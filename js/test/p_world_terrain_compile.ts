import { ops } from "../src/engine.ts";
import { createMapTerrainField } from "../src/terrain/map-field.mjs";
import { createTerrainEditBaseTopology, createTerrainEditLayer } from "../src/terrain/edit-layer.mjs";
import { terrainChunkRangeForBounds, terrainChunkId } from "../src/terrain/grid.mjs";
import { NO_EROSION_RECIPE } from "../src/world/pipeline/erosion.mjs";
import { sha256 } from "../src/world/sha256.mjs";
import { worldMapContentHash, type WorldMap } from "../src/world/worldmap.ts";
import { canonicalCompilerSnapshot, canonicalDerivedRevisionManifest, compilerContentHash, decodeTerrainChunkArtifact, parseDerivedRevisionManifest } from "../src/world/compiler/index.mjs";
import { compileWorldTerrain, WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA } from "../src/world/compiler/terrain-compile.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_world_terrain_compile FAIL: ${message}`);
}
function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }

const MAP_DOC = { schema: "limina.map-doc/v1", mapId: "terrain-compile-fixture", layers: [] };
const MAPS_JSON_TEXT = JSON.stringify({ maps: [{ id: "terrain-compile-fixture" }] });
const WORLD_BIBLE_TEXT = "---\ntitle: Terrain Compile Fixture\n---\n\nA nonempty world bible.\n";
// atlas-source-bridge canonicalizes object keys and appends one newline before hashing.
const MAP_DOC_CANONICAL_BYTES = `${JSON.stringify({ layers: MAP_DOC.layers, mapId: MAP_DOC.mapId, schema: MAP_DOC.schema })}\n`;
const MAP_DOC_HASH = `sha256:${sha256(MAP_DOC_CANONICAL_BYTES)}`;
const DESIGN_SOURCE_HASH = sha256(`${MAPS_JSON_TEXT}\u0000${WORLD_BIBLE_TEXT}`);
assert(MAP_DOC_HASH !== `sha256:${DESIGN_SOURCE_HASH}`, "regression fixture must distinguish canonical MapDoc bytes from aggregate design inputs");

function fixtureMap(): WorldMap {
  const sourceHash = DESIGN_SOURCE_HASH;
  const core = {
    version: 1 as const,
    id: "terrain-compile-fixture",
    unitsPerMeter: 1,
    origin: [0, 0] as [number, number],
    extent: { w: 16, h: 16 },
    seaLevel: 0,
    land: [{ points: [[-8, -8], [8, -8], [8, 8], [-8, 8]] as [number, number][] }],
    relief: [],
    biomes: [{ biome: "grass" as const, points: [[-8, -8], [8, -8], [8, 8], [-8, 8]] as [number, number][] }],
    waterways: [],
    routes: [],
    anchors: [],
    provenance: { tool: "design-space" as const, sourceHash, contentHash: "pending" },
  };
  const contentHash = worldMapContentHash(core as WorldMap);
  return { ...core, provenance: { ...core.provenance, contentHash } } as WorldMap;
}

const map = fixtureMap();
const GRID_ID = "terrain-compile.surface";
function config(override: Record<string, unknown> = {}) {
  return {
    schema: WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA,
    seed: 7,
    baseAmplitude: 12,
    erosionRecipe: NO_EROSION_RECIPE,
    gridId: GRID_ID,
    verticalRange: { minM: -500, maxM: 9000 },
    limits: { maxChunks: 4096, maxMasterSamples: 1_050_625, maxArtifactBytes: 256 * 1024 * 1024 },
    ...override,
  };
}
const mapDocumentRef = { refId: "map-document", refType: "map-document/v1", scope: "global", assetId: "design/maps/fixture.map.json", contentHash: MAP_DOC_HASH };
const designSourceRef = { refId: "design-source", refType: "design-source/v1", scope: "global", assetId: "design/build-inputs/fixture.json", contentHash: `sha256:${map.provenance.sourceHash}` };
const worldMapRef = { refId: "world-map", refType: "world-map/v1", scope: "global", assetId: "maps/fixture.worldmap.json", contentHash: `sha256:${map.provenance.contentHash}` };

