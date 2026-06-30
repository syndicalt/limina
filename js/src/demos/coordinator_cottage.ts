// "A cottage on the beach" — the engine-side coordinator/delegate showcase.
//
// THE STORY: a COORDINATOR agent (holding `orchestrate` + `approval.review` — the
// `reviewer.coordinator` profile) decomposes the goal "a cottage on the beach" and
// DELEGATES it to three least-privilege WORKER agents, each scoped to a distinct
// capability BUNDLE:
//   - Terraform  — bundle [terrain.read, terrain.generate, scene.write], task
//                  "shape the beach", proposes `world.generateRegion` (the ground).
//   - Builder    — bundle [scene.read, scene.write], task "place the cottage",
//                  proposes a `scene.createEntity` (a cottage box at a fixed spot).
//   - Decorator  — bundle [scene.read, scene.write], task "scatter palms +
//                  driftwood", proposes a few `scene.createEntity` props.
//
// Each worker runs under the Phase 10C delegate review gate (its bundle governs
// what it SEES + can INVOKE; the marker profile flags it for review), so every
// MUTATING edit it proposes is HELD (`skill.approval.pending`) — the world does NOT
// change. A human (the web client) lists the held edits (`approval.list`), then
// `approval.grant`s the ones it wants (they apply now) and `approval.deny`s the
// rest (dropped). This reuses the SHIPPED delegate + approval seam verbatim; nothing
// here is a new engine primitive — it is the showcase wiring over them.
//
// Two entry points:
//   - `setupCoordinatorCottage()` — builds a self-contained headless world + registry
//     with the three worker providers, the `delegate` skill (via registerCoreSkills),
//     and a `coordinator.build` trigger skill. Returns a `runCottageBuild()` that runs
//     the build as the coordinator. The headless test drives this.
//   - `installCottageScenario(registry, …)` — wires the SAME `delegate` + `coordinator.
//     build` surface onto an EXISTING registry/world (the editor host's authoritative
//     server), composing with any gate the host already installed.

import { z } from "../../build/zod.bundle.mjs";
import { createHeadlessContext } from "../game/index.ts";
import { despawnRenderable } from "../ecs/world.ts";
import { AgentRegistry } from "../agents/agent.ts";
import { ScriptedProvider } from "../agents/llm.ts";
import type { DecideRequest } from "../agents/llm.ts";
import type { MCPRequest } from "../mcp/protocol.ts";
import { LiminaTracer } from "../observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../skills/registry.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { ORCHESTRATE_PERMISSION, registerOrchestrationSkills } from "../skills/orchestration.ts";
import type { ProviderMap } from "../agents/systems.ts";

/** The coordinator's permission profile — `orchestrate` (to delegate) + `approval.
 *  review` (to grant/deny the workers' held edits) + reads. */
export const COORDINATOR_PROFILE = "reviewer.coordinator";

/** Deterministic terrain seed for the beach (the same value drives the procedural
 *  source on every run, so generation is reproducible). */
export const BEACH_SEED = 7;

/** One delegated worker: a named provider, its least-privilege bundle, the task it
 *  is given, and how many tool calls its bounded loop may make. */
export interface CottageWorkerSpec {
  /** Provider name (also the worker's human label in the showcase). */
  provider: string;
  /** The worker's least-privilege capability bundle (scopes exposure + invocation). */
  bundle: string[];
  /** The natural-language task the coordinator hands the worker (its systemPrompt). */
  task: string;
  /** Tool-call budget for the worker's bounded loop. */
  maxToolCalls: number;
}

/** The three workers, in delegation order. Bundles are DISTINCT and least-privilege:
 *  only Terraform may run the high-cost `terrain.generate`; Builder/Decorator are
 *  pure scene writers (no terrain authority). None holds an escalation cap. */
export const COTTAGE_WORKERS: readonly CottageWorkerSpec[] = [
  { provider: "terraform", bundle: ["terrain.read", "terrain.generate", "scene.write"], task: "shape the beach", maxToolCalls: 4 },
  { provider: "builder", bundle: ["scene.read", "scene.write"], task: "place the cottage", maxToolCalls: 4 },
  { provider: "decorator", bundle: ["scene.read", "scene.write"], task: "scatter palms + driftwood", maxToolCalls: 6 },
];

/** The three deterministic worker policies. Each is a ScriptedProvider so the whole
 *  build is reproducible + headless. A policy proposes its mutating edits on the
 *  first decision, then returns no tool calls so its bounded loop ends cleanly. */
