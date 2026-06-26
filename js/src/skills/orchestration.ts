// Coordinator / delegate orchestration (Phase 10 chunk C). A coordinator agent
// (holding `orchestrate`) decomposes a goal and DELEGATES bounded tasks to worker
// agents, each spawned with a scoped, least-privilege capability BUNDLE. A worker
// is automatically least-privilege: its bundle governs BOTH what it SEES
// (registry.list) and what it can INVOKE (InvokeBase.permissions) via agentGrants.
//
// REVIEW: a delegated worker is marked "under review" by running under the
// dedicated marker profile `delegate.review` (DELEGATE_REVIEW_PROFILE). Its grants
// still come from its bundle (agentGrants prefers the bundle over the profile); the
// profile is purely the review FLAG the approval gate keys on. Install
// `reviewProfileGate(new Set([DELEGATE_REVIEW_PROFILE]))` and every MUTATING edit a
// worker proposes is HELD (no world change) and surfaced as `skill.approval.pending`
// for the coordinator (an `orchestrate` + `approval.review` holder) to grant or deny
// through the existing approval.* skills — the Phase 7 seam, now driven by a
// coordinator agent instead of a human.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillRegistry, WorldContext } from "./registry.ts";
import { reviewProfileGate } from "./approval.ts";
import { AgentRegistry } from "../agents/agent.ts";
import { type BoundedMultiTurnOptions, type ProviderMap, runBoundedMultiTurn } from "../agents/systems.ts";

/** Capability a worker BUNDLE may NEVER contain at ANY depth — it would let a worker
 *  escape review by self-approving its own held edits. Coordinators hold it; workers
 *  never. (`orchestrate` is the OTHER escalation cap, but it is gated by DEPTH rather
 *  than denied outright — see the handler's depth-budget check.) */
const SELF_APPROVAL_CAP = "approval.review";

/** Capability a coordinator session must hold to delegate work. */
export const ORCHESTRATE_PERMISSION = "orchestrate";

/** Marker profile a delegated worker runs under so the review gate HOLDS its
 *  mutating edits. The worker's real capabilities come from its bundle
 *  (agentGrants prefers the bundle); this profile string is ONLY the review flag. */
export const DELEGATE_REVIEW_PROFILE = "delegate.review";

/** Dependencies the delegate skill closes over (the provider map is the only hard
 *  requirement; the rest are optional wiring/back-stops like other stateful skills). */
export interface OrchestrationDeps {
  /** The LLM providers a delegated worker can run under (keyed by provider name). */
  providers: ProviderMap;
  /** Where to register spawned workers (so they are inspectable). A fresh,
   *  self-contained registry is used when omitted. */
  agents?: AgentRegistry;
  /** Fallback world for the worker loop when an invocation supplies none. */
  world?: WorldContext;
  /** Provider used when a delegate call does not name one. */
  defaultProvider?: string;
  /** Maximum delegation NESTING depth. The top coordinator delegates at depth 0
   *  (spawning depth-1 workers); a worker may itself hold `orchestrate` (and thus
   *  delegate) only while the worker it would spawn stays within this budget.
   *  DEFAULT 1 = exactly today's behavior: only the top coordinator delegates and
   *  no worker bundle may contain `orchestrate` (nesting blocked at depth 1). */
  maxDepth?: number;
}

const delegateInput = z.object({
  /** The worker's goal — becomes its llm.systemPrompt. */
  task: z.string().min(1),
  /** The worker's least-privilege capability set (scopes exposure AND invocation). */
  bundle: z.array(z.string()).min(1),
  /** Worker kind (default builder). */
  type: z.enum(["builder", "player"]).default("builder"),
  /** Provider name for the worker loop (falls back to deps.defaultProvider). */
  provider: z.string().optional(),
  maxSteps: z.number().int().positive().max(256).default(4),
  maxToolCalls: z.number().int().positive().max(256).default(4),
  timeoutMs: z.number().int().positive().max(600000).default(5000),
  maxTokens: z.number().int().positive().optional(),
});

/** Register the `delegate` skill. Closes over the provider map + (optional)
 *  worker registry, mirroring the other stateful skill registrars. */
