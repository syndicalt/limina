import { WorldMapSchema, migrateWorldMap, verifyWorldMap, type WorldMap } from "../worldmap.ts";
import { createMapTerrainField, sliceMapFieldChunk, MapFieldCancelledError, MAP_FIELD_MARGIN_M, MAX_MAP_FIELD_MASTER_RES } from "../../terrain/map-field.mjs";
import {
  createTerrainEditBaseTopology,
  parseTerrainEditLayer,
  prepareTerrainEditLayers,
  composePreparedTerrainEditLayers,
  preparedTerrainEditLayerChunkSlices,
  TerrainEditCancelledError,
} from "../../terrain/edit-layer.mjs";
import { terrainChunkRangeForBounds, terrainChunkTopology } from "../../terrain/grid.mjs";
import { validateErosionRecipe } from "../pipeline/erosion.mjs";
import { HYDROLOGY_TOPOLOGY_VERSION, HydrologyTopologyCancelledError, createHydrologyTopology } from "../hydrology-topology.mjs";
import {
  HYDROLOGY_FIELD_ARTIFACT_VERSION,
  HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_FIELD_ARTIFACT_TYPE,
  HydrologyArtifactCancelledError,
  encodeHydrologyFieldArtifact,
} from "../hydrology-artifact.mjs";
import {
  HYDROLOGY_COMBINED_WATER_TOPOLOGY_VERSION,
  HydrologyWaterTopologyCancelledError,
  extractHydrologyWaterTopology,
} from "../hydrology-water-topology.mjs";
import {
  HYDROLOGY_WATER_ARTIFACT_VERSION,
  HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
  HYDROLOGY_WATER_ARTIFACT_TYPE,
  HydrologyWaterArtifactCancelledError,
  encodeHydrologyWaterArtifact,
} from "../hydrology-water-artifact.mjs";
import { BIOME_LIBRARY_V1 } from "../biome-library-v1.mjs";
import { biomePackContentHash } from "../biome-ir.mjs";
import {
  WORLD_BIOME_CLIMATE_FEATHER,
  WORLD_BIOME_FIELD_COMPILER_VERSION,
  WORLD_BIOME_FIELD_POLICY,
  WORLD_BIOME_FIELD_TOP_N,
  WORLD_BIOME_PRECIPITATION_CEILING_MM_PER_YEAR,
  WorldBiomeFieldCancelledError,
  compileWorldBiomeField,
} from "./world-biome-field.mjs";
import {
  BIOME_FIELD_ARTIFACT_MEDIA_TYPE,
  BIOME_FIELD_ARTIFACT_TYPE,
  BIOME_FIELD_ARTIFACT_VERSION,
  BiomeFieldArtifactCancelledError,
  encodeBiomeFieldArtifact,
} from "./biome-field-artifact.mjs";
import { compilerContentHash, validateCompilerContentHash } from "./canonical.mjs";
import { createBiomeWorldCompilerGraph, createHydrologyWorldCompilerGraph, createInitialWorldCompilerGraph } from "./graph.mjs";
import { planCompilerInvalidation } from "./planner.mjs";
import { createDerivedRevisionManifest, derivedArtifactContentHash, derivedGlobalArtifacts, parseDerivedRevisionManifest } from "./manifest.mjs";
import { encodeTerrainChunkArtifact, TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE } from "./terrain-artifact.mjs";
import {
  WORLD_OVERVIEW_ARTIFACT_MEDIA_TYPE,
  WORLD_OVERVIEW_ARTIFACT_TYPE,
  WORLD_OVERVIEW_TARGET_DIMENSION,
  WorldOverviewArtifactCancelledError,
  encodeWorldOverviewArtifact,
} from "./world-overview-artifact.mjs";
import {
  NAVIGATION_INDEX_ARTIFACT_MEDIA_TYPE,
  NAVIGATION_INDEX_ARTIFACT_TYPE,
  NavigationIndexArtifactValidationError,
  encodeNavigationIndexArtifact,
} from "./navigation-index-artifact.mjs";
import { atlasDesignRefKey } from "../design-ref.mjs";
import { carveGeneratedRiverChannels, RIVER_CHANNEL_CARVE_POLICY, RiverChannelCarveCancelledError } from "../river-channel-carve.mjs";

export const WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA = "limina.world-terrain-compiler-config/v1";
export const WORLD_INITIAL_TERRAIN_COMPILER_VERSION = "1.0.0";
export const WORLD_HYDROLOGY_TERRAIN_COMPILER_VERSION = "1.2.0";
export const WORLD_BIOME_TERRAIN_COMPILER_VERSION = "1.3.0";
export const TERRAIN_CHUNK_ARTIFACT_TYPE = "terrain-chunk/v1";
export const MAX_WORLD_TERRAIN_COMPILE_CHUNKS = 16_384;
// Sized so the chunk cap is actually reachable: 16,384 chunks x ~27 KiB terrain
// artifacts ≈ 427 MiB + globals. The former 256 MiB ceiling silently capped worlds
// at ~9.8k chunks — below the advertised chunk cap.
export const MAX_WORLD_TERRAIN_COMPILE_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MAX_WORLD_TERRAIN_COMPILE_MASTER_SAMPLES = MAX_MAP_FIELD_MASTER_RES * MAX_MAP_FIELD_MASTER_RES;

const RAW_HASH = /^[0-9a-f]{64}$/;
const REF_ID = /^[a-z][a-z0-9._-]{0,95}$/;
const VERSION = /^[0-9][A-Za-z0-9._+-]{0,63}$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BRANCH_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;

export class WorldTerrainCompileCancelledError extends Error {
  readonly code = "world_terrain_compile_cancelled";
  constructor() {
    super("world terrain compile cancelled");
    this.name = "WorldTerrainCompileCancelledError";
  }
}

type RecordValue = Record<string, any>;
type HydrologyArtifactEncoder = (
  topology: ReturnType<typeof createHydrologyTopology>,
  placement: { originX: number; originZ: number },
  control: { shouldCancel: () => boolean },
) => Uint8Array;
type HydrologyWaterExtractor = (input: Record<string, unknown>, control: { shouldCancel: () => boolean }) => any;
type HydrologyWaterEncoder = (
  topology: any,
  bindings: Record<string, string>,
  control: { shouldCancel: () => boolean },
) => Uint8Array;

const encodeHydrologyArtifact = encodeHydrologyFieldArtifact as unknown as HydrologyArtifactEncoder;
const extractHydrologyWater = extractHydrologyWaterTopology as unknown as HydrologyWaterExtractor;
const encodeHydrologyWater = encodeHydrologyWaterArtifact as unknown as HydrologyWaterEncoder;

function exactRecord(value: unknown, keys: readonly string[], label: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error(`${label} must not contain symbol fields`);
  const names = Object.getOwnPropertyNames(value);
  const actual = [...names].sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined || descriptor?.enumerable !== true) {
      throw new Error(`${label}.${name} must be an enumerable data field`);
    }
  }
  return value as RecordValue;
}

function recordWithOptional(value: unknown, required: readonly string[], optional: readonly string[], label: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error(`${label} must not contain symbol fields`);
  const requiredSet = new Set(required), allowed = new Set([...required, ...optional]);
  const names = Object.getOwnPropertyNames(value);
  const missing = required.filter((name) => !names.includes(name));
  const extras = names.filter((name) => !allowed.has(name));
  if (missing.length !== 0 || extras.length !== 0) {
    throw new Error(`${label} must contain exactly its required fields and supported optional fields (missing: ${missing.join(", ") || "none"}; extra: ${extras.join(", ") || "none"})`);
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined || descriptor?.enumerable !== true) {
      throw new Error(`${label}.${name} must be an enumerable data field`);
    }
  }
  for (const name of requiredSet) if (!Object.hasOwn(value, name)) throw new Error(`${label} is missing ${name}`);
  return value as RecordValue;
}

