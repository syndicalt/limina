// M10 (live smoke) — an Ollama-driven player produces a schema-valid action that
// executes and appears in the trace with the perception->decision->action chain.
// The deterministic player path is the windowed scripted demo (js/src/demos/player.ts).

import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { AgentRegistry } from "../src/agents/agent.ts";
import { OllamaProvider } from "../src/agents/llm.ts";
import { perceptionSystem } from "../src/agents/systems.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function entityId(res: MCPResponse): string {
  if (!res.success) throw new Error("setup failed: " + JSON.stringify(res.error));
  const r = res.result;
  if (typeof r === "object" && r !== null && "entity" in r) {
    const rec = r as Record<string, unknown>;
    if (typeof rec.entity === "string") return rec.entity;
  }
  throw new Error("no entity id");
}

const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const agents = new AgentRegistry();
const world: WorldContext = { ecs: createEcsWorld(), entities: new EntityTable(), tags: new Map(), scene, camera, ops, agents };

ops.op_physics_create_world(0);
ops.op_physics_add_ground(-5);

const tracer = new LiminaTracer("ses_m10");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);
const setup = { agentId: "engine", sessionId: "ses_m10", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

const player = entityId(await registry.invoke("scene.createEntity", { shape: "sphere", color: 0xff8c1a, position: [0, 0.5, 0], dynamic: true }, setup));
await registry.invoke("scene.createEntity", { shape: "box", color: 0x4ade80, position: [5, 0.5, 0], dynamic: false }, setup);

const agent = agents.add({
  id: "agt_player", type: "player", entityId: player,
  perceptionRadius: 100, decisionIntervalTicks: 1, profile: "player.limited", sessionId: "ses_m10",
  llm: {
    provider: "ollama", model: "qwen2.5-coder:3b",
    systemPrompt: "You are a player in a 3D world. Move toward the nearest entity in your perception by calling the physics.applyImpulse tool on your OWN entity (use the selfEntity id) with an impulse vector pointing at the target. You MUST call a tool.",
  },
});

perceptionSystem(agents, world, tracer, 1);
if (agent.perception === undefined) throw new Error("perception not built");

const provider = new OllamaProvider("qwen2.5-coder:3b");
ops.op_log("M10: calling Ollama qwen2.5-coder:3b (may take a few seconds)...");
const { toolCalls } = await provider.decide({ systemPrompt: agent.llm.systemPrompt, perception: agent.perception, tools: registry.list(), previousResults: [] });
ops.op_log(`M10: ollama proposed ${toolCalls.length} tool call(s): ${toolCalls.map((c) => c.tool).join(", ")}`);

const decisionId = tracer.emit({
  type: "agent.decision.made", actorId: "agt_player", threadId: "ses_m10", parentEventId: null,
  causedBy: agent.lastPerceptionEventId !== undefined ? [agent.lastPerceptionEventId] : [],
  payload: { tick: 1, provider: "ollama" },
});

let executed = false;
for (const call of toolCalls) {
  const skill = registry.describe(call.tool);
  if (skill === undefined || !skill.input.safeParse(call.input).success) {
    tracer.emit({ type: "agent.toolcall.rejected", actorId: "agt_player", threadId: "ses_m10", parentEventId: null, causedBy: [decisionId], payload: { tool: call.tool } });
    continue;
  }
  const res = await registry.invoke(call.tool, call.input, {
    agentId: "agt_player", sessionId: "ses_m10", permissions: resolveProfile("player.limited"), tick: 2, world, causedBy: [decisionId],
  });
  if (res.success) { executed = true; break; }
}
if (!executed) throw new Error("no schema-valid, permitted tool call executed from Ollama");

const trace = tracer.trace("agt_player");
const exec = trace.find((e) => e.type === "skill.executed");
if (!exec) throw new Error("no skill.executed in trace");
if (!exec.causedBy.includes(decisionId)) throw new Error("execution not linked to the decision");
const decision = trace.find((e) => e.id === decisionId);
const perceptionIds = new Set(trace.filter((e) => e.type === "agent.perception.updated").map((e) => e.id));
if (decision === undefined || !decision.causedBy.some((id) => perceptionIds.has(id))) throw new Error("decision not linked to perception");

ops.op_log("M10 OK: Ollama-driven player executed a schema-valid action, traced perception->decision->action");
