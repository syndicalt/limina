// map-paint.js — Map Painter P1: the landmass paint layer. Owns the per-map decoded landmass
// mask cache ({w, h, rect, cells, dirty, rev}), the land brush, the composited land image
// (offscreen canvas -> data URL, blitted as an SVG <image> exactly like the elevation hillshade),
// and the live coastline — derived by the SAME marching-squares module the compiler runs
// (served at /shared/), so the coast you see while painting IS the coast the world builds from.
//
// Creation is explicit: the mask is only created by the FIRST landmass stroke (never by arming
// the tool), and that first stroke's command carries the whole grid — seed (any hand-traced
// outline rasterized in) + stroke as ONE undoable step, so undo returns the doc to pure-vector
// state. No load-time doc mutation, ever (the phantom-loss audit's finding #6).

import { encodeRasterCells, decodeRasterCells } from "/shared/raster-codec.mjs";
import { maskToLandPolygons } from "/shared/marching-squares.mjs";
import * as EL from "./map-elevation.js";
import { createWorldMapToMapDocTransform } from "./map-coordinate-conversion.js";

export const LAND_SIZE = 512; // cells per side — ~5m cells on a 2.6km map (locked decision)
const LAND_FILL = "#dccfa6"; // matches the legacy traced-outline land fill
const COAST_STROKE = "#b89b6a";

const cache = new Map(); // mapId -> {w, h, rect, cells, dirty, rev}
const imgCache = new Map(); // mapId -> {rev, url}
const coastCache = new Map(); // mapId -> {rev, polys}

const effCache = new Map(); // mapId -> {key, cells, w, h, rect, rev}

export function landmassOf(mapId) { return cache.get(mapId) || null; }
export function hasLandmass(map) { return !!(map.rasters && map.rasters.landmass) || cache.has(map.id); }
export function dropLandmassCache(mapId) { cache.delete(mapId); imgCache.delete(mapId); coastCache.delete(mapId); effCache.delete(mapId); }

/** ELEVATION CARVES WATER: the effective land mask = painted land MINUS anywhere the painted
 *  elevation dips below sea level (inside the elevation extent). Digging at the coast extends
 *  the sea — display, coastline, and compile all read this SAME rule (the compiler applies it
 *  identically). Returns null when there's no painted elevation (mask is authoritative alone). */
export function effectiveLand(lm, mapId, elevEntry, seaLevel, elevKey) {
  if (!elevEntry) return null;
  const key = (lm.rev || 0) + ":" + elevKey + ":" + seaLevel + ":" + lm.rect.x0 + "," + lm.rect.w;
  const hit = effCache.get(mapId);
  if (hit && hit.key === key) return hit;
  const { w, h, rect } = lm;
  const cells = lm.cells.slice();
  const sx = rect.w / (w - 1), sz = rect.h / (h - 1);
  const er = elevEntry.rect;
  for (let r = 0; r < h; r++) {
    const wz = rect.z0 + r * sz;
    if (wz < er.z0 || wz > er.z0 + er.h) continue;
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      if (cells[i] < 128) continue;
      const wx = rect.x0 + c * sx;
      if (wx < er.x0 || wx > er.x0 + er.w) continue;
      if (EL.sampleY(elevEntry, wx, wz) < seaLevel - 0.01) cells[i] = 0;
    }
  }
  const out = { key, cells, w, h, rect, rev: key };
  effCache.set(mapId, out);
  return out;
}
export function dropAllLandmassCaches() { cache.clear(); imgCache.clear(); coastCache.clear(); }

/** Decode the doc's stored mask into the cache (display path for already-painted maps). */
export function ensureLandmass(map) {
  let e = cache.get(map.id);
  if (e) return e;
  const lm = map.rasters && map.rasters.landmass;
  if (!lm) return null;
  e = {
    w: lm.w, h: lm.h,
    rect: { ...lm.rect },
    cells: decodeRasterCells(lm, lm.w * lm.h),
    dirty: false, rev: 0,
  };
  cache.set(map.id, e);
  return e;
}

