import { terrainChunkId, createTerrainGridSpec } from "../../terrain/grid.mjs";
import { sha256 } from "../sha256.mjs";
import {
  canonicalCompilerJson,
  cloneCanonicalCompilerJson,
  compilerContentHash,
  validateCompilerContentHash,
} from "./canonical.mjs";

export const DERIVED_REVISION_MANIFEST_SCHEMA_V1 = "limina.derived-revision-manifest/v1";
export const DERIVED_REVISION_MANIFEST_SCHEMA_V2 = "limina.derived-revision-manifest/v2";
export const DERIVED_REVISION_MANIFEST_SCHEMA = DERIVED_REVISION_MANIFEST_SCHEMA_V2;
export const MAX_DERIVED_MANIFEST_BYTES = 32 * 1024 * 1024;
export const MAX_DERIVED_CHUNKS = 16_384;
export const MAX_SOURCE_CONTENT_REFS = 64;
export const MAX_ARTIFACTS_PER_CHUNK = 16;
export const MAX_GLOBAL_DERIVED_ARTIFACTS = 64;
export const MAX_DERIVED_ARTIFACTS = 131_072;
export const MAX_DERIVED_ARTIFACT_BYTES = 256 * 1024 * 1024;
export const MAX_DERIVED_TOTAL_ARTIFACT_BYTES = 1024 * 1024 * 1024;

const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BRANCH_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const REF_ID = /^[a-z][a-z0-9._-]{0,95}$/;
const ASSET_ID_MAX_LENGTH = 256;
const VERSION = /^[0-9][A-Za-z0-9._+-]{0,63}$/;
const TYPED_ID = /^[a-z][a-z0-9._-]{0,95}\/v[1-9][0-9]*$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
const MANIFEST_LIMITS = Object.freeze({
  maxBytes: MAX_DERIVED_MANIFEST_BYTES,
  maxDepth: 12,
  maxNodes: 1_500_000,
  maxProperties: 32,
  maxArrayLength: MAX_DERIVED_CHUNKS,
});
const VERIFIED_DERIVED_MANIFESTS = new WeakSet();

