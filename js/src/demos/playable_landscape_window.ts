// PLAYABLE LANDSCAPE — the gorgeous eroded ISLAND, now WALKABLE in third person.
//
// Run: ./target/release/limina --window js/src/demos/playable_landscape_window.ts
//   (frame-capped: ./target/release/limina --window --frames 1800 js/src/demos/playable_landscape_window.ts)
//
// This fuses landscape_window's island (a high-relief MOUNTAINS region with hydraulic/
// thermal EROSION + a coastal island falloff, the procedural-PBR terrain surface, a
// sea-level water plane, and deterministic biome scatter) with playable_world_window's
// CHARACTER: a kinematic capsule on the SAME Rapier heightfield colliders, driven at the
// fixed step, followed by a third-person orbit camera, and presented through the full
// post stack (GTAO + bloom + grade) over the height-falloff atmosphere.
//
// SIM / RENDER SPLIT (replay invariant): the character's movement comes ENTIRELY from
// input sampled at the FIXED step — W/S drive forward/back along a SIM-owned heading,
// A/D turn that heading, Space jumps, Shift runs. The sim NEVER reads render state, so
// the recorded move_character stream is frame-rate-independent and replay-faithful. The
// mouse only orbits the third-person camera for VIEWING (render-side); it never steers
// the character.
//
// CONTROLS: click the window to capture the mouse (Escape releases).
//   W/S   — move forward / back        A/D — turn
//   mouse — orbit the camera (view only)
//   Shift — run                        Space — jump

import * as THREE from "../../build/three.bundle.mjs";
import { ops } from "../engine.ts";
import { createWindowedContext } from "../game/index.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { applyTurn } from "../world/heading.ts";
import { TILE_SIZE } from "../terrain/procedural.ts";
import { terrainTypeHints, type TerrainTypeName } from "../terrain/terrain-types.ts";
import { surveyRegionRelief } from "../terrain/biome-content.ts";
import { MATERIALS } from "../materials/palette.ts";
import { DEFAULT_RENDER_BASELINE } from "../render-baseline.ts";
import { buildPostPipeline } from "../render/post.ts";
import { CharacterController } from "../world/character.ts";
import { ThirdPersonCamera } from "../world/third_person_camera.ts";
import { attachCharacterModel } from "../world/character_model.ts";

// ── ISLAND RECIPE — identical to landscape_window so the world matches exactly. ──────
const SEED = 1234;
const TYPE: TerrainTypeName = "mountains";
const SURFACE: "pbr" | "ramp" = "pbr";
const BOUNDS = { minTx: 0, minTz: 0, maxTx: 3, maxTz: 3 } as const;
const SEA_FRACTION = 0.18;
const AMP = 4.5;
const WATER_MARGIN = 2.5;

const HALF_EXTENT = (Math.min(BOUNDS.maxTx - BOUNDS.minTx, BOUNDS.maxTz - BOUNDS.minTz) + 1) * TILE_SIZE / 2;
const ISLAND = {
  islandCx: ((BOUNDS.minTx + BOUNDS.maxTx + 1) / 2) * TILE_SIZE,
  islandCz: ((BOUNDS.minTz + BOUNDS.maxTz + 1) / 2) * TILE_SIZE,
  islandRadius: HALF_EXTENT * 0.40,
  islandFalloff: HALF_EXTENT * 0.62,
};
const SHAPE = { amp: AMP, erode: 1, ...ISLAND };
const HINTS = { ...terrainTypeHints(TYPE, BOUNDS), ...SHAPE };

const ctx = await createWindowedContext({
  width: 1280,
  height: 720,
  renderBaseline: {
    ground: { enabled: false },
    atmosphere: { height: { enabled: true, density: 0.00055 } },
  },
  session: "ses_playable_landscape",
  agentId: "agt_playable_landscape",
});
const engine = ctx.engine!;
const registry = ctx.registry;
const core = ctx.core;
const world = ctx.world;
const base = ctx.base;

ops.op_physics_create_world(-9.81);

