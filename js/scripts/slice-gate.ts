// SLICE GATE (native limina script) — runs the functional gate for the game a SLICE selects, and
// prints a single machine-readable verdict line for llmff's op:tool stage. The host shim
// (run-slice-gate.sh) writes the slice's target { gameId, broken } into a trace the sandbox reads
// (op_read_trace), so the game is DATA-DRIVEN, not hardcoded. Defaults to relic-sprint.
//
// Run: ./target/release/limina js/scripts/slice-gate.ts

import { ops } from "../src/engine.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import { runGate } from "../src/game/gate.ts";
import { getGame } from "../src/game/examples/games.ts";

function emit(v: { passed: boolean; automatedPassed: number; automatedTotal: number; detail: string }): void {
  ops.op_log("__SLICE_VERDICT__" + JSON.stringify(v));
}

// The slice's target is written by the host shim into traces/slice-target (a JSON the sandbox can read).
let gameId = "relic-sprint";
let broken = false;
try {
  const raw = ops.op_read_trace("slice-target");
  if (raw && raw.length > 0) {
    const t = JSON.parse(raw) as { gameId?: string; broken?: boolean };
    if (typeof t.gameId === "string" && t.gameId.length > 0) gameId = t.gameId;
    broken = t.broken === true;
  }
} catch {
  /* no target trace → defaults */
}

const game = getGame(gameId);
if (game === undefined) {
  emit({ passed: false, automatedPassed: 0, automatedTotal: 0, detail: `unknown game "${gameId}"` });
} else {
  let n = 0;
  const report = await runGate(game.gds, () => {
    n++;
    return game.build(createHeadlessContext({ session: `ses_slice_${gameId}_${n}` }), { broken });
  });
  emit({
    passed: report.passed,
    automatedPassed: report.automatedPassed,
    automatedTotal: report.automatedTotal,
    detail: report.passed ? "all automated DoDs passed" : "one or more automated DoDs failed",
  });
}
