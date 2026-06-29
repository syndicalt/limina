// Phase 16 (Track B — Eyes) — THE STRUCTURAL SELF-CORRECTION GATE (real providers, end to end).
//
// This runs the self-correction loop with REAL providers, GPU-free: the agent PERCEIVES its scene
// through scene.inspect and FIXES it through scene.createEntity, iterating until a structural goal
// (enough content, spread across the region) is met. It's a complete loop over real engine state —
// not a mock — proving an agent genuinely improves its world unattended. The pixel/vision variant
// (self_correct.ts) layers on top once GPU readback exists; this slice is complete now.
//
// Run: ./target/release/limina js/test/p16_structural_refine.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { refineScene, type SceneSummary } from "../src/eyes/structural_refine.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p16_structural_refine FAIL: " + msg);
}
function makeWorld(worldOps: EngineOps): WorldContext {
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}
const PERMS = resolveProfile("builder.readWrite");

/** A live agent context: real scene.inspect perception + real scene.createEntity fixes. */
function makeAgent(session: string): { inspect: () => Promise<SceneSummary>; addAt: (x: number, z: number) => Promise<void> } {
  ops.op_physics_create_world(-9.81);
  const reg = new SkillRegistry(new LiminaTracer(session));
  registerCoreSkills(reg);
  const world = makeWorld(ops);
  const base: InvokeBase = { agentId: "agt", sessionId: session, permissions: PERMS, tick: 0, world };
  const unwrap = (r: MCPResponse | undefined) => {
    if (r === undefined || !r.success) throw new Error("invoke failed: " + JSON.stringify(r?.error));
    return (r.result ?? {}) as Record<string, unknown>;
  };
  return {
    inspect: async () => {
      const r = unwrap(await reg.invoke("scene.inspect", {}, base)) as { entityCount: number; size: [number, number, number] | null };
      return { entityCount: r.entityCount, spanX: r.size ? r.size[0] : 0, spanZ: r.size ? r.size[2] : 0 };
    },
    addAt: async (x, z) => { unwrap(await reg.invoke("scene.createEntity", { shape: "box", position: [x, 0, z] }, base)); },
  };
}

// ── 1. From an EMPTY scene, the agent self-corrects to meet the structural goal. ──────────────
const goal = { minEntities: 6, minSpan: 20 };
{
  const agent = makeAgent("ses_p16_sref_A");
  const r = await refineScene({ ...agent, goal, spacing: 5, maxIterations: 32 });
  assert(r.history[0].entityCount === 0, "the agent started from an empty scene");
  assert(r.converged, "the agent self-corrected the scene to meet the goal");
  assert(r.finalSummary.entityCount >= goal.minEntities, `enough content placed (${r.finalSummary.entityCount} ≥ ${goal.minEntities})`);
  assert(Math.max(r.finalSummary.spanX, r.finalSummary.spanZ) >= goal.minSpan, `content is spread across the region (span ${Math.max(r.finalSummary.spanX, r.finalSummary.spanZ)} ≥ ${goal.minSpan})`);
  assert(r.history.some((h) => h.action === "place"), "the loop actually applied fixes");
  // Entity count is non-decreasing as it fixes (every fix adds content).
  for (let i = 1; i < r.history.length; i++) assert(r.history[i].entityCount >= r.history[i - 1].entityCount, `content grows monotonically (step ${i})`);
}

// ── 2. Re-running on the now-populated world short-circuits: goal already met, no new fixes. ──
{
  const agent = makeAgent("ses_p16_sref_idem");
  await refineScene({ ...agent, goal, spacing: 5, maxIterations: 32 }); // build it
  const r2 = await refineScene({ ...agent, goal, spacing: 5, maxIterations: 32 }); // already satisfied
  assert(r2.converged && r2.iterations === 1, "a scene that already meets the goal passes on the first look");
  assert(!r2.history.some((h) => h.action === "place"), "no new content is placed when the goal is already met");
}

// ── 3. Deterministic: two fresh agents reach the same world. ──────────────────────────────────
{
  const a = await refineScene({ ...makeAgent("ses_p16_sref_detA"), goal, spacing: 5, maxIterations: 32 });
  const b = await refineScene({ ...makeAgent("ses_p16_sref_detB"), goal, spacing: 5, maxIterations: 32 });
  assert(a.iterations === b.iterations && a.finalSummary.entityCount === b.finalSummary.entityCount, "the refinement is deterministic across agents");
}

// ── 4. Honest non-convergence under a tight budget. ───────────────────────────────────────────
{
  const r = await refineScene({ ...makeAgent("ses_p16_sref_short"), goal: { minEntities: 20, minSpan: 50 }, spacing: 5, maxIterations: 3 });
  assert(!r.converged, "a 3-step budget cannot reach a 20-entity / 50m goal");
  assert(r.finalSummary.entityCount === 3, `it reports the honest partial progress (placed ${r.finalSummary.entityCount}), not a fake pass`);
}

ops.op_log(
  "p16_structural_refine OK: a COMPLETE self-correction loop with real providers — the agent perceives its scene via " +
  "scene.inspect and fixes it via scene.createEntity, converging an empty world to a content-rich, well-spread one; " +
  "short-circuits when the goal is already met; is deterministic; and reports honest non-convergence under a tight budget. " +
  "GPU-free and end-to-end. The pixel/vision variant layers on top once readback exists.",
);
