// p99 — off-main-thread derived verification (H8, plan review-remediation-architectural
// Chunk C1). Proves the ONE verifier (derived-runtime-verify.ts) accepts a golden
// snapshot and rejects tampered input — one flipped byte (content-hash mismatch), a
// canonical re-encode mismatch, and a duplicated chunk id — IDENTICALLY inline and
// through the worker-shell controller (the sim-worker testable-controller pattern, so
// this runs headless with no Worker global). Also proves verify-before-construct: the
// render candidate constructor refuses an unverified raw snapshot. The tamper cases
// are the gate's in-code falsifiability proof (§6): a broken input must FAIL.
//
// The companion static check (verify module's import graph pulls no three/DOM) lives
// in js/test/browser_derived_verify_static.test.cjs — the limina host has no
// filesystem read surface, so source-text checks run under node --test (house
// pattern: browser_derived_transaction_static.test.cjs).

import {
  DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA,
  DERIVED_VERIFY_WORKER_SCHEMA,
  DerivedSnapshotVerifier,
  collectDerivedSnapshotTransferables,
  createDerivedVerifyWorkerController,
  isVerifiedTransferredDerivedSnapshot,
  parseTransferredDerivedRuntimeSnapshot,
  type ParsedTransferredDerivedSnapshot,
} from "../src/browser/derived-runtime-verify.ts";
import {
  DetachedDerivedRenderCandidate,
  searchTransferredDerivedNavigation,
} from "../src/browser/derived-runtime-render-candidate.ts";
import { DERIVED_TERRAIN_RESIDENCY_SCHEMA } from "../src/browser/derived-terrain-residency.ts";
import { createTerrainGridSpec, terrainChunkId } from "../src/terrain/grid.mjs";
import {
  DERIVED_REVISION_MANIFEST_SCHEMA_V2,
  createDerivedRevisionManifest,
  derivedArtifactContentHash,
} from "../src/world/compiler/manifest.mjs";
import {
  TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE,
  decodeTerrainChunkArtifact,
  encodeTerrainChunkArtifact,
} from "../src/world/compiler/terrain-artifact.mjs";
import {
  NAVIGATION_INDEX_ARTIFACT_MEDIA_TYPE,
  NAVIGATION_INDEX_ARTIFACT_TYPE,
  encodeNavigationIndexArtifact,
} from "../src/world/compiler/navigation-index-artifact.mjs";
import {
  WORLD_OVERVIEW_ARTIFACT_MEDIA_TYPE,
  WORLD_OVERVIEW_ARTIFACT_TYPE,
  decodeWorldOverviewArtifact,
  encodeWorldOverviewArtifact,
} from "../src/world/compiler/world-overview-artifact.mjs";
import { ATLAS_DESIGN_REF_SCHEMA } from "../src/world/design-ref.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p99_derived_verify_worker FAIL: ${message}`);
}

