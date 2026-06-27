// Phase 12 — CHARACTER snapshot/restore parity (M2 mid-stream resume).
//
// A character's vertical velocity / grounded / heading are JS-owned and the native
// Rapier blob cannot carry them. This proves the snapshot/restore PATH captures
// and reinstalls them: a snapshot taken MID-JUMP, restored into the same world +
// controller, produces a continuation BIT-IDENTICAL to the never-stopped run.
//
// FALSIFIABLE: corrupting the captured `vy` makes the restored continuation
// diverge — so the controller state is provably load-bearing in the snapshot
// (i.e. dropping it from the snapshot path would fail this test).
//
// Run: ./target/release/limina js/test/p12_character_snapshot.ts   (exit 0 = pass)

import { EntityTable, ops } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { type WorldContext } from "../src/skills/registry.ts";
import { installSeededRandom } from "../src/worldlog/log.ts";
import {
  captureWorldSnapshot,
  parseSnapshot,
  restoreSnapshot,
  serializeSnapshot,
} from "../src/worldlog/snapshot.ts";
import { CharacterController, type MoveCommand } from "../src/world/character.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p12_character_snapshot FAIL: " + msg);
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

const DT = 1 / 60;
const STILL: MoveCommand = { forward: 0, strafe: 0, yaw: 0, run: false, jump: false };
const CONT = 60; // continuation steps (covers the arc + landing)

/** Drive a controller CONT steps under STILL (let the jump arc play out) and
 *  return the recorded center positions. */
function continueArc(c: CharacterController): number[] {
  const traj: number[] = [];
  for (let i = 0; i < CONT; i++) {
    c.step(STILL, DT);
    ops.op_physics_step();
    const p = c.position;
    traj.push(p[0], p[1], p[2]);
  }
  return traj;
}

// A seeded RNG must be installed for captureRandomState/restore to round-trip.
installSeededRandom(0xa11ce);

const world = makeHeadlessWorld(ops);
ops.op_physics_create_world(-9.81);
ops.op_physics_add_ground(0);
const character = new CharacterController(ops, [0, 1.0, 0], { halfHeight: 0.5, radius: 0.35 });
ops.op_physics_step();

// Settle on the ground, then jump and step a few frames INTO the ascending arc.
for (let i = 0; i < 40; i++) { character.step(STILL, DT); ops.op_physics_step(); }
character.step({ forward: 0, strafe: 0, yaw: 0, run: false, jump: true }, DT);
ops.op_physics_step();
for (let i = 0; i < 6; i++) { character.step(STILL, DT); ops.op_physics_step(); }

// MID-JUMP: airborne with a clearly non-zero vertical velocity.
const mid = character.serializeState();
assert(!character.isGrounded, "expected to be airborne mid-jump");
assert(Math.abs(mid.vy) > 1.0, `expected non-trivial vy mid-jump: vy=${mid.vy}`);

// Snapshot the world + character state at the mid-jump tick.
const snap = captureWorldSnapshot(world, { sessionId: "ses_char_snap", tick: 47, snapshotSeq: 0, characters: [character] });
const snapJson = serializeSnapshot(snap);
assert(snap.characters.length === 1 && Object.is(snap.characters[0].vy, mid.vy), "snapshot captured character vy");

// REFERENCE: continue the never-stopped run from mid-jump.
const reference = continueArc(character);

// RESTORE the mid-jump snapshot into the same world + controller, then continue.
restoreSnapshot(world, parseSnapshot(snapJson), [character]);
assert(Object.is(character.serializeState().vy, mid.vy), "restore reinstated character vy");
const restored = continueArc(character);

// The restored continuation must be BIT-IDENTICAL to the reference.
assert(reference.length === restored.length, "continuation length");
for (let i = 0; i < reference.length; i++) {
  assert(Object.is(reference[i], restored[i]), `resume diverged at index ${i}: ${reference[i]} vs ${restored[i]}`);
}

// FALSIFY: corrupt the captured vy -> the restored continuation must diverge,
// proving the controller's vy is load-bearing in the snapshot path.
const corrupt = parseSnapshot(snapJson);
corrupt.characters[0].vy = 0;
restoreSnapshot(world, corrupt, [character]);
const badTraj = continueArc(character);
let diverged = false;
for (let i = 0; i < reference.length; i++) {
  if (!Object.is(reference[i], badTraj[i])) { diverged = true; break; }
}
assert(diverged, "FALSIFY FAILED: corrupting captured vy did not change the resume (controller state not load-bearing)");

ops.op_log(
  `p12_character_snapshot OK: mid-jump (vy=${mid.vy.toFixed(2)}, airborne) snapshot -> restore -> ` +
  `${CONT}-step continuation bit-identical; corrupting vy diverges (falsifiable).`,
);
