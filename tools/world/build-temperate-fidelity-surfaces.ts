import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BIOME_LIBRARY_V1 } from "../../js/src/world/biome-library-v1.mjs";
import {
  BIOME_CONTENT_BUNDLE_SCHEMA,
  deriveBiomeContentBundleClosureHash,
} from "../../js/src/world/biome-content-bundle.mjs";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import { biomeRuntimePackContentHash, parseBiomeRuntimePack } from "../../js/src/world/biome-runtime-pack.mjs";
import { createBiomeRuntimePublication } from "../../js/src/world/biome-runtime-publication.mjs";
import { buildBiomeSurfacePlan } from "../../js/src/world/biome-surface-plan.mjs";
import { buildBiomePopulationPlan } from "../../js/src/world/biome-population-plan.mjs";
import { parseBiomePopulationAsset } from "../../js/src/world/biome-population-asset.mjs";
import { sha256 } from "../../js/src/world/sha256.mjs";
import { buildSurfaceCompositeTile } from "../../js/src/world/surface-composite-tile.mjs";
import { BiomeGrassDensitySampler } from "../../js/src/render/biome-grass-density.ts";
import { createCachedBilinearScalarField } from "../../js/src/world/cached-bilinear-scalar-field.ts";
import {
  encodeSurfaceCompositeArtifact,
  decodeSurfaceCompositeArtifact,
  SURFACE_COMPOSITE_ARTIFACT_MEDIA_TYPE,
  SURFACE_COMPOSITE_ARTIFACT_TYPE,
} from "../../js/src/world/compiler/surface-composite-artifact.mjs";
import {
  BIOME_FIELD_ARTIFACT_MEDIA_TYPE,
  BIOME_FIELD_ARTIFACT_TYPE,
  biomeFieldArtifactContentHash,
  decodeBiomeFieldArtifact,
} from "../../js/src/world/compiler/biome-field-artifact.mjs";
import {
  BIOME_POPULATION_ARTIFACT_SCHEMA,
  BIOME_POPULATION_ARTIFACT_TYPE,
  encodeBiomePopulationArtifact,
} from "../../js/src/world/compiler/biome-population-artifact.mjs";
import {
  BIOME_PUBLICATION_INPUT_SCHEMA,
  WORLD_PUBLISHED_BIOME_COMPILER_VERSION,
  publishBiomeTerrainCompilation,
  validateBiomePublicationContentEntries,
} from "../../js/src/world/compiler/biome-publication-compile.mjs";
import { decodeTerrainChunkArtifact } from "../../js/src/world/compiler/terrain-artifact.mjs";
import { DerivedLod0TerrainIndex } from "../../js/src/browser/derived-terrain-index.ts";
import { parseTerrainEditLayer } from "../../js/src/terrain/edit-layer.mjs";
import { compilerContentHash } from "../../js/src/world/compiler/index.mjs";
import { decodeHydrologyWaterArtifact, HYDROLOGY_WATER_ARTIFACT_TYPE } from "../../js/src/world/hydrology-water-artifact.mjs";
import { smoothRiverPresentationReach } from "../../js/src/world/river-presentation-curve.mjs";
import { createDerivedRevisionManifest, derivedArtifactContentHash } from "../../js/src/world/compiler/manifest.mjs";
import {
  compileWorldTerrain,
  WORLD_BIOME_TERRAIN_COMPILER_VERSION,
  WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA,
} from "../../js/src/world/compiler/terrain-compile.ts";
import { DEFAULT_MAP_EROSION_RECIPE } from "../../js/src/world/pipeline/erosion.mjs";
import { WorldMapSchema, verifyWorldMap } from "../../js/src/world/worldmap.ts";
import { loadMaterialPackLayer } from "../material/material-pack-layer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const assetRoot = path.join(root, "assets");
const write = process.argv.includes("--write");
const encoder = new TextEncoder();
// This package was independently audited and found to be the same rejected ribbon-blade visual
// strategy at a denser local tuft count. Never let a stale descriptor silently freeze it into a
// review candidate; the descriptor/runtime-pack must first be repinned to the replacement package.
const REJECTED_GRASS_VISUAL_PACKAGES = new Set(["limina.grass.dense-temperate-groundcover"]);

function readBytes(target: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(target));
}

function readAsset(assetId: string): Uint8Array {
  return readBytes(path.join(assetRoot, assetId));
}

function canonicalJson(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

function writeOrVerify(target: string, bytes: Uint8Array, label: string): void {
  if (write) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    return;
  }
  if (!fs.existsSync(target) || !fs.readFileSync(target).equals(Buffer.from(bytes))) {
    throw new Error(`${label} is absent or stale; rerun with --write`);
  }
}

