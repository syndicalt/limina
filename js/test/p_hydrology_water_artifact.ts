import { ops } from "../src/engine.ts";
import { createHydrologyTopology } from "../src/world/hydrology-topology.mjs";
import { extractHydrologyWaterTopology, HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA } from "../src/world/hydrology-water-topology.mjs";
import {
  HYDROLOGY_WATER_ARTIFACT_HEADER_BYTES,
  HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_WATER_ARTIFACT_TYPE,
  MAX_HYDROLOGY_WATER_ARTIFACT_BYTES,
  HydrologyWaterArtifactCancelledError,
  HydrologyWaterArtifactValidationError,
  decodeHydrologyWaterArtifact,
  encodeHydrologyWaterArtifact,
  inspectHydrologyWaterArtifactBindings,
} from "../src/world/hydrology-water-artifact.mjs";
import { sha256 } from "../src/world/sha256.mjs";
import { WATER_LIMITS } from "../src/world/water-ir.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_hydrology_water_artifact FAIL: ${message}`);
}

function rejects(fn: () => unknown, pattern: RegExp, message: string): Error {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
  return error;
}

function exactBytes(left: Uint8Array, right: Uint8Array, label: string): void {
  assert(left.length === right.length, `${label} length differs`);
  for (let index = 0; index < left.length; index++) assert(left[index] === right[index], `${label}[${index}] differs`);
}

const bindings = Object.freeze({
  hydrologyFieldContentHash: `sha256:${"11".repeat(32)}`,
  recipeHash: `sha256:${"22".repeat(32)}`,
  erosionStageKey: `sha256:${"33".repeat(32)}`,
  compilerGraphHash: `sha256:${"44".repeat(32)}`,
});

const recipe = Object.freeze({
  schema: "limina.hydrology-recipe/v1",
  precipitationMmPerYear: 500,
  riverMinCatchmentAreaM2: 12,
  basinMinAreaM2: 1,
  basinMinDepthM: 1,
  waterfallMinDropM: 5,
});

function field(rows: number, cols: number, heightsM: Float32Array | Float64Array, overrides: Record<string, unknown> = {}): any {
  return createHydrologyTopology({ rows, cols, heightsM, cellSizeM: 2, seaLevelM: -1, precipitationMmPerYear: 500, ...overrides });
}

function confluenceHeights(): Float64Array {
  const heights = new Float64Array(49);
  for (let index = 0; index < heights.length; index++) {
    const mixed = Math.imul(1 ^ index, -1640531535) >>> 0;
    heights[index] = (mixed % 1000) / 10;
  }
  heights[3] = 0;
  return heights;
}

function extract(heightsM: Float32Array | Float64Array, topology: any, recipeOverride: any = recipe, placement = { originX: -6, originZ: -6 }): any {
  return extractHydrologyWaterTopology({ heightsM, topology, placement, recipe: recipeOverride });
}

const heights = confluenceHeights();
const both = extract(heights, field(7, 7, heights));
const encoded = encodeHydrologyWaterArtifact(both, bindings);
const inspectedBindings = inspectHydrologyWaterArtifactBindings(encoded);
const decoded = decodeHydrologyWaterArtifact(encoded, bindings);
assert(encoded.byteOffset === 0 && encoded.byteLength === encoded.buffer.byteLength, "encoder bytes are not owned");
assert(encoded.byteLength === 1288, `fixed vector length changed to ${encoded.byteLength}`);
assert(decoded.artifact.artifactType === HYDROLOGY_WATER_ARTIFACT_TYPE && decoded.artifact.mediaType === HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
  "artifact identity changed");
assert(decoded.bindings.hydrologyFieldContentHash === bindings.hydrologyFieldContentHash, "raw binding hash did not round-trip");
assert(JSON.stringify(inspectedBindings) === JSON.stringify(bindings), "header-only binding inspection changed values or order");
assert(Object.isFrozen(inspectedBindings), "header-only binding inspection returned mutable bindings");
const bindingCarrier = new Uint8Array(encoded.byteLength + 2);
bindingCarrier.set(encoded, 1);
rejects(() => inspectHydrologyWaterArtifactBindings(bindingCarrier.subarray(1, 1 + encoded.byteLength)), /own its complete/, "binding inspector accepted a subarray");
const corruptBindingHeader = encoded.slice();
new DataView(corruptBindingHeader.buffer).setUint32(16, corruptBindingHeader.byteLength - 8, true);
rejects(() => inspectHydrologyWaterArtifactBindings(corruptBindingHeader), /byte length/, "binding inspector accepted a non-canonical declared length");
if (typeof SharedArrayBuffer === "function") {
  const shared = new Uint8Array(new SharedArrayBuffer(encoded.byteLength));
  shared.set(encoded);
  rejects(() => inspectHydrologyWaterArtifactBindings(shared), /non-shared/, "binding inspector accepted shared bytes");
}
assert(JSON.stringify(decoded.topology.basins) === JSON.stringify(both.basins), "basins did not round-trip");
assert(JSON.stringify(decoded.topology.reaches) === JSON.stringify(both.reaches), "reaches/elevation channels did not round-trip");
assert(Object.isFrozen(decoded) && Object.isFrozen(decoded.topology) && Object.isFrozen(decoded.topology.reaches[0].points[0]),
  "decoder output is mutable");
