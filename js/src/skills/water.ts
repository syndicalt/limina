// world.addWater — add a RENDER-ONLY sea-level water surface to the scene.
//
// This is the cosmetic counterpart to the terrain seam: terrain.* adds real
// heightfield COLLIDERS (sim state), whereas water is PURELY VISUAL. The skill
// records its REQUEST (the sea `level`, plus size/color) as a single skill command
// in the world log; on replay, re-invoking it rebuilds the SAME cosmetic surface
// from that logged level — never from instance bytes. Because it touches neither
// the physics world nor the ECS/entity table, a world with water captures/compares
// IDENTICALLY to one without (the mesh is recomputed, like prop scatter), so it can
// never perturb determinism or replay parity.
//
// Permission: scene.write (it mutates the render scene). Typed (Zod), permissioned,
// traced (emits `world.water.added` with the level so the request is on the trace).

import { z } from "../../build/zod.bundle.mjs";
import { buildWaterSurface, DEFAULT_WATER_COLOR, DEFAULT_WATER_SIZE } from "../water.ts";
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

const addWaterInput = z.object({
  level: z.number().default(0),
  size: z.number().positive().max(100000).default(DEFAULT_WATER_SIZE),
  color: z.number().int().min(0).max(0xffffff).default(DEFAULT_WATER_COLOR),
});
const addWaterOutput = z.object({
  level: z.number(),
  size: z.number(),
  color: z.number().int(),
});

/** Register the `world.addWater` skill bound to a closure list of placed surfaces
 *  (returned for host/test inspection — the SAME shape terrain skills return). */
export function registerWaterSkills(registry: SkillRegistry): { surfaces: WaterSurfaceState[] } {
  const surfaces: WaterSurfaceState[] = [];

  const addWater: SkillDefinition<z.infer<typeof addWaterInput>, z.infer<typeof addWaterOutput>> = {
    name: "world.addWater",
    version: "1.0.0",
    description:
      "Add a RENDER-ONLY water surface (a large plane) at a sea-level Y so beaches/lakes/oceans read as water. Cosmetic only: no physics body, no collider, no ECS entity — it never affects the deterministic sim or replay. The world log records the REQUEST (level/size/color); replay rebuilds the same surface from the logged level.",
    category: "world",
    permissions: ["scene.write"],
    input: addWaterInput,
    output: addWaterOutput,
    handler: (input, ctx) => {
      const mesh = buildWaterSurface({ level: input.level, size: input.size, color: input.color });
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
