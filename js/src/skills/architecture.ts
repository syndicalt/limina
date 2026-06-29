// architecture.* skills — PROCEDURAL ARCHITECTURE (the missing "buildings/interiors" primitive).
//
// architecture.building deterministically emits a hollow, enterable rectangular structure as REAL
// collidable box entities: a floor slab, four walls, a centered doorway (two jamb segments + a
// lintel) cut into one wall, and an optional roof. Everything is parametric and replay-safe — the
// same input yields byte-identical geometry and entity creation order, so a recorded session
// replays bit-identically (the entities flow through the normal scene/entity-table/physics path).
//
// This is the generative LAYOUT primitive an agent (or the AI director) composes into towns: call
// it N times with different footprints to populate a settlement. It owns no rendering of its own;
// it creates standard entities the existing render-sync + physics paths drive.

import * as THREE from "../../build/three.bundle.mjs";
import { z } from "../../build/zod.bundle.mjs";
import { MAX_ENTITIES, despawnRenderable, spawnRenderable } from "../ecs/world.ts";
import type { SkillDefinition, SkillRegistry, WorldContext } from "./registry.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
type V3 = [number, number, number];

/** Create one static, collidable box entity (axis-aligned, non-uniform) at `pos` with full size
 *  `size`. Mirrors scene.createEntity's static-box path but specialized for the generator (no
 *  material palette — a flat tinted standard material). Returns the entity id. */
function spawnStaticBox(world: WorldContext, pos: V3, size: V3, color: number): string {
  const [x, y, z] = pos;
  const [w, h, d] = size;
  const geometry = new THREE.BoxGeometry(w, h, d);
  const material = new THREE.MeshStandardNodeMaterial({ color, roughness: 0.85, metalness: 0.05 });
  const mesh = new THREE.Mesh(geometry, material);
  world.scene.add(mesh);
  const eid = spawnRenderable(world.ecs, mesh, x, y, z);
  if (eid >= MAX_ENTITIES) {
    despawnRenderable(world.ecs, eid);
    world.scene.remove(mesh);
    throw new Error("architecture: entity capacity exceeded (MAX_ENTITIES)");
  }
  const bodyId = world.ops.op_physics_add_static_box(x, y, z, w / 2, h / 2, d / 2, 0.85, 0);
  return world.entities.create({ eid, mesh, bodyId });
}

interface Part { kind: string; entity: string; position: V3; size: V3; }

const buildingInput = z.object({
  position: Vec3.default([0, 0, 0]).describe("Building CENTER on the ground (the floor sits at position.y)."),
  width: z.number().positive().max(200).default(8).describe("Footprint extent along X (meters)."),
  depth: z.number().positive().max(200).default(6).describe("Footprint extent along Z (meters)."),
  height: z.number().positive().max(80).default(3.2).describe("Wall height (meters)."),
  wallThickness: z.number().positive().max(5).default(0.25).describe("Wall/floor/roof slab thickness."),
  doorWidth: z.number().positive().max(50).default(1.4).describe("Doorway opening width (centered on the -Z wall)."),
  doorHeight: z.number().positive().max(70).default(2.2).describe("Doorway opening height (lintel sits above it)."),
  withRoof: z.boolean().default(true).describe("Cap the structure with a roof slab."),
  color: z.number().int().min(0).max(0xffffff).default(0x9a8c7a).describe("Wall/floor/roof albedo (flat)."),
  meta: z.record(z.string(), z.unknown()).optional(),
});

type BuildingResult = {
  entities: string[];
  parts: Part[];
  bounds: { min: V3; max: V3 };
  entityCount: number;
};

function makeBuilding(): SkillDefinition<z.infer<typeof buildingInput>, BuildingResult> {
  return {
    name: "architecture.building",
    version: "1.0.0",
    description: "Procedurally generate an enterable rectangular building (floor, 4 walls, a centered doorway with lintel, optional roof) as real collidable box entities. Deterministic + replay-safe. Compose it repeatedly to build settlements.",
    category: "scene",
    permissions: ["scene.write"],
    input: buildingInput,
    output: z.object({
      entities: z.array(z.string()),
      parts: z.array(z.object({ kind: z.string(), entity: z.string(), position: Vec3, size: Vec3 })),
      bounds: z.object({ min: Vec3, max: Vec3 }),
      entityCount: z.number(),
    }),
    handler: (input, ctx) => {
      const [cx, cy, cz] = input.position;
      const W = input.width, D = input.depth, H = input.height, t = input.wallThickness;
      const dw = Math.min(input.doorWidth, W - 2 * t); // door can't be wider than the wall span
      const dh = Math.min(input.doorHeight, H - t);     // leave room for a lintel
      const col = input.color;
      const parts: Part[] = [];
      const add = (kind: string, position: V3, size: V3): void => {
        parts.push({ kind, entity: spawnStaticBox(ctx.world, position, size, col), position, size });
      };

      // Floor slab (top surface at cy).
      add("floor", [cx, cy - t / 2, cz], [W, t, D]);
      // Long walls run the full width along X at +Z and -Z faces; -Z wall carries the doorway.
      const wallYc = cy + H / 2;
      const zPos = cz + D / 2 - t / 2; // +Z wall center
      const zNeg = cz - D / 2 + t / 2; // -Z wall center (door wall)
      add("wall_north", [cx, wallYc, zPos], [W, H, t]);
      // Side walls run the full depth along Z at +X and -X faces (inset so corners don't overlap).
      const sideD = D - 2 * t;
      add("wall_east", [cx + W / 2 - t / 2, wallYc, cz], [t, H, sideD]);
      add("wall_west", [cx - W / 2 + t / 2, wallYc, cz], [t, H, sideD]);
      // -Z wall with a centered doorway: left jamb, right jamb, and a lintel above the opening.
      const jambW = (W - dw) / 2;
      if (jambW > 1e-3) {
        add("wall_south_left", [cx - (dw / 2 + jambW / 2), wallYc, zNeg], [jambW, H, t]);
        add("wall_south_right", [cx + (dw / 2 + jambW / 2), wallYc, zNeg], [jambW, H, t]);
      }
      const lintelH = H - dh;
      if (lintelH > 1e-3) {
        add("lintel", [cx, cy + dh + lintelH / 2, zNeg], [dw, lintelH, t]);
      }
      if (input.withRoof) add("roof", [cx, cy + H + t / 2, cz], [W, t, D]);

      const entities = parts.map((p) => p.entity);
      const bounds = {
        min: [cx - W / 2, cy - t, cz - D / 2] as V3,
        max: [cx + W / 2, cy + H + (input.withRoof ? t : 0), cz + D / 2] as V3,
      };
      ctx.emit("architecture.built", {
        kind: "building", center: input.position, width: W, depth: D, height: H,
        entityCount: entities.length, hasDoor: jambW > 1e-3, hasRoof: input.withRoof, ...input.meta,
      });
      return { entities, parts, bounds, entityCount: entities.length };
    },
  };
}

export function registerArchitectureSkills(registry: SkillRegistry): void {
  registry.register(makeBuilding());
}
