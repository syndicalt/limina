import {
  ATLAS_DESIGN_REF_SCHEMA,
  parseAtlasDesignRef,
} from "../design-ref.mjs";

export const NAVIGATION_INDEX_ARTIFACT_SCHEMA = "limina.navigation-index-artifact/v1";
export const NAVIGATION_INDEX_ARTIFACT_VERSION = 1;
export const NAVIGATION_INDEX_ARTIFACT_TYPE = "navigation-index/v1";
export const NAVIGATION_INDEX_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.navigation-index";

// This is a runtime budget for searchable navigation subjects, not a mirror of
// Atlas geometry. Only navigable anchors, glyphs, stamps, places, and markers
// enter the index; raw features remain under their separate authoring budgets.
export const MAX_NAVIGATION_INDEX_ENTRIES = 100_000;
export const MAX_NAVIGATION_INDEX_SEARCH_KEYS_PER_ENTRY = 16;
// Four aliases per entry at full scale; smaller indexes may use all 16.
export const MAX_NAVIGATION_INDEX_SEARCH_KEYS = MAX_NAVIGATION_INDEX_ENTRIES * 4;
export const MAX_NAVIGATION_INDEX_STRING_CHARS = 256;
// The wire budget is independent of the structural counts: verbose labels or
// alias-heavy inputs must be curated rather than expanding runtime payloads.
export const MAX_NAVIGATION_INDEX_ARTIFACT_BYTES = 12 * 1024 * 1024;

