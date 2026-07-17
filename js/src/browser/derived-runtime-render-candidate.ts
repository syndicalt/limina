import * as THREE from "../../build/three.bundle.mjs";
import {
  DEFAULT_RENDER_QUALITY_PROFILES,
  type RenderQualityTier,
  type WaterRenderQuality,
} from "../render/quality.ts";
import {
  mountGeneratedWaterResource,
  generatedWaterCoversPoint,
  type GeneratedWaterRenderMount,
  type VerifiedGeneratedWaterRenderResource,
} from "../render/water/generated-water-renderer.ts";
import { VisibleWaterManager } from "../render/water/visible-water-manager.ts";
import {
  TERRAIN_ELEVATION_ALBEDO_HEX,
  buildTerrainMesh,
  disposeTerrainMesh,
} from "../terrain/render.ts";
import { TERRAIN_PAINT_ALBEDO_HEX } from "../terrain/material-palette.ts";
import { tileKey } from "../terrain/stream.ts";
import type { TerrainTile } from "../terrain/types.ts";
import {
  MAX_DERIVED_TERRAIN_RESIDENCY_CHUNKS,
  MAX_DERIVED_TERRAIN_RESIDENCY_RADIUS,
  parseDerivedTerrainResidency,
  selectDerivedTerrainChunks,
  type DerivedTerrainResidency,
} from "./derived-terrain-residency.ts";
import {
  DerivedLod0TerrainIndex,
  assertDerivedTerrainTilePlacement,
  parseTransferredTerrainTile,
  type DerivedTerrainArtifactDescriptor,
  type DerivedTerrainIndexEntry,
  type DerivedTerrainManifestChunk,
} from "./derived-terrain-index.ts";
export { DerivedLod0TerrainIndex } from "./derived-terrain-index.ts";
import { DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA } from "./derived-runtime-worker.ts";
import { compilerContentHash } from "../world/compiler/canonical.mjs";
import {
  derivedArtifactCompilerGraphHash,
  derivedArtifactContentHash,
  derivedGlobalArtifacts,
  parseDerivedRevisionManifest,
} from "../world/compiler/manifest.mjs";
import {
  TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE,
  MAX_TERRAIN_CHUNK_ARTIFACT_BYTES,
} from "../world/compiler/terrain-artifact.mjs";
import {
  HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_FIELD_ARTIFACT_TYPE,
  decodeHydrologyFieldArtifact,
  encodeHydrologyFieldArtifact,
} from "../world/hydrology-artifact.mjs";
import {
  HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_WATER_ARTIFACT_TYPE,
  inspectHydrologyWaterArtifactBindings,
} from "../world/hydrology-water-artifact.mjs";
import {
  WORLD_OVERVIEW_ARTIFACT_MEDIA_TYPE,
  WORLD_OVERVIEW_ARTIFACT_TYPE,
  decodeWorldOverviewArtifact,
  encodeWorldOverviewArtifact,
} from "../world/compiler/world-overview-artifact.mjs";
import {
  NAVIGATION_INDEX_ARTIFACT_MEDIA_TYPE,
  NAVIGATION_INDEX_ARTIFACT_TYPE,
  decodeNavigationIndexArtifact,
  searchNavigationIndexPrefix,
} from "../world/compiler/navigation-index-artifact.mjs";
import {
  BIOME_FIELD_ARTIFACT_MEDIA_TYPE,
  BIOME_FIELD_ARTIFACT_TYPE,
  decodeBiomeFieldArtifact,
  encodeBiomeFieldArtifact,
} from "../world/compiler/biome-field-artifact.mjs";
import { createBiomeFieldSampler } from "../world/biome-field-sampler.mjs";
import {
  MAX_SURFACE_COMPOSITE_ARTIFACT_BYTES,
  SURFACE_COMPOSITE_ARTIFACT_MEDIA_TYPE,
  SURFACE_COMPOSITE_ARTIFACT_TYPE,
  decodeSurfaceCompositeArtifact,
  encodeSurfaceCompositeArtifact,
} from "../world/compiler/surface-composite-artifact.mjs";
import {
  BIOME_POPULATION_ARTIFACT_MEDIA_TYPE,
  BIOME_POPULATION_ARTIFACT_SCHEMA,
  BIOME_POPULATION_ARTIFACT_TYPE,
  MAX_BIOME_POPULATION_ARTIFACT_BYTES,
  decodeBiomePopulationArtifact,
  encodeBiomePopulationArtifact,
} from "../world/compiler/biome-population-artifact.mjs";
import {
  BIOME_CONTENT_CLOSURE_ARTIFACT_MEDIA_TYPE,
  BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE,
  decodeBiomeContentClosureArtifact,
} from "../world/compiler/biome-content-closure-artifact.mjs";
import {
  BIOME_RUNTIME_PACK_ARTIFACT_MEDIA_TYPE,
  BIOME_RUNTIME_PACK_ARTIFACT_TYPE,
  decodeBiomeRuntimePackArtifact,
} from "../world/compiler/biome-runtime-pack-artifact.mjs";
import {
  buildBiomeSurfaceMaterial,
  type BiomeSurfaceMaterialMount,
} from "../terrain/biome-surface-material.ts";
import { exactDataKeys, plainRecord } from "./derived-plain-data.ts";

export const MAX_DETACHED_DERIVED_TERRAIN_RADIUS = MAX_DERIVED_TERRAIN_RESIDENCY_RADIUS;
export const MAX_DETACHED_DERIVED_TERRAIN_MESHES = MAX_DERIVED_TERRAIN_RESIDENCY_CHUNKS;
export const MAX_DETACHED_DERIVED_TERRAIN_CPU_BYTES = 256 * 1024 * 1024;
const TERRAIN_CHUNK_ARTIFACT_TYPE = "terrain-chunk/v1";
const HASH = /^sha256:[0-9a-f]{64}$/;

type ArtifactDescriptor = DerivedTerrainArtifactDescriptor;

type ManifestChunk = DerivedTerrainManifestChunk;

type ParsedManifest = Readonly<{
  manifestHash: string;
  projectId: string;
  branchId: string;
  source: Readonly<{ revision: number; headHash: string }>;
  compiler: Readonly<{ graphHash: string }>;
  grid: Readonly<{ schema: string; gridId: string; origin: readonly [number, number]; chunkSizeM: number; defaultSamples: number }>;
  chunks: readonly ManifestChunk[];
}>;

export interface ParsedGeneratedWaterResource {
  readonly artifact: ArtifactDescriptor;
  readonly bytes: Uint8Array;
  readonly bindings: Readonly<{
    hydrologyFieldContentHash: string;
    recipeHash: string;
    erosionStageKey: string;
    compilerGraphHash: string;
  }>;
  readonly render: VerifiedGeneratedWaterRenderResource;
}

type IndexedTerrainChunk = DerivedTerrainIndexEntry;

export interface ParsedTransferredDerivedSnapshot {
  readonly schema: typeof DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA;
  readonly projectId: string;
  readonly branchId: string;
  readonly manifestHash: string;
  readonly source: Readonly<{ revision: number; headHash: string }>;
  readonly manifest: ParsedManifest;
  readonly residency: Readonly<DerivedTerrainResidency>;
  readonly terrain: DerivedLod0TerrainIndex;
  readonly surfaceAt: (tx: number, tz: number) => ParsedTransferredSurfaceComposite | undefined;
  readonly populationAt: (tx: number, tz: number) => ParsedTransferredBiomePopulation | undefined;
  readonly populationPlan: DetachedDerivedPopulationPlan | null;
  readonly biomeContent: VerifiedBiomeContentBundle | null;
  readonly biomeRuntimePack: Readonly<{ bytes: Uint8Array; semanticContentHash: string }> | null;
  readonly retainedCpuBytes: number;
  readonly worldOverview: ReturnType<typeof decodeWorldOverviewArtifact> | null;
  readonly navigationIndex: ReturnType<typeof decodeNavigationIndexArtifact> | null;
  readonly biomeField: ReturnType<typeof decodeBiomeFieldArtifact> | null;
  readonly biomeSampler: ReturnType<typeof createBiomeFieldSampler> | null;
  readonly generatedWater: ParsedGeneratedWaterResource | null;
}

export interface ParsedTransferredSurfaceComposite {
  readonly artifact: ArtifactDescriptor;
  readonly decoded: ReturnType<typeof decodeSurfaceCompositeArtifact>;
}

