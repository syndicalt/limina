// map-raster — Phase 1.1 of "Map-Driven Worlds": rasterize a committed WorldMap IR
// (js/src/world/worldmap.ts) into an editable terrain tile's heightfield + paint channel.
// PURE, dependency-free (no THREE, no DOM, no Date/Math.random) — mirrors
// terrain-heightfield.mjs's contract exactly: same (worldMap, params) -> byte-identical
// {heights, paintMat, paintW}, so terrain.create's replay reconstructs identical bytes.
//
// THE COORDINATE CONTRACT: a WorldMap's land/relief/biome/waterway points are in the map's
// OWN local units (`unitsPerMeter` scales them to meters; `origin` is where the map's local
// (0,0) sits in WORLD space). This module maps every IR point to WORLD METERS
// (worldX = origin[0] + x*unitsPerMeter, worldZ = origin[1] + y*unitsPerMeter) and rasterizes
// a `size`x`size` grid centered on `opts.center` in WORLD space (default (0,0)). The returned
// height array remains tile-local row/column data; terrain.create places it at the same center.
// This keeps non-zero terrain origins aligned with WorldMap rivers, biomes, and relief instead
// of translating the rasterized features a second time when the mesh is positioned.
//
// LAYERING (outside -> in): sea/shore falloff by distance-to-coast (a TIGHT band so the
// rendered coast tracks the drawn polygon, incl. concavities like a pinched waist, instead of
// blurring it) -> a hard vertical-separation clamp outside that same narrow band (underwater
// terrain tops out at seaLevel-0.5, land floors at seaLevel+0.8 — only the band itself, the
// "surf zone", is allowed to cross the water plane — so the water plane never z-fights a
// near-flat run of terrain) -> relief hints (mountain/hills/plateau/peak raise, depression
// lowers, smoothstep falloff from each hint's shape) -> seeded value-noise/fBm texture (bounded
// to `noiseFrac` x the LOCAL authored relief amplitude, so it stays legible: this bound is what
// keeps the land-mask IoU >= 0.85) -> waterway carve (a shallow channel floor at seaLevel-0.6,
// so the water plane visibly fills it — rivers read as channels, not craters — clamped to only
// ever LOWER the surface, never raise it) -> biome regions painted onto the tile's
// paintMat/paintW overlay channel (terrain.paint's SAME channel — reused, not reinvented) with
// a narrow coastal sand fringe, sand river banks, and a full seabed paint (sand near shore ->
// dirt/rock deeper) so no tile cell is left with paintW===0 (which would fall back to a bare
// checker material).

import { bakeMasterErosion, NO_EROSION_RECIPE } from "./erosion.mjs";

export class MapRasterCancelledError extends Error {
  constructor() {
    super("map raster cancelled");
    this.name = "MapRasterCancelledError";
  }
}

// ── deterministic value noise + fBm (verbatim technique from terrain-heightfield.mjs, kept
// local to this module so map-raster.mjs has zero cross-file coupling with the procedural
// generator — the two sources are independent, swappable pipelines over the same tile shape). ─
function hash2(ix, iz, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth = (t) => t * t * (3 - 2 * t);
function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed), c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  const ux = smooth(fx), uz = smooth(fz);
  return (a * (1 - ux) + b * ux) * (1 - uz) + (c * (1 - ux) + d * ux) * uz;
}
/** fBm in [-1, 1] (zero-mean-ish), deterministic per (x,z,seed). */
function fbm(x, z, seed, oct = 4, lac = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < oct; o++) {
    sum += amp * (valueNoise(x * freq, z * freq, seed + o * 1013) * 2 - 1);
    norm += amp;
    amp *= gain;
    freq *= lac;
  }
  return norm > 0 ? sum / norm : 0;
}

const clamp01 = (t) => Math.max(0, Math.min(1, t));
const smoothstep01 = (t) => { const c = clamp01(t); return c * c * (3 - 2 * c); };
const lerp = (a, b, t) => a + (b - a) * t;

// ── geometry primitives (pure, deterministic) ──────────────────────────────────────────────

/** Even-odd point-in-ring test (ray casting), no holes — `ring` is an array of [x,z] pairs. */
function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    const denom = (zj - zi) || 1e-12;
    const intersect = (zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / denom + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Point-to-segment distance in the XZ plane. */
function distPointSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cz = az + t * dz;
  return Math.hypot(px - cx, pz - cz);
}

/** Min distance from (x,z) to any edge of a CLOSED ring (wraps last->first). */
function distToRing(x, z, ring) {
  let d = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const s = distPointSegment(x, z, ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
    if (s < d) d = s;
  }
  return d;
}

/** Min distance from (x,z) to any segment of an OPEN polyline (no wrap). */
function distToPolyline(x, z, pts) {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const s = distPointSegment(x, z, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    if (s < d) d = s;
  }
  return d;
}

