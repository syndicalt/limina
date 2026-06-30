// Phase 12 UAT — a PLAYABLE limina world.
//
// Run: ./target/release/limina --window js/src/demos/playable_world_window.ts
//   (frame-capped: ./target/release/limina --window --frames 1800 js/src/demos/playable_world_window.ts)
//
// Generate a beach region (the deterministic generator + its biome content — palms,
// grass), spawn an input-driven CHARACTER on the Rapier terrain, and walk it around
// in third-person. Nothing is hand-modeled: the surface is world.generateRegion, the
// content is scatterBiomeContent, the character walks the SAME heightfield colliders.
//
// SIM / RENDER SPLIT (replay invariant): the character's movement comes ENTIRELY
// from input sampled at the FIXED step — W/S drive forward/back along a SIM-owned
// heading, A/D turn that heading. The sim NEVER reads render state, so the recorded
// move_character stream is frame-rate-independent and replay-faithful. The mouse
// only orbits the third-person camera for VIEWING (render-side); it does not steer
// the character.
//
// CONTROLS: click the window to capture the mouse (Escape releases).
//   W/S   — move forward / back        A/D — turn
//   mouse — look around (camera only)
//   Shift — run                        Space — jump

import { ops } from "../engine.ts";
import { createWindowedContext } from "../game/index.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { applyTurn } from "../world/heading.ts";
import { TILE_SIZE } from "../terrain/procedural.ts";
import { terrainTypeHints } from "../terrain/terrain-types.ts";
import { MATERIALS } from "../materials/palette.ts";
import { CharacterController } from "../world/character.ts";
import { ThirdPersonCamera } from "../world/third_person_camera.ts";
import { attachCharacterModel } from "../world/character_model.ts";

const SEED = 1234;
const TYPE = "beach" as const;
const BOUNDS = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 }; // a 2x2-tile region (~96m square)

const ctx = await createWindowedContext({ width: 1280, height: 720, renderBaseline: { ground: { enabled: false } }, session: "ses_playable", agentId: "agt_playable" });
const engine = ctx.engine!;
const registry = ctx.registry;
const core = ctx.core;
const world = ctx.world;
const base = ctx.base;

ops.op_physics_create_world(-9.81);

// Terrain: generate the heightfield colliders AND the visible procedural-PBR surface in ONE
// skill call (render defaults ON — the auto-surface mesh vertices coincide with the collider the
// character walks). seaFraction is kept LOW (0.05) so the sea sits near the lowest point and the
// region center where the character spawns stays well above water (walkable).
const hints = terrainTypeHints(TYPE, BOUNDS);
const gen = await registry.invoke("world.generateRegion", {
  seed: SEED, bounds: BOUNDS, lod: 0, type: TYPE,
  surface: { mode: "pbr", seaFraction: 0.05, waterline: { wetBand: 1.2, foam: 0.4 } },
}, base);
const { regionId, seaLevel, relief } = gen.result as { regionId: string; seaLevel: number; relief: { minY: number; maxY: number } };

// The sea — a depth-aware water plane at the resolved sea level.
const span = (BOUNDS.maxTx - BOUNDS.minTx + 1) * TILE_SIZE;
await registry.invoke("world.addWater", {
  level: seaLevel, color: MATERIALS.water.color, size: span * 3,
  region: { seed: SEED, type: TYPE, bounds: BOUNDS, hints },
}, base);

// Populate the beach with its biome content (palms, grass) — first-class skill, same placements.
await registry.invoke("world.populateBiome", { regionId, type: TYPE, waterLevel: seaLevel, waterMargin: 1.5 }, base);

// Character: spawn at the region center, resting on the generated surface.
const spawnX = ((BOUNDS.minTx + BOUNDS.maxTx + 1) / 2) * TILE_SIZE;
const spawnZ = ((BOUNDS.minTz + BOUNDS.maxTz + 1) / 2) * TILE_SIZE;
const surfaceY = core.terrain.source.sampleHeight(SEED, spawnX, spawnZ, 0, hints);
const controller = new CharacterController(ops, [spawnX, surfaceY + 0.9, spawnZ], { halfHeight: 0.5, radius: 0.35 });
ops.op_physics_step(); // build the broad-phase BVH so the first move_character resolves the ground

