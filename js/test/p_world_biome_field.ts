import { BIOME_FIELD_NONE, BiomeFieldCancelledError } from "../src/world/biome-field.mjs";
import {
  WORLD_BIOME_AUTHORED_TARGETS,
  WORLD_BIOME_FIELD_POLICY,
  WorldBiomeFieldCancelledError,
  compileWorldBiomeField,
} from "../src/world/compiler/world-biome-field.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_world_biome_field FAIL: ${message}`);
}
function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(`${error.name}: ${error.message}`),
    `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}

function fixture(kind = "grass", heights = new Float32Array(9), oceanCell = 0) {
  const map = { seaLevel: 0, biomes: [{ biome: kind }], hydrology: { schema: "limina.hydrology-recipe/v1" } };
  const terrainField = {
    bounds: { minX: -10, minZ: -10, maxX: 10, maxZ: 10 }, half: 10,
    masterRes: 3, masterStep: 10, seaLevelM: 0,
    heightsM: new Float32Array(heights), biomeCell: new Uint8Array(9).fill(1), biomeKinds: [kind],
  };
  const oceanMask = new Uint8Array(9);
  oceanMask[oceanCell] = 1;
  const hydrologyTopology = { rows: 3, cols: 3, cellSizeM: 10, oceanMask };
  const generatedWaterTopology = {
    rows: 3, cols: 3, cellSizeM: 10, placement: { originX: -10, originZ: -10 }, basins: [], reaches: [],
  };
  return { worldMap: map, terrainField, hydrologyTopology, generatedWaterTopology, shouldCancel: () => false };
}

function weight(field: any, cell: number, biomeId: string): number {
  for (let rank = 0; rank < field.topN; rank++) {
    const offset = cell * field.topN + rank, index = field.indices[offset];
    if (index !== BIOME_FIELD_NONE && field.biomeIds[index] === biomeId) return field.weights[offset];
  }
  return 0;
}

const flat = compileWorldBiomeField(fixture());
assert(flat.grid.rows === 3 && flat.grid.cols === 3 && flat.grid.origin[0] === -10 && flat.grid.origin[1] === -10
  && flat.grid.cellSizeM === 10, "world biome field did not preserve the exact terrain master grid");
assert(weight(flat, 0, "deep-ocean") > 60_000, "hydrology ocean source cell did not resolve to pinned deep-ocean target");
assert(weight(flat, 0, "grassland") === 0 && weight(flat, 0, "canyon") === 0,
  "hydrology-covered cell retained land semantic or slope modifiers");
assert(weight(flat, 1, "river") > 0, "exact water-distance transform did not activate the pinned riparian target");
assert(weight(flat, 4, "grassland") > 0 && weight(flat, 4, "badlands") === 0 && weight(flat, 4, "crystal") === 0,
  "authored grass semantics leaked into broad geological/fantasy climate bands");

const forest = compileWorldBiomeField(fixture("forest"));
assert(weight(forest, 4, "temperate-deciduous-forest") > 0 && weight(forest, 4, "blighted-waste") === 0,
  "authored forest semantics did not resolve to the explicit legacy target");

const desert = compileWorldBiomeField(fixture("desert"));
assert(JSON.stringify([...desert.indices, ...desert.weights]) !== JSON.stringify([...flat.indices, ...flat.weights]),
  "authored-region temperature/precipitation climate did not change canonical biome weights");

const highHeights = new Float32Array(9);
highHeights[4] = 450;
const high = compileWorldBiomeField(fixture("grass", highHeights));
assert(weight(high, 4, "alpine") > weight(flat, 4, "alpine"),
  "pre-edit globally eroded elevation did not activate the alpine modifier");
assert(weight(high, 1, "canyon") > weight(flat, 1, "canyon"),
  "one-sided/central atan-normalized terrain gradient did not activate the canyon modifier");

const movedWater = compileWorldBiomeField(fixture("grass", new Float32Array(9), 8));
assert(weight(movedWater, 8, "deep-ocean") > 60_000 && weight(movedWater, 0, "deep-ocean") < 60_000,
  "moving the canonical hydrology source did not move the water-distance biome response");
assert(WORLD_BIOME_FIELD_POLICY.modifiers.map((modifier) => `${modifier.id}:${modifier.targetBiomeId}`).join(",")
  === "compiled-alpine-elevation:alpine,compiled-canyon-slope:canyon,compiled-deep-ocean-water:deep-ocean,compiled-riparian-water:river",
"pinned environmental modifier IDs or targets changed");
assert(WORLD_BIOME_AUTHORED_TARGETS.forest === "temperate-deciduous-forest"
  && WORLD_BIOME_FIELD_POLICY.authoredInfluences.includes("exclusive-semantic-baseline"),
"authored semantic baseline policy is not pinned");

let polls = 0;
rejects(() => compileWorldBiomeField({ ...fixture(), shouldCancel: () => ++polls === 2 }), /cancelled/,
  "compiler callback cancellation was not translated to the world biome boundary");
assert(polls === 2, "world biome cancellation polling was not deterministic in the fixture");
const mismatched = fixture();
mismatched.generatedWaterTopology = { ...mismatched.generatedWaterTopology, placement: { originX: -9, originZ: -10 } };
rejects(() => compileWorldBiomeField(mismatched), /exact master grid/, "mismatched generated-water source grid was accepted");
const singleton = fixture();
singleton.terrainField = { ...singleton.terrainField, masterRes: 1, masterStep: 1, heightsM: new Float32Array(1), biomeCell: new Uint8Array([1]) };
singleton.hydrologyTopology = { ...singleton.hydrologyTopology, rows: 1, cols: 1, cellSizeM: 1, oceanMask: new Uint8Array([1]) };
singleton.generatedWaterTopology = { ...singleton.generatedWaterTopology, rows: 1, cols: 1, cellSizeM: 1 };
rejects(() => compileWorldBiomeField(singleton), /at least 2/, "singleton master grid reached zero slope denominators");
assert(!(new WorldBiomeFieldCancelledError() instanceof BiomeFieldCancelledError),
  "world/compiler cancellation domains unexpectedly alias each other");

console.log("[js] p_world_biome_field OK: pinned climate, elevation, slope, hydrology-distance, source fencing, and cancellation policies proven");
