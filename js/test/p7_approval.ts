// Phase 7 — human-in-the-loop approval gate. A mutating agent action (scene.write)
// run under review is HELD (no world change) until a reviewer grants it; a denied
// action is dropped; reads are never gated; only a reviewer (approval.review) can
// resolve; the full causal chain (pending -> granted -> executed) stays intact;
// and with the gate off, behaviour is exactly as before.

import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { reviewProfileGate } from "../src/skills/approval.ts";
import { resolveProfile } from "../src/skills/permissions.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p7_approval FAIL: " + msg);
}

const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const world: WorldContext = { ecs: createEcsWorld(), entities: new EntityTable(), tags: new Map(), scene, camera, ops };

ops.op_physics_create_world(0);
const tracer = new LiminaTracer("ses_p7");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);

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

// 10. Gate OFF -> a mutating action applies directly (existing behaviour restored).
registry.clearApprovalGate();
const direct = await registry.invoke("scene.createEntity", { position: [3, 0, 0] }, agentBase(9));
assert(direct.success, "ungated mutating action did not apply: " + JSON.stringify(direct.error));

ops.op_log(`p7_approval OK: mutating action held (no world change) -> reviewer-only grant applies it (pending->granted->executed linked); deny drops it; reads ungated; re-grant no-op; gate-off applies directly. entities ${before}->${world.entities.ids().length}`);
