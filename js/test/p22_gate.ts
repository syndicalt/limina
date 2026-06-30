// M3 GATE — THE FUNCTIONAL GATE GENERATOR. Proves the discipline that was missing when gameplay
// bugs shipped: a GDS's state-transition DoDs are turned into a DRIVEN headless check (replay the
// input script, assert the resulting state transitions), and that check is FALSIFIABLE — it goes
// red on a broken build and green on a correct one.
//
//   1. The reference relic-sprint game (built on the direct path) PASSES the RELIC_SPRINT gate:
//      the collect-wins DoD drives the player to the relic and asserts gameState "won" + counter>=1.
//   2. The "feel" DoD is SKIPPED (human UAT only), not silently counted as passing.
//   3. A BROKEN build (win transition omitted — the Aethon turn-in bug) makes the gate go RED, with
//      the failure pointing at the missing gameState transition while the counter still advanced.
//
// Run: ./target/release/limina js/test/p22_gate.ts   (exit 0 = pass)

import { createHeadlessContext } from "../src/game/index.ts";
import { runGate, runDoD, type GameUnderTest } from "../src/game/gate.ts";
import { RELIC_SPRINT } from "../src/game/examples/relic_sprint.gds.ts";
import { buildRelicSprintGame } from "../src/game/examples/relic_sprint_game.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p22_gate FAIL: " + msg);
}

// ════════════════════════ 1. THE CORRECT GAME PASSES THE GATE ══════════════════════════════════
{
  let built = 0;
  const report = await runGate(RELIC_SPRINT, () => {
    built++;
    return buildRelicSprintGame(createHeadlessContext({ session: `ses_p22_real_${built}` }));
  });

  assert(report.passed, "the correct relic-sprint game must PASS the GDS gate; results: " + JSON.stringify(report.results));
  assert(report.automatedTotal === 1, `expected 1 automated DoD, got ${report.automatedTotal}`);
  assert(report.automatedPassed === 1, `expected 1 automated DoD to pass, got ${report.automatedPassed}`);

  const collect = report.results.find((r) => r.id === "collect-wins");
  assert(collect !== undefined && collect.status === "passed", "collect-wins DoD must pass");
  assert(collect!.steps > 0 && collect!.steps < 600, `collect-wins should reach the relic well within the cap (steps=${collect?.steps})`);

  // The "feel" DoD is reported skipped — never silently counted as a pass.
  const feel = report.results.find((r) => r.id === "feels-snappy");
  assert(feel !== undefined && feel.status === "skipped", "the feel DoD must be SKIPPED (human UAT only)");
  assert(report.automatedTotal === report.results.filter((r) => r.status !== "skipped").length, "automatedTotal must exclude skipped DoDs");
}

// ════════════════════════ 2. FALSIFIABILITY — A BROKEN BUILD GOES RED ══════════════════════════
{
  const broken: GameUnderTest = buildRelicSprintGame(
    createHeadlessContext({ session: "ses_p22_broken" }),
    { broken: true },
  );
  // Drive the single collect-wins DoD directly against the broken build.
  const dod = RELIC_SPRINT.dod.find((d) => d.id === "collect-wins")!;
  const result = await runDoD(dod, broken);

  assert(result.status === "failed", "the broken build (win omitted) MUST fail the gate — otherwise the gate is inert");
  // The bug class: the counter advanced (pickup fired) but the WIN transition did not.
  assert(broken.counter("relics") >= 1, "the broken build still collects the relic (counter advanced)");
  assert(broken.gameState() !== "won", "the broken build never reaches the won state (that is the bug)");
  assert(result.failures.some((f) => f.includes("gameState")), "the failure must point at the missing gameState transition: " + JSON.stringify(result.failures));
}

// ════════════════════════ 3. GATE-LEVEL RED FOR THE BROKEN BUILD ═══════════════════════════════
{
  let built = 0;
  const report = await runGate(RELIC_SPRINT, () => {
    built++;
    return buildRelicSprintGame(createHeadlessContext({ session: `ses_p22_brokengate_${built}` }), { broken: true });
  });
  assert(!report.passed, "runGate must report the broken build as NOT passed");
  assert(report.automatedPassed === 0, `expected 0 automated DoDs to pass for the broken build, got ${report.automatedPassed}`);
}

console.log(
  "p22_gate OK: the functional gate generator turns RELIC_SPRINT's state-transition DoD into a " +
  "driven headless check — the correct direct-path game PASSES (collect-wins: walk to the relic, " +
  "assert gameState \"won\" + counter>=1), the feel DoD is SKIPPED (human UAT), and a broken build " +
  "(win transition omitted — the Aethon turn-in bug) goes RED with the failure pinned to the missing " +
  "gameState transition. The gate is falsifiable.",
);
