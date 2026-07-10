import { cloneCanonicalCompilerJson, compilerContentHash } from "./canonical.mjs";

export const COMPILER_STAGE_SCHEMA = "limina.compiler-stage/v1";
export const COMPILER_GRAPH_SCHEMA = "limina.compiler-graph/v1";
export const MAX_COMPILER_STAGES = 64;
export const MAX_STAGE_DEPENDENCIES = 16;
export const MAX_STAGE_SOURCE_INPUTS = 16;
export const MAX_COMPILER_GRAPH_EDGES = 512;
export const MAX_STAGE_HALO_CHUNKS = 16;
export const MAX_COMPILER_GRAPH_BYTES = 1024 * 1024;

const STAGE_ID = /^[a-z][a-z0-9.-]{0,63}$/;
const STAGE_VERSION = /^[0-9][A-Za-z0-9._+-]{0,63}$/;
const SOURCE_INPUT_ID = /^[a-z][a-z0-9._-]{0,95}$/;

function assertObject(value, label) {
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

function codeUnitCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function deepFreezeJson(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function parseStageDefinition(input, index) {
  const stage = assertObject(input, `compiler stage ${index}`);
  assertExactKeys(stage, new Set(["schema", "stageId", "stageVersion", "scope", "dependencies", "sourceInputs", "footprint"]), `compiler stage ${index}`);
  if (stage.schema !== COMPILER_STAGE_SCHEMA) throw new Error(`compiler stage ${index} schema must be '${COMPILER_STAGE_SCHEMA}'`);
  if (typeof stage.stageId !== "string" || !STAGE_ID.test(stage.stageId)) throw new Error(`compiler stage ${index} has an invalid stageId`);
  if (typeof stage.stageVersion !== "string" || !STAGE_VERSION.test(stage.stageVersion)) throw new Error(`compiler stage '${stage.stageId}' has an invalid stageVersion`);
  if (stage.scope !== "global" && stage.scope !== "chunk") throw new Error(`compiler stage '${stage.stageId}' scope must be global or chunk`);
  if (!Array.isArray(stage.dependencies) || stage.dependencies.length > MAX_STAGE_DEPENDENCIES) {
    throw new Error(`compiler stage '${stage.stageId}' dependencies must contain at most ${MAX_STAGE_DEPENDENCIES} entries`);
  }
  if (!Array.isArray(stage.sourceInputs) || stage.sourceInputs.length > MAX_STAGE_SOURCE_INPUTS) {
    throw new Error(`compiler stage '${stage.stageId}' sourceInputs must contain at most ${MAX_STAGE_SOURCE_INPUTS} entries`);
  }
  const dependencies = stage.dependencies.map((dependency, dependencyIndex) => {
    if (typeof dependency !== "string" || !STAGE_ID.test(dependency)) {
      throw new Error(`compiler stage '${stage.stageId}' dependency ${dependencyIndex} is invalid`);
    }
    return dependency;
  });
  if (new Set(dependencies).size !== dependencies.length) throw new Error(`compiler stage '${stage.stageId}' has duplicate dependencies`);
  const sourceInputs = stage.sourceInputs.map((sourceInput, sourceIndex) => {
    const source = assertObject(sourceInput, `compiler stage '${stage.stageId}' source input ${sourceIndex}`);
    assertExactKeys(source, new Set(["inputId", "scope"]), `compiler stage '${stage.stageId}' source input ${sourceIndex}`);
    if (typeof source.inputId !== "string" || !SOURCE_INPUT_ID.test(source.inputId)) {
      throw new Error(`compiler stage '${stage.stageId}' source input ${sourceIndex} has an invalid inputId`);
    }
    if (source.scope !== "global" && source.scope !== "chunk") {
      throw new Error(`compiler stage '${stage.stageId}' source input '${source.inputId}' has an invalid scope`);
    }
    if (stage.scope === "global" && source.scope === "chunk") {
      throw new Error(`global compiler stage '${stage.stageId}' cannot consume chunk source input '${source.inputId}'`);
    }
    return { inputId: source.inputId, scope: source.scope };
  });
  if (new Set(sourceInputs.map((source) => source.inputId)).size !== sourceInputs.length) {
    throw new Error(`compiler stage '${stage.stageId}' has duplicate source inputs`);
  }
  const footprint = assertObject(stage.footprint, `compiler stage '${stage.stageId}' footprint`);
  assertExactKeys(footprint, new Set(["haloChunks"]), `compiler stage '${stage.stageId}' footprint`);
  if (!Number.isSafeInteger(footprint.haloChunks) || footprint.haloChunks < 0 || footprint.haloChunks > MAX_STAGE_HALO_CHUNKS) {
    throw new Error(`compiler stage '${stage.stageId}' haloChunks must be an integer in [0, ${MAX_STAGE_HALO_CHUNKS}]`);
  }
  if (stage.scope === "global" && footprint.haloChunks !== 0) throw new Error(`global compiler stage '${stage.stageId}' cannot declare a halo`);
  return cloneCanonicalCompilerJson({
    schema: COMPILER_STAGE_SCHEMA,
    stageId: stage.stageId,
    stageVersion: stage.stageVersion,
    scope: stage.scope,
    dependencies: [...dependencies].sort(codeUnitCompare),
    sourceInputs: [...sourceInputs].sort((a, b) => codeUnitCompare(a.inputId, b.inputId)),
    footprint: { haloChunks: footprint.haloChunks },
  });
}

export function createCompilerGraph(definitionsInput) {
  if (!Array.isArray(definitionsInput) || definitionsInput.length < 1 || definitionsInput.length > MAX_COMPILER_STAGES) {
    throw new Error(`compiler graph must contain 1-${MAX_COMPILER_STAGES} stages`);
  }
  const sanitizedDefinitions = cloneCanonicalCompilerJson(definitionsInput, {
    maxBytes: MAX_COMPILER_GRAPH_BYTES,
    maxArrayLength: MAX_COMPILER_STAGES,
    maxNodes: 10_000,
    maxProperties: 16,
  });
  const definitions = sanitizedDefinitions.map(parseStageDefinition);
  const byId = new Map();
  for (const definition of definitions) {
    if (byId.has(definition.stageId)) throw new Error(`compiler graph has duplicate stage '${definition.stageId}'`);
    byId.set(definition.stageId, definition);
  }
  let edgeCount = 0;
  for (const definition of definitions) {
    for (const dependency of definition.dependencies) {
      edgeCount++;
      if (dependency === definition.stageId) throw new Error(`compiler stage '${definition.stageId}' depends on itself`);
      const upstream = byId.get(dependency);
      if (upstream === undefined) throw new Error(`compiler stage '${definition.stageId}' has missing dependency '${dependency}'`);
      if (definition.scope === "global" && upstream.scope === "chunk") {
        throw new Error(`global compiler stage '${definition.stageId}' cannot depend on chunk stage '${dependency}'`);
      }
    }
  }
  if (edgeCount > MAX_COMPILER_GRAPH_EDGES) throw new Error(`compiler graph exceeds ${MAX_COMPILER_GRAPH_EDGES} dependency edges`);

  const indegree = new Map(definitions.map((definition) => [definition.stageId, definition.dependencies.length]));
  const reverse = new Map(definitions.map((definition) => [definition.stageId, []]));
  for (const definition of definitions) {
    for (const dependency of definition.dependencies) reverse.get(dependency).push(definition.stageId);
  }
  for (const downstream of reverse.values()) downstream.sort(codeUnitCompare);
  const ready = definitions.filter((definition) => indegree.get(definition.stageId) === 0).map((definition) => definition.stageId).sort(codeUnitCompare);
  const topologicalOrder = [];
  while (ready.length > 0) {
    const stageId = ready.shift();
    topologicalOrder.push(stageId);
    for (const dependent of reverse.get(stageId)) {
      const next = indegree.get(dependent) - 1;
      indegree.set(dependent, next);
      if (next === 0) { ready.push(dependent); ready.sort(codeUnitCompare); }
    }
  }
  if (topologicalOrder.length !== definitions.length) {
    const cyclic = definitions.map((definition) => definition.stageId).filter((stageId) => !topologicalOrder.includes(stageId)).sort(codeUnitCompare);
    throw new Error(`compiler graph contains a dependency cycle involving: ${cyclic.join(", ")}`);
  }
  const sortedDefinitions = [...definitions].sort((a, b) => codeUnitCompare(a.stageId, b.stageId));
  const reverseDependencies = Object.fromEntries(
    [...reverse.entries()]
      .sort(([a], [b]) => codeUnitCompare(a, b))
      .map(([stageId, dependents]) => [stageId, Object.freeze([...dependents])]),
  );
  const graphHash = compilerContentHash({ schema: COMPILER_GRAPH_SCHEMA, definitions: sortedDefinitions });
  return deepFreezeJson({
    schema: COMPILER_GRAPH_SCHEMA,
    graphHash,
    definitions: sortedDefinitions,
    topologicalOrder,
    reverseDependencies,
  });
}

export const INITIAL_WORLD_COMPILER_STAGE_DEFINITIONS = deepFreezeJson([
  {
    schema: COMPILER_STAGE_SCHEMA,
    stageId: "worldmap",
    stageVersion: "1.0.0",
    scope: "global",
    dependencies: [],
    sourceInputs: [{ inputId: "worldmap.global", scope: "global" }],
    footprint: { haloChunks: 0 },
  },
  {
    schema: COMPILER_STAGE_SCHEMA,
    stageId: "base-height",
    stageVersion: "1.0.0",
    scope: "global",
    dependencies: ["worldmap"],
    sourceInputs: [],
    footprint: { haloChunks: 0 },
  },
  {
    schema: COMPILER_STAGE_SCHEMA,
    stageId: "erosion",
    stageVersion: "1.0.0",
    scope: "global",
    dependencies: ["base-height"],
    sourceInputs: [],
    footprint: { haloChunks: 0 },
  },
  {
    schema: COMPILER_STAGE_SCHEMA,
    stageId: "edit-layers",
    stageVersion: "1.0.0",
    scope: "chunk",
    dependencies: ["erosion"],
    sourceInputs: [{ inputId: "edit-layers.slice", scope: "chunk" }],
    footprint: { haloChunks: 0 },
  },
  {
    schema: COMPILER_STAGE_SCHEMA,
    stageId: "collision",
    stageVersion: "1.0.0",
    scope: "chunk",
    dependencies: ["edit-layers"],
    sourceInputs: [],
    footprint: { haloChunks: 0 },
  },
  {
    schema: COMPILER_STAGE_SCHEMA,
    stageId: "render",
    stageVersion: "1.0.0",
    scope: "chunk",
    dependencies: ["edit-layers"],
    sourceInputs: [],
    footprint: { haloChunks: 0 },
  },
]);

export function createInitialWorldCompilerGraph() {
  return createCompilerGraph(INITIAL_WORLD_COMPILER_STAGE_DEFINITIONS);
}

export const HYDROLOGY_WORLD_COMPILER_STAGE_DEFINITIONS = deepFreezeJson([
  ...INITIAL_WORLD_COMPILER_STAGE_DEFINITIONS,
  {
    schema: COMPILER_STAGE_SCHEMA,
    stageId: "hydrology-field",
    stageVersion: "1.0.0",
    scope: "global",
    dependencies: ["erosion"],
    sourceInputs: [{ inputId: "hydrology.precipitation", scope: "global" }],
    footprint: { haloChunks: 0 },
  },
]);

export function createHydrologyWorldCompilerGraph() {
  return createCompilerGraph(HYDROLOGY_WORLD_COMPILER_STAGE_DEFINITIONS);
}
