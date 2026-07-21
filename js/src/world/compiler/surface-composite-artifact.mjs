import { sha256 } from "../sha256.mjs";
import { SURFACE_COMPOSITE_POLICY_VERSION, SURFACE_COMPOSITE_TILE_SCHEMA } from "../surface-composite-tile.mjs";

export const SURFACE_COMPOSITE_ARTIFACT_TYPE = "surface-composite-tile/v1";
export const SURFACE_COMPOSITE_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.surface-composite-qoi-v1";
export const SURFACE_COMPOSITE_ARTIFACT_VERSION = 1;
export const MAX_SURFACE_COMPOSITE_ARTIFACT_BYTES = 4 * 1024 * 1024;
export const MAX_SURFACE_COMPOSITE_DECODED_BYTES = 4 * 1024 * 1024;

const MAGIC = Object.freeze([0x4c, 0x4d, 0x53, 0x55, 0x52, 0x46, 0x01, 0x00]);
const HEADER_BYTES = 32;
const MAX_METADATA_BYTES = 16 * 1024;
const HASH = /^sha256:[0-9a-f]{64}$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function checkpoint(control, index = 0) {
  if ((index & 4095) === 0 && control?.shouldCancel?.() === true) {
    const error = new Error("surface composite artifact operation cancelled");
    error.name = "AbortError";
    throw error;
  }
}

