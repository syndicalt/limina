import {
  BIOME_CONTENT_ARTIFACT_HEADER_BYTES,
  BIOME_CONTENT_ARTIFACT_MEDIA_TYPE,
  BIOME_CONTENT_ARTIFACT_SCHEMA,
  BIOME_CONTENT_ARTIFACT_TYPE,
  BIOME_CONTENT_ARTIFACT_VERSION,
  MAX_BIOME_CONTENT_ARTIFACT_BYTES,
  MAX_BIOME_CONTENT_ARTIFACT_ENTRIES,
  BiomeContentArtifactCancelledError,
  biomeContentArtifactContentHash,
  decodeBiomeContentArtifact,
  encodeBiomeContentArtifact,
} from "../src/world/compiler/biome-content-artifact.mjs";
import * as compiler from "../src/world/compiler/index.mjs";
import { portableAssetContentHash } from "../src/world/asset-content-hash.mjs";
import { sha256 } from "../src/world/sha256.mjs";
import { MAX_DERIVED_ARTIFACT_BYTES } from "../src/world/compiler/manifest.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_biome_content_artifact FAIL: ${message}`);
}
function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(`${error.name}: ${error.message}`),
    `${message}: ${error instanceof Error ? `${error.name}: ${error.message}` : "did not throw"}`);
}
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const text = new TextEncoder();
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;

function entry(id: string, bytes: Uint8Array) {
  return { id, path: `assets/${id}`, hash: portableAssetContentHash(bytes), bytes };
}
function archive(entries = [
  entry("biomes/lush/forest-grass.json", text.encode('{"backend":"grass-field"}')),
  entry("biomes/lush/oak.glb", new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0])),
  entry("runtime/temperate.json", text.encode('{"schema":"limina.biome-runtime-pack/v1"}')),
]) {
  return {
    schema: BIOME_CONTENT_ARTIFACT_SCHEMA,
    identity: { bundleClosureHash: HASH_A, runtimePackContentHash: HASH_B, fieldContentHash: HASH_C },
    entries,
  };
}

const source = archive();
const first = encodeBiomeContentArtifact(source);
const second = encodeBiomeContentArtifact(source);
assert(equalBytes(first, second), "same archive did not encode byte-identically");
assert(first.byteLength <= MAX_BIOME_CONTENT_ARTIFACT_BYTES
  && MAX_BIOME_CONTENT_ARTIFACT_BYTES === MAX_DERIVED_ARTIFACT_BYTES,
"archive cap drifted from the global derived artifact cap");
const vectorHash = biomeContentArtifactContentHash(first);
const EXPECTED_VECTOR_HASH = "sha256:717a0e7921de0be6d0eb251d06e7a8db42be065354717b4ce6c609b42396640a";
assert(vectorHash === EXPECTED_VECTOR_HASH, `canonical portable vector changed: ${vectorHash}`);

const view = new DataView(first.buffer);
assert(view.getUint16(8, true) === BIOME_CONTENT_ARTIFACT_VERSION
  && view.getUint16(10, true) === BIOME_CONTENT_ARTIFACT_HEADER_BYTES
  && view.getUint32(12, true) === first.length
  && view.getUint32(16, true) === source.entries.length
  && view.getUint32(20, true) === BIOME_CONTENT_ARTIFACT_HEADER_BYTES,
"fixed little-endian archive header fields are incorrect");

const decoded = decodeBiomeContentArtifact(first);
assert(decoded.archive.schema === BIOME_CONTENT_ARTIFACT_SCHEMA
  && JSON.stringify(decoded.archive.identity) === JSON.stringify(source.identity)
  && decoded.archive.entries.length === source.entries.length
  && decoded.archive.entries.every((value, index) => value.id === source.entries[index].id
    && value.path === source.entries[index].path && value.hash === source.entries[index].hash
    && equalBytes(value.bytes, source.entries[index].bytes)),
"archive round-trip changed identity or AssetBundle-compatible entries");
assert(equalBytes(encodeBiomeContentArtifact(decoded.archive), first),
  "decoded AssetBundle-compatible archive did not re-encode canonically");
