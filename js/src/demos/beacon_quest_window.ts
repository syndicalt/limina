// BEACON QUEST — the human-playable build of "Light the Eastern Beacon". Boots the SAME shared,
// deterministic builder/sim as the headless gate (js/test/p14_beacon_quest.ts → js/src/demos/
// beacon_quest.ts) on the MAP-PAINTER world, then layers RENDER-ONLY presentation on top: a
// third-person camera, rigged player + warden models, the dialogue speech bubble, and the HUD
// (HP + quest progress). The fixedStep samples the keyboard into the BeaconInput and calls
// beaconQuest.step; ALL game state lives in the deterministic sim — this file only draws it.
//
// Run: ./target/release/limina --window js/src/demos/beacon_quest_window.ts
//   (frame-capped: ./target/release/limina --window --frames 40 js/src/demos/beacon_quest_window.ts)
//
// THE GAME: the painted Eastern Watch — a warden at the camp, the unlit beacon east on its
// headland, the Blight south. Walk to the warden → a dialogue opens → accept → walk east to the
// beacon → press Space in range to LIGHT it (avoid the Blight, it drains HP) → return to WIN.
//
// CONTROLS: click the window to capture the mouse (Escape releases).
//   W/S — move        A/D — turn        mouse — look        Shift — run
//   Space — jump / light the beacon (when in range) / accept in dialogue    Shift — decline

import { ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { createWindowedContext } from "../game/index.ts";
import { ThirdPersonCamera } from "../world/third_person_camera.ts";
import { attachCharacterModel } from "../world/character_model.ts";
import { applyTurn } from "../world/heading.ts";
import { GameHud } from "../world/game_hud.ts";
import { MapTerrainSource } from "../terrain/map-source.ts";
import { buildBeaconQuest, loadBeaconWorldMap, BEACON_LAYOUT, type BeaconInput } from "./beacon_quest.ts";

// ── The painted world (the SAME committed artifact the peek renders + the gate plays). ────────
const worldMapText = new TextDecoder().decode(ops.op_read_asset("maps/beacon-quest-primary.worldmap.json"));
const worldMap = loadBeaconWorldMap(worldMapText);

// ── Engine + skill surface, cored on the MAP terrain source so world.generateRegion streams the
//    painted ground and sampleHeight is painter-authored. The flat ground plane is suppressed —
//    the painted terrain IS the ground. The source is built ONCE and handed to the context's
//    single registerCoreSkills via coreOpts (never re-core the same registry). ─────────────────
const terrainSource = new MapTerrainSource({ worldMap, name: "beacon-quest", seed: 11 });
const ctx = await createWindowedContext({
  width: 1280, height: 720,
  renderBaseline: { ground: { enabled: false } },
  session: "ses_beacon", agentId: "agt_beacon",
  coreOpts: { terrainSource },
});
const engine = ctx.engine!;
const world = ctx.world;
const registry = ctx.registry;
const core = ctx.core;
const base = ctx.base;

ops.op_physics_create_world(-9.81);

// ── AUTHOR THE GAME (shared builder — painted region, navmesh, player, warden, beacon, quest,
//    dialogue, Blight, win/lose). Identical to the headless gate. ──────────────────────────────
const q = await buildBeaconQuest({ world, registry, core, base });

// ── RENDER-ONLY: rigged character models (the sim drives positions; these just follow). ───────
const pPos = q.playerController.position;
const playerModel = await attachCharacterModel({
  assetId: "robot.glb",
  world, registry, base, animationManager: core.animation.animationManager,
  position: [pPos[0], pPos[1] - q.playerController.groundOffset, pPos[2]],
});
const nPos = q.npcPos();
const npcModel = await attachCharacterModel({
  assetId: "robot.glb",
  world, registry, base, animationManager: core.animation.animationManager,
  position: [nPos[0], nPos[1], nPos[2]],
  // The warden: a weathered brass tint, a touch shorter than the player.
  tintColor: 0x8A6D3B, targetHeight: 1.72,
});

// ── HUD: HP (vitals) + the beacon objective, reading the live managers. ───────────────────────
const hud = new GameHud({
  uiManager: core.ui, world,
  managers: {
    stats: core.combat.statsManager,
    quest: core.quest.questManager,
    inventory: core.inventory.inventoryManager,
    gamestate: core.gamestate.gameStateManager,
  },
  options: { hpStat: "hp", counters: ["beacon"], vitalsTitle: "VITALS", questTitle: "QUEST", turnInHint: "Return to the warden" },
});
hud.init();
hud.setQuest(q.questId);

engine.camera.near = 0.3;
engine.camera.far = 1000;
engine.camera.updateProjectionMatrix();
const camera = new ThirdPersonCamera({ distance: 7, lookHeight: 1.1 });

const TURN_RATE = 2.6;
const LOOK_SENS = 0.0022;
const PITCH_MIN = -1.2;
const PITCH_MAX = 0.6;
const BEACON = BEACON_LAYOUT.beacon;

let heading = 0;
let freeYaw = 0;
let freePitch = -0.25;

const axes = new Float32Array(4);
const buttons = new Float32Array(2);
const look = new Float32Array(2);
let prevSpace = false;
let prevShift = false;

let stepping = false;
let loggedEnd = false;

const nearBeacon = (): boolean => {
  const p = q.playerController.position;
  return Math.hypot(p[0] - BEACON[0], p[2] - BEACON[1]) <= BEACON_LAYOUT.beaconRange;
};

function fixedStep(dt: number): void {
  if (stepping) return;
  ops.op_input_axes(axes);
  ops.op_input_buttons(buttons);
  heading = applyTurn(heading, axes[0], TURN_RATE, dt);

  const dialogueOpen = q.dialogue.isActive();
  const space = buttons[0] === 1;
  const shift = buttons[1] === 1;
  const spaceEdge = space && !prevSpace;
  const shiftEdge = shift && !prevShift;
  prevSpace = space;
  prevShift = shift;

  // In dialogue: Space = accept (choice 0), Shift = decline (choice 1). Else: Space (edge) near
  // the beacon = LIGHT it, otherwise jump; Shift = run.
  let choose = -1;
  if (dialogueOpen) {
    if (spaceEdge) choose = 0;
    else if (shiftEdge) choose = 1;
  }
  const wantLight = !dialogueOpen && spaceEdge && nearBeacon();
  const input: BeaconInput = {
    forward: axes[2],
    yaw: heading + freeYaw,
    run: !dialogueOpen && shift,
    jump: !dialogueOpen && spaceEdge && !wantLight,
    choose,
    light: wantLight,
  };

  stepping = true;
  void q.step(dt, input).then(() => {
    if (!loggedEnd) {
      const s = q.state();
      if (s === "won") { loggedEnd = true; ops.op_log("you win — the Eastern Beacon is lit and the warden's charge is kept! game state: won."); }
      else if (s === "lost") { loggedEnd = true; ops.op_log("you lose — the Blight took you. game state: lost."); }
    }
  }).catch((e) => {
    ops.op_log("beacon step error: " + (e instanceof Error ? e.message : String(e)));
  }).finally(() => { stepping = false; });
}

function render(_alpha: number): void {
  ops.op_input_look(look);
  freeYaw += look[0] * LOOK_SENS;
  freePitch -= look[1] * LOOK_SENS;
  if (freePitch < PITCH_MIN) freePitch = PITCH_MIN;
  if (freePitch > PITCH_MAX) freePitch = PITCH_MAX;

  const p = q.playerController.position;
  const moving = Math.abs(axes[2]) > 0.01 && !q.dialogue.isActive();
  playerModel.setPose([p[0], p[1] - q.playerController.groundOffset, p[2]], q.playerController.facing);
  playerModel.setLocomotion(moving ? (buttons[1] === 1 ? "run" : "walk") : "idle", 1 / 60);

  const np = q.npcPos();
  npcModel.setPose([np[0], np[1], np[2]], q.npcFacing());
  npcModel.setLocomotion("idle", 1 / 60);

  camera.yaw = heading + freeYaw;
  camera.pitch = freePitch;
  camera.update(engine.camera, p);

  core.ui.update(engine.camera, engine.width, engine.height, 1000 / 60);
  hud.update(q.playerEntity);

  renderSyncSystem(engine.world);
  playerModel.syncSkinning();
  npcModel.syncSkinning();
  engine.renderer.render(engine.scene, engine.camera);
  ops.op_surface_present(engine.context);
}

function onResize(w: number, h: number): void {
  ops.op_surface_resize(w, h);
  engine.renderer.setSize(w, h, false);
  engine.camera.aspect = w / h;
  engine.camera.updateProjectionMatrix();
}

render(0);

ops.op_set_fixed_step_callback(fixedStep);
ops.op_set_frame_callback(render);
ops.op_set_resize_callback(onResize);

ops.op_log(
  "beacon quest ready: LIGHT THE EASTERN BEACON — walk to the warden (brass marker) to take the charge, " +
  "head east to the beacon on the headland and press Space in range to light it (avoid the Blight — it drains HP), " +
  "then return to the warden to WIN. CLICK to capture the mouse; W/S move, A/D turn, mouse to look, Shift to run. " +
  "In dialogue: Space accepts, Shift declines. HUD shows HP + the beacon objective.",
);
