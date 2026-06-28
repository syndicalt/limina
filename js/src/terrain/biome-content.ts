// Phase 11 — the BIOME-CONTENT catalog: the missing half of the terrain-TYPE system.
//
// terrain-types.ts seeds the SURFACE (shape + climate) per type; this catalog seeds
// the CONTENT that lives on it — which curated CC0 assets a type scatters, and the
// tuned ScatterConfig(s) that place them believably (density / coverage / cluster /
// elevation / slope / size, biome- and elevation-gated). The point is the same as the
// type catalog: adding lived-in content to a type is DATA, not engine code, and every
// placement flows through the SAME deterministic, replay-pinned asset.scatter seam the
// beach already used (js/src/skills/asset.ts) — pines on mountain slopes, cacti in the
// desert, broadleaf+pine in forest, grass on plains, palms on the beach.
//
// A type maps to one or more LAYERS. A layer is a ScatterConfig template whose elevation
// gates are expressed as FRACTIONS of the region's own surveyed relief (so a mountain
// tree-line sits below the icy peaks REGARDLESS of seed), plus an optional water gate
// (palms only on dry sand) and an optional biome whitelist (cacti only in the hot/dry
// desert biome). `scatterBiomeContent` surveys the generated region, resolves every
// layer to a concrete ScatterConfig, and drives asset.scatter — the deterministic,
// content-addressed, replay-safe placement the whole engine is built on.
//
// THE BEACH IS UNCHANGED: `resolveBeachConfig` reproduces the original beachScatterConfig
// bit-for-bit (palms weight 3 + driftwood weight 2, clustered groves on dry sand), and
// cottage_beach.ts now delegates to it — one source of truth, the cottage scene identical.

import { TILE_SIZE } from "./procedural.ts";
import { terrainTypeHints, TERRAIN_TYPES, type TerrainTypeName, type RegionBounds } from "./terrain-types.ts";
import type { ScatterAsset, ScatterConfig } from "./asset-scatter.ts";
import { Biome, type TerrainSource } from "./types.ts";
import type { SkillRegistry, InvokeBase } from "../skills/registry.ts";
import type { MCPResponse } from "../mcp/protocol.ts";

// ───────────────────────── ASSET IDS — THE CURATED CC0 PALETTE ─────────────────────────
// Each is plain glTF 2.0 (no Draco/meshopt/KTX2), public-domain (CC0), verified to load
// through parseGltfScene + asset.place. Source + license per asset (model unit extents in
// meters, base at Y≈0 so a scatter seats it ON the surface):
//   pine.glb      — "Tree" (conifer) by hat_my_guy, CC0 — https://poly.pizza/m/BiWaLAItBx
//                   (≈2.40 × 6.03 × 2.40 m — a tall narrow spruce)
//   broadleaf.glb — "Tree from the savanna" by hat_my_guy, CC0 — https://poly.pizza/m/uLxXsCfYb7
//                   (≈2.32 × 5.13 × 4.89 m — a spreading round canopy)
//   cactus.glb    — "Cactus" by Quaternius, CC0 — https://poly.pizza/m/HsEJgRLQWX
//                   (≈0.34 × 1.41 × 1.00 m — a saguaro)
//   bush.glb      — "Bush" by Quaternius, CC0 — https://poly.pizza/m/ooG6CkLyE8
//                   (≈2.07 × 1.19 × 2.07 m — a low shrub)
//   grass.glb     — "Grass" by Quaternius, CC0 — https://poly.pizza/m/UGTOzcO3P2
//                   (≈1.84 × 0.51 × 0.50 m — a grass tuft)
//   rock.glb      — "Rock" by Quaternius, CC0 — https://poly.pizza/m/RtLRqYjfMs (the beach set)
//   palm.glb      — "Palm Tree" by Quaternius, CC0 — https://poly.pizza/m/A6cKJYFsIb (the beach set)
export const PINE_ASSET = "pine.glb";
export const BROADLEAF_ASSET = "broadleaf.glb";
export const CACTUS_ASSET = "cactus.glb";
export const BUSH_ASSET = "bush.glb";
export const GRASS_ASSET = "grass.glb";
export const ROCK_ASSET = "rock.glb"; //   boulder / desert rock / driftwood (reused)
export const PALM_ASSET = "palm.glb"; //   tropical palm (the beach set)

