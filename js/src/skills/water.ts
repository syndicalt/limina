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
import { buildRiverRibbon, buildWaterSurface, DEFAULT_WATER_COLOR, DEFAULT_WATER_SIZE, type WaterDepthOptions } from "../water.ts";
import { TILE_SIZE } from "../terrain/procedural.ts";
import { isTerrainType, terrainTypeHints } from "../terrain/terrain-types.ts";
import type { TerrainSource } from "../terrain/types.ts";
import type { RegionState } from "./terrain.ts";
import type { EditableTerrain } from "./terrain-edit.ts";
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
  /** Sea-level world Y the surface sits at. OMIT to auto-derive it from the target editable
   *  terrain layer's `elevationColors.seaLevel` (the waterline terrain.create computed) so the
   *  shoreline lines up with no drift; an explicit value overrides. Defaults to 0 only when
   *  there is no generated terrain to read. */
  level: z.number().optional(),
  size: z.number().positive().max(100000).default(DEFAULT_WATER_SIZE),
  color: z.number().int().min(0).max(0xffffff).default(DEFAULT_WATER_COLOR),
  region: waterRegionInput.optional(),
  /** Editable terrain layer (terrain.create) to couple to for the auto-derived level + the
   *  depth-fade. Defaults to the most recently created layer (like terrain.deform/village.build). */
  terrainEntity: z.string().optional(),
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

/** Derive a TRUE water-column-depth descriptor from an EDITABLE terrain layer (terrain.create).
 *  OUR settlement scene sculpts its ground with terrain.create — an editable heightfield held in
 *  `layer.tile`, NOT the region table — so deriveDepthFromRegions can't see it and the depth-fade
 *  would fall back to the camera-distance proxy. This builds `sampleHeight(x,z)` from the tile's
 *  heightfield with the SAME bilinear sampler village.build/grass read (world<->grid mapping from
 *  terrain/mesh.ts: x0 = ox - sizeX/2, y = origin.y + heights[r*ncols+c]), over the tile's world-XZ
 *  rectangle, so the shoreline depth-fade (turquoise shallows → opaque deep) tracks the eroded
 *  terrain. RENDER-ONLY: it only feeds colour/opacity, never sim state; deterministic and
 *  re-derived on replay from the re-created layer. EXPORTED for the depth UAT. */
export function deriveDepthFromLayer(layer: EditableTerrain): WaterDepthOptions {
  const tile = layer.tile;
  const n = tile.ncols, nr = tile.nrows;
  const [ox, oy, oz] = tile.origin;
  const sizeX = tile.scale[0], sizeZ = tile.scale[2];
  const x0 = ox - sizeX / 2, z0 = oz - sizeZ / 2;
  const dxStep = sizeX / (n - 1), dzStep = sizeZ / (nr - 1);
  const heights = tile.heights;
  const sampleHeight = (x: number, z: number): number => {
    const fc = Math.min(n - 1, Math.max(0, (x - x0) / dxStep));
    const fr = Math.min(nr - 1, Math.max(0, (z - z0) / dzStep));
    const c0 = Math.floor(fc), r0 = Math.floor(fr);
    const c1 = Math.min(n - 1, c0 + 1), r1 = Math.min(nr - 1, r0 + 1);
    const tx = fc - c0, tz = fr - r0;
    const h = (r: number, c: number): number => oy + heights[r * n + c];
    const a = h(r0, c0) + (h(r0, c1) - h(r0, c0)) * tx;
    const b = h(r1, c0) + (h(r1, c1) - h(r1, c0)) * tx;
    return a + (b - a) * tz;
  };
  return { sampleHeight, bounds: { minX: x0, minZ: z0, maxX: x0 + sizeX, maxZ: z0 + sizeZ } };
}

/** Pick the target editable terrain layer: the explicit `id`, else the most recently created
 *  (the SAME resolution terrain.deform / village.build use). Undefined when no layer exists. */
