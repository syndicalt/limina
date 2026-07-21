import {
  DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA,
  DERIVED_RUNTIME_WORKER_SCHEMA,
  DerivedRuntimeWorkerController,
} from "../src/browser/derived-runtime-worker.ts";
import {
  createMemoryDerivedArtifactCache,
  type DerivedArtifactCache,
} from "../src/browser/derived-artifact-cache.ts";
import { DERIVED_TERRAIN_RESIDENCY_SCHEMA, selectDerivedTerrainChunks } from "../src/browser/derived-terrain-residency.ts";
import {
  DetachedDerivedRenderCandidate,
  parseTransferredDerivedRuntimeSnapshot,
} from "../src/browser/derived-runtime-render-candidate.ts";
import {
  DERIVED_SIM_STAGE_SCHEMA,
  SimWorkerController,
  type AuthorCommand,
  type DerivedSimStageSnapshot,
} from "../src/browser/sim-worker.ts";
import type { RapierModule } from "../src/browser/wasm-rapier-physics.ts";
import { createTerrainGridSpec, terrainChunkId } from "../src/terrain/grid.mjs";
import { tileKey } from "../src/terrain/stream.ts";
import { compilerContentHash } from "../src/world/compiler/canonical.mjs";
import {
  DERIVED_REVISION_MANIFEST_SCHEMA_V2,
  createDerivedRevisionManifest,
  derivedArtifactContentHash,
} from "../src/world/compiler/manifest.mjs";
import {
  TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE,
  decodeTerrainChunkArtifact,
  encodeTerrainChunkArtifact,
} from "../src/world/compiler/terrain-artifact.mjs";
import {
  HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_FIELD_ARTIFACT_TYPE,
  decodeHydrologyFieldArtifact,
  encodeHydrologyFieldArtifact,
} from "../src/world/hydrology-artifact.mjs";
import {
  HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_WATER_ARTIFACT_TYPE,
  encodeHydrologyWaterArtifact,
} from "../src/world/hydrology-water-artifact.mjs";
import { HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA } from "../src/world/hydrology-water-topology.mjs";
import { createHydrologyTopology } from "../src/world/hydrology-topology.mjs";
import { prepareGeneratedWaterFieldInput } from "../src/world/water-field.mjs";
import { worldMapContentHash } from "../src/world/worldmap-hash.mjs";
import type { DerivedRuntimeCurrent } from "../src/browser/derived-runtime-transport.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_derived_windowed_fetch FAIL: ${message}`);
}

let rapier: RapierModule | null = null;
try {
  // @ts-ignore native test runner cannot resolve the bare browser specifier.
  rapier = (await import("../node_modules/@dimforge/rapier3d-compat/rapier.mjs")) as unknown as RapierModule;
} catch (error) {
  throw new Error(`p_derived_windowed_fetch FAIL: rapier import failed: ${String(error)}`);
}

// ── Fixture: an 8x8 LOD0 chunk domain (64 chunks) with hydrology water globals.
//    The residency window (radius 1) covers 9 chunks, so every assertion about
//    "only the window" separates 9 fetched chunks from 55 unfetched ones. ──
const hash = (label: string): string => compilerContentHash({ label });
const graphHash = hash("windowed-graph");
const grid = createTerrainGridSpec({ gridId: "windowed-fetch", origin: [0, 0], chunkSizeM: 64, defaultSamples: 3 });
const DOMAIN = 8;
const BASE_URL = "http://127.0.0.1:43127";

function terrain(salt: number, tx: number, tz: number) {
  const heights = new Float32Array(9);
  for (let index = 0; index < 9; index++) heights[index] = ((index + tx * 3 + tz * 7 + salt) % 5) * 0.02;
  const bytes = encodeTerrainChunkArtifact({
    nrows: 3,
    ncols: 3,
    origin: [(tx + 0.5) * 64, 2 + (tx + tz) * 0.5 + salt * 40, (tz + 0.5) * 64],
    scale: [64, 10, 64],
    heights,
  });
  return {
    bytes,
    descriptor: Object.freeze({
      artifactType: "terrain-chunk/v1",
      contentHash: derivedArtifactContentHash(bytes),
      byteLength: bytes.byteLength,
      mediaType: TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE,
    }),
  };
}

