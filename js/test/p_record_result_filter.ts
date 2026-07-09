import { z } from "../build/zod.bundle.mjs";
import { ops } from "../src/engine.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_record_result_filter: ${message}`);
}

const registry = new SkillRegistry(new LiminaTracer("p_record_result_filter"));
const recorder = new WorldRecorder("p_record_result_filter");
recorder.attach(registry);
let mutations = 0;
registry.register({
  name: "test.idempotentCommit",
  version: "1.0.0",
  description: "record only newly applied commits",
  category: "system",
  permissions: [],
  input: z.object({ transactionId: z.string() }).strict(),
  output: z.object({ committed: z.boolean(), receipt: z.string() }).strict(),
  shouldRecordResult: (result) => result.committed,
  handler: ({ transactionId }) => {
    const committed = transactionId === "new";
    if (committed) mutations++;
    return { committed, receipt: `receipt:${transactionId}` };
  },
});

const world = { entities: { ids: () => [] }, tags: new Map(), scene: {}, camera: {}, ops } as unknown as WorldContext;
const base = { agentId: "agt_test", sessionId: "ses_test", permissions: new Set<string>(), tick: 0, world };
const first = await registry.invoke("test.idempotentCommit", { transactionId: "new" }, base);
const retry = await registry.invoke("test.idempotentCommit", { transactionId: "retry" }, base);
assert(first.success && retry.success, "successful new commit or retry failed");
assert(mutations === 1, "test handler did not isolate the new mutation");
assert(recorder.commandCount === 1 && recorder.flushableCount() === 1, "idempotent no-op retry remained in the world log");
const only = recorder.commandAt(0);
assert(only?.kind === "skill" && only.input !== undefined, "new commit was not retained");

ops.op_log("p_record_result_filter OK: successful idempotent no-op retries do not duplicate authoritative commands");
