// Phase 14 — SCRIPTED NPC RUNTIME (non-LLM brain). Pins the honest behaviour of
// js/src/world/npc_runtime.ts: a deterministic patrol over the grid navmesh that
// drives a render-only model and raises a "wants to talk" signal near the player.
//
//   1. PATROL + ARRIVAL + CYCLING: ticking advances the NPC toward waypoint 1,
//      it REACHES it (within the arrival epsilon), then the runtime cycles to
//      waypoint 2 and advances toward it. Position progresses monotonically
//      toward the live target; the waypoint index actually advances.
//   2. LOCOMOTION GAIT: the model records "walk" while the NPC is moving toward a
//      waypoint and "idle" once it has arrived / is blocked. Asserted via a STUB
//      model that records every setPose/setLocomotion/syncSkinning call (no real
//      CharacterModel needed headless — the runtime drives the sim position on
//      its own; the model is render-only + OPTIONAL).
//   3. PERCEPTION / TALK SIGNAL: wantsToTalk() is false when the player is far and
//      TRUE when playerPos enters talkRadius; state() flips patrol↔greet and the
//      NPC stops + faces the player while greeting.
//   4. DETERMINISM: the SAME tick sequence on a FRESH NPC reproduces the identical
//      position trajectory + state sequence + locomotion sequence, bit-for-bit
//      (movement is pure-helper math over the deterministic A* path — no RNG, no
//      wall-clock — so run-twice identity is the determinism proof).
//
// Run: limina js/test/p14_npc.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import { NavmeshManager } from "../src/skills/navmesh.ts";
import { ScriptedNpc, type NpcVisual } from "../src/world/npc_runtime.ts";
import type { LocomotionState } from "../src/world/character_model.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p14_npc FAIL: " + msg);
}
type V3 = [number, number, number];
const distXZ = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[2] - b[2]);

// ── A recording STUB model (the render-only visual surface the runtime drives).
// It is NOT a real glTF rig — headless needs none; the runtime advances the sim
// position itself and the model is purely a render sink. We record every call so
// the test can assert the gait + the per-frame sync contract.
interface PoseCall { foot: V3; yaw: number; }
class StubModel implements NpcVisual {
  readonly poses: PoseCall[] = [];
  readonly locomotion: LocomotionState[] = [];
  syncCount = 0;
  setPose(footPos: readonly [number, number, number], yaw: number): void {
    this.poses.push({ foot: [footPos[0], footPos[1], footPos[2]], yaw });
  }
  setLocomotion(state: LocomotionState, _dt: number): void {
    this.locomotion.push(state);
  }
  syncSkinning(): void {
    this.syncCount++;
  }
}

// ── World stub: the runtime only needs world for future skill routing; it drives
// the NavmeshManager directly, so a bare object satisfies the (unused-at-runtime)
// WorldContext slot. registry/base are likewise contract-only here.
const FAKE_WORLD = {} as unknown as ConstructorParameters<typeof ScriptedNpc>[0]["world"];
const FAKE_REGISTRY = {} as unknown as ConstructorParameters<typeof ScriptedNpc>[0]["registry"];
const FAKE_BASE = {} as unknown as ConstructorParameters<typeof ScriptedNpc>[0]["base"];

// ── Build a small open grid navmesh (10×10, cellSize 1) — the NPC's walkable region.
const REGION = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 } as const;
function freshNav(): NavmeshManager {
  const nav = new NavmeshManager();
  const r = nav.build({ bounds: REGION, cellSize: 1 });
  assert(r.ok && r.blocked === 0, "navmesh.build failed for the open grid");
  return nav;
}

// Patrol: three waypoints forming an L. Start at WP0; the loop is WP0→WP1→WP2→WP0…
const WP: [number, number][] = [
  [1, 1],
  [8, 1],
  [8, 8],
];
const W0: V3 = [WP[0][0], 0, WP[0][1]];
const W1: V3 = [WP[1][0], 0, WP[1][1]];
const W2: V3 = [WP[2][0], 0, WP[2][1]];
const SPEED = 3;
const TALK_RADIUS = 2;
const DT = 1 / 60;
const FAR_PLAYER: V3 = [50, 0, 50]; // way outside talkRadius

function makeNpc(nav: NavmeshManager, model?: NpcVisual): ScriptedNpc {
  return new ScriptedNpc(
    { registry: FAKE_REGISTRY, base: FAKE_BASE, world: FAKE_WORLD, model, navmeshManager: nav, regionId: "rgn_p14" },
    { waypoints: WP, speed: SPEED, talkRadius: TALK_RADIUS, arriveEps: 0.2, startPos: W0, startYaw: 0 },
  );
}