function input(layers: any[] = [], refs: any[] = [], extra: Record<string, unknown> = {}) {
  return {
    request: { projectId: "terrain-compile", branchId: "main", revision: 4, headHash: compilerContentHash({ head: 4 }) },
    worldMap: map,
    sourceRefs: { mapDocument: mapDocumentRef, designSource: designSourceRef, worldMap: worldMapRef },
    terrainEditLayers: layers,
    terrainEditLayerRefs: refs,
    compiler: { version: "1.0.0", config: config() },
    previousSnapshot: null,
    cancellation: { shouldCancel: () => false },
    ...extra,
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

const base = compileWorldTerrain(input());
const reorderedRoot = Object.fromEntries(Object.entries(input()).reverse());
const repeat = compileWorldTerrain(reorderedRoot);
assert(canonicalDerivedRevisionManifest(base.manifest) === canonicalDerivedRevisionManifest(repeat.manifest), "repeat/reordered input changed manifest bytes");
assert(canonicalCompilerSnapshot(base.snapshot) === canonicalCompilerSnapshot(repeat.snapshot), "repeat/reordered input changed snapshot bytes");
assert(base.artifacts.length === repeat.artifacts.length && base.artifacts.every((artifact, index) => bytesEqual(artifact.bytes, repeat.artifacts[index].bytes)), "repeat/reordered input changed artifact bytes");
assert(parseDerivedRevisionManifest(clone(base.manifest)).manifestHash === base.manifest.manifestHash, "manifest failed strict roundtrip");
assert(base.reusedArtifacts.length === 0, "cold compile reported reused artifacts");
for (const artifact of base.artifacts) {
  const decoded = decodeTerrainChunkArtifact(artifact.bytes);
  assert(decoded.tile.nrows === 33 && decoded.tile.ncols === 33, "artifact is not canonical 33x33 terrain");
  assert(decoded.tile.origin[1] === -500 && decoded.tile.scale[1] === 9500, "artifact did not use fixed configured vertical range");
}

const available = [...new Set(base.artifacts.map((artifact) => artifact.contentHash))].sort();
const allReused = compileWorldTerrain({
  ...input(),
  previousSnapshot: base.snapshot,
  previousManifest: base.manifest,
  availableArtifactHashes: available,
});
assert(allReused.artifacts.length === 0 && allReused.reusedArtifacts.length === base.manifest.chunks.length, "unchanged compile materialized cached artifacts");
assert(allReused.manifest.manifestHash === base.manifest.manifestHash, "sparse reuse changed the complete manifest");
assert(allReused.reusedArtifacts.every((artifact, index) => artifact.chunkId === base.manifest.chunks[index].chunkId
  && artifact.contentHash === base.manifest.chunks[index].artifacts[0].contentHash), "reused descriptor partition does not match manifest order");
const unavailableHash = available[0];
const oneUnavailable = compileWorldTerrain({
  ...input(),
  previousSnapshot: base.snapshot,
  previousManifest: base.manifest,
  availableArtifactHashes: available.filter((hash) => hash !== unavailableHash),
});
assert(oneUnavailable.artifacts.length >= 1, "missing cache availability did not force artifact generation");
assert(oneUnavailable.artifacts.every((artifact) => artifact.contentHash === unavailableHash), "availability miss recompiled unrelated artifact content");
assert(oneUnavailable.reusedArtifacts.length + oneUnavailable.artifacts.length === base.manifest.chunks.length, "sparse output did not partition complete manifest chunks");

rejects(() => compileWorldTerrain({ ...input(), previousSnapshot: base.snapshot, previousManifest: base.manifest }), /requires availableArtifactHashes/, "manifest without cache availability was accepted");
rejects(() => compileWorldTerrain({ ...input(), previousSnapshot: null, previousManifest: base.manifest, availableArtifactHashes: available }), /non-null previousSnapshot/, "cache reuse without planner snapshot was accepted");
rejects(() => compileWorldTerrain({ ...input(), previousManifest: null, availableArtifactHashes: available }), /must be empty/, "availability without prior manifest was accepted");
rejects(() => compileWorldTerrain({ ...input(), previousSnapshot: base.snapshot, previousManifest: base.manifest, availableArtifactHashes: [...available].reverse() }), /strictly ordered/, "unordered availability was accepted");
rejects(() => compileWorldTerrain({ ...input(), previousSnapshot: base.snapshot, previousManifest: base.manifest, availableArtifactHashes: [...available, compilerContentHash({ unrelated: true })].sort() }), /not referenced/, "unreferenced cache hash was accepted");
const mismatchedSnapshot = clone(base.snapshot);
mismatchedSnapshot.stageKeys.render[base.manifest.chunks[0].chunkId] = compilerContentHash({ wrong: "stage" });
const { snapshotHash: _oldSnapshotHash, ...mismatchedSnapshotCore } = mismatchedSnapshot;
mismatchedSnapshot.snapshotHash = compilerContentHash(mismatchedSnapshotCore);
rejects(() => compileWorldTerrain({ ...input(), previousSnapshot: mismatchedSnapshot, previousManifest: base.manifest, availableArtifactHashes: available }), /manifest and snapshot hashes do not agree/, "manifest/snapshot mismatch was accepted for reuse");
const wrongBranchManifest = clone(base.manifest);
delete wrongBranchManifest.manifestHash;
wrongBranchManifest.branchId = "other";
const resealedWrongBranch = (await import("../src/world/compiler/index.mjs")).createDerivedRevisionManifest(wrongBranchManifest);
rejects(() => compileWorldTerrain({ ...input(), previousSnapshot: base.snapshot, previousManifest: resealedWrongBranch, availableArtifactHashes: available }), /another project or branch/, "cross-branch cache manifest was accepted");

const atlasMap = clone(map);
atlasMap.provenance.sourceHash = MAP_DOC_HASH.slice("sha256:".length);
atlasMap.provenance.contentHash = worldMapContentHash(atlasMap);
const atlasCompile = compileWorldTerrain({
  ...input(),
  worldMap: atlasMap,
  sourceRefs: {
    mapDocument: mapDocumentRef,
  },
});
assert(atlasCompile.manifest.source.contentRefs.length === 1 && atlasCompile.manifest.source.contentRefs[0].refType === "map-document/v1", "Atlas manifest retained a fake WorldMap/design-source authority");
rejects(() => compileWorldTerrain({ ...input(), worldMap: atlasMap, sourceRefs: { mapDocument: { ...mapDocumentRef, contentHash: compilerContentHash({ wrong: true }) } } }), /MapDoc ref is not bound/, "Atlas compile accepted a MapDoc ref unrelated to provenance");
rejects(() => compileWorldTerrain({ ...input(), sourceRefs: { mapDocument: mapDocumentRef, worldMap: worldMapRef } }), /must contain mapDocument, designSource, and worldMap together/, "partial legacy source-ref set was accepted");

const tamperedMap = clone(map);
tamperedMap.seaLevel = 1;
rejects(() => compileWorldTerrain({ ...input(), worldMap: tamperedMap }), /WorldMap content hash mismatch/, "tampered WorldMap was accepted");
rejects(() => compileWorldTerrain({ ...input(), sourceRefs: { mapDocument: mapDocumentRef, designSource: { ...designSourceRef, contentHash: compilerContentHash({ wrong: true }) }, worldMap: worldMapRef } }), /design source ref is not bound/, "unbound aggregate design-source ref was accepted");
rejects(() => compileWorldTerrain({ ...input(), sourceRefs: { mapDocument: mapDocumentRef, designSource: designSourceRef, worldMap: { ...worldMapRef, assetId: "../escape" } } }), /assetId/, "malformed source ref was accepted");
rejects(() => compileWorldTerrain({ ...input(), artifactCache: [] }), /must contain exactly/, "unsupported client artifact cache was accepted");
rejects(() => compileWorldTerrain({ ...input(), compiler: { version: "1.0.0", config: config({ verticalRange: { minM: -1, maxM: 1 } }) } }), /outside configured vertical range/, "out-of-range height was silently clamped or rescaled");

const field = createMapTerrainField({ worldMap: map, seed: 7, baseAmplitude: 12, erosionRecipe: NO_EROSION_RECIPE, gridId: GRID_ID });
const domain = terrainChunkRangeForBounds(field.grid, field.bounds);
const editBase = createTerrainEditBaseTopology({ grid: field.grid, domain });
function layer(layerId: string, operations: any[]) { return createTerrainEditLayer({ layerId, baseTopology: editBase, operations }); }
function layerRef(layerValue: any, refId = "terrain-edits") {
  return { refId, refType: "terrain-edit-layer/v1", scope: "chunk", assetId: `terrain/${refId}.json`, contentHash: layerValue.contentHash };
}

const sharedLayer = layer("shared-edge", [{ operationId: "raise", kind: "add", deltas: [{ gx: 0, gz: 0, deltaM: 5 }] }]);
const edited = compileWorldTerrain(input([sharedLayer], [layerRef(sharedLayer)]));
const decodedById = new Map(edited.artifacts.map((artifact) => [artifact.chunkId, decodeTerrainChunkArtifact(artifact.bytes).tile]));
const nw = decodedById.get(terrainChunkId(GRID_ID, 0, -1, -1))!;
const ne = decodedById.get(terrainChunkId(GRID_ID, 0, 0, -1))!;
const sw = decodedById.get(terrainChunkId(GRID_ID, 0, -1, 0))!;
const se = decodedById.get(terrainChunkId(GRID_ID, 0, 0, 0))!;
const seamValues = [nw.heights[32 * 33 + 32], ne.heights[32 * 33], sw.heights[32], se.heights[0]];
assert(seamValues.every((value) => Object.is(value, seamValues[0])), "shared-edge edit produced unequal normalized seam samples");
const baseHashes = new Map(base.artifacts.map((artifact) => [artifact.chunkId, artifact.contentHash]));
const changedFromBase = edited.artifacts.filter((artifact) => baseHashes.get(artifact.chunkId) !== artifact.contentHash).map((artifact) => artifact.chunkId);
assert(changedFromBase.length === 4, `shared-corner edit changed ${changedFromBase.length} artifacts instead of four owners`);

const localV1 = layer("local", [{ operationId: "first", kind: "add", deltas: [{ gx: 1, gz: 1, deltaM: 2 }] }]);
const localV2 = layer("local", [
  { operationId: "first", kind: "add", deltas: [{ gx: 1, gz: 1, deltaM: 2 }] },
  { operationId: "second", kind: "add", deltas: [{ gx: 40, gz: 40, deltaM: 3 }] },
]);
const localFirst = compileWorldTerrain(input([localV1], [layerRef(localV1)]));
const localSecond = compileWorldTerrain({ ...input([localV2], [layerRef(localV2)]), previousSnapshot: localFirst.snapshot });
assert(localSecond.invalidation.changedChunks.length === 1, `local edit invalidated ${localSecond.invalidation.changedChunks.length} chunks instead of one`);
const unchangedArtifacts = localSecond.artifacts.filter((artifact) => localFirst.artifacts.find((prior) => prior.chunkId === artifact.chunkId)?.contentHash === artifact.contentHash);
assert(unchangedArtifacts.length === localSecond.artifacts.length - 1, "local edit rewrote unrelated terrain artifacts");
const localAvailable = [...new Set(localFirst.artifacts.map((artifact) => artifact.contentHash))].sort();
const localSparse = compileWorldTerrain({
  ...input([localV2], [layerRef(localV2)]),
  previousSnapshot: localFirst.snapshot,
  previousManifest: localFirst.manifest,
  availableArtifactHashes: localAvailable,
});
assert(localSparse.artifacts.length === 1, `local sparse compile emitted ${localSparse.artifacts.length} artifacts instead of one`);
assert(localSparse.reusedArtifacts.length === localFirst.manifest.chunks.length - 1, "local sparse compile did not reuse every unaffected chunk");
assert(localSparse.manifest.manifestHash === localSecond.manifest.manifestHash, "sparse and full local compiles produced different complete manifests");
assert(bytesEqual(localSparse.artifacts[0].bytes, localSecond.artifacts.find((artifact) => artifact.chunkId === localSparse.artifacts[0].chunkId)!.bytes), "sparse changed-chunk bytes differ from full compile");

// Slice hashing must consume the prepared spatial buckets, not filter every source delta for
// every chunk. These 256 interior deltas belong to exactly one chunk in a 16-chunk domain.
const denseLocalLayer = layer("dense-local", [{
  operationId: "dense",
  kind: "add",
  deltas: Array.from({ length: 256 }, (_unused, index) => ({
    gx: 1 + (index % 16),
    gz: 1 + Math.floor(index / 16),
    deltaM: 1,
  })),
}]);
const indexedSlices = compileWorldTerrain(input([denseLocalLayer], [layerRef(denseLocalLayer, "dense-local")]));
const sliceWork = indexedSlices.diagnostics[0].details;
assert(sliceWork.editSourceDeltaCount === 256, `expected 256 source deltas, got ${sliceWork.editSourceDeltaCount}`);
assert(sliceWork.editIndexedDeltaCount === 256, `expected 256 indexed deltas, got ${sliceWork.editIndexedDeltaCount}`);
assert(sliceWork.editSliceDeltaVisits === 256, `slice hashing inspected ${sliceWork.editSliceDeltaVisits} deltas instead of the 256 owned bucket entries`);
assert(sliceWork.editSliceDeltaVisits < sliceWork.chunkCount * sliceWork.editSourceDeltaCount, "slice hashing regressed to chunk-by-all-source-deltas work");

const orderA = layer("order-a", [{ operationId: "a", kind: "add", deltas: [{ gx: 1, gz: 1, deltaM: 10000 }] }]);
const orderB = layer("order-b", [{ operationId: "b", kind: "add", deltas: [{ gx: 1, gz: 1, deltaM: 0.0001 }] }]);
const orderC = layer("order-c", [{ operationId: "c", kind: "add", deltas: [{ gx: 1, gz: 1, deltaM: -10000 }] }]);
const ordered = compileWorldTerrain(input([orderA, orderB, orderC], [layerRef(orderA, "order-a"), layerRef(orderB, "order-b"), layerRef(orderC, "order-c")]));
const reordered = compileWorldTerrain(input([orderA, orderC, orderB], [layerRef(orderA, "order-a"), layerRef(orderC, "order-c"), layerRef(orderB, "order-b")]));
assert(ordered.manifest.manifestHash !== reordered.manifest.manifestHash, "terrain edit order did not bind the derived revision");
assert(ordered.artifacts.some((artifact, index) => artifact.contentHash !== reordered.artifacts[index].contentHash), "terrain edit order did not affect composed bytes");

const erosionConfig = config({ erosionRecipe: { schema: "limina.erosion-recipe/v1", enabled: true, rain: 0, thermal: 1, talus: 0.75, lifetime: 12, capacity: 4, deposition: 0.3, erosionRate: 0.3 } });
const eroded = compileWorldTerrain({ ...input(), compiler: { version: "1.0.0", config: erosionConfig }, previousSnapshot: base.snapshot });
for (const stageId of ["worldmap", "base-height"]) assert(eroded.invalidation.changedByStage[stageId].length === 0, `erosion config invalidated upstream ${stageId}`);
assert(eroded.invalidation.changedByStage.erosion.length === 1, "erosion config did not invalidate the one global erosion stage");
for (const stageId of ["edit-layers", "collision", "render"]) assert(eroded.invalidation.changedByStage[stageId].length === base.artifacts.length, `global erosion change did not invalidate every ${stageId} chunk`);

const forgedSnapshot = clone(base.snapshot);
forgedSnapshot.snapshotHash = compilerContentHash({ forged: true });
rejects(() => compileWorldTerrain({ ...input(), previousSnapshot: forgedSnapshot }), /snapshot hash mismatch/, "forged previous snapshot was accepted");
let polls = 0;
rejects(() => compileWorldTerrain({ ...input(), cancellation: { shouldCancel: () => ++polls > 3 } }), /cancelled/, "cancellation was not polled inside compile work");
rejects(() => compileWorldTerrain({ ...input(), compiler: { version: "1.0.0", config: config({ limits: { maxChunks: 1, maxMasterSamples: 1_050_625, maxArtifactBytes: 256 * 1024 * 1024 } }) } }), /chunks, exceeding cap 1/, "chunk cap was not enforced");
rejects(() => compileWorldTerrain({ ...input(), compiler: { version: "1.0.0", config: config({ limits: { maxChunks: 4096, maxMasterSamples: 1_050_625, maxArtifactBytes: 100 } }) } }), /artifact bytes exceed cap 100/, "artifact byte cap was not enforced");

const expensiveMap = fixtureMap() as any;
expensiveMap.extent = { w: 4000, h: 4000 };
expensiveMap.land = [{ points: [[-2000, -2000], [2000, -2000], [2000, 2000], [-2000, 2000]] }];
expensiveMap.biomes = Array.from({ length: 1000 }, (_unused, index) => {
  const x = -1800 + (index % 40) * 90, z = -1800 + Math.floor(index / 40) * 140;
  return { biome: "grass", points: [[x, z], [x + 20, z], [x, z + 20]] };
});
expensiveMap.provenance.contentHash = worldMapContentHash(expensiveMap);
rejects(() => compileWorldTerrain({
  ...input(),
  worldMap: expensiveMap,
  sourceRefs: { mapDocument: mapDocumentRef, designSource: designSourceRef, worldMap: { ...worldMapRef, contentHash: `sha256:${expensiveMap.provenance.contentHash}` } },
}), /estimated work .* exceeds/, "adversarial cell-by-vector work was not rejected before rasterization");

ops.op_log(`p_world_terrain_compile OK: ${base.artifacts.length} canonical chunks; deterministic bytes/manifest/snapshot, exact Atlas and legacy provenance, validated sparse cache reuse, ordered local edits, exact seams, fixed vertical range, honest global erosion invalidation, strict snapshot/cache/cancellation/resource rejection, and bounded vector work.`);
