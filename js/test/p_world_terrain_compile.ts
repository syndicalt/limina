import { ops } from "../src/engine.ts";
import { createMapTerrainField } from "../src/terrain/map-field.mjs";
import { createTerrainEditBaseTopology, createTerrainEditLayer } from "../src/terrain/edit-layer.mjs";
import { terrainChunkRangeForBounds, terrainChunkId } from "../src/terrain/grid.mjs";
import { NO_EROSION_RECIPE } from "../src/world/pipeline/erosion.mjs";
import { sha256 } from "../src/world/sha256.mjs";
import { worldMapContentHash, type WorldMap } from "../src/world/worldmap.ts";
import { decodeHydrologyFieldArtifact, HYDROLOGY_FIELD_ARTIFACT_TYPE } from "../src/world/hydrology-artifact.mjs";
import {
  decodeHydrologyWaterArtifact,
  HYDROLOGY_WATER_ARTIFACT_TYPE,
} from "../src/world/hydrology-water-artifact.mjs";
import {
  canonicalCompilerSnapshot,
  canonicalDerivedRevisionManifest,
  compilerContentHash,
  createDerivedRevisionManifest,
  createHydrologyWorldCompilerGraph,
  createInitialWorldCompilerGraph,
  decodeTerrainChunkArtifact,
  derivedGlobalArtifacts,
  parseDerivedRevisionManifest,
} from "../src/world/compiler/index.mjs";
import {
  compileWorldTerrain,
  WORLD_HYDROLOGY_TERRAIN_COMPILER_VERSION,
  WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA,
} from "../src/world/compiler/terrain-compile.ts";
import {
  WORLD_OVERVIEW_ARTIFACT_TYPE,
  decodeWorldOverviewArtifact,
} from "../src/world/compiler/world-overview-artifact.mjs";
import {
  NAVIGATION_INDEX_ARTIFACT_TYPE,
  decodeNavigationIndexArtifact,
  searchNavigationIndexPrefix,
} from "../src/world/compiler/navigation-index-artifact.mjs";
import { createDefaultWorldTerrainCompiler, createHydrologyWorldTerrainCompiler } from "../src/world/compiler/node-entry.ts";

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
assert(base.snapshot.snapshotHash === "sha256:6319cd47d082a2c4ccc39f77bb51f102e3dd4b293466b7b020d6e9d7655ef152", `default snapshot golden changed: ${base.snapshot.snapshotHash}`);
assert(compilerContentHash(base.reusedArtifacts) === "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", "legacy reuse envelope golden changed");
assert(base.manifest.schema === "limina.derived-revision-manifest/v2", "terrain compile did not publish global-artifact manifest v2");
const baseOverviewDescriptor = derivedGlobalArtifacts(base.manifest).find((artifact: any) => artifact.artifactType === WORLD_OVERVIEW_ARTIFACT_TYPE);
const baseOverview = base.artifacts.find((artifact: any) => artifact.artifactType === WORLD_OVERVIEW_ARTIFACT_TYPE);
const baseNavigationDescriptor = derivedGlobalArtifacts(base.manifest).find((artifact: any) => artifact.artifactType === NAVIGATION_INDEX_ARTIFACT_TYPE);
const baseNavigation = base.artifacts.find((artifact: any) => artifact.artifactType === NAVIGATION_INDEX_ARTIFACT_TYPE);
assert(baseNavigationDescriptor !== undefined && baseNavigation?.scope === "global", "terrain compile did not publish navigation descriptor and bytes");
assert(baseNavigationDescriptor.contentHash === baseNavigation.contentHash && baseNavigationDescriptor.byteLength === baseNavigation.bytes.byteLength,
  "navigation descriptor is not bound to emitted bytes");
assert(decodeNavigationIndexArtifact(baseNavigation.bytes).entryCount === 0, "legacy map navigation index is not empty");
assert(baseOverviewDescriptor !== undefined && baseOverview?.scope === "global", "terrain compile did not publish its world overview descriptor and bytes");
assert(baseOverviewDescriptor.contentHash === baseOverview.contentHash && baseOverviewDescriptor.byteLength === baseOverview.bytes.byteLength,
  "world overview descriptor is not bound to emitted bytes");
const decodedOverview = decodeWorldOverviewArtifact(baseOverview.bytes);
assert(decodedOverview.grid.rows === 129 && decodedOverview.grid.cols === 129, "world overview is not canonical 129x129 terrain");
assert(decodedOverview.grid.origin[0] === -57 && decodedOverview.grid.origin[1] === -57 && decodedOverview.grid.stepM === 114 / 128,
  "world overview placement is not bound to the compiler master field");