const MAGIC = Uint8Array.of(0x4c, 0x4e, 0x41, 0x56, 0x49, 0x44, 0x58, 0x31); // LNAVIDX1
const HEADER_BYTES = 96;
const ENTRY_BYTES = 56;
const KEY_BYTES = 8;
const STRING_DESCRIPTOR_BYTES = 8;
const MAX_COORDINATE_M = 10_000_000;
const MAX_SEARCH_KEY_CHARS = 128;
const MAX_UTF8_STRING_BYTES = MAX_NAVIGATION_INDEX_STRING_CHARS * 4;
const KIND = /^[a-z][a-z0-9._-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const decodedState = new WeakMap();

const STRING_USE = Object.freeze({ IDENTIFIER: 1, REF_KIND: 2, LABEL: 4, KIND: 8, SEARCH_KEY: 16 });

export class NavigationIndexArtifactValidationError extends Error {
  constructor(message, code = "navigation_index_artifact_invalid") {
    super(message);
    this.name = "NavigationIndexArtifactValidationError";
    this.code = code;
  }
}

function fail(message) {
  throw new NavigationIndexArtifactValidationError(message);
}

function cancelled() {
  throw new NavigationIndexArtifactValidationError(
    "navigation index operation was cancelled",
    "navigation_index_artifact_cancelled",
  );
}

function exactRecord(value, required, optional, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object"
      || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object`);
  const names = Object.getOwnPropertyNames(value);
  const allowed = new Set([...required, ...optional]);
  if (Object.getOwnPropertySymbols(value).length !== 0 || names.some((name) => !allowed.has(name))
      || required.some((name) => !names.includes(name))) fail(`${label} fields are invalid`);
  const fields = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, "value")) {
      fail(`${label}.${name} must be an enumerable data field`);
    }
    fields[name] = descriptor.value;
  }
  return fields;
}

function denseArray(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > maximum || Object.getOwnPropertySymbols(value).length !== 0
      || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    fail(`${label} must be a dense array containing at most ${maximum} entries`);
  }
  const output = new Array(value.length);
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, "value")) {
      fail(`${label}[${index}] must be an enumerable data field`);
    }
    output[index] = descriptor.value;
  }
  return output;
}

function parseCancellationOptions(options) {
  const fields = exactRecord(options, [], ["cancellationFlag", "shouldCancel"], "navigation index options");
  const hasFlag = Object.hasOwn(fields, "cancellationFlag");
  const hasCallback = Object.hasOwn(fields, "shouldCancel");
  if (hasFlag && hasCallback) fail("navigation index options must choose one cancellation mechanism");
  if (hasCallback) {
    if (typeof fields.shouldCancel !== "function") fail("navigation index shouldCancel must be a function");
    return fields.shouldCancel;
  }
  if (!hasFlag) return null;
  const flag = fields.cancellationFlag;
  if (!(flag instanceof Int32Array) || flag.length !== 1
      || typeof SharedArrayBuffer !== "function" || !(flag.buffer instanceof SharedArrayBuffer)) {
    fail("navigation index cancellationFlag must be a one-element shared Int32Array");
  }
  return () => Atomics.load(flag, 0) !== 0;
}

function checkCancellation(shouldCancel, index = 0) {
  if (shouldCancel !== null && (index & 0xfff) === 0 && shouldCancel()) cancelled();
}

function finiteCoordinate(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE_M) {
    fail(`${label} must be a finite coordinate within ${MAX_COORDINATE_M} meters`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function printable(value, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
      || value.trim().length < 1 || CONTROL.test(value)) {
    fail(`${label} must contain 1-${maximum} printable characters`);
  }
  return value;
}

function canonicalSearchKey(value, label) {
  const input = printable(value, MAX_NAVIGATION_INDEX_STRING_CHARS, label);
  const key = input.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
  if (key.length < 1 || key.length > MAX_SEARCH_KEY_CHARS || CONTROL.test(key)) {
    fail(`${label} exceeds the canonical search-key limit`);
  }
  return key;
}

function compareBytes(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

function parseBounds(input) {
  const fields = exactRecord(input, ["minX", "minZ", "maxX", "maxZ"], [], "navigation world bounds");
  const bounds = {
    minX: finiteCoordinate(fields.minX, "navigation world bounds.minX"),
    minZ: finiteCoordinate(fields.minZ, "navigation world bounds.minZ"),
    maxX: finiteCoordinate(fields.maxX, "navigation world bounds.maxX"),
    maxZ: finiteCoordinate(fields.maxZ, "navigation world bounds.maxZ"),
  };
  if (!(bounds.maxX > bounds.minX) || !(bounds.maxZ > bounds.minZ)) {
    fail("navigation world bounds must have positive width and depth");
  }
  return Object.freeze(bounds);
}

function parsePosition(input, bounds, label) {
  const values = denseArray(input, 2, label);
  if (values.length !== 2) fail(`${label} must contain exactly [x,z]`);
  const position = [finiteCoordinate(values[0], `${label}[0]`), finiteCoordinate(values[1], `${label}[1]`)];
  if (position[0] < bounds.minX || position[0] > bounds.maxX
      || position[1] < bounds.minZ || position[1] > bounds.maxZ) {
    fail(`${label} lies outside navigation world bounds`);
  }
  return position;
}

function parseEntry(input, bounds, index) {
  const label = `navigation entry ${index}`;
  const fields = exactRecord(input, ["designRef", "position", "label", "kind", "searchKeys"], ["radiusM"], label);
  let designRef;
  try { designRef = parseAtlasDesignRef(fields.designRef); }
  catch (error) { fail(`${label}.designRef is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  const kind = printable(fields.kind, 64, `${label}.kind`);
  if (!KIND.test(kind)) fail(`${label}.kind is invalid`);
  const searchKeys = denseArray(fields.searchKeys, MAX_NAVIGATION_INDEX_SEARCH_KEYS_PER_ENTRY, `${label}.searchKeys`)
    .map((key, keyIndex) => canonicalSearchKey(key, `${label}.searchKeys[${keyIndex}]`));
  if (searchKeys.length < 1) fail(`${label}.searchKeys must not be empty`);
  const searchKeyBytes = searchKeys.map((key) => encoder.encode(key));
  const order = searchKeys.map((_, keyIndex) => keyIndex)
    .sort((left, right) => compareBytes(searchKeyBytes[left], searchKeyBytes[right]));
  const sortedKeys = order.map((keyIndex) => searchKeys[keyIndex]);
  const sortedKeyBytes = order.map((keyIndex) => searchKeyBytes[keyIndex]);
  for (let keyIndex = 1; keyIndex < sortedKeys.length; keyIndex++) {
    if (compareBytes(sortedKeyBytes[keyIndex - 1], sortedKeyBytes[keyIndex]) === 0) {
      fail(`${label}.searchKeys contains duplicate canonical keys`);
    }
  }
  let radiusM;
  if (Object.hasOwn(fields, "radiusM")) {
    radiusM = finiteCoordinate(fields.radiusM, `${label}.radiusM`);
    if (!(radiusM > 0)) fail(`${label}.radiusM must be positive`);
  }
  return {
    designRef,
    designRefBytes: [encoder.encode(designRef.mapId), encoder.encode(designRef.kind), encoder.encode(designRef.id)],
    position: parsePosition(fields.position, bounds, `${label}.position`),
    label: printable(fields.label, MAX_NAVIGATION_INDEX_STRING_CHARS, `${label}.label`),
    kind,
    searchKeys: sortedKeys,
    searchKeyBytes: sortedKeyBytes,
    radiusM,
  };
}

function compareEntries(left, right) {
  return compareBytes(left.designRefBytes[0], right.designRefBytes[0])
    || compareBytes(left.designRefBytes[1], right.designRefBytes[1])
    || compareBytes(left.designRefBytes[2], right.designRefBytes[2]);
}

function checkedSectionEnd(offset, count, stride, label) {
  const end = offset + count * stride;
  if (!Number.isSafeInteger(end) || end > MAX_NAVIGATION_INDEX_ARTIFACT_BYTES) {
    fail(`${label} exceeds the navigation artifact size budget`);
  }
  return end;
}

function setMagic(bytes) {
  bytes.set(MAGIC, 0);
}

function hasMagic(bytes) {
  for (let index = 0; index < MAGIC.length; index++) if (bytes[index] !== MAGIC[index]) return false;
  return true;
}

function buildEncodedArtifact(input, cancellationCheck) {
  checkCancellation(cancellationCheck);
  const fields = exactRecord(input, ["worldBounds", "entries"], [], "navigation index source");
  const worldBounds = parseBounds(fields.worldBounds);
  const rawEntries = denseArray(fields.entries, MAX_NAVIGATION_INDEX_ENTRIES, "navigation entries");
  const entries = new Array(rawEntries.length);
  for (let index = 0; index < rawEntries.length; index++) {
    checkCancellation(cancellationCheck, index);
    entries[index] = parseEntry(rawEntries[index], worldBounds, index);
  }
  let sortComparisons = 0;
  entries.sort((left, right) => {
    checkCancellation(cancellationCheck, sortComparisons++);
    return compareEntries(left, right);
  });
  let keyCount = 0;
  for (let index = 0; index < entries.length; index++) {
    checkCancellation(cancellationCheck, index);
    if (index > 0 && compareEntries(entries[index - 1], entries[index]) === 0) {
      const ref = entries[index].designRef;
      fail(`navigation entries contain duplicate designRef '${ref.mapId}:${ref.kind}:${ref.id}'`);
    }
    keyCount += entries[index].searchKeys.length;
    if (keyCount > MAX_NAVIGATION_INDEX_SEARCH_KEYS) fail("navigation index contains too many search keys");
  }

  const strings = [];
  const stringBytes = [];
  const stringIds = new Map();
  let blobBytes = 0;
  const intern = (value, knownBytes) => {
    const existing = stringIds.get(value);
    if (existing !== undefined) return existing;
    const bytes = knownBytes ?? encoder.encode(value);
    if (bytes.length > MAX_UTF8_STRING_BYTES) fail("navigation index string exceeds the UTF-8 byte budget");
    const id = strings.length;
    strings.push(value);
    stringBytes.push(bytes);
    stringIds.set(value, id);
    blobBytes += bytes.length;
    return id;
  };

  const entryStringIds = new Array(entries.length);
  for (let index = 0; index < entries.length; index++) {
    checkCancellation(cancellationCheck, index);
    const entry = entries[index];
    entryStringIds[index] = [
      intern(entry.designRef.mapId, entry.designRefBytes[0]),
      intern(entry.designRef.kind, entry.designRefBytes[1]),
      intern(entry.designRef.id, entry.designRefBytes[2]),
      intern(entry.label), intern(entry.kind),
    ];
  }
  const keyRecords = new Array(keyCount);
  let keyIndex = 0;
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    checkCancellation(cancellationCheck, entryIndex);
    const entry = entries[entryIndex];
    entry.firstKey = keyIndex;
    for (let localIndex = 0; localIndex < entry.searchKeys.length; localIndex++) {
      keyRecords[keyIndex++] = {
        stringId: intern(entry.searchKeys[localIndex], entry.searchKeyBytes[localIndex]),
        entryIndex,
      };
    }
  }
  const sortedKeyOrder = Array.from({ length: keyCount }, (_, index) => index);
  sortComparisons = 0;
  sortedKeyOrder.sort((left, right) => {
    checkCancellation(cancellationCheck, sortComparisons++);
    const leftRecord = keyRecords[left], rightRecord = keyRecords[right];
    return compareBytes(stringBytes[leftRecord.stringId], stringBytes[rightRecord.stringId])
      || leftRecord.entryIndex - rightRecord.entryIndex;
  });

  const entryOffset = HEADER_BYTES;
  const keyOffset = checkedSectionEnd(entryOffset, entries.length, ENTRY_BYTES, "navigation entry table");
  const orderOffset = checkedSectionEnd(keyOffset, keyCount, KEY_BYTES, "navigation key table");
  const descriptorOffset = checkedSectionEnd(orderOffset, keyCount, 4, "navigation key order");
  const blobOffset = checkedSectionEnd(descriptorOffset, strings.length, STRING_DESCRIPTOR_BYTES, "navigation string table");
  const totalBytes = blobOffset + blobBytes;
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_NAVIGATION_INDEX_ARTIFACT_BYTES) {
    fail(`navigation index artifact exceeds ${MAX_NAVIGATION_INDEX_ARTIFACT_BYTES} bytes`);
  }

  const bytes = new Uint8Array(totalBytes);
  const view = new DataView(bytes.buffer);
  setMagic(bytes);
  view.setUint16(8, NAVIGATION_INDEX_ARTIFACT_VERSION, true);
  view.setUint16(10, HEADER_BYTES, true);
  view.setUint32(16, entries.length, true);
  view.setUint32(20, keyCount, true);
  view.setUint32(24, strings.length, true);
  view.setUint32(32, entryOffset, true);
  view.setUint32(36, keyOffset, true);
  view.setUint32(40, orderOffset, true);
  view.setUint32(44, descriptorOffset, true);
  view.setUint32(48, blobOffset, true);
  view.setUint32(52, totalBytes, true);
  view.setFloat64(56, worldBounds.minX, true);
  view.setFloat64(64, worldBounds.minZ, true);
  view.setFloat64(72, worldBounds.maxX, true);
  view.setFloat64(80, worldBounds.maxZ, true);

  for (let index = 0; index < entries.length; index++) {
    checkCancellation(cancellationCheck, index);
    const offset = entryOffset + index * ENTRY_BYTES;
    const ids = entryStringIds[index], entry = entries[index];
    for (let field = 0; field < ids.length; field++) view.setUint32(offset + field * 4, ids[field], true);
    view.setUint32(offset + 20, entry.firstKey, true);
    view.setUint16(offset + 24, entry.searchKeys.length, true);
    view.setUint16(offset + 26, entry.radiusM === undefined ? 0 : 1, true);
    view.setFloat64(offset + 32, entry.position[0], true);
    view.setFloat64(offset + 40, entry.position[1], true);
    view.setFloat64(offset + 48, entry.radiusM ?? 0, true);
  }
  for (let index = 0; index < keyRecords.length; index++) {
    const offset = keyOffset + index * KEY_BYTES;
    view.setUint32(offset, keyRecords[index].stringId, true);
    view.setUint32(offset + 4, keyRecords[index].entryIndex, true);
    view.setUint32(orderOffset + index * 4, sortedKeyOrder[index], true);
  }
  let blobCursor = 0;
  for (let index = 0; index < stringBytes.length; index++) {
    const bytesForString = stringBytes[index];
    view.setUint32(descriptorOffset + index * STRING_DESCRIPTOR_BYTES, blobCursor, true);
    view.setUint32(descriptorOffset + index * STRING_DESCRIPTOR_BYTES + 4, bytesForString.length, true);
    bytes.set(bytesForString, blobOffset + blobCursor);
    blobCursor += bytesForString.length;
  }
  return bytes;
}

