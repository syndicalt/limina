// limina DYNAMIC POLICY ENGINE (Phase 4b / M7) — the contextual authority that
// replaces static profile allow-lists at the non-bypassable boundaries.
//
// A profile is now ONE policy INPUT (the engine subsumes the static allow-lists),
// alongside QUOTAS (deny the N+1th call in a sliding window), REVOCATION (revoke a
// capability mid-session -> the next call is denied), and RESOURCE BUDGETS (a
// per-session ledger of calls / CPU-ms / memory-bytes, the CPU/mem dimensions tied
// to the M6 sandbox knobs). Every crossing — at SkillRegistry.invoke, the sandbox
// host bridge, session admission, and package load — calls `evaluate`/`admitSession`/
// `admitPackage` and gets a DECISION carrying the RULE that fired, a human reason,
// the salient CONTEXT values, and the live quota/budget snapshot. The decision is
// what the M8 audit surface records and explains.
//
// Deny-overrides, fail-closed ordering (the FIRST matching deny wins):
//   1. session admission revoked      -> session.revoked
//   2. capability/agent revoked       -> revoked
//   3. profile does not grant the cap -> profile.denied   (a permission denial)
//   4. quota window exhausted         -> quota.exceeded
//   5. resource budget exhausted      -> budget.calls / budget.cpu / budget.mem
//   6. otherwise                      -> allow (profile.grant) and COMMIT usage
//
// Falsifiability: stub `evaluate` to always-allow and the quota/revocation/budget
// denials vanish — the M7 test asserts those denials, so the stub fails the suite.

import { PERMISSION_PROFILES } from "../skills/permissions.ts";

export type PolicyBoundary = "registry" | "sandbox" | "session" | "package";

export type PolicyRule =
  | "profile.grant"
  | "session.admitted"
  | "package.admitted"
  | "profile.denied"
  | "revoked"
  | "session.revoked"
  | "quota.exceeded"
  | "budget.calls"
  | "budget.cpu"
  | "budget.mem"
  | "package.overclaim"
  | "package.revoked"
  | "profile.unknown";

/** The full input to a policy evaluation: who, what, in which profile, with which
 *  grants, at which boundary. The engine reads ONLY this — never ambient state. */
export interface PolicyContext {
  boundary: PolicyBoundary;
  agentId: string;
  sessionId: string;
  /** capability/tool/skill (registry+sandbox); "" for session; package id for package. */
  cap: string;
  /** profile name — a policy INPUT (subsumes the static profile allow-list). */
  profile?: string;
  /** permissions GRANTED to the caller (the resolved profile set). */
  permissions?: ReadonlySet<string>;
  /** permissions the cap REQUIRES (a skill's `permissions`). */
  requiredPermissions?: readonly string[];
  /** capabilities a package DECLARES it needs (package boundary). */
  declaredCaps?: readonly string[];
  /** capabilities a package is GRANTED (package boundary). */
  grantedCaps?: readonly string[];
  tick?: number;
  args?: unknown;
  /** package provenance, when the crossing originates from a loaded package. */
  pkg?: string;
}

export interface QuotaState {
  key: string;
  limit: number;
  windowMs: number;
  /** hits already counted in the current window (BEFORE this call committed). */
  used: number;
  remaining: number;
}

export interface BudgetDim {
  used: number;
  limit: number;
}

export interface BudgetState {
  calls?: BudgetDim;
  cpuMs?: BudgetDim;
  memBytes?: BudgetDim;
}

export interface PolicyDecision {
  allow: boolean;
  rule: PolicyRule;
  reason: string;
  boundary: PolicyBoundary;
  /** The salient context values that drove the decision (recorded for audit). */
  context: {
    agentId: string;
    sessionId: string;
    cap: string;
    profile?: string;
    package?: string;
    tick?: number;
    requiredPermissions?: string[];
  };
  quota?: QuotaState;
  budget?: BudgetState;
  /** True when the deny is a profile/permission denial (the registry then ALSO
   *  emits `security.permission.denied`, preserving the M6 audit semantics). */
  permissionDenial?: boolean;
}

