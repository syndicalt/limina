// ecs.* skills — transform component writes + string "component" tags.

import { z } from "../../build/zod.bundle.mjs";
import { createTransformStorage } from "../ecs/facade.ts";
import { Position, Rotation } from "../ecs/world.ts";
import { propagateTransform } from "../ecs/hierarchy.ts";
import type { ExecutionContext, SkillDefinition, SkillRegistry } from "./registry.ts";

function eidOf(ctx: ExecutionContext, entity: string): number | undefined {
  return ctx.world.entities.resolve(entity)?.eid;
}

/** Write ONE transform component (position [x,y,z] / rotation quaternion [x,y,z,w] / scale [x,y,z])
 *  onto an existing entity, keeping everything downstream consistent: re-poses a bound physics body
 *  (so the collider follows AND the per-tick body→SoA sync doesn't snap it back), invalidates the
 *  spatial index, and propagates to any child subtree. THE one place transform writes happen —
 *  ecs.updateComponent and scene.moveEntity both go through it. Returns false if the entity is
 *  unknown. Runs inside a skill (depth>0) so it is NOT recorded separately — replay re-derives it. */
export function writeTransformComponent(
  ctx: ExecutionContext,
  entity: string,
  component: "position" | "rotation" | "scale",
  value: readonly number[],
): boolean {
  const eid = eidOf(ctx, entity);
  if (eid === undefined) return false;
  const storage = ctx.world.transforms ?? createTransformStorage(ctx.world.ecs);
  if (component === "position") storage.writePosition(eid, value[0], value[1], value[2]);
  else if (component === "rotation") storage.writeRotation(eid, value[0], value[1], value[2], value[3] ?? 1);
  else storage.writeScale(eid, value[0], value[1], value[2]);
  ctx.world.spatial?.invalidate();
  const entry = ctx.world.entities.resolve(entity);
  if (entry?.bodyId !== undefined && component !== "scale") {
    ctx.world.ops.op_physics_set_body_transform(
      entry.bodyId,
      Position.x[eid], Position.y[eid], Position.z[eid],
      Rotation.x[eid], Rotation.y[eid], Rotation.z[eid], Rotation.w[eid],
    );
  }
  if (ctx.world.entities.childrenOf(entity).length > 0) propagateTransform(ctx.world, entity);
  return true;
}

const updateInput = z.object({
  entity: z.string(),
  component: z.enum(["position", "rotation", "scale"]),
  value: z.array(z.number()).min(3).max(4),
});
const updateComponent: SkillDefinition<z.infer<typeof updateInput>, { ok: boolean }> = {
  name: "ecs.updateComponent",
  version: "1.0.0",
  description: "Set an entity's position [x,y,z], rotation quaternion [x,y,z,w], or scale [x,y,z]. (To move/reposition an existing entity, scene.moveEntity is the friendlier tool.)",
  category: "ecs",
  permissions: ["ecs.modify"],
  input: updateInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const ok = writeTransformComponent(ctx, input.entity, input.component, input.value);
    if (ok) ctx.emit("ecs.component.updated", { entity: input.entity, component: input.component });
    return { ok };
  },
};

const tagInput = z.object({ entity: z.string(), component: z.string().min(1) });

const addComponent: SkillDefinition<z.infer<typeof tagInput>, { ok: boolean }> = {
  name: "ecs.addComponent",
  version: "1.0.0",
  description: "Tag an entity with a named component (e.g. 'target', 'hostile').",
  category: "ecs",
  permissions: ["ecs.modify"],
  input: tagInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const eid = eidOf(ctx, input.entity);
    if (eid === undefined) return { ok: false };
    let set = ctx.world.tags.get(eid);
    if (set === undefined) {
      set = new Set();
      ctx.world.tags.set(eid, set);
    }
    set.add(input.component);
    ctx.emit("ecs.component.added", { entity: input.entity, component: input.component });
    return { ok: true };
  },
};

const removeComponent: SkillDefinition<z.infer<typeof tagInput>, { ok: boolean }> = {
  name: "ecs.removeComponent",
  version: "1.0.0",
  description: "Remove a named component tag from an entity.",
  category: "ecs",
  permissions: ["ecs.modify"],
  input: tagInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const eid = eidOf(ctx, input.entity);
    if (eid === undefined) return { ok: false };
    const removed = ctx.world.tags.get(eid)?.delete(input.component) ?? false;
    if (removed) ctx.emit("ecs.component.removed", { entity: input.entity, component: input.component });
    return { ok: removed };
  },
};

export function registerEcsSkills(registry: SkillRegistry): void {
  registry.register(updateComponent);
  registry.register(addComponent);
  registry.register(removeComponent);
}
