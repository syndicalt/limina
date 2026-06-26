// Phase 9 — native heightfield collider op (headless). Proves op_physics_add_
// heightfield builds a REAL collider that a falling body rests on at the surface
// the heights define, that the grid SHAPE is read (not a flat plane), and that it
// is DETERMINISTIC (the replay-parity foundation: same heights -> same rest).

import { ops } from "../src/engine.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p9_heightfield FAIL: " + msg);
}

const N = 33;
const SCALE: [number, number, number] = [20, 4, 20];

function settleRun(): { sphere: number[]; surfaceY: number; hId: number; sId: number } {
  ops.op_physics_create_world(-9.81);
  // Flat field at a NON-zero height (proves heights * scaleY is applied — a buggy
  // op that ignored heights/scale would put the surface at y=0).
  const flat = new Float32Array(N * N).fill(0.5);
  const hId = ops.op_physics_add_heightfield(0, 0, 0, N, N, SCALE[0], SCALE[1], SCALE[2], flat);
  ops.op_physics_step(); // build the broad-phase so the query ray can hit the static field
  // Where is the surface, per the engine itself? Ray straight down (no sphere yet).
  const ray = new Float32Array(6);
  ops.op_physics_raycast(0, 10, 0, 0, -1, 0, 30, ray);
  assert(ray[0] === 1, "down-ray did not hit the heightfield");
  assert(ray[5] === hId, `down-ray hit body ${ray[5]}, expected the heightfield ${hId}`);
  const surfaceY = ray[3];
  const sId = ops.op_physics_add_sphere(0, 10, 0, 0.5, 0.4, 0.2);
  for (let i = 0; i < 300; i++) ops.op_physics_step();
  const t = new Float32Array(7);
  ops.op_physics_body_transform(sId, t);
  return { sphere: [...t], surfaceY, hId, sId };
}

// 1. Settle: the sphere rests ~one radius above the surface the engine raycasts.
const a = settleRun();
assert(a.hId === 0 && a.sId === 1, `body ids wrong: heightfield=${a.hId} sphere=${a.sId} (expected 0,1)`);
assert(a.sphere.every(Number.isFinite), "sphere transform not finite (fell through / NaN)");
const restY = a.sphere[1];
assert(Math.abs(restY - (a.surfaceY + 0.5)) < 0.12, `sphere rested at y=${restY}, expected ~${a.surfaceY + 0.5} (surface+radius)`);
assert(a.surfaceY > 1.0, `surface should sit at heights*scaleY ≈ 2, got ${a.surfaceY} (heights/scale not applied?)`);

// 2. Determinism: a second identical run is BIT-IDENTICAL (replay-parity basis).
const b = settleRun();
for (let i = 0; i < 7; i++) assert(Object.is(a.sphere[i], b.sphere[i]), `non-deterministic at component ${i}: ${a.sphere[i]} vs ${b.sphere[i]}`);

// 3. Grid shape is read: a corner-ramp heightfield (low at one corner, high at the
// opposite) gives DIFFERENT raycast heights at opposite corners — a flat plane could
// not. Both axes ramp together so this holds regardless of row/col<->x/z mapping.
ops.op_physics_create_world(-9.81);
const ramp = new Float32Array(N * N);
for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) ramp[r * N + c] = (r / (N - 1) + c / (N - 1)) * 0.5;
const rampId = ops.op_physics_add_heightfield(0, 0, 0, N, N, SCALE[0], SCALE[1], SCALE[2], ramp);
ops.op_physics_step(); // build the broad-phase before querying
const hi = new Float32Array(6), lo = new Float32Array(6);
ops.op_physics_raycast(8, 20, 8, 0, -1, 0, 40, hi);   // near the high corner
ops.op_physics_raycast(-8, 20, -8, 0, -1, 0, 40, lo);  // near the low corner
assert(hi[0] === 1 && lo[0] === 1, "corner rays did not both hit the ramp");
assert(hi[5] === rampId && lo[5] === rampId, "corner rays hit the wrong body");
assert(hi[3] - lo[3] > 1.0, `ramp not read: corner heights ${hi[3]} vs ${lo[3]} (expected a >1m difference)`);

ops.op_log(`p9_heightfield OK: heightfield collider built (id ${a.hId}); sphere settled at y=${restY.toFixed(3)} ≈ surface(${a.surfaceY.toFixed(3)})+radius; bit-identical across two runs; corner-ramp read (Δheight ${(hi[3] - lo[3]).toFixed(2)}m).`);