function pickLayer(layers: Map<string, EditableTerrain> | undefined, id?: string): EditableTerrain | undefined {
  if (layers === undefined) return undefined;
  if (id !== undefined) return layers.get(id);
  let last: EditableTerrain | undefined;
  for (const v of layers.values()) last = v;
  return last;
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
  /** The live editable-terrain layer map (terrain.create). When the scene has NO generated
   *  region (our settlement uses the editable layer, not the region table), the water auto-derives
   *  its LEVEL from the layer's `elevationColors.seaLevel` and bakes its depth-fade from the layer's
   *  heightfield. Read-only — never mutated. */
  terrainLayers?: Map<string, EditableTerrain>,
): { surfaces: WaterSurfaceState[]; rivers: unknown[] } {
  const surfaces: WaterSurfaceState[] = [];
  /** River ribbon meshes currently in the scene (render-only, like `surfaces`). */
  const rivers: unknown[] = [];

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
      // The editable terrain layer this water couples to (explicit, else most-recent). Source of
      // BOTH the auto-derived sea level AND the editable-layer depth-fade for OUR settlement scene.
      const layer = pickLayer(terrainLayers, input.terrainEntity);
      // Sea level: an explicit `level` wins; else the layer's computed waterline (so the shoreline
      // lines up with zero drift — the SAME value terrain.create derived from seaCoverage); else 0.
      const level = input.level ?? layer?.elevationColors?.seaLevel ?? 0;

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
      } else if (region === undefined) {
        // DEFAULT true-depth path: no explicit region descriptor. Prefer generated regions (their
        // seed/lod/hints); ELSE — our settlement case — derive the depth field from the EDITABLE
        // terrain layer's heightfield, so the water grades by ACTUAL water-column depth and the
        // shoreline tracks the real eroded coast. Only when there is neither does this stay
        // undefined → the camera-distance proxy fallback.
        if (terrainSource !== undefined && terrainRegions !== undefined) {
          depth = deriveDepthFromRegions(terrainSource, terrainRegions);
        }
        if (depth === undefined && layer !== undefined) {
          depth = deriveDepthFromLayer(layer);
        }
      }
      const mesh = buildWaterSurface({ level, size: input.size, color: input.color, depth, peek: ctx.world.peek === true });
      // Render-only: add to the scene graph ONLY. No spawnRenderable (ECS), no
      // ctx.world.entities.create, no op_physics_* — so sim state is untouched.
      ctx.world.scene.add(mesh);
      const surface: WaterSurfaceState = { level, size: input.size, color: input.color, mesh };
      surfaces.push(surface);
      ctx.emit("world.water.added", { level, size: input.size, color: input.color });
      return { level, size: input.size, color: input.color };
    },
  };

  // world.addRiver — the water system's TERRAIN-FOLLOWING counterpart to the flat sea plane:
  // a render-only ribbon draped along a carved channel (a map's waterway), descending with
  // the ground. Same contract as addWater: cosmetic, no sim state, recomputed on replay.
  const addRiverInput = z.object({
    /** Channel centerline in world meters (>= 2 points). Typically a WorldMap waterway. */
    points: z.array(z.tuple([z.number(), z.number()])).min(2),
    /** Water surface width (meters) — match the map waterway's widthM. */
    widthM: z.number().positive().default(6),
    /** Tint (sRGB hex). Default: the sea surface color. */
    color: z.number().int().optional(),
    /** Sea plane Y (the ribbon meets it flush at the mouth). Default: the layer's waterline. */
    level: z.number().optional(),
    /** Terrain layer to drape on (explicit, else most-recent). */
    terrainEntity: z.string().optional(),
  });
  const addRiverOutput = z.object({ points: z.number().int(), widthM: z.number(), level: z.number() });
  const addRiver: SkillDefinition<z.infer<typeof addRiverInput>, z.infer<typeof addRiverOutput>> = {
    name: "world.addRiver",
    version: "1.0.0",
    description:
      "Add a RENDER-ONLY river: a water ribbon draped along a carved channel polyline, following the terrain (a flat sea plane cannot render a river crossing elevated ground). Cosmetic only — no physics body, no ECS entity, replay rebuilds it from the logged request.",
    category: "world",
    permissions: ["scene.write"],
    input: addRiverInput,
    output: addRiverOutput,
    handler: (input, ctx) => {
      const layer = pickLayer(terrainLayers, input.terrainEntity);
      const level = input.level ?? layer?.elevationColors?.seaLevel ?? 0;
      // Bilinear surface sample over the layer's heightfield (the CARVED channel floor along
      // the centerline). With no terrain layer the ribbon lies flat just above `level`.
      const sampleHeight = layer === undefined ? () => level - 1.2 : (x: number, z: number): number => {
        const t = layer.tile;
        const fc = ((x - (t.origin[0] - t.scale[0] / 2)) / t.scale[0]) * (t.ncols - 1);
        const fr = ((z - (t.origin[2] - t.scale[2] / 2)) / t.scale[2]) * (t.nrows - 1);
        const c0 = Math.max(0, Math.min(t.ncols - 2, Math.floor(fc)));
        const r0 = Math.max(0, Math.min(t.nrows - 2, Math.floor(fr)));
        const tc = Math.max(0, Math.min(1, fc - c0));
        const tr = Math.max(0, Math.min(1, fr - r0));
        const h00 = t.heights[r0 * t.ncols + c0], h01 = t.heights[r0 * t.ncols + c0 + 1];
        const h10 = t.heights[(r0 + 1) * t.ncols + c0], h11 = t.heights[(r0 + 1) * t.ncols + c0 + 1];
        return t.origin[1] + (h00 * (1 - tc) + h01 * tc) * (1 - tr) + (h10 * (1 - tc) + h11 * tc) * tr;
      };
      const mesh = buildRiverRibbon({ points: input.points as [number, number][], widthM: input.widthM, color: input.color, sampleHeight, seaLevel: level });
      // Render-only: scene graph ONLY (no ECS entity, no physics body) — same as addWater.
      ctx.world.scene.add(mesh);
      rivers.push(mesh);
      ctx.emit("world.river.added", { points: input.points.length, widthM: input.widthM, level });
      return { points: input.points.length, widthM: input.widthM, level };
    },
  };

  registry.register(addWater);
  registry.register(addRiver);
  return { surfaces, rivers };
}
