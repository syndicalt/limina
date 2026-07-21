// Atlas map-doc model (Editor 2.0): decode a vault map doc into live editable
// rasters and sync them back for save. The raster codec is INJECTED (the surface
// imports /shared/raster-codec.mjs in the browser; tests use a relative path) so
// this module stays pure and node-testable.
//
// Wire contracts (owned by map-doc.mjs / the compiler — do not invent new shapes):
//   rasters.landmass: { w, h, rect, ...codec.encodeRasterCells(cells) } — absent when
//     fully carved away (a fully-undone first stroke restores pure-vector compile).
//   rasters.elevation: { w, h, rect, minY, maxY, encoding: "u16le", data: b64 } —
//     legacy u8 heights dequantize ×257 (257/65535 == 1/255 exactly).
//   rasters.biomes: { w, h, rect, ...codec.encodeRasterCells(cells) } — cell = class
//     index + 1, 0 = unpainted; class order is the compiler's fixed enum.

export const BIOME_CLASSES = ["grass", "forest", "mountain", "desert", "tundra", "swamp", "water", "blight"];
export const ELEV_ENCODING = "u16";

function liveU8(raster, codec) {
  return {
    w: raster.w,
    h: raster.h,
    rect: { ...raster.rect },
    cells: codec.decodeRasterCells(raster, raster.w * raster.h),
    dirty: false,
    rev: 0,
  };
}

function decodeElevation(stored, codec) {
  const bytes = codec.b64ToU8(stored.data);
  const count = stored.w * stored.h;
  let cells;
  if (stored.encoding === ELEV_ENCODING) {
    if (bytes.length !== count * 2) throw new Error(`elevation: u16le payload is ${bytes.length} bytes, expected ${count * 2}`);
    cells = new Uint16Array(count);
    for (let i = 0; i < count; i++) cells[i] = bytes[2 * i] | (bytes[2 * i + 1] << 8);
  } else {
    // Legacy u8 heights: byte-for-byte identical dequant via the 1/255 identity.
    if (bytes.length !== count) throw new Error(`elevation: legacy payload is ${bytes.length} bytes, expected ${count}`);
    cells = new Uint16Array(count);
    for (let i = 0; i < count; i++) cells[i] = bytes[i] * 257;
  }
  return { w: stored.w, h: stored.h, rect: { ...stored.rect }, minY: stored.minY, maxY: stored.maxY, cells, dirty: false, rev: 0 };
}

function encodeElevation(e, codec) {
  if (!(e.cells instanceof Uint16Array) || e.cells.length !== e.w * e.h) {
    throw new RangeError("elevation: live u16 cell count does not match w*h");
  }
  const bytes = new Uint8Array(e.cells.length * 2);
  for (let i = 0; i < e.cells.length; i++) {
    bytes[2 * i] = e.cells[i] & 0xff;
    bytes[2 * i + 1] = e.cells[i] >>> 8;
  }
  return { w: e.w, h: e.h, rect: { ...e.rect }, minY: e.minY, maxY: e.maxY, encoding: ELEV_ENCODING, data: codec.u8ToB64(bytes) };
}

/** The rect a NEW raster spans: content bbox, padded, with a hard minimum so
 *  island-scale painting never silently no-ops outside the region. */
export function creationRect(map, { pad = 1.5, minSpan = 800 } = {}) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const feed = (x, z) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };
  for (const f of map.features || []) {
    if (f.type === "glyph") feed(f.x, f.z);
    else for (const p of f.points || []) feed(p[0], p[1]);
  }
  for (const m of map.markers || []) feed(m.x, m.z);
  if (minX === Infinity) { minX = maxX = minZ = maxZ = 0; }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const span = Math.max(minSpan, Math.ceil(Math.max(maxX - minX, maxZ - minZ) * pad));
  return { x0: Math.round(cx - span / 2), z0: Math.round(cz - span / 2), w: span, h: span };
}