// ───────────────────────── the canonical biome enum (terrain/types.ts) ─────────────
// The integers the tile climate grid actually carries (asset.scatter's `biomes` gate reads
// CLIMATE_BIOME). These ALIAS the canonical `Biome` (the single source of truth EVERY source
// maps onto — procedural.ts:biomeOf AND model-source.ts:classifyBiome), so a content gate
// means the same biome no matter which source generated the tile. Kept as named aliases here
// so the catalog reads by NAME, not magic numbers.
export const BIOME_ICE = Biome.ICE;
export const BIOME_DESERT = Biome.DESERT;
export const BIOME_STEPPE = Biome.STEPPE;
export const BIOME_SAVANNA = Biome.SAVANNA;
export const BIOME_TEMPERATE_FOREST = Biome.TEMPERATE_FOREST;
export const BIOME_TROPICAL = Biome.TROPICAL;
export const BIOME_BOREAL_WET = Biome.BOREAL_WET;

/**
 * One scatter LAYER of a type's content. A ScatterConfig template whose elevation gates
 * are FRACTIONS of the surveyed region relief (resolved per region so they track the
 * seed), plus optional water/biome gates. Everything else passes straight through to the
 * deterministic scatterAssets contract.
 */
export interface BiomeLayer {
  /** Scatter salt — distinct per layer so a type's layers don't share a grid. */
  seed: number;
  /** The curated palette for this layer (>=1), weighted. */
  assets: ScatterAsset[];
  density?: number;
  coverage?: number;
  cluster?: number;
  clusterFreq?: number;
  slopeMax?: number;
  sizeRange?: [number, number];
  /** Biome whitelist (procedural biome enum) — e.g. cacti only in BIOME_DESERT. */
  biomes?: number[];
  /** Inclusive temperature window (°C), reads the climate grid. */
  tempMin?: number;
  tempMax?: number;
  /** Lower elevation gate as a fraction [0,1] of the region relief (minY..maxY). */
  elevMinFrac?: number;
  /** Upper elevation gate (the TREE LINE) as a fraction [0,1] of the region relief. */
  elevMaxFrac?: number;
  /** When true, the lower gate is the region's water level (props on dry land only),
   *  combined with any elevMinFrac as the stricter of the two. */
  waterGated?: boolean;
}

