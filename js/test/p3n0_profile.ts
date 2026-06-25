// P3N-0 — profile-first (the native-parallelism re-target gate).
//
// Headless sim-step profiler at the LOCKED Phase 3 density: A=200 agents,
// D=256 dynamic physics bodies, E=2000 total entities. It mirrors the
// phase3_showcase `fixedStep` sequence EXACTLY — perception -> decision ->
// action -> op_physics_step -> per-body transform sync -> spatial.invalidate —
// but with NO render (so it isolates the sim cost P3N-4 will gate on) and with
// PER-PHASE timing. Goal: confirm the spatial build/query + physics readback
// actually dominate the sim step before we build native ops; if something else
// dominates (JS perception materialize, scheduler sorts, action drain, GC),
// the plan says RE-TARGET first. Prints a JSON breakdown + a verdict.
//
// Run: limina js/test/p3n0_profile.ts

import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld, syncPhysicsBodyTransform } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { AgentRegistry } from "../src/agents/agent.ts";
import type { DecideRequest } from "../src/agents/llm.ts";
import { actionSystem, decisionSystem, perceptionSystem } from "../src/agents/systems.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { createShowcaseScheduler } from "../src/demos/phase3_showcase_core.ts";
import type { MCPRequest, MCPResponse } from "../src/mcp/protocol.ts";

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

const A = 200; // agents (each a dynamic body, fully perceiving/deciding/acting)
const D = 256; // total dynamic physics bodies (A agents + props)
const E = 2000; // total entities in the grid
const AREA = 200; // entities spread over AREA x AREA (radius-15 -> ~35 neighbors)
const TICKS = 360;
const WARMUP = 12; // drop the first ticks (JIT + tick-1 spawn-in)

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
const tracer = new LiminaTracer("ses_p3n0");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);
const builder = { agentId: "engine_p3n0", sessionId: "ses_p3n0", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

// Deterministic positions via a small LCG (reproducible runs).
let seed = 0x1234abcd >>> 0;
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0xffffffff;
};
const posAt = (): [number, number, number] => [(rnd() - 0.5) * AREA, 0.5, (rnd() - 0.5) * AREA];

const dynBindings: { eid: number; bodyId: number }[] = [];

// A agent-bound dynamic entities.
for (let i = 0; i < A; i++) {
  const entity = field(ok(await registry.invoke("scene.createEntity", { position: posAt(), dynamic: true }, builder)), "entity");
  if (typeof entity !== "string") throw new Error("agent entity setup failed");
  const entry = world.entities.resolve(entity);
  if (entry?.bodyId !== undefined && entry.bodyId >= 0) dynBindings.push({ eid: entry.eid, bodyId: entry.bodyId });
  agents.add({
    id: `agt_${i}`,
    type: "player",
    entityId: entity,
    perceptionRadius: 15,
    decisionIntervalTicks: 30,
    profile: "player.limited",
    sessionId: "ses_p3n0",
    llm: { provider: "deferred", model: "", systemPrompt: "" },
  });
}
// Extra dynamic props up to D dynamic bodies.
for (let i = 0; i < D - A; i++) {
  const entity = field(ok(await registry.invoke("scene.createEntity", { position: posAt(), dynamic: true }, builder)), "entity");
  if (typeof entity !== "string") throw new Error("prop entity setup failed");
  const entry = world.entities.resolve(entity);
  if (entry?.bodyId !== undefined && entry.bodyId >= 0) dynBindings.push({ eid: entry.eid, bodyId: entry.bodyId });
}
// Static decoration entities up to E total (in the grid, perceived, no body).
for (let i = 0; i < E - D; i++) {
  ok(await registry.invoke("scene.createEntity", { position: posAt() }, builder));
}

// Off-loop decision provider (production-faithful). decide() returns a pending
// promise immediately (await), so the compute + the .then validate/enqueue land
// in the untimed post-tick drain — exactly like the real LLM resolving in
// poll_event_loop AFTER the frame. A synchronous ScriptedProvider would instead
// run the whole decision inside decisionSystem and mis-attribute it as on-frame.
const provider = {
  name: "deferred",
  async decide(req: DecideRequest): Promise<{ toolCalls: MCPRequest[]; usage: { totalTokens: number } }> {
    await Promise.resolve();
    const t = req.perception.nearby[0];
    if (t === undefined || req.perception.position === undefined || req.perception.selfEntity === undefined) {
      return { toolCalls: [], usage: { totalTokens: 0 } };
    }
    const s = req.perception.position;
    const d = [t.position[0] - s[0], t.position[1] - s[1], t.position[2] - s[2]];
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    return {
      toolCalls: [{ tool: "physics.applyImpulse", input: { entity: req.perception.selfEntity, impulse: [(d[0] / len) * 0.5, 0, (d[2] / len) * 0.5] } }],
      usage: { totalTokens: 0 },
    };
  },
};
const providers = { deferred: provider };
const scheduler = createShowcaseScheduler();
const scratch = new Float32Array(7);