const scene = JSON.parse(fs.readFileSync(path.join(root, "art-direction/temperate-fidelity-scene.json"), "utf8"));
const map = WorldMapSchema.parse(JSON.parse(fs.readFileSync(path.join(assetRoot, scene.map.assetId), "utf8")));
if (!verifyWorldMap(map).ok) throw new Error("temperate fidelity WorldMap hash is invalid");
const sourceHash = `sha256:${map.provenance.sourceHash}`;
const mapHash = `sha256:${map.provenance.contentHash}`;
const baseCompilerConfig = {
  schema: WORLD_TERRAIN_COMPILER_CONFIG_SCHEMA,
  seed: scene.compiler.seed,
  baseAmplitude: scene.compiler.baseAmplitude,
  erosionRecipe: DEFAULT_MAP_EROSION_RECIPE,
  gridId: scene.compiler.gridId,
  verticalRange: { minM: -32, maxM: 96 },
  limits: { maxChunks: 1024, maxMasterSamples: 1_050_625, maxArtifactBytes: 256 * 1024 * 1024 },
};
const terrainEditLayers = (scene.terrainEditLayers ?? []).map((entry: {
  assetId: string; contentHash: string; layerId: string; baseTopologyHash: string;
}) => {
  const layer = parseTerrainEditLayer(JSON.parse(new TextDecoder().decode(readAsset(entry.assetId))));
  if (layer.contentHash !== entry.contentHash) throw new Error(`terrain edit layer '${entry.assetId}' hash drifted`);
  if (layer.layerId !== entry.layerId) throw new Error(`terrain edit layer '${entry.assetId}' id drifted`);
  if (layer.baseTopology.topologyHash !== entry.baseTopologyHash) throw new Error(`terrain edit layer '${entry.assetId}' topology drifted`);
  return layer;
});
const terrainEditLayerRefs = terrainEditLayers.map((layer: any, index: number) => ({
  refId: `terrain-edit-${index}`,
  refType: "terrain-edit-layer/v1",
  scope: "chunk",
  assetId: scene.terrainEditLayers[index].assetId,
  contentHash: layer.contentHash,
}));
const compiled = compileWorldTerrain({
  request: { projectId: "temperate-fidelity", branchId: "main", revision: 1, headHash: compilerContentHash({ mapHash, terrainEditLayerHashes: terrainEditLayers.map((layer: any) => layer.contentHash) }) },
  worldMap: map,
  sourceRefs: {
    mapDocument: { refId: "map-document", refType: "map-document/v1", scope: "global", assetId: "maps/temperate-fidelity-primary.map.json", contentHash: sourceHash },
    designSource: { refId: "design-source", refType: "design-source/v1", scope: "global", assetId: "maps/temperate-fidelity-primary.source.json", contentHash: sourceHash },
    worldMap: { refId: "world-map", refType: "world-map/v1", scope: "global", assetId: scene.map.assetId, contentHash: mapHash },
  },
  terrainEditLayers, terrainEditLayerRefs,
  compiler: { version: WORLD_BIOME_TERRAIN_COMPILER_VERSION, config: baseCompilerConfig },
  previousSnapshot: null,
  cancellation: { shouldCancel: () => false },
});

const fieldBytes = readAsset(scene.biomeSnapshot.assetId);
const fieldContentHash = biomeFieldArtifactContentHash(fieldBytes);
if (fieldContentHash !== scene.biomeSnapshot.contentHash) throw new Error("frozen biome snapshot hash drifted");
const runtimePackAssetId = "biomes/temperate-fidelity-runtime-pack.json";
const runtimePackBytes = readAsset(runtimePackAssetId);
const runtimePack = parseBiomeRuntimePack(JSON.parse(new TextDecoder().decode(runtimePackBytes)), BIOME_LIBRARY_V1);
const runtimePackContentHash = biomeRuntimePackContentHash(runtimePack, BIOME_LIBRARY_V1);
const runtimePackByteContentHash = portableAssetContentHash(runtimePackBytes);

