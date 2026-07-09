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
// EMPIRICAL: built on three's `RenderPipeline`.
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
// Phase-4 additions (opt-in stages). godrays raymarches the SUN's shadow map for
// volumetric crepuscular scatter; dof is a depth-driven bokeh blur; sobel is a
// full-scene edge operator we use for a cel ink outline.
// deno-lint-ignore no-explicit-any
const GODRAYS = (THREE as any).godrays as (depth: unknown, camera: unknown, light: unknown) => any;
// deno-lint-ignore no-explicit-any
const DOF = (THREE as any).dof as (node: unknown, viewZ: unknown, focus?: unknown, focal?: unknown, bokeh?: unknown) => any;
// deno-lint-ignore no-explicit-any
const SOBEL = (THREE as any).sobel as (node: unknown) => any;

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

/** Volumetric god-rays (crepuscular scatter) parameters. Raymarches the sun's
 *  shadow map, so the SUN must cast shadows (the render baseline's does). */
export interface GodraysPreset {
  /** Scatter strength accumulated per raymarch step. */
  density: number;
  /** Clamp on accumulated density (keeps rays from blowing out). */
  maxDensity: number;
  /** Falloff of the scatter over distance. */
  distanceAttenuation: number;
  /** Raymarch step count (quality vs. cost). */
  raymarchSteps: number;
  /** Overall additive strength when composited over the scene (our dial). */
  intensity: number;
}

/** Depth-of-field bokeh. Distances are WORLD units along the camera look axis.
 *  Low value for a top-down map overview; meant for hero / eye-level shots. */
export interface DofPreset {
  /** Distance along the look direction that is perfectly in focus. */
  focusDistance: number;
  /** How far past the focus plane before fully out of focus. */
  focalLength: number;
  /** Artistic bokeh size multiplier. */
  bokehScale: number;
}

/** Full-scene Sobel edge → cel ink outline. A style choice (can read noisy on
 *  organic terrain), so opt-in. */
export interface OutlinePreset {
  /** Darkening applied where the edge operator fires (0 = none, 1 = black lines). */
  strength: number;
}

/** The full post preset. Each stage can be toggled off independently. */
export interface PostPreset {
  ao: AoPreset & { enabled: boolean };
  bloom: BloomPreset & { enabled: boolean };
  grade: GradePreset & { enabled: boolean };
  godrays: GodraysPreset & { enabled: boolean };
  dof: DofPreset & { enabled: boolean };
  outline: OutlinePreset & { enabled: boolean };
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
  // Opt-in stages: OFF by default so the shipped "Grounded Stylized Realism" look
  // (and every demo built on it) is unchanged. Callers enable per scene.
  godrays: {
    enabled: false,
    density: 0.7,
    maxDensity: 0.5,
    distanceAttenuation: 2.0,
    raymarchSteps: 60,
    intensity: 0.9,
  },
  dof: {
    enabled: false,
    focusDistance: 40,
    focalLength: 60,
    bokehScale: 2.0,
  },
  outline: {
    enabled: false,
    strength: 0.6,
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
    godrays: { ...d.godrays, ...(override?.godrays ?? {}) },
    dof: { ...d.dof, ...(override?.dof ?? {}) },
    outline: { ...d.outline, ...(override?.outline ?? {}) },
  };
}

type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> };

/** The built pipeline, with the live nodes exposed for inspection (tests) + the
 *  driver methods the render loop calls in place of `renderer.render(...)`. */
export interface PostPipeline {
  /** The three RenderPipeline object — `.outputNode` is the composited graph. */
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
  /** The godrays node (null if disabled or no shadow-casting sun was found). */
  godraysNode: unknown;
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
  const post = new (THREE as any).RenderPipeline(renderer);

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

  // ── 2b. GODRAYS — volumetric crepuscular scatter from the sun ────────────────
  // The sun = the first shadow-casting directional light; godrays raymarches its
  // shadow map (allocated on the first render — shadow.camera, which the node needs
  // at construction, already exists). Composited additively like bloom.
  // deno-lint-ignore no-explicit-any
  let godraysNode: any = null;
  if (preset.godrays.enabled) {
    // deno-lint-ignore no-explicit-any
    let sun: any = null;
    // deno-lint-ignore no-explicit-any
    (scene as any).traverse?.((o: any) => { if (!sun && o?.isDirectionalLight && o.castShadow && o.shadow?.camera) sun = o; });
    if (sun) {
      godraysNode = GODRAYS(depthNode, camera, sun);
      godraysNode.density.value = preset.godrays.density;
      godraysNode.maxDensity.value = preset.godrays.maxDensity;
      godraysNode.distanceAttenuation.value = preset.godrays.distanceAttenuation;
      godraysNode.raymarchSteps.value = preset.godrays.raymarchSteps;
      composited = composited.add(godraysNode.mul(T.float(preset.godrays.intensity)));
    }
  }

  // ── 2c. DEPTH OF FIELD — depth-driven bokeh (blurs the composited colour) ────
  if (preset.dof.enabled) {
    const viewZ = scenePass.getViewZNode();
    composited = DOF(composited, viewZ, T.float(preset.dof.focusDistance), T.float(preset.dof.focalLength), T.float(preset.dof.bokehScale));
  }

  // ── 2d. OUTLINE — full-scene Sobel cel edge (darkens where the edge fires) ───
  if (preset.outline.enabled) {
    const edge = SOBEL(composited);
    // Sobel output is a grayscale edge magnitude; use .r and darken the colour there.
    const ink = T.float(1.0).sub(edge.r.mul(T.float(preset.outline.strength))).max(0.0);
    composited = composited.mul(T.vec4(T.vec3(ink), 1.0));
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
    godraysNode,
    preset,
    render(): void {
      // Refresh the camera's world matrix from the LIVE transform BEFORE the scene
      // pass samples it. The render loop drives the camera with
      // `camera.position.set(...)` + `camera.lookAt(...)` (which sets position +
      // quaternion); the view matrix the pass renders from is derived from
      // `matrixWorld`, so it must be recomposed each frame. The bare
      // `renderer.render(scene, camera)` this pipeline replaced did this implicitly;
      // doing it here — ONE place — keeps free-fly / orbit navigation live for every
      // consumer, independent of three's internal auto-update behaviour. Cheap +
      // idempotent (a single mat4 compose; the camera has no children to recurse).
      // deno-lint-ignore no-explicit-any
      const cam = camera as any;
      if (cam && typeof cam.updateMatrixWorld === "function") cam.updateMatrixWorld(true);
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
