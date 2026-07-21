import { sha256 } from "../world/sha256.mjs";
import {
  TERRAIN_CHUNK_TOPOLOGY_SCHEMA,
  terrainChunkId,
  terrainChunkTopology,
} from "./grid.mjs";
import {
  MAX_TERRAIN_REBASE_CONFLICT_DETAILS,
  TERRAIN_EDIT_REBASE_CONFLICT,
  TerrainEditBaseMismatchError,
  TerrainEditCancelledError,
  parseTerrainEditBaseTopology,
} from "./edit-layer.mjs";

/**
 * Durable paint-layer source stores the materialized material/weight stamps produced by
 * terrain.paint on derived terrain, sibling to the heights-only edit layer (edit-layer.mjs).
 * OVERLAP SEMANTICS (ordered additive clamp — the ONLY semantics that reproduce
 * terrain.paint on EditableTerrain): each stamp contributes a SIGNED weight delta per
 * lattice sample (erase = negative). Composition applies ops in layer -> operation ->
 * canonical delta order, clamping into [0,1] after EVERY application, because the
 * EditableTerrain brush blends strength into a persistent per-vertex weight. Paint
 * (material !== "none") sets the material id unconditionally; erase ("none") keeps the
 * id unless the clamped weight reaches 0. A zero-weight delta is still meaningful:
 * paint-at-zero sets the material id, erase-at-zero clears it where weight is already 0
 * — both mirror applyBrushPaint's zero-strength side effects, so the differential gate
 * can require byte equality, not approximation. Deltas at DIFFERENT lattice keys commute
 * (disjoint channels); only the per-key application order is load-bearing.
 */

export const TERRAIN_PAINT_LAYER_SCHEMA = "limina.terrain-paint-layer/v1";
export const PREPARED_TERRAIN_PAINT_LAYERS_SCHEMA = "limina.prepared-terrain-paint-layers/v1";
export const PREPARED_TERRAIN_PAINT_CHUNK_SLICES_SCHEMA = "limina.prepared-terrain-paint-chunk-slices/v1";
export const TERRAIN_PAINT_ERASE_MATERIAL = "none";
/** Canonical material ids — MUST match TERRAIN_PAINT_ALBEDO_HEX order in material-palette.ts
 *  (id 0 is unpainted). terrain.paint and the compiler both key off this table. */
export const TERRAIN_PAINT_MATERIAL_IDS = Object.freeze({
  sand: 1,
  grass: 2,
  rock: 3,
  dirt: 4,
  snow: 5,
  murk: 6,
  tundra: 7,
});

export const MAX_TERRAIN_PAINT_OPERATIONS = 1_024;
export const MAX_TERRAIN_PAINT_DELTAS_PER_OPERATION = 4_096;
export const MAX_TERRAIN_PAINT_DELTAS = 65_536;
export const MAX_TERRAIN_PAINT_LAYER_BYTES = 4 * 1024 * 1024;
export const MAX_TERRAIN_PAINT_COMPOSE_LAYERS = 64;
export const MAX_TERRAIN_PAINT_COMPOSE_DELTAS = 262_144;
export const MAX_TERRAIN_PAINT_INDEX_ENTRIES = MAX_TERRAIN_PAINT_COMPOSE_DELTAS * 4;
export const MAX_TERRAIN_PAINT_WEIGHT = 1_024;

const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PREPARED_DATA = new WeakMap();

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

