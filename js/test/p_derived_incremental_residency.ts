import * as THREE from "../build/three.bundle.mjs";
import {
  DetachedDerivedRenderCandidate,
  parseTransferredDerivedRuntimeSnapshot,
} from "../src/browser/derived-runtime-render-candidate.ts";
import { DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA } from "../src/browser/derived-runtime-worker.ts";
import {
  DERIVED_TERRAIN_RESIDENCY_SCHEMA,
  planDerivedActivation,
  selectDerivedTerrainChunks,
} from "../src/browser/derived-terrain-residency.ts";
import {
  DERIVED_SIM_STAGE_SCHEMA,
  SimWorkerController,
  type AuthorCommand,
  type DerivedSimStageSnapshot,
} from "../src/browser/sim-worker.ts";
import type { RapierModule } from "../src/browser/wasm-rapier-physics.ts";
import { createTerrainGridSpec, terrainChunkId } from "../src/terrain/grid.mjs";
import { tileKey } from "../src/terrain/stream.ts";
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
  WORLD_OVERVIEW_ARTIFACT_MEDIA_TYPE,
  WORLD_OVERVIEW_ARTIFACT_TYPE,
  decodeWorldOverviewArtifact,
  encodeWorldOverviewArtifact,
} from "../src/world/compiler/world-overview-artifact.mjs";
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_derived_incremental_residency FAIL: ${message}`);
}

function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}

async function rejectsAsync(fn: () => Promise<unknown>, pattern: RegExp, message: string): Promise<void> {
  let error: unknown;
  try { await fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not reject"}`);
}

let rapier: RapierModule | null = null;
try {
  // @ts-ignore native test runner cannot resolve the bare browser specifier.
  rapier = (await import("../node_modules/@dimforge/rapier3d-compat/rapier.mjs")) as unknown as RapierModule;
} catch (error) {
  throw new Error(`p_derived_incremental_residency FAIL: rapier import failed: ${String(error)}`);
}

// ── Compiled-test-revision fixture: a 12x12 LOD0 chunk domain with hydrology
//    water and a world overview, parameterized by a salt so a second manifest
//    (different content, different manifestHash) exercises fail-closed routing. ──
const hash = (label: string): string => derivedArtifactContentHash(new TextEncoder().encode(label));
const graphHash = hash("incremental-graph");
const grid = createTerrainGridSpec({ gridId: "incremental-residency", origin: [0, 0], chunkSizeM: 64, defaultSamples: 3 });
const DOMAIN = 12;

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
    descriptor: {
      artifactType: "terrain-chunk/v1",
      contentHash: derivedArtifactContentHash(bytes),
      byteLength: bytes.byteLength,
      mediaType: TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE,
    },
  };
}

const fieldTopology = createHydrologyTopology({
  rows: 16,
  cols: 16,
  heightsM: new Float64Array(16 * 16).fill(4),
  cellSizeM: 64,
  seaLevelM: 8,
  precipitationMmPerYear: 800,
});
const fieldBytes = encodeHydrologyFieldArtifact(fieldTopology, { originX: 0, originZ: 0 });
const fieldDescriptor = {
  artifactType: HYDROLOGY_FIELD_ARTIFACT_TYPE,
  contentHash: derivedArtifactContentHash(fieldBytes),
  byteLength: fieldBytes.byteLength,
  mediaType: HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE,
};
const waterBindings = Object.freeze({
  hydrologyFieldContentHash: fieldDescriptor.contentHash,
  recipeHash: hash("incremental-recipe"),
  erosionStageKey: hash("incremental-erosion"),
  compilerGraphHash: graphHash,
});
const waterBytes = encodeHydrologyWaterArtifact({
  schema: HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA,
  version: 1,
  placement: { originX: 0, originZ: 0 },
  rows: 16,
  cols: 16,
  cellSizeM: 64,
  basins: [{
    id: "gen-b-6-5",
    kind: "lake",
    spillLevelM: 8,
    maxDepthM: 3,
    areaM2: 16384,
    cellCount: 4,
    seedCell: 5,
    spillInsideCell: 5,
    spillOutsideCell: 6,
    spillOutsideDrainageRank: 6,
    footprint: { points: [[128, 128], [256, 128], [256, 256], [128, 256]] },
  }],
  reaches: [],
  diagnostics: {},
}, waterBindings);
const waterDescriptor = {
  artifactType: HYDROLOGY_WATER_ARTIFACT_TYPE,
  contentHash: derivedArtifactContentHash(waterBytes),
  byteLength: waterBytes.byteLength,
  mediaType: HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
};
const preparedWater = prepareGeneratedWaterFieldInput({
  bytes: waterBytes,
  descriptor: waterDescriptor,
  expectedBindings: waterBindings,
});
const overviewCells = 17 * 17;
const overviewBytes = encodeWorldOverviewArtifact({
  rows: 17,
  cols: 17,
  origin: [0, 0],
  stepM: 48,
  heights: new Float32Array(overviewCells).fill(5),
  paintMaterial: new Uint8Array(overviewCells).fill(2),
  paintWeight: new Uint8Array(overviewCells).fill(128),
});
const overviewDescriptor = {
  artifactType: WORLD_OVERVIEW_ARTIFACT_TYPE,
  contentHash: derivedArtifactContentHash(overviewBytes),
  byteLength: overviewBytes.byteLength,
  mediaType: WORLD_OVERVIEW_ARTIFACT_MEDIA_TYPE,
};

