import { ops, EntityTable, type WorldContext } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { AssetRegistry } from "../src/asset-registry.ts";
import { MapTerrainSource } from "../src/terrain/map-source.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerTerrainEditSkills, type EditableTerrain } from "../src/skills/terrain-edit.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import {
  bakeMasterErosion,
  DEFAULT_MAP_EROSION_RECIPE,
  ErosionCancelledError,
  EROSION_RECIPE_SCHEMA,
  flowAccumulation,
  NO_EROSION_RECIPE,
  sliceMasterHeightfield,
  validateErosionRecipe,
} from "../src/world/pipeline/erosion.mjs";
import { rasterizeWorldMap } from "../src/world/pipeline/map-raster.mjs";
import type { WorldMap } from "../src/world/worldmap.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_map_erosion FAIL: ${message}`);
}

function rejects(run: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}

function equalBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const av = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const bv = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let index = 0; index < av.length; index++) if (av[index] !== bv[index]) return false;
  return true;
}

function relief(rows: number, cols: number, minimum = 60, range = 120): Float32Array {
  const heights = new Float32Array(rows * cols);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = (col / (cols - 1)) * 12;
      const z = (row / (rows - 1)) * 12;
      const value = 18 * Math.sin(x * 0.7) + 12 * Math.cos(z * 0.9) + 8 * Math.sin(x * 1.7 + z * 0.5) + 0.3 * (rows - row);
      heights[row * cols + col] = minimum + ((value + 40) / 100) * range;
    }
  }
  return heights;
}

const fixtureMap: WorldMap = {
  version: 1,
  id: "erosion-fixture",
  unitsPerMeter: 1,
  origin: [0, 0],
  extent: { w: 200, h: 200 },
  seaLevel: 0,
  land: [{ points: [[-90, -90], [90, -90], [90, 90], [-90, 90]] }],
  relief: [{ kind: "mountain", shape: { point: [0, 0] }, amplitude: 80 }],
  biomes: [],
  waterways: [{ points: [[-70, -20], [0, 0], [70, 30]], widthM: 6, class: "river" }],
  routes: [],
  anchors: [],
  provenance: { tool: "test", contentHash: "fixture" },
};

// Omitted and explicit-disabled recipes preserve every prior output byte.
const rasterOptions = { size: 200, resolution: 65, seed: 71, baseAmplitude: 80, noiseFrac: 0.2 };
const legacy = rasterizeWorldMap(fixtureMap, rasterOptions);
const disabled = rasterizeWorldMap(fixtureMap, { ...rasterOptions, erosion: NO_EROSION_RECIPE });
assert(disabled.erosionPasses === 0, "disabled recipe reported an erosion pass");
assert(equalBytes(legacy.heights, disabled.heights), "disabled mode changed legacy height bytes");
assert(equalBytes(legacy.paintMat, disabled.paintMat), "disabled mode changed legacy paint material bytes");
assert(equalBytes(legacy.paintW, disabled.paintW), "disabled mode changed legacy paint weight bytes");
assert(equalBytes(legacy.blight, disabled.blight), "disabled mode changed legacy blight bytes");

const enabledA = rasterizeWorldMap(fixtureMap, { ...rasterOptions, erosion: DEFAULT_MAP_EROSION_RECIPE });
const enabledB = rasterizeWorldMap(fixtureMap, { ...rasterOptions, erosion: DEFAULT_MAP_EROSION_RECIPE });
assert(enabledA.erosionPasses === 1, "enabled recipe did not run exactly one master pass");
assert(equalBytes(enabledA.heights, enabledB.heights), "identical map erosion was not byte deterministic");
assert(!equalBytes(enabledA.heights, legacy.heights), "enabled recipe did not alter the generated surface");

// Seed and recipe changes must affect hydraulic output.
const raw = relief(65, 65);
const baseJob = { heights: raw, rows: 65, cols: 65, seed: 123, recipe: DEFAULT_MAP_EROSION_RECIPE };
const baked = bakeMasterErosion(baseJob);
const otherSeed = bakeMasterErosion({ ...baseJob, seed: 124 });
const otherRecipe = bakeMasterErosion({
  ...baseJob,
  recipe: { ...DEFAULT_MAP_EROSION_RECIPE, rain: 0.35 },
});
assert(!equalBytes(baked.heights, otherSeed.heights), "erosion seed did not affect output");
assert(!equalBytes(baked.heights, otherRecipe.heights), "erosion recipe did not affect output");

// Chunking is a post-bake copy operation. Adjacent overlapping chunks share exact
// Float32 edge bytes because no chunk-local erosion can run.
const left = sliceMasterHeightfield(baked.heights, 65, 65, { row: 0, col: 0, rows: 65, cols: 33 });
const right = sliceMasterHeightfield(baked.heights, 65, 65, { row: 0, col: 32, rows: 65, cols: 33 });
for (let row = 0; row < 65; row++) {
  assert(Object.is(left[row * 33 + 32], right[row * 33]), `sliced chunk seam diverged at row ${row}`);
}

