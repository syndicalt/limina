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
import type { RenderQualityProfile } from "./render/quality.ts";
import type { HdrEnvironmentLease } from "./render/environment-hdri.ts";

// ---- Preset --------------------------------------------------------------

/** A 3-stop vertical sky gradient (sRGB hex). `top` is the zenith, `horizon`
 *  the band at eye level, `bottom` the downward (ground-bounce) hemisphere. */
export interface SkyGradient {
  top: number;
  horizon: number;
  bottom: number;
}

/** ATMOSPHERE — distance/height haze + aerial perspective. This is what makes a
 *  world read as *vast*: distant terrain fades into a haze tinted to the horizon
 *  band, so the terrain edge dissolves into the sky instead of ending on a hard
 *  silhouette. Two models (both render-only, both proven on the WebGPU node path):
 *
 *   - DEFAULT (height OFF) — a `THREE.FogExp2`: uniform exponential distance haze.
 *     The renderer auto-converts it to `fog(color, densityFogFactor(density))`,
 *     the most-travelled + widely-supported fog path. Bulletproof; this is what
 *     ships on by default.
 *   - HEIGHT (height ON) — a `scene.fogNode` = `fog(color, exponentialHeightFog-
 *     Factor(density, ceiling))`: the haze POOLS in the low ground and THINS with
 *     altitude, so valleys/horizon go hazy while peaks stay crisp. Opt-in.
 *
 *  The aerial-perspective tint is the haze `color`: leave it `null` and it auto-
 *  matches `sky.horizon`, so distant geometry tints toward the exact horizon band
 *  it dissolves into (no hard colour seam between terrain and sky). */