const reorderedRoot = Object.fromEntries(Object.entries(input()).reverse());
const repeat = compileWorldTerrain(reorderedRoot);
assert(canonicalDerivedRevisionManifest(base.manifest) === canonicalDerivedRevisionManifest(repeat.manifest), "repeat/reordered input changed manifest bytes");
assert(canonicalCompilerSnapshot(base.snapshot) === canonicalCompilerSnapshot(repeat.snapshot), "repeat/reordered input changed snapshot bytes");
assert(base.artifacts.length === repeat.artifacts.length && base.artifacts.every((artifact, index) => bytesEqual(artifact.bytes, repeat.artifacts[index].bytes)), "repeat/reordered input changed artifact bytes");
assert(parseDerivedRevisionManifest(clone(base.manifest)).manifestHash === base.manifest.manifestHash, "manifest failed strict roundtrip");
assert(base.reusedArtifacts.length === 0, "cold compile reported reused artifacts");
for (const artifact of base.artifacts.filter((candidate: any) => candidate.chunkId !== undefined)) {
  const decoded = decodeTerrainChunkArtifact(artifact.bytes);
  assert(decoded.tile.nrows === 33 && decoded.tile.ncols === 33, "artifact is not canonical 33x33 terrain");
  assert(decoded.tile.origin[1] === -500 && decoded.tile.scale[1] === 9500, "artifact did not use fixed configured vertical range");
}

function navigationInput(worldMap: WorldMap, extra: Record<string, unknown> = {}) {
  return {
    ...input(),
    worldMap,
    sourceRefs: {
      mapDocument: mapDocumentRef,
      designSource: { ...designSourceRef, contentHash: `sha256:${worldMap.provenance.sourceHash}` },
      worldMap: { ...worldMapRef, contentHash: `sha256:${worldMap.provenance.contentHash}` },
    },
    ...extra,
  };
}

const millRef = { schema: "limina.atlas-design-ref/v1", mapId: map.id, kind: "place", id: "old-mill" } as const;
const navigationMap = clone(map) as WorldMap;
navigationMap.anchors = [{ id: "old-mill", kind: "village", position: [0, 0], name: "Old Mill", designRef: millRef, source: "map" }];
navigationMap.gazetteer = [{ placeId: "old-mill", name: "Old Mill", kind: "village", parentId: null, position: [0, 0], radiusM: 12, designRef: millRef }];
navigationMap.designIndex = [{ designRef: millRef, position: [0, 0], radiusM: 12 }];
navigationMap.provenance.contentHash = worldMapContentHash(navigationMap);
const navigationCold = compileWorldTerrain(navigationInput(navigationMap));
const navigationBytes = navigationCold.artifacts.find((artifact: any) => artifact.artifactType === NAVIGATION_INDEX_ARTIFACT_TYPE)?.bytes;
assert(navigationBytes instanceof Uint8Array, "navigation compile omitted binary index bytes");
const decodedNavigation = decodeNavigationIndexArtifact(navigationBytes);
assert(decodedNavigation.worldBounds.minX === -57 && decodedNavigation.worldBounds.maxX === 57,
  "navigation artifact is not bound to canonical compiler world bounds");
const millResult = searchNavigationIndexPrefix(decodedNavigation, "old mill")[0];
assert(millResult?.designRef.id === "old-mill" && millResult.label === "Old Mill" && millResult.kind === "village"
  && millResult.radiusM === 12, "navigation artifact did not enrich designIndex from anchor/gazetteer metadata");

const renamedNavigationMap = clone(navigationMap) as WorldMap;
renamedNavigationMap.anchors[0].name = "Elder Mill";
renamedNavigationMap.gazetteer![0].name = "Elder Mill";
renamedNavigationMap.provenance.contentHash = worldMapContentHash(renamedNavigationMap);
const navigationAvailable = [...new Set(navigationCold.artifacts.map((artifact: any) => artifact.contentHash))].sort();
const navigationRenamed = compileWorldTerrain(navigationInput(renamedNavigationMap, {
  previousSnapshot: navigationCold.snapshot,
  previousManifest: navigationCold.manifest,
  availableArtifactHashes: navigationAvailable,
}));
assert(navigationRenamed.artifacts.length === 1
  && navigationRenamed.artifacts[0].artifactType === NAVIGATION_INDEX_ARTIFACT_TYPE,
"navigation-only source change did not rebuild exactly the navigation index");
assert(navigationRenamed.reusedArtifacts.length === navigationCold.manifest.chunks.length + 1,
  "navigation-only source change did not reuse every terrain chunk and overview");