// ───────────────────────── THE CATALOG ─────────────────────────
// Tuned per type from the generator's actual per-type surface + biome spread (see
// js/test/p11_terrain_types.ts): mountains 100% ice biome over Y≈7..24 (so pines are
// ELEVATION-gated below the peaks, never biome-gated); desert 100% desert biome (cacti
// biome-gated, falsifiably absent elsewhere); forest/plains/hills well-separated biomes.
export const BIOME_CONTENT: Record<TerrainTypeName, BiomeLayer[]> = {
  // Palms + driftwood clustered into groves on the DRY sand (reproduces beachScatterConfig).
  beach: [
    {
      seed: 21, density: 14, coverage: 0.05, cluster: 0.85, clusterFreq: 1 / 30,
      assets: [{ id: PALM_ASSET, weight: 3 }, { id: ROCK_ASSET, weight: 2 }],
      slopeMax: 0.7, sizeRange: [1.1, 2.4], waterGated: true,
    },
  ],
  // Pines on the lower slopes; boulders scattered mid-to-high; the icy peaks stay BARE
  // (the pine tree-line is the falsifiable elevation gate — nothing green above the ice).
  // Both layers are waterGated so that, when a water level is supplied (e.g. valleys flooded
  // into lakes), nothing places in or below the water (no trees/boulders standing in a lake).
  // No-op when no waterLevel is supplied — un-flooded mountains stay byte-identical.
  mountains: [
    {
      // Generous conifer forest on the green base + lower/mid slopes up to a sensible tree-line
      // (~0.58 of the relief). slopeMax 1.15 keeps trees on the steep ERODED flanks (an amp-4.5
      // eroded mountainside is steep; the old 0.85/0.45 cropped pines into a thin band → "only rocks").
      seed: 31, assets: [{ id: PINE_ASSET }], coverage: 0.30, cluster: 0.45, clusterFreq: 1 / 34,
      slopeMax: 1.15, sizeRange: [0.8, 1.5], elevMaxFrac: 0.58, waterGated: true,
    },
    {
      // Boulders as the rock-zone ACCENT (sparse, so they don't dominate the forested slopes).
      seed: 32, assets: [{ id: ROCK_ASSET }], coverage: 0.08, cluster: 0.35,
      slopeMax: 1.4, sizeRange: [1.0, 2.6], elevMinFrac: 0.30, waterGated: true,
    },
  ],
  // Dense temperate woodland: broadleaf + conifer mix over a bush understorey.
  forest: [
    {
      seed: 41, assets: [{ id: BROADLEAF_ASSET, weight: 3 }, { id: PINE_ASSET, weight: 2 }],
      coverage: 0.30, cluster: 0.5, clusterFreq: 1 / 30, slopeMax: 0.9, sizeRange: [0.9, 1.6],
    },
    {
      seed: 42, assets: [{ id: BUSH_ASSET }], coverage: 0.18, cluster: 0.3, sizeRange: [0.8, 1.5],
    },
  ],
  // Sparse saguaro cacti (biome-gated to the hot/dry desert) + the odd weathered rock.
  desert: [
    {
      seed: 51, assets: [{ id: CACTUS_ASSET }], biomes: [BIOME_DESERT],
      coverage: 0.08, cluster: 0.5, clusterFreq: 1 / 32, slopeMax: 0.6, sizeRange: [0.8, 1.8],
    },
    {
      seed: 52, assets: [{ id: ROCK_ASSET }], coverage: 0.05, cluster: 0.4, sizeRange: [0.8, 2.0],
    },
  ],
  // Open grassland: dense grass tufts with the occasional lone broadleaf.
  plains: [
    {
      seed: 61, assets: [{ id: GRASS_ASSET }], coverage: 0.35, cluster: 0.35, slopeMax: 0.7, sizeRange: [0.7, 1.4],
    },
    {
      seed: 62, assets: [{ id: BROADLEAF_ASSET }], coverage: 0.02, cluster: 0.6, sizeRange: [0.9, 1.5],
    },
  ],
  // Cool rolling uplands: a thinner broadleaf+pine cover over grass and bush.
  hills: [
    {
      seed: 71, assets: [{ id: BROADLEAF_ASSET, weight: 2 }, { id: PINE_ASSET, weight: 2 }],
      coverage: 0.12, cluster: 0.5, slopeMax: 0.9, sizeRange: [0.8, 1.5],
    },
    {
      seed: 72, assets: [{ id: GRASS_ASSET, weight: 2 }, { id: BUSH_ASSET, weight: 1 }],
      coverage: 0.16, cluster: 0.3, sizeRange: [0.7, 1.3],
    },
  ],
  // Warm archipelago: palm groves on the shore, a few pines on the higher dry interior.
  islands: [
    {
      seed: 81, assets: [{ id: PALM_ASSET, weight: 3 }, { id: ROCK_ASSET, weight: 1 }],
      coverage: 0.07, cluster: 0.7, clusterFreq: 1 / 28, slopeMax: 0.7, sizeRange: [1.0, 2.2], waterGated: true,
    },
    {
      seed: 82, assets: [{ id: PINE_ASSET }], coverage: 0.06, cluster: 0.5, sizeRange: [0.8, 1.3],
      waterGated: true, elevMinFrac: 0.45,
    },
  ],
};

/** The surveyed world-Y relief of a region (the range a scatter's fractional elevation
 *  gates resolve against). */
export interface ReliefSurvey {
  minY: number;
  maxY: number;
}

