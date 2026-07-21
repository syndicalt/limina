import { ops } from "../src/engine.ts";
import { createHydrologyTopology } from "../src/world/hydrology-topology.mjs";
import {
  HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA,
  extractHydrologyBasins,
  extractHydrologyReaches,
  extractHydrologyWaterTopology,
} from "../src/world/hydrology-water-topology.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_hydrology_water_topology FAIL: ${message}`);
}

function heightsForConfluence(): Float64Array {
  const heights = new Float64Array(49);
  for (let index = 0; index < heights.length; index++) {
    const mixed = Math.imul(1 ^ index, -1640531535) >>> 0;
    heights[index] = (mixed % 1000) / 10;
  }
  heights[3] = 0;
  return heights;
}

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

const heights = heightsForConfluence();
const topology = field(7, 7, heights);
const input = { heightsM: heights, topology, placement: { originX: -6, originZ: -6 }, recipe };
const basins = extractHydrologyBasins(input);
const reaches = extractHydrologyReaches(input);
const combined = extractHydrologyWaterTopology(input);
assert(combined.schema === HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA && combined.version === 1, "combined identity changed");
assert(JSON.stringify(combined.basins) === JSON.stringify(basins.basins), "combined basin pass differs from the existing wrapper");
assert(JSON.stringify(combined.reaches) === JSON.stringify(reaches.reaches), "combined reach pass differs from the existing wrapper");
assert(combined.diagnostics.verificationPasses === 1, "combined extraction did not report one input verification");
assert(combined.basins.length === 3 && combined.reaches.length === 3, "fixed both-section vector changed");
for (const reach of combined.reaches) {
  assert(reach.points.length === reach.widths.length
    && reach.points.length === reach.terrainElevationsM.length
    && reach.points.length === reach.surfaceElevationsM.length, `reach ${reach.id} aligned channels diverged`);
}
assert(Object.isFrozen(combined) && Object.isFrozen(combined.basins) && Object.isFrozen(combined.reaches)
  && Object.isFrozen(combined.diagnostics) && Object.isFrozen(combined.diagnostics.basins), "combined result is mutable");
assert(JSON.stringify(extractHydrologyWaterTopology(input)) === JSON.stringify(combined), "combined extraction is not repeat deterministic");

// All source channels are snapshotted once before callback-driven mutation can race either pass.
const mutableHeights = heightsForConfluence();
const mutableTopology = field(7, 7, mutableHeights);
let checks = 0;
const isolated = extractHydrologyWaterTopology({
  heightsM: mutableHeights,
  topology: mutableTopology,
  placement: { originX: -6, originZ: -6 },
  recipe,
}, { shouldCancel: () => {
  checks++;
  mutableHeights.fill(999);
  mutableTopology.filledHeightM.fill(999);
  mutableTopology.receiver.fill(-1);
  return false;
} });
assert(JSON.stringify(isolated.basins) === JSON.stringify(combined.basins), "callback mutation changed combined basins");
assert(JSON.stringify(isolated.reaches) === JSON.stringify(combined.reaches), "callback mutation changed combined reaches");
assert(checks >= 6, "combined validation and both passes did not poll cancellation");

// Maximum supported grid with no selected water proves one verification and bounded sequential passes.
const size = 1025, cells = size * size;
const maximumHeights = new Float32Array(cells);
for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) maximumHeights[row * size + col] = row + col * 0.001;
const maximumTopology = field(size, size, maximumHeights, { cellSizeM: 1.5, seaLevelM: -100 });
const inactiveRecipe = { ...recipe, riverMinCatchmentAreaM2: 1_000_000_000_000, basinMinAreaM2: 1_000_000_000_000, basinMinDepthM: 20_000 };
const start = globalThis.performance?.now() ?? Date.now();
const maximum = extractHydrologyWaterTopology({
  heightsM: maximumHeights,
  topology: maximumTopology,
  placement: { originX: -768, originZ: -768 },
  recipe: inactiveRecipe,
});
const elapsed = (globalThis.performance?.now() ?? Date.now()) - start;
assert(maximum.basins.length === 0 && maximum.reaches.length === 0, "maximum inactive field emitted generated water");
assert(maximum.diagnostics.verificationPasses === 1, "maximum combined field repeated verification");
assert(maximum.diagnostics.basins.typedScratchBytes <= cells * 45 && maximum.diagnostics.reaches.typedScratchBytes === cells * 3,
  "maximum combined scratch exceeded linear channel bounds");

ops.op_log(
  `[js] p_hydrology_water_topology OK: one verified snapshot feeds byte-compatible basin/reach passes with aligned elevation channels; `
  + `${cells} cells combined in ${elapsed.toFixed(1)}ms, basin/reach scratch `
  + `${(maximum.diagnostics.basins.typedScratchBytes / 1048576).toFixed(1)}/${(maximum.diagnostics.reaches.typedScratchBytes / 1048576).toFixed(1)} MiB.`,
);
