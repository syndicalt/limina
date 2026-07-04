// P83 — headless COLLISION gate for the WALKABLE settlement wiring.
//
// Proves the two load-bearing colliders this feature adds, end-to-end, with a REAL player character
// controller driven by SCRIPTED input over fixed steps (deterministic — no wall-clock, no random):
//
//   1. GROUND (terrain.create heightfield collider) — a player spawned ABOVE a terrain.create layer
//      DROPS and RESTS on its surface (Y ~ terrain height), instead of falling forever. This is the
//      load-bearing fix: terrain.create now builds a Rapier heightfield collider (mirroring
//      world.generateRegion), so the ground is solid.
//   2. FORWARD MOVE — on flat ground the capsule walks forward (world -Z at yaw 0).
//   3. BUILDING BLOCK (static box collider) — a static box in the player's path STOPS it: the
//      capsule cannot enter the box. The box mirrors what asset.place / village.build now emit per
//      building (op_physics_add_static_box over the placed AABB). A NO-BOX control walks straight
//      through the same spot, proving the box — not the step budget — is what blocks.
//   4. DETERMINISM — the same spawn/move script twice ⇒ byte-identical trajectories.
//
// Run: ./target/release/limina js/test/p83_player_collision.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p83_player_collision FAIL: " + msg);
}
function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return res.result as Record<string, unknown>;
}

