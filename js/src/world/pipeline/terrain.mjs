// PIPELINE STAGE 2 — TERRAIN (eroded). Base fBm heightfield → limina's hydraulic + thermal EROSION
// (erosion.mjs, ported from js/src/terrain) which carves drainage valleys/channels — so the WATER
// stage has interesting geography to pool + flow through. Grid-based: the eroded heightfield IS the
// mesh vertices, and heightAt/flowAt/slopeAt bilinear-sample that same grid, so every downstream
// stage (water form, river routing, vegetation + structure seating) agrees on the surface.
// Deterministic: same config+seed → byte-identical terrain (no Date/Math.random).
import * as THREE from "three";
import { erodeBlock, flowAccumulation, DEFAULT_EROSION } from "./erosion.mjs";

// ── deterministic value noise + fBm ─────────────────────────────────────────────
function hash2(ix, iz, seed) { let h = (ix * 374761393 + iz * 668265263 + seed * 2246822519) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
const smooth = (t) => t * t * (3 - 2 * t);
function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed), c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  const ux = smooth(fx), uz = smooth(fz);
  return (a * (1 - ux) + b * ux) * (1 - uz) + (c * (1 - ux) + d * ux) * uz;
}
function fbm(x, z, seed, oct, lac, gain) { let amp = 1, freq = 1, sum = 0, norm = 0; for (let o = 0; o < oct; o++) { sum += amp * (valueNoise(x * freq, z * freq, seed + o * 1013) * 2 - 1); norm += amp; amp *= gain; freq *= lac; } return sum / norm; }

export const DEFAULT_TERRAIN = {
  seed: 1337, sizeM: 120, gridN: 200,
  noiseScale: 0.02, amplitude: 13,
  octaves: 5, lacunarity: 2.0, gain: 0.5, warp: 0.55,
  seaCoverage: 0.32,   // fraction of the map underwater — sea level is derived to hit this
  seaLevelM: 2.0,      // fallback if seaCoverage is set to undefined
  // Erosion recipe: gentle thermal (higher talus) so it carves channels rather than flattening.
  erosion: { ...DEFAULT_EROSION, rain: 1.5, thermal: 6, talus: 0.04 },
};

const COL = { sand: new THREE.Color(0xc4b68e), grass: new THREE.Color(0x5f7f3c), grassDark: new THREE.Color(0x44602a), rock: new THREE.Color(0x736b60), snow: new THREE.Color(0xe2e7ec) };

export function generateTerrain(overrides = {}) {
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

  // 2. EROSION (normalized units) — carves channels. Then RE-NORMALIZE: erosion shifts the whole
  //    field down (material moves out), so re-stretch to 0..1 to keep full relief — erosion shapes
  //    the geography (valleys/channels) without sinking everything below sea level.
  const eroded = erodeBlock(raw, rows, cols, seed, cfg.erosion);
  // PERCENTILE-CLAMP re-normalize: erosion sinks the field AND can leave an outlier deposit spike
  // that would dominate min-max. Stretch the 2nd..98th percentile to 0..1 → full, well-distributed
  // relief without one spike crushing everything else low.
  const sortedE = Float32Array.from(eroded).sort();
  const plo = sortedE[Math.floor(sortedE.length * 0.02)], phi = sortedE[Math.floor(sortedE.length * 0.98)];
  const einv = 1 / (phi - plo || 1);
  for (let i = 0; i < eroded.length; i++) eroded[i] = Math.max(0, Math.min(1, (eroded[i] - plo) * einv));
  // 3. flow accumulation (rivers) on the final shape.
  const flow = flowAccumulation(eroded, rows, cols);
  let maxFlow = 1; for (let i = 0; i < flow.length; i++) if (flow[i] > maxFlow) maxFlow = flow[i];

  // scale normalized field → metres.
  const heights = new Float32Array(eroded.length); for (let i = 0; i < eroded.length; i++) heights[i] = eroded[i] * cfg.amplitude;
  // SEA LEVEL by target coverage: pick the level so a fixed fraction of the map is underwater,
  // robust to whatever height distribution erosion produced. (Absolute seaLevelM is the fallback.)
  if (cfg.seaCoverage !== undefined) { const hs = Float32Array.from(heights).sort(); cfg.seaLevelM = hs[Math.min(hs.length - 1, Math.floor(cfg.seaCoverage * hs.length))]; }

  // bilinear samplers over the grid (world x,z → grid).
  const sample = (grid, x, z) => {
    let gx = (x + half) / step, gz = (z + half) / step;
    gx = Math.max(0, Math.min(cols - 1.0001, gx)); gz = Math.max(0, Math.min(rows - 1.0001, gz));
    const ix = Math.floor(gx), iz = Math.floor(gz), fx = gx - ix, fz = gz - iz, i = iz * cols + ix;
    return grid[i] * (1 - fx) * (1 - fz) + grid[i + 1] * fx * (1 - fz) + grid[i + cols] * (1 - fx) * fz + grid[i + cols + 1] * fx * fz;
  };
  const heightAt = (x, z) => sample(heights, x, z);
  const slopeAt = (x, z) => { const hx = heightAt(x + step, z) - heightAt(x - step, z), hz = heightAt(x, z + step) - heightAt(x, z - step); return Math.hypot(hx, hz) / (2 * step); };
  const flowAt = (x, z) => sample(flow, x, z) / maxFlow; // 0..1 river-ness

  // 4. mesh from the grid.
  const verts = new Float32Array(rows * cols * 3), colors = new Float32Array(rows * cols * 3), c = new THREE.Color();
  for (let gz = 0; gz < rows; gz++) for (let gx = 0; gx < cols; gx++) {
    const idx = gz * cols + gx, x = -half + gx * step, z = -half + gz * step, y = heights[idx];
    verts[idx * 3] = x; verts[idx * 3 + 1] = y; verts[idx * 3 + 2] = z;
    const slope = Math.min(1, slopeAt(x, z) * 1.2);
    if (y < cfg.seaLevelM + 0.6) c.copy(COL.sand);
    else if (y > cfg.amplitude * 0.82) c.copy(COL.snow);
    else c.copy(COL.grass).lerp(COL.grassDark, (Math.sin((x + z) * 0.2) * 0.5 + 0.5) * 0.3);
    if (slope > 0.4 && y >= cfg.seaLevelM) c.lerp(COL.rock, Math.min(1, (slope - 0.4) / 0.4));
    colors[idx * 3] = c.r; colors[idx * 3 + 1] = c.g; colors[idx * 3 + 2] = c.b;
  }
  const indices = new Uint32Array((rows - 1) * (cols - 1) * 6); let t = 0;
  for (let gz = 0; gz < rows - 1; gz++) for (let gx = 0; gx < cols - 1; gx++) {
    const a = gz * cols + gx, b = a + 1, d = a + cols, e = d + 1;
    indices[t++] = a; indices[t++] = d; indices[t++] = b; indices[t++] = b; indices[t++] = d; indices[t++] = e;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0 }));
  mesh.receiveShadow = true; mesh.name = "terrain";

  return { object3d: mesh, heightAt, slopeAt, flowAt, config: cfg, halfSize: half, grid: { heights, flow, cols, rows, step, maxFlow } };
}
