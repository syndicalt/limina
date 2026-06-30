// DIRECT-PATH GAME CONTEXT (M1 of the game-director roadmap).
//
// The single factory that assembles everything a game needs — the skill read/write
// surface (WorldContext), the SkillRegistry + CoreSkills bundle, and the per-invocation
// `base` — so a game stops hand-copying the ~11-field WorldContext literal that was
// duplicated across every demo. Game code then calls the substrate managers DIRECTLY off
// `ctx.core` (e.g. a CharacterController on `ctx.ops`, `ctx.core.nav.navmeshManager`,
// `ctx.core.quest.questManager`) with ZERO `registry.invoke` ceremony on the hot path.
//
// THE OPT-IN SUPERSTRUCTURE: determinism/world-log recording is a layer you WRAP ON, not
// the mandatory authoring path. With `record` omitted, nothing wraps the ops and the game
// pays zero recorder cost. With `record` supplied, the same context transparently:
//   - installs the seeded PRNG (recorder.seed),
//   - wraps `ctx.ops` so direct-path physics ops issued at depth 0 are logged, and
//   - patches `registry.invoke` so any authoring skills are logged too,
// yielding a replay-complete world-log (recorder.toJsonl()) — without changing game code.
//
// Two factories share one `assemble()`:
//   - createWindowedContext(...)  — builds a real Engine (GPU surface); for `--window` runs.
//   - createHeadlessContext(...)  — stub scene/camera + a real bitECS world + native ops;
//                                   for headless tests and the functional gate (no GPU).

import {
  createEngine, EntityTable, ops as moduleOps,
  type Engine, type EngineOps, type SceneLike, type CameraLike,
} from "../engine.ts";
import { createEcsWorld } from "../ecs/world.ts";
import { createTransformStorage } from "../ecs/facade.ts";
import { UniformGridSpatialIndex } from "../spatial/index.ts";
import { LiminaTracer } from "../observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills, type CoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { WorldRecorder } from "../worldlog/recorder.ts";
import type { PolicyEngine } from "../policy/engine.ts";

/** Opt-in world-log recording. Supply to capture a replay-complete command stream;
 *  omit (or pass `false`) for a zero-cost direct-path game. */
export interface RecordOptions {
  /** Deterministic PRNG seed installed via the recorder (replaces global Math.random).
   *  Omit if the game uses no randomness. */
  seed?: number;
}

/** Options common to both context factories. */
interface CommonContextOptions {
  /** Session id (trace + world-log identity). Default "ses_game". */
  session?: string;
  /** Acting agent id stamped on recorded commands. Default "agt_game". */
  agentId?: string;
  /** Permission profile name resolved into `base.permissions`. Default "builder.readWrite". */
  profile?: string;
  /** Opt into world-log recording. Omitted/false → zero recorder cost. */
  record?: RecordOptions | false;
  /** Custom opts forwarded to registerCoreSkills (e.g. terrainSource, providers, a delegate agents
   *  registry). Omit for the default core set. */
  coreOpts?: Parameters<typeof registerCoreSkills>[1];
  /** AgentRegistry exposed on `world.agents` (agent-pipeline demos/tests). */
  agents?: WorldContext["agents"];
  /** Custom spatial index (e.g. a non-default cellSize a profiler/spatial test asserts on).
   *  Default: a fresh UniformGridSpatialIndex (headless) or the engine's (windowed). */
  spatial?: WorldContext["spatial"];
  /** Reuse a specific tracer (e.g. a LiminaTracer with a non-default maxAge a durability test
   *  builds). Default: a fresh LiminaTracer over the session. */
  tracer?: LiminaTracer;
  /** Policy engine for the SkillRegistry (M7 governed invocation). */
  policy?: PolicyEngine;
}

export interface HeadlessContextOptions extends CommonContextOptions {
  /** Override the host capability ops (tests inject a stub/native surface).
   *  Defaults to the module-bound host ops. */
  ops?: EngineOps;
  /** Custom scene (e.g. a child-tracking stub a test asserts on). Default: a no-op stub. */
  scene?: SceneLike;
  /** Custom camera (e.g. a real PerspectiveCamera used in ui.update / projection asserts). */
  camera?: CameraLike;
}

export interface WindowedContextOptions extends CommonContextOptions {
  width: number;
  height: number;
  /** Phase 11 render baseline (see createEngine). Omit for the lit default. */
  renderBaseline?: Parameters<typeof createEngine>[0]["renderBaseline"];
}

/** Everything a direct-path game needs, assembled once. */
export interface GameContext {
  /** The skill read/write surface (built here, not hand-copied per demo). */
  world: WorldContext;
  registry: SkillRegistry;
  /** The substrate managers — the DIRECT PATH. Call these without `registry.invoke`. */
  core: CoreSkills;
  /** Per-invocation base for the authoring skills that still go through invoke. */
  base: InvokeBase;
  /** The capability ops the game MUST use for all physics/host work. When recording is
   *  opted in these are the recorder-wrapped ops (so direct-path physics is logged);
   *  otherwise the bare host ops. Always use this — never the module `ops` — in game code. */
  ops: EngineOps;
  /** Present iff recording was opted in: the authoritative command stream (+ toJsonl()). */
  recorder?: WorldRecorder;
  /** The tracer the registry emits through (HUDs / tracer-inspecting code use it). */
  tracer: LiminaTracer;
  /** Present in windowed mode (createWindowedContext); absent headless. */
  engine?: Engine;
  /** Advance the sim tick: stamps base.tick AND recorder.tick so direct-path physics
   *  commands and skill invokes log at the right tick. Call once per fixed step. */
  setTick(tick: number): void;
}