// ─────────────────────────── 1+2. PATROL, ARRIVAL, CYCLING, GAIT ───────────────────────────
const nav = freshNav();
const model = new StubModel();
const npc = makeNpc(nav, model);

// Frame 0 (constructor) already posed + idled the model.
assert(model.poses.length === 1 && model.locomotion.length === 1 && model.locomotion[0] === "idle", "constructor did not pose+idle the model on frame 0");

const startToW1 = distXZ(npc.position(), W1);
assert(distXZ(npc.position(), W0) < 1e-9, "NPC did not spawn at waypoint 0");

// Walk until the NPC has reached W1 (its FIRST patrol target). Track that distance
// to the live target strictly decreases while it is walking toward it.
let reachedW1 = false;
let reachedW2 = false;
let prevDistToTarget = Infinity;
let sawWalk = false;
let walkingTowardW1 = true;
let cycledToW2Index = false;

let t = 0;
for (; t < 4000; t++) {
  const before = npc.position();
  npc.tick(DT, FAR_PLAYER);
  const after = npc.position();
  assert(npc.wantsToTalk() === false, "wantsToTalk true with the player far away");
  assert(npc.state() === "patrol", "state not patrol while the player is far");

  const loco = model.locomotion[model.locomotion.length - 1];
  if (loco === "walk") sawWalk = true;

  // Phase A: heading to W1. distance to W1 must strictly decrease until arrival.
  if (!reachedW1 && walkingTowardW1) {
    const d = distXZ(after, W1);
    if (d > 0.2 + 1e-6) {
      assert(d < prevDistToTarget + 1e-9, `distance to W1 did not progress: ${d} >= ${prevDistToTarget}`);
      // While genuinely walking toward W1 the gait must be "walk".
      if (distXZ(before, after) > 1e-9) assert(loco === "walk", "gait not 'walk' while moving toward W1");
    }
    prevDistToTarget = d;
    if (d <= 0.2 + 1e-6) {
      reachedW1 = true;
      walkingTowardW1 = false;
      prevDistToTarget = Infinity;
    }
  } else if (reachedW1 && !reachedW2) {
    // Phase B: after arriving at W1 the runtime cycled to W2 — now closing on W2.
    cycledToW2Index = true;
    const d = distXZ(after, W2);
    if (d <= 0.2 + 1e-6) {
      reachedW2 = true;
      break;
    }
  }
}
assert(reachedW1, `NPC never reached waypoint 1 in ${t} steps`);
assert(sawWalk, "NPC never reported a 'walk' gait while patrolling");
assert(cycledToW2Index, "runtime did not cycle to waypoint 2 after reaching waypoint 1");
assert(reachedW2, "NPC never reached waypoint 2 after cycling");

// Distance W0→W1 is 7 units at speed 3 ⇒ ≈ 140 steps minimum: arrival is a real walk.
assert(t > 100, `reached W1+W2 implausibly fast (${t} steps) — not actually walking the path`);

// ── GAIT settles to idle once arrived/blocked: pin a stationary single-waypoint NPC.
const navIdle = freshNav();
const idleModel = new StubModel();
const idleNpc = new ScriptedNpc(
  { registry: FAKE_REGISTRY, base: FAKE_BASE, world: FAKE_WORLD, model: idleModel, navmeshManager: navIdle, regionId: "rgn_idle" },
  { waypoints: [[5, 5]], speed: SPEED, talkRadius: TALK_RADIUS, startPos: [5, 0, 5] },
);
for (let i = 0; i < 5; i++) idleNpc.tick(DT, FAR_PLAYER);
const tailIdle = idleModel.locomotion.slice(-3);
assert(tailIdle.every((s) => s === "idle"), `NPC standing on its only waypoint should idle, got ${tailIdle.join(",")}`);
assert(distXZ(idleNpc.position(), [5, 0, 5]) < 1e-9, "stationary NPC drifted off its waypoint");

// ── syncSkinning passthrough reaches the model.
const beforeSync = idleModel.syncCount;
idleNpc.syncSkinning();
assert(idleModel.syncCount === beforeSync + 1, "syncSkinning() did not pass through to the model");

// ── Model is OPTIONAL: a model-less NPC still advances its sim position.
const navHeadless = freshNav();
const headlessNpc = makeNpc(navHeadless, undefined);
const hStart = headlessNpc.position();
for (let i = 0; i < 30; i++) headlessNpc.tick(DT, FAR_PLAYER);
assert(distXZ(headlessNpc.position(), hStart) > 0.5, "model-less NPC did not advance its sim position");

