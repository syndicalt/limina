/**
 * Canonical portable codec for one chunk's subset of a BiomePopulationPlan.
 *
 * All multi-byte numbers are little-endian. Descriptor strings are interned in
 * a strictly sorted table and placements reference that table by index. The
 * envelope includes a SHA-256 integrity digest over every byte except the
 * digest field itself, so corruption is rejected even when it happens to
 * remain structurally valid. Decode creates fresh objects/arrays and never
 * retains a view into caller-owned artifact storage.
 *
 * Header (160 bytes):
 *   0   u8[8]  magic "LMPOPUL\0"
 *   8   u16    format version
 *   10  u16    header bytes
 *   12  u32    exact artifact bytes
 *   16  i32x2  chunk tx, tz
 *   24  u16    chunk lod
 *   26  u16    reserved zero
 *   28  u32    placement count
 *   32  u32    descriptor count
 *   36  u32    descriptor-table offset (160)
 *   40  u32    descriptor-table byte length
 *   44  u32    placement-table offset (8-byte aligned)
 *   48  u8[32] biome-field identity digest
 *   80  u8[32] runtime-pack identity digest
 *   112 u8[32] envelope integrity digest (this field zeroed while hashing)
 *   144 u8[16] reserved zero
 *
 * Descriptor entry: u16 role bytes, u16 asset-id bytes, u8[32] content hash,
 * then canonical UTF-8 role and asset-id bytes. Placement entry (56 bytes):
 * u32 descriptor index, i32 pageX, i32 pageZ, u32 reserved zero, then f64
 * x/y/z/yaw/scale.
 */

import { BIOME_POPULATION_ASSET_LIMITS } from "../biome-population-asset.mjs";
import { sha256 } from "../sha256.mjs";

export const BIOME_POPULATION_ARTIFACT_SCHEMA = "limina.biome-population-artifact/v1";
export const BIOME_POPULATION_ARTIFACT_TYPE = "biome-population-plan/v1";
export const BIOME_POPULATION_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.biome-population-plan-v1";
export const BIOME_POPULATION_ARTIFACT_VERSION = 1;
export const BIOME_POPULATION_ARTIFACT_HEADER_BYTES = 160;
export const BIOME_POPULATION_ARTIFACT_PLACEMENT_BYTES = 56;
// Ratcheted to BIOME_POPULATION_LIMITS.placements without importing the planner,
// whose candidate generator intentionally depends on terrain TypeScript code.
export const MAX_BIOME_POPULATION_ARTIFACT_PLACEMENTS = 24_576;
export const MAX_BIOME_POPULATION_ARTIFACT_BYTES = 12 * 1024 * 1024;

const MAGIC = Object.freeze([0x4c, 0x4d, 0x50, 0x4f, 0x50, 0x55, 0x4c, 0x00]); // LMPOPUL\0
const HASH = /^sha256:[0-9a-f]{64}$/;
const REF = /^[a-z][a-z0-9._/-]*$/;
const ROOT_KEYS = new Set(["schema", "coord", "identity", "placements"]);
const COORD_KEYS = new Set(["tx", "tz", "lod"]);
const IDENTITY_KEYS = new Set(["fieldContentHash", "runtimePackContentHash"]);
const PLACEMENT_KEYS = new Set(["role", "assetId", "contentHash", "x", "y", "z", "yaw", "scale", "pageX", "pageZ"]);
const CONTROL_KEYS = new Set(["shouldCancel"]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_COORD = 1_000_000;
const MAX_WORLD_METRES = 10_000_000;
const MAX_SCALE = 100;

export class BiomePopulationArtifactValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "BiomePopulationArtifactValidationError";
    this.code = "biome_population_artifact_invalid";
  }
}

export class BiomePopulationArtifactCancelledError extends Error {
  constructor() {
    super("biome population artifact operation cancelled");
    this.name = "BiomePopulationArtifactCancelledError";
    this.code = "biome_population_artifact_cancelled";
  }
}

function fail(message) { throw new BiomePopulationArtifactValidationError(message); }
function isShared(buffer) { return Object.prototype.toString.call(buffer) === "[object SharedArrayBuffer]"; }
function align8(value) { return (value + 7) & ~7; }

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
      || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    fail(`${label} must be a dense standard array with at most ${maximum} entries`);
  }
  return value;
}