export function encodeNavigationIndexArtifact(input, options = {}) {
  return buildEncodedArtifact(input, parseCancellationOptions(options));
}

function readHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < HEADER_BYTES
      || bytes.byteLength > MAX_NAVIGATION_INDEX_ARTIFACT_BYTES) {
    fail(`navigation index artifact must contain ${HEADER_BYTES}-${MAX_NAVIGATION_INDEX_ARTIFACT_BYTES} bytes`);
  }
  const ownedBytes = Uint8Array.from(bytes);
  if (!hasMagic(ownedBytes)) fail("navigation index artifact magic is invalid");
  const view = new DataView(ownedBytes.buffer);
  if (view.getUint16(8, true) !== NAVIGATION_INDEX_ARTIFACT_VERSION
      || view.getUint16(10, true) !== HEADER_BYTES) fail("navigation index artifact version is unsupported");
  if (view.getUint32(12, true) !== 0 || view.getUint32(28, true) !== 0
      || view.getUint32(88, true) !== 0 || view.getUint32(92, true) !== 0) {
    fail("navigation index artifact reserved header fields must be zero");
  }
  const header = {
    ownedBytes,
    view,
    entryCount: view.getUint32(16, true),
    keyCount: view.getUint32(20, true),
    stringCount: view.getUint32(24, true),
    entryOffset: view.getUint32(32, true),
    keyOffset: view.getUint32(36, true),
    orderOffset: view.getUint32(40, true),
    descriptorOffset: view.getUint32(44, true),
    blobOffset: view.getUint32(48, true),
    totalBytes: view.getUint32(52, true),
  };
  if (header.entryCount > MAX_NAVIGATION_INDEX_ENTRIES
      || header.keyCount > MAX_NAVIGATION_INDEX_SEARCH_KEYS
      || header.stringCount > header.entryCount * 5 + header.keyCount) {
    fail("navigation index artifact counts exceed their production budgets");
  }
  const expectedKeyOffset = checkedSectionEnd(HEADER_BYTES, header.entryCount, ENTRY_BYTES, "navigation entry table");
  const expectedOrderOffset = checkedSectionEnd(expectedKeyOffset, header.keyCount, KEY_BYTES, "navigation key table");
  const expectedDescriptorOffset = checkedSectionEnd(expectedOrderOffset, header.keyCount, 4, "navigation key order");
  const expectedBlobOffset = checkedSectionEnd(expectedDescriptorOffset, header.stringCount, STRING_DESCRIPTOR_BYTES, "navigation string table");
  if (header.entryOffset !== HEADER_BYTES || header.keyOffset !== expectedKeyOffset
      || header.orderOffset !== expectedOrderOffset || header.descriptorOffset !== expectedDescriptorOffset
      || header.blobOffset !== expectedBlobOffset || header.totalBytes !== ownedBytes.byteLength) {
    fail("navigation index artifact section layout is invalid");
  }
  return header;
}

