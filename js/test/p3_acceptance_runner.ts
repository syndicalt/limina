// Phase 3 acceptance foundation: deterministic scale runner that exercises
// many in-world Agent Players, concurrent bound MCP builder sessions, finite
// scheduler budgets, inspector snapshots, trace explanation, and real runtime
// metrics without claiming unresolved textured glTF or third-party-code sandboxing.

import { EntityTable, ops } from "../src/engine.ts";
import { AgentRegistry } from "../src/agents/agent.ts";
import { actionSystem, decisionSystem, perceptionSystem } from "../src/agents/systems.ts";
import { AgentScheduler } from "../src/agents/scheduler.ts";
import type { DecideRequest, LLMProvider } from "../src/agents/llm.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { Mcp, StdioMcpTransport } from "../src/mcp/mcp.ts";
import type { JsonRpcResponse, MCPRequest, MCPResponse } from "../src/mcp/protocol.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown): Record<string, unknown> {
  assert(typeof value === "object" && value !== null, "expected object");
  return value as Record<string, unknown>;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function ok(res: MCPResponse): unknown {
  if (!res.success) throw new Error("MCP call failed: " + JSON.stringify(res.error));
  return res.result;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function sumQueues(agents: AgentRegistry): number {
  return agents.all().reduce((sum, agent) => sum + agent.queue.length, 0);
}

class AcceptanceProvider implements LLMProvider {
  readonly name = "acceptance";
  readonly decisionLatenciesMs: number[] = [];
  private seq = 0;

  async decide(req: DecideRequest): Promise<{ toolCalls: MCPRequest[]; usage: { totalTokens: number } }> {
    const start = Date.now();
    const agentId = req.perception.selfId;
    const index = this.seq++;
    // Small deterministic host sleep keeps decision latency visible to the
    // acceptance metrics without introducing network or model dependencies.
    if (index % 4 === 0) await ops.op_sleep_ms(1);
    const toolCalls: MCPRequest[] = [
      { tool: "agent.getPerception", input: {} },
      {
        tool: "agent.emitEvent",
        input: {
          type: "acceptance.player_tick",
          payload: {
            agentId,
            tick: req.perception.tick,
            nearby: req.perception.nearby.length,
          },
        },
      },
      { tool: "scene.queryEntities", input: { near: req.perception.position ?? [0, 0, 0], radius: 12 } },
    ];
    this.decisionLatenciesMs.push(Date.now() - start);
    return { toolCalls, usage: { totalTokens: 32 + req.perception.nearby.length } };
  }
}

const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const agents = new AgentRegistry();
const world: WorldContext = {
  ecs: createEcsWorld(),
  entities: new EntityTable(),
  tags: new Map(),
  scene,
  camera,
  ops,
  agents,
  mode: "headless",
};
const tracer = new LiminaTracer("ses_p3_acceptance");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);
ops.op_physics_create_world(-9.81);

const mcp = new Mcp(registry, world);
const builderWrites: string[][] = [];
const builderSessions = Array.from({ length: 6 }, (_unused, index) => {
  const writes: string[] = [];
  builderWrites.push(writes);
  return new StdioMcpTransport(mcp, (line) => writes.push(line));
});

async function builderRequest(builderIndex: number, id: number, method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
  const writes = builderWrites[builderIndex];
  const before = writes.length;
  await builderSessions[builderIndex].handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  assert(writes.length === before + 1, `builder ${builderIndex} did not emit one response for ${method}`);
  return JSON.parse(writes[writes.length - 1]) as JsonRpcResponse;
}

const mcpCallBoundaryMs: number[] = [];
const externalEntities: string[] = [];
for (let i = 0; i < builderSessions.length; i++) {
  const init = await builderRequest(i, 1, "initialize", {
    agentId: `agt_builder_${i}`,
    sessionId: `ses_builder_${i}`,
    profile: "builder.readWrite",
  });
  assert(init.result !== undefined, `builder ${i} initialize failed`);
}