// Survey the eroded surface (SAME hints) → relief + sea level, BEFORE generating, so the
// auto-surface builds the visible PBR mesh with the EXACT band (byte-identical, no double mesh).
const relief = surveyRegionRelief(core.terrain.source, SEED, BOUNDS, HINTS);
const seaLevel = relief.minY + SEA_FRACTION * (relief.maxY - relief.minY);

// 1. THE GROUND + SURFACE — generate the eroded mountains region (heightfield colliders the
//    character walks + region handle) AND the VISIBLE procedural-PBR surface in one skill call
//    (the AUTO-SURFACE). Each tile mesh coincides with the collider; render-only.
const gen = await registry.invoke("world.generateRegion", {
  seed: SEED, bounds: BOUNDS, lod: 0, type: TYPE, hints: SHAPE,
  surface: SURFACE === "pbr"
    ? { mode: "pbr", roughness: 0.95, seaLevel, minY: relief.minY, maxY: relief.maxY, waterline: { wetBand: 1.4, foam: 0.5 } }
    : { mode: "palette", roughness: 0.95, seaLevel, minY: relief.minY, maxY: relief.maxY },
}, base);
if (!gen.success) throw new Error("world.generateRegion failed: " + JSON.stringify(gen.error));
const regionId = (gen.result as { regionId: string }).regionId;

// ATMOSPHERE ceiling — set the height-falloff haze just under the summit (render-only).
{
  const T = (THREE as unknown as { TSL: Record<string, (...a: unknown[]) => unknown> }).TSL;
  const ceiling = seaLevel + (relief.maxY - seaLevel) * 0.85;
  const factor = T.exponentialHeightFogFactor(T.float(0.00055), T.float(ceiling));
  (engine.scene as { fogNode?: unknown }).fogNode = T.fog(T.color(DEFAULT_RENDER_BASELINE.sky.horizon), factor);
  ops.op_log(`atmosphere: height-falloff haze, ceiling ${ceiling.toFixed(1)} m (peak ${relief.maxY.toFixed(1)} m)`);
}

// 2. THE SEA — render-only water plane at sea level, region-aware depth shading.
const span = (BOUNDS.maxTx - BOUNDS.minTx + 1) * TILE_SIZE;
const waterRes = await registry.invoke("world.addWater", {
  level: seaLevel, color: MATERIALS.water.color, size: span * 3,
  region: { seed: SEED, type: TYPE, bounds: BOUNDS, hints: SHAPE },
}, base);
if (!waterRes.success) throw new Error("world.addWater failed: " + JSON.stringify(waterRes.error));

// 3. THE SURFACE is built by the AUTO-SURFACE above (world.generateRegion `surface`).

// 4. THE CONTENT — pines + boulders scattered via the deterministic world.populateBiome SKILL.
const popRes = await registry.invoke("world.populateBiome", {
  regionId, type: TYPE, waterLevel: seaLevel, waterMargin: WATER_MARGIN,
}, base);
if (!popRes.success) throw new Error("world.populateBiome failed: " + JSON.stringify(popRes.error));
const scattered = popRes.result as { instances: number };

// 5. THE CHARACTER — spawn the kinematic capsule on the eroded heightfield. Pick a DRY
//    spot up on a flank of the island core (offset from the peak so the framing shows
//    terrain in front), comfortably above the waterline. The center Y rests at the
//    surface + groundOffset; op_physics_step builds the BVH so the first move grounds it.
const HALF = 0.5;
const RADIUS = 0.35;
const GROUND_OFFSET = HALF + RADIUS;
// Offset toward -X/-Z from the island center, on a mid-flank dry shelf.
const spawnX = ISLAND.islandCx - HALF_EXTENT * 0.18;
const spawnZ = ISLAND.islandCz - HALF_EXTENT * 0.18;
const spawnSurfaceY = core.terrain.source.sampleHeight(SEED, spawnX, spawnZ, 0, HINTS);
if (spawnSurfaceY < seaLevel + 1) {
  ops.op_log(`WARN: spawn surface ${spawnSurfaceY.toFixed(1)} m below dry margin (sea ${seaLevel.toFixed(1)} m)`);
}
const controller = new CharacterController(ops, [spawnX, spawnSurfaceY + GROUND_OFFSET + 0.05, spawnZ], {
  halfHeight: HALF, radius: RADIUS,
});
ops.op_physics_step(); // build the broad-phase BVH so the first move_character grounds