export interface DetachedDerivedPopulationPlacement {
  readonly role: string;
  readonly assetId: string;
  readonly contentHash: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly scale: number;
  readonly pageX: number;
  readonly pageZ: number;
}

export interface ParsedTransferredBiomePopulation {
  readonly artifact: ArtifactDescriptor;
  readonly plan: Readonly<{
    schema: typeof BIOME_POPULATION_ARTIFACT_SCHEMA;
    coord: Readonly<{ tx: number; tz: number; lod: number }>;
    identity: Readonly<{ fieldContentHash: string; runtimePackContentHash: string }>;
    placements: readonly DetachedDerivedPopulationPlacement[];
  }>;
}

export const DETACHED_DERIVED_POPULATION_PLAN_SCHEMA = "limina.detached-derived-population-plan/v1" as const;

export interface DetachedDerivedPopulationPlan {
  readonly schema: typeof DETACHED_DERIVED_POPULATION_PLAN_SCHEMA;
  readonly identity: Readonly<{ fieldContentHash: string; runtimePackContentHash: string }>;
  readonly chunks: readonly Readonly<{
    tx: number;
    tz: number;
    lod: number;
    contentHash: string;
    placementCount: number;
  }>[];
  readonly placements: readonly DetachedDerivedPopulationPlacement[];
}

export interface VerifiedBiomeContentBundle {
  readonly schema: string;
  readonly id: string;
  readonly version: string;
  readonly status: "candidate" | "accepted";
  readonly closureHash: string;
  readonly runtimePack: Readonly<{ assetId: string; contentHash: string }>;
  readonly entries: readonly Readonly<{
    assetId: string;
    contentHash: string;
    kind: string;
    byteLength: number;
  }>[];
}

export interface DetachedDerivedRenderCandidateOptions {
  readonly quality?: RenderQualityTier;
  readonly maxTerrainMeshes?: number;
}

export interface DerivedPresentationStatus {
  readonly groundCover: "unfulfilled" | "ready" | "empty";
  readonly groundCoverTiles: number;
  readonly groundCoverBlades: number;
  readonly climateProfiles: readonly string[];
  readonly canopy: "unfulfilled" | "ready" | "empty";
  readonly canopyReason: string;
  readonly groundCoverReason: string;
  readonly populationPlacements: number;
}

export interface DetachedDerivedPopulationMount {
  readonly canopyInstances: number;
  readonly groundCoverTiles: number;
  readonly groundCoverBlades: number;
  dispose(): void;
}

export type DetachedDerivedPopulationFactory = (input: Readonly<{
  plan: DetachedDerivedPopulationPlan;
  content: VerifiedBiomeContentBundle;
  root: THREE.Group;
  terrainWindow: readonly DetachedDerivedTerrainWindowEntry[];
  biomeField: Readonly<{ bytes: Uint8Array; contentHash: string }>;
  runtimePack: Readonly<{ bytes: Uint8Array; semanticContentHash: string }>;
  waterCoverageAt: (x: number, z: number) => boolean;
}>) => Promise<DetachedDerivedPopulationMount>;

export interface DetachedDerivedTerrainWindowEntry {
  readonly key: string;
  readonly tx: number;
  readonly tz: number;
  readonly tile: TerrainTile;
  readonly surface?: ParsedTransferredSurfaceComposite;
}

export type DerivedNavigationSearchResult = Readonly<{
  designRef: Readonly<{ schema: string; mapId: string; kind: string; id: string }>;
  position: readonly [number, number];
  label: string;
  kind: string;
  searchKeys: readonly string[];
  radiusM?: number;
}>;

/** Search only the main-realm index reconstructed by snapshot verification. */
export function searchTransferredDerivedNavigation(
  snapshot: Pick<ParsedTransferredDerivedSnapshot, "navigationIndex"> | null,
  prefix: string,
  limit = 20,
): readonly DerivedNavigationSearchResult[] {
  if (snapshot?.navigationIndex === null || snapshot?.navigationIndex === undefined) return Object.freeze([]);
  return searchNavigationIndexPrefix(snapshot.navigationIndex, prefix, { limit }) as readonly DerivedNavigationSearchResult[];
}

export interface DetachedWorldOverviewBounds {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

function plain(value: unknown, label: string): Record<string, unknown> {
  return plainRecord(value, label);
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  exactDataKeys(value, keys, [], label);
}

function dense(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    throw new TypeError(`${label} must be a bounded standard array`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    throw new TypeError(`${label} must be dense and field-free`);
  }
  return value;
}

function descriptor(value: unknown, label: string): ArtifactDescriptor {
  const record = plain(value, label);
  exact(record, ["artifactType", "contentHash", "byteLength", "mediaType"], label);
  if (typeof record.artifactType !== "string" || typeof record.mediaType !== "string"
      || typeof record.contentHash !== "string" || !HASH.test(record.contentHash)
      || !Number.isSafeInteger(record.byteLength) || (record.byteLength as number) < 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return Object.freeze({
    artifactType: record.artifactType,
    contentHash: record.contentHash,
    byteLength: record.byteLength as number,
    mediaType: record.mediaType,
  });
}

function sameDescriptor(left: ArtifactDescriptor, right: ArtifactDescriptor): boolean {
  return left.artifactType === right.artifactType && left.contentHash === right.contentHash
    && left.byteLength === right.byteLength && left.mediaType === right.mediaType;
}

function completeUint8(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer)
      || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    throw new TypeError(`${label} must be an owned complete Uint8Array`);
  }
  return value;
}


function bindings(value: unknown): ParsedGeneratedWaterResource["bindings"] {
  const record = plain(value, "generated water bindings");
  exact(record, ["hydrologyFieldContentHash", "recipeHash", "erosionStageKey", "compilerGraphHash"], "generated water bindings");
  for (const key of Object.keys(record)) {
    if (typeof record[key] !== "string" || !HASH.test(record[key] as string)) throw new TypeError(`generated water binding '${key}' is invalid`);
  }
  return Object.freeze(record as unknown as ParsedGeneratedWaterResource["bindings"]);
}

function generatedRenderTopology(value: unknown): VerifiedGeneratedWaterRenderResource["topology"] {
  const topology = plain(value, "generated water render topology");
  if (!Array.isArray(topology.basins) || !Array.isArray(topology.reaches)) {
    throw new TypeError("generated water render topology requires basin and reach arrays");
  }
  return Object.freeze({
    ...topology,
    basins: Object.freeze(topology.basins.map((input, index) => {
      const basin = plain(input, `generated water render basin ${index}`);
      const footprint = plain(basin.footprint, `generated water render basin ${index} footprint`);
      return Object.freeze({
        ...basin,
        footprint: Object.freeze({ ...footprint, holes: Object.freeze(Array.isArray(footprint.holes) ? footprint.holes : []) }),
      });
    })),
    reaches: Object.freeze([...topology.reaches]),
  }) as unknown as VerifiedGeneratedWaterRenderResource["topology"];
}

