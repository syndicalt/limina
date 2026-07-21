import * as THREE from "../build/three.bundle.mjs";
import { AssetRegistry } from "../src/asset-registry.ts";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_asset_place_collider_lifecycle FAIL: ${message}`);
}
function world(worldOps: EngineOps): WorldContext {
  const ecs = createEcsWorld(); return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
    ops: worldOps, mode: "headless", simWorker: false } as unknown as WorldContext;
}
const hit = (worldOps: EngineOps, x: number): boolean => { const out = new Float32Array(6);
  worldOps.op_physics_raycast(x + 2.95, 5, -.6, 0, -1, 0, 10, out); return out[0] === 1; };
const bytes = ops.op_read_asset("assets/buildings/authoring/functional-hall-house-v4/fire-r1/hearth-fuel-r1.glb");
const run = async (kind: "asset.place" | "asset.placeLod", x: number): Promise<void> => {
  ops.op_physics_create_world(0); const context = world(ops), assets = new AssetRegistry(ops);
  assets.seed("test/fuel-a.glb", bytes); assets.seed("test/fuel-b.glb", bytes);
  const registry = new SkillRegistry(new LiminaTracer(`collider-${kind}`)); registerCoreSkills(registry, { assets });
  const base = { agentId: "test", sessionId: `collider-${kind}`, permissions: resolveProfile("builder.readWrite"), tick: 1, world: context };
  assert(!hit(ops, x), `${kind} test ray began with a collider`);
  const input = kind === "asset.place"
    ? { assetId: "test/fuel-a.glb", position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], ground: false }
    : { lods: [{ assetId: "test/fuel-a.glb", distance: 0 }, { assetId: "test/fuel-b.glb", distance: 20 }],
      position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], ground: false };
  const placed = await registry.invoke(kind, input, base); assert(placed.success, `${kind} failed: ${JSON.stringify(placed.error)}`);
  ops.op_physics_step(); const entity = (placed.result as { entity: string }).entity; assert(hit(ops, x), `${kind} did not publish its static AABB body`);
  const destroyed = await registry.invoke("scene.destroyEntity", { entity }, { ...base, tick: 2 });
  ops.op_physics_step(); assert(destroyed.success && !hit(ops, x) && context.entities.ids().length === 0 && (context.scene as unknown as THREE.Scene).children.length === 0,
    `${kind} destroy did not restore physics/entity/scene baseline`);
};
await run("asset.place", 20); await run("asset.placeLod", 40);

// A body-removal failure is reported, but teardown still removes entity and render resources rather
// than aborting halfway. Resetting the isolated test world releases the deliberately failed body.
let failRemoval = false; const failingOps = new Proxy(ops, { get(target, property, receiver) {
  if (property === "op_physics_remove_body") return (id: number): void => { if (failRemoval) throw new Error(`forced remove failure ${id}`); target.op_physics_remove_body(id); };
  return Reflect.get(target, property, receiver);
} }) as EngineOps;
failingOps.op_physics_create_world(0); const failureWorld = world(failingOps), failureAssets = new AssetRegistry(failingOps);
failureAssets.seed("test/failure-fuel.glb", bytes); const failureRegistry = new SkillRegistry(new LiminaTracer("collider-failure"));
registerCoreSkills(failureRegistry, { assets: failureAssets }); const failureBase = { agentId: "test", sessionId: "collider-failure",
  permissions: resolveProfile("builder.readWrite"), tick: 1, world: failureWorld };
const placed = await failureRegistry.invoke("asset.place", { assetId: "test/failure-fuel.glb", position: [60, 0, 0],
  rotation: [0, 0, 0], scale: [1, 1, 1], ground: false }, failureBase);
assert(placed.success, "failure-path placement did not reach teardown"); failRemoval = true;
const entity = (placed.result as { entity: string }).entity, failedDestroy = await failureRegistry.invoke("scene.destroyEntity", { entity }, { ...failureBase, tick: 2 });
assert(!failedDestroy.success && /runtime disposal|forced remove failure|entity teardown failed/.test(JSON.stringify(failedDestroy.error))
  && failureWorld.entities.ids().length === 0 && (failureWorld.scene as unknown as THREE.Scene).children.length === 0,
  `body-removal failure was not surfaced after continuing entity/render rollback: ${JSON.stringify({ failedDestroy,
    ids: failureWorld.entities.ids(), children: (failureWorld.scene as unknown as THREE.Scene).children.length })}`);
ops.op_physics_create_world(0);

console.log("p_asset_place_collider_lifecycle OK: asset.place and asset.placeLod retain/remove exact AABB bodies, while cleanup failures surface after entity/render rollback");
