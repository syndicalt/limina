import { AssetRegistry, assetContentHash } from "../src/asset-registry.ts";
import { EntityTable, ops, type WorldContext } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { registerTerrainEditSkills, type EditableTerrain } from "../src/skills/terrain-edit.ts";
import { registerTerrainSkills } from "../src/skills/terrain.ts";
import { ProceduralTerrainSource } from "../src/terrain/procedural.ts";
import { SwappableTerrainSource } from "../src/terrain/swappable.ts";
import { TileCache } from "../src/terrain/tilecache.ts";
import type { WorldMap } from "../src/world/worldmap.ts";
import { worldMapContentHash, stableStringifyWorldMap } from "../src/world/worldmap-hash.mjs";
import { WaterContactRuntime, editableTerrainHeightSampler } from "../src/world/water-contact.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_water_contact FAIL: ${message}`);
}

function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}

function sealedMap(overrides: Partial<WorldMap> = {}): WorldMap {
  const map = {
    version: 1,
    id: "contact-test",
    unitsPerMeter: 1,
    origin: [0, 0],
    extent: { w: 100, h: 100 },
    seaLevel: 2,
    land: [],
    relief: [],
    biomes: [],
    waterways: [],
    waterBodies: [
      {
        id: "main-lake",
        kind: "lake",
        level: 10,
        footprint: {
          points: [[-20, -20], [20, -20], [20, 20], [-20, 20]],
          holes: [[[-4, -4], [-4, 4], [4, 4], [4, -4]]],
        },
        depthZones: [{ minShoreDistanceM: 0, maxShoreDistanceM: 100, depthM: 6 }],
      },
      {
        id: "high-reservoir",
        kind: "reservoir",
        level: 13,
        footprint: { points: [[8, -3], [18, -3], [18, 3], [8, 3]] },
        depthZones: [{ minShoreDistanceM: 0, maxShoreDistanceM: 100, depthM: 4 }],
      },
    ],
    routes: [],
    anchors: [],
    provenance: { tool: "design-space", sourceHash: "contact-source", contentHash: "0".repeat(64) },
    ...overrides,
  } as unknown as WorldMap;
  map.provenance.contentHash = worldMapContentHash(map);
  return map;
}

function makeWorld(): WorldContext {
  const ecs = createEcsWorld();
  return {
    ecs,
    transforms: createTransformStorage(ecs),
    spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(),
    tags: new Map(),
    scene: { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null },
    camera: { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} },
    ops,
    mode: "headless",
  };
}

const map = sealedMap();
const runtime = new WaterContactRuntime();
let terrainHeight = 18; // translated local terrain y=8
let terrainSamples = 0;
const spec = {
  bindingId: "editable-terrain:0",
  offset: [100, 10, -50] as const,
  bounds: { minX: 50, maxX: 150, minZ: -100, maxZ: 0 },
};
const prepared = runtime.prepareVerifiedMap(map, spec);
const preparedAgain = runtime.prepareVerifiedMap(map, spec);
assert(runtime.fieldBuildCount === 1, `same verified hash built ${runtime.fieldBuildCount} fields instead of one`);
runtime.activate(prepared, () => { terrainSamples++; return terrainHeight; });
runtime.activate(preparedAgain, () => { terrainSamples++; return terrainHeight; });

// Coordinate translation, overlap precedence, outer-wet/hole-dry, and exact surface policy.
const lake = runtime.query(106, -50);
assert(lake.wet && lake.type === "basin" && lake.bodyId === "main-lake", "translated lake contact was not selected");
assert(lake.surfaceLevelM === 20 && lake.columnDepthM === 2 && lake.terrainHeightM === 18, "translated Y/depth channels changed");
const reservoir = runtime.query(112, -50);
// local (12,0) lies in both bodies; highest surface must win.
assert(reservoir.bodyId === "high-reservoir" && reservoir.surfaceLevelM === 23 && reservoir.columnDepthM === 5,
  "highest-surface overlap did not win after translation");
assert(runtime.query(120, -40).wet, "outer footprint boundary is not wet");
assert(!runtime.query(104, -50).wet, "exact hole boundary is not dry");
terrainHeight = 23;
assert(!runtime.query(112, -50).wet, "terrain exactly at the selected surface was claimed wet");

// Ocean needs proven terrain submersion and a bounded editable binding never leaks beyond its tile.
terrainHeight = 11;
const ocean = runtime.query(130, -50);
assert(ocean.wet && ocean.type === "ocean" && ocean.surfaceLevelM === 12 && ocean.columnDepthM === 1, "translated ocean contact changed");
terrainHeight = 12;
assert(!runtime.query(130, -50).wet, "terrain exactly at sea level was claimed ocean-wet");
const beforeOutside = terrainSamples;
assert(!runtime.query(151, -50).wet && terrainSamples === beforeOutside, "out-of-domain query sampled terrain or leaked ocean");

