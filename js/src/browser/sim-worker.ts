// Phase 8 Mode B — M3: the SIM-WORKER, the authoritative fixed-step engine loop.
//
// `SimWorkerController` is the Worker-API-AGNOSTIC unit (no `self` / `postMessage`
// / `onmessage` anywhere in it) — it is the testable composition of the verified
// M1/M2 pieces into a headless, deterministic, fixed-step simulation:
//
//   • M1  WasmRapierPhysics   — the live wasm-Rapier `PhysicsOps` (real solver).
//   • M2  SharedTransformStorage — the zero-copy transform SAB the render-main
//                                  thread reads (the worker is the WRITER).
//   • M3  InputRingBuffer     — the lock-free input SAB the render-main thread
//                                  writes (the worker is the CONSUMER).
//   • ECS world + EntityTable + a SkillRegistry with registerCoreSkills, bound to
//     a headless WorldContext whose `ops` are the wasm-physics ops + no-op stubs
//     for the render/audio/host surfaces a worker doesn't have.
//
// tick() is ONE fixed step: read the latest input, drive the player controller,
// `op_physics_step`, then SYNC every live body transform into the transform SAB
// (so the render thread sees the new pose), and publish a coherent Atomics status.
//
// DETERMINISM: real wasm Rapier is deterministic; the controller writes body
// transforms straight into its OWN transform SAB (never the shared world.ts SoA
// globals), so two controllers given identical authoring + identical per-tick
// input produce byte-identical SAB transforms. (Proven in p8_sim_worker.ts.)
//
// The thin Worker SHELL at the bottom (the `self.onmessage` <-> controller wiring)
// is browser-UAT: it runs ONLY inside a real dedicated Worker and does NOTHING at
// import (so this module stays Deno-free / portable, and a native test can import
// the controller without the shell touching a Worker global).

import { EntityTable, type CameraLike, type EngineOps, type PhysicsOps, type SceneLike } from "../engine.ts";
import { createEcsWorld } from "../ecs/world.ts";
import { UniformGridSpatialIndex } from "../spatial/index.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { AssetRegistry } from "../asset-registry.ts";
import { registerCoreSkills, type CoreSkills } from "../skills/index.ts";
import { applyAuthorCommandsIsolated, type AuthorCommandFailure } from "../kernel/apply-isolated.ts";
import { partitionViewportCommands } from "./author-command-policy.ts";
import { AuthoringProjectBinding } from "./authoring-project.ts";
import { registerBrowserAuthoringRuntime } from "./authoring-runtime.ts";
import { LiminaTracer } from "../observability/event.ts";
import { createDesignArtifactStore } from "../world/design-artifacts.ts";
import type { CharacterController } from "../world/character.ts";
import { WasmRapierPhysics, type RapierModule } from "./wasm-rapier-physics.ts";
import { SharedTransformStorage } from "./sab-transforms.ts";
import { InputRingBuffer, type InputFrame } from "./sab-ringbuffer.ts";
import {
  DerivedLod0TerrainIndex,
  type DerivedTerrainGrid,
  type DerivedTerrainIndexEntry,
  type DerivedTerrainManifestChunk,
} from "./derived-terrain-index.ts";
import { createTerrainGridSpec } from "../terrain/grid.mjs";
import { tileKey } from "../terrain/stream.ts";
import type { TerrainTile } from "../terrain/types.ts";
import { prepareGeneratedWaterFieldInput } from "../world/water-field.mjs";
import type { PreparedWaterContactBinding, TerrainHeightSampler } from "../world/water-contact.ts";
import {
  SIM_STATUS_BYTES,
  SIM_STATUS_FLAG_IN_WATER,
  SIM_STATUS_FLAG_SUBMERGED,
  SIM_STATUS_FLAG_SWIMMING,
  SIM_STATUS_TICK_INDEX,
  createSimStatusView,
  initializeSimStatus,
  type SimStatusWrite,
  writeSimStatus,
} from "./sim-status.ts";

/** The fixed simulation step (seconds) — the native 1/60 cadence (host.ts FIXED_DT). */
const FIXED_DT = 1 / 60;

export const DERIVED_SIM_STAGE_SCHEMA = "limina.derived-sim-stage/v1";
const DERIVED_SIM_MAX_RESIDENT_TILES = 225;
const DERIVED_SIM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DERIVED_SIM_HASH = /^sha256:[0-9a-f]{64}$/;
const DERIVED_SIM_PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DERIVED_SIM_BRANCH_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const DERIVED_SIM_MAX_ERROR_LENGTH = 512;

interface DerivedSimGeneratedWater {
  readonly artifact: Readonly<{ artifactType: string; contentHash: string; byteLength: number; mediaType: string }>;
  readonly bytes: Uint8Array;
  readonly bindings: Readonly<{
    hydrologyFieldContentHash: string;
    recipeHash: string;
    erosionStageKey: string;
    compilerGraphHash: string;
  }>;
}

export interface DerivedSimTerrainWindowEntry {
  readonly key: string;
  readonly tx: number;
  readonly tz: number;
  readonly tile: TerrainTile;
}

export interface DerivedSimStageSnapshot {
  readonly schema: typeof DERIVED_SIM_STAGE_SCHEMA;
  readonly projectId: string;
  readonly branchId: string;
  readonly source: Readonly<{ revision: number; headHash: string }>;
  readonly manifestHash: string;
  readonly grid: DerivedTerrainGrid;
  /** First-UAT scope: the complete bounded LOD0 collision residency window, at most 15x15 tiles. */
  readonly terrainWindow: readonly DerivedSimTerrainWindowEntry[];
  readonly generatedWater?: DerivedSimGeneratedWater;
}

export class DerivedSimActivationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DerivedSimActivationError";
    this.code = code;
  }
}

function derivedError(code: string, message: string): DerivedSimActivationError {
  return new DerivedSimActivationError(code, message);
}

