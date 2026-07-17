/**
 * The ONE derived-snapshot verifier (H8). Every byte of a transferred derived runtime
 * resource snapshot is validated against its manifest hashes HERE — per-chunk canonical
 * re-encode, content-hash checks, tile placement asserts, binding identity — before any
 * of it may touch the scene. The module is deliberately dependency-light (no `three`
 * import, no DOM use) so the exact same verifier loads in a dedicated Worker realm:
 * the venue (worker vs inline) is a performance decision; the contract is identical.
 *
 * Verify-before-use is verify-before-CONSTRUCT: `ParsedTransferredDerivedSnapshot` is
 * branded and minted only by this module (type-level via a private unique symbol,
 * runtime via a module-private WeakSet — TS types are erased on this untranspiled
 * host, so the WeakSet is the load-bearing enforcement). The render candidate's
 * constructor accepts only that branded output. Do not fork any check in this file
 * into a sibling module — one verifier, reused, is the seam.
 *
 * Worker protocol: the main thread posts the untrusted snapshot WITHOUT a transfer
 * list — callers RETAIN their snapshot (the editor re-activates the same object for
 * Play-start and edit-reboot), so the request must never detach the caller's buffers;
 * the structured clone copies each one (one memcpy ≪ the hashing this offloads). The
 * worker verifies and posts the structured-clone-safe verification back TRANSFERRING
 * its buffers. Verify-before-use still holds — TOCTOU is closed on the RESPONSE path:
 * the render candidate consumes only the worker-verified copy moved back here, never
 * the caller's still-mutable original. The main realm hydrates that verified copy
 * (index/closure rebuild only, no re-validation of verified content).
 */

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
import { tileKey } from "../terrain/stream.ts";
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
} from "../world/compiler/navigation-index-artifact.mjs";
import {
  BIOME_FIELD_ARTIFACT_MEDIA_TYPE,
  BIOME_FIELD_ARTIFACT_TYPE,
  decodeBiomeFieldArtifact,
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
import { exactDataKeys, plainRecord } from "./derived-plain-data.ts";

export const DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA = "limina.derived-runtime-resource-snapshot/v2";

export const MAX_DETACHED_DERIVED_TERRAIN_RADIUS = MAX_DERIVED_TERRAIN_RESIDENCY_RADIUS;
export const MAX_DETACHED_DERIVED_TERRAIN_MESHES = MAX_DERIVED_TERRAIN_RESIDENCY_CHUNKS;
export const MAX_DETACHED_DERIVED_TERRAIN_CPU_BYTES = 256 * 1024 * 1024;
const TERRAIN_CHUNK_ARTIFACT_TYPE = "terrain-chunk/v1";
const HASH = /^sha256:[0-9a-f]{64}$/;

type ArtifactDescriptor = DerivedTerrainArtifactDescriptor;

type ManifestChunk = DerivedTerrainManifestChunk;

export type ParsedDerivedManifest = Readonly<{
  manifestHash: string;
  projectId: string;
  branchId: string;
  source: Readonly<{ revision: number; headHash: string }>;
  compiler: Readonly<{ graphHash: string }>;
  grid: Readonly<{ schema: string; gridId: string; origin: readonly [number, number]; chunkSizeM: number; defaultSamples: number }>;
  chunks: readonly ManifestChunk[];
}>;

// ── Verified generated-water render views (the trust-boundary shapes the render
//    adapter consumes; owned here so the render module is not an import of the
//    worker-loadable verifier). ──

export type WaterViewPoint2 = readonly [number, number];

export interface GeneratedWaterfallSpanView {
  readonly startSegment: number;
  readonly endSegmentExclusive: number;
  readonly totalDropM: number;
}

export interface GeneratedBasinView {
  readonly id: string;
  readonly spillLevelM: number;
  readonly maxDepthM: number;
  readonly footprint: {
    readonly points: readonly WaterViewPoint2[];
    readonly holes: readonly (readonly WaterViewPoint2[])[];
  };
}

export interface GeneratedWaterFieldView {
  readonly placement: { readonly originX: number; readonly originZ: number };
  readonly rows: number;
  readonly cols: number;
  readonly cellSizeM: number;
  /** Descriptor-verified hydrology sea level; presentation consumers must not infer it from codec bounds. */
  readonly seaLevelM: number;
  readonly oceanMask: Uint8Array;
}

export interface GeneratedReachView {
  readonly id: string;
  readonly class: "stream" | "river";
  readonly order: number;
  readonly points: readonly WaterViewPoint2[];
  readonly widths: readonly number[];
  readonly terrainElevationsM: readonly number[];
  readonly surfaceElevationsM: readonly number[];
  readonly waterfalls: readonly GeneratedWaterfallSpanView[];
}

export interface GeneratedWaterTopologyView {
  readonly schema: string;
  readonly version: number;
  readonly basins: readonly GeneratedBasinView[];
  readonly reaches: readonly GeneratedReachView[];
}

/** Adapter boundary for a topology that was decoded and binding-verified off the render thread. */
export interface VerifiedGeneratedWaterRenderResource {
  readonly artifactHash: string;
  readonly topology: GeneratedWaterTopologyView;
  /** Descriptor-verified hydrology domain used to reject pixels outside this water artifact's field. */
  readonly field: GeneratedWaterFieldView;
  /** Exact resident derived-terrain sampler. Missing tiles produce transparent water, never guessed depth. */
  readonly sampleTerrainHeight: (x: number, z: number) => number | null;
}

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

declare const VERIFIED_DERIVED_SNAPSHOT_BRAND: unique symbol;

export interface ParsedTransferredDerivedSnapshot {
  /** Type-level mint restricted to this module; the runtime twin is the module WeakSet. */
  readonly [VERIFIED_DERIVED_SNAPSHOT_BRAND]: true;
  readonly schema: typeof DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA;
  readonly projectId: string;
  readonly branchId: string;
  readonly manifestHash: string;
  readonly source: Readonly<{ revision: number; headHash: string }>;
  readonly manifest: ParsedDerivedManifest;
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

/**
 * The structured-clone-safe result of verification: plain data + typed arrays only —
 * no class instances, no closures — so it survives the worker→main postMessage.
 * The realm-local pieces (terrain index, lookup closures, samplers) are rebuilt by
 * hydration from this verified content without re-running the byte-level checks.
 */
export interface VerifiedTransferredDerivedSnapshot {
  readonly manifest: ParsedDerivedManifest;
  readonly residency: Readonly<DerivedTerrainResidency>;
  readonly indexed: readonly IndexedTerrainChunk[];
  readonly surfaces: readonly (readonly [string, ParsedTransferredSurfaceComposite])[];
  readonly populations: readonly (readonly [string, ParsedTransferredBiomePopulation])[];
  readonly populationPlan: DetachedDerivedPopulationPlan | null;
  readonly biomeContent: VerifiedBiomeContentBundle | null;
  readonly biomeRuntimePack: Readonly<{ bytes: Uint8Array; semanticContentHash: string }> | null;
  readonly retainedCpuBytes: number;
  readonly worldOverview: ReturnType<typeof decodeWorldOverviewArtifact> | null;
  /** Canonical (hash-verified) navigation bytes; the searchable index state is realm-local and is re-decoded at hydration. */
  readonly navigationIndexBytes: Uint8Array | null;
  readonly biomeField: ReturnType<typeof decodeBiomeFieldArtifact> | null;
  readonly generatedWater: Readonly<{
    artifact: ArtifactDescriptor;
    bytes: Uint8Array;
    bindings: ParsedGeneratedWaterResource["bindings"];
    topology: GeneratedWaterTopologyView;
    field: GeneratedWaterFieldView;
  }> | null;
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

function generatedRenderTopology(value: unknown): GeneratedWaterTopologyView {
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
  }) as unknown as GeneratedWaterTopologyView;
}

/**
 * The full trust-boundary pass: validate every field, re-encode every canonical
 * codec, and check every content hash and binding of an untrusted transferred
 * snapshot. Pure and realm-agnostic — it is the expensive stage that runs in the
 * verify worker (or inline where no Worker exists). Throws on the first violation.
 */
export function verifyTransferredDerivedRuntimeSnapshot(input: unknown): VerifiedTransferredDerivedSnapshot {
  const snapshot = plain(input, "derived runtime resource snapshot");
  exact(snapshot, ["schema", "projectId", "branchId", "manifestHash", "source", "manifest", "residency", "chunks", "globals"], "derived runtime resource snapshot");
  if (snapshot.schema !== DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA) throw new Error("derived runtime resource snapshot schema is unsupported");
  const manifest = parseDerivedRevisionManifest(snapshot.manifest) as ParsedDerivedManifest;
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
      // canonical codec bytes before descriptor identity is trusted in this realm.
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
        // Decode the canonical bytes rather than retaining the transferred object graph.
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

  let generatedWater: VerifiedTransferredDerivedSnapshot["generatedWater"] = null;
  let worldOverview: ReturnType<typeof decodeWorldOverviewArtifact> | null = null;
  let navigationIndexBytes: Uint8Array | null = null;
  let biomeField: ReturnType<typeof decodeBiomeFieldArtifact> | null = null;
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
    // Decode validates the codec now; the searchable state it builds is realm-local
    // (WeakMap-keyed to the decode result), so hydration re-decodes the same bytes.
    decodeNavigationIndexArtifact(canonicalBytes);
    navigationIndexBytes = canonicalBytes;
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
  }
  let biomeContent: VerifiedBiomeContentBundle | null = null;
  let biomeRuntimePack: VerifiedTransferredDerivedSnapshot["biomeRuntimePack"] = null;
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
  let renderField: GeneratedWaterFieldView | null = null;
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
      topology: generatedRenderTopology(prepared.topology),
      field: renderField!,
    });
  }

  return Object.freeze({
    manifest,
    residency,
    indexed: Object.freeze(indexed),
    surfaces: Object.freeze([...surfaces.entries()].map(([key, value]) => Object.freeze([key, value] as const))),
    populations: Object.freeze([...populations.entries()].map(([key, value]) => Object.freeze([key, value] as const))),
    populationPlan,
    biomeContent,
    biomeRuntimePack,
    retainedCpuBytes,
    worldOverview,
    navigationIndexBytes,
    biomeField,
    generatedWater,
  });
}

