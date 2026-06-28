// RENDER-ONLY post-processing stack — Phase 3 of the terrain overhaul.
//
// "Grounded Stylized Realism" (subtle): a real depth + normal pre-pass feeding
//   1. GTAO  — ground-truth ambient occlusion. Short radius, gentle intensity:
//      it nestles trees / rocks / dunes into the terrain with CONTACT occlusion,
//      not a dirty global wash.
//   2. BLOOM — high threshold, low strength: only the brightest highlights (snow
//      crests, sun-glints on the water) lift, the rest of the frame is untouched.
//   3. GRADE — gentle exposure / contrast / saturation over the existing ACES
//      tonemap, applied in HDR before the pipeline's tone transform, for cohesion.
//
// This is PURELY a render-graph concern. It composites the colour the scene pass
// already produced; it NEVER touches the sim / physics / world-log / replay. A
// world rendered with or without this stack logs and replays bit-identically —
// the pipeline is rebuilt per-run from the scene, never carried as world state.
//
// EMPIRICAL: built on three's `PostProcessing` (a wrapper over RenderPipeline).
// The depth+normal pre-pass is real — `pass(scene, camera).setMRT(mrt({ output,
// normal: normalView }))` makes the scene pass emit a sampleable depth texture
// (`getTextureNode('depth')`) and a view-space normal target, which GTAO reads.
// The deno_webgpu backend allocates depth textures sampleable, so this path runs
// natively (verified by a windowed boot — see js/test + the demo wiring).
//
// The node factories `ao` (GTAONode) and `bloom` (BloomNode) are addon TSL display
// nodes exposed through the limina three bundle (build/three-entry.js). The grade
// uses the bundled TSL `saturation`/`luminance` colour-adjustment helpers.

import * as THREE from "../../build/three.bundle.mjs";

// The fluent TSL node API is dynamic (every op returns a chainable node); typed
// loosely, validated by the live WebGPU shader compile (windowed UAT). Same seam
// water.ts uses.
// deno-lint-ignore no-explicit-any
const T = (THREE as any).TSL;
// deno-lint-ignore no-explicit-any
const AO = (THREE as any).ao as (depth: unknown, normal: unknown, camera: unknown) => any;
// deno-lint-ignore no-explicit-any
const BLOOM = (THREE as any).bloom as (node: unknown, strength?: number, radius?: number, threshold?: number) => any;

/** GTAO (ambient-occlusion) parameters. Defaults are tuned SUBTLE — short radius,
 *  gentle intensity — so the AO reads as contact shadow where geometry meets the
 *  ground, not as a global dirt pass. */
export interface AoPreset {
  /** View-space sampling radius (world units). Short → tight contact occlusion. */
  radius: number;
  /** Occlusion darkness exponent (`scale` on the GTAO node). 1 = linear. */
  scale: number;
  /** Falloff over distance for each sample. 1 = linear. */
  distanceExponent: number;
  /** Max view-Z thickness a sample is allowed to occlude through. */
  thickness: number;
  /** Sample count (quality vs. cost). */
  samples: number;
  /** AO render resolution as a fraction of full (0.5 ≈ half-res, cheaper). */
  resolutionScale: number;
  /** Overall strength: lerp 1→AO. 1 = full node effect, lower = gentler. */
  intensity: number;
}

/** Bloom parameters. Defaults: HIGH threshold + LOW strength so only the brightest
 *  highlights (snow, water glints) lift — never a soft-focus haze over everything. */
export interface BloomPreset {
  /** Additive glow strength. Low. */
  strength: number;
  /** Blur spread of the glow. */
  radius: number;
  /** Luminance threshold a pixel must exceed to bloom. High → highlights only. */
  threshold: number;
}

/** Colour-grade parameters, applied in HDR before the pipeline's ACES tone
 *  transform. Gentle by default — cohesion, not a creative LUT. */
export interface GradePreset {
  /** HDR exposure multiplier (on top of renderer.toneMappingExposure). */
  exposure: number;
  /** Contrast around the 0.18 middle-grey pivot. 1 = unchanged. */
  contrast: number;
  /** Saturation. 1 = unchanged, <1 desaturates, >1 boosts. */
  saturation: number;
}

/** The full post preset. Each stage can be toggled off independently. */
export interface PostPreset {
  ao: AoPreset & { enabled: boolean };
  bloom: BloomPreset & { enabled: boolean };
  grade: GradePreset & { enabled: boolean };
}

/** "Grounded Stylized Realism" — the subtle default. */
export const DEFAULT_POST_PRESET: PostPreset = {
  ao: {
    enabled: true,
    radius: 0.5,
    scale: 1.0,
    distanceExponent: 1.0,
    thickness: 1.0,
    samples: 16,
    resolutionScale: 1.0,
    intensity: 0.85,
  },
  bloom: {
    enabled: true,
    strength: 0.22,
    radius: 0.4,
    threshold: 0.9,
  },
  grade: {
    enabled: true,
    exposure: 1.0,
    contrast: 1.05,
    saturation: 1.08,
  },
};

/** Deep-merge a partial preset onto the default (per-stage), so callers can tweak
 *  one knob without restating the whole preset. */
export function resolvePostPreset(override?: DeepPartial<PostPreset>): PostPreset {
  const d = DEFAULT_POST_PRESET;
  return {
    ao: { ...d.ao, ...(override?.ao ?? {}) },
    bloom: { ...d.bloom, ...(override?.bloom ?? {}) },
    grade: { ...d.grade, ...(override?.grade ?? {}) },
  };
}

type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> };

