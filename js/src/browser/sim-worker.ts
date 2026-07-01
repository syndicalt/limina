// Phase 8 Mode B — M3: the SIM-WORKER, the authoritative fixed-step engine loop.
//
// `SimWorkerController` is the Worker-API-AGNOSTIC unit (no `self` / `postMessage`
// / `onmessage` anywhere in it) — it is the testable composition of the verified
// M1/M2 pieces into a headless, deterministic, fixed-step simulation:
//
//   • M1  WasmRapierPhysics   — the live wasm-Rapier `PhysicsOps` (real solver).
//   • M2  SharedTransformStorage — the zero-copy transform SAB the render-main
//                                  thread reads (the worker is the WRITER).
//   • M3  InputRingBuffer     — the lock-free input SAB the render-main thread
//                                  writes (the worker is the CONSUMER).
//   • ECS world + EntityTable + a SkillRegistry with registerCoreSkills, bound to
//     a headless WorldContext whose `ops` are the wasm-physics ops + no-op stubs
//     for the render/audio/host surfaces a worker doesn't have.
//
// tick() is ONE fixed step: read the latest input, drive the player controller,
// `op_physics_step`, then SYNC every live body transform into the transform SAB
// (so the render thread sees the new pose), and bump an Atomics tick counter.
//
// DETERMINISM: real wasm Rapier is deterministic; the controller writes body
// transforms straight into its OWN transform SAB (never the shared world.ts SoA
// globals), so two controllers given identical authoring + identical per-tick
// input produce byte-identical SAB transforms. (Proven in p8_sim_worker.ts.)
//
// The thin Worker SHELL at the bottom (the `self.onmessage` <-> controller wiring)
// is browser-UAT: it runs ONLY inside a real dedicated Worker and does NOTHING at
// import (so this module stays Deno-free / portable, and a native test can import
// the controller without the shell touching a Worker global).

import { EntityTable, type CameraLike, type EngineOps, type PhysicsOps, type SceneLike } from "../engine.ts";
import { createEcsWorld } from "../ecs/world.ts";
import { UniformGridSpatialIndex } from "../spatial/index.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills, type CoreSkills } from "../skills/index.ts";
import { LiminaTracer } from "../observability/event.ts";
import { WasmRapierPhysics, type RapierModule } from "./wasm-rapier-physics.ts";
import { SharedTransformStorage } from "./sab-transforms.ts";
import { InputRingBuffer, type InputFrame } from "./sab-ringbuffer.ts";

/** The fixed simulation step (seconds) — the native 1/60 cadence (host.ts FIXED_DT). */
const FIXED_DT = 1 / 60;

/** A broad authoring grant set so `loadWorld` can drive the core authoring skills.
 *  Covers the write/read permissions the world-building + player skills require. */
const DEFAULT_GRANTS: ReadonlySet<string> = new Set([
  "scene.write", "scene.read", "ecs.write", "ecs.read", "three.write", "three.read",
  "physics.write", "physics.read", "player.write", "player.read", "player.configure",
  "world.write", "world.read", "terrain.write", "terrain.read", "asset.write", "material.write",
  "audio.write", "camera.write", "animation.write",
]);

/** One `loadWorld` authoring command. A `skill` command RE-INVOKES a recorded tool
 *  call through the registry (exactly the worldlog replay rule — see replay.ts); a
 *  `physics` command calls an engine physics op directly (for engine-level authoring
 *  with no entity, e.g. `op_physics_create_world` / `op_physics_add_ground`). */
export type AuthorCommand =
  | { kind: "physics"; op: keyof PhysicsOps; args: unknown[] }
  | { kind: "skill"; tool: string; input: unknown; agentId?: string; perms?: Iterable<string> };

/** Buffers handed across the worker<->main handshake. */
export interface SimWorkerBuffers {
  /** The transform SAB (M2) — render-main JOINs it to read poses zero-copy. */
  sab: SharedArrayBuffer | ArrayBuffer;
  /** The input SAB (M3) — render-main JOINs it to publish input frames. */
  input: SharedArrayBuffer | ArrayBuffer;
  /** The status SAB — render-main JOINs it to read the Atomics tick counter. */
  status: SharedArrayBuffer | ArrayBuffer;
}

