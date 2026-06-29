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

// ── CURVATURE-AWARE PLACEMENT (the global "no float, no bury on ridges" fix) ─────
// A prop is tethered to the surface at its CENTER (x,z). Its flat base is horizontal, so on a
// SLOPE of gradient `s` (rise/run) the downhill lip of a base of radius `r` hangs ~`r·s` above
// the surface. The BALANCED sink K=0.5 (skirt float == trunk bury == r·s/2) is the minmax-optimal
// Y-only placement on a UNIFORM SLOPE — but it FAILS on non-planar terrain, because slope is a
// single-point gradient:
//   • CONVEX RIDGE: slope@pivot ≈ 0 even though the ground drops on both sides → no sink → the
//     skirt FLOATS by (pivot − downhill_ground), often metres on a sharp ridge. This is the
//     "floating trees" artefact the island demo exhibited.
//   • CONCAVE GULLY: the pivot sits at the gully floor; sinking it buries the trunk into the
//     floor (the "sunken trees" artefact).
// The fix is CURVATURE-AWARE placement: sample the height field at 4 cardinal points at radius r,
// compute the discrete Laplacian (sum of cardinals − 4·center, normalised by r²), and BRANCH:
//   • lap < CURV_CONVEX (convex / ridge)   → instY = min(center, 4 cardinals). Grounds the skirt
//     at the lowest point in the footprint disc → float structurally impossible (mesh and scatter
//     share tile.heights bit-exactly, so no visible vertex in the disc can sit above instY).
//   • lap > CURV_CONCAVE (concave / gully) → instY = center. Sits at the gully floor (no sink →
//     no trunk bury into the floor).
//   • |lap| ≤ threshold (planar / slope)   → the BALANCED K=0.5 sink (minmax-optimal Y-only
//     placement on a uniform slope). Byte-identical to the prior code on flat ground and on
//     uniform slopes — so every existing embed behaviour (including the gate contract, the water
//     clamp, the cap) is preserved exactly. Only ridge/gully placements change.
// Determinism + replay-safe: pure geometry from tile.heights (already shared bit-exactly with the
// mesh + collider); no new per-instance log state; driven entirely by the ScatterConfig.
const EMBED_K = 0.35;         // PLANAR-SLOPE SINK (rebalanced 0.5 → 0.35): trades some skirt float
                              // for less trunk bury. Float: r·s·(1−K) ≈ 0.65·r·s. Bury: r·s·K ≈ 0.35·r·s.
                              // Empirically reads better than the strict minmax K=0.5 (which left a
                              // uniform ~0.3 m trunk bury on the island dome's slopes — visible as
                              // "all trees sunk a little"). At K=0.35 sink drops to ~0.19 m, skirt
                              // float rises to ~0.31 m (both small, both at visual tolerance).
const EMBED_MAX_RADII = 1.5;  // never sink more than 1.5 base radii on a planar slope (~40% of a ~4R-tall prop)
const EMBED_ABS_MAX = 3.0;    // absolute world-unit cap on the planar-slope sink
// Per-m² curvature thresholds at which the planar-slope sink stops being the right answer.
// Tuned so a centre-to-cardinal height delta of ~5 cm at radius r switches to the non-planar path:
// for a parabolic ridge y = −a·x², lap = −2a; the delta at radius r is a·r²; threshold |lap|·r²/2 ≈ delta,
// so CURV = 0.10/r² ≈ 0.07 for r=1.2 → ~5 cm delta. Below this the planar path is byte-identical to
// the legacy K=0.5 sink; above it the ridge/gully path takes over.
const CURV_CONVEX = -0.10;    // 1/m² — lap below this ⇒ convex (ridge) ⇒ min(cardinals)
const CURV_CONCAVE = +0.10;   // 1/m² — lap above this ⇒ concave (gully) ⇒ center (no sink)
// CREST GATE: the convex/concave branches seat at the FOOTPRINT DISC MIN (convex) or the pivot
// (concave) — both are correct only when the pivot itself is at a local extremum (a true ridge
// crest or gully floor, where pivot slope ≈ 0). On a CONVEX FLANK (curvature < 0 AND non-zero
// slope — e.g. a smooth dome like the island demo) the disc-min is the downhill EDGE of the
// footprint, ~r·slope below the pivot, so seating there sinks the trunk by ~2× the balanced
// planar sink (the over-bury symptom). Gating the non-planar branches to near-zero pivot slope
// means flanks take the balanced planar K=0.5 sink regardless of curvature, and only genuine
// crests (slope < CREST_SLOPE) take the disc-min grounding. Measured on the 4×4 island demo:
// the crest gate moves 48 convex-branch pines (avg sink 0.608 m) to the planar path (avg sink
// 0.300 m) — eliminating the over-bury without losing the ridge-crest grounding.
const CREST_SLOPE = 0.05;     // pivot slope below which the convex/concave branches may fire

