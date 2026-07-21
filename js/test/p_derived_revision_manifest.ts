import { ops } from "../src/engine.ts";
import { createTerrainGridSpec, terrainChunkId } from "../src/terrain/grid.mjs";
import {
  DERIVED_REVISION_MANIFEST_SCHEMA,
  DERIVED_REVISION_MANIFEST_SCHEMA_V1,
  DERIVED_REVISION_MANIFEST_SCHEMA_V2,
  DERIVED_REVISION_MANIFEST_SCHEMA_V3,
  MAX_DERIVED_ARTIFACT_BYTES,
  MAX_DERIVED_CHUNKS,
  MAX_GLOBAL_DERIVED_ARTIFACTS,
  MAX_SOURCE_CONTENT_REFS,
  canonicalDerivedRevisionManifest,
  compilerContentHash,
  createDerivedRevisionManifest,
  derivedGlobalArtifacts,
  derivedArtifactCompilerGraphHash,
  derivedArtifactContentHash,
  parseDerivedRevisionManifest,
} from "../src/world/compiler/index.mjs";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_derived_revision_manifest FAIL: ${message}`);
}

function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function hash(label: string): string { return compilerContentHash({ label }); }

const artifactBytes = {
  collision0: new Uint8Array([1, 2, 3]),
  render0: new Uint8Array([4, 5, 6, 7]),
  collision1: new Uint8Array([8, 9]),
  render1: new Uint8Array([10, 11, 12]),
};

function artifact(artifactType: string, bytes: Uint8Array, mediaType: string) {
  return { artifactType, contentHash: derivedArtifactContentHash(bytes), byteLength: bytes.byteLength, mediaType };
}

function manifestInput() {
  const grid = createTerrainGridSpec({ gridId: "grey-field.surface", origin: [-512, -512], chunkSizeM: 64, defaultSamples: 65 });
  const chunk = (tx: number, collision: Uint8Array, render: Uint8Array) => ({
    chunkId: terrainChunkId(grid.gridId, 0, tx, 0),
    gridId: grid.gridId,
    lod: 0,
    tx,
    tz: 0,
    topologyHash: hash(`topology:${tx}`),
    sourceSliceHashes: [{ refId: "terrain-edits", contentHash: hash(`terrain-edits:${tx}`) }],
    artifacts: [
      artifact("collision-mesh/v1", collision, "application/octet-stream"),
      artifact("render-mesh/v1", render, "model/gltf-binary"),
    ],
  });
  const sharedSourceHash = hash("shared-authoritative-document");
  return {
    schema: DERIVED_REVISION_MANIFEST_SCHEMA_V1,
    projectId: "grey-field",
    branchId: "main",
    source: {
      revision: 42,
      headHash: hash("head:42"),
      contentRefs: [
        { refId: "map-document", refType: "map-document/v1", scope: "global", assetId: "design/maps/grey-field.map.json", contentHash: sharedSourceHash },
        { refId: "scene-document", refType: "scene-document/v1", scope: "global", assetId: "design/scenes/grey-field.scene.json", contentHash: sharedSourceHash },
        { refId: "terrain-edits", refType: "terrain-edit-layer/v1", scope: "chunk", assetId: "terrain/edit-layers/primary.json", contentHash: hash("terrain-edit-index") },
      ],
    },
    compiler: {
      version: "1.0.0",
      configHash: hash("compiler-config"),
      graphHash: hash("compiler-graph"),
      snapshotHash: hash("compiler-snapshot"),
    },
    grid,
    chunks: [chunk(0, artifactBytes.collision0, artifactBytes.render0), chunk(1, artifactBytes.collision1, artifactBytes.render1)],
  };
}

function reseal(value: any): any {
  const core = clone(value);
  delete core.manifestHash;
  return { ...core, manifestHash: compilerContentHash(core, { maxBytes: 32 * 1024 * 1024, maxDepth: 12, maxNodes: 1_500_000, maxProperties: 32, maxArrayLength: MAX_DERIVED_CHUNKS }) };
}

const first = createDerivedRevisionManifest(manifestInput());
const second = createDerivedRevisionManifest(clone(manifestInput()));
const firstCanonical = canonicalDerivedRevisionManifest(first);
assert(DERIVED_REVISION_MANIFEST_SCHEMA === DERIVED_REVISION_MANIFEST_SCHEMA_V2, "current derived manifest schema is not v2");
assert(first.manifestHash === "sha256:2a6db95fe7affc8e4e5e798ff8bb8cad8ee15ca92325032ddf909c35c5eed5fa", "v1 manifestHash compatibility lock changed");
assert(firstCanonical.length === 2739, "v1 canonical byte length compatibility lock changed");
assert(compilerContentHash(firstCanonical) === "sha256:503b4997a594bc9ef2b0e74ab3e5fd8cb001e9d25e2d5e9e892a64aa1cb2a0f2", "v1 canonical byte compatibility lock changed");
assert(first.manifestHash === second.manifestHash, "identical input changed manifestHash");
assert(firstCanonical === canonicalDerivedRevisionManifest(second), "identical input changed canonical bytes");
assert(Object.isFrozen(first) && Object.isFrozen(first.source.contentRefs) && Object.isFrozen(first.chunks[0].artifacts), "manifest is not deeply immutable");
const parsedV1 = parseDerivedRevisionManifest(clone(first));
assert(parsedV1.manifestHash === first.manifestHash, "canonical manifest did not round-trip");
assert(!Object.hasOwn(parsedV1, "globalArtifacts"), "v1 manifest was structurally normalized with v2 fields");
const v1Globals = derivedGlobalArtifacts(first);
assert(Object.isFrozen(v1Globals) && v1Globals.length === 0, "v1 global artifact helper did not return the frozen empty view");
rejects(() => derivedGlobalArtifacts(clone(first)), /verified derived revision manifest/, "global artifact helper reparsed an unverified clone");
assert(first.source.contentRefs[0].contentHash === first.source.contentRefs[1].contentHash, "fixture does not prove distinct logical refs may share content");

function v2Input(globals: any[] = []): any {
  return { ...manifestInput(), schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2, globalArtifacts: globals };
}

const hydrologyBytes = new Uint8Array([21, 22, 23, 24]);
const navigationBytes = new Uint8Array([31, 32, 33]);
const hydrology = artifact("hydrology-field/v1", hydrologyBytes, "application/vnd.limina.hydrology-field");
const navigation = artifact("navigation-field/v1", navigationBytes, "application/vnd.limina.navigation-field");
const emptyV2 = createDerivedRevisionManifest(v2Input());
assert(emptyV2.schema === DERIVED_REVISION_MANIFEST_SCHEMA_V2 && emptyV2.globalArtifacts.length === 0, "empty v2 globalArtifacts did not round-trip");
assert(Object.isFrozen(emptyV2.globalArtifacts) && derivedGlobalArtifacts(emptyV2).length === 0, "empty v2 globals are not frozen");
const populatedV2 = createDerivedRevisionManifest(v2Input([hydrology, navigation]));
const populatedGlobals = derivedGlobalArtifacts(populatedV2);
assert(populatedGlobals.length === 2 && populatedGlobals[0].artifactType === "hydrology-field/v1", "populated v2 globals did not round-trip");
assert(Object.isFrozen(populatedGlobals) && Object.isFrozen(populatedGlobals[0]), "populated v2 globals are not deeply frozen");
assert(parseDerivedRevisionManifest(clone(populatedV2)).manifestHash === populatedV2.manifestHash, "populated v2 manifest did not round-trip");

const ancestorGraphHash = hash("compiler-graph:ancestor");
const populatedV3 = createDerivedRevisionManifest({ ...v2Input([hydrology, navigation]),
  schema: DERIVED_REVISION_MANIFEST_SCHEMA_V3,
  artifactAuthorities: [{ artifactType: hydrology.artifactType, compilerGraphHash: ancestorGraphHash }],
});
assert(populatedV3.schema === DERIVED_REVISION_MANIFEST_SCHEMA_V3
  && populatedV3.artifactAuthorities.length === 1
  && derivedArtifactCompilerGraphHash(populatedV3, hydrology.artifactType) === ancestorGraphHash
  && derivedArtifactCompilerGraphHash(populatedV3, navigation.artifactType) === populatedV3.compiler.graphHash,
"v3 did not preserve explicit carried-artifact compiler authority with current-graph fallback");
assert(parseDerivedRevisionManifest(clone(populatedV3)).manifestHash === populatedV3.manifestHash,
  "populated v3 manifest did not round-trip");
rejects(() => createDerivedRevisionManifest({ ...v2Input([hydrology]), schema: DERIVED_REVISION_MANIFEST_SCHEMA_V3,
  artifactAuthorities: [{ artifactType: "missing-artifact/v1", compilerGraphHash: ancestorGraphHash }] }),
/has no published artifact/, "v3 accepted authority for an absent artifact type");
rejects(() => createDerivedRevisionManifest({ ...v2Input([hydrology]), schema: DERIVED_REVISION_MANIFEST_SCHEMA_V3,
  artifactAuthorities: [
    { artifactType: hydrology.artifactType, compilerGraphHash: ancestorGraphHash },
    { artifactType: hydrology.artifactType, compilerGraphHash: ancestorGraphHash },
  ] }), /strictly ordered/, "v3 accepted duplicate artifact compiler authorities");

const changedGlobal = v2Input([{ ...hydrology, contentHash: hash("changed-hydrology") }, navigation]);
assert(createDerivedRevisionManifest(changedGlobal).manifestHash !== populatedV2.manifestHash, "global artifact field change did not change manifestHash");

for (const [globals, pattern, label] of [
  [[navigation, hydrology], /global artifacts must be strictly ordered/, "unordered global artifacts"],
  [[hydrology, hydrology], /global artifacts must be strictly ordered/, "duplicate global artifact types"],
] as const) rejects(() => createDerivedRevisionManifest(v2Input(globals as any[])), pattern, `${label} were accepted`);

const staleGlobalHash = clone(populatedV2);
staleGlobalHash.globalArtifacts[0].byteLength++;
rejects(() => parseDerivedRevisionManifest(staleGlobalHash), /hash mismatch/, "tampered global artifact with stale manifestHash was accepted");

for (const [mutate, pattern, label] of [
  [(value: any) => { value.globalArtifacts[0].contentHash = "SHA256:not-valid"; }, /lowercase sha256/, "malformed global content hash"],
  [(value: any) => { value.globalArtifacts[0].mediaType = "not a media type"; }, /mediaType is invalid/, "malformed global media type"],
  [(value: any) => { value.globalArtifacts[0].byteLength = MAX_DERIVED_ARTIFACT_BYTES + 1; }, /byteLength is out of bounds/, "oversized global artifact"],
] as const) {
  const value = v2Input(clone([hydrology, navigation]));
  mutate(value);
  rejects(() => createDerivedRevisionManifest(value), pattern, `${label} was accepted`);
}

const excessiveGlobals = v2Input(Array.from({ length: MAX_GLOBAL_DERIVED_ARTIFACTS + 1 }, (_unused, index) => ({
  artifactType: `global-${String(index).padStart(3, "0")}/v1`,
  contentHash: hash(`global:${index}`),
  byteLength: 0,
  mediaType: "application/octet-stream",
})));
rejects(() => createDerivedRevisionManifest(excessiveGlobals), /at most 64 entries/, "global artifact count bound was not enforced");

const aggregateAcrossScopes = v2Input(Array.from({ length: 4 }, (_unused, index) => ({
  artifactType: `global-${index}/v1`,
  contentHash: hash(`large-global:${index}`),
  byteLength: MAX_DERIVED_ARTIFACT_BYTES,
  mediaType: "application/octet-stream",
})));
rejects(() => createDerivedRevisionManifest(aggregateAcrossScopes), /resources exceed publication bounds/, "aggregate global+chunk byte bound was not enforced");

const accessorGlobal = v2Input([hydrology]);
Object.defineProperty(accessorGlobal.globalArtifacts[0], "mediaType", { enumerable: true, get: () => "application/octet-stream" });
rejects(() => createDerivedRevisionManifest(accessorGlobal), /enumerable data field/, "global artifact accessor was accepted");
const prototypeGlobal = v2Input([Object.assign(Object.create({ inherited: true }), hydrology)]);
rejects(() => createDerivedRevisionManifest(prototypeGlobal), /plain object/, "global artifact with a custom prototype was accepted");
const symbolGlobal = v2Input([{ ...hydrology }]);
Object.defineProperty(symbolGlobal.globalArtifacts[0], Symbol("hidden"), { value: true, enumerable: true });
rejects(() => createDerivedRevisionManifest(symbolGlobal), /symbol fields/, "global artifact symbol field was accepted");
const accessorSchema = v2Input();
Object.defineProperty(accessorSchema, "schema", { enumerable: true, get: () => DERIVED_REVISION_MANIFEST_SCHEMA_V2 });
rejects(() => createDerivedRevisionManifest(accessorSchema), /enumerable data field/, "manifest schema accessor was accepted");

const staleOuterHash = clone(first);
staleOuterHash.source.revision++;
rejects(() => parseDerivedRevisionManifest(staleOuterHash), /hash mismatch/, "manifest tampering with stale outer hash was accepted");

const malformedInnerHash = clone(first);
malformedInnerHash.chunks[0].artifacts[0].contentHash = "SHA256:not-valid";
rejects(() => parseDerivedRevisionManifest(reseal(malformedInnerHash)), /lowercase sha256/, "rehashed manifest with malformed artifact hash was accepted");

const incompleteSlices = clone(first);
incompleteSlices.chunks[0].sourceSliceHashes = [];
rejects(() => parseDerivedRevisionManifest(reseal(incompleteSlices)), /dependency-incomplete/, "dependency-incomplete chunk was accepted");

const wrongSlice = clone(first);
wrongSlice.chunks[0].sourceSliceHashes[0].refId = "unknown-slice";
rejects(() => parseDerivedRevisionManifest(reseal(wrongSlice)), /dependency-incomplete/, "chunk slice for an undeclared source was accepted");

for (const [mutate, pattern, label] of [
  [(value: any) => value.chunks.reverse(), /chunks must be strictly ordered/, "unordered chunks"],
  [(value: any) => value.source.contentRefs.reverse(), /source refs must be strictly ordered/, "unordered source refs"],
  [(value: any) => value.chunks[0].artifacts.reverse(), /artifacts must be strictly ordered/, "unordered artifacts"],
] as const) {
  const value = clone(first);
  mutate(value);
  rejects(() => parseDerivedRevisionManifest(reseal(value)), pattern, `${label} were accepted`);
}

const wrongChunkId = clone(first);
wrongChunkId.chunks[0].chunkId = terrainChunkId(first.grid.gridId, 0, 9, 0);
rejects(() => parseDerivedRevisionManifest(reseal(wrongChunkId)), /non-canonical chunkId/, "chunk coordinate/id disagreement was accepted");

for (const assetId of ["", "/absolute", "../escape", "design/../escape", "design//map", "design/./map", "design\\map", "C:/map", "design/map file"]) {
  const value = manifestInput();
  value.source.contentRefs[0].assetId = assetId;
  rejects(() => createDerivedRevisionManifest(value), /assetId/, `unsafe assetId '${assetId}' was accepted`);
}

const excessiveRefs = manifestInput();
excessiveRefs.source.contentRefs = Array.from({ length: MAX_SOURCE_CONTENT_REFS + 1 }, (_unused, index) => ({
  refId: `ref${String(index).padStart(3, "0")}`,
  refType: "source/v1",
  scope: "global",
  assetId: `source/${index}.json`,
  contentHash: hash(`source:${index}`),
}));
rejects(() => createDerivedRevisionManifest(excessiveRefs), /1-64 entries/, "source reference resource bound was not enforced");

const excessiveChunks = manifestInput();
excessiveChunks.chunks = Array.from({ length: MAX_DERIVED_CHUNKS + 1 }, () => excessiveChunks.chunks[0]);
rejects(() => createDerivedRevisionManifest(excessiveChunks), /1-16384 entries/, "chunk resource bound was not enforced");

const excessiveArtifactBytes = manifestInput();
excessiveArtifactBytes.chunks = [excessiveArtifactBytes.chunks[0]];
excessiveArtifactBytes.chunks[0].artifacts = Array.from({ length: 5 }, (_unused, index) => ({
  artifactType: `artifact-${index}/v1`,
  contentHash: hash(`large-artifact:${index}`),
  byteLength: MAX_DERIVED_ARTIFACT_BYTES,
  mediaType: "application/octet-stream",
}));
rejects(() => createDerivedRevisionManifest(excessiveArtifactBytes), /resources exceed publication bounds/, "aggregate artifact byte bound was not enforced");

assert(derivedArtifactContentHash(new Uint8Array([1, 2, 3])) === derivedArtifactContentHash(new Uint8Array([1, 2, 3])), "raw artifact hashing is not deterministic");
rejects(() => derivedArtifactContentHash("not bytes" as any), /Uint8Array/, "non-byte artifact was accepted");

ops.op_log(
  "p_derived_revision_manifest OK: locked v1 compatibility, strict v2 globals, and v3 per-artifact compiler authority; immutable manifests bind exact source, compiler, grid, chunk, and artifact identities; tampering and resource exhaustion are rejected.",
);