function buildManifest(salt: number) {
  const chunks = [];
  for (let tz = 0; tz < DOMAIN; tz++) {
    for (let tx = 0; tx < DOMAIN; tx++) {
      chunks.push({
        chunkId: terrainChunkId(grid.gridId, 0, tx, tz),
        gridId: grid.gridId,
        lod: 0,
        tx,
        tz,
        topologyHash: hash(`incremental-topology-${salt}-${tx}-${tz}`),
        sourceSliceHashes: [],
        artifacts: [terrain(salt, tx, tz).descriptor],
      });
    }
  }
  chunks.sort((left, right) => (left.chunkId < right.chunkId ? -1 : left.chunkId > right.chunkId ? 1 : 0));
  return createDerivedRevisionManifest({
    schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2,
    projectId: "incremental-residency",
    branchId: "main",
    source: {
      revision: 1,
      headHash: hash("incremental-head"),
      contentRefs: [{ refId: "map-document", refType: "map-document/v1", scope: "global", assetId: "maps/incremental.mapdoc.json", contentHash: hash("incremental-map") }],
    },
    compiler: { version: "1.0.0", configHash: hash("incremental-config"), graphHash, snapshotHash: hash("incremental-snapshot") },
    grid,
    globalArtifacts: [fieldDescriptor, waterDescriptor, overviewDescriptor],
    chunks,
  });
}

const manifest = buildManifest(0);
const otherManifest = buildManifest(1);

function residencyAt(tx: number, tz: number, radius = 1) {
  return { schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA, center: [tx * 64 + 32, tz * 64 + 32] as [number, number], lod: 0 as const, radius };
}

