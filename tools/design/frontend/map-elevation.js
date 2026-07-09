// map-elevation.js — Map Studio S1: painted elevation. Owns the per-map decoded raster cache
// (the MapDoc stores base64; painting works on a live Uint16Array), the raise/lower/smooth/level
// brush math, and the hillshade render (offscreen canvas -> data-URL <image> in the map SVG).
// Interaction wiring (tool state, pointer events, undo commit) lives in map.js; the stroke's
// undo step is map-commands.js's cmdPatchRaster over the bounding box the stroke touched.
//
// GRID CONVENTION (must match worldmap.ts's ReliefGridSchema): u16 cells, explicit little-endian
// persistence, value/65535 -> [minY,maxY] meters, row-major, +col = +x (east), +row = +z — row 0
// is the NORTHERNMOST row (north = -z, drawn screen-up). Legacy u8 documents have no `encoding`
// field; they expand exactly via value*257 on read and remain byte-identical until first edited.

export const ELEV_SIZE = 256;          // 256² per map (locked decision: ~2m/cell on a 500m map)
export const ELEV_MIN_Y = -500;        // configured Atlas authoring floor (deep ocean / trenches)
export const ELEV_MAX_Y = 9000;        // configured Atlas authoring ceiling (Everest-class peaks)
export const ELEV_ENCODING = "u16";
export const ELEV_QUANT_MAX = 65535;
const MAX_ELEV_DIM = 1024;
const SEA_DEFAULT = 0;
const BRUSH_MODES = new Set(["raise", "lower", "smooth", "level"]);

function elevationRange(g) {
  const minY = g ? g.minY : ELEV_MIN_Y, maxY = g ? g.maxY : ELEV_MAX_Y;
  if (!Number.isFinite(minY) || !Number.isFinite(maxY) || !(maxY > minY)) throw new RangeError("elevation: minY/maxY must be finite with maxY > minY");
  return { minY, maxY };
}

/** Deterministic nearest-level quantization. Out-of-range heights are rejected rather than
 * silently flattened to an endpoint; brush saturation is explicit at its mutation site. */
export function yToVal(y, g) {
  const { minY, maxY } = elevationRange(g);
  if (!Number.isFinite(y)) throw new TypeError("elevation: height must be finite");
  if (y < minY || y > maxY) throw new RangeError(`elevation: height ${y}m is outside [${minY}, ${maxY}]m`);
  return Math.round(((y - minY) / (maxY - minY)) * ELEV_QUANT_MAX);
}
export function valToY(v, g) {
  const { minY, maxY } = elevationRange(g);
  if (!Number.isFinite(v) || v < 0 || v > ELEV_QUANT_MAX) throw new RangeError(`elevation: quantized value ${v} is outside u16`);
  return minY + (v / ELEV_QUANT_MAX) * (maxY - minY);
}

// ---- base64 <-> Uint8Array (browser-native atob/btoa over binary strings) ----------------------
function b64ToU8Exact(s, expectedBytes) {
  if (typeof s !== "string") throw new TypeError("elevation: data must be base64 text");
  const encodedLength = 4 * Math.ceil(expectedBytes / 3);
  if (s.length !== encodedLength) throw new RangeError(`elevation: base64 length ${s.length} != expected ${encodedLength}`);
  const pad = expectedBytes % 3 === 0 ? "" : expectedBytes % 3 === 1 ? "==" : "=";
  const body = pad ? s.slice(0, -pad.length) : s;
  if (!/^[A-Za-z0-9+/]*$/.test(body) || (pad && !s.endsWith(pad))) throw new Error("elevation: malformed base64 payload");
  // Reject alternate non-canonical encodings with non-zero unused padding bits.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (expectedBytes % 3 === 1 && (alphabet.indexOf(body.at(-1)) & 15) !== 0) throw new Error("elevation: non-canonical base64 padding bits");
  if (expectedBytes % 3 === 2 && (alphabet.indexOf(body.at(-1)) & 3) !== 0) throw new Error("elevation: non-canonical base64 padding bits");
  let bin;
  try { bin = atob(s); } catch { throw new Error("elevation: malformed base64 payload"); }
  if (bin.length !== expectedBytes) throw new RangeError(`elevation: decoded ${bin.length} bytes, expected ${expectedBytes}`);
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

function validateElevationMetadata(stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new TypeError("elevation: raster must be an object");
  const { w, h, rect, minY, maxY } = stored;
  if (!Number.isInteger(w) || w < 2 || w > MAX_ELEV_DIM || !Number.isInteger(h) || h < 2 || h > MAX_ELEV_DIM) {
    throw new RangeError(`elevation: dimensions must be integers in [2, ${MAX_ELEV_DIM}]`);
  }
  if (!rect || typeof rect !== "object" || !Number.isFinite(rect.x0) || !Number.isFinite(rect.z0)
      || !Number.isFinite(rect.w) || rect.w <= 0 || !Number.isFinite(rect.h) || rect.h <= 0) {
    throw new RangeError("elevation: rect must contain finite x0/z0 and positive finite w/h");
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY) || !(maxY > minY)) {
    throw new RangeError("elevation: minY/maxY must be finite with maxY > minY");
  }
  if (stored.encoding !== undefined && stored.encoding !== "u8" && stored.encoding !== ELEV_ENCODING) {
    throw new Error(`elevation: unsupported encoding "${stored.encoding}"`);
  }
}

