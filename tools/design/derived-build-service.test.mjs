import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { compilerContentHash } from "../../js/src/world/compiler/canonical.mjs";
import { createTerrainGridSpec, terrainChunkId } from "../../js/src/terrain/grid.mjs";
import { createTerrainEditBaseTopology, createTerrainEditLayer } from "../../js/src/terrain/edit-layer.mjs";
import {
  COMPILER_SNAPSHOT_SCHEMA,
  DERIVED_REVISION_MANIFEST_SCHEMA,
  createDerivedRevisionManifest,
  canonicalCompilerJson,
  derivedArtifactContentHash,
} from "../../js/src/world/compiler/index.mjs";
import { ProjectAssetStore, projectAssetHash } from "../project-asset-store.mjs";
import { readPublishedDerivedRevision } from "./derived-publisher.mjs";
import {
  DerivedBuildService,
  DerivedBuildServiceError,
  bootstrapAuthoritativeMapDoc,
  validateAuthoritySourceSnapshot,
} from "./derived-build-service.mjs";

class BootstrapAuthority {
  constructor(projectId, { revision = 0, mapDoc = null } = {}) {
    this.projectId = projectId;
    this.revision = revision;
    this.mapDoc = mapDoc;
    this.commitCalls = 0;
    this.headHash = compilerContentHash({ bootstrapGenesis: projectId, revision, mapDoc });
    this.previousRecordHash = null;
  }

  snapshot() {
    const snapshot = sourceSnapshot(this.projectId, this.mapDoc, this.revision);
    snapshot.head.headHash = this.headHash;
    const core = { schema: snapshot.schema, head: snapshot.head, projectState: snapshot.projectState };
    snapshot.snapshotHash = compilerContentHash(core);
    return snapshot;
  }

  async callTool(name, args, options) {
    if (name === "authoring.sourceSnapshot") return this.snapshot();
    assert.equal(name, "authoring.commit");
    assert.deepEqual(options, { retryTransport: true });
    this.commitCalls++;
    const transaction = args.transaction;
    if (this.revision !== transaction.baseRevision || this.snapshot().head.headHash !== transaction.baseHeadHash) {
      const error = new Error("stale head");
      error.code = "conflict";
      throw error;
    }
    const previousRevision = this.revision;
    const previousHeadHash = this.headHash;
    const beforeStateHash = this.snapshot().projectState.stateHash;
    this.mapDoc = transaction.operations[0].input.patch.mapDoc;
    this.revision++;
    const transactionHash = compilerContentHash(transaction);
    const afterStateHash = sourceSnapshot(this.projectId, this.mapDoc, this.revision).projectState.stateHash;
    const operations = [{
      index: 0,
      adapter: "project-state",
      action: "refs.patch",
      stateKey: `world-project:${this.projectId}:refs`,
      beforeStateHash,
      afterStateHash,
    }];
    this.headHash = compilerContentHash({
      schema: "limina.world-project-head/v1",
      projectId: this.projectId,
      revision: this.revision,
      parentHash: previousHeadHash,
      transactionHash,
      operations,
    });
    const confirmed = this.snapshot();
    const receipt = {
      schema: "limina.authoring-receipt/v1",
      transactionId: transaction.transactionId,
      projectId: this.projectId,
      transactionHash,
      previousRevision,
      committedRevision: this.revision,
      previousHeadHash,
      headHash: confirmed.head.headHash,
      operations,
    };
    const commitRecord = {
      schema: "limina.authoring-commit-record/v1",
      previousRecordHash: this.previousRecordHash,
      receipt,
      recordHash: compilerContentHash({
        schema: "limina.authoring-commit-record/v1",
        previousRecordHash: this.previousRecordHash,
        receipt,
      }),
    };
    this.previousRecordHash = commitRecord.recordHash;
    return {
      committed: true,
      receipt,
      commitRecord,
    };
  }
}

function sourceSnapshot(projectId, mapRef, revision = 1, terrainEditLayers = []) {
  const head = {
    schema: "limina.world-project-head/v1",
    projectId,
    revision,
    headHash: compilerContentHash({ head: revision }),
  };
  const refs = { mapDoc: mapRef, terrainEditLayers, scene: null, assets: [], lookProfile: null };
  const projectState = {
    schema: "limina.world-project-state/v1",
    projectId,
    refs,
    stateHash: compilerContentHash({ schema: "limina.world-project-state/v1", projectId, refs }),
  };
  const core = { schema: "limina.world-project-source-snapshot/v1", head, projectState };
  return { ...core, snapshotHash: compilerContentHash(core) };
}

