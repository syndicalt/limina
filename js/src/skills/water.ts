// world.addWater — add a RENDER-ONLY sea-level water surface to the scene.
//
// This is the cosmetic counterpart to the terrain seam: terrain.* adds real
// heightfield COLLIDERS (sim state), whereas water is PURELY VISUAL. The skill
// records its REQUEST (the sea `level`, plus size/color, and an OPTIONAL `region`
// descriptor) as a single skill command in the world log; on replay, re-invoking it
// rebuilds the SAME cosmetic surface from that logged request — never from instance
// bytes. Because it touches neither the physics world nor the ECS/entity table, a world
// with water captures/compares IDENTICALLY to one without (the mesh is recomputed, like
// prop scatter), so it can never perturb determinism or replay parity.
//
// The optional `region` (seed + tile bounds + terrain type — all pure, log-safe values)
// turns on TRUE water-column-depth shading: the skill samples the deterministic terrain
// source the region was generated with to bake a depth field for the water material
// (clear shallows → opaque deep by actual depth, clean shoreline). This is a RENDER-graph
// read only — the baked field feeds colour/opacity, never sim state — so the render-only /
// replay-parity contract is unchanged. The depth field is DETERMINISTICALLY re-derived on
// replay from the same (seed, type, bounds) via the bound source, but it is NOT claimed to
// be byte-identical across authoring and replay: authoring samples the analytic source at
// the bake resolution (default 256²) while a replay's CachedTerrainSource bilinearly reads
// the 33²-per-tile cached heights, so the two depth fields differ at the sub-tile scale
// (~0.24 m). That is fine because the depth field is RENDER-ONLY and is never captured into
// the world state or compared by the determinism gate — only the cosmetic shading shifts
// imperceptibly; sim/ECS/log replay parity is untouched (proven in p11_water).
//
// Permission: scene.write (it mutates the render scene). Typed (Zod), permissioned,
// traced (emits `world.water.added` with the level so the request is on the trace).

import { z } from "../../build/zod.bundle.mjs";
import { buildWaterSurface, DEFAULT_WATER_COLOR, DEFAULT_WATER_SIZE, type WaterDepthOptions } from "../water.ts";
import { TILE_SIZE } from "../terrain/procedural.ts";
import { isTerrainType, terrainTypeHints } from "../terrain/terrain-types.ts";
import type { TerrainSource } from "../terrain/types.ts";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

/** One water surface currently in the scene (for inspection / idempotent rebuild on
 *  replay). Held in the registry closure, so a fresh replay registry starts empty and
 *  rebuilds it by re-invoking the recorded `world.addWater` command. */
export interface WaterSurfaceState {
  level: number;
  size: number;
  color: number;
  /** The cosmetic mesh added to the scene (never an ECS entity / physics body). */
  mesh: unknown;
}

/** Optional region descriptor enabling TRUE water-column-depth shading. All pure,
 *  log-safe values: on replay the bound terrain source DETERMINISTICALLY re-derives the
 *  depth field from (seed, type, bounds). It is RENDER-ONLY and sub-tile-resolution, so it
 *  is NOT byte-identical to the authoring bake (and is never captured/compared by the sim
 *  determinism gate). `resolution` is the baked grid size (default 256). */
const waterRegionInput = z.object({
  seed: z.number().int(),
  type: z.string(),
  bounds: z.object({
    minTx: z.number().int(),
    minTz: z.number().int(),
    maxTx: z.number().int(),
    maxTz: z.number().int(),
  }),
  resolution: z.number().int().positive().max(1024).optional(),
});

const addWaterInput = z.object({
  level: z.number().default(0),
  size: z.number().positive().max(100000).default(DEFAULT_WATER_SIZE),
  color: z.number().int().min(0).max(0xffffff).default(DEFAULT_WATER_COLOR),
  region: waterRegionInput.optional(),
});
const addWaterOutput = z.object({
  level: z.number(),
  size: z.number(),
  color: z.number().int(),
});

/** Register the `world.addWater` skill bound to a closure list of placed surfaces
 *  (returned for host/test inspection — the SAME shape terrain skills return). The
 *  `terrainSource` (the SAME deterministic source the terrain.* skills are bound to) is
 *  read — never mutated — to bake the depth field when a `region` is supplied. */
export function registerWaterSkills(
  registry: SkillRegistry,
  terrainSource?: TerrainSource,
): { surfaces: WaterSurfaceState[] } {
  const surfaces: WaterSurfaceState[] = [];

  const addWater: SkillDefinition<z.infer<typeof addWaterInput>, z.infer<typeof addWaterOutput>> = {
    name: "world.addWater",
    version: "1.0.0",
    description:
      "Add a RENDER-ONLY water surface (a large plane) at a sea-level Y so beaches/lakes/oceans read as water. Cosmetic only: no physics body, no collider, no ECS entity — it never affects the deterministic sim or replay. The world log records the REQUEST (level/size/color, and an optional region for true depth-aware shading); replay rebuilds the same surface from the logged request.",
    category: "world",
    permissions: ["scene.write"],
    input: addWaterInput,
    output: addWaterOutput,
    handler: (input, ctx) => {
      // TRUE water-column-depth shading when a region + a bound terrain source are present:
      // bake the depth field from the SAME source/seed/type/bounds the terrain was built
      // with. Read-only — it only feeds the render graph (colour/opacity), never sim state.
      let depth: WaterDepthOptions | undefined;
      const region = input.region;
      if (region !== undefined && terrainSource !== undefined && isTerrainType(region.type)) {
        const hints = terrainTypeHints(region.type, region.bounds);
        const b = region.bounds;
        depth = {
          sampleHeight: (x, z) => terrainSource.sampleHeight(region.seed, x, z, 0, hints),
          bounds: {
            minX: b.minTx * TILE_SIZE,
            minZ: b.minTz * TILE_SIZE,
            maxX: (b.maxTx + 1) * TILE_SIZE,
            maxZ: (b.maxTz + 1) * TILE_SIZE,
          },
          resolution: region.resolution,
        };
      }
      const mesh = buildWaterSurface({ level: input.level, size: input.size, color: input.color, depth });
      // Render-only: add to the scene graph ONLY. No spawnRenderable (ECS), no
      // ctx.world.entities.create, no op_physics_* — so sim state is untouched.
      ctx.world.scene.add(mesh);
      const surface: WaterSurfaceState = { level: input.level, size: input.size, color: input.color, mesh };
      surfaces.push(surface);
      ctx.emit("world.water.added", { level: input.level, size: input.size, color: input.color });
      return { level: input.level, size: input.size, color: input.color };
    },
  };

  registry.register(addWater);
  return { surfaces };
}
