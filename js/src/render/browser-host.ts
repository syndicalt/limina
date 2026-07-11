import * as THREE from "../../build/three.bundle.mjs";
import {
  applyRenderBaseline,
  createRenderBaselineBackground,
  type AppliedRenderBaseline,
  type RenderBaselineBackground,
  type RenderBaselineOverride,
} from "../render-baseline.ts";
import { resolveRenderQuality, type RenderQualityOverride, type RenderQualityProfile, type RenderQualityTier } from "./quality.ts";
import { RenderTelemetryRing, type RenderTelemetrySnapshot, type RendererInfoLike } from "./telemetry.ts";
import { GltfSceneCache, type GltfSceneCacheOptions } from "../skills/three.ts";

export const RENDER_RESOURCE_HOST_LIFETIME = "host";

export interface BrowserRenderHostOptions {
  canvas: HTMLCanvasElement;
  forceWebGL?: boolean;
  initialQuality?: RenderQualityTier;
  devicePixelRatio?: number;
  qualityOverride?: RenderQualityOverride;
  gltfCache?: GltfSceneCacheOptions;
  onTelemetry?: (snapshot: Readonly<RenderTelemetrySnapshot>) => void;
  now?: () => number;
}

export interface AcquireRenderWorldOptions {
  width: number;
  height: number;
  baseline: RenderBaselineOverride | false;
  onTelemetry?: (snapshot: Readonly<RenderTelemetrySnapshot>) => void;
}

export interface BrowserRenderWorldSession {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly baseline?: AppliedRenderBaseline;
  quality(): Readonly<RenderQualityProfile>;
  setQuality(tier: RenderQualityTier): Readonly<RenderQualityProfile>;
  resize(width: number, height: number): void;
  updateShadowFocus(focus: readonly [number, number, number]): void;
  render(draw: () => void): void;
  telemetry(): Readonly<RenderTelemetrySnapshot>;
  dispose(): void;
}

export interface BrowserRenderHost {
  readonly canvas: HTMLCanvasElement;
  readonly gltfCache: GltfSceneCache;
  acquireWorld(options: AcquireRenderWorldOptions): Promise<BrowserRenderWorldSession>;
  rendererIdentity(): THREE.WebGPURenderer | undefined;
  dispose(): Promise<void>;
}

function finiteDimension(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16_384) throw new RangeError(`${label} must be an integer in [1, 16384]`);
  return value;
}

function isHostLifetime(resource: unknown): boolean {
  return !!resource && typeof resource === "object"
    && (resource as { userData?: { liminaLifetime?: unknown } }).userData?.liminaLifetime === RENDER_RESOURCE_HOST_LIFETIME;
}

function collectMaterialTextures(material: unknown, textures: Set<{ dispose?(): void }>): void {
  if (!material || typeof material !== "object") return;
  for (const value of Object.values(material)) {
    if (value && typeof value === "object" && (value as { isTexture?: unknown }).isTexture === true && !isHostLifetime(value)) {
      textures.add(value as { dispose?(): void });
    }
  }
  const owned = (material as { userData?: { liminaOwnedTextures?: unknown } }).userData?.liminaOwnedTextures;
  if (Array.isArray(owned)) for (const texture of owned) {
    if (texture && typeof texture === "object" && !isHostLifetime(texture)) textures.add(texture as { dispose?(): void });
  }
}

interface RendererSessionDefaults {
  autoClear: boolean;
  autoClearColor: boolean;
  autoClearDepth: boolean;
  autoClearStencil: boolean;
  sortObjects: boolean;
  toneMapping: number;
  toneMappingExposure: number;
  outputColorSpace: string;
  shadowEnabled: boolean;
  shadowType: number;
  shadowAutoUpdate: boolean;
}

