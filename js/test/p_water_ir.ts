// WB-W1 water IR gate: backward-compatible canonical bytes plus strict per-basin and ordered-river
// authoring from Atlas MapDoc through the pure WorldMap compiler.

import { ops } from "../src/engine.ts";
import { compileDesignMap } from "../src/world/design-map-compile.mjs";
import { stableStringifyWorldMap, verifyWorldMap, WorldMapSchema, type WorldMap } from "../src/world/worldmap.ts";
import { inspectWaterBodyTopology, WATER_LIMITS } from "../src/world/water-ir.mjs";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p_water_ir FAIL: " + message);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

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
assert(stableStringifyWorldMap(legacy) === LEGACY_BYTES, "a pre-WB-W1 WorldMap changed canonical bytes");
assert(
  (await import("../src/world/worldmap-hash.mjs")).worldMapContentHash(legacy) === "3f62ab4461c69ce36c6a26847bd47b64beb2d9747c60d6c3d49c847e678508b3",
  "a pre-WB-W1 WorldMap changed its content hash",
);
assert(!("waterBodies" in WorldMapSchema.parse(legacy)), "parsing a legacy map silently emitted waterBodies");

const waterBody = {
  id: "upper-mere",
  kind: "lake",
  level: 42,
  footprint: {
    points: [[-20, -20], [20, -20], [20, 20], [-20, 20]],
    holes: [[[-4, -4], [-4, 4], [4, 4], [4, -4]]],
  },
  depthZones: [
    { minShoreDistanceM: 0, maxShoreDistanceM: 3, depthM: 1 },
    { minShoreDistanceM: 3, maxShoreDistanceM: 12, depthM: 7 },
  ],
};

const mapDoc = {
  version: 2,
  activeMapId: "primary",
  maps: [{
    id: "primary",
    name: "Water contract",
    scope: "site",
    parent: null,
    units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
    features: [{
      id: "river-1",
      type: "line",
      kind: "river",
      class: "stream",
      points: [[-30, -10], [0, 0], [30, 10]],
      widthM: 4,
      order: 3,
      widths: [2, 3, 5],
    }],
    waterBodies: [waterBody],
  }],
};
const worldBibleText = "---\nzone:\n  size_m: 1000\n---\n";
const compile = (doc: unknown = mapDoc) => compileDesignMap({ mapsJsonText: JSON.stringify(doc), worldBibleText }).worldMap as WorldMap;

const compiledA = compile();
const compiledB = compile();
const parsed = WorldMapSchema.parse(compiledA);
assert(stableStringifyWorldMap(compiledA) === stableStringifyWorldMap(compiledB), "water compilation is not byte deterministic");
assert(verifyWorldMap(compiledA).ok, "compiled water map does not verify against its embedded hash");
assert(parsed.waterBodies?.length === 1 && parsed.waterBodies[0].id === "upper-mere", "Atlas waterBodies did not compile");
assert(parsed.waterBodies[0].footprint.holes?.length === 1 && parsed.waterBodies[0].depthZones[1].depthM === 7, "water footprint/depth zones did not survive compile");
assert(parsed.waterways[0].class === "stream" && parsed.waterways[0].order === 3, "waterway class/order did not survive compile");
assert(parsed.waterways[0].widthM === 4 && parsed.waterways[0].widths?.join(",") === "2,3,5", "waterway scalar/per-vertex widths did not survive compile");

const legacyDoc = clone(mapDoc);
delete legacyDoc.maps[0].waterBodies;
delete legacyDoc.maps[0].features[0].class;
delete legacyDoc.maps[0].features[0].order;
delete legacyDoc.maps[0].features[0].widths;
const legacyCompile = compile(legacyDoc);
assert(!("waterBodies" in legacyCompile), "compiler emitted a default waterBodies field for old MapDoc input");
assert(!("order" in legacyCompile.waterways[0]) && !("widths" in legacyCompile.waterways[0]), "compiler emitted new waterway defaults for old input");
assert(legacyCompile.waterways[0].class === "river" && legacyCompile.waterways[0].widthM === 4, "legacy class/widthM behavior regressed");

