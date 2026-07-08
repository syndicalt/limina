// BEACON QUEST — "Light the Eastern Beacon": the shared, deterministic builder + sim for the
// Track-1 capstone game, authored ENTIRELY from the limina game skills + the world/ helpers
// (DialogueRuntime, ScriptedNpc, GameHud) on a MAP-PAINTER-authored world. It is the Beacon
// Quest sibling of capstone_game.ts ("The Relic Hunt"): same deterministic spine + skill
// surface, but the ground is the painted Eastern Watch (games/beacon-quest/), the quest is a
// vanilla-WoW fetch loop (take the charge → light the beacon → return → turn in), and the
// hazard is the Blight. Shared by BOTH the human-playable window demo and the headless gate
// (js/test/p14_beacon_quest.ts).
//
// THE WORLD IS PAINTED, NOT GENERATED: the caller builds `core` with a MapTerrainSource backed
// by the compiled Beacon Quest WorldMap (assets/maps/beacon-quest-primary.worldmap.json), so
// world.generateRegion streams the PAINTED terrain and core.terrain.source.sampleHeight returns
// the painted heights — the integration proof that the Map Painter feeds the capstone. See
// makeBeaconCore() below.
//
// THE GAME (a complete loop, all skill-authored):
//   • world.generateRegion over the play bounds (painted terrain tiles) — the island ground.
//   • navmesh — the warden's walkable grid (painted-height field).
//   • player.spawn at the warden's camp; player.move drives it (replay-faithful).
//   • scene.createEntity (warden anchor + the beacon marker); interaction.register makes the
//     beacon a "light" interactable; inventory.create gives the player a pack; stats.create HP.
//   • quest.define — one objective: light the Eastern Beacon; offered/accepted on dialogue.
//   • dialogue.define — the warden's branching charge (accept / decline) via DialogueRuntime.
//   • trigger.create — the BLIGHT hazard; its fired action drains HP (HP→0 ⇒ game.lose).
//   • game.counter / game.condition / game.win / game.lose — the win/lose state machine.
//   • checkpoint.create/load — a mid-game save/load of the game-layer state.
//
// SIM vs RENDER (the replay invariant): step() is a PURE function of (state, input) — no
// Date.now / Math.random / wall clock. Every mutation flows through the recorded skill surface,
// so a recorded session replays bit-identically; the same scripted input twice is byte-identical.

import { TILE_SIZE } from "../terrain/procedural.ts";
import { terrainTypeHints } from "../terrain/terrain-types.ts";
import { MapTerrainSource } from "../terrain/map-source.ts";
import { WorldMapSchema, verifyWorldMap, type WorldMap } from "../world/worldmap.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills, type CoreSkills } from "../skills/index.ts";
import type { MCPResponse } from "../mcp/protocol.ts";
import type { CharacterController } from "../world/character.ts";
import { DialogueRuntime } from "../world/dialogue_runtime.ts";
import { ScriptedNpc } from "../world/npc_runtime.ts";

type Vec3 = [number, number, number];

// ── Authoring constants (the "agent's seeds"): the painted world + a fixed quest layout. ─────
/** Deterministic sim seed (shared by the demo + the test). */
export const SEED = 0xbea0;
/** Terrain-type hints for the region call. The MapTerrainSource ignores them (it samples the
 *  painted field), but generateRegion still wants a type; "plains" keeps the region metadata sane. */
const TYPE = "plains" as const;
/** The compiled Beacon Quest WorldMap asset id (under assets/maps/), consumed by the map source. */
export const BEACON_MAP_ASSET = "beacon-quest-primary.worldmap.json";

/** Play bounds in TILES (TILE_SIZE=48) covering camp(≈-40,10) → beacon(150,-20): world x∈[-144,240],
 *  z∈[-96,96]. Wide enough that the whole quest path streams in. */
const BOUNDS = { minTx: -3, minTz: -2, maxTx: 4, maxTz: 1 } as const;
const HINTS = terrainTypeHints(TYPE, BOUNDS);
const WORLD = { minX: BOUNDS.minTx * TILE_SIZE, minZ: BOUNDS.minTz * TILE_SIZE, maxX: (BOUNDS.maxTx + 1) * TILE_SIZE, maxZ: (BOUNDS.maxTz + 1) * TILE_SIZE };

