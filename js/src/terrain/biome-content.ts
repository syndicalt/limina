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
import type { AssetInstance, ScatterAsset, ScatterConfig } from "./asset-scatter.ts";
import { Biome, type TerrainSource } from "./types.ts";
import type { SkillRegistry, InvokeBase } from "../skills/registry.ts";
import type { RegionState } from "../skills/terrain.ts";
import type { MCPResponse } from "../mcp/protocol.ts";

// ───────────────────────── SEMANTIC ROLES — THE ENGINE NEVER NAMES A GLB ─────────────────────────
// A layer references a semantic ROLE (conifer, broadleaf, boulder, …); a PROJECT supplies a
// BiomePack binding each role to a concrete asset id (+ optional embed radius). The engine ships
// NO pack — an absent/partial pack is GRACEFUL: an unmapped role is skipped, and a layer with no
// mapped roles produces no scatter config at all (never a thrown, broken world). The reference
// CC0 assets a project MIGHT bind (model unit extents in meters, base at Y≈0 so a scatter seats
// it ON the surface) are documented per role so a pack author knows the intended scale/silhouette:
//   conifer   — a tall narrow spruce (e.g. "Tree" by hat_my_guy, CC0 — ≈2.40 × 6.03 × 2.40 m)
//   broadleaf — a spreading round canopy (e.g. "Tree from the savanna" by hat_my_guy, CC0 — ≈2.32 × 5.13 × 4.89 m)
//   cactus    — a saguaro (e.g. "Cactus" by Quaternius, CC0 — ≈0.34 × 1.41 × 1.00 m)
//   bush      — a low shrub (e.g. "Bush" by Quaternius, CC0 — ≈2.07 × 1.19 × 2.07 m)
//   grass     — a grass tuft (e.g. "Grass" by Quaternius, CC0 — ≈1.84 × 0.51 × 0.50 m)
//   boulder   — a rock / desert boulder / driftwood (e.g. "Rock" by Quaternius, CC0)
//   palm      — a tropical palm (e.g. "Palm Tree" by Quaternius, CC0)

/** The semantic content roles a biome layer can reference. A project's BiomePack binds each to
 *  a concrete asset id; the engine never hardcodes a GLB name. */
export type BiomeRole = "conifer" | "broadleaf" | "boulder" | "bush" | "grass" | "cactus" | "palm";

/** A project's binding of ONE role to a concrete content asset. `embedRadius` is the measured base
 *  FOOTPRINT half-extent (world units at scale 1), fed to asset.scatter's embed-sink so a prop on a
 *  slope beds its downhill base lip into the ground instead of floating ~r·slope above it (the
 *  "floating trees" artefact). Omit for props that need no sink (slope≈0 → sink≈0 regardless). */
export interface BiomePackEntry {
  id: string;
  embedRadius?: number;
  lods?: { id: string; distance: number; hysteresis?: number }[];
}

/** A project-supplied binding of roles → assets. Partial: any unmapped role is scattered as nothing
 *  (graceful). The engine ships NO pack — a project drops one in (biome-pack.json). */
export type BiomePack = Partial<Record<BiomeRole, BiomePackEntry>>;

/** The empty pack — the default when a project supplies none. Every role unmapped → nothing scatters. */
export const EMPTY_BIOME_PACK: BiomePack = {};

/** One weighted role reference inside a layer's palette. Resolved against a BiomePack to a concrete
 *  ScatterAsset; an unmapped role is dropped from the resolved palette. */
