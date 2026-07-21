import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTerrainGridSpec, terrainChunkId } from "../../js/src/terrain/grid.mjs";
import {
  COMPILER_SNAPSHOT_SCHEMA,
  DERIVED_REVISION_MANIFEST_SCHEMA,
  DERIVED_REVISION_MANIFEST_SCHEMA_V1,
  compilerContentHash,
  createDerivedRevisionManifest,
  derivedArtifactContentHash,
} from "../../js/src/world/compiler/index.mjs";
import {
  BIOME_CONTENT_CLOSURE_ARTIFACT_MEDIA_TYPE,
  BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE,
  encodeBiomeContentClosureArtifact,
} from "../../js/src/world/compiler/biome-content-closure-artifact.mjs";
import {
  BIOME_CONTENT_BUNDLE_SCHEMA,
  deriveBiomeContentBundleClosureHash,
} from "../../js/src/world/biome-content-bundle.mjs";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import {
  MAX_STALE_STAGE_CLEANUPS,
  DERIVED_PUBLICATION_POINTER_SCHEMA,
  DERIVED_PUBLICATION_POINTER_SCHEMA_V1,
  DERIVED_PUBLICATION_LOCK_SCHEMA,
  DERIVED_PUBLICATION_STAGE_SCHEMA,
  PUBLICATION_FAULT_POINTS,
  PUBLICATION_LOCK_STALE_MS,
  PublicationCancelledError,
  PublicationConflictError,
  PublicationStaleError,
  nodePublicationFs,
  publishDerivedRevision,
  readPublishedDerivedRevision,
  verifyPublishedDerivedArtifacts,
} from "./derived-publisher.mjs";

function hash(label) { return compilerContentHash({ label }); }

function projectFixture(createState = true) {
  const root = mkdtempSync(join(tmpdir(), "limina-derived-publisher-"));
  mkdirSync(join(root, "assets"));
  if (createState) mkdirSync(join(root, ".limina"));
  writeFileSync(join(root, "limina.project.json"), `${JSON.stringify({
    schema: "limina-project/1",
    projectId: "grey-field",
    assetRoot: "assets",
    stateDir: ".limina",
  })}\n`);
  return root;
}

function revisionFixture(tag, source = { revision: 7, headHash: hash("head:7") }, artifactTag = tag, options = {}) {
  const bytes = new Uint8Array([...Buffer.from(`artifact:${artifactTag}`, "utf8")]);
  const contentHash = derivedArtifactContentHash(bytes);
  const globalBytes = options.globalArtifactTag === undefined
    ? undefined
    : new Uint8Array([...Buffer.from(`global:${options.globalArtifactTag}`, "utf8")]);
  const globalContentHash = globalBytes === undefined ? undefined : derivedArtifactContentHash(globalBytes);
  const grid = createTerrainGridSpec({ gridId: "grey-field.surface", origin: [0, 0], chunkSizeM: 64, defaultSamples: 65 });
  const chunkId = terrainChunkId(grid.gridId, 0, 0, 0);
  const graphHash = hash("graph:1");
  const snapshotCore = {
    schema: COMPILER_SNAPSHOT_SCHEMA,
    graphHash,
    chunks: [{ chunkId, gridId: grid.gridId, lod: 0, tx: 0, tz: 0, chunkTopologyHash: hash("topology:0:0") }],
    stageKeys: { render: { [chunkId]: hash(`render-stage:${tag}`) } },
  };
  const snapshot = { ...snapshotCore, snapshotHash: compilerContentHash(snapshotCore) };
  const manifest = createDerivedRevisionManifest({
    schema: options.schema ?? DERIVED_REVISION_MANIFEST_SCHEMA,
    projectId: "grey-field",
    branchId: "main",
    source: {
      revision: source.revision,
      headHash: source.headHash,
      contentRefs: [
        { refId: "map-document", refType: "map-document/v1", scope: "global", assetId: "design/maps/grey-field.json", contentHash: hash("map:7") },
        { refId: "terrain-edits", refType: "terrain-edit-layer/v1", scope: "chunk", assetId: "terrain/edit-layers/primary.json", contentHash: hash("edits:index:7") },
      ],
    },
    compiler: {
      version: "1.0.0",
      configHash: hash(`config:${tag}`),
      graphHash,
      snapshotHash: snapshot.snapshotHash,
    },
    grid,
    ...(options.schema === DERIVED_REVISION_MANIFEST_SCHEMA_V1 ? {} : { globalArtifacts: globalBytes === undefined ? [] : [{
      artifactType: "hydrology-field/v1",
      contentHash: globalContentHash,
      byteLength: globalBytes.byteLength,
      mediaType: "application/vnd.limina.hydrology-field",
    }] }),
    chunks: [{
      chunkId,
      gridId: grid.gridId,
      lod: 0,
      tx: 0,
      tz: 0,
      topologyHash: hash("topology:0:0"),
      sourceSliceHashes: [{ refId: "terrain-edits", contentHash: hash("edits:0:0:7") }],
      artifacts: [{ artifactType: "render-mesh/v1", contentHash, byteLength: bytes.byteLength, mediaType: "model/gltf-binary" }],
    }],
  });
  return {
    manifest,
    artifacts: [{ contentHash, bytes }, ...(globalBytes === undefined ? [] : [{ contentHash: globalContentHash, bytes: globalBytes }])],
    snapshot,
    globalBytes,
    globalContentHash,
  };
}

function authoritative(source = { revision: 7, headHash: hash("head:7") }) {
  return { projectId: "grey-field", branchId: "main", revision: source.revision, headHash: source.headHash };
}

function pointerPath(root) { return join(root, ".limina", "derived", "main", "published.json"); }
function manifestPath(root, manifestHash) { return join(root, ".limina", "derived", "main", "manifests", `${manifestHash.slice(7)}.json`); }
function artifactPath(root, contentHash) { return join(root, ".limina", "derived", "main", "artifacts", `${contentHash.slice(7)}.bin`); }
function snapshotPath(root, snapshotHash) { return join(root, ".limina", "derived", "main", "snapshots", `${snapshotHash.slice(7)}.json`); }
function contentPath(root, contentHash) { return join(root, ".limina", "derived", "main", "content", `${contentHash.slice(7)}.bin`); }

