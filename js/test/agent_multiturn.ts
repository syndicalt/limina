// Phase 3 bounded multi-turn orchestration — provider/tool-result/perception
// loop with hard limits and causal trace edges across turns.

import { ops } from "../src/engine.ts";
import { AgentRegistry } from "../src/agents/agent.ts";
import { runBoundedMultiTurn } from "../src/agents/systems.ts";
import type { DecideRequest, LLMProvider } from "../src/agents/llm.ts";
import type { MCPRequest } from "../src/mcp/protocol.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { createHeadlessContext } from "../src/game/index.ts";

const ctx = createHeadlessContext({ session: "ses_multi" });
const registry = ctx.registry;
const world = ctx.world;
const tracer = ctx.registry.tracer;
const agents = new AgentRegistry();
world.agents = agents;

ops.op_physics_create_world(0);

const setup = { agentId: "engine", sessionId: "ses_multi", permissions: resolveProfile("builder.readWrite"), tick: 0, world };
await registry.invoke("scene.createEntity", { position: [0, 0, 0] }, setup);

const agent = agents.add({
  id: "agt_multi",
  type: "builder",
  perceptionRadius: 50,
  decisionIntervalTicks: 1,
  profile: "builder.readWrite",
  sessionId: "ses_multi",
  llm: { provider: "scripted-multi", model: "", systemPrompt: "query twice" },
});

class TwoStepProvider implements LLMProvider {
  readonly name = "scripted-multi";
  calls: DecideRequest[] = [];
  decide(req: DecideRequest): Promise<{ toolCalls: MCPRequest[]; usage?: { totalTokens?: number } }> {
    this.calls.push(req);
    if (this.calls.length === 1) {
      return Promise.resolve({ toolCalls: [{ tool: "scene.queryEntities", input: {} }], usage: { totalTokens: 3 } });
    }
    if (this.calls.length === 2) {
      if (req.previousResults.length !== 1) throw new Error("second turn did not receive previous tool result");
      return Promise.resolve({ toolCalls: [{ tool: "skills.list", input: {} }], usage: { totalTokens: 5 } });
    }
    if (req.previousResults.length !== 2) throw new Error("third turn did not receive both previous tool results");
    return Promise.resolve({ toolCalls: [], usage: { totalTokens: 0 } });
  }
}

const provider = new TwoStepProvider();
const result = await runBoundedMultiTurn(agent, registry, { "scripted-multi": provider }, world, tracer, {
  startTick: 10,
  maxSteps: 3,
  maxToolCalls: 2,
  timeoutMs: 1000,
  maxTokens: 10,
});

if (result.reason !== "max_tool_calls" || result.steps !== 2) throw new Error("multi-turn did not stop at the tool-call ceiling: " + JSON.stringify(result));
if (result.toolCalls !== 2) throw new Error(`expected exactly two tool calls, got ${result.toolCalls}`);
if (result.tokensUsed !== 8) throw new Error(`expected token usage to accumulate, got ${result.tokensUsed}`);
if (provider.calls.length !== 2) throw new Error(`expected two provider steps, got ${provider.calls.length}`);

const trace = tracer.trace("agt_multi");
const perceptions = trace.filter((e) => e.type === "agent.perception.updated");
const decisions = trace.filter((e) => e.type === "agent.decision.made");
const toolResults = trace.filter((e) => e.type === "agent.tool_result");
if (perceptions.length < 2 || decisions.length < 2 || toolResults.length !== 2) throw new Error("missing multi-turn trace events");
if (!decisions[1].causedBy.includes(toolResults[0].id)) throw new Error("second decision not linked to first tool result");

const slowAgent = agents.add({
  id: "agt_slow",
  type: "builder",
  perceptionRadius: 50,
  decisionIntervalTicks: 1,
  profile: "builder.readWrite",
  sessionId: "ses_multi",
  llm: { provider: "slow", model: "", systemPrompt: "hang" },
});

class SlowProvider implements LLMProvider {
  readonly name = "slow";
  decide(): Promise<{ toolCalls: MCPRequest[] }> {
    return ops.op_sleep_ms(250).then(() => ({ toolCalls: [{ tool: "scene.queryEntities", input: {} }] }));
  }
}

const started = Date.now();
const timeoutResult = await runBoundedMultiTurn(slowAgent, registry, { slow: new SlowProvider() }, world, tracer, {
  startTick: 20,
  maxSteps: 2,
  maxToolCalls: 2,
  timeoutMs: 20,
});
const elapsed = Date.now() - started;
if (timeoutResult.reason !== "timeout") throw new Error("slow provider did not return timeout: " + JSON.stringify(timeoutResult));
if (elapsed > 180) throw new Error(`slow provider was not bounded; elapsed=${elapsed}ms`);
if (tracer.trace("agt_slow").some((e) => e.type === "skill.executed")) throw new Error("late slow-provider tool call executed after timeout");

ops.op_log("Agent multi-turn OK: bounded provider/tool-result/perception loop with trace edges");
