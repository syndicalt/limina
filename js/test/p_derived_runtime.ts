import { ops } from "../src/engine.ts";
import { terrainChunkId, createTerrainGridSpec } from "../src/terrain/grid.mjs";
import {
  DERIVED_REVISION_MANIFEST_SCHEMA_V1,
  DERIVED_REVISION_MANIFEST_SCHEMA_V2,
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

type GlobalSpec = {
  artifactType: string;
  bytes: Uint8Array;
  mediaType?: string;
};

function makeManifest(
  revision: number,
  specs: ChunkSpec[],
  globalSpecs: GlobalSpec[] = [],
  schema: typeof DERIVED_REVISION_MANIFEST_SCHEMA_V1 | typeof DERIVED_REVISION_MANIFEST_SCHEMA_V2 = DERIVED_REVISION_MANIFEST_SCHEMA_V2,
) {
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
  const globalArtifacts = globalSpecs.map((spec) => ({
    artifactType: spec.artifactType,
    contentHash: derivedArtifactContentHash(spec.bytes),
    byteLength: spec.bytes.byteLength,
    mediaType: spec.mediaType ?? "application/octet-stream",
  })).sort((a, b) => codeUnitCompare(a.artifactType, b.artifactType));
  const manifest = createDerivedRevisionManifest({
    schema,
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
    ...(schema === DERIVED_REVISION_MANIFEST_SCHEMA_V2 ? { globalArtifacts } : {}),
    chunks: chunks.map(({ fixtureBytes: _fixtureBytes, ...chunk }) => chunk),
  });
  const artifacts = new Map([
    ...chunks.map((chunk) => [chunk.artifacts[0].contentHash, chunk.fixtureBytes] as const),
    ...globalSpecs.map((spec) => [derivedArtifactContentHash(spec.bytes), spec.bytes] as const),
  ]);
  return { manifest, artifacts };
}

function runtimeResources(current: any): Map<string, any> {
  return new Map(current.chunks.map((entry: any) => [entry.chunkId, entry.resource]));
}

function createHarness(initialAuthority: any, diagnosticsLimit = 64, selectChunks?: (manifest: any) => readonly any[]) {
  let authorityManifest = initialAuthority;
  let resourceSequence = 0;
  let failStageChunkId: string | null = null;
  let failStageGlobalType: string | null = null;
  let failActivation = false;
  let artifactOverride: ((input: any) => Promise<Uint8Array> | Uint8Array) | null = null;
  const artifactSets: Map<string, Uint8Array>[] = [];
  const staged: any[] = [];
  const disposed: any[] = [];
  const stagedGlobals: any[] = [];
  const globalStageInputs: any[] = [];
  const disposedGlobals: any[] = [];
  const retirementOrder: string[] = [];
  const activations: any[] = [];
  let visible: readonly any[] = [];
  let visibleGlobals = new Map<string, any>();
  const manager = new DerivedRevisionManager({
    projectId: "grey-field",
    branchId: "main",
    diagnosticsLimit,
    ...(selectChunks === undefined ? {} : { selectChunks }),
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
    stageGlobal: async (input: any) => {
      if (input.artifact.artifactType === failStageGlobalType) throw new Error(`global stage failed for ${input.artifact.artifactType}`);
      const resource = Object.freeze({ id: ++resourceSequence, artifactType: input.artifact.artifactType });
      globalStageInputs.push(input);
      stagedGlobals.push(resource);
      return resource;
    },
    activateRevision: async (input: any) => {
      if (failActivation) throw new Error("activation failed before atomic swap");
      visible = input.chunks;
      visibleGlobals = input.globals;
      activations.push(input);
    },
    disposeChunk: async (input: any) => { disposed.push(input); retirementOrder.push(`chunk:${input.chunkId}:${input.reason}`); },
    disposeGlobal: async (input: any) => { disposedGlobals.push(input); retirementOrder.push(`global:${input.artifactType}:${input.reason}`); },
  });
  return {
    manager,
    artifactSets,
    staged,
    stagedGlobals,
    globalStageInputs,
    disposed,
    disposedGlobals,
    retirementOrder,
    activations,
    visible: () => visible,
    visibleGlobals: () => visibleGlobals,
    setAuthority: (value: any) => { authorityManifest = value; },
    setStageFailure: (chunkId: string | null) => { failStageChunkId = chunkId; },
    setGlobalStageFailure: (artifactType: string | null) => { failStageGlobalType = artifactType; },
    setActivationFailure: (value: boolean) => { failActivation = value; },
    setArtifactOverride: (value: typeof artifactOverride) => { artifactOverride = value; },
  };
}

// A browser residency selector keeps full-manifest identity while lifecycle-loading only its
// exact canonical window. Malformed selectors fail before artifact I/O.
{
  const specs = [];
  for (let tz = -10; tz < 10; tz++) for (let tx = -10; tx < 10; tx++) specs.push({ tx, tz });
  const large = makeManifest(90, specs);
  const selector = (manifest: any) => Object.freeze(manifest.chunks.filter((chunk: any) => Math.abs(chunk.tx) <= 7 && Math.abs(chunk.tz) <= 7));
  const bounded = createHarness(large, 64, selector);
  bounded.artifactSets.push(large.artifacts);
  await bounded.manager.submit(large.manifest, Object.freeze({}));
  assert(bounded.staged.length === 225 && bounded.manager.current.chunks.length === 225,
    "resident manager did not cap chunk staging at 225");
  assert(bounded.activations[0].manifest.chunks.length === 400
      && bounded.activations[0].manifest.manifestHash === large.manifest.manifestHash,
  "resident manager weakened full-manifest identity");

  let selectedTx = -10;
  const driftingSelector = (manifest: any) => Object.freeze(manifest.chunks.filter((chunk: any) => (
    chunk.tx === selectedTx && chunk.tz === -10
  )));
  const drifting = createHarness(large, 64, driftingSelector);
  drifting.artifactSets.push(large.artifacts);
  await drifting.manager.submit(large.manifest);
  const firstResident = drifting.manager.current.chunks[0].resource;
  selectedTx = -9;
  const driftOutcome = await drifting.manager.submit(large.manifest);
  assert(driftOutcome.status === "activated" && drifting.activations.length === 2,
    "same-manifest selector drift was returned as unchanged");
  assert(drifting.manager.current.chunks[0].chunk.tx === -9
      && drifting.manager.current.chunks[0].resource !== firstResident,
  "same-manifest selector drift did not replace the resident set");

  selectedTx = -8;
  const overlapping = createHarness(large, 64, driftingSelector);
  overlapping.artifactSets.push(large.artifacts);
  const firstLoadStarted = deferred();
  const releaseFirstLoad = deferred();
  let blockFirstLoad = true;
  overlapping.setArtifactOverride(async (input: any) => {
    if (blockFirstLoad) {
      blockFirstLoad = false;
      firstLoadStarted.resolve();
      await releaseFirstLoad.promise;
    }
    return large.artifacts.get(input.artifact.contentHash)!;
  });
  const firstWindow = overlapping.manager.submit(large.manifest);
  await firstLoadStarted.promise;
  selectedTx = -7;
  const secondWindow = overlapping.manager.submit(large.manifest);
  releaseFirstLoad.resolve();
  const [firstWindowOutcome, secondWindowOutcome] = await Promise.all([firstWindow, secondWindow]);
  assert(firstWindowOutcome.status === "activated" && secondWindowOutcome.status === "activated"
      && overlapping.activations.length === 2 && overlapping.manager.current.chunks[0].chunk.tx === -7,
  "overlapping same-manifest residency windows were incorrectly coalesced");

  const stableResidentBytes = new Uint8Array([9, 0, 1]);
  const outsideBase = makeManifest(91, [
    { tx: 0, bytes: stableResidentBytes },
    { tx: 1, bytes: new Uint8Array([9, 1, 1]) },
  ]);
  const outsideNext = makeManifest(92, [
    { tx: 0, bytes: stableResidentBytes },
    { tx: 1, bytes: new Uint8Array([9, 1, 2]) },
  ]);
  const residentOnly = createHarness(outsideBase, 64, (manifest: any) => Object.freeze(
    manifest.chunks.filter((chunk: any) => chunk.tx === 0),
  ));
  residentOnly.artifactSets.push(outsideBase.artifacts, outsideNext.artifacts);
  await residentOnly.manager.submit(outsideBase.manifest);
  const stableResidentResource = residentOnly.manager.current.chunks[0].resource;
  const residentStageCount = residentOnly.staged.length;
  residentOnly.setAuthority(outsideNext);
  const outsideOutcome = await residentOnly.manager.submit(outsideNext.manifest);
  assert(outsideOutcome.status === "activated" && outsideOutcome.changedChunks === 0
      && outsideOutcome.unchangedChunks === 1 && residentOnly.activations.length === 2,
  "nonresident-only revision change did not advance full-manifest activation");
  assert(residentOnly.manager.current.manifest.manifestHash === outsideNext.manifest.manifestHash
      && residentOnly.manager.current.manifest.source.revision === 92,
  "nonresident-only revision change did not advance manifest/source identity");
  assert(residentOnly.staged.length === residentStageCount
      && residentOnly.manager.current.chunks[0].resource === stableResidentResource,
  "nonresident-only revision change reloaded or replaced the stable resident resource");

  let loads = 0;
  const malformed = createHarness(large, 64, (manifest: any) => Object.freeze([{ ...manifest.chunks[0] }]));
  malformed.setArtifactOverride(() => { loads++; return new Uint8Array(); });
  await rejects(malformed.manager.submit(large.manifest), /canonical manifest chunk references/, "cloned selector output was accepted");
  assert(loads === 0, "malformed residency selector performed artifact I/O");
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

// V1 and v2-empty manifests remain compatible when no global lifecycle callbacks are installed.
for (const [revision, schema] of [[80, DERIVED_REVISION_MANIFEST_SCHEMA_V1], [81, DERIVED_REVISION_MANIFEST_SCHEMA_V2]] as const) {
  const fixture = makeManifest(revision, [{ tx: revision - 80 }], [], schema);
  let activationGlobals: Map<string, unknown> | null = null;
  const manager = new DerivedRevisionManager({
    projectId: "grey-field",
    branchId: "main",
    getAuthoritativeSource: () => ({ projectId: "grey-field", branchId: "main", revision, headHash: fixture.manifest.source.headHash }),
    loadArtifact: (input: any) => fixture.artifacts.get(input.artifact.contentHash)!,
    stageChunk: async (input: any) => ({ chunkId: input.chunk.chunkId }),
    activateRevision: async (input: any) => { activationGlobals = input.globals; },
    disposeChunk: async () => {},
  });
  const outcome = await manager.submit(fixture.manifest);
  assert(outcome.changedGlobals === 0 && outcome.unchangedGlobals === 0 && outcome.removedGlobals === 0, `${schema} changed additive global counts`);
  assert(manager.current.globals instanceof Map && manager.current.globals.size === 0, `${schema} did not expose an empty globals Map`);
  assert(activationGlobals instanceof Map && activationGlobals.size === 0, `${schema} activation did not receive an empty globals Map`);
}

// A non-empty v2 manifest fails closed before artifact I/O when global lifecycle ownership is absent.
{
  const fixture = makeManifest(82, [{ tx: 0 }], [{ artifactType: "hydrology-field/v1", bytes: new Uint8Array([8, 2]) }]);
  let loads = 0, stages = 0, activations = 0;
  const manager = new DerivedRevisionManager({
    projectId: "grey-field",
    branchId: "main",
    getAuthoritativeSource: () => ({ projectId: "grey-field", branchId: "main", revision: 82, headHash: fixture.manifest.source.headHash }),
    loadArtifact: () => { loads++; throw new Error("must not load"); },
    stageChunk: async () => { stages++; return {}; },
    activateRevision: async () => { activations++; },
    disposeChunk: async () => {},
  });
  await rejects(manager.submit(fixture.manifest), /stageGlobal\/disposeGlobal are unavailable/, "non-empty globals ran without lifecycle callbacks");
  assert(loads === 0 && stages === 0 && activations === 0 && manager.current === null, "missing global callbacks caused side effects");
}

// Exact global descriptor identity drives changed-only staging independently from chunk identity.
const stableChunkBytes = new Uint8Array([9, 0, 9]);
const globalBase = makeManifest(90, [{ tx: 0, bytes: stableChunkBytes }], [
  { artifactType: "hydrology-field/v1", bytes: new Uint8Array([1, 2, 3]) },
]);
const globalOnly = makeManifest(91, [{ tx: 0, bytes: stableChunkBytes }], [
  { artifactType: "hydrology-field/v1", bytes: new Uint8Array([4, 5, 6]) },
]);
const globalDescriptorOnly = makeManifest(92, [{ tx: 0, bytes: stableChunkBytes }], [
  { artifactType: "hydrology-field/v1", bytes: new Uint8Array([4, 5, 6]), mediaType: "application/json" },
]);
const chunkOnly = makeManifest(93, [{ tx: 0, bytes: stableChunkBytes, topology: "chunk-only-change" }], [
  { artifactType: "hydrology-field/v1", bytes: new Uint8Array([4, 5, 6]), mediaType: "application/json" },
]);
const globalHarness = createHarness(globalBase);
globalHarness.artifactSets.push(globalBase.artifacts, globalOnly.artifacts, globalDescriptorOnly.artifacts, chunkOnly.artifacts);
await globalHarness.manager.submit(globalBase.manifest);
const baseChunkResource = globalHarness.manager.current.chunks[0].resource;
const baseGlobalResource = globalHarness.manager.current.globals.get("hydrology-field/v1").resource;
globalHarness.setAuthority(globalOnly);
const globalOnlyOutcome = await globalHarness.manager.submit(globalOnly.manifest);
const changedGlobalResource = globalHarness.manager.current.globals.get("hydrology-field/v1").resource;
assert(globalOnlyOutcome.changedGlobals === 1 && globalOnlyOutcome.unchangedGlobals === 0 && globalOnlyOutcome.changedChunks === 0 && globalOnlyOutcome.unchangedChunks === 1,
  "global-only diff counts are wrong");
assert(globalHarness.manager.current.chunks[0].resource === baseChunkResource, "global-only update replaced an unchanged chunk");
assert(changedGlobalResource !== baseGlobalResource, "changed global descriptor reused its resource");
const globalActivation = globalHarness.activations.at(-1);
assert(globalActivation.globals instanceof Map && globalActivation.previousGlobals instanceof Map
  && globalActivation.changedGlobalArtifactTypes.join(",") === "hydrology-field/v1"
  && globalActivation.removedGlobalArtifactTypes.length === 0,
"activation did not receive complete current/previous global sets and changed types");

globalHarness.setAuthority(globalDescriptorOnly);
await globalHarness.manager.submit(globalDescriptorOnly.manifest);
const descriptorGlobalResource = globalHarness.manager.current.globals.get("hydrology-field/v1").resource;
assert(descriptorGlobalResource !== changedGlobalResource, "mediaType-only descriptor change did not replace the global resource");
globalHarness.setAuthority(chunkOnly);
const chunkOnlyOutcome = await globalHarness.manager.submit(chunkOnly.manifest);
assert(chunkOnlyOutcome.changedChunks === 1 && chunkOnlyOutcome.unchangedGlobals === 1 && chunkOnlyOutcome.changedGlobals === 0,
  "chunk-only diff counts are wrong");
assert(globalHarness.manager.current.globals.get("hydrology-field/v1").resource === descriptorGlobalResource,
  "chunk-only update replaced an unchanged global");

// `current.globals` is a defensive Map: caller mutation cannot corrupt the live set.
const publicGlobals = globalHarness.manager.current.globals;
publicGlobals.clear();
assert(globalHarness.manager.current.globals.size === 1, "caller mutated the manager's internal global Map");

const withoutGlobal = makeManifest(94, [{ tx: 0, bytes: stableChunkBytes, topology: "chunk-only-change" }]);
globalHarness.artifactSets.push(withoutGlobal.artifacts);
globalHarness.setAuthority(withoutGlobal);
const removeGlobalOutcome = await globalHarness.manager.submit(withoutGlobal.manifest);
assert(removeGlobalOutcome.removedGlobals === 1 && globalHarness.manager.current.globals.size === 0, "removed global remained live");
assert(globalHarness.disposedGlobals.some((entry) => entry.artifactType === "hydrology-field/v1" && entry.reason === "removed"),
  "removed global resource was not retired");

// Content-addressed load I/O is shared across global/chunk descriptors, but each descriptor is verified and counted.
{
  const sharedBytes = new Uint8Array([7, 7, 7, 7]);
  const fixture = makeManifest(95, [{ tx: 0, bytes: sharedBytes }], [{ artifactType: "hydrology-field/v1", bytes: sharedBytes }]);
  let loaderCalls = 0;
  const manager = new DerivedRevisionManager({
    projectId: "grey-field", branchId: "main",
    getAuthoritativeSource: () => ({ projectId: "grey-field", branchId: "main", revision: 95, headHash: fixture.manifest.source.headHash }),
    loadArtifact: (input: any) => { loaderCalls++; return fixture.artifacts.get(input.artifact.contentHash)!; },
    stageGlobal: async (input: any) => ({ bytes: input.bytes, type: input.artifact.artifactType }),
    stageChunk: async (input: any) => ({ bytes: input.artifacts[0].bytes, id: input.chunk.chunkId }),
    activateRevision: async () => {},
    disposeGlobal: async () => {}, disposeChunk: async () => {},
  });
  await manager.submit(fixture.manifest);
  assert(loaderCalls === 1, `shared global/chunk content performed ${loaderCalls} loader calls`);
  const diagnostic = manager.getDiagnostics().at(-1);
  assert(diagnostic.artifactsLoaded === 2 && diagnostic.artifactBytesLoaded === sharedBytes.byteLength * 2,
    "deduplicated I/O weakened per-descriptor verification accounting");
}

// Global length/hash failures occur before staging and preserve the prior complete live set.
{
  const base = makeManifest(96, [{ tx: 0 }], [{ artifactType: "hydrology-field/v1", bytes: new Uint8Array([1, 1, 1]) }]);
  const next = makeManifest(97, [{ tx: 0, bytes: base.artifacts.get(base.manifest.chunks[0].artifacts[0].contentHash)! }], [
    { artifactType: "hydrology-field/v1", bytes: new Uint8Array([2, 2, 2, 2]) },
  ]);
  const harness = createHarness(base);
  harness.artifactSets.push(base.artifacts, next.artifacts);
  await harness.manager.submit(base.manifest);
  const priorChunk = harness.manager.current.chunks[0].resource;
  const priorGlobal = harness.manager.current.globals.get("hydrology-field/v1").resource;
  harness.setAuthority(next);
  harness.setArtifactOverride((input: any) => input.globalArtifact ? new Uint8Array([2]) : next.artifacts.get(input.artifact.contentHash)!);
  await rejects(harness.manager.submit(next.manifest), /byteLength mismatch/, "global length mismatch was accepted");
  harness.setArtifactOverride((input: any) => input.globalArtifact ? new Uint8Array([2, 2, 2, 3]) : next.artifacts.get(input.artifact.contentHash)!);
  await rejects(harness.manager.submit(next.manifest), /content hash mismatch/, "global hash mismatch was accepted");
  assert(harness.manager.current.chunks[0].resource === priorChunk
    && harness.manager.current.globals.get("hydrology-field/v1").resource === priorGlobal,
  "global byte failure changed the live chunk/global set");
}

// Partial global staging and mixed cancellation reverse-dispose every resource staged so far.
{
  const fixture = makeManifest(98, [{ tx: 0 }], [
    { artifactType: "climate-field/v1", bytes: new Uint8Array([1]) },
    { artifactType: "hydrology-field/v1", bytes: new Uint8Array([2]) },
  ]);
  const harness = createHarness(fixture);
  harness.artifactSets.push(fixture.artifacts);
  harness.setGlobalStageFailure("hydrology-field/v1");
  await rejects(harness.manager.submit(fixture.manifest), /global stage failed/, "partial global stage failure was swallowed");
  assert(harness.disposedGlobals.length === 1 && harness.disposedGlobals[0].artifactType === "climate-field/v1"
    && harness.disposedGlobals[0].reason === "staging-failed", "staged global prefix was not reverse-cleaned");
  assert(harness.manager.current === null, "partial global stage failure created a live revision");
}
{
  const base = makeManifest(99, [{ tx: 0 }]);
  const next = makeManifest(100, [{ tx: 0, topology: "cancel-after-global" }], [
    { artifactType: "hydrology-field/v1", bytes: new Uint8Array([1, 0, 0]) },
  ]);
  const harness = createHarness(base);
  harness.artifactSets.push(base.artifacts, next.artifacts);
  await harness.manager.submit(base.manifest);
  const priorChunk = harness.manager.current.chunks[0].resource;
  harness.setAuthority(next);
  const chunkLoadStarted = deferred();
  const releaseChunkLoad = deferred();
  harness.setArtifactOverride(async (input: any) => {
    if (input.chunk) { chunkLoadStarted.resolve(); await releaseChunkLoad.promise; }
    return next.artifacts.get(input.artifact.contentHash)!;
  });
  const signal = new TestAbortSignal();
  const pending = harness.manager.submit(next.manifest, { signal });
  await chunkLoadStarted.promise;
  signal.abort();
  releaseChunkLoad.resolve();
  await rejects(pending, /cancelled/, "mixed global/chunk update ignored cancellation");
  assert(harness.manager.current.chunks[0].resource === priorChunk && harness.manager.current.globals.size === 0,
    "cancelled mixed update changed the live set");
  assert(harness.disposedGlobals.some((entry) => entry.reason === "cancelled"), "cancelled mixed update leaked its staged global");
}

const HYDROLOGY_FIELD = "hydrology-field/v1";
const HYDROLOGY_WATER = "hydrology-water-topology/v1";

// A dependent global without its prerequisite is rejected before artifact or staging callbacks run.
{
  const fixture = makeManifest(103, [{ tx: 0 }], [
    { artifactType: HYDROLOGY_WATER, bytes: new Uint8Array([1, 0, 3]) },
  ]);
  const harness = createHarness(fixture);
  let loads = 0;
  harness.setArtifactOverride(() => { loads++; throw new Error("unreachable artifact load"); });
  await rejects(harness.manager.submit(fixture.manifest), /requires 'hydrology-field\/v1'/, "water artifact without its field was accepted");
  assert(loads === 0 && harness.staged.length === 0 && harness.stagedGlobals.length === 0 && harness.manager.current === null,
    "missing global prerequisite caused load, stage, or live-set side effects");
}

// Global staging is topological, and each callback receives an exact frozen dependency view.
{
  const fixture = makeManifest(104, [{ tx: 0 }], [
    { artifactType: HYDROLOGY_FIELD, bytes: new Uint8Array([1, 0, 4]) },
    { artifactType: HYDROLOGY_WATER, bytes: new Uint8Array([2, 0, 4]) },
  ]);
  const harness = createHarness(fixture);
  harness.artifactSets.push(fixture.artifacts);
  await harness.manager.submit(fixture.manifest);
  assert(harness.globalStageInputs.map((input) => input.artifact.artifactType).join(",") === `${HYDROLOGY_FIELD},${HYDROLOGY_WATER}`,
    "dependent global staged before its prerequisite");
  const fieldDependencies = harness.globalStageInputs[0].dependencies;
  const waterDependencies = harness.globalStageInputs[1].dependencies;
  assert(fieldDependencies instanceof Map && fieldDependencies.size === 0 && Object.isFrozen(fieldDependencies),
    "prerequisite did not receive an exact frozen empty dependency Map");
  assert(waterDependencies instanceof Map && waterDependencies.size === 1 && Object.isFrozen(waterDependencies),
    "dependent did not receive an exact frozen dependency Map");
  const fieldDependency = waterDependencies.get(HYDROLOGY_FIELD);
  assert(Object.isFrozen(fieldDependency) && fieldDependency.artifactType === HYDROLOGY_FIELD
    && fieldDependency.artifact === harness.globalStageInputs[0].artifact && fieldDependency.resource === harness.stagedGlobals[0],
  "dependency view did not expose the exact staged prerequisite descriptor/resource");
  for (const mutate of [
    () => waterDependencies.set("climate-field/v1", {}),
    () => waterDependencies.delete(HYDROLOGY_FIELD),
    () => waterDependencies.clear(),
    () => Map.prototype.set.call(waterDependencies, "climate-field/v1", {}),
    () => waterDependencies.valueOf().set("climate-field/v1", {}),
  ]) {
    let rejected = false;
    try { mutate(); } catch (error) { rejected = error instanceof TypeError; }
    assert(rejected, "dependency Map admitted caller mutation");
  }
  let forEachMap: any = null;
  waterDependencies.forEach((_value: any, _key: string, map: any) => { forEachMap = map; });
  assert(forEachMap === waterDependencies && waterDependencies.size === 1, "dependency Map forEach leaked a mutable backing Map");
}

// A prerequisite descriptor change forces dependent restaging; failures preserve the complete prior live set.
{
  const stableChunk = new Uint8Array([1, 1, 0]);
  const stableWater = new Uint8Array([9, 9, 9]);
  const base = makeManifest(105, [{ tx: 0, bytes: stableChunk }], [
    { artifactType: HYDROLOGY_FIELD, bytes: new Uint8Array([1, 0, 5]) },
    { artifactType: HYDROLOGY_WATER, bytes: stableWater },
  ]);
  const next = makeManifest(106, [{ tx: 0, bytes: stableChunk }], [
    { artifactType: HYDROLOGY_FIELD, bytes: new Uint8Array([1, 0, 6]) },
    { artifactType: HYDROLOGY_WATER, bytes: stableWater },
  ]);
  const harness = createHarness(base);
  harness.artifactSets.push(base.artifacts, next.artifacts);
  await harness.manager.submit(base.manifest);
  const priorField = harness.manager.current.globals.get(HYDROLOGY_FIELD).resource;
  const priorWater = harness.manager.current.globals.get(HYDROLOGY_WATER).resource;
  harness.setAuthority(next);
  harness.setGlobalStageFailure(HYDROLOGY_WATER);
  await rejects(harness.manager.submit(next.manifest), /global stage failed/, "dependent binding/stage failure was swallowed");
  assert(harness.manager.current.globals.get(HYDROLOGY_FIELD).resource === priorField
    && harness.manager.current.globals.get(HYDROLOGY_WATER).resource === priorWater,
  "dependent binding/stage failure changed the prior live set");
  assert(harness.disposedGlobals.at(-1)?.artifactType === HYDROLOGY_FIELD
    && harness.disposedGlobals.at(-1)?.reason === "staging-failed", "dependent stage failure leaked its newly staged prerequisite");

  harness.setGlobalStageFailure(null);
  harness.setActivationFailure(true);
  await rejects(harness.manager.submit(next.manifest), /activation failed/, "dependency activation failure was swallowed");
  assert(harness.manager.current.globals.get(HYDROLOGY_FIELD).resource === priorField
    && harness.manager.current.globals.get(HYDROLOGY_WATER).resource === priorWater,
  "dependency activation failure changed the prior live set");
  const activationCleanup = harness.retirementOrder.filter((entry) => entry.endsWith(":activation-failed")).slice(-2);
  assert(activationCleanup[0] === `global:${HYDROLOGY_WATER}:activation-failed`
    && activationCleanup[1] === `global:${HYDROLOGY_FIELD}:activation-failed`,
  `staged dependency cleanup was not strict reverse order (${activationCleanup.join(",")})`);

  harness.setActivationFailure(false);
  const outcome = await harness.manager.submit(next.manifest);
  const currentField = harness.manager.current.globals.get(HYDROLOGY_FIELD).resource;
  const currentWater = harness.manager.current.globals.get(HYDROLOGY_WATER).resource;
  assert(outcome.changedGlobals === 2 && outcome.unchangedGlobals === 0 && outcome.unchangedChunks === 1,
    "dependency-forced restage counts are wrong");
  assert(currentField !== priorField && currentWater !== priorWater, "prerequisite change reused a stale dependent resource");
  const successfulStages = harness.globalStageInputs.slice(-2);
  assert(successfulStages[1].dependencies.get(HYDROLOGY_FIELD).resource === currentField,
    "restaged dependent received the retired prerequisite resource");
  const replacedOrder = harness.retirementOrder.filter((entry) => entry.endsWith(":replaced")).slice(-2);
  assert(replacedOrder.join(",") === `global:${HYDROLOGY_WATER}:replaced,global:${HYDROLOGY_FIELD}:replaced`,
    `replacement retired prerequisite before dependent (${replacedOrder.join(",")})`);

  const withoutGlobals = makeManifest(107, [{ tx: 0, bytes: stableChunk }]);
  harness.artifactSets.push(withoutGlobals.artifacts);
  harness.setAuthority(withoutGlobals);
  const removal = await harness.manager.submit(withoutGlobals.manifest);
  const removedOrder = harness.retirementOrder.filter((entry) => entry.endsWith(":removed")).slice(-2);
  assert(removal.removedGlobals === 2 && removedOrder.join(",") === `global:${HYDROLOGY_WATER}:removed,global:${HYDROLOGY_FIELD}:removed`,
    `removal retired prerequisite before dependent (${removedOrder.join(",")})`);
}

// Unchanged prerequisite/dependent descriptors reuse both resources without staging.
{
  const chunkBytes = new Uint8Array([1, 0, 8]);
  const fieldBytes = new Uint8Array([2, 0, 8]);
  const waterBytes = new Uint8Array([3, 0, 8]);
  const base = makeManifest(108, [{ tx: 0, bytes: chunkBytes }], [
    { artifactType: HYDROLOGY_FIELD, bytes: fieldBytes }, { artifactType: HYDROLOGY_WATER, bytes: waterBytes },
  ]);
  const next = makeManifest(109, [{ tx: 0, bytes: chunkBytes }], [
    { artifactType: HYDROLOGY_FIELD, bytes: fieldBytes }, { artifactType: HYDROLOGY_WATER, bytes: waterBytes },
  ]);
  const harness = createHarness(base);
  harness.artifactSets.push(base.artifacts, next.artifacts);
  await harness.manager.submit(base.manifest);
  const priorField = harness.manager.current.globals.get(HYDROLOGY_FIELD).resource;
  const priorWater = harness.manager.current.globals.get(HYDROLOGY_WATER).resource;
  const priorStageCount = harness.stagedGlobals.length;
  harness.setAuthority(next);
  const outcome = await harness.manager.submit(next.manifest);
  assert(outcome.unchangedGlobals === 2 && outcome.changedGlobals === 0 && harness.stagedGlobals.length === priorStageCount,
    "unchanged dependency identities caused staging");
  assert(harness.manager.current.globals.get(HYDROLOGY_FIELD).resource === priorField
    && harness.manager.current.globals.get(HYDROLOGY_WATER).resource === priorWater,
  "unchanged dependency identities replaced resources");
}

// Closing is idempotent and tears down chunks before globals, with dependents before prerequisites.
{
  const fixture = makeManifest(110, [{ tx: 0 }], [
    { artifactType: HYDROLOGY_FIELD, bytes: new Uint8Array([1, 1, 0]) },
    { artifactType: HYDROLOGY_WATER, bytes: new Uint8Array([2, 1, 0]) },
  ]);
  const harness = createHarness(fixture);
  harness.artifactSets.push(fixture.artifacts);
  await harness.manager.submit(fixture.manifest);
  const closing = harness.manager.close();
  assert(harness.manager.close() === closing, "close was not idempotent");
  await closing;
  const closeOrder = harness.retirementOrder.filter((entry) => entry.endsWith(":closed")).slice(-3);
  assert(closeOrder[0]?.startsWith("chunk:")
    && closeOrder[1] === `global:${HYDROLOGY_WATER}:closed`
    && closeOrder[2] === `global:${HYDROLOGY_FIELD}:closed`,
  `close retired prerequisite before dependent (${closeOrder.join(",")})`);
  assert(harness.manager.current === null, "close retained a live revision");
  await rejects(harness.manager.submit(fixture.manifest), /manager is closed/, "closed manager accepted another revision");
}

// Closing signals both active and queued work before waiting for their cleanup.
{
  const active = makeManifest(111, [{ tx: 0 }]);
  const pending = makeManifest(112, [{ tx: 0, topology: "close-pending" }]);
  const loadStarted = deferred();
  let abortEvents = 0;
  const manager = new DerivedRevisionManager({
    projectId: "grey-field",
    branchId: "main",
    getAuthoritativeSource: () => ({
      projectId: "grey-field",
      branchId: "main",
      revision: active.manifest.source.revision,
      headHash: active.manifest.source.headHash,
    }),
    loadArtifact: (input: any) => new Promise((_resolve, reject) => {
      loadStarted.resolve();
      input.signal.addEventListener("abort", () => {
        abortEvents++;
        reject(input.signal.reason);
      }, { once: true });
    }),
    stageChunk: async () => { throw new Error("closing load reached staging"); },
    activateRevision: async () => { throw new Error("closing load reached activation"); },
    disposeChunk: async () => {},
  });
  const activeSubmission = manager.submit(active.manifest);
  await loadStarted.promise;
  const pendingSubmission = manager.submit(pending.manifest);
  const closing = manager.close();
  await rejects(activeSubmission, /cancelled/, "close did not cancel active artifact loading");
  await rejects(pendingSubmission, /cancelled/, "close did not cancel queued revision work");
  await closing;
  assert(abortEvents === 1 && manager.current === null, "close did not signal active work or retained runtime state");
}

// Activation failure preserves both prior sets; successful replacement retires chunks before globals.
const atomicBase = makeManifest(101, [{ tx: 0 }], [{ artifactType: "hydrology-field/v1", bytes: new Uint8Array([1]) }]);
const atomicNext = makeManifest(102, [{ tx: 0, topology: "atomic-next" }], [{ artifactType: "hydrology-field/v1", bytes: new Uint8Array([2]) }]);
const atomicHarness = createHarness(atomicBase);
atomicHarness.artifactSets.push(atomicBase.artifacts, atomicNext.artifacts);
await atomicHarness.manager.submit(atomicBase.manifest);
const atomicPriorChunk = atomicHarness.manager.current.chunks[0].resource;
const atomicPriorGlobal = atomicHarness.manager.current.globals.get("hydrology-field/v1").resource;
atomicHarness.setAuthority(atomicNext);
atomicHarness.setActivationFailure(true);
await rejects(atomicHarness.manager.submit(atomicNext.manifest), /activation failed/, "mixed activation failure was swallowed");
assert(atomicHarness.manager.current.chunks[0].resource === atomicPriorChunk
  && atomicHarness.manager.current.globals.get("hydrology-field/v1").resource === atomicPriorGlobal,
"mixed activation failure changed manager visibility");
assert(atomicHarness.disposed.some((entry) => entry.reason === "activation-failed")
  && atomicHarness.disposedGlobals.some((entry) => entry.reason === "activation-failed"),
"mixed activation failure leaked staged resources");
atomicHarness.setActivationFailure(false);
await atomicHarness.manager.submit(atomicNext.manifest);
const retirementTail = atomicHarness.retirementOrder.filter((entry) => entry.endsWith(":replaced")).slice(-2);
assert(retirementTail[0]?.startsWith("chunk:") && retirementTail[1]?.startsWith("global:"),
  `replacement retirement order was not chunk then global (${retirementTail.join(",")})`);

// Retirement failures are diagnostic only, and forced authoritative rollback restores both domains.
{
  let authority = atomicBase;
  let failRetirement = false;
  const order: string[] = [];
  let sequence = 0;
  const artifacts = new Map([...atomicBase.artifacts, ...atomicNext.artifacts]);
  const manager = new DerivedRevisionManager({
    projectId: "grey-field", branchId: "main",
    getAuthoritativeSource: () => ({ projectId: "grey-field", branchId: "main", revision: authority.manifest.source.revision, headHash: authority.manifest.source.headHash }),
    loadArtifact: (input: any) => artifacts.get(input.artifact.contentHash)!,
    stageChunk: async (input: any) => ({ id: ++sequence, chunk: input.chunk.chunkId }),
    stageGlobal: async (input: any) => ({ id: ++sequence, global: input.artifact.artifactType }),
    activateRevision: async () => {},
    disposeChunk: async (input: any) => { order.push(`chunk:${input.reason}`); if (failRetirement) throw new Error("chunk retire failed"); },
    disposeGlobal: async (input: any) => { order.push(`global:${input.reason}`); if (failRetirement) throw new Error("global retire failed"); },
  });
  await manager.submit(atomicBase.manifest);
  authority = atomicNext;
  failRetirement = true;
  const outcome = await manager.submit(atomicNext.manifest);
  assert(outcome.status === "activated" && outcome.retirementFailures === 2 && manager.current.manifest.source.revision === 102,
    "retirement failure blocked successful activation");
  assert(order.slice(-2).join(",") === "chunk:replaced,global:replaced", "failed retirement did not preserve dependency order");
  const diagnostic = manager.getDiagnostics().at(-1);
  assert(diagnostic.retirementFailures === 2 && diagnostic.errorCount === 2, "retirement failures were not diagnostic");
  authority = atomicBase;
  failRetirement = false;
  const rollback = await manager.submit(atomicBase.manifest, { force: true });
  assert(rollback.status === "activated" && manager.current.manifest.source.revision === 101
    && manager.current.chunks[0].chunk.topologyHash === atomicBase.manifest.chunks[0].topologyHash
    && manager.current.globals.get("hydrology-field/v1").artifact.contentHash === atomicBase.manifest.globalArtifacts[0].contentHash,
  "forced rollback did not restore both chunk and global descriptors");
}

ops.op_log(
  "p_derived_runtime OK: exact-head validated revisions atomically activate complete chunk/global sets; exact descriptor identity preserves unchanged resources; content-addressed loads verify length/hash; v1/v2-empty compatibility, missing lifecycle fail-closed, failure/cancellation cleanup, dependency-ordered retirement, queued work, and forced two-domain rollback proven.",
);