/** Options for `SimWorkerController.create`. */
export interface SimWorkerCreateOptions {
  /** The injected rapier-compat module namespace (M1 needs the value; the native
   *  loader cannot resolve its bare specifier, so the caller imports + injects it). */
  rapier: RapierModule;
  /** JOIN an existing transform SAB (render-main allocated it) instead of allocating. */
  sab?: SharedArrayBuffer | ArrayBuffer;
  /** JOIN an existing input SAB instead of allocating. */
  inputBuffer?: SharedArrayBuffer | ArrayBuffer;
  /** Permissions `loadWorld` invokes authoring skills with (default DEFAULT_GRANTS). */
  grants?: Iterable<string>;
  width?: number;
  height?: number;
}

const STATUS_INTS = 4; // slot 0 = tick counter; rest reserved.
const TICK_INDEX = 0;

/** A headless no-op scene stub — the worker has no renderer, but skills that touch
 *  `world.scene` (e.g. scene.createEntity's `scene.add(mesh)`) must not crash. */
function stubScene(): SceneLike {
  return {
    position: { set(): void {}, x: 0, y: 0, z: 0 },
    add(): void {},
    remove(): void {},
    background: null,
  };
}

/** A headless no-op camera stub. */
function stubCamera(): CameraLike {
  return {
    position: { set(): void {} },
    aspect: 1,
    lookAt(): void {},
    updateProjectionMatrix(): void {},
  };
}

/** Compose the worker's `EngineOps`: the live wasm-Rapier physics ops bound to the
 *  M1 adapter, and inert stubs for every surface a headless worker lacks (render,
 *  input device, host services, trace, sandbox, audio). Skills read `ctx.world.ops`,
 *  so this is the single op seam the whole sim composes over — no `Deno.core.ops`. */
function composeWorkerOps(P: WasmRapierPhysics): EngineOps {
  const noop = (): void => {};
  return {
    // ── physics: the REAL wasm-Rapier solver (bound so `this` is the adapter) ──
    op_physics_create_world: P.op_physics_create_world.bind(P),
    op_physics_add_ground: P.op_physics_add_ground.bind(P),
    op_physics_add_box: P.op_physics_add_box.bind(P),
    op_physics_add_box_material: P.op_physics_add_box_material.bind(P),
    op_physics_add_sphere: P.op_physics_add_sphere.bind(P),
    op_physics_add_capsule: P.op_physics_add_capsule.bind(P),
    op_physics_add_static_box: P.op_physics_add_static_box.bind(P),
    op_physics_add_static_sphere: P.op_physics_add_static_sphere.bind(P),
    op_physics_add_static_capsule: P.op_physics_add_static_capsule.bind(P),
    op_physics_add_heightfield: P.op_physics_add_heightfield.bind(P),
    op_physics_add_character: P.op_physics_add_character.bind(P),
    op_physics_move_character: P.op_physics_move_character.bind(P),
    op_physics_remove_body: P.op_physics_remove_body.bind(P),
    op_physics_apply_impulse: P.op_physics_apply_impulse.bind(P),
    op_physics_step: P.op_physics_step.bind(P),
    op_physics_snapshot: P.op_physics_snapshot.bind(P),
    op_physics_restore: P.op_physics_restore.bind(P),
    op_physics_body_pos: P.op_physics_body_pos.bind(P),
    op_physics_body_transform: P.op_physics_body_transform.bind(P),
    op_physics_drain_collisions: P.op_physics_drain_collisions.bind(P),
    op_physics_raycast: P.op_physics_raycast.bind(P),
    // ── render / loop / device input — no surface in a worker (input arrives via
    //    the InputRingBuffer, consumed directly in tick(), not these ops) ──
    op_create_window_context: () => ({}),
    op_surface_present: noop,
    op_surface_resize: noop,
    op_set_frame_callback: noop,
    op_set_fixed_step_callback: noop,
    op_set_resize_callback: noop,
    op_input_axes: noop,
    op_input_look: noop,
    op_input_buttons: noop,
    // ── host services ──
    op_log: noop,
    op_http_post: () => Promise.resolve(""),
    op_sleep_ms: () => Promise.resolve(),
    op_read_asset: () => new Uint8Array(0),
    op_sha256: () => "",
    // ── durable trace ──
    op_write_trace: noop,
    op_append_trace: noop,
    op_read_trace: () => "",
    // ── sandbox ──
    op_sandbox_create: () => 0,
    op_sandbox_eval: () => "",
    op_sandbox_destroy: () => false,
    op_sandbox_count: () => 0,
    // ── native ECS spatial ──
    op_ecs_spatial_query_batch: noop,
    // ── audio ──
    op_audio_init: () => 0,
    op_audio_play: () => 0,
    op_audio_ambient: () => 0,
    op_audio_stop: noop,
    op_audio_stop_all: noop,
    op_audio_set_bus_volume: noop,
    op_audio_play_spatial: () => 0,
    op_audio_set_emitter: noop,
    op_audio_set_listener: noop,
    op_audio_set_volume: noop,
    op_audio_speak: () => 0,
    op_audio_play_buffer: () => 0,
  };
}