function codeUnitCompare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function plainObject(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${label} has symbol fields`);
  const actual = Object.getOwnPropertyNames(value);
  const extras = actual.filter((key) => !expected.has(key));
  const missing = [...expected].filter((key) => !actual.includes(key));
  if (extras.length > 0 || missing.length > 0) {
    throw new Error(`${label} fields differ (missing: ${missing.join(", ") || "none"}; extra: ${extras.join(", ") || "none"})`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined || descriptor?.enumerable !== true) {
      throw new Error(`${label}.${key} must be an enumerable data field`);
    }
  }
}

function identifier(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function assetIdentifier(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > ASSET_ID_MAX_LENGTH || value.includes("\\") || value.startsWith("/")) {
    throw new Error(`${label} is invalid`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`${label} contains an invalid path segment`);
  }
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) throw new Error(`${label} is invalid`);
  }
  return value;
}

function orderedUnique(entries, keyOf, label) {
  let previous;
  for (let index = 0; index < entries.length; index++) {
    const key = keyOf(entries[index]);
    if (previous !== undefined && codeUnitCompare(previous, key) >= 0) {
      throw new Error(`${label} must be strictly ordered and unique`);
    }
    previous = key;
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseGrid(input) {
  const grid = plainObject(input, "derived manifest grid");
  exactKeys(grid, new Set(["schema", "gridId", "origin", "chunkSizeM", "defaultSamples"]), "derived manifest grid");
  const canonical = createTerrainGridSpec(grid);
  return {
    schema: canonical.schema,
    gridId: canonical.gridId,
    origin: [...canonical.origin],
    chunkSizeM: canonical.chunkSizeM,
    defaultSamples: canonical.defaultSamples,
  };
}

function parseSource(input) {
  const source = plainObject(input, "derived manifest source");
  exactKeys(source, new Set(["revision", "headHash", "contentRefs"]), "derived manifest source");
  if (!Number.isSafeInteger(source.revision) || source.revision < 0) throw new Error("derived manifest source revision must be a non-negative safe integer");
  if (!Array.isArray(source.contentRefs) || source.contentRefs.length < 1 || source.contentRefs.length > MAX_SOURCE_CONTENT_REFS) {
    throw new Error(`derived manifest source contentRefs must contain 1-${MAX_SOURCE_CONTENT_REFS} entries`);
  }
  const contentRefs = source.contentRefs.map((entry, index) => {
    const ref = plainObject(entry, `derived manifest source ref ${index}`);
    exactKeys(ref, new Set(["refId", "refType", "scope", "assetId", "contentHash"]), `derived manifest source ref ${index}`);
    if (ref.scope !== "global" && ref.scope !== "chunk") throw new Error(`derived manifest source ref ${index} scope must be global or chunk`);
    return {
      refId: identifier(ref.refId, REF_ID, `derived manifest source ref ${index} refId`),
      refType: identifier(ref.refType, TYPED_ID, `derived manifest source ref ${index} refType`),
      scope: ref.scope,
      assetId: assetIdentifier(ref.assetId, `derived manifest source ref ${index} assetId`),
      contentHash: validateCompilerContentHash(ref.contentHash, `derived manifest source ref '${ref.refId}' hash`),
    };
  });
  orderedUnique(contentRefs, (entry) => entry.refId, "derived manifest source refs");
  return {
    revision: source.revision,
    headHash: validateCompilerContentHash(source.headHash, "derived manifest source headHash"),
    contentRefs,
  };
}

function parseCompiler(input) {
  const compiler = plainObject(input, "derived manifest compiler");
  exactKeys(compiler, new Set(["version", "configHash", "graphHash", "snapshotHash"]), "derived manifest compiler");
  return {
    version: identifier(compiler.version, VERSION, "derived manifest compiler version"),
    configHash: validateCompilerContentHash(compiler.configHash, "derived manifest compiler configHash"),
    graphHash: validateCompilerContentHash(compiler.graphHash, "derived manifest compiler graphHash"),
    snapshotHash: validateCompilerContentHash(compiler.snapshotHash, "derived manifest compiler snapshotHash"),
  };
}

function parseArtifactDescriptor(input, label, budget) {
  const artifact = plainObject(input, label);
  exactKeys(artifact, new Set(["artifactType", "contentHash", "byteLength", "mediaType"]), label);
  if (!Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0 || artifact.byteLength > MAX_DERIVED_ARTIFACT_BYTES) {
    throw new Error(`${label} byteLength is out of bounds`);
  }
  budget.artifactCount++;
  budget.totalArtifactBytes += artifact.byteLength;
  if (budget.artifactCount > MAX_DERIVED_ARTIFACTS || budget.totalArtifactBytes > MAX_DERIVED_TOTAL_ARTIFACT_BYTES) {
    throw new Error("derived manifest artifact resources exceed publication bounds");
  }
  return {
    artifactType: identifier(artifact.artifactType, TYPED_ID, `${label} type`),
    contentHash: validateCompilerContentHash(artifact.contentHash, `${label} hash`),
    byteLength: artifact.byteLength,
    mediaType: identifier(artifact.mediaType, MEDIA_TYPE, `${label} mediaType`),
  };
}

function parseGlobalArtifacts(input, budget) {
  if (!Array.isArray(input) || input.length > MAX_GLOBAL_DERIVED_ARTIFACTS) {
    throw new Error(`derived manifest globalArtifacts must contain at most ${MAX_GLOBAL_DERIVED_ARTIFACTS} entries`);
  }
  const artifacts = input.map((artifact, index) => (
    parseArtifactDescriptor(artifact, `derived manifest global artifact ${index}`, budget)
  ));
  orderedUnique(artifacts, (artifact) => artifact.artifactType, "derived manifest global artifacts");
  return artifacts;
}

function parseChunks(input, grid, sourceRefs, budget) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_DERIVED_CHUNKS) {
    throw new Error(`derived manifest chunks must contain 1-${MAX_DERIVED_CHUNKS} entries`);
  }
  const requiredSlices = sourceRefs.filter((ref) => ref.scope === "chunk").map((ref) => ref.refId);
  const chunks = input.map((entry, index) => {
    const chunk = plainObject(entry, `derived manifest chunk ${index}`);
    exactKeys(chunk, new Set(["chunkId", "gridId", "lod", "tx", "tz", "topologyHash", "sourceSliceHashes", "artifacts"]), `derived manifest chunk ${index}`);
    const canonicalId = terrainChunkId(chunk.gridId, chunk.lod, chunk.tx, chunk.tz);
    if (chunk.chunkId !== canonicalId) throw new Error(`derived manifest chunk ${index} has a non-canonical chunkId`);
    if (chunk.gridId !== grid.gridId) throw new Error(`derived manifest chunk '${chunk.chunkId}' belongs to another grid`);
    if (!Array.isArray(chunk.sourceSliceHashes) || chunk.sourceSliceHashes.length !== requiredSlices.length) {
      throw new Error(`derived manifest chunk '${chunk.chunkId}' sourceSliceHashes are dependency-incomplete`);
    }
    const sourceSliceHashes = chunk.sourceSliceHashes.map((slice, sliceIndex) => {
      const parsed = plainObject(slice, `derived manifest chunk '${chunk.chunkId}' source slice ${sliceIndex}`);
      exactKeys(parsed, new Set(["refId", "contentHash"]), `derived manifest chunk '${chunk.chunkId}' source slice ${sliceIndex}`);
      return {
        refId: identifier(parsed.refId, REF_ID, `derived manifest chunk '${chunk.chunkId}' source slice refId`),
        contentHash: validateCompilerContentHash(parsed.contentHash, `derived manifest chunk '${chunk.chunkId}' source slice '${parsed.refId}' hash`),
      };
    });
    orderedUnique(sourceSliceHashes, (slice) => slice.refId, `derived manifest chunk '${chunk.chunkId}' source slices`);
    if (canonicalCompilerJson(sourceSliceHashes.map((slice) => slice.refId)) !== canonicalCompilerJson(requiredSlices)) {
      throw new Error(`derived manifest chunk '${chunk.chunkId}' sourceSliceHashes are dependency-incomplete`);
    }
    if (!Array.isArray(chunk.artifacts) || chunk.artifacts.length < 1 || chunk.artifacts.length > MAX_ARTIFACTS_PER_CHUNK) {
      throw new Error(`derived manifest chunk '${chunk.chunkId}' artifacts must contain 1-${MAX_ARTIFACTS_PER_CHUNK} entries`);
    }
    const artifacts = chunk.artifacts.map((artifact, artifactIndex) => (
      parseArtifactDescriptor(artifact, `derived manifest chunk '${chunk.chunkId}' artifact ${artifactIndex}`, budget)
    ));
    orderedUnique(artifacts, (artifact) => artifact.artifactType, `derived manifest chunk '${chunk.chunkId}' artifacts`);
    return {
      chunkId: chunk.chunkId,
      gridId: chunk.gridId,
      lod: chunk.lod,
      tx: chunk.tx,
      tz: chunk.tz,
      topologyHash: validateCompilerContentHash(chunk.topologyHash, `derived manifest chunk '${chunk.chunkId}' topologyHash`),
      sourceSliceHashes,
      artifacts,
    };
  });
  orderedUnique(chunks, (chunk) => chunk.chunkId, "derived manifest chunks");
  return chunks;
}

function parseCore(input, includeHash) {
  const value = plainObject(input, "derived revision manifest");
  const schemaDescriptor = Object.getOwnPropertyDescriptor(value, "schema");
  if (schemaDescriptor === undefined || schemaDescriptor.get !== undefined || schemaDescriptor.set !== undefined || schemaDescriptor.enumerable !== true) {
    throw new Error("derived revision manifest.schema must be an enumerable data field");
  }
  const schema = schemaDescriptor.value;
  if (schema !== DERIVED_REVISION_MANIFEST_SCHEMA_V1 && schema !== DERIVED_REVISION_MANIFEST_SCHEMA_V2) {
    throw new Error(
      `derived revision manifest schema must be '${DERIVED_REVISION_MANIFEST_SCHEMA_V1}' or '${DERIVED_REVISION_MANIFEST_SCHEMA_V2}'`,
    );
  }
  const isV2 = schema === DERIVED_REVISION_MANIFEST_SCHEMA_V2;
  const keys = new Set(["schema", "projectId", "branchId", "source", "compiler", "grid", "chunks"]);
  if (isV2) keys.add("globalArtifacts");
  if (includeHash) keys.add("manifestHash");
  exactKeys(value, keys, "derived revision manifest");
  const projectId = identifier(value.projectId, PROJECT_ID, "derived manifest projectId");
  const branchId = identifier(value.branchId, BRANCH_ID, "derived manifest branchId");
  const source = parseSource(value.source);
  const compiler = parseCompiler(value.compiler);
  const grid = parseGrid(value.grid);
  const budget = { artifactCount: 0, totalArtifactBytes: 0 };
  const globalArtifacts = isV2 ? parseGlobalArtifacts(value.globalArtifacts, budget) : undefined;
  const chunks = parseChunks(value.chunks, grid, source.contentRefs, budget);
  return isV2
    ? { schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2, projectId, branchId, source, compiler, grid, globalArtifacts, chunks }
    : { schema: DERIVED_REVISION_MANIFEST_SCHEMA_V1, projectId, branchId, source, compiler, grid, chunks };
}

export function createDerivedRevisionManifest(input) {
  const core = parseCore(input, false);
  const manifest = { ...core, manifestHash: compilerContentHash(core, MANIFEST_LIMITS) };
  canonicalCompilerJson(manifest, MANIFEST_LIMITS);
  const verified = deepFreeze(manifest);
  VERIFIED_DERIVED_MANIFESTS.add(verified);
  return verified;
}

export function parseDerivedRevisionManifest(input) {
  const cloned = cloneCanonicalCompilerJson(input, MANIFEST_LIMITS);
  const core = parseCore(cloned, true);
  const manifestHash = validateCompilerContentHash(cloned.manifestHash, "derived manifest manifestHash");
  if (compilerContentHash(core, MANIFEST_LIMITS) !== manifestHash) throw new Error("derived revision manifest hash mismatch");
  const verified = deepFreeze({ ...core, manifestHash });
  VERIFIED_DERIVED_MANIFESTS.add(verified);
  return verified;
}

export function canonicalDerivedRevisionManifest(input) {
  return canonicalCompilerJson(parseDerivedRevisionManifest(input), MANIFEST_LIMITS);
}

const EMPTY_GLOBAL_DERIVED_ARTIFACTS = Object.freeze([]);

export function derivedGlobalArtifacts(manifest) {
  if (!VERIFIED_DERIVED_MANIFESTS.has(manifest)) {
    throw new TypeError("derivedGlobalArtifacts requires a verified derived revision manifest");
  }
  return manifest.schema === DERIVED_REVISION_MANIFEST_SCHEMA_V2
    ? manifest.globalArtifacts
    : EMPTY_GLOBAL_DERIVED_ARTIFACTS;
}

export function derivedArtifactContentHash(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("derived artifact bytes must be Uint8Array");
  if (bytes.byteLength > MAX_DERIVED_ARTIFACT_BYTES) throw new Error(`derived artifact exceeds ${MAX_DERIVED_ARTIFACT_BYTES} bytes`);
  return `sha256:${sha256(bytes)}`;
}
