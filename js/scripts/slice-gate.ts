// SLICE GATE (native limina script) — runs the functional gate for a slice's produced game and
// prints a single machine-readable verdict line for llmff's op:tool stage to consume. The host-side
// run-slice-gate.sh runs this via the limina binary and forwards the verdict to the llmff pipeline.
//
// This is the REAL gate (the same runGate the coordinator uses), against the reference relic-sprint
// game (standing in for the slice's produced game). The verdict is wrapped in a sentinel so the
// shell can extract it from the binary's other stdout.
//
// Run: ./target/release/limina js/scripts/slice-gate.ts

import { ops } from "../src/engine.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import { runGate } from "../src/game/gate.ts";
import { RELIC_SPRINT } from "../src/game/examples/relic_sprint.gds.ts";
import { buildRelicSprintGame } from "../src/game/examples/relic_sprint_game.ts";

let n = 0;
const report = await runGate(RELIC_SPRINT, () => {
  n++;
  return buildRelicSprintGame(createHeadlessContext({ session: `ses_slice_gate_${n}` }));
});

const verdict = {
  passed: report.passed,
  automatedPassed: report.automatedPassed,
  automatedTotal: report.automatedTotal,
  detail: report.passed ? "all automated DoDs passed" : "one or more automated DoDs failed",
};
ops.op_log("__SLICE_VERDICT__" + JSON.stringify(verdict));