export function registerOrchestrationSkills(registry: SkillRegistry, deps: OrchestrationDeps): void {
  const workers = deps.agents ?? new AgentRegistry();
  let workerSeq = 0;
  const maxDepth = deps.maxDepth ?? 1;
  // Per-agent delegation depth. The top coordinator is absent -> depth 0; each worker
  // it spawns is recorded at its parent's depth + 1. A worker may be granted
  // `orchestrate` (and so delegate) only while the worker IT would spawn stays inside
  // the budget — see the handler's depth check.
  const depthOf = new Map<string, number>();

  // Co-install the review gate so a delegated worker's MUTATING edits are HELD for
  // the coordinator — this is the security contract of delegation, so it must be
  // wired with the surface, not left to the host. COMPOSED (not clobbering) any gate
  // the host already set (e.g. a human-review gate).
  registry.addApprovalGate(reviewProfileGate(new Set([DELEGATE_REVIEW_PROFILE])));

  registry.register({
    name: "delegate",
    version: "1.0.0",
    description:
      "Delegate a bounded task to a fresh least-privilege worker agent scoped to `bundle`, " +
      "running it under review. The worker's MUTATING edits are HELD by the approval gate for " +
      "the coordinator to grant/deny. Returns the worker id and its run outcome.",
    category: "agent",
    permissions: [ORCHESTRATE_PERMISSION],
    input: delegateInput,
    output: z.object({
      workerId: z.string(),
      steps: z.number(),
      toolCalls: z.number(),
      reason: z.string(),
    }),
    handler: async (input, ctx) => {
      const depth = depthOf.get(ctx.agentId) ?? 0;
      const childDepth = depth + 1;
      // Fail-closed BEFORE spawning anything. (1) `approval.review` is ALWAYS denied —
      // a worker holding it would self-approve its own held edits, escaping review at
      // any depth. (2) `orchestrate` is gated by the DEPTH budget: a worker may itself
      // delegate only while the worker IT would spawn (at childDepth + 1) stays inside
      // maxDepth — i.e. childDepth < maxDepth (equivalently depth + 1 < maxDepth).
      if (input.bundle.includes(SELF_APPROVAL_CAP)) {
        throw new Error(`delegate: a worker bundle may not contain the escalation capability '${SELF_APPROVAL_CAP}' (it would self-approve its own held edits)`);
      }
      if (input.bundle.includes(ORCHESTRATE_PERMISSION) && !(childDepth < maxDepth)) {
        throw new Error(`delegate: a worker at depth ${childDepth} may not be granted '${ORCHESTRATE_PERMISSION}' — delegation depth cap is ${maxDepth} (a depth-${childDepth} worker would spawn at depth ${childDepth + 1})`);
      }
      const providerName = input.provider ?? deps.defaultProvider;
      if (providerName === undefined || deps.providers[providerName] === undefined) {
        throw new Error(`delegate: no provider '${providerName ?? "(unset)"}' available`);
      }
      const world = ctx.world ?? deps.world;
      if (world === undefined) throw new Error("delegate: no world available for the worker loop");

      // Deterministic worker identity: the coordinator id + a monotonic counter.
      const workerId = `${ctx.agentId}.w${++workerSeq}`;
      // Record the worker's nesting depth so IF it holds `orchestrate` its own
      // delegations are budgeted against the same cap (an absent agent is depth 0).
      depthOf.set(workerId, childDepth);
      const worker = workers.add({
        id: workerId,
        type: input.type,
        perceptionRadius: 50,
        decisionIntervalTicks: 1,
        // Least-privilege: the BUNDLE governs exposure + invocation (agentGrants);
        // the review-marker PROFILE only flags the worker for the approval gate.
        profile: DELEGATE_REVIEW_PROFILE,
        bundle: new Set(input.bundle),
        sessionId: workerId,
        llm: { provider: providerName, model: "", systemPrompt: input.task },
      });

      const bounds: BoundedMultiTurnOptions = {
        startTick: ctx.tick,
        maxSteps: input.maxSteps,
        maxToolCalls: input.maxToolCalls,
        timeoutMs: input.timeoutMs,
        maxTokens: input.maxTokens,
      };
      const result = await runBoundedMultiTurn(worker, registry, deps.providers, world, registry.tracer, bounds);

      // Audit the delegation on the coordinator's thread (the spawn record links to
      // the worker by id; the worker's held edits surface on the worker's thread).
      ctx.emit("agent.delegated", {
        workerId,
        type: input.type,
        bundle: [...input.bundle].sort(),
        task: input.task,
        depth: childDepth,
        steps: result.steps,
        toolCalls: result.toolCalls,
        reason: result.reason,
      });

      return { workerId, steps: result.steps, toolCalls: result.toolCalls, reason: result.reason };
    },
  });
}

// ---- Governance status (Phase 10 follow-ups) -----------------------------
// 1. RESOLVED — delegation depth is now a BOUNDED BUDGET (deps.maxDepth, default 1).
//    `approval.review` is still denied in any bundle at any depth (self-approval), but
//    `orchestrate` is gated by depth: a worker may delegate only while the worker it
//    would spawn stays inside maxDepth. Default 1 reproduces the old behavior exactly
//    (workers can't delegate); maxDepth >= 2 enables intentional multi-level nesting.
// 2. RESOLVED — the trace skills (trace.tail / trace.explainEvent / trace.export in
//    skills/system.ts) now require the `trace.read` capability, which only observer
//    profiles (reviewer / reviewer.coordinator / system.readonly) carry. A bundle-
//    scoped `delegate.review` worker has neither, so it can no longer read or export
//    the cross-agent trace.
// 3. RESOLVED (apply-tick provenance) — a granted action's `skill.approval.granted` +
//    `skill.executed` are now stamped with the reviewer's APPLY tick (see skills/
//    registry.ts resolveApproval + skills/approval.ts). Propose-time AUTHORITY is still
//    inherited from the parked base (the worker proposed it); that is by design.
