// Phase 14 — THE PRODUCTION CAPSTONE GATE. Proves an agent can author AND drive a whole,
// complete, deterministic game ("The Relic Hunt") composed entirely from the limina game
// skills + the world/ helpers (DialogueRuntime, ScriptedNpc) — via the SHARED builder/sim in
// js/src/demos/capstone_game.ts (the same module the human-playable window demo boots).
//
// SCRIPTED PLAYTHROUGH (skill-driven, no input ops — the headless test drives the typed input):
//   1. WIN PATH: walk to the quest-giver → the dialogue proximity-opens → accept (choice 0) →
//      walk to + auto-pick-up all 3 relics (inventory + counter + quest.update) → walk back to
//      the keeper → game.win. Asserts state="won", HP intact (100, never touched the hazard),
//      quest completed, relic counter == 3.
//   2. LOSE PATH: a fresh game; walk straight into the scorched-ground HAZARD until the per-tick
//      damage.apply drains HP to 0 → game.lose. Asserts state="lost", HP == 0.
//   3. SAVE/LOAD: mid-game checkpoint.create captures the game-layer state; checkpoint.load
//      restores the relic count + HP (a real mid-game save/load).
//   4. DETERMINISM — run-twice: the SAME scripted input from a FRESH world yields a
//      byte-identical trajectory + HP + relic counter + win tick (Object.is, +0/-0/NaN-strict).
//   5. REPLAY-EQUIVALENCE (the sacred invariant): record the full authored+played skill stream
//      with WorldRecorder, replay it into a FRESH core, and assert the game-state managers
//      recompute BIT-IDENTICAL (game state, counters, HP, quest) — the recorded surface replays
//      deterministically.
//
// Run: ./target/release/limina js/test/p14_capstone.ts   (exit 0 = pass)

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
import {
  buildCapstone, CAPSTONE_LAYOUT, headingToward, type Capstone,
} from "../src/demos/capstone_game.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p14_capstone FAIL: " + msg);
}

/** The headless WorldContext (stub scene/camera, mode "headless") — mirrors p12_capstone. The
 *  scene's add/remove are no-ops so the DialogueRuntime's UI panels are harmless headless. */
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
const NPC = CAPSTONE_LAYOUT.npc;
const HOLD_DIST = CAPSTONE_LAYOUT.talkRadius - 0.8; // stop walking here, hold + talk / turn in
const distXZ = (p: readonly number[], xz: readonly [number, number]): number =>
  Math.hypot(p[0] - xz[0], p[2] - xz[1]);

/** Build a fresh game on a freshly-reset native physics world (the global singleton reset is
 *  what makes re-runs reproducible). Returns the controller + its core/registry. */
async function freshGame(session: string): Promise<{ cap: Capstone; core: CoreSkills; registry: SkillRegistry }> {
  ops.op_physics_create_world(-9.81);
  const registry = new SkillRegistry(new LiminaTracer(session));
  const core = registerCoreSkills(registry);
  const world = makeWorld(ops);
  const base: InvokeBase = { agentId: "agt_capstone", sessionId: session, permissions: PERMS, tick: 0, world };
  const cap = await buildCapstone({ world, registry, core, base });
  return { cap, core, registry };
}

type OnStep = (cap: Capstone) => void;

/** Walk up to the quest-giver, hold, and accept the quest through the dialogue. */
async function approachAndAccept(cap: Capstone, onStep?: OnStep): Promise<void> {
  for (let s = 0; s < 600 && !cap.accepted(); s++) {
    const p = cap.playerPos();
    const forward = distXZ(p, NPC) > HOLD_DIST ? 1 : 0;
    const yaw = headingToward(p[0], p[2], NPC[0], NPC[1]);
    // Pick the accept branch (choice 0) whenever the dialogue is open on a branching node.
    const choose = cap.dialogue.isActive() && !cap.dialogue.isTerminal() ? 0 : -1;
    await cap.step(DT, { forward, yaw, choose });
    onStep?.(cap);
  }
  assert(cap.accepted(), "quest was never accepted via the dialogue");
}

/** Walk to relic `index` (0-based) and let the sim auto-pick-it-up. */
async function collectRelic(cap: Capstone, index: number, onStep?: OnStep): Promise<void> {
  const target = CAPSTONE_LAYOUT.relics[index];
  for (let s = 0; s < 800 && cap.relics() <= index; s++) {
    const p = cap.playerPos();
    const yaw = headingToward(p[0], p[2], target[0], target[1]);
    await cap.step(DT, { forward: 1, yaw });
    onStep?.(cap);
  }
  assert(cap.relics() === index + 1, `relic ${index} was not collected (count=${cap.relics()})`);
}