assert(decoded.metadata.artifactType === BIOME_CONTENT_ARTIFACT_TYPE
  && decoded.metadata.mediaType === BIOME_CONTENT_ARTIFACT_MEDIA_TYPE
  && decoded.metadata.contentHash === vectorHash
  && decoded.metadata.entryBytes === source.entries.reduce((sum, value) => sum + value.bytes.length, 0)
  && decoded.metadata.storage === "owned-asset-bundle-copies",
"archive metadata is incomplete or inconsistent");
assert(Object.isFrozen(decoded) && Object.isFrozen(decoded.archive) && Object.isFrozen(decoded.archive.identity)
  && Object.isFrozen(decoded.archive.entries) && decoded.archive.entries.every(Object.isFrozen),
"decoded archive ownership envelope is not immutable");
assert(typeof compiler.encodeBiomeContentArtifact === "function"
  && compiler.BIOME_CONTENT_ARTIFACT_TYPE === BIOME_CONTENT_ARTIFACT_TYPE,
"compiler barrel does not export the biome content artifact codec");

// Encoding and decoding never retain caller or artifact storage.
source.entries[0].bytes[0] ^= 1;
assert(decodeBiomeContentArtifact(first).archive.entries[0].bytes[0] !== source.entries[0].bytes[0],
  "encode retained caller entry storage");
source.entries[0].bytes[0] ^= 1;
const decodedByte = decoded.archive.entries[2].bytes[0];
first[first.length - 1] ^= 1;
assert(decoded.archive.entries[2].bytes[0] === decodedByte, "decode retained a view into archive storage");
first[first.length - 1] ^= 1;
assert(decoded.archive.entries.every((value) => value.bytes.byteOffset === 0
  && value.bytes.byteLength === value.bytes.buffer.byteLength),
"decoded entries do not own complete ArrayBuffers");