function paintMaterial(value, label) {
  if (value === TERRAIN_PAINT_ERASE_MATERIAL) return value;
  if (typeof value !== "string" || !Object.hasOwn(TERRAIN_PAINT_MATERIAL_IDS, value)) {
    throw new Error(`${label} must be 'none' or one of: ${Object.keys(TERRAIN_PAINT_MATERIAL_IDS).join(", ")}`);
  }
  return value;
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
  ownDataObject(input, ["gx", "gz", "material", "weight"], label);
  if (!Number.isSafeInteger(input.gx) || !Number.isSafeInteger(input.gz)) throw new Error(`${label} coordinates must be safe integers`);
  const bounds = sampleBounds(base);
  if (input.gx < bounds.minGx || input.gx > bounds.maxGx || input.gz < bounds.minGz || input.gz > bounds.maxGz) {
    throw new Error(`${label} is outside the base topology domain`);
  }
  const material = paintMaterial(input.material, `${label} material`);
  const weight = finite(input.weight, `${label} weight`);
  if (Math.abs(weight) > MAX_TERRAIN_PAINT_WEIGHT) {
    throw new Error(`${label} weight must be within +/-${MAX_TERRAIN_PAINT_WEIGHT}`);
  }
  // The material field IS the branch marker: paint ids carry a non-negative blend delta,
  // 'none' carries a non-positive erase delta. Sign/branch disagreement is non-canonical.
  if (material === TERRAIN_PAINT_ERASE_MATERIAL ? weight > 0 : weight < 0) {
    throw new Error(`${label} weight sign does not match its material branch`);
  }
  return { gx: input.gx, gz: input.gz, material, weight };
}

function compareDeltas(a, b) {
  return a.gz - b.gz || a.gx - b.gx;
}

function layerCore(layerId, baseTopology, operations) {
  return {
    schema: TERRAIN_PAINT_LAYER_SCHEMA,
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
    deltas: Object.freeze(operation.deltas.map((delta) => Object.freeze({ ...delta }))),
  }));
  return Object.freeze({
    schema: TERRAIN_PAINT_LAYER_SCHEMA,
    layerId: core.layerId,
    gridId: core.gridId,
    baseTopology: core.baseTopology,
    operations: Object.freeze(operations),
    contentHash: hash,
  });
}

