// REMNANTS OF AETHON — THE EASTERN WATCH (Phase 0+1): the deterministic, skill-authored sim for
// the single-player halo loop. Modeled line-for-line on capstone_game.ts (buildCapstone) but set
// in the Aethon outpost environment from aethon_outpost.ts: a frontier watch post on a WEST→EAST
// Blight gradient. The healthy CAMP sits WEST (−X); the world drains EAST (+X) into the Blight.
//
// THE SCAFFOLD (Phase 0+1 — combat/enemies are LATER phases, intentionally absent):
//   • world.generateRegion (SEED 23, plains, the same bounds/shape as aethon_outpost) — the ground.
//   • navmesh (core.nav) — Torvald's walkable grid (terrain-height field).
//   • player.spawn — a real kinematic character at the CAMP (west); player.move drives it.
//   • the OUTPOST assets (watchtower / tents / campfire / well / barrels / pines + the Blight's dead
//     trees + toppled boundary marker) placed through asset.place — ported from aethon_outpost,
//     and (like capstone's biome/surface) only when WINDOWED, so the headless path stays light.
//   • stats.create — the player's HP (100).
//   • Torvald — a gruff veteran NPC (ScriptedNpc) standing at the campfire; greets when near.
//   • dialogue.define — Torvald's branching tree (warns of the Blight, asks the player to walk the
//     eastern perimeter and report — accept / decline branches); driven through DialogueRuntime.
//   • quest.define — "The Eastern Watch": one objective, reach the eastern perimeter. quest.offer/
//     accept/track on dialogue accept; reaching the perimeter auto-completes the objective; the
//     "report" (returning to Torvald) is the game.win.
//
// SIM vs RENDER (the replay invariant, inherited from capstone): step() is a PURE function of
// (state, input) — no Date.now / Math.random / wall clock. All mutation flows through the recorded
// skill surface; camera / models / HUD / dialogue bubbles are the window demo's job.

import { TILE_SIZE } from "../terrain/procedural.ts";
import { terrainTypeHints } from "../terrain/terrain-types.ts";
import { surveyRegionRelief } from "../terrain/biome-content.ts";
import type { InvokeBase, SkillRegistry, WorldContext } from "../skills/registry.ts";
import type { CoreSkills } from "../skills/index.ts";
import type { MCPResponse } from "../mcp/protocol.ts";
import type { CharacterController } from "../world/character.ts";
import { DialogueRuntime } from "../world/dialogue_runtime.ts";
import { ScriptedNpc } from "../world/npc_runtime.ts";

type Vec3 = [number, number, number];

// ── Authoring constants (the "agent's seeds"): the SAME fixed region as aethon_outpost. ──────────
/** Deterministic world seed (shared with aethon_outpost.ts). */
export const SEED = 23;
const TYPE = "plains" as const;
/** A small 2×2-tile region (~96 m) — identical bounds to aethon_outpost. */
const BOUNDS = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 } as const;
/** Terrain shape knobs (must match aethon_outpost so heights line up with the placed assets). */
const SHAPE = { amp: 0.25, erode: 0 } as const;
const HINTS = { ...terrainTypeHints(TYPE, BOUNDS), ...SHAPE };

const CENTER_X = ((BOUNDS.minTx + BOUNDS.maxTx + 1) / 2) * TILE_SIZE; // 48
const CENTER_Z = ((BOUNDS.minTz + BOUNDS.maxTz + 1) / 2) * TILE_SIZE; // 48
const WORLD_MIN = 0;
const WORLD_MAX = 2 * TILE_SIZE; // 96

/** The player spawns in the CAMP (west), in the open ground east of the campfire (a clear
 *  sightline to Torvald at the fire, not occluded by the pine ring or the watchtower). */
const PLAYER_OFFSET: readonly [number, number] = [-20, 6];
/** Torvald stands at the CAMPFIRE (matches aethon_outpost's campfire at dx=-29, dz=6). */
const TORVALD_OFFSET: readonly [number, number] = [-29, 6];
/** The eastern perimeter checkpoint — out in the Blight (+X), near the region's east edge. */
const PERIMETER_OFFSET: readonly [number, number] = [40, 0];

