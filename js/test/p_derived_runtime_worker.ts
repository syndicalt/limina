import { ops } from "../src/engine.ts";
import { createTerrainGridSpec, terrainChunkId } from "../src/terrain/grid.mjs";
import {
  DERIVED_REVISION_MANIFEST_SCHEMA_V2,
  compilerContentHash,
  createDerivedRevisionManifest,
  derivedArtifactContentHash,
} from "../src/world/compiler/index.mjs";
import {
  TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE,
  encodeTerrainChunkArtifact,
} from "../src/world/compiler/terrain-artifact.mjs";
import {
  HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_FIELD_ARTIFACT_TYPE,
  encodeHydrologyFieldArtifact,
} from "../src/world/hydrology-artifact.mjs";
import { createHydrologyTopology } from "../src/world/hydrology-topology.mjs";
import {
  HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_WATER_ARTIFACT_TYPE,
  encodeHydrologyWaterArtifact,
} from "../src/world/hydrology-water-artifact.mjs";
import { HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA } from "../src/world/hydrology-water-topology.mjs";
import {
  DERIVED_RUNTIME_POLL_DELAYS_MS,
  DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA,
  DERIVED_RUNTIME_WORKER_SCHEMA,
  DerivedRuntimeWorkerController,
  parseDerivedRuntimeWorkerInput,
} from "../src/browser/derived-runtime-worker.ts";
import { DERIVED_TERRAIN_RESIDENCY_SCHEMA } from "../src/browser/derived-terrain-residency.ts";
import type { DerivedRuntimeCurrent } from "../src/browser/derived-runtime-transport.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_derived_runtime_worker FAIL: ${message}`);
}

function rejectsSync(callback: () => unknown, pattern: RegExp, message: string): void {
  let failure: unknown;
  try { callback(); } catch (error) { failure = error; }
  assert(failure instanceof Error && pattern.test(failure.message), `${message}: ${failure instanceof Error ? failure.message : "did not reject"}`);
}

function hash(label: string): string { return compilerContentHash({ label }); }

class TestTimers {
  readonly entries: Array<{ callback: () => void; delayMs: number; active: boolean }> = [];

  setTimeout(callback: () => void, delayMs: number): unknown {
    const entry = { callback, delayMs, active: true };
    this.entries.push(entry);
    return entry;
  }

  clearTimeout(handle: unknown): void {
    (handle as { active: boolean }).active = false;
  }

  runNext(delayMs?: number): void {
    const entry = this.entries.find((candidate) => candidate.active && (delayMs === undefined || candidate.delayMs === delayMs));
    assert(entry !== undefined, `no active timer${delayMs === undefined ? "" : ` at ${delayMs}ms`}`);
    entry.active = false;
    entry.callback();
  }

  activeCount(): number { return this.entries.filter((entry) => entry.active).length; }
}

async function eventually(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`p_derived_runtime_worker FAIL: timed out waiting for ${label}`);
}

const grid = createTerrainGridSpec({ gridId: "grey-field.surface", origin: [0, 0], chunkSizeM: 64, defaultSamples: 3 });
const graphHash = hash("hydrology-graph");
const terrainBytes = encodeTerrainChunkArtifact({
  nrows: 2,
  ncols: 2,
  origin: [0, 0, 0],
  scale: [64, 10, 64],
  heights: new Float32Array([0, 0.25, 0.5, 1]),
});
const terrainDescriptor = Object.freeze({
  artifactType: "terrain-chunk/v1",
  contentHash: derivedArtifactContentHash(terrainBytes),
  byteLength: terrainBytes.byteLength,
  mediaType: TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE,
});
const hydrology = createHydrologyTopology({
  rows: 2,
  cols: 2,
  heightsM: new Float64Array([1, 2, 3, 4]),
  cellSizeM: 1,
  seaLevelM: -1,
  precipitationMmPerYear: 500,
});
const fieldBytes = encodeHydrologyFieldArtifact(hydrology, { originX: 0, originZ: 0 });
const fieldDescriptor = Object.freeze({
  artifactType: HYDROLOGY_FIELD_ARTIFACT_TYPE,
  contentHash: derivedArtifactContentHash(fieldBytes),
  byteLength: fieldBytes.byteLength,
  mediaType: HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE,
});
const bindings = Object.freeze({
  hydrologyFieldContentHash: fieldDescriptor.contentHash,
  recipeHash: hash("recipe"),
  erosionStageKey: hash("erosion"),
  compilerGraphHash: graphHash,
});
const waterBytes = encodeHydrologyWaterArtifact({
  schema: HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA,
  version: 1,
  placement: { originX: 0, originZ: 0 },
  rows: 2,
  cols: 2,
  cellSizeM: 1,
  basins: [],
  reaches: [],
  diagnostics: {},
}, bindings);
const waterDescriptor = Object.freeze({
  artifactType: HYDROLOGY_WATER_ARTIFACT_TYPE,
  contentHash: derivedArtifactContentHash(waterBytes),
  byteLength: waterBytes.byteLength,
  mediaType: HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
});