/** A quota rule. The first rule (registration order) whose `cap` matches the
 *  crossing applies. `cap` undefined matches any capability. */
export interface QuotaSpec {
  cap?: string;
  /** Counter scope: per session (default) or global across sessions. */
  perSession?: boolean;
  limit: number;
  windowMs: number;
}

/** A per-session resource budget. Any dimension left undefined is unbounded. */
export interface BudgetSpec {
  calls?: number;
  cpuMs?: number;
  memBytes?: number;
}

export interface PolicyEngineOptions {
  /** Override/extend the profile -> permission map (defaults to PERMISSION_PROFILES). */
  profiles?: Record<string, readonly string[]>;
  /** Quota rules evaluated in order; first cap match applies. */
  quotas?: QuotaSpec[];
  /** Per-session budgets, keyed by sessionId. */
  budgets?: Record<string, BudgetSpec>;
  /** Maximum concurrently-admitted sessions (a session-admission quota). */
  maxSessions?: number;
}

interface BudgetLedger {
  spec: BudgetSpec;
  calls: number;
  cpuMs: number;
  memBytes: number; // peak
}

export class PolicyEngine {
  private readonly profiles = new Map<string, Set<string>>();
  private readonly quotaRules: QuotaSpec[] = [];
  /** sliding-window hit timestamps, keyed `${cap}::${scope}`. */
  private readonly quotaHits = new Map<string, number[]>();
  /** revoked single capabilities, keyed `${sessionId}::${cap}`. */
  private readonly revokedCaps = new Set<string>();
  /** sessions whose every capability is revoked (or admission revoked). */
  private readonly revokedSessions = new Set<string>();
  /** packages revoked from loading, by package id. */
  private readonly revokedPackages = new Set<string>();
  private readonly budgets = new Map<string, BudgetLedger>();
  private readonly admittedSessions = new Set<string>();
  private readonly maxSessions: number;

  constructor(opts: PolicyEngineOptions = {}) {
    const profiles = opts.profiles ?? PERMISSION_PROFILES;
    for (const [name, perms] of Object.entries(profiles)) {
      this.profiles.set(name, new Set(perms));
    }
    for (const q of opts.quotas ?? []) this.quotaRules.push({ perSession: true, ...q });
    for (const [sid, spec] of Object.entries(opts.budgets ?? {})) {
      this.budgets.set(sid, { spec, calls: 0, cpuMs: 0, memBytes: 0 });
    }
    this.maxSessions = opts.maxSessions ?? Number.POSITIVE_INFINITY;
  }

  // ---- configuration (the contextual knobs) --------------------------------

  /** Add a quota rule. Returns `this` for chaining. */
  setQuota(spec: QuotaSpec): this {
    this.quotaRules.push({ perSession: true, ...spec });
    return this;
  }

  /** Set (or replace) a per-session resource budget. */
  setBudget(sessionId: string, spec: BudgetSpec): this {
    const existing = this.budgets.get(sessionId);
    this.budgets.set(sessionId, { spec, calls: existing?.calls ?? 0, cpuMs: existing?.cpuMs ?? 0, memBytes: existing?.memBytes ?? 0 });
    return this;
  }

  /** Revoke a single capability for a session — the NEXT call to it is denied. */
  revoke(sessionId: string, cap: string): this {
    this.revokedCaps.add(`${sessionId}::${cap}`);
    return this;
  }

  /** Restore a previously-revoked capability. */
  restore(sessionId: string, cap: string): this {
    this.revokedCaps.delete(`${sessionId}::${cap}`);
    return this;
  }

  /** Revoke an ENTIRE session — every capability denied AND admission refused. */
  revokeSession(sessionId: string): this {
    this.revokedSessions.add(sessionId);
    return this;
  }

