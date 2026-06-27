// Phase 9 — the PROCEDURAL terrain source: a real, shippable, fully deterministic
// value-noise heightmap generator. It is the offline/test implementation of the
// TerrainSource contract (the model is the authoring source; the tile cache is the
// replay source). Determinism is byte-exact: every value is derived from an
// integer hash of the (seed, integer-lattice) coordinates folded through ONLY
// polynomial float ops (multiply/add, smoothstep, lerp) — no Math.sin / pow / and
// no Math.random — so the same request yields a byte-identical tile on any run of
// the same build, which is what makes the cache/replay path reproduce the world.

import {
  CLIMATE_BIOME, CLIMATE_CHANNELS, CLIMATE_PRECIP_MM, CLIMATE_TEMP_C,
  type ClimateSample, type TerrainSource, type TerrainTile, type TileRequest,
} from "./types.ts";

// ---- Tile geometry (the world<->tile-grid mapping the heightfield op consumes) --
/** World-space edge length of one square tile (meters). A tile (tx,tz) spans
 *  world x∈[tx*SIZE, (tx+1)*SIZE], z∈[tz*SIZE, (tz+1)*SIZE]. */
export const TILE_SIZE = 48;
/** Height-sample resolution per tile edge (nrows = ncols). A denser grid gives a
 *  smoother collider surface. */
export const TILE_RES = 33;
/** Vertical scale (meters) the heightfield op multiplies the [0,1] heights by:
 *  surface world Y ∈ [0, HEIGHT_SCALE]. */
export const HEIGHT_SCALE = 12;

/** World-space center + extent of a tile, the exact (origin, scale) the
 *  op_physics_add_heightfield collider is built at. Exported so a host/test can
 *  place an agent at a tile center without re-deriving the mapping. */
export function tilePlacement(tx: number, tz: number): { origin: [number, number, number]; scale: [number, number, number] } {
  return {
    origin: [tx * TILE_SIZE + TILE_SIZE / 2, 0, tz * TILE_SIZE + TILE_SIZE / 2],
    scale: [TILE_SIZE, HEIGHT_SCALE, TILE_SIZE],
  };
}

// ---- Deterministic integer-lattice noise -----------------------------------

/** 32-bit integer hash of an integer lattice cell -> a value in [0,1). Pure
 *  integer ops (Math.imul + xorshift) then a single divide: identical on any
 *  build, no transcendental functions. */