function parseControl(value) {
  if (value === undefined) return null;
  const d = exactRecord(value, CONTROL_KEYS, "biome population artifact control");
  if (typeof d.shouldCancel.value !== "function") fail("biome population artifact control.shouldCancel must be a function");
  return d.shouldCancel.value;
}

function createMeter(shouldCancel) {
  let work = 0;
  const check = () => { if (shouldCancel?.() === true) throw new BiomePopulationArtifactCancelledError(); };
  return Object.freeze({
    start: check,
    work() {
      work++;
      if (work > MAX_BIOME_POPULATION_ARTIFACT_PLACEMENTS * 8 + 65_536) fail("biome population artifact validation work exceeded its bound");
      if ((work & 1023) === 0) check();
    },
    finish: check,
  });
}

function canonicalNumber(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < minimum || value > maximum) {
    fail(`${label} must be a canonical number in [${minimum}, ${maximum}]`);
  }
  return value;
}

function integer(value, minimum, maximum, label) {
  const result = canonicalNumber(value, minimum, maximum, label);
  if (!Number.isSafeInteger(result)) fail(`${label} must be an integer`);
  return result;
}

function reference(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > BIOME_POPULATION_ASSET_LIMITS.refChars || !REF.test(value)) {
    fail(`${label} is invalid`);
  }
  const bytes = encoder.encode(value);
  if (bytes.length > BIOME_POPULATION_ASSET_LIMITS.refChars) fail(`${label} UTF-8 encoding is too long`);
  return Object.freeze({ value, bytes });
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

function descriptorKey(role, assetId, hash) { return `${role}\u0000${assetId}\u0000${hash}`; }
function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }

function parsePlan(input, meter) {
  const root = exactRecord(input, ROOT_KEYS, "biome population artifact plan");
  if (root.schema.value !== BIOME_POPULATION_ARTIFACT_SCHEMA) fail("biome population artifact plan schema is unsupported");
  const coordInput = exactRecord(root.coord.value, COORD_KEYS, "biome population artifact coord");
  const coord = Object.freeze({
    tx: integer(coordInput.tx.value, -MAX_COORD, MAX_COORD, "biome population artifact coord.tx"),
    tz: integer(coordInput.tz.value, -MAX_COORD, MAX_COORD, "biome population artifact coord.tz"),
    lod: integer(coordInput.lod.value, 0, 16, "biome population artifact coord.lod"),
  });
  const identityInput = exactRecord(root.identity.value, IDENTITY_KEYS, "biome population artifact identity");
  const identity = Object.freeze({
    fieldContentHash: contentHash(identityInput.fieldContentHash.value, "biome population artifact identity.fieldContentHash"),
    runtimePackContentHash: contentHash(identityInput.runtimePackContentHash.value, "biome population artifact identity.runtimePackContentHash"),
  });
  const source = denseArray(root.placements.value, MAX_BIOME_POPULATION_ARTIFACT_PLACEMENTS, "biome population artifact placements");
  const placements = new Array(source.length);
  for (let index = 0; index < source.length; index++) {
    meter.work();
    const d = exactRecord(source[index], PLACEMENT_KEYS, `biome population artifact placements[${index}]`);
    const role = reference(d.role.value, `biome population artifact placements[${index}].role`).value;
    const assetId = reference(d.assetId.value, `biome population artifact placements[${index}].assetId`).value;
    const hash = contentHash(d.contentHash.value, `biome population artifact placements[${index}].contentHash`);
    const scale = canonicalNumber(d.scale.value, Number.MIN_VALUE, MAX_SCALE, `biome population artifact placements[${index}].scale`);
    if (scale === 0) fail(`biome population artifact placements[${index}].scale must be positive`);
    placements[index] = Object.freeze({
      role, assetId, contentHash: hash,
      x: canonicalNumber(d.x.value, -MAX_WORLD_METRES, MAX_WORLD_METRES, `biome population artifact placements[${index}].x`),
      y: canonicalNumber(d.y.value, -MAX_WORLD_METRES, MAX_WORLD_METRES, `biome population artifact placements[${index}].y`),
      z: canonicalNumber(d.z.value, -MAX_WORLD_METRES, MAX_WORLD_METRES, `biome population artifact placements[${index}].z`),
      yaw: canonicalNumber(d.yaw.value, -Math.PI * 2, Math.PI * 2, `biome population artifact placements[${index}].yaw`),
      scale,
      pageX: integer(d.pageX.value, -MAX_COORD, MAX_COORD, `biome population artifact placements[${index}].pageX`),
      pageZ: integer(d.pageZ.value, -MAX_COORD, MAX_COORD, `biome population artifact placements[${index}].pageZ`),
    });
  }
  return Object.freeze({ schema: BIOME_POPULATION_ARTIFACT_SCHEMA, coord, identity, placements: Object.freeze(placements) });
}

