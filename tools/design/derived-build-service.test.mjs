import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { compilerContentHash } from "../../js/src/world/compiler/canonical.mjs";
import { createTerrainGridSpec, terrainChunkId } from "../../js/src/terrain/grid.mjs";
import { createTerrainEditBaseTopology, createTerrainEditLayer } from "../../js/src/terrain/edit-layer.mjs";
import { terrainEditBaseTopologyForWorldMap } from "../../js/src/terrain/edit-topology.mjs";
import {
  COMPILER_SNAPSHOT_SCHEMA,
  DERIVED_REVISION_MANIFEST_SCHEMA,
  createDerivedRevisionManifest,
  canonicalCompilerJson,
  derivedArtifactContentHash,
} from "../../js/src/world/compiler/index.mjs";
import { ProjectAssetStore, projectAssetHash } from "../project-asset-store.mjs";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import { BIOME_LIBRARY_V1 } from "../../js/src/world/biome-library-v1.mjs";
import { biomePackContentHash } from "../../js/src/world/biome-ir.mjs";
import { BIOME_RUNTIME_PACK_LIMITS, BIOME_RUNTIME_PACK_SCHEMA,
  biomeRuntimePackContentHash } from "../../js/src/world/biome-runtime-pack.mjs";
import { BIOME_CONTENT_BUNDLE_SCHEMA, deriveBiomeContentBundleClosureHash } from "../../js/src/world/biome-content-bundle.mjs";
import { BIOME_PUBLICATION_INPUT_SCHEMA, WORLD_PUBLISHED_BIOME_COMPILER_VERSION } from "../../js/src/world/compiler/biome-publication-compile.mjs";
import { readPublishedDerivedRevision, resolveCurrentPublishedDerivedArtifact } from "./derived-publisher.mjs";
import {
  DerivedBuildService,
  DerivedBuildServiceError,
  bootstrapAuthoritativeMapDoc,
  derivedRuntimeConfigurationFromEnvironment,
  derivedRuntimeDiscovery,
  startDerivedRuntimeAfterAuthority,
  stopDerivedRuntimeBeforeBuildService,
  validateAuthoritySourceSnapshot,
} from "./derived-build-service.mjs";

test("derived runtime environment and discovery are exact, bounded loopback capabilities", () => {
  const tokenText = Buffer.alloc(32, 0x41).toString("base64url");
  const configuration = derivedRuntimeConfigurationFromEnvironment({
    LIMINA_DERIVED_RUNTIME_PORT: "5174",
    LIMINA_DERIVED_RUNTIME_TOKEN: tokenText,
    LIMINA_DERIVED_RUNTIME_ORIGIN: "http://localhost:5173",
  });
  assert.equal(configuration.port, 5174);
  assert.deepEqual(configuration.token, new Uint8Array(32).fill(0x41));
  assert.deepEqual(configuration.allowedOrigins, ["http://localhost:5173"]);
  assert.deepEqual(derivedRuntimeDiscovery("http://127.0.0.1:5174"), {
    schema: "limina.derived-runtime-discovery/v1",
    baseUrl: "http://127.0.0.1:5174",
  });

  for (const [field, value] of [
    ["LIMINA_DERIVED_RUNTIME_PORT", "0"],
    ["LIMINA_DERIVED_RUNTIME_PORT", "05174"],
    ["LIMINA_DERIVED_RUNTIME_PORT", "65536"],
    ["LIMINA_DERIVED_RUNTIME_TOKEN", "short"],
    ["LIMINA_DERIVED_RUNTIME_ORIGIN", "http://localhost:5173/path"],
    ["LIMINA_DERIVED_RUNTIME_ORIGIN", "https://localhost:5173"],
    ["LIMINA_DERIVED_RUNTIME_ORIGIN", "http://evil.invalid:5173"],
  ]) {
    assert.throws(() => derivedRuntimeConfigurationFromEnvironment({
      LIMINA_DERIVED_RUNTIME_PORT: "5174",
      LIMINA_DERIVED_RUNTIME_TOKEN: tokenText,
      LIMINA_DERIVED_RUNTIME_ORIGIN: "http://localhost:5173",
      [field]: value,
    }), (error) => error instanceof DerivedBuildServiceError && error.code === "INVALID_RUNTIME_CONFIG");
  }
  for (const baseUrl of ["http://localhost:5174", "https://127.0.0.1:5174", "http://127.0.0.1:5174/path", "http://127.0.0.1:5174?token=x"]) {
    assert.throws(() => derivedRuntimeDiscovery(baseUrl), /invalid|non-loopback/);
  }
});

