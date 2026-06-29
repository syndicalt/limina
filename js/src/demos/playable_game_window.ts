// Phase 12 CAPSTONE — a human-PLAYABLE tiny complete game, authored through skills.
//
// Run: ./target/release/limina --window js/src/demos/playable_game_window.ts
//   (frame-capped: ./target/release/limina --window --frames 5 js/src/demos/playable_game_window.ts)
//
// The SAME tiny game the headless capstone (js/test/p12_capstone.ts) proves, but driven by
// a human: walk the character to the glowing orb to collect it and WIN. Every part of the
// game is authored with the Phase-12 game skills — nothing is hand-modeled:
//   • world.generateRegion  — the ground colliders + the visible procedural-PBR surface;
//   • world.populateBiome    — biome-correct grass/props;
//   • scene.createEntity      — the orb (a gold sphere), made interactable with interaction.register;
//   • inventory.create         — the player's pack;
//   • game.condition           — the WIN rule: counter('orbs') >= 1 → game.win.
// The live character reuses the playable_world_window CharacterController + third-person camera
// pattern. When the player reaches the orb, the win sequence runs through skills
// (interaction.pickup → game.counter → game.condition → game.win) and logs "you win".
//
// SIM / RENDER SPLIT (replay invariant): movement comes ENTIRELY from input at the FIXED step —
// W/S move along a SIM-owned heading, A/D turn it. The mouse only orbits the camera (render-side).
//
// CONTROLS: click the window to capture the mouse (Escape releases).
//   W/S — move forward / back     A/D — turn     mouse — look (camera only)
//   Shift — run                   Space — jump

import * as THREE from "../../build/three.bundle.mjs";
import { createEngine, ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { LiminaTracer } from "../observability/event.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { applyTurn } from "../world/heading.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { TILE_SIZE } from "../terrain/procedural.ts";
import { terrainTypeHints } from "../terrain/terrain-types.ts";
import { CharacterController } from "../world/character.ts";
import { ThirdPersonCamera } from "../world/third_person_camera.ts";
import { attachCharacterModel } from "../world/character_model.ts";

const SEED = 4242;
const TYPE = "plains" as const;
const BOUNDS = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 }; // a small 2x2-tile region (~96m)
const HINTS = terrainTypeHints(TYPE, BOUNDS);

// The engine + skill registry. The render baseline (sun + IBL + atmosphere + tonemapping) is
// applied automatically; we suppress the flat ground plane because the generated terrain IS
// the ground.
const engine = await createEngine({ width: 1280, height: 720, renderBaseline: { ground: { enabled: false } } });

const tracer = new LiminaTracer("ses_playable_game");
const registry = new SkillRegistry(tracer);
const core = registerCoreSkills(registry);