function buildDescriptors(plan, meter) {
  const unique = new Map();
  for (const placement of plan.placements) {
    meter.work();
    const key = descriptorKey(placement.role, placement.assetId, placement.contentHash);
    if (!unique.has(key)) unique.set(key, { role: placement.role, assetId: placement.assetId, contentHash: placement.contentHash });
  }
  const descriptors = [...unique.values()].sort((left, right) => compareText(left.role, right.role)
    || compareText(left.assetId, right.assetId) || compareText(left.contentHash, right.contentHash));
  const byKey = new Map();
  let byteLength = 0;
  for (let index = 0; index < descriptors.length; index++) {
    meter.work();
    const descriptor = descriptors[index];
    const roleBytes = encoder.encode(descriptor.role), assetIdBytes = encoder.encode(descriptor.assetId);
    descriptor.roleBytes = roleBytes;
    descriptor.assetIdBytes = assetIdBytes;
    byteLength += 36 + roleBytes.length + assetIdBytes.length;
    byKey.set(descriptorKey(descriptor.role, descriptor.assetId, descriptor.contentHash), index);
  }
  return Object.freeze({ descriptors, byKey, byteLength });
}

function integrityBytes(bytes) {
  const material = new Uint8Array(bytes);
  material.fill(0, 112, 144);
  return material;
}

function artifactBytes(input) {
  if (!ArrayBuffer.isView(input) || Object.getPrototypeOf(input) !== Uint8Array.prototype
      || !(input.buffer instanceof ArrayBuffer) || isShared(input.buffer)
      || input.byteOffset !== 0 || input.byteLength !== input.buffer.byteLength) {
    fail("biome population artifact bytes must be an owned Uint8Array over a non-shared ArrayBuffer");
  }
  if (input.length < BIOME_POPULATION_ARTIFACT_HEADER_BYTES || input.length > MAX_BIOME_POPULATION_ARTIFACT_BYTES) {
    fail("biome population artifact byte length is outside the supported range");
  }
  return input;
}