function makeWorld(worldOps: EngineOps): WorldContext {
  // A stub scene whose add()/remove() are no-ops (headless): terrain.create still builds its tile +
  // heightfield collider; the render mesh is best-effort and irrelevant to the physics assertions.
  const stub = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: stub as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

// player.spawn defaults: halfHeight 0.5, radius 0.35 ⇒ resting center sits GROUND_OFFSET above a
// surface. terrain.create with baseHeight 0 ⇒ a flat heightfield surface at y=0.
const GROUND_OFFSET = 0.5 + 0.35; // 0.85
const SPAWN: [number, number, number] = [0, 5, 0]; // well above the surface, so it must DROP onto it

// The building box sits in the forward (-Z) path: center (0, 1, -3), half-extents (1,1,1) ⇒ it
// occupies z ∈ [-4, -2], y ∈ [0, 2]. A capsule of radius 0.35 walking toward -Z is stopped with its
// surface against the +Z face, i.e. at z ≈ -2 + 0.35 = -1.65 (never inside the box).
const BOX_CENTER: [number, number, number] = [0, 1, -3];
const BOX_FRONT_Z = -2; // the +Z face of the box

const SETTLE = 60; // steps to drop + settle on the surface
const WALK = 90;   // forward steps; at 4.5 m/s * (1/60) ≈ 0.075 m/step ⇒ ~6.75 m unobstructed

const perms = resolveProfile("builder.readWrite");

interface Run { traj: number[]; grounded: boolean[] }

/** Fresh native physics world + core registry. Author a terrain.create heightfield, OPTIONALLY a
 *  building box, spawn a player above the surface, settle it, then walk it forward — recording the
 *  per-step center position + grounded flag. Pure function of the scripted commands ⇒ replayable. */
async function run(session: string, withBox: boolean): Promise<Run> {
  ops.op_physics_create_world(-9.81);
  const reg = new SkillRegistry(new LiminaTracer(session));
  registerCoreSkills(reg);
  const world = makeWorld(ops);
  const at = (tick: number) => ({ agentId: "agt_p83", sessionId: session, permissions: perms, tick, world });

  // 1. GROUND — terrain.create builds the flat heightfield + (new) its Rapier heightfield collider.
  ok(await reg.invoke("terrain.create", { size: 100, resolution: 33, baseHeight: 0 }, at(1)));
  // 3. BUILDING — the static box collider asset.place/village.build now emit per placed structure.
  if (withBox) ops.op_physics_add_static_box(BOX_CENTER[0], BOX_CENTER[1], BOX_CENTER[2], 1, 1, 1, 0.85, 0);
  ops.op_physics_step(); // build the broad-phase BVH so the first move grounds against the terrain

  const entity = ok(await reg.invoke("player.spawn", { position: SPAWN }, at(2))).entity as string;

  const traj: number[] = [];
  const grounded: boolean[] = [];
  const record = (r: Record<string, unknown>): void => {
    const p = r.newPosition as [number, number, number];
    traj.push(p[0], p[1], p[2]);
    grounded.push(r.grounded as boolean);
  };
  for (let i = 0; i < SETTLE; i++) record(ok(await reg.invoke("player.move", { entity, forward: 0 }, at(3))));
  for (let i = 0; i < WALK; i++) record(ok(await reg.invoke("player.move", { entity, forward: 1, yaw: 0 }, at(4))));
  return { traj, grounded };
}

const z = (r: Run, step: number): number => r.traj[step * 3 + 2];
const y = (r: Run, step: number): number => r.traj[step * 3 + 1];
const x = (r: Run, step: number): number => r.traj[step * 3 + 0];

// ── Author + walk WITH the building box, twice (determinism), and a NO-BOX control ──
const A = await run("ses_p83_box_A", true);
const B = await run("ses_p83_box_B", true);
const CTRL = await run("ses_p83_nobox", false);

const settleEnd = SETTLE - 1;
const walkEnd = SETTLE + WALK - 1;

// 1. GROUND — after settling the capsule RESTS on the terrain surface (did NOT fall through). Without
//    the terrain.create heightfield collider it would keep falling (Y → large negative, never grounded).
assert(A.grounded[settleEnd] === true, "player never grounded on the terrain.create surface (fell through — no ground collider?)");
for (let step = SETTLE - 10; step < SETTLE; step++) {
  assert(Number.isFinite(y(A, step)), `Y not finite at settle step ${step}`);
  assert(Math.abs(y(A, step) - GROUND_OFFSET) < 0.1, `not resting on the surface at step ${step}: Y=${y(A, step).toFixed(3)}, expected ~${GROUND_OFFSET}`);
}
const startZ = z(A, settleEnd);
assert(Math.abs(startZ) < 0.2, `unexpected settle drift in Z: ${startZ.toFixed(3)}`);

// 2. FORWARD MOVE — a few steps in, the capsule has advanced toward -Z on flat ground before it can
//    reach the box (box front is at z=-2; a few steps only reach ~-0.4).
const earlyWalk = SETTLE + 5;
assert(z(A, earlyWalk) < startZ - 0.15, `player did not walk forward (-Z) on flat ground: startZ=${startZ.toFixed(3)}, z@+5=${z(A, earlyWalk).toFixed(3)}`);
assert(Math.abs(x(A, earlyWalk)) < 0.2, `drifted off the commanded axis while walking: X=${x(A, earlyWalk).toFixed(3)}`);

// 3. BUILDING BLOCK — WITH the box, the capsule is STOPPED in front of it: its final Z never crosses
//    the box's +Z face (stays > BOX_FRONT_Z, i.e. never enters the box). The NO-BOX control, run with
//    the identical script, walks straight PAST that plane — so the box (not the step budget) blocks.
const finalZbox = z(A, walkEnd);
const finalZctrl = z(CTRL, walkEnd);
assert(finalZbox > BOX_FRONT_Z, `player entered the building box: finalZ=${finalZbox.toFixed(3)} (box front at ${BOX_FRONT_Z})`);
assert(finalZbox > BOX_FRONT_Z - 0.36 - 0.15, `player penetrated the box more than a capsule radius: finalZ=${finalZbox.toFixed(3)}`);
assert(finalZctrl < BOX_FRONT_Z - 1.0, `NO-BOX control did not walk past the box plane (script too short to prove blocking): ctrlZ=${finalZctrl.toFixed(3)}`);
assert(finalZbox > finalZctrl + 1.0, `the box did not stop the player short of the unobstructed control: box=${finalZbox.toFixed(3)} vs ctrl=${finalZctrl.toFixed(3)}`);

// 4. DETERMINISM — the same scripted run twice is byte-identical.
assert(A.traj.length === B.traj.length, "trajectory length mismatch across runs");
for (let i = 0; i < A.traj.length; i++) {
  assert(Object.is(A.traj[i], B.traj[i]), `non-deterministic at index ${i}: ${A.traj[i]} vs ${B.traj[i]}`);
}

ops.op_log(
  `[js] p83_player_collision OK: terrain.create heightfield collider holds the player on the surface ` +
  `(Y~${GROUND_OFFSET}, grounded), forward walk drives -Z, a static building box STOPS the capsule at ` +
  `z=${finalZbox.toFixed(2)} (never past the ${BOX_FRONT_Z} face) while the no-box control reaches ` +
  `z=${finalZctrl.toFixed(2)}, and the scripted run replays byte-identically.`,
);
