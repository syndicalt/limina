import * as THREE from "../../build/three.bundle.mjs";
import { sharedDetailTexture } from "./detail-noise-texture.ts";

// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;

export interface ParallaxOptions {
  heightScale: number;
  minLayers: number;
  maxLayers: number;
  fadeStart: number;
  fadeEnd: number;
}

export interface StochasticCoordinates {
  // deno-lint-ignore no-explicit-any
  readonly uvA: any;
  // deno-lint-ignore no-explicit-any
  readonly uvB: any;
  // deno-lint-ignore no-explicit-any
  readonly blend: any;
  // deno-lint-ignore no-explicit-any
  readonly dx: any;
  // deno-lint-ignore no-explicit-any
  readonly dy: any;
}

/**
 * IQ-style two-translation stochastic coordinates. The selector is evaluated once from the
 * undisplaced UV and shared by every PBR channel, so the channels cannot slide apart. Translation
 * (rather than rotation) keeps tangent-space normals and the explicit base derivatives valid.
 */
// deno-lint-ignore no-explicit-any
export function stochasticCoordinates(baseUv: any, sampleUv: any = baseUv): StochasticCoordinates {
  const dx = baseUv.dFdx();
  const dy = baseUv.dFdy();
  const selectorUv = baseUv.mul(0.03125);
  const selector = T.texture(sharedDetailTexture(), selectorUv)
    .grad(dx.mul(0.03125), dy.mul(0.03125)).b;
  const index = T.floor(selector.mul(8));
  const phase = T.fract(selector.mul(8));
  const offsetA = T.sin(T.vec2(3, 7).mul(index)).mul(0.5);
  const offsetB = T.sin(T.vec2(3, 7).mul(index.add(1))).mul(0.5);
  return {
    uvA: sampleUv.add(offsetA),
    uvB: sampleUv.add(offsetB),
    blend: T.smoothstep(0.2, 0.8, phase),
    dx,
    dy,
  };
}

/** Sample one channel with stable explicit derivatives; stochastic coordinates are shared. */
// deno-lint-ignore no-explicit-any
export function sampleSurfaceTexture(texture: THREE.Texture, baseUv: any, sampleUv: any, antiTiling: boolean): any {
  const dx = baseUv.dFdx();
  const dy = baseUv.dFdy();
  if (!antiTiling) return T.texture(texture, sampleUv).grad(dx, dy);
  const c = stochasticCoordinates(baseUv, sampleUv);
  const a = T.texture(texture, c.uvA).grad(c.dx, c.dy);
  const b = T.texture(texture, c.uvB).grad(c.dx, c.dy);
  return T.mix(a, b, c.blend);
}

/**
 * True bounded parallax-occlusion UV march. The height field is white-high. Texture gradients are
 * taken from the original UV before entering the dynamic loop, avoiding undefined implicit
 * derivatives in both WGSL and GLSL. `viewDirection` is tangent/projection-space, toward camera.
 */
// deno-lint-ignore no-explicit-any
export function parallaxOcclusionUv(
  displacement: THREE.Texture,
  baseUv: any,
  viewDirection: any,
  options: ParallaxOptions,
  antiTiling: boolean,
  // deno-lint-ignore no-explicit-any
  projectionWeight: any = T.float(1),
): any {
  const pom = T.Fn(() => {
    // Leave function-local symbols unnamed. A material can reuse this shader call from several
    // output channels; fixed declaration names would collide when Three expands the shared graph.
    const outputUv = baseUv.toVar();
    const vz = viewDirection.z.abs();
    const distance = T.positionView.length();
    const distanceFade = T.oneMinus(T.smoothstep(options.fadeStart, options.fadeEnd, distance));
    const grazingFade = T.smoothstep(0.08, 0.25, vz);
    const strength = T.float(options.heightScale).mul(distanceFade).mul(grazingFade).mul(projectionWeight);

    T.If(strength.greaterThan(1e-5), () => {
      const layers = T.mix(T.float(options.maxLayers), T.float(options.minLayers), T.clamp(vz, 0, 1));
      const layerStep = T.oneMinus(T.float(0)).div(layers);
      const directionUv = viewDirection.xy.div(T.max(vz, 0.08));
      const deltaUv = directionUv.mul(strength).div(layers);
      const currentUv = baseUv.toVar();
      const previousUv = baseUv.toVar();
      const currentLayer = T.float(0).toVar();
      const previousLayer = T.float(0).toVar();
      const height = sampleSurfaceTexture(displacement, baseUv, currentUv, antiTiling).r.toVar();
      const previousHeight = T.float(0).toVar();
      previousHeight.assign(height);

      T.Loop(options.maxLayers, () => {
        T.If(currentLayer.greaterThanEqual(height), () => { T.Break(); });
        previousUv.assign(currentUv);
        previousLayer.assign(currentLayer);
        previousHeight.assign(height);
        currentUv.subAssign(deltaUv);
        currentLayer.addAssign(layerStep);
        height.assign(sampleSurfaceTexture(displacement, baseUv, currentUv, antiTiling).r);
      });

      // Refine between the final point above the virtual surface and the first point below it.
      const before = previousHeight.sub(previousLayer);
      const after = height.sub(currentLayer);
      const denominator = T.max(before.sub(after).abs(), 1e-5);
      const t = T.clamp(before.div(denominator), 0, 1);
      outputUv.assign(T.mix(previousUv, currentUv, t));
    });
    return outputUv;
  });
  return pom();
}

export interface CpuPomOptions {
  heightScale: number;
  layers: number;
}

/** CPU oracle for intersection/refinement tests; mirrors the bounded white-high shader march. */
export function parallaxOcclusionUvCpu(
  baseUv: readonly [number, number],
  viewDirection: readonly [number, number, number],
  sampleHeight: (u: number, v: number) => number,
  options: CpuPomOptions,
): { uv: [number, number]; iterations: number } {
  const layers = Math.max(1, Math.trunc(options.layers));
  const vz = Math.max(Math.abs(viewDirection[2]), 0.08);
  const du = viewDirection[0] / vz * options.heightScale / layers;
  const dv = viewDirection[1] / vz * options.heightScale / layers;
  let u = baseUv[0], v = baseUv[1], layer = 0;
  let height = Math.min(1, Math.max(0, sampleHeight(u, v)));
  let pu = u, pv = v, previousLayer = layer, previousHeight = height;
  let iterations = 0;
  for (; iterations < layers && layer < height; iterations++) {
    pu = u; pv = v; previousLayer = layer; previousHeight = height;
    u -= du; v -= dv; layer += 1 / layers;
    height = Math.min(1, Math.max(0, sampleHeight(u, v)));
  }
  const before = previousHeight - previousLayer;
  const after = height - layer;
  const t = Math.min(1, Math.max(0, before / Math.max(Math.abs(before - after), 1e-5)));
  return { uv: [pu + (u - pu) * t, pv + (v - pv) * t], iterations };
}
