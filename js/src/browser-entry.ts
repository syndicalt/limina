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
import { EntityTable, installOps, type CameraLike, type EngineOps, type SceneLike } from "./engine.ts";
import { createEcsWorld, Position, renderableOwnerEid, renderSyncSystem, Rotation, Scale } from "./ecs/world.ts";
import { createTransformStorage } from "./ecs/facade.ts";
import { UniformGridSpatialIndex } from "./spatial/index.ts";
import { SkillRegistry, type WorldContext } from "./skills/registry.ts";
import { registerCoreSkills } from "./skills/index.ts";
import { resolveProfile } from "./skills/permissions.ts";
import { applyAuthorCommand } from "./kernel/authoring.ts";
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
  applyAuthorCommands(cmds: AuthorCommand[]): Promise<{ applied: number; needsReboot: boolean; structural: number }>;
  setCameraControlsEnabled(on: boolean): void;
  setSyncSuppressed(eid: number, on: boolean): void;
  stop(): void;
}

const LIVE_IN_PLACE_SKILLS = new Set(["ecs.updateComponent", "three.setMaterial"]);
const LIVE_STRUCTURAL_ADD_SKILLS = new Set(["scene.createEntity", "asset.place", "player.spawn"]);
// Removals that hot-drop a single entity (mesh + body + eid) instead of forcing a full
// viewport reboot. The skill runs on the render-thread world (teardownEntity removes the
// mesh) and is forwarded to the sim worker (which tears down the body + eid); the removed
// eid is dropped from the interpolation ring so its stale transform is never re-applied.
const LIVE_REMOVE_SKILLS = new Set(["scene.destroyEntity"]);

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

  const ready = await new Promise<ReadyMessage | null>((resolve) => {
    worker.onmessage = (ev: { data: unknown }): void => {
      const msg = ev.data as { type?: string };
      if (msg.type === "ready") resolve(ev.data as ReadyMessage);
    };
    worker.onerror = (ev: { message?: string }): void => {
      status("error", "sim worker error: " + (ev.message ?? "unknown"));
      resolve(null);
    };
    worker.postMessage({ type: "init", commands: opts.commands });
  });
  if (ready === null) { worker.terminate(); return null; }
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
    const msg = ev.data as { type?: string; phase?: string; message?: string };
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

  // ── Build the real renderer/scene/camera (reuse Mode-A buildRenderTarget + baseline). ──
  status("loading", "starting WebGPU");
  const { renderer, scene, camera } = await buildRenderTarget(
    opts.canvas, opts.width, opts.height, opts.forceWebGL ?? false, {},
  );

  // ── Re-author the SAME command log on the render-main thread against the REAL
  //    scene so meshes exist and eids match the worker (deterministic authoring).
  //    The render-main physics world is built ONLY to author — it is never stepped
  //    (the worker is authoritative). ──
  status("loading", "authoring scene meshes");
  const rapier = opts.rapier ?? (await import("@dimforge/rapier3d-compat")) as unknown as RapierModule;
  const physics = await WasmRapierPhysics.create(rapier);
  const ops = composeAuthoringOps(physics);
  installOps(ops); // complete global op surface for any engine code reaching module-level `ops`

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
  registerCoreSkills(registry);
  const permissions = resolveProfile(opts.profile ?? "builder.readWrite");
  const applyOne = (cmd: AuthorCommand): Promise<Awaited<ReturnType<typeof applyAuthorCommand>>> => {
    return applyAuthorCommand(registry, world, cmd, {
      sessionId: "ses_browser_live",
      defaultAgentId: "author",
      defaultPerms: permissions,
      tick: 0,
    });
  };
  for (const cmd of opts.commands) {
    const res = await applyOne(cmd);
    if (!res.success) {
      status("error", authoringFailureMessage(cmd, res.error?.message ?? "unknown"));
      worker.terminate();
      return null;
    }
  }

  // The authored entity eids = the render set; capture their (static) authored scale
  // so the interpolator keeps meshes at size (the worker syncs position+rotation only).
  const eids: number[] = [];
  for (const id of entities.ids()) {
    const eid = entities.resolve(id)?.eid;
    if (eid !== undefined) eids.push(eid);
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
      if (cameraControls !== undefined) {
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
    applyAuthorCommands: async (cmds: AuthorCommand[]): Promise<{ applied: number; needsReboot: boolean; structural: number }> => {
      const unsupportedStructuralTools: string[] = [];
      let structuralAdds = 0;
      for (const cmd of cmds) {
        if (cmd.kind === "physics") {
          unsupportedStructuralTools.push(`physics.${String(cmd.op)}`);
          continue;
        }
        if (LIVE_IN_PLACE_SKILLS.has(cmd.tool)) continue;
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
