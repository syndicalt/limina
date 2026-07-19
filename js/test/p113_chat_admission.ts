import { ChatAdmissionGate, type ChatAdmissionLimits } from "../src/agents/chat-admission.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p113_chat_admission FAIL: ${message}`);
}

let now = 1_000;
const limits: ChatAdmissionLimits = {
  maxTextBytes: 8,
  maxInFlightPerSession: 2,
  maxGlobalInFlight: 3,
  burst: 2,
  refillIntervalMs: 100,
  maxTrackedSessions: 2,
  idleSessionTtlMs: 500,
};
const gate = new ChatAdmissionGate(() => now, limits);

const multibyte = gate.acquire("utf8", "😀😀x");
assert(!multibyte.ok && multibyte.code === "text_too_large", "text cap did not count UTF-8 bytes before admission");
assert(gate.snapshot().sessions === 0, "oversized text allocated session state");

const a1 = gate.acquire("a", "one");
const a2 = gate.acquire("a", "two");
assert(a1.ok && a2.ok, "burst/concurrency reservations were not admitted");
const busy = gate.acquire("a", "three");
assert(!busy.ok && busy.code === "session_busy", "per-session semaphore did not fail closed");
const b1 = gate.acquire("b", "one");
assert(b1.ok, "second session did not reach global capacity");
const globalBusy = gate.acquire("b", "two");
assert(!globalBusy.ok && globalBusy.code === "server_busy", "global semaphore did not fail closed");

a1.release();
a1.release();
assert(gate.snapshot().globalInFlight === 2, "lease release was not idempotent");
const depleted = gate.acquire("a", "four");
assert(!depleted.ok && depleted.code === "rate_limited" && depleted.retryAfterMs === 100,
  "accepted turns did not consume a non-refundable token-bucket reservation");

now += 100;
const refilled = gate.acquire("a", "five");
assert(refilled.ok, "monotonic token refill did not admit one turn");
a2.release(); b1.release(); refilled.release();

const full = gate.acquire("c", "one");
assert(!full.ok && full.code === "session_capacity", "tracked-session cap did not reject live/recent state");
now += 500;
const evicted = gate.acquire("c", "one");
assert(evicted.ok, "idle session state was not evicted at capacity");
evicted.release();

console.log("p113_chat_admission OK: UTF-8 cap, per-session/global semaphores, token bucket, idempotent release, bounded session table");
