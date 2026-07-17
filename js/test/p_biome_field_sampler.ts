import {
  BIOME_FIELD_NONE,
  BIOME_FIELD_SCHEMA,
  BIOME_FIELD_VERSION,
  BIOME_FIELD_WEIGHT_TOTAL,
} from "../src/world/biome-field.mjs";
import { createBiomeFieldSampler } from "../src/world/biome-field-sampler.mjs";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_biome_field_sampler FAIL: ${message}`);
}

const full = BIOME_FIELD_WEIGHT_TOTAL;
const none = BIOME_FIELD_NONE;
const field = Object.freeze({
  schema: BIOME_FIELD_SCHEMA,
  version: BIOME_FIELD_VERSION,
  pack: Object.freeze({ id: "test-pack", version: "1.0.0" }),
  grid: Object.freeze({ origin: Object.freeze([100, -50]), rows: 2, cols: 2, cellSizeM: 10 }),
  topN: 2,
  biomeIds: Object.freeze(["boreal-forest", "grassland"]),
  // NW=boreal, NE=grassland, SW=grassland, SE=boreal.
  indices: new Uint16Array([0, none, 1, none, 1, none, 0, none]),
  weights: new Uint16Array([full, 0, full, 0, full, 0, full, 0]),
  diagnostics: Object.freeze({ cells: 4, workUnits: 8, outputBytes: 32, influences: 0, modifiers: 0 }),
});

const sampler = createBiomeFieldSampler(field);
assert(JSON.stringify(sampler.bounds) === JSON.stringify({ minX: 100, minZ: -50, maxX: 110, maxZ: -40 }), "world bounds are wrong");
const corner = sampler.sample(100, -50);
assert(corner?.dominantId === "boreal-forest", "exact cell did not preserve its dominant biome");
assert(corner.influences.length === 1 && corner.influences[0].weightU16 === full, "exact cell did not preserve full weight");

const center = sampler.sample(105, -45);
assert(center?.influences.length === 2, "center blend did not retain both biomes");
assert(center.dominantId === "boreal-forest", "equal blend tie did not resolve by stable biome id");
assert(center.influences[0].weightU16 === 32768 && center.influences[1].weightU16 === 32767, "center blend was not exact u16 normalized");
assert(center.influences.reduce((sum, influence) => sum + influence.weightU16, 0) === full, "center weights do not sum to 65535");
assert(sampler.sample(99.999, -45) === null && sampler.sample(105, -39.999) === null, "out-of-bounds sample leaked a biome");

const repeated = sampler.sample(105, -45);
assert(JSON.stringify(repeated) === JSON.stringify(center), "repeated sampling retained mutable scratch state");
let nonFinite: unknown;
try { sampler.sample(Number.NaN, 0); } catch (error) { nonFinite = error; }
assert(nonFinite instanceof TypeError, "non-finite query did not fail closed");

console.log("p_biome_field_sampler OK: validated world-coordinate sampling is bilinear, seam-free, deterministically ranked, exactly u16-normalized, bounded, and repeatable");
