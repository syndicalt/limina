import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p40_asset_scatter_lifecycle FAIL: " + message);
}

function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return res.result as Record<string, unknown>;
}

function makeWorld(): { world: WorldContext; added: unknown[]; removed: unknown[] } {
  const ecs = createEcsWorld();
  const added: unknown[] = [];
  const removed: unknown[] = [];
  const scene = {
    add(o: unknown) { added.push(o); },
    remove(o: unknown) { removed.push(o); },
    position: { set() {}, x: 0, y: 0, z: 0 },
    background: null as unknown,
  };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    world: {
      ecs,
      transforms: createTransformStorage(ecs),
      spatial: new UniformGridSpatialIndex(),
      entities: new EntityTable(),
      tags: new Map(),
      scene,
      camera,
      ops,
      mode: "headless",
    },
    added,
    removed,
  };
}

ops.op_physics_create_world(-9.81);
const registry = new SkillRegistry(new LiminaTracer("ses_p40_asset_scatter_lifecycle"));
registerCoreSkills(registry);
const { world, added, removed } = makeWorld();
const base = {
  agentId: "agt_p40",
  sessionId: "ses_p40_asset_scatter_lifecycle",
  permissions: resolveProfile("builder.readWrite"),
  tick: 0,
  world,
};

const generated = ok(await registry.invoke("world.generateRegion", {
  seed: 4040,
  bounds: { minTx: 0, minTz: 0, maxTx: 0, maxTz: 0 },
  lod: 0,
  render: false,
}, base));
const regionId = generated.regionId as string;

const scattered = ok(await registry.invoke("asset.scatter", {
  regionId,
  config: { seed: 7, density: 8, assets: [{ id: "fixtures/mesh.glb" }], sizeRange: [0.8, 0.8] },
}, base));
assert((scattered.mounted as number) > 0, "asset.scatter mounted no InstancedMeshes");
const meshes = added.filter((o): o is THREE.InstancedMesh => o instanceof THREE.InstancedMesh);
assert(meshes.length === scattered.mounted, `scene.add captured ${meshes.length} meshes, expected ${scattered.mounted}`);

let objectDisposed = 0;
let ownedGeometryDisposed = 0;
let ownedMaterialDisposed = 0;
for (const mesh of meshes) {
  mesh.addEventListener("dispose", () => { objectDisposed++; });
  const geometryDispose = mesh.geometry.dispose.bind(mesh.geometry);
  mesh.geometry.dispose = () => { ownedGeometryDisposed++; geometryDispose(); };
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) {
    const materialDispose = material.dispose.bind(material);
    material.dispose = () => { ownedMaterialDisposed++; materialDispose(); };
  }
}

const streamed = ok(await registry.invoke("world.streamFollow", {
  regionId,
  anchor: [10_000, 0, 10_000],
  radius: 0,
}, base));
assert((streamed.removed as string[]).length > 0, "streamFollow did not unload the original tile");
assert(meshes.every((mesh) => removed.includes(mesh)), "stream unload did not remove every scatter InstancedMesh from the scene");
assert(objectDisposed === meshes.length, `stream unload disposed ${objectDisposed}/${meshes.length} scatter InstancedMeshes`);
assert(ownedGeometryDisposed === meshes.length, `stream unload disposed ${ownedGeometryDisposed}/${meshes.length} owned scatter geometries`);
assert(ownedMaterialDisposed === meshes.length, `stream unload disposed ${ownedMaterialDisposed}/${meshes.length} owned scatter materials`);

ops.op_log("p40_asset_scatter_lifecycle OK: streamed-out region disposes mounted asset.scatter InstancedMeshes");
