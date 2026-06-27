// Phase 12 — headless gate for the input-driven CHARACTER CONTROLLER.
//
// Falsifiable assertions, driven by SCRIPTED command sequences over fixed steps:
//   1. DETERMINISM      — same commands => byte-identical trajectory across two runs.
//   2. GROUND-FOLLOW    — on flat terrain the capsule rests on the surface (center
//                          at surfaceY + groundOffset), never falling through or floating.
//   3. COMMANDED DIR    — walking forward moves the capsule in the commanded world dir.
//   4. GENTLE SLOPE     — walking uphill on a gentle ramp climbs (Y rises).
//   5. STEEP SLOPE      — a too-steep ramp blocks the climb (Y barely rises).
//   6. JUMP             — a jump leaves the ground then lands back on the surface.
//
// Run: ./target/release/limina js/test/p12_character.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import { CharacterController, type MoveCommand } from "../src/world/character.ts";

const DT = 1 / 60;

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p12_character FAIL: " + msg);
}

/** Build a fresh world with a single FLAT heightfield whose surface sits at y=0,
 *  spanning a large area centered on the origin. */
function flatWorld(): void {
  ops.op_physics_create_world(-9.81);
  // 2x2 all-zero heightfield => flat plane at y=0 spanning 200x200m centered at origin.
  ops.op_physics_add_heightfield(0, 0, 0, 2, 2, 200, 1, 200, new Float32Array(4));
  ops.op_physics_step(); // build the broad-phase BVH so move_character can query it
}

const RAMP_SPAN = 40;
/** World surface height of the ramp at world-X `x` for the given angle. The ramp
 *  surface y rises linearly from x=-span/2 (y=0) along +X. */
function rampSurfaceY(angleDeg: number, x: number): number {
  return (x + RAMP_SPAN / 2) * Math.tan((angleDeg * Math.PI) / 180);
}

/** Build a fresh world with a RAMP heightfield rising along +X at the given angle
 *  (degrees). Centered at origin; spans RAMP_SPAN meters in X/Z. */
function rampWorld(angleDeg: number, cols = 41): void {
  ops.op_physics_create_world(-9.81);
  const tan = Math.tan((angleDeg * Math.PI) / 180);
  const dxPerCol = RAMP_SPAN / (cols - 1); // world meters per column step
  const heights = new Float32Array(cols * cols);
  for (let r = 0; r < cols; r++) {
    for (let c = 0; c < cols; c++) {
      // scale_y = 1 below, so the stored height IS the world height: rise = run * tan.
      heights[r * cols + c] = c * dxPerCol * tan;
    }
  }
  ops.op_physics_add_heightfield(0, 0, 0, cols, cols, RAMP_SPAN, 1, RAMP_SPAN, heights);
  ops.op_physics_step();
}

const HALF = 0.5;
const RADIUS = 0.35;
function spawn(x: number, surfaceY: number, z: number): CharacterController {
  const c = new CharacterController(ops, [x, surfaceY + HALF + RADIUS + 0.05, z], {
    halfHeight: HALF,
    radius: RADIUS,
  });
  return c;
}

/** Drive a controller through a command sequence, stepping the sim each frame, and
 *  return the recorded per-step center positions as a flat [x0,y0,z0, x1,...] array. */
function drive(c: CharacterController, cmds: MoveCommand[]): number[] {
  const traj: number[] = [];
  for (const cmd of cmds) {
    c.step(cmd, DT);
    ops.op_physics_step();
    const p = c.position;
    traj.push(p[0], p[1], p[2]);
  }
  return traj;
}

const STILL: MoveCommand = { forward: 0, strafe: 0, yaw: 0, run: false, jump: false };
function rep(cmd: MoveCommand, n: number): MoveCommand[] {
  return Array.from({ length: n }, () => cmd);
}

// ---- 1 + 2 + 3: determinism, ground-follow, commanded direction (flat) --------
// Settle, then walk forward (yaw=0, forward=1 => world -Z) for 2s.
const flatCmds: MoveCommand[] = [
  ...rep(STILL, 30),
  ...rep({ forward: 1, strafe: 0, yaw: 0, run: false, jump: false }, 120),
];

function runFlat(): number[] {
  flatWorld();
  const c = spawn(0, 0, 0);
  return drive(c, flatCmds);
}

const trajA = runFlat();
const trajB = runFlat();

// 1. DETERMINISM — byte-identical trajectories.
assert(trajA.length === trajB.length && trajA.length === flatCmds.length * 3, "trajectory length");
for (let i = 0; i < trajA.length; i++) {
  assert(Object.is(trajA[i], trajB[i]), `non-deterministic at index ${i}: ${trajA[i]} vs ${trajB[i]}`);
}

// 2. GROUND-FOLLOW — after settling, the capsule center sits at surface(0) + groundOffset.
const groundOffset = HALF + RADIUS;
for (let step = 40; step < flatCmds.length; step++) {
  const y = trajA[step * 3 + 1];
  assert(Number.isFinite(y), `y not finite at step ${step}`);
  assert(
    Math.abs(y - groundOffset) < 0.1,
    `not ground-following at step ${step}: y=${y}, expected ~${groundOffset}`,
  );
}

