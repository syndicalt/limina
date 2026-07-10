import * as THREE from "../../build/three.bundle.mjs";
import {
  DEFAULT_RENDER_QUALITY_PROFILES,
  type RenderQualityTier,
  type WaterRenderQuality,
} from "../render/quality.ts";
import {
  mountGeneratedWaterResource,
  type GeneratedWaterRenderMount,
  type VerifiedGeneratedWaterRenderResource,
} from "../render/water/generated-water-renderer.ts";
import { VisibleWaterManager } from "../render/water/visible-water-manager.ts";
import {
  TerrainMaterialPool,
  applyPaintOverlay,
  buildTerrainMesh,
  disposeTerrainMesh,
} from "../terrain/render.ts";
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
  derivedArtifactContentHash,
  derivedGlobalArtifacts,
  parseDerivedRevisionManifest,
} from "../world/compiler/manifest.mjs";
import {
  TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE,
  MAX_TERRAIN_CHUNK_ARTIFACT_BYTES,
} from "../world/compiler/terrain-artifact.mjs";
import {
  HYDROLOGY_FIELD_ARTIFACT_TYPE,
} from "../world/hydrology-artifact.mjs";
import {
  HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_WATER_ARTIFACT_TYPE,
  inspectHydrologyWaterArtifactBindings,
} from "../world/hydrology-water-artifact.mjs";

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
  readonly generatedWater: ParsedGeneratedWaterResource | null;
}

export interface DetachedDerivedRenderCandidateOptions {
  readonly quality?: RenderQualityTier;
  readonly maxTerrainMeshes?: number;
}

export interface DetachedDerivedTerrainWindowEntry {
  readonly key: string;
  readonly tx: number;
  readonly tz: number;
  readonly tile: TerrainTile;
}

function plain(value: unknown, label: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0 || names.length !== expected.size
      || names.some((name) => !expected.has(name))) {
    throw new TypeError(`${label} fields are invalid`);
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new TypeError(`${label}.${name} must be an enumerable data field`);
    }
  }
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
  const seenIds = new Set<string>(), seenCoords = new Set<string>();
  const indexed: IndexedTerrainChunk[] = [];
  let retainedTerrainBytes = 0;
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
    if (canonical.artifacts.length !== 1) throw new Error(`derived terrain chunk '${canonical.chunkId}' must carry exactly one artifact`);
    const artifact = canonical.artifacts[0];
    if (artifact.artifactType !== TERRAIN_CHUNK_ARTIFACT_TYPE || artifact.mediaType !== TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE
        || artifact.byteLength > MAX_TERRAIN_CHUNK_ARTIFACT_BYTES) {
      throw new Error(`derived terrain chunk '${canonical.chunkId}' artifact contract is unsupported`);
    }
    const resource = plain(entry.resource, `derived runtime terrain chunk '${canonical.chunkId}' resource`);
    exact(resource, ["kind", "decoded"], `derived runtime terrain chunk '${canonical.chunkId}' resource`);
    if (resource.kind !== TERRAIN_CHUNK_ARTIFACT_TYPE) throw new Error(`derived terrain chunk '${canonical.chunkId}' resource kind is unsupported`);
    const tile = parseTransferredTerrainTile(resource.decoded, artifact, `derived terrain chunk '${canonical.chunkId}'`);
    assertDerivedTerrainTilePlacement(tile, canonical, manifest.grid);
    retainedTerrainBytes += artifact.byteLength;
    if (!Number.isSafeInteger(retainedTerrainBytes) || retainedTerrainBytes > MAX_DETACHED_DERIVED_TERRAIN_CPU_BYTES) {
      throw new RangeError("derived terrain snapshot exceeds the 256 MiB retained CPU budget");
    }
    seenIds.add(entry.chunkId);
    seenCoords.add(coordinate);
    indexed.push(Object.freeze({ chunk: canonical, tile }));
  }

  const globalEntries = dense(snapshot.globals, 64, "derived runtime globals");
  const manifestGlobals = derivedGlobalArtifacts(manifest) as ArtifactDescriptor[];
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
  const water = globals.get(HYDROLOGY_WATER_ARTIFACT_TYPE);
  const hydrologyField = globals.get(HYDROLOGY_FIELD_ARTIFACT_TYPE);
  if (hydrologyField !== undefined) {
    exact(hydrologyField.resource, ["kind", "decoded"], "hydrology field resource");
    if (hydrologyField.resource.kind !== HYDROLOGY_FIELD_ARTIFACT_TYPE) throw new Error("hydrology field resource kind is unsupported");
  }
  for (const artifactType of globals.keys()) {
    if (artifactType !== HYDROLOGY_FIELD_ARTIFACT_TYPE && artifactType !== HYDROLOGY_WATER_ARTIFACT_TYPE) {
      throw new Error(`derived render candidate does not support global '${artifactType}'`);
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
        || parsedBindings.compilerGraphHash !== manifest.compiler.graphHash) {
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
      render: Object.freeze({ artifactHash: resourceArtifact.contentHash, topology: generatedRenderTopology(prepared.topology) }),
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
    terrain: new DerivedLod0TerrainIndex(indexed, manifest.grid),
    generatedWater,
  });
}

