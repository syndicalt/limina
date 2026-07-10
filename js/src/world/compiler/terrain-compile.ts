import { WorldMapSchema, migrateWorldMap, verifyWorldMap, type WorldMap } from "../worldmap.ts";
import { createMapTerrainField, sliceMapFieldChunk, MapFieldCancelledError, MAX_MAP_FIELD_MASTER_RES } from "../../terrain/map-field.mjs";
import {
  createTerrainEditBaseTopology,
  parseTerrainEditLayer,
  prepareTerrainEditLayers,
  composePreparedTerrainEditLayers,
  preparedTerrainEditLayerChunkSlices,
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
import { compilerContentHash, validateCompilerContentHash } from "./canonical.mjs";
import { createHydrologyWorldCompilerGraph, createInitialWorldCompilerGraph } from "./graph.mjs";
import { planCompilerInvalidation } from "./planner.mjs";
import { createDerivedRevisionManifest, derivedArtifactContentHash, derivedGlobalArtifacts, parseDerivedRevisionManifest } from "./manifest.mjs";
import { encodeTerrainChunkArtifact, TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE } from "./terrain-artifact.mjs";

export const WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA = "limina.world-terrain-compiler-config/v1";
export const WORLD_HYDROLOGY_TERRAIN_COMPILER_VERSION = "1.1.0";
export const TERRAIN_CHUNK_ARTIFACT_TYPE = "terrain-chunk/v1";
export const MAX_WORLD_TERRAIN_COMPILE_CHUNKS = 16_384;
export const MAX_WORLD_TERRAIN_COMPILE_ARTIFACT_BYTES = 256 * 1024 * 1024;
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

const encodeHydrologyArtifact = encodeHydrologyFieldArtifact as unknown as HydrologyArtifactEncoder;

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
  return compilerContentHash({ schema: "limina.world-terrain-source/v1", worldMap: terrainInputs });
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
  const config = parseConfig(compilerInput.config);
  const map = WorldMapSchema.parse(migrateWorldMap(root.worldMap)) as WorldMap;
  const verification = verifyWorldMap(map);
  if (!verification.ok) throw new Error(`WorldMap content hash mismatch: expected '${verification.expected}', actual '${verification.actual}'`);
  const hydrologyProfile = compilerVersion === WORLD_HYDROLOGY_TERRAIN_COMPILER_VERSION;
  if (hydrologyProfile !== (map.hydrology !== undefined)) {
    throw new Error(hydrologyProfile
      ? "hydrology terrain compiler profile requires a WorldMap hydrology recipe"
      : `WorldMap hydrology recipe requires compiler version '${WORLD_HYDROLOGY_TERRAIN_COMPILER_VERSION}'`);
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
  const domain = terrainChunkRangeForBounds(field.grid, field.bounds);
  const width = domain.maxTx - domain.minTx + 1, height = domain.maxTz - domain.minTz + 1;
  const chunkCount = width * height;
  if (!Number.isSafeInteger(chunkCount) || chunkCount > config.limits.maxChunks) throw new Error(`terrain compile domain has ${chunkCount} chunks, exceeding cap ${config.limits.maxChunks}`);
  const baseTopology = createTerrainEditBaseTopology({ grid: field.grid, domain });
  for (const layer of layers) if (layer.baseTopology.topologyHash !== baseTopology.topologyHash) throw new Error(`terrain edit layer '${layer.layerId}' base topology does not match compiler domain`);
  const prepared = prepareTerrainEditLayers({ baseTopology, layers }, { shouldCancel });

  // Pass 1 computes dependency identity only. No chunk artifact is materialized before the
  // compiler-owned invalidation plan decides whether a verified prior artifact is reusable.
  const compiledChunks: any[] = [];
  let editSliceDeltaVisits = 0, work = 0;
  for (let tz = domain.minTz; tz <= domain.maxTz; tz++) {
    for (let tx = domain.minTx; tx <= domain.maxTx; tx++) {
      checkpoint(shouldCancel, work++);
      const topology = terrainChunkTopology(field.grid, { lod: 0, tx, tz, samples: 33 });
      const chunkSlices = preparedTerrainEditLayerChunkSlices({ baseTopology, chunkTopology: topology, preparedLayers: prepared }, { shouldCancel });
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
  const graph = hydrologyProfile ? createHydrologyWorldCompilerGraph() : createInitialWorldCompilerGraph();
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
      ...(hydrologyProfile ? {
        "hydrology-field": {
          schema: "limina.hydrology-field-stage-config/v1",
          topologyVersion: HYDROLOGY_TOPOLOGY_VERSION,
          artifactVersion: HYDROLOGY_FIELD_ARTIFACT_VERSION,
        },
      } : {}),
    },
    globalSourceHashes: hydrologyProfile ? {
      "worldmap.global": terrainWorldMapSourceHash(map),
      "hydrology.precipitation": compilerContentHash({
        schema: "limina.hydrology-precipitation-source/v1",
        precipitationMmPerYear: map.hydrology!.precipitationMmPerYear,
      }),
    } : { "worldmap.global": expectedWorldMapHash },
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
      const coldAvailability = denseArray(root.availableArtifactHashes, MAX_WORLD_TERRAIN_COMPILE_CHUNKS + (hydrologyProfile ? 1 : 0), "available terrain artifact hashes");
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
      reusedArtifacts.push(Object.freeze(hydrologyProfile ? {
        scope: "chunk",
        chunkId: chunk.chunkId,
        artifactType: priorArtifact.artifactType,
        mediaType: priorArtifact.mediaType,
        contentHash: priorArtifact.contentHash,
        byteLength: priorArtifact.byteLength,
      } : {
        chunkId: chunk.chunkId,
        artifactType: priorArtifact.artifactType,
        mediaType: priorArtifact.mediaType,
        contentHash: priorArtifact.contentHash,
        byteLength: priorArtifact.byteLength,
      }));
    } else {
      const base = sliceMapFieldChunk(field, chunk.tx, chunk.tz, { shouldCancel });
      const topology = terrainChunkTopology(field.grid, { lod: chunk.lod, tx: chunk.tx, tz: chunk.tz, samples: 33 });
      const composed = composePreparedTerrainEditLayers({ baseTopology, chunkTopology: topology, baseHeightsM: base.heightsM, preparedLayers: prepared }, { shouldCancel });
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
      artifacts.push(Object.freeze(hydrologyProfile
        ? { scope: "chunk", chunkId: chunk.chunkId, artifactType: TERRAIN_CHUNK_ARTIFACT_TYPE, mediaType: TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE, contentHash, bytes }
        : { chunkId: chunk.chunkId, artifactType: TERRAIN_CHUNK_ARTIFACT_TYPE, mediaType: TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE, contentHash, bytes }));
    }
    if (artifactBytes > config.limits.maxArtifactBytes) throw new Error(`terrain compile artifact bytes exceed cap ${config.limits.maxArtifactBytes}`);
  }

  let hydrologyArtifact: any | undefined;
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
        const topology = createHydrologyTopology({
          rows: field.masterRes,
          cols: field.masterRes,
          heightsM: field.heightsM,
          cellSizeM: field.masterStep,
          seaLevelM: field.seaLevelM,
          precipitationMmPerYear: map.hydrology!.precipitationMmPerYear,
          shouldCancel,
        });
        const bytes = encodeHydrologyArtifact(topology, {
          originX: field.bounds.minX,
          originZ: field.bounds.minZ,
        }, { shouldCancel });
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
        if (error instanceof HydrologyTopologyCancelledError || error instanceof HydrologyArtifactCancelledError) {
          throw new WorldTerrainCompileCancelledError();
        }
        throw error;
      }
    }
    if (artifactBytes > config.limits.maxArtifactBytes) throw new Error(`terrain compile artifact bytes exceed cap ${config.limits.maxArtifactBytes}`);
  }

  const contentRefs = [mapDocumentRef, ...(designSourceRef === undefined ? [] : [designSourceRef, worldMapRef!]), ...layerRefs]
    .sort((a, b) => a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0);
  const manifest = createDerivedRevisionManifest({
    schema: hydrologyProfile ? "limina.derived-revision-manifest/v2" : "limina.derived-revision-manifest/v1",
    projectId: request.projectId,
    branchId: request.branchId,
    source: { revision: request.revision, headHash: request.headHash, contentRefs },
    compiler: { version: compilerVersion, configHash: compilerContentHash(config), graphHash: graph.graphHash, snapshotHash: snapshot.snapshotHash },
    grid: field.grid,
    ...(hydrologyProfile ? { globalArtifacts: [hydrologyArtifact] } : {}),
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
    message: hydrologyProfile
      ? "Compiled the complete bounded LOD0 terrain domain and global hydrology field from one globally eroded master field."
      : "Compiled the complete bounded LOD0 terrain domain from one globally eroded master field.",
    details: Object.freeze({
      chunkCount,
      artifactCount: chunkCount + (hydrologyProfile ? 1 : 0),
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
