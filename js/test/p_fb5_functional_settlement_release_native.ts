import { z } from "../build/zod.bundle.mjs";
import { AssetRegistry } from "../src/asset-registry.ts";
import { loadApprovedFunctionalSettlementRelease } from "../src/assets/functional-settlement-release.mjs";
import { loadApprovedFunctionalSettlementFurnishingAuthority } from "../src/assets/functional-settlement-furnishing.mjs";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { registerFunctionalSettlementSkills } from "../src/skills/functional-settlement.ts";
import {
  createFurnishedReleasedFunctionalSettlementRuntimeResidency,
  createReleasedFunctionalSettlementRuntimeResidency,
} from "../src/skills/functional-settlement-runtime-residency.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { canonicalCompilerJson } from "../src/world/compiler/canonical.mjs";
import { sha256 } from "../src/world/sha256.mjs";
import { installSeededRandom } from "../src/worldlog/log.ts";

const assert = (value: unknown, message: string): asserts value => {
  if (!value) throw new Error(`p_fb5_functional_settlement_release_native FAIL: ${message}`);
};
const read = (path: string): Uint8Array => ops.op_read_asset(path),
  release = loadApprovedFunctionalSettlementRelease(
    read("assets/settlements/functional-hall-r1/release.json"),
    read,
  ) as any;
const furnishingAuthority = loadApprovedFunctionalSettlementFurnishingAuthority(
  read("assets/settlements/functional-hall-r1/furnishing-authority-r1.json"),
  release,
  read,
) as any;
const makeWorld = (worldOps: EngineOps): WorldContext => {
  const ecs = createEcsWorld();
  return {
    ecs,
    transforms: createTransformStorage(ecs),
    spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(),
    tags: new Map(),
    scene: { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null },
    camera: { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} },
    ops: worldOps,
    mode: "headless",
    simWorker: true,
  } as WorldContext;
};
const terrain = release.release.terrain,
  c = Math.cos(terrain.yaw),
  s = Math.sin(terrain.yaw),
  sampleHeight = (x: number, z: number) =>
    terrain.baseHeight + terrain.localZSlope * ((x - terrain.origin[0]) * s + (z - terrain.origin[1]) * c);

ops.op_physics_create_world(0);
installSeededRandom(0xfb51, true);
const assets = new AssetRegistry(ops),
  entry = release.publication.catalog.entries[0],
  assetPath = `assets/${entry.asset.assetId}`;
assets.seed(entry.asset.assetId, read(assetPath));
for (const placement of release.plan.placements)
  assets.seed(placement.siteFoundation.path, read(placement.siteFoundation.path));
const world = makeWorld(ops),
  registry = new SkillRegistry(new LiminaTracer("fb5-release-native")),
  core = registerCoreSkills(registry, { assets });
registry.unregister("settlement.placeFunctional");
registry.unregister("settlement.destroyFunctional");
const manager = registerFunctionalSettlementSkills(registry, assets, { sampleHeight });
let genericCalls = 0;
registry.replace("asset.place", {
  name: "asset.place",
  version: "trap",
  description: "release pipeline trap",
  category: "scene",
  permissions: ["scene.write"],
  input: z.unknown(),
  output: z.unknown(),
  handler() {
    genericCalls++;
    throw new Error("generic asset.place forbidden");
  },
} as any);
const permissions = resolveProfile("builder.readWrite");
let tick = 1;
const invokeBase = () => ({ agentId: "release-builder", sessionId: "fb5-release", permissions, tick: tick++, world });

const forged = JSON.parse(JSON.stringify(release));
let forgedRejected = false;
try {
  createReleasedFunctionalSettlementRuntimeResidency(registry, manager, {
    namespace: "release/forged",
    release: forged,
    invokeBase,
  });
} catch (error) {
  forgedRejected = /not a verified in-process settlement release/.test(
    error instanceof Error ? error.message : String(error),
  );
}
assert(
  forgedRejected && manager.size() === 0 && [...world.entities.ids()].length === 0,
  "deserialized release reached Atlas or runtime mutation",
);
const faultNearest = release.plan.placements.find(
    (placement: any) => placement.residency.unitId === "residency/functional-hall/b",
  ),
  faulted = createFurnishedReleasedFunctionalSettlementRuntimeResidency(registry, manager, {
    namespace: "release/furnishing-fault",
    release,
    furnishingAuthority,
    invokeBase,
    beforeFurnitureInstancePlacement(_placement, _instance, index) {
      if (index === 1) throw new Error("injected-dormant-furnishing-stage");
    },
  });
