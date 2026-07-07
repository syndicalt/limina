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

export const LAND_SIZE = 512; // cells per side — ~5m cells on a 2.6km map (locked decision)
const LAND_FILL = "#dccfa6"; // matches the legacy traced-outline land fill
const COAST_STROKE = "#b89b6a";

const cache = new Map(); // mapId -> {w, h, rect, cells, dirty, rev}
const imgCache = new Map(); // mapId -> {rev, url}
const coastCache = new Map(); // mapId -> {rev, polys}

export function landmassOf(mapId) { return cache.get(mapId) || null; }
export function hasLandmass(map) { return !!(map.rasters && map.rasters.landmass) || cache.has(map.id); }
export function dropLandmassCache(mapId) { cache.delete(mapId); imgCache.delete(mapId); coastCache.delete(mapId); }
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
    const next = new Uint8Array(w * h);
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

/** The land layer as a data-URL image covering the mask rect (soft alpha shoreline). */
export function renderLandImage(e, mapId) {
  const hit = imgCache.get(mapId);
  if (hit && hit.rev === e.rev) return hit.url;
  const cv = document.createElement("canvas");
  cv.width = e.w; cv.height = e.h;
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(e.w, e.h);
  const R = parseInt(LAND_FILL.slice(1, 3), 16), G = parseInt(LAND_FILL.slice(3, 5), 16), B = parseInt(LAND_FILL.slice(5, 7), 16);
  const ocean = borderOcean(e);
  for (let i = 0; i < e.cells.length; i++) {
    const v = e.cells[i];
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
  imgCache.set(mapId, { rev: e.rev, url });
  return url;
}

/** The derived coastline polygons in world coords — cached per mask revision AND rect (a region
 *  move/resize changes world coords without touching cells). Recomputed at stroke end / undo /
 *  redo, never per dab (the <50ms budget lives in the gate). */
export function coastPolygons(e, mapId) {
  const rectKey = e.rect.x0 + "," + e.rect.z0 + "," + e.rect.w + "," + e.rect.h;
  const hit = coastCache.get(mapId);
  if (hit && hit.rev === e.rev && hit.rectKey === rectKey) return hit.polys;
  const polys = maskToLandPolygons(e, {});
  coastCache.set(mapId, { rev: e.rev, rectKey, polys });
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
