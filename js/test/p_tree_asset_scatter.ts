import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_tree_asset_scatter FAIL: ${message}`);
}
function ok(response: Awaited<ReturnType<SkillRegistry["invoke"]>>): Record<string, unknown> {
  if (response === undefined || !response.success) throw new Error(`tree asset scatter call failed: ${JSON.stringify(response?.error)}`);
  return response.result as Record<string, unknown>;
}

ops.op_physics_create_world(-9.81);
const registry = new SkillRegistry(new LiminaTracer("p_tree_asset_scatter"));
registerCoreSkills(registry);
const ecs = createEcsWorld(), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(); camera.position.set(0, 4, 0);
const world: WorldContext = { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(),
  tags: new Map(), scene, camera, ops, mode: "headless" };
const base = { agentId: "tree", sessionId: "p_tree_asset_scatter", permissions: resolveProfile("builder.readWrite"), tick: 0, world };
const generated = ok(await registry.invoke("world.generateRegion", { seed: 9090, bounds: { minTx: 0, minTz: 0, maxTx: 0, maxTz: 0 }, lod: 0, render: false }, base));
const scattered = ok(await registry.invoke("asset.scatter", { regionId: generated.regionId, config: { seed: 12, density: 4, cellSize: 48,
  assets: [{ id: "oak.glb", treeLod: { reducedId: "oak-lod.glb", reducedDistance: 80,
    impostorId: "oak-impostor.glb", impostorDistance: 280, cullDistance: 1200, hysteresis: 0.15 } }],
  inclusions: [{ x: 16, z: 16, r: 60 }], elevationMin: -100, elevationMax: 100 } }, base));
assert((scattered.instances as number) > 0 && scattered.mounted === 5, `production tree chain did not mount five true draws: ${JSON.stringify(scattered)}`);
const hashes = scattered.assetHashes as Record<string, string>;
assert(Object.keys(hashes).sort().join(",") === "oak-impostor.glb,oak-lod.glb,oak.glb", "tree chain did not pin all three content addresses");
assert(world.lods?.length === 1 && scene.children.length === 1, "tree population controller/root was not registered exactly once");
const controller = world.lods![0] as unknown as { update(camera: THREE.Camera): void; settle(): Promise<void>; takeErrors(): unknown[] };
for (let index = 0; index < 4; index++) { controller.update(camera); await controller.settle(); }
assert(controller.takeErrors().length === 0, "tree population controller reported a production-chain error");
const batches: THREE.InstancedMesh[] = []; scene.traverse((object) => { if ((object as THREE.InstancedMesh).isInstancedMesh) batches.push(object as THREE.InstancedMesh); });
assert(batches.length === 5 && batches.reduce((sum, batch) => sum + batch.count, 0) > 0, "production tree chain did not publish instanced geometry");
ok(await registry.invoke("world.streamFollow", { regionId: generated.regionId, anchor: [10_000, 0, 10_000], radius: 0 }, base));
await Promise.resolve(); await Promise.resolve();
assert(world.lods?.length === 0 && !scene.children.some((child) => child.name === "limina-tree-population-batches"), "stream-out retained the tree controller/root");

console.log("p_tree_asset_scatter OK: asset.scatter pins source/reduced/impostor bytes, mounts the shared five-draw controller, converges without errors, and stream-out unregisters/detaches it");