const populationDescriptors = new Map<string, {
  descriptor: ReturnType<typeof parseBiomePopulationAsset>;
  bytes: Uint8Array;
  contentHash: string;
  licenseSpdx: string;
  sourceUri: string;
}>();
const populationStrata = new Map<string, string>();
for (const biome of runtimePack.biomes) for (const binding of biome.bindings) {
  if (binding.kind !== "vegetation") continue;
  let verified = populationDescriptors.get(binding.assetId);
  if (verified === undefined) {
    const bytes = readAsset(binding.assetId);
    const descriptor = parseBiomePopulationAsset(JSON.parse(new TextDecoder().decode(bytes)));
    const engineHash = portableAssetContentHash(bytes);
    if (descriptor.role !== binding.role || engineHash !== binding.contentHash) {
      throw new Error(`population descriptor '${binding.assetId}' does not fulfill '${binding.role}'`);
    }
    if ((descriptor.backend === "grass-field" || descriptor.backend === "continuous-grass-field")
        && REJECTED_GRASS_VISUAL_PACKAGES.has(descriptor.visualPackageId)) {
      throw new Error(`temperate fidelity publication refuses rejected grass visual package '${descriptor.visualPackageId}'`);
    }
    verified = { descriptor, bytes, contentHash: engineHash, licenseSpdx: binding.licenseId, sourceUri: binding.sourceUri };
    populationDescriptors.set(binding.assetId, verified);
  } else if (verified.contentHash !== binding.contentHash || verified.descriptor.role !== binding.role) {
    throw new Error(`population descriptor '${binding.assetId}' has conflicting runtime-pack bindings`);
  }
  const stratum = verified.descriptor.backend === "grass-field" || verified.descriptor.backend === "continuous-grass-field" ? "ground-cover"
    : verified.descriptor.backend === "tree-population" ? "canopy" : "understory";
  const existingStratum = populationStrata.get(binding.role);
  if (existingStratum !== undefined && existingStratum !== stratum) throw new Error(`population role '${binding.role}' has conflicting ecological strata`);
  populationStrata.set(binding.role, stratum);
}

const runtimePublication = createBiomeRuntimePublication({
  metadataPack: BIOME_LIBRARY_V1,
  fieldArtifactBytes: fieldBytes,
  fieldContentHash,
  runtimePack,
  runtimePackContentHash,
});
// Resolve only descriptors whose exact bytes and portable content hashes were authenticated above.
// The sampler cannot fall back to the host filesystem or silently substitute a stale package.
const grassDensityAssets = {
  resolve(assetId: string) {
    const entry = populationDescriptors.get(assetId);
    if (entry === undefined) throw new Error(`grass density resolver has no verified descriptor '${assetId}'`);
    return { assetId, bytes: entry.bytes, hash: entry.contentHash };
  },
};
const grassDensitySampler = new BiomeGrassDensitySampler(runtimePublication as any, grassDensityAssets as any);
const field = decodeBiomeFieldArtifact(fieldBytes).field;
const surfacePlan = buildBiomeSurfacePlan({ publication: runtimePublication, grid: field.grid });
const layers = await Promise.all(surfacePlan.roles.map((role, index) => loadMaterialPackLayer({
  root: assetRoot, manifestAssetId: role.assetId, expectedContentHash: role.contentHash, width: 512, index,
})));
const grassOverlayRole = "ground/grass-turf";
if (surfacePlan.roles.filter((role) => role.role === grassOverlayRole).length !== 1) {
  throw new Error(`temperate fidelity surface plan must bind '${grassOverlayRole}' exactly once`);
}

const terrainArtifacts = new Map(compiled.artifacts.filter((entry: any) => entry.artifactType === "terrain-chunk/v1")
  .map((entry: any) => [entry.contentHash, entry]));
const terrainIndex = new DerivedLod0TerrainIndex(compiled.manifest.chunks.map((chunk: any) => {
  const descriptor = chunk.artifacts.find((entry: any) => entry.artifactType === "terrain-chunk/v1");
  const artifact: any = terrainArtifacts.get(descriptor.contentHash);
  if (artifact === undefined) throw new Error(`terrain bytes for '${chunk.chunkId}' are unavailable`);
  return { chunk, tile: decodeTerrainChunkArtifact(artifact.bytes).tile };
}), compiled.manifest.grid);

