// A skill's advertised output schema is a runtime contract, including for
// dynamically registered and hot-reloaded implementations.

import { z } from "../build/zod.bundle.mjs";
import { ops } from "../src/engine.ts";
import { createHeadlessContext } from "../src/game/index.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p38_skill_output_contract FAIL: " + message);
}

const ctx = createHeadlessContext({ session: "ses_p38_contract" });
let afterCalls = 0;
ctx.registry.register({
  name: "test.invalidOutput",
  version: "1.0.0",
  description: "Deliberately violates its output contract.",
  category: "system",
  permissions: [],
  effect: "read",
  input: z.object({}),
  output: z.object({ ok: z.literal(true) }),
  hooks: {
    after: () => { afterCalls++; },
  },
  handler: () => ({ ok: false }) as never,
});

const response = await ctx.registry.invoke("test.invalidOutput", {}, ctx.base);
assert(!response.success && response.error?.code === "contract_error", "invalid output did not return contract_error");
assert(afterCalls === 0, "after hook observed output that failed validation");

const events = ctx.tracer.trace(ctx.base.agentId);
assert(events.filter((event) => event.type === "skill.contract.violation").length === 1, "contract violation was not traced exactly once");
assert(!events.some((event) => event.type === "skill.executed" && (event.payload as { skill?: string }).skill === "test.invalidOutput"),
  "invalid output emitted skill.executed");

ops.op_log("P38 skill output contract OK: invalid handler output fails distinctly before after hooks and success tracing");
