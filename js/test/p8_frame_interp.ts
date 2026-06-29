// P8 Mode-B M4 — render-thread frame interpolation. Proves the Frame(alpha) tween
// between two fixed-step tick snapshots: position lerp, shortest-path quaternion
// nlerp, exact endpoints, clamping, newly-spawned handling, and determinism.

import {
  FrameInterpolator,
  interpolateInto,
  type TransformSnapshot,
  type TransformStore,
} from "../src/browser/frame-interpolator.ts";

declare const Deno: { core: { ops: { op_log(msg: string): void } } };
const log = Deno.core.ops.op_log;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`p8_frame_interp FAIL: ${msg}`);
}
function near(a: number, b: number, eps = 1e-6): boolean { return Math.abs(a - b) <= eps; }

// A small transform store (capacity N).
function makeStore(n: number): TransformStore {
  return {
    Position: { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n) },
    Rotation: { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), w: new Float32Array(n) },
    Scale: { x: new Float32Array(n).fill(1), y: new Float32Array(n).fill(1), z: new Float32Array(n).fill(1) },
  };
}
function setPos(s: TransformStore, eid: number, x: number, y: number, z: number): void {
  s.Position.x[eid] = x; s.Position.y[eid] = y; s.Position.z[eid] = z;
}
function setRot(s: TransformStore, eid: number, x: number, y: number, z: number, w: number): void {
  s.Rotation.x[eid] = x; s.Rotation.y[eid] = y; s.Rotation.z[eid] = z; s.Rotation.w[eid] = w;
}
function rotLen(s: TransformStore, eid: number): number {
  return Math.sqrt(
    s.Rotation.x[eid] ** 2 + s.Rotation.y[eid] ** 2 + s.Rotation.z[eid] ** 2 + s.Rotation.w[eid] ** 2,
  );
}

const N = 8;
const h = Math.SQRT1_2; // sin/cos(45deg) — 90deg-about-Y quat is (0,h,0,h)

// ---- core: eid 0 (0,0,0)->(10,0,0), identity -> 90deg about Y -----------------
{
  const prevStore = makeStore(N);
  const currStore = makeStore(N);
  setPos(prevStore, 0, 0, 0, 0);
  setRot(prevStore, 0, 0, 0, 0, 1); // identity
  setPos(currStore, 0, 10, 0, 0);
  setRot(currStore, 0, 0, h, 0, h); // 90deg about Y
  const present = new Set([0]);
  const prev: TransformSnapshot = { store: prevStore, present };
  const curr: TransformSnapshot = { store: currStore, present };
  const fi = new FrameInterpolator(makeStore(N));
  fi.setSnapshots(prev, curr);
  const out = (fi as unknown as { out: TransformStore }).out;

  // alpha 0 -> EXACTLY prev (bit-exact, no drift).
  fi.interpolate(0);
  assert(Object.is(out.Position.x[0], 0) && Object.is(out.Position.y[0], 0) && Object.is(out.Position.z[0], 0),
    "alpha0 position not exactly prev");
  assert(Object.is(out.Rotation.x[0], 0) && Object.is(out.Rotation.y[0], 0) &&
    Object.is(out.Rotation.z[0], 0) && Object.is(out.Rotation.w[0], 1), "alpha0 rotation not exactly prev identity");

  // alpha ~1 -> ~curr.
  fi.interpolate(1 - 1e-7);
  assert(near(out.Position.x[0], 10, 1e-3), `alpha~1 posX ${out.Position.x[0]}`);
  assert(near(out.Rotation.y[0], h, 1e-3) && near(out.Rotation.w[0], h, 1e-3), "alpha~1 rotation not ~curr");
  assert(near(rotLen(out, 0), 1), "alpha~1 quat not unit");

  // alpha 0.5 -> position (5,0,0); rotation ~45deg about Y, unit length.
  fi.interpolate(0.5);
  assert(near(out.Position.x[0], 5) && near(out.Position.y[0], 0) && near(out.Position.z[0], 0),
    `alpha0.5 position (${out.Position.x[0]},${out.Position.y[0]},${out.Position.z[0]})`);
  assert(near(rotLen(out, 0), 1), `alpha0.5 quat not unit (len ${rotLen(out, 0)})`);
  // 45deg about Y -> (0, sin22.5, 0, cos22.5). nlerp of identity & 90deg lands here.
  const s22 = Math.sin(Math.PI / 8), c22 = Math.cos(Math.PI / 8);
  assert(near(out.Rotation.x[0], 0) && near(out.Rotation.z[0], 0), "alpha0.5 rotation off Y axis");
  assert(near(out.Rotation.y[0], s22, 1e-6) && near(out.Rotation.w[0], c22, 1e-6),
    `alpha0.5 rotation not ~45deg about Y (got y=${out.Rotation.y[0]}, w=${out.Rotation.w[0]})`);
}

