// M1 GATE — THE DIRECT-PATH SUBSTRATE SPLIT. Proves the roadmap's prerequisite: a game can be
// built and driven on limina's substrate with ZERO registry.invoke ceremony on the hot path,
// while world-log recording is an OPT-IN layer wrapped around the same context (and is
// transparent — it captures the direct path without changing the trajectory).
//
// Falsifiable assertions:
//   1. createHeadlessContext assembles a valid context (managers exposed, recorder OFF by default).
//   2. DIRECT-PATH movement: a CharacterController driven straight off ctx.ops walks forward, and
//      a spy on registry.invoke proves the gameplay loop issues EXACTLY ZERO invoke calls.
//   3. OPT-IN recorder: the same movement on a recording context captures physics commands AND
//      reproduces a byte-identical trajectory (the recorder is transparent).
//   4. GameLoop frame ORDER invariant (pose → ECS sync → skinning → present) + the async-step
//      re-entrancy guard (an overlapping tick is skipped).
//
// Run: ./target/release/limina js/test/p20_direct_path.ts   (exit 0 = pass)

import { ops, type EngineOps } from "../src/engine.ts";
import { CharacterController } from "../src/world/character.ts";
import { createHeadlessContext, GameLoop, type GameContext } from "../src/game/index.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p20_direct_path FAIL: " + msg);
}

const DT = 1 / 60;
const HALF = 0.5;
const RADIUS = 0.35;
const GROUND_OFFSET = HALF + RADIUS; // capsule center resting height above a flat ground at y=0

/** Walk a freshly-spawned controller straight forward (yaw 0 → world -Z) on flat ground at y=0
 *  for `steps` fixed steps, driving it DIRECTLY off ctx.ops (no skill invoke). Returns the final
 *  capsule-center position. Assumes the caller has created the physics world + ground. */
function walkForward(ctx: GameContext, steps: number): readonly [number, number, number] {
  const player = new CharacterController(ctx.ops, [0, GROUND_OFFSET, 0], { halfHeight: HALF, radius: RADIUS });
  for (let i = 0; i < steps; i++) {
    ctx.setTick(i);
    player.step({ forward: 1, strafe: 0, yaw: 0, run: false, jump: false }, DT);
    ctx.ops.op_physics_step();
  }
  const p = player.position;
  return [p[0], p[1], p[2]];
}

// ════════════════════════════ 1. CONTEXT SHAPE + RECORDER OFF BY DEFAULT ══════════════════════
{
  const ctx = createHeadlessContext({ session: "ses_p20_shape" });
  assert(ctx.recorder === undefined, "record omitted must leave no recorder (zero superstructure cost)");
  assert(ctx.base.tick === 0, "base starts at tick 0");
  assert(ctx.world.mode === "headless", "headless context reports headless mode");
  assert(ctx.core.player !== undefined && ctx.core.player.controllers !== undefined, "direct-path managers exposed (player)");
  assert(ctx.core.nav !== undefined && ctx.core.nav.navmeshManager !== undefined, "direct-path managers exposed (nav)");
  assert(ctx.core.quest !== undefined && ctx.core.quest.questManager !== undefined, "direct-path managers exposed (quest)");
  assert(ctx.ops === ctx.world.ops, "context ops and world ops are the same capability surface");
}

// ════════════════════════════ 2. DIRECT-PATH MOVEMENT WITH ZERO INVOKE ════════════════════════
ops.op_physics_create_world(-9.81);
ops.op_physics_add_ground(0);
const ctxA = createHeadlessContext({ session: "ses_p20_a" });

// Spy on the invoke choke point: the gameplay loop must not touch it.
let invokeCount = 0;
const origInvoke = ctxA.registry.invoke.bind(ctxA.registry);
ctxA.registry.invoke = ((name: string, input: unknown, base): Promise<MCPResponse> => {
  invokeCount++;
  return origInvoke(name, input, base);
}) as typeof ctxA.registry.invoke;

const endA = walkForward(ctxA, 120);
assert(invokeCount === 0, `direct-path movement issued ${invokeCount} registry.invoke calls — expected ZERO ceremony`);
assert(endA[2] < -1.0, `player did not walk forward along -Z (end z=${endA[2]})`);
assert(Math.abs(endA[0]) < 0.25, `player drifted sideways unexpectedly (end x=${endA[0]})`);

// ════════════════════════════ 3. OPT-IN RECORDER: TRANSPARENT + CAPTURES THE DIRECT PATH ══════
ops.op_physics_create_world(-9.81);
ops.op_physics_add_ground(0);
const ctxB = createHeadlessContext({ session: "ses_p20_b", record: { seed: 1 } });
assert(ctxB.recorder !== undefined, "record opt-in must create a recorder");
assert(ctxB.ops !== ops, "recording context must hand the game RECORDER-WRAPPED ops, not the raw host ops");

const endB = walkForward(ctxB, 120);
assert(ctxB.recorder!.count("physics") > 0, "recorder did not capture the direct-path physics ops (depth-0 wrap failed)");
for (let k = 0; k < 3; k++) {
  assert(Object.is(endA[k], endB[k]), `recorder changed the trajectory at axis ${k}: ${endA[k]} vs ${endB[k]} (recorder must be transparent)`);
}
// The recorder serializes a non-empty world-log (the export-everywhere artifact).
const jsonl = ctxB.recorder!.toJsonl();
assert(jsonl.split("\n").length > 1, "recorded world-log is empty");

// ════════════════════════════ 4. GAMELOOP FRAME ORDER + RE-ENTRANCY GUARD ═════════════════════
{
  const ctx = createHeadlessContext({ session: "ses_p20_loop" });
  const order: string[] = [];
  const loop = new GameLoop<Record<string, never>>(ctx, {
    sampleInput: () => ({}),
    step: () => { order.push("step"); },
    beforeSync: () => order.push("pose"),
    synced: [{ syncSkinning: () => order.push("skin") }],
    present: () => order.push("present"),
  });
  loop.frameTick(0);
  assert(order.join(",") === "pose,skin,present",
    `frame order invariant broken (got "${order.join(",")}") — skinning must run after the ECS sync and before present`);
}
{
  const ctx = createHeadlessContext({ session: "ses_p20_reentry" });
  let runs = 0;
  let release: () => void = () => {};
  const loop = new GameLoop<Record<string, never>>(ctx, {
    sampleInput: () => ({}),
    step: () => { runs++; return new Promise<void>((r) => { release = r; }); },
    present: () => {},
  });
  loop.fixedStep(DT); // starts an async step (stays pending)
  loop.fixedStep(DT); // must be SKIPPED while the first is in flight
  assert(runs === 1, `re-entrancy guard failed: step ran ${runs}x while one was in flight (expected 1)`);
  release();
  // Drain the microtask queue: the step promise's .catch().finally() chain (which clears the
  // re-entrancy flag) is several microtask hops; one await is not enough (the runtime has no timers).
  for (let i = 0; i < 10; i++) await Promise.resolve();
  loop.fixedStep(DT); // the prior step resolved → a new one may run
  assert(runs === 2, `step did not resume after the in-flight one resolved (runs=${runs})`);
}

ops.op_log(
  "p20_direct_path OK: direct-path substrate split proven — createGameContext assembles the " +
  "WorldContext + CoreSkills + base once; a CharacterController walks forward driven straight off " +
  "ctx.ops with ZERO registry.invoke (spy=0); the OPT-IN recorder captures the direct-path physics " +
  "and reproduces a byte-identical trajectory; and GameLoop enforces the pose→sync→skin→present " +
  "order plus the async-step re-entrancy guard.",
);
