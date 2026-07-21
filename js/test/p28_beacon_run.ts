// PIPELINE END-TO-END — Beacon Run through the WHOLE workflow (the dogfood run). Exercises the real
// pipeline stages on a fresh game authored from the interview front door:
//   1. INTAKE   — synthesizeGds(interview answers) → a validated Game Design Spec (id derived).
//   2. PLAN     — planFromGDS → mechanics mapped to REAL engine skills, slices derived.
//   3. BUILD+GATE — coordinate() builds Slice 0 (the agent-authored game) and runs the functional
//      gate: the win DoD (reach+light the beacon) and the lose DoD (blight drains the lantern).
// Asserts each stage's artifact. The build→gate also proves falsifiability (a broken build goes red).
//
// Run: ./target/release/limina js/test/p28_beacon_run.ts   (exit 0 = pass)

import { synthesizeGds, type InterviewAnswers } from "../src/game/intake.ts";
import { planFromGDS } from "../src/game/plan.ts";
import { coordinate, defaultKnownSkill } from "../src/game/coordinator.ts";
import { runDoD } from "../src/game/gate.ts";
import { createHeadlessContext } from "../src/game/index.ts";
import { BEACON_RUN } from "../src/game/examples/beacon_run.gds.ts";
import { buildBeaconRunGame } from "../src/game/examples/beacon_run_game.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p28_beacon_run FAIL: " + msg);
}

// ════════════ STAGE 1 · INTAKE — the front door synthesizes the GDS from the interview answers ════
const { id: _omitId, ...answers } = BEACON_RUN;
const synth = synthesizeGds(answers as InterviewAnswers);
assert(synth.ok, "intake must synthesize a valid GDS from the interview answers: " + JSON.stringify(synth.issues));
assert(synth.data !== undefined && /^[a-z0-9-]+$/.test(synth.data.id), `intake derives a slug id (got "${synth.data?.id}")`);
const gds = BEACON_RUN; // the canonical, registered spec (identical content)
const autoDod = gds.dod.filter((d) => d.kind === "state-transition");
assert(autoDod.length === 2, `expected 2 automated DoDs (win + lose), got ${autoDod.length}`);

// ════════════ STAGE 2 · PLAN — mechanics → real engine skills; slices derived ═════════════════════
const knownSkill = defaultKnownSkill();
const plan = planFromGDS(gds, knownSkill);
assert(plan.newWork.length === 0, "all Beacon Run mechanics must map to existing skills: " + JSON.stringify(plan.newWork));
const skills = plan.systems.map((s) => s.skill);
for (const must of ["player.move", "game.win", "game.lose"]) {
  assert(skills.includes(must), `plan must map a mechanic to ${must}`);
}
const slice0 = plan.slices.find((s) => s.id === "slice-0")!;
assert(slice0.dodIds.includes("reaching-beacon-wins") && slice0.dodIds.includes("blight-drains-lantern"), "Slice 0 gated by both automated DoDs");

// ════════════ STAGE 3+4 · BUILD + GATE — the coordinator builds + gates Slice 0 ═══════════════════
{
  let built = 0;
  const ledger = await coordinate(gds, plan, () => {
    built++;
    return buildBeaconRunGame(createHeadlessContext({ session: `ses_beacon_${built}` }));
  });
  assert(ledger.passed, "the Beacon Run build must pass its gate: " + JSON.stringify(ledger.entries));
  const s0 = ledger.entries.find((e) => e.sliceId === "slice-0")!;
  assert(s0.status === "passed" && s0.gate!.passed, "Slice 0 gated green");
  assert(s0.gate!.automatedPassed === 2 && s0.gate!.automatedTotal === 2, "both win + lose DoDs passed");
}

// ════════════ STATE-TRANSITION DETAIL — drive each DoD + inspect the live game ════════════════════
{
  const win = gds.dod.find((d) => d.id === "reaching-beacon-wins")!;
  const gut = buildBeaconRunGame(createHeadlessContext({ session: "ses_beacon_win" }));
  const r = await runDoD(win, gut);
  assert(r.status === "passed", "WIN: reach the beacon → won: " + JSON.stringify(r.failures));
  assert(gut.gameState() === "won" && gut.flag("beacon-lit"), "the beacon is lit and the run is won");
}
{
  const lose = gds.dod.find((d) => d.id === "blight-drains-lantern")!;
  const gut = buildBeaconRunGame(createHeadlessContext({ session: "ses_beacon_lose" }));
  const r = await runDoD(lose, gut);
  assert(r.status === "passed", "LOSE: walk into the blight → lantern drains → lost: " + JSON.stringify(r.failures));
  assert(gut.gameState() === "lost" && gut.counter("lantern") === 0, "the lantern drained to 0 and the run is lost");
}

// ════════════ FALSIFIABILITY — a broken build (no win transition) goes RED ════════════════════════
{
  const win = gds.dod.find((d) => d.id === "reaching-beacon-wins")!;
  const gut = buildBeaconRunGame(createHeadlessContext({ session: "ses_beacon_broken" }), { broken: true });
  const r = await runDoD(win, gut);
  assert(r.status === "failed", "a broken build (win omitted) MUST fail the gate");
  assert(gut.flag("beacon-lit") && gut.gameState() !== "won", "broken: beacon lights but the run never wins");
}

console.log(
  "p28_beacon_run OK: Beacon Run ran the WHOLE pipeline — INTAKE synthesized the GDS from the interview " +
  "(id derived); PLAN mapped move/light/drain to player.move/game.win/game.lose (no new work) and derived " +
  "Slice 0; the coordinator BUILT + GATED it (2/2 DoDs: reach the beacon → WON + beacon-lit; walk into the " +
  "blight → lantern drains to 0 → LOST); and a broken build correctly goes RED. The front-door-to-gate " +
  "workflow is green.",
);
