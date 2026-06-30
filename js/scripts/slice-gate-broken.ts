// SLICE GATE (BROKEN variant) — identical to slice-gate.ts but builds the relic-sprint game with
// the win transition omitted, so the functional gate goes RED. Used to prove the llmff slice-build
// loop is FALSIFIABLE: a slice whose game fails the gate yields passed:false (the loop does not
// rubber-stamp).
//
// Run: ./target/release/limina js/scripts/slice-gate-broken.ts

import { ops } from "../src/engine.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import { runGate } from "../src/game/gate.ts";
import { RELIC_SPRINT } from "../src/game/examples/relic_sprint.gds.ts";
import { buildRelicSprintGame } from "../src/game/examples/relic_sprint_game.ts";

let n = 0;
const report = await runGate(RELIC_SPRINT, () => {
  n++;
  return buildRelicSprintGame(createHeadlessContext({ session: `ses_slice_gate_broken_${n}` }), { broken: true });
});

const verdict = {
  passed: report.passed,
  automatedPassed: report.automatedPassed,
  automatedTotal: report.automatedTotal,
  detail: report.passed ? "all automated DoDs passed" : "one or more automated DoDs failed",
};
ops.op_log("__SLICE_VERDICT__" + JSON.stringify(verdict));
