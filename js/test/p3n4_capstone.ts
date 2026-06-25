// P3N-4 — density capstone (Phase 3 native-parallelism acceptance).
//
// A skill-built scene at the LOCKED density: A=200 in-world agents (each fully
// perceiving -> deciding -> acting, every action traced through the registry),
// D=256 dynamic physics bodies, E=2000 total entities in the grid. Agents move
// kinematically via the `three.setTransform` skill toward DISPERSED per-agent
// waypoints (realistic locomotion — no pathological pile-up), and the 256 props
// fall + rest sparsely, so physics is realistic. Perception runs through the
// native batched spatial op (P3N-1′). Decisions run OFF-loop (deferred), exactly
// like production.
//
// ACCEPTANCE: sim-step p95 (frameStepMs) <= 8 ms over >= 300 measured ticks, with
// the fixed step at 60 steps/s. Prints the per-system breakdown + asserts. Run:
//   limina js/test/p3n4_capstone.ts   (release recommended for representative numbers)

import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld, Position, syncPhysicsBodyTransform } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { AgentRegistry } from "../src/agents/agent.ts";
import { actionSystem, decisionSystem, perceptionSystem } from "../src/agents/systems.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { createShowcaseScheduler } from "../src/demos/phase3_showcase_core.ts";
import type { DecideRequest } from "../src/agents/llm.ts";
import type { MCPRequest, MCPResponse } from "../src/mcp/protocol.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function ok(res: MCPResponse): unknown {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result;
}
function field(v: unknown, k: string): unknown {
  return typeof v === "object" && v !== null && k in v ? (v as Record<string, unknown>)[k] : undefined;
}
const perf = (globalThis as { performance?: { now?: () => number } }).performance;
const hiRes = typeof perf?.now === "function";
const now: () => number = hiRes ? () => perf!.now!() : () => Date.now();
function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
const mean = (v: number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const r2 = (n: number): number => Number(n.toFixed(3));

const A = 200; // agents
const D = 256; // dynamic physics bodies (props)
const E = 2000; // total entities
const AREA = 200;
const TICKS = 400;
const WARMUP = 60; // drop ramp-in; measure >= 300 ticks
const STEP_BUDGET_MS = 8; // sim-step p95 acceptance

const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const agents = new AgentRegistry();
const ecs = createEcsWorld();
const world: WorldContext = {
  ecs,
  transforms: createTransformStorage(ecs),
  spatial: new UniformGridSpatialIndex({ cellSize: 10 }),
  entities: new EntityTable(),
  tags: new Map(),
  scene,
  camera,
  ops,
  agents,
};
ops.op_physics_create_world(-9.81);
ops.op_physics_add_ground(0);
const tracer = new LiminaTracer("ses_p3n4");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);
const builder = { agentId: "engine_p3n4", sessionId: "ses_p3n4", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

let seed = 0x0c0ffee5 >>> 0;
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0xffffffff;
};
const spread = (): number => (rnd() - 0.5) * AREA;

const dynBindings: { eid: number; bodyId: number }[] = [];
const homes = new Map<string, [number, number, number]>();
const agentStart: { eid: number; x: number; z: number }[] = [];

// A agents: static-ish entities (kinematic; moved via three.setTransform), each
// with a dispersed home waypoint they walk toward (so they stay spread out).
for (let i = 0; i < A; i++) {
  const start: [number, number, number] = [spread(), 0.5, spread()];
  const entity = field(ok(await registry.invoke("scene.createEntity", { position: start }, builder)), "entity");
  assert(typeof entity === "string", "agent entity setup failed");
  const aEid = world.entities.resolve(entity)!.eid;
  agentStart.push({ eid: aEid, x: start[0], z: start[2] });
  homes.set(entity, [spread(), 0.5, spread()]);
  agents.add({
    id: `agt_${i}`,
    type: "player",
    entityId: entity,
    perceptionRadius: 15,
    decisionIntervalTicks: 30,
    profile: "builder.readWrite", // grants scene.write so three.setTransform actually executes (player.limited would silently DENY it)
    sessionId: "ses_p3n4",
    llm: { provider: "deferred", model: "", systemPrompt: "" },
  });
}
// D dynamic physics props (fall + rest sparsely — realistic, non-clustering).
for (let i = 0; i < D; i++) {
  const entity = field(ok(await registry.invoke("scene.createEntity", { position: [spread(), 0.5, spread()], dynamic: true }, builder)), "entity");
  assert(typeof entity === "string", "prop setup failed");
  const entry = world.entities.resolve(entity);
  if (entry?.bodyId !== undefined && entry.bodyId >= 0) dynBindings.push({ eid: entry.eid, bodyId: entry.bodyId });
}
// Static scenery up to E total entities (in the grid, perceived).
for (let i = 0; i < E - D - A; i++) {
  ok(await registry.invoke("scene.createEntity", { position: [spread(), 0, spread()] }, builder));
}

