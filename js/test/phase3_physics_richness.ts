// Phase 3 Worker 1 - richer native Rapier collider ops, transforms, and collisions.

import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

interface CollisionRecord {
  started: boolean;
  bodyA: number;
  bodyB: number;
  point: [number, number, number] | null;
  normal: [number, number, number] | null;
}

const sceneChildren: unknown[] = [];
const scene = {
  add(c: unknown) { sceneChildren.push(c); },
  remove(c: unknown) { const i = sceneChildren.indexOf(c); if (i >= 0) sceneChildren.splice(i, 1); },
  position: { set() {}, x: 0, y: 0, z: 0 },
  background: null as unknown,
};
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };

function ok(res: MCPResponse): unknown {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result;
}

function field(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

function drainCollisionTuples(): CollisionRecord[] {
  const records = ops.op_physics_drain_collisions();
  if (!Array.isArray(records)) throw new Error("collision drain did not return an array");
  return records.map((rec) => {
    if (typeof rec !== "object" || rec === null) throw new Error("collision record is not a structured event");
    return { started: rec.kind === 1, bodyA: rec.a, bodyB: rec.b, point: rec.point, normal: rec.normal };
  });
}

function hasStarted(records: CollisionRecord[], a: number, b: number): boolean {
  return records.some((rec) => rec.started && (
    (rec.bodyA === a && rec.bodyB === b) || (rec.bodyA === b && rec.bodyB === a)
  ));
}

// Sphere falls and rests on a static box floor.
ops.op_physics_create_world(-9.81);
const floor = ops.op_physics_add_static_box(0, -0.5, 0, 10, 0.5, 10, 0.8, 0.1);
const sphere = ops.op_physics_add_sphere(0, 4, 0, 0.5, 0.8, 0.1);
const transform = new Float32Array(7);
let sawFloorCollision = false;
for (let i = 0; i < 300; i++) {
  ops.op_physics_step();
  if (hasStarted(drainCollisionTuples(), sphere, floor)) sawFloorCollision = true;
}
ops.op_physics_body_transform(sphere, transform);
if (Math.abs(transform[1] - 0.5) > 0.03) throw new Error(`sphere rest y expected ~0.5, got ${transform[1]}`);
if (Math.abs(transform[6] - 1) > 1e-4) throw new Error(`identity quaternion w expected ~1, got ${transform[6]}`);
if (!sawFloorCollision) throw new Error("sphere/floor collision did not emit a started event");

// Restitution against a static wall reverses x velocity enough to move left.
ops.op_physics_create_world(0);
const wall = ops.op_physics_add_static_box(2, 0, 0, 0.25, 2, 2, 0.1, 1.0);
const ball = ops.op_physics_add_sphere(0, 0, 0, 0.5, 0.1, 1.0);
ops.op_physics_apply_impulse(ball, 12, 0, 0);
let maxX = -Infinity;
let finalX = 0;
let sawWallCollision = false;
for (let i = 0; i < 180; i++) {
  ops.op_physics_step();
  ops.op_physics_body_transform(ball, transform);
  maxX = Math.max(maxX, transform[0]);
  finalX = transform[0];
  if (hasStarted(drainCollisionTuples(), ball, wall)) sawWallCollision = true;
}
if (!sawWallCollision) throw new Error("ball/wall collision did not emit a started event");
if (finalX >= maxX - 0.05) throw new Error(`ball did not bounce away from wall: max=${maxX}, final=${finalX}`);

// Capsule op produces a dynamic body with transform readback.
ops.op_physics_create_world(-9.81);
ops.op_physics_add_static_box(0, -0.5, 0, 10, 0.5, 10, 0.8, 0.1);
const capsule = ops.op_physics_add_capsule(0, 3, 0, 0.6, 0.3, 0.8, 0.1);
for (let i = 0; i < 240; i++) ops.op_physics_step();
ops.op_physics_body_transform(capsule, transform);
if (transform[1] < 0.85 || transform[1] > 1.05) throw new Error(`capsule rest y out of range: ${transform[1]}`);

// Skill path: scene.createEntity supports collider/static/material fields and physics.collisionEvents maps body ids to entities.
ops.op_physics_create_world(0);
const world: WorldContext = { ecs: createEcsWorld(), entities: new EntityTable(), tags: new Map(), scene, camera, ops };
const registry = new SkillRegistry(new LiminaTracer("ses_phase3_physics"));
registerCoreSkills(registry);
const base = { agentId: "agt_builder", sessionId: "ses_phase3_physics", permissions: resolveProfile("builder.readWrite"), tick: 0, world };
const a = field(ok(await registry.invoke("scene.createEntity", {
  shape: "sphere",
  collider: "sphere",
  size: 1,
  position: [0, 0, 0],
  dynamic: true,
  friction: 0.1,
  restitution: 1.0,
}, base)), "entity");
const b = field(ok(await registry.invoke("scene.createEntity", {
  shape: "box",
  collider: "box",
  static: true,
  size: 1,
  position: [2, 0, 0],
  friction: 0.1,
  restitution: 1.0,
}, base)), "entity");
if (typeof a !== "string" || typeof b !== "string") throw new Error("scene.createEntity did not return entity ids");
const bodyA = world.entities.resolve(a)?.bodyId ?? -1;
ops.op_physics_apply_impulse(bodyA, 12, 0, 0);
for (let i = 0; i < 90; i++) ops.op_physics_step();
const collisions = ok(await registry.invoke("physics.collisionEvents", {}, base));
const events = field(collisions, "events");
if (!Array.isArray(events) || !events.some((ev) => field(ev, "started") === true && field(ev, "entityA") === a && field(ev, "entityB") === b)) {
  throw new Error("physics.collisionEvents did not map started collision to entities");
}

ops.op_log("Phase3 physics richness OK: sphere/capsule/static-box/materials/transform/collision skill");