test("derived runtime is constructed after authority and stops before the build service", async () => {
  const events = [];
  const service = {
    async reconcileOnce() { events.push("authority"); },
    async stop(reason) { events.push(`service:${reason}`); },
  };
  const started = await startDerivedRuntimeAfterAuthority(service, () => {
    assert.deepEqual(events, ["authority"]);
    events.push("construct-runtime");
    return {
      async start() { events.push("start-runtime"); return { baseUrl: "http://127.0.0.1:5174" }; },
      async stop() { events.push("stop-runtime"); },
    };
  });
  assert.equal(started.discovery.baseUrl, "http://127.0.0.1:5174");
  await stopDerivedRuntimeBeforeBuildService(started.runtimeServer, service, "test");
  assert.deepEqual(events, ["authority", "construct-runtime", "start-runtime", "stop-runtime", "service:test"]);

  const failedStopEvents = [];
  await assert.rejects(stopDerivedRuntimeBeforeBuildService(
    { async stop() { failedStopEvents.push("runtime"); throw new Error("runtime stop failed"); } },
    { async stop() { failedStopEvents.push("service"); } },
    "fault",
  ), /runtime stop failed/);
  assert.deepEqual(failedStopEvents, ["runtime", "service"], "build service must still stop after a runtime shutdown fault");

  let cleanedFailedStart = false;
  await assert.rejects(startDerivedRuntimeAfterAuthority(
    { async reconcileOnce() {} },
    () => ({
      async start() { throw new Error("bind failed"); },
      async stop() { cleanedFailedStart = true; },
    }),
  ), /bind failed/);
  assert.equal(cleanedFailedStart, true);
});

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
    if (name === "authoring.sourceSnapshot") {
      // Authority reads must survive one transport drop: a long publish hand-off can
      // block the loop past the host's ping window and the host closes the socket
      // (a 15k-chunk build died at authority-at-publication exactly this way).
      assert.deepEqual(options, { retryTransport: true });
      return this.snapshot();
    }
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

function previousManifest(projectId, artifactHash, snapshotHash, globalArtifactHash = undefined, options = {}) {
  const grid = createTerrainGridSpec({ gridId: `${projectId}.surface`, origin: [0, 0], chunkSizeM: 48, defaultSamples: 33 });
  const chunkId = terrainChunkId(grid.gridId, 0, 0, 0);
  return createDerivedRevisionManifest({
    schema: DERIVED_REVISION_MANIFEST_SCHEMA,
    projectId,
    branchId: "main",
    source: {
      revision: options.revision ?? 1,
      headHash: compilerContentHash({ head: options.revision ?? 1 }),
      contentRefs: [{ refId: "map-document", refType: "map-document/v1", scope: "global", assetId: "assets/map.json", contentHash: compilerContentHash({ map: 1 }) }],
    },
    compiler: {
      version: options.compiler?.version ?? "1.0.0",
      configHash: options.compiler?.configHash ?? compilerContentHash({ fixture: true }),
      graphHash: options.compiler?.graphHash ?? compilerContentHash({ graph: true }),
      snapshotHash,
    },
    grid,
    globalArtifacts: globalArtifactHash === undefined ? [] : [{
      artifactType: "hydrology-field/v1",
      contentHash: globalArtifactHash,
      byteLength: 4,
      mediaType: "application/vnd.limina.hydrology-field",
    }],
    chunks: [{
      chunkId,
      gridId: grid.gridId,
      lod: 0,
      tx: 0,
      tz: 0,
      topologyHash: compilerContentHash({ topology: 1 }),
      sourceSliceHashes: [],
      artifacts: [{ artifactType: "terrain-chunk/v1", contentHash: artifactHash, byteLength: 3, mediaType: "application/vnd.limina.terrain-chunk" }],
    }],
  });
}