const RING_Z_BINS = 256;
const SEGMENT_BVH_LEAF_SIZE = 8;

function pointsBounds(points) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const point of points) {
    if (point[0] < minX) minX = point[0];
    if (point[0] > maxX) maxX = point[0];
    if (point[1] < minZ) minZ = point[1];
    if (point[1] > maxZ) maxZ = point[1];
  }
  return { minX, minZ, maxX, maxZ };
}

function containsExpanded(bounds, x, z, margin = 0) {
  return x >= bounds.minX - margin && x <= bounds.maxX + margin && z >= bounds.minZ - margin && z <= bounds.maxZ + margin;
}

function segmentOf(a, b, order) {
  return { ax: a[0], az: a[1], bx: b[0], bz: b[1], order, minX: Math.min(a[0], b[0]), minZ: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxZ: Math.max(a[1], b[1]) };
}

function buildSegmentBvh(segments, indices = segments.map((_segment, index) => index)) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const index of indices) {
    const segment = segments[index];
    if (segment.minX < minX) minX = segment.minX;
    if (segment.minZ < minZ) minZ = segment.minZ;
    if (segment.maxX > maxX) maxX = segment.maxX;
    if (segment.maxZ > maxZ) maxZ = segment.maxZ;
  }
  const node = { minX, minZ, maxX, maxZ };
  if (indices.length <= SEGMENT_BVH_LEAF_SIZE) return { ...node, indices: indices.sort((a, b) => segments[a].order - segments[b].order) };
  const axisX = maxX - minX >= maxZ - minZ;
  indices.sort((a, b) => {
    const ac = axisX ? segments[a].minX + segments[a].maxX : segments[a].minZ + segments[a].maxZ;
    const bc = axisX ? segments[b].minX + segments[b].maxX : segments[b].minZ + segments[b].maxZ;
    return ac - bc || segments[a].order - segments[b].order;
  });
  const middle = indices.length >> 1;
  return { ...node, left: buildSegmentBvh(segments, indices.slice(0, middle)), right: buildSegmentBvh(segments, indices.slice(middle)) };
}

function distanceToBounds(node, x, z) {
  const dx = x < node.minX ? node.minX - x : x > node.maxX ? x - node.maxX : 0;
  const dz = z < node.minZ ? node.minZ - z : z > node.maxZ ? z - node.maxZ : 0;
  return Math.hypot(dx, dz);
}

function distanceToSegmentBvh(spatial, x, z) {
  let best = Infinity;
  const stack = [spatial.bvh];
  while (stack.length > 0) {
    const node = stack.pop();
    if (distanceToBounds(node, x, z) > best) continue;
    if (node.indices !== undefined) {
      for (const index of node.indices) {
        const segment = spatial.segments[index];
        const distance = distPointSegment(x, z, segment.ax, segment.az, segment.bx, segment.bz);
        if (distance < best) best = distance;
      }
      continue;
    }
    const leftDistance = distanceToBounds(node.left, x, z), rightDistance = distanceToBounds(node.right, x, z);
    if (leftDistance <= rightDistance) { stack.push(node.right, node.left); }
    else { stack.push(node.left, node.right); }
  }
  return best;
}

function buildRingSpatial(ring) {
  const bounds = pointsBounds(ring);
  const segments = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) segments.push(segmentOf(ring[j], ring[i], i));
  const bins = Array.from({ length: RING_Z_BINS }, () => []);
  const span = bounds.maxZ - bounds.minZ;
  const binOf = (z) => span > 0 ? Math.max(0, Math.min(RING_Z_BINS - 1, Math.floor(((z - bounds.minZ) / span) * RING_Z_BINS))) : 0;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    for (let bin = binOf(segment.minZ); bin <= binOf(segment.maxZ); bin++) bins[bin].push(index);
  }
  return { ring, bounds, segments, bins, binOf, bvh: buildSegmentBvh(segments) };
}

function pointInRingSpatial(x, z, spatial) {
  if (!containsExpanded(spatial.bounds, x, z)) return false;
  let inside = false;
  for (const index of spatial.bins[spatial.binOf(z)]) {
    const segment = spatial.segments[index];
    const denom = (segment.bz - segment.az) || 1e-12;
    if ((segment.az > z) !== (segment.bz > z) && x < ((segment.bx - segment.ax) * (z - segment.az)) / denom + segment.ax) inside = !inside;
  }
  return inside;
}

function buildPolylineSpatial(points) {
  const segments = [];
  for (let index = 1; index < points.length; index++) segments.push(segmentOf(points[index - 1], points[index], index - 1));
  return { points, bounds: pointsBounds(points), segments, bvh: buildSegmentBvh(segments) };
}