function descriptor(state, stringId) {
  if (stringId >= state.stringCount) fail("navigation index string reference is out of bounds");
  const offset = state.descriptorOffset + stringId * STRING_DESCRIPTOR_BYTES;
  return [state.view.getUint32(offset, true), state.view.getUint32(offset + 4, true)];
}

function stringBytes(state, stringId) {
  const [offset, length] = descriptor(state, stringId);
  return state.ownedBytes.subarray(state.blobOffset + offset, state.blobOffset + offset + length);
}

function decodeString(state, stringId) {
  try { return decoder.decode(stringBytes(state, stringId)); }
  catch { fail("navigation index string is not valid UTF-8"); }
}

function validatePrintableString(state, stringId, maximum, label) {
  const descriptorOffset = state.descriptorOffset + stringId * STRING_DESCRIPTOR_BYTES;
  const relativeOffset = state.view.getUint32(descriptorOffset, true);
  const length = state.view.getUint32(descriptorOffset + 4, true);
  const start = state.blobOffset + relativeOffset;
  let ascii = true;
  let onlySpaces = true;
  for (let index = 0; index < length; index++) {
    const byte = state.ownedBytes[start + index];
    if (byte >= 0x80) { ascii = false; break; }
    if (byte < 0x20 || byte === 0x7f) fail(`${label} contains control characters`);
    if (byte !== 0x20) onlySpaces = false;
  }
  if (ascii) {
    if (length < 1 || length > maximum || onlySpaces) fail(`${label} is not a bounded printable string`);
    return;
  }
  const value = decodeString(state, stringId);
  printable(value, maximum, label);
}

