// FUNCTIONAL GATE GENERATOR (M3) — turns a GDS's DoD assertions into a falsifiable, headless,
// loop-DRIVEN check. This is the discipline that was missing when gameplay bugs shipped: instead
// of eyeballing a screenshot, the gate DRIVES the sim with each DoD's input script and asserts the
// resulting STATE transitions (dialogue branched? quest fired? counter advanced? win reached?).
//
// It generalizes the p14_capstone + p14_playability pattern: a game exposes a small `GameUnderTest`
// surface; the runner replays each state-transition DoD's `drives` script and checks its `assert`
// post-conditions against that surface. "feel" DoDs are reported as skipped (human UAT only).
//
// The runner is engine-importable so it runs headless via the limina binary; the coordinator (M4)
// builds a game, exposes it as a GameUnderTest, and runs the gate after each slice.

import type { DoDAssertion, GameDesignSpec, Assertion } from "./gds.ts";

/** One fixed-step input the gate feeds the game (the typed sim input, fully specified). */
export interface SimInput {
  forward: number;
  strafe: number;
  yaw: number;
  run: boolean;
  jump: boolean;
  /** Dialogue/menu choice index, or -1 for none. */
  choose: number;
}

/** The minimal surface a game exposes so the gate can drive it and read its state. A direct-path
 *  game implements this over its controllers + managers. */
export interface GameUnderTest {
  /** Advance ONE fixed step with the given input. */
  step(input: SimInput, dt: number): void | Promise<void>;
  /** Player position projected to the XZ plane (for `walkToward` + reach checks). */
  playerXZ(): readonly [number, number];
  /** Resolve a drive target reference — an entity id (e.g. "relic") or an "x,z" literal — to an XZ. */
  resolveXZ(ref: string): readonly [number, number] | undefined;
  /** Game-defined named predicate for a step's `until` (e.g. "reached", "accepted", "collected"). */
  predicate(name: string): boolean;
  /** Current game-state string ("running" | "won" | "lost" | ...). */
  gameState(): string;
  counter(name: string): number;
  flag(name: string): boolean;
  hp(): number;
  questStatus(questId: string): string | undefined;
}

export interface DoDResult {
  id: string;
  statement: string;
  /** "passed" | "failed" | "skipped" (feel DoD — human UAT only). */
  status: "passed" | "failed" | "skipped";
  failures: string[];
  /** Fixed steps the drive script consumed. */
  steps: number;
}

export interface GateReport {
  passed: boolean;
  results: DoDResult[];
  /** Count of automated (state-transition) DoDs that passed. */
  automatedPassed: number;
  automatedTotal: number;
}

const DEFAULT_DT = 1 / 60;
const DEFAULT_REACH = 1.2;

