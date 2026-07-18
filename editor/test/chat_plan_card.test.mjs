// LIMITATION (known, accepted): this is a SOURCE-TEXT wiring test — it asserts exact
// code fragments in editor/src/chat.js (+ styles.css) instead of executing them
// (execution needs a real DOM; chat.js touches document at module top). It can FAIL
// on a harmless rename and stay GREEN through a logic inversion the grepped fragments
// survive. A green here is a wiring check, never a behavioral verdict.
//
// CONTRACT UNDER TEST (Chunk D, Slice D3): a successful gds.plan tool result renders
// as a structured PLAN CARD — slices, mechanic→skill mapping chips colored by status
// (existing/new/unknown), and the gap report — instead of prose/JSON.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [chat, css] = await Promise.all([
  readFile(new URL("../src/chat.js", import.meta.url), "utf8"),
  readFile(new URL("../styles.css", import.meta.url), "utf8"),
]);

test("a gds.plan ok step routes to the plan card, not a chip", () => {
  assert.match(chat, /step\.tool === "gds\.plan" && step\.status === "ok" && step\.result/);
  assert.match(chat, /return renderPlanCard\(step\.result\)/);
});

test("the plan card renders slices with their gate status", () => {
  assert.match(chat, /chat-plan-slice-name/);
  assert.match(chat, /chat-plan-slice-goal/);
  assert.match(chat, /DoD/);
  assert.match(chat, /not auto-gated/);
});

test("mechanic→skill mappings render as status-colored chips", () => {
  assert.match(chat, /chat-plan-mapping chat-plan-mapping-\$\{m\.status\}/);
  assert.match(chat, /\$\{m\.mechanicName\} → \$\{m\.skill\}/);
  for (const cls of [".chat-plan-mapping-existing", ".chat-plan-mapping-new", ".chat-plan-mapping-unknown"]) {
    assert.ok(css.includes(cls), `styles.css must style ${cls}`);
  }
});

test("the gap report and new-work list render on the card", () => {
  assert.match(chat, /result\.gaps/);
  assert.match(chat, /chat-plan-gap/);
  assert.match(chat, /result\.newWork/);
  assert.match(chat, /chat-plan-newwork-item/);
  assert.match(chat, /result\.issues/);
});

test("the card is styled", () => {
  for (const cls of [".chat-plan-card", ".chat-plan-title", ".chat-plan-slices", ".chat-plan-gaps"]) {
    assert.ok(css.includes(cls), `styles.css must style ${cls}`);
  }
});
