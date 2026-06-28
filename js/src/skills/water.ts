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
import type { RegionState } from "./terrain.ts";
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
  /** The SAME shaping-hint OVERRIDES the region was generated with (amp/erode/island/…).
   *  Merged over the type defaults so the depth field is baked against the ACTUAL surface
   *  the terrain was built with — without it a region generated with overrides (e.g. an
   *  island falloff + erosion) bakes its depth against a flat type-default surface, and the
   *  shoreline depth-fade reads wrong (a pale shelf where the real coast tapers). */
  hints: z.record(z.string(), z.number()).optional(),
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

/** Derive a TRUE water-column-depth descriptor from the terrain regions ALREADY generated
 *  in this world (the live region table the terrain.* skills populate) — used when the
 *  caller did NOT pass an explicit `region`. This makes terrain-aware true depth the DEFAULT
 *  whenever the scene has terrain, instead of the camera-distance proxy: the water reads its
 *  floor from the SAME deterministic source/seed/lod/hints the heightfield colliders were
 *  built with. RENDER-ONLY: it only feeds the render graph (colour/opacity); it is read at
 *  invoke time and deterministically re-derived on replay (generateRegion is re-invoked
 *  before addWater), and is never captured into world state. Returns undefined when there is
 *  no generated terrain to read (e.g. a bare lake) — then the proxy fallback stands in.
 *  EXPORTED for the depth UAT (js/test/p11_water_depth.ts). */
export function deriveDepthFromRegions(
  source: TerrainSource,
  regions: Map<string, RegionState>,
): WaterDepthOptions | undefined {
  // Each generated region → its world-XZ rectangle (from the applied tiles) + the exact
  // seed/lod/hints it was generated with, so a height query reproduces the eroded surface.
  const regs: {
    minX: number; minZ: number; maxX: number; maxZ: number; cx: number; cz: number;
    seed: number; lod: number; hints?: Record<string, number>;
  }[] = [];
  for (const r of regions.values()) {
    let minTx = Infinity, minTz = Infinity, maxTx = -Infinity, maxTz = -Infinity;
    for (const t of r.tiles.values()) {
      if (t.tx < minTx) minTx = t.tx;
      if (t.tx > maxTx) maxTx = t.tx;
      if (t.tz < minTz) minTz = t.tz;
      if (t.tz > maxTz) maxTz = t.tz;
    }
    if (!Number.isFinite(minTx)) continue; // region with no applied tiles → skip
    const minX = minTx * TILE_SIZE, minZ = minTz * TILE_SIZE;
    const maxX = (maxTx + 1) * TILE_SIZE, maxZ = (maxTz + 1) * TILE_SIZE;
    regs.push({ minX, minZ, maxX, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, seed: r.seed, lod: r.lod, hints: r.hints });
  }
  if (regs.length === 0) return undefined;

  // Union bounds over all regions (the water samples true depth inside it, deep sea outside).
  let uMinX = Infinity, uMinZ = Infinity, uMaxX = -Infinity, uMaxZ = -Infinity;
  for (const g of regs) {
    if (g.minX < uMinX) uMinX = g.minX;
    if (g.minZ < uMinZ) uMinZ = g.minZ;
    if (g.maxX > uMaxX) uMaxX = g.maxX;
    if (g.maxZ > uMaxZ) uMaxZ = g.maxZ;
  }

  const sampleHeight = (x: number, z: number): number => {
    // The region containing (x,z); if none (a gap between disjoint regions), the nearest by
    // centre. Sample it clamped to its own bounds so every read is a real terrain height
    // (an out-of-region point reads the coast's edge height — it then dissolves to deep sea
    // via the shader's boundary feather).
    let pick = regs[0];
    let inside = false;
    for (const g of regs) {
      if (x >= g.minX && x <= g.maxX && z >= g.minZ && z <= g.maxZ) { pick = g; inside = true; break; }
    }
    if (!inside && regs.length > 1) {
      let best = Infinity;
      for (const g of regs) {
        const dx = x - g.cx, dz = z - g.cz;
        const d = dx * dx + dz * dz;
        if (d < best) { best = d; pick = g; }
      }
    }
    const sx = Math.min(pick.maxX, Math.max(pick.minX, x));
    const sz = Math.min(pick.maxZ, Math.max(pick.minZ, z));
    return source.sampleHeight(pick.seed, sx, sz, pick.lod, pick.hints);
  };

  return { sampleHeight, bounds: { minX: uMinX, minZ: uMinZ, maxX: uMaxX, maxZ: uMaxZ } };
}

/** Register the `world.addWater` skill bound to a closure list of placed surfaces
 *  (returned for host/test inspection — the SAME shape terrain skills return). The
 *  `terrainSource` (the SAME deterministic source the terrain.* skills are bound to) is
 *  read — never mutated — to bake the depth field: from an explicit `region` when supplied,
 *  ELSE auto-derived from the `terrainRegions` already generated in this world (so true
 *  depth-aware water is the DEFAULT wherever terrain exists; the camera-distance proxy is
 *  used only when there is no heightfield at all, e.g. a bare lake). */
export function registerWaterSkills(
  registry: SkillRegistry,
  terrainSource?: TerrainSource,
  terrainRegions?: Map<string, RegionState>,
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
        // Type defaults + the region's actual overrides (mirrors world.generateRegion's
        // merge), so the depth bake samples the SAME shaped+eroded surface as the colliders.
        const hints = { ...terrainTypeHints(region.type, region.bounds), ...(region.hints ?? {}) };
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
      } else if (region === undefined && terrainSource !== undefined && terrainRegions !== undefined) {
        // DEFAULT true-depth path: no explicit region descriptor, but the world has generated
        // terrain — derive the depth field from those regions (their seed/lod/hints), so the
        // water grades by ACTUAL water-column depth and the shoreline tracks the real coast.
        // Only when there is no terrain at all does this stay undefined → proxy fallback.
        depth = deriveDepthFromRegions(terrainSource, terrainRegions);
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
