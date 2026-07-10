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
  TERRAIN_ELEVATION_ALBEDO_HEX,
  TERRAIN_PAINT_ALBEDO_HEX,
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
  readonly worldOverview: ReturnType<typeof decodeWorldOverviewArtifact> | null;
  readonly navigationIndex: ReturnType<typeof decodeNavigationIndexArtifact> | null;
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
  let worldOverview: ReturnType<typeof decodeWorldOverviewArtifact> | null = null;
  let navigationIndex: ReturnType<typeof decodeNavigationIndexArtifact> | null = null;
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
  const water = globals.get(HYDROLOGY_WATER_ARTIFACT_TYPE);
  const hydrologyField = globals.get(HYDROLOGY_FIELD_ARTIFACT_TYPE);
  if (hydrologyField !== undefined) {
    exact(hydrologyField.resource, ["kind", "decoded"], "hydrology field resource");
    if (hydrologyField.resource.kind !== HYDROLOGY_FIELD_ARTIFACT_TYPE) throw new Error("hydrology field resource kind is unsupported");
  }
  for (const artifactType of globals.keys()) {
    if (artifactType !== HYDROLOGY_FIELD_ARTIFACT_TYPE && artifactType !== HYDROLOGY_WATER_ARTIFACT_TYPE
        && artifactType !== WORLD_OVERVIEW_ARTIFACT_TYPE && artifactType !== NAVIGATION_INDEX_ARTIFACT_TYPE) {
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
    worldOverview,
    navigationIndex,
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
  const colors = new Uint8Array(count * 3);
  let minY = Infinity, maxY = -Infinity;
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const cell = row * grid.cols + col;
      const vertex = cell * 3;
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
        colors[vertex + channel] = Math.round(255 * value);
      }
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
  const indices = new Uint16Array(quadRows * quadCols * 6);
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
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3, true));
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
  readonly overviewRoot = new THREE.Group();
  readonly overviewBounds: Readonly<DetachedWorldOverviewBounds> | null;
  readonly #terrainMeshes = new Map<string, THREE.Mesh>();
  readonly #terrainMaterials = new TerrainMaterialPool();
  readonly #waterManager: VisibleWaterManager;
  readonly #waterMount: GeneratedWaterRenderMount | null;
  #overviewMesh: THREE.Mesh | null;
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
    this.overviewRoot.name = "limina:world-overview";
    this.root.add(this.overviewRoot, this.terrainRoot, this.waterRoot);
    this.#waterManager = new VisibleWaterManager(this.waterRoot, quality.water);
    let waterMount: GeneratedWaterRenderMount | null = null;
    let overviewMesh: THREE.Mesh | null = null;
    let overviewBounds: Readonly<DetachedWorldOverviewBounds> | null = null;
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
    this.#overviewMesh = overviewMesh;
    this.overviewBounds = overviewBounds;
    this.#terrainWindow = Object.freeze(terrainWindow);
  }

  get disposed(): boolean { return this.#disposed; }
  get terrainMeshCount(): number { return this.#terrainMeshes.size; }
  get waterFragmentCount(): number { return this.#waterManager.size; }
  get overviewMeshCount(): number { return this.#disposed || this.#overviewMesh === null ? 0 : 1; }
  get overviewTriangleCount(): number {
    const index = this.#overviewMesh?.geometry.index;
    return this.#disposed || index === null || index === undefined ? 0 : index.count / 3;
  }
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
    this.#disposed = true;
    const errors: unknown[] = [];
    try { this.#waterMount?.dispose(); } catch (error) { errors.push(error); }
    try { this.#waterManager.dispose(); } catch (error) { errors.push(error); }
    const overviewMesh = this.#overviewMesh;
    this.#overviewMesh = null;
    if (overviewMesh !== null) {
      this.overviewRoot.remove(overviewMesh);
      try { overviewMesh.geometry.dispose(); } catch (error) { errors.push(error); }
      try { (overviewMesh.material as THREE.Material).dispose(); } catch (error) { errors.push(error); }
    }
    for (const mesh of this.#terrainMeshes.values()) {
      this.terrainRoot.remove(mesh);
      try { disposeTerrainMesh(mesh); } catch (error) { errors.push(error); }
    }
    this.#terrainMeshes.clear();
    try { this.#terrainMaterials.dispose(); } catch (error) { errors.push(error); }
    this.root.clear();
    if (errors.length > 0) throw new AggregateError(errors, "detached derived render candidate disposal failed");
  }
}
