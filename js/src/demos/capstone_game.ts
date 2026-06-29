// Phase 14 CAPSTONE — "The Relic Hunt": the shared, deterministic builder + sim for one
// complete, playable game authored ENTIRELY from the limina game skills + the world/ helpers
// (DialogueRuntime, ScriptedNpc, GameHud). This module is the single source of truth shared by
// BOTH the human-playable window demo (js/src/demos/capstone_window.ts) and the headless gate
// test (js/test/p14_capstone.ts) — exactly the way playable_game_window + p12_capstone share a
// setup. It owns NO rendering: every line here mutates deterministic game STATE through skills;
// the camera / character models / HUD draw / dialogue bubbles are the window demo's job.
//
// THE GAME (a tiny but COMPLETE loop, all skill-authored — nothing hand-modeled):
//   • world.generateRegion (+ populateBiome/addWater when windowed) — the island ground.
//   • navmesh (core.nav) — the NPC's walkable grid (terrain-height field).
//   • player.spawn — a real kinematic character; player.move drives it (replay-faithful).
//   • scene.createEntity ×(1 NPC anchor + 3 relics); interaction.register makes the relics
//     pickups; inventory.create gives the player a pack.
//   • stats.create — the player's HP (100).
//   • quest.define — one objective: collect 3 relics; quest.offer/accept on dialogue accept;
//     quest.update folds each pickup into progress (auto-completes at 3).
//   • dialogue.define — the quest-giver's branching tree (accept / decline); driven through the
//     DialogueRuntime (records dialogue.start/choose/end only — UI is render-only).
//   • trigger.create + trigger.onEnter/onStay — the "scorched ground" HAZARD; its fired action
//     carries the per-tick damage that damage.apply drains from HP (HP→0 ⇒ game.lose).
//   • game.counter / game.condition / game.win / game.lose — the win/lose state machine.
//   • checkpoint.create/load — a mid-game save/load of the game-layer state.
//
// SIM vs RENDER (the replay invariant): step() is a PURE function of (state, input) — no
// Date.now / Math.random / wall clock. All mutation flows through the recorded skill surface,
// so a recorded session replays bit-identically; run the same scripted input twice and the
// trajectory + HP + counters + win tick are byte-identical.

import { TILE_SIZE } from "../terrain/procedural.ts";
import { terrainTypeHints } from "../terrain/terrain-types.ts";
import type { InvokeBase, SkillRegistry, WorldContext } from "../skills/registry.ts";
import type { CoreSkills } from "../skills/index.ts";
import type { MCPResponse } from "../mcp/protocol.ts";
import type { CharacterController } from "../world/character.ts";
import { DialogueRuntime } from "../world/dialogue_runtime.ts";
import { ScriptedNpc } from "../world/npc_runtime.ts";

type Vec3 = [number, number, number];

// ── Authoring constants (the "agent's seeds"): a fixed island + a fixed layout. ──────────────
/** Deterministic world seed (shared by the demo + the test). */
export const SEED = 7331;
const TYPE = "plains" as const;
/** A small 2×2-tile region (~96m). */
const BOUNDS = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 } as const;
const HINTS = terrainTypeHints(TYPE, BOUNDS);

/** Region center = the player spawn (tiles 0..1 ⇒ world 0..2·TILE_SIZE, center = TILE_SIZE). */
const CENTER_X = ((BOUNDS.minTx + BOUNDS.maxTx + 1) / 2) * TILE_SIZE; // 48
const CENTER_Z = ((BOUNDS.minTz + BOUNDS.maxTz + 1) / 2) * TILE_SIZE; // 48
const WORLD_MIN = 0;
const WORLD_MAX = 2 * TILE_SIZE; // 96

/** The quest-giver stands a few metres "north" (+Z) of spawn. */
const NPC_OFFSET: readonly [number, number] = [0, 5];
/** The three relics, scattered "south" of spawn (clear of the hazard). */
const RELIC_OFFSETS: readonly (readonly [number, number])[] = [
  [4, -8],
  [-4, -8],
  [0, -12],
];
/** The "scorched ground" hazard, off to the west — the win path avoids it; the lose path
 *  walks into it. Box half-extents. */
const HAZARD_CENTER: readonly [number, number] = [-20, 0];
const HAZARD_HALF: Vec3 = [5, 4, 5];
/** HP drained per fixed step while standing on the hazard (HP 100 ⇒ ~20 ticks to die). */
const HAZARD_DPS = 5;

