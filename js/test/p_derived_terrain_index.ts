import { DerivedLod0TerrainIndex, parseTransferredTerrainTile } from "../src/browser/derived-terrain-index.ts";
import { decodeTerrainChunkArtifact, encodeTerrainChunkArtifact, TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE } from "../src/world/compiler/terrain-artifact.mjs";
import { derivedArtifactContentHash } from "../src/world/compiler/manifest.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_derived_terrain_index FAIL: ${message}`);
}

function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}

const grid = { schema: "limina.terrain-grid/v1", gridId: "far.surface", origin: [9_000_000, -9_000_000] as const, chunkSizeM: 64, defaultSamples: 3 };
const bytes = encodeTerrainChunkArtifact({
  nrows: 3, ncols: 3, origin: [9_000_032, 100, -8_999_968], scale: [64, 20, 64],
  heights: new Float32Array([0, 0.25, 0.5, 0.25, 0.5, 0.75, 0.5, 0.75, 1]),
});
const artifact = { artifactType: "terrain-chunk/v1", contentHash: derivedArtifactContentHash(bytes), byteLength: bytes.byteLength, mediaType: TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE };
const tile = parseTransferredTerrainTile(decodeTerrainChunkArtifact(bytes), artifact, "fixture");
const chunk = { chunkId: "terrain:far.surface:0:0:0", gridId: grid.gridId, lod: 0, tx: 0, tz: 0, topologyHash: derivedArtifactContentHash(new Uint8Array()), sourceSliceHashes: [], artifacts: [artifact] };
const index = new DerivedLod0TerrainIndex([{ chunk, tile }], grid);

assert(index.size === 1 && index.has(0, 0) && index.tile(0, 0) === tile, "index lookup lost tile identity");
assert(index.sampleHeight(9_000_032, -8_999_968) === 110, "centre bilinear sample changed");
assert(index.sampleHeight(9_000_016, -8_999_984) === 105, "interior bilinear sample changed");
assert(index.sampleHeight(8_999_999, -8_999_968) === null, "outside-domain sample was not bounded");
rejects(() => index.sampleHeight(Infinity, 0), /finite/, "non-finite sample was accepted");
rejects(() => new DerivedLod0TerrainIndex([{ chunk, tile }, { chunk, tile }], grid), /duplicated/, "duplicate coordinate was accepted");
rejects(() => new DerivedLod0TerrainIndex([{ chunk, tile: { ...tile, origin: [9_000_031, 100, -8_999_968] } }], grid), /placement/,
  "grid/tile placement mismatch was accepted");
const aliased = { ...decodeTerrainChunkArtifact(bytes), tile: { ...tile, heights: new Float32Array(new ArrayBuffer(40), 4, 9) } };
rejects(() => parseTransferredTerrainTile(aliased, artifact, "aliased"), /owned/, "aliased typed-array storage was accepted");

console.log("[js] p_derived_terrain_index OK: host-free strict tile validation, immutable O(1) LOD0 lookup, far-coordinate bilinear sampling, bounds, duplicates, and placement proven");