export function parseTransferredDerivedRuntimeSnapshot(input: unknown): ParsedTransferredDerivedSnapshot {
  const snapshot = plain(input, "derived runtime resource snapshot");
  exact(snapshot, ["schema", "projectId", "branchId", "manifestHash", "source", "manifest", "residency", "chunks", "globals"], "derived runtime resource snapshot");
  if (snapshot.schema !== DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA) throw new Error("derived runtime resource snapshot schema is unsupported");
  const manifest = parseDerivedRevisionManifest(snapshot.manifest) as ParsedManifest;
  if (snapshot.projectId !== manifest.projectId || snapshot.branchId !== manifest.branchId
      || snapshot.manifestHash !== manifest.manifestHash || compilerContentHash(snapshot.source) !== compilerContentHash(manifest.source)) {
    throw new Error("derived runtime resource snapshot identity disagrees with its manifest");
  }

  const residency = parseDerivedTerrainResidency(snapshot.residency);
  const expectedChunks = selectDerivedTerrainChunks(manifest, residency);
  const entries = dense(snapshot.chunks, MAX_DETACHED_DERIVED_TERRAIN_MESHES, "derived runtime terrain chunks");
  if (entries.length < 1 || entries.length !== expectedChunks.length) {
    throw new Error("derived runtime terrain residency set is incomplete or exceeds its requested window");
  }
  const manifestChunks = new Map(manifest.chunks.map((chunk) => [chunk.chunkId, chunk]));
  const manifestGlobals = derivedGlobalArtifacts(manifest) as ArtifactDescriptor[];
  const manifestBiomeField = manifestGlobals.find((artifact) => artifact.artifactType === BIOME_FIELD_ARTIFACT_TYPE);
  const seenIds = new Set<string>(), seenCoords = new Set<string>();
  const indexed: IndexedTerrainChunk[] = [];
  const surfaces = new Map<string, ParsedTransferredSurfaceComposite>();
  const populations = new Map<string, ParsedTransferredBiomePopulation>();
  const populationChunks: DetachedDerivedPopulationPlan["chunks"][number][] = [];
  const populationPlacements: DetachedDerivedPopulationPlacement[] = [];
  let populationIdentity: DetachedDerivedPopulationPlan["identity"] | null = null;
  let retainedCpuBytes = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = plain(entries[index], `derived runtime terrain chunk ${index}`);
    exact(entry, ["chunkId", "chunk", "resource"], `derived runtime terrain chunk ${index}`);
    if (typeof entry.chunkId !== "string" || seenIds.has(entry.chunkId)) throw new Error("derived runtime terrain chunks contain duplicate or invalid ids");
    if (entry.chunkId !== expectedChunks[index]?.chunkId) throw new Error("derived runtime terrain chunks do not match requested manifest order");
    const canonical = manifestChunks.get(entry.chunkId);
    if (canonical === undefined || compilerContentHash(entry.chunk) !== compilerContentHash(canonical)) {
      throw new Error(`derived runtime terrain chunk '${entry.chunkId}' identity does not match its manifest`);
    }
    const coordinate = `${canonical.lod}:${canonical.tx}:${canonical.tz}`;
    if (seenCoords.has(coordinate)) throw new Error(`derived runtime terrain coordinate '${coordinate}' is duplicated`);
    if (canonical.artifacts.length < 1 || canonical.artifacts.length > 3) {
      throw new Error(`derived terrain chunk '${canonical.chunkId}' must carry terrain and at most one surface and population artifact`);
    }
    const artifactByType = new Map(canonical.artifacts.map((artifact) => [artifact.artifactType, artifact]));
    if (artifactByType.size !== canonical.artifacts.length
        || [...artifactByType.keys()].some((type) => type !== TERRAIN_CHUNK_ARTIFACT_TYPE
          && type !== SURFACE_COMPOSITE_ARTIFACT_TYPE && type !== BIOME_POPULATION_ARTIFACT_TYPE)) {
      throw new Error(`derived terrain chunk '${canonical.chunkId}' artifact contract is unsupported`);
    }
    const artifact = artifactByType.get(TERRAIN_CHUNK_ARTIFACT_TYPE);
    const surfaceArtifact = artifactByType.get(SURFACE_COMPOSITE_ARTIFACT_TYPE);
    const populationArtifact = artifactByType.get(BIOME_POPULATION_ARTIFACT_TYPE);
    if (artifact === undefined || artifact.mediaType !== TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE
        || artifact.byteLength > MAX_TERRAIN_CHUNK_ARTIFACT_BYTES
        || (surfaceArtifact !== undefined && (surfaceArtifact.mediaType !== SURFACE_COMPOSITE_ARTIFACT_MEDIA_TYPE
          || surfaceArtifact.byteLength > MAX_SURFACE_COMPOSITE_ARTIFACT_BYTES))
        || (populationArtifact !== undefined && (populationArtifact.mediaType !== BIOME_POPULATION_ARTIFACT_MEDIA_TYPE
          || populationArtifact.byteLength > MAX_BIOME_POPULATION_ARTIFACT_BYTES))) {
      throw new Error(`derived terrain chunk '${canonical.chunkId}' artifact contract is unsupported`);
    }
    if (populationArtifact !== undefined && surfaceArtifact === undefined) {
      throw new Error(`derived terrain chunk '${canonical.chunkId}' population is missing its surface identity context`);
    }
    const resource = plain(entry.resource, `derived runtime terrain chunk '${canonical.chunkId}' resource`);
    exact(resource, surfaceArtifact === undefined ? ["kind", "decoded"]
      : populationArtifact === undefined ? ["kind", "decoded", "surface", "artifacts"]
        : ["kind", "decoded", "surface", "population", "artifacts"],
      `derived runtime terrain chunk '${canonical.chunkId}' resource`);
    if (resource.kind !== TERRAIN_CHUNK_ARTIFACT_TYPE) throw new Error(`derived terrain chunk '${canonical.chunkId}' resource kind is unsupported`);
    const tile = parseTransferredTerrainTile(resource.decoded, artifact, `derived terrain chunk '${canonical.chunkId}'`);
    assertDerivedTerrainTilePlacement(tile, canonical, manifest.grid);
    retainedCpuBytes += artifact.byteLength;
    if (surfaceArtifact !== undefined) {
      if (manifestBiomeField === undefined) {
        throw new Error(`derived terrain chunk '${canonical.chunkId}' surface is missing its global biome field dependency`);
      }
      const transferredArtifacts = plain(resource.artifacts, `derived terrain chunk '${canonical.chunkId}' resource artifacts`);
      exact(transferredArtifacts, populationArtifact === undefined ? ["terrain", "surface"] : ["terrain", "surface", "population"],
        `derived terrain chunk '${canonical.chunkId}' resource artifacts`);
      const transferredTerrain = descriptor(transferredArtifacts.terrain, `derived terrain chunk '${canonical.chunkId}' transferred terrain artifact`);
      const transferredSurface = descriptor(transferredArtifacts.surface, `derived terrain chunk '${canonical.chunkId}' transferred surface artifact`);
      const transferredPopulation = populationArtifact === undefined ? undefined
        : descriptor(transferredArtifacts.population, `derived terrain chunk '${canonical.chunkId}' transferred population artifact`);
      if (!sameDescriptor(transferredTerrain, artifact) || !sameDescriptor(transferredSurface, surfaceArtifact)
          || (populationArtifact !== undefined && (transferredPopulation === undefined
            || !sameDescriptor(transferredPopulation, populationArtifact)))) {
        throw new Error(`derived terrain chunk '${canonical.chunkId}' transferred artifact bindings do not match its manifest`);
      }
      // Re-encoding independently revalidates the transferred map hashes, exact schema, and
      // canonical codec bytes before descriptor identity is trusted in the main realm.
      const decodedSurface = resource.surface as ReturnType<typeof decodeSurfaceCompositeArtifact>;
      const canonicalSurfaceBytes = encodeSurfaceCompositeArtifact(decodedSurface);
      if (canonicalSurfaceBytes.byteLength !== surfaceArtifact.byteLength
          || derivedArtifactContentHash(canonicalSurfaceBytes) !== surfaceArtifact.contentHash) {
        throw new Error(`derived terrain chunk '${canonical.chunkId}' surface does not match its canonical descriptor`);
      }
      const expectedOriginX = manifest.grid.origin[0] + canonical.tx * manifest.grid.chunkSizeM;
      const expectedOriginZ = manifest.grid.origin[1] + canonical.tz * manifest.grid.chunkSizeM;
      if (decodedSurface.coord.tx !== canonical.tx || decodedSurface.coord.tz !== canonical.tz || decodedSurface.coord.lod !== canonical.lod
          || decodedSurface.source.terrainChunkHash !== artifact.contentHash
          || decodedSurface.source.biomeFieldHash !== manifestBiomeField.contentHash) {
        throw new Error(`derived terrain chunk '${canonical.chunkId}' surface bindings do not match its terrain, biome field, or coordinate`);
      }
      if (decodedSurface.placement.origin[0] !== expectedOriginX || decodedSurface.placement.origin[1] !== expectedOriginZ
          || decodedSurface.placement.sizeM !== manifest.grid.chunkSizeM
          || decodedSurface.placement.origin[0] !== tile.origin[0] - tile.scale[0] / 2
          || decodedSurface.placement.origin[1] !== tile.origin[2] - tile.scale[2] / 2) {
        throw new Error(`derived terrain chunk '${canonical.chunkId}' surface placement does not match the manifest grid or terrain tile`);
      }
      const decodedBytes = decodedSurface.maps.albedo.data.byteLength
        + decodedSurface.maps.normal.data.byteLength + decodedSurface.maps.orm.data.byteLength;
      retainedCpuBytes += decodedBytes;
      surfaces.set(tileKey(canonical.tx, canonical.tz), Object.freeze({ artifact: surfaceArtifact, decoded: decodedSurface }));

      if (populationArtifact !== undefined) {
        if (manifestBiomeField === undefined) {
          throw new Error(`derived terrain chunk '${canonical.chunkId}' population is missing its global biome field dependency`);
        }
        const transferredPopulationResource = plain(resource.population,
          `derived terrain chunk '${canonical.chunkId}' population resource`);
        exact(transferredPopulationResource, ["plan", "metadata"],
          `derived terrain chunk '${canonical.chunkId}' population resource`);
        const metadata = plain(transferredPopulationResource.metadata,
          `derived terrain chunk '${canonical.chunkId}' population metadata`);
        exact(metadata, ["schema", "artifactType", "mediaType", "version", "byteLength", "contentHash", "storage"],
          `derived terrain chunk '${canonical.chunkId}' population metadata`);
        const canonicalPopulationBytes = encodeBiomePopulationArtifact(transferredPopulationResource.plan);
        if (canonicalPopulationBytes.byteLength !== populationArtifact.byteLength
            || derivedArtifactContentHash(canonicalPopulationBytes) !== populationArtifact.contentHash
            || metadata.artifactType !== BIOME_POPULATION_ARTIFACT_TYPE
            || metadata.mediaType !== BIOME_POPULATION_ARTIFACT_MEDIA_TYPE
            || metadata.schema !== BIOME_POPULATION_ARTIFACT_SCHEMA
            || metadata.byteLength !== populationArtifact.byteLength
            || metadata.contentHash !== populationArtifact.contentHash) {
          throw new Error(`derived terrain chunk '${canonical.chunkId}' population does not match its canonical descriptor`);
        }
        // Decode the canonical main-realm bytes rather than retaining the worker's object graph.
        const decodedPopulation = decodeBiomePopulationArtifact(canonicalPopulationBytes);
        if (compilerContentHash(metadata) !== compilerContentHash(decodedPopulation.metadata)) {
          throw new Error(`derived terrain chunk '${canonical.chunkId}' population metadata is not canonical`);
        }
        const plan = decodedPopulation.plan as ParsedTransferredBiomePopulation["plan"];
        if (plan.coord.tx !== canonical.tx || plan.coord.tz !== canonical.tz || plan.coord.lod !== canonical.lod) {
          throw new Error(`derived terrain chunk '${canonical.chunkId}' population coordinate does not match its manifest chunk`);
        }
        if (plan.identity.fieldContentHash !== manifestBiomeField.contentHash
            || plan.identity.fieldContentHash !== decodedSurface.source.biomeFieldHash) {
          throw new Error(`derived terrain chunk '${canonical.chunkId}' population biome-field identity does not match its publication`);
        }
        if (plan.identity.runtimePackContentHash !== decodedSurface.source.biomePackHash) {
          throw new Error(`derived terrain chunk '${canonical.chunkId}' population runtime-pack identity does not match its surface`);
        }
        if (populationIdentity !== null
            && (populationIdentity.fieldContentHash !== plan.identity.fieldContentHash
              || populationIdentity.runtimePackContentHash !== plan.identity.runtimePackContentHash)) {
          throw new Error("derived terrain population chunks do not share one publication identity");
        }
        if (populationIdentity === null) populationIdentity = Object.freeze({ ...plan.identity });
        const parsedPopulation = Object.freeze({ artifact: populationArtifact, plan });
        populations.set(tileKey(canonical.tx, canonical.tz), parsedPopulation);
        populationChunks.push(Object.freeze({
          tx: canonical.tx,
          tz: canonical.tz,
          lod: canonical.lod,
          contentHash: populationArtifact.contentHash,
          placementCount: plan.placements.length,
        }));
        populationPlacements.push(...plan.placements);
        retainedCpuBytes += populationArtifact.byteLength;
      }
    }
    if (!Number.isSafeInteger(retainedCpuBytes) || retainedCpuBytes > MAX_DETACHED_DERIVED_TERRAIN_CPU_BYTES) {
      throw new RangeError("derived terrain snapshot exceeds the 256 MiB retained CPU budget");
    }
    seenIds.add(entry.chunkId);
    seenCoords.add(coordinate);
    indexed.push(Object.freeze({ chunk: canonical, tile }));
  }
  const terrain = new DerivedLod0TerrainIndex(indexed, manifest.grid);
  const surfaceAt = (tx: number, tz: number): ParsedTransferredSurfaceComposite | undefined => surfaces.get(tileKey(tx, tz));
  const populationAt = (tx: number, tz: number): ParsedTransferredBiomePopulation | undefined => populations.get(tileKey(tx, tz));
  const populationPlan: DetachedDerivedPopulationPlan | null = populationIdentity === null ? null : Object.freeze({
    schema: DETACHED_DERIVED_POPULATION_PLAN_SCHEMA,
    identity: populationIdentity,
    chunks: Object.freeze(populationChunks),
    placements: Object.freeze(populationPlacements),
  });

  const globalEntries = dense(snapshot.globals, 64, "derived runtime globals");
  if (globalEntries.length !== manifestGlobals.length) throw new Error("derived runtime global resource set is incomplete");
  const globals = new Map<string, { artifact: ArtifactDescriptor; resource: Record<string, unknown> }>();
  for (let index = 0; index < globalEntries.length; index++) {
    const entry = plain(globalEntries[index], `derived runtime global ${index}`);
    exact(entry, ["artifactType", "artifact", "resource"], `derived runtime global ${index}`);
    if (typeof entry.artifactType !== "string" || globals.has(entry.artifactType)) throw new Error("derived runtime globals contain duplicate or invalid types");
    const parsedArtifact = descriptor(entry.artifact, `derived runtime global '${entry.artifactType}' artifact`);
    const canonical = manifestGlobals.find((artifact) => artifact.artifactType === entry.artifactType);
    if (canonical === undefined || !sameDescriptor(parsedArtifact, canonical)) throw new Error(`derived runtime global '${entry.artifactType}' identity does not match its manifest`);
    globals.set(entry.artifactType, { artifact: canonical, resource: plain(entry.resource, `derived runtime global '${entry.artifactType}' resource`) });
  }

  let generatedWater: ParsedGeneratedWaterResource | null = null;
  let worldOverview: ReturnType<typeof decodeWorldOverviewArtifact> | null = null;
  let navigationIndex: ReturnType<typeof decodeNavigationIndexArtifact> | null = null;
  let biomeField: ReturnType<typeof decodeBiomeFieldArtifact> | null = null;
  let biomeSampler: ReturnType<typeof createBiomeFieldSampler> | null = null;
  const overview = globals.get(WORLD_OVERVIEW_ARTIFACT_TYPE);
  if (overview !== undefined) {
    exact(overview.resource, ["kind", "decoded"], "world overview resource");
    if (overview.resource.kind !== WORLD_OVERVIEW_ARTIFACT_TYPE) throw new Error("world overview resource kind is unsupported");
    const decodedEnvelope = plain(overview.resource.decoded, "world overview decoded resource");
    exact(decodedEnvelope, ["grid", "metadata"], "world overview decoded resource");
    const canonicalBytes = encodeWorldOverviewArtifact(decodedEnvelope.grid);
    if (overview.artifact.mediaType !== WORLD_OVERVIEW_ARTIFACT_MEDIA_TYPE
        || canonicalBytes.byteLength !== overview.artifact.byteLength
        || derivedArtifactContentHash(canonicalBytes) !== overview.artifact.contentHash) {
      throw new Error("world overview resource does not match its canonical descriptor");
    }
    worldOverview = decodeWorldOverviewArtifact(canonicalBytes);
  }
  const navigation = globals.get(NAVIGATION_INDEX_ARTIFACT_TYPE);
  if (navigation !== undefined) {
    exact(navigation.resource, ["kind", "bytes"], "navigation index resource");
    if (navigation.resource.kind !== NAVIGATION_INDEX_ARTIFACT_TYPE) throw new Error("navigation index resource kind is unsupported");
    const canonicalBytes = completeUint8(navigation.resource.bytes, "navigation index resource bytes");
    if (navigation.artifact.mediaType !== NAVIGATION_INDEX_ARTIFACT_MEDIA_TYPE
        || canonicalBytes.byteLength !== navigation.artifact.byteLength
        || derivedArtifactContentHash(canonicalBytes) !== navigation.artifact.contentHash) {
      throw new Error("navigation index resource does not match its canonical descriptor");
    }
    navigationIndex = decodeNavigationIndexArtifact(canonicalBytes);
  }
  const biome = globals.get(BIOME_FIELD_ARTIFACT_TYPE);
  if (biome !== undefined) {
    exact(biome.resource, ["kind", "bytes"], "biome field resource");
    if (biome.resource.kind !== BIOME_FIELD_ARTIFACT_TYPE) throw new Error("biome field resource kind is unsupported");
    const canonicalBytes = completeUint8(biome.resource.bytes, "biome field resource bytes");
    if (biome.artifact.mediaType !== BIOME_FIELD_ARTIFACT_MEDIA_TYPE
        || canonicalBytes.byteLength !== biome.artifact.byteLength
        || derivedArtifactContentHash(canonicalBytes) !== biome.artifact.contentHash) {
      throw new Error("biome field resource does not match its canonical descriptor");
    }
    biomeField = decodeBiomeFieldArtifact(canonicalBytes);
    biomeSampler = createBiomeFieldSampler(biomeField.field);
  }
  let biomeContent: VerifiedBiomeContentBundle | null = null;
  let biomeRuntimePack: ParsedTransferredDerivedSnapshot["biomeRuntimePack"] = null;
  const content = globals.get(BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE);
  if (content !== undefined) {
    exact(content.resource, ["kind", "bytes"], "biome content closure resource");
    if (content.resource.kind !== BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE) {
      throw new Error("biome content closure resource kind is unsupported");
    }
    const bytes = completeUint8(content.resource.bytes, "biome content closure resource bytes");
    if (content.artifact.mediaType !== BIOME_CONTENT_CLOSURE_ARTIFACT_MEDIA_TYPE
        || bytes.byteLength !== content.artifact.byteLength
        || derivedArtifactContentHash(bytes) !== content.artifact.contentHash) {
      throw new Error("biome content closure resource does not match its canonical descriptor");
    }
    biomeContent = decodeBiomeContentClosureArtifact(bytes).bundle as VerifiedBiomeContentBundle;
  }
  const runtimePackResource = globals.get(BIOME_RUNTIME_PACK_ARTIFACT_TYPE);
  if (runtimePackResource !== undefined) {
    exact(runtimePackResource.resource, ["kind", "bytes"], "biome runtime-pack resource");
    if (runtimePackResource.resource.kind !== BIOME_RUNTIME_PACK_ARTIFACT_TYPE) throw new Error("biome runtime-pack resource kind is unsupported");
    const bytes = completeUint8(runtimePackResource.resource.bytes, "biome runtime-pack resource bytes");
    if (runtimePackResource.artifact.mediaType !== BIOME_RUNTIME_PACK_ARTIFACT_MEDIA_TYPE
        || bytes.byteLength !== runtimePackResource.artifact.byteLength
        || derivedArtifactContentHash(bytes) !== runtimePackResource.artifact.contentHash) {
      throw new Error("biome runtime-pack resource does not match its canonical descriptor");
    }
    const decoded = decodeBiomeRuntimePackArtifact(bytes);
    biomeRuntimePack = Object.freeze({ bytes, semanticContentHash: decoded.semanticContentHash });
  }
  const water = globals.get(HYDROLOGY_WATER_ARTIFACT_TYPE);
  const hydrologyField = globals.get(HYDROLOGY_FIELD_ARTIFACT_TYPE);
  let renderField: VerifiedGeneratedWaterRenderResource["field"] | null = null;
  if (hydrologyField !== undefined) {
    exact(hydrologyField.resource, ["kind", "decoded"], "hydrology field resource");
    if (hydrologyField.resource.kind !== HYDROLOGY_FIELD_ARTIFACT_TYPE) throw new Error("hydrology field resource kind is unsupported");
    const decoded = plain(hydrologyField.resource.decoded, "hydrology field decoded resource");
    exact(decoded, ["placement", "topology", "artifact"], "hydrology field decoded resource");
    const canonicalBytes = encodeHydrologyFieldArtifact(decoded.topology, decoded.placement);
    if (hydrologyField.artifact.mediaType !== HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE
        || canonicalBytes.byteLength !== hydrologyField.artifact.byteLength
        || derivedArtifactContentHash(canonicalBytes) !== hydrologyField.artifact.contentHash) {
      throw new Error("hydrology field resource does not match its canonical descriptor");
    }
    const canonical = decodeHydrologyFieldArtifact(canonicalBytes) as unknown as Readonly<{
      placement: Readonly<{ originX: number; originZ: number }>;
      topology: Readonly<{ rows: number; cols: number; cellSizeM: number; seaLevelM: number; oceanMask: Uint8Array }>;
    }>;
    renderField = Object.freeze({
      placement: Object.freeze({ originX: canonical.placement.originX, originZ: canonical.placement.originZ }),
      rows: canonical.topology.rows,
      cols: canonical.topology.cols,
      cellSizeM: canonical.topology.cellSizeM,
      seaLevelM: canonical.topology.seaLevelM,
      oceanMask: canonical.topology.oceanMask,
    });
  }
  for (const artifactType of globals.keys()) {
    if (artifactType !== HYDROLOGY_FIELD_ARTIFACT_TYPE && artifactType !== HYDROLOGY_WATER_ARTIFACT_TYPE
        && artifactType !== WORLD_OVERVIEW_ARTIFACT_TYPE && artifactType !== NAVIGATION_INDEX_ARTIFACT_TYPE
        && artifactType !== BIOME_FIELD_ARTIFACT_TYPE && artifactType !== BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE
        && artifactType !== BIOME_RUNTIME_PACK_ARTIFACT_TYPE) {
      throw new Error(`derived render candidate does not support global '${artifactType}'`);
    }
  }
  if (populationPlan !== null) {
    if (biomeContent === null) throw new Error("verified biome population is missing its content closure");
    if (biomeRuntimePack === null) throw new Error("verified biome population is missing its runtime-pack artifact");
    if (biomeContent.runtimePack.contentHash !== populationPlan.identity.runtimePackContentHash) {
      throw new Error("biome content closure runtime-pack identity does not match population plans");
    }
    if (biomeRuntimePack.semanticContentHash !== biomeContent.runtimePack.contentHash) {
      throw new Error("biome runtime-pack artifact semantic identity does not match its content closure");
    }
    const authorized = new Map(biomeContent.entries.map((entry) => [entry.assetId, entry]));
    for (const placement of populationPlan.placements) {
      const entry = authorized.get(placement.assetId);
      if (entry?.kind !== "population-descriptor" || entry.contentHash !== placement.contentHash) {
        throw new Error(`biome population descriptor '${placement.assetId}' is not authorized by its content closure`);
      }
    }
  }
  if (water !== undefined) {
    const field = hydrologyField;
    if (field === undefined) throw new Error("generated water is missing its hydrology field dependency");
    exact(water.resource, ["kind", "artifact", "bytes", "bindings", "prepared"], "generated water resource");
    if (water.resource.kind !== HYDROLOGY_WATER_ARTIFACT_TYPE) throw new Error("generated water resource kind is unsupported");
    const resourceArtifact = descriptor(water.resource.artifact, "generated water resource artifact");
    if (!sameDescriptor(resourceArtifact, water.artifact) || resourceArtifact.mediaType !== HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE) {
      throw new Error("generated water resource artifact does not match its manifest descriptor");
    }
    const bytes = completeUint8(water.resource.bytes, "generated water resource bytes");
    if (bytes.byteLength !== resourceArtifact.byteLength || derivedArtifactContentHash(bytes) !== resourceArtifact.contentHash) {
      throw new Error("generated water resource bytes do not match their canonical descriptor");
    }
    const parsedBindings = bindings(water.resource.bindings);
    const rawBindings = inspectHydrologyWaterArtifactBindings(bytes) as ParsedGeneratedWaterResource["bindings"];
    if (compilerContentHash(parsedBindings) !== compilerContentHash(rawBindings)
        || parsedBindings.hydrologyFieldContentHash !== field.artifact.contentHash
        || parsedBindings.compilerGraphHash !== derivedArtifactCompilerGraphHash(manifest, HYDROLOGY_WATER_ARTIFACT_TYPE)) {
      throw new Error("generated water resource bindings do not match its bytes, field, or compiler graph");
    }
    const prepared = plain(water.resource.prepared, "generated water prepared resource");
    exact(prepared, ["artifactContentHash", "bindings", "topology"], "generated water prepared resource");
    if (prepared.artifactContentHash !== resourceArtifact.contentHash
        || compilerContentHash(prepared.bindings) !== compilerContentHash(parsedBindings)) {
      throw new Error("generated water prepared identity does not match its canonical artifact");
    }
    generatedWater = Object.freeze({
      artifact: resourceArtifact,
      bytes,
      bindings: parsedBindings,
      render: Object.freeze({
        artifactHash: resourceArtifact.contentHash,
        topology: generatedRenderTopology(prepared.topology),
        field: renderField!,
        sampleTerrainHeight: (x: number, z: number): number | null => terrain.sampleHeight(x, z),
      }),
    });
  }

  return Object.freeze({
    schema: DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA,
    projectId: manifest.projectId,
    branchId: manifest.branchId,
    manifestHash: manifest.manifestHash,
    source: Object.freeze({ revision: manifest.source.revision, headHash: manifest.source.headHash }),
    manifest,
    residency,
    terrain,
    surfaceAt,
    populationAt,
    populationPlan,
    biomeContent,
    biomeRuntimePack,
    retainedCpuBytes,
    worldOverview,
    navigationIndex,
    biomeField,
    biomeSampler,
    generatedWater,
  });
}

