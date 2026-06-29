// limina physics_showcase demo (windowed): a bordered table of static-box rails, a
// triangular rack of dynamic spheres plus a cue ball, and a cue break. Each
// fixed step advances native Rapier, then every ball's full transform (position
// + orientation quaternion) is read back into the ECS so renderSyncSystem makes
// the balls visibly ROLL across the cloth rather than slide.
//
// Run: limina --window js/src/demos/physics_showcase.ts
//
// Physics (native Rapier) -> ECS Position/Rotation (SoA) -> renderSyncSystem ->
// three.js scene -> render + present. No agents: this is a pure physics showcase.

import * as THREE from "../../build/three.bundle.mjs";
import { createEngine, ops } from "../engine.ts";
import { renderSyncSystem, spawnRenderable, syncPhysicsBodyTransform } from "../ecs/world.ts";
import { createMaterial } from "../materials/palette.ts";

// ---- Table + rack geometry ------------------------------------------------
const BALL_R = 0.5;
const BALL_FRICTION = 0.2; // low: a physics_showcase ball glides on the cloth
const BALL_RESTITUTION = 0.9; // moderately lively ball-to-ball rebound
const RAIL_FRICTION = 0.3;
const RAIL_RESTITUTION = 0.6; // cushions absorb some energy
const GROUND_Y = 0; // top surface of the playfield
const BALL_Y = GROUND_Y + BALL_R; // ball centre rests on the cloth

const IX = 8; // interior half-extent along x (playfield x in [-8, 8])
const IZ = 4; // interior half-extent along z (playfield z in [-4, 4])
const RAIL_HALF_T = 0.25; // rail half thickness
const RAIL_HALF_H = 0.75; // rail half height (top at y=1.5, above ball top 1.0)
const RAIL_CY = RAIL_HALF_H; // rail centre y so its base sits on the ground

const PITCH = 1.05; // centre spacing in a rack row (> 2R so balls start apart)
const ROW_PITCH = PITCH * Math.cos(Math.PI / 6); // perpendicular row spacing
const APEX_X = -1; // apex ball x; rows extend toward -x
const CUE_X = 5; // cue ball sits down-table from the apex
const CUE_IMPULSE = 13.0; // toward -x (into the rack); v0 ~= 24.8 m/s (near the no-CCD tunneling ceiling)

// Distinct colours for the 10 racked balls; the cue ball is bright white.
const RACK_COLORS = [
  0xffd400, 0x0047ab, 0xd11f1f, 0x5a189a, 0xff8c00,
  0x14532d, 0x7b241c, 0x101010, 0x2563eb, 0xec4899,
];
const CUE_COLOR = 0xfafafa;

const engine = await createEngine({ width: 960, height: 640, renderBaseline: { ground: { enabled: false } } });
const { renderer, scene, camera, world } = engine;
scene.background = new THREE.Color(0x05080d);

scene.add(new THREE.AmbientLight(0x404060, 1.2));
const keyLight = new THREE.DirectionalLight(0xffffff, 3.4);
keyLight.position.set(6, 12, 8);
scene.add(keyLight);

// Felt table surface (visual only; the physics floor is op_physics_add_ground).
const surfaceW = 2 * (IX + 2 * RAIL_HALF_T);
const surfaceD = 2 * (IZ + 2 * RAIL_HALF_T);
const felt = new THREE.Mesh(
  new THREE.BoxGeometry(surfaceW, 0.2, surfaceD),
  // Large static cloth bed → procedural-PBR greenery reads as felt grain.
  createMaterial("foliage", { pbr: true }),
);
felt.position.y = GROUND_Y - 0.1;
scene.add(felt);

// ---- Physics world: floor + four cushioned rails --------------------------
ops.op_physics_create_world(-9.81);
ops.op_physics_add_ground(GROUND_Y);

const railZ = IZ + RAIL_HALF_T;
const railX = IX + RAIL_HALF_T;
const railSpecs: [number, number, number, number, number, number][] = [
  // [cx, cy, cz, hx, hy, hz]
  [0, RAIL_CY, railZ, IX + 2 * RAIL_HALF_T, RAIL_HALF_H, RAIL_HALF_T],
  [0, RAIL_CY, -railZ, IX + 2 * RAIL_HALF_T, RAIL_HALF_H, RAIL_HALF_T],
  [railX, RAIL_CY, 0, RAIL_HALF_T, RAIL_HALF_H, IZ + 2 * RAIL_HALF_T],
  [-railX, RAIL_CY, 0, RAIL_HALF_T, RAIL_HALF_H, IZ + 2 * RAIL_HALF_T],
];
// Static wooden cushions/rails → procedural-PBR timber grain.
const railMat = createMaterial("wood", { pbr: true });
for (const [cx, cy, cz, hx, hy, hz] of railSpecs) {
  ops.op_physics_add_static_box(cx, cy, cz, hx, hy, hz, RAIL_FRICTION, RAIL_RESTITUTION);
  const railMesh = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), railMat);
  railMesh.position.set(cx, cy, cz);
  scene.add(railMesh);
}

// ---- Cue ball + the 10-ball triangle rack (apex toward the cue) ------------
interface Ball {
  eid: number;
  bodyId: number;
}
const balls: Ball[] = [];

function spawnBall(x: number, z: number, color: number): Ball {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_R, 24, 16),
    new THREE.MeshStandardNodeMaterial({ color, roughness: 0.25, metalness: 0.05 }),
  );
  scene.add(mesh);
  const bodyId = ops.op_physics_add_sphere(x, BALL_Y, z, BALL_R, BALL_FRICTION, BALL_RESTITUTION);
  const eid = spawnRenderable(world, mesh, x, BALL_Y, z);
  return { eid, bodyId };
}

const cue = spawnBall(CUE_X, 0, CUE_COLOR);
balls.push(cue);
let colorIdx = 0;
for (let row = 0; row <= 3; row++) {
  const x = APEX_X - row * ROW_PITCH;
  for (let k = 0; k <= row; k++) {
    const z = (k - row / 2) * PITCH;
    balls.push(spawnBall(x, z, RACK_COLORS[colorIdx++ % RACK_COLORS.length]));
  }
}

// Cue break: drive the cue straight into the rack apex (toward -x).
ops.op_physics_apply_impulse(cue.bodyId, -CUE_IMPULSE, 0, 0);

// ---- Loop -----------------------------------------------------------------
const transformScratch = new Float32Array(7);
function fixedStep(_dt: number): void {
  ops.op_physics_step();
  for (const { eid, bodyId } of balls) {
    syncPhysicsBodyTransform(eid, bodyId, ops, transformScratch);
  }
}

let angle = 0.6;
function render(_alpha: number): void {
  angle += 0.0025;
  camera.position.set(Math.cos(angle) * 18, 14, Math.sin(angle) * 18);
  camera.lookAt(0, 0, 0);
  renderSyncSystem(world);
  renderer.render(scene, camera);
  ops.op_surface_present(engine.context);
}

function onResize(w: number, h: number): void {
  ops.op_surface_resize(w, h);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// Warm-up render: issue one frame now so the host's post-eval event-loop pump
// compiles all WebGPU pipelines while the loop is uncontended, avoiding a blank
// opening frame (the player.ts pattern).
renderSyncSystem(world);
renderer.render(scene, camera);
ops.op_surface_present(engine.context);

ops.op_set_fixed_step_callback(fixedStep);
ops.op_set_frame_callback(render);
ops.op_set_resize_callback(onResize);
ops.op_log("physics_showcase demo ready: cue break -> Rapier -> ECS -> three (balls roll on the cloth)");