/** The built pipeline, with the live nodes exposed for inspection (tests) + the
 *  driver methods the render loop calls in place of `renderer.render(...)`. */
export interface PostPipeline {
  /** The three PostProcessing object — `.outputNode` is the composited graph. */
  postProcessing: unknown;
  /** The scene `pass` node (the depth+normal pre-pass source). */
  scenePass: unknown;
  /** The scene pass's depth texture node (proof the depth pre-pass is wired). */
  depthNode: unknown;
  /** The scene pass's view-normal texture node. */
  normalNode: unknown;
  /** The GTAO node (null if AO disabled). */
  aoNode: unknown;
  /** The bloom node (null if bloom disabled). */
  bloomNode: unknown;
  /** The resolved preset this pipeline was built from. */
  preset: PostPreset;
  /** Render one frame through the post stack (replaces renderer.render). */
  render(): void;
  /** Keep AO/bloom internal targets sized with the swapchain (call on resize). */
  setSize(width: number, height: number): void;
}

/** Build the render-only post-processing pipeline over a scene/camera. The caller
 *  drives it from the windowed render loop: `pipeline.render()` then
 *  `op_surface_present(...)`, in place of `renderer.render(scene, camera)`.
 *
 *  Render-only: this composites the colour buffer; it reads NOTHING from and writes
 *  NOTHING to the sim/physics/world-log. */
export function buildPostPipeline(
  renderer: unknown,
  scene: unknown,
  camera: unknown,
  override?: DeepPartial<PostPreset>,
): PostPipeline {
  const preset = resolvePostPreset(override);

  // deno-lint-ignore no-explicit-any
  const post = new (THREE as any).PostProcessing(renderer);

  // ── Depth + normal PRE-PASS ──────────────────────────────────────────────────
  // The scene pass renders colour AND, via MRT, a view-space normal target; its
  // depth attachment is exposed as a sampleable texture node. This is the real
  // depth/normal source GTAO consumes (no camera-distance proxy).
  const scenePass = T.pass(scene, camera);
  scenePass.setMRT(T.mrt({ output: T.output, normal: T.normalView }));
  const colorNode = scenePass.getTextureNode("output");
  const normalNode = scenePass.getTextureNode("normal");
  const depthNode = scenePass.getTextureNode("depth");

  // ── 1. GTAO — contact ambient occlusion ──────────────────────────────────────
  // deno-lint-ignore no-explicit-any
  let aoNode: any = null;
  // deno-lint-ignore no-explicit-any
  let litColor: any = colorNode;
  if (preset.ao.enabled) {
    aoNode = AO(depthNode, normalNode, camera);
    aoNode.radius.value = preset.ao.radius;
    aoNode.scale.value = preset.ao.scale;
    aoNode.distanceExponent.value = preset.ao.distanceExponent;
    aoNode.thickness.value = preset.ao.thickness;
    aoNode.samples.value = preset.ao.samples;
    aoNode.resolutionScale = preset.ao.resolutionScale;
    // GTAO output .r is the occlusion factor (1 = open, →0 = occluded). Lerp from
    // fully-open (1) toward the AO factor by `intensity` so the strength is a clean,
    // gentle dial independent of the node's internal scale/radius.
    const aoR = aoNode.getTextureNode().r;
    const occlusion = T.mix(T.float(1.0), aoR, T.float(preset.ao.intensity));
    litColor = colorNode.mul(T.vec4(T.vec3(occlusion), 1.0));
  }

  // ── 2. BLOOM — highlight-only glow ───────────────────────────────────────────
  // deno-lint-ignore no-explicit-any
  let bloomNode: any = null;
  // deno-lint-ignore no-explicit-any
  let composited: any = litColor;
  if (preset.bloom.enabled) {
    bloomNode = BLOOM(litColor, preset.bloom.strength, preset.bloom.radius, preset.bloom.threshold);
    composited = litColor.add(bloomNode);
  }

  // ── 3. GRADE — gentle HDR exposure / contrast / saturation ───────────────────
  // Applied BEFORE the pipeline's tone transform (post.outputColorTransform keeps
  // the renderer's ACES tonemap + sRGB convert at the very end), so this is cohesion
  // on the linear HDR signal, not a punchy creative grade.
  // deno-lint-ignore no-explicit-any
  let outputNode: any = composited;
  if (preset.grade.enabled) {
    let rgb = composited.rgb;
    if (preset.grade.exposure !== 1.0) rgb = rgb.mul(T.float(preset.grade.exposure));
    if (preset.grade.contrast !== 1.0) {
      // contrast around 0.18 middle grey; clamp ≥0 to avoid negative HDR.
      rgb = rgb.sub(0.18).mul(T.float(preset.grade.contrast)).add(0.18).max(0.0);
    }
    if (preset.grade.saturation !== 1.0) rgb = T.saturation(rgb, T.float(preset.grade.saturation));
    outputNode = T.vec4(rgb, composited.a);
  }

  post.outputNode = outputNode;

  return {
    postProcessing: post,
    scenePass,
    depthNode,
    normalNode,
    aoNode,
    bloomNode,
    preset,
    render(): void {
      post.render();
    },
    // The scene pass, GTAO and bloom nodes ALL re-derive their render-target sizes
    // from the renderer's drawing buffer every frame in their own updateBefore, so a
    // resize is picked up automatically once renderer.setSize() runs. This is a no-op
    // hook kept for call-site symmetry (and so callers needn't special-case it) —
    // calling the nodes' setSize() here would crash before their internals are built
    // (they are lazily set up on the first render).
    setSize(_width: number, _height: number): void {},
  };
}
