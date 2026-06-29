// Phase 8 Mode-B — M5: the RENDER-MAIN half of the live in-browser runtime.
//
// `runLive` (browser-entry.ts) spawns the M3 sim-worker (the authoritative
// fixed-step solver) and renders its output on the main thread. This module is
// the PURE, portable, Deno-free composition the render side needs — split out of
// browser-entry.ts so it carries no THREE import (THREE pulls browser globals at
// its own module top level) and is unit-testable without a renderer:
//
//   • crossOriginIsolatedAvailable() — the SAB cross-origin-isolation gate (no
//     COOP/COEP ⇒ no SharedArrayBuffer ⇒ no zero-copy bridge ⇒ runLive degrades).
//   • composeAuthoringOps(physics)   — the render-main authoring op surface: the
//     REAL wasm-Rapier ops (M1) so re-authoring the command log builds the SAME
//     entities (matching eids) + real meshes, plus inert stubs for the surfaces a
//     render-main authoring pass never drives. NEVER stepped here — the worker is
//     authoritative; this pass exists only to materialise the scene meshes and to
//     allocate eids byte-identically to the worker (deterministic authoring).
//   • SnapshotRing — the render side of the M4 interpolation contract. The worker
//     writes only the LATEST tick into the transform SAB (it overwrites in place),
//     but FrameInterpolator needs TWO frozen snapshots (prev@N, curr@N+1). This
//     ring freezes the live SAB into one of two ping-pong stores each consumed
//     tick, so prev and curr never alias. Scale is filled from the authored
//     transforms (the worker syncs position+rotation only — scale is static), so a
//     constant scale interpolates to itself and meshes keep their authored size.
//
// PORTABILITY (Seam 4): no `Deno.*` anywhere; SAB/Atomics are web primitives and
// are feature-detected. Nothing runs at module import.

import type { EngineOps } from "../engine.ts";
import type { WasmRapierPhysics } from "./wasm-rapier-physics.ts";
import { SharedTransformStorage } from "./sab-transforms.ts";
import type { TransformSnapshot, TransformStore } from "./frame-interpolator.ts";
import type { InputFrame } from "./sab-ringbuffer.ts";

/** True iff this context is cross-origin-isolated, the browser precondition for a
 *  usable `SharedArrayBuffer` (set only when the page is served with
 *  `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
 *  require-corp`). Off a browser (or without the headers) this is false and the
 *  caller degrades gracefully instead of constructing a non-shared bridge that
 *  cannot cross the worker boundary zero-copy. */
export function crossOriginIsolatedAvailable(): boolean {
  const g = globalThis as unknown as { crossOriginIsolated?: boolean; SharedArrayBuffer?: unknown };
  return g.crossOriginIsolated === true && typeof g.SharedArrayBuffer === "function";
}

/** Compose the render-main AUTHORING op surface: the live wasm-Rapier physics ops
 *  (so re-authoring the command log creates the same bodies → the same eids → the
 *  same meshes as the worker), and inert stubs for every other engine surface. The
 *  physics world built here is NEVER stepped (the worker owns simulation); it only
 *  makes `scene.createEntity` / `player.spawn` author deterministically. Mirrors
 *  the worker's own op composition so both threads author byte-identically.
 *
 *  This is intentionally a parallel of `composeWorkerOps` (sim-worker.ts) rather
 *  than an import of it: the worker module's shell auto-installs on a WorkerGlobalScope
 *  and that composition is its private detail; the render side owns its own. */
