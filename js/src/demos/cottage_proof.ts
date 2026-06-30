// COTTAGE PROOF — the modeling loop's first end-to-end target (spike piece #4).
//
// One cottage raised from the declarative RECIPE via assembleBuilding (door + windows + gable roof,
// all real collidable entities, structurally asserted by p15c), on flat ground under the render
// baseline, framed by a hero 3/4 camera matching the reference
// art-direction/library/buildings/medieval/dwelling/cottage/cottage-2.jpg.
//
// Run: ./target/release/limina --window js/src/demos/cottage_proof.ts
//
// This is the scene we ITERATE: build → capture → compare to the ref → refine the recipe → repeat,
// until the capture reads like a cottage.

import { createEngine, ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { assembleBuilding, type BuildingRecipe } from "../skills/building-recipe.ts";
import type { WorldContext } from "../skills/registry.ts";

const engine = await createEngine({ width: 1280, height: 720 });
const world = {
  ecs: engine.world, entities: engine.entities, tags: engine.tags,
  transforms: engine.transforms, spatial: engine.spatial, scene: engine.scene,
  camera: engine.camera, renderer: engine.renderer, ops: engine.ops,
  width: engine.width, height: engine.height, mode: engine.mode,
} as WorldContext;

ops.op_physics_create_world(-9.81);

// The cottage recipe — iteration target. Half-timber palette (timber-brown walls, pale plaster tone
// will come from materials later); steep gable; a door flanked by windows on the front, windows aside.
const COTTAGE: BuildingRecipe = {
  width: 7, depth: 6, height: 4.2, wallThickness: 0.22,
  openings: [
    { wall: "south", kind: "door", offset: 0, width: 1.4, height: 2.4, sill: 0 },
    { wall: "south", kind: "window", offset: -2.3, width: 1.5, height: 1.6, sill: 1.0 },
    { wall: "south", kind: "window", offset: 2.3, width: 1.5, height: 1.6, sill: 1.0 },
    { wall: "east", kind: "window", offset: 0, width: 1.6, height: 1.6, sill: 1.1 },
    { wall: "west", kind: "window", offset: 0, width: 1.6, height: 1.6, sill: 1.1 },
    { wall: "north", kind: "window", offset: 0, width: 1.8, height: 1.6, sill: 1.1 },
  ],
  roof: { type: "gable", pitch: 3.6, overhang: 0.4 }, // steeper, tighter eaves (less detached read)
  colors: { wall: 0xa07a4e, floor: 0x3a322a, roof: 0x4a3324 }, // warm timber-brown walls, dark shingle
};

const built = assembleBuilding(COTTAGE, [0, 0, 0], world);

// Hero 3/4 camera: front-right, slightly above, framing the whole cottage (matches the ref angle).
const H = COTTAGE.height;
const target = { x: 0, y: H * 0.45, z: 0 };
engine.camera.near = 0.1;
engine.camera.far = 200;
engine.camera.updateProjectionMatrix();
let angle = Math.PI * 0.28; // front-right quarter
const radius = 12;
const camHeight = H * 0.85; // lower, more grounded hero angle (matches the ref)

function render(_alpha: number): void {
  const axes = new Float32Array(3);
  ops.op_input_axes(axes); // A/D orbit, S/W dolly
  angle += axes[0] * 0.02;
  const r = radius * (1 - axes[2] * 0.15);
  engine.camera.position.set(target.x + Math.cos(angle) * r, camHeight, target.z + Math.sin(angle) * r);
  engine.camera.lookAt(target.x, target.y, target.z);
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
render(0); // warm-up
ops.op_set_frame_callback(render);
ops.op_set_resize_callback(onResize);
ops.op_log(`cottage proof: 1 cottage (${built.entityCount} parts) from the recipe+assembler — door + 5 windows + gable. A/D orbit, S/W dolly.`);
