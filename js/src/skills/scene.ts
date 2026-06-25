// scene.* skills — entity lifecycle + queries over the bitECS world + entity table.

import * as THREE from "../../build/three.bundle.mjs";
import { z } from "../../build/zod.bundle.mjs";
import { MAX_ENTITIES, despawnRenderable, spawnRenderable } from "../ecs/world.ts";
import { querySpatialEntities } from "../spatial/index.ts";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

const createEntityInput = z.object({
  shape: z.enum(["box", "sphere"]).default("box"),
  collider: z.enum(["box", "sphere", "capsule"]).optional(),
  size: z.number().positive().max(50).default(1),
  color: z.number().int().min(0).max(0xffffff).default(0xffffff),
  position: Vec3.default([0, 0, 0]),
  dynamic: z.boolean().default(false),
  static: z.boolean().default(false),
  friction: z.number().min(0).max(10).default(0.5),
  restitution: z.number().min(0).max(2).default(0),
});
const createEntity: SkillDefinition<z.infer<typeof createEntityInput>, { entity: string }> = {
  name: "scene.createEntity",
  version: "1.0.0",
  description: "Create a renderable entity (box or sphere) at a position, optionally with a dynamic physics body. Returns its entity id.",
  category: "scene",
  permissions: ["scene.write"],
  input: createEntityInput,
  output: z.object({ entity: z.string() }),
  handler: (input, ctx) => {
    const [x, y, z] = input.position;
    const geometry = input.shape === "sphere"
      ? new THREE.SphereGeometry(input.size / 2, 24, 16)
      : new THREE.BoxGeometry(input.size, input.size, input.size);
    const material = new THREE.MeshStandardNodeMaterial({ color: input.color, roughness: 0.6, metalness: 0.1 });
    const mesh = new THREE.Mesh(geometry, material);
    ctx.world.scene.add(mesh);
    const eid = spawnRenderable(ctx.world.ecs, mesh, x, y, z);
    if (eid >= MAX_ENTITIES) {
      despawnRenderable(ctx.world.ecs, eid);
      ctx.world.scene.remove(mesh);
      throw new Error("entity capacity exceeded (MAX_ENTITIES)");
    }
    let bodyId: number | undefined;
    const collider = input.collider ?? ((input.dynamic || input.static) ? "box" : undefined);
    if (input.static) {
      if (collider === "sphere") {
        bodyId = ctx.world.ops.op_physics_add_static_sphere(x, y, z, input.size / 2, input.friction, input.restitution);
      } else if (collider === "capsule") {
        bodyId = ctx.world.ops.op_physics_add_static_capsule(x, y, z, input.size / 2, input.size / 4, input.friction, input.restitution);
      } else {
        bodyId = ctx.world.ops.op_physics_add_static_box(
          x, y, z,
          input.size / 2, input.size / 2, input.size / 2,
          input.friction, input.restitution,
        );
      }
    } else if (input.dynamic) {
      if (collider === "sphere") {
        bodyId = ctx.world.ops.op_physics_add_sphere(x, y, z, input.size / 2, input.friction, input.restitution);
      } else if (collider === "capsule") {
        bodyId = ctx.world.ops.op_physics_add_capsule(x, y, z, input.size / 2, input.size / 4, input.friction, input.restitution);
      } else {
        bodyId = ctx.world.ops.op_physics_add_box_material(x, y, z, input.size / 2, input.friction, input.restitution);
      }
    }
    const entity = ctx.world.entities.create({ eid, mesh, bodyId });
    ctx.emit("ecs.component.added", { entity, eid, shape: input.shape, collider, static: input.static });
    return { entity };
  },
};

const destroyEntityInput = z.object({ entity: z.string() });
const destroyEntity: SkillDefinition<z.infer<typeof destroyEntityInput>, { removed: boolean }> = {
  name: "scene.destroyEntity",
  version: "1.0.0",
  description: "Destroy an entity and free its scene object and physics body.",
  category: "scene",
  permissions: ["scene.write"],
  input: destroyEntityInput,
  output: z.object({ removed: z.boolean() }),
  handler: (input, ctx) => {
    const entry = ctx.world.entities.destroy(input.entity);
    if (entry === undefined) return { removed: false };
    if (entry.mesh !== undefined) ctx.world.scene.remove(entry.mesh);
    if (entry.bodyId !== undefined) ctx.world.ops.op_physics_remove_body(entry.bodyId);
    if (entry.resource !== undefined) {
      ctx.emit("resource.unloaded", { entity: input.entity, ...entry.resource });
    }
    despawnRenderable(ctx.world.ecs, entry.eid);
    ctx.world.tags.delete(entry.eid);
    ctx.emit("ecs.component.removed", { entity: input.entity, eid: entry.eid });
    return { removed: true };
  },
};

const queryEntitiesInput = z.object({
  near: Vec3.optional(),
  radius: z.number().positive().optional(),
  tag: z.string().optional(),
});
const queryEntities: SkillDefinition<
  z.infer<typeof queryEntitiesInput>,
  { entities: { entity: string; position: [number, number, number]; distance: number }[] }
> = {
  name: "scene.queryEntities",
  version: "1.0.0",
  description: "List entities, optionally filtered by tag and/or within a radius of a point. Returns ids, positions, distances.",
  category: "scene",
  permissions: ["scene.read"],
  input: queryEntitiesInput,
  output: z.object({
    entities: z.array(z.object({ entity: z.string(), position: Vec3, distance: z.number() })),
  }),
  handler: (input, ctx) => {
    const entities = querySpatialEntities(ctx.world, {
      near: input.near,
      radius: input.radius,
      tag: input.tag,
      sortBy: "entity",
    }).entities.map((entity) => ({
      entity: entity.entity,
      position: entity.position,
      distance: entity.distance,
    }));
    return { entities };
  },
};

export function registerSceneSkills(registry: SkillRegistry): void {
  registry.register(createEntity);
  registry.register(destroyEntity);
  registry.register(queryEntities);
}