function hexRgb(hex: number): readonly [number, number, number] {
  return Object.freeze([((hex >>> 16) & 0xff) / 255, ((hex >>> 8) & 0xff) / 255, (hex & 0xff) / 255]);
}

const OVERVIEW_PAINT_COLORS = Object.freeze(TERRAIN_PAINT_ALBEDO_HEX.map((hex) => (
  hex === null ? null : hexRgb(hex)
)));
const OVERVIEW_GRASS = hexRgb(TERRAIN_ELEVATION_ALBEDO_HEX.grass);
const OVERVIEW_GRASS_DARK = hexRgb(TERRAIN_ELEVATION_ALBEDO_HEX.grassDark);
const OVERVIEW_ROCK = hexRgb(TERRAIN_ELEVATION_ALBEDO_HEX.rock);

function buildWorldOverviewMesh(
  overview: NonNullable<ParsedTransferredDerivedSnapshot["worldOverview"]>,
  terrainWindow: readonly DetachedDerivedTerrainWindowEntry[],
): Readonly<{ mesh: THREE.Mesh; bounds: Readonly<DetachedWorldOverviewBounds> }> {
  const { grid } = overview;
  const count = grid.rows * grid.cols;
  const positions = new Float32Array(count * 3);
  // Native WebGPU requires every vertex-buffer stride to be 4-byte aligned. A packed RGB8
  // attribute has a 3-byte stride and is accepted by WebGL but rejected by wgpu; RGBA8 keeps
  // the same normalized colour while satisfying both backends.
  const colors = new Uint8Array(count * 4);
  let minY = Infinity, maxY = -Infinity;
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const cell = row * grid.cols + col;
      const vertex = cell * 3;
      const color = cell * 4;
      positions[vertex] = col * grid.stepM;
      positions[vertex + 1] = grid.heights[cell];
      positions[vertex + 2] = row * grid.stepM;
      minY = Math.min(minY, grid.heights[cell]);
      maxY = Math.max(maxY, grid.heights[cell]);
      const left = grid.heights[row * grid.cols + Math.max(0, col - 1)]!;
      const right = grid.heights[row * grid.cols + Math.min(grid.cols - 1, col + 1)]!;
      const top = grid.heights[Math.max(0, row - 1) * grid.cols + col]!;
      const bottom = grid.heights[Math.min(grid.rows - 1, row + 1) * grid.cols + col]!;
      const slope = Math.min(1, Math.hypot(right - left, bottom - top) / (2 * grid.stepM));
      const worldX = grid.origin[0] + col * grid.stepM;
      const worldZ = grid.origin[1] + row * grid.stepM;
      const mottle = (Math.sin(worldX * 0.2 + worldZ * 0.2) * 0.5 + 0.5) * 0.3;
      const rockWeight = Math.min(1, Math.max(0, (slope * 1.2 - 0.18) / 0.32));
      const unpainted = [0, 1, 2].map((channel) => {
        const grass = OVERVIEW_GRASS[channel]! + (OVERVIEW_GRASS_DARK[channel]! - OVERVIEW_GRASS[channel]!) * mottle;
        return grass + (OVERVIEW_ROCK[channel]! - grass) * rockWeight;
      });
      const paint = OVERVIEW_PAINT_COLORS[grid.paintMaterial[cell]] ?? null;
      const weight = grid.paintWeight[cell] / 255;
      for (let channel = 0; channel < 3; channel++) {
        const value = paint === null ? unpainted[channel]! : unpainted[channel]! + (paint[channel]! - unpainted[channel]!) * weight;
        colors[color + channel] = Math.round(255 * value);
      }
      colors[color + 3] = 255;
    }
  }
  // Fine chunks own the proxy quad whose centre lies inside their footprint. This bounds overlap
  // to half a proxy cell while avoiding the visible holes caused by removing every intersecting quad.
  const quadCols = grid.cols - 1, quadRows = grid.rows - 1;
  const covered = new Uint8Array(quadCols * quadRows);
  for (const entry of terrainWindow) {
    const halfX = entry.tile.scale[0] / 2, halfZ = entry.tile.scale[2] / 2;
    const localMinX = entry.tile.origin[0] - halfX - grid.origin[0];
    const localMaxX = entry.tile.origin[0] + halfX - grid.origin[0];
    const localMinZ = entry.tile.origin[2] - halfZ - grid.origin[1];
    const localMaxZ = entry.tile.origin[2] + halfZ - grid.origin[1];
    const minCol = Math.max(0, Math.ceil(localMinX / grid.stepM - 0.5));
    const maxCol = Math.min(quadCols - 1, Math.floor(localMaxX / grid.stepM - 0.5));
    const minRow = Math.max(0, Math.ceil(localMinZ / grid.stepM - 0.5));
    const maxRow = Math.min(quadRows - 1, Math.floor(localMaxZ / grid.stepM - 0.5));
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) covered[row * quadCols + col] = 1;
    }
  }
  // A Uint16 index buffer wraps silently past 65 536 vertices; the overview format allows up to
  // WORLD_OVERVIEW_MAX_DIMENSION² = 257×257 = 66 049.
  const indices = count > 65_536 ? new Uint32Array(quadRows * quadCols * 6) : new Uint16Array(quadRows * quadCols * 6);
  let offset = 0;
  for (let row = 0; row < quadRows; row++) {
    for (let col = 0; col < quadCols; col++) {
      if (covered[row * quadCols + col] !== 0) continue;
      const a = row * grid.cols + col, b = a + 1, c = a + grid.cols, d = c + 1;
      indices[offset++] = a; indices[offset++] = c; indices[offset++] = b;
      indices[offset++] = b; indices[offset++] = c; indices[offset++] = d;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4, true));
  geometry.setIndex(new THREE.BufferAttribute(indices.subarray(0, offset), 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0,
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(grid.origin[0], 0, grid.origin[1]);
  mesh.name = "limina:world-overview-terrain";
  mesh.userData.derivedWorldOverview = true;
  mesh.frustumCulled = true;
  return Object.freeze({
    mesh,
    bounds: Object.freeze({
      minX: grid.origin[0],
      minY,
      minZ: grid.origin[1],
      maxX: grid.origin[0] + (grid.cols - 1) * grid.stepM,
      maxY,
      maxZ: grid.origin[1] + (grid.rows - 1) * grid.stepM,
    }),
  });
}

interface DerivedTerrainSurfaceFrame {
  readonly seaLevelM: number;
  readonly minY: number;
  readonly maxY: number;
  readonly source: "hydrology" | "window-relief-fallback";
}

function terrainWindowSurfaceFrame(
  tiles: readonly TerrainTile[],
  hydrologySeaLevelM?: number,
): DerivedTerrainSurfaceFrame {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const tile of tiles) {
    for (const height of tile.heights) {
      const worldY = tile.origin[1] + height * tile.scale[1];
      minY = Math.min(minY, worldY);
      maxY = Math.max(maxY, worldY);
    }
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) throw new Error("derived terrain surface frame requires finite staged relief");
  if (hydrologySeaLevelM !== undefined) {
    if (!Number.isFinite(hydrologySeaLevelM)) throw new Error("derived terrain hydrology sea level must be finite");
    return Object.freeze({ seaLevelM: hydrologySeaLevelM, minY, maxY, source: "hydrology" as const });
  }
  const relief = Math.max(0, maxY - minY);
  const dryMargin = Math.min(5, Math.max(0.25, relief * 0.05));
  return Object.freeze({
    seaLevelM: minY - dryMargin,
    minY,
    maxY,
    source: "window-relief-fallback" as const,
  });
}

