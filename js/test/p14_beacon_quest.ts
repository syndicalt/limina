// Phase 14 — THE BEACON QUEST GATE. Proves an agent authors AND drives a complete, deterministic
// game ("Light the Eastern Beacon") composed entirely from the limina game skills + the world/
// helpers (DialogueRuntime, ScriptedNpc) on a MAP-PAINTER-AUTHORED world — the shared builder/sim
// in js/src/demos/beacon_quest.ts, the same module the window demo boots. This is the Track-1
// integration proof: the ground is the painted Eastern Watch (assets/maps/beacon-quest-primary
// .worldmap.json) streamed through a MapTerrainSource, NOT world.generateRegion's noise.
//
// SCRIPTED PLAYTHROUGH (skill-driven, no input ops):
//   1. WIN PATH: walk to the warden → dialogue proximity-opens → accept (choice 0) → walk east to
//      the beacon → light it (interaction.interact → counter + quest.update) → walk back to the
//      warden → game.win. Asserts state="won", HP intact (100, never touched the Blight),
//      quest completed, beacon counter == 1.
//   2. LOSE PATH: a fresh game; walk into the BLIGHT hazard until damage.apply drains HP to 0 →
//      game.lose. Asserts state="lost", HP == 0.
//   3. SAVE/LOAD: a mid-game checkpoint captures the game-layer state; load restores HP + lit.
//   4. DETERMINISM — run-twice byte-identical trajectory + HP + counter + win tick.
//   5. REPLAY-EQUIVALENCE: record the authored+played skill stream, replay it into a FRESH
//      map-backed core, assert the game-state managers recompute BIT-IDENTICAL.
//
// Run: ./target/release/limina js/test/p14_beacon_quest.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills, type CoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import type { WorldMap } from "../src/world/worldmap.ts";
import {
  buildBeaconQuest, makeBeaconCore, loadBeaconWorldMap, BEACON_LAYOUT, headingToward, type BeaconQuest,
} from "../src/demos/beacon_quest.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p14_beacon_quest FAIL: " + msg);
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

const DT = 1 / 60;
const PERMS = resolveProfile("builder.readWrite");
const WARDEN = BEACON_LAYOUT.warden;
const BEACON = BEACON_LAYOUT.beacon;
const BLIGHT = BEACON_LAYOUT.blight;
const HOLD_DIST = BEACON_LAYOUT.talkRadius - 0.8;
const distXZ = (p: readonly number[], xz: readonly [number, number]): number => Math.hypot(p[0] - xz[0], p[2] - xz[1]);

// The committed painted world (the SAME artifact the peek renders).
const worldMapText = new TextDecoder().decode(ops.op_read_asset("maps/beacon-quest-primary.worldmap.json"));
const WORLDMAP: WorldMap = loadBeaconWorldMap(worldMapText);

async function freshGame(session: string): Promise<{ q: BeaconQuest; core: CoreSkills; registry: SkillRegistry }> {
  ops.op_physics_create_world(-9.81);
  const registry = new SkillRegistry(new LiminaTracer(session));
  const core = makeBeaconCore(registry, WORLDMAP);
  const world = makeWorld(ops);
  const base: InvokeBase = { agentId: "agt_beacon", sessionId: session, permissions: PERMS, tick: 0, world };
  const q = await buildBeaconQuest({ world, registry, core, base });
  return { q, core, registry };
}

type OnStep = (q: BeaconQuest) => void;

async function approachAndAccept(q: BeaconQuest, onStep?: OnStep): Promise<void> {
  for (let s = 0; s < 1200 && !q.accepted(); s++) {
    const p = q.playerPos();
    const forward = distXZ(p, WARDEN) > HOLD_DIST ? 1 : 0;
    const yaw = headingToward(p[0], p[2], WARDEN[0], WARDEN[1]);
    const choose = q.dialogue.isActive() && !q.dialogue.isTerminal() ? 0 : -1;
    await q.step(DT, { forward, yaw, choose });
    onStep?.(q);
  }
  assert(q.accepted(), "quest was never accepted via the dialogue");
}

async function lightBeacon(q: BeaconQuest, onStep?: OnStep): Promise<void> {
  for (let s = 0; s < 4000 && !q.lit(); s++) {
    const p = q.playerPos();
    const inRange = distXZ(p, BEACON) <= BEACON_LAYOUT.beaconRange;
    const yaw = headingToward(p[0], p[2], BEACON[0], BEACON[1]);
    await q.step(DT, { forward: inRange ? 0 : 1, yaw, light: inRange });
    onStep?.(q);
  }
  assert(q.lit(), `the beacon was never lit (player at ${q.playerPos().map((n) => n.toFixed(1))})`);
}

