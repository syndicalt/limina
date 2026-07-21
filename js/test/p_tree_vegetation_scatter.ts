import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";

// The native script host exposes rAF but has no browser frame pump. Drive the skill's intentional
// one-archetype-per-frame upload boundary directly; browser timing itself is covered by browser gates.
globalThis.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
  callback(0);
  return 1;
}) as typeof requestAnimationFrame;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_tree_vegetation_scatter FAIL: ${message}`);
}
function ok(response: Awaited<ReturnType<SkillRegistry["invoke"]>>): Record<string, unknown> {
  if (response === undefined || !response.success) throw new Error(`tree vegetation scatter call failed: ${JSON.stringify(response?.error)}`);
  return response.result as Record<string, unknown>;
}

ops.op_physics_create_world(-9.81);
const registry = new SkillRegistry(new LiminaTracer("p_tree_vegetation_scatter"));
registerCoreSkills(registry);
const ecs = createEcsWorld(), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(); camera.position.set(0, 8, 0);
const world: WorldContext = { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(),
  tags: new Map(), scene, camera, ops, mode: "windowed" };
const base = { agentId: "tree", sessionId: "p_tree_vegetation_scatter", permissions: resolveProfile("builder.readWrite"), tick: 0, world };
const terrain = ok(await registry.invoke("terrain.create", { size: 80, resolution: 17, baseHeight: 4 }, base));
const scattered = ok(await registry.invoke("vegetation.scatter", { terrain: terrain.entity, density: 4, seed: 17,
  assets: [{ id: "oak.glb", treeLod: { reducedId: "oak-lod.glb", reducedDistance: 80,
    impostorId: "oak-impostor.glb", impostorDistance: 280, cullDistance: 1200, hysteresis: 0.15 } }],
  elevationMin: -100, elevationMax: 100, coverage: 1, cluster: 0 }, base));

assert((scattered.instances as number) > 0, "editable vegetation path produced no placements");
const hashes = scattered.assetHashes as Record<string, string>;
assert(Object.keys(hashes).sort().join(",") === "oak-impostor.glb,oak-lod.glb,oak.glb", "editable vegetation path did not pin all three content addresses");
assert(world.lods?.length === 1, "editable vegetation path did not register one tree controller");
const controller = world.lods![0] as unknown as { update(camera: THREE.Camera): void; settle(): Promise<void>; takeErrors(): unknown[] };
for (let index = 0; index < 4; index++) { controller.update(camera); await controller.settle(); }
assert(controller.takeErrors().length === 0, "editable vegetation controller reported a residency error");
const roots = scene.children.filter((child) => child.name === "limina-tree-population-batches");
assert(roots.length === 1, "editable vegetation path did not publish exactly one shared five-draw root");
const batches: THREE.InstancedMesh[] = [];
roots[0]!.traverse((object) => { if ((object as THREE.InstancedMesh).isInstancedMesh) batches.push(object as THREE.InstancedMesh); });
assert(batches.length === 5 && batches.reduce((sum, batch) => sum + batch.count, 0) > 0, "editable vegetation path did not publish five populated instanced batches");

world.entities.resolve(scattered.entity as string)?.runtimeDispose?.();
await Promise.resolve(); await Promise.resolve();
assert(world.lods?.length === 0 && !scene.children.some((child) => child.name === "limina-tree-population-batches"),
  "editable vegetation disposal retained the controller/root");

console.log("p_tree_vegetation_scatter OK: vegetation.scatter pins and mounts the source/reduced/impostor chain, converges, and unregisters cleanly");