function validateUsedString(state, stringId, use) {
  if (stringId >= state.stringCount) fail("navigation index string reference is out of bounds");
  if ((state.stringUses[stringId] & use) !== 0) return;
  if (state.stringUses[stringId] === 0) {
    if (stringId !== state.nextStringId) fail("navigation index string table is not in canonical first-use order");
    state.nextStringId++;
  }
  state.stringUses[stringId] |= use;
  if (use === STRING_USE.IDENTIFIER) validatePrintableString(state, stringId, 128, "navigation design identifier");
  else if (use === STRING_USE.LABEL) validatePrintableString(state, stringId, MAX_NAVIGATION_INDEX_STRING_CHARS, "navigation label");
  else if (use === STRING_USE.REF_KIND) {
    const value = decodeString(state, stringId);
    if (value !== "feature" && value !== "marker" && value !== "place" && value !== "stamp") {
      fail("navigation designRef kind is invalid");
    }
  } else if (use === STRING_USE.KIND) {
    const value = decodeString(state, stringId);
    if (!KIND.test(value)) fail("navigation entry kind is invalid");
  } else if (use === STRING_USE.SEARCH_KEY) {
    const descriptorOffset = state.descriptorOffset + stringId * STRING_DESCRIPTOR_BYTES;
    const relativeOffset = state.view.getUint32(descriptorOffset, true);
    const length = state.view.getUint32(descriptorOffset + 4, true);
    const start = state.blobOffset + relativeOffset;
    let ascii = true;
    for (let index = 0; index < length; index++) {
      const byte = state.ownedBytes[start + index];
      if (byte >= 0x80) { ascii = false; break; }
      if (byte < 0x20 || byte === 0x7f || (byte >= 0x41 && byte <= 0x5a)
          || (byte === 0x20 && (index === 0 || index === length - 1 || state.ownedBytes[start + index - 1] === 0x20))) {
        fail("navigation search key is not canonical");
      }
    }
    if (ascii) {
      if (length < 1 || length > MAX_SEARCH_KEY_CHARS) fail("navigation search key is not canonical");
    } else {
      const value = decodeString(state, stringId);
      if (canonicalSearchKey(value, "navigation search key") !== value) fail("navigation search key is not canonical");
    }
  }
}