function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), "limina-derived-service-"));
  const assetRoot = join(projectRoot, "assets");
  mkdirSync(assetRoot);
  const bytes = Buffer.from('{"activeMapId":"primary","maps":[{"id":"primary"}],"schema":"limina.map-doc/v1"}\n');
  const assetId = "assets/sources/map-doc/fixture.mapdoc.json";
  const path = join(projectRoot, ...assetId.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  const mapRef = { assetId, hash: projectAssetHash(bytes) };
  const projectId = "derived-service";
  return {
    projectId,
    projectRoot,
    assetRoot,
    bytes,
    mapRef,
    snapshot: sourceSnapshot(projectId, mapRef),
    assetStore: new ProjectAssetStore({ projectId, projectRoot, assetRoot }),
    cleanup: () => rmSync(projectRoot, { recursive: true, force: true }),
  };
}

class FakeCoordinator {
  constructor(options) {
    this.options = options;
    this.submissions = [];
    this.closed = false;
  }

  async submit(request) {
    this.submissions.push(request);
    const controller = new AbortController();
    const full = {
      buildId: "derived-test-build",
      ...request,
      compiler: this.options.compiler,
      signal: controller.signal,
    };
    const output = await this.options.compile(full);
    if (output.reusedArtifacts.length > 0) await this.options.verifyReusableArtifacts({
      projectRoot: this.options.projectRoot,
      buildId: full.buildId,
      manifest: output.manifest,
      reusedArtifacts: output.reusedArtifacts,
      signal: controller.signal,
    });
    const current = await this.options.readHead();
    assert.equal(current.headHash, request.headHash);
    const published = await this.options.publish({
      projectRoot: this.options.projectRoot,
      buildId: full.buildId,
      manifest: output.manifest,
      artifacts: output.artifacts,
      reusedArtifacts: output.reusedArtifacts,
      readHead: this.options.readHead,
      signal: controller.signal,
    });
    return {
      status: "published",
      buildId: full.buildId,
      projectId: request.projectId,
      branchId: request.branchId,
      revision: request.revision,
      headHash: request.headHash,
      compiler: this.options.compiler,
      manifestHash: published.manifestHash,
      durationMs: 1,
    };
  }

  diagnostics() { return { fake: true }; }
  async close() { this.closed = true; }
}

function service(fx, overrides = {}) {
  let coordinator;
  const authority = overrides.authority ?? {
    closed: false,
    async callTool(name) { assert.equal(name, "authoring.sourceSnapshot"); return fx.snapshot; },
    close() { this.closed = true; },
  };
  const compiler = {
    version: "1.0.0",
    config: { fixture: true },
    identity: {
      version: "1.0.0",
      configHash: compilerContentHash({ config: true }),
      graphHash: compilerContentHash({ graph: true }),
    },
  };
  const instance = new DerivedBuildService({
    projectId: fx.projectId,
    projectRoot: fx.projectRoot,
    authoringClient: authority,
    assetStore: fx.assetStore,
    compiler,
    compileAtlasMapDoc: overrides.compileAtlasMapDoc ?? (({ mapsJsonText }) => {
      assert.equal(mapsJsonText, fx.bytes.toString("utf8"));
      return { worldMap: { fixture: "world-map" }, warnings: [] };
    }),
    compileWorldTerrain: overrides.compileWorldTerrain,
    coordinatorFactory(options) { coordinator = new FakeCoordinator(options); return coordinator; },
    publish: overrides.publish,
    verifyReusableArtifacts: overrides.verifyReusableArtifacts ?? (() => {}),
    loadPrevious: overrides.loadPrevious,
    logger: { info() {}, error() {} },
    setTimer: overrides.setTimer,
    clearTimer: overrides.clearTimer,
  });
  return { instance, authority, get coordinator() { return coordinator; } };
}