export function decodeMap(map, codec) {
  if (map === null || typeof map !== "object") throw new TypeError("atlas doc: map must be an object");
  const rasters = {};
  if (map.rasters?.landmass) rasters.landmass = liveU8(map.rasters.landmass, codec);
  if (map.rasters?.elevation) rasters.elevation = decodeElevation(map.rasters.elevation, codec);
  if (map.rasters?.biomes) rasters.biomes = liveU8(map.rasters.biomes, codec);
  return {
    id: map.id,
    name: map.name,
    doc: map,
    rasters,
    features: map.features ?? [],
    stamps: map.stamps ?? [],
    waterBodies: map.waterBodies ?? [],
    hydrology: map.hydrology,
    markers: map.markers ?? [],
    seaLevel: map.seaLevel ?? map.sea ?? 0,
  };
}

/** Ensure a live landmass raster exists (first stroke on an unpainted map):
 *  512² over the creation rect, all ocean. */
export function ensureLandmass(model, { size = 512 } = {}) {
  if (model.rasters.landmass) return model.rasters.landmass;
  const rect = creationRect(model.doc, { pad: 1.5, minSpan: 800 });
  model.rasters.landmass = {
    w: size, h: size, rect, cells: new Uint8Array(size * size), dirty: true, rev: 0,
  };
  return model.rasters.landmass;
}

/** Ensure a live elevation raster exists: 256² over the creation rect (min 120m),
 *  seeded flat at y=0 so enabling elevation never visibly changes terrain. */
export function ensureElevation(model, { size = 256 } = {}) {
  if (model.rasters.elevation) return model.rasters.elevation;
  const rect = creationRect(model.doc, { pad: 1.15, minSpan: 120 });
  model.rasters.elevation = {
    w: size, h: size, rect,
    minY: -500, maxY: 9000,
    cells: new Uint16Array(size * size),
    dirty: true, rev: 0,
  };
  // y=0 in u16 over [-500,9000]: (0-(-500))/(9500) * 65535.
  const zero = Math.round((500 / 9500) * 65535);
  model.rasters.elevation.cells.fill(zero);
  return model.rasters.elevation;
}

/** Ensure a live biome raster exists: 256² over the landmass rect (shared frame),
 *  all unpainted (0). */
export function ensureBiomes(model, { size = 256 } = {}) {
  if (model.rasters.biomes) return model.rasters.biomes;
  const rect = model.rasters.landmass ? { ...model.rasters.landmass.rect } : creationRect(model.doc, { pad: 1.5, minSpan: 800 });
  model.rasters.biomes = {
    w: size, h: size, rect, cells: new Uint8Array(size * size), dirty: true, rev: 0,
  };
  return model.rasters.biomes;
}

/** Write dirty rasters back into the doc for a save payload. Returns the doc. */
export function syncRastersIntoDoc(model, codec) {
  const map = model.doc;
  const lm = model.rasters.landmass;
  if (lm?.dirty) {
    const any = lm.cells.some((v) => v >= 128);
    map.rasters = map.rasters || {};
    if (any) {
      map.rasters.landmass = {
        w: lm.w, h: lm.h,
        rect: { x0: lm.rect.x0, z0: lm.rect.z0, w: lm.rect.w, h: lm.rect.h },
        ...codec.encodeRasterCells(lm.cells),
      };
    } else {
      delete map.rasters.landmass;
      if (Object.keys(map.rasters).length === 0) delete map.rasters;
    }
    lm.dirty = false;
  }
  const el = model.rasters.elevation;
  if (el?.dirty) {
    map.rasters = map.rasters || {};
    map.rasters.elevation = encodeElevation(el, codec);
    el.dirty = false;
  }
  const bi = model.rasters.biomes;
  if (bi?.dirty) {
    const any = bi.cells.some((v) => v !== 0);
    map.rasters = map.rasters || {};
    if (any) {
      map.rasters.biomes = { w: bi.w, h: bi.h, rect: { ...bi.rect }, ...codec.encodeRasterCells(bi.cells) };
    } else {
      delete map.rasters.biomes;
    }
    bi.dirty = false;
  }
  return map;
}