const hydrologyWaterArtifact: any = compiled.artifacts.find((entry: any) => entry.artifactType === HYDROLOGY_WATER_ARTIFACT_TYPE);
if (hydrologyWaterArtifact === undefined) throw new Error("temperate fidelity compile omitted generated-water topology");
const hydrologyWater = decodeHydrologyWaterArtifact(hydrologyWaterArtifact.bytes).topology;
const presentationHydrologyReaches = hydrologyWater.reaches.map((reach: any) => smoothRiverPresentationReach(reach));
const segmentDistance = (x: number, z: number, ax: number, az: number, bx: number, bz: number) => {
  const dx = bx - ax, dz = bz - az, lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSquared));
  return { distance: Math.hypot(x - (ax + dx * t), z - (az + dz * t)), t };
};
const WATER_DISTANCE_INDEX_CELL_M = 12;
const WATER_DISTANCE_INFLUENCE_M = 12;
const waterSegmentIndex = new Map<string, Array<Readonly<{ reach: any; index: number }>>>();
for (const reach of presentationHydrologyReaches) for (let index = 1; index < reach.points.length; index++) {
  const a = reach.points[index - 1], b = reach.points[index];
  const minCellX = Math.floor((Math.min(a[0], b[0]) - WATER_DISTANCE_INFLUENCE_M) / WATER_DISTANCE_INDEX_CELL_M);
  const maxCellX = Math.floor((Math.max(a[0], b[0]) + WATER_DISTANCE_INFLUENCE_M) / WATER_DISTANCE_INDEX_CELL_M);
  const minCellZ = Math.floor((Math.min(a[1], b[1]) - WATER_DISTANCE_INFLUENCE_M) / WATER_DISTANCE_INDEX_CELL_M);
  const maxCellZ = Math.floor((Math.max(a[1], b[1]) + WATER_DISTANCE_INFLUENCE_M) / WATER_DISTANCE_INDEX_CELL_M);
  const entry = Object.freeze({ reach, index });
  for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
    const key = `${cellX}:${cellZ}`, bucket = waterSegmentIndex.get(key) ?? [];
    bucket.push(entry); waterSegmentIndex.set(key, bucket);
  }
}
const waterDistanceM = (x: number, z: number): number => {
  let nearest = Number.POSITIVE_INFINITY;
  const bucket = waterSegmentIndex.get(`${Math.floor(x / WATER_DISTANCE_INDEX_CELL_M)}:${Math.floor(z / WATER_DISTANCE_INDEX_CELL_M)}`) ?? [];
  for (const { reach, index } of bucket) {
    const hit = segmentDistance(x, z, reach.points[index - 1][0], reach.points[index - 1][1], reach.points[index][0], reach.points[index][1]);
    const width = reach.widths[index - 1] + (reach.widths[index] - reach.widths[index - 1]) * hit.t;
    nearest = Math.min(nearest, Math.max(0, hit.distance - width * 0.5));
  }
  // The index only stores segments capable of affecting the widest 12 m environmental band.
  // Return a bounded just-outside value rather than infinity: ecological rules commonly use
  // [0,100000] to mean unrestricted, and must not be rejected merely because no nearby segment
  // needed indexing.
  return Number.isFinite(nearest) ? nearest : WATER_DISTANCE_INFLUENCE_M + 1;
};
const environmentLatticeCache = new Map<string, Readonly<{ elevationM: number; slope01: number }>>();
const ecologicalLatticeStep = compiled.manifest.grid.chunkSizeM / (compiled.manifest.grid.defaultSamples - 1);
const grassDensityField = createCachedBilinearScalarField({
  origin: compiled.manifest.grid.origin,
  step: ecologicalLatticeStep,
  sampleLattice: (x, z) => grassDensitySampler.sample(x, z),
});
const sampleGrassDensity = (x: number, z: number): number => {
  // Water ownership remains exact at the material texel. Away from water, reconstruct the
  // compiler's 1.5 m ecological lattice continuously. Nearest-lattice snapping repeated each
  // density value over an 8x8 block of 18.75 cm material texels and exposed the splat grid.
  if (waterDistanceM(x, z) === 0) return 0;
  return grassDensityField.sample(x, z);
};
const sampleEnvironmentLattice = (qx: number, qz: number) => {
  const key = `${qx}:${qz}`;
  const cached = environmentLatticeCache.get(key); if (cached !== undefined) return cached;
  const elevationM = terrainIndex.sampleHeight(qx, qz);
  if (elevationM === null) {
    const outside = Object.freeze({ elevationM: 0, slope01: 0 });
    environmentLatticeCache.set(key, outside); return outside;
  }
  const step = 1;
  const x0 = terrainIndex.sampleHeight(qx - step, qz) ?? elevationM;
  const x1 = terrainIndex.sampleHeight(qx + step, qz) ?? elevationM;
  const z0 = terrainIndex.sampleHeight(qx, qz - step) ?? elevationM;
  const z1 = terrainIndex.sampleHeight(qx, qz + step) ?? elevationM;
  const sampled = Object.freeze({ elevationM, slope01: Math.min(1, Math.hypot((x1 - x0) / (2 * step), (z1 - z0) / (2 * step))) });
  environmentLatticeCache.set(key, sampled); return sampled;
};
const elevationField = createCachedBilinearScalarField({ origin: compiled.manifest.grid.origin,
  step: ecologicalLatticeStep, sampleLattice: (x, z) => sampleEnvironmentLattice(x, z).elevationM });
const slopeField = createCachedBilinearScalarField({ origin: compiled.manifest.grid.origin,
  step: ecologicalLatticeStep, sampleLattice: (x, z) => sampleEnvironmentLattice(x, z).slope01 });
const sampleEditedEnvironment = (x: number, z: number) => {
  // Reconstruct the authoritative 1.5 m terrain lattice continuously. Nearest-cell masks produced
  // the large pale splat plateaus visible beneath otherwise randomized mid-field grass.
  return Object.freeze({ elevationM: elevationField.sample(x, z), slope01: slopeField.sample(x, z),
    waterDistanceM: waterDistanceM(x, z) });
};

