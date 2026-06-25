// M7 — agent systems with a deterministic ScriptedProvider: a player perceives
// a target, decides to impulse toward it, the action executes one tick later,
// and the perception -> decision -> action causal chain is traced.

import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { AgentRegistry } from "../src/agents/agent.ts";
import { ScriptedProvider, type DecideRequest } from "../src/agents/llm.ts";
import { actionSystem, decisionSystem, perceptionSystem } from "../src/agents/systems.ts";
import type { MCPRequest, MCPResponse } from "../src/mcp/protocol.ts";

function ok(res: MCPResponse): unknown {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result;
}
function field(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) {
    const rec = value as Record<string, unknown>;
    return rec[key];
  }
  return undefined;
}

const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const agents = new AgentRegistry();
const world: WorldContext = { ecs: createEcsWorld(), entities: new EntityTable(), tags: new Map(), scene, camera, ops, agents };

// No gravity so the body moves ONLY from the agent's impulse (deterministic).
ops.op_physics_create_world(0);
ops.op_physics_add_ground(-10);

const tracer = new LiminaTracer("ses_m7");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);

const builder = { agentId: "engine", sessionId: "ses_m7", permissions: resolveProfile("builder.readWrite"), tick: 0, world };
const playerEntity = field(ok(await registry.invoke("scene.createEntity", { position: [0, 0, 0], dynamic: true }, builder)), "entity");
const targetEntity = field(ok(await registry.invoke("scene.createEntity", { position: [5, 0, 0], dynamic: false }, builder)), "entity");
if (typeof playerEntity !== "string" || typeof targetEntity !== "string") throw new Error("entity setup failed");

agents.add({
  id: "agt_player", type: "player", entityId: playerEntity,
  perceptionRadius: 50, decisionIntervalTicks: 1, profile: "player.limited", sessionId: "ses_m7",
  llm: { provider: "scripted", model: "", systemPrompt: "move toward the nearest entity" },
});

const scripted = new ScriptedProvider((req: DecideRequest): MCPRequest[] => {
  const target = req.perception.nearby[0];
  if (target === undefined || req.perception.position === undefined || req.perception.selfEntity === undefined) return [];
  const s = req.perception.position;
  const d = [target.position[0] - s[0], target.position[1] - s[1], target.position[2] - s[2]];
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  return [{ tool: "physics.applyImpulse", input: { entity: req.perception.selfEntity, impulse: [d[0] / len * 2, d[1] / len * 2, d[2] / len * 2] } }];
});
const providers = { scripted };

const bodyId = world.entities.resolve(playerEntity)?.bodyId ?? -1;
const startPos = new Float32Array(3);
ops.op_physics_body_pos(bodyId, startPos);

for (let tick = 1; tick <= 6; tick++) {
  perceptionSystem(agents, world, tracer, tick);
  decisionSystem(agents, registry, providers, tracer, tick);
  await actionSystem(agents, registry, world, tick);
  ops.op_physics_step();
  await Promise.resolve(); // pump microtasks: scripted decide().then enqueues for next tick
}

const endPos = new Float32Array(3);
ops.op_physics_body_pos(bodyId, endPos);
if (endPos[0] <= startPos[0] + 0.01) throw new Error(`player did not move toward target: ${startPos[0]} -> ${endPos[0]}`);

const trace = tracer.trace("agt_player");
const perception = trace.find((e) => e.type === "agent.perception.updated");
const decision = trace.find((e) => e.type === "agent.decision.made");
const exec = trace.find((e) => e.type === "skill.executed");
if (!perception || !decision || !exec) throw new Error("missing perception/decision/execution events");

// Causal chain: decision <- perception, skill.executed <- some decision.
const perceptionIds = new Set(trace.filter((e) => e.type === "agent.perception.updated").map((e) => e.id));
if (!decision.causedBy.some((id) => perceptionIds.has(id))) throw new Error("decision not linked to a perception");
const decisionIds = new Set(trace.filter((e) => e.type === "agent.decision.made").map((e) => e.id));
if (!exec.causedBy.some((id) => decisionIds.has(id))) throw new Error("execution not linked to a decision");

// Tick delta: the action executes exactly one tick after its decision.
const linkedDecision = trace.find((e) => e.type === "agent.decision.made" && exec.causedBy.includes(e.id));
const execTick = field(exec.payload, "tick");
const decTick = field(linkedDecision?.payload, "tick");
if (typeof execTick !== "number" || typeof decTick !== "number" || execTick !== decTick + 1) {
  throw new Error(`expected action one tick after decision, got dec=${String(decTick)} exec=${String(execTick)}`);
}

ops.op_log("M7 OK: perception->decision->action (scripted), causal chain traced, action lands decision tick + 1");