const fieldTopology = createHydrologyTopology({
  rows: 2,
  cols: 2,
  heightsM: new Float64Array([1, 2, 3, 4]),
  cellSizeM: 1,
  seaLevelM: -1,
  precipitationMmPerYear: 500,
});
const fieldBytes = encodeHydrologyFieldArtifact(fieldTopology, { originX: 0, originZ: 0 });
const fieldDescriptor = Object.freeze({
  artifactType: HYDROLOGY_FIELD_ARTIFACT_TYPE,
  contentHash: derivedArtifactContentHash(fieldBytes),
  byteLength: fieldBytes.byteLength,
  mediaType: HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE,
});
const waterBindings = Object.freeze({
  hydrologyFieldContentHash: fieldDescriptor.contentHash,
  recipeHash: hash("windowed-recipe"),
  erosionStageKey: hash("windowed-erosion"),
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
}, waterBindings);
const waterDescriptor = Object.freeze({
  artifactType: HYDROLOGY_WATER_ARTIFACT_TYPE,
  contentHash: derivedArtifactContentHash(waterBytes),
  byteLength: waterBytes.byteLength,
  mediaType: HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
});
const preparedWater = prepareGeneratedWaterFieldInput({
  bytes: waterBytes,
  descriptor: waterDescriptor,
  expectedBindings: waterBindings,
});

/** salt=-1 means "every chunk keeps its base bytes"; changedChunks lists [tx,tz,salt] overrides. */
function buildManifest(revision: number, changedChunks: ReadonlyArray<readonly [number, number, number]> = []) {
  const overrides = new Map(changedChunks.map(([tx, tz, salt]) => [`${tx},${tz}`, salt]));
  const artifacts = new Map<string, Uint8Array>([
    [fieldDescriptor.contentHash, fieldBytes],
    [waterDescriptor.contentHash, waterBytes],
  ]);
  const chunks = [];
  for (let tz = 0; tz < DOMAIN; tz++) {
    for (let tx = 0; tx < DOMAIN; tx++) {
      const salt = overrides.get(`${tx},${tz}`) ?? 0;
      const piece = terrain(salt, tx, tz);
      artifacts.set(piece.descriptor.contentHash, piece.bytes);
      chunks.push({
        chunkId: terrainChunkId(grid.gridId, 0, tx, tz),
        gridId: grid.gridId,
        lod: 0,
        tx,
        tz,
        topologyHash: hash(`windowed-topology-${salt}-${tx}-${tz}`),
        sourceSliceHashes: [],
        artifacts: [piece.descriptor],
      });
    }
  }
  chunks.sort((left, right) => (left.chunkId < right.chunkId ? -1 : left.chunkId > right.chunkId ? 1 : 0));
  const manifest = createDerivedRevisionManifest({
    schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2,
    projectId: "windowed-fetch",
    branchId: "main",
    source: {
      revision,
      headHash: hash(`windowed-head-${revision}`),
      contentRefs: [{
        refId: "map-document",
        refType: "map-document/v1",
        scope: "global",
        assetId: "maps/windowed.mapdoc.json",
        contentHash: hash(`windowed-map-${revision}`),
      }],
    },
    compiler: { version: "1.0.0", configHash: hash("windowed-config"), graphHash, snapshotHash: hash(`windowed-snapshot-${revision}`) },
    grid,
    globalArtifacts: [fieldDescriptor, waterDescriptor],
    chunks,
  });
  return { manifest, artifacts };
}