export function composeAuthoringOps(P: WasmRapierPhysics): EngineOps {
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
    // ── render / loop / device input — the render-main renderer is built directly
    //    via THREE.WebGPURenderer (buildRenderTarget), not through these ops; input
    //    is pumped into the SAB ring, not these device hooks ──
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

/**
 * The render-side double-buffer for M4 interpolation. The worker overwrites the
 * single transform SAB in place each tick, so a render thread that wants to tween
 * tick N → tick N+1 must FREEZE each consumed tick. `SnapshotRing` keeps two
 * detached stores and ping-pongs between them: `freeze()` copies the live SAB's
 * Position+Rotation (the only channels the worker writes) for the given eids into
 * the next store, fills Scale from the authored (static) scale source, and returns
 * a `TransformSnapshot` over it. Feed each returned snapshot to
 * `FrameInterpolator.push` — `prev` (the other store) and `curr` never alias, so
 * the tween reads two genuinely distinct tick states.
 */
export class SnapshotRing {
  private readonly stores: [SharedTransformStorage, SharedTransformStorage];
  private readonly present: ReadonlySet<number>;
  private readonly eids: number[];
  private readonly scaleSrc: TransformStore;
  private which = 0;

  /** @param eids the live entity eids to mirror each tick (the authored set).
   *  @param scaleSrc the authored transform store carrying the static per-eid scale
   *         (the worker never writes scale; this keeps meshes at authored size). */
  constructor(eids: Iterable<number>, scaleSrc: TransformStore) {
    this.eids = [...eids];
    this.present = new Set(this.eids);
    this.scaleSrc = scaleSrc;
    // Two detached (non-shared) stores — plain ArrayBuffer backing is fine; they are
    // render-thread-local freeze targets, never posted across a thread boundary.
    this.stores = [new SharedTransformStorage(), new SharedTransformStorage()];
  }

  /** The set of eids every snapshot carries (for `FrameInterpolator.interpolate`). */
  get presentSet(): ReadonlySet<number> {
    return this.present;
  }

  /** Freeze the live SAB (`src`) into the next ping-pong store and return a snapshot.
   *  Copies Position+Rotation from `src` (the worker's writes) and Scale from the
   *  authored static source, for every tracked eid. */
  freeze(src: TransformStore): TransformSnapshot {
    const dst = this.stores[this.which];
    this.which ^= 1;
    const sp = src.Position, sr = src.Rotation;
    const dp = dst.Position, dr = dst.Rotation, ds = dst.Scale;
    const cs = this.scaleSrc.Scale;
    for (const eid of this.eids) {
      dp.x[eid] = sp.x[eid]; dp.y[eid] = sp.y[eid]; dp.z[eid] = sp.z[eid];
      dr.x[eid] = sr.x[eid]; dr.y[eid] = sr.y[eid]; dr.z[eid] = sr.z[eid]; dr.w[eid] = sr.w[eid];
      ds.x[eid] = cs.x[eid]; ds.y[eid] = cs.y[eid]; ds.z[eid] = cs.z[eid];
    }
    return { store: dst, present: this.present };
  }
}

// ── DOM → InputRingBuffer producer (the render-main input pump) ───────────────
// Reads the keyboard each frame and produces an `InputFrame` the worker consumes
// (move = [strafe, vertical, forward]; look[0] = heading yaw; buttons = [jump,
// run]) — exactly the mapping SimWorkerController.tick() expects. Listeners attach
// only on `attach()`, never at import, so this module stays side-effect-free.
// A minimal ambient event surface keeps it compilable without the DOM lib.

interface KeyEventLike { key: string; preventDefault(): void; }
interface EventTargetLike {
  addEventListener(type: string, cb: (ev: KeyEventLike) => void): void;
  removeEventListener(type: string, cb: (ev: KeyEventLike) => void): void;
}

/** Yaw turn rate (radians per frame at full deflection) for the Q/E heading keys. */
const YAW_RATE = 0.03;

export class LivePlayerInput {
  private readonly pressed = new Set<string>();
  private heading = 0;
  private readonly tracked = "wasdqe ";
  private readonly onDown = (ev: KeyEventLike): void => {
    const k = ev.key === " " ? " " : ev.key.toLowerCase();
    const key = k === "shift" || ev.key === "Shift" ? "shift" : k;
    if (this.tracked.includes(k) || key === "shift") { this.pressed.add(key); ev.preventDefault(); }
  };
  private readonly onUp = (ev: KeyEventLike): void => {
    const k = ev.key === " " ? " " : ev.key.toLowerCase();
    this.pressed.delete(k === "shift" || ev.key === "Shift" ? "shift" : k);
  };

  attach(target: EventTargetLike): void {
    target.addEventListener("keydown", this.onDown);
    target.addEventListener("keyup", this.onUp);
  }
  detach(target: EventTargetLike): void {
    target.removeEventListener("keydown", this.onDown);
    target.removeEventListener("keyup", this.onUp);
  }

  /** Build the current input frame, advancing the accumulated heading from Q/E.
   *  `tick` stamps the producer's frame (latency observability). */
  frame(tick: number, out?: InputFrame): InputFrame {
    const p = this.pressed;
    const forward = (p.has("w") ? 1 : 0) - (p.has("s") ? 1 : 0);
    const strafe = (p.has("d") ? 1 : 0) - (p.has("a") ? 1 : 0);
    this.heading += ((p.has("e") ? 1 : 0) - (p.has("q") ? 1 : 0)) * YAW_RATE;
    const jump = p.has(" ") ? 1 : 0;
    const run = p.has("shift") ? 1 : 0;
    const f = out ?? { move: [0, 0, 0], look: [0, 0], buttons: [0, 0], tick: 0 };
    f.move[0] = strafe; f.move[1] = 0; f.move[2] = forward;
    f.look[0] = this.heading; f.look[1] = 0;
    f.buttons[0] = jump; f.buttons[1] = run;
    f.tick = tick;
    return f;
  }
}