// Meaningful-flow control: the stronger accepted recipe must concentrate both
// peak and high-percentile D8 drainage, not merely blur the input.
const drainageRecipe = {
  ...DEFAULT_MAP_EROSION_RECIPE,
  rain: 1,
  thermal: 12,
  talus: 0.2,
  lifetime: 18,
  capacity: 6,
  erosionRate: 0.35,
};
const drainageRaw = relief(65, 65, 60, 120);
const drainageEroded = bakeMasterErosion({ heights: drainageRaw, rows: 65, cols: 65, seed: 123, recipe: drainageRecipe }).heights;
function flowStats(heights: Float32Array): { peak: number; p99: number } {
  const sorted = Float32Array.from(flowAccumulation(heights, 65, 65)).sort();
  return { peak: sorted[sorted.length - 1], p99: sorted[Math.floor(sorted.length * 0.99)] };
}
const rawFlow = flowStats(drainageRaw);
const erodedFlow = flowStats(drainageEroded);
assert(erodedFlow.peak > rawFlow.peak * 1.5,
  `erosion did not concentrate peak drainage (${rawFlow.peak} -> ${erodedFlow.peak})`);
assert(erodedFlow.p99 > rawFlow.p99 * 1.3,
  `erosion did not concentrate p99 drainage (${rawFlow.p99} -> ${erodedFlow.p99})`);

// Absolute authored elevations remain absolute. There is no percentile/min-max
// normalization in the map bake, including at Everest-scale u16-derived ranges.
const extreme = new Float32Array(65 * 65);
for (let row = 0; row < 65; row++) for (let col = 0; col < 65; col++) {
  extreme[row * 65 + col] = -500 + (9500 * col) / 64 + 20 * Math.sin(row * 0.3);
}
const extremeBake = bakeMasterErosion({ heights: extreme, rows: 65, cols: 65, seed: 9, recipe: DEFAULT_MAP_EROSION_RECIPE }).heights;
let extremeMin = Infinity, extremeMax = -Infinity;
for (const height of extremeBake) { extremeMin = Math.min(extremeMin, height); extremeMax = Math.max(extremeMax, height); }
assert(extremeMin < -400 && extremeMax > 8_500 && extremeMax - extremeMin > 8_900,
  `absolute elevation range was normalized or collapsed (${extremeMin}..${extremeMax})`);

// The streamed source must hold the same baked master as the one-shot raster
// compiler for identical domain, seed, amplitude, and recipe.
const streamed = new MapTerrainSource({
  worldMap: fixtureMap,
  seed: rasterOptions.seed,
  baseAmplitude: rasterOptions.baseAmplitude,
  erosionRecipe: DEFAULT_MAP_EROSION_RECIPE,
});
const streamedSize = streamed.masterStep * (streamed.masterRes - 1);
const streamedMaster = rasterizeWorldMap(fixtureMap, {
  size: streamedSize,
  resolution: streamed.masterRes,
  seed: rasterOptions.seed,
  baseAmplitude: rasterOptions.baseAmplitude,
  erosion: DEFAULT_MAP_EROSION_RECIPE,
});
const streamedHalf = streamedSize / 2;
for (let row = 0; row < streamed.masterRes; row += 7) {
  for (let col = 0; col < streamed.masterRes; col += 7) {
    const x = -streamedHalf + col * streamed.masterStep;
    const z = -streamedHalf + row * streamed.masterStep;
    assert(Object.is(
      streamed.sampleHeight(rasterOptions.seed, x, z, 0),
      streamedMaster.heights[row * streamed.masterRes + col],
    ), `streamed master diverged from one-shot compile at (${row},${col})`);
  }
}

// Strict and bounded configuration failures happen before simulation.
rejects(() => validateErosionRecipe({ ...NO_EROSION_RECIPE, rain: 1 }), /requires exactly/, "disabled recipe accepted tuning fields");
rejects(() => validateErosionRecipe({ ...DEFAULT_MAP_EROSION_RECIPE, typo: 1 }), /requires exactly/, "enabled recipe accepted an unknown field");
rejects(() => validateErosionRecipe({ ...DEFAULT_MAP_EROSION_RECIPE, schema: "limina.erosion-recipe/v2" }), /schema must be/, "unknown recipe version was accepted");
rejects(() => validateErosionRecipe({ ...DEFAULT_MAP_EROSION_RECIPE, rain: 0, thermal: 0 }), /use disabled/, "enabled no-op recipe was accepted");
rejects(() => validateErosionRecipe({ ...DEFAULT_MAP_EROSION_RECIPE, rain: Number.NaN }), /rain must be/, "non-finite recipe value was accepted");
const expensive = new Float32Array(513 * 513);
rejects(() => bakeMasterErosion({
  heights: expensive,
  rows: 513,
  cols: 513,
  seed: 1,
  recipe: { ...DEFAULT_MAP_EROSION_RECIPE, rain: 2, thermal: 32, lifetime: 64 },
}), /work estimate/, "unbounded erosion work was accepted");
let cancelled = false;
try { bakeMasterErosion(baseJob, { shouldCancel: () => true }); } catch (error) { cancelled = error instanceof ErosionCancelledError; }
assert(cancelled, "worker-boundary cancellation did not abort before simulation");

