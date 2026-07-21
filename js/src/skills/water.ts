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
import * as THREE from "../../build/three.bundle.mjs";
import {
  buildRiverRibbon,
  buildWaterBodySurface,
  buildWaterSurface,
  DEFAULT_WATER_COLOR,
  DEFAULT_WATER_SIZE,
  type WaterDepthOptions,
} from "../water.ts";
import { DEFAULT_RENDER_QUALITY_PROFILES, type WaterRenderQuality } from "../render/quality.ts";
import { VisibleWaterManager } from "../render/water/visible-water-manager.ts";
import { TILE_SIZE } from "../terrain/procedural.ts";
import { isTerrainType, terrainTypeHints } from "../terrain/terrain-types.ts";
import type { TerrainSource } from "../terrain/types.ts";
import { sampleTileSurfaceHeight } from "../terrain/mesh.ts";
import type { RegionState } from "./terrain.ts";
import type { EditableTerrain } from "./terrain-edit.ts";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";
import type { AssetRegistry } from "../asset-registry.ts";
import { migrateWorldMap, verifyWorldMap, WorldMapSchema, type WorldMap } from "../world/worldmap.ts";
import { createWaterField } from "../world/water-field.mjs";
import { WATER_LIMITS } from "../world/water-ir.mjs";

/** One water surface currently in the scene (for inspection / idempotent rebuild on
 *  replay). Held in the registry closure, so a fresh replay registry starts empty and
 *  rebuilds it by re-invoking the recorded `world.addWater` command. */
export interface WaterSurfaceState {
  level: number;
  size: number;
  color: number;
  /** The cosmetic mesh added to the scene (never an ECS entity / physics body). */
  mesh: unknown;
  key?: string;
  kind?: "ocean" | "basin";
  bodyId?: string;
}

