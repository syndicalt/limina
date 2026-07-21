// P74 — the BEHAVIOUR + EVENT RECORD FORMAT (Track-B keystone, B1). Proves the FORMAT exists, is
// set-able via a REAL recorded skill, is carried by a SELF-SUFFICIENT snapshot, and REPLAYS
// identically — WITHOUT implementing runtime execution (NPCs moving / events firing is B2/B3).
//
//   1. BehaviorSpec + EventSpec round-trip byte-stable (incl. defaults + agent-supplied records);
//      malformed specs are REJECTED by the schema (bad kind, out-of-range, unknown key, missing).
//   2. behavior.set through registry.invoke writes EntityEntry.behavior (the parsed canonical spec)
//      AND is RECORDED as a skill command (event.define too).
//   3. Snapshot self-sufficiency: a world with a behaviour-bearing entity + a defined event is
//      captured, restored into a FRESH world + FRESH event registry, and the behaviour + event
//      survive IDENTICALLY — with NO replay of the authoring commands (the keystone property).
//   4. Replay identity: replaying the recorded command stream into a fresh world rebuilds the SAME
//      behaviour + event state.
//   5. Graceful: a malformed behaviour via the skill → {success:false}, never an uncaught throw.
//
// Run: ./target/release/limina js/test/p74_behavior_events.ts   (exit 0 = pass)

import { EntityTable, ops, type WorldContext } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import { captureWorldSnapshot, parseSnapshot, restoreSnapshot, serializeSnapshot } from "../src/worldlog/snapshot.ts";
import type { EventSpecRegistry } from "../src/skills/behavior-spec.ts";
import {
  BehaviorSpecSchema,
  EventSpecSchema,
  DEFAULT_BEHAVIOR,
  DEFAULT_EVENT,
  parseBehaviorSpec,
  parseEventSpec,
  serializeBehaviorSpec,
  serializeEventSpec,
  type BehaviorSpec,
  type EventSpec,
} from "../src/behavior/behavior-spec.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p74_behavior_events: " + msg);
}

function makeHeadlessWorld(): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene, camera, ops, mode: "headless",
  };
}

const perms = resolveProfile("builder.readWrite");

// ════════════════════════════════════════════════════════════════════════════════════════════
// 1. FORMAT — byte-stable round-trip + strict rejection.
// ════════════════════════════════════════════════════════════════════════════════════════════

// A behaviour with EVERY variant exercised; script.params deliberately UNSORTED to prove the
// canonical form key-sorts the agent-supplied record.
const sampleBehaviors: BehaviorSpec[] = [
  DEFAULT_BEHAVIOR,
  { version: 1, kind: "patrol", waypoints: [[0, 0, 0], [5, 0, 2], [5, 0, 8]], speed: 1.5, loop: false },
  { version: 1, kind: "wander", radius: 4, speed: 0.8 },
  { version: 1, kind: "script", ref: "guard-post", params: { zeta: 1, alpha: { y: 2, x: 1 }, mid: [3, 2, 1] } },
];
for (const b of sampleBehaviors) {
  const once = serializeBehaviorSpec(b);
  const twice = serializeBehaviorSpec(parseBehaviorSpec(once));
  assert(once === twice, `BehaviorSpec ${b.kind} not byte-stable: ${once} vs ${twice}`);
}
// Canonical key-sorting is real: the unsorted script params serialize with sorted keys (nested too).
const scriptBytes = serializeBehaviorSpec(sampleBehaviors[3]);
assert(scriptBytes.includes('"params":{"alpha":{"x":1,"y":2},"mid":[3,2,1],"zeta":1}'),
  `script params not deep-key-sorted in canonical form: ${scriptBytes}`);
// A patrol authored WITHOUT `loop` picks up the default and serializes it in a fixed slot.
const patrolDefaulted = serializeBehaviorSpec(parseBehaviorSpec('{"version":1,"kind":"patrol","waypoints":[[0,0,0],[1,0,0]],"speed":2}'));
assert(patrolDefaulted.includes('"loop":true'), `patrol default loop not emitted: ${patrolDefaulted}`);

const sampleEvents: EventSpec[] = [
  DEFAULT_EVENT,
  { version: 1, trigger: { type: "onTick", every: 30 }, action: { type: "emit", event: "wave", payload: { n: 2 } } },
  { version: 1, trigger: { type: "onEnterRegion", center: [10, 0, 10], radius: 6 },
    action: { type: "setBehavior", entity: "ent_0", behavior: { version: 1, kind: "wander", radius: 3, speed: 1 } } },
  { version: 1, trigger: { type: "onInteract", entity: "ent_1" }, action: { type: "spawn", recipe: "goblin", origin: [2, 0, 2] } },
];
for (const e of sampleEvents) {
  const once = serializeEventSpec(e);
  const twice = serializeEventSpec(parseEventSpec(once));
  assert(once === twice, `EventSpec ${e.trigger.type}/${e.action.type} not byte-stable: ${once} vs ${twice}`);
}

