// P109 — DIRECTOR PIPELINE EVENTS (Chunk D, Slice D2). The planner + coordinator emit
// `director.pipeline.*` events through the OPTIONAL PipelineTrace seam, and the event stream
// must be a faithful, causally-chained account of the returned ledger:
//
//   plan.created → slice.started → gate.report → (slice.failed) → run.halted | run.passed
//
// The gate proves: (1) the emitted sequence matches the ledger EXACTLY (types, slice ids,
// per-DoD failures, error strings); (2) every event is causally chained to its predecessor
// (one tree — what the editor's Activity forest renders); (3) the seam is optional (no trace
// → identical ledger, zero events); (4) FALSIFIABILITY — an event-suppressing shim makes the
// sequence checker FAIL, so the checker cannot rubber-stamp a silent pipeline.
//
// Run: LIMINA_AUDIO=null ./target/release/limina js/test/p109_director_pipeline_events.ts

import { coordinate, type Ledger } from "../src/game/coordinator.ts";
import { planFromGDS, type ArchitecturePlan, type PipelineTrace } from "../src/game/plan.ts";
import type { GameDesignSpec } from "../src/game/gds.ts";
import type { GameUnderTest } from "../src/game/gate.ts";
import { LiminaTracer } from "../src/observability/event.ts";

let pass = 0;
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p109_director_pipeline_events FAIL: " + msg);
  pass++;
}

// ── Fixture GDS: two automated DoDs — one the stub game satisfies, one it cannot ─────────
const GDS = {
  id: "pipeline-events-fixture",
  pitch: "fixture",
  loopSentence: "fixture loop",
  controls: { scheme: "keyboard-mouse", intents: [{ name: "move", binding: "KeyW" }] },
  winCondition: "fixture", loseCondition: "fixture",
  artDirection: "fixture", targetPlatforms: ["desktop"], scopeTier: "prototype",
  optIn: "direct-path",
  entities: [{ id: "player", name: "Player", role: "player", states: [] }],
  mechanics: [
    { id: "move", name: "Move", skill: "known.skill" },
    { id: "warp", name: "Warp", skill: "does.not.exist" },
  ],
  content: [],
  dod: [
    {
      id: "dod-pass", statement: "the game reaches won", kind: "state-transition",
      drives: { steps: [{ repeat: 1 }], assert: [{ check: "gameState", value: "won" }] },
    },
    {
      id: "dod-fail", statement: "an impossible flag is set", kind: "state-transition",
      drives: { steps: [{ repeat: 1 }], assert: [{ check: "flagTrue", target: "impossible" }] },
    },
  ],
} as unknown as GameDesignSpec;

function stubGame(): GameUnderTest {
  return {
    step: () => {},
    playerXZ: () => [0, 0] as const,
    resolveXZ: () => undefined,
    predicate: () => false,
    gameState: () => "won",
    counter: () => 0,
    flag: () => false,
    hp: () => 100,
    questStatus: () => undefined,
  };
}

interface Captured { id: string; type: string; causedBy: string[]; payload: Record<string, unknown> }

/** A PipelineTrace over a real LiminaTracer that also captures locally (id + causal links). */
function capturingTrace(tracer: LiminaTracer, captured: Captured[], causedBy?: string[]): PipelineTrace {
  return {
    causedBy,
    emit: (type, payload, links) => {
      const id = tracer.emit({ type, actorId: "agt_p109", threadId: "ses_p109", parentEventId: null, causedBy: links ?? [], payload });
      captured.push({ id, type, causedBy: links ?? [], payload: payload as Record<string, unknown> });
      return id;
    },
  };
}

/** THE CHECKER under falsifiability test: the captured pipeline events must be a faithful,
 *  causally-chained account of the ledger. Throws on any mismatch. */