const revision1 = buildManifest(1);
const CHANGED_CHUNK: readonly [number, number] = [4, 3];
const revision2 = buildManifest(2, [[CHANGED_CHUNK[0], CHANGED_CHUNK[1], 1]]);

function currentOf(source: typeof revision1): DerivedRuntimeCurrent {
  return Object.freeze({
    schema: "limina.derived-runtime-current/v1",
    projectId: source.manifest.projectId,
    branchId: source.manifest.branchId,
    generation: 1,
    source: source.manifest.source,
    manifest: source.manifest,
    manifestHash: source.manifest.manifestHash,
    etag: `"${source.manifest.manifestHash}"`,
  }) as DerivedRuntimeCurrent;
}

function residencyAt(tx: number, tz: number, radius = 1) {
  return { schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA, center: [tx * 64 + 32, tz * 64 + 32] as [number, number], lod: 0 as const, radius };
}

const artifactUrl = (manifestHash: string, contentHash: string): string => (
  `${BASE_URL}/v1/derived/manifests/${manifestHash.slice(7)}/artifacts/${contentHash.slice(7)}`
);



class CountingTransport {
  current: DerivedRuntimeCurrent;
  readonly artifacts: Map<string, Uint8Array>;
  readonly fetchUrls: string[] = [];

  constructor(source: typeof revision1) {
    this.current = currentOf(source);
    this.artifacts = source.artifacts;
  }

  async fetchCurrent(options: { previous?: DerivedRuntimeCurrent } = {}) {
    const value = this.current;
    return Object.freeze({
      status: options.previous?.manifestHash === value.manifestHash ? "not-modified" as const : "current" as const,
      current: value,
    });
  }

  async fetchArtifact(publication: DerivedRuntimeCurrent, descriptor: { contentHash: string }, options: { signal?: AbortSignal } = {}) {
    if (options.signal?.aborted) throw options.signal.reason;
    this.fetchUrls.push(artifactUrl(publication.manifestHash, descriptor.contentHash));
    const bytes = this.artifacts.get(descriptor.contentHash);
    if (bytes === undefined) throw new Error(`missing artifact ${descriptor.contentHash}`);
    return Object.freeze({ status: "artifact" as const, contentHash: descriptor.contentHash, bytes });
  }
}

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

  runNext(): void {
    const entry = this.entries.find((candidate) => candidate.active);
    assert(entry !== undefined, "no active timer");
    entry.active = false;
    entry.callback();
  }
}

async function eventually(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`p_derived_windowed_fetch FAIL: timed out waiting for ${label}`);
}

// Same clone-across-the-boundary discipline as p_derived_runtime_worker: the snapshot the
// gate consumes must be the transferred copy, not the worker's retained object graph.
function harness(source: typeof revision1, cache: DerivedArtifactCache | null) {
  const timers = new TestTimers();
  const transport = new CountingTransport(source);
  const posted: Array<Record<string, unknown>> = [];
  const controller = new DerivedRuntimeWorkerController({
    createTransport: () => transport,
    timers,
    activationAckTimeoutMs: 1_000,
    artifactCache: cache,
    postMessage: (message) => {
      posted.push(globalThis.structuredClone(message) as Record<string, unknown>);
    },
  });
  const init = (residency: ReturnType<typeof residencyAt>) => controller.handleMessage({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "init",
    requestId: "init-1",
    config: { baseUrl: BASE_URL, token: "A".repeat(43), projectId: "windowed-fetch", branchId: "main" },
    mode: "watch",
    residency,
  });
  return { timers, transport, posted, controller, init };
}

function messages(state: ReturnType<typeof harness>, type: string): Record<string, unknown>[] {
  return state.posted.filter((entry) => entry.type === type);
}