for (let round = 0; round < 4; round++) {
  await Promise.all(builderSessions.map(async (_transport, i) => {
    const start = Date.now();
    const res = await builderRequest(i, 100 + round, "tools/call", {
      name: "scene.createEntity",
      arguments: {
        shape: round % 2 === 0 ? "box" : "sphere",
        position: [i * 2 - 5, 1 + round * 0.15, round * 2 - 4],
        dynamic: round % 2 === 1,
        collider: round % 2 === 1 ? "sphere" : "box",
        color: 0x4455aa + i * 0x1111,
      },
      context: { agentId: "agt_spoofed_builder", sessionId: "ses_spoofed" },
    });
    mcpCallBoundaryMs.push(Date.now() - start);
    const result = record(res.result);
    assert(result.success === true, `builder ${i} scene.createEntity failed`);
    const entity = field(record(result.result), "entity");
    assert(typeof entity === "string", "builder entity id missing");
    externalEntities.push(entity);
  }));
}

assert(tracer.trace("agt_spoofed_builder").length === 0, "MCP context spoofing reached tracer");
assert(externalEntities.length === 24, `expected 24 external builder entities, got ${externalEntities.length}`);

const setupCtx = {
  agentId: "agt_acceptance_setup",
  sessionId: "ses_p3_acceptance",
  permissions: resolveProfile("builder.readWrite"),
  tick: 0,
  world,
};
for (let i = 0; i < 48; i++) {
  const result = record(ok(await registry.invoke("scene.createEntity", {
    shape: "sphere",
    position: [(i % 12) - 6, 1.5, Math.floor(i / 12) * 2 - 4],
    dynamic: true,
    collider: "sphere",
    size: 0.6,
    friction: 0.4,
    restitution: 0.1,
  }, setupCtx)));
  const entity = field(result, "entity");
  assert(typeof entity === "string", "player entity creation failed");
  agents.add({
    id: `agt_player_${String(i).padStart(2, "0")}`,
    type: "player",
    entityId: entity,
    perceptionRadius: 16,
    decisionIntervalTicks: 1,
    profile: "player.limited",
    sessionId: "ses_p3_acceptance",
    llm: { provider: "acceptance", model: "scripted", systemPrompt: "emit bounded acceptance actions" },
  });
}

const provider = new AcceptanceProvider();
const scheduler = new AgentScheduler({
  maxDecisionStartsPerTick: 12,
  maxGlobalActionsPerTick: 24,
  defaultAgentBudget: {
    weight: 1,
    maxQueueDepth: 4,
    maxToolCallsPerDecision: 2,
    maxActionsPerTick: 1,
    decisionTimeoutMs: 100,
  },
});

const frameStepMs: number[] = [];
const queueDepthSamples: number[] = [];
for (let tick = 1; tick <= 18; tick++) {
  const start = Date.now();
  perceptionSystem(agents, world, tracer, tick);
  decisionSystem(agents, registry, { acceptance: provider }, tracer, tick, scheduler);
  await ops.op_sleep_ms(2);
  queueDepthSamples.push(sumQueues(agents));
  await actionSystem(agents, registry, world, tick, scheduler);
  queueDepthSamples.push(sumQueues(agents));
  ops.op_physics_step();
  frameStepMs.push(Date.now() - start);
}

const snapshotCtx = {
  agentId: "agt_acceptance_inspector",
  sessionId: "ses_p3_acceptance",
  permissions: resolveProfile("system.readonly"),
  tick: 100,
  world,
};
const snapshot = record(ok(await registry.invoke("inspector.snapshot", { limit: 20 }, snapshotCtx)));
assert(record(snapshot.page).totalEntities === 72, "inspector did not see all acceptance entities");
assert((snapshot.agents as unknown[]).length === 48, "inspector did not see all acceptance agents");

