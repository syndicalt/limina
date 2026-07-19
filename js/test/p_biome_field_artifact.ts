import {
  BIOME_FIELD_ARTIFACT_HEADER_BYTES,
  BIOME_FIELD_ARTIFACT_MEDIA_TYPE,
  BIOME_FIELD_ARTIFACT_TYPE,
  BiomeFieldArtifactCancelledError,
  biomeFieldArtifactContentHash,
  decodeBiomeFieldArtifact,
  encodeBiomeFieldArtifact,
} from "../src/world/compiler/biome-field-artifact.mjs";
import { compileBiomeField } from "../src/world/biome-field.mjs";
import { BIOME_LIBRARY_V1 } from "../src/world/biome-library-v1.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_biome_field_artifact FAIL: ${message}`);
}
function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(`${error.name}: ${error.message}`), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function samples(rows: number, cols: number, varied = false) {
  const cells = rows * cols;
  const temperatureC = new Float32Array(cells);
  const moisture01 = new Float32Array(cells);
  const elevationM = new Float32Array(cells);
  const slope01 = new Float32Array(cells);
  const waterDistanceM = new Float32Array(cells);
  for (let index = 0; index < cells; index++) {
    temperatureC[index] = varied ? -20 + (index % cols) * 12 + Math.floor(index / cols) * 4 : 12;
    moisture01[index] = varied ? Math.min(1, 0.1 + (index % cols) * 0.2 + Math.floor(index / cols) * 0.1) : 0.55;
    elevationM[index] = index % 700;
    slope01[index] = (index % 10) / 10;
    waterDistanceM[index] = index % 200;
  }
  return { temperatureC, moisture01, elevationM, slope01, waterDistanceM };
}
function field(rows: number, cols: number, varied = false) {
  return compileBiomeField({
    pack: BIOME_LIBRARY_V1,
    grid: { origin: [-128.5, 64.25], rows, cols, cellSizeM: 2.5 },
    samples: samples(rows, cols, varied),
    influences: [],
    modifiers: [],
    topN: 4,
    climateFeather: { temperatureC: 6, moisture01: 0.2 },
  });
}

const source = field(2, 3, true);
const bytes = encodeBiomeFieldArtifact(source);
const bytesAgain = encodeBiomeFieldArtifact(source);
assert(equalBytes(bytes, bytesAgain), "same strict field did not encode byte-identically");
const hash = biomeFieldArtifactContentHash(bytes);
assert(source.pack.version === "1.0.1", `canonical vector pack version changed: ${source.pack.version}`);
assert(hash === "sha256:d3e619196d6fa5e6d2c6135886c98f4e3ec8169b07d74e708f9b4b3a38bca32a",
  `canonical codec vector hash changed: ${hash}`);
const decoded = decodeBiomeFieldArtifact(bytes);
assert(decoded.metadata.artifactType === BIOME_FIELD_ARTIFACT_TYPE
  && decoded.metadata.mediaType === BIOME_FIELD_ARTIFACT_MEDIA_TYPE
  && decoded.metadata.contentHash === hash,
"artifact metadata or content hash diverged from canonical bytes");
assert(decoded.field.pack.id === source.pack.id && decoded.field.pack.version === source.pack.version
  && JSON.stringify(decoded.field.grid) === JSON.stringify(source.grid)
  && JSON.stringify(decoded.field.biomeIds) === JSON.stringify(source.biomeIds)
  && equalBytes(new Uint8Array(decoded.field.indices.buffer), new Uint8Array(source.indices.buffer))
  && equalBytes(new Uint8Array(decoded.field.weights.buffer), new Uint8Array(source.weights.buffer)),
"roundtrip changed strict field metadata, ids, indices, or weights");
assert(decoded.field.indices.buffer !== source.indices.buffer && decoded.field.weights.buffer !== source.weights.buffer
  && decoded.field.indices.buffer !== bytes.buffer && decoded.field.weights.buffer !== bytes.buffer
  && decoded.field.indices.byteOffset === 0 && decoded.field.indices.byteLength === decoded.field.indices.buffer.byteLength,
"decode did not return exact owned transferable channel copies");
const sourceFirst = source.indices[0];
decoded.field.indices[0] = decoded.field.indices[0] === 0 ? 1 : 0;
assert(source.indices[0] === sourceFirst && bytes[0] === 0x4c, "decoded mutation aliased source field or artifact bytes");
decoded.field.indices[0] = sourceFirst;

// Canonical header/vector checks. The hash is pinned after the first reviewed implementation run.
const view = new DataView(bytes.buffer);
assert(bytes.length > BIOME_FIELD_ARTIFACT_HEADER_BYTES && view.getUint32(12, true) === bytes.length
  && view.getUint32(16, true) === 2 && view.getUint32(20, true) === 3
  && view.getUint16(28, true) === 4 && view.getUint16(30, true) === 40,
"fixed little-endian header vector is incorrect");

