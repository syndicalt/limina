// limina Skill/Hook Registry — the typed, permissioned path every agent action
// flows through. invoke() is the canonical pipeline: resolve -> Zod validate ->
// permission -> before -> handler -> after -> emit (the MCP callTool is a thin
// wrapper over it).

import { z } from "../../build/zod.bundle.mjs";
import type { CameraLike, EngineOps, EntityTable, SceneLike } from "../engine.ts";
import type { TransformStorage } from "../ecs/facade.ts";
import type { Tracer } from "../observability/event.ts";
import type { MCPResponse, MCPTool } from "../mcp/protocol.ts";
import type { UniformGridSpatialIndex } from "../spatial/index.ts";
import { type PolicyEngine, type PolicyContext, type PolicyDecision, policyEventType, policyEventPayload } from "../policy/engine.ts";

export type SkillCategory = "scene" | "ecs" | "three" | "physics" | "agent" | "system" | "ui" | "social" | "audio" | "terrain" | "world" | "player" | "camera" | "animation" | "interaction" | "inventory" | "game" | "trigger" | "event" | "quest" | "stats" | "damage" | "status" | "combat" | "behavior" | "dialogue" | "nav" | "vfx" | "save" | "progression";

/** Pick the tick to stamp on an APPLY-TIME event. The apply tick (the reviewer's
 *  current tick for an approval-gated action) is used ONLY when it is a finite number
 *  that is NOT BEFORE the propose tick — otherwise we floor at the propose tick. This
 *  guards against "applied before proposed" provenance: an MCP reviewer that never
 *  advanced a sim tick passes tick 0, which must not stamp an action proposed at a
 *  later tick as if it applied at 0. Absent apply tick -> propose tick (back-compat). */
function stampTick(applyTick: number | undefined, proposeTick: number): number {
  return typeof applyTick === "number" && Number.isFinite(applyTick) && applyTick >= proposeTick
    ? applyTick
    : proposeTick;
}

/** Minimal agent-perception lookup (the AgentRegistry implements it) so the
 *  agent.getPerception skill can read the calling agent's perception. */
export interface AgentLookup {
  getPerception(agentId: string): unknown;
  all?(): unknown[];
}

/** Read/write surface a skill handler operates on (built from the Engine). */
export interface WorldContext {
  ecs: unknown; // bitECS world
  transforms?: TransformStorage;
  spatial?: UniformGridSpatialIndex;
  entities: EntityTable;
  tags: Map<number, Set<string>>;
  scene: SceneLike;
  camera: CameraLike;
  ops: EngineOps;
  agents?: AgentLookup;
  renderer?: unknown;
  /** The render-only post-processing pipeline built by `render.enablePost` (a
   *  PostPipeline from render/post.ts). A render loop drives `post.render()` in place of
   *  `renderer.render(...)`. Set by the skill; never sim/log state. */
  post?: unknown;
  width?: number;
  height?: number;
  mode?: "windowed" | "headless";
}

export interface ExecutionContext {
  agentId: string;
  sessionId: string;
  permissions: ReadonlySet<string>;
  tick: number;
  world: WorldContext;
  emit(type: string, payload: unknown, causedBy?: string[]): string;
}

/** Per-invocation inputs the caller supplies; the registry builds `emit`. */
export interface InvokeBase {
  agentId: string;
  sessionId: string;
  permissions: ReadonlySet<string>;
  tick: number;
  world: WorldContext;
  /** Optional causal parents to link `skill.executed` into a trace chain. */
  causedBy?: string[];
  /** The caller's profile name — a policy INPUT (recorded for audit provenance). */
  profile?: string;
  /** Package provenance, when the call originates from a loaded package (M9). */
  pkg?: string;
}

