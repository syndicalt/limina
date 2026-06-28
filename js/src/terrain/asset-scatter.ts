// Phase 11 — deterministic ASSET scatter. The sibling of scatterProps (scatter.ts),
// but instead of a fixed PropKind enum it places CURATED, content-addressed assets
// BY ID across a region, under an agent-set ScatterConfig. Like the prop scatter it
// is a PURE function of (tile, seed, config): a per-tile seeded RNG walks a jittered
// candidate grid, reads each point's surface height + local slope + climate from the
// tile's OWN fields, and emits an instance only where the config's rules allow.
//
// THE PHASE-9 GAP IT CLOSES: the tile's height + climate grid drive the placement
// RULES (a tree-line `elevationMax`, a `slopeMax`, optional biome/temperature gates)
// — fields that were carried but UNUSED. The rules are falsifiable: a low tree line
// demonstrably excludes the high candidates; loosen it and they reappear.
//
// DETERMINISM / REPLAY (same contract as scatterProps + asset.place): identical
// (tile, seed, config) -> byte-identical instances. The durable log records the
// ScatterConfig REQUEST (+ pinned asset hashes), NEVER the instance transforms; a
// replay recomputes the exact placements from the config over the same deterministic
// tiles. RNG draws are issued in a FIXED order per candidate REGARDLESS of whether
// the candidate is accepted, so loosening a threshold yields a strict SUPERSET of the
// instances (the tighter run is reproducible inside the looser one).

import { CLIMATE_BIOME, CLIMATE_CHANNELS, CLIMATE_TEMP_C, type TerrainTile } from "./types.ts";
import { hashSeed, mulberry32 } from "./scatter.ts";

// ── EMBED-SINK (slope-aware vertical tether) ────────────────────────────────────
// A prop is tethered to the surface at its CENTER (x,z). Its flat base is horizontal,
// so on a slope of gradient `s` (rise/run) the downhill lip of a base of radius `r`
// hangs ~`r·s` above the surface (the "floating trees" artefact). But the curated trees
// are WIDE GROUND-TOUCHING CONES (the foliage skirt reaches the ground, base radius ~1.2–1.3),
// not thin trunks — so fully grounding the downhill lip (sink = r·s) buries the TRUNK by r·s,
// which reads as "sunken" trees on a slope. There is no perfect Y-only fix for a wide cone, so
// use the BALANCED sink K=0.5: sinking by r·s/2 makes the downhill-skirt float (r·s − sink) and
// the trunk bury (sink) EQUAL, each r·s/2 — minimizing the worst-case mismatch instead of
// trading a floating skirt for a buried trunk. (Trees are also kept off the steepest slopes via
// the catalog tree slopeMax, where even the balanced sink leaves a visible mismatch.) The sink
// is capped so a near-cliff prop can't submerge. Pure geometry from the slope already computed
// per candidate — deterministic + replay-safe (no new per-instance log state; driven by config).
const EMBED_K = 0.5;          // BALANCED: skirt float (r·s/2) == trunk bury (r·s/2), min worst-case
const EMBED_MAX_RADII = 1.5;  // never sink more than 1.5 base radii (~40% of a ~4R-tall prop)
const EMBED_ABS_MAX = 3.0;    // absolute world-unit cap on the sink

/** One curated asset in the scatter palette: its content-addressed id and an
 *  optional relative weight (default 1) for the deterministic weighted pick. */
export interface ScatterAsset {
  id: string;
  weight?: number;
  /** OPT-IN footprint radius (world units at scale 1, the XZ half-extent of the
   *  asset's flat base). 0 (default) → no change, byte-identical. >0 sinks the
   *  instance into a slope so its downhill base lip stays grounded instead of
   *  floating ~`radius·slope` above the surface (see the embed-sink in scatterAssets).
   *  Per-asset; overrides the layer-default ScatterConfig.embedRadius. */
  embedRadius?: number;
}

/** An agent-set scatter recipe. Pure data — recorded verbatim in the world log as
 *  the request (never the resulting instances). */
