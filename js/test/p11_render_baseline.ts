// Phase 11 RENDER BASELINE — headless verification.
//
// applyRenderBaseline() is the single source of truth that makes every limina
// world look *rendered* (lit + IBL + tonemapped sky) instead of an unlit void.
// createEngine() needs a live WebGPU adapter (window-only), so this proves the
// baseline directly on real three.js Scene/Camera objects, exercising BOTH:
//   (a) the headless fallback — no usable renderer -> lights + a cheap gradient
//       environment, PMREM skipped, nothing thrown;
//   (b) preset overrides actually taking effect (exposure / sun / ground / IBL).
//
// Run: limina js/test/p11_render_baseline.ts   (exit 0 = pass)

import * as THREE from "../build/three.bundle.mjs";
import {
  applyRenderBaseline,
  DEFAULT_RENDER_BASELINE,
  type RenderBaselineOverride,
} from "../src/render-baseline.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p11_render_baseline FAIL: " + msg);
}

interface LightFlags {
  isDirectionalLight?: boolean;
  isHemisphereLight?: boolean;
  isAmbientLight?: boolean;
  isMesh?: boolean;
  intensity?: number;
  castShadow?: boolean;
}
function children(scene: unknown): LightFlags[] {
  return (scene as { children: LightFlags[] }).children;
}
function count(scene: unknown, pred: (c: LightFlags) => boolean): number {
  return children(scene).filter(pred).length;
}

// ===========================================================================
// 1. Default baseline, HEADLESS (no renderer) — full kit installed, IBL falls
//    back to the gradient environment, nothing throws.
// ===========================================================================
{
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  const applied = applyRenderBaseline({ scene, camera });

  assert(count(scene, (c) => c.isDirectionalLight === true) === 1, "expected exactly one sun (DirectionalLight)");
  assert(count(scene, (c) => c.isHemisphereLight === true) === 1, "expected a hemisphere fill light");
  assert(count(scene, (c) => c.isAmbientLight === true) === 1, "expected a faint ambient floor");
  assert(count(scene, (c) => c.isMesh === true) === 1, "expected a default ground plane");

  // The sun casts shadows by default.
  const sun = children(scene).find((c) => c.isDirectionalLight === true)!;
  assert(sun.castShadow === true, "sun should cast shadows by default");

  // IBL: headless -> the gradient-equirect environment is set (PMREM skipped).
  assert(applied.environmentMode === "gradient", `headless env mode should be 'gradient', got '${applied.environmentMode}'`);
  assert((scene as { environment: unknown }).environment != null, "scene.environment must be set (gradient fallback)");
  assert((scene as { environment: { isTexture?: boolean } }).environment.isTexture === true, "environment must be a texture");

  // Sky background replaced the dark void with the gradient texture.
  const bg = (scene as { background: { isTexture?: boolean; isColor?: boolean } }).background;
  assert(bg != null && bg.isTexture === true, "background should be the sky-gradient texture");

  // ATMOSPHERE (Phase-2 terrain-quality overhaul) — default-ON. The default model is a
  // uniform exponential distance haze (THREE.FogExp2) so distant terrain fades into the
  // horizon. The haze colour auto-matches the sky's horizon band (color:null) so the
  // terrain edge dissolves into the sky with no hard colour seam. (Re-baselined here on
  // purpose: atmosphere is now a built-in default capability of every world.)
  assert(applied.atmosphereMode === "exp", `default atmosphere should be FogExp2 ('exp'), got '${applied.atmosphereMode}'`);
  const fog = (scene as { fog: { isFogExp2?: boolean; density?: number; color?: { getHex(cs?: number): number } } }).fog;
  assert(fog != null && fog.isFogExp2 === true, "scene.fog must be a FogExp2 by default");
  assert(fog.density === DEFAULT_RENDER_BASELINE.atmosphere.density, `fog density must match the preset (got ${fog.density})`);
  // color:null ⇒ the haze takes the sky.horizon colour (aerial perspective into the horizon).
  assert(
    fog.color!.getHex(THREE.SRGBColorSpace) === DEFAULT_RENDER_BASELINE.sky.horizon,
    "default haze colour must auto-match sky.horizon (aerial perspective, no seam)",
  );
  assert(DEFAULT_RENDER_BASELINE.atmosphere.enabled === true, "atmosphere must be on by default in DEFAULT_RENDER_BASELINE");
  assert(DEFAULT_RENDER_BASELINE.atmosphere.height.enabled === false, "default atmosphere uses the uniform exp model (height off)");

  // Camera framed at the default position/target.
  const pos = (camera as { position: { x: number; y: number; z: number } }).position;
  const [dx, dy, dz] = DEFAULT_RENDER_BASELINE.camera.position;
  assert(pos.x === dx && pos.y === dy && pos.z === dz, "camera should be framed at the default position");
  assert((camera as { far: number }).far === DEFAULT_RENDER_BASELINE.camera.far, "camera far should match preset");
}

