// Phase 8 BROWSER RUNTIME ENTRY — load a native-authored EXPORT and play it back
// in a browser tab. This is the (A) export-playback path from the Phase 8 plan:
// no live simulation — the recorded command log is replayed tick-by-tick into a
// fresh world whose PhysicsOps are KEYFRAME-DRIVEN, rendered via three's WebGPU
// renderer on `navigator.gpu`, driven by a requestAnimationFrame accumulator loop
// that mirrors the native windowed loop.
//
// Verified headlessly: the bundle builds (esbuild --platform=browser), this entry
// is free of ungated `Deno.*` (portability guard), the sample export loads and
// the ReplayPlayer runs to `done`. The in-tab WebGPU RENDER itself is UAT.
//
// No `Deno.*` anywhere. Browser globals (document/window/navigator/fetch) are
// read only inside functions, and the auto-bootstrap is guarded by
// `typeof document` so importing this module off a browser does nothing.

import * as THREE from "../build/three.bundle.mjs";
export { THREE };
export { OrbitControls } from "../build/three.bundle.mjs";
export { TransformControls } from "../build/three.bundle.mjs";
// Real asset-mount path (used by vegetation.scatter/asset.place) — exported so a repro harness
// can exercise the EXACT editor code path (GLB parse + WebGPU texture rehome + instancing).
export { parseGltfScene } from "./skills/three.ts";
import { GltfSceneParseError, type GltfSceneCache } from "./skills/three.ts";
import { loadVegetationPack, speciesPaletteEntries, speciesPaletteIds, type VegetationPack, type VegetationPackEntry } from "./skills/vegetation.ts";
export { buildAssetInstancedMeshes } from "./terrain/asset-scatter-render.ts";
import { EntityTable, installOps, type CameraLike, type EngineOps, type SceneLike } from "./engine.ts";
import { createEcsWorld, Position, renderableOwnerEid, renderSyncSystem, Rotation, Scale } from "./ecs/world.ts";
import { createTransformStorage } from "./ecs/facade.ts";
import { UniformGridSpatialIndex } from "./spatial/index.ts";
import { SkillRegistry, type WorldContext } from "./skills/registry.ts";
import { registerCoreSkills } from "./skills/index.ts";
import { resolveProfile } from "./skills/permissions.ts";
import { createDesignArtifactStore } from "./world/design-artifacts.ts";
import { applyAuthorCommand } from "./kernel/authoring.ts";
import {
  applyAuthorCommandsIsolated,
  createWorkerHandshake,
  type AuthorCommandFailure,
} from "./kernel/apply-isolated.ts";
import { isViewportDataOnlyCommand, partitionViewportCommands } from "./browser/author-command-policy.ts";
// Re-exported so the editor viewport (plain JS importing the bundle) shares the SAME quarantine
// helper the headless gate unit-tests — no forked copy of the skip logic.
export { partitionQuarantined } from "./kernel/apply-isolated.ts";
import { LiminaTracer } from "./observability/event.ts";
// ── Phase 8 Mode-B (M5) live runtime: the verified M1–M4 + M3 worker pieces ──
import { WasmRapierPhysics, type RapierModule } from "./browser/wasm-rapier-physics.ts";
import { SharedTransformStorage } from "./browser/sab-transforms.ts";
import { InputRingBuffer } from "./browser/sab-ringbuffer.ts";
import {
  createSimStatusView,
  readSimStatus,
  readSimStatusInto,
  type MutableSimStatusSnapshot,
  type SimStatusSnapshot,
} from "./browser/sim-status.ts";
import { FrameInterpolator, type TransformStore } from "./browser/frame-interpolator.ts";
import type { AuthorCommand } from "./browser/sim-worker.ts";
import { AuthoringProjectBinding, authoringProjectIdForCommands } from "./browser/authoring-project.ts";
import { registerBrowserAuthoringRuntime } from "./browser/authoring-runtime.ts";
export { AuthoringProjectBinding, authoringProjectIdForCommands } from "./browser/authoring-project.ts";
import {
  composeAuthoringOps,
  crossOriginIsolatedAvailable,
  LivePlayerInput,
  shouldRenderLiveFrame,
  SnapshotRing,
} from "./browser/live-runtime.ts";
import { exportAssetBundle, loadExport, type LoadedExport } from "./export/package.ts";
import { AssetRegistry } from "./asset-registry.ts";
import type { DerivedRuntimeTransportConfig } from "./browser/derived-runtime-transport.ts";
import { KeyframePhysics, playbackOps } from "./browser/keyframe-physics.ts";
import { ReplayPlayer } from "./browser/player.ts";
import {
  applyPaintOverlay,
  buildTerrainMesh,
  disposeTerrainMesh,
  TerrainMaterialPool,
  TerrainStreamRenderer,
  type TerrainStreamRendererOptions,
} from "./terrain/render.ts";
import { ProceduralTerrainSource, TILE_SIZE } from "./terrain/procedural.ts";
import type { TerrainTile } from "./terrain/types.ts";
// Map Phase 3.3 — client-side (view) terrain streaming for the LIVE viewport: the stream loop
// (pure set math + budget, headless-gated in p_stream_client) + the map-backed source it follows.
import { ClientTerrainStream } from "./terrain/stream-client.ts";
// Task #78 — placed-entity residency streaming (view state, like the tile stream): detach
// far props' RETAINED meshes, re-attach on approach; ids/eids/counters untouched.
import { createEntityResidencyWiring, EntityResidencyStream } from "./browser/entity-stream.ts";
import { GrassFieldStreamManager } from "./render/grass-field-render.ts";
import { grassFieldInstanceSpacing } from "./render/grass-field-package.ts";
import { INTERACTIVE_TEMPERATE_MEADOW_PACKAGE } from "./content/grass/interactive-temperate-meadow.ts";
import type { TileCoord } from "./terrain/stream.ts";
import { MapTerrainSource } from "./terrain/map-source.ts";
import { SwappableTerrainSource } from "./terrain/swappable.ts";
import type { StreamTileColliderAdd } from "./browser/sim-worker.ts";
import { FlyCamera } from "./browser/fly-camera.ts";
import { applyRenderBaseline, type RenderBaselineOverride } from "./render-baseline.ts";
import {
  createBrowserRenderHost,
  type BrowserRenderHost,
  type BrowserRenderWorldSession,
} from "./render/browser-host.ts";
import type { RenderQualityTier } from "./render/quality.ts";
import type { RenderTelemetrySnapshot } from "./render/telemetry.ts";
import { UnderwaterEffect } from "./render/underwater.ts";
export { UnderwaterEffect } from "./render/underwater.ts";
export { HdrEnvironmentCache } from "./render/environment-hdri.ts";
import {
  DERIVED_SIM_STAGE_SCHEMA,
  type DerivedSimStageSnapshot,
} from "./browser/sim-worker.ts";
import {
  DetachedDerivedRenderCandidate,
  searchTransferredDerivedNavigation,
} from "./browser/derived-runtime-render-candidate.ts";
import {
  DerivedSnapshotVerifier,
  parseTransferredDerivedRuntimeSnapshot,
  type ParsedTransferredDerivedSnapshot,
} from "./browser/derived-runtime-verify.ts";
import { mountTransportDerivedBiomePopulation } from "./browser/derived-biome-population-mount.ts";
import {
  derivedTerrainResidencyKey,
  type DerivedTerrainResidency,
} from "./browser/derived-terrain-residency.ts";
import {
  deriveCommandCameraFrame,
  DerivedTerrainResidencyTracker,
  type DerivedTerrainResidencyListener,
} from "./browser/camera-framing.ts";
import {
  EditorNavigationController,
  type EditorNavigationMode,
  type RunningEditorNavigation,
} from "./browser/editor-navigation.ts";
export type { EditorCameraPose, EditorNavigationMode, RunningEditorNavigation } from "./browser/editor-navigation.ts";
import { buildPostPipeline, constrainPostPreset, type PostPipeline, type PostPreset } from "./render/post.ts";
export { createBrowserRenderHost } from "./render/browser-host.ts";
import { applyToonStyle, type ToonStyleOptions } from "./render/toon.ts";
export { createCharacterBody, type CharacterBody, type CharacterBodyOptions } from "./world/character-body.ts";
import {
  BrowserInput,
  createBrowserRenderOps,
  DurableTraceStore,
  IndexedDbKvStore,
  startAccumulatorLoop,
  type AccumulatorLoopHandle,
} from "./browser/host.ts";

declare const document: unknown;
declare const fetch: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface RunOptions {
  /** A real <canvas> element to render into. */
  canvas: HTMLCanvasElement;
  /** Base URL of the exported world (dir holding manifest.json/log.jsonl/keyframes.jsonl). */
  worldUrl: string;
  width: number;
  height: number;
  /** Optional event target for keyboard camera control (usually `window`). */
  input?: unknown;
  /** Force the WebGL2 backend instead of WebGPU (set when WebGPU is unavailable). */
  forceWebGL?: boolean;
  /** Status sink for the page UI (loading / playing / error). */
  onStatus?: (phase: "loading" | "ready" | "playing" | "done" | "error", detail?: string) => void;
  /** Override the trace store (tests inject a fake; defaults to IndexedDB). */
  traceStore?: DurableTraceStore;
  /** Initial fly-camera pose for terrain mode (default is a high aerial). Lets a world
   *  frame an eye-level hero shot instead of the fly-through default. */
  flyStart?: { x: number; y: number; z: number; yaw: number; pitch: number };
  /** Optional Phase 9 terrain stream: cached tiles become visible meshes that stream
   *  in/out around the camera. Logic (mesh math + stream set) is headless-proven; the
   *  in-tab WebGPU render of the terrain is UAT. */
  terrain?: TerrainStreamRendererOptions;
  /** Optional framing for the (non-terrain) ORBIT camera. A replayed world whose
   *  content is NOT at the origin (e.g. an exported island centered far from 0,0,0)
   *  needs the orbit centered on it; defaults reproduce the legacy origin orbit. */
  orbit?: {
    /** Point the orbit circles + looks at (world space). Default [0, 1, 0]. */
    center?: [number, number, number];
    /** Initial orbit radius. Default 16. */
    radius?: number;
    /** Initial orbit height above the center. Default 8. */
    height?: number;
    /** Max radius the scroll-out clamp allows. Default 40. */
    maxRadius?: number;
    /** Max height the up clamp allows. Default 25. */
    maxHeight?: number;
    /** Camera far plane (large worlds need a pushed-out far). Default unchanged. */
    far?: number;
    /** Auto-spin per frame (radians). Default 0.004. */
    autoSpin?: number;
    /** Initial orbit azimuth (radians). 0 places the camera on +X of the center;
     *  PI/2 places it on +Z looking toward -Z. Default 0. Lets a world frame a
     *  specific hero angle (e.g. down a path) instead of the legacy side view. */
    azimuth?: number;
  };
}

export interface RunningPlayer {
  player: ReplayPlayer;
  loop: AccumulatorLoopHandle;
  stop(): void;
}