function assertEventsMatchLedger(events: Captured[], ledger: Ledger, planCreatedId: string): void {
  // One causal tree: every event's causedBy names the previous pipeline event (the first
  // chains to plan.created).
  let prev = planCreatedId;
  for (const ev of events) {
    if (ev.causedBy.length !== 1 || ev.causedBy[0] !== prev) {
      throw new Error(`event ${ev.type} breaks the causal chain (causedBy ${JSON.stringify(ev.causedBy)}, expected [${prev}])`);
    }
    prev = ev.id;
  }
  // Sequence: per ledger entry — slice.started, then gate.report (gated) or nothing more
  // (skipped) or slice.failed (build error); then exactly one run terminal event.
  let i = 0;
  const next = (): Captured => {
    const ev = events[i++];
    if (ev === undefined) throw new Error("event stream ended before the ledger did");
    return ev;
  };
  for (const entry of ledger.entries) {
    const started = next();
    if (started.type !== "director.pipeline.slice.started" || started.payload.sliceId !== entry.sliceId) {
      throw new Error(`expected slice.started for ${entry.sliceId}, got ${started.type}/${String(started.payload.sliceId)}`);
    }
    if (entry.gate !== undefined) {
      const report = next();
      if (report.type !== "director.pipeline.gate.report" || report.payload.sliceId !== entry.sliceId) {
        throw new Error(`expected gate.report for ${entry.sliceId}, got ${report.type}`);
      }
      if (report.payload.passed !== entry.gate.passed
        || report.payload.automatedPassed !== entry.gate.automatedPassed
        || report.payload.automatedTotal !== entry.gate.automatedTotal) {
        throw new Error(`gate.report totals diverge from the ledger for ${entry.sliceId}`);
      }
      const wantFailures = entry.gate.results.filter((r) => r.status === "failed").map((r) => ({ id: r.id, statement: r.statement, failures: r.failures }));
      if (JSON.stringify(report.payload.failures) !== JSON.stringify(wantFailures)) {
        throw new Error(`gate.report per-DoD failures diverge from the ledger for ${entry.sliceId}`);
      }
    } else if (entry.error !== undefined) {
      const failed = next();
      if (failed.type !== "director.pipeline.slice.failed" || failed.payload.sliceId !== entry.sliceId || failed.payload.error !== entry.error) {
        throw new Error(`expected slice.failed carrying the ledger error for ${entry.sliceId}, got ${failed.type}: ${String(failed.payload.error)}`);
      }
    }
  }
  const terminal = next();
  const wantTerminal = ledger.passed ? "director.pipeline.run.passed" : "director.pipeline.run.halted";
  if (terminal.type !== wantTerminal) throw new Error(`expected ${wantTerminal}, got ${terminal.type}`);
  if (!ledger.passed && terminal.payload.haltedAt !== undefined && terminal.payload.haltedAt !== ledger.haltedAt) {
    throw new Error(`run.halted haltedAt diverges from the ledger`);
  }
  if (i !== events.length) throw new Error(`${events.length - i} extra pipeline events beyond the ledger`);
}

// ── 1. plan.created carries the mapping incl. the previously-silent unknown ──────────────
const tracer = new LiminaTracer("ses_p109");
const planEvents: Captured[] = [];
const plan = planFromGDS(GDS, (name) => name === "known.skill", capturingTrace(tracer, planEvents));
assert(planEvents.length === 1 && planEvents[0].type === "director.pipeline.plan.created", "planFromGDS emits exactly plan.created");
const planPayload = planEvents[0].payload as { unknown: string[]; newWork: string[]; systems: unknown[] };
assert(JSON.stringify(planPayload.unknown) === JSON.stringify(["does.not.exist"]), "plan.created names the unknown mapping: " + JSON.stringify(planPayload.unknown));
assert(planPayload.newWork.length === 1 && planPayload.newWork[0].includes("does.not.exist"), "plan.created carries newWork");
assert(planPayload.systems.length === 2, "plan.created carries the full systems mapping");
const planCreatedId = planEvents[0].id;

