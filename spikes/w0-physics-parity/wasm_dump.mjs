// W0 wasm parity probe. Rebuilds the EXACT scene from js/test/w0_native_dump.ts
// using @dimforge/rapier3d-compat (wasm), with the same gravity, dt, body params,
// impulse, and M=300 steps, then writes wasm.json with per-body transforms in the
// same body order (id 0..7).
//
// Native config mirrored here (crates/limina-physics/src/lib.rs +
// rapier3d 0.33 IntegrationParameters::default()):
//   gravity (0,-9.81,0); dt=1/60; num_solver_iterations=4;
//   num_internal_pgs_iterations=1; length_unit=1.0; warmstart_coefficient=1.0.
//   ground: fixed cuboid (100,0.5,100) centered at (0,-0.5,0) (top at y=0).
//   box: dynamic cuboid (0.5,0.5,0.5), density 1.0, friction 0.5, restitution 0.0.
//
// NOTE / HONESTY GATE: the published wasm package bundles Rust rapier core 0.30.0,
// while the native side is rapier 0.33.0. We match every *input* parameter, but the
// solver core versions differ — see RESULT.md.

import RAPIER from "@dimforge/rapier3d-compat";
import { writeFileSync } from "node:fs";

const STEPS = 300;
const HALF = 0.5;
const GRAVITY_Y = -9.81;

const SPAWN = [
  [0.0, 1.0, 0.0],
  [0.3, 2.0, 0.0],
  [-0.3, 3.0, 0.2],
  [0.2, 4.0, -0.2],
  [0.0, 5.0, 0.3],
  [-0.2, 6.0, -0.3],
  [0.4, 7.0, 0.1],
  [-0.4, 8.0, -0.1],
];

await RAPIER.init();

const world = new RAPIER.World({ x: 0.0, y: GRAVITY_Y, z: 0.0 });

// Match native IntegrationParameters::default() where the wasm core exposes them.
world.timestep = 1 / 60;
const ip = world.integrationParameters;
if ("numSolverIterations" in ip) ip.numSolverIterations = 4;
if ("numInternalPgsIterations" in ip) ip.numInternalPgsIterations = 1;
if ("numAdditionalFrictionIterations" in ip) {
  // 0.30 may not expose this; leave default if absent.
}
if ("lengthUnit" in ip) ip.lengthUnit = 1.0;

// Ground: a parent-less (static) cuboid collider, top surface at y=0 => center y=-0.5.
world.createCollider(
  RAPIER.ColliderDesc.cuboid(100.0, 0.5, 100.0).setTranslation(0.0, -0.5, 0.0),
);

// Dynamic boxes, created in the same order as native (ids 0..7).
const bodies = [];
for (const [x, y, z] of SPAWN) {
  const rb = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z),
  );
  // ColliderDesc.cuboid defaults: density 1.0, friction 0.5, restitution 0.0 —
  // identical to native ColliderBuilder::cuboid defaults.
  world.createCollider(RAPIER.ColliderDesc.cuboid(HALF, HALF, HALF), rb);
  bodies.push(rb);
}

// Same deterministic impulse on body 0.
bodies[0].applyImpulse({ x: 2.0, y: 0.0, z: 1.0 }, true);

for (let i = 0; i < STEPS; i++) {
  world.step();
}

const out = bodies.map((rb, id) => {
  const t = rb.translation();
  const r = rb.rotation();
  return { id, pos: [t.x, t.y, t.z], quat: [r.x, r.y, r.z, r.w] };
});

const payload = {
  engine: `wasm @dimforge/rapier3d-compat (core ${RAPIER.version()})`,
  steps: STEPS,
  dt: 1 / 60,
  gravityY: GRAVITY_Y,
  bodies: out,
};

writeFileSync(
  new URL("./wasm.json", import.meta.url),
  JSON.stringify(payload, null, 2),
);
console.log(
  `W0 wasm: dumped ${out.length} bodies after ${STEPS} steps -> wasm.json`,
);