export interface BiomeLayerRole { role: BiomeRole; weight?: number; }

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
  /** The role palette for this layer (>=1), weighted. Resolved against a project's BiomePack to a
   *  concrete ScatterAsset palette; any role the pack doesn't map is dropped (graceful). */
  assets: BiomeLayerRole[];
  density?: number;
  coverage?: number;
  cluster?: number;
  clusterFreq?: number;
  slopeMax?: number;
  sizeRange?: [number, number];
  /** Optional spatial render-cell size used by population LOD or scatter chunking. */
  cellSize?: number;
  /** Layer-default footprint radius for the embed-sink (world units), applied to any
   *  palette asset that doesn't set its own ScatterAsset.embedRadius. 0/unset → no sink. */
  embedRadius?: number;
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
      assets: [{ role: "palm", weight: 3 }, { role: "boulder", weight: 2 }],
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
      // (~0.58 of the relief). slopeMax 0.8 keeps the WIDE pine cones off the steepest eroded
      // flanks, where even the balanced embed-sink (K=0.5) leaves a visible skirt-float / trunk-
      // bury mismatch (the "sunken trees" the user saw at slopeMax 1.15). 0.8 still yields a
      // healthy forest on the amp-4.5 eroded mountain (~540 pines on the 4×4, far above boulders)
      // — it is the gentler tree-line, not the old 0.85/0.45 dual cap that cropped pines to a band.
      seed: 31, assets: [{ role: "conifer" }], coverage: 0.30, cluster: 0.45, clusterFreq: 1 / 34,
      slopeMax: 0.8, sizeRange: [0.8, 1.5], elevMaxFrac: 0.58, waterGated: true,
    },
    {
      // Boulders as the rock-zone ACCENT (sparse, so they don't dominate the forested slopes).
      seed: 32, assets: [{ role: "boulder" }], coverage: 0.08, cluster: 0.35,
      slopeMax: 1.4, sizeRange: [1.0, 2.6], elevMinFrac: 0.30, waterGated: true,
    },
  ],
  // Dense temperate woodland: broadleaf + conifer mix over a bush understorey.
  forest: [
    {
      seed: 41, assets: [{ role: "broadleaf", weight: 3 }, { role: "conifer", weight: 2 }],
      coverage: 0.30, cluster: 0.5, clusterFreq: 1 / 30, slopeMax: 0.8, sizeRange: [0.9, 1.6],
    },
    {
      seed: 42, assets: [{ role: "bush" }], coverage: 0.18, cluster: 0.3, sizeRange: [0.8, 1.5],
    },
  ],
  // Sparse saguaro cacti (biome-gated to the hot/dry desert) + the odd weathered rock.
  desert: [
    {
      seed: 51, assets: [{ role: "cactus" }], biomes: [BIOME_DESERT],
      coverage: 0.08, cluster: 0.5, clusterFreq: 1 / 32, slopeMax: 0.6, sizeRange: [0.8, 1.8],
    },
    {
      seed: 52, assets: [{ role: "boulder" }], coverage: 0.05, cluster: 0.4, sizeRange: [0.8, 2.0],
    },
  ],
  // Open grassland: dense grass tufts with the occasional lone broadleaf.
  plains: [
    {
      seed: 61, assets: [{ role: "grass" }], coverage: 0.35, cluster: 0.35, slopeMax: 0.7, sizeRange: [0.7, 1.4],
    },
    {
      seed: 62, assets: [{ role: "broadleaf" }], coverage: 0.02, cluster: 0.6, slopeMax: 0.8, sizeRange: [0.9, 1.5],
    },
  ],
  // Cool rolling uplands: a thinner broadleaf+pine cover over grass and bush.
  hills: [
    {
      seed: 71, assets: [{ role: "broadleaf", weight: 2 }, { role: "conifer", weight: 2 }],
      coverage: 0.12, cluster: 0.5, slopeMax: 0.8, sizeRange: [0.8, 1.5],
    },
    {
      seed: 72, assets: [{ role: "grass", weight: 2 }, { role: "bush", weight: 1 }],
      coverage: 0.16, cluster: 0.3, sizeRange: [0.7, 1.3],
    },
  ],
  // Warm archipelago: palm groves on the shore, a few pines on the higher dry interior.
  islands: [
    {
      seed: 81, assets: [{ role: "palm", weight: 3 }, { role: "boulder", weight: 1 }],
      coverage: 0.07, cluster: 0.7, clusterFreq: 1 / 28, slopeMax: 0.7, sizeRange: [1.0, 2.2], waterGated: true,
    },
    {
      seed: 82, assets: [{ role: "conifer" }], coverage: 0.06, cluster: 0.5, slopeMax: 0.8, sizeRange: [0.8, 1.3],
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
export function resolveLayer(layer: BiomeLayer, pack: BiomePack, survey: ReliefSurvey, waterLevel?: number, waterMargin = 0): ScatterConfig {
  const relief = survey.maxY - survey.minY;
  // Resolve the layer's ROLE palette against the project's BiomePack. An unmapped role is dropped
  // (graceful decoupling): a layer whose roles are all unmapped resolves to an empty palette, which
  // biomeScatterConfigs then filters out so no asset.scatter runs for it.
  const palette: ScatterAsset[] = [];
  for (const { role, weight } of layer.assets) {
    const bound = pack[role];
    if (bound === undefined) continue;
    palette.push({
      id: bound.id,
      ...(weight !== undefined ? { weight } : {}),
      ...(bound.embedRadius !== undefined ? { embedRadius: bound.embedRadius } : {}),
      ...(bound.lods !== undefined ? { lods: bound.lods } : {}),
    });
  }
  const config: ScatterConfig = { seed: layer.seed, assets: palette };
  if (layer.density !== undefined) config.density = layer.density;
  if (layer.coverage !== undefined) config.coverage = layer.coverage;
  if (layer.cluster !== undefined) config.cluster = layer.cluster;
  if (layer.clusterFreq !== undefined) config.clusterFreq = layer.clusterFreq;
  if (layer.slopeMax !== undefined) config.slopeMax = layer.slopeMax;
  if (layer.sizeRange !== undefined) config.sizeRange = layer.sizeRange;
  if (layer.cellSize !== undefined) config.cellSize = layer.cellSize;
  if (layer.embedRadius !== undefined) config.embedRadius = layer.embedRadius;
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
export function biomeScatterConfigs(type: TerrainTypeName, pack: BiomePack, survey: ReliefSurvey, waterLevel?: number, waterMargin = 0): ScatterConfig[] {
  const wl = waterLevel ?? (isWaterType(type) ? defaultWaterLevel(survey) : undefined);
  // FILTER OUT layers whose palette resolved to nothing (an unmapped/absent pack) — an empty-asset
  // config would drive asset.scatter with no assets. Dropping it means an absent pack scatters
  // nothing rather than throwing, and a partial pack scatters only its mapped layers.
  return BIOME_CONTENT[type]
    .map((layer) => resolveLayer(layer, pack, survey, wl, waterMargin))
    .filter((config) => config.assets.length > 0);
}

/** The deterministic beach palm/driftwood config, reproduced bit-for-bit from the catalog
 *  (the beach has exactly one layer, water-gated to `seaLevel`). cottage_beach.ts delegates
 *  here so the catalog is the single source of truth and the cottage scene is unchanged. */
export function resolveBeachConfig(seaLevel: number, pack: BiomePack): ScatterConfig {
  return resolveLayer(BIOME_CONTENT.beach[0], pack, { minY: 0, maxY: 1 }, seaLevel);
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
  /** The project's role→asset binding. The engine ships no pack; an absent/partial pack scatters
   *  nothing for unmapped roles (graceful). Pass EMPTY_BIOME_PACK to scatter nothing at all. */
  pack: BiomePack;
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
  /** Optional render-cell size applied to every resolved layer. This changes only
   *  derived render batching/LOD granularity, never canonical placements. */
  cellSize?: number;
  /** The live region table the terrain.* skills populate (core.terrain.regions). When the
   *  region is found, the relief is surveyed with the EXACT hints it was generated with
   *  (e.g. an amp/erode override) so fractional gates like the pine tree-line resolve
   *  against the SAME surface asset.scatter places on. Without it the survey falls back to
   *  the bare type-default hints — which silently mis-places gated content when the region
   *  was generated with hint overrides (the "only rocks, no pines" bug). */
  regions?: Map<string, RegionState>;
}

/** The result of scattering a type's content: one asset.scatter response per layer. */
export interface ScatterBiomeContentResult {
  regionId: string;
  type: TerrainTypeName;
  survey: ReliefSurvey;
  configs: ScatterConfig[];
  /** Total instances placed across all layers. */
  instances: number;
  /** Per-layer asset.scatter results (instances + mounted level-mesh count + pinned hashes +
   *  the computed placements). `placements` are the REAL transforms the mount path placed
   *  (asset.scatter's output), so callers/tests can verify the spawn mask — e.g. that no
   *  waterGated prop sits at/below the waterline — on the actual mounted set, not a
   *  re-derived pure scatter. */
  layers: { instances: number; mounted: number; assetHashes: Record<string, string>; placements: AssetInstance[] }[];
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
  // Survey with the region's ACTUAL generated hints (amp/erode overrides included) when the
  // region table is supplied — so the fractional elevation gates resolve against the SAME
  // surface asset.scatter places on. Fall back to the bare type defaults otherwise (matches
  // a region generated with no hint overrides). region.hints is already the merged map
  // ({ ...terrainTypeHints, ...overrides }) world.generateRegion stored, so it's complete.
  const hints = deps.regions?.get(deps.regionId)?.hints ?? terrainTypeHints(deps.type, deps.bounds);
  const survey = surveyRegionRelief(deps.source, deps.seed, deps.bounds, hints);
  const wl = deps.waterLevel ?? (isWaterType(deps.type) ? defaultWaterLevel(survey) : undefined);
  // Configs are already filtered to non-empty palettes (unmapped roles dropped). If the pack maps
  // nothing, configs=[] → the loop drives zero asset.scatter calls → 0 instances, no throw.
  const resolvedConfigs = biomeScatterConfigs(deps.type, deps.pack, survey, wl, deps.waterMargin ?? 0);
  const configs = deps.cellSize === undefined
    ? resolvedConfigs
    : resolvedConfigs.map((config) => ({ ...config, cellSize: deps.cellSize }));

  const layers: ScatterBiomeContentResult["layers"] = [];
  let total = 0;
  for (const config of configs) {
    const res = ok(await deps.registry.invoke("asset.scatter", { regionId: deps.regionId, config }, deps.base), `asset.scatter ${deps.type}`);
    const instances = res.instances as number;
    total += instances;
    layers.push({ instances, mounted: res.mounted as number, assetHashes: res.assetHashes as Record<string, string>, placements: res.placements as AssetInstance[] });
  }
  return { regionId: deps.regionId, type: deps.type, survey, configs, instances: total, layers };
}
