// Approval queue capacity: a reviewed agent cannot grow the pending approval map
// without bound by proposing a new held mutation every tick.

import { ops } from "../src/engine.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import { reviewProfileGate } from "../src/skills/approval.ts";
import { resolveProfile } from "../src/skills/permissions.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p37_approval_capacity FAIL: " + message);
}

const ctx = createHeadlessContext({ session: "ses_p37" });
const registry = ctx.registry;
const world = ctx.world;
ops.op_physics_create_world(0);

registry.setApprovalGate(reviewProfileGate(new Set(["builder.review"])));
registry.setApprovalQueueLimit(2);

const base = (tick: number) => ({
  agentId: "agt_spam",
  sessionId: "ses_p37",
  permissions: resolveProfile("builder.review"),
  profile: "builder.review",
  tick,
  world,
});

const first = await registry.invoke("scene.createEntity", { position: [1, 0, 0] }, base(1));
const second = await registry.invoke("scene.createEntity", { position: [2, 0, 0] }, base(2));
const third = await registry.invoke("scene.createEntity", { position: [3, 0, 0] }, base(3));

assert(!first.success && first.error?.code === "pending_approval", "first proposal should be held");
assert(!second.success && second.error?.code === "pending_approval", "second proposal should be held");
assert(!third.success && third.error?.code === "resource_exhausted", "third proposal should fail closed when approval queue is full");
assert(registry.pendingApprovals().length === 2, "approval queue exceeded its configured capacity");
assert(world.entities.ids().length === 0, "capacity rejection must not apply any held mutation");

ops.op_log("p37_approval_capacity OK: pending approval queue is capped and fails closed at capacity");
