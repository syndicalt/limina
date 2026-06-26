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
  /** Optional climate channels (temp, tempSeasonality, precip, precipCV, …), flat
   *  row-major, length = channels*nrows*ncols. Empty when the source omits it. */
  climate?: Float32Array;
  climateChannels?: number;
}

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
  /** O(1) point elevation query (snapping/queries). Deterministic per (seed, x, z, lod). */
  sampleHeight(seed: number, x: number, z: number, lod: number): number;
  /** Per-coordinate climate (agent perception). Deterministic per (seed, x, z). */
  sampleClimate(seed: number, x: number, z: number): ClimateSample;
}