// Every new field participates independently in the canonical content hash.
const hashVariants: WorldMap[] = [];
const canonical = clone(compiledA);
for (const mutate of [
  (map: WorldMap) => { map.waterways[0].order = 4; },
  (map: WorldMap) => { map.waterways[0].widths![1] = 3.5; },
  (map: WorldMap) => { map.waterBodies![0].id = "upper-mere-v2"; },
  (map: WorldMap) => { map.waterBodies![0].kind = "pond"; },
  (map: WorldMap) => { map.waterBodies![0].level = 43; },
  (map: WorldMap) => { map.waterBodies![0].footprint.points[0][0] -= 1; },
  (map: WorldMap) => { map.waterBodies![0].footprint.holes![0][0][0] -= 0.5; },
  (map: WorldMap) => { map.waterBodies![0].depthZones[1].minShoreDistanceM = 3.5; },
  (map: WorldMap) => { map.waterBodies![0].depthZones[1].maxShoreDistanceM = 13; },
  (map: WorldMap) => { map.waterBodies![0].depthZones[1].depthM = 8; },
]) {
  const variant = clone(canonical);
  mutate(variant);
  variant.provenance.contentHash = (await import("../src/world/worldmap-hash.mjs")).worldMapContentHash(variant);
  hashVariants.push(variant);
}
const hashes = new Set([canonical.provenance.contentHash, ...hashVariants.map((map) => map.provenance.contentHash)]);
assert(hashes.size === hashVariants.length + 1, "one or more water fields are absent from the canonical hash walker");

function schemaReject(mutator: (map: any) => void, message: string) {
  const candidate = clone(compiledA);
  mutator(candidate);
  assert(!WorldMapSchema.safeParse(candidate).success, message);
}

schemaReject((map) => { map.waterBodies[0].id = "Upper/Mere"; }, "non-portable water id accepted");
schemaReject((map) => { map.waterBodies.push(clone(map.waterBodies[0])); }, "duplicate water id accepted");
schemaReject((map) => { map.waterBodies[0].level = Infinity; }, "infinite basin level accepted");
schemaReject((map) => { map.waterBodies[0].footprint.points[0][0] = NaN; }, "non-finite footprint point accepted");
schemaReject((map) => { map.waterBodies[0].footprint.points = [[0, 0], [2, 2], [0, 2], [2, 0]]; }, "self-intersecting footprint accepted");
schemaReject((map) => { map.waterBodies[0].footprint.holes = [[[30, 30], [31, 30], [31, 31]]]; }, "hole outside footprint accepted");
schemaReject((map) => { map.waterBodies[0].depthZones[0].depthM = 0; }, "zero depth accepted");
schemaReject((map) => { map.waterBodies[0].depthZones[0].minShoreDistanceM = 1; }, "depth zones not starting at shoreline accepted");
schemaReject((map) => { map.waterBodies[0].depthZones[1].minShoreDistanceM = 2; }, "overlapping depth zones accepted");
schemaReject((map) => { map.waterBodies[0].depthZones[1].minShoreDistanceM = 4; }, "gap between depth zones accepted");
schemaReject((map) => { map.waterBodies[0].depthZones[1].depthM = 0.5; }, "decreasing interior depth accepted");
schemaReject((map) => { map.waterBodies[0].depthZones = new Array(65).fill(map.waterBodies[0].depthZones[0]); }, "excess depth zones accepted");
schemaReject((map) => { map.waterways[0].points[0][0] = Infinity; }, "non-finite waterway point accepted");
schemaReject((map) => { map.waterways[0].widths.pop(); }, "per-vertex width length mismatch accepted");
schemaReject((map) => { map.waterways[0].order = 13; }, "out-of-range stream order accepted");
schemaReject((map) => { map.waterways[0].widths[0] = -1; }, "negative vertex width accepted");

// Local-frame area math accepts a small valid basin near the coordinate ceiling, while the
// scale-aware orientation policy rejects numerically unstable near-collinear topology.
schemaReject((map) => {
  map.waterBodies[0].footprint = { points: [[0, 0], [4_000_000, 4_000_000], [8_000_000, 8_000_000.00000001]] };
}, "numerically unstable near-collinear footprint accepted");
{
  const far = clone(compiledA) as any;
  far.waterBodies[0].footprint = { points: [[9_999_980, 9_999_980], [9_999_990, 9_999_980], [9_999_990, 9_999_990], [9_999_980, 9_999_990]] };
  assert(WorldMapSchema.safeParse(far).success, "small valid footprint near the coordinate ceiling was rejected by cancellation");
}
schemaReject((map) => { map.waterBodies[0].footprint.points[0][0] = WATER_LIMITS.absCoordinateM + 1; }, "out-of-domain water coordinate accepted");

// The topology validator must stop at its deterministic work budget rather than performing the
// billions of pair checks permitted by aggregate point caps alone.
{
  const ring = Array.from({ length: WATER_LIMITS.ringPoints }, (_, index) => {
    const angle = index * Math.PI * 2 / WATER_LIMITS.ringPoints;
    return [Math.cos(angle) * 1000, Math.sin(angle) * 1000];
  });
  const bodies = Array.from({ length: 16 }, (_, index) => ({ ...clone(waterBody), id: `budget-${index}`, footprint: { points: ring.map(([x, z]) => [x, z]) } }));
  const topology = inspectWaterBodyTopology(bodies);
  assert(!topology.ok, "adversarial aggregate topology did not hit the work budget");
  assert(topology.workUnits === WATER_LIMITS.topologyWorkUnits + 1, `topology stopped at ${topology.workUnits}, expected exact budget + 1`);
  const hostile = clone(compiledA) as any;
  hostile.waterBodies = bodies;
  assert(!WorldMapSchema.safeParse(hostile).success, "WorldMap parser accepted topology beyond the work budget");
  compileReject((doc) => { doc.maps[0].waterBodies = bodies; }, "compiler accepted topology beyond the work budget");
}

