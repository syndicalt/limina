// Phase 12 — quest.* lifecycle + DETERMINISM/REPLAY parity.
//
// Pins the quest system invariants:
//   1. LIFECYCLE: define -> offer -> accept -> update objective -> complete, with
//      the right state transitions and list() filtering.
//   2. DETERMINISTIC TICKS: offeredTick/acceptedTick/completedTick/failedTick come
//      from ctx.tick (the recorded sim tick), NOT wall-clock — asserted to equal the
//      exact ticks the calls were made at.
//   3. REPLAY-EQUIVALENCE: record the lifecycle with WorldRecorder at known ticks,
//      snapshot the quest state, replay the command stream into a FRESH core, and
//      assert BIT-IDENTICAL quest state. This is the teeth on the Date.now regression:
//      a wall-clock tick would diverge between authoring and replay and fail here.
//
// Run: limina js/test/p12_quest.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills, type CoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";
import type { QuestManager } from "../src/skills/quest.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p12_quest FAIL: " + msg);
}
function ok(res: MCPResponse): Record<string, unknown> {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return (res.result ?? {}) as Record<string, unknown>;
}

ops.op_physics_create_world(0);
const BUILDER = resolveProfile("builder.readWrite");
const HERO = "hero";

function makeWorld(worldOps: EngineOps): WorldContext {
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

/** Stable, ordered snapshot of an entity's full quest state (incl. all ticks). */
function snapshot(mgr: QuestManager, entity: string): string {
  return JSON.stringify(mgr.list(entity));
}

// ── AUTHORING: drive the full quest lifecycle through a RECORDED registry ─────────────
const recorder = new WorldRecorder("ses_p12_quest");
const recReg = new SkillRegistry(new LiminaTracer("ses_p12_quest"));
const recCore: CoreSkills = registerCoreSkills(recReg);
recorder.attach(recReg); // record top-level invokes (depth 0)
const recMgr = recCore.quest.questManager;
const world = makeWorld(ops);

// Each call carries a KNOWN tick so we can assert the stamped ticks come from ctx.tick.
const at = (tick: number): InvokeBase => ({ agentId: "agt_q", sessionId: "ses_p12_quest", permissions: BUILDER, tick, world });
const call = (tool: string, input: unknown, tick: number) => recReg.invoke(tool, input, at(tick));

// (1) Define four quests: a main (1 objective, with rewards + follow-up), a side (2
//     objectives, force-completed), one to fail, and one to decline.
ok(await call("quest.define", {
  id: "q_main", name: "Gather Herbs",
  objectives: [{ id: "herbs", type: "collect", description: "Collect 3 herbs", required: 3 }],
  rewards: { xp: 100, gold: 50 }, followUpQuests: ["q_epilogue"],
}, 1));
ok(await call("quest.define", {
  id: "q_side", name: "Two Tasks",
  objectives: [
    { id: "a", type: "kill", description: "Slay 2 wolves", required: 2 },
    { id: "b", type: "reach", description: "Reach the ridge", required: 1 },
  ],
  rewards: { xp: 25 },
}, 1));
ok(await call("quest.define", { id: "q_fail", name: "Doomed", objectives: [{ id: "x", type: "custom", description: "?", required: 1 }] }, 1));
ok(await call("quest.define", { id: "q_decline", name: "Maybe Later", objectives: [{ id: "y", type: "talk", description: "Talk", required: 1 }] }, 1));

// (2) Offer all four at tick 5.
for (const id of ["q_main", "q_side", "q_fail", "q_decline"]) {
  assert(ok(await call("quest.offer", { entity: HERO, questId: id }, 5)).ok === true, `offer ${id} failed`);
}
assert((ok(await call("quest.list", { entity: HERO, status: "available" }, 5)).quests as unknown[]).length === 4, "expected 4 available quests after offers");
assert(recMgr.getInstance(HERO, "q_main")?.offeredTick === 5, "offeredTick not stamped from ctx.tick (5)");

// (3) Decline one, accept the rest at tick 10.
assert(ok(await call("quest.decline", { entity: HERO, questId: "q_decline" }, 6)).ok === true, "decline failed");
assert(recMgr.getInstance(HERO, "q_decline") === undefined, "declined quest must be removed");
for (const id of ["q_main", "q_side", "q_fail"]) {
  assert(ok(await call("quest.accept", { entity: HERO, questId: id }, 10)).ok === true, `accept ${id} failed`);
}
assert(recMgr.getInstance(HERO, "q_main")?.status === "active", "q_main should be active after accept");
assert(recMgr.getInstance(HERO, "q_main")?.acceptedTick === 10, "acceptedTick not stamped from ctx.tick (10)");

// (4) Track q_main; it must be tracked and the others not.
assert(ok(await call("quest.track", { entity: HERO, questId: "q_main" }, 11)).ok === true, "track failed");
assert(recMgr.getInstance(HERO, "q_main")?.tracked === true, "q_main must be tracked");
assert(recMgr.getInstance(HERO, "q_side")?.tracked === false, "q_side must not be tracked");

// (5) GATE: completing before objectives are satisfied (no force) must be rejected.
assert(ok(await call("quest.complete", { entity: HERO, questId: "q_main" }, 12)).ok === false, "complete must reject unsatisfied objectives");
assert(recMgr.getInstance(HERO, "q_main")?.status === "active", "rejected complete must leave the quest active");

// (6) Drive q_main's objective to its required count at tick 20 -> auto-completes.
const upd = ok(await call("quest.update", { entity: HERO, questId: "q_main", objectiveId: "herbs", progress: 3 }, 20));
assert(upd.completed === true && upd.questCompleted === true, "objective + quest should auto-complete at required count");
assert(JSON.stringify(upd.rewards) === JSON.stringify({ xp: 100, gold: 50 }), "auto-complete must surface rewards (not silently dropped)");
assert(JSON.stringify(upd.followUpQuests) === JSON.stringify(["q_epilogue"]), "auto-complete must surface follow-up quests");
assert(recMgr.getInstance(HERO, "q_main")?.status === "completed", "q_main should be completed after objective satisfied");
assert(recMgr.getInstance(HERO, "q_main")?.completedTick === 20, "completedTick not stamped from ctx.tick (20)");

// (7) q_side: partial progress, reject plain complete, then FORCE-complete at tick 24.
ok(await call("quest.update", { entity: HERO, questId: "q_side", objectiveId: "a", progress: 2 }, 22));
assert(recMgr.getInstance(HERO, "q_side")?.status === "active", "q_side must stay active with an objective outstanding");
assert(ok(await call("quest.complete", { entity: HERO, questId: "q_side" }, 23)).ok === false, "complete must reject a quest with an outstanding objective");
const forced = ok(await call("quest.complete", { entity: HERO, questId: "q_side", force: true }, 24));
assert(forced.ok === true, "force complete must succeed");
assert(JSON.stringify(forced.rewards) === JSON.stringify({ xp: 25 }), "force complete must surface rewards");
assert(recMgr.getInstance(HERO, "q_side")?.completedTick === 24, "force completedTick not stamped from ctx.tick (24)");
assert(recMgr.getInstance(HERO, "q_side")?.objectives.every((o) => o.completed) === true, "force complete must mark objectives complete");

// (8) Fail q_fail at tick 30.
assert(ok(await call("quest.fail", { entity: HERO, questId: "q_fail" }, 30)).ok === true, "fail failed");
assert(recMgr.getInstance(HERO, "q_fail")?.status === "failed", "q_fail should be failed");
assert(recMgr.getInstance(HERO, "q_fail")?.failedTick === 30, "failedTick not stamped from ctx.tick (30)");

// (9) list() filtering: available 0, active 0, completed [q_main,q_side], failed [q_fail].
const byStatus = async (status: string, tick: number) => (ok(await call("quest.list", { entity: HERO, status }, tick)).quests as { questId: string }[]);
assert((await byStatus("available", 31)).length === 0, "no available quests should remain");
assert((await byStatus("active", 31)).length === 0, "no active quests should remain");
const completed = (await byStatus("completed", 31)).map((q) => q.questId).sort();
assert(JSON.stringify(completed) === JSON.stringify(["q_main", "q_side"]), `completed filter wrong: ${completed}`);
const failed = (await byStatus("failed", 31)).map((q) => q.questId);
assert(JSON.stringify(failed) === JSON.stringify(["q_fail"]), `failed filter wrong: ${failed}`);

// Snapshot the authored quest state (embeds every stamped tick).
const authoredSnapshot = snapshot(recMgr, HERO);

// ── REPLAY-EQUIVALENCE: replay the recorded stream into a FRESH core ──────────────────
// Replay re-invokes each skill with its RECORDED tick, so a deterministic (ctx.tick)
// implementation rebuilds bit-identical state. A Date.now() tick would diverge here.
let replayCore: CoreSkills | undefined;
await replayCommands(recorder.commands, {
  makeWorld: () => makeWorld(ops),
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    replayCore = registerCoreSkills(r);
    return r;
  },
  tracer: new LiminaTracer("ses_p12_quest_replay"),
});
assert(replayCore !== undefined, "replay did not construct a core");
const replayMgr = replayCore.quest.questManager;
const replaySnapshot = snapshot(replayMgr, HERO);