const surfaceDirectory = path.join(assetRoot, "derived/temperate-fidelity/surfaces");
const surfaceByChunk = new Map<string, { bytes: Uint8Array; descriptor: any; assetId: string; maps: unknown }>();
for (const chunk of compiled.manifest.chunks) {
  const originX = compiled.manifest.grid.origin[0] + chunk.tx * compiled.manifest.grid.chunkSizeM;
  const originZ = compiled.manifest.grid.origin[1] + chunk.tz * compiled.manifest.grid.chunkSizeM;
  const maxX = originX + compiled.manifest.grid.chunkSizeM;
  const maxZ = originZ + compiled.manifest.grid.chunkSizeM;
  const terrain = chunk.artifacts.find((entry: any) => entry.artifactType === "terrain-chunk/v1");
  if (terrain === undefined || !terrainArtifacts.has(terrain.contentHash)) throw new Error(`terrain artifact for '${chunk.chunkId}' is unavailable`);
  const tile = buildSurfaceCompositeTile({
    plan: surfacePlan,
    layers,
    terrainChunkHash: terrain.contentHash,
    environmentHash: hydrologyWaterArtifact.contentHash,
    tile: { tx: chunk.tx, tz: chunk.tz, lod: chunk.lod, origin: [originX, originZ], sizeM: compiled.manifest.grid.chunkSizeM },
    featureOrigin: [0, 0],
    interior: 256,
    gutter: 1,
    edgePolicy: "clamp",
    sampleEnvironment: sampleEditedEnvironment,
    sampleGrassDensity,
    grassOverlayRole,
  });
  const bytes = encodeSurfaceCompositeArtifact(tile);
  const decoded = decodeSurfaceCompositeArtifact(bytes);
  const filename = `${chunk.chunkId.replaceAll(":", "_")}.surface.bin`;
  const assetId = `derived/temperate-fidelity/surfaces/${filename}`;
  writeOrVerify(path.join(assetRoot, assetId), bytes, `surface artifact '${filename}'`);
  surfaceByChunk.set(chunk.chunkId, {
    bytes,
    assetId,
    descriptor: {
      artifactType: SURFACE_COMPOSITE_ARTIFACT_TYPE,
      mediaType: SURFACE_COMPOSITE_ARTIFACT_MEDIA_TYPE,
      contentHash: derivedArtifactContentHash(bytes),
      byteLength: bytes.byteLength,
    },
    maps: Object.fromEntries(Object.entries(decoded.maps).map(([name, value]: any) => [name, value.contentHash])),
  });
}
const frozenChunks = compiled.manifest.chunks.filter((chunk: any) => surfaceByChunk.has(chunk.chunkId));
if (frozenChunks.length < 1) throw new Error("frozen capture domain contains no compiler chunks");

const publicationBounds = {
  minX: Math.min(...frozenChunks.map((chunk: any) => compiled.manifest.grid.origin[0] + chunk.tx * compiled.manifest.grid.chunkSizeM)),
  minZ: Math.min(...frozenChunks.map((chunk: any) => compiled.manifest.grid.origin[1] + chunk.tz * compiled.manifest.grid.chunkSizeM)),
  maxX: Math.max(...frozenChunks.map((chunk: any) => compiled.manifest.grid.origin[0] + (chunk.tx + 1) * compiled.manifest.grid.chunkSizeM)),
  maxZ: Math.max(...frozenChunks.map((chunk: any) => compiled.manifest.grid.origin[1] + (chunk.tz + 1) * compiled.manifest.grid.chunkSizeM)),
};

const sampleSurface = (x: number, z: number) => {
  const y = terrainIndex.sampleHeight(x, z); if (y === null) return null;
  const environment = sampleEditedEnvironment(x, z);
  const biome = runtimePublication.sample(x, z);
  const wet = biome?.dominantId === "river" || biome?.dominantId === "deep-ocean";
  return { y, slope01: environment.slope01, moisture01: wet ? 1 : 0.7, waterDistanceM: environment.waterDistanceM };
};
const stratumForRole = (role: string) => {
  const stratum = populationStrata.get(role);
  if (stratum === undefined) throw new Error(`population role '${role}' has no verified ecological stratum`);
  return stratum;
};

// Plan each canonical compiler chunk independently with the same world-anchored grid and a
// max-radius halo. This preserves cross-boundary Matérn decisions while keeping each bounded plan
// below the production candidate cap; a monolithic full-world candidate array is neither needed
// by runtime activation nor safe for large worlds.
const placementsByChunk = new Map<string, any[]>();
const populationPlans = frozenChunks.map((chunk: any) => {
  const minX = compiled.manifest.grid.origin[0] + chunk.tx * compiled.manifest.grid.chunkSizeM;
  const minZ = compiled.manifest.grid.origin[1] + chunk.tz * compiled.manifest.grid.chunkSizeM;
  const plan = buildBiomePopulationPlan({
    publication: runtimePublication,
    seed: scene.compiler.seed,
    bounds: [minX, minZ, minX + compiled.manifest.grid.chunkSizeM, minZ + compiled.manifest.grid.chunkSizeM],
    featureOrigin: [0, 0],
    cellSizeM: 1.5,
    pageSizeM: 48,
    maxRadiusM: 10,
    stratumForRole,
    sampleSurface,
  });
  placementsByChunk.set(chunk.chunkId, [...plan.placements]);
  return { chunkId: chunk.chunkId, plan };
});
runtimePublication.dispose();
const allPlacements = populationPlans.flatMap((entry) => entry.plan.placements)
  .sort((left, right) => left.pageZ - right.pageZ || left.pageX - right.pageX || left.z - right.z || left.x - right.x || left.role.localeCompare(right.role));
