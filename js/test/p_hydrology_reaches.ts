import { ops } from "../src/engine.ts";
import { createHydrologyTopology } from "../src/world/hydrology-topology.mjs";
import {
  HYDROLOGY_REACH_TOPOLOGY_SCHEMA,
  HydrologyWaterTopologyCancelledError,
  HydrologyWaterTopologyValidationError,
  extractHydrologyBasins,
  extractHydrologyReaches,
} from "../src/world/hydrology-water-topology.mjs";
import { WATER_LIMITS } from "../src/world/water-ir.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_hydrology_reaches FAIL: ${message}`);
}

function rejects(fn: () => unknown, pattern: RegExp, message: string): Error {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
  return error;
}

function recipe(threshold = 12, waterfall = 5): any {
  return Object.freeze({
    schema: "limina.hydrology-recipe/v1",
    precipitationMmPerYear: 500,
    riverMinCatchmentAreaM2: threshold,
    basinMinAreaM2: 1,
    basinMinDepthM: 1,
    waterfallMinDropM: waterfall,
  });
}

function build(rows: number, cols: number, heightsM: Float32Array | Float64Array, overrides: Record<string, unknown> = {}): any {
  return createHydrologyTopology({
    rows, cols, heightsM, cellSizeM: 2, seaLevelM: -1,
    precipitationMmPerYear: 500, ...overrides,
  });
}

