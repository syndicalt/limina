// Phase 11 RENDER BASELINE — the single source of truth that makes every limina
// world look *rendered* by default (lit + environment-lit + tonemapped) instead
// of an unlit void. `applyRenderBaseline(engine, preset?)` installs, onto the
// engine's scene / renderer / camera:
//
//   - a key SUN (DirectionalLight, soft shadows) + a HEMISPHERE fill (cool sky
//     from above, warm bounce from below),
//   - a procedural SKY gradient that drives `scene.environment` via PMREM (IBL:
//     ambient + reflections for PBR/node materials — the biggest "looks rendered"
//     jump) and replaces the dark background,
//   - a default GROUND plane + a sensible default CAMERA framing,
//   - ACES tonemapping + exposure (kept, fully overridable).
//
// It is ON BY DEFAULT (called from createEngine) and fully overridable through
// the preset. It is WebGPU-safe (THREE.WebGPURenderer + node materials) and
// HEADLESS-safe: PMREM needs a live renderer/GPU, so when no usable renderer is
// present (the headless test suite) it degrades gracefully — lights + a cheap
// gradient-equirect environment are still installed, PMREM is skipped, nothing
// throws. No `Deno.*`, no host ops: this is pure three.js, so it is portable.

import * as THREE from "../build/three.bundle.mjs";

// ---- Preset --------------------------------------------------------------

/** A 3-stop vertical sky gradient (sRGB hex). `top` is the zenith, `horizon`
 *  the band at eye level, `bottom` the downward (ground-bounce) hemisphere. */
export interface SkyGradient {
  top: number;
  horizon: number;
  bottom: number;
}

/** The full render-baseline configuration. Every field has a tasteful default
 *  (DEFAULT_RENDER_BASELINE); `applyRenderBaseline` accepts a deep-partial
 *  override so a world can tweak one knob without restating the rest. */
export interface RenderBaselinePreset {
  /** Master switch — `false` makes applyRenderBaseline a no-op (void by choice). */
  enabled: boolean;
  /** THREE tonemapping operator constant (default ACESFilmicToneMapping). */
  toneMapping: number;
  /** Linear exposure multiplier applied after tonemapping. */
  exposure: number;
  /** Real-time shadow maps on the sun (PCF-soft, configured by the renderer). */
  shadows: boolean;
  /** Key light: a single directional "sun". `direction` points FROM the scene
   *  TOWARD the light (i.e. the light sits at `direction` looking at origin). */
  sun: { color: number; intensity: number; direction: [number, number, number] };
  /** Hemisphere fill — cool sky tint from above, warm ground bounce from below. */
  hemisphere: { skyColor: number; groundColor: number; intensity: number };
  /** A faint omnidirectional ambient floor so deep shadows never crush to black. */
  ambientIntensity: number;
  /** Procedural sky gradient — drives both the background and the IBL source. */
  sky: SkyGradient;
  /** Build `scene.environment` (IBL). PMREM when a renderer is present, else a
   *  cheap gradient-equirect texture (headless fallback). */
  environment: boolean;
  /** Linear scale on the environment's contribution to lighting. */
  environmentIntensity: number;
  /** Paint the sky gradient as `scene.background` (replaces the dark void). */
  background: boolean;
  /** Default ground plane so bodies are grounded and catch the sun's shadow. */
  ground: { enabled: boolean; color: number; size: number; y: number; roughness: number };
  /** Default camera framing (a world may override per frame). */
  camera: { position: [number, number, number]; target: [number, number, number]; far: number };
}

/** Tasteful default: a clear-day key sun from the upper-right, a cool/warm
 *  hemisphere fill, a blue→haze→earth sky gradient driving the IBL, a matte
 *  ground, and a 3/4 orbit-friendly camera. ACES @ exposure 1.0. */
export const DEFAULT_RENDER_BASELINE: RenderBaselinePreset = {
  enabled: true,
  toneMapping: THREE.ACESFilmicToneMapping,
  exposure: 1.0,
  shadows: true,
  sun: { color: 0xfff4e6, intensity: 3.0, direction: [5, 9, 6] },
  hemisphere: { skyColor: 0x9bb8ff, groundColor: 0x6b5a44, intensity: 0.9 },
  ambientIntensity: 0.15,
  sky: { top: 0x4a7fc4, horizon: 0xcdd9e6, bottom: 0x2a2620 },
  environment: true,
  environmentIntensity: 1.0,
  background: true,
  ground: { enabled: true, color: 0x3a4250, size: 80, y: 0, roughness: 0.95 },
  camera: { position: [12, 8, 14], target: [0, 1, 0], far: 200 },
};

/** NAMED preset — a warm "golden-hour tropical beach" look. ADDITIVE: it does NOT
 *  touch DEFAULT_RENDER_BASELINE (every other world stays byte-identical), it is opt-in
 *  by a world passing it to `createEngine({ renderBaseline })` (e.g. the cottage-beach
 *  window demo). Differences from the default: a warm low-ish sun, a tropical-blue→warm-
 *  hazy-horizon sky (so the IBL warms the sand and the water reflects a sunset-tinted
 *  sky), a sandy-bounce hemisphere fill, slightly lifted exposure + environment so the
 *  sand glows and the sea sparkles without blowing the highlights. */
