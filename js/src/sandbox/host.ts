// limina SandboxedSkillHost — runs UNTRUSTED skill/agent decision code in a
// per-agent QuickJS context (the limina-sandbox crate), OUTSIDE the privileged
// V8 isolate, and bridges its only host surface — host.invoke(cap, argsJson) —
// to the engine's real SkillRegistry.invoke under HOST-BOUND attribution.
//
// Containment (proven by js/test/p4_isolation.ts): the QuickJS context exposes
// standard ECMAScript globals plus the single injected `host` object. There is
// no Deno, no Deno.core.ops, no ECS TypedArrays, no WorldContext — an
// eval/Function-ctor escape only reaches an empty global. CPU/memory/stack
// budgets are enforced in-thread by the runtime (interrupt deadline, memory
// limit, stack cap).
//
// Re-entry: a READ capability is served synchronously from the agent's injected
// perception snapshot (its OWN view, never another agent's private state); a
// MUTATING capability is RECORDED by the sandbox and returned here as an intent,
// which this host drives through SkillRegistry.invoke — the same permissioned,
// audited choke point every trusted action crosses. The untrusted code can never
// reach the registry, an op, or another agent's state directly.

import { z } from "../../build/zod.bundle.mjs";
import { ops } from "../engine.ts";
import type { SkillRegistry, WorldContext } from "../skills/registry.ts";
import { resolveProfile } from "../skills/permissions.ts";
import type { Tracer } from "../observability/event.ts";
import type { PolicyEngine } from "../policy/engine.ts";
import type { MCPResponse } from "../mcp/protocol.ts";

/** The untrusted argsJson a sandbox call carries, validated at the boundary: an
 *  object map of skill inputs. A non-object (array/scalar/garbage) yields an
 *  empty input — the skill schema rejects it downstream. `claimedAgentId` is the
 *  identity the payload tried to assert; it is surfaced for forensic audit and
 *  then IGNORED (attribution is host-bound). */
const untrustedArgsSchema = z.record(z.string(), z.unknown());

export function parseUntrustedArgs(argsJson: string): { input: Record<string, unknown>; claimedAgentId?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(argsJson);
  } catch {
    return { input: {} };
  }
  const parsed = untrustedArgsSchema.safeParse(raw);
  if (!parsed.success) return { input: {} };
  const claimed = parsed.data.agentId;
  return { input: parsed.data, claimedAgentId: typeof claimed === "string" ? claimed : undefined };
}

export interface SandboxBudgets {
  /** Per-agent memory budget; an OOM is a catchable error, the host survives. */
  memLimitBytes?: number;
  /** Per-decision CPU budget; a runaway decision is interrupted at the deadline. */
  cpuDeadlineMs?: number;
  /** Stack cap; deep recursion throws "stack size exceeded" instead of aborting. */
  maxStackBytes?: number;
  /** Capabilities served synchronously from the injected perception snapshot. */
  readCaps?: string[];
}

const DEFAULT_BUDGETS: Required<SandboxBudgets> = {
  memLimitBytes: 16 * 1024 * 1024,
  cpuDeadlineMs: 50,
  maxStackBytes: 256 * 1024,
  readCaps: ["perception", "agent.getPerception", "ecs.getSelfPosition"],
};

/** A mutating-capability intent the untrusted decision recorded via host.invoke. */
export interface CapabilityCall {
  cap: string;
  /** The serialized argument JSON the untrusted code passed. */
  args: string;
}

/** The JSON envelope op_sandbox_eval returns: the eval outcome plus the recorded
 *  mutating intents and the boundary-crossing counts (the audit signal). */
export interface SandboxEvalResult {
  ok: boolean;
  value?: string;
  error?: string;
  calls: CapabilityCall[];
  crossings: number;
  reads: number;
}

/** One audited boundary crossing: what the untrusted code asked for, what the
 *  registry decided, and the HOST-BOUND identity it was attributed to. */
export interface CrossingAudit {
  cap: string;
  success: boolean;
  /** True when the registry refused for lack of a permission grant. */
  denied: boolean;
  /** Registry error code on failure (forbidden / not_found / invalid_input / ...). */
  code?: string;
  reason?: string;
  /** The agentId the untrusted payload tried to claim (forensics; IGNORED). */
  claimedAgentId?: string;
  /** The identity the crossing was actually attributed to (host-bound). */
  attributedTo: string;
  /** The audit trace event id this crossing emitted. */
  eventId: string;
}