/** Quest-critical world positions (metres; must sit inside WORLD). north = -z, east = +x. */
const SPAWN_XZ: readonly [number, number] = [-30, 0];      // open ground by the camp
const WARDEN_XZ: readonly [number, number] = [-40, 18];    // at the Warden's Hall (world-bible)
const BEACON_XZ: readonly [number, number] = [150, -20];   // the Eastern Beacon headland
/** The Blight hazard: a blighted tongue SOUTH of camp — OFF the eastward beacon path, so the
 *  win path never touches it and the lose path walks deliberately into it. */
const BLIGHT_XZ: readonly [number, number] = [-18, 40];
const BLIGHT_HALF: Vec3 = [8, 4, 8];

const PLAYER_HP = 100;
/** HP drained per fixed step in the Blight (100 HP ⇒ ~20 ticks to die). */
const BLIGHT_DPS = 5;
/** Light the beacon within this planar distance. */
const BEACON_RANGE = 5;
/** The warden gives / accepts a turn-in within this planar distance. */
const TALK_RADIUS = 4.5;
const CAPSULE_OFFSET = 0.9; // halfHeight(0.5) + radius(0.35), rounded — the resting centre Y.

/** Ids authored into the world (stable across runs). */
const QUEST_ID = "light_the_beacon";
const QUEST_OBJECTIVE = "light_beacon";
const DIALOGUE_TREE_ID = "the_warden";

/** The authored quest layout in WORLD coordinates — shared with the headless script + the
 *  window demo so neither re-derives the warden/beacon/hazard placement. */
export const BEACON_LAYOUT = {
  spawn: SPAWN_XZ,
  warden: WARDEN_XZ,
  beacon: BEACON_XZ,
  blight: BLIGHT_XZ,
  talkRadius: TALK_RADIUS,
  beaconRange: BEACON_RANGE,
} as const;

/** The branching warden dialogue. choiceIndex 0 = accept, 1 = decline. */
const DIALOGUE_TREE = {
  id: DIALOGUE_TREE_ID,
  name: "The Warden",
  startNode: "greet",
  nodes: [
    {
      id: "greet",
      text: "The east beacon's gone dark and the Blight comes with the night. Light it before dusk — will you?",
      speaker: "the_warden",
      mood: "grim",
      choices: [
        { text: "I'll light it.", nextNodeId: "accept" },
        { text: "Not tonight.", nextNodeId: "decline" },
      ],
    },
    { id: "accept", text: "Good. The headland's east, past the wood. Keep clear of the Blight.", speaker: "the_warden", choices: [] },
    { id: "decline", text: "Then we watch the dark and hope. Come back if your nerve returns.", speaker: "the_warden", choices: [] },
  ],
};

/** The per-fixed-step input the sim consumes (identical shape to the capstone's). */
export interface BeaconInput {
  forward: number;
  strafe?: number;
  yaw: number;
  run?: boolean;
  jump?: boolean;
  choose?: number;
  /** Light the beacon this step (the window demo binds it to the interact key; the headless
   *  test sets it true once in range). Ignored unless the player is within BEACON_RANGE. */
  light?: boolean;
}

export type BeaconState = "playing" | "won" | "lost";

export interface BuildBeaconDeps {
  world: WorldContext;
  registry: SkillRegistry;
  core: CoreSkills;
  base: InvokeBase;
}

/** The deterministic game controller returned by buildBeaconQuest. */
export interface BeaconQuest {
  step(dt: number, input: BeaconInput): Promise<void>;
  save(name: string): Promise<void>;
  load(name: string): Promise<{ lit: boolean; hp: number; accepted: boolean; state: BeaconState }>;
  state(): BeaconState;
  hp(): number;
  /** Whether the beacon has been lit. */
  lit(): boolean;
  accepted(): boolean;
  endedAtTick(): number | undefined;
  playerPos(): Vec3;
  npcPos(): Vec3;
  npcFacing(): number;
  readonly playerEntity: string;
  readonly npcEntity: string;
  readonly beaconEntity: string;
  readonly questId: string;
  readonly dialogueTreeId: string;
  readonly playerController: CharacterController;
  readonly npc: ScriptedNpc;
  readonly dialogue: DialogueRuntime;
}

