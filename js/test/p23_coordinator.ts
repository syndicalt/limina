// M4 GATE — THE PLANNER + COORDINATOR SPINE. Proves Stage 2 → Stage 3 of the pipeline runs
// generically and deterministically: a GDS is planned into an Architecture Plan (mechanics mapped
// to real engine skills via the authoritative registry catalog, slices derived with Slice 0 = the
// playable loop), and the coordinator builds + GATES each slice in order, HALTING on the first
// failure (playable-loop-first). The SliceBuilder seam stands in for the specialist agents / llmff.
//
// Run: ./target/release/limina js/test/p23_coordinator.ts   (exit 0 = pass)

import { createHeadlessContext } from "../src/game/index.ts";
import { planFromGDS, ArchitecturePlanSchema } from "../src/game/plan.ts";
import { coordinate, defaultKnownSkill } from "../src/game/coordinator.ts";
import { RELIC_SPRINT } from "../src/game/examples/relic_sprint.gds.ts";
import { buildRelicSprintGame } from "../src/game/examples/relic_sprint_game.ts";
import type { GameDesignSpec } from "../src/game/gds.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p23_coordinator FAIL: " + msg);
}
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

const knownSkill = defaultKnownSkill();

// ════════════════════════ 1. PLANNER: GDS → ARCHITECTURE PLAN ══════════════════════════════════
{
  const plan = planFromGDS(RELIC_SPRINT, knownSkill);
  ArchitecturePlanSchema.parse(plan); // the plan validates against its own schema

  assert(plan.gdsId === "relic-sprint", "plan carries the GDS id");
  assert(plan.optIn === "direct-path", "plan carries the opt-in choice");
  assert(plan.systems.length === 3, `expected 3 mapped systems, got ${plan.systems.length}`);

  const byId = (id: string) => plan.systems.find((s) => s.mechanicId === id)!;
  assert(byId("move").skill === "player.move" && byId("move").status === "existing", "move → player.move (existing)");
  assert(byId("pickup").skill === "interaction.pickup" && byId("pickup").status === "existing", "pickup → interaction.pickup (existing)");
  assert(byId("win").skill === "game.win" && byId("win").status === "existing", "win → game.win (existing)");
  assert(plan.newWork.length === 0, "all RELIC_SPRINT mechanics map to existing skills (no new work): " + JSON.stringify(plan.newWork));

  const slice0 = plan.slices.find((s) => s.id === "slice-0")!;
  assert(slice0 !== undefined, "Slice 0 (playable loop) is present");
  assert(slice0.dodIds.includes("collect-wins"), "Slice 0 is gated by the automated DoD");
  assert(!slice0.dodIds.includes("feels-snappy"), "Slice 0 must NOT be gated by the feel DoD");
  assert(plan.slices.some((s) => s.id === "slice-content"), "a content slice follows (manifest is non-empty)");
}

// ════════════════════════ 2. PLANNER FLAGS NEW / UNKNOWN WORK ══════════════════════════════════
{
  const g = clone(RELIC_SPRINT) as GameDesignSpec;
  g.mechanics.push({ id: "bogus", name: "Bogus", skill: "does.not.exist" });
  g.mechanics.push({ id: "novel", name: "Novel", skill: "NEW: a brand-new mechanic" });
  const plan = planFromGDS(g, knownSkill);
  assert(plan.systems.find((s) => s.mechanicId === "bogus")!.status === "unknown", "a nonexistent skill is flagged unknown");
  assert(plan.systems.find((s) => s.mechanicId === "novel")!.status === "new", "a NEW:-prefixed mechanic is flagged new");
  assert(plan.newWork.some((w) => w.includes("does.not.exist")) && plan.newWork.some((w) => w.includes("brand-new")),
    "both the unknown and the new mechanic appear in newWork: " + JSON.stringify(plan.newWork));
}

// ════════════════════════ 3. COORDINATOR: CORRECT BUILD → SPINE GREEN ══════════════════════════
{
  const plan = planFromGDS(RELIC_SPRINT, knownSkill);
  let built = 0;
  const ledger = await coordinate(RELIC_SPRINT, plan, () => {
    built++;
    return buildRelicSprintGame(createHeadlessContext({ session: `ses_p23_real_${built}` }));
  });

  assert(ledger.passed, "the spine must pass with the correct build: " + JSON.stringify(ledger.entries));
  assert(ledger.haltedAt === undefined, "no halt on a passing run");
  const s0 = ledger.entries.find((e) => e.sliceId === "slice-0")!;
  assert(s0.status === "passed" && s0.gate !== undefined && s0.gate.passed, "slice-0 gated green");
  const sc = ledger.entries.find((e) => e.sliceId === "slice-content")!;
  assert(sc !== undefined && sc.status === "skipped", "the content slice is skipped by the functional gate (no automated DoDs)");
  assert(built >= 1, "the SliceBuilder was invoked to produce the game");
}

// ════════════════════════ 4. COORDINATOR: BROKEN BUILD HALTS THE SPINE ═════════════════════════
{
  const plan = planFromGDS(RELIC_SPRINT, knownSkill);
  let built = 0;
  const ledger = await coordinate(RELIC_SPRINT, plan, () => {
    built++;
    return buildRelicSprintGame(createHeadlessContext({ session: `ses_p23_broken_${built}` }), { broken: true });
  });

  assert(!ledger.passed, "a broken build must fail the spine");
  assert(ledger.haltedAt === "slice-0", `the spine must HALT at slice-0 (playable-loop-first), halted at ${ledger.haltedAt}`);
  const s0 = ledger.entries.find((e) => e.sliceId === "slice-0")!;
  assert(s0.status === "failed", "slice-0 recorded as failed");
  assert(ledger.entries.find((e) => e.sliceId === "slice-content") === undefined,
    "halt means downstream slices are never reached (the content slice is absent from the ledger)");
}

console.log(
  "p23_coordinator OK: the planner maps RELIC_SPRINT's mechanics to real engine skills " +
  "(move→player.move, pickup→interaction.pickup, win→game.win — all existing; bogus/NEW flagged), " +
  "derives Slice 0 = playable loop gated by the automated DoD, and the coordinator runs the spine — " +
  "GREEN on the correct build (slice-0 gated, content skipped) and HALTING at slice-0 on a broken " +
  "build (playable-loop-first). The pipeline spine is generic, deterministic, and falsifiable.",
);
