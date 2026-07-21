// p_studio_trace_append_replay — APPEND-MODE INCREMENTAL REPLAY INDEX (studio-unification P4).
//
// THE BUG THIS GATE PINS: an append-backed LiminaTracer answered every tail() /
// explainEvent() / durableEventCount() by re-reading the WHOLE durable file and
// re-verifying its ENTIRE sha256 chain (one native op + O(history) parse/hash per
// call). The editor host polls trace.tail on a cursor, so a long-lived session's
// trace cost grew QUADRATICALLY — the long-running-host degradation the idle-step
// filter and read-only-skill cut exist to prevent.
//
// THE FIX UNDER TEST: append mode keeps a verified durable byte cursor. A bounded
// native suffix read supplies only newly appended bytes plus file identity,
// length, and a verified-tail anchor. Every query catches up that suffix, so
// valid external appenders become visible while corruption, replacement, and
// truncation fail closed. Static replay remains the explicit full verifier.
//
// PROOF SHAPE:
//   1. PARITY: after EVERY emit, the incremental index equals a fresh full-file
//      replay — ids, integrity hashes, threadId, causal linkage (parents/children).
//   2. EXTERNAL WRITERS: two live tracers converge without a full reread.
//   3. FAILURE SEMANTICS: corrupt suffixes and replacement poison the live
//      cursor; reopen recovery and torn-tail recovery remain deterministic.
//   4. CAUSAL/IMMUTABILITY: forward references resolve like the two-pass static
//      replay and callers cannot mutate the live cached replay structure.
//   5. RETENTION: the hot window preserves order with O(1) ring eviction.
//   6. NON-TIMING SCALE: operation counters prove unchanged polls do no byte,
//      hash, or history-scan work, and K appends cost K verifications/visits.
//
// Run: LIMINA_AUDIO=null ./target/release/limina js/test/p_studio_trace_append_replay.ts

import { ops } from "../src/engine.ts";
import {
  LiminaTracer,
  TraceIntegrityError,
  type EmitInput,
  type EngineEvent,
  type TraceReplayResult,
} from "../src/observability/event.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p_studio_trace_append_replay FAIL: " + msg);
}

const THREAD = "ses_studio_trace_append";

function emitN(
  tracer: LiminaTracer,
  i: number,
  opts: { parent?: string; causedBy?: string[]; threadId?: string } = {},
): string {
  const e: EmitInput = {
    type: "p_studio.trace.event",
    actorId: "agent_studio",
    threadId: opts.threadId ?? THREAD,
    parentEventId: opts.parent ?? null,
    causedBy: opts.causedBy ?? [],
    payload: { tick: i },
  };
  return tracer.emit(e);
}

/** The incremental index must equal a fresh full-file replay, field for field. */
function assertIndexParity(name: string, index: TraceReplayResult): void {
  const full = LiminaTracer.replayTrace(name);
  assert(index.events.length === full.events.length, `event count ${index.events.length} != file ${full.events.length}`);
  assert(index.threadId === full.threadId, `threadId ${index.threadId} != ${full.threadId}`);
  assert(index.threadIds.join(",") === full.threadIds.join(","), `threadIds ${index.threadIds.join(",")} != ${full.threadIds.join(",")}`);
  assert(index.byId.size === full.byId.size, "byId size mismatch");
  assert(index.parentsById.size === full.parentsById.size, "parentsById size mismatch");
  assert(index.childrenById.size === full.childrenById.size, "childrenById size mismatch");
  for (let i = 0; i < full.events.length; i++) {
    const a = index.events[i];
    const b = full.events[i];
    assert(a.id === b.id, `event[${i}] id mismatch`);
    assert(a.integrity?.hash === b.integrity?.hash, `event[${i}] hash mismatch (index not chain-faithful)`);
    assert(a.integrity?.previousHash === b.integrity?.previousHash, `event[${i}] previousHash mismatch`);
    const pa = (index.parentsById.get(a.id) ?? []).map((e: EngineEvent) => e.id).join(",");
    const pb = (full.parentsById.get(b.id) ?? []).map((e: EngineEvent) => e.id).join(",");
    assert(pa === pb, `parents of ${a.id}: ${pa} != ${pb}`);
    const ca = (index.childrenById.get(a.id) ?? []).map((e: EngineEvent) => e.id).join(",");
    const cb = (full.childrenById.get(b.id) ?? []).map((e: EngineEvent) => e.id).join(",");
    assert(ca === cb, `children of ${a.id}: ${ca} != ${cb}`);
  }
}

