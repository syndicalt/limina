// P112 — stdio MCP is an authority boundary, not a client-selected profile.

import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { Mcp, StdioMcpTransport } from "../src/mcp/mcp.ts";
import type { JsonRpcResponse } from "../src/mcp/protocol.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { PolicyEngine } from "../src/policy/engine.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p112_mcp_stdio_admission FAIL: ${message}`);
}

const world: WorldContext = {
  ecs: createEcsWorld(), entities: new EntityTable(), tags: new Map(),
  scene: { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null },
  camera: { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} },
  ops, mode: "headless",
};
ops.op_physics_create_world(0);
const tracer = new LiminaTracer("ses_p112");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);
const mcp = new Mcp(registry, world);

function transport(policy?: PolicyEngine, allowedProfiles?: ReadonlySet<string>, specProfile?: string) {
  const writes: JsonRpcResponse[] = [];
  const instance = new StdioMcpTransport(mcp, (line) => writes.push(JSON.parse(line) as JsonRpcResponse), {
    ...(policy === undefined ? {} : { policy }),
    ...(allowedProfiles === undefined ? {} : { allowedProfiles }),
    ...(specProfile === undefined ? {} : { specProfile }),
  });
  const request = async (id: number, method: string, params: unknown = {}) => {
    await instance.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return writes.at(-1)!;
  };
  return { instance, request };
}

// Secure defaults: spec clients receive readonly, and native clients cannot
// self-assert system.admin or builder authority.
{
  const t = transport();
  const denied = await t.request(1, "initialize", { agentId: "evil", sessionId: "evil", profile: "system.admin" });
  assert(denied.error?.code === -32001, "default transport accepted a self-asserted admin profile");
  const spec = await t.request(2, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "ordinary-client" } });
  assert(spec.result !== undefined, "spec initialization failed under readonly default");
  const listed = await t.request(3, "tools/list");
  const tools = (listed.result as { tools: Array<{ name: string }> }).tools;
  assert(!tools.some((tool) => tool.name === "scene.createEntity"), "readonly spec session advertised a write skill");
  const repeated = await t.request(4, "initialize", { agentId: "replacement", sessionId: "replacement", profile: "system.readonly" });
  assert(repeated.error?.code === -32600, "reinitialize replaced the bound identity");
  t.instance.close();
}

// Admission is policy-audited and released exactly once on shutdown/close.
{
  const policy = new PolicyEngine({ maxSessions: 1 });
  const allowed = new Set(["builder.readWrite"]);
  const first = transport(policy, allowed, "builder.readWrite");
  const second = transport(policy, allowed, "builder.readWrite");
  const init = { agentId: "builder", sessionId: "ses_builder", profile: "builder.readWrite" };
  assert((await first.request(10, "initialize", init)).result !== undefined, "first admitted session failed");
  const full = await second.request(11, "initialize", { ...init, agentId: "other", sessionId: "ses_other" });
  assert(full.error?.code === -32001, "session quota did not deny a second stdio client");
  assert((await first.request(12, "shutdown")).result !== undefined, "shutdown failed");
  assert((await second.request(13, "initialize", { ...init, agentId: "other", sessionId: "ses_other" })).result !== undefined,
    "shutdown did not release policy admission");
  second.instance.close();
  second.instance.close();
  const third = transport(policy, allowed, "builder.readWrite");
  assert((await third.request(14, "initialize", { ...init, agentId: "third", sessionId: "ses_third" })).result !== undefined,
    "idempotent close leaked or double-retained admission");
  third.instance.close();

  const decisions = ["builder", "other", "third"].flatMap((agent) => tracer.trace(agent))
    .filter((event) => event.type === "policy.decision" || event.type === "policy.denied");
  assert(decisions.some((event) => (event.payload as { rule?: string }).rule === "session.admitted"), "session admission allow was not audited");
  assert(decisions.some((event) => (event.payload as { rule?: string }).rule === "quota.exceeded"), "session admission denial was not audited");
}

ops.op_log("P112 MCP stdio admission OK: readonly default, one-shot identity, policy audit, and exact admission release");
