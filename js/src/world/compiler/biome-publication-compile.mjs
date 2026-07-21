import { parseBiomeContentBundle } from "../biome-content-bundle.mjs";
import { portableAssetContentHash } from "../asset-content-hash.mjs";
import { BIOME_LIBRARY_V1 } from "../biome-library-v1.mjs";
import { biomeRuntimePackContentHash, parseBiomeRuntimePack } from "../biome-runtime-pack.mjs";
import {
  BIOME_CONTENT_CLOSURE_ARTIFACT_MEDIA_TYPE,
  BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE,
  encodeBiomeContentClosureArtifact,
} from "./biome-content-closure-artifact.mjs";
import {
  BIOME_RUNTIME_PACK_ARTIFACT_MEDIA_TYPE,
  BIOME_RUNTIME_PACK_ARTIFACT_TYPE,
} from "./biome-runtime-pack-artifact.mjs";
import {
  BIOME_FIELD_ARTIFACT_TYPE,
  biomeFieldArtifactContentHash,
} from "./biome-field-artifact.mjs";
import {
  BIOME_POPULATION_ARTIFACT_MEDIA_TYPE,
  BIOME_POPULATION_ARTIFACT_TYPE,
  decodeBiomePopulationArtifact,
} from "./biome-population-artifact.mjs";
import {
  SURFACE_COMPOSITE_ARTIFACT_MEDIA_TYPE,
  SURFACE_COMPOSITE_ARTIFACT_TYPE,
  inspectSurfaceCompositeArtifactBindings,
} from "./surface-composite-artifact.mjs";
import { compilerContentHash } from "./canonical.mjs";
import { createPublishedBiomeWorldCompilerGraph } from "./graph.mjs";
import {
  DERIVED_REVISION_MANIFEST_SCHEMA_V3,
  createDerivedRevisionManifest,
  derivedArtifactContentHash,
} from "./manifest.mjs";
import { planCompilerInvalidation } from "./planner.mjs";

export const WORLD_PUBLISHED_BIOME_COMPILER_VERSION = "1.4.0";
export const BIOME_PUBLICATION_INPUT_SCHEMA = "limina.biome-publication-compile-input/v1";

const HASH = /^sha256:[0-9a-f]{64}$/;

function exact(value, keys, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const names = Object.getOwnPropertyNames(value).sort(), expected = [...keys].sort();
  if (Object.getOwnPropertySymbols(value).length !== 0 || names.length !== expected.length
      || names.some((name, index) => name !== expected[index])) throw new TypeError(`${label} fields are invalid`);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || descriptor.get || descriptor.set) throw new TypeError(`${label}.${name} must be an enumerable data field`);
  }
  return value;
}

function dense(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
      || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    throw new TypeError(`${label} must be a dense standard array`);
  }
  return value;
}

function ownedBytes(value, label) {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer)
      || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    throw new TypeError(`${label} must be an owned complete Uint8Array`);
  }
  return value;
}

function hash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) throw new TypeError(`${label} must be a canonical content hash`);
  return value;
}

function artifact(bytes, artifactType, mediaType, scope, chunkId) {
  const contentHash = derivedArtifactContentHash(bytes);
  return Object.freeze({
    scope,
    ...(chunkId === undefined ? {} : { chunkId }),
    artifactType,
    mediaType,
    contentHash,
    bytes,
  });
}

function descriptor(value) {
  return Object.freeze({ artifactType: value.artifactType, contentHash: value.contentHash,
    byteLength: value.bytes.byteLength, mediaType: value.mediaType });
}

