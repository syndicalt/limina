// Phase 7 — human-in-the-loop approval gate. A mutating agent action (scene.write)
// run under review is HELD (no world change) until a reviewer grants it; a denied
// action is dropped; reads are never gated; only a reviewer (approval.review) can
// resolve; the full causal chain (pending -> granted -> executed) stays intact;
// and with the gate off, behaviour is exactly as before.

import { ops } from "../src/engine.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import { reviewProfileGate } from "../src/skills/approval.ts";
import { resolveProfile } from "../src/skills/permissions.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p7_approval FAIL: " + msg);
}

const ctx = createHeadlessContext({ session: "ses_p7" });
const registry = ctx.registry;
const world = ctx.world;
const tracer = ctx.registry.tracer as LiminaTracer;

ops.op_physics_create_world(0);

// Hold the MUTATING world-edits of agents running the `builder.review` profile.
registry.setApprovalGate(reviewProfileGate(new Set(["builder.review"])));

const agentBase = (tick: number) => ({
  agentId: "agt_review", sessionId: "ses_p7",
  permissions: resolveProfile("builder.review"), profile: "builder.review", tick, world,
});
const reviewerBase = (tick: number) => ({
  agentId: "human_reviewer", sessionId: "ses_p7",
  permissions: resolveProfile("reviewer"), profile: "reviewer", tick, world,
});

const before = world.entities.ids().length;

// 1. A mutating agent action is HELD pending — and does NOT change the world.
const held = await registry.invoke("scene.createEntity", { position: [1, 0, 0] }, agentBase(1));
assert(!held.success && held.error?.code === "pending_approval", "mutating action was not held: " + JSON.stringify(held.error));
const approvalId = held.error!.message;
assert(world.entities.ids().length === before, "held action changed the world before approval");

// 2. The pending event is on the agent's trace.
const pendingEvents = tracer.trace("agt_review").filter((e) => e.type === "skill.approval.pending");
assert(pendingEvents.length === 1 && pendingEvents[0].id === approvalId, "expected one skill.approval.pending matching the approvalId");

// 3. A reviewer can list it.
const listed = await registry.invoke("approval.list", {}, reviewerBase(2));
assert(listed.success, "approval.list failed for reviewer");
const pending = (listed.result as { pending: { approvalId: string; skill: string }[] }).pending;
assert(pending.length === 1 && pending[0].approvalId === approvalId && pending[0].skill === "scene.createEntity", "approval.list did not return the held action");

// 4. A non-reviewer agent CANNOT grant (missing approval.review) — world unchanged.
const cannotGrant = await registry.invoke("approval.grant", { approvalId }, agentBase(3));
assert(!cannotGrant.success && cannotGrant.error?.code === "forbidden", "an agent without approval.review was able to grant");
assert(world.entities.ids().length === before, "failed grant attempt changed the world");

// 5. The reviewer GRANTS -> the held action applies now (entity created).
const granted = await registry.invoke("approval.grant", { approvalId }, reviewerBase(4));
assert(granted.success && (granted.result as { applied: boolean }).applied, "reviewer grant did not apply: " + JSON.stringify(granted));
assert(world.entities.ids().length === before + 1, "granted action did not create the entity");

// 6. Causal chain: pending -> granted -> executed, present and linked.
const evs = tracer.trace("agt_review");
const grantedEv = evs.find((e) => e.type === "skill.approval.granted");
const executedEv = evs.find((e) => e.type === "skill.executed" && (e.payload as { skill?: string }).skill === "scene.createEntity");
assert(grantedEv !== undefined && grantedEv.causedBy.includes(approvalId), "granted not linked to pending");
assert(executedEv !== undefined && executedEv.causedBy.includes(grantedEv.id), "executed not linked to granted");