const populationPlan = {
  schema: "limina.biome-population-plan-bundle/v1",
  seed: scene.compiler.seed,
  identity: { fieldContentHash, runtimePackContentHash },
  bounds: [publicationBounds.minX, publicationBounds.minZ, publicationBounds.maxX, publicationBounds.maxZ],
  chunks: populationPlans.map((entry) => ({ chunkId: entry.chunkId, candidates: entry.plan.candidates, placements: entry.plan.placements.length })),
  placements: allPlacements,
};
writeOrVerify(path.join(assetRoot, "derived/temperate-fidelity/population-plan.json"), canonicalJson(populationPlan), "population plan bundle");
const populationByChunk = new Map<string, { bytes: Uint8Array; descriptor: any; assetId: string }>();
for (const chunk of frozenChunks) {
  const bytes = encodeBiomePopulationArtifact({
    schema: BIOME_POPULATION_ARTIFACT_SCHEMA,
    coord: { tx: chunk.tx, tz: chunk.tz, lod: chunk.lod },
    identity: { fieldContentHash, runtimePackContentHash },
    placements: placementsByChunk.get(chunk.chunkId)!.map((placement) => ({
      role: placement.role, assetId: placement.assetId, contentHash: placement.contentHash,
      x: placement.x, y: placement.y, z: placement.z, yaw: placement.yaw, scale: placement.scale,
      pageX: placement.pageX, pageZ: placement.pageZ,
    })),
  });
  const filename = `${chunk.chunkId.replaceAll(":", "_")}.population.bin`;
  const assetId = `derived/temperate-fidelity/population/${filename}`;
  writeOrVerify(path.join(assetRoot, assetId), bytes, `population artifact '${filename}'`);
  populationByChunk.set(chunk.chunkId, {
    bytes,
    assetId,
    descriptor: {
      artifactType: BIOME_POPULATION_ARTIFACT_TYPE,
      mediaType: "application/vnd.limina.biome-population-plan-v1",
      contentHash: derivedArtifactContentHash(bytes),
      byteLength: bytes.byteLength,
    },
  });
}

const roleCounts = Object.fromEntries([...new Set(populationPlan.placements.map((entry: any) => entry.role))].sort()
  .map((role) => [role, populationPlan.placements.filter((entry: any) => entry.role === role).length]));
const mechanicalEvidenceBytes = canonicalJson({
  schema: "limina.temperate-fidelity-mechanical-evidence/v1",
  status: "candidate-mechanical-only",
  fieldContentHash,
  runtimePackContentHash,
  runtimePackByteContentHash,
  sourceManifestHash: compiled.manifest.manifestHash,
  chunks: frozenChunks.length,
  populationPlacements: populationPlan.placements.length,
  roleCounts,
  invariants: [
    "terrain-surface-population-per-chunk",
    "content-closure-exact-bytes",
    "population-descriptors-package-pinned",
    "normal-map-present-in-every-surface-composite",
  ],
});
const mechanicalEvidenceAssetId = "evidence/temperate-fidelity-mechanical.json";
const mechanicalEvidenceContentHash = portableAssetContentHash(mechanicalEvidenceBytes);
const mechanicalEvidenceIdentity = { assetId: mechanicalEvidenceAssetId, contentHash: mechanicalEvidenceContentHash };
const contentBytesByAssetId = new Map<string, Uint8Array>([[mechanicalEvidenceAssetId, mechanicalEvidenceBytes]]);
const contentEntries: any[] = [{
  assetId: mechanicalEvidenceAssetId,
  contentHash: mechanicalEvidenceContentHash,
  kind: "mechanical-evidence",
  byteLength: mechanicalEvidenceBytes.byteLength,
  provenance: { licenseSpdx: "CC0-1.0", sourceUri: "limina://derived/temperate-fidelity/mechanical-evidence" },
}];