async function publish(root, fixture, jobId, overrides = {}) {
  return publishDerivedRevision({
    projectRoot: root,
    jobId,
    ...fixture,
    readHead: async () => authoritative(),
    ...overrides,
  });
}

function withContentClosure(fixture, sourceEntries, status = "candidate") {
  const contentEntries = sourceEntries.map(({ id, bytes }) => ({
    id,
    path: `assets/${id}`,
    hash: portableAssetContentHash(bytes),
    bytes,
  })).sort((left, right) => left.id.localeCompare(right.id));
  const draft = {
    schema: BIOME_CONTENT_BUNDLE_SCHEMA,
    id: `publisher-${fixture.manifest.compiler.configHash.slice(7, 19)}`,
    version: "1.0.0",
    status,
    runtimePack: { assetId: "runtime/temperate.json", contentHash: hash("runtime-pack") },
    entries: contentEntries.map((entry) => ({
      assetId: entry.id,
      contentHash: entry.hash,
      kind: "texture",
      byteLength: entry.bytes.byteLength,
      provenance: { licenseSpdx: "CC0-1.0", sourceUri: `limina://publisher-test/${entry.id}` },
    })),
  };
  const bundle = { ...draft, closureHash: deriveBiomeContentBundleClosureHash(draft) };
  const closureBytes = encodeBiomeContentClosureArtifact(bundle);
  const closureDescriptor = {
    artifactType: BIOME_CONTENT_CLOSURE_ARTIFACT_TYPE,
    contentHash: derivedArtifactContentHash(closureBytes),
    byteLength: closureBytes.byteLength,
    mediaType: BIOME_CONTENT_CLOSURE_ARTIFACT_MEDIA_TYPE,
  };
  const manifest = createDerivedRevisionManifest({
    schema: fixture.manifest.schema,
    projectId: fixture.manifest.projectId,
    branchId: fixture.manifest.branchId,
    source: fixture.manifest.source,
    compiler: fixture.manifest.compiler,
    grid: fixture.manifest.grid,
    globalArtifacts: [...fixture.manifest.globalArtifacts, closureDescriptor]
      .sort((left, right) => left.artifactType.localeCompare(right.artifactType)),
    chunks: fixture.manifest.chunks,
  });
  return {
    ...fixture,
    manifest,
    artifacts: [...fixture.artifacts, { contentHash: closureDescriptor.contentHash, bytes: closureBytes }],
    contentEntries,
    contentBundle: bundle,
  };
}

function reusedDescriptor(fixture) {
  const chunk = fixture.manifest.chunks[0];
  const artifact = chunk.artifacts[0];
  return {
    scope: "chunk",
    chunkId: chunk.chunkId,
    artifactType: artifact.artifactType,
    mediaType: artifact.mediaType,
    contentHash: artifact.contentHash,
    byteLength: artifact.byteLength,
  };
}

function sparseFixture(fixture) {
  return { ...fixture, artifacts: [], reusedArtifacts: [reusedDescriptor(fixture)] };
}

function legacyReusedDescriptor(fixture) {
  const { scope: _scope, ...legacy } = reusedDescriptor(fixture);
  return legacy;
}

function reusedGlobalDescriptor(fixture) {
  const artifact = fixture.manifest.globalArtifacts[0];
  return { scope: "global", ...artifact };
}

function sparseGlobalFixture(fixture) {
  return { ...fixture, artifacts: [fixture.artifacts[0]], reusedArtifacts: [reusedGlobalDescriptor(fixture)] };
}

