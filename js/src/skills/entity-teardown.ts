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
import { disposeEntitySceneResources } from "../render/entity-scene-resources.ts";
import type { WorldContext } from "./registry.ts";

export function teardownEntity(world: WorldContext, entity: string): EntityEntry | undefined {
  const entry = world.entities.destroy(entity);
  if (entry === undefined) return undefined;
  const errors: unknown[] = [];
  const attempt = (operation: () => void): void => {
    try { operation(); } catch (error) { errors.push(error); }
  };
  // Runtime-only owners (compute kernels, direct scene mounts, retained callbacks) release first.
  // Continue through ordinary mesh/physics/ECS cleanup even when one disposer fails.
  if (entry.runtimeDispose !== undefined) attempt(entry.runtimeDispose);
  if (entry.mesh !== undefined) {
    attempt(() => world.scene.remove(entry.mesh!));
    attempt(() => disposeEntitySceneResources(entry.mesh!));
  }
  if (entry.bodyId !== undefined) attempt(() => world.ops.op_physics_remove_body(entry.bodyId!));
  attempt(() => despawnRenderable(world.ecs, entry.eid));
  attempt(() => { world.tags.delete(entry.eid); });
  if (errors.length > 0) {
    throw new AggregateError(errors, `entity teardown failed for '${entity}' in ${errors.length} operation(s)`);
  }
  return entry;
}