/** Project an IR [x,y] point into WORLD METERS via the map's origin + unitsPerMeter. */
function toWorld(origin, unitsPerMeter, p) {
  return [origin[0] + p[0] * unitsPerMeter, origin[1] + p[1] * unitsPerMeter];
}

/** Normalize a WorldMap's land polygons into world-meter rings (outer + holes per polygon). */
function projectLandPolys(worldMap) {
  const { origin, unitsPerMeter } = worldMap;
  return worldMap.land.map((poly) => ({
    outer: buildRingSpatial(poly.points.map((p) => toWorld(origin, unitsPerMeter, p))),
    holes: (poly.holes ?? []).map((h) => buildRingSpatial(h.map((p) => toWorld(origin, unitsPerMeter, p)))),
  }));
}

/** Whether (x,z) [world meters] is inside ANY land polygon (outer minus holes). */
function isInsideLandPolys(landPolys, x, z) {
  for (const poly of landPolys) {
    if (!pointInRingSpatial(x, z, poly.outer)) continue;
    let inHole = false;
    for (const h of poly.holes) { if (pointInRingSpatial(x, z, h)) { inHole = true; break; } }
    if (!inHole) return true;
  }
  return false;
}

/** Min distance from (x,z) to the nearest land-polygon boundary (outer ring or hole ring),
 *  across every land polygon. Infinity when the map has no land at all. */
function buildLandBoundaryIndex(landPolys) {
  const segments = [];
  for (const polygon of landPolys) for (const ring of [polygon.outer, ...polygon.holes]) {
    for (const segment of ring.segments) segments.push({ ...segment, order: segments.length });
  }
  return segments.length === 0 ? undefined : { segments, bvh: buildSegmentBvh(segments) };
}

function distToLandBoundary(boundaryIndex, x, z) {
  return boundaryIndex === undefined ? Infinity : distanceToSegmentBvh(boundaryIndex, x, z);
}

/**
 * Build a reusable land classifier + coast-distance sampler over a WorldMap's land polygons —
 * the SAME point-in-polygon this module rasterizes with, exposed so a caller (e.g. the
 * determinism/IoU gate) can build an independent "truth" mask without duplicating the PIP.
 */
export function landClassifier(worldMap) {
  const landPolys = projectLandPolys(worldMap);
  const boundaryIndex = buildLandBoundaryIndex(landPolys);
  return {
    isLand: (x, z) => isInsideLandPolys(landPolys, x, z),
    distToCoast: (x, z) => {
      const d = distToLandBoundary(boundaryIndex, x, z);
      return Number.isFinite(d) ? d : 0;
    },
  };
}

/** Convenience one-shot land test (rebuilds the classifier each call — fine for occasional use;
 *  prefer `landClassifier(worldMap)` when testing many points). */
export function isLand(worldMap, x, z) {
  return landClassifier(worldMap).isLand(x, z);
}

// ── base64 -> Uint8Array, dependency-free (no Buffer/atob: this module must stay pure and run
// identically in Node, the engine's V8, and the browser sim worker). ─────────────────────────
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = (() => { const t = new Int16Array(128).fill(-1); for (let i = 0; i < 64; i++) t[B64_ALPHABET.charCodeAt(i)] = i; return t; })();
function b64ToU8Exact(s, expectedBytes) {
  if (typeof s !== "string") throw new TypeError("reliefGrid: data must be base64 text");
  const encodedLength = 4 * Math.ceil(expectedBytes / 3);
  if (s.length !== encodedLength) throw new Error(`reliefGrid: base64 length ${s.length} != expected ${encodedLength}`);
  const paddingLength = expectedBytes % 3 === 0 ? 0 : expectedBytes % 3 === 1 ? 2 : 1;
  const clean = paddingLength ? s.slice(0, -paddingLength) : s;
  if (paddingLength && s.slice(-paddingLength) !== "=".repeat(paddingLength)) throw new Error("reliefGrid: malformed base64 padding");
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    if (code >= B64_LOOKUP.length || B64_LOOKUP[code] < 0) throw new Error("reliefGrid: invalid base64 character");
  }
  if (expectedBytes % 3 === 1 && (B64_LOOKUP[clean.charCodeAt(clean.length - 1)] & 15) !== 0) throw new Error("reliefGrid: non-canonical base64 padding bits");
  if (expectedBytes % 3 === 2 && (B64_LOOKUP[clean.charCodeAt(clean.length - 1)] & 3) !== 0) throw new Error("reliefGrid: non-canonical base64 padding bits");
  const out = new Uint8Array(expectedBytes);
  let buf = 0, bits = 0, o = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64_LOOKUP[clean.charCodeAt(i)];
    buf = (buf << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xff; }
  }
  if (o !== expectedBytes) throw new Error(`reliefGrid: decoded ${o} bytes, expected ${expectedBytes}`);
  return out;
}