/** Whether a type is an ISLAND/water type (its surface dips below a water level). Used
 *  to default a water level for the dry-land gate when the caller doesn't pass one. */
export function isWaterType(type: TerrainTypeName): boolean {
  return TERRAIN_TYPES[type].island !== undefined;
}

/** Default water level for a water type: the low 40% of the relief floods (matches the
 *  beach scene's SEA_FRACTION), leaving dry land above for the props. */
export function defaultWaterLevel(survey: ReliefSurvey): number {
  return survey.minY + 0.4 * (survey.maxY - survey.minY);
}

/**
 * Resolve one layer's fractional gates against a region's surveyed relief into a concrete,
 * deterministic ScatterConfig (the exact recorded request asset.scatter logs). Only the
 * fields the layer actually sets are emitted, so a layer with no gates stays a plain
 * density+coverage scatter (and the beach layer reproduces beachScatterConfig verbatim).
 */
export function resolveLayer(layer: BiomeLayer, survey: ReliefSurvey, waterLevel?: number, waterMargin = 0): ScatterConfig {
  const relief = survey.maxY - survey.minY;
  const config: ScatterConfig = { seed: layer.seed, assets: layer.assets };
  if (layer.density !== undefined) config.density = layer.density;
  if (layer.coverage !== undefined) config.coverage = layer.coverage;
  if (layer.cluster !== undefined) config.cluster = layer.cluster;
  if (layer.clusterFreq !== undefined) config.clusterFreq = layer.clusterFreq;
  if (layer.slopeMax !== undefined) config.slopeMax = layer.slopeMax;
  if (layer.sizeRange !== undefined) config.sizeRange = layer.sizeRange;
  if (layer.biomes !== undefined) config.biomes = layer.biomes;
  if (layer.tempMin !== undefined) config.tempMin = layer.tempMin;
  if (layer.tempMax !== undefined) config.tempMax = layer.tempMax;

  // Lower gate: the stricter of a fractional floor and (when water-gated) the water line +
  // a small DRY MARGIN above it (so nothing places in or right at the waterline). The gate
  // is compared against the candidate's surface height in scatterAssets, which reads the
  // SAME (eroded, if enabled) tile heights the lakes sit in — so the exclusion is exact.
  // `waterMargin` defaults to 0, so an unchanged call (beach/islands) stays byte-identical.
  let elevationMin: number | undefined;
  if (layer.elevMinFrac !== undefined) elevationMin = survey.minY + layer.elevMinFrac * relief;
  if (layer.waterGated && waterLevel !== undefined) {
    const dryFloor = waterLevel + waterMargin;
    elevationMin = elevationMin === undefined ? dryFloor : Math.max(elevationMin, dryFloor);
  }
  if (elevationMin !== undefined) config.elevationMin = elevationMin;
  // Upper gate: the tree line.
  if (layer.elevMaxFrac !== undefined) config.elevationMax = survey.minY + layer.elevMaxFrac * relief;
  return config;
}

/** The full set of concrete ScatterConfigs a TYPE places over a region (one per layer).
 *  Pure — for inspection, the demo, and the falsifiable tests without invoking the skill. */
export function biomeScatterConfigs(type: TerrainTypeName, survey: ReliefSurvey, waterLevel?: number, waterMargin = 0): ScatterConfig[] {
  const wl = waterLevel ?? (isWaterType(type) ? defaultWaterLevel(survey) : undefined);
  return BIOME_CONTENT[type].map((layer) => resolveLayer(layer, survey, wl, waterMargin));
}

/** The deterministic beach palm/driftwood config, reproduced bit-for-bit from the catalog
 *  (the beach has exactly one layer, water-gated to `seaLevel`). cottage_beach.ts delegates
 *  here so the catalog is the single source of truth and the cottage scene is unchanged. */
export function resolveBeachConfig(seaLevel: number): ScatterConfig {
  return resolveLayer(BIOME_CONTENT.beach[0], { minY: 0, maxY: 1 }, seaLevel);
}

/** Sample the shaped surface across a region (deterministic, fixed order) to find its
 *  world-Y relief — the SAME survey the cottage scene uses to pick sea level, so a
 *  fractional gate resolves against the real generated tiles. */
