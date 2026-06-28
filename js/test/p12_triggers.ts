// Phase 12 — TRIGGERS + EVENTS: the deterministic WHEN seam.
//
// This test pins the contract the trigger.* / event.* skills MUST honour:
//
//   1. CLOSURE WIRING: the skills act on the ONE TriggerManager/EventManager the
//      register fn returns (core.triggers.*). The previous cut read a manager off
//      ctx.world that the engine never sets — so every handler silently no-op'd.
//      Here we prove the handlers do REAL bookkeeping on the returned managers.
//   2. EVENT DISPATCH: event.emit actually dispatches to the listeners event.listen
//      registered (fired > 0 to a matching listener; 0 after event.remove). The
//      matched action descriptor (the agent-authored WHAT) rides the result.
//   3. TRIGGER PUMP: a box zone fires onEnter/onExit when an entity's position
//      crosses its bounds, driven by the manager's tick(entities) pump.
//   4. REPLAY-EQUIVALENCE: record an invoke sequence with WorldRecorder, snapshot the
//      manager state + outputs, replay the stream into a FRESH core, and assert the
//      replayed manager state + outputs are bit-identical (deterministic ids/state).
//
// Run: limina js/test/p12_triggers.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills, type CoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p12_triggers FAIL: " + msg);
}
function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return res.result as Record<string, unknown>;
}

function makeWorld(worldOps: EngineOps): WorldContext {
  const stub = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: stub as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

const BUILDER = resolveProfile("builder.readWrite");

// ===========================================================================
// AUTHORING RUN (recorded): create a trigger + attach onEnter/onExit, register
// two listeners, remove one, then emit two events.
// ===========================================================================
ops.op_physics_create_world(-9.81);
const recorder = new WorldRecorder("ses_p12_rec");
const recReg = new SkillRegistry(new LiminaTracer("ses_p12_rec"));
const recCore: CoreSkills = registerCoreSkills(recReg);
recorder.attach(recReg);
const recWorld = makeWorld(ops);
const base = { agentId: "agt_rec", sessionId: "ses_p12_rec", permissions: BUILDER, tick: 0, world: recWorld };

// (1) CLOSURE WIRING — the managers the skills mutate are the ones core exposes.
const triggerMgr = recCore.triggers.triggerManager;
const eventMgr = recCore.triggers.eventManager;

// Trigger zone: a 1×1×1 half-extent box at the origin, with an onEnter + onExit action.
const trig = ok(await recReg.invoke("trigger.create", { shape: "box", center: [0, 0, 0], size: [1, 1, 1] }, base));
const triggerId = trig.triggerId as string;
assert(triggerId === "trigger_0", `first trigger id must be deterministic (got ${triggerId})`);
assert(triggerMgr.get(triggerId) !== undefined, "trigger.create did NOT register on the closed-over manager (closure wiring broken)");

ok(await recReg.invoke("trigger.onEnter", { triggerId, action: { type: "audio", data: { clip: "chime" } } }, base));
ok(await recReg.invoke("trigger.onExit", { triggerId, action: { type: "emit", data: { event: "left_zone" } } }, base));
const zone = triggerMgr.get(triggerId);
assert(zone !== undefined && zone.actions.onEnter.length === 1 && zone.actions.onExit.length === 1,
  "trigger.onEnter/onExit did NOT record action descriptors on the manager");

// Event listeners: two for "door_opened", one for "boss_dead"; we remove the boss one.
const lA = ok(await recReg.invoke("event.listen", { eventName: "door_opened", action: { type: "setState", data: { door: "open" } } }, base));
const lB = ok(await recReg.invoke("event.listen", { eventName: "door_opened", action: { type: "audio", data: { clip: "creak" } } }, base));
const lC = ok(await recReg.invoke("event.listen", { eventName: "boss_dead", action: { type: "spawn", data: { loot: "key" } } }, base));
assert((lA.listenerId as string) === "listener_0", "listener ids must be deterministic");

const rmRes = ok(await recReg.invoke("event.remove", { listenerId: lC.listenerId as string }, base));
assert(rmRes.ok === true, "event.remove of a real listener must return ok");
void lB;

// (2) EVENT DISPATCH — emit door_opened fires the TWO remaining listeners; boss_dead fires 0.
const emitDoor = ok(await recReg.invoke("event.emit", { eventName: "door_opened", payload: { by: "agt_rec" } }, base));
assert((emitDoor.fired as number) === 2, `event.emit must dispatch to the 2 registered door_opened listeners (got ${emitDoor.fired}) — emit is no longer a no-op`);
const dispatched = emitDoor.dispatched as { listenerId: string; eventName: string; action: { type: string } }[];
assert(dispatched.length === 2 && dispatched[0].listenerId === "listener_0" && dispatched[1].listenerId === "listener_1",
  "event.emit must return the matched listeners' descriptors in registration order");
assert(dispatched[0].action.type === "setState" && dispatched[1].action.type === "audio",
  "dispatched descriptors must carry the agent-authored action (the WHAT)");

const emitBoss = ok(await recReg.invoke("event.emit", { eventName: "boss_dead", payload: {} }, base));
assert((emitBoss.fired as number) === 0, "event.emit to a removed listener's event must dispatch to 0 (event.remove must actually unregister)");

// Direct manager check: no listeners after removing the only boss_dead one.
assert(eventMgr.emit("boss_dead", {}).fired === 0, "EventManager.emit(boss_dead) should match nothing after remove");

// ===========================================================================
// (3) TRIGGER PUMP — drive tick(entities) across the zone bounds.
// ===========================================================================
// Entity starts OUTSIDE (x=5): no enter.
const tOut = triggerMgr.tick([{ id: "player", position: [5, 0, 0] }]);
assert(tOut.entered.length === 0 && tOut.fired.length === 0, "entity outside the zone must not fire onEnter");

// Entity moves INSIDE (x=0): onEnter fires its audio descriptor.
const tIn = triggerMgr.tick([{ id: "player", position: [0, 0, 0] }]);
assert(tIn.entered.length === 1 && tIn.entered[0].entityId === "player" && tIn.entered[0].triggerId === triggerId,
  "entity crossing INTO the zone must register an enter");
assert(tIn.fired.length === 1 && tIn.fired[0].phase === "onEnter" && tIn.fired[0].action.type === "audio",
  "onEnter must fire the attached audio action descriptor");
assert(triggerMgr.get(triggerId)!.entitiesInside.has("player"), "occupancy must record the entity inside");

// Entity stays INSIDE (x=0.5): a stay (no onStay actions attached → no fired).
const tStay = triggerMgr.tick([{ id: "player", position: [0.5, 0, 0] }]);
assert(tStay.stayed.length === 1 && tStay.entered.length === 0 && tStay.fired.length === 0, "still-inside entity must be a stay, not a re-enter");

// Entity moves OUTSIDE (x=5): onExit fires its emit descriptor.
const tExit = triggerMgr.tick([{ id: "player", position: [5, 0, 0] }]);
assert(tExit.exited.length === 1 && tExit.exited[0].entityId === "player",
  "entity crossing OUT of the zone must register an exit");
assert(tExit.fired.length === 1 && tExit.fired[0].phase === "onExit" && tExit.fired[0].action.type === "emit",
  "onExit must fire the attached emit action descriptor");
assert(!triggerMgr.get(triggerId)!.entitiesInside.has("player"), "occupancy must drop the departed entity");

// Snapshot the AUTHORING manager state (after the skill stream; the tick pump above is
// NOT a recorded skill, so re-snapshot a SEPARATE post-skill state for replay parity:
// occupancy is empty again after the exit, matching a fresh replay's untouched pump).
const authTrigSnap = JSON.stringify(triggerMgr.snapshot());
const authEvtSnap = JSON.stringify(eventMgr.snapshot());

// ===========================================================================
// (4) REPLAY-EQUIVALENCE — replay the recorded skill stream into a FRESH core and
// assert bit-identical manager state + dispatch outputs.
// ===========================================================================
let replayCore: CoreSkills | undefined;
const replay = await replayCommands(recorder.commands, {
  makeWorld: () => makeWorld(ops),
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    replayCore = registerCoreSkills(r);
    return r;
  },
  tracer: new LiminaTracer("ses_p12_replay"),
});
assert(replayCore !== undefined, "replay did not construct a core");
assert(replay.skillInvokes > 0, "replay re-invoked no skills");