const phase: Record<string, number[]> = { perception: [], decision: [], action: [], physics: [], sync: [], spatial: [], total: [] };
let dueTicks = 0;

for (let tick = 1; tick <= TICKS; tick++) {
  builder.tick = tick;
  const dueBefore = agents.all().filter((a) => tick - a.lastDecisionTick >= a.decisionIntervalTicks && a.inFlight !== true).length;
  if (dueBefore > 0) dueTicks += 1;
  const t0 = now();
  perceptionSystem(agents, world, tracer, tick);
  const t1 = now();
  decisionSystem(agents, registry, providers, tracer, tick, scheduler);
  const t2 = now();
  void actionSystem(agents, registry, world, tick, scheduler); // production fires this `void`; its cost drains post-frame, not in the sim step
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
  await ops.op_sleep_ms(0); // untimed post-tick drain: off-loop decide().then + the void actionSystem resolve here (the poll_event_loop analogue)
}

const keys = ["perception", "decision", "action", "physics", "sync", "spatial"] as const;
const kept: Record<string, number[]> = {};
for (const k of Object.keys(phase)) kept[k] = phase[k].slice(WARMUP);
const totalMeanSum = keys.map((k) => mean(kept[k])).reduce((a, b) => a + b, 0);
const breakdown: Record<string, { meanMs: number; p95Ms: number; sharePct: number }> = {};
for (const k of keys) {
  const m = mean(kept[k]);
  breakdown[k] = { meanMs: r2(m), p95Ms: r2(pct(kept[k], 95)), sharePct: r2((100 * m) / Math.max(1e-9, totalMeanSum)) };
}
const ranked = Object.entries(breakdown).sort((a, b) => b[1].sharePct - a[1].sharePct);
const top = ranked[0][0];
// "spatial cost" = the perception phase (which performs the per-tick grid rebuild + radius queries) + the spatial.invalidate bookkeeping.
const spatialShare = breakdown.perception.sharePct + breakdown.spatial.sharePct;
const physicsShare = breakdown.physics.sharePct + breakdown.sync.sharePct;
const dominateTarget = spatialShare + physicsShare;

const report = {
  density: { agents: A, dynamicBodies: D, entities: E, dynBindings: dynBindings.length, areaSize: AREA },
  ticks: TICKS,
  warmupDropped: WARMUP,
  dueTicks,
  timer: hiRes ? "performance.now()" : "Date.now() [ms granularity — sub-ms phases under-resolved]",
  simStep: { meanMs: r2(mean(kept.total)), p95Ms: r2(pct(kept.total, 95)), maxMs: r2(Math.max(...kept.total)) },
  breakdown,
  dominantPhase: top,
  spatialSharePct: r2(spatialShare),
  physicsReadbackSharePct: r2(physicsShare),
  nativeTargetSharePct: r2(dominateTarget),
};
ops.op_log("P3N-0 PROFILE " + JSON.stringify(report));

// Gate verdict (interpretive — printed, not asserted): does the native-op target
// (spatial perception + physics readback) actually dominate the sim step?
const verdict = dominateTarget >= 60
  ? `GO: spatial+physics readback = ${r2(dominateTarget)}% of sim work (dominant: ${top}) — native-parallel target confirmed.`
  : `RE-TARGET: spatial+physics readback only ${r2(dominateTarget)}% (dominant: ${top}) — the wall is elsewhere; revisit before building native ops.`;
ops.op_log("P3N-0 VERDICT " + verdict);

// --- Decision-hotspot micro-confirm: registry.list() rebuilds every tool
// descriptor (z.toJSONSchema per skill) and decisionSystem calls it ONCE PER
// ADMITTED AGENT per tick, producing an identical result every time. ---
const LIST_ITERS = 1000;
const lt0 = now();
for (let i = 0; i < LIST_ITERS; i++) registry.list();
const listMsPerCall = (now() - lt0) / LIST_ITERS;
ops.op_log(
  `P3N-0 HOTSPOT registry.list()=${r2(listMsPerCall)}ms/call x ${registry.list().length} skills (z.toJSONSchema per skill); ` +
    `decisionSystem rebuilds it ONCE PER ADMITTED AGENT/tick -> implied ~${Math.round(breakdown.decision.meanMs / Math.max(1e-9, listMsPerCall))} list() calls/tick explains the ${r2(breakdown.decision.meanMs)}ms decision phase. Fix: cache list(), invalidate on register/reload.`,
);