export class SimWorkerController {
  /** The headless WorldContext skills + the controller operate over. */
  readonly world: WorldContext;
  /** The composed core skills (player controllers, etc.) — handed back for drive. */
  readonly core: CoreSkills;
  /** The skill registry (registerCoreSkills installed). */
  readonly registry: SkillRegistry;

  private readonly physics: WasmRapierPhysics;
  private readonly transformStorage: SharedTransformStorage;
  private readonly inputRing: InputRingBuffer;
  private readonly statusBuffer: SharedArrayBuffer | ArrayBuffer;
  private readonly status: Int32Array;
  private readonly statusShared: boolean;
  private readonly entityTable: EntityTable;
  private readonly grants: ReadonlySet<string>;
  private readonly sessionId = "ses_sim_worker";

  private tickCount = 0;
  private disposed = false;
  private readonly scratch7 = new Float32Array(7);
  private readonly inFrame: InputFrame = { move: [0, 0, 0], look: [0, 0], buttons: [0, 0], tick: 0 };
  private lastInputFrame: InputFrame | null = null;

  private constructor(args: {
    physics: WasmRapierPhysics;
    transforms: SharedTransformStorage;
    inputRing: InputRingBuffer;
    statusBuffer: SharedArrayBuffer | ArrayBuffer;
    statusShared: boolean;
    world: WorldContext;
    core: CoreSkills;
    registry: SkillRegistry;
    entities: EntityTable;
    grants: ReadonlySet<string>;
  }) {
    this.physics = args.physics;
    this.transformStorage = args.transforms;
    this.inputRing = args.inputRing;
    this.statusBuffer = args.statusBuffer;
    this.status = new Int32Array(args.statusBuffer, 0, STATUS_INTS);
    this.statusShared = args.statusShared;
    this.world = args.world;
    this.core = args.core;
    this.registry = args.registry;
    this.entityTable = args.entities;
    this.grants = args.grants;
  }

  /** Build the controller: bring up wasm Rapier (M1), allocate/join the transform
   *  (M2) + input (M3) SABs, build the ECS world + EntityTable, and a registry with
   *  the core skill set bound to a headless WorldContext over the wasm-physics ops.
   *  No physics world exists yet — `loadWorld` issues `op_physics_create_world`. */
  static async create(opts: SimWorkerCreateOptions): Promise<SimWorkerController> {
    const physics = await WasmRapierPhysics.create(opts.rapier);
    const transforms = new SharedTransformStorage(opts.sab !== undefined ? { buffer: opts.sab } : {});
    const inputRing = new InputRingBuffer(opts.inputBuffer !== undefined ? { buffer: opts.inputBuffer } : {});

    const statusShared = typeof SharedArrayBuffer === "function" && typeof Atomics !== "undefined";
    const statusBuffer: SharedArrayBuffer | ArrayBuffer = statusShared
      ? new SharedArrayBuffer(STATUS_INTS * Int32Array.BYTES_PER_ELEMENT)
      : new ArrayBuffer(STATUS_INTS * Int32Array.BYTES_PER_ELEMENT);

    const ecs = createEcsWorld();
    const entities = new EntityTable();
    const ops = composeWorkerOps(physics);

    const world: WorldContext = {
      ecs,
      transforms,
      spatial: new UniformGridSpatialIndex(),
      entities,
      tags: new Map(),
      scene: stubScene(),
      camera: stubCamera(),
      ops,
      width: opts.width ?? 1,
      height: opts.height ?? 1,
      mode: "headless",
    };

    const registry = new SkillRegistry(new LiminaTracer("ses_sim_worker"));
    const core = registerCoreSkills(registry);

    return new SimWorkerController({
      physics, transforms, inputRing, statusBuffer, statusShared,
      world, core, registry, entities,
      grants: opts.grants !== undefined ? new Set(opts.grants) : DEFAULT_GRANTS,
    });
  }

