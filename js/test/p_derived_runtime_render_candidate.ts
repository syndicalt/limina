import * as THREE from "../build/three.bundle.mjs";
import {
  DetachedDerivedRenderCandidate,
  parseTransferredDerivedRuntimeSnapshot,
  searchTransferredDerivedNavigation,
} from "../src/browser/derived-runtime-render-candidate.ts";
import { DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA } from "../src/browser/derived-runtime-worker.ts";
import { DERIVED_TERRAIN_RESIDENCY_SCHEMA } from "../src/browser/derived-terrain-residency.ts";
import { createTerrainGridSpec, terrainChunkId } from "../src/terrain/grid.mjs";
import {
  DERIVED_REVISION_MANIFEST_SCHEMA_V2,
  DERIVED_REVISION_MANIFEST_SCHEMA_V3,
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
  NAVIGATION_INDEX_ARTIFACT_MEDIA_TYPE,
  NAVIGATION_INDEX_ARTIFACT_TYPE,
  encodeNavigationIndexArtifact,
} from "../src/world/compiler/navigation-index-artifact.mjs";
import {
  BIOME_FIELD_ARTIFACT_MEDIA_TYPE,
  BIOME_FIELD_ARTIFACT_TYPE,
  encodeBiomeFieldArtifact,
} from "../src/world/compiler/biome-field-artifact.mjs";
import { compileBiomeField } from "../src/world/biome-field.mjs";
import { BIOME_LIBRARY_V1 } from "../src/world/biome-library-v1.mjs";
import { biomePackContentHash } from "../src/world/biome-ir.mjs";
import {
  BIOME_RUNTIME_PACK_SCHEMA,
  biomeRuntimePackContentHash,
  stableStringifyBiomeRuntimePack,
} from "../src/world/biome-runtime-pack.mjs";
import {
  BIOME_RUNTIME_PACK_ARTIFACT_MEDIA_TYPE,
  BIOME_RUNTIME_PACK_ARTIFACT_TYPE,
} from "../src/world/compiler/biome-runtime-pack-artifact.mjs";
import { ATLAS_DESIGN_REF_SCHEMA } from "../src/world/design-ref.mjs";
import {
  HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_FIELD_ARTIFACT_TYPE,
  decodeHydrologyFieldArtifact,
  encodeHydrologyFieldArtifact,
} from "../src/world/hydrology-artifact.mjs";
import { createHydrologyTopology } from "../src/world/hydrology-topology.mjs";
import {
  HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_WATER_ARTIFACT_TYPE,
  encodeHydrologyWaterArtifact,
} from "../src/world/hydrology-water-artifact.mjs";
import { HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA } from "../src/world/hydrology-water-topology.mjs";
import { prepareGeneratedWaterFieldInput } from "../src/world/water-field.mjs";
import { VisibleWaterManager } from "../src/render/water/visible-water-manager.ts";
import {
  SURFACE_COMPOSITE_ARTIFACT_MEDIA_TYPE,
  SURFACE_COMPOSITE_ARTIFACT_TYPE,
  encodeSurfaceCompositeArtifact,
} from "../src/world/compiler/surface-composite-artifact.mjs";
import { SURFACE_COMPOSITE_POLICY_VERSION, SURFACE_COMPOSITE_TILE_SCHEMA } from "../src/world/surface-composite-tile.mjs";
import {
  BIOME_POPULATION_ARTIFACT_MEDIA_TYPE,
  BIOME_POPULATION_ARTIFACT_SCHEMA,
  BIOME_POPULATION_ARTIFACT_TYPE,
  decodeBiomePopulationArtifact,
  encodeBiomePopulationArtifact,
} from "../src/world/compiler/biome-population-artifact.mjs";
import {
  BIOME_CONTENT_CLOSURE_ARTIFACT_MEDIA_TYPE,
  BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE,
  encodeBiomeContentClosureArtifact,
} from "../src/world/compiler/biome-content-closure-artifact.mjs";
import {
  BIOME_CONTENT_BUNDLE_SCHEMA,
  deriveBiomeContentBundleClosureHash,
} from "../src/world/biome-content-bundle.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_derived_runtime_render_candidate FAIL: ${message}`);
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

function structuredCloneFixture<T>(value: T, seen = new Map<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  const prior = seen.get(value);
  if (prior !== undefined) return prior as T;
  if (value instanceof ArrayBuffer) return value.slice(0) as T;
  if (ArrayBuffer.isView(value)) {
    const source = value as Exclude<ArrayBufferView, DataView>;
    const Constructor = source.constructor as { new (source: ArrayLike<number>): typeof source };
    return new Constructor(source as unknown as ArrayLike<number>) as T;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const entry of value) copy.push(structuredCloneFixture(entry, seen));
    return copy as T;
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, entry] of Object.entries(value)) copy[key] = structuredCloneFixture(entry, seen);
  return copy as T;
}

function collectNodeGraph(root: any): { textures: THREE.Texture[]; constants: number[] } {
  const seen = new Set<unknown>();
  const textures: THREE.Texture[] = [];
  const constants: number[] = [];
  function walk(node: any): void {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (node.isTextureNode && node.value?.isTexture && !textures.includes(node.value)) textures.push(node.value);
    if (node.constructor?.name === "ConstNode" && typeof node.value === "number") constants.push(node.value);
    if (typeof node.getChildren === "function") for (const child of node.getChildren()) walk(child);
  }
  walk(root);
  return { textures, constants };
}

const hash = (label: string): string => derivedArtifactContentHash(new TextEncoder().encode(label));
const FAR = 9_000_000;
const graphHash = hash("graph");
const grid = createTerrainGridSpec({ gridId: "grey-field.surface", origin: [FAR, FAR], chunkSizeM: 64, defaultSamples: 3 });
const runtimeBiome = BIOME_LIBRARY_V1.definitions[0];
const populationRuntimePackDocument = {
  schema: BIOME_RUNTIME_PACK_SCHEMA,
  id: "test-runtime",
  version: "1.0.0",
  metadataPackContentHash: biomePackContentHash(BIOME_LIBRARY_V1),
  status: "metadata-only",
  biomes: [{
    biomeId: runtimeBiome.id,
    status: "metadata-only",
    surfaceRules: runtimeBiome.surfaceMaterials
      .map(({ role }) => ({ role, weight: 1, tileScaleM: 4 }))
      .sort((left, right) => left.role.localeCompare(right.role)),
    vegetationRules: runtimeBiome.vegetationPalette
      .map(({ role, weight }) => ({ role, weight, radiusM: 1.5, density01: 0.5,
        scale: [0.8, 1.2], tintSrgb: [255, 255, 255] }))
      .sort((left, right) => left.role.localeCompare(right.role)),
    bindings: [],
  }],
};
const populationRuntimePackBytes = new TextEncoder().encode(
  stableStringifyBiomeRuntimePack(populationRuntimePackDocument, BIOME_LIBRARY_V1),
);
const populationPackHash = biomeRuntimePackContentHash(populationRuntimePackDocument, BIOME_LIBRARY_V1);
const populationRuntimePackDescriptor = Object.freeze({
  artifactType: BIOME_RUNTIME_PACK_ARTIFACT_TYPE,
  contentHash: derivedArtifactContentHash(populationRuntimePackBytes),
  byteLength: populationRuntimePackBytes.byteLength,
  mediaType: BIOME_RUNTIME_PACK_ARTIFACT_MEDIA_TYPE,
});

