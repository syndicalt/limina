import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import type { SkillCommand } from "../src/worldlog/log.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_population_asset_scatter: ${message}`);
}

function ok(response: MCPResponse | undefined): Record<string, unknown> {
  if (response === undefined || !response.success) throw new Error(`call failed: ${JSON.stringify(response?.error)}`);
  return response.result as Record<string, unknown>;
}

function makeWorld(): { world: WorldContext; added: unknown[]; removed: unknown[] } {
  const ecs = createEcsWorld();
  const added: unknown[] = [];
  const removed: unknown[] = [];
  const camera = new THREE.PerspectiveCamera();
  return {
    world: {
      ecs,
      transforms: createTransformStorage(ecs),
      spatial: new UniformGridSpatialIndex(),
      entities: new EntityTable(),
      tags: new Map(),
      scene: {
        add(object: unknown) { added.push(object); },
        remove(object: unknown) { removed.push(object); },
        position: { set() {}, x: 0, y: 0, z: 0 },
        background: null as unknown,
      },
      camera,
      ops,
      mode: "headless",
    },
    added,
    removed,
  };
}

ops.op_physics_create_world(-9.81);
const registry = new SkillRegistry(new LiminaTracer("ses_population_asset_scatter"));
const recorder = new WorldRecorder("ses_population_asset_scatter");
recorder.attach(registry);
const core = registerCoreSkills(registry);
const { world, added, removed } = makeWorld();
const base = {
  agentId: "agt_population",
  sessionId: "ses_population_asset_scatter",
  permissions: resolveProfile("builder.readWrite"),
  tick: 0,
  world,
};

const generated = ok(await registry.invoke("world.generateRegion", {
  seed: 5050,
  bounds: { minTx: 0, minTz: 0, maxTx: 0, maxTz: 0 },
  lod: 0,
  render: false,
}, base));
const regionId = generated.regionId as string;
const nearId = "fixtures/mesh.glb";
const farId = "fixtures/building.glb";
const scattered = ok(await registry.invoke("asset.scatter", {
  regionId,
  config: {
    seed: 8,
    density: 6,
    cellSize: 16,
    assets: [{
      id: nearId,
      embedRadius: 0.5,
      lods: [{ id: farId, distance: 24, hysteresis: 0.2 }],
    }],
    inclusions: [{ x: 16, z: 16, r: 48 }],
  },
}, base));

assert((scattered.instances as number) > 0, "LOD scatter produced no placements");
const hashes = scattered.assetHashes as Record<string, string>;
assert(hashes[nearId] === core.assets.resolve(nearId).hash, "base asset hash was not pinned");
assert(hashes[farId] === core.assets.resolve(farId).hash, "LOD asset hash was not pinned");
const command = recorder.commands.find((entry): entry is SkillCommand => entry.kind === "skill" && entry.tool === "asset.scatter");
const committedHashes = (command?.input as { assetHashes?: Record<string, string> } | undefined)?.assetHashes;
assert(committedHashes?.[nearId] === hashes[nearId] && committedHashes?.[farId] === hashes[farId], "world log did not commit base and LOD hashes");

const childMeshes = added.filter((object): object is THREE.InstancedMesh => object instanceof THREE.InstancedMesh);
assert(childMeshes.length === scattered.mounted, "mounted count does not include every aggregated LOD mesh");
assert(added.every((object) => object instanceof THREE.InstancedMesh), "LOD scatter mounted non-batch scene objects");
assert(world.lods?.length === 1, "population LOD controller was not registered with the render world");
assert(childMeshes.length === 3, `expected one near primitive plus two far primitives, got ${childMeshes.length}`);
assert(childMeshes.every((mesh) => mesh.instanceMatrix.count === scattered.instances), "LOD mesh capacity does not cover the population");
world.camera.position.set(10_000, 0, 10_000);
world.lods[0]!.update(world.camera);
assert(childMeshes[0]?.count === 0 && childMeshes.slice(1).every((mesh) => mesh.count === scattered.instances), "far camera did not aggregate every instance into the far level");

let disposed = 0;
for (const mesh of childMeshes) mesh.addEventListener("dispose", () => { disposed++; });
const streamed = ok(await registry.invoke("world.streamFollow", {
  regionId,
  anchor: [10_000, 0, 10_000],
  radius: 0,
}, base));
assert((streamed.removed as string[]).length > 0, "stream-out did not unload the source tile");
assert(childMeshes.every((mesh) => removed.includes(mesh)), "stream-out did not remove every population batch");
assert(disposed === childMeshes.length, `stream-out disposed ${disposed}/${childMeshes.length} LOD meshes`);
assert(world.lods?.length === 0, "stream-out retained a disposed population controller");

const invalidWorld = makeWorld().world;
const invalid = await registry.invoke("asset.scatter", {
  regionId,
  config: {
    seed: 9,
    assets: [{ id: nearId, lods: [{ id: farId, distance: 20 }, { id: "fixtures/textured-cube.glb", distance: 10 }] }],
  },
}, { ...base, world: invalidWorld });
assert(invalid !== undefined && !invalid.success && JSON.stringify(invalid.error).includes("strictly increasing"), "invalid LOD ordering was accepted");

console.log("p_population_asset_scatter: ok");
