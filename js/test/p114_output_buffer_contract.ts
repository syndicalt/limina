import { ops } from "../src/engine.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p114_output_buffer_contract FAIL: ${message}`);
}

function rejects(label: string, call: () => void, expected: RegExp): void {
  let error: unknown;
  try { call(); } catch (caught) { error = caught; }
  assert(error instanceof Error && expected.test(error.message), `${label} did not reject clearly: ${String(error)}`);
}

ops.op_physics_create_world(-9.81);
const body = ops.op_physics_add_box(0, 2, 0, 0.5);
rejects("body position", () => ops.op_physics_body_pos(body, new Float32Array(2)), /requires at least 3 elements/);
rejects("body transform", () => ops.op_physics_body_transform(body, new Float32Array(6)), /requires at least 7 elements/);
rejects("raycast", () => ops.op_physics_raycast(0, 4, 0, 0, -1, 0, 10, new Float32Array(5)), /requires at least 6 elements/);
rejects("character movement", () => ops.op_physics_move_character(body, 0, 0, 0, new Float32Array(3)), /requires at least 4 elements/);
rejects("input axes", () => ops.op_input_axes(new Float32Array(2)), /requires at least 3 elements/);
rejects("input look", () => ops.op_input_look(new Float32Array(1)), /requires at least 2 elements/);
rejects("input buttons", () => ops.op_input_buttons(new Float32Array(1)), /requires at least 2 elements/);

const transform = new Float32Array(7);
ops.op_physics_body_transform(body, transform);
assert(transform[6] === 1, "valid transform output no longer works");
const axes = new Float32Array(3);
ops.op_input_axes(axes);
assert(axes.every(Number.isFinite), "valid input output no longer works");

ops.op_log("p114_output_buffer_contract OK: every fixed-size native output op rejects truncation and preserves valid calls");
