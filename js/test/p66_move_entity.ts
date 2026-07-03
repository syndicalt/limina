// P66 — scene.moveEntity repositions / re-orients / rescales an EXISTING entity (the discoverable
// "move" tool an agent reaches for after creating things). Absolute + relative position, a friendly
// yaw and a full quaternion, uniform + per-axis scale — all routed through the shared
// writeTransformComponent so the transform SoA (and any physics body / child subtree) stays
// consistent. Proves the capability the agent said it lacked.

import { ops, EntityTable, type WorldContext } from "../src/engine.ts";
import { createEcsWorld, Position, Rotation, Scale } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p66_move_entity: " + msg);
}
const near = (a: number, b: number, eps = 1e-4): boolean => Math.abs(a - b) <= eps;

function makeHeadlessWorld(): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene, camera, ops, mode: "headless",
  };
}

const world = makeHeadlessWorld();
const registry = new SkillRegistry(new LiminaTracer("ses_p66"));
registerCoreSkills(registry);
const perms = resolveProfile("builder.readWrite");
const at = (t: number) => ({ agentId: "agt_p66", sessionId: "ses_p66", permissions: perms, tick: t, world });

// scene.moveEntity + ecs.updateComponent must both be CORE (in the agent's default tool surface).
const core = new Set(registry.list().filter((t) => t.priority === "core").map((t) => t.name));
assert(core.has("scene.moveEntity"), "scene.moveEntity must be a core (agent-visible) skill");
assert(core.has("ecs.updateComponent"), "ecs.updateComponent must be a core skill");

// Create an entity to move.
const rc = await registry.invoke("scene.createEntity", { shape: "box", size: 1, position: [0, 0, 0] }, at(1));
assert(rc.success, `createEntity failed: ${JSON.stringify(rc.error)}`);
const id = (rc.result as { entity: string }).entity;
const eid = world.entities.resolve(id)!.eid;

// 1. Absolute move.
const r1 = await registry.invoke("scene.moveEntity", { entity: id, position: [5, 2, -3] }, at(2));
assert(r1.success, `moveEntity absolute failed: ${JSON.stringify(r1.error)}`);
assert(near(Position.x[eid], 5) && near(Position.y[eid], 2) && near(Position.z[eid], -3), `absolute move wrong: ${Position.x[eid]},${Position.y[eid]},${Position.z[eid]}`);
const rp = (r1.result as { position: [number, number, number] }).position;
assert(near(rp[0], 5) && near(rp[1], 2) && near(rp[2], -3), "returned position must reflect the move");

// 2. Relative move (offset from current).
await registry.invoke("scene.moveEntity", { entity: id, position: [1, 0, 1], relative: true }, at(3));
assert(near(Position.x[eid], 6) && near(Position.y[eid], 2) && near(Position.z[eid], -2), `relative move wrong: ${Position.x[eid]},${Position.y[eid]},${Position.z[eid]}`);

// 3. Yaw → quaternion about +Y.
await registry.invoke("scene.moveEntity", { entity: id, yaw: Math.PI / 2 }, at(4));
const s = Math.sin(Math.PI / 4);
assert(near(Rotation.y[eid], s) && near(Rotation.w[eid], Math.cos(Math.PI / 4)) && near(Rotation.x[eid], 0) && near(Rotation.z[eid], 0), `yaw quaternion wrong: ${Rotation.x[eid]},${Rotation.y[eid]},${Rotation.z[eid]},${Rotation.w[eid]}`);

// 4. Full quaternion overrides yaw.
await registry.invoke("scene.moveEntity", { entity: id, rotation: [0, 0, 0, 1], yaw: 1.23 }, at(5));
assert(near(Rotation.x[eid], 0) && near(Rotation.y[eid], 0) && near(Rotation.z[eid], 0) && near(Rotation.w[eid], 1), "explicit rotation must override yaw");

// 5. Uniform + per-axis scale.
await registry.invoke("scene.moveEntity", { entity: id, scale: 2 }, at(6));
assert(near(Scale.x[eid], 2) && near(Scale.y[eid], 2) && near(Scale.z[eid], 2), `uniform scale wrong: ${Scale.x[eid]},${Scale.y[eid]},${Scale.z[eid]}`);
await registry.invoke("scene.moveEntity", { entity: id, scale: [1, 3, 1] }, at(7));
assert(near(Scale.x[eid], 1) && near(Scale.y[eid], 3) && near(Scale.z[eid], 1), `per-axis scale wrong: ${Scale.x[eid]},${Scale.y[eid]},${Scale.z[eid]}`);

// 6. Position untouched by a rotation/scale-only move.
assert(near(Position.x[eid], 6) && near(Position.y[eid], 2) && near(Position.z[eid], -2), "position must be unchanged by rotation/scale-only moves");

// 7. Unknown entity → a clear failure (not a silent no-op).
const rBad = await registry.invoke("scene.moveEntity", { entity: "ent_does_not_exist", position: [0, 0, 0] }, at(8));
assert(!rBad.success, "moving an unknown entity must fail");

ops.op_log("[js] p66_move_entity OK: scene.moveEntity (core + live) repositions an existing entity — absolute + relative, yaw + quaternion (quaternion wins), uniform + per-axis scale — via the shared transform-write path; unknown entity fails loudly. The agent's missing 'move' capability now exists.");
