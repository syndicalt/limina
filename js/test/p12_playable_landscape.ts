// Phase 12 — headless gate for the PLAYABLE LANDSCAPE (character on the eroded island).
//
// Falsifiable assertions, driving the SAME CharacterController the windowed demo
// (playable_landscape_window.ts) drives, over the SAME deterministic island terrain
// (the high-relief eroded MOUNTAINS region with the coastal island falloff). The
// colliders are built here the exact way world.generateRegion builds them — one
// op_physics_add_heightfield per source.generateTile tile — so this exercises the
// real island surface the player walks, no synthetic ramp.
//
//   1. DETERMINISM   — the SAME scripted command sequence ⇒ byte-identical trajectory
//                       across two independent runs (replay invariant).
//   2. GROUND-FOLLOW — across the eroded relief the capsule center tracks
//                       sampleHeight(x,z) + groundOffset within tolerance (never falls
//                       through the heightfield, never floats off it).
//   3. SLOPES        — the eroded surface is NOT flat: walking varies the capsule's Y
//                       (it climbs/descends real relief) and stays DRY (above sea level).
//   4. FINITE        — every recorded position is finite (no NaN/tunnel blow-up).
//
// Run: ./target/release/limina js/test/p12_playable_landscape.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import { CharacterController, type MoveCommand } from "../src/world/character.ts";
import { ProceduralTerrainSource } from "../src/terrain/procedural.ts";
import { TILE_SIZE } from "../src/terrain/procedural.ts";
import { terrainTypeHints, type TerrainTypeName } from "../src/terrain/terrain-types.ts";
import { surveyRegionRelief } from "../src/terrain/biome-content.ts";

const DT = 1 / 60;

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p12_playable_landscape FAIL: " + msg);
}

// ── ISLAND RECIPE — identical to playable_landscape_window.ts / landscape_window.ts. ──
const SEED = 1234;
const TYPE: TerrainTypeName = "mountains";
const BOUNDS = { minTx: 0, minTz: 0, maxTx: 3, maxTz: 3 } as const;
const SEA_FRACTION = 0.18;
const AMP = 4.5;
const HALF_EXTENT = (Math.min(BOUNDS.maxTx - BOUNDS.minTx, BOUNDS.maxTz - BOUNDS.minTz) + 1) * TILE_SIZE / 2;
const ISLAND = {
  islandCx: ((BOUNDS.minTx + BOUNDS.maxTx + 1) / 2) * TILE_SIZE,
  islandCz: ((BOUNDS.minTz + BOUNDS.maxTz + 1) / 2) * TILE_SIZE,
  islandRadius: HALF_EXTENT * 0.40,
  islandFalloff: HALF_EXTENT * 0.62,
};
const SHAPE = { amp: AMP, erode: 1, ...ISLAND };
const HINTS = { ...terrainTypeHints(TYPE, BOUNDS), ...SHAPE };

const HALF = 0.5;
const RADIUS = 0.35;
const GROUND_OFFSET = HALF + RADIUS;

const source = new ProceduralTerrainSource();
const relief = surveyRegionRelief(source, SEED, BOUNDS, HINTS);
const seaLevel = relief.minY + SEA_FRACTION * (relief.maxY - relief.minY);

// Same dry spawn the demo uses (a mid-flank shelf, offset off the peak).
const SPAWN_X = ISLAND.islandCx - HALF_EXTENT * 0.18;
const SPAWN_Z = ISLAND.islandCz - HALF_EXTENT * 0.18;
const SPAWN_SURFACE_Y = source.sampleHeight(SEED, SPAWN_X, SPAWN_Z, 0, HINTS);
assert(SPAWN_SURFACE_Y > seaLevel + 1, `spawn must be dry: surfaceY=${SPAWN_SURFACE_Y.toFixed(2)} vs sea ${seaLevel.toFixed(2)}`);

/** Build a fresh physics world with the island's heightfield colliders — exactly the
 *  op_physics_add_heightfield calls world.generateRegion issues, one per tile, in the
 *  same deterministic (tz outer, tx inner) order so body-id allocation matches. */
function islandWorld(): void {
  ops.op_physics_create_world(-9.81);
  for (let tz = BOUNDS.minTz; tz <= BOUNDS.maxTz; tz++) {
    for (let tx = BOUNDS.minTx; tx <= BOUNDS.maxTx; tx++) {
      const tile = source.generateTile({ seed: SEED, tx, tz, lod: 0, hints: HINTS });
      const [ox, oy, oz] = tile.origin;
      const [sx, sy, sz] = tile.scale;
      ops.op_physics_add_heightfield(ox, oy, oz, tile.nrows, tile.ncols, sx, sy, sz, tile.heights);
    }
  }
  ops.op_physics_step(); // build the broad-phase BVH so move_character can query it
}