test("genesis bootstrap canonicalizes, CAS-writes, commits once, and then preserves the ref", async () => {
  const fx = fixture();
  try {
    const seedPath = join(fx.projectRoot, "design", "maps.json");
    mkdirSync(dirname(seedPath), { recursive: true });
    writeFileSync(seedPath, JSON.stringify({
      version: 2,
      activeMapId: "primary",
      maps: [{ id: "primary", name: "Seed", scope: "world", parent: null, features: [], units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] } }],
    }, null, 2));
    const authority = new BootstrapAuthority(fx.projectId);
    let validations = 0;
    const options = {
      projectId: fx.projectId,
      projectRoot: fx.projectRoot,
      assetRoot: fx.assetRoot,
      seedPath,
      authoringClient: authority,
      validateMapDoc({ mapsJsonText }) {
        validations++;
        assert.equal(mapsJsonText.endsWith("\n"), true);
        assert.equal(mapsJsonText.includes("\n  "), false, "bootstrap did not canonicalize seed JSON");
        return { worldMap: {} };
      },
    };
    const first = await bootstrapAuthoritativeMapDoc(options);
    assert.equal(first.status, "committed");
    assert.equal(authority.commitCalls, 1);
    assert.deepEqual(authority.mapDoc, first.source);
    const stored = readFileSync(join(fx.projectRoot, ...first.source.assetId.split("/")));
    assert.equal(projectAssetHash(stored), first.source.hash);
    assert.equal(stored.at(-1), 0x0a);

    const second = await bootstrapAuthoritativeMapDoc(options);
    assert.equal(second.status, "preserved");
    assert.equal(authority.commitCalls, 1);
    assert.equal(validations, 1, "idempotent bootstrap re-read or rewrote the seed");
  } finally { fx.cleanup(); }
});

test("bootstrap never overwrites non-null or non-genesis authority", async () => {
  const fx = fixture();
  try {
    const existing = { assetId: "assets/sources/map-doc/existing.json", hash: compilerContentHash({ existing: true }) };
    const existingAuthority = new BootstrapAuthority(fx.projectId, { revision: 7, mapDoc: existing });
    const fail = () => { throw new Error("seed path must not be touched"); };
    const preserved = await bootstrapAuthoritativeMapDoc({
      projectId: fx.projectId,
      projectRoot: fx.projectRoot,
      assetRoot: fx.assetRoot,
      seedPath: join(fx.projectRoot, "missing.json"),
      authoringClient: existingAuthority,
      validateMapDoc: fail,
      persistSource: fail,
    });
    assert.equal(preserved.status, "preserved");
    assert.deepEqual(preserved.source, existing);
    assert.equal(existingAuthority.commitCalls, 0);

    const advancedNull = new BootstrapAuthority(fx.projectId, { revision: 1, mapDoc: null });
    const skipped = await bootstrapAuthoritativeMapDoc({
      projectId: fx.projectId,
      projectRoot: fx.projectRoot,
      assetRoot: fx.assetRoot,
      seedPath: join(fx.projectRoot, "missing.json"),
      authoringClient: advancedNull,
      validateMapDoc: fail,
      persistSource: fail,
    });
    assert.equal(skipped.status, "not-genesis");
    assert.equal(advancedNull.commitCalls, 0);
  } finally { fx.cleanup(); }
});

test("concurrent bootstraps preserve the one exact-head winner", async () => {
  const fx = fixture();
  try {
    const design = join(fx.projectRoot, "design");
    mkdirSync(design);
    const seedA = join(design, "a.json"), seedB = join(design, "b.json");
    const doc = (name) => ({ version: 2, activeMapId: "primary", maps: [{ id: "primary", name, scope: "world", parent: null, features: [], units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] } }] });
    writeFileSync(seedA, JSON.stringify(doc("A")));
    writeFileSync(seedB, JSON.stringify(doc("B")));
    const authority = new BootstrapAuthority(fx.projectId);
    const common = { projectId: fx.projectId, projectRoot: fx.projectRoot, assetRoot: fx.assetRoot, authoringClient: authority, validateMapDoc: () => ({}) };
    const [a, b] = await Promise.all([
      bootstrapAuthoritativeMapDoc({ ...common, seedPath: seedA }),
      bootstrapAuthoritativeMapDoc({ ...common, seedPath: seedB }),
    ]);
    assert.equal(authority.revision, 1);
    assert.equal(authority.commitCalls, 2);
    assert.ok([a.status, b.status].includes("committed"));
    assert.ok([a.status, b.status].includes("preserved-concurrent"));
    assert.ok(sameReferenceForTest(authority.mapDoc, a.source) || sameReferenceForTest(authority.mapDoc, b.source));
  } finally { fx.cleanup(); }
});