const VERIFIED_DERIVED_SNAPSHOTS = new WeakSet<object>();

export function isVerifiedTransferredDerivedSnapshot(value: unknown): value is ParsedTransferredDerivedSnapshot {
  return typeof value === "object" && value !== null && VERIFIED_DERIVED_SNAPSHOTS.has(value);
}

/** Runtime half of the brand: types are erased on this host, so consumers that must
 *  only accept verified snapshots (the render candidate constructor) assert here. */
export function assertVerifiedTransferredDerivedSnapshot(value: unknown): ParsedTransferredDerivedSnapshot {
  if (!isVerifiedTransferredDerivedSnapshot(value)) {
    throw new TypeError(
      "derived render candidate requires a snapshot verified by derived-runtime-verify (parseTransferredDerivedRuntimeSnapshot or the verify worker)",
    );
  }
  return value;
}

function freezePlacement(placement: DetachedDerivedPopulationPlacement): DetachedDerivedPopulationPlacement {
  return Object.isFrozen(placement) ? placement : Object.freeze({ ...placement });
}

/**
 * Rebuild the realm-local runtime shape (index, lookup closures, samplers, searchable
 * navigation state) from verified content and mint the branded snapshot. Structured
 * clone drops frozen-ness and prototypes, so hydration re-freezes and re-canonicalizes
 * through the SAME parse helpers — it never re-checks content hashes, and it is
 * module-private so verification cannot be skipped.
 */
