// P60 — moving a body-bound entity re-poses its physics body (no snap-back). ecs.updateComponent
// now calls op_physics_set_body_transform for entities with a body, so the collider follows the
// edit and the per-tick body→SoA sync (syncAllBodies) keeps the new position instead of reverting
// it. This is what makes the editor able to MOVE static/agent-placed physics entities.

import { ops, type WorldContext } from "../src/engine.ts";
import { Position } from "../src/ecs/world.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import { syncAllBodies } from "../src/worldlog/log.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p60_body_move: " + msg);
}

const ctx = createHeadlessContext({ session: "ses_p60" });
const registry = ctx.registry;
const world: WorldContext = ctx.world;
ops.op_physics_create_world(-9.81);
const perms = resolveProfile("builder.readWrite");
const at = (tick: number) => ({ agentId: "agt_p60", sessionId: "ses_p60", permissions: perms, tick, world });

// A STATIC-body box (as an agent places one). Static so it doesn't fall — isolating the move.
const id = ((await registry.invoke("scene.createEntity", { shape: "box", size: 1, static: true, position: [0, 5, 0] }, at(1))).result as { entity: string }).entity;
const eid = world.entities.resolve(id)!.eid;
const bodyId = world.entities.resolve(id)!.bodyId;
assert(bodyId !== undefined, "static entity must have a physics body");

// Baseline: after a step + sync, a static body stays put.
ops.op_physics_step();
syncAllBodies(world);
assert(Math.abs(Position.x[eid] - 0) < 1e-4, `static body should start at x=0, got ${Position.x[eid]}`);

// Move it via ecs.updateComponent — the body must be re-posed so it does NOT snap back.
await registry.invoke("ecs.updateComponent", { entity: id, component: "position", value: [7, 5, -2] }, at(2));
assert(Math.abs(Position.x[eid] - 7) < 1e-4, `SoA should reflect the edit immediately: x=${Position.x[eid]}`);

// The critical assertion: after the next physics step + body→SoA sync, the entity stays at the
// new position (the body followed), instead of reverting to (0,5,0).
ops.op_physics_step();
syncAllBodies(world);
assert(Math.abs(Position.x[eid] - 7) < 1e-3 && Math.abs(Position.z[eid] + 2) < 1e-3,
  `body did not follow the move — snapped back to (${Position.x[eid]}, _, ${Position.z[eid]}) instead of (7, _, -2)`);

// A body-LESS renderable is unaffected (no body to re-pose; the op is a no-op for a missing id).
const r = ((await registry.invoke("scene.createEntity", { shape: "sphere", size: 1, position: [1, 1, 1] }, at(3))).result as { entity: string }).entity;
assert(world.entities.resolve(r)!.bodyId === undefined, "plain shape has no body");
await registry.invoke("ecs.updateComponent", { entity: r, component: "position", value: [9, 1, 1] }, at(4));
assert(Math.abs(Position.x[world.entities.resolve(r)!.eid] - 9) < 1e-4, "body-less entity still moves via SoA");

ops.op_log("[js] p60_body_move OK: op_physics_set_body_transform re-poses a body-bound entity on move so its collider follows and it does not snap back; body-less entities unaffected");