// ── 2. one passing + one failing slice: sequence matches the ledger exactly ──────────────
const twoSlicePlan: ArchitecturePlan = {
  ...plan,
  slices: [
    { id: "s-pass", name: "Passing slice", goal: "satisfiable DoD", dodIds: ["dod-pass"] },
    { id: "s-fail", name: "Failing slice", goal: "unsatisfiable DoD", dodIds: ["dod-fail"] },
  ],
};
{
  const events: Captured[] = [];
  const ledger = await coordinate(GDS, twoSlicePlan, stubGame, {}, capturingTrace(tracer, events, [planCreatedId]));
  assert(!ledger.passed && ledger.haltedAt === "s-fail", "the run halts at the failing slice");
  assert(ledger.entries.length === 2 && ledger.entries[0].status === "passed" && ledger.entries[1].status === "failed", "ledger: passed then failed");
  const types = events.map((e) => e.type.replace("director.pipeline.", ""));
  assert(JSON.stringify(types) === JSON.stringify(["slice.started", "gate.report", "slice.started", "gate.report", "run.halted"]),
    "event sequence for pass→fail run: " + JSON.stringify(types));
  assertEventsMatchLedger(events, ledger, planCreatedId); // types + payloads + causal chain
  pass++;

  // ── 4. FALSIFIABILITY: a suppressing shim must make the checker fail ──
  const suppressed = events.filter((e) => e.type !== "director.pipeline.gate.report");
  let checkerFailed = false;
  try {
    assertEventsMatchLedger(suppressed, ledger, planCreatedId);
  } catch {
    checkerFailed = true;
  }
  assert(checkerFailed, "the checker MUST fail when gate.report events are suppressed (falsifiability)");
  const reordered = [...events];
  [reordered[0], reordered[2]] = [reordered[2], reordered[0]];
  let orderFailed = false;
  try {
    assertEventsMatchLedger(reordered, ledger, planCreatedId);
  } catch {
    orderFailed = true;
  }
  assert(orderFailed, "the checker MUST fail on a reordered event stream (causal chain)");
}

// ── 3. build error: the previously-swallowed error string rides slice.failed ─────────────
{
  const events: Captured[] = [];
  const throwingBuilder = (): GameUnderTest => {
    throw new Error("fixture build exploded");
  };
  const ledger = await coordinate(GDS, twoSlicePlan, throwingBuilder, {}, capturingTrace(tracer, events, [planCreatedId]));
  assert(!ledger.passed && ledger.entries[0].error === "fixture build exploded", "the ledger records the build error");
  const types = events.map((e) => e.type.replace("director.pipeline.", ""));
  assert(JSON.stringify(types) === JSON.stringify(["slice.started", "slice.failed", "run.halted"]),
    "event sequence for a build error: " + JSON.stringify(types));
  assert(events[1].payload.error === "fixture build exploded", "slice.failed carries the exact error string");
  assertEventsMatchLedger(events, ledger, planCreatedId);
  pass++;
}

// ── 5. the seam is optional: no trace → identical ledger, and skipped slices chain ───────
{
  const untraced = await coordinate(GDS, twoSlicePlan, stubGame, {});
  const traced = await coordinate(GDS, twoSlicePlan, stubGame, {}, capturingTrace(tracer, [], [planCreatedId]));
  assert(JSON.stringify(untraced) === JSON.stringify(traced), "the trace seam must not change the returned ledger");

  // A skipped (un-gated) slice emits slice.started only, and the run terminal still lands.
  const skippedPlan: ArchitecturePlan = { ...plan, slices: [{ id: "s-content", name: "Content", goal: "no DoDs", dodIds: [] }] };
  const events: Captured[] = [];
  const ledger = await coordinate(GDS, skippedPlan, stubGame, {}, capturingTrace(tracer, events, [planCreatedId]));
  assert(ledger.passed && ledger.entries[0].status === "skipped", "an un-gated slice is skipped");
  const types = events.map((e) => e.type.replace("director.pipeline.", ""));
  assert(JSON.stringify(types) === JSON.stringify(["slice.started", "run.passed"]), "skipped-slice sequence: " + JSON.stringify(types));
  assertEventsMatchLedger(events, ledger, planCreatedId);
  pass++;
}

console.log(`p109_director_pipeline_events OK: ${pass} assertions — plan.created (unknown mappings surfaced), slice.started/gate.report/slice.failed/run.* match the ledger exactly, one causal chain, seam optional, checker proven falsifiable`);
