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

/** Capabilities a worker BUNDLE may never contain — they would let a worker escape
 *  review (approval.review -> self-approve its own held edits) or fan out unbounded
 *  (orchestrate -> spawn further workers). Coordinators hold these; workers never. */
const ESCALATION_CAPS = new Set(["approval.review", "orchestrate"]);

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
      // Fail-closed on a privilege-escalation bundle (self-approval / unbounded
      // recursion) BEFORE spawning anything.
      const escalating = input.bundle.find((c) => ESCALATION_CAPS.has(c));
      if (escalating !== undefined) {
        throw new Error(`delegate: a worker bundle may not contain the escalation capability '${escalating}'`);
      }
      const providerName = input.provider ?? deps.defaultProvider;
      if (providerName === undefined || deps.providers[providerName] === undefined) {
        throw new Error(`delegate: no provider '${providerName ?? "(unset)"}' available`);
      }
      const world = ctx.world ?? deps.world;
      if (world === undefined) throw new Error("delegate: no world available for the worker loop");

      // Deterministic worker identity: the coordinator id + a monotonic counter.
      const workerId = `${ctx.agentId}.w${++workerSeq}`;
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
        steps: result.steps,
        toolCalls: result.toolCalls,
        reason: result.reason,
      });

      return { workerId, steps: result.steps, toolCalls: result.toolCalls, reason: result.reason };
    },
  });
}

// ---- Known limitations / follow-ups (first cut) --------------------------
// 1. Escalation caps (approval.review, orchestrate) are denied in worker bundles, so
//    nesting depth is bounded to 1 (workers can't delegate). A depth COUNTER (for
//    intentional multi-level delegation) is a later extension.
// 2. The `permissions: []` trace skills (trace.tail / trace.explainEvent / trace.export
//    in skills/system.ts) are advertised to every worker regardless of bundle — a
//    delegated worker can read the cross-agent trace and trace.export can write disk.
//    Pre-existing, but delegation newly exposes it to scoped/untrusted workers; gate
//    the trace surface behind a read capability as a governance follow-up.
// 3. A granted action re-applies with the WORKER's propose-time authority + tick (the
//    inherited Phase 7 approval limitation — see skills/approval.ts).