  /** Author (or replay) a world into the sim: each command either RE-INVOKES a
   *  recorded skill through the registry (the worldlog replay rule) or calls an
   *  engine physics op directly. After authoring, the initial body transforms are
   *  synced into the transform SAB so the render thread frames the world before the
   *  first tick. Returns the per-command results (skill result / physics-op return). */
  async loadWorld(commands: AuthorCommand[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const cmd of commands) {
      if (cmd.kind === "physics") {
        const fn = (this.world.ops as unknown as Record<string, (...a: unknown[]) => unknown>)[cmd.op];
        results.push(fn(...cmd.args));
        continue;
      }
      const res = await this.registry.invoke(cmd.tool, cmd.input, {
        agentId: cmd.agentId ?? "author",
        sessionId: this.sessionId,
        permissions: cmd.perms !== undefined ? new Set(cmd.perms) : this.grants,
        tick: this.tickCount,
        world: this.world,
        causedBy: [],
      });
      if (!res.success) {
        throw new Error(`loadWorld: skill '${cmd.tool}' failed: ${res.error?.message ?? "unknown error"}`);
      }
      results.push(res.result);
    }
    this.syncTransforms();
    return results;
  }

  /** Advance the simulation ONE fixed step:
   *    1. read the most-recently-published input frame (1-frame latency by design),
   *    2. drive the player character controller (if one is spawned) with it,
   *    3. `op_physics_step` (integrate dynamics + commit queued kinematic moves),
   *    4. sync every live body transform into the transform SAB (render sees it),
   *    5. bump the Atomics tick counter.
   *  Returns the new tick number. */
  tick(): number {
    if (this.disposed) return this.tickCount; // torn down — never step a released world
    const frame = this.inputRing.readLatest(this.inFrame);
    this.lastInputFrame = frame;

    // Drive the first registered player controller, if any. A null frame -> a zero
    // command, so gravity still integrates and the character stays grounded
    // deterministically each tick.
    const playerIds = this.core.player.controllers.ids();
    if (playerIds.length > 0) {
      const entry = this.core.player.controllers.get(playerIds[0]);
      if (entry !== undefined) {
        entry.controller.step(
          frame !== null
            ? {
              // move = [strafe, vertical, forward]; look[0] = heading yaw.
              forward: frame.move[2],
              strafe: frame.move[0],
              yaw: frame.look[0],
              run: frame.buttons[1] > 0.5,
              jump: frame.buttons[0] > 0.5,
            }
            : { forward: 0, strafe: 0, yaw: 0, run: false, jump: false },
          FIXED_DT,
        );
      }
    }

    this.world.ops.op_physics_step();
    this.syncTransforms();

    this.tickCount++;
    if (this.statusShared) Atomics.store(this.status, TICK_INDEX, this.tickCount);
    else this.status[TICK_INDEX] = this.tickCount;
    return this.tickCount;
  }

  /** Tear the controller down (shell `stop`): mark it disposed so no later `tick()`
   *  steps the released world, and drop the retained input frame. Idempotent.
   *  Releasing the controller reference afterward lets the joined SABs be collected.
   *  NOTE: the live wasm-Rapier world's solver state lives in wasm linear memory the
   *  JS GC does not reclaim; freeing it needs a public `dispose()`/`free()` on
   *  WasmRapierPhysics (not owned here) that `this.physics` would forward to. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lastInputFrame = null;
  }

  /** Copy every live body/entity transform from the physics solver into the
   *  transform SAB (SoA), keyed by ECS eid — the worker's WRITE half of the M2
   *  zero-copy bridge. Writes the SAB directly (not the world.ts SoA globals), so
   *  parallel controllers stay independent + deterministic. */
  private syncTransforms(): void {
    const scratch = this.scratch7;
    for (const id of this.entityTable.ids()) {
      const entry = this.entityTable.resolve(id);
      if (entry === undefined || entry.bodyId === undefined) continue;
      this.world.ops.op_physics_body_transform(entry.bodyId, scratch);
      this.transformStorage.writePosition(entry.eid, scratch[0], scratch[1], scratch[2]);
      this.transformStorage.writeRotation(entry.eid, scratch[3], scratch[4], scratch[5], scratch[6]);
    }
  }

  /** The completed fixed-step count (read via Atomics — cross-thread visible).
   *  Named `ticks` because `tick()` is the step method (a class cannot expose both
   *  a `tick()` method and a `tick` getter); `tick()` ALSO returns the new count. */
  get ticks(): number {
    return this.statusShared ? Atomics.load(this.status, TICK_INDEX) : this.status[TICK_INDEX];
  }

  /** The M2 transform storage (the render thread reads its `.Position`/`.Rotation`). */
  get transforms(): SharedTransformStorage {
    return this.transformStorage;
  }

  /** The entity table (resolve an authored entity id -> its eid/bodyId). */
  get entities(): EntityTable {
    return this.entityTable;
  }

