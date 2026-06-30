// REMNANTS OF AETHON — THE EASTERN WATCH (Phase 0+1): the human-playable build. Boots the shared,
// deterministic builder/sim (js/src/demos/aethon_game.ts → buildAethon) in the Aethon outpost
// environment, then layers RENDER-ONLY presentation on top: a third-person camera, rigged player +
// Torvald models, the dialogue speech bubble, and the HUD (HP + quest objective). Modeled on
// capstone_window.ts; the Blight haze (atmosphere) from aethon_outpost carries over.
//
// Run: ./target/release/limina --window js/src/demos/aethon_window.ts
//
// THE SCAFFOLD: spawn at the CAMP (west) → walk to Torvald at the campfire → a dialogue opens →
// accept his charge → walk the EASTERN perimeter (out past the toppled marker into the Blight) →
// return to Torvald to report. (Combat/enemies are later phases.)
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
import { buildAethon, headingToward, AETHON_LAYOUT, type AethonInput } from "./aethon_game.ts";

// ── Engine + skill surface. The flat ground plane is suppressed (the generated terrain IS the
//    ground); the moody Blight haze (atmosphere) is carried over from aethon_outpost. ─────────────
const engine = await createEngine({
  width: 1280, height: 720,
  renderBaseline: { ground: { enabled: false }, atmosphere: { density: 0.0006 } },
});

const registry = new SkillRegistry(new LiminaTracer("ses_aethon"));
const core = registerCoreSkills(registry);
const world: WorldContext = {
  ecs: engine.world, entities: engine.entities, tags: engine.tags,
  transforms: engine.transforms, spatial: engine.spatial, scene: engine.scene,
  camera: engine.camera, renderer: engine.renderer, ops: engine.ops,
  width: engine.width, height: engine.height, mode: engine.mode,
};
const base = { agentId: "agt_aethon", sessionId: "ses_aethon", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

ops.op_physics_create_world(-9.81);

// ── AUTHOR THE SCAFFOLD (shared builder — terrain, outpost assets, navmesh, player, Torvald,
//    quest, dialogue). ────────────────────────────────────────────────────────────────────────
const game = await buildAethon({ world, registry, core, base });

// ── RENDER-ONLY: rigged character models (the sim drives positions; these just follow). ─────────
const pPos = game.playerController.position;
const playerModel = await attachCharacterModel({
  world, registry, base, animationManager: core.animation.animationManager,
  position: [pPos[0], pPos[1] - game.playerController.groundOffset, pPos[2]],
});
const nPos = game.npcPos();
const npcModel = await attachCharacterModel({
  world, registry, base, animationManager: core.animation.animationManager,
  position: [nPos[0], nPos[1], nPos[2]],
  // Torvald: a darker, weathered tint + a touch stockier/taller so the veteran doesn't render as
  // a clone of the player. (A dedicated Torvald.glb is the eventual full fix.)
  tintColor: 0x5a4634, targetHeight: 1.82,
});

// ── HUD: HP (vitals) + quest objective, reading the live managers. ──────────────────────────────
const hud = new GameHud({
  uiManager: core.ui, world,
  managers: {
    stats: core.combat.statsManager,
    quest: core.quest.questManager,
    inventory: core.inventory.inventoryManager,
    gamestate: core.gamestate.gameStateManager,
  },
  options: { hpStat: "hp", counters: ["perimeter"], vitalsTitle: "VITALS", questTitle: "THE EASTERN WATCH", turnInHint: "Report back to Torvald" },
});
hud.init();
hud.setQuest(game.questId);

engine.camera.near = 0.3;
engine.camera.far = 1000;
engine.camera.updateProjectionMatrix();
const camera = new ThirdPersonCamera({ distance: 7, lookHeight: 1.1 });

// ── Input → sim plumbing. The heading is SIM-owned (A/D turn it); the mouse only orbits the
//    camera (render-side), preserving the replay invariant. ──────────────────────────────────────
const TURN_RATE = 2.6;
const LOOK_SENS = 0.0022;
const PITCH_MIN = -1.2;
const PITCH_MAX = 0.6;

// Start facing Torvald at the campfire so the player opens looking into the camp.
let heading = headingToward(AETHON_LAYOUT.spawn[0], AETHON_LAYOUT.spawn[1], AETHON_LAYOUT.torvald[0], AETHON_LAYOUT.torvald[1]);
let freeYaw = 0;
let freePitch = -0.25;

const axes = new Float32Array(4);
const buttons = new Float32Array(2);
const look = new Float32Array(2);
let prevSpace = false;
let prevShift = false;

let stepping = false;     // re-entrancy guard for the async sim step
let loggedEnd = false;    // log win/lose exactly once

function fixedStep(dt: number): void {
  if (stepping) return; // skip a tick rather than overlap an in-flight async step
  ops.op_input_axes(axes);       // [0]=A/D, [2]=S/W
  ops.op_input_buttons(buttons); // [0]=Space, [1]=Shift
  heading = applyTurn(heading, axes[0], TURN_RATE, dt);

  const dialogueOpen = game.dialogue.isActive();
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
  const input: AethonInput = {
    forward: axes[2],
    yaw: heading + freeYaw,
    run: !dialogueOpen && shift,
    jump: !dialogueOpen && spaceEdge,
    choose,
  };

  stepping = true;
  void game.step(dt, input).then(() => {
    if (!loggedEnd && game.state() === "won") {
      loggedEnd = true;
      ops.op_log("the watch is kept — you walked the eastern perimeter and reported back to Torvald. game state: won.");
    }
  }).catch((e) => {
    ops.op_log("aethon step error: " + (e instanceof Error ? e.message : String(e)));
  }).finally(() => { stepping = false; });
}

function render(_alpha: number): void {
  ops.op_input_look(look);
  freeYaw += look[0] * LOOK_SENS;
  freePitch -= look[1] * LOOK_SENS;
  if (freePitch < PITCH_MIN) freePitch = PITCH_MIN;
  if (freePitch > PITCH_MAX) freePitch = PITCH_MAX;

  // Foot-place the rigged player (controller.position is the capsule CENTER) + drive its gait.
  const p = game.playerController.position;
  const moving = Math.abs(axes[2]) > 0.01 && !game.dialogue.isActive();
  playerModel.setPose([p[0], p[1] - game.playerController.groundOffset, p[2]], game.playerController.facing);
  playerModel.setLocomotion(moving ? (buttons[1] === 1 ? "run" : "walk") : "idle", 1 / 60);

  // Torvald's sim position is already at ground level; pose + idle (he stands and greets).
  const np = game.npcPos();
  npcModel.setPose([np[0], np[1], np[2]], game.npcFacing());
  npcModel.setLocomotion("idle", 1 / 60);

  camera.yaw = heading + freeYaw;
  camera.pitch = freePitch;
  camera.update(engine.camera, p);

  core.ui.update(engine.camera, engine.width, engine.height, 1000 / 60);
  hud.update(game.playerEntity);

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
  "Remnants of Aethon — THE EASTERN WATCH ready: spawn at the camp (west), walk to Torvald at the " +
  "campfire to accept his charge, then walk the EASTERN perimeter (past the toppled marker into the " +
  "Blight) and return to report. CLICK to capture the mouse; W/S move, A/D turn, mouse to look, " +
  "Shift to run, Space to jump. In dialogue: Space accepts, Shift declines. HUD shows HP + quest.",
);
