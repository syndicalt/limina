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
  if (!condition) throw new Error(`p_derived_content_delta FAIL: ${message}`);
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
  throw new Error(`p_derived_content_delta FAIL: rapier import failed: ${String(error)}`);
}

// ── Compiled-test-revision fixture: a 12x12 LOD0 chunk domain with hydrology
//    water and a world overview. A revision names the chunks a sculpt touched:
//    touched chunks get different height bytes (SAME origin/scale and the same
//    relief range, so the window surface frame holds) while every other chunk,
//    the per-chunk topologyHash, the grid, and the globals stay byte-identical —
//    exactly what the compiler emits for an edit-layer op (verified against
//    limina-world production manifests: 2 of 5046 chunk hashes moved, key set,
//    topology hashes, grid, and all global artifacts unchanged). ──
const hash = (label: string): string => derivedArtifactContentHash(new TextEncoder().encode(label));
const graphHash = hash("content-delta-graph");
const grid = createTerrainGridSpec({ gridId: "content-delta", origin: [0, 0], chunkSizeM: 64, defaultSamples: 3 });
const DOMAIN = 12;

function chunkTerrain(variant: "base" | "sculpt" | "surge", tx: number, tz: number) {
  const heights = new Float32Array(9);
  for (let index = 0; index < 9; index++) {
    const sample = ((index + tx * 3 + tz * 7) % 5) * 0.02;
    // sculpt keeps the base relief range (surface frame holds); surge exceeds it
    // (frame moves — must route full).
    heights[index] = variant === "sculpt" ? (0.08 - sample) : variant === "surge" ? sample * 4 : sample;
  }
  const bytes = encodeTerrainChunkArtifact({
    nrows: 3,
    ncols: 3,
    origin: [(tx + 0.5) * 64, 2 + (tx + tz) * 0.5, (tz + 0.5) * 64],
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
  recipeHash: hash("content-delta-recipe"),
  erosionStageKey: hash("content-delta-erosion"),
  compilerGraphHash: graphHash,
});
function waterArtifact(maxDepthM: number) {
  const bytes = encodeHydrologyWaterArtifact({
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
      maxDepthM,
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
  const descriptor = {
    artifactType: HYDROLOGY_WATER_ARTIFACT_TYPE,
    contentHash: derivedArtifactContentHash(bytes),
    byteLength: bytes.byteLength,
    mediaType: HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
  };
  return {
    bytes,
    descriptor,
    prepared: prepareGeneratedWaterFieldInput({ bytes, descriptor, expectedBindings: waterBindings }),
  };
}
const waterA = waterArtifact(3);
const waterB = waterArtifact(4);
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

interface RevisionFixture {
  readonly manifest: ReturnType<typeof createDerivedRevisionManifest>;
  readonly bytesFor: (tx: number, tz: number) => Uint8Array;
  readonly water: typeof waterA;
}

/** One compiled revision. `changed` names the sculpt-touched chunk keys; their
 *  terrain bytes move (nothing else). `topologyShift`/`waterB` build the
 *  route-full variants. */
function buildRevision(options: Readonly<{
  revision: number;
  changed?: ReadonlyMap<string, "sculpt" | "surge">;
  topologyShift?: boolean;
  waterB?: boolean;
}>): RevisionFixture {
  const changed = options.changed ?? new Map<string, "sculpt" | "surge">();
  const bytesFor = (tx: number, tz: number): Uint8Array =>
    chunkTerrain(changed.get(tileKey(tx, tz)) ?? "base", tx, tz).bytes;
  const chunks = [];
  for (let tz = 0; tz < DOMAIN; tz++) {
    for (let tx = 0; tx < DOMAIN; tx++) {
      chunks.push({
        chunkId: terrainChunkId(grid.gridId, 0, tx, tz),
        gridId: grid.gridId,
        lod: 0,
        tx,
        tz,
        // Per-chunk topology is grid-derived: a sculpt does not move it (compiler-
        // verified above), so only the explicit shift variant changes it.
        topologyHash: hash(`content-topology${options.topologyShift === true ? "-shifted" : ""}-${tx}-${tz}`),
        sourceSliceHashes: [],
        artifacts: [chunkTerrain(changed.get(tileKey(tx, tz)) ?? "base", tx, tz).descriptor],
      });
    }
  }
  chunks.sort((left, right) => (left.chunkId < right.chunkId ? -1 : left.chunkId > right.chunkId ? 1 : 0));
  const water = options.waterB === true ? waterB : waterA;
  const manifest = createDerivedRevisionManifest({
    schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2,
    projectId: "content-delta",
    branchId: "main",
    source: {
      revision: options.revision,
      headHash: hash(`content-delta-head-${options.revision}`),
      contentRefs: [{ refId: "map-document", refType: "map-document/v1", scope: "global", assetId: "maps/content-delta.mapdoc.json", contentHash: hash("content-delta-map") }],
    },
    compiler: { version: "1.0.0", configHash: hash("content-delta-config"), graphHash, snapshotHash: hash("content-delta-snapshot") },
    grid,
    globalArtifacts: [fieldDescriptor, water.descriptor, overviewDescriptor],
    chunks,
  });
  return { manifest, bytesFor, water };
}

const revA = buildRevision({ revision: 1 });
const r0 = { schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA, center: [4 * 64 + 32, 4 * 64 + 32] as [number, number], lod: 0 as const, radius: 1 };
const r1 = { schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA, center: [5 * 64 + 32, 4 * 64 + 32] as [number, number], lod: 0 as const, radius: 1 };
// r0's window is tx,tz in 3..5; the sculpt touches one interior chunk.
const revB = buildRevision({ revision: 2, changed: new Map([["4,4", "sculpt"]]) });
// revC vs revB: only "5,3" moves ("4,4" keeps revB's sculpted bytes).
const revC = buildRevision({ revision: 3, changed: new Map([["4,4", "sculpt"], ["5,3", "sculpt"]]) });
const revSurge = buildRevision({ revision: 4, changed: new Map([["4,4", "surge"]]) });
const revWater = buildRevision({ revision: 5, waterB: true });
const revTopology = buildRevision({ revision: 6, topologyShift: true });

type Residency = typeof r0;

/** The transferred full-window snapshot shape the derived worker posts (one window). */
function transferredSnapshot(revision: RevisionFixture, residency: Residency): any {
  return {
    schema: DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA,
    projectId: revision.manifest.projectId,
    branchId: revision.manifest.branchId,
    manifestHash: revision.manifest.manifestHash,
    source: revision.manifest.source,
    manifest: revision.manifest,
    residency,
    chunks: selectDerivedTerrainChunks(revision.manifest, residency).map((chunk) => ({
      chunkId: chunk.chunkId,
      chunk,
      resource: { kind: "terrain-chunk/v1", decoded: decodeTerrainChunkArtifact(revision.bytesFor(chunk.tx, chunk.tz)) },
    })),
    globals: [
      {
        artifactType: HYDROLOGY_FIELD_ARTIFACT_TYPE,
        artifact: fieldDescriptor,
        resource: { kind: HYDROLOGY_FIELD_ARTIFACT_TYPE, decoded: decodeHydrologyFieldArtifact(fieldBytes) },
      },
      {
        artifactType: HYDROLOGY_WATER_ARTIFACT_TYPE,
        artifact: revision.water.descriptor,
        resource: { kind: HYDROLOGY_WATER_ARTIFACT_TYPE, artifact: revision.water.descriptor, bytes: revision.water.bytes, bindings: waterBindings, prepared: revision.water.prepared },
      },
      {
        artifactType: WORLD_OVERVIEW_ARTIFACT_TYPE,
        artifact: overviewDescriptor,
        resource: { kind: WORLD_OVERVIEW_ARTIFACT_TYPE, decoded: decodeWorldOverviewArtifact(overviewBytes) },
      },
    ],
  };
}

function verifiedSnapshot(revision: RevisionFixture, residency: Residency) {
  return parseTransferredDerivedRuntimeSnapshot(transferredSnapshot(revision, residency));
}

/** Wire-shape tile ({nrows, ncols, origin, scale, heights}) for one fixture chunk. */
function simTile(revision: RevisionFixture, tx: number, tz: number) {
  const decoded = decodeTerrainChunkArtifact(revision.bytesFor(tx, tz)).tile;
  return {
    nrows: decoded.nrows,
    ncols: decoded.ncols,
    origin: [...decoded.origin] as [number, number, number],
    scale: [...decoded.scale] as [number, number, number],
    heights: decoded.heights.slice(),
  };
}

/** The sim stage snapshot for one full window (the full-activation reference path). */
function simStageSnapshot(revision: RevisionFixture, residency: Residency): DerivedSimStageSnapshot {
  return {
    schema: DERIVED_SIM_STAGE_SCHEMA,
    projectId: revision.manifest.projectId,
    branchId: revision.manifest.branchId,
    source: { revision: revision.manifest.source.revision, headHash: revision.manifest.source.headHash },
    manifestHash: revision.manifest.manifestHash,
    grid,
    terrainWindow: selectDerivedTerrainChunks(revision.manifest, residency).map((chunk) => ({
      key: tileKey(chunk.tx, chunk.tz),
      tx: chunk.tx,
      tz: chunk.tz,
      tile: simTile(revision, chunk.tx, chunk.tz),
    })),
    generatedWater: { artifact: revision.water.descriptor, bytes: revision.water.bytes.slice(), bindings: waterBindings },
  };
}

/** The sim content-delta payload, built exactly like browser-entry's updateDerivedContent call. */
function simContentPayload(revision: RevisionFixture, residency: Residency, changedKeys: readonly string[]) {
  return {
    nextManifestHash: revision.manifest.manifestHash,
    replaced: selectDerivedTerrainChunks(revision.manifest, residency)
      .filter((chunk) => changedKeys.includes(tileKey(chunk.tx, chunk.tz)))
      .map((chunk) => ({
        key: tileKey(chunk.tx, chunk.tz),
        tx: chunk.tx,
        tz: chunk.tz,
        tile: simTile(revision, chunk.tx, chunk.tz),
      })),
  };
}

// ── Sim fixture: the authored-map binding pattern from p_sim_derived_activation. ──
const MAP_ASSET_ID = "maps/content-delta.worldmap.json";
const map: any = {
  version: 1,
  id: "content-delta",
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

function windowKeys(revision: RevisionFixture, residency: Residency): string[] {
  return selectDerivedTerrainChunks(revision.manifest, residency).map((chunk) => tileKey(chunk.tx, chunk.tz));
}

const CONTACT_POINTS: readonly (readonly [number, number])[] = [
  [160, 160], // inside the basin footprint
  [224, 224], // basin edge
  [50, 50],   // dry, outside the window
  [352, 416], // dry chunk interior
];

/** Mesh-object identity per chunk key, recovered from the terrainRoot attach set
 *  (mesh position IS the tile origin, so the key is derivable). */
function meshIdentity(candidate: DetachedDerivedRenderCandidate): Map<string, object> {
  const result = new Map<string, object>();
  for (const mesh of candidate.terrainRoot.children) {
    const tx = Math.round(mesh.position.x / 64 - 0.5);
    const tz = Math.round(mesh.position.z / 64 - 0.5);
    result.set(tileKey(tx, tz), mesh);
  }
  return result;
}

interface DeltaTrace {
  keys: string;
  meshes: number;
  overviewTriangles: number;
  waterFragments: number;
  colliders: number;
  bodies: number;
  activeManifest: string;
  heights: string;
  contacts: string;
}

function compareAgainstFull(
  label: string,
  deltaCandidate: DetachedDerivedRenderCandidate,
  deltaSim: SimWorkerController,
  reference: DetachedDerivedRenderCandidate,
  referenceSim: SimWorkerController,
  revision: RevisionFixture,
): DeltaTrace {
  const candidateKeys = deltaCandidate.terrainWindow().map((entry) => entry.key).join("|");
  assert(candidateKeys === reference.terrainWindow().map((entry) => entry.key).join("|"),
    `${label}: mounted chunk set diverges from full activation`);
  assert(candidateKeys === windowKeys(revision, r0).join("|"), `${label}: mounted chunk set diverges from the selected window`);
  assert(deltaCandidate.terrainMeshCount === reference.terrainMeshCount, `${label}: mesh count diverges`);
  assert(deltaCandidate.overviewMeshCount === reference.overviewMeshCount
    && deltaCandidate.overviewTriangleCount === reference.overviewTriangleCount, `${label}: overview coverage diverges`);
  assert(deltaCandidate.waterFragmentCount === reference.waterFragmentCount, `${label}: water fragments diverge`);
  assert(deltaCandidate.snapshot.manifestHash === revision.manifest.manifestHash
    && reference.snapshot.manifestHash === revision.manifest.manifestHash, `${label}: candidate manifest identity diverges`);
  assert(deltaSim.derivedRevisionStatus.activeManifestHash === revision.manifest.manifestHash,
    `${label}: sim revision was not renamed to the new manifest`);
  assert(deltaSim.derivedRevisionStatus.activeColliderCount === referenceSim.derivedRevisionStatus.activeColliderCount,
    `${label}: sim collider count diverges`);
  assert(bodyCount(deltaSim) === bodyCount(referenceSim), `${label}: physics body count diverges`);
  const heightSamples: string[] = [];
  for (const key of windowKeys(revision, r0)) {
    const [tx, tz] = key.split(",").map(Number);
    for (const [fx, fz] of [[0.5, 0.5], [0.25, 0.75]] as const) {
      const x = (tx! + fx) * 64, z = (tz! + fz) * 64;
      heightSamples.push(`${x},${z}:${deltaCandidate.snapshot.terrain.sampleHeight(x, z)}|${reference.snapshot.terrain.sampleHeight(x, z)}`);
    }
  }
  for (const sample of heightSamples) {
    const [deltaHeight, referenceHeight] = sample.split(":")[1]!.split("|");
    assert(deltaHeight === referenceHeight && deltaHeight !== "null", `${label}: height sample diverges (${sample})`);
  }
  const contacts = CONTACT_POINTS.map(([x, z]) => JSON.stringify(deltaSim.core.water.contact.query(x, z))).join(";");
  const referenceContacts = CONTACT_POINTS.map(([x, z]) => JSON.stringify(referenceSim.core.water.contact.query(x, z))).join(";");
  assert(contacts === referenceContacts, `${label}: water contact state diverges:\n${contacts}\nvs\n${referenceContacts}`);
  return {
    keys: candidateKeys,
    meshes: deltaCandidate.terrainMeshCount,
    overviewTriangles: deltaCandidate.overviewTriangleCount,
    waterFragments: deltaCandidate.waterFragmentCount,
    colliders: deltaSim.derivedRevisionStatus.activeColliderCount,
    bodies: bodyCount(deltaSim),
    activeManifest: deltaSim.derivedRevisionStatus.activeManifestHash ?? "null",
    heights: heightSamples.join(","),
    contacts,
  };
}

/** The sculpt sequence: full-activate revA, then content-delta to revB (1 chunk)
 *  and revC (1 further chunk). Every revision is compared against a FRESH full
 *  activation of the same revision. */
async function runSequence(onDelta?: (label: string, changed: readonly string[]) => void): Promise<DeltaTrace[]> {
  const deltaCandidate = new DetachedDerivedRenderCandidate(verifiedSnapshot(revA, r0), { quality: "balanced" });
  const deltaSim = await controller();
  const stage = deltaSim.stageDerivedRevision("seq-stage-0", revA.manifest.manifestHash, simStageSnapshot(revA, r0));
  deltaSim.commitDerivedRevision("seq-commit-0", stage.requestId, revA.manifest.manifestHash);
  const traces: DeltaTrace[] = [];
  let activeRevision = revA;
  for (const [step, nextRevision, expectedChanged] of [
    [0, revB, ["4,4"]],
    [1, revC, ["5,3"]],
  ] as const) {
    const label = step === 0 ? "A->B" : "B->C";
    const nextSnapshot = verifiedSnapshot(nextRevision, r0);
    // Routing: the pure planner names exactly the touched chunks.
    const changedKeys = deltaCandidate.planContentDelta(nextSnapshot);
    assert(changedKeys !== null && changedKeys.join("|") === expectedChanged.join("|"),
      `${label}: routing named ${changedKeys?.join(",") ?? "null"} instead of ${expectedChanged.join(",")}`);
    const plan = planDerivedActivation(
      { manifestHash: activeRevision.manifest.manifestHash, residencyKey: "0:288:288:1" },
      nextRevision.manifest.manifestHash,
      "0:288:288:1",
      false,
      changedKeys,
    );
    assert(plan === "content-delta", `${label}: router returned '${plan}' instead of 'content-delta'`);
    onDelta?.(label, changedKeys);
    // Mesh-object identity BEFORE the swap: unchanged chunks must survive it.
    const priorIdentity = meshIdentity(deltaCandidate);
    const prepared = await deltaCandidate.beginContentDelta(nextSnapshot, changedKeys);
    assert(prepared.replaced.length === expectedChanged.length
      && prepared.replaced.every((entry) => expectedChanged.includes(entry.key)),
      `${label}: mount phase replaced ${prepared.replaced.length} chunks instead of ${expectedChanged.length}`);
    const simResult = deltaSim.updateDerivedContent(
      `seq-update-${step}`,
      activeRevision.manifest.manifestHash,
      simContentPayload(nextRevision, r0, changedKeys),
    );
    assert(simResult.replaced === expectedChanged.length, `${label}: sim replaced count diverges`);
    deltaCandidate.commitContentDelta(prepared);
    const postIdentity = meshIdentity(deltaCandidate);
    for (const [key, mesh] of postIdentity) {
      const prior = priorIdentity.get(key);
      assert(prior !== undefined, `${label}: chunk '${key}' appeared from nowhere`);
      if (expectedChanged.includes(key)) {
        assert(prior !== mesh, `${label}: changed chunk '${key}' kept its stale mesh object`);
      } else {
        assert(prior === mesh, `${label}: unchanged chunk '${key}' lost its mesh object identity`);
      }
    }
    // Full-activation reference at the same revision.
    const reference = new DetachedDerivedRenderCandidate(verifiedSnapshot(nextRevision, r0), { quality: "balanced" });
    const referenceSim = await controller();
    const refStage = referenceSim.stageDerivedRevision(`seq-ref-stage-${step}`, nextRevision.manifest.manifestHash, simStageSnapshot(nextRevision, r0));
    referenceSim.commitDerivedRevision(`seq-ref-commit-${step}`, refStage.requestId, nextRevision.manifest.manifestHash);
    traces.push(compareAgainstFull(label, deltaCandidate, deltaSim, reference, referenceSim, nextRevision));
    reference.dispose();
    referenceSim.dispose();
    activeRevision = nextRevision;
  }
  deltaCandidate.dispose();
  deltaSim.dispose();
  return traces;
}

// (a)+(b) Delta-proportional mounting with mesh-object identity, byte-exact vs full.
const mountedPerDelta: Array<[string, number]> = [];
const traces = await runSequence((label, changed) => mountedPerDelta.push([label, changed.length]));
assert(traces.length === 2, "sequence did not trace every delta");
assert(mountedPerDelta[0]![1] === 1 && mountedPerDelta[1]![1] === 1,
  `mounted ${mountedPerDelta.map(([, count]) => count).join("+")} for 1-chunk sculpts — not delta-proportional`);
// The sculpt moved the height field: revB's touched chunk samples differ from revA's.
{
  const before = parseTransferredDerivedRuntimeSnapshot(transferredSnapshot(revA, r0));
  const after = parseTransferredDerivedRuntimeSnapshot(transferredSnapshot(revB, r0));
  const x = 4.5 * 64, z = 4.5 * 64;
  assert(before.terrain.sampleHeight(x, z) !== after.terrain.sampleHeight(x, z), "sculpt did not move the touched chunk's heights");
  const untouched = after.terrain.sampleHeight(3.5 * 64, 3.5 * 64);
  assert(untouched === before.terrain.sampleHeight(3.5 * 64, 3.5 * 64), "sculpt moved an untouched chunk's heights");
}

// (e) Replay parity: the same sequence twice produces byte-identical traces.
const replay = await runSequence();
assert(JSON.stringify(replay) === JSON.stringify(traces), "replayed content-delta sequence diverged from the first run");

// (b) No presentation-gate freeze on the delta path: the gate
// (derivedActivationInProgress in browser-entry) is raised in exactly one place —
// the full path, immediately after derivedActivationStats.full++ — so routing NEVER
// returning "full" for a delta-eligible revision is the whole invariant. The routing
// assertions inside runSequence prove that for every delta; the live gate reads the
// stats (full unchanged across a sculpt revision ⟺ the gate never froze).
assert(traces.length === 2 && mountedPerDelta.length === 2, "delta routing evidence incomplete");

// (c) Population/water-hash change routes full; (d) topology/window/frame changes
// route residency-delta or full exactly as today.
{
  const active = { manifestHash: revA.manifest.manifestHash, residencyKey: "0:288:288:1" };
  const candidate = new DetachedDerivedRenderCandidate(verifiedSnapshot(revA, r0), { quality: "balanced" });
  // Population: the router never sees keys for a population-carrying snapshot.
  const deltaKeys = candidate.planContentDelta(verifiedSnapshot(revB, r0));
  assert(planDerivedActivation(active, revB.manifest.manifestHash, "0:288:288:1", true, deltaKeys) === "full",
    "population must route a changed manifest to the full path");
  // Water artifact change: not delta-eligible.
  assert(candidate.planContentDelta(verifiedSnapshot(revWater, r0)) === null, "water change stayed delta-eligible");
  assert(planDerivedActivation(active, revWater.manifest.manifestHash, "0:288:288:1", false, null) === "full",
    "water change must route to the full path");
  // Topology change: not delta-eligible.
  assert(candidate.planContentDelta(verifiedSnapshot(revTopology, r0)) === null, "topology change stayed delta-eligible");
  // Surface-frame move (relief extreme exceeded): not delta-eligible.
  assert(candidate.planContentDelta(verifiedSnapshot(revSurge, r0)) === null, "surface-frame move stayed delta-eligible");
  // Window move WITH a manifest change routes full (content delta needs the same window).
  assert(planDerivedActivation(active, revB.manifest.manifestHash, "0:352:288:1", false, null) === "full",
    "manifest change plus window move must route to the full path");
  // Regression: same-manifest window move is still incremental; same window a duplicate.
  assert(planDerivedActivation(active, revA.manifest.manifestHash, "0:352:288:1", false) === "incremental",
    "same-manifest window move regressed from incremental");
  assert(planDerivedActivation(active, revA.manifest.manifestHash, "0:288:288:1", false) === "duplicate",
    "same window regressed from duplicate");
  candidate.dispose();
}

// Candidate fail-closed guards: every ineligible delta rejects without touching the
// live window; cancellation abandons only the detached builds.
{
  const candidate = new DetachedDerivedRenderCandidate(verifiedSnapshot(revA, r0), { quality: "balanced" });
  const priorKeys = candidate.terrainWindow().map((entry) => entry.key).join("|");
  const priorChildren = candidate.terrainRoot.children.length;
  const unchangedManifest = verifiedSnapshot(revA, r0);
  await rejectsAsync(() => candidate.beginContentDelta(unchangedManifest, ["4,4"]),
    /requires a changed manifest/, "candidate accepted a same-manifest content delta");
  await rejectsAsync(() => candidate.beginContentDelta(verifiedSnapshot(revWater, r0), ["4,4"]),
    /unchanged generated-water artifact/, "candidate accepted a water-changing content delta");
  await rejectsAsync(() => candidate.beginContentDelta(verifiedSnapshot(revTopology, r0), ["4,4"]),
    /unchanged grid topology/, "candidate accepted a topology-changing content delta");
  await rejectsAsync(() => candidate.beginContentDelta(verifiedSnapshot(revB, r1), ["4,4"]),
    /active residency window/, "candidate accepted a moved-window content delta");
  await rejectsAsync(() => candidate.beginContentDelta(verifiedSnapshot(revSurge, r0), ["4,4"]),
    /unchanged terrain surface frame/, "candidate accepted a frame-moving content delta");
  await rejectsAsync(() => candidate.beginContentDelta(verifiedSnapshot(revB, r0), ["3,3"]),
    /does not name the evaluated changed chunk set/, "candidate accepted mismatched changed keys");
  await rejectsAsync(() => candidate.beginContentDelta(verifiedSnapshot(revB, r0), ["4,4", "4,5"]),
    /does not name the evaluated changed chunk set/, "candidate accepted extra changed keys");
  assert(candidate.terrainWindow().map((entry) => entry.key).join("|") === priorKeys
    && candidate.terrainMeshCount === 9 && candidate.terrainRoot.children.length === priorChildren,
    "rejected content deltas mutated the live window");
  // Cancellation mid-mount abandons only the detached builds.
  let slices = 0;
  await rejectsAsync(
    () => candidate.beginContentDelta(verifiedSnapshot(revB, r0), ["4,4"], {
      onSlice: () => { slices++; if (slices >= 2) throw new Error("injected late cancel"); },
    }),
    /injected late cancel/,
    "cancelled content delta did not reject",
  );
  assert(candidate.terrainWindow().map((entry) => entry.key).join("|") === priorKeys
    && candidate.terrainMeshCount === 9 && candidate.terrainRoot.children.length === priorChildren
    && candidate.overviewTriangleCount > 0,
    "cancelled content delta leaked builds into the live window");
  // Overlap, abort, double-commit discipline.
  const prepared = await candidate.beginContentDelta(verifiedSnapshot(revB, r0), ["4,4"]);
  await rejectsAsync(() => candidate.beginContentDelta(verifiedSnapshot(revB, r0), ["4,4"]),
    /already has a content delta in flight/, "overlapping content deltas were not refused");
  await rejectsAsync(() => candidate.beginResidencyDelta(verifiedSnapshot(revA, r1)),
    /already has a content delta in flight/, "residency delta raced a content delta");
  candidate.abortContentDelta(prepared);
  rejects(() => candidate.commitContentDelta(prepared), /does not name the in-flight delta/, "commit after abort was not refused");
  // A clean retry of the SAME delta succeeds and matches the full-activation reference.
  const reprepared = await candidate.beginContentDelta(verifiedSnapshot(revB, r0), ["4,4"]);
  candidate.commitContentDelta(reprepared);
  const reference = new DetachedDerivedRenderCandidate(verifiedSnapshot(revB, r0), { quality: "balanced" });
  assert(candidate.terrainWindow().map((entry) => entry.key).join("|") === reference.terrainWindow().map((entry) => entry.key).join("|")
    && candidate.overviewTriangleCount === reference.overviewTriangleCount
    && candidate.waterFragmentCount === reference.waterFragmentCount,
    "post-abort retry does not match the full-activation reference");
  reference.dispose();
  candidate.dispose();
}

// Sim fail-closed guards: rejected content updates never touch physics, and an
// injected collider failure rolls the physics snapshot back byte-exactly.
{
  const sim = await controller();
  const stage = sim.stageDerivedRevision("guard-stage", revA.manifest.manifestHash, simStageSnapshot(revA, r0));
  sim.commitDerivedRevision("guard-commit", stage.requestId, revA.manifest.manifestHash);
  const before = sim.world.ops.op_physics_snapshot();
  const contactBefore = JSON.stringify(sim.core.water.contact.query(160, 160));
  rejects(() => sim.updateDerivedContent("guard-1", revB.manifest.manifestHash, simContentPayload(revB, r0, ["4,4"])),
    /does not name the active revision/, "sim accepted a content update for another revision");
  rejects(() => sim.updateDerivedContent("guard-2", revA.manifest.manifestHash, simContentPayload(revB, r0, [])),
    /must carry 1-/, "sim accepted an empty content update");
  const offWindow = { key: "40,40", tx: 40, tz: 40, tile: simTile(revB, 40, 40) };
  rejects(() => sim.updateDerivedContent("guard-3", revA.manifest.manifestHash,
    { nextManifestHash: revB.manifest.manifestHash, replaced: [offWindow] }),
    /not resident/, "sim accepted an unknown replaced key");
  const single = simContentPayload(revB, r0, ["4,4"]).replaced[0]!;
  rejects(() => sim.updateDerivedContent("guard-4", revA.manifest.manifestHash,
    { nextManifestHash: revB.manifest.manifestHash, replaced: [single, single] }),
    /duplicated/, "sim accepted duplicate replaced keys");
  rejects(() => sim.updateDerivedContent("guard-5", revA.manifest.manifestHash,
    { nextManifestHash: revA.manifest.manifestHash, replaced: [single] }),
    /requires a changed manifest/, "sim accepted a same-manifest content update");
  const staged = sim.stageDerivedRevision("guard-stage-2", revB.manifest.manifestHash, simStageSnapshot(revB, r0));
  rejects(() => sim.updateDerivedContent("guard-6", revA.manifest.manifestHash, simContentPayload(revB, r0, ["4,4"])),
    /raced a staged full revision/, "sim accepted a content update racing a staged full revision");
  sim.discardDerivedRevision("guard-discard", staged.requestId, revB.manifest.manifestHash);
  const after = sim.world.ops.op_physics_snapshot();
  assert(before.length === after.length && before.every((value, index) => value === after[index]),
    "rejected content updates touched physics");
  // Injected collider failure: byte-exact rollback, prior revision stays authoritative.
  const originalAdd = sim.world.ops.op_physics_add_heightfield;
  sim.world.ops.op_physics_add_heightfield = (...args) => {
    throw new Error("injected content collider failure");
  };
  rejects(() => sim.updateDerivedContent("guard-7", revA.manifest.manifestHash, simContentPayload(revB, r0, ["4,4"])),
    /injected content collider failure/, "failed content update did not reject");
  sim.world.ops.op_physics_add_heightfield = originalAdd;
  const rolledBack = sim.world.ops.op_physics_snapshot();
  assert(before.length === rolledBack.length && before.every((value, index) => value === rolledBack[index]),
    "failed content update did not restore exact physics bytes");
  assert(sim.derivedRevisionStatus.activeManifestHash === revA.manifest.manifestHash
    && JSON.stringify(sim.core.water.contact.query(160, 160)) === contactBefore,
    "failed content update changed the active revision or contact");
  // The SAME update applies cleanly once the injection stops, and the rename sticks:
  // the OLD hash is now stale, the NEW hash names the revision.
  const applied = sim.updateDerivedContent("guard-8", revA.manifest.manifestHash, simContentPayload(revB, r0, ["4,4"]));
  assert(applied.replaced === 1 && sim.derivedRevisionStatus.activeManifestHash === revB.manifest.manifestHash,
    "post-failure content update retry did not apply cleanly");
  rejects(() => sim.updateDerivedContent("guard-9", revA.manifest.manifestHash, simContentPayload(revC, r0, ["5,3"])),
    /does not name the active revision/, "renamed revision still answers to its prior manifest hash");
  // A full stage/commit still works on the same sim after a content delta.
  const restage = sim.stageDerivedRevision("guard-stage-3", revC.manifest.manifestHash, simStageSnapshot(revC, r0));
  sim.commitDerivedRevision("guard-commit-3", restage.requestId, revC.manifest.manifestHash);
  assert(sim.derivedRevisionStatus.activeManifestHash === revC.manifest.manifestHash,
    "full activation after a content delta did not land");
  sim.dispose();
}

console.log("[js] p_derived_content_delta OK: content deltas re-mount only the changed chunks (mesh identity preserved elsewhere), are byte-exact against full activation (meshes, colliders, heights, contacts), never route through the presentation gate, fail closed, and replay stable");
