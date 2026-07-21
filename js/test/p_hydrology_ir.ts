// WB-W1 hydrology source gate: strict optional recipe from canonical Atlas MapDoc through the
// WorldMap hash boundary, without changing any legacy bytes or producing derived topology.

import { ops } from "../src/engine.ts";
import { compileAtlasMapDoc, compileDesignMap } from "../src/world/design-map-compile.mjs";
import {
  HYDROLOGY_LIMITS,
  HYDROLOGY_RECIPE_SCHEMA,
  HydrologyIrValidationError,
  parseAuthoredHydrologyRecipe,
} from "../src/world/hydrology-ir.mjs";
import { canonicalMapDocText } from "../src/world/mapdoc-canonical.mjs";
import { createWaterField } from "../src/world/water-field.mjs";
import {
  stableStringifyWorldMap,
  verifyWorldMap,
  WorldMapSchema,
  worldMapContentHash,
  type WorldMap,
} from "../src/world/worldmap.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_hydrology_ir FAIL: ${message}`);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function rejects(fn: () => unknown, pattern: RegExp, message: string): Error {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
  return error;
}

const recipe = {
  schema: HYDROLOGY_RECIPE_SCHEMA,
  precipitationMmPerYear: 875,
  riverMinCatchmentAreaM2: 125_000,
  basinMinAreaM2: 4_000,
  basinMinDepthM: 0.75,
  waterfallMinDropM: 2.5,
};

const parsedRecipe = parseAuthoredHydrologyRecipe(recipe);
assert(parsedRecipe !== recipe && Object.isFrozen(parsedRecipe), "recipe parser did not return an immutable clone");
assert(JSON.stringify(parsedRecipe) === JSON.stringify(recipe), "recipe parser changed canonical values or field order");

const legacy: WorldMap = {
  version: 1,
  id: "legacy",
  unitsPerMeter: 1,
  origin: [0, 0],
  extent: { w: 10, h: 10 },
  seaLevel: 0,
  land: [],
  relief: [],
  biomes: [],
  waterways: [{ points: [[0, 0], [1, 1]], widthM: 3, class: "river" }],
  routes: [],
  anchors: [],
  provenance: { tool: "design-space", sourceHash: "abc", contentHash: "legacy-hash" },
};
const LEGACY_BYTES = "{\"version\":1,\"id\":\"legacy\",\"unitsPerMeter\":1,\"origin\":[0,0],\"extent\":{\"w\":10,\"h\":10},\"seaLevel\":0,\"land\":[],\"relief\":[],\"biomes\":[],\"waterways\":[{\"points\":[[0,0],[1,1]],\"widthM\":3,\"class\":\"river\"}],\"routes\":[],\"anchors\":[],\"provenance\":{\"tool\":\"design-space\",\"sourceHash\":\"abc\",\"contentHash\":\"legacy-hash\"}}";
assert(stableStringifyWorldMap(legacy) === LEGACY_BYTES, "optional hydrology changed legacy WorldMap bytes");
assert(worldMapContentHash(legacy) === "3f62ab4461c69ce36c6a26847bd47b64beb2d9747c60d6c3d49c847e678508b3", "optional hydrology changed legacy WorldMap hash");
assert(!("hydrology" in WorldMapSchema.parse(legacy)), "WorldMap parser materialized a default hydrology recipe");

const mapDoc = {
  version: 2,
  activeMapId: "primary",
  maps: [
    {
      id: "inactive",
      name: "Inactive",
      scope: "site",
      parent: null,
      features: [],
      units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
    },
    {
      id: "primary",
      name: "Hydrology",
      scope: "region",
      parent: null,
      seaLevel: 1,
      features: [{ id: "coast", type: "area", kind: "outline", points: [[-50, -50], [50, -50], [50, 50], [-50, 50]] }],
      units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
      hydrology: recipe,
    },
  ],
};

const canonical = canonicalMapDocText(mapDoc);
const first = compileAtlasMapDoc({ mapsJsonText: canonical }).worldMap as WorldMap;
const second = compileAtlasMapDoc({ mapsJsonText: canonical }).worldMap as WorldMap;
assert(stableStringifyWorldMap(first) === stableStringifyWorldMap(second), "canonical Atlas compilation was not byte deterministic");
assert(JSON.stringify(first.hydrology) === JSON.stringify(recipe), "Atlas recipe did not survive compilation exactly");
assert(verifyWorldMap(first).ok, "compiled hydrology WorldMap failed its embedded content hash");
const compatibleWaterField = createWaterField(first);
assert(compatibleWaterField.query(0, 0, 2).type === "dry", "WaterField rejected or misread a valid hydrology-bearing WorldMap");

const withoutRecipe = clone(mapDoc);
delete withoutRecipe.maps[1].hydrology;
const oldCompile = compileAtlasMapDoc({ mapsJsonText: canonicalMapDocText(withoutRecipe) }).worldMap as WorldMap;
assert(!("hydrology" in oldCompile), "compiler materialized a default hydrology recipe");

const fieldMutations: Array<(candidate: any) => void> = [
  (candidate) => { candidate.schema = "limina.hydrology-recipe/v2"; },
  (candidate) => { candidate.precipitationMmPerYear = 876; },
  (candidate) => { candidate.riverMinCatchmentAreaM2 = 125_001; },
  (candidate) => { candidate.basinMinAreaM2 = 4_001; },
  (candidate) => { candidate.basinMinDepthM = 0.76; },
  (candidate) => { candidate.waterfallMinDropM = 2.6; },
];
const fieldHashes = new Set([first.provenance.contentHash]);
for (const mutate of fieldMutations) {
  const candidate = clone(first) as any;
  mutate(candidate.hydrology);
  candidate.provenance.contentHash = worldMapContentHash(candidate);
  fieldHashes.add(candidate.provenance.contentHash);
}
assert(fieldHashes.size === fieldMutations.length + 1, "one or more hydrology recipe fields are absent from the hash walker");