export interface DecisionResult {
  /** Whether the untrusted decision itself ran to completion (vs interrupt/OOM/crash). */
  ok: boolean;
  error?: string;
  crossings: CrossingAudit[];
  executed: number;
  denied: number;
}

interface SandboxEntry {
  handle: number;
  agentId: string;
  sessionId: string;
  profile: string;
  cpuDeadlineMs: number;
  memLimitBytes: number;
}

export interface SandboxSpec {
  agentId: string;
  sessionId: string;
  /** Permission profile name resolved HOST-SIDE for every crossing. */
  profile: string;
  /** Untrusted decision source; must define a global `decide()`. */
  code: string;
}

export class SandboxedSkillHost {
  private readonly entries = new Map<string, SandboxEntry>();

  /** The dynamic policy engine (M7). When attached it governs every sandbox
   *  crossing (via the shared registry) AND receives the per-decision CPU/memory
   *  charge from the M6 sandbox knobs, so resource budgets really deny. */
  private policy?: PolicyEngine;

  constructor(
    private readonly registry: SkillRegistry,
    private readonly tracer: Tracer,
    policy?: PolicyEngine,
  ) {
    this.policy = policy;
    if (policy !== undefined) this.registry.setPolicy(policy);
  }

  /** Attach the policy engine that governs sandbox crossings + resource budgets.
   *  Also installs it on the shared registry so the bridge's invoke is policy-checked. */
  setPolicy(policy: PolicyEngine): void {
    this.policy = policy;
    this.registry.setPolicy(policy);
  }

  /** Create a QuickJS sandbox for an untrusted agent and load its decision code.
   *  The code runs in the fresh context (defining `decide`); a load failure is
   *  surfaced (and the sandbox torn down) rather than silently swallowed. */
  create(spec: SandboxSpec, budgets: SandboxBudgets = {}): void {
    if (this.entries.has(spec.agentId)) {
      throw new Error(`sandbox already exists for agent ${spec.agentId}`);
    }
    const b = { ...DEFAULT_BUDGETS, ...budgets };
    const handle = ops.op_sandbox_create(b.memLimitBytes, b.maxStackBytes, JSON.stringify(b.readCaps));
    this.entries.set(spec.agentId, {
      handle,
      agentId: spec.agentId,
      sessionId: spec.sessionId,
      profile: spec.profile,
      cpuDeadlineMs: b.cpuDeadlineMs,
      memLimitBytes: b.memLimitBytes,
    });
    // Load with no deadline (defining decide() is trusted setup, not a decision).
    const loaded = this.evalRaw(spec.agentId, spec.code, { deadlineMs: 0 });
    if (!loaded.ok) {
      this.destroy(spec.agentId);
      throw new Error(`sandbox decision code failed to load for ${spec.agentId}: ${loaded.error ?? "unknown"}`);
    }
  }

  /** Destroy a sandbox and free its QuickJS context. Returns whether one existed. */
  destroy(agentId: string): boolean {
    const e = this.entries.get(agentId);
    if (e === undefined) return false;
    this.entries.delete(agentId);
    return ops.op_sandbox_destroy(e.handle);
  }

  has(agentId: string): boolean {
    return this.entries.has(agentId);
  }

  /** Live QuickJS contexts (host-side count is authoritative; the op cross-checks). */
  liveCount(): number {
    return ops.op_sandbox_count();
  }

  /** Evaluate arbitrary untrusted code in the sandbox (probe/diagnostic path).
   *  Used by the containment tests to drive the malicious escapes; the recorded
   *  capability intents and crossing counts come back in the envelope. */
  evalRaw(agentId: string, code: string, opts: { deadlineMs?: number; perceptionJson?: string } = {}): SandboxEvalResult {
    const e = this.entry(agentId);
    const raw = ops.op_sandbox_eval(e.handle, code, opts.perceptionJson ?? "null", opts.deadlineMs ?? 0);
    return JSON.parse(raw) as SandboxEvalResult;
  }