export function cottageProviders(): ProviderMap {
  // Terraform: lay down a 2x2 beach region (4 heightfield tiles) from BEACH_SEED.
  const terraform = new ScriptedProvider((req: DecideRequest): MCPRequest[] =>
    req.previousResults.length === 0
      ? [{ tool: "world.generateRegion", input: { seed: BEACH_SEED, bounds: { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 } } }]
      : []);

  // Builder: a single cottage box (a low-poly brown cube) on the sand.
  const builder = new ScriptedProvider((req: DecideRequest): MCPRequest[] =>
    req.previousResults.length === 0
      ? [{ tool: "scene.createEntity", input: { shape: "box", size: 3, color: 0x8b5a2b, position: [0, 1.5, 0] } }]
      : []);

  // Decorator: two palm "trunks" + one piece of driftwood, scattered around it.
  const decorator = new ScriptedProvider((req: DecideRequest): MCPRequest[] =>
    req.previousResults.length === 0
      ? [
        { tool: "scene.createEntity", input: { shape: "box", size: 1, color: 0x2e8b57, position: [4, 1, 2] } },
        { tool: "scene.createEntity", input: { shape: "box", size: 1, color: 0x2e8b57, position: [-3, 1, 4] } },
        { tool: "scene.createEntity", input: { shape: "box", size: 1, color: 0xa0522d, position: [2, 0.5, -3] } },
      ]
      : []);

  return { terraform, builder, decorator };
}

/** Summary of one delegated worker returned by the `coordinator.build` trigger. */
export interface CottageWorkerResult {
  workerId: string;
  provider: string;
  bundle: string[];
  steps: number;
  toolCalls: number;
  reason: string;
}

/** Reset the demo world to empty before a fresh build. Idempotent + deterministic:
 *  (1) DENY every still-held edit from a prior run (dropped, never applied); (2)
 *  remove every entity (its scene mesh, ECS renderable, table row, tags); (3) rebuild
 *  the physics world wholesale (wipes the prior run's heightfields/bodies); (4) forget
 *  the prior run's worker agents. After this the only things a subsequent grant can
 *  add are THIS build's edits — so two builds never accumulate (no duplicate beaches/
 *  cottages). On the very first build (empty world, nothing held) it is a no-op apart
 *  from re-creating the empty physics world, and emits no trace events. */
async function resetCottageWorld(registry: SkillRegistry, world: WorldContext, agents?: AgentRegistry): Promise<void> {
  // 1. Drop edits still held from a prior build (deny -> dropped, never applied).
  for (const p of registry.pendingApprovals()) {
    await registry.resolveApproval(p.approvalId, false, { agentId: "agt_coord", reason: "reset for fresh build" });
  }
  // 2. Clear every entity created by the prior build.
  for (const id of world.entities.ids()) {
    const entry = world.entities.resolve(id);
    if (entry === undefined) continue;
    if (entry.mesh !== undefined) world.scene.remove(entry.mesh);
    despawnRenderable(world.ecs, entry.eid);
    world.tags.delete(entry.eid);
    world.entities.destroy(id);
  }
  // 3. Rebuild the physics world (drops all colliders/bodies from the prior build).
  world.ops.op_physics_create_world(0);
  // 4. Forget the prior run's worker agents.
  agents?.clear();
}

/** Core delegation routine, shared by the `coordinator.build` skill and the
 *  standalone `runCottageBuild` helper. Emits the coordinator's decomposition
 *  decision, then DELEGATES the three workers (each held under review), linking each
 *  delegate action to that decision so the causal tree is intact. Returns the per-
 *  worker outcomes; the workers' mutating edits are now HELD in the registry's
 *  pending store for a reviewer to resolve. */
async function delegateCottageWorkers(
  registry: SkillRegistry,
  base: InvokeBase,
  agents?: AgentRegistry,
): Promise<{ decisionId: string; workers: CottageWorkerResult[] }> {
  // FRESH BUILD: reset the demo world to empty before delegating, so each build is
  // clean + repeatable (the inspector.snapshot must not carry the previous run's
  // entities). This drops any still-held edits from the prior run, clears its
  // entities, rebuilds the physics world, and forgets its workers.
  await resetCottageWorld(registry, base.world, agents);

  // The coordinator's decompose decision — the cause every delegate links back to.
  const decisionId = base.causedBy === undefined || base.causedBy.length === 0
    ? registry.tracer.emit({
      type: "agent.decision.made",
      actorId: base.agentId,
      threadId: base.sessionId,
      parentEventId: null,
      causedBy: [],
      payload: { tick: base.tick, kind: "decompose", goal: "a cottage on the beach" },
    })
    : base.causedBy[0];

  const workers: CottageWorkerResult[] = [];
  for (const spec of COTTAGE_WORKERS) {
    const res = await registry.invoke(
      "delegate",
      { task: spec.task, bundle: spec.bundle, provider: spec.provider, maxSteps: 4, maxToolCalls: spec.maxToolCalls, timeoutMs: 5000 },
      { ...base, causedBy: [decisionId] },
    );
    if (!res.success) {
      throw new Error(`coordinator.build: delegate to '${spec.provider}' failed: ${res.error?.message ?? "unknown"}`);
    }
    const out = res.result as { workerId: string; steps: number; toolCalls: number; reason: string };
    workers.push({ workerId: out.workerId, provider: spec.provider, bundle: [...spec.bundle].sort(), steps: out.steps, toolCalls: out.toolCalls, reason: out.reason });
  }
  return { decisionId, workers };
}

