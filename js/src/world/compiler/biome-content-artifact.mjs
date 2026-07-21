/**
 * Canonical global archive for the exact assets closed by one derived biome publication.
 *
 * The archive is deliberately AssetBundle-compatible at its boundary: decoded entries are
 * `{ id, path, hash, bytes }`, with `path === "assets/" + id` and hashes computed by the same
 * portable raw-asset mapping used by AssetRegistry. All multibyte integers are little-endian.
 *
 * Header (192 bytes):
 *   0   u8[8]  magic "LMBIOME\0"
 *   8   u16    version
 *   10  u16    header bytes
 *   12  u32    exact artifact bytes
 *   16  u32    entry count
 *   20  u32    entry-table offset (192)
 *   24  u32    entry-table bytes
 *   28  u32    data offset (8-byte aligned)
 *   32  u32    total entry bytes
 *   36  u8[12] reserved zero
 *   48  u8[32] biome-content-bundle closure hash
 *   80  u8[32] runtime-pack content hash
 *   112 u8[32] biome-field content hash
 *   144 u8[32] archive integrity digest (zeroed while hashing)
 *   176 u8[16] reserved zero
 *
 * Entry table (strictly id-sorted): u16 id bytes, u16 path bytes, u32 content bytes,
 * u32 data offset relative to the data section, u32 reserved zero, u8[32] asset hash,
 * then canonical UTF-8 id and path bytes.
 */

import { portableAssetContentHash } from "../asset-content-hash.mjs";
import { sha256 } from "../sha256.mjs";
import { MAX_DERIVED_ARTIFACT_BYTES } from "./manifest.mjs";

export const BIOME_CONTENT_ARTIFACT_SCHEMA = "limina.biome-content-artifact/v1";
export const BIOME_CONTENT_ARTIFACT_TYPE = "biome-content-archive/v1";
export const BIOME_CONTENT_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.biome-content-archive-v1";
export const BIOME_CONTENT_ARTIFACT_VERSION = 1;
export const BIOME_CONTENT_ARTIFACT_HEADER_BYTES = 192;
export const MAX_BIOME_CONTENT_ARTIFACT_ENTRIES = 4_096;
export const MAX_BIOME_CONTENT_ARTIFACT_BYTES = MAX_DERIVED_ARTIFACT_BYTES;

const MAGIC = Object.freeze([0x4c, 0x4d, 0x42, 0x49, 0x4f, 0x4d, 0x45, 0x00]); // LMBIOME\0
const HASH = /^sha256:[0-9a-f]{64}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const ROOT_KEYS = new Set(["schema", "identity", "entries"]);
const IDENTITY_KEYS = new Set(["bundleClosureHash", "runtimePackContentHash", "fieldContentHash"]);
const ENTRY_KEYS = new Set(["id", "path", "hash", "bytes"]);
const CONTROL_KEYS = new Set(["shouldCancel"]);
const MAX_ID_BYTES = 256;
const MAX_PATH_BYTES = 263;
const FIXED_ENTRY_BYTES = 48;
const INTEGRITY_OFFSET = 144;
const INTEGRITY_END = 176;
const COPY_CHUNK_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class BiomeContentArtifactValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "BiomeContentArtifactValidationError";
    this.code = "biome_content_artifact_invalid";
  }
}

export class BiomeContentArtifactCancelledError extends Error {
  constructor() {
    super("biome content artifact operation cancelled");
    this.name = "BiomeContentArtifactCancelledError";
    this.code = "biome_content_artifact_cancelled";
  }
}

function fail(message) { throw new BiomeContentArtifactValidationError(message); }
function align8(value) { return (value + 7) & ~7; }
function isShared(buffer) { return Object.prototype.toString.call(buffer) === "[object SharedArrayBuffer]"; }