assert(navigationRenamed.snapshot.stageKeys.render[navigationCold.manifest.chunks[0].chunkId]
  === navigationCold.snapshot.stageKeys.render[navigationCold.manifest.chunks[0].chunkId],
"navigation-only source change leaked into terrain stage identity");
assert(navigationRenamed.snapshot.stageKeys["navigation-index"]["@global"]
  !== navigationCold.snapshot.stageKeys["navigation-index"]["@global"],
"navigation-only source change did not invalidate navigation stage identity");
const renamedDecoded = decodeNavigationIndexArtifact(navigationRenamed.artifacts[0].bytes);
assert(searchNavigationIndexPrefix(renamedDecoded, "elder")[0]?.label === "Elder Mill",
  "rebuilt navigation index did not contain renamed search metadata");

const available = [...new Set(base.artifacts.map((artifact) => artifact.contentHash))].sort();
const allReused = compileWorldTerrain({
  ...input(),
  previousSnapshot: base.snapshot,
  previousManifest: base.manifest,
  availableArtifactHashes: available,
});
assert(allReused.artifacts.length === 0 && allReused.reusedArtifacts.length === base.manifest.chunks.length + 2, "unchanged compile materialized cached artifacts");
assert(allReused.manifest.manifestHash === base.manifest.manifestHash, "sparse reuse changed the complete manifest");
const reusedChunks = allReused.reusedArtifacts.filter((artifact: any) => artifact.chunkId !== undefined);
assert(reusedChunks.every((artifact, index) => artifact.chunkId === base.manifest.chunks[index].chunkId
  && artifact.contentHash === base.manifest.chunks[index].artifacts[0].contentHash), "reused descriptor partition does not match manifest order");
assert(allReused.reusedArtifacts.some((artifact: any) => artifact.scope === "global" && artifact.artifactType === WORLD_OVERVIEW_ARTIFACT_TYPE),
  "unchanged compile did not reuse the source-fenced overview");
const unavailableHash = available[0];
const oneUnavailable = compileWorldTerrain({
  ...input(),
  previousSnapshot: base.snapshot,
  previousManifest: base.manifest,
  availableArtifactHashes: available.filter((hash) => hash !== unavailableHash),
});
assert(oneUnavailable.artifacts.length >= 1, "missing cache availability did not force artifact generation");
assert(oneUnavailable.artifacts.every((artifact) => artifact.contentHash === unavailableHash), "availability miss recompiled unrelated artifact content");
assert(oneUnavailable.reusedArtifacts.length + oneUnavailable.artifacts.length === base.manifest.chunks.length + 2, "sparse output did not partition complete manifest artifacts");

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
const decodedById = new Map(edited.artifacts.filter((artifact: any) => artifact.chunkId !== undefined)
  .map((artifact) => [artifact.chunkId, decodeTerrainChunkArtifact(artifact.bytes).tile]));
const nw = decodedById.get(terrainChunkId(GRID_ID, 0, -1, -1))!;
const ne = decodedById.get(terrainChunkId(GRID_ID, 0, 0, -1))!;
const sw = decodedById.get(terrainChunkId(GRID_ID, 0, -1, 0))!;
const se = decodedById.get(terrainChunkId(GRID_ID, 0, 0, 0))!;
const seamValues = [nw.heights[32 * 33 + 32], ne.heights[32 * 33], sw.heights[32], se.heights[0]];
assert(seamValues.every((value) => Object.is(value, seamValues[0])), "shared-edge edit produced unequal normalized seam samples");
const baseHashes = new Map(base.artifacts.filter((artifact) => artifact.chunkId !== undefined)
  .map((artifact) => [artifact.chunkId, artifact.contentHash]));
const changedFromBase = edited.artifacts.filter((artifact) => artifact.chunkId !== undefined
  && baseHashes.get(artifact.chunkId) !== artifact.contentHash).map((artifact) => artifact.chunkId);
assert(changedFromBase.length === 4, `shared-corner edit changed ${changedFromBase.length} artifacts instead of four owners`);

