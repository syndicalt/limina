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
export { sharedDetailTexture } from "./detail-noise-texture.ts";
import { sharedDetailTexture } from "./detail-noise-texture.ts";
import { parallaxOcclusionUv, sampleSurfaceTexture, type ParallaxOptions } from "./surface-sampling.ts";

// TSL handle (loosely typed — the fluent node API is dynamic; the graph is validated by the
// live WebGPU shader compile / in-tab UAT, and its CONSTRUCTION by the headless tests).
// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;

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
export interface TriplanarProjection {
  /** Position node to project. Defaults to world position. Feature-local terrain supplies
   * `positionLocal` so kilometre-scale world translations never enter f32 shader math. */
  // deno-lint-ignore no-explicit-any
  position?: any;
  /** CPU-side world origin paired with a feature-local position. Only the repeating fractional
   * phase enters the shader, preserving cross-feature continuity without large coordinates. */
  origin?: readonly [number, number, number];
}

function wrappedPhase(value: number): number {
  const phase = value - Math.floor(value);
  return Object.is(phase, -0) ? 0 : phase;
}

export function triplanarLayer(
  tex: THREE.DataTexture,
  scale: number,
  normalStrength: number,
  sharpness: number,
  projection: TriplanarProjection = {},
): { value: any; normal: any } {
  const { w, sgn } = triplanarWeights(sharpness);
  const position = projection.position ?? T.positionWorld;
  const origin = projection.origin;
  // A repeating texture only needs origin*scale modulo one. Computing that phase on the CPU
  // avoids passing multi-kilometre coordinates to the shader while remaining exactly continuous
  // with ordinary world-space projection at feature boundaries.
  const phase = origin === undefined
    ? T.vec3(0, 0, 0)
    : T.vec3(
      wrappedPhase(origin[0] * scale),
      wrappedPhase(origin[1] * scale),
      wrappedPhase(origin[2] * scale),
    );
  const pw = position.mul(scale).add(phase);
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
/** Triplanar-project an imported albedo/roughness/normal/occlusion map set onto arbitrary geometry at
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
  occlusion: THREE.Texture | null,
  displacement: THREE.Texture | null,
  scale: number,
  normalStrength: number,
  sharpness: number,
  options: { antiTiling: boolean; parallax?: ParallaxOptions } = { antiTiling: false },
  // deno-lint-ignore no-explicit-any
): { color: any; normal: any; roughness: any; occlusion: any } {
  const { w, sgn } = triplanarWeights(sharpness);
  const pw = T.positionWorld.mul(scale);
  const baseYZ = T.vec2(pw.z, pw.y);
  const baseXZ = T.vec2(pw.x, pw.z);
  const baseXY = T.vec2(pw.x, pw.y);
  // POM is deliberately limited to the upward XZ projection. Its UV displacement fades to zero
  // across the triplanar seam; side projections retain stochastic normal relief without paying
  // three ray marches per fragment.
  let sampleXZ = baseXZ;
  if (options.parallax !== undefined && displacement !== null) {
    const viewWorld = T.cameraPosition.sub(T.positionWorld).normalize();
    const upwardWeight = w.y.mul(T.smoothstep(0, 0.25, T.normalWorld.y));
    sampleXZ = parallaxOcclusionUv(
      displacement,
      baseXZ,
      T.vec3(viewWorld.x, viewWorld.z, viewWorld.y),
      options.parallax,
      options.antiTiling,
      upwardWeight,
    );
  }
  // deno-lint-ignore no-explicit-any
  const sample = (tex: THREE.Texture) => ({
    yz: options.antiTiling ? sampleSurfaceTexture(tex, baseYZ, baseYZ, true) : T.texture(tex, baseYZ),
    xz: options.antiTiling || options.parallax !== undefined
      ? sampleSurfaceTexture(tex, baseXZ, sampleXZ, options.antiTiling)
      : T.texture(tex, baseXZ),
    xy: options.antiTiling ? sampleSurfaceTexture(tex, baseXY, baseXY, true) : T.texture(tex, baseXY),
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
  let ao: any;
  if (occlusion !== null) {
    const s = sample(occlusion);
    ao = s.yz.r.mul(w.x).add(s.xz.r.mul(w.y)).add(s.xy.r.mul(w.z));
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

  return { color, normal: nrm, roughness: rough, occlusion: ao };
}