function tickOf(event: EngineEvent): number {
  return (event.payload as { tick: number }).tick;
}

function expectIntegrityReason(run: () => unknown, reason: TraceIntegrityError["reason"], label: string): TraceIntegrityError {
  try {
    run();
  } catch (err) {
    assert(err instanceof TraceIntegrityError, `${label}: expected TraceIntegrityError, got ${String(err)}`);
    assert(err.reason === reason, `${label}: expected ${reason}, got ${err.reason}`);
    return err;
  }
  throw new Error(`p_studio_trace_append_replay FAIL: ${label}: expected ${reason}`);
}

// ═══ 1+2. PARITY per emit + ZERO file reads after boot. ════════════════════════
const NAME = "p_studio_trace_append_replay.jsonl";
ops.op_write_trace(NAME, "");
let readCount = 0;
const originalRead = ops.op_read_trace;
(ops as unknown as { op_read_trace: (name: string) => string }).op_read_trace = (name: string): string => {
  readCount++;
  return originalRead(name);
};
try {
  const tracer = LiminaTracer.appendOnEmit(THREAD, NAME);
  // Boot itself may read; parity-phase reads via the static verifier are expected.
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    ids.push(emitN(tracer, i, { parent: i > 0 ? ids[i - 1] : undefined, causedBy: i > 1 ? [ids[i - 2]] : undefined }));
    // Query through the incremental index after every emit.
    const tail = tracer.tail({ afterSeq: -1, limit: 1000 });
    assert(tail.events.length === i + 1, `tail after emit ${i}: ${tail.events.length} != ${i + 1}`);
    assertIndexParity(NAME, tracer.replay());
    assert(tracer.durableEventCount() === i + 1, "durableEventCount must track the index");
  }
  // Cost leg, isolated: queries below must add ZERO reads (the parity asserts
  // above legitimately read via the static verifier).
  const afterParity = readCount;
  const suffix = tracer.tail({ afterSeq: 5, limit: 100 });
  assert(suffix.events.length === 6, `cursor tail: ${suffix.events.length} != 6`);
  for (let i = 0; i < 8; i++) {
    tracer.tail({ afterSeq: i, limit: 100 });
    tracer.replay();
    tracer.durableEventCount();
  }
  tracer.explainEvent(ids[10]);
  assert(readCount === afterParity, `append-mode queries must not re-read the file (parity-phase reads ${afterParity}, query-phase added ${readCount - afterParity})`);

  // ═══ 5. explainEvent linkage through the index. ═════════════════════════════
  const explained = tracer.explainEvent(ids[10]);
  assert(explained !== undefined, "explainEvent must resolve through the index");
  assert(explained.parents.map((e) => e.id).join(",") === [ids[9], ids[8]].join(","), "explain parents");
  assert(explained.children.length === 1 && explained.children[0].id === ids[11], "explain children");
} finally {
  (ops as unknown as { op_read_trace: (name: string) => string }).op_read_trace = originalRead;
}

// ═══ 3. TAMPER EVIDENCE — the static verifier still rejects a corrupted line. ══
{
  const lines = ops.op_read_trace(NAME).trimEnd().split("\n");
  const bad = JSON.parse(lines[3]) as EngineEvent;
  (bad as { payload: unknown }).payload = { tick: 999 };
  lines[3] = JSON.stringify(bad);
  let threw = false;
  try {
    LiminaTracer.replayJsonl(lines.join("\n") + "\n");
  } catch (err) {
    threw = err instanceof TraceIntegrityError && err.reason === "hash_mismatch";
  }
  assert(threw, "static verifier must reject a corrupted line with hash_mismatch");
}

