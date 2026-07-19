import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { loadApprovedFunctionalSettlementFurnishingAuthority } from "../src/assets/functional-settlement-furnishing.mjs";
import { loadApprovedFunctionalSettlementRelease } from "../src/assets/functional-settlement-release.mjs";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { createEcsWorld, spawnRenderable } from "../src/ecs/world.ts";
import { EntityTable, type EngineOps } from "../src/engine.ts";
import { FunctionalSettlementFurnishingRuntime } from "../src/skills/functional-settlement-furnishing-runtime.ts";
import type { FunctionalSettlementBuildingHandle } from "../src/skills/functional-settlement.ts";
import type { SkillRegistry, WorldContext } from "../src/skills/registry.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path));
const release = loadApprovedFunctionalSettlementRelease(read("assets/settlements/functional-hall-r1/release.json"), read) as any;
const authority = loadApprovedFunctionalSettlementFurnishingAuthority(read("assets/settlements/functional-hall-r1/furnishing-authority-r1.json"), release, read) as any;
let physicsAdds = 0, invokes = 0, tick = 1;
const ops = { op_physics_add_static_box() { physicsAdds++; throw new Error("dormant sidecar reached physics"); } } as unknown as EngineOps;
const ecs = createEcsWorld(), world = { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(),
  scene: { add() { throw new Error("dormant sidecar mounted pixels"); }, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null },
  camera: { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} }, ops, mode: "headless", simWorker: true } as unknown as WorldContext;
const registry = { async invoke() { invokes++; throw new Error("dormant sidecar invoked a placement skill"); } } as unknown as SkillRegistry;
const invokeBase = () => ({ agentId: "furnishing-test", sessionId: "fb5-furnishing", permissions: new Set(["scene.write"]), tick: tick++, world });
const inert = () => ({ position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } });

function buildingFor(placement: any): FunctionalSettlementBuildingHandle {
  const site = JSON.parse(new TextDecoder().decode(read(placement.siteFoundation.path)));
  const eid = spawnRenderable(world.ecs, inert() as never, placement.position[0], site.foundation.rootWorldY, placement.position[2]);
  const root = world.entities.create({ eid, origin: { tool: "building.placeFunctional", input: { functionalSchema: "limina.functional-building/v2" } } });
  return { placementId: placement.placementId, residencyUnitId: placement.residency.unitId, root, doors: [], parts: [], catalogEntryId: placement.catalogEntryId,
    assetId: release.publication.catalog.entries[0].asset.assetId, assetHash: release.publication.catalog.entries[0].asset.hash,
    position: [placement.position[0], site.foundation.rootWorldY, placement.position[2]], yaw: placement.yaw,
    atlasAnchorId: placement.atlasBinding.anchorId, atlasRouteId: placement.atlasBinding.routeId, routeContact: placement.entryConnector.routeContact };
}

const runtime = new FunctionalSettlementFurnishingRuntime(registry, { authority, invokeBase });
const variants = new Set<string>();
for (const placement of release.plan.placements) {
  const building = buildingFor(placement), before = [...world.entities.ids()];
  const handle = await runtime.furnish(building); variants.add(handle.variantId);
  assert.equal(runtime.size, 1); assert.equal(runtime.get(placement.placementId), handle);
  assert(handle.instances.every((instance) => instance.activation === "dormant-authoring-sidecar" && instance.position[0] > 100_000 && instance.position[2] < -100_000));
  assert.deepEqual([...world.entities.ids()], before, "dormant furnishing mutated ECS"); assert.equal(invokes, 0); assert.equal(physicsAdds, 0);
  await runtime.unfurnish(placement.placementId); assert.equal(runtime.size, 0); world.entities.destroy(building.root);
}
assert.equal(variants.size, 3, "all deterministic arrangement variants were not exercised");

const faultPlacement = release.plan.placements.find((placement: any) => placement.placementId === "placement/6ac96398468d8f592372790c7823c252")!, faultBuilding = buildingFor(faultPlacement);
const faultRuntime = new FunctionalSettlementFurnishingRuntime(registry, { authority, invokeBase, beforeInstancePlacement(_placement, _instance, index) { if (index === 1) throw new Error("injected-furnishing-stage"); } });
const beforeFault = [...world.entities.ids()]; await assert.rejects(faultRuntime.furnish(faultBuilding), /injected-furnishing-stage/);
assert.equal(faultRuntime.size, 0); assert.deepEqual([...world.entities.ids()], beforeFault, "failed dormant transaction mutated ECS"); assert.equal(invokes, 0); assert.equal(physicsAdds, 0);

console.log("p_fb5_functional_settlement_furnishing_runtime OK: three exact large-coordinate arrangements attach/detach transactionally; fault rollback leaves zero state; no mesh, collider, physics, or skill activation");