const PLAYER_HP = 100;
/** Torvald notices / can be reported to within this planar distance. */
const TALK_RADIUS = 4.5;
/** "Reached the eastern perimeter" planar distance. */
const PERIMETER_RANGE = 6;
const CAPSULE_OFFSET = 0.9; // halfHeight(0.5) + radius(0.35), rounded for the resting center Y.

/** Ids authored into the world (stable across runs). */
const QUEST_ID = "eastern_watch";
const QUEST_OBJECTIVE = "walk_perimeter";
const DIALOGUE_TREE_ID = "torvald";

/** The authored world layout in WORLD coordinates — shared with the window demo so it doesn't
 *  have to re-derive the spawn / Torvald / perimeter placement. */
export const AETHON_LAYOUT = {
  spawn: [CENTER_X + PLAYER_OFFSET[0], CENTER_Z + PLAYER_OFFSET[1]] as [number, number],
  torvald: [CENTER_X + TORVALD_OFFSET[0], CENTER_Z + TORVALD_OFFSET[1]] as [number, number],
  perimeter: [CENTER_X + PERIMETER_OFFSET[0], CENTER_Z + PERIMETER_OFFSET[1]] as [number, number],
  talkRadius: TALK_RADIUS,
  perimeterRange: PERIMETER_RANGE,
} as const;

/** Torvald's branching tree. choiceIndex 0 = accept, 1 = decline (matches the capstone convention
 *  the window demo's Space/Shift mapping relies on). A gruff veteran of the watch. */
const DIALOGUE_TREE = {
  id: DIALOGUE_TREE_ID,
  name: "Torvald, Watch-Veteran",
  startNode: "greet",
  nodes: [
    {
      id: "greet",
      text: "You're the new blood, then. Good. The Blight's been creeping west off the dead trees — I can smell it from the fire. I need eyes on the eastern line. Walk the perimeter and report back what you find. Will you do it?",
      speaker: "torvald",
      mood: "gruff",
      choices: [
        { text: "I'll walk it.", nextNodeId: "accept" },
        { text: "Not my watch.", nextNodeId: "decline" },
      ],
    },
    {
      id: "accept",
      text: "Hmph. Maybe you'll last. East, past the toppled marker, to the edge of the dead ground. Eyes open, mouth shut. Come back to the fire when it's done.",
      speaker: "torvald",
      choices: [],
    },
    {
      id: "decline",
      text: "Then keep warming the fire while the rest of us hold the line. Come find me when you've grown a spine.",
      speaker: "torvald",
      choices: [],
    },
  ],
};

/** The per-fixed-step input the sim consumes (identical contract to CapstoneInput). */
export interface AethonInput {
  forward: number;
  strafe?: number;
  yaw: number;
  run?: boolean;
  jump?: boolean;
  /** Dialogue choice index this step (≥0 to choose; <0 / undefined = no choice). */
  choose?: number;
}

export type AethonState = "playing" | "won" | "lost";

export interface BuildAethonDeps {
  world: WorldContext;
  registry: SkillRegistry;
  core: CoreSkills;
  base: InvokeBase;
}

/** The deterministic game controller returned by buildAethon (a Capstone-like interface). */
export interface AethonGame {
  step(dt: number, input: AethonInput): Promise<void>;
  save(name: string): Promise<void>;
  load(name: string): Promise<{ reached: boolean; hp: number; accepted: boolean; state: AethonState }>;
  state(): AethonState;
  hp(): number;
  /** Whether the eastern perimeter has been reached (objective progress). */
  reachedPerimeter(): boolean;
  /** Whether Torvald's quest has been accepted via the dialogue. */
  accepted(): boolean;
  endedAtTick(): number | undefined;
  playerPos(): Vec3;
  npcPos(): Vec3;
  npcFacing(): number;
  readonly playerEntity: string;
  readonly npcEntity: string;
  readonly questId: string;
  readonly dialogueTreeId: string;
  readonly playerController: CharacterController;
  readonly npc: ScriptedNpc;
  readonly dialogue: DialogueRuntime;
}

const distXZ = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(a[0] - b[0], a[2] - b[2]);