function compareStringIds(state, leftId, rightId) {
  const leftDescriptor = state.descriptorOffset + leftId * STRING_DESCRIPTOR_BYTES;
  const rightDescriptor = state.descriptorOffset + rightId * STRING_DESCRIPTOR_BYTES;
  const leftStart = state.blobOffset + state.view.getUint32(leftDescriptor, true);
  const rightStart = state.blobOffset + state.view.getUint32(rightDescriptor, true);
  const leftLength = state.view.getUint32(leftDescriptor + 4, true);
  const rightLength = state.view.getUint32(rightDescriptor + 4, true);
  const length = Math.min(leftLength, rightLength);
  for (let index = 0; index < length; index++) {
    const difference = state.ownedBytes[leftStart + index] - state.ownedBytes[rightStart + index];
    if (difference !== 0) return difference;
  }
  return leftLength - rightLength;
}

function validateStringDescriptors(state, cancellationCheck) {
  let expectedOffset = 0;
  for (let index = 0; index < state.stringCount; index++) {
    checkCancellation(cancellationCheck, index);
    const descriptorOffset = state.descriptorOffset + index * STRING_DESCRIPTOR_BYTES;
    const offset = state.view.getUint32(descriptorOffset, true);
    const length = state.view.getUint32(descriptorOffset + 4, true);
    if (offset !== expectedOffset || length < 1 || length > MAX_UTF8_STRING_BYTES
        || offset + length > state.ownedBytes.length - state.blobOffset) {
      fail("navigation index string descriptor is invalid");
    }
    const startByte = state.ownedBytes[state.blobOffset + offset];
    const after = state.blobOffset + offset + length;
    if ((startByte & 0xc0) === 0x80
        || (after < state.ownedBytes.length && (state.ownedBytes[after] & 0xc0) === 0x80)) {
      fail("navigation index string descriptor splits a UTF-8 sequence");
    }
    expectedOffset += length;
  }
  if (expectedOffset !== state.ownedBytes.length - state.blobOffset) {
    fail("navigation index string blob contains unreferenced bytes");
  }
  try { decoder.decode(state.ownedBytes.subarray(state.blobOffset)); }
  catch { fail("navigation index string blob is not valid UTF-8"); }
}

