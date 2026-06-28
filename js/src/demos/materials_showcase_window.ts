// MATERIALS SHOWCASE — the headline for limina's general PBR MATERIAL SYSTEM.
//
// Run: ./target/release/limina --window js/src/demos/materials_showcase_window.ts
//   (frame-capped: ./target/release/limina --window --frames 1200 js/src/demos/materials_showcase_window.ts)
//
// What this proves, in one walkable scene:
//   1. PROCEDURAL-PBR PRIMITIVES (the zero-download headline) — `scene.createEntity({ shape,
//      material:"<name>", pbr:true, ... })` turns a flat palette preset into a TACTILE surface:
//      triplanar noise albedo + a real detail NORMAL + honest roughness, no textures to ship.
//   2. A/B CONTRAST — for a few materials we place the FLAT version (pbr:false) right next to the
//      PBR version (pbr:true) so the upgrade reads at a glance.
//   3. TEXTURE-PACK IMPORT (the optional upgrade path) — `material.import` brings a real bundled
//      image in as a triplanar PBR material and applies it to one box. Guarded so the demo still
//      boots if the asset id differs; the procedural primitives are the guaranteed headline.
//
// `createEngine` applies the render BASELINE automatically (sun + hemisphere fill + procedural-sky
// IBL + atmosphere + ACES tonemapping) — so the surfaces are lit honestly with zero setup. The rest
// of the file is just a free-fly CAMERA to walk the lineup.

