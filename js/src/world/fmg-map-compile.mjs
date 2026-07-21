// fmg-map-compile.mjs — the PURE compiler for Azgaar Fantasy-Map-Generator "Full JSON" exports:
// (full-export text) -> a WorldMap IR object (see worldmap.ts for the schema this must satisfy).
// The FMG front-end mirrors design-map-compile.mjs exactly: pure and dependency-free (no fs, no
// process, no Date/Math.random) so it is gated directly (js/test/p_fmg_compile.ts imports
// compileFmgMap and asserts determinism), and tools/map/compile-fmg.mjs — the CLI — is a thin,
// untested-logic wrapper: read the export, call this, write the file, print a summary.
//
// WHAT AN FMG FULL EXPORT LOOKS LIKE (verified against FMG source at v1.134.2,
// src/services/io/export-json.ts getFullDataJson): JSON.stringify of {info{version,seed,mapId,
// width,height}, settings{distanceScale,distanceUnit,...}, mapCoordinates, pack, grid,
// biomesData, notes, nameBases}. The pack is the resolved map. The CURRENT exporter emits
// pack.cells as an ARRAY OF PER-CELL OBJECTS ({i, p:[x,y] px center, h: height 0-100 with 20 =
// sea level, biome: biome index, f: feature id, v: vertex-id ring, c: neighbor cell ids, ...})
// and pack.vertices as an array of {i, p:[x,y], v, c}; FMG's INTERNAL graph (and older exports)
// is the same data as STRUCTURE-OF-ARRAYS (cells.p/h/biome/f/v/c as parallel arrays) — this
// compiler normalizes EITHER layout. features[] entries are {i,land,border,type:"ocean"|
// "island"|"lake",...} with features[0] the literal number 0 (a placeholder, same for burgs[0]);
// rivers[] carry width (mouth width in KM) + discharge (m³/s) and only OPTIONALLY points
// (hand-edited rivers only — freshly generated rivers have cells but no points); routes[]
// points are [x,y,cellId] triplets grouped "roads"|"trails"|"searoutes"; burgs[].capital is
// the number 1/0; biomesData {i[],name[],color[],...}.
//
// SCALE CONTRACT: FMG coordinates are SVG pixels; settings.distanceScale is "<unit> per px" and
// settings.distanceUnit names the unit (km / mi supported — anything else is REJECTED, never
// guessed). metersPerPx = distanceScale * unitToMeters. Every output coordinate is
// (px - landCentroidPx) * metersPerPx — recentered so the landmass centroid sits at world (0,0)
// — with unitsPerMeter fixed at 1 and origin [0,0] (already meters, the IR's preferred form).
// FMG's y axis (SVG, grows downward/south) maps directly onto the IR's second coordinate (z).
//
// DETERMINISM: no provenance.compiledAt is stamped (a wall clock would break "compile the same
// export twice -> byte-identical"). provenance.sourceHash pins the INPUT bytes,
// provenance.contentHash (worldmap-hash.mjs — the exact function the engine re-verifies with)
// pins the compiled OUTPUT.

import { sha256 } from "./sha256.mjs";
import { worldMapContentHash } from "./worldmap-hash.mjs";

const SEA_LEVEL_H = 20; // FMG: cells.h < 20 is water, >= 20 is land.
const MOUNTAIN_H = 60; //  h >= 60 -> "mountain" relief group.
const HILLS_H = 45; //     45 <= h < 60 -> "hills" relief group.
const RELIEF_MAX_AMPLITUDE_M = 30; // amplitude = mean(h - 20)/80 * 30m over the group's cells.
const RIVER_FALLBACK_WIDTH_M = 3;

const UNIT_TO_METERS = {
  km: 1000,
  mi: 1609.344,
};

