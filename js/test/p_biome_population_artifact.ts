import {
  BIOME_POPULATION_ARTIFACT_HEADER_BYTES,
  BIOME_POPULATION_ARTIFACT_MEDIA_TYPE,
  BIOME_POPULATION_ARTIFACT_SCHEMA,
  BIOME_POPULATION_ARTIFACT_TYPE,
  BIOME_POPULATION_ARTIFACT_VERSION,
  MAX_BIOME_POPULATION_ARTIFACT_BYTES,
  MAX_BIOME_POPULATION_ARTIFACT_PLACEMENTS,
  BiomePopulationArtifactCancelledError,
  biomePopulationArtifactContentHash,
  decodeBiomePopulationArtifact,
  encodeBiomePopulationArtifact,
} from "../src/world/compiler/biome-population-artifact.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_biome_population_artifact FAIL: ${message}`);
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

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const HASH_D = `sha256:${"d".repeat(64)}`;

function placement(overrides: Record<string, unknown> = {}) {
  return {
    role: "flora/oak", assetId: "biomes/lush/oak-descriptor.json", contentHash: HASH_C,
    x: -47.5, y: 8.25, z: 12.75, yaw: 0.5, scale: 1.125, pageX: -1, pageZ: 0,
    ...overrides,
  };
}
function plan(placements = [
  placement(),
  placement({ x: 2.5, z: -4.75, yaw: Math.PI, pageX: 0, pageZ: -1 }),
  placement({ role: "flora/grass", assetId: "biomes/lush/grass-descriptor.json", contentHash: HASH_D,
    x: 19, y: 7, z: 23, yaw: 0, scale: 0.8, pageX: 0, pageZ: 0 }),
]) {
  return {
    schema: BIOME_POPULATION_ARTIFACT_SCHEMA,
    coord: { tx: -7, tz: 9, lod: 2 },
    identity: { fieldContentHash: HASH_A, runtimePackContentHash: HASH_B },
    placements,
  };
}

const source = plan();
const first = encodeBiomePopulationArtifact(source);
const second = encodeBiomePopulationArtifact(source);
assert(equalBytes(first, second), "same chunk plan did not encode byte-identically");
assert(first.length <= MAX_BIOME_POPULATION_ARTIFACT_BYTES, "representative artifact exceeded its declared byte cap");
const vectorHash = biomePopulationArtifactContentHash(first);
const EXPECTED_VECTOR_HASH = "sha256:8e8b6a20bb6b85cdc6ceaacd555dc38c15ffef56fe31e9286211b1295c9b971f";
assert(vectorHash === EXPECTED_VECTOR_HASH, `canonical portable vector changed: ${vectorHash}`);

const view = new DataView(first.buffer);
assert(view.getUint16(8, true) === BIOME_POPULATION_ARTIFACT_VERSION
  && view.getUint16(10, true) === BIOME_POPULATION_ARTIFACT_HEADER_BYTES
  && view.getUint32(12, true) === first.length
  && view.getInt32(16, true) === -7 && view.getInt32(20, true) === 9 && view.getUint16(24, true) === 2
  && view.getUint32(28, true) === 3 && view.getUint32(32, true) === 2,
"fixed little-endian header fields are incorrect");

const decoded = decodeBiomePopulationArtifact(first);
assert(JSON.stringify(decoded.plan) === JSON.stringify(source), "chunk plan round-trip changed semantic data");
assert(decoded.metadata.artifactType === BIOME_POPULATION_ARTIFACT_TYPE
  && decoded.metadata.mediaType === BIOME_POPULATION_ARTIFACT_MEDIA_TYPE
  && decoded.metadata.contentHash === vectorHash
  && decoded.metadata.storage === "owned-object-and-array-copies",
"artifact metadata is incomplete or inconsistent");
assert(Object.isFrozen(decoded) && Object.isFrozen(decoded.metadata) && Object.isFrozen(decoded.plan)
  && Object.isFrozen(decoded.plan.coord) && Object.isFrozen(decoded.plan.identity)
  && Object.isFrozen(decoded.plan.placements) && decoded.plan.placements.every(Object.isFrozen),
"decoded object/array ownership envelope is not immutable");

// Encoding and decoding own their data rather than retaining mutable caller storage.
source.placements[0].x = 999;
assert(decodeBiomePopulationArtifact(first).plan.placements[0].x === -47.5, "encode retained caller placement objects");
const decodedBeforeMutation = decoded.plan.placements[2].scale;
first[first.length - 1] ^= 1;
assert(decoded.plan.placements[2].scale === decodedBeforeMutation, "decode retained a view into artifact bytes");
first[first.length - 1] ^= 1;

// Empty chunks are valid and preserve both source identities.
const empty = decodeBiomePopulationArtifact(encodeBiomePopulationArtifact(plan([]))).plan;
assert(empty.placements.length === 0 && empty.identity.fieldContentHash === HASH_A
  && empty.identity.runtimePackContentHash === HASH_B, "empty chunk or identity hashes did not round-trip");