export const TROPICAL_BEACH_BASELINE: RenderBaselinePreset = {
  enabled: true,
  toneMapping: THREE.ACESFilmicToneMapping,
  // A touch hotter than 1.0 so the sand reads sun-warmed; ACES rolls off the glints
  // so the foam line and sky reflection stay inside the highlight shoulder.
  exposure: 1.12,
  shadows: true,
  // Warm golden sun, raked lower-left so the beach gets long warm light + soft shadows.
  sun: { color: 0xffd9a0, intensity: 3.3, direction: [6, 6, 7] },
  // Tropical sky tint from above, warm dry-sand bounce from below.
  hemisphere: { skyColor: 0x9fd0ff, groundColor: 0xc9a878, intensity: 0.85 },
  ambientIntensity: 0.16,
  // Deep tropical zenith → warm hazy horizon glow → warm sand bounce. The warm horizon
  // band is what the low-roughness water reflects as a "sunset on the sea" sheen.
  sky: { top: 0x2f7fd6, horizon: 0xffe7c4, bottom: 0x70573f },
  environment: true,
  environmentIntensity: 1.15,
  background: true,
  ground: { enabled: true, color: 0xCBA56B, size: 80, y: 0, roughness: 0.95 },
  camera: { position: [12, 8, 14], target: [0, 1, 0], far: 200 },
};

// A deep-partial of the preset (override any nested knob in isolation).
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type RenderBaselineOverride = DeepPartial<RenderBaselinePreset>;

// ---- Minimal target surface ----------------------------------------------
// applyRenderBaseline only needs scene/renderer/camera, so it accepts a loose
// shape — the full Engine, the browser playback target, or a test stub.

interface BaselineTarget {
  scene: { add(o: unknown): void; background?: unknown; environment?: unknown; environmentIntensity?: number };
  camera?: {
    position?: { set(x: number, y: number, z: number): void };
    lookAt?(x: number, y: number, z: number): void;
    far?: number;
    updateProjectionMatrix?(): void;
  };
  renderer?: {
    render?(s: unknown, c: unknown): void;
    shadowMap?: { enabled: boolean; type?: number };
    toneMapping?: number;
    toneMappingExposure?: number;
  };
}

/** What `applyRenderBaseline` installed — handy for tests and teardown. The
 *  `environmentMode` records WHICH IBL path ran ("pmrem" live, "gradient"
 *  headless fallback, or "none" when disabled / failed-and-skipped). */
export interface AppliedRenderBaseline {
  preset: RenderBaselinePreset;
  sun?: unknown;
  hemisphere?: unknown;
  ambient?: unknown;
  ground?: unknown;
  environmentMode: "pmrem" | "gradient" | "none";
}

// ---- Helpers -------------------------------------------------------------

function mergePreset(base: RenderBaselinePreset, over?: RenderBaselineOverride): RenderBaselinePreset {
  if (over === undefined) return { ...base };
  return {
    enabled: over.enabled ?? base.enabled,
    toneMapping: over.toneMapping ?? base.toneMapping,
    exposure: over.exposure ?? base.exposure,
    shadows: over.shadows ?? base.shadows,
    sun: { ...base.sun, ...over.sun },
    hemisphere: { ...base.hemisphere, ...over.hemisphere },
    ambientIntensity: over.ambientIntensity ?? base.ambientIntensity,
    sky: { ...base.sky, ...over.sky },
    environment: over.environment ?? base.environment,
    environmentIntensity: over.environmentIntensity ?? base.environmentIntensity,
    background: over.background ?? base.background,
    ground: { ...base.ground, ...over.ground },
    camera: { ...base.camera, ...over.camera },
  };
}

