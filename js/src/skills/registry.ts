// limina Skill/Hook Registry — the typed, permissioned path every agent action
// flows through. invoke() is the canonical pipeline: resolve -> Zod validate ->
// permission -> before -> handler -> after -> emit (the MCP callTool is a thin
// wrapper over it).

import { z } from "../../build/zod.bundle.mjs";
import type { World } from "bitecs";
import type { CameraLike, EngineOps, EntityTable, SceneLike } from "../engine.ts";
import type { TransformStorage } from "../ecs/facade.ts";
import type { Tracer } from "../observability/event.ts";
import type { MCPErrorCode, MCPResponse, MCPTool } from "../mcp/protocol.ts";
import type { UniformGridSpatialIndex } from "../spatial/index.ts";
import type { SeededRng } from "../worldlog/log.ts";
import { captureEntityIndex, hasEntityIndex, restoreEntityIndex, type EntityIndexSnapshot } from "../worldlog/snapshot.ts";
import { armEntityIndexMutationHook } from "../ecs/world.ts";
import { teardownEntity } from "./entity-teardown.ts";
import { type PolicyEngine, type PolicyContext, type PolicyDecision, policyEventType, policyEventPayload } from "../policy/engine.ts";
import type { DesignArtifactStore } from "../world/design-artifacts.ts";
import type { GltfSceneCache } from "./three.ts";

export type SkillCategory = "scene" | "ecs" | "three" | "physics" | "agent" | "system" | "ui" | "social" | "audio" | "terrain" | "world" | "design" | "player" | "camera" | "animation" | "interaction" | "inventory" | "game" | "trigger" | "event" | "quest" | "stats" | "damage" | "status" | "combat" | "behavior" | "dialogue" | "nav" | "vfx" | "save" | "progression";
export type SkillEffect = "read" | "write" | "admin";

const policyAlreadyCommitted: unique symbol = Symbol("limina.policyAlreadyCommitted");

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
  ecs: World;
  transforms?: TransformStorage;
  spatial?: UniformGridSpatialIndex;
  entities: EntityTable;
  tags: Map<number, Set<string>>;
  design?: DesignArtifactStore;
  scene: SceneLike;
  camera: CameraLike;
  /** Render-only distance/residency controllers updated once before each draw. */
  lods?: { update(camera: CameraLike): void }[];
  ops: EngineOps;
  /** The world-owned deterministic SKILL RNG stream (worldlog/log.ts, M4). A skill
   *  needing randomness draws `ctx.world.rng.next()` -- NEVER `Math.random()`,
   *  whose global stream position depends on which CONTEXT ran (three.js draws it
   *  for UUIDs only when meshes are created), not on the command stream. Wired by
   *  the seeding/replay/recovery paths; absent in unseeded worlds. */
  rng?: SeededRng;
  agents?: AgentLookup;
  renderer?: unknown;
  /** Parsed glTF templates owned by the browser render host. Browser render worlds must use this
   * cache so a world session never performs an asynchronous loader miss mid-frame. */
  gltfCache?: GltfSceneCache;
  /** The render-only post-processing pipeline built by `render.enablePost` (a
   *  PostPipeline from render/post.ts). A render loop drives `post.render()` in place of
   *  `renderer.render(...)`. Set by the skill; never sim/log state. */
  post?: unknown;
  width?: number;
  height?: number;
  mode?: "windowed" | "headless";
  /** True in the browser SIM WORKER (the authoritative fixed-step sim). It has no DOM, so GLTFLoader
   *  texture decode hangs — GLB-mounting skills skip the mesh parse here and spawn the entity only
   *  (the render thread mounts the mesh). Distinct from `mode:"headless"`, which also covers the
   *  server recorder + gates, both of which DO parse/resolve normally. */
  simWorker?: boolean;
  /** True for an offline OVERVIEW render (the design-space Atlas peek): a distant turntable of the
   *  whole map. Render-only skills that add eye-level detail invisible at that scale — paint-driven
   *  grass blades above all — skip it, so the peek renders the map's shape/paint without paying for
   *  thousands of sub-pixel grass chunks. The painted ground tint already reads the grassy areas. */
  peek?: boolean;
}