function ok(label: string, res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) {
    throw new Error(`aethon: ${label} failed: ${JSON.stringify(res?.error ?? "no response")}`);
  }
  return (res.result ?? {}) as Record<string, unknown>;
}

/**
 * Author the whole scaffold through skills + helpers and return the deterministic controller.
 * The native physics world MUST already be created by the caller (ops.op_physics_create_world).
 */
export async function buildAethon(deps: BuildAethonDeps): Promise<AethonGame> {
  const { world, registry, core, base } = deps;
  if (world === undefined || registry === undefined || core === undefined || base === undefined) {
    throw new Error("buildAethon: world, registry, core and base are all required");
  }
  const ops = world.ops;
  const windowed = world.mode === "windowed";

  let tick = 0;
  const at = (): InvokeBase => ({ ...base, tick, world });

  const surfaceY = (x: number, z: number): number => core.terrain.source.sampleHeight(SEED, x, z, 0, HINTS);

  // ── 1. GROUND. Colliders always; the visible PBR surface + biome scatter only when windowed. ──
  const relief = surveyRegionRelief(core.terrain.source, SEED, BOUNDS, HINTS);
  const gen = ok("world.generateRegion", await registry.invoke("world.generateRegion", {
    seed: SEED, bounds: BOUNDS, lod: 0, type: TYPE, hints: SHAPE, render: windowed,
    surface: windowed
      ? { mode: "pbr", roughness: 0.95, seaLevel: relief.minY - 5, minY: relief.minY, maxY: relief.maxY }
      : undefined,
  }, at()));
  const regionId = gen.regionId as string;
  if (typeof regionId !== "string" || regionId.length === 0) {
    throw new Error("buildAethon: world.generateRegion returned no regionId");
  }
  if (windowed) {
    ok("world.populateBiome", await registry.invoke("world.populateBiome", { regionId, type: TYPE }, at()));
  }
  ops.op_physics_step(); // build the broad-phase BVH so the first player.move resolves the ground.

  // ── 1b. THE OUTPOST (windowed only — render-heavy glb placement; mirrors aethon_outpost). ─────
  if (windowed) {
    const place = async (assetId: string, dx: number, dz: number, height: number, rotY = 0): Promise<void> => {
      const x = CENTER_X + dx, z = CENTER_Z + dz;
      const res = await registry.invoke("asset.place", {
        assetId, position: [x, surfaceY(x, z), z], normalizeHeight: height, rotation: [0, rotY, 0],
      }, at());
      if (!res.success) { ops.op_log(`asset.place FAILED ${assetId}: ${JSON.stringify(res.error)}`); return; }
      ops.op_log(`placed ${assetId} @(${dx.toFixed(0)},${dz.toFixed(0)})`);
    };
    // THE CAMP (west, healthy): watchtower + well + tents + fire + barrels, ringed by living pines.
    await place("building-wooden-watchtower-1.glb", -30, -2, 9.0);
    await place("prop-water-well-1.glb", -22, 8, 2.2);
    await place("prop-camping-tent-1.glb", -34, 9, 2.2, 0.6);
    await place("prop-camping-tent-1.glb", -27, 13, 2.2, -0.4);
    await place("prop-campfire-1.glb", -29, 6, 0.8);
    await place("prop-barrel-1.glb", -24, 2, 0.9);
    await place("prop-barrel-1.glb", -23, 3.2, 0.9);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      await place("vegetation-pine-tree-1.glb", -28 + Math.cos(a) * 14, Math.cos(a * 1.7) * 16, 6.5 + (i % 3), a);
    }
    // THE PERIMETER MARKER at the Blight boundary (toppled — a story beat + the player's first cue).
    await place("prop-stone-pillar-1.glb", 2, 4, 1.8, Math.PI / 2.3);
    // THE BLIGHT (east): dead trees, sparser eastward + receding into the haze.
    const deadTrees: Array<[number, number, number]> = [
      [12, -6, 7], [18, 7, 6.5], [16, -14, 6], [26, 2, 7.5], [30, -10, 6], [33, 12, 6.5], [40, -3, 7], [44, 9, 6],
    ];
    for (const [dx, dz, h] of deadTrees) await place("vegetation-dead-tree-1.glb", dx, dz, h, dx * 0.3);
  }

  // ── 2. NAVMESH for Torvald — a walkable grid over the region carrying terrain heights. ────────
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
    heightField: { heights },
  });
  if (!navRes.ok) throw new Error("buildAethon: navmesh.build failed");

  // ── 3. PLAYER. A real kinematic character resting on the surface at the CAMP. ──────────────────
  const spawnXZ: readonly [number, number] = [CENTER_X + PLAYER_OFFSET[0], CENTER_Z + PLAYER_OFFSET[1]];
  const spawn: Vec3 = [spawnXZ[0], surfaceY(spawnXZ[0], spawnXZ[1]) + CAPSULE_OFFSET, spawnXZ[1]];
  const playerEntity = ok("player.spawn", await registry.invoke("player.spawn", { position: spawn }, at())).entity as string;
  const ctrlEntry = core.player.controllers.get(playerEntity);
  if (ctrlEntry === undefined) throw new Error("buildAethon: player.spawn did not register a controller");
  const playerController = ctrlEntry.controller;
  ok("stats.create", await registry.invoke("stats.create", {
    entity: playerEntity, stats: [{ name: "hp", value: PLAYER_HP, maxValue: PLAYER_HP, minValue: 0 }],
  }, at()));

  // ── 4. TORVALD. A scene anchor entity (dialogue speaker + bubble anchor) plus a ScriptedNpc that
  //    idles at the campfire and faces the player when near. ─────────────────────────────────────
  const npcPosXZ: readonly [number, number] = [CENTER_X + TORVALD_OFFSET[0], CENTER_Z + TORVALD_OFFSET[1]];
  const npcY = surfaceY(npcPosXZ[0], npcPosXZ[1]);
  const npcEntity = ok("scene.createEntity(torvald)", await registry.invoke("scene.createEntity", {
    shape: "box", size: 1, color: 0x6b4a2b, position: [npcPosXZ[0], npcY + 0.9, npcPosXZ[1]],
  }, at())).entity as string;
  // Face the player's spawn (east-ish) so he greets toward the camp's open ground.
  const startYaw = Math.atan2(spawnXZ[0] - npcPosXZ[0], spawnXZ[1] - npcPosXZ[1]);
  const npc = new ScriptedNpc(
    { registry, base: at(), world, navmeshManager: nav, regionId, seed: SEED },
    {
      waypoints: [[npcPosXZ[0], npcPosXZ[1]]], // single waypoint ⇒ stands + greets
      speed: 3,
      talkRadius: TALK_RADIUS,
      startPos: [npcPosXZ[0], npcY, npcPosXZ[1]],
      startYaw,
    },
  );

  // ── 5. QUEST. One objective: reach the eastern perimeter. Offered + accepted on dialogue. ──────
  ok("quest.define", await registry.invoke("quest.define", {
    id: QUEST_ID, name: "The Eastern Watch",
    description: "Walk the eastern perimeter and report back to Torvald what you find.",
    objectives: [{
      id: QUEST_OBJECTIVE, type: "reach", description: "Walk the eastern perimeter", required: 1,
    }],
  }, at()));

  // ── 6. DIALOGUE tree + runtime. ───────────────────────────────────────────────────────────────
  ok("dialogue.define", await registry.invoke("dialogue.define", DIALOGUE_TREE, at()));
  const dialogue = new DialogueRuntime({ registry, base: at(), uiManager: core.ui, world });

  const gs = core.gamestate.gameStateManager;
  const stats = core.combat.statsManager;
  const quests = core.quest.questManager;
  let acceptedFlag = false;
  let reachedFlag = false;
  let npcTalkLatch = false;
  const perimeter: Vec3 = [CENTER_X + PERIMETER_OFFSET[0], surfaceY(CENTER_X + PERIMETER_OFFSET[0], CENTER_Z + PERIMETER_OFFSET[1]), CENTER_Z + PERIMETER_OFFSET[1]];
  let lastPlayerPos: Vec3 = [spawn[0], spawn[1], spawn[2]];
  let lastNpcPos: Vec3 = [npcPosXZ[0], npcY, npcPosXZ[1]];

  const hp = (): number => stats.getStat(playerEntity, "hp")?.value ?? 0;
  const liveState = (): AethonState => {
    const s = gs.getState().state;
    return s === "won" ? "won" : s === "lost" ? "lost" : "playing";
  };

  // ── The deterministic sim tick. ────────────────────────────────────────────────────────────────
  async function step(dt: number, input: AethonInput): Promise<void> {
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

    // (2) TORVALD — deterministic greet (stands at the fire, faces the player when near).
    lastNpcPos = npc.tick(dt, lastPlayerPos);

    // (3) DIALOGUE — open Torvald's greeting ONCE per approach (edge-triggered on entering talk
    //     range) so DECLINING sticks; leaving + re-approaching re-arms it.
    const wantsTalk = npc.wantsToTalk();
    if (!wantsTalk) npcTalkLatch = false;
    if (!acceptedFlag && wantsTalk && !npcTalkLatch && !dialogue.isActive()) {
      npcTalkLatch = true;
      await dialogue.open(npcEntity, playerEntity, DIALOGUE_TREE_ID);
    }
    if (dialogue.isActive()) {
      const choose = input.choose;
      if (choose !== undefined && choose >= 0 && !dialogue.isTerminal()) {
        await dialogue.choose(choose);
      }
      if (dialogue.isActive() && dialogue.isTerminal()) {
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

    // (4) PERIMETER — reaching the eastern line completes the objective (auto-completes the quest).
    if (acceptedFlag && !reachedFlag && distXZ(lastPlayerPos, perimeter) <= PERIMETER_RANGE) {
      reachedFlag = true;
      const c = ok("game.counter", await registry.invoke("game.counter", {
        name: "perimeter", action: "set", value: 1,
      }, at()));
      ok("quest.update", await registry.invoke("quest.update", {
        entity: playerEntity, questId: QUEST_ID, objectiveId: QUEST_OBJECTIVE, progress: c.value as number,
      }, at()));
    }

    // (5) REPORT / WIN — perimeter walked AND back within Torvald's range ⇒ report in ⇒ win.
    if (acceptedFlag && reachedFlag && npc.wantsToTalk()) {
      if (quests.getInstance(playerEntity, QUEST_ID)?.status === "active") {
        ok("quest.complete", await registry.invoke("quest.complete", { entity: playerEntity, questId: QUEST_ID }, at()));
      }
      ok("game.win", await registry.invoke("game.win", {}, at()));
    }
  }

  async function save(name: string): Promise<void> {
    const snapshot = { reached: reachedFlag, hp: hp(), accepted: acceptedFlag, state: liveState() };
    ok("checkpoint.create", await registry.invoke("checkpoint.create", { name, gameState: snapshot }, at()));
  }

  async function load(name: string): Promise<{ reached: boolean; hp: number; accepted: boolean; state: AethonState }> {
    const res = ok("checkpoint.load", await registry.invoke("checkpoint.load", { name }, at()));
    const saved = (res.gameState ?? {}) as { reached?: boolean; hp?: number; accepted?: boolean; state?: AethonState };
    const hpTo = typeof saved.hp === "number" ? saved.hp : hp();
    const hpDelta = hpTo - hp();
    if (hpDelta !== 0) {
      ok("stats.modify(restore)", await registry.invoke("stats.modify", { entity: playerEntity, statName: "hp", delta: hpDelta }, at()));
    }
    acceptedFlag = saved.accepted ?? acceptedFlag;
    reachedFlag = saved.reached ?? reachedFlag;
    return { reached: reachedFlag, hp: hpTo, accepted: acceptedFlag, state: saved.state ?? liveState() };
  }

  return {
    step, save, load,
    state: liveState,
    hp,
    reachedPerimeter: () => reachedFlag,
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

/** Absolute movement heading (radians) that walks from a planar point toward a target. Shared
 *  with the window demo's initial facing. */
export function headingToward(fromX: number, fromZ: number, toX: number, toZ: number): number {
  return Math.atan2(toX - fromX, -(toZ - fromZ));
}