function captureRendererDefaults(renderer: THREE.WebGPURenderer): RendererSessionDefaults {
  const value = renderer as unknown as {
    autoClear: boolean; autoClearColor: boolean; autoClearDepth: boolean; autoClearStencil: boolean;
    sortObjects: boolean; toneMapping: number; toneMappingExposure: number; outputColorSpace: string;
    shadowMap: { enabled: boolean; type: number; autoUpdate: boolean };
  };
  return {
    autoClear: value.autoClear,
    autoClearColor: value.autoClearColor,
    autoClearDepth: value.autoClearDepth,
    autoClearStencil: value.autoClearStencil,
    sortObjects: value.sortObjects,
    toneMapping: value.toneMapping,
    toneMappingExposure: value.toneMappingExposure,
    outputColorSpace: value.outputColorSpace,
    shadowEnabled: value.shadowMap.enabled,
    shadowType: value.shadowMap.type,
    shadowAutoUpdate: value.shadowMap.autoUpdate,
  };
}

function resetRendererSession(renderer: THREE.WebGPURenderer, defaults: RendererSessionDefaults): void {
  const value = renderer as unknown as {
    autoClear: boolean; autoClearColor: boolean; autoClearDepth: boolean; autoClearStencil: boolean;
    sortObjects: boolean; toneMapping: number; toneMappingExposure: number; outputColorSpace: string;
    shadowMap: { enabled: boolean; type: number; autoUpdate: boolean; needsUpdate: boolean };
    setRenderTarget?(target: null): void; setOutputRenderTarget?(target: null): void; setScissorTest?(enabled: boolean): void;
  };
  value.setRenderTarget?.(null);
  value.setOutputRenderTarget?.(null);
  value.setScissorTest?.(false);
  value.autoClear = defaults.autoClear;
  value.autoClearColor = defaults.autoClearColor;
  value.autoClearDepth = defaults.autoClearDepth;
  value.autoClearStencil = defaults.autoClearStencil;
  value.sortObjects = defaults.sortObjects;
  value.toneMapping = defaults.toneMapping;
  value.toneMappingExposure = defaults.toneMappingExposure;
  value.outputColorSpace = defaults.outputColorSpace;
  value.shadowMap.enabled = defaults.shadowEnabled;
  value.shadowMap.type = defaults.shadowType;
  value.shadowMap.autoUpdate = defaults.shadowAutoUpdate;
  value.shadowMap.needsUpdate = false;
}

function resetObjectState(object: THREE.Object3D): void {
  object.clear();
  object.position.set(0, 0, 0);
  object.rotation.set(0, 0, 0);
  object.quaternion.identity();
  object.scale.set(1, 1, 1);
  object.up.set(0, 1, 0);
  object.layers.mask = 1;
  object.visible = true;
  object.castShadow = false;
  object.receiveShadow = false;
  object.frustumCulled = true;
  object.renderOrder = 0;
  object.matrixAutoUpdate = true;
  object.matrixWorldAutoUpdate = true;
  object.userData = {};
  object.updateMatrix();
  object.updateMatrixWorld(true);
}

function resetWorldState(scene: THREE.Scene, camera: THREE.PerspectiveCamera, width: number, height: number): void {
  resetObjectState(scene);
  scene.background = null;
  scene.environment = null;
  scene.fog = null;
  scene.backgroundBlurriness = 0;
  scene.backgroundIntensity = 1;
  scene.backgroundRotation.set(0, 0, 0);
  scene.environmentIntensity = 1;
  scene.environmentRotation.set(0, 0, 0);
  scene.overrideMaterial = null;
  (scene as unknown as { backgroundNode?: unknown; environmentNode?: unknown; fogNode?: unknown }).backgroundNode = null;
  (scene as unknown as { backgroundNode?: unknown; environmentNode?: unknown; fogNode?: unknown }).environmentNode = null;
  (scene as unknown as { backgroundNode?: unknown; environmentNode?: unknown; fogNode?: unknown }).fogNode = null;

  resetObjectState(camera);
  camera.fov = 60;
  camera.zoom = 1;
  camera.near = 0.1;
  camera.far = 200;
  camera.focus = 10;
  camera.aspect = width / height;
  camera.view = null;
  camera.filmGauge = 35;
  camera.filmOffset = 0;
  camera.updateProjectionMatrix();
}

