/** Canonical portable little-endian codec for a WB-B2 blended biome field. */

import {
  BIOME_FIELD_LIMITS,
  BIOME_FIELD_NONE,
  BIOME_FIELD_SCHEMA,
  BIOME_FIELD_VERSION,
  BIOME_FIELD_WEIGHT_TOTAL,
} from "../biome-field.mjs";
import { sha256 } from "../sha256.mjs";

export const BIOME_FIELD_ARTIFACT_SCHEMA = "limina.biome-field-artifact/v1";
export const BIOME_FIELD_ARTIFACT_VERSION = 1;
export const BIOME_FIELD_ARTIFACT_TYPE = "biome-field/v1";
export const BIOME_FIELD_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.biome-field-v1";
export const BIOME_FIELD_ARTIFACT_HEADER_BYTES = 112;
export const BIOME_FIELD_ARTIFACT_MAX_BYTES = BIOME_FIELD_LIMITS.outputBytes + 64 * 1024;

const MAGIC = Object.freeze([0x4c, 0x4d, 0x42, 0x49, 0x4f, 0x4d, 0x45, 0x00]); // LMBIOME\0
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const FIELD_KEYS = new Set(["schema", "version", "pack", "grid", "topN", "biomeIds", "indices", "weights", "diagnostics"]);
const PACK_KEYS = new Set(["id", "version"]);
const GRID_KEYS = new Set(["origin", "rows", "cols", "cellSizeM"]);
const DIAGNOSTIC_KEYS = new Set(["cells", "workUnits", "outputBytes", "influences", "modifiers"]);
const CONTROL_KEYS = new Set(["shouldCancel"]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class BiomeFieldArtifactValidationError extends Error {
  constructor(message) { super(message); this.name = "BiomeFieldArtifactValidationError"; this.code = "biome_field_artifact_invalid"; }
}
export class BiomeFieldArtifactCancelledError extends Error {
  constructor() { super("biome field artifact operation cancelled"); this.name = "BiomeFieldArtifactCancelledError"; this.code = "biome_field_artifact_cancelled"; }
}
function fail(message) { throw new BiomeFieldArtifactValidationError(message); }

function exactRecord(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!keys.has(key)) fail(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor) || descriptor.enumerable !== true) fail(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${label} is missing '${key}'`);
  return descriptors;
}
function parseControl(value) {
  if (value === undefined) return null;
  const d = exactRecord(value, CONTROL_KEYS, "biome field artifact control");
  if (typeof d.shouldCancel.value !== "function") fail("biome field artifact control.shouldCancel must be a function");
  return d.shouldCancel.value;
}
function createMeter(shouldCancel, limit) {
  let work = 0;
  const check = () => { if (shouldCancel?.()) throw new BiomeFieldArtifactCancelledError(); };
  return Object.freeze({
    start: check,
    work() { if (++work > limit) fail(`biome field artifact exceeded bounded validation work ${limit}`); if ((work & 1023) === 0) check(); },
    finish: check,
  });
}
function canonicalNumber(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < minimum || value > maximum) fail(`${label} must be a canonical number in [${minimum}, ${maximum}]`);
  return value;
}
function integer(value, minimum, maximum, label) {
  const result = canonicalNumber(value, minimum, maximum, label);
  if (!Number.isSafeInteger(result)) fail(`${label} must be an integer`);
  return result;
}
function string(value, pattern, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}
function denseStrings(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 2 || value.length > 64
      || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    fail(`${label} must be a dense standard array with 2-64 entries`);
  }
  const result = value.map((entry, index) => string(entry, ID, 64, `${label}[${index}]`));
  for (let index = 1; index < result.length; index++) if (result[index - 1] >= result[index]) fail(`${label} must be strictly sorted and unique`);
  return Object.freeze(result);
}
function originTuple(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 2
      || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== 3) fail("biome field grid.origin must be a dense tuple");
  return Object.freeze([
    canonicalNumber(value[0], -10_000_000, 10_000_000, "biome field grid.origin[0]"),
    canonicalNumber(value[1], -10_000_000, 10_000_000, "biome field grid.origin[1]"),
  ]);
}
function isShared(buffer) { return Object.prototype.toString.call(buffer) === "[object SharedArrayBuffer]"; }
function ownedUint16(value, length, label) {
  if (!ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== Uint16Array.prototype
      || !(value.buffer instanceof ArrayBuffer) || isShared(value.buffer)
      || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength || value.length !== length) {
    fail(`${label} must own a complete non-shared Uint16Array of length ${length}`);
  }
  return value;
}

function parseField(input, meter) {
  const d = exactRecord(input, FIELD_KEYS, "biome field");
  if (d.schema.value !== BIOME_FIELD_SCHEMA || d.version.value !== BIOME_FIELD_VERSION) fail("biome field schema/version is unsupported");
  const packInput = exactRecord(d.pack.value, PACK_KEYS, "biome field pack");
  const pack = Object.freeze({
    id: string(packInput.id.value, ID, 64, "biome field pack.id"),
    version: string(packInput.version.value, SEMVER, 64, "biome field pack.version"),
  });
  const gridInput = exactRecord(d.grid.value, GRID_KEYS, "biome field grid");
  const rows = integer(gridInput.rows.value, 1, BIOME_FIELD_LIMITS.rows, "biome field grid.rows");
  const cols = integer(gridInput.cols.value, 1, BIOME_FIELD_LIMITS.cols, "biome field grid.cols");
  const cells = rows * cols;
  if (!Number.isSafeInteger(cells) || cells > BIOME_FIELD_LIMITS.cells) fail("biome field cell count exceeds the supported limit");
  const grid = Object.freeze({
    origin: originTuple(gridInput.origin.value), rows, cols,
    cellSizeM: canonicalNumber(gridInput.cellSizeM.value, 0.01, 1_000_000, "biome field grid.cellSizeM"),
  });
  const biomeIds = denseStrings(d.biomeIds.value, "biome field biomeIds");
  const topN = integer(d.topN.value, 2, Math.min(BIOME_FIELD_LIMITS.topN, biomeIds.length), "biome field topN");
  const length = cells * topN;
  const indices = ownedUint16(d.indices.value, length, "biome field indices");
  const weights = ownedUint16(d.weights.value, length, "biome field weights");
  const diagnosticInput = exactRecord(d.diagnostics.value, DIAGNOSTIC_KEYS, "biome field diagnostics");
  const outputBytes = cells * topN * 4;
  const diagnostics = Object.freeze({
    cells: integer(diagnosticInput.cells.value, cells, cells, "biome field diagnostics.cells"),
    workUnits: integer(diagnosticInput.workUnits.value, 0, BIOME_FIELD_LIMITS.workUnits, "biome field diagnostics.workUnits"),
    outputBytes: integer(diagnosticInput.outputBytes.value, outputBytes, outputBytes, "biome field diagnostics.outputBytes"),
    influences: integer(diagnosticInput.influences.value, 0, BIOME_FIELD_LIMITS.influences, "biome field diagnostics.influences"),
    modifiers: integer(diagnosticInput.modifiers.value, 0, BIOME_FIELD_LIMITS.modifiers, "biome field diagnostics.modifiers"),
  });
  for (let cell = 0; cell < cells; cell++) {
    let sum = 0;
    let priorWeight = Infinity;
    let empty = false;
    const seen = new Set();
    for (let rank = 0; rank < topN; rank++) {
      meter.work();
      const offset = cell * topN + rank;
      const index = indices[offset], weight = weights[offset];
      if (index === BIOME_FIELD_NONE) {
        if (weight !== 0) fail(`biome field cell ${cell} empty rank has nonzero weight`);
        empty = true;
        continue;
      }
      if (empty || index >= biomeIds.length || weight === 0 || weight > priorWeight || seen.has(index)) fail(`biome field cell ${cell} rank ${rank} is non-canonical`);
      seen.add(index);
      priorWeight = weight;
      sum += weight;
    }
    if (sum !== BIOME_FIELD_WEIGHT_TOTAL) fail(`biome field cell ${cell} weights do not normalize exactly`);
  }
  return Object.freeze({ schema: BIOME_FIELD_SCHEMA, version: BIOME_FIELD_VERSION, pack, grid, topN, biomeIds, indices, weights, diagnostics });
}

function align4(value) { return (value + 3) & ~3; }
function strings(field) {
  const packId = encoder.encode(field.pack.id);
  const packVersion = encoder.encode(field.pack.version);
  const biomeIds = field.biomeIds.map((value) => encoder.encode(value));
  let byteLength = packId.length + packVersion.length;
  for (const value of biomeIds) byteLength += 2 + value.length;
  if (packId.length > 0xffff || packVersion.length > 0xffff || biomeIds.some((value) => value.length > 0xffff)) fail("biome field artifact string exceeds u16 encoding");
  return Object.freeze({ packId, packVersion, biomeIds, byteLength });
}
function layout(field, stringTableBytes) {
  const stringTable = BIOME_FIELD_ARTIFACT_HEADER_BYTES;
  const indices = align4(stringTable + stringTableBytes);
  const weights = indices + field.indices.byteLength;
  const byteLength = weights + field.weights.byteLength;
  if (byteLength > BIOME_FIELD_ARTIFACT_MAX_BYTES) fail(`biome field artifact exceeds ${BIOME_FIELD_ARTIFACT_MAX_BYTES} bytes`);
  return Object.freeze({ stringTable, indices, weights, byteLength });
}
function writeHeader(view, field, table, offsets) {
  for (let index = 0; index < MAGIC.length; index++) view.setUint8(index, MAGIC[index]);
  view.setUint16(8, BIOME_FIELD_ARTIFACT_VERSION, true);
  view.setUint16(10, BIOME_FIELD_ARTIFACT_HEADER_BYTES, true);
  view.setUint32(12, offsets.byteLength, true);
  view.setUint32(16, field.grid.rows, true);
  view.setUint32(20, field.grid.cols, true);
  view.setUint32(24, field.diagnostics.cells, true);
  view.setUint16(28, field.topN, true);
  view.setUint16(30, field.biomeIds.length, true);
  view.setFloat64(32, field.grid.origin[0], true);
  view.setFloat64(40, field.grid.origin[1], true);
  view.setFloat64(48, field.grid.cellSizeM, true);
  view.setUint16(56, table.packId.length, true);
  view.setUint16(58, table.packVersion.length, true);
  view.setUint32(60, table.byteLength, true);
  view.setUint32(64, offsets.indices, true);
  view.setUint32(68, offsets.weights, true);
  view.setUint32(72, field.diagnostics.workUnits, true);
  view.setUint32(76, field.diagnostics.outputBytes, true);
  view.setUint16(80, field.diagnostics.influences, true);
  view.setUint16(82, field.diagnostics.modifiers, true);
  // 84..111 remain canonical zero from Uint8Array allocation.
}
function writeU16(view, offset, values, meter) {
  for (let index = 0; index < values.length; index++) { meter.work(); view.setUint16(offset + index * 2, values[index], true); }
}

export function encodeBiomeFieldArtifact(input, controlInput) {
  const meter = createMeter(parseControl(controlInput), BIOME_FIELD_LIMITS.cells * BIOME_FIELD_LIMITS.topN * 4 + 8192);
  meter.start();
  const field = parseField(input, meter);
  const table = strings(field);
  const offsets = layout(field, table.byteLength);
  const bytes = new Uint8Array(offsets.byteLength);
  const view = new DataView(bytes.buffer);
  writeHeader(view, field, table, offsets);
  let cursor = offsets.stringTable;
  bytes.set(table.packId, cursor); cursor += table.packId.length;
  bytes.set(table.packVersion, cursor); cursor += table.packVersion.length;
  for (const value of table.biomeIds) {
    view.setUint16(cursor, value.length, true); cursor += 2;
    bytes.set(value, cursor); cursor += value.length;
  }
  if (cursor !== offsets.stringTable + table.byteLength) throw new Error("biome field artifact internal string layout mismatch");
  writeU16(view, offsets.indices, field.indices, meter);
  writeU16(view, offsets.weights, field.weights, meter);
  meter.finish();
  return bytes;
}

function artifactBytes(input) {
  if (!ArrayBuffer.isView(input) || Object.getPrototypeOf(input) !== Uint8Array.prototype
      || !(input.buffer instanceof ArrayBuffer) || isShared(input.buffer)
      || input.byteOffset !== 0 || input.byteLength !== input.buffer.byteLength) fail("biome field artifact bytes must be an owned Uint8Array over a non-shared ArrayBuffer");
  if (input.byteLength < BIOME_FIELD_ARTIFACT_HEADER_BYTES || input.byteLength > BIOME_FIELD_ARTIFACT_MAX_BYTES) fail("biome field artifact byte length is outside the supported range");
  return input;
}
function decodeString(bytes, start, length, label) {
  try {
    const value = decoder.decode(bytes.subarray(start, start + length));
    if (encoder.encode(value).length !== length) fail(`${label} is not canonical UTF-8`);
    return value;
  } catch (error) {
    if (error instanceof BiomeFieldArtifactValidationError) throw error;
    fail(`${label} is invalid UTF-8`);
  }
}

export function decodeBiomeFieldArtifact(input, controlInput) {
  const bytes = artifactBytes(input);
  const meter = createMeter(parseControl(controlInput), BIOME_FIELD_LIMITS.cells * BIOME_FIELD_LIMITS.topN * 4 + 8192);
  meter.start();
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC.length; index++) if (view.getUint8(index) !== MAGIC[index]) fail("biome field artifact magic mismatch");
  if (view.getUint16(8, true) !== BIOME_FIELD_ARTIFACT_VERSION) fail("biome field artifact version is unsupported");
  if (view.getUint16(10, true) !== BIOME_FIELD_ARTIFACT_HEADER_BYTES) fail("biome field artifact header length mismatch");
  if (view.getUint32(12, true) !== bytes.byteLength) fail("biome field artifact byte length is non-canonical");
  for (let offset = 84; offset < BIOME_FIELD_ARTIFACT_HEADER_BYTES; offset++) if (bytes[offset] !== 0) fail("biome field artifact reserved header bytes must be zero");
  const rows = view.getUint32(16, true), cols = view.getUint32(20, true), cells = rows * cols;
  if (!Number.isSafeInteger(cells) || cells !== view.getUint32(24, true) || cells < 1 || cells > BIOME_FIELD_LIMITS.cells) fail("biome field artifact cell count is invalid");
  const topN = view.getUint16(28, true), biomeCount = view.getUint16(30, true);
  if (biomeCount < 2 || biomeCount > 64 || topN < 2 || topN > Math.min(BIOME_FIELD_LIMITS.topN, biomeCount)) fail("biome field artifact rank/biome count is invalid");
  const packIdLength = view.getUint16(56, true), packVersionLength = view.getUint16(58, true), stringTableBytes = view.getUint32(60, true);
  let cursor = BIOME_FIELD_ARTIFACT_HEADER_BYTES;
  if (cursor + stringTableBytes > bytes.byteLength || stringTableBytes < packIdLength + packVersionLength + biomeCount * 3) fail("biome field artifact string table is invalid");
  const packId = decodeString(bytes, cursor, packIdLength, "biome field pack id"); cursor += packIdLength;
  const packVersion = decodeString(bytes, cursor, packVersionLength, "biome field pack version"); cursor += packVersionLength;
  const biomeIds = [];
  for (let index = 0; index < biomeCount; index++) {
    if (cursor + 2 > BIOME_FIELD_ARTIFACT_HEADER_BYTES + stringTableBytes) fail("biome field artifact biome string descriptor is truncated");
    const length = view.getUint16(cursor, true); cursor += 2;
    if (length < 1 || cursor + length > BIOME_FIELD_ARTIFACT_HEADER_BYTES + stringTableBytes) fail("biome field artifact biome string is truncated");
    biomeIds.push(decodeString(bytes, cursor, length, `biome field id ${index}`)); cursor += length;
  }
  if (cursor !== BIOME_FIELD_ARTIFACT_HEADER_BYTES + stringTableBytes) fail("biome field artifact string table has trailing bytes");
  const shell = {
    indices: { byteLength: cells * topN * 2 },
    weights: { byteLength: cells * topN * 2 },
  };
  const expectedIndices = align4(BIOME_FIELD_ARTIFACT_HEADER_BYTES + stringTableBytes);
  const expectedWeights = expectedIndices + shell.indices.byteLength;
  const expectedLength = expectedWeights + shell.weights.byteLength;
  if (view.getUint32(64, true) !== expectedIndices || view.getUint32(68, true) !== expectedWeights || bytes.byteLength !== expectedLength) fail("biome field artifact channel layout is non-canonical");
  for (let offset = BIOME_FIELD_ARTIFACT_HEADER_BYTES + stringTableBytes; offset < expectedIndices; offset++) if (bytes[offset] !== 0) fail("biome field artifact alignment padding must be zero");
  const indices = new Uint16Array(cells * topN);
  const weights = new Uint16Array(cells * topN);
  for (let index = 0; index < indices.length; index++) { meter.work(); indices[index] = view.getUint16(expectedIndices + index * 2, true); }
  for (let index = 0; index < weights.length; index++) { meter.work(); weights[index] = view.getUint16(expectedWeights + index * 2, true); }
  const field = {
    schema: BIOME_FIELD_SCHEMA,
    version: BIOME_FIELD_VERSION,
    pack: { id: packId, version: packVersion },
    grid: { origin: [view.getFloat64(32, true), view.getFloat64(40, true)], rows, cols, cellSizeM: view.getFloat64(48, true) },
    topN,
    biomeIds,
    indices,
    weights,
    diagnostics: {
      cells,
      workUnits: view.getUint32(72, true),
      outputBytes: view.getUint32(76, true),
      influences: view.getUint16(80, true),
      modifiers: view.getUint16(82, true),
    },
  };
  const parsed = parseField(field, meter);
  meter.finish();
  return Object.freeze({
    field: parsed,
    metadata: Object.freeze({
      schema: BIOME_FIELD_ARTIFACT_SCHEMA,
      artifactType: BIOME_FIELD_ARTIFACT_TYPE,
      mediaType: BIOME_FIELD_ARTIFACT_MEDIA_TYPE,
      version: BIOME_FIELD_ARTIFACT_VERSION,
      byteLength: bytes.byteLength,
      contentHash: `sha256:${sha256(bytes)}`,
      storage: "owned-transferable-channel-copies",
    }),
  });
}

export function biomeFieldArtifactContentHash(input) {
  return `sha256:${sha256(artifactBytes(input))}`;
}