function addContent(assetId: string, expectedHash: string, kind: string, provenance: any, acceptance?: any): void {
  if (contentBytesByAssetId.has(assetId)) {
    const current = contentEntries.find((entry) => entry.assetId === assetId);
    if (current.contentHash !== expectedHash || current.kind !== kind) throw new Error(`content closure collision for '${assetId}'`);
    return;
  }
  const bytes = readAsset(assetId);
  const contentHash = portableAssetContentHash(bytes);
  if (contentHash !== expectedHash) throw new Error(`content bytes for '${assetId}' do not match ${expectedHash}`);
  contentBytesByAssetId.set(assetId, bytes);
  contentEntries.push({ assetId, contentHash, kind, byteLength: bytes.byteLength, provenance, ...(acceptance === undefined ? {} : { acceptance }) });
}

const reachableDescriptors = new Set(populationPlan.placements.map((entry: any) => entry.assetId));
for (const assetId of [...reachableDescriptors].sort()) {
  const pinned = populationDescriptors.get(assetId);
  if (pinned === undefined) throw new Error(`reachable population descriptor '${assetId}' is not pinned by the runtime pack`);
  const provenance = { licenseSpdx: pinned.licenseSpdx, sourceUri: pinned.sourceUri };
  addContent(assetId, pinned.contentHash, "population-descriptor", provenance, { mechanicalEvidence: mechanicalEvidenceIdentity });
  const descriptor: any = pinned.descriptor;
  if (descriptor.backend === "tree-population") {
    addContent(descriptor.sourceAssetId, descriptor.sourceContentHash, "model-source", provenance);
    addContent(descriptor.reducedAssetId, descriptor.reducedContentHash, "model-lod", provenance);
    addContent(descriptor.impostorAssetId, descriptor.impostorContentHash, "impostor", provenance);
  } else if (descriptor.backend === "instanced-asset") {
    addContent(descriptor.assetId, descriptor.contentHash, "model-source", provenance);
  }
}

