// Billiards physics acceptance test (headless: pure native Rapier + bitECS, no
// window, no renderer). Racks a triangle of dynamic spheres plus a cue ball
// inside a bordered table built from static-box rails, applies a cue-break
// impulse, and steps the fixed-timestep sim. Asserts REAL emergent behaviour:
//   (a) the cue ball moved from its start,
//   (b) the break propagated through contacts (a racked ball was set in motion),
//   (c) at least one ball ROLLED (its orientation quaternion left identity),
//   (d) no ball tunnelled through a rail (everyone stayed within the cushions),
//   (e) the simulation is deterministic (two identical breaks => bit-identical
//       final positions).
// Every transform is read back from the native body through the same
// `syncPhysicsBodyTransform` ECS bridge the renderer consumes, so the test fails
// if rolling, containment, propagation, or determinism regress.

import { ops } from "../src/engine.ts";
import {
  createEcsWorld,
  Position,
  Rotation,
  spawnRenderable,
  syncPhysicsBodyTransform,
} from "../src/ecs/world.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("billiards_physics: " + message);
}

// ---- Table + rack geometry (shared shape with the windowed demo) ----------
const BALL_R = 0.5;
const BALL_FRICTION = 0.2; // low: a billiards ball glides on the cloth
const BALL_RESTITUTION = 0.9; // moderately lively ball-to-ball rebound
const RAIL_FRICTION = 0.3;
const RAIL_RESTITUTION = 0.6; // cushions absorb some energy
const GROUND_Y = 0; // top surface of the playfield
const BALL_Y = GROUND_Y + BALL_R; // ball centre rests on the cloth

// Interior playfield half-extents (centre-to-inner-face) and rail dimensions.
const IX = 8; // playfield spans x in [-8, 8]
const IZ = 4; // playfield spans z in [-4, 4]
const RAIL_HALF_T = 0.25; // rail half thickness
const RAIL_HALF_H = 0.75; // rail half height (top at y=1.5, above ball top 1.0)
const RAIL_CY = RAIL_HALF_H; // rail centre y so its base sits on the ground

// Triangle rack: apex toward +x (toward the cue), four rows of 1+2+3+4 = 10.
const PITCH = 1.05; // centre spacing in a row (> 2R so balls start just apart)
const ROW_PITCH = PITCH * Math.cos(Math.PI / 6); // perpendicular row spacing
const APEX_X = -1; // apex ball x; rows extend toward -x
const CUE_X = 5; // cue ball sits down-table from the apex
const CUE_IMPULSE = 13.0; // toward -x (into the rack); v0 ~= 24.8 m/s (near the no-CCD tunneling ceiling)

const STEPS = 240; // ~4 s at the fixed dt of 1/60

interface BallSpec {
  x: number;
  z: number;
  cue: boolean;
}

/** Cue ball + the 10-ball triangle, in stable creation order (cue first). */
function ballLayout(): BallSpec[] {
  const balls: BallSpec[] = [{ x: CUE_X, z: 0, cue: true }];
  for (let row = 0; row <= 3; row++) {
    const x = APEX_X - row * ROW_PITCH;
    for (let k = 0; k <= row; k++) {
      const z = (k - row / 2) * PITCH;
      balls.push({ x, z, cue: false });
    }
  }
  return balls;
}

interface BreakResult {
  start: number[][]; // [x,y,z] per ball at t=0
  final: number[]; // flat [x,y,z, x,y,z, ...] at the end (determinism key)
  minW: number[]; // min |quaternion.w| seen per ball over the whole run
  boundsViolated: boolean; // any ball left the cushioned interior at any step
  ballCount: number;
}

/** Build a fresh table + rack, break, and step the sim, reading every body's
 *  transform back through the ECS bridge each step. */