function featureLocalTerrainMesh(tile: TerrainTile, frame: DerivedTerrainSurfaceFrame): THREE.Mesh {
  const localTile: TerrainTile = {
    ...tile,
    origin: [0, 0, 0],
  };
  const mesh = buildTerrainMesh(localTile, {
    pbr: {
      seaLevel: frame.seaLevelM - tile.origin[1],
      minY: frame.minY - tile.origin[1],
      maxY: frame.maxY - tile.origin[1],
      featureLocalOrigin: tile.origin,
    },
  });
  mesh.position.set(tile.origin[0], tile.origin[1], tile.origin[2]);
  mesh.name = "limina:derived-terrain-chunk";
  mesh.userData.derivedTerrain = true;
  mesh.userData.derivedTerrainSurfaceFrame = Object.freeze({
    seaLevelM: frame.seaLevelM,
    minY: frame.minY,
    maxY: frame.maxY,
    localSeaLevel: frame.seaLevelM - tile.origin[1],
    localMinY: frame.minY - tile.origin[1],
    localMaxY: frame.maxY - tile.origin[1],
    source: frame.source,
  });
  return mesh;
}

function disposeUnpooledTerrainMaterial(material: THREE.Material | THREE.Material[]): void {
  const errors: unknown[] = [];
  for (const owned of Array.isArray(material) ? material : [material]) {
    const textures = owned.userData.liminaOwnedTextures;
    if (Array.isArray(textures)) {
      owned.userData.liminaOwnedTextures = [];
      for (const texture of textures) try { (texture as THREE.Texture).dispose(); } catch (error) { errors.push(error); }
    }
    try { owned.dispose(); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, "provisional derived terrain material disposal failed");
}

/** Replace only the provisional material; geometry remains candidate-owned. */
function installBiomeSurfaceMaterial(mesh: THREE.Mesh, surface: ParsedTransferredSurfaceComposite): BiomeSurfaceMaterialMount {
  let mount: BiomeSurfaceMaterialMount;
  try {
    mount = buildBiomeSurfaceMaterial(surface.decoded, {
      localBounds: [-surface.decoded.placement.sizeM / 2, -surface.decoded.placement.sizeM / 2,
        surface.decoded.placement.sizeM / 2, surface.decoded.placement.sizeM / 2],
    });
  } catch (error) {
    try { disposeTerrainMesh(mesh); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "biome surface material build and provisional terrain cleanup failed");
    }
    throw error;
  }
  const provisional = mesh.material;
  mesh.material = mount.material;
  try {
    disposeUnpooledTerrainMaterial(provisional);
  } catch (error) {
    const errors: unknown[] = [error];
    try { mesh.geometry.dispose(); } catch (cleanupError) { errors.push(cleanupError); }
    try { mount.dispose(); } catch (cleanupError) { errors.push(cleanupError); }
    throw new AggregateError(errors, "biome surface material installation failed");
  }
  mesh.userData.derivedBiomeSurface = Object.freeze({
    artifact: surface.artifact,
    source: surface.decoded.source,
    coord: surface.decoded.coord,
  });
  mesh.geometry.userData.derivedBiomeSurface = true;
  return mount;
}