export interface ScatterConfig {
  /** Scatter salt: folded with the world seed + tile origin so the same config
   *  reproduces identical placements and a different seed reshuffles them. */
  seed: number;
  /** Candidate samples per axis across each tile (placement density). Default 16. */
  density?: number;
  /** The curated asset palette (>=1). Weighted, deterministic pick per candidate. */
  assets: ScatterAsset[];
  /** Inclusive world-Y floor: no assets below this elevation (e.g. above water). */
  elevationMin?: number;
  /** Inclusive world-Y ceiling — the TREE LINE: no assets above this elevation. */
  elevationMax?: number;
  /** Max local slope (rise/run); steeper candidates are excluded (e.g. cliffs). */
  slopeMax?: number;
  /** Uniform scale range [min,max] sampled per instance. Default [0.8, 1.2]. */
  sizeRange?: [number, number];
  /** Fraction of passing candidates actually placed (sparser cover). Default 1. */
  coverage?: number;
  /** OPT-IN clumping strength [0,1]. 0 (default) = the legacy uniform grid (byte-
   *  identical). >0 modulates acceptance by a low-frequency deterministic noise field
   *  so instances gather into natural clusters (palm groves) instead of an even spread.
   *  Purely spatial — it never changes the per-candidate RNG draw ORDER, so the
   *  superset/replay guarantees hold (a looser elevation/slope rule still yields a
   *  strict superset). */
  cluster?: number;
  /** World-space frequency of the cluster field (smaller = larger clumps). Default 1/26. */
  clusterFreq?: number;
  /** OPT-IN layer-default footprint radius (world units at scale 1) for the embed-sink,
   *  applied to any palette asset that doesn't set its own ScatterAsset.embedRadius.
   *  0 (default) → no sink, byte-identical back-compat. See the embed-sink in scatterAssets. */
  embedRadius?: number;
  /** Optional biome whitelist (reads the tile climate grid's biome channel). */
  biomes?: number[];
  /** Optional inclusive temperature window (reads the climate grid's tempC channel). */
  tempMin?: number;
  tempMax?: number;
}

/** One placed asset instance. `y` is the terrain surface at (x,z). Serializable,
 *  but NEVER serialized into the log — recomputed from the config on replay. */
