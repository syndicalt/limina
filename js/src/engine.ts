// limina engine module — owns the device/renderer/scene/camera/world that were
// formerly locals in demo.ts, plus a typed op facade and the entity table.
// The Phase 1 skill registry builds its WorldContext from an Engine.

import * as THREE from "../build/three.bundle.mjs";
import { createTransformStorage, type TransformStorage } from "./ecs/facade.ts";
import { createEcsWorld, type Transformable } from "./ecs/world.ts";
import { UniformGridSpatialIndex } from "./spatial/index.ts";
import { applyRenderBaseline, type RenderBaselineOverride } from "./render-baseline.ts";

// ---- Typed op surface (provider-agnostic; no `any`) ----------------------

/** A drained native collision event. `kind` is 1 for a contact start, 0 for a
 *  contact stop. `point`/`normal` are the world-space contact geometry from the
 *  Rapier manifold on a start (null on a stop or when the contact already
 *  separated before draining). `a`/`b` are body ids ordered `a <= b`; `normal`
 *  points from body `a` toward body `b`. */
export interface CollisionEventRecord {
  kind: number;
  a: number;
  b: number;
  point: [number, number, number] | null;
  normal: [number, number, number] | null;
}

export interface EngineOps {
  // surface / loop
  op_create_window_context(): unknown;
  op_surface_present(context: unknown): void;
  op_surface_resize(w: number, h: number): void;
  op_set_frame_callback(cb: (alpha: number) => void): void;
  op_set_fixed_step_callback(cb: (dt: number) => void): void;
  op_set_resize_callback(cb: (w: number, h: number) => void): void;
  op_input_axes(out: Float32Array): void;
  op_input_look(out: Float32Array): void;
  /** Write discrete action-button states into out[0..2] as 0/1 floats
   *  (out[0]=jump/Space, out[1]=run/Shift). */
  op_input_buttons(out: Float32Array): void;
  // physics
  op_physics_create_world(gravityY: number): void;
  op_physics_add_ground(y: number): void;
  op_physics_add_box(x: number, y: number, z: number, half: number): number;
  op_physics_add_box_material(x: number, y: number, z: number, half: number, friction: number, restitution: number): number;
  op_physics_add_sphere(x: number, y: number, z: number, radius: number, friction: number, restitution: number): number;
  op_physics_add_capsule(x: number, y: number, z: number, halfHeight: number, radius: number, friction: number, restitution: number): number;
  op_physics_add_static_box(x: number, y: number, z: number, hx: number, hy: number, hz: number, friction: number, restitution: number): number;
  op_physics_add_static_sphere(x: number, y: number, z: number, radius: number, friction: number, restitution: number): number;
  op_physics_add_static_capsule(x: number, y: number, z: number, halfHeight: number, radius: number, friction: number, restitution: number): number;
  /** Add a fixed heightfield collider (Phase 9 terrain). `heights` is an
   *  nrows×ncols grid in row-major order (index = row*ncols + col), spanning
   *  scaleX×scaleZ world units centered at (x,y,z), heights scaled by scaleY.
   *  Returns its stable body id. */
  op_physics_add_heightfield(x: number, y: number, z: number, nrows: number, ncols: number, scaleX: number, scaleY: number, scaleZ: number, heights: Float32Array): number;
  /** Add a KINEMATIC position-based capsule for use as a character-controller
   *  body (Phase 12). `halfHeight` is the cylindrical half-height (excludes the
   *  radius caps). Driven only by op_physics_move_character (unaffected by
   *  gravity/forces). Returns its stable body id. */
  op_physics_add_character(x: number, y: number, z: number, halfHeight: number, radius: number): number;
  /** Move a character body by a desired translation, resolved via Rapier's
   *  KinematicCharacterController (slide, slope limit, autostep, snap-to-ground).
   *  Queues the corrected position as the body's next kinematic translation
   *  (applied on the next op_physics_step). Writes
   *  out = [newX, newY, newZ, grounded(1/0)] (out length >= 4). */
  op_physics_move_character(id: number, dx: number, dy: number, dz: number, out: Float32Array): void;
  op_physics_remove_body(id: number): void;
  op_physics_apply_impulse(id: number, ix: number, iy: number, iz: number): void;
  op_physics_step(): void;
  /** Serialize the full native physics world (bodies+velocities, colliders,
   *  joints, contact graph, broad/narrow phase, islands, id->handle slotmap) to
   *  a bincode blob as a Uint8Array. The M2 snapshot path persists this. */
  op_physics_snapshot(): Uint8Array;
  /** Replace the live native physics world with one deserialized from an
   *  op_physics_snapshot blob -- body ids resolve exactly as before. */
  op_physics_restore(bytes: Uint8Array): void;
  op_physics_body_pos(id: number, out: Float32Array): void;
  op_physics_body_transform(id: number, out: Float32Array): void;
  op_physics_drain_collisions(): CollisionEventRecord[];
  op_physics_raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxToi: number, out: Float32Array,
  ): void;
  // host services
  op_log(msg: string): void;
  op_http_post(url: string, body: string): Promise<string>;
  op_sleep_ms(ms: number): Promise<void>;
  op_read_asset(relativeId: string): Uint8Array;
  op_sha256(input: string): string;
  op_write_trace(name: string, content: string): void;
  op_append_trace(name: string, content: string): void;
  op_read_trace(name: string): string;
  // untrusted-code isolation (limina-sandbox QuickJS host)
  op_sandbox_create(memLimitBytes: number, maxStackBytes: number, readCapsJson: string): number;
  op_sandbox_eval(handle: number, code: string, perceptionJson: string, deadlineMs: number): string;
  op_sandbox_destroy(handle: number): boolean;
  op_sandbox_count(): number;
  // native parallel ECS hot paths (limina-ecs)
  op_ecs_spatial_query_batch(
    px: Float32Array, py: Float32Array, pz: Float32Array,
    orderedEids: Uint32Array, cellSize: number,
    queries: Float64Array, maxHits: number, out: Uint32Array,
  ): void;
  // audio (limina-audio)
  op_audio_init(): number;
  op_audio_play(freq: number, secs: number, bus: number, volume: number): number;
  op_audio_ambient(bus: number, volume: number): number;
  op_audio_stop(id: number): void;
  op_audio_stop_all(): void;
  op_audio_set_bus_volume(bus: number, volume: number): void;
  op_audio_play_spatial(freq: number, secs: number, ex: number, ey: number, ez: number, bus: number, volume: number): number;
  op_audio_set_emitter(id: number, x: number, y: number, z: number): void;
  op_audio_set_listener(lx: number, ly: number, lz: number, rx: number, ry: number, rz: number): void;
  op_audio_set_volume(id: number, volume: number): void;
  op_audio_speak(text: string, ex: number, ey: number, ez: number, volume: number, pitch: number): number;
  op_audio_play_buffer(data: Float32Array, sampleRate: number, channels: number, bus: number, volume: number, loop: boolean): number;
}
interface Adapter { requestDevice(): Promise<unknown>; }
declare const navigator: { gpu: { requestAdapter(): Promise<Adapter | null> } };
declare const Deno: { core: { ops: EngineOps } } | undefined;