function validateEntries(state, bounds, cancellationCheck) {
  let expectedFirstKey = 0;
  let previousMapId = -1;
  let previousKindId = -1;
  let previousRefId = -1;
  for (let index = 0; index < state.entryCount; index++) {
    checkCancellation(cancellationCheck, index);
    const offset = state.entryOffset + index * ENTRY_BYTES;
    const mapId = state.view.getUint32(offset, true);
    const refKindId = state.view.getUint32(offset + 4, true);
    const refId = state.view.getUint32(offset + 8, true);
    const labelId = state.view.getUint32(offset + 12, true);
    const kindId = state.view.getUint32(offset + 16, true);
    validateUsedString(state, mapId, STRING_USE.IDENTIFIER);
    validateUsedString(state, refKindId, STRING_USE.REF_KIND);
    validateUsedString(state, refId, STRING_USE.IDENTIFIER);
    validateUsedString(state, labelId, STRING_USE.LABEL);
    validateUsedString(state, kindId, STRING_USE.KIND);
    if (previousMapId !== -1) {
      const order = compareStringIds(state, previousMapId, mapId)
        || compareStringIds(state, previousKindId, refKindId)
        || compareStringIds(state, previousRefId, refId);
      if (order >= 0) fail(order === 0 ? "navigation entries contain duplicate designRef" : "navigation entries are not canonical");
    }
    previousMapId = mapId;
    previousKindId = refKindId;
    previousRefId = refId;
    const firstKey = state.view.getUint32(offset + 20, true);
    const keyCount = state.view.getUint16(offset + 24, true);
    const flags = state.view.getUint16(offset + 26, true);
    const reserved = state.view.getUint32(offset + 28, true);
    const x = state.view.getFloat64(offset + 32, true);
    const z = state.view.getFloat64(offset + 40, true);
    const radius = state.view.getFloat64(offset + 48, true);
    if (firstKey !== expectedFirstKey || keyCount < 1 || keyCount > MAX_NAVIGATION_INDEX_SEARCH_KEYS_PER_ENTRY
        || firstKey + keyCount > state.keyCount) fail("navigation entry key range is invalid");
    if ((flags !== 0 && flags !== 1) || reserved !== 0 || !Number.isFinite(x) || !Number.isFinite(z)
        || x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ
        || (flags === 0 ? radius !== 0 : !Number.isFinite(radius) || radius <= 0 || radius > MAX_COORDINATE_M)) {
      fail("navigation entry numeric record is invalid");
    }
    expectedFirstKey += keyCount;
  }
  if (expectedFirstKey !== state.keyCount) fail("navigation key table is incomplete");
}

function validateKeys(state, cancellationCheck) {
  let expectedEntry = 0;
  let previousStringId = null;
  for (let index = 0; index < state.keyCount; index++) {
    checkCancellation(cancellationCheck, index);
    while (expectedEntry < state.entryCount) {
      const entryOffset = state.entryOffset + expectedEntry * ENTRY_BYTES;
      const first = state.view.getUint32(entryOffset + 20, true);
      const count = state.view.getUint16(entryOffset + 24, true);
      if (index < first + count) break;
      expectedEntry++;
      previousStringId = null;
    }
    const offset = state.keyOffset + index * KEY_BYTES;
    const stringId = state.view.getUint32(offset, true);
    const entryIndex = state.view.getUint32(offset + 4, true);
    if (entryIndex !== expectedEntry) fail("navigation key entry reference is not canonical");
    validateUsedString(state, stringId, STRING_USE.SEARCH_KEY);
    if (previousStringId !== null && compareStringIds(state, previousStringId, stringId) >= 0) {
      fail("navigation entry search keys are not strictly sorted");
    }
    previousStringId = stringId;
  }
  if (state.nextStringId !== state.stringCount) fail("navigation string table contains unused records");

  const seen = new Uint8Array(state.keyCount);
  let previousKey = null;
  let previousEntry = -1;
  for (let index = 0; index < state.keyCount; index++) {
    checkCancellation(cancellationCheck, index);
    const keyIndex = state.view.getUint32(state.orderOffset + index * 4, true);
    if (keyIndex >= state.keyCount || seen[keyIndex] !== 0) fail("navigation sorted-key table is not a permutation");
    seen[keyIndex] = 1;
    const keyOffset = state.keyOffset + keyIndex * KEY_BYTES;
    const stringId = state.view.getUint32(keyOffset, true);
    const entryIndex = state.view.getUint32(keyOffset + 4, true);
    if (previousKey !== null) {
      const order = compareStringIds(state, previousKey, stringId);
      if (order > 0 || (order === 0 && entryIndex <= previousEntry)) {
        fail("navigation sorted-key table is not canonical");
      }
    }
    previousKey = stringId;
    previousEntry = entryIndex;
  }
}

