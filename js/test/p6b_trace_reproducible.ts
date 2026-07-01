// P6b -- TRACE REPRODUCIBILITY (the sha256 integrity chain is a pure function of
// the command stream, headless).
//
// The integrity hash used to fold in each event's wall-clock `timestamp`, so two
// replays of the SAME logical events produced DIFFERENT hash chains -- breaking
// bit-identical replay and the determinism-first contract. This test pins the
// fix as a REAL proof: it STUBS the wall clock so the two runs carry DEMONSTRABLY
// different timestamps (run A at T0, run B at T1 != T0), emits a FIXED sequence of
// events through two independent, freshly constructed tracers, then asserts BOTH:
//   (a) the exported per-event `timestamp` fields actually DIFFER between the runs
//       (proving the clock stub took effect -- a display timestamp still rides on
//       each line), AND
//   (b) the exported integrity.hash chains are nonetheless BYTE-IDENTICAL (the
//       differing wall-clock does not leak into the hash).
// Because the timestamps provably differ, this cannot pass vacuously: if a future
// change re-folded `timestamp` into the hash, (b) would fail.

import { LiminaTracer, type EmitInput } from "../src/observability/event.ts";
import { ops } from "../src/engine.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p6b_trace_reproducible: " + message);
}

const THREAD = "ses_p6b_reproducible";

// A fixed, timestamp-free sequence of events (the id, type, actorId, payload,
// causal links are all stable; only wall-clock differs between runs).
const FIXED_EVENTS: EmitInput[] = [
  { type: "session.start", actorId: "limina:builder", threadId: THREAD, parentEventId: null, causedBy: [], payload: { seed: 0x5ea3c047 } },
  { type: "scene.createEntity", actorId: "limina:builder", threadId: THREAD, parentEventId: null, causedBy: [], payload: { shape: "sphere", size: 1.0, position: [0, 4, 0] } },
  { type: "physics.applyImpulse", actorId: "limina:builder", threadId: THREAD, parentEventId: null, causedBy: [], payload: { entity: "ent_ball", impulse: [-0.5, 0, 0.25] } },
  { type: "physics.step", actorId: "limina:sim", threadId: THREAD, parentEventId: null, causedBy: [], payload: { tick: 1 } },
];

function emitFixedTrace(): string {
  const tracer = new LiminaTracer(THREAD);
  for (const e of FIXED_EVENTS) tracer.emit(e);
  return tracer.exportJsonl();
}

interface HashedLine {
  hash: string;
  timestamp: string;
}

function hashChain(jsonl: string): HashedLine[] {
  return jsonl.split("\n").filter((l) => l.length > 0).map((line, i) => {
    const ev = JSON.parse(line) as { integrity?: { hash?: unknown }; timestamp?: unknown };
    assert(ev.integrity !== undefined && typeof ev.integrity.hash === "string", `line ${i + 1} missing integrity.hash`);
    assert(typeof ev.timestamp === "string" && ev.timestamp.length > 0, `line ${i + 1} missing human-readable timestamp field`);
    return { hash: ev.integrity.hash, timestamp: ev.timestamp };
  });
}

// ---- Stub the wall clock so the two runs carry DIFFERENT timestamps --------
// `emit` stamps each event with `new Date().toISOString()`; monkeypatch
// `globalThis.Date` so run A's clock reads T0 and run B's reads T1 (T1 != T0).
// This makes the "wall-clock does not leak into the hash" claim falsifiable: the
// exported timestamps provably differ between the runs.
const REAL_DATE = globalThis.Date;
const T0 = "2020-01-01T00:00:00.000Z";
const T1 = "2021-06-15T12:34:56.789Z";

function withStubbedClock(iso: string, fn: () => string): string {
  class StubDate {
    toISOString(): string {
      return iso;
    }
  }
  (globalThis as { Date: unknown }).Date = StubDate;
  try {
    return fn();
  } finally {
    (globalThis as { Date: unknown }).Date = REAL_DATE;
  }
}

// ---- Run the SAME event stream through two independent fresh tracers --------
const firstJsonl = withStubbedClock(T0, emitFixedTrace);
const secondJsonl = withStubbedClock(T1, emitFixedTrace);

// The real Date must be back in place before any assertions run.
assert(globalThis.Date === REAL_DATE, "real Date was not restored after the clock stub");

const firstChain = hashChain(firstJsonl);
const secondChain = hashChain(secondJsonl);

assert(firstChain.length === FIXED_EVENTS.length, `expected ${FIXED_EVENTS.length} hashed lines, got ${firstChain.length}`);
assert(secondChain.length === firstChain.length, "the two runs produced a different number of lines");

// (a) The clock stub took effect: every exported timestamp differs between the
//     two runs (run A stamped T0, run B stamped T1). Without this the hash-parity
//     check below would be a vacuous guard.
for (let i = 0; i < firstChain.length; i++) {
  assert(firstChain[i].timestamp === T0, `run A event ${i} timestamp ${firstChain[i].timestamp} != stubbed ${T0} (clock stub did not take effect)`);
  assert(secondChain[i].timestamp === T1, `run B event ${i} timestamp ${secondChain[i].timestamp} != stubbed ${T1} (clock stub did not take effect)`);
  assert(firstChain[i].timestamp !== secondChain[i].timestamp, `event ${i} timestamps did not differ between runs -- the wall-clock proof is vacuous`);
}

// (b) The hash chains must be byte-identical across runs DESPITE the differing
//     timestamps (no wall-clock leakage into the integrity hash).
for (let i = 0; i < firstChain.length; i++) {
  assert(firstChain[i].hash === secondChain[i].hash, `hash chain diverged at event ${i}: ${firstChain[i].hash} != ${secondChain[i].hash} (wall-clock leaked into the integrity hash)`);
}

// Guard against a trivial pass: the fixed events warm distinct hashes (a chain
// of identical hashes would mean the payload/prev-hash fold is not engaged).
const distinct = new Set(firstChain.map((l) => l.hash));
assert(distinct.size === firstChain.length, "expected each event to produce a distinct chained hash");

ops.op_log(
  `p6b_trace_reproducible OK: two runs of ${FIXED_EVENTS.length} events with PROVABLY DIFFERENT ` +
    `wall-clock timestamps (${T0} vs ${T1}) produced BYTE-IDENTICAL integrity hash chains ` +
    `(head ${firstChain[0].hash}); exported lines still carry the differing human-readable ` +
    `timestamp field (display only, not hashed)`,
);