let faultRejected = false;
try {
  await faulted.residency.update(faultNearest.position);
} catch (error) {
  faultRejected = /injected-dormant-furnishing-stage/.test(error instanceof Error ? error.message : String(error));
}
assert(
  faultRejected &&
    faulted.furnishing.size === 0 &&
    manager.size() === 0 &&
    core.functionalBuildings.topologyManager.size() === 0 &&
    [...world.entities.ids()].length === 0,
  "dormant furnishing stage failure did not rollback its whole building",
);
const namespace = "release/functional-hall-r1",
  furnished = createFurnishedReleasedFunctionalSettlementRuntimeResidency(registry, manager, {
    namespace,
    release,
    furnishingAuthority,
    invokeBase,
  }),
  residency = furnished.residency,
  nearest = release.plan.placements.find(
    (placement: any) => placement.residency.unitId === "residency/functional-hall/b",
  );
assert(nearest, "release omitted center building");
let snapshot = await residency.update(nearest.position);
assert(
  snapshot.residentUnitIds.join(",") === "residency/functional-hall/b" &&
    manager.size() === 1 &&
    core.functionalBuildings.topologyManager.size() === 1 &&
    furnished.furnishing.size === 1,
  "released residency did not load exactly one whole building plus its dormant furnishing sidecar",
);
let handles = [...world.entities.ids()]
  .map((id) => world.entities.resolve(id))
  .filter((entity) => entity?.origin?.tool === "building.placeFunctional");
assert(handles.length === 1 && genericCalls === 0, "released placement bypassed building.placeFunctional");
assert(
  ![...world.entities.ids()].some((id) => world.entities.resolve(id)?.origin?.tool === "furniture.placeFunctional"),
  "dormant furnishing sidecar created invisible furniture entities/colliders",
);
const centerFurnishing = furnished.furnishing.get(nearest.placementId);
assert(
  centerFurnishing?.variantId === "furnishing/hearth-social" &&
    centerFurnishing.instances.length === 2 &&
    centerFurnishing.instances.every((instance) => instance.activation === "dormant-authoring-sidecar"),
  "deterministic center furnishing assignment drifted",
);
const site = JSON.parse(new TextDecoder().decode(read(nearest.siteFoundation.path))),
  settlement = [...snapshot.residentUnitIds][0];
assert(settlement && manager.size() === 1, "released whole-building ownership was not established");
const allUnits = release.plan.placements.map((placement: any) => placement.residency.unitId).sort();
residency.setExplicitInterest(allUnits);
snapshot = await residency.update(nearest.position);
assert(
  snapshot.residentUnitIds.length === release.runtime.maxActiveUnits &&
    manager.size() === release.runtime.maxActiveUnits &&
    core.functionalBuildings.topologyManager.size() === release.runtime.maxActiveUnits &&
    furnished.furnishing.size === release.runtime.maxActiveUnits,
  "released maxActiveUnits did not bound complete building+sidecar loads",
);
const residentHandles = snapshot.residentUnitIds.flatMap((unitId: string) => {
  const settlementId = `residency/${sha256(canonicalCompilerJson({ namespace, planId: release.plan.planId, unitId })).slice(0, 32)}`;
  return manager.get(settlementId)?.buildings ?? [];
});
assert(
  residentHandles.length === release.runtime.maxActiveUnits &&
    residentHandles.every(
      (building: any) =>
        Math.abs(building.position[0]) > 100_000 &&
        Math.abs(building.position[2]) > 100_000 &&
        building.position[1] > 5 &&
        building.yaw === 0.713,
    ),
  "large-coordinate site/yaw production placements drifted",
);
residency.setExplicitInterest([]);
snapshot = await residency.update([900000, 0, -900000]);
assert(
  snapshot.residentUnitIds.length === 0 &&
    manager.size() === 0 &&
    core.functionalBuildings.topologyManager.size() === 0 &&
    furnished.furnishing.size === 0 &&
    [...world.entities.ids()].length === 0,
  "released residency did not atomically unload all whole buildings and furnishing sidecars",
);
await residency.close();
assert(
  site.foundation.rootWorldY > 5 && genericCalls === 0,
  "exact site foundation was not applied or generic asset placement was used",
);
console.log(
  "p_fb5_functional_settlement_release_native OK: exact branded 3-house release and dormant furnishing sidecars obey native whole-building bounds/teardown with zero invisible furnishing entities or asset.place",
);