// ---- nlerp shortest-path: curr ~= -prev (dot<0) -> short way, no flip, unit ----
{
  const prevStore = makeStore(N);
  const currStore = makeStore(N);
  // prev = 170deg about Y; curr = -(178deg about Y) so dot(prev,curr) < 0.
  const a = (170 * Math.PI / 180) / 2;
  setRot(prevStore, 0, 0, Math.sin(a), 0, Math.cos(a));
  const b = (178 * Math.PI / 180) / 2;
  setRot(currStore, 0, 0, -Math.sin(b), 0, -Math.cos(b)); // negated -> double-cover twin
  const dot = prevStore.Rotation.y[0] * currStore.Rotation.y[0] + prevStore.Rotation.w[0] * currStore.Rotation.w[0];
  assert(dot < 0, "test setup: expected dot < 0");
  const present = new Set([0]);
  const out = makeStore(N);
  interpolateInto(out, { store: prevStore, present }, { store: currStore, present }, 0.5, [0]);
  assert(near(rotLen(out, 0), 1), `shortest-path quat not unit (len ${rotLen(out, 0)})`);
  // Short way: the midpoint sits BETWEEN 170 and 178deg about +Y, i.e. y>0, w<0
  // region near the +Y pole — NOT flung to the antipode. Check it's close to the
  // proper short-arc midpoint (~174deg about Y, expressed via the negated twin).
  const mid = (174 * Math.PI / 180) / 2;
  // Either sign of the unit quat is the same orientation; compare the orientation
  // by the absolute components.
  assert(near(Math.abs(out.Rotation.y[0]), Math.sin(mid), 2e-3),
    `shortest-path went the long way (y=${out.Rotation.y[0]})`);
  // No NaN anywhere.
  assert(Number.isFinite(out.Rotation.y[0]) && Number.isFinite(out.Rotation.w[0]), "shortest-path NaN");
}

// ---- near-identical quats -> no NaN ------------------------------------------
{
  const prevStore = makeStore(N);
  const currStore = makeStore(N);
  setRot(prevStore, 0, 0, 0, 0, 1);
  setRot(currStore, 0, 1e-9, 0, 0, Math.sqrt(1 - 1e-18)); // microscopically off identity
  const present = new Set([0]);
  const out = makeStore(N);
  interpolateInto(out, { store: prevStore, present }, { store: currStore, present }, 0.5, [0]);
  assert(near(rotLen(out, 0), 1) && Number.isFinite(out.Rotation.w[0]), "near-identical produced NaN / non-unit");
}

// ---- clamp: alpha 1.5 and -0.2 -> [0,1] behavior, no NaN ---------------------
{
  const prevStore = makeStore(N);
  const currStore = makeStore(N);
  setPos(prevStore, 0, 1, 2, 3);
  setRot(prevStore, 0, 0, 0, 0, 1);
  setPos(currStore, 0, 7, 8, 9);
  setRot(currStore, 0, 0, h, 0, h);
  const present = new Set([0]);
  const prev: TransformSnapshot = { store: prevStore, present };
  const curr: TransformSnapshot = { store: currStore, present };

  const outHi = makeStore(N);
  interpolateInto(outHi, prev, curr, 1.5, [0]); // clamp -> curr
  assert(near(outHi.Position.x[0], 7) && near(outHi.Position.y[0], 8) && near(outHi.Position.z[0], 9),
    "alpha 1.5 did not clamp to curr");
  assert(near(rotLen(outHi, 0), 1) && Number.isFinite(outHi.Rotation.w[0]), "alpha 1.5 NaN");

  const outLo = makeStore(N);
  interpolateInto(outLo, prev, curr, -0.2, [0]); // clamp -> prev (exact)
  assert(Object.is(outLo.Position.x[0], 1) && Object.is(outLo.Position.y[0], 2) && Object.is(outLo.Position.z[0], 3),
    "alpha -0.2 did not clamp to exact prev");

  // NaN alpha -> treated as 0 (exact prev), no NaN.
  const outNan = makeStore(N);
  interpolateInto(outNan, prev, curr, Number.NaN, [0]);
  assert(Object.is(outNan.Position.x[0], 1) && Number.isFinite(outNan.Rotation.w[0]), "NaN alpha not handled");
}