export interface WaterSkillState {
  surfaces: WaterSurfaceState[];
  rivers: unknown[];
  manager(): VisibleWaterManager | undefined;
  setQuality(quality: Readonly<WaterRenderQuality>): void;
  dispose(): void;
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
   *  shoreline depth-fade reads wrong (a pale shelf where the real coast tapers). When
   *  OMITTED, the skill defaults to the recorded merged hints of the already-generated
   *  region matching (seed, bounds) in the live region table (generateRegion precedes
   *  addWater in every log, so replay re-derives the same map). */
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

/** The recorded merged hint map (type defaults + overrides, as world.generateRegion stored it)
 *  of the ALREADY-GENERATED region matching (seed, tile bounds) in the live region table.
 *  Used when an explicit `region` descriptor arrives WITHOUT `hints`: the depth field MUST be
 *  baked against the same shaped/eroded surface the region's colliders were built with, or a
 *  region generated with overrides (island falloff + erosion) bakes against the bare
 *  type-default surface — that surface can sit entirely ABOVE the sea level, the whole
 *  submerged shelf then reads depth≈0 ("at the waterline"), and the water material's
 *  shoreline foam band (a diagonal world-XZ ripple) stripes the entire shelf instead of
 *  hugging the coast. Deterministic + replay-safe: the region table is itself rebuilt by
 *  replaying world.generateRegion, which precedes world.addWater in every log. */
export function recordedRegionHints(
  regions: Map<string, RegionState> | undefined,
  seed: number,
  bounds: { minTx: number; minTz: number; maxTx: number; maxTz: number },
): Record<string, number> | undefined {
  if (regions === undefined) return undefined;
  for (const r of regions.values()) {
    if (r.seed !== seed || r.hints === undefined) continue;
    let minTx = Infinity, minTz = Infinity, maxTx = -Infinity, maxTz = -Infinity;
    for (const t of r.tiles.values()) {
      if (t.tx < minTx) minTx = t.tx;
      if (t.tx > maxTx) maxTx = t.tx;
      if (t.tz < minTz) minTz = t.tz;
      if (t.tz > maxTz) maxTz = t.tz;
    }
    if (minTx === bounds.minTx && minTz === bounds.minTz && maxTx === bounds.maxTx && maxTz === bounds.maxTz) {
      return r.hints;
    }
  }
  return undefined;
}

/** Derive a TRUE water-column-depth descriptor from an EDITABLE terrain layer (terrain.create).
 *  OUR settlement scene sculpts its ground with terrain.create — an editable heightfield held in
 *  `layer.tile`, NOT the region table — so deriveDepthFromRegions can't see it and the depth-fade
 *  would fall back to the camera-distance proxy. This builds `sampleHeight(x,z)` from the tile's
 *  heightfield with the SAME shared bilinear sampler village.build/asset.place read
 *  (terrain/mesh.ts sampleTileSurfaceHeight), over the tile's world-XZ rectangle, so the shoreline
 *  depth-fade (turquoise shallows → opaque deep) tracks the eroded terrain. RENDER-ONLY: it only feeds colour/opacity, never sim state; deterministic and
 *  re-derived on replay from the re-created layer. EXPORTED for the depth UAT. */
export function deriveDepthFromLayer(layer: EditableTerrain): WaterDepthOptions {
  const tile = layer.tile;
  const sizeX = tile.scale[0], sizeZ = tile.scale[2];
  const x0 = tile.origin[0] - sizeX / 2, z0 = tile.origin[2] - sizeZ / 2;
  const sampleHeight = (x: number, z: number): number => sampleTileSurfaceHeight(tile, x, z);
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

function sampleLayerHeight(layer: EditableTerrain, x: number, z: number): number {
  return sampleTileSurfaceHeight(layer.tile, x, z);
}

function resolveVerifiedMap(assets: AssetRegistry | undefined, mapAssetId: string, committedHash: string | undefined, skill: string): WorldMap {
  if (assets === undefined) throw new Error(`${skill} requires an AssetRegistry`);
  const resolved = assets.resolve(mapAssetId);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(resolved.bytes)); }
  catch (error) { throw new Error(`${skill}: '${mapAssetId}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const worldMap = WorldMapSchema.parse(migrateWorldMap(parsed));
  if (!verifyWorldMap(worldMap).ok) throw new Error(`${skill}: '${mapAssetId}' content hash mismatch`);
  if (committedHash !== undefined && committedHash !== worldMap.provenance.contentHash) {
    throw new Error(`${skill}: map identity mismatch (committed ${committedHash}, resolved ${worldMap.provenance.contentHash})`);
  }
  return worldMap;
}

function mapPoint(worldMap: WorldMap, point: readonly [number, number]): [number, number] {
  return [
    worldMap.origin[0] + point[0] * worldMap.unitsPerMeter,
    worldMap.origin[1] + point[1] * worldMap.unitsPerMeter,
  ];
}

function footprintBounds(contours: readonly (readonly (readonly [number, number])[])[]): Readonly<{ minX: number; minZ: number; maxX: number; maxZ: number }> {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const contour of contours) for (const [x, z] of contour) {
    minX = Math.min(minX, x); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxZ = Math.max(maxZ, z);
  }
  return Object.freeze({ minX, minZ, maxX, maxZ });
}

function bodyDepthTexture(
  field: ReturnType<typeof createWaterField>,
  bodyId: string,
  bounds: Readonly<{ minX: number; minZ: number; maxX: number; maxZ: number }>,
  maximumDepthM: number,
  resolution: number,
): THREE.DataTexture {
  const sampled = field.sampleBodyDepthMask({
    bodyId,
    rect: { x0: bounds.minX, z0: bounds.minZ, w: bounds.maxX - bounds.minX, h: bounds.maxZ - bounds.minZ },
    rows: resolution,
    cols: resolution,
    maximumDepthM,
  });
  const texture = new THREE.DataTexture(sampled.bytes, resolution, resolution, THREE.RGFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function bodyDepthResolution(quality: Readonly<WaterRenderQuality>, bodyCount: number): number {
  if (bodyCount <= 0) return quality.depthRasterSize;
  const perBodyPixels = Math.max(64, Math.floor(quality.depthTextureBudgetPixels / bodyCount));
  const dimension = Math.min(quality.depthRasterSize, Math.floor(Math.sqrt(perBodyPixels)));
  return Math.max(8, 2 ** Math.floor(Math.log2(dimension)));
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
  assets?: AssetRegistry,
): WaterSkillState {
  const surfaces: WaterSurfaceState[] = [];
  /** River ribbon meshes currently in the scene (render-only, like `surfaces`). */
  const rivers: unknown[] = [];
  let visibleWater: VisibleWaterManager | undefined;
  let visibleWaterScene: unknown;
  let quality: Readonly<WaterRenderQuality> = DEFAULT_RENDER_QUALITY_PROFILES.balanced.water;
  let legacySequence = 0;
  const semanticIdentity = (...parts: unknown[]): string => JSON.stringify(parts);
  const managerFor = (scene: unknown): VisibleWaterManager => {
    if (visibleWater === undefined) {
      visibleWaterScene = scene;
      visibleWater = new VisibleWaterManager(scene as never, quality);
    } else if (scene !== visibleWaterScene) {
      throw new Error("water skill registry cannot own more than one world scene");
    }
    return visibleWater;
  };

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
        // Type defaults, then the generated region's RECORDED merged hints (when the caller
        // omitted `region.hints`), then any explicit hints — so the depth bake samples the
        // SAME shaped+eroded surface as the colliders even when the descriptor carries no
        // hints (the recorded-hints fallback is what keeps an island region's submerged
        // shelf from reading depth≈0 and zebra-striping under the shoreline foam band).
        const hints = {
          ...terrainTypeHints(region.type, region.bounds),
          ...(recordedRegionHints(terrainRegions, region.seed, region.bounds) ?? {}),
          ...(region.hints ?? {}),
        };
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
      const key = `legacy:surface:${legacySequence++}`;
      const mounted = managerFor(ctx.world.scene).mount(key, "ocean", (waterQuality) => (
        buildWaterSurface({ level, size: input.size, color: input.color, depth, peek: ctx.world.peek === true,
          waveCount: waterQuality.waveCount, sceneOptics: waterQuality.sceneOptics }) as THREE.Mesh
      ), { source: "legacy-skill" });
      const surface: WaterSurfaceState = { level, size: input.size, color: input.color, mesh: mounted.entry.mesh, key, kind: "ocean" };
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
    points: z.array(z.tuple([
      z.number().finite().min(-WATER_LIMITS.absCoordinateM).max(WATER_LIMITS.absCoordinateM),
      z.number().finite().min(-WATER_LIMITS.absCoordinateM).max(WATER_LIMITS.absCoordinateM),
    ])).min(2).max(WATER_LIMITS.waterwayPoints),
    /** Water surface width (meters) — match the map waterway's widthM. */
    widthM: z.number().finite().positive().max(WATER_LIMITS.widthM).default(6),
    widths: z.array(z.number().finite().positive().max(WATER_LIMITS.widthM)).min(2).max(WATER_LIMITS.waterwayPoints).optional(),
    class: z.enum(["river", "stream"]).default("river"),
    order: z.number().int().min(1).max(WATER_LIMITS.streamOrder).optional(),
    /** Tint (sRGB hex). Default: the sea surface color. */
    color: z.number().int().optional(),
    /** Sea plane Y (the ribbon meets it flush at the mouth). Default: the layer's waterline. */
    level: z.number().optional(),
    /** Terrain layer to drape on (explicit, else most-recent). */
    terrainEntity: z.string().optional(),
  }).superRefine((value, ctx) => {
    if (value.widths !== undefined && value.widths.length !== value.points.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["widths"], message: "widths must have exactly one value per point" });
    }
  });
  const addRiverOutput = z.object({ points: z.number().int(), widthM: z.number(), level: z.number() });
  type MountRiverInput = z.infer<typeof addRiverInput> & {
    key?: string;
    mapDerived?: boolean;
    identity?: string;
    onMounted?: (key: string) => void;
  };
  const mountRiver = (input: MountRiverInput, ctx: Parameters<typeof addRiver.handler>[1]) => {
    const layer = pickLayer(terrainLayers, input.terrainEntity);
    const level = input.level ?? layer?.elevationColors?.seaLevel ?? 0;
    const hasCanonicalTerrain = layer !== undefined || (input.mapDerived === true && terrainSource !== undefined);
    const sampleHeight = layer !== undefined
      ? (x: number, z: number) => sampleLayerHeight(layer, x, z)
      : input.mapDerived === true && terrainSource !== undefined
      ? (x: number, z: number) => terrainSource.sampleHeight(1, x, z, 0)
      : () => level - 1.2;
    const surfaceElevationsM = hasCanonicalTerrain
      ? input.points.map(([x, z]) => Math.max(level + 0.03, sampleHeight(x, z) + 0.03))
      : undefined;
    const key = input.key ?? `legacy:river:${legacySequence++}`;
    const mounted = managerFor(ctx.world.scene).mount(key, "river", (waterQuality) => buildRiverRibbon({
      points: input.points as [number, number][],
      widthM: input.widthM,
      widthsM: input.widths,
      color: input.color,
      sampleHeight,
      surfaceElevationsM,
      seaLevel: level,
      waveCount: input.mapDerived === true ? waterQuality.waveCount : undefined,
      sceneOptics: waterQuality.sceneOptics,
      class: input.class,
      order: input.order,
    }) as THREE.Mesh, { class: input.class, ...(input.order === undefined ? {} : { order: input.order }) }, input.identity ?? key);
    if (mounted.mounted) {
      rivers.push(mounted.entry.mesh);
      input.onMounted?.(key);
    }
    ctx.emit("world.river.added", { points: input.points.length, widthM: input.widthM, level });
    return { points: input.points.length, widthM: input.widthM, level };
  };
  const addRiver: SkillDefinition<z.infer<typeof addRiverInput>, z.infer<typeof addRiverOutput>> = {
    name: "world.addRiver",
    version: "1.0.0",
    description:
      "Add a RENDER-ONLY river: a water ribbon draped along a carved channel polyline, following the terrain (a flat sea plane cannot render a river crossing elevated ground). Cosmetic only — no physics body, no ECS entity, replay rebuilds it from the logged request.",
    category: "world",
    permissions: ["scene.write"],
    input: addRiverInput,
    output: addRiverOutput,
    handler: mountRiver,
  };

  const addMapRiversInput = z.object({
    mapAssetId: z.string().min(1),
    mapHash: z.string().optional(),
    widthScale: z.number().positive().max(10).default(1),
    color: z.number().int().min(0).max(0xffffff).optional(),
    level: z.number().optional(),
    terrainEntity: z.string().optional(),
  });
  const addMapRivers: SkillDefinition<z.infer<typeof addMapRiversInput>, { rivers: number; points: number; mapHash: string }> = {
    name: "world.addMapRivers",
    version: "1.0.0",
    description: "Render every waterway in a validated WorldMap asset as terrain-following river ribbons without duplicating its centerline data in authoring source.",
    category: "world",
    permissions: ["scene.write"],
    commitFields: ["mapHash"],
    input: addMapRiversInput,
    output: z.object({ rivers: z.number().int(), points: z.number().int(), mapHash: z.string() }),
    handler: (input, ctx) => {
      const worldMap = resolveVerifiedMap(assets, input.mapAssetId, input.mapHash, "world.addMapRivers");
      const manager = managerFor(ctx.world.scene);
      const newFragmentCount = worldMap.waterways.reduce((count, _waterway, index) => (
        count + (manager.has(`authored:${worldMap.provenance.contentHash}:waterway:${index}`) ? 0 : 1)
      ), 0);
      if (newFragmentCount > manager.quality.maxResidentFragments - manager.size) {
        throw new RangeError(`map rivers require ${newFragmentCount} new fragments but only ${manager.quality.maxResidentFragments - manager.size} are available`);
      }
      const mountedKeys: string[] = [];
      const riverCountBefore = rivers.length;
      let pointCount = 0;
      try {
        for (let index = 0; index < worldMap.waterways.length; index++) {
          const waterway = worldMap.waterways[index];
          const points = waterway.points.map((entry) => mapPoint(worldMap, entry));
          const level = input.level ?? worldMap.seaLevel;
          mountRiver({
            points,
            widthM: (waterway.widthM ?? 6) * input.widthScale,
            widths: waterway.widths?.map((width) => width * input.widthScale),
            class: waterway.class,
            order: waterway.order,
            color: input.color,
            level,
            terrainEntity: input.terrainEntity,
            mapDerived: true,
            key: `authored:${worldMap.provenance.contentHash}:waterway:${index}`,
            identity: semanticIdentity("authored-waterway", worldMap.provenance.contentHash, index, input.widthScale, input.color ?? null, level, input.terrainEntity ?? null),
            onMounted: (key) => mountedKeys.push(key),
          }, ctx);
          pointCount += points.length;
        }
        return { rivers: worldMap.waterways.length, points: pointCount, mapHash: worldMap.provenance.contentHash };
      } catch (error) {
        rivers.length = riverCountBefore;
        const cleanupErrors: unknown[] = [];
        for (const key of mountedKeys.reverse()) try { manager.remove(key); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
        if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "map river mount and rollback failed");
        throw error;
      }
    },
  };

  const addMapWaterInput = z.object({
    mapAssetId: z.string().min(1),
    mapHash: z.string().optional(),
    widthScale: z.number().positive().max(10).default(1),
    color: z.number().int().min(0).max(0xffffff).optional(),
    level: z.number().optional(),
    terrainEntity: z.string().optional(),
  });
  const addMapWaterOutput = z.object({
    ocean: z.number().int(),
    bodies: z.number().int(),
    rivers: z.number().int(),
    points: z.number().int(),
    mapHash: z.string(),
  });
  const addMapWater: SkillDefinition<z.infer<typeof addMapWaterInput>, z.infer<typeof addMapWaterOutput>> = {
    name: "world.addMapWater",
    version: "1.0.0",
    description: "Mount the verified WorldMap ocean, standing WaterBodies, and waterways as one idempotent render-only water set.",
    category: "world",
    permissions: ["scene.write"],
    commitFields: ["mapHash"],
    input: addMapWaterInput,
    output: addMapWaterOutput,
    handler: (input, ctx) => {
      const worldMap = resolveVerifiedMap(assets, input.mapAssetId, input.mapHash, "world.addMapWater");
      const hash = worldMap.provenance.contentHash;
      const manager = managerFor(ctx.world.scene);
      const requestedKeys = [
        `authored:${hash}:ocean`,
        ...(worldMap.waterBodies ?? []).map((body) => `authored:${hash}:body:${body.id}`),
        ...worldMap.waterways.map((_waterway, index) => `authored:${hash}:waterway:${index}`),
      ];
      const newFragmentCount = requestedKeys.reduce((count, key) => count + (manager.has(key) ? 0 : 1), 0);
      if (newFragmentCount > manager.quality.maxResidentFragments - manager.size) {
        throw new RangeError(`map water requires ${newFragmentCount} new fragments but only ${manager.quality.maxResidentFragments - manager.size} are available`);
      }
      const mountedKeys: string[] = [];
      const surfaceCountBefore = surfaces.length;
      const riverCountBefore = rivers.length;
      const minX = worldMap.origin[0], minZ = worldMap.origin[1];
      const maxX = minX + worldMap.extent.w * worldMap.unitsPerMeter;
      const maxZ = minZ + worldMap.extent.h * worldMap.unitsPerMeter;
      const oceanLevel = input.level ?? worldMap.seaLevel;
      const oceanKey = `authored:${hash}:ocean`;
      try {
      const ocean = manager.mount(oceanKey, "ocean", (waterQuality) => buildWaterSurface({
        level: oceanLevel,
        size: Math.max(maxX - minX, maxZ - minZ) + TILE_SIZE * 2,
        center: [(minX + maxX) / 2, (minZ + maxZ) / 2],
        color: input.color,
        segments: waterQuality.oceanSegments,
        waveCount: waterQuality.waveCount,
        sceneOptics: waterQuality.sceneOptics,
        depth: terrainSource === undefined ? undefined : {
          bounds: { minX, minZ, maxX, maxZ },
          resolution: waterQuality.depthRasterSize,
          sampleHeight: (x, z) => terrainSource.sampleHeight(1, x, z, 0),
        },
        peek: ctx.world.peek === true,
      }) as THREE.Mesh, { mapHash: hash }, semanticIdentity("authored-ocean", hash, oceanLevel, input.color ?? null));
      if (ocean.mounted) {
        mountedKeys.push(oceanKey);
        surfaces.push({
        level: oceanLevel,
        size: Math.max(maxX - minX, maxZ - minZ) + TILE_SIZE * 2,
        color: input.color ?? DEFAULT_WATER_COLOR,
        mesh: ocean.entry.mesh,
        key: oceanKey,
        kind: "ocean",
        });
      }

      let field: ReturnType<typeof createWaterField> | undefined;
      for (const body of worldMap.waterBodies ?? []) {
        const key = `authored:${hash}:body:${body.id}`;
        const points = body.footprint.points.map((entry) => mapPoint(worldMap, entry));
        const holes = body.footprint.holes?.map((hole) => hole.map((entry) => mapPoint(worldMap, entry)));
        const bounds = footprintBounds([points, ...(holes ?? [])]);
        const mounted = manager.mount(key, "basin", (waterQuality) => {
          field ??= createWaterField(worldMap);
          const maximumDepthM = body.depthZones[body.depthZones.length - 1].depthM;
          const texture = bodyDepthTexture(
            field,
            body.id,
            bounds,
            maximumDepthM,
            bodyDepthResolution(waterQuality, worldMap.waterBodies?.length ?? 0),
          );
          return buildWaterBodySurface({
            id: body.id,
            kind: body.kind,
            level: body.level,
            footprint: { points, ...(holes === undefined ? {} : { holes }) },
            color: input.color,
            waveCount: waterQuality.waveCount,
            sceneOptics: waterQuality.sceneOptics,
            depth: { texture, bounds, coverageChannel: true },
          });
        }, { mapHash: hash, bodyId: body.id, bodyKind: body.kind }, semanticIdentity("authored-body", hash, body.id, input.color ?? null));
        if (mounted.mounted) {
          mountedKeys.push(key);
          surfaces.push({
          level: body.level,
          size: Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ),
          color: input.color ?? DEFAULT_WATER_COLOR,
          mesh: mounted.entry.mesh,
          key,
          kind: "basin",
          bodyId: body.id,
          });
        }
      }

      let pointCount = 0;
      for (let index = 0; index < worldMap.waterways.length; index++) {
        const waterway = worldMap.waterways[index];
        const points = waterway.points.map((entry) => mapPoint(worldMap, entry));
        mountRiver({
          points,
          widthM: (waterway.widthM ?? 6) * input.widthScale,
          widths: waterway.widths?.map((width) => width * input.widthScale),
          class: waterway.class,
          order: waterway.order,
          color: input.color,
          level: oceanLevel,
          terrainEntity: input.terrainEntity,
          mapDerived: true,
          key: `authored:${hash}:waterway:${index}`,
          identity: semanticIdentity("authored-waterway", hash, index, input.widthScale, input.color ?? null, oceanLevel, input.terrainEntity ?? null),
          onMounted: (key) => mountedKeys.push(key),
        }, ctx);
        pointCount += points.length;
      }
      return {
        ocean: 1,
        bodies: worldMap.waterBodies?.length ?? 0,
        rivers: worldMap.waterways.length,
        points: pointCount,
        mapHash: hash,
      };
      } catch (error) {
        surfaces.length = surfaceCountBefore;
        rivers.length = riverCountBefore;
        const cleanupErrors: unknown[] = [];
        for (const key of mountedKeys.reverse()) try { manager.remove(key); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
        if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "map water mount and rollback failed");
        throw error;
      }
    },
  };

  registry.register(addWater);
  registry.register(addRiver);
  registry.register(addMapRivers);
  registry.register(addMapWater);
  return {
    surfaces,
    rivers,
    manager: () => visibleWater,
    setQuality(next): void {
      quality = next;
      visibleWater?.setQuality(next);
    },
    dispose(): void {
      visibleWater?.dispose();
      visibleWater = undefined;
      visibleWaterScene = undefined;
      surfaces.length = 0;
      rivers.length = 0;
    },
  };
}