// ===========================================================================
// 2. Renderer present (stub) — ACES tonemapping + exposure + soft shadows are
//    applied to the renderer. PMREM is attempted then gracefully falls back on
//    the stub (no GPU backend) without throwing.
// ===========================================================================
{
  const scene = new THREE.Scene();
  const renderer = {
    render(): void {},
    shadowMap: { enabled: false, type: undefined as number | undefined },
    toneMapping: 0,
    toneMappingExposure: 0,
  };
  const applied = applyRenderBaseline({ scene, renderer });

  assert(renderer.toneMapping === THREE.ACESFilmicToneMapping, "renderer.toneMapping must be ACES by default");
  assert(renderer.toneMappingExposure === 1.0, "default exposure must be 1.0");
  assert(renderer.shadowMap.enabled === true, "soft shadows must be enabled by default");
  assert(renderer.shadowMap.type === THREE.PCFSoftShadowMap, "shadow type must default to PCFSoftShadowMap");
  // PMREM cannot succeed on a backend-less stub; it must degrade, not throw.
  assert(applied.environmentMode === "gradient", "stub renderer must fall back to the gradient environment");
  assert((scene as { environment: unknown }).environment != null, "environment must still be set on the fallback path");
}

// ===========================================================================
// 3. Preset overrides take effect — exposure, sun intensity, ground OFF,
//    custom tonemapping, environment OFF.
// ===========================================================================
{
  const scene = new THREE.Scene();
  const renderer = { render(): void {}, shadowMap: { enabled: false, type: undefined as number | undefined }, toneMapping: 0, toneMappingExposure: 0 };
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  const override: RenderBaselineOverride = {
    exposure: 0.6,
    toneMapping: THREE.LinearToneMapping ?? 1,
    sun: { intensity: 7.5 },
    ground: { enabled: false },
    environment: false,
    camera: { position: [3, 4, 5], far: 50 },
  };
  const applied = applyRenderBaseline({ scene, renderer, camera }, override);

  assert(renderer.toneMappingExposure === 0.6, "exposure override must apply");
  assert(renderer.toneMapping === (THREE.LinearToneMapping ?? 1), "tonemapping override must apply");
  const sun = children(scene).find((c) => c.isDirectionalLight === true)!;
  assert(sun.intensity === 7.5, `sun intensity override must apply (got ${sun.intensity})`);
  assert(count(scene, (c) => c.isMesh === true) === 0, "ground:enabled=false must add no ground plane");
  assert(applied.environmentMode === "none" && (scene as { environment: unknown }).environment == null, "environment:false must skip IBL");
  assert(applied.preset.camera.far === 50, "camera override must merge into the applied preset");
  assert((camera as { far: number }).far === 50, "camera far override must reach the camera");
}

// ===========================================================================
// 3b. ATMOSPHERE overrides — the opt-in HEIGHT model installs a node fog
//     (scene.fogNode, haze pools low + clears with altitude) and supersedes the
//     FogExp2; a custom haze colour overrides the sky-horizon auto-match; and
//     atmosphere:{enabled:false} installs no fog at all.
// ===========================================================================
{
  // Height model + custom colour.
  const scene = new THREE.Scene();
  const applied = applyRenderBaseline({ scene }, {
    atmosphere: { color: 0x88aacc, height: { enabled: true, ceiling: 35, density: 0.00012 } },
  });
  assert(applied.atmosphereMode === "height", `height override must select the node model (got '${applied.atmosphereMode}')`);
  const fogNode = (scene as { fogNode: { isNode?: boolean } | null }).fogNode;
  assert(fogNode != null && fogNode.isNode === true, "height atmosphere must install a scene.fogNode (TSL node)");
  assert((scene as { fog: unknown }).fog == null, "height (node) fog must supersede / clear any FogExp2");
  assert(applied.preset.atmosphere.color === 0x88aacc, "custom haze colour override must merge into the preset");
  assert(applied.preset.atmosphere.height.ceiling === 35, "height.ceiling override must merge");
}
{
  // Atmosphere fully off — no fog of either kind.
  const scene = new THREE.Scene();
  const applied = applyRenderBaseline({ scene }, { atmosphere: { enabled: false } });
  assert(applied.atmosphereMode === "none", "atmosphere:{enabled:false} must install no fog");
  assert((scene as { fog: unknown }).fog == null, "atmosphere off must leave scene.fog unset");
  assert((scene as { fogNode: unknown }).fogNode == null, "atmosphere off must leave scene.fogNode unset");
}

// ===========================================================================
// 4. Master switch — enabled:false is a true no-op (a bare scene by choice).
// ===========================================================================
{
  const scene = new THREE.Scene();
  const applied = applyRenderBaseline({ scene }, { enabled: false });
  assert(children(scene).length === 0, "enabled:false must add nothing to the scene");
  assert(applied.environmentMode === "none", "disabled baseline reports no environment");
  assert((scene as { environment: unknown }).environment == null, "disabled baseline must not set environment");
  assert(applied.atmosphereMode === "none", "disabled baseline reports no atmosphere");
  assert((scene as { fog: unknown }).fog == null, "disabled baseline must not set fog");
}

(globalThis as { console?: { log(s: string): void } }).console?.log(
  "p11_render_baseline OK: default baseline installs sun+hemisphere+ambient+ground, " +
  "sky-gradient background + IBL (PMREM live / gradient headless fallback), ACES tonemapping, " +
  "+ default-ON ATMOSPHERE (FogExp2 distance haze auto-matched to sky.horizon; opt-in height-falloff node fog); " +
  "renderer tonemapping/exposure/shadows applied; preset overrides (exposure/sun/ground/env/camera/atmosphere) take effect; " +
  "enabled:false is a no-op.",
);