/** Decode a serialized Atlas/WorldMap elevation grid into the live u16 representation. */
export function decodeElevationRaster(stored) {
  validateElevationMetadata(stored);
  const count = stored.w * stored.h;
  const isU16 = stored.encoding === ELEV_ENCODING;
  const bytes = b64ToU8Exact(stored.data, count * (isU16 ? 2 : 1));
  const cells = new Uint16Array(count);
  if (isU16) {
    for (let i = 0; i < count; i++) cells[i] = bytes[2 * i] | (bytes[2 * i + 1] << 8);
  } else {
    // 257/65535 == 1/255 exactly: every legacy u8 height dequantizes byte-for-byte identically.
    for (let i = 0; i < count; i++) cells[i] = bytes[i] * 257;
  }
  return { w: stored.w, h: stored.h, rect: { ...stored.rect }, minY: stored.minY, maxY: stored.maxY, cells };
}

/** Encode live cells explicitly as deterministic little-endian u16. */
export function encodeElevationRaster(e) {
  validateElevationMetadata({ ...e, encoding: ELEV_ENCODING, data: "pending" });
  if (!(e.cells instanceof Uint16Array) || e.cells.length !== e.w * e.h) throw new RangeError("elevation: live u16 cell count does not match w*h");
  const bytes = new Uint8Array(e.cells.length * 2);
  for (let i = 0; i < e.cells.length; i++) {
    bytes[2 * i] = e.cells[i] & 0xff;
    bytes[2 * i + 1] = e.cells[i] >>> 8;
  }
  return { w: e.w, h: e.h, rect: { ...e.rect }, minY: e.minY, maxY: e.maxY, encoding: ELEV_ENCODING, data: u8ToB64(bytes) };
}

// ---- per-map raster cache -----------------------------------------------------------------------
// mapId -> { w, h, rect, minY, maxY, cells: Uint16Array, dirty: boolean }
const cache = new Map();

/** The world rect a NEW raster should span: a square covering ALL the map's drawn content
 *  (features incl. the coast outline + markers) padded 1.15x, min 120m. NOT fixed — the region
 *  is user-adjustable afterward (drag the dashed outline to move, corner handles to resize, both
 *  undoable), so the default only needs to be sensible, not perfect. On a big map 256² gets
 *  coarse (~10m/cell at 2.6km) — shrink the region over the area that needs detail. */
function creationRect(map, markers) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const feed = (x, z) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; };
  for (const f of map.features || []) {
    if (f.type === "glyph") feed(f.x, f.z);
    else for (const p of f.points || []) feed(p[0], p[1]);
  }
  for (const m of markers || []) feed(m.x, m.z);
  if (minX === Infinity) { minX = maxX = minZ = maxZ = 0; }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const span = Math.max(120, Math.ceil(Math.max(maxX - minX, maxZ - minZ) * 1.15));
  return { x0: Math.round(cx - span / 2), z0: Math.round(cz - span / 2), w: span, h: span };
}

/** Get (or lazily create) the live decoded raster for a map. Creation seeds every cell at y=0
 *  (a flat plain at old sea level) so enabling elevation never visibly changes the terrain. */
export function ensureElevation(map, markers) {
  let e = cache.get(map.id);
  if (e) return e;
  const stored = map.rasters && map.rasters.elevation;
  if (stored) {
    e = { ...decodeElevationRaster(stored), dirty: false };
  } else {
    const cells = new Uint16Array(ELEV_SIZE * ELEV_SIZE).fill(yToVal(0));
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
    map.rasters.elevation = encodeElevationRaster(e);
    e.dirty = false;
  }
}

// ---- brush ---------------------------------------------------------------------------------------
/** Apply one brush dab at world (wx,wz). mode: raise|lower|smooth|level. radiusM in meters,
 *  strength 0..1. `levelY` is the target elevation for the level tool. Returns the touched cell
 *  bbox {x0,y0,x1,y1} or null. Smooth cos² falloff from the dab center. */
