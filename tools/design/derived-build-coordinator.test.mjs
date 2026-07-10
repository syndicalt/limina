import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTerrainGridSpec, terrainChunkId } from "../../js/src/terrain/grid.mjs";
import {
  DERIVED_REVISION_MANIFEST_SCHEMA,
  compilerContentHash,
  createDerivedRevisionManifest,
  derivedArtifactContentHash,
} from "../../js/src/world/compiler/index.mjs";
import {
  DERIVED_BUILD_DIAGNOSTICS_SCHEMA,
  DERIVED_BUILD_REQUEST_SCHEMA,
  DerivedBuildCoordinator,
  DerivedBuildCoordinatorError,
} from "./derived-build-coordinator.mjs";

function hash(label) { return compilerContentHash({ label }); }

function source(revision) {
  return { revision, headHash: hash(`head:${revision}`) };
}

function compiler(tag = "1") {
  return {
    version: `${tag}.0.0`,
    configHash: hash(`config:${tag}`),
    graphHash: hash(`graph:${tag}`),
  };
}

function request(revision, overrides = {}) {
  const identity = source(revision);
  return {
    schema: DERIVED_BUILD_REQUEST_SCHEMA,
    projectId: "grey-field",
    branchId: "main",
    revision: identity.revision,
    headHash: identity.headHash,
    ...overrides,
  };
}

function authority(identity, branchId = "main") {
  return { projectId: "grey-field", branchId, revision: identity.revision, headHash: identity.headHash };
}

function compileFixture(identity, tag = `r${identity.revision}`, branchId = "main", compilerIdentity = compiler()) {
  const bytes = new Uint8Array(Buffer.from(`artifact:${tag}`, "utf8"));
  const contentHash = derivedArtifactContentHash(bytes);
  const grid = createTerrainGridSpec({
    gridId: "grey-field.surface",
    origin: [0, 0],
    chunkSizeM: 64,
    defaultSamples: 65,
  });
  const manifest = createDerivedRevisionManifest({
    schema: DERIVED_REVISION_MANIFEST_SCHEMA,
    projectId: "grey-field",
    branchId,
    source: {
      revision: identity.revision,
      headHash: identity.headHash,
      contentRefs: [{
        refId: "map-document",
        refType: "map-document/v1",
        scope: "global",
        assetId: "sources/map.mapdoc.json",
        contentHash: hash(`map:${identity.revision}`),
      }],
    },
    compiler: {
      version: compilerIdentity.version,
      configHash: compilerIdentity.configHash,
      graphHash: compilerIdentity.graphHash,
      snapshotHash: hash(`snapshot:${tag}`),
    },
    grid,
    chunks: [{
      chunkId: terrainChunkId(grid.gridId, 0, 0, 0),
      gridId: grid.gridId,
      lod: 0,
      tx: 0,
      tz: 0,
      topologyHash: hash("topology:0:0"),
      sourceSliceHashes: [],
      artifacts: [{
        artifactType: "render-mesh/v1",
        contentHash,
        byteLength: bytes.byteLength,
        mediaType: "model/gltf-binary",
      }],
    }],
  });
  return { manifest, artifacts: [{ contentHash, bytes }] };
}

function reusedDescriptor(fixture) {
  const chunk = fixture.manifest.chunks[0];
  const artifact = chunk.artifacts[0];
  return {
    chunkId: chunk.chunkId,
    artifactType: artifact.artifactType,
    mediaType: artifact.mediaType,
    contentHash: artifact.contentHash,
    byteLength: artifact.byteLength,
  };
}

function sparseFixture(fixture) {
  return { manifest: fixture.manifest, artifacts: [], reusedArtifacts: [reusedDescriptor(fixture)] };
}

async function confirmingPublish({ manifest, readHead }) {
  await readHead();
  return { published: true, manifestHash: manifest.manifestHash };
}

function coordinator(overrides = {}) {
  let current = source(1);
  const options = {
    projectId: "grey-field",
    projectRoot: "/not-used-by-test-publisher",
    compiler: compiler(),
    readHead: async ({ branchId }) => authority(current, branchId),
    compile: async ({ revision, branchId, compiler: compilerIdentity }) => compileFixture(source(revision), `r${revision}`, branchId, compilerIdentity),
    publish: confirmingPublish,
    ...overrides,
  };
  return {
    coordinator: new DerivedBuildCoordinator(options),
    setHead(value) { current = value; },
  };
}

