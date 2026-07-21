import { ops } from "../src/engine.ts";
import { createHydrologyTopology } from "../src/world/hydrology-topology.mjs";
import {
  HYDROLOGY_WATER_TOPOLOGY_SCHEMA,
  HydrologyWaterTopologyCancelledError,
  HydrologyWaterTopologyValidationError,
  extractHydrologyBasins,
} from "../src/world/hydrology-water-topology.mjs";
import { inspectWaterBodyTopology, WATER_LIMITS } from "../src/world/water-ir.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_hydrology_basins FAIL: ${message}`);
}

function rejects(fn: () => unknown, pattern: RegExp, message: string): Error {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
  return error;
}

const recipe = Object.freeze({
  schema: "limina.hydrology-recipe/v1",
  precipitationMmPerYear: 500,
  riverMinCatchmentAreaM2: 4,
  basinMinAreaM2: 1,
  basinMinDepthM: 1,
  waterfallMinDropM: 1,
});

function topology(rows: number, cols: number, heightsM: Float32Array | Float64Array, overrides: Record<string, unknown> = {}): any {
  return createHydrologyTopology({
    rows, cols, heightsM, cellSizeM: 2, seaLevelM: -10,
    precipitationMmPerYear: 500, ...overrides,
  });
}

function extract(rows: number, cols: number, heightsM: Float32Array | Float64Array, overrides: Record<string, unknown> = {}): any {
  const field = topology(rows, cols, heightsM, overrides.topology as Record<string, unknown> ?? {});
  return extractHydrologyBasins({
    heightsM,
    topology: field,
    placement: overrides.placement ?? { originX: 0, originZ: 0 },
    recipe: overrides.recipe ?? recipe,
  }, overrides.control as any);
}

function signedArea(ring: readonly (readonly number[])[]): number {
  const origin = ring[0];
  let twice = 0;
  for (let index = 1; index < ring.length - 1; index++) {
    twice += (ring[index][0] - origin[0]) * (ring[index + 1][1] - origin[1])
      - (ring[index + 1][0] - origin[0]) * (ring[index][1] - origin[1]);
  }
  return twice / 2;
}

// One closed pit pins midpoint geometry, inclusive thresholds, portable id, ownership and repeat bytes.
const pitHeights = new Float64Array(25).fill(10);
pitHeights[12] = 0;
const pit = extract(5, 5, pitHeights);
assert(pit.schema === HYDROLOGY_WATER_TOPOLOGY_SCHEMA && pit.version === 1, "basin topology identity changed");
assert(pit.basins.length === 1, `pit emitted ${pit.basins.length} basins`);
const pitBasin = pit.basins[0];
assert(pitBasin.id === "gen-b-6-c", `pit id changed to ${pitBasin.id}`);
assert(pitBasin.spillLevelM === 10 && pitBasin.maxDepthM === 10 && pitBasin.cellCount === 1, "pit metrics changed");
assert(pitBasin.areaM2 === 2, `single-sample midpoint diamond area changed to ${pitBasin.areaM2}`);
assert(JSON.stringify(pitBasin.footprint.points) === "[[3,4],[4,3],[5,4],[4,5]]", "pit canonical ring changed");
assert(signedArea(pitBasin.footprint.points) > 0, "outer ring is not CCW");
assert(Object.isFrozen(pit) && Object.isFrozen(pit.basins) && Object.isFrozen(pitBasin)
  && Object.isFrozen(pitBasin.footprint) && Object.isFrozen(pitBasin.footprint.points[0]), "returned basin graph is mutable");
assert(JSON.stringify(extract(5, 5, pitHeights)) === JSON.stringify(pit), "repeat extraction changed canonical output");

const inclusive = extract(5, 5, pitHeights, { recipe: { ...recipe, basinMinAreaM2: 2, basinMinDepthM: 10 } });
assert(inclusive.basins.length === 1, "exact area/depth threshold excluded a basin");
assert(extract(5, 5, pitHeights, { recipe: { ...recipe, basinMinAreaM2: 2.000001 } }).basins.length === 0, "area threshold below candidate was ignored");
assert(extract(5, 5, pitHeights, { recipe: { ...recipe, basinMinDepthM: 10.000001 } }).basins.length === 0, "depth threshold below candidate was ignored");

// Flat terrain has no raised samples. Proven ocean samples are never emitted as standing basins.
assert(extract(5, 5, new Float64Array(25).fill(7)).basins.length === 0, "flat terrain emitted a basin");
const oceanHeights = new Float64Array(49).fill(5);
for (const index of [0, 8, 16, 24]) oceanHeights[index] = -2;
assert(extract(7, 7, oceanHeights, { topology: { seaLevelM: 0 } }).basins.length === 0, "connected ocean emitted a basin");