// ---- Host-capabilities boundary ------------------------------------------
// The native host exposes its ops as `Deno.core.ops`; bind to them lazily and
// ONLY when the global is present, so importing this module with no `Deno`
// global (a browser) does NOT throw. A non-native host (browser/wasm) calls
// installOps() with its own EngineOps implementation — wasm Rapier + a WebGPU
// canvas surface + IndexedDB trace — before any engine code runs. This is the
// single seam that keeps the engine portable: no other module touches `Deno.*`.
// `typeof Deno` short-circuits before `Deno?.core` so an undeclared global never
// throws a ReferenceError. Native binds once at module eval; importers read a
// live binding, so there is no per-call overhead and call sites are unchanged.
export let ops: EngineOps =
  typeof Deno !== "undefined" && Deno?.core?.ops
    ? Deno.core.ops
    : (undefined as unknown as EngineOps);

/** Inject the host capability surface (a browser/wasm host, or a test harness).
 *  Native runs auto-bind to `Deno.core.ops` at import, so this is only needed
 *  off the native host. Call it before any op is used. */
export function installOps(host: EngineOps): void {
  ops = host;
}

// Capability sub-surfaces a non-native host must implement — explicit subsets of
// EngineOps so a browser/wasm host (and the export spike) know the exact seam per
// concern. Pure types; no runtime change.
export type RenderOps = Pick<
  EngineOps,
  | "op_create_window_context" | "op_surface_present" | "op_surface_resize"
  | "op_set_frame_callback" | "op_set_fixed_step_callback" | "op_set_resize_callback"
  | "op_input_axes" | "op_input_look" | "op_input_buttons"