export interface ExecutionContext {
  agentId: string;
  sessionId: string;
  /** Caller profile retained for domain-level least-privilege constraints. */
  profile?: string;
  permissions: ReadonlySet<string>;
  tick: number;
  world: WorldContext;
  /** The recording chain this invocation belongs to (set by the WorldRecorder;
   *  undefined when not recording). A skill handler that RE-INVOKES the registry
   *  MUST pass `chainId: ctx.chainId` so the nested call is folded into the
   *  already-recorded top-level command instead of recorded again. */
  chainId?: string;
  /** Register a COMPENSATION for a world mutation this handler just applied (H1
   *  failure atomicity). Undos accumulate on ONE LIFO ledger per HEAD chain —
   *  nested invokes append to their head's ledger — and run only when the head
   *  invocation fails (handler throw, output contract_error, hooks.after throw);
   *  success drops the ledger. With the recorder's discard-on-failure this makes
   *  a failed multi-step skill "never happened" for WORLD STATE: live == log ==
   *  replay. ENTITY creation needs no undo — the unwind tears down every entity
   *  the chain created (the catch-all in unwindChainFrame); register undos for
   *  NON-entity effects (terrain heights, footprints, manager entries).
   *  `fn` must be synchronous and must tolerate state already freed by a later
   *  (earlier-run) undo — teardownEntity's undefined-on-missing contract.
   *
   *  KNOWN BOUNDARY (C3 window, disclosed — not full rewind): tick-loop `step`s
   *  legitimately RECORDED while an async chain was in flight simulated WITH the
   *  chain's transient bodies. Unwind removes the bodies but cannot un-run those
   *  recorded steps, and replay re-runs them WITHOUT the transient bodies — so a
   *  dynamic body that interacted with a failed chain's transient collider can
   *  diverge on replay. The unwind emits `skill.rollback.stepsDuringChain` when
   *  this window was observed, so the boundary is loud, never silent. */
  undo(label: string, fn: () => void): void;
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
  /** Recording-chain id (set by the WorldRecorder on the base it forwards). A
   *  TOP-LEVEL caller leaves this undefined -- the recorder mints one and records
   *  the command. A skill handler that re-invokes passes `ctx.chainId` so the
   *  nested call is classified as part of the same chain (not re-recorded). This
   *  is robust to concurrent top-level chains interleaving on a single thread,
   *  which a depth/flag counter cannot be. */
  chainId?: string;
  /** Internal approval-resolution bypass. Only resolveApproval sets this when it
   *  re-enters invoke() to apply an already-approved parked action; callers must
   *  not use it as a general policy or validation bypass. */
  approvalGateBypassed?: true;
  /** Module-private proof that resolveApproval already committed policy usage at
   *  proposal time. The symbol key prevents callers from forging this bypass. */
  [policyAlreadyCommitted]?: true;
}