const localV1 = layer("local", [{ operationId: "first", kind: "add", deltas: [{ gx: 1, gz: 1, deltaM: 2 }] }]);
const localV2 = layer("local", [
  { operationId: "first", kind: "add", deltas: [{ gx: 1, gz: 1, deltaM: 2 }] },
  { operationId: "second", kind: "add", deltas: [{ gx: 40, gz: 40, deltaM: 3 }] },
]);
const localFirst = compileWorldTerrain(input([localV1], [layerRef(localV1)]));
const localSecond = compileWorldTerrain({ ...input([localV2], [layerRef(localV2)]), previousSnapshot: localFirst.snapshot });
assert(localSecond.invalidation.changedChunks.length === 1, `local edit invalidated ${localSecond.invalidation.changedChunks.length} chunks instead of one`);
const localSecondChunks = localSecond.artifacts.filter((artifact) => artifact.chunkId !== undefined);
const unchangedArtifacts = localSecondChunks.filter((artifact) => localFirst.artifacts.find((prior) => prior.chunkId === artifact.chunkId)?.contentHash === artifact.contentHash);
assert(unchangedArtifacts.length === localSecondChunks.length - 1, "local edit rewrote unrelated terrain artifacts");
const localAvailable = [...new Set(localFirst.artifacts.map((artifact) => artifact.contentHash))].sort();
const localSparse = compileWorldTerrain({
  ...input([localV2], [layerRef(localV2)]),
  previousSnapshot: localFirst.snapshot,
  previousManifest: localFirst.manifest,
  availableArtifactHashes: localAvailable,
});
assert(localSparse.artifacts.length === 1, `local sparse compile emitted ${localSparse.artifacts.length} artifacts instead of one`);
assert(localSparse.reusedArtifacts.length === localFirst.manifest.chunks.length + 1, "local sparse compile did not reuse every unaffected chunk and both globals");
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
for (const stageId of ["edit-layers", "collision", "render"]) assert(eroded.invalidation.changedByStage[stageId].length === base.manifest.chunks.length, `global erosion change did not invalidate every ${stageId} chunk`);

const HYDROLOGY_RECIPE = Object.freeze({
  schema: "limina.hydrology-recipe/v1",
  precipitationMmPerYear: 900,
  riverMinCatchmentAreaM2: 20_000,
  basinMinAreaM2: 10_000,
  basinMinDepthM: 1,
  waterfallMinDropM: 2,
});
function fixtureHydrologyMap(recipeOverride: Record<string, unknown> = {}, terrainOverride: Record<string, unknown> = {}): WorldMap {
  const value = { ...clone(map), ...terrainOverride } as any;
  value.hydrology = { ...HYDROLOGY_RECIPE, ...recipeOverride };
  value.provenance.sourceHash = sha256(JSON.stringify({ hydrology: value.hydrology, terrainOverride }));
  value.provenance.contentHash = worldMapContentHash(value);
  return value;
}
function hydrologyInput(mapValue: WorldMap, layers: any[] = [], refs: any[] = [], extra: Record<string, unknown> = {}) {
  return {
    ...input(layers, refs),
    request: {
      projectId: "terrain-compile",
      branchId: "main",
      revision: 5,
      headHash: compilerContentHash({ sourceHash: mapValue.provenance.sourceHash }),
    },
    worldMap: mapValue,
    sourceRefs: {
      mapDocument: mapDocumentRef,
      designSource: { ...designSourceRef, contentHash: `sha256:${mapValue.provenance.sourceHash}` },
      worldMap: { ...worldMapRef, contentHash: `sha256:${mapValue.provenance.contentHash}` },
    },
    compiler: { version: WORLD_HYDROLOGY_TERRAIN_COMPILER_VERSION, config: config() },
    ...extra,
  };
}
function availableManifestHashes(output: any): string[] {
  return [...new Set([
    ...derivedGlobalArtifacts(output.manifest).map((artifact: any) => artifact.contentHash),
    ...output.manifest.chunks.flatMap((chunk: any) => chunk.artifacts.map((artifact: any) => artifact.contentHash)),
  ])].sort();
}

const initialGraph = createInitialWorldCompilerGraph();
const hydrologyGraph = createHydrologyWorldCompilerGraph();
assert(initialGraph.graphHash === base.manifest.compiler.graphHash, "legacy graph hash changed when hydrology graph was added");
assert(hydrologyGraph.graphHash !== initialGraph.graphHash, "hydrology profile did not receive a distinct graph identity");
assert(hydrologyGraph.definitions.find((stage: any) => stage.stageId === "hydrology-field")?.dependencies.join(",") === "erosion", "hydrology stage is not terminal over erosion");
assert(hydrologyGraph.reverseDependencies["hydrology-field"].join(",") === "hydrology-water-topology",
  "hydrology field does not invalidate only generated water topology");
assert(hydrologyGraph.definitions.find((stage: any) => stage.stageId === "hydrology-water-topology")?.dependencies.join(",") === "hydrology-field",
  "generated water topology is not terminal over the hydrology field");
assert(hydrologyGraph.reverseDependencies["hydrology-water-topology"].length === 0,
  "generated water topology incorrectly invalidates terrain chunks");