function canonicalOperations(input, base, requireCanonicalOrder) {
  denseArray(input, MAX_TERRAIN_PAINT_OPERATIONS, "terrain paint operations");
  const operationIds = new Set();
  let deltaCount = 0;
  return input.map((operation, operationIndex) => {
    const label = `terrain paint operation ${operationIndex}`;
    ownDataObject(operation, ["operationId", "deltas"], label);
    const operationId = identifier(operation.operationId, `${label} id`);
    if (operationIds.has(operationId)) throw new Error(`duplicate terrain paint operation id '${operationId}'`);
    operationIds.add(operationId);
    denseArray(operation.deltas, MAX_TERRAIN_PAINT_DELTAS_PER_OPERATION, `${label} deltas`);
    if (operation.deltas.length === 0) throw new Error(`${label} must contain at least one delta`);
    deltaCount += operation.deltas.length;
    if (deltaCount > MAX_TERRAIN_PAINT_DELTAS) throw new Error(`terrain paint layer exceeds ${MAX_TERRAIN_PAINT_DELTAS} deltas`);
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
    return { operationId, deltas };
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

export function createTerrainPaintLayer(input) {
  ownDataObject(input, ["layerId", "baseTopology", "operations"], "terrain paint layer input");
  const layerId = identifier(input.layerId, "terrain paint layer id");
  const baseTopology = parseTerrainEditBaseTopology(input.baseTopology);
  const operations = canonicalOperations(input.operations, baseTopology, false);
  const core = layerCore(layerId, baseTopology, operations);
  const hash = `sha256:${sha256(canonicalLayerBytes(core))}`;
  const bytes = canonicalLayerBytes(core, hash);
  if (bytes.length > MAX_TERRAIN_PAINT_LAYER_BYTES) throw new Error(`terrain paint layer exceeds ${MAX_TERRAIN_PAINT_LAYER_BYTES} bytes`);
  return freezeLayer(core, hash);
}

export function parseTerrainPaintLayer(input) {
  ownDataObject(input, ["schema", "layerId", "gridId", "baseTopology", "operations", "contentHash"], "terrain paint layer");
  if (input.schema !== TERRAIN_PAINT_LAYER_SCHEMA) throw new Error(`terrain paint layer schema must be '${TERRAIN_PAINT_LAYER_SCHEMA}'`);
  const layerId = identifier(input.layerId, "terrain paint layer id");
  const baseTopology = parseTerrainEditBaseTopology(input.baseTopology);
  if (input.gridId !== baseTopology.grid.gridId) throw new Error("terrain paint layer gridId does not match its base topology");
  const operations = canonicalOperations(input.operations, baseTopology, true);
  const core = layerCore(layerId, baseTopology, operations);
  const expectedHash = `sha256:${sha256(canonicalLayerBytes(core))}`;
  const suppliedHash = validateContentHash(input.contentHash, "terrain paint layer content hash");
  if (suppliedHash !== expectedHash) throw new Error("terrain paint layer content hash does not match its canonical content");
  const bytes = canonicalLayerBytes(core, suppliedHash);
  if (bytes.length > MAX_TERRAIN_PAINT_LAYER_BYTES) throw new Error(`terrain paint layer exceeds ${MAX_TERRAIN_PAINT_LAYER_BYTES} bytes`);
  return freezeLayer(core, suppliedHash);
}

export function canonicalTerrainPaintLayer(input) {
  const layer = parseTerrainPaintLayer(input);
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
  if (data === undefined) throw new Error("prepared terrain paint layers were not created by prepareTerrainPaintLayers");
  return data;
}

/**
 * Build a compiler-session spatial index once, then reuse it for every affected chunk.
 * Shared-edge samples are indexed into every owning chunk; bucket insertion order is
 * layer -> operation -> canonical sparse delta, exactly matching source composition.
 */
export function prepareTerrainPaintLayers(input, options = {}) {
  ownDataObject(input, ["baseTopology", "layers"], "terrain paint preparation input");
  const base = parseTerrainEditBaseTopology(input.baseTopology);
  denseArray(input.layers, MAX_TERRAIN_PAINT_COMPOSE_LAYERS, "terrain paint preparation layers");
  if (options.shouldCancel !== undefined && typeof options.shouldCancel !== "function") throw new Error("terrain paint shouldCancel must be a function");
  if (options.shouldCancel?.()) throw new TerrainEditCancelledError();

  const layers = [];
  let sourceDeltaCount = 0;
  for (const layerInput of input.layers) {
    const layer = parseTerrainPaintLayer(layerInput);
    if (layer.baseTopology.topologyHash !== base.topologyHash) {
      throw new TerrainEditBaseMismatchError(base.topologyHash, layer.baseTopology.topologyHash);
    }
    for (const operation of layer.operations) sourceDeltaCount += operation.deltas.length;
    if (sourceDeltaCount > MAX_TERRAIN_PAINT_COMPOSE_DELTAS) {
      throw new Error(`terrain paint preparation exceeds ${MAX_TERRAIN_PAINT_COMPOSE_DELTAS} source deltas`);
    }
    layers.push(layer);
  }

  const intervals = base.grid.defaultSamples - 1;
  const chunks = new Map();
  let indexedDeltaCount = 0;
  let work = 0;
  for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
    const layer = layers[layerIndex];
    for (let operationIndex = 0; operationIndex < layer.operations.length; operationIndex++) {
      const operation = layer.operations[operationIndex];
      for (const delta of operation.deltas) {
        checkpoint(options.shouldCancel, work++);
        const ownersX = ownedChunkCoordinates(delta.gx, intervals, base.domain.minTx, base.domain.maxTx);
        const ownersZ = ownedChunkCoordinates(delta.gz, intervals, base.domain.minTz, base.domain.maxTz);
        const entry = Object.freeze({
          layerIndex,
          operationIndex,
          operationId: operation.operationId,
          gx: delta.gx,
          gz: delta.gz,
          material: delta.material,
          weight: delta.weight,
        });
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
            if (indexedDeltaCount > MAX_TERRAIN_PAINT_INDEX_ENTRIES) {
              throw new Error(`terrain paint spatial index exceeds ${MAX_TERRAIN_PAINT_INDEX_ENTRIES} entries`);
            }
          }
        }
      }
    }
  }
  if (options.shouldCancel?.()) throw new TerrainEditCancelledError();
  for (const [chunkId, bucket] of chunks) chunks.set(chunkId, Object.freeze(bucket));

  const prepared = Object.freeze({
    schema: PREPARED_TERRAIN_PAINT_LAYERS_SCHEMA,
    gridId: base.grid.gridId,
    baseTopologyHash: base.topologyHash,
    sourceDeltaCount,
    indexedDeltaCount,
    indexedChunkCount: chunks.size,
    layerHashes: Object.freeze(layers.map((layer) => layer.contentHash)),
  });
  PREPARED_DATA.set(prepared, Object.freeze({ base, chunks, layers: Object.freeze(layers) }));
  return prepared;
}