/** The creation rect: content bbox ∪ a centered square, padded 1.5x, MINIMUM 800m — island-scale
 *  painting must never hit the elevation layer's 120m floor (strokes outside the rect are
 *  silent no-ops, the exact trap the plan review flagged). */
function creationRect(map, markers) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const eat = (x, z) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; };
  for (const f of map.features || []) {
    if (f.points) for (const p of f.points) eat(p[0], p[1]);
    else if (typeof f.x === "number") eat(f.x, f.z);
  }
  for (const m of markers || []) eat(m.x, m.z);
  if (minX === Infinity) { minX = -1000; maxX = 1000; minZ = -1000; maxZ = 1000; }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const span = Math.max(2000, (maxX - minX) * 1.5, (maxZ - minZ) * 1.5);
  return { x0: Math.round(cx - span / 2), z0: Math.round(cz - span / 2), w: Math.round(span), h: Math.round(span) };
}

/** Auto-grow the raster rect so a stroke landing outside the current extent just works — the
 *  extent is internal bookkeeping, never a wall (there is no visible region UI). Existing cells
 *  resample (nearest) into the grown grid. `coBuffers` (e.g. the in-flight stroke's undo
 *  snapshot) resample through the SAME transform so a mid-stroke grow keeps undo exact — the
 *  caller must widen its bbox to the full grid afterwards. The slight coarsening of old paint
 *  is not undoable. */
export function growRasterToInclude(e, wx, wz, radiusM, fillValue = 0, coBuffers = []) {
  const pad = radiusM * 1.5;
  const nx0 = Math.min(e.rect.x0, wx - pad), nz0 = Math.min(e.rect.z0, wz - pad);
  const nx1 = Math.max(e.rect.x0 + e.rect.w, wx + pad), nz1 = Math.max(e.rect.z0 + e.rect.h, wz + pad);
  if (nx0 === e.rect.x0 && nz0 === e.rect.z0 && nx1 === e.rect.x0 + e.rect.w && nz1 === e.rect.z0 + e.rect.h) return false;
  const rect = { x0: Math.round(nx0), z0: Math.round(nz0), w: Math.round(nx1 - nx0), h: Math.round(nz1 - nz0) };
  const { w, h } = e;
  const osx = e.rect.w / (w - 1), osz = e.rect.h / (h - 1);
  const nsx = rect.w / (w - 1), nsz = rect.h / (h - 1);
  const resample = (src) => {
    const next = new src.constructor(w * h);
    if (fillValue) next.fill(fillValue); // e.g. elevation's flat-y=0 value; landmass fills ocean (0)
    for (let r = 0; r < h; r++) {
      const wz2 = rect.z0 + r * nsz;
      const or = Math.round((wz2 - e.rect.z0) / osz);
      if (or < 0 || or > h - 1) continue;
      for (let c = 0; c < w; c++) {
        const wx2 = rect.x0 + c * nsx;
        const oc = Math.round((wx2 - e.rect.x0) / osx);
        if (oc >= 0 && oc <= w - 1) next[r * w + c] = src[or * w + oc];
      }
    }
    return next;
  };
  const nextCells = resample(e.cells);
  for (const buf of coBuffers) buf.set(resample(buf));
  e.rect = rect;
  e.cells = nextCells;
  e.dirty = true; e.rev = (e.rev || 0) + 1;
  return true;
}

/** Create the mask (first stroke only). Seeds LAND from any hand-traced outline features via
 *  scanline fill, so painting CONTINUES the existing coast instead of starting over. The caller
 *  snapshots the empty grid BEFORE calling this, so seed+stroke undo as one step. */
export function createLandmass(map, markers) {
  const rect = creationRect(map, markers);
  const e = { w: LAND_SIZE, h: LAND_SIZE, rect, cells: new Uint8Array(LAND_SIZE * LAND_SIZE), dirty: false, rev: 0 };
  const outlines = (map.features || []).filter((f) => f.type === "area" && f.kind === "outline" && Array.isArray(f.points) && f.points.length >= 3);
  for (const o of outlines) scanlineFill(e, o.points);
  cache.set(map.id, e);
  return e;
}

