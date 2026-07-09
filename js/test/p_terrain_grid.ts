import { ops } from "../src/engine.ts";
import {
  createTerrainGridSpec,
  terrainChunkId,
  terrainChunkRangeForBounds,
  terrainChunkSampleXZ,
  terrainChunkTopology,
  terrainWorldToChunk,
} from "../src/terrain/grid.mjs";
import { MapTerrainSource } from "../src/terrain/map-source.ts";
import { parseTileKey, tileKey, worldToTile } from "../src/terrain/stream.ts";
import { requestKey, terrainTileArtifactHashV2, tileContentHash } from "../src/terrain/tilecache.ts";
import type { TerrainTile } from "../src/terrain/types.ts";
import type { WorldMap } from "../src/world/worldmap.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_terrain_grid FAIL: ${message}`);
}

function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}

const grid = createTerrainGridSpec({ gridId: "grey-field.surface", origin: [0, 0], chunkSizeM: 48, defaultSamples: 33 });

// Negative coordinates use mathematical floor, not truncation, and round-trip through legacy keys.
assert(terrainWorldToChunk(grid, -0.001, -48.001).tx === -1, "negative x must floor to chunk -1");
assert(terrainWorldToChunk(grid, -0.001, -48.001).tz === -2, "negative z must floor across the -48 boundary");
assert(worldToTile(-0.001, -48.001, 48).tx === -1, "legacy worldToTile must share the validated floor mapping");
assert(tileKey(-7, 11) === "-7,11", "legacy tileKey bytes changed");
assert(JSON.stringify(parseTileKey("-7,11")) === JSON.stringify({ tx: -7, tz: 11 }), "legacy tile key did not round-trip");
for (const nonCanonical of ["-0,0", "00,0", "01,0", "0,-00", "+1,0"]) {
  rejects(() => parseTileKey(nonCanonical), /invalid tile key|non-canonical tile key/, `non-canonical tile key accepted: ${nonCanonical}`);
}

// Fixed-size coverage works for both an editor-scale patch and the approved 8 km single-domain cap.
const small = terrainChunkRangeForBounds(grid, { minX: -100, minZ: -100, maxX: 100, maxZ: 100 });
assert(JSON.stringify(small) === JSON.stringify({ minTx: -3, minTz: -3, maxTx: 2, maxTz: 2 }), "200m domain coverage is wrong");
const large = terrainChunkRangeForBounds(grid, { minX: -4000, minZ: -4000, maxX: 4000, maxZ: 4000 });
assert(large.minTx === -84 && large.maxTx === 83 && large.minTz === -84 && large.maxTz === 83, "8km domain coverage is wrong");

// Chunk identity is spatial and revision-independent. Topology is separately versioned.
const idAtRevision7 = terrainChunkId(grid.gridId, 0, -2, 5);
const idAtRevision99 = terrainChunkId(grid.gridId, 0, -2, 5);
assert(idAtRevision7 === idAtRevision99, "chunk id must not include source revision");
assert(idAtRevision7 === "surface:grey-field.surface:l0:x-2:z5", "chunk id wire shape is wrong");
const coarse = terrainChunkTopology(grid, { lod: 0, tx: -2, tz: 5, samples: 33 });
const fine = terrainChunkTopology(grid, { lod: 1, tx: -2, tz: 5, samples: 65 });
const changedSamples = terrainChunkTopology(grid, { lod: 0, tx: -2, tz: 5, samples: 65 });
assert(coarse.topologyHash !== changedSamples.topologyHash, "sample-count topology change was not hashed");
assert(coarse.topologyHash === terrainChunkTopology(grid, { lod: 0, tx: -2, tz: 5, samples: 33 }).topologyHash, "topology hash is not deterministic");
for (let index = 0; index < 33; index++) {
  const coarseEdge = terrainChunkSampleXZ(coarse, index, 32);
  const fineEdge = terrainChunkSampleXZ(fine, index * 2, 64);
  assert(Object.is(coarseEdge[0], fineEdge[0]) && Object.is(coarseEdge[1], fineEdge[1]), `cross-LOD shared edge diverged at ${index}`);
}
rejects(() => terrainChunkTopology(grid, { lod: 0, tx: 0, tz: 0, samples: 34 }), /power-of-two plus one/, "nonconforming sample count accepted");