function validateComposeTopology(base, topology) {
  if (topology?.schema !== TERRAIN_CHUNK_TOPOLOGY_SCHEMA) throw new Error("terrain paint composition requires a terrain chunk topology");
  if (topology.lod !== 0) throw new Error("terrain paint source layers compose only at lod 0");
  const expected = terrainChunkTopology(base.grid, {
    lod: topology.lod,
    tx: topology.tx,
    tz: topology.tz,
    samples: base.grid.defaultSamples,
  });
  if (topology.topologyHash !== expected.topologyHash) throw new Error("terrain paint chunk topology is not canonical for the base grid");
  if (topology.tx < base.domain.minTx || topology.tx > base.domain.maxTx || topology.tz < base.domain.minTz || topology.tz > base.domain.maxTz) {
    throw new Error("terrain paint chunk is outside the base topology domain");
  }
  return expected;
}

function validateBaseChannels(input, sampleCount) {
  if (!(input.basePaintMat instanceof Uint8Array)) throw new Error("terrain paint basePaintMat must be a Uint8Array");
  if (input.basePaintMat.length !== sampleCount) throw new Error(`terrain paint basePaintMat must contain exactly ${sampleCount} samples`);
  if (!(input.basePaintW instanceof Float32Array)) throw new Error("terrain paint basePaintW must be a Float32Array");
  if (input.basePaintW.length !== sampleCount) throw new Error(`terrain paint basePaintW must contain exactly ${sampleCount} samples`);
  for (let index = 0; index < sampleCount; index++) {
    if (!Number.isFinite(input.basePaintW[index])) throw new Error(`terrain paint basePaintW sample ${index} must be finite`);
  }
}

/** Compose a prepared paint index over one chunk's biome-rasterized paint channels.
 *  The arithmetic mirrors applyBrushPaint on EditableTerrain bit-for-bit (Float32Array
 *  store rounds each application; clamp after each op), so a materialized stamp produces
 *  the same bytes the live brush would. Chunks with no indexed deltas pass the ORIGINAL
 *  channel arrays through untouched — their encoded artifacts stay byte-identical, which
 *  is what content-delta activation keys on. */
