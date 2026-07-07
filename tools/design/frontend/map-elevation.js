// map-elevation.js — Map Studio S1: painted elevation. Owns the per-map decoded raster cache
// (the MapDoc stores base64; painting works on a live Uint8Array), the raise/lower/smooth/level
// brush math, and the hillshade render (offscreen canvas -> data-URL <image> in the map SVG).
// Interaction wiring (tool state, pointer events, undo commit) lives in map.js; the stroke's
// undo step is map-commands.js's cmdPatchRaster over the bounding box the stroke touched.
//
// GRID CONVENTION (must match worldmap.ts's ReliefGridSchema): u8 cells, value/255 -> [minY,maxY]
// meters, row-major, +col = +x (east), +row = +z — row 0 is the NORTHERNMOST row (north = -z,
// drawn screen-up). `rect` is the world-meter square the raster spans, fixed at creation.

export const ELEV_SIZE = 256;          // 256² per map (locked decision: ~2m/cell on a 500m map)
export const ELEV_MIN_Y = -16;         // value 0   -> -16m
export const ELEV_MAX_Y = 48;          // value 255 -> +48m  (0.25m per step)
const SEA_DEFAULT = 0;

const yToVal = (y) => Math.max(0, Math.min(255, Math.round(((y - ELEV_MIN_Y) / (ELEV_MAX_Y - ELEV_MIN_Y)) * 255)));
export const valToY = (v, g) => (g ? g.minY + (v / 255) * (g.maxY - g.minY) : ELEV_MIN_Y + (v / 255) * (ELEV_MAX_Y - ELEV_MIN_Y));

// ---- base64 <-> Uint8Array (browser-native atob/btoa over binary strings) ----------------------
function b64ToU8(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function u8ToB64(u8) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  return btoa(bin);
}

// ---- per-map raster cache -----------------------------------------------------------------------
// mapId -> { w, h, rect, minY, maxY, cells: Uint8Array, dirty: boolean }
const cache = new Map();

/** The world rect a NEW raster should span: a square centered on the SETTLED content — the
 *  markers' bbox when the map has markers, else the features' — padded 1.5x, min 120m, and
 *  CAPPED at 512m (so 256² stays ≥ 2m/cell and a brush stroke always moves many cells; a
 *  continental coast outline must not stretch the paintable area to uselessness). Terrain
 *  outside the rect stays polygon/clamp-driven in the rasterizer (clamp-to-edge sampling +
 *  the land/sea vertical-separation clamp), so a big island still builds sanely. Fixed at
 *  creation — it never shifts afterward. */
function creationRect(map, markers) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const feed = (x, z) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; };
  if (markers && markers.length) {
    for (const m of markers) feed(m.x, m.z);
  } else {
    for (const f of map.features || []) {
      if (f.type === "glyph") feed(f.x, f.z);
      else for (const p of f.points || []) feed(p[0], p[1]);
    }
  }
  if (minX === Infinity) { minX = maxX = minZ = maxZ = 0; }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const span = Math.min(512, Math.max(120, Math.ceil(Math.max(maxX - minX, maxZ - minZ) * 1.5)));
  return { x0: Math.round(cx - span / 2), z0: Math.round(cz - span / 2), w: span, h: span };
}

/** Get (or lazily create) the live decoded raster for a map. Creation seeds every cell at y=0
 *  (a flat plain at old sea level) so enabling elevation never visibly changes the terrain. */
export function ensureElevation(map, markers) {
  let e = cache.get(map.id);
  if (e) return e;
  const stored = map.rasters && map.rasters.elevation;
  if (stored) {
    e = { w: stored.w, h: stored.h, rect: { ...stored.rect }, minY: stored.minY, maxY: stored.maxY, cells: b64ToU8(stored.data), dirty: false };
  } else {
    const cells = new Uint8Array(ELEV_SIZE * ELEV_SIZE).fill(yToVal(0));
    e = { w: ELEV_SIZE, h: ELEV_SIZE, rect: creationRect(map, markers), minY: ELEV_MIN_Y, maxY: ELEV_MAX_Y, cells, dirty: true };
  }
  cache.set(map.id, e);
  return e;
}

export function elevationOf(mapId) { return cache.get(mapId) || null; }
export function hasStoredElevation(map) { return !!(map.rasters && map.rasters.elevation) || cache.has(map.id); }
export function dropElevationCache(mapId) { cache.delete(mapId); }

/** Serialize every dirty cached raster back into its map's doc object (called by the save-payload
 *  getter, so rasters encode on stroke-end debounce, never per pointer move). */
export function syncElevationIntoDoc(maps) {
  for (const map of maps || []) {
    const e = cache.get(map.id);
    if (!e || !e.dirty) continue;
    if (!map.rasters) map.rasters = {};
    map.rasters.elevation = { w: e.w, h: e.h, rect: { ...e.rect }, minY: e.minY, maxY: e.maxY, data: u8ToB64(e.cells) };
    e.dirty = false;
  }
}

// ---- brush ---------------------------------------------------------------------------------------
/** Apply one brush dab at world (wx,wz). mode: raise|lower|smooth|level. radiusM in meters,
 *  strength 0..1. `levelY` is the target elevation for the level tool. Returns the touched cell
 *  bbox {x0,y0,x1,y1} or null. Smooth cos² falloff from the dab center. */