const rTrigMgr = replayCore.triggers.triggerManager;
const rEvtMgr = replayCore.triggers.eventManager;

// State parity: the replayed managers reach the SAME state the authoring stream did
// (deterministic ids + recorded action descriptors). NOTE: the authoring snapshot's
// occupancy is empty (entity exited), and a fresh replay never ran the pump → also
// empty, so the snapshots match exactly.
const replayTrigSnap = JSON.stringify(rTrigMgr.snapshot());
const replayEvtSnap = JSON.stringify(rEvtMgr.snapshot());
assert(replayTrigSnap === authTrigSnap, "replay TriggerManager state is NOT bit-identical to authoring");
assert(replayEvtSnap === authEvtSnap, "replay EventManager state is NOT bit-identical to authoring");

// Output parity: re-emit door_opened on the REPLAYED bus → identical dispatch result.
const rEmit = rEvtMgr.emit("door_opened", { by: "agt_rec" });
assert(rEmit.fired === 2, "replayed bus must dispatch to the same 2 door_opened listeners");
assert(JSON.stringify(rEmit) === JSON.stringify(eventMgr.emit("door_opened", { by: "agt_rec" })),
  "replayed event.emit dispatch result is NOT bit-identical to authoring");

// Output parity: re-run the trigger pump on the REPLAYED manager → identical enter/exit/fired.
const rIn = rTrigMgr.tick([{ id: "player", position: [0, 0, 0] }]);
assert(JSON.stringify(rIn) === JSON.stringify(tIn), "replayed onEnter pump result is NOT bit-identical to authoring");
const rExit = rTrigMgr.tick([{ id: "player", position: [5, 0, 0] }]);
assert(JSON.stringify(rExit) === JSON.stringify(tExit), "replayed onExit pump result is NOT bit-identical to authoring");

ops.op_log(
  `p12_triggers OK: closure-wired managers (core.triggers.*) do real bookkeeping; ` +
  `event.emit DISPATCHES (door_opened → 2 listeners; 0 after event.remove) returning the authored descriptors; ` +
  `trigger pump fires onEnter/onExit as an entity crosses box bounds (onStay = stay, no double-enter); ` +
  `replay into a fresh core is bit-identical — manager state + ${replay.skillInvokes} skill invokes + emit/pump outputs all match.`,
);
