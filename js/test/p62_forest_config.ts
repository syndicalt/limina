import { ops } from "../src/engine.ts";
import {
  DEFAULT_FOREST_CONFIG,
  parseForestConfig,
  serializeForestConfig,
} from "../src/game/forest-config.ts";
import {
  LAAS_PHOTOREAL,
  parseLookProfile,
  resolveLook,
  serializeLookProfile,
} from "../src/render/look-profile.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p62_forest_config: " + msg);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function assertThrows(fn: () => unknown, msg: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, msg);
}

const forestJsonA = serializeForestConfig(DEFAULT_FOREST_CONFIG);
const forestJsonB = serializeForestConfig(DEFAULT_FOREST_CONFIG);
assert(deepEqual(parseForestConfig(forestJsonA), DEFAULT_FOREST_CONFIG), "DEFAULT_FOREST_CONFIG must serialize/parse round-trip");
assert(forestJsonA === forestJsonB, "serializeForestConfig must be byte-identical across repeated calls");

const invalidMoisture = JSON.parse(forestJsonA) as typeof DEFAULT_FOREST_CONFIG;
invalidMoisture.climate.moisture01 = 2;
assertThrows(() => parseForestConfig(JSON.stringify(invalidMoisture)), "schema must reject 0..1 fields above 1");

const invalidSpecies = JSON.parse(forestJsonA) as typeof DEFAULT_FOREST_CONFIG;
invalidSpecies.canopy.species = [];
assertThrows(() => parseForestConfig(JSON.stringify(invalidSpecies)), "schema must reject empty canopy.species");

const invalidDensity = JSON.parse(forestJsonA) as typeof DEFAULT_FOREST_CONFIG;
invalidDensity.canopy.densityPerHa = -1;
assertThrows(() => parseForestConfig(JSON.stringify(invalidDensity)), "schema must reject negative densityPerHa");

const lookJson = serializeLookProfile(LAAS_PHOTOREAL);
assert(deepEqual(parseLookProfile(lookJson), LAAS_PHOTOREAL), "LAAS_PHOTOREAL must serialize/parse round-trip");

const resolved = resolveLook(LAAS_PHOTOREAL);
assert(resolved.shading === "pbr", `resolveLook shading mismatch: ${resolved.shading}`);
assert(resolved.sky === "hillaire", `resolveLook sky mismatch: ${resolved.sky}`);
assert(resolved.tonemap === "aces", `resolveLook tonemap mismatch: ${resolved.tonemap}`);
assert(resolved.volumetrics === true, "resolveLook volumetrics mismatch");
assert(resolved.gi === "probes", `resolveLook gi mismatch: ${resolved.gi}`);

ops.op_log("[js] p62_forest_config OK: ForestConfig and LookProfile schemas validate, reject invalid inputs, serialize deterministically, and resolve render choices");