test("publishes a fully validated current revision and reports source staleness explicitly", async () => {
  const root = projectFixture();
  try {
    const fixture = revisionFixture("first");
    const published = await publish(root, fixture, "job-first");
    assert.equal(published.pointer.generation, 1);
    assert.equal(published.pointer.previous, null);
    const current = await readPublishedDerivedRevision({ projectRoot: root, branchId: "main", readHead: async () => authoritative() });
    assert.equal(current.status, "current");
    assert.equal(current.diagnostics.matchesCurrentSource, true);
    const stale = await readPublishedDerivedRevision({
      projectRoot: root,
      branchId: "main",
      readHead: async () => authoritative({ revision: 8, headHash: hash("head:8") }),
    });
    assert.equal(stale.status, "stale");
    assert.equal(stale.diagnostics.matchesCurrentSource, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("installs closure-authorized content before publication and preserves candidate status without implying release approval", async () => {
  const root = projectFixture();
  try {
    const fixture = withContentClosure(revisionFixture("content-first"), [
      { id: "materials/forest-albedo.bin", bytes: new Uint8Array([1, 2, 3, 4]) },
      { id: "population/oak-descriptor.json", bytes: new TextEncoder().encode('{"backend":"tree-population"}') },
    ]);
    const published = await publish(root, fixture, "job-content-first");
    assert.equal(published.content.status, "candidate");
    assert.equal(published.content.closureHash, fixture.contentBundle.closureHash);
    for (const entry of fixture.contentEntries) {
      assert.deepEqual(new Uint8Array(readFileSync(contentPath(root, entry.hash))), entry.bytes);
    }
    const read = await readPublishedDerivedRevision({ projectRoot: root, branchId: "main", readHead: async () => authoritative() });
    assert.equal(read.content.status, "candidate");
    assert.equal(read.content.closureHash, fixture.contentBundle.closureHash);
    assert.equal(read.status, "current");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects tampered closure-authorized input without changing the prior pointer", async () => {
  const root = projectFixture();
  try {
    await publish(root, revisionFixture("content-tamper-baseline"), "job-content-tamper-baseline");
    const before = readFileSync(pointerPath(root), "utf8");
    const fixture = withContentClosure(revisionFixture("content-tamper"), [
      { id: "models/oak.glb", bytes: new Uint8Array([10, 20, 30, 40]) },
    ]);
    fixture.contentEntries[0] = {
      ...fixture.contentEntries[0],
      bytes: new Uint8Array([10, 20, 30, 41]),
    };
    await assert.rejects(publish(root, fixture, "job-content-tamper"), /content hash mismatch/);
    assert.equal(readFileSync(pointerPath(root), "utf8"), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("revalidates installed closure content at commit and preserves the prior pointer on corruption", async () => {
  const root = projectFixture();
  try {
    await publish(root, revisionFixture("content-commit-baseline"), "job-content-commit-baseline");
    const before = readFileSync(pointerPath(root), "utf8");
    const fixture = withContentClosure(revisionFixture("content-commit-race"), [
      { id: "models/oak-reduced.glb", bytes: new Uint8Array([5, 6, 7, 8]) },
    ]);
    await assert.rejects(publish(root, fixture, "job-content-commit-race", {
      fault: (point) => {
        if (point === "after-manifest-install") {
          writeFileSync(contentPath(root, fixture.contentEntries[0].hash), new Uint8Array([5, 6, 7, 9]));
        }
      },
    }), /biome content.*hash mismatch/i);
    assert.equal(readFileSync(pointerPath(root), "utf8"), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dedupes closure content by engine hash and retains previous revision content after B", async () => {
  const root = projectFixture();
  try {
    const shared = new Uint8Array([7, 7, 7]);
    const previousOnly = new Uint8Array([1, 9, 1]);
    const currentOnly = new Uint8Array([2, 8, 2]);
    const previous = withContentClosure(revisionFixture("content-a"), [
      { id: "shared/a.bin", bytes: shared },
      { id: "shared/b.bin", bytes: shared.slice() },
      { id: "versions/a-only.bin", bytes: previousOnly },
    ]);
    await publish(root, previous, "job-content-a");
    const contentRoot = join(root, ".limina", "derived", "main", "content");
    assert.equal(readdirSync(contentRoot).length, 2, "same-hash closure entries were installed twice");
    const current = withContentClosure(revisionFixture("content-b"), [
      { id: "shared/a.bin", bytes: shared.slice() },
      { id: "versions/b-only.bin", bytes: currentOnly },
    ]);
    await publish(root, current, "job-content-b");
    assert.equal(readdirSync(contentRoot).length, 3, "B removed previous bytes or reinstalled shared content");
    assert.equal(nodePublicationFs.existsSync(contentPath(root, portableAssetContentHash(previousOnly))), true);
    assert.equal(nodePublicationFs.existsSync(contentPath(root, portableAssetContentHash(shared))), true);
    assert.equal(nodePublicationFs.existsSync(contentPath(root, portableAssetContentHash(currentOnly))), true);
    const alreadyInstalled = withContentClosure(revisionFixture("content-c"), [
      { id: "shared/a.bin", bytes: shared.slice() },
      { id: "versions/b-only.bin", bytes: currentOnly.slice() },
    ]);
    delete alreadyInstalled.contentEntries;
    await publish(root, alreadyInstalled, "job-content-c");
    assert.equal(readdirSync(contentRoot).length, 3, "optional content omission reinstalled or removed verified bytes");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reader rejects missing or corrupt closure-authorized installed content", async () => {
  for (const mode of ["missing", "corrupt"]) {
    const root = projectFixture();
    try {
      const bytes = new Uint8Array([4, 3, 2, 1]);
      const fixture = withContentClosure(revisionFixture(`content-${mode}`), [
        { id: "models/fern.glb", bytes },
      ]);
      await publish(root, fixture, `job-content-${mode}`);
      const path = contentPath(root, fixture.contentEntries[0].hash);
      if (mode === "missing") unlinkSync(path);
      else writeFileSync(path, new Uint8Array([4, 3, 2, 0]));
      await assert.rejects(
        readPublishedDerivedRevision({ projectRoot: root, branchId: "main", readHead: async () => authoritative() }),
        mode === "missing" ? /biome content.*missing|content.*missing/i : /biome content.*hash mismatch/i,
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("content corruption falls back to the previous closure without deleting its bytes", async () => {
  const root = projectFixture();
  try {
    const previous = withContentClosure(revisionFixture("content-fallback-a"), [
      { id: "versions/previous.bin", bytes: new Uint8Array([1, 1, 1]) },
    ]);
    const current = withContentClosure(revisionFixture("content-fallback-b"), [
      { id: "versions/current.bin", bytes: new Uint8Array([2, 2, 2]) },
    ]);
    await publish(root, previous, "job-content-fallback-a");
    await publish(root, current, "job-content-fallback-b");
    writeFileSync(contentPath(root, current.contentEntries[0].hash), new Uint8Array([2, 2, 3]));
    const fallback = await readPublishedDerivedRevision({ projectRoot: root, branchId: "main", readHead: async () => authoritative() });
    assert.equal(fallback.status, "fallback");
    assert.equal(fallback.manifest.manifestHash, previous.manifest.manifestHash);
    assert.equal(fallback.content.closureHash, previous.contentBundle.closureHash);
    assert.equal(nodePublicationFs.existsSync(contentPath(root, previous.contentEntries[0].hash)), true);
    assert.match(fallback.diagnostics.currentError, /biome content.*hash mismatch/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects one content hash assigned conflicting media types", async () => {
  const root = projectFixture();
  try {
    const fixture = revisionFixture("media-conflict");
    const { manifestHash: _manifestHash, ...core } = fixture.manifest;
    const chunkArtifact = fixture.manifest.chunks[0].artifacts[0];
    const manifest = createDerivedRevisionManifest({
      ...core,
      globalArtifacts: [{
        ...chunkArtifact,
        artifactType: "hydrology-field/v1",
        mediaType: "application/vnd.limina.hydrology-field",
      }],
    });
    await assert.rejects(
      publish(root, { ...fixture, manifest }, "job-media-conflict"),
      /inconsistent byte lengths or media types/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishes sparse output only after hash-verifying installed reused artifacts", async () => {
  const root = projectFixture();
  try {
    const baseline = revisionFixture("reuse-baseline");
    await publish(root, baseline, "job-reuse-baseline");
    const candidate = revisionFixture("reuse-candidate", undefined, "reuse-baseline");
    assert.deepEqual(verifyPublishedDerivedArtifacts({
      projectRoot: root,
      branchId: "main",
      manifest: candidate.manifest,
      reusedArtifacts: [reusedDescriptor(candidate)],
    }), { verified: true, artifactCount: 1 });
    const published = await publish(root, sparseFixture(candidate), "job-reuse-candidate");
    assert.equal(published.pointer.generation, 2);
    assert.equal(published.pointer.current.snapshotHash, candidate.snapshot.snapshotHash);
    assert.equal(published.pointer.previous.manifestHash, baseline.manifest.manifestHash);
    const read = await readPublishedDerivedRevision({ projectRoot: root, branchId: "main", readHead: async () => authoritative() });
    assert.equal(read.manifest.manifestHash, candidate.manifest.manifestHash);
    assert.equal(read.snapshot.snapshotHash, candidate.snapshot.snapshotHash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("publishes and sparsely reuses a first-class global artifact", async () => {
  const root = projectFixture();
  try {
    const baseline = revisionFixture("global-baseline", undefined, "global-chunk-base", { globalArtifactTag: "hydrology-stable" });
    const global = baseline.manifest.globalArtifacts[0];
    await publish(root, {
      ...baseline,
      artifacts: [baseline.artifacts[0], {
        scope: "global",
        artifactType: global.artifactType,
        mediaType: global.mediaType,
        contentHash: global.contentHash,
        bytes: baseline.globalBytes,
      }],
    }, "job-global-baseline");
    assert.deepEqual(readFileSync(artifactPath(root, baseline.globalContentHash)), Buffer.from(baseline.globalBytes));
    const candidate = revisionFixture("global-candidate", undefined, "global-chunk-next", { globalArtifactTag: "hydrology-stable" });
    assert.deepEqual(verifyPublishedDerivedArtifacts({
      projectRoot: root,
      branchId: "main",
      manifest: candidate.manifest,
      reusedArtifacts: [reusedGlobalDescriptor(candidate)],
    }), { verified: true, artifactCount: 1 });
    const published = await publish(root, sparseGlobalFixture(candidate), "job-global-candidate");
    assert.equal(published.pointer.generation, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy v1 unscoped chunk reuse remains accepted", async () => {
  const root = projectFixture();
  try {
    const baseline = revisionFixture("legacy-reuse-base", undefined, "legacy-stable", { schema: DERIVED_REVISION_MANIFEST_SCHEMA_V1 });
    await publish(root, baseline, "job-legacy-reuse-base");
    const candidate = revisionFixture("legacy-reuse-next", undefined, "legacy-stable", { schema: DERIVED_REVISION_MANIFEST_SCHEMA_V1 });
    const descriptor = legacyReusedDescriptor(candidate);
    assert.deepEqual(verifyPublishedDerivedArtifacts({ projectRoot: root, branchId: "main", manifest: candidate.manifest, reusedArtifacts: [descriptor] }), { verified: true, artifactCount: 1 });
    await publish(root, { ...candidate, artifacts: [], reusedArtifacts: [descriptor] }, "job-legacy-reuse-next");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("global publication rejects missing, forged, corrupt, and symlinked reuse without moving the pointer", async (t) => {
  await t.test("missing and forged descriptors", async () => {
    const root = projectFixture();
    try {
      const baseline = revisionFixture("global-validation-base", undefined, "chunk-base", { globalArtifactTag: "water" });
      await publish(root, baseline, "job-global-validation-base");
      const before = readFileSync(pointerPath(root), "utf8");
      const candidate = revisionFixture("global-validation-next", undefined, "chunk-next", { globalArtifactTag: "water" });
      await assert.rejects(publish(root, { ...candidate, artifacts: [candidate.artifacts[0]], reusedArtifacts: [] }, "job-global-missing"), /missing artifact/);
      const descriptor = reusedGlobalDescriptor(candidate);
      await assert.rejects(publish(root, { ...candidate, artifacts: [candidate.artifacts[0]], reusedArtifacts: [{ ...descriptor, scope: "chunk", chunkId: candidate.manifest.chunks[0].chunkId }] }, "job-global-forged-scope"), /does not match/);
      await assert.rejects(publish(root, { ...candidate, artifacts: [candidate.artifacts[0]], reusedArtifacts: [{ ...descriptor, byteLength: descriptor.byteLength + 1 }] }, "job-global-forged-length"), /does not match/);
      assert.equal(readFileSync(pointerPath(root), "utf8"), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  for (const mode of ["hash", "symlink"]) await t.test(mode, async () => {
    const root = projectFixture();
    const outside = mkdtempSync(join(tmpdir(), "limina-global-reuse-outside-"));
    try {
      const baseline = revisionFixture(`global-${mode}-base`, undefined, "chunk-base", { globalArtifactTag: `water-${mode}` });
      await publish(root, baseline, `job-global-${mode}-base`);
      const before = readFileSync(pointerPath(root), "utf8");
      const path = artifactPath(root, baseline.globalContentHash);
      if (mode === "hash") {
        const corrupt = new Uint8Array(baseline.globalBytes); corrupt[0] ^= 0xff; writeFileSync(path, corrupt);
      } else {
        const target = join(outside, "matching.bin"); writeFileSync(target, baseline.globalBytes); unlinkSync(path); symlinkSync(target, path);
      }
      const candidate = revisionFixture(`global-${mode}-next`, undefined, "chunk-next", { globalArtifactTag: `water-${mode}` });
      await assert.rejects(publish(root, sparseGlobalFixture(candidate), `job-global-${mode}-next`), mode === "hash" ? /hash mismatch/ : /missing or not regular/);
      assert.equal(readFileSync(pointerPath(root), "utf8"), before);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });
});

test("commit-time global corruption preserves the last-known-good pointer", async () => {
  const root = projectFixture();
  try {
    await publish(root, revisionFixture("global-commit-base", undefined, "chunk-base", { globalArtifactTag: "water-base" }), "job-global-commit-base");
    const before = readFileSync(pointerPath(root), "utf8");
    const candidate = revisionFixture("global-commit-next", undefined, "chunk-next", { globalArtifactTag: "water-next" });
    await assert.rejects(publish(root, candidate, "job-global-commit-next", {
      fault(point) {
        if (point === "before-pointer-rename") {
          const corrupt = new Uint8Array(candidate.globalBytes); corrupt[0] ^= 0xff;
          writeFileSync(artifactPath(root, candidate.globalContentHash), corrupt);
        }
      },
    }), /hash mismatch/);
    assert.equal(readFileSync(pointerPath(root), "utf8"), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("targeted reuse verification is cancellable and branch-bound", async () => {
  const root = projectFixture();
  try {
    const baseline = revisionFixture("targeted-verifier");
    await publish(root, baseline, "job-targeted-verifier");
    const options = {
      projectRoot: root,
      branchId: "main",
      manifest: baseline.manifest,
      reusedArtifacts: [reusedDescriptor(baseline)],
    };
    assert.throws(() => verifyPublishedDerivedArtifacts({ ...options, branchId: "other" }), /branchId does not match/);
    assert.throws(() => verifyPublishedDerivedArtifacts({ ...options, shouldCancel: () => true }), PublicationCancelledError);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("sparse reuse rejects corrupt and symlink-swapped cache entries without moving the LKG pointer", async (t) => {
  await t.test("corrupt bytes", async () => {
    const root = projectFixture();
    try {
      const baseline = revisionFixture("reuse-corrupt-base");
      await publish(root, baseline, "job-reuse-corrupt-base");
      const before = readFileSync(pointerPath(root), "utf8");
      const corrupt = new Uint8Array(baseline.artifacts[0].bytes);
      corrupt[0] ^= 0xff;
      writeFileSync(artifactPath(root, baseline.artifacts[0].contentHash), corrupt);
      const candidate = revisionFixture("reuse-corrupt-next", undefined, "reuse-corrupt-base");
      await assert.rejects(publish(root, sparseFixture(candidate), "job-reuse-corrupt-next"), /hash mismatch/);
      assert.equal(readFileSync(pointerPath(root), "utf8"), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  await t.test("no-follow symlink swap", async () => {
    const root = projectFixture();
    const outside = mkdtempSync(join(tmpdir(), "limina-reused-artifact-outside-"));
    try {
      const baseline = revisionFixture("reuse-symlink-base");
      await publish(root, baseline, "job-reuse-symlink-base");
      const before = readFileSync(pointerPath(root), "utf8");
      const target = join(outside, "matching.bin");
      writeFileSync(target, baseline.artifacts[0].bytes);
      const path = artifactPath(root, baseline.artifacts[0].contentHash);
      unlinkSync(path);
      symlinkSync(target, path);
      const candidate = revisionFixture("reuse-symlink-next", undefined, "reuse-symlink-base");
      await assert.rejects(publish(root, sparseFixture(candidate), "job-reuse-symlink-next"), /missing or not regular/);
      assert.equal(readFileSync(pointerPath(root), "utf8"), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
  await t.test("lstat-to-open symlink race", async () => {
    const root = projectFixture();
    const outside = mkdtempSync(join(tmpdir(), "limina-reused-race-outside-"));
    try {
      const baseline = revisionFixture("reuse-race-base");
      await publish(root, baseline, "job-reuse-race-base");
      const target = join(outside, "matching.bin");
      writeFileSync(target, baseline.artifacts[0].bytes);
      const path = artifactPath(root, baseline.artifacts[0].contentHash);
      let swapped = false;
      const racingFs = {
        ...nodePublicationFs,
        openSync(candidate, flags) {
          if (candidate === path && !swapped) {
            swapped = true;
            unlinkSync(path);
            symlinkSync(target, path);
          }
          return nodePublicationFs.openSync(candidate, flags);
        },
      };
      assert.throws(
        () => verifyPublishedDerivedArtifacts({
          projectRoot: root,
          branchId: "main",
          manifest: baseline.manifest,
          reusedArtifacts: [reusedDescriptor(baseline)],
          fs: racingFs,
        }),
        (error) => swapped && (error?.code === "ELOOP" || /symbolic link|not regular/i.test(error?.message ?? "")),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("snapshot sidecars are canonical, pointer-bound, and participate in LKG fallback", async () => {
  const root = projectFixture();
  try {
    const previous = revisionFixture("snapshot-previous");
    const current = revisionFixture("snapshot-current");
    await publish(root, previous, "job-snapshot-previous");
    await publish(root, current, "job-snapshot-current");
    const pointer = JSON.parse(readFileSync(pointerPath(root), "utf8"));
    assert.equal(pointer.schema, DERIVED_PUBLICATION_POINTER_SCHEMA);
    assert.equal(pointer.current.snapshotHash, current.snapshot.snapshotHash);
    assert.equal(JSON.parse(readFileSync(snapshotPath(root, current.snapshot.snapshotHash), "utf8")).snapshotHash, current.snapshot.snapshotHash);
    writeFileSync(snapshotPath(root, current.snapshot.snapshotHash), "{\"truncated\":");
    const fallback = await readPublishedDerivedRevision({ projectRoot: root, branchId: "main", readHead: async () => authoritative() });
    assert.equal(fallback.status, "fallback");
    assert.equal(fallback.manifest.manifestHash, previous.manifest.manifestHash);
    assert.equal(fallback.snapshot.snapshotHash, previous.snapshot.snapshotHash);
    assert.match(fallback.diagnostics.currentError, /snapshot.*invalid/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reader migrates legacy manifest-only pointers without discarding the legacy LKG", async () => {
  const root = projectFixture();
  try {
    const legacy = revisionFixture("legacy-pointer", undefined, "legacy-pointer", { schema: DERIVED_REVISION_MANIFEST_SCHEMA_V1 });
    await assert.rejects(publishDerivedRevision({
      projectRoot: root,
      jobId: "job-implicit-legacy",
      manifest: legacy.manifest,
      artifacts: legacy.artifacts,
      readHead: async () => authoritative(),
    }), /requires a compiler snapshot/);
    await publishDerivedRevision({
      projectRoot: root,
      jobId: "job-legacy-pointer",
      manifest: legacy.manifest,
      artifacts: legacy.artifacts,
      allowLegacyManifestOnly: true,
      readHead: async () => authoritative(),
    });
    assert.equal(JSON.parse(readFileSync(pointerPath(root), "utf8")).schema, DERIVED_PUBLICATION_POINTER_SCHEMA_V1);
    const legacyRead = await readPublishedDerivedRevision({ projectRoot: root, branchId: "main", readHead: async () => authoritative() });
    assert.equal(legacyRead.snapshot, null);
    const validLegacyPointer = readFileSync(pointerPath(root), "utf8");
    const forgedLegacyPointer = JSON.parse(validLegacyPointer);
    forgedLegacyPointer.current.snapshotHash = legacy.snapshot.snapshotHash;
    writeFileSync(pointerPath(root), `${JSON.stringify(forgedLegacyPointer)}\n`);
    await assert.rejects(
      readPublishedDerivedRevision({ projectRoot: root, branchId: "main", readHead: async () => authoritative() }),
      /manifest reference/,
    );
    writeFileSync(pointerPath(root), validLegacyPointer);

    const current = revisionFixture("legacy-migration-current");
    await publish(root, current, "job-legacy-migration-current");
    const migrated = JSON.parse(readFileSync(pointerPath(root), "utf8"));
    assert.equal(migrated.schema, DERIVED_PUBLICATION_POINTER_SCHEMA);
    assert.deepEqual(Object.keys(migrated.previous), ["manifestHash"]);
    writeFileSync(manifestPath(root, current.manifest.manifestHash), "{\"truncated\":");
    const fallback = await readPublishedDerivedRevision({ projectRoot: root, branchId: "main", readHead: async () => authoritative() });
    assert.equal(fallback.status, "fallback");
    assert.equal(fallback.manifest.manifestHash, legacy.manifest.manifestHash);
    assert.equal(fallback.snapshot, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects a stale build after installation without changing the published pointer", async () => {
  const root = projectFixture();
  try {
    await publish(root, revisionFixture("baseline"), "job-baseline");
    const before = readFileSync(pointerPath(root), "utf8");
    let headReads = 0;
    await assert.rejects(
      publish(root, revisionFixture("stale"), "job-stale", {
        readHead: async () => { headReads++; return authoritative({ revision: 8, headHash: hash("head:8") }); },
      }),
      PublicationStaleError,
    );
    assert.equal(headReads, 1);
    assert.equal(readFileSync(pointerPath(root), "utf8"), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("every injected precommit crash boundary preserves the prior pointer", async () => {
  const root = projectFixture();
  try {
    await publish(root, revisionFixture("baseline"), "job-baseline");
    const before = readFileSync(pointerPath(root), "utf8");
    const candidate = revisionFixture("fault-candidate");
    for (const [index, point] of PUBLICATION_FAULT_POINTS.entries()) {
      await assert.rejects(
        publish(root, candidate, `job-fault-${index}`, {
          fault: (observed) => { if (observed === point) throw new Error(`fault:${point}`); },
        }),
        new RegExp(`fault:${point}`),
      );
      assert.equal(readFileSync(pointerPath(root), "utf8"), before, `${point} changed the prior pointer`);
      assert.equal(readdirSync(join(root, ".limina", "derived", "main", "staging")).length, 0, `${point} leaked its active stage`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("late cancellation preserves the prior pointer and cleans temporary state", async () => {
  const root = projectFixture();
  try {
    await publish(root, revisionFixture("baseline"), "job-baseline");
    const before = readFileSync(pointerPath(root), "utf8");
    let checks = 0;
    await assert.rejects(
      publish(root, revisionFixture("cancelled"), "job-cancelled", { shouldCancel: () => ++checks === 3 }),
      PublicationCancelledError,
    );
    assert.equal(readFileSync(pointerPath(root), "utf8"), before);
    assert.equal(readdirSync(join(root, ".limina", "derived", "main", "staging")).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("two racing jobs use pointer compare-and-swap so exactly one publishes", async () => {
  const root = projectFixture();
  try {
    let releaseWinner;
    let winnerAtHead;
    const reachedHead = new Promise((resolve) => { winnerAtHead = resolve; });
    const firstFs = { ...nodePublicationFs };
    const secondFs = { ...nodePublicationFs };
    const winnerPromise = publish(root, revisionFixture("race-a"), "job-race-a", {
      fs: firstFs,
      readHead: () => new Promise((resolve) => { releaseWinner = resolve; winnerAtHead(); }),
    });
    await reachedHead;
    await assert.rejects(
      publish(root, revisionFixture("race-b"), "job-race-b", { fs: secondFs, readHead: async () => authoritative() }),
      PublicationConflictError,
    );
    releaseWinner(authoritative());
    const winner = await winnerPromise;
    const pointer = JSON.parse(readFileSync(pointerPath(root), "utf8"));
    assert.equal(pointer.current.manifestHash, winner.manifest.manifestHash);
    assert.equal(pointer.generation, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pointer replacement is atomic: observers see the complete old or complete new document", async () => {
  const root = projectFixture();
  try {
    await publish(root, revisionFixture("old"), "job-old");
    const oldRaw = readFileSync(pointerPath(root), "utf8");
    const observations = [];
    const observingFs = {
      ...nodePublicationFs,
      renameSync(source, destination) {
        if (destination === pointerPath(root)) observations.push(readFileSync(destination, "utf8"));
        nodePublicationFs.renameSync(source, destination);
        if (destination === pointerPath(root)) observations.push(readFileSync(destination, "utf8"));
      },
    };
    const result = await publish(root, revisionFixture("new"), "job-new", { fs: observingFs });
    assert.equal(observations.length, 2);
    assert.equal(observations[0], oldRaw);
    const newPointer = JSON.parse(observations[1]);
    assert.equal(newPointer.current.manifestHash, result.manifest.manifestHash);
    assert.equal(newPointer.generation, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reader falls back from a corrupt current manifest without claiming a current-source match", async () => {
  const root = projectFixture();
  try {
    const previous = revisionFixture("previous");
    const current = revisionFixture("current");
    await publish(root, previous, "job-previous");
    await publish(root, current, "job-current");
    writeFileSync(manifestPath(root, current.manifest.manifestHash), "{\"truncated\":");
    const read = await readPublishedDerivedRevision({ projectRoot: root, branchId: "main", readHead: async () => authoritative() });
    assert.equal(read.status, "fallback");
    assert.equal(read.manifest.manifestHash, previous.manifest.manifestHash);
    assert.equal(read.diagnostics.usedFallback, true);
    assert.equal(read.diagnostics.matchesCurrentSource, false);
    assert.match(read.diagnostics.currentError, /invalid|Unexpected end/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reader falls back when a current artifact is missing and fails explicitly when both revisions are corrupt", async () => {
  const root = projectFixture();
  try {
    const previous = revisionFixture("previous-artifact");
    const current = revisionFixture("current-artifact");
    await publish(root, previous, "job-previous");
    await publish(root, current, "job-current");
    unlinkSync(artifactPath(root, current.artifacts[0].contentHash));
    const fallback = await readPublishedDerivedRevision({ projectRoot: root, branchId: "main", readHead: async () => authoritative() });
    assert.equal(fallback.status, "fallback");
    assert.equal(fallback.manifest.manifestHash, previous.manifest.manifestHash);
    unlinkSync(manifestPath(root, previous.manifest.manifestHash));
    await assert.rejects(
      readPublishedDerivedRevision({ projectRoot: root, branchId: "main", readHead: async () => authoritative() }),
      /all published derived revisions are unusable/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reader falls back when the current artifact is truncated or silently corrupted", async () => {
  for (const mode of ["truncated", "corrupt"]) {
    const root = projectFixture();
    try {
      const previous = revisionFixture(`previous-${mode}`);
      const current = revisionFixture(`current-${mode}`);
      await publish(root, previous, `job-previous-${mode}`);
      await publish(root, current, `job-current-${mode}`);
      const bytes = new Uint8Array(current.artifacts[0].bytes);
      if (mode === "truncated") writeFileSync(artifactPath(root, current.artifacts[0].contentHash), bytes.subarray(0, bytes.byteLength - 1));
      else { bytes[0] ^= 0xff; writeFileSync(artifactPath(root, current.artifacts[0].contentHash), bytes); }
      const fallback = await readPublishedDerivedRevision({ projectRoot: root, branchId: "main", readHead: async () => authoritative() });
      assert.equal(fallback.status, "fallback");
      assert.equal(fallback.manifest.manifestHash, previous.manifest.manifestHash);
      assert.match(fallback.diagnostics.currentError, mode === "truncated" ? /byteLength mismatch/ : /hash mismatch/);
      assert.equal(fallback.diagnostics.matchesCurrentSource, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("artifact byte length, content hash, and completeness are validated before publication", async () => {
  const root = projectFixture();
  try {
    const fixture = revisionFixture("validation");
    await assert.rejects(publish(root, { ...fixture, artifacts: [] }, "job-missing"), /missing artifact/);
    await assert.rejects(
      publish(root, { ...fixture, artifacts: [{ ...fixture.artifacts[0], bytes: new Uint8Array([1]) }] }, "job-length"),
      /byteLength mismatch/,
    );
    const wrong = new Uint8Array(fixture.artifacts[0].bytes);
    wrong[0] ^= 0xff;
    await assert.rejects(
      publish(root, { ...fixture, artifacts: [{ ...fixture.artifacts[0], bytes: wrong }] }, "job-hash"),
      /content hash mismatch/,
    );
    assert.equal(nodePublicationFs.existsSync(pointerPath(root)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("re-hashes newly installed artifacts at the pointer commit boundary", async () => {
  const root = projectFixture();
  try {
    const fixture = revisionFixture("supplied-commit-race");
    await assert.rejects(publish(root, fixture, "job-supplied-commit-race", {
      fault: (point) => {
        if (point !== "after-manifest-install") return;
        const corrupted = new Uint8Array(fixture.artifacts[0].bytes);
        corrupted[0] ^= 0xff;
        writeFileSync(artifactPath(root, fixture.artifacts[0].contentHash), corrupted);
      },
    }), /hash mismatch/);
    assert.equal(nodePublicationFs.existsSync(pointerPath(root)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("publication rejects branch traversal and symlink escape attempts", async () => {
  const root = projectFixture();
  const outside = mkdtempSync(join(tmpdir(), "limina-derived-outside-"));
  try {
    await assert.rejects(
      readPublishedDerivedRevision({ projectRoot: root, branchId: "../outside", readHead: async () => authoritative() }),
      /branchId is invalid/,
    );
    mkdirSync(join(root, ".limina", "derived"));
    symlinkSync(outside, join(root, ".limina", "derived", "main"), "dir");
    await assert.rejects(publish(root, revisionFixture("escape"), "job-escape"), /not a real directory|resolves outside/);
    assert.equal(readdirSync(outside).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("stale stage cleanup is age-gated and bounded per publication", async () => {
  const root = projectFixture();
  try {
    const staging = join(root, ".limina", "derived", "main", "staging");
    mkdirSync(staging, { recursive: true });
    const oldSeconds = (Date.now() - 60 * 60 * 1000) / 1000;
    for (let index = 0; index < MAX_STALE_STAGE_CLEANUPS + 4; index++) {
      const path = join(staging, `old-${String(index).padStart(2, "0")}`);
      mkdirSync(path);
      utimesSync(path, oldSeconds, oldSeconds);
    }
    const result = await publish(root, revisionFixture("cleanup"), "job-cleanup");
    assert.equal(result.cleanedStages, MAX_STALE_STAGE_CLEANUPS);
    assert.equal(readdirSync(staging).length, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("creates a missing configured state directory through validated project ancestors", async () => {
  const root = projectFixture(false);
  try {
    const result = await publish(root, revisionFixture("fresh-state"), "job-fresh-state");
    assert.equal(JSON.parse(readFileSync(pointerPath(root), "utf8")).current.manifestHash, result.manifest.manifestHash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reclaims an expired publication lock with bounded owner metadata", async () => {
  const root = projectFixture();
  try {
    const branchRoot = join(root, ".limina", "derived", "main");
    mkdirSync(branchRoot, { recursive: true });
    const nowMs = 2_000_000_000_000;
    writeFileSync(join(branchRoot, "publication.lock"), `${JSON.stringify({
      schema: DERIVED_PUBLICATION_LOCK_SCHEMA,
      jobId: "abandoned-job",
      pid: 999999,
      createdAtMs: nowMs - PUBLICATION_LOCK_STALE_MS - 1,
      ownerToken: "abandoned-owner",
    })}\n`);
    const result = await publish(root, revisionFixture("stale-lock"), "job-stale-lock", { nowMs, isProcessAlive: () => false });
    assert.equal(result.published, true);
    assert.equal(nodePublicationFs.existsSync(join(branchRoot, "publication.lock")), false);
    assert.equal(readdirSync(branchRoot).some((name) => name.startsWith("publication.lock.stale-")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("never steals an expired lock whose local owner process is still alive", async () => {
  const root = projectFixture();
  try {
    const branchRoot = join(root, ".limina", "derived", "main");
    mkdirSync(branchRoot, { recursive: true });
    const nowMs = 2_000_000_000_000;
    const lockPath = join(branchRoot, "publication.lock");
    writeFileSync(lockPath, `${JSON.stringify({
      schema: DERIVED_PUBLICATION_LOCK_SCHEMA,
      jobId: "long-running-job",
      pid: process.pid,
      createdAtMs: nowMs - PUBLICATION_LOCK_STALE_MS - 1,
      ownerToken: "still-live",
    })}\n`);
    await assert.rejects(
      publish(root, revisionFixture("live-old-lock"), "job-contender", { nowMs, isProcessAlive: (pid) => pid === process.pid }),
      PublicationConflictError,
    );
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).ownerToken, "still-live");
    assert.equal(nodePublicationFs.existsSync(pointerPath(root)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("revalidates publication-lock ownership immediately before pointer rename", async () => {
  const root = projectFixture();
  try {
    let resolveHead;
    let reachedHead;
    const atHead = new Promise((resolve) => { reachedHead = resolve; });
    const publishing = publish(root, revisionFixture("owner-swap"), "job-owner-swap", {
      readHead: () => new Promise((resolve) => { resolveHead = resolve; reachedHead(); }),
    });
    await atHead;
    const lockPath = join(root, ".limina", "derived", "main", "publication.lock");
    writeFileSync(lockPath, `${JSON.stringify({
      schema: DERIVED_PUBLICATION_LOCK_SCHEMA,
      jobId: "replacement-owner",
      pid: process.pid,
      createdAtMs: Date.now(),
      ownerToken: "replacement-token",
    })}\n`);
    resolveHead(authoritative());
    await assert.rejects(publishing, /lock ownership changed before commit/);
    assert.equal(nodePublicationFs.existsSync(pointerPath(root)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stale cleanup preserves an old stage owned by a live local process", async () => {
  const root = projectFixture();
  try {
    const nowMs = 2_000_000_000_000;
    const staging = join(root, ".limina", "derived", "main", "staging");
    const activeStage = join(staging, "long-running-stage");
    mkdirSync(activeStage, { recursive: true });
    writeFileSync(join(activeStage, "active.json"), `${JSON.stringify({
      schema: DERIVED_PUBLICATION_STAGE_SCHEMA,
      jobId: "long-running-stage",
      pid: process.pid,
      createdAtMs: nowMs - 60 * 60 * 1000,
      ownerToken: "active-stage-owner",
    })}\n`);
    const oldSeconds = (nowMs - 60 * 60 * 1000) / 1000;
    utimesSync(activeStage, oldSeconds, oldSeconds);
    const result = await publish(root, revisionFixture("active-stage"), "job-active-stage", {
      nowMs,
      isProcessAlive: (pid) => pid === process.pid,
    });
    assert.equal(result.cleanedStages, 0);
    assert.equal(nodePublicationFs.existsSync(activeStage), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unreadable lock fails closed while fresh and is recoverable after the stale bound", async () => {
  const root = projectFixture();
  try {
    const branchRoot = join(root, ".limina", "derived", "main");
    mkdirSync(branchRoot, { recursive: true });
    const lockPath = join(branchRoot, "publication.lock");
    writeFileSync(lockPath, "{\"torn\":");
    const nowMs = Date.now();
    await assert.rejects(
      publish(root, revisionFixture("fresh-torn-lock"), "job-fresh-torn", { nowMs }),
      PublicationConflictError,
    );
    const staleSeconds = (nowMs - PUBLICATION_LOCK_STALE_MS - 1) / 1000;
    utimesSync(lockPath, staleSeconds, staleSeconds);
    const result = await publish(root, revisionFixture("stale-torn-lock"), "job-stale-torn", { nowMs });
    assert.equal(result.published, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