function assertCode(code) {
  return (error) => error instanceof DerivedBuildCoordinatorError && error.code === code;
}

test("identical active requests share one deterministic build", async () => {
  let compileCalls = 0;
  let release;
  const entered = new Promise((resolve) => { release = resolve; });
  let allowCompile;
  const allowed = new Promise((resolve) => { allowCompile = resolve; });
  const setup = coordinator({
    compile: async ({ revision, compiler: compilerIdentity }) => {
      compileCalls++;
      release();
      await allowed;
      return compileFixture(source(revision), `r${revision}`, "main", compilerIdentity);
    },
  });
  const first = setup.coordinator.submit(request(1));
  await entered;
  const second = setup.coordinator.submit(request(1));
  assert.strictEqual(second, first);
  allowCompile();
  const [a, b] = await Promise.all([first, second]);
  assert.strictEqual(a, b);
  assert.equal(compileCalls, 1);
  assert.match(a.buildId, /^derived-[0-9a-f]{64}$/);
  assert.equal(setup.coordinator.diagnostics().counts.coalesced, 1);
});

test("newer intent cancels active work and replaces pending work without starting the middle revision", async () => {
  let firstEntered;
  const entered = new Promise((resolve) => { firstEntered = resolve; });
  const compiled = [];
  const setup = coordinator({
    compile: async ({ revision, signal, compiler: compilerIdentity }) => {
      compiled.push(revision);
      if (revision === 1) {
        firstEntered();
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return compileFixture(source(revision), `r${revision}`, "main", compilerIdentity);
    },
  });
  const first = setup.coordinator.submit(request(1));
  const observedFirst = first.catch((error) => error);
  await entered;
  setup.setHead(source(2));
  const second = setup.coordinator.submit(request(2));
  const observedSecond = second.catch((error) => error);
  setup.setHead(source(3));
  const third = setup.coordinator.submit(request(3));

  assert.equal((await observedFirst).code, "BUILD_SUPERSEDED");
  assert.equal((await observedSecond).code, "BUILD_SUPERSEDED");
  assert.equal((await third).revision, 3);
  assert.deepEqual(compiled, [1, 3]);
  const diagnostics = setup.coordinator.diagnostics();
  assert.equal(diagnostics.counts.superseded, 2);
  assert.equal(diagnostics.counts.succeeded, 1);
});

test("lower revisions and equal revisions with conflicting hashes cannot replace newer intent", async () => {
  const setup = coordinator();
  setup.setHead(source(4));
  await setup.coordinator.submit(request(4));
  await assert.rejects(setup.coordinator.submit(request(3)), assertCode("STALE_BUILD_REQUEST"));
  await assert.rejects(
    setup.coordinator.submit(request(4, { headHash: hash("conflicting-head:4") })),
    assertCode("STALE_BUILD_REQUEST"),
  );
  assert.equal(setup.coordinator.diagnostics().counts.rejected, 2);
});

test("authority drift before compilation prevents compiler execution", async () => {
  let compileCalls = 0;
  const setup = coordinator({
    readHead: async () => authority(source(2)),
    compile: async () => { compileCalls++; return compileFixture(source(1)); },
  });
  await assert.rejects(setup.coordinator.submit(request(1)), assertCode("AUTHORITY_DRIFT"));
  assert.equal(compileCalls, 0);
});

test("authority drift after compilation prevents publication", async () => {
  let headReads = 0;
  let publishCalls = 0;
  const setup = coordinator({
    readHead: async () => authority(++headReads === 1 ? source(1) : source(2)),
    publish: async (input) => { publishCalls++; return confirmingPublish(input); },
  });
  await assert.rejects(setup.coordinator.submit(request(1)), assertCode("AUTHORITY_DRIFT"));
  assert.equal(headReads, 2);
  assert.equal(publishCalls, 0);
});

test("compile output is strict and artifact sets must be complete, unique, and authentic", async (t) => {
  const fixture = compileFixture(source(1));
  const cases = [
    ["missing output fields", {}, /fields differ/],
    ["missing artifact", { manifest: fixture.manifest, artifacts: [] }, /missing artifact/],
    ["duplicate artifact", { manifest: fixture.manifest, artifacts: [fixture.artifacts[0], fixture.artifacts[0]] }, /duplicate/],
    ["corrupt artifact", {
      manifest: fixture.manifest,
      artifacts: [{ contentHash: fixture.artifacts[0].contentHash, bytes: new Uint8Array(fixture.artifacts[0].bytes.byteLength) }],
    }, /content hash mismatch/],
    ["unreferenced artifact", {
      manifest: fixture.manifest,
      artifacts: [...fixture.artifacts, { contentHash: derivedArtifactContentHash(new Uint8Array([9])), bytes: new Uint8Array([9]) }],
    }, /unreferenced/],
  ];
  for (const [name, output, pattern] of cases) {
    await t.test(name, async () => {
      const setup = coordinator({ compile: async () => output });
      await assert.rejects(
        setup.coordinator.submit(request(1)),
        (error) => assertCode("INVALID_COMPILE_OUTPUT")(error) && pattern.test(error.message),
      );
    });
  }
});

test("manifest identity mismatch is rejected before publication", async () => {
  const wrong = compileFixture(source(2));
  const setup = coordinator({ compile: async () => wrong });
  await assert.rejects(setup.coordinator.submit(request(1)), /source or compiler identity/);
});

test("sparse compile output requires independent reuse verification before publication", async () => {
  const fixture = compileFixture(source(1), "sparse");
  const phases = [];
  const setup = coordinator({
    compile: async () => sparseFixture(fixture),
    verifyReusableArtifacts: async ({ manifest, reusedArtifacts, signal }) => {
      phases.push("verify");
      assert.equal(signal.aborted, false);
      assert.equal(manifest.manifestHash, fixture.manifest.manifestHash);
      assert.deepEqual(reusedArtifacts, [reusedDescriptor(fixture)]);
    },
    publish: async ({ reusedArtifacts, readHead }) => {
      phases.push("publish");
      assert.deepEqual(reusedArtifacts, [reusedDescriptor(fixture)]);
      await readHead();
      return { published: true, manifestHash: fixture.manifest.manifestHash };
    },
  });
  assert.equal((await setup.coordinator.submit(request(1))).status, "published");
  assert.deepEqual(phases, ["verify", "publish"]);
});

test("sparse compile fails closed without a reuse verifier or when verification fails", async (t) => {
  const fixture = compileFixture(source(1), "sparse-verifier");
  await t.test("missing verifier", async () => {
    let publishCalls = 0;
    const setup = coordinator({
      compile: async () => sparseFixture(fixture),
      publish: async () => { publishCalls++; return { published: true, manifestHash: fixture.manifest.manifestHash }; },
    });
    await assert.rejects(setup.coordinator.submit(request(1)), assertCode("REUSE_VERIFIER_REQUIRED"));
    assert.equal(publishCalls, 0);
  });
  await t.test("failed verifier", async () => {
    let publishCalls = 0;
    const setup = coordinator({
      compile: async () => sparseFixture(fixture),
      verifyReusableArtifacts: async () => { throw new Error("reused artifact vanished"); },
      publish: async () => { publishCalls++; return { published: true, manifestHash: fixture.manifest.manifestHash }; },
    });
    await assert.rejects(setup.coordinator.submit(request(1)), /reused artifact vanished/);
    assert.equal(publishCalls, 0);
  });
});

test("sparse artifact partitions reject overlap and forged reuse descriptors", async (t) => {
  const fixture = compileFixture(source(1), "sparse-invalid");
  const descriptor = reusedDescriptor(fixture);
  const cases = [
    ["overlap", { manifest: fixture.manifest, artifacts: fixture.artifacts, reusedArtifacts: [descriptor] }, /both supplied and reused/],
    ["forged byte length", { manifest: fixture.manifest, artifacts: [], reusedArtifacts: [{ ...descriptor, byteLength: descriptor.byteLength + 1 }] }, /does not match/],
    ["forged location", { manifest: fixture.manifest, artifacts: [], reusedArtifacts: [{ ...descriptor, chunkId: "grey-field.surface:l0:1:0" }] }, /does not match/],
  ];
  for (const [name, output, pattern] of cases) await t.test(name, async () => {
    const setup = coordinator({ compile: async () => output, verifyReusableArtifacts: async () => {} });
    await assert.rejects(setup.coordinator.submit(request(1)), (error) => assertCode("INVALID_COMPILE_OUTPUT")(error) && pattern.test(error.message));
  });
});

test("supersession aborts reuse verification and never publishes the superseded revision", async () => {
  let entered;
  const verifying = new Promise((resolve) => { entered = resolve; });
  const published = [];
  const setup = coordinator({
    compile: async ({ revision, compiler: compilerIdentity }) => {
      const fixture = compileFixture(source(revision), `reuse-${revision}`, "main", compilerIdentity);
      return revision === 1 ? sparseFixture(fixture) : fixture;
    },
    verifyReusableArtifacts: async ({ signal }) => {
      entered();
      await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
    publish: async ({ manifest, readHead }) => {
      published.push(manifest.source.revision);
      await readHead();
      return { published: true, manifestHash: manifest.manifestHash };
    },
  });
  const first = setup.coordinator.submit(request(1));
  const firstError = first.catch((error) => error);
  await verifying;
  setup.setHead(source(2));
  const second = setup.coordinator.submit(request(2));
  assert.equal((await firstError).code, "BUILD_SUPERSEDED");
  assert.equal((await second).revision, 2);
  assert.deepEqual(published, [2]);
});

test("trusted constructor compiler identity participates in build identity and manifest validation", async () => {
  const firstSetup = coordinator();
  const secondSetup = coordinator({
    compiler: compiler("2"),
    compile: async ({ revision, branchId, compiler: compilerIdentity }) => (
      compileFixture(source(revision), `compiler-${compilerIdentity.version}`, branchId, compilerIdentity)
    ),
  });
  const first = await firstSetup.coordinator.submit(request(1));
  const second = await secondSetup.coordinator.submit(request(1));
  assert.notEqual(first.buildId, second.buildId);
  assert.notEqual(first.manifestHash, second.manifestHash);
  assert.deepEqual(second.compiler, compiler("2"));
  assert.throws(
    () => firstSetup.coordinator.submit(request(1, { compiler: compiler("2") })),
    assertCode("INVALID_INPUT"),
  );

  const mismatched = coordinator({ compiler: compiler("2"), compile: async () => compileFixture(source(1), "wrong-compiler") });
  await assert.rejects(
    mismatched.coordinator.submit(request(1)),
    assertCode("INVALID_COMPILE_OUTPUT"),
  );
});

test("publisher failure does not poison an identical retry", async () => {
  let attempts = 0;
  const setup = coordinator({
    publish: async (input) => {
      await input.readHead();
      if (++attempts === 1) throw new Error("disk temporarily unavailable");
      return { published: true, manifestHash: input.manifest.manifestHash };
    },
  });
  await assert.rejects(setup.coordinator.submit(request(1)), /disk temporarily unavailable/);
  const recovered = await setup.coordinator.submit(request(1));
  assert.equal(recovered.status, "published");
  assert.equal(attempts, 2);
  assert.equal(setup.coordinator.diagnostics().counts.failed, 1);
});

test("a failed newer publication preserves bounded last-known-good metadata", async () => {
  let failRevision = 2;
  const setup = coordinator({
    publish: async (input) => {
      await input.readHead();
      if (input.manifest.source.revision === failRevision) throw new Error("publish revision two failed");
      return { published: true, manifestHash: input.manifest.manifestHash };
    },
  });
  const baseline = await setup.coordinator.submit(request(1));
  setup.setHead(source(2));
  await assert.rejects(setup.coordinator.submit(request(2)), /publish revision two failed/);
  const diagnostics = setup.coordinator.diagnostics();
  assert.equal(diagnostics.lastKnownGood.length, 1);
  assert.equal(diagnostics.lastKnownGood[0].revision, 1);
  assert.equal(diagnostics.lastKnownGood[0].manifestHash, baseline.manifestHash);
  assert.doesNotMatch(JSON.stringify(diagnostics.lastKnownGood), /artifacts|bytes/);
  failRevision = -1;
  assert.equal((await setup.coordinator.submit(request(2))).revision, 2);
});

test("publisher success without its commit-time authority check is rejected", async () => {
  const setup = coordinator({
    publish: async ({ manifest }) => ({ published: true, manifestHash: manifest.manifestHash }),
  });
  await assert.rejects(setup.coordinator.submit(request(1)), assertCode("PUBLISH_AUTHORITY_NOT_CHECKED"));
});

test("a late supersession after atomic publication does not misreport the committed build as cancelled", async () => {
  let committed;
  const publicationCommitted = new Promise((resolve) => { committed = resolve; });
  let release;
  const mayReturn = new Promise((resolve) => { release = resolve; });
  const setup = coordinator({
    publish: async (input) => {
      await input.readHead();
      if (input.manifest.source.revision === 1) {
        committed();
        await mayReturn;
      }
      return { published: true, manifestHash: input.manifest.manifestHash };
    },
  });
  const first = setup.coordinator.submit(request(1));
  await publicationCommitted;
  setup.setHead(source(2));
  const second = setup.coordinator.submit(request(2));
  release();
  assert.equal((await first).status, "published");
  assert.equal((await second).revision, 2);
  const diagnostics = setup.coordinator.diagnostics();
  assert.equal(diagnostics.counts.succeeded, 2);
  assert.equal(diagnostics.counts.superseded, 0);
});

test("malformed authority and malformed publisher results fail closed", async (t) => {
  await t.test("authority", async () => {
    const setup = coordinator({ readHead: async () => ({ projectId: "grey-field" }) });
    await assert.rejects(setup.coordinator.submit(request(1)), /fields differ/);
  });
  await t.test("publisher result", async () => {
    const setup = coordinator({ publish: async ({ readHead }) => { await readHead(); return { published: true }; } });
    await assert.rejects(setup.coordinator.submit(request(1)), assertCode("INVALID_PUBLISH_RESULT"));
  });
});

test("diagnostics are bounded, report phases and duration, and retain no artifact buffers", async () => {
  let now = 100;
  let failures = 0;
  const setup = coordinator({
    now: () => now++,
    maxDiagnostics: 2,
    compile: async () => { failures++; throw new Error(`compile-failure-${failures}`); },
  });
  for (let index = 0; index < 4; index++) {
    await assert.rejects(setup.coordinator.submit(request(1)), /compile-failure/);
  }
  const diagnostics = setup.coordinator.diagnostics();
  assert.equal(diagnostics.schema, DERIVED_BUILD_DIAGNOSTICS_SCHEMA);
  assert.equal(diagnostics.counts.failed, 4);
  assert.equal(diagnostics.counts.diagnosticsDropped, 2);
  assert.equal(diagnostics.truncated, true);
  assert.equal(diagnostics.recent.length, 2);
  assert.ok(diagnostics.recent.every((entry) => entry.phase === "compile" && entry.durationMs >= 0));
  assert.doesNotMatch(JSON.stringify(diagnostics), /artifacts|Uint8Array|bytes/);
});

test("successful terminal state exposes only bounded metadata and coalesces later identical intent", async () => {
  let compileCalls = 0;
  const setup = coordinator({
    compile: async ({ revision, compiler: compilerIdentity }) => {
      compileCalls++;
      return compileFixture(source(revision), "private-payload", "main", compilerIdentity);
    },
  });
  const result = await setup.coordinator.submit(request(1));
  const repeated = await setup.coordinator.submit(request(1));
  assert.strictEqual(result, repeated);
  assert.deepEqual(Object.keys(result).sort(), [
    "branchId", "buildId", "compiler", "durationMs", "headHash", "manifestHash", "projectId", "revision", "status",
  ]);
  assert.equal(compileCalls, 1);
  assert.doesNotMatch(JSON.stringify(setup.coordinator.diagnostics()), /private-payload|artifact:/);
});

test("tracked branch state is resource bounded", async () => {
  const setup = coordinator({ maxTrackedBranches: 1 });
  await setup.coordinator.submit(request(1));
  assert.throws(
    () => setup.coordinator.submit(request(1, { branchId: "second" })),
    assertCode("BRANCH_LIMIT"),
  );
});

test("global build concurrency is bounded and queued branches start in FIFO order", async () => {
  const starts = [];
  let releaseFirst;
  const firstMayFinish = new Promise((resolve) => { releaseFirst = resolve; });
  const scheduler = new DerivedBuildCoordinator({
    projectId: "grey-field",
    projectRoot: "/not-used-by-test-publisher",
    compiler: compiler(),
    maxConcurrentBuilds: 1,
    readHead: async ({ branchId }) => authority(source(1), branchId),
    compile: async ({ revision, branchId, compiler: compilerIdentity }) => {
      starts.push(branchId);
      if (branchId === "main") await firstMayFinish;
      return compileFixture(source(revision), branchId, branchId, compilerIdentity);
    },
    publish: confirmingPublish,
  });
  const first = scheduler.submit(request(1));
  await new Promise((resolve) => setImmediate(resolve));
  const second = scheduler.submit(request(1, { branchId: "second" }));
  const third = scheduler.submit(request(1, { branchId: "third" }));
  const during = scheduler.diagnostics();
  assert.equal(during.capacity.running, 1);
  assert.equal(during.capacity.ready, 2);
  assert.equal(during.active.length, 3);
  assert.deepEqual(starts, ["main"]);
  releaseFirst();
  await Promise.all([first, second, third]);
  assert.deepEqual(starts, ["main", "second", "third"]);
  assert.equal(scheduler.diagnostics().capacity.running, 0);
});

test("a failed running branch releases capacity for queued work", async () => {
  let failFirst;
  const firstCanFail = new Promise((resolve) => { failFirst = resolve; });
  const starts = [];
  const scheduler = new DerivedBuildCoordinator({
    projectId: "grey-field",
    projectRoot: "/not-used-by-test-publisher",
    compiler: compiler(),
    maxConcurrentBuilds: 1,
    readHead: async ({ branchId }) => authority(source(1), branchId),
    compile: async ({ revision, branchId, compiler: compilerIdentity }) => {
      starts.push(branchId);
      if (branchId === "main") {
        await firstCanFail;
        throw new Error("first branch failed");
      }
      return compileFixture(source(revision), branchId, branchId, compilerIdentity);
    },
    publish: confirmingPublish,
  });
  const first = scheduler.submit(request(1));
  const observedFirst = first.catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  const second = scheduler.submit(request(1, { branchId: "second" }));
  failFirst();
  assert.match((await observedFirst).message, /first branch failed/);
  assert.equal((await second).branchId, "second");
  assert.deepEqual(starts, ["main", "second"]);
  assert.equal(scheduler.diagnostics().capacity.running, 0);
});

test("close aborts active work, rejects queued work, and resolves only after the coordinator is idle", async () => {
  let activeStarted;
  const started = new Promise((resolve) => { activeStarted = resolve; });
  const published = [];
  const scheduler = new DerivedBuildCoordinator({
    projectId: "grey-field",
    projectRoot: "/not-used-by-test-publisher",
    compiler: compiler(),
    maxConcurrentBuilds: 1,
    readHead: async ({ branchId }) => authority(source(1), branchId),
    compile: async ({ branchId, signal }) => {
      if (branchId === "main") {
        activeStarted();
        await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      return compileFixture(source(1), branchId, branchId);
    },
    publish: async ({ manifest, readHead }) => {
      published.push(manifest.branchId);
      await readHead();
      return { published: true, manifestHash: manifest.manifestHash };
    },
  });
  const active = scheduler.submit(request(1));
  const activeError = active.catch((error) => error);
  await started;
  const queued = scheduler.submit(request(1, { branchId: "queued" }));
  const queuedError = queued.catch((error) => error);
  const closing = scheduler.close("test shutdown");
  assert.equal((await activeError).code, "BUILD_CANCELLED");
  assert.equal((await queuedError).code, "BUILD_CANCELLED");
  await closing;
  await scheduler.whenIdle();
  assert.deepEqual(published, []);
  assert.equal(scheduler.diagnostics().capacity.running, 0);
  assert.throws(() => scheduler.submit(request(1)), assertCode("COORDINATOR_CLOSED"));
});

test("default publisher adapter writes a validated derived revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "limina-derived-coordinator-"));
  try {
    mkdirSync(join(root, "assets"));
    mkdirSync(join(root, ".limina"));
    writeFileSync(join(root, "limina.project.json"), `${JSON.stringify({
      schema: "limina-project/1",
      projectId: "grey-field",
      assetRoot: "assets",
      stateDir: ".limina",
    })}\n`);
    const coordinatorWithDefault = new DerivedBuildCoordinator({
      projectId: "grey-field",
      projectRoot: root,
      compiler: compiler(),
      readHead: async () => authority(source(1)),
      compile: async () => compileFixture(source(1), "default-publisher"),
    });
    const result = await coordinatorWithDefault.submit(request(1));
    const pointer = JSON.parse(readFileSync(join(root, ".limina", "derived", "main", "published.json"), "utf8"));
    assert.equal(pointer.current.manifestHash, result.manifestHash);
    assert.equal(pointer.generation, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
