// Phase 3 durable observability: full-history flush, replay verification,
// deterministic partial-line handling, and bounded trace query skills.

import { ops } from "../src/engine.ts";
import {
  LiminaTracer,
  TraceIntegrityError,
  type EngineEvent,
} from "../src/observability/event.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function emitTick(tracer: LiminaTracer, actorId: string, tick: number, causedBy: string[] = [], parentEventId: string | null = null): string {
  return tracer.emit({
    type: tick % 2 === 0 ? "agent.decision.made" : "agent.perception.updated",
    actorId,
    threadId: "ses_p3_trace",
    parentEventId,
    causedBy,
    payload: { tick },
  });
}

function testDurableFlushBeyondMemoryWindow(): void {
  const tracer = new LiminaTracer("ses_p3_trace", 2);
  for (let tick = 0; tick < 5; tick++) emitTick(tracer, "agt_a", tick);

  assert(tracer.inspect().eventCount === 2, "in-memory window should stay bounded");
  const jsonl = tracer.exportJsonl();
  const replay = LiminaTracer.replayJsonl(jsonl);
  assert(replay.events.length === 5, "exportJsonl should include full durable history");

  tracer.flush("p3_trace_durable.jsonl");
  const restarted = LiminaTracer.replayTrace("p3_trace_durable.jsonl");
  assert(restarted.events.length === 5, "replay after restart should load flushed history");
  assert(restarted.events[0]?.payload && (restarted.events[0].payload as { tick: number }).tick === 0, "replay lost first event");

  const restartedTracer = LiminaTracer.fromTrace("p3_trace_durable.jsonl", 2);
  const next = emitTick(restartedTracer, "agt_a", 5);
  assert(next.includes("_000000000005_"), "hydrated tracer should continue the persisted sequence");
  assert(restartedTracer.inspect().eventCount === 2, "hydrated tracer should keep the configured memory window");
  assert(LiminaTracer.replayJsonl(restartedTracer.exportJsonl()).events.length === 6, "hydrated tracer should preserve and extend durable history");
}

function testChainBreakDetection(): void {
  const tracer = new LiminaTracer("ses_p3_trace", 10);
  emitTick(tracer, "agt_a", 0);
  emitTick(tracer, "agt_a", 1);
  const lines = tracer.exportJsonl().trimEnd().split("\n");
  const second = JSON.parse(lines[1] ?? "{}") as EngineEvent;
  second.payload = { tick: 999 };
  lines[1] = JSON.stringify(second);

  let failed = false;
  try {
    LiminaTracer.replayJsonl(lines.join("\n") + "\n");
  } catch (err) {
    failed = err instanceof TraceIntegrityError && err.reason === "hash_mismatch";
  }
  assert(failed, "replay should reject a modified event hash");
}

function testPartialFinalLineHandling(): void {
  const tracer = new LiminaTracer("ses_p3_trace", 10);
  emitTick(tracer, "agt_a", 0);
  emitTick(tracer, "agt_a", 1);
  const full = tracer.exportJsonl();
  assert(LiminaTracer.replayJsonl(full.trimEnd()).events.length === 2, "valid JSONL without trailing newline should replay");
  const partial = full + "{\"id\":\"evt_partial\"";

  const lenient = LiminaTracer.replayJsonl(partial, { onPartialFinalLine: "ignore" });
  assert(lenient.events.length === 2, "lenient replay should ignore only the final partial line");
  assert(lenient.partialFinalLine !== undefined, "lenient replay should report the ignored partial line");

  let failed = false;
  try {
    LiminaTracer.replayJsonl(partial);
  } catch (err) {
    failed = err instanceof TraceIntegrityError && err.reason === "partial_final_line";
  }
  assert(failed, "strict replay should report incomplete final line");
}

async function testTraceQuerySkills(): Promise<void> {
  const tracer = new LiminaTracer("ses_p3_trace", 10);
  const ctx = createHeadlessContext({ tracer, session: "ses_p3_trace", agentId: "agt_debugger", profile: "system.readonly" });
  const world = ctx.world;
  const registry = ctx.registry;

  const first = emitTick(tracer, "agt_a", 0);
  const second = emitTick(tracer, "agt_a", 1, [first]);
  emitTick(tracer, "agt_b", 2);
  const fourth = emitTick(tracer, "agt_a", 3, [], second);

  const base = {
    agentId: "agt_debugger",
    sessionId: "ses_p3_trace",
    permissions: resolveProfile("system.readonly"),
    tick: 4,
    world,
  };

  const tail = await registry.invoke("trace.tail", { afterSeq: 0, limit: 2, actorId: "agt_a" }, base);
  assert(tail.success, "trace.tail should succeed");
  const tailResult = tail.result as { events: EngineEvent[]; nextAfterSeq: number | null };
  assert(tailResult.events.length === 2, "trace.tail should paginate after sequence");
  assert(tailResult.events[0]?.id === second && tailResult.events[1]?.id === fourth, "trace.tail actor filter/order failed");
  assert(tailResult.nextAfterSeq === 3, "trace.tail next cursor should be last returned sequence");

  const explain = await registry.invoke("trace.explainEvent", { eventId: second }, base);
  assert(explain.success, "trace.explainEvent should succeed");
  const explainResult = explain.result as { event: EngineEvent; parents: EngineEvent[]; children: EngineEvent[] };
  assert(explainResult.event.id === second, "explain returned wrong event");
  assert(explainResult.parents.map((e) => e.id).includes(first), "explain missing parent");
  assert(explainResult.children.map((e) => e.id).includes(fourth), "explain missing child");

  const exported = await registry.invoke("trace.export", { name: "p3_trace_skill_export.jsonl" }, base);
  assert(exported.success, "trace.export should succeed");
  const exportedResult = exported.result as { name: string; events: number };
  assert(exportedResult.name === "p3_trace_skill_export.jsonl", "trace.export returned wrong name");
  assert(exportedResult.events === 6, "trace.export should report durable event count before export self-event");
  assert(ops.op_read_trace("p3_trace_skill_export.jsonl").trimEnd().split("\n").length === 6, "trace.export file event count");
}

testDurableFlushBeyondMemoryWindow();
testChainBreakDetection();
testPartialFinalLineHandling();
await testTraceQuerySkills();

ops.op_log("P3 trace durable OK: flush, replay, integrity, partial-line handling, tail, explain, export");