/** True iff the environment exposes a WebGPU adapter. Graceful-degradation gate. */
export async function hasWebGpu(): Promise<boolean> {
  if (typeof navigator === "undefined" || navigator.gpu === undefined) return false;
  try {
    return (await navigator.gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

/** Fetch the three export files from `worldUrl` and parse them. */
export async function fetchExport(worldUrl: string): Promise<LoadedExport> {
  const base = worldUrl.endsWith("/") ? worldUrl : worldUrl + "/";
  const get = async (name: string): Promise<string> => {
    const res = await fetch(base + name);
    if (!res.ok) throw new Error(`fetch ${name}: HTTP ${res.status}`);
    return await res.text();
  };
  const manifest = await get("manifest.json");
  let manifestSummary: { tiles?: unknown; assets?: unknown };
  try { manifestSummary = JSON.parse(manifest) as { tiles?: unknown; assets?: unknown }; }
  catch { throw new Error("fetch manifest.json: invalid JSON"); }
  const [log, keyframes, tiles, assets] = await Promise.all([
    get("log.jsonl"),
    get("keyframes.jsonl"),
    Number(manifestSummary.tiles ?? 0) > 0 ? get("tiles.jsonl") : Promise.resolve(""),
    Array.isArray(manifestSummary.assets) && manifestSummary.assets.length > 0 ? get("assets.jsonl") : Promise.resolve(""),
  ]);
  return loadExport({ "manifest.json": manifest, "log.jsonl": log, "keyframes.jsonl": keyframes, "tiles.jsonl": tiles, "assets.jsonl": assets });
}

/** Build the real three renderer + scene + camera for browser playback. The
 *  Phase 11 render baseline (lights + procedural-sky IBL + ground + framing) is
 *  the single source of truth for "looks rendered", so this no longer hand-rolls
 *  cosmetic lights/ground — it just applies the baseline. `baseline` lets the
 *  caller tweak it (terrain mode disables the flat ground, for example). */
async function buildRenderTarget(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  forceWebGL: boolean,
  baseline: RenderBaselineOverride | false,
  renderScale = 1,
): Promise<{
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}> {
  // THREE's WebGPURenderer targets either a WebGPU or a WebGL2 backend; forceWebGL
  // selects WebGL2 so the world still renders where WebGPU is unavailable.
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL });
  await renderer.init();
  // Supersample (SSAA): `antialias:true` is a no-op on the WebGPU-renderer forceWebGL path, so flat
  // low-poly geometry aliases hard at 1:1 and small features (a character's face) drop below a pixel.
  // renderScale>1 renders into a buffer `scale×` the display size and presents downscaled — real AA
  // that also resolves sub-pixel detail. Default 1 = unchanged (no extra VRAM; small-GPU-safe); heavy
  // hero/marketing renders opt in. When scaled we set CSS to the display size so a downscaled present
  // (and headless canvas screenshot) yields the AA'd frame.
  const scale = Number.isFinite(renderScale) && renderScale > 1 ? renderScale : 1;
  if (scale > 1) {
    const r = renderer as unknown as { setPixelRatio?: (p: number) => void };
    r.setPixelRatio?.(scale);
    renderer.setSize(width, height, true);
  } else {
    renderer.setSize(width, height, false);
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 200);

  // One source of truth: lights, procedural-sky IBL, tonemapping, ground, camera.
  if (baseline !== false) {
    applyRenderBaseline({ scene, renderer: renderer as never, camera }, baseline);
  }
  return { renderer, scene, camera };
}

/** Load + play an exported world. Returns the running player (or throws on a
 *  hard failure — caller surfaces it via `onStatus("error")`). */
export async function run(opts: RunOptions): Promise<RunningPlayer> {
  const status = opts.onStatus ?? ((): void => {});

  status("loading", "starting WebGPU");
  // Terrain mode renders its own streamed surface, so suppress the baseline's
  // flat ground plane (it would clip through the terrain); keep everything else.
  const baseline: RenderBaselineOverride =
    opts.terrain !== undefined ? { ground: { enabled: false } } : {};
  const { renderer, scene, camera } = await buildRenderTarget(
    opts.canvas, opts.width, opts.height, opts.forceWebGL ?? false, baseline,
  );

  // Host surfaces: render ops bound to the canvas + input, durable trace over
  // IndexedDB (hydrated before playback).
  const input = new BrowserInput();
  if (opts.input !== undefined) {
    input.attach(opts.input as Parameters<BrowserInput["attach"]>[0]);
  }
  const renderOps = createBrowserRenderOps(opts.canvas as Parameters<typeof createBrowserRenderOps>[0], input);
  const traceStore = opts.traceStore ?? new DurableTraceStore(new IndexedDbKvStore("limina-trace", "traces"));
  await traceStore.hydrate();

  const hostOverrides: Partial<EngineOps> = {
    ...renderOps,
    op_write_trace: (name, content) => traceStore.op_write_trace(name, content),
    op_append_trace: (name, content) => traceStore.op_append_trace(name, content),
    op_read_trace: (name) => traceStore.op_read_trace(name),
  };

  // Install a complete global op surface so any engine code that reaches the
  // module-level `ops` binding (off the native host the lazy bind left it unset)
  // finds the browser host. The player's world uses its OWN composed ops below.
  installOps(playbackOps(new KeyframePhysics([]), hostOverrides));

  // Fetch + load the export AFTER installOps so tile hash verification can reach
  // the host op_sha256 (the module `ops` binding is unset until installOps).
  status("loading", "fetching export");
  const loaded = await fetchExport(opts.worldUrl);

  // Build the player. makeWorld binds the player's keyframe-driven ops to the
  // REAL three scene + camera, so replayed scene.createEntity skills add real
  // meshes the renderer draws.
  const player = new ReplayPlayer(loaded, {
    makeWorld: (worldOps: EngineOps): WorldContext => {
      const ecs = createEcsWorld();
      return {
        ecs,
        transforms: createTransformStorage(ecs),
        spatial: new UniformGridSpatialIndex(),
        entities: new EntityTable(),
        tags: new Map(),
        scene,
        camera,
        ops: worldOps,
        renderer,
        width: opts.width,
        height: opts.height,
        mode: "windowed",
      };
    },
    // Phase 11: a PACKAGE-BACKED asset registry so a replayed asset.place loads the
    // GLTF bytes carried in the export (assets.jsonl), NOT the (stubbed/absent) host
    // asset root. The bundle was hash-verified in loadExport.
    makeRegistry: (tracer) => {
      const r = new SkillRegistry(tracer);
      registerCoreSkills(r, { assets: AssetRegistry.fromBundle(exportAssetBundle(loaded)), grassVisualPackage: INTERACTIVE_TEMPERATE_MEADOW_PACKAGE });
      return r;
    },
    tracer: LiminaTracer.ephemeral("ses_browser_player"),
    opsOverrides: hostOverrides,
  });

  await player.init();
  status("ready", `${loaded.manifest.ticks} ticks, ${loaded.keyframes.length} keyframes`);

  // Phase 9 terrain stream (optional): mount cached tiles as meshes around the camera.
  // The set math (StreamFollower) and geometry (terrainTileGeometry) are headless-proven;
  // the actual WebGPU draw of these meshes is UAT.
  const terrain = opts.terrain !== undefined ? new TerrainStreamRenderer(scene, opts.terrain) : undefined;

  // In terrain mode, fly freely (mouse-look + WASD) and stream terrain around the
  // flier; otherwise orbit (the Phase 8 export demo, unchanged). Fog + a pushed-out
  // far plane fade the streamed edge into a horizon instead of a hard pop.
  const nowMs = (): number => {
    const perf = (globalThis as unknown as { performance?: { now(): number } }).performance;
    return perf !== undefined ? perf.now() : Date.now();
  };
  const fly = terrain !== undefined ? new FlyCamera(opts.flyStart ?? { x: 0, y: 34, z: 70, yaw: 0, pitch: -0.32 }) : undefined;
  if (fly !== undefined) {
    const doc = (globalThis as unknown as { document?: unknown }).document;
    // Input is optional (a headless render shot has none) — only attach interactive
    // controls when an input source is provided, so the camera still holds its pose.
    if (opts.input !== undefined) {
      fly.attach(
        opts.input as Parameters<FlyCamera["attach"]>[0],
        opts.canvas as Parameters<FlyCamera["attach"]>[1],
        doc as Parameters<FlyCamera["attach"]>[2],
      );
    }
    const cam = camera as unknown as { far: number; updateProjectionMatrix(): void };
    cam.far = 900;
    cam.updateProjectionMatrix();
    // Fade the streamed edge into the baseline sky's horizon haze (not black).
    (scene as unknown as { fog: unknown }).fog = new THREE.Fog(0xcdd9e6, 140, 380);
  }

  // Camera orbit state (used only when NOT flying). Framing is configurable so a
  // world centered away from the origin (e.g. an exported island) is framed; the
  // defaults reproduce the legacy origin orbit.
  const orbitCenter = opts.orbit?.center ?? [0, 1, 0];
  const orbitMaxRadius = opts.orbit?.maxRadius ?? 40;
  const orbitMaxHeight = opts.orbit?.maxHeight ?? 25;
  const orbitSpin = opts.orbit?.autoSpin ?? 0.004;
  let angle = opts.orbit?.azimuth ?? 0;
  let radius = opts.orbit?.radius ?? 16;
  let camHeight = opts.orbit?.height ?? 8;
  if (opts.orbit?.far !== undefined) {
    const cam = camera as unknown as { far: number; updateProjectionMatrix(): void };
    cam.far = opts.orbit.far;
    cam.updateProjectionMatrix();
  }
  const axes = new Float32Array(3);
  let announcedDone = false;
  let lastFrame = nowMs();

  const loop = startAccumulatorLoop({
    step: async (): Promise<void> => {
      if (!player.done) {
        await player.stepTick();
        status("playing", `tick ${player.tick}`);
      } else if (!announcedDone) {
        announcedDone = true;
        status("done", `played ${player.tick} ticks`);
      }
    },
    frame: (): void => {
      if (fly !== undefined) {
        const t = nowMs();
        let dt = (t - lastFrame) / 1000;
        lastFrame = t;
        if (dt > 0.1) dt = 0.1;
        const g = fly.update(dt, camera);
        terrain?.update(g.x, g.z);
      } else {
        renderOps.op_input_axes(axes);
        angle += orbitSpin + axes[0] * 0.03;
        radius = Math.min(orbitMaxRadius, Math.max(5, radius - axes[2] * (orbitMaxRadius * 0.006)));
        camHeight = Math.min(orbitMaxHeight, Math.max(1.5, camHeight + axes[1] * (orbitMaxHeight * 0.01)));
        camera.position.set(
          orbitCenter[0] + Math.cos(angle) * radius,
          orbitCenter[1] + camHeight,
          orbitCenter[2] + Math.sin(angle) * radius,
        );
        camera.lookAt(orbitCenter[0], orbitCenter[1], orbitCenter[2]);
      }
      const wl = (player.world as unknown as { lods?: Array<{ update: (c: unknown) => void }> }).lods;
      if (wl !== undefined) for (const l of wl) l.update(camera);
      renderSyncSystem(player.world.ecs);
      renderer.render(scene, camera);
    },
  });

  return {
    player,
    loop,
    stop: (): void => {
      loop.stop();
      terrain?.clear();
      fly?.detach();
      if (opts.input !== undefined) input.detach(opts.input as Parameters<BrowserInput["detach"]>[0]);
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// MODE B — the LIVE in-browser runtime (Phase 8 M5).
//
// `run()` above is Mode A: replay a recorded EXPORT, no live simulation. `runLive`
// is Mode B: spawn the M3 sim-worker (the authoritative fixed-step wasm-Rapier
// solver on its own thread) and render its output here on the main thread, so an
// agent's authoring edits SIMULATE and render live.
//
// Composition (all verified M1–M4 + M3 pieces — no stubs in the wiring):
//   • the worker (sim-worker-entry.js) brings up M1 wasm-Rapier, allocates the M2
//     transform SAB + M3 input/status SABs, authors the command log, and self-drives
//     a 60 Hz fixed step, writing each tick's poses into the transform SAB;
//   • the render-main thread JOINs that SAB (M2 SharedTransformStorage), re-authors
//     the SAME command log against the REAL three scene (matching eids → meshes),
//     freezes each consumed tick (SnapshotRing) and tweens prev→curr by `alpha`
//     (M4 FrameInterpolator) into the render store renderSyncSystem reads, every
//     animation frame; DOM input is pumped into the M3 input ring (1-frame latency).
//
// GRACEFUL DEGRADATION: SharedArrayBuffer needs cross-origin isolation (COOP/COEP);
// without it, or without WebGPU, there is no live bridge — `runLive` reports
// `error` via onStatus and returns null WITHOUT throwing (the caller shows a poster,
// exactly like Mode A). The live Worker+SAB+WebGPU render itself is BROWSER-UAT.
// ════════════════════════════════════════════════════════════════════════════

interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
}
declare const Worker: { new (url: unknown, opts?: { type?: "module" }): WorkerLike };
declare const URL: { new (url: string, base?: string): unknown };

export interface RunLiveOptions {
  /** A real <canvas> element to render into. */
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** The authoring command log (the agent's edits): each command is re-invoked
   *  through the registry (skill) or calls an engine physics op directly. The worker
   *  simulates it; the render thread re-authors it for meshes. */
  commands: AuthorCommand[];
  /** Optional event target for keyboard input (usually `window`). */
  input?: unknown;
  /** The injected rapier-compat module for render-main authoring. Defaults to a
   *  dynamic `import("@dimforge/rapier3d-compat")` (resolved by the browser bundle). */
  rapier?: RapierModule;
  /** Force the WebGL2 backend (set when WebGPU is unavailable but you still want a render). */
  forceWebGL?: boolean;
  /** Status sink for the page UI. */
  onStatus?: (phase: "loading" | "ready" | "playing" | "done" | "error", detail?: string) => void;
  /** Worker script URL override (tests / custom hosting). Defaults to the sibling
   *  `sim-worker-entry.js` chunk next to this bundle. */
  workerUrl?: unknown;
  /** Derived-verify worker script URL override. Defaults to the sibling
   *  `derived-verify-worker-entry.js` chunk next to this bundle. */
  verifyWorkerUrl?: unknown;
  /** Authoring permission profile (default "builder.readWrite" — the broad authoring grant). */
  profile?: string;
  /** Camera orbit framing (the live MVP auto-orbits the world; the follow-cam is future).
   *  `far` pushes the camera far plane out (a map-STREAMED world is bigger than the default
   *  200 m frustum — mirrors run()'s orbit.far). */
  orbit?: { center?: [number, number, number]; radius?: number; height?: number; autoSpin?: number; far?: number };
  /** Opt-in browser camera controls for editor-style viewports. Falsy preserves the legacy auto-spin. */
  orbitControls?: boolean;
  /** Runtime-owned project-scale editor navigation. This is view state only: it never authors commands.
   *  `true` uses orbit mode at 32 m/s; an object selects the initial mode and fly speed modifiers. */
  editorNavigation?: boolean | Readonly<{
    mode?: EditorNavigationMode;
    speedMps?: number;
    boostMultiplier?: number;
    precisionMultiplier?: number;
  }>;
  /** Positioned "vantage" camera (Places Stage 2): sit the camera AT `pos` (world space) and
   *  look along `yaw` (radians; yaw=0 → forward is -Z, matching the first-person move basis),
   *  with an optional downward `pitch` (radians). Static — no orbit, no auto-spin — for a
   *  preview shot FROM a point on the map. When set it wins over the orbit auto-spin. `far`
   *  pushes the far plane out like orbit.far. */
  vantage?: { pos: [number, number, number]; yaw: number; pitch?: number; far?: number };
  /** Scene-level render-baseline override (lights/tonemapping/atmosphere/ground/camera). A world can
   *  carry its own look (e.g. golden-hour sun + fog) without touching DEFAULT_RENDER_BASELINE. Merged
   *  over the default by applyRenderBaseline; omit for the default look. */
  renderBaseline?: RenderBaselineOverride;
  /** Cel-shading (toon) render style. When set, the scene's PBR meshes are converted to hard-banded
   *  MeshToonNodeMaterial after authoring (reusing baked albedo) — the authored buildings + ground read
   *  cel-shaded with no re-authoring. `true` = 3 bands; pass an object to tune bands/saturation. */
  toon?: boolean | ToonStyleOptions;
  /** Supersample factor (SSAA). Default 1 = native buffer (small-GPU-safe). >1 renders `scale×` the
   *  display size and presents downscaled — the antialiasing the WebGPU forceWebGL path otherwise lacks,
   *  and the only thing that resolves sub-pixel detail (a character's face at distance). 2 is a good hero
   *  value; cost is ~scale² fragment work + VRAM, so leave at 1 for the interactive editor. */
  renderScale?: number;
  /** Task #78 — placed-entity residency streaming overrides. Default policy: active on a
   *  map-streamed world, or when the authored world carries > `threshold` (512) streamable
   *  placed entities; window `radius` defaults to 600 m (map-streamed; past the fog knee so
   *  nothing pops in visible air) / 300 m otherwise, `hysteresis` 50 m, `budget` 4 ops/frame.
   *  `enabled` forces it on/off regardless of the policy. */
  entityStream?: { enabled?: boolean; radius?: number; hysteresis?: number; budget?: number; threshold?: number };
  /** Offline/preview override: tiles the terrain stream mounts per frame (live default 2, so the
   *  frame loop never hitches). A headless render (the Atlas peek) protects no frame budget, so it
   *  mounts the whole window at once — set high to drain the tile queue in a few frames instead of
   *  ~40s at 2/frame on a multi-km painted map. */
  terrainMountsPerFrame?: number;
  /** Offline OVERVIEW render (design-space Atlas peek): a distant turntable of the whole map. Sets
   *  ctx.world.peek so render-only skills skip eye-level detail invisible at that scale — chiefly the
   *  paint-driven grass blades (thousands of sub-pixel instanced chunks that dominated peek time).
   *  The painted ground tint already carries the grassy areas. Absent/false = normal (grass grows). */
  peek?: boolean;
  /** Persistent canvas renderer owner. Editor reboots should reuse one host. */
  renderHost?: BrowserRenderHost;
  /** Execution quality; independent of authored look/post strengths. */
  quality?: RenderQualityTier;
  /** Bounded periodic renderer/frame metrics. */
  onRenderTelemetry?: (snapshot: Readonly<RenderTelemetrySnapshot>) => void;
  /** Exact derived revision to activate before this runtime is returned to its caller. */
  initialDerivedRevision?: unknown;
  /** Authenticated loopback capability used only by main-realm biome content activation. */
  initialDerivedContentAccess?: DerivedRuntimeTransportConfig;
  /** @deprecated Internally-owned hosts are always released. Supply renderHost to reuse a canvas backend. */
  disposeRendererOnStop?: boolean;
}

export interface RunningLive {
  worker: WorkerLike;
  loop: AccumulatorLoopHandle;
  scene: SceneLike;
  camera: CameraLike;
  renderer: {
    render(s: unknown, c: unknown): void;
    setSize(w: number, h: number, u?: boolean): void;
    dispose?(): void | Promise<void>;
    domElement?: unknown;
  };
  entities: EntityTable;
  pickEntityId(object: { parent?: unknown }): string | undefined;
  cameraControls?: unknown;
  /** Editor-only camera navigation handle. Absent for gameplay/legacy orbit runtimes. */
  editorNavigation?: RunningEditorNavigation;
  /** Per-command authoring failures encountered while bringing the viewport up (Layer-2 isolation):
   *  the viewport still came up with every command that DID apply — a bad/out-of-band command no
   *  longer wedges it. Absent/empty when the whole command log authored cleanly. The editor uses
   *  these to QUARANTINE the offending commands so a later reboot does not replay them. Distinct from
   *  a `null` return, which means the environment could not host the viewport at all. */
  authoringFailures?: AuthorCommandFailure[];
  applyAuthorCommands(cmds: AuthorCommand[]): Promise<{ applied: number; needsReboot: boolean; structural: number }>;
  /** Map Phase 3.3 — introspection over the client-side (view) terrain stream. Present only on a
   *  map-streamed world (the recorded log bound world.setTerrainSource {kind:"map"}). */
  terrainStream?: { mounted(): string[]; pending(): number };
  /** Paint-driven streamed grass introspection (proof harnesses/UAT) — present with terrainStream. */
  grassStream?: { tiles(): number; blades(): number };
  /** Task #78 — placed-entity residency stream introspection + the editor-selection hook.
   *  Present only when the stream activated (map-streamed world or > threshold placed props).
   *  `setProtected(id, true)` pins an entity resident (re-materializing it IMMEDIATELY if
   *  dormant — the viewport gizmo must never attach a detached mesh); the editor calls it on
   *  select/deselect. A dormant entity is intentionally absent from the scene graph, so it is
   *  unpickable by the viewport raycast until the camera comes back (the World panel, which
   *  lists server-side inspector.snapshot state, still sees it and can select it via this hook). */
  entityStream?: { resident(): number; dormant(): number; isDormant(id: string): boolean; setProtected(id: string, on: boolean): void };
  setCameraControlsEnabled(on: boolean): void;
  setOrbitAzimuth?(angle: number): void;
  setSyncSuppressed(eid: number, on: boolean): void;
  /** Acknowledged worker control: resolves only after the fixed-step driver has stopped. */
  pause(): Promise<void>;
  /** Resume the same worker/controller state; no world re-authoring occurs. */
  resume(): Promise<void>;
  isPaused(): boolean;
  /** Suspend/resume render-main frame work without changing deterministic simulation state. */
  setViewSuspended(on: boolean): void;
  resize(width: number, height: number): void;
  setRenderQuality(tier: RenderQualityTier): Readonly<import("./render/quality.ts").RenderQualityProfile>;
  renderTelemetry(): Readonly<RenderTelemetrySnapshot>;
  /** Coherent completed-tick player water state read directly from the status SAB.
   *  Returns null only when the bounded seqlock reader cannot obtain a stable generation. */
  playerWaterState(): Readonly<SimStatusSnapshot> | null;
  /** Atomically replace the bounded derived terrain/water render and simulation revision. */
  activateDerivedRevision(snapshot: unknown, options?: Readonly<{
    signal?: AbortSignal;
    contentAccess?: DerivedRuntimeTransportConfig;
  }>): Promise<Readonly<{
    manifestHash: string;
    revision: number;
    headHash: string;
  }>>;
  /** Exact derived revision currently committed in both render and simulation. */
  derivedRevision(): Readonly<{ manifestHash: string; revision: number; headHash: string }> | null;
  /** Immutable LOD0 camera residency used by the next derived worker and active revision. */
  derivedTerrainResidency(): Readonly<DerivedTerrainResidency>;
  /** Read-only height sample from the exact active derived terrain revision. */
  derivedTerrainHeightAt(worldX: number, worldZ: number): number | null;
  /** Immutable whole-world bounds compiled with the exact active derived revision. */
  derivedWorldBounds(): Readonly<{
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
  }> | null;
  /** Prefix search over the exact active source-fenced navigation artifact. */
  searchDerivedNavigation(prefix: string, limit?: number): readonly Readonly<{
    designRef: Readonly<{ schema: string; mapId: string; kind: string; id: string }>;
    position: readonly [number, number];
    label: string;
    kind: string;
    searchKeys: readonly string[];
    radiusM?: number;
  }>[];
  /** Scale distance haze for whole-world inspection and restore the exact local value on exit. */
  setWorldOverviewPresentation(enabled: boolean): boolean;
  /** Subscribe to threshold-crossing residency changes. Does not emit the current value immediately. */
  subscribeDerivedTerrainResidency(listener: DerivedTerrainResidencyListener): () => void;
  stop(): Promise<void>;
}

// Map Phase 3.3 — live handling of the STREAMED-terrain commands (decided, not defaulted):
//   • world.setTerrainSource → REBOOT (deliberately NOT in any live set). It is world-DEFINING
//     (the whole tile field derives from it) and the skill itself rejects once regions exist, so
//     the only correct live application is a fresh boot where it authors before everything else.
//     The reboot's pre-warm seeds the map IR bytes before renderer.init() (mapAssetIdsForCommand).
//   • world.generateRegion → REBOOT (also not in any live set): a region is bulk structural
//     world state (colliders + tile entities + meshes); a reboot re-authors it deterministically.
//   • world.streamFollow → applied IN PLACE (below) and forwarded to the sim worker. NOT a no-op:
//     the skill allocates tile ENTITIES (EntityTable ids + eids + body ids are sequential), so a
//     client that skipped it would drift its id counters from the authoritative record and every
//     LATER command referencing a newer entity id would hit the wrong entity until reboot. The
//     CLIENT's own view window stays independent: the view stream never records anything, and it
//     treats recorded-region tiles as externally owned (reconciled right after the apply), so an
//     authoritative window and the camera window coexist without double-mounting.
const LIVE_IN_PLACE_SKILLS = new Set(["authoring.commit", "ecs.updateComponent", "scene.moveEntity", "three.setMaterial", "terrain.deform", "terrain.paint", "catalog.publish", "asset.request", "world.streamFollow"]);
// Structural adds applied INCREMENTALLY on the live scene (no reboot) — including the GLB-mounting
// skills. Their mid-session mount is safe because runLive PRE-WARMS the glTF parse cache (the tree
// palette + the scene's assets) BEFORE renderer.init(), so parseGltfScene returns a synchronous clone
// — no GLTFLoader.parse / createImageBitmap macrotask around a render, which would corrupt the WebGL2
// backend (invisible mesh). A handler must NOT do its own async fetch: handlers ALSO run in the sim
// worker, where a hanging fetch blocks the "ready" handshake and freezes the viewport (learned the
// hard way — that is why prewarmAssets was removed).
const LIVE_STRUCTURAL_ADD_SKILLS = new Set([
  "scene.createEntity", "asset.place", "asset.placeLod", "asset.scatter", "world.populateBiome",
  "building.placeFunctional", "furniture.placeFunctional",
  "player.spawn", "terrain.create", "vegetation.scatter", "vegetation.plant",
]);

/** An inline `assets` palette off a command's input (vegetation.plant/scatter), sanitised to ids. */
function inlinePaletteEntries(input: Record<string, unknown>): VegetationPackEntry[] {
  return (Array.isArray(input.assets) ? input.assets : [])
    .map((a) => {
      if (!a || typeof (a as { id?: unknown }).id !== "string") return { id: "" };
      const candidate = a as VegetationPackEntry;
      return { id: candidate.id, ...(candidate.weight !== undefined ? { weight: candidate.weight } : {}), ...(candidate.treeLod !== undefined ? { treeLod: candidate.treeLod } : {}) };
    })
    .filter((e) => e.id.length > 0);
}

function vegetationAssetIds(species: string[], input: Record<string, unknown>, pack: VegetationPack): string[] {
  const ids: string[] = [];
  for (const entry of speciesPaletteEntries(species, inlinePaletteEntries(input), pack)) {
    ids.push(entry.id);
    if (entry.treeLod !== undefined) ids.push(entry.treeLod.reducedId, entry.treeLod.impostorId);
  }
  return ids;
}

/** The GLB asset ids a command will MOUNT — used to pre-warm the parse cache before renderer.init().
 *  Vegetation commands name no baked ids: their archetypes come from the command's inline `assets`
 *  palette or the project VEGETATION PACK (tree-pack.json), so the pack is threaded in. */
export function gltfAssetIdsForCommand(cmd: AuthorCommand, pack: VegetationPack = {}): string[] {
  if (cmd.kind !== "skill") return [];
  const input = (cmd.input ?? {}) as Record<string, unknown>;
  if (cmd.tool === "asset.place" || cmd.tool === "three.loadGLTF" || cmd.tool === "building.placeFunctional" || cmd.tool === "furniture.placeFunctional") {
    return typeof input.assetId === "string" ? [input.assetId] : [];
  }
  // asset.placeLod mounts a GLB PER LEVEL — pre-warm every level's parse cache before init().
  if (cmd.tool === "asset.placeLod") {
    const lods = Array.isArray(input.lods) ? input.lods : [];
    return lods.map((l) => (l && typeof (l as { assetId?: unknown }).assetId === "string" ? (l as { assetId: string }).assetId : "")).filter((s) => s.length > 0);
  }
  // asset.scatter can mount every base palette asset and every declared population LOD.
  // All ids must be parsed before acquireWorld(): a cache miss during the active render
  // session is rejected deliberately to prevent asynchronous GLTFLoader work corrupting WebGL.
  if (cmd.tool === "asset.scatter") {
    const config = input.config as { assets?: unknown } | undefined;
    const assets = Array.isArray(config?.assets) ? config.assets : [];
    const ids: string[] = [];
    for (const candidate of assets) {
      if (candidate === null || typeof candidate !== "object") continue;
      const asset = candidate as { id?: unknown; lods?: unknown; treeLod?: unknown };
      if (typeof asset.id === "string" && asset.id.length > 0) ids.push(asset.id);
      if (asset.treeLod !== null && typeof asset.treeLod === "object") {
        const tree = asset.treeLod as { reducedId?: unknown; impostorId?: unknown };
        if (typeof tree.reducedId === "string" && tree.reducedId.length > 0) ids.push(tree.reducedId);
        if (typeof tree.impostorId === "string" && tree.impostorId.length > 0) ids.push(tree.impostorId);
      }
      if (!Array.isArray(asset.lods)) continue;
      for (const candidateLod of asset.lods) {
        const lod = candidateLod as { id?: unknown } | null;
        if (lod !== null && typeof lod === "object" && typeof lod.id === "string" && lod.id.length > 0) ids.push(lod.id);
      }
    }
    return ids;
  }
  // world.populateBiome drives nested asset.scatter calls from its inline semantic role pack.
  // The nested calls are intentionally not separate author commands, so the top-level command
  // is the only place boot/live prewarm can discover these GLBs.
  if (cmd.tool === "world.populateBiome") {
    const biomePack = input.biomePack;
    if (biomePack === null || typeof biomePack !== "object" || Array.isArray(biomePack)) return [];
    const ids: string[] = [];
    for (const candidate of Object.values(biomePack as Record<string, unknown>)) {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const asset = candidate as { id?: unknown; lods?: unknown; treeLod?: unknown };
      if (typeof asset.id === "string" && asset.id.length > 0) ids.push(asset.id);
      if (asset.treeLod !== null && typeof asset.treeLod === "object") {
        const tree = asset.treeLod as { reducedId?: unknown; impostorId?: unknown };
        if (typeof tree.reducedId === "string" && tree.reducedId.length > 0) ids.push(tree.reducedId);
        if (typeof tree.impostorId === "string" && tree.impostorId.length > 0) ids.push(tree.impostorId);
      }
      if (!Array.isArray(asset.lods)) continue;
      for (const candidateLod of asset.lods) {
        const lod = candidateLod as { id?: unknown } | null;
        if (lod !== null && typeof lod === "object" && typeof lod.id === "string" && lod.id.length > 0) ids.push(lod.id);
      }
    }
    return ids;
  }
  // village.build mounts a GLB per building (via nested asset.place); its ids live in
  // steering.buildings[].assetId, so pre-warm each one's parse cache before init().
  if (cmd.tool === "village.build") {
    const steering = (input.steering ?? {}) as { buildings?: Array<{ assetId?: unknown }>; siting?: { lawnVegetation?: Array<{ id?: unknown }> } };
    const bs = Array.isArray(steering.buildings) ? steering.buildings : [];
    const buildingIds = bs.map((b) => (typeof b.assetId === "string" ? b.assetId : "")).filter((s) => s.length > 0);
    // A "lawn" yard scatters PROJECT-supplied wildflower/tuft GLBs (steering.siting.lawnVegetation) — pre-warm
    // those too, else the render-thread scatter can't resolve them and the lawn stays bare.
    const lawnVeg = Array.isArray(steering.siting?.lawnVegetation) ? steering.siting!.lawnVegetation : [];
    const lawnIds = lawnVeg.map((a) => (typeof a.id === "string" ? a.id : "")).filter((s) => s.length > 0);
    return [...buildingIds, ...lawnIds];
  }
  if (cmd.tool === "vegetation.plant") {
    const species = typeof input.species === "string" ? input.species : "spruce";
    // Warm every variant of the species' palette (the seed picks one; warming all is cheap).
    return speciesPaletteIds([species], inlinePaletteEntries(input), pack);
  }
  if (cmd.tool === "vegetation.scatter") {
    const species = Array.isArray(input.species) ? (input.species as string[]) : ["spruce", "pine", "birch"];
    return vegetationAssetIds(species, input, pack);
  }
  return [];
}

/** The WorldMap IR asset ids a command RESOLVES (world.setTerrainSource kind "map",
 *  terrain.create generate.source "map"). Pre-fetched + seeded into the live AssetRegistry
 *  BEFORE renderer.init() so authoring resolves them from memory — never the blocking
 *  main-thread sync-XHR op_read_asset fallback, and never inside the forceWebGL
 *  init-collapse window. Resolved ONCE per boot: streamed tiles are pure math over the
 *  rasterized master field, so no per-tile asset I/O ever happens. */
function mapAssetIdsForCommand(cmd: AuthorCommand): string[] {
  if (cmd.kind !== "skill") return [];
  const input = (cmd.input ?? {}) as Record<string, unknown>;
  if (cmd.tool === "world.setTerrainSource") {
    return input.kind === "map" && typeof input.mapAssetId === "string" ? [input.mapAssetId] : [];
  }
  if (cmd.tool === "world.addMapWater" || cmd.tool === "world.addMapRivers") {
    return typeof input.mapAssetId === "string" ? [input.mapAssetId] : [];
  }
  if (cmd.tool === "terrain.create") {
    const g = (input.generate ?? {}) as { source?: unknown; mapAssetId?: unknown };
    return g.source === "map" && typeof g.mapAssetId === "string" ? [g.mapAssetId] : [];
  }
  return [];
}
// Removals that hot-drop a single entity (mesh + body + eid) instead of forcing a full
// viewport reboot. The skill runs on the render-thread world (teardownEntity removes the
// mesh) and is forwarded to the sim worker (which tears down the body + eid); the removed
// eid is dropped from the interpolation ring so its stale transform is never re-applied.
const LIVE_REMOVE_SKILLS = new Set(["scene.destroyEntity", "building.destroyFunctional", "furniture.destroyFunctional"]);
// Render-scene mutations (lights) apply on the RENDER thread only: they add/remove three.js
// lights on the real scene via applyOne, so they must NOT force a full reboot, and must NOT be
// forwarded to the sim worker (whose scene is a headless stub with no lighting). Without this a
// three.addLight fell into the "unsupported → reboot" path and the light never rendered.
const LIVE_RENDER_ONLY_SKILLS = new Set(["three.addLight", "three.removeLight", "three.setLighting"]);

function resultEntityId(result: unknown): string | undefined {
  return typeof result === "object" && result !== null && typeof (result as { entity?: unknown }).entity === "string"
    ? (result as { entity: string }).entity
    : undefined;
}

function authoringFailureMessage(cmd: AuthorCommand, message: string): string {
  if (cmd.kind === "physics") return `authoring physics '${String(cmd.op)}' failed: ${message}`;
  return `authoring '${cmd.tool}' failed: ${message}`;
}

interface ReadyMessage { type: "ready"; buffer: SharedArrayBuffer | ArrayBuffer; inputBuffer: SharedArrayBuffer | ArrayBuffer; status: SharedArrayBuffer | ArrayBuffer; }

/** Spawn the live runtime. Returns the running handle, or `null` when the
 *  environment can't support the live bridge (reported via `onStatus("error")` —
 *  never throws for an unsupported environment). */
export async function runLive(opts: RunLiveOptions): Promise<RunningLive | null> {
  const status = opts.onStatus ?? ((): void => {});
  const initialAuthoringProjectId = authoringProjectIdForCommands(opts.commands);

  // ── Gate 1: cross-origin isolation (no COOP/COEP ⇒ no SharedArrayBuffer ⇒ no
  //    zero-copy worker bridge). Degrade gracefully — the caller shows a poster.
  if (!crossOriginIsolatedAvailable()) {
    status("error", "not cross-origin isolated — serve with COOP: same-origin + COEP: require-corp for SharedArrayBuffer");
    return null;
  }
  // ── Gate 2: WebGPU (or an explicit WebGL2 fallback). ──
  const webgpu = await hasWebGpu();
  if (!webgpu && !(opts.forceWebGL ?? false)) {
    status("error", "WebGPU unavailable (no navigator.gpu adapter)");
    return null;
  }

  // Resolve every asset the boot command stream can reference before either
  // thread authors the world. AssetRegistry.resolve is synchronous by contract;
  // prefetching here keeps that contract without synchronous XHR on main or worker.
  const prefetchedAssets = new Map<string, Uint8Array>();
  const fetchAsset = async (id: string): Promise<Uint8Array | undefined> => {
    if (prefetchedAssets.has(id)) return prefetchedAssets.get(id);
    try {
      const response = await fetch("/assets/" + id);
      if (!response.ok) return undefined;
      const bytes = new Uint8Array(await response.arrayBuffer());
      prefetchedAssets.set(id, bytes);
      return bytes;
    } catch {
      return undefined;
    }
  };
  if (typeof fetch === "function") await fetchAsset("tree-pack.json");
  const vegPack = loadVegetationPack({ op_read_asset: (id) => prefetchedAssets.get(id) ?? new Uint8Array(0) });
  const gltfIds = new Set<string>(Object.values(vegPack).flat().map((entry) => entry.id));
  const mapIds = new Set<string>();
  for (const cmd of opts.commands) {
    for (const id of gltfAssetIdsForCommand(cmd, vegPack)) gltfIds.add(id);
    for (const id of mapAssetIdsForCommand(cmd)) mapIds.add(id);
  }
  const assetIds = [...new Set([...gltfIds, ...mapIds])];
  if (assetIds.length > 0) {
    status("loading", `loading ${assetIds.length} asset${assetIds.length === 1 ? "" : "s"}`);
    await Promise.all(assetIds.map(fetchAsset));
  }

  status("loading", "spawning sim worker");

  // ── Spawn the sim-worker + handshake. The worker authors the command log, then
  //    replies `ready` with the M2/M3 SABs. ──
  const workerUrl = opts.workerUrl ?? new URL("./sim-worker-entry.js", import.meta.url);
  let worker: WorkerLike;
  try {
    worker = new Worker(workerUrl, { type: "module" });
  } catch (err) {
    status("error", "failed to spawn sim worker: " + (err instanceof Error ? err.message : String(err)));
    return null;
  }

  let liveLoop: AccumulatorLoopHandle | null = null;
  let controlRequestId = 0;
  let derivedControlRequestId = 0;
  const controlWaiters = new Map<number, {
    expected: "paused" | "resumed";
    resolve(): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const derivedControlWaiters = new Map<string, {
    expected: "derivedRevisionStaged" | "derivedRevisionCommitted" | "derivedRevisionDiscarded";
    manifestHash: string;
    resolve(message: Record<string, unknown>): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let commandAckRequestId = 0;
  const commandAckWaiters = new Map<number, {
    resolve(ack: { applied: number; failed: number }): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const ownsRenderHost = opts.renderHost === undefined;
  let cleanupRenderHost: BrowserRenderHost | undefined;
  let cleanupRenderSession: BrowserRenderWorldSession | undefined;
  let cleanupWorld: WorldContext | undefined;
  let cleanupTerrainStream: ClientTerrainStream | undefined;
  let cleanupTerrainMaterialPool: TerrainMaterialPool | undefined;
  let cleanupGrassStream: GrassFieldStreamManager | undefined;
  let cleanupEntityStream: EntityResidencyStream | undefined;
  let cleanupDerivedTerrainResidency: (() => void) | undefined;
  let cleanupInput: LivePlayerInput | undefined;
  let cleanupCameraControls: InstanceType<typeof THREE.OrbitControls> | undefined;
  let cleanupEditorNavigation: EditorNavigationController | undefined;
  let cleanupUnderwater: UnderwaterEffect | undefined;
  let cleanupWater: { dispose(): void } | undefined;
  let cleanupDerivedRevision: (() => void) | undefined;
  const failedDerivedDisposals: DetachedDerivedRenderCandidate[] = [];
  const MAX_FAILED_DERIVED_DISPOSALS = 8;
  let teardownPromise: Promise<void> | undefined;
  let runtimeReady = false;
  let aborted = false;
  let stopped = false;
  let workerTerminated = false;

  const disposeDerivedCandidate = (candidate: DetachedDerivedRenderCandidate, label: string): void => {
    try {
      candidate.dispose();
      const retained = failedDerivedDisposals.indexOf(candidate);
      if (retained >= 0) failedDerivedDisposals.splice(retained, 1);
    } catch (error) {
      if (!failedDerivedDisposals.includes(candidate)) {
        if (failedDerivedDisposals.length >= MAX_FAILED_DERIVED_DISPOSALS) {
          throw new AggregateError([error], `${label}; derived disposal retry queue is full`);
        }
        failedDerivedDisposals.push(candidate);
      }
      console.warn(label, error);
    }
  };

  const retryFailedDerivedDisposals = (): void => {
    const failures: unknown[] = [];
    for (const candidate of [...failedDerivedDisposals]) {
      try {
        candidate.dispose();
        const retained = failedDerivedDisposals.indexOf(candidate);
        if (retained >= 0) failedDerivedDisposals.splice(retained, 1);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} derived candidate disposal retry operation(s) failed`);
    }
  };

  // ── Derived snapshot verification venue (H8). The hash/re-encode pass over an
  //    untrusted snapshot runs in a dedicated verify worker so a full residency
  //    window never stalls the rAF thread; environments without Worker (headless
  //    gates) run the SAME verifier inline. Buffers are TRANSFERRED both ways, so
  //    the bytes verified are provably the bytes mounted. A channel-level worker
  //    failure fails that activation (its buffers are already detached) and every
  //    later activation verifies inline. ──
  let verifyWorker: { terminate(): void } | null = null;
  let derivedVerifier: DerivedSnapshotVerifier | null = null;
  let verifyWorkerUnavailable = false;
  const verifyDerivedSnapshotOffThread = (snapshot: unknown): Promise<ParsedTransferredDerivedSnapshot> => {
    if (typeof Worker !== "function" || verifyWorkerUnavailable) {
      try { return Promise.resolve(parseTransferredDerivedRuntimeSnapshot(snapshot)); }
      catch (error) { return Promise.reject(error); }
    }
    if (derivedVerifier === null) {
      try {
        const verifyWorkerUrl = opts.verifyWorkerUrl ?? new URL("./derived-verify-worker-entry.js", import.meta.url);
        const spawned = new Worker(verifyWorkerUrl as string | URL, { type: "module" }) as Worker;
        const client = new DerivedSnapshotVerifier({
          post: (message, transfer) => spawned.postMessage(message, transfer),
          listen: (handler) => { spawned.onmessage = (ev: MessageEvent<unknown>): void => handler(ev.data); },
        });
        spawned.onerror = (event: unknown): void => {
          verifyWorkerUnavailable = true;
          const detail = (event as { message?: unknown } | null)?.message;
          client.fail(new Error(`derived verify worker failed: ${typeof detail === "string" && detail.length > 0 ? detail : "worker error"}`));
          try { spawned.terminate(); } catch { /* already torn down */ }
          if (verifyWorker === spawned) { verifyWorker = null; derivedVerifier = null; }
        };
        verifyWorker = spawned;
        derivedVerifier = client;
      } catch (error) {
        verifyWorkerUnavailable = true;
        console.warn("derived verify worker unavailable; verifying inline", error);
        try { return Promise.resolve(parseTransferredDerivedRuntimeSnapshot(snapshot)); }
        catch (parseError) { return Promise.reject(parseError); }
      }
    }
    return derivedVerifier.verify(snapshot);
  };

  const requireDerivedDisposalCapacity = (): void => {
    // Reserve one slot for retirement and one for the active candidate's eventual teardown.
    if (failedDerivedDisposals.length < MAX_FAILED_DERIVED_DISPOSALS - 2) return;
    try { retryFailedDerivedDisposals(); } catch { /* the retained count below is authoritative */ }
    if (failedDerivedDisposals.length >= MAX_FAILED_DERIVED_DISPOSALS - 2) {
      throw new Error("derived activation is blocked by persistent GPU disposal failures");
    }
  };

  const teardown = (reason: string): Promise<void> => {
    if (teardownPromise !== undefined) return teardownPromise;
    stopped = true;
    teardownPromise = (async () => {
      const errors: unknown[] = [];
      const step = async (label: string, operation: () => void | Promise<void>): Promise<void> => {
        try { await operation(); }
        catch (error) {
          errors.push(error);
          console.warn(`live runtime ${label} cleanup failed`, error);
        }
      };
      liveLoop?.stop();
      liveLoop = null;
      for (const waiter of controlWaiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(reason));
      }
      controlWaiters.clear();
      for (const waiter of derivedControlWaiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(reason));
      }
      derivedControlWaiters.clear();
      for (const waiter of commandAckWaiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(reason));
      }
      commandAckWaiters.clear();
      await step("worker stop", async () => {
        // Bounded graceful stop: give the worker a short window to run its own teardown
        // (explicitly freeing the wasm Rapier world/controller) before the unconditional hard
        // terminate. A dead or hung worker must not stall teardown, so the wait is capped and
        // `terminate()` ALWAYS runs. Every waiter above was already rejected, so the only
        // message that still matters is the worker's `stopped` ack — replace the handler.
        try {
          if (!workerTerminated) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 1_500);
              const settle = (): void => { clearTimeout(timer); resolve(); };
              worker.onmessage = (ev: { data: unknown }): void => {
                if ((ev.data as { type?: string } | null)?.type === "stopped") settle();
              };
              try { worker.postMessage({ type: "stop" }); }
              catch { settle(); }
            });
          }
        } finally {
          workerTerminated = true;
          worker.terminate();
        }
      });
      await step("input", () => {
        if (opts.input !== undefined) cleanupInput?.detach(opts.input as Parameters<LivePlayerInput["detach"]>[0]);
        cleanupInput?.detachPointer();
      });
      await step("editor navigation", () => cleanupEditorNavigation?.dispose());
      await step("camera controls", () => cleanupCameraControls?.dispose());
      await step("entity residency", () => cleanupEntityStream?.clear());
      await step("derived terrain residency", () => cleanupDerivedTerrainResidency?.());
      await step("grass stream", () => cleanupGrassStream?.clear());
      await step("terrain stream", () => cleanupTerrainStream?.clear());
      await step("terrain material pool", () => cleanupTerrainMaterialPool?.dispose());
      await step("underwater effect", () => cleanupUnderwater?.dispose());
      await step("visible water", () => cleanupWater?.dispose());
      await step("derived revision", () => cleanupDerivedRevision?.());
      await step("derived disposal retries", retryFailedDerivedDisposals);
      await step("derived verify worker", () => {
        derivedVerifier?.fail(new Error(reason));
        derivedVerifier = null;
        const spawned = verifyWorker;
        verifyWorker = null;
        spawned?.terminate();
      });
      await step("post-processing", () => (cleanupWorld?.post as { dispose?(): void } | undefined)?.dispose?.());
      if (cleanupWorld !== undefined) cleanupWorld.post = undefined;
      await step("world render session", () => cleanupRenderSession?.dispose());
      if (ownsRenderHost) await step("renderer host", () => cleanupRenderHost?.dispose());
      if (errors.length > 0) throw new AggregateError(errors, `live runtime teardown failed in ${errors.length} step(s)`);
    })();
    return teardownPromise;
  };

  const reportTeardownFailure = (error: unknown): void => {
    console.warn("live runtime teardown failed after a fatal error", error);
  };

  try {

  const legacyScale = Number.isFinite(opts.renderScale) && (opts.renderScale ?? 1) > 1 ? opts.renderScale! : undefined;
  const renderHost = opts.renderHost ?? createBrowserRenderHost({
    canvas: opts.canvas,
    forceWebGL: opts.forceWebGL ?? false,
    initialQuality: opts.quality ?? "balanced",
    ...(legacyScale === undefined ? {} : { qualityOverride: { resolutionScale: legacyScale, maxPixelRatio: legacyScale } }),
  });
  cleanupRenderHost = renderHost;
  await Promise.all([...gltfIds].map(async (id) => {
    const bytes = prefetchedAssets.get(id);
    if (bytes === undefined) return;
    try { await renderHost.gltfCache.prewarm(id, bytes); }
    catch (error) {
      if (!(error instanceof GltfSceneParseError)) throw error;
      // Preserve the existing malformed-asset behavior: the mount reports the parse failure.
    }
  }));

  // The handshake ALWAYS settles: on `ready`, on `{type:"error"}`, on a hard worker.onerror, OR on
  // the deadline below. The event paths only cover a worker that ANSWERS (the old listener resolved
  // solely on `ready`, and a worker `{type:"error"}` left the promise pending forever, freezing the
  // viewport); a silently-dead worker — e.g. a module-resolution failure some browsers surface with
  // no onerror — fires none of them, so the timeout is the one settle path needing no cooperation
  // from the worker. Generous cap: init imports + instantiates wasm Rapier and authors the whole
  // command log before replying `ready`.
  const HANDSHAKE_TIMEOUT_MS = 30_000;
  const handshake = createWorkerHandshake<ReadyMessage>();
  const handshakeDeadline = setTimeout(
    () => handshake.fail(`sim worker init did not reply ready within ${HANDSHAKE_TIMEOUT_MS / 1000}s`),
    HANDSHAKE_TIMEOUT_MS,
  );
  worker.onmessage = (ev: { data: unknown }): void => { handshake.offer(ev.data); };
  worker.onerror = (ev: { message?: string }): void => handshake.fail("sim worker error: " + (ev.message ?? "unknown"));
  worker.postMessage({
    type: "init",
    commands: opts.commands,
    authoringProjectId: initialAuthoringProjectId,
    assets: [...prefetchedAssets].map(([id, bytes]) => ({ id, bytes })),
  });
  const handshakeResult = await handshake.promise;
  clearTimeout(handshakeDeadline);
  if (!handshakeResult.ok) {
    // A hard startup failure (no worker, rapier import/create failed) — the environment cannot host
    // the viewport. Report the SPECIFIC reason and return null (the "unsupported / cannot host"
    // signal, distinct from a per-command authoring failure, which keeps the viewport up below).
    status("error", handshakeResult.error);
    await teardown(handshakeResult.error).catch(reportTeardownFailure);
    return null;
  }
  const ready = handshakeResult.ready;
  // A worker throw can arrive DURING startup (the worker self-drives at 60Hz the moment
  // it posts `ready`, while this thread is still building WebGPU/scene). `aborted` records
  // that so the startup path below bails instead of overwriting status back to
  // ready/playing over a dead worker — otherwise an early solver throw looks like a
  // frozen sim reporting "playing".
  const failLive = (message: string): void => {
    aborted = true;
    status("error", message);
    for (const waiter of controlWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
    controlWaiters.clear();
    for (const waiter of derivedControlWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
    derivedControlWaiters.clear();
    for (const waiter of commandAckWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
    commandAckWaiters.clear();
    liveLoop?.stop();
    workerTerminated = true;
    worker.terminate();
    if (runtimeReady) void teardown(message).catch(reportTeardownFailure);
  };
  // Per-tick acks are ignored — the render thread reads progress from the status SAB
  // via Atomics (cross-thread, allocation-free), not the message channel. But a
  // solver throw inside the worker's step arrives as {type:"error"} on THIS channel;
  // keep handling messages after `ready` (instead of nulling onmessage) so that throw
  // is surfaced and the now-broken sim is torn down rather than dying silently.
  worker.onmessage = (ev: { data: unknown }): void => {
    const msg = ev.data as {
      type?: string;
      phase?: string;
      message?: string;
      failures?: AuthorCommandFailure[];
      requestId?: number | string;
      reason?: string;
      manifestHash?: string;
      code?: string;
      applied?: number;
      failed?: number;
    };
    if (typeof msg.requestId === "string" && (msg.type === "derivedRevisionStaged"
        || msg.type === "derivedRevisionCommitted" || msg.type === "derivedRevisionDiscarded"
        || msg.type === "derivedRevisionRejected")) {
      const waiter = derivedControlWaiters.get(msg.requestId);
      if (waiter === undefined) return;
      clearTimeout(waiter.timer);
      derivedControlWaiters.delete(msg.requestId);
      if (msg.type === "derivedRevisionRejected") {
        waiter.reject(new Error(`sim worker rejected derived revision (${msg.code ?? "UNKNOWN"})`));
      } else if (msg.type !== waiter.expected || msg.manifestHash !== waiter.manifestHash) {
        waiter.reject(new Error("sim worker derived revision acknowledgement did not match its request"));
      } else {
        waiter.resolve(msg as unknown as Record<string, unknown>);
      }
      return;
    }
    if (msg.type === "controlRejected" && typeof msg.requestId === "number" && Number.isSafeInteger(msg.requestId)) {
      const waiter = controlWaiters.get(msg.requestId);
      if (waiter) {
        clearTimeout(waiter.timer);
        controlWaiters.delete(msg.requestId);
        waiter.reject(new Error(msg.reason || "sim worker rejected control request"));
      }
      return;
    }
    if ((msg.type === "paused" || msg.type === "resumed") && typeof msg.requestId === "number" && Number.isSafeInteger(msg.requestId)) {
      const waiter = controlWaiters.get(msg.requestId);
      if (waiter && waiter.expected === msg.type) {
        clearTimeout(waiter.timer);
        controlWaiters.delete(msg.requestId);
        waiter.resolve();
      }
      return;
    }
    if (msg.type === "commandsApplied" && typeof msg.requestId === "number" && Number.isSafeInteger(msg.requestId)) {
      const waiter = commandAckWaiters.get(msg.requestId);
      if (waiter) {
        clearTimeout(waiter.timer);
        commandAckWaiters.delete(msg.requestId);
        waiter.resolve({
          applied: typeof msg.applied === "number" ? msg.applied : 0,
          failed: typeof msg.failed === "number" ? msg.failed : 0,
        });
      }
      return;
    }
    if (msg.type === "authoringFailures") {
      // NON-FATAL: the worker isolated a bad/out-of-band command (it kept stepping). The render
      // thread re-authors the same log and reports the same failures via `authoringFailures`, so this
      // is surfaced for observability, not treated as a fatal sim throw.
      console.warn(
        `limina sim worker isolated ${msg.failures?.length ?? 0} authoring failure(s) in ${msg.phase ?? "loadWorld"}:`,
        (msg.failures ?? []).map((f) => `#${f.index} ${f.command}: ${f.message}`).join("; "),
      );
      return;
    }
    if (msg.type !== "error") return; // tick acks (and anything else) are ignored
    failLive(`sim worker ${msg.phase ?? "tick"}: ${msg.message ?? "unknown"}`);
  };
  // Reassign onerror too: post-`ready`, a hard worker error must converge on the SAME
  // teardown as the message-channel path (the handshake handler above only resolved).
  worker.onerror = (ev: { message?: string }): void => failLive("sim worker error: " + (ev.message ?? "unknown"));

  // ── JOIN the worker's SABs (M2 transform bridge + M3 input ring + status). ──
  const joined = new SharedTransformStorage({ buffer: ready.buffer });
  const inputRing = new InputRingBuffer({ buffer: ready.inputBuffer });
  const statusShared = typeof SharedArrayBuffer === "function" && ready.status instanceof SharedArrayBuffer;
  const statusView = createSimStatusView(ready.status);
  const frameStatus: MutableSimStatusSnapshot = {
    tick: 0,
    flags: 0,
    playerEid: -1,
    generation: 0,
    inWater: false,
    swimming: false,
    submerged: false,
  };
  const readWorkerTick = (): number => (statusShared ? Atomics.load(statusView, 0) : statusView[0]);
  const requestWorkerControl = (type: "pause" | "resume"): Promise<void> => {
    const requestId = ++controlRequestId;
    const expected = type === "pause" ? "paused" : "resumed";
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        controlWaiters.delete(requestId);
        reject(new Error(`sim worker ${type} acknowledgement timed out`));
      }, 2_000);
      controlWaiters.set(requestId, { expected, resolve, reject, timer });
      try { worker.postMessage({ type, requestId }); }
      catch (error) {
        clearTimeout(timer);
        controlWaiters.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
  const forwardCommandsToWorker = (commands: AuthorCommand[]): Promise<{ applied: number; failed: number }> => {
    const requestId = ++commandAckRequestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        commandAckWaiters.delete(requestId);
        reject(new Error("sim worker applyCommands acknowledgement timed out"));
      }, 10_000);
      commandAckWaiters.set(requestId, { resolve, reject, timer });
      try { worker.postMessage({ type: "applyCommands", commands, requestId }); }
      catch (error) {
        clearTimeout(timer);
        commandAckWaiters.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
  const requestDerivedWorker = (
    type: "stageDerivedRevision" | "commitDerivedRevision" | "discardDerivedRevision",
    manifestHash: string,
    payload: Record<string, unknown>,
    transfer: Transferable[] = [],
  ): Promise<Record<string, unknown>> => {
    const requestId = `derived-sim-${++derivedControlRequestId}`;
    const expected = type === "stageDerivedRevision"
      ? "derivedRevisionStaged"
      : type === "commitDerivedRevision"
      ? "derivedRevisionCommitted"
      : "derivedRevisionDiscarded";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        derivedControlWaiters.delete(requestId);
        reject(new Error(`sim worker ${type} acknowledgement timed out`));
      }, 10_000);
      derivedControlWaiters.set(requestId, { expected, manifestHash, resolve, reject, timer });
      try { worker.postMessage({ type, requestId, manifestHash, ...payload }, transfer); }
      catch (error) {
        clearTimeout(timer);
        derivedControlWaiters.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  // ── Pre-warm GLB assets BEFORE the renderer exists. GLTFLoader.parse (createImageBitmap) + an
  //    async fetch are macrotasks; one firing around a render on the WebGL2 backend permanently
  //    corrupts it (invisible mesh — see prewarmGltfScene). Doing ALL the async asset work now —
  //    fetch the bytes + parse into the clone cache — means every mount during authoring is a
  //    synchronous clone (no macrotask), so the mesh renders. Best-effort; a missing asset just
  //    surfaces at mount time. ──
  // ── Physics + the authoring op surface FIRST. The AssetRegistry — and any cache-MISS resolve() in
  //    the apply loop below — needs a real op_read_asset; `new AssetRegistry()` with the default
  //    (still-unset module) ops throws "Cannot read op_read_asset of undefined" on the first uncached
  //    asset. Building physics here (not after buildRenderTarget) also lets installOps run before any
  //    renderer/baseline code reaches module-level `ops`. ──
  const rapier = opts.rapier ?? (await import("@dimforge/rapier3d-compat")) as unknown as RapierModule;
  const physics = await WasmRapierPhysics.create(rapier);
  const ops = composeAuthoringOps(physics, (id) => prefetchedAssets.get(id) ?? new Uint8Array(0));
  installOps(ops); // complete global op surface for any engine code reaching module-level `ops`

  const liveAssets = new AssetRegistry(ops);
  for (const [id, bytes] of prefetchedAssets) liveAssets.seed(id, bytes);

  // ── Build the real renderer/scene/camera (reuse Mode-A buildRenderTarget + baseline). ──
  // Map Phase 3.3: a map-STREAMED world renders its own ground wherever the camera goes, and its
  // sea floor sits BELOW y=0 — the baseline's flat ground plane would roof the whole ocean. Same
  // policy as run()'s terrain mode: suppress the baseline ground when the recorded log binds a
  // map terrain source (known from the commands up front). An explicit renderBaseline override
  // still wins (spread last).
  const streamingPlanned = opts.commands.some((cmd) =>
    cmd.kind === "skill" && cmd.tool === "world.setTerrainSource" &&
    (cmd.input as { kind?: unknown } | undefined)?.kind === "map"
  );
  const commandCameraFrame = deriveCommandCameraFrame(opts.commands);
  const largeMapTerrainPlanned = streamingPlanned || commandCameraFrame.largeMapTerrain;
  // Both streamed map worlds and editable terrain generated from a map need a production-scale
  // far plane and atmosphere. Map-generated terrain derives those values from its bounded local
  // editor frame; streamed maps retain the established 1500 m / 600 m-distance defaults.
  const streamedAtmosphere: RenderBaselineOverride = {
    camera: { far: commandCameraFrame.largeMapTerrain ? commandCameraFrame.farM : 1500 },
    atmosphere: { density: commandCameraFrame.largeMapTerrain ? commandCameraFrame.atmosphereDensity : 1 / 600 },
  };
  // Task #71: a world that AUTHORS real terrain (terrain.create editable layer, or generated
  // regions) renders its own ground — the baseline's flat 80×80 slate plane at y=0 would sit
  // ABOVE any seabed/river bed below y=0 and show through the transparent water as a dark
  // square, with the water's wave vertex displacement dipping around the opaque plane into a
  // dark "checkerboard/blob" pattern (the shallow-water artifact NE/SE of the map island).
  // Same policy run()'s terrain mode and the map-streamed path already apply: suppress the
  // baseline ground whenever the log builds terrain. An explicit override still wins.
  const terrainAuthored = opts.commands.some((cmd) =>
    cmd.kind === "skill" && (cmd.tool === "terrain.create" || cmd.tool === "world.generateRegion")
  );
  const liveBaseline: RenderBaselineOverride = largeMapTerrainPlanned
    ? { ground: { enabled: false }, ...streamedAtmosphere, ...(opts.renderBaseline ?? {}) }
    : terrainAuthored
    ? { ground: { enabled: false }, ...(opts.renderBaseline ?? {}) }
    : (opts.renderBaseline ?? {});
  status("loading", "starting WebGPU");
  const renderSession: BrowserRenderWorldSession = await renderHost.acquireWorld({
    width: opts.width,
    height: opts.height,
    baseline: liveBaseline,
    onTelemetry: opts.onRenderTelemetry,
  });
  cleanupRenderSession = renderSession;
  if (opts.quality !== undefined && renderSession.quality().tier !== opts.quality) renderSession.setQuality(opts.quality);
  const { renderer, scene, camera } = renderSession;

  // ── Re-author the SAME command log on the render-main thread against the REAL scene so meshes
  //    exist and eids match the worker (deterministic authoring). ──
  status("loading", "authoring scene meshes");

  const ecs = createEcsWorld();
  const entities = new EntityTable();
  const world: WorldContext = {
    ecs,
    transforms: createTransformStorage(ecs),
    spatial: new UniformGridSpatialIndex(),
    entities,
    tags: new Map(),
    design: createDesignArtifactStore(),
    scene,
    camera,
    ops,
    renderer,
    gltfCache: renderHost.gltfCache,
    width: opts.width,
    height: opts.height,
    mode: "windowed",
    peek: opts.peek === true,
  };
  cleanupWorld = world;
  const underwaterEffect = new UnderwaterEffect(scene);
  cleanupUnderwater = underwaterEffect;
  const registry = new SkillRegistry(LiminaTracer.ephemeral("ses_browser_live"));
  const core = registerCoreSkills(registry, { assets: liveAssets, grassVisualPackage: INTERACTIVE_TEMPERATE_MEADOW_PACKAGE });
  core.water.setQuality(renderSession.quality().water);
  cleanupWater = core.water;
  const authoringBinding = new AuthoringProjectBinding((projectId) => {
    registerBrowserAuthoringRuntime(registry, world, projectId);
  }, initialAuthoringProjectId);
  const permissions = resolveProfile(opts.profile ?? "builder.readWrite");
  const applyOne = (cmd: AuthorCommand): Promise<Awaited<ReturnType<typeof applyAuthorCommand>>> => {
    return applyAuthorCommand(registry, world, cmd, {
      sessionId: "ses_browser_live",
      defaultAgentId: "author",
      defaultPerms: permissions,
      tick: 0,
    });
  };
  // ISOLATE authoring (Layer-2 boundary): a single bad / out-of-band command must NOT terminate the
  // worker and return null-as-if-unsupported — that wedges the whole viewport. Apply every command,
  // collect the failures, and bring the viewport up with what DID author. (Same per-command contract
  // as `applyOne` — `applyAuthorCommandsIsolated` calls the very same `applyAuthorCommand`; only the
  // abort policy differs. This adds NO fetch/import/createImageBitmap between renderer.init() and the
  // first render — the assets were pre-warmed above — so the forceWebGL init-collapse window is
  // untouched: this loop's awaits are identical in kind to the original per-command loop.)
  const viewportBatch = partitionViewportCommands(opts.commands);
  const authoringOutcome = await applyAuthorCommandsIsolated(registry, world, viewportBatch.commands, {
    sessionId: "ses_browser_live",
    defaultAgentId: "author",
    defaultPerms: permissions,
    tick: 0,
  });
  const authoringFailures = authoringOutcome.failures.map((failure) => ({
    ...failure,
    index: viewportBatch.originalIndices[failure.index],
  }));
  if (authoringFailures.length > 0) {
    // The viewport still comes up; surface the offenders for observability. The caller (editor) reads
    // `running.authoringFailures` off the returned handle to quarantine + report which/why.
    console.warn(
      `limina live authoring isolated ${authoringFailures.length} failure(s):`,
      authoringFailures.map((f) => `#${f.index} ${authoringFailureMessage(opts.commands[f.index], f.message)}`).join("; "),
    );
  }

  // ── Cel-shading (toon) render style: swap PBR meshes → hard-banded MeshToonNodeMaterial now that the
  //    scene is fully authored (buildings + ground) and BEFORE the first render — synchronous, so it does
  //    not open a macrotask in the forceWebGL init-collapse window. Instanced vegetation is left as-is. ──
  if (opts.toon) {
    const n = applyToonStyle(scene, typeof opts.toon === "object" ? opts.toon : {});
    console.info(`limina toon style: converted ${n} material(s) to cel shading`);
  }

  const authoredPostPreset = (world.post as PostPipeline | undefined)?.preset as PostPreset | undefined;
  const rebuildPostForQuality = (profile: Readonly<import("./render/quality.ts").RenderQualityProfile>): void => {
    if (authoredPostPreset === undefined) return;
    const current = world.post as PostPipeline | undefined;
    const executionPreset = constrainPostPreset(authoredPostPreset, profile.post);
    if (executionPreset === undefined) {
      current?.dispose();
      world.post = undefined;
      return;
    }
    const replacement = buildPostPipeline(renderer, scene, camera, executionPreset);
    current?.dispose();
    world.post = replacement;
  };
  rebuildPostForQuality(renderSession.quality());

  // ── Map Phase 3.3: CLIENT-SIDE terrain streaming around the ACTIVE CAMERA. ──────────────────
  // Activates ONLY when the recorded log bound a map terrain source (world.setTerrainSource
  // {kind:"map"} — checked on the LIVE holder, so a failed/absent bind streams nothing). This is
  // VIEW state, never world state: the window follows whatever the local camera does, generates
  // tiles by PURE MATH from the already-rasterized master field (no fetch — the IR was seeded
  // before renderer.init()), mounts meshes SCENE-DIRECT (raycastable for the editor brush/ghost
  // tools; NO entity slots — MAX_ENTITIES untouched) plus a local heightfield collider, mirrors
  // that collider into the sim worker (keyed, so removal needs no cross-thread body-id
  // agreement), and writes NOTHING to the world log. Recorded terrain (generateRegion /
  // streamFollow region tiles, editable terrain.create slabs) stays authoritative: tiles the
  // record owns are treated as externally resident and never double-mounted. Full contract +
  // budget rationale in terrain/stream-client.ts; the loop is gated headlessly in
  // p_stream_client.ts. Mounts run inside frame() below — synchronous math only, so the
  // forceWebGL init-collapse window (no macrotask between init() and first render) is untouched.
  let terrainStream: ClientTerrainStream | undefined;
  let grassStream: GrassFieldStreamManager | undefined;
  {
    const holder = core.terrain.source;
    const mapSource = holder instanceof SwappableTerrainSource && holder.current instanceof MapTerrainSource
      ? holder.current
      : undefined;
    if (mapSource !== undefined) {
      // Window config: honor the LAST recorded world.streamFollow radius as the authored window
      // intent, else a 3-tile default (7×7 ≈ 336 m across at the 48 m tile). Keep-margin +1 —
      // the same load-at-r / drop-beyond-r+1 hysteresis the authoritative skill uses.
      // Cap 14 (window edge 672 m; Map Phase 3.5): the old ≤8 cap (≈384 m) put the streamed
      // edge well inside the Phase-3.4 fog knee (63% at 600 m), so the edge popped through the
      // haze on km-scale maps. At 14 the nearest window edge sits past the knee (~71% faded)
      // and the corners (~950 m) are >90% gone — measured against the 1 km proof renders
      // (tools/preview/stream-1km-proof-c.json). Still bounded: keep window (2·15+1)² = 961
      // tiles ≈ 9.6 MB of 33×33 heightfields, amortized in at ≤2 mounts/frame.
      let radius = 3;
      for (const cmd of opts.commands) {
        if (cmd.kind === "skill" && cmd.tool === "world.streamFollow") {
          const r = (cmd.input as { radius?: unknown } | undefined)?.radius;
          if (typeof r === "number" && r >= 1 && r <= 14) radius = Math.floor(r);
        }
      }
      // Streamed-tile look: the SAME elevation-banded vertex colors + terrain.paint overlay the
      // editable map slab (terrain.create source:"map") renders with, so both paths read as one
      // world. Bands resolve against the source's FIELD-WIDE relief (seam-consistent by design).
      const elevationColors = {
        seaLevel: mapSource.seaLevelM,
        amplitude: Math.max(1, mapSource.floorY + mapSource.spanY - mapSource.seaLevelM),
        snowFrac: 1.0,
      };
      const tileMeshes = new Map<string, ReturnType<typeof buildTerrainMesh>>();
      const tileBodies = new Map<string, number>();
      const terrainMaterialPool = new TerrainMaterialPool();
      cleanupTerrainMaterialPool = terrainMaterialPool;
      // A tile the RECORDED world already covers: any applied region tile (generateRegion /
      // streamFollow) at the same coord, or a tile fully inside an editable terrain.create
      // slab's footprint. Boundary tiles that only PARTIALLY overlap a slab still stream (no
      // window gaps); their overlap passes under the slab and sits at/below sea level in
      // practice. O(recorded tiles) per query, called ≤ budget times per frame.
      const tileExternallyOwned = (c: TileCoord): boolean => {
        for (const region of core.terrain.regions.values()) {
          for (const t of region.tiles.values()) {
            if (t.tx === c.tx && t.tz === c.tz) return true;
          }
        }
        const tMinX = c.tx * TILE_SIZE, tMaxX = tMinX + TILE_SIZE;
        const tMinZ = c.tz * TILE_SIZE, tMaxZ = tMinZ + TILE_SIZE;
        for (const layer of core.terrain.layers.values()) {
          const [lox, , loz] = layer.tile.origin;
          const [lsx, , lsz] = layer.tile.scale;
          if (tMinX >= lox - lsx / 2 && tMaxX <= lox + lsx / 2 && tMinZ >= loz - lsz / 2 && tMaxZ <= loz + lsz / 2) return true;
        }
        return false;
      };
      // PAINT-DRIVEN STREAMED GRASS (view state, like the tile stream itself): real instanced
      // blades on the near tiles wherever the map's paint channel says grass (density ∝ paintW;
      // none on sand/rock/underwater). Tiles register on mount and the manager grows/drops grass
      // around the camera (one transactional async tile build in flight, radius 2 + hysteresis 1)
      // inside frame() below. Native WebGPU concatenates canonical pages into one compute+draw per
      // terrain tile; forceWebGL uses the deterministic CPU source. No fetch/macrotask and ZERO entity slots. The
      // 60→110 m camera fade in the TSL material shrinks far blades into the painted ground tint,
      // so the grass edge never pops at the grow radius.
      // Grass is eye-level detail; an overview peek skips it (see RunLiveOptions.peek) — the painted
      // ground tint already reads the grassy areas from that distance.
      grassStream = opts.peek === true ? undefined : new GrassFieldStreamManager(scene, {
        tileSize: TILE_SIZE,
        // Preserve the package's near-field density and bound AREA through camera-local 16 m
        // residency cells. A sparse full-tile lattice recreates the rejected wispy silhouette.
        cellSize: TILE_SIZE / 3,
        renderer,
        visualPackage: INTERACTIVE_TEMPERATE_MEADOW_PACKAGE,
        quality: renderSession.quality().tier,
        source: () => ({
          seed: 1337,
          elevationMin: mapSource.seaLevelM + 0.05,
          spacing: grassFieldInstanceSpacing(INTERACTIVE_TEMPERATE_MEADOW_PACKAGE, renderSession.quality().tier, 0),
        }),
        onError: (error) => console.error("streamed grass field build failed", error),
      });
      cleanupGrassStream = grassStream;
      const grassStreamRef = grassStream;
      terrainStream = new ClientTerrainStream({
        tileSize: TILE_SIZE,
        radius,
        hysteresis: 1,
        maxLoadsPerUpdate: opts.terrainMountsPerFrame ?? 2, // live: ≤2/frame (no hitch); offline peek raises it to drain the queue fast
        getTile: (c) => mapSource.generateTile({ seed: 0, tx: c.tx, tz: c.tz, lod: 0 }),
        isExternal: tileExternallyOwned,
        mount: (key, c, tile) => {
          const mesh = buildTerrainMesh(tile, { elevationColors, materialPool: terrainMaterialPool });
          applyPaintOverlay(mesh.geometry, tile);
          scene.add(mesh);
          tileMeshes.set(key, mesh);
          grassStreamRef?.noteTile(key, c, tile);
          // Local collider + the sim-worker mirror, so raycasts here AND the locally-simulated
          // player over there both stand on the streamed ground. Keyed view-support state.
          const [ox, oy, oz] = tile.origin;
          const [sx, sy, sz] = tile.scale;
          tileBodies.set(key, ops.op_physics_add_heightfield(ox, oy, oz, tile.nrows, tile.ncols, sx, sy, sz, tile.heights));
          const add: StreamTileColliderAdd = { key, ox, oy, oz, nrows: tile.nrows, ncols: tile.ncols, sx, sy, sz, heights: tile.heights };
          worker.postMessage({ type: "streamTileColliders", add: [add], remove: [] });
        },
        unmount: (key) => {
          grassStreamRef?.dropTile(key);
          const mesh = tileMeshes.get(key);
          if (mesh !== undefined) {
            scene.remove(mesh);
            disposeTerrainMesh(mesh);
            tileMeshes.delete(key);
          }
          const bodyId = tileBodies.get(key);
          if (bodyId !== undefined) {
            ops.op_physics_remove_body(bodyId);
            tileBodies.delete(key);
          }
          worker.postMessage({ type: "streamTileColliders", add: [], remove: [key] });
        },
      });
      cleanupTerrainStream = terrainStream;
    }
  }

  type ActiveDerivedRevision = {
    candidate: DetachedDerivedRenderCandidate;
    bodyIds: number[];
    identity: Readonly<{ manifestHash: string; revision: number; headHash: string }>;
    residencyKey: string;
  };
  let activeDerivedRevision: ActiveDerivedRevision | null = null;
  let stagingDerivedCandidate: DetachedDerivedRenderCandidate | null = null;
  let derivedActivationInProgress = false;
  const suppressedAuthoredTerrainBodies = new Set<number>();

  const configureAuthoredTerrainFarField = (input: unknown): void => {
    if (!(input instanceof THREE.Mesh)) return;
    input.visible = true;
    input.castShadow = false;
    input.renderOrder = -100;
    input.raycast = () => {};
    input.userData.derivedTerrainFarField = true;
    const materials = Array.isArray(input.material) ? input.material : [input.material];
    for (const material of materials) {
      if (material.userData.derivedTerrainFarField === true) continue;
      // The authored full-map slab fills the view beyond the bounded LOD0 window. Render it first
      // and bias its depth back so resident derived chunks remain authoritative without z-fighting.
      material.polygonOffset = true;
      material.polygonOffsetFactor = 1;
      material.polygonOffsetUnits = 4;
      material.userData.derivedTerrainFarField = true;
      material.needsUpdate = true;
    }
  };

  const suppressAuthoredTerrainPresentation = (): void => {
    const currentBodies = new Set<number>();
    for (const layer of core.terrain.layers.values()) {
      currentBodies.add(layer.bodyId);
      if (!suppressedAuthoredTerrainBodies.has(layer.bodyId)) {
        ops.op_physics_remove_body(layer.bodyId);
      }
      if (layer.mesh !== undefined) configureAuthoredTerrainFarField(layer.mesh);
      if (layer.grass !== undefined) (layer.grass as unknown as { visible?: boolean }).visible = false;
      if (layer.blightMist !== undefined) (layer.blightMist as unknown as { visible: boolean }).visible = false;
    }
    for (const region of core.terrain.regions.values()) for (const tile of region.tiles.values()) {
      currentBodies.add(tile.bodyId);
      if (!suppressedAuthoredTerrainBodies.has(tile.bodyId)) {
        ops.op_physics_remove_body(tile.bodyId);
      }
      if (tile.mesh !== undefined) (tile.mesh as { visible: boolean }).visible = false;
    }
    suppressedAuthoredTerrainBodies.clear();
    for (const bodyId of currentBodies) suppressedAuthoredTerrainBodies.add(bodyId);
    terrainStream?.clear();
    terrainStream = undefined;
    void grassStream?.clear().catch((error) => console.error("streamed grass field cleanup failed", error));
    grassStream = undefined;
  };

  // ── Task #78: PLACED-ENTITY residency streaming around the ACTIVE CAMERA. ─────────────────
  // View state, exactly like the tile/grass streams above: far placed props' RETAINED meshes
  // are DETACHED from the scene graph and re-attached on approach — the EntityTable slot, eid,
  // SoA transform, renderables binding, SAB lane and colliders all stay as authored, so ids
  // stay deterministic and an unloaded prop re-materializes byte-identical (contract + what
  // this does/doesn't bound: browser/entity-stream.ts; gated in p_entity_stream). ACTIVE only
  // on a map-streamed world (unbounded roaming) or when the log carries > threshold streamable
  // props; small orbit scenes keep every mesh resident, unchanged. Dormant edits need no
  // special path — setMaterial mutates the retained mesh, moves write the SoA renderSyncSystem
  // keeps copying onto the detached object — so live in-place commands apply as-is.
  let entityStream: EntityResidencyStream | undefined;
  const entityStreamProtected = new Set<string>();
  const entityWiring = createEntityResidencyWiring(entities, entityStreamProtected);
  {
    const es = opts.entityStream ?? {};
    const candidates = entities.ids().filter((id) => entityWiring.eligible(id));
    const active = es.enabled ?? (streamingPlanned || candidates.length > (es.threshold ?? 512));
    if (active) {
      entityStream = new EntityResidencyStream({
        // Map-streamed default 600 m: at the Phase-3.4 haze (FogExp2 density 1/600) a prop at
        // 600 m is ~63% faded, so the de/re-materialization edge sits in air the fog already
        // owns. Non-streamed (>threshold) worlds default tighter — their far plane is nearer.
        radiusM: es.radius ?? (streamingPlanned ? 600 : 300),
        hysteresisM: es.hysteresis ?? 50,
        maxOpsPerUpdate: es.budget ?? 4,
        getPosition: entityWiring.getPosition,
        isProtected: entityWiring.isProtected,
        dematerialize: entityWiring.dematerialize,
        rematerialize: entityWiring.rematerialize,
      });
      cleanupEntityStream = entityStream;
      for (const id of candidates) entityStream.register(id);
    }
  }

  // The authored entity eids = the render set; capture their (static) authored scale
  // so the interpolator keeps meshes at size (the worker syncs position+rotation only).
  const eids: number[] = [];
  // BODILESS statics (asset.place / asset.scatter / any renderable with no physics body)
  // need their authored pose SEEDED into the transform SAB below: the sim-worker streams
  // ONLY body-bound entities into the SAB each tick (sim-worker syncTransforms skips
  // `bodyId === undefined`), so a bodiless slot would otherwise stay at the SAB's zero and
  // the mesh would collapse onto the origin. Body-bound entities are left out here — the
  // worker owns their per-tick pose (seeding them would fight the live physics sync).
  const bodilessEids: number[] = [];
  for (const id of entities.ids()) {
    const entry = entities.resolve(id);
    const eid = entry?.eid;
    if (eid === undefined) continue;
    eids.push(eid);
    if (entry?.bodyId === undefined) bodilessEids.push(eid);
  }
  const authoredScale = new SharedTransformStorage();
  for (const eid of eids) {
    authoredScale.Scale.x[eid] = Scale.x[eid];
    authoredScale.Scale.y[eid] = Scale.y[eid];
    authoredScale.Scale.z[eid] = Scale.z[eid];
  }
  const syncAuthoredScaleMutation = (cmd: AuthorCommand): void => {
    if (cmd.kind !== "skill" || cmd.tool !== "ecs.updateComponent") return;
    const input = cmd.input as { entity?: unknown; component?: unknown; value?: unknown };
    if (typeof input.entity !== "string" || input.component !== "scale" || !Array.isArray(input.value)) return;
    const eid = entities.resolve(input.entity)?.eid;
    if (eid === undefined) return;
    authoredScale.Scale.x[eid] = Number(input.value[0]);
    authoredScale.Scale.y[eid] = Number(input.value[1]);
    authoredScale.Scale.z[eid] = Number(input.value[2]);
  };
  const syncAuthoredScaleForEid = (eid: number): void => {
    authoredScale.Scale.x[eid] = Scale.x[eid];
    authoredScale.Scale.y[eid] = Scale.y[eid];
    authoredScale.Scale.z[eid] = Scale.z[eid];
  };
  const seedJoinedTransformForEid = (eid: number): void => {
    joined.Position.x[eid] = Position.x[eid];
    joined.Position.y[eid] = Position.y[eid];
    joined.Position.z[eid] = Position.z[eid];
    joined.Rotation.x[eid] = Rotation.x[eid];
    joined.Rotation.y[eid] = Rotation.y[eid];
    joined.Rotation.z[eid] = Rotation.z[eid];
    joined.Rotation.w[eid] = Rotation.w[eid];
  };
  // Seed the shared transform SAB with each bodiless static's authored Position+Rotation
  // (Scale is supplied per-frame by SnapshotRing from `authoredScale`). Symmetric with the
  // incremental live-authoring path (seedJoinedTransformForEid on newly-added eids) and with
  // the authoredScale seed above — the initial authored set was the one channel that never
  // seeded Position/Rotation, so bodiless statics read 0 and stacked at the origin. This seed
  // is STABLE across every tick: the worker never overwrites a bodiless SAB slot, so freeze →
  // interpolate carries the authored pose forward unchanged (prev==curr ⇒ no drift).
  for (const eid of bodilessEids) seedJoinedTransformForEid(eid);
  const captureNewEids = (beforeSeq: number, result: unknown): number[] => {
    const out: number[] = [];
    const entity = resultEntityId(result);
    if (entity !== undefined) {
      const eid = entities.resolve(entity)?.eid;
      if (eid !== undefined) out.push(eid);
    }
    for (const id of entities.idsCreatedSince(beforeSeq)) {
      const eid = entities.resolve(id)?.eid;
      if (eid !== undefined && !out.includes(eid)) out.push(eid);
    }
    return out;
  };

  // ── M4 interpolation: tween the two latest frozen ticks into the render store
  //    (the world.ts SoA globals renderSyncSystem reads) each frame. ──
  const renderStore: TransformStore = { Position, Rotation, Scale };
  const interp = new FrameInterpolator(renderStore);
  const ring = new SnapshotRing(eids, authoredScale);
  let lastConsumed = -1;
  const suppressedEids = new Set<number>();

  // ── Input pump + camera framing. ──
  const liveInput = new LivePlayerInput();
  cleanupInput = liveInput;
  const inFrame = { move: [0, 0, 0] as [number, number, number], look: [0, 0] as [number, number], buttons: [0, 0] as [number, number], tick: 0 };

  const orbitCenter = opts.orbit?.center ?? [
    commandCameraFrame.target[0],
    commandCameraFrame.target[1],
    commandCameraFrame.target[2],
  ];
  const orbitSpin = opts.orbit?.autoSpin ?? 0.004;
  let angle = 0;
  const radius = opts.orbit?.radius ?? commandCameraFrame.orbitRadiusM;
  const camHeight = opts.orbit?.height ?? commandCameraFrame.orbitHeightM;
  if (opts.orbit?.far !== undefined) {
    const cam = camera as unknown as { far: number; updateProjectionMatrix(): void };
    // RunLive orbit fields are explicit caller authority; command-derived framing supplies defaults.
    cam.far = opts.orbit.far;
    cam.updateProjectionMatrix();
  }
  const editorNavigationConfig = opts.editorNavigation === true
    ? {}
    : opts.editorNavigation !== null && typeof opts.editorNavigation === "object"
    ? opts.editorNavigation
    : undefined;
  const editorNavigationEnabled = opts.editorNavigation === true || editorNavigationConfig !== undefined;
  if (editorNavigationEnabled && opts.vantage !== undefined) {
    throw new TypeError("editorNavigation cannot be combined with a positioned vantage camera");
  }
  let cameraControls: InstanceType<typeof THREE.OrbitControls> | undefined;
  let editorNavigation: EditorNavigationController | undefined;
  if (opts.orbitControls === true || editorNavigationEnabled) {
    camera.position.set(
      orbitCenter[0] + Math.cos(angle) * radius,
      orbitCenter[1] + camHeight,
      orbitCenter[2] + Math.sin(angle) * radius,
    );
    camera.lookAt(orbitCenter[0], orbitCenter[1], orbitCenter[2]);
    const controlsMinDistance = Math.min(commandCameraFrame.controls.minDistanceM, Math.max(2, radius * 0.5));
    const controlsMaxDistance = Math.max(
      controlsMinDistance + 1,
      opts.orbit?.radius === undefined ? commandCameraFrame.controls.maxDistanceM : Math.min(576, Math.max(128, radius * 3)),
    );
    if (editorNavigationEnabled) {
      editorNavigation = new EditorNavigationController({
        camera,
        element: renderer.domElement,
        ...(opts.input === undefined ? {} : { keyTarget: opts.input as EventTarget }),
        navigation: {
          target: orbitCenter,
          minDistanceM: controlsMinDistance,
          maxDistanceM: controlsMaxDistance,
          maxPolarAngleRad: commandCameraFrame.controls.maxPolarAngleRad,
          ...editorNavigationConfig,
        },
      });
      cleanupEditorNavigation = editorNavigation;
      cameraControls = editorNavigation.orbitControls;
    } else {
      cameraControls = new THREE.OrbitControls(camera, renderer.domElement);
      cleanupCameraControls = cameraControls;
      cameraControls.target.set(orbitCenter[0], orbitCenter[1], orbitCenter[2]);
      cameraControls.enableRotate = true;
      cameraControls.enableZoom = true;
      cameraControls.enablePan = true;
      cameraControls.enableDamping = true;
      cameraControls.minDistance = controlsMinDistance;
      cameraControls.maxDistance = controlsMaxDistance;
      cameraControls.minPolarAngle = 0.04;
      cameraControls.maxPolarAngle = commandCameraFrame.controls.maxPolarAngleRad;
      cameraControls.update();
    }
  }

  // ── POSITIONED VANTAGE CAMERA (Places Stage 2). Sit AT a point on the map and look a fixed
  //    heading — no orbit, no auto-spin. Same convention as the first-person branch below
  //    (yaw=0 → forward is -Z). The pose is set ONCE here; the frame loop holds it. ──
  const vantage = opts.vantage;
  if (vantage !== undefined) {
    const [vx, vy, vz] = vantage.pos;
    const pitch = vantage.pitch ?? 0;
    const cp = Math.cos(pitch);
    camera.position.set(vx, vy, vz);
    camera.lookAt(vx + Math.sin(vantage.yaw) * cp, vy + Math.sin(pitch), vz - Math.cos(vantage.yaw) * cp);
    if (vantage.far !== undefined) {
      const cam = camera as unknown as { far: number; updateProjectionMatrix(): void };
      cam.far = vantage.far;
      cam.updateProjectionMatrix();
    }
  }

  // ── FIRST-PERSON CAMERA. When a player character was spawned (player.spawn is in the log), put the
  //    camera AT the player capsule's eye instead of auto-orbiting — so the settlement is WALKABLE and
  //    scale reads true against doorways (no avatar mesh needed; the player IS the camera). Gated on a
  //    player existing: non-player scenes (the fidelity renders) find no controller and keep the orbit
  //    path untouched. View yaw/pitch track the input look (inFrame.look, mouse-driven), and the
  //    character controller rotates WASD+strafe by that same yaw, so movement is view-relative. ──
  let playerEid: number | undefined;
  {
    const playerId = core.player.controllers.ids()[0];
    if (playerId !== undefined) {
      playerEid = entities.resolve(playerId)?.eid;
      if (playerEid !== undefined && editorNavigation === undefined) {
        // Mouse-look ONLY on a walkable (player) scene: click the canvas to capture the pointer, then
        // mouse X yaws the view + mouse Y pitches it. Gated on a player so it never hijacks the
        // editor's click-to-select on a non-player scene.
        if (opts.input !== undefined) liveInput.attach(opts.input as Parameters<LivePlayerInput["attach"]>[0]);
        liveInput.attachPointer(renderer.domElement as Parameters<LivePlayerInput["attachPointer"]>[0]);
      }
    }
  }
  const playerCameraActive = playerEid !== undefined && editorNavigation === undefined;
  // Eye height above the capsule CENTER (center rests at ~0.9 m for the 1.8 m capsule → eye ~1.6 m).
  const EYE_OFFSET = 0.7;
  const navigationAnchor = { x: 0, y: 0, z: 0 };
  const navigationFocus: [number, number, number] = [0, 0, 0];
  if (editorNavigation !== undefined) editorNavigation.writeAnchor(navigationAnchor);
  const residencyStartX = editorNavigation !== undefined
    ? navigationAnchor.x
    : playerCameraActive
    ? Position.x[playerEid!]
    : cameraControls !== undefined
    ? cameraControls.target.x
    : camera.position.x;
  const residencyStartZ = editorNavigation !== undefined
    ? navigationAnchor.z
    : playerCameraActive
    ? Position.z[playerEid!]
    : cameraControls !== undefined
    ? cameraControls.target.z
    : camera.position.z;
  const derivedTerrainResidencyTracker = new DerivedTerrainResidencyTracker({
    center: [residencyStartX, residencyStartZ],
    radius: 7,
    thresholdChunks: 2,
    onListenerError: (error) => console.warn("derived terrain residency listener failed", error),
  });
  cleanupDerivedTerrainResidency = () => derivedTerrainResidencyTracker.dispose();

  const updateDerivedTerrainResidency = (): void => {
    if (editorNavigation !== undefined) {
      editorNavigation.writeAnchor(navigationAnchor);
      derivedTerrainResidencyTracker.update(navigationAnchor.x, navigationAnchor.z);
    } else if (playerCameraActive) {
      derivedTerrainResidencyTracker.update(Position.x[playerEid!], Position.z[playerEid!]);
    } else if (cameraControls !== undefined) {
      derivedTerrainResidencyTracker.update(cameraControls.target.x, cameraControls.target.z);
    } else {
      derivedTerrainResidencyTracker.update(camera.position.x, camera.position.z);
    }
  };

  // If the worker already threw during the WebGPU/scene build above, bail now instead
  // of announcing "ready"/"playing" over a terminated worker (failLive set the status).
  if (aborted) {
    await teardown("sim worker aborted during startup").catch(reportTeardownFailure);
    return null;
  }

  status("ready", `${eids.length} entities authored — live sim running`);

  const pickEntityId = (object: { parent?: unknown }): string | undefined => {
    let current: unknown = object;
    while (current !== undefined && current !== null) {
      const eid = renderableOwnerEid(current);
      if (eid !== undefined) {
        const id = entities.entityByEid(eid);
        if (id !== undefined) return id;
      }
      current = typeof current === "object" ? (current as { parent?: unknown }).parent : undefined;
    }
    return undefined;
  };

  // ── The accumulator rAF loop (host.ts). `step` consumes the worker's latest tick
  //    (freezing it for interpolation) at the fixed cadence; `frame(alpha)` pumps
  //    input, interpolates by alpha, syncs the scene, and renders. ──
  let paused = false;
  let viewSuspended = false;
  // Status detail refreshes at ~1Hz, not per tick: the first consumed tick still announces
  // "playing" immediately (callers wait on the phase), but a fresh `tick N` string 60×/s is
  // allocation churn for a label nothing can read at that rate.
  let nextStatusTick = 0;
  const loop = startAccumulatorLoop({
    step: (): void => {
      const t = readWorkerTick();
      if (t > lastConsumed) {
        interp.push(ring.freeze(joined));
        lastConsumed = t;
        if (t >= nextStatusTick) {
          status("playing", `tick ${t}`);
          nextStatusTick = t + 60;
        }
      }
    },
    frame: (alpha: number): void => {
      // A hidden retained Edit runtime can suspend render work while its deterministic worker is
      // paused. Visible Play remains composited while paused so its last state and editor UI render.
      if (!shouldRenderLiveFrame(viewSuspended) || derivedActivationInProgress) return;
      // Publish this frame's input into the M3 ring (consumed by the worker next tick).
      inputRing.writeInput(liveInput.frame(lastConsumed < 0 ? 0 : lastConsumed, inFrame));
      // Tween prev→curr by alpha into the render store, then drive the scene + render.
      interp.interpolate(alpha, ring.presentSet);
      renderSyncSystem(ecs, suppressedEids);
      if (playerCameraActive) {
        // FIRST-PERSON: sit at the player capsule's eye (interpolated Position + EYE_OFFSET) and look
        // along the mouse heading (yaw) + pitch. yaw=0 → forward is -Z, matching the controller's move
        // basis (character.ts), so W walks where you look.
        const yaw = inFrame.look[0];
        const pitch = inFrame.look[1];
        const cp = Math.cos(pitch);
        const ex = Position.x[playerEid!];
        const ey = Position.y[playerEid!] + EYE_OFFSET;
        const ez = Position.z[playerEid!];
        camera.position.set(ex, ey, ez);
        camera.lookAt(ex + Math.sin(yaw) * cp, ey + Math.sin(pitch), ez - Math.cos(yaw) * cp);
      } else if (editorNavigation !== undefined) {
        editorNavigation.update();
        const surfaceHeight = activeDerivedRevision?.candidate.snapshot.terrain.sampleHeight(
          camera.position.x,
          camera.position.z,
        );
        if (surfaceHeight !== undefined && surfaceHeight !== null) {
          editorNavigation.constrainAboveSurface(surfaceHeight);
        }
      } else if (cameraControls !== undefined) {
        cameraControls.update();
      } else if (vantage !== undefined) {
        // Static positioned camera — pose was set once at boot; hold it. (Terrain streaming
        // below still reads camera.position, which stays fixed at the vantage.)
      } else {
        angle += orbitSpin;
        camera.position.set(
          orbitCenter[0] + Math.cos(angle) * radius,
          orbitCenter[1] + camHeight,
          orbitCenter[2] + Math.sin(angle) * radius,
        );
        camera.lookAt(orbitCenter[0], orbitCenter[1], orbitCenter[2]);
      }
      updateDerivedTerrainResidency();
      if (readSimStatusInto(statusView, frameStatus)) underwaterEffect.update(frameStatus.submerged);
      // Map Phase 3.3: editor navigation streams every view subsystem from its mode-aware anchor
      // (orbit target or fly camera); gameplay and legacy views retain the active camera position. Budgeted pure
      // math + budgeted async grass compute only (no fetch/macrotask — the map IR was resolved at boot),
      // so the forceWebGL init-collapse window stays untouched.
      if (terrainStream !== undefined || entityStream !== undefined) {
        const camPos = (camera as unknown as { position: { x: number; z: number } }).position;
        const streamX = editorNavigation === undefined ? camPos.x : navigationAnchor.x;
        const streamZ = editorNavigation === undefined ? camPos.z : navigationAnchor.z;
        terrainStream?.update(streamX, streamZ);
        // Grass follows the same camera anchor, with at most one unpublished build in flight.
        grassStream?.update(streamX, streamZ);
        // Task #78: placed-entity residency follows the same anchor — ≤4 detach/attach ops of
        // RETAINED objects per frame (no fetch/parse/macrotask; the meshes already exist).
        entityStream?.update(streamX, streamZ);
      }
      // Screen-distance and population LOD: select render-only levels/residency for THIS frame's
      // camera before drawing. Population controllers rebuild aggregate buffers only on transitions.
      const wl = (world as unknown as { lods?: Array<{ update: (c: unknown) => void }> }).lods;
      if (wl !== undefined) for (const l of wl) l.update(camera);
      if (editorNavigation !== undefined) {
        navigationFocus[0] = navigationAnchor.x;
        navigationFocus[1] = navigationAnchor.y;
        navigationFocus[2] = navigationAnchor.z;
      }
      const focus = playerCameraActive
        ? [Position.x[playerEid!], Position.y[playerEid!], Position.z[playerEid!]] as const
        : editorNavigation !== undefined
        ? navigationFocus
        : cameraControls !== undefined
        ? [cameraControls.target.x, cameraControls.target.y, cameraControls.target.z] as const
        : vantage !== undefined
        ? [camera.position.x, camera.position.y, camera.position.z] as const
        : orbitCenter;
      renderSession.updateShadowFocus(focus);
      // Opt-in RENDER-ONLY post stack: render.enablePost stashes a PostPipeline on world.post;
      // when present, drive its GTAO/bloom/grade composite in place of the bare present.
      const wp = (world as unknown as { post?: { render: () => void } }).post;
      renderSession.render(() => { if (wp) wp.render(); else renderer.render(scene, camera); });
    },
  });
  liveLoop = loop; // let the error handler above stop the loop on a worker throw
  runtimeReady = true;

  let controlTail = Promise.resolve();
  let publicPauseIntent = false;
  let activationPauseLeases = 0;
  const reconcilePaused = (): Promise<void> => {
    const work = async (): Promise<void> => {
      if (stopped) throw new Error("live runtime is stopped");
      const target = publicPauseIntent || activationPauseLeases > 0;
      if (paused === target) return;
      await requestWorkerControl(target ? "pause" : "resume");
      paused = target;
    };
    const result = controlTail.then(work, work);
    controlTail = result.then(() => undefined, () => undefined);
    return result;
  };
  const setPaused = (next: boolean): Promise<void> => {
    publicPauseIntent = next;
    return reconcilePaused();
  };
  const acquireActivationPause = async (): Promise<() => Promise<void>> => {
    activationPauseLeases++;
    let released = false;
    try { await reconcilePaused(); }
    catch (error) {
      activationPauseLeases--;
      throw error;
    }
    return async (): Promise<void> => {
      if (released) return;
      released = true;
      activationPauseLeases--;
      if (!stopped) await reconcilePaused();
    };
  };
  let runtimeMutationTail = Promise.resolve();
  const serializeRuntimeMutation = <T>(work: () => Promise<T>): Promise<T> => {
    const result = runtimeMutationTail.then(work, work);
    runtimeMutationTail = result.then(() => undefined, () => undefined);
    return result;
  };
  let stopPromise: Promise<void> | undefined;
  let localFogDensity: number | undefined;
  const stopLive = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopped = true;
    stopPromise = teardown("live runtime stopped during worker control request");
    return stopPromise;
  };

  const derivedIdentity = (candidate: DetachedDerivedRenderCandidate): Readonly<{
    manifestHash: string;
    revision: number;
    headHash: string;
  }> => Object.freeze({
    manifestHash: candidate.snapshot.manifestHash,
    revision: candidate.snapshot.source.revision,
    headHash: candidate.snapshot.source.headHash,
  });

  const removeDerivedBodies = (bodyIds: readonly number[]): void => {
    const errors: unknown[] = [];
    for (const bodyId of bodyIds) {
      try { ops.op_physics_remove_body(bodyId); }
      catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, `${errors.length} derived collider removal operation(s) failed`);
  };

  const activateDerivedRevision = (
    snapshot: unknown,
    options: Readonly<{
      signal?: AbortSignal;
      contentAccess?: DerivedRuntimeTransportConfig;
    }> = {},
  ): Promise<Readonly<{ manifestHash: string; revision: number; headHash: string }>> => {
    const work = async (): Promise<Readonly<{ manifestHash: string; revision: number; headHash: string }>> => {
      if (stopped) throw new Error("live runtime is stopped");
      const signal = options.signal;
      const cancelled = (): void => {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("derived revision activation was cancelled");
      };
      cancelled();
      requireDerivedDisposalCapacity();
      // Off-main-thread verification (H8): hash/re-encode runs in the verify worker
      // (inline where no Worker exists) and a rejection fails this activation exactly
      // as the former in-constructor parse throw did. Frames keep rendering while the
      // worker verifies; only mounting below runs under the activation gate.
      const verifiedSnapshot = await verifyDerivedSnapshotOffThread(snapshot);
      cancelled();
      const candidate = new DetachedDerivedRenderCandidate(verifiedSnapshot, {
        quality: renderSession.quality().tier,
      });
      const identity = derivedIdentity(candidate);
      const residencyKey = derivedTerrainResidencyKey(candidate.snapshot.residency);
      if (activeDerivedRevision?.identity.manifestHash === identity.manifestHash
          && activeDerivedRevision.residencyKey === residencyKey) {
        disposeDerivedCandidate(candidate, "duplicate derived candidate disposal failed");
        return activeDerivedRevision.identity;
      }
      stagingDerivedCandidate = candidate;
      let stagedRequestId: string | undefined;
      let candidateBodies: number[] = [];
      let candidateAttached = false;
      let simCommitted = false;
      let commitDispatched = false;
      let failClosed = false;
      let releaseActivationPause: (() => Promise<void>) | undefined;
      // GLTF parsing and texture decode can yield macrotasks. Gate frame work before any population
      // fetch/parse begins so neither backend can render through the known WebGL corruption window.
      derivedActivationInProgress = true;
      try {
        if (candidate.snapshot.populationPlan !== null) {
          if (options.contentAccess === undefined) {
            throw new Error("derived biome population activation requires authenticated main-realm content access");
          }
          await candidate.stagePopulation(({ plan, content, root, terrainWindow, biomeField, runtimePack, waterCoverageAt }) => mountTransportDerivedBiomePopulation({
            plan,
            content,
            root,
            terrainWindow,
            biomeField,
            runtimePack,
            waterCoverageAt,
            manifestHash: identity.manifestHash,
            contentAccess: options.contentAccess!,
            signal,
            world,
            camera,
            quality: renderSession.quality().tier,
            gltfCache: renderHost.gltfCache,
            ops,
          }));
          cancelled();
        }
        const transfer: Transferable[] = [];
        const terrainWindow = candidate.terrainWindow().map((entry) => {
          const heights = entry.tile.heights.slice();
          transfer.push(heights.buffer);
          return {
            key: entry.key,
            tx: entry.tx,
            tz: entry.tz,
            tile: {
              nrows: entry.tile.nrows,
              ncols: entry.tile.ncols,
              origin: [entry.tile.origin[0], entry.tile.origin[1], entry.tile.origin[2]] as [number, number, number],
              scale: [entry.tile.scale[0], entry.tile.scale[1], entry.tile.scale[2]] as [number, number, number],
              heights,
            },
          };
        });
        const generated = candidate.snapshot.generatedWater;
        const generatedBytes = generated?.bytes.slice();
        if (generatedBytes !== undefined) transfer.push(generatedBytes.buffer);
        const stageSnapshot: DerivedSimStageSnapshot = {
          schema: DERIVED_SIM_STAGE_SCHEMA,
          projectId: candidate.snapshot.projectId,
          branchId: candidate.snapshot.branchId,
          source: candidate.snapshot.source,
          manifestHash: identity.manifestHash,
          grid: candidate.snapshot.manifest.grid,
          terrainWindow,
          ...(generated === null ? {} : {
            generatedWater: {
              artifact: generated.artifact,
              bytes: generatedBytes!,
              bindings: generated.bindings,
            },
          }),
        };
        releaseActivationPause = await acquireActivationPause();
        cancelled();
        const staged = await requestDerivedWorker("stageDerivedRevision", identity.manifestHash, { snapshot: stageSnapshot }, transfer);
        stagedRequestId = String(staged.requestId);
        cancelled();
        for (const entry of candidate.terrainWindow()) {
          const tile = entry.tile;
          candidateBodies.push(ops.op_physics_add_heightfield(
            tile.origin[0], tile.origin[1], tile.origin[2], tile.nrows, tile.ncols,
            tile.scale[0], tile.scale[1], tile.scale[2], tile.heights,
          ));
        }
        candidate.setQuality(renderSession.quality().tier);
        scene.add(candidate.root);
        candidateAttached = true;
        cancelled();
        commitDispatched = true;
        const commitAck = requestDerivedWorker("commitDerivedRevision", identity.manifestHash, { stagedRequestId });
        if (signal === undefined) await commitAck;
        else {
          let onAbort: (() => void) | undefined;
          try {
            await Promise.race([
              commitAck,
              new Promise<never>((_resolve, reject) => {
                onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("derived revision activation was cancelled"));
                signal.addEventListener("abort", onAbort, { once: true });
              }),
            ]);
          } finally {
            if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
          }
        }
        simCommitted = true;
        cancelled();

        // No frame or fixed step can observe the transition: render is gated and simulation remains
        // paused until the new group, local colliders, and sim contact/colliders all agree.
        suppressAuthoredTerrainPresentation();
        editorNavigation?.constrainToResidencyGrid(candidate.snapshot.manifest.grid.chunkSizeM, 7, 2);
        derivedTerrainResidencyTracker.setGrid(candidate.snapshot.manifest.grid);
        const prior = activeDerivedRevision;
        activeDerivedRevision = { candidate, bodyIds: candidateBodies, identity, residencyKey };
        cleanupDerivedRevision = () => {
          const active = activeDerivedRevision;
          if (active === null) return;
          activeDerivedRevision = null;
          const errors: unknown[] = [];
          try { scene.remove(active.candidate.root); } catch (error) { errors.push(error); }
          try { removeDerivedBodies(active.bodyIds); } catch (error) { errors.push(error); }
          try { disposeDerivedCandidate(active.candidate, "active derived revision disposal failed"); }
          catch (error) { errors.push(error); }
          if (errors.length > 0) throw new AggregateError(errors, "active derived revision cleanup failed");
        };
        candidateBodies = [];
        candidateAttached = false;
        if (prior !== null) {
          const errors: unknown[] = [];
          try { scene.remove(prior.candidate.root); } catch (error) { errors.push(error); }
          try { removeDerivedBodies(prior.bodyIds); } catch (error) { errors.push(error); }
          try { disposeDerivedCandidate(prior.candidate, "derived revision retirement failed"); }
          catch (error) { errors.push(error); }
          if (errors.length > 0) throw new AggregateError(errors, "derived revision retirement failed");
        }
        return identity;
      } catch (error) {
        if (commitDispatched) {
          failClosed = true;
          failLive(
            `derived revision commit outcome is indeterminate for ${identity.manifestHash}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        try { if (candidateAttached) scene.remove(candidate.root); }
        catch (cleanupError) { console.warn("derived candidate detach failed", cleanupError); }
        try { removeDerivedBodies(candidateBodies); }
        catch (cleanupError) { console.warn("derived candidate body cleanup failed", cleanupError); }
        try { disposeDerivedCandidate(candidate, "derived candidate cleanup failed"); }
        catch (cleanupError) { console.warn("derived candidate cleanup could not be retained", cleanupError); }
        if (!commitDispatched && stagedRequestId !== undefined && !simCommitted && !stopped) {
          try { await requestDerivedWorker("discardDerivedRevision", identity.manifestHash, { stagedRequestId }); }
          catch (discardError) { console.warn("derived simulation discard failed", discardError); }
        }
        throw error;
      } finally {
        if (stagingDerivedCandidate === candidate) stagingDerivedCandidate = null;
        if (!failClosed && releaseActivationPause !== undefined) {
          try { await releaseActivationPause(); }
          catch (error) {
            failLive(`sim worker resume after derived activation failed: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
          }
        }
        derivedActivationInProgress = false;
      }
    };
    return serializeRuntimeMutation(work);
  };

  const runningLive: RunningLive = {
    worker,
    loop,
    scene,
    camera,
    renderer,
    entities,
    pickEntityId,
    cameraControls,
    editorNavigation,
    /** Set the orbit camera's azimuth (radians) directly. Lets a shot harness place yaw
     *  frames at EXACT angles (i/N x 2pi) instead of timing screenshots against the
     *  frame-rate-dependent autoSpin — wall-clock spacing under-rotates on heavy scenes
     *  (a 12-shot "revolution" stopped at ~270 deg). Render-side camera state only. */
    setOrbitAzimuth: (a: number): void => { angle = a; },
    authoringFailures: authoringFailures.length > 0 ? authoringFailures : undefined,
    applyAuthorCommands: (cmds: AuthorCommand[]): Promise<{ applied: number; needsReboot: boolean; structural: number }> => serializeRuntimeMutation(async () => {
      if (stopped) throw new Error("live runtime is stopped");
      authoringBinding.ensure(cmds);
      const unsupportedStructuralTools: string[] = [];
      let structuralAdds = 0;
      for (const cmd of cmds) {
        if (cmd.kind === "physics") {
          unsupportedStructuralTools.push(`physics.${String(cmd.op)}`);
          continue;
        }
        if (LIVE_IN_PLACE_SKILLS.has(cmd.tool)) continue;
        if (LIVE_RENDER_ONLY_SKILLS.has(cmd.tool)) continue; // render-thread scene mutation (lights), no reboot
        if (LIVE_REMOVE_SKILLS.has(cmd.tool)) continue; // hot removal, no reboot
        if (LIVE_STRUCTURAL_ADD_SKILLS.has(cmd.tool)) {
          // In-place GLB mount is safe ONLY when the asset's parse cache was PRE-WARMED at load (runLive
          // warms the load-time command set before renderer.init, so parseGltfScene returns a sync clone).
          // An asset first appearing MID-SESSION — an approved/authored GLB placed after boot — has NO
          // cached clone, so mounting it in place would parse on the render thread (macrotask → WebGL2
          // corruption / invisible mesh) or fall back to the blocking sync-XHR read (garbled placeholder —
          // the "spiral tower" bug). Force a REBOOT: runLive re-pre-warms EVERY asset (incl. this one)
          // before renderer.init, then it mounts from a synchronous clone. Already-warmed assets (the
          // load-time set, tree palette) keep the fast in-place path.
          const unwarmed = gltfAssetIdsForCommand(cmd, vegPack).filter((id) => {
            try {
              const bytes = liveAssets.resolve(id).bytes;
              return !renderHost.gltfCache.has(id, bytes);
            } catch {
              return true;
            }
          });
          if (unwarmed.length > 0) { unsupportedStructuralTools.push(`${cmd.tool} (unwarmed asset: ${unwarmed.join(", ")})`); continue; }
          structuralAdds++;
        } else unsupportedStructuralTools.push(cmd.tool);
      }
      if (unsupportedStructuralTools.length > 0) {
        console.warn(
          "limina live authoring: structural command requires viewport reboot:",
          [...new Set(unsupportedStructuralTools)].join(", "),
        );
        return { applied: 0, needsReboot: true, structural: structuralAdds + unsupportedStructuralTools.length };
      }

      const workerCmds: AuthorCommand[] = [];
      const addedEids: number[] = [];
      const removedEids: number[] = [];
      let applied = 0;
      for (const cmd of cmds) {
        // catalog.publish / asset.request are DATA-ONLY (catalog entry / build request) — they touch
        // no scene/ecs/physics state, and the live viewport's registry doesn't carry the
        // asset-catalog skills (they live server-side; the catalog is not render/sim state). Apply
        // as a true no-op: mark applied without invoking the registry or the sim worker.
        if (isViewportDataOnlyCommand(cmd)) { applied++; continue; }
        // O(1) creation marker: everything the command creates is `ent_<beforeSeq>` onward
        // (idsCreatedSince), so no before-set of the whole table is snapshotted per command.
        const beforeSeq = cmd.kind === "skill" && LIVE_STRUCTURAL_ADD_SKILLS.has(cmd.tool)
          ? entities.nextSeq
          : undefined;
        // A functional removal can free a complete root-owned subtree (door/collider or
        // furniture compound-collider entities), not only the command's named root. Capture
        // exact ids/eids before applying so the interpolation ring cannot retain stale slots.
        const pendingRemoval = new Map<string, number>();
        if (cmd.kind === "skill" && LIVE_REMOVE_SKILLS.has(cmd.tool)) {
          const input = cmd.input as { entity?: unknown; root?: unknown };
          const rootId = String((cmd.tool === "scene.destroyEntity" ? input.entity : input.root) ?? "");
          const stack = rootId ? [rootId] : [];
          while (stack.length > 0) {
            const id = stack.pop()!;
            if (pendingRemoval.has(id)) continue;
            const entry = entities.resolve(id);
            if (entry === undefined) continue;
            pendingRemoval.set(id, entry.eid);
            stack.push(...entities.childrenOf(id));
          }
          // Task #78: untrack every to-be-destroyed entity BEFORE the skill runs.
          // unregister re-materializes a dormant mesh first, so teardown's scene.remove
          // path is byte-identical to the never-streamed world.
          if (entityStream !== undefined) for (const id of pendingRemoval.keys()) {
            entityStream.unregister(id);
            entityStreamProtected.delete(id);
          }
        }
        const res = await applyOne(cmd);
        if (!res.success) {
          throw new Error(authoringFailureMessage(cmd, res.error?.message ?? "unknown"));
        }
        syncAuthoredScaleMutation(cmd);
        // A live world.streamFollow just changed which tiles the RECORDED world owns — hand any
        // now-region-owned tiles back (and re-queue any released ones) so the camera window and
        // the authoritative window never double-mount the same ground.
        if (cmd.kind === "skill" && cmd.tool === "world.streamFollow") terrainStream?.reconcileExternal();
        for (const [id, eid] of pendingRemoval) if (entities.resolve(id) === undefined && !removedEids.includes(eid)) removedEids.push(eid);
        if (beforeSeq !== undefined) {
          const newEids = captureNewEids(beforeSeq, res.result);
          if (newEids.length === 0) {
            throw new Error(authoringFailureMessage(cmd, "structural add produced no resolvable entity eid"));
          }
          for (const eid of newEids) {
            syncAuthoredScaleForEid(eid);
            seedJoinedTransformForEid(eid);
            if (!addedEids.includes(eid)) addedEids.push(eid);
          }
          // Task #78: a live structural add tracks its new streamable (bodiless placed) entities
          // so a big live-built world stays bounded too. They start materialized (just mounted).
          if (entityStream !== undefined) {
            for (const id of entities.idsCreatedSince(beforeSeq)) {
              if (entityWiring.eligible(id)) entityStream.register(id);
            }
          }
        }
        if (cmd.kind === "skill" && (LIVE_IN_PLACE_SKILLS.has(cmd.tool) || LIVE_STRUCTURAL_ADD_SKILLS.has(cmd.tool) || LIVE_REMOVE_SKILLS.has(cmd.tool))) {
          workerCmds.push(cmd);
        }
        applied++;
      }
      if (addedEids.length > 0) {
        ring.addEids(addedEids);
      }
      if (removedEids.length > 0) {
        // Stop mirroring + suppressing the destroyed eids (the worker frees the body next).
        ring.removeEids(removedEids);
        for (const eid of removedEids) suppressedEids.delete(eid);
      }
      if (workerCmds.length > 0) {
        // Every forwarded command already SUCCEEDED on the render thread, so any worker-side
        // shortfall (a failed command, a short/missing ack) means the two realms' entity/body/eid
        // allocation has diverged — wrong SAB lanes, wrong physics, permanently. That is never
        // warn-and-continue material: report `needsReboot` so the caller's reboot machinery
        // re-authors BOTH realms from the log (the same recovery the editor already runs for
        // structural commands).
        let ack: { applied: number; failed: number };
        try {
          ack = await forwardCommandsToWorker(workerCmds);
        } catch (error) {
          if (stopped) throw error instanceof Error ? error : new Error(String(error));
          console.warn("limina live authoring: sim worker did not acknowledge the forwarded command batch:", error);
          return { applied, needsReboot: true, structural: structuralAdds };
        }
        if (ack.failed > 0 || ack.applied !== workerCmds.length) {
          console.warn(
            `limina live authoring: sim worker applied ${ack.applied}/${workerCmds.length} forwarded command(s)` +
            ` (${ack.failed} failed) — realms diverged, requesting viewport reboot`,
          );
          return { applied, needsReboot: true, structural: structuralAdds };
        }
      }
      if (activeDerivedRevision !== null) suppressAuthoredTerrainPresentation();
      return { applied, needsReboot: false, structural: structuralAdds };
    }),
    terrainStream: ((stream) => stream === undefined ? undefined : {
      mounted: (): string[] => [...stream.mountedKeys()],
      pending: (): number => stream.pendingCount(),
    })(terrainStream),
    grassStream: ((g) => g === undefined ? undefined : {
      tiles: (): number => g.grassKeys().size,
      blades: (): number => g.bladeCount(),
    })(grassStream),
    entityStream: ((s) => s === undefined ? undefined : {
      resident: (): number => s.residentCount(),
      dormant: (): number => s.dormantCount(),
      isDormant: (id: string): boolean => s.isDormant(id),
      setProtected: (id: string, on: boolean): void => {
        if (on) {
          entityStreamProtected.add(id);
          // Selection must take effect NOW: the editor gizmo attaches (and its selection guard
          // scene-graph check runs) this same frame, before the next budgeted update().
          s.forceMaterialize(id);
        } else {
          entityStreamProtected.delete(id);
        }
      },
    })(entityStream),
    setCameraControlsEnabled: (on: boolean): void => {
      if (editorNavigation !== undefined) editorNavigation.setEnabled(on);
      else if (cameraControls !== undefined) cameraControls.enabled = on;
    },
    setSyncSuppressed: (eid: number, on: boolean): void => {
      if (on) suppressedEids.add(eid);
      else suppressedEids.delete(eid);
    },
    pause: (): Promise<void> => setPaused(true),
    resume: (): Promise<void> => setPaused(false),
    isPaused: (): boolean => paused,
    setViewSuspended: (on: boolean): void => { viewSuspended = on; },
    resize: (width: number, height: number): void => {
      renderSession.resize(width, height);
      (world.post as PostPipeline | undefined)?.setSize(width, height);
    },
    setRenderQuality: (nextTier): Readonly<import("./render/quality.ts").RenderQualityProfile> => {
      if (renderSession.quality().tier === nextTier) return renderSession.quality();
      const profile = renderSession.setQuality(nextTier);
      core.water.setQuality(profile.water);
      activeDerivedRevision?.candidate.setQuality(nextTier);
      stagingDerivedCandidate?.setQuality(nextTier);
      rebuildPostForQuality(profile);
      return profile;
    },
    renderTelemetry: (): Readonly<RenderTelemetrySnapshot> => renderSession.telemetry(),
    playerWaterState: (): Readonly<SimStatusSnapshot> | null => readSimStatus(statusView),
    activateDerivedRevision,
    derivedRevision: () => activeDerivedRevision?.identity ?? null,
    derivedTerrainResidency: (): Readonly<DerivedTerrainResidency> => derivedTerrainResidencyTracker.current(),
    derivedTerrainHeightAt: (worldX: number, worldZ: number): number | null => {
      if (!Number.isFinite(worldX) || !Number.isFinite(worldZ)) {
        throw new TypeError("derived terrain height coordinates must be finite");
      }
      const terrain = activeDerivedRevision?.candidate.snapshot.terrain;
      if (terrain === undefined) return null;
      const height = terrain.sampleHeight(Object.is(worldX, -0) ? 0 : worldX, Object.is(worldZ, -0) ? 0 : worldZ);
      if (!Number.isFinite(height)) throw new Error("active derived terrain returned a non-finite height");
      return Object.is(height, -0) ? 0 : height;
    },
    derivedWorldBounds: () => activeDerivedRevision?.candidate.overviewBounds ?? null,
    searchDerivedNavigation: (prefix: string, limit = 20) => searchTransferredDerivedNavigation(
      activeDerivedRevision?.candidate.snapshot ?? null,
      prefix,
      limit,
    ),
    setWorldOverviewPresentation: (enabled: boolean): boolean => {
      const fog = scene.fog as unknown as { density?: number } | null;
      if (fog === null || typeof fog.density !== "number" || !Number.isFinite(fog.density) || !(fog.density > 0)) return false;
      if (localFogDensity === undefined) localFogDensity = fog.density;
      if (!enabled) {
        fog.density = localFogDensity;
        return true;
      }
      const bounds = activeDerivedRevision?.candidate.overviewBounds;
      if (bounds === null || bounds === undefined) return false;
      const span = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ);
      fog.density = Math.min(localFogDensity, 1 / Math.max(2_400, span * 3));
      return true;
    },
    subscribeDerivedTerrainResidency: (listener: DerivedTerrainResidencyListener): (() => void) => (
      derivedTerrainResidencyTracker.subscribe(listener)
    ),
    stop: stopLive,
  };
  if (opts.initialDerivedRevision !== undefined) {
    await runningLive.activateDerivedRevision(opts.initialDerivedRevision, {
      ...(opts.initialDerivedContentAccess === undefined ? {} : { contentAccess: opts.initialDerivedContentAccess }),
    });
  }
  return runningLive;
  } catch (error) {
    try { await teardown("live runtime failed during startup"); }
    catch (cleanupError) { console.warn("live runtime cleanup failed while preserving startup error", cleanupError); }
    throw error;
  }
}

// ---- Auto-bootstrap (browser only) -----------------------------------------
// Guarded by `typeof document` so importing this module off a browser (the
// portability bundle eval) executes NOTHING. The page provides `#limina-canvas`,
// a `data-world` attribute for the export URL, and optional `#limina-status`.

interface DocLike {
  getElementById(id: string): (CanvasElLike & StatusElLike) | null;
  body: { clientWidth: number; clientHeight: number };
}
interface CanvasElLike { getAttribute(name: string): string | null; width: number; height: number; }
interface StatusElLike { textContent: string | null; }

async function bootstrap(): Promise<void> {
  const doc = (globalThis as unknown as { document: DocLike }).document;
  const win = globalThis as unknown as { innerWidth: number; innerHeight: number };
  const canvas = doc.getElementById("limina-canvas");
  const statusEl = doc.getElementById("limina-status");
  const setStatus = (phase: string, detail?: string): void => {
    if (statusEl !== null) statusEl.textContent = detail !== undefined ? `${phase}: ${detail}` : phase;
  };
  if (canvas === null) { setStatus("error", "missing #limina-canvas"); return; }

  // Prefer WebGPU; gracefully fall back to the WebGL2 backend so the world still
  // renders where WebGPU is unavailable (Linux Chrome without the flag, Firefox,
  // older devices). If WebGL2 is also missing, run() surfaces the init error below.
  const webgpu = await hasWebGpu();
  if (!webgpu) setStatus("loading", "WebGPU unavailable — falling back to WebGL2");

  const worldUrl = canvas.getAttribute("data-world") ?? "./worlds/demo";
  const width = win.innerWidth || 960;
  const height = win.innerHeight || 640;
  canvas.width = width;
  canvas.height = height;

  // Phase 9 terrain demo: `data-terrain` streams an in-browser PROCEDURAL terrain
  // (deterministic, no model) around the camera — the in-tab terrain render UAT.
  // `data-terrain-seed` picks the world; the mesh sits on the same surface the
  // heightfield collider would (drop-test parity, proven headlessly).
  let terrain: TerrainStreamRendererOptions | undefined;
  if (canvas.getAttribute("data-terrain") !== null) {
    const seedAttr = canvas.getAttribute("data-terrain-seed");
    const seed = seedAttr !== null && seedAttr.length > 0 ? Number(seedAttr) : 1337;
    const source = new ProceduralTerrainSource();
    terrain = {
      tileSize: TILE_SIZE,
      radius: 5,
      shape: "disc",
      getTile: (coord) => source.generateTile({ seed, tx: coord.tx, tz: coord.tz, lod: 0 }) as TerrainTile,
      mesh: { color: 0x5a7d4a },
      // Phase 9.1: scatter trees/rocks/grass on each tile (deterministic from seed+tile).
      seed,
      props: true,
    };
  }

  try {
    await run({
      canvas: canvas as unknown as HTMLCanvasElement,
      worldUrl,
      width,
      height,
      input: globalThis,
      forceWebGL: !webgpu,
      terrain,
      onStatus: (phase, detail) => setStatus(phase, detail),
    });
  } catch (err) {
    setStatus("error", err instanceof Error ? err.message : String(err));
  }
}

if (typeof document !== "undefined") {
  void bootstrap();
}