function spawn(): CharacterController {
  return new CharacterController(ops, [SPAWN_X, SPAWN_SURFACE_Y + GROUND_OFFSET + 0.05, SPAWN_Z], {
    halfHeight: HALF, radius: RADIUS,
  });
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

// SCRIPTED SEQUENCE (sim-owned heading, like the demo's fixedStep): settle, walk
// forward, turn, walk a different heading, then settle again — a real traversal that
// crosses eroded relief while staying on the island core.
const SETTLE = 30;
const SEQ: MoveCommand[] = [
  ...rep(STILL, SETTLE),
  ...rep({ forward: 1, strafe: 0, yaw: 0.6, run: false, jump: false }, 80),
  ...rep({ forward: 1, strafe: 0, yaw: 2.4, run: false, jump: false }, 80),
  ...rep({ forward: 1, strafe: 0, yaw: 4.0, run: true, jump: false }, 80),
  ...rep(STILL, 20),
];

// ── 1. DETERMINISM — two independent runs, byte-identical trajectories. ───────────────
function runOnce(): number[] {
  islandWorld();
  return drive(spawn(), SEQ);
}
const trajA = runOnce();
const trajB = runOnce();
assert(trajA.length === trajB.length && trajA.length === SEQ.length * 3, "trajectory length");
for (let i = 0; i < trajA.length; i++) {
  assert(Object.is(trajA[i], trajB[i]), `non-deterministic at index ${i}: ${trajA[i]} vs ${trajB[i]}`);
}

// ── 4. FINITE — no NaN / tunnelling blow-up anywhere. ─────────────────────────────────
for (let i = 0; i < trajA.length; i++) {
  assert(Number.isFinite(trajA[i]), `non-finite position component at index ${i}: ${trajA[i]}`);
}

// ── 2. GROUND-FOLLOW — capsule center tracks the eroded surface (post-settle). ────────
const GROUND_TOL = 0.75; // m — bridges the eroded high-frequency micro-relief under the capsule
let maxFollowErr = 0;
let minY = Infinity;
let maxY = -Infinity;
const steps = trajA.length / 3;
for (let step = SETTLE + 5; step < steps; step++) {
  const x = trajA[step * 3 + 0];
  const y = trajA[step * 3 + 1];
  const z = trajA[step * 3 + 2];
  const expected = source.sampleHeight(SEED, x, z, 0, HINTS) + GROUND_OFFSET;
  maxFollowErr = Math.max(maxFollowErr, Math.abs(y - expected));
  minY = Math.min(minY, y);
  maxY = Math.max(maxY, y);
}
assert(maxFollowErr < GROUND_TOL, `ground-follow broke on the eroded island: maxErr=${maxFollowErr.toFixed(3)}m`);

// ── 3. SLOPES — the walk crossed REAL relief (Y varied) and stayed DRY (above sea). ───
const yRange = maxY - minY;
assert(yRange > 0.5, `expected to cross eroded relief but Y barely varied: range=${yRange.toFixed(3)}m`);
assert(minY > seaLevel + GROUND_OFFSET - 0.1, `walked into the sea: minY=${minY.toFixed(2)} vs sea ${seaLevel.toFixed(2)}`);

// And confirm the character actually traveled (a real traversal, not stuck).
const sx = trajA[SETTLE * 3 + 0], sz = trajA[SETTLE * 3 + 2];
const ex = trajA[(steps - 1) * 3 + 0], ez = trajA[(steps - 1) * 3 + 2];
const traveled = Math.hypot(ex - sx, ez - sz);
assert(traveled > 3, `character did not traverse the island: traveled=${traveled.toFixed(2)}m`);

ops.op_log(
  `p12_playable_landscape OK: island ${TYPE} (relief ${relief.minY.toFixed(1)}..${relief.maxY.toFixed(1)} m, sea ${seaLevel.toFixed(1)} m), ` +
  `determinism (${SEQ.length} steps x2 byte-identical), ground-follow maxErr ${maxFollowErr.toFixed(3)}m, ` +
  `crossed relief ΔY ${yRange.toFixed(2)}m (minY ${minY.toFixed(2)} dry), traveled ${traveled.toFixed(1)}m`,
);