/** Register the `coordinator.build` trigger skill on a registry that already has the
 *  `delegate` skill wired (via registerCoreSkills providers OR registerOrchestration
 *  Skills). This is the clean entry point the web client calls to START the build:
 *  one `tools/call` to `coordinator.build` decomposes the goal and delegates all
 *  three workers, leaving their edits HELD for review. Requires `orchestrate`. */
export function registerCottageBuildSkill(registry: SkillRegistry, agents?: AgentRegistry): void {
  registry.register({
    name: "coordinator.build",
    version: "1.0.0",
    description:
      "Decompose 'a cottage on the beach' and delegate it to three least-privilege worker agents " +
      "(Terraform shapes the beach, Builder places the cottage, Decorator scatters palms + driftwood). " +
      "Each worker's mutating edits are HELD for review (approval.list / approval.grant / approval.deny).",
    category: "agent",
    permissions: [ORCHESTRATE_PERMISSION],
    input: z.object({}),
    output: z.object({
      decisionId: z.string(),
      workers: z.array(z.object({
        workerId: z.string(),
        provider: z.string(),
        bundle: z.array(z.string()),
        steps: z.number(),
        toolCalls: z.number(),
        reason: z.string(),
      })),
    }),
    handler: async (_input, ctx) => {
      const base: InvokeBase = {
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        permissions: ctx.permissions,
        profile: COORDINATOR_PROFILE,
        tick: ctx.tick,
        world: ctx.world,
      };
      return await delegateCottageWorkers(registry, base, agents);
    },
  });
}

/** Wire the cottage scenario onto an EXISTING registry/world (the editor host's
 *  authoritative server): register the `delegate` skill + its review gate (composed
 *  with any gate the host already installed) with the three worker providers, then
 *  register the `coordinator.build` trigger. Use when registerCoreSkills was already
 *  called WITHOUT providers (the stock server path). Returns the worker registry +
 *  providers so the host can inspect spawned workers. */
export function installCottageScenario(
  registry: SkillRegistry,
  opts: { world?: WorldContext; agents?: AgentRegistry } = {},
): { providers: ProviderMap; agents: AgentRegistry } {
  const providers = cottageProviders();
  const agents = opts.agents ?? new AgentRegistry();
  registerOrchestrationSkills(registry, { providers, agents, world: opts.world });
  registerCottageBuildSkill(registry, agents);
  return { providers, agents };
}

/** A self-contained headless cottage setup: a fresh world + registry with the core
 *  skills (including `delegate`, wired to the three worker providers), the
 *  `coordinator.build` trigger, and a ready-made coordinator invoke base. The
 *  caller owns the single `op_physics_create_world` for the process. */
export interface CottageSetup {
  registry: SkillRegistry;
  world: WorldContext;
  agents: AgentRegistry;
  tracer: LiminaTracer;
  providers: ProviderMap;
  /** Build a coordinator invoke base at `tick` (profile reviewer.coordinator). */
  coordBase: (tick: number, causedBy?: string[]) => InvokeBase;
  /** Run the whole build as the coordinator at `tick` (default 1): delegate the
   *  three workers; their mutating edits end up HELD. */
  runCottageBuild: (tick?: number) => Promise<{ decisionId: string; workers: CottageWorkerResult[] }>;
}

/** Construct the standalone headless cottage scenario. Does NOT call
 *  op_physics_create_world (the process owns that once); the caller must have. */
export function setupCoordinatorCottage(sessionId = "ses_cottage"): CottageSetup {
  const agents = new AgentRegistry();
  const providers = cottageProviders();
  // createHeadlessContext forwards coreOpts to registerCoreSkills, which wires the
  // delegate skill AND co-installs the delegate review gate (so workers' edits are
  // held); then add the trigger.
  const ctx = createHeadlessContext({ session: sessionId, agents, coreOpts: { providers, agents } });
  const world = ctx.world;
  const registry = ctx.registry;
  const tracer = ctx.tracer;
  registerCottageBuildSkill(registry, agents);

  const coordPerms = resolveProfile(COORDINATOR_PROFILE);
  const coordBase = (tick: number, causedBy?: string[]): InvokeBase => ({
    agentId: "agt_coord", sessionId, permissions: coordPerms, profile: COORDINATOR_PROFILE, tick, world, causedBy,
  });

  const runCottageBuild = (tick = 1) => delegateCottageWorkers(registry, coordBase(tick), agents);

  return { registry, world, agents, tracer, providers, coordBase, runCottageBuild };
}