// Conflicting owners/maps fail before replacing the active binding; prepared tokens are runtime-owned.
rejects(() => runtime.prepareVerifiedMap(map, { ...spec, bindingId: "editable-terrain:1" }), /binding conflict/, "same map under another owner did not conflict");
const differentMap = sealedMap({ seaLevel: 3 });
rejects(() => runtime.prepareVerifiedMap(differentMap, spec), /binding conflict|map conflict/, "different active map hash did not conflict");
const otherRuntime = new WaterContactRuntime();
rejects(() => otherRuntime.activate(prepared, () => 0), /prepared by this runtime/, "prepared binding crossed world ownership");
assert(!runtime.clear("terrain-source"), "another terrain owner cleared the active contact field");
assert(runtime.clear("editable-terrain:0") && !runtime.query(112, -50).wet, "clear did not restore no-map dry behavior");
const rebound = runtime.prepareVerifiedMap(map, spec);
runtime.activate(rebound, () => terrainHeight);
assert(runtime.fieldBuildCount === 1, "same hash rebuilt its WaterField after a source reset");
assert(runtime.clear("editable-terrain:0"), "rebound contact did not clear");

// Editable sampling reads the current height array, so a deform changes depth without a field rebuild.
const deformRuntime = new WaterContactRuntime();
const tile = {
  nrows: 3,
  ncols: 3,
  origin: [100, 10, -50] as [number, number, number],
  scale: [100, 1, 100] as [number, number, number],
  heights: new Float32Array(9).fill(8),
};
const deformPrepared = deformRuntime.prepareVerifiedMap(map, spec);
deformRuntime.activate(deformPrepared, editableTerrainHeightSampler(tile));
assert(deformRuntime.query(112, -50).columnDepthM === 5, "editable sampler did not read initial translated depth");
tile.heights.fill(13);
assert(!deformRuntime.query(112, -50).wet, "live tile mutation did not remove water contact");
assert(deformRuntime.fieldBuildCount === 1, "deformation rebuilt the immutable WaterField");

// Real editable terrain skill seam: verified map bytes bind only after terrain.create succeeds.
const bytes = new TextEncoder().encode(stableStringifyWorldMap(map));
const mapAssetId = "maps/contact.worldmap.json";
const assets = AssetRegistry.fromBundle([{ id: mapAssetId, path: `assets/${mapAssetId}`, hash: assetContentHash(bytes, ops), bytes }], ops);
ops.op_physics_create_world(-9.81);
const editableRuntime = new WaterContactRuntime();
const layers = new Map<string, EditableTerrain>();
const editRegistry = new SkillRegistry(new LiminaTracer("ses_water_contact_edit"));
registerTerrainEditSkills(editRegistry, layers, assets, new Map(), new Map(), editableRuntime);
const permissions = resolveProfile("builder.readWrite");
const editResult = await editRegistry.invoke("terrain.create", {
  size: 100,
  resolution: 33,
  origin: [100, 10, -50],
  generate: { source: "map", mapAssetId, seed: 7, amplitude: 12 },
}, { agentId: "water-test", sessionId: "ses_water_contact_edit", permissions, tick: 0, world: makeWorld() });
assert(editResult.success, `map terrain contact binding failed: ${editResult.success ? "" : editResult.error?.message}`);
assert(editableRuntime.activeContentHash === map.provenance.contentHash && editableRuntime.activeBindingId === "editable-terrain:0",
  "terrain.create did not activate its verified map contact field");
assert(!editableRuntime.query(151, -50).wet, "terrain.create contact leaked beyond its finite translated domain");

// Real streamed source seam: exact MapTerrainSource sampler binds, and procedural reset clears it.
const streamedRuntime = new WaterContactRuntime();
const streamedRegistry = new SkillRegistry(new LiminaTracer("ses_water_contact_stream"));
const swappable = new SwappableTerrainSource(new ProceduralTerrainSource());
registerTerrainSkills(streamedRegistry, swappable, new TileCache(), new Map(), assets, streamedRuntime);
const streamedWorld = makeWorld();
const setMap = await streamedRegistry.invoke("world.setTerrainSource", { kind: "map", mapAssetId }, {
  agentId: "water-test", sessionId: "ses_water_contact_stream", permissions, tick: 0, world: streamedWorld,
});
assert(setMap.success && streamedRuntime.activeBindingId === "terrain-source", "world.setTerrainSource did not bind verified water contact");
assert(streamedRuntime.query(30, 0).wet && streamedRuntime.query(30, 0).type === "ocean", "MapTerrainSource exact height did not prove ocean contact");
const setProcedural = await streamedRegistry.invoke("world.setTerrainSource", { kind: "procedural" }, {
  agentId: "water-test", sessionId: "ses_water_contact_stream", permissions, tick: 1, world: streamedWorld,
});
assert(setProcedural.success && streamedRuntime.activeContentHash === null && !streamedRuntime.query(30, 0).wet,
  "procedural source reset retained stale water contact");

// Full core composition owns a fresh runtime per registry/world.
const coreA = registerCoreSkills(new SkillRegistry(LiminaTracer.ephemeral("ses_contact_core_a")));
const coreB = registerCoreSkills(new SkillRegistry(LiminaTracer.ephemeral("ses_contact_core_b")));
assert(coreA.water.contact !== coreB.water.contact, "CoreSkills shared WaterContactRuntime across worlds");
assert(coreA.water.contact.activeContentHash === null && coreB.water.contact.activeContentHash === null, "fresh core runtime was not dry");

ops.op_log(
  "[js] p_water_contact OK: one immutable field build/hash; per-world ownership; verified streamed/editable map binding; "
  + "outer-wet/hole-dry/overlap/ocean/exact-surface policies; translated bounded queries; live deform sampling; conflicts and no-map reset proven.",
);