interface AssembleParams {
  ecs: unknown;
  transforms: WorldContext["transforms"];
  spatial: WorldContext["spatial"];
  entities: EntityTable;
  tags: Map<number, Set<string>>;
  scene: SceneLike;
  camera: CameraLike;
  renderer?: unknown;
  width?: number;
  height?: number;
  mode: "windowed" | "headless";
  baseOps: EngineOps;
  session: string;
  agentId: string;
  profile: string;
  record?: RecordOptions | false;
  coreOpts?: Parameters<typeof registerCoreSkills>[1];
  agents?: WorldContext["agents"];
  tracer?: LiminaTracer;
  policy?: PolicyEngine;
  engine?: Engine;
}

/** The shared assembly both factories delegate to: registry + core + the opt-in recorder
 *  + the WorldContext + base, wired so the recorder (when present) sees the WHOLE session. */
function assemble(p: AssembleParams): GameContext {
  const tracer = p.tracer ?? new LiminaTracer(p.session);
  const registry = new SkillRegistry(tracer, p.policy);
  const core = registerCoreSkills(registry, p.coreOpts);

  let recorder: WorldRecorder | undefined;
  let activeOps = p.baseOps;
  if (p.record) {
    recorder = new WorldRecorder(p.session);
    // Seed BEFORE any command can consume randomness; install the deterministic PRNG.
    if (p.record.seed !== undefined) recorder.seed(p.record.seed);
    // Wrap ops so direct-path physics (depth 0) is logged, and patch invoke so authoring
    // skills are logged — BOTH before the game authors or steps anything.
    activeOps = recorder.wrapOps(p.baseOps);
    recorder.attach(registry);
  }

  const world: WorldContext = {
    ecs: p.ecs,
    transforms: p.transforms,
    spatial: p.spatial,
    entities: p.entities,
    tags: p.tags,
    scene: p.scene,
    camera: p.camera,
    renderer: p.renderer,
    ops: activeOps,
    agents: p.agents,
    width: p.width,
    height: p.height,
    mode: p.mode,
  };
  const base: InvokeBase = {
    agentId: p.agentId,
    sessionId: p.session,
    permissions: resolveProfile(p.profile),
    tick: 0,
    world,
  };

  const setTick = (tick: number): void => {
    base.tick = tick;
    if (recorder) recorder.tick = tick;
  };

  return { world, registry, core, base, ops: activeOps, recorder, engine: p.engine, tracer, setTick };
}

/** Build a HEADLESS context: a real bitECS world + native ops, with no-op stub scene/camera
 *  (UI panels are harmless). For tests and the functional gate — no GPU/window required. */
export function createHeadlessContext(opts: HeadlessContextOptions = {}): GameContext {
  const baseOps = opts.ops ?? moduleOps;
  const ecs = createEcsWorld();
  const scene = opts.scene ?? ({
    add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown,
  } as unknown as SceneLike);
  const camera = opts.camera ?? ({
    position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {},
  } as unknown as CameraLike);
  return assemble({
    ecs,
    transforms: createTransformStorage(ecs),
    spatial: opts.spatial ?? new UniformGridSpatialIndex(),
    entities: new EntityTable(),
    tags: new Map(),
    scene,
    camera,
    mode: "headless",
    baseOps,
    session: opts.session ?? "ses_game",
    agentId: opts.agentId ?? "agt_game",
    profile: opts.profile ?? "builder.readWrite",
    record: opts.record,
    coreOpts: opts.coreOpts,
    agents: opts.agents,
    tracer: opts.tracer,
    policy: opts.policy,
  });
}

/** Build a WINDOWED context: a real Engine (GPU device + window surface + render baseline),
 *  then the shared assembly over it. For `--window` runs. */
export async function createWindowedContext(opts: WindowedContextOptions): Promise<GameContext> {
  const engine = await createEngine({
    width: opts.width,
    height: opts.height,
    renderBaseline: opts.renderBaseline,
  });
  return assemble({
    ecs: engine.world,
    transforms: engine.transforms,
    spatial: opts.spatial ?? engine.spatial,
    entities: engine.entities,
    tags: engine.tags,
    scene: engine.scene,
    camera: engine.camera,
    renderer: engine.renderer,
    width: engine.width,
    height: engine.height,
    mode: "windowed",
    baseOps: engine.ops,
    session: opts.session ?? "ses_game",
    agentId: opts.agentId ?? "agt_game",
    profile: opts.profile ?? "builder.readWrite",
    record: opts.record,
    coreOpts: opts.coreOpts,
    agents: opts.agents,
    tracer: opts.tracer,
    policy: opts.policy,
    engine,
  });
}
