import * as THREE from "../build/three.bundle.mjs";
import {
  DetachedDerivedRenderCandidate,
  parseTransferredDerivedRuntimeSnapshot,
} from "../src/browser/derived-runtime-render-candidate.ts";
import { DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA } from "../src/browser/derived-runtime-worker.ts";
import { DERIVED_TERRAIN_RESIDENCY_SCHEMA } from "../src/browser/derived-terrain-residency.ts";
import { createTerrainGridSpec, terrainChunkId } from "../src/terrain/grid.mjs";
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
} from "../src/world/hydrology-artifact.mjs";
import {
  HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_WATER_ARTIFACT_TYPE,
  encodeHydrologyWaterArtifact,
} from "../src/world/hydrology-water-artifact.mjs";
import { HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA } from "../src/world/hydrology-water-topology.mjs";
import { prepareGeneratedWaterFieldInput } from "../src/world/water-field.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_derived_runtime_render_candidate FAIL: ${message}`);
}

function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}

const hash = (label: string): string => derivedArtifactContentHash(new TextEncoder().encode(label));
const FAR = 9_000_000;
const graphHash = hash("graph");
const grid = createTerrainGridSpec({ gridId: "grey-field.surface", origin: [FAR, FAR], chunkSizeM: 64, defaultSamples: 3 });