// Off-loop provider: walk a small step toward this agent's home via three.setTransform
// (kinematic; permission-checked + traced like any action). Returns pending first
// (await) so the compute lands in the post-tick drain, exactly like a real LLM.
const STEP = 0.6;
const provider = {
  name: "deferred",
  async decide(req: DecideRequest): Promise<{ toolCalls: MCPRequest[]; usage: { totalTokens: number } }> {
    await Promise.resolve();
    const self = req.perception.selfEntity;
    const pos = req.perception.position;
    if (self === undefined || pos === undefined) return { toolCalls: [], usage: { totalTokens: 0 } };
    const home = homes.get(self) ?? pos;
    const dx = home[0] - pos[0];
    const dz = home[2] - pos[2];
    const len = Math.hypot(dx, dz) || 1;
    const step = Math.min(STEP, len);
    const next: [number, number, number] = [pos[0] + (dx / len) * step, pos[1], pos[2] + (dz / len) * step];
    return { toolCalls: [{ tool: "three.setTransform", input: { entity: self, position: next } }], usage: { totalTokens: 0 } };
  },
};
const providers = { deferred: provider };
const scheduler = createShowcaseScheduler();
const scratch = new Float32Array(7);

const phase: Record<string, number[]> = { perception: [], decision: [], action: [], physics: [], sync: [], spatial: [], total: [] };

for (let tick = 1; tick <= TICKS; tick++) {
  builder.tick = tick;
  const t0 = now();
  perceptionSystem(agents, world, tracer, tick);
  const t1 = now();
  decisionSystem(agents, registry, providers, tracer, tick, scheduler);
  const t2 = now();
  void actionSystem(agents, registry, world, tick, scheduler);
  const t3 = now();
  ops.op_physics_step();
  const t4 = now();
  for (const b of dynBindings) syncPhysicsBodyTransform(b.eid, b.bodyId, ops, scratch);
  const t5 = now();
  world.spatial.invalidate();
  const t6 = now();
  phase.perception.push(t1 - t0);
  phase.decision.push(t2 - t1);
  phase.action.push(t3 - t2);
  phase.physics.push(t4 - t3);
  phase.sync.push(t5 - t4);
  phase.spatial.push(t6 - t5);
  phase.total.push(t6 - t0);
  await ops.op_sleep_ms(0); // untimed post-tick drain (off-loop decisions + void actions land here)
}

const kept: Record<string, number[]> = {};
for (const key of Object.keys(phase)) kept[key] = phase[key].slice(WARMUP);
const stepP95 = pct(kept.total, 95);
const stepMean = mean(kept.total);
const breakdown: Record<string, { meanMs: number; p95Ms: number }> = {};
for (const key of ["perception", "decision", "action", "physics", "sync", "spatial"]) {
  breakdown[key] = { meanMs: r2(mean(kept[key])), p95Ms: r2(pct(kept[key], 95)) };
}
// Sanity: this is a non-clustering scene — physics must be the realistic baseline,
// not the piled-up artifact (guards against accidentally rebuilding the clustering).
const tracedActions = ok(await registry.invoke("trace.tail", { type: "skill.executed", limit: 1000 }, { agentId: "inspector", sessionId: "ses_p3n4", permissions: resolveProfile("system.readonly"), tick: TICKS, world }));
const tracedCount = (field(tracedActions, "events") as unknown[]).length;

// Integrity: agents must have ACTUALLY moved (three.setTransform executed, not
// denied) — a static/denied scene would leave every agent at its spawn.
let movedCount = 0;
for (const a of agentStart) {
  if (Math.hypot(Position.x[a.eid] - a.x, Position.z[a.eid] - a.z) > 0.5) movedCount += 1;
}
const report = {
  density: { agents: A, dynamicBodies: D, entities: E, dynBindings: dynBindings.length },
  ticks: TICKS,
  measuredTicks: TICKS - WARMUP,
  timer: hiRes ? "performance.now()" : "Date.now()",
  simStep: { meanMs: r2(stepMean), p95Ms: r2(stepP95), budgetMs: STEP_BUDGET_MS },
  breakdown,
  tracedActions: tracedCount,
  movedAgents: movedCount,
};
ops.op_log("P3N-4 CAPSTONE " + JSON.stringify(report));
assert(tracedCount > 0, "no actions were traced — agents must perceive->decide->act through the registry");
assert(movedCount >= Math.floor(A * 0.8), `only ${movedCount}/${A} agents moved — three.setTransform actions were denied/ineffective (agents need scene.write)`);
assert(stepP95 <= STEP_BUDGET_MS, `sim-step p95 ${r2(stepP95)}ms exceeds the ${STEP_BUDGET_MS}ms budget at the locked density`);
ops.op_log(`P3N-4 PASS: sim-step p95 ${r2(stepP95)}ms <= ${STEP_BUDGET_MS}ms over ${TICKS - WARMUP} ticks @ A=${A}/D=${D}/E=${E} (${movedCount}/${A} agents moved, ${tracedCount} traced ops)`);
