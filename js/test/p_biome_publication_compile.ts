import { BIOME_LIBRARY_V1 } from "../src/world/biome-library-v1.mjs";
import { biomePackContentHash } from "../src/world/biome-ir.mjs";
import { BIOME_RUNTIME_PACK_LIMITS, BIOME_RUNTIME_PACK_SCHEMA,
  biomeRuntimePackContentHash } from "../src/world/biome-runtime-pack.mjs";
import { compileBiomeField } from "../src/world/biome-field.mjs";
import { BIOME_CONTENT_BUNDLE_SCHEMA, deriveBiomeContentBundleClosureHash } from "../src/world/biome-content-bundle.mjs";
import { portableAssetContentHash } from "../src/world/asset-content-hash.mjs";
import { BIOME_POPULATION_ARTIFACT_SCHEMA, encodeBiomePopulationArtifact } from "../src/world/compiler/biome-population-artifact.mjs";
import { encodeBiomeFieldArtifact, BIOME_FIELD_ARTIFACT_MEDIA_TYPE, BIOME_FIELD_ARTIFACT_TYPE, biomeFieldArtifactContentHash } from "../src/world/compiler/biome-field-artifact.mjs";
import { encodeSurfaceCompositeArtifact } from "../src/world/compiler/surface-composite-artifact.mjs";
import { DERIVED_REVISION_MANIFEST_SCHEMA_V3, createDerivedRevisionManifest,
  derivedArtifactCompilerGraphHash, derivedArtifactContentHash } from "../src/world/compiler/manifest.mjs";
import { COMPILER_SNAPSHOT_SCHEMA } from "../src/world/compiler/planner.mjs";
import { compilerContentHash } from "../src/world/compiler/canonical.mjs";
import { BIOME_PUBLICATION_INPUT_SCHEMA, WORLD_PUBLISHED_BIOME_COMPILER_VERSION,
  publishBiomeTerrainCompilation, validateBiomePublicationContentEntries } from "../src/world/compiler/biome-publication-compile.mjs";