const corrupt = (mutate: (copy: Uint8Array, view: DataView) => void): Uint8Array => {
  const copy = bytes.slice();
  mutate(copy, new DataView(copy.buffer));
  return copy;
};
rejects(() => decodeBiomeFieldArtifact(corrupt((copy) => { copy[0] ^= 0xff; })), /magic/, "corrupt magic was accepted");
rejects(() => decodeBiomeFieldArtifact(corrupt((_copy, v) => v.setUint16(8, 2, true))), /version/, "unsupported version was accepted");
rejects(() => decodeBiomeFieldArtifact(corrupt((_copy, v) => v.setUint32(12, bytes.length - 1, true))), /byte length/, "noncanonical byte length was accepted");
rejects(() => decodeBiomeFieldArtifact(corrupt((copy) => { copy[84] = 1; })), /reserved/, "nonzero reserved header was accepted");
rejects(() => decodeBiomeFieldArtifact(corrupt((_copy, v) => v.setUint32(64, v.getUint32(64, true) + 2, true))), /layout/, "noncanonical channel offset was accepted");
rejects(() => decodeBiomeFieldArtifact(corrupt((copy, v) => { copy[BIOME_FIELD_ARTIFACT_HEADER_BYTES] = 0xff; void v; })), /UTF-8|pack id/, "invalid UTF-8 was accepted");
const indicesOffset = view.getUint32(64, true);
const weightsOffset = view.getUint32(68, true);
rejects(() => decodeBiomeFieldArtifact(corrupt((_copy, v) => v.setUint16(indicesOffset, 0xfffe, true))), /non-canonical/, "out-of-range biome index was accepted");
rejects(() => decodeBiomeFieldArtifact(corrupt((_copy, v) => v.setUint16(weightsOffset, 0, true))), /non-canonical|normalize/, "corrupt normalized weight was accepted");
const stringEnd = BIOME_FIELD_ARTIFACT_HEADER_BYTES + view.getUint32(60, true);
if (stringEnd < indicesOffset) {
  rejects(() => decodeBiomeFieldArtifact(corrupt((copy) => { copy[stringEnd] = 1; })), /padding/, "nonzero alignment padding was accepted");
}
rejects(() => decodeBiomeFieldArtifact(bytes.subarray(1)), /owned Uint8Array/, "sliced artifact storage was accepted");

// Encoder rejects non-owned channels and inconsistent diagnostics before allocation.
const badIndices = source.indices.slice();
const padded = new Uint16Array(badIndices.length + 1);
padded.set(badIndices, 1);
rejects(() => encodeBiomeFieldArtifact({ ...source, indices: padded.subarray(1) }), /own a complete/, "subarray-backed indices were accepted");
rejects(() => encodeBiomeFieldArtifact({ ...source, diagnostics: { ...source.diagnostics, outputBytes: source.diagnostics.outputBytes + 4 } }), /outputBytes/, "lying output-byte diagnostics were accepted");

// Cancellation is checked before work and every 1024 ranks for large fields.
rejects(() => encodeBiomeFieldArtifact(source, { shouldCancel: () => true }), /Cancelled|cancelled/, "pre-cancelled encode continued");
rejects(() => decodeBiomeFieldArtifact(bytes, { shouldCancel: () => true }), /Cancelled|cancelled/, "pre-cancelled decode continued");

const large = field(257, 257);
const encodeStarted = performance.now();
const largeBytes = encodeBiomeFieldArtifact(large);
const encodeMs = performance.now() - encodeStarted;
const decodeStarted = performance.now();
const largeDecoded = decodeBiomeFieldArtifact(largeBytes);
const decodeMs = performance.now() - decodeStarted;
assert(largeDecoded.field.diagnostics.cells === 257 * 257 && encodeMs < 5000 && decodeMs < 5000,
  `bounded 257x257 codec performance exceeded 5s (${encodeMs.toFixed(2)}/${decodeMs.toFixed(2)} ms)`);
let cancellationChecks = 0;
rejects(() => encodeBiomeFieldArtifact(large, { shouldCancel: () => ++cancellationChecks >= 3 }), /Cancelled|cancelled/,
  "mid-encode cancellation was not observed at bounded work intervals");

console.log(`p_biome_field_artifact OK: vector bytes=${bytes.length} hash=${hash}; 257x257 bytes=${largeBytes.length} encode=${encodeMs.toFixed(2)}ms decode=${decodeMs.toFixed(2)}ms; canonical LE roundtrip, ownership, corruption, caps, cancellation`);
