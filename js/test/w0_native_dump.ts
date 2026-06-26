// W0 native parity probe. Builds a deterministic scene (ground + 8 dynamic boxes
// dropped at known offsets, one apply_impulse), steps M=300 fixed ticks via
// op_physics_step(), and dumps every body's final transform (pos xyz + quat xyzw)
// as JSON. Written via op_write_trace to a bare filename under <cwd>/traces/, then
// copied to spikes/w0-physics-parity/native.json by the runner.
//
// This MUST mirror, on the wasm side, the EXACT native config used by
// crates/limina-physics/src/lib.rs:
//   - gravity = (0, -9.81, 0)        [op_physics_create_world(gravityY)]
//   - dt = 1/60 per step             [IntegrationParameters::default()]
//   - num_solver_iterations = 4, num_internal_pgs_iterations = 1,
//     num_internal_stabilization_iterations = 1, warmstart_coefficient = 1.0,
//     length_unit = 1.0, normalized_allowed_linear_error = 0.001,
//     normalized_max_corrective_velocity = 10, normalized_prediction_distance = 0.002
//   - ground: fixed cuboid half-extents (100, 0.5, 100), top surface at y=0
//             => collider centered at (0, -0.5, 0)
//   - box: dynamic cuboid half-extents (0.5,0.5,0.5), density 1.0 (=> mass 1.0),
//          friction 0.5, restitution 0.0 (ColliderBuilder cuboid defaults)
//   - impulse applied to body 0 before stepping.

interface PhysicsOps {
  op_physics_create_world(gravityY: number): void;
  op_physics_add_ground(y: number): void;
  op_physics_add_box(x: number, y: number, z: number, half: number): number;
  op_physics_apply_impulse(id: number, ix: number, iy: number, iz: number): void;
  op_physics_step(): void;
  op_physics_body_transform(id: number, out: Float32Array): void;
  op_write_trace(name: string, content: string): void;
  op_log(msg: string): void;
}

declare const Deno: { core: { ops: PhysicsOps } };
const ops = Deno.core.ops;

const STEPS = 300;
const HALF = 0.5;
const GRAVITY_Y = -9.81;

// Deterministic pile: 8 boxes stacked vertically with small lateral offsets so
// they collide, settle, and rotate (exercises both translation AND rotation drift).
const SPAWN: [number, number, number][] = [
  [0.0, 1.0, 0.0],
  [0.3, 2.0, 0.0],
  [-0.3, 3.0, 0.2],
  [0.2, 4.0, -0.2],
  [0.0, 5.0, 0.3],
  [-0.2, 6.0, -0.3],
  [0.4, 7.0, 0.1],
  [-0.4, 8.0, -0.1],
];

ops.op_physics_create_world(GRAVITY_Y);
ops.op_physics_add_ground(0); // top surface at y=0

const ids: number[] = [];
for (const [x, y, z] of SPAWN) {
  ids.push(ops.op_physics_add_box(x, y, z, HALF));
}

// One deterministic impulse on body 0 (units: kg*m/s; mass is 1.0 so this is a
// 2 m/s +X, 1 m/s +Z kick).
ops.op_physics_apply_impulse(ids[0], 2.0, 0.0, 1.0);

for (let i = 0; i < STEPS; i++) {
  ops.op_physics_step();
}

const out = new Float32Array(7);
const bodies = ids.map((id) => {
  ops.op_physics_body_transform(id, out);
  return {
    id,
    pos: [out[0], out[1], out[2]],
    quat: [out[3], out[4], out[5], out[6]],
  };
});

const payload = {
  engine: "native-rapier-0.33.0 (FFI)",
  steps: STEPS,
  dt: 1 / 60,
  gravityY: GRAVITY_Y,
  bodies,
};

ops.op_write_trace("w0_native.json", JSON.stringify(payload, null, 2));
ops.op_log(`W0 native: dumped ${bodies.length} bodies after ${STEPS} steps -> traces/w0_native.json`);
