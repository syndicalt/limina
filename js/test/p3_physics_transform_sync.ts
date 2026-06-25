// Phase 3 physics/ECS bridge: native physics transform readback writes both
// position and quaternion into the ECS SoA arrays consumed by renderSyncSystem.

import { ops } from "../src/engine.ts";
import {
  createEcsWorld,
  Position,
  Rotation,
  spawnRenderable,
  syncPhysicsBodyTransform,
} from "../src/ecs/world.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function close(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) < 0.00001;
}

const object = {
  position: { set() {} },
  quaternion: { set() {} },
  scale: { set() {} },
};

const world = createEcsWorld();
const eid = spawnRenderable(world, object, 0, 0, 0);
const scratch = new Float32Array(7);
const fakeOps = {
  op_physics_body_transform(_id: number, out: Float32Array): void {
    out.set([1, 2, 3, 0.25, 0.5, 0.75, 0.35]);
  },
};

syncPhysicsBodyTransform(eid, 42, fakeOps, scratch);

assert(Position.x[eid] === 1 && Position.y[eid] === 2 && Position.z[eid] === 3, "position not synced");
assert(
  close(Rotation.x[eid], 0.25) && close(Rotation.y[eid], 0.5) &&
    close(Rotation.z[eid], 0.75) && close(Rotation.w[eid], 0.35),
  "rotation quaternion not synced",
);

ops.op_physics_create_world(-9.81);
ops.op_physics_add_static_box(0, -0.5, 0, 8, 0.5, 8, 0.8, 0.1);
const bodyId = ops.op_physics_add_box_material(0, 3, 0, 0.5, 0.8, 0.1);
for (let i = 0; i < 120; i++) ops.op_physics_step();
syncPhysicsBodyTransform(eid, bodyId, ops, scratch);

assert(Number.isFinite(Position.y[eid]) && Position.y[eid] < 3, "native physics position not synced");
assert(Number.isFinite(Rotation.w[eid]), "native physics quaternion not synced");

ops.op_log("P3 physics transform sync OK: full transform readback writes ECS position and rotation");