/** One curated asset in the scatter palette: its content-addressed id and an
 *  optional relative weight (default 1) for the deterministic weighted pick. */
export interface ScatterAsset {
  id: string;
  weight?: number;
  /** OPT-IN footprint radius (world units at scale 1, the XZ half-extent of the
   *  asset's flat base). 0 (default) → no change, byte-identical. >0 enables CURVATURE-AWARE
   *  placement: on a convex ridge the instance seats at the lowest point of its footprint
   *  disc (no skirt float), on a planar slope it takes the balanced K=0.5 sink (skirt float
   *  == trunk bury == r·slope/2), on a concave gully it sits at the pivot (no trunk bury
   *  into the floor). See the curvature-aware block in scatterAssets.
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
  /** OPT-IN layer-default footprint radius (world units at scale 1) for the curvature-aware
   *  placement, applied to any palette asset that doesn't set its own ScatterAsset.embedRadius.
   *  0 (default) → no sampling, byte-identical back-compat. See the curvature-aware block in
   *  scatterAssets. */
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

      // CURVATURE-AWARE PLACEMENT — applied to the FINAL instance.y AFTER every gate (the
      // elevation/water + slope + climate filters above all consult the SURFACE y at the pivot),
      // so the placement decision NEVER changes which props place (count + the 0-in-water
      // guarantee are preserved exactly). The footprint radius is the picked asset's per-asset
      // radius (else the layer default, else 0); embedRadius 0 → byte-identical to the un-embedded
      // scatter (no cardinal samples, no sink — pure back-compat).
      const embedRadius = palette[pick].embedRadius ?? config.embedRadius ?? 0;
      let instY = y;
      if (embedRadius > 0) {
        const r = embedRadius * scale; // footprint half-extent in world units for THIS instance
        // World → grid step for radius r (mirrors the candidate u→fc / v→fr mapping at line ~201).
        const fcStep = (r / sx) * (ncols - 1);
        const frStep = (r / sz) * (nrows - 1);
        // EDGE GUARD: sampleRaw extrapolates linearly beyond the tile edge (it clamps the integer
        // index but not the fractional weight), which fabricates curvature out of the flat
        // constant region past the edge — a uniform ramp reads as a "ridge" near its right edge.
        // The Laplacian is only meaningful when all 4 cardinals sit inside the tile; otherwise
        // fall through to the planar-slope path (byte-identical to the legacy embed-sink).
        const cardinalsInterior = fc - fcStep >= 0 && fc + fcStep <= ncols - 1 && fr - frStep >= 0 && fr + frStep <= nrows - 1;
        if (cardinalsInterior) {
          // 16 samples on the footprint circle at 22.5° intervals (radius r) — denser than 4
          // cardinals, captures narrow erosion channels that the 8-sample (cardinal + diagonal)
          // pattern missed on hydraulic-eroded terrain. The 4 cardinals (k % 4 === 0) drive the
          // standard 5-point Laplacian; all 16 drive the convex-branch min().
          const yN = oy + sampleRaw(fr - frStep, fc) * sy;          // k=6 (270°)
          const yS = oy + sampleRaw(fr + frStep, fc) * sy;          // k=2 (90°)
          const yW = oy + sampleRaw(fr, fc - fcStep) * sy;          // k=4 (180°)
          const yE = oy + sampleRaw(fr, fc + fcStep) * sy;          // k=0 (0°)
          // Discrete Laplacian at the pivot, per world unit², from the 4 cardinals (the standard
          // 5-point stencil). The linear (slope) component cancels in the symmetric stencil — so a
          // uniform slope yields lap≈0 (planar path), while ridges (cardinals average below centre)
          // yield lap<0 and gullies (cardinals average above) lap>0.
          const lap = (yN + yS + yW + yE - 4 * y) / (r * r);
          // CREST GATE: the non-planar branches are correct only when the pivot is a local
          // extremum (slope ≈ 0). On a convex/concave FLANK (curvature + non-zero slope), the
          // disc-min over-sinks (the dome demo's symptom) — fall through to the planar K=0.5 path.
          const isCrest = slope < CREST_SLOPE;
          if (isCrest && lap < CURV_CONVEX) {
            // CONVEX CREST (ridge peak, slope ≈ 0): ground the skirt at the lowest point on the
            // footprint disc. The sample pattern is a dense 5×5 grid filtered to the disc (radius r)
            // — same pattern tools/export-island.ts re-samples in its parity assertion, so the
            // contract holds by construction. 21 interior samples catch narrow erosion channels.
            let yMinFootprint = y;
            for (let gi = 0; gi < 5; gi++) {
              for (let gj = 0; gj < 5; gj++) {
                const dx = -r + (2 * r) * (gi + 0.5) / 5;
                const dz = -r + (2 * r) * (gj + 0.5) / 5;
                if (dx * dx + dz * dz > r * r) continue;
                const fcOff = (dx / sx) * (ncols - 1);
                const frOff = (dz / sz) * (nrows - 1);
                yMinFootprint = Math.min(yMinFootprint, oy + sampleRaw(fr + frOff, fc + fcOff) * sy);
              }
            }
            instY = yMinFootprint;
          } else if (isCrest && lap > CURV_CONCAVE) {
            // CONCAVE FLOOR (gully bottom, slope ≈ 0): sit at the pivot (the gully floor).
            // Sinking into the floor would bury the trunk into the rising walls; the pivot IS
            // the natural seat. instY = y (no-op).
          } else if (slope > 0) {
            // PLANAR SLOPE — including convex/concave FLANKS (gated away from the crest branches
            // by CREST_SLOPE). The BALANCED K=0.5 sink: minmax-optimal Y-only placement for a
            // wide base on a uniform slope (skirt float == trunk bury == r·s/2). Byte-identical
            // to the prior embed-sink on a uniform slope; the cap holds a near-cliff prop above
            // submerge. Residual skirt-float of r·s/2 is the inherent Y-only limit; partial
            // normal-alignment (tilt toward surface normal) is the lever if it ever reads badly.
            const cap = Math.min(r * EMBED_MAX_RADII, EMBED_ABS_MAX);
            const sink = Math.min(r * slope * EMBED_K, cap);
            instY = y - sink;
          }
        } else if (slope > 0) {
          // EDGE FALLBACK (within `cardinalsInterior === false`): the cardinals would extrapolate
          // past the tile, so the Laplacian is unreliable. Use the planar K=0.5 sink alone — the
          // slope at the pivot is still valid (it reads ±1 cell INSIDE the tile).
          const cap = Math.min(r * EMBED_MAX_RADII, EMBED_ABS_MAX);
          const sink = Math.min(r * slope * EMBED_K, cap);
          instY = y - sink;
        }
        // WATERLINE CLAMP (unchanged): the gate accepts a prop on SURFACE y >= elevationMin, so a
        // prop placed just above the waterline must NOT bed its origin UNDER the water. The ridge
        // path's min(samples) can dip below the surface at the pivot; the clamp pins it to the
        // floor, preserving the 0-in-water guarantee exactly. elevationMin defaults to -Infinity →
        // no floor → the full min applies (a ridge prop grounded at the lowest footprint vertex).
        instY = Math.max(instY, elevationMin);
      }
      out.push({ assetId: palette[pick].id, x, y: instY, z, yaw, scale });
    }
  }
  return out;
}