export interface SkillDefinition<I = unknown, O = unknown> {
  name: string;
  version: string;
  description: string;
  category: SkillCategory;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  permissions: string[];
  /** OUTPUT field names the RECORDER commits back into the recorded command's
   *  input, so the replay log PINS authored-resolved identity (e.g. asset.place's
   *  content hash). Each named field must also be an OPTIONAL input field so the
   *  committed value validates on replay. Absent -> nothing committed (default). */
  commitFields?: string[];
  /** Progressive-disclosure tier for the MCP surface. "core" tools are returned in
   *  the BOOTSTRAP list an agent starts with (kept small so a large catalog never
   *  floods the model's tool-reasoning window); "standard"/"advanced" are discovered
   *  on demand via skills.search/browse. Omitted → "core" if the name is in the
   *  registry's DEFAULT_CORE set, else "standard". */
  priority?: "core" | "standard" | "advanced";
  handler(input: I, ctx: ExecutionContext): Promise<O> | O;
  hooks?: {
    before?(input: I, ctx: ExecutionContext): Promise<void> | void;
    after?(result: O, ctx: ExecutionContext): Promise<void> | void;
  };
}

/** Decides whether a validated, policy-approved call is HELD for human approval
 *  instead of applied immediately. Installed via `SkillRegistry.setApprovalGate`;
 *  unset by default, so `invoke()` behaves exactly as before. */
export type ApprovalGate = (skillName: string, base: InvokeBase, skill: SkillDefinition) => boolean;

/** An action held pending approval — the validated, policy-approved intent. */
interface PendingApproval {
  approvalId: string;
  skill: string;
  input: unknown;
  base: InvokeBase;
  createdTick: number;
}

/** A pending approval surfaced to a reviewer/editor (no closures or world ref). */
export interface PendingApprovalView {
  approvalId: string;
  skill: string;
  input: unknown;
  agentId: string;
  sessionId: string;
  profile?: string;
  tick: number;
}

/** Produces the latest definition for a hot-reloadable skill. A real runtime
 *  re-imports the skill module; the returned definition replaces the live one. */
export type SkillSource = () => SkillDefinition | Promise<SkillDefinition>;

/** Rebuilds scene state for a named scene so `dev.reload` can re-run it. */
export type SceneBuilder = (ctx: ExecutionContext) => Promise<SceneBuildSummary> | SceneBuildSummary;

/** What a scene builder reports it (re)created, for reload invalidation. */
export interface SceneBuildSummary {
  scene: string;
  entities?: number;
  [key: string]: unknown;
}