async function returnToWarden(q: BeaconQuest, onStep?: OnStep): Promise<void> {
  for (let s = 0; s < 4000 && q.state() === "playing"; s++) {
    const p = q.playerPos();
    const forward = distXZ(p, WARDEN) > HOLD_DIST ? 1 : 0;
    const yaw = headingToward(p[0], p[2], WARDEN[0], WARDEN[1]);
    await q.step(DT, { forward, yaw });
    onStep?.(q);
  }
}

async function playWin(q: BeaconQuest, onStep?: OnStep): Promise<void> {
  await approachAndAccept(q, onStep);
  await lightBeacon(q, onStep);
  await returnToWarden(q, onStep);
}

interface WinResult { trajectory: number[]; state: string; endedAtTick: number | undefined; hp: number; lit: boolean; }
async function runWin(session: string): Promise<WinResult> {
  const { q } = await freshGame(session);
  const trajectory: number[] = [];
  const record: OnStep = (c) => {
    const p = c.playerPos(), n = c.npcPos();
    trajectory.push(p[0], p[1], p[2], n[0], n[1], n[2], c.hp(), c.lit() ? 1 : 0);
  };
  await playWin(q, record);
  return { trajectory, state: q.state(), endedAtTick: q.endedAtTick(), hp: q.hp(), lit: q.lit() };
}

// ════════════════════════════ 1. WIN PATH ════════════════════════════════════════════════════
const A = await runWin("ses_p14_beacon_A");
assert(A.state === "won", `win path did not win (state=${A.state})`);
assert(A.lit, "win path did not light the beacon");
assert(A.hp === 100, `win path HP is ${A.hp}, expected an untouched 100 (never entered the Blight)`);
assert(A.endedAtTick !== undefined, "game.win did not stamp a deterministic endedAtTick");

{
  const { q, core } = await freshGame("ses_p14_beacon_quest");
  await playWin(q);
  const inst = core.quest.questManager.getInstance(q.playerEntity, q.questId);
  assert(inst !== undefined && inst.status === "completed", `quest not completed (status=${inst?.status})`);
  assert(core.gamestate.gameStateManager.getCounter("beacon") === 1, "beacon counter not 1 on the manager");
}

// ════════════════════════════ 2. LOSE PATH ═══════════════════════════════════════════════════
async function runLose(session: string): Promise<{ state: string; hp: number; endedAtTick: number | undefined }> {
  const { q } = await freshGame(session);
  for (let s = 0; s < 4000 && q.state() === "playing"; s++) {
    const p = q.playerPos();
    const yaw = headingToward(p[0], p[2], BLIGHT[0], BLIGHT[1]);
    await q.step(DT, { forward: 1, yaw });
  }
  return { state: q.state(), hp: q.hp(), endedAtTick: q.endedAtTick() };
}
const L = await runLose("ses_p14_beacon_lose_A");
assert(L.state === "lost", `lose path did not lose (state=${L.state})`);
assert(L.hp === 0, `lose path HP is ${L.hp}, expected 0`);
assert(L.endedAtTick !== undefined, "game.lose did not stamp a deterministic endedAtTick");

// ════════════════════════════ 3. SAVE / LOAD (mid-game) ══════════════════════════════════════
{
  const { q } = await freshGame("ses_p14_beacon_save");
  await approachAndAccept(q);
  await lightBeacon(q); // lit == true, before turning in
  assert(q.lit() && q.state() === "playing", "expected the beacon lit and still playing before save");
  const savedHp = q.hp();
  await q.save("mid");
  const restored = await q.load("mid");
  assert(restored.lit === true, `load did not restore the lit flag (${restored.lit})`);
  assert(restored.hp === savedHp, `load did not restore HP (${restored.hp} != ${savedHp})`);
  assert(q.state() === "playing", "game state should still be playing after a mid-game load");
}

// ════════════════════════════ 4. DETERMINISM — run-twice ═════════════════════════════════════
const B = await runWin("ses_p14_beacon_B");
assert(A.trajectory.length === B.trajectory.length, `trajectory length differs across runs (${A.trajectory.length} vs ${B.trajectory.length})`);
for (let i = 0; i < A.trajectory.length; i++) {
  assert(Object.is(A.trajectory[i], B.trajectory[i]), `non-deterministic trajectory at index ${i}: ${A.trajectory[i]} vs ${B.trajectory[i]}`);
}
assert(A.state === B.state && A.lit === B.lit && A.endedAtTick === B.endedAtTick,
  `win outcome differs across runs (state ${A.state}/${B.state}, lit ${A.lit}/${B.lit}, tick ${A.endedAtTick}/${B.endedAtTick})`);
