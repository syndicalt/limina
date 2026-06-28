// Phase 11 — OPT-IN procedural PBR terrain surface ("Grounded Stylized Realism").
//
// The flat ramp (terrain/render.ts `applyBiomeRamp`) shades a tile by elevation+climate
// into a single flat `colorNode`/`roughnessNode` — believable bands, but a CLAY read: no
// surface micro-relief, so light lands the same everywhere inside a band. This module is the
// opt-in upgrade: it keeps the EXACT same band logic (so the rock/grass/snow/sand zones land
// in the same places), but each band is now a real MATERIAL LAYER — procedural albedo + a
// real detail NORMAL + honest roughness — projected TRIPLANARLY (no UV stretch on slopes) and
// blended by the same slope+height+biome weights. The detail normals are the key "not clay"
// lever: they break up the flat shading so rock reads craggy, sand reads rippled, grass reads
// grained, snow reads soft — PBR-grounded but stylized + readable, not photoreal.
//
// RENDER-ONLY + OPT-IN: invoked only when `TerrainMeshOptions.pbr` is set (supersedes
// palette/shoreline). When absent the material keeps the flat-colour defaults byte-for-byte —
// no sim/physics/log impact, no regression to the default path.
//
// NOISE SOURCE — BAKED, not in-shader. The three TSL build here exposes MaterialX in-shader
// noise (`mx_noise_float`/`mx_noise_vec3`), but this module BAKES a single small tileable
// noise DataTexture once at module load and samples it, because:
//   • PROVEN on this backend — DataTexture + `texture()` is the exact path water.ts and the
//     flat ramp already compile + run on deno_webgpu; in-shader mx_noise compiling to valid
//     WGSL on this backend is unverified (the look is windowed-only UAT, so we don't gamble).
//   • DETERMINISTIC — the bake is a pure function of a fixed seed (render-only; never the log).
//   • PERFORMANT over many tiles — the texture is a SHARED module-level singleton (baked once,
//     reused by every tile's material), and baking the gradient INTO the texture means the
//     per-layer detail-normal strength is a cheap multiply, with no per-fragment noise eval.
//     Cost per fragment is a fixed set of texture fetches (3 planes × the active layers), the
//     same primitive the proven ramp/water shaders already use.

import * as THREE from "../../build/three.bundle.mjs";
import type { TerrainTile } from "./types.ts";
import { hashLattice } from "./procedural.ts";
import { bakeTileClimate, RAMP_DEFAULT_COLORS, type TerrainPaletteOptions } from "./render.ts";

// TSL handle (loosely typed — the fluent node API is dynamic; the graph is validated by the
// live WebGPU shader compile / in-tab UAT, and its CONSTRUCTION by js/test/p11_terrain_pbr.ts).
// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;

/**
 * OPT-IN procedural-PBR surface recipe (via `TerrainMeshOptions.pbr`). Extends the flat ramp's
 * band options (`TerrainPaletteOptions`) — the SAME `seaLevel`/relief/climate/coast knobs place
 * the bands — and adds the per-layer surface-detail knobs. Only `seaLevel` is required.
 */
export interface TerrainPbrOptions extends TerrainPaletteOptions {
  /** Per-layer surface-detail tuning. All optional; defaults are tuned to Grounded Stylized
   *  Realism (crisp detail normals, controlled albedo mottling, honest roughness). */
  detail?: {
    /** World-space detail tiling frequency (cycles per metre) per layer. Higher = finer grain.
     *  Defaults: rock 0.14 (coarse crags), grass 0.45 (fine blades), snow 0.10 (soft drifts),
     *  sand 0.55 (tight ripples). */
    rockScale?: number;
    grassScale?: number;
    snowScale?: number;
    sandScale?: number;
    /** Detail-NORMAL intensity per layer (0 = flat/clay, 1 = strong relief). The "not clay"
     *  lever. Defaults: rock 1.0, grass 0.55, snow 0.30, sand 0.7. */
    rockNormal?: number;
    grassNormal?: number;
    snowNormal?: number;
    sandNormal?: number;
    /** Albedo mottling depth per layer (0 = flat colour, ~0.35 = lively). Default 0.22. */
    mottle?: number;
    /** Triplanar blend sharpness (higher = crisper plane transitions). Default 4. */
    triplanarSharpness?: number;
  };
  /** Per-layer base roughness (PBR honesty). Defaults: rock 0.92, grass 0.85, snow 0.6,
   *  sand 0.95, subSea 0.5. */
  layerRoughness?: Partial<{ rock: number; grass: number; snow: number; sand: number; subSea: number }>;
}

