// Trace-flushing fixture for the EventLoom bridge round-trip test.
//
// Runs INSIDE the limina engine binary (`./target/debug/limina js/test/...`) so
// the durable trace it flushes is genuine LiminaTracer output — real FNV ids,
// real sha256 integrity chain, real EventLoom envelope — NOT hand-faked JSON.
// It emits a small, explicitly causally-linked world-event chain so the bridge
// round-trip can assert that ids + parentEventId + causedBy survive ingest.

import { LiminaTracer } from "../src/observability/event.ts";
import { ops } from "../src/engine.ts";

const TRACE_NAME = "eventloom_bridge_src.jsonl";
const THREAD = "ses_limina_world";
const ACTOR = "agt_world";

const tracer = new LiminaTracer(THREAD);

// A: genesis world event (no parent, no cause).
const a = tracer.emit({
  type: "skill.executed",
  actorId: ACTOR,
  threadId: THREAD,
  parentEventId: null,
  causedBy: [],
  payload: { skill: "spawn_billiards", tick: 0 },
});

// B: a decision caused by A (parent = A, causedBy = [A]).
const b = tracer.emit({
  type: "agent.decision.made",
  actorId: ACTOR,
  threadId: THREAD,
  parentEventId: a,
  causedBy: [a],
  payload: { decision: "break", confidence: 0.91, tick: 1 },
});

// C: a physics collision caused by both A and B (parent = B, causedBy = [A, B]).
const c = tracer.emit({
  type: "physics.collision",
  actorId: ACTOR,
  threadId: THREAD,
  parentEventId: b,
  causedBy: [a, b],
  payload: { bodies: [1, 7], impulse: 3.2, tick: 2 },
});

const result = tracer.flush(TRACE_NAME);
ops.op_log(
  "EVENTLOOM_PRODUCER " +
    JSON.stringify({ trace: result.name, events: result.events, ids: { a, b, c } }),
);
