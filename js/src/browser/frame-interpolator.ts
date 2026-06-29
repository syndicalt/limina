// Phase 8 Mode-B M4 — RENDER-thread FRAME INTERPOLATION.
//
// The sim-worker advances the ECS at a FIXED 1/60 step (host.ts FIXED_DT). The
// render thread runs faster (rAF, e.g. 144Hz) and must show motion BETWEEN ticks:
// the windowed accumulator (host.ts startAccumulatorLoop) emits a leftover factor
// `alpha = accumulator / FIXED_DT` in [0,1). This module is that `Frame(alpha)`
// made physical — it tweens each live entity's transform from the PREVIOUS tick
// state (N, `prev`) toward the CURRENT (N+1, `curr`) by `alpha`, writing the
// result into the RENDER store that renderSyncSystem (ecs/world.ts) reads.
//
// Math is pure and deterministic — no Date.now / Math.random, only +,-,*,/ and
// Math.sqrt (IEEE-754 requires sqrt be correctly-rounded, so same inputs give the
// same bits on any conforming engine). Position is a linear lerp; rotation is a
// SHORTEST-PATH normalized quaternion lerp (nlerp) — NOT a raw component lerp,
// which would drift off the unit sphere and shrink the rotation. nlerp (not slerp)
// is chosen deliberately: slerp needs acos/sin (not correctly-rounded, engine-
// variant) and is overkill for the sub-1/60s arcs between fixed ticks, where nlerp
// is visually indistinguishable and provably bit-stable.
//
// This module is THREE-free and side-effect-free at import (Phase-6 portability
// guard): it touches no browser global and allocates nothing at module top-level.

/** SoA transform arrays for one set of entities. The module-level
 *  {Position,Rotation,Scale} of ecs/world.ts satisfy this structurally, as do any
 *  SharedArrayBuffer-backed views the worker double-buffers. */
export interface TransformStore {
  Position: { x: Float32Array; y: Float32Array; z: Float32Array };
  Rotation: { x: Float32Array; y: Float32Array; z: Float32Array; w: Float32Array };
  Scale: { x: Float32Array; y: Float32Array; z: Float32Array };
}

/** One tick's frozen transform state. `present`, if given, is the set of eids that
 *  hold valid data this tick — used to detect a newly-spawned entity (in `curr`
 *  but not `prev`) and a despawned one (in `prev` but not `curr`). When omitted,
 *  every eid handed to `interpolate` is assumed present. */
export interface TransformSnapshot {
  readonly store: TransformStore;
  readonly present?: ReadonlySet<number>;
}

/** Clamp the raw accumulator factor into the interpolation domain [0,1]. The
 *  physical alpha is always in [0,1) (the accumulator remainder is < FIXED_DT), so
 *  this only fires on a degenerate/overflowed input (e.g. a frame the loop didn't
 *  fully drain): negative -> hold `prev`, >1 -> snap to `curr`. Never NaN. */
function clampAlpha(alpha: number): number {
  // NaN-safe: the comparisons below treat NaN as "not in range"; map it to 0.
  if (!(alpha > 0)) return 0;
  if (alpha > 1) return 1;
  return alpha;
}

/** Copy one eid's full transform from `src` into `dst` (exact, no math). */
function copyTransform(dst: TransformStore, src: TransformStore, eid: number): void {
  dst.Position.x[eid] = src.Position.x[eid];
  dst.Position.y[eid] = src.Position.y[eid];
  dst.Position.z[eid] = src.Position.z[eid];
  dst.Rotation.x[eid] = src.Rotation.x[eid];
  dst.Rotation.y[eid] = src.Rotation.y[eid];
  dst.Rotation.z[eid] = src.Rotation.z[eid];
  dst.Rotation.w[eid] = src.Rotation.w[eid];
  dst.Scale.x[eid] = src.Scale.x[eid];
  dst.Scale.y[eid] = src.Scale.y[eid];
  dst.Scale.z[eid] = src.Scale.z[eid];
}

/** Interpolate one eid's transform from `prev`@N toward `curr`@N+1 by `t`∈[0,1],
 *  writing into `out`. Position & scale: linear lerp in the `a + (b-a)*t` form so
 *  t=0 is bit-exact `a`. Rotation: shortest-path nlerp — negate `curr`'s quat when
 *  the dot is negative (the quaternion double cover: q and -q are the same
 *  orientation, so the lerp must take the short arc), then renormalize onto the
 *  unit sphere. A degenerate zero-length result falls back to identity (no NaN). */
