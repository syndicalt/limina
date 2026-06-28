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
import { createEngine, ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { LiminaTracer } from "../observability/event.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { buildTerrainMesh } from "../terrain/render.ts";
import { TILE_SIZE } from "../terrain/procedural.ts";
import { terrainTypeHints, type TerrainTypeName } from "../terrain/terrain-types.ts";
import { surveyRegionRelief, scatterBiomeContent } from "../terrain/biome-content.ts";
import { MATERIALS } from "../materials/palette.ts";
import { DEFAULT_RENDER_BASELINE } from "../render-baseline.ts";
import { buildPostPipeline } from "../render/post.ts";
import { CharacterController } from "../world/character.ts";
import { ThirdPersonCamera } from "../world/third_person_camera.ts";

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

const engine = await createEngine({
  width: 1280,
  height: 720,
  renderBaseline: {
    ground: { enabled: false },
    atmosphere: { height: { enabled: true, density: 0.00055 } },
  },
});

const tracer = new LiminaTracer("ses_playable_landscape");
const registry = new SkillRegistry(tracer);
const core = registerCoreSkills(registry);

const world: WorldContext = {
  ecs: engine.world, entities: engine.entities, tags: engine.tags,
  transforms: engine.transforms, spatial: engine.spatial, scene: engine.scene,
  camera: engine.camera, renderer: engine.renderer, ops: engine.ops,
  width: engine.width, height: engine.height, mode: engine.mode,
};
const base = { agentId: "agt_playable_landscape", sessionId: "ses_playable_landscape", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

ops.op_physics_create_world(-9.81);

// 1. THE GROUND — generate the eroded mountains region (heightfield colliders the
//    character walks + region handle). Same hints (SHAPE) as the visible mesh below.
const gen = await registry.invoke("world.generateRegion", { seed: SEED, bounds: BOUNDS, lod: 0, type: TYPE, hints: SHAPE }, base);
if (!gen.success) throw new Error("world.generateRegion failed: " + JSON.stringify(gen.error));
const regionId = (gen.result as { regionId: string }).regionId;

// Survey the eroded surface (SAME hints) → relief + sea level.
const relief = surveyRegionRelief(core.terrain.source, SEED, BOUNDS, HINTS);
const seaLevel = relief.minY + SEA_FRACTION * (relief.maxY - relief.minY);

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

// 3. THE SURFACE — mount each tile with the procedural-PBR material (built with the
//    SAME eroded hints, so the visible mesh coincides with the colliders).
for (let tz = BOUNDS.minTz; tz <= BOUNDS.maxTz; tz++) {
  for (let tx = BOUNDS.minTx; tx <= BOUNDS.maxTx; tx++) {
    const tile = core.terrain.source.generateTile({ seed: SEED, tx, tz, lod: 0, hints: HINTS });
    const band = { seaLevel, minY: relief.minY, maxY: relief.maxY };
    const mesh = buildTerrainMesh(tile, SURFACE === "pbr"
      ? { roughness: 0.95, pbr: { ...band, waterline: { wetBand: 1.4, foam: 0.5 } } }
      : { roughness: 0.95, palette: band });
    engine.scene.add(mesh);
  }
}

// 4. THE CONTENT — pines + boulders scattered via the deterministic biome-content seam.
const scattered = await scatterBiomeContent({
  registry, source: core.terrain.source, regions: core.terrain.regions,
  regionId, type: TYPE, bounds: BOUNDS, seed: SEED, base,
  waterLevel: seaLevel, waterMargin: WATER_MARGIN,
});

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

// Visible capsule (CapsuleGeometry length = 2 * cylindrical half-height).
const capsule = new THREE.Mesh(
  new THREE.CapsuleGeometry(controller.radius, controller.halfHeight * 2, 8, 16),
  new THREE.MeshStandardNodeMaterial({ color: 0xff7a1a, roughness: 0.5, metalness: 0.0 }),
);
capsule.castShadow = true;
engine.scene.add(capsule);

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

function fixedStep(dt: number): void {
  ops.op_input_axes(axes);       // [0]=A/D, [1]=Q/E (unused), [2]=S/W
  ops.op_input_buttons(buttons); // [0]=jump/Space, [1]=run/Shift
  heading -= axes[0] * TURN_RATE * dt;
  const jumpHeld = buttons[0] === 1;
  const jump = jumpHeld && !prevJump; // rising edge
  prevJump = jumpHeld;
  controller.step(
    { forward: axes[2], strafe: 0, yaw: heading, run: buttons[1] === 1, jump },
    dt,
  );
  ops.op_physics_step();
}

// 7. POST stack drives presentation (GTAO + bloom + grade over the atmosphere).
const post = buildPostPipeline(engine.renderer, engine.scene, engine.camera);

function render(_alpha: number): void {
  ops.op_input_look(look);
  freeYaw += look[0] * LOOK_SENS;
  freePitch -= look[1] * LOOK_SENS;
  if (freePitch < PITCH_MIN) freePitch = PITCH_MIN;
  if (freePitch > PITCH_MAX) freePitch = PITCH_MAX;
  const p = controller.position;
  capsule.position.set(p[0], p[1], p[2]);
  const yaw = controller.facing;
  capsule.quaternion.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
  camera.yaw = heading + freeYaw;
  camera.pitch = freePitch;
  camera.update(engine.camera, p);
  renderSyncSystem(engine.world);
  post.render();
  ops.op_surface_present(engine.context);
}

function onResize(w: number, h: number): void {
  ops.op_surface_resize(w, h);
  engine.renderer.setSize(w, h, false);
  post.setSize(w, h);
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
