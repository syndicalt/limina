// Regression coverage for adversarial sandbox audit findings:
// - untrusted top-level load code gets a finite deadline and tears down on failure
// - object-ish eval results are serialized as JSON values, not type names
// - non-finite memory budgets do not disable the sandbox memory limit
import { ops } from "../src/engine.ts";
import { createHeadlessContext } from "../src/game/context.ts";
import { AgentRegistry } from "../src/agents/agent.ts";
import { SandboxedSkillHost } from "../src/sandbox/host.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error("FAIL: " + msg);
}

function assertThrows(fn: () => void, msg: string): Error {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  throw new Error("FAIL: " + msg);
}

const ctx = createHeadlessContext({ session: "ses_sandbox_regressions", agentId: "engine", agents: new AgentRegistry() });
const host = new SandboxedSkillHost(ctx.registry, ctx.tracer);

const startLive = host.liveCount();
const loadErr = assertThrows(
  () =>
    host.create({
      agentId: "agt_load_spin",
      sessionId: "ses_load_spin",
      profile: "system.readonly",
      code: "while (true) {}",
    }),
  "top-level load loop must be interrupted instead of hanging the host",
);
assert((loadErr.message).toLowerCase().includes("interrupt"), "load timeout should surface interrupt, got: " + loadErr.message);
assert(!host.has("agt_load_spin"), "failed load must remove the host entry");
assert(host.liveCount() === startLive, "failed load must free the QuickJS handle, live=" + host.liveCount() + " start=" + startLive);

host.create({
  agentId: "agt_json_result",
  sessionId: "ses_json_result",
  profile: "system.readonly",
  code: "globalThis.decide = function(){ return { nested: [1, true, null], label: 'ok' }; };",
});
const objectResult = host.produceCalls("agt_json_result", null);
assert(objectResult.ok, "object-returning decide should evaluate");
const parsedObject: unknown = JSON.parse(objectResult.value ?? "");
assert(
  parsedObject !== null &&
    typeof parsedObject === "object" &&
    Array.isArray((parsedObject as { nested?: unknown }).nested) &&
    (parsedObject as { label?: unknown }).label === "ok",
  "object-ish result must be returned as JSON, got: " + String(objectResult.value),
);

host.create(
  {
    agentId: "agt_nan_mem",
    sessionId: "ses_nan_mem",
    profile: "system.readonly",
    code: "globalThis.decide = function(){ return 'noop'; };",
  },
  { memLimitBytes: Number.NaN },
);
const bomb = host.evalRaw("agt_nan_mem", "var a = []; for (;;) { a.push(new Array(100000).fill(7)); }", { deadlineMs: 1000 });
assert(!bomb.ok, "NaN memory budget must not disable containment");
assert((bomb.error ?? "").toLowerCase().includes("memory"), "NaN memory budget should fall back to memory cap, got: " + String(bomb.error));
assert(host.evalRaw("agt_nan_mem", "21 * 2").value === "42", "sandbox must remain alive after contained NaN-budget OOM");

assert(host.destroy("agt_json_result"), "destroy json sandbox");
assert(host.destroy("agt_nan_mem"), "destroy NaN memory sandbox");
assert(host.liveCount() === startLive, "all regression sandboxes must be freed, live=" + host.liveCount() + " start=" + startLive);

ops.op_log("p4_sandbox_audit_regressions OK: load timeout/cleanup, object JSON result, and NaN memory budget containment");