export function composePreparedTerrainPaintLayers(input, options = {}) {
  ownDataObject(input, ["baseTopology", "chunkTopology", "basePaintMat", "basePaintW", "preparedLayers"], "prepared terrain paint composition input");
  const base = parseTerrainEditBaseTopology(input.baseTopology);
  const chunk = validateComposeTopology(base, input.chunkTopology);
  const sampleCount = base.grid.defaultSamples * base.grid.defaultSamples;
  validateBaseChannels(input, sampleCount);
  if (options.shouldCancel !== undefined && typeof options.shouldCancel !== "function") throw new Error("terrain paint shouldCancel must be a function");
  if (options.shouldCancel?.()) throw new TerrainEditCancelledError();
  const prepared = preparedData(input.preparedLayers);
  if (input.preparedLayers.baseTopologyHash !== base.topologyHash || prepared.base.topologyHash !== base.topologyHash) {
    throw new TerrainEditBaseMismatchError(base.topologyHash, input.preparedLayers.baseTopologyHash);
  }

  const bucket = prepared.chunks.get(chunk.chunkId) ?? [];
  if (bucket.length === 0) {
    return Object.freeze({
      paintMat: input.basePaintMat,
      paintW: input.basePaintW,
      appliedDeltaCount: 0,
      inspectedDeltaCount: 0,
      sourceDeltaCount: input.preparedLayers.sourceDeltaCount,
      layerHashes: input.preparedLayers.layerHashes,
    });
  }
  const paintMat = new Uint8Array(input.basePaintMat);
  const paintW = new Float32Array(input.basePaintW);
  const intervals = base.grid.defaultSamples - 1;
  const minGx = chunk.tx * intervals;
  const minGz = chunk.tz * intervals;
  let work = 0;
  for (const delta of bucket) {
    checkpoint(options.shouldCancel, work++);
    const col = delta.gx - minGx;
    const row = delta.gz - minGz;
    if (col < 0 || col > intervals || row < 0 || row > intervals) throw new Error("prepared terrain paint index contains an invalid chunk owner");
    const index = row * base.grid.defaultSamples + col;
    if (delta.material === TERRAIN_PAINT_ERASE_MATERIAL) {
      const weight = Math.max(0, paintW[index] + delta.weight);
      paintW[index] = weight;
      if (weight <= 0) paintMat[index] = 0;
    } else {
      paintMat[index] = TERRAIN_PAINT_MATERIAL_IDS[delta.material];
      paintW[index] = Math.min(1, paintW[index] + delta.weight);
    }
  }
  if (options.shouldCancel?.()) throw new TerrainEditCancelledError();
  return Object.freeze({
    paintMat,
    paintW,
    appliedDeltaCount: bucket.length,
    inspectedDeltaCount: bucket.length,
    sourceDeltaCount: input.preparedLayers.sourceDeltaCount,
    layerHashes: input.preparedLayers.layerHashes,
  });
}

/** Canonical sparse source slices for one chunk from the already-built spatial index.
 *  Bucket insertion order is layer -> operation -> canonical delta, so grouping preserves
 *  the exact durable composition order without sorting. */
export function preparedTerrainPaintLayerChunkSlices(input, options = {}) {
  ownDataObject(input, ["baseTopology", "chunkTopology", "preparedLayers"], "prepared terrain paint chunk slices input");
  const base = parseTerrainEditBaseTopology(input.baseTopology);
  const chunk = validateComposeTopology(base, input.chunkTopology);
  if (options.shouldCancel !== undefined && typeof options.shouldCancel !== "function") throw new Error("terrain paint shouldCancel must be a function");
  if (options.shouldCancel?.()) throw new TerrainEditCancelledError();
  const prepared = preparedData(input.preparedLayers);
  if (input.preparedLayers.baseTopologyHash !== base.topologyHash || prepared.base.topologyHash !== base.topologyHash) {
    throw new TerrainEditBaseMismatchError(base.topologyHash, input.preparedLayers.baseTopologyHash);
  }

  const operationsByLayer = Array.from({ length: prepared.layers.length }, () => []);
  const bucket = prepared.chunks.get(chunk.chunkId) ?? [];
  let currentLayer = -1, currentOperation = -1, currentDeltas;
  for (let index = 0; index < bucket.length; index++) {
    checkpoint(options.shouldCancel, index);
    const entry = bucket[index];
    if (entry.layerIndex !== currentLayer || entry.operationIndex !== currentOperation) {
      currentLayer = entry.layerIndex;
      currentOperation = entry.operationIndex;
      currentDeltas = [];
      operationsByLayer[currentLayer].push({ operationId: entry.operationId, deltas: currentDeltas });
    }
    currentDeltas.push(Object.freeze({ gx: entry.gx, gz: entry.gz, material: entry.material, weight: entry.weight }));
  }
  if (options.shouldCancel?.()) throw new TerrainEditCancelledError();
  const slices = operationsByLayer.map((operations, layerIndex) => Object.freeze({
    layerId: prepared.layers[layerIndex].layerId,
    operations: Object.freeze(operations.map((operation) => Object.freeze({
      operationId: operation.operationId,
      deltas: Object.freeze(operation.deltas),
    }))),
  }));
  return Object.freeze({
    schema: PREPARED_TERRAIN_PAINT_CHUNK_SLICES_SCHEMA,
    chunkId: chunk.chunkId,
    slices: Object.freeze(slices),
    inspectedDeltaCount: bucket.length,
  });
}

