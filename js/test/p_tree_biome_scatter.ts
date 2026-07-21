import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";

function assert(condition: boolean, message: string): asserts condition { if (!condition) throw new Error(`p_tree_biome_scatter FAIL: ${message}`); }
function ok(response: Awaited<ReturnType<SkillRegistry["invoke"]>>): Record<string, unknown> {
  if (response === undefined || !response.success) throw new Error(`tree biome scatter call failed: ${JSON.stringify(response?.error)}`);
  return response.result as Record<string, unknown>;
}

ops.op_physics_create_world(-9.81);
const registry = new SkillRegistry(new LiminaTracer("p_tree_biome_scatter")); registerCoreSkills(registry);
const ecs = createEcsWorld(), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(); camera.position.set(0, 8, 0);
const world: WorldContext = { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(),
  tags: new Map(), scene, camera, ops, mode: "headless" };
const base = { agentId: "tree", sessionId: "p_tree_biome_scatter", permissions: resolveProfile("builder.readWrite"), tick: 0, world };
const generated = ok(await registry.invoke("world.generateRegion", { seed: 8080, type: "mountains",
  bounds: { minTx: 0, minTz: 0, maxTx: 0, maxTz: 0 }, lod: 0, render: false }, base));
const populated = ok(await registry.invoke("world.populateBiome", { regionId: generated.regionId, type: "mountains", biomePack: {
  conifer: { id: "oak.glb", treeLod: { reducedId: "oak-lod.glb", reducedDistance: 80,
    impostorId: "oak-impostor.glb", impostorDistance: 280, cullDistance: 1200, hysteresis: 0.15 } },
} }, base));
assert((populated.instances as number) > 0, "biome-driven tree layer produced no placements");
assert(world.lods?.length === 1 && scene.children.some((child) => child.name === "limina-tree-population-batches"),
  "world.populateBiome did not publish the shared tree controller/root");
const controller = world.lods![0] as unknown as { update(camera: THREE.Camera): void; settle(): Promise<void>; takeErrors(): unknown[] };
for (let index = 0; index < 4; index++) { controller.update(camera); await controller.settle(); }
assert(controller.takeErrors().length === 0, "biome-driven tree controller reported a residency error");
console.log("p_tree_biome_scatter OK: world.populateBiome validates and mounts the source/reduced/impostor chain through nested asset.scatter");
