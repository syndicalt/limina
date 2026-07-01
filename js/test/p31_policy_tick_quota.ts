// P31 -- the sliding-window policy quota is driven by ctx.tick (deterministic sim
// time), NOT wall-clock (headless, deterministic, falsifiable). Locks in the fix:
// PolicyEngine.windowHits prunes by `nowTick - windowMs` over the recorded tick, so a
// recorded decision sequence REPLAYS to the SAME allow/deny vector regardless of how
// much REAL time elapses between calls. A Date.now()-driven window would (a) make the
// same tick sequence flaky under different wall-clock spacing and (b) diverge on replay.
//
// What this pins (windowMs is measured in TICKS, per engine.ts):
//   A. BUNCHED at one tick: with limit L, the (L+1)th call at the SAME tick is DENIED
//      (rule quota.exceeded, used >= limit) -- the window counts hits by tick.
//   B. WINDOW SLIDES BY TICK: after the window's worth of TICKS passes, an earlier
//      hit expires and a call is allowed again -- even with zero wall-clock delay.
//   C. SPREAD ACROSS WINDOWS, back-to-back in WALL time: L+1 calls each more than
//      windowMs TICKS apart are ALL allowed. A wall-clock quota (all fired within
//      milliseconds) would count them in one real window and deny the last -> the
//      all-allow result is only possible for a tick-driven window.
//   D. DETERMINISTIC REPLAY: the SAME tick sequence yields the SAME allow/deny vector
//      whether run instantly, run again, OR run with REAL op_sleep_ms delays injected
//      between calls. If the window read Date.now(), case E's ~160ms of injected sleeps
//      (> windowMs=100) would expire the same-tick hits and let the final call through,
//      diverging from the no-sleep run -- the equality assertions would then fail.
//   E. WALL-CLOCK IMMUNITY (the sharpest falsifier): 4 same-tick calls spaced by real
//      40ms sleeps (~160ms total, > windowMs=100) STILL deny the 4th -- real elapsed
//      time exceeding the window does not expire a tick-indexed hit.
//
// Run: limina js/test/p31_policy_tick_quota.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import { PolicyEngine, type PolicyContext } from "../src/policy/engine.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p31_policy_tick_quota: " + msg);
}

const LIMIT = 3;
const WINDOW = 100; // TICKS

function freshEngine(limit = LIMIT): PolicyEngine {
  // A quota with no permission requirement: only the quota gates the crossing.
  return new PolicyEngine().setQuota({ cap: "act", perSession: true, limit, windowMs: WINDOW });
}
function ctxAt(tick: number): PolicyContext {
  return { boundary: "registry", agentId: "a", sessionId: "s", cap: "act", tick };
}

/** Run a tick sequence through a FRESH engine; return the allow vector. Optionally
 *  inject a REAL wall-clock sleep between calls (to prove wall-clock immunity). */
async function runSeq(ticks: number[], sleepMsBetween = 0): Promise<boolean[]> {
  const eng = freshEngine();
  const out: boolean[] = [];
  for (let i = 0; i < ticks.length; i++) {
    out.push(eng.evaluate(ctxAt(ticks[i])).allow);
    if (sleepMsBetween > 0 && i < ticks.length - 1) await ops.op_sleep_ms(sleepMsBetween);
  }
  return out;
}

// ===========================================================================
// A. BUNCHED at one tick -> the (L+1)th is DENIED with rule quota.exceeded.
// ===========================================================================
const engA = freshEngine();
const decA: ReturnType<PolicyEngine["evaluate"]>[] = [];
for (let i = 0; i < LIMIT + 1; i++) decA.push(engA.evaluate(ctxAt(10)));
for (let i = 0; i < LIMIT; i++) assert(decA[i].allow, `A: call ${i + 1}/${LIMIT} at the same tick must be allowed`);
const overA = decA[LIMIT];
assert(!overA.allow && overA.rule === "quota.exceeded", "A: the (L+1)th same-tick call must be DENIED with rule quota.exceeded");
assert(overA.quota !== undefined && overA.quota.used >= overA.quota.limit,
  "A: the denied decision's quota snapshot must show exhaustion (used >= limit)");