// VISIBLE CHARACTER — a rigged, animated glTF (robot.glb) replaces the old capsule. The
// physics body above is unchanged; this is RENDER-ONLY (mesh + AnimationMixer). The model
// is foot-placed each frame from the controller and crossfades idle/walk/run from input.
const model = await attachCharacterModel({
  world, registry, base, animationManager: core.animation.animationManager,
  position: [spawnX, controller.position[1] - controller.groundOffset, spawnZ],
});
{
  const info = await registry.invoke("animation.getClipInfo", { entity: model.entity }, base);
  ops.op_log(
    `character model: entity ${model.entity}, scale ${model.scale.toFixed(3)}, footY ${model.footY.toFixed(3)}, ` +
    `clips ${JSON.stringify((info.result as { clips: unknown[] }).clips)}`,
  );
}

// Third-person follow camera (sits behind the character heading; mouse adds a
// free-look offset for VIEWING only — it never feeds back into the sim).
engine.camera.near = 0.3;
engine.camera.far = 1000;
engine.camera.updateProjectionMatrix();
const camera = new ThirdPersonCamera({ distance: 7, lookHeight: 1.1 });

const TURN_RATE = 2.6;        // rad/s the heading turns under A/D (sim-owned)
const LOOK_SENS = 0.0022;     // free-look sensitivity (camera only)
const PITCH_MIN = -1.2;
const PITCH_MAX = 0.6;

// SIM-owned movement heading (radians). Turned by A/D at the FIXED step.
let heading = 0;
// Render-only free-look offsets layered onto the follow camera.
let freeYaw = 0;
let freePitch = -0.25;

const axes = new Float32Array(3);
const buttons = new Float32Array(2);
const look = new Float32Array(2);
let prevJump = false;
let dbgFrame = 0;

function fixedStep(dt: number): void {
  ops.op_input_axes(axes);       // [0]=A/D, [1]=Q/E (unused), [2]=S/W
  ops.op_input_buttons(buttons); // [0]=jump/Space, [1]=run/Shift
  // A/D turn the sim-owned heading; W/S move along it. (No render state read.)
  heading = applyTurn(heading, axes[0], TURN_RATE, dt);
  const jumpHeld = buttons[0] === 1;
  const jump = jumpHeld && !prevJump; // rising edge
  prevJump = jumpHeld;
  controller.step(
    { forward: axes[2], strafe: 0, yaw: heading, run: buttons[1] === 1, jump },
    dt,
  );
  ops.op_physics_step();
}

function render(_alpha: number): void {
  ops.op_input_look(look);
  freeYaw += look[0] * LOOK_SENS;
  freePitch -= look[1] * LOOK_SENS;
  if (freePitch < PITCH_MIN) freePitch = PITCH_MIN;
  if (freePitch > PITCH_MAX) freePitch = PITCH_MAX;
  const p = controller.position;
  // Foot-place the model (controller.position is the capsule CENTER) + drive its gait
  // from the latest sampled input (forward axis -> walk, run button -> run).
  const moving = Math.abs(axes[2]) > 0.01;
  model.setPose([p[0], p[1] - controller.groundOffset, p[2]], controller.facing);
  model.setLocomotion(moving ? (buttons[1] === 1 ? "run" : "walk") : "idle", 1 / 60);
  if (dbgFrame === 25) {
    void registry.invoke("animation.getClipInfo", { entity: model.entity }, base).then((r) =>
      ops.op_log(`character model @frame25: clipInfo ${JSON.stringify((r.result as { clips: unknown[] }).clips)}`));
  }
  dbgFrame++;
  // Follow camera = behind the sim heading + the mouse free-look offset.
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

// Warm-up render before registering callbacks (compile WebGPU pipelines while the
// loop is uncontended; otherwise the surface can stay blank — see player.ts).
render(0);

ops.op_set_fixed_step_callback(fixedStep);
ops.op_set_frame_callback(render);
ops.op_set_resize_callback(onResize);
ops.op_log(
  `playable world ready: beach region (seed ${SEED}) — auto-surface PBR + addWater + populateBiome; ` +
  `walk the character on the Rapier terrain. CLICK to capture the mouse, ` +
  `W/S move, A/D turn, mouse to look, Shift to run, Space to jump, Escape to release.`,
);