function compilerProfile(version, tag) {
  const config = { profile: tag };
  return {
    version,
    config,
    identity: {
      version,
      configHash: compilerContentHash(config),
      graphHash: compilerContentHash({ profileGraph: tag }),
    },
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
    const sourceRequest = Object.freeze({ ...request });
    const compiler = this.options.compilerForRequest?.(sourceRequest) ?? this.options.compiler;
    const full = {
      buildId: "derived-test-build",
      ...request,
      compiler,
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
      compiler,
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
    // An authority without the D5.1 live layer store answers not_found, which is the
    // one fallthrough that sends ingestion to the fs-backed asset store.
    async callTool(name) {
      if (name === "authoring.sourceSnapshot") return fx.snapshot;
      const error = new Error(`unknown tool: ${name}`);
      error.code = "not_found";
      throw error;
    },
    close() { this.closed = true; },
  };
  const compiler = overrides.compiler ?? {
    version: "1.0.0",
    config: { fixture: true },
    identity: {
      version: "1.0.0",
      configHash: compilerContentHash({ fixture: true }),
      graphHash: compilerContentHash({ graph: true }),
    },
  };
  const instance = new DerivedBuildService({
    projectId: fx.projectId,
    projectRoot: fx.projectRoot,
    authoringClient: authority,
    assetStore: overrides.assetStore ?? fx.assetStore,
    compiler,
    compilerForWorldMap: overrides.compilerForWorldMap,
    biomePublicationForWorldMap: overrides.biomePublicationForWorldMap,
    compileAtlasMapDoc: overrides.compileAtlasMapDoc ?? (({ mapsJsonText }) => {
      assert.equal(mapsJsonText, fx.bytes.toString("utf8"));
      return { worldMap: { fixture: "world-map" }, warnings: [] };
    }),
    compileWorldTerrain: overrides.compileWorldTerrain,
    coordinatorFactory(options) { coordinator = new FakeCoordinator(options); return coordinator; },
    publish: overrides.publish,
    verifyReusableArtifacts: overrides.verifyReusableArtifacts ?? (() => {}),
    loadPrevious: overrides.loadPrevious,
    logger: overrides.logger ?? { info() {}, error() {} },
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

test("prepares the exact MapDoc once and submits the selected compiler profile", async () => {
  const fx = fixture();
  try {
    const legacy = compilerProfile("1.0.0", "legacy");
    const biome = compilerProfile("1.3.0", "biome");
    let assetReads = 0;
    let atlasCompiles = 0;
    let selectorCalls = 0;
    let terrainCompiles = 0;
    const manifestHash = compilerContentHash({ manifest: "selected-hydrology" });
    const assetStore = {
      read(...args) { assetReads++; return fx.assetStore.read(...args); },
      readCanonicalJson(...args) { return fx.assetStore.readCanonicalJson(...args); },
    };
    const created = service(fx, {
      compiler: legacy,
      assetStore,
      compileAtlasMapDoc({ mapsJsonText }) {
        atlasCompiles++;
        assert.equal(mapsJsonText, fx.bytes.toString("utf8"));
        return { worldMap: { hydrology: { schema: "limina.hydrology-recipe/v1" } }, warnings: [] };
      },
      compilerForWorldMap(worldMap) {
        selectorCalls++;
        assert.equal(Object.isFrozen(worldMap), true);
        return worldMap.hydrology === undefined ? legacy : biome;
      },
      compileWorldTerrain(input) {
        terrainCompiles++;
        assert.equal(input.compiler.version, "1.3.0");
        assert.strictEqual(input.compiler.config, biome.config);
        return { manifest: { manifestHash }, artifacts: [], reusedArtifacts: [], snapshot: {}, invalidation: {}, diagnostics: [] };
      },
      publish: async (input) => { await input.readHead(); return { published: true, manifestHash }; },
    });
    const result = await created.instance.reconcileOnce({ waitForBuild: true });
    assert.deepEqual(result.compiler, biome.identity);
    assert.equal(assetReads, 1);
    assert.equal(atlasCompiles, 1);
    assert.equal(selectorCalls, 1);
    assert.equal(terrainCompiles, 1);
    assert.equal((await created.instance.reconcileOnce({ waitForBuild: true })).status, "unchanged");
    assert.equal(assetReads, 1, "unchanged source was prepared twice");
    await created.instance.stop();
  } finally { fx.cleanup(); }
});

test("opt-in published biome profile source-fences its closure and forwards exact CAS content to publication", async () => {
  const fx = fixture();
  try {
    const published = compilerProfile(WORLD_PUBLISHED_BIOME_COMPILER_VERSION, "published-biome");
    const bytes = new TextEncoder().encode("verified population descriptor\n");
    const contentHash = portableAssetContentHash(bytes);
    const runtimePackDocument = { schema: BIOME_RUNTIME_PACK_SCHEMA, id: "build-service-runtime", version: "1.0.0",
      metadataPackContentHash: biomePackContentHash(BIOME_LIBRARY_V1), status: "metadata-only",
      biomes: BIOME_LIBRARY_V1.definitions.map((definition) => ({ biomeId: definition.id, status: "metadata-only",
        surfaceRules: definition.surfaceMaterials.slice(0, BIOME_RUNTIME_PACK_LIMITS.surfaceRules)
          .map(({ role }) => ({ role, weight: 1, tileScaleM: 4 })).sort((left, right) => left.role.localeCompare(right.role)),
        vegetationRules: definition.vegetationPalette.slice(0, BIOME_RUNTIME_PACK_LIMITS.vegetationRules)
          .map(({ role, weight }) => ({ role, weight, radiusM: 1.5, density01: 0.5, scale: [0.8, 1.2],
            tintSrgb: [255, 255, 255] })).sort((left, right) => left.role.localeCompare(right.role)), bindings: [] })) };
    const runtimePackBytes = new TextEncoder().encode(`${JSON.stringify(runtimePackDocument)}\n`);
    const runtimePackByteHash = portableAssetContentHash(runtimePackBytes);
    const runtimePackHash = biomeRuntimePackContentHash(runtimePackDocument, BIOME_LIBRARY_V1);
    const draft = {
      schema: BIOME_CONTENT_BUNDLE_SCHEMA,
      id: "published-biome-test",
      version: "1.0.0",
      status: "candidate",
      runtimePack: { assetId: "biomes/runtime.json", contentHash: runtimePackHash },
      entries: [{
        assetId: "content/fixture.bin",
        contentHash,
        kind: "model-lod",
        byteLength: bytes.byteLength,
        provenance: { licenseSpdx: "CC0-1.0", sourceUri: "limina://test/fixture" },
      }],
    };
    const contentBundle = { ...draft, closureHash: deriveBiomeContentBundleClosureHash(draft) };
    const biomePublication = {
      schema: BIOME_PUBLICATION_INPUT_SCHEMA,
      runtimePack: { ...contentBundle.runtimePack, byteContentHash: runtimePackByteHash,
        byteLength: runtimePackBytes.byteLength, bytes: runtimePackBytes },
      contentBundle,
      chunks: [],
    };
    const manifestHash = compilerContentHash({ manifest: "published-biome" });
    let preparedCalls = 0;
    let publicationInput;
    const created = service(fx, {
      compiler: published,
      compileAtlasMapDoc: () => ({ worldMap: { hydrology: {} }, warnings: [] }),
      biomePublicationForWorldMap({ worldMap, authority, assetStore }) {
        preparedCalls++;
        assert.equal(worldMap.hydrology !== undefined, true);
        assert.equal(authority.head.headHash, fx.snapshot.head.headHash);
        assert.ok(assetStore);
        return { input: biomePublication, contentEntries: [{ id: "content/fixture.bin", path: "assets/content/fixture.bin", hash: contentHash, bytes }] };
      },
      compileWorldTerrain(input) {
        assert.strictEqual(input.biomePublication, biomePublication);
        assert.equal(input.previousSnapshot, null, "published biome compilation was not forced cold");
        return { manifest: { manifestHash }, artifacts: [], reusedArtifacts: [], snapshot: {}, invalidation: {}, diagnostics: [] };
      },
      async publish(input) {
        publicationInput = input;
        assert.deepEqual(input.contentEntries.map((entry) => ({ id: entry.id, path: entry.path, hash: entry.hash })),
          [{ id: "content/fixture.bin", path: "assets/content/fixture.bin", hash: contentHash }]);
        assert.strictEqual(input.contentEntries[0].bytes, bytes);
        await input.readHead();
        return { published: true, manifestHash };
      },
    });
    const result = await created.instance.reconcileOnce({ waitForBuild: true });
    assert.equal(result.manifestHash, manifestHash);
    assert.equal(preparedCalls, 1);
    assert.ok(publicationInput, "content-aware publication was not invoked");
    await created.instance.stop();
  } finally { fx.cleanup(); }
});

test("selected profile controls already-published and warm-versus-cold cache decisions", async (t) => {
  const legacy = compilerProfile("1.0.0", "legacy");
  const biome = compilerProfile("1.3.0", "biome");
  await t.test("already published selected profile", async () => {
    const fx = fixture();
    try {
      const artifactHash = compilerContentHash({ prior: "selected-artifact" });
      const snapshotHash = compilerContentHash({ prior: "selected-snapshot" });
      const manifest = previousManifest(fx.projectId, artifactHash, snapshotHash, undefined, { compiler: biome.identity });
      let atlasCompiles = 0;
      const created = service(fx, {
        compiler: legacy,
        compilerForWorldMap: () => biome,
        compileAtlasMapDoc() { atlasCompiles++; return { worldMap: { hydrology: {} }, warnings: [] }; },
        compileWorldTerrain() { throw new Error("already-published selected profile must not compile terrain"); },
        loadPrevious: async () => ({ manifest, snapshot: { snapshotHash } }),
        publish: async () => { throw new Error("already-published selected profile must not publish"); },
      });
      const result = await created.instance.reconcileOnce({ waitForBuild: true });
      assert.equal(result.status, "already-published");
      assert.equal(atlasCompiles, 1, "selector did not inspect the exact MapDoc");
      assert.equal(created.coordinator.submissions.length, 0);
      await created.instance.stop();
    } finally { fx.cleanup(); }
  });

  for (const [name, priorCompiler, expectWarm] of [
    ["matching profile remains sparse", biome.identity, true],
    ["different profile transitions cold", legacy.identity, false],
  ]) await t.test(name, async () => {
    const fx = fixture();
    try {
      fx.snapshot = sourceSnapshot(fx.projectId, fx.mapRef, 2);
      const artifactHash = compilerContentHash({ prior: name });
      const snapshotHash = compilerContentHash({ snapshot: name });
      const manifest = previousManifest(fx.projectId, artifactHash, snapshotHash, undefined, { compiler: priorCompiler });
      let sawWarm;
      const manifestHash = compilerContentHash({ next: name });
      const created = service(fx, {
        compiler: legacy,
        compilerForWorldMap: () => biome,
        compileAtlasMapDoc: () => ({ worldMap: { hydrology: {} }, warnings: [] }),
        loadPrevious: async () => ({ manifest, snapshot: { snapshotHash } }),
        compileWorldTerrain(input) {
          sawWarm = input.previousSnapshot !== null;
          assert.equal(Object.hasOwn(input, "previousManifest"), expectWarm);
          assert.equal(input.compiler.version, "1.3.0");
          return { manifest: { manifestHash }, artifacts: [], reusedArtifacts: [], snapshot: {}, invalidation: {}, diagnostics: [] };
        },
        publish: async (input) => { await input.readHead(); return { published: true, manifestHash }; },
      });
      await created.instance.reconcileOnce({ waitForBuild: true });
      assert.equal(sawWarm, expectWarm);
      await created.instance.stop();
    } finally { fx.cleanup(); }
  });
});

test("malformed compiler bundles and profile selectors fail before queueing without retained work", async (t) => {
  const fx = fixture();
  try {
    assert.throws(() => service(fx, {
      compiler: { version: "1.0.0", config: {}, identity: { version: "2.0.0", configHash: compilerContentHash({}), graphHash: compilerContentHash({ graph: true }) } },
      compileWorldTerrain() {},
    }), (error) => error instanceof DerivedBuildServiceError && error.code === "INVALID_COMPILER");
  } finally { fx.cleanup(); }

  for (const [name, selector] of [
    ["throwing selector", () => { throw new Error("selection unavailable"); }],
    ["malformed selector bundle", () => ({ version: "1.2.0", config: {} })],
    ["forged selector config hash", () => ({ ...compilerProfile("1.2.0", "forged"), config: { profile: "tampered" } })],
  ]) await t.test(name, async () => {
    const local = fixture();
    try {
      const created = service(local, {
        compilerForWorldMap: selector,
        compileWorldTerrain() { throw new Error("selector failure reached terrain compiler"); },
        publish: async () => { throw new Error("selector failure reached publisher"); },
      });
      await assert.rejects(created.instance.reconcileOnce({ waitForBuild: true }), (error) => (
        error instanceof DerivedBuildServiceError && error.code === "COMPILER_SELECTION_FAILED"
      ));
      assert.equal(created.coordinator.submissions.length, 0);
      assert.equal(created.instance.diagnostics().inFlight, 0);
      await created.instance.stop();
    } finally { local.cleanup(); }
  });
});

function fixtureWorldMap() {
  return {
    version: 1,
    id: "primary",
    unitsPerMeter: 1,
    origin: [0, 0],
    extent: { w: 16, h: 16 },
    seaLevel: 0,
    land: [{ points: [[-8, -8], [8, -8], [8, 8], [-8, 8]] }],
    relief: [],
    biomes: [],
    waterways: [],
    routes: [],
    anchors: [],
  };
}

test("reads terrain edit layers by validated domain hash rather than an impossible raw self-hash", async () => {
  const fx = fixture();
  try {
    const worldMap = fixtureWorldMap();
    const baseTopology = terrainEditBaseTopologyForWorldMap(worldMap, {});
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
      compileAtlasMapDoc: () => ({ worldMap, warnings: [] }),
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

test("reads terrain edit layer content from the authority live store without fs bytes", async () => {
  const fx = fixture();
  try {
    const worldMap = fixtureWorldMap();
    const baseTopology = terrainEditBaseTopologyForWorldMap(worldMap, {});
    const layer = createTerrainEditLayer({
      layerId: "derived-primary.surface",
      baseTopology,
      operations: [{ operationId: "op-000000", kind: "add", deltas: [{ gx: 1, gz: 1, deltaM: 2 }] }],
    });
    const layerRef = {
      layerId: layer.layerId,
      assetId: `assets/sources/terrain-edit-layer/${layer.contentHash.slice(7)}.layer.json`,
      hash: layer.contentHash,
      baseTopologyHash: layer.baseTopology.topologyHash,
    };
    fx.snapshot = sourceSnapshot(fx.projectId, fx.mapRef, 1, [layerRef]);
    let reads = 0;
    const authority = {
      closed: false,
      async callTool(name, args, options) {
        if (name === "authoring.sourceSnapshot") return fx.snapshot;
        assert.equal(name, "authoring.terrainEditLayer");
        assert.deepEqual(options, { retryTransport: true });
        assert.deepEqual(args, { assetId: layerRef.assetId, hash: layerRef.hash });
        reads++;
        return { layer: JSON.parse(canonicalCompilerJson(layer)) };
      },
      close() { this.closed = true; },
    };
    const manifestHash = compilerContentHash({ manifest: "authority-layer" });
    const created = service(fx, {
      authority,
      compileAtlasMapDoc: () => ({ worldMap, warnings: [] }),
      compileWorldTerrain(input) {
        assert.equal(input.terrainEditLayers.length, 1);
        assert.equal(input.terrainEditLayers[0].contentHash, layer.contentHash);
        return { manifest: { manifestHash }, artifacts: [], reusedArtifacts: [], snapshot: {}, invalidation: {}, diagnostics: [] };
      },
      publish: async (input) => { await input.readHead(); return { published: true, manifestHash }; },
    });
    await created.instance.reconcileOnce({ waitForBuild: true });
    assert.equal(reads, 1, "ingestion must resolve the layer through the authority once");
    await created.instance.stop();
  } finally { fx.cleanup(); }
});

test("rebases an edit layer onto a moved compile domain, binding the compile to the rebased content", async () => {
  const fx = fixture();
  try {
    const worldMap = fixtureWorldMap();
    const targetBase = terrainEditBaseTopologyForWorldMap(worldMap, {});
    const grid = createTerrainGridSpec({ gridId: targetBase.grid.gridId, origin: [0, 0], chunkSizeM: 48, defaultSamples: 33 });
    const oldBase = createTerrainEditBaseTopology({ grid, domain: { minTx: 0, minTz: 0, maxTx: 0, maxTz: 0 } });
    assert.notEqual(oldBase.topologyHash, targetBase.topologyHash, "fixture must bind the layer to a stale topology");
    const layer = createTerrainEditLayer({
      layerId: "sculpt",
      baseTopology: oldBase,
      operations: [{ operationId: "raise", kind: "add", deltas: [{ gx: 1, gz: 1, deltaM: 2 }] }],
    });
    const assetId = "assets/terrain/sculpt.layer.json";
    const path = join(fx.projectRoot, ...assetId.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(`${canonicalCompilerJson(layer)}\n`));
    const layerRef = { layerId: layer.layerId, assetId, hash: layer.contentHash, baseTopologyHash: oldBase.topologyHash };
    fx.snapshot = sourceSnapshot(fx.projectId, fx.mapRef, 1, [layerRef]);
    const manifestHash = compilerContentHash({ manifest: "rebased" });
    const created = service(fx, {
      compileAtlasMapDoc: () => ({ worldMap, warnings: [] }),
      compileWorldTerrain(input) {
        assert.equal(input.terrainEditLayers.length, 1);
        const compiled = input.terrainEditLayers[0];
        assert.notEqual(compiled.contentHash, layer.contentHash, "stale topology content reached the compiler");
        assert.equal(compiled.baseTopology.topologyHash, targetBase.topologyHash);
        assert.equal(input.terrainEditLayerRefs[0].contentHash, compiled.contentHash, "ref must bind the rebased content");
        return { manifest: { manifestHash }, artifacts: [], reusedArtifacts: [], snapshot: {}, invalidation: {}, diagnostics: [] };
      },
      publish: async (input) => { await input.readHead(); return { published: true, manifestHash }; },
    });
    await created.instance.reconcileOnce({ waitForBuild: true });
    await created.instance.stop();
  } finally { fx.cleanup(); }
});

test("an unrebasable edit layer fails the build with structured conflicts, never a silent drop", async () => {
  const fx = fixture();
  try {
    const worldMap = fixtureWorldMap();
    const grid = createTerrainGridSpec({ gridId: "other-grid", origin: [0, 0], chunkSizeM: 48, defaultSamples: 33 });
    const oldBase = createTerrainEditBaseTopology({ grid, domain: { minTx: 0, minTz: 0, maxTx: 0, maxTz: 0 } });
    const layer = createTerrainEditLayer({
      layerId: "sculpt",
      baseTopology: oldBase,
      operations: [{ operationId: "raise", kind: "add", deltas: [{ gx: 1, gz: 1, deltaM: 2 }] }],
    });
    const assetId = "assets/terrain/sculpt.layer.json";
    const path = join(fx.projectRoot, ...assetId.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(`${canonicalCompilerJson(layer)}\n`));
    const layerRef = { layerId: layer.layerId, assetId, hash: layer.contentHash, baseTopologyHash: oldBase.topologyHash };
    fx.snapshot = sourceSnapshot(fx.projectId, fx.mapRef, 1, [layerRef]);
    const errors = [];
    let compiled = false;
    const created = service(fx, {
      compileAtlasMapDoc: () => ({ worldMap, warnings: [] }),
      compileWorldTerrain() { compiled = true; throw new Error("an unrebasable layer reached the compiler"); },
      publish: async () => { throw new Error("an unrebasable layer reached publication"); },
      logger: { info() {}, error(message) { errors.push(message); } },
    });
    await assert.rejects(created.instance.reconcileOnce({ waitForBuild: true }), (error) => (
      error instanceof DerivedBuildServiceError && error.code === "TERRAIN_EDIT_REBASE_CONFLICT" && error.message.includes("grid_mismatch")
    ));
    assert.equal(compiled, false);
    const conflictLines = errors.filter((line) => line.includes("rebase conflicts"));
    assert.equal(conflictLines.length, 1, "rebase conflicts must surface in the build log");
    assert.match(conflictLines[0], /grid_mismatch/);
    await created.instance.stop();
  } finally { fx.cleanup(); }
});

test("passes verified previous chunk and global artifact availability into sparse compilation", async () => {
  const fx = fixture();
  try {
    fx.snapshot = sourceSnapshot(fx.projectId, fx.mapRef, 2);
    const priorHash = compilerContentHash({ prior: "artifact" });
    const priorGlobalHash = compilerContentHash({ prior: "global-artifact" });
    const priorSnapshotHash = compilerContentHash({ prior: "snapshot" });
    const previous = {
      snapshot: { snapshotHash: priorSnapshotHash },
      manifest: previousManifest(fx.projectId, priorHash, priorSnapshotHash, priorGlobalHash),
    };
    let sawPrevious = false;
    const manifestHash = compilerContentHash({ manifest: 2 });
    const created = service(fx, {
      loadPrevious: async () => previous,
      compileWorldTerrain(input) {
        sawPrevious = input.previousSnapshot === previous.snapshot
          && input.previousManifest === previous.manifest
          && input.availableArtifactHashes.join() === [priorGlobalHash, priorHash].sort().join();
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
    assert.equal(created.coordinator.submissions.length, 0, "invalid immutable source reached the build queue");
    await created.instance.stop();
  } finally { fx.cleanup(); }
});

test("a failed reuse verification forces the next retry onto a cold rebuild", async () => {
  const fx = fixture();
  try {
    fx.snapshot = sourceSnapshot(fx.projectId, fx.mapRef, 2);
    const priorHash = compilerContentHash({ prior: "artifact" });
    const priorSnapshotHash = compilerContentHash({ prior: "snapshot" });
    const previous = {
      snapshot: { snapshotHash: priorSnapshotHash },
      manifest: previousManifest(fx.projectId, priorHash, priorSnapshotHash),
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

test("real coordinator and publisher preserve selected biome globals across cold, sparse, and precipitation builds", async () => {
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
        configHash: compilerContentHash({ fixture: true }),
        graphHash: compilerContentHash({ graph: "real-integration" }),
      },
    };
    const biomeCompiler = compilerProfile("1.3.0", "real-biome");
    const grid = createTerrainGridSpec({ gridId: `${fx.projectId}.surface`, origin: [0, 0], chunkSizeM: 48, defaultSamples: 33 });
    const chunkId = terrainChunkId(grid.gridId, 0, 0, 0);
    const bytes = Uint8Array.from(Buffer.from("real-service-artifact"));
    const contentHash = derivedArtifactContentHash(bytes);
    const globalBytes = Uint8Array.from(Buffer.from("real-service-global-hydrology"));
    const globalContentHash = derivedArtifactContentHash(globalBytes);
    const wetterGlobalBytes = Uint8Array.from(Buffer.from("real-service-global-hydrology-wetter"));
    const wetterGlobalContentHash = derivedArtifactContentHash(wetterGlobalBytes);
    const biomeBytes = Uint8Array.from(Buffer.from("real-service-global-biome"));
    const biomeContentHash = derivedArtifactContentHash(biomeBytes);
    const wetterBiomeBytes = Uint8Array.from(Buffer.from("real-service-global-biome-wetter"));
    const wetterBiomeContentHash = derivedArtifactContentHash(wetterBiomeBytes);
    let compileCount = 0;
    const instance = new DerivedBuildService({
      projectId: fx.projectId,
      projectRoot: fx.projectRoot,
      authoringClient: authority,
      assetStore: fx.assetStore,
      compiler,
      compilerForWorldMap: (worldMap) => worldMap.hydrology === undefined ? compiler : biomeCompiler,
      compileAtlasMapDoc: () => ({ worldMap: { fixture: true, hydrology: {} }, warnings: [] }),
      compileWorldTerrain(input) {
        compileCount++;
        assert.equal(input.compiler.version, "1.3.0", "recipe build did not select the biome compiler profile");
        if (input.previousSnapshot !== null) {
          assert.deepEqual(input.availableArtifactHashes, [contentHash, globalContentHash, biomeContentHash].sort(),
            "restart/sparse compile lost hydrology or biome global availability");
        }
        const precipitationChanged = input.request.revision >= 3;
        const selectedGlobalBytes = precipitationChanged ? wetterGlobalBytes : globalBytes;
        const selectedGlobalContentHash = precipitationChanged ? wetterGlobalContentHash : globalContentHash;
        const selectedBiomeBytes = precipitationChanged ? wetterBiomeBytes : biomeBytes;
        const selectedBiomeContentHash = precipitationChanged ? wetterBiomeContentHash : biomeContentHash;
        const snapshotCore = {
          schema: COMPILER_SNAPSHOT_SCHEMA,
          graphHash: biomeCompiler.identity.graphHash,
          chunks: [{ chunkId, gridId: grid.gridId, lod: 0, tx: 0, tz: 0, chunkTopologyHash: compilerContentHash({ topology: 1 }) }],
          stageKeys: {
            render: { [chunkId]: compilerContentHash({ render: 1 }) },
            "hydrology-field": { "@global": compilerContentHash({ precipitation: precipitationChanged ? 2 : 1 }) },
            "biome-field": { "@global": compilerContentHash({ biome: precipitationChanged ? 2 : 1 }) },
          },
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
          compiler: { ...biomeCompiler.identity, snapshotHash: snapshot.snapshotHash },
          grid,
          globalArtifacts: [
            {
              artifactType: "biome-field/v1",
              contentHash: selectedBiomeContentHash,
              byteLength: selectedBiomeBytes.byteLength,
              mediaType: "application/vnd.limina.biome-field-v1",
            },
            {
              artifactType: "hydrology-field/v1",
              contentHash: selectedGlobalContentHash,
              byteLength: selectedGlobalBytes.byteLength,
              mediaType: "application/vnd.limina.hydrology-field",
            },
          ],
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
        const descriptor = { scope: "chunk", chunkId, artifactType: "terrain-chunk/v1", mediaType: "application/vnd.limina.terrain-chunk", contentHash, byteLength: bytes.byteLength };
        const globalDescriptor = { scope: "global", artifactType: "hydrology-field/v1", mediaType: "application/vnd.limina.hydrology-field", contentHash: selectedGlobalContentHash, byteLength: selectedGlobalBytes.byteLength };
        const biomeDescriptor = { scope: "global", artifactType: "biome-field/v1", mediaType: "application/vnd.limina.biome-field-v1", contentHash: selectedBiomeContentHash, byteLength: selectedBiomeBytes.byteLength };
        const cold = input.previousSnapshot === null;
        return {
          manifest,
          artifacts: cold
            ? [
              { ...descriptor, bytes },
              { scope: "global", artifactType: globalDescriptor.artifactType, mediaType: globalDescriptor.mediaType, contentHash: selectedGlobalContentHash, bytes: selectedGlobalBytes },
              { scope: "global", artifactType: biomeDescriptor.artifactType, mediaType: biomeDescriptor.mediaType, contentHash: selectedBiomeContentHash, bytes: selectedBiomeBytes },
            ]
            : precipitationChanged
              ? [
                { scope: "global", artifactType: globalDescriptor.artifactType, mediaType: globalDescriptor.mediaType, contentHash: selectedGlobalContentHash, bytes: selectedGlobalBytes },
                { scope: "global", artifactType: biomeDescriptor.artifactType, mediaType: biomeDescriptor.mediaType, contentHash: selectedBiomeContentHash, bytes: selectedBiomeBytes },
              ]
              : [],
          reusedArtifacts: cold ? [] : [descriptor, ...(precipitationChanged ? [] : [globalDescriptor, biomeDescriptor])].sort((a, b) => {
            const ak = a.scope === "global" ? `global\u0000${a.artifactType}` : `chunk\u0000${a.chunkId}\u0000${a.artifactType}`;
            const bk = b.scope === "global" ? `global\u0000${b.artifactType}` : `chunk\u0000${b.chunkId}\u0000${b.artifactType}`;
            return ak < bk ? -1 : ak > bk ? 1 : 0;
          }),
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
    fx.snapshot = sourceSnapshot(fx.projectId, fx.mapRef, 3);
    const third = await instance.reconcileOnce({ waitForBuild: true });
    assert.equal(third.revision, 3);
    assert.equal(compileCount, 3);
    const current = await readPublishedDerivedRevision({
      projectRoot: fx.projectRoot,
      branchId: "main",
      readHead: async () => ({ projectId: fx.projectId, branchId: "main", revision: 3, headHash: fx.snapshot.head.headHash }),
    });
    assert.equal(current.status, "current");
    assert.equal(current.pointer.generation, 3);
    assert.equal(current.snapshot.snapshotHash, current.manifest.compiler.snapshotHash);
    assert.equal(current.manifest.chunks[0].artifacts[0].contentHash, contentHash);
    const publishedBiome = current.manifest.globalArtifacts.find((artifact) => artifact.artifactType === "biome-field/v1");
    const publishedHydrology = current.manifest.globalArtifacts.find((artifact) => artifact.artifactType === "hydrology-field/v1");
    assert.equal(publishedHydrology.contentHash, wetterGlobalContentHash);
    assert.equal(publishedBiome.contentHash, wetterBiomeContentHash);
    const carriedBiome = resolveCurrentPublishedDerivedArtifact({
      projectRoot: fx.projectRoot,
      branchId: "main",
      manifestHash: current.manifest.manifestHash,
      contentHash: wetterBiomeContentHash,
    });
    assert.equal(carriedBiome.descriptor.artifactType, "biome-field/v1");
    assert.deepEqual(new Uint8Array(readFileSync(carriedBiome.path)), wetterBiomeBytes,
      "published biome global bytes were not carried through real build-service/runtime resolution");
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
      compilerForWorldMap: (worldMap) => worldMap.hydrology === undefined ? compiler : biomeCompiler,
      compileAtlasMapDoc: () => ({ worldMap: { fixture: true, hydrology: {} }, warnings: [] }),
      compileWorldTerrain() { throw new Error("already-published source must not compile"); },
      loadPrevious: () => readPublishedDerivedRevision({
        projectRoot: fx.projectRoot,
        branchId: "main",
        readHead: async () => ({ projectId: fx.projectId, branchId: "main", revision: 3, headHash: fx.snapshot.head.headHash }),
      }),
      logger: { info() {}, error() {} },
    });
    const restartResult = await restarted.reconcileOnce({ waitForBuild: true });
    assert.equal(restartResult.status, "already-published");
    assert.equal(restartResult.manifestHash, current.manifest.manifestHash);
    await restarted.stop();
  } finally { fx.cleanup(); }
});
