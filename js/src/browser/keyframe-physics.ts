// Keyframe-driven PhysicsOps for EXPORT PLAYBACK (Phase 8). Instead of simulating
// physics (W0: native↔wasm Rapier diverge in contact scenes), the browser serves
// each body's transform from the recorded keyframe stream. replayCommands re-issues
// the SAME add_*/step/remove commands, so:
//   - add_box/sphere/capsule/static_* re-allocate the SAME monotonic body ids
//     native did (native insert_body assigns len()->id from 0; add_ground is a
//     collider with NO body id; removed ids tombstone and never reuse);
//   - op_physics_step advances the playback tick;
//   - op_physics_body_transform returns the authoritative keyframe transform for
//     (bodyId, tick) — exact at keyframe ticks, step-held in between.

import type { CollisionEventRecord, EngineOps } from "../engine.ts";
import type { Keyframe } from "../worldlog/keyframes.ts";

type Transform7 = [number, number, number, number, number, number, number];

export class KeyframePhysics {
  private nextBodyId = 0;
  private tick = 0;
  /** bodyId -> ascending keyframe ticks + the body's transform at each. */
  private readonly timelines = new Map<number, { ticks: number[]; xforms: Transform7[] }>();

  constructor(keyframes: Keyframe[]) {
    for (const kf of [...keyframes].sort((a, b) => a.tick - b.tick)) {
      for (const b of kf.bodies) {
        let tl = this.timelines.get(b.id);
        if (tl === undefined) { tl = { ticks: [], xforms: [] }; this.timelines.set(b.id, tl); }
        tl.ticks.push(kf.tick);
        tl.xforms.push(b.t);
      }
    }
  }

  /** Current playback tick (advanced by op_physics_step). */
  get currentTick(): number { return this.tick; }

  /** Write the body's transform at the current tick into `out` — the largest
   *  keyframe with tick <= current (step-to-keyframe; exact at keyframe ticks). */
  private lookup(id: number, out: Float32Array): void {
    const tl = this.timelines.get(id);
    if (tl === undefined || tl.ticks.length === 0) { out.fill(0); return; }
    let idx = 0;
    if (this.tick >= tl.ticks[0]) {
      let lo = 0, hi = tl.ticks.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (tl.ticks[mid] <= this.tick) { idx = mid; lo = mid + 1; } else hi = mid - 1;
      }
    }
    const t = tl.xforms[idx];
    for (let i = 0; i < 7; i++) out[i] = t[i];
  }

  // ---- the PhysicsOps surface (structurally matches engine.ts PhysicsOps) ---
  op_physics_create_world(_gravityY: number): void { this.nextBodyId = 0; this.tick = 0; }
  op_physics_add_ground(_y: number): void { /* collider only — no body id (matches native) */ }
  op_physics_add_box(): number { return this.nextBodyId++; }
  op_physics_add_box_material(): number { return this.nextBodyId++; }
  op_physics_add_sphere(): number { return this.nextBodyId++; }
  op_physics_add_capsule(): number { return this.nextBodyId++; }
  op_physics_add_static_box(): number { return this.nextBodyId++; }
  op_physics_add_static_sphere(): number { return this.nextBodyId++; }
  op_physics_add_static_capsule(): number { return this.nextBodyId++; }
  op_physics_remove_body(_id: number): void { /* tombstone: ids never reused (matches native) */ }
  op_physics_apply_impulse(): void { /* motion comes from keyframes, not impulses */ }
  op_physics_step(): void { this.tick++; }
  op_physics_body_transform(id: number, out: Float32Array): void { this.lookup(id, out); }
  op_physics_body_pos(id: number, out: Float32Array): void {
    const s = new Float32Array(7); this.lookup(id, s); out[0] = s[0]; out[1] = s[1]; out[2] = s[2];
  }
  op_physics_drain_collisions(): CollisionEventRecord[] { return []; }
  op_physics_raycast(_ox: number, _oy: number, _oz: number, _dx: number, _dy: number, _dz: number, maxToi: number, out: Float32Array): void {
    out[0] = maxToi; out[1] = 0; out[2] = 0; out[3] = -1; // no-hit
  }
  op_physics_snapshot(): Uint8Array { return new Uint8Array(0); }
  op_physics_restore(_bytes: Uint8Array): void { /* not used in playback */ }
}

/** Compose a full EngineOps for playback: the keyframe-driven physics + safe
 *  no-op stubs for everything else, overridable (the browser host overrides the
 *  render + trace surfaces). Used by the headless parity test and the browser
 *  runtime alike. Explicit (no Proxy) so the physics hot path stays direct. */
export function playbackOps(physics: KeyframePhysics, overrides: Partial<EngineOps> = {}): EngineOps {
  const noop = (): void => {};
  const base: EngineOps = {
    // physics — the keyframe-driven implementation
    op_physics_create_world: (g) => physics.op_physics_create_world(g),
    op_physics_add_ground: (y) => physics.op_physics_add_ground(y),
    op_physics_add_box: () => physics.op_physics_add_box(),
    op_physics_add_box_material: () => physics.op_physics_add_box_material(),
    op_physics_add_sphere: () => physics.op_physics_add_sphere(),
    op_physics_add_capsule: () => physics.op_physics_add_capsule(),
    op_physics_add_static_box: () => physics.op_physics_add_static_box(),
    op_physics_add_static_sphere: () => physics.op_physics_add_static_sphere(),
    op_physics_add_static_capsule: () => physics.op_physics_add_static_capsule(),
    op_physics_remove_body: (id) => physics.op_physics_remove_body(id),
    op_physics_apply_impulse: () => physics.op_physics_apply_impulse(),
    op_physics_step: () => physics.op_physics_step(),
    op_physics_snapshot: () => physics.op_physics_snapshot(),
    op_physics_restore: (b) => physics.op_physics_restore(b),
    op_physics_body_pos: (id, out) => physics.op_physics_body_pos(id, out),
    op_physics_body_transform: (id, out) => physics.op_physics_body_transform(id, out),
    op_physics_drain_collisions: () => physics.op_physics_drain_collisions(),
    op_physics_raycast: (ox, oy, oz, dx, dy, dz, maxToi, out) => physics.op_physics_raycast(ox, oy, oz, dx, dy, dz, maxToi, out),
    // render / loop / input — stubs (browser host overrides)
    op_create_window_context: () => ({}),
    op_surface_present: noop,
    op_surface_resize: noop,
    op_set_frame_callback: noop,
    op_set_fixed_step_callback: noop,
    op_set_resize_callback: noop,
    op_input_axes: noop,
    // host services
    op_log: noop,
    op_http_post: () => Promise.resolve(""),
    op_sleep_ms: () => Promise.resolve(),
    op_read_asset: () => new Uint8Array(0),
    op_sha256: () => "",
    // durable trace — stubs (browser host overrides with IndexedDB)
    op_write_trace: noop,
    op_append_trace: noop,
    op_read_trace: () => "",
    // sandbox
    op_sandbox_create: () => 0,
    op_sandbox_eval: () => "",
    op_sandbox_destroy: () => false,
    op_sandbox_count: () => 0,
    // native ECS spatial
    op_ecs_spatial_query_batch: noop,
    // audio
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
  return { ...base, ...overrides };
}
