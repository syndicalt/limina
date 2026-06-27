// limina Phase 0 capstone demo (windowed) — now built on the engine module.
//
// Run: limina --window js/src/demo.ts
//
// Physics steps at a fixed dt -> writes ECS Position (SoA) -> renderSyncSystem
// pushes transforms to the three scene graph -> render + present. Camera
// auto-orbits and responds to WASD/QE; Escape or closing the window exits.

import * as THREE from "../build/three.bundle.mjs";
import { createEngine, ops } from "./engine.ts";
import { renderSyncSystem, spawnRenderable, syncPhysicsBodyTransform } from "./ecs/world.ts";

// The engine installs the Phase 11 render baseline (key sun + hemisphere fill +
// procedural-sky IBL + ground + framing), so this demo no longer hand-rolls its
// own lights/ground — one source of truth lives in render-baseline.ts.
const engine = await createEngine({ width: 960, height: 640 });
const { renderer, scene, camera, world } = engine;

ops.op_physics_create_world(-9.81);
ops.op_physics_add_ground(0);

const palette = [0xff8c1a, 0x4ade80, 0x60a5fa, 0xf472b6, 0xfacc15, 0xa78bfa];
const entities: { eid: number; bodyId: number }[] = [];
for (let i = 0; i < 6; i++) {
  const x = (i - 2.5) * 1.4;
  const y = 5 + i * 0.9;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardNodeMaterial({ color: palette[i % palette.length], roughness: 0.5, metalness: 0.1 }),
  );
  scene.add(mesh);
  const eid = spawnRenderable(world, mesh, x, y, 0);
  const bodyId = ops.op_physics_add_box(x, y, 0, 0.5);
  entities.push({ eid, bodyId });
}

const transformScratch = new Float32Array(7);
function fixedStep(_dt: number): void {
  ops.op_physics_step();
  for (const { eid, bodyId } of entities) {
    syncPhysicsBodyTransform(eid, bodyId, ops, transformScratch);
  }
}

let angle = 0;
let radius = 14;
let camHeight = 7;
const axes = new Float32Array(3);
function render(_alpha: number): void {
  ops.op_input_axes(axes);
  angle += 0.006 + axes[0] * 0.03;
  radius = Math.min(40, Math.max(5, radius - axes[2] * 0.25));
  camHeight = Math.min(25, Math.max(1.5, camHeight + axes[1] * 0.25));
  camera.position.set(Math.cos(angle) * radius, camHeight, Math.sin(angle) * radius);
  camera.lookAt(0, 1, 0);
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

ops.op_set_fixed_step_callback(fixedStep);
ops.op_set_frame_callback(render);
ops.op_set_resize_callback(onResize);
ops.op_log("demo ready: physics -> ECS -> three (engine module), fixed-timestep loop, WASD/QE camera");