const UNSTAGED_POPULATION_STATUS: Readonly<DerivedPresentationStatus> = Object.freeze({
  groundCover: "unfulfilled" as const,
  groundCoverTiles: 0,
  groundCoverBlades: 0,
  climateProfiles: Object.freeze([]),
  canopy: "unfulfilled" as const,
  canopyReason: "verified biome population has not been mounted",
  groundCoverReason: "verified biome population has not been mounted",
  populationPlacements: 0,
});

/** Detached initial camera-window candidate. Dynamic post-activation streaming remains the live adapter's job. */
export class DetachedDerivedRenderCandidate {
  readonly snapshot: ParsedTransferredDerivedSnapshot;
  readonly root = new THREE.Group();
  readonly terrainRoot = new THREE.Group();
  readonly waterRoot = new THREE.Group();
  readonly overviewRoot = new THREE.Group();
  readonly populationRoot = new THREE.Group();
  /** Compatibility alias; all vegetation now belongs to the verified population mount. */
  readonly groundCoverRoot = this.populationRoot;
  readonly overviewBounds: Readonly<DetachedWorldOverviewBounds> | null;
  readonly #terrainMeshes = new Map<string, THREE.Mesh>();
  readonly #surfaceMounts = new Map<string, BiomeSurfaceMaterialMount>();
  readonly #waterManager: VisibleWaterManager;
  readonly #waterMount: GeneratedWaterRenderMount | null;
  #overviewMesh: THREE.Mesh | null;
  readonly #terrainWindow: readonly DetachedDerivedTerrainWindowEntry[];
  #populationMount: DetachedDerivedPopulationMount | null = null;
  #populationStage: "available" | "staging" | "staged" | "failed" = "available";
  #presentationStatus: Readonly<DerivedPresentationStatus> = UNSTAGED_POPULATION_STATUS;
  #disposed = false;