  /** Run the untrusted `decide()` for one decision against `perception`, under the
   *  agent's CPU deadline. Returns the recorded mutating intents WITHOUT touching
   *  the registry — the caller (runDecision, or the agent action system via
   *  SandboxedProvider) drives them. Reads inside decide() resolve against the
   *  injected perception snapshot. */
  produceCalls(agentId: string, perception: unknown): SandboxEvalResult {
    const e = this.entry(agentId);
    const raw = ops.op_sandbox_eval(e.handle, "decide()", JSON.stringify(perception ?? null), e.cpuDeadlineMs);
    return JSON.parse(raw) as SandboxEvalResult;
  }

  /** THE BRIDGE. Run the untrusted decision, then drive each recorded MUTATING
   *  capability call through the REAL SkillRegistry.invoke under HOST-BOUND
   *  { agentId, sessionId, permissions }. A spoofed agentId/sessionId in the
   *  untrusted payload is IGNORED (attribution comes from the AgentRecord, never
   *  the payload). Every crossing is audited via the tracer (the M8 trail):
   *  `sandbox.capability.invoked` on success, `sandbox.capability.denied` on a
   *  refusal/failure. */
  async runDecision(
    agentId: string,
    ctx: { perception: unknown; world: WorldContext; tick: number; causedBy?: string[] },
  ): Promise<DecisionResult> {
    const e = this.entry(agentId);
    const ev = this.produceCalls(agentId, ctx.perception);
    const crossings: CrossingAudit[] = [];
    let executed = 0;
    let denied = 0;

    // Tie the M6 sandbox knobs to the M7 resource budget: each decision burns up
    // to its CPU deadline and peaks at its memory cap; charging them here makes the
    // engine's budget.cpu / budget.mem rules deny once a session's budget is spent.
    this.policy?.charge(e.sessionId, { cpuMs: e.cpuDeadlineMs, memBytes: e.memLimitBytes });

    if (!ev.ok) {
      // The decision itself was contained (interrupt / OOM / crash). NOTHING
      // crosses the boundary; record the containment for audit.
      this.tracer.emit({
        type: "sandbox.decision.contained",
        actorId: e.agentId,
        threadId: e.sessionId,
        parentEventId: null,
        causedBy: ctx.causedBy ?? [],
        payload: { error: ev.error ?? null, tick: ctx.tick, crossings: ev.crossings },
      });
      return { ok: false, error: ev.error, crossings, executed, denied };
    }

    for (const call of ev.calls) {
      const { input, claimedAgentId } = parseUntrustedArgs(call.args);

      // HOST-BOUND attribution — never read from the untrusted payload.
      const res: MCPResponse = await this.registry.invoke(call.cap, input, {
        agentId: e.agentId,
        sessionId: e.sessionId,
        permissions: resolveProfile(e.profile),
        profile: e.profile,
        tick: ctx.tick,
        world: ctx.world,
        causedBy: ctx.causedBy,
      });

      const eventId = this.tracer.emit({
        type: res.success ? "sandbox.capability.invoked" : "sandbox.capability.denied",
        actorId: e.agentId, // HOST-BOUND
        threadId: e.sessionId, // HOST-BOUND
        parentEventId: null,
        causedBy: [...(ctx.causedBy ?? []), ...(res.metadata?.eventsEmitted ?? [])],
        payload: {
          cap: call.cap,
          ok: res.success,
          attributedTo: e.agentId,
          claimedAgentId: claimedAgentId ?? null,
          code: res.success ? null : (res.error?.code ?? null),
          sandbox: e.handle,
          tick: ctx.tick,
        },
      });

      crossings.push({
        cap: call.cap,
        success: res.success,
        denied: !res.success && res.error?.code === "forbidden",
        code: res.success ? undefined : res.error?.code,
        reason: res.success ? undefined : res.error?.message,
        claimedAgentId,
        attributedTo: e.agentId,
        eventId,
      });
      if (res.success) executed++;
      else denied++;
    }

    return { ok: true, crossings, executed, denied };
  }

  private entry(agentId: string): SandboxEntry {
    const e = this.entries.get(agentId);
    if (e === undefined) throw new Error(`no sandbox for agent ${agentId}`);
    return e;
  }
}
