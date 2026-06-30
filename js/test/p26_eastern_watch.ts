// M6 (Eastern Watch) — THE DOGFOOD. Re-builds the Aethon "Eastern Watch" through the pipeline and
// proves the ORIGINAL UAT BUGS are now functionally gated:
//   - the dialogue branches: choosing DECLINE (choice 1) keeps the quest UNACCEPTED (it was the
//     "1/2 doesn't matter, Space always accepts" bug);
//   - the quest TURN-IN FIRES: accept → secure the watch-points → return → won + quest completed
//     (it was the "turn-in never works" bug).
// The Eastern Watch is planned through the same planner (mechanics map to real engine skills) and
// its DoDs are driven by the same functional gate — the discipline Aethon never had.
//
// Run: ./target/release/limina js/test/p26_eastern_watch.ts   (exit 0 = pass)

import { createHeadlessContext } from "../src/game/index.ts";
import { runDoD } from "../src/game/gate.ts";
import { planFromGDS } from "../src/game/plan.ts";
import { defaultKnownSkill } from "../src/game/coordinator.ts";
import { validateGDS } from "../src/game/gds.ts";
import { EASTERN_WATCH } from "../src/game/examples/eastern_watch.gds.ts";
import { buildEasternWatchGame } from "../src/game/examples/eastern_watch_game.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p26_eastern_watch FAIL: " + msg);
}

// ════════════════════════ 1. THE EASTERN WATCH GDS VALIDATES ═══════════════════════════════════
{
  const v = validateGDS(EASTERN_WATCH);
  assert(v.ok, "the EASTERN_WATCH GDS must validate: " + JSON.stringify(v.issues));
  const auto = EASTERN_WATCH.dod.filter((d) => d.kind === "state-transition");
  assert(auto.length === 2, `expected 2 automated DoDs (accept + decline), got ${auto.length}`);
}

// ════════════════════════ 2. PLAN: DIALOGUE/QUEST/TURN-IN MAP TO REAL SKILLS ═══════════════════
{
  const plan = planFromGDS(EASTERN_WATCH, defaultKnownSkill());
  assert(plan.newWork.length === 0, "Eastern Watch mechanics must map to existing engine skills: " + JSON.stringify(plan.newWork));
  const skills = plan.systems.map((s) => s.skill);
  for (const must of ["player.move", "dialogue.start", "quest.accept", "game.win"]) {
    assert(skills.includes(must), `plan must map a mechanic to ${must}`);
  }
}

// ════════════════════════ 3. TURN-IN FIRES (the "turn-in never works" bug, fixed + gated) ══════
{
  const dod = EASTERN_WATCH.dod.find((d) => d.id === "accept-then-turnin")!;
  const gut = await buildEasternWatchGame(createHeadlessContext({ session: "ses_ew_accept" }));
  const res = await runDoD(dod, gut);
  assert(res.status === "passed", "accept→secure→return must TURN IN and win: " + JSON.stringify(res.failures));
  assert(gut.gameState() === "won", "the watch is WON after turn-in");
  assert(gut.questStatus("eastern-watch") === "completed", "the quest TURNED IN (status completed) — the turn-in bug is gated");
}

// ════════════════════════ 4. DECLINE STICKS (the "1/2 always accepts" bug, fixed + gated) ══════
{
  const dod = EASTERN_WATCH.dod.find((d) => d.id === "decline-sticks")!;
  const gut = await buildEasternWatchGame(createHeadlessContext({ session: "ses_ew_decline" }));
  const res = await runDoD(dod, gut);
  assert(res.status === "passed", "declining must keep the quest UNACCEPTED: " + JSON.stringify(res.failures));
  assert(gut.flag("accepted") === false, "declining did NOT accept the quest — the dialogue-branch bug is gated");
  assert(gut.gameState() === "playing", "the game is still in progress after declining");
}

console.log(
  "p26_eastern_watch OK: the Aethon Eastern Watch runs through the pipeline — planned to real skills " +
  "(player.move / dialogue.start / quest.accept / game.win), and its DoDs DRIVE the exact UAT bugs: " +
  "accept → secure the three watch-points → return TURNS IN the quest (gameState won, quest completed), " +
  "and DECLINE keeps the quest unaccepted (gameState still playing). Both bugs are now functionally gated.",
);