// ── Shared baked tileable detail-noise texture ────────────────────────────────────────────
// RGBA8, RepeatWrapping, LinearFilter. Channels:
//   R = ∂h/∂u gradient (encoded *0.5+0.5)   → detail-normal X
//   G = ∂h/∂v gradient (encoded *0.5+0.5)   → detail-normal Y
//   B = height/value noise h ∈ [0,1]         → albedo mottling
// Baked ONCE (module-level singleton) from a deterministic periodic fbm, so every tile's
// material shares it (one upload, GPU-cache friendly). Gradients are pre-baked so a layer's
// detail-normal strength is a cheap in-shader multiply (no per-fragment noise evaluation).

const DETAIL_RES = 256;     // texture edge (px)
const DETAIL_CELLS = 8;     // base lattice cells across the tile (period → tileable)
const DETAIL_OCTAVES = 5;   // fbm octaves
const DETAIL_SEED = 0x9e3779b1 | 0;

let SHARED_DETAIL: THREE.DataTexture | null = null;

function smoothstep01(t: number): number { return t * t * (3 - 2 * t); }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

/** Periodic value noise in [0,1] over a `period`-cell torus (so it tiles seamlessly): bilinear
 *  smoothstep interpolation of four hashed lattice corners, lattice indices taken modulo
 *  `period`. Pure integer hash → deterministic (same family as procedural.ts). */
function periodicValueNoise(seed: number, x: number, z: number, period: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const wrap = (n: number) => ((n % period) + period) % period;
  const x0 = wrap(ix), x1 = wrap(ix + 1), z0 = wrap(iz), z1 = wrap(iz + 1);
  const v00 = hashLattice(seed, x0, z0), v10 = hashLattice(seed, x1, z0);
  const v01 = hashLattice(seed, x0, z1), v11 = hashLattice(seed, x1, z1);
  const ux = smoothstep01(fx), uz = smoothstep01(fz);
  return lerp(lerp(v00, v10, ux), lerp(v01, v11, ux), uz);
}

/** Tileable fbm over [0,1)²: summed octaves, each tiling on its own (cells×2^o)-cell torus, so
 *  the whole field is seamless across the [0,1) texture wrap. Normalised to [0,1]. */
function periodicFbm(x: number, z: number, baseCells: number, octaves: number): number {
  let amp = 1, sum = 0, norm = 0, cells = baseCells;
  for (let o = 0; o < octaves; o++) {
    const s = (DETAIL_SEED + Math.imul(o, 0x85ebca6b)) | 0;
    sum += amp * periodicValueNoise(s, x * cells, z * cells, cells);
    norm += amp;
    amp *= 0.5;
    cells *= 2;
  }
  return sum / norm;
}