export interface AtmospherePreset {
  /** Master switch for the haze (independent of the rest of the baseline). */
  enabled: boolean;
  /** Haze colour (sRGB hex). `null` ⇒ auto-match `sky.horizon` (aerial perspective
   *  into the horizon band — the recommended cohesive default). */
  color: number | null;
  /** Exponential distance-haze density (FogExp2 model, used when `height.enabled`
   *  is false). Larger = haze thickens closer in. Subtle by default — not soupy. */
  density: number;
  /** Optional HEIGHT falloff (node model). When `enabled`, the haze is densest in
   *  the low ground and clears above `ceiling` (world-Y), keeping peaks crisp.
   *  `density` here is in different units to the flat `density` above (it scales by
   *  (ceiling − y)·distance), so it is much smaller. */
  height: { enabled: boolean; ceiling: number; density: number };
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
  /** Tint of that ambient floor (sRGB hex). Default 0xffffff (neutral) — a cool hex
   *  (e.g. 0x556072) gives shadows a cool cast for a golden-hour key/cool-fill split. */
  ambientColor: number;
  /** Procedural sky gradient — drives both the background and the IBL source. */
  sky: SkyGradient;
  /** Build `scene.environment` (IBL). PMREM when a renderer is present, else a
   *  cheap gradient-equirect texture (headless fallback). */
  environment: boolean;
  /** Linear scale on the environment's contribution to lighting. */
  environmentIntensity: number;
  /** Yaw, pitch, and roll of the PBR environment in radians. */
  environmentRotation: [number, number, number];
  /** Paint the sky gradient as `scene.background` (replaces the dark void). */
  background: boolean;
  /** Linear scale on the visible sky background. */
  backgroundIntensity: number;
  /** Yaw, pitch, and roll of the visible sky in radians. */
  backgroundRotation: [number, number, number];
  /** Distance/height haze + aerial perspective so terrain fades into the horizon. */
  atmosphere: AtmospherePreset;
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
  ambientColor: 0xffffff,
  sky: { top: 0x4a7fc4, horizon: 0xcdd9e6, bottom: 0x2a2620 },
  environment: true,
  environmentIntensity: 1.0,
  environmentRotation: [0, 0, 0],
  background: true,
  backgroundIntensity: 1.0,
  backgroundRotation: [0, 0, 0],
  // GENTLE default haze: a uniform exponential distance fog tinted to the horizon
  // band (color:null ⇒ sky.horizon = 0xcdd9e6). Subtle density so near geometry stays
  // crisp and a comparison/row demo isn't washed out, while distant geometry softly
  // dissolves into the sky — depth + scale for every world, for free. A world that
  // wants the "vast island, crisp peaks" look opts into `height` (see the landscape
  // demo) or simply raises `density`.
  atmosphere: {
    enabled: true,
    color: null,
    density: 0.0011,
    height: { enabled: false, ceiling: 60, density: 0.00010 },
  },
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
  ambientColor: 0xffffff,
  // Deep tropical zenith → warm hazy horizon glow → warm sand bounce. The warm horizon
  // band is what the low-roughness water reflects as a "sunset on the sea" sheen.
  sky: { top: 0x2f7fd6, horizon: 0xffe7c4, bottom: 0x70573f },
  environment: true,
  environmentIntensity: 1.15,
  environmentRotation: [0, 0, 0],
  background: true,
  backgroundIntensity: 1.0,
  backgroundRotation: [0, 0, 0],
  // WARM beach haze: matched to the warm hazy horizon band (color:null ⇒ sky.horizon =
  // 0xffe7c4) so the distant sea + headland melt into the same golden horizon the water
  // reflects — a touch lighter density than the default since the open sea reads best with
  // a long, soft fade rather than a near wall of haze.
  atmosphere: {
    enabled: true,
    color: null,
    density: 0.0009,
    height: { enabled: false, ceiling: 40, density: 0.00010 },
  },
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
  scene: {
    add(o: unknown): void;
    remove?(o: unknown): void;
    background?: unknown;
    backgroundIntensity?: number;
    backgroundRotation?: { set(x: number, y: number, z: number): void; clone?(): unknown; copy?(value: unknown): void };
    environment?: unknown;
    environmentIntensity?: number;
    environmentRotation?: { set(x: number, y: number, z: number): void; clone?(): unknown; copy?(value: unknown): void };
    fog?: unknown;
    fogNode?: unknown;
  };
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
  environmentMode: "hdri" | "pmrem" | "gradient" | "none";
  /** WHICH haze model was installed: "exp" (FogExp2 distance fog → scene.fog),
   *  "height" (node height-falloff fog → scene.fogNode), or "none" (disabled). */
  atmosphereMode: "exp" | "height" | "none";
  /** The fog object that was installed (FogExp2) or the fog node (height mode). */
  fog?: unknown;
  /** Move the directional-shadow frustum with the active camera/orbit focus. */
  updateShadowFocus(focus: readonly [number, number, number]): void;
  /** Apply execution-quality shadow limits without changing the authored look. */
  setQuality(profile: Pick<RenderQualityProfile, "shadowMapSize" | "shadowHalfExtent">): void;
  /** Release every baseline-owned scene and GPU resource. Idempotent. */
  dispose(): void;
}

// ---- Helpers -------------------------------------------------------------

function mergeVec3(
  base: [number, number, number],
  over?: [number?, number?, number?],
): [number, number, number] {
  return [over?.[0] ?? base[0], over?.[1] ?? base[1], over?.[2] ?? base[2]];
}