function hydrateVerifiedDerivedSnapshot(data: VerifiedTransferredDerivedSnapshot): ParsedTransferredDerivedSnapshot {
  const manifest = parseDerivedRevisionManifest(data.manifest) as ParsedDerivedManifest;
  const residency = parseDerivedTerrainResidency(data.residency);
  const indexed = data.indexed.map((entry) => Object.freeze({ chunk: entry.chunk, tile: Object.freeze(entry.tile) }));
  const terrain = new DerivedLod0TerrainIndex(indexed, manifest.grid);
  const surfaces = new Map<string, ParsedTransferredSurfaceComposite>(
    data.surfaces.map(([key, value]) => [key, Object.freeze({ artifact: Object.freeze({ ...value.artifact }), decoded: value.decoded })]),
  );
  const populations = new Map<string, ParsedTransferredBiomePopulation>(
    data.populations.map(([key, value]) => [key, Object.freeze({ artifact: Object.freeze({ ...value.artifact }), plan: value.plan })]),
  );
  const populationPlan: DetachedDerivedPopulationPlan | null = data.populationPlan === null ? null : Object.freeze({
    schema: DETACHED_DERIVED_POPULATION_PLAN_SCHEMA,
    identity: Object.freeze({ ...data.populationPlan.identity }),
    chunks: Object.freeze(data.populationPlan.chunks.map((chunk) => Object.freeze({ ...chunk }))),
    placements: Object.freeze(data.populationPlan.placements.map(freezePlacement)),
  });
  const biomeContent: VerifiedBiomeContentBundle | null = data.biomeContent === null ? null : Object.freeze({
    ...data.biomeContent,
    runtimePack: Object.freeze({ ...data.biomeContent.runtimePack }),
    entries: Object.freeze(data.biomeContent.entries.map((entry) => Object.freeze({ ...entry }))),
  });
  const biomeRuntimePack = data.biomeRuntimePack === null ? null
    : Object.freeze({ bytes: data.biomeRuntimePack.bytes, semanticContentHash: data.biomeRuntimePack.semanticContentHash });
  const navigationIndex = data.navigationIndexBytes === null ? null : decodeNavigationIndexArtifact(data.navigationIndexBytes);
  const biomeField = data.biomeField;
  const biomeSampler = biomeField === null ? null : createBiomeFieldSampler(biomeField.field);
  const generatedWater: ParsedGeneratedWaterResource | null = data.generatedWater === null ? null : Object.freeze({
    artifact: Object.freeze({ ...data.generatedWater.artifact }),
    bytes: data.generatedWater.bytes,
    bindings: Object.freeze({ ...data.generatedWater.bindings }),
    render: Object.freeze({
      artifactHash: data.generatedWater.artifact.contentHash,
      topology: data.generatedWater.topology,
      field: data.generatedWater.field,
      sampleTerrainHeight: (x: number, z: number): number | null => terrain.sampleHeight(x, z),
    }),
  });
  const surfaceAt = (tx: number, tz: number): ParsedTransferredSurfaceComposite | undefined => surfaces.get(tileKey(tx, tz));
  const populationAt = (tx: number, tz: number): ParsedTransferredBiomePopulation | undefined => populations.get(tileKey(tx, tz));
  const snapshot = Object.freeze({
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
    retainedCpuBytes: data.retainedCpuBytes,
    worldOverview: data.worldOverview,
    navigationIndex,
    biomeField,
    biomeSampler,
    generatedWater,
  }) as unknown as ParsedTransferredDerivedSnapshot;
  VERIFIED_DERIVED_SNAPSHOTS.add(snapshot);
  return snapshot;
}