const corrupt = (mutate: (copy: Uint8Array, data: DataView) => void): Uint8Array => {
  const copy = first.slice();
  mutate(copy, new DataView(copy.buffer));
  return copy;
};
rejects(() => decodeBiomePopulationArtifact(corrupt((copy) => { copy[0] ^= 0xff; })), /magic/, "corrupt magic was accepted");
rejects(() => decodeBiomePopulationArtifact(corrupt((_copy, data) => data.setUint16(8, 2, true))), /version/, "unsupported version was accepted");
rejects(() => decodeBiomePopulationArtifact(corrupt((_copy, data) => data.setUint32(12, first.length - 1, true))), /byte length/, "lying byte length was accepted");
rejects(() => decodeBiomePopulationArtifact(corrupt((copy) => { copy[144] = 1; })), /reserved/, "nonzero reserved header was accepted");
rejects(() => decodeBiomePopulationArtifact(corrupt((copy) => { copy[48] ^= 1; })), /integrity hash mismatch/, "identity tamper was accepted");
rejects(() => decodeBiomePopulationArtifact(corrupt((copy) => { copy[copy.length - 1] ^= 1; })), /integrity hash mismatch/, "placement tamper was accepted");
rejects(() => decodeBiomePopulationArtifact(first.slice(0, -1)), /byte length/, "truncation was accepted");
const trailing = new Uint8Array(first.length + 1); trailing.set(first);
rejects(() => decodeBiomePopulationArtifact(trailing), /byte length/, "trailing data was accepted");
const slicedStorage = new Uint8Array(first.length + 2); slicedStorage.set(first, 1);
rejects(() => decodeBiomePopulationArtifact(slicedStorage.subarray(1, first.length + 1)), /owned Uint8Array/, "subarray-backed bytes were accepted");

// Exact record validation never invokes accessors and rejects unknown/non-data fields.
let getterInvoked = false;
const accessorPlacement = placement();
Object.defineProperty(accessorPlacement, "role", { enumerable: true, get() { getterInvoked = true; return "flora/oak"; } });
rejects(() => encodeBiomePopulationArtifact(plan([accessorPlacement])), /enumerable data field/, "accessor-backed descriptor was accepted");
assert(!getterInvoked, "descriptor validation invoked an accessor");
rejects(() => encodeBiomePopulationArtifact(plan([{ ...placement(), renderer: {} }])), /unknown field/, "renderer-bearing descriptor was accepted");
rejects(() => encodeBiomePopulationArtifact({ ...plan(), extra: true }), /unknown field/, "unknown root field was accepted");
const sparse = new Array(2); sparse[1] = placement();
rejects(() => encodeBiomePopulationArtifact(plan(sparse as ReturnType<typeof placement>[])), /dense standard array/, "sparse placement array was accepted");
rejects(() => encodeBiomePopulationArtifact(plan([placement({ assetId: "../escape" })])), /assetId is invalid/, "unsafe descriptor asset id was accepted");
rejects(() => encodeBiomePopulationArtifact(plan([placement({ contentHash: `sha256:${"A".repeat(64)}` })])), /canonical content hash/, "noncanonical hash was accepted");
rejects(() => encodeBiomePopulationArtifact(plan([placement({ x: Number.NaN })])), /canonical number/, "NaN position was accepted");
rejects(() => encodeBiomePopulationArtifact(plan([placement({ yaw: -0 })])), /canonical number/, "negative-zero yaw was accepted");
rejects(() => encodeBiomePopulationArtifact(plan([placement({ scale: 0 })])), /canonical number|positive/, "zero scale was accepted");
rejects(() => encodeBiomePopulationArtifact(plan([placement({ pageX: 1.5 })])), /integer/, "fractional page coordinate was accepted");

const overCap = Array.from({ length: MAX_BIOME_POPULATION_ARTIFACT_PLACEMENTS + 1 }, () => placement());
rejects(() => encodeBiomePopulationArtifact(plan(overCap)), /at most/, "placement count above the declared cap was accepted");
const maximum = encodeBiomePopulationArtifact(plan(overCap.slice(0, -1)));
assert(maximum.length <= MAX_BIOME_POPULATION_ARTIFACT_BYTES
  && decodeBiomePopulationArtifact(maximum).plan.placements.length === MAX_BIOME_POPULATION_ARTIFACT_PLACEMENTS,
"maximum valid placement count did not round-trip within the byte budget");

rejects(() => encodeBiomePopulationArtifact(plan(), { shouldCancel: () => true }), /cancelled/, "pre-cancelled encode continued");
rejects(() => decodeBiomePopulationArtifact(second, { shouldCancel: () => true }), /cancelled/, "pre-cancelled decode continued");
const many = plan(Array.from({ length: 3_000 }, (_, index) => placement({ x: index % 1000, z: Math.floor(index / 1000), pageX: index % 21 })));
let checks = 0;
rejects(() => encodeBiomePopulationArtifact(many, { shouldCancel: () => ++checks >= 3 }), /cancelled/, "mid-encode cancellation was not observed");
assert(checks >= 3, "bounded cancellation checkpoint count was not reached");
assert(new BiomePopulationArtifactCancelledError().name === "BiomePopulationArtifactCancelledError", "cancellation error contract changed");

console.log(`p_biome_population_artifact OK: ${second.length}B vector ${vectorHash}; deterministic LE descriptor interning, identity binding, ownership, strict shapes, integrity/trailing rejection, caps, cancellation`);
