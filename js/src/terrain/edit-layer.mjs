import { sha256 } from "../world/sha256.mjs";
import {
  TERRAIN_CHUNK_TOPOLOGY_SCHEMA,
  TERRAIN_GRID_SCHEMA,
  createTerrainGridSpec,
  terrainChunkId,
  terrainChunkTopology,
  validateTerrainChunkCoordinate,
  validateTerrainGridId,
} from "./grid.mjs";

/**
 * Durable edit-layer source stores the materialized additive metre deltas produced by
 * interactive brushes, stamps, and flatten tools. Brush UI parameters are not replayed:
 * materialization is what makes the source independent of future brush implementations.
 * Flatten tools must calculate their deltas inside an exact-base authoritative transaction;
 * this artifact independently binds the spatial topology needed to replay those deltas.
 */

export const TERRAIN_EDIT_BASE_TOPOLOGY_SCHEMA = "limina.terrain-edit-base-topology/v1";
export const TERRAIN_EDIT_LAYER_SCHEMA = "limina.terrain-edit-layer/v1";
export const PREPARED_TERRAIN_EDIT_LAYERS_SCHEMA = "limina.prepared-terrain-edit-layers/v1";
export const TERRAIN_EDIT_OPERATION_KIND = "add";

export const MAX_TERRAIN_EDIT_OPERATIONS = 1_024;
export const MAX_TERRAIN_EDIT_DELTAS_PER_OPERATION = 4_096;
export const MAX_TERRAIN_EDIT_DELTAS = 65_536;
export const MAX_TERRAIN_EDIT_LAYER_BYTES = 4 * 1024 * 1024;
export const MAX_TERRAIN_EDIT_COMPOSE_LAYERS = 64;
export const MAX_TERRAIN_EDIT_COMPOSE_DELTAS = 262_144;
export const MAX_TERRAIN_EDIT_INDEX_ENTRIES = MAX_TERRAIN_EDIT_COMPOSE_DELTAS * 4;
export const MAX_TERRAIN_EDIT_DOMAIN_CHUNKS = 1_048_576;
export const MAX_TERRAIN_EDIT_DELTA_M = 10_000;
export const MAX_TERRAIN_REBASE_CONFLICT_DETAILS = 512;
export const TERRAIN_EDIT_REBASE_CONFLICT = Object.freeze({
  GRID_MISMATCH: "grid_mismatch",
  GRID_GEOMETRY_CHANGED: "grid_geometry_changed",
  COORDINATE_NOT_REPRESENTABLE: "coordinate_not_representable",
  OUTSIDE_TARGET_DOMAIN: "outside_target_domain",
});

const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PREPARED_DATA = new WeakMap();

export class TerrainEditCancelledError extends Error {
  constructor() {
    super("terrain edit operation cancelled");
    this.name = "TerrainEditCancelledError";
    this.code = "terrain_edit_cancelled";
  }
}

export class TerrainEditBaseMismatchError extends Error {
  constructor(expected, actual) {
    super(`terrain edit base topology mismatch: expected '${expected}', received '${actual}'`);
    this.name = "TerrainEditBaseMismatchError";
    this.code = "terrain_edit_base_mismatch";
    this.expected = expected;
    this.actual = actual;
  }
}

function ownDataObject(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error(`${label} must not have symbol keys`);
  const names = Object.getOwnPropertyNames(value).sort();
  const expected = [...keys].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined || descriptor?.enumerable !== true) {
      throw new Error(`${label}.${name} must be an enumerable data property`);
    }
  }
  return value;
}

