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

/** Render-side suspension gate shared by runLive and its headless render-spy proof. */
export function shouldRenderLiveFrame(viewSuspended: boolean): boolean {
  return viewSuspended === false;
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
export function composeAuthoringOps(P: WasmRapierPhysics, readAsset: (id: string) => Uint8Array = () => new Uint8Array(0)): EngineOps {
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
    op_physics_set_body_transform: P.op_physics_set_body_transform.bind(P),
    op_physics_drain_collisions: P.op_physics_drain_collisions.bind(P),
    op_physics_raycast: P.op_physics_raycast.bind(P),
    op_physics_overlap_box: P.op_physics_overlap_box.bind(P),
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
    op_http_post_headers: () => Promise.resolve(""),
    op_sleep_ms: () => Promise.resolve(),
    // AssetRegistry is synchronous, so the caller prefetches known command assets
    // before authoring and provides an in-memory reader. A miss returns empty bytes;
    // browser I/O never blocks the render thread.
    op_read_asset: readAsset,
    op_sha256: () => "",
    op_read_env: () => "",
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
  private readonly present: Set<number>;
  private eids: number[];
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

  /** Add newly-authored eids to future freezes/interpolations without rebuilding
   *  the viewport. Existing eids are ignored so command retries or multi-source
   *  capture paths cannot duplicate per-frame work. */
  addEids(newEids: Iterable<number>): void {
    for (const eid of newEids) {
      if (this.present.has(eid)) continue;
      this.present.add(eid);
      this.eids.push(eid);
    }
  }

  /** Drop eids (a destroyed entity) from future freezes/interpolations so a removed
   *  mesh's stale transform is never re-applied — the counterpart to addEids that lets
   *  a delete hot-remove one entity instead of rebooting the whole viewport. */
  removeEids(gone: Iterable<number>): void {
    for (const eid of gone) {
      if (!this.present.delete(eid)) continue;
      const i = this.eids.indexOf(eid);
      if (i !== -1) this.eids.splice(i, 1);
    }
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

interface KeyEventLike {
  key: string;
  preventDefault(): void;
  target?: { tagName?: string; isContentEditable?: boolean } | null;
}
interface EventTargetLike {
  addEventListener(type: string, cb: (ev: KeyEventLike) => void): void;
  removeEventListener(type: string, cb: (ev: KeyEventLike) => void): void;
}
/** A pointer-lock capable element (the canvas): request lock on click, and its owner document
 *  delivers the locked mouse deltas + reports which element holds the lock. */
interface MouseEventLike { movementX?: number; movementY?: number }
interface DocumentLike {
  pointerLockElement?: unknown;
  addEventListener(type: string, cb: (ev: MouseEventLike) => void): void;
  removeEventListener(type: string, cb: (ev: MouseEventLike) => void): void;
}
interface PointerTargetLike {
  ownerDocument?: DocumentLike | null;
  requestPointerLock?: () => void;
  addEventListener(type: string, cb: (ev: MouseEventLike) => void): void;
  removeEventListener(type: string, cb: (ev: MouseEventLike) => void): void;
}

/** True when a key event targets an editable field (the chat textarea, inspector inputs).
 *  Player controls are bound globally on `window`, so without this guard wasd/space are
 *  captured + preventDefault'd while the user is typing — swallowing those keys in chat. */
function isEditableKeyTarget(ev: KeyEventLike): boolean {
  const t = ev.target;
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Mouse-look sensitivity (radians per pixel of pointer-locked movement). */
const MOUSE_SENSITIVITY = 0.0025;
/** First-person pitch clamps (radians): look up to ~26°, down to ~-69°. */
const MIN_PITCH = -1.2;
const MAX_PITCH = 0.45;
/** Initial pitch — level, with a hair of downward look. */
const INITIAL_PITCH = -0.05;

/**
 * The render-main input producer for the live walk. Standard first-person / MMO scheme:
 *   • W/S — walk forward / back (along the current heading).
 *   • A/D — STRAFE left / right (no turn; turning is the mouse's job).
 *   • Mouse (pointer-locked on the canvas) — X yaws the view, Y pitches it.
 *   • Shift — run, Space — jump.
 * `heading` (look[0]) is the yaw the sim rotates W/S+strafe by AND the camera yaw; `pitch` (look[1])
 * drives the camera pitch. Heading + pitch accumulate from the mouse only (event-driven).
 */
export class LivePlayerInput {
  private readonly pressed = new Set<string>();
  private heading = 0;
  private pitch = INITIAL_PITCH;
  private readonly tracked = "wasd ";
  private pointerTarget: PointerTargetLike | null = null;
  private pointerDoc: DocumentLike | null = null;

  private readonly onDown = (ev: KeyEventLike): void => {
    if (isEditableKeyTarget(ev)) return; // typing in chat/inspector — don't capture wasd/space
    const k = ev.key === " " ? " " : ev.key.toLowerCase();
    const key = k === "shift" || ev.key === "Shift" ? "shift" : k;
    if (this.tracked.includes(k) || key === "shift") { this.pressed.add(key); ev.preventDefault(); }
  };
  private readonly onUp = (ev: KeyEventLike): void => {
    const k = ev.key === " " ? " " : ev.key.toLowerCase();
    this.pressed.delete(k === "shift" || ev.key === "Shift" ? "shift" : k);
  };

  /** Request pointer lock on the canvas so mouse-look engages (browser gesture requirement). */
  private readonly onClick = (): void => {
    this.pointerTarget?.requestPointerLock?.();
  };
  /** Accumulate yaw (movementX) + pitch (movementY) ONLY while the canvas holds the pointer lock. */
  private readonly onMouseMove = (ev: MouseEventLike): void => {
    if (this.pointerDoc?.pointerLockElement !== this.pointerTarget) return;
    this.heading += (ev.movementX ?? 0) * MOUSE_SENSITIVITY;
    this.pitch -= (ev.movementY ?? 0) * MOUSE_SENSITIVITY;
    if (this.pitch < MIN_PITCH) this.pitch = MIN_PITCH;
    if (this.pitch > MAX_PITCH) this.pitch = MAX_PITCH;
  };

  /** Bind the KEYBOARD (typically `window`, matching the editor viewport). */
  attach(target: EventTargetLike): void {
    target.addEventListener("keydown", this.onDown);
    target.addEventListener("keyup", this.onUp);
  }
  detach(target: EventTargetLike): void {
    target.removeEventListener("keydown", this.onDown);
    target.removeEventListener("keyup", this.onUp);
  }

  /** Bind MOUSE-LOOK to the canvas: click captures the pointer, then locked mouse deltas turn the
   *  heading + pitch the camera. Safe to skip (e.g. no canvas) — keyboard turn (A/D) still works. */
  attachPointer(canvas: PointerTargetLike | null | undefined): void {
    if (!canvas || typeof canvas.addEventListener !== "function") return;
    this.pointerTarget = canvas;
    this.pointerDoc = canvas.ownerDocument ?? null;
    canvas.addEventListener("click", this.onClick);
    this.pointerDoc?.addEventListener("mousemove", this.onMouseMove);
  }
  detachPointer(): void {
    this.pointerTarget?.removeEventListener("click", this.onClick);
    this.pointerDoc?.removeEventListener("mousemove", this.onMouseMove);
    this.pointerTarget = null;
    this.pointerDoc = null;
  }

  /** Build the current input frame. Heading comes purely from the mouse; A/D strafe.
   *  `tick` stamps the producer's frame (latency observability). */
  frame(tick: number, out?: InputFrame): InputFrame {
    const p = this.pressed;
    const forward = (p.has("w") ? 1 : 0) - (p.has("s") ? 1 : 0);
    // A/D STRAFE (D = right, A = left); the character controller rotates strafe into world
    // space by the mouse heading (character.ts: +strafe = right). No keyboard turn.
    const strafe = (p.has("d") ? 1 : 0) - (p.has("a") ? 1 : 0);
    const jump = p.has(" ") ? 1 : 0;
    const run = p.has("shift") ? 1 : 0;
    const f = out ?? { move: [0, 0, 0], look: [0, 0], buttons: [0, 0], tick: 0 };
    f.move[0] = strafe; f.move[1] = 0; f.move[2] = forward;
    f.look[0] = this.heading; f.look[1] = this.pitch;
    f.buttons[0] = jump; f.buttons[1] = run;
    f.tick = tick;
    return f;
  }
}