/**
 * Build a bilinear sampler over a WorldMap's painted elevation raster (reliefGrid), or null when
 * the map has none. Returns sample(wx, wz) -> ABSOLUTE surface elevation in world meters.
 * The grid's rect is in the map's local units (like every other IR coordinate) — projected to
 * world meters here via origin/unitsPerMeter; sampling clamps to the grid edge outside the rect.
 */
export function reliefGridSampler(worldMap) {
  const g = worldMap.reliefGrid;
  if (!g) return null;
  if (!Number.isInteger(g.w) || g.w < 2 || g.w > 1024 || !Number.isInteger(g.h) || g.h < 2 || g.h > 1024) {
    throw new Error("reliefGrid: w/h must be integers in [2, 1024]");
  }
  if (!g.rect || !Number.isFinite(g.rect.x0) || !Number.isFinite(g.rect.z0)
      || !Number.isFinite(g.rect.w) || g.rect.w <= 0 || !Number.isFinite(g.rect.h) || g.rect.h <= 0) {
    throw new Error("reliefGrid: rect requires finite x0/z0 and positive finite w/h");
  }
  if (!Number.isFinite(g.minY) || !Number.isFinite(g.maxY) || !(g.maxY > g.minY)) {
    throw new Error("reliefGrid: minY/maxY must be finite with maxY > minY");
  }
  if (g.encoding !== undefined && g.encoding !== "u8" && g.encoding !== "u16") {
    throw new Error(`reliefGrid: unsupported encoding "${g.encoding}"`);
  }
  const { origin, unitsPerMeter } = worldMap;
  // u16 packs 2 little-endian bytes per cell (65,536 levels); absent/'u8' = 1 byte. Explicit LE
  // decode (not a Uint16Array view) keeps the byte layout host-independent for determinism.
  const u16 = g.encoding === "u16";
  const need = g.w * g.h * (u16 ? 2 : 1);
  const bytes = b64ToU8Exact(g.data, need);
  const max = u16 ? 65535 : 255;
  const cellAt = u16 ? (i) => bytes[2 * i] | (bytes[2 * i + 1] << 8) : (i) => bytes[i];
  const x0 = origin[0] + g.rect.x0 * unitsPerMeter;
  const z0 = origin[1] + g.rect.z0 * unitsPerMeter;
  const rw = g.rect.w * unitsPerMeter;
  const rh = g.rect.h * unitsPerMeter;
  const yOf = (val) => g.minY + (val / max) * (g.maxY - g.minY);
  return (wx, wz) => {
    const u = Math.max(0, Math.min(g.w - 1, ((wx - x0) / rw) * (g.w - 1)));
    const v = Math.max(0, Math.min(g.h - 1, ((wz - z0) / rh) * (g.h - 1)));
    const c0 = Math.floor(u), r0 = Math.floor(v);
    const c1 = Math.min(g.w - 1, c0 + 1), r1 = Math.min(g.h - 1, r0 + 1);
    const fu = u - c0, fv = v - r0;
    const a = cellAt(r0 * g.w + c0), b = cellAt(r0 * g.w + c1);
    const c = cellAt(r1 * g.w + c0), d = cellAt(r1 * g.w + c1);
    return yOf((a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv);
  };
}

// Relief kinds that RAISE terrain (everything except "depression", which lowers it).
const RAISING_RELIEF = new Set(["mountain", "hills", "plateau", "peak"]);

/** Project relief hints into world-meter shapes. */
function projectRelief(worldMap) {
  const { origin, unitsPerMeter } = worldMap;
  return worldMap.relief.map((r) => {
    const polygon = r.shape.polygon !== undefined ? buildRingSpatial(r.shape.polygon.map((p) => toWorld(origin, unitsPerMeter, p))) : undefined;
    return { kind: r.kind, amplitude: r.amplitude, polygon, point: r.shape.point !== undefined ? toWorld(origin, unitsPerMeter, r.shape.point) : undefined };
  });
}

/** Project biome regions into world-meter rings. */
function projectBiomes(worldMap) {
  const { origin, unitsPerMeter } = worldMap;
  return worldMap.biomes.map((b) => ({ biome: b.biome, ring: buildRingSpatial(b.points.map((p) => toWorld(origin, unitsPerMeter, p))) }));
}

/** Project waterways into world-meter polylines. */
function projectWaterways(worldMap) {
  const { origin, unitsPerMeter } = worldMap;
  return worldMap.waterways.map((w) => ({
    widthM: w.widthM ?? 3,
    ...buildPolylineSpatial(w.points.map((p) => toWorld(origin, unitsPerMeter, p))),
  }));
}

// terrain.paint's material ids (MUST match PAINT_MATERIALS in terrain-edit.ts / PAINT_ALBEDO in
// terrain/render.ts): 0 none, 1 sand, 2 grass, 3 rock, 4 dirt, 5 snow. Biome -> paint mapping
// is a deliberate, sensible default (not load-bearing on exact ids beyond matching that
// channel). Every biome the Map Painter palette exposes MUST paint something real here — a
// brush that compiles to nothing is a silent UI lie (plan-8df2466225bf4213 review finding #1).
function biomePaintId(biome) {
  switch (biome) {
    case "grass": return 2;
    case "forest": return 2;
    case "mountain": return 3;
    case "swamp": return 6; // murk (PAINT_ALBEDO[6] / PAINT_MATERIALS.murk) — dirt read as generic brown, invisible as wetland
    case "desert": return 1;
    case "tundra": return 5; // snow (PAINT_ALBEDO[5] / PAINT_MATERIALS.snow)
    case "water": return undefined; // never paints; it's below sea level anyway.
    default: return undefined;
  }
}

/**
 * Rasterize a WorldMap IR into a square heightfield + paint overlay — PURE (no THREE/DOM,
 * no Date/Math.random): identical (worldMap, params) -> byte-identical output, every run,
 * every host.
 *
 * @param {import("../worldmap.ts").WorldMap} worldMap
 * @param {{ size: number, resolution: number, center?: readonly [number, number], seed?: number, noiseFrac?: number, baseAmplitude?: number,
 *           erosion?: object, shouldCancel?: () => boolean }} opts
 * @returns {{ heights: Float32Array, paintMat: Uint8Array, paintW: Float32Array, seaLevelM: number,
 *             erosion: object, erosionPasses: number,
 *             cfg: { seaLevelM: number, amplitude: number, noiseFrac: number, size: number, resolution: number, seed: number } }}
 */
export function rasterizeWorldMap(worldMap, opts) {
  const size = opts.size;
  const n = opts.resolution;
  const seed = (opts.seed ?? 1) | 0;
  const noiseFrac = opts.noiseFrac ?? 0.2;
  const baseAmplitude = opts.baseAmplitude ?? 12;
  if (!(size > 0)) throw new Error("rasterizeWorldMap: size must be > 0");
  if (!(n >= 2)) throw new Error("rasterizeWorldMap: resolution must be >= 2");
  const center = opts.center ?? [0, 0];
  if (!Array.isArray(center) || center.length !== 2 || !Number.isFinite(center[0]) || !Number.isFinite(center[1])) {
    throw new Error("rasterizeWorldMap: center must be finite [x,z]");
  }

  const seaLevel = worldMap.seaLevel;
  const landBase = seaLevel + 2;
  const half = size / 2;
  const step = size / (n - 1);
  const minX = center[0] - half;
  const minZ = center[1] - half;

  const landPolys = projectLandPolys(worldMap);
  const landBoundaryIndex = buildLandBoundaryIndex(landPolys);
  const reliefs = projectRelief(worldMap);
  const biomes = projectBiomes(worldMap);
  // Blight is a DEPTH gradient, not a flat mask — the caesura is mild at its frontier and grows
  // oppressive toward its core (Corruption Index / periphery→heart). Precompute each blight region's
  // core depth (≈ its inscribed radius, measured at the centroid) so the per-cell mask can normalise
  // inward distance → ~0 at the edge, →1 at the core.
  for (const b of biomes) {
    if (b.biome !== "blight") continue;
    let cx = 0, cz = 0;
    for (const [x, z] of b.ring.ring) { cx += x; cz += z; }
    cx /= b.ring.ring.length; cz /= b.ring.ring.length;
    b.coreDepth = Math.max(1, distanceToSegmentBvh(b.ring, cx, cz));
  }
  const waterways = projectWaterways(worldMap);
  // PRECEDENCE: a painted elevation raster (reliefGrid) REPLACES the base shore-lerp + vector
  // relief hints entirely — the painted surface is authoritative. Everything downstream of the
  // base surface (bounded ambient noise, the vertical-separation clamp, waterway carve, paint)
  // still applies, so the water plane can never z-fight a painted near-sea-level plain.
  const gridSample = reliefGridSampler(worldMap);

  // Scale-relative bands (deterministic functions of `size` only, so a bigger tile gets a
  // proportionally wider shore/relief falloff instead of a fixed-meter band reading too sharp).
  // shoreBand is deliberately TIGHT (a real-world "surf zone" width, ~2.5-4m, not a fraction of
  // the whole tile) — it doubles as BOTH the coastline-shape falloff (so drawn concavities like
  // a pinched waist survive) AND the vertical-separation surf-zone threshold below: only within
  // this band of the true coast may the terrain cross the water plane.
  const shoreBand = Math.min(6, Math.max(2.5, size * 0.015));
  const reliefBand = Math.max(4, size * 0.06);
  const seaFarDepth = Math.max(2, baseAmplitude * 0.5);
  const flatNoiseAmp = baseAmplitude * 0.15; // ambient roughness where no relief hint applies.
  const noiseScale = 0.08; // fBm cycles/meter — a fixed implementation constant, not a knob.

  const heights = new Float32Array(n * n);
  const paintMat = new Uint8Array(n * n);
  const paintW = new Float32Array(n * n);
  // Per-cell caesura mask (0 clean .. 1 corrupt). Blight is an OVERLAY biome — it drains the color of
  // whatever's painted beneath it rather than being a paint material of its own (see the biome loop).
  const blight = new Float32Array(n * n);

  for (let row = 0; row < n; row++) {
    const wz = minZ + row * step;
    for (let col = 0; col < n; col++) {
      if (((row * n + col) & 1023) === 0 && opts.shouldCancel?.()) throw new MapRasterCancelledError();
      const wx = minX + col * step;
      const i = row * n + col;

      // ── 1+2. Base surface: either the PAINTED raster (authoritative — replaces both the
      //    shore-lerp base and the vector relief hints, per the reliefGrid precedence contract)
      //    or the classic shore falloff + relief-hint composition. ───────────────────────────
      const inLand = isInsideLandPolys(landPolys, wx, wz);
      let coastD = distToLandBoundary(landBoundaryIndex, wx, wz);
      if (!Number.isFinite(coastD)) coastD = shoreBand; // no land at all: treat as "at the shore".
      let h;
      let localAmp = 0;
      // Painted-elevation LAKES: the painted raster is authoritative (the elevation-carves-water
      // contract), so ANY land cell painted below the water plane renders submerged — the SAME
      // <seaLevel rule the 2D hillshade tints by, so the lake the author sees is the lake that
      // builds, full extent. Cells in the shallow rim (0 to -0.5) are pushed DOWN to the -0.5
      // sea ceiling below so nothing sits within z-fighting range of the plane.
      let paintedSubSea = false;
      if (gridSample) {
        h = gridSample(wx, wz);
        paintedSubSea = inLand && h < seaLevel - 0.05;
        // SEA cells with no authored seabed (the raster reads at/above the plane out there —
        // typically the unpainted default): fall back to the classic deepening shore falloff.
        // Without this the whole open sea rides the -0.5 clamp ceiling and renders as a BRIGHT
        // SAND SHELF around the island. A painted sub-sea value IS an authored seabed
        // (e.g. a dug bay) and is honored (subject to the same -0.5 ceiling below).
        if (!inLand && h >= seaLevel - 0.05) {
          const t = smoothstep01(coastD / shoreBand);
          h = lerp(seaLevel - 0.4, seaLevel - seaFarDepth, t);
        }
      } else {
        const t = smoothstep01(coastD / shoreBand);
        h = inLand ? lerp(seaLevel + 0.4, landBase, t) : lerp(seaLevel - 0.4, seaLevel - seaFarDepth, t);

        // Relief hints (polygon: smoothstep falloff from the edge inward; point: radial bump).
        // Mountain/hills/plateau/peak RAISE; depression LOWERS — regardless of the hint's own
        // stored sign, so authored data can carry either convention safely.
        let reliefSum = 0;
        for (const r of reliefs) {
          let w = 0;
          if (r.polygon !== undefined) {
            if (pointInRingSpatial(wx, wz, r.polygon)) {
              const edgeD = distanceToSegmentBvh(r.polygon, wx, wz);
              w = smoothstep01(edgeD / reliefBand);
            }
          } else if (r.point !== undefined) {
            const radius = Math.max(10, Math.min(60, Math.abs(r.amplitude) * 1.5));
            const dist = Math.hypot(wx - r.point[0], wz - r.point[1]);
            w = 1 - smoothstep01(dist / radius);
          }
          if (w > 0) {
            const signed = RAISING_RELIEF.has(r.kind) ? Math.abs(r.amplitude) : -Math.abs(r.amplitude);
            reliefSum += signed * w;
            const mag = Math.abs(r.amplitude) * w;
            if (mag > localAmp) localAmp = mag;
          }
        }
        h += reliefSum;
      }

      // ── 3. Seeded noise texture, bounded by noiseFrac x the LOCAL authored amplitude (the
      //    relief hint governing this cell, else a small ambient roughness on land — this bound
      //    is what keeps the drawing legible / the land-mask IoU high). ──────────────────────
      const effAmp = Math.max(localAmp, inLand ? flatNoiseAmp : 0);
      if (effAmp > 0) {
        const nv = fbm(wx * noiseScale, wz * noiseScale, seed, 4, 2.0, 0.5);
        h += nv * noiseFrac * effAmp;
      }

      // ── 3b. Vertical-separation clamp: outside the narrow shoreBand "surf zone" around the
      //    TRUE coast, hard-floor land at seaLevel+0.8 and hard-ceiling sea at seaLevel-0.5 —
      //    relief/noise may shape the surface freely but must never bring a far-from-coast cell
      //    back within z-fighting range of the water plane. Only cells inside shoreBand of the
      //    actual shoreline (where the lerp above legitimately crosses the plane) are exempt, so
      //    the crossing itself stays a narrow ~shoreBand-wide surf strip, not a wide dead band. ─
      if (coastD > shoreBand) {
        if (inLand && !paintedSubSea) { if (h < seaLevel + 0.8) h = seaLevel + 0.8; }
        else if (paintedSubSea) {
          // Lake basins sink to >= 2m depth across their FULL painted extent: the water plane's
          // depth shading is nearly clear in the first ~1m of column, so a shallow painted rim
          // read as wet sand and the lake looked half its drawn size (a real UAT complaint).
          if (h > seaLevel - 2.0) h = seaLevel - 2.0;
        }
        else { if (h > seaLevel - 0.5) h = seaLevel - 0.5; }
      }

      heights[i] = h;

      // ── 5. Biome -> paint (computed here so it shares the coastD already known; carving
      //    happens in a second pass below since it must clamp against the noised base height). ─
      let matId = 0, matW = 0;
      const edgeBand = Math.max(3, size * 0.03);
      for (const b of biomes) {
        if (!pointInRingSpatial(wx, wz, b.ring)) continue;
        // Blight is an OVERLAY (not a paint material) and a DEPTH gradient: intensity climbs from ~0 at
        // the caesura's frontier to ~1 toward its core (inward distance / coreDepth), so the render's
        // colour-drain + mist + dead-vegetation all intensify with depth — a mild edge, an oppressive
        // heart. The underlying biome still wins paintMat, so the ground keeps its texture, just
        // corrupted. (An authored per-region Corruption Index ceiling is a future painter hook.)
        if (b.biome === "blight") {
          const inten = Math.min(1, distanceToSegmentBvh(b.ring, wx, wz) / b.coreDepth);
          if (inten > blight[i]) blight[i] = inten;
          continue;
        }
        const id = biomePaintId(b.biome);
        if (id === undefined) continue;
        const bd = distanceToSegmentBvh(b.ring, wx, wz);
        const w = 0.8 * smoothstep01(bd / edgeBand);
        if (w > matW) { matId = id; matW = w; }
      }
      const coastalBand = shoreBand * 1.5;
      if (coastD < coastalBand) {
        const sandW = 0.8 * (1 - smoothstep01(coastD / coastalBand));
        if (sandW > matW) { matId = 1; matW = sandW; }
      }

      // River banks: sand along each waterway's channel + bank falloff (peaking at the
      // channel/bank edge — the same halfWidth/bankBand geometry the carve pass uses below —
      // so the painted strip matches the carved channel exactly).
      for (const w of waterways) {
        if (w.points.length < 2) continue;
        const halfWidth = w.widthM / 2;
        const bankBand = Math.max(halfWidth, 2);
        const reach = halfWidth + bankBand;
        if (!containsExpanded(w.bounds, wx, wz, reach)) continue;
        const d = distanceToSegmentBvh(w, wx, wz);
        if (d >= reach) continue;
        const bankW = 0.85 * (1 - smoothstep01(d / reach));
        if (bankW > matW) { matId = 1; matW = bankW; }
      }

      // Full seabed paint: every OPEN-SEA cell gets a material so paintW is never ~0 out there —
      // an unpainted cell falls back to a bare checker material, which is the "checkerboard
      // seabed" defect this kills. UNIFORM sand (not dirt/rock) — dirt/rock read as gray blobs
      // through the water (a real UAT complaint, "gray platform"); depth darkening is the
      // water shader's job, not the terrain paint's. Weight only tapers slightly with depth.
      // (Land cells with no biome/coastal hit stay unpainted; the elevation-color ramp already
      // gives them a sensible grass/rock base, so there's no bare-checker risk on land.)
      if (!inLand || paintedSubSea) {
        const seabedId = 1; // sand, uniform across shallows, deep open sea AND painted lake floors
        const seabedW = coastD < coastalBand ? 0.85 : 0.55;
        if (seabedW > matW) { matId = seabedId; matW = seabedW; }
      }

      paintMat[i] = matId;
      paintW[i] = matW;
    }
  }

  // ── 4. CANONICAL MASTER EROSION. This runs exactly once over the complete bounded
  // base field, before waterways/swamp pools (hydrology) and before any future edit
  // layers. Downstream chunking must slice this baked array, never erode per chunk.
  // Disabled mode returns the original Float32Array untouched for byte compatibility.
  const erosionBake = bakeMasterErosion({
    heights,
    rows: n,
    cols: n,
    seed,
    recipe: opts.erosion ?? NO_EROSION_RECIPE,
  }, { shouldCancel: opts.shouldCancel });
  if (erosionBake.erosionPasses === 1) heights.set(erosionBake.heights);

  // ── 5. Waterway carve (second pass: pulls the surface DOWN toward a shallow channel floor
  //    along each polyline so rivers read as WATER CHANNELS the water plane visibly fills, not
  //    craters — a fixed subtract-with-floor previously dug to seaLevel-3, rendering as a dark
  //    pit wherever the local terrain was already low, e.g. near a river mouth at the coast).
  //    `Math.min` makes this a one-way clamp: it can only lower a cell toward channelFloor,
  //    never raise one that is already lower (e.g. open sea past a river mouth stays untouched
  //    instead of getting an underwater ridge). Runs after the base+relief+noise(+clamp) pass so
  //    the carve reads relative to the already-shaped surface, not fighting it. ─────────────────
  const channelFloor = seaLevel - 0.6;
  for (let row = 0; row < n; row++) {
    const wz = minZ + row * step;
    for (let col = 0; col < n; col++) {
      const wx = minX + col * step;
      const i = row * n + col;
      let carve = 0;
      for (const w of waterways) {
        if (w.points.length < 2) continue;
        const halfWidth = w.widthM / 2;
        const bankBand = Math.max(halfWidth, 2);
        const reach = halfWidth + bankBand;
        if (!containsExpanded(w.bounds, wx, wz, reach)) continue;
        const d = distanceToSegmentBvh(w, wx, wz);
        let ct;
        if (d <= halfWidth) ct = 1;
        else if (d >= halfWidth + bankBand) ct = 0;
        else ct = 1 - smoothstep01((d - halfWidth) / bankBand);
        if (ct > carve) carve = ct;
      }
      if (carve > 0) {
        // RELATIVE gully, not an absolute floor: through elevated ground the channel cuts ~3m
        // into the LOCAL surface (an absolute seaLevel-0.6 floor cut slot canyons through a
        // painted mountain — walls hid the water and the "river" read as a dry crack). Where
        // the ground is already low the absolute flood floor still wins, so river mouths and
        // lake links stay below the plane and fill.
        const floorHere = Math.max(channelFloor, heights[i] - 3);
        const target = lerp(heights[i], floorHere, carve);
        heights[i] = Math.min(heights[i], target);
      }
    }
  }

  // ── 5b. SWAMP POOLS (third pass, same one-way-lower pattern as the carve): a swamp that is
  //    only a murk ground tint reads as dirt, not wetland. Dapple LOW-LYING swamp-biome ground
  //    with seeded shallow pools the water plane fills — mottled standing water over the murk
  //    floor is the marsh read. Only near-waterline ground pools (≤ seaLevel+2.5): an ELEVATED
  //    painted swamp stays a dank ground tint instead of gaining impossible hillside ponds.
  //    Pool features ~20 m across (fixed 0.05 cycles/m), covering ~1/3 of the low swamp; the
  //    dip is one-way (Math.min) and runs after the clamp + carve so it never raises ground and
  //    never fights the lake/sea rules. Pure + seeded (salt 7919) — replay identical.
  const swampRings = biomes.filter((b) => b.biome === "swamp").map((b) => b.ring);
  if (swampRings.length > 0) {
    const poolFloor = seaLevel - 0.7;
    for (let row = 0; row < n; row++) {
      const wz = minZ + row * step;
      for (let col = 0; col < n; col++) {
        const wx = minX + col * step;
        const i = row * n + col;
        if (heights[i] <= seaLevel || heights[i] > seaLevel + 2.5) continue;
        let inSwamp = false;
        for (const ring of swampRings) { if (pointInRingSpatial(wx, wz, ring)) { inSwamp = true; break; } }
        if (!inSwamp) continue;
        const pool = fbm(wx * 0.05, wz * 0.05, seed + 7919, 3, 2.0, 0.5);
        if (pool > 0.12) {
          const t = smoothstep01((pool - 0.12) / 0.18);
          heights[i] = Math.min(heights[i], lerp(heights[i], poolFloor, t));
        }
      }
    }
  }

  return {
    heights,
    paintMat,
    paintW,
    blight,
    seaLevelM: seaLevel,
    erosion: erosionBake.recipe,
    erosionPasses: erosionBake.erosionPasses,
    cfg: { seaLevelM: seaLevel, amplitude: baseAmplitude, noiseFrac, size, resolution: n, seed },
  };
}