assert(createDefaultWorldTerrainCompiler("terrain-compile").identity.graphHash === initialGraph.graphHash, "default compiler profile no longer uses the exact legacy graph");
assert(createHydrologyWorldTerrainCompiler("terrain-compile").identity.graphHash === hydrologyGraph.graphHash, "hydrology compiler profile identity does not match its graph");

const hydrologyMap = fixtureHydrologyMap();
rejects(() => compileWorldTerrain({ ...input(), compiler: { version: WORLD_HYDROLOGY_TERRAIN_COMPILER_VERSION, config: config() } }), /requires a WorldMap hydrology recipe/, "hydrology profile accepted a map without a recipe");
rejects(() => compileWorldTerrain({ ...hydrologyInput(hydrologyMap), compiler: { version: "1.0.0", config: config() } }), /requires compiler version/, "legacy profile silently ignored a hydrology recipe");

const hydrologyCold = compileWorldTerrain(hydrologyInput(hydrologyMap));
assert(hydrologyCold.manifest.schema === "limina.derived-revision-manifest/v2", "recipe compile did not emit manifest v2");
assert(derivedGlobalArtifacts(hydrologyCold.manifest).length === 4, "recipe compile did not emit navigation, overview, and two hydrology global artifact descriptors");
const hydrologyColdGlobals = hydrologyCold.artifacts.filter((artifact: any) => artifact.scope === "global");
const hydrologyColdGlobal = hydrologyColdGlobals.find((artifact: any) => artifact.artifactType === HYDROLOGY_FIELD_ARTIFACT_TYPE);
const hydrologyWaterGlobal = hydrologyColdGlobals.find((artifact: any) => artifact.artifactType === HYDROLOGY_WATER_ARTIFACT_TYPE);
assert(hydrologyColdGlobal !== undefined, "recipe compile omitted hydrology field bytes");
assert(hydrologyWaterGlobal !== undefined, "recipe compile omitted generated water topology bytes");
assert(hydrologyCold.artifacts.slice(0, -4).every((artifact: any) => artifact.scope === "chunk")
  && hydrologyCold.artifacts.at(-4)?.artifactType === WORLD_OVERVIEW_ARTIFACT_TYPE
  && hydrologyCold.artifacts.at(-3)?.artifactType === NAVIGATION_INDEX_ARTIFACT_TYPE
  && hydrologyCold.artifacts.at(-2) === hydrologyColdGlobal && hydrologyCold.artifacts.at(-1) === hydrologyWaterGlobal,
"v2 supplied artifacts are not explicitly scoped in dependency order");
const decodedHydrology = decodeHydrologyFieldArtifact(hydrologyColdGlobal.bytes);
const decodedWater = decodeHydrologyWaterArtifact(hydrologyWaterGlobal.bytes, {
  hydrologyFieldContentHash: hydrologyColdGlobal.contentHash,
  recipeHash: compilerContentHash(hydrologyMap.hydrology),
  erosionStageKey: hydrologyCold.snapshot.stageKeys.erosion["@global"],
  compilerGraphHash: hydrologyGraph.graphHash,
});
const hydrologyField = createMapTerrainField({ worldMap: hydrologyMap, seed: 7, baseAmplitude: 12, erosionRecipe: NO_EROSION_RECIPE, gridId: GRID_ID });
assert(decodedHydrology.topology.rows === hydrologyField.masterRes && decodedHydrology.topology.cols === hydrologyField.masterRes, "hydrology artifact dimensions do not match the eroded master field");
assert(decodedHydrology.placement.originX === hydrologyField.bounds.minX && decodedHydrology.placement.originZ === hydrologyField.bounds.minZ, "hydrology artifact placement does not match the master field origin");
assert(decodedHydrology.topology.cellSizeM === hydrologyField.masterStep, "hydrology artifact cell size does not match the master field");
assert(decodedWater.topology.rows === hydrologyField.masterRes && decodedWater.topology.cols === hydrologyField.masterRes,
  "generated water topology dimensions do not match the master field");