import * as THREE from "../../build/three.bundle.mjs";
import { createEngine, ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { LiminaTracer } from "../observability/event.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { createMaterial, type MaterialName } from "../materials/palette.ts";

// The engine + render baseline. We suppress the default flat ground plane because we lay down our
// own large PBR stone slab below.
const engine = await createEngine({
  width: 1280,
  height: 720,
  renderBaseline: { ground: { enabled: false } },
});

// The skill registry — built exactly like default_world_window so scene.createEntity and
// material.import are available against the live engine world.
const tracer = new LiminaTracer("ses_materials_showcase");
const registry = new SkillRegistry(tracer);
const core = registerCoreSkills(registry);
void core;
const world: WorldContext = {
  ecs: engine.world, entities: engine.entities, tags: engine.tags,
  transforms: engine.transforms, spatial: engine.spatial, scene: engine.scene,
  camera: engine.camera, renderer: engine.renderer, ops: engine.ops,
  width: engine.width, height: engine.height, mode: engine.mode,
};
const base = { agentId: "agt_materials_showcase", sessionId: "ses_materials_showcase", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

ops.op_physics_create_world(-9.81);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// GROUND — a large static procedural-PBR stone slab. Hand-built (visual only; nothing falls, so no
// physics body needed) so the lineup has a tactile, lit surface to rest on. `createMaterial("stone",
// { pbr:true })` is the same procedural-PBR upgrade the lineup below uses, applied to a plain mesh.
// ════════════════════════════════════════════════════════════════════════════════════════════════
const groundMat = createMaterial("stone", { pbr: true });
const ground = new THREE.Mesh(new THREE.BoxGeometry(80, 1, 40), groundMat);
ground.position.set(0, -0.5, 0);
engine.scene.add(ground);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// CAPABILITY 1 — PROCEDURAL-PBR PRIMITIVES. Every entity below is a single `scene.createEntity` call
// with `pbr:true`: the named palette preset is upgraded in place to a triplanar-noise albedo + a
// real detail normal + honest roughness. Two rows so each material reads on both a sphere and a box.
// ════════════════════════════════════════════════════════════════════════════════════════════════
const PALETTE: MaterialName[] = ["stone", "rock", "sand", "wood", "plank", "grass", "foliage", "leaf", "metal", "water"];

// Center the row on X: 10 items spaced 6 apart → x from -27 .. +27.
const SPACING = 6;
const x0 = -((PALETTE.length - 1) * SPACING) / 2; // = -27

// Row A — SPHERES at z = -4. Spheres show the detail normal's curvature response best.
for (let i = 0; i < PALETTE.length; i++) {
  const name = PALETTE[i];
  const x = x0 + i * SPACING;
  await registry.invoke("scene.createEntity", {
    shape: "sphere", material: name, pbr: true, size: 3, position: [x, 2, -4],
  }, base);
}

// Row B — BOXES at z = +4. The SAME materials on flat faces so triplanar projection is obvious.
for (let i = 0; i < PALETTE.length; i++) {
  const name = PALETTE[i];
  const x = x0 + i * SPACING;
  await registry.invoke("scene.createEntity", {
    shape: "box", material: name, pbr: true, size: 3, position: [x, 2, 4],
  }, base);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// CAPABILITY 2 — A/B CONTRAST. For a few materials, place the FLAT preset (pbr:false) next to the
// PROCEDURAL-PBR version (pbr:true), as side-by-side pairs, so the upgrade is unmistakable. Left box
// of each pair is flat; right box is PBR.
// ════════════════════════════════════════════════════════════════════════════════════════════════
const CONTRAST: MaterialName[] = ["rock", "wood", "sand", "metal"];
const PAIR_GAP = 4;     // gap between flat & PBR within a pair
const PAIR_PITCH = 12;  // gap between successive pairs
const pairX0 = -((CONTRAST.length - 1) * PAIR_PITCH) / 2;
for (let i = 0; i < CONTRAST.length; i++) {
  const name = CONTRAST[i];
  const cx = pairX0 + i * PAIR_PITCH;
  // FLAT (legacy preset — no nodes, flat color/roughness).
  await registry.invoke("scene.createEntity", {
    shape: "box", material: name, pbr: false, size: 3, position: [cx - PAIR_GAP / 2, 2, 12],
  }, base);
  // PROCEDURAL-PBR (same name, upgraded surface).
  await registry.invoke("scene.createEntity", {
    shape: "box", material: name, pbr: true, size: 3, position: [cx + PAIR_GAP / 2, 2, 12],
  }, base);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// CAPABILITY 3 — TEXTURE-PACK IMPORT (optional upgrade path). Bring a real bundled image in as a
// TRIPLANAR PBR material via `material.import`, then apply it to one box. GUARDED: if the bundled
// asset ids differ in this build, we log a warning and the demo still boots on the procedural
// headline above.
// ════════════════════════════════════════════════════════════════════════════════════════════════
let importedOk = false;
try {
  await registry.invoke("material.import", {
    name: "logo_pack", albedo: "limina-hero.png", normal: "limina-x-header.png", triplanar: true, scale: 0.3,
  }, base);
  await registry.invoke("scene.createEntity", {
    shape: "box", material: "logo_pack", size: 4, position: [0, 2.5, 20],
  }, base);
  importedOk = true;
} catch (e) {
  ops.op_log("materials_showcase: material.import skipped: " + (e as Error).message);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// CAMERA — free-fly so you can walk the lineup. (Copied from default_world_window; bare render, no
// post-processing — post freezes navigation on this backend.) Framed above and in front of the grid,
// looking down at the lineup center ~[0, 2, 0].
// ════════════════════════════════════════════════════════════════════════════════════════════════
engine.camera.near = 0.5;
engine.camera.far = 2000;
engine.camera.updateProjectionMatrix();

const pos = { x: 0, y: 18, z: 44 };
let yaw = 0;
let pitch = -0.32;
const MOVE_SPEED = 30;
const LOOK_SENS = 0.0022;
const PITCH_LIMIT = Math.PI / 2 - 0.03;
const DT = 1 / 60;

const axes = new Float32Array(3);
const look = new Float32Array(2);
function render(_alpha: number): void {
  ops.op_input_axes(axes); // [0]=A/D strafe, [1]=Q/E up, [2]=S/W forward
  ops.op_input_look(look); // [0]=mouse dx, [1]=mouse dy
  yaw += look[0] * LOOK_SENS;
  pitch -= look[1] * LOOK_SENS;
  if (pitch > PITCH_LIMIT) pitch = PITCH_LIMIT;
  if (pitch < -PITCH_LIMIT) pitch = -PITCH_LIMIT;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const sy = Math.sin(yaw), cyaw = Math.cos(yaw);
  const fwd = { x: cp * sy, y: sp, z: -cp * cyaw };
  const right = { x: cyaw, y: 0, z: sy };
  const s = MOVE_SPEED * DT;
  pos.x += (fwd.x * axes[2] + right.x * axes[0]) * s;
  pos.y += (fwd.y * axes[2] + axes[1]) * s;
  pos.z += (fwd.z * axes[2] + right.z * axes[0]) * s;
  engine.camera.position.set(pos.x, pos.y, pos.z);
  engine.camera.lookAt(pos.x + fwd.x, pos.y + fwd.y, pos.z + fwd.z);
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
render(0); // warm-up (compile WebGPU pipelines before the loop)
ops.op_set_frame_callback(render);
ops.op_set_resize_callback(onResize);
ops.op_log(
  `materials-showcase ready: procedural-PBR palette lineup (10 materials × sphere+box), ` +
  `flat-vs-PBR A/B strip, + a material.import texture-pack box` +
  (importedOk ? "" : " (import skipped — see warning above)") + ". " +
  `FREE-FLY: click to capture the mouse, WASD to move, Q/E up·down, mouse to look, Escape to release.`,
);
