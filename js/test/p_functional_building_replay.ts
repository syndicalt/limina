import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld, Position, Rotation } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import { captureWorldSnapshot, restoreSnapshot } from "../src/worldlog/snapshot.ts";
import { AssetRegistry } from "../src/asset-registry.ts";
import { sha256 } from "../src/world/sha256.mjs";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`p_functional_building_replay FAIL: ${message}`); }
function makeWorld(worldOps: EngineOps): WorldContext {
  const ecs = createEcsWorld();
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(),
    scene: { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null },
    camera: { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} }, ops: worldOps, mode: "headless", simWorker: true } as WorldContext;
}
const assetId = "buildings/functional-hall-house-v4-production.glb";
const approvedR1Path = "buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653/functional-hall-house-v4-production.glb";
const approvedR1RawHash = "sha256:20063648f0c7aa7331b348e66bb714b419e2b8a1fa215045fb775d6c0ee3fb99";
const approvedR1EngineHash = "sha256:d228705fedbcf0cb7b92cc0b14ecf77e87c89e55fdbba3b6c8ea1a8f25948f69";
const approvedR1Bytes = ops.op_read_asset(approvedR1Path);
assert(`sha256:${sha256(approvedR1Bytes)}` === approvedR1RawHash, "approved R1 raw bytes drifted");
function makeRegistry(tracer: LiminaTracer): SkillRegistry {
  const registry = new SkillRegistry(tracer), assets = new AssetRegistry(ops);
  assets.seed(assetId, approvedR1Bytes);
  registerCoreSkills(registry, { assets });
  return registry;
}
const perms = resolveProfile("builder.readWrite");

const recorder = new WorldRecorder("functional-author");
const wrapped = recorder.wrapOps(ops), world = makeWorld(wrapped), registry = makeRegistry(new LiminaTracer("functional-author"));
recorder.attach(registry); recorder.seed(0xF00D);
wrapped.op_physics_create_world(0);
const at = (tick: number) => ({ agentId: "builder", sessionId: "functional-author", permissions: perms, tick, world });
const placed = await registry.invoke("building.placeFunctional", { assetId, position: [11, 0, -7], yaw: 0.37 }, at(1));
assert(placed.success, `place failed: ${JSON.stringify(placed.error)}`);
const out = placed.result as { root: string; doors: string[]; hash: string };
assert(out.hash === approvedR1EngineHash, `approved R1 engine hash drifted: ${out.hash}`);
const door = out.doors[0];
const opened = await registry.invoke("door.setOpen", { door, open: true }, at(2));
assert(opened.success, `open failed: ${JSON.stringify(opened.error)}`);
const authored = world.entities.resolve(door)!;
const authoredPose = [Position.x[authored.eid], Position.y[authored.eid], Position.z[authored.eid], Rotation.y[authored.eid], Rotation.w[authored.eid]];
assert(world.tags.get(authored.eid)?.has("door-open"), "authored door state tag is not open");

const replayed = await replayCommands(recorder.commands, {
  makeWorld: () => makeWorld(ops), makeRegistry, tracer: new LiminaTracer("functional-replay"),
});
const replayDoor = replayed.world.entities.resolve(door)!;
const replayPose = [Position.x[replayDoor.eid], Position.y[replayDoor.eid], Position.z[replayDoor.eid], Rotation.y[replayDoor.eid], Rotation.w[replayDoor.eid]];
assert(JSON.stringify(replayPose) === JSON.stringify(authoredPose), `replay door pose drifted: ${JSON.stringify(replayPose)} vs ${JSON.stringify(authoredPose)}`);
assert(replayed.world.tags.get(replayDoor.eid)?.has("door-open"), "replay lost open state");
assert(replayed.skillInvokes === 2, `expected place+open replay, got ${replayed.skillInvokes}`);

const snapshot = captureWorldSnapshot(replayed.world, { sessionId: "functional-replay", tick: 2, snapshotSeq: recorder.commands.length });
const restoredWorld = makeWorld(ops); restoreSnapshot(restoredWorld, snapshot);
const restored = restoredWorld.entities.resolve(door)!;
assert(restored.origin?.tool === "building.functionalDoor", "snapshot lost the door descriptor origin");
assert(restoredWorld.tags.get(restored.eid)?.has("door-open"), "snapshot lost open state");
const restoredRegistry = makeRegistry(new LiminaTracer("functional-restored"));
const closed = await restoredRegistry.invoke("door.setOpen", { door, open: false },
  { agentId: "builder", sessionId: "functional-restored", permissions: perms, tick: 3, world: restoredWorld });
assert(closed.success && restoredWorld.tags.get(restored.eid)?.has("door-closed"), "restored door could not be closed");
const closedAgain = await restoredRegistry.invoke("door.setOpen", { door, open: false },
  { agentId: "builder", sessionId: "functional-restored", permissions: perms, tick: 4, world: restoredWorld });
assert(closedAgain.success, "absolute close was not idempotent after snapshot restore");
console.log(`p_functional_building_replay OK: hash=${out.hash}, door=${door}, replay and snapshot-toggle stable`);
