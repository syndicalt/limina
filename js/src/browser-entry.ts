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
import { hasGltfScene, prewarmGltfScene } from "./skills/three.ts";
import { SPECIES_ARCHETYPES, TREE_ARCHETYPE_IDS, pickArchetype } from "./skills/vegetation.ts";
export { buildAssetInstancedMeshes } from "./terrain/asset-scatter-render.ts";
import { EntityTable, installOps, type CameraLike, type EngineOps, type SceneLike } from "./engine.ts";
import { createEcsWorld, Position, renderableOwnerEid, renderSyncSystem, Rotation, Scale } from "./ecs/world.ts";
import { createTransformStorage } from "./ecs/facade.ts";
import { UniformGridSpatialIndex } from "./spatial/index.ts";
import { SkillRegistry, type WorldContext } from "./skills/registry.ts";
import { registerCoreSkills } from "./skills/index.ts";
import { resolveProfile } from "./skills/permissions.ts";
import { applyAuthorCommand } from "./kernel/authoring.ts";
import {
  applyAuthorCommandsIsolated,
  createWorkerHandshake,
  type AuthorCommandFailure,
} from "./kernel/apply-isolated.ts";
// Re-exported so the editor viewport (plain JS importing the bundle) shares the SAME quarantine
// helper the headless gate unit-tests — no forked copy of the skip logic.
export { partitionQuarantined } from "./kernel/apply-isolated.ts";
import { LiminaTracer } from "./observability/event.ts";
// ── Phase 8 Mode-B (M5) live runtime: the verified M1–M4 + M3 worker pieces ──
import { WasmRapierPhysics, type RapierModule } from "./browser/wasm-rapier-physics.ts";
import { SharedTransformStorage } from "./browser/sab-transforms.ts";
import { InputRingBuffer } from "./browser/sab-ringbuffer.ts";
import { FrameInterpolator, type TransformStore } from "./browser/frame-interpolator.ts";
import type { AuthorCommand } from "./browser/sim-worker.ts";
import {
  composeAuthoringOps,
  crossOriginIsolatedAvailable,
  LivePlayerInput,
  SnapshotRing,
} from "./browser/live-runtime.ts";
import { exportAssetBundle, loadExport, type LoadedExport } from "./export/package.ts";
import { AssetRegistry } from "./asset-registry.ts";
import { KeyframePhysics, playbackOps } from "./browser/keyframe-physics.ts";
import { ReplayPlayer } from "./browser/player.ts";
import { TerrainStreamRenderer, type TerrainStreamRendererOptions } from "./terrain/render.ts";
import { ProceduralTerrainSource, TILE_SIZE } from "./terrain/procedural.ts";
import type { TerrainTile } from "./terrain/types.ts";
import { FlyCamera } from "./browser/fly-camera.ts";
import { LAWN_DECO_ASSETS } from "./skills/village.ts";
import { applyRenderBaseline, type RenderBaselineOverride } from "./render-baseline.ts";
import {
  BrowserInput,
  createBrowserRenderOps,
  DurableTraceStore,
  IndexedDbKvStore,
  startAccumulatorLoop,
  type AccumulatorLoopHandle,
} from "./browser/host.ts";

declare const navigator: { gpu?: { requestAdapter(): Promise<unknown> } };
declare const document: unknown;
declare const fetch: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface RunOptions {
  /** A real <canvas> element to render into. */
  canvas: unknown;
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
  // tiles.jsonl is OPTIONAL (only terrain worlds carry it) -> "" when absent.
  const getOptional = async (name: string): Promise<string> => {
    const res = await fetch(base + name);
    return res.ok ? await res.text() : "";
  };
  const [manifest, log, keyframes, tiles, assets] = await Promise.all([
    get("manifest.json"),
    get("log.jsonl"),
    get("keyframes.jsonl"),
    getOptional("tiles.jsonl"),
    getOptional("assets.jsonl"),
  ]);
  return loadExport({ "manifest.json": manifest, "log.jsonl": log, "keyframes.jsonl": keyframes, "tiles.jsonl": tiles, "assets.jsonl": assets });
}

