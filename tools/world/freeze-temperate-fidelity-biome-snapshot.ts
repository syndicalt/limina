import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeBiomeFieldArtifact, encodeBiomeFieldArtifact, BIOME_FIELD_ARTIFACT_TYPE } from "../../js/src/world/compiler/biome-field-artifact.mjs";
import { compilerContentHash, derivedGlobalArtifacts } from "../../js/src/world/compiler/index.mjs";
import {
  compileWorldTerrain,
  WORLD_BIOME_TERRAIN_COMPILER_VERSION,
  WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA,
} from "../../js/src/world/compiler/terrain-compile.ts";
import { DEFAULT_MAP_EROSION_RECIPE } from "../../js/src/world/pipeline/erosion.mjs";
import { WorldMapSchema, verifyWorldMap } from "../../js/src/world/worldmap.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scenePath = path.join(root, "art-direction/temperate-fidelity-scene.json");
const scene = JSON.parse(fs.readFileSync(scenePath, "utf8"));
const mapPath = path.join(root, "assets", scene.map.assetId);
const map = WorldMapSchema.parse(JSON.parse(fs.readFileSync(mapPath, "utf8")));
if (!verifyWorldMap(map).ok) throw new Error("temperate fidelity WorldMap hash is invalid");
const sourceHash = `sha256:${map.provenance.sourceHash}`;
const mapHash = `sha256:${map.provenance.contentHash}`;
if (mapHash !== scene.map.contentHash) throw new Error("temperate fidelity scene map hash drifted");
const output = compileWorldTerrain({
  request: { projectId: "temperate-fidelity", branchId: "main", revision: 1, headHash: compilerContentHash({ mapHash }) },
  worldMap: map,
  sourceRefs: {
    mapDocument: { refId: "map-document", refType: "map-document/v1", scope: "global", assetId: "maps/temperate-fidelity-primary.map.json", contentHash: sourceHash },
    designSource: { refId: "design-source", refType: "design-source/v1", scope: "global", assetId: "maps/temperate-fidelity-primary.source.json", contentHash: sourceHash },
    worldMap: { refId: "world-map", refType: "world-map/v1", scope: "global", assetId: scene.map.assetId, contentHash: mapHash },
  },
  terrainEditLayers: [], terrainEditLayerRefs: [],
  compiler: { version: WORLD_BIOME_TERRAIN_COMPILER_VERSION, config: {
    schema: WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA,
    seed: scene.compiler.seed,
    baseAmplitude: scene.compiler.baseAmplitude,
    erosionRecipe: DEFAULT_MAP_EROSION_RECIPE,
    gridId: scene.compiler.gridId,
    verticalRange: { minM: -32, maxM: 96 },
    limits: { maxChunks: 1024, maxMasterSamples: 1_050_625, maxArtifactBytes: 256 * 1024 * 1024 },
  } },
  previousSnapshot: null,
  cancellation: { shouldCancel: () => false },
});
const descriptor = derivedGlobalArtifacts(output.manifest).find((artifact: any) => artifact.artifactType === BIOME_FIELD_ARTIFACT_TYPE);
const artifact = output.artifacts.find((candidate: any) => candidate.artifactType === BIOME_FIELD_ARTIFACT_TYPE);
if (descriptor === undefined || artifact === undefined || descriptor.contentHash !== artifact.contentHash) {
  throw new Error("temperate fidelity compiler did not publish a canonical biome field");
}
// The frozen field is a production authority for the complete locked WorldMap. A capture-domain
// crop cannot be published as if it covered the full source map: surface/population bindings would
// have two incompatible field authorities outside the camera window. Re-encode the complete
// compiler field so the checked-in bytes remain independently reproducible.
const snapshot = decodeBiomeFieldArtifact(artifact.bytes).field;
const bytes = encodeBiomeFieldArtifact(snapshot);
const decoded = decodeBiomeFieldArtifact(bytes);
const relativePath = "assets/biomes/temperate-fidelity.biome-field.bin";
const outputPath = path.join(root, relativePath);
if (process.argv.includes("--write")) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, bytes);
} else {
  if (!fs.existsSync(outputPath) || !Buffer.from(fs.readFileSync(outputPath)).equals(Buffer.from(bytes))) {
    throw new Error("frozen biome snapshot is absent or stale; rerun with --write");
  }
}
console.log(JSON.stringify({
  assetId: "biomes/temperate-fidelity.biome-field.bin",
  contentHash: decoded.metadata.contentHash,
  byteLength: bytes.byteLength,
  grid: snapshot.grid,
  sourceFieldContentHash: artifact.contentHash,
  sourceManifestHash: output.manifest.manifestHash,
}, null, 2));