// Equal-spill components remain distinct and keep ids when a distant non-basin height changes.
const multipleHeights = new Float64Array(49).fill(10);
multipleHeights[16] = 2;
multipleHeights[32] = 4;
const multipleA = extract(7, 7, multipleHeights);
assert(multipleA.basins.length === 2, `two pits emitted ${multipleA.basins.length} basins`);
assert(multipleA.basins[0].spillLevelM === 10 && multipleA.basins[1].spillLevelM === 10, "equal spill levels diverged");
const stableHeights = multipleHeights.slice();
stableHeights[26] = 11;
const multipleB = extract(7, 7, stableHeights);
assert(multipleB.basins.map((basin: any) => basin.id).join(",") === multipleA.basins.map((basin: any) => basin.id).join(","),
  "unrelated non-basin height changed stable ids");

// A raised ring around an unraised summit must become one outer with one clockwise hole.
const holeHeights = new Float64Array(81).fill(10);
for (let row = 2; row <= 6; row++) for (let col = 2; col <= 6; col++) holeHeights[row * 9 + col] = 0;
holeHeights[4 * 9 + 4] = 10;
const hole = extract(9, 9, holeHeights);
assert(hole.basins.length === 1 && hole.basins[0].footprint.holes?.length === 1, "island did not produce one basin hole");
assert(signedArea(hole.basins[0].footprint.points) > 0 && signedArea(hole.basins[0].footprint.holes[0]) < 0,
  "outer/hole orientation contract changed");
assert(inspectWaterBodyTopology([{ footprint: hole.basins[0].footprint }]).ok, "hole footprint is not simple Water IR topology");

// Diagonal positive samples are separate under 4-connectivity. A same-label diagonal pinch joined
// around the quad remains manifold under the fixed positive-disconnected 0101 decision.
const diagonalHeights = new Float64Array(49).fill(10);
diagonalHeights[2 * 7 + 2] = 0;
diagonalHeights[3 * 7 + 3] = 0;
assert(extract(7, 7, diagonalHeights).basins.length === 2, "diagonal pits merged across a corner");
const pinchHeights = new Float64Array(81).fill(10);
for (const [row, col] of [[2, 2], [3, 3], [2, 1], [3, 1], [4, 1], [4, 2], [4, 3]]) pinchHeights[row * 9 + col] = 0;
const pinch = extract(9, 9, pinchHeights);
assert(pinch.basins.length === 1, "4-connected pinched component split or failed");
assert(inspectWaterBodyTopology([{ footprint: pinch.basins[0].footprint }]).ok, "pinched component emitted invalid topology");

// Inputs are snapshotted before callbacks. Callback mutation cannot race derived output.
const mutableHeights = pitHeights.slice();
const mutableTopology = topology(5, 5, mutableHeights);
let mutationChecks = 0;
const isolated = extractHydrologyBasins({
  heightsM: mutableHeights,
  topology: mutableTopology,
  placement: { originX: 0, originZ: 0 },
  recipe,
}, { shouldCancel: () => {
  mutationChecks++;
  mutableHeights.fill(999);
  mutableTopology.filledHeightM.fill(999);
  return false;
} });
assert(JSON.stringify(isolated.basins) === JSON.stringify(pit.basins), "callback mutation changed basin output");
assert(mutationChecks >= 4, "cancellation callback was not polled across validation and extraction");

let cancellationChecks = 0;
const cancellation = rejects(() => {
  const heights = new Float64Array(128 * 128).fill(10);
  heights[64 * 128 + 64] = 0;
  const field = topology(128, 128, heights);
  extractHydrologyBasins({ heightsM: heights, topology: field, placement: { originX: 0, originZ: 0 }, recipe }, {
    shouldCancel: () => ++cancellationChecks === 2,
  });
}, /cancelled/, "mid-operation cancellation was ignored");
assert(cancellation instanceof HydrologyWaterTopologyCancelledError && cancellationChecks === 2, "cancellation type/check count changed");