// ─────────────────────────── 3. PERCEPTION / TALK SIGNAL ───────────────────────────
const navTalk = freshNav();
const talkNpc = makeNpc(navTalk, undefined);
// Far player → no talk.
talkNpc.tick(DT, FAR_PLAYER);
assert(talkNpc.wantsToTalk() === false && talkNpc.state() === "patrol", "talk signal raised with a far player");
// Player steps onto the NPC's current position → inside talkRadius → wantsToTalk.
const here = talkNpc.position();
const nearPlayer: V3 = [here[0] + 1, 0, here[2]]; // 1 unit away < talkRadius 2
const posBeforeGreet = talkNpc.position();
talkNpc.tick(DT, nearPlayer);
assert(talkNpc.wantsToTalk() === true, "wantsToTalk false when the player is inside talkRadius");
assert(talkNpc.state() === "greet", "state not 'greet' when the player is near");
// Greeting NPC stops moving and faces the player.
assert(distXZ(talkNpc.position(), posBeforeGreet) < 1e-9, "NPC moved while greeting (should stop)");
const expectedYaw = Math.atan2(nearPlayer[0] - here[0], nearPlayer[2] - here[2]);
assert(Math.abs(talkNpc.facing() - expectedYaw) < 1e-9, `NPC did not face the player while greeting (yaw ${talkNpc.facing()} != ${expectedYaw})`);
// Player leaves → back to patrol, signal drops.
talkNpc.tick(DT, FAR_PLAYER);
assert(talkNpc.wantsToTalk() === false && talkNpc.state() === "patrol", "talk signal stuck on after the player left");

// ─────────────────────────── 4. DETERMINISM — run-twice identity ───────────────────────────
// Drive a scripted perception SCRIPT (player approaches, lingers near, leaves) over
// a fixed tick budget on two FRESH NPCs and assert identical trajectory + state +
// locomotion sequences, bit-for-bit. Movement is pure math over the deterministic
// A* path, so any divergence would mean a non-deterministic runtime.
const SCRIPT_STEPS = 600;
function playerAt(step: number): V3 {
  // Far for most of the run, then a near window to exercise the greet branch.
  // NPC walks W0[1,1]→W1[8,1] along z=1 at 0.05 u/step, so near step ~100 it is
  // around x≈6. Park the player just off that corridor to trigger the greet branch.
  if (step >= 95 && step < 140) return [6, 0, 2];
  return FAR_PLAYER;
}
function runScript(): { traj: V3[]; states: string[]; loco: LocomotionState[] } {
  const n = freshNav();
  const m = new StubModel();
  const npc2 = makeNpc(n, m);
  const traj: V3[] = [];
  const states: string[] = [];
  for (let s = 0; s < SCRIPT_STEPS; s++) {
    npc2.tick(DT, playerAt(s));
    traj.push(npc2.position());
    states.push(npc2.state());
  }
  return { traj, states, loco: m.locomotion.slice() };
}
const runA = runScript();
const runB = runScript();
assert(runA.traj.length === runB.traj.length, "trajectory length mismatch across runs");
for (let i = 0; i < runA.traj.length; i++) {
  const a = runA.traj[i], b = runB.traj[i];
  assert(Object.is(a[0], b[0]) && Object.is(a[1], b[1]) && Object.is(a[2], b[2]), `non-deterministic position at step ${i}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  assert(runA.states[i] === runB.states[i], `non-deterministic state at step ${i}: ${runA.states[i]} != ${runB.states[i]}`);
}
assert(runA.loco.length === runB.loco.length && runA.loco.every((s, i) => s === runB.loco[i]), "non-deterministic locomotion sequence across runs");
// The script genuinely exercised BOTH branches (proves the determinism test has teeth).
assert(runA.states.includes("greet") && runA.states.includes("patrol"), "determinism script never hit both patrol and greet");

ops.op_log(
  `p14_npc OK: scripted NPC patrols the grid navmesh (findPath A* + fixed-dt integrator) — ` +
  `reached W1 then CYCLED to W2 (${t} steps, distance strictly decreasing); gait is 'walk' while moving / 'idle' when arrived; ` +
  `model is render-only + OPTIONAL (model-less NPC still advances; syncSkinning passes through); ` +
  `wantsToTalk()/state() flip patrol→greet inside talkRadius (NPC stops + faces the player) and reset when they leave; ` +
  `run-twice identity over a ${SCRIPT_STEPS}-step approach/linger/leave script: identical trajectory + state + locomotion, bit-for-bit.`,
);