async function acknowledgeNext(state: ReturnType<typeof harness>, index: number): Promise<Record<string, unknown>> {
  await eventually(() => messages(state, "activate").length > index, `activation ${index + 1}`);
  const activation = messages(state, "activate")[index]!;
  await state.controller.handleMessage({
    schema: DERIVED_RUNTIME_WORKER_SCHEMA,
    type: "activation-ack",
    activationId: activation.activationId,
    ...(activation.requestId === undefined ? {} : { requestId: activation.requestId }),
    accepted: true,
  });
  await eventually(() => messages(state, "revision").length > index, `revision outcome ${index + 1}`);
  return activation;
}

function windowChunkHashes(source: typeof revision1, residency: ReturnType<typeof residencyAt>): string[] {
  return selectDerivedTerrainChunks(source.manifest, residency).map((chunk) => chunk.artifacts[0]!.contentHash);
}

function fetchProgressEvents(state: ReturnType<typeof harness>): Array<{ fetched: number; total: number }> {
  return messages(state, "fetch-progress") as unknown as Array<{ fetched: number; total: number }>;
}

function assertProgressContract(events: Array<{ fetched: number; total: number }>, expectedTotal: number, label: string): void {
  assert(events.length === expectedTotal + 1, `${label}: expected ${expectedTotal + 1} fetch events, got ${events.length}`);
  assert(events[0]!.fetched === 0 && events[0]!.total === expectedTotal, `${label}: progress does not start at (0, ${expectedTotal})`);
  for (let index = 1; index < events.length; index++) {
    assert(events[index]!.fetched === events[index - 1]!.fetched + 1, `${label}: fetched is not monotonically increasing at event ${index}`);
    assert(events[index]!.fetched <= events[index]!.total, `${label}: fetched exceeds total at event ${index}`);
  }
  assert(events.at(-1)!.fetched === expectedTotal && events.at(-1)!.total === expectedTotal, `${label}: progress does not end at total`);
}

// ═══ (a)+(e) Cold activation fetches ONLY the window + required globals, with progress. ═══
const INITIAL = residencyAt(3, 3);
const cache = createMemoryDerivedArtifactCache(derivedArtifactContentHash);
const cold = harness(revision1, cache);
await cold.init(INITIAL);
await eventually(() => messages(cold, "ready").length === 1, "worker ready");
cold.timers.runNext();
const firstActivation = await acknowledgeNext(cold, 0);

const expectedColdUrls = new Set([
  ...windowChunkHashes(revision1, INITIAL).map((contentHash) => artifactUrl(revision1.manifest.manifestHash, contentHash)),
  artifactUrl(revision1.manifest.manifestHash, fieldDescriptor.contentHash),
  artifactUrl(revision1.manifest.manifestHash, waterDescriptor.contentHash),
]);
assert(cold.transport.fetchUrls.length === expectedColdUrls.size,
  `cold activation fetched ${cold.transport.fetchUrls.length} artifacts, expected ${expectedColdUrls.size} (9 window + 2 globals)`);
assert(new Set(cold.transport.fetchUrls).size === cold.transport.fetchUrls.length, "cold activation fetched an artifact twice");
for (const url of cold.transport.fetchUrls) assert(expectedColdUrls.has(url), `cold activation fetched outside the window: ${url}`);
const outsideChunk = terrain(0, 0, 0);
assert(!windowChunkHashes(revision1, INITIAL).includes(outsideChunk.descriptor.contentHash), "fixture: outside chunk must not be in the window");
assert(!cold.transport.fetchUrls.includes(artifactUrl(revision1.manifest.manifestHash, outsideChunk.descriptor.contentHash)),
  "cold activation fetched a chunk outside the residency window");
assertProgressContract(fetchProgressEvents(cold), 11, "cold activation");