// FMG default biome names (biomesData.name) -> the IR's biome enum. Matching is by NAME (the
// index table travels in the export as biomesData), case-insensitive; any land biome that maps
// to nothing falls back to "grass" WITH a warning — better a grassy field than a hole in the map.
// "Marine" maps to null: water is expressed by the land polygons / seaLevel, not a biome region.
function mapBiomeName(name) {
  const n = String(name).toLowerCase();
  if (n === "marine") return null;
  if (n.includes("forest") || n === "taiga") return "forest";
  if (n.includes("desert")) return "desert"; // Hot desert, Cold desert
  if (n === "grassland" || n === "savanna") return "grass";
  if (n === "tundra" || n === "glacier") return "tundra";
  if (n === "wetland") return "swamp";
  return undefined; // unmapped -> caller warns and uses "grass".
}

// ── small pure geometry helpers ─────────────────────────────────────────────────────────────

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1]);
  }
  return a / 2;
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    const denom = (yj - yi) || 1e-12;
    const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / denom + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Andrew's monotone-chain convex hull over [x,y] points; returns hull ring (CCW, no repeat). */
function convexHull(points) {
  const pts = points.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const uniq = [];
  for (const p of pts) {
    const last = uniq[uniq.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) uniq.push(p);
  }
  if (uniq.length < 3) return uniq;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// ── REGION CROP (compile-fmg.mjs --crop/--radius) ──────────────────────────────────────────
// A crop takes a whole (possibly whole-planet-scale) FMG export and keeps only a disc of cells
// around an anchor, re-centering the anchor to world (0,0). This is the only way a real export
// (whose native px scale is often kilometers-per-cell) becomes a walkable region: rescaling the
// WHOLE map to fit a small IR extent produces uniform biome/relief stripes (every land feature
// shrinks by the same factor, so nothing reads as organic) — cropping keeps native meters/px and
// throws away everything outside the disc instead.

const PX_COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*-px\s*$/i;

/** Levenshtein edit distance (small strings only — burg-name suggestion ranking, not a hot path). */
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/**
 * Resolve a --crop spec to a pixel anchor: either the literal "x,y-px" form (raw export pixel
 * coordinates, no lookup) or a burg name (case-insensitive exact match against pack.burgs). An
 * unresolved name throws BY NAME, listing the closest burg names (edit-distance ranked) so a typo
 * doesn't dead-end into a silent empty crop.
 */
function resolveCropAnchor(spec, pack) {
  const text = String(spec);
  const pxMatch = PX_COORD_RE.exec(text);
  if (pxMatch) {
    return { x: Number(pxMatch[1]), y: Number(pxMatch[2]), label: `${Number(pxMatch[1])},${Number(pxMatch[2])}-px` };
  }
  const burgs = (pack.burgs ?? []).filter((b) => b && typeof b === "object" && b.i !== undefined && b.i !== 0 && !b.removed);
  const needle = text.trim().toLowerCase();
  const exact = burgs.find((b) => String(b.name ?? "").trim().toLowerCase() === needle);
  if (exact) return { x: exact.x, y: exact.y, label: String(exact.name) };
  const ranked = burgs
    .map((b) => ({ name: String(b.name ?? `burg-${b.i}`), dist: levenshtein(needle, String(b.name ?? "").trim().toLowerCase()) }))
    .sort((a, b) => a.dist - b.dist || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map((b) => b.name);
  throw new Error(
    `compile-fmg: --crop burg "${spec}" not found among ${burgs.length} burgs. Near matches: ${ranked.join(", ") || "(none)"}`,
  );
}

/** Split a polyline (already in world meters, anchor at origin) into runs of points within
 *  radiusM of the origin, dropping out-of-disc points and splitting at each exit/re-entry. Runs
 *  of fewer than 2 points (nothing left to draw a segment with) are dropped. */
function clipPolylineToDisc(pointsM, radiusM) {
  const runs = [];
  let current = [];
  for (const p of pointsM) {
    if (Math.sqrt(p[0] * p[0] + p[1] * p[1]) <= radiusM) current.push(p);
    else { if (current.length > 0) runs.push(current); current = []; }
  }
  if (current.length > 0) runs.push(current);
  return runs.filter((r) => r.length >= 2);
}

// ── pack readers ────────────────────────────────────────────────────────────────────────────

/** Normalize pack.cells to structure-of-arrays {p,h,biome,f,v,c}: the v1.134 exporter emits an
 *  array of per-cell objects; FMG's internal graph (and older exports) is already SoA. */
function normalizeCells(rawCells) {
  if (Array.isArray(rawCells)) {
    return {
      p: rawCells.map((c) => c.p),
      h: rawCells.map((c) => c.h),
      biome: rawCells.map((c) => c.biome),
      f: rawCells.map((c) => c.f),
      v: rawCells.map((c) => c.v),
      c: rawCells.map((c) => c.c),
    };
  }
  if (rawCells && Array.isArray(rawCells.p)) return rawCells;
  return null;
}

/** Normalize pack.vertices to {p: [x,y][]} (array-of-objects or SoA, as with cells). */
function normalizeVertices(rawVertices) {
  if (Array.isArray(rawVertices)) return { p: rawVertices.map((v) => v.p) };
  if (rawVertices && Array.isArray(rawVertices.p)) return rawVertices;
  return null;
}

/** Cell adjacency: prefer pack.cells.c (FMG's neighbor lists); derive from shared ring edges
 *  when absent (two cells are neighbors iff their vertex rings share an edge). */
function buildAdjacency(cells) {
  const n = cells.p.length;
  if (Array.isArray(cells.c) && cells.c.length === n) {
    return (i) => cells.c[i];
  }
  const edgeOwners = new Map(); // "a-b" (a<b vertex ids) -> [cell ids]
  for (let i = 0; i < n; i++) {
    const ring = cells.v[i];
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      let owners = edgeOwners.get(key);
      if (!owners) edgeOwners.set(key, owners = []);
      owners.push(i);
    }
  }
  const neighbors = Array.from({ length: n }, () => []);
  for (const owners of edgeOwners.values()) {
    if (owners.length === 2) {
      neighbors[owners[0]].push(owners[1]);
      neighbors[owners[1]].push(owners[0]);
    }
  }
  return (i) => neighbors[i];
}

/** Flood-fill `memberIndices` (ascending) into contiguous groups via `neighborsOf`. */
function contiguousGroups(memberIndices, neighborsOf) {
  const memberSet = new Set(memberIndices);
  const seen = new Set();
  const groups = [];
  for (const start of memberIndices) {
    if (seen.has(start)) continue;
    const group = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const c = stack.pop();
      group.push(c);
      for (const nb of neighborsOf(c)) {
        if (memberSet.has(nb) && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
      }
    }
    group.sort((a, b) => a - b);
    groups.push(group);
  }
  return groups;
}

/**
 * Trace the boundary of a set of cells as closed vertex rings. Every ring edge of a member cell
 * that is NOT shared with another member cell is a boundary edge (interior edges appear exactly
 * twice); boundary edges are chained vertex-to-vertex into rings. Returns rings of vertex ids.
 */
function traceBoundaryRings(cellIndices, cells) {
  const edgeCount = new Map(); // "a-b" -> occurrences among member cells
  for (const i of cellIndices) {
    const ring = cells.v[i];
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
    }
  }
  // vertex -> boundary-neighbor vertices (deterministic: insertion follows ascending edge keys).
  const adj = new Map();
  const boundaryKeys = [...edgeCount.keys()].filter((k) => edgeCount.get(k) === 1).sort();
  for (const key of boundaryKeys) {
    const [a, b] = key.split("-").map(Number);
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  }
  const visitedEdges = new Set();
  const rings = [];
  const startVerts = [...adj.keys()].sort((a, b) => a - b);
  for (const start of startVerts) {
    for (const firstNext of adj.get(start)) {
      const k0 = start < firstNext ? `${start}-${firstNext}` : `${firstNext}-${start}`;
      if (visitedEdges.has(k0)) continue;
      const ring = [start];
      let prev = start, cur = firstNext;
      visitedEdges.add(k0);
      while (cur !== start) {
        ring.push(cur);
        const nexts = adj.get(cur).filter((v) => {
          const k = cur < v ? `${cur}-${v}` : `${v}-${cur}`;
          return v !== prev && !visitedEdges.has(k);
        });
        if (nexts.length === 0) break; // open chain — degenerate input; drop below.
        const next = nexts[0];
        visitedEdges.add(cur < next ? `${cur}-${next}` : `${next}-${cur}`);
        prev = cur; cur = next;
      }
      if (cur === start && ring.length >= 3) rings.push(ring);
    }
  }
  return rings;
}

