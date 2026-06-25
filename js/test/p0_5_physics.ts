// P0.5 - native Rapier physics via ops: a dynamic box falls onto a static
// ground. Asserts monotonic descent during free-fall, rest at the contact
// height, and bit-identical results across two same-binary runs (determinism).

interface PhysicsOps {
  op_physics_create_world(gravityY: number): void;
  op_physics_add_ground(y: number): void;
  op_physics_add_box(x: number, y: number, z: number, half: number): number;
  op_physics_step(): void;
  op_physics_body_pos(id: number, out: Float32Array): void;
  op_log(msg: string): void;
}

declare const Deno: { core: { ops: PhysicsOps } };
const ops = Deno.core.ops;

const STEPS = 300;
const HALF = 0.5;

function simulate(): number[] {
  ops.op_physics_create_world(-9.81);
  ops.op_physics_add_ground(0); // ground top surface at y = 0
  const id = ops.op_physics_add_box(0, 5, 0, HALF); // box center starts at y = 5
  const pos = new Float32Array(3);
  const ys: number[] = [];
  for (let i = 0; i < STEPS; i++) {
    ops.op_physics_step();
    ops.op_physics_body_pos(id, pos);
    ys.push(pos[1]);
  }
  return ys;
}

const run1 = simulate();
const run2 = simulate();

// (a) Monotonic descent during free-fall (while clearly above the rest height).
let prev = 5;
for (let i = 0; i < run1.length; i++) {
  const y = run1[i];
  if (y > 1.0) {
    if (y > prev + 1e-5) throw new Error(`not monotonic during fall at ${i}: ${y} > ${prev}`);
    prev = y;
  }
}

// (b) Comes to rest at the contact height (box half-extent on ground => y ~ 0.5).
const restY = run1[run1.length - 1];
if (Math.abs(restY - HALF) > 0.02) {
  throw new Error(`rest Y expected ~${HALF}, got ${restY}`);
}

// (c) Determinism: bit-identical across the two runs.
for (let i = 0; i < run1.length; i++) {
  if (run1[i] !== run2[i]) {
    throw new Error(`nondeterministic at step ${i}: ${run1[i]} vs ${run2[i]}`);
  }
}

ops.op_log(
  `P0.5 OK: monotonic free-fall, rest at y=${restY.toFixed(5)}, bit-identical over ${STEPS} steps`,
);
