import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { BIOME_FIELD_NONE } from "../src/world/biome-field.mjs";
import {
  biomeFieldArtifactContentHash,
  decodeBiomeFieldArtifact,
  encodeBiomeFieldArtifact,
  BIOME_FIELD_ARTIFACT_TYPE,
} from "../src/world/compiler/biome-field-artifact.mjs";
import { compilerContentHash, derivedGlobalArtifacts } from "../src/world/compiler/index.mjs";
import {
  compileWorldTerrain,
  WORLD_BIOME_TERRAIN_COMPILER_VERSION,
  WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA,
} from "../src/world/compiler/terrain-compile.ts";
import { DEFAULT_MAP_EROSION_RECIPE } from "../src/world/pipeline/erosion.mjs";
import { WorldMapSchema, verifyWorldMap } from "../src/world/worldmap.ts";
import {
  FIXED_CAMERA_REGRESSION_SCHEMA,
  validateFixedCameraRegressionPolicy,
} from "../src/render/fixed-camera-regression.ts";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`p_temperate_fidelity_authority FAIL: ${message}`); }
const mapPath = fileURLToPath(new URL("../../assets/maps/temperate-fidelity-primary.worldmap.json", import.meta.url));
const map = WorldMapSchema.parse(JSON.parse(fs.readFileSync(mapPath, "utf8")));
assert(verifyWorldMap(map).ok, "source-controlled WorldMap content hash is invalid");
assert(map.hydrology !== undefined, "acceptance WorldMap lost hydrology authority");
const sourceHash = `sha256:${map.provenance.sourceHash}`;
const mapHash = `sha256:${map.provenance.contentHash}`;
const output = compileWorldTerrain({
  request: { projectId: "temperate-fidelity", branchId: "main", revision: 1, headHash: compilerContentHash({ mapHash }) },
  worldMap: map,
  sourceRefs: {
    mapDocument: { refId: "map-document", refType: "map-document/v1", scope: "global", assetId: "maps/temperate-fidelity-primary.map.json", contentHash: sourceHash },
    designSource: { refId: "design-source", refType: "design-source/v1", scope: "global", assetId: "maps/temperate-fidelity-primary.source.json", contentHash: sourceHash },
    worldMap: { refId: "world-map", refType: "world-map/v1", scope: "global", assetId: "maps/temperate-fidelity-primary.worldmap.json", contentHash: mapHash },
  },
  terrainEditLayers: [], terrainEditLayerRefs: [],
  compiler: { version: WORLD_BIOME_TERRAIN_COMPILER_VERSION, config: {
    schema: WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA,
    seed: 0x5e7,
    baseAmplitude: 8,
    erosionRecipe: DEFAULT_MAP_EROSION_RECIPE,
    gridId: "temperate-fidelity.surface",
    verticalRange: { minM: -32, maxM: 96 },
    limits: { maxChunks: 1024, maxMasterSamples: 1_050_625, maxArtifactBytes: 256 * 1024 * 1024 },
  } },
  previousSnapshot: null,
  cancellation: { shouldCancel: () => false },
});
const descriptor = derivedGlobalArtifacts(output.manifest).find((artifact: any) => artifact.artifactType === BIOME_FIELD_ARTIFACT_TYPE);
const artifact = output.artifacts.find((candidate: any) => candidate.artifactType === BIOME_FIELD_ARTIFACT_TYPE);
assert(descriptor !== undefined && artifact !== undefined && descriptor.contentHash === artifact.contentHash,
  "compiled acceptance authority did not publish its biome field");
const field = decodeBiomeFieldArtifact(artifact.bytes).field;
const reachable = new Set<string>();
for (let offset = 0; offset < field.indices.length; offset++) {
  if (field.indices[offset] !== BIOME_FIELD_NONE && field.weights[offset] > 0) reachable.add(field.biomeIds[field.indices[offset]]);
}
const ids = [...reachable].sort();
const captureIds = new Set<string>();
for (let row = 0; row < field.grid.rows; row++) for (let col = 0; col < field.grid.cols; col++) {
  const x = field.grid.origin[0] + col * field.grid.cellSizeM, z = field.grid.origin[1] + row * field.grid.cellSizeM;
  if (x < -144 || x > 144 || z < -144 || z > 144) continue;
  for (let rank = 0; rank < field.topN; rank++) {
    const offset = (row * field.grid.cols + col) * field.topN + rank;
    if (field.indices[offset] !== BIOME_FIELD_NONE && field.weights[offset] > 0) captureIds.add(field.biomeIds[field.indices[offset]]);
  }
}
assert([...captureIds].sort().join(",") === "deep-ocean,river,temperate-deciduous-forest",
  `locked capture-domain closure changed: ${[...captureIds].sort().join(",")}`);
const scene = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../art-direction/temperate-fidelity-scene.json", import.meta.url)), "utf8"));
const frozenPath = fileURLToPath(new URL(`../../assets/${scene.biomeSnapshot.assetId}`, import.meta.url));
const frozenBytes = new Uint8Array(fs.readFileSync(frozenPath));
assert(scene.biomeSnapshot.coverage === "complete-world", "scene stopped requiring complete-world biome authority");
const compiledSnapshotBytes = encodeBiomeFieldArtifact(field);
assert(Buffer.from(frozenBytes).equals(Buffer.from(compiledSnapshotBytes)), "frozen complete-world biome field drifted from compiler authority");
assert(biomeFieldArtifactContentHash(frozenBytes) === scene.biomeSnapshot.contentHash,
  "frozen complete-world biome field content hash drifted from scene authority");
assert(ids.includes("temperate-deciduous-forest") && ids.includes("deep-ocean"),
  `acceptance authority lost forest/coastal semantics: ${ids.join(",")}`);
assert(!ids.some((id) => ["badlands", "blighted-waste", "crystal", "floating-island", "glacier", "polar-desert"].includes(id)),
  `acceptance authority leaked broad climate ties: ${ids.join(",")}`);
assert(output.manifest.chunks.length > 0 && output.manifest.compiler.version === WORLD_BIOME_TERRAIN_COMPILER_VERSION,
  "acceptance authority did not compile through the production profile");
const regression = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../art-direction/temperate-fidelity-native-regression.json", import.meta.url)), "utf8"));
assert(regression.schema === "limina.fixed-camera-regression-authority/v1"
  && regression.referenceSetId === "project-gorgon-floor-20260711"
  && regression.cameraRoute === "river-leading-line",
"native regression authority drifted from the locked reference set or acceptance camera");
const regressionPolicy = validateFixedCameraRegressionPolicy(regression.policy);
assert(regressionPolicy.schema === FIXED_CAMERA_REGRESSION_SCHEMA
  && regressionPolicy.maxMeanAbsoluteError <= 1.5
  && regressionPolicy.maxRootMeanSquareError <= 7
  && regressionPolicy.maxLargeChannelFraction <= 0.04
  && regressionPolicy.maxTileMeanAbsoluteError <= 7,
"native regression envelope was loosened beyond the proven repeat-capture tolerance");
console.log(`p_temperate_fidelity_authority OK: ${output.manifest.chunks.length} chunks, reachable=${ids.join(",")}, manifest=${output.manifest.manifestHash}`);