function compileReject(mutator: (doc: any) => void, message: string) {
  const candidate = clone(mapDoc);
  mutator(candidate);
  let rejected = false;
  try { compile(candidate); } catch { rejected = true; }
  assert(rejected, message);
}

compileReject((doc) => { doc.maps[0].waterBodies[0].id = "bad id"; }, "compiler accepted malformed water id");
compileReject((doc) => { doc.maps[0].waterBodies[0].level = null; }, "compiler accepted malformed basin level");
compileReject((doc) => { doc.maps[0].waterBodies[0].footprint.points = [[0, 0], [2, 2], [0, 2], [2, 0]]; }, "compiler accepted invalid footprint");
compileReject((doc) => { doc.maps[0].waterBodies[0].footprint.holes = [[[50, 50], [51, 50], [51, 51]]]; }, "compiler accepted invalid hole");
compileReject((doc) => { doc.maps[0].waterBodies[0].depthZones[0].depthM = -1; }, "compiler accepted invalid depth");
compileReject((doc) => { doc.maps[0].waterBodies[0].depthZones[0].minShoreDistanceM = 1; }, "compiler accepted depth zones that do not start at shoreline");
compileReject((doc) => { doc.maps[0].waterBodies[0].depthZones[1].minShoreDistanceM = 1; }, "compiler accepted overlapping zones");
compileReject((doc) => { doc.maps[0].waterBodies[0].depthZones[1].minShoreDistanceM = 4; }, "compiler accepted a gap between depth zones");
compileReject((doc) => { doc.maps[0].features[0].points[0][0] = null; }, "compiler accepted malformed waterway point");
compileReject((doc) => { doc.maps[0].features[0].widths = [2, 3]; }, "compiler accepted mismatched vertex widths");
compileReject((doc) => { doc.maps[0].features[0].order = 0; }, "compiler accepted invalid stream order");
compileReject((doc) => { doc.maps[0].waterBodies = new Array(4097).fill(waterBody); }, "compiler accepted excess water bodies");
compileReject((doc) => { doc.maps[0].waterBodies[0].unexpected = true; }, "compiler silently ignored an unknown WaterBody field");
compileReject((doc) => { doc.maps[0].waterBodies[0].footprint.points[0][0] = WATER_LIMITS.absCoordinateM + 1; }, "compiler accepted out-of-domain water coordinate");

// Hostile in-memory graphs cannot execute getters or exploit sparse/prototyped containers at the
// exported Zod parser boundary. JSON input cannot construct these, but direct engine callers can.
{
  const hostile = clone(compiledA) as any;
  let getterCalls = 0;
  Object.defineProperty(hostile, "waterBodies", { enumerable: true, get() { getterCalls++; return [waterBody]; } });
  assert(!WorldMapSchema.safeParse(hostile).success, "root WorldMap accessor accepted");
  assert(getterCalls === 0, "WorldMap root validation executed an accessor");
}
{
  const hostile = clone(compiledA) as any;
  const sparse = new Array(2);
  sparse[1] = clone(waterBody);
  hostile.waterBodies = sparse;
  assert(!WorldMapSchema.safeParse(hostile).success, "sparse waterBodies accepted");
}
{
  const hostile = clone(compiledA) as any;
  let getterCalls = 0;
  Object.defineProperty(hostile.waterBodies[0], "level", { enumerable: true, get() { getterCalls++; return 42; } });
  assert(!WorldMapSchema.safeParse(hostile).success, "WaterBody accessor object accepted");
  assert(getterCalls === 0, "WaterBody validation executed an accessor");
}
{
  const hostile = clone(compiledA) as any;
  const sparse = new Array(3);
  sparse[0] = 2;
  sparse[2] = 5;
  hostile.waterways[0].widths = sparse;
  assert(!WorldMapSchema.safeParse(hostile).success, "sparse per-vertex widths accepted");
}
{
  const hostile = clone(compiledA) as any;
  hostile.waterBodies[0] = Object.assign(Object.create({ polluted: true }), hostile.waterBodies[0]);
  assert(!WorldMapSchema.safeParse(hostile).success, "prototyped WaterBody accepted");
}

ops.op_log("[js] p_water_ir OK: legacy bytes/hash unchanged; strict, hash-complete WaterBody and ordered Waterway IR round-trip deterministically from Atlas MapDoc; malformed topology, ids, numbers, depth bands, widths, orders, resource excess, sparse/prototyped/accessor graphs are rejected.");