  /** Revoke a package from loading (a later admitPackage is denied). */
  revokePackage(pkg: string): this {
    this.revokedPackages.add(pkg);
    return this;
  }

  /** Register/replace a profile -> permission grant (profile is a policy input). */
  setProfile(name: string, perms: readonly string[]): this {
    this.profiles.set(name, new Set(perms));
    return this;
  }

  // ---- the boundary decision (registry + sandbox capability crossings) ------

  /** Decide a capability crossing. On ALLOW, COMMITS the quota hit + budget call
   *  (so the N+1th really exhausts the quota and the ledger advances). On DENY,
   *  nothing is committed (a refused call does not consume the caller's quota). */
  evaluate(ctx: PolicyContext): PolicyDecision {
    const base = this.baseDecision(ctx);

    // 1. whole-session revocation.
    if (this.revokedSessions.has(ctx.sessionId)) {
      return { ...base, allow: false, rule: "session.revoked", reason: `session ${ctx.sessionId} is revoked` };
    }
    // 2. single-capability revocation.
    if (this.revokedCaps.has(`${ctx.sessionId}::${ctx.cap}`)) {
      return { ...base, allow: false, rule: "revoked", reason: `capability '${ctx.cap}' revoked for session ${ctx.sessionId}` };
    }
    // 3. profile grant (the subsumed static check).
    const granted = this.grantedSet(ctx);
    const missing = (ctx.requiredPermissions ?? []).find((p) => !granted.has(p));
    if (missing !== undefined) {
      return {
        ...base,
        allow: false,
        rule: "profile.denied",
        reason: `missing permission: ${missing}`,
        permissionDenial: true,
      };
    }
    // 4. quota (peek; commit only if the whole decision allows).
    const quota = this.quotaPeek(ctx);
    if (quota !== undefined && quota.remaining <= 0) {
      return { ...base, allow: false, rule: "quota.exceeded", reason: `quota exhausted for '${quota.key}' (${quota.used}/${quota.limit} per ${quota.windowMs}ms)`, quota };
    }
    // 5. resource budget (peek).
    const ledger = this.budgets.get(ctx.sessionId);
    const budget = ledger !== undefined ? this.budgetState(ledger) : undefined;
    if (ledger !== undefined) {
      const overCalls = ledger.spec.calls !== undefined && ledger.calls >= ledger.spec.calls;
      const overCpu = ledger.spec.cpuMs !== undefined && ledger.cpuMs >= ledger.spec.cpuMs;
      const overMem = ledger.spec.memBytes !== undefined && ledger.memBytes >= ledger.spec.memBytes;
      if (overCalls) return { ...base, allow: false, rule: "budget.calls", reason: `call budget exhausted (${ledger.calls}/${ledger.spec.calls})`, quota, budget };
      if (overCpu) return { ...base, allow: false, rule: "budget.cpu", reason: `CPU budget exhausted (${ledger.cpuMs}/${ledger.spec.cpuMs} ms)`, quota, budget };
      if (overMem) return { ...base, allow: false, rule: "budget.mem", reason: `memory budget exhausted (${ledger.memBytes}/${ledger.spec.memBytes} bytes)`, quota, budget };
    }

    // 6. ALLOW — commit the quota hit and the call against the budget.
    const committedQuota = this.quotaCommit(ctx);
    if (ledger !== undefined) ledger.calls += 1;
    return {
      ...base,
      allow: true,
      rule: "profile.grant",
      reason: ctx.requiredPermissions && ctx.requiredPermissions.length > 0
        ? `profile '${ctx.profile ?? "(grants)"}' grants ${ctx.requiredPermissions.join(", ")}`
        : `profile '${ctx.profile ?? "(grants)"}' permits '${ctx.cap}'`,
      quota: committedQuota ?? quota,
      budget: ledger !== undefined ? this.budgetState(ledger) : undefined,
    };
  }