export function encodeBiomePopulationArtifact(input, controlInput) {
  const meter = createMeter(parseControl(controlInput));
  meter.start();
  const plan = parsePlan(input, meter);
  const table = buildDescriptors(plan, meter);
  const descriptorOffset = BIOME_POPULATION_ARTIFACT_HEADER_BYTES;
  const placementOffset = align8(descriptorOffset + table.byteLength);
  const byteLength = placementOffset + plan.placements.length * BIOME_POPULATION_ARTIFACT_PLACEMENT_BYTES;
  if (!Number.isSafeInteger(byteLength) || byteLength > MAX_BIOME_POPULATION_ARTIFACT_BYTES) {
    fail(`biome population artifact exceeds ${MAX_BIOME_POPULATION_ARTIFACT_BYTES} bytes`);
  }
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC.length; index++) bytes[index] = MAGIC[index];
  view.setUint16(8, BIOME_POPULATION_ARTIFACT_VERSION, true);
  view.setUint16(10, BIOME_POPULATION_ARTIFACT_HEADER_BYTES, true);
  view.setUint32(12, byteLength, true);
  view.setInt32(16, plan.coord.tx, true);
  view.setInt32(20, plan.coord.tz, true);
  view.setUint16(24, plan.coord.lod, true);
  view.setUint32(28, plan.placements.length, true);
  view.setUint32(32, table.descriptors.length, true);
  view.setUint32(36, descriptorOffset, true);
  view.setUint32(40, table.byteLength, true);
  view.setUint32(44, placementOffset, true);
  writeHex(bytes, 48, hashHex(plan.identity.fieldContentHash));
  writeHex(bytes, 80, hashHex(plan.identity.runtimePackContentHash));
  let cursor = descriptorOffset;
  for (const descriptor of table.descriptors) {
    meter.work();
    view.setUint16(cursor, descriptor.roleBytes.length, true);
    view.setUint16(cursor + 2, descriptor.assetIdBytes.length, true);
    writeHex(bytes, cursor + 4, hashHex(descriptor.contentHash));
    cursor += 36;
    bytes.set(descriptor.roleBytes, cursor); cursor += descriptor.roleBytes.length;
    bytes.set(descriptor.assetIdBytes, cursor); cursor += descriptor.assetIdBytes.length;
  }
  if (cursor !== descriptorOffset + table.byteLength) throw new Error("biome population artifact internal descriptor layout mismatch");
  for (let index = 0; index < plan.placements.length; index++) {
    meter.work();
    const placement = plan.placements[index], offset = placementOffset + index * BIOME_POPULATION_ARTIFACT_PLACEMENT_BYTES;
    const descriptorIndex = table.byKey.get(descriptorKey(placement.role, placement.assetId, placement.contentHash));
    if (descriptorIndex === undefined) throw new Error("biome population artifact internal descriptor reference mismatch");
    view.setUint32(offset, descriptorIndex, true);
    view.setInt32(offset + 4, placement.pageX, true);
    view.setInt32(offset + 8, placement.pageZ, true);
    view.setFloat64(offset + 16, placement.x, true);
    view.setFloat64(offset + 24, placement.y, true);
    view.setFloat64(offset + 32, placement.z, true);
    view.setFloat64(offset + 40, placement.yaw, true);
    view.setFloat64(offset + 48, placement.scale, true);
  }
  writeHex(bytes, 112, sha256(integrityBytes(bytes)));
  meter.finish();
  return bytes;
}

function decodeString(bytes, start, length, label) {
  try {
    const value = decoder.decode(bytes.subarray(start, start + length));
    if (encoder.encode(value).length !== length) fail(`${label} is not canonical UTF-8`);
    return value;
  } catch (error) {
    if (error instanceof BiomePopulationArtifactValidationError) throw error;
    fail(`${label} is invalid UTF-8`);
  }
}

