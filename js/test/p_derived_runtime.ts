import { ops } from "../src/engine.ts";
import { terrainChunkId, createTerrainGridSpec } from "../src/terrain/grid.mjs";
import {
  DERIVED_REVISION_MANIFEST_SCHEMA,
  compilerContentHash,
  createDerivedRevisionManifest,
  derivedArtifactContentHash,
} from "../src/world/compiler/index.mjs";
import { DerivedRevisionManager } from "../src/world/derived-runtime.mjs";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_derived_runtime FAIL: ${message}`);
}

async function rejects(promise: Promise<unknown>, pattern: RegExp, message: string): Promise<void> {
  let failure: unknown;
  try { await promise; } catch (error) { failure = error; }
  assert(failure instanceof Error && pattern.test(failure.message), `${message}: ${failure instanceof Error ? failure.message : "did not reject"}`);
}

async function captureRejection(promise: Promise<unknown>, message: string): Promise<Error> {
  try { await promise; } catch (error) {
    assert(error instanceof Error, `${message}: rejection was not an Error`);
    return error;
  }
  throw new Error(`p_derived_runtime FAIL: ${message}: did not reject`);
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

class TestAbortSignal {
  aborted = false;
  listeners = new Set<() => void>();
  addEventListener(_type: string, listener: () => void): void { this.listeners.add(listener); }
  removeEventListener(_type: string, listener: () => void): void { this.listeners.delete(listener); }
  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const listener of [...this.listeners]) listener();
    this.listeners.clear();
  }
}

const grid = createTerrainGridSpec({ gridId: "grey-field.surface", origin: [-512, -512], chunkSizeM: 64, defaultSamples: 65 });
const hash = (label: string) => compilerContentHash({ label });
const codeUnitCompare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

type ChunkSpec = {
  tx: number;
  tz?: number;
  topology?: string;
  slice?: string;
  bytes?: Uint8Array;
};

function makeManifest(revision: number, specs: ChunkSpec[]) {
  const chunks = specs.map((spec) => {
    const bytes = spec.bytes ?? new Uint8Array([spec.tx & 0xff, revision & 0xff, 17]);
    return {
      chunkId: terrainChunkId(grid.gridId, 0, spec.tx, spec.tz ?? 0),
      gridId: grid.gridId,
      lod: 0,
      tx: spec.tx,
      tz: spec.tz ?? 0,
      topologyHash: hash(spec.topology ?? `topology:${spec.tx}:${spec.tz ?? 0}`),
      sourceSliceHashes: [{ refId: "terrain-edits", contentHash: hash(spec.slice ?? `slice:${spec.tx}:${spec.tz ?? 0}`) }],
      artifacts: [{
        artifactType: "render-mesh/v1",
        contentHash: derivedArtifactContentHash(bytes),
        byteLength: bytes.byteLength,
        mediaType: "model/gltf-binary",
      }],
      fixtureBytes: bytes,
    };
  }).sort((a, b) => codeUnitCompare(a.chunkId, b.chunkId));
  const manifest = createDerivedRevisionManifest({
    schema: DERIVED_REVISION_MANIFEST_SCHEMA,
    projectId: "grey-field",
    branchId: "main",
    source: {
      revision,
      headHash: hash(`head:${revision}`),
      contentRefs: [
        { refId: "map-document", refType: "map-document/v1", scope: "global", assetId: "design/maps/grey-field.map.json", contentHash: hash(`map:${revision}`) },
        { refId: "terrain-edits", refType: "terrain-edit-layer/v1", scope: "chunk", assetId: "terrain/edit-layers/primary.json", contentHash: hash(`edit-index:${revision}`) },
      ],
    },
    compiler: {
      version: "1.0.0",
      configHash: hash("compiler-config"),
      graphHash: hash("compiler-graph"),
      snapshotHash: hash(`snapshot:${revision}`),
    },
    grid,
    chunks: chunks.map(({ fixtureBytes: _fixtureBytes, ...chunk }) => chunk),
  });
  const artifacts = new Map(chunks.map((chunk) => [chunk.artifacts[0].contentHash, chunk.fixtureBytes]));
  return { manifest, artifacts };
}

function runtimeResources(current: any): Map<string, any> {
  return new Map(current.chunks.map((entry: any) => [entry.chunkId, entry.resource]));
}

function createHarness(initialAuthority: any, diagnosticsLimit = 64) {
  let authorityManifest = initialAuthority;
  let resourceSequence = 0;
  let failStageChunkId: string | null = null;
  let failActivation = false;
  let artifactOverride: ((input: any) => Promise<Uint8Array> | Uint8Array) | null = null;
  const artifactSets: Map<string, Uint8Array>[] = [];
  const staged: any[] = [];
  const disposed: any[] = [];
  const activations: any[] = [];
  let visible: readonly any[] = [];
  const manager = new DerivedRevisionManager({
    projectId: "grey-field",
    branchId: "main",
    diagnosticsLimit,
    getAuthoritativeSource: () => ({
      projectId: "grey-field",
      branchId: "main",
      revision: authorityManifest.manifest.source.revision,
      headHash: authorityManifest.manifest.source.headHash,
    }),
    loadArtifact: async (input: any) => {
      if (artifactOverride !== null) return await artifactOverride(input);
      for (let index = artifactSets.length - 1; index >= 0; index--) {
        const bytes = artifactSets[index].get(input.artifact.contentHash);
        if (bytes !== undefined) return bytes;
      }
      throw new Error(`missing fixture artifact ${input.artifact.contentHash}`);
    },
    stageChunk: async (input: any) => {
      if (input.chunk.chunkId === failStageChunkId) throw new Error(`stage failed for ${input.chunk.chunkId}`);
      const resource = Object.freeze({ id: ++resourceSequence, chunkId: input.chunk.chunkId });
      staged.push(resource);
      return resource;
    },
    activateRevision: async (input: any) => {
      if (failActivation) throw new Error("activation failed before atomic swap");
      visible = input.chunks;
      activations.push(input);
    },
    disposeChunk: async (input: any) => { disposed.push(input); },
  });
  return {
    manager,
    artifactSets,
    staged,
    disposed,
    activations,
    visible: () => visible,
    setAuthority: (value: any) => { authorityManifest = value; },
    setStageFailure: (chunkId: string | null) => { failStageChunkId = chunkId; },
    setActivationFailure: (value: boolean) => { failActivation = value; },
    setArtifactOverride: (value: typeof artifactOverride) => { artifactOverride = value; },
  };
}

// Changed-only activation preserves stable runtime identity, handles signed chunk IDs, and retires replacements/removals.
const first = makeManifest(1, [{ tx: -1 }, { tx: 0 }, { tx: 1 }]);
const second = makeManifest(2, [
  { tx: -1, bytes: first.artifacts.get(first.manifest.chunks[0].artifacts[0].contentHash)!, slice: "slice:-1:0" },
  { tx: 0, topology: "topology:0:changed" },
]);
const liveHarness = createHarness(first);
liveHarness.artifactSets.push(first.artifacts, second.artifacts);
await liveHarness.manager.submit(first.manifest);
const firstResources = runtimeResources(liveHarness.manager.current);
assert(firstResources.has(terrainChunkId(grid.gridId, 0, -1, 0)), "negative chunk ID was not activated");
liveHarness.setAuthority(second);
const secondOutcome = await liveHarness.manager.submit(second.manifest);
const secondResources = runtimeResources(liveHarness.manager.current);
const negativeId = terrainChunkId(grid.gridId, 0, -1, 0);
const zeroId = terrainChunkId(grid.gridId, 0, 0, 0);
const positiveId = terrainChunkId(grid.gridId, 0, 1, 0);
assert(secondOutcome.changedChunks === 1 && secondOutcome.unchangedChunks === 1 && secondOutcome.removedChunks === 1, "changed/unchanged/removed diff counts are wrong");
assert(secondResources.get(negativeId) === firstResources.get(negativeId), "unchanged chunk runtime identity was replaced");
assert(secondResources.get(zeroId) !== firstResources.get(zeroId), "changed chunk runtime identity was reused");
assert(!secondResources.has(positiveId), "removed chunk remained live");
assert(liveHarness.disposed.some((entry) => entry.chunkId === zeroId && entry.reason === "replaced"), "replaced resource was not retired");
assert(liveHarness.disposed.some((entry) => entry.chunkId === positiveId && entry.reason === "removed"), "removed resource was not retired");

// Every identity-bearing field (topology, source slice, artifact descriptor) independently invalidates a chunk.
const identityBase = makeManifest(10, [{ tx: -2, bytes: new Uint8Array([1, 1, 1]) }]);
const identityTopology = makeManifest(11, [{ tx: -2, topology: "topology-mutated", bytes: new Uint8Array([1, 1, 1]) }]);
const identitySlice = makeManifest(12, [{ tx: -2, topology: "topology-mutated", slice: "slice-mutated", bytes: new Uint8Array([1, 1, 1]) }]);
const identityArtifact = makeManifest(13, [{ tx: -2, topology: "topology-mutated", slice: "slice-mutated", bytes: new Uint8Array([9, 9, 9]) }]);
const identityHarness = createHarness(identityBase);
identityHarness.artifactSets.push(identityBase.artifacts, identityTopology.artifacts, identitySlice.artifacts, identityArtifact.artifacts);
let priorResource: any = null;
for (const revision of [identityBase, identityTopology, identitySlice, identityArtifact]) {
  identityHarness.setAuthority(revision);
  await identityHarness.manager.submit(revision.manifest);
  const resource = identityHarness.manager.current.chunks[0].resource;
  if (priorResource !== null) assert(resource !== priorResource, "an identity-bearing chunk field changed without replacement");
  priorResource = resource;
}

// Corrupt/missing bytes fail before staging and leave the prior live revision byte-for-byte untouched.
const failureBase = makeManifest(20, [{ tx: 0 }]);
const failureNext = makeManifest(21, [{ tx: 0, bytes: new Uint8Array([7, 8, 9, 10]) }]);
const failureHarness = createHarness(failureBase);
failureHarness.artifactSets.push(failureBase.artifacts, failureNext.artifacts);
await failureHarness.manager.submit(failureBase.manifest);
const failureResource = failureHarness.manager.current.chunks[0].resource;
failureHarness.setAuthority(failureNext);
failureHarness.setArtifactOverride(() => new Uint8Array([7]));
await rejects(failureHarness.manager.submit(failureNext.manifest), /byteLength mismatch/, "corrupt byte length was accepted");
assert(failureHarness.manager.current.chunks[0].resource === failureResource, "length failure changed the live resource");
failureHarness.setArtifactOverride(() => new Uint8Array([7, 8, 9, 11]));
await rejects(failureHarness.manager.submit(failureNext.manifest), /content hash mismatch/, "corrupt artifact hash was accepted");
assert(failureHarness.manager.current.chunks[0].resource === failureResource, "hash failure changed the live resource");
failureHarness.setArtifactOverride(() => { throw new Error("artifact is missing"); });
await rejects(failureHarness.manager.submit(failureNext.manifest), /artifact is missing/, "missing artifact did not fail activation");
assert(failureHarness.manager.current.chunks[0].resource === failureResource, "missing artifact changed the live resource");

// A partial staging failure disposes every newly staged resource and does not retire prior resources.
const partialBase = makeManifest(30, [{ tx: -1 }]);
const partialNext = makeManifest(31, [{ tx: -2 }, { tx: -1, topology: "changed-later" }]);
const partialHarness = createHarness(partialBase);
partialHarness.artifactSets.push(partialBase.artifacts, partialNext.artifacts);
await partialHarness.manager.submit(partialBase.manifest);
const partialPrior = partialHarness.manager.current.chunks[0].resource;
partialHarness.setAuthority(partialNext);
partialHarness.setStageFailure(terrainChunkId(grid.gridId, 0, -2, 0));
await rejects(partialHarness.manager.submit(partialNext.manifest), /stage failed/, "partial staging failure was swallowed");
assert(partialHarness.manager.current.chunks[0].resource === partialPrior, "partial staging failure changed the live revision");
assert(partialHarness.disposed.some((entry) => entry.chunkId === terrainChunkId(grid.gridId, 0, -1, 0) && entry.reason === "staging-failed"), "successfully staged prefix was not cleaned up");
assert(!partialHarness.disposed.some((entry) => entry.resource === partialPrior), "partial failure retired a prior live resource");

// The staging callback owns allocations that it cannot return; the manager cannot dispose an unknown handle.
const ownedStage = makeManifest(35, [{ tx: 0 }]);
let stageOwnedAllocationCleaned = false;
let unknownStageDisposeCalls = 0;
const stageOwnershipManager = new DerivedRevisionManager({
  projectId: "grey-field",
  branchId: "main",
  getAuthoritativeSource: () => ({ projectId: "grey-field", branchId: "main", revision: 35, headHash: ownedStage.manifest.source.headHash }),
  loadArtifact: (input: any) => ownedStage.artifacts.get(input.artifact.contentHash)!,
  stageChunk: async () => {
    const callbackOwnedAllocation = { allocated: true };
    try {
      throw new Error("stage callback failed after internal allocation");
    } finally {
      callbackOwnedAllocation.allocated = false;
      stageOwnedAllocationCleaned = true;
    }
  },
  activateRevision: async () => { throw new Error("unreachable activation"); },
  disposeChunk: async () => { unknownStageDisposeCalls++; },
});
await rejects(stageOwnershipManager.submit(ownedStage.manifest), /failed after internal allocation/, "stage callback ownership failure was swallowed");
assert(stageOwnedAllocationCleaned && unknownStageDisposeCalls === 0, "stage callback allocation ownership contract was violated");

// Activation failure obeys the atomic callback contract, cleans staged resources, and preserves prior visibility.
const activationBase = makeManifest(40, [{ tx: 0 }]);
const activationNext = makeManifest(41, [{ tx: 0, topology: "activation-change" }]);
const activationHarness = createHarness(activationBase);
activationHarness.artifactSets.push(activationBase.artifacts, activationNext.artifacts);
await activationHarness.manager.submit(activationBase.manifest);
const activationPrior = activationHarness.manager.current.chunks[0].resource;
const visiblePrior = activationHarness.visible()[0].resource;
activationHarness.setAuthority(activationNext);
activationHarness.setActivationFailure(true);
await rejects(activationHarness.manager.submit(activationNext.manifest), /activation failed/, "activation callback failure was swallowed");
assert(activationHarness.manager.current.chunks[0].resource === activationPrior && activationHarness.visible()[0].resource === visiblePrior, "activation failure changed manager or renderer visibility");
assert(activationHarness.disposed.some((entry) => entry.reason === "activation-failed" && entry.resource !== activationPrior), "failed activation staged resource was not disposed");

// Cleanup continues through all resources but retains only a bounded number of failure objects/summaries.
const boundedFailureRevision = makeManifest(45, Array.from({ length: 40 }, (_unused, tx) => ({ tx, bytes: new Uint8Array([tx, 45]) })));
let boundedDisposeAttempts = 0;
const boundedFailureManager = new DerivedRevisionManager({
  projectId: "grey-field",
  branchId: "main",
  getAuthoritativeSource: () => ({ projectId: "grey-field", branchId: "main", revision: 45, headHash: boundedFailureRevision.manifest.source.headHash }),
  loadArtifact: (input: any) => boundedFailureRevision.artifacts.get(input.artifact.contentHash)!,
  stageChunk: async (input: any) => ({ chunkId: input.chunk.chunkId }),
  activateRevision: async () => { throw new Error("bounded activation failure"); },
  disposeChunk: async () => { boundedDisposeAttempts++; throw new Error(`cleanup failure ${boundedDisposeAttempts}`); },
});
const boundedFailure = await captureRejection(boundedFailureManager.submit(boundedFailureRevision.manifest), "bounded cleanup failure");
assert(boundedFailure instanceof AggregateError && boundedFailure.errors.length === 32, "AggregateError retained an unbounded cleanup error set");
assert(boundedDisposeAttempts === 40, "cleanup stopped before attempting every staged resource");
const boundedFailureDiagnostic = boundedFailureManager.getDiagnostics()[0];
assert(boundedFailureDiagnostic.errors.length === 32 && boundedFailureDiagnostic.errorCount === 41 && boundedFailureDiagnostic.errorsTruncated === true, "diagnostics did not summarize bounded cleanup failures accurately");
assert(boundedFailureManager.current === null, "failed first activation created a live revision");

// Cancellation after a staged prefix cleans that prefix and leaves the prior revision exactly live.
const cancelBase = makeManifest(50, [{ tx: -3 }]);
const cancelNext = makeManifest(51, [{ tx: -2 }, { tx: -1 }]);
const cancelHarness = createHarness(cancelBase);
cancelHarness.artifactSets.push(cancelBase.artifacts, cancelNext.artifacts);
await cancelHarness.manager.submit(cancelBase.manifest);
const cancelPrior = cancelHarness.manager.current.chunks[0].resource;
cancelHarness.setAuthority(cancelNext);
const secondLoadStarted = deferred();
const releaseSecondLoad = deferred();
let cancellationAbortEvents = 0;
cancelHarness.setArtifactOverride(async (input: any) => {
  if (input.chunk.tx === -2) {
    input.signal.addEventListener("abort", () => { cancellationAbortEvents++; }, { once: true });
    secondLoadStarted.resolve();
    await releaseSecondLoad.promise;
  }
  return cancelNext.artifacts.get(input.artifact.contentHash)!;
});
const signal = new TestAbortSignal();
const cancelled = cancelHarness.manager.submit(cancelNext.manifest, { signal });
await secondLoadStarted.promise;
signal.abort();
releaseSecondLoad.resolve();
await rejects(cancelled, /cancelled/, "cancelled update resolved successfully");
assert(cancelHarness.manager.current.chunks[0].resource === cancelPrior, "cancelled update changed the live revision");
assert(cancelHarness.disposed.some((entry) => entry.chunkId === terrainChunkId(grid.gridId, 0, -1, 0) && entry.reason === "cancelled"), "cancelled update leaked its staged prefix");
assert(cancellationAbortEvents === 1, "shared native cancellation signal did not notify the cooperative loader");

// Serialized requests retain the active build and coalesce queued work to the latest manifest.
const queuedTwo = makeManifest(60, [{ tx: 0 }]);
const queuedThree = makeManifest(61, [{ tx: 0, topology: "queued-three" }]);
const queuedFour = makeManifest(62, [{ tx: 0, topology: "queued-four" }]);
const firstLoadStarted = deferred();
const releaseFirstLoad = deferred();
let authorityCall = 0;
let queuedInternalSignal: AbortSignal | null = null;
const queuedArtifacts = new Map([...queuedTwo.artifacts, ...queuedThree.artifacts, ...queuedFour.artifacts]);
const queuedActivations: number[] = [];
let queuedStages = 0;
const queuedManager = new DerivedRevisionManager({
  projectId: "grey-field",
  branchId: "main",
  diagnosticsLimit: 2,
  getAuthoritativeSource: () => {
    const source = authorityCall++ < 2 ? queuedTwo.manifest : queuedFour.manifest;
    return { projectId: "grey-field", branchId: "main", revision: source.source.revision, headHash: source.source.headHash };
  },
  loadArtifact: async (input: any) => {
    queuedInternalSignal = input.signal;
    if (input.manifest.source.revision === 60) {
      firstLoadStarted.resolve();
      await releaseFirstLoad.promise;
    }
    return queuedArtifacts.get(input.artifact.contentHash)!;
  },
  stageChunk: async (input: any) => { queuedStages++; return { chunkId: input.chunk.chunkId, revision: input.manifest.source.revision }; },
  activateRevision: async (input: any) => { queuedActivations.push(input.manifest.source.revision); },
  disposeChunk: async () => {},
});
const queuedTwoPromise = queuedManager.submit(queuedTwo.manifest);
await firstLoadStarted.promise;
const duplicateActiveSignal = new TestAbortSignal();
const duplicateActivePromise = queuedManager.submit(queuedTwo.manifest, { signal: duplicateActiveSignal });
const duplicateActiveSharedPromise = queuedManager.submit(queuedTwo.manifest);
duplicateActiveSignal.abort();
await rejects(duplicateActivePromise, /cancelled/, "one duplicate caller cancelled the shared active job");
assert(queuedInternalSignal instanceof AbortSignal && Object.getPrototypeOf(queuedInternalSignal) === AbortSignal.prototype, "loader did not receive a native branded AbortSignal");
const nativeAbortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
assert(nativeAbortedGetter?.call(queuedInternalSignal) === false, "platform AbortSignal brand check failed or one duplicate caller aborted shared work");
const queuedThreePromise = queuedManager.submit(queuedThree.manifest);
const queuedFourPromise = queuedManager.submit(queuedFour.manifest);
const duplicateQueuedFourPromise = queuedManager.submit(queuedFour.manifest);
const lateOlderPromise = queuedManager.submit(queuedThree.manifest);
const queuedThreeOutcome = await queuedThreePromise;
assert(queuedThreeOutcome.status === "superseded", "superseded queued revision did not resolve explicitly");
const lateOlderOutcome = await lateOlderPromise;
assert(lateOlderOutcome.status === "superseded" && lateOlderOutcome.supersededByManifestHash === queuedFour.manifest.manifestHash, "late older revision displaced the newer pending build");
releaseFirstLoad.resolve();
const [queuedTwoOutcome, duplicateActiveSharedOutcome] = await Promise.all([queuedTwoPromise, duplicateActiveSharedPromise]);
assert(queuedTwoOutcome.status === "activated" && duplicateActiveSharedOutcome.manifestHash === queuedTwoOutcome.manifestHash, "identical active callers did not share the activation outcome");
const [queuedFourOutcome, duplicateQueuedFourOutcome] = await Promise.all([queuedFourPromise, duplicateQueuedFourPromise]);
assert(queuedFourOutcome.status === "activated" && duplicateQueuedFourOutcome.manifestHash === queuedFourOutcome.manifestHash, "identical pending callers did not share the activation outcome");
assert(queuedActivations.join(",") === "60,62", `queued revisions were not serialized/coalesced (${queuedActivations.join(",")})`);
assert(queuedStages === 2, `identical callers duplicated staging work (${queuedStages} stages)`);
assert(queuedManager.current.manifest.source.revision === 62, "latest queued revision is not live");
const boundedDiagnostics = queuedManager.getDiagnostics();
assert(boundedDiagnostics.length === 2, "diagnostic history did not enforce its configured bound");
assert(!JSON.stringify(boundedDiagnostics).includes("fixtureBytes") && !JSON.stringify(boundedDiagnostics).includes("Uint8Array"), "diagnostics retained raw artifact bytes");

// Scope mismatches fail before I/O, and an authority change during staging is caught before activation.
const wrongScopeInput: any = JSON.parse(JSON.stringify(queuedFour.manifest));
delete wrongScopeInput.manifestHash;
wrongScopeInput.projectId = "another-project";
const wrongScopeManifest = createDerivedRevisionManifest(wrongScopeInput);
await rejects(queuedManager.submit(wrongScopeManifest), /another project or branch/, "manifest project mismatch reached the runtime");
const authorityRace = makeManifest(70, [{ tx: 0 }]);
let authorityRaceChecks = 0;
let authorityRaceActivations = 0;
const authorityRaceDisposals: any[] = [];
const authorityRaceManager = new DerivedRevisionManager({
  projectId: "grey-field",
  branchId: "main",
  getAuthoritativeSource: () => ({
    projectId: "grey-field",
    branchId: "main",
    revision: 70,
    headHash: authorityRaceChecks++ === 0 ? authorityRace.manifest.source.headHash : hash("head-changed-during-stage"),
  }),
  loadArtifact: (input: any) => authorityRace.artifacts.get(input.artifact.contentHash)!,
  stageChunk: async (input: any) => ({ chunkId: input.chunk.chunkId }),
  activateRevision: async () => { authorityRaceActivations++; },
  disposeChunk: async (input: any) => { authorityRaceDisposals.push(input); },
});
await rejects(authorityRaceManager.submit(authorityRace.manifest), /not the authoritative head/, "authority TOCTOU change reached activation");
assert(authorityRaceActivations === 0 && authorityRaceManager.current === null, "authority race made a revision visible");
assert(authorityRaceDisposals.length === 1, "authority race leaked its staged resource");

// Rollback is rejected by default; force permits it only when the old source is authoritative again.
liveHarness.setAuthority(first);
await rejects(liveHarness.manager.submit(first.manifest), /rollback requires force/, "out-of-order revision activated without force");
const rollbackOutcome = await liveHarness.manager.submit(first.manifest, { force: true });
assert(rollbackOutcome.status === "activated" && liveHarness.manager.current.manifest.source.revision === 1, "forced authoritative rollback did not activate");

ops.op_log(
  "p_derived_runtime OK: exact-head validated revisions activate atomically; stable chunk identity preserves unchanged resources; changed topology/slices/artifacts replace only affected chunks; corrupt/missing bytes, staging/activation failure and cancellation preserve the prior live set with cleanup; queued work coalesces and rollback is explicit.",
);