/** Bake (once) the shared tileable detail-noise texture (gradient in RG, height in B). */
function bakeDetailNoise(): THREE.DataTexture {
  const res = DETAIL_RES;
  const h = new Float32Array(res * res);
  for (let r = 0; r < res; r++) {
    const z = r / res;
    for (let c = 0; c < res; c++) {
      h[r * res + c] = periodicFbm(c / res, z, DETAIL_CELLS, DETAIL_OCTAVES);
    }
  }
  // Wrapped central-difference gradients (texel space), then normalise by the max |grad| so the
  // encoded RG channels span the full byte range deterministically (decoded back in-shader).
  const gx = new Float32Array(res * res);
  const gy = new Float32Array(res * res);
  let maxg = 1e-6;
  for (let r = 0; r < res; r++) {
    for (let c = 0; c < res; c++) {
      const cL = (c - 1 + res) % res, cR = (c + 1) % res;
      const rU = (r - 1 + res) % res, rD = (r + 1) % res;
      const dx = (h[r * res + cR] - h[r * res + cL]) * 0.5;
      const dy = (h[rD * res + c] - h[rU * res + c]) * 0.5;
      gx[r * res + c] = dx;
      gy[r * res + c] = dy;
      const a = Math.abs(dx), b = Math.abs(dy);
      if (a > maxg) maxg = a;
      if (b > maxg) maxg = b;
    }
  }
  const inv = 1 / maxg;
  const data = new Uint8Array(res * res * 4);
  for (let i = 0; i < h.length; i++) {
    const o = i * 4;
    data[o] = Math.round(Math.min(1, Math.max(0, gx[i] * inv * 0.5 + 0.5)) * 255);
    data[o + 1] = Math.round(Math.min(1, Math.max(0, gy[i] * inv * 0.5 + 0.5)) * 255);
    data[o + 2] = Math.round(Math.min(1, Math.max(0, h[i])) * 255);
    data[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function sharedDetailTexture(): THREE.DataTexture {
  if (SHARED_DETAIL === null) SHARED_DETAIL = bakeDetailNoise();
  return SHARED_DETAIL;
}

// ── Triplanar layer sampling ──────────────────────────────────────────────────────────────
/** One triplanar sample of the shared detail texture at `scale` (cycles/m), returning an
 *  albedo-mottle VALUE in [0,1] and a world-space detail NORMAL (geometric normal perturbed by
 *  the baked gradient, intensity `normalStrength`). Samples the three world planes (YZ/XZ/XY)
 *  and blends by the world-normal triplanar weights, so there is no UV stretch on slopes. */
// deno-lint-ignore no-explicit-any
function triplanarLayer(tex: THREE.DataTexture, scale: number, normalStrength: number, sharpness: number): { value: any; normal: any } {
  const N = T.normalWorld;
  const aN = N.abs();
  let w = aN.pow(sharpness);
  const wsum = w.x.add(w.y).add(w.z).add(1e-5);
  w = w.div(wsum);
  const sgn = T.sign(N);

  const pw = T.positionWorld.mul(scale);
  const sYZ = T.texture(tex, T.vec2(pw.z, pw.y)); // X-facing plane (up = world X)
  const sXZ = T.texture(tex, T.vec2(pw.x, pw.z)); // Y-facing plane (up = world Y)
  const sXY = T.texture(tex, T.vec2(pw.x, pw.y)); // Z-facing plane (up = world Z)

  // Albedo mottle: triplanar-blended height/value.
  const value = sYZ.b.mul(w.x).add(sXZ.b.mul(w.y)).add(sXY.b.mul(w.z));

  // Per-plane world detail normal from the baked gradient (RG → [-1,1] × strength), with the
  // "up" axis carrying the geometric-normal sign so a tilted/under face keeps the right facing.
  // deno-lint-ignore no-explicit-any
  const g = (s: any) => T.vec2(s.r.mul(2).sub(1).mul(normalStrength), s.g.mul(2).sub(1).mul(normalStrength));
  const gYZ = g(sYZ), gXZ = g(sXZ), gXY = g(sXY);
  const nYZ = T.vec3(sgn.x, gYZ.y.negate(), gYZ.x.negate());        // up = world X; tangents Z,Y
  const nXZ = T.vec3(gXZ.x.negate(), sgn.y, gXZ.y.negate());        // up = world Y; tangents X,Z
  const nXY = T.vec3(gXY.x.negate(), gXY.y.negate(), sgn.z);        // up = world Z; tangents X,Y
  const normal = nYZ.mul(w.x).add(nXZ.mul(w.y)).add(nXY.mul(w.z)).normalize();
  return { value, normal };
}

/**
 * Apply the OPT-IN procedural-PBR surface to a terrain tile material. Sets `colorNode`,
 * `normalNode`, and `roughnessNode` from triplanar procedural layers blended by the SAME
 * slope+height+biome bands as the flat ramp. Render-only; deterministic; no sim/log impact.
 */
export function applyPbrMaterial(material: THREE.MeshStandardNodeMaterial, tile: TerrainTile, baseRough: number, pbr: TerrainPbrOptions): void {
  const tempRange = pbr.tempRange ?? [-30, 40];
  const precipMax = pbr.precipMax ?? 3000;
  const [precipDry, precipWet] = pbr.precipBand ?? [300, 1400];
  const [tMin, tMax] = tempRange;
  const tSpan = tMax - tMin;

  const cols = { ...RAMP_DEFAULT_COLORS, ...(pbr.colors ?? {}) };
  const C = (hex: number) => { const c = new THREE.Color(hex); return T.vec3(c.r, c.g, c.b); };
  const subSeaV = C(cols.subSea), sandV = C(cols.sand), dryV = C(cols.dryGrass);
  const forestV = C(cols.forest), rockV = C(cols.rock), snowV = C(cols.snow);

  const d = pbr.detail ?? {};
  const sharp = d.triplanarSharpness ?? 4;
  const mottle = d.mottle ?? 0.22;
  const tex = sharedDetailTexture();
  // The four surface layers: each its own tiling + detail-normal strength (the look knobs).
  // CUT-1 PERF LIMITATION: all 4 layers × 3 triplanar planes (~12 detail fetches) + 1 climate
  // fetch are evaluated UNCONDITIONALLY per fragment — the band masks blend the results, they do
  // not gate the fetches. Fine at landscape_window tile counts; a cost cliff at km-scale tile
  // counts (e.g. model_terrain_window), so `pbr` is intentionally NOT enabled on the model demo
  // yet. PHASE-4 OPTIMIZATION: reduce to a shared fine/coarse pair (6 fetches) or branch-gate
  // layers whose mask is ~0, and/or drop to a single triplanar pass with per-layer reprojection.
  const rockL = triplanarLayer(tex, d.rockScale ?? 0.14, d.rockNormal ?? 1.0, sharp);
  const grassL = triplanarLayer(tex, d.grassScale ?? 0.45, d.grassNormal ?? 0.55, sharp);
  const snowL = triplanarLayer(tex, d.snowScale ?? 0.10, d.snowNormal ?? 0.30, sharp);
  const sandL = triplanarLayer(tex, d.sandScale ?? 0.55, d.sandNormal ?? 0.70, sharp);

  // Per-layer albedo = base band colour modulated by its own mottle (controlled, not noisy).
  // deno-lint-ignore no-explicit-any
  const mod = (val: any) => val.sub(0.5).mul(mottle).add(1); // ~[1-m/2, 1+m/2]

  // ── Relief + climate bands — identical thresholds to applyBiomeRamp (zones land the same) ──
  const sea = pbr.seaLevel;
  let minY = pbr.minY, maxY = pbr.maxY;
  if (minY === undefined || maxY === undefined) {
    const oy = tile.origin[1], sy = tile.scale[1];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < tile.heights.length; i++) { const h = tile.heights[i]; if (h < lo) lo = h; if (h > hi) hi = h; }
    minY = pbr.minY ?? (oy + lo * sy);
    maxY = pbr.maxY ?? (oy + hi * sy);
  }
  const aboveSpan = Math.max(1e-3, maxY - sea);
  const coastBand = Math.max(1e-3, aboveSpan * (pbr.coastFrac ?? 0.06));
  const subBand = Math.max(0.5, (sea - minY) * 0.6);

  const baked = bakeTileClimate(tile, tempRange, precipMax);
  const { minX, minZ, maxX, maxZ } = baked.bounds;
  const u = T.positionWorld.x.sub(minX).div(maxX - minX);
  const v = T.positionWorld.z.sub(minZ).div(maxZ - minZ);
  const clim = T.texture(baked.texture, T.vec2(u, v));
  const tempC = clim.r.mul(tSpan).add(tMin);
  const precip = clim.g.mul(precipMax);

  const y = T.positionWorld.y;
  const r = T.clamp(y.sub(sea).div(aboveSpan), 0, 1);
  const steep = T.clamp(T.oneMinus(T.normalWorld.y), 0, 1);
  const wet = T.smoothstep(precipDry, precipWet, precip);
  const cold = T.oneMinus(T.smoothstep(-5.0, 6.0, tempC));
  const rEff = T.clamp(r.add(cold.mul(0.06)), 0, 1);

  const rockMask = T.smoothstep(0.32, 0.46, rEff);
  const snowMask = T.smoothstep(0.84, 0.95, rEff);
  const cliff = T.smoothstep(0.55, 0.82, steep).mul(T.oneMinus(snowMask)).mul(0.7);
  const coastMask = T.oneMinus(T.smoothstep(0.0, coastBand, y.sub(sea)));
  const subMask = T.smoothstep(0.0, subBand, T.float(sea).sub(y));

  // ── Albedo: blend LAYER outputs (band colour × that layer's mottle) in ramp order ──
  const grassAlbedo = T.mix(dryV, forestV, wet).mul(mod(grassL.value));
  const rockAlbedo = rockV.mul(mod(rockL.value));
  const snowAlbedo = snowV.mul(mod(snowL.value));
  const sandAlbedo = sandV.mul(mod(sandL.value));
  const subAlbedo = subSeaV.mul(mod(sandL.value));

  let col = grassAlbedo;
  col = T.mix(col, rockAlbedo, rockMask);
  col = T.mix(col, snowAlbedo, snowMask);
  col = T.mix(col, rockAlbedo, cliff);
  col = T.mix(col, sandAlbedo, coastMask);
  col = T.mix(col, subAlbedo, subMask);
  material.colorNode = col;

  // ── Detail NORMAL: blend the LAYER detail normals by the same masks, then world→view ──
  let nrm = grassL.normal;
  nrm = T.mix(nrm, rockL.normal, rockMask);
  nrm = T.mix(nrm, snowL.normal, snowMask);
  nrm = T.mix(nrm, rockL.normal, cliff);
  nrm = T.mix(nrm, sandL.normal, coastMask);
  // Under the sea the floor is wet/smooth — fade detail back toward the geometric normal.
  nrm = T.mix(nrm, T.normalWorld, subMask.mul(0.7));
  // `normalNode` is consumed directly AS the VIEW-space normal (three's setupNormal returns it
  // as-is). The terrain mesh is identity-transformed (geometry positions are already world-space),
  // so local≈world and `transformNormalToView` (model-view normal matrix = view matrix here) lands
  // the perturbed normal in view space — the proven idiom water.ts uses for its bump normal. (Do
  // NOT use `transformDirection(vec, cameraViewMatrix)`: vec-first builds Mᵀ·v = the INVERSE
  // rotation, leaving a bogus camera-dependent frame that makes the relief swim as the camera moves.)
  material.normalNode = T.transformNormalToView(nrm.normalize());

  // ── Roughness: per-layer honest roughness blended by the same masks ──
  const lr = pbr.layerRoughness ?? {};
  let rough = T.float(lr.grass ?? Math.min(baseRough, 0.85));
  rough = T.mix(rough, T.float(lr.rock ?? 0.92), rockMask);
  rough = T.mix(rough, T.float(lr.snow ?? 0.6), snowMask);
  rough = T.mix(rough, T.float(lr.rock ?? 0.92), cliff);
  rough = T.mix(rough, T.float(lr.sand ?? 0.95), coastMask);
  rough = T.mix(rough, T.float(lr.subSea ?? 0.5), subMask);
  material.roughnessNode = T.clamp(rough, 0, 1);
}