function extract(heightsM: Float32Array | Float64Array, topology: any, overrides: Record<string, unknown> = {}): any {
  return extractHydrologyReaches({
    heightsM,
    topology,
    placement: overrides.placement ?? { originX: -6, originZ: -6 },
    recipe: overrides.recipe ?? recipe(),
  }, overrides.control as any);
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

// Fixed field: active cells 22 and 29 enter outlet 28 at an equal-order confluence. A separate
// chain 25 -> 32 -> 39 -> 46 proves that degree-one cells remain inside one directed reach.
const heights = confluenceHeights();
const field = build(7, 7, heights);
const reaches = extract(heights, field);
assert(reaches.schema === HYDROLOGY_REACH_TOPOLOGY_SCHEMA && reaches.version === 1, "reach topology identity changed");
assert(reaches.reaches.map((reach: any) => reach.id).join(",") === "gen-r-m-s,gen-r-p-1a,gen-r-t-s", "fixed reach ids changed");
assert(reaches.diagnostics.expectedEdgeCount === 5 && reaches.diagnostics.visitedEdgeCount === 5, "active edges were lost or duplicated");
assert(reaches.diagnostics.totalPoints === reaches.diagnostics.expectedEdgeCount + reaches.diagnostics.reachCount,
  "reach point accounting no longer equals edges plus starts");

const left = reaches.reaches[0], chain = reaches.reaches[1], right = reaches.reaches[2];
assert(left.startCell === 22 && left.endCell === 28 && right.startCell === 29 && right.endCell === 28,
  "confluence segmentation changed");
assert(JSON.stringify(left.points[left.points.length - 1]) === JSON.stringify(right.points[right.points.length - 1]),
  "tributaries do not share the exact confluence endpoint");
assert(!reaches.reaches.some((reach: any) => reach.startCell === 28), "outlet node emitted a nonexistent outgoing edge");
assert(chain.startCell === 25 && chain.endCell === 46 && chain.points.length === 4, "degree-one chain was split or truncated");
assert(JSON.stringify(chain.points) === "[[2,0],[2,2],[2,4],[2,6]]", "canonical cell-center points changed");
assert(left.order === 2 && left.class === "stream" && right.order === 2 && right.class === "stream",
  "incoming tributaries inherited the terminal confluence order");
assert(chain.order === 2 && chain.class === "stream", "order-2 class mapping changed");
for (const reach of reaches.reaches) {
  let current = reach.startCell;
  let expectedOrder = 0;
  while (current !== reach.endCell) {
    expectedOrder = Math.max(expectedOrder, field.streamOrder[current]);
    current = field.receiver[current];
  }
  assert(reach.order === expectedOrder, `reach ${reach.id} order does not match its owned outgoing edges`);
  assert(reach.class === (expectedOrder <= 2 ? "stream" : "river"), `reach ${reach.id} class does not match its edge order`);
}
assert(left.widths[0] === 2, `threshold-width channel starts at ${left.widths[0]}m instead of one cell`);
const expectedOutletWidth = 2 * Math.sqrt(28 / 12);
assert(Math.abs(left.widths[1] - expectedOutletWidth) <= Number.EPSILON * expectedOutletWidth * 4, "catchment width formula changed");
assert(chain.widths.length === chain.points.length && chain.widths.every((width: number) => Number.isFinite(width) && width > 0),
  "per-point widths are missing or invalid");
assert(chain.terrainElevationsM.length === chain.points.length && chain.surfaceElevationsM.length === chain.points.length,
  "per-point terrain/surface elevation channels are not aligned with reach points");
assert(chain.terrainElevationsM[0] === heights[chain.startCell]
  && chain.terrainElevationsM.at(-1) === heights[chain.endCell], "reach terrain elevations changed");
assert(chain.surfaceElevationsM[0] === field.filledHeightM[chain.startCell]
  && chain.surfaceElevationsM.at(-1) === field.filledHeightM[chain.endCell], "reach surface elevations changed");
assert(chain.waterfalls.length === 1 && chain.waterfalls[0].startSegment === 1 && chain.waterfalls[0].endSegmentExclusive === 2
  && chain.waterfalls[0].startCell === 32 && chain.waterfalls[0].endCell === 39, "waterfall span metadata changed");
assert(Object.isFrozen(reaches) && Object.isFrozen(reaches.reaches) && Object.isFrozen(chain.points[0])
  && Object.isFrozen(chain.widths) && Object.isFrozen(chain.terrainElevationsM)
  && Object.isFrozen(chain.surfaceElevationsM) && Object.isFrozen(chain.waterfalls[0]), "returned reach graph is mutable");
assert(JSON.stringify(extract(heights, field)) === JSON.stringify(reaches), "repeat extraction changed canonical output");

// Catchment and waterfall comparisons are inclusive at the exact authored threshold.
assert(reaches.reaches.some((reach: any) => reach.startCell === 22), "exact catchment threshold excluded cell 22");
const aboveThreshold = extract(heights, field, { recipe: recipe(12.000001) });
assert(!aboveThreshold.reaches.some((reach: any) => reach.startCell === 22 || reach.startCell === 29),
  "cells below a raised catchment threshold remained active");
const exactDrop = heights[32] - heights[39];
assert(extract(heights, field, { recipe: recipe(12, exactDrop) }).reaches[1].waterfalls.length === 1,
  "exact waterfall threshold excluded its edge");
assert(extract(heights, field, { recipe: recipe(12, exactDrop + 0.000001) }).reaches[1].waterfalls.length === 0,
  "edge below a raised waterfall threshold remained marked");

// A distant perimeter change does not alter the fixed active graph's stable cell-index ids.
const stableHeights = heights.slice();
stableHeights[48] += 1;
const stable = extract(stableHeights, build(7, 7, stableHeights));
assert(stable.reaches.map((reach: any) => reach.id).join(",") === reaches.reaches.map((reach: any) => reach.id).join(","),
  "unrelated terrain change altered stable reach ids");

// Proven ocean cells are inactive but remain the exact terminal point of an incoming active edge.
const oceanHeights = new Float64Array(49).fill(5);
for (const index of [0, 8, 16, 24]) oceanHeights[index] = -2;
oceanHeights[40] = -3;
const oceanField = build(7, 7, oceanHeights, { seaLevelM: 0 });
const ocean = extract(oceanHeights, oceanField, { recipe: recipe(4, 1), placement: { originX: 0, originZ: 0 } });
const oceanTerminal = ocean.reaches.find((reach: any) => reach.id === "gen-r-9-8");
assert(oceanTerminal?.points.length === 2 && oceanField.oceanMask[oceanTerminal.endCell] === 1,
  "active-to-ocean edge did not terminate at the ocean cell");
assert(!ocean.reaches.some((reach: any) => oceanField.oceanMask[reach.startCell] === 1), "ocean cell started a generated reach");

// Reach extraction is additive derived work: calling it cannot mutate or change basin output.
const pitHeights = new Float64Array(25).fill(10);
pitHeights[12] = 0;
const pitField = build(5, 5, pitHeights, { seaLevelM: -10 });
const pitInput = { heightsM: pitHeights, topology: pitField, placement: { originX: 0, originZ: 0 }, recipe: recipe(4, 1) };
const basinBefore = extractHydrologyBasins(pitInput);
extractHydrologyReaches(pitInput);
assert(JSON.stringify(extractHydrologyBasins(pitInput)) === JSON.stringify(basinBefore), "reach extraction changed basin output bytes");

// Inputs and topology channels are snapshotted before the first cancellation callback.
const mutableHeights = confluenceHeights();
const mutableField = build(7, 7, mutableHeights);
let mutationChecks = 0;
const isolated = extract(mutableHeights, mutableField, { control: { shouldCancel: () => {
  mutationChecks++;
  mutableHeights.fill(999);
  mutableField.receiver.fill(-1);
  mutableField.catchmentAreaM2.fill(0);
  return false;
} } });
assert(JSON.stringify(isolated.reaches) === JSON.stringify(reaches.reaches), "callback mutation changed reach output");
assert(mutationChecks >= 4, "cancellation callback was not polled across validation and reach extraction");

let cancellationChecks = 0;
const cancellation = rejects(() => extract(heights, field, { control: { shouldCancel: () => ++cancellationChecks === 2 } }),
  /cancelled/, "mid-operation cancellation was ignored");
assert(cancellation instanceof HydrologyWaterTopologyCancelledError && cancellationChecks === 2, "cancellation type/check count changed");

function invalid(input: unknown, pattern: RegExp, message: string): void {
  const error = rejects(() => extractHydrologyReaches(input as any), pattern, message);
  assert(error instanceof HydrologyWaterTopologyValidationError, `${message} did not use water-topology validation error`);
}
const validInput = () => ({ heightsM: heights.slice(), topology: build(7, 7, heights), placement: { originX: 0, originZ: 0 }, recipe: recipe() });
invalid(null, /plain object/, "null input accepted");
invalid({ ...validInput(), unknown: true }, /unknown field/, "unknown input field accepted");
{
  let calls = 0;
  const hostile = validInput();
  Object.defineProperty(hostile, "topology", { enumerable: true, get() { calls++; return field; } });
  invalid(hostile, /data field/, "topology accessor accepted");
  assert(calls === 0, "input validation invoked a topology accessor");
}
invalid({ ...validInput(), heightsM: new Float64Array(50).subarray(1) }, /complete non-shared/, "height subarray accepted");
invalid({ ...validInput(), heightsM: new Float64Array(48) }, /length does not match/, "wrong height count accepted");
invalid({ ...validInput(), recipe: { ...recipe(), precipitationMmPerYear: 501 } }, /precipitation does not match/, "rain mismatch accepted");
rejects(() => extractHydrologyReaches(validInput(), { shouldCancel: true } as any), /shouldCancel/, "non-function cancellation accepted");
if (typeof SharedArrayBuffer === "function") {
  invalid({ ...validInput(), heightsM: new Float64Array(new SharedArrayBuffer(49 * 8)) }, /non-shared/, "shared terrain accepted");
}

// A hostile width model result fails instead of clamping away the fixed formula.
const wideSize = 64;
const wideHeights = new Float32Array(wideSize * wideSize).fill(10);
const wideField = build(wideSize, wideSize, wideHeights, { cellSizeM: 4000, seaLevelM: -10 });
rejects(
  () => extract(wideHeights, wideField, { recipe: recipe(1, 1), placement: { originX: 0, originZ: 0 } }),
  new RegExp(`at most ${WATER_LIMITS.widthM}m`),
  "over-limit generated width was silently clamped",
);

const branchSize = 129;
const branchHeights = new Float32Array(branchSize * branchSize);
for (let index = 0; index < branchHeights.length; index++) {
  const mixed = Math.imul(1 ^ index, -1640531535) >>> 0;
  branchHeights[index] = (mixed % 100_000) / 100;
}
const branchField = build(branchSize, branchSize, branchHeights);
rejects(
  () => extract(branchHeights, branchField, { recipe: recipe(4, 1), placement: { originX: 0, originZ: 0 } }),
  new RegExp(`exceed ${WATER_LIMITS.waterways} waterways`),
  "hostile branching field did not fail at the Water IR reach cap",
);

// Maximum grid with an inactive threshold proves constant-channel linear scratch. Reusing the same
// topology at the inclusive cell threshold must reject aggregate geometry before tracing it.
const size = 1025, cells = size * size;
const benchmarkHeights = new Float32Array(cells);
for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) benchmarkHeights[row * size + col] = row + col * 0.001;
const benchmarkField = build(size, size, benchmarkHeights, { cellSizeM: 1.5, seaLevelM: -100 });
const benchmarkStart = globalThis.performance?.now() ?? Date.now();
const benchmark = extract(benchmarkHeights, benchmarkField, {
  recipe: recipe(1_000_000_000_000, 1),
  placement: { originX: -768, originZ: -768 },
});
const benchmarkMs = (globalThis.performance?.now() ?? Date.now()) - benchmarkStart;
assert(benchmark.reaches.length === 0 && benchmark.diagnostics.activeCellCount === 0, "maximum inactive field emitted a reach");
assert(benchmark.diagnostics.typedScratchBytes === cells * 3, "maximum field scratch is not three linear byte channels");
assert(benchmark.diagnostics.workUnits <= benchmark.diagnostics.workLimit, "maximum field exceeded bounded work");
rejects(
  () => extract(benchmarkHeights, benchmarkField, { recipe: recipe(2.25, 1), placement: { originX: -768, originZ: -768 } }),
  new RegExp(`exceeds ${WATER_LIMITS.totalWaterwayPoints} total points`),
  "maximum active field did not reject aggregate geometry before tracing",
);

ops.op_log(
  `[js] p_hydrology_reaches OK: confluence-exact directed edges, chain segmentation, inclusive thresholds, `
  + `stable ids, widths/order/classes, waterfalls, ocean terminals, strict caps and cancellation proven; `
  + `${cells} cells extracted in ${benchmarkMs.toFixed(1)}ms with ${(benchmark.diagnostics.typedScratchBytes / 1048576).toFixed(1)} MiB reach scratch `
  + `and ${benchmark.diagnostics.workUnits}/${benchmark.diagnostics.workLimit} work units.`,
);