function sameReferenceForTest(left, right) {
  return left?.assetId === right?.assetId && left?.hash === right?.hash;
}

test("bootstrap rejects symlinked and invalid seed files before CAS persistence", async () => {
  const fx = fixture();
  const outside = mkdtempSync(join(tmpdir(), "limina-bootstrap-outside-"));
  try {
    const outsideSeed = join(outside, "maps.json");
    writeFileSync(outsideSeed, "{}\n");
    const design = join(fx.projectRoot, "design");
    mkdirSync(design);
    const linked = join(design, "maps.json");
    symlinkSync(outsideSeed, linked);
    let persisted = false;
    await assert.rejects(bootstrapAuthoritativeMapDoc({
      projectId: fx.projectId,
      projectRoot: fx.projectRoot,
      assetRoot: fx.assetRoot,
      seedPath: linked,
      authoringClient: new BootstrapAuthority(fx.projectId),
      validateMapDoc: () => ({}),
      persistSource() { persisted = true; },
    }), /cannot be opened safely/);
    assert.equal(persisted, false);

    rmSync(linked);
    writeFileSync(linked, "{bad json");
    await assert.rejects(bootstrapAuthoritativeMapDoc({
      projectId: fx.projectId,
      projectRoot: fx.projectRoot,
      assetRoot: fx.assetRoot,
      seedPath: linked,
      authoringClient: new BootstrapAuthority(fx.projectId),
      validateMapDoc: () => ({}),
      persistSource() { persisted = true; },
    }), /invalid JSON/);
    assert.equal(persisted, false);
  } finally {
    fx.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("bootstrap rejects malformed durable commit evidence even when authority mutated", async () => {
  const fx = fixture();
  try {
    const seedPath = join(fx.projectRoot, "design", "maps.json");
    mkdirSync(dirname(seedPath), { recursive: true });
    writeFileSync(seedPath, JSON.stringify({
      version: 2,
      activeMapId: "primary",
      maps: [{ id: "primary", name: "Seed", scope: "world", parent: null, features: [], units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] } }],
    }));
    const authority = new BootstrapAuthority(fx.projectId);
    const callTool = authority.callTool.bind(authority);
    authority.callTool = async (name, args, options) => {
      const result = await callTool(name, args, options);
      if (name === "authoring.commit") result.commitRecord.recordHash = compilerContentHash({ forged: true });
      return result;
    };
    await assert.rejects(bootstrapAuthoritativeMapDoc({
      projectId: fx.projectId,
      projectRoot: fx.projectRoot,
      assetRoot: fx.assetRoot,
      seedPath,
      authoringClient: authority,
      validateMapDoc: () => ({}),
    }), /invalid durable commit evidence/);
    assert.notEqual(authority.mapDoc, null, "fixture did not exercise post-mutation evidence rejection");
  } finally { fx.cleanup(); }
});

test("validates the complete authority binding and rejects head/state tampering", () => {
  const fx = fixture();
  try {
    assert.equal(validateAuthoritySourceSnapshot(fx.snapshot, fx.projectId).snapshotHash, fx.snapshot.snapshotHash);
    const stateTamper = JSON.parse(JSON.stringify(fx.snapshot));
    stateTamper.projectState.refs.mapDoc = null;
    assert.throws(() => validateAuthoritySourceSnapshot(stateTamper, fx.projectId), (error) => (
      error instanceof DerivedBuildServiceError && error.code === "INVALID_AUTHORITY"
    ));
    const headTamper = JSON.parse(JSON.stringify(fx.snapshot));
    headTamper.head.revision++;
    assert.throws(() => validateAuthoritySourceSnapshot(headTamper, fx.projectId), /snapshot hash is invalid/);
    const accessorArray = JSON.parse(JSON.stringify(fx.snapshot));
    const layers = [];
    Object.defineProperty(layers, "0", { enumerable: true, get() { throw new Error("must not execute"); } });
    layers.length = 1;
    accessorArray.projectState.refs.terrainEditLayers = layers;
    assert.throws(() => validateAuthoritySourceSnapshot(accessorArray, fx.projectId), /enumerable data field/);

    const traversal = sourceSnapshot(fx.projectId, { assetId: "assets/../outside.json", hash: fx.mapRef.hash });
    assert.throws(() => validateAuthoritySourceSnapshot(traversal, fx.projectId), /invalid asset identity/);

    const layer = (index) => ({
      layerId: `layer-${index}`,
      assetId: `assets/terrain/layer-${index}.json`,
      hash: compilerContentHash({ layer: index }),
      baseTopologyHash: compilerContentHash({ topology: index }),
    });
    const duplicateLayers = sourceSnapshot(fx.projectId, fx.mapRef, 1, [layer(0), { ...layer(1), layerId: "layer-0" }]);
    assert.throws(() => validateAuthoritySourceSnapshot(duplicateLayers, fx.projectId), /duplicates layerId/);

    const validAuthorityLayers = sourceSnapshot(fx.projectId, fx.mapRef, 1, Array.from({ length: 65 }, (_, index) => layer(index)));
    assert.equal(validateAuthoritySourceSnapshot(validAuthorityLayers, fx.projectId).projectState.refs.terrainEditLayers.length, 65,
      "authority validation incorrectly applied the compiler's lower composition limit");

    const unsortedAssets = sourceSnapshot(fx.projectId, fx.mapRef);
    unsortedAssets.projectState.refs.assets = [
      { assetId: "assets/z.json", hash: compilerContentHash({ asset: "z" }) },
      { assetId: "assets/a.json", hash: compilerContentHash({ asset: "a" }) },
    ];
    unsortedAssets.projectState.stateHash = compilerContentHash({
      schema: "limina.world-project-state/v1",
      projectId: fx.projectId,
      refs: unsortedAssets.projectState.refs,
    });
    unsortedAssets.snapshotHash = compilerContentHash({
      schema: unsortedAssets.schema,
      head: unsortedAssets.head,
      projectState: unsortedAssets.projectState,
    });
    assert.throws(() => validateAuthoritySourceSnapshot(unsortedAssets, fx.projectId), /strictly sorted/);
  } finally { fx.cleanup(); }
});

test("compiles the exact hash-verified MapDoc and normalizes coordinator artifacts", async () => {
  const fx = fixture();
  try {
    const artifactBytes = Uint8Array.of(1, 2, 3);
    const artifactHash = projectAssetHash(artifactBytes);
    const manifestHash = compilerContentHash({ manifest: 1 });
    let publishInput;
    const created = service(fx, {
      compileWorldTerrain(input) {
        assert.deepEqual(input.worldMap, { fixture: "world-map" });
        assert.deepEqual(Object.keys(input.sourceRefs), ["mapDocument"]);
        assert.equal(input.sourceRefs.mapDocument.assetId, fx.mapRef.assetId);
        assert.equal(input.sourceRefs.mapDocument.contentHash, fx.mapRef.hash);
        assert.equal(input.previousSnapshot, null);
        assert.equal(input.cancellation.shouldCancel(), false);
        return {
          manifest: { manifestHash },
          artifacts: [
            { chunkId: "a", artifactType: "terrain", mediaType: "x", contentHash: artifactHash, bytes: artifactBytes },
            { chunkId: "b", artifactType: "terrain", mediaType: "x", contentHash: artifactHash, bytes: artifactBytes },
          ],
          reusedArtifacts: [],
          snapshot: { snapshotHash: compilerContentHash({ snapshot: 1 }) },
          invalidation: { changed: true },
          diagnostics: [],
        };
      },
      async publish(input) {
        publishInput = input;
        await input.readHead();
        return { published: true, manifestHash: input.manifest.manifestHash };
      },
    });
    const result = await created.instance.reconcileOnce({ waitForBuild: true });
    assert.equal(result.manifestHash, manifestHash);
    assert.equal(publishInput.artifacts.length, 1, "duplicate content-addressed bytes were not deduplicated");
    assert.deepEqual(Object.keys(publishInput.artifacts[0]).sort(), ["bytes", "contentHash"]);
    assert.equal(created.coordinator.submissions.length, 1);

    const unchanged = await created.instance.reconcileOnce({ waitForBuild: true });
    assert.equal(unchanged.status, "unchanged");
    assert.equal(created.coordinator.submissions.length, 1);
    await created.instance.stop();
    assert.equal(created.coordinator.closed, true);
    assert.equal(created.authority.closed, true);
  } finally { fx.cleanup(); }
});

test("reads terrain edit layers by validated domain hash rather than an impossible raw self-hash", async () => {
  const fx = fixture();
  try {
    const grid = createTerrainGridSpec({ gridId: `${fx.projectId}.surface`, origin: [0, 0], chunkSizeM: 48, defaultSamples: 33 });
    const baseTopology = createTerrainEditBaseTopology({ grid, domain: { minTx: 0, minTz: 0, maxTx: 0, maxTz: 0 } });
    const layer = createTerrainEditLayer({
      layerId: "sculpt",
      baseTopology,
      operations: [{ operationId: "raise", kind: "add", deltas: [{ gx: 1, gz: 1, deltaM: 2 }] }],
    });
    const assetId = "assets/terrain/sculpt.layer.json";
    const path = join(fx.projectRoot, ...assetId.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    const layerBytes = Buffer.from(`${canonicalCompilerJson(layer)}\n`);
    assert.notEqual(projectAssetHash(layerBytes), layer.contentHash, "fixture must distinguish raw and domain hashes");
    writeFileSync(path, layerBytes);
    const layerRef = { layerId: layer.layerId, assetId, hash: layer.contentHash, baseTopologyHash: layer.baseTopology.topologyHash };
    fx.snapshot = sourceSnapshot(fx.projectId, fx.mapRef, 1, [layerRef]);
    const manifestHash = compilerContentHash({ manifest: "terrain-layer" });
    const created = service(fx, {
      compileWorldTerrain(input) {
        assert.equal(input.terrainEditLayers.length, 1);
        assert.equal(input.terrainEditLayers[0].contentHash, layer.contentHash);
        assert.equal(input.terrainEditLayerRefs[0].contentHash, layer.contentHash);
        return { manifest: { manifestHash }, artifacts: [], reusedArtifacts: [], snapshot: {}, invalidation: {}, diagnostics: [] };
      },
      publish: async (input) => { await input.readHead(); return { published: true, manifestHash }; },
    });
    await created.instance.reconcileOnce({ waitForBuild: true });
    await created.instance.stop();
  } finally { fx.cleanup(); }
});

test("passes verified previous manifest state into sparse compilation", async () => {
  const fx = fixture();
  try {
    const priorHash = compilerContentHash({ prior: "artifact" });
    const previous = {
      snapshot: { snapshotHash: compilerContentHash({ prior: "snapshot" }) },
      manifest: { chunks: [{ artifacts: [{ contentHash: priorHash }] }] },
    };
    let sawPrevious = false;
    const manifestHash = compilerContentHash({ manifest: 2 });
    const created = service(fx, {
      loadPrevious: async () => previous,
      compileWorldTerrain(input) {
        sawPrevious = input.previousSnapshot === previous.snapshot
          && input.previousManifest === previous.manifest
          && input.availableArtifactHashes.join() === priorHash;
        return { manifest: { manifestHash }, artifacts: [], reusedArtifacts: [], snapshot: {}, invalidation: {}, diagnostics: [] };
      },
      publish: async (input) => { await input.readHead(); return { published: true, manifestHash }; },
    });
    await created.instance.reconcileOnce({ waitForBuild: true });
    assert.equal(sawPrevious, true);
    await created.instance.stop();
  } finally { fx.cleanup(); }
});

test("tampered assets fail before compiler execution and remain retryable", async () => {
  const fx = fixture();
  try {
    writeFileSync(join(fx.projectRoot, ...fx.mapRef.assetId.split("/")), "tampered\n");
    let compiled = false;
    const created = service(fx, {
      compileWorldTerrain() { compiled = true; throw new Error("must not execute"); },
      publish: async () => { throw new Error("must not publish"); },
    });
    await assert.rejects(created.instance.reconcileOnce({ waitForBuild: true }), /hash mismatch/);
    assert.equal(compiled, false);
    await assert.rejects(created.instance.reconcileOnce({ waitForBuild: true }), /hash mismatch/);
    assert.equal(created.coordinator.submissions.length, 2, "failed immutable-source read was incorrectly cached as success");
    await created.instance.stop();
  } finally { fx.cleanup(); }
});

test("a failed reuse verification forces the next retry onto a cold rebuild", async () => {
  const fx = fixture();
  try {
    const priorHash = compilerContentHash({ prior: "artifact" });
    const previous = {
      snapshot: { snapshotHash: compilerContentHash({ prior: "snapshot" }) },
      manifest: { chunks: [{ artifacts: [{ contentHash: priorHash }] }] },
    };
    let compiles = 0;
    let verifierCalls = 0;
    const manifestHash = compilerContentHash({ manifest: "recovery" });
    const created = service(fx, {
      loadPrevious: async () => previous,
      compileWorldTerrain(input) {
        compiles++;
        if (compiles === 1) {
          assert.equal(input.previousSnapshot, previous.snapshot);
          return {
            manifest: { manifestHash },
            artifacts: [],
            reusedArtifacts: [{ chunkId: "a", artifactType: "terrain", mediaType: "x", contentHash: priorHash, byteLength: 3 }],
            snapshot: {}, invalidation: {}, diagnostics: [],
          };
        }
        assert.equal(input.previousSnapshot, null, "failed cache remained advertised on retry");
        assert.equal(Object.hasOwn(input, "previousManifest"), false);
        return { manifest: { manifestHash }, artifacts: [], reusedArtifacts: [], snapshot: {}, invalidation: {}, diagnostics: [] };
      },
      verifyReusableArtifacts() { verifierCalls++; throw new Error("installed artifact vanished"); },
      publish: async (input) => { await input.readHead(); return { published: true, manifestHash }; },
    });
    await assert.rejects(created.instance.reconcileOnce({ waitForBuild: true }), /installed artifact vanished/);
    await created.instance.reconcileOnce({ waitForBuild: true });
    assert.equal(verifierCalls, 1);
    assert.equal(compiles, 2);
    await created.instance.stop();
  } finally { fx.cleanup(); }
});

test("start is idempotent and stop cancels the owned timer and coordinator", async () => {
  const fx = fixture();
  try {
    const timers = [];
    const cleared = [];
    const created = service(fx, {
      compileWorldTerrain() { throw new Error("not reached"); },
      publish: async () => { throw new Error("not reached"); },
      setTimer(fn, delay) { const token = { fn, delay, unref() {} }; timers.push(token); return token; },
      clearTimer(token) { cleared.push(token); },
    });
    created.instance.start();
    created.instance.start();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 0);
    await created.instance.stop("test shutdown");
    assert.deepEqual(cleared, [timers[0]]);
    assert.equal(created.coordinator.closed, true);
    assert.equal(created.authority.closed, true);
    assert.throws(() => created.instance.start(), /closed/);
  } finally { fx.cleanup(); }
});

test("real coordinator and publisher preserve snapshot-bound artifacts across cold then sparse builds", async () => {
  const fx = fixture();
  try {
    mkdirSync(join(fx.projectRoot, ".limina"));
    writeFileSync(join(fx.projectRoot, "limina.project.json"), `${JSON.stringify({
      schema: "limina-project/1",
      projectId: fx.projectId,
      assetRoot: "assets",
      stateDir: ".limina",
    })}\n`);
    const authority = {
      closed: false,
      async callTool(name) { assert.equal(name, "authoring.sourceSnapshot"); return fx.snapshot; },
      close() { this.closed = true; },
    };
    const compiler = {
      version: "1.0.0",
      config: { fixture: true },
      identity: {
        version: "1.0.0",
        configHash: compilerContentHash({ config: "real-integration" }),
        graphHash: compilerContentHash({ graph: "real-integration" }),
      },
    };
    const grid = createTerrainGridSpec({ gridId: `${fx.projectId}.surface`, origin: [0, 0], chunkSizeM: 48, defaultSamples: 33 });
    const chunkId = terrainChunkId(grid.gridId, 0, 0, 0);
    const bytes = Uint8Array.from(Buffer.from("real-service-artifact"));
    const contentHash = derivedArtifactContentHash(bytes);
    let compileCount = 0;
    const instance = new DerivedBuildService({
      projectId: fx.projectId,
      projectRoot: fx.projectRoot,
      authoringClient: authority,
      assetStore: fx.assetStore,
      compiler,
      compileAtlasMapDoc: () => ({ worldMap: { fixture: true }, warnings: [] }),
      compileWorldTerrain(input) {
        compileCount++;
        const snapshotCore = {
          schema: COMPILER_SNAPSHOT_SCHEMA,
          graphHash: compiler.identity.graphHash,
          chunks: [{ chunkId, gridId: grid.gridId, lod: 0, tx: 0, tz: 0, chunkTopologyHash: compilerContentHash({ topology: 1 }) }],
          stageKeys: { render: { [chunkId]: compilerContentHash({ render: 1 }) } },
        };
        const snapshot = { ...snapshotCore, snapshotHash: compilerContentHash(snapshotCore) };
        const manifest = createDerivedRevisionManifest({
          schema: DERIVED_REVISION_MANIFEST_SCHEMA,
          projectId: fx.projectId,
          branchId: "main",
          source: {
            revision: input.request.revision,
            headHash: input.request.headHash,
            contentRefs: [{
              refId: "map-document",
              refType: "map-document/v1",
              scope: "global",
              assetId: fx.mapRef.assetId,
              contentHash: fx.mapRef.hash,
            }],
          },
          compiler: { ...compiler.identity, snapshotHash: snapshot.snapshotHash },
          grid,
          chunks: [{
            chunkId,
            gridId: grid.gridId,
            lod: 0,
            tx: 0,
            tz: 0,
            topologyHash: compilerContentHash({ topology: 1 }),
            sourceSliceHashes: [],
            artifacts: [{ artifactType: "terrain-chunk/v1", mediaType: "application/vnd.limina.terrain-chunk", contentHash, byteLength: bytes.byteLength }],
          }],
        });
        const descriptor = { chunkId, artifactType: "terrain-chunk/v1", mediaType: "application/vnd.limina.terrain-chunk", contentHash, byteLength: bytes.byteLength };
        return {
          manifest,
          artifacts: input.previousSnapshot === null ? [{ ...descriptor, bytes }] : [],
          reusedArtifacts: input.previousSnapshot === null ? [] : [descriptor],
          snapshot,
          invalidation: {},
          diagnostics: [],
        };
      },
      logger: { info() {}, error() {} },
    });

    const first = await instance.reconcileOnce({ waitForBuild: true });
    assert.equal(first.revision, 1);
    fx.snapshot = sourceSnapshot(fx.projectId, fx.mapRef, 2);
    const second = await instance.reconcileOnce({ waitForBuild: true });
    assert.equal(second.revision, 2);
    assert.equal(compileCount, 2);
    const current = await readPublishedDerivedRevision({
      projectRoot: fx.projectRoot,
      branchId: "main",
      readHead: async () => ({ projectId: fx.projectId, branchId: "main", revision: 2, headHash: fx.snapshot.head.headHash }),
    });
    assert.equal(current.status, "current");
    assert.equal(current.pointer.generation, 2);
    assert.equal(current.snapshot.snapshotHash, current.manifest.compiler.snapshotHash);
    assert.equal(current.manifest.chunks[0].artifacts[0].contentHash, contentHash);
    await instance.stop();
    assert.equal(authority.closed, true);

    const restartedAuthority = {
      async callTool() { return fx.snapshot; },
      close() {},
    };
    const restarted = new DerivedBuildService({
      projectId: fx.projectId,
      projectRoot: fx.projectRoot,
      authoringClient: restartedAuthority,
      assetStore: fx.assetStore,
      compiler,
      compileAtlasMapDoc() { throw new Error("already-published source must not compile"); },
      compileWorldTerrain() { throw new Error("already-published source must not compile"); },
      loadPrevious: () => readPublishedDerivedRevision({
        projectRoot: fx.projectRoot,
        branchId: "main",
        readHead: async () => ({ projectId: fx.projectId, branchId: "main", revision: 2, headHash: fx.snapshot.head.headHash }),
      }),
      logger: { info() {}, error() {} },
    });
    const restartResult = await restarted.reconcileOnce({ waitForBuild: true });
    assert.equal(restartResult.status, "already-published");
    assert.equal(restartResult.manifestHash, current.manifest.manifestHash);
    await restarted.stop();
  } finally { fx.cleanup(); }
});
