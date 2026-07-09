import { terrainChunkId } from "../../terrain/grid.mjs";
import {
  canonicalCompilerJson,
  cloneCanonicalCompilerJson,
  compilerContentHash,
  compilerUtf8ByteLength,
  validateCompilerContentHash,
} from "./canonical.mjs";
import {
  COMPILER_GRAPH_SCHEMA,
  MAX_COMPILER_GRAPH_BYTES,
  MAX_COMPILER_STAGES,
  MAX_STAGE_DEPENDENCIES,
  MAX_STAGE_HALO_CHUNKS,
  MAX_STAGE_SOURCE_INPUTS,
  createCompilerGraph,
} from "./graph.mjs";

export const COMPILER_SNAPSHOT_SCHEMA = "limina.compiler-snapshot/v1";
export const COMPILER_INVALIDATION_SCHEMA = "limina.compiler-invalidation/v1";
export const MAX_COMPILER_CHUNKS = 65_536;
export const MAX_COMPILER_STAGE_INSTANCES = 500_000;
export const MAX_STAGE_CONFIG_BYTES = 65_536;
export const MAX_ALL_STAGE_CONFIG_BYTES = 1_048_576;
export const MAX_CLIENT_DIRTY_HINTS = 4_096;
export const MAX_COMPILER_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const MAX_COMPILER_DEPENDENCY_BINDINGS = 5_000_000;
export const MAX_STAGE_KEY_DEPENDENCIES = MAX_STAGE_DEPENDENCIES * ((2 * MAX_STAGE_HALO_CHUNKS + 1) ** 2) + MAX_STAGE_SOURCE_INPUTS;
export const MAX_STAGE_KEY_BYTES = 4 * 1024 * 1024;

const GLOBAL_INSTANCE = "@global";
const GLOBAL_TOPOLOGY_HASH = compilerContentHash({ scope: "global" });
const STAGE_ID = /^[a-z][a-z0-9.-]{0,63}$/;
const STAGE_VERSION = /^[0-9][A-Za-z0-9._+-]{0,63}$/;
const SOURCE_INPUT_ID = /^[a-z][a-z0-9._-]{0,95}$/;
const SNAPSHOT_CANONICAL_LIMITS = Object.freeze({
  maxBytes: MAX_COMPILER_SNAPSHOT_BYTES,
  maxDepth: 16,
  maxNodes: 1_500_000,
  maxProperties: MAX_COMPILER_CHUNKS,
  maxArrayLength: MAX_COMPILER_CHUNKS,
});