function denseArray(value, maximum, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} entries`);
  const names = Object.getOwnPropertyNames(value);
  const allowed = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
  if (names.some((name) => !allowed.has(name)) || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new Error(`${label} must be a dense array without custom properties`);
  }
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor?.get !== undefined || descriptor?.set !== undefined || descriptor?.enumerable !== true) {
      throw new Error(`${label}[${index}] must be an enumerable data property`);
    }
  }
  return value;
}

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}

function identifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error(`${label} must be 1-64 lowercase characters using a-z, 0-9, '.', '_' or '-'`);
  }
  return value;
}

function contentHash(value) {
  return `sha256:${sha256(JSON.stringify(value))}`;
}

function validateContentHash(value, label) {
  if (typeof value !== "string" || !CONTENT_HASH.test(value)) throw new Error(`${label} must be a lowercase sha256 content hash`);
  return value;
}

function canonicalGrid(input) {
  ownDataObject(input, ["schema", "gridId", "origin", "chunkSizeM", "defaultSamples"], "terrain edit grid");
  if (input.schema !== TERRAIN_GRID_SCHEMA) throw new Error(`terrain edit grid schema must be '${TERRAIN_GRID_SCHEMA}'`);
  denseArray(input.origin, 2, "terrain edit grid origin");
  if (input.origin.length !== 2) throw new Error("terrain edit grid origin must contain exactly two values");
  return createTerrainGridSpec({
    gridId: input.gridId,
    origin: [finite(input.origin[0], "terrain edit grid origin x"), finite(input.origin[1], "terrain edit grid origin z")],
    chunkSizeM: finite(input.chunkSizeM, "terrain edit grid chunkSizeM"),
    defaultSamples: input.defaultSamples,
  });
}

function canonicalDomain(input) {
  ownDataObject(input, ["minTx", "minTz", "maxTx", "maxTz"], "terrain edit domain");
  const domain = {
    minTx: validateTerrainChunkCoordinate("terrain edit domain minTx", input.minTx),
    minTz: validateTerrainChunkCoordinate("terrain edit domain minTz", input.minTz),
    maxTx: validateTerrainChunkCoordinate("terrain edit domain maxTx", input.maxTx),
    maxTz: validateTerrainChunkCoordinate("terrain edit domain maxTz", input.maxTz),
  };
  if (domain.maxTx < domain.minTx || domain.maxTz < domain.minTz) throw new Error("terrain edit domain must not be inverted");
  const width = domain.maxTx - domain.minTx + 1;
  const height = domain.maxTz - domain.minTz + 1;
  if (!Number.isSafeInteger(width * height) || width * height > MAX_TERRAIN_EDIT_DOMAIN_CHUNKS) {
    throw new Error(`terrain edit domain exceeds ${MAX_TERRAIN_EDIT_DOMAIN_CHUNKS} chunks`);
  }
  return Object.freeze(domain);
}

function baseCore(grid, domain) {
  return {
    schema: TERRAIN_EDIT_BASE_TOPOLOGY_SCHEMA,
    grid: {
      schema: TERRAIN_GRID_SCHEMA,
      gridId: grid.gridId,
      origin: [grid.origin[0], grid.origin[1]],
      chunkSizeM: grid.chunkSizeM,
      defaultSamples: grid.defaultSamples,
    },
    domain: { minTx: domain.minTx, minTz: domain.minTz, maxTx: domain.maxTx, maxTz: domain.maxTz },
  };
}

function freezeBase(core, topologyHash) {
  const grid = Object.freeze({ ...core.grid, origin: Object.freeze([...core.grid.origin]) });
  return Object.freeze({
    schema: TERRAIN_EDIT_BASE_TOPOLOGY_SCHEMA,
    grid,
    domain: Object.freeze({ ...core.domain }),
    topologyHash,
  });
}

export function createTerrainEditBaseTopology(input) {
  ownDataObject(input, ["grid", "domain"], "terrain edit base topology input");
  const grid = canonicalGrid(input.grid);
  const domain = canonicalDomain(input.domain);
  const core = baseCore(grid, domain);
  return freezeBase(core, contentHash(core));
}

export function parseTerrainEditBaseTopology(input) {
  ownDataObject(input, ["schema", "grid", "domain", "topologyHash"], "terrain edit base topology");
  if (input.schema !== TERRAIN_EDIT_BASE_TOPOLOGY_SCHEMA) {
    throw new Error(`terrain edit base topology schema must be '${TERRAIN_EDIT_BASE_TOPOLOGY_SCHEMA}'`);
  }
  const parsed = createTerrainEditBaseTopology({ grid: input.grid, domain: input.domain });
  const supplied = validateContentHash(input.topologyHash, "terrain edit base topology hash");
  if (supplied !== parsed.topologyHash) throw new Error("terrain edit base topology hash does not match its canonical topology");
  return parsed;
}

function sampleBounds(base) {
  const intervals = base.grid.defaultSamples - 1;
  return {
    minGx: base.domain.minTx * intervals,
    minGz: base.domain.minTz * intervals,
    maxGx: (base.domain.maxTx + 1) * intervals,
    maxGz: (base.domain.maxTz + 1) * intervals,
  };
}

function canonicalDelta(input, base, label) {
  ownDataObject(input, ["gx", "gz", "deltaM"], label);
  if (!Number.isSafeInteger(input.gx) || !Number.isSafeInteger(input.gz)) throw new Error(`${label} coordinates must be safe integers`);
  const bounds = sampleBounds(base);
  if (input.gx < bounds.minGx || input.gx > bounds.maxGx || input.gz < bounds.minGz || input.gz > bounds.maxGz) {
    throw new Error(`${label} is outside the base topology domain`);
  }
  const deltaM = finite(input.deltaM, `${label} deltaM`);
  if (deltaM === 0 || Math.abs(deltaM) > MAX_TERRAIN_EDIT_DELTA_M) {
    throw new Error(`${label} deltaM must be non-zero and within +/-${MAX_TERRAIN_EDIT_DELTA_M}m`);
  }
  return { gx: input.gx, gz: input.gz, deltaM };
}

function compareDeltas(a, b) {
  return a.gz - b.gz || a.gx - b.gx;
}

function layerCore(layerId, baseTopology, operations) {
  return {
    schema: TERRAIN_EDIT_LAYER_SCHEMA,
    layerId,
    gridId: baseTopology.grid.gridId,
    baseTopology,
    operations,
  };
}

function wireBase(base) {
  return {
    schema: base.schema,
    grid: {
      schema: base.grid.schema,
      gridId: base.grid.gridId,
      origin: [base.grid.origin[0], base.grid.origin[1]],
      chunkSizeM: base.grid.chunkSizeM,
      defaultSamples: base.grid.defaultSamples,
    },
    domain: { ...base.domain },
    topologyHash: base.topologyHash,
  };
}

function freezeLayer(core, hash) {
  const operations = core.operations.map((operation) => Object.freeze({
    operationId: operation.operationId,
    kind: TERRAIN_EDIT_OPERATION_KIND,
    deltas: Object.freeze(operation.deltas.map((delta) => Object.freeze({ ...delta }))),
  }));
  return Object.freeze({
    schema: TERRAIN_EDIT_LAYER_SCHEMA,
    layerId: core.layerId,
    gridId: core.gridId,
    baseTopology: core.baseTopology,
    operations: Object.freeze(operations),
    contentHash: hash,
  });
}

function canonicalOperations(input, base, requireCanonicalOrder) {
  denseArray(input, MAX_TERRAIN_EDIT_OPERATIONS, "terrain edit operations");
  const operationIds = new Set();
  let deltaCount = 0;
  return input.map((operation, operationIndex) => {
    const label = `terrain edit operation ${operationIndex}`;
    ownDataObject(operation, ["operationId", "kind", "deltas"], label);
    const operationId = identifier(operation.operationId, `${label} id`);
    if (operationIds.has(operationId)) throw new Error(`duplicate terrain edit operation id '${operationId}'`);
    operationIds.add(operationId);
    if (operation.kind !== TERRAIN_EDIT_OPERATION_KIND) throw new Error(`${label} kind must be '${TERRAIN_EDIT_OPERATION_KIND}'`);
    denseArray(operation.deltas, MAX_TERRAIN_EDIT_DELTAS_PER_OPERATION, `${label} deltas`);
    if (operation.deltas.length === 0) throw new Error(`${label} must contain at least one delta`);
    deltaCount += operation.deltas.length;
    if (deltaCount > MAX_TERRAIN_EDIT_DELTAS) throw new Error(`terrain edit layer exceeds ${MAX_TERRAIN_EDIT_DELTAS} deltas`);
    const deltas = operation.deltas.map((delta, deltaIndex) => canonicalDelta(delta, base, `${label} delta ${deltaIndex}`));
    if (requireCanonicalOrder) {
      for (let index = 1; index < deltas.length; index++) {
        if (compareDeltas(deltas[index - 1], deltas[index]) >= 0) {
          throw new Error(`${label} deltas must be strictly ordered by gz then gx without duplicates`);
        }
      }
    } else {
      deltas.sort(compareDeltas);
      for (let index = 1; index < deltas.length; index++) {
        if (compareDeltas(deltas[index - 1], deltas[index]) === 0) throw new Error(`${label} contains duplicate sample coordinates`);
      }
    }
    return { operationId, kind: TERRAIN_EDIT_OPERATION_KIND, deltas };
  });
}

function canonicalLayerBytes(core, hash) {
  return JSON.stringify({
    schema: core.schema,
    layerId: core.layerId,
    gridId: core.gridId,
    baseTopology: wireBase(core.baseTopology),
    operations: core.operations,
    ...(hash === undefined ? {} : { contentHash: hash }),
  });
}

export function createTerrainEditLayer(input) {
  ownDataObject(input, ["layerId", "baseTopology", "operations"], "terrain edit layer input");
  const layerId = identifier(input.layerId, "terrain edit layer id");
  const baseTopology = parseTerrainEditBaseTopology(input.baseTopology);
  const operations = canonicalOperations(input.operations, baseTopology, false);
  const core = layerCore(layerId, baseTopology, operations);
  const hash = `sha256:${sha256(canonicalLayerBytes(core))}`;
  const bytes = canonicalLayerBytes(core, hash);
  if (bytes.length > MAX_TERRAIN_EDIT_LAYER_BYTES) throw new Error(`terrain edit layer exceeds ${MAX_TERRAIN_EDIT_LAYER_BYTES} bytes`);
  return freezeLayer(core, hash);
}

export function parseTerrainEditLayer(input) {
  ownDataObject(input, ["schema", "layerId", "gridId", "baseTopology", "operations", "contentHash"], "terrain edit layer");
  if (input.schema !== TERRAIN_EDIT_LAYER_SCHEMA) throw new Error(`terrain edit layer schema must be '${TERRAIN_EDIT_LAYER_SCHEMA}'`);
  const layerId = identifier(input.layerId, "terrain edit layer id");
  const baseTopology = parseTerrainEditBaseTopology(input.baseTopology);
  const gridId = validateTerrainGridId(input.gridId);
  if (gridId !== baseTopology.grid.gridId) throw new Error("terrain edit layer gridId does not match its base topology");
  const operations = canonicalOperations(input.operations, baseTopology, true);
  const core = layerCore(layerId, baseTopology, operations);
  const expectedHash = `sha256:${sha256(canonicalLayerBytes(core))}`;
  const suppliedHash = validateContentHash(input.contentHash, "terrain edit layer content hash");
  if (suppliedHash !== expectedHash) throw new Error("terrain edit layer content hash does not match its canonical content");
  const bytes = canonicalLayerBytes(core, suppliedHash);
  if (bytes.length > MAX_TERRAIN_EDIT_LAYER_BYTES) throw new Error(`terrain edit layer exceeds ${MAX_TERRAIN_EDIT_LAYER_BYTES} bytes`);
  return freezeLayer(core, suppliedHash);
}

export function canonicalTerrainEditLayer(input) {
  const layer = parseTerrainEditLayer(input);
  const core = layerCore(layer.layerId, layer.baseTopology, layer.operations);
  return canonicalLayerBytes(core, layer.contentHash);
}

function checkpoint(shouldCancel, work) {
  if ((work & 1023) === 0 && shouldCancel?.()) throw new TerrainEditCancelledError();
}

function ownedChunkCoordinates(globalSample, intervals, minimumChunk, maximumChunk) {
  const primary = Math.floor(globalSample / intervals);
  const candidates = globalSample % intervals === 0 ? [primary - 1, primary] : [primary];
  return candidates.filter((coordinate) => coordinate >= minimumChunk && coordinate <= maximumChunk);
}

function preparedData(prepared) {
  const data = PREPARED_DATA.get(prepared);
  if (data === undefined) throw new Error("prepared terrain edit layers were not created by prepareTerrainEditLayers");
  return data;
}

/**
 * Build a compiler-session spatial index once, then reuse it for every affected chunk.
 * Shared-edge samples are indexed into every owning chunk; bucket insertion order is
 * layer -> operation -> canonical sparse delta, exactly matching source composition.
 */
export function prepareTerrainEditLayers(input, options = {}) {
  ownDataObject(input, ["baseTopology", "layers"], "terrain edit preparation input");
  const base = parseTerrainEditBaseTopology(input.baseTopology);
  denseArray(input.layers, MAX_TERRAIN_EDIT_COMPOSE_LAYERS, "terrain edit preparation layers");
  if (options.shouldCancel !== undefined && typeof options.shouldCancel !== "function") throw new Error("terrain edit shouldCancel must be a function");
  if (options.shouldCancel?.()) throw new TerrainEditCancelledError();

  const layers = [];
  let sourceDeltaCount = 0;
  for (const layerInput of input.layers) {
    const layer = parseTerrainEditLayer(layerInput);
    if (layer.baseTopology.topologyHash !== base.topologyHash) {
      throw new TerrainEditBaseMismatchError(base.topologyHash, layer.baseTopology.topologyHash);
    }
    for (const operation of layer.operations) sourceDeltaCount += operation.deltas.length;
    if (sourceDeltaCount > MAX_TERRAIN_EDIT_COMPOSE_DELTAS) {
      throw new Error(`terrain edit preparation exceeds ${MAX_TERRAIN_EDIT_COMPOSE_DELTAS} source deltas`);
    }
    layers.push(layer);
  }

  const intervals = base.grid.defaultSamples - 1;
  const chunks = new Map();
  let indexedDeltaCount = 0;
  let work = 0;
  for (const layer of layers) {
    for (const operation of layer.operations) {
      for (const delta of operation.deltas) {
        checkpoint(options.shouldCancel, work++);
        const ownersX = ownedChunkCoordinates(delta.gx, intervals, base.domain.minTx, base.domain.maxTx);
        const ownersZ = ownedChunkCoordinates(delta.gz, intervals, base.domain.minTz, base.domain.maxTz);
        const entry = Object.freeze({ gx: delta.gx, gz: delta.gz, deltaM: delta.deltaM });
        for (const tz of ownersZ) {
          for (const tx of ownersX) {
            const chunkId = terrainChunkId(base.grid.gridId, 0, tx, tz);
            let bucket = chunks.get(chunkId);
            if (bucket === undefined) {
              bucket = [];
              chunks.set(chunkId, bucket);
            }
            bucket.push(entry);
            indexedDeltaCount++;
            if (indexedDeltaCount > MAX_TERRAIN_EDIT_INDEX_ENTRIES) {
              throw new Error(`terrain edit spatial index exceeds ${MAX_TERRAIN_EDIT_INDEX_ENTRIES} entries`);
            }
          }
        }
      }
    }
  }
  if (options.shouldCancel?.()) throw new TerrainEditCancelledError();
  for (const [chunkId, bucket] of chunks) chunks.set(chunkId, Object.freeze(bucket));

  const prepared = Object.freeze({
    schema: PREPARED_TERRAIN_EDIT_LAYERS_SCHEMA,
    gridId: base.grid.gridId,
    baseTopologyHash: base.topologyHash,
    sourceDeltaCount,
    indexedDeltaCount,
    indexedChunkCount: chunks.size,
    layerHashes: Object.freeze(layers.map((layer) => layer.contentHash)),
  });
  PREPARED_DATA.set(prepared, Object.freeze({ base, chunks }));
  return prepared;
}

function validateComposeTopology(base, topology) {
  if (topology?.schema !== TERRAIN_CHUNK_TOPOLOGY_SCHEMA) throw new Error("terrain edit composition requires a terrain chunk topology");
  if (topology.lod !== 0) throw new Error("terrain edit source layers compose only at lod 0");
  const expected = terrainChunkTopology(base.grid, {
    lod: topology.lod,
    tx: topology.tx,
    tz: topology.tz,
    samples: base.grid.defaultSamples,
  });
  if (topology.topologyHash !== expected.topologyHash) throw new Error("terrain edit chunk topology is not canonical for the base grid");
  if (topology.tx < base.domain.minTx || topology.tx > base.domain.maxTx || topology.tz < base.domain.minTz || topology.tz > base.domain.maxTz) {
    throw new Error("terrain edit chunk is outside the base topology domain");
  }
  return expected;
}

/** Compose a prepared source-lattice index over LOD0 world-metre heights. */
export function composePreparedTerrainEditLayers(input, options = {}) {
  ownDataObject(input, ["baseTopology", "chunkTopology", "baseHeightsM", "preparedLayers"], "prepared terrain edit composition input");
  const base = parseTerrainEditBaseTopology(input.baseTopology);
  const chunk = validateComposeTopology(base, input.chunkTopology);
  if (!(input.baseHeightsM instanceof Float32Array)) throw new Error("terrain edit baseHeightsM must be a world-metre Float32Array");
  const sampleCount = base.grid.defaultSamples * base.grid.defaultSamples;
  if (input.baseHeightsM.length !== sampleCount) throw new Error(`terrain edit baseHeightsM must contain exactly ${sampleCount} world-metre samples`);
  for (let index = 0; index < input.baseHeightsM.length; index++) {
    if (!Number.isFinite(input.baseHeightsM[index])) throw new Error(`terrain edit baseHeightsM sample ${index} must be finite`);
  }
  if (options.shouldCancel !== undefined && typeof options.shouldCancel !== "function") throw new Error("terrain edit shouldCancel must be a function");
  if (options.shouldCancel?.()) throw new TerrainEditCancelledError();
  const prepared = preparedData(input.preparedLayers);
  if (input.preparedLayers.baseTopologyHash !== base.topologyHash || prepared.base.topologyHash !== base.topologyHash) {
    throw new TerrainEditBaseMismatchError(base.topologyHash, input.preparedLayers.baseTopologyHash);
  }

  const heightsM = new Float32Array(input.baseHeightsM);
  const intervals = base.grid.defaultSamples - 1;
  const minGx = chunk.tx * intervals;
  const minGz = chunk.tz * intervals;
  const bucket = prepared.chunks.get(chunk.chunkId) ?? [];
  let work = 0;
  let appliedDeltaCount = 0;
  for (const delta of bucket) {
    checkpoint(options.shouldCancel, work++);
    const col = delta.gx - minGx;
    const row = delta.gz - minGz;
    if (col < 0 || col > intervals || row < 0 || row > intervals) throw new Error("prepared terrain edit index contains an invalid chunk owner");
    const index = row * base.grid.defaultSamples + col;
    const composedHeightM = Math.fround(heightsM[index] + delta.deltaM);
    if (!Number.isFinite(composedHeightM)) throw new Error(`terrain edit composed height ${index} is not finite`);
    heightsM[index] = composedHeightM;
    appliedDeltaCount++;
  }
  if (options.shouldCancel?.()) throw new TerrainEditCancelledError();
  return Object.freeze({
    heightsM,
    appliedDeltaCount,
    inspectedDeltaCount: bucket.length,
    sourceDeltaCount: input.preparedLayers.sourceDeltaCount,
    layerHashes: input.preparedLayers.layerHashes,
  });
}

/** Convenience for one chunk. Compiler sessions should prepare once and reuse the index. */
export function composeTerrainEditLayers(input, options = {}) {
  ownDataObject(input, ["baseTopology", "chunkTopology", "baseHeightsM", "layers"], "terrain edit composition input");
  const preparedLayers = prepareTerrainEditLayers({ baseTopology: input.baseTopology, layers: input.layers }, options);
  return composePreparedTerrainEditLayers({
    baseTopology: input.baseTopology,
    chunkTopology: input.chunkTopology,
    baseHeightsM: input.baseHeightsM,
    preparedLayers,
  }, options);
}

function sameGridGeometry(source, target) {
  return source.grid.origin[0] === target.grid.origin[0]
    && source.grid.origin[1] === target.grid.origin[1]
    && source.grid.chunkSizeM === target.grid.chunkSizeM;
}

function rebaseReport(source, target, operationCount, deltaCount, mappedDeltaCount, conflictCount) {
  return Object.freeze({
    exact: conflictCount === 0,
    fromTopologyHash: source.topologyHash,
    toTopologyHash: target.topologyHash,
    operationCount,
    deltaCount,
    mappedDeltaCount,
    conflictCount,
    conflictDetailsTruncated: conflictCount > MAX_TERRAIN_REBASE_CONFLICT_DETAILS,
  });
}

export function rebaseTerrainEditLayer(input, targetBaseInput, options = {}) {
  if (options.shouldCancel !== undefined && typeof options.shouldCancel !== "function") throw new Error("terrain edit shouldCancel must be a function");
  if (options.shouldCancel?.()) throw new TerrainEditCancelledError();
  const layer = parseTerrainEditLayer(input);
  const source = layer.baseTopology;
  const target = parseTerrainEditBaseTopology(targetBaseInput);
  const deltaCount = layer.operations.reduce((total, operation) => total + operation.deltas.length, 0);
  const conflicts = [];
  let conflictCount = 0;
  const addConflict = (conflict) => {
    conflictCount++;
    if (conflicts.length < MAX_TERRAIN_REBASE_CONFLICT_DETAILS) conflicts.push(Object.freeze(conflict));
  };

  if (source.grid.gridId !== target.grid.gridId) {
    addConflict({ code: TERRAIN_EDIT_REBASE_CONFLICT.GRID_MISMATCH, message: `grid '${source.grid.gridId}' cannot rebase onto '${target.grid.gridId}'` });
  } else if (!sameGridGeometry(source, target)) {
    addConflict({ code: TERRAIN_EDIT_REBASE_CONFLICT.GRID_GEOMETRY_CHANGED, message: "grid origin or chunk size changed; exact coordinate preservation is unavailable" });
  }
  if (conflictCount !== 0) {
    return Object.freeze({
      ok: false,
      conflicts: Object.freeze(conflicts),
      report: rebaseReport(source, target, layer.operations.length, deltaCount, 0, conflictCount),
    });
  }

  const sourceIntervals = source.grid.defaultSamples - 1;
  const targetIntervals = target.grid.defaultSamples - 1;
  const targetBounds = sampleBounds(target);
  let work = 0;
  let mappedDeltaCount = 0;
  const mappedOperations = layer.operations.map((operation) => {
    const mapped = [];
    for (const delta of operation.deltas) {
      checkpoint(options.shouldCancel, work++);
      const gxNumerator = delta.gx * targetIntervals;
      const gzNumerator = delta.gz * targetIntervals;
      if (!Number.isSafeInteger(gxNumerator) || !Number.isSafeInteger(gzNumerator)
        || gxNumerator % sourceIntervals !== 0 || gzNumerator % sourceIntervals !== 0) {
        addConflict({
          code: TERRAIN_EDIT_REBASE_CONFLICT.COORDINATE_NOT_REPRESENTABLE,
          operationId: operation.operationId,
          gx: delta.gx,
          gz: delta.gz,
          message: "edited sample does not land exactly on the target lattice",
        });
        continue;
      }
      const gx = gxNumerator / sourceIntervals;
      const gz = gzNumerator / sourceIntervals;
      if (gx < targetBounds.minGx || gx > targetBounds.maxGx || gz < targetBounds.minGz || gz > targetBounds.maxGz) {
        addConflict({
          code: TERRAIN_EDIT_REBASE_CONFLICT.OUTSIDE_TARGET_DOMAIN,
          operationId: operation.operationId,
          gx: delta.gx,
          gz: delta.gz,
          targetGx: gx,
          targetGz: gz,
          message: "edited sample is outside the target topology domain",
        });
        continue;
      }
      mapped.push({ gx, gz, deltaM: delta.deltaM });
      mappedDeltaCount++;
    }
    return { operationId: operation.operationId, kind: TERRAIN_EDIT_OPERATION_KIND, deltas: mapped };
  });
  if (options.shouldCancel?.()) throw new TerrainEditCancelledError();
  if (conflictCount !== 0) {
    return Object.freeze({
      ok: false,
      conflicts: Object.freeze(conflicts),
      report: rebaseReport(source, target, layer.operations.length, deltaCount, mappedDeltaCount, conflictCount),
    });
  }
  const rebasedLayer = createTerrainEditLayer({ layerId: layer.layerId, baseTopology: target, operations: mappedOperations });
  return Object.freeze({
    ok: true,
    layer: rebasedLayer,
    report: rebaseReport(source, target, layer.operations.length, deltaCount, mappedDeltaCount, 0),
  });
}