function manifest(revision: number, options: { globals?: boolean; terrain?: Uint8Array; graphHash?: string } = {}) {
  const terrain = options.terrain ?? terrainBytes;
  const descriptor = terrain === terrainBytes ? terrainDescriptor : {
    ...terrainDescriptor,
    contentHash: derivedArtifactContentHash(terrain),
    byteLength: terrain.byteLength,
  };
  return createDerivedRevisionManifest({
    schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2,
    projectId: "grey-field",
    branchId: "main",
    source: {
      revision,
      headHash: hash(`head-${revision}`),
      contentRefs: [{
        refId: "map-document",
        refType: "map-document/v1",
        scope: "global",
        assetId: "maps/grey-field.worldmap.json",
        contentHash: hash(`map-${revision}`),
      }],
    },
    compiler: {
      version: "1.2.0",
      configHash: hash("config"),
      graphHash: options.graphHash ?? graphHash,
      snapshotHash: hash(`snapshot-${revision}`),
    },
    grid,
    globalArtifacts: options.globals ? [fieldDescriptor, waterDescriptor] : [],
    chunks: [{
      chunkId: terrainChunkId(grid.gridId, 0, 0, 0),
      gridId: grid.gridId,
      lod: 0,
      tx: 0,
      tz: 0,
      topologyHash: hash("stable-topology"),
      sourceSliceHashes: [],
      artifacts: [descriptor],
    }],
  });
}

function largeManifest(revision: number) {
  const artifacts = new Map<string, Uint8Array>();
  const chunks = [];
  for (let tz = -10; tz < 10; tz++) {
    for (let tx = -10; tx < 10; tx++) {
      const bytes = encodeTerrainChunkArtifact({
        nrows: 2,
        ncols: 2,
        origin: [tx * grid.chunkSizeM, 0, tz * grid.chunkSizeM],
        scale: [grid.chunkSizeM, 10, grid.chunkSizeM],
        heights: new Float32Array([0, 0.25, 0.5, 1]),
      });
      const descriptor = Object.freeze({
        artifactType: "terrain-chunk/v1",
        contentHash: derivedArtifactContentHash(bytes),
        byteLength: bytes.byteLength,
        mediaType: TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE,
      });
      artifacts.set(descriptor.contentHash, bytes);
      chunks.push({
        chunkId: terrainChunkId(grid.gridId, 0, tx, tz),
        gridId: grid.gridId,
        lod: 0,
        tx,
        tz,
        topologyHash: hash(`large-topology-${tx}-${tz}`),
        sourceSliceHashes: [],
        artifacts: [descriptor],
      });
    }
  }
  chunks.sort((left, right) => left.chunkId < right.chunkId ? -1 : left.chunkId > right.chunkId ? 1 : 0);
  return {
    artifacts,
    manifest: createDerivedRevisionManifest({
      schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2,
      projectId: "grey-field",
      branchId: "main",
      source: {
        revision,
        headHash: hash(`head-${revision}`),
        contentRefs: [{
          refId: "map-document",
          refType: "map-document/v1",
          scope: "global",
          assetId: "maps/grey-field.worldmap.json",
          contentHash: hash(`map-${revision}`),
        }],
      },
      compiler: {
        version: "1.2.0",
        configHash: hash("config"),
        graphHash,
        snapshotHash: hash(`snapshot-${revision}`),
      },
      grid,
      globalArtifacts: [fieldDescriptor, waterDescriptor],
      chunks,
    }),
  };
}

function current(manifestValue: ReturnType<typeof manifest>, generation = 1): DerivedRuntimeCurrent {
  return Object.freeze({
    schema: "limina.derived-runtime-current/v1",
    projectId: manifestValue.projectId,
    branchId: manifestValue.branchId,
    generation,
    source: manifestValue.source,
    manifest: manifestValue,
    manifestHash: manifestValue.manifestHash,
    etag: `"${manifestValue.manifestHash}"`,
  }) as DerivedRuntimeCurrent;
}

class FakeTransport {
  current: DerivedRuntimeCurrent;
  readonly artifacts = new Map<string, Uint8Array>();
  readonly artifactOrder: string[] = [];
  fetchCurrentCount = 0;
  currentHook: ((previous: DerivedRuntimeCurrent | undefined, signal: AbortSignal | undefined) => Promise<DerivedRuntimeCurrent> | DerivedRuntimeCurrent) | null = null;
  artifactHook: ((descriptor: typeof terrainDescriptor, signal: AbortSignal | undefined) => Promise<void> | void) | null = null;

  constructor(initial: DerivedRuntimeCurrent) {
    this.current = initial;
    this.artifacts.set(terrainDescriptor.contentHash, terrainBytes);
    this.artifacts.set(fieldDescriptor.contentHash, fieldBytes);
    this.artifacts.set(waterDescriptor.contentHash, waterBytes);
  }

