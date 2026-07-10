import { ops } from "../src/engine.ts";
import {
  HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_WATER_ARTIFACT_TYPE,
  encodeHydrologyWaterArtifact,
} from "../src/world/hydrology-water-artifact.mjs";
import { HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA } from "../src/world/hydrology-water-topology.mjs";
import { sha256 } from "../src/world/sha256.mjs";
import { prepareGeneratedWaterFieldInput } from "../src/world/water-field.mjs";
import { WaterContactRuntime } from "../src/world/water-contact.ts";
import { worldMapContentHash } from "../src/world/worldmap-hash.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_generated_water_contact FAIL: ${message}`);
}

function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}

const bindings = Object.freeze({
  hydrologyFieldContentHash: `sha256:${"11".repeat(32)}`,
  recipeHash: `sha256:${"22".repeat(32)}`,
  erosionStageKey: `sha256:${"33".repeat(32)}`,
  compilerGraphHash: `sha256:${"44".repeat(32)}`,
});

function generated(id: string, seedCell: number, spillOutsideCell: number, level: number): any {
  const basin = {
    id,
    kind: "lake",
    spillLevelM: level,
    maxDepthM: 4,
    areaM2: 100,
    cellCount: 100,
    seedCell,
    spillInsideCell: seedCell,
    spillOutsideCell,
    spillOutsideDrainageRank: spillOutsideCell,
    footprint: { points: [[0, 0], [10, 0], [10, 10], [0, 10]] },
  };
  const topology = {
    schema: HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA,
    version: 1,
    placement: { originX: 0, originZ: 0 },
    rows: 16,
    cols: 16,
    cellSizeM: 1,
    basins: [basin],
    reaches: [],
    diagnostics: {},
  };
  const bytes = encodeHydrologyWaterArtifact(topology, bindings);
  return prepareGeneratedWaterFieldInput({
    bytes,
    descriptor: { artifactType: HYDROLOGY_WATER_ARTIFACT_TYPE, mediaType: HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
      contentHash: `sha256:${sha256(bytes)}`, byteLength: bytes.byteLength },
    expectedBindings: bindings,
  });
}

function authoredCollision(): any {
  return {
    id: "gen-b-8-7",
    kind: "pond",
    level: 1,
    footprint: { points: [[20, 20], [22, 20], [22, 22], [20, 22]] },
    depthZones: [{ minShoreDistanceM: 0, maxShoreDistanceM: 10, depthM: 1 }],
  };
}

function sealedMap(seaLevel = -100): any {
  const map: any = {
    version: 1,
    id: "generated-contact",
    unitsPerMeter: 1,
    origin: [0, 0],
    extent: { w: 100, h: 100 },
    seaLevel,
    land: [], relief: [], biomes: [], waterways: [], waterBodies: [authoredCollision()], routes: [], anchors: [],
    provenance: { tool: "design-space", sourceHash: "generated-contact", contentHash: "0".repeat(64) },
  };
  map.provenance.contentHash = worldMapContentHash(map);
  return map;
}

const map = sealedMap();
const first = generated("gen-b-6-5", 5, 6, 10);
const second = generated("gen-b-a-9", 9, 10, 12);
const colliding = generated("gen-b-8-7", 7, 8, 11);
const runtime = new WaterContactRuntime();
const spec = {
  bindingId: "terrain-source",
  offset: [100, 10, -50] as const,
  bounds: { minX: 100, maxX: 110, minZ: -50, maxZ: -40 },
};

const prepared = runtime.prepareVerifiedMap(map, spec, first);
const preparedAgain = runtime.prepareVerifiedMap(map, spec, first);
assert(runtime.fieldBuildCount === 1, "unchanged composite identity rebuilt the field");
runtime.activate(prepared, () => 18);
runtime.activate(preparedAgain, () => 18);
assert(runtime.activeContentHash === map.provenance.contentHash
  && runtime.activeGeneratedArtifactContentHash === first.artifactContentHash, "active composite identity changed");
assert(runtime.activeIdentity?.worldMapContentHash === map.provenance.contentHash
  && runtime.activeIdentity.generatedArtifactContentHash === first.artifactContentHash, "active identity tuple is incomplete");