// 3. COMMANDED DIRECTION — forward (yaw=0) drives -Z; X stays put.
const startZ = trajA[30 * 3 + 2];
const endX = trajA[(flatCmds.length - 1) * 3 + 0];
const endZ = trajA[(flatCmds.length - 1) * 3 + 2];
assert(endZ < startZ - 5, `did not move forward (-Z): startZ=${startZ}, endZ=${endZ}`);
assert(Math.abs(endX) < 0.5, `drifted off the commanded axis: endX=${endX}`);

// ---- 4 + 5: slope handling -----------------------------------------------------
// Walk uphill (+X via strafe=1, yaw=0) from near the bottom of a ramp.
const uphill = rep({ forward: 0, strafe: 1, yaw: 0, run: false, jump: false }, 150);

// 4. GENTLE 15deg ramp — should climb a meaningful height.
rampWorld(15);
const gentle = spawn(-18, rampSurfaceY(15, -18), 0); // x=-18 near the low edge (x in [-20,20])
const gentleTraj = drive(gentle, [...rep(STILL, 30), ...uphill]);
const gentleStartY = gentleTraj[30 * 3 + 1];
const gentleEndY = gentleTraj[(gentleTraj.length / 3 - 1) * 3 + 1];
const gentleGain = gentleEndY - gentleStartY;
assert(gentleGain > 1.0, `gentle slope was not climbed: gain=${gentleGain.toFixed(3)}m`);

// 5. STEEP 70deg ramp — too steep to climb (> 50deg slope limit); barely rises.
rampWorld(70);
const steep = spawn(-18, rampSurfaceY(70, -18), 0);
const steepTraj = drive(steep, [...rep(STILL, 30), ...uphill]);
const steepStartY = steepTraj[30 * 3 + 1];
const steepEndY = steepTraj[(steepTraj.length / 3 - 1) * 3 + 1];
const steepGain = steepEndY - steepStartY;
assert(steepGain < 0.5, `steep slope was wrongly climbed: gain=${steepGain.toFixed(3)}m`);
assert(gentleGain > steepGain * 2, `slope limit not discriminating: gentle=${gentleGain.toFixed(3)} steep=${steepGain.toFixed(3)}`);

// ---- 5b: DOWNHILL ground-follow (revert-proofs snap_to_ground) -----------------
// Walk DOWN a 30deg ramp at run speed. snap_to_ground only matters DESCENDING: with
// it, the capsule sticks to the falling surface; with snap_to_ground=None the surface
// drops faster than per-step gravity can, so the capsule floats above it and this
// tight tolerance fails. (Walk -X via strafe=-1 from the high end.)
const DOWN_ANGLE = 30;
rampWorld(DOWN_ANGLE);
const downhillCmds = rep({ forward: 0, strafe: -1, yaw: 0, run: true, jump: false }, 120);
const downhill = spawn(18, rampSurfaceY(DOWN_ANGLE, 18), 0); // x=+18 high end
const downTraj = drive(downhill, [...rep(STILL, 40), ...downhillCmds]);
const downSteps = downTraj.length / 3;
let maxFollowErr = 0;
for (let step = 50; step < downSteps; step++) {
  const x = downTraj[step * 3 + 0];
  const y = downTraj[step * 3 + 1];
  assert(Number.isFinite(y), `downhill y not finite at step ${step}`);
  const expected = rampSurfaceY(DOWN_ANGLE, x) + groundOffset;
  maxFollowErr = Math.max(maxFollowErr, Math.abs(y - expected));
}
assert(maxFollowErr < 0.15, `downhill ground-follow broke (snap_to_ground?): maxErr=${maxFollowErr.toFixed(3)}m`);
// And confirm it actually descended (a real downhill walk, not a no-op).
const downStartY = downTraj[40 * 3 + 1];
const downEndY = downTraj[(downSteps - 1) * 3 + 1];
assert(downStartY - downEndY > 2.0, `did not descend the ramp: start=${downStartY.toFixed(2)} end=${downEndY.toFixed(2)}`);

// ---- 6: jump -------------------------------------------------------------------
flatWorld();
const jumper = spawn(0, 0, 0);
// Settle, single jump impulse, then hold still while it arcs + lands.
const jumpCmds: MoveCommand[] = [
  ...rep(STILL, 30),
  { forward: 0, strafe: 0, yaw: 0, run: false, jump: true },
  ...rep(STILL, 90),
];
const jumpTraj = drive(jumper, jumpCmds);
let peak = -Infinity;
for (let step = 31; step < jumpCmds.length; step++) peak = Math.max(peak, jumpTraj[step * 3 + 1]);
assert(peak > groundOffset + 0.5, `jump did not leave the ground: peak=${peak.toFixed(3)}`);
const landY = jumpTraj[(jumpCmds.length - 1) * 3 + 1];
assert(Math.abs(landY - groundOffset) < 0.1, `did not land back on the surface: landY=${landY.toFixed(3)}`);

ops.op_log(
  `p12_character OK: determinism (${flatCmds.length} steps x2 byte-identical), ` +
  `ground-follow (y~${groundOffset}), forward dir (-Z ${(startZ - endZ).toFixed(1)}m), ` +
  `gentle-slope climb ${gentleGain.toFixed(2)}m vs steep-slope ${steepGain.toFixed(2)}m, ` +
  `downhill follow maxErr ${maxFollowErr.toFixed(3)}m (descended ${(downStartY - downEndY).toFixed(1)}m), ` +
  `jump peak ${peak.toFixed(2)} -> land ${landY.toFixed(2)}`,
);