/** Convenience for one chunk. Compiler sessions should prepare once and reuse the index. */
export function composeTerrainPaintLayers(input, options = {}) {
  ownDataObject(input, ["baseTopology", "chunkTopology", "basePaintMat", "basePaintW", "layers"], "terrain paint composition input");
  const preparedLayers = prepareTerrainPaintLayers({ baseTopology: input.baseTopology, layers: input.layers }, options);
  return composePreparedTerrainPaintLayers({
    baseTopology: input.baseTopology,
    chunkTopology: input.chunkTopology,
    basePaintMat: input.basePaintMat,
    basePaintW: input.basePaintW,
    preparedLayers,
  }, options);
}

const STROKE_OPERATION_ID = /^op-\d{6}$/;
const FOLD_OPERATION_ID = /^fold-\d{6}$/;

/** Chunk one stroke's canonical sparse deltas into cap-respecting operations. Ids are
 *  derived from the layer's current operation count, so a replayed stroke sequence
 *  re-derives identical ids; uniqueness is required only within one layer. */
export function splitTerrainPaintStrokeDeltas(deltas, firstOperationIndex) {
  denseArray(deltas, MAX_TERRAIN_PAINT_DELTAS, "terrain paint stroke deltas");
  if (deltas.length === 0) throw new Error("terrain paint stroke must contain at least one delta");
  if (!Number.isSafeInteger(firstOperationIndex) || firstOperationIndex < 0) {
    throw new Error("terrain paint stroke first operation index must be a non-negative safe integer");
  }
  const operations = [];
  for (let offset = 0; offset < deltas.length; offset += MAX_TERRAIN_PAINT_DELTAS_PER_OPERATION) {
    operations.push({
      operationId: `op-${String(firstOperationIndex + operations.length).padStart(6, "0")}`,
      deltas: deltas.slice(offset, offset + MAX_TERRAIN_PAINT_DELTAS_PER_OPERATION),
    });
  }
  return operations;
}

/** Fold many ordered operations into the fewest equivalent ones. Per lattice key the
 *  ordered delta subsequence collapses into maximal same-branch runs (a run sums its
 *  weights in double; a paint run keeps its LATEST material). Same-sign blend deltas
 *  associate through the [0,1] clamp, while a branch switch (paint<->erase) does not, so
 *  runs split there; deltas at different keys commute, so run k of every key packs into
 *  fold operation k (sorted by gz then gx) and cross-key application order is free.
 *  Composition applies each op with a float32 rounding per application, so the fold is
 *  weight-equivalent within one rounding per overlapping sample (the exactness the
 *  height layer's fold already documents) and material-EXACT — deterministic, never
 *  resampled. A layer that still exceeds the caps after a fold throws — a paint layer
 *  is never silently lossy. */
