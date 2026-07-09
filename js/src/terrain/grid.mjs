import { sha256 } from "../world/sha256.mjs";

export const TERRAIN_GRID_SCHEMA = "limina.terrain-grid/v1";
export const TERRAIN_CHUNK_TOPOLOGY_SCHEMA = "limina.terrain-chunk-topology/v1";
export const TERRAIN_FIELD_TOPOLOGY_SCHEMA = "limina.terrain-field-topology/v1";
export const MIN_TERRAIN_CHUNK_SAMPLES = 3;
export const MAX_TERRAIN_CHUNK_SAMPLES = 257;
export const MAX_TERRAIN_FIELD_SAMPLES = 4097;
export const MIN_TERRAIN_CHUNK_COORD = -2147483648;
export const MAX_TERRAIN_CHUNK_COORD = 2147483647;

const GRID_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function finite(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be finite`);
  }
  return value;
}

function positiveFinite(name, value) {
  finite(name, value);
  if (!(value > 0)) throw new Error(`${name} must be > 0`);
  return value;
}

export function validateTerrainGridId(gridId) {
  if (typeof gridId !== "string" || !GRID_ID.test(gridId)) {
    throw new Error("terrain grid id must be 1-64 lowercase characters using a-z, 0-9, '.', '_' or '-'");
  }
  return gridId;
}

/** Stable fallback for a logical map whose human id may not satisfy the grid-id grammar. */
export function terrainGridIdForLogicalMap(logicalMapId) {
  if (typeof logicalMapId !== "string" || logicalMapId.length === 0) {
    throw new Error("logical map id must be a non-empty string");
  }
  return `map-${sha256(logicalMapId).slice(0, 24)}`;
}

export function validateTerrainChunkCoordinate(name, value) {
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
  if (value < MIN_TERRAIN_CHUNK_COORD || value > MAX_TERRAIN_CHUNK_COORD) {
    throw new Error(`${name} is outside the supported terrain chunk coordinate range`);
  }
  return value;
}

export function validateTerrainSeed(seed) {
  if (!Number.isSafeInteger(seed) || seed < MIN_TERRAIN_CHUNK_COORD || seed > MAX_TERRAIN_CHUNK_COORD) {
    throw new Error("terrain seed must be a signed 32-bit integer");
  }
  return seed;
}

export function validateTerrainLod(lod) {
  if (!Number.isSafeInteger(lod) || lod < 0 || lod > 31) {
    throw new Error("terrain lod must be an integer in [0, 31]");
  }
  return lod;
}

export function validateTerrainChunkSamples(samples) {
  if (!Number.isSafeInteger(samples) || samples < MIN_TERRAIN_CHUNK_SAMPLES || samples > MAX_TERRAIN_CHUNK_SAMPLES) {
    throw new Error(`terrain chunk samples must be an integer in [${MIN_TERRAIN_CHUNK_SAMPLES}, ${MAX_TERRAIN_CHUNK_SAMPLES}]`);
  }
  const intervals = samples - 1;
  if ((intervals & (intervals - 1)) !== 0) {
    throw new Error("terrain chunk samples must be a power-of-two plus one");
  }
  return samples;
}

function validateTerrainFieldSamples(name, samples) {
  if (!Number.isSafeInteger(samples) || samples < 2 || samples > MAX_TERRAIN_FIELD_SAMPLES) {
    throw new Error(`${name} must be an integer in [2, ${MAX_TERRAIN_FIELD_SAMPLES}]`);
  }
  return samples;
}

export function createTerrainGridSpec(input) {
  const gridId = validateTerrainGridId(input?.gridId);
  const origin = input?.origin;
  if (!Array.isArray(origin) || origin.length !== 2) throw new Error("terrain grid origin must be [x, z]");
  const spec = {
    schema: TERRAIN_GRID_SCHEMA,
    gridId,
    origin: [finite("terrain grid origin x", origin[0]), finite("terrain grid origin z", origin[1])],
    chunkSizeM: positiveFinite("terrain grid chunkSizeM", input.chunkSizeM),
    defaultSamples: validateTerrainChunkSamples(input.defaultSamples),
  };
  return Object.freeze({ ...spec, origin: Object.freeze(spec.origin) });
}

function validateGridSpec(grid) {
  if (grid?.schema !== TERRAIN_GRID_SCHEMA) throw new Error(`terrain grid schema must be '${TERRAIN_GRID_SCHEMA}'`);
  validateTerrainGridId(grid.gridId);
  if (!Array.isArray(grid.origin) || grid.origin.length !== 2) throw new Error("terrain grid origin must be [x, z]");
  finite("terrain grid origin x", grid.origin[0]);
  finite("terrain grid origin z", grid.origin[1]);
  positiveFinite("terrain grid chunkSizeM", grid.chunkSizeM);
  validateTerrainChunkSamples(grid.defaultSamples);
  return grid;
}

/** Stable identity for a chunk location and LOD. Source revision is deliberately absent. */
export function terrainChunkId(gridId, lod, tx, tz) {
  return `surface:${validateTerrainGridId(gridId)}:l${validateTerrainLod(lod)}:x${validateTerrainChunkCoordinate("tx", tx)}:z${validateTerrainChunkCoordinate("tz", tz)}`;
}

export function terrainChunkBounds(gridInput, tx, tz) {
  const grid = validateGridSpec(gridInput);
  const x = validateTerrainChunkCoordinate("tx", tx);
  const z = validateTerrainChunkCoordinate("tz", tz);
  const minX = grid.origin[0] + x * grid.chunkSizeM;
  const minZ = grid.origin[1] + z * grid.chunkSizeM;
  const maxX = minX + grid.chunkSizeM;
  const maxZ = minZ + grid.chunkSizeM;
  for (const [name, value] of [["minX", minX], ["minZ", minZ], ["maxX", maxX], ["maxZ", maxZ]]) {
    if (!Number.isFinite(value)) throw new Error(`terrain chunk ${name} is not representable`);
  }
  return Object.freeze({ minX, minZ, maxX, maxZ });
}

function contentHash(value) {
  return `sha256:${sha256(JSON.stringify(value))}`;
}

export function terrainChunkTopology(gridInput, input) {
  const grid = validateGridSpec(gridInput);
  const lod = validateTerrainLod(input?.lod);
  const tx = validateTerrainChunkCoordinate("tx", input?.tx);
  const tz = validateTerrainChunkCoordinate("tz", input?.tz);
  const samples = validateTerrainChunkSamples(input?.samples ?? grid.defaultSamples);
  const bounds = terrainChunkBounds(grid, tx, tz);
  const canonical = {
    schema: TERRAIN_CHUNK_TOPOLOGY_SCHEMA,
    chunkId: terrainChunkId(grid.gridId, lod, tx, tz),
    gridId: grid.gridId,
    lod,
    tx,
    tz,
    bounds,
    samples: { rows: samples, cols: samples },
  };
  return Object.freeze({
    ...canonical,
    bounds,
    samples: Object.freeze(canonical.samples),
    topologyHash: contentHash(canonical),
  });
}

/** Explicit identity for a bounded master field; prevents silent global coarsening changes. */
export function terrainFieldTopologyHash(input) {
  const gridId = validateTerrainGridId(input?.gridId);
  const bounds = input?.bounds;
  if (bounds === null || typeof bounds !== "object") throw new Error("terrain field bounds are required");
  const canonicalBounds = {
    minX: finite("terrain field minX", bounds.minX),
    minZ: finite("terrain field minZ", bounds.minZ),
    maxX: finite("terrain field maxX", bounds.maxX),
    maxZ: finite("terrain field maxZ", bounds.maxZ),
  };
  if (!(canonicalBounds.maxX > canonicalBounds.minX) || !(canonicalBounds.maxZ > canonicalBounds.minZ)) {
    throw new Error("terrain field bounds must have positive width and height");
  }
  const rows = validateTerrainFieldSamples("terrain field rows", input.rows);
  const cols = validateTerrainFieldSamples("terrain field cols", input.cols);
  return contentHash({ schema: TERRAIN_FIELD_TOPOLOGY_SCHEMA, gridId, bounds: canonicalBounds, samples: { rows, cols } });
}

/** World coordinate of one topology sample. Coarse/fine power-of-two grids share edges exactly. */
export function terrainChunkSampleXZ(topology, row, col) {
  if (topology?.schema !== TERRAIN_CHUNK_TOPOLOGY_SCHEMA) throw new Error("invalid terrain chunk topology");
  const rows = validateTerrainChunkSamples(topology.samples?.rows);
  const cols = validateTerrainChunkSamples(topology.samples?.cols);
  if (!Number.isSafeInteger(row) || row < 0 || row >= rows || !Number.isSafeInteger(col) || col < 0 || col >= cols) {
    throw new Error("terrain chunk sample index is out of range");
  }
  return [
    topology.bounds.minX + (col / (cols - 1)) * (topology.bounds.maxX - topology.bounds.minX),
    topology.bounds.minZ + (row / (rows - 1)) * (topology.bounds.maxZ - topology.bounds.minZ),
  ];
}

export function terrainChunkRangeForBounds(gridInput, bounds) {
  const grid = validateGridSpec(gridInput);
  const minX = finite("terrain domain minX", bounds?.minX);
  const minZ = finite("terrain domain minZ", bounds?.minZ);
  const maxX = finite("terrain domain maxX", bounds?.maxX);
  const maxZ = finite("terrain domain maxZ", bounds?.maxZ);
  if (!(maxX > minX) || !(maxZ > minZ)) throw new Error("terrain domain bounds must have positive width and height");
  const minTx = Math.floor((minX - grid.origin[0]) / grid.chunkSizeM);
  const minTz = Math.floor((minZ - grid.origin[1]) / grid.chunkSizeM);
  const maxTx = Math.ceil((maxX - grid.origin[0]) / grid.chunkSizeM) - 1;
  const maxTz = Math.ceil((maxZ - grid.origin[1]) / grid.chunkSizeM) - 1;
  validateTerrainChunkCoordinate("minTx", minTx);
  validateTerrainChunkCoordinate("minTz", minTz);
  validateTerrainChunkCoordinate("maxTx", maxTx);
  validateTerrainChunkCoordinate("maxTz", maxTz);
  return Object.freeze({ minTx, minTz, maxTx, maxTz });
}

export function terrainWorldToChunk(gridInput, x, z) {
  const grid = validateGridSpec(gridInput);
  const tx = Math.floor((finite("terrain world x", x) - grid.origin[0]) / grid.chunkSizeM);
  const tz = Math.floor((finite("terrain world z", z) - grid.origin[1]) / grid.chunkSizeM);
  return Object.freeze({
    tx: validateTerrainChunkCoordinate("tx", tx),
    tz: validateTerrainChunkCoordinate("tz", tz),
  });
}
