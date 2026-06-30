// REMNANTS OF AETHON — THE EASTERN WATCH (outpost environment showcase).
//
// A frontier watch post on a WEST→EAST Blight gradient, sourced entirely from the asset pipeline:
// the healthy CAMP (watchtower, tents, signal fire, well, barrels) sits west under warm light + living
// pines; eastward the world DRAINS into the Blight — dead trees, a toppled boundary marker, grey haze.
// The camera stands in the camp and looks EAST into the corruption (the watch's gaze). All assets are
// CC glbs fetched by tools/asset-fetch.ts and placed through the grounding + scale-normalizing
// asset.place. This is the environment bed the single-player halo loop scaffolds onto.
//
// Asset manifest (fetch with tools/asset-fetch.ts before running; curated picks):
//   building "wooden watchtower"      → building-wooden-watchtower-1.glb
//   prop     "camping tent"           → prop-camping-tent-1.glb
//   prop     "campfire"               → prop-campfire-1.glb
//   prop     "barrel"                 → prop-barrel-1.glb
//   prop     "water well"             → prop-water-well-1.glb
//   prop     "stone pillar"           → prop-stone-pillar-1.glb   (perimeter marker)
//   vegetation "pine tree"            → vegetation-pine-tree-1.glb
//   vegetation "dead tree"            → vegetation-dead-tree-1.glb
//
// Run: ./target/release/limina --window js/src/demos/aethon_outpost.ts

import { createEngine, ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { LiminaTracer } from "../observability/event.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { TILE_SIZE } from "../terrain/procedural.ts";
import { terrainTypeHints } from "../terrain/terrain-types.ts";
import { surveyRegionRelief } from "../terrain/biome-content.ts";

const SEED = 23;
const BOUNDS = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 } as const; // ~96 m
const SHAPE = { amp: 0.25, erode: 0 };

const engine = await createEngine({
  width: 1280, height: 720,
  renderBaseline: { ground: { enabled: false }, atmosphere: { density: 0.0006 } }, // moody haze (Blight reads in the distance)
});
const registry = new SkillRegistry(new LiminaTracer("ses_aethon_outpost"));
const core = registerCoreSkills(registry);
const world: WorldContext = {
  ecs: engine.world, entities: engine.entities, tags: engine.tags,
  transforms: engine.transforms, spatial: engine.spatial, scene: engine.scene,
  camera: engine.camera, renderer: engine.renderer, ops: engine.ops,
  width: engine.width, height: engine.height, mode: engine.mode,
};
const base = { agentId: "agt", sessionId: "ses_aethon_outpost", permissions: resolveProfile("builder.readWrite"), tick: 0, world };
ops.op_physics_create_world(-9.81);

const HINTS = { ...terrainTypeHints("plains", BOUNDS), ...SHAPE };
const relief = surveyRegionRelief(core.terrain.source, SEED, BOUNDS, HINTS);
const gen = await registry.invoke("world.generateRegion", {
  seed: SEED, bounds: BOUNDS, lod: 0, type: "plains", hints: SHAPE,
  surface: { mode: "pbr", roughness: 0.95, seaLevel: relief.minY - 5, minY: relief.minY, maxY: relief.maxY },
}, base);
if (!gen.success) throw new Error("generateRegion failed: " + JSON.stringify(gen.error));

const cx = ((BOUNDS.minTx + BOUNDS.maxTx + 1) / 2) * TILE_SIZE;
const cz = ((BOUNDS.minTz + BOUNDS.maxTz + 1) / 2) * TILE_SIZE;
const surf = (x: number, z: number): number => core.terrain.source.sampleHeight(SEED, x, z, 0, HINTS);

// +X is EAST (toward the Blight); the camp sits at WEST (−X).
async function place(assetId: string, dx: number, dz: number, height: number, rotY = 0): Promise<void> {
  const x = cx + dx, z = cz + dz;
  const res = await registry.invoke("asset.place", { assetId, position: [x, surf(x, z), z], normalizeHeight: height, rotation: [0, rotY, 0] }, base);
  if (!res.success) { ops.op_log(`asset.place FAILED ${assetId}: ${JSON.stringify(res.error)}`); return; }
  const b = (res.result as { bounds: [number, number, number] }).bounds;
  ops.op_log(`placed ${assetId} @(${dx.toFixed(0)},${dz.toFixed(0)}) → bounds=[${b.map((v) => v.toFixed(1)).join(",")}]`);
}

// ── THE CAMP (west, healthy): watchtower + well + tents + fire + barrels, ringed by living pines. ─
await place("building-wooden-watchtower-1.glb", -30, -2, 9.0);
await place("prop-water-well-1.glb", -22, 8, 2.2);
await place("prop-camping-tent-1.glb", -34, 9, 2.2, 0.6);
await place("prop-camping-tent-1.glb", -27, 13, 2.2, -0.4);
await place("prop-campfire-1.glb", -29, 6, 0.8);
await place("prop-barrel-1.glb", -24, 2, 0.9);
await place("prop-barrel-1.glb", -23, 3.2, 0.9);
for (let i = 0; i < 6; i++) { // living pines clustered around the camp
  const a = (i / 6) * Math.PI * 2;
  await place("vegetation-pine-tree-1.glb", -28 + Math.cos(a) * 14, Math.cos(a * 1.7) * 16, 6.5 + (i % 3), a);
}

// ── THE PERIMETER MARKER at the Blight boundary (toppled — a story beat). ─────────────────────────
await place("prop-stone-pillar-1.glb", 2, 4, 1.8, Math.PI / 2.3); // leaning/toppled toward the Blight

// ── THE BLIGHT (east): dead trees, sparser eastward + receding into the haze. ─────────────────────
const deadTrees: Array<[number, number, number]> = [
  [12, -6, 7], [18, 7, 6.5], [16, -14, 6], [26, 2, 7.5], [30, -10, 6], [33, 12, 6.5], [40, -3, 7], [44, 9, 6],
];
for (const [dx, dz, h] of deadTrees) await place("vegetation-dead-tree-1.glb", dx, dz, h, dx * 0.3);

// Hero camera: an elevated SW vantage looking NE ACROSS the camp toward the Blight (the watch's view).
const eye = { x: cx - 48, y: surf(cx - 48, cz - 30) + 17, z: cz - 32 };
const look = { x: cx - 14, z: cz + 3 }; // feature the camp; the Blight recedes beyond it
engine.camera.near = 0.3; engine.camera.far = 500; engine.camera.updateProjectionMatrix();
let t = 0;
function render(_a: number): void {
  const axes = new Float32Array(3); ops.op_input_axes(axes);
  t += 0.0018 + axes[0] * 0.02;
  // a slow drift along the camp's edge, always gazing east across the outpost into the Blight
  engine.camera.position.set(eye.x + Math.sin(t) * 10, eye.y, eye.z + Math.cos(t) * 5);
  engine.camera.lookAt(look.x, surf(look.x, look.z) + 4, look.z);
  renderSyncSystem(engine.world);
  engine.renderer.render(engine.scene, engine.camera);
  ops.op_surface_present(engine.context);
}
function onResize(w: number, h: number): void {
  ops.op_surface_resize(w, h); engine.renderer.setSize(w, h, false);
  engine.camera.aspect = w / h; engine.camera.updateProjectionMatrix();
}
render(0);
ops.op_set_frame_callback(render);
ops.op_set_resize_callback(onResize);
ops.op_log("Aethon outpost ready: the Eastern Watch — camp (west) gazing into the Blight (east), all asset-sourced. A/D drift.");