function denseArray(value: unknown, maximum: number, label: string): any[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    throw new Error(`${label} must be a standard array with at most ${maximum} entries`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    throw new Error(`${label} must not be sparse or contain custom fields`);
  }
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined || descriptor.enumerable !== true) {
      throw new Error(`${label}[${index}] must be an enumerable data field`);
    }
  }
  return value;
}

function identifier(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) throw new Error(`${label} must be a finite canonical number`);
  return value;
}

function checkpoint(shouldCancel: () => boolean, work = 0): void {
  if ((work & 1023) === 0 && shouldCancel()) throw new WorldTerrainCompileCancelledError();
}

function parseSourceRequest(input: unknown) {
  const value = exactRecord(input, ["projectId", "branchId", "revision", "headHash"], "terrain compile source request");
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error("terrain compile revision must be a non-negative safe integer");
  return Object.freeze({
    projectId: identifier(value.projectId, PROJECT_ID, "terrain compile projectId"),
    branchId: identifier(value.branchId, BRANCH_ID, "terrain compile branchId"),
    revision: value.revision as number,
    headHash: validateCompilerContentHash(value.headHash, "terrain compile headHash"),
  });
}

function parseContentRef(input: unknown, label: string, expectedType: string, expectedScope: "global" | "chunk") {
  const value = exactRecord(input, ["refId", "refType", "scope", "assetId", "contentHash"], label);
  if (value.refType !== expectedType) throw new Error(`${label} refType must be '${expectedType}'`);
  if (value.scope !== expectedScope) throw new Error(`${label} scope must be '${expectedScope}'`);
  if (typeof value.assetId !== "string" || value.assetId.length < 1 || value.assetId.startsWith("/") || value.assetId.includes("\\") || value.assetId.split("/").some((part: string) => part === "" || part === "." || part === "..")) {
    throw new Error(`${label} assetId is invalid`);
  }
  return Object.freeze({
    refId: identifier(value.refId, REF_ID, `${label} refId`),
    refType: expectedType,
    scope: expectedScope,
    assetId: value.assetId as string,
    contentHash: validateCompilerContentHash(value.contentHash, `${label} contentHash`),
  });
}

function parseConfig(input: unknown) {
  const value = exactRecord(input, ["schema", "seed", "baseAmplitude", "erosionRecipe", "gridId", "verticalRange", "limits"], "terrain compiler config");
  if (value.schema !== WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA) throw new Error(`terrain compiler config schema must be '${WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA}'`);
  if (!Number.isSafeInteger(value.seed) || value.seed < -2147483648 || value.seed > 2147483647) throw new Error("terrain compiler seed must be signed 32-bit integer");
  const baseAmplitude = finite(value.baseAmplitude, "terrain compiler baseAmplitude");
  if (!(baseAmplitude > 0)) throw new Error("terrain compiler baseAmplitude must be positive");
  const vertical = exactRecord(value.verticalRange, ["minM", "maxM"], "terrain compiler verticalRange");
  const minM = finite(vertical.minM, "terrain compiler verticalRange.minM");
  const maxM = finite(vertical.maxM, "terrain compiler verticalRange.maxM");
  if (!(maxM > minM)) throw new Error("terrain compiler verticalRange must have minM < maxM");
  const limits = exactRecord(value.limits, ["maxChunks", "maxMasterSamples", "maxArtifactBytes"], "terrain compiler limits");
  for (const key of ["maxChunks", "maxMasterSamples", "maxArtifactBytes"] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw new Error(`terrain compiler limits.${key} must be a positive safe integer`);
  }
  if (limits.maxChunks > MAX_WORLD_TERRAIN_COMPILE_CHUNKS) throw new Error(`terrain compiler maxChunks exceeds ${MAX_WORLD_TERRAIN_COMPILE_CHUNKS}`);
  if (limits.maxMasterSamples > MAX_WORLD_TERRAIN_COMPILE_MASTER_SAMPLES) throw new Error(`terrain compiler maxMasterSamples exceeds ${MAX_WORLD_TERRAIN_COMPILE_MASTER_SAMPLES}`);
  if (limits.maxArtifactBytes > MAX_WORLD_TERRAIN_COMPILE_ARTIFACT_BYTES) throw new Error(`terrain compiler maxArtifactBytes exceeds ${MAX_WORLD_TERRAIN_COMPILE_ARTIFACT_BYTES}`);
  if (typeof value.gridId !== "string") throw new Error("terrain compiler gridId must be a string");
  return Object.freeze({
    schema: WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA,
    seed: value.seed as number,
    baseAmplitude,
    erosionRecipe: validateErosionRecipe(value.erosionRecipe),
    gridId: value.gridId,
    verticalRange: Object.freeze({ minM, maxM }),
    limits: Object.freeze({ maxChunks: limits.maxChunks, maxMasterSamples: limits.maxMasterSamples, maxArtifactBytes: limits.maxArtifactBytes }),
  });
}

function normalizeEditedTile(base: any, heightsM: Float32Array, verticalRange: { minM: number; maxM: number }, shouldCancel: () => boolean) {
  const span = verticalRange.maxM - verticalRange.minM;
  const heights = new Float32Array(heightsM.length);
  for (let index = 0; index < heights.length; index++) {
    checkpoint(shouldCancel, index);
    const height = heightsM[index];
    if (height < verticalRange.minM || height > verticalRange.maxM) {
      throw new Error(`terrain compile height ${height}m is outside configured vertical range [${verticalRange.minM}, ${verticalRange.maxM}]`);
    }
    heights[index] = Math.fround((height - verticalRange.minM) / span);
  }
  return {
    nrows: base.topology.samples.rows,
    ncols: base.topology.samples.cols,
    origin: [base.topology.bounds.minX + 24, verticalRange.minM, base.topology.bounds.minZ + 24],
    scale: [48, span, 48],
    heights,
    paintMat: base.paintMat,
    paintW: base.paintW,
    climate: base.climate,
    climateChannels: 3,
    blight: base.blight,
  };
}