  // ---- session admission (the transport boundary) --------------------------

  /** Decide whether a session may be admitted (initialize). Denied when the
   *  session is revoked, the profile is unknown, or the concurrent-session quota
   *  is full. On allow, the session is marked admitted (for the session quota). */
  admitSession(ctx: PolicyContext): PolicyDecision {
    const base = this.baseDecision({ ...ctx, boundary: "session" });
    if (this.revokedSessions.has(ctx.sessionId)) {
      return { ...base, allow: false, rule: "session.revoked", reason: `session ${ctx.sessionId} is revoked` };
    }
    if (ctx.profile !== undefined && !this.profiles.has(ctx.profile)) {
      return { ...base, allow: false, rule: "profile.unknown", reason: `unknown profile '${ctx.profile}'`, permissionDenial: true };
    }
    if (!this.admittedSessions.has(ctx.sessionId) && this.admittedSessions.size >= this.maxSessions) {
      return { ...base, allow: false, rule: "quota.exceeded", reason: `session admission quota full (${this.admittedSessions.size}/${this.maxSessions})` };
    }
    this.admittedSessions.add(ctx.sessionId);
    return { ...base, allow: true, rule: "session.admitted", reason: `session admitted under profile '${ctx.profile ?? "(none)"}'` };
  }

  /** Release an admitted session (frees a session-quota slot on disconnect). */
  releaseSession(sessionId: string): void {
    this.admittedSessions.delete(sessionId);
  }

  // ---- package load (the M9 hook) ------------------------------------------

  /** The package-load policy hook M9 calls. Denies a revoked package or one that
   *  DECLARES a capability it was not GRANTED (a capability over-claim). */
  admitPackage(ctx: PolicyContext): PolicyDecision {
    const base = this.baseDecision({ ...ctx, boundary: "package" });
    const pkg = ctx.pkg ?? ctx.cap;
    if (this.revokedPackages.has(pkg)) {
      return { ...base, allow: false, rule: "package.revoked", reason: `package '${pkg}' is revoked` };
    }
    const grantedCaps = new Set(ctx.grantedCaps ?? []);
    const overclaim = (ctx.declaredCaps ?? []).find((c) => !grantedCaps.has(c));
    if (overclaim !== undefined) {
      return { ...base, allow: false, rule: "package.overclaim", reason: `package '${pkg}' declares ungranted capability '${overclaim}'` };
    }
    return { ...base, allow: true, rule: "package.admitted", reason: `package '${pkg}' admitted (${(ctx.declaredCaps ?? []).length} declared caps within grant)` };
  }

  // ---- resource accounting (the sandbox host charges these knobs) -----------

  /** Charge CPU-ms and/or peak-memory against a session's budget ledger. The M6
   *  sandbox host calls this with its per-decision CPU deadline and memory cap so
   *  the engine's budget.cpu / budget.mem rules are tied to the real sandbox knobs.
   *  cpuMs accumulates; memBytes tracks the peak. */
  charge(sessionId: string, usage: { cpuMs?: number; memBytes?: number }): void {
    let ledger = this.budgets.get(sessionId);
    if (ledger === undefined) {
      ledger = { spec: {}, calls: 0, cpuMs: 0, memBytes: 0 };
      this.budgets.set(sessionId, ledger);
    }
    if (usage.cpuMs !== undefined) ledger.cpuMs += usage.cpuMs;
    if (usage.memBytes !== undefined) ledger.memBytes = Math.max(ledger.memBytes, usage.memBytes);
  }

  /** Current budget ledger snapshot for a session (for the M8 usage query). */
  usage(sessionId: string): BudgetState | undefined {
    const ledger = this.budgets.get(sessionId);
    return ledger === undefined ? undefined : this.budgetState(ledger);
  }

  /** Whether a session is currently admitted (session-quota inspection). */
  isAdmitted(sessionId: string): boolean {
    return this.admittedSessions.has(sessionId);
  }