/** Scanline polygon fill into the mask (255 = land). Row-major, row 0 = north (z0). */
function scanlineFill(e, points) {
  const { w, h, rect } = e;
  const sx = rect.w / (w - 1), sz = rect.h / (h - 1);
  for (let r = 0; r < h; r++) {
    const wz = rect.z0 + r * sz;
    const xs = [];
    for (let i = 0; i < points.length; i++) {
      const [x1, z1] = points[i], [x2, z2] = points[(i + 1) % points.length];
      if ((z1 <= wz && z2 > wz) || (z2 <= wz && z1 > wz)) {
        xs.push(x1 + ((wz - z1) / (z2 - z1)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - rect.x0) / sx));
      const c1 = Math.min(w - 1, Math.floor((xs[k + 1] - rect.x0) / sx));
      for (let c = c0; c <= c1; c++) e.cells[r * w + c] = 255;
    }
  }
}

/** One brush dab. mode "land" raises toward 255, "ocean" carves toward 0; smooth cos² falloff
 *  gives a soft painted shoreline. Returns the touched cell bbox or null. */
export function landDab(e, wx, wz, { mode, radiusM }) {
  const { w, h, rect } = e;
  const sx = rect.w / (w - 1), sz = rect.h / (h - 1);
  const c0 = Math.max(0, Math.floor((wx - radiusM - rect.x0) / sx));
  const c1 = Math.min(w - 1, Math.ceil((wx + radiusM - rect.x0) / sx));
  const r0 = Math.max(0, Math.floor((wz - radiusM - rect.z0) / sz));
  const r1 = Math.min(h - 1, Math.ceil((wz + radiusM - rect.z0) / sz));
  if (c0 > c1 || r0 > r1) return null;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const dx = rect.x0 + c * sx - wx, dz = rect.z0 + r * sz - wz;
      const d = Math.hypot(dx, dz);
      if (d > radiusM) continue;
      const f = Math.cos((d / radiusM) * Math.PI * 0.5) ** 2; // 1 at center -> 0 at edge
      const i = r * w + c, v = e.cells[i];
      // Over-drive x4: the inner ~2/3 of the brush paints SOLID land, only the outer third is
      // shore gradient — a subtle beach skirt, not a halo half the brush wide.
      const nv = mode === "ocean"
        ? Math.min(v, Math.round(255 * (1 - Math.min(1, f * 4))))
        : Math.max(v, Math.round(255 * Math.min(1, f * 4)));
      // Quantize the shore gradient to 16 levels (multiples of 17, preserving 0 and 255):
      // visually identical at map zoom, but rle8 runs get ~5-10x longer — a smooth-gradient
      // mask encoded to ~77KB, banded it stays in the low tens of KB.
      e.cells[i] = Math.round(nv / 17) * 17;
    }
  }
  e.dirty = true; e.rev++;
  return { c0, r0, c1, r1 };
}

/** Ocean cells REACHABLE from the mask border. An ocean pocket fully enclosed by land is NOT
 *  real ocean: the compiler emits outer coast loops only (holes/lakes arrive with the water
 *  tools), so the display must show enclosed pockets as land — the coast you see IS the coast
 *  the world builds. Carve a channel to the sea and the pocket becomes a real bay instantly. */
function borderOcean(e) {
  const { w, h, cells } = e;
  const ocean = new Uint8Array(w * h);
  const q = new Int32Array(w * h);
  let qt = 0;
  const push = (i) => { if (!ocean[i] && cells[i] < 128) { ocean[i] = 1; q[qt++] = i; } };
  for (let c = 0; c < w; c++) { push(c); push((h - 1) * w + c); }
  for (let r = 0; r < h; r++) { push(r * w); push(r * w + w - 1); }
  for (let qh = 0; qh < qt; qh++) {
    const i = q[qh], c = i % w, r = (i / w) | 0;
    if (c > 0) push(i - 1);
    if (c < w - 1) push(i + 1);
    if (r > 0) push(i - w);
    if (r < h - 1) push(i + w);
  }
  return ocean;
}