function mergePreset(base: RenderBaselinePreset, over?: RenderBaselineOverride): RenderBaselinePreset {
  if (over === undefined) return { ...base };
  return {
    enabled: over.enabled ?? base.enabled,
    toneMapping: over.toneMapping ?? base.toneMapping,
    exposure: over.exposure ?? base.exposure,
    shadows: over.shadows ?? base.shadows,
    sun: { ...base.sun, ...over.sun, direction: mergeVec3(base.sun.direction, over.sun?.direction) },
    hemisphere: { ...base.hemisphere, ...over.hemisphere },
    ambientIntensity: over.ambientIntensity ?? base.ambientIntensity,
    ambientColor: over.ambientColor ?? base.ambientColor,
    sky: { ...base.sky, ...over.sky },
    environment: over.environment ?? base.environment,
    environmentIntensity: over.environmentIntensity ?? base.environmentIntensity,
    environmentRotation: mergeVec3(base.environmentRotation, over.environmentRotation),
    background: over.background ?? base.background,
    backgroundIntensity: over.backgroundIntensity ?? base.backgroundIntensity,
    backgroundRotation: mergeVec3(base.backgroundRotation, over.backgroundRotation),
    atmosphere: {
      ...base.atmosphere,
      ...over.atmosphere,
      height: { ...base.atmosphere.height, ...over.atmosphere?.height },
    },
    ground: { ...base.ground, ...over.ground },
    camera: {
      ...base.camera,
      ...over.camera,
      position: mergeVec3(base.camera.position, over.camera?.position),
      target: mergeVec3(base.camera.target, over.camera?.target),
    },
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
  writeSkyGradient(data, width, height, sky);
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function writeSkyGradient(data: Uint8Array, width: number, height: number, sky: SkyGradient): void {
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
}

export interface RenderBaselineBackground {
  readonly texture: unknown;
  update(sky: SkyGradient): void;
  dispose(): void;
}

/** One mutable equirectangular background per renderer host avoids unbounded
 * Three.js conversion targets when Edit worlds are repeatedly replaced. */
export function createRenderBaselineBackground(): RenderBaselineBackground {
  const width = 16;
  const height = 128;
  const texture = buildSkyEquirect(DEFAULT_RENDER_BASELINE.sky) as THREE.DataTexture;
  texture.userData.liminaLifetime = "host";
  let disposed = false;
  return {
    texture,
    update(sky): void {
      if (disposed) throw new Error("render baseline background is disposed");
      writeSkyGradient(texture.image.data as Uint8Array, width, height, sky);
      texture.needsUpdate = true;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      texture.dispose();
    },
  };
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
  sharedBackground?: RenderBaselineBackground,
  hdrEnvironment?: HdrEnvironmentLease,
): AppliedRenderBaseline {
  const preset = mergePreset(DEFAULT_RENDER_BASELINE, override);
  if (!preset.enabled) {
    hdrEnvironment?.release();
    return {
      preset,
      environmentMode: "none",
      atmosphereMode: "none",
      updateShadowFocus(): void {},
      setQuality(): void {},
      dispose(): void {},
    };
  }

  const { scene, renderer, camera } = target;
  const previousScene = {
    background: scene.background,
    backgroundIntensity: scene.backgroundIntensity,
    backgroundRotation: scene.backgroundRotation?.clone?.(),
    environment: scene.environment,
    environmentIntensity: scene.environmentIntensity,
    environmentRotation: scene.environmentRotation?.clone?.(),
    fog: scene.fog,
    fogNode: scene.fogNode,
  };

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
  const sunDistance = Math.max(1, sun.position.length());
  const sunDirection = sun.position.clone().normalize();
  let shadowHalfExtent = Math.max(10, preset.ground.size * 0.35);
  let shadowMapSize = 2048;
  if (preset.shadows) {
    sun.castShadow = true;
    // A tight ortho frustum around the default ground keeps shadow texels dense.
    const cam = sun.shadow.camera as { left: number; right: number; top: number; bottom: number; near: number; far: number };
    cam.left = -shadowHalfExtent; cam.right = shadowHalfExtent; cam.top = shadowHalfExtent; cam.bottom = -shadowHalfExtent;
    cam.near = 0.5; cam.far = 200;
    sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
  }
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(
    preset.hemisphere.skyColor,
    preset.hemisphere.groundColor,
    preset.hemisphere.intensity,
  );
  scene.add(hemi);

  let ambient: unknown;
  if (preset.ambientIntensity > 0) {
    ambient = new THREE.AmbientLight(preset.ambientColor, preset.ambientIntensity);
    scene.add(ambient);
  }

  // 3. Sky gradient → background + IBL environment.
  const skyTex = buildSkyEquirect(preset.sky);
  let backgroundTex: unknown;
  if (preset.background && "background" in scene) {
    if (hdrEnvironment !== undefined) {
      backgroundTex = hdrEnvironment.background;
    } else if (sharedBackground !== undefined) {
      sharedBackground.update(preset.sky);
      backgroundTex = sharedBackground.texture;
    } else {
      backgroundTex = skyTex;
    }
    scene.background = backgroundTex;
    if ("backgroundIntensity" in scene) scene.backgroundIntensity = preset.backgroundIntensity;
    scene.backgroundRotation?.set(...preset.backgroundRotation);
  }

  let environmentMode: AppliedRenderBaseline["environmentMode"] = "none";
  let environmentTexture: unknown;
  let pmremTarget: { texture?: unknown; dispose?(): void } | undefined;
  if (preset.environment) {
    let envTexture: unknown = hdrEnvironment?.environment ?? skyTex; // fallback: the gradient itself
    if (hdrEnvironment !== undefined) {
      environmentMode = "hdri";
    } else if (rendererIsUsable(renderer)) {
      // PMREM needs a live renderer/GPU. Try it; on ANY failure fall back to
      // the cheap gradient (never ship a broken environment, never throw).
      let pmrem: { fromEquirectangular(texture: unknown): unknown; dispose(): void } | undefined;
      try {
        pmrem = new THREE.PMREMGenerator(renderer as never);
        const rt = pmrem.fromEquirectangular(skyTex) as { texture: unknown; dispose?(): void };
        pmremTarget = rt;
        envTexture = rt.texture;
        environmentMode = "pmrem";
      } catch {
        envTexture = skyTex;
        environmentMode = "gradient";
      } finally {
        pmrem?.dispose();
      }
    } else {
      environmentMode = "gradient";
    }
    environmentTexture = envTexture;
    scene.environment = envTexture;
    if ("environmentIntensity" in scene) {
      scene.environmentIntensity = preset.environmentIntensity;
    }
    scene.environmentRotation?.set(...preset.environmentRotation);
  }

  // 3b. ATMOSPHERE — distance/height haze so terrain dissolves into the horizon.
  //     Render-only; the haze colour defaults to the sky's horizon band, so the
  //     terrain edge melts into the same colour the sky shows there (no hard seam).
  //     The sky `background` is NOT a fogged material, so it stays as the sky —
  //     only the in-scene geometry (terrain/water/props) fades into the haze.
  let fog: unknown;
  let atmosphereMode: AppliedRenderBaseline["atmosphereMode"] = "none";
  const atm = preset.atmosphere;
  if (atm.enabled && ("fog" in scene || "fogNode" in scene)) {
    const hazeColor = atm.color ?? preset.sky.horizon;
    if (atm.height.enabled) {
      // HEIGHT model — a node fog that pools low and clears above `ceiling`.
      // deno-lint-ignore no-explicit-any
      const T = (THREE as any).TSL;
      const factor = T.exponentialHeightFogFactor(T.float(atm.height.density), T.float(atm.height.ceiling));
      const node = T.fog(T.color(hazeColor), factor);
      scene.fogNode = node;
      scene.fog = null; // node fog supersedes any FogExp2
      fog = node;
      atmosphereMode = "height";
    } else {
      // DEFAULT model — uniform exponential distance fog (auto-converted by the
      // renderer to the proven fog(color, densityFogFactor) node path).
      const exp = new THREE.FogExp2(hazeColor, atm.density);
      scene.fog = exp;
      scene.fogNode = null; // ensure no stale node fog wins over the FogExp2
      fog = exp;
      atmosphereMode = "exp";
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

  const shadowRight = new THREE.Vector3();
  const shadowUp = new THREE.Vector3();
  const shadowFocus = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0);
  shadowRight.crossVectors(worldUp, sunDirection);
  if (shadowRight.lengthSq() < 1e-10) shadowRight.set(1, 0, 0);
  else shadowRight.normalize();
  shadowUp.crossVectors(sunDirection, shadowRight).normalize();

  const updateShadowFocus = (focus: readonly [number, number, number]): void => {
    if (!preset.shadows) return;
    if (focus.length !== 3 || focus.some((value) => !Number.isFinite(value))) {
      throw new TypeError("shadow focus must contain three finite world coordinates");
    }
    shadowFocus.set(focus[0], focus[1], focus[2]);
    const texel = (2 * shadowHalfExtent) / shadowMapSize;
    const right = Math.round(shadowFocus.dot(shadowRight) / texel) * texel;
    const up = Math.round(shadowFocus.dot(shadowUp) / texel) * texel;
    const depth = shadowFocus.dot(sunDirection);
    shadowFocus.copy(shadowRight).multiplyScalar(right)
      .addScaledVector(shadowUp, up)
      .addScaledVector(sunDirection, depth);
    sun.target.position.copy(shadowFocus);
    sun.position.copy(shadowFocus).addScaledVector(sunDirection, sunDistance);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
  };

  const setQuality = (profile: Pick<RenderQualityProfile, "shadowMapSize" | "shadowHalfExtent">): void => {
    if (!preset.shadows) return;
    const nextMapSize = profile?.shadowMapSize;
    const nextHalfExtent = profile?.shadowHalfExtent;
    if (!Number.isSafeInteger(nextMapSize) || nextMapSize < 256 || nextMapSize > 8192 || (nextMapSize & (nextMapSize - 1)) !== 0) {
      throw new RangeError("shadowMapSize must be a power-of-two integer in [256, 8192]");
    }
    if (typeof nextHalfExtent !== "number" || !Number.isFinite(nextHalfExtent) || nextHalfExtent < 8 || nextHalfExtent > 2048) {
      throw new RangeError("shadowHalfExtent must be finite and in [8, 2048]");
    }
    const mapChanged = shadowMapSize !== nextMapSize;
    shadowMapSize = nextMapSize;
    shadowHalfExtent = nextHalfExtent;
    const shadowCamera = sun.shadow.camera as { left: number; right: number; top: number; bottom: number; updateProjectionMatrix?(): void };
    shadowCamera.left = -shadowHalfExtent;
    shadowCamera.right = shadowHalfExtent;
    shadowCamera.top = shadowHalfExtent;
    shadowCamera.bottom = -shadowHalfExtent;
    shadowCamera.updateProjectionMatrix?.();
    sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    if (mapChanged && sun.shadow.map !== null) {
      try { sun.shadow.map?.dispose(); }
      finally { sun.shadow.map = null; }
    }
  };

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    const cleanup = (label: string, operation: () => void): void => {
      try { operation(); }
      catch (error) { console.warn(`render baseline ${label} cleanup failed`, error); }
    };
    if (ground !== undefined) cleanup("ground scene", () => scene.remove?.(ground));
    if (ambient !== undefined) cleanup("ambient scene", () => scene.remove?.(ambient));
    cleanup("hemisphere scene", () => scene.remove?.(hemi));
    cleanup("sun target scene", () => scene.remove?.(sun.target));
    cleanup("sun scene", () => scene.remove?.(sun));
    const ownedGround = ground as { geometry?: { dispose?(): void }; material?: { dispose?(): void } } | undefined;
    cleanup("ground geometry", () => ownedGround?.geometry?.dispose?.());
    cleanup("ground material", () => ownedGround?.material?.dispose?.());
    cleanup("sun", () => sun.dispose());
    cleanup("environment", () => pmremTarget?.dispose?.());
    cleanup("sky", () => (skyTex as { dispose?(): void }).dispose?.());
    cleanup("HDR lease", () => hdrEnvironment?.release());
    if (scene.background === backgroundTex) scene.background = previousScene.background;
    if (scene.background === previousScene.background) {
      if ("backgroundIntensity" in scene) scene.backgroundIntensity = previousScene.backgroundIntensity;
      if (previousScene.backgroundRotation !== undefined) scene.backgroundRotation?.copy?.(previousScene.backgroundRotation);
    }
    if (preset.environment && scene.environment === environmentTexture) {
      scene.environment = previousScene.environment;
      if ("environmentIntensity" in scene) scene.environmentIntensity = previousScene.environmentIntensity;
      if (previousScene.environmentRotation !== undefined) scene.environmentRotation?.copy?.(previousScene.environmentRotation);
    }
    if (atmosphereMode === "height" && scene.fogNode === fog) scene.fogNode = previousScene.fogNode;
    if (atmosphereMode === "height" && scene.fog === null) scene.fog = previousScene.fog;
    if (atmosphereMode === "exp" && scene.fog === fog) scene.fog = previousScene.fog;
    if (atmosphereMode === "exp" && scene.fogNode === null) scene.fogNode = previousScene.fogNode;
  };

  return {
    preset,
    sun,
    hemisphere: hemi,
    ambient,
    ground,
    environmentMode,
    atmosphereMode,
    fog,
    updateShadowFocus,
    setQuality,
    dispose,
  };
}