  async fetchCurrent(options: { previous?: DerivedRuntimeCurrent; signal?: AbortSignal } = {}) {
    this.fetchCurrentCount++;
    const value = this.currentHook === null ? this.current : await this.currentHook(options.previous, options.signal);
    return Object.freeze({ status: options.previous?.manifestHash === value.manifestHash ? "not-modified" as const : "current" as const, current: value });
  }

  async fetchArtifact(_publication: DerivedRuntimeCurrent, descriptor: typeof terrainDescriptor, options: { signal?: AbortSignal } = {}) {
    if (options.signal?.aborted) throw options.signal.reason;
    this.artifactOrder.push(descriptor.artifactType);
    await this.artifactHook?.(descriptor, options.signal);
    if (options.signal?.aborted) throw options.signal.reason;
    const bytes = this.artifacts.get(descriptor.contentHash);
    if (bytes === undefined) throw new Error(`missing artifact ${descriptor.contentHash}`);
    return Object.freeze({ status: "artifact" as const, contentHash: descriptor.contentHash, bytes });
  }
}

type Posted = { message: Record<string, unknown>; transferCount: number };

function harness(initial: DerivedRuntimeCurrent, ackTimeoutMs = 1_000) {
  const timers = new TestTimers();
  const transport = new FakeTransport(initial);
  const posted: Posted[] = [];
  const controller = new DerivedRuntimeWorkerController({
    createTransport: () => transport,
    timers,
    activationAckTimeoutMs: ackTimeoutMs,
    postMessage: (message, transfers = []) => {
      const clone = typeof globalThis.structuredClone === "function"
        ? globalThis.structuredClone(message, { transfer: transfers })
        : message;
      posted.push({ message: clone as Record<string, unknown>, transferCount: transfers.length });
    },
  });
  const init = (mode: "watch" | "pinned" = "watch", pinnedSource?: { revision: number; headHash: string; manifestHash?: string }) => controller.handleMessage({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "init",
    requestId: "init-1",
    config: { baseUrl: "http://127.0.0.1:43127", token: "A".repeat(43), projectId: "grey-field", branchId: "main" },
    mode,
    residency: { schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA, center: [0, 0], lod: 0, radius: 7 },
    ...(pinnedSource === undefined ? {} : { pinnedSource }),
  });
  return { timers, transport, posted, controller, init };
}

function setResidency(state: ReturnType<typeof harness>, requestId: string, center: readonly [number, number], radius = 7): Promise<void> {
  return state.controller.handleMessage({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "set-residency",
    requestId,
    residency: { schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA, center, lod: 0, radius },
  });
}

function reconcileResidency(state: ReturnType<typeof harness>, requestId: string, center: readonly [number, number], radius = 7): Promise<void> {
  return state.controller.handleMessage({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "reconcile-residency",
    requestId,
    residency: { schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA, center, lod: 0, radius },
  });
}

function messages(state: ReturnType<typeof harness>, type: string): Record<string, unknown>[] {
  return state.posted.map((entry) => entry.message).filter((entry) => entry.type === type);
}

async function acknowledgeLatest(state: ReturnType<typeof harness>, accepted = true): Promise<void> {
  await eventually(() => messages(state, "activate").length > messages(state, "revision").length || messages(state, "error").length > 0, "activation message");
  assert(messages(state, "activate").length > messages(state, "revision").length,
    `activation failed before acknowledgement: ${JSON.stringify(messages(state, "error").at(-1))}`);
  const activation = messages(state, "activate").at(-1)!;
  await state.controller.handleMessage({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "activation-ack",
    activationId: activation.activationId,
    ...(activation.requestId === undefined ? {} : { requestId: activation.requestId }),
    accepted,
    ...(accepted ? {} : { errorCode: "VIEWPORT_SWAP_FAILED" }),
  });
}

// Exact schemas reject ambiguity before any secret-bearing config can escape.
rejectsSync(() => parseDerivedRuntimeWorkerInput({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "init", requestId: "x",
  config: { baseUrl: "http://127.0.0.1:1", token: "A".repeat(43), projectId: "grey-field", branchId: "main", extra: true }, mode: "watch",
  residency: { schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA, center: [0, 0], lod: 0, radius: 7 } }),
/unsupported or missing/, "init accepted an extra config field");
rejectsSync(() => parseDerivedRuntimeWorkerInput({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "init", requestId: "x",
  config: { baseUrl: "http://127.0.0.1:1", token: "A".repeat(43), projectId: "grey-field", branchId: "main" }, mode: "watch",
  residency: { schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA, center: [0, 0], lod: 0, radius: 7 },
  pinnedSource: { revision: 1, headHash: hash("head-1") } }), /forbids/, "watch accepted a pinned source");