function runBreak(steps: number): BreakResult {
  ops.op_physics_create_world(-9.81);
  ops.op_physics_add_ground(GROUND_Y);

  // Four static-box rails forming the rectangular border. Long rails run along
  // x at z = +/-(IZ + RAIL_HALF_T); short rails along z at x = +/-(IX + ...).
  const railZ = IZ + RAIL_HALF_T;
  const railX = IX + RAIL_HALF_T;
  ops.op_physics_add_static_box(0, RAIL_CY, railZ, IX + 2 * RAIL_HALF_T, RAIL_HALF_H, RAIL_HALF_T, RAIL_FRICTION, RAIL_RESTITUTION);
  ops.op_physics_add_static_box(0, RAIL_CY, -railZ, IX + 2 * RAIL_HALF_T, RAIL_HALF_H, RAIL_HALF_T, RAIL_FRICTION, RAIL_RESTITUTION);
  ops.op_physics_add_static_box(railX, RAIL_CY, 0, RAIL_HALF_T, RAIL_HALF_H, IZ + 2 * RAIL_HALF_T, RAIL_FRICTION, RAIL_RESTITUTION);
  ops.op_physics_add_static_box(-railX, RAIL_CY, 0, RAIL_HALF_T, RAIL_HALF_H, IZ + 2 * RAIL_HALF_T, RAIL_FRICTION, RAIL_RESTITUTION);

  const layout = ballLayout();
  const world = createEcsWorld();
  const dummy = { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };
  const eids: number[] = [];
  const bodyIds: number[] = [];
  let cueBody = -1;
  for (const b of layout) {
    const bodyId = ops.op_physics_add_sphere(b.x, BALL_Y, b.z, BALL_R, BALL_FRICTION, BALL_RESTITUTION);
    // A distinct dummy per entity: spawnRenderable binds eid -> object.
    const eid = spawnRenderable(world, { ...dummy }, b.x, BALL_Y, b.z);
    bodyIds.push(bodyId);
    eids.push(eid);
    if (b.cue) cueBody = bodyId;
  }
  assert(cueBody >= 0, "cue ball was not created");

  // Cue break: drive the cue straight into the rack apex (toward -x).
  ops.op_physics_apply_impulse(cueBody, -CUE_IMPULSE, 0, 0);

  const scratch = new Float32Array(7);
  const start: number[][] = [];
  const minW: number[] = new Array(eids.length).fill(1);

  // Capture starting positions from the bodies directly.
  for (let i = 0; i < eids.length; i++) {
    syncPhysicsBodyTransform(eids[i], bodyIds[i], ops, scratch);
    start.push([Position.x[eids[i]], Position.y[eids[i]], Position.z[eids[i]]]);
  }

  let boundsViolated = false;
  for (let s = 0; s < steps; s++) {
    ops.op_physics_step();
    for (let i = 0; i < eids.length; i++) {
      const eid = eids[i];
      syncPhysicsBodyTransform(eid, bodyIds[i], ops, scratch);
      const px = Position.x[eid];
      const py = Position.y[eid];
      const pz = Position.z[eid];
      // Containment: a ball centre may legitimately reach IX-R / IZ-R against a
      // cushion; exceeding the inner rail face (IX / IZ) means it tunnelled.
      if (Math.abs(px) > IX || Math.abs(pz) > IZ || py < GROUND_Y - 0.25 || !Number.isFinite(px)) {
        boundsViolated = true;
      }
      const w = Math.abs(Rotation.w[eid]);
      if (w < minW[i]) minW[i] = w;
    }
  }

  const final: number[] = [];
  for (let i = 0; i < eids.length; i++) {
    final.push(Position.x[eids[i]], Position.y[eids[i]], Position.z[eids[i]]);
  }

  return { start, final, minW, boundsViolated, ballCount: eids.length };
}

// ---- Run 1: behavioural assertions ----------------------------------------
const r1 = runBreak(STEPS);

const cueFinal = [r1.final[0], r1.final[1], r1.final[2]];
const cueDelta = Math.hypot(cueFinal[0] - r1.start[0][0], cueFinal[1] - r1.start[0][1], cueFinal[2] - r1.start[0][2]);

let movedRacked = 0;
let maxRackedDelta = 0;
for (let i = 1; i < r1.ballCount; i++) {
  const s = r1.start[i];
  const d = Math.hypot(r1.final[i * 3] - s[0], r1.final[i * 3 + 1] - s[1], r1.final[i * 3 + 2] - s[2]);
  if (d > 0.05) movedRacked++;
  if (d > maxRackedDelta) maxRackedDelta = d;
}

let rolledBalls = 0;
let minWSeen = 1;
for (let i = 0; i < r1.ballCount; i++) {
  if (r1.minW[i] < 0.9) rolledBalls++;
  if (r1.minW[i] < minWSeen) minWSeen = r1.minW[i];
}

ops.op_log(
  `billiards: balls=${r1.ballCount} (1 cue + 10 racked) cueDelta=${cueDelta.toFixed(3)} ` +
    `rackedMoved=${movedRacked} maxRackedDelta=${maxRackedDelta.toFixed(3)} ` +
    `rolled=${rolledBalls} min|w|=${minWSeen.toFixed(3)} bounds=${r1.boundsViolated ? "ESCAPED" : "ok"}`,
);

// (a) the cue ball moved from where it was racked.
assert(cueDelta > 0.1, `cue ball did not move (delta ${cueDelta.toFixed(4)})`);
// (b) the break propagated: at least one racked ball was set in motion.
assert(movedRacked >= 1, "no racked ball was set in motion by the break");
// (c) at least one ball rolled (orientation left identity) rather than slid.
assert(rolledBalls >= 1, `no ball rolled (min |quaternion.w| was ${minWSeen.toFixed(4)})`);
// (d) every ball stayed inside the cushions for the whole run (no tunnelling).
assert(!r1.boundsViolated, "a ball tunnelled through a rail / left the table");

// ---- (e) Determinism: an identical break must reproduce bit-for-bit --------
const r2 = runBreak(STEPS);
assert(r1.final.length === r2.final.length, "ball count diverged between runs");
for (let i = 0; i < r1.final.length; i++) {
  assert(
    r1.final[i] === r2.final[i],
    `nondeterministic: component ${i} differed (${r1.final[i]} vs ${r2.final[i]})`,
  );
}

ops.op_log(
  "billiards_physics OK: cue broke the rack, balls rolled in-bounds, and the break is deterministic",
);
