// Approval applies an intent whose policy usage was already committed at
// proposal. Granting must recheck revocation without consuming quota twice.

import { ops } from "../src/engine.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import { PolicyEngine } from "../src/policy/engine.ts";
import { reviewProfileGate } from "../src/skills/approval.ts";
import { resolveProfile } from "../src/skills/permissions.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p38_approval_accounting FAIL: " + message);
}

const policy = new PolicyEngine().setQuota({ cap: "scene.createEntity", limit: 1, windowMs: 100 });
const ctx = createHeadlessContext({ session: "ses_p38_approval", policy });
ctx.registry.setApprovalGate(reviewProfileGate(new Set(["builder.review"])));
ops.op_physics_create_world(0);

const proposer = (tick: number) => ({
  agentId: "agt_builder",
  sessionId: "ses_builder",
  permissions: resolveProfile("builder.review"),
  profile: "builder.review",
  tick,
  world: ctx.world,
});
const reviewer = (tick: number) => ({
  agentId: "human_reviewer",
  sessionId: "ses_reviewer",
  permissions: resolveProfile("reviewer"),
  profile: "reviewer",
  tick,
  world: ctx.world,
});

const before = ctx.world.entities.ids().length;
const held = await ctx.registry.invoke("scene.createEntity", { position: [1, 0, 0] }, proposer(1));
assert(!held.success && held.error?.code === "pending_approval", "quota-one action was not held");

const granted = await ctx.registry.invoke("approval.grant", { approvalId: held.error.message }, reviewer(2));
assert(granted.success && (granted.result as { applied?: boolean }).applied === true, "grant re-consumed quota and rejected the parked action");
assert(ctx.world.entities.ids().length === before + 1, "granted action did not apply exactly once");

const second = await ctx.registry.invoke("scene.createEntity", { position: [2, 0, 0] }, proposer(3));
assert(!second.success && second.error?.code === "forbidden", "quota-one policy allowed a second proposal");

const createDecisions = ctx.tracer.trace("agt_builder").filter((event) => {
  if (event.type !== "policy.decision") return false;
  const payload = event.payload as { cap?: string };
  return payload.cap === "scene.createEntity";
});
assert(createDecisions.length === 1, `expected one committed allow decision, got ${createDecisions.length}`);

ops.op_log("P38 approval accounting OK: proposal consumes quota once, grant applies and records without a second policy commit");