function caught(fn: () => unknown): Error | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function caughtAsync(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

// ── Golden fixture: two resident terrain chunks + navigation-index and world-overview
//    globals (a raw-bytes hash seam and a canonical re-encode seam). ──

const hash = (label: string): string => derivedArtifactContentHash(new TextEncoder().encode(label));
const FAR = 9_000_000;
const grid = createTerrainGridSpec({ gridId: "verify-field.surface", origin: [FAR, FAR], chunkSizeM: 64, defaultSamples: 3 });

function terrain(tx: number, heights: number[]) {
  const bytes = encodeTerrainChunkArtifact({
    nrows: 3,
    ncols: 3,
    origin: [FAR + (tx + 0.5) * 64, 100, FAR + 32],
    scale: [64, 10, 64],
    heights: new Float32Array(heights),
  });
  return {
    bytes,
    descriptor: {
      artifactType: "terrain-chunk/v1",
      contentHash: derivedArtifactContentHash(bytes),
      byteLength: bytes.byteLength,
      mediaType: TERRAIN_CHUNK_ARTIFACT_MEDIA_TYPE,
    },
  };
}

const terrain0 = terrain(0, [0, 0.25, 0.5, 0.25, 0.5, 0.75, 0.5, 0.75, 1]);
const terrain1 = terrain(1, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);

const navigationBytes = encodeNavigationIndexArtifact({
  worldBounds: { minX: FAR, minZ: FAR, maxX: FAR + 25_600, maxZ: FAR + 25_600 },
  entries: [{
    designRef: { schema: ATLAS_DESIGN_REF_SCHEMA, mapId: "primary", kind: "place", id: "verify-mill" },
    position: [FAR + 320, FAR + 640],
    radiusM: 24,
    label: "Verify Mill",
    kind: "village",
    searchKeys: ["verify mill", "mill"],
  }],
});
const navigationDescriptor = {
  artifactType: NAVIGATION_INDEX_ARTIFACT_TYPE,
  contentHash: derivedArtifactContentHash(navigationBytes),
  byteLength: navigationBytes.byteLength,
  mediaType: NAVIGATION_INDEX_ARTIFACT_MEDIA_TYPE,
};

const overviewCells = 65 * 65;
const overviewBytes = encodeWorldOverviewArtifact({
  rows: 65,
  cols: 65,
  origin: [FAR, FAR],
  stepM: 200,
  heights: new Float32Array(overviewCells).fill(100),
  paintMaterial: new Uint8Array(overviewCells).fill(2),
  paintWeight: new Uint8Array(overviewCells).fill(128),
});
const overviewDescriptor = {
  artifactType: WORLD_OVERVIEW_ARTIFACT_TYPE,
  contentHash: derivedArtifactContentHash(overviewBytes),
  byteLength: overviewBytes.byteLength,
  mediaType: WORLD_OVERVIEW_ARTIFACT_MEDIA_TYPE,
};

const manifest = createDerivedRevisionManifest({
  schema: DERIVED_REVISION_MANIFEST_SCHEMA_V2,
  projectId: "verify-field",
  branchId: "main",
  source: {
    revision: 7,
    headHash: hash("head"),
    contentRefs: [{ refId: "map-document", refType: "map-document/v1", scope: "global", assetId: "maps/verify-field.mapdoc.json", contentHash: hash("map") }],
  },
  compiler: { version: "1.2.0", configHash: hash("config"), graphHash: hash("graph"), snapshotHash: hash("snapshot") },
  grid,
  globalArtifacts: [navigationDescriptor, overviewDescriptor],
  chunks: Array.from({ length: 4 }, (_, tx) => ({
    chunkId: terrainChunkId(grid.gridId, 0, tx, 0),
    gridId: grid.gridId,
    lod: 0,
    tx,
    tz: 0,
    topologyHash: hash(`topology-${tx}`),
    sourceSliceHashes: [],
    artifacts: [tx === 0 ? terrain0.descriptor : terrain1.descriptor],
  })).sort((left, right) => left.chunkId < right.chunkId ? -1 : left.chunkId > right.chunkId ? 1 : 0),
});

// deno-lint-ignore no-explicit-any
function snapshot(): any {
  return {
    schema: DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA,
    projectId: manifest.projectId,
    branchId: manifest.branchId,
    manifestHash: manifest.manifestHash,
    source: manifest.source,
    manifest,
    residency: { schema: DERIVED_TERRAIN_RESIDENCY_SCHEMA, center: [FAR + 32, FAR + 32], lod: 0, radius: 1 },
    chunks: manifest.chunks.filter((chunk) => chunk.tx <= 1).map((chunk) => ({
      chunkId: chunk.chunkId,
      chunk,
      resource: { kind: "terrain-chunk/v1", decoded: decodeTerrainChunkArtifact(chunk.tx === 0 ? terrain0.bytes : terrain1.bytes) },
    })),
    globals: [
      {
        artifactType: NAVIGATION_INDEX_ARTIFACT_TYPE,
        artifact: navigationDescriptor,
        resource: { kind: NAVIGATION_INDEX_ARTIFACT_TYPE, bytes: navigationBytes.slice() },
      },
      {
        artifactType: WORLD_OVERVIEW_ARTIFACT_TYPE,
        artifact: overviewDescriptor,
        resource: { kind: WORLD_OVERVIEW_ARTIFACT_TYPE, decoded: decodeWorldOverviewArtifact(overviewBytes) },
      },
    ],
  };
}

// deno-lint-ignore no-explicit-any
function flippedNavigationByte(): any {
  const value = snapshot();
  value.globals[0].resource.bytes[value.globals[0].resource.bytes.length - 1] ^= 1;
  return value;
}

// deno-lint-ignore no-explicit-any
function tamperedOverviewHeight(): any {
  const value = snapshot();
  value.globals[1].resource.decoded.grid.heights[0] += 1;
  return value;
}

// deno-lint-ignore no-explicit-any
function duplicatedChunkId(): any {
  const value = snapshot();
  value.chunks[1] = { ...value.chunks[0] };
  return value;
}

function assertGolden(parsed: ParsedTransferredDerivedSnapshot, venue: string): void {
  assert(parsed.manifestHash === manifest.manifestHash && parsed.projectId === "verify-field"
    && parsed.source.revision === 7 && parsed.manifest.chunks.length === 4,
  `${venue}: golden snapshot identity was not preserved`);
  assert(parsed.terrain.size === 2 && parsed.terrain.sampleHeight(FAR + 32, FAR + 32) === 105,
    `${venue}: bounded terrain index or exact height sample changed`);
  assert(parsed.worldOverview?.grid.rows === 65 && parsed.worldOverview.metadata.byteLength === overviewBytes.byteLength,
    `${venue}: canonical world overview was not retained`);
  const navigationHit = searchTransferredDerivedNavigation(parsed, "verify m", 1)[0];
  assert(navigationHit?.designRef.id === "verify-mill" && navigationHit.position[0] === FAR + 320,
    `${venue}: hydrated navigation index is not searchable in this realm`);
  assert(isVerifiedTransferredDerivedSnapshot(parsed), `${venue}: output does not carry the runtime verification brand`);
}

// ── 1. Inline venue: golden accept + tamper rejects. ──

const inlineParsed = parseTransferredDerivedRuntimeSnapshot(snapshot());
assertGolden(inlineParsed, "inline");

const inlineFlipped = caught(() => parseTransferredDerivedRuntimeSnapshot(flippedNavigationByte()));
assert(inlineFlipped !== null && /canonical descriptor/.test(inlineFlipped.message),
  `inline: one flipped navigation byte was not rejected by its content hash (${inlineFlipped?.message ?? "accepted"})`);
const inlineOverview = caught(() => parseTransferredDerivedRuntimeSnapshot(tamperedOverviewHeight()));
assert(inlineOverview !== null && /canonical descriptor/.test(inlineOverview.message),
  `inline: canonical re-encode did not reject a mutated decoded overview (${inlineOverview?.message ?? "accepted"})`);
const inlineDuplicate = caught(() => parseTransferredDerivedRuntimeSnapshot(duplicatedChunkId()));
assert(inlineDuplicate !== null && /duplicate|manifest order/.test(inlineDuplicate.message),
  `inline: duplicated chunk id was not rejected (${inlineDuplicate?.message ?? "accepted"})`);

// ── 2. Verify-before-construct: the mounting constructor refuses raw input. The type
//       brand is erased on this untranspiled host, so the runtime assert is the seam. ──

const rawConstruction = caught(() => new DetachedDerivedRenderCandidate(snapshot() as never, {}));
assert(rawConstruction !== null && /requires a snapshot verified/.test(rawConstruction.message),
  "an unverified raw snapshot reached the mounting constructor");

// ── 3. Worker-shell venue (testable-controller loopback, no Worker global): identical
//       behavior for the golden accept and every tamper reject. ──

function loopbackVerifier(): DerivedSnapshotVerifier {
  const listeners: ((message: unknown) => void)[] = [];
  const controller = createDerivedVerifyWorkerController((message) => {
    for (const listener of listeners) listener(message);
  });
  return new DerivedSnapshotVerifier({
    post: (message) => controller(message),
    listen: (handler) => { listeners.push(handler); },
  }, { timeoutMs: null });
}

const workerParsed = await loopbackVerifier().verify(snapshot());
assertGolden(workerParsed, "worker");
assert(workerParsed.manifestHash === inlineParsed.manifestHash
  && workerParsed.terrain.sampleHeight(FAR + 40, FAR + 20) === inlineParsed.terrain.sampleHeight(FAR + 40, FAR + 20),
"worker and inline venues disagreed on verified content");
const workerCandidate = new DetachedDerivedRenderCandidate(workerParsed, {});
assert(workerCandidate.terrainMeshCount === 2 && workerCandidate.overviewMeshCount === 1,
  "worker-verified snapshot did not mount the exact bounded window");
workerCandidate.dispose();

const workerFlipped = await caughtAsync(() => loopbackVerifier().verify(flippedNavigationByte()));
assert(workerFlipped !== null && workerFlipped.message === inlineFlipped!.message,
  `worker venue diverged from inline on the flipped-byte reject (${workerFlipped?.message ?? "accepted"})`);
const workerOverview = await caughtAsync(() => loopbackVerifier().verify(tamperedOverviewHeight()));
assert(workerOverview !== null && workerOverview.message === inlineOverview!.message,
  `worker venue diverged from inline on the re-encode reject (${workerOverview?.message ?? "accepted"})`);
const workerDuplicate = await caughtAsync(() => loopbackVerifier().verify(duplicatedChunkId()));
assert(workerDuplicate !== null && workerDuplicate.message === inlineDuplicate!.message,
  `worker venue diverged from inline on the duplicate-chunk reject (${workerDuplicate?.message ?? "accepted"})`);

// ── 4. Protocol hygiene: a malformed envelope is rejected without wedging the client,
//       and a channel-level failure rejects in-flight and later requests. ──

{
  const listeners: ((message: unknown) => void)[] = [];
  const controller = createDerivedVerifyWorkerController((message) => {
    for (const listener of listeners) listener(message);
  });
  const responses: unknown[] = [];
  listeners.push((message) => responses.push(message));
  controller({ schema: DERIVED_VERIFY_WORKER_SCHEMA, type: "verify", requestId: 1, snapshot: snapshot(), extra: true });
  const rejected = responses[0] as Record<string, unknown>;
  assert(rejected?.type === "verify-rejected" && rejected.requestId === 1,
    "a malformed verify envelope was not rejected with its request id");
}
{
  const verifier = new DerivedSnapshotVerifier({ post: () => {}, listen: () => {} }, { timeoutMs: null });
  const pending = verifier.verify(snapshot());
  verifier.fail(new Error("injected channel failure"));
  const failure = await caughtAsync(() => pending);
  assert(failure !== null && /injected channel failure/.test(failure.message),
    "channel failure did not reject the in-flight verification");
  const later = await caughtAsync(() => verifier.verify(snapshot()));
  assert(later !== null && /injected channel failure/.test(later.message),
    "a failed verify channel accepted later requests");
}

// ── 5. RETAIN-AND-REUSE (D1 — the editor's exact pattern). The editor keeps ONE snapshot
//       object and re-activates it for Play-start and edit-reboot, so the verify client must
//       never detach the caller's buffers. This channel emulates REAL postMessage transfer
//       semantics headlessly (structured clone of the message, then source-side detach of every
//       transfer-listed buffer via ArrayBuffer.prototype.transfer, and a DataCloneError on an
//       already-detached transferable) — a plain synchronous loopback would never detach
//       anything and could not falsify the copy-before-post behavior. ──

function structuredCloneLike(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function") throw new Error("gate clone: functions are not structured-clone-safe");
    return value;
  }
  const cached = seen.get(value as object);
  if (cached !== undefined) return cached;
  if (value instanceof ArrayBuffer) {
    if ((value as ArrayBuffer & { detached?: boolean }).detached === true) throw new Error("DataCloneError: ArrayBuffer is detached");
    const copy = value.slice(0);
    seen.set(value, copy);
    return copy;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    if ((view.buffer as ArrayBuffer & { detached?: boolean }).detached === true) throw new Error("DataCloneError: ArrayBuffer is detached");
    const Ctor = view.constructor as new (input: unknown) => ArrayBufferView;
    const copy = new Ctor(view); // typed arrays copy-construct into a fresh owned buffer
    seen.set(value, copy);
    return copy;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const entry of value) out.push(structuredCloneLike(entry, seen));
    return out;
  }
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const key of Object.getOwnPropertyNames(value)) out[key] = structuredCloneLike((value as Record<string, unknown>)[key], seen);
  return out;
}

