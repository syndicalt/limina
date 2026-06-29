// scene.* skills — entity lifecycle + queries over the bitECS world + entity table.

import * as THREE from "../../build/three.bundle.mjs";
import { z } from "../../build/zod.bundle.mjs";
import { MAX_ENTITIES, despawnRenderable, spawnRenderable } from "../ecs/world.ts";
import { teardownEntity } from "./entity-teardown.ts";
import { createMaterial, isMaterialName, MATERIAL_NAMES } from "../materials/palette.ts";
import type { MaterialRegistry } from "../materials/material-registry.ts";
import { querySpatialEntities } from "../spatial/index.ts";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

const createEntityInput = z.object({
  shape: z.enum(["box", "sphere"]).default("box"),
  collider: z.enum(["box", "sphere", "capsule"]).optional(),
  size: z.number().positive().max(50).default(1),
  // Pick a material by intent ("sand", "wood", ...) from the named palette, OR an
  // imported texture-pack material name (material.import). When set it supplies the
  // surface; the numeric `color` below is the back-compat path used when no name is given.
  material: z.string().optional(),
  // Opt-in: upgrade a PALETTE material to a procedural-PBR surface (triplanar noise
  // albedo + a real detail normal + honest roughness, matching the terrain). Default
  // false → flat preset, byte-identical to before. Ignored for imported materials
  // (already PBR) and for the numeric color path.
  pbr: z.boolean().default(false),
  color: z.number().int().min(0).max(0xffffff).default(0xffffff),
  position: Vec3.default([0, 0, 0]),
  dynamic: z.boolean().default(false),
  static: z.boolean().default(false),
  friction: z.number().min(0).max(10).default(0.5),
  restitution: z.number().min(0).max(2).default(0),
});
function makeCreateEntity(materials?: MaterialRegistry): SkillDefinition<z.infer<typeof createEntityInput>, { entity: string }> {
 return {
  name: "scene.createEntity",
  version: "1.0.0",
  description: "Create a renderable entity (box or sphere) at a position, optionally with a dynamic physics body. The `material` field accepts a palette name (optionally upgraded to procedural-PBR via `pbr: true`) or an imported texture-pack material name (material.import). Returns its entity id.",
  category: "scene",
  permissions: ["scene.write"],
  input: createEntityInput,
  output: z.object({ entity: z.string() }),
  handler: (input, ctx) => {
    const [x, y, z] = input.position;
    const geometry = input.shape === "sphere"
      ? new THREE.SphereGeometry(input.size / 2, 24, 16)
      : new THREE.BoxGeometry(input.size, input.size, input.size);
    // Material resolution, in order:
    //   • palette name  → createMaterial (flat by default; procedural-PBR when `pbr`).
    //   • imported name → the built texture-pack material (material.import).
    //   • no name       → the legacy numeric color path (byte-identical to before).
    let material: THREE.MeshStandardNodeMaterial;
    if (input.material !== undefined) {
      if (isMaterialName(input.material)) {
        material = createMaterial(input.material, { pbr: input.pbr });
      } else if (materials?.has(input.material)) {
        material = materials.build(input.material);
      } else {
        const imported = materials?.names() ?? [];
        throw new Error(
          `unknown material "${input.material}"; known palette: ${MATERIAL_NAMES.join(", ")}` +
          (imported.length > 0 ? `; imported: ${imported.join(", ")}` : ""),
        );
      }
    } else {
      material = new THREE.MeshStandardNodeMaterial({ color: input.color, roughness: 0.6, metalness: 0.1 });
    }
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
}

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
    // Full teardown (entity-table + scene mesh + physics body + ECS binding + tags)
    // via the single shared path, then emit this skill's domain/resource events.
    const entry = teardownEntity(ctx.world, input.entity);
    if (entry === undefined) return { removed: false };
    if (entry.resource !== undefined) {
      ctx.emit("resource.unloaded", { entity: input.entity, ...entry.resource });
    }
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

// ---- scene.inspect (the "Eyes" perception substrate) ----------------------------------------
// A structured, whole-scene summary an agent reads to reason about WHAT IT BUILT before it
// renders a pixel: how many entities, their world AABB / center / size, a tag census, and a
// small position sample. This is the perception half of the self-correction loop — it lets an
// agent sanity-check its world ("200 entities spanning ~96m, tags: relic×3, tree×40") and catch
// gross authoring mistakes (nothing placed, everything at the origin, runaway bounds) without
// needing the GPU. Pure read — emits nothing, mutates nothing.
const inspectInput = z.object({
  tag: z.string().optional().describe("Summarize only entities carrying this tag (the AABB/sample is over the filtered set; the tag census is always global)."),
  sampleSize: z.number().int().min(0).max(64).default(8).describe("How many entity positions to include in `sample` (for spot-checking placement)."),
});
const inspectScene: SkillDefinition<
  z.infer<typeof inspectInput>,
  {
    entityCount: number;
    bounds: { min: [number, number, number]; max: [number, number, number] } | null;
    center: [number, number, number] | null;
    size: [number, number, number] | null;
    tagCounts: Record<string, number>;
    sample: { entity: string; position: [number, number, number] }[];
  }
> = {
  name: "scene.inspect",
  version: "1.0.0",
  description: "Summarize the whole scene for an agent to reason about: entity count, world AABB (min/max/center/size), a global tag census, and a small position sample. Pure read — the perception substrate for self-checking an authored world.",
  category: "scene",
  permissions: ["scene.read"],
  input: inspectInput,
  output: z.object({
    entityCount: z.number(),
    bounds: z.object({ min: Vec3, max: Vec3 }).nullable(),
    center: Vec3.nullable(),
    size: Vec3.nullable(),
    tagCounts: z.record(z.string(), z.number()),
    sample: z.array(z.object({ entity: z.string(), position: Vec3 })),
  }),
  handler: (input, ctx) => {
    const ents = querySpatialEntities(ctx.world, { tag: input.tag, sortBy: "entity" }).entities;
    let bounds: { min: [number, number, number]; max: [number, number, number] } | null = null;
    let center: [number, number, number] | null = null;
    let size: [number, number, number] | null = null;
    if (ents.length > 0) {
      let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
      for (const e of ents) {
        const [x, y, z] = e.position;
        if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z;
        if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
      }
      bounds = { min: [mnx, mny, mnz], max: [mxx, mxy, mxz] };
      center = [(mnx + mxx) / 2, (mny + mxy) / 2, (mnz + mxz) / 2];
      size = [mxx - mnx, mxy - mny, mxz - mnz];
    }
    // Global tag census (independent of the `tag` filter) — an at-a-glance content inventory.
    const tagCounts: Record<string, number> = {};
    for (const set of ctx.world.tags.values()) {
      for (const t of set) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
    }
    const sample = ents.slice(0, input.sampleSize).map((e) => ({ entity: e.entity, position: e.position }));
    return { entityCount: ents.length, bounds, center, size, tagCounts, sample };
  },
};

export function registerSceneSkills(registry: SkillRegistry, materials?: MaterialRegistry): void {
  registry.register(makeCreateEntity(materials));
  registry.register(destroyEntity);
  registry.register(queryEntities);
  registry.register(inspectScene);
}