export function brushDab(e, wx, wz, { mode, radiusM, strength, levelY }) {
  if (!(e.cells instanceof Uint16Array) || e.cells.length !== e.w * e.h) throw new TypeError("elevation: brush requires a valid live u16 raster");
  if (!Number.isFinite(radiusM) || radiusM <= 0 || !Number.isFinite(strength) || strength < 0 || strength > 1) throw new RangeError("elevation: invalid brush radius/strength");
  if (!BRUSH_MODES.has(mode)) throw new Error(`elevation: unknown brush mode "${mode}"`);
  const levelValue = mode === "level" ? yToVal(levelY, e) : 0;
  const cellW = e.rect.w / (e.w - 1), cellH = e.rect.h / (e.h - 1);
  const cc = (wx - e.rect.x0) / cellW, cr = (wz - e.rect.z0) / cellH;
  const rc = radiusM / cellW, rr = radiusM / cellH;
  const c0 = Math.max(0, Math.floor(cc - rc)), c1 = Math.min(e.w - 1, Math.ceil(cc + rc));
  const r0 = Math.max(0, Math.floor(cr - rr)), r1 = Math.min(e.h - 1, Math.ceil(cr + rr));
  if (c1 < c0 || r1 < r0) return null;
  const stepPerDab = ((e.maxY - e.minY) / ELEV_QUANT_MAX);
  // raise/lower move up to ~1.2m per dab at strength 1; level pulls 35%/dab; smooth blends 30%/dab.
  // The UI permits 5% strength (0.06m/dab). Across 9.5km one u16 step is ~0.145m, so without
  // this explicit floor the weakest center dab rounds to zero and the brush appears broken.
  const amount = strength === 0 ? 0 : Math.max(1, (1.2 * strength) / stepPerDab);
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
      else if (mode === "level") v += (levelValue - v) * 0.35 * strength * fall;
      else if (mode === "smooth") {
        const cm = Math.max(0, c - 1), cp = Math.min(e.w - 1, c + 1);
        const rm = Math.max(0, r - 1), rp = Math.min(e.h - 1, r + 1);
        const avg = (src[r * e.w + cm] + src[r * e.w + cp] + src[rm * e.w + c] + src[rp * e.w + c]) / 4;
        v += (avg - v) * 0.3 * (0.5 + 0.5 * strength) * fall;
      }
      // Raise/lower saturation at the configured authoring boundary is deliberate brush
      // behavior, unlike persistence/import conversions which must never silently clamp.
      e.cells[i] = Math.max(0, Math.min(ELEV_QUANT_MAX, Math.round(v)));
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
  const valueScale = (e.maxY - e.minY) / ELEV_QUANT_MAX;
  const landSpan = Math.max(1e-9, e.maxY - seaLevel);
  const yAt = (c, r) => e.minY + e.cells[Math.max(0, Math.min(e.h - 1, r)) * e.w + Math.max(0, Math.min(e.w - 1, c))] * valueScale;
  const cellM = e.rect.w / (e.w - 1);
  // light from the NW (screen up-left = north-west since row 0 is north)
  const lx = -0.5547, lz = -0.5547, ly = 0.6202;
  for (let r = 0; r < e.h; r++) {
    for (let c = 0; c < e.w; c++) {
      const y = yAt(c, r);
      let rgb;
      if (y < seaLevel - 0.05) {
        const depth = Math.min(1, (seaLevel - y) / 12);
        rgb = [127 - 60 * depth, 176 - 78 * depth, 212 - 74 * depth];
      } else {
        rgb = landColor(Math.min(1, Math.max(0, y - seaLevel) / landSpan));
      }
      // central-difference normal -> lambert shade
      const gx = (yAt(c + 1, r) - yAt(c - 1, r)) / (2 * cellM);
      const gz = (yAt(c, r + 1) - yAt(c, r - 1)) / (2 * cellM);
      const inv = 1 / Math.hypot(gx, gz, 1);
      const shade = 0.62 + 0.38 * Math.max(0, (-gx * inv) * lx + (-gz * inv) * lz + inv * ly);
      // PER-PIXEL ALPHA: unpainted terrain (flat at 0m, above sea) renders INVISIBLE — the layer
      // shows relief only where the user actually sculpted (UAT: an opaque flat plain read as a
      // "static green square" pasted over the map). Alpha ramps in over ~2m of deviation from
      // the flat seed; submerged cells always read (painted depressions / raised sea level).
      const dev = Math.abs(y);
      let a = Math.min(1, dev / 2) * 0.85;
      if (y < seaLevel - 0.05) a = Math.max(a, Math.min(1, 0.35 + (seaLevel - y) / 8) * 0.85);
      const i = (r * e.w + c) * 4;
      d[i] = rgb[0] * shade; d[i + 1] = rgb[1] * shade; d[i + 2] = rgb[2] * shade; d[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}