export function surveyRegionRelief(source: TerrainSource, seed: number, bounds: RegionBounds, hints: Record<string, number>): ReliefSurvey {
  const STEP = TILE_SIZE / 8;
  const x0 = bounds.minTx * TILE_SIZE, x1 = (bounds.maxTx + 1) * TILE_SIZE;
  const z0 = bounds.minTz * TILE_SIZE, z1 = (bounds.maxTz + 1) * TILE_SIZE;
  let minY = Infinity, maxY = -Infinity;
  for (let z = z0; z <= z1 + 1e-6; z += STEP) {
    for (let x = x0; x <= x1 + 1e-6; x += STEP) {
      const y = source.sampleHeight(seed, x, z, 0, hints);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minY, maxY };
}

/** Dependencies for scattering a type's biome content over an already-generated region. */
export interface ScatterBiomeContentDeps {
  registry: SkillRegistry;
  /** The deterministic terrain source the region was generated from (surveyed for relief). */
  source: TerrainSource;
  /** Handle of the region produced by world.generateRegion (the scatter binds to it). */
  regionId: string;
  /** The terrain TYPE (selects its content layers + the hints to survey with). */
  type: TerrainTypeName;
  /** The region's tile-grid bounds (to survey the relief). */
  bounds: RegionBounds;
  /** The world seed the region was generated at. */
  seed: number;
  /** Invoke identity (the same base the region was generated under). */
  base: InvokeBase;
  /** Override the water level for a water type (default: low 40% of relief floods). */
  waterLevel?: number;
  /** Dry margin (world Y) added ABOVE the water level for waterGated layers, so props sit
   *  clear of the shoreline rather than at it. Default 0 (byte-identical to the prior path). */
  waterMargin?: number;
}

/** The result of scattering a type's content: one asset.scatter response per layer. */
export interface ScatterBiomeContentResult {
  regionId: string;
  type: TerrainTypeName;
  survey: ReliefSurvey;
  configs: ScatterConfig[];
  /** Total instances placed across all layers. */
  instances: number;
  /** Per-layer asset.scatter results (instances + pinned hashes + placements). */
  layers: { instances: number; mounted: number; assetHashes: Record<string, string> }[];
}

function ok(res: MCPResponse | undefined, what: string): Record<string, unknown> {
  if (res === undefined || !res.success) {
    throw new Error(`scatterBiomeContent: ${what} failed: ${JSON.stringify(res?.error)}`);
  }
  return res.result as Record<string, unknown>;
}

/**
 * Scatter a terrain TYPE's biome content over its generated region. Surveys the region's
 * relief, resolves every catalog layer to a concrete ScatterConfig, and drives asset.scatter
 * once per layer — deterministic, replay-pinned, biome/elevation-gated. Returns the resolved
 * configs + per-layer placement counts. The agent-native way to make a typed world lived-in:
 * `world.generateRegion(type) → scatterBiomeContent(type)`.
 */
export async function scatterBiomeContent(deps: ScatterBiomeContentDeps): Promise<ScatterBiomeContentResult> {
  const hints = terrainTypeHints(deps.type, deps.bounds);
  const survey = surveyRegionRelief(deps.source, deps.seed, deps.bounds, hints);
  const wl = deps.waterLevel ?? (isWaterType(deps.type) ? defaultWaterLevel(survey) : undefined);
  const configs = biomeScatterConfigs(deps.type, survey, wl, deps.waterMargin ?? 0);

  const layers: ScatterBiomeContentResult["layers"] = [];
  let total = 0;
  for (const config of configs) {
    const res = ok(await deps.registry.invoke("asset.scatter", { regionId: deps.regionId, config }, deps.base), `asset.scatter ${deps.type}`);
    const instances = res.instances as number;
    total += instances;
    layers.push({ instances, mounted: res.mounted as number, assetHashes: res.assetHashes as Record<string, string> });
  }
  return { regionId: deps.regionId, type: deps.type, survey, configs, instances: total, layers };
}