// End-to-end terrain.create forwarding: omitted and explicit-disabled remain
// byte-identical, while the versioned enabled recipe changes the actual layer.
function makeWorld(): WorldContext {
  const ecs = createEcsWorld();
  return {
    ecs,
    transforms: createTransformStorage(ecs),
    spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(),
    tags: new Map(),
    scene: { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown },
    camera: { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} },
    ops,
    mode: "headless",
  };
}
async function terrainCreate(erosion?: object): Promise<{ success: boolean; heights?: Float32Array; error?: unknown }> {
  const layers = new Map<string, EditableTerrain>();
  const registry = new SkillRegistry(new LiminaTracer(`ses_map_erosion_${erosion === undefined ? "legacy" : JSON.stringify(erosion)}`));
  registerTerrainEditSkills(registry, layers, new AssetRegistry());
  const response = await registry.invoke("terrain.create", {
    size: 200,
    resolution: 65,
    generate: {
      source: "map",
      mapAssetId: "maps/primary.worldmap.json",
      seed: 71,
      amplitude: 30,
      ...(erosion === undefined ? {} : { erosion }),
    },
  }, {
    agentId: "agt_map_erosion",
    sessionId: "ses_map_erosion",
    permissions: resolveProfile("builder.readWrite"),
    tick: 1,
    world: makeWorld(),
  });
  if (!response.success) return { success: false, error: response.error };
  const entity = (response.result as { entity: string }).entity;
  return { success: true, heights: layers.get(entity)!.tile.heights };
}

const sourceRecorder = new WorldRecorder("ses_map_erosion_source_record");
const sourceRegistry = new SkillRegistry(new LiminaTracer("ses_map_erosion_source_record"));
const sourceCore = registerCoreSkills(sourceRegistry);
sourceRecorder.attach(sourceRegistry);
const sourceResponse = await sourceRegistry.invoke("world.setTerrainSource", {
  kind: "map",
  mapAssetId: "maps/primary.worldmap.json",
  seed: 71,
  baseAmplitude: 30,
  erosion: DEFAULT_MAP_EROSION_RECIPE,
}, {
  agentId: "agt_map_erosion",
  sessionId: "ses_map_erosion_source_record",
  permissions: resolveProfile("builder.readWrite"),
  tick: 1,
  world: makeWorld(),
});
assert(sourceResponse.success && sourceCore.terrain.source.name === "map", "recorded streamed source did not bind");
const sourceCommand = sourceRecorder.commands.find((command) =>
  command.kind === "skill" && command.tool === "world.setTerrainSource"
);
assert(sourceCommand?.kind === "skill" && sourceCommand.input.seed === 71 && sourceCommand.input.baseAmplitude === 30,
  "streamed source command did not record raster seed/amplitude");
assert(sourceCommand?.kind === "skill" && JSON.stringify(sourceCommand.input.erosion) === JSON.stringify(DEFAULT_MAP_EROSION_RECIPE),
  "streamed source command did not record the canonical erosion recipe");
assert(sourceCommand?.kind === "skill", "streamed source command was not recorded as a skill");
const replayRegistry = new SkillRegistry(new LiminaTracer("ses_map_erosion_source_replay"));
const replayCore = registerCoreSkills(replayRegistry);
const replaySourceResponse = await replayRegistry.invoke(sourceCommand.tool, sourceCommand.input, {
  agentId: sourceCommand.actorId,
  sessionId: sourceCommand.sessionId,
  permissions: new Set(sourceCommand.perms),
  tick: sourceCommand.tick,
  world: makeWorld(),
});
assert(replaySourceResponse.success && replayCore.terrain.source.name === "map", "recorded streamed recipe did not replay");
for (const [x, z] of [[-40, -40], [0, 0], [40, 20]] as const) {
  assert(Object.is(
    sourceCore.terrain.source.sampleHeight(71, x, z, 0),
    replayCore.terrain.source.sampleHeight(71, x, z, 0),
  ), `recorded streamed recipe replay diverged at (${x},${z})`);
}

const layerLegacy = await terrainCreate();
const layerDisabled = await terrainCreate(NO_EROSION_RECIPE);
const layerEnabled = await terrainCreate(DEFAULT_MAP_EROSION_RECIPE);
assert(layerLegacy.success && layerDisabled.success && layerEnabled.success, "terrain.create erosion integration failed");
assert(equalBytes(layerLegacy.heights!, layerDisabled.heights!), "terrain.create disabled mode changed legacy bytes");
assert(!equalBytes(layerLegacy.heights!, layerEnabled.heights!), "terrain.create ignored enabled map erosion recipe");
const malformedLayer = await terrainCreate({ schema: EROSION_RECIPE_SCHEMA, enabled: false, rain: 1 });
assert(!malformedLayer.success, "terrain.create accepted malformed disabled recipe");

ops.op_log(
  `p_map_erosion OK: deterministic master bake, exact disabled compatibility, seed/recipe sensitivity, ` +
  `seam-free slicing, meaningful D8 flow, absolute ${extremeMin.toFixed(1)}..${extremeMax.toFixed(1)}m range, strict bounds, cancellation, and terrain.create forwarding`,
);