const distXZ = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[2] - b[2]);
const distXZp = (a: readonly number[], b: readonly [number, number]): number => Math.hypot(a[0] - b[0], a[2] - b[1]);

function ok(label: string, res: MCPResponse | undefined): Record<string, unknown> {
  if (res === undefined || !res.success) {
    throw new Error(`beacon_quest: ${label} failed: ${JSON.stringify(res?.error ?? "no response")}`);
  }
  return (res.result ?? {}) as Record<string, unknown>;
}

/** Parse + verify a compiled Beacon Quest WorldMap from its JSON text (the caller reads the file;
 *  this module stays I/O-free for the determinism discipline). Throws on a schema/hash failure. */
export function loadBeaconWorldMap(worldMapJson: string): WorldMap {
  // WorldMapSchema.parse enforces STRUCTURE (throws on a malformed map). verifyWorldMap only
  // re-checks the content hash — and op_sha256 (Rust host) is not byte-identical to the JS
  // hash, so a mismatch is benign provenance drift, never corruption. Per the engine-wide rule
  // (CLAUDE.md failure mode #12) a hash mismatch WARNS and continues; it must never block.
  const worldMap = WorldMapSchema.parse(JSON.parse(worldMapJson));
  const verdict = verifyWorldMap(worldMap);
  if (!verdict.ok) {
    console.warn(`loadBeaconWorldMap: content-hash drift (expected ${verdict.expected}, got ${verdict.actual}) — continuing (assetId pins identity).`);
  }
  return worldMap;
}

/** Build a CoreSkills whose terrain source is the painted Beacon Quest world. The returned core
 *  makes world.generateRegion stream the painted tiles and core.terrain.source.sampleHeight
 *  return painted heights — so buildBeaconQuest authors the game on the Map-Painter world. */
export function makeBeaconCore(registry: SkillRegistry, worldMap: WorldMap): CoreSkills {
  const terrainSource = new MapTerrainSource({ worldMap, name: "beacon-quest", seed: 11 });
  return registerCoreSkills(registry, { terrainSource });
}

/**
 * Author the whole Beacon Quest through skills + helpers and return the deterministic controller.
 * The native physics world MUST already be created by the caller (ops.op_physics_create_world),
 * and `core` MUST be a makeBeaconCore(...) (its terrain source is the painted world).
 */