/** Dispose per-world scene resources while retaining process-hosted GLTF/cache resources. */
export function disposeRenderWorldScene(scene: { traverse(visitor: (object: unknown) => void): void; clear?(): void }, onError: (error: unknown) => void = console.warn): void {
  if (!scene || typeof scene.traverse !== "function") throw new TypeError("render world scene must be traversable");
  if (typeof onError !== "function") throw new TypeError("render world cleanup onError must be a function");
  const geometries = new Set<{ dispose?(): void }>();
  const materials = new Set<{ dispose?(): void }>();
  const textures = new Set<{ dispose?(): void }>();
  const sceneResources = new Set<{ dispose?(): void }>();
  scene.traverse((object) => {
    if (!object || typeof object !== "object") return;
    if ((object as { isLight?: unknown }).isLight === true && !isHostLifetime(object)) {
      sceneResources.add(object as { dispose?(): void });
    }
    const geometry = (object as { geometry?: unknown }).geometry;
    if (geometry && typeof geometry === "object" && !isHostLifetime(geometry)) geometries.add(geometry as { dispose?(): void });
    const value = (object as { material?: unknown }).material;
    for (const material of Array.isArray(value) ? value : [value]) {
      if (!material || typeof material !== "object" || isHostLifetime(material)) continue;
      materials.add(material as { dispose?(): void });
      collectMaterialTextures(material, textures);
    }
  });
  const sceneState = scene as unknown as { background?: unknown; environment?: unknown; overrideMaterial?: unknown };
  for (const texture of [sceneState.background, sceneState.environment]) {
    if (texture && typeof texture === "object" && (texture as { isTexture?: unknown }).isTexture === true && !isHostLifetime(texture)) {
      textures.add(texture as { dispose?(): void });
    }
  }
  for (const material of Array.isArray(sceneState.overrideMaterial) ? sceneState.overrideMaterial : [sceneState.overrideMaterial]) {
    if (!material || typeof material !== "object" || isHostLifetime(material)) continue;
    materials.add(material as { dispose?(): void });
    collectMaterialTextures(material, textures);
  }
  const dispose = (resource: { dispose?(): void }): void => {
    try { resource.dispose?.(); } catch (error) { try { onError(error); } catch { /* reporting cannot stop cleanup */ } }
  };
  for (const resource of sceneResources) dispose(resource);
  for (const texture of textures) dispose(texture);
  for (const material of materials) dispose(material);
  for (const geometry of geometries) dispose(geometry);
  try { scene.clear?.(); } catch (error) { try { onError(error); } catch { /* reporting cannot stop cleanup */ } }
}