rejectsSync(() => parseDerivedRuntimeWorkerInput({
  schema: DERIVED_RUNTIME_WORKER_SCHEMA,
  type: "set-residency",
  requestId: "residency-1",
  residency: { schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA, center: [0, 0], lod: 0, radius: 8 },
}), /residency is invalid/, "set-residency accepted an out-of-bounds radius");
{
  let invoked = false;
  const hostile = {
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "reconcile-residency",
    requestId: "reconcile-accessor",
  } as Record<string, unknown>;
  Object.defineProperty(hostile, "residency", {
    enumerable: true,
    get() { invoked = true; return { schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA, center: [0, 0], lod: 0, radius: 7 }; },
  });
  rejectsSync(() => parseDerivedRuntimeWorkerInput(hostile), /enumerable data field/, "reconcile-residency accepted an accessor");
  assert(!invoked, "reconcile-residency parser invoked an untrusted accessor");
}

// Watch mode activates current, polls deterministically, reuses worker-owned buffers, and keeps credentials out of output.
{
  const firstManifest = manifest(1);
  const secondManifest = manifest(2);
  const state = harness(current(firstManifest));
  await state.init();
  assert(messages(state, "ready").length === 1 && state.timers.activeCount() === 1, "watch init did not become ready with one poll");
  state.timers.runNext(0);
  await acknowledgeLatest(state);
  await eventually(() => messages(state, "revision").length === 1, "first revision outcome");
  const firstActivation = messages(state, "activate")[0];
  const firstSnapshot = firstActivation.snapshot as { schema: string; chunks: Array<{ resource: { decoded: { tile: { heights: Float32Array } } } }> };
  assert(firstSnapshot.schema === DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA && firstSnapshot.chunks[0].resource.decoded.tile.heights.length === 4,
    "activation snapshot was incomplete");
  assert(state.posted.find((entry) => entry.message === firstActivation)!.transferCount > 0, "activation did not transfer copied typed-array buffers");
  assert(!JSON.stringify(state.posted).includes("A".repeat(43)), "worker output leaked the bearer token");
  assert(state.timers.entries.some((entry) => entry.active && entry.delayMs === DERIVED_RUNTIME_POLL_DELAYS_MS[0]), "watch did not schedule its deterministic base poll");

  const fetchesBeforeUnchanged = state.transport.fetchCurrentCount;
  state.timers.runNext(DERIVED_RUNTIME_POLL_DELAYS_MS[0]);
  await eventually(() => messages(state, "revision").length === 2, "unchanged revision outcome");
  assert(messages(state, "activate").length === 1 && state.transport.fetchCurrentCount === fetchesBeforeUnchanged + 1,
    "unchanged watch poll re-entered activation or duplicated authority I/O");

  state.transport.current = current(secondManifest, 2);
  state.timers.runNext(DERIVED_RUNTIME_POLL_DELAYS_MS[0]);
  await eventually(() => messages(state, "activate").length === 2, "second activation message");
  await state.controller.handleMessage({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "activation-ack",
    activationId: messages(state, "activate")[1].activationId,
    accepted: true,
  });
  await eventually(() => messages(state, "revision").length === 3, "second revision outcome");
  const secondSnapshot = (messages(state, "activate")[1].snapshot as { chunks: Array<{ resource: { decoded: { tile: { heights: Float32Array } } } }> });
  assert(secondSnapshot.chunks[0].resource.decoded.tile.heights.length === 4,
    "first activation detached a worker-owned buffer needed for unchanged-resource reuse");
  await state.controller.close("close-watch");
  assert(state.timers.activeCount() === 0, "watch retained a timer after close");
}

// Pinned mode rejects another source and does not retry a fatal mismatch.
{
  const published = current(manifest(3));
  const state = harness(published);
  await state.init("pinned", { revision: 2, headHash: hash("head-2") });
  state.timers.runNext(0);
  await eventually(() => messages(state, "error").length === 1, "pinned mismatch error");
  assert(messages(state, "error")[0].code === "PINNED_SOURCE_MISMATCH" && state.timers.activeCount() === 0,
    "pinned mismatch was not fatal/stopped");
  await state.controller.close("close-pinned-mismatch");
}

// A matching pin activates once and stops polling permanently.
{
  const publication = current(manifest(4));
  const state = harness(publication);
  await state.init("pinned", { revision: publication.source.revision, headHash: publication.source.headHash });
  state.timers.runNext(0);
  await acknowledgeLatest(state);
  await eventually(() => messages(state, "revision").length === 1, "pinned activation");
  assert(state.timers.activeCount() === 0, "matching pinned mode continued polling after activation");
  await state.controller.close("close-pinned");
}