const L2 = await runLose("ses_p14_beacon_lose_B");
assert(L.endedAtTick === L2.endedAtTick && L.hp === L2.hp, `lose path differs across runs (tick ${L.endedAtTick}/${L2.endedAtTick}, hp ${L.hp}/${L2.hp})`);

// ════════════════════════════ 5. REPLAY-EQUIVALENCE (record → replay) ════════════════════════
function snapshotGameState(core: CoreSkills, player: string, questId: string): string {
  const gs = core.gamestate.gameStateManager.getState();
  const counters = [...gs.counters.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const flags = [...gs.flags.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const hp = core.combat.statsManager.getStat(player, "hp");
  const quest = core.quest.questManager.getInstance(player, questId);
  return JSON.stringify({
    state: gs.state, endedAtTick: gs.endedAtTick, counters, flags,
    hp: hp ? { value: hp.value, max: hp.maxValue, min: hp.minValue } : null,
    quest: quest ? { status: quest.status, objectives: quest.objectives } : null,
  });
}

ops.op_physics_create_world(-9.81);
const recReg = new SkillRegistry(new LiminaTracer("ses_p14_beacon_rec"));
const recCore = makeBeaconCore(recReg, WORLDMAP);
const recorder = new WorldRecorder("ses_p14_beacon_rec");
recorder.attach(recReg);
const recWorld = makeWorld(ops);
const recBase: InvokeBase = { agentId: "agt_beacon_rec", sessionId: "ses_p14_beacon_rec", permissions: PERMS, tick: 0, world: recWorld };
const recQ = await buildBeaconQuest({ world: recWorld, registry: recReg, core: recCore, base: recBase });
await playWin(recQ);
assert(recQ.state() === "won", "recorded run did not reach the won state");

const skillCommands = recorder.commands.filter((c) => c.kind === "skill");
assert(skillCommands.length > 30, `expected a substantial recorded skill stream, got ${skillCommands.length}`);
const recordedTools = new Set(skillCommands.map((c) => (c as { tool: string }).tool));
for (const must of ["world.generateRegion", "player.spawn", "player.move", "quest.accept", "interaction.interact", "dialogue.start", "game.win"]) {
  assert(recordedTools.has(must), `recorded stream is missing ${must}`);
}
const authState = snapshotGameState(recCore, recQ.playerEntity, recQ.questId);

// Replay into a FRESH map-backed core (the terrain source MUST match, or player.move re-resolves
// against different ground and the game state diverges).
let replayCore: CoreSkills | undefined;
await replayCommands(recorder.commands, {
  makeWorld: () => { ops.op_physics_create_world(-9.81); return makeWorld(ops); },
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    replayCore = makeBeaconCore(r, WORLDMAP);
    return r;
  },
  tracer: new LiminaTracer("ses_p14_beacon_replay"),
});
assert(replayCore !== undefined, "replay did not construct a core");
const replayState = snapshotGameState(replayCore, recQ.playerEntity, recQ.questId);
assert(replayState === authState,
  "replay recomputed a DIFFERENT game state than authoring\n  auth  : " + authState + "\n  replay: " + replayState);

const winTick = A.endedAtTick ?? -1;
const steps = A.trajectory.length / 8;
ops.op_log(
  `p14_beacon_quest OK: authored + PLAYED a complete game ("Light the Eastern Beacon") through skills + helpers on a ` +
  `MAP-PAINTER world (painted Eastern Watch streamed via MapTerrainSource) — ` +
  `WIN: walk to warden → dialogue accept → walk east → light the beacon (interaction.interact → counter + quest.update) → ` +
  `return → game.win (state="won", HP=100, quest completed, beacon=1, endedAtTick=${winTick}); ` +
  `LOSE: walk into the Blight → damage.apply drains HP → game.lose (state="lost", HP=0); ` +
  `SAVE/LOAD: mid-game checkpoint restored HP + lit; ` +
  `DETERMINISM: ${steps}-step win script x2 byte-identical + deterministic lose tick; ` +
  `REPLAY: ${skillCommands.length} recorded skills replay into a fresh map-backed core BIT-IDENTICAL.`,
);