export function brushDab(e, wx, wz, { mode, radiusM, strength, levelY }) {
  const cellW = e.rect.w / (e.w - 1), cellH = e.rect.h / (e.h - 1);
  const cc = (wx - e.rect.x0) / cellW, cr = (wz - e.rect.z0) / cellH;
  const rc = radiusM / cellW, rr = radiusM / cellH;
  const c0 = Math.max(0, Math.floor(cc - rc)), c1 = Math.min(e.w - 1, Math.ceil(cc + rc));
  const r0 = Math.max(0, Math.floor(cr - rr)), r1 = Math.min(e.h - 1, Math.ceil(cr + rr));
  if (c1 < c0 || r1 < r0) return null;
  const stepPerDab = ((e.maxY - e.minY) / 255);
  // raise/lower move up to ~1.2m per dab at strength 1; level pulls 35%/dab; smooth blends 30%/dab.
  const amount = (1.2 * strength) / stepPerDab;
  const src = mode === "smooth" ? e.cells.slice() : null;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const dx = (c - cc) / rc, dz = (r - cr) / rr;
      const d = Math.hypot(dx, dz);
      if (d > 1) continue;
      const fall = Math.cos((d * Math.PI) / 2) ** 2;
      const i = r * e.w + c;
      let v = e.cells[i];
      if (mode === "raise") v += amount * fall;
      else if (mode === "lower") v -= amount * fall;
      else if (mode === "level") v += (yToVal(levelY) - v) * 0.35 * strength * fall;
      else if (mode === "smooth") {
        const cm = Math.max(0, c - 1), cp = Math.min(e.w - 1, c + 1);
        const rm = Math.max(0, r - 1), rp = Math.min(e.h - 1, r + 1);
        const avg = (src[r * e.w + cm] + src[r * e.w + cp] + src[rm * e.w + c] + src[rp * e.w + c]) / 4;
        v += (avg - v) * 0.3 * (0.5 + 0.5 * strength) * fall;
      }
      e.cells[i] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  e.dirty = true;
  return { c0, r0, c1, r1 };
}

/** Sample the raster at world (wx,wz) — bilinear, clamp-to-edge — in meters. */
export function sampleY(e, wx, wz) {
  const u = Math.max(0, Math.min(e.w - 1, ((wx - e.rect.x0) / e.rect.w) * (e.w - 1)));
  const v = Math.max(0, Math.min(e.h - 1, ((wz - e.rect.z0) / e.rect.h) * (e.h - 1)));
  const c0 = Math.floor(u), r0 = Math.floor(v);
  const c1 = Math.min(e.w - 1, c0 + 1), r1 = Math.min(e.h - 1, r0 + 1);
  const fu = u - c0, fv = v - r0;
  const a = e.cells[r0 * e.w + c0], b = e.cells[r0 * e.w + c1], c = e.cells[r1 * e.w + c0], d = e.cells[r1 * e.w + c1];
  return valToY((a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv, e);
}

// ---- hillshade render -----------------------------------------------------------------------------
const RAMP_LAND = [
  [0.0, [116, 154, 92]],   // low plain — grass green
  [0.35, [158, 146, 92]],  // uplands — tan
  [0.65, [136, 130, 122]], // rock grey
  [1.0, [236, 236, 232]],  // high — near white
];
function landColor(t) {
  for (let i = 1; i < RAMP_LAND.length; i++) {
    if (t <= RAMP_LAND[i][0]) {
      const [t0, c0] = RAMP_LAND[i - 1], [t1, c1] = RAMP_LAND[i];
      const f = (t - t0) / (t1 - t0);
      return [0, 1, 2].map((k) => c0[k] + (c1[k] - c0[k]) * f);
    }
  }
  return RAMP_LAND[RAMP_LAND.length - 1][1];
}

let canvas = null;
/** Render the raster to a hillshaded data URL (elevation ramp x NW-light hillshade; sea depths in
 *  blues below `seaLevel`). One 256² canvas pass — cheap enough to run per animation frame during
 *  a stroke. */
export function renderHillshade(e, seaLevel = SEA_DEFAULT) {
  if (!canvas) canvas = document.createElement("canvas");
  canvas.width = e.w; canvas.height = e.h;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(e.w, e.h);
  const d = img.data;
  const yAt = (c, r) => valToY(e.cells[Math.max(0, Math.min(e.h - 1, r)) * e.w + Math.max(0, Math.min(e.w - 1, c))], e);
  const cellM = e.rect.w / (e.w - 1);
  // light from the NW (screen up-left = north-west since row 0 is north)
  const lx = -0.5547, lz = -0.5547, ly = 0.6202;
  for (let r = 0; r < e.h; r++) {
    for (let c = 0; c < e.w; c++) {
      const y = yAt(c, r);
      let rgb;
      if (y <= seaLevel) {
        const depth = Math.min(1, (seaLevel - y) / 12);
        rgb = [127 - 60 * depth, 176 - 78 * depth, 212 - 74 * depth];
      } else {
        rgb = landColor(Math.min(1, (y - seaLevel) / (e.maxY - seaLevel)));
      }
      // central-difference normal -> lambert shade
      const gx = (yAt(c + 1, r) - yAt(c - 1, r)) / (2 * cellM);
      const gz = (yAt(c, r + 1) - yAt(c, r - 1)) / (2 * cellM);
      const inv = 1 / Math.hypot(gx, gz, 1);
      const shade = 0.62 + 0.38 * Math.max(0, (-gx * inv) * lx + (-gz * inv) * lz + inv * ly);
      const i = (r * e.w + c) * 4;
      d[i] = rgb[0] * shade; d[i + 1] = rgb[1] * shade; d[i + 2] = rgb[2] * shade; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}