/** The synchronous venue: verify + hydrate inline. Headless gates and environments
 *  without `Worker` run exactly this; the worker path runs the same two stages. */
export function parseTransferredDerivedRuntimeSnapshot(input: unknown): ParsedTransferredDerivedSnapshot {
  return hydrateVerifiedDerivedSnapshot(verifyTransferredDerivedRuntimeSnapshot(input));
}

/** Every ArrayBuffer reachable from a snapshot/verification graph, deduplicated —
 *  the worker→main RESPONSE transfer list (and the client's detached-buffer scan).
 *  Never used as a request transfer list: callers retain their snapshot, so the
 *  request path must copy, not detach (see the module doc). SharedArrayBuffer-backed
 *  views are deliberately excluded: they cannot be detached, and the verifier
 *  rejects them anyway. */
export function collectDerivedSnapshotTransferables(value: unknown): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object" || seen.has(node as object)) return;
    seen.add(node as object);
    if (node instanceof ArrayBuffer) {
      buffers.add(node);
      return;
    }
    if (ArrayBuffer.isView(node)) {
      if (node.buffer instanceof ArrayBuffer) buffers.add(node.buffer);
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    if (node instanceof Map) {
      for (const [key, entry] of node) {
        visit(key);
        visit(entry);
      }
      return;
    }
    if (node instanceof Set) {
      for (const entry of node) visit(entry);
      return;
    }
    for (const key of Object.getOwnPropertyNames(node)) {
      const field = Object.getOwnPropertyDescriptor(node, key);
      if (field !== undefined && "value" in field) visit(field.value);
    }
  };
  visit(value);
  return [...buffers];
}

