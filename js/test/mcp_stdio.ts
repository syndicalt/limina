// Phase 3 MCP stdio transport — exercises JSON-RPC framing, initialize-bound
// session/profile, request ids, error mapping, and external attribution rules.

import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { Mcp, StdioMcpTransport } from "../src/mcp/mcp.ts";
import type { JsonRpcResponse } from "../src/mcp/protocol.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";

const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const world: WorldContext = { ecs: createEcsWorld(), entities: new EntityTable(), tags: new Map(), scene, camera, ops };

ops.op_physics_create_world(0);

const tracer = new LiminaTracer("ses_stdio_bound");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);

const mcp = new Mcp(registry, world);
const writes: string[] = [];
const transport = new StdioMcpTransport(mcp, (line) => writes.push(line));

await transport.handleLine(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { agentId: "agt_stdio_bound", sessionId: "ses_stdio_bound", profile: "builder.readWrite" },
}));
await transport.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
await transport.handleLine(JSON.stringify({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "scene.createEntity",
    arguments: { position: [1, 2, 3] },
    context: { agentId: "agt_spoof", sessionId: "ses_spoof" },
  },
}));
await transport.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "missing/method", params: {} }));
await transport.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "shutdown", params: {} }));
await transport.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "scene.queryEntities", arguments: {} } }));
await transport.handleLine("{bad json");

const responses = writes.map((line) => JSON.parse(line) as JsonRpcResponse);
const byId = new Map(responses.filter((r) => "id" in r).map((r) => [r.id, r]));

if (byId.get(1)?.result === undefined) throw new Error("initialize did not return a result");
const tools = byId.get(2)?.result;
if (typeof tools !== "object" || tools === null || !Array.isArray((tools as { tools?: unknown }).tools)) {
  throw new Error("tools/list did not return tools array");
}
const call = byId.get(3);
if (call?.result === undefined || (call.result as { success?: unknown }).success !== true) {
  throw new Error("tools/call did not return successful MCP response");
}
const unknown = byId.get(4);
if (unknown?.error?.code !== -32601) throw new Error("unknown method did not map to JSON-RPC method-not-found");
if ((byId.get(5)?.result as { ok?: unknown } | undefined)?.ok !== true) throw new Error("shutdown did not return ok");
if (byId.get(6)?.error?.code !== -32000) throw new Error("post-shutdown call did not fail as uninitialized");
const parseError = responses.find((r) => r.id === null);
if (parseError?.error?.code !== -32700) throw new Error("bad JSON did not map to parse error");

const boundTrace = tracer.trace("agt_stdio_bound");
if (!boundTrace.some((e) => e.type === "skill.executed" && e.threadId === "ses_stdio_bound")) {
  throw new Error("bound session did not execute the tool");
}
if (tracer.trace("agt_spoof").length !== 0) {
  throw new Error("external context spoofing was accepted");
}

ops.op_log("MCP stdio OK: JSON-RPC framing, bound session attribution, and error mapping");
