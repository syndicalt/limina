// Phase 12 — headless gate for the input-driven PLAYER skills (player.* + input.*).
//
// Proves the FIX: the player.* skills now DRIVE the real CharacterController
// (js/src/world/character.ts) through the closure-bound CharacterControllerRegistry,
// instead of reading a never-set `ctx.world.controllers` and no-op'ing. Falsifiable
// assertions, driven by SCRIPTED skill calls over fixed steps:
//
//   1. SPAWN + MOVE     — player.spawn makes a real body; player.move actually moves the
//                          entity (position changes) and reports grounded correctly.
//   2. GROUND-FOLLOW    — on flat terrain the capsule rests on the surface after settling.
//   3. COMMANDED DIR    — walking forward (yaw=0) drives the capsule in world -Z.
//   4. JUMP (bug fix)   — player.jump leaves the ground (height rises) then gravity returns
//                          it to the surface. The old impulse-on-a-kinematic-body never did.
//   5. SPRINT           — sprint makes the SAME number of move steps cover MORE ground.
//   6. INPUT ROUND-TRIP — input.bind -> input.set -> input.action / input.axis read back.
//   7. DETERMINISM      — the SAME spawn/move/jump sequence twice => byte-identical positions.
//   8. HONESTY          — player.move on a missing controller FAILS (no silent success).
//
// Run: ./target/release/limina js/test/p12_player.ts   (exit 0 = pass)

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
  if (!cond) throw new Error("p12_player FAIL: " + msg);
}
function ok(res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) throw new Error("call failed: " + JSON.stringify(res?.error));
  return res.result as Record<string, unknown>;
}

