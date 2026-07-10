/**
 * Portable binary codec for one derived TerrainTile chunk.
 *
 * Layout (all multi-byte values are little-endian):
 *   0   u8[8] magic "LMTERRN\0"
 *   8   u16   format version
 *   10  u16   optional-channel flags
 *   12  u16   header byte length
 *   14  u16   climate channel count (0 or 3)
 *   16  u32   exact artifact byte length
 *   20  u16   rows
 *   22  u16   columns
 *   24  u32   rows * columns
 *   28  u32   reserved (zero)
 *   32  f64x3 world-space origin [x, y, z]
 *   56  f64x3 world-space scale [x, y, z]
 *   80  f32[] normalized heights (required)
 *            followed by present channels in paintMat, paintW, climate, blight order.
 *
 * paintMat is padded with canonical zero bytes to a four-byte boundary. Decoding
 * deliberately returns owned channel copies rather than views into caller-owned
 * artifact storage. This costs O(payload bytes), but makes artifact lifetime and
 * mutation ownership explicit across Node, browser, and native Limina hosts.
 */

export const TERRAIN_CHUNK_ARTIFACT_SCHEMA = "limina.terrain-chunk-artifact/v1";
export const TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.terrain-chunk-v1";
export const TERRAIN_CHUNK_ARTIFACT_VERSION = 1;
export const TERRAIN_CHUNK_ARTIFACT_HEADER_BYTES = 80;
export const MIN_TERRAIN_ARTIFACT_ROWS = 2;
export const MAX_TERRAIN_ARTIFACT_ROWS = 257;
export const MIN_TERRAIN_ARTIFACT_COLS = 2;
export const MAX_TERRAIN_ARTIFACT_COLS = 257;
export const MAX_TERRAIN_ARTIFACT_CELLS = MAX_TERRAIN_ARTIFACT_ROWS * MAX_TERRAIN_ARTIFACT_COLS;
export const TERRAIN_ARTIFACT_CLIMATE_CHANNELS = 3;
export const MAX_TERRAIN_CHUNK_ARTIFACT_BYTES = 2 * 1024 * 1024;
// The current roadmap's authoritative terrain domain is 8 km. These limits leave
// three orders of magnitude for paged worlds while preventing values that overflow
// or lose all useful precision when downstream render/physics code converts to f32.
export const MAX_TERRAIN_ARTIFACT_ORIGIN_ABS_M = 10_000_000;
export const MAX_TERRAIN_ARTIFACT_SCALE_M = 1_000_000;

export const TERRAIN_ARTIFACT_FLAG_PAINT_MAT = 1 << 0;
export const TERRAIN_ARTIFACT_FLAG_PAINT_WEIGHT = 1 << 1;
export const TERRAIN_ARTIFACT_FLAG_CLIMATE = 1 << 2;
export const TERRAIN_ARTIFACT_FLAG_BLIGHT = 1 << 3;

const KNOWN_FLAGS = TERRAIN_ARTIFACT_FLAG_PAINT_MAT
  | TERRAIN_ARTIFACT_FLAG_PAINT_WEIGHT
  | TERRAIN_ARTIFACT_FLAG_CLIMATE
  | TERRAIN_ARTIFACT_FLAG_BLIGHT;
const MAGIC = Object.freeze([0x4c, 0x4d, 0x54, 0x45, 0x52, 0x52, 0x4e, 0x00]);
const REQUIRED_FIELDS = Object.freeze(["nrows", "ncols", "origin", "scale", "heights"]);
const ALLOWED_FIELDS = new Set([...REQUIRED_FIELDS, "paintMat", "paintW", "climate", "climateChannels", "blight"]);
const BIOME_MIN = 0;
const BIOME_MAX = 6;
// Runtime terrain paint defines 0 none, 1 sand, 2 grass, 3 rock, 4 dirt,
// 5 snow, 6 murk, and 7 tundra. The portable codec must preserve the complete channel.
const PAINT_MATERIAL_MAX = 7;

function plainRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function validateDataFields(value, label) {
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error(`${label} must not contain symbol fields`);
  for (const name of Object.getOwnPropertyNames(value)) {
    if (!ALLOWED_FIELDS.has(name)) throw new Error(`${label} has unsupported field '${name}'`);
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined || descriptor?.enumerable !== true) {
      throw new Error(`${label}.${name} must be an enumerable data field`);
    }
  }
  for (const name of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) throw new Error(`${label}.${name} is required`);
  }
}