function exactPlainRecord(value: unknown, keys: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw derivedError("INVALID_DERIVED_MESSAGE", `${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...keys, ...optional]);
  const names = Object.getOwnPropertyNames(record);
  if (Object.getOwnPropertySymbols(record).length !== 0 || keys.some((key) => !names.includes(key))
      || names.some((key) => !allowed.has(key))) {
    throw derivedError("INVALID_DERIVED_MESSAGE", `${label} has unsupported or missing fields`);
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(record, name);
    if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw derivedError("INVALID_DERIVED_MESSAGE", `${label}.${name} must be an enumerable data field`);
    }
  }
  return record;
}

function derivedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !DERIVED_SIM_ID.test(value)) {
    throw derivedError("INVALID_DERIVED_MESSAGE", `${label} is invalid`);
  }
  return value;
}

function derivedHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !DERIVED_SIM_HASH.test(value)) {
    throw derivedError("INVALID_DERIVED_MESSAGE", `${label} is invalid`);
  }
  return value;
}

function finiteTuple3(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3
      || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
    throw derivedError("INVALID_DERIVED_TERRAIN", `${label} must be a finite 3-tuple`);
  }
  return [value[0], value[1], value[2]];
}

function parseDerivedTerrainTile(value: unknown, label: string): TerrainTile {
  const tile = exactPlainRecord(
    value,
    ["nrows", "ncols", "origin", "scale", "heights"],
    ["paintMat", "paintW", "climate", "climateChannels", "blight"],
    label,
  );
  const nrows = tile.nrows;
  const ncols = tile.ncols;
  if (!Number.isSafeInteger(nrows) || !Number.isSafeInteger(ncols)
      || (nrows as number) < 2 || (ncols as number) < 2
      || (nrows as number) > 257 || (ncols as number) > 257) {
    throw derivedError("INVALID_DERIVED_TERRAIN", `${label} dimensions are invalid`);
  }
  const cells = (nrows as number) * (ncols as number);
  const heights = tile.heights;
  if (!(heights instanceof Float32Array) || Object.getPrototypeOf(heights) !== Float32Array.prototype
      || !(heights.buffer instanceof ArrayBuffer) || heights.byteOffset !== 0
      || heights.byteLength !== heights.buffer.byteLength || heights.length !== cells) {
    throw derivedError("INVALID_DERIVED_TERRAIN", `${label}.heights must be a complete owned Float32Array of length ${cells}`);
  }
  for (let index = 0; index < heights.length; index++) {
    if (!Number.isFinite(heights[index])) throw derivedError("INVALID_DERIVED_TERRAIN", `${label}.heights contains a non-finite sample`);
  }
  const origin = finiteTuple3(tile.origin, `${label}.origin`);
  const scale = finiteTuple3(tile.scale, `${label}.scale`);
  if (!(scale[0] > 0) || !(scale[1] > 0) || !(scale[2] > 0)) {
    throw derivedError("INVALID_DERIVED_TERRAIN", `${label}.scale values must be positive`);
  }
  return Object.freeze({ nrows: nrows as number, ncols: ncols as number, origin, scale, heights });
}

function parseDerivedSimStageSnapshot(value: unknown): Readonly<{
  snapshot: DerivedSimStageSnapshot;
  entries: readonly DerivedTerrainIndexEntry[];
  index: DerivedLod0TerrainIndex;
  preparedGeneratedWater: unknown;
}> {
  const record = exactPlainRecord(
    value,
    ["schema", "projectId", "branchId", "source", "manifestHash", "grid", "terrainWindow"],
    ["generatedWater"],
    "derived sim stage snapshot",
  );
  if (record.schema !== DERIVED_SIM_STAGE_SCHEMA) {
    throw derivedError("INVALID_DERIVED_MESSAGE", `derived sim stage schema must be '${DERIVED_SIM_STAGE_SCHEMA}'`);
  }
  if (typeof record.projectId !== "string" || !DERIVED_SIM_PROJECT_ID.test(record.projectId)
      || typeof record.branchId !== "string" || !DERIVED_SIM_BRANCH_ID.test(record.branchId)) {
    throw derivedError("INVALID_DERIVED_MESSAGE", "derived sim project or branch id is invalid");
  }
  const source = exactPlainRecord(record.source, ["revision", "headHash"], [], "derived sim source");
  if (!Number.isSafeInteger(source.revision) || (source.revision as number) < 0) {
    throw derivedError("INVALID_DERIVED_MESSAGE", "derived sim source revision is invalid");
  }
  const headHash = derivedHash(source.headHash, "derived sim source headHash");
  const manifestHash = derivedHash(record.manifestHash, "derived sim manifestHash");
  const gridInput = exactPlainRecord(record.grid, ["schema", "gridId", "origin", "chunkSizeM", "defaultSamples"], [], "derived sim grid");
  let grid: DerivedTerrainGrid;
  try { grid = createTerrainGridSpec(gridInput) as DerivedTerrainGrid; }
  catch (error) { throw derivedError("INVALID_DERIVED_TERRAIN", error instanceof Error ? error.message : String(error)); }
  if (!Array.isArray(record.terrainWindow) || record.terrainWindow.length < 1
      || record.terrainWindow.length > DERIVED_SIM_MAX_RESIDENT_TILES) {
    throw derivedError("INVALID_DERIVED_TERRAIN", `derived sim terrainWindow must contain 1-${DERIVED_SIM_MAX_RESIDENT_TILES} LOD0 tiles`);
  }
  const entries: DerivedTerrainIndexEntry[] = [];
  const window: DerivedSimTerrainWindowEntry[] = [];
  for (let index = 0; index < record.terrainWindow.length; index++) {
    const item = exactPlainRecord(record.terrainWindow[index], ["key", "tx", "tz", "tile"], [], `derived sim terrainWindow[${index}]`);
    let canonicalKey: string;
    try { canonicalKey = tileKey(item.tx as number, item.tz as number); }
    catch (error) { throw derivedError("INVALID_DERIVED_TERRAIN", error instanceof Error ? error.message : String(error)); }
    if (item.key !== canonicalKey) throw derivedError("INVALID_DERIVED_TERRAIN", `derived sim terrainWindow[${index}].key is not canonical`);
    const tile = parseDerivedTerrainTile(item.tile, `derived sim terrainWindow[${index}].tile`);
    const chunk: DerivedTerrainManifestChunk = Object.freeze({
      chunkId: `resident:${grid.gridId}:0:${item.tx}:${item.tz}`,
      gridId: grid.gridId,
      lod: 0,
      tx: item.tx as number,
      tz: item.tz as number,
      topologyHash: manifestHash,
      sourceSliceHashes: Object.freeze([]),
      artifacts: Object.freeze([]),
    });
    entries.push(Object.freeze({ chunk, tile }));
    window.push(Object.freeze({ key: canonicalKey, tx: item.tx as number, tz: item.tz as number, tile }));
  }
  let terrainIndex: DerivedLod0TerrainIndex;
  try { terrainIndex = new DerivedLod0TerrainIndex(entries, grid); }
  catch (error) { throw derivedError("INVALID_DERIVED_TERRAIN", error instanceof Error ? error.message : String(error)); }

  let generatedWater: DerivedSimGeneratedWater | undefined;
  let preparedGeneratedWater: unknown = undefined;
  if (record.generatedWater !== undefined) {
    const generated = exactPlainRecord(record.generatedWater, ["artifact", "bytes", "bindings"], [], "derived sim generatedWater");
    // prepareGeneratedWaterFieldInput performs the canonical byte hash, descriptor, binding,
    // topology and ownership checks again in this simulation realm.
    try {
      preparedGeneratedWater = prepareGeneratedWaterFieldInput({
        bytes: generated.bytes,
        descriptor: generated.artifact,
        expectedBindings: generated.bindings,
      });
    } catch (error) {
      throw derivedError("INVALID_DERIVED_WATER", error instanceof Error ? error.message : String(error));
    }
    generatedWater = generated as unknown as DerivedSimGeneratedWater;
  }
  const snapshot: DerivedSimStageSnapshot = Object.freeze({
    schema: DERIVED_SIM_STAGE_SCHEMA,
    projectId: record.projectId,
    branchId: record.branchId,
    source: Object.freeze({ revision: source.revision as number, headHash }),
    manifestHash,
    grid,
    terrainWindow: Object.freeze(window),
    ...(generatedWater === undefined ? {} : { generatedWater }),
  });
  return Object.freeze({ snapshot, entries: Object.freeze(entries), index: terrainIndex, preparedGeneratedWater });
}

/** A broad authoring grant set so `loadWorld` can drive the core authoring skills.
 *  Covers the write/read permissions the world-building + player skills require. */
const DEFAULT_GRANTS: ReadonlySet<string> = new Set([
  "scene.write", "scene.read", "ecs.write", "ecs.read", "three.write", "three.read",
  "physics.write", "physics.read", "player.write", "player.read", "player.configure",
  "world.write", "world.read", "terrain.write", "terrain.read", "asset.write", "material.write",
  "design.write", "design.read",
  "audio.write", "camera.write", "animation.write",
  "authoring.read", "authoring.write",
]);

/** One `loadWorld` authoring command. A `skill` command RE-INVOKES a recorded tool
 *  call through the registry (exactly the worldlog replay rule — see replay.ts); a
 *  `physics` command calls an engine physics op directly (for engine-level authoring
 *  with no entity, e.g. `op_physics_create_world` / `op_physics_add_ground`). */
export type AuthorCommand =
  | { kind: "physics"; op: keyof PhysicsOps; args: unknown[] }
  | { kind: "skill"; tool: string; input: unknown; agentId?: string; perms?: Iterable<string> };

/** Map Phase 3.3 — ONE client-streamed terrain tile's heightfield collider, mirrored into the
 *  sim. VIEW-SUPPORT state: the render thread streams tiles around ITS camera (terrain/
 *  stream-client.ts — never the world log) and mirrors each resident tile's collider here so
 *  the locally-simulated player/props stand on the streamed ground. Keyed by tile key so the
 *  matching remove never needs cross-thread body-id agreement (each world numbers its own
 *  bodies); NEVER an entity (no EntityTable/eid slot), NEVER recorded. */
export interface StreamTileColliderAdd {
  key: string;
  ox: number;
  oy: number;
  oz: number;
  nrows: number;
  ncols: number;
  sx: number;
  sy: number;
  sz: number;
  heights: Float32Array;
}

/** Buffers handed across the worker<->main handshake. */
export interface SimWorkerBuffers {
  /** The transform SAB (M2) — render-main JOINs it to read poses zero-copy. */
  sab: SharedArrayBuffer | ArrayBuffer;
  /** The input SAB (M3) — render-main JOINs it to publish input frames. */
  input: SharedArrayBuffer | ArrayBuffer;
  /** The v1 16-byte status SAB. Slot 0 remains the legacy Atomics tick counter. */
  status: SharedArrayBuffer | ArrayBuffer;
}

/** Options for `SimWorkerController.create`. */
export interface SimWorkerCreateOptions {
  /** The injected rapier-compat module namespace (M1 needs the value; the native
   *  loader cannot resolve its bare specifier, so the caller imports + injects it). */
  rapier: RapierModule;
  /** JOIN an existing transform SAB (render-main allocated it) instead of allocating. */
  sab?: SharedArrayBuffer | ArrayBuffer;
  /** JOIN an existing input SAB instead of allocating. */
  inputBuffer?: SharedArrayBuffer | ArrayBuffer;
  /** Asset bytes prefetched by the main thread before the worker handshake. */
  assets?: Iterable<{ id: string; bytes: Uint8Array }>;
  /** Project authority for replaying authoring.commit commands through the scene adapter. */
  authoringProjectId?: string;
  /** Permissions `loadWorld` invokes authoring skills with (default DEFAULT_GRANTS). */
  grants?: Iterable<string>;
  width?: number;
  height?: number;
}

/** A headless no-op scene stub — the worker has no renderer, but skills that touch
 *  `world.scene` (e.g. scene.createEntity's `scene.add(mesh)`) must not crash. */
function stubScene(): SceneLike {
  return {
    position: { set(): void {}, x: 0, y: 0, z: 0 },
    add(): void {},
    remove(): void {},
    background: null,
  };
}

/** A headless no-op camera stub. */
function stubCamera(): CameraLike {
  return {
    position: { set(): void {} },
    aspect: 1,
    lookAt(): void {},
    updateProjectionMatrix(): void {},
  };
}

/** Compose the worker's `EngineOps`: the live wasm-Rapier physics ops bound to the
 *  M1 adapter, and inert stubs for every surface a headless worker lacks (render,
 *  input device, host services, trace, sandbox, audio). Skills read `ctx.world.ops`,
 *  so this is the single op seam the whole sim composes over — no `Deno.core.ops`. */
function composeWorkerOps(P: WasmRapierPhysics, assets: ReadonlyMap<string, Uint8Array>): EngineOps {
  const noop = (): void => {};
  return {
    // ── physics: the REAL wasm-Rapier solver (bound so `this` is the adapter) ──
    op_physics_create_world: P.op_physics_create_world.bind(P),
    op_physics_add_ground: P.op_physics_add_ground.bind(P),
    op_physics_add_box: P.op_physics_add_box.bind(P),
    op_physics_add_box_material: P.op_physics_add_box_material.bind(P),
    op_physics_add_sphere: P.op_physics_add_sphere.bind(P),
    op_physics_add_capsule: P.op_physics_add_capsule.bind(P),
    op_physics_add_static_box: P.op_physics_add_static_box.bind(P),
    op_physics_add_static_sphere: P.op_physics_add_static_sphere.bind(P),
    op_physics_add_static_capsule: P.op_physics_add_static_capsule.bind(P),
    op_physics_add_heightfield: P.op_physics_add_heightfield.bind(P),
    op_physics_add_character: P.op_physics_add_character.bind(P),
    op_physics_move_character: P.op_physics_move_character.bind(P),
    op_physics_remove_body: P.op_physics_remove_body.bind(P),
    op_physics_apply_impulse: P.op_physics_apply_impulse.bind(P),
    op_physics_step: P.op_physics_step.bind(P),
    op_physics_snapshot: P.op_physics_snapshot.bind(P),
    op_physics_restore: P.op_physics_restore.bind(P),
    op_physics_body_pos: P.op_physics_body_pos.bind(P),
    op_physics_body_transform: P.op_physics_body_transform.bind(P),
    op_physics_set_body_transform: P.op_physics_set_body_transform.bind(P),
    op_physics_drain_collisions: P.op_physics_drain_collisions.bind(P),
    op_physics_raycast: P.op_physics_raycast.bind(P),
    op_physics_overlap_box: P.op_physics_overlap_box.bind(P),
    // ── render / loop / device input — no surface in a worker (input arrives via
    //    the InputRingBuffer, consumed directly in tick(), not these ops) ──
    op_create_window_context: () => ({}),
    op_surface_present: noop,
    op_surface_resize: noop,
    op_set_frame_callback: noop,
    op_set_fixed_step_callback: noop,
    op_set_resize_callback: noop,
    op_input_axes: noop,
    op_input_look: noop,
    op_input_buttons: noop,
    // ── host services ──
    op_log: noop,
    op_http_post: () => Promise.resolve(""),
    op_http_post_headers: () => Promise.resolve(""),
    op_sleep_ms: () => Promise.resolve(),
    // Asset bytes are cloned into the init message after an async main-thread
    // prefetch. This keeps worker authoring deterministic without synchronous XHR.
    op_read_asset: (id: string): Uint8Array => assets.get(id) ?? new Uint8Array(0),
    op_sha256: () => "",
    op_read_env: () => "",
    // ── durable trace ──
    op_write_trace: noop,
    op_append_trace: noop,
    op_read_trace: () => "",
    // ── sandbox ──
    op_sandbox_create: () => 0,
    op_sandbox_eval: () => "",
    op_sandbox_destroy: () => false,
    op_sandbox_count: () => 0,
    // ── native ECS spatial ──
    op_ecs_spatial_query_batch: noop,
    // ── audio ──
    op_audio_init: () => 0,
    op_audio_play: () => 0,
    op_audio_ambient: () => 0,
    op_audio_stop: noop,
    op_audio_stop_all: noop,
    op_audio_set_bus_volume: noop,
    op_audio_play_spatial: () => 0,
    op_audio_set_emitter: noop,
    op_audio_set_listener: noop,
    op_audio_set_volume: noop,
    op_audio_speak: () => 0,
    op_audio_play_buffer: () => 0,
  };
}

export class SimWorkerController {
  /** The headless WorldContext skills + the controller operate over. */
  readonly world: WorldContext;
  /** The composed core skills (player controllers, etc.) — handed back for drive. */
  readonly core: CoreSkills;
  /** The skill registry (registerCoreSkills installed). */
  readonly registry: SkillRegistry;

  private readonly physics: WasmRapierPhysics;
  private readonly transformStorage: SharedTransformStorage;
  private readonly inputRing: InputRingBuffer;
  private readonly statusBuffer: SharedArrayBuffer | ArrayBuffer;
  private readonly status: Int32Array;
  private readonly statusShared: boolean;
  private readonly entityTable: EntityTable;
  private readonly grants: ReadonlySet<string>;
  private readonly sessionId = "ses_sim_worker";
  private readonly authoringBinding: AuthoringProjectBinding;

  private tickCount = 0;
  private disposed = false;
  private activePlayerDirty = true;
  private activePlayerCache: { eid: number; controller: CharacterController } | undefined;
  private readonly statusWrite: SimStatusWrite = { tick: 0, flags: 0, playerEid: -1 };
  private readonly scratch7 = new Float32Array(7);
  private readonly inFrame: InputFrame = { move: [0, 0, 0], look: [0, 0], buttons: [0, 0], tick: 0 };
  private lastInputFrame: InputFrame | null = null;
  private stagedDerived: {
    readonly requestId: string;
    readonly snapshot: DerivedSimStageSnapshot;
    readonly entries: readonly DerivedTerrainIndexEntry[];
    readonly index: DerivedLod0TerrainIndex;
    readonly preparedContact: PreparedWaterContactBinding | null;
    readonly priorTerrainSampler: TerrainHeightSampler | null;
    readonly priorContactBindingId: string | null;
    readonly priorContactContentHash: string | null;
    readonly priorGeneratedContentHash: string | null;
  } | null = null;
  private activeDerived: {
    readonly requestId: string;
    readonly manifestHash: string;
    readonly colliderIds: readonly number[];
    readonly preparedContact: PreparedWaterContactBinding | null;
    readonly terrainSampler: TerrainHeightSampler;
  } | null = null;
  private lastDiscardedDerived: { readonly requestId: string; readonly manifestHash: string } | null = null;
  private suppressedAuthoredTerrainBodies = new Set<number>();

  private constructor(args: {
    physics: WasmRapierPhysics;
    transforms: SharedTransformStorage;
    inputRing: InputRingBuffer;
    statusBuffer: SharedArrayBuffer | ArrayBuffer;
    statusShared: boolean;
    world: WorldContext;
    core: CoreSkills;
    registry: SkillRegistry;
    entities: EntityTable;
    grants: ReadonlySet<string>;
    authoringBinding: AuthoringProjectBinding;
  }) {
    this.physics = args.physics;
    this.transformStorage = args.transforms;
    this.inputRing = args.inputRing;
    this.statusBuffer = args.statusBuffer;
    this.status = createSimStatusView(args.statusBuffer);
    this.statusShared = args.statusShared;
    this.world = args.world;
    this.core = args.core;
    this.registry = args.registry;
    this.entityTable = args.entities;
    this.grants = args.grants;
    this.authoringBinding = args.authoringBinding;
  }

  /** Build the controller: bring up wasm Rapier (M1), allocate/join the transform
   *  (M2) + input (M3) SABs, build the ECS world + EntityTable, and a registry with
   *  the core skill set bound to a headless WorldContext over the wasm-physics ops.
   *  No physics world exists yet — `loadWorld` issues `op_physics_create_world`. */
  static async create(opts: SimWorkerCreateOptions): Promise<SimWorkerController> {
    const physics = await WasmRapierPhysics.create(opts.rapier);
    const transforms = new SharedTransformStorage(opts.sab !== undefined ? { buffer: opts.sab } : {});
    const inputRing = new InputRingBuffer(opts.inputBuffer !== undefined ? { buffer: opts.inputBuffer } : {});

    const statusShared = typeof SharedArrayBuffer === "function" && typeof Atomics !== "undefined";
    const statusBuffer: SharedArrayBuffer | ArrayBuffer = statusShared
      ? new SharedArrayBuffer(SIM_STATUS_BYTES)
      : new ArrayBuffer(SIM_STATUS_BYTES);
    initializeSimStatus(createSimStatusView(statusBuffer));

    const ecs = createEcsWorld();
    const entities = new EntityTable();
    const assetBytes = new Map<string, Uint8Array>();
    for (const asset of opts.assets ?? []) assetBytes.set(asset.id, asset.bytes);
    const ops = composeWorkerOps(physics, assetBytes);

    const world: WorldContext = {
      ecs,
      transforms,
      spatial: new UniformGridSpatialIndex(),
      entities,
      tags: new Map(),
      design: createDesignArtifactStore(),
      scene: stubScene(),
      camera: stubCamera(),
      ops,
      width: opts.width ?? 1,
      height: opts.height ?? 1,
      mode: "headless",
      // The authoritative sim, with no DOM: GLB-mounting skills skip the mesh parse here (the render
      // thread mounts it) and only spawn the entity — see loadGltfIntoScene.
      simWorker: true,
    };

    const registry = new SkillRegistry(LiminaTracer.ephemeral("ses_sim_worker"));
    // AssetRegistry bound to the WORKER's ops (op_read_asset is a no-op → empty bytes): a GLB skill's
    // assets.resolve() returns instantly here instead of a blocking sync XHR that would hang the
    // worker's init. The worker never parses the mesh, so it never needs real bytes.
    const assets = new AssetRegistry(ops);
    for (const [id, bytes] of assetBytes) assets.seed(id, bytes);
    const core = registerCoreSkills(registry, { assets });
    const authoringBinding = new AuthoringProjectBinding((projectId) => {
      registerBrowserAuthoringRuntime(registry, world, projectId);
    }, opts.authoringProjectId);

    return new SimWorkerController({
      physics, transforms, inputRing, statusBuffer, statusShared,
      world, core, registry, entities,
      grants: opts.grants !== undefined ? new Set(opts.grants) : DEFAULT_GRANTS,
      authoringBinding,
    });
  }

  /** Author (or replay) a world into the sim, ISOLATING each command (Layer-2 graceful boundary): a
   *  single bad / out-of-band command must NEVER throw out of `loadWorld` and abort the whole batch —
   *  every valid command still applies, and the failures are carried out structurally. Each command
   *  either RE-INVOKES a recorded skill through the registry (the worldlog replay rule) or calls an
   *  engine physics op directly; both go through the SAME per-command contract as the kernel/skill
   *  layers (`applyAuthorCommandsIsolated` → `applyAuthorCommand` → `registry.invoke`, which already
   *  try/catches every handler). After authoring, the initial body transforms are synced into the
   *  transform SAB so the render thread frames the world before the first tick. */
  async loadWorldIsolated(commands: AuthorCommand[]): Promise<{ results: unknown[]; failures: AuthorCommandFailure[] }> {
    this.authoringBinding.ensure(commands);
    const viewportBatch = partitionViewportCommands(commands);
    const outcome = await applyAuthorCommandsIsolated(this.registry, this.world, viewportBatch.commands, {
      sessionId: this.sessionId,
      defaultAgentId: "author",
      defaultPerms: this.grants,
      tick: this.tickCount,
    });
    // Player spawn/despawn is authored only between fixed steps. Any authoring batch may
    // change entity/controller membership, so reselect once on the next tick, not every tick.
    this.activePlayerDirty = true;
    const results: unknown[] = Array(commands.length).fill(undefined);
    for (let i = 0; i < viewportBatch.commands.length; i++) {
      const originalIndex = viewportBatch.originalIndices[i];
      const res = outcome.results[i];
      if (res !== undefined && res.success) {
        // Only a SUCCESSFUL live transform mutation re-drives the physics body; a failed command left
        // no effect to mirror.
        this.syncLiveTransformMutationToPhysics(viewportBatch.commands[i]);
        results[originalIndex] = res.result;
      }
    }
    if (this.activeDerived !== null) {
      this.suppressAuthoredTerrainColliders();
      // A recorded terrain-source command may have cleared the authored contact binding. The
      // committed derived presentation remains authoritative until a later two-phase commit.
      if (this.activeDerived.preparedContact !== null) {
        this.core.water.contact.activate(this.activeDerived.preparedContact, this.activeDerived.terrainSampler);
      }
    }
    this.syncTransforms();
    return {
      results,
      failures: outcome.failures.map((failure) => ({
        ...failure,
        index: viewportBatch.originalIndices[failure.index],
      })),
    };
  }

  /** Back-compat wrapper: returns just the per-command results (skill result / physics-op return, or
   *  `undefined` for a command that failed). Never throws. Callers that need the failure detail use
   *  `loadWorldIsolated`. */
  async loadWorld(commands: AuthorCommand[]): Promise<unknown[]> {
    return (await this.loadWorldIsolated(commands)).results;
  }

  /** Map Phase 3.3 — apply a client-stream collider diff (removes, then adds; idempotent per
   *  key). VIEW-SUPPORT state driven by the render thread's camera-following terrain stream:
   *  it keeps the local sim's ground under the streamed meshes, but is NOT part of the
   *  recorded/authored world (see StreamTileColliderAdd). Processed between fixed steps
   *  (worker messages interleave the self-drive interval), so a tick never sees a half-diff. */
  private readonly streamTileBodies = new Map<string, number>();
  applyStreamTileColliders(add: readonly StreamTileColliderAdd[], remove: readonly string[]): void {
    if (this.disposed) return;
    for (const key of remove) {
      const bodyId = this.streamTileBodies.get(key);
      if (bodyId !== undefined) {
        this.world.ops.op_physics_remove_body(bodyId);
        this.streamTileBodies.delete(key);
      }
    }
    // A committed derived LOD0 window is the authoritative local collision presentation. The
    // camera-follow legacy stream must not double-mount its own copy while that revision is live.
    if (this.activeDerived !== null) return;
    for (const t of add) {
      if (this.streamTileBodies.has(t.key)) continue;
      this.streamTileBodies.set(
        t.key,
        this.world.ops.op_physics_add_heightfield(t.ox, t.oy, t.oz, t.nrows, t.ncols, t.sx, t.sy, t.sz, t.heights),
      );
    }
  }

  /** Stage one bounded derived-simulation candidate. This verifies and indexes transferred LOD0
   *  tiles and re-verifies canonical generated-water bytes in this realm, but creates no collider
   *  and does not change the active water contact. A newer successful stage replaces the sole
   *  retained candidate. */
  stageDerivedRevision(requestIdValue: unknown, manifestHashValue: unknown, snapshotValue: unknown): Readonly<{
    requestId: string; manifestHash: string; tick: number;
  }> {
    if (this.disposed) throw derivedError("SIM_DISPOSED", "sim worker is disposed");
    const requestId = derivedId(requestIdValue, "derived stage requestId");
    const manifestHash = derivedHash(manifestHashValue, "derived stage manifestHash");
    const parsed = parseDerivedSimStageSnapshot(snapshotValue);
    if (parsed.snapshot.manifestHash !== manifestHash) {
      throw derivedError("DERIVED_MANIFEST_MISMATCH", "derived stage manifestHash does not match its snapshot");
    }
    const contact = this.core.water.contact;
    const priorTerrainSampler = contact.activeTerrainSampler;
    let preparedContact: PreparedWaterContactBinding | null = null;
    if (contact.activeBindingId !== null || parsed.preparedGeneratedWater !== undefined) {
      if (contact.activeBindingId === null) {
        throw derivedError("DERIVED_CONTACT_UNBOUND", "generated water requires an active verified authored map binding");
      }
      try { preparedContact = contact.prepareGeneratedForActive(parsed.preparedGeneratedWater); }
      catch (error) { throw derivedError("DERIVED_CONTACT_PREPARE_FAILED", error instanceof Error ? error.message : String(error)); }
      if (priorTerrainSampler === null) {
        throw derivedError("DERIVED_CONTACT_UNBOUND", "active water contact has no terrain sampler");
      }
    }
    this.stagedDerived = Object.freeze({
      requestId,
      snapshot: parsed.snapshot,
      entries: parsed.entries,
      index: parsed.index,
      preparedContact,
      priorTerrainSampler,
      priorContactBindingId: contact.activeBindingId,
      priorContactContentHash: contact.activeContentHash,
      priorGeneratedContentHash: contact.activeGeneratedArtifactContentHash,
    });
    this.lastDiscardedDerived = null;
    return Object.freeze({ requestId, manifestHash, tick: this.ticks });
  }

  /** Atomically commit the sole staged candidate. The synchronous method is invoked from one
   *  worker task, so neither the fixed-step timer nor another worker message can observe its
   *  intermediate collider/contact state. */
  commitDerivedRevision(requestIdValue: unknown, stagedRequestIdValue: unknown, manifestHashValue: unknown): Readonly<{
    requestId: string; stagedRequestId: string; manifestHash: string; tick: number;
  }> {
    if (this.disposed) throw derivedError("SIM_DISPOSED", "sim worker is disposed");
    const requestId = derivedId(requestIdValue, "derived commit requestId");
    const stagedRequestId = derivedId(stagedRequestIdValue, "derived commit stagedRequestId");
    const manifestHash = derivedHash(manifestHashValue, "derived commit manifestHash");
    const candidate = this.stagedDerived;
    if (candidate === null || candidate.requestId !== stagedRequestId || candidate.snapshot.manifestHash !== manifestHash) {
      throw derivedError("STALE_DERIVED_STAGE", "derived commit does not name the currently staged candidate");
    }
    const contact = this.core.water.contact;
    if (contact.activeBindingId !== candidate.priorContactBindingId
        || contact.activeContentHash !== candidate.priorContactContentHash
        || contact.activeGeneratedArtifactContentHash !== candidate.priorGeneratedContentHash) {
      throw derivedError("STALE_DERIVED_CONTACT", "active water contact changed after derived staging");
    }
    const fallback = candidate.priorTerrainSampler;
    const terrainSampler: TerrainHeightSampler = (x, z) => {
      const resident = candidate.index.sampleHeight(x, z);
      if (resident !== null) return resident;
      if (fallback !== null) return fallback(x, z);
      throw new RangeError("derived terrain query is outside the resident LOD0 window and has no prior sampler");
    };
    const physicsSnapshot = this.world.ops.op_physics_snapshot();
    const nextColliderIds: number[] = [];
    const priorSuppressed = this.suppressedAuthoredTerrainBodies;
    try {
      for (const entry of candidate.entries) {
        const tile = entry.tile;
        nextColliderIds.push(this.world.ops.op_physics_add_heightfield(
          tile.origin[0], tile.origin[1], tile.origin[2],
          tile.nrows, tile.ncols,
          tile.scale[0], tile.scale[1], tile.scale[2],
          tile.heights,
        ));
      }
      const suppressed = this.collectAuthoredTerrainBodies();
      for (const bodyId of suppressed) this.world.ops.op_physics_remove_body(bodyId);
      for (const bodyId of this.streamTileBodies.values()) this.world.ops.op_physics_remove_body(bodyId);
      for (const bodyId of this.activeDerived?.colliderIds ?? []) this.world.ops.op_physics_remove_body(bodyId);
      if (candidate.preparedContact !== null) contact.activate(candidate.preparedContact, terrainSampler);

      this.streamTileBodies.clear();
      this.suppressedAuthoredTerrainBodies = suppressed;
      this.activeDerived = Object.freeze({
        requestId: stagedRequestId,
        manifestHash,
        colliderIds: Object.freeze(nextColliderIds),
        preparedContact: candidate.preparedContact,
        terrainSampler,
      });
      this.stagedDerived = null;
      this.lastDiscardedDerived = null;
    } catch (error) {
      try { this.world.ops.op_physics_restore(physicsSnapshot); }
      catch (restoreError) {
        throw new AggregateError([error, restoreError], "derived commit failed and physics rollback also failed");
      }
      this.suppressedAuthoredTerrainBodies = priorSuppressed;
      throw derivedError("DERIVED_COMMIT_FAILED", error instanceof Error ? error.message : String(error));
    }
    return Object.freeze({ requestId, stagedRequestId, manifestHash, tick: this.ticks });
  }

  /** Discard is idempotent only for the exact candidate most recently discarded. Replaced,
   *  committed, arbitrary or manifest-mismatched IDs are stale and are rejected. */
  discardDerivedRevision(requestIdValue: unknown, stagedRequestIdValue: unknown, manifestHashValue: unknown): Readonly<{
    requestId: string; stagedRequestId: string; manifestHash: string; discarded: boolean; tick: number;
  }> {
    if (this.disposed) throw derivedError("SIM_DISPOSED", "sim worker is disposed");
    const requestId = derivedId(requestIdValue, "derived discard requestId");
    const stagedRequestId = derivedId(stagedRequestIdValue, "derived discard stagedRequestId");
    const manifestHash = derivedHash(manifestHashValue, "derived discard manifestHash");
    let discarded = false;
    if (this.stagedDerived?.requestId === stagedRequestId && this.stagedDerived.snapshot.manifestHash === manifestHash) {
      this.stagedDerived = null;
      this.lastDiscardedDerived = Object.freeze({ requestId: stagedRequestId, manifestHash });
      discarded = true;
    } else if (this.stagedDerived === null
        && this.lastDiscardedDerived?.requestId === stagedRequestId
        && this.lastDiscardedDerived.manifestHash === manifestHash) {
      discarded = false;
    } else {
      throw derivedError("STALE_DERIVED_STAGE", "derived discard does not name the currently staged or last-discarded candidate");
    }
    return Object.freeze({ requestId, stagedRequestId, manifestHash, discarded, tick: this.ticks });
  }

  get derivedRevisionStatus(): Readonly<{
    stagedRequestId: string | null;
    stagedManifestHash: string | null;
    activeRequestId: string | null;
    activeManifestHash: string | null;
    activeColliderCount: number;
  }> {
    return Object.freeze({
      stagedRequestId: this.stagedDerived?.requestId ?? null,
      stagedManifestHash: this.stagedDerived?.snapshot.manifestHash ?? null,
      activeRequestId: this.activeDerived?.requestId ?? null,
      activeManifestHash: this.activeDerived?.manifestHash ?? null,
      activeColliderCount: this.activeDerived?.colliderIds.length ?? 0,
    });
  }

  private collectAuthoredTerrainBodies(): Set<number> {
    const result = new Set<number>();
    for (const region of this.core.terrain.regions.values()) {
      for (const tile of region.tiles.values()) result.add(tile.bodyId);
    }
    for (const layer of this.core.terrain.layers.values()) result.add(layer.bodyId);
    return result;
  }

  private suppressAuthoredTerrainColliders(): void {
    const current = this.collectAuthoredTerrainBodies();
    for (const bodyId of current) {
      if (!this.suppressedAuthoredTerrainBodies.has(bodyId)) this.world.ops.op_physics_remove_body(bodyId);
    }
    this.suppressedAuthoredTerrainBodies = current;
  }

  /** Advance the simulation ONE fixed step:
   *    1. read the most-recently-published input frame (1-frame latency by design),
   *    2. drive the player character controller (if one is spawned) with it,
   *    3. `op_physics_step` (integrate dynamics + commit queued kinematic moves),
   *    4. sync every live body transform into the transform SAB (render sees it),
   *    5. seqlock-publish the completed tick and canonical player water state.
   *  Returns the new tick number. */
  tick(): number {
    if (this.disposed) return this.tickCount; // torn down — never step a released world
    const frame = this.inputRing.readLatest(this.inFrame);
    this.lastInputFrame = frame;

    // Lowest live eid is the canonical controlled player. Registration order is not
    // an identity contract, and stale controller entries may remain after entity teardown.
    const activePlayer = this.activePlayer();
    // A null frame -> a zero
    // command, so gravity still integrates and the character stays grounded
    // deterministically each tick.
    if (activePlayer !== undefined) {
      activePlayer.controller.step(
        frame !== null
          ? {
            // move = [strafe, vertical, forward]; look[0] = heading yaw.
            forward: frame.move[2],
            strafe: frame.move[0],
            yaw: frame.look[0],
            run: frame.buttons[1] > 0.5,
            jump: frame.buttons[0] > 0.5,
          }
          : { forward: 0, strafe: 0, yaw: 0, run: false, jump: false },
        FIXED_DT,
      );
    }

    this.world.ops.op_physics_step();
    this.syncTransforms();

    this.tickCount++;
    let flags = 0;
    if (activePlayer !== undefined) {
      if (activePlayer.controller.waterMode !== "dry") flags |= SIM_STATUS_FLAG_IN_WATER;
      if (activePlayer.controller.isSwimming) flags |= SIM_STATUS_FLAG_SWIMMING;
      if (activePlayer.controller.isSubmerged) flags |= SIM_STATUS_FLAG_SUBMERGED;
    }
    this.statusWrite.tick = this.tickCount;
    this.statusWrite.flags = flags;
    this.statusWrite.playerEid = activePlayer?.eid ?? -1;
    writeSimStatus(this.status, this.statusWrite);
    return this.tickCount;
  }

  private activePlayer(): { eid: number; controller: CharacterController } | undefined {
    if (!this.activePlayerDirty) return this.activePlayerCache;
    let selected: { eid: number; controller: CharacterController } | undefined;
    for (const entity of this.core.player.controllers.ids()) {
      const tableEntry = this.entityTable.resolve(entity);
      const controllerEntry = this.core.player.controllers.get(entity);
      if (tableEntry === undefined || controllerEntry === undefined || tableEntry.bodyId !== controllerEntry.controller.bodyId) continue;
      if (selected === undefined || tableEntry.eid < selected.eid) {
        selected = { eid: tableEntry.eid, controller: controllerEntry.controller };
      }
    }
    this.activePlayerCache = selected;
    this.activePlayerDirty = false;
    return this.activePlayerCache;
  }

  /** Tear the controller down (shell `stop`): mark it disposed so no later `tick()`
   *  steps the released world, drop the retained input frame, and free the wasm
   *  Rapier world/controller/event handles. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lastInputFrame = null;
    this.activePlayerCache = undefined;
    this.stagedDerived = null;
    this.activeDerived = null;
    this.lastDiscardedDerived = null;
    this.suppressedAuthoredTerrainBodies.clear();
    this.physics.dispose();
  }

  /** Copy every live body/entity transform from the physics solver into the
   *  transform SAB (SoA), keyed by ECS eid — the worker's WRITE half of the M2
   *  zero-copy bridge. Writes the SAB directly (not the world.ts SoA globals), so
   *  parallel controllers stay independent + deterministic. */
  private syncTransforms(): void {
    const scratch = this.scratch7;
    for (const id of this.entityTable.ids()) {
      const entry = this.entityTable.resolve(id);
      if (entry === undefined || entry.bodyId === undefined) continue;
      if (this.suppressedAuthoredTerrainBodies.has(entry.bodyId)) continue;
      // ONLY physics-bound entities stream their live transform into the SAB each tick.
      // Bodyless static renderables are DELIBERATELY not written here: putting them in the
      // per-tick SAB present-set makes renderSyncSystem overwrite a gizmo/inspector move the
      // instant the drag's sync-suppression lifts (before the server round-trip lands), which
      // breaks direct-manipulation editing. (The offline-authored → reconnect origin-render
      // bug this once addressed needs a movement-safe re-fix: sync a bodyless pose on load /
      // on authored change, not every frame.)
      this.world.ops.op_physics_body_transform(entry.bodyId, scratch);
      this.transformStorage.writePosition(entry.eid, scratch[0], scratch[1], scratch[2]);
      this.transformStorage.writeRotation(entry.eid, scratch[3], scratch[4], scratch[5], scratch[6]);
    }
  }

  /** `ecs.updateComponent` is the editor's live transform mutation path. The
   *  worker owns Rapier and then streams body transforms into the SAB, so for a
   *  body-bound entity the physics body must be updated before the next sync. */
  private syncLiveTransformMutationToPhysics(cmd: AuthorCommand): void {
    if (cmd.kind !== "skill" || cmd.tool !== "ecs.updateComponent") return;
    const input = cmd.input as { entity?: unknown; component?: unknown; value?: unknown };
    if (typeof input.entity !== "string" || !Array.isArray(input.value)) return;
    const entry = this.entityTable.resolve(input.entity);
    if (entry?.bodyId === undefined) return;
    if (input.component === "position" && input.value.length >= 3) {
      this.physics.setBodyTranslation(
        entry.bodyId,
        Number(input.value[0]),
        Number(input.value[1]),
        Number(input.value[2]),
      );
    } else if (input.component === "rotation" && input.value.length >= 3) {
      this.physics.setBodyRotation(
        entry.bodyId,
        Number(input.value[0]),
        Number(input.value[1]),
        Number(input.value[2]),
        Number(input.value[3] ?? 1),
      );
    }
  }

  /** The completed fixed-step count (read via Atomics — cross-thread visible).
   *  Named `ticks` because `tick()` is the step method (a class cannot expose both
   *  a `tick()` method and a `tick` getter); `tick()` ALSO returns the new count. */
  get ticks(): number {
    return this.statusShared ? Atomics.load(this.status, SIM_STATUS_TICK_INDEX) : this.status[SIM_STATUS_TICK_INDEX];
  }

  /** The M2 transform storage (the render thread reads its `.Position`/`.Rotation`). */
  get transforms(): SharedTransformStorage {
    return this.transformStorage;
  }

  /** The entity table (resolve an authored entity id -> its eid/bodyId). */
  get entities(): EntityTable {
    return this.entityTable;
  }

  /** The buffers to post across the worker handshake. */
  get buffers(): SimWorkerBuffers {
    return { sab: this.transformStorage.buffer, input: this.inputRing.buffer, status: this.statusBuffer };
  }

  /** The input frame consumed at the most recent `tick()` (null if none / pre-tick).
   *  A fresh copy each call so callers can retain it across ticks. */
  get lastInput(): InputFrame | null {
    const f = this.lastInputFrame;
    return f === null ? null : { move: [...f.move], look: [...f.look], buttons: [...f.buttons], tick: f.tick };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Thin Worker SHELL (browser-UAT). Wires `self.onmessage` -> controller and
// `postMessage` <- controller. Import-only: NOTHING runs at module load; the
// auto-install at the very bottom fires ONLY inside a real dedicated Worker, so a
// native test importing `SimWorkerController` never touches a Worker global.
// ───────────────────────────────────────────────────────────────────────────────

interface WorkerScopeLike {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

export type InitMessage = {
  type: "init";
  sab?: SharedArrayBuffer | ArrayBuffer;
  inputBuffer?: SharedArrayBuffer | ArrayBuffer;
  commands?: AuthorCommand[];
  assets?: { id: string; bytes: Uint8Array }[];
  authoringProjectId?: string;
  hz?: number;
};
type StepMessage = { type: "step" };
type StopMessage = { type: "stop" };
type PauseMessage = { type: "pause"; requestId?: number };
type ResumeMessage = { type: "resume"; requestId?: number };
type ApplyCommandsMessage = { type: "applyCommands"; commands?: AuthorCommand[] };
/** Map Phase 3.3 — client-stream collider mirroring (view-support; see StreamTileColliderAdd). */
type StreamTileCollidersMessage = { type: "streamTileColliders"; add?: StreamTileColliderAdd[]; remove?: string[] };
export type StageDerivedRevisionMessage = {
  type: "stageDerivedRevision";
  requestId: string;
  manifestHash: string;
  snapshot: DerivedSimStageSnapshot;
};
export type CommitDerivedRevisionMessage = {
  type: "commitDerivedRevision";
  requestId: string;
  stagedRequestId: string;
  manifestHash: string;
};
export type DiscardDerivedRevisionMessage = {
  type: "discardDerivedRevision";
  requestId: string;
  stagedRequestId: string;
  manifestHash: string;
};
type DerivedRevisionShellMessage = StageDerivedRevisionMessage | CommitDerivedRevisionMessage | DiscardDerivedRevisionMessage;
type ShellMessage = InitMessage | StepMessage | StopMessage | PauseMessage | ResumeMessage | ApplyCommandsMessage
  | StreamTileCollidersMessage | DerivedRevisionShellMessage;

export interface SimWorkerShellDependencies {
  /** Test/embedding seam. Production omits this and imports rapier in the dedicated worker. */
  createController?: (message: InitMessage) => Promise<SimWorkerController>;
}

function parseDerivedRevisionShellMessage(value: unknown): Readonly<DerivedRevisionShellMessage> {
  const record = exactPlainRecord(value, ["type", "requestId", "manifestHash"], ["snapshot", "stagedRequestId"], "derived revision shell message");
  const type = record.type;
  if (type !== "stageDerivedRevision" && type !== "commitDerivedRevision" && type !== "discardDerivedRevision") {
    throw derivedError("INVALID_DERIVED_MESSAGE", "derived revision shell message type is invalid");
  }
  const requestId = derivedId(record.requestId, `derived ${type} requestId`);
  const manifestHash = derivedHash(record.manifestHash, `derived ${type} manifestHash`);
  if (type === "stageDerivedRevision") {
    if (!Object.hasOwn(record, "snapshot") || Object.hasOwn(record, "stagedRequestId")) {
      throw derivedError("INVALID_DERIVED_MESSAGE", "derived stage message fields are invalid");
    }
    return Object.freeze({ type, requestId, manifestHash, snapshot: record.snapshot as DerivedSimStageSnapshot });
  }
  if (!Object.hasOwn(record, "stagedRequestId") || Object.hasOwn(record, "snapshot")) {
    throw derivedError("INVALID_DERIVED_MESSAGE", `derived ${type} message fields are invalid`);
  }
  const stagedRequestId = derivedId(record.stagedRequestId, `derived ${type} stagedRequestId`);
  return Object.freeze({ type, requestId, stagedRequestId, manifestHash });
}

/** Install the Worker message wiring on a worker global. `init` builds the
 *  controller (importing rapier-compat — resolved by the browser bundle, never the
 *  native loader, since this runs only inside a real Worker), authors any supplied
 *  world, replies `ready` with the handshake buffers, then self-drives a fixed-step
 *  interval (or steps on demand). Completed-tick state is published through the
 *  status SAB; no per-tick messages are posted. */
export function installSimWorker(scope: WorkerScopeLike, dependencies: SimWorkerShellDependencies = {}): void {
  let controller: SimWorkerController | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let driveHz = 60;
  let paused = false;

  /** Post a structured error to the main thread so a throw is observable rather
   *  than a silent unhandledrejection (which would stop stepping unseen). */
  const postError = (phase: string, err: unknown): void => {
    const e = err as { message?: unknown; stack?: unknown } | null;
    scope.postMessage({
      type: "error",
      phase,
      message: typeof e?.message === "string" ? e.message : String(err),
      stack: typeof e?.stack === "string" ? e.stack : undefined,
    });
  };

  /** Post the NON-FATAL per-command authoring failures from an isolated `loadWorld` back to the main
   *  thread (distinct `type:"authoringFailures"` so the main thread reports WHICH commands failed
   *  without treating it as a fatal `{type:"error"}` that tears the sim down). The valid commands
   *  already applied; the worker keeps stepping. */
  const postAuthoringFailures = (phase: string, failures: AuthorCommandFailure[]): void => {
    if (failures.length === 0) return;
    scope.postMessage({ type: "authoringFailures", phase, failures });
  };

  /** Fully tear down what `init` brought up: stop the self-drive interval and
   *  dispose + release the controller (so its joined SABs can be collected). */
  const teardown = (): void => {
    if (timer !== undefined) { clearInterval(timer); timer = undefined; }
    if (controller !== null) { controller.dispose(); controller = null; }
    paused = false;
  };

  const rejectControl = (operation: "pause" | "resume", requestId: number | undefined, reason: string): void => {
    scope.postMessage({ type: "controlRejected", operation, requestId, reason });
  };

  const rejectDerived = (operation: "stage" | "commit" | "discard", raw: unknown, error: unknown): void => {
    const record = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const message = error instanceof Error ? error.message : String(error);
    scope.postMessage({
      type: "derivedRevisionRejected",
      operation,
      ...(typeof record.requestId === "string" && DERIVED_SIM_ID.test(record.requestId) ? { requestId: record.requestId } : {}),
      ...(typeof record.stagedRequestId === "string" && DERIVED_SIM_ID.test(record.stagedRequestId) ? { stagedRequestId: record.stagedRequestId } : {}),
      ...(typeof record.manifestHash === "string" && DERIVED_SIM_HASH.test(record.manifestHash) ? { manifestHash: record.manifestHash } : {}),
      code: error instanceof DerivedSimActivationError ? error.code : "DERIVED_OPERATION_FAILED",
      message: message.length <= DERIVED_SIM_MAX_ERROR_LENGTH ? message : `${message.slice(0, DERIVED_SIM_MAX_ERROR_LENGTH - 3)}...`,
      tick: controller?.ticks ?? 0,
    });
  };

  const startDrive = (): void => {
    if (timer !== undefined || controller === null || paused) return;
    timer = setInterval((): void => {
      if (controller === null) return;
      try {
        controller.tick();
      } catch (err) {
        // A solver throw inside the timer would otherwise silently kill stepping.
        teardown();
        postError("tick", err);
      }
    }, 1000 / driveHz);
  };

  scope.onmessage = (ev: { data: unknown }): void => {
    const msg = ev.data as ShellMessage;
    void (async (): Promise<void> => {
      if (msg.type === "init") {
        teardown();
        if (dependencies.createController !== undefined) controller = await dependencies.createController(msg);
        else {
          const rapier = (await import("@dimforge/rapier3d-compat")) as unknown as RapierModule;
          controller = await SimWorkerController.create({
            rapier,
            sab: msg.sab,
            inputBuffer: msg.inputBuffer,
            assets: msg.assets,
            authoringProjectId: msg.authoringProjectId,
          });
        }
        if (msg.commands !== undefined) {
          // ISOLATED: a bad/out-of-band command reports a structured failure instead of throwing and
          // aborting the handshake — the worker still replies `ready` and self-drives.
          postAuthoringFailures("loadWorld", (await controller.loadWorldIsolated(msg.commands)).failures);
        }
        const b = controller.buffers;
        scope.postMessage({ type: "ready", buffer: b.sab, inputBuffer: b.input, status: b.status });
        driveHz = msg.hz ?? 60;
        paused = false;
        startDrive();
      } else if (msg.type === "step") {
        if (controller !== null && !paused) controller.tick();
      } else if (msg.type === "pause") {
        if (controller === null) { rejectControl("pause", msg.requestId, "sim worker is not initialized"); return; }
        // Worker messages and interval callbacks run as serialized tasks. Clearing here and only
        // then acknowledging proves that no later deterministic tick can start while paused.
        if (timer !== undefined) { clearInterval(timer); timer = undefined; }
        paused = true;
        scope.postMessage({ type: "paused", requestId: msg.requestId, tick: controller?.ticks ?? 0 });
      } else if (msg.type === "resume") {
        if (controller === null) { rejectControl("resume", msg.requestId, "sim worker is not initialized"); return; }
        paused = false;
        startDrive();
        scope.postMessage({ type: "resumed", requestId: msg.requestId, tick: controller?.ticks ?? 0 });
      } else if (msg.type === "applyCommands") {
        if (controller !== null && msg.commands !== undefined) {
          postAuthoringFailures("applyCommands", (await controller.loadWorldIsolated(msg.commands)).failures);
        }
      } else if (msg.type === "streamTileColliders") {
        if (controller !== null) controller.applyStreamTileColliders(msg.add ?? [], msg.remove ?? []);
      } else if (msg.type === "stageDerivedRevision" || msg.type === "commitDerivedRevision" || msg.type === "discardDerivedRevision") {
        const operation = msg.type === "stageDerivedRevision" ? "stage" : msg.type === "commitDerivedRevision" ? "commit" : "discard";
        try {
          if (controller === null) throw derivedError("SIM_NOT_INITIALIZED", "sim worker is not initialized");
          const derived = parseDerivedRevisionShellMessage(msg);
          if (derived.type === "stageDerivedRevision") {
            const result = controller.stageDerivedRevision(derived.requestId, derived.manifestHash, derived.snapshot);
            scope.postMessage({ type: "derivedRevisionStaged", ...result });
          } else if (derived.type === "commitDerivedRevision") {
            const result = controller.commitDerivedRevision(derived.requestId, derived.stagedRequestId, derived.manifestHash);
            scope.postMessage({ type: "derivedRevisionCommitted", ...result });
          } else {
            const result = controller.discardDerivedRevision(derived.requestId, derived.stagedRequestId, derived.manifestHash);
            scope.postMessage({ type: "derivedRevisionDiscarded", ...result });
          }
        } catch (error) {
          rejectDerived(operation, msg, error);
        }
      } else if (msg.type === "stop") {
        teardown();
      }
    })().catch((err) => postError((msg as { type?: string } | null)?.type ?? "message", err));
  };
}

// Auto-install ONLY inside a real dedicated Worker (WorkerGlobalScope present and
// `self` is an instance of it). The short-circuit guards keep this inert — and
// crucially side-effect-free — at plain import / on the native host (no Worker
// global), so the portability guard + headless tests are unaffected.
declare const WorkerGlobalScope: { prototype: unknown } | undefined;
if (
  typeof WorkerGlobalScope !== "undefined" &&
  typeof self !== "undefined" &&
  (self as unknown) instanceof (WorkerGlobalScope as unknown as { prototype: unknown } & (new () => unknown))
) {
  installSimWorker(self as unknown as WorkerScopeLike);
}
