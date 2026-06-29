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
import { EntityTable, installOps, type CameraLike, type EngineOps, type SceneLike } from "./engine.ts";
import { createEcsWorld, Position, renderSyncSystem, Rotation, Scale } from "./ecs/world.ts";
import { createTransformStorage } from "./ecs/facade.ts";
import { UniformGridSpatialIndex } from "./spatial/index.ts";
import { SkillRegistry, type WorldContext } from "./skills/registry.ts";
import { registerCoreSkills } from "./skills/index.ts";
import { resolveProfile } from "./skills/permissions.ts";
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
    tracer: new LiminaTracer("ses_browser_player"),
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
  const fly = terrain !== undefined ? new FlyCamera({ x: 0, y: 34, z: 70, yaw: 0, pitch: -0.32 }) : undefined;
  if (fly !== undefined) {
    const doc = (globalThis as unknown as { document?: unknown }).document;
    fly.attach(
      opts.input as Parameters<FlyCamera["attach"]>[0],
      opts.canvas as Parameters<FlyCamera["attach"]>[1],
      doc as Parameters<FlyCamera["attach"]>[2],
    );
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
  let angle = 0;
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
}

export interface RunningLive {
  worker: WorkerLike;
  loop: AccumulatorLoopHandle;
  stop(): void;
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
  // Further per-tick acks are ignored — the render thread reads progress from the
  // status SAB via Atomics (cross-thread, allocation-free), not the message channel.
  worker.onmessage = null;

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
  const registry = new SkillRegistry(new LiminaTracer("ses_browser_live"));
  registerCoreSkills(registry);
  const permissions = resolveProfile(opts.profile ?? "builder.readWrite");
  for (const cmd of opts.commands) {
    if (cmd.kind === "physics") {
      const fn = (ops as unknown as Record<string, (...a: unknown[]) => unknown>)[cmd.op];
      fn(...cmd.args);
      continue;
    }
    const res = await registry.invoke(cmd.tool, cmd.input, {
      agentId: cmd.agentId ?? "author",
      sessionId: "ses_browser_live",
      permissions: cmd.perms !== undefined ? new Set(cmd.perms) : permissions,
      tick: 0,
      world,
      causedBy: [],
    });
    if (!res.success) {
      status("error", `authoring '${cmd.tool}' failed: ${res.error?.message ?? "unknown"}`);
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

  // ── M4 interpolation: tween the two latest frozen ticks into the render store
  //    (the world.ts SoA globals renderSyncSystem reads) each frame. ──
  const renderStore: TransformStore = { Position, Rotation, Scale };
  const interp = new FrameInterpolator(renderStore);
  const ring = new SnapshotRing(eids, authoredScale);
  let lastConsumed = -1;

  // ── Input pump + camera framing. ──
  const liveInput = new LivePlayerInput();
  if (opts.input !== undefined) liveInput.attach(opts.input as Parameters<LivePlayerInput["attach"]>[0]);
  const inFrame = { move: [0, 0, 0] as [number, number, number], look: [0, 0] as [number, number], buttons: [0, 0] as [number, number], tick: 0 };

  const orbitCenter = opts.orbit?.center ?? [0, 1, 0];
  const orbitSpin = opts.orbit?.autoSpin ?? 0.004;
  let angle = 0;
  const radius = opts.orbit?.radius ?? 16;
  const camHeight = opts.orbit?.height ?? 8;

  status("ready", `${eids.length} entities authored — live sim running`);

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
      renderSyncSystem(ecs);
      angle += orbitSpin;
      camera.position.set(
        orbitCenter[0] + Math.cos(angle) * radius,
        orbitCenter[1] + camHeight,
        orbitCenter[2] + Math.sin(angle) * radius,
      );
      camera.lookAt(orbitCenter[0], orbitCenter[1], orbitCenter[2]);
      renderer.render(scene, camera);
    },
  });

  return {
    worker,
    loop,
    stop: (): void => {
      loop.stop();
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