function makeWorld(worldOps: EngineOps): WorldContext {
  const stub = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: stub as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

const HALF = 0.5;
const RADIUS = 0.35;
const GROUND_OFFSET = HALF + RADIUS; // resting capsule-center height above a y=0 surface
const SPAWN: [number, number, number] = [0, GROUND_OFFSET + 0.05, 0];

interface Scenario {
  reg: SkillRegistry;
  base: { agentId: string; sessionId: string; permissions: ReadonlySet<string>; tick: number; world: WorldContext };
}

/** Fresh FLAT world (heightfield surface at y=0) + a fresh core registry/world. The native
 *  physics world is global, so each scenario RESETS it — that (plus the fresh entity table /
 *  controller registry in the closure) is what makes a re-run reproducible. */
function buildScenario(session: string): Scenario {
  ops.op_physics_create_world(-9.81);
  // 2x2 all-zero heightfield => flat plane at y=0 spanning 200x200m centered at origin.
  ops.op_physics_add_heightfield(0, 0, 0, 2, 2, 200, 1, 200, new Float32Array(4));
  ops.op_physics_step(); // build the broad-phase BVH so the first move grounds the capsule
  const reg = new SkillRegistry(new LiminaTracer(session));
  registerCoreSkills(reg);
  const world = makeWorld(ops);
  const base = { agentId: "agt_p12", sessionId: session, permissions: resolveProfile("builder.readWrite"), tick: 0, world };
  return { reg, base };
}

const SETTLE = 30;
const WALK = 120;
const AIR = 90;

/** Run the canonical spawn + settle + walk-forward + jump + arc script, recording the
 *  per-step center position and grounded flag. The trajectory is a pure function of the
 *  scripted commands (fixed step, no wall-clock), so two runs must match bit-for-bit. */
async function runScript(session: string): Promise<{ traj: number[]; grounded: boolean[]; jumped: boolean }> {
  const s = buildScenario(session);
  const entity = ok(await s.reg.invoke("player.spawn", { position: SPAWN }, s.base)).entity as string;
  const traj: number[] = [];
  const grounded: boolean[] = [];
  const record = (r: Record<string, unknown>): void => {
    const p = r.newPosition as [number, number, number];
    traj.push(p[0], p[1], p[2]);
    grounded.push(r.grounded as boolean);
  };
  for (let i = 0; i < SETTLE; i++) record(ok(await s.reg.invoke("player.move", { entity, forward: 0 }, s.base)));
  for (let i = 0; i < WALK; i++) record(ok(await s.reg.invoke("player.move", { entity, forward: 1, yaw: 0 }, s.base)));
  const jr = ok(await s.reg.invoke("player.jump", { entity }, s.base));
  record(jr);
  const jumped = jr.jumped as boolean;
  for (let i = 0; i < AIR; i++) record(ok(await s.reg.invoke("player.move", { entity, forward: 0 }, s.base)));
  return { traj, grounded, jumped };
}

// ── 1 + 2 + 3 + 4 + 7: run the script twice ──────────────────────────────────────────
const A = await runScript("ses_p12_player_A");
const B = await runScript("ses_p12_player_B");
const STEPS = SETTLE + WALK + 1 + AIR;

// 7. DETERMINISM — byte-identical trajectories from the same scripted sequence.
assert(A.traj.length === B.traj.length && A.traj.length === STEPS * 3, "trajectory length mismatch");
for (let i = 0; i < A.traj.length; i++) {
  assert(Object.is(A.traj[i], B.traj[i]), `non-deterministic at index ${i}: ${A.traj[i]} vs ${B.traj[i]}`);
}

// 1. SPAWN + MOVE — the entity actually moved during the walk, and grounded reads true while
//    settled on flat ground.
const settleEnd = SETTLE - 1;
assert(A.grounded[settleEnd] === true, "not grounded after settling on flat ground");
const startZ = A.traj[settleEnd * 3 + 2];

// 2. GROUND-FOLLOW — after settling the capsule center sits at surface(0) + groundOffset.
for (let step = SETTLE - 10; step < SETTLE; step++) {
  const y = A.traj[step * 3 + 1];
  assert(Number.isFinite(y), `y not finite at settle step ${step}`);
  assert(Math.abs(y - GROUND_OFFSET) < 0.1, `not ground-following at step ${step}: y=${y}, expected ~${GROUND_OFFSET}`);
}

// 3. COMMANDED DIRECTION — forward (yaw=0) drives -Z; X stays put.
const walkEnd = SETTLE + WALK - 1;
const endX = A.traj[walkEnd * 3 + 0];
const endZ = A.traj[walkEnd * 3 + 2];
assert(endZ < startZ - 5, `player.move did not move forward (-Z): startZ=${startZ}, endZ=${endZ}`);
assert(Math.abs(endX) < 0.5, `drifted off the commanded axis: endX=${endX}`);

// 4. JUMP (bug fix) — the jump left the ground (a real rise) then gravity returned it.
assert(A.jumped === true, "player.jump reported jumped:false while grounded");
const jumpStep = SETTLE + WALK; // index of the player.jump record
let peak = -Infinity;
let leftGround = false;
for (let step = jumpStep; step < STEPS; step++) {
  peak = Math.max(peak, A.traj[step * 3 + 1]);
  if (A.grounded[step] === false) leftGround = true;
}
assert(leftGround, "jump never reported airborne (grounded stayed true)");
assert(peak > GROUND_OFFSET + 0.5, `jump did not leave the ground: peak=${peak.toFixed(3)}`);
const landY = A.traj[(STEPS - 1) * 3 + 1];
assert(Math.abs(landY - GROUND_OFFSET) < 0.1, `did not land back on the surface: landY=${landY.toFixed(3)}`);

// ── 5: SPRINT changes effective speed ────────────────────────────────────────────────
async function walkForwardDistance(session: string, sprint: boolean): Promise<number> {
  const s = buildScenario(session);
  const entity = ok(await s.reg.invoke("player.spawn", { position: SPAWN }, s.base)).entity as string;
  for (let i = 0; i < SETTLE; i++) ok(await s.reg.invoke("player.move", { entity, forward: 0 }, s.base));
  if (sprint) {
    const sp = ok(await s.reg.invoke("player.sprint", { entity, sprinting: true }, s.base));
    assert(sp.sprinting === true, "player.sprint did not toggle on");
  }
  const before = ok(await s.reg.invoke("player.move", { entity, forward: 0 }, s.base)).newPosition as [number, number, number];
  let last = before;
  for (let i = 0; i < 60; i++) last = ok(await s.reg.invoke("player.move", { entity, forward: 1, yaw: 0 }, s.base)).newPosition as [number, number, number];
  return Math.abs(last[2] - before[2]);
}
const walkDist = await walkForwardDistance("ses_p12_player_walk", false);
const sprintDist = await walkForwardDistance("ses_p12_player_sprint", true);
assert(walkDist > 1, `walk covered no ground: ${walkDist.toFixed(3)}m`);
assert(sprintDist > walkDist * 1.3, `sprint did not change effective speed: walk=${walkDist.toFixed(2)}m sprint=${sprintDist.toFixed(2)}m`);

// ── 6: INPUT round-trip (bind -> set -> action / axis) ────────────────────────────────
{
  const s = buildScenario("ses_p12_player_input");
  assert((ok(await s.reg.invoke("input.bind", { name: "fire", sources: ["key:space", "mouse:left"], type: "action" }, s.base)).ok) === true, "input.bind action failed");
  assert((ok(await s.reg.invoke("input.set", { name: "fire", value: true }, s.base)).ok) === true, "input.set on a bound action failed");
  assert((ok(await s.reg.invoke("input.action", { name: "fire" }, s.base)).active) === true, "input.action did not read back the set state");
  ok(await s.reg.invoke("input.set", { name: "fire", value: false }, s.base));
  assert((ok(await s.reg.invoke("input.action", { name: "fire" }, s.base)).active) === false, "input.action did not clear");

  assert((ok(await s.reg.invoke("input.bind", { name: "throttle", sources: ["gamepad:axis:1"], type: "axis" }, s.base)).ok) === true, "input.bind axis failed");
  ok(await s.reg.invoke("input.set", { name: "throttle", value: 0.75 }, s.base));
  const ax = ok(await s.reg.invoke("input.axis", { name: "throttle" }, s.base)).value as number;
  assert(Object.is(ax, 0.75), `input.axis round-trip wrong: ${ax}`);

  // HONESTY: input.set on an UNBOUND name reports ok:false (no silent success).
  assert((ok(await s.reg.invoke("input.set", { name: "unbound", value: 1 }, s.base)).ok) === false, "input.set on an unbound name claimed success");
}

// ── 8: HONESTY — player.move on a missing controller FAILS (does not report success) ──
{
  const s = buildScenario("ses_p12_player_missing");
  const res = await s.reg.invoke("player.move", { entity: "ent_does_not_exist", forward: 1 }, s.base);
  assert(!res.success, "player.move on a missing controller wrongly succeeded (silent no-op)");
}

ops.op_log(
  `p12_player OK: spawn+move (forward -Z ${(startZ - endZ).toFixed(1)}m), ground-follow (y~${GROUND_OFFSET}), ` +
  `jump bug-fixed (peak ${peak.toFixed(2)} -> land ${landY.toFixed(2)}, airborne reported), ` +
  `sprint walk ${walkDist.toFixed(1)}m vs sprint ${sprintDist.toFixed(1)}m, ` +
  `input bind/set/action/axis round-trip, determinism (${STEPS} steps x2 byte-identical), ` +
  `missing-controller move fails cleanly.`,
);