// ───────────────────────────────────────────────────────────────────────────────
// Verify worker realm (sim-worker pattern: worker-API-agnostic controller + thin
// shell). The controller and client live HERE so hydration — the only mint of the
// branded snapshot — never leaves this module.
// ───────────────────────────────────────────────────────────────────────────────

export const DERIVED_VERIFY_WORKER_SCHEMA = "limina.derived-verify-worker/v1";
const MAX_VERIFY_ERROR_MESSAGE_LENGTH = 2_048;

export interface DerivedVerifyWorkerPost {
  (message: unknown, transfer?: Transferable[]): void;
}

function shortVerifyError(error: unknown): Readonly<{ errorName: string; errorMessage: string }> {
  const errorName = error instanceof RangeError ? "RangeError" : error instanceof TypeError ? "TypeError" : "Error";
  const raw = error instanceof Error ? error.message : String(error);
  return Object.freeze({
    errorName,
    errorMessage: raw.length <= MAX_VERIFY_ERROR_MESSAGE_LENGTH ? raw : `${raw.slice(0, MAX_VERIFY_ERROR_MESSAGE_LENGTH - 3)}...`,
  });
}

function reviveVerifyError(errorName: unknown, errorMessage: unknown): Error {
  const message = typeof errorMessage === "string" ? errorMessage : "derived snapshot verification failed";
  if (errorName === "RangeError") return new RangeError(message);
  if (errorName === "TypeError") return new TypeError(message);
  return new Error(message);
}

/** Worker-side controller: one message shape in, one verification (or one rejection)
 *  out. Worker-API-agnostic so gates drive it headless without a Worker global. */
export function createDerivedVerifyWorkerController(post: DerivedVerifyWorkerPost): (message: unknown) => void {
  if (typeof post !== "function") throw new TypeError("derived verify worker post must be a function");
  return (message: unknown): void => {
    const requestId = (message !== null && typeof message === "object"
      && Number.isSafeInteger((message as Record<string, unknown>).requestId))
      ? (message as Record<string, unknown>).requestId as number
      : null;
    try {
      const record = plainRecord(message, "derived verify request");
      exactDataKeys(record, ["schema", "type", "requestId", "snapshot"], [], "derived verify request");
      if (record.schema !== DERIVED_VERIFY_WORKER_SCHEMA || record.type !== "verify" || requestId === null) {
        throw new TypeError("derived verify request envelope is invalid");
      }
      const verification = verifyTransferredDerivedRuntimeSnapshot(record.snapshot);
      // Transferring the verified buffers back is the TOCTOU closure: the bytes this
      // realm verified are detached here and become the only copy the main realm uses.
      post(
        { schema: DERIVED_VERIFY_WORKER_SCHEMA, type: "verified", requestId, verification },
        collectDerivedSnapshotTransferables(verification),
      );
    } catch (error) {
      post({ schema: DERIVED_VERIFY_WORKER_SCHEMA, type: "verify-rejected", requestId, ...shortVerifyError(error) });
    }
  };
}

export interface DerivedVerifyWorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** Thin shell wiring for a real dedicated Worker (see derived-verify-worker-entry.ts). */
export function installDerivedVerifyWorker(scope: DerivedVerifyWorkerScope): void {
  const handle = createDerivedVerifyWorkerController((message, transfer) => scope.postMessage(message, transfer));
  scope.onmessage = (event) => handle(event.data);
}

export interface DerivedVerifyChannel {
  /** Post one request toward the verify realm, transferring the listed buffers. */
  post(message: unknown, transfer: Transferable[]): void;
  /** Install the single response handler (a Worker's `onmessage`, or a loopback). */
  listen(handler: (message: unknown) => void): void;
}

interface PendingVerify {
  readonly resolve: (snapshot: ParsedTransferredDerivedSnapshot) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | null;
}

/** Fail fast, with a cause the caller can act on, when a snapshot already carries
 *  detached ArrayBuffers — the signature of a snapshot whose memory was transferred
 *  away by an earlier postMessage. Without this the detachment surfaces later as an
 *  opaque verification failure (zero-length views) or a browser DataCloneError.
 *  Detection uses `ArrayBuffer.prototype.detached` where the host provides it;
 *  elsewhere the downstream verification failure remains the (less specific) signal. */