// ===========================================================================
// B. WINDOW SLIDES BY TICK: after > WINDOW ticks the earliest hit expires.
// ===========================================================================
const engB = freshEngine(2);
assert(engB.evaluate(ctxAt(0)).allow, "B: 1st hit at tick 0 allowed");
assert(engB.evaluate(ctxAt(0)).allow, "B: 2nd hit at tick 0 allowed (limit 2)");
assert(!engB.evaluate(ctxAt(0)).allow, "B: 3rd hit at tick 0 must be DENIED (window full)");
assert(engB.evaluate(ctxAt(WINDOW + 1)).allow,
  "B: a call WINDOW+1 ticks later must be ALLOWED -- the tick-0 hits have slid out of the window");

// ===========================================================================
// C. SPREAD across windows, back-to-back in WALL time -> ALL allowed. A wall-clock
//    quota would count these four within one real millisecond-window and deny the last.
// ===========================================================================
const spread = await runSeq([0, WINDOW * 2, WINDOW * 4, WINDOW * 6]); // each > WINDOW ticks apart
assert(spread.every((a) => a === true),
  `C: calls spaced > windowMs TICKS apart must ALL be allowed (a wall-clock window would deny the last); got ${JSON.stringify(spread)}`);

// ===========================================================================
// D + E. DETERMINISTIC REPLAY + WALL-CLOCK IMMUNITY. The SAME tick sequence gives the
//    SAME allow vector run instantly, run again, and run with REAL sleeps injected.
// ===========================================================================
const bunched = [10, 10, 10, 10]; // four calls at ONE tick; the 4th exhausts limit=3
const runInstant1 = await runSeq(bunched);
const runInstant2 = await runSeq(bunched);
const runSlept = await runSeq(bunched, 40); // ~160ms real total, > windowMs=100 (E)

const EXPECT = [true, true, true, false];
assert(JSON.stringify(runInstant1) === JSON.stringify(EXPECT), `D: unexpected allow vector ${JSON.stringify(runInstant1)}`);
assert(JSON.stringify(runInstant2) === JSON.stringify(runInstant1), "D: a second identical replay diverged (non-determinism)");
assert(JSON.stringify(runSlept) === JSON.stringify(runInstant1),
  `E: injecting ~160ms of real sleeps (> windowMs=100) changed the decisions ${JSON.stringify(runSlept)} -- the window is reading WALL-CLOCK, not ctx.tick`);

// A representative MIXED sequence: same replay determinism across wall-clock spacing.
const mixed = [5, 5, 5, 5, WINDOW * 3, WINDOW * 3];
const mixedInstant = await runSeq(mixed);
const mixedSlept = await runSeq(mixed, 25);
assert(JSON.stringify(mixedInstant) === JSON.stringify([true, true, true, false, true, true]),
  `D: mixed sequence gave an unexpected vector ${JSON.stringify(mixedInstant)}`);
assert(JSON.stringify(mixedSlept) === JSON.stringify(mixedInstant),
  "E: the mixed sequence diverged under real sleeps -- a Date.now() leak would make the quota flaky");

ops.op_log(
  "p31_policy_tick_quota OK: the sliding-window quota is driven by ctx.tick -- the (L+1)th same-tick call is denied (quota.exceeded); " +
    "the window slides after WINDOW ticks; calls spaced > WINDOW ticks apart are all allowed even back-to-back in wall time; " +
    "and the SAME tick sequence replays to the SAME allow/deny vector instantly, on a second run, and with ~160ms of real sleeps injected " +
    "(> windowMs=100) -- a wall-clock window would diverge, proving no Date.now leak.",
);
