// M6 (intake) — STAGE 1. Both intake paths converge on one validated GDS:
//   1a parseGdd: pull the GDS from a markdown GDD's ```json block, validate, gap-report.
//   1b interview: the expert panel COVERS every required GDS field, and synthesizeGds assembles the
//      collected answers into a validated GDS (deriving the id from the pitch).
//
// Run: ./target/release/limina js/test/p25_intake.ts   (exit 0 = pass)

import { parseGdd, interviewPlan, interviewCoverage, synthesizeGds, REQUIRED_GDS_FIELDS, type InterviewAnswers } from "../src/game/intake.ts";
import { RELIC_SPRINT } from "../src/game/examples/relic_sprint.gds.ts";
import type { GameDesignSpec } from "../src/game/gds.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p25_intake FAIL: " + msg);
}
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ════════════════════════ 1a. GDD PARSING ═════════════════════════════════════════════════════
{
  const gdd = `# Relic Sprint — GDD\n\nA short prose intro the parser ignores.\n\n` +
    "```json\n" + JSON.stringify(RELIC_SPRINT, null, 2) + "\n```\n\nMore prose after.";
  const r = parseGdd(gdd);
  assert(r.ok, "a GDD with a valid embedded GDS must parse: " + JSON.stringify(r.issues));
  assert(r.data !== undefined && r.data.id === "relic-sprint", "parsed GDS carries the id");
  assert(r.gaps.length === 0, "no gaps for a complete GDD");
}
{
  // A GDD whose embedded spec is missing a required field → gap report.
  const broken = clone(RELIC_SPRINT) as Record<string, unknown>;
  delete broken.winCondition;
  const gdd = "```json\n" + JSON.stringify(broken) + "\n```";
  const r = parseGdd(gdd);
  assert(!r.ok, "a GDD missing winCondition must not parse clean");
  assert(r.gaps.includes("winCondition"), "the gap report names winCondition: " + JSON.stringify(r.gaps));
}
{
  const r = parseGdd("# A doc with no json block\n\njust prose");
  assert(!r.ok && r.gaps.includes("(entire spec)"), "a GDD with no GDS block reports the whole spec missing");
}
{
  const r = parseGdd("```json\n{ not valid json,, }\n```");
  assert(!r.ok && r.issues[0].message.includes("invalid JSON"), "a GDD with a broken json block reports invalid JSON");
}

// ════════════════════════ 1b. INTERVIEW PANEL ═════════════════════════════════════════════════
{
  const plan = interviewPlan();
  assert(plan.length === 4, `expected a 4-persona panel, got ${plan.length}`);
  assert(plan.every((p) => p.questions.length > 0), "every persona asks at least one question");

  const cov = interviewCoverage();
  assert(cov.complete, "the interview panel must cover EVERY required GDS field; missing: " + JSON.stringify(cov.missing));
  for (const f of REQUIRED_GDS_FIELDS) {
    assert(cov.covered.includes(f), `required field "${f}" must be covered by some persona's question`);
  }
}

// Synthesize a GDS from collected answers (id derived from the pitch).
{
  const answers: InterviewAnswers = {
    pitch: RELIC_SPRINT.pitch,
    loopSentence: RELIC_SPRINT.loopSentence,
    controls: RELIC_SPRINT.controls,
    winCondition: RELIC_SPRINT.winCondition,
    loseCondition: RELIC_SPRINT.loseCondition,
    artDirection: RELIC_SPRINT.artDirection,
    targetPlatforms: RELIC_SPRINT.targetPlatforms,
    scopeTier: RELIC_SPRINT.scopeTier,
    optIn: RELIC_SPRINT.optIn,
    entities: RELIC_SPRINT.entities,
    mechanics: RELIC_SPRINT.mechanics,
    content: RELIC_SPRINT.content,
    dod: RELIC_SPRINT.dod,
  };
  const r = synthesizeGds(answers);
  assert(r.ok, "a complete answer set must synthesize a valid GDS: " + JSON.stringify(r.issues));
  assert(r.data !== undefined && typeof r.data.id === "string" && r.data.id.length > 0, "the id is derived from the pitch");
  // The derived id is a slug (no spaces/uppercase).
  assert(/^[a-z0-9-]+$/.test(r.data!.id), `derived id must be a slug, got "${r.data!.id}"`);
  // It is functionally the same spec (entities + dod preserved).
  assert(r.data!.entities.length === RELIC_SPRINT.entities.length, "entities preserved through synthesis");
  assert(r.data!.dod.some((d: GameDesignSpec["dod"][number]) => d.kind === "state-transition"), "an automated DoD survives synthesis");
}

// An incomplete interview (no DoD answered) reports the gap rather than producing a spec.
{
  const r = synthesizeGds({ pitch: "x", loopSentence: "y" } as InterviewAnswers);
  assert(!r.ok, "an incomplete interview must NOT yield a valid GDS");
  assert(r.issues.length > 0, "incomplete synthesis reports the missing fields");
}

console.log(
  "p25_intake OK: 1a parseGdd extracts + validates the GDS from a markdown GDD (gap-reports missing " +
  "fields, invalid JSON, and absent blocks); 1b the 4-persona interview panel COVERS every required " +
  "GDS field, and synthesizeGds assembles a complete answer set into a validated GDS (id derived from " +
  "the pitch), while an incomplete interview reports its gaps. Both paths converge on one GDS.",
);
