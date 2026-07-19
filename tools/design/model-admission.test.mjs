import assert from "node:assert/strict";
import test from "node:test";
import { DesignModelAdmission } from "./model-admission.mjs";

test("bounds model prompt bytes, concurrency, and request rate", () => {
  let now = 0;
  const gate = new DesignModelAdmission({
    nowMs: () => now,
    maxInFlight: 2,
    burst: 2,
    refillIntervalMs: 100,
    maxMessageBytes: 8,
    maxHistoryBytes: 16,
  });
  assert.equal(gate.acquire("😀😀x", []).code, "message_too_large");
  assert.equal(gate.acquire("ok", [{ content: "0123456789" }]).code, "history_too_large");
  const a = gate.acquire("a", []), b = gate.acquire("b", []);
  assert(a.ok && b.ok);
  assert.equal(gate.acquire("c", []).code, "provider_busy");
  a.release(); a.release(); b.release();
  assert.equal(gate.snapshot().inFlight, 0);
  assert.equal(gate.acquire("d", []).code, "rate_limited");
  now = 100;
  const refilled = gate.acquire("e", []);
  assert(refilled.ok);
  refilled.release();
});

test("rejects circular history without throwing", () => {
  const gate = new DesignModelAdmission();
  const history = []; history.push(history);
  assert.equal(gate.acquire("ok", history).code, "invalid_history");
});
