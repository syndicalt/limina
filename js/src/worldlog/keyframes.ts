// Phase 8 export KEYFRAMES — periodic authoritative transform snapshots so a
// browser can REPLAY a native-authored world's motion WITHOUT re-simulating
// physics (W0 proved native↔wasm Rapier diverges in contact scenes). A keyframe
// is pure portable data: each native body's [pos, quat] at a tick, read from the
// same source as captureWorldState (op_physics_body_transform). The browser's
// keyframe-driven PhysicsOps serves op_physics_body_transform from these.

import type { WorldLike } from "./log.ts";

export interface BodyKeyframe {
  /** Native body id (monotonic from 0; the keyframe-driven replay re-allocates
   *  the SAME ids because it re-issues the same add_* commands in order). */
  id: number;
  /** [px,py,pz, qx,qy,qz,qw] — the body's world transform at the keyframe tick. */
  t: [number, number, number, number, number, number, number];
}

export interface Keyframe {
  tick: number;
  bodies: BodyKeyframe[];
}

/** Capture every body-bound entity's native transform at `tick` (reads
 *  op_physics_body_transform — the exact source captureWorldState uses). */
export function captureKeyframe(world: WorldLike, tick: number): Keyframe {
  const scratch = new Float32Array(7);
  const bodies: BodyKeyframe[] = [];
  for (const id of world.entities.ids()) {
    const entry = world.entities.resolve(id);
    if (entry === undefined || entry.bodyId === undefined) continue;
    world.ops.op_physics_body_transform(entry.bodyId, scratch);
    bodies.push({ id: entry.bodyId, t: [scratch[0], scratch[1], scratch[2], scratch[3], scratch[4], scratch[5], scratch[6]] });
  }
  bodies.sort((a, b) => a.id - b.id);
  return { tick, bodies };
}

/** Captures a keyframe every `interval` ticks during a session; always force a
 *  final keyframe at the last tick so playback's END state is exact. */
export class KeyframeRecorder {
  readonly keyframes: Keyframe[] = [];
  private lastTick = -1;
  constructor(readonly interval: number) {
    if (!Number.isInteger(interval) || interval < 1) throw new Error("KeyframeRecorder: interval must be an integer >= 1");
  }
  /** Capture if `tick` is on the interval (and not already captured this tick). */
  maybeCapture(world: WorldLike, tick: number): void {
    if (tick % this.interval === 0) this.capture(world, tick);
  }
  /** Force-capture at `tick` (e.g. the final tick). Idempotent per tick. */
  capture(world: WorldLike, tick: number): void {
    if (tick === this.lastTick) return;
    this.keyframes.push(captureKeyframe(world, tick));
    this.lastTick = tick;
  }
}

// Transforms serialize as their exact Float32 BIT PATTERNS (int32 per component),
// not decimal floats: JSON.stringify loses -0 (-> "0") and NaN/Infinity (-> "null"),
// but compareWorldState is bit-identical (Object.is distinguishes -0 / NaN), so a
// decimal keyframe would silently diverge on any body whose transform lands a -0.
// The in-memory Keyframe stays plain floats; only the wire form is bit-exact.
const _f32 = new Float32Array(1);
const _i32 = new Int32Array(_f32.buffer);
function floatToBits(x: number): number { _f32[0] = x; return _i32[0]; }
function bitsToFloat(i: number): number { _i32[0] = i; return _f32[0]; }

/** JSONL: one keyframe per line, tick-ordered; each transform stored as 7 int32
 *  Float32 bit patterns so the round-trip is bit-exact (incl. -0 / NaN / Inf). */
export function serializeKeyframes(keyframes: Keyframe[]): string {
  if (keyframes.length === 0) return "";
  return keyframes.map((k) => JSON.stringify({
    tick: k.tick,
    bodies: k.bodies.map((b) => ({ id: b.id, b: b.t.map(floatToBits) })),
  })).join("\n") + "\n";
}

export function parseKeyframes(jsonl: string): Keyframe[] {
  const out: Keyframe[] = [];
  const lines = jsonl.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    let k: unknown;
    try {
      k = JSON.parse(line);
    } catch (err) {
      throw new Error(`keyframes: invalid JSON on line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const kf = k as { tick?: unknown; bodies?: unknown };
    if (typeof kf.tick !== "number" || !Array.isArray(kf.bodies)) {
      throw new Error(`keyframes: malformed keyframe on line ${i + 1}`);
    }
    const bodies: BodyKeyframe[] = [];
    for (const rawBody of kf.bodies) {
      const rb = rawBody as { id?: unknown; b?: unknown };
      if (typeof rb.id !== "number" || !Array.isArray(rb.b) || rb.b.length !== 7 || rb.b.some((n) => typeof n !== "number")) {
        throw new Error(`keyframes: malformed body in keyframe on line ${i + 1}`);
      }
      const bits = rb.b as number[];
      bodies.push({ id: rb.id, t: [bitsToFloat(bits[0]), bitsToFloat(bits[1]), bitsToFloat(bits[2]), bitsToFloat(bits[3]), bitsToFloat(bits[4]), bitsToFloat(bits[5]), bitsToFloat(bits[6])] });
    }
    out.push({ tick: kf.tick, bodies });
  }
  out.sort((a, b) => a.tick - b.tick);
  return out;
}