const world: WorldContext = {
  ecs: engine.world, entities: engine.entities, tags: engine.tags,
  transforms: engine.transforms, spatial: engine.spatial, scene: engine.scene,
  camera: engine.camera, renderer: engine.renderer, ops: engine.ops,
  width: engine.width, height: engine.height, mode: engine.mode,
};
const base = { agentId: "agt_playable_game", sessionId: "ses_playable_game", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

ops.op_physics_create_world(-9.81);

// ── AUTHOR THE GAME (skills) ──────────────────────────────────────────────────
// 1. GROUND + SURFACE: colliders AND the visible procedural-PBR terrain mesh in one call.
const gen = await registry.invoke("world.generateRegion", {
  seed: SEED, bounds: BOUNDS, lod: 0, type: TYPE,
  surface: { mode: "pbr" },
}, base);
if (!gen.success) throw new Error("world.generateRegion failed: " + JSON.stringify(gen.error));
const { regionId } = gen.result as { regionId: string };

// 2. CONTENT: biome-correct scatter (grass/props) — one deterministic call.
await registry.invoke("world.populateBiome", { regionId, type: TYPE }, base);

// Region center (spawn) and the orb 8m "forward" (world -Z).
const CENTER_X = ((BOUNDS.minTx + BOUNDS.maxTx + 1) / 2) * TILE_SIZE;
const CENTER_Z = ((BOUNDS.minTz + BOUNDS.maxTz + 1) / 2) * TILE_SIZE;
const ORB_X = CENTER_X;
const ORB_Z = CENTER_Z - 8;
const orbSurfaceY = core.terrain.source.sampleHeight(SEED, ORB_X, ORB_Z, 0, HINTS);
const ORB_Y = orbSurfaceY + 0.8;

// 3. THE ORB: a gold sphere made interactable + the player's pack.
const orb = (await registry.invoke("scene.createEntity", {
  shape: "sphere", size: 0.7, color: 0xffd000, position: [ORB_X, ORB_Y, ORB_Z],
}, base)).result as { entity: string };
const orbEntity = orb.entity;
await registry.invoke("interaction.register", { entity: orbEntity, prompt: "Collect the orb", maxRange: 3, type: "pickup" }, base);
await registry.invoke("inventory.create", { entity: "player", capacity: 8 }, base);

// 4. THE WIN RULE: collecting the orb trips a counter; the condition declares victory.
await registry.invoke("game.condition", { name: "collected", expression: "counter('orbs') >= 1", onTrue: "game.objectiveComplete" }, base);

// ── THE LIVE CHARACTER (playable_world_window pattern) ─────────────────────────
const surfaceY = core.terrain.source.sampleHeight(SEED, CENTER_X, CENTER_Z, 0, HINTS);
const controller = new CharacterController(ops, [CENTER_X, surfaceY + 0.9, CENTER_Z], { halfHeight: 0.5, radius: 0.35 });
ops.op_physics_step(); // build the broad-phase BVH so the first move_character resolves the ground

// VISIBLE CHARACTER — a rigged, animated glTF (robot.glb) replaces the old capsule.
// Physics body unchanged; RENDER-ONLY (mesh + AnimationMixer), foot-placed each frame.
const model = await attachCharacterModel({
  world, registry, base, animationManager: core.animation.animationManager,
  position: [CENTER_X, controller.position[1] - controller.groundOffset, CENTER_Z],
});
{
  const info = await registry.invoke("animation.getClipInfo", { entity: model.entity }, base);
  ops.op_log(
    `character model: entity ${model.entity}, scale ${model.scale.toFixed(3)}, footY ${model.footY.toFixed(3)}, ` +
    `clips ${JSON.stringify((info.result as { clips: unknown[] }).clips)}`,
  );
}

engine.camera.near = 0.3;
engine.camera.far = 1000;
engine.camera.updateProjectionMatrix();
const camera = new ThirdPersonCamera({ distance: 7, lookHeight: 1.1 });

const TURN_RATE = 2.6;     // rad/s the heading turns under A/D (sim-owned)
const LOOK_SENS = 0.0022;  // free-look sensitivity (camera only)
const PITCH_MIN = -1.2;
const PITCH_MAX = 0.6;
const WIN_RANGE = 2.2;     // collect the orb when the character is within this distance

let heading = 0;
let freeYaw = 0;
let freePitch = -0.25;

const axes = new Float32Array(3);
const buttons = new Float32Array(2);
const look = new Float32Array(2);
let prevJump = false;
let simTick = 0;
let dbgFrame = 0;

// Win bookkeeping: claim once, run the skill-driven win sequence, log "you win".
let claiming = false;
let won = false;

function tryCollect(px: number, pz: number): void {
  if (won || claiming) return;
  const dx = px - ORB_X;
  const dz = pz - ORB_Z;
  if (Math.sqrt(dx * dx + dz * dz) > WIN_RANGE) return;
  claiming = true;
  // The win flow, authored as skills (mirrors the headless capstone): pickup → counter →
  // condition → game.win. Run async off the fixed step (the calls resolve promptly).
  void (async () => {
    const at = { ...base, tick: simTick };
    const pk = await registry.invoke("interaction.pickup", { itemEntity: orbEntity, actorEntity: "player" }, at);
    if (!pk.success || !(pk.result as { ok: boolean }).ok) { claiming = false; return; }
    await registry.invoke("game.counter", { name: "orbs", action: "increment", value: 1 }, at);
    const cond = await registry.invoke("game.condition", { name: "collected", action: "evaluate" }, at);
    if (cond.success && (cond.result as { value: boolean }).value) {
      await registry.invoke("game.win", {}, at);
      if (orbMesh !== undefined) engine.scene.remove(orbMesh); // hide the collected orb
      won = true;
      ops.op_log("you win — orb collected! game state: won.");
    } else {
      claiming = false;
    }
  })();
}

// The orb's visible mesh (so we can hide it on collect). Resolve it from the entity table.
const orbMesh = engine.entities.resolve(orbEntity)?.mesh as THREE.Object3D | undefined;

function fixedStep(dt: number): void {
  simTick++;
  ops.op_input_axes(axes);       // [0]=A/D, [1]=Q/E (unused), [2]=S/W
  ops.op_input_buttons(buttons); // [0]=jump/Space, [1]=run/Shift
  heading = applyTurn(heading, axes[0], TURN_RATE, dt);
  const jumpHeld = buttons[0] === 1;
  const jump = jumpHeld && !prevJump;
  prevJump = jumpHeld;
  controller.step({ forward: axes[2], strafe: 0, yaw: heading, run: buttons[1] === 1, jump }, dt);
  ops.op_physics_step();
  const p = controller.position;
  tryCollect(p[0], p[2]);
}

function render(_alpha: number): void {
  ops.op_input_look(look);
  freeYaw += look[0] * LOOK_SENS;
  freePitch -= look[1] * LOOK_SENS;
  if (freePitch < PITCH_MIN) freePitch = PITCH_MIN;
  if (freePitch > PITCH_MAX) freePitch = PITCH_MAX;
  const p = controller.position;
  // Foot-place the rigged model (controller.position is the capsule CENTER) + drive gait.
  const moving = Math.abs(axes[2]) > 0.01;
  model.setPose([p[0], p[1] - controller.groundOffset, p[2]], controller.facing);
  model.setLocomotion(moving ? (buttons[1] === 1 ? "run" : "walk") : "idle", 1 / 60);
  if (dbgFrame === 25) {
    void registry.invoke("animation.getClipInfo", { entity: model.entity }, base).then((r) =>
      ops.op_log(`character model @frame25: clipInfo ${JSON.stringify((r.result as { clips: unknown[] }).clips)}`));
  }
  dbgFrame++;
  camera.yaw = heading + freeYaw;
  camera.pitch = freePitch;
  camera.update(engine.camera, p);
  renderSyncSystem(engine.world);
  model.syncSkinning(); // refresh rig bone matrices after the transform (else arms detach)
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
  `playable game ready: OBJECTIVE — collect the orb to win. A tiny complete game authored with ` +
  `the Phase-12 skills (generateRegion + populateBiome + scene.createEntity orb + interaction.register + ` +
  `inventory.create + game.condition win rule). CLICK to capture the mouse, W/S move, A/D turn, ` +
  `mouse to look, Shift to run, Space to jump, Escape to release. Walk to the gold orb to win.`,
);
