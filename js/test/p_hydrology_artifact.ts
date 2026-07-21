import { ops } from "../src/engine.ts";
import {
  HYDROLOGY_FIELD_ARTIFACT_HEADER_BYTES,
  HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_FIELD_ARTIFACT_TYPE,
  MAX_HYDROLOGY_FIELD_ARTIFACT_BYTES,
  HydrologyArtifactCancelledError,
  HydrologyArtifactValidationError,
  decodeHydrologyFieldArtifact,
  encodeHydrologyFieldArtifact,
  inspectHydrologyFieldArtifact,
} from "../src/world/hydrology-artifact.mjs";
import { createHydrologyTopology, MAX_HYDROLOGY_DIMENSION } from "../src/world/hydrology-topology.mjs";
import { sha256 } from "../src/world/sha256.mjs";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_hydrology_artifact FAIL: ${message}`);
}

function rejects(fn: () => unknown, pattern: RegExp, message: string): Error {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
  return error;
}

function exactBytes(left: Uint8Array, right: Uint8Array, label: string): void {
  assert(left.length === right.length, `${label} length ${left.length} != ${right.length}`);
  for (let index = 0; index < left.length; index++) assert(left[index] === right[index], `${label}[${index}] differs`);
}

function exactArray(left: ArrayLike<number>, right: ArrayLike<number>, label: string): void {
  assert(left.length === right.length, `${label} length differs`);
  for (let index = 0; index < left.length; index++) assert(Object.is(left[index], right[index]), `${label}[${index}] differs`);
}

function topology(rows: number, cols: number, heightsM: Float32Array | Float64Array, overrides: Record<string, unknown> = {}): any {
  return createHydrologyTopology({
    rows,
    cols,
    heightsM,
    cellSizeM: 1.5,
    seaLevelM: -1,
    precipitationMmPerYear: 800,
    ...overrides,
  });
}

const oddHeights = new Float64Array([2, 2, 2, 2, 0, 2, 2, 2, 2]);
const oddTopology = topology(3, 3, oddHeights);
const placement = { originX: -4.5, originZ: 9.25 };
const encoded = encodeHydrologyFieldArtifact(oddTopology, placement);
const inspected = inspectHydrologyFieldArtifact(encoded);
assert(inspected.artifact.artifactType === HYDROLOGY_FIELD_ARTIFACT_TYPE, "artifact type changed");
assert(inspected.artifact.mediaType === HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE, "artifact media type changed");
assert(encoded.byteOffset === 0 && encoded.byteLength === encoded.buffer.byteLength, "encoder did not return owned bytes");
assert(encoded.byteLength === 352 && inspected.artifact.offsets.dataEnd === 346, "odd-cell canonical layout changed");
assert(inspected.artifact.offsets.byteLength === 352 && encoded.byteLength <= MAX_HYDROLOGY_FIELD_ARTIFACT_BYTES, "artifact byte bounds changed");
for (let index = inspected.artifact.offsets.dataEnd; index < encoded.byteLength; index++) {
  assert(encoded[index] === 0, `odd-cell alignment padding byte ${index} is non-zero`);
}

const FIXED_HASH = "6d597f8eedf512ee5b5ddbbe05188e6d7ad49e5fb1e694d1af40f63940817101";
assert(sha256(encoded) === FIXED_HASH, `fixed artifact hash changed: ${sha256(encoded)}`);

const decoded = decodeHydrologyFieldArtifact(encoded);
assert(decoded.placement.originX === placement.originX && decoded.placement.originZ === placement.originZ, "placement did not round-trip");
for (const key of ["receiver", "drainageRank", "filledHeightM", "catchmentAreaM2", "streamOrder", "oceanMask"] as const) {
  exactArray(decoded.topology[key], oddTopology[key], `${key} round-trip`);
  assert(decoded.topology[key].byteOffset === 0 && decoded.topology[key].byteLength === decoded.topology[key].buffer.byteLength,
    `${key} decoder output is not owned`);
}
for (let index = 0; index < decoded.topology.cellCount; index++) {
  const expected = decoded.topology.catchmentAreaM2[index] * decoded.topology.precipitationMPerYear;
  assert(decoded.topology.dischargeM3PerYear[index] === expected, `derived discharge[${index}] is not catchment*precipitation`);
}
const reencoded = encodeHydrologyFieldArtifact(decoded.topology, decoded.placement);
exactBytes(reencoded, encoded, "decode/re-encode");

const evenTopology = topology(2, 2, new Float32Array([1, 2, 3, 4]));
const evenBytes = encodeHydrologyFieldArtifact(evenTopology, { originX: 0, originZ: 0 });
const evenInspection = inspectHydrologyFieldArtifact(evenBytes);
assert(evenInspection.artifact.offsets.dataEnd === 216 && evenBytes.byteLength === 216,
  "even-cell no-padding layout changed");
exactBytes(encodeHydrologyFieldArtifact(decodeHydrologyFieldArtifact(evenBytes).topology, { originX: 0, originZ: 0 }), evenBytes,
  "even layout decode/re-encode");

// Decoder accepts a misaligned subarray but snapshots it. Later caller mutation cannot alter output.
const carrier = new Uint8Array(encoded.length + 7);
carrier.set(encoded, 3);
const misaligned = carrier.subarray(3, 3 + encoded.length);
const fromSubarray = decodeHydrologyFieldArtifact(misaligned);
carrier.fill(0);
exactArray(fromSubarray.topology.filledHeightM, oddTopology.filledHeightM, "misaligned input ownership");

// Valid source mutations change bytes/hash while leaving the input untouched.
const originalFilled = oddTopology.filledHeightM[4];
oddTopology.filledHeightM[4] = originalFilled + 0.25;
const changedSurface = encodeHydrologyFieldArtifact(oddTopology, placement);
assert(sha256(changedSurface) !== sha256(encoded), "filled-height mutation did not change artifact identity");
oddTopology.filledHeightM[4] = originalFilled;
const changedOrigin = encodeHydrologyFieldArtifact(oddTopology, { ...placement, originX: placement.originX + 1 });
assert(sha256(changedOrigin) !== sha256(encoded), "placement mutation did not change artifact identity");
exactArray(oddHeights, new Float64Array([2, 2, 2, 2, 0, 2, 2, 2, 2]), "source height mutation");

function corruptReject(mutator: (bytes: Uint8Array, view: DataView, offsets: any) => void, pattern: RegExp, message: string): void {
  const candidate = encoded.slice();
  const view = new DataView(candidate.buffer);
  mutator(candidate, view, inspected.artifact.offsets);
  const error = rejects(() => decodeHydrologyFieldArtifact(candidate), pattern, message);
  assert(error instanceof HydrologyArtifactValidationError, `${message} did not throw HydrologyArtifactValidationError`);
}

corruptReject((bytes) => { bytes[0] ^= 1; }, /magic/, "corrupt magic accepted");
corruptReject((_bytes, view) => { view.setUint16(8, 2, true); }, /version/, "corrupt version accepted");
corruptReject((_bytes, view) => { view.setUint16(10, 1, true); }, /flags/, "non-zero flags accepted");
corruptReject((_bytes, view) => { view.setUint16(12, HYDROLOGY_FIELD_ARTIFACT_HEADER_BYTES - 8, true); }, /header length/, "corrupt header length accepted");
corruptReject((_bytes, view) => { view.setUint16(14, 1, true); }, /reserved/, "non-zero reserved field accepted");
corruptReject((bytes) => { bytes[100] = 1; }, /reserved/, "non-zero reserved bytes accepted");
corruptReject((_bytes, view) => { view.setUint32(24, 8, true); }, /cell count/, "false cell count accepted");
corruptReject((_bytes, view) => { view.setUint32(28, encoded.length - 8, true); }, /byte length/, "false declared length accepted");
corruptReject((_bytes, view) => { view.setFloat64(32, -0, true); }, /originX/, "negative-zero encoded origin accepted");
corruptReject((_bytes, view) => { view.setFloat64(48, Number.NaN, true); }, /cellSizeM/, "NaN encoded cell size accepted");
corruptReject((_bytes, view) => { view.setFloat64(64, Number.POSITIVE_INFINITY, true); }, /precipitation/, "infinite encoded precipitation accepted");
corruptReject((_bytes, view) => { view.setUint32(72, inspected.artifact.offsets.receiver + 4, true); }, /receiver offset/, "noncanonical channel offset accepted");
corruptReject((bytes, _view, offsets) => { bytes[offsets.dataEnd] = 1; }, /padding/, "non-zero alignment padding accepted");
corruptReject((_bytes, view, offsets) => { view.setInt32(offsets.receiver + 4 * 4, 99, true); }, /out of range/, "out-of-range receiver accepted");
corruptReject((_bytes, view, offsets) => { view.setUint32(offsets.drainageRank + 4 * 4, 0, true); }, /permutation/, "duplicate drainage rank accepted");
corruptReject((_bytes, view, offsets) => { view.setFloat64(offsets.filledHeightM + 4 * 8, Number.NaN, true); }, /filledHeightM/, "NaN filled height accepted");
corruptReject((_bytes, view, offsets) => { view.setFloat64(offsets.filledHeightM, 3, true); }, /rises downstream/, "downstream-rising filled surface accepted");
corruptReject((_bytes, view, offsets) => { view.setFloat64(offsets.catchmentAreaM2 + 4 * 8, 0, true); }, /catchmentAreaM2/, "zero catchment accepted");
corruptReject((bytes, _view, offsets) => { bytes[offsets.streamOrder + 4] = 2; }, /Strahler/, "invalid stream order accepted");
corruptReject((bytes, _view, offsets) => { bytes[offsets.oceanMask + 4] = 2; }, /0 or 1/, "invalid ocean bit accepted");
corruptReject((bytes, _view, offsets) => { bytes[offsets.oceanMask + 4] = 1; }, /outlet policy/, "ocean cell with receiver accepted");

for (const candidate of [encoded.subarray(0, encoded.length - 1), new Uint8Array([...encoded, 0])]) {
  rejects(() => decodeHydrologyFieldArtifact(candidate), /byte length/, "non-exact artifact length accepted");
}
rejects(() => decodeHydrologyFieldArtifact(Array.from(encoded) as any), /Uint8Array/, "ordinary artifact byte array accepted");
if (typeof SharedArrayBuffer === "function") {
  const shared = new Uint8Array(new SharedArrayBuffer(encoded.length));
  shared.set(encoded);
  rejects(() => decodeHydrologyFieldArtifact(shared), /non-shared/, "shared artifact bytes accepted");
}

function encodeReject(candidateTopology: any, candidatePlacement: any, pattern: RegExp, message: string): void {
  const error = rejects(() => encodeHydrologyFieldArtifact(candidateTopology, candidatePlacement), pattern, message);
  assert(error instanceof HydrologyArtifactValidationError, `${message} did not throw HydrologyArtifactValidationError`);
}
encodeReject({ ...oddTopology, unknown: true }, placement, /unknown field/, "unknown topology field accepted");
encodeReject({ ...oddTopology, schema: "limina.hydrology-topology/v2" }, placement, /schema/, "wrong topology schema accepted");
encodeReject({ ...oddTopology, cellAreaM2: oddTopology.cellAreaM2 + 1 }, placement, /cellAreaM2/, "inconsistent cell area accepted");
{
  const backing = new Int32Array(oddTopology.receiver.length + 1);
  backing.set(oddTopology.receiver, 1);
  encodeReject({ ...oddTopology, receiver: backing.subarray(1) }, placement, /complete non-shared ArrayBuffer/, "receiver subarray accepted");
}
encodeReject(oddTopology, { ...placement, unknown: true }, /unknown field/, "unknown placement field accepted");
encodeReject(oddTopology, { ...placement, originX: -0 }, /originX/, "negative-zero origin accepted");
encodeReject(oddTopology, Object.assign(Object.create({ polluted: true }), placement), /plain object/, "prototyped placement accepted");
{
  let calls = 0;
  const accessor = { originX: placement.originX, originZ: placement.originZ };
  Object.defineProperty(accessor, "originX", { enumerable: true, get() { calls++; return placement.originX; } });
  encodeReject(oddTopology, accessor, /data field/, "placement accessor accepted");
  assert(calls === 0, "placement validation invoked an accessor");
}

let encodeCancellationChecks = 0;
const encodeCancelled = rejects(
  () => encodeHydrologyFieldArtifact(oddTopology, placement, { shouldCancel: () => ++encodeCancellationChecks === 1 }),
  /cancelled/,
  "encode cancellation ignored",
);
assert(encodeCancelled instanceof HydrologyArtifactCancelledError, "encode cancellation was not typed");
let decodeCancellationChecks = 0;
const decodeCancelled = rejects(
  () => decodeHydrologyFieldArtifact(encoded, { shouldCancel: () => ++decodeCancellationChecks === 1 }),
  /cancelled/,
  "decode cancellation ignored",
);
assert(decodeCancelled instanceof HydrologyArtifactCancelledError, "decode cancellation was not typed");

// Maximum current master field, measured without host-endian views.
const maxRows = MAX_HYDROLOGY_DIMENSION;
const maxCols = MAX_HYDROLOGY_DIMENSION;
const maxCells = maxRows * maxCols;
const maxHeights = new Float32Array(maxCells);
for (let row = 0; row < maxRows; row++) {
  for (let col = 0; col < maxCols; col++) maxHeights[row * maxCols + col] = row * 0.001 + col * 0.002;
}
const maximumTopology = topology(maxRows, maxCols, maxHeights, { cellSizeM: 1.25, precipitationMmPerYear: 650 });
const runtimeProcess = (globalThis as unknown as { process?: { memoryUsage?: () => { rss: number } } }).process;
const rss = (): number | null => runtimeProcess?.memoryUsage?.().rss ?? null;
const beforeRss = rss();
const encodeStart = globalThis.performance?.now() ?? Date.now();
const maximumBytes = encodeHydrologyFieldArtifact(maximumTopology, { originX: -640, originZ: -640 });
const encodeMs = (globalThis.performance?.now() ?? Date.now()) - encodeStart;
const decodeStart = globalThis.performance?.now() ?? Date.now();
const maximumDecoded = decodeHydrologyFieldArtifact(maximumBytes);
const decodeMs = (globalThis.performance?.now() ?? Date.now()) - decodeStart;
const afterRss = rss();
assert(maximumBytes.byteLength === MAX_HYDROLOGY_FIELD_ARTIFACT_BYTES, "maximum artifact byte length changed");
assert(maximumDecoded.topology.cellCount === maxCells, "maximum artifact decode is incomplete");
assert(maximumDecoded.artifact.invariants.outletCatchmentAreaM2 > 0, "maximum artifact conservation diagnostics missing");
const maximumReencoded = encodeHydrologyFieldArtifact(maximumDecoded.topology, maximumDecoded.placement);
exactBytes(maximumReencoded, maximumBytes, "maximum decode/re-encode");

ops.op_log(
  `[js] p_hydrology_artifact OK: portable LE header/channels, exact hash, odd padding, owned decode, invariant corruption and cancellation proven; `
  + `${maxCells} cells/${maximumBytes.byteLength} bytes encode ${encodeMs.toFixed(1)}ms decode ${decodeMs.toFixed(1)}ms`
  + `${beforeRss === null || afterRss === null ? "" : ` RSS delta ${((afterRss - beforeRss) / (1024 * 1024)).toFixed(1)}MiB`}.`,
);
