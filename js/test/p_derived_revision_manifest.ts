import { ops } from "../src/engine.ts";
import { createTerrainGridSpec, terrainChunkId } from "../src/terrain/grid.mjs";
import {
  DERIVED_REVISION_MANIFEST_SCHEMA,
  MAX_DERIVED_ARTIFACT_BYTES,
  MAX_DERIVED_CHUNKS,
  MAX_SOURCE_CONTENT_REFS,
  canonicalDerivedRevisionManifest,
  compilerContentHash,
  createDerivedRevisionManifest,
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
    schema: DERIVED_REVISION_MANIFEST_SCHEMA,
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
assert(first.manifestHash === second.manifestHash, "identical input changed manifestHash");
assert(canonicalDerivedRevisionManifest(first) === canonicalDerivedRevisionManifest(second), "identical input changed canonical bytes");
assert(Object.isFrozen(first) && Object.isFrozen(first.source.contentRefs) && Object.isFrozen(first.chunks[0].artifacts), "manifest is not deeply immutable");
assert(parseDerivedRevisionManifest(clone(first)).manifestHash === first.manifestHash, "canonical manifest did not round-trip");
assert(first.source.contentRefs[0].contentHash === first.source.contentRefs[1].contentHash, "fixture does not prove distinct logical refs may share content");

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
  "p_derived_revision_manifest OK: immutable canonical manifests bind exact source assets, compiler/grid/chunk dependencies and typed artifacts; tampering, incomplete ordering, path traversal, malformed hashes, and declared resource exhaustion are rejected.",
);