exactBytes(encodeHydrologyWaterArtifact(decoded.topology, decoded.bindings), encoded, "decode/re-encode");

const FIXED_HASH = "6007f6de6ba44852e5d8488d66573ca27ac0998e3654774922bd85dc0ee2749c";
assert(sha256(encoded) === FIXED_HASH, `fixed artifact hash changed: ${sha256(encoded)}`);
assert(MAX_HYDROLOGY_WATER_ARTIFACT_BYTES === 24_860_240, `derived artifact cap changed to ${MAX_HYDROLOGY_WATER_ARTIFACT_BYTES}`);
assert(MAX_HYDROLOGY_WATER_ARTIFACT_BYTES < 256 * 1024 * 1024, "water artifact cap exceeds compiler artifact cap");

// Every optional section combination uses the same canonical fixed header and re-encodes exactly.
const pitHeights = new Float64Array(25).fill(10);
pitHeights[12] = 0;
const basinOnly = extract(pitHeights, field(5, 5, pitHeights, { seaLevelM: -10 }),
  { ...recipe, riverMinCatchmentAreaM2: 1_000_000_000_000 }, { originX: 0, originZ: 0 });
const reachOnly = extract(heights, field(7, 7, heights), { ...recipe, basinMinAreaM2: 1_000_000_000_000, basinMinDepthM: 20_000 });
const flatHeights = new Float64Array(25).fill(10);
const empty = extract(flatHeights, field(5, 5, flatHeights, { seaLevelM: -10 }),
  { ...recipe, riverMinCatchmentAreaM2: 1_000_000_000_000, basinMinAreaM2: 1_000_000_000_000, basinMinDepthM: 20_000 },
  { originX: 0, originZ: 0 });
for (const [label, topology, expectedBasins, expectedReaches] of [
  ["both", both, 3, 3], ["basin-only", basinOnly, 1, 0], ["reach-only", reachOnly, 0, 3], ["empty", empty, 0, 0],
] as const) {
  const bytes = encodeHydrologyWaterArtifact(topology, bindings);
  const result = decodeHydrologyWaterArtifact(bytes, bindings);
  assert(result.topology.basins.length === expectedBasins && result.topology.reaches.length === expectedReaches, `${label} section counts changed`);
  exactBytes(encodeHydrologyWaterArtifact(result.topology, bindings), bytes, `${label} re-encode`);
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }

// Encoder snapshots the complete canonical graph before callbacks; decoder snapshots bytes first.
const mutableTopology = clone(both);
let encodeChecks = 0;
const isolatedBytes = encodeHydrologyWaterArtifact(mutableTopology, bindings, { shouldCancel: () => {
  encodeChecks++;
  mutableTopology.reaches[0].points[0][0] = 999;
  mutableTopology.basins[0].footprint.points[0][0] = 999;
  return false;
} });
exactBytes(isolatedBytes, encoded, "callback-side encoder mutation");
assert(encodeChecks >= 2, "encoder cancellation was not checked at boundaries");
const mutableBytes = encoded.slice();
let decodeChecks = 0;
const isolatedDecode = decodeHydrologyWaterArtifact(mutableBytes, bindings, { shouldCancel: () => { decodeChecks++; mutableBytes.fill(0); return false; } });
assert(JSON.stringify(isolatedDecode.topology.reaches) === JSON.stringify(both.reaches), "callback-side byte mutation changed decode");
assert(decodeChecks >= 2, "decoder cancellation was not checked at boundaries");

function corruptReject(mutator: (bytes: Uint8Array, view: DataView, offsets: any) => void, pattern: RegExp, message: string,
  expected: any = undefined): void {
  const bytes = encoded.slice(), view = new DataView(bytes.buffer);
  mutator(bytes, view, decoded.artifact.offsets);
  const error = rejects(() => decodeHydrologyWaterArtifact(bytes, expected), pattern, message);
  assert(error instanceof HydrologyWaterArtifactValidationError, `${message} did not use artifact validation error`);
}