/** Walk back to the quest-giver to turn in (which triggers the win). */
async function returnToGiver(cap: Capstone, onStep?: OnStep): Promise<void> {
  for (let s = 0; s < 800 && cap.state() === "playing"; s++) {
    const p = cap.playerPos();
    const forward = distXZ(p, NPC) > HOLD_DIST ? 1 : 0;
    const yaw = headingToward(p[0], p[2], NPC[0], NPC[1]);
    await cap.step(DT, { forward, yaw });
    onStep?.(cap);
  }
}

/** The full win playthrough. */
async function playWin(cap: Capstone, onStep?: OnStep): Promise<void> {
  await approachAndAccept(cap, onStep);
  for (let i = 0; i < CAPSTONE_LAYOUT.relics.length; i++) await collectRelic(cap, i, onStep);
  await returnToGiver(cap, onStep);
}

interface WinResult {
  trajectory: number[]; // flattened [px,py,pz, nx,ny,nz, hp, relics] per step
  state: string;
  endedAtTick: number | undefined;
  hp: number;
  relics: number;
}

async function runWin(session: string): Promise<WinResult> {
  const { cap } = await freshGame(session);
  const trajectory: number[] = [];
  const record: OnStep = (c) => {
    const p = c.playerPos(), n = c.npcPos();
    trajectory.push(p[0], p[1], p[2], n[0], n[1], n[2], c.hp(), c.relics());
  };
  await playWin(cap, record);
  return { trajectory, state: cap.state(), endedAtTick: cap.endedAtTick(), hp: cap.hp(), relics: cap.relics() };
}

// ════════════════════════════ 1. WIN PATH ════════════════════════════════════════════════════
const A = await runWin("ses_p14_capstone_A");
assert(A.state === "won", `win path did not win (state=${A.state})`);
assert(A.relics === 3, `win path relic counter is ${A.relics}, expected 3`);
assert(A.hp === 100, `win path HP is ${A.hp}, expected an untouched 100 (never entered the hazard)`);
assert(A.endedAtTick !== undefined, "game.win did not stamp a deterministic endedAtTick");

// Independent check on the manager surface: the quest is genuinely completed.
{
  const { cap, core } = await freshGame("ses_p14_capstone_quest");
  await playWin(cap);
  const inst = core.quest.questManager.getInstance(cap.playerEntity, cap.questId);
  assert(inst !== undefined && inst.status === "completed", `quest not completed (status=${inst?.status})`);
  assert(core.inventory.inventoryManager.countItem(cap.playerEntity, cap.npcEntity) >= 0, "inventory manager unreachable");
  assert(core.gamestate.gameStateManager.getCounter("relics") === 3, "relic counter not 3 on the manager");
}

// ════════════════════════════ 2. LOSE PATH ═══════════════════════════════════════════════════
async function runLose(session: string): Promise<{ state: string; hp: number; endedAtTick: number | undefined }> {
  const { cap } = await freshGame(session);
  const hz = CAPSTONE_LAYOUT.hazard;
  for (let s = 0; s < 2000 && cap.state() === "playing"; s++) {
    const p = cap.playerPos();
    const yaw = headingToward(p[0], p[2], hz[0], hz[1]);
    await cap.step(DT, { forward: 1, yaw });
  }
  return { state: cap.state(), hp: cap.hp(), endedAtTick: cap.endedAtTick() };
}
const L = await runLose("ses_p14_capstone_lose_A");
assert(L.state === "lost", `lose path did not lose (state=${L.state})`);
assert(L.hp === 0, `lose path HP is ${L.hp}, expected 0`);
assert(L.endedAtTick !== undefined, "game.lose did not stamp a deterministic endedAtTick");

// ════════════════════════════ 3. SAVE / LOAD (mid-game) ══════════════════════════════════════
{
  const { cap } = await freshGame("ses_p14_capstone_save");
  await approachAndAccept(cap);
  await collectRelic(cap, 0); // relics == 1
  const savedRelics = cap.relics();
  const savedHp = cap.hp();
  assert(savedRelics === 1, `expected 1 relic before save, got ${savedRelics}`);
  await cap.save("mid");
  await collectRelic(cap, 1); // relics == 2 — diverge from the checkpoint
  assert(cap.relics() === 2, "second relic not collected before load");
  const restored = await cap.load("mid");
  assert(restored.relics === savedRelics, `load did not restore the relic count (${restored.relics} != ${savedRelics})`);
  assert(restored.hp === savedHp, `load did not restore HP (${restored.hp} != ${savedHp})`);
  assert(cap.relics() === savedRelics, `relic counter not re-applied after load (${cap.relics()})`);
  assert(cap.hp() === savedHp, `HP not re-applied after load (${cap.hp()})`);
  assert(cap.state() === "playing", "game state should still be playing after a mid-game load");
}