const PLAYER_HP = 100;
const RELIC_TARGET = 3;
/** Auto-pickup a relic within this planar distance of the player (matches the orb in p12). */
const PICKUP_RANGE = 2.5;
const RELIC_INTERACT_RANGE = 4;
/** The quest-giver notices / can be turned in to within this planar distance. */
const TALK_RADIUS = 4.5;
const CAPSULE_OFFSET = 0.9; // halfHeight(0.5) + radius(0.35), rounded for the resting center Y.

/** Ids authored into the world (stable across runs). */
const QUEST_ID = "relic_hunt";
const QUEST_OBJECTIVE = "gather_relics";
const DIALOGUE_TREE_ID = "relic_keeper";

/** The authored world layout in WORLD coordinates — shared with the headless script + the
 *  window demo so neither has to re-derive the relic/NPC/hazard placement. */
export const CAPSTONE_LAYOUT = {
  spawn: [CENTER_X, CENTER_Z] as [number, number],
  npc: [CENTER_X + NPC_OFFSET[0], CENTER_Z + NPC_OFFSET[1]] as [number, number],
  relics: RELIC_OFFSETS.map(([ox, oz]) => [CENTER_X + ox, CENTER_Z + oz] as [number, number]),
  hazard: [CENTER_X + HAZARD_CENTER[0], CENTER_Z + HAZARD_CENTER[1]] as [number, number],
  talkRadius: TALK_RADIUS,
  pickupRange: PICKUP_RANGE,
  relicTarget: RELIC_TARGET,
} as const;

/** The branching quest-giver dialogue. choiceIndex 0 = accept, 1 = decline. */
const DIALOGUE_TREE = {
  id: DIALOGUE_TREE_ID,
  name: "The Relic Keeper",
  startNode: "greet",
  nodes: [
    {
      id: "greet",
      text: "Bring me 3 relics. Beware the scorched ground. Will you help?",
      speaker: "relic_keeper",
      mood: "wary",
      choices: [
        { text: "I'll find them.", nextNodeId: "accept" },
        { text: "Not now.", nextNodeId: "decline" },
      ],
    },
    {
      id: "accept",
      text: "Good. Return to me once all three are in hand.",
      speaker: "relic_keeper",
      choices: [],
    },
    {
      id: "decline",
      text: "Then the relics stay lost. Return if you reconsider.",
      speaker: "relic_keeper",
      choices: [],
    },
  ],
};

/** The per-fixed-step input the sim consumes. The window demo fills this from the keyboard
 *  (W/S → forward, A/D → an integrated heading → yaw, Space/Shift → choose/jump); the headless
 *  test fills it from a deterministic script. NO input ops are read inside the sim. */
export interface CapstoneInput {
  /** Forward axis in [-1,1] (+ = forward). */
  forward: number;
  /** Strafe axis in [-1,1] (+ = right). Usually 0. */
  strafe?: number;
  /** Absolute movement heading (radians). yaw=0 ⇒ world -Z. */
  yaw: number;
  /** Run this step. */
  run?: boolean;
  /** Jump this step (ignored while a dialogue is open). */
  jump?: boolean;
  /** Dialogue choice index this step (≥0 to choose; <0 / undefined = no choice). */
  choose?: number;
}

export type CapstoneState = "playing" | "won" | "lost";

/** What buildCapstone needs: a constructed world/registry/core + an InvokeBase TEMPLATE
 *  (its tick is managed internally so every skill invoke is stamped with the sim tick). */
export interface BuildCapstoneDeps {
  world: WorldContext;
  registry: SkillRegistry;
  core: CoreSkills;
  base: InvokeBase;
}