  /** The buffers to post across the worker handshake. */
  get buffers(): SimWorkerBuffers {
    return { sab: this.transformStorage.buffer, input: this.inputRing.buffer, status: this.statusBuffer };
  }

  /** The input frame consumed at the most recent `tick()` (null if none / pre-tick).
   *  A fresh copy each call so callers can retain it across ticks. */
  get lastInput(): InputFrame | null {
    const f = this.lastInputFrame;
    return f === null ? null : { move: [...f.move], look: [...f.look], buttons: [...f.buttons], tick: f.tick };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Thin Worker SHELL (browser-UAT). Wires `self.onmessage` -> controller and
// `postMessage` <- controller. Import-only: NOTHING runs at module load; the
// auto-install at the very bottom fires ONLY inside a real dedicated Worker, so a
// native test importing `SimWorkerController` never touches a Worker global.
// ───────────────────────────────────────────────────────────────────────────────

interface WorkerScopeLike {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

type InitMessage = {
  type: "init";
  sab?: SharedArrayBuffer | ArrayBuffer;
  inputBuffer?: SharedArrayBuffer | ArrayBuffer;
  commands?: AuthorCommand[];
  hz?: number;
};
type StepMessage = { type: "step" };
type StopMessage = { type: "stop" };
type ShellMessage = InitMessage | StepMessage | StopMessage;

/** Install the Worker message wiring on a worker global. `init` builds the
 *  controller (importing rapier-compat — resolved by the browser bundle, never the
 *  native loader, since this runs only inside a real Worker), authors any supplied
 *  world, replies `ready` with the handshake buffers, then self-drives a fixed-step
 *  interval (or steps on demand). `postMessage` acks each tick. */
export function installSimWorker(scope: WorkerScopeLike): void {
  let controller: SimWorkerController | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  /** Post a structured error to the main thread so a throw is observable rather
   *  than a silent unhandledrejection (which would stop stepping unseen). */
  const postError = (phase: string, err: unknown): void => {
    const e = err as { message?: unknown; stack?: unknown } | null;
    scope.postMessage({
      type: "error",
      phase,
      message: typeof e?.message === "string" ? e.message : String(err),
      stack: typeof e?.stack === "string" ? e.stack : undefined,
    });
  };

  /** Fully tear down what `init` brought up: stop the self-drive interval and
   *  dispose + release the controller (so its joined SABs can be collected). */
  const teardown = (): void => {
    if (timer !== undefined) { clearInterval(timer); timer = undefined; }
    if (controller !== null) { controller.dispose(); controller = null; }
  };

  scope.onmessage = (ev: { data: unknown }): void => {
    const msg = ev.data as ShellMessage;
    void (async (): Promise<void> => {
      if (msg.type === "init") {
        const rapier = (await import("@dimforge/rapier3d-compat")) as unknown as RapierModule;
        controller = await SimWorkerController.create({ rapier, sab: msg.sab, inputBuffer: msg.inputBuffer });
        if (msg.commands !== undefined) await controller.loadWorld(msg.commands);
        const b = controller.buffers;
        scope.postMessage({ type: "ready", buffer: b.sab, inputBuffer: b.input, status: b.status });
        const hz = msg.hz ?? 60;
        timer = setInterval((): void => {
          if (controller === null) return;
          try {
            scope.postMessage({ type: "tick", tick: controller.tick() });
          } catch (err) {
            // A solver throw inside the timer would otherwise silently kill stepping —
            // stop the now-broken sim and surface it to the main thread.
            teardown();
            postError("tick", err);
          }
        }, 1000 / hz);
      } else if (msg.type === "step") {
        if (controller !== null) scope.postMessage({ type: "tick", tick: controller.tick() });
      } else if (msg.type === "stop") {
        teardown();
      }
    })().catch((err) => postError((msg as { type?: string } | null)?.type ?? "message", err));
  };
}

// Auto-install ONLY inside a real dedicated Worker (WorkerGlobalScope present and
// `self` is an instance of it). The short-circuit guards keep this inert — and
// crucially side-effect-free — at plain import / on the native host (no Worker
// global), so the portability guard + headless tests are unaffected.
declare const WorkerGlobalScope: { prototype: unknown } | undefined;
if (
  typeof WorkerGlobalScope !== "undefined" &&
  typeof self !== "undefined" &&
  (self as unknown) instanceof (WorkerGlobalScope as unknown as { prototype: unknown } & (new () => unknown))
) {
  installSimWorker(self as unknown as WorkerScopeLike);
}