function publicationInput(value) {
  const root = exact(value, ["schema", "runtimePack", "contentBundle", "chunks"], "biome publication input");
  if (root.schema !== BIOME_PUBLICATION_INPUT_SCHEMA) throw new Error(`biome publication input schema must be '${BIOME_PUBLICATION_INPUT_SCHEMA}'`);
  const runtimePack = exact(root.runtimePack,
    ["assetId", "contentHash", "byteContentHash", "byteLength", "bytes"], "biome publication runtime pack");
  hash(runtimePack.contentHash, "biome publication runtime pack hash");
  hash(runtimePack.byteContentHash, "biome publication runtime pack byte hash");
  if (typeof runtimePack.assetId !== "string" || !Number.isSafeInteger(runtimePack.byteLength) || runtimePack.byteLength < 1) {
    throw new TypeError("biome publication runtime pack identity is invalid");
  }
  const runtimePackBytes = ownedBytes(runtimePack.bytes, "biome publication runtime pack bytes");
  if (runtimePackBytes.byteLength !== runtimePack.byteLength
      || portableAssetContentHash(runtimePackBytes) !== runtimePack.byteContentHash) {
    throw new Error("biome publication runtime pack bytes do not match their exact identity");
  }
  let parsedRuntimePack;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(runtimePackBytes);
    parsedRuntimePack = parseBiomeRuntimePack(JSON.parse(decoded), BIOME_LIBRARY_V1);
  } catch (error) {
    throw new Error(`biome publication runtime pack bytes are invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (biomeRuntimePackContentHash(parsedRuntimePack, BIOME_LIBRARY_V1) !== runtimePack.contentHash) {
    throw new Error("biome publication runtime pack semantic identity does not match its exact bytes");
  }
  const contentBundle = parseBiomeContentBundle(root.contentBundle);
  if (contentBundle.runtimePack.assetId !== runtimePack.assetId || contentBundle.runtimePack.contentHash !== runtimePack.contentHash) {
    throw new Error("biome publication runtime pack does not match its content closure");
  }
  return Object.freeze({ runtimePack: Object.freeze({ assetId: runtimePack.assetId,
      contentHash: runtimePack.contentHash, byteContentHash: runtimePack.byteContentHash,
      byteLength: runtimePack.byteLength, bytes: runtimePackBytes }), contentBundle,
    chunks: dense(root.chunks, 16_384, "biome publication chunks") });
}

/**
 * Promote one cold, verified 1.3 terrain/biome compilation plus reviewed immutable B3
 * artifacts into the production 1.4 manifest. This function does no filesystem or network IO.
 */
export function publishBiomeTerrainCompilation({ baseCompilation, publication, compiler, cancellation }) {
  if (cancellation?.shouldCancel?.() === true) throw new Error("biome publication compilation cancelled");
  if (baseCompilation?.manifest?.compiler?.version !== "1.3.0" || !baseCompilation.snapshot || !Array.isArray(baseCompilation.artifacts)) {
    throw new TypeError("biome publication requires a complete cold 1.3 base compilation");
  }
  const compilerIdentity = exact(compiler, ["version", "configHash"], "published biome compiler identity");
  if (compilerIdentity.version !== WORLD_PUBLISHED_BIOME_COMPILER_VERSION) throw new Error("published biome compiler version mismatch");
  hash(compilerIdentity.configHash, "published biome compiler config hash");
  const input = publicationInput(publication);
  const baseManifest = baseCompilation.manifest;
  if (baseManifest.compiler.graphHash !== baseCompilation.snapshot.graphHash
      || baseManifest.compiler.snapshotHash !== baseCompilation.snapshot.snapshotHash) {
    throw new Error("biome publication base manifest and snapshot disagree on compiler identity");
  }
  const fieldDescriptor = baseManifest.globalArtifacts.find((entry) => entry.artifactType === BIOME_FIELD_ARTIFACT_TYPE);
  const fieldArtifact = baseCompilation.artifacts.find((entry) => entry.artifactType === BIOME_FIELD_ARTIFACT_TYPE
    && entry.contentHash === fieldDescriptor?.contentHash);
  if (fieldDescriptor === undefined || fieldArtifact === undefined) throw new Error("biome publication base compilation is missing biome-field bytes");
  const fieldBytes = ownedBytes(fieldArtifact.bytes, "biome publication field bytes");
  const fieldHash = biomeFieldArtifactContentHash(fieldBytes);
  if (fieldHash !== fieldDescriptor.contentHash) throw new Error("biome publication field descriptor is not bound to its bytes");

  const closureBytes = encodeBiomeContentClosureArtifact(input.contentBundle, cancellation);
  const closureArtifact = artifact(closureBytes, BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE,
    BIOME_CONTENT_CLOSURE_ARTIFACT_MEDIA_TYPE, "global");
  const runtimePackArtifact = artifact(input.runtimePack.bytes, BIOME_RUNTIME_PACK_ARTIFACT_TYPE,
    BIOME_RUNTIME_PACK_ARTIFACT_MEDIA_TYPE, "global");
  const authorizedPopulation = new Map(input.contentBundle.entries.filter((entry) => entry.kind === "population-descriptor")
    .map((entry) => [entry.assetId, entry.contentHash]));
  const byChunk = new Map();
  for (const [index, raw] of input.chunks.entries()) {
    if (cancellation?.shouldCancel?.() === true) throw new Error("biome publication compilation cancelled");
    const chunkInput = exact(raw, ["chunkId", "surfaceBytes", "populationBytes"], `biome publication chunk ${index}`);
    if (byChunk.has(chunkInput.chunkId)) throw new Error(`biome publication duplicates chunk '${chunkInput.chunkId}'`);
    const baseChunk = baseManifest.chunks.find((entry) => entry.chunkId === chunkInput.chunkId);
    if (baseChunk === undefined) throw new Error(`biome publication chunk '${chunkInput.chunkId}' is outside the base manifest`);
    const terrain = baseChunk.artifacts.find((entry) => entry.artifactType === "terrain-chunk/v1");
    if (terrain === undefined) throw new Error(`biome publication chunk '${chunkInput.chunkId}' has no terrain artifact`);
    const surfaceBytes = ownedBytes(chunkInput.surfaceBytes, `biome publication chunk ${index} surface bytes`);
    const surface = inspectSurfaceCompositeArtifactBindings(surfaceBytes);
    if (surface.source.terrainChunkHash !== terrain.contentHash || surface.source.biomeFieldHash !== fieldHash
        || surface.source.biomePackHash !== input.runtimePack.contentHash
        || surface.coord.tx !== baseChunk.tx || surface.coord.tz !== baseChunk.tz || surface.coord.lod !== baseChunk.lod) {
      throw new Error(`biome publication chunk '${chunkInput.chunkId}' surface authority mismatch`);
    }
    const populationBytes = ownedBytes(chunkInput.populationBytes, `biome publication chunk ${index} population bytes`);
    const population = decodeBiomePopulationArtifact(populationBytes, cancellation).plan;
    if (population.identity.fieldContentHash !== fieldHash || population.identity.runtimePackContentHash !== input.runtimePack.contentHash
        || population.coord.tx !== baseChunk.tx || population.coord.tz !== baseChunk.tz || population.coord.lod !== baseChunk.lod) {
      throw new Error(`biome publication chunk '${chunkInput.chunkId}' population authority mismatch`);
    }
    for (const placement of population.placements) {
      if (authorizedPopulation.get(placement.assetId) !== placement.contentHash) {
        throw new Error(`biome publication chunk '${chunkInput.chunkId}' uses unauthorized population descriptor '${placement.assetId}'`);
      }
    }
    byChunk.set(chunkInput.chunkId, Object.freeze({
      surface: artifact(surfaceBytes, SURFACE_COMPOSITE_ARTIFACT_TYPE, SURFACE_COMPOSITE_ARTIFACT_MEDIA_TYPE, "chunk", chunkInput.chunkId),
      population: artifact(populationBytes, BIOME_POPULATION_ARTIFACT_TYPE, BIOME_POPULATION_ARTIFACT_MEDIA_TYPE, "chunk", chunkInput.chunkId),
    }));
  }
  if (byChunk.size !== baseManifest.chunks.length) throw new Error("biome publication must provide surface and population artifacts for every base chunk");

  const graph = createPublishedBiomeWorldCompilerGraph();
  const plannerChunks = baseCompilation.snapshot.chunks.map((chunk) => {
    const presentation = byChunk.get(chunk.chunkId);
    return { ...chunk, sourceSliceHashes: {
      "biome.population-artifact": presentation.population.contentHash,
      "biome.surface-artifact": presentation.surface.contentHash,
    } };
  });
  const { snapshot, invalidation } = planCompilerInvalidation({
    graph,
    chunks: plannerChunks,
    configs: {
      "base-biome-world": { compilerVersion: "1.3.0", graphHash: baseCompilation.snapshot.graphHash },
      "biome-content-closure": { schema: BIOME_PUBLICATION_INPUT_SCHEMA, closureHash: input.contentBundle.closureHash,
        status: input.contentBundle.status, runtimePack: { assetId: input.runtimePack.assetId,
          contentHash: input.runtimePack.contentHash, byteContentHash: input.runtimePack.byteContentHash,
          byteLength: input.runtimePack.byteLength } },
      "surface-composite": { artifactType: SURFACE_COMPOSITE_ARTIFACT_TYPE },
      "biome-population": { artifactType: BIOME_POPULATION_ARTIFACT_TYPE },
    },
    globalSourceHashes: {
      "base.snapshot": baseCompilation.snapshot.snapshotHash,
      "biome.content-closure": input.contentBundle.closureHash,
      "biome.runtime-pack": input.runtimePack.contentHash,
      "biome.runtime-pack.bytes": input.runtimePack.byteContentHash,
    },
    previous: undefined,
  });
  const chunks = baseManifest.chunks.map((chunk) => {
    const presentation = byChunk.get(chunk.chunkId);
    return { ...chunk, artifacts: [...chunk.artifacts, descriptor(presentation.surface), descriptor(presentation.population)]
        .sort((left, right) => left.artifactType.localeCompare(right.artifactType)) };
  });
  const globalArtifacts = [...baseManifest.globalArtifacts, descriptor(closureArtifact), descriptor(runtimePackArtifact)]
    .sort((left, right) => left.artifactType.localeCompare(right.artifactType));
  const artifactAuthorities = [...new Set([
    ...baseManifest.globalArtifacts.map((entry) => entry.artifactType),
    ...baseManifest.chunks.flatMap((chunk) => chunk.artifacts.map((entry) => entry.artifactType)),
  ])].sort().map((artifactType) => Object.freeze({
    artifactType,
    compilerGraphHash: baseManifest.compiler.graphHash,
  }));
  const manifest = createDerivedRevisionManifest({
    schema: DERIVED_REVISION_MANIFEST_SCHEMA_V3,
    projectId: baseManifest.projectId,
    branchId: baseManifest.branchId,
    source: baseManifest.source,
    compiler: { version: compilerIdentity.version, configHash: compilerIdentity.configHash,
      graphHash: graph.graphHash, snapshotHash: snapshot.snapshotHash },
    grid: baseManifest.grid,
    artifactAuthorities,
    globalArtifacts,
    chunks,
  });
  const presentationArtifacts = [...byChunk.values()].flatMap((entry) => [entry.surface, entry.population]);
  const artifacts = Object.freeze([...baseCompilation.artifacts, closureArtifact, runtimePackArtifact, ...presentationArtifacts]
    .sort((left, right) => left.contentHash.localeCompare(right.contentHash)));
  const diagnostics = Object.freeze([...(baseCompilation.diagnostics ?? []), Object.freeze({
    code: "biome.publication.summary", severity: "info",
    message: "Published terrain, PBR surface composites, ecological population, and a closure-gated biome content revision.",
    details: Object.freeze({ chunks: chunks.length, contentEntries: input.contentBundle.entries.length,
      closureHash: input.contentBundle.closureHash, runtimePackContentHash: input.runtimePack.contentHash }),
  })]);
  return Object.freeze({ manifest, artifacts, reusedArtifacts: Object.freeze([]), snapshot, invalidation, diagnostics });
}

export function validateBiomePublicationContentEntries(publication, entries) {
  const input = publicationInput(publication);
  const values = dense(entries, 4_096, "biome publication content entries");
  if (values.length !== input.contentBundle.entries.length) throw new Error("biome publication content entries do not close the bundle");
  return Object.freeze(values.map((raw, index) => {
    const entry = exact(raw, ["id", "path", "hash", "bytes"], `biome publication content entry ${index}`);
    const expected = input.contentBundle.entries[index];
    const bytes = ownedBytes(entry.bytes, `biome publication content entry ${index} bytes`);
    if (entry.id !== expected.assetId || entry.path !== `assets/${expected.assetId}` || entry.hash !== expected.contentHash
        || bytes.byteLength !== expected.byteLength || portableAssetContentHash(bytes) !== expected.contentHash) {
      throw new Error(`biome publication content entry ${index} does not match its closure`);
    }
    return Object.freeze({ id: entry.id, path: entry.path, hash: entry.hash, bytes });
  }));
}
