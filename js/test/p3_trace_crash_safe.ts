// Phase 3 trace durability policy: append-on-emit recovery after torn writes.

import { ops } from "../src/engine.ts";
import { LiminaTracer } from "../src/observability/event.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function emitTick(tracer: LiminaTracer, tick: number, parentEventId: string | null = null): string {
  return tracer.emit({
    type: "trace.crash-safe.tick",
    actorId: "agt_trace",
    threadId: "ses_p3_trace_crash",
    parentEventId,
    causedBy: [],
    payload: { tick },
  });
}

function ticks(tracer: LiminaTracer): number[] {
  return LiminaTracer
    .replayJsonl(tracer.exportJsonl())
    .events
    .map((ev) => (ev.payload as { tick: number }).tick);
}

function testAppendOnEmitPersistsWithoutExplicitFlush(): void {
  ops.op_write_trace("p3_trace_crash_append.jsonl", "");
  const tracer = LiminaTracer.appendOnEmit("ses_p3_trace_crash", "p3_trace_crash_append.jsonl", 2);
  emitTick(tracer, 0);
  const first = emitTick(tracer, 1);
  emitTick(tracer, 2, first);

  const persisted = LiminaTracer.replayTrace("p3_trace_crash_append.jsonl");
  assert(persisted.events.length === 3, "append-on-emit should persist each event without explicit flush");
  assert(tracer.inspect().eventCount === 2, "append-on-emit should preserve bounded in-memory window");

  const restarted = LiminaTracer.appendOnEmit("ses_p3_trace_crash", "p3_trace_crash_append.jsonl", 2);
  const next = emitTick(restarted, 3);
  assert(next.includes("_000000000003_"), "restart hydration should continue persisted sequence");
  assert(ticks(restarted).join(",") === "0,1,2,3", "restart hydration should preserve and extend complete history");
}

function testAppendOnEmitRecoversTornFinalWrite(): void {
  ops.op_write_trace("p3_trace_crash_torn.jsonl", "");
  const tracer = LiminaTracer.appendOnEmit("ses_p3_trace_crash", "p3_trace_crash_torn.jsonl", 10);
  const first = emitTick(tracer, 0);
  emitTick(tracer, 1, first);
  const complete = ops.op_read_trace("p3_trace_crash_torn.jsonl");
  ops.op_write_trace("p3_trace_crash_torn.jsonl", complete + "{\"id\":\"evt_torn\"");

  const recovered = LiminaTracer.appendOnEmit("ses_p3_trace_crash", "p3_trace_crash_torn.jsonl", 10);
  assert(ticks(recovered).join(",") === "0,1", "hydration should ignore only the torn final line");
  const next = emitTick(recovered, 2);
  assert(next.includes("_000000000002_"), "recovered tracer should continue after last complete event");

  const persisted = ops.op_read_trace("p3_trace_crash_torn.jsonl");
  assert(!persisted.includes("evt_torn"), "recovery should truncate the torn final line before appending");
  assert(LiminaTracer.replayTrace("p3_trace_crash_torn.jsonl").events.length === 3, "recovered trace should replay with an intact hash chain");
}

testAppendOnEmitPersistsWithoutExplicitFlush();
testAppendOnEmitRecoversTornFinalWrite();

ops.op_log("P3 trace crash-safe OK: append-on-emit, torn final write recovery, restart hydration");