/** Build the real three renderer + scene + camera for browser playback. The
 *  Phase 11 render baseline (lights + procedural-sky IBL + ground + framing) is
 *  the single source of truth for "looks rendered", so this no longer hand-rolls
 *  cosmetic lights/ground — it just applies the baseline. `baseline` lets the
 *  caller tweak it (terrain mode disables the flat ground, for example). */
async function buildRenderTarget(
  canvas: unknown,
  width: number,
  height: number,
  forceWebGL: boolean,
  baseline: RenderBaselineOverride | false,
): Promise<{
  renderer: { render(s: unknown, c: unknown): void; setSize(w: number, h: number, u?: boolean): void };
  scene: SceneLike;
  camera: CameraLike;
}> {
  // THREE's WebGPURenderer targets either a WebGPU or a WebGL2 backend; forceWebGL
  // selects WebGL2 so the world still renders where WebGPU is unavailable.
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL });
  await renderer.init();
  renderer.setSize(width, height, false);

  const scene: SceneLike = new THREE.Scene();
  const camera: CameraLike = new THREE.PerspectiveCamera(60, width / height, 0.1, 200);

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
      registerCoreSkills(r, { assets: AssetRegistry.fromBundle(exportAssetBundle(loaded)) });
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
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
}
declare const Worker: { new (url: unknown, opts?: { type?: "module" }): WorkerLike };
declare const URL: { new (url: string, base?: string): unknown };

export interface RunLiveOptions {
  /** A real <canvas> element to render into. */
  canvas: unknown;
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
  /** Authoring permission profile (default "builder.readWrite" — the broad authoring grant). */
  profile?: string;
  /** Camera orbit framing (the live MVP auto-orbits the world; the follow-cam is future). */
  orbit?: { center?: [number, number, number]; radius?: number; height?: number; autoSpin?: number };
  /** Opt-in browser camera controls for editor-style viewports. Falsy preserves the legacy auto-spin. */
  orbitControls?: boolean;
  /** Scene-level render-baseline override (lights/tonemapping/atmosphere/ground/camera). A world can
   *  carry its own look (e.g. golden-hour sun + fog) without touching DEFAULT_RENDER_BASELINE. Merged
   *  over the default by applyRenderBaseline; omit for the default look. */
  renderBaseline?: RenderBaselineOverride;
}

export interface RunningLive {
  worker: WorkerLike;
  loop: AccumulatorLoopHandle;
  scene: SceneLike;
  camera: CameraLike;
  renderer: { render(s: unknown, c: unknown): void; setSize(w: number, h: number, u?: boolean): void; domElement?: unknown };
  entities: EntityTable;
  pickEntityId(object: { parent?: unknown }): string | undefined;
  cameraControls?: unknown;
  /** Per-command authoring failures encountered while bringing the viewport up (Layer-2 isolation):
   *  the viewport still came up with every command that DID apply — a bad/out-of-band command no
   *  longer wedges it. Absent/empty when the whole command log authored cleanly. The editor uses
   *  these to QUARANTINE the offending commands so a later reboot does not replay them. Distinct from
   *  a `null` return, which means the environment could not host the viewport at all. */
  authoringFailures?: AuthorCommandFailure[];
  applyAuthorCommands(cmds: AuthorCommand[]): Promise<{ applied: number; needsReboot: boolean; structural: number }>;
  setCameraControlsEnabled(on: boolean): void;
  setSyncSuppressed(eid: number, on: boolean): void;
  stop(): void;
}

const LIVE_IN_PLACE_SKILLS = new Set(["ecs.updateComponent", "scene.moveEntity", "three.setMaterial", "terrain.deform"]);
// Structural adds applied INCREMENTALLY on the live scene (no reboot) — including the GLB-mounting
// skills. Their mid-session mount is safe because runLive PRE-WARMS the glTF parse cache (the tree
// palette + the scene's assets) BEFORE renderer.init(), so parseGltfScene returns a synchronous clone
// — no GLTFLoader.parse / createImageBitmap macrotask around a render, which would corrupt the WebGL2
// backend (invisible mesh). A handler must NOT do its own async fetch: handlers ALSO run in the sim
// worker, where a hanging fetch blocks the "ready" handshake and freezes the viewport (learned the
// hard way — that is why prewarmAssets was removed).
const LIVE_STRUCTURAL_ADD_SKILLS = new Set(["scene.createEntity", "asset.place", "player.spawn", "terrain.create", "vegetation.scatter", "vegetation.plant"]);