// ═══ (b) Windowed mount is byte-identical to the eager reference mount. ═══
{
  const windowedSnapshot = (firstActivation.snapshot as { schema: string });
  assert(windowedSnapshot.schema === DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA, "activation did not carry a resource snapshot");
  // Eager reference: the same window assembled straight from fixture bytes (the pre-windowing
  // path's output shape), verified through the same trust boundary.
  const eagerSnapshot = {
    schema: DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA,
    projectId: revision1.manifest.projectId,
    branchId: revision1.manifest.branchId,
    manifestHash: revision1.manifest.manifestHash,
    source: revision1.manifest.source,
    manifest: revision1.manifest,
    residency: INITIAL,
    chunks: selectDerivedTerrainChunks(revision1.manifest, INITIAL).map((chunk) => ({
      chunkId: chunk.chunkId,
      chunk,
      resource: {
        kind: "terrain-chunk/v1",
        decoded: decodeTerrainChunkArtifact(revision1.artifacts.get(chunk.artifacts[0]!.contentHash)!),
      },
    })),
    globals: [
      {
        artifactType: HYDROLOGY_FIELD_ARTIFACT_TYPE,
        artifact: fieldDescriptor,
        resource: { kind: HYDROLOGY_FIELD_ARTIFACT_TYPE, decoded: decodeHydrologyFieldArtifact(fieldBytes) },
      },
      {
        artifactType: HYDROLOGY_WATER_ARTIFACT_TYPE,
        artifact: waterDescriptor,
        resource: { kind: HYDROLOGY_WATER_ARTIFACT_TYPE, artifact: waterDescriptor, bytes: waterBytes, bindings: waterBindings, prepared: preparedWater },
      },
    ],
  };
  const windowed = new DetachedDerivedRenderCandidate(parseTransferredDerivedRuntimeSnapshot(firstActivation.snapshot), { quality: "balanced" });
  const eager = new DetachedDerivedRenderCandidate(parseTransferredDerivedRuntimeSnapshot(eagerSnapshot), { quality: "balanced" });
  const windowedKeys = windowed.terrainWindow().map((entry) => entry.key).join("|");
  assert(windowedKeys === eager.terrainWindow().map((entry) => entry.key).join("|"), "mounted chunk set diverges from the eager mount");
  assert(windowed.terrainMeshCount === eager.terrainMeshCount, "mounted mesh count diverges from the eager mount");
  assert(windowed.overviewTriangleCount === eager.overviewTriangleCount, "mounted overview coverage diverges from the eager mount");
  assert(windowed.waterFragmentCount === eager.waterFragmentCount, "mounted water fragments diverge from the eager mount");
  for (const key of windowedKeys.split("|")) {
    const [tx, tz] = key.split(",").map(Number);
    for (const [fx, fz] of [[0.5, 0.5], [0.25, 0.75]] as const) {
      const x = (tx! + fx) * 64, z = (tz! + fz) * 64;
      const windowedHeight = windowed.snapshot.terrain.sampleHeight(x, z);
      assert(windowedHeight !== null && windowedHeight === eager.snapshot.terrain.sampleHeight(x, z),
        `mounted height diverges from the eager mount at ${x},${z}`);
    }
    const windowedTile = windowed.terrainWindow().find((entry) => entry.key === key)!.tile;
    const eagerTile = eager.terrainWindow().find((entry) => entry.key === key)!.tile;
    assert(windowedTile.heights.every((value, index) => value === eagerTile.heights[index]),
      `mounted tile bytes diverge from the eager mount at ${key}`);
  }
  // Collider equivalence: both windows stage into the sim to byte-identical physics.
  const MAP_ASSET_ID = "maps/windowed-fetch.worldmap.json";
  const map: any = {
    version: 1, id: "windowed-fetch", unitsPerMeter: 1, origin: [0, 0],
    extent: { w: 2048, h: 2048 }, seaLevel: -100,
    land: [], relief: [], biomes: [], waterways: [], waterBodies: [], routes: [], anchors: [],
    provenance: { tool: "design-space", sourceHash: "fixture", contentHash: "0".repeat(64) },
  };
  map.provenance.contentHash = worldMapContentHash(map);
  const mapBytes = new TextEncoder().encode(JSON.stringify(map));
  const initialCommands: AuthorCommand[] = [
    { kind: "physics", op: "op_physics_create_world", args: [-9.81] },
    { kind: "skill", tool: "world.setTerrainSource", input: { kind: "map", mapAssetId: MAP_ASSET_ID, hash: map.provenance.contentHash } },
    { kind: "skill", tool: "terrain.create", input: { size: 64, resolution: 3, origin: [32, 0, 32], baseHeight: 0 } },
  ];
  const simOf = async (candidate: DetachedDerivedRenderCandidate): Promise<SimWorkerController> => {
    const sim = await SimWorkerController.create({ rapier: rapier as RapierModule, assets: [{ id: MAP_ASSET_ID, bytes: mapBytes }] });
    const loaded = await sim.loadWorldIsolated(initialCommands);
    assert(loaded.failures.length === 0, `sim world failed: ${JSON.stringify(loaded.failures)}`);
    const stage: DerivedSimStageSnapshot = {
      schema: DERIVED_SIM_STAGE_SCHEMA,
      projectId: revision1.manifest.projectId,
      branchId: revision1.manifest.branchId,
      source: { revision: revision1.manifest.source.revision, headHash: revision1.manifest.source.headHash },
      manifestHash: revision1.manifest.manifestHash,
      grid,
      terrainWindow: candidate.terrainWindow().map((entry) => ({
        key: entry.key,
        tx: entry.tx,
        tz: entry.tz,
        tile: {
          nrows: entry.tile.nrows,
          ncols: entry.tile.ncols,
          origin: [...entry.tile.origin] as [number, number, number],
          scale: [...entry.tile.scale] as [number, number, number],
          heights: entry.tile.heights.slice(),
        },
      })),
      generatedWater: { artifact: waterDescriptor, bytes: waterBytes.slice(), bindings: waterBindings, fieldBytes: fieldBytes.slice() },
    };
    const staged = sim.stageDerivedRevision("windowed-stage", revision1.manifest.manifestHash, stage);
    sim.commitDerivedRevision("windowed-commit", staged.requestId, revision1.manifest.manifestHash);
    return sim;
  };
  const windowedSim = await simOf(windowed);
  const eagerSim = await simOf(eager);
  assert(windowedSim.derivedRevisionStatus.activeColliderCount === eagerSim.derivedRevisionStatus.activeColliderCount,
    "mounted collider count diverges from the eager mount");
  const windowedPhysics = windowedSim.world.ops.op_physics_snapshot();
  const eagerPhysics = eagerSim.world.ops.op_physics_snapshot();
  assert(windowedPhysics.length === eagerPhysics.length && windowedPhysics.every((value, index) => value === eagerPhysics[index]),
    "mounted physics bytes diverge from the eager mount");
  windowedSim.dispose();
  eagerSim.dispose();
  windowed.dispose();
  eager.dispose();
}

