// Verify the coordinator's SliceBuilder is wired to a REAL `llmff run`: llmff drives the per-slice
// build→gate loop, the REAL limina functional gate runs inside it (op:tool), the loop gates on the
// JSON verdict, and a BROKEN slice is NOT rubber-stamped. Deterministic on the mock backend (no
// provider key). exit 0 = pass · 1 = fail · 2 = skipped (no llmff).
//
// Run: LLMFF_BIN=/path/to/llmff node tools/director/check-slice-builder.mjs
//   (or with llmff on PATH)

import { buildSliceViaLlmff, coordinateViaLlmff, resolveLlmff } from "./slice-builder.mjs";

function fail(m) { console.error("check-slice-builder FAIL: " + m); process.exit(1); }
function skip(m) { console.log("SKIP: " + m); process.exit(2); }

if (!resolveLlmff()) skip("llmff not found (set LLMFF_BIN or install llmff)");

// 1. PASS — a slice whose game passes the gate: llmff drives the loop, the REAL limina gate runs.
const ok = buildSliceViaLlmff({ sliceId: "slice-0", dodIds: ["collect-wins"], gameId: "relic-sprint" });
if (ok.skipped) skip(ok.reason);
if (!ok.ok) fail("llmff run did not exit 0; stderr: " + (ok.stderr || "").slice(0, 400));
if (ok.llmffStatus !== "succeeded") fail("llmff status not 'succeeded': " + ok.llmffStatus);
if (!ok.manifestHash) fail("no manifest hash — llmff did not produce a run record");
if (!ok.verdict) fail("no gate verdict captured from the llmff run");
if (ok.passed !== true) fail("the passing slice must report passed:true; verdict: " + JSON.stringify(ok.verdict));
if (!(ok.verdict.automatedTotal >= 1)) fail("the gate did not actually run an automated DoD; verdict: " + JSON.stringify(ok.verdict));

// 2. FALSIFIABLE — a broken slice: the loop must NOT rubber-stamp.
const bad = buildSliceViaLlmff({ sliceId: "slice-0", dodIds: ["collect-wins"], gameId: "relic-sprint" }, { broken: true });
if (bad.skipped) skip(bad.reason);
if (bad.passed !== false) fail("the BROKEN slice must report passed:false (no rubber-stamp); verdict: " + JSON.stringify(bad.verdict));

// 3. coordinateViaLlmff — the host-side coordinator delegates a plan's slices to llmff.
const plan = { slices: [
  { id: "slice-0", name: "Playable loop", dodIds: ["collect-wins"], gameId: "relic-sprint" },
  { id: "slice-content", name: "Content", dodIds: [] },
] };
const ledger = coordinateViaLlmff(plan);
if (ledger.skipped) skip(ledger.reason);
if (!ledger.passed) fail("coordinateViaLlmff should pass with the real gate; ledger: " + JSON.stringify(ledger.entries));
const s0 = ledger.entries.find((e) => e.sliceId === "slice-0");
if (!s0 || s0.status !== "passed") fail("slice-0 must be gated green via llmff");
const sc = ledger.entries.find((e) => e.sliceId === "slice-content");
if (!sc || sc.status !== "skipped") fail("the content slice must be skipped");

console.log(
  "check-slice-builder OK: the coordinator's SliceBuilder is wired to a real `llmff run` — llmff drove " +
  "the per-slice build->gate loop (status " + ok.llmffStatus + ", manifest " + ok.manifestHash.slice(0, 19) + "…), " +
  "the REAL limina functional gate ran inside it (" + ok.verdict.automatedPassed + "/" + ok.verdict.automatedTotal +
  " DoDs passed), a BROKEN slice correctly reports passed:false (no rubber-stamp), and coordinateViaLlmff gates a " +
  "plan's slices (slice-0 green, content skipped). Mock backend = deterministic; swap mock:good for a real " +
  "provider alias in slice-build.yaml for live codegen.",
);
process.exit(0);
