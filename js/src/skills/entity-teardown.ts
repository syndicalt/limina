// Single canonical teardown path for a world entity.
//
// Every entity-removing skill (scene.destroyEntity, interaction.pickup, …) routes
// through teardownEntity so the four pieces of an entity's footprint are ALWAYS
// freed together and can never diverge again:
//   1. the entity-table identity (entities.destroy),
//   2. the three.js scene object (scene.remove — omitting this is the "ghost mesh"
//      bug: the freed eid stops being transform-synced but the mesh keeps rendering
//      frozen in place),
//   3. the native physics body (op_physics_remove_body),
//   4. the ECS transform binding + recycled eid (despawnRenderable) and tag set.
//
// It returns the destroyed entry so callers can emit their own domain/resource
// events (e.g. interaction.pickedUp, resource.unloaded), or undefined when the id
// was unknown. It performs NO emits and reads no wall clock — safe on the sim path
// and replay-deterministic.

import { despawnRenderable } from "../ecs/world.ts";
import type { EntityEntry } from "../engine.ts";
import type { WorldContext } from "./registry.ts";

export function teardownEntity(world: WorldContext, entity: string): EntityEntry | undefined {
  const entry = world.entities.destroy(entity);
  if (entry === undefined) return undefined;
  if (entry.mesh !== undefined) world.scene.remove(entry.mesh);
  if (entry.bodyId !== undefined) world.ops.op_physics_remove_body(entry.bodyId);
  despawnRenderable(world.ecs, entry.eid);
  world.tags.delete(entry.eid);
  return entry;
}