// ═══ 4. TORN FINAL LINE recovery at boot — index matches the rewritten file. ═══
{
  const TORN = "p_studio_trace_append_torn.jsonl";
  ops.op_write_trace(TORN, "");
  const seed = LiminaTracer.appendOnEmit(THREAD, TORN);
  emitN(seed, 0);
  emitN(seed, 1);
  ops.op_append_trace(TORN, '{"id":"evt_agent_studio_000000000002_DEADBEEFDEADBEEF","type":"p_studio.trunc'); // torn tail
  const recovered = LiminaTracer.appendOnEmit(THREAD, TORN);
  const index = recovered.replay();
  assert(index.partialFinalLine === undefined, "recovered index must not report the rewritten torn tail");
  assert(index.events.length === 2, `recovered events ${index.events.length} != 2`);
  emitN(recovered, 2);
  assertIndexParity(TORN, recovered.replay());
}

// ═══ 6. EXTERNAL APPENDERS converge by verified suffix, never full reread. ════
{
  const EXTERNAL = "p_studio_trace_external_writer.jsonl";
  ops.op_write_trace(EXTERNAL, "");
  const first = LiminaTracer.appendOnEmit(THREAD, EXTERNAL, 3);
  const second = LiminaTracer.appendOnEmit(THREAD, EXTERNAL, 3);
  const root = emitN(first, 0);
  const child = emitN(second, 1, { parent: root });

  const before = first.workMetrics();
  const caughtUp = first.tail({ afterSeq: 0, limit: 10 });
  const after = first.workMetrics();
  assert(caughtUp.events.length === 1 && caughtUp.events[0].id === child, "external append was not caught up");
  assert(after.linesVerified - before.linesVerified === 1, "external catch-up must verify exactly one new line");
  assert(after.deltaBytesRead > before.deltaBytesRead, "external catch-up must read the new suffix");
  assert(after.fullFileReads === before.fullFileReads, "external catch-up must not fall back to a full read");
  const explained = first.explainEvent(child);
  assert(explained?.parents[0]?.id === root, "external child did not link to its parent");
  assert(first.inspect().eventCount === 2, "hot ring did not include external durable events");
}

// A writer may expose a final line in multiple durable writes. Queries retain
// the verified prefix until the newline arrives, then verify the assembled line
// exactly once; local emit remains forbidden while the tail is incomplete.
{
  const PARTIAL = "p_studio_trace_external_partial.jsonl";
  const STAGING = "p_studio_trace_external_partial_staging.jsonl";
  ops.op_write_trace(PARTIAL, "");
  const live = LiminaTracer.appendOnEmit(THREAD, PARTIAL);
  emitN(live, 0);
  ops.op_write_trace(STAGING, ops.op_read_trace(PARTIAL));
  const staging = LiminaTracer.appendOnEmit(THREAD, STAGING);
  const stagedId = emitN(staging, 1);
  const stagedLine = ops.op_read_trace(STAGING).trimEnd().split("\n")[1] + "\n";
  const cut = Math.floor(stagedLine.length / 2);
  ops.op_append_trace(PARTIAL, stagedLine.slice(0, cut));
  const prefixOnly = live.tail({ afterSeq: 0, limit: 10 });
  assert(prefixOnly.events.length === 0, "partial external line became visible before completion");
  expectIntegrityReason(() => emitN(live, 2), "partial_final_line", "emit over external partial line");
  ops.op_append_trace(PARTIAL, stagedLine.slice(cut));
  const completed = live.tail({ afterSeq: 0, limit: 10 });
  assert(completed.events.length === 1 && completed.events[0].id === stagedId, "completed external line did not become visible");
}

// ═══ 7. LIVE corrupt suffix poisons; reopen deterministically recovers prefix. ═
{
  const CORRUPT = "p_studio_trace_live_corrupt.jsonl";
  ops.op_write_trace(CORRUPT, "");
  const live = LiminaTracer.appendOnEmit(THREAD, CORRUPT);
  emitN(live, 0);
  ops.op_append_trace(CORRUPT, JSON.stringify({
    id: "evt_agent_studio_000000000001_0000000000000000",
    type: "p_studio.trace.event",
    actorId: "agent_studio",
    threadId: THREAD,
    parentEventId: null,
    causedBy: [],
    timestamp: new Date().toISOString(),
    payload: { tick: 1 },
    integrity: { hash: "sha256:not-the-event-hash", previousHash: live.replay().events[0].integrity?.hash ?? null },
  }) + "\n");
  const firstFault = expectIntegrityReason(() => live.tail(), "hash_mismatch", "live corrupt suffix");
  const repeatedFault = expectIntegrityReason(() => live.durableEventCount(), "hash_mismatch", "poisoned cursor");
  assert(firstFault === repeatedFault, "poisoned tracer must replay the original integrity fault");

  const recovered = LiminaTracer.appendOnEmit(THREAD, CORRUPT);
  assert(recovered.durableEventCount() === 1, "reopen recovery did not retain exactly the verified prefix");
  emitN(recovered, 1);
  assertIndexParity(CORRUPT, recovered.replay());
}