function exactRecord(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!keys.has(key)) fail(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor) || descriptor.enumerable !== true) fail(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${label} is missing '${key}'`);
  return descriptors;
}

function denseArray(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
      || Object.getOwnPropertySymbols(value).length !== 0
      || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    fail(`${label} must be a dense standard array with at most ${maximum} entries`);
  }
  return value;
}

function parseControl(value) {
  if (value === undefined) return null;
  const d = exactRecord(value, CONTROL_KEYS, "biome content artifact control");
  if (typeof d.shouldCancel.value !== "function") fail("biome content artifact control.shouldCancel must be a function");
  return d.shouldCancel.value;
}

function cancellation(shouldCancel) {
  const check = () => { if (shouldCancel?.() === true) throw new BiomeContentArtifactCancelledError(); };
  return Object.freeze({
    start: check,
    entry: check,
    bytes(index) { if ((index & (COPY_CHUNK_BYTES - 1)) === 0) check(); },
    finish: check,
  });
}

function contentHash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) fail(`${label} must be a canonical content hash`);
  return value;
}

function hashHex(value) { return value.slice("sha256:".length); }
function writeHex(bytes, offset, hex) {
  for (let index = 0; index < 32; index++) bytes[offset + index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
}
function readHex(bytes, offset) {
  let result = "";
  for (let index = 0; index < 32; index++) result += bytes[offset + index].toString(16).padStart(2, "0");
  return result;
}

function safeId(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_ID_BYTES || value.startsWith("/") || value.includes("\\")) {
    fail(`${label} is invalid`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || !SAFE_SEGMENT.test(segment))) {
    fail(`${label} contains an unsafe path segment`);
  }
  const bytes = encoder.encode(value);
  if (bytes.length > MAX_ID_BYTES) fail(`${label} UTF-8 encoding is too long`);
  return Object.freeze({ value, bytes });
}

function canonicalPath(value, id, label) {
  const expected = `assets/${id.value}`;
  if (value !== expected) fail(`${label} must be '${expected}'`);
  const bytes = encoder.encode(value);
  if (bytes.length > MAX_PATH_BYTES) fail(`${label} UTF-8 encoding is too long`);
  return Object.freeze({ value, bytes });
}

function ownedBytes(value, label, allowArtifact = false) {
  if (!ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype
      || !(value.buffer instanceof ArrayBuffer) || isShared(value.buffer)
      || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    fail(`${label} must be an owned Uint8Array over a non-shared ArrayBuffer`);
  }
  const minimum = allowArtifact ? BIOME_CONTENT_ARTIFACT_HEADER_BYTES : 1;
  if (value.byteLength < minimum || value.byteLength > MAX_BIOME_CONTENT_ARTIFACT_BYTES) {
    fail(`${label} byte length is outside the supported range`);
  }
  return value;
}

function parseArchive(input, meter) {
  const root = exactRecord(input, ROOT_KEYS, "biome content artifact archive");
  if (root.schema.value !== BIOME_CONTENT_ARTIFACT_SCHEMA) fail("biome content artifact archive schema is unsupported");
  const identityInput = exactRecord(root.identity.value, IDENTITY_KEYS, "biome content artifact identity");
  const identity = Object.freeze({
    bundleClosureHash: contentHash(identityInput.bundleClosureHash.value, "biome content artifact identity.bundleClosureHash"),
    runtimePackContentHash: contentHash(identityInput.runtimePackContentHash.value, "biome content artifact identity.runtimePackContentHash"),
    fieldContentHash: contentHash(identityInput.fieldContentHash.value, "biome content artifact identity.fieldContentHash"),
  });
  const source = denseArray(root.entries.value, MAX_BIOME_CONTENT_ARTIFACT_ENTRIES, "biome content artifact entries");
  if (source.length < 1) fail("biome content artifact entries must not be empty");
  const entries = new Array(source.length);
  let priorId = null;
  let totalEntryBytes = 0;
  let tableBytes = 0;
  for (let index = 0; index < source.length; index++) {
    meter.entry();
    const d = exactRecord(source[index], ENTRY_KEYS, `biome content artifact entries[${index}]`);
    const id = safeId(d.id.value, `biome content artifact entries[${index}].id`);
    if (priorId !== null && priorId >= id.value) fail("biome content artifact entries must be strictly id-sorted and unique");
    priorId = id.value;
    const path = canonicalPath(d.path.value, id, `biome content artifact entries[${index}].path`);
    const bytes = ownedBytes(d.bytes.value, `biome content artifact entries[${index}].bytes`);
    const hash = contentHash(d.hash.value, `biome content artifact entries[${index}].hash`);
    if (portableAssetContentHash(bytes) !== hash) fail(`biome content artifact entry '${id.value}' asset content hash mismatch`);
    totalEntryBytes += bytes.byteLength;
    tableBytes += FIXED_ENTRY_BYTES + id.bytes.length + path.bytes.length;
    if (!Number.isSafeInteger(totalEntryBytes) || totalEntryBytes > MAX_BIOME_CONTENT_ARTIFACT_BYTES) {
      fail("biome content artifact entry bytes exceed the derived artifact bound");
    }
    entries[index] = Object.freeze({ id: id.value, path: path.value, hash, bytes, idBytes: id.bytes, pathBytes: path.bytes });
  }
  const dataOffset = align8(BIOME_CONTENT_ARTIFACT_HEADER_BYTES + tableBytes);
  const artifactBytes = dataOffset + totalEntryBytes;
  if (!Number.isSafeInteger(artifactBytes) || artifactBytes > MAX_BIOME_CONTENT_ARTIFACT_BYTES) {
    fail(`biome content artifact exceeds ${MAX_BIOME_CONTENT_ARTIFACT_BYTES} bytes`);
  }
  return Object.freeze({ schema: BIOME_CONTENT_ARTIFACT_SCHEMA, identity, entries, tableBytes, dataOffset, totalEntryBytes, artifactBytes });
}

function copyChunked(target, targetOffset, source, meter) {
  for (let offset = 0; offset < source.length; offset += COPY_CHUNK_BYTES) {
    meter.bytes(offset);
    target.set(source.subarray(offset, Math.min(source.length, offset + COPY_CHUNK_BYTES)), targetOffset + offset);
  }
}

function integrityMaterial(bytes) {
  const material = new Uint8Array(bytes);
  material.fill(0, INTEGRITY_OFFSET, INTEGRITY_END);
  return material;
}

function decodeString(bytes, start, length, label) {
  try {
    const value = decoder.decode(bytes.subarray(start, start + length));
    if (encoder.encode(value).length !== length) fail(`${label} is not canonical UTF-8`);
    return value;
  } catch (error) {
    if (error instanceof BiomeContentArtifactValidationError) throw error;
    fail(`${label} is invalid UTF-8`);
  }
}

export function encodeBiomeContentArtifact(input, controlInput) {
  const meter = cancellation(parseControl(controlInput));
  meter.start();
  const archive = parseArchive(input, meter);
  const bytes = new Uint8Array(archive.artifactBytes);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC.length; index++) bytes[index] = MAGIC[index];
  view.setUint16(8, BIOME_CONTENT_ARTIFACT_VERSION, true);
  view.setUint16(10, BIOME_CONTENT_ARTIFACT_HEADER_BYTES, true);
  view.setUint32(12, archive.artifactBytes, true);
  view.setUint32(16, archive.entries.length, true);
  view.setUint32(20, BIOME_CONTENT_ARTIFACT_HEADER_BYTES, true);
  view.setUint32(24, archive.tableBytes, true);
  view.setUint32(28, archive.dataOffset, true);
  view.setUint32(32, archive.totalEntryBytes, true);
  writeHex(bytes, 48, hashHex(archive.identity.bundleClosureHash));
  writeHex(bytes, 80, hashHex(archive.identity.runtimePackContentHash));
  writeHex(bytes, 112, hashHex(archive.identity.fieldContentHash));
  let tableCursor = BIOME_CONTENT_ARTIFACT_HEADER_BYTES;
  let dataCursor = 0;
  for (const entry of archive.entries) {
    meter.entry();
    view.setUint16(tableCursor, entry.idBytes.length, true);
    view.setUint16(tableCursor + 2, entry.pathBytes.length, true);
    view.setUint32(tableCursor + 4, entry.bytes.byteLength, true);
    view.setUint32(tableCursor + 8, dataCursor, true);
    writeHex(bytes, tableCursor + 16, hashHex(entry.hash));
    tableCursor += FIXED_ENTRY_BYTES;
    bytes.set(entry.idBytes, tableCursor); tableCursor += entry.idBytes.length;
    bytes.set(entry.pathBytes, tableCursor); tableCursor += entry.pathBytes.length;
    copyChunked(bytes, archive.dataOffset + dataCursor, entry.bytes, meter);
    dataCursor += entry.bytes.byteLength;
  }
  if (tableCursor !== BIOME_CONTENT_ARTIFACT_HEADER_BYTES + archive.tableBytes || dataCursor !== archive.totalEntryBytes) {
    throw new Error("biome content artifact internal layout mismatch");
  }
  writeHex(bytes, INTEGRITY_OFFSET, sha256(integrityMaterial(bytes)));
  meter.finish();
  return bytes;
}

export function decodeBiomeContentArtifact(input, controlInput) {
  const bytes = ownedBytes(input, "biome content artifact bytes", true);
  const meter = cancellation(parseControl(controlInput));
  meter.start();
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC.length; index++) if (bytes[index] !== MAGIC[index]) fail("biome content artifact magic mismatch");
  if (view.getUint16(8, true) !== BIOME_CONTENT_ARTIFACT_VERSION) fail("biome content artifact version is unsupported");
  if (view.getUint16(10, true) !== BIOME_CONTENT_ARTIFACT_HEADER_BYTES) fail("biome content artifact header length mismatch");
  if (view.getUint32(12, true) !== bytes.length) fail("biome content artifact byte length is non-canonical");
  for (let offset = 36; offset < 48; offset++) if (bytes[offset] !== 0) fail("biome content artifact reserved header bytes must be zero");
  for (let offset = 176; offset < BIOME_CONTENT_ARTIFACT_HEADER_BYTES; offset++) if (bytes[offset] !== 0) fail("biome content artifact reserved header bytes must be zero");
  const expectedIntegrity = readHex(bytes, INTEGRITY_OFFSET);
  const actualIntegrity = sha256(integrityMaterial(bytes));
  if (expectedIntegrity !== actualIntegrity) fail("biome content artifact integrity hash mismatch");
  const entryCount = view.getUint32(16, true);
  if (entryCount < 1 || entryCount > MAX_BIOME_CONTENT_ARTIFACT_ENTRIES) fail("biome content artifact entry count is out of bounds");
  const tableOffset = view.getUint32(20, true), tableBytes = view.getUint32(24, true);
  const dataOffset = view.getUint32(28, true), totalEntryBytes = view.getUint32(32, true);
  const expectedDataOffset = align8(BIOME_CONTENT_ARTIFACT_HEADER_BYTES + tableBytes);
  if (tableOffset !== BIOME_CONTENT_ARTIFACT_HEADER_BYTES || dataOffset !== expectedDataOffset
      || dataOffset + totalEntryBytes !== bytes.length) {
    fail("biome content artifact table layout is non-canonical");
  }
  for (let offset = BIOME_CONTENT_ARTIFACT_HEADER_BYTES + tableBytes; offset < dataOffset; offset++) {
    if (bytes[offset] !== 0) fail("biome content artifact alignment padding must be zero");
  }
  const identity = Object.freeze({
    bundleClosureHash: contentHash(`sha256:${readHex(bytes, 48)}`, "biome content artifact identity.bundleClosureHash"),
    runtimePackContentHash: contentHash(`sha256:${readHex(bytes, 80)}`, "biome content artifact identity.runtimePackContentHash"),
    fieldContentHash: contentHash(`sha256:${readHex(bytes, 112)}`, "biome content artifact identity.fieldContentHash"),
  });
  const entries = new Array(entryCount);
  let tableCursor = tableOffset;
  let expectedEntryOffset = 0;
  let priorId = null;
  for (let index = 0; index < entryCount; index++) {
    meter.entry();
    if (tableCursor + FIXED_ENTRY_BYTES > tableOffset + tableBytes) fail(`biome content artifact entry ${index} is truncated`);
    const idLength = view.getUint16(tableCursor, true), pathLength = view.getUint16(tableCursor + 2, true);
    const byteLength = view.getUint32(tableCursor + 4, true), entryOffset = view.getUint32(tableCursor + 8, true);
    if (view.getUint32(tableCursor + 12, true) !== 0) fail(`biome content artifact entry ${index} reserved bytes must be zero`);
    if (idLength < 1 || idLength > MAX_ID_BYTES || pathLength < 1 || pathLength > MAX_PATH_BYTES
        || byteLength < 1 || entryOffset !== expectedEntryOffset
        || tableCursor + FIXED_ENTRY_BYTES + idLength + pathLength > tableOffset + tableBytes
        || entryOffset + byteLength > totalEntryBytes) {
      fail(`biome content artifact entry ${index} layout is invalid`);
    }
    const hash = contentHash(`sha256:${readHex(bytes, tableCursor + 16)}`, `biome content artifact entry ${index} hash`);
    tableCursor += FIXED_ENTRY_BYTES;
    const idValue = decodeString(bytes, tableCursor, idLength, `biome content artifact entry ${index} id`);
    tableCursor += idLength;
    const pathValue = decodeString(bytes, tableCursor, pathLength, `biome content artifact entry ${index} path`);
    tableCursor += pathLength;
    const id = safeId(idValue, `biome content artifact entry ${index} id`);
    const path = canonicalPath(pathValue, id, `biome content artifact entry ${index} path`);
    if (priorId !== null && priorId >= id.value) fail("biome content artifact entries are not strictly id-sorted and unique");
    priorId = id.value;
    const owned = new Uint8Array(byteLength);
    copyChunked(owned, 0, bytes.subarray(dataOffset + entryOffset, dataOffset + entryOffset + byteLength), meter);
    if (portableAssetContentHash(owned) !== hash) fail(`biome content artifact entry '${id.value}' asset content hash mismatch`);
    entries[index] = Object.freeze({ id: id.value, path: path.value, hash, bytes: owned });
    expectedEntryOffset += byteLength;
  }
  if (tableCursor !== tableOffset + tableBytes) fail("biome content artifact entry table has trailing bytes");
  if (expectedEntryOffset !== totalEntryBytes) fail("biome content artifact data section is incomplete");
  meter.finish();
  const archive = Object.freeze({ schema: BIOME_CONTENT_ARTIFACT_SCHEMA, identity, entries: Object.freeze(entries) });
  return Object.freeze({
    archive,
    metadata: Object.freeze({
      schema: BIOME_CONTENT_ARTIFACT_SCHEMA,
      artifactType: BIOME_CONTENT_ARTIFACT_TYPE,
      mediaType: BIOME_CONTENT_ARTIFACT_MEDIA_TYPE,
      version: BIOME_CONTENT_ARTIFACT_VERSION,
      byteLength: bytes.length,
      entryBytes: totalEntryBytes,
      contentHash: `sha256:${sha256(bytes)}`,
      storage: "owned-asset-bundle-copies",
    }),
  });
}

export function biomeContentArtifactContentHash(input) {
  return `sha256:${sha256(ownedBytes(input, "biome content artifact bytes", true))}`;
}
