// Phase 3 scheduler density/backpressure: many agents cannot create unbounded
// provider starts, queues, or registry invocations in one tick.

import { EntityTable, ops } from "../src/engine.ts";
import { AgentRegistry } from "../src/agents/agent.ts";
import { actionSystem, decisionSystem, perceptionSystem } from "../src/agents/systems.ts";
import { AgentScheduler } from "../src/agents/scheduler.ts";
import type { DecideRequest, LLMProvider } from "../src/agents/llm.ts";
import type { MCPRequest } from "../src/mcp/protocol.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";

function field(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) return (value as Record<string, unknown>)[key];
  return undefined;
}

class BurstProvider implements LLMProvider {
  readonly name = "burst";
  starts: string[] = [];
  constructor(private readonly callsPerDecision: number) {}
  decide(req: DecideRequest): Promise<{ toolCalls: MCPRequest[] }> {
    this.starts.push(req.perception.selfId);
    const toolCalls: MCPRequest[] = [];
    for (let i = 0; i < this.callsPerDecision; i++) toolCalls.push({ tool: "skills.list", input: {} });
    return Promise.resolve({ toolCalls });
  }
}

const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const agents = new AgentRegistry();
const world: WorldContext = { ecs: createEcsWorld(), entities: new EntityTable(), tags: new Map(), scene, camera, ops, agents };
const tracer = new LiminaTracer("ses_p3_scheduler");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);

for (let i = 0; i < 12; i++) {
  agents.add({
    id: `agt_${String(i).padStart(2, "0")}`,
    type: "builder",
    perceptionRadius: 50,
    decisionIntervalTicks: 1,
    profile: "builder.readWrite",
    sessionId: "ses_p3_scheduler",
    llm: { provider: "burst", model: "", systemPrompt: "emit many calls" },
  });
}

const scheduler = new AgentScheduler({
  maxDecisionStartsPerTick: 4,
  maxGlobalActionsPerTick: 5,
  defaultAgentBudget: {
    weight: 1,
    maxQueueDepth: 3,
    maxToolCallsPerDecision: 2,
    maxActionsPerTick: 1,
    decisionTimeoutMs: 500,
  },
});
const provider = new BurstProvider(5);

perceptionSystem(agents, world, tracer, 1);
decisionSystem(agents, registry, { burst: provider }, tracer, 1, scheduler);
await Promise.resolve();

if (provider.starts.join(",") !== "agt_00,agt_01,agt_02,agt_03") {
  throw new Error(`expected deterministic first admission set, got ${provider.starts.join(",")}`);
}
if (agents.all().some((agent) => agent.queue.length > 2)) throw new Error("decision tool-call cap was not applied");

perceptionSystem(agents, world, tracer, 2);
decisionSystem(agents, registry, { burst: provider }, tracer, 2, scheduler);
await Promise.resolve();
const expectedSecond = "agt_00,agt_01,agt_02,agt_03,agt_04,agt_05,agt_06,agt_07";
if (provider.starts.join(",") !== expectedSecond) {
  throw new Error(`expected stable round-robin second admission set, got ${provider.starts.join(",")}`);
}

perceptionSystem(agents, world, tracer, 3);
decisionSystem(agents, registry, { burst: provider }, tracer, 3, scheduler);
await Promise.resolve();
perceptionSystem(agents, world, tracer, 4);
decisionSystem(agents, registry, { burst: provider }, tracer, 4, scheduler);
await Promise.resolve();
const expectedFourth = expectedSecond + ",agt_08,agt_09,agt_10,agt_11,agt_00,agt_01,agt_02,agt_03";
if (provider.starts.join(",") !== expectedFourth) {
  throw new Error(`expected round-robin to cycle back through first agents, got ${provider.starts.join(",")}`);
}

await actionSystem(agents, registry, world, 5, scheduler);
const executions = tracer.trace("agt_00").concat(
  ...agents.all().filter((agent) => agent.id !== "agt_00").map((agent) => tracer.trace(agent.id)),
).filter((ev) => ev.type === "agent.action.executed");
if (executions.length !== 5) throw new Error(`expected global action cap of 5, got ${executions.length}`);
const perAgentExec = new Map<string, number>();
for (const ev of executions) perAgentExec.set(ev.actorId, (perAgentExec.get(ev.actorId) ?? 0) + 1);
if ([...perAgentExec.values()].some((n) => n > 1)) throw new Error("per-agent action cap was not applied");

const allTrace = agents.all().flatMap((agent) => tracer.trace(agent.id));
const scheduled = allTrace.filter((ev) => ev.type === "agent.scheduled");
const drops = allTrace.filter((ev) => ev.type === "agent.queue.dropped");
const backpressure = allTrace.filter((ev) => ev.type === "agent.backpressure.applied");
if (scheduled.length !== 16) throw new Error(`expected 16 scheduled decisions, got ${scheduled.length}`);
if (drops.length < 24) throw new Error(`expected queue drops from capped decisions, got ${drops.length}`);
if (backpressure.length === 0) throw new Error("missing backpressure events");

const dropPayload = drops.map((ev) => field(ev.payload, "reason"));
if (!dropPayload.includes("tool_call_cap")) throw new Error("missing tool_call_cap drop reason");
if (!dropPayload.includes("queue_full")) throw new Error("missing queue_full drop reason");

ops.op_log("P3 scheduler density OK: deterministic admission, queue drops, action caps, backpressure events");
