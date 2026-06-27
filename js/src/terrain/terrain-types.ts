// Phase 11 — the TERRAIN-TYPE catalog: named, seedable presets of the general
// procedural-shaping primitives. The whole point is agent-native authoring: the agent
// picks a TYPE ("beach", "mountains", "desert", …) + a seed, and the deterministic
// generator builds that world — no per-type special-case code in the engine. A type is
// nothing but a fixed bundle of the SAME opt-in knobs procedural.ts already understands
// (domain warp, ridged detail, an amplitude/relief multiplier, a base-frequency scale,
// a radial island falloff, and a temp/precip CLIMATE bias), so adding a type is data,
// not code, and every type is just as deterministic + replay-safe as the beach was.
//
// `terrainTypeHints(type, bounds)` resolves a type name into the numeric `hints` map
// world.generateRegion / procedural.ts consume. With a type chosen the agent gets a
// believable world; with NO type (no hints) the generator is byte-identical to the
// pre-catalog default. The beach preset reproduces the old `beachShapeHints` shape
// bit-for-bit (so the cottage scene is unchanged) — this catalog is now its one source
// of truth.

import { TILE_SIZE } from "./procedural.ts";

/** The shipped terrain types. The first five are the required core set; hills/islands
 *  are cheap extra presets over the same primitives. */
export type TerrainTypeName =
  | "beach" | "mountains" | "forest" | "desert" | "plains" | "hills" | "islands";

/** Tile-grid rectangle a region spans (same shape as world.generateRegion bounds).
 *  Used to centre + scale an island-falloff type to the generated rectangle. */
export interface RegionBounds { minTx: number; minTz: number; maxTx: number; maxTz: number }

/**
 * A terrain type = a config of the general shaping primitives + a climate bias. Every
 * field maps to a single opt-in knob procedural.ts parses (see parseShape):
 *   warp/warpFreq  domain-warp amplitude (m) + frequency — meandering, organic landforms
 *   ridge          [0,1] blend of ridged multifractal detail (crests/dunes/peaks)
 *   amp            RELIEF multiplier on the [0,1] elevation — mountains tall, plains flat
 *   freqScale      base-frequency multiplier — <1 broad landforms, >1 finer/busier
 *   island         OPT radial falloff (as fractions of the region half-extent): the land
 *                  rises from the sea floor inside `radiusFrac`, slopes to water over
 *                  `falloffFrac`. Omit for a continuous (non-island) terrain.
 *   tempBias/precipBias  added to the climate fields (°C / mm) so biomeOf reads sensibly
 *                  per type: desert hot+dry, forest wet, alpine cold, beach warm+maritime.
 */
export interface TerrainTypeConfig {
  warp: number;
  warpFreq: number;
  ridge: number;
  amp: number;
  freqScale: number;
  island?: { radiusFrac: number; falloffFrac: number };
  tempBias: number;
  precipBias: number;
}

/** The catalog. Tuned so the five core types produce DISTINCT surfaces (mountains ~6×
 *  the relief of plains) AND distinct climates/biomes (a falsifiable spread, not one
 *  config wearing seven hats). Keep these stable — they are the seedable world presets. */
export const TERRAIN_TYPES: Record<TerrainTypeName, TerrainTypeConfig> = {
  // A warm tropical sand island: the exact shape `beachShapeHints` shipped (warp 22,
  // ridge 0.45, island core 0.62 / slope 0.70), now with a warm+wet maritime climate.
  beach: {
    warp: 22, warpFreq: 1 / 130, ridge: 0.45, amp: 1, freqScale: 1,
    island: { radiusFrac: 0.62, falloffFrac: 0.70 },
    tempBias: 14, precipBias: 600,
  },
  // Tall, sharp, COLD relief: high amplitude + heavy ridged multifractal → snow-capped
  // peaks (the elevation lapse + the negative bias push the crests below freezing → ice).
  mountains: {
    warp: 24, warpFreq: 1 / 160, ridge: 0.70, amp: 2.4, freqScale: 1.25,
    tempBias: -8, precipBias: 300,
  },
  // Rolling, well-watered temperate land → a wet forest biome.
  forest: {
    warp: 16, warpFreq: 1 / 140, ridge: 0.25, amp: 0.9, freqScale: 1.0,
    tempBias: 6, precipBias: 1500,
  },
  // Hot + bone dry, with crisp wind-ridged dunes (high ridge + high frequency).
  desert: {
    warp: 30, warpFreq: 1 / 110, ridge: 0.60, amp: 0.65, freqScale: 1.5,
    tempBias: 22, precipBias: -2750,
  },
  // Near-flat, broad, warm-temperate grassland/savanna (low amplitude + frequency, no
  // ridges; warm + semi-dry so it reads as open grassland, not wet forest).
  plains: {
    warp: 8, warpFreq: 1 / 200, ridge: 0.0, amp: 0.35, freqScale: 0.7,
    tempBias: 6, precipBias: -1850,
  },
  // Gentle, cooler, temperate-dry rolling hills (between plains and mountains).
  hills: {
    warp: 18, warpFreq: 1 / 150, ridge: 0.20, amp: 0.8, freqScale: 1.1,
    tempBias: 2, precipBias: -1850,
  },
  // A warm archipelago: a smaller, busier island core than the beach.
  islands: {
    warp: 26, warpFreq: 1 / 120, ridge: 0.35, amp: 1.1, freqScale: 1.1,
    island: { radiusFrac: 0.50, falloffFrac: 0.80 },
    tempBias: 6, precipBias: 400,
  },
};

/** All shipped type names (for catalogs, enums, demos). */
export const TERRAIN_TYPE_NAMES = Object.keys(TERRAIN_TYPES) as TerrainTypeName[];

/** True if `name` is a known terrain type (narrows to TerrainTypeName). */
export function isTerrainType(name: string): name is TerrainTypeName {
  return Object.prototype.hasOwnProperty.call(TERRAIN_TYPES, name);
}

/**
 * Resolve a terrain TYPE into the numeric `hints` map procedural.ts / world.generateRegion
 * consume. Pure + deterministic: the same (type, bounds) always yields the same map, so the
 * recorded request replays bit-for-bit. `bounds` is only needed to centre + scale an
 * island-falloff type to the region; continuous types ignore it. Only the knobs that
 * actually shape the surface for this type are emitted (so `beach` stays byte-identical to
 * the original beachShapeHints — amp/freqScale of 1 are no-ops but harmless to include).
 */
export function terrainTypeHints(type: TerrainTypeName, bounds: RegionBounds): Record<string, number> {
  const c = TERRAIN_TYPES[type];
  const hints: Record<string, number> = {
    shape: 1,
    warp: c.warp,
    warpFreq: c.warpFreq,
    ridge: c.ridge,
    amp: c.amp,
    freqScale: c.freqScale,
    tempBias: c.tempBias,
    precipBias: c.precipBias,
  };
  if (c.island !== undefined) {
    const cx = ((bounds.minTx + bounds.maxTx + 1) / 2) * TILE_SIZE;
    const cz = ((bounds.minTz + bounds.maxTz + 1) / 2) * TILE_SIZE;
    const spanX = (bounds.maxTx - bounds.minTx + 1) * TILE_SIZE;
    const spanZ = (bounds.maxTz - bounds.minTz + 1) * TILE_SIZE;
    const half = Math.min(spanX, spanZ) / 2;
    hints.islandCx = cx;
    hints.islandCz = cz;
    hints.islandRadius = half * c.island.radiusFrac;
    hints.islandFalloff = half * c.island.falloffFrac;
  }
  return hints;
}
