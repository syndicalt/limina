import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AssetRegistry } from "../src/asset-registry.ts";
import { parseFunctionalFurnitureContract } from "../src/assets/furniture-functional-contract.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { computeLocalOffset } from "../src/ecs/hierarchy.ts";
import { createEcsWorld, despawnRenderable, MAX_ENTITIES, Position, Rotation, spawnRenderable } from "../src/ecs/world.ts";
import { EntityTable, type EngineOps } from "../src/engine.ts";
import { LiminaTracer, type Tracer } from "../src/observability/event.ts";
import { registerFurnitureSkills } from "../src/skills/furniture.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { teardownEntity } from "../src/skills/entity-teardown.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import { captureWorldSnapshot, restoreSnapshot } from "../src/worldlog/snapshot.ts";

type Catalog = { artifact: { artifactId: string }; runtimeGlb: { path: string; sha256: string } };
type Instance = { id: string; catalogArtifactId: string; placement: { position: [number, number, number]; yawRadians: number } };
type Socket = { id: string; position: [number, number, number]; facing: [number, number, number] };
type Placed = { root: string; colliders: string[]; sockets: Socket[]; hash: string; contractHash: string };
const workspace = new URL("../../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("assets/buildings/authoring/functional-hall-house-v4/composition-r3/composition-manifest.json", workspace), "utf8")) as {
  dependencies: { catalog: Catalog[] }; instances: Instance[];
};
assert.equal(manifest.instances.length, 7);

const catalog = new Map(manifest.dependencies.catalog.map((entry) => [entry.artifact.artifactId, entry]));
const source = new Map<string, Uint8Array>();
const contracts = new Map<string, ReturnType<typeof parseFunctionalFurnitureContract>>();
for (const entry of manifest.dependencies.catalog) {
  const assetId = entry.runtimeGlb.path.replace(/^assets\//, ""), bytes = new Uint8Array(await readFile(new URL(entry.runtimeGlb.path, workspace)));
  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, entry.runtimeGlb.sha256, `${assetId} bytes drifted`);
  source.set(assetId, bytes); contracts.set(entry.artifact.artifactId, parseFunctionalFurnitureContract(bytes));
}
assert.equal(manifest.instances.reduce((sum, instance) => sum + contracts.get(instance.catalogArtifactId)!.colliders.length, 0), 86);
assert.equal(manifest.instances.reduce((sum, instance) => sum + contracts.get(instance.catalogArtifactId)!.sockets.length, 0), 12);