export interface AssetInstance {
  assetId: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

/** Fold the world seed + the config's scatter salt into one 32-bit base seed, so
 *  BOTH influence placement (a new world seed OR a new config seed reshuffles). */
function baseSeed(seed: number, configSeed: number): number {
  return (Math.imul((seed | 0) ^ 0x9e3779b1, 0x85ebca77) ^ (configSeed | 0)) >>> 0;
}

/** Smooth deterministic value noise in [0,1] for the cluster mask. Built on the same
 *  integer hashSeed lattice (no transcendentals) so it is bit-identical across engines
 *  — the clumping reproduces exactly on replay/browser playback like every placement. */
function clusterNoise(seed: number, x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const corner = (cx: number, cz: number): number => hashSeed(seed, cx, cz) / 4294967296;
  const v00 = corner(ix, iz), v10 = corner(ix + 1, iz);
  const v01 = corner(ix, iz + 1), v11 = corner(ix + 1, iz + 1);
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const top = v00 + (v10 - v00) * ux;
  const bot = v01 + (v11 - v01) * ux;
  return top + (bot - top) * uz;
}

/**
 * Scatter curated assets over a single tile under `config`. Deterministic:
 * identical (tile, seed, config) -> identical instances.
 *
 * Elevation/slope/climate AWARE: each candidate's world-Y elevation + local slope
 * come from the tile's heights, and (when gated) its biome/temperature come from the
 * tile's climate grid — a candidate is placed only when it passes every configured
 * rule. With no rules set, density + coverage alone govern placement.
 */
export function scatterAssets(tile: TerrainTile, seed: number, config: ScatterConfig): AssetInstance[] {
  const palette = config.assets;
  if (palette.length === 0) return [];
  const weights = palette.map((a) => Math.max(0, a.weight ?? 1));
  const totalW = weights.reduce((s, w) => s + w, 0);
  if (totalW <= 0) return [];

  const density = config.density ?? 16;
  const elevationMin = config.elevationMin ?? -Infinity;
  const elevationMax = config.elevationMax ?? Infinity;
  const slopeMax = config.slopeMax ?? Infinity;
  const coverage = config.coverage ?? 1;
  const cluster = config.cluster ?? 0;
  const clusterFreq = config.clusterFreq ?? (1 / 26);
  // The cluster mask reshuffles with the world+config seed (independent salt) so it
  // doesn't lock to the candidate RNG stream.
  const clusterSeed = (baseSeed(seed, config.seed) ^ 0x7f4a7c15) | 0;
  const [sizeLo, sizeHi] = config.sizeRange ?? [0.8, 1.2];
  const wantClimate = config.biomes !== undefined || config.tempMin !== undefined || config.tempMax !== undefined;

  const [ox, oy, oz] = tile.origin;
  const [sx, sy, sz] = tile.scale;
  const { nrows, ncols, heights } = tile;
  const channels = tile.climateChannels ?? 0;
  const climate = tile.climate;
  if (wantClimate && (climate === undefined || channels === 0)) {
    throw new Error("scatterAssets: config requests a climate rule (biome/temperature) but the tile carries no climate grid");
  }
  // Read biome/temperature by the TerrainTile climate CONTRACT (CLIMATE_* offsets),
  // not a hard-coded index — so a model source emitting the documented layout reads
  // correctly. Assert the declared channel count matches the contract, else a
  // differently-packed grid would be silently mis-read (fail loudly instead).
  if (wantClimate && channels !== CLIMATE_CHANNELS) {
    throw new Error(`scatterAssets: tile climate has ${channels} channels but the climate rule expects the ${CLIMATE_CHANNELS}-channel [tempC, precipMm, biome] contract`);
  }

  const rng = mulberry32(hashSeed(baseSeed(seed, config.seed), Math.round(ox), Math.round(oz)));

  // Bilinear raw height at fractional grid (fr along z/rows, fc along x/cols) — the
  // SAME surface the mesh + heightfield collider use, so instances sit ON the ground.
  const sampleRaw = (fr: number, fc: number): number => {
    const r0 = Math.min(nrows - 1, Math.max(0, Math.floor(fr)));
    const c0 = Math.min(ncols - 1, Math.max(0, Math.floor(fc)));
    const r1 = Math.min(nrows - 1, r0 + 1), c1 = Math.min(ncols - 1, c0 + 1);
    const tr = fr - r0, tc = fc - c0;
    const h = (r: number, c: number): number => heights[r * ncols + c];
    const top = h(r0, c0) * (1 - tc) + h(r0, c1) * tc;
    const bot = h(r1, c0) * (1 - tc) + h(r1, c1) * tc;
    return top * (1 - tr) + bot * tr;
  };

  // World run spanned by a ±1 grid sample (for slope = rise/run).
  const runX = ((sx / Math.max(1, ncols - 1)) * 2) || 1;
  const runZ = ((sz / Math.max(1, nrows - 1)) * 2) || 1;

  const out: AssetInstance[] = [];
  for (let i = 0; i < density; i++) {
    for (let j = 0; j < density; j++) {
      // Jittered candidate within this cell. RNG draw ORDER below is FIXED for every
      // candidate (drawn before any filter decision) so a loosened threshold yields a
      // strict superset of placements.
      const u = (i + rng()) / density; // across x
      const v = (j + rng()) / density; // across z
      const fc = u * (ncols - 1);
      const fr = v * (nrows - 1);
      const x = ox - sx / 2 + u * sx;
      const z = oz - sz / 2 + v * sz;
      const y = oy + sampleRaw(fr, fc) * sy;
      // Local slope (rise/run) from neighbouring samples, in world units. sqrt (not
      // Math.hypot) keeps the recompute bit-identical across engines (see scatter.ts).
      const dC = (sampleRaw(fr, Math.min(ncols - 1, fc + 1)) - sampleRaw(fr, Math.max(0, fc - 1))) * sy;
      const dR = (sampleRaw(Math.min(nrows - 1, fr + 1), fc) - sampleRaw(Math.max(0, fr - 1), fc)) * sy;
      const ax = dC / runX, az = dR / runZ;
      const slope = Math.sqrt(ax * ax + az * az);

      // Fixed-order draws (independent of acceptance): coverage, asset pick, yaw, size.
      const coverRoll = rng();
      const pickRoll = rng();
      const yaw = rng() * Math.PI * 2;
      const sizeT = rng();

      // Weighted deterministic asset pick.
      let acc = pickRoll * totalW;
      let pick = palette.length - 1;
      for (let k = 0; k < weights.length; k++) {
        if (acc < weights[k]) { pick = k; break; }
        acc -= weights[k];
      }
      const scale = sizeLo + sizeT * (sizeHi - sizeLo);

      // --- RULES: consult the tile's height + climate fields --------------------
      // OPT-IN clumping: bias the coverage threshold by a low-freq spatial mask so
      // placements gather into groves (hotspots pass; gaps thin out). cluster=0 leaves
      // effCoverage === coverage (byte-identical to the uniform path).
      let effCoverage = coverage;
      if (cluster > 0) {
        const cm = clusterNoise(clusterSeed, x * clusterFreq, z * clusterFreq); // [0,1]
        const hot = cm * cm * (3 - 2 * cm); // smootherstep-ish emphasis of the hotspots
        effCoverage = coverage * ((1 - cluster) + cluster * hot * 2); // mean ≈ coverage
      }
      if (coverRoll > effCoverage) continue;
      if (y < elevationMin || y > elevationMax) continue; // tree line / water line (heights)
      if (slope > slopeMax) continue; // cliffs (heights)
      if (wantClimate) {
        const r = Math.min(nrows - 1, Math.max(0, Math.round(fr)));
        const c = Math.min(ncols - 1, Math.max(0, Math.round(fc)));
        const cidx = (r * ncols + c) * channels;
        const tempC = climate![cidx + CLIMATE_TEMP_C];
        const biome = climate![cidx + CLIMATE_BIOME];
        if (config.biomes !== undefined && !config.biomes.includes(biome)) continue;
        if (config.tempMin !== undefined && tempC < config.tempMin) continue;
        if (config.tempMax !== undefined && tempC > config.tempMax) continue;
      }

      // EMBED-SINK — applied to the FINAL instance.y AFTER every gate (the elevation/
      // water + slope + climate filters above all consult the SURFACE y), so sinking a
      // prop into the slope NEVER pulls it through the water line or changes which props
      // place (count + the 0-in-water guarantee are preserved). The sink is the picked
      // asset's footprint (per-asset radius, else the layer default, else 0) scaled by the
      // instance scale and the local slope; embedRadius 0 → instY === y (byte-identical).
      const embedRadius = palette[pick].embedRadius ?? config.embedRadius ?? 0;
      let instY = y;
      if (embedRadius > 0 && slope > 0) {
        const r = embedRadius * scale; // footprint half-extent in world units for THIS instance
        const cap = Math.min(r * EMBED_MAX_RADII, EMBED_ABS_MAX);
        const sink = Math.min(r * slope * EMBED_K, cap);
        // Clamp the sunk origin to the lower elevation/water floor: the gate accepts a prop on
        // SURFACE y >= elevationMin, so a prop placed just above the waterline must NOT bed its
        // origin UNDER the water. Near the floor the sink simply shortens (the downhill lip
        // floats a touch) instead of submerging — the 0-in-water guarantee is preserved exactly.
        // elevationMin defaults to -Infinity (no floor) → the full sink applies. For a ZERO-margin
        // water gate the clamp may seat a base AT the waterline (elevationMin); that's acceptable
        // (e.g. driftwood at the shore), and any dry margin lifts it clear.
        instY = Math.max(y - sink, elevationMin);
      }
      out.push({ assetId: palette[pick].id, x, y: instY, z, yaw, scale });
    }
  }
  return out;
}