export function compactTerrainPaintOperations(operationsInput) {
  denseArray(operationsInput, MAX_TERRAIN_PAINT_OPERATIONS + MAX_TERRAIN_PAINT_DELTAS_PER_OPERATION, "terrain paint fold operations");
  const runsByKey = new Map();
  const keyOrder = new Map();
  let deltaCount = 0;
  // Fold input is bounded by one full layer plus one full stroke (the append path folds
  // existing+incoming in one pass); the MERGED output must still fit the layer caps.
  const maxInput = MAX_TERRAIN_PAINT_DELTAS * 2;
  for (const operation of operationsInput) {
    ownDataObject(operation, ["operationId", "deltas"], "terrain paint fold operation");
    denseArray(operation.deltas, maxInput, "terrain paint fold operation deltas");
    for (const delta of operation.deltas) {
      ownDataObject(delta, ["gx", "gz", "material", "weight"], "terrain paint fold delta");
      if (!Number.isSafeInteger(delta.gx) || !Number.isSafeInteger(delta.gz)) throw new Error("terrain paint fold delta coordinates must be safe integers");
      const material = paintMaterial(delta.material, "terrain paint fold delta material");
      const weight = finite(delta.weight, "terrain paint fold delta weight");
      if (material === TERRAIN_PAINT_ERASE_MATERIAL ? weight > 0 : weight < 0) {
        throw new Error("terrain paint fold delta weight sign does not match its material branch");
      }
      deltaCount++;
      if (deltaCount > maxInput) throw new Error(`terrain paint fold exceeds ${maxInput} input deltas`);
      const key = `${delta.gz}:${delta.gx}`;
      if (!keyOrder.has(key)) keyOrder.set(key, { gz: delta.gz, gx: delta.gx });
      let runs = runsByKey.get(key);
      if (runs === undefined) {
        runs = [];
        runsByKey.set(key, runs);
      }
      const last = runs[runs.length - 1];
      const erase = material === TERRAIN_PAINT_ERASE_MATERIAL;
      if (last !== undefined && last.erase === erase) {
        last.weight += weight;
        if (!erase) last.material = material;
      } else {
        runs.push({ erase, material, weight });
      }
    }
  }
  if (runsByKey.size === 0) throw new Error("terrain paint fold requires at least one delta");
  const keys = [...keyOrder.values()].sort((a, b) => a.gz - b.gz || a.gx - b.gx);
  let runCount = 0;
  for (const key of keys) {
    const runs = runsByKey.get(`${key.gz}:${key.gx}`);
    for (const run of runs) {
      if (!Number.isFinite(run.weight) || Math.abs(run.weight) > MAX_TERRAIN_PAINT_WEIGHT) {
        throw new Error(`terrain paint fold merged weight must be within +/-${MAX_TERRAIN_PAINT_WEIGHT}`);
      }
    }
    runCount = Math.max(runCount, runs.length);
  }
  const operations = [];
  for (let run = 0; run < runCount; run++) {
    const deltas = [];
    for (const key of keys) {
      const runs = runsByKey.get(`${key.gz}:${key.gx}`);
      if (runs.length <= run) continue;
      deltas.push({ gx: key.gx, gz: key.gz, material: runs[run].material, weight: runs[run].weight });
    }
    for (let offset = 0; offset < deltas.length; offset += MAX_TERRAIN_PAINT_DELTAS_PER_OPERATION) {
      operations.push({
        operationId: `fold-${String(operations.length).padStart(6, "0")}`,
        deltas: deltas.slice(offset, offset + MAX_TERRAIN_PAINT_DELTAS_PER_OPERATION),
      });
    }
  }
  return operations;
}

/** Append one materialized stroke to a layer (or create it). When the result would
 *  exceed the operation OR delta cap, all operations fold into exact run-merged
 *  operations first (see compactTerrainPaintOperations). The layer is rebound to
 *  `stroke.baseTopology` — callers rebase first when the mounted base changed, so an
 *  append never silently migrates topology. */
