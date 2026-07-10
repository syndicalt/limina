import {
  MAX_TERRAIN_ARTIFACT_COLS,
  MAX_TERRAIN_ARTIFACT_ORIGIN_ABS_M,
  MAX_TERRAIN_ARTIFACT_ROWS,
  MAX_TERRAIN_ARTIFACT_SCALE_M,
  MAX_TERRAIN_CHUNK_ARTIFACT_BYTES,
  TERRAIN_ARTIFACT_FLAG_BLIGHT,
  TERRAIN_ARTIFACT_FLAG_CLIMATE,
  TERRAIN_ARTIFACT_FLAG_PAINT_MAT,
  TERRAIN_ARTIFACT_FLAG_PAINT_WEIGHT,
  TERRAIN_CHUNK_ARTIFACT_HEADER_BYTES,
  decodeTerrainChunkArtifact,
  encodeTerrainChunkArtifact,
} from "../src/world/compiler/terrain-artifact.mjs";
import { derivedArtifactContentHash } from "../src/world/compiler/manifest.mjs";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_terrain_artifact FAIL: ${message}`);
}

function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

function makeTile(nrows = 3, ncols = 3, channels = 0b1111) {
  const cells = nrows * ncols;
  const heights = new Float32Array(cells);
  for (let index = 0; index < cells; index++) heights[index] = (index % 17) / 16;
  const tile: {
    nrows: number;
    ncols: number;
    origin: [number, number, number];
    scale: [number, number, number];
    heights: Float32Array;
    paintMat?: Uint8Array;
    paintW?: Float32Array;
    climate?: Float32Array;
    climateChannels?: number;
    blight?: Float32Array;
  } = {
    nrows,
    ncols,
    origin: [-128.25, 12.5, 64.75],
    scale: [256, 80, 256],
    heights,
  };
  if ((channels & TERRAIN_ARTIFACT_FLAG_PAINT_MAT) !== 0) {
    tile.paintMat = new Uint8Array(cells);
    for (let index = 0; index < cells; index++) tile.paintMat[index] = index % 5;
  }
  if ((channels & TERRAIN_ARTIFACT_FLAG_PAINT_WEIGHT) !== 0) {
    tile.paintW = new Float32Array(cells);
    for (let index = 0; index < cells; index++) tile.paintW[index] = (index % 9) / 8;
  }
  if ((channels & TERRAIN_ARTIFACT_FLAG_CLIMATE) !== 0) {
    tile.climateChannels = 3;
    tile.climate = new Float32Array(cells * 3);
    for (let index = 0; index < cells; index++) {
      tile.climate[index * 3] = -20 + (index % 70);
      tile.climate[index * 3 + 1] = 50 + (index % 2000);
      tile.climate[index * 3 + 2] = index % 7;
    }
  }
  if ((channels & TERRAIN_ARTIFACT_FLAG_BLIGHT) !== 0) {
    tile.blight = new Float32Array(cells);
    for (let index = 0; index < cells; index++) tile.blight[index] = (index % 5) / 4;
  }
  return tile;
}

function copyBytes(bytes: Uint8Array): Uint8Array { return new Uint8Array(bytes); }
const now = (): number => globalThis.performance?.now() ?? Date.now();

const runtimeProcess = (globalThis as unknown as {
  process?: { memoryUsage?: () => { rss: number } };
}).process;
function residentBytes(): number | null {
  const rss = runtimeProcess?.memoryUsage?.().rss;
  return typeof rss === "number" && Number.isFinite(rss) ? rss : null;
}

function withDataView(bytes: Uint8Array, edit: (view: DataView) => void): Uint8Array {
  const copy = copyBytes(bytes);
  edit(new DataView(copy.buffer, copy.byteOffset, copy.byteLength));
  return copy;
}

// Every independent optional-channel combination accepted by TerrainTile must round-trip.
for (let mask = 0; mask <= 0b1111; mask++) {
  const tile = makeTile(3, 5, mask);
  const first = encodeTerrainChunkArtifact(tile);
  const decoded = decodeTerrainChunkArtifact(first);
  const second = encodeTerrainChunkArtifact(decoded.tile);
  assert(bytesEqual(first, second), `optional mask ${mask.toString(2).padStart(4, "0")} was not byte-stable`);
  assert(decoded.metadata.channels.paintMat === ((mask & TERRAIN_ARTIFACT_FLAG_PAINT_MAT) !== 0), `mask ${mask} paintMat flag changed`);
  assert(decoded.metadata.channels.paintW === ((mask & TERRAIN_ARTIFACT_FLAG_PAINT_WEIGHT) !== 0), `mask ${mask} paintW flag changed`);
  assert(decoded.metadata.channels.climate === ((mask & TERRAIN_ARTIFACT_FLAG_CLIMATE) !== 0), `mask ${mask} climate flag changed`);
  assert(decoded.metadata.channels.blight === ((mask & TERRAIN_ARTIFACT_FLAG_BLIGHT) !== 0), `mask ${mask} blight flag changed`);
  assert(decoded.metadata.byteLength === first.byteLength && decoded.metadata.offsets.end === first.byteLength, `mask ${mask} byte layout is not exact`);
}

// Format-vector proof: this constant must match in Node and in the Limina native host.
const vectorTile = makeTile(2, 2, 0b1111);
vectorTile.origin = [-12.5, 3, 7.25];
vectorTile.scale = [10, 20, 30];
vectorTile.heights.set([0, 0.25, 0.5, 1]);
vectorTile.paintMat!.set([0, 1, 2, 4]);
vectorTile.paintW!.set([0, 0.25, 0.75, 1]);
vectorTile.climate!.set([-5, 100, 0, 10, 400, 1, 20, 800, 4, 35, 1200, 5]);
vectorTile.blight!.set([0, 0.25, 0.5, 1]);
const vectorBytes = encodeTerrainChunkArtifact(vectorTile);
const vectorHash = derivedArtifactContentHash(vectorBytes);
const EXPECTED_VECTOR_HASH = "sha256:569cbb62626166528183e8533c9561a53f0d5a6beeb3ea0c9c9c14e81cb785cb";
assert(vectorHash === EXPECTED_VECTOR_HASH, `portable format vector changed: ${vectorHash}`);
assert(bytesEqual(vectorBytes, encodeTerrainChunkArtifact(decodeTerrainChunkArtifact(vectorBytes).tile)), "known format vector was not encode-decode stable");

const vectorHeaderHex = Array.from(vectorBytes.subarray(0, 32), (value) => value.toString(16).padStart(2, "0")).join("");
assert(
  vectorHeaderHex === "4c4d544552524e0001000f0050000300b4000000020002000400000000000000",
  `little-endian header vector changed: ${vectorHeaderHex}`,
);

// Decoding uses owned copies and is safe for arbitrarily aligned Uint8Array slices.
const misalignedStorage = new Uint8Array(vectorBytes.length + 3);
misalignedStorage.set(vectorBytes, 1);
const misaligned = misalignedStorage.subarray(1, vectorBytes.length + 1);
const owned = decodeTerrainChunkArtifact(misaligned);
const originalHeight = owned.tile.heights[0];
misaligned[TERRAIN_CHUNK_ARTIFACT_HEADER_BYTES] ^= 0xff;
assert(Object.is(owned.tile.heights[0], originalHeight), "decoded heights retained a view into caller-owned artifact bytes");
assert(
  Object.isFrozen(owned) && Object.isFrozen(owned.metadata) && Object.isFrozen(owned.metadata.channels)
    && Object.isFrozen(owned.metadata.offsets) && Object.isFrozen(owned.tile)
    && Object.isFrozen(owned.tile.origin) && Object.isFrozen(owned.tile.scale),
  "decoded metadata and tile envelope are not immutable",
);
assert(owned.metadata.storage === "owned-channel-copies", "decode ownership contract is not explicit");
const encodeIsolationTile = makeTile(3, 3, 0b1111);
const isolatedArtifact = encodeTerrainChunkArtifact(encodeIsolationTile);
const isolatedHeight = decodeTerrainChunkArtifact(isolatedArtifact).tile.heights[0];
encodeIsolationTile.heights[0] = 1;
encodeIsolationTile.paintMat![0] = 4;
assert(
  Object.is(decodeTerrainChunkArtifact(isolatedArtifact).tile.heights[0], isolatedHeight),
  "encoded artifact retained mutable caller channel storage",
);

// The minimum and maximum supported dimensions are real codec boundaries.
const minimum = encodeTerrainChunkArtifact(makeTile(2, 2, 0));
assert(decodeTerrainChunkArtifact(minimum).metadata.cells === 4, "minimum 2x2 artifact did not round-trip");
const maximumTile = makeTile(MAX_TERRAIN_ARTIFACT_ROWS, MAX_TERRAIN_ARTIFACT_COLS, 0b1111);
const maximumRssBefore = residentBytes();
const maximumEncodeStart = now();
const maximum = encodeTerrainChunkArtifact(maximumTile);
const maximumEncodeMs = now() - maximumEncodeStart;
const maximumDecodeStart = now();
const maximumDecoded = decodeTerrainChunkArtifact(maximum);
const maximumDecodeMs = now() - maximumDecodeStart;
const maximumRssAfter = residentBytes();
const maximumRssDelta = maximumRssBefore === null || maximumRssAfter === null
  ? null
  : Math.max(0, maximumRssAfter - maximumRssBefore);
assert(maximumDecoded.metadata.cells === MAX_TERRAIN_ARTIFACT_ROWS * MAX_TERRAIN_ARTIFACT_COLS, "maximum artifact cell count changed");
assert(maximum.length <= MAX_TERRAIN_CHUNK_ARTIFACT_BYTES, "maximum valid artifact exceeds its declared resource bound");
rejects(() => encodeTerrainChunkArtifact(makeTile(1, 2, 0)), /nrows/, "row lower bound was not enforced");
rejects(() => encodeTerrainChunkArtifact(makeTile(MAX_TERRAIN_ARTIFACT_ROWS + 1, 2, 0)), /nrows/, "row upper bound was not enforced");
rejects(() => encodeTerrainChunkArtifact(makeTile(2, 1, 0)), /ncols/, "column lower bound was not enforced");
rejects(() => encodeTerrainChunkArtifact(makeTile(2, MAX_TERRAIN_ARTIFACT_COLS + 1, 0)), /ncols/, "column upper bound was not enforced");
const coordinateBoundary = makeTile(2, 2, 0);
coordinateBoundary.origin = [-MAX_TERRAIN_ARTIFACT_ORIGIN_ABS_M, MAX_TERRAIN_ARTIFACT_ORIGIN_ABS_M, 0];
coordinateBoundary.scale = [MAX_TERRAIN_ARTIFACT_SCALE_M, 1, MAX_TERRAIN_ARTIFACT_SCALE_M];
assert(decodeTerrainChunkArtifact(encodeTerrainChunkArtifact(coordinateBoundary)).tile.origin[0] === -MAX_TERRAIN_ARTIFACT_ORIGIN_ABS_M, "world coordinate boundary did not round-trip");
const excessiveOrigin = makeTile(2, 2, 0);
excessiveOrigin.origin[0] = MAX_TERRAIN_ARTIFACT_ORIGIN_ABS_M + 1;
rejects(() => encodeTerrainChunkArtifact(excessiveOrigin), /absolute value/, "origin beyond downstream-safe bound was accepted");
const excessiveScale = makeTile(2, 2, 0);
excessiveScale.scale[2] = MAX_TERRAIN_ARTIFACT_SCALE_M + 1;
rejects(() => encodeTerrainChunkArtifact(excessiveScale), /must be <=/, "scale beyond downstream-safe bound was accepted");

// Adjacent chunks preserve exactly equal shared edge samples after independent round-trips.
const left = makeTile(5, 5, 0);
const right = makeTile(5, 5, 0);
left.origin = [-128, 0, 0];
right.origin = [128, 0, 0];
for (let row = 0; row < 5; row++) {
  const shared = Math.fround((row + 1) / 8);
  left.heights[row * 5 + 4] = shared;
  right.heights[row * 5] = shared;
}
const leftDecoded = decodeTerrainChunkArtifact(encodeTerrainChunkArtifact(left)).tile;
const rightDecoded = decodeTerrainChunkArtifact(encodeTerrainChunkArtifact(right)).tile;
for (let row = 0; row < 5; row++) {
  assert(Object.is(leftDecoded.heights[row * 5 + 4], rightDecoded.heights[row * 5]), `shared seam diverged at row ${row}`);
}

// Content addressing binds exact artifact bytes and changes on a semantic mutation.
const hashBefore = derivedArtifactContentHash(vectorBytes);
const changedTile = makeTile(2, 2, 0b1111);
changedTile.origin = [-12.5, 3, 7.25];
changedTile.scale = [10, 20, 30];
changedTile.heights.set([0, 0.25, 0.5, 1]);
changedTile.paintMat!.set([0, 1, 3, 4]);
changedTile.paintW!.set([0, 0.25, 0.75, 1]);
changedTile.climate!.set(vectorTile.climate!);
changedTile.blight!.set(vectorTile.blight!);
assert(derivedArtifactContentHash(encodeTerrainChunkArtifact(changedTile)) !== hashBefore, "paint mutation did not change derived content hash");

// Input structure and typed-array validation fail closed rather than silently reinterpreting data.
const malformedTyped = makeTile();
malformedTyped.heights = new Float64Array(9) as unknown as Float32Array;
rejects(() => encodeTerrainChunkArtifact(malformedTyped), /Float32Array/, "Float64 heights were accepted");
const malformedArray = makeTile();
malformedArray.paintW = new Array(9).fill(0) as unknown as Float32Array;
rejects(() => encodeTerrainChunkArtifact(malformedArray), /Float32Array/, "plain-array paint weights were accepted");
const sparseOrigin = makeTile();
delete sparseOrigin.origin[1];
rejects(() => encodeTerrainChunkArtifact(sparseOrigin), /sparse/, "sparse origin was accepted");
const climateWithoutCount = makeTile();
delete climateWithoutCount.climateChannels;
rejects(() => encodeTerrainChunkArtifact(climateWithoutCount), /climateChannels/, "climate without its channel count was accepted");
const wrongClimateCount = makeTile();
wrongClimateCount.climateChannels = 4;
rejects(() => encodeTerrainChunkArtifact(wrongClimateCount), /must equal 3/, "wrong climate channel count was accepted");
const wrongClimateLength = makeTile();
wrongClimateLength.climate = new Float32Array(26);
rejects(() => encodeTerrainChunkArtifact(wrongClimateLength), /climate length/, "wrong climate payload length was accepted");
const extraField = { ...makeTile(), transient: true };
rejects(() => encodeTerrainChunkArtifact(extraField), /unsupported field/, "unknown lossy tile field was ignored");
const accessorTile = makeTile();
Object.defineProperty(accessorTile, "nrows", { enumerable: true, get: () => 3 });
rejects(() => encodeTerrainChunkArtifact(accessorTile), /data field/, "accessor-backed tile field was accepted");
if (typeof SharedArrayBuffer === "function") {
  const sharedTile = makeTile();
  sharedTile.heights = new Float32Array(new SharedArrayBuffer(9 * 4));
  rejects(() => encodeTerrainChunkArtifact(sharedTile), /SharedArrayBuffer/, "concurrently mutable height storage was accepted");
}

for (const [mutate, pattern, label] of [
  [(tile: ReturnType<typeof makeTile>) => { tile.heights[0] = Number.NaN; }, /finite/, "NaN height"],
  [(tile: ReturnType<typeof makeTile>) => { tile.heights[0] = -0; }, /negative zero/, "negative-zero height"],
  [(tile: ReturnType<typeof makeTile>) => { tile.heights[0] = 1.01; }, /\[0, 1\]/, "height above one"],
  [(tile: ReturnType<typeof makeTile>) => { tile.paintMat![0] = 7; }, /paintMat/, "unknown material id"],
  [(tile: ReturnType<typeof makeTile>) => { tile.paintW![0] = -0.1; }, /\[0, 1\]/, "negative paint weight"],
  [(tile: ReturnType<typeof makeTile>) => { tile.climate![0] = Number.POSITIVE_INFINITY; }, /finite/, "infinite climate value"],
  [(tile: ReturnType<typeof makeTile>) => { tile.climate![2] = 1.5; }, /biome/, "fractional biome"],
  [(tile: ReturnType<typeof makeTile>) => { tile.blight![0] = 2; }, /\[0, 1\]/, "blight above one"],
  [(tile: ReturnType<typeof makeTile>) => { tile.origin[0] = -0; }, /negative zero/, "negative-zero origin"],
  [(tile: ReturnType<typeof makeTile>) => { tile.scale[1] = 0; }, /> 0/, "zero scale"],
] as const) {
  const tile = makeTile();
  mutate(tile);
  rejects(() => encodeTerrainChunkArtifact(tile), pattern, `${label} was accepted by encoder`);
}

// Header corruption, truncation, extension, and non-canonical padding all reject.
const valid = encodeTerrainChunkArtifact(makeTile());
const validDecoded = decodeTerrainChunkArtifact(valid);
const offsets = validDecoded.metadata.offsets;
const corruptCases: Array<[Uint8Array, RegExp, string]> = [
  [withDataView(valid, (view) => view.setUint8(0, 0)), /magic/, "magic"],
  [withDataView(valid, (view) => view.setUint16(8, 2, true)), /version/, "version"],
  [withDataView(valid, (view) => view.setUint16(10, 0x800f, true)), /unknown flags/, "reserved flag"],
  [withDataView(valid, (view) => view.setUint16(12, 76, true)), /header length/, "header length"],
  [withDataView(valid, (view) => view.setUint16(14, 2, true)), /channel-count/, "climate channel count"],
  [withDataView(valid, (view) => view.setUint32(16, valid.length - 1, true)), /byte length/, "declared byte length"],
  [withDataView(valid, (view) => view.setUint16(20, 1, true)), /nrows/, "rows"],
  [withDataView(valid, (view) => view.setUint16(22, 1, true)), /ncols/, "columns"],
  [withDataView(valid, (view) => view.setUint32(24, 8, true)), /cell count/, "cell count"],
  [withDataView(valid, (view) => view.setUint32(28, 1, true)), /reserved/, "reserved bytes"],
  [withDataView(valid, (view) => view.setFloat64(32, Number.NaN, true)), /finite/, "NaN origin"],
  [withDataView(valid, (view) => view.setFloat64(32, MAX_TERRAIN_ARTIFACT_ORIGIN_ABS_M + 1, true)), /absolute value/, "excessive origin"],
  [withDataView(valid, (view) => view.setFloat64(56, -0, true)), /negative zero/, "negative-zero scale"],
  [withDataView(valid, (view) => view.setFloat64(56, MAX_TERRAIN_ARTIFACT_SCALE_M + 1, true)), /must be <=/, "excessive scale"],
  [withDataView(valid, (view) => view.setUint32(offsets.heights, 0x7fc00000, true)), /finite/, "NaN height payload"],
  [withDataView(valid, (view) => view.setUint32(offsets.heights, 0x80000000, true)), /negative zero/, "negative-zero height payload"],
  [withDataView(valid, (view) => view.setFloat32(offsets.heights, 2, true)), /\[0, 1\]/, "out-of-range height payload"],
  [withDataView(valid, (view) => view.setUint8(offsets.paintMat, 255)), /paintMat/, "paint material payload"],
  [withDataView(valid, (view) => view.setFloat32(offsets.paintW, -1, true)), /\[0, 1\]/, "paint weight payload"],
  [withDataView(valid, (view) => view.setFloat32(offsets.climate + 8, 2.5, true)), /biome/, "biome payload"],
  [withDataView(valid, (view) => view.setUint32(offsets.climate, 0x7f800000, true)), /finite/, "infinite climate payload"],
  [withDataView(valid, (view) => view.setFloat32(offsets.blight, 1.5, true)), /\[0, 1\]/, "blight payload"],
];
assert(offsets.paintMatPadding.byteLength > 0, "fixture does not exercise canonical paint alignment padding");
const nonzeroPadding = copyBytes(valid);
nonzeroPadding[offsets.paintMatPadding.offset] = 1;
corruptCases.push([nonzeroPadding, /padding/, "nonzero alignment padding"]);
for (const [bytes, pattern, label] of corruptCases) rejects(() => decodeTerrainChunkArtifact(bytes), pattern, `corrupt ${label} was accepted`);

rejects(() => decodeTerrainChunkArtifact(valid.subarray(0, valid.length - 1)), /byte length/, "truncated artifact was accepted");
const extended = new Uint8Array(valid.length + 1);
extended.set(valid);
rejects(() => decodeTerrainChunkArtifact(extended), /byte length/, "artifact with trailing byte was accepted");
const canonicallyExtended = withDataView(extended, (view) => view.setUint32(16, extended.length, true));
rejects(() => decodeTerrainChunkArtifact(canonicallyExtended), /canonical byte length/, "redeclared trailing byte was accepted");

// Representative build-path benchmark. It is informational, not a timing gate.
const representative = makeTile(65, 65, 0b1111);
const iterations = 40;
let checksum = 0;
const encodeStart = now();
let representativeBytes = new Uint8Array();
for (let iteration = 0; iteration < iterations; iteration++) {
  representativeBytes = encodeTerrainChunkArtifact(representative);
  checksum ^= representativeBytes[representativeBytes.length - 1];
}
const encodeMs = now() - encodeStart;
const decodeStart = now();
for (let iteration = 0; iteration < iterations; iteration++) {
  const decoded = decodeTerrainChunkArtifact(representativeBytes);
  checksum ^= decoded.tile.paintMat![iteration % decoded.tile.paintMat!.length];
}
const decodeMs = now() - decodeStart;

console.log(
  `p_terrain_artifact OK: v1 LE codec covers all 16 optional-channel combinations; 2x2..${MAX_TERRAIN_ARTIFACT_ROWS}x${MAX_TERRAIN_ARTIFACT_COLS}; `
  + `portable vector ${vectorHash}; exact lengths, owned decode copies, seams, hashes, malformed headers/payloads, bounds and canonical floats proven. `
  + `65x65 full tile ${representativeBytes.length} bytes: encode ${(encodeMs / iterations).toFixed(3)} ms, decode ${(decodeMs / iterations).toFixed(3)} ms avg `
  + `(O(cells * present channels) time and bytes). Max 257x257 full tile ${maximum.length} bytes: encode ${maximumEncodeMs.toFixed(3)} ms, `
  + `decode ${maximumDecodeMs.toFixed(3)} ms, process RSS delta ${maximumRssDelta === null ? "n/a on this host" : `${(maximumRssDelta / (1024 * 1024)).toFixed(2)} MiB`} `
  + `(artifact plus owned channel arrays; checksum ${checksum}).`,
);