// The command stream carried the skills (not nothing) and replay rebuilt the manager.
const tools = recorder.commands.filter((c): c is { kind: "skill"; tool: string } => c.kind === "skill").map((c) => c.tool);
assert(tools.includes("quest.define") && tools.includes("quest.complete"), "lifecycle skills were not recorded");

assert(replaySnapshot === authoredSnapshot,
  `replay recomputed DIFFERENT quest state than authoring (not bit-identical):\n  authored=${authoredSnapshot}\n  replay  =${replaySnapshot}`);
// Spot-check the ticks survived replay exactly (the Date.now regression teeth).
assert(replayMgr.getInstance(HERO, "q_main")?.acceptedTick === 10 && replayMgr.getInstance(HERO, "q_main")?.completedTick === 20,
  "replay lost the deterministic accept/complete ticks");
assert(replayMgr.getInstance(HERO, "q_fail")?.failedTick === 30, "replay lost the deterministic fail tick");

ops.op_log(
  `p12_quest OK: full lifecycle (define->offer->decline->accept->track->update->complete/force->fail) with correct state transitions + list() filtering; ` +
  `offered/accepted/completed/failed ticks come from ctx.tick (5/10/20|24/30), not wall-clock; ` +
  `rewards + follow-up quests surfaced on completion (auto + forced); ` +
  `replay of the recorded stream into a fresh core rebuilds BIT-IDENTICAL quest state (Date.now regression would fail this).`,
);