export function decodeBiomePopulationArtifact(input, controlInput) {
  const bytes = artifactBytes(input);
  const meter = createMeter(parseControl(controlInput));
  meter.start();
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC.length; index++) if (bytes[index] !== MAGIC[index]) fail("biome population artifact magic mismatch");
  if (view.getUint16(8, true) !== BIOME_POPULATION_ARTIFACT_VERSION) fail("biome population artifact version is unsupported");
  if (view.getUint16(10, true) !== BIOME_POPULATION_ARTIFACT_HEADER_BYTES) fail("biome population artifact header length mismatch");
  if (view.getUint32(12, true) !== bytes.length) fail("biome population artifact byte length is non-canonical");
  if (view.getUint16(26, true) !== 0) fail("biome population artifact reserved header bytes must be zero");
  for (let offset = 144; offset < BIOME_POPULATION_ARTIFACT_HEADER_BYTES; offset++) if (bytes[offset] !== 0) fail("biome population artifact reserved header bytes must be zero");
  const expectedIntegrity = readHex(bytes, 112), actualIntegrity = sha256(integrityBytes(bytes));
  meter.finish();
  if (expectedIntegrity !== actualIntegrity) fail("biome population artifact integrity hash mismatch");

  const placementCount = view.getUint32(28, true), descriptorCount = view.getUint32(32, true);
  if (placementCount > MAX_BIOME_POPULATION_ARTIFACT_PLACEMENTS || descriptorCount > placementCount) fail("biome population artifact count is out of bounds");
  const descriptorOffset = view.getUint32(36, true), descriptorBytes = view.getUint32(40, true), placementOffset = view.getUint32(44, true);
  const expectedPlacementOffset = align8(BIOME_POPULATION_ARTIFACT_HEADER_BYTES + descriptorBytes);
  const expectedLength = expectedPlacementOffset + placementCount * BIOME_POPULATION_ARTIFACT_PLACEMENT_BYTES;
  if (descriptorOffset !== BIOME_POPULATION_ARTIFACT_HEADER_BYTES || placementOffset !== expectedPlacementOffset || expectedLength !== bytes.length) {
    fail("biome population artifact table layout is non-canonical");
  }
  for (let offset = descriptorOffset + descriptorBytes; offset < placementOffset; offset++) if (bytes[offset] !== 0) fail("biome population artifact alignment padding must be zero");

  const descriptors = new Array(descriptorCount);
  let cursor = descriptorOffset, priorKey = null;
  for (let index = 0; index < descriptorCount; index++) {
    meter.work();
    if (cursor + 36 > descriptorOffset + descriptorBytes) fail("biome population artifact descriptor is truncated");
    const roleLength = view.getUint16(cursor, true), assetIdLength = view.getUint16(cursor + 2, true);
    if (roleLength < 1 || assetIdLength < 1 || roleLength > BIOME_POPULATION_ASSET_LIMITS.refChars || assetIdLength > BIOME_POPULATION_ASSET_LIMITS.refChars
        || cursor + 36 + roleLength + assetIdLength > descriptorOffset + descriptorBytes) {
      fail("biome population artifact descriptor string length is invalid");
    }
    const hash = `sha256:${readHex(bytes, cursor + 4)}`;
    cursor += 36;
    const role = decodeString(bytes, cursor, roleLength, `biome population artifact descriptor ${index} role`); cursor += roleLength;
    const assetId = decodeString(bytes, cursor, assetIdLength, `biome population artifact descriptor ${index} assetId`); cursor += assetIdLength;
    const checkedRole = reference(role, `biome population artifact descriptor ${index} role`).value;
    const checkedAssetId = reference(assetId, `biome population artifact descriptor ${index} assetId`).value;
    contentHash(hash, `biome population artifact descriptor ${index} hash`);
    const key = descriptorKey(checkedRole, checkedAssetId, hash);
    if (priorKey !== null && priorKey >= key) fail("biome population artifact descriptors are not strictly sorted and unique");
    priorKey = key;
    descriptors[index] = Object.freeze({ role: checkedRole, assetId: checkedAssetId, contentHash: hash });
  }
  if (cursor !== descriptorOffset + descriptorBytes) fail("biome population artifact descriptor table has trailing bytes");

  const placements = new Array(placementCount);
  for (let index = 0; index < placementCount; index++) {
    meter.work();
    const offset = placementOffset + index * BIOME_POPULATION_ARTIFACT_PLACEMENT_BYTES;
    const descriptorIndex = view.getUint32(offset, true);
    if (descriptorIndex >= descriptors.length) fail(`biome population artifact placement ${index} descriptor index is invalid`);
    if (view.getUint32(offset + 12, true) !== 0) fail(`biome population artifact placement ${index} reserved bytes must be zero`);
    const descriptor = descriptors[descriptorIndex];
    placements[index] = {
      ...descriptor,
      x: view.getFloat64(offset + 16, true), y: view.getFloat64(offset + 24, true), z: view.getFloat64(offset + 32, true),
      yaw: view.getFloat64(offset + 40, true), scale: view.getFloat64(offset + 48, true),
      pageX: view.getInt32(offset + 4, true), pageZ: view.getInt32(offset + 8, true),
    };
  }
  const shell = {
    schema: BIOME_POPULATION_ARTIFACT_SCHEMA,
    coord: { tx: view.getInt32(16, true), tz: view.getInt32(20, true), lod: view.getUint16(24, true) },
    identity: { fieldContentHash: `sha256:${readHex(bytes, 48)}`, runtimePackContentHash: `sha256:${readHex(bytes, 80)}` },
    placements,
  };
  const plan = parsePlan(shell, meter);
  meter.finish();
  return Object.freeze({
    plan,
    metadata: Object.freeze({
      schema: BIOME_POPULATION_ARTIFACT_SCHEMA,
      artifactType: BIOME_POPULATION_ARTIFACT_TYPE,
      mediaType: BIOME_POPULATION_ARTIFACT_MEDIA_TYPE,
      version: BIOME_POPULATION_ARTIFACT_VERSION,
      byteLength: bytes.length,
      contentHash: `sha256:${sha256(bytes)}`,
      storage: "owned-object-and-array-copies",
    }),
  });
}

export function biomePopulationArtifactContentHash(input) {
  return `sha256:${sha256(artifactBytes(input))}`;
}
