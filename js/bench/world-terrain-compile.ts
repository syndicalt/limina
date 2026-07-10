import { createMapTerrainField } from "../src/terrain/map-field.mjs";
import { ops } from "../src/engine.ts";
import { NO_EROSION_RECIPE } from "../src/world/pipeline/erosion.mjs";
import { sha256 } from "../src/world/sha256.mjs";
import { compilerContentHash } from "../src/world/compiler/canonical.mjs";
import { compileWorldTerrain, WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA } from "../src/world/compiler/terrain-compile.ts";
import type { WorldMap } from "../src/world/worldmap.ts";

const EXPECTED_CONTENT_HASH = "52e42440354823b2627b3aea43241815300a7cb6b21b35e49ede1fa96df73211";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`world-terrain-compile benchmark FAIL: ${message}`);
}

function float32LittleEndian(values: Float32Array): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index++) view.setFloat32(index * 4, values[index], true);
  return bytes;
}

async function main(): Promise<void> {
  const assetId = "maps/remnants-of-aethon-grey-field-primary.worldmap.json";
  let bytes;
  try { bytes = ops.op_read_asset(assetId); }
  catch {
    console.log(`world-terrain-compile benchmark SKIP: external benchmark asset '${assetId}' is not installed under the active asset root`);
    return;
  }
  const map = JSON.parse(new TextDecoder().decode(bytes)) as WorldMap;
  assert(map.provenance.contentHash === EXPECTED_CONTENT_HASH, `external WorldMap contentHash ${map.provenance.contentHash} != ${EXPECTED_CONTENT_HASH}`);

  const fieldStarted = performance.now();
  const field = createMapTerrainField({ worldMap: map, seed: 7, baseAmplitude: 12, erosionRecipe: NO_EROSION_RECIPE, gridId: "grey-field.surface" });
  const fieldMs = performance.now() - fieldStarted;
  assert(field.masterRes === 1025, `expected masterRes 1025, got ${field.masterRes}`);
  assert(field.geometry.estimatedWorkUnits === 207_002_969, `indexed work estimate drifted to ${field.geometry.estimatedWorkUnits}`);
  assert(sha256(float32LittleEndian(field.heightsM)) === "0167e78fb6641a036136781b9c46d3967a786b4554675dbf3523ffef651a13ad", "indexed raster changed height bytes");
  assert(sha256(field.paintMat) === "643cfa3a9554dcacd1f2d1a09f50cbb05968f2ceb3d61ff7ab5f69ca434895b9", "indexed raster changed paint material bytes");
  assert(sha256(float32LittleEndian(field.paintW)) === "b70d7202a6f3813ab09f968c4943cce2071305e367e6b4f2c27aec7ea4002352", "indexed raster changed paint weight bytes");
  assert(sha256(field.biomeCell) === "5756492c853c991b7c8439ed156f9581e2d2a940fdfba5d03c69cf18ae6f64a2", "indexed biome pass changed region bytes");

  const compileInput = {
    request: { projectId: "remnants-of-aethon", branchId: "grey-field", revision: 1, headHash: compilerContentHash({ benchmark: "grey-field" }) },
    worldMap: map,
    sourceRefs: {
      mapDocument: { refId: "map-document", refType: "map-document/v1", scope: "global", assetId: "design/maps/grey-field.map.json", contentHash: compilerContentHash({ benchmark: "authoritative-mapdoc" }) },
      designSource: { refId: "design-source", refType: "design-source/v1", scope: "global", assetId: "design/build-inputs/grey-field.json", contentHash: `sha256:${map.provenance.sourceHash}` },
      worldMap: { refId: "world-map", refType: "world-map/v1", scope: "global", assetId: "maps/remnants-of-aethon-grey-field-primary.worldmap.json", contentHash: `sha256:${map.provenance.contentHash}` },
    },
    terrainEditLayers: [],
    terrainEditLayerRefs: [],
    compiler: { version: "1.0.0", config: {
      schema: WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA,
      seed: 7,
      baseAmplitude: 12,
      erosionRecipe: NO_EROSION_RECIPE,
      gridId: "grey-field.surface",
      verticalRange: { minM: -500, maxM: 9000 },
      limits: { maxChunks: 16_384, maxMasterSamples: 1_050_625, maxArtifactBytes: 256 * 1024 * 1024 },
    } },
    previousSnapshot: null,
    cancellation: { shouldCancel: () => false },
  };
  const compileStarted = performance.now();
  const result = compileWorldTerrain(compileInput);
  const compileMs = performance.now() - compileStarted;
  const artifactBytes = result.artifacts.reduce((total, artifact) => total + artifact.bytes.byteLength, 0);
  assert(result.artifacts.length === 6400, `expected 6400 artifacts, got ${result.artifacts.length}`);
  assert(artifactBytes === 174_771_200, `expected 174771200 artifact bytes, got ${artifactBytes}`);
  const availableArtifactHashes = [...new Set(result.artifacts.map((artifact) => artifact.contentHash))].sort();
  const sparseStarted = performance.now();
  const sparse = compileWorldTerrain({
    ...compileInput,
    previousManifest: result.manifest,
    previousSnapshot: result.snapshot,
    availableArtifactHashes,
  });
  const sparseMs = performance.now() - sparseStarted;
  assert(sparse.artifacts.length === 0, `unchanged sparse compile emitted ${sparse.artifacts.length} artifacts`);
  assert(sparse.reusedArtifacts.length === 6400, `unchanged sparse compile reused ${sparse.reusedArtifacts.length} artifacts`);
  assert(sparse.manifest.manifestHash === result.manifest.manifestHash, "sparse reuse changed complete manifest identity");
  console.log(`world-terrain-compile benchmark OK: master ${fieldMs.toFixed(1)}ms; cold ${compileMs.toFixed(1)}ms/174771200 emitted bytes; sparse ${sparseMs.toFixed(1)}ms/0 emitted bytes/6400 reused; 1050625 samples`);
}

await main();
