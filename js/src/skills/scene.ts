// scene.* skills — entity lifecycle + queries over the bitECS world + entity table.

import * as THREE from "../../build/three.bundle.mjs";
import { z } from "../../build/zod.bundle.mjs";
import { MAX_ENTITIES, Position, Rotation, Scale, despawnRenderable, spawnRenderable } from "../ecs/world.ts";
import { teardownEntity } from "./entity-teardown.ts";
import { createMaterial, getMaterialParams, isMaterialName, MATERIAL_NAMES } from "../materials/palette.ts";
import type { MaterialRegistry } from "../materials/material-registry.ts";
import { querySpatialEntities } from "../spatial/index.ts";
import { computeLocalOffset, isAncestor, propagateTransform } from "../ecs/hierarchy.ts";
import { tagEntity, writeTransformComponent } from "./ecs.ts";
import { spawnStaticMesh } from "./architecture.ts";
import { buildGeometry, GeometrySpecSchema } from "../geometry/geometry-spec.ts";
import type { MaterialState, TransformOffset } from "../engine.ts";
import type { ExecutionContext, SkillDefinition, SkillRegistry, WorldContext } from "./registry.ts";
import {
  ENTITY_RECIPE_VERSION,
  type EntityRecipe,
  EntityRecipeSchema,
  validateEntityRecipe,
} from "../scene/entity-recipe.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

// ── Deterministic seeded PRNG (mulberry32) — pure integer math, NO Math.random, so a seed always
// yields the same stream (replay-safe + headless). Used to give scene.createMesh optional, genuine
// per-instance geometry variation (the "each stamped house differs" knob a prefab reseed drives). ──
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Displace every position vertex by a small, seeded offset proportional to the geometry's extent on
// each axis, giving a genuinely DIFFERENT (but deterministic) mesh per seed while preserving the gross
// shape. Applied BEFORE the collider AABB is measured so the box collider still matches the mesh.
const JITTER_AMPLITUDE = 0.12; // fraction of each axis extent
function jitterGeometry(geo: THREE.BufferGeometry, seed: number): void {
  geo.computeBoundingBox();
  const bb = geo.boundingBox as { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  const ex = [bb.max.x - bb.min.x || 1, bb.max.y - bb.min.y || 1, bb.max.z - bb.min.z || 1];
  const rng = mulberry32(seed);
  const pos = geo.getAttribute("position") as {
    count: number;
    getX(i: number): number;
    getY(i: number): number;
    getZ(i: number): number;
    setXYZ(i: number, x: number, y: number, z: number): void;
    needsUpdate: boolean;
  };
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) + (rng() - 0.5) * JITTER_AMPLITUDE * ex[0],
      pos.getY(i) + (rng() - 0.5) * JITTER_AMPLITUDE * ex[1],
      pos.getZ(i) + (rng() - 0.5) * JITTER_AMPLITUDE * ex[2],
    );
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

// The parameterized visual PRIMITIVES scene.createEntity can build (all deterministic THREE geometry).
// `box`/`sphere` are the original two; the rest widen the general building hand. Default stays "box"
// so existing recordings are byte-identical.
const PRIMITIVE_SHAPES = ["box", "sphere", "cylinder", "cone", "plane", "capsule", "torus"] as const;

// ── SHAPE → PHYSICS-COLLIDER MAP (honest approximations) ────────────────────────────────────────
// The native physics backend ships ONLY box / sphere / capsule colliders. Each visual shape maps to
// the nearest SOUND collider; a `collider` override is always honored. Defaults (no override):
//   box      → box     : AABB is exact.
//   sphere   → box     : the sphere's bounding cube (UNCHANGED from before — the historical default).
//                        Pass collider:"sphere" for the tight sphere collider.
//   cylinder → box     : AABB is tight (height==size, radius==size/2) — the round side is boxed.
//   cone     → box     : AABB is tight; the tapered/apex volume above the base is over-approximated.
//   plane    → box     : a THIN slab (Z half floored to 0.02m) — a flat quad has ~0 thickness.
//   capsule  → box     : the capsule's bounding box (taller than a cube; the round caps are boxed).
//                        Pass collider:"capsule" for the true capsule collider.
//   torus    → box     : the outer-ring bounding box — the central HOLE is filled (not represented).
// The box collider is derived from the ACTUAL geometry's AABB (boxColliderHalf), so it is always a
// SOUND over-approximation (never smaller than the mesh), never a silently-wrong sphere/tunnel.

/** Build a deterministic primitive geometry from the shape + a single uniform `size`. box/sphere
 *  are byte-identical to the original two; the rest fit inside the same `size` extent. */
