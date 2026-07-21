// terrain-heightfield — the PURE, dependency-free ERODED HEIGHTFIELD generator shared by
// the preview pipeline (world/pipeline/terrain.mjs builds a THREE mesh over it) and the
// engine's terrain.create skill (fills an editable tile's heights from it). NO THREE, NO
// DOM — just the base fBm shape → limina's hydraulic + thermal erosion (erosion.mjs) →
// percentile re-normalize → flow accumulation → metres + a coverage-derived sea level.
//
// This is the record/replay spine's generator: the durable log records the GENERATE PARAMS
// (seed/amplitude/…); replay re-runs this PURE function to reconstruct byte-identical heights
// (never the height array). Same config+seed → byte-identical field (no Date/Math.random).

import { erodeBlock, flowAccumulation, DEFAULT_EROSION } from "./erosion.mjs";

// ── deterministic value noise + fBm (verbatim from the terrain pipeline) ──────────
function hash2(ix, iz, seed) { let h = (ix * 374761393 + iz * 668265263 + seed * 2246822519) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
const smooth = (t) => t * t * (3 - 2 * t);
function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed), c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  const ux = smooth(fx), uz = smooth(fz);
  return (a * (1 - ux) + b * ux) * (1 - uz) + (c * (1 - ux) + d * ux) * uz;
}
function fbm(x, z, seed, oct, lac, gain) { let amp = 1, freq = 1, sum = 0, norm = 0; for (let o = 0; o < oct; o++) { sum += amp * (valueNoise(x * freq, z * freq, seed + o * 1013) * 2 - 1); norm += amp; amp *= gain; freq *= lac; } return sum / norm; }

/** Default terrain generation recipe — the canonical eroded-heightfield parameters. */
export const DEFAULT_TERRAIN = {
  seed: 1337, sizeM: 120, gridN: 200,
  noiseScale: 0.02, amplitude: 13,
  octaves: 5, lacunarity: 2.0, gain: 0.5, warp: 0.55,
  seaCoverage: 0.32,   // fraction of the map underwater — sea level is derived to hit this
  seaLevelM: 2.0,      // fallback if seaCoverage is set to undefined
  // Erosion recipe: gentle thermal (higher talus) so it carves channels rather than flattening.
  erosion: { ...DEFAULT_EROSION, rain: 1.5, thermal: 6, talus: 0.04 },
};

/**
 * Generate the eroded heightfield for a square terrain region — PURE.
 *
 * @param {object} overrides  Partial of DEFAULT_TERRAIN (seed, sizeM, gridN, amplitude,
 *                            noiseScale, octaves, lacunarity, gain, warp, seaCoverage,
 *                            seaLevelM, erosion{...}).
 * @returns {{ heights: Float32Array, flow: Float32Array, maxFlow: number,
 *             cols: number, rows: number, step: number, half: number, cfg: object }}
 *          heights are in METRES (0..~amplitude), row-major (index = gz*cols + gx),
 *          rows === cols === gridN+1; cfg.seaLevelM is the coverage-derived sea level.
 */
export function generateHeightfield(overrides = {}) {
  const cfg = { ...DEFAULT_TERRAIN, ...overrides, erosion: { ...DEFAULT_TERRAIN.erosion, ...(overrides.erosion || {}) } };
  const N = cfg.gridN, cols = N + 1, rows = N + 1, half = cfg.sizeM / 2, step = cfg.sizeM / N, s = cfg.noiseScale, seed = cfg.seed | 0;

  // 1. base fBm shape (with domain warp), sampled into a grid + normalized to 0..1.
  const raw = new Float32Array(rows * cols); let mn = Infinity, mx = -Infinity;
  for (let gz = 0; gz < rows; gz++) for (let gx = 0; gx < cols; gx++) {
    const x = -half + gx * step, z = -half + gz * step;
    const wx = x + cfg.warp / s * fbm(x * s * 0.5 + 100, z * s * 0.5, seed + 7, 3, 2, 0.5);
    const wz = z + cfg.warp / s * fbm(x * s * 0.5, z * s * 0.5 + 100, seed + 9, 3, 2, 0.5);
    const n = fbm(wx * s, wz * s, seed, cfg.octaves, cfg.lacunarity, cfg.gain);
    const v = (n * 0.5 + 0.5) ** 1.35;
    raw[gz * cols + gx] = v; if (v < mn) mn = v; if (v > mx) mx = v;
  }
  const inv = 1 / (mx - mn || 1); for (let i = 0; i < raw.length; i++) raw[i] = (raw[i] - mn) * inv;

  // 2. EROSION (normalized units) — carves channels. Then PERCENTILE-CLAMP re-normalize:
  //    erosion sinks the field AND can leave an outlier deposit spike; stretch the 2nd..98th
  //    percentile to 0..1 → full, well-distributed relief without one spike crushing everything.
  const eroded = erodeBlock(raw, rows, cols, seed, cfg.erosion);
  const sortedE = Float32Array.from(eroded).sort();
  const plo = sortedE[Math.floor(sortedE.length * 0.02)], phi = sortedE[Math.floor(sortedE.length * 0.98)];
  const einv = 1 / (phi - plo || 1);
  for (let i = 0; i < eroded.length; i++) eroded[i] = Math.max(0, Math.min(1, (eroded[i] - plo) * einv));

  // 3. flow accumulation (rivers) on the final shape.
  const flow = flowAccumulation(eroded, rows, cols);
  let maxFlow = 1; for (let i = 0; i < flow.length; i++) if (flow[i] > maxFlow) maxFlow = flow[i];

  // scale normalized field → metres.
  const heights = new Float32Array(eroded.length); for (let i = 0; i < eroded.length; i++) heights[i] = eroded[i] * cfg.amplitude;
  // SEA LEVEL by target coverage (robust to the eroded distribution); absolute seaLevelM is the fallback.
  if (cfg.seaCoverage !== undefined) { const hs = Float32Array.from(heights).sort(); cfg.seaLevelM = hs[Math.min(hs.length - 1, Math.floor(cfg.seaCoverage * hs.length))]; }

  return { heights, flow, maxFlow, cols, rows, step, half, cfg };
}

/** Resample a row-major heightfield onto a DIFFERENT square grid resolution by bilinear
 *  sampling — so an editable tile of `outN`×`outN` vertices over the same `sizeM` reads the
 *  same surface the native gridN produced. Deterministic (pure arithmetic). Returns a
 *  Float32Array of length outN*outN, row-major (index = r*outN + c), metres. */
export function resampleHeightfield(heights, cols, rows, half, step, outN) {
  const out = new Float32Array(outN * outN);
  const size = 2 * half;
  const outStep = size / (outN - 1);
  for (let r = 0; r < outN; r++) {
    for (let c = 0; c < outN; c++) {
      const x = -half + c * outStep, z = -half + r * outStep;
      let gx = (x + half) / step, gz = (z + half) / step;
      gx = Math.max(0, Math.min(cols - 1.0001, gx)); gz = Math.max(0, Math.min(rows - 1.0001, gz));
      const ix = Math.floor(gx), iz = Math.floor(gz), fx = gx - ix, fz = gz - iz, i = iz * cols + ix;
      out[r * outN + c] = heights[i] * (1 - fx) * (1 - fz) + heights[i + 1] * fx * (1 - fz) + heights[i + cols] * (1 - fx) * fz + heights[i + cols + 1] * fx * fz;
    }
  }
  return out;
}