function hashLattice(seed: number, ix: number, iz: number): number {
  let h = seed | 0;
  h = Math.imul(h ^ (ix | 0), 0x27d4eb2d);
  h ^= h >>> 15;
  h = Math.imul(h ^ (iz | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 2D value noise in [0,1]: bilinear interpolation (smoothstep-faded) of four
 *  hashed lattice corners. Continuous and deterministic. */
function valueNoise(seed: number, x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const v00 = hashLattice(seed, ix, iz);
  const v10 = hashLattice(seed, ix + 1, iz);
  const v01 = hashLattice(seed, ix, iz + 1);
  const v11 = hashLattice(seed, ix + 1, iz + 1);
  const ux = smoothstep(fx);
  const uz = smoothstep(fz);
  return lerp(lerp(v00, v10, ux), lerp(v01, v11, ux), uz);
}

/** Fractional Brownian motion: summed value-noise octaves, normalized to [0,1].
 *  Each octave uses a decorrelated seed so layers don't align. */
function fbm(seed: number, x: number, z: number, octaves: number, freq: number): number {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let f = freq;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise((seed + Math.imul(o, 0x9e3779b1)) | 0, x * f, z * f);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

// ---- Field definitions (the actual world's shape + climate) ----------------

const ELEV_BASE_FREQ = 1 / 96; // ~96 m primary landforms
const WARMTH_FREQ = 1 / 320; // broad temperature provinces
const PRECIP_FREQ = 1 / 220; // broad rainfall provinces

/** Elevation in [0,1] at a world coordinate. lod adds high-frequency octaves
 *  (more detail) without changing the coarse shape. Used by BOTH generateTile
 *  (stored raw, scaled by HEIGHT_SCALE in the collider) and sampleHeight. */
function elevation01(seed: number, x: number, z: number, lod: number): number {
  const octaves = 3 + Math.max(0, Math.min(4, lod | 0));
  return fbm(seed | 0, x, z, octaves, ELEV_BASE_FREQ);
}

// ---- OPT-IN rich shaping (deterministic, byte-identical default) -----------
// With NO hints the elevation path above is used VERBATIM, so every existing tile
// is byte-identical to today. When a request carries shaping hints (hints.shape>0),
// generateTile / sampleHeight route through `shapedElevation01` instead, which layers
// three OPT-IN effects on the same value-noise primitives:
//   • domain WARP — displace the sample point by an independent low-freq noise field
//     so landforms meander (organic coastlines/dune fronts) instead of axis-aligned
//     value-noise blobs;
//   • RIDGED multifractal — sharpened inverted-abs octaves blended in for crisp dune
//     ridgelines (a tan dome has none);
//   • island FALLOFF — a radial mask so the landmass rises from the sea floor, crests
//     into dunes, and slopes back down into the water: a real island + beach, not a dome.
// Every op is the SAME pure poly/integer family the base field uses (mul/add/smoothstep/
// lerp + Math.abs/Math.sqrt, both IEEE-correctly-rounded) — no sin/pow/random — so the
// rich path is just as deterministic + replay-safe behind the same seam + tile cache.

/** The parsed shaping recipe (decoded from the numeric `hints` map). */
interface ShapeConfig {
  warpAmp: number;  // world-meter amplitude of the domain warp (0 = off)
  warpFreq: number; // spatial frequency of the warp field
  ridge: number;    // [0,1] blend of ridged dune detail into the smooth base
  cx: number; cz: number; // island centre (world x,z)
  radius: number;   // distance from centre where the beach slope begins (Infinity = no island)
  falloff: number;  // width (m) over which land slopes down to the sea floor
}

const RIDGE_SALT = 0x5bd1e995 | 0;
const WARP_X_SALT = 0x68bc21eb | 0;
const WARP_Z_SALT = 0x02e5be93 | 0;

function clamp01(t: number): number { return t < 0 ? 0 : t > 1 ? 1 : t; }

/** Decode the OPT-IN shaping hints. Returns undefined when shaping is OFF (no hints,
 *  or hints.shape <= 0) so the caller keeps the byte-identical default path. */
function parseShape(hints: Record<string, number> | undefined): ShapeConfig | undefined {
  if (hints === undefined || !(hints.shape > 0)) return undefined;
  return {
    warpAmp: hints.warp ?? 0,
    warpFreq: hints.warpFreq ?? (1 / 130),
    ridge: clamp01(hints.ridge ?? 0),
    cx: hints.islandCx ?? 0,
    cz: hints.islandCz ?? 0,
    radius: hints.islandRadius ?? Infinity,
    falloff: hints.islandFalloff ?? 1,
  };
}

/** Ridged multifractal in [0,1]: each octave is an inverted-abs value-noise crest
 *  (1-|2n-1|), squared to sharpen the ridge, summed + normalized — crisp dune lines. */
function ridgedFbm(seed: number, x: number, z: number, octaves: number, freq: number): number {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let f = freq;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise((seed + Math.imul(o, 0x9e3779b1)) | 0, x * f, z * f);
    let r = 1 - Math.abs(2 * n - 1); // [0,1], peaks where n≈0.5
    r = r * r; // sharpen the crest
    sum += amp * r;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Rich elevation in [0,1]: domain-warped fbm + optional ridged dunes, masked by an
 *  optional radial island falloff. Pure + deterministic (same as elevation01). */
function shapedElevation01(seed: number, x: number, z: number, lod: number, s: ShapeConfig): number {
  const octaves = 3 + Math.max(0, Math.min(4, lod | 0));
  // Domain warp: meander the sample point so landforms aren't axis-aligned blobs.
  let wx = x;
  let wz = z;
  if (s.warpAmp !== 0) {
    const nx = valueNoise((seed ^ WARP_X_SALT) | 0, x * s.warpFreq, z * s.warpFreq);
    const nz = valueNoise((seed ^ WARP_Z_SALT) | 0, x * s.warpFreq, z * s.warpFreq);
    wx = x + (nx - 0.5) * 2 * s.warpAmp;
    wz = z + (nz - 0.5) * 2 * s.warpAmp;
  }
  const base = fbm(seed | 0, wx, wz, octaves, ELEV_BASE_FREQ); // [0,1]
  let e = base;
  if (s.ridge > 0) {
    const dunes = ridgedFbm((seed ^ RIDGE_SALT) | 0, wx, wz, octaves, ELEV_BASE_FREQ * 2); // [0,1]
    e = base * (1 - s.ridge) + dunes * s.ridge; // convex blend → e stays in [0,1]
  }
  // Radial island falloff: 1 inside `radius`, smoothstep down to 0 across `falloff`,
  // so the surface rises from the sea floor into the dunes and slopes back into water.
  if (s.radius !== Infinity) {
    const dx = x - s.cx;
    const dz = z - s.cz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const t = clamp01((dist - s.radius) / (s.falloff <= 0 ? 1 : s.falloff));
    e *= 1 - smoothstep(t); // 1 (land) → 0 (sea floor)
  }
  return e;
}

/** Quantize (temperature, precipitation) into a small biome enum. Stable integer
 *  boundaries so the mapping is exactly reproducible. */
function biomeOf(tempC: number, precipMm: number): number {
  if (tempC < 0) return 0; // 0 polar / ice
  if (precipMm < 250) return tempC > 22 ? 1 : 2; // 1 desert, 2 steppe
  if (precipMm < 1200) return tempC > 18 ? 3 : 4; // 3 savanna/temperate-dry, 4 temperate forest
  return tempC > 20 ? 5 : 6; // 5 tropical rainforest, 6 boreal/wet
}

/** The shippable, deterministic offline terrain source. */
export class ProceduralTerrainSource implements TerrainSource {
  readonly name: string;

  constructor(name = "procedural") {
    this.name = name;
  }

  /** Generate one tile — a byte-identical function of the request. Heights are
   *  the raw [0,1] elevation field (the collider multiplies by scale[1]); a
   *  3-channel climate grid (tempC, precipMm, biome) rides along for perception. */
  generateTile(req: TileRequest): TerrainTile {
    const seed = req.seed | 0;
    const lod = req.lod | 0;
    // OPT-IN shaping: undefined (the default) ⇒ byte-identical to the base field.
    const shape = parseShape(req.hints);
    const { origin, scale } = tilePlacement(req.tx, req.tz);
    const nrows = TILE_RES;
    const ncols = TILE_RES;
    const x0 = req.tx * TILE_SIZE;
    const z0 = req.tz * TILE_SIZE;
    const heights = new Float32Array(nrows * ncols);
    const climateChannels = CLIMATE_CHANNELS;
    const climate = new Float32Array(climateChannels * nrows * ncols);
    for (let r = 0; r < nrows; r++) {
      // rows -> z, cols -> x (the heightfield contract).
      const z = z0 + (r / (nrows - 1)) * TILE_SIZE;
      for (let c = 0; c < ncols; c++) {
        const x = x0 + (c / (ncols - 1)) * TILE_SIZE;
        const e = shape === undefined ? elevation01(seed, x, z, lod) : shapedElevation01(seed, x, z, lod, shape);
        const idx = r * ncols + c;
        heights[idx] = e;
        const cl = this.climateAt(seed, x, z, e);
        const cidx = idx * climateChannels;
        climate[cidx + CLIMATE_TEMP_C] = cl.tempC;
        climate[cidx + CLIMATE_PRECIP_MM] = cl.precipMm;
        climate[cidx + CLIMATE_BIOME] = cl.biome;
      }
    }
    return { nrows, ncols, origin, scale, heights, climate, climateChannels };
  }

  /** O(1) world-space elevation query (snapping/placement). Returns the surface
   *  world Y = elevation[0,1] * HEIGHT_SCALE (origin Y is 0). Passing the SAME
   *  shaping `hints` a region was generated with samples the SHAPED surface (so a
   *  survey/snap matches the rich tiles); omit them for the byte-identical base field. */
  sampleHeight(seed: number, x: number, z: number, lod: number, hints?: Record<string, number>): number {
    const shape = parseShape(hints);
    const e = shape === undefined ? elevation01(seed | 0, x, z, lod | 0) : shapedElevation01(seed | 0, x, z, lod | 0, shape);
    return e * HEIGHT_SCALE;
  }

  /** Per-coordinate climate for agent perception. Deterministic per (seed,x,z). */
  sampleClimate(seed: number, x: number, z: number): ClimateSample {
    return this.climateAt(seed | 0, x, z, elevation01(seed | 0, x, z, 0));
  }

  /** Shared climate model so generateTile and sampleClimate agree exactly. */
  private climateAt(seed: number, x: number, z: number, elev01: number): ClimateSample {
    const warmth = fbm((seed ^ 0x1f1f1f1f) | 0, x, z, 3, WARMTH_FREQ); // [0,1]
    const wet = fbm((seed ^ 0x2c2c2c2c) | 0, x, z, 3, PRECIP_FREQ); // [0,1]
    // Warm in the lowlands, colder with elevation (a fixed lapse), modulated by
    // the broad warmth province.
    const tempC = 4 + warmth * 30 - elev01 * 22;
    const precipMm = wet * 3000;
    return { tempC, precipMm, biome: biomeOf(tempC, precipMm) };
  }
}