const hydrologyAvailable = availableManifestHashes(hydrologyCold);
const hydrologyWarm = compileWorldTerrain(hydrologyInput(hydrologyMap, [], [], {
  previousSnapshot: hydrologyCold.snapshot,
  previousManifest: hydrologyCold.manifest,
  availableArtifactHashes: hydrologyAvailable,
}));
assert(hydrologyWarm.artifacts.length === 0, "warm hydrology compile materialized bytes");
assert(hydrologyWarm.reusedArtifacts.length === hydrologyCold.manifest.chunks.length + 4, "warm hydrology compile did not reuse every global and chunk artifact");
assert(hydrologyWarm.reusedArtifacts.slice(0, -4).every((artifact: any) => artifact.scope === "chunk")
  && hydrologyWarm.reusedArtifacts.at(-4)?.artifactType === WORLD_OVERVIEW_ARTIFACT_TYPE
  && hydrologyWarm.reusedArtifacts.at(-3)?.artifactType === NAVIGATION_INDEX_ARTIFACT_TYPE
  && hydrologyWarm.reusedArtifacts.at(-2)?.artifactType === HYDROLOGY_FIELD_ARTIFACT_TYPE
  && hydrologyWarm.reusedArtifacts.at(-1)?.artifactType === HYDROLOGY_WATER_ARTIFACT_TYPE,
"v2 reused artifacts are not explicitly scoped in dependency order");

const hydrologyGlobalHash = derivedGlobalArtifacts(hydrologyCold.manifest)
  .find((artifact: any) => artifact.artifactType === HYDROLOGY_FIELD_ARTIFACT_TYPE).contentHash;
const missingHydrologyGlobal = compileWorldTerrain(hydrologyInput(hydrologyMap, [], [], {
  previousSnapshot: hydrologyCold.snapshot,
  previousManifest: hydrologyCold.manifest,
  availableArtifactHashes: hydrologyAvailable.filter((hash) => hash !== hydrologyGlobalHash),
}));
assert(missingHydrologyGlobal.artifacts.length === 1 && missingHydrologyGlobal.artifacts[0].scope === "global", "missing global availability recompiled chunk artifacts");
assert(missingHydrologyGlobal.artifacts[0].artifactType === HYDROLOGY_FIELD_ARTIFACT_TYPE,
  "missing field availability rebuilt the wrong global artifact");
assert(missingHydrologyGlobal.reusedArtifacts.length === hydrologyCold.manifest.chunks.length + 3,
  "missing field availability failed to reuse chunks and bound water topology");
const hydrologyWaterHash = derivedGlobalArtifacts(hydrologyCold.manifest)
  .find((artifact: any) => artifact.artifactType === HYDROLOGY_WATER_ARTIFACT_TYPE).contentHash;
const missingWaterGlobal = compileWorldTerrain(hydrologyInput(hydrologyMap, [], [], {
  previousSnapshot: hydrologyCold.snapshot,
  previousManifest: hydrologyCold.manifest,
  availableArtifactHashes: hydrologyAvailable.filter((hash) => hash !== hydrologyWaterHash),
}));
assert(missingWaterGlobal.artifacts.length === 1 && missingWaterGlobal.artifacts[0].artifactType === HYDROLOGY_WATER_ARTIFACT_TYPE,
  "missing water topology availability rebuilt more than generated water");
assert(missingWaterGlobal.reusedArtifacts.length === hydrologyCold.manifest.chunks.length + 3,
  "missing water topology availability failed to reuse chunks and field");
const overviewHash = derivedGlobalArtifacts(hydrologyCold.manifest)
  .find((artifact: any) => artifact.artifactType === WORLD_OVERVIEW_ARTIFACT_TYPE).contentHash;
const missingOverview = compileWorldTerrain(hydrologyInput(hydrologyMap, [], [], {
  previousSnapshot: hydrologyCold.snapshot,
  previousManifest: hydrologyCold.manifest,
  availableArtifactHashes: hydrologyAvailable.filter((hash) => hash !== overviewHash),
}));
assert(missingOverview.artifacts.length === 1 && missingOverview.artifacts[0].artifactType === WORLD_OVERVIEW_ARTIFACT_TYPE,
  "missing overview availability rebuilt unrelated global or chunk artifacts");
assert(missingOverview.reusedArtifacts.length === hydrologyCold.manifest.chunks.length + 3,
  "missing overview availability failed to reuse chunks and hydrology globals");
const wrongMediaManifest = clone(hydrologyCold.manifest);
delete wrongMediaManifest.manifestHash;
wrongMediaManifest.globalArtifacts[0].mediaType = "application/octet-stream";
const resealedWrongMediaManifest = createDerivedRevisionManifest(wrongMediaManifest);
const wrongMediaHydrology = compileWorldTerrain(hydrologyInput(hydrologyMap, [], [], {
  previousSnapshot: hydrologyCold.snapshot,
  previousManifest: resealedWrongMediaManifest,
  availableArtifactHashes: availableManifestHashes({ manifest: resealedWrongMediaManifest }),
}));
assert(wrongMediaHydrology.artifacts.length === 1 && wrongMediaHydrology.artifacts[0].artifactType === HYDROLOGY_FIELD_ARTIFACT_TYPE,
  "wrong field media type did not recompile only the field");