>;
export type PhysicsOps = Pick<
  EngineOps,
  | "op_physics_create_world" | "op_physics_add_ground" | "op_physics_add_box"
  | "op_physics_add_box_material" | "op_physics_add_sphere" | "op_physics_add_capsule"
  | "op_physics_add_static_box" | "op_physics_add_static_sphere" | "op_physics_add_static_capsule"
  | "op_physics_add_heightfield" | "op_physics_add_character" | "op_physics_move_character"
  | "op_physics_remove_body" | "op_physics_apply_impulse" | "op_physics_step"
  | "op_physics_snapshot" | "op_physics_restore" | "op_physics_body_pos"
  | "op_physics_body_transform" | "op_physics_drain_collisions" | "op_physics_raycast"
>;
/** Durable world-log I/O. INVARIANT: a trace is seed + the command stream +
 *  content hashes — NEVER raw runtime bytes; snapshots are caches, not the
 *  source of truth. A browser host implements this over IndexedDB. */
export type TraceOps = Pick<EngineOps, "op_write_trace" | "op_append_trace" | "op_read_trace">;

// ---- Minimal three.js surface used across the engine (avoids `any`) -------

export interface Object3DLike {
  position: { set(x: number, y: number, z: number): void; x: number; y: number; z: number };
  add(child: unknown): void;
  remove(child: unknown): void;
}
export interface SceneLike extends Object3DLike {
  background: unknown;
  /** PBR image-based-lighting source (set by the Phase 11 render baseline). */
  environment?: unknown;
  environmentIntensity?: number;
}
export interface CameraLike {
  position: { set(x: number, y: number, z: number): void };
  aspect: number;
  lookAt(x: number, y: number, z: number): void;
  updateProjectionMatrix(): void;
}
export interface RendererLike {
  init(): Promise<void>;
  setSize(w: number, h: number, updateStyle?: boolean): void;
  render(scene: unknown, camera: unknown): void;
  /** Real-time shadow-map config (WebGPU path). `type` is one of THREE's
   *  PCFShadowMap / PCFSoftShadowMap / VSMShadowMap constants. */
  shadowMap: { enabled: boolean; type: number };
  /** Tone-mapping operator constant (e.g. ACESFilmicToneMapping) + exposure. */
  toneMapping: number;
  toneMappingExposure: number;
}
export interface MaterialLike {
  color: { set(value: number): void };
  roughness: number;
  metalness: number;
}
export interface SceneObject extends Transformable {
  add(child: unknown): void;
  remove(child: unknown): void;
  visible: boolean;
  material?: MaterialLike;
  /** Object3D shadow participation (set by the three.* skills). */
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Object3D.traverse — present on real three objects (glTF groups/meshes). */
  traverse?(callback: (object: SceneObject) => void): void;
}

export interface LoadedResourceMetadata {
  kind: "gltf";
  assetId: string;
  source: string;
  /** Content address ("sha256:...") of the asset bytes this resource was loaded
   *  from — the placed asset's portable, verifiable identity (Phase 11). */
  hash: string;
  bytes: number;
  rootName?: string;
  objectCount: number;
  meshCount: number;
  materialCount: number;
  textureCount: number;
}

// ---- Entity table: opaque ent_ ids -> internal handles -------------------

export interface EntityEntry {
  eid: number;
  generation: number;
  mesh?: SceneObject;
  bodyId?: number;
  resource?: LoadedResourceMetadata;
}

/** The serializable identity slice of one entity-table entry. The mesh/resource
 *  bindings are runtime-only objects (rebound on re-creation), so a snapshot
 *  carries only the stable identity fields. */
export interface EntityEntrySnapshot {
  id: string;
  eid: number;
  generation: number;
  bodyId?: number;
}

/** A capture of the entity table's identity state: the live id->handle entries
 *  (in creation order) plus the `ent_` allocation counter and table version, so
 *  a restored table issues the SAME next ids and reports the same version. */
export interface EntityTableSnapshot {
  seq: number;
  version: number;
  entries: EntityEntrySnapshot[];
}

/** Maps opaque `ent_` strings to internal handles. `ent_` strings are monotonic
 *  and NEVER reused, so a destroyed entity's id resolves to `undefined` forever —
 *  a recycled bitECS eid can never be reached through a stale `ent_`. */
export class EntityTable {
  private readonly map = new Map<string, EntityEntry>();
  private seq = 0;
  private tableVersion = 0;

  get version(): number {
    return this.tableVersion;
  }

  create(entry: Omit<EntityEntry, "generation">): string {
    const id = `ent_${this.seq++}`;
    this.map.set(id, { generation: 0, ...entry });
    this.tableVersion++;
    return id;
  }
  resolve(id: string): EntityEntry | undefined {
    return this.map.get(id);
  }
  destroy(id: string): EntityEntry | undefined {
    const entry = this.map.get(id);
    if (entry !== undefined) {
      this.map.delete(id);
      this.tableVersion++;
    }
    return entry;
  }
  ids(): string[] {
    return [...this.map.keys()];
  }