// ═══ 8. Atomic replacement fails live and succeeds only through explicit reopen. ═
{
  const ROTATED = "p_studio_trace_rotation.jsonl";
  ops.op_write_trace(ROTATED, "");
  const live = LiminaTracer.appendOnEmit(THREAD, ROTATED);
  emitN(live, 0);
  const intact = ops.op_read_trace(ROTATED);
  ops.op_write_trace(ROTATED, intact); // atomic rename: same bytes, new file identity
  expectIntegrityReason(() => live.replay(), "trace_replaced", "atomic replacement");
  const reopened = LiminaTracer.appendOnEmit(THREAD, ROTATED);
  assert(reopened.durableEventCount() === 1, "reopen after rotation lost the intact event");
  emitN(reopened, 1);
  assertIndexParity(ROTATED, reopened.replay());
}

// The native Rust gate performs a real same-inode truncate. This behavioral leg
// falsifies the JS cursor response without requiring a filesystem escape op.
{
  const TRUNCATED = "p_studio_trace_truncated_cursor.jsonl";
  ops.op_write_trace(TRUNCATED, "");
  const live = LiminaTracer.appendOnEmit(THREAD, TRUNCATED);
  emitN(live, 0);
  const originalDelta = ops.op_read_trace_delta;
  assert(originalDelta !== undefined, "native delta op unavailable for truncation fixture");
  (ops as { op_read_trace_delta?: typeof originalDelta }).op_read_trace_delta = (name, offset, maxBytes): string => {
    const real = JSON.parse(originalDelta(name, offset, maxBytes)) as Record<string, unknown>;
    real.length = 0;
    return JSON.stringify(real);
  };
  try {
    expectIntegrityReason(() => live.tail(), "trace_truncated", "same-inode truncation response");
  } finally {
    (ops as { op_read_trace_delta?: typeof originalDelta }).op_read_trace_delta = originalDelta;
  }
}

// ═══ 9. Mixed logical threads share one authenticated durable sequence. ═══════
{
  const MIXED = "p_studio_trace_mixed_threads.jsonl";
  const THREAD_A = "ses_studio_client_a";
  const THREAD_B = "ses_studio_client_b";
  ops.op_write_trace(MIXED, "");
  const serverView = LiminaTracer.appendOnEmit("shared_server", MIXED);
  const root = emitN(serverView, 0, { threadId: THREAD_A });
  // The append owner is a file cursor identity, not an event-thread admission
  // boundary. A second cursor must converge on the same authenticated stream.
  const secondCursor = LiminaTracer.appendOnEmit("independent_cursor", MIXED);
  const child = emitN(secondCursor, 1, { threadId: THREAD_B, parent: root });

  const replay = serverView.replay();
  assert(replay.threadId === null, "mixed replay claimed a single logical thread");
  assert(replay.threadIds.join(",") === [THREAD_A, THREAD_B].join(","), "mixed replay thread inventory/order drifted");
  assert(replay.events.length === 2, "shared cursor did not catch up the second logical thread");
  assert(serverView.explainEvent(child)?.parents[0]?.id === root, "cross-thread causal edge was not preserved");
  assert(serverView.tail({ afterSeq: -1, threadId: THREAD_A }).events.map((event) => event.id).join(",") === root, "thread A tail leaked another thread");
  assert(serverView.tail({ afterSeq: -1, threadId: THREAD_B }).events.map((event) => event.id).join(",") === child, "thread B tail leaked another thread");
  assertIndexParity(MIXED, replay);

  let inventoryMutationThrew = false;
  try { (replay.threadIds as string[]).push("forged-thread"); } catch { inventoryMutationThrew = true; }
  assert(inventoryMutationThrew, "mixed replay exposed a mutable thread inventory");

  // Removing the invalid owner-equality check must not make threadId mutable
  // outside the integrity chain: changing it without rehashing still fails.
  const lines = ops.op_read_trace(MIXED).trimEnd().split("\n");
  const forged = JSON.parse(lines[1]) as EngineEvent;
  forged.threadId = "forged-thread";
  lines[1] = JSON.stringify(forged);
  expectIntegrityReason(
    () => LiminaTracer.replayJsonl(lines.join("\n") + "\n"),
    "hash_mismatch",
    "mixed-thread id tamper",
  );
}