const corrupt = (mutate: (copy: Uint8Array, data: DataView) => void): Uint8Array => {
  const copy = first.slice();
  mutate(copy, new DataView(copy.buffer));
  return copy;
};
function resign(bytes: Uint8Array): Uint8Array {
  const material = bytes.slice();
  material.fill(0, 144, 176);
  const digest = sha256(material);
  for (let index = 0; index < 32; index++) bytes[144 + index] = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

rejects(() => decodeBiomeContentArtifact(corrupt((copy) => { copy[0] ^= 0xff; })), /magic/, "corrupt magic was accepted");
rejects(() => decodeBiomeContentArtifact(corrupt((_copy, data) => data.setUint16(8, 2, true))), /version/, "unsupported version was accepted");
rejects(() => decodeBiomeContentArtifact(corrupt((_copy, data) => data.setUint32(12, first.length - 1, true))), /byte length/, "lying byte length was accepted");
rejects(() => decodeBiomeContentArtifact(corrupt((copy) => { copy[36] = 1; })), /reserved/, "nonzero reserved header was accepted");
rejects(() => decodeBiomeContentArtifact(corrupt((copy) => { copy[48] ^= 1; })), /integrity hash mismatch/, "closure identity tamper was accepted");
rejects(() => decodeBiomeContentArtifact(corrupt((copy) => { copy[copy.length - 1] ^= 1; })), /integrity hash mismatch/, "asset data tamper was accepted");
rejects(() => decodeBiomeContentArtifact(first.slice(0, -1)), /byte length/, "truncation was accepted");
const trailing = new Uint8Array(first.length + 1); trailing.set(first);
rejects(() => decodeBiomeContentArtifact(trailing), /byte length/, "trailing archive data was accepted");
const slicedStorage = new Uint8Array(first.length + 2); slicedStorage.set(first, 1);
rejects(() => decodeBiomeContentArtifact(slicedStorage.subarray(1, first.length + 1)), /owned Uint8Array/, "subarray-backed archive was accepted");
const unsafeBinary = corrupt((copy, data) => { copy[data.getUint32(20, true) + 48] = 0x2f; });
rejects(() => decodeBiomeContentArtifact(resign(unsafeBinary)), /invalid|unsafe path segment/,
  "integrity-valid binary containing an unsafe asset id was accepted");
const wrongAssetHash = corrupt((copy, data) => {
  const tableOffset = data.getUint32(20, true);
  copy[tableOffset + 16] ^= 1;
});
rejects(() => decodeBiomeContentArtifact(resign(wrongAssetHash)), /asset content hash mismatch/,
  "integrity-valid binary with the wrong engine asset hash was accepted");
const noncanonicalLayout = corrupt((_copy, data) => data.setUint32(28, data.getUint32(28, true) + 8, true));
rejects(() => decodeBiomeContentArtifact(resign(noncanonicalLayout)), /layout is non-canonical/,
  "integrity-valid noncanonical table layout was accepted");

// Exact record validation never invokes accessors and rejects sparse/unsafe/ambiguous inputs.
let getterInvoked = false;
const accessorEntry = entry("a.bin", new Uint8Array([1]));
Object.defineProperty(accessorEntry, "id", { enumerable: true, get() { getterInvoked = true; return "a.bin"; } });
rejects(() => encodeBiomeContentArtifact(archive([accessorEntry])), /enumerable data field/,
  "accessor-backed archive entry was accepted");
assert(!getterInvoked, "archive validation invoked an accessor");
rejects(() => encodeBiomeContentArtifact({ ...archive(), renderer: {} }), /unknown field/, "unknown archive root field was accepted");
rejects(() => encodeBiomeContentArtifact({ ...archive(), identity: { ...archive().identity, extra: true } }), /unknown field/,
  "unknown archive identity field was accepted");
rejects(() => encodeBiomeContentArtifact(archive([{ ...entry("a.bin", new Uint8Array([1])), extra: true }])), /unknown field/,
  "unknown archive entry field was accepted");
const sparse = new Array(2); sparse[1] = entry("b.bin", new Uint8Array([2]));
rejects(() => encodeBiomeContentArtifact(archive(sparse as ReturnType<typeof entry>[])), /dense standard array/,
  "sparse archive entries were accepted");
rejects(() => encodeBiomeContentArtifact(archive([])), /must not be empty/, "empty content archive was accepted");
rejects(() => encodeBiomeContentArtifact(archive([entry("../escape", new Uint8Array([1]))])), /unsafe path segment/,
  "unsafe asset id was accepted");
rejects(() => encodeBiomeContentArtifact(archive([{ ...entry("safe.bin", new Uint8Array([1])), path: "assets/other.bin" }])), /must be/,
  "noncanonical AssetBundle path was accepted");
rejects(() => encodeBiomeContentArtifact(archive([
  entry("b.bin", new Uint8Array([2])), entry("a.bin", new Uint8Array([1])),
])), /strictly id-sorted/, "unsorted archive entries were silently canonicalized");
rejects(() => encodeBiomeContentArtifact(archive([
  entry("a.bin", new Uint8Array([1])), entry("a.bin", new Uint8Array([1])),
])), /strictly id-sorted/, "duplicate asset ids were accepted");
rejects(() => encodeBiomeContentArtifact(archive([{ ...entry("a.bin", new Uint8Array([1])), hash: HASH_A }])), /asset content hash mismatch/,
  "entry hash not produced by the engine asset mapping was accepted");
const backing = new Uint8Array([0, 1, 2]);
rejects(() => encodeBiomeContentArtifact(archive([{ ...entry("a.bin", new Uint8Array([1])), bytes: backing.subarray(1, 2) }])), /owned Uint8Array/,
  "subarray-backed entry bytes were accepted");
rejects(() => encodeBiomeContentArtifact(archive(), { shouldCancel: () => true }), /cancelled/, "pre-cancelled encode continued");
rejects(() => decodeBiomeContentArtifact(second, { shouldCancel: () => true }), /cancelled/, "pre-cancelled decode continued");

const tooMany = new Array(MAX_BIOME_CONTENT_ARTIFACT_ENTRIES + 1).fill(entry("a.bin", new Uint8Array([1])));
rejects(() => encodeBiomeContentArtifact(archive(tooMany)), /at most/, "entry count above the declared cap was accepted");
const manyEntries = Array.from({ length: 100 }, (_, index) => {
  const id = `content/${index.toString().padStart(3, "0")}.bin`;
  return entry(id, new Uint8Array([index]));
});
let encodeChecks = 0;
rejects(() => encodeBiomeContentArtifact(archive(manyEntries), { shouldCancel: () => ++encodeChecks >= 6 }), /cancelled/,
  "mid-encode cancellation was not observed");
assert(encodeChecks >= 6, "mid-encode cancellation checkpoint count was not reached");
const manyArtifact = encodeBiomeContentArtifact(archive(manyEntries));
let decodeChecks = 0;
rejects(() => decodeBiomeContentArtifact(manyArtifact, { shouldCancel: () => ++decodeChecks >= 6 }), /cancelled/,
  "mid-decode cancellation was not observed");
assert(decodeChecks >= 6 && new BiomeContentArtifactCancelledError().name === "BiomeContentArtifactCancelledError",
  "decode cancellation or cancellation error contract changed");

console.log(`p_biome_content_artifact OK: ${second.length}B vector ${vectorHash}; canonical global AssetBundle archive, closure identity, engine hashes, ownership, hostile shape/integrity/layout rejection, caps, cancellation`);