const initial = runtime.query(101, -49);
assert(initial.wet && initial.bodyId === "gen-b-6-5" && initial.surfaceLevelM === 20 && initial.columnDepthM === 2,
  "generated contact did not translate exact surface/depth");

// Same owner prepares a replacement without changing the active authority; activation swaps atomically.
const replacement = runtime.prepareVerifiedMap(map, spec, second);
assert(runtime.fieldBuildCount === 2, "new generated identity did not build exactly one field");
assert(runtime.query(101, -49).surfaceLevelM === 20, "prepare replaced active contact before activation");
runtime.activate(replacement, () => 18);
assert(runtime.query(101, -49).surfaceLevelM === 22 && runtime.query(101, -49).columnDepthM === 4,
  "same-owner replacement did not activate atomically");
assert(runtime.activeGeneratedArtifactContentHash === second.artifactContentHash, "replacement identity did not become active");
const replacementAgain = runtime.prepareVerifiedMap(map, spec, second);
assert(runtime.fieldBuildCount === 2, "active replacement identity was rebuilt");
runtime.activate(replacementAgain, () => 21);
assert(runtime.query(101, -49).columnDepthM === 1, "unchanged identity did not accept a new live terrain sampler");

// Runtime integration can stage a realm-verified generated replacement without retaining or
// retransferring the authored map outside the contact owner.
const activeReplacement = runtime.prepareGeneratedForActive(first);
assert(runtime.activeGeneratedArtifactContentHash === second.artifactContentHash
  && runtime.query(101, -49).surfaceLevelM === 22,
"prepareGeneratedForActive changed live contact before activation");
runtime.activate(activeReplacement, () => 19);
assert(runtime.activeGeneratedArtifactContentHash === first.artifactContentHash
  && runtime.query(101, -49).surfaceLevelM === 20 && runtime.query(101, -49).columnDepthM === 1,
"active-map generated replacement did not activate with the derived terrain sampler");
assert(runtime.fieldBuildCount === 3, "active-map generated replacement did not build exactly one field");

// Failed preparation leaves the currently active field and sampler untouched.
rejects(() => runtime.prepareVerifiedMap(map, spec, colliding), /id collision/, "colliding replacement prepared successfully");
assert(runtime.fieldBuildCount === 3 && runtime.query(101, -49).columnDepthM === 1
  && runtime.activeGeneratedArtifactContentHash === first.artifactContentHash, "failed replacement mutated active state or build count");

rejects(() => runtime.prepareVerifiedMap(map, { ...spec, bindingId: "editable-terrain:0" }, first), /binding conflict/,
  "competing owner prepared over active composite field");
rejects(() => runtime.prepareVerifiedMap(sealedMap(-90), spec, first), /map conflict/,
  "same owner replaced the active verified WorldMap");
const otherRuntime = new WaterContactRuntime();
rejects(() => otherRuntime.prepareGeneratedForActive(first), /active verified map/, "generated replacement prepared without an active map");
rejects(() => otherRuntime.activate(prepared, () => 0), /prepared by this runtime/, "prepared composite token crossed runtime ownership");
rejects(() => runtime.prepareVerifiedMap(map, spec, { artifactContentHash: first.artifactContentHash } as any), /verified prepared envelope/,
  "unverified generated resource entered contact preparation");

assert(!runtime.clear("wrong-owner"), "wrong owner cleared composite contact");
assert(runtime.clear("terrain-source") && !runtime.query(101, -49).wet, "clear did not restore dry state");
const authoredOnly = runtime.prepareVerifiedMap(map, spec);
runtime.activate(authoredOnly, () => 0);
assert(runtime.activeGeneratedArtifactContentHash === null && runtime.activeIdentity?.generatedArtifactContentHash === null,
  "authored-only replacement retained generated identity");
assert(!runtime.query(101, -49).wet, "generated basin survived authored-only replacement");
assert(runtime.fieldBuildCount === 4, "authored-only composite identity build count changed");
assert(runtime.clear("terrain-source"), "authored-only contact did not clear");

ops.op_log(
  "[js] p_generated_water_contact OK: composite map/artifact identity reuse, same-owner atomic replacement, failed-build rollback, "
  + "competing-owner isolation, live terrain replacement and exact clear behavior proven.",
);
