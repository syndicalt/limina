// Phase 3 scheduler timeout generation: provider decisions remain off-loop, and
// late results from timed-out generations must not enqueue actions.

import { ops } from "../src/engine.ts";
import { AgentRegistry } from "../src/agents/agent.ts";
import { actionSystem, decisionSystem, perceptionSystem } from "../src/agents/systems.ts";
import { AgentScheduler } from "../src/agents/scheduler.ts";
import type { DecideRequest, LLMProvider } from "../src/agents/llm.ts";
import type { MCPRequest } from "../src/mcp/protocol.ts";
import { createHeadlessContext } from "../src/game/context.ts";

class SlowProvider implements LLMProvider {
  readonly name = "slow";
  starts = 0;
  decide(_req: DecideRequest): Promise<{ toolCalls: MCPRequest[] }> {
    this.starts++;
    return ops.op_sleep_ms(60).then(() => ({ toolCalls: [{ tool: "skills.list", input: {} }] }));
  }
}

const agents = new AgentRegistry();
const ctx = createHeadlessContext({ session: "ses_p3_scheduler_timeout", agents });
const registry = ctx.registry;
const world = ctx.world;
const tracer = ctx.tracer;
const agent = agents.add({
  id: "agt_timeout",
  type: "builder",
  perceptionRadius: 50,
  decisionIntervalTicks: 1,
  profile: "builder.readWrite",
  sessionId: "ses_p3_scheduler_timeout",
  llm: { provider: "slow", model: "", systemPrompt: "late result" },
});
const scheduler = new AgentScheduler({
  maxDecisionStartsPerTick: 1,
  maxGlobalActionsPerTick: 1,
  defaultAgentBudget: {
    maxQueueDepth: 4,
    maxToolCallsPerDecision: 4,
    maxActionsPerTick: 1,
    decisionTimeoutMs: 10,
    weight: 1,
  },
});
const provider = new SlowProvider();

perceptionSystem(agents, world, tracer, 1);
decisionSystem(agents, registry, { slow: provider }, tracer, 1, scheduler);
await ops.op_sleep_ms(25);
// Timeouts are detected by a synchronous per-tick sweep (no host-blocking
// watchdog timer); drive it the way decisionSystem does each tick.
scheduler.sweepDecisionTimeouts(agents.all(), 2, tracer);

const exceeded = tracer.trace("agt_timeout").filter((ev) => ev.type === "agent.budget.exceeded");
if (exceeded.length !== 1) throw new Error(`expected one timeout budget event, got ${exceeded.length}`);
if (agent.inFlight) throw new Error("timed-out generation left the agent in flight");

await ops.op_sleep_ms(60);
if (agent.queue.length !== 0) throw new Error(`late timed-out result enqueued ${agent.queue.length} actions`);
await actionSystem(agents, registry, world, 3, scheduler);
if (tracer.trace("agt_timeout").some((ev) => ev.type === "agent.action.executed")) {
  throw new Error("late timed-out result executed an action");
}
if (provider.starts !== 1) throw new Error(`expected one provider start, got ${provider.starts}`);

ops.op_log("P3 scheduler timeout OK: generation timeout clears in-flight and ignores late tool calls");