/** The deterministic game controller returned by buildCapstone. */
export interface Capstone {
  /** Advance ONE fixed step from `input`. Deterministic; resolves once all skill writes land. */
  step(dt: number, input: CapstoneInput): Promise<void>;
  /** Save the game-layer state (relics/hp/accepted/state) to a named checkpoint. */
  save(name: string): Promise<void>;
  /** Load a named checkpoint and re-apply its game-layer state. Returns the restored snapshot. */
  load(name: string): Promise<{ relics: number; hp: number; accepted: boolean; state: CapstoneState }>;
  /** "playing" | "won" | "lost". */
  state(): CapstoneState;
  /** Current player HP. */
  hp(): number;
  /** Relics collected so far (0..3). */
  relics(): number;
  /** Whether the quest has been accepted via the dialogue. */
  accepted(): boolean;
  /** The tick game.win / game.lose landed on (deterministic), or undefined while playing. */
  endedAtTick(): number | undefined;
  /** Live player capsule-center position. */
  playerPos(): Vec3;
  /** Live NPC sim position. */
  npcPos(): Vec3;
  // Handles the window demo / test read for rendering + assertions:
  readonly playerEntity: string;
  readonly npcEntity: string;
  readonly questId: string;
  readonly dialogueTreeId: string;
  /** The player's kinematic controller (for the window demo's camera + model foot-placement). */
  readonly playerController: CharacterController;
  /** The scripted quest-giver (render-only model is posed from npcPos()/npcFacing() by the host). */
  readonly npc: ScriptedNpc;
  /** Heading (radians) the NPC faces — for the window demo's NPC model. */
  npcFacing(): number;
  /** The active dialogue runtime (state-driven; renders only when a windowed UiManager is wired). */
  readonly dialogue: DialogueRuntime;
}

const distXZ = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(a[0] - b[0], a[2] - b[2]);

/** Unwrap an MCPResponse, throwing with context on failure (production-grade — never a
 *  silent stub). */
function ok(label: string, res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) {
    throw new Error(`capstone: ${label} failed: ${JSON.stringify(res?.error ?? "no response")}`);
  }
  return (res.result ?? {}) as Record<string, unknown>;
}

/**
 * Author the whole game through skills + helpers and return the deterministic Capstone
 * controller. The native physics world MUST already be created by the caller
 * (ops.op_physics_create_world) so a fresh run resets the global singleton.
 */