function codeUnitCompare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function assertPlainObject(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function assertExactKeys(value, allowed, label) {
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${label} has unsupported symbol fields`);
  const names = Object.getOwnPropertyNames(value);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined || descriptor?.enumerable !== true) {
      throw new Error(`${label}.${name} must be an enumerable data field`);
    }
  }
  const extras = names.filter((key) => !allowed.has(key));
  if (extras.length > 0) throw new Error(`${label} has unsupported field(s): ${extras.join(", ")}`);
}

function validatedGraph(graphInput) {
  const graph = cloneCanonicalCompilerJson(graphInput, {
    maxBytes: MAX_COMPILER_GRAPH_BYTES * 2,
    maxArrayLength: MAX_COMPILER_STAGES,
    maxNodes: 20_000,
    maxProperties: MAX_COMPILER_STAGES,
  });
  assertExactKeys(graph, new Set(["schema", "graphHash", "definitions", "topologicalOrder", "reverseDependencies"]), "compiler graph");
  if (graph.schema !== COMPILER_GRAPH_SCHEMA || !Array.isArray(graph.definitions) || !Array.isArray(graph.topologicalOrder)) {
    throw new Error("compiler planner requires a validated compiler graph");
  }
  const expected = createCompilerGraph(graph.definitions);
  if (
    graph.graphHash !== expected.graphHash
    || canonicalCompilerJson(graph.topologicalOrder) !== canonicalCompilerJson(expected.topologicalOrder)
    || canonicalCompilerJson(graph.reverseDependencies) !== canonicalCompilerJson(expected.reverseDependencies)
  ) {
    throw new Error("compiler graph hash or indexes are inconsistent");
  }
  return { graph: expected, definitions: new Map(expected.definitions.map((definition) => [definition.stageId, definition])) };
}

function parseChunks(chunksInput) {
  if (!Array.isArray(chunksInput) || chunksInput.length < 1 || chunksInput.length > MAX_COMPILER_CHUNKS) {
    throw new Error(`compiler chunks must contain 1-${MAX_COMPILER_CHUNKS} entries`);
  }
  const chunks = [];
  const ids = new Set();
  const coordinates = new Set();
  for (let index = 0; index < chunksInput.length; index++) {
    const input = cloneCanonicalCompilerJson(chunksInput[index], { maxBytes: 256 * 1024, maxProperties: 16 });
    assertPlainObject(input, `compiler chunk ${index}`);
    assertExactKeys(input, new Set(["chunkId", "gridId", "lod", "tx", "tz", "chunkTopologyHash", "sourceSliceHashes"]), `compiler chunk ${index}`);
    const canonicalId = terrainChunkId(input.gridId, input.lod, input.tx, input.tz);
    if (input.chunkId !== canonicalId) throw new Error(`compiler chunk ${index} has non-canonical chunkId '${input.chunkId}'`);
    if (ids.has(input.chunkId)) throw new Error(`compiler chunks contain duplicate chunkId '${input.chunkId}'`);
    ids.add(input.chunkId);
    const coordinate = `${input.gridId}:${input.lod}:${input.tx}:${input.tz}`;
    if (coordinates.has(coordinate)) throw new Error(`compiler chunks contain duplicate coordinate ${coordinate}`);
    coordinates.add(coordinate);
    const sourceSliceHashes = assertPlainObject(input.sourceSliceHashes, `compiler chunk '${input.chunkId}' sourceSliceHashes`);
    const hashes = {};
    for (const inputId of Object.keys(sourceSliceHashes).sort(codeUnitCompare)) {
      if (!SOURCE_INPUT_ID.test(inputId)) throw new Error(`compiler chunk '${input.chunkId}' has an invalid source input id`);
      hashes[inputId] = validateCompilerContentHash(sourceSliceHashes[inputId], `compiler chunk '${input.chunkId}' source '${inputId}'`);
    }
    chunks.push({
      chunkId: input.chunkId,
      gridId: input.gridId,
      lod: input.lod,
      tx: input.tx,
      tz: input.tz,
      chunkTopologyHash: validateCompilerContentHash(input.chunkTopologyHash, `compiler chunk '${input.chunkId}' topology hash`),
      sourceSliceHashes: hashes,
    });
  }
  return chunks.sort((a, b) => codeUnitCompare(a.chunkId, b.chunkId));
}

function parseConfigs(configsInput, definitions) {
  const configs = assertPlainObject(configsInput ?? {}, "compiler configs");
  const stageIds = new Set(definitions.keys());
  const unknown = Object.keys(configs).filter((stageId) => !stageIds.has(stageId));
  if (unknown.length > 0) throw new Error(`compiler configs contain unknown stage(s): ${unknown.join(", ")}`);
  const parsed = {};
  let total = 0;
  for (const stageId of [...stageIds].sort(codeUnitCompare)) {
    const canonical = canonicalCompilerJson(configs[stageId] ?? {}, { maxBytes: MAX_STAGE_CONFIG_BYTES });
    total += compilerUtf8ByteLength(canonical);
    if (total > MAX_ALL_STAGE_CONFIG_BYTES) throw new Error(`compiler configs exceed ${MAX_ALL_STAGE_CONFIG_BYTES} bytes`);
    parsed[stageId] = JSON.parse(canonical);
  }
  return parsed;
}

function requiredSourceInputs(definitions) {
  const global = new Set();
  const chunk = new Set();
  for (const definition of definitions.values()) {
    for (const source of definition.sourceInputs) (source.scope === "global" ? global : chunk).add(source.inputId);
  }
  return { global, chunk };
}

function parseGlobalSourceHashes(input, required) {
  const hashesInput = assertPlainObject(input, "compiler globalSourceHashes");
  const unknown = Object.keys(hashesInput).filter((inputId) => !required.has(inputId));
  if (unknown.length > 0) throw new Error(`compiler globalSourceHashes contain undeclared input(s): ${unknown.join(", ")}`);
  const hashes = {};
  for (const inputId of [...required].sort(codeUnitCompare)) {
    if (!(inputId in hashesInput)) throw new Error(`compiler globalSourceHashes are missing '${inputId}'`);
    hashes[inputId] = validateCompilerContentHash(hashesInput[inputId], `compiler global source '${inputId}'`);
  }
  return hashes;
}

function validateChunkSourceHashes(chunks, required) {
  for (const chunk of chunks) {
    const actual = new Set(Object.keys(chunk.sourceSliceHashes));
    const unknown = [...actual].filter((inputId) => !required.has(inputId));
    if (unknown.length > 0) throw new Error(`compiler chunk '${chunk.chunkId}' has undeclared source input(s): ${unknown.join(", ")}`);
    for (const inputId of required) {
      if (!actual.has(inputId)) throw new Error(`compiler chunk '${chunk.chunkId}' is missing source input '${inputId}'`);
    }
  }
}

function parseDirtyHints(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_CLIENT_DIRTY_HINTS) {
    throw new Error(`client dirty hints must contain at most ${MAX_CLIENT_DIRTY_HINTS} chunk ids`);
  }
  const result = [];
  const seen = new Set();
  for (let index = 0; index < input.length; index++) {
    const hint = input[index];
    if (typeof hint !== "string" || hint.length < 1 || hint.length > 256) throw new Error(`client dirty hint ${index} is invalid`);
    if (seen.has(hint)) throw new Error(`client dirty hints contain duplicate '${hint}'`);
    seen.add(hint);
    result.push(hint);
  }
  return result.sort(codeUnitCompare);
}

/** Exact versioned stage-key contract consumed by artifact caches and publishers. */
export function compilerStageKey(input) {
  const value = assertPlainObject(input, "compiler stage key");
  assertExactKeys(value, new Set(["stageId", "stageVersion", "config", "chunkTopologyHash", "sortedDependencyHashes"]), "compiler stage key");
  if (typeof value.stageId !== "string" || !STAGE_ID.test(value.stageId)) throw new Error("compiler stage key has an invalid stageId");
  if (typeof value.stageVersion !== "string" || !STAGE_VERSION.test(value.stageVersion)) throw new Error("compiler stage key has an invalid stageVersion");
  if (!Array.isArray(value.sortedDependencyHashes) || value.sortedDependencyHashes.length > MAX_STAGE_KEY_DEPENDENCIES) {
    throw new Error(`compiler stage key dependencies must contain at most ${MAX_STAGE_KEY_DEPENDENCIES} entries`);
  }
  const dependencies = value.sortedDependencyHashes;
  const parsedDependencies = dependencies.map((entry, index) => {
    const dependency = assertPlainObject(entry, `compiler stage-key dependency ${index}`);
    assertExactKeys(dependency, new Set(["dependencyId", "hash"]), `compiler stage-key dependency ${index}`);
    if (typeof dependency.dependencyId !== "string" || dependency.dependencyId.length < 1 || dependency.dependencyId.length > 512 || /[\u0000-\u001f\u007f]/.test(dependency.dependencyId)) {
      throw new Error(`compiler stage-key dependency ${index} has an invalid dependencyId`);
    }
    return { dependencyId: dependency.dependencyId, hash: validateCompilerContentHash(dependency.hash, `compiler stage-key dependency '${dependency.dependencyId}'`) };
  }).sort((a, b) => codeUnitCompare(a.dependencyId, b.dependencyId));
  if (new Set(parsedDependencies.map((dependency) => dependency.dependencyId)).size !== parsedDependencies.length) {
    throw new Error("compiler stage key has duplicate dependency ids");
  }
  const payload = {
    stageId: value.stageId,
    stageVersion: value.stageVersion,
    config: cloneCanonicalCompilerJson(value.config, { maxBytes: MAX_STAGE_CONFIG_BYTES }),
    chunkTopologyHash: validateCompilerContentHash(value.chunkTopologyHash, "compiler stage-key topology hash"),
    sortedDependencyHashes: parsedDependencies,
  };
  return compilerContentHash(payload, {
    maxBytes: MAX_STAGE_KEY_BYTES,
    maxArrayLength: MAX_STAGE_KEY_DEPENDENCIES,
    maxNodes: MAX_STAGE_KEY_DEPENDENCIES * 3 + 10,
  });
}

function addDependency(dependencies, dependency, work) {
  if (++work.bindings > MAX_COMPILER_DEPENDENCY_BINDINGS) {
    throw new Error(`compiler plan exceeds ${MAX_COMPILER_DEPENDENCY_BINDINGS} dependency bindings`);
  }
  dependencies.push(dependency);
}

function dependencyHashesForChunk(definition, chunk, chunksByCoordinate, stageKeys, definitions, work) {
  const dependencies = [];
  for (const source of definition.sourceInputs) {
    if (source.scope === "global") continue;
    addDependency(dependencies, { dependencyId: `source:${source.inputId}:${chunk.chunkId}`, hash: chunk.sourceSliceHashes[source.inputId] }, work);
  }
  for (const upstreamId of definition.dependencies) {
    const upstream = definitions.get(upstreamId);
    if (upstream.scope === "global") {
      addDependency(dependencies, { dependencyId: `stage:${upstreamId}:${GLOBAL_INSTANCE}`, hash: stageKeys[upstreamId][GLOBAL_INSTANCE] }, work);
      continue;
    }
    const halo = definition.footprint.haloChunks;
    for (let dz = -halo; dz <= halo; dz++) {
      for (let dx = -halo; dx <= halo; dx++) {
        const dependencyChunk = chunksByCoordinate.get(`${chunk.gridId}:${chunk.lod}:${chunk.tx + dx}:${chunk.tz + dz}`);
        if (dependencyChunk === undefined) continue;
        addDependency(dependencies, {
          dependencyId: `stage:${upstreamId}:${dependencyChunk.chunkId}`,
          hash: stageKeys[upstreamId][dependencyChunk.chunkId],
        }, work);
      }
    }
  }
  return dependencies;
}

export function buildCompilerSnapshot(input) {
  const { graph, definitions } = validatedGraph(input?.graph);
  const chunks = parseChunks(input?.chunks);
  const instanceCount = [...definitions.values()].reduce((total, definition) => total + (definition.scope === "global" ? 1 : chunks.length), 0);
  if (instanceCount > MAX_COMPILER_STAGE_INSTANCES) throw new Error(`compiler plan exceeds ${MAX_COMPILER_STAGE_INSTANCES} stage instances`);
  const configs = parseConfigs(input?.configs, definitions);
  const required = requiredSourceInputs(definitions);
  const globalSourceHashes = parseGlobalSourceHashes(input?.globalSourceHashes, required.global);
  validateChunkSourceHashes(chunks, required.chunk);
  const chunksByCoordinate = new Map(chunks.map((chunk) => [`${chunk.gridId}:${chunk.lod}:${chunk.tx}:${chunk.tz}`, chunk]));
  const stageKeys = {};
  const work = { bindings: 0 };
  for (const stageId of graph.topologicalOrder) {
    const definition = definitions.get(stageId);
    const keys = {};
    if (definition.scope === "global") {
      const dependencies = [];
      for (const source of definition.sourceInputs) {
        addDependency(dependencies, { dependencyId: `source:${source.inputId}:${GLOBAL_INSTANCE}`, hash: globalSourceHashes[source.inputId] }, work);
      }
      for (const upstreamId of definition.dependencies) {
        addDependency(dependencies, { dependencyId: `stage:${upstreamId}:${GLOBAL_INSTANCE}`, hash: stageKeys[upstreamId][GLOBAL_INSTANCE] }, work);
      }
      keys[GLOBAL_INSTANCE] = compilerStageKey({
        stageId,
        stageVersion: definition.stageVersion,
        config: configs[stageId],
        chunkTopologyHash: GLOBAL_TOPOLOGY_HASH,
        sortedDependencyHashes: dependencies,
      });
    } else {
      for (const chunk of chunks) {
        const dependencies = dependencyHashesForChunk(definition, chunk, chunksByCoordinate, stageKeys, definitions, work);
        for (const source of definition.sourceInputs) {
          if (source.scope === "global") addDependency(dependencies, { dependencyId: `source:${source.inputId}:${GLOBAL_INSTANCE}`, hash: globalSourceHashes[source.inputId] }, work);
        }
        keys[chunk.chunkId] = compilerStageKey({
          stageId,
          stageVersion: definition.stageVersion,
          config: configs[stageId],
          chunkTopologyHash: chunk.chunkTopologyHash,
          sortedDependencyHashes: dependencies,
        });
      }
    }
    stageKeys[stageId] = keys;
  }
  const snapshotCore = {
    schema: COMPILER_SNAPSHOT_SCHEMA,
    graphHash: graph.graphHash,
    chunks: chunks.map(({ sourceSliceHashes: _sourceSliceHashes, ...chunk }) => chunk),
    stageKeys,
  };
  const snapshot = { ...snapshotCore, snapshotHash: compilerContentHash(snapshotCore, SNAPSHOT_CANONICAL_LIMITS) };
  // Enforce the retained representation bound too, not only the pre-hash core.
  canonicalCompilerJson(snapshot, SNAPSHOT_CANONICAL_LIMITS);
  return snapshot;
}

function validatePreviousSnapshot(snapshot) {
  if (snapshot === undefined) return undefined;
  const value = assertPlainObject(snapshot, "previous compiler snapshot");
  assertExactKeys(value, new Set(["schema", "graphHash", "chunks", "stageKeys", "snapshotHash"]), "previous compiler snapshot");
  if (value.schema !== COMPILER_SNAPSHOT_SCHEMA) throw new Error(`previous compiler snapshot schema must be '${COMPILER_SNAPSHOT_SCHEMA}'`);
  canonicalCompilerJson(value, SNAPSHOT_CANONICAL_LIMITS);
  validateCompilerContentHash(value.graphHash, "previous compiler graph hash");
  validateCompilerContentHash(value.snapshotHash, "previous compiler snapshot hash");
  const { snapshotHash: _snapshotHash, ...core } = value;
  if (compilerContentHash(core, SNAPSHOT_CANONICAL_LIMITS) !== value.snapshotHash) {
    throw new Error("previous compiler snapshot hash mismatch");
  }
  if (!Array.isArray(value.chunks) || value.chunks.length < 1 || value.chunks.length > MAX_COMPILER_CHUNKS) {
    throw new Error(`previous compiler snapshot chunks must contain 1-${MAX_COMPILER_CHUNKS} entries`);
  }
  const chunkIds = new Set();
  const coordinates = new Set();
  for (let index = 0; index < value.chunks.length; index++) {
    const chunk = assertPlainObject(value.chunks[index], `previous compiler snapshot chunk ${index}`);
    assertExactKeys(chunk, new Set(["chunkId", "gridId", "lod", "tx", "tz", "chunkTopologyHash"]), `previous compiler snapshot chunk ${index}`);
    const canonicalId = terrainChunkId(chunk.gridId, chunk.lod, chunk.tx, chunk.tz);
    if (chunk.chunkId !== canonicalId) throw new Error(`previous compiler snapshot chunk ${index} has a non-canonical chunkId`);
    if (chunkIds.has(chunk.chunkId)) throw new Error(`previous compiler snapshot has duplicate chunkId '${chunk.chunkId}'`);
    chunkIds.add(chunk.chunkId);
    const coordinate = `${chunk.gridId}:${chunk.lod}:${chunk.tx}:${chunk.tz}`;
    if (coordinates.has(coordinate)) throw new Error(`previous compiler snapshot has duplicate coordinate ${coordinate}`);
    coordinates.add(coordinate);
    validateCompilerContentHash(chunk.chunkTopologyHash, `previous compiler snapshot chunk '${chunk.chunkId}' topology hash`);
  }
  const stageKeys = assertPlainObject(value.stageKeys, "previous compiler snapshot stageKeys");
  const stageIds = Object.keys(stageKeys);
  if (stageIds.length < 1 || stageIds.length > MAX_COMPILER_STAGES) {
    throw new Error(`previous compiler snapshot stageKeys must contain 1-${MAX_COMPILER_STAGES} stages`);
  }
  let instances = 0;
  for (const stageId of stageIds) {
    if (!STAGE_ID.test(stageId)) throw new Error(`previous compiler snapshot has an invalid stage id '${stageId}'`);
    const keys = assertPlainObject(stageKeys[stageId], `previous compiler snapshot stage '${stageId}' keys`);
    const instanceIds = Object.keys(keys);
    instances += instanceIds.length;
    if (instances > MAX_COMPILER_STAGE_INSTANCES) {
      throw new Error(`previous compiler snapshot exceeds ${MAX_COMPILER_STAGE_INSTANCES} stage instances`);
    }
    for (const instanceId of instanceIds) {
      if (instanceId !== GLOBAL_INSTANCE && !chunkIds.has(instanceId)) {
        throw new Error(`previous compiler snapshot stage '${stageId}' has unknown instance '${instanceId}'`);
      }
      validateCompilerContentHash(keys[instanceId], `previous compiler snapshot stage '${stageId}' instance '${instanceId}'`);
    }
  }
  return value;
}

export function canonicalCompilerSnapshot(snapshot) {
  return canonicalCompilerJson(snapshot, SNAPSHOT_CANONICAL_LIMITS);
}

export function planCompilerInvalidation(input) {
  const dirtyHints = parseDirtyHints(input?.clientDirtyHints);
  const previous = validatePreviousSnapshot(input?.previous);
  const next = buildCompilerSnapshot(input);
  const changedByStage = {};
  const removedByStage = {};
  const changedChunks = new Set();
  let changedInstances = 0;
  let cacheHits = 0;
  for (const stageId of Object.keys(next.stageKeys).sort(codeUnitCompare)) {
    const changed = [];
    for (const instanceId of Object.keys(next.stageKeys[stageId]).sort(codeUnitCompare)) {
      if (previous?.stageKeys?.[stageId]?.[instanceId] === next.stageKeys[stageId][instanceId]) cacheHits++;
      else {
        changed.push(instanceId);
        changedInstances++;
        if (instanceId !== GLOBAL_INSTANCE) changedChunks.add(instanceId);
      }
    }
    changedByStage[stageId] = changed;
  }
  if (previous !== undefined) {
    for (const stageId of Object.keys(previous.stageKeys).sort(codeUnitCompare)) {
      const removed = Object.keys(previous.stageKeys[stageId]).filter((instanceId) => next.stageKeys?.[stageId]?.[instanceId] === undefined).sort(codeUnitCompare);
      if (removed.length > 0) removedByStage[stageId] = removed;
    }
  }
  const changedChunkIds = [...changedChunks].sort(codeUnitCompare);
  const changedSet = new Set(changedChunkIds);
  const hintSet = new Set(dirtyHints);
  const missedChangedChunks = changedChunkIds.filter((chunkId) => !hintSet.has(chunkId));
  const extraHintChunks = dirtyHints.filter((chunkId) => !changedSet.has(chunkId));
  const invalidation = {
    schema: COMPILER_INVALIDATION_SCHEMA,
    previousSnapshotHash: previous?.snapshotHash ?? null,
    snapshotHash: next.snapshotHash,
    changedByStage,
    removedByStage,
    changedChunks: changedChunkIds,
    changedInstances,
    cacheHits,
    telemetry: {
      clientDirtyHints: dirtyHints,
      missedChangedChunks,
      extraHintChunks,
    },
  };
  return { snapshot: next, invalidation };
}