function lerpEid(out: TransformStore, prev: TransformStore, curr: TransformStore, eid: number, t: number): void {
  // Position — linear.
  const apx = prev.Position.x[eid], apy = prev.Position.y[eid], apz = prev.Position.z[eid];
  out.Position.x[eid] = apx + (curr.Position.x[eid] - apx) * t;
  out.Position.y[eid] = apy + (curr.Position.y[eid] - apy) * t;
  out.Position.z[eid] = apz + (curr.Position.z[eid] - apz) * t;

  // Scale — linear (hold is the t=0 limit; interpolated so growth/shrink is smooth).
  const asx = prev.Scale.x[eid], asy = prev.Scale.y[eid], asz = prev.Scale.z[eid];
  out.Scale.x[eid] = asx + (curr.Scale.x[eid] - asx) * t;
  out.Scale.y[eid] = asy + (curr.Scale.y[eid] - asy) * t;
  out.Scale.z[eid] = asz + (curr.Scale.z[eid] - asz) * t;

  // Rotation — shortest-path normalized lerp (nlerp).
  const ax = prev.Rotation.x[eid], ay = prev.Rotation.y[eid], az = prev.Rotation.z[eid], aw = prev.Rotation.w[eid];
  let bx = curr.Rotation.x[eid], by = curr.Rotation.y[eid], bz = curr.Rotation.z[eid], bw = curr.Rotation.w[eid];
  // Take the short arc across the double cover: if a·b < 0, q and -q name the same
  // orientation but lerping toward -b is the long way round — flip b.
  if (ax * bx + ay * by + az * bz + aw * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
  const qx = ax + (bx - ax) * t;
  const qy = ay + (by - ay) * t;
  const qz = az + (bz - az) * t;
  const qw = aw + (bw - aw) * t;
  const len2 = qx * qx + qy * qy + qz * qz + qw * qw;
  if (len2 > 0) {
    const inv = 1 / Math.sqrt(len2); // sqrt is IEEE-754 correctly-rounded -> bit-stable
    out.Rotation.x[eid] = qx * inv;
    out.Rotation.y[eid] = qy * inv;
    out.Rotation.z[eid] = qz * inv;
    out.Rotation.w[eid] = qw * inv;
  } else {
    // Degenerate (both quats ~zero, or exact antipodes summing to zero): identity.
    out.Rotation.x[eid] = 0;
    out.Rotation.y[eid] = 0;
    out.Rotation.z[eid] = 0;
    out.Rotation.w[eid] = 1;
  }
}

/** Pure form: tween every eid in `eids` from `prev` toward `curr` by `alpha`,
 *  writing into `out`. See FrameInterpolator.interpolate for the per-eid rules. */
export function interpolateInto(
  out: TransformStore,
  prev: TransformSnapshot,
  curr: TransformSnapshot,
  alpha: number,
  eids: Iterable<number>,
): void {
  const t = clampAlpha(alpha);
  const prevPresent = prev.present;
  const currPresent = curr.present;
  for (const eid of eids) {
    // Despawned: present last tick, gone this tick -> nothing authoritative to show.
    if (currPresent !== undefined && !currPresent.has(eid)) continue;
    // Newly spawned: in curr but not prev -> snap to curr, no interpolation (there
    // is no prior pose to tween from).
    if (prevPresent !== undefined && !prevPresent.has(eid)) {
      copyTransform(out, curr.store, eid);
      continue;
    }
    // alpha exactly 0 -> bit-exact prev (guarantees zero drift even after the
    // rotation renormalization, which can perturb a unit quat by an ULP).
    if (t === 0) { copyTransform(out, prev.store, eid); continue; }
    lerpEid(out, prev.store, curr.store, eid, t);
  }
}

/** Render-thread frame interpolator. Holds the two latest fixed-tick snapshots the
 *  sim-worker double-buffers and tweens them into a render `out` store each frame.
 *
 *  Usage per fixed tick: `push(latestSnapshot)` (curr becomes prev, the new state
 *  becomes curr). Usage per render frame: `interpolate(alpha, liveEids)` then run
 *  renderSyncSystem over `out`. */
export class FrameInterpolator {
  private prevSnap: TransformSnapshot | undefined;
  private currSnap: TransformSnapshot | undefined;

  /** @param out the RENDER store renderSyncSystem reads (e.g. world.ts arrays, or
   *  a dedicated render buffer). Interpolated transforms are written here. */
  constructor(private readonly out: TransformStore) {}

  /** Latest two snapshots seen (observability / tests). */
  get prev(): TransformSnapshot | undefined { return this.prevSnap; }
  get curr(): TransformSnapshot | undefined { return this.currSnap; }

  /** Set both snapshots explicitly (prev=tick N, curr=tick N+1). */
  setSnapshots(prev: TransformSnapshot, curr: TransformSnapshot): void {
    this.prevSnap = prev;
    this.currSnap = curr;
  }

  /** Advance the double buffer: the old `curr` (tick N) becomes `prev`, the new
   *  tick state (N+1) becomes `curr`. Call once per consumed fixed tick. */
  push(snapshot: TransformSnapshot): void {
    this.prevSnap = this.currSnap;
    this.currSnap = snapshot;
  }

  /** Tween prev->curr by `alpha` into the render `out` store.
   *  - `alpha` is clamped to [0,1]; at alpha=0 each result is bit-exact `prev`.
   *  - `eids`: which entities to write. Defaults to `curr.present`, else
   *    `prev.present`; one of those, or an explicit `eids`, must be available.
   *  Before the first two ticks exist it copies whichever single snapshot it has
   *  (or no-ops if none), so an early frame never reads undefined. */
  interpolate(alpha: number, eids?: Iterable<number>): void {
    const prev = this.prevSnap;
    const curr = this.currSnap;
    // Fewer than two snapshots: show whatever single state exists, no interpolation.
    if (curr === undefined) {
      if (prev !== undefined) this.copyAll(prev, eids);
      return;
    }
    if (prev === undefined) { this.copyAll(curr, eids); return; }
    const ids = eids ?? curr.present ?? prev.present;
    if (ids === undefined) {
      throw new Error("FrameInterpolator.interpolate: no eids given and snapshots carry no `present` set");
    }
    interpolateInto(this.out, prev, curr, alpha, ids);
  }

  /** Copy a single snapshot's transforms straight into `out` (no interpolation). */
  private copyAll(snap: TransformSnapshot, eids?: Iterable<number>): void {
    const ids = eids ?? snap.present;
    if (ids === undefined) return;
    const present = snap.present;
    for (const eid of ids) {
      if (present !== undefined && !present.has(eid)) continue;
      copyTransform(this.out, snap.store, eid);
    }
  }
}