  constructor(snapshotInput: unknown, options: DetachedDerivedRenderCandidateOptions) {
    const optionRecord = plain(options, "detached derived render candidate options");
    const optionKeys = Object.getOwnPropertyNames(optionRecord);
    const supportedOptions = new Set(["quality", "maxTerrainMeshes"]);
    if (optionKeys.some((key) => !supportedOptions.has(key))) {
      throw new TypeError("detached derived render candidate options are invalid");
    }
    for (const key of optionKeys) {
      const field = Object.getOwnPropertyDescriptor(optionRecord, key);
      if (field?.enumerable !== true || field.get !== undefined || field.set !== undefined) {
        throw new TypeError(`detached derived render candidate options.${key} must be an enumerable data field`);
      }
    }
    const maxMeshes = options.maxTerrainMeshes ?? MAX_DETACHED_DERIVED_TERRAIN_MESHES;
    if (!Number.isSafeInteger(maxMeshes) || maxMeshes < 1 || maxMeshes > MAX_DETACHED_DERIVED_TERRAIN_MESHES) {
      throw new RangeError(`derived terrain maxTerrainMeshes must be in [1, ${MAX_DETACHED_DERIVED_TERRAIN_MESHES}]`);
    }
    const tier = options.quality ?? "balanced";
    const quality = DEFAULT_RENDER_QUALITY_PROFILES[tier];
    if (quality === undefined) throw new TypeError("derived render quality tier is invalid");
    this.snapshot = parseTransferredDerivedRuntimeSnapshot(snapshotInput);

    this.root.name = `limina:derived-revision:${this.snapshot.manifestHash}`;
    this.terrainRoot.name = "limina:derived-terrain";
    this.waterRoot.name = "limina:derived-water";
    this.overviewRoot.name = "limina:world-overview";
    this.populationRoot.name = "limina:derived-biome-population";
    this.root.add(this.overviewRoot, this.terrainRoot, this.waterRoot, this.populationRoot);
    this.#waterManager = new VisibleWaterManager(this.waterRoot, quality.water);
    let waterMount: GeneratedWaterRenderMount | null = null;
    let overviewMesh: THREE.Mesh | null = null;
    let overviewBounds: Readonly<DetachedWorldOverviewBounds> | null = null;
    const terrainWindow: DetachedDerivedTerrainWindowEntry[] = [];
    try {
      const available = selectDerivedTerrainChunks(this.snapshot.manifest, this.snapshot.residency);
      if (available.length > maxMeshes) throw new RangeError(`derived terrain window requires ${available.length} meshes, exceeding budget ${maxMeshes}`);
      const stagedTiles = available.map((chunk) => ({ chunk, tile: this.snapshot.terrain.tile(chunk.tx, chunk.tz)! }));
      const surfaceFrame = terrainWindowSurfaceFrame(
        stagedTiles.map((entry) => entry.tile),
        this.snapshot.generatedWater?.render.field.seaLevelM,
      );
      for (const { chunk, tile } of stagedTiles) {
        const mesh = featureLocalTerrainMesh(tile, surfaceFrame);
        const key = tileKey(chunk.tx, chunk.tz);
        const surface = this.snapshot.surfaceAt(chunk.tx, chunk.tz);
        const surfaceMount = surface === undefined ? null : installBiomeSurfaceMaterial(mesh, surface);
        this.#terrainMeshes.set(key, mesh);
        if (surfaceMount !== null) this.#surfaceMounts.set(key, surfaceMount);
        terrainWindow.push(Object.freeze({ key, tx: chunk.tx, tz: chunk.tz, tile, ...(surface === undefined ? {} : { surface }) }));
        this.terrainRoot.add(mesh);
      }
      if (this.snapshot.worldOverview !== null) {
        const built = buildWorldOverviewMesh(this.snapshot.worldOverview, terrainWindow);
        overviewMesh = built.mesh;
        overviewBounds = built.bounds;
        this.overviewRoot.add(overviewMesh);
      }
      if (this.snapshot.generatedWater !== null) {
        waterMount = mountGeneratedWaterResource(this.snapshot.generatedWater.render, this.#waterManager);
      }
    } catch (error) {
      try { waterMount?.dispose(); } catch { /* preserve the staging error */ }
      try { this.#waterManager.dispose(); } catch { /* preserve the staging error */ }
      if (overviewMesh !== null) {
        this.overviewRoot.remove(overviewMesh);
        try { overviewMesh.geometry.dispose(); } catch { /* preserve the staging error */ }
        try { (overviewMesh.material as THREE.Material).dispose(); } catch { /* preserve the staging error */ }
      }
      for (const [key, mesh] of this.#terrainMeshes) {
        this.terrainRoot.remove(mesh);
        const surfaceMount = this.#surfaceMounts.get(key);
        if (surfaceMount === undefined) {
          try { disposeTerrainMesh(mesh); } catch { /* preserve the staging error */ }
        } else {
          try { mesh.geometry.dispose(); } catch { /* preserve the staging error */ }
          try { surfaceMount.dispose(); } catch { /* preserve the staging error */ }
        }
      }
      this.#terrainMeshes.clear();
      this.#surfaceMounts.clear();
      this.root.clear();
      throw error;
    }
    this.#waterMount = waterMount;
    this.#overviewMesh = overviewMesh;
    this.overviewBounds = overviewBounds;
    this.#terrainWindow = Object.freeze(terrainWindow);
  }

  get disposed(): boolean { return this.#disposed; }
  get terrainMeshCount(): number { return this.#terrainMeshes.size; }
  get waterFragmentCount(): number { return this.#waterManager.size; }
  get groundCoverBladeCount(): number { return this.#presentationStatus.groundCoverBlades; }
  get groundCoverTileCount(): number { return this.#presentationStatus.groundCoverTiles; }
  presentationStatus(): Readonly<DerivedPresentationStatus> { return this.#presentationStatus; }
  get overviewMeshCount(): number { return this.#disposed || this.#overviewMesh === null ? 0 : 1; }
  get overviewTriangleCount(): number {
    const index = this.#overviewMesh?.geometry.index;
    return this.#disposed || index === null || index === undefined ? 0 : index.count / 3;
  }
  get quality(): Readonly<WaterRenderQuality> { return this.#waterManager.quality; }

  /** Exact initial bounded window for main/sim collider staging; no internal mutable map escapes. */
  terrainWindow(): readonly DetachedDerivedTerrainWindowEntry[] { return this.#terrainWindow; }

  /**
   * Mount the independently verified aggregate population exactly once. The factory receives a
   * candidate-owned scene root and must roll back its own provisional resources if it throws.
   * Once it returns, the candidate assumes terminal disposal ownership of the mount.
   */
  async stagePopulation(factory: DetachedDerivedPopulationFactory): Promise<void> {
    if (this.#disposed) throw new Error("detached derived render candidate is disposed");
    if (typeof factory !== "function") throw new TypeError("derived population factory must be a function");
    const plan = this.snapshot.populationPlan;
    if (plan === null) throw new Error("detached derived render candidate has no verified population plan");
    if (this.#populationStage !== "available") {
      throw new Error(`detached derived population stage is already ${this.#populationStage}`);
    }
    this.#populationStage = "staging";
    let mount: DetachedDerivedPopulationMount | null = null;
    try {
      if (this.snapshot.biomeContent === null) throw new Error("detached derived population has no verified content closure");
      if (this.snapshot.biomeRuntimePack === null || this.snapshot.biomeField === null) {
        throw new Error("detached derived population is missing its biome field or runtime pack");
      }
      const biomeFieldBytes = encodeBiomeFieldArtifact(this.snapshot.biomeField.field);
      const waterCoverageAt = this.snapshot.generatedWater === null
        ? (_x: number, _z: number): boolean => false
        // Cover the full distant-grass candidate jitter/footprint, not only the grid sample point.
        // A narrower seam lets an accepted LOD1 cluster jitter back into the rendered river.
        : (x: number, z: number): boolean => generatedWaterCoversPoint(this.snapshot.generatedWater!.render, x, z, 0.8);
      mount = await factory(Object.freeze({ plan, content: this.snapshot.biomeContent, root: this.populationRoot,
        terrainWindow: this.#terrainWindow,
        biomeField: Object.freeze({ bytes: biomeFieldBytes, contentHash: plan.identity.fieldContentHash }),
        runtimePack: this.snapshot.biomeRuntimePack, waterCoverageAt }));
      if (mount === null || typeof mount !== "object" || typeof mount.dispose !== "function") {
        throw new TypeError("derived population factory returned an invalid mount");
      }
      for (const [label, value] of [
        ["canopyInstances", mount.canopyInstances],
        ["groundCoverTiles", mount.groundCoverTiles],
        ["groundCoverBlades", mount.groundCoverBlades],
      ] as const) {
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new TypeError(`derived population mount.${label} must be a non-negative safe integer`);
        }
      }
      if (this.#disposed) throw new Error("detached derived render candidate was disposed during population staging");
      this.#populationMount = mount;
      this.#populationStage = "staged";
      this.#presentationStatus = Object.freeze({
        groundCover: mount.groundCoverBlades > 0 ? "ready" as const : "empty" as const,
        groundCoverTiles: mount.groundCoverTiles,
        groundCoverBlades: mount.groundCoverBlades,
        climateProfiles: Object.freeze([]),
        canopy: mount.canopyInstances > 0 ? "ready" as const : "empty" as const,
        canopyReason: mount.canopyInstances > 0
          ? "verified biome population mount is active"
          : "verified biome population contains no resident canopy",
        groundCoverReason: mount.groundCoverBlades > 0
          ? "verified biome population mount is active"
          : "verified biome population contains no resident ground cover",
        populationPlacements: plan.placements.length,
      });
    } catch (primary) {
      this.#populationStage = "failed";
      this.populationRoot.clear();
      if (mount !== null && this.#populationMount !== mount) {
        try { mount.dispose(); } catch (rollback) {
          throw new AggregateError([primary, rollback], "derived population staging and rollback failed");
        }
      }
      throw primary;
    }
  }

  setQuality(tier: RenderQualityTier): void {
    if (this.#disposed) throw new Error("detached derived render candidate is disposed");
    const profile = DEFAULT_RENDER_QUALITY_PROFILES[tier];
    if (profile === undefined) throw new TypeError("derived render quality tier is invalid");
    this.#waterManager.setQuality(profile.water);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors: unknown[] = [];
    const populationMount = this.#populationMount;
    this.#populationMount = null;
    if (populationMount !== null) try { populationMount.dispose(); } catch (error) { errors.push(error); }
    this.populationRoot.clear();
    this.#presentationStatus = UNSTAGED_POPULATION_STATUS;
    try { this.#waterMount?.dispose(); } catch (error) { errors.push(error); }
    try { this.#waterManager.dispose(); } catch (error) { errors.push(error); }
    const overviewMesh = this.#overviewMesh;
    this.#overviewMesh = null;
    if (overviewMesh !== null) {
      this.overviewRoot.remove(overviewMesh);
      try { overviewMesh.geometry.dispose(); } catch (error) { errors.push(error); }
      try { (overviewMesh.material as THREE.Material).dispose(); } catch (error) { errors.push(error); }
    }
    for (const [key, mesh] of this.#terrainMeshes) {
      this.terrainRoot.remove(mesh);
      const surfaceMount = this.#surfaceMounts.get(key);
      if (surfaceMount === undefined) {
        try { disposeTerrainMesh(mesh); } catch (error) { errors.push(error); }
      } else {
        try { mesh.geometry.dispose(); } catch (error) { errors.push(error); }
        try { surfaceMount.dispose(); } catch (error) { errors.push(error); }
      }
    }
    this.#terrainMeshes.clear();
    this.#surfaceMounts.clear();
    this.root.clear();
    if (errors.length > 0) throw new AggregateError(errors, "detached derived render candidate disposal failed");
  }
}