function parserReject(value: unknown, pattern: RegExp, message: string): void {
  const error = rejects(() => parseAuthoredHydrologyRecipe(value), pattern, message);
  assert(error instanceof HydrologyIrValidationError, `${message} did not throw HydrologyIrValidationError`);
}

parserReject(null, /plain object/, "null recipe accepted");
parserReject([], /plain object/, "array recipe accepted");
parserReject(new Array(3), /plain object/, "sparse array recipe accepted");
parserReject({ ...recipe, schema: "limina.hydrology-recipe/v2" }, /schema/, "unknown recipe schema accepted");
parserReject({ ...recipe, extra: true }, /unknown field/, "unknown recipe field accepted");
for (const key of Object.keys(recipe)) {
  const candidate: any = { ...recipe };
  delete candidate[key];
  parserReject(candidate, /missing/, `missing ${key} accepted`);
}
for (const key of ["precipitationMmPerYear", "riverMinCatchmentAreaM2", "basinMinAreaM2", "basinMinDepthM", "waterfallMinDropM"]) {
  parserReject({ ...recipe, [key]: -0 }, /canonical/, `negative-zero ${key} accepted`);
  parserReject({ ...recipe, [key]: Number.POSITIVE_INFINITY }, /finite/, `infinite ${key} accepted`);
  parserReject({ ...recipe, [key]: Number.NaN }, /finite/, `NaN ${key} accepted`);
}
parserReject({ ...recipe, precipitationMmPerYear: -1 }, /non-negative/, "negative precipitation accepted");
for (const key of ["riverMinCatchmentAreaM2", "basinMinAreaM2", "basinMinDepthM", "waterfallMinDropM"]) {
  parserReject({ ...recipe, [key]: 0 }, /positive/, `zero ${key} accepted`);
}
parserReject({ ...recipe, precipitationMmPerYear: HYDROLOGY_LIMITS.precipitationMmPerYear + 1 }, /at most/, "excess precipitation accepted");
parserReject({ ...recipe, riverMinCatchmentAreaM2: HYDROLOGY_LIMITS.catchmentAreaM2 + 1 }, /at most/, "excess catchment accepted");
parserReject({ ...recipe, basinMinAreaM2: HYDROLOGY_LIMITS.basinAreaM2 + 1 }, /at most/, "excess basin area accepted");
parserReject({ ...recipe, basinMinDepthM: HYDROLOGY_LIMITS.basinDepthM + 1 }, /at most/, "excess basin depth accepted");
parserReject({ ...recipe, waterfallMinDropM: HYDROLOGY_LIMITS.waterfallDropM + 1 }, /at most/, "excess waterfall drop accepted");

{
  let calls = 0;
  const accessor = { ...recipe };
  Object.defineProperty(accessor, "precipitationMmPerYear", { enumerable: true, get() { calls++; return 875; } });
  parserReject(accessor, /data field/, "accessor recipe accepted");
  assert(calls === 0, "recipe validation invoked an accessor");
}
{
  const hidden = { ...recipe };
  Object.defineProperty(hidden, "hidden", { enumerable: false, value: true });
  parserReject(hidden, /unknown field/, "non-enumerable custom field accepted");
}
{
  const symbol = { ...recipe, [Symbol("hidden")]: true };
  parserReject(symbol, /symbol/, "symbol recipe field accepted");
}
parserReject(Object.assign(Object.create({ polluted: true }), recipe), /plain object/, "prototyped recipe accepted");

function schemaReject(mutator: (candidate: any) => void, message: string): void {
  const candidate = clone(first) as any;
  mutator(candidate.hydrology);
  assert(!WorldMapSchema.safeParse(candidate).success, message);
}
schemaReject((candidate) => { candidate.extra = true; }, "WorldMap schema accepted an unknown recipe field");
schemaReject((candidate) => { candidate.basinMinDepthM = -0; }, "WorldMap schema accepted negative-zero recipe data");
schemaReject((candidate) => { candidate.waterfallMinDropM = Infinity; }, "WorldMap schema accepted non-finite recipe data");

{
  const malformedInactive = clone(mapDoc) as any;
  malformedInactive.maps[0].hydrology = { ...recipe, basinMinDepthM: 0 };
  rejects(
    () => compileAtlasMapDoc({ mapsJsonText: canonicalMapDocText(malformedInactive) }),
    /hydrology\.basinMinDepthM/,
    "malformed inactive-map hydrology bypassed whole-document validation",
  );
}

// The legacy aggregate compiler path uses the same recipe parser and hash walker.
const aggregateDoc = { activeMapId: "primary", maps: [mapDoc.maps[1]] };
const aggregate = compileDesignMap({ mapsJsonText: JSON.stringify(aggregateDoc), worldBibleText: "---\nzone:\n  size_m: 1000\n---\n" }).worldMap as WorldMap;
assert(JSON.stringify(aggregate.hydrology) === JSON.stringify(recipe) && verifyWorldMap(aggregate).ok, "legacy aggregate path did not compile recipe deterministically");

ops.op_log("[js] p_hydrology_ir OK: optional exact v1 recipe compiles deterministically from canonical Atlas MapDoc; every field is hash-sensitive; legacy bytes/hash stay exact; malformed inactive maps and hostile/noncanonical data fail closed.");
