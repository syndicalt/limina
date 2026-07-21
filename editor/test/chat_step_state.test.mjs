// LIMITATION (known, accepted): this is a SOURCE-TEXT wiring test — it asserts exact
// code fragments in editor/src/chat.js (+ styles.css) instead of executing them
// (execution needs a real DOM; chat.js touches document at module top). It can FAIL
// on a harmless rename and stay GREEN through a logic inversion the grepped fragments
// survive. A green here is a wiring check, never a behavioral verdict.
//
// CONTRACT UNDER TEST (Chunk D, Slice D1): the chat panel renders tool-call steps
// with their server-pushed outcome — ok / failed / held / rejected — so a failed
// agent tool call can never read as silence; a held step links the user to the
// Approval accordion; a bound-cut turn's terminal reason is surfaced on chat.done.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [chat, css] = await Promise.all([
  readFile(new URL("../src/chat.js", import.meta.url), "utf8"),
  readFile(new URL("../styles.css", import.meta.url), "utf8"),
]);

test("chat.step pushes carry tool + status + detail into turn state, upgrading the pending chip", () => {
  // The handler must read every contract field off the push.
  for (const field of ["msg.tool", "msg.status", "msg.detail", "msg.result"]) {
    assert.ok(chat.includes(field), `onChatMessage must read ${field}`);
  }
  // Completion steps upgrade the matching pending (status-less) chip in place.
  assert.match(chat, /find\(\(s\) => s\.tool === step\.tool && !s\.status\)/);
  assert.match(chat, /Object\.assign\(pending, \{ status: step\.status, detail: step\.detail, result: step\.result \}\)/);
});

test("all four step states render with distinct glyphs and status classes", () => {
  assert.match(chat, /STEP_STATUS_GLYPHS = \{ ok: "✓", failed: "✕", held: "⏸", rejected: "⊘" \}/);
  assert.match(chat, /chat-step-\$\{step\.status\}/);
  for (const cls of [".chat-step-ok", ".chat-step-failed", ".chat-step-held", ".chat-step-rejected"]) {
    assert.ok(css.includes(cls), `styles.css must style ${cls}`);
  }
});

test("a held step links the user to the Approval accordion", () => {
  assert.match(chat, /step\.status === "held"/);
  assert.match(chat, /Review in Approval/);
  assert.match(chat, /data-acc-toggle="approval"/);
  assert.ok(css.includes(".chat-step-approval-link"), "the approval link is styled");
});

test("failures are surfaced, not folded away", () => {
  // The steps summary counts failed/rejected + held, and auto-opens on either.
  assert.match(chat, /s\.status === "failed" \|\| s\.status === "rejected"/);
  assert.match(chat, /if \(failed \|\| held\) details\.open = true/);
});

test("a bound-cut turn's terminal reason is surfaced on chat.done", () => {
  assert.match(chat, /msg\.reason && !turn\.text/);
  assert.match(chat, /stopped without a reply \(\$\{msg\.reason\}\)/);
});