function createWorldOverviewGrid(field: any, shouldCancel: () => boolean) {
  const rows = WORLD_OVERVIEW_TARGET_DIMENSION, cols = WORLD_OVERVIEW_TARGET_DIMENSION;
  const cells = rows * cols;
  const heights = new Float32Array(cells);
  const paintMaterial = new Uint8Array(cells);
  const paintWeight = new Uint8Array(cells);
  const sourceMax = field.masterRes - 1;
  let work = 0;
  for (let row = 0; row < rows; row++) {
    const sourceZ = row * sourceMax / (rows - 1);
    const z0 = Math.floor(sourceZ), z1 = Math.min(sourceMax, z0 + 1), tz = sourceZ - z0;
    for (let col = 0; col < cols; col++) {
      checkpoint(shouldCancel, work++);
      const sourceX = col * sourceMax / (cols - 1);
      const x0 = Math.floor(sourceX), x1 = Math.min(sourceMax, x0 + 1), tx = sourceX - x0;
      const top = field.heightsM[z0 * field.masterRes + x0]
        + (field.heightsM[z0 * field.masterRes + x1] - field.heightsM[z0 * field.masterRes + x0]) * tx;
      const bottom = field.heightsM[z1 * field.masterRes + x0]
        + (field.heightsM[z1 * field.masterRes + x1] - field.heightsM[z1 * field.masterRes + x0]) * tx;
      const target = row * cols + col;
      heights[target] = Math.fround(top + (bottom - top) * tz);
      const nearestX = Math.round(sourceX), nearestZ = Math.round(sourceZ);
      const nearest = nearestZ * field.masterRes + nearestX;
      paintMaterial[target] = field.paintMat[nearest];
      paintWeight[target] = Math.round(Math.max(0, Math.min(1, field.paintW[nearest])) * 255);
    }
  }
  checkpoint(shouldCancel);
  return {
    rows,
    cols,
    origin: [field.bounds.minX, field.bounds.minZ],
    stepM: (field.bounds.maxX - field.bounds.minX) / (cols - 1),
    heights,
    paintMaterial,
    paintWeight,
  };
}

function parseAvailableArtifactHashes(input: unknown, previousManifest: any) {
  const globalArtifacts = derivedGlobalArtifacts(previousManifest);
  const values = denseArray(input, MAX_WORLD_TERRAIN_COMPILE_CHUNKS + globalArtifacts.length, "available terrain artifact hashes");
  const referenced = new Set<string>();
  for (const chunk of previousManifest.chunks) for (const artifact of chunk.artifacts) referenced.add(artifact.contentHash);
  for (const artifact of globalArtifacts) referenced.add(artifact.contentHash);
  let prior = "";
  const parsed = values.map((value, index) => {
    const hash = validateCompilerContentHash(value, `available terrain artifact hash ${index}`);
    if (index > 0 && hash <= prior) throw new Error("available terrain artifact hashes must be strictly ordered and unique");
    if (!referenced.has(hash)) throw new Error(`available terrain artifact hash '${hash}' is not referenced by the previous manifest`);
    prior = hash;
    return hash;
  });
  return new Set(parsed);
}

function terrainWorldMapSourceHash(map: WorldMap): string {
  const terrainInputs = { ...map } as Record<string, unknown>;
  delete terrainInputs.hydrology;
  delete terrainInputs.provenance;
  delete terrainInputs.designIndex;
  delete terrainInputs.gazetteer;
  terrainInputs.anchors = map.anchors.map((anchor) => ({ position: anchor.position }));
  return compilerContentHash({ schema: "limina.world-terrain-source/v1", worldMap: terrainInputs });
}

const NAVIGATION_KIND = /^[a-z][a-z0-9._-]{0,63}$/;
const NAVIGATION_SOURCE_HASH_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 12,
  maxNodes: 2_000_000,
  maxProperties: 32,
  maxArrayLength: 100_000,
});

function canonicalNavigationSearchTerm(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
}