const scheduledTail = record(ok(await registry.invoke("trace.tail", { type: "agent.scheduled", limit: 1000 }, snapshotCtx)));
const scheduledEvents = scheduledTail.events as unknown[];
assert(scheduledEvents.length >= 48, "expected many scheduled decisions in trace.tail");
const actionTail = record(ok(await registry.invoke("trace.tail", { type: "agent.action.executed", limit: 1000 }, snapshotCtx)));
const actionEvents = actionTail.events as unknown[];
assert(actionEvents.length > 0, "expected executed actions in trace.tail");
const skillTail = record(ok(await registry.invoke("trace.tail", { type: "skill.executed", limit: 1000 }, snapshotCtx)));
const skillEvents = (skillTail.events as unknown[]).filter((event) => {
  const actorId = record(event).actorId;
  return typeof actorId === "string" && actorId.startsWith("agt_player_");
});
assert(skillEvents.length > 0, "expected player skill execution events in trace.tail");
const explainTarget = record(skillEvents[skillEvents.length - 1]).id;
assert(typeof explainTarget === "string", "trace target id missing");
const explained = record(ok(await registry.invoke("trace.explainEvent", { eventId: explainTarget }, snapshotCtx)));
const explainedParents = explained.parents as unknown[];
assert(explainedParents.some((parent) => record(parent).type === "agent.decision.made"), "trace explanation missed decision parent");

const allAgentEvents = agents.all().flatMap((agent) => tracer.trace(agent.id));
const backpressure = allAgentEvents.filter((event) => event.type === "agent.backpressure.applied").length;
const queueDrops = allAgentEvents.filter((event) => event.type === "agent.queue.dropped").length;
const metrics = {
  builders: builderSessions.length,
  builderEntities: externalEntities.length,
  players: agents.all().length,
  totalEntities: record(snapshot.page).totalEntities,
  finiteSchedulerBudget: {
    maxDecisionStartsPerTick: 12,
    maxGlobalActionsPerTick: 24,
    maxQueueDepth: 4,
    maxToolCallsPerDecision: 2,
    maxActionsPerTick: 1,
    decisionTimeoutMs: 100,
  },
  p95: {
    frameStepMs: percentile(frameStepMs, 95),
    decisionMs: percentile(provider.decisionLatenciesMs, 95),
    queueDepth: percentile(queueDepthSamples, 95),
    mcpCallBoundaryMs: percentile(mcpCallBoundaryMs, 95),
  },
  samples: {
    frames: frameStepMs.length,
    decisions: provider.decisionLatenciesMs.length,
    queueDepths: queueDepthSamples.length,
    mcpCalls: mcpCallBoundaryMs.length,
  },
  trace: {
    scheduled: scheduledEvents.length,
    actions: actionEvents.length,
    playerSkillExecutions: skillEvents.length,
    backpressure,
    queueDrops,
    explainedEvent: explainTarget,
  },
  honestClaims: {
    stdioEquivalent: "StdioMcpTransport JSON-RPC path exercised in-process; host --mcp-stdio smoke remains separate.",
    texturedGltf: "sandboxed/data-asset textured glTF is covered by p3_textured_gltf tests; network glTF is not claimed.",
    untrustedCodeIsolation: "not claimed; arbitrary third-party code is not allowed in the privileged runtime isolate.",
  },
};

assert(backpressure > 0, "finite budgets did not produce observable backpressure");
assert(queueDrops > 0, "finite queue/tool caps did not produce observable drops");
assert(metrics.p95.frameStepMs >= 0 && metrics.p95.decisionMs >= 0 && metrics.p95.queueDepth >= 0, "invalid p95 metrics");

ops.op_log("P3 acceptance metrics " + JSON.stringify(metrics));
ops.op_log("P3 acceptance OK: many players, bound MCP builders, finite budgets, inspector, trace explain, and p95 metrics");
