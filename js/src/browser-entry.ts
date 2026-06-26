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
import { createEcsWorld, renderSyncSystem } from "./ecs/world.ts";
import { createTransformStorage } from "./ecs/facade.ts";
import { UniformGridSpatialIndex } from "./spatial/index.ts";
import { SkillRegistry, type WorldContext } from "./skills/registry.ts";
import { registerCoreSkills } from "./skills/index.ts";
import { LiminaTracer } from "./observability/event.ts";
import { loadExport, type LoadedExport } from "./export/package.ts";
import { KeyframePhysics, playbackOps } from "./browser/keyframe-physics.ts";
import { ReplayPlayer } from "./browser/player.ts";
import { TerrainStreamRenderer, type TerrainStreamRendererOptions } from "./terrain/render.ts";
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
  const [manifest, log, keyframes, tiles] = await Promise.all([
    get("manifest.json"),
    get("log.jsonl"),
    get("keyframes.jsonl"),
    getOptional("tiles.jsonl"),
  ]);
  return loadExport({ "manifest.json": manifest, "log.jsonl": log, "keyframes.jsonl": keyframes, "tiles.jsonl": tiles });
}

/** Build the real three renderer + scene + camera for browser playback. */
async function buildRenderTarget(canvas: unknown, width: number, height: number, forceWebGL: boolean): Promise<{
  renderer: { render(s: unknown, c: unknown): void; setSize(w: number, h: number, u?: boolean): void };
  scene: SceneLike;
  camera: CameraLike;
}> {
  // THREE's WebGPURenderer targets either a WebGPU or a WebGL2 backend; forceWebGL
  // selects WebGL2 so the world still renders where WebGPU is unavailable.
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL });
  await renderer.init();
  renderer.setSize(width, height, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene: SceneLike = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e14);
  // Cosmetic stage dressing (NOT part of the replay): lights + a ground plane so
  // the keyframed bodies are lit and grounded. The replay adds the real entities.
  scene.add(new THREE.AmbientLight(0x404060, 1.3));
  const key = new THREE.DirectionalLight(0xffffff, 3.2);
  key.position.set(5, 9, 6);
  scene.add(key);
  const ground = new THREE.Mesh(
    new THREE.BoxGeometry(40, 0.2, 40),
    new THREE.MeshStandardNodeMaterial({ color: 0x1b2230, roughness: 0.9 }),
  );
  ground.position.y = -0.1;
  scene.add(ground);

  const camera: CameraLike = new THREE.PerspectiveCamera(60, width / height, 0.1, 200);
  return { renderer, scene, camera };
}

/** Load + play an exported world. Returns the running player (or throws on a
 *  hard failure — caller surfaces it via `onStatus("error")`). */
export async function run(opts: RunOptions): Promise<RunningPlayer> {
  const status = opts.onStatus ?? ((): void => {});

  status("loading", "starting WebGPU");
  const { renderer, scene, camera } = await buildRenderTarget(opts.canvas, opts.width, opts.height, opts.forceWebGL ?? false);

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
    makeRegistry: (tracer) => { const r = new SkillRegistry(tracer); registerCoreSkills(r); return r; },
    tracer: new LiminaTracer("ses_browser_player"),
    opsOverrides: hostOverrides,
  });

  await player.init();
  status("ready", `${loaded.manifest.ticks} ticks, ${loaded.keyframes.length} keyframes`);

  // Phase 9 terrain stream (optional): mount cached tiles as meshes around the camera.
  // The set math (StreamFollower) and geometry (terrainTileGeometry) are headless-proven;
  // the actual WebGPU draw of these meshes is UAT.
  const terrain = opts.terrain !== undefined ? new TerrainStreamRenderer(scene, opts.terrain) : undefined;

  // Camera orbit state (WASD/QE adjust like the native demo).
  let angle = 0;
  let radius = 16;
  let camHeight = 8;
  const axes = new Float32Array(3);
  let announcedDone = false;

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
      renderOps.op_input_axes(axes);
      angle += 0.004 + axes[0] * 0.03;
      radius = Math.min(40, Math.max(5, radius - axes[2] * 0.25));
      camHeight = Math.min(25, Math.max(1.5, camHeight + axes[1] * 0.25));
      camera.position.set(Math.cos(angle) * radius, camHeight, Math.sin(angle) * radius);
      camera.lookAt(0, 1, 0);
      // Stream terrain tiles in/out around the camera's ground position.
      if (terrain !== undefined) terrain.update(Math.cos(angle) * radius, Math.sin(angle) * radius);
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
      if (opts.input !== undefined) input.detach(opts.input as Parameters<BrowserInput["detach"]>[0]);
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
  try {
    await run({
      canvas,
      worldUrl,
      width,
      height,
      input: globalThis,
      forceWebGL: !webgpu,
      onStatus: (phase, detail) => setStatus(phase, detail),
    });
  } catch (err) {
    setStatus("error", err instanceof Error ? err.message : String(err));
  }
}

if (typeof document !== "undefined") {
  void bootstrap();
}