const inert = () => ({ position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } });
function baseOps(counters: { added: number[]; removed: number[] }): EngineOps {
  let nextBody = 1;
  return {
    op_physics_add_static_box() { const id = nextBody++; counters.added.push(id); return id; },
    op_physics_set_body_transform() {},
    op_physics_remove_body(id: number) { counters.removed.push(id); },
    op_physics_body_transform(_id: number, out: Float32Array) { out.fill(0); out[6] = 1; },
    op_physics_snapshot() { return new Uint8Array(); },
    op_physics_restore() {},
  } as unknown as EngineOps;
}
function makeWorld(ops: EngineOps): WorldContext & { sceneAdds: number; sceneRemoves: number } {
  const ecs = createEcsWorld();
  const world = {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(),
    sceneAdds: 0, sceneRemoves: 0,
    scene: { add() { world.sceneAdds++; }, remove() { world.sceneRemoves++; }, position: { set() {}, x: 0, y: 0, z: 0 }, background: null },
    camera: { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} }, ops, simWorker: false, mode: "headless",
  } as unknown as WorldContext & { sceneAdds: number; sceneRemoves: number };
  return world;
}
const assetOps = { op_sha256: () => "", op_read_asset: (id: string) => source.get(id) ?? new Uint8Array() } as unknown as EngineOps;
function makeRegistry(tracer: Tracer): SkillRegistry {
  const assets = new AssetRegistry(assetOps);
  for (const [id, bytes] of source) assets.seed(id, bytes);
  const registry = new SkillRegistry(tracer); registerFurnitureSkills(registry, assets); return registry;
}
const context = (world: WorldContext, tick: number) => ({ agentId: "test", sessionId: "semantic-furniture", permissions: new Set(["scene.write"]), tick, world });
const rotateY = ([x, y, z]: readonly number[], yaw: number): [number, number, number] => {
  const c = Math.cos(yaw), s = Math.sin(yaw); return [x * c + z * s, y, -x * s + z * c];
};
const buildingPosition: [number, number, number] = [13, 0.4, -9], buildingYaw = 0.37;
async function placeSeven(registry: SkillRegistry, world: WorldContext, tickOffset = 0): Promise<Placed[]> {
  const placed: Placed[] = [];
  for (const [index, instance] of manifest.instances.entries()) {
    const entry = catalog.get(instance.catalogArtifactId)!, local = rotateY(instance.placement.position, buildingYaw);
    const assetId = entry.runtimeGlb.path.replace(/^assets\//, ""), contract = contracts.get(instance.catalogArtifactId)!;
    const response = await registry.invoke("furniture.placeFunctional", {
      assetId, contractHash: contract.contractHash, visual: false,
      position: [buildingPosition[0] + local[0], buildingPosition[1] + local[1], buildingPosition[2] + local[2]],
      yaw: buildingYaw + instance.placement.yawRadians,
    }, context(world, tickOffset + index + 1));
    assert.equal(response.success, true, `${instance.id} semantic placement failed: ${JSON.stringify(response.error)}`);
    placed.push(response.result as Placed);
  }
  return placed;
}
function spawnParent(world: WorldContext): string {
  const eid = spawnRenderable(world.ecs, inert() as never, ...buildingPosition);
  const q = [0, Math.sin(buildingYaw / 2), 0, Math.cos(buildingYaw / 2)];
  Rotation.x[eid] = q[0]; Rotation.y[eid] = q[1]; Rotation.z[eid] = q[2]; Rotation.w[eid] = q[3];
  const id = world.entities.create({ eid, origin: { tool: "test.semanticFurnitureOwner", input: {} } });
  world.tags.set(eid, new Set(["semantic-furniture-owner"])); return id;
}
async function destroySeven(registry: SkillRegistry, world: WorldContext, placed: readonly Placed[], tickOffset = 100): Promise<void> {
  for (const [index, item] of [...placed].reverse().entries()) {
    const response = await registry.invoke("furniture.destroyFunctional", { root: item.root }, context(world, tickOffset + index));
    assert.equal(response.success, true, `semantic destroy failed: ${JSON.stringify(response.error)}`);
    assert.equal((response.result as { removed: string[] }).removed.length, item.colliders.length + 1);
  }
}

const lifecycleCounts = { added: [] as number[], removed: [] as number[] }, lifecycleWorld = makeWorld(baseOps(lifecycleCounts));
const lifecycleRegistry = makeRegistry(new LiminaTracer("semantic-furniture-lifecycle")), owner = spawnParent(lifecycleWorld);
for (let cycle = 0; cycle < 3; cycle++) {
  const beforeAdded = lifecycleCounts.added.length, beforeRemoved = lifecycleCounts.removed.length;
  const placed = await placeSeven(lifecycleRegistry, lifecycleWorld, cycle * 20);
  assert.equal(placed.reduce((sum, item) => sum + item.colliders.length, 0), 86);
  assert.equal(placed.reduce((sum, item) => sum + item.sockets.length, 0), 12);
  assert.equal(lifecycleWorld.sceneAdds, 0, "visual=false loaded or mounted a GLB scene");
  for (const [index, item] of placed.entries()) {
    const entry = lifecycleWorld.entities.resolve(item.root)!;
    assert.equal(entry.mesh, undefined); assert.equal((entry.origin!.input as { visual: boolean }).visual, false);
    assert.deepEqual((entry.origin!.input as { sockets: Socket[] }).sockets, item.sockets, "transformed sockets were not preserved in replay origin");
    assert(lifecycleWorld.tags.get(entry.eid)?.has("functional-furniture-root"));
    assert(lifecycleWorld.tags.get(entry.eid)?.has("functional-furniture-semantic-only"));
    const instance = manifest.instances[index], contract = contracts.get(instance.catalogArtifactId)!;
    const local = rotateY(instance.placement.position, buildingYaw), expectedPosition = [buildingPosition[0] + local[0], buildingPosition[1] + local[1], buildingPosition[2] + local[2]];
    assert([Position.x[entry.eid], Position.y[entry.eid], Position.z[entry.eid]].every((value, axis) => Math.abs(value - expectedPosition[axis]) < 1e-6),
      `${instance.id} root lost its arbitrary placement`);
    const yaw = buildingYaw + instance.placement.yawRadians;
    for (const authored of contract.sockets) {
      const actual = item.sockets.find((socket) => socket.id === authored.id)!, offset = rotateY(authored.position, yaw), facing = rotateY(authored.facing, yaw);
      const expected = [expectedPosition[0] + offset[0], expectedPosition[1] + offset[1], expectedPosition[2] + offset[2]];
      assert(actual.position.every((value, axis) => Math.abs(value - expected[axis]) < 1e-9), `${instance.id}/${authored.id} position lost arbitrary transform`);
      assert(actual.facing.every((value, axis) => Math.abs(value - facing[axis]) < 1e-9), `${instance.id}/${authored.id} facing lost arbitrary yaw`);
    }
    lifecycleWorld.entities.setParent(item.root, owner, computeLocalOffset(lifecycleWorld, owner, entry.eid));
  }
  assert.equal(lifecycleWorld.entities.childrenOf(owner).length, 7);
  await destroySeven(lifecycleRegistry, lifecycleWorld, placed, cycle * 20 + 8);
  assert.equal(lifecycleWorld.entities.childrenOf(owner).length, 0, "destroy left semantic roots attached to their owner");
  assert.equal(lifecycleWorld.entities.ids().length, 1, "semantic lifecycle leaked entities");
  assert.equal(lifecycleCounts.added.length - beforeAdded, 86); assert.equal(lifecycleCounts.removed.length - beforeRemoved, 86);
}
teardownEntity(lifecycleWorld, owner); assert.equal(lifecycleWorld.entities.ids().length, 0);

const recordCounts = { added: [] as number[], removed: [] as number[] }, recorder = new WorldRecorder("semantic-furniture-replay");
const recordedWorld = makeWorld(recorder.wrapOps(baseOps(recordCounts))), recordedRegistry = makeRegistry(new LiminaTracer("semantic-furniture-record"));
recorder.attach(recordedRegistry); recorder.seed(0xF17E);
const recorded = await placeSeven(recordedRegistry, recordedWorld);
assert.equal(recorder.commands.filter((command) => command.kind === "skill").length, 7);
assert(recorder.commands.filter((command) => command.kind === "skill").every((command) => command.input.visual === false), "visual=false was not replay-authoritative");
const replayCounters = { added: [] as number[], removed: [] as number[] };
const replayed = await replayCommands(recorder.commands, {
  makeWorld: () => makeWorld(baseOps(replayCounters)), makeRegistry, tracer: new LiminaTracer("semantic-furniture-replay"),
});
assert.equal(replayed.skillInvokes, 7); assert.equal(replayed.world.entities.ids().length, 93); // 7 roots + 86 colliders
assert.equal((replayed.world as WorldContext & { sceneAdds: number }).sceneAdds, 0, "replay duplicated GLB visuals");
const replayRoots = replayed.world.entities.ids().filter((id) => replayed.world.entities.resolve(id)?.origin?.tool === "furniture.placeFunctional");
assert.equal(replayRoots.length, 7);
assert(replayRoots.every((id) => (replayed.world.entities.resolve(id)!.origin!.input as { visual: boolean }).visual === false));

const replayOwner = spawnParent(replayed.world);
for (const root of replayRoots) replayed.world.entities.setParent(root, replayOwner, computeLocalOffset(replayed.world, replayOwner, replayed.world.entities.resolve(root)!.eid));
const snapshot = captureWorldSnapshot(replayed.world, { sessionId: "semantic-furniture-replay", tick: 7, snapshotSeq: recorder.commands.length });
const restoredCounters = { added: [] as number[], removed: [] as number[] }, restoredWorld = makeWorld(baseOps(restoredCounters));
restoreSnapshot(restoredWorld, snapshot);
const restoredRegistry = makeRegistry(new LiminaTracer("semantic-furniture-restored"));
const restoredRoots = restoredWorld.entities.ids().filter((id) => restoredWorld.entities.resolve(id)?.origin?.tool === "furniture.placeFunctional");
assert.equal(restoredRoots.length, 7); assert.equal(restoredWorld.entities.childrenOf(replayOwner).length, 7);
assert.equal(restoredRoots.reduce((sum, root) => sum + ((restoredWorld.entities.resolve(root)!.origin!.input as { sockets: Socket[] }).sockets?.length ?? 0), 0), 12);
assert(restoredRoots.every((root) => restoredWorld.tags.get(restoredWorld.entities.resolve(root)!.eid)?.has("functional-furniture-semantic-only")));
await destroySeven(restoredRegistry, restoredWorld, restoredRoots.map((root) => ({ root, colliders: restoredWorld.entities.childrenOf(root), sockets: [], hash: "", contractHash: "" })));
assert.equal(restoredWorld.entities.childrenOf(replayOwner).length, 0); assert.equal(restoredCounters.removed.length, 86);
teardownEntity(restoredWorld, replayOwner); assert.equal(restoredWorld.entities.ids().length, 0, "snapshot teardown leaked semantic furniture");

// Default remains visual=true for existing callers and recordings.
const defaultWorld = makeWorld(baseOps({ added: [], removed: [] })), defaultRegistry = makeRegistry(new LiminaTracer("semantic-furniture-default"));
defaultWorld.simWorker = true; // Exercise the existing default input/origin path without asking this CPU test to decode textures.
const first = manifest.instances[0], firstEntry = catalog.get(first.catalogArtifactId)!, defaultResponse = await defaultRegistry.invoke("furniture.placeFunctional", {
  assetId: firstEntry.runtimeGlb.path.replace(/^assets\//, ""), contractHash: contracts.get(first.catalogArtifactId)!.contractHash,
}, context(defaultWorld, 1));
assert.equal(defaultResponse.success, true); assert.equal((defaultWorld.entities.resolve((defaultResponse.result as Placed).root)!.origin!.input as { visual: boolean }).visual, true);
teardownEntity(defaultWorld, (defaultResponse.result as Placed).root);

const capacityCounts = { added: [] as number[], removed: [] as number[] }, capacityWorld = makeWorld(baseOps(capacityCounts));
const occupied: number[] = [];
let saturated = false;
while (!saturated && occupied.length <= MAX_ENTITIES) {
  try { occupied.push(spawnRenderable(capacityWorld.ecs, inert() as never, 0, 0, 0)); }
  catch (error) { assert.match(String(error), /MAX_ENTITIES/); saturated = true; }
}
assert.equal(saturated, true, "capacity fixture did not saturate ECS");
const capacityRegistry = makeRegistry(new LiminaTracer("semantic-furniture-capacity"));
const capacityResponse = await capacityRegistry.invoke("furniture.placeFunctional", {
  assetId: firstEntry.runtimeGlb.path.replace(/^assets\//, ""), contractHash: contracts.get(first.catalogArtifactId)!.contractHash, visual: false,
}, context(capacityWorld, 1));
assert.equal(capacityResponse.success, false); assert.match(capacityResponse.error?.message ?? "", /MAX_ENTITIES|capacity/);
assert.equal(capacityWorld.entities.ids().length, 0, "capacity failure published a semantic root");
assert.equal(capacityCounts.added.length, 0, "capacity failure reached collider publication");
for (const eid of occupied.reverse()) despawnRenderable(capacityWorld.ecs, eid);

console.log("p_functional_furniture_semantic_only OK: seven exact instances, 86 colliders, 12 sockets; arbitrary transform, replay, snapshot, parent-safe three-cycle teardown; default visual behavior preserved");