/** The transferred full-window snapshot shape the derived worker posts (one window). */
function transferredSnapshot(sourceManifest: typeof manifest, residency: ReturnType<typeof residencyAt>): any {
  return {
    schema: DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA,
    projectId: sourceManifest.projectId,
    branchId: sourceManifest.branchId,
    manifestHash: sourceManifest.manifestHash,
    source: sourceManifest.source,
    manifest: sourceManifest,
    residency,
    chunks: selectDerivedTerrainChunks(sourceManifest, residency).map((chunk) => ({
      chunkId: chunk.chunkId,
      chunk,
      resource: { kind: "terrain-chunk/v1", decoded: decodeTerrainChunkArtifact(terrain(saltOf(sourceManifest), chunk.tx, chunk.tz).bytes) },
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
      {
        artifactType: WORLD_OVERVIEW_ARTIFACT_TYPE,
        artifact: overviewDescriptor,
        resource: { kind: WORLD_OVERVIEW_ARTIFACT_TYPE, decoded: decodeWorldOverviewArtifact(overviewBytes) },
      },
    ],
  };
}

function saltOf(sourceManifest: typeof manifest): number {
  return sourceManifest === manifest ? 0 : 1;
}

function verifiedSnapshot(residency: ReturnType<typeof residencyAt>, sourceManifest = manifest) {
  return parseTransferredDerivedRuntimeSnapshot(transferredSnapshot(sourceManifest, residency));
}

/** Wire-shape tile ({nrows, ncols, origin, scale, heights}) for one fixture chunk. */
function simTile(salt: number, tx: number, tz: number) {
  const decoded = decodeTerrainChunkArtifact(terrain(salt, tx, tz).bytes).tile;
  return {
    nrows: decoded.nrows,
    ncols: decoded.ncols,
    origin: [...decoded.origin] as [number, number, number],
    scale: [...decoded.scale] as [number, number, number],
    heights: decoded.heights.slice(),
  };
}

/** The sim stage snapshot for one full window (the full-activation reference path). */
function simStageSnapshot(residency: ReturnType<typeof residencyAt>): DerivedSimStageSnapshot {
  return {
    schema: DERIVED_SIM_STAGE_SCHEMA,
    projectId: manifest.projectId,
    branchId: manifest.branchId,
    source: { revision: manifest.source.revision, headHash: manifest.source.headHash },
    manifestHash: manifest.manifestHash,
    grid,
    terrainWindow: selectDerivedTerrainChunks(manifest, residency).map((chunk) => ({
      key: tileKey(chunk.tx, chunk.tz),
      tx: chunk.tx,
      tz: chunk.tz,
      tile: simTile(0, chunk.tx, chunk.tz),
    })),
    generatedWater: { artifact: waterDescriptor, bytes: waterBytes.slice(), bindings: waterBindings },
  };
}

// ── Sim fixture: the authored-map binding pattern from p_sim_derived_activation. ──
const MAP_ASSET_ID = "maps/incremental-residency.worldmap.json";
const map: any = {
  version: 1,
  id: "incremental-residency",
  unitsPerMeter: 1,
  origin: [0, 0],
  extent: { w: 2048, h: 2048 },
  seaLevel: -100,
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

async function controller(): Promise<SimWorkerController> {
  const result = await SimWorkerController.create({
    rapier: rapier as RapierModule,
    assets: [{ id: MAP_ASSET_ID, bytes: mapBytes }],
  });
  const loaded = await result.loadWorldIsolated(initialCommands);
  assert(loaded.failures.length === 0, `initial authored map failed: ${JSON.stringify(loaded.failures)}`);
  return result;
}

function bodyCount(ctrl: SimWorkerController): number {
  const blob = ctrl.world.ops.op_physics_snapshot();
  const metaLength = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(blob.subarray(4, 4 + metaLength))) as { entries: unknown[] };
  return meta.entries.length;
}

function windowKeys(residency: ReturnType<typeof residencyAt>): string[] {
  return selectDerivedTerrainChunks(manifest, residency).map((chunk) => tileKey(chunk.tx, chunk.tz));
}

function deltaOf(priorKeys: readonly string[], nextKeys: readonly string[]): { added: string[]; removed: string[] } {
  const prior = new Set(priorKeys);
  const next = new Set(nextKeys);
  return {
    added: nextKeys.filter((key) => !prior.has(key)),
    removed: priorKeys.filter((key) => !next.has(key)),
  };
}

/** The sim delta payload, built exactly like browser-entry's updateDerivedResidency call. */
function simUpdatePayload(residency: ReturnType<typeof residencyAt>, added: readonly string[], removed: readonly string[]) {
  return {
    added: selectDerivedTerrainChunks(manifest, residency)
      .filter((chunk) => added.includes(tileKey(chunk.tx, chunk.tz)))
      .map((chunk) => ({
        key: tileKey(chunk.tx, chunk.tz),
        tx: chunk.tx,
        tz: chunk.tz,
        tile: simTile(0, chunk.tx, chunk.tz),
      })),
    removed: [...removed],
  };
}

// The walk: five single-chunk moves, one 3-chunk jump (no overlap), one diagonal
// (-2,+2 — exactly one retained chunk), one closing move. Every step is compared
// against a FRESH full activation of the same window.
const WALK = [
  residencyAt(4, 4),
  residencyAt(5, 4),
  residencyAt(5, 5),
  residencyAt(5, 6),
  residencyAt(6, 6),
  residencyAt(9, 6),
  residencyAt(9, 7),
  residencyAt(7, 9),
  residencyAt(7, 7),
];
const CONTACT_POINTS: readonly (readonly [number, number])[] = [
  [160, 160], // inside the basin footprint
  [224, 224], // basin edge
  [50, 50],   // dry, inside early windows
  [600, 600], // outside every window
  [352, 416], // dry chunk interior
];

interface WalkTrace {
  keys: string;
  meshes: number;
  overviewTriangles: number;
  waterFragments: number;
  colliders: number;
  bodies: number;
  heights: string;
  contacts: string;
}

async function runWalk(onStep?: (step: number, added: number, removed: number) => void): Promise<WalkTrace[]> {
  // Delta side: one candidate + one sim, full-activated once at the walk start and
  // then driven ONLY through the incremental path.
  const deltaCandidate = new DetachedDerivedRenderCandidate(verifiedSnapshot(WALK[0]!), { quality: "balanced" });
  const deltaSim = await controller();
  let stage = deltaSim.stageDerivedRevision(`walk-stage-0`, manifest.manifestHash, simStageSnapshot(WALK[0]!));
  deltaSim.commitDerivedRevision(`walk-commit-0`, stage.requestId, manifest.manifestHash);
  let priorKeys = windowKeys(WALK[0]!);
  assert(deltaCandidate.terrainWindow().map((entry) => entry.key).join("|") === priorKeys.join("|"), "initial full window is wrong");
  const traces: WalkTrace[] = [];
  for (let step = 1; step < WALK.length; step++) {
    const residency = WALK[step]!;
    const nextKeys = windowKeys(residency);
    const delta = deltaOf(priorKeys, nextKeys);
    onStep?.(step, delta.added.length, delta.removed.length);
    // Render-realm incremental swap.
    const prepared = await deltaCandidate.beginResidencyDelta(verifiedSnapshot(residency));
    assert(prepared.added.length === delta.added.length && prepared.removed.length === delta.removed.length,
      `step ${step}: render delta ${prepared.added.length}+/${prepared.removed.length}- != expected ${delta.added.length}+/${delta.removed.length}-`);
    // Sim-realm incremental swap (single atomic wrapper).
    const simResult = deltaSim.updateDerivedResidency(`walk-update-${step}`, manifest.manifestHash, simUpdatePayload(residency, delta.added, delta.removed));
    assert(simResult.added === delta.added.length && simResult.removed === delta.removed.length, `step ${step}: sim delta counts diverge`);
    deltaCandidate.commitResidencyDelta(prepared);
    // Full-activation reference at the same window.
    const reference = new DetachedDerivedRenderCandidate(verifiedSnapshot(residency), { quality: "balanced" });
    const referenceSim = await controller();
    stage = referenceSim.stageDerivedRevision(`ref-stage-${step}`, manifest.manifestHash, simStageSnapshot(residency));
    referenceSim.commitDerivedRevision(`ref-commit-${step}`, stage.requestId, manifest.manifestHash);
    const candidateKeys = deltaCandidate.terrainWindow().map((entry) => entry.key).join("|");
    assert(candidateKeys === reference.terrainWindow().map((entry) => entry.key).join("|"), `step ${step}: mounted chunk set diverges from full activation`);
    assert(candidateKeys === nextKeys.join("|"), `step ${step}: mounted chunk set diverges from the selected window`);
    assert(deltaCandidate.terrainMeshCount === reference.terrainMeshCount, `step ${step}: mesh count diverges`);
    assert(deltaCandidate.overviewMeshCount === reference.overviewMeshCount
      && deltaCandidate.overviewTriangleCount === reference.overviewTriangleCount, `step ${step}: overview coverage diverges`);
    assert(deltaCandidate.waterFragmentCount === reference.waterFragmentCount, `step ${step}: water fragments diverge`);
    assert(deltaSim.derivedRevisionStatus.activeColliderCount === referenceSim.derivedRevisionStatus.activeColliderCount,
      `step ${step}: sim collider count diverges`);
    assert(bodyCount(deltaSim) === bodyCount(referenceSim), `step ${step}: physics body count diverges`);
    // Height sample grid over the new window (both candidates must cover it exactly;
    // the added chunks prove the delta candidate adopted the new snapshot's index).
    const heightSamples: string[] = [];
    for (const key of nextKeys) {
      const [tx, tz] = key.split(",").map(Number);
      for (const [fx, fz] of [[0.5, 0.5], [0.25, 0.75]] as const) {
        const x = (tx! + fx) * 64, z = (tz! + fz) * 64;
        heightSamples.push(`${x},${z}:${deltaCandidate.snapshot.terrain.sampleHeight(x, z)}|${reference.snapshot.terrain.sampleHeight(x, z)}`);
      }
    }
    for (const sample of heightSamples) {
      const [deltaHeight, referenceHeight] = sample.split(":")[1]!.split("|");
      assert(deltaHeight === referenceHeight && deltaHeight !== "null", `step ${step}: height sample diverges (${sample})`);
    }
    // Contact query results over fixed world points (inside/outside basin and window).
    const contacts = CONTACT_POINTS.map(([x, z]) => JSON.stringify(deltaSim.core.water.contact.query(x, z))).join(";");
    const referenceContacts = CONTACT_POINTS.map(([x, z]) => JSON.stringify(referenceSim.core.water.contact.query(x, z))).join(";");
    assert(contacts === referenceContacts, `step ${step}: water contact state diverges:\n${contacts}\nvs\n${referenceContacts}`);
    traces.push({
      keys: candidateKeys,
      meshes: deltaCandidate.terrainMeshCount,
      overviewTriangles: deltaCandidate.overviewTriangleCount,
      waterFragments: deltaCandidate.waterFragmentCount,
      colliders: deltaSim.derivedRevisionStatus.activeColliderCount,
      bodies: bodyCount(deltaSim),
      heights: heightSamples.join(","),
      contacts,
    });
    reference.dispose();
    referenceSim.dispose();
    priorKeys = nextKeys;
  }
  deltaCandidate.dispose();
  deltaSim.dispose();
  return traces;
}

// (a)+(b) Walk equivalence and delta-proportional mounting.
const mountedPerStep: Array<[number, number, number]> = [];
const traces = await runWalk((step, added, removed) => mountedPerStep.push([step, added, removed]));
assert(traces.length === WALK.length - 1, "walk did not trace every step");
for (const [step, added, removed] of mountedPerStep) {
  assert(added <= 9 && removed <= 9, `step ${step}: mounted ${added}+/${removed}- for a window of 9 — not delta-proportional`);
}
assert(mountedPerStep[0]![1] === 3 && mountedPerStep[0]![2] === 3, `1-chunk move mounted ${mountedPerStep[0]![1]}+/${mountedPerStep[0]![2]}- instead of the 3-chunk column delta`);
assert(mountedPerStep[4]![1] === 9 && mountedPerStep[4]![2] === 9, "3-chunk jump should mount the whole non-overlapping window");
assert(mountedPerStep[6]![1] === 8 && mountedPerStep[6]![2] === 8, "diagonal move should keep exactly its 1-chunk overlap");

// (e) Replay parity: the same walk twice produces byte-identical traces.
const replay = await runWalk();
assert(JSON.stringify(replay) === JSON.stringify(traces), "replayed residency walk diverged from the first run");

// (c) Cancellation mid-delta-mount abandons only the partial delta.
{
  const candidate = new DetachedDerivedRenderCandidate(verifiedSnapshot(WALK[0]!), { quality: "balanced" });
  const priorKeys = candidate.terrainWindow().map((entry) => entry.key).join("|");
  const priorChildren = candidate.terrainRoot.children.length;
  // Cancel before ANY chunk mount (first slice boundary).
  await rejectsAsync(
    () => candidate.beginResidencyDelta(verifiedSnapshot(WALK[1]!), {
      onSlice: () => { throw new Error("injected early cancel"); },
    }),
    /injected early cancel/,
    "early-cancelled delta did not reject",
  );
  assert(candidate.terrainWindow().map((entry) => entry.key).join("|") === priorKeys
    && candidate.terrainMeshCount === 9 && candidate.terrainRoot.children.length === priorChildren,
    "early-cancelled delta mutated the live window");
  // Cancel after chunk mounts (at the overview slice boundary).
  let slices = 0;
  await rejectsAsync(
    () => candidate.beginResidencyDelta(verifiedSnapshot(WALK[1]!), {
      onSlice: () => { slices++; if (slices >= 2) throw new Error("injected late cancel"); },
    }),
    /injected late cancel/,
    "late-cancelled delta did not reject",
  );
  assert(candidate.terrainWindow().map((entry) => entry.key).join("|") === priorKeys
    && candidate.terrainMeshCount === 9 && candidate.terrainRoot.children.length === priorChildren
    && candidate.overviewTriangleCount > 0,
    "late-cancelled delta leaked partial mounts into the live window");
  // A clean retry of the SAME move succeeds and matches the full-activation reference.
  const prepared = await candidate.beginResidencyDelta(verifiedSnapshot(WALK[1]!));
  candidate.commitResidencyDelta(prepared);
  const reference = new DetachedDerivedRenderCandidate(verifiedSnapshot(WALK[1]!), { quality: "balanced" });
  assert(candidate.terrainWindow().map((entry) => entry.key).join("|") === reference.terrainWindow().map((entry) => entry.key).join("|")
    && candidate.overviewTriangleCount === reference.overviewTriangleCount
    && candidate.waterFragmentCount === reference.waterFragmentCount,
    "post-cancel retry does not match the full-activation reference");
  reference.dispose();
  candidate.dispose();
}
// Sim-side cancellation: an injected collider failure rolls the physics snapshot back
// byte-exactly and keeps the prior window's colliders and contact authoritative.
{
  const sim = await controller();
  const stage = sim.stageDerivedRevision("cancel-stage", manifest.manifestHash, simStageSnapshot(WALK[0]!));
  sim.commitDerivedRevision("cancel-commit", stage.requestId, manifest.manifestHash);
  const keys = windowKeys(WALK[0]!);
  const nextKeys = windowKeys(WALK[1]!);
  const delta = deltaOf(keys, nextKeys);
  const before = sim.world.ops.op_physics_snapshot();
  const contactBefore = JSON.stringify(sim.core.water.contact.query(160, 160));
  const originalAdd = sim.world.ops.op_physics_add_heightfield;
  let addCalls = 0;
  sim.world.ops.op_physics_add_heightfield = (...args) => {
    addCalls++;
    if (addCalls === 2) throw new Error("injected delta collider failure");
    return originalAdd(...args);
  };
  rejects(
    () => sim.updateDerivedResidency("cancel-update", manifest.manifestHash, simUpdatePayload(WALK[1]!, delta.added, delta.removed)),
    /injected delta collider failure/,
    "failed sim delta did not reject",
  );
  sim.world.ops.op_physics_add_heightfield = originalAdd;
  const after = sim.world.ops.op_physics_snapshot();
  assert(before.length === after.length && before.every((value, index) => value === after[index]),
    "failed sim delta did not restore exact physics bytes");
  assert(sim.derivedRevisionStatus.activeColliderCount === 9
    && JSON.stringify(sim.core.water.contact.query(160, 160)) === contactBefore,
    "failed sim delta changed the active collider set or contact");
  // The SAME delta applies cleanly once the injection stops.
  const applied = sim.updateDerivedResidency("cancel-update-2", manifest.manifestHash, simUpdatePayload(WALK[1]!, delta.added, delta.removed));
  assert(applied.added === 3 && applied.removed === 3 && sim.derivedRevisionStatus.activeColliderCount === 9,
    "post-failure sim delta retry did not apply cleanly");
  sim.dispose();
}

// (d) Tampered/mismatched revisions route to the full path or fail closed.
{
  const r0 = residencyAt(4, 4);
  const r1 = residencyAt(5, 4);
  const active = { manifestHash: manifest.manifestHash, residencyKey: "0:288:288:1" };
  assert(planDerivedActivation(null, manifest.manifestHash, "0:288:288:1", false) === "full", "no active revision must be a full activation");
  assert(planDerivedActivation(active, manifest.manifestHash, "0:288:288:1", false) === "duplicate", "same window must be a duplicate");
  assert(planDerivedActivation(active, manifest.manifestHash, "0:352:288:1", false) === "incremental", "same-manifest window move must be incremental");
  assert(planDerivedActivation(active, manifest.manifestHash, "0:352:288:1", true) === "full", "population must route to the full path");
  assert(planDerivedActivation(active, otherManifest.manifestHash, "0:352:288:1", false) === "full", "manifest change must route to the full path");
  // The candidate refuses a mismatched manifest even if routing let one through.
  const candidate = new DetachedDerivedRenderCandidate(verifiedSnapshot(r0), { quality: "balanced" });
  await rejectsAsync(
    () => candidate.beginResidencyDelta(verifiedSnapshot(r1, otherManifest)),
    /requires the active manifest/,
    "candidate accepted a mismatched-manifest delta",
  );
  await rejectsAsync(
    () => candidate.beginResidencyDelta(verifiedSnapshot(r0)),
    /requires a changed residency/,
    "candidate accepted a same-residency delta",
  );
  assert(candidate.terrainMeshCount === 9 && !candidate.disposed, "rejected deltas damaged the live candidate");
  candidate.dispose();
  // The sim refuses deltas against the wrong revision, a pending full stage, and
  // structurally-broken payloads — all without touching physics.
  const sim = await controller();
  const stage = sim.stageDerivedRevision("guard-stage", manifest.manifestHash, simStageSnapshot(r0));
  sim.commitDerivedRevision("guard-commit", stage.requestId, manifest.manifestHash);
  const before = sim.world.ops.op_physics_snapshot();
  rejects(() => sim.updateDerivedResidency("guard-1", otherManifest.manifestHash, { added: [], removed: [] }),
    /does not name the active revision/, "sim accepted a delta for another revision");
  rejects(() => sim.updateDerivedResidency("guard-2", manifest.manifestHash, { added: [], removed: ["40,40"] }),
    /not canonical|not resident/, "sim accepted an unknown removed key");
  const singleAdd = simUpdatePayload(r1, ["6,3"], []).added[0]!;
  const duplicateAdd = { added: [singleAdd, singleAdd], removed: [] };
  rejects(() => sim.updateDerivedResidency("guard-3", manifest.manifestHash, duplicateAdd),
    /duplicated/, "sim accepted duplicate added keys");
  const staged = sim.stageDerivedRevision("guard-stage-2", manifest.manifestHash, simStageSnapshot(r1));
  rejects(() => sim.updateDerivedResidency("guard-4", manifest.manifestHash, { added: [], removed: [] }),
    /raced a staged full revision/, "sim accepted a delta racing a staged full revision");
  sim.discardDerivedRevision("guard-discard", staged.requestId, manifest.manifestHash);
  const after = sim.world.ops.op_physics_snapshot();
  assert(before.length === after.length && before.every((value, index) => value === after[index]),
    "rejected sim deltas touched physics");
  sim.dispose();
}

// Dispose-order sanity: THREE stays importable and unused candidates cannot double-delta.
{
  const candidate = new DetachedDerivedRenderCandidate(verifiedSnapshot(WALK[0]!), { quality: "balanced" });
  const prepared = await candidate.beginResidencyDelta(verifiedSnapshot(WALK[1]!));
  await rejectsAsync(() => candidate.beginResidencyDelta(verifiedSnapshot(WALK[2]!)), /already has a residency delta in flight/,
    "overlapping deltas were not refused");
  candidate.abortResidencyDelta(prepared);
  assert(candidate.terrainWindow().map((entry) => entry.key).join("|") === windowKeys(WALK[0]!).join("|"),
    "aborted delta did not restore the prior window");
  const reprepared = await candidate.beginResidencyDelta(verifiedSnapshot(WALK[1]!));
  candidate.commitResidencyDelta(reprepared);
  rejects(() => candidate.commitResidencyDelta(reprepared), /does not name the in-flight delta/, "double commit was not refused");
  candidate.dispose();
  void THREE;
}

console.log("[js] p_derived_incremental_residency OK: incremental window deltas are byte-exact against full activation (meshes, colliders, heights, contacts), delta-proportional, cancellation-safe, fail-closed, and replay-stable");