// ════════════════════════════ 4. DETERMINISM — run-twice ═════════════════════════════════════
const B = await runWin("ses_p14_capstone_B");
assert(A.trajectory.length === B.trajectory.length, `trajectory length differs across runs (${A.trajectory.length} vs ${B.trajectory.length})`);
for (let i = 0; i < A.trajectory.length; i++) {
  assert(Object.is(A.trajectory[i], B.trajectory[i]), `non-deterministic trajectory at index ${i}: ${A.trajectory[i]} vs ${B.trajectory[i]}`);
}
assert(A.state === B.state, `final state differs across runs (${A.state} vs ${B.state})`);
assert(A.relics === B.relics, `relic count differs across runs (${A.relics} vs ${B.relics})`);
assert(A.endedAtTick === B.endedAtTick, `win tick differs across runs (${A.endedAtTick} vs ${B.endedAtTick}) — a wall-clock leaked into the win`);
// The lose path is deterministic too (same death tick + HP).
const L2 = await runLose("ses_p14_capstone_lose_B");
assert(L.endedAtTick === L2.endedAtTick, `lose tick differs across runs (${L.endedAtTick} vs ${L2.endedAtTick})`);
assert(L.hp === L2.hp, `lose HP differs across runs (${L.hp} vs ${L2.hp})`);

// ════════════════════════════ 5. REPLAY-EQUIVALENCE (record → replay) ════════════════════════
// Serialize the deterministic game-state managers (game state, counters, flags, HP, quest) — the
// part the recorded skill stream must reproduce bit-for-bit.
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

// Author + play the WIN path with the recorder attached to the live registry.
ops.op_physics_create_world(-9.81);
const recReg = new SkillRegistry(new LiminaTracer("ses_p14_capstone_rec"));
const recCore = registerCoreSkills(recReg);
const recorder = new WorldRecorder("ses_p14_capstone_rec");
recorder.attach(recReg); // patch the invoke choke point BEFORE authoring so the whole stream is logged
const recWorld = makeWorld(ops);
const recBase: InvokeBase = { agentId: "agt_capstone_rec", sessionId: "ses_p14_capstone_rec", permissions: PERMS, tick: 0, world: recWorld };
const recCap = await buildCapstone({ world: recWorld, registry: recReg, core: recCore, base: recBase });
await playWin(recCap);
assert(recCap.state() === "won", "recorded run did not reach the won state");

const skillCommands = recorder.commands.filter((c) => c.kind === "skill");
assert(skillCommands.length > 30, `expected a substantial recorded skill stream, got ${skillCommands.length}`);
const recordedTools = new Set(skillCommands.map((c) => (c as { tool: string }).tool));
for (const must of ["world.generateRegion", "player.spawn", "player.move", "quest.accept", "interaction.pickup", "dialogue.start", "game.win"]) {
  assert(recordedTools.has(must), `recorded stream is missing ${must}`);
}
const authState = snapshotGameState(recCore, recCap.playerEntity, recCap.questId);

// Replay the recorded stream into a FRESH core (fresh physics + registry) and re-snapshot.
let replayCore: CoreSkills | undefined;
await replayCommands(recorder.commands, {
  makeWorld: () => { ops.op_physics_create_world(-9.81); return makeWorld(ops); },
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    replayCore = registerCoreSkills(r);
    return r;
  },
  tracer: new LiminaTracer("ses_p14_capstone_replay"),
});
assert(replayCore !== undefined, "replay did not construct a core");
const replayState = snapshotGameState(replayCore, recCap.playerEntity, recCap.questId);
assert(replayState === authState,
  "replay recomputed a DIFFERENT game state than authoring\n  auth  : " + authState + "\n  replay: " + replayState);

const winTick = A.endedAtTick ?? -1;
const steps = A.trajectory.length / 8;
ops.op_log(
  `p14_capstone OK: authored + PLAYED a complete game ("The Relic Hunt") through skills + helpers — ` +
  `WIN path: walk to keeper → dialogue accept → collect 3 relics (interaction.pickup → inventory + counter + quest.update) → ` +
  `return → game.win (state="won", HP=100, quest completed, relics=3, endedAtTick=${winTick}); ` +
  `LOSE path: walk into the scorched-ground hazard → damage.apply drains HP → game.lose (state="lost", HP=0); ` +
  `SAVE/LOAD: mid-game checkpoint restored the relic count + HP; ` +
  `DETERMINISM: ${steps}-step win script x2 byte-identical (trajectory + HP + counter + win tick) + deterministic lose tick; ` +
  `REPLAY: ${skillCommands.length} recorded skills replay into a fresh core BIT-IDENTICAL game state.`,
);
