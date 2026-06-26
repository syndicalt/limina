// Phase 7 — a held action does not outlive its authorization. A capability
// REVOKED between propose and grant is denied at apply time (fail-closed), even
// when the reviewer approves it; a restored capability grants normally.

import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { reviewProfileGate } from "../src/skills/approval.ts";
import { PolicyEngine } from "../src/policy/engine.ts";
import { resolveProfile } from "../src/skills/permissions.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p7_approval_revocation FAIL: " + msg);
}

const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const world: WorldContext = { ecs: createEcsWorld(), entities: new EntityTable(), tags: new Map(), scene, camera, ops };
ops.op_physics_create_world(0);

const tracer = new LiminaTracer("ses_p7rev");
const policy = new PolicyEngine();
const registry = new SkillRegistry(tracer, policy);
registerCoreSkills(registry);
registry.setApprovalGate(reviewProfileGate(new Set(["builder.review"])));

const agentBase = (t: number) => ({ agentId: "agt", sessionId: "ses_agent", permissions: resolveProfile("builder.review"), profile: "builder.review", tick: t, world });
const reviewerBase = (t: number) => ({ agentId: "rev", sessionId: "ses_review", permissions: resolveProfile("reviewer"), profile: "reviewer", tick: t, world });

const before = world.entities.ids().length;

// 1. Propose (held under policy), then REVOKE the capability, then grant -> DENIED.
const held = await registry.invoke("scene.createEntity", { position: [0, 1, 0] }, agentBase(1));
assert(!held.success && held.error?.code === "pending_approval", "action not held under policy: " + JSON.stringify(held.error));
const id1 = held.error!.message;

policy.revoke("ses_agent", "scene.createEntity");

const grantRevoked = await registry.invoke("approval.grant", { approvalId: id1 }, reviewerBase(2));
assert(grantRevoked.success, "approval.grant skill itself should not error");
assert(!(grantRevoked.result as { applied: boolean }).applied, "a revoked action was applied at grant time");
assert(world.entities.ids().length === before, "revoked action changed the world");
const deniedEv = tracer.trace("agt").find((e) => e.type === "skill.approval.denied" && /revoked/.test(JSON.stringify(e.payload)));
assert(deniedEv !== undefined, "no revoked-denial event recorded");

// 2. Control: restore the capability -> a fresh held action grants and applies.
policy.restore("ses_agent", "scene.createEntity");
const held2 = await registry.invoke("scene.createEntity", { position: [0, 2, 0] }, agentBase(3));
assert(!held2.success && held2.error?.code === "pending_approval", "second action not held");
const id2 = held2.error!.message;
const grantOk = await registry.invoke("approval.grant", { approvalId: id2 }, reviewerBase(4));
assert(grantOk.success && (grantOk.result as { applied: boolean }).applied, "non-revoked grant did not apply");
assert(world.entities.ids().length === before + 1, "non-revoked grant did not create the entity");

ops.op_log(`p7_approval_revocation OK: capability revoked between propose and grant is denied at apply (fail-closed, world unchanged); restored capability grants normally. entities ${before}->${world.entities.ids().length}`);