export function decodeNavigationIndexArtifact(bytes, options = {}) {
  const cancellationCheck = parseCancellationOptions(options);
  checkCancellation(cancellationCheck);
  const state = readHeader(bytes);
  const bounds = parseBounds({
    minX: state.view.getFloat64(56, true), minZ: state.view.getFloat64(64, true),
    maxX: state.view.getFloat64(72, true), maxZ: state.view.getFloat64(80, true),
  });
  state.stringUses = new Uint8Array(state.stringCount);
  state.nextStringId = 0;
  validateStringDescriptors(state, cancellationCheck);
  validateEntries(state, bounds, cancellationCheck);
  validateKeys(state, cancellationCheck);
  const artifact = Object.freeze({
    schema: NAVIGATION_INDEX_ARTIFACT_SCHEMA,
    version: NAVIGATION_INDEX_ARTIFACT_VERSION,
    worldBounds: bounds,
    entryCount: state.entryCount,
    keyCount: state.keyCount,
    byteLength: state.ownedBytes.byteLength,
  });
  delete state.stringUses;
  delete state.nextStringId;
  decodedState.set(artifact, state);
  return artifact;
}

function compareKeyToPrefix(state, keyIndex, prefixBytes) {
  const keyOffset = state.keyOffset + keyIndex * KEY_BYTES;
  const stringId = state.view.getUint32(keyOffset, true);
  return compareBytes(stringBytes(state, stringId), prefixBytes);
}

function lowerBound(state, prefixBytes) {
  let low = 0;
  let high = state.keyCount;
  while (low < high) {
    const middle = low + ((high - low) >> 1);
    const keyIndex = state.view.getUint32(state.orderOffset + middle * 4, true);
    if (compareKeyToPrefix(state, keyIndex, prefixBytes) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function startsWithBytes(value, prefix) {
  if (value.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index++) if (value[index] !== prefix[index]) return false;
  return true;
}

function materializeEntry(state, entryIndex) {
  const offset = state.entryOffset + entryIndex * ENTRY_BYTES;
  const mapId = decodeString(state, state.view.getUint32(offset, true));
  const refKind = decodeString(state, state.view.getUint32(offset + 4, true));
  const id = decodeString(state, state.view.getUint32(offset + 8, true));
  const label = decodeString(state, state.view.getUint32(offset + 12, true));
  const kind = decodeString(state, state.view.getUint32(offset + 16, true));
  const firstKey = state.view.getUint32(offset + 20, true);
  const keyCount = state.view.getUint16(offset + 24, true);
  const flags = state.view.getUint16(offset + 26, true);
  const searchKeys = new Array(keyCount);
  for (let index = 0; index < keyCount; index++) {
    const keyOffset = state.keyOffset + (firstKey + index) * KEY_BYTES;
    searchKeys[index] = decodeString(state, state.view.getUint32(keyOffset, true));
  }
  const entry = {
    designRef: Object.freeze({ schema: ATLAS_DESIGN_REF_SCHEMA, mapId, kind: refKind, id }),
    position: Object.freeze([state.view.getFloat64(offset + 32, true), state.view.getFloat64(offset + 40, true)]),
    label,
    kind,
    searchKeys: Object.freeze(searchKeys),
  };
  if (flags === 1) entry.radiusM = state.view.getFloat64(offset + 48, true);
  return Object.freeze(entry);
}

export function searchNavigationIndexPrefix(artifact, prefixInput, options = {}) {
  const state = decodedState.get(artifact);
  if (state === undefined) fail("prefix search requires a decoded navigation index artifact");
  const optionFields = exactRecord(options, [], ["limit"], "navigation prefix search options");
  const limit = Object.hasOwn(optionFields, "limit") ? optionFields.limit : 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    fail("navigation prefix search limit must be an integer in [1, 100]");
  }
  const prefixBytes = encoder.encode(canonicalSearchKey(prefixInput, "navigation search prefix"));
  const results = [];
  const seen = new Set();
  for (let orderIndex = lowerBound(state, prefixBytes); orderIndex < state.keyCount; orderIndex++) {
    const keyIndex = state.view.getUint32(state.orderOffset + orderIndex * 4, true);
    const keyOffset = state.keyOffset + keyIndex * KEY_BYTES;
    const stringId = state.view.getUint32(keyOffset, true);
    if (!startsWithBytes(stringBytes(state, stringId), prefixBytes)) break;
    const entryIndex = state.view.getUint32(keyOffset + 4, true);
    if (seen.has(entryIndex)) continue;
    seen.add(entryIndex);
    results.push(materializeEntry(state, entryIndex));
    if (results.length === limit) break;
  }
  return Object.freeze(results);
}