function lerpByte(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** Build a vertical-gradient EQUIRECTANGULAR texture from the 3-stop sky. Rows
 *  run top (zenith) → bottom (nadir): top→horizon over the upper half, then
 *  horizon→bottom over the lower half. This is both the IBL source (PMREM input
 *  or the headless environment directly) and the scene background. Cheap (no
 *  GPU): a width×height RGBA byte texture tagged equirect + sRGB. */
function buildSkyEquirect(sky: SkyGradient): unknown {
  const width = 16;
  const height = 128;
  const data = new Uint8Array(width * height * 4);
  const top = [(sky.top >> 16) & 0xff, (sky.top >> 8) & 0xff, sky.top & 0xff];
  const hor = [(sky.horizon >> 16) & 0xff, (sky.horizon >> 8) & 0xff, sky.horizon & 0xff];
  const bot = [(sky.bottom >> 16) & 0xff, (sky.bottom >> 8) & 0xff, sky.bottom & 0xff];
  for (let y = 0; y < height; y++) {
    const v = y / (height - 1); // 0 = top row
    let r: number, g: number, b: number;
    if (v < 0.5) {
      const t = v / 0.5;
      r = lerpByte(top[0], hor[0], t); g = lerpByte(top[1], hor[1], t); b = lerpByte(top[2], hor[2], t);
    } else {
      const t = (v - 0.5) / 0.5;
      r = lerpByte(hor[0], bot[0], t); g = lerpByte(hor[1], bot[1], t); b = lerpByte(hor[2], bot[2], t);
    }
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function rendererIsUsable(r: BaselineTarget["renderer"]): boolean {
  return !!r && typeof r.render === "function";
}

// ---- Public API ----------------------------------------------------------

/** Install the render baseline onto `target` (an Engine or any scene/renderer/
 *  camera bundle). Idempotent-enough for one-time setup; returns what it added.
 *  Safe to call headlessly (no renderer) — PMREM is skipped, a gradient
 *  environment is set instead, and nothing throws. */
export function applyRenderBaseline(
  target: BaselineTarget,
  override?: RenderBaselineOverride,
): AppliedRenderBaseline {
  const preset = mergePreset(DEFAULT_RENDER_BASELINE, override);
  if (!preset.enabled) return { preset, environmentMode: "none" };

  const { scene, renderer, camera } = target;

  // 1. Renderer: ACES tonemapping + exposure + soft shadows (overridable).
  if (renderer !== undefined) {
    renderer.toneMapping = preset.toneMapping;
    renderer.toneMappingExposure = preset.exposure;
    if (renderer.shadowMap !== undefined) {
      renderer.shadowMap.enabled = preset.shadows;
      if (preset.shadows && renderer.shadowMap.type === undefined) {
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      }
    }
  }

  // 2. Lighting — key sun + hemisphere fill + a faint ambient floor.
  const [sx, sy, sz] = preset.sun.direction;
  const sun = new THREE.DirectionalLight(preset.sun.color, preset.sun.intensity);
  sun.position.set(sx, sy, sz);
  if (preset.shadows) {
    sun.castShadow = true;
    // A tight ortho frustum around the default ground keeps shadow texels dense.
    const cam = sun.shadow.camera as { left: number; right: number; top: number; bottom: number; near: number; far: number };
    const half = Math.max(10, preset.ground.size * 0.35);
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
    cam.near = 0.5; cam.far = 200;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
  }
  scene.add(sun);

  const hemi = new THREE.HemisphereLight(
    preset.hemisphere.skyColor,
    preset.hemisphere.groundColor,
    preset.hemisphere.intensity,
  );
  scene.add(hemi);

  let ambient: unknown;
  if (preset.ambientIntensity > 0) {
    ambient = new THREE.AmbientLight(0xffffff, preset.ambientIntensity);
    scene.add(ambient);
  }

  // 3. Sky gradient → background + IBL environment.
  const skyTex = buildSkyEquirect(preset.sky);
  if (preset.background && "background" in scene) {
    scene.background = skyTex;
  }

  let environmentMode: AppliedRenderBaseline["environmentMode"] = "none";
  if (preset.environment) {
    let envTexture: unknown = skyTex; // fallback: the gradient itself
    if (rendererIsUsable(renderer)) {
      // PMREM needs a live renderer/GPU. Try it; on ANY failure fall back to
      // the cheap gradient (never ship a broken environment, never throw).
      try {
        const pmrem = new THREE.PMREMGenerator(renderer);
        const rt = pmrem.fromEquirectangular(skyTex as never);
        envTexture = (rt as { texture: unknown }).texture;
        pmrem.dispose();
        environmentMode = "pmrem";
      } catch {
        envTexture = skyTex;
        environmentMode = "gradient";
      }
    } else {
      environmentMode = "gradient";
    }
    scene.environment = envTexture;
    if ("environmentIntensity" in scene) {
      scene.environmentIntensity = preset.environmentIntensity;
    }
  }

  // 4. Ground plane (receives the sun's shadow).
  let ground: unknown;
  if (preset.ground.enabled) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(preset.ground.size, preset.ground.size),
      new THREE.MeshStandardNodeMaterial({ color: preset.ground.color, roughness: preset.ground.roughness, metalness: 0.0 }),
    );
    // PlaneGeometry is XY-facing by default; rotate it flat (XZ).
    (mesh as { rotation: { x: number } }).rotation.x = -Math.PI / 2;
    mesh.position.set(0, preset.ground.y, 0);
    if (preset.shadows) (mesh as { receiveShadow: boolean }).receiveShadow = true;
    scene.add(mesh);
    ground = mesh;
  }

  // 5. Default camera framing (a world may override per frame).
  if (camera !== undefined) {
    const [px, py, pz] = preset.camera.position;
    camera.position?.set(px, py, pz);
    if (camera.far !== undefined) {
      camera.far = preset.camera.far;
      camera.updateProjectionMatrix?.();
    }
    const [tx, ty, tz] = preset.camera.target;
    camera.lookAt?.(tx, ty, tz);
  }

  return { preset, sun, hemisphere: hemi, ambient, ground, environmentMode };
}
