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

import * as THREE from "../../build/three.bundle.mjs";
import { createEngine, ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { LiminaTracer } from "../observability/event.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { buildTerrainMesh } from "../terrain/render.ts";
import { TILE_SIZE } from "../terrain/procedural.ts";
import { terrainTypeHints } from "../terrain/terrain-types.ts";
import { scatterBiomeContent } from "../terrain/biome-content.ts";
import { MATERIALS } from "../materials/palette.ts";
import { CharacterController } from "../world/character.ts";
import { ThirdPersonCamera } from "../world/third_person_camera.ts";

const SEED = 1234;
const TYPE = "beach" as const;
const BOUNDS = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 }; // a 2x2-tile region (~96m square)

const engine = await createEngine({ width: 1280, height: 720, renderBaseline: { ground: { enabled: false } } });

const tracer = new LiminaTracer("ses_playable");
const registry = new SkillRegistry(tracer);
const core = registerCoreSkills(registry);

const world: WorldContext = {
  ecs: engine.world, entities: engine.entities, tags: engine.tags,
  transforms: engine.transforms, spatial: engine.spatial, scene: engine.scene,
  camera: engine.camera, renderer: engine.renderer, ops: engine.ops,
  width: engine.width, height: engine.height, mode: engine.mode,
};
const base = { agentId: "agt_playable", sessionId: "ses_playable", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

ops.op_physics_create_world(-9.81);

// Terrain: generate the heightfield colliders via the agent-facing skill, then mount
// the matching surface meshes (vertices coincide with the collider the character walks).
const hints = terrainTypeHints(TYPE, BOUNDS);
const gen = await registry.invoke("world.generateRegion", { seed: SEED, bounds: BOUNDS, lod: 0, type: TYPE }, base);
const regionId = (gen.result as { regionId: string }).regionId;
for (let tz = BOUNDS.minTz; tz <= BOUNDS.maxTz; tz++) {
  for (let tx = BOUNDS.minTx; tx <= BOUNDS.maxTx; tx++) {
    const tile = core.terrain.source.generateTile({ seed: SEED, tx, tz, lod: 0, hints });
    engine.scene.add(buildTerrainMesh(tile, { color: MATERIALS.sand.color, roughness: 0.95 }));
  }
}
// Populate the beach with its biome content (palms, grass) — same path the gate drives.
await scatterBiomeContent({ registry, source: core.terrain.source, regionId, type: TYPE, bounds: BOUNDS, seed: SEED, base });

// Character: spawn at the region center, resting on the generated surface.
const spawnX = ((BOUNDS.minTx + BOUNDS.maxTx + 1) / 2) * TILE_SIZE;
const spawnZ = ((BOUNDS.minTz + BOUNDS.maxTz + 1) / 2) * TILE_SIZE;
const surfaceY = core.terrain.source.sampleHeight(SEED, spawnX, spawnZ, 0, hints);
const controller = new CharacterController(ops, [spawnX, surfaceY + 0.9, spawnZ], { halfHeight: 0.5, radius: 0.35 });
ops.op_physics_step(); // build the broad-phase BVH so the first move_character resolves the ground

// Visible capsule for the character (CapsuleGeometry length = 2 * cylindrical half-height).
const capsule = new THREE.Mesh(
  new THREE.CapsuleGeometry(controller.radius, controller.halfHeight * 2, 8, 16),
  new THREE.MeshStandardNodeMaterial({ color: 0xff7a1a, roughness: 0.5, metalness: 0.0 }),
);
capsule.castShadow = true;
engine.scene.add(capsule);

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

function fixedStep(dt: number): void {
  ops.op_input_axes(axes);       // [0]=A/D, [1]=Q/E (unused), [2]=S/W
  ops.op_input_buttons(buttons); // [0]=jump/Space, [1]=run/Shift
  // A/D turn the sim-owned heading; W/S move along it. (No render state read.)
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

function render(_alpha: number): void {
  ops.op_input_look(look);
  freeYaw += look[0] * LOOK_SENS;
  freePitch -= look[1] * LOOK_SENS;
  if (freePitch < PITCH_MIN) freePitch = PITCH_MIN;
  if (freePitch > PITCH_MAX) freePitch = PITCH_MAX;
  const p = controller.position;
  capsule.position.set(p[0], p[1], p[2]);
  const yaw = controller.facing; // local +Z faces the move dir (engine yaw->quat convention)
  capsule.quaternion.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
  // Follow camera = behind the sim heading + the mouse free-look offset.
  camera.yaw = heading + freeYaw;
  camera.pitch = freePitch;
  camera.update(engine.camera, p);
  renderSyncSystem(engine.world);
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
  `playable world ready: beach region (seed ${SEED}) generated + populated; ` +
  `walk the character on the Rapier terrain. CLICK to capture the mouse, ` +
  `W/S move, A/D turn, mouse to look, Shift to run, Space to jump, Escape to release.`,
);
