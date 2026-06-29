// Phase 14 CAPSTONE — the human-playable build of "The Relic Hunt". Boots the SAME shared,
// deterministic builder/sim as the headless gate (js/test/p14_capstone.ts → js/src/demos/
// capstone_game.ts), then layers RENDER-ONLY presentation on top: a third-person camera, rigged
// player + NPC models, the dialogue speech bubble, and the HUD (HP + quest progress). The
// fixedStep samples the keyboard into the Capstone's typed input and calls capstone.step; ALL
// game state lives in the deterministic sim — this file only draws it.
//
// Run: ./target/release/limina --window js/src/demos/capstone_window.ts
//   (frame-capped: ./target/release/limina --window --frames 40 js/src/demos/capstone_window.ts)
//
// THE GAME: a generated island, a quest-giver near spawn, 3 relics, and scorched-ground hazard.
// Walk to the keeper → a dialogue opens → accept → gather all 3 relics (avoid the scorched
// ground, it drains your HP) → return to the keeper to WIN.
//
// CONTROLS: click the window to capture the mouse (Escape releases).
//   W/S — move forward / back     A/D — turn     mouse — look (camera only)
//   Shift — run                   Space — jump
//   In dialogue: Space — accept (choice 1)   Shift — decline (choice 2)

import { createEngine, ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { LiminaTracer } from "../observability/event.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { ThirdPersonCamera } from "../world/third_person_camera.ts";
import { attachCharacterModel } from "../world/character_model.ts";
import { applyTurn } from "../world/heading.ts";
import { GameHud } from "../world/game_hud.ts";
import { buildCapstone, type CapstoneInput } from "./capstone_game.ts";

// ── Engine + skill surface. The render baseline (sun/IBL/sky/tonemap) is automatic; the flat
//    ground plane is suppressed because the generated terrain IS the ground. ──────────────────
const engine = await createEngine({ width: 1280, height: 720, renderBaseline: { ground: { enabled: false } } });

const registry = new SkillRegistry(new LiminaTracer("ses_capstone"));
const core = registerCoreSkills(registry);
const world: WorldContext = {
  ecs: engine.world, entities: engine.entities, tags: engine.tags,
  transforms: engine.transforms, spatial: engine.spatial, scene: engine.scene,
  camera: engine.camera, renderer: engine.renderer, ops: engine.ops,
  width: engine.width, height: engine.height, mode: engine.mode,
};
const base = { agentId: "agt_capstone", sessionId: "ses_capstone", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

ops.op_physics_create_world(-9.81);

// ── AUTHOR THE GAME (shared builder — terrain, navmesh, player, NPC, relics, quest, dialogue,
//    hazard, win/lose). Identical to the headless gate. ───────────────────────────────────────
const capstone = await buildCapstone({ world, registry, core, base });

// ── RENDER-ONLY: rigged character models (the sim drives positions; these just follow). ───────
const pPos = capstone.playerController.position;
const playerModel = await attachCharacterModel({
  world, registry, base, animationManager: core.animation.animationManager,
  position: [pPos[0], pPos[1] - capstone.playerController.groundOffset, pPos[2]],
});
const nPos = capstone.npcPos();
const npcModel = await attachCharacterModel({
  world, registry, base, animationManager: core.animation.animationManager,
  position: [nPos[0], nPos[1], nPos[2]],
  // The keeper: a brassy tint + a touch shorter so the quest-giver doesn't render as a
  // clone of the player. (A dedicated keeper.glb is the eventual full fix.)
  tintColor: 0xC8A24B, targetHeight: 1.7,
});

// ── HUD: HP (vitals) + quest progress, reading the live managers. ─────────────────────────────
const hud = new GameHud({
  uiManager: core.ui, world,
  managers: {
    stats: core.combat.statsManager,
    quest: core.quest.questManager,
    inventory: core.inventory.inventoryManager,
    gamestate: core.gamestate.gameStateManager,
  },
  options: { hpStat: "hp", counters: ["relics"], vitalsTitle: "VITALS", questTitle: "QUEST", turnInHint: "Return to the keeper" },
});
hud.init();
hud.setQuest(capstone.questId);

engine.camera.near = 0.3;
engine.camera.far = 1000;
engine.camera.updateProjectionMatrix();
const camera = new ThirdPersonCamera({ distance: 7, lookHeight: 1.1 });

// ── Input → sim plumbing. The heading is SIM-owned (A/D turn it); the mouse only orbits the
//    camera (render-side), preserving the replay invariant. ──────────────────────────────────
const TURN_RATE = 2.6;
const LOOK_SENS = 0.0022;
const PITCH_MIN = -1.2;
const PITCH_MAX = 0.6;

let heading = 0;
let freeYaw = 0;
let freePitch = -0.25;

const axes = new Float32Array(4);
const buttons = new Float32Array(2);
const look = new Float32Array(2);
let prevSpace = false;
let prevShift = false;

let stepping = false;     // re-entrancy guard for the async sim step
let loggedEnd = false;    // log "you win"/"you lose" exactly once

function fixedStep(dt: number): void {
  if (stepping) return; // skip a tick rather than overlap an in-flight async step
  ops.op_input_axes(axes);       // [0]=A/D, [2]=S/W
  ops.op_input_buttons(buttons); // [0]=Space, [1]=Shift
  heading = applyTurn(heading, axes[0], TURN_RATE, dt);

  const dialogueOpen = capstone.dialogue.isActive();
  const space = buttons[0] === 1;
  const shift = buttons[1] === 1;
  const spaceEdge = space && !prevSpace;
  const shiftEdge = shift && !prevShift;
  prevSpace = space;
  prevShift = shift;

  // In dialogue: Space = accept (choice 0), Shift = decline (choice 1). Else: Shift = run,
  // Space (edge) = jump.
  let choose = -1;
  if (dialogueOpen) {
    if (spaceEdge) choose = 0;
    else if (shiftEdge) choose = 1;
  }
  const input: CapstoneInput = {
    forward: axes[2],
    // Sim-owned heading (A/D) PLUS the mouse look-yaw, so the mouse steers the player —
    // not just the camera. Replay-safe: yaw is a recorded player.move input, so replay
    // re-applies the recorded value (never the raw mouse delta).
    yaw: heading + freeYaw,
    run: !dialogueOpen && shift,
    jump: !dialogueOpen && spaceEdge,
    choose,
  };

  stepping = true;
  void capstone.step(dt, input).then(() => {
    if (!loggedEnd) {
      const s = capstone.state();
      if (s === "won") { loggedEnd = true; ops.op_log("you win — all 3 relics returned to the keeper! game state: won."); }
      else if (s === "lost") { loggedEnd = true; ops.op_log("you lose — the scorched ground burned you down. game state: lost."); }
    }
  }).catch((e) => {
    ops.op_log("capstone step error: " + (e instanceof Error ? e.message : String(e)));
  }).finally(() => { stepping = false; });
}

function render(_alpha: number): void {
  ops.op_input_look(look);
  freeYaw += look[0] * LOOK_SENS;
  freePitch -= look[1] * LOOK_SENS;
  if (freePitch < PITCH_MIN) freePitch = PITCH_MIN;
  if (freePitch > PITCH_MAX) freePitch = PITCH_MAX;

  // Foot-place the rigged player (controller.position is the capsule CENTER) + drive its gait.
  const p = capstone.playerController.position;
  const moving = Math.abs(axes[2]) > 0.01 && !capstone.dialogue.isActive();
  playerModel.setPose([p[0], p[1] - capstone.playerController.groundOffset, p[2]], capstone.playerController.facing);
  playerModel.setLocomotion(moving ? (buttons[1] === 1 ? "run" : "walk") : "idle", 1 / 60);

  // The NPC sim position is already at ground level; pose + idle (it stands and greets).
  const np = capstone.npcPos();
  npcModel.setPose([np[0], np[1], np[2]], capstone.npcFacing());
  npcModel.setLocomotion("idle", 1 / 60);

  camera.yaw = heading + freeYaw;
  camera.pitch = freePitch;
  camera.update(engine.camera, p);

  // Tick the UI anchors + lifecycles (HUD screen anchors + dialogue bubble billboard), then
  // patch the HUD content from the live managers.
  core.ui.update(engine.camera, engine.width, engine.height, 1000 / 60);
  hud.update(capstone.playerEntity);

  renderSyncSystem(engine.world);
  playerModel.syncSkinning(); // refresh rig bone matrices AFTER the transform sync (else arms detach)
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

// Warm-up render before registering callbacks (compile WebGPU pipelines while uncontended).
render(0);

ops.op_set_fixed_step_callback(fixedStep);
ops.op_set_frame_callback(render);
ops.op_set_resize_callback(onResize);

ops.op_log(
  "capstone ready: THE RELIC HUNT — walk to the keeper (blue marker) to accept the quest, " +
  "gather all 3 gold relics (avoid the scorched ground — it drains HP), then return to the keeper to WIN. " +
  "CLICK to capture the mouse; W/S move, A/D turn, mouse to look, Shift to run, Space to jump. " +
  "In dialogue: Space accepts, Shift declines. HUD shows HP + quest progress.",
);