export async function buildBeaconQuest(deps: BuildBeaconDeps): Promise<BeaconQuest> {
  const { world, registry, core, base } = deps;
  if (world === undefined || registry === undefined || core === undefined || base === undefined) {
    throw new Error("buildBeaconQuest: world, registry, core and base are all required");
  }
  const ops = world.ops;
  const windowed = world.mode === "windowed";

  let tick = 0;
  const at = (): InvokeBase => ({ ...base, tick, world });

  // ── 1. GROUND — the painted region. Colliders always; the visible surface + scatter only
  //    windowed (headless needs only the data/colliders). ─────────────────────────────────────
  const gen = ok("world.generateRegion", await registry.invoke("world.generateRegion", {
    seed: SEED, bounds: BOUNDS, lod: 0, type: TYPE, render: windowed,
    surface: windowed ? { mode: "pbr" } : undefined,
  }, at()));
  const regionId = gen.regionId as string;
  if (typeof regionId !== "string" || regionId.length === 0) {
    throw new Error("buildBeaconQuest: world.generateRegion returned no regionId");
  }
  if (windowed) ok("world.populateBiome", await registry.invoke("world.populateBiome", { regionId, type: TYPE }, at()));
  ops.op_physics_step();

  const surfaceY = (x: number, z: number): number => core.terrain.source.sampleHeight(SEED, x, z, 0, HINTS);

  // ── 2. NAVMESH for the warden — a walkable grid over the play bounds carrying painted heights. ─
  const CELL = 4;
  const cols = Math.ceil((WORLD.maxX - WORLD.minX) / CELL);
  const rows = Math.ceil((WORLD.maxZ - WORLD.minZ) / CELL);
  const heights = new Array<number>(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      heights[r * cols + c] = surfaceY(WORLD.minX + (c + 0.5) * CELL, WORLD.minZ + (r + 0.5) * CELL);
    }
  }
  const nav = core.nav.navmeshManager;
  const navRes = nav.build({
    bounds: { minX: WORLD.minX, minZ: WORLD.minZ, maxX: WORLD.maxX, maxZ: WORLD.maxZ },
    cellSize: CELL, heightField: { heights },
  });
  if (!navRes.ok) throw new Error("buildBeaconQuest: navmesh.build failed");

  // ── 3. PLAYER — a kinematic character resting on the painted surface at the camp. ────────────
  const spawn: Vec3 = [SPAWN_XZ[0], surfaceY(SPAWN_XZ[0], SPAWN_XZ[1]) + CAPSULE_OFFSET, SPAWN_XZ[1]];
  const playerEntity = ok("player.spawn", await registry.invoke("player.spawn", { position: spawn }, at())).entity as string;
  const ctrlEntry = core.player.controllers.get(playerEntity);
  if (ctrlEntry === undefined) throw new Error("buildBeaconQuest: player.spawn did not register a controller");
  const playerController = ctrlEntry.controller;
  ok("inventory.create", await registry.invoke("inventory.create", { entity: playerEntity, capacity: 8 }, at()));
  ok("stats.create", await registry.invoke("stats.create", {
    entity: playerEntity, stats: [{ name: "hp", value: PLAYER_HP, maxValue: PLAYER_HP, minValue: 0 }],
  }, at()));

  // ── 4. THE WARDEN — a scene anchor (dialogue speaker + bubble anchor) + a ScriptedNpc that
  //    stands at the hall and faces the player when near. ─────────────────────────────────────
  const npcY = surfaceY(WARDEN_XZ[0], WARDEN_XZ[1]);
  const npcEntity = ok("scene.createEntity(warden)", await registry.invoke("scene.createEntity", {
    shape: "box", size: 1, color: 0x8a6d3b, position: [WARDEN_XZ[0], npcY + 0.9, WARDEN_XZ[1]],
  }, at())).entity as string;
  const npc = new ScriptedNpc(
    { registry, base: at(), world, navmeshManager: nav, regionId, seed: SEED },
    { waypoints: [[WARDEN_XZ[0], WARDEN_XZ[1]]], speed: 3, talkRadius: TALK_RADIUS, startPos: [WARDEN_XZ[0], npcY, WARDEN_XZ[1]], startYaw: 0 },
  );

  // ── 5. THE BEACON — one interactable marker on the headland; interaction.register makes it
  //    lightable. The visible watchtower is a world stamp (windowed); this is its logical hook. ─
  const beaconY = surfaceY(BEACON_XZ[0], BEACON_XZ[1]);
  const beaconEntity = ok("scene.createEntity(beacon)", await registry.invoke("scene.createEntity", {
    shape: "box", size: 1.2, color: 0xffaa33, position: [BEACON_XZ[0], beaconY + 1.2, BEACON_XZ[1]],
  }, at())).entity as string;
  ok("interaction.register(beacon)", await registry.invoke("interaction.register", {
    entity: beaconEntity, prompt: "Light the beacon", maxRange: BEACON_RANGE, type: "use",
  }, at()));

  // ── 6. QUEST — one objective: light the beacon. Offered + accepted on dialogue accept. ───────
  ok("quest.define", await registry.invoke("quest.define", {
    id: QUEST_ID, name: "Light the Eastern Beacon",
    description: "Light the signal beacon on the eastern headland and return to the warden.",
    objectives: [{ id: QUEST_OBJECTIVE, type: "custom", description: "Light the Eastern Beacon", required: 1 }],
  }, at()));

  // ── 7. DIALOGUE tree + runtime. ──────────────────────────────────────────────────────────────
  ok("dialogue.define", await registry.invoke("dialogue.define", DIALOGUE_TREE, at()));
  const dialogue = new DialogueRuntime({ registry, base: at(), uiManager: core.ui, world });

  // ── 8. BLIGHT hazard — a box zone whose onEnter/onStay action carries the per-tick damage. ───
  const blightId = ok("trigger.create", await registry.invoke("trigger.create", {
    shape: "box",
    center: [BLIGHT_XZ[0], surfaceY(BLIGHT_XZ[0], BLIGHT_XZ[1]) + BLIGHT_HALF[1], BLIGHT_XZ[1]],
    size: BLIGHT_HALF, config: { name: "the_blight" },
  }, at())).triggerId as string;
  const blightAction = { type: "custom" as const, data: { damage: BLIGHT_DPS } };
  ok("trigger.onEnter", await registry.invoke("trigger.onEnter", { triggerId: blightId, action: blightAction }, at()));
  ok("trigger.onStay", await registry.invoke("trigger.onStay", { triggerId: blightId, action: blightAction }, at()));

  // ── 9. WIN/LOSE bookkeeping. ─────────────────────────────────────────────────────────────────
  ok("game.condition", await registry.invoke("game.condition", {
    name: "beacon_lit", expression: `counter('beacon') >= 1`, onTrue: "game.objectiveComplete",
  }, at()));

  const gs = core.gamestate.gameStateManager;
  const stats = core.combat.statsManager;
  const quests = core.quest.questManager;
  let acceptedFlag = false;
  let beaconLit = false;
  let npcTalkLatch = false;
  let lastPlayerPos: Vec3 = [spawn[0], spawn[1], spawn[2]];
  let lastNpcPos: Vec3 = [WARDEN_XZ[0], npcY, WARDEN_XZ[1]];

  const hp = (): number => stats.getStat(playerEntity, "hp")?.value ?? 0;
  const beaconCount = (): number => gs.getCounter("beacon");
  const liveState = (): BeaconState => {
    const s = gs.getState().state;
    return s === "won" ? "won" : s === "lost" ? "lost" : "playing";
  };

  async function step(dt: number, input: BeaconInput): Promise<void> {
    if (liveState() !== "playing") return;
    tick++;

    // (1) MOVE — skill-driven.
    const dialogueOpen = dialogue.isActive();
    const mv = ok("player.move", await registry.invoke("player.move", {
      entity: playerEntity, forward: input.forward, strafe: input.strafe ?? 0, yaw: input.yaw,
      run: input.run === true, jump: input.jump === true && !dialogueOpen,
    }, at()));
    lastPlayerPos = mv.newPosition as Vec3;

    // (2) NPC — deterministic stand/greet.
    lastNpcPos = npc.tick(dt, lastPlayerPos);

    // (3) BLIGHT — trigger pump → HP drain.
    const fired = core.triggers.triggerManager.tick([{ id: playerEntity, position: lastPlayerPos }]).fired;
    let totalDamage = 0;
    for (const f of fired) {
      if (f.triggerId !== blightId || f.entityId !== playerEntity) continue;
      const dmg = (f.action.data as { damage?: number } | undefined)?.damage ?? 0;
      if (dmg > 0) totalDamage += dmg;
    }
    if (totalDamage > 0) {
      const res = ok("damage.apply", await registry.invoke("damage.apply", { targetEntity: playerEntity, amount: totalDamage, type: "poison" }, at()));
      if (res.killed === true || hp() <= 0) {
        ok("game.lose", await registry.invoke("game.lose", {}, at()));
        return;
      }
    }

    // (4) DIALOGUE — open the warden's charge ONCE per approach (edge-triggered).
    const wantsTalk = npc.wantsToTalk();
    if (!wantsTalk) npcTalkLatch = false;
    if (!acceptedFlag && wantsTalk && !npcTalkLatch && !dialogue.isActive()) {
      npcTalkLatch = true;
      await dialogue.open(npcEntity, playerEntity, DIALOGUE_TREE_ID);
    }
    if (dialogue.isActive()) {
      const choose = input.choose;
      if (choose !== undefined && choose >= 0 && !dialogue.isTerminal()) await dialogue.choose(choose);
      if (dialogue.isActive() && dialogue.isTerminal()) {
        const session = core.behavior.dialogueManager.getCurrentSession(npcEntity, playerEntity);
        const acceptChosen = session?.history.some((h) => h.choiceIndex === 0) ?? false;
        if (acceptChosen && !acceptedFlag) {
          ok("quest.offer", await registry.invoke("quest.offer", { entity: playerEntity, questId: QUEST_ID }, at()));
          ok("quest.accept", await registry.invoke("quest.accept", { entity: playerEntity, questId: QUEST_ID }, at()));
          ok("quest.track", await registry.invoke("quest.track", { entity: playerEntity, questId: QUEST_ID }, at()));
          acceptedFlag = true;
        }
        await dialogue.advance();
      }
    }

    // (5) LIGHT THE BEACON — accepted + in range + the light input ⇒ interaction.activate →
    //     counter + quest.update (once).
    if (acceptedFlag && !beaconLit && input.light === true && distXZp(lastPlayerPos, BEACON_XZ) <= BEACON_RANGE) {
      const act = ok("interaction.interact", await registry.invoke("interaction.interact", {
        entity: beaconEntity, actorEntity: playerEntity,
      }, at()));
      if (act.ok === true) {
        beaconLit = true;
        ok("game.counter", await registry.invoke("game.counter", { name: "beacon", action: "increment", value: 1 }, at()));
        ok("quest.update", await registry.invoke("quest.update", {
          entity: playerEntity, questId: QUEST_ID, objectiveId: QUEST_OBJECTIVE, progress: 1,
        }, at()));
        ok("game.condition(eval)", await registry.invoke("game.condition", { name: "beacon_lit", action: "evaluate" }, at()));
      }
    }

    // (6) WIN — beacon lit AND back within the warden's range ⇒ turn in.
    if (acceptedFlag && beaconLit && beaconCount() >= 1 && npc.wantsToTalk()) {
      if (quests.getInstance(playerEntity, QUEST_ID)?.status === "active") {
        ok("quest.complete", await registry.invoke("quest.complete", { entity: playerEntity, questId: QUEST_ID }, at()));
      }
      ok("game.win", await registry.invoke("game.win", {}, at()));
    }
  }

  async function save(name: string): Promise<void> {
    const snapshot = { lit: beaconLit ? 1 : 0, hp: hp(), accepted: acceptedFlag, state: liveState() };
    ok("checkpoint.create", await registry.invoke("checkpoint.create", { name, gameState: snapshot }, at()));
  }

  async function load(name: string): Promise<{ lit: boolean; hp: number; accepted: boolean; state: BeaconState }> {
    const res = ok("checkpoint.load", await registry.invoke("checkpoint.load", { name }, at()));
    const saved = (res.gameState ?? {}) as { lit?: number; hp?: number; accepted?: boolean; state?: BeaconState };
    const litTo = typeof saved.lit === "number" ? saved.lit >= 1 : beaconLit;
    const hpTo = typeof saved.hp === "number" ? saved.hp : hp();
    ok("game.counter(restore)", await registry.invoke("game.counter", { name: "beacon", action: "set", value: litTo ? 1 : 0 }, at()));
    const hpDelta = hpTo - hp();
    if (hpDelta !== 0) ok("stats.modify(restore)", await registry.invoke("stats.modify", { entity: playerEntity, statName: "hp", delta: hpDelta }, at()));
    beaconLit = litTo;
    acceptedFlag = saved.accepted ?? acceptedFlag;
    return { lit: litTo, hp: hpTo, accepted: acceptedFlag, state: saved.state ?? liveState() };
  }

  return {
    step, save, load,
    state: liveState, hp, lit: () => beaconLit, accepted: () => acceptedFlag,
    endedAtTick: () => gs.getState().endedAtTick,
    playerPos: () => [lastPlayerPos[0], lastPlayerPos[1], lastPlayerPos[2]],
    npcPos: () => [lastNpcPos[0], lastNpcPos[1], lastNpcPos[2]],
    npcFacing: () => npc.facing(),
    playerEntity, npcEntity, beaconEntity, questId: QUEST_ID, dialogueTreeId: DIALOGUE_TREE_ID,
    playerController, npc, dialogue,
  };
}

/** Absolute movement heading (radians) walking from a planar point toward a target (inverse of
 *  the controller basis: yaw=0 ⇒ -Z, so direction = (sin yaw, -cos yaw)). */
export function headingToward(fromX: number, fromZ: number, toX: number, toZ: number): number {
  return Math.atan2(toX - fromX, -(toZ - fromZ));
}
