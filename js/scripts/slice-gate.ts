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

// Per-run nonce from the host shim: stamped into the verdict sentinel so the shim can reject a
// STATICALLY pre-printed sentinel (game text can't know the nonce). It is NOT full unforgeability:
// the nonce is also carried in the target trace, which in-VM code can read via op_read_trace, so
// untrusted code could emit a matching line — the shim additionally takes the LAST nonced line
// (tail -1), and this gate emits its verdict LAST (after the build below), so the gate's own emit
// wins. Prefer the environment (env-capable hosts); the native runtime exposes no env API, so the
// nonce is also carried in the target trace below. When absent (back-compat), the sentinel is bare.
let nonce: string | undefined;
try {
  const g = globalThis as { Deno?: { env?: { get(k: string): string | undefined } } };
  const v = g.Deno?.env?.get?.("SLICE_VERDICT_NONCE");
  if (v && v.length > 0) nonce = v;
} catch {
  /* env not available on this host → fall back to the target-trace nonce */
}

function emit(v: { passed: boolean; automatedPassed: number; automatedTotal: number; detail: string }): void {
  const tag = nonce !== undefined ? "__SLICE_VERDICT__" + nonce + "__" : "__SLICE_VERDICT__";
  ops.op_log(tag + JSON.stringify(v));
}

// The slice's target is written by the host shim into traces/slice-target (a JSON the sandbox can read).
let gameId = "relic-sprint";
let broken = false;
try {
  const raw = ops.op_read_trace("slice-target");
  if (raw && raw.length > 0) {
    const t = JSON.parse(raw) as { gameId?: string; broken?: boolean; nonce?: string };
    if (typeof t.gameId === "string" && t.gameId.length > 0) gameId = t.gameId;
    broken = t.broken === true;
    if (nonce === undefined && typeof t.nonce === "string" && t.nonce.length > 0) nonce = t.nonce;
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