/**
 * Compile an FMG Full JSON export into a plain WorldMap-shaped object (matching worldmap.ts's
 * WorldMapSchema — the caller zod-parses it; this pure function has no zod dependency so it runs
 * from plain Node with no engine build).
 *
 * @param {string} fmgJsonText raw contents of the FMG Full JSON export
 * @param {object} [opts]
 * @param {string} [opts.mapId]                 output WorldMap id (default "fmg-<info.mapId>")
 * @param {number} [opts.anchorMinPopulation=0] skip burgs below this population (FMG
 *   "population points" — headcount is population x populationRate x urbanization; the
 *   threshold compares the raw points value as exported)
 * @param {object} [opts.crop] a REGION CROP: keep only a disc of cells around an anchor,
 *   re-centered to world (0,0), at the export's NATIVE meters/px (no rescale). This is how a
 *   real (often whole-planet-scale) export becomes a walkable region — uniformly rescaling the
 *   whole map instead would shrink every biome/relief feature by the same factor and produce
 *   flat stripes, not organic terrain.
 * @param {string} [opts.crop.anchor] a burg name (case-insensitive exact match; on a miss, throws
 *   listing the closest names by edit distance) or a raw "x,y-px" pixel coordinate string
 * @param {number} [opts.crop.radiusM] crop radius in METERS (converted to px via the export's
 *   own distanceScale/distanceUnit)
 * @returns {{ worldMap: object, warnings: string[] }}
 */
