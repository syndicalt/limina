// Native physics boundary hardening: malformed scalar inputs must be rejected
// before Rapier can store NaN/Inf transforms or invalid collider dimensions.

import { ops } from "../src/engine.ts";

const physicsOps = Deno.core.ops as {
  op_physics_new_world(gravityY: number): number;
};

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p36_physics_boundary FAIL: " + message);
}

function throws(label: string, fn: () => unknown, needle: string): void {
  try {
    fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(msg.toLowerCase().includes(needle), `${label}: wrong error '${msg}', expected '${needle}'`);
    return;
  }
  throw new Error(`p36_physics_boundary FAIL: ${label}: expected throw`);
}

ops.op_physics_create_world(0);
throws("new physics world NaN gravity", () => physicsOps.op_physics_new_world(Number.NaN), "finite");

throws("dynamic box NaN origin", () => ops.op_physics_add_box(Number.NaN, 0, 0, 0.5), "finite");
throws("dynamic sphere negative radius", () => ops.op_physics_add_sphere(0, 0, 0, -0.5, 0.5, 0), "positive");
throws("static box zero half extent", () => ops.op_physics_add_static_box(0, 0, 0, 1, 0, 1, 0.5, 0), "positive");
throws("character infinite radius", () => ops.op_physics_add_character(0, 1, 0, 0.5, Infinity), "finite");

const good = ops.op_physics_add_sphere(0, 2, 0, 0.5, 0.5, 0);
throws("non-finite impulse", () => ops.op_physics_apply_impulse(good, 1, Number.NaN, 0), "finite");

const stalePos = new Float32Array([7, 8, 9]);
ops.op_physics_remove_body(good);
ops.op_physics_body_pos(good, stalePos);
assert(stalePos.every((v) => v === 0), "removed-body position read must zero-fill stale caller data");
const staleTransform = new Float32Array([1, 2, 3, 4, 5, 6, 7]);
ops.op_physics_body_transform(good, staleTransform);
assert(staleTransform.every((v) => v === 0), "removed-body transform read must zero-fill stale caller data");
const moveOut = new Float32Array([1, 2, 3, 4]);
ops.op_physics_move_character(good, 1, 0, 0, moveOut);
assert(moveOut.every((v) => v === 0), "removed-character move must zero-fill stale caller data");

const ray = new Float32Array(6);
throws("non-finite raycast direction", () => ops.op_physics_raycast(0, 2, 0, 0, Number.NaN, 0, 10, ray), "finite");

assert(good === 0, "rejected bodies must not consume ids before the first valid body");

ops.op_log("p36_physics_boundary OK: invalid scalar inputs are rejected and bad body reads zero-fill stale caller data");
