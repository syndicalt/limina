// P34 -- native per-world physics (the native half of finding #8).
//
// #8 made the JS ECS transform store + PRNG per-world. Native Rapier was still a
// single world/process: every physics op operated on one PhysicsWorld in OpState.
// This test proves the new registry (op_physics_new_world / activate_world) lets
// multiple independent native physics worlds coexist:
//   1. A world stepped via ACTIVATION, INTERLEAVED with another world's steps, is
//      BIT-IDENTICAL to that same world stepped alone -- activation preserves each
//      world's state exactly across being swapped out and back (no cross-mixing).
//   2. FALSIFIABILITY: double-stepping a world changes its result, so the equality
//      in (1) is load-bearing -- if activation shared one world, "step A; step B"
//      per round would double-step it and diverge.
//
// Headless-safe: pure native physics, no GPU/window.

import { ops } from "../src/engine.ts";

const P = ops as unknown as {
  op_physics_create_world(gravityY: number): void;
  op_physics_new_world(gravityY: number): number;
  op_physics_activate_world(id: number): boolean;
  op_physics_active_world(): number;
  op_physics_add_sphere(x: number, y: number, z: number, r: number, friction: number, restitution: number): number;
  op_physics_step(): void;
  op_physics_body_pos(id: number, out: Float32Array): void;
};

function assert(c: boolean, m: string): asserts c { if (!c) throw new Error("p34_two_worlds_physics: " + m); }

const K = 40;
const bodyY = (id: number): number => { const s = new Float32Array(3); P.op_physics_body_pos(id, s); return s[1]; };
const drop = (): number => P.op_physics_add_sphere(0, 10, 0, 0.5, 0.5, 0.0);

// ---- solo baselines: world A (g=-9.81) and world B (g=-4.0), each stepped K alone --
P.op_physics_create_world(-9.81);
const bA = drop();
for (let i = 0; i < K; i++) P.op_physics_step();
const yA_solo = bodyY(bA);

const wB = P.op_physics_new_world(-4.0);
assert(P.op_physics_activate_world(wB), "activate world B");
assert(P.op_physics_active_world() === wB, "active id should be B");
const bB = drop();
for (let i = 0; i < K; i++) P.op_physics_step();
const yB_solo = bodyY(bB);
assert(yA_solo !== yB_solo, `sanity: different gravity must give different fall (A=${yA_solo}, B=${yB_solo})`);

// ---- interleaved: two fresh worlds, stepped ALTERNATELY via activation -------------
const wA2 = P.op_physics_new_world(-9.81);
const wB2 = P.op_physics_new_world(-4.0);
assert(P.op_physics_activate_world(wA2), "activate A2"); const bA2 = drop();
assert(P.op_physics_activate_world(wB2), "activate B2"); const bB2 = drop();
for (let i = 0; i < K; i++) {
  P.op_physics_activate_world(wA2); P.op_physics_step();
  P.op_physics_activate_world(wB2); P.op_physics_step();
}
P.op_physics_activate_world(wA2); const yA_inter = bodyY(bA2);
P.op_physics_activate_world(wB2); const yB_inter = bodyY(bB2);

assert(yA_inter === yA_solo, `world A interleaved (${yA_inter}) != solo (${yA_solo}) -- activation lost/mixed state`);
assert(yB_inter === yB_solo, `world B interleaved (${yB_inter}) != solo (${yB_solo}) -- activation lost/mixed state`);

// ---- falsifiability control: double-stepping A2 must change y ----------------------
P.op_physics_activate_world(wA2);
for (let i = 0; i < K; i++) P.op_physics_step();
const yA_double = bodyY(bA2);
assert(yA_double !== yA_solo, "double-stepping A did not change y -- the bit-identical assertion would be vacuous");

ops.op_log(
  `[js] p34_two_worlds_physics OK: 2 native worlds x ${K} interleaved steps are BIT-IDENTICAL to solo ` +
  `(A yr=${yA_inter.toFixed(6)}==${yA_solo.toFixed(6)}, B yr=${yB_inter.toFixed(6)}==${yB_solo.toFixed(6)}); ` +
  `control: double-step A -> ${yA_double.toFixed(6)} != ${yA_solo.toFixed(6)}, so isolation is load-bearing.`,
);