function terrain(tx: number, heights: number[]) {
  const bytes = encodeTerrainChunkArtifact({
    nrows: 3,
    ncols: 3,
    origin: [FAR + (tx + 0.5) * 64, 100, FAR + 32],
    scale: [64, 10, 64],
    heights: new Float32Array(heights),
    paintMat: new Uint8Array(9).fill(2),
    paintW: new Float32Array(9).fill(0.5),
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

const terrain0 = terrain(0, [0, 0.25, 0.5, 0.25, 0.5, 0.75, 0.5, 0.75, 1]);
const terrain1 = terrain(1, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
const fieldDescriptor = {
  artifactType: HYDROLOGY_FIELD_ARTIFACT_TYPE,
  contentHash: hash("field"),
  byteLength: 256,
  mediaType: HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE,
};
const waterBindings = Object.freeze({
  hydrologyFieldContentHash: fieldDescriptor.contentHash,
  recipeHash: hash("recipe"),
  erosionStageKey: hash("erosion"),
  compilerGraphHash: graphHash,
});
const waterBytes = encodeHydrologyWaterArtifact({
  schema: HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA,
  version: 1,
  placement: { originX: FAR, originZ: FAR },
  rows: 16,
  cols: 16,
  cellSizeM: 1,
  basins: [{
    id: "gen-b-6-5",
    kind: "lake",
    spillLevelM: 108,
    maxDepthM: 4,
    areaM2: 100,
    cellCount: 100,
    seedCell: 5,
    spillInsideCell: 5,
    spillOutsideCell: 6,
    spillOutsideDrainageRank: 6,
    footprint: { points: [[FAR, FAR], [FAR + 10, FAR], [FAR + 10, FAR + 10], [FAR, FAR + 10]] },
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

const manifest = createDerivedRevisionManifest({
  schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2,
  projectId: "grey-field",
  branchId: "main",
  source: {
    revision: 12,
    headHash: hash("head"),
    contentRefs: [{ refId: "map-document", refType: "map-document/v1", scope: "global", assetId: "maps/grey-field.mapdoc.json", contentHash: hash("map") }],
  },
  compiler: { version: "1.2.0", configHash: hash("config"), graphHash, snapshotHash: hash("snapshot") },
  grid,
  globalArtifacts: [fieldDescriptor, waterDescriptor],
  chunks: Array.from({ length: 400 }, (_, tx) => ({
    chunkId: terrainChunkId(grid.gridId, 0, tx, 0),
    gridId: grid.gridId,
    lod: 0,
    tx,
    tz: 0,
    topologyHash: hash(`topology-${tx}`),
    sourceSliceHashes: [],
    artifacts: [tx === 0 ? terrain0.descriptor : terrain1.descriptor],
  })).sort((left, right) => left.chunkId < right.chunkId ? -1 : left.chunkId > right.chunkId ? 1 : 0),
});

function snapshot(): any {
  return {
    schema: DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA,
    projectId: manifest.projectId,
    branchId: manifest.branchId,
    manifestHash: manifest.manifestHash,
    source: manifest.source,
    manifest,
    residency: { schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA, center: [FAR + 32, FAR + 32], lod: 0, radius: 1 },
    chunks: manifest.chunks.filter((chunk) => chunk.tx <= 1).map((chunk) => ({
      chunkId: chunk.chunkId,
      chunk,
      resource: { kind: "terrain-chunk/v1", decoded: decodeTerrainChunkArtifact(chunk.tx === 0 ? terrain0.bytes : terrain1.bytes) },
    })),
    globals: [
      { artifactType: HYDROLOGY_FIELD_ARTIFACT_TYPE, artifact: fieldDescriptor, resource: { kind: HYDROLOGY_FIELD_ARTIFACT_TYPE, decoded: {} } },
      {
        artifactType: HYDROLOGY_WATER_ARTIFACT_TYPE,
        artifact: waterDescriptor,
        resource: { kind: HYDROLOGY_WATER_ARTIFACT_TYPE, artifact: waterDescriptor, bytes: waterBytes, bindings: waterBindings, prepared: preparedWater },
      },
    ],
  };
}

const transferred = snapshot();
const parsed = parseTransferredDerivedRuntimeSnapshot(transferred);
assert(parsed.manifestHash === manifest.manifestHash && parsed.manifest.chunks.length === 400 && parsed.terrain.size === 2,
  "full manifest identity or exact bounded terrain index changed");
assert(parsed.generatedWater?.bytes === waterBytes && parsed.generatedWater.artifact.contentHash === waterDescriptor.contentHash,
  "canonical raw water resource was not retained for simulation verification");
assert(parsed.terrain.sampleHeight(FAR + 32, FAR + 32) === 105, "O(1) centre sample changed");
assert(parsed.terrain.sampleHeight(FAR + 64, FAR + 32) === 105, "exact shared-edge sample did not select the canonical adjacent chunk");
assert(parsed.terrain.sampleHeight(FAR - 1, FAR + 32) === null, "out-of-domain sample did not fail bounded");
rejects(() => parsed.terrain.sampleHeight(Number.NaN, 0), /finite/, "non-finite sampler input was accepted");

const externalScene = new THREE.Scene();
const candidate = new DetachedDerivedRenderCandidate(transferred, {});
assert(externalScene.children.length === 0 && candidate.root.parent === null, "detached candidate mutated or attached to a live scene");
assert(candidate.terrainMeshCount === 2 && candidate.waterFragmentCount === 1, "bounded terrain/water window did not mount expected resources");
assert(candidate.terrainRoot.children.length === 2 && candidate.waterRoot.children.length === 1, "revision root does not own its complete staged window");
assert(Object.isFrozen(candidate.terrainWindow()) && candidate.terrainWindow().length === 2
  && candidate.terrainWindow().every((entry) => Object.isFrozen(entry) && entry.key === `${entry.tx},${entry.tz}`),
"candidate did not expose an immutable exact initial collider window");
for (const object of candidate.terrainRoot.children) {
  const mesh = object as THREE.Mesh;
  const positions = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
  assert(Math.abs(mesh.position.x) >= FAR, "terrain mesh did not retain its world-space feature origin");
  for (let index = 0; index < positions.count; index++) {
    assert(Math.abs(positions.getX(index)) <= 32 && Math.abs(positions.getZ(index)) <= 32,
      "terrain geometry was not feature-local at large world coordinates");
  }
}
const waterMesh = candidate.waterRoot.children[0] as THREE.Mesh;
candidate.setQuality("cinematic");
assert(candidate.waterRoot.children[0] === waterMesh && candidate.quality.waveCount === 4,
  "quality update replaced semantic water ownership or did not reach the candidate manager");

const wrongSource = snapshot();
wrongSource.source = { ...wrongSource.source, revision: 13 };
rejects(() => parseTransferredDerivedRuntimeSnapshot(wrongSource), /identity/, "envelope/manifest source mismatch was accepted");
const duplicate = snapshot();
duplicate.chunks[1] = duplicate.chunks[0];
rejects(() => parseTransferredDerivedRuntimeSnapshot(duplicate), /manifest order|duplicate/, "duplicate chunk/coordinate was accepted");
const incomplete = snapshot();
incomplete.chunks.pop();
rejects(() => parseTransferredDerivedRuntimeSnapshot(incomplete), /incomplete/, "resident chunk omission was accepted");
const outOfWindow = snapshot();
const firstNonresidentChunk = manifest.chunks.find((chunk) => chunk.tx === 2)!;
outOfWindow.chunks.push({
  chunkId: firstNonresidentChunk.chunkId,
  chunk: firstNonresidentChunk,
  resource: { kind: "terrain-chunk/v1", decoded: decodeTerrainChunkArtifact(terrain1.bytes) },
});
rejects(() => parseTransferredDerivedRuntimeSnapshot(outOfWindow), /incomplete|residency|window/,
  "nonresident manifest resource was accepted into the bounded activation window");
const reordered = snapshot();
reordered.chunks.reverse();
rejects(() => parseTransferredDerivedRuntimeSnapshot(reordered), /manifest order/, "resident chunk reorder was accepted");
const corruptWater = snapshot();
corruptWater.globals[1].resource.bytes = waterBytes.slice();
corruptWater.globals[1].resource.bytes[corruptWater.globals[1].resource.bytes.length - 1] ^= 1;
rejects(() => parseTransferredDerivedRuntimeSnapshot(corruptWater), /canonical descriptor/, "corrupt raw water bytes were accepted");
const wrongPlacement = snapshot();
const misplacedBytes = encodeTerrainChunkArtifact({
  nrows: 3, ncols: 3, origin: [FAR + 31, 100, FAR + 32], scale: [64, 10, 64],
  heights: new Float32Array([0, 0.25, 0.5, 0.25, 0.5, 0.75, 0.5, 0.75, 1]),
  paintMat: new Uint8Array(9).fill(2), paintW: new Float32Array(9).fill(0.5),
});
wrongPlacement.chunks[0].resource.decoded = decodeTerrainChunkArtifact(misplacedBytes);
rejects(() => parseTransferredDerivedRuntimeSnapshot(wrongPlacement), /placement/, "tile/grid placement mismatch was accepted");
rejects(() => new DetachedDerivedRenderCandidate(snapshot(), {
  maxTerrainMeshes: 1,
}), /exceeding budget/, "terrain mesh window budget was enforced after staging");
const emptyResidency = snapshot();
emptyResidency.residency = { schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA, center: [FAR + 10_000, FAR + 10_000], lod: 0, radius: 1 };
rejects(() => new DetachedDerivedRenderCandidate(emptyResidency, {}), /no manifest chunks/, "empty terrain activation window reached simulation staging");

candidate.dispose();
candidate.dispose();
assert(candidate.disposed && candidate.root.children.length === 0 && candidate.terrainMeshCount === 0 && candidate.waterFragmentCount === 0,
  "candidate disposal leaked revision-scoped resources or was not idempotent");

console.log("[js] p_derived_runtime_render_candidate OK: strict 400-chunk snapshot identity with exact bounded resources, canonical raw water, O(1) LOD0 sampling, feature-local detached terrain/water staging, quality, faults, and disposal proven");
