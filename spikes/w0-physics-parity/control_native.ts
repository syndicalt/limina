// W0 control (native): a SINGLE box free-falls onto the ground and rests — a
// non-chaotic, contact-light scene. Compared against control_wasm.mjs to isolate
// solver/core-version drift from the chaotic amplification seen in the 8-box pile.
interface PhysicsOps {
  op_physics_create_world(g: number): void;
  op_physics_add_ground(y: number): void;
  op_physics_add_box(x: number, y: number, z: number, half: number): number;
  op_physics_step(): void;
  op_physics_body_transform(id: number, out: Float32Array): void;
  op_write_trace(name: string, content: string): void;
  op_log(msg: string): void;
}
declare const Deno: { core: { ops: PhysicsOps } };
const ops = Deno.core.ops;
ops.op_physics_create_world(-9.81);
ops.op_physics_add_ground(0);
const id = ops.op_physics_add_box(0, 5, 0, 0.5);
for (let i = 0; i < 300; i++) ops.op_physics_step();
const out = new Float32Array(7);
ops.op_physics_body_transform(id, out);
const payload = { pos: [out[0], out[1], out[2]], quat: [out[3], out[4], out[5], out[6]] };
ops.op_write_trace("w0_control_native.json", JSON.stringify(payload));
ops.op_log("W0 control native done");