export function createBrowserRenderHost(options: BrowserRenderHostOptions): BrowserRenderHost {
  if (!options?.canvas) throw new TypeError("browser render host requires a canvas");
  const canvas = options.canvas;
  const forceWebGL = options.forceWebGL === true;
  const dpr = options.devicePixelRatio ?? (typeof globalThis.devicePixelRatio === "number" ? globalThis.devicePixelRatio : 1);
  const now = options.now ?? (() => globalThis.performance?.now() ?? Date.now());
  if (typeof now !== "function") throw new TypeError("browser render host now must be a function");
  if (options.onTelemetry !== undefined && typeof options.onTelemetry !== "function") throw new TypeError("browser render host onTelemetry must be a function");
  let tier = options.initialQuality ?? "balanced";
  let renderer: THREE.WebGPURenderer | undefined;
  let rendererInit: Promise<THREE.WebGPURenderer> | undefined;
  let rendererDefaults: RendererSessionDefaults | undefined;
  let hostScene: THREE.Scene | undefined;
  let hostCamera: THREE.PerspectiveCamera | undefined;
  let hostBackground: RenderBaselineBackground | undefined;
  let activeSession: BrowserRenderWorldSession | undefined;
  let acquiring = false;
  let disposed = false;
  let surfaceWidth: number | undefined;
  let surfaceHeight: number | undefined;
  let surfacePixelRatio: number | undefined;
  const gltfCache = new GltfSceneCache(options.gltfCache);

  const configureSurface = (
    liveRenderer: THREE.WebGPURenderer,
    width: number,
    height: number,
    pixelRatio: number,
  ): void => {
    const expectedWidth = Math.floor(width * pixelRatio);
    const expectedHeight = Math.floor(height * pixelRatio);
    const stateChanged = surfacePixelRatio !== pixelRatio || surfaceWidth !== width || surfaceHeight !== height;
    if (stateChanged || canvas.width !== expectedWidth || canvas.height !== expectedHeight) {
      liveRenderer.setDrawingBufferSize(width, height, pixelRatio);
    }
    surfaceWidth = width;
    surfaceHeight = height;
    surfacePixelRatio = pixelRatio;
  };

  const acquireRenderer = (): Promise<THREE.WebGPURenderer> => {
    if (renderer !== undefined) return Promise.resolve(renderer);
    if (rendererInit !== undefined) return rendererInit;
    rendererInit = (async () => {
      const created = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL });
      await created.init();
      if (disposed) {
        await created.dispose();
        throw new Error("browser render host was disposed during renderer initialization");
      }
      renderer = created;
      rendererDefaults = captureRendererDefaults(created);
      return created;
    })();
    void rendererInit.catch(() => { rendererInit = undefined; });
    return rendererInit;
  };

  return {
    canvas,
    gltfCache,
    rendererIdentity: () => renderer,
    async acquireWorld(input): Promise<BrowserRenderWorldSession> {
      if (disposed) throw new Error("browser render host is disposed");
      if (activeSession !== undefined || acquiring) throw new Error("browser render host already owns or is acquiring a world session");
      let width = finiteDimension(input?.width, "render world width");
      let height = finiteDimension(input?.height, "render world height");
      if (input.onTelemetry !== undefined && typeof input.onTelemetry !== "function") {
        throw new TypeError("render world onTelemetry must be a function");
      }
      acquiring = true;
      gltfCache.beginWorld();
      let liveRenderer: THREE.WebGPURenderer | undefined;
      let scene: THREE.Scene | undefined;
      let baseline: AppliedRenderBaseline | undefined;
      try {
        const acquiredRenderer = await acquireRenderer();
        liveRenderer = acquiredRenderer;
        if (disposed) throw new Error("browser render host was disposed during world acquisition");
        if (rendererDefaults === undefined) throw new Error("browser render host renderer defaults are unavailable");
        let profile = resolveRenderQuality(tier, dpr, options.qualityOverride);
        configureSurface(acquiredRenderer, width, height, profile.pixelRatio);
        const worldScene = hostScene ?? new THREE.Scene();
        scene = worldScene;
        const camera = hostCamera ?? new THREE.PerspectiveCamera(60, width / height, 0.1, 200);
        hostScene = worldScene;
        hostCamera = camera;
        resetRendererSession(acquiredRenderer, rendererDefaults);
        resetWorldState(worldScene, camera, width, height);
        if (input.baseline !== false && hostBackground === undefined) hostBackground = createRenderBaselineBackground();
        baseline = input.baseline === false
          ? undefined
          : applyRenderBaseline({ scene: worldScene, renderer: acquiredRenderer as never, camera }, input.baseline, hostBackground);
        baseline?.setQuality(profile);
        const telemetry = new RenderTelemetryRing();
        let frameCount = 0;
        let lastFrameAt: number | undefined;
        let sessionDisposed = false;
        const session: BrowserRenderWorldSession = {
          renderer: acquiredRenderer,
          scene: worldScene,
          camera,
          baseline,
          quality: () => profile,
          setQuality(nextTier): Readonly<RenderQualityProfile> {
            if (sessionDisposed) throw new Error("render world session is disposed");
            profile = resolveRenderQuality(nextTier, dpr, options.qualityOverride);
            tier = nextTier;
            configureSurface(acquiredRenderer, width, height, profile.pixelRatio);
            baseline?.setQuality(profile);
            return profile;
          },
          resize(nextWidth, nextHeight): void {
            if (sessionDisposed) throw new Error("render world session is disposed");
            width = finiteDimension(nextWidth, "render world width");
            height = finiteDimension(nextHeight, "render world height");
            configureSurface(acquiredRenderer, width, height, profile.pixelRatio);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
          },
          updateShadowFocus: (focus): void => baseline?.updateShadowFocus(focus),
          render(draw): void {
            if (sessionDisposed) throw new Error("render world session is disposed");
            if (typeof draw !== "function") throw new TypeError("render world draw must be a function");
            const started = now();
            const frameDelta = lastFrameAt === undefined ? 0 : Math.max(0, started - lastFrameAt);
            lastFrameAt = started;
            // WebGPURenderer keeps render counters cumulative unless reset explicitly. Reset at the
            // frame boundary so telemetry reports per-frame work instead of a growing session total.
            acquiredRenderer.info.reset();
            draw();
            const submitted = now() - started;
            const surface = acquiredRenderer.domElement;
            telemetry.record(
              frameDelta,
              submitted,
              acquiredRenderer.info as unknown as RendererInfoLike,
              surface.width,
              surface.height,
              profile.pixelRatio,
              profile.tier,
            );
            frameCount++;
            if ((options.onTelemetry !== undefined || input.onTelemetry !== undefined)
                && frameCount % profile.telemetryIntervalFrames === 0) {
              const snapshot = telemetry.snapshot();
              for (const callback of [options.onTelemetry, input.onTelemetry]) {
                if (callback === undefined) continue;
                try { callback(snapshot); }
                catch (error) { console.warn("render telemetry callback failed", error); }
              }
            }
          },
          telemetry: () => telemetry.snapshot(),
          dispose(): void {
            if (sessionDisposed) return;
            sessionDisposed = true;
            const errors: unknown[] = [];
            try { baseline?.dispose(); } catch (error) { errors.push(error); }
            try { disposeRenderWorldScene(worldScene); } catch (error) { errors.push(error); }
            try { disposeRenderWorldScene(camera); } catch (error) { errors.push(error); }
            try { gltfCache.endWorld(); } catch (error) { errors.push(error); }
            if (activeSession === session) activeSession = undefined;
            if (errors.length > 0) throw new AggregateError(errors, `render world disposal failed in ${errors.length} step(s)`);
          },
        };
        activeSession = session;
        acquiring = false;
        return session;
      } catch (error) {
        try { baseline?.dispose(); } catch { /* acquisition error remains primary */ }
        if (scene !== undefined) disposeRenderWorldScene(scene);
        gltfCache.endWorld();
        acquiring = false;
        throw error;
      }
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      const errors: unknown[] = [];
      try { activeSession?.dispose(); } catch (error) { errors.push(error); }
      let liveRenderer: THREE.WebGPURenderer | undefined;
      try { liveRenderer = renderer ?? (rendererInit === undefined ? undefined : await rendererInit.catch(() => undefined)); }
      finally { rendererInit = undefined; }
      renderer = undefined;
      rendererDefaults = undefined;
      hostScene = undefined;
      hostCamera = undefined;
      try { hostBackground?.dispose(); } catch (error) { errors.push(error); }
      hostBackground = undefined;
      try { await gltfCache.dispose(); } catch (error) { errors.push(error); }
      if (liveRenderer !== undefined) {
        try { await liveRenderer.dispose(); } catch (error) { errors.push(error); }
      }
      if (errors.length > 0) throw new AggregateError(errors, `browser render host disposal failed in ${errors.length} step(s)`);
    },
  };
}