// ---- newly-spawned eid (in curr only) -> uses curr ---------------------------
{
  const prevStore = makeStore(N);
  const currStore = makeStore(N);
  // eid 0 exists in both; eid 1 is newly spawned this tick (curr only).
  setPos(prevStore, 0, 0, 0, 0);
  setPos(currStore, 0, 10, 0, 0);
  setPos(currStore, 1, 4, 5, 6);
  setRot(currStore, 1, 0, h, 0, h);
  const prev: TransformSnapshot = { store: prevStore, present: new Set([0]) };
  const curr: TransformSnapshot = { store: currStore, present: new Set([0, 1]) };
  const out = makeStore(N);
  interpolateInto(out, prev, curr, 0.5, [0, 1]);
  // eid 0 interpolates.
  assert(near(out.Position.x[0], 5), `spawned-case eid0 posX ${out.Position.x[0]}`);
  // eid 1 snaps to curr exactly (no prior pose to tween from).
  assert(Object.is(out.Position.x[1], 4) && Object.is(out.Position.y[1], 5) && Object.is(out.Position.z[1], 6),
    "newly-spawned eid did not use curr exactly");
  assert(near(out.Rotation.y[1], h) && near(out.Rotation.w[1], h), "newly-spawned rotation not curr");

  // despawned eid (in prev only) is skipped — out stays untouched (identity).
  const prev2: TransformSnapshot = { store: prevStore, present: new Set([0, 2]) };
  const curr2: TransformSnapshot = { store: currStore, present: new Set([0]) };
  const out2 = makeStore(N);
  setPos(out2, 2, -999, -999, -999); // sentinel to prove it's left untouched
  interpolateInto(out2, prev2, curr2, 0.5, [0, 2]);
  assert(Object.is(out2.Position.x[2], -999), "despawned eid was written");
}

// ---- determinism: same call twice -> byte-identical --------------------------
{
  const prevStore = makeStore(N);
  const currStore = makeStore(N);
  setPos(prevStore, 0, 1.25, -3.5, 7.125);
  setRot(prevStore, 0, 0.1, 0.2, 0.3, Math.sqrt(1 - 0.14));
  setPos(currStore, 0, -2.75, 9.5, 0.5);
  setRot(currStore, 0, -0.4, 0.5, -0.1, Math.sqrt(1 - 0.42));
  const present = new Set([0]);
  const prev: TransformSnapshot = { store: prevStore, present };
  const curr: TransformSnapshot = { store: currStore, present };
  const outA = makeStore(N);
  const outB = makeStore(N);
  interpolateInto(outA, prev, curr, 0.3717, [0]);
  interpolateInto(outB, prev, curr, 0.3717, [0]);
  for (const k of ["x", "y", "z"] as const) {
    assert(Object.is(outA.Position[k][0], outB.Position[k][0]), `nondeterministic position.${k}`);
    assert(Object.is(outA.Scale[k][0], outB.Scale[k][0]), `nondeterministic scale.${k}`);
  }
  for (const k of ["x", "y", "z", "w"] as const) {
    assert(Object.is(outA.Rotation[k][0], outB.Rotation[k][0]), `nondeterministic rotation.${k}`);
  }
  assert(near(rotLen(outA, 0), 1), "determinism quat not unit");
}

// ---- class double-buffer: push advances curr->prev ---------------------------
{
  const s0 = makeStore(N); setPos(s0, 0, 0, 0, 0);
  const s1 = makeStore(N); setPos(s1, 0, 2, 0, 0);
  const s2 = makeStore(N); setPos(s2, 0, 6, 0, 0);
  const present = new Set([0]);
  const fi = new FrameInterpolator(makeStore(N));
  fi.push({ store: s0, present }); // curr=s0, prev=undefined -> copies s0
  fi.interpolate(0.5, [0]);
  const out = (fi as unknown as { out: TransformStore }).out;
  assert(Object.is(out.Position.x[0], 0), "single-snapshot copy failed");
  fi.push({ store: s1, present }); // prev=s0, curr=s1
  fi.interpolate(0.5, [0]);
  assert(near(out.Position.x[0], 1), `buffer s0->s1 mid ${out.Position.x[0]}`);
  fi.push({ store: s2, present }); // prev=s1, curr=s2
  fi.interpolate(0.5, [0]);
  assert(near(out.Position.x[0], 4), `buffer s1->s2 mid ${out.Position.x[0]}`);
}

log("p8_frame_interp OK: position lerp + shortest-path nlerp (unit, no-NaN) — exact endpoints, clamp, spawn/despawn, deterministic, double-buffered");