function createNavigationIndexSource(map: WorldMap, worldBounds: any, shouldCancel: () => boolean) {
  const anchorsByRef = new Map<string, any[]>();
  const gazetteerByRef = new Map<string, any[]>();
  let work = 0;
  for (const anchor of map.anchors) {
    checkpoint(shouldCancel, work++);
    if (anchor.designRef === undefined) continue;
    const key = atlasDesignRefKey(anchor.designRef);
    const matches = anchorsByRef.get(key);
    if (matches === undefined) anchorsByRef.set(key, [anchor]);
    else matches.push(anchor);
  }
  for (const place of map.gazetteer ?? []) {
    checkpoint(shouldCancel, work++);
    if (place.designRef === undefined) continue;
    const key = atlasDesignRefKey(place.designRef);
    const matches = gazetteerByRef.get(key);
    if (matches === undefined) gazetteerByRef.set(key, [place]);
    else matches.push(place);
  }

  const entries = (map.designIndex ?? []).map((indexed, index) => {
    checkpoint(shouldCancel, work++);
    const refKey = atlasDesignRefKey(indexed.designRef);
    const anchors = anchorsByRef.get(refKey) ?? [];
    const places = gazetteerByRef.get(refKey) ?? [];
    const label = places[0]?.name ?? anchors[0]?.name ?? anchors[0]?.id ?? indexed.designRef.id;
    const sourceKind = places[0]?.kind ?? anchors[0]?.kind ?? indexed.designRef.kind;
    const kind = NAVIGATION_KIND.test(sourceKind) ? sourceKind : indexed.designRef.kind;
    const searchTerms = new Map<string, string>();
    const addSearchTerm = (value: unknown) => {
      if (typeof value !== "string") return;
      const canonical = canonicalNavigationSearchTerm(value);
      if (canonical.length > 0 && !searchTerms.has(canonical)) searchTerms.set(canonical, canonical);
    };
    addSearchTerm(indexed.designRef.id);
    addSearchTerm(indexed.designRef.kind);
    addSearchTerm(label);
    for (const anchor of anchors) {
      addSearchTerm(anchor.id);
      addSearchTerm(anchor.name);
      addSearchTerm(anchor.kind);
    }
    for (const place of places) {
      addSearchTerm(place.placeId);
      addSearchTerm(place.name);
      addSearchTerm(place.kind);
    }
    const searchKeys = [...searchTerms.values()].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    if (searchKeys.length > 16) {
      throw new Error(`navigation subject '${refKey}' exceeds 16 canonical search terms`);
    }
    return {
      designRef: indexed.designRef,
      position: indexed.position,
      ...(indexed.radiusM === undefined ? {} : { radiusM: indexed.radiusM }),
      label,
      kind,
      searchKeys,
    };
  });
  entries.sort((left, right) => {
    const leftKey = atlasDesignRefKey(left.designRef), rightKey = atlasDesignRefKey(right.designRef);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  checkpoint(shouldCancel, work);
  return { worldBounds, entries };
}

function sourceSlicesEqual(left: any[], right: any[]): boolean {
  return left.length === right.length && left.every((slice, index) => (
    slice.refId === right[index].refId && slice.contentHash === right[index].contentHash
  ));
}

/** Pure compiler boundary: no filesystem, network, clock, or random inputs. */
export function compileWorldTerrain(input: unknown) {
  const root = recordWithOptional(
    input,
    ["request", "worldMap", "sourceRefs", "terrainEditLayers", "terrainEditLayerRefs", "compiler", "previousSnapshot", "cancellation"],
    ["previousManifest", "availableArtifactHashes"],
    "world terrain compile input",
  );
  const request = parseSourceRequest(root.request);
  const cancellation = exactRecord(root.cancellation, ["shouldCancel"], "terrain compile cancellation");
  if (typeof cancellation.shouldCancel !== "function") throw new Error("terrain compile cancellation.shouldCancel must be a function");
  const shouldCancel = cancellation.shouldCancel as () => boolean;
  checkpoint(shouldCancel);

  const compilerInput = exactRecord(root.compiler, ["version", "config"], "terrain compiler identity");
  const compilerVersion = identifier(compilerInput.version, VERSION, "terrain compiler version");
  if (compilerVersion !== WORLD_INITIAL_TERRAIN_COMPILER_VERSION
      && compilerVersion !== WORLD_HYDROLOGY_TERRAIN_COMPILER_VERSION
      && compilerVersion !== WORLD_BIOME_TERRAIN_COMPILER_VERSION) {
    throw new Error(`terrain compiler version '${compilerVersion}' is unsupported`);
  }
  const config = parseConfig(compilerInput.config);
  const map = WorldMapSchema.parse(migrateWorldMap(root.worldMap)) as WorldMap;
  const verification = verifyWorldMap(map);
  if (!verification.ok) throw new Error(`WorldMap content hash mismatch: expected '${verification.expected}', actual '${verification.actual}'`);
  const biomeProfile = compilerVersion === WORLD_BIOME_TERRAIN_COMPILER_VERSION;
  const hydrologyProfile = compilerVersion === WORLD_HYDROLOGY_TERRAIN_COMPILER_VERSION || biomeProfile;
  if (hydrologyProfile !== (map.hydrology !== undefined)) {
    throw new Error(hydrologyProfile
      ? "hydrology terrain compiler profile requires a WorldMap hydrology recipe"
      : `WorldMap hydrology recipe requires compiler version '${WORLD_HYDROLOGY_TERRAIN_COMPILER_VERSION}' or '${WORLD_BIOME_TERRAIN_COMPILER_VERSION}'`);
  }
  const refsInput = recordWithOptional(root.sourceRefs, ["mapDocument"], ["designSource", "worldMap"], "terrain compile sourceRefs");
  const mapDocumentRef = parseContentRef(refsInput.mapDocument, "terrain compile MapDoc ref", "map-document/v1", "global");
  const hasDesignSourceRef = Object.hasOwn(refsInput, "designSource");
  const hasWorldMapRef = Object.hasOwn(refsInput, "worldMap");
  if (hasDesignSourceRef !== hasWorldMapRef) {
    throw new Error("terrain compile legacy sourceRefs must contain mapDocument, designSource, and worldMap together");
  }
  const legacyRefs = hasDesignSourceRef;
  const designSourceRef = legacyRefs ? parseContentRef(refsInput.designSource, "terrain compile design source ref", "design-source/v1", "global") : undefined;
  const worldMapRef = legacyRefs ? parseContentRef(refsInput.worldMap, "terrain compile WorldMap ref", "world-map/v1", "global") : undefined;
  const expectedWorldMapHash = `sha256:${verification.actual}`;
  if (worldMapRef !== undefined && worldMapRef.contentHash !== expectedWorldMapHash) throw new Error("terrain compile WorldMap ref is not bound to the verified WorldMap content hash");
  if (typeof map.provenance.sourceHash !== "string" || !RAW_HASH.test(map.provenance.sourceHash)) throw new Error("terrain compile WorldMap provenance must bind a lowercase source hash");
  if (designSourceRef === undefined) {
    if (mapDocumentRef.contentHash !== `sha256:${map.provenance.sourceHash}`) throw new Error("terrain compile MapDoc ref is not bound to Atlas WorldMap provenance.sourceHash");
  } else if (designSourceRef.contentHash !== `sha256:${map.provenance.sourceHash}`) {
    throw new Error("terrain compile design source ref is not bound to WorldMap provenance.sourceHash");
  }

  const layerInputs = denseArray(root.terrainEditLayers, 64, "terrain edit layers");
  const layerRefInputs = denseArray(root.terrainEditLayerRefs, 64, "terrain edit layer refs");
  if (layerInputs.length !== layerRefInputs.length) throw new Error("terrain edit layers and refs must have identical lengths");
  const layers = layerInputs.map((layer) => parseTerrainEditLayer(layer));
  const layerRefs = layerRefInputs.map((ref, index) => {
    const parsed = parseContentRef(ref, `terrain edit layer ref ${index}`, "terrain-edit-layer/v1", "chunk");
    if (parsed.contentHash !== layers[index].contentHash) throw new Error(`terrain edit layer ref ${index} is not bound to its parsed layer content hash`);
    return parsed;
  });
  const allRefIds = [mapDocumentRef.refId, ...(designSourceRef === undefined ? [] : [designSourceRef.refId, worldMapRef!.refId]), ...layerRefs.map((ref) => ref.refId)];
  if (new Set(allRefIds).size !== allRefIds.length) throw new Error("terrain compile source refs must have unique refId values");

  let field;
  try {
    field = createMapTerrainField({
      worldMap: map,
      seed: config.seed,
      baseAmplitude: config.baseAmplitude,
      erosionRecipe: config.erosionRecipe,
      gridId: config.gridId,
      shouldCancel,
    });
  } catch (error) {
    if (error instanceof MapFieldCancelledError || (error instanceof Error && error.name === "ErosionCancelledError")) throw new WorldTerrainCompileCancelledError();
    throw error;
  }
  const masterSamples = field.masterRes * field.masterRes;
  if (masterSamples > config.limits.maxMasterSamples) throw new Error(`terrain compile master field has ${masterSamples} samples, exceeding cap ${config.limits.maxMasterSamples}`);
  const hydrologyPlacement = hydrologyProfile
    ? Object.freeze({ originX: field.bounds.minX, originZ: field.bounds.minZ })
    : undefined;
  let compiledHydrologyTopology: ReturnType<typeof createHydrologyTopology> | undefined;
  const hydrologyTopology = () => {
    if (!hydrologyProfile || hydrologyPlacement === undefined) throw new Error("hydrology topology requested outside a hydrology compiler profile");
    if (compiledHydrologyTopology === undefined) {
      try {
        compiledHydrologyTopology = createHydrologyTopology({
          rows: field.masterRes,
          cols: field.masterRes,
          heightsM: field.heightsM,
          cellSizeM: field.masterStep,
          seaLevelM: field.seaLevelM,
          precipitationMmPerYear: map.hydrology!.precipitationMmPerYear,
          shouldCancel,
        });
      } catch (error) {
        if (error instanceof HydrologyTopologyCancelledError) throw new WorldTerrainCompileCancelledError();
        throw error;
      }
    }
    return compiledHydrologyTopology;
  };
  let compiledHydrologyWaterTopology: any | undefined;
  const hydrologyWaterTopology = () => {
    if (!hydrologyProfile || hydrologyPlacement === undefined) throw new Error("hydrology water requested outside a hydrology compiler profile");
    if (compiledHydrologyWaterTopology === undefined) {
      try {
        compiledHydrologyWaterTopology = extractHydrologyWater({
          heightsM: field.heightsM,
          topology: hydrologyTopology(),
          placement: hydrologyPlacement,
          recipe: map.hydrology!,
        }, { shouldCancel });
      } catch (error) {
        if (error instanceof HydrologyWaterTopologyCancelledError) throw new WorldTerrainCompileCancelledError();
        throw error;
      }
    }
    return compiledHydrologyWaterTopology;
  };
  let terrainField = field;
  let riverChannelDiagnostics: Readonly<Record<string, number>> | undefined;
  if (hydrologyProfile) {
    let carved;
    const channelBase = field.channelTerrainHeightsM ?? field.heightsM;
    try {
      carved = carveGeneratedRiverChannels({
        rows: field.masterRes,
        cols: field.masterRes,
        heightsM: channelBase,
        cellSizeM: field.masterStep,
        originX: field.bounds.minX,
        originZ: field.bounds.minZ,
        reaches: hydrologyWaterTopology().reaches,
      }, { shouldCancel, minimumHeightM: config.verticalRange.minM });
    } catch (error) {
      if (error instanceof RiverChannelCarveCancelledError) throw new WorldTerrainCompileCancelledError();
      throw error;
    }
    terrainField = Object.freeze({ ...field, heightsM: new Float32Array(carved.heightsM),
      paintMat: field.channelTerrainPaintMat ?? field.paintMat,
      paintW: field.channelTerrainPaintW ?? field.paintW });
    riverChannelDiagnostics = carved.diagnostics;
  }
  // TERRITORY-RECT DOMAIN (plans/territory-rect-compile-domain.md): compile the chunks
  // covering the AUTHORED extent (featureBounds + the map-field margin), not the
  // origin-centered master square — a 6.9x4.6 km world costs its ~15k-chunk rect, not
  // the 23.7k bounding square that blew the cap. Clamped to the master square so every
  // chunk slices real raster data; master framing (raster, erosion, hydrology origin,
  // overview grid, topology hash) is unchanged. Beyond the rect is unauthored deep sea,
  // still rendered by the square overview.
  const territory = Object.freeze({
    minX: Math.max(field.bounds.minX, field.featureBounds.minX - MAP_FIELD_MARGIN_M),
    minZ: Math.max(field.bounds.minZ, field.featureBounds.minZ - MAP_FIELD_MARGIN_M),
    maxX: Math.min(field.bounds.maxX, field.featureBounds.maxX + MAP_FIELD_MARGIN_M),
    maxZ: Math.min(field.bounds.maxZ, field.featureBounds.maxZ + MAP_FIELD_MARGIN_M),
  });
  const domain = terrainChunkRangeForBounds(field.grid, territory);
  const width = domain.maxTx - domain.minTx + 1, height = domain.maxTz - domain.minTz + 1;
  const chunkCount = width * height;
  if (!Number.isSafeInteger(chunkCount) || chunkCount > config.limits.maxChunks) throw new Error(`terrain compile domain has ${chunkCount} chunks, exceeding cap ${config.limits.maxChunks}`);
  const baseTopology = createTerrainEditBaseTopology({ grid: field.grid, domain });
  for (const layer of layers) if (layer.baseTopology.topologyHash !== baseTopology.topologyHash) throw new Error(`terrain edit layer '${layer.layerId}' base topology does not match compiler domain`);
  let prepared;
  try { prepared = prepareTerrainEditLayers({ baseTopology, layers }, { shouldCancel }); }
  catch (error) { if (error instanceof TerrainEditCancelledError) throw new WorldTerrainCompileCancelledError(); throw error; }

  // Pass 1 computes dependency identity only. No chunk artifact is materialized before the
  // compiler-owned invalidation plan decides whether a verified prior artifact is reusable.
  const compiledChunks: any[] = [];
  let editSliceDeltaVisits = 0, work = 0;
  for (let tz = domain.minTz; tz <= domain.maxTz; tz++) {
    for (let tx = domain.minTx; tx <= domain.maxTx; tx++) {
      checkpoint(shouldCancel, work++);
      const topology = terrainChunkTopology(field.grid, { lod: 0, tx, tz, samples: 33 });
      let chunkSlices;
      try { chunkSlices = preparedTerrainEditLayerChunkSlices({ baseTopology, chunkTopology: topology, preparedLayers: prepared }, { shouldCancel }); }
      catch (error) { if (error instanceof TerrainEditCancelledError) throw new WorldTerrainCompileCancelledError(); throw error; }
      editSliceDeltaVisits += chunkSlices.inspectedDeltaCount;
      const orderedSlices = layerRefs.map((ref, index) => ({
        order: index,
        refId: ref.refId,
        contentHash: compilerContentHash({
          schema: "limina.terrain-edit-layer-slice/v1",
          chunkId: topology.chunkId,
          operations: chunkSlices.slices[index].operations,
        }),
      }));
      const sourceSlices = orderedSlices.map(({ order: _order, ...slice }) => slice).sort((a, b) => a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0);
      const editSliceHash = compilerContentHash({ schema: "limina.terrain-edit-stack-slice/v1", slices: orderedSlices });
      compiledChunks.push({
        chunkId: topology.chunkId,
        gridId: topology.gridId,
        lod: 0,
        tx,
        tz,
        chunkTopologyHash: topology.topologyHash,
        sourceSliceHashes: { "edit-layers.slice": editSliceHash },
        manifestSourceSlices: sourceSlices,
      });
    }
  }
  compiledChunks.sort((a, b) => a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0);
  const navigationSource = createNavigationIndexSource(map, field.bounds, shouldCancel);
  const navigationSourceHash = compilerContentHash(
    { schema: "limina.navigation-index-source/v1", ...navigationSource },
    NAVIGATION_SOURCE_HASH_LIMITS,
  );
  const terrainSourceHash = terrainWorldMapSourceHash(map);
  const graph = biomeProfile ? createBiomeWorldCompilerGraph()
    : hydrologyProfile ? createHydrologyWorldCompilerGraph() : createInitialWorldCompilerGraph();
  const plannerInput = {
    graph,
    chunks: compiledChunks.map(({ manifestSourceSlices: _manifestSourceSlices, artifact: _artifact, ...chunk }) => chunk),
    configs: {
      worldmap: { schema: "limina.worldmap-stage-config/v1" },
      "base-height": { seed: config.seed, baseAmplitude: config.baseAmplitude, masterTopologyHash: field.masterTopologyHash },
      erosion: config.erosionRecipe,
      "edit-layers": { composition: "ordered-additive-metres/v1" },
      collision: { source: TERRAIN_CHUNK_ARTIFACT_TYPE },
      render: { source: TERRAIN_CHUNK_ARTIFACT_TYPE, verticalRange: config.verticalRange },
      "navigation-index": {
        schema: "limina.navigation-index-stage-config/v1",
        artifactType: NAVIGATION_INDEX_ARTIFACT_TYPE,
      },
      ...(hydrologyProfile ? {
        "hydrology-field": {
          schema: "limina.hydrology-field-stage-config/v1",
          topologyVersion: HYDROLOGY_TOPOLOGY_VERSION,
          artifactVersion: HYDROLOGY_FIELD_ARTIFACT_VERSION,
        },
        "hydrology-water-topology": {
          schema: "limina.hydrology-water-topology-stage-config/v1",
          extractionVersion: HYDROLOGY_COMBINED_WATER_TOPOLOGY_VERSION,
          artifactVersion: HYDROLOGY_WATER_ARTIFACT_VERSION,
        },
        "river-channel-carve": RIVER_CHANNEL_CARVE_POLICY,
        ...(biomeProfile ? {
          "biome-field": {
            schema: "limina.biome-field-stage-config/v1",
            compilerVersion: WORLD_BIOME_FIELD_COMPILER_VERSION,
            artifactVersion: BIOME_FIELD_ARTIFACT_VERSION,
            pack: { id: BIOME_LIBRARY_V1.id, version: BIOME_LIBRARY_V1.version, contentHash: biomePackContentHash(BIOME_LIBRARY_V1) },
            topN: WORLD_BIOME_FIELD_TOP_N,
            precipitationCeilingMmPerYear: WORLD_BIOME_PRECIPITATION_CEILING_MM_PER_YEAR,
            climateFeather: WORLD_BIOME_CLIMATE_FEATHER,
            policy: WORLD_BIOME_FIELD_POLICY,
          },
        } : {}),
      } : {}),
    },
    globalSourceHashes: hydrologyProfile ? {
      "worldmap.global": terrainSourceHash,
      "navigation.index": navigationSourceHash,
      "hydrology.precipitation": compilerContentHash({
        schema: "limina.hydrology-precipitation-source/v1",
        precipitationMmPerYear: map.hydrology!.precipitationMmPerYear,
      }),
      "hydrology.thresholds": compilerContentHash({
        schema: "limina.hydrology-threshold-source/v1",
        riverMinCatchmentAreaM2: map.hydrology!.riverMinCatchmentAreaM2,
        basinMinAreaM2: map.hydrology!.basinMinAreaM2,
        basinMinDepthM: map.hydrology!.basinMinDepthM,
        waterfallMinDropM: map.hydrology!.waterfallMinDropM,
      }),
    } : { "worldmap.global": terrainSourceHash, "navigation.index": navigationSourceHash },
  };
  const previous = root.previousSnapshot === null ? undefined : root.previousSnapshot;
  const { snapshot, invalidation } = planCompilerInvalidation({ ...plannerInput, previous });

  const hasPreviousManifest = Object.hasOwn(root, "previousManifest");
  const hasAvailability = Object.hasOwn(root, "availableArtifactHashes");
  let previousManifest: any | undefined;
  let availableArtifactHashes = new Set<string>();
  if (hasPreviousManifest && root.previousManifest !== null) {
    if (!hasAvailability) throw new Error("terrain artifact reuse requires availableArtifactHashes with previousManifest");
    if (previous === undefined) throw new Error("terrain artifact reuse requires a non-null previousSnapshot");
    previousManifest = parseDerivedRevisionManifest(root.previousManifest);
    if (previousManifest.projectId !== request.projectId || previousManifest.branchId !== request.branchId) {
      throw new Error("previous terrain manifest belongs to another project or branch");
    }
    if (previousManifest.compiler.snapshotHash !== previous.snapshotHash) throw new Error("previous terrain manifest and snapshot hashes do not agree");
    if (previousManifest.compiler.graphHash !== previous.graphHash) throw new Error("previous terrain manifest and snapshot graph hashes do not agree");
    availableArtifactHashes = parseAvailableArtifactHashes(root.availableArtifactHashes, previousManifest);
  } else {
    if (hasAvailability) {
      const coldAvailability = denseArray(root.availableArtifactHashes,
        MAX_WORLD_TERRAIN_COMPILE_CHUNKS + 2 + (hydrologyProfile ? 2 : 0) + (biomeProfile ? 1 : 0),
        "available terrain artifact hashes");
      if (coldAvailability.length !== 0) throw new Error("availableArtifactHashes must be empty without a previousManifest");
    }
    if (hasPreviousManifest && root.previousManifest !== null) throw new Error("previousManifest is invalid");
  }

  const previousChunks = new Map<string, any>(previousManifest?.chunks.map((chunk: any) => [chunk.chunkId, chunk]) ?? []);
  const previousStageKeys = previous as any;
  const nextStageKeys = (snapshot as any).stageKeys;
  const cacheCompilerMatches = previousManifest?.compiler.version === compilerVersion
    && previousManifest?.compiler.graphHash === graph.graphHash;
  const artifacts: any[] = [];
  const reusedArtifacts: any[] = [];
  let artifactBytes = 0, emittedArtifactBytes = 0, reusedArtifactBytes = 0;
  work = 0;
  for (const chunk of compiledChunks) {
    checkpoint(shouldCancel, work++);
    const priorChunk = previousChunks.get(chunk.chunkId);
    const priorArtifact = priorChunk?.artifacts.find((artifact: any) => artifact.artifactType === TERRAIN_CHUNK_ARTIFACT_TYPE);
    const terminalKeysMatch = cacheCompilerMatches
      && previousStageKeys?.stageKeys?.render?.[chunk.chunkId] === nextStageKeys.render[chunk.chunkId]
      && previousStageKeys?.stageKeys?.collision?.[chunk.chunkId] === nextStageKeys.collision[chunk.chunkId];
    const reusable = terminalKeysMatch
      && priorChunk?.gridId === chunk.gridId
      && priorChunk?.lod === chunk.lod
      && priorChunk?.tx === chunk.tx
      && priorChunk?.tz === chunk.tz
      && priorChunk?.topologyHash === chunk.chunkTopologyHash
      && sourceSlicesEqual(priorChunk.sourceSliceHashes, chunk.manifestSourceSlices)
      && priorArtifact?.mediaType === TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE
      && availableArtifactHashes.has(priorArtifact?.contentHash);

    if (reusable) {
      chunk.artifact = priorArtifact;
      artifactBytes += priorArtifact.byteLength;
      reusedArtifactBytes += priorArtifact.byteLength;
      reusedArtifacts.push(Object.freeze({
        scope: "chunk",
        chunkId: chunk.chunkId,
        artifactType: priorArtifact.artifactType,
        mediaType: priorArtifact.mediaType,
        contentHash: priorArtifact.contentHash,
        byteLength: priorArtifact.byteLength,
      }));
    } else {
      const base = sliceMapFieldChunk(terrainField, chunk.tx, chunk.tz, { shouldCancel });
      const topology = terrainChunkTopology(terrainField.grid, { lod: chunk.lod, tx: chunk.tx, tz: chunk.tz, samples: 33 });
      let composed;
      try { composed = composePreparedTerrainEditLayers({ baseTopology, chunkTopology: topology, baseHeightsM: base.heightsM, preparedLayers: prepared }, { shouldCancel }); }
      catch (error) { if (error instanceof TerrainEditCancelledError) throw new WorldTerrainCompileCancelledError(); throw error; }
      const tile = normalizeEditedTile(base, composed.heightsM, config.verticalRange, shouldCancel);
      const bytes = encodeTerrainChunkArtifact(tile);
      const contentHash = derivedArtifactContentHash(bytes);
      const descriptor = Object.freeze({
        artifactType: TERRAIN_CHUNK_ARTIFACT_TYPE,
        contentHash,
        byteLength: bytes.byteLength,
        mediaType: TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE,
      });
      chunk.artifact = descriptor;
      artifactBytes += bytes.byteLength;
      emittedArtifactBytes += bytes.byteLength;
      artifacts.push(Object.freeze({
        scope: "chunk",
        chunkId: chunk.chunkId,
        artifactType: TERRAIN_CHUNK_ARTIFACT_TYPE,
        mediaType: TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE,
        contentHash,
        bytes,
      }));
    }
    if (artifactBytes > config.limits.maxArtifactBytes) throw new Error(`terrain compile artifact bytes exceed cap ${config.limits.maxArtifactBytes}`);
  }

  let overviewArtifact: any;
  const priorOverviewArtifact = previousManifest === undefined ? undefined : derivedGlobalArtifacts(previousManifest)
    .find((artifact: any) => artifact.artifactType === WORLD_OVERVIEW_ARTIFACT_TYPE);
  const overviewAuthorityStage = hydrologyProfile ? "river-channel-carve" : "erosion";
  const reusableOverview = cacheCompilerMatches
    && previousStageKeys?.stageKeys?.[overviewAuthorityStage]?.["@global"] === nextStageKeys[overviewAuthorityStage]["@global"]
    && priorOverviewArtifact?.mediaType === WORLD_OVERVIEW_ARTIFACT_MEDIA_TYPE
    && availableArtifactHashes.has(priorOverviewArtifact?.contentHash);
  if (reusableOverview) {
    overviewArtifact = priorOverviewArtifact;
    artifactBytes += priorOverviewArtifact.byteLength;
    reusedArtifactBytes += priorOverviewArtifact.byteLength;
    reusedArtifacts.push(Object.freeze({
      scope: "global",
      artifactType: priorOverviewArtifact.artifactType,
      mediaType: priorOverviewArtifact.mediaType,
      contentHash: priorOverviewArtifact.contentHash,
      byteLength: priorOverviewArtifact.byteLength,
    }));
  } else {
    try {
      const bytes = encodeWorldOverviewArtifact(createWorldOverviewGrid(terrainField, shouldCancel), { shouldCancel });
      const contentHash = derivedArtifactContentHash(bytes);
      overviewArtifact = Object.freeze({
        artifactType: WORLD_OVERVIEW_ARTIFACT_TYPE,
        contentHash,
        byteLength: bytes.byteLength,
        mediaType: WORLD_OVERVIEW_ARTIFACT_MEDIA_TYPE,
      });
      artifactBytes += bytes.byteLength;
      emittedArtifactBytes += bytes.byteLength;
      artifacts.push(Object.freeze({
        scope: "global",
        artifactType: WORLD_OVERVIEW_ARTIFACT_TYPE,
        mediaType: WORLD_OVERVIEW_ARTIFACT_MEDIA_TYPE,
        contentHash,
        bytes,
      }));
    } catch (error) {
      if (error instanceof WorldOverviewArtifactCancelledError) throw new WorldTerrainCompileCancelledError();
      throw error;
    }
  }
  if (artifactBytes > config.limits.maxArtifactBytes) throw new Error(`terrain compile artifact bytes exceed cap ${config.limits.maxArtifactBytes}`);

  let navigationArtifact: any;
  const priorNavigationArtifact = previousManifest === undefined ? undefined : derivedGlobalArtifacts(previousManifest)
    .find((artifact: any) => artifact.artifactType === NAVIGATION_INDEX_ARTIFACT_TYPE);
  const reusableNavigation = cacheCompilerMatches
    && previousStageKeys?.stageKeys?.["navigation-index"]?.["@global"] === nextStageKeys["navigation-index"]["@global"]
    && priorNavigationArtifact?.mediaType === NAVIGATION_INDEX_ARTIFACT_MEDIA_TYPE
    && availableArtifactHashes.has(priorNavigationArtifact?.contentHash);
  if (reusableNavigation) {
    navigationArtifact = priorNavigationArtifact;
    artifactBytes += priorNavigationArtifact.byteLength;
    reusedArtifactBytes += priorNavigationArtifact.byteLength;
    reusedArtifacts.push(Object.freeze({
      scope: "global",
      artifactType: priorNavigationArtifact.artifactType,
      mediaType: priorNavigationArtifact.mediaType,
      contentHash: priorNavigationArtifact.contentHash,
      byteLength: priorNavigationArtifact.byteLength,
    }));
  } else {
    try {
      const bytes = encodeNavigationIndexArtifact(navigationSource, { shouldCancel });
      const contentHash = derivedArtifactContentHash(bytes);
      navigationArtifact = Object.freeze({
        artifactType: NAVIGATION_INDEX_ARTIFACT_TYPE,
        contentHash,
        byteLength: bytes.byteLength,
        mediaType: NAVIGATION_INDEX_ARTIFACT_MEDIA_TYPE,
      });
      artifactBytes += bytes.byteLength;
      emittedArtifactBytes += bytes.byteLength;
      artifacts.push(Object.freeze({
        scope: "global",
        artifactType: NAVIGATION_INDEX_ARTIFACT_TYPE,
        mediaType: NAVIGATION_INDEX_ARTIFACT_MEDIA_TYPE,
        contentHash,
        bytes,
      }));
    } catch (error) {
      if (error instanceof NavigationIndexArtifactValidationError
          && error.code === "navigation_index_artifact_cancelled") {
        throw new WorldTerrainCompileCancelledError();
      }
      throw error;
    }
  }
  if (artifactBytes > config.limits.maxArtifactBytes) throw new Error(`terrain compile artifact bytes exceed cap ${config.limits.maxArtifactBytes}`);

  let hydrologyArtifact: any | undefined;
  let hydrologyWaterArtifact: any | undefined;
  let biomeArtifact: any | undefined;
  if (hydrologyProfile) {
    const priorArtifact = previousManifest === undefined ? undefined : derivedGlobalArtifacts(previousManifest)
      .find((artifact: any) => artifact.artifactType === HYDROLOGY_FIELD_ARTIFACT_TYPE);
    const reusable = cacheCompilerMatches
      && previousStageKeys?.stageKeys?.["hydrology-field"]?.["@global"] === nextStageKeys["hydrology-field"]["@global"]
      && priorArtifact?.mediaType === HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE
      && availableArtifactHashes.has(priorArtifact?.contentHash);
    if (reusable) {
      hydrologyArtifact = priorArtifact;
      artifactBytes += priorArtifact.byteLength;
      reusedArtifactBytes += priorArtifact.byteLength;
      reusedArtifacts.push(Object.freeze({
        scope: "global",
        artifactType: priorArtifact.artifactType,
        mediaType: priorArtifact.mediaType,
        contentHash: priorArtifact.contentHash,
        byteLength: priorArtifact.byteLength,
      }));
    } else {
      try {
        const bytes = encodeHydrologyArtifact(hydrologyTopology(), hydrologyPlacement!, { shouldCancel });
        const contentHash = derivedArtifactContentHash(bytes);
        hydrologyArtifact = Object.freeze({
          artifactType: HYDROLOGY_FIELD_ARTIFACT_TYPE,
          contentHash,
          byteLength: bytes.byteLength,
          mediaType: HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE,
        });
        artifactBytes += bytes.byteLength;
        emittedArtifactBytes += bytes.byteLength;
        artifacts.push(Object.freeze({
          scope: "global",
          artifactType: HYDROLOGY_FIELD_ARTIFACT_TYPE,
          mediaType: HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE,
          contentHash,
          bytes,
        }));
      } catch (error) {
        if (error instanceof HydrologyArtifactCancelledError) {
          throw new WorldTerrainCompileCancelledError();
        }
        throw error;
      }
    }
    if (artifactBytes > config.limits.maxArtifactBytes) throw new Error(`terrain compile artifact bytes exceed cap ${config.limits.maxArtifactBytes}`);

    const priorWaterArtifact = previousManifest === undefined ? undefined : derivedGlobalArtifacts(previousManifest)
      .find((artifact: any) => artifact.artifactType === HYDROLOGY_WATER_ARTIFACT_TYPE);
    const reusableWater = cacheCompilerMatches
      && previousStageKeys?.stageKeys?.["hydrology-water-topology"]?.["@global"] === nextStageKeys["hydrology-water-topology"]["@global"]
      && priorWaterArtifact?.mediaType === HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE
      && availableArtifactHashes.has(priorWaterArtifact?.contentHash);
    if (reusableWater) {
      hydrologyWaterArtifact = priorWaterArtifact;
      artifactBytes += priorWaterArtifact.byteLength;
      reusedArtifactBytes += priorWaterArtifact.byteLength;
      reusedArtifacts.push(Object.freeze({
        scope: "global",
        artifactType: priorWaterArtifact.artifactType,
        mediaType: priorWaterArtifact.mediaType,
        contentHash: priorWaterArtifact.contentHash,
        byteLength: priorWaterArtifact.byteLength,
      }));
    } else {
      try {
        const bytes = encodeHydrologyWater(hydrologyWaterTopology(), {
          hydrologyFieldContentHash: hydrologyArtifact.contentHash,
          recipeHash: compilerContentHash(map.hydrology!),
          erosionStageKey: nextStageKeys.erosion["@global"],
          compilerGraphHash: graph.graphHash,
        }, { shouldCancel });
        const contentHash = derivedArtifactContentHash(bytes);
        hydrologyWaterArtifact = Object.freeze({
          artifactType: HYDROLOGY_WATER_ARTIFACT_TYPE,
          contentHash,
          byteLength: bytes.byteLength,
          mediaType: HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
        });
        artifactBytes += bytes.byteLength;
        emittedArtifactBytes += bytes.byteLength;
        artifacts.push(Object.freeze({
          scope: "global",
          artifactType: HYDROLOGY_WATER_ARTIFACT_TYPE,
          mediaType: HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
          contentHash,
          bytes,
        }));
      } catch (error) {
        if (error instanceof HydrologyWaterTopologyCancelledError || error instanceof HydrologyWaterArtifactCancelledError) {
          throw new WorldTerrainCompileCancelledError();
        }
        throw error;
      }
    }
    if (artifactBytes > config.limits.maxArtifactBytes) throw new Error(`terrain compile artifact bytes exceed cap ${config.limits.maxArtifactBytes}`);

    if (biomeProfile) {
      const priorBiomeArtifact = previousManifest === undefined ? undefined : derivedGlobalArtifacts(previousManifest)
        .find((artifact: any) => artifact.artifactType === BIOME_FIELD_ARTIFACT_TYPE);
      const reusableBiome = cacheCompilerMatches
        && previousStageKeys?.stageKeys?.["biome-field"]?.["@global"] === nextStageKeys["biome-field"]["@global"]
        && priorBiomeArtifact?.mediaType === BIOME_FIELD_ARTIFACT_MEDIA_TYPE
        && availableArtifactHashes.has(priorBiomeArtifact?.contentHash);
      if (reusableBiome) {
        biomeArtifact = priorBiomeArtifact;
        artifactBytes += priorBiomeArtifact.byteLength;
        reusedArtifactBytes += priorBiomeArtifact.byteLength;
        reusedArtifacts.push(Object.freeze({
          scope: "global",
          artifactType: priorBiomeArtifact.artifactType,
          mediaType: priorBiomeArtifact.mediaType,
          contentHash: priorBiomeArtifact.contentHash,
          byteLength: priorBiomeArtifact.byteLength,
        }));
      } else {
        try {
          const biomeField = compileWorldBiomeField({
            worldMap: map,
            terrainField,
            hydrologyTopology: hydrologyTopology(),
            generatedWaterTopology: hydrologyWaterTopology(),
            shouldCancel,
          });
          const bytes = encodeBiomeFieldArtifact(biomeField, { shouldCancel });
          const contentHash = derivedArtifactContentHash(bytes);
          biomeArtifact = Object.freeze({
            artifactType: BIOME_FIELD_ARTIFACT_TYPE,
            contentHash,
            byteLength: bytes.byteLength,
            mediaType: BIOME_FIELD_ARTIFACT_MEDIA_TYPE,
          });
          artifactBytes += bytes.byteLength;
          emittedArtifactBytes += bytes.byteLength;
          artifacts.push(Object.freeze({
            scope: "global",
            artifactType: BIOME_FIELD_ARTIFACT_TYPE,
            mediaType: BIOME_FIELD_ARTIFACT_MEDIA_TYPE,
            contentHash,
            bytes,
          }));
        } catch (error) {
          if (error instanceof WorldBiomeFieldCancelledError || error instanceof BiomeFieldArtifactCancelledError) {
            throw new WorldTerrainCompileCancelledError();
          }
          throw error;
        }
      }
      if (artifactBytes > config.limits.maxArtifactBytes) throw new Error(`terrain compile artifact bytes exceed cap ${config.limits.maxArtifactBytes}`);
    }
  }

  // The reuse envelope must be strictly key-ordered for the derived-build coordinator
  // (chunk entries in manifest order, then globals by artifactType — the same ordering
  // the manifest's globalArtifacts already use below). The stages above append reused
  // globals in pipeline order, so canonicalize the global tail here; two or more reused
  // globals in pipeline order are rejected as INVALID_COMPILE_OUTPUT.
  const firstReusedGlobal = reusedArtifacts.findIndex((reused) => reused.scope === "global");
  if (firstReusedGlobal >= 0) {
    const reusedGlobals = reusedArtifacts.splice(firstReusedGlobal)
      .sort((a, b) => a.artifactType < b.artifactType ? -1 : a.artifactType > b.artifactType ? 1 : 0);
    reusedArtifacts.push(...reusedGlobals);
  }

  const contentRefs = [mapDocumentRef, ...(designSourceRef === undefined ? [] : [designSourceRef, worldMapRef!]), ...layerRefs]
    .sort((a, b) => a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0);
  const globalArtifacts = [navigationArtifact, overviewArtifact,
    ...(hydrologyProfile ? [hydrologyArtifact, hydrologyWaterArtifact] : []), ...(biomeProfile ? [biomeArtifact] : [])]
    .sort((a, b) => a.artifactType < b.artifactType ? -1 : a.artifactType > b.artifactType ? 1 : 0);
  const manifest = createDerivedRevisionManifest({
    schema: "limina.derived-revision-manifest/v2",
    projectId: request.projectId,
    branchId: request.branchId,
    source: { revision: request.revision, headHash: request.headHash, contentRefs },
    compiler: { version: compilerVersion, configHash: compilerContentHash(config), graphHash: graph.graphHash, snapshotHash: snapshot.snapshotHash },
    grid: field.grid,
    globalArtifacts,
    chunks: compiledChunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      gridId: chunk.gridId,
      lod: chunk.lod,
      tx: chunk.tx,
      tz: chunk.tz,
      topologyHash: chunk.chunkTopologyHash,
      sourceSliceHashes: chunk.manifestSourceSlices,
      artifacts: [chunk.artifact],
    })),
  });
  checkpoint(shouldCancel);
  const diagnostics = Object.freeze([Object.freeze({
    code: "terrain.compile.summary",
    severity: "info",
    message: biomeProfile
      ? "Compiled the complete bounded LOD0 terrain domain with carved river channels, hydrology, generated water, and biome snapshot from one globally eroded authority field."
      : hydrologyProfile
      ? "Compiled the complete bounded LOD0 terrain domain with carved river channels, hydrology field, and generated water topology from one globally eroded authority field."
      : "Compiled the complete bounded LOD0 terrain domain from one globally eroded master field.",
    details: Object.freeze({
      chunkCount,
      artifactCount: chunkCount + 2 + (hydrologyProfile ? 2 : 0) + (biomeProfile ? 1 : 0),
      artifactBytes,
      emittedArtifactCount: artifacts.length,
      emittedArtifactBytes,
      reusedArtifactBytes,
      masterSamples,
      estimatedMapWorkUnits: field.geometry.estimatedWorkUnits,
      editSourceDeltaCount: prepared.sourceDeltaCount,
      editIndexedDeltaCount: prepared.indexedDeltaCount,
      editSliceDeltaVisits,
      reusedArtifacts: reusedArtifacts.length,
      ...(riverChannelDiagnostics === undefined ? {} : { riverChannelCarve: riverChannelDiagnostics }),
    }),
  })]);
  return Object.freeze({
    manifest,
    artifacts: Object.freeze(artifacts),
    reusedArtifacts: Object.freeze(reusedArtifacts),
    snapshot,
    invalidation,
    diagnostics,
  });
}