corruptReject((bytes) => { bytes[0] ^= 1; }, /magic/, "corrupt magic accepted");
corruptReject((_bytes, view) => { view.setUint16(8, 2, true); }, /version/, "corrupt version accepted");
corruptReject((_bytes, view) => { view.setUint16(10, 1, true); }, /flags/, "unknown flags accepted");
corruptReject((_bytes, view) => { view.setUint16(12, HYDROLOGY_WATER_ARTIFACT_HEADER_BYTES - 8, true); }, /header length/, "corrupt header length accepted");
corruptReject((_bytes, view) => { view.setUint32(16, encoded.length - 8, true); }, /byte length/, "false byte length accepted");
corruptReject((_bytes, view) => { view.setUint32(44, WATER_LIMITS.totalWaterwayPoints, true); }, /byte length|offset|structurally/, "hostile point count accepted");
corruptReject((_bytes, view, offsets) => { view.setUint32(96, offsets.reachPointRecords + 8, true); }, /reach point offset/, "misaligned reach channel accepted");
corruptReject((bytes) => { bytes[250] = 1; }, /reserved header/, "non-zero header padding accepted");
corruptReject((bytes, _view, offsets) => { bytes[offsets.ringRecords + 5] = 1; }, /ring 0 reserved/, "non-zero ring padding accepted");
corruptReject((bytes) => { bytes[112] ^= 1; }, /binding/, "binding corruption was not detected", bindings);
corruptReject((_bytes, view, offsets) => { view.setUint32(offsets.reachPointRecords, 48, true); }, /cell index is inconsistent/, "corrupt point cell accepted");
corruptReject((_bytes, view, offsets) => { view.setFloat64(offsets.waterfallRecords + 24, 999, true); }, /drop metrics/, "corrupt waterfall total accepted");
corruptReject((_bytes, view, offsets) => {
  view.setUint32(offsets.basinRecords + 64, view.getUint32(offsets.basinRecords, true), true);
  view.setUint32(offsets.basinRecords + 72, view.getUint32(offsets.basinRecords + 8, true), true);
}, /duplicate basin id/, "binary basin id collision accepted");

rejects(() => decodeHydrologyWaterArtifact(new Uint8Array([...encoded, 0])), /byte length/, "trailing byte accepted");
const carrier = new Uint8Array(encoded.length + 1);
carrier.set(encoded, 1);
rejects(() => decodeHydrologyWaterArtifact(carrier.subarray(1)), /complete non-shared/, "sliced artifact bytes accepted");
rejects(() => decodeHydrologyWaterArtifact(Array.from(encoded) as any), /Uint8Array/, "ordinary byte array accepted");
if (typeof SharedArrayBuffer === "function") {
  const shared = new Uint8Array(new SharedArrayBuffer(encoded.length));
  shared.set(encoded);
  rejects(() => decodeHydrologyWaterArtifact(shared), /non-shared/, "shared artifact bytes accepted");
}

function encodeReject(topology: any, bindingValue: any, pattern: RegExp, message: string): void {
  const error = rejects(() => encodeHydrologyWaterArtifact(topology, bindingValue), pattern, message);
  assert(error instanceof HydrologyWaterArtifactValidationError, `${message} did not use artifact validation error`);
}
encodeReject({ ...both, unknown: true }, bindings, /unknown field/, "unknown topology field accepted");
encodeReject(Object.assign(Object.create({ polluted: true }), both), bindings, /plain object/, "prototyped topology accepted");
encodeReject({ ...both, [Symbol("bad")]: true }, bindings, /symbol/, "symbol topology field accepted");
{
  let calls = 0;
  const hostile = { ...both };
  Object.defineProperty(hostile, "basins", { enumerable: true, get() { calls++; return both.basins; } });
  encodeReject(hostile, bindings, /data field/, "topology accessor accepted");
  assert(calls === 0, "topology accessor was invoked");
}
{
  const hostile = clone(both);
  hostile.reaches[0].points[1] = hostile.reaches[0].points[0];
  encodeReject(hostile, bindings, /alias/, "aliased reach points accepted");
}
{
  const hostile = clone(both);
  let calls = 0;
  Object.defineProperty(hostile.diagnostics.basins, "workUnits", { enumerable: true, get() { calls++; return 1; } });
  encodeReject(hostile, bindings, /data field/, "nested diagnostics accessor accepted");
  assert(calls === 0, "nested diagnostics accessor was invoked");
}
{
  const hostile = clone(both);
  hostile.diagnostics.reaches = hostile.diagnostics.basins;
  encodeReject(hostile, bindings, /alias/, "aliased diagnostics accepted");
}
encodeReject(both, { ...bindings, recipeHash: "ABC" }, /lowercase sha256 content hash/, "malformed binding hash accepted");
encodeReject(both, { ...bindings, unknown: "55".repeat(32) }, /unknown field/, "unknown binding accepted");
{
  const hostile = clone(both);
  hostile.basins.reverse();
  encodeReject(hostile, bindings, /strictly ordered by id/, "reordered basins admitted a second canonical encoding");
}
{
  const hostile = clone(both);
  hostile.reaches.reverse();
  encodeReject(hostile, bindings, /strictly ordered by startCell/, "reordered reaches admitted a second canonical encoding");
}
{
  const hostile = clone(both);
  hostile.reaches[0].surfaceElevationsM[0] = hostile.reaches[0].terrainElevationsM[0] - 1;
  encodeReject(hostile, bindings, /must not be below terrain/, "sub-terrain water surface accepted");
}