function emulatePostMessage(message: unknown, transfer: readonly unknown[]): unknown {
  for (const entry of transfer) {
    if (entry instanceof ArrayBuffer && (entry as ArrayBuffer & { detached?: boolean }).detached === true) {
      throw new Error("DataCloneError: cannot transfer a detached ArrayBuffer");
    }
  }
  const delivered = structuredCloneLike(message);
  // Source-side detach — exactly what a real postMessage transfer list does.
  for (const entry of transfer) {
    if (entry instanceof ArrayBuffer) (entry as ArrayBuffer & { transfer(): ArrayBuffer }).transfer();
  }
  return delivered;
}

function transferEmulatingVerifier(): DerivedSnapshotVerifier {
  const listeners: ((message: unknown) => void)[] = [];
  const controller = createDerivedVerifyWorkerController((message, transfer) => {
    const delivered = emulatePostMessage(message, transfer ?? []);
    for (const listener of listeners) listener(delivered);
  });
  return new DerivedSnapshotVerifier({
    post: (message, transfer) => { controller(emulatePostMessage(message, transfer)); },
    listen: (handler) => { listeners.push(handler); },
  }, { timeoutMs: null });
}

{
  assert(typeof (ArrayBuffer.prototype as unknown as { transfer?: unknown }).transfer === "function",
    "this host lacks ArrayBuffer.prototype.transfer — the transfer emulation cannot run");
  const retained = snapshot();
  const client = transferEmulatingVerifier();
  const first = await client.verify(retained);
  assertGolden(first, "retain-first");
  // Same client, same retained object (Play-start re-activation through the same runtime)…
  const second = await client.verify(retained);
  assertGolden(second, "retain-reuse");
  // …and a FRESH client over the same retained object (edit-reboot spawns a new runtime).
  const third = await transferEmulatingVerifier().verify(retained);
  assertGolden(third, "retain-reboot");
  assert(first.manifestHash === second.manifestHash && second.manifestHash === third.manifestHash,
    "retained-snapshot re-verifications disagreed");
}

