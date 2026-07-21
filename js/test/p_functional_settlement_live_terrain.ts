import { createResidentFunctionalSettlementTerrainSampler } from "../src/skills/functional-settlement-live-host.ts";
import type { EditableTerrain } from "../src/skills/terrain-edit.ts";
import type { RegionState } from "../src/skills/terrain.ts";
import type { TerrainSource, TerrainTile } from "../src/terrain/types.ts";

const assert = (value: unknown, message: string): asserts value => {
  if (!value) throw new Error(`p_functional_settlement_live_terrain FAIL: ${message}`);
};
const tile = (height: number): TerrainTile => ({
  nrows: 2,
  ncols: 2,
  origin: [120, 0, -120],
  scale: [48, 1, 48],
  heights: new Float32Array([height, height, height, height]),
});
const source = (height: number): TerrainSource => ({
  name: "proof-live-terrain",
  generateTile: () => tile(height),
  sampleHeight: () => height,
  sampleClimate: () => ({ tempC: 12, precipMm: 800, biome: 4 }),
});
const region = (): RegionState => ({
  seed: 77,
  lod: 0,
  tiles: new Map([["resident", { bodyId: 1, entity: "terrain/resident", eid: 1, tx: 2, tz: -3 }]]),
});

const regions = new Map<string, RegionState>();
const layers = new Map<string, EditableTerrain>();
let sampler = createResidentFunctionalSettlementTerrainSampler({ source: source(7), regions, layers });
assert(sampler(120, -120) === undefined, "non-resident source terrain was accepted");
regions.set("region/proof", region());
assert(sampler(120, -120) === 7, "resident generated terrain did not sample its live source authority");
assert(sampler(48, -120) === undefined, "point outside the applied tile was accepted");

layers.set("terrain/layer", { tile: tile(8), mesh: undefined, eid: 2, entity: "terrain/layer", bodyId: 2 });
assert(sampler(120, -120) === 8, "live editable deformation did not override the generated substrate");
layers.set("terrain/conflict", { tile: tile(9), mesh: undefined, eid: 3, entity: "terrain/conflict", bodyId: 3 });
assert(sampler(120, -120) === undefined, "conflicting overlapping editable layers did not fail closed");
layers.delete("terrain/conflict");
regions.set("region/conflict", { ...region(), seed: 78 });
sampler = createResidentFunctionalSettlementTerrainSampler({
  source: { ...source(8), sampleHeight: (seed) => seed === 77 ? 8 : 9 }, regions, layers: new Map(),
});
assert(sampler(120, -120) === undefined, "conflicting overlapping generated regions did not fail closed");
assert(sampler(Number.NaN, -120) === undefined, "non-finite coordinate was accepted");

console.log("p_functional_settlement_live_terrain OK: uncovered terrain rejects, editable deformation overrides generated substrate, and same-tier ambiguity fails closed");