function bufferIsShared(buffer) {
  return Object.prototype.toString.call(buffer) === "[object SharedArrayBuffer]";
}

function typedArray(value, tag, label) {
  if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== `[object ${tag}]`) {
    throw new TypeError(`${label} must be ${tag}`);
  }
  if (bufferIsShared(value.buffer)) throw new TypeError(`${label} must not use SharedArrayBuffer storage`);
  return value;
}

function bytesInput(value) {
  return typedArray(value, "Uint8Array", "terrain artifact bytes");
}

function tuple3(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 3) {
    throw new TypeError(`${label} must be a three-number array`);
  }
  for (let index = 0; index < 3; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new Error(`${label} must not be sparse or accessor-backed`);
    }
  }
  return value;
}

function dimension(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function finiteCanonical(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  if (Object.is(value, -0)) throw new RangeError(`${label} must not be negative zero`);
  return value;
}

function normalized(value, label) {
  finiteCanonical(value, label);
  if (value < 0 || value > 1) throw new RangeError(`${label} must be in [0, 1]`);
  return value;
}

function positive(value, label) {
  finiteCanonical(value, label);
  if (!(value > 0)) throw new RangeError(`${label} must be > 0`);
  return value;
}

function boundedOrigin(value, label) {
  finiteCanonical(value, label);
  if (Math.abs(value) > MAX_TERRAIN_ARTIFACT_ORIGIN_ABS_M) {
    throw new RangeError(`${label} absolute value must be <= ${MAX_TERRAIN_ARTIFACT_ORIGIN_ABS_M} metres`);
  }
  return value;
}

function boundedScale(value, label) {
  positive(value, label);
  if (value > MAX_TERRAIN_ARTIFACT_SCALE_M) {
    throw new RangeError(`${label} must be <= ${MAX_TERRAIN_ARTIFACT_SCALE_M} metres`);
  }
  return value;
}

function optionalField(tile, name) {
  return Object.prototype.hasOwnProperty.call(tile, name) && tile[name] !== undefined ? tile[name] : undefined;
}

function align4(value) { return (value + 3) & ~3; }

function checkedByteLength(cells, flags, climateChannels) {
  let length = TERRAIN_CHUNK_ARTIFACT_HEADER_BYTES + cells * 4;
  if ((flags & TERRAIN_ARTIFACT_FLAG_PAINT_MAT) !== 0) length = align4(length + cells);
  if ((flags & TERRAIN_ARTIFACT_FLAG_PAINT_WEIGHT) !== 0) length += cells * 4;
  if ((flags & TERRAIN_ARTIFACT_FLAG_CLIMATE) !== 0) length += cells * climateChannels * 4;
  if ((flags & TERRAIN_ARTIFACT_FLAG_BLIGHT) !== 0) length += cells * 4;
  if (!Number.isSafeInteger(length) || length > MAX_TERRAIN_CHUNK_ARTIFACT_BYTES) {
    throw new RangeError(`terrain artifact exceeds ${MAX_TERRAIN_CHUNK_ARTIFACT_BYTES} bytes`);
  }
  return length;
}

function payloadLayout(cells, flags, climateChannels) {
  let offset = TERRAIN_CHUNK_ARTIFACT_HEADER_BYTES;
  const heights = offset;
  offset += cells * 4;
  let paintMat = null;
  let paintMatPadding = null;
  if ((flags & TERRAIN_ARTIFACT_FLAG_PAINT_MAT) !== 0) {
    paintMat = offset;
    offset += cells;
    paintMatPadding = Object.freeze({ offset, byteLength: align4(offset) - offset });
    offset = align4(offset);
  }
  let paintW = null;
  if ((flags & TERRAIN_ARTIFACT_FLAG_PAINT_WEIGHT) !== 0) {
    paintW = offset;
    offset += cells * 4;
  }
  let climate = null;
  if ((flags & TERRAIN_ARTIFACT_FLAG_CLIMATE) !== 0) {
    climate = offset;
    offset += cells * climateChannels * 4;
  }
  let blight = null;
  if ((flags & TERRAIN_ARTIFACT_FLAG_BLIGHT) !== 0) {
    blight = offset;
    offset += cells * 4;
  }
  return Object.freeze({ heights, paintMat, paintMatPadding, paintW, climate, blight, end: offset });
}

function validateFloatChannel(values, label, validator) {
  for (let index = 0; index < values.length; index++) validator(values[index], `${label}[${index}]`);
}

function validateClimate(values, cells) {
  if (values.length !== cells * TERRAIN_ARTIFACT_CLIMATE_CHANNELS) {
    throw new Error(`terrain tile climate length ${values.length} != ${cells * TERRAIN_ARTIFACT_CLIMATE_CHANNELS}`);
  }
  for (let cell = 0; cell < cells; cell++) {
    const base = cell * TERRAIN_ARTIFACT_CLIMATE_CHANNELS;
    finiteCanonical(values[base], `terrain tile climate[${base}]`);
    finiteCanonical(values[base + 1], `terrain tile climate[${base + 1}]`);
    const biome = finiteCanonical(values[base + 2], `terrain tile climate[${base + 2}]`);
    if (!Number.isInteger(biome) || biome < BIOME_MIN || biome > BIOME_MAX) {
      throw new RangeError(`terrain tile climate[${base + 2}] biome must be an integer in [${BIOME_MIN}, ${BIOME_MAX}]`);
    }
  }
}

function validateTile(input) {
  const tile = plainRecord(input, "terrain tile");
  validateDataFields(tile, "terrain tile");
  const nrows = dimension(tile.nrows, MIN_TERRAIN_ARTIFACT_ROWS, MAX_TERRAIN_ARTIFACT_ROWS, "terrain tile nrows");
  const ncols = dimension(tile.ncols, MIN_TERRAIN_ARTIFACT_COLS, MAX_TERRAIN_ARTIFACT_COLS, "terrain tile ncols");
  const cells = nrows * ncols;
  if (!Number.isSafeInteger(cells) || cells > MAX_TERRAIN_ARTIFACT_CELLS) throw new RangeError("terrain tile cell count is unsupported");

  const origin = tuple3(tile.origin, "terrain tile origin");
  const scale = tuple3(tile.scale, "terrain tile scale");
  for (let axis = 0; axis < 3; axis++) {
    boundedOrigin(origin[axis], `terrain tile origin[${axis}]`);
    boundedScale(scale[axis], `terrain tile scale[${axis}]`);
  }

  const heights = typedArray(tile.heights, "Float32Array", "terrain tile heights");
  if (heights.length !== cells) throw new Error(`terrain tile heights length ${heights.length} != ${cells}`);
  validateFloatChannel(heights, "terrain tile heights", normalized);

  const paintMat = optionalField(tile, "paintMat");
  if (paintMat !== undefined) {
    typedArray(paintMat, "Uint8Array", "terrain tile paintMat");
    if (paintMat.length !== cells) throw new Error(`terrain tile paintMat length ${paintMat.length} != ${cells}`);
    for (let index = 0; index < paintMat.length; index++) {
      if (paintMat[index] > PAINT_MATERIAL_MAX) {
        throw new RangeError(`terrain tile paintMat[${index}] must be in [0, ${PAINT_MATERIAL_MAX}]`);
      }
    }
  }

  const paintW = optionalField(tile, "paintW");
  if (paintW !== undefined) {
    typedArray(paintW, "Float32Array", "terrain tile paintW");
    if (paintW.length !== cells) throw new Error(`terrain tile paintW length ${paintW.length} != ${cells}`);
    validateFloatChannel(paintW, "terrain tile paintW", normalized);
  }

  const climate = optionalField(tile, "climate");
  const climateChannels = optionalField(tile, "climateChannels");
  if (climate === undefined && climateChannels !== undefined) throw new Error("terrain tile climateChannels requires climate data");
  if (climate !== undefined) {
    typedArray(climate, "Float32Array", "terrain tile climate");
    if (climateChannels !== TERRAIN_ARTIFACT_CLIMATE_CHANNELS) {
      throw new Error(`terrain tile climateChannels must equal ${TERRAIN_ARTIFACT_CLIMATE_CHANNELS}`);
    }
    validateClimate(climate, cells);
  }

  const blight = optionalField(tile, "blight");
  if (blight !== undefined) {
    typedArray(blight, "Float32Array", "terrain tile blight");
    if (blight.length !== cells) throw new Error(`terrain tile blight length ${blight.length} != ${cells}`);
    validateFloatChannel(blight, "terrain tile blight", normalized);
  }

  const flags = (paintMat === undefined ? 0 : TERRAIN_ARTIFACT_FLAG_PAINT_MAT)
    | (paintW === undefined ? 0 : TERRAIN_ARTIFACT_FLAG_PAINT_WEIGHT)
    | (climate === undefined ? 0 : TERRAIN_ARTIFACT_FLAG_CLIMATE)
    | (blight === undefined ? 0 : TERRAIN_ARTIFACT_FLAG_BLIGHT);
  return { tile, nrows, ncols, cells, origin, scale, heights, paintMat, paintW, climate, climateChannels: climate === undefined ? 0 : climateChannels, blight, flags };
}

function writeFloat32Channel(view, offset, values) {
  for (let index = 0; index < values.length; index++) view.setFloat32(offset + index * 4, values[index], true);
}

function readFloat32Channel(view, offset, count) {
  const values = new Float32Array(count);
  for (let index = 0; index < count; index++) values[index] = view.getFloat32(offset + index * 4, true);
  return values;
}

export function encodeTerrainChunkArtifact(tileInput) {
  const value = validateTile(tileInput);
  const byteLength = checkedByteLength(value.cells, value.flags, value.climateChannels);
  const layout = payloadLayout(value.cells, value.flags, value.climateChannels);
  if (layout.end !== byteLength) throw new Error("internal terrain artifact layout mismatch");
  const bytes = new Uint8Array(byteLength);
  bytes.set(MAGIC, 0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint16(8, TERRAIN_CHUNK_ARTIFACT_VERSION, true);
  view.setUint16(10, value.flags, true);
  view.setUint16(12, TERRAIN_CHUNK_ARTIFACT_HEADER_BYTES, true);
  view.setUint16(14, value.climateChannels, true);
  view.setUint32(16, byteLength, true);
  view.setUint16(20, value.nrows, true);
  view.setUint16(22, value.ncols, true);
  view.setUint32(24, value.cells, true);
  view.setUint32(28, 0, true);
  for (let axis = 0; axis < 3; axis++) {
    view.setFloat64(32 + axis * 8, value.origin[axis], true);
    view.setFloat64(56 + axis * 8, value.scale[axis], true);
  }
  writeFloat32Channel(view, layout.heights, value.heights);
  if (layout.paintMat !== null) bytes.set(value.paintMat, layout.paintMat);
  if (layout.paintW !== null) writeFloat32Channel(view, layout.paintW, value.paintW);
  if (layout.climate !== null) writeFloat32Channel(view, layout.climate, value.climate);
  if (layout.blight !== null) writeFloat32Channel(view, layout.blight, value.blight);
  return bytes;
}

function verifyMagic(bytes) {
  for (let index = 0; index < MAGIC.length; index++) {
    if (bytes[index] !== MAGIC[index]) throw new Error("terrain artifact magic mismatch");
  }
}

function channelFlags(flags) {
  return Object.freeze({
    paintMat: (flags & TERRAIN_ARTIFACT_FLAG_PAINT_MAT) !== 0,
    paintW: (flags & TERRAIN_ARTIFACT_FLAG_PAINT_WEIGHT) !== 0,
    climate: (flags & TERRAIN_ARTIFACT_FLAG_CLIMATE) !== 0,
    blight: (flags & TERRAIN_ARTIFACT_FLAG_BLIGHT) !== 0,
  });
}

export function decodeTerrainChunkArtifact(bytesInputValue) {
  const bytes = bytesInput(bytesInputValue);
  if (bytes.byteLength < TERRAIN_CHUNK_ARTIFACT_HEADER_BYTES) throw new Error("terrain artifact is truncated before its fixed header");
  if (bytes.byteLength > MAX_TERRAIN_CHUNK_ARTIFACT_BYTES) throw new RangeError(`terrain artifact exceeds ${MAX_TERRAIN_CHUNK_ARTIFACT_BYTES} bytes`);
  verifyMagic(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(8, true);
  if (version !== TERRAIN_CHUNK_ARTIFACT_VERSION) throw new Error(`unsupported terrain artifact version ${version}`);
  const flags = view.getUint16(10, true);
  if ((flags & ~KNOWN_FLAGS) !== 0) throw new Error("terrain artifact contains unknown flags");
  if (view.getUint16(12, true) !== TERRAIN_CHUNK_ARTIFACT_HEADER_BYTES) throw new Error("terrain artifact header length mismatch");
  const climateChannels = view.getUint16(14, true);
  const hasClimate = (flags & TERRAIN_ARTIFACT_FLAG_CLIMATE) !== 0;
  if (climateChannels !== (hasClimate ? TERRAIN_ARTIFACT_CLIMATE_CHANNELS : 0)) {
    throw new Error("terrain artifact climate flag/channel-count mismatch");
  }
  const declaredLength = view.getUint32(16, true);
  if (declaredLength !== bytes.byteLength) {
    throw new Error(`terrain artifact byte length mismatch: header ${declaredLength}, actual ${bytes.byteLength}`);
  }
  const nrows = dimension(view.getUint16(20, true), MIN_TERRAIN_ARTIFACT_ROWS, MAX_TERRAIN_ARTIFACT_ROWS, "terrain artifact nrows");
  const ncols = dimension(view.getUint16(22, true), MIN_TERRAIN_ARTIFACT_COLS, MAX_TERRAIN_ARTIFACT_COLS, "terrain artifact ncols");
  const cells = nrows * ncols;
  if (view.getUint32(24, true) !== cells) throw new Error("terrain artifact cell count does not match dimensions");
  if (view.getUint32(28, true) !== 0) throw new Error("terrain artifact reserved header bytes must be zero");
  const expectedLength = checkedByteLength(cells, flags, climateChannels);
  if (declaredLength !== expectedLength) throw new Error(`terrain artifact canonical byte length must be ${expectedLength}`);
  const layout = payloadLayout(cells, flags, climateChannels);
  if (layout.paintMatPadding !== null) {
    for (let offset = layout.paintMatPadding.offset; offset < layout.paintMatPadding.offset + layout.paintMatPadding.byteLength; offset++) {
      if (bytes[offset] !== 0) throw new Error("terrain artifact paintMat alignment padding must be zero");
    }
  }

  const origin = new Array(3);
  const scale = new Array(3);
  for (let axis = 0; axis < 3; axis++) {
    origin[axis] = boundedOrigin(view.getFloat64(32 + axis * 8, true), `terrain artifact origin[${axis}]`);
    scale[axis] = boundedScale(view.getFloat64(56 + axis * 8, true), `terrain artifact scale[${axis}]`);
  }

  const heights = readFloat32Channel(view, layout.heights, cells);
  validateFloatChannel(heights, "terrain artifact heights", normalized);
  let paintMat;
  if (layout.paintMat !== null) {
    paintMat = new Uint8Array(cells);
    paintMat.set(bytes.subarray(layout.paintMat, layout.paintMat + cells));
    for (let index = 0; index < paintMat.length; index++) {
      if (paintMat[index] > PAINT_MATERIAL_MAX) throw new RangeError(`terrain artifact paintMat[${index}] must be in [0, ${PAINT_MATERIAL_MAX}]`);
    }
  }
  let paintW;
  if (layout.paintW !== null) {
    paintW = readFloat32Channel(view, layout.paintW, cells);
    validateFloatChannel(paintW, "terrain artifact paintW", normalized);
  }
  let climate;
  if (layout.climate !== null) {
    climate = readFloat32Channel(view, layout.climate, cells * climateChannels);
    validateClimate(climate, cells);
  }
  let blight;
  if (layout.blight !== null) {
    blight = readFloat32Channel(view, layout.blight, cells);
    validateFloatChannel(blight, "terrain artifact blight", normalized);
  }

  const tile = { nrows, ncols, origin: Object.freeze(origin), scale: Object.freeze(scale), heights };
  if (paintMat !== undefined) tile.paintMat = paintMat;
  if (paintW !== undefined) tile.paintW = paintW;
  if (climate !== undefined) {
    tile.climate = climate;
    tile.climateChannels = climateChannels;
  }
  if (blight !== undefined) tile.blight = blight;
  Object.freeze(tile);

  const metadata = Object.freeze({
    schema: TERRAIN_CHUNK_ARTIFACT_SCHEMA,
    mediaType: TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE,
    version,
    byteLength: declaredLength,
    headerBytes: TERRAIN_CHUNK_ARTIFACT_HEADER_BYTES,
    nrows,
    ncols,
    cells,
    climateChannels,
    channels: channelFlags(flags),
    offsets: layout,
    storage: "owned-channel-copies",
  });
  return Object.freeze({ metadata, tile });
}