  // ---- internals -----------------------------------------------------------

  private baseDecision(ctx: PolicyContext): PolicyDecision {
    return {
      allow: false,
      rule: "profile.denied",
      reason: "",
      boundary: ctx.boundary,
      context: {
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        cap: ctx.cap,
        profile: ctx.profile,
        package: ctx.pkg,
        tick: ctx.tick,
        requiredPermissions: ctx.requiredPermissions ? [...ctx.requiredPermissions] : undefined,
      },
    };
  }

  private grantedSet(ctx: PolicyContext): ReadonlySet<string> {
    if (ctx.permissions !== undefined) return ctx.permissions;
    if (ctx.profile !== undefined) return this.profiles.get(ctx.profile) ?? new Set();
    return new Set();
  }

  private matchingQuota(ctx: PolicyContext): { spec: QuotaSpec; key: string } | undefined {
    for (const spec of this.quotaRules) {
      if (spec.cap !== undefined && spec.cap !== ctx.cap) continue;
      const scope = spec.perSession === false ? "*" : ctx.sessionId;
      const cap = spec.cap ?? ctx.cap;
      return { spec, key: `${cap}::${scope}` };
    }
    return undefined;
  }

  private quotaPeek(ctx: PolicyContext): QuotaState | undefined {
    const match = this.matchingQuota(ctx);
    if (match === undefined) return undefined;
    const used = this.windowHits(match.key, match.spec.windowMs).length;
    return { key: match.key, limit: match.spec.limit, windowMs: match.spec.windowMs, used, remaining: Math.max(0, match.spec.limit - used) };
  }

  private quotaCommit(ctx: PolicyContext): QuotaState | undefined {
    const match = this.matchingQuota(ctx);
    if (match === undefined) return undefined;
    const hits = this.windowHits(match.key, match.spec.windowMs);
    hits.push(Date.now());
    this.quotaHits.set(match.key, hits);
    return { key: match.key, limit: match.spec.limit, windowMs: match.spec.windowMs, used: hits.length, remaining: Math.max(0, match.spec.limit - hits.length) };
  }

  /** Prune hits older than the window and return the live (in-window) hits. */
  private windowHits(key: string, windowMs: number): number[] {
    const cutoff = Date.now() - windowMs;
    const hits = (this.quotaHits.get(key) ?? []).filter((t) => t > cutoff);
    this.quotaHits.set(key, hits);
    return hits;
  }

  private budgetState(ledger: BudgetLedger): BudgetState {
    const out: BudgetState = {};
    if (ledger.spec.calls !== undefined) out.calls = { used: ledger.calls, limit: ledger.spec.calls };
    if (ledger.spec.cpuMs !== undefined) out.cpuMs = { used: ledger.cpuMs, limit: ledger.spec.cpuMs };
    if (ledger.spec.memBytes !== undefined) out.memBytes = { used: ledger.memBytes, limit: ledger.spec.memBytes };
    return out;
  }
}

/** The tracer event TYPE for a decision: `policy.decision` (allow) / `policy.denied`. */
export function policyEventType(d: PolicyDecision): string {
  return d.allow ? "policy.decision" : "policy.denied";
}

/** The recorded payload for a decision — the M8 audit reads `rule`/`reason`/
 *  `context`/`quota`/`budget` straight back out of this. */
export function policyEventPayload(d: PolicyDecision): Record<string, unknown> {
  return {
    boundary: d.boundary,
    cap: d.context.cap,
    allow: d.allow,
    rule: d.rule,
    reason: d.reason,
    agentId: d.context.agentId,
    sessionId: d.context.sessionId,
    profile: d.context.profile ?? null,
    package: d.context.package ?? null,
    requiredPermissions: d.context.requiredPermissions ?? null,
    tick: d.context.tick ?? null,
    quota: d.quota ?? null,
    budget: d.budget ?? null,
  };
}