function featureLocalTerrainMesh(tile: TerrainTile, materialPool: TerrainMaterialPool): THREE.Mesh {
  const localTile: TerrainTile = {
    ...tile,
    origin: [0, 0, 0],
  };
  const mesh = buildTerrainMesh(localTile, {
    elevationColors: { seaLevel: 0, amplitude: Math.max(1, tile.scale[1]), snowFrac: 1 },
    materialPool,
  });
  if (tile.paintMat !== undefined) applyPaintOverlay(mesh.geometry, localTile);
  mesh.position.set(tile.origin[0], tile.origin[1], tile.origin[2]);
  mesh.name = "limina:derived-terrain-chunk";
  mesh.userData.derivedTerrain = true;
  return mesh;
}

/** Detached initial camera-window candidate. Dynamic post-activation streaming remains the live adapter's job. */
export class DetachedDerivedRenderCandidate {
  readonly snapshot: ParsedTransferredDerivedSnapshot;
  readonly root = new THREE.Group();
  readonly terrainRoot = new THREE.Group();
  readonly waterRoot = new THREE.Group();
  readonly #terrainMeshes = new Map<string, THREE.Mesh>();
  readonly #terrainMaterials = new TerrainMaterialPool();
  readonly #waterManager: VisibleWaterManager;
  readonly #waterMount: GeneratedWaterRenderMount | null;
  readonly #terrainWindow: readonly DetachedDerivedTerrainWindowEntry[];
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
    this.root.add(this.terrainRoot, this.waterRoot);
    this.#waterManager = new VisibleWaterManager(this.waterRoot, quality.water);
    let waterMount: GeneratedWaterRenderMount | null = null;
    const terrainWindow: DetachedDerivedTerrainWindowEntry[] = [];
    try {
      const available = selectDerivedTerrainChunks(this.snapshot.manifest, this.snapshot.residency);
      if (available.length > maxMeshes) throw new RangeError(`derived terrain window requires ${available.length} meshes, exceeding budget ${maxMeshes}`);
      for (const chunk of available) {
        const tile = this.snapshot.terrain.tile(chunk.tx, chunk.tz)!;
        const mesh = featureLocalTerrainMesh(tile, this.#terrainMaterials);
        const key = tileKey(chunk.tx, chunk.tz);
        this.#terrainMeshes.set(key, mesh);
        terrainWindow.push(Object.freeze({ key, tx: chunk.tx, tz: chunk.tz, tile }));
        this.terrainRoot.add(mesh);
      }
      if (this.snapshot.generatedWater !== null) {
        waterMount = mountGeneratedWaterResource(this.snapshot.generatedWater.render, this.#waterManager);
      }
    } catch (error) {
      try { waterMount?.dispose(); } catch { /* preserve the staging error */ }
      try { this.#waterManager.dispose(); } catch { /* preserve the staging error */ }
      for (const mesh of this.#terrainMeshes.values()) {
        this.terrainRoot.remove(mesh);
        try { disposeTerrainMesh(mesh); } catch { /* preserve the staging error */ }
      }
      this.#terrainMeshes.clear();
      try { this.#terrainMaterials.dispose(); } catch { /* preserve the staging error */ }
      this.root.clear();
      throw error;
    }
    this.#waterMount = waterMount;
    this.#terrainWindow = Object.freeze(terrainWindow);
  }

  get disposed(): boolean { return this.#disposed; }
  get terrainMeshCount(): number { return this.#terrainMeshes.size; }
  get waterFragmentCount(): number { return this.#waterManager.size; }
  get quality(): Readonly<WaterRenderQuality> { return this.#waterManager.quality; }

  /** Exact initial bounded window for main/sim collider staging; no internal mutable map escapes. */
  terrainWindow(): readonly DetachedDerivedTerrainWindowEntry[] { return this.#terrainWindow; }

  setQuality(tier: RenderQualityTier): void {
    if (this.#disposed) throw new Error("detached derived render candidate is disposed");
    const profile = DEFAULT_RENDER_QUALITY_PROFILES[tier];
    if (profile === undefined) throw new TypeError("derived render quality tier is invalid");
    this.#waterManager.setQuality(profile.water);
  }

  dispose(): void {
    if (this.#disposed) return;
    const errors: unknown[] = [];
    try { this.#waterMount?.dispose(); } catch (error) { errors.push(error); }
    try { this.#waterManager.dispose(); } catch (error) { errors.push(error); }
    for (const mesh of this.#terrainMeshes.values()) {
      this.terrainRoot.remove(mesh);
      try { disposeTerrainMesh(mesh); } catch (error) { errors.push(error); }
    }
    this.#terrainMeshes.clear();
    try { this.#terrainMaterials.dispose(); } catch (error) { errors.push(error); }
    this.root.clear();
    if (errors.length === 0) this.#disposed = true;
    if (errors.length > 0) throw new AggregateError(errors, "detached derived render candidate disposal failed");
  }
}