/** Outcome of a live reload — honest about success and what was invalidated. */
export interface ReloadResult {
  ok: boolean;
  invalidated: string[];
  reason?: string;
  summary?: Record<string, unknown>;
}

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();
  /** Memoized `list()` output — z.toJSONSchema per skill is ~ms-expensive and
   *  identical until the skill set changes. Invalidated in register/unregister/replace. */
  private listCache: MCPTool[] | undefined;
  private readonly reloadSources = new Map<string, SkillSource>();
  private readonly sceneBuilders = new Map<string, SceneBuilder>();
  /** The dynamic policy engine (M7). When set, it SUBSUMES the static profile
   *  check at this choke point and adds quotas/revocation/budgets; when unset the
   *  registry falls back to the static permission check (legacy callers). */
  private policy?: PolicyEngine;
  constructor(readonly tracer: Tracer, policy?: PolicyEngine) {
    this.policy = policy;
  }

  /** Attach (or replace) the policy engine that governs every invoke crossing. */
  setPolicy(policy: PolicyEngine): void {
    this.policy = policy;
  }

  /** PACKAGE-LOAD policy hook (M7 enforcement point #4, called by M9 packaging).
   *  Evaluates a package's DECLARED vs GRANTED capabilities (and package revocation)
   *  against the engine and AUDITS the decision on the trace chain. Returns the
   *  decision; `allow === false` means the package must NOT load. With no engine
   *  attached the load is ungoverned (allow) — M9 always attaches one. */
  admitPackageLoad(ctx: { agentId: string; sessionId: string; pkg: string; declaredCaps: readonly string[]; grantedCaps: readonly string[]; tick?: number }): PolicyDecision {
    const packageCtx: PolicyContext = {
      boundary: "package",
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      cap: ctx.pkg,
      pkg: ctx.pkg,
      declaredCaps: ctx.declaredCaps,
      grantedCaps: ctx.grantedCaps,
      tick: ctx.tick,
    };
    const decision: PolicyDecision = this.policy !== undefined
      ? this.policy.admitPackage(packageCtx)
      : {
        allow: true,
        rule: "package.admitted",
        reason: "no policy engine attached (ungoverned package load)",
        boundary: "package",
        context: { agentId: ctx.agentId, sessionId: ctx.sessionId, cap: ctx.pkg, package: ctx.pkg, tick: ctx.tick },
      };
    this.tracer.emit({
      type: policyEventType(decision),
      actorId: ctx.agentId,
      threadId: ctx.sessionId,
      parentEventId: null,
      causedBy: [],
      payload: policyEventPayload(decision),
    });
    return decision;
  }

  register<I, O>(def: SkillDefinition<I, O>): void {
    // Stored type-erased; the registry treats input/output as `unknown` internally.
    this.skills.set(def.name, def as unknown as SkillDefinition);
    this.listCache = undefined;
  }

  describe(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  /** The default BOOTSTRAP core set — the universal cross-domain verbs an agent
   *  starts with (plus discovery, so it can always find more). Grant-filtering then
   *  narrows this to each profile's relevant subset (a builder sees the authoring
   *  ones, a player the play ones). A skill overrides its tier via the `priority`
   *  field; this set is the default for skills that don't. */
  private static readonly DEFAULT_CORE: ReadonlySet<string> = new Set([
    "skills.list", "skills.search", "skills.browse", "skills.describe",
    "scene.createEntity", "scene.queryEntities",
    "world.generateRegion", "world.populateBiome", "asset.place",
    "player.move", "player.jump", "interaction.interact", "interaction.query", "inventory.add",
    "social.say", "dialogue.start",
  ]);

  /** A skill's effective progressive-disclosure tier (explicit `priority` wins,
   *  else the DEFAULT_CORE membership decides core-vs-standard). */
  private tierOf(s: SkillDefinition): "core" | "standard" | "advanced" {
    return s.priority ?? (SkillRegistry.DEFAULT_CORE.has(s.name) ? "core" : "standard");
  }

  /** The FULL tool list. Cached: z.toJSONSchema per skill is ~ms-expensive and
   *  identical until the skill set changes. decisionSystem calls this once per
   *  admitted agent per tick and MCP listTools once per request, so the rebuild
   *  was a real hot path. */
  private fullList(): MCPTool[] {
    if (this.listCache === undefined) {
      this.listCache = [...this.skills.values()].map((s) => ({
        name: s.name,
        description: s.description,
        input_schema: z.toJSONSchema(s.input, { target: "draft-07", unrepresentable: "any" }),
        category: s.category,
        priority: this.tierOf(s),
      }));
    }
    return this.listCache;
  }

  /** Advertised tools. With `grants`, returns ONLY the skills the caller could
   *  invoke (its grants cover the skill's required permissions) — least-privilege
   *  EXPOSURE that matches the invocation boundary, so a large catalog never floods
   *  or over-exposes an agent. No-arg returns the full catalog (back-compat: the
   *  inspection surface + legacy callers are unchanged). The filter is O(n) over the
   *  memoized list — the expensive schema build stays cached. */
  list(grants?: ReadonlySet<string>, opts?: { mode?: "bootstrap" | "full" }): MCPTool[] {
    const full = this.fullList();
    const granted = grants === undefined
      ? full
      : full.filter((t) => {
        const s = this.skills.get(t.name);
        return s !== undefined && s.permissions.every((p) => grants.has(p));
      });
    // BOOTSTRAP mode: narrow to the core tier so an agent starts with a small,
    // reasoning-window-sized surface and expands on demand via skills.search/browse.
    if (opts?.mode === "bootstrap") return granted.filter((t) => t.priority === "core");
    return granted;
  }

  /** Whether a skill is currently registered. */
  has(name: string): boolean {
    return this.skills.has(name);
  }

  /** Remove a registered skill and its reload source. Returns whether one existed. */
  unregister(name: string): boolean {
    this.reloadSources.delete(name);
    const existed = this.skills.delete(name);
    if (existed) this.listCache = undefined;
    return existed;
  }

  /** Live-swap a skill definition: unregister the old one and register `def`
   *  under `name` so subsequent invoke()/callTool route to the new handler and
   *  list()/describe() report the new metadata. Returns whether an existing
   *  definition was replaced (false => nothing to reload). */
  replace(name: string, def: SkillDefinition): boolean {
    if (!this.skills.has(name)) return false;
    this.skills.delete(name);
    this.skills.set(name, def as unknown as SkillDefinition);
    this.listCache = undefined;
    return true;
  }

  /** Mark a skill hot-reloadable by registering a source that produces its
   *  latest definition (a real runtime re-imports the module on reload). */
  setReloadSource(name: string, source: SkillSource): void {
    this.reloadSources.set(name, source);
  }

  /** Register a skill together with the source used to hot-reload it. */
  registerReloadable<I, O>(def: SkillDefinition<I, O>, source: SkillSource): void {
    this.register(def);
    this.setReloadSource(def.name, source);
  }

  /** Whether `name` has a registered reload source. */
  isReloadable(name: string): boolean {
    return this.reloadSources.has(name);
  }

  /** Reload one skill from its registered source and swap it in live. Honest
   *  failure when the skill is unknown or has no reload source registered. */
  async reloadSkill(name: string): Promise<ReloadResult> {
    if (!this.skills.has(name)) {
      return { ok: false, invalidated: [], reason: `unknown skill: ${name}` };
    }
    const source = this.reloadSources.get(name);
    if (source === undefined) {
      return { ok: false, invalidated: [], reason: `skill '${name}' is not reloadable (no reload source registered)` };
    }
    const next = await source();
    if (next.name !== name) {
      return { ok: false, invalidated: [], reason: `reload source for '${name}' produced a definition named '${next.name}'` };
    }
    this.replace(name, next as unknown as SkillDefinition);
    return { ok: true, invalidated: [name], summary: { name, version: next.version } };
  }

  /** Register (or replace) a named scene builder so dev.reload can re-run it. */
  registerSceneBuilder(name: string, builder: SceneBuilder): void {
    this.sceneBuilders.set(name, builder);
  }

  /** Whether a scene builder is registered under `name`. */
  hasSceneBuilder(name: string): boolean {
    return this.sceneBuilders.has(name);
  }

  /** Names of all registered scene builders (registration order). */
  sceneBuilderNames(): string[] {
    return [...this.sceneBuilders.keys()];
  }

  /** Re-run a registered scene builder. Honest failure when none is registered. */
  async reloadScene(name: string, ctx: ExecutionContext): Promise<ReloadResult> {
    const builder = this.sceneBuilders.get(name);
    if (builder === undefined) {
      return { ok: false, invalidated: [], reason: `no scene builder registered for '${name}'` };
    }
    const summary = await builder(ctx);
    return { ok: true, invalidated: [`scene:${name}`], summary };
  }

  // ---- Human-in-the-loop approval (review gate) --------------------------
  // Off by default: with no gate installed, invoke() applies calls immediately,
  // exactly as before. When a gate is installed and returns true for a
  // (validated, policy-approved) call, the intent is HELD — surfaced as a
  // `skill.approval.pending` event and parked under its id — and applied only
  // when a reviewer grants it via resolveApproval (the approval.* skills).
  private reviewGate?: ApprovalGate;
  private readonly pending = new Map<string, PendingApproval>();

  /** Install the review gate (e.g. `reviewProfileGate(...)`), REPLACING any existing. */
  setApprovalGate(gate: ApprovalGate): void {
    this.reviewGate = gate;
  }
  /** COMPOSE a review gate: a call is held if the existing gate OR `gate` holds it.
   *  Lets independent subsystems each install their own review predicate (e.g. a
   *  host's human-review gate + the delegate-worker gate) without clobbering. */
  addApprovalGate(gate: ApprovalGate): void {
    const prev = this.reviewGate;
    this.reviewGate = prev === undefined
      ? gate
      : (name, base, skill): boolean => prev(name, base, skill) || gate(name, base, skill);
  }
  /** Remove the review gate — calls apply directly again. */
  clearApprovalGate(): void {
    this.reviewGate = undefined;
  }
  /** Snapshot of the actions currently held for approval (for a reviewer/editor). */
  pendingApprovals(): PendingApprovalView[] {
    return [...this.pending.values()].map((p) => ({
      approvalId: p.approvalId,
      skill: p.skill,
      input: p.input,
      agentId: p.base.agentId,
      sessionId: p.base.sessionId,
      profile: p.base.profile,
      tick: p.createdTick,
    }));
  }

  /** Build the per-invocation execution context + a metadata thunk. Shared by
   *  invoke() and resolveApproval() so emitted-event accounting is identical. */
  private makeCtx(base: InvokeBase): { ctx: ExecutionContext; meta: () => MCPResponse["metadata"] } {
    const start = Date.now();
    const emitted: string[] = [];
    const ctx: ExecutionContext = {
      agentId: base.agentId,
      sessionId: base.sessionId,
      permissions: base.permissions,
      tick: base.tick,
      world: base.world,
      emit: (type, payload, causedBy) => {
        const id = this.tracer.emit({
          type,
          actorId: base.agentId,
          threadId: base.sessionId,
          parentEventId: null,
          causedBy: causedBy ?? [],
          payload,
        });
        emitted.push(id);
        return id;
      },
    };
    return { ctx, meta: () => ({ executionTimeMs: Date.now() - start, eventsEmitted: emitted }) };
  }

  /** Run before -> handler -> after -> emit `skill.executed` for a resolved,
   *  validated, policy-approved (and approval-granted, if gated) call.
   *
   *  `applyTick` overrides the tick stamped on `skill.executed`: for an APPROVAL-GATED
   *  action it is the reviewer's APPLY tick (when the grant landed), not the parked
   *  PROPOSE tick — but only when it is finite and NOT BEFORE the propose tick (see
   *  stampTick; an early/zero reviewer tick is floored to the propose tick so an action
   *  is never stamped "applied before proposed"). Absent (the direct invoke() path), it
   *  falls back to `base.tick`, so a non-gated call stamps propose==apply as before. */
  private async applyHandler(
    skill: SkillDefinition,
    input: unknown,
    base: InvokeBase,
    ctx: ExecutionContext,
    meta: () => MCPResponse["metadata"],
    execCausedBy: string[] | undefined,
    applyTick?: number,
  ): Promise<MCPResponse> {
    try {
      if (skill.hooks?.before) await skill.hooks.before(input, ctx);
      const result = await skill.handler(input, ctx);
      if (skill.hooks?.after) await skill.hooks.after(result, ctx);
      ctx.emit("skill.executed", { skill: skill.name, version: skill.version, input, tick: stampTick(applyTick, base.tick) }, execCausedBy);
      return { success: true, result, metadata: meta() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: { code: "handler_error", message }, metadata: meta() };
    }
  }

  async invoke(name: string, input: unknown, base: InvokeBase): Promise<MCPResponse> {
    const { ctx, meta } = this.makeCtx(base);

    // 1. Resolve.
    const skill = this.skills.get(name);
    if (skill === undefined) {
      return { success: false, error: { code: "not_found", message: `unknown skill: ${name}` } };
    }
    // 2. Validate input against the skill's schema.
    const parsed = skill.input.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: { code: "invalid_input", message: parsed.error.message }, metadata: meta() };
    }
    // 3. Policy decision (M7). With an engine attached it SUBSUMES the static
    //    profile check and adds quota/revocation/budget; every crossing is audited
    //    via policy.decision (allow) / policy.denied (deny), and the allow decision
    //    is linked into skill.executed (causedBy) so M8 can walk action -> decision.
    //    Without an engine, the legacy static permission check governs (unchanged).
    let policyEventId: string | undefined;
    if (this.policy !== undefined) {
      const decision = this.policy.evaluate({
        boundary: "registry",
        agentId: base.agentId,
        sessionId: base.sessionId,
        cap: name,
        profile: base.profile,
        permissions: base.permissions,
        requiredPermissions: skill.permissions,
        tick: base.tick,
        args: parsed.data,
        pkg: base.pkg,
      });
      policyEventId = ctx.emit(policyEventType(decision), policyEventPayload(decision), base.causedBy);
      if (!decision.allow) {
        if (decision.permissionDenial) {
          ctx.emit("security.permission.denied", { skill: name, missing: decision.reason, rule: decision.rule, agentId: base.agentId });
        }
        return { success: false, error: { code: "forbidden", message: decision.reason }, metadata: meta() };
      }
    } else {
      // Legacy static permission check (O(1) set membership); denial is observable.
      for (const perm of skill.permissions) {
        if (!base.permissions.has(perm)) {
          ctx.emit("security.permission.denied", { skill: name, missing: perm, agentId: base.agentId });
          return { success: false, error: { code: "forbidden", message: `missing permission: ${perm}` }, metadata: meta() };
        }
      }
    }
    const execCausedBy = policyEventId !== undefined ? [...(base.causedBy ?? []), policyEventId] : base.causedBy;

    // 3b. Approval gate (off by default). Hold the validated, policy-approved
    //     intent for human review instead of applying it — no world change until
    //     a reviewer grants it.
    if (this.reviewGate !== undefined && this.reviewGate(name, base, skill)) {
      const approvalId = ctx.emit(
        "skill.approval.pending",
        { skill: name, version: skill.version, input: parsed.data, agentId: base.agentId, profile: base.profile, tick: base.tick },
        execCausedBy,
      );
      this.pending.set(approvalId, { approvalId, skill: name, input: parsed.data, base, createdTick: base.tick });
      return { success: false, error: { code: "pending_approval", message: approvalId }, metadata: meta() };
    }

    // 4. Apply.
    return this.applyHandler(skill, parsed.data, base, ctx, meta, execCausedBy);
  }

  /** Resolve a held approval. `grant` -> apply the parked intent now and return
   *  its result; deny -> drop it. Honest failure on an unknown/already-resolved
   *  id. Emits `skill.approval.granted` / `denied` on the original agent's thread,
   *  linked to the pending event so the causal chain stays intact. */
  async resolveApproval(
    approvalId: string,
    granted: boolean,
    reviewer?: { agentId: string; reason?: string; applyTick?: number },
  ): Promise<MCPResponse> {
    const parked = this.pending.get(approvalId);
    if (parked === undefined) {
      return { success: false, error: { code: "not_found", message: `unknown or already-resolved approval: ${approvalId}` } };
    }
    this.pending.delete(approvalId);
    const skill = this.skills.get(parked.skill);
    if (skill === undefined) {
      this.tracer.emit({ type: "skill.approval.denied", actorId: parked.base.agentId, threadId: parked.base.sessionId, parentEventId: null, causedBy: [approvalId], payload: { approvalId, skill: parked.skill, reason: "skill no longer registered" } });
      return { success: false, error: { code: "not_found", message: `skill '${parked.skill}' is no longer registered` } };
    }
    if (!granted) {
      this.tracer.emit({ type: "skill.approval.denied", actorId: parked.base.agentId, threadId: parked.base.sessionId, parentEventId: null, causedBy: [approvalId], payload: { approvalId, skill: parked.skill, reviewer: reviewer?.agentId, reason: reviewer?.reason } });
      return { success: false, error: { code: "forbidden", message: `approval denied: ${parked.skill}` } };
    }
    // Re-authorize at apply time: a capability (or the whole session) may have
    // been revoked since the action was proposed. A held action must not outlive
    // the authorization that permitted it — fail closed.
    if (this.policy !== undefined && this.policy.isRevoked(parked.base.sessionId, parked.skill)) {
      this.tracer.emit({ type: "skill.approval.denied", actorId: parked.base.agentId, threadId: parked.base.sessionId, parentEventId: null, causedBy: [approvalId], payload: { approvalId, skill: parked.skill, reason: "authorization revoked since propose", reviewer: reviewer?.agentId } });
      return { success: false, error: { code: "forbidden", message: `authorization revoked: ${parked.skill}` } };
    }
    // Apply-time provenance: stamp the grant + the executed action with the APPLY
    // tick (the reviewer's current tick) when it is supplied AND not before the propose
    // tick (stampTick floors it), falling back to the parked propose tick otherwise.
    // The propose-time `skill.approval.pending` event (emitted in invoke) KEEPS the
    // propose tick — only these apply-time events move.
    const applyTick = reviewer?.applyTick;
    const grantedId = this.tracer.emit({ type: "skill.approval.granted", actorId: parked.base.agentId, threadId: parked.base.sessionId, parentEventId: null, causedBy: [approvalId], payload: { approvalId, skill: parked.skill, reviewer: reviewer?.agentId, tick: stampTick(applyTick, parked.base.tick) } });
    const { ctx, meta } = this.makeCtx(parked.base);
    return this.applyHandler(skill, parked.input, parked.base, ctx, meta, [approvalId, grantedId], applyTick);
  }
}