/** The land layer as a data-URL image covering the mask rect (soft alpha shoreline). `eff`
 *  (from effectiveLand) substitutes the elevation-carved cells so dug water shows as sea. */
export function renderLandImage(e, mapId, eff) {
  const rev = eff ? eff.rev : e.rev;
  const hit = imgCache.get(mapId);
  if (hit && hit.rev === rev) return hit.url;
  const src = eff || e;
  const cv = document.createElement("canvas");
  cv.width = e.w; cv.height = e.h;
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(e.w, e.h);
  const R = parseInt(LAND_FILL.slice(1, 3), 16), G = parseInt(LAND_FILL.slice(3, 5), 16), B = parseInt(LAND_FILL.slice(5, 7), 16);
  const ocean = borderOcean(src);
  for (let i = 0; i < src.cells.length; i++) {
    const v = src.cells[i];
    const o = i * 4;
    img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B;
    if (!ocean[i]) {
      // Land — including enclosed ocean pockets (they compile as land; see borderOcean).
      // Ramp across the threshold band instead of a hard step so the coast edge reads smooth.
      const t = Math.max(0, Math.min(1, (v - 96) / 64));
      img.data[o + 3] = v >= 160 ? 242 : Math.round(t * 242 + (1 - t) * 120);
    } else {
      // Real (border-connected) ocean: a faint shallows skirt under the sub-threshold gradient.
      img.data[o + 3] = Math.round((v / 128) * 90);
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = cv.toDataURL("image/png");
  imgCache.set(mapId, { rev, url });
  return url;
}

/** The derived coastline polygons in world coords — cached per mask revision AND rect (a region
 *  move/resize changes world coords without touching cells). Recomputed at stroke end / undo /
 *  redo, never per dab (the <50ms budget lives in the gate). */
export function coastPolygons(e, mapId, eff) {
  const rev = eff ? eff.rev : e.rev;
  const rectKey = e.rect.x0 + "," + e.rect.z0 + "," + e.rect.w + "," + e.rect.h;
  const hit = coastCache.get(mapId);
  if (hit && hit.rev === rev && hit.rectKey === rectKey) return hit.polys;
  const polys = maskToLandPolygons(eff || e, {});
  coastCache.set(mapId, { rev, rectKey, polys });
  return polys;
}

export const coastStroke = COAST_STROKE;

/** Serialize dirty masks into their map docs at save-payload time. An all-ocean mask leaves the
 *  doc entirely (absent = not painted), so a fully-undone first stroke restores pure-vector
 *  compile precedence. */
export function syncLandmassIntoDoc(maps) {
  for (const map of maps || []) {
    const e = cache.get(map.id);
    if (!e || !e.dirty) continue;
    const any = e.cells.some((v) => v >= 128);
    map.rasters = map.rasters || {};
    if (any) {
      map.rasters.landmass = {
        w: e.w, h: e.h,
        rect: { x0: e.rect.x0, z0: e.rect.z0, w: e.rect.w, h: e.rect.h },
        ...encodeRasterCells(e.cells),
      };
    } else {
      delete map.rasters.landmass;
      if (Object.keys(map.rasters).length === 0) delete map.rasters;
    }
    e.dirty = false;
  }
}

// ─── Biome paint layer (Painter P2) ─────────────────────────────────────────────────────────────
// A paletted u8 raster: cell = BIOME_CLASSES index + 1, 0 = unpainted. MUST MATCH BIOME_KINDS in
// js/src/world/worldmap.ts and BIOME_CLASSES in design-map-compile.mjs (the gate asserts the
// sync). Fixed enum indices — no per-map palette array a reorder could silently repaint.

export const BIOME_CLASSES = ["grass", "forest", "mountain", "desert", "tundra", "swamp", "water", "blight"];
export const BIOME_SIZE = 256;
const BIOME_BASE = { grass: "#8aa85f", forest: "#4a7a45", mountain: "#8f8d88", desert: "#d9c48f", tundra: "#dbe4ea", swamp: "#6b7a55", water: "#3f6ea5", blight: "#6b6a66" };

const bioCache = new Map(); // mapId -> {w, h, rect, cells, dirty, rev}
const bioImgCache = new Map(); // mapId -> {key, url}

export function biomesOf(mapId) { return bioCache.get(mapId) || null; }
export function dropBiomesCache(mapId) { bioCache.delete(mapId); bioImgCache.delete(mapId); }
export function dropAllPaintCaches() {
  cache.clear(); imgCache.clear(); coastCache.clear(); effCache.clear();
  bioCache.clear(); bioImgCache.clear();
}

export function ensureBiomes(map) {
  let e = bioCache.get(map.id);
  if (e) return e;
  const b = map.rasters && map.rasters.biomes;
  if (!b) return null;
  e = { w: b.w, h: b.h, rect: { ...b.rect }, cells: decodeRasterCells(b, b.w * b.h), dirty: false, rev: 0 };
  bioCache.set(map.id, e);
  return e;
}

/** Create the biome raster (first terrain stroke only). Rect aligns with the landmass extent
 *  when one exists. Seeds from legacy hand-traced biome polygons — the caller bundles the seed
 *  into the first stroke's command (the landmass pattern), so conversion is one undoable act. */
export function createBiomes(map, markers) {
  const lm = cache.get(map.id);
  const rect = lm ? { ...lm.rect } : creationRect(map, markers);
  const e = { w: BIOME_SIZE, h: BIOME_SIZE, rect, cells: new Uint8Array(BIOME_SIZE * BIOME_SIZE), dirty: false, rev: 0 };
  for (const f of (map.features || [])) {
    if (f.type === "area" && f.kind === "biome" && Array.isArray(f.points) && f.points.length >= 3) {
      const idx = BIOME_CLASSES.indexOf(f.biome);
      if (idx >= 0) scanlineFillValue(e, f.points, idx + 1);
    }
  }
  bioCache.set(map.id, e);
  return e;
}

function scanlineFillValue(e, points, value) {
  const { w, h, rect } = e;
  const sx = rect.w / (w - 1), sz = rect.h / (h - 1);
  for (let r = 0; r < h; r++) {
    const wz = rect.z0 + r * sz;
    const xs = [];
    for (let i = 0; i < points.length; i++) {
      const [x1, z1] = points[i], [x2, z2] = points[(i + 1) % points.length];
      if ((z1 <= wz && z2 > wz) || (z2 <= wz && z1 > wz)) xs.push(x1 + ((wz - z1) / (z2 - z1)) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - rect.x0) / sx));
      const c1 = Math.min(w - 1, Math.floor((xs[k + 1] - rect.x0) / sx));
      for (let c = c0; c <= c1; c++) e.cells[r * w + c] = value;
    }
  }
}