// ── 6. FALSIFIABILITY of leg 5's emulation + the retained-buffer contract, in code: posting the
//       caller's ORIGINAL buffers as the request transfer list (the pre-fix client behavior)
//       detaches them, and the SECOND use of the same snapshot fails with the DataCloneError the
//       editor hit (DERIVED_PLAY_INITIAL_ACTIVATION_FAILED). Proves the channel's detach
//       emulation is live — leg 5 cannot pass vacuously. ──
{
  const doomed = snapshot();
  const responses: unknown[] = [];
  const controller = createDerivedVerifyWorkerController((message, transfer) => {
    responses.push(emulatePostMessage(message, transfer ?? []));
  });
  controller(emulatePostMessage(
    { schema: DERIVED_VERIFY_WORKER_SCHEMA, type: "verify", requestId: 61, snapshot: doomed },
    collectDerivedSnapshotTransferables(doomed),
  ));
  assert((responses[0] as { type?: string } | undefined)?.type === "verified",
    "the transfer-emulating channel must deliver intact bytes on first use");
  const detachedReuse = caught(() => emulatePostMessage(
    { schema: DERIVED_VERIFY_WORKER_SCHEMA, type: "verify", requestId: 62, snapshot: doomed },
    collectDerivedSnapshotTransferables(doomed),
  ));
  assert(detachedReuse !== null && /DataCloneError/.test(detachedReuse.message),
    "transferring the caller's own buffers must detach them and fail the snapshot's second use");
  // The client also names the condition up front: a snapshot whose buffers were already
  // detached is rejected with a clear error instead of an opaque verification failure.
  const clientReject = await caughtAsync(() => transferEmulatingVerifier().verify(doomed));
  assert(clientReject !== null && /detached/.test(clientReject.message),
    `an already-detached snapshot must be rejected with a clear detached-buffer error (${clientReject?.message ?? "accepted"})`);
}

console.log("[js] p99_derived_verify_worker OK: one verifier accepts the golden snapshot and rejects flipped-byte/re-encode/duplicate tampers identically inline and through the worker-shell controller; unverified snapshots cannot reach the mounting constructor; a RETAINED snapshot re-verifies through transfer-emulating channels (editor Play-start/edit-reboot pattern) while transferring the caller's own buffers provably detaches them");
