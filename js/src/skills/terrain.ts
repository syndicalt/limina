// Phase 9 — the terrain.* / world.* skill seam. Four Zod-typed, permissioned,
// traced skills closing over a pluggable TerrainSource (the procedural source
// offline/in tests; the learned model at authoring; the tile cache at replay)
// and a content-addressed TileCache.
//
// THE RECORD/REPLAY SPINE (same shape as Phase 8, one level up): world.
// generateRegion is a SKILL, so the world log records its REQUEST ({seed, bounds,
// lod, hints}) as a single SKILL command. The op_physics_add_heightfield calls it
// makes are NESTED (depth > 0) and are therefore NOT separately logged — replay
// RE-INVOKES generateRegion, which re-resolves the SAME deterministic tiles from
// the source/cache and re-applies the SAME heightfield colliders in the SAME
// order, allocating the SAME body ids. The log carries the request + a content
// hash; the tile BYTES ride the cache/export, never the log.
//
// OFF-LOOP NOTE: the heavy generate is meant to run off the frame loop (the
// action queue marshals the request to the generator worker and applies tiles
// between frames). For this headless cut the apply is SYNCHRONOUS, but the skill
// is shaped for the off-loop wrapper: it returns a region HANDLE (regionId) and
// emits `terrain.tile.ready` per applied tile, so an async marshaller can later
// stream the same events without changing the contract.

import { z } from "../../build/zod.bundle.mjs";
import { MAX_ENTITIES, despawnRenderable, spawnRenderable } from "../ecs/world.ts";
import type { Transformable } from "../ecs/world.ts";
import type { TerrainSource, TileRequest } from "../terrain/types.ts";
import { TILE_SIZE } from "../terrain/procedural.ts";
import { TERRAIN_TYPE_NAMES, terrainTypeHints, type TerrainTypeName } from "../terrain/terrain-types.ts";
import { requestKey, tileContentHash, TileCache } from "../terrain/tilecache.ts";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

/** Inert transform binding for a static terrain tile (the render mesh is attached
 *  by the host's render path — Workstream D / UAT; the ECS entity exists headless
 *  so the tile is a first-class, snapshot/replay-comparable entity). */
function inertTransform(): Transformable {
  return { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };
}

/** Per-region state: which tiles are currently applied (for streamFollow load/
 *  unload bookkeeping). Lives in the closure of one registry, so a fresh replay
 *  registry starts empty and rebuilds it by re-invoking the recorded skills. */
export interface AppliedTile {
  bodyId: number;
  entity: string;
  eid: number;
  tx: number;
  tz: number;
}
/** Live state of a generated region (the tiles actually applied). Exported so
 *  asset.scatter can bind a scatter to the SAME region world.generateRegion built —
 *  it reads the region's seed/lod + applied tile coords, never a free-floating seed. */
export interface RegionState {
  seed: number;
  lod: number;
  hints?: Record<string, number>;
  tiles: Map<string, AppliedTile>;
}

/** A stable region handle derived from the request (deterministic across runs). */
function regionIdOf(seed: number, lod: number, b: { minTx: number; minTz: number; maxTx: number; maxTz: number }): string {
  return `rgn_${seed | 0}_l${lod | 0}_${b.minTx}_${b.minTz}_${b.maxTx}_${b.maxTz}`;
}

/** Register the terrain.* / world.* skills bound to a source + cache. The default
 *  core wiring passes a ProceduralTerrainSource; a runtime can pass the cached
 *  source (replay) or the model-backed source (authoring) instead. */