// Unsafe and protocol-out-of-range coordinates fail instead of aliasing through bitwise coercion.
for (const coordinate of [1.5, Number.MAX_SAFE_INTEGER + 1, 2147483648, -2147483649]) {
  rejects(() => tileKey(coordinate, 0), /safe integer|outside/, `tileKey accepted ${coordinate}`);
  rejects(() => requestKey({ seed: 1, tx: coordinate, tz: 0, lod: 0 }), /safe integer|outside/, `requestKey accepted ${coordinate}`);
}
rejects(() => parseTileKey("1.5,0"), /invalid tile key/, "fractional serialized tile key accepted");
rejects(() => terrainWorldToChunk(grid, Infinity, 0), /finite/, "non-finite world coordinate accepted");
rejects(() => requestKey({ seed: 2147483648, tx: 0, tz: 0, lod: 0 }), /signed 32-bit/, "out-of-range seed alias accepted");
rejects(() => requestKey({ seed: 1, tx: 0, tz: 0, lod: 0, hints: { roughness: NaN } }), /hint 'roughness' must be finite/, "non-finite hint alias accepted");

// MapTerrainSource exposes stable chunk identity separately from its exact master-field topology.
function map(id: string, half: number, seaLevel: number): WorldMap {
  return {
    version: 1,
    id,
    unitsPerMeter: 1,
    origin: [0, 0],
    extent: { w: half * 2, h: half * 2 },
    seaLevel,
    land: [{ points: [[-half, -half], [half, -half], [half, half], [-half, half]] }],
    relief: [],
    biomes: [],
    waterways: [],
    routes: [],
    anchors: [],
    provenance: { tool: "design-space", contentHash: "fixture" },
  };
}
const sourceA = new MapTerrainSource({ worldMap: map("primary", 100, 0) });
const sourceRevisionOnly = new MapTerrainSource({ worldMap: map("primary", 100, 3) });
const sourceExpanded = new MapTerrainSource({ worldMap: map("primary", 180, 0) });
const sourceChunk = sourceA.chunkTopology({ tx: -1, tz: 0, lod: 0 });
assert(sourceChunk.chunkId === sourceRevisionOnly.chunkTopology({ tx: -1, tz: 0, lod: 0 }).chunkId, "map source revision changed stable chunk id");
assert(sourceA.masterTopologyHash === sourceRevisionOnly.masterTopologyHash, "content-only revision changed master topology");
assert(sourceA.masterTopologyHash !== sourceExpanded.masterTopologyHash, "expanded/coarsened master topology was not explicit");
for (const seed of [1.5, Infinity, 2147483648, -2147483649]) {
  rejects(() => new MapTerrainSource({ worldMap: map("seed-check", 20, 0), seed }), /terrain seed must be a signed 32-bit integer/, `map source accepted invalid seed ${seed}`);
}

// The new v2 artifact hash covers all terrain channels. Legacy hashes remain byte-compatible and
// deliberately ignore paint/blight, so changing them here must not change tileContentHash.
function tile(): TerrainTile {
  return {
    nrows: 2,
    ncols: 2,
    origin: [0, -2, 0],
    scale: [48, 10, 48],
    heights: new Float32Array([0, 0.25, 0.5, 1]),
    paintMat: new Uint8Array([1, 2, 3, 4]),
    paintW: new Float32Array([0.1, 0.2, 0.3, 0.4]),
    climateChannels: 1,
    climate: new Float32Array([1, 2, 3, 4]),
    blight: new Float32Array([0, 0.25, 0.5, 1]),
  };
}
const baseTile = tile();
const legacy = tileContentHash(baseTile);
const complete = terrainTileArtifactHashV2(baseTile);
const mutations: Array<(candidate: TerrainTile) => void> = [
  (candidate) => { candidate.heights[0] = 0.75; },
  (candidate) => { candidate.paintMat![0] = 5; },
  (candidate) => { candidate.paintW![0] = 0.9; },
  (candidate) => { candidate.climate![0] = 9; },
  (candidate) => { candidate.blight![0] = 1; },
];
for (const mutate of mutations) {
  const candidate = tile();
  mutate(candidate);
  assert(terrainTileArtifactHashV2(candidate) !== complete, "v2 artifact hash omitted a mutated channel");
}
const paintOnly = tile();
paintOnly.paintMat![0] = 5;
paintOnly.paintW![0] = 0.9;
paintOnly.blight![0] = 1;
assert(tileContentHash(paintOnly) === legacy, "legacy tileContentHash semantics changed");
assert(/^sha256:[0-9a-f]{64}$/.test(complete), "v2 artifact hash is not a portable sha256 content address");
rejects(() => terrainTileArtifactHashV2({ ...tile(), paintW: new Float32Array(3) }), /paintW length mismatch/, "malformed artifact channel accepted");
const corruptTile = tile();
corruptTile.heights[2] = NaN;
rejects(() => terrainTileArtifactHashV2(corruptTile), /heights\[2\] must be finite/, "non-finite terrain artifact accepted");

ops.op_log("p_terrain_grid OK: fixed grid covers 200m/8km domains; negative and huge coordinates are exact/fail-closed; stable revision-independent chunk IDs, versioned topology hashes, cross-LOD shared edges, explicit map master topology, and complete v2 terrain artifact hashes are proven without changing legacy hashes.");
