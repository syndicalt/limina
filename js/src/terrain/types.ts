// Phase 9 terrain contract — the seam between the terrain.* / world.* skills and
// a generator. The generator is PLUGGABLE and always behind the skill (never an
// engine runtime dependency):
//   - authoring        -> the learned model (Python service, S0-greenlit),
//   - replay / playback -> the tile CACHE carried in the snapshot/export,
//   - tests / offline   -> a deterministic PROCEDURAL source.
// Output is a PURE function of the request (the determinism + replay contract):
// the durable log records the REQUEST (+ a content hash), never the tile bytes.

/** A generated terrain tile — a heightfield grid (+ optional per-cell climate).
 *  Pure data: serializable, content-addressable, snapshot/export-cacheable. The
 *  heightfield maps directly onto op_physics_add_heightfield and a render mesh. */
export interface TerrainTile {
  /** Tile grid resolution. */
  nrows: number;
  ncols: number;
  /** World-space center of the tile [x, y, z] (meters). */
  origin: [number, number, number];
  /** World-space extent [width(x), heightScale(y), depth(z)] (meters). */
  scale: [number, number, number];
  /** Row-major elevation samples (index = row*ncols + col), length nrows*ncols. */
  heights: Float32Array;
  /** Optional per-cell climate grid, flat row-major, length = climateChannels *
   *  nrows * ncols. Channels are packed in the fixed CLIMATE_* order below —
   *  [tempC, precipMm, biome], climateChannels === CLIMATE_CHANNELS — matching
   *  ClimateSample. Empty when the source omits it. A source that emits a climate
   *  grid MUST use this layout; consumers index it by the CLIMATE_* constants
   *  (source-agnostic) and may assert climateChannels === CLIMATE_CHANNELS. */
  climate?: Float32Array;
  climateChannels?: number;
}

/** The fixed channel layout of `TerrainTile.climate` (and the order a source must
 *  pack it in). One climate cell is CLIMATE_CHANNELS consecutive floats:
 *  [tempC (°C), precipMm (mm/yr), biome (enum)] — the same fields as ClimateSample.
 *  Consumers read a cell at base `(row*ncols + col) * climateChannels` + these
 *  offsets, so a correctly-declared grid is read identically across sources. */
export const CLIMATE_TEMP_C = 0;
export const CLIMATE_PRECIP_MM = 1;
export const CLIMATE_BIOME = 2;
export const CLIMATE_CHANNELS = 3;

/** THE CANONICAL BIOME ENUM — the single source of truth for the integer a source packs
 *  into `TerrainTile.climate[CLIMATE_BIOME]` and that content gates (biome-content.ts) read.
 *  EVERY TerrainSource maps its own climate classification onto THESE values, so a biome
 *  whitelist (e.g. cacti only in DESERT) means the same thing regardless of which source
 *  generated the tile. Values are FIXED and load-bearing: they are baked into cached tiles
 *  and asserted by the procedural-parity tests, so changing one re-bakes every world and
 *  breaks replay. A coarse 7-class Whittaker partition:
 *    ICE(0)              — polar / permanent ice (tempC below freezing)
 *    DESERT(1)           — hot + arid
 *    STEPPE(2)           — cool/temperate semi-arid grassland
 *    SAVANNA(3)          — warm semi-arid grassland / tropical dry
 *    TEMPERATE_FOREST(4) — temperate, moderate-to-wet
 *    TROPICAL(5)         — warm + wet (tropical rain/seasonal forest)
 *    BOREAL_WET(6)       — cold + wet (taiga / cool wet forest) */
export const Biome = {
  ICE: 0,
  DESERT: 1,
  STEPPE: 2,
  SAVANNA: 3,
  TEMPERATE_FOREST: 4,
  TROPICAL: 5,
  BOREAL_WET: 6,
} as const;
/** A canonical biome integer (a value of {@link Biome}). */
export type BiomeValue = (typeof Biome)[keyof typeof Biome];

/** Request for a single tile at tile-grid coordinate (tx, tz). The fields here are
 *  exactly what the durable log records — the deterministic input. */
export interface TileRequest {
  seed: number;
  tx: number;
  tz: number;
  lod: number;
  hints?: Record<string, number>;
}

export interface ClimateSample {
  tempC: number;
  precipMm: number;
  biome: number;
}

/** A pluggable terrain generator. Implementations MUST be deterministic: identical
 *  requests yield byte-identical tiles (so the cache/replay path reproduces the
 *  world without re-running the model). */
export interface TerrainSource {
  /** Stable identifier recorded for provenance (e.g. "procedural", "model:terrain-diffusion-30m"). */
  readonly name: string;
  /** Generate one tile. Deterministic per (seed, lod, tx, tz[, hints]). */
  generateTile(req: TileRequest): TerrainTile | Promise<TerrainTile>;
  /** O(1) point elevation query (snapping/queries). Deterministic per (seed, x, z, lod
   *  [, hints]). The optional `hints` carry the SAME opt-in shaping a region was
   *  generated with, so a point query matches the shaped tiles (sources that don't
   *  shape simply ignore it). */
  sampleHeight(seed: number, x: number, z: number, lod: number, hints?: Record<string, number>): number;
  /** Per-coordinate climate (agent perception). Deterministic per (seed, x, z[, hints]).
   *  The optional `hints` carry the SAME opt-in shaping (incl. per-type climate bias) a
   *  region was generated with, so a point query matches the shaped tiles' biomes;
   *  sources that don't synthesize climate per-point ignore it. */
  sampleClimate(seed: number, x: number, z: number, hints?: Record<string, number>): ClimateSample;
}