// VISIBLE CHARACTER — a rigged, animated glTF (robot.glb) replaces the old capsule. The
// kinematic body above is unchanged; this is RENDER-ONLY (mesh + AnimationMixer), foot-
// placed each frame from the controller and crossfading idle/walk/run from input.
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

// 6. THIRD-PERSON camera framed to show the terrain ahead of the character.
engine.camera.near = 0.3;
engine.camera.far = span * 6;
engine.camera.updateProjectionMatrix();
const camera = new ThirdPersonCamera({ distance: 9, lookHeight: 1.2 });

const TURN_RATE = 2.6;     // rad/s the sim-owned heading turns under A/D
const LOOK_SENS = 0.0022;  // free-look sensitivity (camera only)
const PITCH_MIN = -1.2;
const PITCH_MAX = 0.6;

let heading = 0;       // SIM-owned movement heading (radians)
let freeYaw = 0;       // render-only free-look yaw offset
let freePitch = -0.25; // render-only free-look pitch

const axes = new Float32Array(3);
const buttons = new Float32Array(2);
const look = new Float32Array(2);
let prevJump = false;
let dbgFrame = 0;

function fixedStep(dt: number): void {
  ops.op_input_axes(axes);       // [0]=A/D, [1]=Q/E (unused), [2]=S/W
  ops.op_input_buttons(buttons); // [0]=jump/Space, [1]=run/Shift
  heading = applyTurn(heading, axes[0], TURN_RATE, dt); // A/D turn — shared sign
  const jumpHeld = buttons[0] === 1;
  const jump = jumpHeld && !prevJump; // rising edge
  prevJump = jumpHeld;
  controller.step(
    { forward: axes[2], strafe: 0, yaw: heading, run: buttons[1] === 1, jump },
    dt,
  );
  ops.op_physics_step();
}

// 7. PRESENTATION. By DEFAULT we use the bare known-good path
// (`renderer.render` → `op_surface_present`) so free-fly / character navigation is
// LIVE — the same path playable_world_window uses. The Phase-3 post stack (GTAO +
// bloom + grade) is gated behind USE_POST: on this WebGPU windowed backend the
// PostProcessing composite does not reliably present a fresh frame per move (the
// view can stick while the camera moves), so post is OPT-IN for static / cinematic
// shots until that is resolved. The scene LOOK (PBR terrain, atmosphere/fog, water,
// scatter) is scene/material — unaffected by this toggle. Flip to true to A/B the post stack.
const USE_POST = false;
const post = USE_POST ? buildPostPipeline(engine.renderer, engine.scene, engine.camera) : null;

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
  if (post) post.render();
  else engine.renderer.render(engine.scene, engine.camera);
  ops.op_surface_present(engine.context);
}

function onResize(w: number, h: number): void {
  ops.op_surface_resize(w, h);
  engine.renderer.setSize(w, h, false);
  post?.setSize(w, h);
  engine.camera.aspect = w / h;
  engine.camera.updateProjectionMatrix();
}

// Warm-up render before registering callbacks (compile WebGPU pipelines while the loop
// is uncontended; otherwise the surface can stay blank — see playable_world_window).
render(0);

ops.op_set_fixed_step_callback(fixedStep);
ops.op_set_frame_callback(render);
ops.op_set_resize_callback(onResize);
ops.op_log(
  `playable landscape ready: eroded ${TYPE} island ${regionId} ` +
  `(relief ${relief.minY.toFixed(1)}..${relief.maxY.toFixed(1)} m, sea ${seaLevel.toFixed(1)} m), ` +
  `${scattered.instances} biome props; character spawned at ` +
  `(${spawnX.toFixed(1)}, ${spawnSurfaceY.toFixed(1)}, ${spawnZ.toFixed(1)}). ` +
  `CLICK to capture the mouse, W/S move, A/D turn, mouse to orbit, Shift to run, Space to jump, Escape to release.`,
);