// ═══ (c) A window slide fetches exactly the entering chunks. ═══
const SLID = residencyAt(4, 3);
await cold.controller.handleMessage({
  schema: DERIVED_RUNTIME_WORKER_SCHEMA,
  type: "set-residency",
  requestId: "slide-1",
  residency: SLID,
});
await eventually(() => messages(cold, "residency-ack").length === 1, "slide residency acknowledgement");
const fetchesBeforeSlide = cold.transport.fetchUrls.length;
cold.timers.runNext();
await acknowledgeNext(cold, 1);
const slideFetches = cold.transport.fetchUrls.slice(fetchesBeforeSlide);
const enteringHashes = windowChunkHashes(revision1, SLID).filter((contentHash) => !windowChunkHashes(revision1, INITIAL).includes(contentHash));
assert(enteringHashes.length === 3, `fixture: expected a 3-chunk entering column, got ${enteringHashes.length}`);
assert(slideFetches.length === enteringHashes.length, `window slide fetched ${slideFetches.length} artifacts, expected exactly ${enteringHashes.length} entering chunks`);
for (const contentHash of enteringHashes) {
  assert(slideFetches.includes(artifactUrl(revision1.manifest.manifestHash, contentHash)), `window slide did not fetch entering chunk ${contentHash}`);
}
assertProgressContract(fetchProgressEvents(cold).slice(12), 3, "window slide");