// 6b. APPLY-TICK provenance (FIX 3): the action was PROPOSED at tick 1 and GRANTED at
// tick 4. The propose-time `skill.approval.pending` keeps the propose tick; the
// apply-time `skill.approval.granted` + `skill.executed` carry the APPLY tick (4).
const pendingTick = (pendingEvents[0].payload as { tick?: number }).tick;
const grantedTick = (grantedEv.payload as { tick?: number }).tick;
const executedTick = (executedEv.payload as { tick?: number }).tick;
assert(pendingTick === 1, `skill.approval.pending must keep the PROPOSE tick (1), got ${pendingTick}`);
assert(grantedTick === 4, `skill.approval.granted must carry the APPLY tick (4), got ${grantedTick}`);
assert(executedTick === 4, `granted action's skill.executed must carry the APPLY tick (4), not the propose tick, got ${executedTick}`);

// 7. Re-granting a resolved approval is an honest no-op (not found, nothing applied).
const regrant = await registry.invoke("approval.grant", { approvalId }, reviewerBase(5));
assert(regrant.success, "approval.grant skill itself should not error");
assert(!(regrant.result as { resolved: boolean }).resolved && !(regrant.result as { applied: boolean }).applied, "re-granting a resolved approval was not a no-op");
assert(world.entities.ids().length === before + 1, "re-grant created a duplicate entity");

// 8. DENY path — a second held action is dropped, never applied.
const held2 = await registry.invoke("scene.createEntity", { position: [2, 0, 0] }, agentBase(6));
assert(!held2.success && held2.error?.code === "pending_approval", "second mutating action not held");
const approvalId2 = held2.error!.message;
const afterHeld2 = world.entities.ids().length;
const denied = await registry.invoke("approval.deny", { approvalId: approvalId2, reason: "test" }, reviewerBase(7));
assert(denied.success && (denied.result as { resolved: boolean }).resolved, "deny did not resolve");
assert(world.entities.ids().length === afterHeld2, "denied action changed the world");
assert(tracer.trace("agt_review").some((e) => e.type === "skill.approval.denied"), "no skill.approval.denied event");

// 9. READS are never gated.
const read = await registry.invoke("scene.queryEntities", {}, agentBase(8));
assert(read.success, "a read (scene.queryEntities) was incorrectly gated");

// 9b. APPLY-TICK FLOOR (FINDING 2): an MCP reviewer that never advanced a sim tick
// passes tick 0. Granting at tick 0 an action PROPOSED at tick 5 must NOT stamp it
// "applied at 0" (applied-before-proposed); the apply tick is FLOORED to the propose
// tick. (On revert to `applyTick ?? base.tick`, tick 0 would survive and these fail.)
const held3 = await registry.invoke("scene.createEntity", { position: [4, 0, 0] }, agentBase(5));
assert(!held3.success && held3.error?.code === "pending_approval", "third mutating action not held");
const approvalId3 = held3.error!.message;
const granted3 = await registry.invoke("approval.grant", { approvalId: approvalId3 }, reviewerBase(0));
assert(granted3.success && (granted3.result as { applied: boolean }).applied, "grant at reviewer tick 0 did not apply");
const evs3 = tracer.trace("agt_review");
const granted3Evs = evs3.filter((e) => e.type === "skill.approval.granted");
const executed3Evs = evs3.filter((e) => e.type === "skill.executed" && (e.payload as { skill?: string }).skill === "scene.createEntity");
const granted3Tick = (granted3Evs[granted3Evs.length - 1].payload as { tick: number }).tick;
const executed3Tick = (executed3Evs[executed3Evs.length - 1].payload as { tick: number }).tick;
assert(granted3Tick === 5, `skill.approval.granted at reviewer tick 0 must FLOOR to the propose tick 5 (never 0), got ${granted3Tick}`);
assert(executed3Tick === 5, `granted action's skill.executed at reviewer tick 0 must FLOOR to the propose tick 5 (never 0), got ${executed3Tick}`);

// 10. Gate OFF -> a mutating action applies directly (existing behaviour restored).
registry.clearApprovalGate();
const direct = await registry.invoke("scene.createEntity", { position: [3, 0, 0] }, agentBase(9));
assert(direct.success, "ungated mutating action did not apply: " + JSON.stringify(direct.error));

ops.op_log(`p7_approval OK: mutating action held (no world change) -> reviewer-only grant applies it (pending->granted->executed linked); deny drops it; reads ungated; re-grant no-op; gate-off applies directly. entities ${before}->${world.entities.ids().length}`);