const wrongWaterMediaManifest = clone(hydrologyCold.manifest);
delete wrongWaterMediaManifest.manifestHash;
wrongWaterMediaManifest.globalArtifacts[1].mediaType = "application/octet-stream";
const resealedWrongWaterMediaManifest = createDerivedRevisionManifest(wrongWaterMediaManifest);
const wrongMediaWater = compileWorldTerrain(hydrologyInput(hydrologyMap, [], [], {
  previousSnapshot: hydrologyCold.snapshot,
  previousManifest: resealedWrongWaterMediaManifest,
  availableArtifactHashes: availableManifestHashes({ manifest: resealedWrongWaterMediaManifest }),
}));
assert(wrongMediaWater.artifacts.length === 1 && wrongMediaWater.artifacts[0].artifactType === HYDROLOGY_WATER_ARTIFACT_TYPE,
  "wrong water media type did not rebuild only generated water topology");
rejects(() => compileWorldTerrain(hydrologyInput(hydrologyMap, [], [], {
  previousSnapshot: hydrologyCold.snapshot,
  previousManifest: hydrologyCold.manifest,
  availableArtifactHashes: [...hydrologyAvailable, compilerContentHash({ unreferencedHydrology: true })].sort(),
})), /not referenced/, "unreferenced hydrology availability hash was accepted");

const wetterMap = fixtureHydrologyMap({ precipitationMmPerYear: 1200 });
const wetter = compileWorldTerrain(hydrologyInput(wetterMap, [], [], {
  previousSnapshot: hydrologyCold.snapshot,
  previousManifest: hydrologyCold.manifest,
  availableArtifactHashes: hydrologyAvailable,
}));
assert(wetter.artifacts.length === 2 && wetter.artifacts.every((artifact: any) => artifact.scope === "global"),
  "precipitation edit did not emit exactly both hydrology globals");
assert(wetter.reusedArtifacts.length === hydrologyCold.manifest.chunks.length + 2, "precipitation edit did not reuse all terrain chunks, navigation, and overview");
assert(wetter.snapshot.stageKeys.render[hydrologyCold.manifest.chunks[0].chunkId] === hydrologyCold.snapshot.stageKeys.render[hydrologyCold.manifest.chunks[0].chunkId], "precipitation leaked into terrain source identity");

const thresholdMap = fixtureHydrologyMap({ riverMinCatchmentAreaM2: 40_000, waterfallMinDropM: 5 });
const thresholds = compileWorldTerrain(hydrologyInput(thresholdMap, [], [], {
  previousSnapshot: hydrologyCold.snapshot,
  previousManifest: hydrologyCold.manifest,
  availableArtifactHashes: hydrologyAvailable,
}));
assert(thresholds.artifacts.length === 1 && thresholds.artifacts[0].artifactType === HYDROLOGY_WATER_ARTIFACT_TYPE,
  "threshold edit did not rebuild only generated water topology");
assert(thresholds.reusedArtifacts.length === hydrologyCold.manifest.chunks.length + 3,
  "threshold edit failed to reuse all chunks and the raw hydrology field");
assert(thresholds.snapshot.stageKeys["hydrology-field"]["@global"] === hydrologyCold.snapshot.stageKeys["hydrology-field"]["@global"],
  "raw-field-irrelevant thresholds changed the hydrology field stage key");
assert(thresholds.snapshot.snapshotHash !== hydrologyCold.snapshot.snapshotHash, "threshold edit did not change generated-water compiler identity");
assert(thresholds.manifest.manifestHash !== hydrologyCold.manifest.manifestHash, "threshold edit was not bound by manifest source identity");

const raisedSeaMap = fixtureHydrologyMap({}, { seaLevel: 1 });
const raisedSea = compileWorldTerrain(hydrologyInput(raisedSeaMap, [], [], {
  previousSnapshot: hydrologyCold.snapshot,
  previousManifest: hydrologyCold.manifest,
  availableArtifactHashes: hydrologyAvailable,
}));
assert(raisedSea.artifacts.length === hydrologyCold.manifest.chunks.length + 3 && raisedSea.reusedArtifacts.length === 1,
  "terrain source edit did not rebuild terrain/hydrology while preserving navigation");

const hydrologyEroded = compileWorldTerrain(hydrologyInput(hydrologyMap, [], [], {
  compiler: { version: WORLD_HYDROLOGY_TERRAIN_COMPILER_VERSION, config: erosionConfig },
  previousSnapshot: hydrologyCold.snapshot,
  previousManifest: hydrologyCold.manifest,
  availableArtifactHashes: hydrologyAvailable,
}));
assert(hydrologyEroded.artifacts.length === hydrologyCold.manifest.chunks.length + 3 && hydrologyEroded.reusedArtifacts.length === 1,
  "erosion edit did not invalidate terrain/hydrology while preserving navigation");

