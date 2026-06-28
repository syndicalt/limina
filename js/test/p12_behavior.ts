// Phase 12 — behavior.* / npc.* / dialogue.* skills: real storage + DETERMINISTIC replay.
//
// Pins the invariants the behavior/dialogue seam MUST honour:
//   1. CLOSURE-BOUND MANAGERS: the skills mutate the BehaviorManager/DialogueManager returned
//      by registerCoreSkills().behavior — not a phantom (ctx.world as any).behaviorManager
//      (the old no-op bug). Reads come back through core.behavior.*.
//   2. DETERMINISM: memory fact.tick is the sim tick (ctx.tick), NOT wall-clock Date.now();
//      goal ids are tick+seq, NOT `goal_${Date.now()}`. Proven by:
//   3. REPLAY-EQUIVALENCE: record the sequence at known ticks, snapshot manager state, replay
//      the recorded stream into a FRESH core, snapshot again — assert BIT-IDENTICAL. A
//      wall-clock tick/id would differ between record and replay and fail this.
//   4. onEvent STORES the reaction; npc.setRoutine STORES the routine (not emit-only).
//   5. Dialogue traversal is real: start → choose advances the node + records history → get.
//
// Run: limina js/test/p12_behavior.ts   (exit 0 = pass)

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
  if (!cond) throw new Error("p12_behavior FAIL: " + msg);
}
function ok(res: MCPResponse): Record<string, unknown> {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
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

const PERMS = resolveProfile("builder.readWrite");
const NPC = "npc_guard";
const PLAYER = "player";
const PROFILE = "guard_profile";
const TREE = "greet";

// Known, distinct ticks per action (the replay must recompute fact.tick / goal-id from these).
const T = { define: 10, assign: 11, goal: 12, attitude: 13, routine: 14, event: 15, mem: 42, dlgDef: 20, start: 21, choose: 22 };

// The authoring sequence — invoked through `reg`, stamped at the given ticks. Used for both the
// recorded authoring run and (re-invoked by replayCommands) the replay run.
async function runSequence(reg: SkillRegistry): Promise<void> {
  const at = (tick: number) => ({ agentId: "agt", sessionId: "ses_p12", permissions: PERMS, tick, world: makeWorld(ops) });

  ok(await reg.invoke("behavior.define", {
    id: PROFILE, name: "Town Guard",
    routines: [{ id: "patrol_day", name: "Day Patrol", schedule: [{ hour: 8, action: "patrol", position: [1, 0, 2] }] }],
    goals: [{ id: "g_default", type: "guard", priority: 5 }],
    config: { faction: "town" },
  }, at(T.define)));

  ok(await reg.invoke("behavior.assign", { entity: NPC, profileId: PROFILE }, at(T.assign)));
  ok(await reg.invoke("behavior.setGoal", { entity: NPC, type: "patrol", position: [3, 0, 4], priority: 7 }, at(T.goal)));
  ok(await reg.invoke("npc.setAttitude", { entity: NPC, towardEntity: PLAYER, attitude: "hostile" }, at(T.attitude)));
  ok(await reg.invoke("npc.setRoutine", { entity: NPC, routineId: "patrol_day" }, at(T.routine)));
  ok(await reg.invoke("behavior.onEvent", {
    entity: NPC, trigger: "player.nearby",
    action: { type: "approach", data: { speed: 2 } }, priority: 3, cooldown: 1.5,
  }, at(T.event)));
  ok(await reg.invoke("npc.memorize", { entity: NPC, key: "sawPlayer", value: { at: [3, 0, 4] }, source: PLAYER }, at(T.mem)));

  ok(await reg.invoke("dialogue.define", {
    id: TREE, name: "Greeting", startNode: "n1",
    nodes: [
      { id: "n1", text: "Halt! Who goes there?", speaker: NPC, mood: "stern",
        choices: [{ text: "A friend.", nextNodeId: "n2" }, { text: "None of your business.", nextNodeId: "n3" }] },
      { id: "n2", text: "Pass, friend.", speaker: NPC, choices: [] },
      { id: "n3", text: "Then you shall not pass.", speaker: NPC, choices: [] },
    ],
  }, at(T.dlgDef)));
  ok(await reg.invoke("dialogue.start", { treeId: TREE, speaker: NPC, listener: PLAYER }, at(T.start)));
  ok(await reg.invoke("dialogue.choose", { speaker: NPC, listener: PLAYER, choiceIndex: 0 }, at(T.choose)));
}

// Serialize the full observable manager state through the PUBLIC getters (closure-bound).
function snapshot(core: CoreSkills): string {
  const bm = core.behavior.behaviorManager;
  const dm = core.behavior.dialogueManager;
  const tree = dm.getTree(TREE);
  const session = dm.getCurrentSession(NPC, PLAYER);
  return JSON.stringify({
    profile: bm.getProfile(PROFILE),
    assigned: bm.getAssignedProfile(NPC),
    goal: bm.getGoal(NPC),
    routine: bm.getRoutine(NPC),
    reactions: bm.getReactions(NPC),
    memories: bm.recall(NPC),
    attitude: bm.getAttitude(NPC, PLAYER),
    tree: tree ? { id: tree.id, startNode: tree.startNode, nodes: [...tree.nodes.keys()] } : undefined,
    session,
  });
}

// ── AUTHORING (recorded) ─────────────────────────────────────────────────────────────────
const recorder = new WorldRecorder("ses_p12");
const recReg = new SkillRegistry(new LiminaTracer("ses_p12"));
const recCore = registerCoreSkills(recReg);
recorder.attach(recReg);
await runSequence(recReg);

const bm = recCore.behavior.behaviorManager;
const dm = recCore.behavior.dialogueManager;

// (1) CLOSURE-BOUND: state actually landed in the manager returned by registerCoreSkills.
assert(bm.getProfile(PROFILE)?.name === "Town Guard", "behavior.define did not store the profile on the closure-bound manager");
assert(bm.getAssignedProfile(NPC)?.id === PROFILE, "behavior.assign did not bind the profile to the entity");

// (2) setGoal: deterministic id (tick+seq, NOT Date.now()).
const goal = bm.getGoal(NPC);
assert(goal !== undefined && goal.type === "patrol" && goal.priority === 7, "behavior.setGoal did not store the goal");
assert(goal.id === `goal_${T.goal}_0`, `goal id not deterministic (tick+seq): got ${goal.id}`);
assert(!/\d{12,}/.test(goal.id), `goal id looks like a Date.now() timestamp: ${goal.id}`);

// (2) memorize: fact.tick is the SIM tick used, NOT wall-clock.
const recalled = ok(await recReg.invoke("npc.recall", { entity: NPC, key: "sawPlayer" }, { agentId: "agt", sessionId: "ses_p12", permissions: PERMS, tick: 999, world: makeWorld(ops) }));
const mems = recalled.memories as { key: string; tick: number; source?: string }[];
assert(mems.length === 1 && mems[0].key === "sawPlayer", "npc.recall did not return the stored fact");
assert(mems[0].tick === T.mem, `fact.tick must equal the memorize sim tick ${T.mem} (NOT wall-clock): got ${mems[0].tick}`);
assert(mems[0].tick < 1e9, `fact.tick looks like a wall-clock timestamp: ${mems[0].tick}`);

// attitude stored.
assert(bm.getAttitude(NPC, PLAYER) === "hostile", "npc.setAttitude did not store the attitude");

// (4) onEvent STORED the reaction; setRoutine STORED the routine.
const reactions = bm.getReactions(NPC, "player.nearby");
assert(reactions.length === 1 && reactions[0].action.type === "approach" && reactions[0].cooldown === 1.5,
  "behavior.onEvent did not STORE the reaction descriptor (emit-only regression)");
assert(bm.getRoutine(NPC) === "patrol_day", "npc.setRoutine did not STORE the routine");

// (5) Dialogue traversal: start set n1, choose(0) advanced to n2, history recorded.
const session = dm.getCurrentSession(NPC, PLAYER);
assert(session !== undefined && session.currentNodeId === "n2", "dialogue.choose did not advance the node to n2");
assert(session.history.length === 1 && session.history[0].nodeId === "n1" && session.history[0].choiceIndex === 0,
  "dialogue history did not record the n1 choice");
const got = ok(await recReg.invoke("dialogue.get", { speaker: NPC, listener: PLAYER }, { agentId: "agt", sessionId: "ses_p12", permissions: PERMS, tick: 0, world: makeWorld(ops) }));
const cur = got.currentNode as { id: string; text: string } | undefined;
assert(cur?.id === "n2" && cur.text === "Pass, friend.", "dialogue.get did not report the advanced node");

const authState = snapshot(recCore);

// ── REPLAY-EQUIVALENCE: re-invoke the recorded stream into a FRESH core ──────────────────────
// Only the authoring skills were recorded (the two read-only recall/get probes ran AFTER attach
// too, but reads are harmless to replay). Filter to the authoring tools so the snapshot compares
// the recomputed mutating state.
let replayCore: CoreSkills | undefined;
await replayCommands(recorder.commands, {
  makeWorld: () => makeWorld(ops),
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    replayCore = registerCoreSkills(r);
    return r;
  },
  tracer: new LiminaTracer("ses_p12_replay"),
});
assert(replayCore !== undefined, "replay did not construct a core");
const replayState = snapshot(replayCore);

assert(replayState === authState,
  "replay recomputed DIFFERENT manager state than authoring (Date.now/seq regression?)\n  auth  : " + authState + "\n  replay: " + replayState);

// Falsifiable belt-and-braces: the recomputed goal id + fact tick match the deterministic ones.
const rGoal = replayCore.behavior.behaviorManager.getGoal(NPC);
assert(rGoal?.id === `goal_${T.goal}_0`, `replay goal id diverged: ${rGoal?.id}`);
const rMem = replayCore.behavior.behaviorManager.recall(NPC, "sawPlayer");
assert(rMem[0]?.tick === T.mem, `replay fact.tick diverged: ${rMem[0]?.tick}`);

ops.op_log(
  `p12_behavior OK: behavior/npc/dialogue skills are closure-bound to the managers from registerCoreSkills (no phantom ctx.world manager); ` +
  `onEvent STORES the reaction + setRoutine STORES the routine; memory fact.tick == ctx.tick (${T.mem}, not wall-clock) and goal id == goal_${T.goal}_0 (tick+seq, not Date.now()); ` +
  `dialogue start→choose advances n1→n2 with recorded history; record→replay into a fresh core recomputes BIT-IDENTICAL manager state.`,
);