  /** Capture the table's identity state for a world snapshot (M2). Entries are
   *  emitted in creation order so a restore preserves `ids()` ordering. */
  snapshot(): EntityTableSnapshot {
    const entries: EntityEntrySnapshot[] = [];
    for (const [id, entry] of this.map) {
      entries.push({ id, eid: entry.eid, generation: entry.generation, bodyId: entry.bodyId });
    }
    return { seq: this.seq, version: this.tableVersion, entries };
  }

  /** Rebuild the table from a snapshot: same live entries (creation order),
   *  same `ent_` allocation counter and version, so future ids and the spatial
   *  index's version gate behave exactly as in the original run. Mesh/resource
   *  bindings are runtime-only and left unbound (rebound on demand). */
  restore(snapshot: EntityTableSnapshot): void {
    this.map.clear();
    for (const entry of snapshot.entries) {
      this.map.set(entry.id, { eid: entry.eid, generation: entry.generation, bodyId: entry.bodyId });
    }
    this.seq = snapshot.seq;
    this.tableVersion = snapshot.version;
  }
}

// ---- Engine -------------------------------------------------------------

export interface Engine {
  device: unknown;
  context: unknown;
  renderer: RendererLike;
  scene: SceneLike;
  camera: CameraLike;
  world: unknown; // bitECS world
  transforms: TransformStorage;
  spatial: UniformGridSpatialIndex;
  entities: EntityTable;
  /** eid -> string tags (the `component` set for ecs.addComponent/removeComponent). */
  tags: Map<number, Set<string>>;
  ops: EngineOps;
  /** The render-only post-processing pipeline built by `render.enablePost` (opt-in,
   *  static/cinematic). A PostPipeline from render/post.ts; never sim/log state. */
  post?: unknown;
  width: number;
  height: number;
  mode?: "windowed" | "headless";
}

/** Acquire the GPU device + window surface, build the Three.js renderer/scene/
 *  camera and a bitECS world. The host must have created the window first
 *  (windowed mode) before op_create_window_context succeeds. */
export async function createEngine(opts: {
  width: number;
  height: number;
  /** Phase 11 render baseline. Omit for the tasteful default (lit + IBL +
   *  tonemapped sky). Pass a partial to tweak, or `false` to opt out entirely
   *  (a bare scene — the pre-Phase-11 void). */
  renderBaseline?: RenderBaselineOverride | false;
}): Promise<Engine> {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("engine: no WebGPU adapter");
  const device = await adapter.requestDevice();
  const context = ops.op_create_window_context();

  const canvas = { width: opts.width, height: opts.height, style: {} };
  const renderer: RendererLike = new THREE.WebGPURenderer({ device, context, canvas, antialias: true });
  await renderer.init();
  renderer.setSize(opts.width, opts.height, false);
  // Real-time fidelity: PCF-soft shadow maps, ACES Filmic tone mapping, and MSAA
  // (antialias above). These are the WebGPU-path renderer properties three reads
  // each frame; entities opt into shadows via the three.* skills.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene: SceneLike = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e14);
  const camera: CameraLike = new THREE.PerspectiveCamera(60, opts.width / opts.height, 0.1, 200);

  const world = createEcsWorld();
  const transforms = createTransformStorage(world);
  const spatial = new UniformGridSpatialIndex();

  const engine: Engine = {
    device, context, renderer, scene, camera, world,
    transforms, spatial,
    entities: new EntityTable(), tags: new Map(), ops, width: opts.width, height: opts.height, mode: "windowed",
  };

  // Default windowed resize handling. The compositor sends a resize on first
  // map / focus / window-size change; without reconfiguring the swapchain to the
  // new size the surface goes Outdated and `op_surface_present` fails silently
  // every frame -> a frozen window. Reconfigure surface + renderer + camera so
  // EVERY windowed app is robust by default (an app may still register its own
  // op_set_resize_callback to add behavior; last writer wins).
  ops.op_set_resize_callback((w: number, h: number): void => {
    if (w < 1 || h < 1) return;
    ops.op_surface_resize(w, h);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    engine.width = w;
    engine.height = h;
  });

  // Phase 11: every world inherits the render baseline (lights + IBL + sky +
  // ground + framing) unless the caller opts out with `renderBaseline: false`.
  // The renderer is live (init() awaited above), so PMREM IBL runs here.
  if (opts.renderBaseline !== false) {
    applyRenderBaseline(engine, opts.renderBaseline);
  }

  return engine;
}