/** The GLB asset ids a command will MOUNT — used to pre-warm the parse cache before renderer.init(). */
function gltfAssetIdsForCommand(cmd: AuthorCommand): string[] {
  if (cmd.kind !== "skill") return [];
  const input = (cmd.input ?? {}) as Record<string, unknown>;
  if (cmd.tool === "asset.place" || cmd.tool === "three.loadGLTF") {
    return typeof input.assetId === "string" ? [input.assetId] : [];
  }
  // village.build mounts a GLB per building (via nested asset.place); its ids live in
  // steering.buildings[].assetId, so pre-warm each one's parse cache before init().
  if (cmd.tool === "village.build") {
    const steering = (input.steering ?? {}) as { buildings?: Array<{ assetId?: unknown }>; siting?: { yard?: unknown } };
    const bs = Array.isArray(steering.buildings) ? steering.buildings : [];
    const buildingIds = bs.map((b) => (typeof b.assetId === "string" ? b.assetId : "")).filter((s) => s.length > 0);
    // A "lawn" yard (the default) scatters wildflower/tuft GLBs on the yard — pre-warm those too, else the
    // render-thread scatter can't resolve them and the lawn stays bare.
    const yard = steering.siting?.yard;
    const wantLawn = yard === undefined || yard === "lawn";
    return wantLawn ? [...buildingIds, ...LAWN_DECO_ASSETS.map((a) => a.id)] : buildingIds;
  }
  if (cmd.tool === "vegetation.plant") {
    const species = typeof input.species === "string" ? input.species : "spruce";
    const seed = typeof input.seed === "number" ? input.seed : 1;
    try { return [pickArchetype(species, seed)]; } catch { return []; }
  }
  if (cmd.tool === "vegetation.scatter") {
    const species = Array.isArray(input.species) ? (input.species as string[]) : ["spruce", "pine", "birch"];
    return [...new Set(species.flatMap((s) => SPECIES_ARCHETYPES[s] ?? []))];
  }
  return [];
}
// Removals that hot-drop a single entity (mesh + body + eid) instead of forcing a full
// viewport reboot. The skill runs on the render-thread world (teardownEntity removes the
// mesh) and is forwarded to the sim worker (which tears down the body + eid); the removed
// eid is dropped from the interpolation ring so its stale transform is never re-applied.
const LIVE_REMOVE_SKILLS = new Set(["scene.destroyEntity"]);
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

  // The handshake ALWAYS settles: it resolves on `ready` OR on `{type:"error"}` OR on a hard
  // worker.onerror — so `await` can never hang (the old listener resolved only on `ready`, and a
  // worker `{type:"error"}` left the promise pending forever, freezing the viewport).
  const handshake = createWorkerHandshake<ReadyMessage>();
  worker.onmessage = (ev: { data: unknown }): void => { handshake.offer(ev.data); };
  worker.onerror = (ev: { message?: string }): void => handshake.fail("sim worker error: " + (ev.message ?? "unknown"));
  worker.postMessage({ type: "init", commands: opts.commands });
  const handshakeResult = await handshake.promise;
  if (!handshakeResult.ok) {
    // A hard startup failure (no worker, rapier import/create failed) — the environment cannot host
    // the viewport. Report the SPECIFIC reason and return null (the "unsupported / cannot host"
    // signal, distinct from a per-command authoring failure, which keeps the viewport up below).
    status("error", handshakeResult.error);
    worker.terminate();
    return null;
  }
  const ready = handshakeResult.ready;
  // The loop is created far below; the error handler installed here (which can fire
  // any time after `ready`) tears it down via this forward reference.
  let liveLoop: AccumulatorLoopHandle | null = null;
  // A worker throw can arrive DURING startup (the worker self-drives at 60Hz the moment
  // it posts `ready`, while this thread is still building WebGPU/scene). `aborted` records
  // that so the startup path below bails instead of overwriting status back to
  // ready/playing over a dead worker — otherwise an early solver throw looks like a
  // frozen sim reporting "playing".
  let aborted = false;
  const failLive = (message: string): void => {
    aborted = true;
    status("error", message);
    liveLoop?.stop();
    worker.terminate();
  };
  // Per-tick acks are ignored — the render thread reads progress from the status SAB
  // via Atomics (cross-thread, allocation-free), not the message channel. But a
  // solver throw inside the worker's step arrives as {type:"error"} on THIS channel;
  // keep handling messages after `ready` (instead of nulling onmessage) so that throw
  // is surfaced and the now-broken sim is torn down rather than dying silently.
  worker.onmessage = (ev: { data: unknown }): void => {
    const msg = ev.data as { type?: string; phase?: string; message?: string; failures?: AuthorCommandFailure[] };
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
  const statusView = new Int32Array(ready.status, 0, 1);
  const readWorkerTick = (): number => (statusShared ? Atomics.load(statusView, 0) : statusView[0]);

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
  const ops = composeAuthoringOps(physics);
  installOps(ops); // complete global op surface for any engine code reaching module-level `ops`

  const liveAssets = new AssetRegistry(ops);
  if (typeof fetch === "function") {
    // Warm the tree palette (so a LATER incremental plant/scatter mounts from a clone) + this scene's
    // own GLB assets. Skip anything already cached — the module cache persists across reboots, so only
    // the first connect pays the fetch. All of this runs BEFORE renderer.init(), the only safe window.
    const gltfIds = new Set<string>(TREE_ARCHETYPE_IDS);
    for (const cmd of opts.commands) for (const id of gltfAssetIdsForCommand(cmd)) gltfIds.add(id);
    const cold = [...gltfIds].filter((id) => !hasGltfScene(id));
    if (cold.length > 0) {
      status("loading", `loading ${cold.length} asset${cold.length === 1 ? "" : "s"}`);
      await Promise.all(cold.map(async (id) => {
        try {
          const res = await fetch("/assets/" + id);
          if (!res.ok) return;
          const bytes = new Uint8Array(await res.arrayBuffer());
          liveAssets.seed(id, bytes);        // sync resolve() during apply (no host XHR)
          await prewarmGltfScene(id, bytes); // parse into the clone cache (no macrotask at mount)
        } catch { /* a missing/failed asset surfaces when the mount runs */ }
      }));
    }
  }

  // ── Build the real renderer/scene/camera (reuse Mode-A buildRenderTarget + baseline). ──
  status("loading", "starting WebGPU");
  const { renderer, scene, camera } = await buildRenderTarget(
    opts.canvas, opts.width, opts.height, opts.forceWebGL ?? false, opts.renderBaseline ?? {},
  );

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
    scene,
    camera,
    ops,
    renderer,
    width: opts.width,
    height: opts.height,
    mode: "windowed",
  };
  const registry = new SkillRegistry(LiminaTracer.ephemeral("ses_browser_live"));
  const core = registerCoreSkills(registry, { assets: liveAssets });
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
  const authoringOutcome = await applyAuthorCommandsIsolated(registry, world, opts.commands, {
    sessionId: "ses_browser_live",
    defaultAgentId: "author",
    defaultPerms: permissions,
    tick: 0,
  });
  const authoringFailures = authoringOutcome.failures;
  if (authoringFailures.length > 0) {
    // The viewport still comes up; surface the offenders for observability. The caller (editor) reads
    // `running.authoringFailures` off the returned handle to quarantine + report which/why.
    console.warn(
      `limina live authoring isolated ${authoringFailures.length} failure(s):`,
      authoringFailures.map((f) => `#${f.index} ${authoringFailureMessage(opts.commands[f.index], f.message)}`).join("; "),
    );
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
  const captureNewEids = (before: ReadonlySet<string>, result: unknown): number[] => {
    const out: number[] = [];
    const entity = resultEntityId(result);
    if (entity !== undefined) {
      const eid = entities.resolve(entity)?.eid;
      if (eid !== undefined) out.push(eid);
    }
    for (const id of entities.ids()) {
      if (before.has(id)) continue;
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
  if (opts.input !== undefined) liveInput.attach(opts.input as Parameters<LivePlayerInput["attach"]>[0]);
  const inFrame = { move: [0, 0, 0] as [number, number, number], look: [0, 0] as [number, number], buttons: [0, 0] as [number, number], tick: 0 };

  const orbitCenter = opts.orbit?.center ?? [0, 1, 0];
  const orbitSpin = opts.orbit?.autoSpin ?? 0.004;
  let angle = 0;
  const radius = opts.orbit?.radius ?? 16;
  const camHeight = opts.orbit?.height ?? 8;
  let cameraControls: InstanceType<typeof THREE.OrbitControls> | undefined;
  if (opts.orbitControls === true) {
    camera.position.set(
      orbitCenter[0] + Math.cos(angle) * radius,
      orbitCenter[1] + camHeight,
      orbitCenter[2] + Math.sin(angle) * radius,
    );
    camera.lookAt(orbitCenter[0], orbitCenter[1], orbitCenter[2]);
    cameraControls = new THREE.OrbitControls(camera, renderer.domElement);
    cameraControls.target.set(orbitCenter[0], orbitCenter[1], orbitCenter[2]);
    cameraControls.enableRotate = true;
    cameraControls.enableZoom = true;
    cameraControls.enablePan = true;
    cameraControls.enableDamping = true;
    cameraControls.update();
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
      if (playerEid !== undefined) {
        // Mouse-look ONLY on a walkable (player) scene: click the canvas to capture the pointer, then
        // mouse X yaws the view + mouse Y pitches it. Gated on a player so it never hijacks the
        // editor's click-to-select on a non-player scene.
        liveInput.attachPointer(renderer.domElement as Parameters<LivePlayerInput["attachPointer"]>[0]);
      }
    }
  }
  // Eye height above the capsule CENTER (center rests at ~0.9 m for the 1.8 m capsule → eye ~1.6 m).
  const EYE_OFFSET = 0.7;

  // If the worker already threw during the WebGPU/scene build above, bail now instead
  // of announcing "ready"/"playing" over a terminated worker (failLive set the status).
  if (aborted) { worker.terminate(); return null; }

  status("ready", `${eids.length} entities authored — live sim running`);

  const entityIdForEid = (eid: number): string | undefined => {
    for (const id of entities.ids()) {
      if (entities.resolve(id)?.eid === eid) return id;
    }
    return undefined;
  };
  const pickEntityId = (object: { parent?: unknown }): string | undefined => {
    let current: unknown = object;
    while (current !== undefined && current !== null) {
      const eid = renderableOwnerEid(current);
      if (eid !== undefined) {
        const id = entityIdForEid(eid);
        if (id !== undefined) return id;
      }
      current = typeof current === "object" ? (current as { parent?: unknown }).parent : undefined;
    }
    return undefined;
  };

  // ── The accumulator rAF loop (host.ts). `step` consumes the worker's latest tick
  //    (freezing it for interpolation) at the fixed cadence; `frame(alpha)` pumps
  //    input, interpolates by alpha, syncs the scene, and renders. ──
  const loop = startAccumulatorLoop({
    step: (): void => {
      const t = readWorkerTick();
      if (t > lastConsumed) {
        interp.push(ring.freeze(joined));
        lastConsumed = t;
        status("playing", `tick ${t}`);
      }
    },
    frame: (alpha: number): void => {
      // Publish this frame's input into the M3 ring (consumed by the worker next tick).
      inputRing.writeInput(liveInput.frame(lastConsumed < 0 ? 0 : lastConsumed, inFrame));
      // Tween prev→curr by alpha into the render store, then drive the scene + render.
      interp.interpolate(alpha, ring.presentSet);
      renderSyncSystem(ecs, suppressedEids);
      if (playerEid !== undefined) {
        // FIRST-PERSON: sit at the player capsule's eye (interpolated Position + EYE_OFFSET) and look
        // along the mouse heading (yaw) + pitch. yaw=0 → forward is -Z, matching the controller's move
        // basis (character.ts), so W walks where you look.
        const yaw = inFrame.look[0];
        const pitch = inFrame.look[1];
        const cp = Math.cos(pitch);
        const ex = Position.x[playerEid];
        const ey = Position.y[playerEid] + EYE_OFFSET;
        const ez = Position.z[playerEid];
        camera.position.set(ex, ey, ez);
        camera.lookAt(ex + Math.sin(yaw) * cp, ey + Math.sin(pitch), ez - Math.cos(yaw) * cp);
      } else if (cameraControls !== undefined) {
        cameraControls.update();
      } else {
        angle += orbitSpin;
        camera.position.set(
          orbitCenter[0] + Math.cos(angle) * radius,
          orbitCenter[1] + camHeight,
          orbitCenter[2] + Math.sin(angle) * radius,
        );
        camera.lookAt(orbitCenter[0], orbitCenter[1], orbitCenter[2]);
      }
      renderer.render(scene, camera);
    },
  });
  liveLoop = loop; // let the error handler above stop the loop on a worker throw

  return {
    worker,
    loop,
    scene,
    camera,
    renderer,
    entities,
    pickEntityId,
    cameraControls,
    authoringFailures: authoringFailures.length > 0 ? authoringFailures : undefined,
    applyAuthorCommands: async (cmds: AuthorCommand[]): Promise<{ applied: number; needsReboot: boolean; structural: number }> => {
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
        if (LIVE_STRUCTURAL_ADD_SKILLS.has(cmd.tool)) structuralAdds++;
        else unsupportedStructuralTools.push(cmd.tool);
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
        const beforeIds = cmd.kind === "skill" && LIVE_STRUCTURAL_ADD_SKILLS.has(cmd.tool)
          ? new Set(entities.ids())
          : undefined;
        // A removal frees its entity from the render-thread table, so resolve the eid
        // BEFORE applying so the interpolation ring + suppressed set can be cleaned after.
        const removedEid = cmd.kind === "skill" && LIVE_REMOVE_SKILLS.has(cmd.tool)
          ? entities.resolve(String((cmd.input as { entity?: unknown })?.entity ?? ""))?.eid
          : undefined;
        const res = await applyOne(cmd);
        if (!res.success) {
          throw new Error(authoringFailureMessage(cmd, res.error?.message ?? "unknown"));
        }
        syncAuthoredScaleMutation(cmd);
        if (removedEid !== undefined) removedEids.push(removedEid);
        if (beforeIds !== undefined) {
          const newEids = captureNewEids(beforeIds, res.result);
          if (newEids.length === 0) {
            throw new Error(authoringFailureMessage(cmd, "structural add produced no resolvable entity eid"));
          }
          for (const eid of newEids) {
            syncAuthoredScaleForEid(eid);
            seedJoinedTransformForEid(eid);
            if (!addedEids.includes(eid)) addedEids.push(eid);
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
        worker.postMessage({ type: "applyCommands", commands: workerCmds });
      }
      return { applied, needsReboot: false, structural: structuralAdds };
    },
    setCameraControlsEnabled: (on: boolean): void => {
      if (cameraControls !== undefined) cameraControls.enabled = on;
    },
    setSyncSuppressed: (eid: number, on: boolean): void => {
      if (on) suppressedEids.add(eid);
      else suppressedEids.delete(eid);
    },
    stop: (): void => {
      loop.stop();
      cameraControls?.dispose();
      try { worker.postMessage({ type: "stop" }); } catch { /* worker may be gone */ }
      worker.terminate();
      if (opts.input !== undefined) liveInput.detach(opts.input as Parameters<LivePlayerInput["detach"]>[0]);
      liveInput.detachPointer();
    },
  };
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
      canvas,
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
