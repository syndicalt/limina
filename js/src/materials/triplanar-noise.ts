// Phase 2b — SHARED procedural-PBR building blocks: a baked tileable detail-noise
// singleton + triplanar samplers. Extracted verbatim from terrain/material-pbr.ts so
// the terrain surface AND primitive/imported materials draw their micro-relief from the
// SAME source — one upload, one implementation, identical "Grounded Stylized Realism"
// grain. terrain/material-pbr.ts now imports these; the palette procedural-PBR builder
// (materials/procedural-pbr.ts) and the texture-pack import (materials/material-registry.ts)
// reuse the same triplanar machinery.
//
// NOISE SOURCE — BAKED, not in-shader (see the original rationale in material-pbr.ts):
// a single small tileable noise DataTexture baked once at module load and sampled, because
// DataTexture + `texture()` is the proven path on this backend (deno_webgpu), it is
// deterministic, and a shared singleton is cheap across every tile/primitive.

import * as THREE from "../../build/three.bundle.mjs";
import { hashLattice } from "../terrain/procedural.ts";

// TSL handle (loosely typed — the fluent node API is dynamic; the graph is validated by the
// live WebGPU shader compile / in-tab UAT, and its CONSTRUCTION by the headless tests).
// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;

// ── Shared baked tileable detail-noise texture ────────────────────────────────────────────
// RGBA8, RepeatWrapping, LinearFilter. Channels:
//   R = ∂h/∂u gradient (encoded *0.5+0.5)   → detail-normal X
//   G = ∂h/∂v gradient (encoded *0.5+0.5)   → detail-normal Y
//   B = height/value noise h ∈ [0,1]         → albedo mottling
// Baked ONCE (module-level singleton) from a deterministic periodic fbm, so every material
// shares it (one upload, GPU-cache friendly). Gradients are pre-baked so a layer's
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

/** The shared baked detail-noise DataTexture (lazy singleton). Same instance for every
 *  terrain tile + every procedural-PBR primitive → one GPU upload, GPU-cache friendly. */
export function sharedDetailTexture(): THREE.DataTexture {
  if (SHARED_DETAIL === null) SHARED_DETAIL = bakeDetailNoise();
  return SHARED_DETAIL;
}

// ── Triplanar weights (shared) ────────────────────────────────────────────────────────────
/** The world-normal triplanar blend weights (per plane) + the per-axis geometric sign, raised
 *  to `sharpness` and normalised. The single source of the triplanar projection both the noise
 *  detail layer and imported-map sampling use. */
// deno-lint-ignore no-explicit-any
function triplanarWeights(sharpness: number): { w: any; sgn: any } {
  const N = T.normalWorld;
  const aN = N.abs();
  let w = aN.pow(sharpness);
  const wsum = w.x.add(w.y).add(w.z).add(1e-5);
  w = w.div(wsum);
  return { w, sgn: T.sign(N) };
}

// ── Triplanar detail-noise layer ──────────────────────────────────────────────────────────
/** One triplanar sample of the shared detail texture at `scale` (cycles/m), returning an
 *  albedo-mottle VALUE in [0,1] and a world-space detail NORMAL (geometric normal perturbed by
 *  the baked gradient, intensity `normalStrength`). Samples the three world planes (YZ/XZ/XY)
 *  and blends by the world-normal triplanar weights, so there is no UV stretch on slopes. */
// deno-lint-ignore no-explicit-any
export function triplanarLayer(tex: THREE.DataTexture, scale: number, normalStrength: number, sharpness: number): { value: any; normal: any } {
  const { w, sgn } = triplanarWeights(sharpness);
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

// ── Triplanar IMPORTED-MAP sampling (texture-pack import) ───────────────────────────────────
/** Triplanar-project an imported albedo/roughness/normal map set onto arbitrary geometry at
 *  `scale` (cycles/m). Mirrors triplanarLayer's projection but samples real CC0 maps:
 *    • color    = triplanar blend of the albedo map's RGB (undefined if no albedo).
 *    • roughness = triplanar blend of the roughness map's R (undefined if no roughness map).
 *    • normal    = world-space detail normal from the normal map's RG tangent perturbation
 *                  (intensity `normalStrength`), assembled per-plane exactly like the noise
 *                  detail layer; undefined if no normal map.
 *  Any map may be null; only the provided channels yield nodes (the caller decides which of
 *  colorNode/roughnessNode/normalNode to set). */
export function triplanarMapLayer(
  albedo: THREE.Texture | null,
  normal: THREE.Texture | null,
  roughness: THREE.Texture | null,
  scale: number,
  normalStrength: number,
  sharpness: number,
  // deno-lint-ignore no-explicit-any
): { color: any; normal: any; roughness: any } {
  const { w, sgn } = triplanarWeights(sharpness);
  const pw = T.positionWorld.mul(scale);
  // deno-lint-ignore no-explicit-any
  const sample = (tex: THREE.Texture) => ({
    yz: T.texture(tex, T.vec2(pw.z, pw.y)),
    xz: T.texture(tex, T.vec2(pw.x, pw.z)),
    xy: T.texture(tex, T.vec2(pw.x, pw.y)),
  });

  // deno-lint-ignore no-explicit-any
  let color: any;
  if (albedo !== null) {
    const s = sample(albedo);
    color = s.yz.rgb.mul(w.x).add(s.xz.rgb.mul(w.y)).add(s.xy.rgb.mul(w.z));
  }

  // deno-lint-ignore no-explicit-any
  let rough: any;
  if (roughness !== null) {
    const s = sample(roughness);
    rough = s.yz.r.mul(w.x).add(s.xz.r.mul(w.y)).add(s.xy.r.mul(w.z));
  }

  // deno-lint-ignore no-explicit-any
  let nrm: any;
  if (normal !== null) {
    const s = sample(normal);
    // deno-lint-ignore no-explicit-any
    const g = (t: any) => T.vec2(t.r.mul(2).sub(1).mul(normalStrength), t.g.mul(2).sub(1).mul(normalStrength));
    const gYZ = g(s.yz), gXZ = g(s.xz), gXY = g(s.xy);
    const nYZ = T.vec3(sgn.x, gYZ.y.negate(), gYZ.x.negate());
    const nXZ = T.vec3(gXZ.x.negate(), sgn.y, gXZ.y.negate());
    const nXY = T.vec3(gXY.x.negate(), gXY.y.negate(), sgn.z);
    nrm = nYZ.mul(w.x).add(nXZ.mul(w.y)).add(nXY.mul(w.z)).normalize();
  }

  return { color, normal: nrm, roughness: rough };
}