const surfaceBindings = new Map<string, any>();
for (const biome of runtimePack.biomes) for (const binding of biome.bindings) {
  if (binding.kind === "surface") surfaceBindings.set(binding.assetId, binding);
}
for (const [assetId, binding] of [...surfaceBindings.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  const provenance = { licenseSpdx: binding.licenseId, sourceUri: binding.sourceUri };
  addContent(assetId, binding.contentHash, "material-pack", provenance);
  const materialPack = JSON.parse(new TextDecoder().decode(contentBytesByAssetId.get(assetId)!));
  for (const map of Object.values(materialPack.maps) as any[]) {
    addContent(map.assetId, map.assetHash, "texture", provenance);
  }
}
contentEntries.sort((left, right) => left.assetId.localeCompare(right.assetId));
const bundleDraft = {
  schema: BIOME_CONTENT_BUNDLE_SCHEMA,
  id: "temperate-fidelity-candidate",
  version: "1.0.0",
  status: "candidate",
  runtimePack: { assetId: runtimePackAssetId, contentHash: runtimePackContentHash },
  entries: contentEntries,
};
const contentBundle = { ...bundleDraft, closureHash: deriveBiomeContentBundleClosureHash(bundleDraft) };

const publication = {
  schema: BIOME_PUBLICATION_INPUT_SCHEMA,
  runtimePack: {
    assetId: runtimePackAssetId,
    contentHash: runtimePackContentHash,
    byteContentHash: runtimePackByteContentHash,
    byteLength: runtimePackBytes.byteLength,
    bytes: runtimePackBytes,
  },
  contentBundle,
  chunks: frozenChunks.map((chunk: any) => ({
    chunkId: chunk.chunkId,
    surfaceBytes: surfaceByChunk.get(chunk.chunkId)!.bytes,
    populationBytes: populationByChunk.get(chunk.chunkId)!.bytes,
  })),
};
const validatedContentEntries = validateBiomePublicationContentEntries(publication, contentEntries.map((entry) => ({
  id: entry.assetId,
  path: `assets/${entry.assetId}`,
  hash: entry.contentHash,
  bytes: contentBytesByAssetId.get(entry.assetId),
})));
const published = publishBiomeTerrainCompilation({
  baseCompilation: compiled,
  publication,
  compiler: {
    version: WORLD_PUBLISHED_BIOME_COMPILER_VERSION,
    configHash: compilerContentHash(baseCompilerConfig),
  },
  cancellation: { shouldCancel: () => false },
});

const runtimeRoot = path.join(assetRoot, "derived/temperate-fidelity/runtime");
const artifactByHash = new Map(published.artifacts.map((entry: any) => [entry.contentHash, entry]));
const artifactIndex: any[] = [];
for (const chunk of published.manifest.chunks) {
  for (const descriptor of chunk.artifacts) {
    let assetId: string;
    if (descriptor.artifactType === SURFACE_COMPOSITE_ARTIFACT_TYPE) assetId = surfaceByChunk.get(chunk.chunkId)!.assetId;
    else if (descriptor.artifactType === BIOME_POPULATION_ARTIFACT_TYPE) assetId = populationByChunk.get(chunk.chunkId)!.assetId;
    else {
      const artifact: any = artifactByHash.get(descriptor.contentHash);
      if (artifact === undefined) throw new Error(`published chunk artifact '${descriptor.contentHash}' bytes are unavailable`);
      const filename = `${chunk.chunkId.replaceAll(":", "_")}.${descriptor.artifactType.replaceAll("/", "_")}.bin`;
      assetId = `derived/temperate-fidelity/runtime/chunks/${filename}`;
      writeOrVerify(path.join(assetRoot, assetId), artifact.bytes, `published chunk artifact '${filename}'`);
    }
    artifactIndex.push({ ...descriptor, assetId });
  }
}
for (const descriptor of published.manifest.globalArtifacts) {
  let assetId: string;
  if (descriptor.artifactType === BIOME_FIELD_ARTIFACT_TYPE) assetId = scene.biomeSnapshot.assetId;
  else {
    const artifact: any = artifactByHash.get(descriptor.contentHash);
    if (artifact === undefined) throw new Error(`published global '${descriptor.artifactType}' bytes are unavailable`);
    const filename = `${descriptor.artifactType.replaceAll("/", "_")}.bin`;
    assetId = `derived/temperate-fidelity/runtime/global/${filename}`;
    writeOrVerify(path.join(assetRoot, assetId), artifact.bytes, `published global '${filename}'`);
  }
  artifactIndex.push({ ...descriptor, assetId });
}
artifactIndex.sort((left, right) => left.contentHash.localeCompare(right.contentHash));

const runtimePackPublishedAssetId = `derived/temperate-fidelity/runtime/content/${runtimePackByteContentHash.slice(7)}.bin`;
writeOrVerify(path.join(assetRoot, runtimePackPublishedAssetId), runtimePackBytes, "published runtime-pack bytes");
const contentIndex = validatedContentEntries.map((entry: any) => {
  const assetId = `derived/temperate-fidelity/runtime/content/${entry.hash.slice(7)}.bin`;
  writeOrVerify(path.join(assetRoot, assetId), entry.bytes, `published content '${entry.id}'`);
  const closure = contentEntries.find((candidate) => candidate.assetId === entry.id);
  return { sourceAssetId: entry.id, contentHash: entry.hash, byteLength: entry.bytes.byteLength, kind: closure.kind, assetId };
}).sort((left, right) => left.sourceAssetId.localeCompare(right.sourceAssetId));

const runtimeBundle = {
  schema: "limina.temperate-fidelity-runtime-bundle/v3",
  manifest: published.manifest,
  residency: { schema: "limina.derived-terrain-residency/v1", center: [0, 0], lod: 0, radius: 2 },
  baseCompiler: {
    version: WORLD_BIOME_TERRAIN_COMPILER_VERSION,
    config: baseCompilerConfig,
    configHash: compilerContentHash(baseCompilerConfig),
    graphHash: compiled.manifest.compiler.graphHash,
  },
  coverage: { kind: "complete-world", bounds: publicationBounds, chunks: frozenChunks.length },
  artifactIndex,
  contentIndex,
  runtimePack: {
    sourceAssetId: runtimePackAssetId,
    contentHash: runtimePackContentHash,
    byteContentHash: runtimePackByteContentHash,
    byteLength: runtimePackBytes.byteLength,
    assetId: runtimePackPublishedAssetId,
  },
};
writeOrVerify(path.join(runtimeRoot, "bundle.json"), canonicalJson(runtimeBundle), "runtime bundle");

const surfaceBundle = {
  schema: "limina.temperate-fidelity-surface-bundle/v2",
  fieldContentHash,
  runtimePackContentHash,
  sourceManifestHash: compiled.manifest.manifestHash,
  publishedManifestHash: published.manifest.manifestHash,
  grid: published.manifest.grid,
  chunks: published.manifest.chunks.map((chunk: any) => ({
    chunkId: chunk.chunkId,
    tx: chunk.tx,
    tz: chunk.tz,
    terrainContentHash: chunk.artifacts.find((entry: any) => entry.artifactType === "terrain-chunk/v1").contentHash,
    surface: { ...surfaceByChunk.get(chunk.chunkId)!.descriptor, assetId: surfaceByChunk.get(chunk.chunkId)!.assetId },
    population: { ...populationByChunk.get(chunk.chunkId)!.descriptor, assetId: populationByChunk.get(chunk.chunkId)!.assetId },
    maps: surfaceByChunk.get(chunk.chunkId)!.maps,
  })),
};
writeOrVerify(path.join(assetRoot, "derived/temperate-fidelity/surface-bundle.json"), canonicalJson(surfaceBundle), "surface bundle manifest");

console.log(`build-temperate-fidelity-surfaces OK: published ${published.manifest.compiler.version} ${published.manifest.chunks.length} chunks, ${populationPlan.placements.length} placements ${JSON.stringify(roleCounts)}, closure ${contentBundle.closureHash}`);
