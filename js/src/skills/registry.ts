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

export type SkillCategory = "scene" | "ecs" | "three" | "physics" | "agent" | "system" | "ui" | "social" | "audio";

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
  handler(input: I, ctx: ExecutionContext): Promise<O> | O;
  hooks?: {
    before?(input: I, ctx: ExecutionContext): Promise<void> | void;
    after?(result: O, ctx: ExecutionContext): Promise<void> | void;
  };
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

  list(): MCPTool[] {
    // Cached: z.toJSONSchema per skill is ~ms-expensive and identical until the
    // skill set changes. decisionSystem calls this once per admitted agent per
    // tick and MCP listTools once per request, so the rebuild was a real hot path.
    if (this.listCache === undefined) {
      this.listCache = [...this.skills.values()].map((s) => ({
        name: s.name,
        description: s.description,
        input_schema: z.toJSONSchema(s.input, { target: "draft-07", unrepresentable: "any" }),
      }));
    }
    return this.listCache;
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

  async invoke(name: string, input: unknown, base: InvokeBase): Promise<MCPResponse> {
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
    const meta = () => ({ executionTimeMs: Date.now() - start, eventsEmitted: emitted });

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
    // 4. before -> handler -> after -> emit.
    try {
      if (skill.hooks?.before) await skill.hooks.before(parsed.data, ctx);
      const result = await skill.handler(parsed.data, ctx);
      if (skill.hooks?.after) await skill.hooks.after(result, ctx);
      const execCausedBy = policyEventId !== undefined ? [...(base.causedBy ?? []), policyEventId] : base.causedBy;
      ctx.emit("skill.executed", { skill: name, version: skill.version, input: parsed.data, tick: base.tick }, execCausedBy);
      return { success: true, result, metadata: meta() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: { code: "handler_error", message }, metadata: meta() };
    }
  }
}
