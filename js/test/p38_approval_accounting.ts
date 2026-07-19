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

const policy = new PolicyEngine().setQuota({ cap: "scene.createEntity", limit: 1, windowTicks: 100 });
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

// A proposal reservation cannot remain applicable forever. Expiry is observable,
// removes it from the queue, and a later reviewer cannot resurrect it.
{
  const expiring = createHeadlessContext({ session: "ses_p38_approval_expiry" });
  expiring.registry.setApprovalGate(reviewProfileGate(new Set(["builder.review"])));
  expiring.registry.setApprovalHoldTimeoutMs(1);
  const heldForExpiry = await expiring.registry.invoke("scene.createEntity", { position: [3, 0, 0] }, {
    ...proposer(10), sessionId: "ses_builder_expiry", world: expiring.world,
  });
  assert(!heldForExpiry.success && heldForExpiry.error?.code === "pending_approval", "expiry fixture was not held");
  await ops.op_sleep_ms(5);
  assert(expiring.registry.pendingApprovals().length === 0, "expired reservation remained listed");
  const late = await expiring.registry.resolveApproval(heldForExpiry.error.message, true, { agentId: "human_reviewer", applyTick: 11 });
  assert(!late.success && late.error?.code === "not_found", "expired reservation was applied late");
  const expiryEvents = expiring.tracer.trace("agt_builder").filter((event) =>
    event.type === "skill.approval.denied" && (event.payload as { reason?: string }).reason === "approval hold expired");
  assert(expiryEvents.length === 1, `expected one observable approval expiry, got ${expiryEvents.length}`);
}

ops.op_log("P38 approval accounting OK: proposal consumes quota once, grant applies without a second policy commit, and stale reservations expire closed");