// ═══ 10. Forward causal refs converge with static two-pass replay. ════════════
{
  const FORWARD = "p_studio_trace_forward_parent.jsonl";
  ops.op_write_trace(FORWARD, "");
  const planner = new LiminaTracer(THREAD);
  emitN(planner, 0);
  const futureParentId = emitN(planner, 1);

  const tracer = LiminaTracer.appendOnEmit(THREAD, FORWARD);
  const childId = emitN(tracer, 0, { parent: futureParentId });
  const actualParentId = emitN(tracer, 1);
  assert(actualParentId === futureParentId, "forward-reference fixture predicted the wrong parent id");
  assert(tracer.explainEvent(childId)?.parents[0]?.id === futureParentId, "late parent did not repair child ancestry");
  assert(tracer.explainEvent(futureParentId)?.children[0]?.id === childId, "late parent did not gain its child");
  assertIndexParity(FORWARD, tracer.replay());
}

{
  const PROPERTY = "p_studio_trace_causal_property.jsonl";
  const COUNT = 64;
  const planner = new LiminaTracer(THREAD, COUNT);
  const plannedIds: string[] = [];
  for (let i = 0; i < COUNT; i++) plannedIds.push(emitN(planner, i));
  ops.op_write_trace(PROPERTY, "");
  const tracer = LiminaTracer.appendOnEmit(THREAD, PROPERTY, 5);
  for (let i = 0; i < COUNT; i++) {
    const parent = plannedIds[(i * 17 + 11) % COUNT];
    const causedBy = [plannedIds[(i * 29 + 7) % COUNT], plannedIds[(i * 31 + 3) % COUNT]];
    const actual = emitN(tracer, i, { parent, causedBy });
    assert(actual === plannedIds[i], `causal property fixture id drift at ${i}`);
  }
  assertIndexParity(PROPERTY, tracer.replay());
}

// ═══ 11. Cached append replay is structurally immutable to callers. ═══════════
{
  const IMMUTABLE = "p_studio_trace_immutable_view.jsonl";
  ops.op_write_trace(IMMUTABLE, "");
  const tracer = LiminaTracer.appendOnEmit(THREAD, IMMUTABLE);
  const root = emitN(tracer, 0);
  const child = emitN(tracer, 1, { parent: root });
  const replay = tracer.replay();
  let arrayMutationThrew = false;
  try { (replay.events as EngineEvent[]).push(replay.events[0]); } catch { arrayMutationThrew = true; }
  assert(arrayMutationThrew, "cached replay events array accepted push()");
  let mapMutationThrew = false;
  try { (replay.byId as Map<string, EngineEvent>).clear(); } catch { mapMutationThrew = true; }
  assert(mapMutationThrew, "cached replay map exposed clear()");
  let linkMutationThrew = false;
  try { (replay.parentsById.get(child) as EngineEvent[]).push(replay.events[0]); } catch { linkMutationThrew = true; }
  assert(linkMutationThrew, "cached causal link array accepted push()");
  let payloadMutationThrew = false;
  try { (replay.byId.get(root)?.payload as { tick: number }).tick = 999; } catch { payloadMutationThrew = true; }
  assert(payloadMutationThrew && tickOf(tracer.replay().byId.get(root) as EngineEvent) === 0, "cached event payload remained mutable");
}

// ═══ 12. O(1) ordered hot retention — newest maxInMemory entries, no shift. ═══
{
  const ring = new LiminaTracer(THREAD, 3);
  for (let i = 0; i < 10; i++) emitN(ring, i);
  assert(ring.inspect().eventCount === 3, "ring exceeded maxInMemory");
  assert(ring.inspect().recent.map(tickOf).join(",") === "7,8,9", "ring did not preserve newest-first insertion order");
  assert(ring.trace("agent_studio").map(tickOf).join(",") === "7,8,9", "trace() did not preserve ring order");
}

