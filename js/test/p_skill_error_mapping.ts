import { z } from "../build/zod.bundle.mjs";
import { ops } from "../src/engine.ts";
import { mcpErrorToJsonRpc } from "../src/mcp/protocol.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillInvocationError, SkillRegistry, type WorldContext } from "../src/skills/registry.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_skill_error_mapping: ${message}`);
}

const registry = new SkillRegistry(new LiminaTracer("p_skill_error_mapping"));
const input = z.object({}).strict();
const output = z.object({ ok: z.literal(true) }).strict();
registry.register({
  name: "test.conflict",
  version: "1.0.0",
  description: "exercise an expected domain conflict",
  category: "system",
  permissions: [],
  input,
  output,
  handler: () => { throw new SkillInvocationError("conflict", "stale project head"); },
});
registry.register({
  name: "test.unexpected",
  version: "1.0.0",
  description: "exercise an unexpected handler failure",
  category: "system",
  permissions: [],
  input,
  output,
  handler: () => { throw new Error("database invariant failed"); },
});

const world = { entities: { ids: () => [] }, tags: new Map(), scene: {}, camera: {}, ops } as unknown as WorldContext;
const base = { agentId: "agt_test", sessionId: "ses_test", permissions: new Set<string>(), tick: 0, world };
const conflict = await registry.invoke("test.conflict", {}, base);
assert(!conflict.success && conflict.error?.code === "conflict", "expected conflict was collapsed into an internal error");
assert(mcpErrorToJsonRpc(conflict.error.code) === -32009, "conflict JSON-RPC code changed");

const unexpected = await registry.invoke("test.unexpected", {}, base);
assert(!unexpected.success && unexpected.error?.code === "handler_error", "unexpected exception escaped the internal-error boundary");
assert(mcpErrorToJsonRpc(unexpected.error.code) === -32603, "unexpected exception did not map to JSON-RPC internal error");

ops.op_log("p_skill_error_mapping OK: expected domain conflicts remain actionable; unexpected faults stay internal");