function plain(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function exact(value, keys, label) {
  const names = Object.getOwnPropertyNames(value), expected = new Set(keys);
  if (Object.getOwnPropertySymbols(value).length !== 0 || names.length !== expected.size || names.some((name) => !expected.has(name))) {
    throw new TypeError(`${label} fields are invalid`);
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new TypeError(`${label}.${name} must be an enumerable data field`);
    }
  }
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${label} is out of bounds`);
  return value;
}
function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) throw new RangeError(`${label} must be a canonical finite number`);
  return value;
}
function hash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) throw new TypeError(`${label} must be a canonical content hash`);
  return value;
}
function tuple2(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 2) throw new TypeError(`${label} must be a two-number array`);
  return Object.freeze([finite(value[0], `${label}[0]`), finite(value[1], `${label}[1]`)]);
}

function canonicalMetadata(input, verifyPixels = true) {
  const root = exact(plain(input, "surface composite"), ["schema", "source", "coord", "placement", "resolution", "maps", "edgeHashes", "diagnostics"], "surface composite");
  if (root.schema !== SURFACE_COMPOSITE_TILE_SCHEMA) throw new TypeError("surface composite schema is unsupported");
  const sourceInput = plain(root.source, "surface composite source");
  const source = exact(sourceInput, Object.hasOwn(sourceInput, "environmentHash")
    ? ["biomeFieldHash", "biomePackHash", "terrainChunkHash", "environmentHash", "policyVersion"]
    : ["biomeFieldHash", "biomePackHash", "terrainChunkHash", "policyVersion"], "surface composite source");
  const coord = exact(plain(root.coord, "surface composite coord"), ["tx", "tz", "lod"], "surface composite coord");
  const placement = exact(plain(root.placement, "surface composite placement"), ["origin", "sizeM", "featureOrigin"], "surface composite placement");
  const resolution = exact(plain(root.resolution, "surface composite resolution"), ["interior", "gutter", "total"], "surface composite resolution");
  const maps = exact(plain(root.maps, "surface composite maps"), ["albedo", "normal", "orm"], "surface composite maps");
  const edges = exact(plain(root.edgeHashes, "surface composite edge hashes"), ["north", "east", "south", "west"], "surface composite edge hashes");
  const diagnostics = exact(plain(root.diagnostics, "surface composite diagnostics"), ["roles", "runtimeTextureSamples", "outputBytes"], "surface composite diagnostics");
  const interior = integer(resolution.interior, 2, 256, "surface composite interior");
  const gutter = integer(resolution.gutter, 0, 4, "surface composite gutter");
  const total = integer(resolution.total, 2, 264, "surface composite total");
  if (total !== interior + gutter * 2) throw new Error("surface composite resolution is inconsistent");
  const decodedMapBytes = total * total * 4;
  if (decodedMapBytes * 3 > MAX_SURFACE_COMPOSITE_DECODED_BYTES) throw new RangeError("surface composite decoded maps exceed budget");
  const mapMeta = {};
  for (const name of ["albedo", "normal", "orm"]) {
    const entry = plain(maps[name], `surface composite ${name}`);
    const required = name === "albedo" ? ["data", "contentHash", "colorSpace"]
      : name === "normal" ? ["data", "contentHash", "colorSpace", "convention"]
      : ["data", "contentHash", "colorSpace", "channels"];
    exact(entry, required, `surface composite ${name}`);
    if (!(entry.data instanceof Uint8Array) || !(entry.data.buffer instanceof ArrayBuffer) || entry.data.length !== decodedMapBytes
        || entry.data.byteOffset !== 0 || entry.data.byteLength !== entry.data.buffer.byteLength) {
      throw new TypeError(`surface composite ${name} must be owned exact RGBA8 data`);
    }
    const contentHash = hash(entry.contentHash, `surface composite ${name} hash`);
    if (verifyPixels && `sha256:${sha256(entry.data)}` !== contentHash) throw new Error(`surface composite ${name} content hash mismatch`);
    if (entry.colorSpace !== (name === "albedo" ? "srgb" : "none")) throw new Error(`surface composite ${name} color space is invalid`);
    if (name === "normal" && entry.convention !== "opengl-y-plus") throw new Error("surface composite normal convention is invalid");
    if (name === "orm" && entry.channels !== "ao-roughness-metalness-grass-density") throw new Error("surface composite ORM channels are invalid");
    mapMeta[name] = Object.freeze({ contentHash, colorSpace: entry.colorSpace,
      ...(name === "normal" ? { convention: entry.convention } : {}), ...(name === "orm" ? { channels: entry.channels } : {}) });
  }
  const outputBytes = integer(diagnostics.outputBytes, 1, MAX_SURFACE_COMPOSITE_DECODED_BYTES, "surface composite output bytes");
  if (outputBytes !== decodedMapBytes * 3 || diagnostics.runtimeTextureSamples !== 3) throw new Error("surface composite diagnostics are inconsistent");
  return Object.freeze({
    schema: SURFACE_COMPOSITE_TILE_SCHEMA,
    source: Object.freeze({ biomeFieldHash: hash(source.biomeFieldHash, "surface composite biome field hash"),
      biomePackHash: hash(source.biomePackHash, "surface composite biome pack hash"),
      terrainChunkHash: hash(source.terrainChunkHash, "surface composite terrain chunk hash"),
      environmentHash: hash(source.environmentHash ?? source.terrainChunkHash, "surface composite environment hash"),
      policyVersion: integer(source.policyVersion, SURFACE_COMPOSITE_POLICY_VERSION, SURFACE_COMPOSITE_POLICY_VERSION, "surface composite policy version") }),
    coord: Object.freeze({ tx: integer(coord.tx, -1_000_000, 1_000_000, "surface composite tx"), tz: integer(coord.tz, -1_000_000, 1_000_000, "surface composite tz"), lod: integer(coord.lod, 0, 16, "surface composite lod") }),
    placement: Object.freeze({ origin: tuple2(placement.origin, "surface composite origin"), sizeM: (() => { const size = finite(placement.sizeM, "surface composite size"); if (!(size > 0) || size > 1_000_000) throw new RangeError("surface composite size is out of bounds"); return size; })(), featureOrigin: tuple2(placement.featureOrigin, "surface composite feature origin") }),
    resolution: Object.freeze({ interior, gutter, total }), maps: Object.freeze(mapMeta),
    edgeHashes: Object.freeze({ north: hash(edges.north, "surface composite north edge"), east: hash(edges.east, "surface composite east edge"), south: hash(edges.south, "surface composite south edge"), west: hash(edges.west, "surface composite west edge") }),
    diagnostics: Object.freeze({ roles: integer(diagnostics.roles, 1, 32, "surface composite roles"), runtimeTextureSamples: 3, outputBytes }),
    codec: "qoi-rgba-v1",
  });
}

function pixelHash(r, g, b, a) { return (r * 3 + g * 5 + b * 7 + a * 11) & 63; }

function qoiEncode(data, control) {
  const output = [], index = new Uint8Array(64 * 4); let pr = 0, pg = 0, pb = 0, pa = 255, run = 0;
  const flush = () => { if (run > 0) { output.push(0xc0 | (run - 1)); run = 0; } };
  for (let offset = 0, pixel = 0; offset < data.length; offset += 4, pixel++) {
    checkpoint(control, pixel); const r = data[offset], g = data[offset + 1], b = data[offset + 2], a = data[offset + 3];
    if (r === pr && g === pg && b === pb && a === pa) { run++; if (run === 62 || offset + 4 === data.length) flush(); continue; }
    flush(); const slot = pixelHash(r, g, b, a) * 4;
    if (index[slot] === r && index[slot + 1] === g && index[slot + 2] === b && index[slot + 3] === a) output.push(slot / 4);
    else {
      index[slot] = r; index[slot + 1] = g; index[slot + 2] = b; index[slot + 3] = a;
      const dr = r - pr, dg = g - pg, db = b - pb;
      if (a === pa && dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1) output.push(0x40 | (dr + 2) << 4 | (dg + 2) << 2 | db + 2);
      else if (a === pa && dg >= -32 && dg <= 31 && dr - dg >= -8 && dr - dg <= 7 && db - dg >= -8 && db - dg <= 7) output.push(0x80 | dg + 32, (dr - dg + 8) << 4 | db - dg + 8);
      else if (a === pa) output.push(0xfe, r, g, b);
      else output.push(0xff, r, g, b, a);
    }
    pr = r; pg = g; pb = b; pa = a;
  }
  return Uint8Array.from(output);
}

function qoiDecode(bytes, pixels, control) {
  const output = new Uint8Array(pixels * 4), index = new Uint8Array(64 * 4); let at = 0, out = 0, pr = 0, pg = 0, pb = 0, pa = 255;
  while (out < output.length) {
    checkpoint(control, out >>> 2); if (at >= bytes.length) throw new Error("surface composite QOI stream is truncated");
    const tag = bytes[at++]; let run = 1, updateIndex = true;
    if (tag === 0xfe) { if (at + 3 > bytes.length) throw new Error("surface composite QOI RGB is truncated"); pr = bytes[at++]; pg = bytes[at++]; pb = bytes[at++]; }
    else if (tag === 0xff) { if (at + 4 > bytes.length) throw new Error("surface composite QOI RGBA is truncated"); pr = bytes[at++]; pg = bytes[at++]; pb = bytes[at++]; pa = bytes[at++]; }
    else if ((tag & 0xc0) === 0x00) { const slot = (tag & 63) * 4; pr = index[slot]; pg = index[slot + 1]; pb = index[slot + 2]; pa = index[slot + 3]; }
    else if ((tag & 0xc0) === 0x40) { pr = (pr + ((tag >> 4 & 3) - 2)) & 255; pg = (pg + ((tag >> 2 & 3) - 2)) & 255; pb = (pb + ((tag & 3) - 2)) & 255; }
    else if ((tag & 0xc0) === 0x80) { if (at >= bytes.length) throw new Error("surface composite QOI luma is truncated"); const next = bytes[at++], dg = (tag & 63) - 32; pr = (pr + dg + (next >> 4) - 8) & 255; pg = (pg + dg) & 255; pb = (pb + dg + (next & 15) - 8) & 255; }
    else { run = (tag & 63) + 1; updateIndex = false; }
    if (out + run * 4 > output.length) throw new Error("surface composite QOI run exceeds decoded size");
    if (updateIndex) { const slot = pixelHash(pr, pg, pb, pa) * 4; index[slot] = pr; index[slot + 1] = pg; index[slot + 2] = pb; index[slot + 3] = pa; }
    for (let count = 0; count < run; count++) { output[out++] = pr; output[out++] = pg; output[out++] = pb; output[out++] = pa; }
  }
  if (at !== bytes.length) throw new Error("surface composite QOI stream has trailing bytes");
  return output;
}

function parseEnvelope(bytes) {
  if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) || bytes.byteLength < HEADER_BYTES || bytes.byteLength > MAX_SURFACE_COMPOSITE_ARTIFACT_BYTES) throw new TypeError("surface composite artifact bytes are invalid");
  for (let index = 0; index < MAGIC.length; index++) if (bytes[index] !== MAGIC[index]) throw new Error("surface composite artifact magic is invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(8, true) !== SURFACE_COMPOSITE_ARTIFACT_VERSION || view.getUint16(10, true) !== HEADER_BYTES || view.getUint32(12, true) !== bytes.byteLength) throw new Error("surface composite artifact header is invalid");
  const metadataLength = view.getUint32(16, true), lengths = [view.getUint32(20, true), view.getUint32(24, true), view.getUint32(28, true)];
  if (metadataLength < 2 || metadataLength > MAX_METADATA_BYTES || HEADER_BYTES + metadataLength + lengths.reduce((a, b) => a + b, 0) !== bytes.byteLength || lengths.some((length) => length < 1)) throw new Error("surface composite artifact lengths are invalid");
  const metadataBytes = bytes.subarray(HEADER_BYTES, HEADER_BYTES + metadataLength); let parsed;
  try { parsed = JSON.parse(textDecoder.decode(metadataBytes)); } catch (error) { throw new Error("surface composite artifact metadata is invalid", { cause: error }); }
  const metadata = canonicalMetadataForDecode(parsed);
  const canonical = textEncoder.encode(JSON.stringify(metadata));
  if (canonical.length !== metadataBytes.length || !canonical.every((byte, index) => byte === metadataBytes[index])) throw new Error("surface composite artifact metadata is not canonical");
  let offset = HEADER_BYTES + metadataLength;
  const streams = lengths.map((length) => { const stream = bytes.subarray(offset, offset + length); offset += length; return stream; });
  return { metadata, streams };
}

function canonicalMetadataForDecode(input) {
  const root = exact(plain(input, "surface composite metadata"), ["schema", "source", "coord", "placement", "resolution", "maps", "edgeHashes", "diagnostics", "codec"], "surface composite metadata");
  if (root.codec !== "qoi-rgba-v1") throw new Error("surface composite artifact codec is unsupported");
  const total = root.resolution?.total;
  if (!Number.isSafeInteger(total) || total < 2 || total > 264) throw new RangeError("surface composite metadata total is out of bounds");
  const mapBytes = total * total * 4;
  const dummy = new Uint8Array(mapBytes);
  const maps = Object.fromEntries(["albedo", "normal", "orm"].map((name) => [name, { ...root.maps[name], data: dummy }]));
  const { codec: _codec, ...withoutCodec } = root;
  const validated = canonicalMetadata({ ...withoutCodec, maps }, false);
  return Object.freeze({ ...validated, maps: validated.maps, codec: "qoi-rgba-v1" });
}

export function encodeSurfaceCompositeArtifact(input, control = {}) {
  checkpoint(control); const metadata = canonicalMetadata(input), metadataBytes = textEncoder.encode(JSON.stringify(metadata));
  const streams = [input.maps.albedo.data, input.maps.normal.data, input.maps.orm.data].map((data) => qoiEncode(data, control));
  const length = HEADER_BYTES + metadataBytes.length + streams.reduce((sum, stream) => sum + stream.length, 0);
  if (length > MAX_SURFACE_COMPOSITE_ARTIFACT_BYTES) throw new RangeError("surface composite artifact exceeds encoded byte budget");
  const bytes = new Uint8Array(length); bytes.set(MAGIC); const view = new DataView(bytes.buffer);
  view.setUint16(8, SURFACE_COMPOSITE_ARTIFACT_VERSION, true); view.setUint16(10, HEADER_BYTES, true); view.setUint32(12, length, true); view.setUint32(16, metadataBytes.length, true);
  streams.forEach((stream, index) => view.setUint32(20 + index * 4, stream.length, true)); bytes.set(metadataBytes, HEADER_BYTES);
  let offset = HEADER_BYTES + metadataBytes.length; for (const stream of streams) { bytes.set(stream, offset); offset += stream.length; }
  return bytes;
}

export function inspectSurfaceCompositeArtifactBindings(bytes) {
  const { metadata } = parseEnvelope(bytes);
  return Object.freeze({ source: metadata.source, coord: metadata.coord, placement: metadata.placement, resolution: metadata.resolution,
    maps: metadata.maps, edgeHashes: metadata.edgeHashes, diagnostics: metadata.diagnostics, codec: metadata.codec });
}

export function decodeSurfaceCompositeArtifact(bytes, control = {}) {
  checkpoint(control); const { metadata, streams } = parseEnvelope(bytes), pixels = metadata.resolution.total ** 2;
  const decoded = streams.map((stream) => qoiDecode(stream, pixels, control));
  for (let index = 0; index < decoded.length; index++) {
    const name = ["albedo", "normal", "orm"][index], actual = `sha256:${sha256(decoded[index])}`;
    if (actual !== metadata.maps[name].contentHash) throw new Error(`surface composite decoded ${name} map hash mismatch (${actual})`);
    const canonical = qoiEncode(decoded[index], control);
    if (canonical.length !== streams[index].length || !canonical.every((byte, offset) => byte === streams[index][offset])) {
      throw new Error(`surface composite ${name} QOI stream is not canonical`);
    }
  }
  return Object.freeze({ schema: metadata.schema, source: metadata.source, coord: metadata.coord, placement: metadata.placement, resolution: metadata.resolution,
    maps: Object.freeze({ albedo: Object.freeze({ ...metadata.maps.albedo, data: decoded[0] }), normal: Object.freeze({ ...metadata.maps.normal, data: decoded[1] }), orm: Object.freeze({ ...metadata.maps.orm, data: decoded[2] }) }),
    edgeHashes: metadata.edgeHashes, diagnostics: metadata.diagnostics });
}
