// WB-W1 deterministic drainage-field gate: connected-ocean proof, priority-flood routing,
// receiver-rank acyclicity, scalar-rain accumulation, Strahler order, hostile inputs, and scale.

import { ops } from "../src/engine.ts";
import {
  HYDROLOGY_TOPOLOGY_SCHEMA,
  MAX_HYDROLOGY_ABS_HEIGHT_M,
  MAX_HYDROLOGY_CELL_SIZE_M,
  MAX_HYDROLOGY_DIMENSION,
  MAX_HYDROLOGY_PRECIPITATION_MM_PER_YEAR,
  HydrologyTopologyCancelledError,
  HydrologyTopologyValidationError,
  createHydrologyTopology,
} from "../src/world/hydrology-topology.mjs";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_hydrology_topology FAIL: ${message}`);
}

function rejects(fn: () => unknown, pattern: RegExp, message: string): Error {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
  return error;
}

function exactArray(left: ArrayLike<number>, right: ArrayLike<number>, label: string): void {
  assert(left.length === right.length, `${label} length ${left.length} != ${right.length}`);
  for (let index = 0; index < left.length; index++) {
    assert(Object.is(left[index], right[index]), `${label}[${index}] ${left[index]} != ${right[index]}`);
  }
}

function build(rows: number, cols: number, heightsM: Float32Array | Float64Array, overrides: Record<string, unknown> = {}): any {
  return createHydrologyTopology({
    rows,
    cols,
    heightsM,
    cellSizeM: 2,
    seaLevelM: -10,
    precipitationMmPerYear: 500,
    ...overrides,
  });
}

function assertReceiverRanks(topology: any, label: string): void {
  const seenRanks = new Uint8Array(topology.cellCount);
  for (let index = 0; index < topology.cellCount; index++) {
    const rank = topology.drainageRank[index];
    assert(rank < topology.cellCount && seenRanks[rank] === 0, `${label}: rank ${rank} is invalid or duplicated`);
    seenRanks[rank] = 1;
    const receiver = topology.receiver[index];
    assert(receiver === -1 || (receiver >= 0 && receiver < topology.cellCount), `${label}: receiver ${receiver} is invalid`);
    if (receiver >= 0) {
      assert(topology.drainageRank[receiver] < rank, `${label}: receiver ${receiver} is not earlier than cell ${index}`);
      assert(topology.filledHeightM[receiver] <= topology.filledHeightM[index], `${label}: filled surface rises downstream`);
    }
  }
}

function outletDischarge(topology: any): number {
  let total = 0;
  for (let index = 0; index < topology.cellCount; index++) {
    if (topology.receiver[index] === -1) total += topology.dischargeM3PerYear[index];
  }
  return total;
}

// A closed pit fills to its spill surface. A completely flat field remains exact, and canonical
// index ordering makes the complete receiver/rank arrays repeat byte-for-byte.
const pitHeights = new Float32Array(25);
pitHeights.fill(10);
pitHeights[12] = 0;
const pitInputCopy = pitHeights.slice();
const pitA = build(5, 5, pitHeights);
const pitB = build(5, 5, pitHeights.slice());
assert(pitA.schema === HYDROLOGY_TOPOLOGY_SCHEMA && pitA.version === 1, "topology identity changed");
assert(pitA.filledHeightM[12] === 10, `closed pit filled to ${pitA.filledHeightM[12]}m instead of 10m`);
exactArray(pitA.receiver, pitB.receiver, "repeat receiver");
exactArray(pitA.drainageRank, pitB.drainageRank, "repeat drainageRank");
exactArray(pitA.filledHeightM, pitB.filledHeightM, "repeat filledHeightM");
exactArray(pitA.catchmentAreaM2, pitB.catchmentAreaM2, "repeat catchmentAreaM2");
exactArray(pitA.dischargeM3PerYear, pitB.dischargeM3PerYear, "repeat dischargeM3PerYear");
exactArray(pitA.streamOrder, pitB.streamOrder, "repeat streamOrder");
exactArray(pitA.oceanMask, pitB.oceanMask, "repeat oceanMask");
exactArray(pitHeights, pitInputCopy, "input heightfield mutation");
assertReceiverRanks(pitA, "pit");
assert(pitA.diagnostics.heapPushes === 25 && pitA.diagnostics.heapPops === 25 && pitA.diagnostics.heapPeak <= 25, "pit heap bounds changed");

const flat = build(5, 5, new Float64Array(25).fill(7));
for (let index = 0; index < flat.cellCount; index++) {
  assert(flat.filledHeightM[index] === 7, `flat field changed height at ${index}`);
  assert(flat.drainageRank[index] === index, `flat canonical tie-break changed rank at ${index}`);
}
assertReceiverRanks(flat, "flat");

const saddleHeights = new Float64Array([
  0, 0, 0, 0, 0,
  0, 8, 4, 8, 0,
  0, 4, 9, 4, 0,
  0, 8, 4, 8, 0,
  0, 0, 0, 0, 0,
]);
const saddleA = build(5, 5, saddleHeights, { seaLevelM: -1 });
const saddleB = build(5, 5, saddleHeights.slice(), { seaLevelM: -1 });
exactArray(saddleA.receiver, saddleB.receiver, "symmetric saddle receiver");
assertReceiverRanks(saddleA, "saddle");
assert(saddleA.receiver[12] === 7, `symmetric saddle tie-break selected ${saddleA.receiver[12]} instead of lowest-ranked north cell 7`);

// Only sub-sea cells connected to a sub-sea perimeter seed are proven ocean. An isolated interior
// depression below sea level remains a basin candidate, not a false ocean outlet.
const oceanHeights = new Float64Array(49);
oceanHeights.fill(5);
for (const index of [0, 8, 16, 24]) oceanHeights[index] = -2;
oceanHeights[40] = -3;
const ocean = build(7, 7, oceanHeights, { seaLevelM: 0 });
for (const index of [0, 8, 16, 24]) assert(ocean.oceanMask[index] === 1 && ocean.receiver[index] === -1, `connected ocean cell ${index} was not an outlet`);
assert(ocean.oceanMask[40] === 0 && ocean.receiver[40] >= 0, "isolated sub-sea pit was falsely classified as ocean");
assert(ocean.diagnostics.oceanCellCount === 4, `ocean proof found ${ocean.diagnostics.oceanCellCount} cells instead of 4`);
assertReceiverRanks(ocean, "ocean");

// Non-square terrain pins scalar rainfall volume math: 21 cells * 4m2 * 0.5m/year = 42m3/year.
const asymmetricHeights = new Float64Array(3 * 7);
for (let index = 0; index < asymmetricHeights.length; index++) asymmetricHeights[index] = 20 + (index * 7 % 11);
const asymmetric = build(3, 7, asymmetricHeights);
assert(asymmetric.cellAreaM2 === 4 && asymmetric.precipitationMPerYear === 0.5, "asymmetric cell/rain metrics changed");
assert(asymmetric.diagnostics.totalAreaM2 === 84 && asymmetric.diagnostics.totalDischargeM3PerYear === 42, "asymmetric expected totals changed");
assert(Math.abs(outletDischarge(asymmetric) - 42) <= 1e-12, `outlet conservation produced ${outletDischarge(asymmetric)}m3/year instead of 42`);

// A fixed drainage tree contains an explicit equal-order confluence: cells 22 and 29 are order 2
// branches entering outlet 28, which must therefore be Strahler order 3.
const confluenceHeights = new Float64Array(49);
for (let index = 0; index < confluenceHeights.length; index++) {
  const mixed = Math.imul(1 ^ index, -1640531535) >>> 0;
  confluenceHeights[index] = (mixed % 1000) / 10;
}
confluenceHeights[3] = 0;
const confluence = build(7, 7, confluenceHeights, { seaLevelM: -1, precipitationMmPerYear: 1 });
assert(confluence.receiver[22] === 28 && confluence.receiver[29] === 28, "fixed confluence receiver topology changed");
assert(confluence.streamOrder[22] === 2 && confluence.streamOrder[29] === 2 && confluence.streamOrder[28] === 3,
  `equal-order confluence rule changed: ${confluence.streamOrder[22]},${confluence.streamOrder[29]} -> ${confluence.streamOrder[28]}`);
assertReceiverRanks(confluence, "confluence");

// Snapshot isolation: callback-side mutation after entry cannot alter canonical output.
const mutable = pitInputCopy.slice();
let mutationChecks = 0;
const isolated = build(5, 5, mutable, { shouldCancel: () => { mutationChecks++; mutable.fill(999); return false; } });
exactArray(isolated.receiver, pitA.receiver, "callback mutation changed receiver");
exactArray(isolated.filledHeightM, pitA.filledHeightM, "callback mutation changed filled surface");
assert(mutationChecks >= 2, "cancellation callback was not checked at entry and completion");

let cancellationChecks = 0;
const cancelled = rejects(
  () => build(128, 128, new Float32Array(128 * 128).fill(1), { shouldCancel: () => ++cancellationChecks === 2 }),
  /cancelled/,
  "mid-operation cancellation was ignored",
);
assert(cancelled instanceof HydrologyTopologyCancelledError && cancellationChecks === 2, "cancellation was not typed or promptly polled");

const validSmall = () => ({ rows: 2, cols: 2, heightsM: new Float32Array(4).fill(1), cellSizeM: 1, seaLevelM: 0, precipitationMmPerYear: 1 });
function validationReject(input: unknown, pattern: RegExp, message: string): void {
  const error = rejects(() => createHydrologyTopology(input), pattern, message);
  assert(error instanceof HydrologyTopologyValidationError, `${message} did not throw HydrologyTopologyValidationError`);
}
validationReject(null, /plain object/, "null input accepted");
validationReject([], /plain object/, "array input accepted");
validationReject(Object.assign(Object.create({ polluted: true }), validSmall()), /plain object/, "prototyped input accepted");
validationReject({ ...validSmall(), unknown: true }, /unknown field/, "unknown input field accepted");
{
  let calls = 0;
  const accessor = validSmall();
  Object.defineProperty(accessor, "rows", { enumerable: true, get() { calls++; return 2; } });
  validationReject(accessor, /data field/, "input accessor accepted");
  assert(calls === 0, "input validation invoked an accessor");
}
validationReject({ ...validSmall(), rows: 1 }, /rows/, "one-row grid accepted");
validationReject({ ...validSmall(), rows: MAX_HYDROLOGY_DIMENSION + 1 }, /rows/, "oversized row count accepted");
validationReject({ ...validSmall(), cols: 2.5 }, /cols/, "fractional column count accepted");
validationReject({ ...validSmall(), heightsM: [1, 1, 1, 1] }, /Float32Array or Float64Array/, "ordinary height array accepted");
validationReject({ ...validSmall(), heightsM: new Float32Array(5).subarray(1) }, /complete non-shared ArrayBuffer/, "height subarray accepted");
validationReject({ ...validSmall(), heightsM: new Float32Array(3) }, /length/, "wrong height count accepted");
for (const value of [NaN, Infinity, -0, MAX_HYDROLOGY_ABS_HEIGHT_M + 1]) {
  const heightsM = new Float64Array([1, 1, 1, 1]);
  heightsM[2] = value;
  validationReject({ ...validSmall(), heightsM }, /heightsM\[2\]/, `hostile height ${String(value)} accepted`);
}
validationReject({ ...validSmall(), cellSizeM: -0 }, /cellSizeM/, "negative-zero cell size accepted");
validationReject({ ...validSmall(), cellSizeM: MAX_HYDROLOGY_CELL_SIZE_M + 1 }, /cellSizeM/, "excessive cell size accepted");
validationReject({ ...validSmall(), seaLevelM: -0 }, /seaLevelM/, "negative-zero sea level accepted");
validationReject({ ...validSmall(), seaLevelM: MAX_HYDROLOGY_ABS_HEIGHT_M + 1 }, /seaLevelM/, "excessive sea level accepted");
validationReject({ ...validSmall(), precipitationMmPerYear: -0 }, /precipitationMmPerYear/, "negative-zero precipitation accepted");
validationReject({ ...validSmall(), precipitationMmPerYear: MAX_HYDROLOGY_PRECIPITATION_MM_PER_YEAR + 1 }, /precipitationMmPerYear/, "excess precipitation accepted");
validationReject({ ...validSmall(), shouldCancel: true }, /shouldCancel/, "non-function cancellation accepted");
if (typeof SharedArrayBuffer === "function") {
  validationReject({ ...validSmall(), heightsM: new Float32Array(new SharedArrayBuffer(16)) }, /complete non-shared ArrayBuffer/, "shared height buffer accepted");
}

// Maximum supported master field: proves bounded heap/storage behavior on the current 1025^2 domain.
const benchmarkRows = MAX_HYDROLOGY_DIMENSION;
const benchmarkCols = MAX_HYDROLOGY_DIMENSION;
const benchmarkCells = benchmarkRows * benchmarkCols;
const benchmarkHeights = new Float32Array(benchmarkCells);
for (let row = 0; row < benchmarkRows; row++) {
  for (let col = 0; col < benchmarkCols; col++) {
    benchmarkHeights[row * benchmarkCols + col] = row * 0.001 + col * 0.002 + ((row * 17 + col * 31) % 13) * 0.01;
  }
}
const benchmarkStart = globalThis.performance?.now() ?? Date.now();
const benchmark = createHydrologyTopology({
  rows: benchmarkRows,
  cols: benchmarkCols,
  heightsM: benchmarkHeights,
  cellSizeM: 1.5,
  seaLevelM: -100,
  precipitationMmPerYear: 800,
});
const benchmarkMs = (globalThis.performance?.now() ?? Date.now()) - benchmarkStart;
assert(benchmark.cellCount === benchmarkCells && benchmark.receiver.length === benchmarkCells, "maximum field output is incomplete");
assert(benchmark.diagnostics.heapCapacity === benchmarkCells && benchmark.diagnostics.heapPeak <= benchmarkCells, "maximum field heap exceeded its typed capacity");
assert(benchmark.diagnostics.heapPushes === benchmarkCells && benchmark.diagnostics.heapPops === benchmarkCells, "maximum field did not heap each cell exactly once");
assert(benchmark.diagnostics.workUnits <= benchmark.diagnostics.workLimit, "maximum field exceeded bounded work diagnostics");
assert(benchmark.diagnostics.accumulationEdges === benchmarkCells - benchmark.diagnostics.outletCount, "maximum field accumulation edge count changed");
assertReceiverRanks(benchmark, "maximum field");
const expectedBenchmarkDischarge = benchmarkCells * 1.5 * 1.5 * 0.8;
assert(Math.abs(outletDischarge(benchmark) - expectedBenchmarkDischarge) <= expectedBenchmarkDischarge * 1e-12,
  "maximum field outlet discharge is not conservative");

ops.op_log(
  `[js] p_hydrology_topology OK: canonical connected-ocean outlets, pit/flat/saddle priority flood, earlier-rank receivers, `
  + `conservative scalar rainfall, Strahler confluences, cancellation and hostile bounds proven; `
  + `${benchmarkCells} cells in ${benchmarkMs.toFixed(1)}ms, heap peak ${benchmark.diagnostics.heapPeak}/${benchmark.diagnostics.heapCapacity}, `
  + `work ${benchmark.diagnostics.workUnits}/${benchmark.diagnostics.workLimit}.`,
);