/** One terrain dab: writes the class value (0 erases) hard within the radius — a paletted
 *  raster has no per-cell alpha; the soft look comes from the textured, dithered render. */
export function biomeDab(e, wx, wz, { value, radiusM }) {
  const { w, h, rect } = e;
  const sx = rect.w / (w - 1), sz = rect.h / (h - 1);
  const c0 = Math.max(0, Math.floor((wx - radiusM - rect.x0) / sx));
  const c1 = Math.min(w - 1, Math.ceil((wx + radiusM - rect.x0) / sx));
  const r0 = Math.max(0, Math.floor((wz - radiusM - rect.z0) / sz));
  const r1 = Math.min(h - 1, Math.ceil((wz + radiusM - rect.z0) / sz));
  if (c0 > c1 || r0 > r1) return null;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const dx = rect.x0 + c * sx - wx, dz = rect.z0 + r * sz - wz;
      if (dx * dx + dz * dz <= radiusM * radiusM) e.cells[r * w + c] = value;
    }
  }
  e.dirty = true; e.rev = (e.rev || 0) + 1;
  return { c0, r0, c1, r1 };
}

// Procedural texture tiles (32², canvas-generated — no external images). Deterministic per
// class via a tiny seeded xorshift so redraws are stable.
const tileCache = new Map();
function biomeTile(kind) {
  let t = tileCache.get(kind);
  if (t) return t;
  const cv = document.createElement("canvas");
  cv.width = 32; cv.height = 32;
  const ctx = cv.getContext("2d");
  const base = BIOME_BASE[kind] || "#888888";
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 32, 32);
  let s = 0; for (const ch of kind) s = (s * 31 + ch.charCodeAt(0)) | 0;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1000) / 1000; };
  const shade = (hex, f) => {
    const n = parseInt(hex.slice(1), 16);
    const ch2 = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
    return `rgb(${ch2(n >> 16)},${ch2((n >> 8) & 255)},${ch2(n & 255)})`;
  };
  // Per-class grain: speckle for grass/desert/tundra, blobs for forest/swamp, hatch for
  // mountain. Contrast is deliberately strong — the tile is sampled at raster scale, so faint
  // grain disappears into mush at map zoom.
  if (kind === "mountain") {
    ctx.strokeStyle = shade(base, 0.68); ctx.lineWidth = 1.4;
    for (let i = 0; i < 9; i++) { const x = rnd() * 32, y = rnd() * 32; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 4 + rnd() * 6, y + 2 - rnd() * 5); ctx.stroke(); }
    ctx.fillStyle = shade(base, 1.28);
    for (let i = 0; i < 12; i++) ctx.fillRect(rnd() * 32, rnd() * 32, 2, 2);
  } else if (kind === "forest" || kind === "swamp") {
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = shade(base, 0.62 + rnd() * 0.3);
      ctx.beginPath(); ctx.arc(rnd() * 32, rnd() * 32, 1.8 + rnd() * 2.6, 0, 7); ctx.fill();
    }
  } else {
    for (let i = 0; i < 34; i++) {
      ctx.fillStyle = shade(base, 0.74 + rnd() * 0.5);
      ctx.fillRect(rnd() * 32, rnd() * 32, 1.8, 1.8);
    }
  }
  t = ctx.getImageData(0, 0, 32, 32);
  tileCache.set(kind, t);
  return t;
}

