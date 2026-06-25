// ecs.* skills — transform component writes + string "component" tags.

import { z } from "../../build/zod.bundle.mjs";
import { createTransformStorage } from "../ecs/facade.ts";
import type { ExecutionContext, SkillDefinition, SkillRegistry } from "./registry.ts";

function eidOf(ctx: ExecutionContext, entity: string): number | undefined {
  return ctx.world.entities.resolve(entity)?.eid;
}

const updateInput = z.object({
  entity: z.string(),
  component: z.enum(["position", "rotation", "scale"]),
  value: z.array(z.number()).min(3).max(4),
});
const updateComponent: SkillDefinition<z.infer<typeof updateInput>, { ok: boolean }> = {
  name: "ecs.updateComponent",
  version: "1.0.0",
  description: "Set an entity's position [x,y,z], rotation quaternion [x,y,z,w], or scale [x,y,z].",
  category: "ecs",
  permissions: ["ecs.modify"],
  input: updateInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const eid = eidOf(ctx, input.entity);
    if (eid === undefined) return { ok: false };
    const storage = ctx.world.transforms ?? createTransformStorage(ctx.world.ecs);
    const v = input.value;
    if (input.component === "position") {
      storage.writePosition(eid, v[0], v[1], v[2]);
    } else if (input.component === "rotation") {
      storage.writeRotation(eid, v[0], v[1], v[2], v[3] ?? 1);
    } else {
      storage.writeScale(eid, v[0], v[1], v[2]);
    }
    ctx.world.spatial?.invalidate();
    ctx.emit("ecs.component.updated", { entity: input.entity, component: input.component });
    return { ok: true };
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