export function compileFmgMap(fmgJsonText, opts = {}) {
  const warnings = [];
  const doc = JSON.parse(fmgJsonText);

  // ── 1. VERSION GATE: accept major 1 only; reject anything else BY NAME. ──────────────────
  const version = doc?.info?.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("compile-fmg: export has no info.version — not an FMG Full JSON export?");
  }
  const major = version.split(".")[0];
  if (major !== "1") {
    throw new Error(
      `compile-fmg: unsupported FMG version "${version}" (major ${major}) — this compiler understands ` +
      `major version 1 exports only; re-export from FMG 1.x or extend the compiler`,
    );
  }

  const pack = doc.pack;
  const cells = pack ? normalizeCells(pack.cells) : null;
  const vertices = pack ? normalizeVertices(pack.vertices) : null;
  if (!cells || !vertices) {
    throw new Error("compile-fmg: export has no usable pack.cells/pack.vertices — not a Full JSON export (use FMG's 'Full' JSON export, not 'Minimal')");
  }
  const nCells = cells.p.length;

  // ── 2. SCALE: metersPerPx = distanceScale (unit per px) x unit-to-meters. ─────────────────
  const settings = doc.settings ?? {};
  const distanceScale = Number(settings.distanceScale);
  if (!(distanceScale > 0)) {
    throw new Error(`compile-fmg: settings.distanceScale must be a positive number (got ${JSON.stringify(settings.distanceScale)})`);
  }
  const unit = String(settings.distanceUnit ?? "").toLowerCase();
  const unitM = UNIT_TO_METERS[unit];
  if (unitM === undefined) {
    throw new Error(
      `compile-fmg: unknown settings.distanceUnit "${settings.distanceUnit}" — supported: ${Object.keys(UNIT_TO_METERS).join(", ")} ` +
      `(no silent guessing; set a supported unit in FMG's options and re-export)`,
    );
  }
  const metersPerPx = distanceScale * unitM;

  // Landmass centroid (mean of land-cell centers, h >= 20) -> the export's world (0,0) for a
  // WHOLE-map compile. Still computed even when cropping (cheap, and validates the export has
  // any land at all) but cx/cy get overridden below to the crop anchor when opts.crop is set.
  let cxSum = 0, cySum = 0, landCount = 0;
  for (let i = 0; i < nCells; i++) {
    if (cells.h[i] >= SEA_LEVEL_H) { cxSum += cells.p[i][0]; cySum += cells.p[i][1]; landCount++; }
  }
  if (landCount === 0) throw new Error("compile-fmg: export contains no land cells (all h < 20)");
  let cx = cxSum / landCount, cy = cySum / landCount;

  // ── REGION CROP: resolve the anchor + radius, override the recenter origin to the anchor, and
  //    build the kept-cell subset (cell CENTER within radiusPx of the anchor). Every other section
  //    below (land/relief/biomes/waterways/routes/anchors) filters against `subsetSet` when set. ──
  let subsetSet = null;
  let cropRadiusM = null;
  let cropAnchorLabel = null;
  if (opts.crop) {
    const radiusM = Number(opts.crop.radiusM);
    if (!(radiusM > 0)) throw new Error(`compile-fmg: --radius must be a positive number of meters (got ${JSON.stringify(opts.crop.radiusM)})`);
    const resolved = resolveCropAnchor(opts.crop.anchor, pack);
    cx = resolved.x; cy = resolved.y;
    cropRadiusM = radiusM;
    cropAnchorLabel = resolved.label;
    const radiusPx = radiusM / metersPerPx;
    subsetSet = new Set();
    for (let i = 0; i < nCells; i++) {
      const dx = cells.p[i][0] - cx, dy = cells.p[i][1] - cy;
      if (Math.sqrt(dx * dx + dy * dy) <= radiusPx) subsetSet.add(i);
    }
    if (subsetSet.size === 0) {
      throw new Error(`compile-fmg: --crop "${opts.crop.anchor}" --radius ${radiusM} produced an empty cell subset — increase --radius`);
    }
  }
  const toMeters = (p) => [(p[0] - cx) * metersPerPx, (p[1] - cy) * metersPerPx];
  const inSubset = (i) => subsetSet === null || subsetSet.has(i);

  const neighborsOf = buildAdjacency(cells);

  // ── 3. LAND: per island feature, trace the coastline (boundary edges of the feature's cell
  //    set, chained into rings — exact cell geometry, not an approximation). Largest-|area|
  //    ring is the outer coast; other rings inside it are holes (inland lakes). When cropping,
  //    memberCells is intersected with the crop subset FIRST — traceBoundaryRings then treats any
  //    edge no longer shared with a kept neighbor (because that neighbor fell outside the disc) as
  //    a boundary edge too, so the crop rim reads as coastline: the world just ends in sea at the
  //    disc's edge. This is the simplest-correct v1 (no true clip-to-circle geometry). ───────────
  const land = [];
  const features = Array.isArray(pack.features) ? pack.features : [];
  const islands = features.filter((f) => f && f.type === "island");
  for (const island of islands) {
    const memberCells = [];
    for (let i = 0; i < nCells; i++) if (cells.f[i] === island.i && inSubset(i)) memberCells.push(i);
    if (memberCells.length === 0) { warnings.push(`island feature ${island.i} has no cells — skipped`); continue; }
    const rings = traceBoundaryRings(memberCells, cells)
      .map((ring) => ring.map((v) => toMeters(vertices.p[v])));
    if (rings.length === 0) { warnings.push(`island feature ${island.i}: coastline trace produced no closed ring — skipped`); continue; }
    let outerIdx = 0, outerArea = -Infinity;
    for (let r = 0; r < rings.length; r++) {
      const a = Math.abs(ringArea(rings[r]));
      if (a > outerArea) { outerArea = a; outerIdx = r; }
    }
    const outer = rings[outerIdx];
    const holes = [];
    for (let r = 0; r < rings.length; r++) {
      if (r === outerIdx) continue;
      if (pointInRing(rings[r][0][0], rings[r][0][1], outer)) holes.push(rings[r]);
      else warnings.push(`island feature ${island.i}: dropped a stray boundary ring outside the outer coast`);
    }
    land.push(holes.length > 0 ? { points: outer, holes } : { points: outer });
  }
  if (land.length === 0) throw new Error("compile-fmg: no island features traced into land polygons");

  // ── 4. RELIEF: contiguous h>=60 groups -> mountain hints, 45<=h<60 -> hills; polygon =
  //    convex hull of the group's cell VERTICES (real area even for one cell), amplitude =
  //    mean(h - 20)/80 * 30m over the group. ──────────────────────────────────────────────────
  const relief = [];
  const reliefBand = (min, max, kind) => {
    const members = [];
    for (let i = 0; i < nCells; i++) if (cells.h[i] >= min && cells.h[i] < max && inSubset(i)) members.push(i);
    for (const group of contiguousGroups(members, neighborsOf)) {
      const hullPts = [];
      for (const i of group) for (const v of cells.v[i]) hullPts.push(toMeters(vertices.p[v]));
      const hull = convexHull(hullPts);
      if (hull.length < 3) continue;
      let hSum = 0;
      for (const i of group) hSum += cells.h[i] - SEA_LEVEL_H;
      const amplitude = (hSum / group.length) / 80 * RELIEF_MAX_AMPLITUDE_M;
      relief.push({ kind, shape: { polygon: hull }, amplitude });
    }
  };
  reliefBand(MOUNTAIN_H, Infinity, "mountain");
  reliefBand(HILLS_H, MOUNTAIN_H, "hills");

  // ── 5. BIOMES: land cells grouped by MAPPED biome, contiguous groups -> convex-hull regions
  //    (coarse by design for v1 — the rasterizer paints, it doesn't survey). ──────────────────
  const biomesData = doc.biomesData ?? { name: [] };
  const biomeNames = biomesData.name ?? [];
  const unmappedNames = new Set();
  const cellsByBiome = new Map(); // IR biome -> cell indices
  for (let i = 0; i < nCells; i++) {
    if (cells.h[i] < SEA_LEVEL_H) continue; // water cells: never a biome region.
    if (!inSubset(i)) continue;
    const name = biomeNames[cells.biome[i]] ?? `#${cells.biome[i]}`;
    let mapped = mapBiomeName(name);
    if (mapped === null) continue; // Marine on a land cell — ignore.
    if (mapped === undefined) { unmappedNames.add(name); mapped = "grass"; }
    if (!cellsByBiome.has(mapped)) cellsByBiome.set(mapped, []);
    cellsByBiome.get(mapped).push(i);
  }
  for (const name of [...unmappedNames].sort()) {
    warnings.push(`unmapped FMG biome "${name}" -> "grass" (extend mapBiomeName for a better fit)`);
  }
  const biomes = [];
  for (const biome of [...cellsByBiome.keys()].sort()) {
    for (const group of contiguousGroups(cellsByBiome.get(biome), neighborsOf)) {
      const hullPts = [];
      for (const i of group) for (const v of cells.v[i]) hullPts.push(toMeters(vertices.p[v]));
      const hull = convexHull(hullPts);
      if (hull.length < 3) continue;
      biomes.push({ biome, points: hull });
    }
  }

  // ── 6. WATERWAYS: rivers -> river polylines; width km -> m (>= 1m floor), else a discharge
  //    heuristic, else 3m. rivers[].points when present, else the river cells' centers. When
  //    cropping, each polyline is clipped to the crop disc AFTER recentering (so "inside" is just
  //    distance-from-origin <= radiusM) and split into separate waterway entries at each exit/
  //    re-entry — dropped points, not interpolated to the exact disc boundary (v1). ─────────────
  const waterways = [];
  for (const river of pack.rivers ?? []) {
    if (!river || typeof river !== "object" || river.i === undefined) continue;
    let pts;
    if (Array.isArray(river.points) && river.points.length >= 2) {
      pts = river.points.map((p) => toMeters(p));
    } else if (Array.isArray(river.cells) && river.cells.length >= 2) {
      pts = river.cells.filter((c) => c >= 0 && c < nCells).map((c) => toMeters(cells.p[c]));
    } else {
      warnings.push(`river ${river.i} has neither points nor >=2 cells — skipped`);
      continue;
    }
    if (pts.length < 2) { warnings.push(`river ${river.i} resolved to <2 points — skipped`); continue; }
    let widthM;
    if (Number(river.width) > 0) widthM = Number(river.width) * 1000; // FMG river width is km.
    else if (Number(river.discharge) > 0) widthM = Math.sqrt(Number(river.discharge)) * 0.1; // m³/s -> rough channel width
    else widthM = RIVER_FALLBACK_WIDTH_M;
    const segments = subsetSet ? clipPolylineToDisc(pts, cropRadiusM) : [pts];
    for (const seg of segments) waterways.push({ points: seg, widthM: Math.max(1, widthM), class: "river" });
  }

  // ── 7. ROUTES: roads -> road, trails -> trail, searoutes skipped (the sea needs no paving).
  //    Crop-clipped the same way waterways are. ─────────────────────────────────────────────────
  const routes = [];
  for (const route of pack.routes ?? []) {
    if (!route || !Array.isArray(route.points) || route.points.length < 2) continue;
    const group = route.group;
    const cls = group === "roads" ? "road" : group === "trails" ? "trail" : null;
    if (cls === null) {
      if (group !== "searoutes") warnings.push(`route ${route.i} group "${group}" has no mapping — skipped`);
      continue;
    }
    const pts = route.points.map((p) => toMeters(p));
    const segments = subsetSet ? clipPolylineToDisc(pts, cropRadiusM) : [pts];
    for (const seg of segments) routes.push({ points: seg, class: cls });
  }

  // ── 8. ANCHORS: burgs (skip the [0] placeholder + sub-threshold populations). Capital ->
  //    "civic", the rest -> "dwelling". Ids are stable slugs; collisions get the burg index.
  //    Cropping keeps a burg by its own (px) position within the disc — NOT by cell membership,
  //    since a burg can sit at a cell center that itself independently falls in/out. ─────────────
  const anchorMinPopulation = opts.anchorMinPopulation ?? 0;
  const anchors = [];
  const usedIds = new Set();
  for (const burg of pack.burgs ?? []) {
    if (!burg || typeof burg !== "object" || burg.i === undefined || burg.i === 0) continue; // burgs[0] placeholder
    if (burg.removed) continue;
    if (Number(burg.population ?? 0) < anchorMinPopulation) continue;
    const positionM = toMeters([burg.x, burg.y]);
    if (subsetSet && Math.sqrt(positionM[0] * positionM[0] + positionM[1] * positionM[1]) > cropRadiusM) continue;
    let id = burg.name ? `burg-${slugify(burg.name)}` : `burg-${burg.i}`;
    if (usedIds.has(id) || id === "burg-") id = `burg-${burg.i}`;
    usedIds.add(id);
    anchors.push({
      id,
      kind: burg.capital ? "civic" : "dwelling",
      position: positionM,
      count: 1,
      ...(burg.name ? { name: String(burg.name) } : {}),
      source: "map",
    });
  }

  // ── extent: the crop disc's own bbox when cropping (2*radiusM square — independent of how
  //    much of the disc actually came out as land); otherwise the land bbox in meters as before. ─
  let extent;
  if (subsetSet) {
    extent = { w: cropRadiusM * 2, h: cropRadiusM * 2 };
  } else {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const poly of land) {
      for (const [x, y] of poly.points) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    extent = { w: Math.max(maxX - minX, 1), h: Math.max(maxY - minY, 1) };
  }

  const worldMap = {
    version: 1,
    id: opts.mapId || `fmg-${doc.info.mapId ?? doc.info.seed ?? "map"}`,
    unitsPerMeter: 1,
    origin: [0, 0],
    extent,
    seaLevel: 0.0,
    land,
    relief,
    biomes,
    waterways,
    routes,
    anchors,
    provenance: {
      tool: "fmg",
      sourceHash: sha256(fmgJsonText),
      // compiledAt intentionally omitted (determinism — see module header).
      contentHash: "", // placeholder; replaced below once the rest of the shape is final
      ...(subsetSet ? { cropOf: { anchor: cropAnchorLabel, anchorPx: [cx, cy], radiusM: cropRadiusM } } : {}),
    },
  };
  worldMap.provenance.contentHash = worldMapContentHash(worldMap);

  return { worldMap, warnings };
}