import { SURFACE_COMPOSITE_POLICY_VERSION, SURFACE_COMPOSITE_TILE_SCHEMA } from "../src/world/surface-composite-tile.mjs";
import { sha256 } from "../src/world/sha256.mjs";
import { createTerrainGridSpec, terrainChunkId } from "../src/terrain/grid.mjs";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`p_biome_publication_compile FAIL: ${message}`); }
function rejects(fn: () => unknown, pattern: RegExp, message: string) { let error: unknown; try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`); }
const rawHash = (bytes: Uint8Array) => `sha256:${sha256(bytes)}`;

const field = compileBiomeField({ pack: BIOME_LIBRARY_V1, grid: { origin: [0, 0], rows: 2, cols: 2, cellSizeM: 48 },
  samples: { temperatureC: new Float32Array(4).fill(12), moisture01: new Float32Array(4).fill(0.6),
    elevationM: new Float32Array(4).fill(5), slope01: new Float32Array(4), waterDistanceM: new Float32Array(4).fill(20) },
  influences: [], modifiers: [], topN: 4, climateFeather: { temperatureC: 6, moisture01: 0.2 } });
const fieldBytes = encodeBiomeFieldArtifact(field), fieldHash = biomeFieldArtifactContentHash(fieldBytes);
const runtimePackDocument = { schema: BIOME_RUNTIME_PACK_SCHEMA, id: "publication-runtime", version: "1.0.0",
  metadataPackContentHash: biomePackContentHash(BIOME_LIBRARY_V1), status: "metadata-only",
  biomes: BIOME_LIBRARY_V1.definitions.map((definition) => ({ biomeId: definition.id, status: "metadata-only",
    surfaceRules: definition.surfaceMaterials.slice(0, BIOME_RUNTIME_PACK_LIMITS.surfaceRules)
      .map(({ role }) => ({ role, weight: 1, tileScaleM: 4 })).sort((left, right) => left.role.localeCompare(right.role)),
    vegetationRules: definition.vegetationPalette.slice(0, BIOME_RUNTIME_PACK_LIMITS.vegetationRules)
      .map(({ role, weight }) => ({ role, weight, radiusM: 1.5, density01: 0.5, scale: [0.8, 1.2],
        tintSrgb: [255, 255, 255] })).sort((left, right) => left.role.localeCompare(right.role)), bindings: [] })) };
const runtimePackBytes = new TextEncoder().encode(`${JSON.stringify(runtimePackDocument)}\n`);
const runtimePackHash = biomeRuntimePackContentHash(runtimePackDocument, BIOME_LIBRARY_V1);
const runtimePackByteHash = portableAssetContentHash(runtimePackBytes);
const evidenceBytes = new TextEncoder().encode("mechanical evidence\n"), evidenceHash = portableAssetContentHash(evidenceBytes);
const populationDescriptorBytes = new TextEncoder().encode("population descriptor\n");
const populationDescriptorHash = portableAssetContentHash(populationDescriptorBytes);
const provenance = { licenseSpdx: "CC0-1.0", sourceUri: "limina://test/fixture" };
const draft = { schema: BIOME_CONTENT_BUNDLE_SCHEMA, id: "test-biome-publication", version: "1.0.0", status: "candidate",
  runtimePack: { assetId: "biomes/test-runtime.json", contentHash: runtimePackHash }, entries: [
    { assetId: "evidence/mechanical.txt", contentHash: evidenceHash, kind: "mechanical-evidence", byteLength: evidenceBytes.byteLength, provenance },
    { assetId: "population/grass.json", contentHash: populationDescriptorHash, kind: "population-descriptor",
      byteLength: populationDescriptorBytes.byteLength, provenance,
      acceptance: { mechanicalEvidence: { assetId: "evidence/mechanical.txt", contentHash: evidenceHash } } },
  ] };
const contentBundle = { ...draft, closureHash: deriveBiomeContentBundleClosureHash(draft) };

const grid = createTerrainGridSpec({ gridId: "publication.surface", origin: [0, 0], chunkSizeM: 48, defaultSamples: 33 });
const chunkId = terrainChunkId(grid.gridId, 0, 0, 0), topologyHash = compilerContentHash({ topology: 1 });
const terrainHash = compilerContentHash({ terrain: 1 });
const pixels = 4, albedo = new Uint8Array(pixels * 4).fill(120), normal = new Uint8Array(pixels * 4).fill(128), orm = new Uint8Array(pixels * 4).fill(180);
for (let offset = 3; offset < albedo.length; offset += 4) { albedo[offset] = 255; normal[offset] = 255; orm[offset] = 255; }
const edge = rawHash(Uint8Array.of(1));
const surfaceBytes = encodeSurfaceCompositeArtifact({ schema: SURFACE_COMPOSITE_TILE_SCHEMA,
  source: { biomeFieldHash: fieldHash, biomePackHash: runtimePackHash, terrainChunkHash: terrainHash, policyVersion: SURFACE_COMPOSITE_POLICY_VERSION },
  coord: { tx: 0, tz: 0, lod: 0 }, placement: { origin: [0, 0], sizeM: 48, featureOrigin: [0, 0] },
  resolution: { interior: 2, gutter: 0, total: 2 }, maps: {
    albedo: { data: albedo, contentHash: rawHash(albedo), colorSpace: "srgb" },
    normal: { data: normal, contentHash: rawHash(normal), colorSpace: "none", convention: "opengl-y-plus" },
    orm: { data: orm, contentHash: rawHash(orm), colorSpace: "none", channels: "ao-roughness-metalness-grass-density" },
  }, edgeHashes: { north: edge, east: edge, south: edge, west: edge },
  diagnostics: { roles: 1, runtimeTextureSamples: 3, outputBytes: pixels * 4 * 3 } });
const populationBytes = encodeBiomePopulationArtifact({ schema: BIOME_POPULATION_ARTIFACT_SCHEMA,
  coord: { tx: 0, tz: 0, lod: 0 }, identity: { fieldContentHash: fieldHash, runtimePackContentHash: runtimePackHash },
  placements: [{ role: "flora/grass", assetId: "population/grass.json", contentHash: populationDescriptorHash,
    x: 4, y: 2, z: 5, yaw: 0, scale: 1, pageX: 0, pageZ: 0 }] });

const baseSnapshotCore = { schema: COMPILER_SNAPSHOT_SCHEMA, graphHash: compilerContentHash({ graph: "base" }),
  chunks: [{ chunkId, gridId: grid.gridId, lod: 0, tx: 0, tz: 0, chunkTopologyHash: topologyHash }],
  stageKeys: { render: { [chunkId]: compilerContentHash({ render: 1 }) } } };
const baseSnapshot = { ...baseSnapshotCore, snapshotHash: compilerContentHash(baseSnapshotCore) };
const baseManifest = createDerivedRevisionManifest({ schema: "limina.derived-revision-manifest/v2", projectId: "publication",
  branchId: "main", source: { revision: 1, headHash: compilerContentHash({ head: 1 }), contentRefs: [{ refId: "map-document",
    refType: "map-document/v1", scope: "global", assetId: "maps/source.json", contentHash: compilerContentHash({ source: 1 }) }] },
  compiler: { version: "1.3.0", configHash: compilerContentHash({ config: 1 }), graphHash: baseSnapshot.graphHash, snapshotHash: baseSnapshot.snapshotHash },
  grid, globalArtifacts: [{ artifactType: BIOME_FIELD_ARTIFACT_TYPE, contentHash: fieldHash, byteLength: fieldBytes.byteLength, mediaType: BIOME_FIELD_ARTIFACT_MEDIA_TYPE }],
  chunks: [{ chunkId, gridId: grid.gridId, lod: 0, tx: 0, tz: 0, topologyHash, sourceSliceHashes: [],
    artifacts: [{ artifactType: "terrain-chunk/v1", contentHash: terrainHash, byteLength: 1, mediaType: "application/vnd.limina.terrain-chunk" }] }] });
const baseCompilation = { manifest: baseManifest, snapshot: baseSnapshot,
  artifacts: [{ scope: "global", artifactType: BIOME_FIELD_ARTIFACT_TYPE, mediaType: BIOME_FIELD_ARTIFACT_MEDIA_TYPE, contentHash: fieldHash, bytes: fieldBytes }],
  reusedArtifacts: [], invalidation: {}, diagnostics: [] };
const publication = { schema: BIOME_PUBLICATION_INPUT_SCHEMA,
  runtimePack: { assetId: "biomes/test-runtime.json", contentHash: runtimePackHash,
    byteContentHash: runtimePackByteHash, byteLength: runtimePackBytes.byteLength, bytes: runtimePackBytes },
  contentBundle, chunks: [{ chunkId, surfaceBytes, populationBytes }] };
const contentEntries = validateBiomePublicationContentEntries(publication, [
  { id: "evidence/mechanical.txt", path: "assets/evidence/mechanical.txt", hash: evidenceHash, bytes: evidenceBytes },
  { id: "population/grass.json", path: "assets/population/grass.json", hash: populationDescriptorHash, bytes: populationDescriptorBytes },
]);
assert(contentEntries.length === 2, "exact closure content was not retained");
rejects(() => validateBiomePublicationContentEntries({ ...publication,
  runtimePack: { ...publication.runtimePack, bytes: new Uint8Array(runtimePackBytes.byteLength) } }, [
  { id: "evidence/mechanical.txt", path: "assets/evidence/mechanical.txt", hash: evidenceHash, bytes: evidenceBytes },
  { id: "population/grass.json", path: "assets/population/grass.json", hash: populationDescriptorHash, bytes: populationDescriptorBytes },
]), /runtime pack bytes/, "runtime-pack identity was accepted without its exact bytes");

const output = publishBiomeTerrainCompilation({ baseCompilation, publication,
  compiler: { version: WORLD_PUBLISHED_BIOME_COMPILER_VERSION, configHash: compilerContentHash({ config: "published" }) },
  cancellation: { shouldCancel: () => false } });
assert(output.manifest.compiler.version === "1.4.0", "published profile identity was not installed");
assert(output.manifest.schema === DERIVED_REVISION_MANIFEST_SCHEMA_V3
  && derivedArtifactCompilerGraphHash(output.manifest, BIOME_FIELD_ARTIFACT_TYPE) === baseManifest.compiler.graphHash
  && derivedArtifactCompilerGraphHash(output.manifest, "terrain-chunk/v1") === baseManifest.compiler.graphHash
  && derivedArtifactCompilerGraphHash(output.manifest, "surface-composite-tile/v1") === output.manifest.compiler.graphHash,
"published manifest did not distinguish carried base artifacts from outer-graph presentation artifacts");
assert(output.manifest.globalArtifacts.some((entry: any) => entry.artifactType === "biome-content-closure/v1"), "content closure global is missing");
assert(output.manifest.chunks[0].artifacts.map((entry: any) => entry.artifactType).join(",")
  === "biome-population-plan/v1,surface-composite-tile/v1,terrain-chunk/v1", "chunk is not atomically terrain+surface+population complete");
assert(output.snapshot.stageKeys["biome-content-closure"]["@global"], "closure stage is absent from compiler snapshot");

const changed = new Uint8Array(publication.chunks[0].populationBytes);
changed[112] ^= 1;
const unauthorized = { ...publication, chunks: [{ ...publication.chunks[0], populationBytes: changed }] };
rejects(() => publishBiomeTerrainCompilation({ baseCompilation, publication: unauthorized,
  compiler: { version: WORLD_PUBLISHED_BIOME_COMPILER_VERSION, configHash: compilerContentHash({ config: "published" }) }, cancellation: { shouldCancel: () => false } }),
/integrity/, "tampered population artifact was accepted");

const splitBaseIdentity = { ...baseCompilation,
  snapshot: { ...baseCompilation.snapshot, snapshotHash: compilerContentHash({ split: "snapshot" }) } };
rejects(() => publishBiomeTerrainCompilation({ baseCompilation: splitBaseIdentity, publication,
  compiler: { version: WORLD_PUBLISHED_BIOME_COMPILER_VERSION, configHash: compilerContentHash({ config: "published" }) },
  cancellation: { shouldCancel: () => false } }), /manifest and snapshot disagree on compiler identity/,
"base manifest/snapshot identity split was accepted");

console.log(`p_biome_publication_compile OK: ${output.manifest.manifestHash} atomically publishes terrain, PBR surface, population, and ${contentEntries.length} closure-authorized content entries`);