// Strict rejection: each of these MUST fail schema validation (no throw — safeParse).
const badBehaviors: unknown[] = [
  { version: 1, kind: "sprint", speed: 1 },                                   // unknown kind
  { version: 1, kind: "wander", radius: -1, speed: 1 },                       // out-of-range (radius <= 0)
  { version: 1, kind: "patrol", waypoints: [[0, 0, 0]], speed: 1 },           // too few waypoints (< 2)
  { version: 1, kind: "wander", radius: 1, speed: 1, extra: true },           // unknown key (.strict)
  { version: 1, kind: "script" },                                            // missing required `ref`
  { version: 2, kind: "idle" },                                              // wrong version literal
];
for (const b of badBehaviors) {
  assert(!BehaviorSpecSchema.safeParse(b).success, `malformed BehaviorSpec was ACCEPTED: ${JSON.stringify(b)}`);
}
const badEvents: unknown[] = [
  { version: 1, trigger: { type: "always" }, action: { type: "emit", event: "x" } },              // unknown trigger type
  { version: 1, trigger: { type: "onTick", every: 0 }, action: { type: "emit", event: "x" } },    // every < 1
  { version: 1, trigger: { type: "onInteract", entity: "e" }, action: { type: "nuke" } },         // unknown action type
  { version: 1, trigger: { type: "onTick" }, action: { type: "emit", event: "x" }, extra: 1 },    // unknown top-level key
  { version: 1, action: { type: "emit", event: "x" } },                                           // missing trigger
  { version: 1, trigger: { type: "onTick" }, action: { type: "setBehavior", entity: "e", behavior: { version: 1, kind: "bogus" } } }, // nested bad behaviour
];
for (const e of badEvents) {
  assert(!EventSpecSchema.safeParse(e).success, `malformed EventSpec was ACCEPTED: ${JSON.stringify(e)}`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// 2. behavior.set / event.define through invoke — first-class state + RECORDED.
// ════════════════════════════════════════════════════════════════════════════════════════════

const recorder = new WorldRecorder("ses_p74");
const recReg = new SkillRegistry(new LiminaTracer("ses_p74"));
const recCore = registerCoreSkills(recReg);
const authEvents: EventSpecRegistry = recCore.behaviorSpec.events;
recorder.attach(recReg);
const recOps = recorder.wrapOps(ops);
recorder.seed(0x7474);
recOps.op_physics_create_world(-9.81);

const world = makeHeadlessWorld();
const at = (tick: number) => ({ agentId: "agt_p74", sessionId: "ses_p74", permissions: perms, tick, world });

// Create a real entity, then attach a patrol behaviour to it.
const rCreate = await recReg.invoke("scene.createEntity", { shape: "box", size: 1, position: [0, 1, 0] }, at(1));
assert(rCreate.success, "scene.createEntity failed");
const entId = (rCreate.result as { entity: string }).entity;

const patrol: BehaviorSpec = { version: 1, kind: "patrol", waypoints: [[0, 0, 0], [4, 0, 0], [4, 0, 4]], speed: 2 };
const rSet = await recReg.invoke("behavior.set", { entity: entId, behavior: patrol }, at(2));
assert(rSet.success && (rSet.result as { ok: boolean }).ok === true, `behavior.set must succeed: ${JSON.stringify(rSet.error)}`);

// The parsed CANONICAL spec landed on the entity (loop default filled in).
const stored = world.entities.resolve(entId)?.behavior;
assert(stored?.kind === "patrol", `EntityEntry.behavior must be the patrol spec, got ${JSON.stringify(stored)}`);
assert(stored !== undefined && serializeBehaviorSpec(stored) === serializeBehaviorSpec({ ...patrol, loop: true } as BehaviorSpec),
  `stored behaviour is not the canonical spec: ${JSON.stringify(stored)}`);

// Define a world-level event (onEnterRegion → setBehavior on this entity).
const evSpec: EventSpec = {
  version: 1, trigger: { type: "onEnterRegion", center: [4, 0, 4], radius: 3 },
  action: { type: "setBehavior", entity: entId, behavior: { version: 1, kind: "wander", radius: 2, speed: 1 } },
};
const rDef = await recReg.invoke("event.define", { event: evSpec }, at(3));
assert(rDef.success, `event.define must succeed: ${JSON.stringify(rDef.error)}`);
const evId = (rDef.result as { id: string }).id;
assert(authEvents.size() === 1 && authEvents.get(evId) !== undefined, "event.define did not register the spec in the world registry");

// RECORDED: both authoring skills are in the command stream (so they replay).
const recordedTools = recorder.commands.filter((c): c is { kind: "skill"; tool: string; input: unknown } => c.kind === "skill");
assert(recordedTools.some((c) => c.tool === "behavior.set"), "behavior.set was NOT recorded");
assert(recordedTools.some((c) => c.tool === "event.define"), "event.define was NOT recorded");

// ════════════════════════════════════════════════════════════════════════════════════════════
// 3. SNAPSHOT SELF-SUFFICIENCY — capture, restore into a FRESH world + registry, no replay.
// ════════════════════════════════════════════════════════════════════════════════════════════

const snap = captureWorldSnapshot(world, {
  sessionId: "ses_p74", tick: 10, snapshotSeq: recorder.commands.length, events: authEvents,
});
// The capture carries the behaviour on the entity and the event at world level.
const capEnt = snap.entities.find((e) => e.id === entId)!;
assert(capEnt.behavior?.kind === "patrol", `snapshot capture must carry entity behaviour: ${JSON.stringify(capEnt.behavior)}`);
assert(snap.events.length === 1 && snap.events[0].id === evId, "snapshot capture must carry the world event");

// JSON round-trip (the on-disk form) preserves both.
const parsed = parseSnapshot(serializeSnapshot(snap));
assert(parsed.entities.find((e) => e.id === entId)?.behavior?.kind === "patrol", "behaviour lost across snapshot JSON round-trip");
assert(parsed.events.length === 1 && parsed.events[0].spec.action.type === "setBehavior", "event lost across snapshot JSON round-trip");

// Restore into a BRAND-NEW world + registry — the keystone: a saved scene reloads WITHOUT replaying
// the authoring commands.
ops.op_physics_create_world(-9.81);
const freshWorld = makeHeadlessWorld();
const freshReg = new SkillRegistry(new LiminaTracer("ses_p74_restore"));
const freshCore = registerCoreSkills(freshReg);
const freshEvents = freshCore.behaviorSpec.events;
restoreSnapshot(freshWorld, parsed, undefined, freshEvents);

const restoredBehavior = freshWorld.entities.resolve(entId)?.behavior;
assert(restoredBehavior !== undefined && serializeBehaviorSpec(restoredBehavior) === serializeBehaviorSpec(stored),
  `restored behaviour differs from the captured one: ${JSON.stringify(restoredBehavior)}`);
assert(freshEvents.size() === 1, `restored event registry must have exactly the one event, got ${freshEvents.size()}`);
const restoredEvent = freshEvents.get(evId);
assert(restoredEvent !== undefined && serializeEventSpec(restoredEvent) === serializeEventSpec(authEvents.get(evId)!),
  `restored event differs from the captured one: ${JSON.stringify(restoredEvent)}`);

// ════════════════════════════════════════════════════════════════════════════════════════════
// 4. REPLAY IDENTITY — replay the recorded stream into a fresh world → identical state.
// ════════════════════════════════════════════════════════════════════════════════════════════

ops.op_physics_create_world(-9.81);
let replayEvents: EventSpecRegistry | undefined;
const replayResult = await replayCommands(recorder.commands, {
  makeWorld: makeHeadlessWorld,
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    replayEvents = registerCoreSkills(r).behaviorSpec.events;
    return r;
  },
  tracer: new LiminaTracer("ses_p74_replay"),
});
const replayBehavior = replayResult.world.entities.resolve(entId)?.behavior;
assert(replayBehavior !== undefined && serializeBehaviorSpec(replayBehavior) === serializeBehaviorSpec(stored),
  `replay rebuilt a DIFFERENT behaviour: ${JSON.stringify(replayBehavior)}`);
assert(replayEvents !== undefined && replayEvents.size() === 1, "replay did not rebuild the event registry from event.define");
assert(serializeEventSpec(replayEvents.get(evId)!) === serializeEventSpec(authEvents.get(evId)!),
  "replay rebuilt a DIFFERENT event");

// ════════════════════════════════════════════════════════════════════════════════════════════
// 5. GRACEFUL — a malformed behaviour via the skill → {success:false}, no throw.
// ════════════════════════════════════════════════════════════════════════════════════════════

const rBad = await recReg.invoke("behavior.set", { entity: entId, behavior: { version: 1, kind: "teleport" } }, at(4));
assert(rBad.success === false, "malformed behaviour must return success:false");
assert(rBad.error?.code === "invalid_input", `malformed behaviour must be rejected as invalid_input, got ${rBad.error?.code}`);
// The bad edit must NOT have clobbered the good behaviour.
assert(world.entities.resolve(entId)?.behavior?.kind === "patrol", "a rejected behaviour must not mutate the entity");
const rBadEvent = await recReg.invoke("event.define", { event: { version: 1, trigger: { type: "onTick" }, action: { type: "explode" } } }, at(5));
assert(rBadEvent.success === false && rBadEvent.error?.code === "invalid_input", "malformed event must return success:false invalid_input");

ops.op_log("[js] p74_behavior_events OK: BehaviorSpec + EventSpec round-trip byte-stable and reject malformed specs; behavior.set writes first-class EntityEntry.behavior (recorded); event.define registers a world-level event (recorded); a self-sufficient snapshot carries BOTH across a fresh restore with no authoring replay; the recorded stream replays to identical behaviour + event state; malformed specs are rejected as invalid_input without a throw or mutation");