{
  const FILTERED = "p_studio_trace_filtered_cursor.jsonl";
  ops.op_write_trace(FILTERED, "");
  const tracer = LiminaTracer.appendOnEmit(THREAD, FILTERED);
  for (let i = 0; i < 3; i++) emitN(tracer, i);
  const before = tracer.workMetrics();
  const miss = tracer.tail({ afterSeq: -1, type: "does.not.match" });
  const afterMiss = tracer.workMetrics();
  assert(miss.events.length === 0 && miss.nextAfterSeq === 2, "filtered miss did not advance its durable cursor");
  tracer.tail({ afterSeq: miss.nextAfterSeq });
  const settled = tracer.workMetrics();
  assert(afterMiss.tailEntriesVisited - before.tailEntriesVisited === 3, "filtered first poll did not visit exactly the new suffix");
  assert(settled.tailEntriesVisited === afterMiss.tailEntriesVisited, "filtered cursor rescanned non-matching events");
}

// ═══ 13. NON-TIMING SCALING: polling work depends on K, never history N. ═══════
{
  const SCALE = "p_studio_trace_non_timing_scale.jsonl";
  const HISTORY = 2048;
  const APPENDED = 7;
  const seed = new LiminaTracer(THREAD, HISTORY + 1);
  for (let i = 0; i < HISTORY; i++) emitN(seed, i);
  ops.op_write_trace(SCALE, seed.exportJsonl());
  const tracer = LiminaTracer.appendOnEmit(THREAD, SCALE, 8);
  const boot = tracer.workMetrics();

  let cursor = HISTORY - 1;
  for (let i = 0; i < 100; i++) {
    const empty = tracer.tail({ afterSeq: cursor, limit: 100, type: "does.not.match" });
    assert(empty.events.length === 0, "unchanged scale poll unexpectedly returned events");
    tracer.replay();
    tracer.durableEventCount();
  }
  const unchanged = tracer.workMetrics();
  assert(unchanged.deltaBytesRead === boot.deltaBytesRead, "unchanged polls reread durable bytes");
  assert(unchanged.linesVerified === boot.linesVerified, "unchanged polls reverified historical lines");
  assert(unchanged.tailEntriesVisited === boot.tailEntriesVisited, "unchanged polls rescanned history");
  assert(unchanged.fullFileReads === 0, "incremental query path performed a full-file read");

  for (let i = 0; i < APPENDED; i++) emitN(tracer, HISTORY + i);
  const beforeTail = tracer.workMetrics();
  const delta = tracer.tail({ afterSeq: cursor, limit: 100 });
  const afterTail = tracer.workMetrics();
  assert(delta.events.length === APPENDED, `scale tail returned ${delta.events.length}, expected ${APPENDED}`);
  assert(beforeTail.linesVerified - unchanged.linesVerified === APPENDED, "K appends did not cost exactly K line verifications");
  assert(beforeTail.deltaBytesRead - unchanged.deltaBytesRead < APPENDED * 1024, "K appends read work scaled beyond the new suffix");
  assert(afterTail.tailEntriesVisited - beforeTail.tailEntriesVisited === APPENDED, "cursor tail visited more than K new entries");
  cursor = delta.nextAfterSeq ?? cursor;

  for (let i = 0; i < 50; i++) tracer.tail({ afterSeq: cursor, limit: 100 });
  const settled = tracer.workMetrics();
  assert(settled.deltaBytesRead === afterTail.deltaBytesRead, "settled polls reread bytes");
  assert(settled.linesVerified === afterTail.linesVerified, "settled polls rehashed events");
  assert(settled.tailEntriesVisited === afterTail.tailEntriesVisited, "settled polls rescanned indexed events");
}

ops.op_log(
  "p_studio_trace_append_replay OK: incremental verified suffix cursor, external-writer convergence, live corruption/replacement fail-closed, " +
    "reopen+torn-tail recovery, mixed-thread authenticated replay, forward causal parity, immutable cached view, ordered ring retention, and non-timing O(new events) scaling gate.",
);