export function registerTerrainSkills(
  registry: SkillRegistry,
  source: TerrainSource,
  cache: TileCache = new TileCache(),
  regions: Map<string, RegionState> = new Map(),
): { cache: TileCache; regions: Map<string, RegionState> } {

  /** Resolve + apply one tile: build the native heightfield collider, register a
   *  terrain entity, record it in the region, and emit terrain.tile.ready. */
  async function applyTile(
    region: RegionState,
    regionId: string,
    tx: number,
    tz: number,
    ctx: Parameters<SkillDefinition["handler"]>[1],
  ): Promise<{ key: string; bodyId: number; entity: string }> {
    const req: TileRequest = { seed: region.seed, tx, tz, lod: region.lod, hints: region.hints };
    const key = requestKey(req);
    const existing = region.tiles.get(key);
    if (existing !== undefined) return { key, bodyId: existing.bodyId, entity: existing.entity };
    const tile = await cache.resolve(req, source);
    const [ox, oy, oz] = tile.origin;
    const [sx, sy, sz] = tile.scale;
    const bodyId = ctx.world.ops.op_physics_add_heightfield(ox, oy, oz, tile.nrows, tile.ncols, sx, sy, sz, tile.heights);
    const eid = spawnRenderable(ctx.world.ecs, inertTransform(), ox, oy, oz);
    if (eid >= MAX_ENTITIES) {
      despawnRenderable(ctx.world.ecs, eid);
      ctx.world.ops.op_physics_remove_body(bodyId);
      throw new Error("terrain: entity capacity exceeded (MAX_ENTITIES)");
    }
    const entity = ctx.world.entities.create({ eid, bodyId });
    region.tiles.set(key, { bodyId, entity, eid, tx, tz });
    ctx.emit("terrain.tile.ready", {
      regionId, tx, tz, key, hash: tileContentHash(tile), bodyId, entity,
      origin: tile.origin, source: source.name,
    });
    return { key, bodyId, entity };
  }

  // ---- world.generateRegion ------------------------------------------------
  const boundsSchema = z.object({
    minTx: z.number().int(),
    minTz: z.number().int(),
    maxTx: z.number().int(),
    maxTz: z.number().int(),
  }).refine((b) => b.maxTx >= b.minTx && b.maxTz >= b.minTz, "bounds max must be >= min")
    .refine((b) => (b.maxTx - b.minTx + 1) * (b.maxTz - b.minTz + 1) <= 256, "region too large (>256 tiles)");
  const generateRegionInput = z.object({
    seed: z.number().int(),
    bounds: boundsSchema,
    lod: z.number().int().min(0).max(4).default(0),
    // AGENT-NATIVE SEEDING: pick a named terrain TYPE ("beach", "mountains", "desert", …)
    // and it resolves to the full shaping+climate config for the region (the deterministic
    // generator builds that world). Mutually composable with raw `hints` (explicit hints
    // override the type's resolved knobs); omit both for the byte-identical default field.
    type: z.enum(TERRAIN_TYPE_NAMES as [string, ...string[]]).optional(),
    hints: z.record(z.string(), z.number()).optional(),
  });
  const generateRegionOutput = z.object({
    regionId: z.string(),
    tiles: z.number().int(),
    bodies: z.array(z.number().int()),
    keys: z.array(z.string()),
  });
  const generateRegion: SkillDefinition<z.infer<typeof generateRegionInput>, z.infer<typeof generateRegionOutput>> = {
    name: "world.generateRegion",
    version: "1.0.0",
    description: "Generate + apply a rectangular region of terrain tiles (heightfield colliders) from a deterministic source. High-cost; streams tiles, emitting terrain.tile.ready per tile. Returns a region handle. The world log records this REQUEST; the tile bytes ride the cache/export.",
    category: "world",
    permissions: ["terrain.generate"],
    input: generateRegionInput,
    output: generateRegionOutput,
    handler: async (input, ctx) => {
      // Resolve a named terrain TYPE into the full shaping+climate hint map, then let any
      // explicit `hints` override individual knobs. Pure + deterministic, so replay (which
      // re-invokes this skill with the recorded request) re-derives the identical hints.
      const typed = input.type !== undefined ? terrainTypeHints(input.type as TerrainTypeName, input.bounds) : undefined;
      const merged = (typed !== undefined || input.hints !== undefined)
        ? { ...(typed ?? {}), ...(input.hints ?? {}) }
        : undefined;
      const regionId = regionIdOf(input.seed, input.lod, input.bounds);
      let region = regions.get(regionId);
      if (region === undefined) {
        region = { seed: input.seed, lod: input.lod, hints: merged, tiles: new Map() };
        regions.set(regionId, region);
      }
      const bodies: number[] = [];
      const keys: string[] = [];
      // Deterministic apply order (tz outer, tx inner) so body-id allocation is
      // reproducible on replay.
      for (let tz = input.bounds.minTz; tz <= input.bounds.maxTz; tz++) {
        for (let tx = input.bounds.minTx; tx <= input.bounds.maxTx; tx++) {
          const applied = await applyTile(region, regionId, tx, tz, ctx);
          bodies.push(applied.bodyId);
          keys.push(applied.key);
        }
      }
      ctx.emit("terrain.region.ready", { regionId, tiles: bodies.length });
      return { regionId, tiles: bodies.length, bodies, keys };
    },
  };

  // ---- world.streamFollow --------------------------------------------------
  const streamFollowInput = z.object({
    regionId: z.string(),
    anchor: Vec3,
    radius: z.number().int().min(0).max(8).default(1),
  });
  const streamFollowOutput = z.object({
    regionId: z.string(),
    loaded: z.array(z.string()),
    removed: z.array(z.string()),
    active: z.number().int(),
  });
  const streamFollow: SkillDefinition<z.infer<typeof streamFollowInput>, z.infer<typeof streamFollowOutput>> = {
    name: "world.streamFollow",
    version: "1.0.0",
    description: "Stream terrain tiles in a square window around an anchor (agent/camera): generate+apply tiles entering the window, remove tiles leaving a keep-margin. Returns the loaded/removed tile keys. Off-loop in production; synchronous here.",
    category: "world",
    permissions: ["terrain.generate"],
    input: streamFollowInput,
    output: streamFollowOutput,
    handler: async (input, ctx) => {
      const region = regions.get(input.regionId);
      if (region === undefined) throw new Error(`world.streamFollow: unknown region ${input.regionId}`);
      const atx = Math.floor(input.anchor[0] / TILE_SIZE);
      const atz = Math.floor(input.anchor[2] / TILE_SIZE);
      const keep = input.radius + 1; // hysteresis: load within radius, drop beyond keep
      // Load tiles entering the window (deterministic order).
      const loaded: string[] = [];
      for (let tz = atz - input.radius; tz <= atz + input.radius; tz++) {
        for (let tx = atx - input.radius; tx <= atx + input.radius; tx++) {
          const req: TileRequest = { seed: region.seed, tx, tz, lod: region.lod, hints: region.hints };
          if (!region.tiles.has(requestKey(req))) {
            const applied = await applyTile(region, input.regionId, tx, tz, ctx);
            loaded.push(applied.key);
          }
        }
      }
      // Remove tiles outside the keep-margin.
      const removed: string[] = [];
      for (const [key, t] of [...region.tiles]) {
        if (Math.abs(t.tx - atx) > keep || Math.abs(t.tz - atz) > keep) {
          ctx.world.ops.op_physics_remove_body(t.bodyId);
          despawnRenderable(ctx.world.ecs, t.eid);
          ctx.world.entities.destroy(t.entity);
          region.tiles.delete(key);
          removed.push(key);
          ctx.emit("terrain.tile.unloaded", { regionId: input.regionId, key, tx: t.tx, tz: t.tz });
        }
      }
      return { regionId: input.regionId, loaded, removed, active: region.tiles.size };
    },
  };

  // ---- terrain.sampleHeight ------------------------------------------------
  const sampleHeightInput = z.object({
    seed: z.number().int(),
    x: z.number(),
    z: z.number(),
    lod: z.number().int().min(0).max(4).default(0),
  });
  const sampleHeight: SkillDefinition<z.infer<typeof sampleHeightInput>, { y: number }> = {
    name: "terrain.sampleHeight",
    version: "1.0.0",
    description: "O(1) deterministic surface-elevation query at a world (x,z) for a seed/lod (snapping/placement). Returns world Y.",
    category: "terrain",
    permissions: ["terrain.read"],
    input: sampleHeightInput,
    output: z.object({ y: z.number() }),
    handler: (input) => ({ y: source.sampleHeight(input.seed, input.x, input.z, input.lod) }),
  };

  // ---- terrain.sampleClimate -----------------------------------------------
  const sampleClimateInput = z.object({
    seed: z.number().int(),
    x: z.number(),
    z: z.number(),
    // SAME opt-in shaping (incl. per-type climate bias) a region was generated with, so
    // the perceived biome matches the shaped tiles; omit for the byte-identical base.
    hints: z.record(z.string(), z.number()).optional(),
  });
  const sampleClimate: SkillDefinition<z.infer<typeof sampleClimateInput>, { tempC: number; precipMm: number; biome: number }> = {
    name: "terrain.sampleClimate",
    version: "1.0.0",
    description: "Deterministic per-coordinate climate (tempC, precipMm, biome) for agent perception. Pass the region's terrain hints to read the per-type biome.",
    category: "terrain",
    permissions: ["terrain.read"],
    input: sampleClimateInput,
    output: z.object({ tempC: z.number(), precipMm: z.number(), biome: z.number().int() }),
    handler: (input) => source.sampleClimate(input.seed, input.x, input.z, input.hints),
  };

  registry.register(generateRegion);
  registry.register(streamFollow);
  registry.register(sampleHeight);
  registry.register(sampleClimate);

  return { cache, regions };
}