function terrain(tx: number, heights: number[]) {
  const climate = new Float32Array(9 * 3);
  const blight = new Float32Array(9);
  for (let index = 0; index < 9; index++) {
    climate[index * 3] = -8 + index * 4;
    climate[index * 3 + 1] = 200 + index * 180;
    climate[index * 3 + 2] = index % 7;
    blight[index] = index / 8;
  }
  const bytes = encodeTerrainChunkArtifact({
    nrows: 3,
    ncols: 3,
    origin: [FAR + (tx + 0.5) * 64, 100, FAR + 32],
    scale: [64, 10, 64],
    heights: new Float32Array(heights),
    paintMat: new Uint8Array(9).fill(2),
    paintW: new Float32Array(9).fill(0.5),
    climate,
    climateChannels: 3,
    blight,
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

function surface(tx: number, terrainHash: string, total = 2, tz = 0) {
  const pixels = total * total;
  const albedo = new Uint8Array(pixels * 4).fill(72 + tx);
  const normal = new Uint8Array(pixels * 4).fill(128);
  const orm = new Uint8Array(pixels * 4).fill(192);
  for (let offset = 3; offset < pixels * 4; offset += 4) {
    albedo[offset] = 255;
    normal[offset] = 255;
    orm[offset] = 255;
  }
  const decoded = {
    schema: SURFACE_COMPOSITE_TILE_SCHEMA,
    source: { biomeFieldHash: biomeFieldDescriptor.contentHash, biomePackHash: populationPackHash, terrainChunkHash: terrainHash, policyVersion: SURFACE_COMPOSITE_POLICY_VERSION },
    coord: { tx, tz, lod: 0 },
    placement: { origin: [FAR + tx * 64, FAR + tz * 64], sizeM: 64, featureOrigin: [FAR, FAR] },
    resolution: { interior: total, gutter: 0, total },
    maps: {
      albedo: { data: albedo, contentHash: derivedArtifactContentHash(albedo), colorSpace: "srgb" },
      normal: { data: normal, contentHash: derivedArtifactContentHash(normal), colorSpace: "none", convention: "opengl-y-plus" },
      orm: { data: orm, contentHash: derivedArtifactContentHash(orm), colorSpace: "none", channels: "ao-roughness-metalness-grass-density" },
    },
    edgeHashes: { north: hash(`north-${tx}-${tz}`), east: hash(`east-${tx}-${tz}`), south: hash(`south-${tx}-${tz}`), west: hash(`west-${tx}-${tz}`) },
    diagnostics: { roles: 1, runtimeTextureSamples: 3, outputBytes: pixels * 4 * 3 },
  };
  const bytes = encodeSurfaceCompositeArtifact(decoded);
  return {
    decoded,
    descriptor: {
      artifactType: SURFACE_COMPOSITE_ARTIFACT_TYPE,
      contentHash: derivedArtifactContentHash(bytes),
      byteLength: bytes.byteLength,
      mediaType: SURFACE_COMPOSITE_ARTIFACT_MEDIA_TYPE,
    },
  };
}
const overviewCells = 129 * 129;
const overviewPaintMaterial = new Uint8Array(overviewCells).fill(2);
const overviewPaintWeight = new Uint8Array(overviewCells).fill(128);
overviewPaintMaterial[0] = 5;
overviewPaintWeight[0] = 255;
const overviewBytes = encodeWorldOverviewArtifact({
  rows: 129,
  cols: 129,
  origin: [FAR, FAR],
  stepM: 200,
  heights: new Float32Array(overviewCells).fill(100),
  paintMaterial: overviewPaintMaterial,
  paintWeight: overviewPaintWeight,
});
const overviewDescriptor = {
  artifactType: WORLD_OVERVIEW_ARTIFACT_TYPE,
  contentHash: derivedArtifactContentHash(overviewBytes),
  byteLength: overviewBytes.byteLength,
  mediaType: WORLD_OVERVIEW_ARTIFACT_MEDIA_TYPE,
};
const navigationBytes = encodeNavigationIndexArtifact({
  worldBounds: { minX: FAR, minZ: FAR, maxX: FAR + 25_600, maxZ: FAR + 25_600 },
  entries: [{
    designRef: { schema: ATLAS_DESIGN_REF_SCHEMA, mapId: "primary", kind: "place", id: "old-mill" },
    position: [FAR + 320, FAR + 640],
    radiusM: 24,
    label: "Old Mill",
    kind: "village",
    searchKeys: ["old mill", "mill"],
  }],
});
const navigationDescriptor = {
  artifactType: NAVIGATION_INDEX_ARTIFACT_TYPE,
  contentHash: derivedArtifactContentHash(navigationBytes),
  byteLength: navigationBytes.byteLength,
  mediaType: NAVIGATION_INDEX_ARTIFACT_MEDIA_TYPE,
};
const biomeFieldSource = compileBiomeField({
  pack: BIOME_LIBRARY_V1,
  grid: { origin: [FAR, FAR], rows: 2, cols: 2, cellSizeM: 64 },
  samples: {
    temperatureC: new Float32Array([12, 18, -8, 4]),
    moisture01: new Float32Array([0.6, 0.2, 0.8, 0.4]),
    elevationM: new Float32Array([100, 120, 180, 140]),
    slope01: new Float32Array([0.1, 0.2, 0.4, 0.3]),
    waterDistanceM: new Float32Array([10, 40, 80, 20]),
  },
  influences: [],
  modifiers: [],
  topN: 4,
  climateFeather: { temperatureC: 6, moisture01: 0.2 },
});
const biomeFieldBytes = encodeBiomeFieldArtifact(biomeFieldSource);
const biomeFieldDescriptor = {
  artifactType: BIOME_FIELD_ARTIFACT_TYPE,
  contentHash: derivedArtifactContentHash(biomeFieldBytes),
  byteLength: biomeFieldBytes.byteLength,
  mediaType: BIOME_FIELD_ARTIFACT_MEDIA_TYPE,
};
const fieldTopology = createHydrologyTopology({
  rows: 16,
  cols: 16,
  heightsM: new Float64Array(16 * 16).fill(100),
  cellSizeM: 1,
  seaLevelM: 90,
  precipitationMmPerYear: 800,
});
const fieldBytes = encodeHydrologyFieldArtifact(fieldTopology, { originX: FAR, originZ: FAR });
const fieldDescriptor = {
  artifactType: HYDROLOGY_FIELD_ARTIFACT_TYPE,
  contentHash: derivedArtifactContentHash(fieldBytes),
  byteLength: fieldBytes.byteLength,
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
  globalArtifacts: [fieldDescriptor, waterDescriptor, navigationDescriptor, overviewDescriptor],
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

const biomeManifest = createDerivedRevisionManifest({
  schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2,
  projectId: manifest.projectId,
  branchId: manifest.branchId,
  source: manifest.source,
  compiler: manifest.compiler,
  grid: manifest.grid,
  globalArtifacts: [biomeFieldDescriptor, ...manifest.globalArtifacts],
  chunks: manifest.chunks,
});

const surface0 = surface(0, terrain0.descriptor.contentHash);
const surface1 = surface(1, terrain1.descriptor.contentHash);
const surfaceManifest = createDerivedRevisionManifest({
  schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2,
  projectId: biomeManifest.projectId,
  branchId: biomeManifest.branchId,
  source: biomeManifest.source,
  compiler: biomeManifest.compiler,
  grid: biomeManifest.grid,
  globalArtifacts: biomeManifest.globalArtifacts,
  chunks: biomeManifest.chunks.map((chunk) => chunk.tx === 0 || chunk.tx === 1 ? {
    ...chunk,
    artifacts: [chunk.tx === 0 ? surface0.descriptor : surface1.descriptor, chunk.artifacts[0]],
  } : chunk),
});

function population(tx: number, role: string, assetId: string, override: Readonly<{
  coordTx?: number;
  fieldContentHash?: string;
  runtimePackContentHash?: string;
}> = {}) {
  const bytes = encodeBiomePopulationArtifact({
    schema: BIOME_POPULATION_ARTIFACT_SCHEMA,
    coord: { tx: override.coordTx ?? tx, tz: 0, lod: 0 },
    identity: {
      fieldContentHash: override.fieldContentHash ?? biomeFieldDescriptor.contentHash,
      runtimePackContentHash: override.runtimePackContentHash ?? populationPackHash,
    },
    placements: [{
      role,
      assetId,
      contentHash: hash(`${assetId}-descriptor`),
      x: FAR + tx * 64 + 16,
      y: 105,
      z: FAR + 24,
      yaw: tx * 0.25,
      scale: 1 + tx * 0.1,
      pageX: tx,
      pageZ: 0,
    }],
  });
  return Object.freeze({
    bytes,
    decoded: decodeBiomePopulationArtifact(bytes),
    descriptor: Object.freeze({
      artifactType: BIOME_POPULATION_ARTIFACT_TYPE,
      contentHash: derivedArtifactContentHash(bytes),
      byteLength: bytes.byteLength,
      mediaType: BIOME_POPULATION_ARTIFACT_MEDIA_TYPE,
    }),
  });
}
const population0 = population(0, "canopy", "population/oak.json");
const population1 = population(1, "forest-grass", "population/forest-grass.json");
const mechanicalEvidenceHash = hash("population-mechanical-evidence");
function contentClosure(oakContentHash = hash("population/oak.json-descriptor")) {
  const mechanicalEvidence = Object.freeze({
    assetId: "evidence/population-mechanical",
    contentHash: mechanicalEvidenceHash,
  });
  const draft = {
    schema: BIOME_CONTENT_BUNDLE_SCHEMA,
    id: "test-temperate-population",
    version: "1.0.0",
    status: "candidate",
    runtimePack: { assetId: "biomes/test-runtime.json", contentHash: populationPackHash },
    entries: [
      {
        assetId: mechanicalEvidence.assetId,
        contentHash: mechanicalEvidence.contentHash,
        kind: "mechanical-evidence",
        byteLength: 256,
        provenance: { licenseSpdx: "MIT", sourceUri: "limina://test/population-mechanical-evidence" },
      },
      {
        assetId: "population/forest-grass.json",
        contentHash: hash("population/forest-grass.json-descriptor"),
        kind: "population-descriptor",
        byteLength: 512,
        provenance: { licenseSpdx: "MIT", sourceUri: "limina://test/forest-grass-descriptor" },
        acceptance: { mechanicalEvidence },
      },
      {
        assetId: "population/oak.json",
        contentHash: oakContentHash,
        kind: "population-descriptor",
        byteLength: 512,
        provenance: { licenseSpdx: "MIT", sourceUri: "limina://test/oak-descriptor" },
        acceptance: { mechanicalEvidence },
      },
    ],
  };
  const bundle = Object.freeze({ ...draft, closureHash: deriveBiomeContentBundleClosureHash(draft) });
  const bytes = encodeBiomeContentClosureArtifact(bundle);
  return Object.freeze({
    bundle,
    bytes,
    descriptor: Object.freeze({
      artifactType: BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE,
      contentHash: derivedArtifactContentHash(bytes),
      byteLength: bytes.byteLength,
      mediaType: BIOME_CONTENT_CLOSURE_ARTIFACT_MEDIA_TYPE,
    }),
  });
}
const populationContent = contentClosure();
const populationManifest = createDerivedRevisionManifest({
  schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2,
  projectId: surfaceManifest.projectId,
  branchId: surfaceManifest.branchId,
  source: surfaceManifest.source,
  compiler: surfaceManifest.compiler,
  grid: surfaceManifest.grid,
  globalArtifacts: [...surfaceManifest.globalArtifacts, populationContent.descriptor, populationRuntimePackDescriptor]
    .sort((left, right) => left.artifactType.localeCompare(right.artifactType)),
  chunks: surfaceManifest.chunks.map((chunk) => chunk.tx === 0 || chunk.tx === 1 ? {
    ...chunk,
    artifacts: [...chunk.artifacts, chunk.tx === 0 ? population0.descriptor : population1.descriptor]
      .sort((left, right) => left.artifactType.localeCompare(right.artifactType)),
  } : chunk),
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
        artifactType: NAVIGATION_INDEX_ARTIFACT_TYPE,
        artifact: navigationDescriptor,
        resource: { kind: NAVIGATION_INDEX_ARTIFACT_TYPE, bytes: navigationBytes },
      },
      {
        artifactType: WORLD_OVERVIEW_ARTIFACT_TYPE,
        artifact: overviewDescriptor,
        resource: { kind: WORLD_OVERVIEW_ARTIFACT_TYPE, decoded: decodeWorldOverviewArtifact(overviewBytes) },
      },
    ],
  };
}

function carriedWaterSnapshot(authorizedGraphHash = graphHash): any {
  const outerManifest = createDerivedRevisionManifest({
    schema: DERIVED_REVISION_MANIFEST_SCHEMA_V3,
    projectId: manifest.projectId,
    branchId: manifest.branchId,
    source: manifest.source,
    compiler: { ...manifest.compiler, version: "1.4.0", graphHash: hash("published-outer-graph") },
    grid: manifest.grid,
    artifactAuthorities: [{ artifactType: HYDROLOGY_WATER_ARTIFACT_TYPE, compilerGraphHash: authorizedGraphHash }],
    globalArtifacts: manifest.globalArtifacts,
    chunks: manifest.chunks,
  });
  const value = snapshot();
  value.manifest = outerManifest;
  value.manifestHash = outerManifest.manifestHash;
  value.source = outerManifest.source;
  value.chunks = value.chunks.map((entry: any) => ({ ...entry,
    chunk: outerManifest.chunks.find((chunk) => chunk.chunkId === entry.chunkId)! }));
  return value;
}

function carriedWaterWithoutAuthoritySnapshot(): any {
  const value = carriedWaterSnapshot();
  const outerManifest = createDerivedRevisionManifest({
    schema: DERIVED_REVISION_MANIFEST_SCHEMA_V3,
    projectId: value.manifest.projectId, branchId: value.manifest.branchId, source: value.manifest.source,
    compiler: value.manifest.compiler, grid: value.manifest.grid, artifactAuthorities: [],
    globalArtifacts: value.manifest.globalArtifacts, chunks: value.manifest.chunks,
  });
  value.manifest = outerManifest; value.manifestHash = outerManifest.manifestHash; value.source = outerManifest.source;
  value.chunks = value.chunks.map((entry: any) => ({ ...entry,
    chunk: outerManifest.chunks.find((chunk) => chunk.chunkId === entry.chunkId)! }));
  return value;
}

function biomeSnapshot(): any {
  const value = snapshot();
  value.manifest = biomeManifest;
  value.manifestHash = biomeManifest.manifestHash;
  value.source = biomeManifest.source;
  value.globals.unshift({
    artifactType: BIOME_FIELD_ARTIFACT_TYPE,
    artifact: biomeFieldDescriptor,
    resource: { kind: BIOME_FIELD_ARTIFACT_TYPE, bytes: biomeFieldBytes },
  });
  return value;
}

function surfaceSnapshot(): any {
  const value = biomeSnapshot();
  value.manifest = surfaceManifest;
  value.manifestHash = surfaceManifest.manifestHash;
  value.source = surfaceManifest.source;
  value.chunks = surfaceManifest.chunks.filter((chunk) => chunk.tx <= 1).map((chunk) => {
    const composite = chunk.tx === 0 ? surface0 : surface1;
    const terrainArtifact = chunk.artifacts.find((artifact) => artifact.artifactType === "terrain-chunk/v1")!;
    const surfaceArtifact = chunk.artifacts.find((artifact) => artifact.artifactType === SURFACE_COMPOSITE_ARTIFACT_TYPE)!;
    return {
      chunkId: chunk.chunkId,
      chunk,
      resource: {
        kind: "terrain-chunk/v1",
        decoded: decodeTerrainChunkArtifact(chunk.tx === 0 ? terrain0.bytes : terrain1.bytes),
        surface: composite.decoded,
        artifacts: { terrain: terrainArtifact, surface: surfaceArtifact },
      },
    };
  });
  return value;
}

function populationSnapshot(): any {
  const value = surfaceSnapshot();
  value.manifest = populationManifest;
  value.manifestHash = populationManifest.manifestHash;
  value.source = populationManifest.source;
  value.globals.push({
    artifactType: BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE,
    artifact: populationContent.descriptor,
    resource: { kind: BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE, bytes: populationContent.bytes },
  });
  value.globals.push({
    artifactType: BIOME_RUNTIME_PACK_ARTIFACT_TYPE,
    artifact: populationRuntimePackDescriptor,
    resource: { kind: BIOME_RUNTIME_PACK_ARTIFACT_TYPE, bytes: populationRuntimePackBytes },
  });
  value.chunks = populationManifest.chunks.filter((chunk) => chunk.tx <= 1).map((chunk) => {
    const prior = value.chunks.find((entry: any) => entry.chunk.tx === chunk.tx)!;
    const populationResource = chunk.tx === 0 ? population0 : population1;
    const terrainArtifact = chunk.artifacts.find((artifact) => artifact.artifactType === "terrain-chunk/v1")!;
    const surfaceArtifact = chunk.artifacts.find((artifact) => artifact.artifactType === SURFACE_COMPOSITE_ARTIFACT_TYPE)!;
    const populationArtifact = chunk.artifacts.find((artifact) => artifact.artifactType === BIOME_POPULATION_ARTIFACT_TYPE)!;
    return {
      chunkId: chunk.chunkId,
      chunk,
      resource: {
        ...prior.resource,
        population: populationResource.decoded,
        artifacts: { terrain: terrainArtifact, surface: surfaceArtifact, population: populationArtifact },
      },
    };
  });
  return value;
}

function withContentClosureOverride(value: any, replacement: ReturnType<typeof contentClosure> | null): any {
  const globalArtifacts = value.manifest.globalArtifacts
    .filter((artifact: any) => artifact.artifactType !== BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE);
  if (replacement !== null) globalArtifacts.push(replacement.descriptor);
  globalArtifacts.sort((left: any, right: any) => left.artifactType.localeCompare(right.artifactType));
  const nextManifest = createDerivedRevisionManifest({
    schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2,
    projectId: value.manifest.projectId,
    branchId: value.manifest.branchId,
    source: value.manifest.source,
    compiler: value.manifest.compiler,
    grid: value.manifest.grid,
    globalArtifacts,
    chunks: value.manifest.chunks,
  });
  value.manifest = nextManifest;
  value.manifestHash = nextManifest.manifestHash;
  value.source = nextManifest.source;
  value.chunks = value.chunks.map((entry: any) => ({
    ...entry,
    chunk: nextManifest.chunks.find((chunk) => chunk.chunkId === entry.chunkId)!,
  }));
  value.globals = value.globals.filter((entry: any) => entry.artifactType !== BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE);
  if (replacement !== null) value.globals.push({
    artifactType: BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE,
    artifact: replacement.descriptor,
    resource: { kind: BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE, bytes: replacement.bytes },
  });
  return value;
}

function withoutRuntimePack(value: any): any {
  const nextManifest = createDerivedRevisionManifest({
    schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2,
    projectId: value.manifest.projectId,
    branchId: value.manifest.branchId,
    source: value.manifest.source,
    compiler: value.manifest.compiler,
    grid: value.manifest.grid,
    globalArtifacts: value.manifest.globalArtifacts
      .filter((artifact: any) => artifact.artifactType !== BIOME_RUNTIME_PACK_ARTIFACT_TYPE),
    chunks: value.manifest.chunks,
  });
  value.manifest = nextManifest;
  value.manifestHash = nextManifest.manifestHash;
  value.source = nextManifest.source;
  value.chunks = value.chunks.map((entry: any) => ({
    ...entry,
    chunk: nextManifest.chunks.find((chunk) => chunk.chunkId === entry.chunkId)!,
  }));
  value.globals = value.globals.filter((entry: any) => entry.artifactType !== BIOME_RUNTIME_PACK_ARTIFACT_TYPE);
  return value;
}

function withPopulationOverride(value: any, tx: number, replacement: ReturnType<typeof population>): any {
  const nextManifest = createDerivedRevisionManifest({
    schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2,
    projectId: value.manifest.projectId,
    branchId: value.manifest.branchId,
    source: value.manifest.source,
    compiler: value.manifest.compiler,
    grid: value.manifest.grid,
    globalArtifacts: value.manifest.globalArtifacts,
    chunks: value.manifest.chunks.map((chunk: any) => chunk.tx === tx ? {
      ...chunk,
      artifacts: [...chunk.artifacts.filter((artifact: any) => artifact.artifactType !== BIOME_POPULATION_ARTIFACT_TYPE), replacement.descriptor]
        .sort((left: any, right: any) => left.artifactType.localeCompare(right.artifactType)),
    } : chunk),
  });
  value.manifest = nextManifest;
  value.manifestHash = nextManifest.manifestHash;
  value.source = nextManifest.source;
  value.chunks = value.chunks.map((entry: any) => {
    const chunk = nextManifest.chunks.find((candidate: any) => candidate.chunkId === entry.chunkId)!;
    if (chunk.tx !== tx) return { ...entry, chunk };
    return { ...entry, chunk, resource: { ...entry.resource, population: replacement.decoded,
      artifacts: { ...entry.resource.artifacts, population: replacement.descriptor } } };
  });
  return value;
}

const transferred = structuredCloneFixture(snapshot());
const parsed = parseTransferredDerivedRuntimeSnapshot(transferred);
const parsedCarriedWater = parseTransferredDerivedRuntimeSnapshot(carriedWaterSnapshot());
assert(parsedCarriedWater.generatedWater?.bindings.compilerGraphHash === graphHash
  && parsedCarriedWater.manifest.compiler.graphHash !== graphHash,
"v3 did not accept water bound to its explicitly authorized carried base graph");
rejects(() => parseTransferredDerivedRuntimeSnapshot(carriedWaterSnapshot(hash("unauthorized-water-graph"))),
  /bytes, field, or compiler graph/, "v3 accepted carried water without its exact base-graph authority");
rejects(() => parseTransferredDerivedRuntimeSnapshot(carriedWaterWithoutAuthoritySnapshot()),
  /bytes, field, or compiler graph/, "v3 silently treated carried water as an outer-graph artifact when authority was absent");
assert(parsed.manifestHash === manifest.manifestHash && parsed.manifest.chunks.length === 400 && parsed.terrain.size === 2,
  "full manifest identity or exact bounded terrain index changed");
assert(parsed.generatedWater?.bytes.byteLength === waterBytes.byteLength
  && parsed.generatedWater.artifact.contentHash === waterDescriptor.contentHash,
  "canonical raw water resource was not retained for simulation verification");
assert(parsed.generatedWater.render.field.rows === 16 && parsed.generatedWater.render.field.cols === 16
  && parsed.generatedWater.render.field.oceanMask.length === 256,
  "canonical hydrology field was not retained for bounded render depth authority");
assert(parsed.worldOverview?.metadata.byteLength === overviewBytes.byteLength,
  "canonical world overview was not retained for render staging");
assert(parsed.biomeField === null && parsed.biomeSampler === null, "legacy manifest without a biome field changed behavior");
const transferredBiome = structuredCloneFixture(biomeSnapshot());
const parsedBiome = parseTransferredDerivedRuntimeSnapshot(transferredBiome);
assert(parsedBiome.biomeField?.metadata.contentHash === biomeFieldDescriptor.contentHash
  && parsedBiome.biomeField.metadata.mediaType === BIOME_FIELD_ARTIFACT_MEDIA_TYPE
  && parsedBiome.biomeField.field.indices[0] === biomeFieldSource.indices[0]
  && parsedBiome.biomeField.field.weights[0] === biomeFieldSource.weights[0]
  && parsedBiome.biomeField.field.indices.buffer !== transferredBiome.globals[0].resource.bytes.buffer
  && parsedBiome.biomeField.field.weights.buffer !== transferredBiome.globals[0].resource.bytes.buffer
  && parsedBiome.biomeField.field.indices.buffer !== parsedBiome.biomeField.field.weights.buffer,
"canonical biome bytes did not rebuild verified main-realm owned field channels");
const sampledBiome = parsedBiome.biomeSampler?.sample(FAR, FAR);
assert(sampledBiome?.dominantId === biomeFieldSource.biomeIds[biomeFieldSource.indices[0]]
  && sampledBiome.influences.reduce((sum, influence) => sum + influence.weightU16, 0) === 0xffff,
"verified biome field did not become an exact world-coordinate runtime sampler");
const transferredSurface = structuredCloneFixture(surfaceSnapshot());
const parsedSurface = parseTransferredDerivedRuntimeSnapshot(transferredSurface);
assert(parsedSurface.surfaceAt(0, 0)?.artifact.contentHash === surface0.descriptor.contentHash
  && parsedSurface.surfaceAt(1, 0)?.decoded.source.terrainChunkHash === terrain1.descriptor.contentHash
  && parsedSurface.surfaceAt(2, 0) === undefined,
"main-realm verification did not retain exact descriptor-bound surfaces by tile coordinate");
const transferredPopulation = structuredCloneFixture(populationSnapshot());
const parsedPopulation = parseTransferredDerivedRuntimeSnapshot(transferredPopulation);
assert(parsedPopulation.populationAt(0, 0)?.artifact.contentHash === population0.descriptor.contentHash
  && parsedPopulation.populationAt(1, 0)?.plan.placements[0]?.assetId === "population/forest-grass.json"
  && parsedPopulation.populationAt(2, 0) === undefined,
"main-realm verification did not retain exact descriptor-bound populations by tile coordinate");
assert(parsedPopulation.populationPlan?.schema === "limina.detached-derived-population-plan/v1"
  && parsedPopulation.populationPlan.identity.fieldContentHash === biomeFieldDescriptor.contentHash
  && parsedPopulation.populationPlan.identity.runtimePackContentHash === populationPackHash
  && parsedPopulation.populationPlan.placements.map((placement) => placement.assetId).join(",")
    === "population/oak.json,population/forest-grass.json"
  && Object.isFrozen(parsedPopulation.populationPlan)
  && Object.isFrozen(parsedPopulation.populationPlan.chunks)
  && Object.isFrozen(parsedPopulation.populationPlan.placements)
  && parsedPopulation.populationPlan.placements !== transferredPopulation.chunks[0].resource.population.plan.placements
  && parsedPopulation.retainedCpuBytes >= population0.descriptor.byteLength + population1.descriptor.byteLength,
"population chunks were not independently owned, deterministically aggregated, immutable, or retained-byte-accounted");
assert(parsedPopulation.biomeContent?.status === "candidate"
  && parsedPopulation.biomeContent.runtimePack.contentHash === populationPackHash
  && parsedPopulation.biomeContent.entries.length === 3
  && Object.isFrozen(parsedPopulation.biomeContent)
  && Object.isFrozen(parsedPopulation.biomeContent.entries),
"candidate content closure was not independently verified, retained, and frozen");
const missingPopulationClosure = withContentClosureOverride(populationSnapshot(), null);
rejects(() => parseTransferredDerivedRuntimeSnapshot(missingPopulationClosure), /missing its content closure/,
  "population publication without its mandatory content closure was accepted");
const missingPopulationRuntimePack = withoutRuntimePack(populationSnapshot());
rejects(() => parseTransferredDerivedRuntimeSnapshot(missingPopulationRuntimePack), /missing its runtime-pack artifact/,
  "population publication without its mandatory runtime-pack artifact was accepted");
const mismatchedPopulationRuntimePack = populationSnapshot();
const mismatchedRuntimePackBytes = populationRuntimePackBytes.slice();
mismatchedRuntimePackBytes[mismatchedRuntimePackBytes.byteLength - 2] ^= 1;
mismatchedPopulationRuntimePack.globals = mismatchedPopulationRuntimePack.globals.map((entry: any) =>
  entry.artifactType === BIOME_RUNTIME_PACK_ARTIFACT_TYPE
    ? { ...entry, resource: { ...entry.resource, bytes: mismatchedRuntimePackBytes } }
    : entry);
rejects(() => parseTransferredDerivedRuntimeSnapshot(mismatchedPopulationRuntimePack), /canonical descriptor/,
  "population publication with mismatched runtime-pack bytes was accepted");
const unauthorizedPopulationDescriptor = withContentClosureOverride(populationSnapshot(), contentClosure(hash("stale-oak-descriptor")));
rejects(() => parseTransferredDerivedRuntimeSnapshot(unauthorizedPopulationDescriptor), /not authorized by its content closure/,
  "population descriptor whose hash was absent from the content closure was accepted");
const tamperedPopulation = structuredCloneFixture(populationSnapshot());
tamperedPopulation.chunks[0].resource.population.plan.placements[0].x += 1;
rejects(() => parseTransferredDerivedRuntimeSnapshot(tamperedPopulation), /canonical descriptor/,
  "main-realm population parse trusted a worker-decoded plan without re-verifying descriptor hash and length");
const duplicatePopulationArtifact = structuredCloneFixture(populationSnapshot());
const duplicatePopulationChunk = duplicatePopulationArtifact.manifest.chunks.find((chunk: any) => chunk.tx === 0)!;
duplicatePopulationChunk.artifacts.splice(1, 0, { ...duplicatePopulationChunk.artifacts[0] });
rejects(() => parseTransferredDerivedRuntimeSnapshot(duplicatePopulationArtifact), /strictly ordered and unique|duplicate/,
  "duplicate population artifact descriptor reached candidate parsing");
const wrongPopulationCoord = withPopulationOverride(populationSnapshot(), 0,
  population(0, "canopy", "population/oak.json", { coordTx: 7 }));
rejects(() => parseTransferredDerivedRuntimeSnapshot(wrongPopulationCoord), /coordinate does not match/,
  "population artifact bound to another chunk coordinate was accepted");
const wrongPopulationField = withPopulationOverride(populationSnapshot(), 0,
  population(0, "canopy", "population/oak.json", { fieldContentHash: hash("other-biome-field") }));
rejects(() => parseTransferredDerivedRuntimeSnapshot(wrongPopulationField), /biome-field identity does not match/,
  "population artifact bound to another biome field was accepted");
const wrongPopulationPack = withPopulationOverride(populationSnapshot(), 0,
  population(0, "canopy", "population/oak.json", { runtimePackContentHash: hash("other-runtime-pack") }));
rejects(() => parseTransferredDerivedRuntimeSnapshot(wrongPopulationPack), /runtime-pack identity does not match/,
  "population artifact bound to another surface runtime pack was accepted");
const missingPopulationSurface = populationSnapshot();
const missingPopulationSurfaceManifest = createDerivedRevisionManifest({
  schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2,
  projectId: missingPopulationSurface.manifest.projectId,
  branchId: missingPopulationSurface.manifest.branchId,
  source: missingPopulationSurface.manifest.source,
  compiler: missingPopulationSurface.manifest.compiler,
  grid: missingPopulationSurface.manifest.grid,
  globalArtifacts: missingPopulationSurface.manifest.globalArtifacts,
  chunks: missingPopulationSurface.manifest.chunks.map((chunk: any) => chunk.tx === 0 ? {
    ...chunk,
    artifacts: chunk.artifacts.filter((artifact: any) => artifact.artifactType !== SURFACE_COMPOSITE_ARTIFACT_TYPE),
  } : chunk),
});
missingPopulationSurface.manifest = missingPopulationSurfaceManifest;
missingPopulationSurface.manifestHash = missingPopulationSurfaceManifest.manifestHash;
missingPopulationSurface.source = missingPopulationSurfaceManifest.source;
missingPopulationSurface.chunks = missingPopulationSurface.chunks.map((entry: any) => ({ ...entry,
  chunk: missingPopulationSurfaceManifest.chunks.find((chunk) => chunk.chunkId === entry.chunkId)! }));
rejects(() => parseTransferredDerivedRuntimeSnapshot(missingPopulationSurface), /missing its surface identity context/,
  "population artifact without its required surface identity context was accepted");
const navigationResult = searchTransferredDerivedNavigation(parsed, "old m", 1)[0];
assert(navigationResult?.designRef.schema === ATLAS_DESIGN_REF_SCHEMA
  && navigationResult.designRef.mapId === "primary" && navigationResult.designRef.kind === "place"
  && navigationResult.designRef.id === "old-mill" && navigationResult.position[0] === FAR + 320,
"structured-cloned navigation bytes did not rebuild searchable main-realm codec state with exact refs");
assert(parsed.terrain.sampleHeight(FAR + 32, FAR + 32) === 105, "O(1) centre sample changed");
assert(parsed.terrain.sampleHeight(FAR + 64, FAR + 32) === 105, "exact shared-edge sample did not select the canonical adjacent chunk");
assert(parsed.terrain.sampleHeight(FAR - 1, FAR + 32) === null, "out-of-domain sample did not fail bounded");
rejects(() => parsed.terrain.sampleHeight(Number.NaN, 0), /finite/, "non-finite sampler input was accepted");

const externalScene = new THREE.Scene();
const candidate = new DetachedDerivedRenderCandidate(transferredBiome, {});
assert(externalScene.children.length === 0 && candidate.root.parent === null, "detached candidate mutated or attached to a live scene");
assert(candidate.terrainMeshCount === 2 && candidate.waterFragmentCount === 1, "bounded terrain/water window did not mount expected resources");
assert(candidate.terrainRoot.children.length === 2 && candidate.waterRoot.children.length === 1
  && candidate.overviewRoot.children.length === 1 && candidate.overviewMeshCount === 1
  && candidate.populationRoot.children.length === 0,
"revision root does not own its complete staged terrain/water window and empty population stage plus single overview draw");
assert(candidate.overviewTriangleCount === 32_768,
  `sub-proxy-cell fine residency created a coarse coverage hole (${candidate.overviewTriangleCount} triangles)`);
assert(Object.isFrozen(candidate.overviewBounds) && candidate.overviewBounds?.minX === FAR
  && candidate.overviewBounds.minY === 100 && candidate.overviewBounds.minZ === FAR
  && candidate.overviewBounds.maxX === FAR + 25_600 && candidate.overviewBounds.maxY === 100
  && candidate.overviewBounds.maxZ === FAR + 25_600,
"candidate did not retain immutable overview bounds from its mesh-build pass");
const overviewMesh = candidate.overviewRoot.children[0] as THREE.Mesh;
const overviewPositions = overviewMesh.geometry.getAttribute("position") as THREE.BufferAttribute;
const overviewColors = overviewMesh.geometry.getAttribute("color") as THREE.BufferAttribute;
assert(overviewMesh.position.x === FAR && overviewMesh.position.z === FAR && overviewPositions.getX(0) === 0 && overviewPositions.getZ(0) === 0,
  "overview geometry is not feature-local at large world coordinates");
assert(overviewColors.itemSize === 4 && overviewColors.getX(0) === 0xe2 / 0xff
  && overviewColors.getY(0) === 0xe7 / 0xff && overviewColors.getZ(0) === 0xec / 0xff
  && overviewColors.getW(0) === 1,
"overview snow material does not use WebGPU-aligned canonical RGBA8 fine-terrain albedo");
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
const firstTerrainMesh = candidate.terrainRoot.children[0] as THREE.Mesh;
const firstTerrainMaterial = firstTerrainMesh.material as THREE.MeshStandardNodeMaterial & {
  colorNode?: unknown;
  normalNode?: unknown;
  roughnessNode?: unknown;
};
assert((firstTerrainMaterial as any).isMeshStandardNodeMaterial === true
  && firstTerrainMaterial.colorNode !== undefined
  && firstTerrainMaterial.normalNode !== undefined
  && firstTerrainMaterial.roughnessNode !== undefined,
"derived fine terrain did not use the triplanar PBR node-material path");
const colorGraph = collectNodeGraph(firstTerrainMaterial.colorNode);
const normalGraph = collectNodeGraph(firstTerrainMaterial.normalNode);
const colorTextureNames = new Set(colorGraph.textures.map((texture) => texture.name));
assert(colorTextureNames.has("limina:terrain-climate") && colorTextureNames.has("limina:terrain-paint")
  && colorGraph.textures.some((texture) => texture.image?.width === 256),
"derived PBR color graph did not retain climate/blight, paint, and shared surface-detail inputs");
assert(normalGraph.textures.some((texture) => texture.image?.width === 256),
  "derived PBR normal graph collapsed to the geometric/clay normal");
const ownedTerrainTextures = (firstTerrainMaterial.userData.liminaOwnedTextures ?? []) as THREE.DataTexture[];
assert(ownedTerrainTextures.length === 2
  && ownedTerrainTextures.every((texture) => texture.image?.width === 3 && texture.image?.height === 3),
"derived fine terrain does not own exactly its bounded climate and paint textures");
const climateTexture = ownedTerrainTextures.find((texture) => texture.name === "limina:terrain-climate")!;
const paintTexture = ownedTerrainTextures.find((texture) => texture.name === "limina:terrain-paint")!;
const climatePixels = climateTexture.image.data as Uint8Array;
const paintPixels = paintTexture.image.data as Uint8Array;
assert(climatePixels[3] === 0 && climatePixels[8 * 4 + 3] === 255
  && climatePixels[2] === 0 && climatePixels[6 * 4 + 2] === 255,
"derived climate texture lost the canonical biome or blight channels");
assert(paintPixels[3] === 128 && paintPixels[0] > 0 && paintPixels[1] > 0,
  "derived paint texture lost material albedo or authored blend weight");
assert(JSON.stringify(firstTerrainMaterial.userData.liminaTerrainFeatureOrigin) === JSON.stringify([FAR + 32, 100, FAR + 32]),
  "derived PBR material did not retain its exact CPU-side feature origin");
assert([...colorGraph.constants, ...normalGraph.constants].every((value) => Math.abs(value) < FAR / 2),
  "large world coordinates leaked into the feature-local PBR shader graph");
const surfaceFrame = firstTerrainMesh.userData.derivedTerrainSurfaceFrame as Record<string, unknown>;
assert(surfaceFrame.source === "hydrology" && surfaceFrame.seaLevelM === 90
  && surfaceFrame.minY === 100 && surfaceFrame.maxY === 110
  && surfaceFrame.localMinY === 0 && surfaceFrame.localMaxY === 10,
"derived PBR bands used codec range instead of actual staged relief plus verified hydrology sea level");
const groundCoverStatus = candidate.presentationStatus();
assert(Object.isFrozen(groundCoverStatus) && groundCoverStatus.groundCover === "unfulfilled"
  && groundCoverStatus.groundCoverTiles === 0 && groundCoverStatus.groundCoverBlades === 0
  && groundCoverStatus.canopy === "unfulfilled" && /not been mounted/.test(groundCoverStatus.canopyReason),
"legacy candidate synthesized vegetation before a verified population mount");
const waterMesh = candidate.waterRoot.children[0] as THREE.Mesh;
const waterDepthTextures = ((waterMesh.material as THREE.Material).userData as Record<string, unknown>).liminaOwnedTextures as THREE.DataTexture[];
assert(Array.isArray(waterDepthTextures) && waterDepthTextures.length === 1
  && (waterDepthTextures[0].image.data as Uint8Array).some((value, index) => (index & 1) === 1 && value === 255),
"derived basin did not build owned coverage from verified field plus resident terrain");
const stableWindow = candidate.terrainWindow();
const stableOverviewPositionArray = overviewPositions.array;
const stableOverviewIndexArray = overviewMesh.geometry.index!.array;
const stableTerrainMaterial = firstTerrainMesh.material;
const stableTerrainOwnedTextures = firstTerrainMaterial.userData.liminaOwnedTextures;
candidate.setQuality("cinematic");
assert(candidate.waterRoot.children[0] === waterMesh && candidate.quality.waveCount === 4,
  "quality update replaced semantic water ownership or did not reach the candidate manager");
assert(candidate.terrainWindow() === stableWindow && overviewPositions.array === stableOverviewPositionArray
  && overviewMesh.geometry.index!.array === stableOverviewIndexArray,
"runtime quality/frame-facing reads rebuilt overview arrays after staging");
assert(firstTerrainMesh.material === stableTerrainMaterial
  && firstTerrainMaterial.userData.liminaOwnedTextures === stableTerrainOwnedTextures,
"water quality rebuild replaced or leaked immutable derived PBR terrain resources");
assert(candidate.populationRoot.children.length === 0 && candidate.presentationStatus() === groundCoverStatus,
  "quality update synthesized or mutated unstaged population presentation");
const setWaterQuality = VisibleWaterManager.prototype.setQuality;
VisibleWaterManager.prototype.setQuality = function (): void { throw new Error("injected water quality failure"); };
try {
  rejects(() => candidate.setQuality("performance"), /injected water quality failure/,
    "water quality failure did not reject the candidate tier transaction");
} finally {
  VisibleWaterManager.prototype.setQuality = setWaterQuality;
}
assert(candidate.populationRoot.children.length === 0 && candidate.presentationStatus() === groundCoverStatus,
"failed water rebuild partially committed population state");

const surfaceCandidate = new DetachedDerivedRenderCandidate(transferredSurface, {});
assert(surfaceCandidate.root.parent === null && surfaceCandidate.terrainWindow().every((entry) => entry.surface !== undefined),
  "surface candidate attached externally or lost its one-surface-per-tile window binding");
const surfaceMeshes = surfaceCandidate.terrainRoot.children as THREE.Mesh[];
assert(surfaceMeshes.length === 2 && surfaceMeshes.every((mesh) => {
  const material = mesh.material as THREE.MeshStandardNodeMaterial;
  const graph = collectNodeGraph(material.colorNode);
  const positions = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
  const uv = mesh.geometry.getAttribute("uv") as THREE.BufferAttribute | undefined;
  return material.userData.liminaBiomeSurface !== undefined
    && material.userData.liminaOwnedTextures === undefined
    && uv?.itemSize === 2 && uv.count === positions.count
    && uv.getX(0) === 0 && uv.getY(0) === 0
    && uv.getX(uv.count - 1) === 1 && uv.getY(uv.count - 1) === 1
    && graph.textures.some((texture) => texture.name === "limina:biome-surface-albedo");
}), "verified surfaces did not pair canonical terrain UVs with the bounded three-map normal-detail graph");
let surfaceGeometryDisposes = 0, surfaceMaterialDisposes = 0, surfaceTextureDisposes = 0;
for (const mesh of surfaceMeshes) {
  mesh.geometry.dispose = () => { surfaceGeometryDisposes++; };
  const material = mesh.material as THREE.Material;
  material.dispose = () => { surfaceMaterialDisposes++; };
  const graphTextures = new Set<THREE.Texture>();
  for (const node of [
    (material as THREE.MeshStandardNodeMaterial).colorNode,
    (material as THREE.MeshStandardNodeMaterial).normalNode,
    (material as THREE.MeshStandardNodeMaterial).roughnessNode,
  ]) for (const texture of collectNodeGraph(node).textures) graphTextures.add(texture);
  for (const texture of graphTextures) texture.dispose = () => { surfaceTextureDisposes++; };
}
surfaceCandidate.dispose();
surfaceCandidate.dispose();
assert(surfaceGeometryDisposes === 2 && surfaceMaterialDisposes === 2 && surfaceTextureDisposes === 6,
  `surface terminal disposal was not exactly once (${surfaceGeometryDisposes}/${surfaceMaterialDisposes}/${surfaceTextureDisposes})`);

const populationCandidate = new DetachedDerivedRenderCandidate(structuredCloneFixture(populationSnapshot()), {});
assert(populationCandidate.presentationStatus().canopy === "unfulfilled"
  && populationCandidate.presentationStatus().groundCover === "unfulfilled"
  && populationCandidate.populationRoot.children.length === 0,
"population candidate claimed presentation readiness before its external mount succeeded");
let populationMountDisposes = 0;
await populationCandidate.stagePopulation(async ({ plan, content, root, terrainWindow, biomeField, runtimePack }) => {
  assert(plan === populationCandidate.snapshot.populationPlan && Object.isFrozen(plan)
    && content === populationCandidate.snapshot.biomeContent && Object.isFrozen(content)
    && content.status === "candidate" && content.runtimePack.contentHash === populationPackHash
    && plan.placements.length === 2 && root === populationCandidate.populationRoot
    && terrainWindow === populationCandidate.terrainWindow() && terrainWindow.length === 2
    && biomeField.contentHash === biomeFieldDescriptor.contentHash
    && derivedArtifactContentHash(biomeField.bytes) === biomeFieldDescriptor.contentHash
    && runtimePack.semanticContentHash === populationPackHash
    && runtimePack.bytes.byteLength === populationRuntimePackBytes.byteLength
    && derivedArtifactContentHash(runtimePack.bytes) === populationRuntimePackDescriptor.contentHash,
  "population factory did not receive exact immutable plan/content/terrain/field/runtime-pack authority and owned root");
  const mounted = new THREE.Group();
  mounted.name = "test:verified-population";
  root.add(mounted);
  return {
    canopyInstances: 1,
    groundCoverTiles: 1,
    groundCoverBlades: 40,
    dispose(): void { populationMountDisposes++; root.remove(mounted); },
  };
});
assert(populationCandidate.presentationStatus().canopy === "ready"
  && populationCandidate.presentationStatus().groundCover === "ready"
  && populationCandidate.presentationStatus().populationPlacements === 2
  && populationCandidate.groundCoverTileCount === 1 && populationCandidate.groundCoverBladeCount === 40
  && populationCandidate.populationRoot.children.length === 1,
"successful population mount did not atomically commit its owned root and presentation status");
await rejectsAsync(() => populationCandidate.stagePopulation(async () => ({
  canopyInstances: 0, groundCoverTiles: 0, groundCoverBlades: 0, dispose(): void {},
})), /already staged/, "population staging was not one-shot after success");

const failingPopulationCandidate = new DetachedDerivedRenderCandidate(structuredCloneFixture(populationSnapshot()), {});
const priorPopulationRootChild = populationCandidate.populationRoot.children[0];
const priorPopulationStatus = populationCandidate.presentationStatus();
await rejectsAsync(() => failingPopulationCandidate.stagePopulation(async ({ root }) => {
  root.add(new THREE.Group());
  throw new Error("injected population factory failure");
}), /injected population factory failure/, "population factory failure did not reject staging");
assert(failingPopulationCandidate.populationRoot.children.length === 0
  && failingPopulationCandidate.presentationStatus().canopy === "unfulfilled"
  && failingPopulationCandidate.presentationStatus().groundCover === "unfulfilled"
  && populationCandidate.populationRoot.children[0] === priorPopulationRootChild
  && populationCandidate.presentationStatus() === priorPopulationStatus,
"failed replacement population staging mutated its prior candidate or committed provisional state");
await rejectsAsync(() => failingPopulationCandidate.stagePopulation(async () => ({
  canopyInstances: 0, groundCoverTiles: 0, groundCoverBlades: 0, dispose(): void {},
})), /already failed/, "failed population stage was reusable instead of one-shot");
let invalidPopulationMountDisposes = 0;
const invalidPopulationCandidate = new DetachedDerivedRenderCandidate(structuredCloneFixture(populationSnapshot()), {});
await rejectsAsync(() => invalidPopulationCandidate.stagePopulation(async ({ root }) => {
  root.add(new THREE.Group());
  return {
    canopyInstances: -1,
    groundCoverTiles: 0,
    groundCoverBlades: 0,
    dispose(): void { invalidPopulationMountDisposes++; },
  };
}), /non-negative safe integer/, "invalid population mount presentation escaped validation");
assert(invalidPopulationMountDisposes === 1 && invalidPopulationCandidate.populationRoot.children.length === 0
  && invalidPopulationCandidate.presentationStatus().canopy === "unfulfilled",
"invalid returned population mount was not rolled back exactly once");
const noPopulationCandidate = new DetachedDerivedRenderCandidate(structuredCloneFixture(surfaceSnapshot()), {});
await rejectsAsync(() => noPopulationCandidate.stagePopulation(async () => ({
  canopyInstances: 0, groundCoverTiles: 0, groundCoverBlades: 0, dispose(): void {},
})), /no verified population plan/, "surface-only candidate accepted an invented population stage");
populationCandidate.dispose();
populationCandidate.dispose();
failingPopulationCandidate.dispose();
invalidPopulationCandidate.dispose();
noPopulationCandidate.dispose();
assert(populationMountDisposes === 1 && populationCandidate.populationRoot.children.length === 0,
  "candidate did not terminally dispose its successful external population mount exactly once");

function withSurfaceOverride(value: any, tx: number, composite: ReturnType<typeof surface>): any {
  const nextManifest = createDerivedRevisionManifest({
    schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2,
    projectId: value.manifest.projectId,
    branchId: value.manifest.branchId,
    source: value.manifest.source,
    compiler: value.manifest.compiler,
    grid: value.manifest.grid,
    globalArtifacts: value.manifest.globalArtifacts,
    chunks: value.manifest.chunks.map((chunk: any) => chunk.tx === tx ? {
      ...chunk,
      artifacts: [composite.descriptor, chunk.artifacts.find((artifact: any) => artifact.artifactType === "terrain-chunk/v1")],
    } : chunk),
  });
  value.manifest = nextManifest;
  value.manifestHash = nextManifest.manifestHash;
  value.source = nextManifest.source;
  value.chunks = value.chunks.map((entry: any) => {
    const chunk = nextManifest.chunks.find((candidate: any) => candidate.chunkId === entry.chunkId)!;
    if (chunk.tx !== tx) return { ...entry, chunk };
    return { ...entry, chunk, resource: { ...entry.resource, surface: composite.decoded,
      artifacts: { terrain: chunk.artifacts.find((artifact: any) => artifact.artifactType === "terrain-chunk/v1"), surface: composite.descriptor } } };
  });
  return value;
}

const wrongSurfaceBinding = withSurfaceOverride(surfaceSnapshot(), 0, surface(0, hash("other-terrain")));
rejects(() => parseTransferredDerivedRuntimeSnapshot(wrongSurfaceBinding), /surface bindings do not match/,
  "canonical surface bound to another terrain artifact was accepted in the main realm");
const missingSurfaceBiome = surfaceSnapshot();
const noBiomeManifest = createDerivedRevisionManifest({
  schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2,
  projectId: missingSurfaceBiome.manifest.projectId,
  branchId: missingSurfaceBiome.manifest.branchId,
  source: missingSurfaceBiome.manifest.source,
  compiler: missingSurfaceBiome.manifest.compiler,
  grid: missingSurfaceBiome.manifest.grid,
  globalArtifacts: missingSurfaceBiome.manifest.globalArtifacts.filter((artifact: any) => artifact.artifactType !== BIOME_FIELD_ARTIFACT_TYPE),
  chunks: missingSurfaceBiome.manifest.chunks,
});
missingSurfaceBiome.manifest = noBiomeManifest;
missingSurfaceBiome.manifestHash = noBiomeManifest.manifestHash;
missingSurfaceBiome.source = noBiomeManifest.source;
missingSurfaceBiome.chunks = missingSurfaceBiome.chunks.map((entry: any) => ({ ...entry,
  chunk: noBiomeManifest.chunks.find((chunk: any) => chunk.chunkId === entry.chunkId)! }));
missingSurfaceBiome.globals = missingSurfaceBiome.globals.filter((entry: any) => entry.artifactType !== BIOME_FIELD_ARTIFACT_TYPE);
rejects(() => parseTransferredDerivedRuntimeSnapshot(missingSurfaceBiome), /missing its global biome field dependency/,
  "surface-enabled publication without a global biome field was accepted");

// The encoded descriptors are tiny, but 128 max-sized terrain descriptors exactly consume the
// detached budget. The first decoded surface map set must therefore reject the publication.
const budgetCoords = Array.from({ length: 15 * 15 }, (_, index) => ({ tx: index % 15 - 7, tz: Math.floor(index / 15) - 7 }))
  .sort((left, right) => {
    const leftId = terrainChunkId(grid.gridId, 0, left.tx, left.tz), rightId = terrainChunkId(grid.gridId, 0, right.tx, right.tz);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  })
  .slice(0, 128);
const budgetEntries = budgetCoords.map(({ tx, tz }) => {
  const terrainArtifact = { artifactType: "terrain-chunk/v1", contentHash: hash(`budget-terrain-${tx}-${tz}`),
    byteLength: 2 * 1024 * 1024, mediaType: TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE };
  const composite = surface(tx, terrainArtifact.contentHash, 2, tz);
  const chunk = {
    chunkId: terrainChunkId(grid.gridId, 0, tx, tz), gridId: grid.gridId, lod: 0, tx, tz,
    topologyHash: hash(`budget-topology-${tx}-${tz}`), sourceSliceHashes: [],
    artifacts: [composite.descriptor, terrainArtifact],
  };
  const baseline = decodeTerrainChunkArtifact(terrain0.bytes);
  const decoded = { metadata: { ...baseline.metadata, byteLength: terrainArtifact.byteLength },
    tile: { ...baseline.tile, origin: [FAR + (tx + 0.5) * 64, 100, FAR + (tz + 0.5) * 64] } };
  return { chunk, resource: { kind: "terrain-chunk/v1", decoded, surface: composite.decoded,
    artifacts: { terrain: terrainArtifact, surface: composite.descriptor } } };
});
const budgetManifest = createDerivedRevisionManifest({
  schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2, projectId: manifest.projectId, branchId: manifest.branchId,
  source: manifest.source, compiler: manifest.compiler, grid, globalArtifacts: [biomeFieldDescriptor],
  chunks: budgetEntries.map((entry) => entry.chunk),
});
const budgetSnapshot = {
  schema: DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA, projectId: budgetManifest.projectId, branchId: budgetManifest.branchId,
  manifestHash: budgetManifest.manifestHash, source: budgetManifest.source, manifest: budgetManifest,
  residency: { schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA, center: [FAR + 32, FAR + 32], lod: 0, radius: 7 },
  chunks: budgetEntries.map((entry) => ({ chunkId: entry.chunk.chunkId,
    chunk: budgetManifest.chunks.find((chunk) => chunk.chunkId === entry.chunk.chunkId)!, resource: entry.resource })),
  globals: [{ artifactType: BIOME_FIELD_ARTIFACT_TYPE, artifact: biomeFieldDescriptor,
    resource: { kind: BIOME_FIELD_ARTIFACT_TYPE, bytes: biomeFieldBytes } }],
};
rejects(() => parseTransferredDerivedRuntimeSnapshot(budgetSnapshot), /256 MiB retained CPU budget/,
  "decoded surface maps were omitted from the detached candidate CPU budget");

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
const corruptField = snapshot();
corruptField.globals[0].resource.decoded.topology.oceanMask[0] ^= 1;
rejects(() => parseTransferredDerivedRuntimeSnapshot(corruptField), /canonical descriptor|receiver|ocean/,
  "mutated structured-clone hydrology field was accepted for render depth authority");
const corruptOverview = snapshot();
corruptOverview.globals[3].resource.decoded.grid.heights[0] += 1;
rejects(() => parseTransferredDerivedRuntimeSnapshot(corruptOverview), /canonical descriptor/,
  "overview decoded bytes that disagreed with the manifest descriptor were accepted");
const corruptNavigation = snapshot();
corruptNavigation.globals[2].resource.bytes = navigationBytes.slice();
corruptNavigation.globals[2].resource.bytes[0] ^= 0xff;
rejects(() => parseTransferredDerivedRuntimeSnapshot(corruptNavigation), /canonical descriptor/,
  "corrupt navigation bytes were decoded before descriptor verification");
const wrongNavigationDescriptor = snapshot();
wrongNavigationDescriptor.globals[2].artifact = { ...navigationDescriptor, mediaType: "application/octet-stream" };
rejects(() => parseTransferredDerivedRuntimeSnapshot(wrongNavigationDescriptor), /identity does not match/,
  "malformed navigation descriptor reached decode or activation");
const corruptBiome = biomeSnapshot();
corruptBiome.globals[0].resource.bytes = biomeFieldBytes.slice();
corruptBiome.globals[0].resource.bytes[0] ^= 0xff;
rejects(() => parseTransferredDerivedRuntimeSnapshot(corruptBiome), /canonical descriptor/,
  "corrupt biome bytes were decoded before descriptor verification");
const wrongBiomeKind = biomeSnapshot();
wrongBiomeKind.globals[0].resource.kind = "biome-field/v2";
rejects(() => parseTransferredDerivedRuntimeSnapshot(wrongBiomeKind), /kind is unsupported/,
  "unsupported biome resource kind reached decode");
const wrongBiomeDescriptor = biomeSnapshot();
wrongBiomeDescriptor.globals[0].artifact = { ...biomeFieldDescriptor, mediaType: "application/octet-stream" };
rejects(() => parseTransferredDerivedRuntimeSnapshot(wrongBiomeDescriptor), /identity does not match/,
  "malformed biome descriptor reached decode or activation");
const wrongPlacement = snapshot();
const misplacedBytes = encodeTerrainChunkArtifact({
  nrows: 3, ncols: 3, origin: [FAR + 31, 100, FAR + 32], scale: [64, 10, 64],
  heights: new Float32Array([0, 0.25, 0.5, 0.25, 0.5, 0.75, 0.5, 0.75, 1]),
  paintMat: new Uint8Array(9).fill(2), paintW: new Float32Array(9).fill(0.5),
});
wrongPlacement.chunks[0].resource.decoded = decodeTerrainChunkArtifact(misplacedBytes);
rejects(() => parseTransferredDerivedRuntimeSnapshot(wrongPlacement), /placement|decoded metadata/,
  "tile/grid placement mismatch was accepted");
rejects(() => new DetachedDerivedRenderCandidate(snapshot(), {
  maxTerrainMeshes: 1,
}), /exceeding budget/, "terrain mesh window budget was enforced after staging");
const emptyResidency = snapshot();
emptyResidency.residency = { schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA, center: [FAR + 10_000, FAR + 10_000], lod: 0, radius: 1 };
rejects(() => new DetachedDerivedRenderCandidate(emptyResidency, {}), /no manifest chunks/, "empty terrain activation window reached simulation staging");

let rollbackSurfaceGeometries = 0, rollbackSurfaceMaterials = 0, rollbackSurfaceTextures = 0;
const originalGeometryDispose = THREE.BufferGeometry.prototype.dispose;
const originalMaterialDispose = THREE.Material.prototype.dispose;
const originalTextureDispose = THREE.Texture.prototype.dispose;
const originalWaterMount = VisibleWaterManager.prototype.mount;
THREE.BufferGeometry.prototype.dispose = function (): void {
  if (this.userData.derivedBiomeSurface === true) rollbackSurfaceGeometries++;
  originalGeometryDispose.call(this);
};
THREE.Material.prototype.dispose = function (): void {
  if (this.userData.liminaBiomeSurface !== undefined) rollbackSurfaceMaterials++;
  originalMaterialDispose.call(this);
};
THREE.Texture.prototype.dispose = function (): void {
  if (this.name.startsWith("limina:biome-surface-")) rollbackSurfaceTextures++;
  originalTextureDispose.call(this);
};
VisibleWaterManager.prototype.mount = function (): never { throw new Error("injected terminal staging failure"); };
try {
  rejects(() => new DetachedDerivedRenderCandidate(structuredCloneFixture(surfaceSnapshot()), {}), /injected terminal staging failure/,
    "terminal staging failure did not reject the detached surface candidate");
} finally {
  THREE.BufferGeometry.prototype.dispose = originalGeometryDispose;
  THREE.Material.prototype.dispose = originalMaterialDispose;
  THREE.Texture.prototype.dispose = originalTextureDispose;
  VisibleWaterManager.prototype.mount = originalWaterMount;
}
assert(rollbackSurfaceGeometries === 2 && rollbackSurfaceMaterials === 2 && rollbackSurfaceTextures === 6,
  `constructor rollback did not retire each surface resource exactly once (${rollbackSurfaceGeometries}/${rollbackSurfaceMaterials}/${rollbackSurfaceTextures})`);

let derivedTextureDisposes = 0;
let derivedMaterialDisposes = 0;
for (const object of candidate.terrainRoot.children) {
  const material = (object as THREE.Mesh).material as THREE.Material;
  const textures = (material.userData.liminaOwnedTextures ?? []) as THREE.Texture[];
  for (const texture of textures) texture.dispose = () => { derivedTextureDisposes++; };
  material.dispose = () => { derivedMaterialDisposes++; };
}
candidate.dispose();
candidate.dispose();
assert(candidate.disposed && candidate.root.children.length === 0 && candidate.terrainMeshCount === 0
  && candidate.waterFragmentCount === 0 && candidate.overviewMeshCount === 0
  && candidate.groundCoverRoot.children.length === 0 && candidate.groundCoverBladeCount === 0,
  "candidate disposal leaked revision-scoped resources or was not idempotent");
assert(derivedTextureDisposes === 4 && derivedMaterialDisposes === 2,
  `derived PBR teardown did not release each owned texture/material exactly once (${derivedTextureDisposes}/${derivedMaterialDisposes})`);

const faultCandidate = new DetachedDerivedRenderCandidate(snapshot(), {});
const faultOverview = faultCandidate.overviewRoot.children[0] as THREE.Mesh;
let materialDisposed = false;
(faultOverview.geometry as any).dispose = () => { throw new Error("geometry disposal fault"); };
(faultOverview.material as any).dispose = () => { materialDisposed = true; };
rejects(() => faultCandidate.dispose(), /disposal failed/, "overview disposal fault did not surface as an aggregate failure");
assert(faultCandidate.disposed && faultCandidate.root.children.length === 0 && materialDisposed,
  "faulting overview disposal did not atomically retire the candidate and continue cleanup");
faultCandidate.dispose();

console.log("[js] p_derived_runtime_render_candidate OK: legacy terrain/surface compatibility plus descriptor-bound population parse, immutable aggregation, one-shot mount ownership, rollback/disposal, water, overview, and O(1) sampling proven");