function primitiveGeometry(shape: (typeof PRIMITIVE_SHAPES)[number], size: number): THREE.BufferGeometry {
  const r = size / 2;
  switch (shape) {
    case "sphere":
      return new THREE.SphereGeometry(r, 24, 16);
    case "cylinder":
      return new THREE.CylinderGeometry(r, r, size, 24);
    case "cone":
      return new THREE.ConeGeometry(r, size, 24);
    case "plane":
      return new THREE.PlaneGeometry(size, size);
    case "capsule":
      return new THREE.CapsuleGeometry(r, size, 8, 16);
    case "torus":
      return new THREE.TorusGeometry(r, size / 6, 12, 24);
    case "box":
    default:
      return new THREE.BoxGeometry(size, size, size);
  }
}

/** Half-extents of a geometry's axis-aligned bounding box, for a SOUND box collider. A near-zero
 *  extent (a plane's thickness) is floored to 0.02m so the collider is a usable thin slab, never
 *  degenerate. For box/sphere this is exactly [size/2, size/2, size/2] — byte-identical to before. */
function boxColliderHalf(geo: THREE.BufferGeometry): [number, number, number] {
  geo.computeBoundingBox();
  const bb = geo.boundingBox as { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  const floor = (h: number): number => (h < 1e-4 ? 0.02 : h);
  return [floor((bb.max.x - bb.min.x) / 2), floor((bb.max.y - bb.min.y) / 2), floor((bb.max.z - bb.min.z) / 2)];
}

/** Resolve a surface into a live THREE material AND its first-class MaterialState (see MaterialState):
 *   • palette name  → createMaterial (flat by default; procedural-PBR when `pbr`);
 *   • imported name → the built texture-pack material (material.import);
 *   • no name       → the legacy numeric-color path (byte-identical to before).
 *  Shared by scene.createEntity and scene.createMesh so the material path is authored once. */
function resolveSurface(
  materials: MaterialRegistry | undefined,
  material: string | undefined,
  pbr: boolean,
  color: number,
): { surface: THREE.MeshStandardNodeMaterial; state: MaterialState } {
  if (material === undefined) {
    return {
      surface: new THREE.MeshStandardNodeMaterial({ color, roughness: 0.6, metalness: 0.1 }),
      state: { color, roughness: 0.6, metalness: 0.1 },
    };
  }
  if (isMaterialName(material)) {
    return {
      surface: createMaterial(material, { pbr }),
      state: { name: material, pbr, ...getMaterialParams(material) },
    };
  }
  if (materials?.has(material)) {
    return { surface: materials.build(material), state: { name: material, pbr: true } };
  }
  const imported = materials?.names() ?? [];
  throw new Error(
    `unknown material "${material}"; known palette: ${MATERIAL_NAMES.join(", ")}` +
      (imported.length > 0 ? `; imported: ${imported.join(", ")}` : ""),
  );
}

const createEntityInput = z.object({
  shape: z.enum(PRIMITIVE_SHAPES).default("box"),
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
  // Scene hierarchy: create this entity as a child of `parent` (an ent_ id). Its
  // localOffset is captured from `position` (world) relative to the parent's world transform.
  parent: z.string().optional(),
  // Semantic tags for the new entity (e.g. ["rock","cover"]) — queryable in the World panel /
  // scene.queryEntities. Tag what you create so the scene stays organised.
  tags: z.array(z.string()).optional(),
});
function makeCreateEntity(
  materials?: MaterialRegistry,
): SkillDefinition<z.infer<typeof createEntityInput>, { entity: string }> {
  return {
    name: "scene.createEntity",
    version: "1.0.0",
    description:
      "Create a renderable entity (box, sphere, cylinder, cone, plane, capsule, or torus) at a position, optionally with a dynamic physics body. The `material` field accepts a palette name (optionally upgraded to procedural-PBR via `pbr: true`) or an imported texture-pack material name (material.import). Returns its entity id.",
    category: "scene",
    permissions: ["scene.write"],
    input: createEntityInput,
    output: z.object({ entity: z.string() }),
    handler: (input, ctx) => {
      const [x, y, z] = input.position;
      const geometry = primitiveGeometry(input.shape, input.size);
      const { surface: material, state: materialState } = resolveSurface(
        materials,
        input.material,
        input.pbr,
        input.color,
      );
      const mesh = new THREE.Mesh(geometry, material);
      ctx.world.scene.add(mesh);
      const eid = spawnRenderable(ctx.world.ecs, mesh, x, y, z);
      if (eid >= MAX_ENTITIES) {
        despawnRenderable(ctx.world.ecs, eid);
        ctx.world.scene.remove(mesh);
        throw new Error("entity capacity exceeded (MAX_ENTITIES)");
      }
      let bodyId: number | undefined;
      const collider = input.collider ?? (input.dynamic || input.static ? "box" : undefined);
      if (input.static) {
        if (collider === "sphere") {
          bodyId = ctx.world.ops.op_physics_add_static_sphere(
            x,
            y,
            z,
            input.size / 2,
            input.friction,
            input.restitution,
          );
        } else if (collider === "capsule") {
          bodyId = ctx.world.ops.op_physics_add_static_capsule(
            x,
            y,
            z,
            input.size / 2,
            input.size / 4,
            input.friction,
            input.restitution,
          );
        } else {
          // Box collider = the AABB of the ACTUAL geometry (see SHAPE → COLLIDER MAP): exact for box,
          // tight for cylinder/cone, a thin slab for plane, the outer bbox for torus/capsule. For
          // box/sphere this is [size/2, size/2, size/2] — byte-identical to before.
          const [hx, hy, hz] = boxColliderHalf(geometry);
          bodyId = ctx.world.ops.op_physics_add_static_box(x, y, z, hx, hy, hz, input.friction, input.restitution);
        }
      } else if (input.dynamic) {
        if (collider === "sphere") {
          bodyId = ctx.world.ops.op_physics_add_sphere(x, y, z, input.size / 2, input.friction, input.restitution);
        } else if (collider === "capsule") {
          bodyId = ctx.world.ops.op_physics_add_capsule(
            x,
            y,
            z,
            input.size / 2,
            input.size / 4,
            input.friction,
            input.restitution,
          );
        } else {
          // Dynamic box collider takes a single uniform half-extent (the backend op): a cube of size/2.
          // Byte-identical for the box shape; a coarse cube for a dynamic round shape (rare — static is
          // the common path for these and gets the tight AABB above).
          bodyId = ctx.world.ops.op_physics_add_box_material(
            x,
            y,
            z,
            input.size / 2,
            input.friction,
            input.restitution,
          );
        }
      }
      // Persist the create command as the entity's origin so a self-sufficient snapshot can
      // carry the structural params (shape/size/material/color) a bounded-tail viewer needs
      // to rebuild the mesh once this create command has been compacted out of the live log.
      // materialState (first-class MaterialState — see resolveSurface) survives without a live mesh.
      const origin = { tool: "scene.createEntity", input: { ...input } };
      const entity = ctx.world.entities.create({ eid, mesh, bodyId, origin, material: materialState });
      // Parent, if the referenced entity is live: capture the child's offset (its create
      // position relative to the parent's world transform) so a later parent move propagates.
      if (input.parent !== undefined && ctx.world.entities.resolve(input.parent) !== undefined) {
        ctx.world.entities.setParent(entity, input.parent, computeLocalOffset(ctx.world, input.parent, eid));
      }
      if (input.tags !== undefined && input.tags.length > 0) tagEntity(ctx, entity, input.tags);
      ctx.emit("ecs.component.added", { entity, eid, shape: input.shape, collider, static: input.static });
      return { entity };
    },
  };
}

// ── scene.createMesh — the DECLARATIVE custom-geometry hand ──────────────────────────────────────
// Where scene.createEntity offers a fixed menu of size-scaled primitives, scene.createMesh takes a
// full GeometrySpec (a versioned, recorded wire format — see geometry/geometry-spec.ts): any
// parameterized primitive OR an EXTRUDE spec (a 2D profile swept to a depth), so genuinely custom
// shapes are reachable with NO shape-specific skill. It feeds spawnStaticMesh (the already-general
// "any THREE.Mesh → entity" seam), binds first-class material state, and sets transform/tags/parent.
// The geometry is a pure, deterministic value → the same spec yields byte-identical vertex buffers,
// and the recorded command replays/exports faithfully.
const createMeshInput = z.object({
  geometry: GeometrySpecSchema,
  position: Vec3.default([0, 0, 0]),
  // Heading in radians about +Y — the simple "turn it" knob. Ignored if `rotation` is given.
  yaw: z.number().optional(),
  // Full orientation quaternion [x,y,z,w] (overrides `yaw`). Re-poses the collider too.
  rotation: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  // Uniform scale (number) or per-axis [x,y,z]. The box collider is sized to match (visual == collider).
  scale: z
    .union([z.number().positive(), z.tuple([z.number().positive(), z.number().positive(), z.number().positive()])])
    .optional(),
  material: z.string().optional(),
  pbr: z.boolean().default(false),
  color: z.number().int().min(0).max(0xffffff).default(0xffffff),
  // Optional deterministic geometry variation: when set, the vertices are displaced by a small,
  // SEEDED offset (same seed → identical mesh; different seed → a genuinely different mesh). This is
  // the seed-bearing knob a prefab reseed (scene.instantiateGroup) drives so each stamped instance
  // varies. Absent → no jitter, byte-identical to before.
  seed: z.number().int().optional(),
  // Scene hierarchy: create this entity as a child of `parent` (an ent_ id).
  parent: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
function makeCreateMesh(
  materials?: MaterialRegistry,
): SkillDefinition<z.infer<typeof createMeshInput>, { entity: string }> {
  return {
    name: "scene.createMesh",
    version: "1.0.0",
    description:
      "Create a renderable entity from a DECLARATIVE geometry spec — any parameterized primitive " +
      "(box/sphere/cylinder/cone/plane/capsule/torus) or an `extrude` spec (a 2D profile [[x,y],...] swept " +
      "to a depth) — so custom shapes are reachable with no shape-specific skill. Sets position/rotation/scale " +
      "and material (palette name, optionally PBR, or an imported material); a sound axis-aligned box collider " +
      "is derived from the geometry. Optional `seed` deterministically varies the geometry (per-vertex jitter) " +
      "so a prefab can be stamped with per-instance variation. Deterministic + recorded. Returns its entity id.",
    category: "scene",
    permissions: ["scene.write"],
    input: createMeshInput,
    output: z.object({ entity: z.string() }),
    handler: (input, ctx) => {
      const [x, y, z] = input.position;
      // Pure, deterministic geometry construction (headless-safe — no GL context needed).
      const geometry = buildGeometry(input.geometry);
      // Optional seeded per-vertex variation (before collider AABB is measured so they stay matched).
      if (input.seed !== undefined) jitterGeometry(geometry, input.seed);
      const { surface, state } = resolveSurface(materials, input.material, input.pbr, input.color);
      const mesh = new THREE.Mesh(geometry, surface);
      // Sound box collider = the geometry's AABB, scaled to match the visual scale so collider == mesh.
      const s: [number, number, number] =
        input.scale === undefined
          ? [1, 1, 1]
          : typeof input.scale === "number"
            ? [input.scale, input.scale, input.scale]
            : input.scale;
      const [bx, by, bz] = boxColliderHalf(geometry);
      const half: [number, number, number] = [bx * s[0], by * s[1], bz * s[2]];
      // spawnStaticMesh (from architecture.ts) is the already-general seam: it turns ANY mesh into a
      // real collidable entity. Rotation is applied below via the shared transform writer (yaw=0 here)
      // so the collider follows a full quaternion, not just yaw. Pass the create command as `origin` so
      // a self-sufficient snapshot can rebuild this procedurally-built mesh after the create command is
      // compacted out of the live log (parity with scene.createEntity).
      const origin = { tool: "scene.createMesh", input: { ...input } };
      const entity = spawnStaticMesh(ctx.world, mesh, [x, y, z], half, 0, origin);
      // First-class material state — survives without a live mesh (asset/headless entities), like
      // scene.createEntity / three.setMaterial.
      ctx.world.entities.bindMaterial(entity, state);
      const eid = ctx.world.entities.resolve(entity)?.eid;
      // Orientation: a full quaternion overrides yaw. writeTransformComponent re-poses the physics body
      // so the collider rotates with the mesh.
      const quat =
        input.rotation ??
        (input.yaw !== undefined
          ? ([0, Math.sin(input.yaw / 2), 0, Math.cos(input.yaw / 2)] as [number, number, number, number])
          : undefined);
      if (quat !== undefined) writeTransformComponent(ctx, entity, "rotation", quat);
      // Scale is visual (the collider was pre-scaled above); the physics body is not re-scaled.
      if (input.scale !== undefined) writeTransformComponent(ctx, entity, "scale", s);
      if (input.parent !== undefined && eid !== undefined && ctx.world.entities.resolve(input.parent) !== undefined) {
        ctx.world.entities.setParent(entity, input.parent, computeLocalOffset(ctx.world, input.parent, eid));
      }
      if (input.tags !== undefined && input.tags.length > 0) tagEntity(ctx, entity, input.tags);
      ctx.emit("ecs.component.added", { entity, eid, kind: input.geometry.kind, collider: "box", static: true });
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

const reparentInput = z.object({
  entity: z.string(),
  // The new parent's ent_ id, or null/omitted to unparent the entity back to the world root.
  parent: z.string().nullable().optional(),
  // Default true: the child stays visually in place and its offset is recomputed relative to
  // the new parent (Godot's "keep global transform"). False: its current transform is
  // reinterpreted as the offset under the new parent (it may jump).
  keepWorldTransform: z.boolean().default(true),
});
const reparent: SkillDefinition<z.infer<typeof reparentInput>, { ok: boolean }> = {
  name: "scene.reparent",
  version: "1.0.0",
  description:
    "Set or clear an entity's scene-hierarchy parent. keepWorldTransform (default true) keeps the child in place; parent=null unparents to the world root. Moving a parent later propagates to its children.",
  category: "scene",
  permissions: ["scene.write"],
  input: reparentInput,
  output: z.object({ ok: z.boolean() }),
  handler: (input, ctx) => {
    const entry = ctx.world.entities.resolve(input.entity);
    if (entry === undefined) return { ok: false };
    const parentId = input.parent ?? undefined;
    if (parentId === undefined) {
      ctx.world.entities.setParent(input.entity, undefined);
      return { ok: true };
    }
    // Reject a missing parent or a cycle (parent must not be the entity or its descendant).
    if (ctx.world.entities.resolve(parentId) === undefined) return { ok: false };
    if (isAncestor(ctx.world, input.entity, parentId)) return { ok: false };
    const offset = input.keepWorldTransform
      ? computeLocalOffset(ctx.world, parentId, entry.eid)
      : {
          pos: [Position.x[entry.eid], Position.y[entry.eid], Position.z[entry.eid]] as [number, number, number],
          rot: [Rotation.x[entry.eid], Rotation.y[entry.eid], Rotation.z[entry.eid], Rotation.w[entry.eid]] as [
            number,
            number,
            number,
            number,
          ],
          scale: [Scale.x[entry.eid], Scale.y[entry.eid], Scale.z[entry.eid]] as [number, number, number],
        };
    ctx.world.entities.setParent(input.entity, parentId, offset);
    // keep-world is a no-op reposition; reinterpret-as-local moves the child. Propagate either
    // way so the subtree is consistent (idempotent for keep-world).
    propagateTransform(ctx.world, parentId);
    ctx.emit("scene.reparented", { entity: input.entity, parent: parentId });
    return { ok: true };
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
  description:
    "List entities, optionally filtered by tag and/or within a radius of a point. Returns ids, positions, distances.",
  category: "scene",
  permissions: ["scene.read"],
  effect: "read",
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
  tag: z
    .string()
    .optional()
    .describe(
      "Summarize only entities carrying this tag (the AABB/sample is over the filtered set; the tag census is always global).",
    ),
  sampleSize: z
    .number()
    .int()
    .min(0)
    .max(64)
    .default(8)
    .describe("How many entity positions to include in `sample` (for spot-checking placement)."),
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
  description:
    "Summarize the whole scene for an agent to reason about: entity count, world AABB (min/max/center/size), a global tag census, and a small position sample. Pure read — the perception substrate for self-checking an authored world.",
  category: "scene",
  permissions: ["scene.read"],
  effect: "read",
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
      let mnx = Infinity,
        mny = Infinity,
        mnz = Infinity,
        mxx = -Infinity,
        mxy = -Infinity,
        mxz = -Infinity;
      for (const e of ents) {
        const [x, y, z] = e.position;
        if (x < mnx) mnx = x;
        if (y < mny) mny = y;
        if (z < mnz) mnz = z;
        if (x > mxx) mxx = x;
        if (y > mxy) mxy = y;
        if (z > mxz) mxz = z;
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

// scene.moveEntity — reposition / re-orient / rescale an EXISTING entity. The discoverable "move"
// tool an agent reaches for (ecs.updateComponent is the lower-level primitive). Absolute or relative
// position, a friendly yaw (radians about +Y) or a full quaternion, and uniform or per-axis scale —
// all optional, all routed through the shared writeTransformComponent (physics body + hierarchy stay
// consistent). Applied in place on the live viewport (no reboot).
const moveInput = z.object({
  entity: z.string(),
  /** New position [x,y,z]. With relative:true it is an OFFSET added to the current position. */
  position: z.tuple([z.number(), z.number(), z.number()]).optional(),
  /** Treat `position` as a delta from the entity's current position instead of an absolute point. */
  relative: z.boolean().default(false),
  /** Heading in radians about +Y — the simple "turn it" knob. Ignored if `rotation` is given. */
  yaw: z.number().optional(),
  /** Full orientation quaternion [x,y,z,w] (overrides `yaw`). */
  rotation: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  /** Uniform scale (number) or per-axis [x,y,z]. */
  scale: z
    .union([z.number().positive(), z.tuple([z.number().positive(), z.number().positive(), z.number().positive()])])
    .optional(),
});
const moveEntity: SkillDefinition<z.infer<typeof moveInput>, { entity: string; position: [number, number, number] }> = {
  name: "scene.moveEntity",
  version: "1.0.0",
  description:
    "Move / re-orient / rescale an EXISTING entity: set its position [x,y,z] (absolute, or relative:true for an offset), turn it (yaw radians about +Y, or a full rotation quaternion), and/or rescale it (uniform number or [x,y,z]). This is how you reposition entities after creating them.",
  category: "scene",
  permissions: ["ecs.modify"],
  input: moveInput,
  output: z.object({ entity: z.string(), position: z.tuple([z.number(), z.number(), z.number()]) }),
  handler: (input, ctx) => {
    const entry = ctx.world.entities.resolve(input.entity);
    if (entry === undefined) throw new Error(`scene.moveEntity: unknown entity '${input.entity}'`);
    const eid = entry.eid;

    if (input.position !== undefined) {
      const [px, py, pz] = input.position;
      const target: [number, number, number] = input.relative
        ? [Position.x[eid] + px, Position.y[eid] + py, Position.z[eid] + pz]
        : [px, py, pz];
      writeTransformComponent(ctx, input.entity, "position", target);
    }
    if (input.rotation !== undefined) {
      writeTransformComponent(ctx, input.entity, "rotation", input.rotation);
    } else if (input.yaw !== undefined) {
      const h = input.yaw / 2;
      writeTransformComponent(ctx, input.entity, "rotation", [0, Math.sin(h), 0, Math.cos(h)]);
    }
    if (input.scale !== undefined) {
      const s = typeof input.scale === "number" ? [input.scale, input.scale, input.scale] : input.scale;
      writeTransformComponent(ctx, input.entity, "scale", s);
    }

    const position: [number, number, number] = [Position.x[eid], Position.y[eid], Position.z[eid]];
    ctx.emit("scene.entity.moved", { entity: input.entity, position });
    return { entity: input.entity, position };
  },
};

// ── PREFABS / RECIPES — scene.group + scene.instantiateGroup + scene.duplicate ────────────────────
// A prefab is a recorded "group create", not an opaque template: scene.group CAPTURES a root entity's
// subtree (walk childrenOf) into a named EntityRecipe — each node's origin create-command + its
// transform RELATIVE TO THE ROOT — and scene.instantiateGroup STAMPS that recipe at a target transform
// by REPLAYING each captured create-command under a fresh root, wired with the same parent relations.
// This is built entirely on the EXISTING origin / parent / localOffset machinery — no second scene
// graph — so instantiated entities are ordinary entities that carry their own origin (a self-sufficient
// snapshot rebuilds them) and the replay reconstructs them identically. See scene/entity-recipe.ts.

/** Turn a stored transform-relative-to-root into a THREE matrix (for composing with the target). */
function offsetToMatrix(off: TransformOffset): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(off.pos[0], off.pos[1], off.pos[2]),
    new THREE.Quaternion(off.rot[0], off.rot[1], off.rot[2], off.rot[3]),
    new THREE.Vector3(off.scale[0], off.scale[1], off.scale[2]),
  );
}
function yawQuat(yaw: number): THREE.Quaternion {
  return new THREE.Quaternion(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
}
/** Derive a per-node seed from the instance seed + node index (deterministic integer hash), so two
 *  instances stamped with DIFFERENT seeds reseed each seed-bearing node differently, while the SAME
 *  instance seed reproduces identical node seeds. */
function mixSeed(seed: number, index: number): number {
  return (Math.imul(seed >>> 0, 2654435761) + Math.imul(index + 1, 40503)) >>> 0;
}

/** CAPTURE: walk the subtree rooted at `rootId` (parent-before-child) into a named recipe. Every node
 *  must carry an origin create-command (only entities built through a recorded create skill are
 *  capturable) — otherwise this throws a clear error (a clean {success:false} at the skill boundary). */
function captureRecipe(world: WorldContext, rootId: string, name: string): EntityRecipe {
  if (world.entities.resolve(rootId) === undefined) throw new Error(`scene.group: unknown root entity '${rootId}'`);
  // BFS from the root so parents always precede their children (the order a replay needs).
  const order: string[] = [];
  const indexOf = new Map<string, number>();
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (indexOf.has(id)) continue;
    indexOf.set(id, order.length);
    order.push(id);
    for (const child of world.entities.childrenOf(id)) queue.push(child);
  }
  const nodes = order.map((id, i) => {
    const entry = world.entities.resolve(id);
    if (entry === undefined) throw new Error(`scene.group: entity '${id}' vanished during capture`);
    if (entry.origin === undefined) {
      throw new Error(
        `scene.group: entity '${id}' has no origin create-command; only entities created through a recorded create skill can be captured into a recipe`,
      );
    }
    // Offset RELATIVE TO THE ROOT (root → identity): reuse the exact hierarchy math.
    const offset = computeLocalOffset(world, rootId, entry.eid);
    const parentIdx = i === 0 ? null : entry.parent !== undefined ? (indexOf.get(entry.parent) ?? null) : null;
    return {
      parent: parentIdx,
      origin: { tool: entry.origin.tool, input: { ...entry.origin.input } },
      offset,
    };
  });
  const recipe: EntityRecipe = { version: ENTITY_RECIPE_VERSION, name, nodes };
  const bad = validateEntityRecipe(recipe);
  if (bad !== undefined) throw new Error(`scene.group: captured recipe is not well-formed: ${bad}`);
  return recipe;
}

/** INSTANTIATE: stamp a recipe at `targetMatrix` by replaying each node's origin create-command under a
 *  fresh root. Each node's world transform = target ∘ (offset relative to root); the create command's
 *  position (and, for createMesh, rotation/scale) is overridden to that, its parent is rewired to the
 *  freshly-created parent, and any seed-bearing create is reseeded when `seed` is supplied. Re-invokes
 *  the REAL create skills through the registry (never a reimplementation), passing `ctx.chainId` so the
 *  WorldRecorder folds these nested creates into the single recorded instantiate command. */
async function instantiateRecipe(
  registry: SkillRegistry,
  recipe: EntityRecipe,
  targetMatrix: THREE.Matrix4,
  seed: number | undefined,
  ctx: ExecutionContext,
): Promise<{ root: string; entities: string[] }> {
  const bad = validateEntityRecipe(recipe);
  if (bad !== undefined) throw new Error(`scene.instantiateGroup: malformed recipe '${recipe.name}': ${bad}`);
  const created: string[] = [];
  const _p = new THREE.Vector3(),
    _q = new THREE.Quaternion(),
    _s = new THREE.Vector3();
  const world = new THREE.Matrix4();
  for (let i = 0; i < recipe.nodes.length; i++) {
    const node = recipe.nodes[i];
    world.multiplyMatrices(targetMatrix, offsetToMatrix(node.offset)).decompose(_p, _q, _s);
    const input: Record<string, unknown> = { ...node.origin.input };
    input.position = [_p.x, _p.y, _p.z];
    // createMesh carries its own orientation + scale; createEntity has no rotation field, so it is
    // placed by its (correctly rotated) world position only — its own box is not self-rotated.
    if (node.origin.tool === "scene.createMesh") {
      input.rotation = [_q.x, _q.y, _q.z, _q.w];
      input.scale = [_s.x, _s.y, _s.z];
      delete input.yaw; // an explicit rotation overrides yaw
    }
    // Reseed genuinely seed-bearing creates (only when a seed is supplied — else instances are identical).
    if (seed !== undefined && typeof input.seed === "number") input.seed = mixSeed(seed, i);
    // Wire the fresh subtree: the root is a fresh root (no parent); a child points at its fresh parent.
    if (node.parent === null) delete input.parent;
    else input.parent = created[node.parent];
    const res = await registry.invoke(node.origin.tool, input, {
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      permissions: ctx.permissions,
      tick: ctx.tick,
      world: ctx.world,
      chainId: ctx.chainId,
      chainToken: ctx.chainToken,
    });
    if (!res.success) {
      throw new Error(
        `scene.instantiateGroup: replay of '${node.origin.tool}' (node ${i}) failed: ${JSON.stringify(res.error)}`,
      );
    }
    created.push((res.result as { entity: string }).entity);
  }
  return { root: created[0], entities: created };
}

const ScaleInput = z.union([
  z.number().positive(),
  z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
]);
function normScale(scale: number | [number, number, number] | undefined): [number, number, number] {
  return scale === undefined ? [1, 1, 1] : typeof scale === "number" ? [scale, scale, scale] : scale;
}

const groupInput = z.object({
  // The subtree ROOT to capture (an ent_ id). Its descendants (scene.createEntity({parent}) children)
  // are captured with it. Every captured entity must carry an origin create-command.
  root: z.string(),
  // The name the recipe is registered under (re-instantiated by scene.instantiateGroup).
  name: z.string().min(1),
});
function makeGroup(
  recipes: Map<string, EntityRecipe>,
): SkillDefinition<z.infer<typeof groupInput>, { name: string; nodeCount: number; recipe: EntityRecipe }> {
  return {
    name: "scene.group",
    version: "1.0.0",
    description:
      "Capture an entity's subtree (its scene-hierarchy descendants) as a NAMED, reusable prefab recipe: each node's create-command + its transform relative to the root. scene.instantiateGroup then stamps the recipe many times. Recorded so replay rebuilds the recipe. Returns the recipe.",
    category: "scene",
    permissions: ["scene.write"],
    input: groupInput,
    output: z.object({ name: z.string(), nodeCount: z.number(), recipe: EntityRecipeSchema }),
    handler: (input, ctx) => {
      const recipe = captureRecipe(ctx.world, input.root, input.name);
      recipes.set(input.name, recipe);
      return { name: input.name, nodeCount: recipe.nodes.length, recipe };
    },
  };
}

const instantiateGroupInput = z.object({
  // The recipe name registered by scene.group.
  name: z.string().min(1),
  // Where to stamp the fresh root [x,y,z].
  position: Vec3.default([0, 0, 0]),
  // Heading of the stamped instance in radians about +Y.
  yaw: z.number().default(0),
  // Uniform scale (number) or per-axis [x,y,z] applied to the whole instance.
  scale: ScaleInput.optional(),
  // Optional per-instance seed: reseeds every seed-bearing create in the recipe so this instance
  // varies from the next (same seed → identical instance; omitted → the recipe's captured seeds).
  seed: z.number().int().optional(),
});
function makeInstantiateGroup(
  registry: SkillRegistry,
  recipes: Map<string, EntityRecipe>,
): SkillDefinition<z.infer<typeof instantiateGroupInput>, { root: string; entities: string[] }> {
  return {
    name: "scene.instantiateGroup",
    version: "1.0.0",
    description:
      "Stamp a named prefab recipe (from scene.group) at a position/yaw/scale, re-creating its whole subtree wired with the same parenting. An optional `seed` reseeds seed-bearing parts so each instance varies (deterministic: same recipe+transform+seed → identical entities). Recorded + replay-safe. Returns the fresh root + all created entity ids.",
    category: "scene",
    permissions: ["scene.write"],
    input: instantiateGroupInput,
    output: z.object({ root: z.string(), entities: z.array(z.string()) }),
    handler: async (input, ctx) => {
      const recipe = recipes.get(input.name);
      if (recipe === undefined) throw new Error(`scene.instantiateGroup: unknown recipe '${input.name}'`);
      const s = normScale(input.scale);
      const targetMatrix = new THREE.Matrix4().compose(
        new THREE.Vector3(input.position[0], input.position[1], input.position[2]),
        yawQuat(input.yaw),
        new THREE.Vector3(s[0], s[1], s[2]),
      );
      return instantiateRecipe(registry, recipe, targetMatrix, input.seed, ctx);
    },
  };
}

const duplicateInput = z.object({
  // The entity (root of a subtree) to duplicate. Its descendants are duplicated with it.
  entity: z.string(),
  // Offset added to the source's world position for the copy [x,y,z].
  offset: Vec3.default([0, 0, 0]),
  // Extra yaw (radians about +Y) applied to the copy ON TOP of the source's orientation.
  yaw: z.number().default(0),
  // Optional seed to reseed seed-bearing parts of the copy (else the copy matches the source).
  seed: z.number().int().optional(),
});
function makeDuplicate(
  registry: SkillRegistry,
): SkillDefinition<z.infer<typeof duplicateInput>, { root: string; entities: string[] }> {
  return {
    name: "scene.duplicate",
    version: "1.0.0",
    description:
      "Duplicate an entity (and its subtree) at an offset from the source, preserving the source's orientation/scale plus an optional extra yaw. A convenience over scene.group + scene.instantiateGroup. Recorded + replay-safe. Returns the copy's root + all created entity ids.",
    category: "scene",
    permissions: ["scene.write"],
    input: duplicateInput,
    output: z.object({ root: z.string(), entities: z.array(z.string()) }),
    handler: async (input, ctx) => {
      const src = ctx.world.entities.resolve(input.entity);
      if (src === undefined) throw new Error(`scene.duplicate: unknown entity '${input.entity}'`);
      // An ephemeral (unregistered) recipe captured on the fly — duplicate is capture + instantiate.
      const recipe = captureRecipe(ctx.world, input.entity, `__dup:${input.entity}`);
      const eid = src.eid;
      // Target = source's world transform, translated by offset, with any extra yaw composed onto its
      // orientation. The recipe's offsets are relative to its (identity) root, so this places the copy
      // exactly like the source, shifted.
      const rot = new THREE.Quaternion(Rotation.x[eid], Rotation.y[eid], Rotation.z[eid], Rotation.w[eid]).multiply(
        yawQuat(input.yaw),
      );
      const targetMatrix = new THREE.Matrix4().compose(
        new THREE.Vector3(
          Position.x[eid] + input.offset[0],
          Position.y[eid] + input.offset[1],
          Position.z[eid] + input.offset[2],
        ),
        rot,
        new THREE.Vector3(Scale.x[eid], Scale.y[eid], Scale.z[eid]),
      );
      return instantiateRecipe(registry, recipe, targetMatrix, input.seed, ctx);
    },
  };
}

export function registerSceneSkills(registry: SkillRegistry, materials?: MaterialRegistry): void {
  registry.register(makeCreateEntity(materials));
  registry.register(makeCreateMesh(materials));
  registry.register(destroyEntity);
  registry.register(reparent);
  registry.register(queryEntities);
  registry.register(inspectScene);
  registry.register(moveEntity);
  // Per-project prefab registry — one Map per registerSceneSkills call (one registry == one project),
  // shared by group / instantiateGroup / duplicate. Not global/shared state; promotable later.
  const recipes = new Map<string, EntityRecipe>();
  registry.register(makeGroup(recipes));
  registry.register(makeInstantiateGroup(registry, recipes));
  registry.register(makeDuplicate(registry));
}