const localHydrologyFirst = compileWorldTerrain(hydrologyInput(hydrologyMap, [localV1], [layerRef(localV1)]));
const localHydrologyAvailable = availableManifestHashes(localHydrologyFirst);
const localHydrologySecond = compileWorldTerrain(hydrologyInput(hydrologyMap, [localV2], [layerRef(localV2)], {
  previousSnapshot: localHydrologyFirst.snapshot,
  previousManifest: localHydrologyFirst.manifest,
  availableArtifactHashes: localHydrologyAvailable,
}));
assert(localHydrologySecond.artifacts.length === 1 && localHydrologySecond.artifacts[0].scope === "chunk", "local edit did not emit exactly its affected terrain chunk");
assert(localHydrologySecond.reusedArtifacts.filter((artifact: any) => artifact.scope === "global").length === 4,
  "local edit incorrectly invalidated global hydrology artifacts");

const legacyToHydrology = compileWorldTerrain(hydrologyInput(hydrologyMap, [], [], {
  previousSnapshot: base.snapshot,
  previousManifest: base.manifest,
  availableArtifactHashes: available,
}));
assert(legacyToHydrology.artifacts.length === base.manifest.chunks.length + 4 && legacyToHydrology.reusedArtifacts.length === 0,
  "legacy-to-hydrology graph transition was not cold");
const priorProfileManifest = clone(hydrologyCold.manifest);
delete priorProfileManifest.manifestHash;
priorProfileManifest.compiler.version = "1.1.0";
const resealedPriorProfileManifest = createDerivedRevisionManifest(priorProfileManifest);
const priorProfileToCurrent = compileWorldTerrain(hydrologyInput(hydrologyMap, [], [], {
  previousSnapshot: hydrologyCold.snapshot,
  previousManifest: resealedPriorProfileManifest,
  availableArtifactHashes: availableManifestHashes({ manifest: resealedPriorProfileManifest }),
}));
assert(priorProfileToCurrent.artifacts.length === hydrologyCold.manifest.chunks.length + 4
  && priorProfileToCurrent.reusedArtifacts.length === 0, "hydrology 1.1-to-1.2 profile migration was not cold");
const hydrologyToLegacy = compileWorldTerrain({
  ...input(),
  previousSnapshot: hydrologyCold.snapshot,
  previousManifest: hydrologyCold.manifest,
  availableArtifactHashes: hydrologyAvailable,
});
assert(hydrologyToLegacy.manifest.manifestHash === base.manifest.manifestHash
  && hydrologyToLegacy.snapshot.snapshotHash === base.snapshot.snapshotHash,
"hydrology-to-default transition did not restore exact default manifest and snapshot output");
assert(hydrologyToLegacy.artifacts.every((artifact: any, index: number) => bytesEqual(artifact.bytes, base.artifacts[index].bytes)), "hydrology-to-default transition changed terrain or overview artifact bytes");

let hydrologyPolls = 0;
compileWorldTerrain(hydrologyInput(hydrologyMap, [], [], { cancellation: { shouldCancel: () => { hydrologyPolls++; return false; } } }));
let cancelledHydrologyPolls = 0;
rejects(() => compileWorldTerrain(hydrologyInput(hydrologyMap, [], [], {
  cancellation: { shouldCancel: () => ++cancelledHydrologyPolls > Math.floor(hydrologyPolls * 0.75) },
})), /world terrain compile cancelled/, "hydrology topology/artifact cancellation was not translated at the compiler boundary");
const hydrologyChunkBytes = hydrologyCold.manifest.chunks.reduce((total: number, chunk: any) => total + chunk.artifacts[0].byteLength, 0);
rejects(() => compileWorldTerrain(hydrologyInput(hydrologyMap, [], [], {
  compiler: { version: WORLD_HYDROLOGY_TERRAIN_COMPILER_VERSION, config: config({ limits: { maxChunks: 4096, maxMasterSamples: 1_050_625, maxArtifactBytes: hydrologyChunkBytes } }) },
})), /artifact bytes exceed cap/, "global hydrology bytes were omitted from the compiler artifact cap");

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

ops.op_log(`p_world_terrain_compile OK: ${base.manifest.chunks.length} canonical chunks + source-fenced overview/navigation globals; deterministic terrain/navigation/overview/water outputs, exact navigation-only invalidation, precipitation/threshold isolation, cold profile transitions, ordered local edits, strict cache/cancellation/resource rejection, and bounded vector work.`);