function assertNoDetachedSnapshotBuffers(snapshot: unknown): void {
  if (!("detached" in ArrayBuffer.prototype)) return;
  for (const buffer of collectDerivedSnapshotTransferables(snapshot)) {
    if ((buffer as ArrayBuffer & { detached: boolean }).detached) {
      throw new TypeError(
        "derived snapshot carries a detached ArrayBuffer — its memory was already transferred away; "
        + "verify requests never detach (buffers are cloned), so the snapshot was detached before it reached this client",
      );
    }
  }
}

/**
 * Main-realm client over any DerivedVerifyChannel. On success it hydrates the
 * worker's verification into the branded snapshot — the identical object contract
 * the inline `parseTransferredDerivedRuntimeSnapshot` produces.
 */
export class DerivedSnapshotVerifier {
  readonly #channel: DerivedVerifyChannel;
  readonly #timeoutMs: number | null;
  readonly #pending = new Map<number, PendingVerify>();
  #sequence = 0;
  #failure: Error | null = null;

  constructor(channel: DerivedVerifyChannel, options: Readonly<{ timeoutMs?: number | null }> = {}) {
    if (channel === null || typeof channel !== "object"
        || typeof channel.post !== "function" || typeof channel.listen !== "function") {
      throw new TypeError("derived snapshot verifier requires a post/listen channel");
    }
    const timeoutMs = options.timeoutMs === undefined ? 60_000 : options.timeoutMs;
    if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100)) {
      throw new RangeError("derived snapshot verifier timeoutMs must be null or an integer >= 100");
    }
    this.#timeoutMs = timeoutMs;
    this.#channel = channel;
    channel.listen((message) => this.#receive(message));
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  verify(snapshot: unknown): Promise<ParsedTransferredDerivedSnapshot> {
    if (this.#failure !== null) return Promise.reject(this.#failure);
    const requestId = ++this.#sequence;
    return new Promise<ParsedTransferredDerivedSnapshot>((resolve, reject) => {
      const timer = this.#timeoutMs === null ? null : setTimeout(() => {
        if (this.#pending.delete(requestId)) reject(new Error("derived snapshot verification timed out"));
      }, this.#timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer });
      try {
        // The caller RETAINS its snapshot (the editor re-posts the same object on
        // Play-start and edit-reboot re-activation), so the request transfer list is
        // EMPTY: the channel's structured clone copies each buffer (one memcpy per
        // buffer, far cheaper than the hashing this offloads) and the caller's
        // original stays attached for later re-verification. TOCTOU stays closed on
        // the response path — the candidate consumes the worker's verified copy,
        // transferred back, never the caller's still-mutable original.
        assertNoDetachedSnapshotBuffers(snapshot);
        this.#channel.post({ schema: DERIVED_VERIFY_WORKER_SCHEMA, type: "verify", requestId, snapshot }, []);
      } catch (error) {
        this.#settle(requestId)?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Channel-level failure (worker error/termination): reject everything in flight
   *  and every later call on THIS client. The caller's snapshots stay attached
   *  (requests never detach), so a fresh client — or the inline verifier — can
   *  legitimately re-verify the same retained snapshot after a worker failure. */
  fail(error: Error): void {
    if (this.#failure === null) this.#failure = error;
    for (const requestId of [...this.#pending.keys()]) this.#settle(requestId)?.reject(error);
  }

  #settle(requestId: number): PendingVerify | undefined {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return undefined;
    this.#pending.delete(requestId);
    if (pending.timer !== null) clearTimeout(pending.timer);
    return pending;
  }

  #receive(message: unknown): void {
    if (message === null || typeof message === "undefined" || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.schema !== DERIVED_VERIFY_WORKER_SCHEMA || !Number.isSafeInteger(record.requestId)) return;
    const pending = this.#settle(record.requestId as number);
    if (pending === undefined) return;
    if (record.type === "verified") {
      try {
        pending.resolve(hydrateVerifiedDerivedSnapshot(record.verification as VerifiedTransferredDerivedSnapshot));
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    if (record.type === "verify-rejected") {
      pending.reject(reviveVerifyError(record.errorName, record.errorMessage));
      return;
    }
    pending.reject(new Error("derived verify worker sent an unsupported response"));
  }
}
