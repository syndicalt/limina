// building.assemble — the registered SKILL that raises a kit-composed building from a declarative
// recipe. Making it a skill is what turns a building into a FIRST-CLASS, recorded, replayable unit:
//   • the call is written to the world log, so replay rebuilds the building deterministically;
//   • the building-root carries this skill's (tool, input) as its self-sufficient origin, so a
//     bounded-tail viewer or a prefab STAMP rebuilds the whole structure by re-invoking it at a new
//     position — no per-part origins, no second scene graph (see building-recipe.ts).
//
// The assembler (assembleBuilding) owns all geometry/transform/parenting; this is the thin, validated
// skill seam over it. Deterministic + replay-safe (assembleBuilding is pure given the recipe + DD).

import { z } from "../../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "../registry.ts";
import { type BuildingRecipe, assembleBuilding } from "../building-recipe.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

const OpeningSchema = z.object({
  wall: z.enum(["north", "south", "east", "west"]),
  kind: z.enum(["door", "window"]),
  offset: z.number().optional().describe("Centre along the wall axis (0 = wall centre)."),
  width: z.number().positive(),
  height: z.number().positive(),
  sill: z.number().min(0).optional().describe("Height of the solid panel below the opening (0 for a door)."),
}).strict();

const RoofSchema = z.object({
  type: z.enum(["gable", "flat"]),
  pitch: z.number().positive().optional(),
  overhang: z.number().min(0).optional(),
}).strict();

const assembleInput = z.object({
  position: Vec3.default([0, 0, 0]).describe("Building CENTER on the ground (the floor sits at position.y)."),
  width: z.number().positive().max(200).default(8).describe("Footprint extent along X (meters)."),
  depth: z.number().positive().max(200).default(6).describe("Footprint extent along Z (meters)."),
  height: z.number().positive().max(80).default(3.2).describe("Wall height (meters)."),
  wallThickness: z.number().positive().max(5).optional().describe("Wall/floor slab thickness (default 0.25)."),
  openings: z.array(OpeningSchema).optional().describe("Doors + windows cut into the walls (genuine voids)."),
  roof: z.union([RoofSchema, z.null()]).optional().describe("Roof spec; null = open. Omitted = a gable roof."),
  rotation: z.number().optional().describe("Yaw in radians about the building centre."),
  plinth: z.boolean().optional().describe("A foundation course under the footprint (default on)."),
  seed: z.number().optional().describe("Deterministic variation seed for the kit parts."),
});

const assembleOutput = z.object({
  root: z.string().describe("The building-root entity — the whole structure as one selectable/exportable unit."),
  entities: z.array(z.string()).describe("Every part entity (parented under root)."),
  entityCount: z.number(),
  bounds: z.object({ min: Vec3, max: Vec3 }),
});

function makeAssemble(): SkillDefinition<z.infer<typeof assembleInput>, z.infer<typeof assembleOutput>> {
  return {
    name: "building.assemble",
    version: "1.0.0",
    description: "Raise a kit-composed building (relief timber-frame walls, sills/lintels, plinth, gable roof) from a declarative recipe as real collidable entities parented under one building-root. Deterministic + replay-safe; on-brief materials from the active Design Direction. Openings are genuine voids. Re-invoke to STAMP the same building elsewhere.",
    category: "scene",
    permissions: ["scene.write"],
    input: assembleInput,
    output: assembleOutput,
    handler: (input, ctx) => {
      const { position, seed, ...recipe } = input;
      const res = assembleBuilding(recipe as BuildingRecipe, position, ctx.world, seed !== undefined ? { seed } : undefined);
      ctx.emit("building.assembled", { root: res.root, center: position, parts: res.entityCount, width: recipe.width, depth: recipe.depth, height: recipe.height });
      return { root: res.root, entities: res.parts.map((p) => p.entity), entityCount: res.entityCount, bounds: res.bounds };
    },
  };
}

// ── architecture.building — the long-standing building primitive, now KIT-BACKED ─────────────────
// Kept as a named skill (agents, demos, and combat scenes call it by name) but its box-emitting body
// is retired: it now maps its inputs to a recipe and delegates to the SAME assembleBuilding the kit
// uses, so a played/agent-built world gets the relief timber-frame + slate/plaster look. Registered
// here (not architecture.ts) so architecture.ts never imports building-recipe.ts (no import cycle).
const archInput = z.object({
  position: Vec3.default([0, 0, 0]).describe("Building CENTER on the ground (floor at position.y)."),
  width: z.number().positive().max(200).default(8),
  depth: z.number().positive().max(200).default(6),
  height: z.number().positive().max(80).default(3.2),
  rotation: z.number().default(0),
  wallThickness: z.number().positive().max(5).default(0.25),
  doorWidth: z.number().positive().max(50).default(1.4),
  doorHeight: z.number().positive().max(70).default(2.2),
  withRoof: z.boolean().default(true),
  roofStyle: z.enum(["gable", "flat"]).default("gable"),
  roofPitch: z.number().positive().max(40).default(2.4),
  roofOverhang: z.number().min(0).max(5).default(0.5),
  seed: z.number().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
const archOutput = z.object({
  entities: z.array(z.string()),
  parts: z.array(z.object({ kind: z.string(), entity: z.string(), position: Vec3, size: Vec3 })),
  bounds: z.object({ min: Vec3, max: Vec3 }),
  entityCount: z.number(),
  root: z.string(),
});

function makeArchitectureBuilding(): SkillDefinition<z.infer<typeof archInput>, z.infer<typeof archOutput>> {
  return {
    name: "architecture.building",
    version: "2.0.0",
    description: "Procedurally raise an enterable building (relief timber-frame walls, plaster infill, plinth, slate gable roof, a doorway with a stoop) as real collidable entities parented under one building-root. Kit-backed + Design-Direction-materialed; deterministic + replay-safe. Compose repeatedly to build settlements.",
    category: "scene",
    permissions: ["scene.write"],
    input: archInput,
    output: archOutput,
    handler: (input, ctx) => {
      const t = input.wallThickness;
      const recipe: BuildingRecipe = {
        width: input.width, depth: input.depth, height: input.height, wallThickness: t, rotation: input.rotation,
        openings: [{ wall: "south", kind: "door", width: Math.min(input.doorWidth, input.width - 2 * t), height: Math.min(input.doorHeight, input.height - t), sill: 0 }],
        roof: input.withRoof ? { type: input.roofStyle, pitch: input.roofPitch, overhang: input.roofOverhang } : null,
      };
      const res = assembleBuilding(recipe, input.position, ctx.world, input.seed !== undefined ? { seed: input.seed } : undefined);
      ctx.emit("architecture.built", {
        kind: "building", center: input.position, width: input.width, depth: input.depth, height: input.height,
        rotation: input.rotation, roofStyle: input.withRoof ? input.roofStyle : "none",
        entityCount: res.entityCount, hasDoor: true, hasRoof: input.withRoof, ...input.meta,
      });
      return { entities: res.parts.map((p) => p.entity), parts: res.parts, bounds: res.bounds, entityCount: res.entityCount, root: res.root };
    },
  };
}

export function registerBuildingSkills(registry: SkillRegistry): void {
  registry.register(makeAssemble() as unknown as Parameters<SkillRegistry["register"]>[0]);
  registry.register(makeArchitectureBuilding() as unknown as Parameters<SkillRegistry["register"]>[0]);
}