let cancellationChecks = 0;
const cancelled = rejects(() => encodeHydrologyWaterArtifact(both, bindings, { shouldCancel: () => ++cancellationChecks === 1 }),
  /cancelled/, "encode cancellation ignored");
assert(cancelled instanceof HydrologyWaterArtifactCancelledError, "encode cancellation was not typed");
cancellationChecks = 0;
const decodeCancelled = rejects(() => decodeHydrologyWaterArtifact(encoded, undefined, { shouldCancel: () => ++cancellationChecks === 1 }),
  /cancelled/, "decode cancellation ignored");
assert(decodeCancelled instanceof HydrologyWaterArtifactCancelledError, "decode cancellation was not typed");

// Maximum reach-point contract: 32 contiguous snake reaches fill the 262,144-point aggregate cap.
const rows = 1025, cols = 1025, reachCount = 32, pointsPerReach = WATER_LIMITS.waterwayPoints;
const maximumReaches = [];
const cellAt = (position: number): number => {
  const row = Math.floor(position / cols), offset = position - row * cols;
  return row * cols + ((row & 1) === 0 ? offset : cols - 1 - offset);
};
for (let reachIndex = 0; reachIndex < reachCount; reachIndex++) {
  const points = [], widths = [], terrainElevationsM = [], surfaceElevationsM = [];
  const first = reachIndex * pointsPerReach;
  for (let pointIndex = 0; pointIndex < pointsPerReach; pointIndex++) {
    const position = first + pointIndex, cell = cellAt(position), row = Math.floor(cell / cols), col = cell - row * cols;
    points.push([col, row]);
    widths.push(1);
    terrainElevationsM.push(1000 - position / 1000);
    surfaceElevationsM.push(1000 - position / 1000);
  }
  const startCell = cellAt(first), endCell = cellAt(first + pointsPerReach - 1);
  maximumReaches.push({ id: `gen-r-${startCell.toString(36)}-${endCell.toString(36)}`, class: "stream", order: 1,
    startCell, endCell, points, widths, terrainElevationsM, surfaceElevationsM, waterfalls: [] });
}
const maximumTopology = {
  schema: HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA,
  version: 1,
  placement: { originX: 0, originZ: 0 },
  rows,
  cols,
  cellSizeM: 1,
  basins: [],
  reaches: maximumReaches,
  diagnostics: {},
};
const runtimeProcess = (globalThis as unknown as { process?: { memoryUsage?: () => { rss: number } } }).process;
const rss = (): number | null => runtimeProcess?.memoryUsage?.().rss ?? null;
const beforeRss = rss(), encodeStart = globalThis.performance?.now() ?? Date.now();
const maximumBytes = encodeHydrologyWaterArtifact(maximumTopology, bindings);
const encodeMs = (globalThis.performance?.now() ?? Date.now()) - encodeStart;
const decodeStart = globalThis.performance?.now() ?? Date.now();
const maximumDecoded = decodeHydrologyWaterArtifact(maximumBytes, bindings);
const decodeMs = (globalThis.performance?.now() ?? Date.now()) - decodeStart, afterRss = rss();
assert(maximumDecoded.topology.reaches.length === reachCount
  && maximumDecoded.artifact.counts.reachPoints === WATER_LIMITS.totalWaterwayPoints, "maximum point contract did not round-trip");
assert(maximumBytes.byteLength <= MAX_HYDROLOGY_WATER_ARTIFACT_BYTES, "maximum legal point vector exceeded artifact cap");

ops.op_log(
  `[js] p_hydrology_water_artifact OK: fixed 256-byte LE header, raw bindings, all sections, exact hash, strict corruption/ownership/cancellation proven; `
  + `${maximumBytes.byteLength} byte max-point vector encode ${encodeMs.toFixed(1)}ms decode ${decodeMs.toFixed(1)}ms`
  + `${beforeRss === null || afterRss === null ? "" : ` RSS delta ${((afterRss - beforeRss) / 1048576).toFixed(1)} MiB`}; hard cap ${MAX_HYDROLOGY_WATER_ARTIFACT_BYTES}.`,
);
