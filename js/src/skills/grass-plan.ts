// Pure, THREE-free grass placement planner — the deterministic ground-cover counterpart to
// the tree scatter. It reuses the SAME scatterAssets machinery vegetation.scatter uses (seeded
// RNG, slope/elevation gating, and the footprint-exclusion seam), so grass carpets the buildable
// terrain and stops at the settlement edge with byte-identical, replay-safe placements.
//
// Kept free of any THREE / render import on purpose: the determinism gate (js/test/p79) imports
// this module directly, exactly as p78 imports the pure asset-scatter.ts — no WebGPU bundle is
// pulled into the headless test runner. The blade geometry + WebGPU (TSL node) material live in
// the sibling grass.ts, which consumes these placements.

import { scatterAssets, type AssetInstance, type ScatterConfig, type ScatterExclusion } from "../terrain/asset-scatter.ts";
import type { TerrainTile } from "../terrain/types.ts";

/** A placeholder asset id handed to scatterAssets so its weighted pick always resolves to a
 *  single "blade" bucket. Grass never loads a GLB — only the returned x/y/z/yaw/scale are used —
 *  so this id is intentionally NOT a resolvable asset. */
export const GRASS_BLADE_ASSET = "__grass_blade__";

export type GrassClimate = "summer" | "autumn" | "dry" | "winter";

/** Climate-driven palette + density profile. Colours are sRGB hex (converted to linear by
 *  THREE.Color in grass.ts); `coverage` is the default fraction of passing candidates placed
 *  (drier climates thin out); `snowMix` dusts the blade tips (winter). A small, swappable set —
 *  not one hard-coded look. */
export interface GrassClimateParams {
  /** Blade base colour (near the ground). */
  base: number;
  /** Blade tip colour (blended up the blade by height fraction). */
  tip: number;
  /** Default coverage (0..1) — how lush the carpet is for this climate. */
  coverage: number;
  /** How much snow-white to blend into the upper blade (0 = none). */
  snowMix: number;
}

export const GRASS_CLIMATES: Record<GrassClimate, GrassClimateParams> = {
  // Lush green high summer.
  summer: { base: 0x3f5f27, tip: 0x8fae4b, coverage: 0.85, snowMix: 0 },
  // Gold-brown turning autumn.
  autumn: { base: 0x6f5522, tip: 0xc39a44, coverage: 0.70, snowMix: 0 },
  // Sparse, dry, desaturated tan.
  dry: { base: 0x847739, tip: 0xcabe83, coverage: 0.40, snowMix: 0 },
  // Sparse, blue-grey, snow-dusted winter.
  winter: { base: 0x59654f, tip: 0xd6ddd7, coverage: 0.32, snowMix: 0.55 },
};

/** The deterministic inputs to a grass plan. Mirrors ScatterConfig's gating fields but is grass-
 *  specific (a single blade bucket, high density). `exclusions` is the UNION of the terrain's
 *  registered settlement footprints and any explicit discs — grass never grows inside one. */
export interface GrassPlan {
  /** Scatter salt — same seed reproduces the same carpet. Used as both world + config seed
   *  (matching vegetation.scatter). */
  seed: number;
  /** Candidate samples per grid axis (density² candidates over the whole tile). Grass wants a
   *  much higher density than trees to read as a carpet. */
  density: number;
  /** Fraction of passing candidates actually placed (climate-driven default in the skill). */
  coverage: number;
  /** Clumping strength [0,1] — >0 gathers grass into denser tufts and thinner gaps. */
  cluster: number;
  /** Max local slope (rise/run) — steeper faces stay bare. */
  slopeMax: number;
  /** Per-blade uniform scale range (height + width jitter). */
  sizeRange: [number, number];
  /** World-Y floor: no grass below this (above water / sea level). */
  elevationMin?: number;
  /** World-Y ceiling: no grass above this (below the snow line). */
  elevationMax?: number;
  /** Keep-out discs (world XZ) — no blade inside any. Already unioned by the caller. */
  exclusions?: ScatterExclusion[];
}

/** Build the ScatterConfig for a grass plan. A single placeholder "blade" asset (so the weighted
 *  pick is a no-op that always resolves to one bucket) + the plan's gating fields. Pure. */
export function buildGrassScatterConfig(plan: GrassPlan): ScatterConfig {
  return {
    seed: plan.seed,
    density: plan.density,
    assets: [{ id: GRASS_BLADE_ASSET }],
    slopeMax: plan.slopeMax,
    sizeRange: plan.sizeRange,
    coverage: plan.coverage,
    cluster: plan.cluster,
    ...(plan.elevationMin !== undefined ? { elevationMin: plan.elevationMin } : {}),
    ...(plan.elevationMax !== undefined ? { elevationMax: plan.elevationMax } : {}),
    ...(plan.exclusions !== undefined && plan.exclusions.length > 0 ? { exclusions: plan.exclusions } : {}),
  };
}

/** Deterministic per-blade placements over the terrain heightfield: Y sits on the ground, and the
 *  candidate is gated by elevation (above water / below snow), slope, and the footprint-exclusion
 *  discs — exactly like the tree scatter, so grass and trees share the same clean clearings. The
 *  returned AssetInstance list's assetId is always GRASS_BLADE_ASSET (unused by the renderer). */
export function planGrassBlades(tile: TerrainTile, plan: GrassPlan): AssetInstance[] {
  return scatterAssets(tile, plan.seed, buildGrassScatterConfig(plan));
}