export function appendTerrainPaintStroke(layerInput, stroke) {
  ownDataObject(stroke, ["layerId", "baseTopology", "deltas"], "terrain paint stroke");
  const layerId = identifier(stroke.layerId, "terrain paint stroke layer id");
  const base = parseTerrainEditBaseTopology(stroke.baseTopology);
  let existing = [];
  if (layerInput !== undefined) {
    const layer = parseTerrainPaintLayer(layerInput);
    if (layer.baseTopology.topologyHash !== base.topologyHash) {
      throw new TerrainEditBaseMismatchError(base.topologyHash, layer.baseTopology.topologyHash);
    }
    existing = layer.operations.map((operation) => ({
      operationId: operation.operationId,
      deltas: operation.deltas.map((delta) => ({ ...delta })),
    }));
  }
  let operations = [...existing, ...splitTerrainPaintStrokeDeltas(stroke.deltas, existing.length)];
  let deltaCount = 0;
  for (const operation of operations) deltaCount += operation.deltas.length;
  let folded = false;
  if (operations.length > MAX_TERRAIN_PAINT_OPERATIONS || deltaCount > MAX_TERRAIN_PAINT_DELTAS) {
    operations = compactTerrainPaintOperations(operations);
    folded = true;
  }
  const layer = createTerrainPaintLayer({ layerId, baseTopology: base, operations });
  return Object.freeze({
    layer,
    folded,
    operationIds: Object.freeze(layer.operations.map((operation) => operation.operationId)),
    deltaCount: layer.operations.reduce((total, operation) => total + operation.deltas.length, 0),
  });
}

/** Rebase every layer whose base topology drifted from the mounted one. Layers already
 *  on the target pass through untouched. Any conflict is returned structured — callers
 *  surface it, never drop a layer silently. */
export function rebaseTerrainPaintLayersToBase(layersInput, targetBaseInput, options = {}) {
  const target = parseTerrainEditBaseTopology(targetBaseInput);
  denseArray(layersInput, MAX_TERRAIN_PAINT_COMPOSE_LAYERS, "terrain paint rebase layers");
  const layers = [];
  const reports = [];
  const failures = [];
  for (const layerInput of layersInput) {
    const layer = parseTerrainPaintLayer(layerInput);
    if (layer.baseTopology.topologyHash === target.topologyHash) {
      layers.push(layer);
      continue;
    }
    const rebase = rebaseTerrainPaintLayer(layer, target, options);
    if (rebase.ok) {
      layers.push(rebase.layer);
      reports.push(Object.freeze({ layerId: layer.layerId, report: rebase.report }));
    } else {
      failures.push(Object.freeze({ layerId: layer.layerId, conflicts: rebase.conflicts, report: rebase.report }));
    }
  }
  if (failures.length > 0) return Object.freeze({ ok: false, failures: Object.freeze(failures) });
  return Object.freeze({ ok: true, layers: Object.freeze(layers), reports: Object.freeze(reports) });
}

export const TERRAIN_PAINT_OPERATION_ID_PATTERNS = Object.freeze({ stroke: STROKE_OPERATION_ID, fold: FOLD_OPERATION_ID });

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

export function rebaseTerrainPaintLayer(input, targetBaseInput, options = {}) {
  if (options.shouldCancel !== undefined && typeof options.shouldCancel !== "function") throw new Error("terrain paint shouldCancel must be a function");
  if (options.shouldCancel?.()) throw new TerrainEditCancelledError();
  const layer = parseTerrainPaintLayer(input);
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
          message: "painted sample does not land exactly on the target lattice",
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
          message: "painted sample is outside the target topology domain",
        });
        continue;
      }
      mapped.push({ gx, gz, material: delta.material, weight: delta.weight });
      mappedDeltaCount++;
    }
    return { operationId: operation.operationId, deltas: mapped };
  });
  if (options.shouldCancel?.()) throw new TerrainEditCancelledError();
  if (conflictCount !== 0) {
    return Object.freeze({
      ok: false,
      conflicts: Object.freeze(conflicts),
      report: rebaseReport(source, target, layer.operations.length, deltaCount, mappedDeltaCount, conflictCount),
    });
  }
  const rebasedLayer = createTerrainPaintLayer({ layerId: layer.layerId, baseTopology: target, operations: mappedOperations });
  return Object.freeze({
    ok: true,
    layer: rebasedLayer,
    report: rebaseReport(source, target, layer.operations.length, deltaCount, mappedDeltaCount, 0),
  });
}
