// Phase 12 — CHARACTER replay-parity gate (limina's core invariant).
//
// Proves a recorded session that drives a CHARACTER CONTROLLER (alongside other
// physics bodies) replays BIT-IDENTICALLY into a fresh world from the command
// stream ALONE: the character ops (add_character / move_character) are logged,
// re-issued on replay, and `move_shape` re-resolves the same trajectory; and the
// body ids of bodies spawned AFTER the character stay correct.
//
// FALSIFIABLE / REVERT-PROOF: dropping the character commands from the stream
// shifts every later body id (and loses the character), so the replay diverges —
// the test asserts both the good-path parity AND the broken-path divergence. If
// add_character/move_character were removed from the recorded set (log.ts), the
// good-path replay would itself diverge and fail.
//
// Run: ./target/release/limina js/test/p12_character_replay.ts   (exit 0 = pass)

import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import type { WorldCommand } from "../src/worldlog/log.ts";
import { CharacterController, type MoveCommand } from "../src/world/character.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p12_character_replay FAIL: " + msg);
}

function makeHeadlessWorld(worldOps: typeof ops): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs,
    transforms: createTransformStorage(ecs),
    spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(),
    tags: new Map(),
    scene,
    camera,
    ops: worldOps,
    mode: "headless",
  };
}
const makeRegistry = (tracer: LiminaTracer): SkillRegistry => new SkillRegistry(tracer);

const DT = 1 / 60;
const STEPS = 200;
// A constant diagonal walk (yaw=0.5) with a jump partway, so both horizontal and
// vertical character state are exercised across the recording.
const walk: MoveCommand = { forward: 1, strafe: 0, yaw: 0.5, run: false, jump: false };

function readTransform(id: number): number[] {
  const t = new Float32Array(7);
  ops.op_physics_body_transform(id, t);
  return Array.from(t);
}

// ---- RECORD a session with a character + other bodies ----------------------
const rec = new WorldRecorder("ses_char_replay");
const wops = rec.wrapOps(ops); // wrapped ops record depth-0 physics commands
rec.seed(0xc0ffee);
wops.op_physics_create_world(-9.81);
wops.op_physics_add_ground(0);
const boxA = wops.op_physics_add_box(2, 6, 0, 0.5); // dynamic; id 0
const character = new CharacterController(wops, [0, 1.0, 0], { halfHeight: 0.5, radius: 0.35 }); // id 1
const boxB = wops.op_physics_add_sphere(-2, 8, 0, 0.5, 0.5, 0.2); // dynamic; id 2 (spawned AFTER character)
const ids = [boxA, character.bodyId, boxB];
assert(ids[1] === 1 && ids[2] === 2, `body ids monotonic from a fresh world: ${ids.join(",")}`);

for (let i = 0; i < STEPS; i++) {
  rec.tick = i;
  character.step({ ...walk, jump: i === 60 }, DT);
  wops.op_physics_apply_impulse(boxB, 0.02, 0, 0); // id-sensitive nudge each step (recorded)
  wops.op_physics_step();
}

// Capture the record-run final transforms BEFORE replay resets the native world.
const recFinals = ids.map(readTransform);
const commands: WorldCommand[] = rec.commands.slice();

// The character ops must actually be in the recorded stream, with the out-buffer
// stripped (move_character logs only its 4 scalar inputs).
const addChar = commands.filter((c) => c.kind === "physics" && c.op === "add_character").length;
const moveChar = commands.filter((c) => c.kind === "physics" && c.op === "move_character");
assert(addChar === 1, `add_character recorded once: got ${addChar}`);
assert(moveChar.length === STEPS, `move_character recorded each step: ${moveChar.length} != ${STEPS}`);
const firstMove = moveChar[0];
assert(firstMove.kind === "physics" && firstMove.args.length === 4, `move_character args stripped to 4 scalars: ${firstMove.kind === "physics" ? firstMove.args.length : "?"}`);

// ---- GOOD REPLAY: bit-identical for EVERY body -----------------------------
const tracer = new LiminaTracer("ses_char_replay_rb");
await replayCommands(commands, { makeWorld: () => makeHeadlessWorld(ops), makeRegistry, tracer });
const goodFinals = ids.map(readTransform);
for (let b = 0; b < ids.length; b++) {
  for (let k = 0; k < 7; k++) {
    assert(
      Object.is(recFinals[b][k], goodFinals[b][k]),
      `replay diverged for body#${ids[b]} component[${k}]: ${recFinals[b][k]} vs ${goodFinals[b][k]}`,
    );
  }
}

// ---- REVERT-PROOF: drop the character commands -> later ids shift -> diverge -
const broken = commands.filter(
  (c) => !(c.kind === "physics" && (c.op === "add_character" || c.op === "move_character")),
);
assert(broken.length < commands.length, "filter removed character commands");
await replayCommands(broken, { makeWorld: () => makeHeadlessWorld(ops), makeRegistry, tracer });
let diverged = false;
for (let b = 0; b < ids.length && !diverged; b++) {
  const t = readTransform(ids[b]);
  for (let k = 0; k < 7; k++) {
    if (!Object.is(recFinals[b][k], t[k])) { diverged = true; break; }
  }
}
assert(diverged, "REVERT-PROOF FAILED: dropping character ops did not change the replay (recording is not load-bearing)");

ops.op_log(
  `p12_character_replay OK: ${commands.length} commands (1 add_character + ${moveChar.length} move_character), ` +
  `${ids.length} bodies replay bit-identically; dropping character ops diverges (revert-proof).`,
);