function distXZ(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Heading that drives a CharacterController toward (toX,toZ) from (fromX,fromZ). Matches the
 *  engine's heading convention (yaw=atan2(dx,-dz); forward maps to (sin yaw, -cos yaw)). */
function headingToward(fromX: number, fromZ: number, toX: number, toZ: number): number {
  return Math.atan2(toX - fromX, -(toZ - fromZ));
}

/** Parse an "x,z" literal target into an XZ pair, or undefined if not that form. */
function parseXZ(ref: string): [number, number] | undefined {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(ref.trim());
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/** Check one post-condition against the live game. Returns a failure message, or undefined if it holds. */
function checkAssertion(a: Assertion, gut: GameUnderTest, reach: number): string | undefined {
  switch (a.check) {
    case "gameState": {
      const got = gut.gameState();
      return got === String(a.value) ? undefined : `gameState expected "${String(a.value)}", got "${got}"`;
    }
    case "counterAtLeast": {
      const got = gut.counter(String(a.target));
      const need = Number(a.value);
      return got >= need ? undefined : `counter "${String(a.target)}" expected >= ${need}, got ${got}`;
    }
    case "flagTrue": {
      return gut.flag(String(a.target)) ? undefined : `flag "${String(a.target)}" expected true`;
    }
    case "flagFalse": {
      return !gut.flag(String(a.target)) ? undefined : `flag "${String(a.target)}" expected false (it was true)`;
    }
    case "hpAtLeast": {
      const got = gut.hp();
      const need = Number(a.value);
      return got >= need ? undefined : `hp expected >= ${need}, got ${got}`;
    }
    case "questStatus": {
      const got = gut.questStatus(String(a.target));
      return got === String(a.value) ? undefined : `quest "${String(a.target)}" status expected "${String(a.value)}", got "${String(got)}"`;
    }
    case "playerReachedXZ": {
      const target = parseXZ(String(a.target));
      if (!target) return `playerReachedXZ target "${String(a.target)}" is not an "x,z" literal`;
      const d = distXZ(gut.playerXZ(), target);
      return d <= reach ? undefined : `player expected within ${reach}m of (${target[0]},${target[1]}), got ${d.toFixed(2)}m`;
    }
    default:
      return `unknown assertion check "${String((a as { check: string }).check)}"`;
  }
}

export interface RunOptions {
  dt?: number;
  reachRadius?: number;
}

/** Drive ONE DoD's script and check its post-conditions. A "feel" DoD (or one without a drive
 *  script) is reported as skipped. */
export async function runDoD(dod: DoDAssertion, gut: GameUnderTest, opts: RunOptions = {}): Promise<DoDResult> {
  const dt = opts.dt ?? DEFAULT_DT;
  const reach = opts.reachRadius ?? DEFAULT_REACH;

  if (dod.kind !== "state-transition" || dod.drives === undefined) {
    return { id: dod.id, statement: dod.statement, status: "skipped", failures: [], steps: 0 };
  }

  let steps = 0;
  for (const step of dod.drives.steps) {
    const reps = step.repeat ?? 1;
    // Resolve a fixed toward-target once per step (it does not move between iterations here).
    let targetXZ: readonly [number, number] | undefined;
    if (step.toward !== undefined && step.toward.startsWith("walkToward:")) {
      targetXZ = gut.resolveXZ(step.toward.slice("walkToward:".length));
    }
    for (let i = 0; i < reps; i++) {
      let yaw = step.yaw ?? 0;
      if (targetXZ !== undefined) {
        const p = gut.playerXZ();
        yaw = headingToward(p[0], p[1], targetXZ[0], targetXZ[1]);
      }
      const input: SimInput = {
        forward: step.forward ?? 0,
        strafe: step.strafe ?? 0,
        yaw,
        run: step.run ?? false,
        jump: step.jump ?? false,
        choose: step.choose ?? -1,
      };
      await gut.step(input, dt);
      steps++;

      if (step.until !== undefined) {
        let hit = false;
        if (step.until === "reached") {
          hit = (targetXZ !== undefined && distXZ(gut.playerXZ(), targetXZ) <= reach) || gut.predicate("reached");
        } else {
          hit = gut.predicate(step.until);
        }
        if (hit) break;
      }
    }
  }

  const failures: string[] = [];
  for (const a of dod.drives.assert) {
    const f = checkAssertion(a, gut, reach);
    if (f !== undefined) failures.push(f);
  }
  return {
    id: dod.id,
    statement: dod.statement,
    status: failures.length === 0 ? "passed" : "failed",
    failures,
    steps,
  };
}

/** Run the WHOLE gate for a GDS against a freshly-built game: every state-transition DoD is driven
 *  and asserted; feel DoDs are skipped. `passed` is true iff every automated DoD passed.
 *
 *  IMPORTANT: a GameUnderTest holds live sim state, so a multi-DoD gate needs ONE freshly-built
 *  game per DoD when DoDs are not independent. `buildGame` is therefore a factory called per DoD. */
export async function runGate(
  gds: GameDesignSpec,
  buildGame: () => GameUnderTest | Promise<GameUnderTest>,
  opts: RunOptions = {},
): Promise<GateReport> {
  const results: DoDResult[] = [];
  for (const dod of gds.dod) {
    if (dod.kind !== "state-transition") {
      results.push({ id: dod.id, statement: dod.statement, status: "skipped", failures: [], steps: 0 });
      continue;
    }
    const gut = await buildGame();
    results.push(await runDoD(dod, gut, opts));
  }
  const automated = results.filter((r) => r.status !== "skipped");
  const automatedPassed = automated.filter((r) => r.status === "passed").length;
  return {
    passed: automated.length > 0 && automatedPassed === automated.length,
    results,
    automatedPassed,
    automatedTotal: automated.length,
  };
}

/** Convenience for a test body: run the gate and THROW with a readable summary if any automated DoD
 *  fails (so a generated gate is one line in a headless test). */
export async function assertGatePasses(
  gds: GameDesignSpec,
  buildGame: () => GameUnderTest | Promise<GameUnderTest>,
  opts: RunOptions = {},
): Promise<GateReport> {
  const report = await runGate(gds, buildGame, opts);
  if (!report.passed) {
    const lines = report.results
      .filter((r) => r.status === "failed")
      .map((r) => `  ✗ ${r.id}: ${r.statement}\n      ${r.failures.join("\n      ")}`);
    throw new Error(`GDS gate FAILED (${report.automatedPassed}/${report.automatedTotal} automated DoDs passed):\n${lines.join("\n")}`);
  }
  return report;
}