function invalid(input: unknown, pattern: RegExp, message: string): void {
  const error = rejects(() => extractHydrologyBasins(input as any), pattern, message);
  assert(error instanceof HydrologyWaterTopologyValidationError, `${message} did not use basin validation error`);
}
const validInput = () => ({ heightsM: pitHeights.slice(), topology: topology(5, 5, pitHeights), placement: { originX: 0, originZ: 0 }, recipe });
invalid(null, /plain object/, "null input accepted");
invalid({ ...validInput(), extra: true }, /unknown field/, "unknown input field accepted");
{
  let getterCalls = 0;
  const hostile = validInput();
  Object.defineProperty(hostile, "heightsM", { enumerable: true, get() { getterCalls++; return pitHeights; } });
  invalid(hostile, /data field/, "height accessor accepted");
  assert(getterCalls === 0, "input validation invoked a height accessor");
}
invalid({ ...validInput(), heightsM: new Float64Array(26).subarray(1) }, /complete non-shared/, "height subarray accepted");
invalid({ ...validInput(), heightsM: new Float64Array(24) }, /length does not match/, "mismatched height count accepted");
{
  const heights = pitHeights.slice();
  heights[12] = NaN;
  invalid({ ...validInput(), heightsM: heights }, /heightsM\[12\]/, "NaN height accepted");
}
invalid({ ...validInput(), recipe: { ...recipe, precipitationMmPerYear: 501 } }, /precipitation does not match/, "recipe/topology rain mismatch accepted");
invalid({ ...validInput(), placement: { originX: WATER_LIMITS.absCoordinateM + 10, originZ: 0 } }, /coordinate/, "out-of-Water-IR placement accepted");
rejects(() => extractHydrologyBasins(validInput(), { shouldCancel: true } as any), /shouldCancel/, "non-function cancellation accepted");
if (typeof SharedArrayBuffer === "function") {
  invalid({ ...validInput(), heightsM: new Float64Array(new SharedArrayBuffer(25 * 8)) }, /non-shared/, "shared height buffer accepted");
}

// More than the Water IR body cap fails before retaining hostile per-component JS graphs.
const hostileSize = 131;
const hostileHeights = new Float32Array(hostileSize * hostileSize).fill(10);
for (let row = 1; row < hostileSize - 1; row++) for (let col = 1; col < hostileSize - 1; col++) {
  if (((row + col) & 1) === 0) hostileHeights[row * hostileSize + col] = 0;
}
rejects(
  () => extract(hostileSize, hostileSize, hostileHeights),
  new RegExp(`exceed ${WATER_LIMITS.bodies} bodies`),
  "hostile component count did not fail at the Water IR body cap",
);

// A comb contour that remains genuinely complex after exact collinear removal fails explicitly.
// The extractor does not pretend that an unconstrained geometric simplification is topology-safe.
const combSize = 263, combRow = 131;
const combHeights = new Float32Array(combSize * combSize).fill(10);
for (let col = 1; col < combSize - 1; col++) combHeights[combRow * combSize + col] = 0;
for (let col = 1; col < combSize - 1; col += 2) {
  const end = ((col >> 1) & 1) === 0 ? combSize - 3 : 2;
  for (let row = Math.min(combRow, end); row <= Math.max(combRow, end); row++) combHeights[row * combSize + col] = 0;
}
rejects(
  () => extract(combSize, combSize, combHeights),
  new RegExp(`exceeds ${WATER_LIMITS.ringPoints} points in one ring`),
  "over-limit unsimplifiable contour did not fail explicitly",
);

// Maximum field proves linear typed working storage and bounded cancellation/work on a no-basin slope.
const size = 1025, cells = size * size;
const benchmarkHeights = new Float32Array(cells);
for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) benchmarkHeights[row * size + col] = row + col * 0.001;
const benchmarkTopology = topology(size, size, benchmarkHeights, { cellSizeM: 1.5, seaLevelM: -100, precipitationMmPerYear: 500 });
const benchmarkStart = globalThis.performance?.now() ?? Date.now();
const benchmark = extractHydrologyBasins({
  heightsM: benchmarkHeights,
  topology: benchmarkTopology,
  placement: { originX: -768, originZ: -768 },
  recipe,
});
const benchmarkMs = (globalThis.performance?.now() ?? Date.now()) - benchmarkStart;
assert(benchmark.basins.length === 0 && benchmark.diagnostics.componentCount === 0, "maximum monotone field emitted a basin");
assert(benchmark.diagnostics.workUnits <= benchmark.diagnostics.workLimit, "maximum field exceeded bounded extraction work");
assert(benchmark.diagnostics.ownedTerrainBytes === cells * 8, "maximum field owned terrain snapshot size changed");
assert(benchmark.diagnostics.typedScratchBytes <= cells * 45, "maximum field typed scratch exceeded its linear bound");

ops.op_log(
  `[js] p_hydrology_basins OK: deterministic 4-connected spill/depth/area basins, midpoint outer/hole contours, `
  + `inclusive thresholds, stable ids, ocean/flat exclusion, strict caps and cancellation proven; `
  + `${cells} cells extracted in ${benchmarkMs.toFixed(1)}ms with ${(benchmark.diagnostics.typedScratchBytes / 1048576).toFixed(1)} MiB scratch `
  + `and ${benchmark.diagnostics.workUnits}/${benchmark.diagnostics.workLimit} work units.`,
);