// ═══ (f) Hydrology skip: an unchanged water artifact set is never refetched. ═══
cold.transport.current = currentOf(revision2);
for (const [contentHash, bytes] of revision2.artifacts) cold.transport.artifacts.set(contentHash, bytes);
const fetchesBeforeRevision = cold.transport.fetchUrls.length;
cold.timers.runNext();
await acknowledgeNext(cold, 2);
const revisionFetches = cold.transport.fetchUrls.slice(fetchesBeforeRevision);
const changedChunkHash = windowChunkHashes(revision2, SLID).find((contentHash) => !windowChunkHashes(revision1, SLID).includes(contentHash));
assert(changedChunkHash !== undefined, "fixture: revision 2 must change exactly one in-window chunk");
assert(revisionFetches.length === 1 && revisionFetches[0] === artifactUrl(revision2.manifest.manifestHash, changedChunkHash),
  `revision delta fetched ${JSON.stringify(revisionFetches)} — expected only the changed chunk (hydrology field/water must be skipped)`);
assertProgressContract(fetchProgressEvents(cold).slice(12 + 4), 1, "content revision");

// ═══ (d) Warm cache: a fresh worker for the same revision performs ZERO network fetches,
//         and a poisoned entry falls back to the network via the re-hash guard. ═══
{
  const warm = harness(revision2, cache);
  await warm.init(SLID);
  await eventually(() => messages(warm, "ready").length === 1, "warm worker ready");
  warm.timers.runNext();
  await acknowledgeNext(warm, 0);
  assert(warm.transport.fetchUrls.length === 0, `warm activation performed ${warm.transport.fetchUrls.length} network fetches, expected zero`);
  assertProgressContract(fetchProgressEvents(warm), 11, "warm activation");

  // A hostile/corrupted entry (wrong bytes under a valid key, planted behind the guard's back):
  // the read re-hash must evict it and fall back to exactly one network fetch.
  const poisonedHash = windowChunkHashes(revision2, SLID)[0]!;
  const poisonBytes = revision2.artifacts.get(windowChunkHashes(revision2, SLID)[1]!)!;
  const poisonedCache = createMemoryDerivedArtifactCache(derivedArtifactContentHash);
  await poisonedCache.put(poisonedHash, poisonBytes);
  for (const contentHash of [...windowChunkHashes(revision2, SLID), fieldDescriptor.contentHash, waterDescriptor.contentHash]) {
    if (contentHash !== poisonedHash) await poisonedCache.put(contentHash, revision2.artifacts.get(contentHash)!);
  }
  const poisoned = harness(revision2, poisonedCache);
  await poisoned.init(SLID);
  await eventually(() => messages(poisoned, "ready").length === 1, "poisoned worker ready");
  poisoned.timers.runNext();
  await acknowledgeNext(poisoned, 0);
  assert(poisoned.transport.fetchUrls.length === 1
    && poisoned.transport.fetchUrls[0] === artifactUrl(revision2.manifest.manifestHash, poisonedHash),
    `corrupted cache entry did not fall back to exactly one network fetch: ${JSON.stringify(poisoned.transport.fetchUrls)}`);
  await cold.controller.close();
  await warm.controller.close();
  await poisoned.controller.close();
}

console.log("[js] p_derived_windowed_fetch OK: window-only fetch set, byte-identical mounted end-state, exact slide/revision deltas, hydrology skip, zero-fetch warm cache, poison-guard fallback, and monotonic fetch progress");