export async function buildCapstone(deps: BuildCapstoneDeps): Promise<Capstone> {
  const { world, registry, core, base } = deps;
  if (world === undefined || registry === undefined || core === undefined || base === undefined) {
    throw new Error("buildCapstone: world, registry, core and base are all required");
  }
  const ops = world.ops;
  const windowed = world.mode === "windowed";

  // Internal deterministic tick — drives every skill invoke's stamp (never a wall clock).
  let tick = 0;
  const at = (): InvokeBase => ({ ...base, tick, world });

  // ── 1. GROUND. Colliders always; the visible PBR surface + biome scatter only when windowed
  //    (the headless test needs only the data/colliders, mirroring p12_capstone). ────────────
  const gen = ok("world.generateRegion", await registry.invoke("world.generateRegion", {
    seed: SEED, bounds: BOUNDS, lod: 0, type: TYPE, render: windowed,
    surface: windowed ? { mode: "pbr" } : undefined,
  }, at()));
  const regionId = gen.regionId as string;
  if (typeof regionId !== "string" || regionId.length === 0) {
    throw new Error("buildCapstone: world.generateRegion returned no regionId");
  }
  if (windowed) {
    ok("world.populateBiome", await registry.invoke("world.populateBiome", { regionId, type: TYPE }, at()));
  }
  // Build the broad-phase BVH so the first player.move resolves the ground.
  ops.op_physics_step();

  const surfaceY = (x: number, z: number): number => core.terrain.source.sampleHeight(SEED, x, z, 0, HINTS);

  // ── 2. NAVMESH for the NPC. A walkable grid over the region carrying terrain heights so the
  //    quest-giver stands on the ground. Driven through the manager (deterministic infra — not
  //    part of the recorded game-state surface). ─────────────────────────────────────────────
  const CELL = 4;
  const cols = Math.ceil((WORLD_MAX - WORLD_MIN) / CELL);
  const rows = cols;
  const heights = new Array<number>(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = WORLD_MIN + (c + 0.5) * CELL;
      const z = WORLD_MIN + (r + 0.5) * CELL;
      heights[r * cols + c] = surfaceY(x, z);
    }
  }
  const nav = core.nav.navmeshManager;
  const navRes = nav.build({
    bounds: { minX: WORLD_MIN, minZ: WORLD_MIN, maxX: WORLD_MAX, maxZ: WORLD_MAX },
    cellSize: CELL,
    heightField: { heights }, // no slope/Y limits ⇒ every cell stays walkable
  });
  if (!navRes.ok) throw new Error("buildCapstone: navmesh.build failed");

  // ── 3. PLAYER. A real kinematic character resting on the surface; player.move drives it. ────
  const spawn: Vec3 = [CENTER_X, surfaceY(CENTER_X, CENTER_Z) + CAPSULE_OFFSET, CENTER_Z];
  const playerEntity = ok("player.spawn", await registry.invoke("player.spawn", { position: spawn }, at())).entity as string;
  const ctrlEntry = core.player.controllers.get(playerEntity);
  if (ctrlEntry === undefined) throw new Error("buildCapstone: player.spawn did not register a controller");
  const playerController = ctrlEntry.controller;
  ok("inventory.create", await registry.invoke("inventory.create", { entity: playerEntity, capacity: 8 }, at()));
  ok("stats.create", await registry.invoke("stats.create", {
    entity: playerEntity, stats: [{ name: "hp", value: PLAYER_HP, maxValue: PLAYER_HP, minValue: 0 }],
  }, at()));

  // ── 4. NPC quest-giver. A scene anchor entity (the dialogue speaker + bubble anchor) plus a
  //    ScriptedNpc that idles on its spot and faces the player when near. ───────────────────────
  const npcPosXZ: readonly [number, number] = [CENTER_X + NPC_OFFSET[0], CENTER_Z + NPC_OFFSET[1]];
  const npcY = surfaceY(npcPosXZ[0], npcPosXZ[1]);
  const npcEntity = ok("scene.createEntity(npc)", await registry.invoke("scene.createEntity", {
    shape: "box", size: 1, color: 0x4466cc, position: [npcPosXZ[0], npcY + 0.9, npcPosXZ[1]],
  }, at())).entity as string;
  const npc = new ScriptedNpc(
    { registry, base: at(), world, navmeshManager: nav, regionId, seed: SEED },
    {
      waypoints: [[npcPosXZ[0], npcPosXZ[1]]], // single waypoint ⇒ stands + greets
      speed: 3,
      talkRadius: TALK_RADIUS,
      startPos: [npcPosXZ[0], npcY, npcPosXZ[1]],
      startYaw: Math.PI, // face -Z, toward the spawn
    },
  );

  // ── 5. RELICS. Three interactable pickups scattered around spawn. ──────────────────────────
  interface Relic { entity: string; pos: Vec3; collected: boolean; }
  const relics: Relic[] = [];
  for (let i = 0; i < RELIC_OFFSETS.length; i++) {
    const [ox, oz] = RELIC_OFFSETS[i];
    const rx = CENTER_X + ox;
    const rz = CENTER_Z + oz;
    const ry = surfaceY(rx, rz);
    const ent = ok(`scene.createEntity(relic${i})`, await registry.invoke("scene.createEntity", {
      shape: "sphere", size: 0.6, color: 0xffcc33, position: [rx, ry + 0.7, rz],
    }, at())).entity as string;
    ok(`interaction.register(relic${i})`, await registry.invoke("interaction.register", {
      entity: ent, prompt: "Take the relic", maxRange: RELIC_INTERACT_RANGE, type: "pickup",
    }, at()));
    relics.push({ entity: ent, pos: [rx, ry, rz], collected: false });
  }

  // ── 6. QUEST. One objective: collect 3 relics. Defined now; offered + accepted on dialogue. ─
  ok("quest.define", await registry.invoke("quest.define", {
    id: QUEST_ID, name: "The Relic Hunt",
    description: "Recover the three lost relics for the keeper.",
    objectives: [{
      id: QUEST_OBJECTIVE, type: "collect", description: "Collect 3 relics", required: RELIC_TARGET,
    }],
  }, at()));

  // ── 7. DIALOGUE tree + runtime. The runtime records dialogue.start/choose/end (STATE) and
  //    renders to core.ui (RENDER — a no-op against the headless stub scene). ─────────────────
  ok("dialogue.define", await registry.invoke("dialogue.define", DIALOGUE_TREE, at()));
  const dialogue = new DialogueRuntime({ registry, base: at(), uiManager: core.ui, world });

  // ── 8. HAZARD trigger. A box zone whose onEnter/onStay action carries the per-tick damage. ──
  const hazardId = ok("trigger.create", await registry.invoke("trigger.create", {
    shape: "box",
    center: [CENTER_X + HAZARD_CENTER[0], surfaceY(CENTER_X + HAZARD_CENTER[0], CENTER_Z + HAZARD_CENTER[1]) + HAZARD_HALF[1], CENTER_Z + HAZARD_CENTER[1]],
    size: HAZARD_HALF,
    config: { name: "scorched_ground" },
  }, at())).triggerId as string;
  const hazardAction = { type: "custom" as const, data: { damage: HAZARD_DPS } };
  ok("trigger.onEnter", await registry.invoke("trigger.onEnter", { triggerId: hazardId, action: hazardAction }, at()));
  ok("trigger.onStay", await registry.invoke("trigger.onStay", { triggerId: hazardId, action: hazardAction }, at()));

  // ── 9. WIN/LOSE bookkeeping. A condition for the objective; win/lose flip the game state. ───
  ok("game.condition", await registry.invoke("game.condition", {
    name: "relics_done", expression: `counter('relics') >= ${RELIC_TARGET}`, onTrue: "game.objectiveComplete",
  }, at()));

  const gs = core.gamestate.gameStateManager;
  const stats = core.combat.statsManager;
  const quests = core.quest.questManager;
  let acceptedFlag = false;
  let lastPlayerPos: Vec3 = [spawn[0], spawn[1], spawn[2]];
  let lastNpcPos: Vec3 = [npcPosXZ[0], npcY, npcPosXZ[1]];

  const hp = (): number => stats.getStat(playerEntity, "hp")?.value ?? 0;
  const relicCount = (): number => gs.getCounter("relics");
  const liveState = (): CapstoneState => {
    const s = gs.getState().state;
    return s === "won" ? "won" : s === "lost" ? "lost" : "playing";
  };

  // ── The deterministic sim tick. ────────────────────────────────────────────────────────────
  async function step(dt: number, input: CapstoneInput): Promise<void> {
    if (liveState() !== "playing") return; // frozen once the game ends
    tick++;

    // (1) MOVE — entirely skill-driven (player.move advances one fixed step + steps physics).
    const dialogueOpen = dialogue.isActive();
    const mv = ok("player.move", await registry.invoke("player.move", {
      entity: playerEntity,
      forward: input.forward,
      strafe: input.strafe ?? 0,
      yaw: input.yaw,
      run: input.run === true,
      jump: input.jump === true && !dialogueOpen,
    }, at()));
    lastPlayerPos = mv.newPosition as Vec3;

    // (2) NPC — deterministic patrol/greet (drives no skills; its own pure-math sim).
    lastNpcPos = npc.tick(dt, lastPlayerPos);

    // (3) HAZARD — the trigger pump reports the fired enter/stay action; drain HP from its data.
    const fired = core.triggers.triggerManager.tick([{ id: playerEntity, position: lastPlayerPos }]).fired;
    let totalDamage = 0;
    for (const f of fired) {
      if (f.triggerId !== hazardId || f.entityId !== playerEntity) continue;
      const dmg = (f.action.data as { damage?: number } | undefined)?.damage ?? 0;
      if (dmg > 0) totalDamage += dmg;
    }
    if (totalDamage > 0) {
      const res = ok("damage.apply", await registry.invoke("damage.apply", {
        targetEntity: playerEntity, amount: totalDamage, type: "fire",
      }, at()));
      if (res.killed === true || hp() <= 0) {
        ok("game.lose", await registry.invoke("game.lose", {}, at()));
        return;
      }
    }

    // (4) DIALOGUE — proximity-open the quest-giver until the quest is accepted; drive a choice.
    if (!acceptedFlag && npc.wantsToTalk() && !dialogue.isActive()) {
      await dialogue.open(npcEntity, playerEntity, DIALOGUE_TREE_ID);
    }
    if (dialogue.isActive()) {
      const choose = input.choose;
      if (choose !== undefined && choose >= 0 && !dialogue.isTerminal()) {
        await dialogue.choose(choose);
      }
      if (dialogue.isActive() && dialogue.isTerminal()) {
        // Resolve accept vs decline from the recorded session history BEFORE it ends.
        const session = core.behavior.dialogueManager.getCurrentSession(npcEntity, playerEntity);
        const acceptChosen = session?.history.some((h) => h.choiceIndex === 0) ?? false;
        if (acceptChosen && !acceptedFlag) {
          ok("quest.offer", await registry.invoke("quest.offer", { entity: playerEntity, questId: QUEST_ID }, at()));
          ok("quest.accept", await registry.invoke("quest.accept", { entity: playerEntity, questId: QUEST_ID }, at()));
          ok("quest.track", await registry.invoke("quest.track", { entity: playerEntity, questId: QUEST_ID }, at()));
          acceptedFlag = true;
        }
        await dialogue.advance(); // fires dialogue.end + closes the panels
      }
    }

    // (5) RELIC PICKUP — within reach ⇒ interaction.pickup → inventory + counter + quest.update.
    if (acceptedFlag) {
      for (const relic of relics) {
        if (relic.collected) continue;
        if (distXZ(lastPlayerPos, relic.pos) > PICKUP_RANGE) continue;
        const pk = ok("interaction.pickup", await registry.invoke("interaction.pickup", {
          itemEntity: relic.entity, actorEntity: playerEntity,
        }, at()));
        if (pk.ok !== true) continue;
        relic.collected = true;
        const c = ok("game.counter", await registry.invoke("game.counter", {
          name: "relics", action: "increment", value: 1,
        }, at()));
        const collected = c.value as number;
        ok("quest.update", await registry.invoke("quest.update", {
          entity: playerEntity, questId: QUEST_ID, objectiveId: QUEST_OBJECTIVE, progress: collected,
        }, at()));
        if (collected >= RELIC_TARGET) {
          ok("game.condition(eval)", await registry.invoke("game.condition", { name: "relics_done", action: "evaluate" }, at()));
        }
      }
    }

    // (6) WIN — all relics in hand AND back within the keeper's range ⇒ turn in.
    if (acceptedFlag && relicCount() >= RELIC_TARGET && npc.wantsToTalk()) {
      // The quest auto-completed on the 3rd relic; complete() is a guarded no-op if so.
      if (quests.getInstance(playerEntity, QUEST_ID)?.status === "active") {
        ok("quest.complete", await registry.invoke("quest.complete", { entity: playerEntity, questId: QUEST_ID }, at()));
      }
      ok("game.win", await registry.invoke("game.win", {}, at()));
    }
  }

  async function save(name: string): Promise<void> {
    const snapshot = { relics: relicCount(), hp: hp(), accepted: acceptedFlag, state: liveState() };
    ok("checkpoint.create", await registry.invoke("checkpoint.create", { name, gameState: snapshot }, at()));
  }

  async function load(name: string): Promise<{ relics: number; hp: number; accepted: boolean; state: CapstoneState }> {
    const res = ok("checkpoint.load", await registry.invoke("checkpoint.load", { name }, at()));
    const saved = (res.gameState ?? {}) as { relics?: number; hp?: number; accepted?: boolean; state?: CapstoneState };
    const relicsTo = typeof saved.relics === "number" ? saved.relics : relicCount();
    const hpTo = typeof saved.hp === "number" ? saved.hp : hp();
    // Re-apply the game-layer state through skills (the kinematic body itself is not restored —
    // checkpoint.* snapshots transforms + game state, not native physics internals).
    ok("game.counter(restore)", await registry.invoke("game.counter", { name: "relics", action: "set", value: relicsTo }, at()));
    const hpDelta = hpTo - hp();
    if (hpDelta !== 0) {
      ok("stats.modify(restore)", await registry.invoke("stats.modify", { entity: playerEntity, statName: "hp", delta: hpDelta }, at()));
    }
    acceptedFlag = saved.accepted ?? acceptedFlag;
    return { relics: relicsTo, hp: hpTo, accepted: acceptedFlag, state: saved.state ?? liveState() };
  }

  return {
    step, save, load,
    state: liveState,
    hp,
    relics: relicCount,
    accepted: () => acceptedFlag,
    endedAtTick: () => gs.getState().endedAtTick,
    playerPos: () => [lastPlayerPos[0], lastPlayerPos[1], lastPlayerPos[2]],
    npcPos: () => [lastNpcPos[0], lastNpcPos[1], lastNpcPos[2]],
    npcFacing: () => npc.facing(),
    playerEntity,
    npcEntity,
    questId: QUEST_ID,
    dialogueTreeId: DIALOGUE_TREE_ID,
    playerController,
    npc,
    dialogue,
  };
}

/** Absolute movement heading (radians) that walks from a planar point toward a target.
 *  Inverse of the controller basis (yaw=0 ⇒ -Z, so direction = (sin yaw, -cos yaw)). Shared
 *  by the headless script + the window demo's optional "walk to" assist. */
export function headingToward(fromX: number, fromZ: number, toX: number, toZ: number): number {
  return Math.atan2(toX - fromX, -(toZ - fromZ));
}