export function biomesHaveContent(e) { return e.cells.some((v) => v !== 0); }

/** The biome layer as a data-URL image (2px per cell, dithered class lookup so boundaries read
 *  organic, textured from the class tiles, alpha-clipped to the landmass so paint never floats
 *  on open ocean). */
export function renderBiomesImage(e, mapId, landEntry) {
  const key = e.rev + ":" + (landEntry ? landEntry.rev + "/" + landEntry.rect.x0 + "," + landEntry.rect.w : "-") + ":" + e.rect.x0 + "," + e.rect.w;
  const hit = bioImgCache.get(mapId);
  if (hit && hit.key === key) return hit.url;
  const S = 3, W = e.w * S, H = e.h * S;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(W, H);
  const tiles = BIOME_CLASSES.map((k) => biomeTile(k));
  const sx = e.rect.w / (e.w - 1), sz = e.rect.h / (e.h - 1);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      // Dithered class lookup: a small deterministic jitter breaks the raster staircase.
      const jx = (((px * 73856093) ^ (py * 19349663)) >>> 16) % 100 / 100 - 0.5;
      const jz = (((px * 83492791) ^ (py * 2971215073)) >>> 16) % 100 / 100 - 0.5;
      const c = Math.max(0, Math.min(e.w - 1, Math.round(px / S + jx * 1.6)));
      const r = Math.max(0, Math.min(e.h - 1, Math.round(py / S + jz * 1.6)));
      const v = e.cells[r * e.w + c];
      const o = (py * W + px) * 4;
      if (v === 0) { img.data[o + 3] = 0; continue; }
      const tile = tiles[v - 1];
      const ti = ((py % 32) * 32 + (px % 32)) * 4;
      img.data[o] = tile.data[ti]; img.data[o + 1] = tile.data[ti + 1]; img.data[o + 2] = tile.data[ti + 2];
      let a = 225;
      if (landEntry) {
        // Clip to land: transform this biome cell's world position into the landmass grid.
        const wx = e.rect.x0 + c * sx, wz = e.rect.z0 + r * sz;
        const lc = Math.round((wx - landEntry.rect.x0) / (landEntry.rect.w / (landEntry.w - 1)));
        const lr = Math.round((wz - landEntry.rect.z0) / (landEntry.rect.h / (landEntry.h - 1)));
        const lv = (lc >= 0 && lc < landEntry.w && lr >= 0 && lr < landEntry.h) ? landEntry.cells[lr * landEntry.w + lc] : 0;
        a = lv >= 128 ? 225 : Math.round((lv / 128) * 90);
      }
      img.data[o + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = cv.toDataURL("image/png");
  bioImgCache.set(mapId, { key, url });
  return url;
}

// ─── WorldMap IR importer (Painter P4) ──────────────────────────────────────────────────────────
// A compiled WorldMap (design-space or FMG export) converts BACK into paint layers, so generated
// or previously-compiled maps become hand-editable with the same brushes. Pure compute — returns
// the serialized doc fields for cmdImportLayers; never mutates the map.

export function importWorldMapIntoLayers(worldMap, targetUnits = { kind: "m", unitsPerMeter: 1, origin: [0, 0] }) {
  const transform = createWorldMapToMapDocTransform(worldMap, targetUnits);
  const toTarget = transform.point, rectToTarget = transform.rect, targetScale = transform.targetUnitsPerMeter;
  // Extent: land ∪ biomes ∪ reliefGrid rect, padded — the world the IR describes.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const eat = (x, z) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; };
  for (const l of worldMap.land || []) for (const p of l.points) { const q=toTarget(p); eat(q[0], q[1]); }
  for (const b of worldMap.biomes || []) for (const p of b.points) { const q=toTarget(p); eat(q[0], q[1]); }
  const g = worldMap.reliefGrid;
  const targetGridRect = g ? rectToTarget(g.rect) : undefined;
  if (targetGridRect) { eat(targetGridRect.x0, targetGridRect.z0); eat(targetGridRect.x0 + targetGridRect.w, targetGridRect.z0 + targetGridRect.h); }
  if (minX === Infinity) throw new Error("worldmap has no spatial content to import");
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const span = Math.max(transform.metersToTargetLength(200), (maxX - minX) * 1.15, (maxZ - minZ) * 1.15);
  const rect = { x0: Math.round(cx - span / 2), z0: Math.round(cz - span / 2), w: Math.round(span), h: Math.round(span) };

  const rasters = {};
  // Landmass mask from the land polygons (holes carve back to ocean).
  if ((worldMap.land || []).length > 0) {
    const e = { w: LAND_SIZE, h: LAND_SIZE, rect, cells: new Uint8Array(LAND_SIZE * LAND_SIZE) };
    for (const l of worldMap.land) {
      scanlineFill(e, l.points.map(toTarget));
      for (const hole of l.holes || []) scanlineFillValue(e, hole.map(toTarget), 0);
    }
    rasters.landmass = { w: e.w, h: e.h, rect: { ...rect }, ...encodeRasterCells(e.cells) };
  }
  // Biome raster from the biome polygons (array order wins on overlap, like the compiler's).
  if ((worldMap.biomes || []).length > 0) {
    const e = { w: BIOME_SIZE, h: BIOME_SIZE, rect, cells: new Uint8Array(BIOME_SIZE * BIOME_SIZE) };
    for (const b of worldMap.biomes) {
      const idx = BIOME_CLASSES.indexOf(b.biome);
      if (idx >= 0) scanlineFillValue(e, b.points.map(toTarget), idx + 1);
    }
    rasters.biomes = { w: e.w, h: e.h, rect: { ...rect }, ...encodeRasterCells(e.cells) };
  }
  // Elevation: resample the reliefGrid (bilinear) into the import extent, keeping its y range.
  if (g) {
    const decoded = EL.decodeElevationRaster(g);
    const src = decoded.cells;
    const W = BIOME_SIZE, cells = new Uint16Array(W * W);
    const gx0 = targetGridRect.x0, gz0 = targetGridRect.z0, gw = targetGridRect.w, gh = targetGridRect.h;
    // Outside the source grid is flat y=0. Expand the range when necessary instead of silently
    // clamping 0 to a source endpoint and inventing an elevated plateau or abyss.
    const outMinY = Math.min(g.minY, 0), outMaxY = Math.max(g.maxY, 0);
    const outRange = { minY: outMinY, maxY: outMaxY };
    const flat = EL.yToVal(0, outRange);
    for (let r = 0; r < W; r++) {
      const wz = rect.z0 + r / (W - 1) * rect.h;
      for (let c = 0; c < W; c++) {
        const wx = rect.x0 + c / (W - 1) * rect.w;
        if (wx < gx0 || wx > gx0 + gw || wz < gz0 || wz > gz0 + gh) { cells[r * W + c] = flat; continue; }
        const u = Math.max(0, Math.min(g.w - 1, (wx - gx0) / gw * (g.w - 1)));
        const v = Math.max(0, Math.min(g.h - 1, (wz - gz0) / gh * (g.h - 1)));
        const c0 = Math.floor(u), r0 = Math.floor(v);
        const c1 = Math.min(g.w - 1, c0 + 1), r1 = Math.min(g.h - 1, r0 + 1);
        const fu = u - c0, fv = v - r0;
        const a = src[r0 * g.w + c0], b = src[r0 * g.w + c1], d = src[r1 * g.w + c0], f = src[r1 * g.w + c1];
        const sourceValue = (a * (1 - fu) + b * fu) * (1 - fv) + (d * (1 - fu) + f * fu) * fv;
        cells[r * W + c] = EL.yToVal(EL.valToY(sourceValue, decoded), outRange);
      }
    }
    rasters.elevation = EL.encodeElevationRaster({ w: W, h: W, rect: { ...rect }, minY: outMinY, maxY: outMaxY, cells });
  }
  // Asset anchors -> stamps; waterways/routes -> drawn line features.
  const stamps = (worldMap.anchors || [])
    .filter((a) => a.kind === "asset" && a.assetId)
    .map((a) => { const p=toTarget(a.position); return ({ id: a.id, assetId: a.assetId, x: p[0], z: p[1], ...(a.rot !== undefined ? { rot: a.rot } : {}), ...(a.scale !== undefined ? { scale: a.scale } : {}) }); });
  const featuresAppend = [
    ...(worldMap.waterways || []).map((w2) => ({ id: "f-imp-" + crypto.randomUUID(), type: "line", kind: "river", points: w2.points.map((p) => toTarget(p).map(Math.round)) })),
    ...(worldMap.routes || []).map((r2) => ({ id: "f-imp-" + crypto.randomUUID(), type: "line", kind: "road", points: r2.points.map((p) => toTarget(p).map(Math.round)) })),
  ];
  return {
    rasters,
    ...(stamps.length ? { stamps } : {}),
    ...(featuresAppend.length ? { featuresAppend } : {}),
    seaLevel: typeof worldMap.seaLevel === "number" ? worldMap.seaLevel : 0,
    rect,
    _upm: targetScale,
  };
}

export function syncBiomesIntoDoc(maps) {
  for (const map of maps || []) {
    const e = bioCache.get(map.id);
    if (!e || !e.dirty) continue;
    map.rasters = map.rasters || {};
    if (biomesHaveContent(e)) {
      map.rasters.biomes = {
        w: e.w, h: e.h,
        rect: { x0: e.rect.x0, z0: e.rect.z0, w: e.rect.w, h: e.rect.h },
        ...encodeRasterCells(e.cells),
      };
    } else {
      delete map.rasters.biomes;
      if (Object.keys(map.rasters).length === 0) delete map.rasters;
    }
    e.dirty = false;
  }
}