// A changed residency is acknowledged only after an older in-flight submission can no longer
// activate, then a 304 publication still submits the same manifest with the captured new window.
{
  const large = largeManifest(41);
  const state = harness(current(large.manifest));
  for (const [contentHash, bytes] of large.artifacts) state.transport.artifacts.set(contentHash, bytes);
  let releaseArtifact: (() => void) | undefined;
  let delayed = false;
  state.transport.artifactHook = (_descriptor, signal) => {
    if (delayed) return;
    delayed = true;
    return new Promise<void>((resolve, reject) => {
      releaseArtifact = resolve;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  await state.init();
  state.timers.runNext(0);
  await eventually(() => releaseArtifact !== undefined, "delayed initial artifact load");
  await setResidency(state, "residency-during-load", [192, 0]);
  assert(messages(state, "residency-ack").length === 0, "residency was acknowledged while an older load could still activate");
  releaseArtifact!();
  await acknowledgeLatest(state);
  await eventually(() => messages(state, "residency-ack").length === 1, "serialized residency acknowledgement");
  assert(messages(state, "revision").length === 1, "older submission did not finish before residency acknowledgement");
  const oldActivation = messages(state, "activate")[0].snapshot as { residency: { center: readonly number[] } };
  assert(oldActivation.residency.center[0] === 0, "in-flight activation observed a mutable residency");
  state.timers.runNext(0);
  await eventually(() => messages(state, "activate").length === 2, "same-manifest residency activation");
  const nextActivation = messages(state, "activate")[1].snapshot as { residency: { center: readonly number[] }; chunks: unknown[] };
  assert(nextActivation.residency.center[0] === 192 && nextActivation.chunks.length === 210,
    `replacement activation used the wrong captured window (${nextActivation.residency.center[0]}, ${nextActivation.chunks.length})`);
  await state.controller.handleMessage({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "activation-ack",
    activationId: messages(state, "activate")[1].activationId,
    accepted: true,
  });
  await eventually(() => messages(state, "revision").length === 2, "replacement residency revision");
  await state.controller.close("close-residency-during-load");
}

// Pinned mode permits explicit window replacement but never resumes periodic polling and never
// follows a republished manifest, even when its source revision/head are unchanged.
{
  const large = largeManifest(42);
  const publication = current(large.manifest);
  const state = harness(publication);
  for (const [contentHash, bytes] of large.artifacts) state.transport.artifacts.set(contentHash, bytes);
  await state.init("pinned", {
    revision: publication.source.revision,
    headHash: publication.source.headHash,
    manifestHash: publication.manifestHash,
  });
  state.timers.runNext(0);
  await acknowledgeLatest(state);
  await eventually(() => messages(state, "revision").length === 1, "pinned residency baseline");
  assert(state.timers.activeCount() === 0, "pinned baseline retained a periodic timer");

  await setResidency(state, "pinned-residency-1", [192, 0]);
  assert(messages(state, "residency-ack").length === 1 && state.timers.activeCount() === 1,
    "pinned explicit residency was not acknowledged and scheduled exactly once");
  state.timers.runNext(0);
  await eventually(() => messages(state, "activate").length === 2, "pinned explicit activation");
  await state.controller.handleMessage({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "activation-ack",
    activationId: messages(state, "activate")[1].activationId,
    accepted: true,
  });
  await eventually(() => messages(state, "revision").length === 2, "pinned explicit revision");
  assert(state.timers.activeCount() === 0, "pinned explicit activation restarted periodic polling");

  state.transport.current = current(manifest(42, { graphHash: hash("republished-graph") }), 2);
  await setResidency(state, "pinned-residency-2", [-192, 0]);
  state.timers.runNext(0);
  await eventually(() => messages(state, "error").some((entry) => entry.code === "PINNED_MANIFEST_MISMATCH"), "pinned manifest mismatch");
  assert(messages(state, "activate").length === 2 && state.timers.activeCount() === 0,
    "pinned runtime followed another manifest or retried a fatal mismatch");
  await state.controller.close("close-pinned-residency");
}

// A residency update arriving while main-thread activation is awaiting acknowledgement remains
// unacknowledged until that exact older activation has committed or rolled back.
{
  const large = largeManifest(421);
  const state = harness(current(large.manifest));
  for (const [contentHash, bytes] of large.artifacts) state.transport.artifacts.set(contentHash, bytes);
  await state.init();
  state.timers.runNext(0);
  await eventually(() => messages(state, "activate").length === 1, "activation held for residency update");
  await setResidency(state, "residency-during-activation", [-192, 0]);
  assert(messages(state, "residency-ack").length === 0,
    "residency acknowledgement overtook an older activation awaiting main-thread commit");
  await state.controller.handleMessage({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "activation-ack",
    activationId: messages(state, "activate")[0].activationId,
    accepted: true,
  });
  await eventually(() => messages(state, "revision").length === 1 && messages(state, "residency-ack").length === 1,
    "residency acknowledgement after older activation completion");
  const order = state.posted.map(({ message }) => message.type);
  assert(order.indexOf("revision") < order.indexOf("residency-ack"),
    `residency acknowledgement was not serialized after the older revision (${order.join(",")})`);
  state.timers.runNext(0);
  await eventually(() => messages(state, "activate").length === 2, "post-activation residency replacement");
  const replacement = messages(state, "activate")[1].snapshot as { residency: { center: readonly number[] } };
  assert(replacement.residency.center[0] === -192, "replacement activation did not capture the acknowledged residency");
  await state.controller.handleMessage({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "activation-ack",
    activationId: messages(state, "activate")[1].activationId,
    accepted: true,
  });
  await eventually(() => messages(state, "revision").length === 2, "post-activation residency revision");
  await state.controller.close("close-residency-during-activation");
}

// Outside-domain residency preserves the prior live set and does not spin until a new residency arrives.
{
  const state = harness(current(manifest(43)));
  await state.init();
  state.timers.runNext(0);
  await acknowledgeLatest(state);
  await eventually(() => messages(state, "revision").length === 1, "outside-domain baseline");
  await setResidency(state, "outside-domain", [100_000, 100_000]);
  state.timers.runNext(0);
  await eventually(() => messages(state, "error").some((entry) => entry.code === "RESIDENCY_OUTSIDE_DOMAIN"), "outside-domain status");
  assert(messages(state, "activate").length === 1 && state.timers.activeCount() === 0,
    "outside-domain residency replaced the live set or entered a retry loop");
  await setResidency(state, "return-domain", [0, 0]);
  assert(state.timers.activeCount() === 1, "a new valid residency did not restart reconciliation");
  state.timers.runNext(0);
  await eventually(() => messages(state, "revision").length === 2, "return-domain unchanged revision");
  assert(messages(state, "activate").length === 1, "returning to the already-live residency reactivated resources");
  await state.controller.close("close-outside-domain");
}

// Explicit reconciliation carries one request id through activation and revision, resolves unchanged
// without activation, retains correlation across transient activation retry, and terminates outside-domain.
{
  const large = largeManifest(44);
  const state = harness(current(large.manifest));
  for (const [contentHash, bytes] of large.artifacts) state.transport.artifacts.set(contentHash, bytes);
  await state.init();
  state.timers.runNext(0);
  await acknowledgeLatest(state);
  await eventually(() => messages(state, "revision").length === 1, "reconciliation baseline");

  await reconcileResidency(state, "reconcile-changed", [192, 0]);
  assert(messages(state, "residency-ack").length === 0, "explicit reconciliation emitted a set-residency acknowledgement");
  state.timers.runNext(0);
  await eventually(() => messages(state, "activate").length === 2, "correlated reconciliation activation");
  const changedActivation = messages(state, "activate").at(-1)!;
  assert(changedActivation.requestId === "reconcile-changed", "activation lost its reconciliation request id");
  assert(!messages(state, "revision").some((message) => message.requestId === "reconcile-changed"),
    "reconciliation completed before main-thread activation acknowledgement");
  await state.controller.handleMessage({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "activation-ack",
    activationId: changedActivation.activationId,
    requestId: changedActivation.requestId,
    accepted: true,
  });
  await eventually(() => messages(state, "revision").some((message) => message.requestId === "reconcile-changed"), "correlated reconciliation revision");
  const changedRevision = messages(state, "revision").find((message) => message.requestId === "reconcile-changed")!;
  assert(changedRevision.status === "activated" && changedRevision.manifestHash === large.manifest.manifestHash,
    "correlated reconciliation returned the wrong activated revision");

  const activationCount = messages(state, "activate").length;
  await reconcileResidency(state, "reconcile-unchanged", [192, 0]);
  state.timers.runNext(0);
  await eventually(() => messages(state, "revision").some((message) => message.requestId === "reconcile-unchanged"), "correlated unchanged reconciliation");
  const unchanged = messages(state, "revision").find((message) => message.requestId === "reconcile-unchanged")!;
  assert(unchanged.status === "unchanged" && messages(state, "activate").length === activationCount,
    "unchanged reconciliation activated resources or returned the wrong status");

  await reconcileResidency(state, "reconcile-retry", [-192, 0]);
  state.timers.runNext(0);
  await eventually(() => messages(state, "activate").some((message) => message.requestId === "reconcile-retry"), "retry reconciliation activation");
  const rejected = messages(state, "activate").find((message) => message.requestId === "reconcile-retry")!;
  await state.controller.handleMessage({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "activation-ack",
    activationId: rejected.activationId,
    requestId: rejected.requestId,
    accepted: false,
    errorCode: "VIEWPORT_SWAP_FAILED",
  });
  await eventually(() => messages(state, "error").some((message) => message.requestId === "reconcile-retry"), "correlated transient reconciliation error");
  const retryError = messages(state, "error").find((message) => message.requestId === "reconcile-retry")!;
  assert(retryError.code === "ACTIVATION_REJECTED" && retryError.classification === "transient",
    "activation rejection lost transient reconciliation semantics");
  state.timers.runNext(DERIVED_RUNTIME_POLL_DELAYS_MS[0]);
  await eventually(() => messages(state, "activate").filter((message) => message.requestId === "reconcile-retry").length === 2,
    "correlated reconciliation retry activation");
  const retried = messages(state, "activate").filter((message) => message.requestId === "reconcile-retry").at(-1)!;
  await state.controller.handleMessage({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "activation-ack",
    activationId: retried.activationId,
    requestId: retried.requestId,
    accepted: true,
  });
  await eventually(() => messages(state, "revision").some((message) => message.requestId === "reconcile-retry"), "correlated reconciliation retry revision");

  await reconcileResidency(state, "reconcile-outside", [100_000, 100_000]);
  state.timers.runNext(0);
  await eventually(() => messages(state, "error").some((message) => message.requestId === "reconcile-outside"), "correlated outside-domain reconciliation");
  const outside = messages(state, "error").find((message) => message.requestId === "reconcile-outside")!;
  assert(outside.code === "RESIDENCY_OUTSIDE_DOMAIN" && state.timers.activeCount() === 0,
    "outside-domain reconciliation lost correlation or entered a retry loop");
  await state.controller.close("close-reconciliation");
}

// Changing authority between discovery and manager validation rejects stale work, then retries at the base bound.
{
  const stale = current(manifest(5));
  const fresh = current(manifest(6), 2);
  const state = harness(stale);
  let call = 0;
  state.transport.currentHook = () => (++call === 1 ? stale : fresh);
  await state.init();
  state.timers.runNext(0);
  await eventually(() => messages(state, "error").length === 1, "stale authority error");
  assert(messages(state, "error")[0].code === "STALE_SOURCE_HEAD"
    && state.timers.entries.some((entry) => entry.active && entry.delayMs === DERIVED_RUNTIME_POLL_DELAYS_MS[0]),
  "stale publication did not fail closed and schedule a bounded retry");
  await state.controller.close("close-stale");
}

// Duplicate timer delivery is coalesced while one request is in flight; close aborts it and leaves no timer.
{
  const state = harness(current(manifest(7)));
  let release: (() => void) | undefined;
  state.transport.currentHook = (_previous, signal) => new Promise((resolve, reject) => {
    release = () => resolve(state.transport.current);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  await state.init();
  const timer = state.timers.entries.find((entry) => entry.delayMs === 0)!;
  timer.active = false;
  timer.callback();
  timer.callback();
  await eventually(() => state.transport.fetchCurrentCount === 1, "one coalesced fetch");
  assert(state.transport.fetchCurrentCount === 1, "duplicate poll delivery started concurrent fetches");
  await state.controller.close("close-cancel");
  release?.();
  assert(state.timers.activeCount() === 0 && messages(state, "closed").length === 1, "close did not cancel polling cleanly");
}

// Closing during a correlated activation cancels the exact reconciliation without a false ready revision.
{
  const large = largeManifest(71);
  const state = harness(current(large.manifest));
  for (const [contentHash, bytes] of large.artifacts) state.transport.artifacts.set(contentHash, bytes);
  await state.init();
  state.timers.runNext(0);
  await acknowledgeLatest(state);
  await eventually(() => messages(state, "revision").length === 1, "correlated close baseline");
  await reconcileResidency(state, "reconcile-close", [192, 0]);
  state.timers.runNext(0);
  await eventually(() => messages(state, "activate").some((message) => message.requestId === "reconcile-close"), "correlated activation before close");
  await state.controller.close("close-correlated-activation");
  assert(!messages(state, "revision").some((message) => message.requestId === "reconcile-close"),
    "close published a false correlated ready revision");
  assert(messages(state, "closed").at(-1)?.requestId === "close-correlated-activation" && state.timers.activeCount() === 0,
    "close did not cancel correlated activation cleanly");
}

// Global staging is dependency ordered and water activation carries the verified generated topology.
{
  const state = harness(current(manifest(8, { globals: true })));
  await state.init();
  state.timers.runNext(0);
  await acknowledgeLatest(state);
  await eventually(() => messages(state, "revision").length === 1, "global activation");
  assert(state.transport.artifactOrder.join(",") === `${HYDROLOGY_FIELD_ARTIFACT_TYPE},${HYDROLOGY_WATER_ARTIFACT_TYPE},terrain-chunk/v1`,
    `global dependency staging order changed (${state.transport.artifactOrder.join(",")})`);
  const snapshot = messages(state, "activate")[0].snapshot as {
    globals: Array<{ resource: { kind: string; bytes?: Uint8Array; artifact?: { contentHash: string } } }>;
  };
  assert(snapshot.globals.map((entry) => entry.resource.kind).join(",") === "hydrology-field/v1,hydrology-water-topology/v1",
    "complete global resource snapshot changed dependency order or omitted water");
  const transferredWater = snapshot.globals[1].resource;
  assert(transferredWater.bytes instanceof Uint8Array && transferredWater.bytes.byteLength === waterBytes.byteLength
    && transferredWater.artifact?.contentHash === waterDescriptor.contentHash,
  "activation omitted canonical water bytes needed for independent simulation verification");
  await state.controller.close("close-globals");
}

// A large publication retains full manifest identity while fetching and transferring only the
// exact radius-7 terrain window plus complete global artifacts.
{
  const large = largeManifest(81);
  const state = harness(current(large.manifest));
  for (const [contentHash, bytes] of large.artifacts) state.transport.artifacts.set(contentHash, bytes);
  await state.init();
  state.timers.runNext(0);
  await acknowledgeLatest(state);
  await eventually(() => messages(state, "revision").length === 1, "large bounded activation");
  const activation = messages(state, "activate")[0];
  const snapshot = activation.snapshot as {
    manifest: { chunks: unknown[] };
    chunks: unknown[];
    globals: unknown[];
  };
  assert(snapshot.manifest.chunks.length === 400, "worker truncated full manifest revision identity");
  assert(snapshot.chunks.length === 225, `worker transferred ${snapshot.chunks.length} chunks instead of the exact 225 window`);
  assert(snapshot.globals.length === 2, "worker omitted complete global hydrology resources");
  assert(state.transport.artifactOrder.length === 227,
    `worker fetched ${state.transport.artifactOrder.length} artifacts instead of 225 resident chunks plus 2 globals`);
  assert(state.posted.find((entry) => entry.message === activation)!.transferCount >= 227,
    "worker did not transfer the bounded chunk and global resource buffers");
  await state.controller.close("close-large-bounded");
}

// Decoder failure is fail-closed before activation.
{
  const corrupt = terrainBytes.slice(0, terrainBytes.byteLength - 1);
  const corruptManifest = manifest(9, { terrain: corrupt });
  const state = harness(current(corruptManifest));
  const corruptHash = corruptManifest.chunks[0].artifacts[0].contentHash;
  state.transport.artifacts.set(corruptHash, corrupt);
  await state.init();
  state.timers.runNext(0);
  await eventually(() => messages(state, "error").length === 1, "decode failure");
  assert(messages(state, "activate").length === 0 && messages(state, "error")[0].classification === "fatal",
    "decode failure reached activation or was treated as retryable transport noise");
  await state.controller.close("close-corrupt");
}

// Missing main-thread acknowledgement times out, rolls staging back, and remains retryable.
{
  const state = harness(current(manifest(91)), 100);
  await state.init();
  state.timers.runNext(0);
  await eventually(() => messages(state, "activate").length === 1, "unacknowledged activation");
  state.timers.runNext(100);
  await eventually(() => messages(state, "error").some((entry) => entry.code === "ACTIVATION_ACK_TIMEOUT"), "activation acknowledgement timeout");
  assert(state.timers.entries.some((entry) => entry.active && entry.delayMs === DERIVED_RUNTIME_POLL_DELAYS_MS[0]),
    "activation acknowledgement timeout stopped watch mode instead of retrying");
  await state.controller.close("close-timeout");
}

// Main-thread rejection rolls back manager visibility and retries; the next activation still has intact prior resources.
{
  const first = current(manifest(10));
  const changedTerrain = encodeTerrainChunkArtifact({
    nrows: 2, ncols: 2, origin: [0, 0, 0], scale: [64, 10, 64], heights: new Float32Array([1, 0.5, 0.25, 0]),
  });
  const secondManifest = manifest(11, { terrain: changedTerrain });
  const second = current(secondManifest, 2);
  const state = harness(first);
  state.transport.artifacts.set(derivedArtifactContentHash(changedTerrain), changedTerrain);
  await state.init();
  state.timers.runNext(0);
  await acknowledgeLatest(state);
  await eventually(() => messages(state, "revision").length === 1, "rollback baseline activation");
  state.transport.current = second;
  state.timers.runNext(DERIVED_RUNTIME_POLL_DELAYS_MS[0]);
  await acknowledgeLatest(state, false);
  await eventually(() => messages(state, "error").some((entry) => entry.code === "ACTIVATION_REJECTED"), "activation rejection");
  assert(state.timers.entries.some((entry) => entry.active && entry.delayMs === DERIVED_RUNTIME_POLL_DELAYS_MS[0]),
    "activation rejection did not schedule bounded retry");
  const activationCountBeforeRetry = messages(state, "activate").length;
  state.timers.runNext(DERIVED_RUNTIME_POLL_DELAYS_MS[0]);
  await eventually(() => messages(state, "activate").length > activationCountBeforeRetry, "activation retry request");
  const retryActivation = messages(state, "activate").at(-1)!;
  await state.controller.handleMessage({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "activation-ack",
    activationId: retryActivation.activationId,
    accepted: true,
  });
  await eventually(() => messages(state, "revision").length === 2, "activation retry");
  const retried = messages(state, "activate").at(-1)!.snapshot as { chunks: Array<{ resource: { decoded: { tile: { heights: Float32Array } } } }> };
  assert(retried.chunks[0].resource.decoded.tile.heights.length === 4, "ack rollback leaked or detached staged resources");
  await state.controller.close("close-rollback");
}

const completion = "[js] p_derived_runtime_worker OK: exact secret-safe protocol, deterministic watch/pinned reconciliation, exact correlated jump readiness, serialized dynamic residency acknowledgements, exact pinned manifests, bounded 225-chunk windows, no-spin outside-domain recovery, dependency-ordered off-main decode, acknowledged rollback, and reusable transfer ownership proven.";
if (ops?.op_log === undefined) console.log(completion);
else ops.op_log(completion);