export interface SkillDefinition<I = unknown, O = unknown> {
  name: string;
  version: string;
  description: string;
  category: SkillCategory;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  permissions: string[];
  /** Observable effect classification used by scheduling and recording boundaries.
   *  Omitted definitions are treated as writes, never as reads. */
  effect?: SkillEffect;
  /** OUTPUT field names the RECORDER commits back into the recorded command's
   *  input, so the replay log PINS authored-resolved identity (e.g. asset.place's
   *  content hash). Each named field must also be an OPTIONAL input field so the
   *  committed value validates on replay. Absent -> nothing committed (default). */
  commitFields?: string[];
  /** Optional post-success recording filter. Returning false marks a successful
   * idempotent/no-op call as non-authoring so the recorder removes its provisional
   * command. It must be pure and deterministic; a thrown predicate fails closed by
   * retaining the command. */
  shouldRecordResult?(result: O): boolean;
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

/** A deliberate, client-actionable skill failure. Handlers throw this only for
 * expected domain outcomes; unexpected exceptions remain `handler_error`. */
export class SkillInvocationError extends Error {
  constructor(readonly code: MCPErrorCode, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "SkillInvocationError";
  }
}

/** Classify a skill conservatively. Read fast paths are opt-in because an
 *  incorrectly inferred read can bypass authoritative ordering and recording. */
export function skillEffect(skill: SkillDefinition): SkillEffect {
  return skill.effect ?? "write";
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

/** One registered compensation on a chain's undo ledger. */
interface ChainUndoEntry {
  label: string;
  fn: () => void;
}

/** Per-HEAD-chain unwind state (H1). Created when the head invocation reaches
 *  apply; nested invokes (same chainId) find it and append undos. Dropped on
 *  head settle — unwound first when the head failed. */
interface ChainHeadFrame {
  chainId: string;
  skill: string;
  ledger: ChainUndoEntry[];
  /** Head-frame allocator/RNG capture (write skills only). Restored on unwind so
   *  `ent_` ids, eids, and skill-RNG draws rewind — teardown alone leaves the
   *  counters advanced and replay (which never runs the failed chain) would then
   *  allocate DIFFERENT ids for every later command. */
  capture?: {
    world: WorldContext;
    rngState?: number;
    entitySeq: number;
    entityVersion: number;
    /** LAZILY captured at the chain's FIRST entity mutation (the one-shot hooks
     *  beginChainFrame arms) — captureEntityIndex is O(maxId) + two array
     *  allocations, and most write invokes (per-tick movement intents above all)
     *  never touch an entity. Absent when the chain mutated no entities, or when
     *  the world has no bitECS index (stub worlds) — either way there are no
     *  eids to rewind; EntityTable seq/version rewind still applies. */
    entityIndex?: EntityIndexSnapshot;
  };
  /** Disarms the lazy-capture mutation hooks (EntityTable + bitECS allocation
   *  seams). Called before unwind runs (so unwind's own teardown cannot trigger
   *  a late, post-mutation capture) and again at frame end. */
  disarm?: () => void;
  /** True when another head chain was live at any point during this frame's
   *  life. Rewinding allocators is only sound if no other chain allocated in
   *  the window, so an overlapped unwind poisons instead of guessing. */
  overlapped: boolean;
}

export interface SkillRegistryOptions {
  /** FALSIFIABILITY FIXTURE ONLY (the p103 gate proves its asserts detect a
   *  ledger-less registry). A production caller must never pass this — without
   *  the ledger a failed multi-step skill leaves a half-built world that the
   *  discarded command can never replay. */
  disableChainUndoLedger?: boolean;
  /** FALSIFIABILITY FIXTURE ONLY (p103 proves the catch-all is load-bearing).
   *  Without the catch-all, a failed chain whose skill created entities WITHOUT
   *  registering undos leaves live survivors facing rewindAllocator — which
   *  refuses (correctly) and poisons the whole session, turning a survivable
   *  partial failure into session loss. */
  disableChainEntityCatchAll?: boolean;
}

export class SkillRegistry {
  private readonly worldReconcilers = new Set<(world: WorldContext) => void>();
  /** Register idempotent derived-state recovery run before every skill handler.
   *  Snapshot-persisted entity origins remain authority; closure managers are rebuilt here. */
  registerWorldReconciler(reconciler: (world: WorldContext) => void): void { this.worldReconcilers.add(reconciler); }
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
  /** Live head-chain unwind frames, keyed by chainId (H1). Data, not a counter —
   *  concurrent head chains each keep their own frame. */
  private readonly chainFrames = new Map<string, ChainHeadFrame>();
  /** Mints chain ids for top-level invokes with NO recorder attached (the
   *  recorder mints `chain_N` before original invoke runs). Distinct prefix so
   *  the two namespaces can never collide. */
  private localChainSeq = 0;
  /** First failed rollback. A world that failed to roll back is indeterminate:
   *  once set, every further WRITE invoke fails closed (reads stay available for
   *  diagnosis) and hosts map it to their authority poison (net/server.ts). */
  private poisonError?: Error;
  private readonly rollbackFailureHandlers: Array<(error: Error) => void> = [];
  private readonly chainUndoLedgerEnabled: boolean;
  private readonly chainEntityCatchAllEnabled: boolean;
  /** Recorder seam (H1 boundary disclosure): reports how many physics `step`
   *  commands were RECORDED while the given head chain was live (the legitimate
   *  C3 tick-loop-under-async-chain window). Set by WorldRecorder.attach; unset
   *  (0 steps assumed) when no recorder is attached. */
  private chainStepProbe?: (chainId: string) => number;
  constructor(readonly tracer: Tracer, policy?: PolicyEngine, opts?: SkillRegistryOptions) {
    this.policy = policy;
    this.chainUndoLedgerEnabled = opts?.disableChainUndoLedger !== true;
    this.chainEntityCatchAllEnabled = opts?.disableChainEntityCatchAll !== true;
  }

  /** Install the recorded-steps-during-chain probe (see chainStepProbe). */
  setChainStepProbe(probe: (chainId: string) => number): void {
    this.chainStepProbe = probe;
  }

  /** The first rollback failure, or undefined while the registry is healthy.
   *  Mirrors authoring/kernel.ts `poisoned`: hosts check it (or subscribe via
   *  onRollbackFailure) and stop authoring against the indeterminate world. */
  get poisoned(): Error | undefined {
    return this.poisonError;
  }

  /** Subscribe to rollback failures (called at most the moment the registry
   *  poisons). net/server.ts maps this to its existing poisonAuthority. */
  onRollbackFailure(handler: (error: Error) => void): void {
    this.rollbackFailureHandlers.push(handler);
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
    // COLLISION-SAFE: a bare register on a taken name throws — silently clobbering
    // defeated replace()'s live-swap contract and hid double-registration bugs.
    // Intentional re-registration goes through replace() (or unregister() first).
    if (this.skills.has(def.name)) {
      throw new Error(`SkillRegistry.register: skill '${def.name}' is already registered — use replace()/unregister() for an intentional swap`);
    }
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
    "skills.search", "skills.browse",
    "scene.createEntity", "scene.moveEntity", "ecs.updateComponent", "world.generateRegion", "asset.place",
    "terrain.create", "vegetation.scatter",
    "player.move", "player.jump", "interaction.interact", "inventory.add",
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
  private maxPendingApprovals = 1024;

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
  /** Bound the held-action store for long-lived editor/coordinator hosts. */
  setApprovalQueueLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("approval queue limit must be a positive safe integer");
    }
    this.maxPendingApprovals = limit;
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
   *  invoke() and resolveApproval() so emitted-event accounting is identical.
   *  `chainId` is the EFFECTIVE chain id (the caller's, or one this invoke
   *  minted): ctx.chainId must always be forwardable by nested invokes so the
   *  whole chain shares one undo ledger even with no recorder attached. */
  private makeCtx(base: InvokeBase, chainId: string): { ctx: ExecutionContext; meta: () => MCPResponse["metadata"] } {
    const start = Date.now();
    const emitted: string[] = [];
    const ctx: ExecutionContext = {
      agentId: base.agentId,
      sessionId: base.sessionId,
      profile: base.profile,
      permissions: base.permissions,
      tick: base.tick,
      world: base.world,
      chainId,
      undo: (label, fn) => {
        if (!this.chainUndoLedgerEnabled) return;
        const frame = this.chainFrames.get(chainId);
        // Undos are only meaningful while the chain's head frame is live (the
        // handler window). A registration outside it has no unwind to ride and
        // silently dropping it would be an uncompensated mutation — fail loudly.
        if (frame === undefined) {
          throw new Error(`ctx.undo('${label}'): no live chain frame for '${chainId}' — undo registered outside the handler window`);
        }
        frame.ledger.push({ label, fn });
      },
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
      for (const reconcile of this.worldReconcilers) reconcile(base.world);
      if (skill.hooks?.before) await skill.hooks.before(input, ctx);
      const result = await skill.handler(input, ctx);
      const parsedResult = skill.output.safeParse(result);
      if (!parsedResult.success) {
        ctx.emit("skill.contract.violation", {
          skill: skill.name,
          version: skill.version,
          boundary: "output",
          error: parsedResult.error.message,
        }, execCausedBy);
        return {
          success: false,
          error: { code: "contract_error", message: `skill '${skill.name}' returned output that violates its schema: ${parsedResult.error.message}` },
          metadata: meta(),
        };
      }
      if (skill.hooks?.after) await skill.hooks.after(result, ctx);
      ctx.emit("skill.executed", { skill: skill.name, version: skill.version, input, tick: stampTick(applyTick, base.tick) }, execCausedBy);
      return { success: true, result, metadata: meta() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof SkillInvocationError ? err.code : "handler_error";
      return { success: false, error: { code, message }, metadata: meta() };
    }
  }

  async invoke(name: string, input: unknown, base: InvokeBase): Promise<MCPResponse> {
    // Effective chain id: the caller's (a recorder-minted head id, or a nested
    // handler forwarding ctx.chainId), else minted here — so even an unrecorded
    // world gets ONE undo ledger per top-level chain. Distinct prefix from the
    // recorder's `chain_N` namespace.
    const chainId = base.chainId ?? `lchain_${this.localChainSeq++}`;
    const { ctx, meta } = this.makeCtx(base, chainId);

    // 1. Resolve.
    const skill = this.skills.get(name);
    if (skill === undefined) {
      return { success: false, error: { code: "not_found", message: `unknown skill: ${name}` } };
    }
    // 1b. Fail closed after a failed rollback: the world is indeterminate, so no
    //     further WRITE may author against it. Reads stay available for diagnosis
    //     (mirrors authoring/kernel.ts writer_poisoned).
    if (this.poisonError !== undefined && skillEffect(skill) !== "read") {
      return {
        success: false,
        error: { code: "conflict", message: `registry is poisoned after a failed rollback; restart required: ${this.poisonError.message}` },
        metadata: meta(),
      };
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
    if (this.policy !== undefined && base[policyAlreadyCommitted] !== true) {
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
    if (base.approvalGateBypassed !== true && this.reviewGate !== undefined && this.reviewGate(name, base, skill)) {
      if (this.pending.size >= this.maxPendingApprovals) {
        ctx.emit("skill.approval.denied", {
          skill: name,
          version: skill.version,
          agentId: base.agentId,
          profile: base.profile,
          reason: "approval queue full",
          pending: this.pending.size,
          limit: this.maxPendingApprovals,
        }, execCausedBy);
        return { success: false, error: { code: "resource_exhausted", message: `approval queue full (${this.pending.size}/${this.maxPendingApprovals})` }, metadata: meta() };
      }
      const approvalId = ctx.emit(
        "skill.approval.pending",
        { skill: name, version: skill.version, input: parsed.data, agentId: base.agentId, profile: base.profile, tick: base.tick },
        execCausedBy,
      );
      this.pending.set(approvalId, { approvalId, skill: name, input: parsed.data, base, createdTick: base.tick });
      return { success: false, error: { code: "pending_approval", message: approvalId }, metadata: meta() };
    }

    // 4. Apply — under the per-chain undo ledger (H1 failure atomicity). The
    //    HEAD invocation of a chain (first frame seen for this chainId) arms the
    //    ledger + the head-frame allocator/RNG capture; nested invokes (same
    //    chainId, frame already live) append their undos to the head's ledger.
    //    Any failure surfacing from the head's applyHandler — handler throw,
    //    output contract_error, hooks.after throw — unwinds the WHOLE chain, so
    //    the recorder's discard-on-failure leaves live == log == replay ==
    //    "it never happened". Success drops the ledger.
    const frame = this.chainUndoLedgerEnabled && !this.chainFrames.has(chainId)
      ? this.beginChainFrame(chainId, skill, base.world)
      : undefined;
    try {
      const res = await this.applyHandler(skill, parsed.data, base, ctx, meta, execCausedBy);
      if (frame !== undefined && !res.success) this.unwindChainFrame(frame, ctx);
      return res;
    } finally {
      if (frame !== undefined) {
        frame.disarm?.();
        this.chainFrames.delete(chainId);
      }
    }
  }

  /** Arm a head chain's unwind frame. The O(1) captures (RNG state, EntityTable
   *  seq/version) are taken eagerly for every WRITE skill; the O(entities) bitECS
   *  entity-index copy is captured LAZILY at the chain's first entity mutation,
   *  via one-shot hooks on BOTH mutation seams — the EntityTable identity ops and
   *  the bitECS eid allocation path (ecs/world.ts). The allocation seam is load-
   *  bearing: skills allocate the eid (spawnRenderable) BEFORE entities.create,
   *  so a table-only hook would capture an index already containing the chain's
   *  first eid and the unwind would leak it. Declared READ skills skip capture
   *  entirely, so hot polling paths — the editor's per-tick inspector.snapshot /
   *  worldlog.tail — pay nothing; write invokes that never touch an entity
   *  (per-tick movement intents) now pay only the O(1) part. */
  private beginChainFrame(chainId: string, skill: SkillDefinition, world: WorldContext): ChainHeadFrame {
    const overlapped = this.chainFrames.size > 0;
    // Overlap is symmetric: every frame alive while another exists is marked, so
    // an unwind can tell whether shared allocator state stayed exclusively its own.
    if (overlapped) for (const f of this.chainFrames.values()) f.overlapped = true;
    const frame: ChainHeadFrame = { chainId, skill: skill.name, ledger: [], overlapped };
    if (skillEffect(skill) !== "read") {
      const capture: NonNullable<ChainHeadFrame["capture"]> = {
        world,
        rngState: world.rng?.getState(),
        entitySeq: world.entities.nextSeq,
        entityVersion: world.entities.version,
      };
      frame.capture = capture;
      const captureIndex = (): void => {
        if (capture.entityIndex === undefined && hasEntityIndex(world.ecs)) {
          capture.entityIndex = captureEntityIndex(world.ecs);
        }
      };
      const disarmers: Array<() => void> = [armEntityIndexMutationHook(world.ecs, captureIndex)];
      // Stub worlds (registry unit gates drive invoke with minimal WorldContext
      // literals) may lack the EntityTable hook; the guard mirrors hasEntityIndex.
      if (typeof world.entities.armMutationHook === "function") {
        disarmers.push(world.entities.armMutationHook(captureIndex));
      }
      frame.disarm = () => { for (const disarm of disarmers) disarm(); };
    }
    this.chainFrames.set(chainId, frame);
    return frame;
  }

  /** Unwind a failed head chain: run its undo ledger LIFO, tear down every
   *  entity the chain created that still survives (the CATCH-ALL — see below),
   *  then rewind the skill RNG, the bitECS entity index, and the EntityTable
   *  seq/version captured at head start — teardown alone is not enough, because
   *  `ent_`/eid allocation is monotonic and replay (which never runs the failed
   *  chain) would otherwise allocate DIFFERENT ids for every subsequent command.
   *  Synchronous: no other chain can interleave mid-unwind on this single thread.
   *
   *  CATCH-ALL (D3): the ledger is a registration seam, and most entity-creating
   *  skills never registered a teardown undo — their survivors used to reach
   *  rewindAllocator as live ids, which refuses (correctly) and POISONED the
   *  whole session: a survivable partial failure became session loss. Entity
   *  creation is now compensated structurally (idsCreatedSince → teardownEntity,
   *  newest-first); per-skill ctx.undo remains for NON-entity effects (terrain
   *  heights, footprints, manager entries).
   *
   *  KNOWN BOUNDARY (not full rewind): recorded tick-loop `step`s that ran inside
   *  this chain's async window (legitimate under C3) simulated WITH the chain's
   *  transient bodies; replay re-runs those steps WITHOUT them. State is restored
   *  here, but those steps' dynamics cannot be un-run — disclosed via the
   *  `skill.rollback.stepsDuringChain` warning event (recorder-fed probe). */
  private unwindChainFrame(frame: ChainHeadFrame, ctx: ExecutionContext): void {
    // Disarm the lazy-capture hooks FIRST: the catch-all teardown below mutates
    // the entity table/index, and a late hook fire would capture post-chain state.
    frame.disarm?.();
    frame.disarm = undefined;
    const capture = frame.capture;
    const world = capture?.world ?? ctx.world;
    const rngMoved = capture?.rngState !== undefined && world.rng !== undefined && world.rng.getState() !== capture.rngState;
    const tableMoved = capture !== undefined && world.entities.version !== capture.entityVersion;
    const indexCaptured = capture?.entityIndex !== undefined;
    // The failed chain left no compensable tracks — nothing to rewind. (A captured
    // entity index counts as a track: the capture hook only fires on a mutation.)
    if (frame.ledger.length === 0 && !rngMoved && !tableMoved && !indexCaptured) return;
    // H1 boundary disclosure: recorded tick-loop steps inside this chain's window
    // simulated with state the unwind is about to remove. Emitted for ANY
    // compensating unwind (conservative: nearly every compensable mutation —
    // colliders, bodies, heightfields — is physics-affecting), including ones
    // that go on to poison, so the window is never silent.
    const stepsDuringChain = this.chainStepProbe?.(frame.chainId) ?? 0;
    if (stepsDuringChain > 0) {
      ctx.emit("skill.rollback.stepsDuringChain", {
        chainId: frame.chainId,
        skill: frame.skill,
        steps: stepsDuringChain,
        note: "recorded steps in this chain's async window simulated with the rolled-back mutations; replay re-runs them without",
      });
    }
    if (frame.overlapped) {
      // Another head chain was live inside this chain's window: rewinding SHARED
      // allocator/RNG state would clobber its allocations, and range-scoped undos
      // could tear down its entities. That interleaving is a real multi-agent
      // authoring conflict — refuse to guess, poison loudly.
      this.poisonRegistry(ctx, frame, "concurrent_chains", [
        { label: "chain overlap", message: `chain '${frame.chainId}' (${frame.skill}) failed with compensable mutations while another head chain was live` },
      ]);
      return;
    }
    const failures: Array<{ label: string; message: string }> = [];
    for (let i = frame.ledger.length - 1; i >= 0; i--) {
      const entry = frame.ledger[i];
      try {
        entry.fn();
      } catch (error) {
        failures.push({ label: entry.label, message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (capture !== undefined) {
      // CATCH-ALL entity compensation (D3): every still-live entity the chain
      // created is torn down through the canonical four-part path (idempotent —
      // entities a ledger undo already destroyed no longer resolve and are
      // skipped). Newest-first mirrors the ledger's LIFO order.
      if (this.chainEntityCatchAllEnabled && typeof world.entities.idsCreatedSince === "function") {
        const created = world.entities.idsCreatedSince(capture.entitySeq);
        for (let i = created.length - 1; i >= 0; i--) {
          try {
            teardownEntity(world, created[i]);
          } catch (error) {
            failures.push({ label: `catch-all teardown '${created[i]}'`, message: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      try {
        if (capture.rngState !== undefined) world.rng?.setState(capture.rngState);
        if (capture.entityIndex !== undefined) restoreEntityIndex(world.ecs, capture.entityIndex);
        world.entities.rewindAllocator(capture.entitySeq, capture.entityVersion);
      } catch (error) {
        failures.push({ label: "allocator rewind", message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (failures.length > 0) this.poisonRegistry(ctx, frame, "undo_failed", failures);
  }

  /** Mirror authoring/kernel.ts #rollback: collect the failures, emit
   *  `skill.rollback.failed`, poison, and notify hosts (net/server.ts maps the
   *  callback to its existing poisonAuthority). A world that failed to roll back
   *  is indeterminate; nothing may author against it. */
  private poisonRegistry(ctx: ExecutionContext, frame: ChainHeadFrame, reason: string, failures: ReadonlyArray<{ label: string; message: string }>): void {
    const error = new Error(
      `skill rollback failed (${reason}) for chain '${frame.chainId}' (${frame.skill}): ${failures.map((f) => `${f.label}: ${f.message}`).join("; ")}`,
    );
    if (this.poisonError === undefined) this.poisonError = error;
    ctx.emit("skill.rollback.failed", { chainId: frame.chainId, skill: frame.skill, reason, failures: [...failures] });
    for (const handler of this.rollbackFailureHandlers) {
      try {
        handler(error);
      } catch {
        // A broken observer must not mask the poison itself.
      }
    }
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
    const invokeBase: InvokeBase = {
      ...parked.base,
      tick: stampTick(applyTick, parked.base.tick),
      causedBy: [approvalId, grantedId],
      chainId: undefined,
      approvalGateBypassed: true,
      [policyAlreadyCommitted]: true,
    };
    return this.invoke(parked.skill, parked.input, invokeBase);
  }
}
