// Phase 11 ACCEPTANCE — "a cottage on a beach", LIVE for UAT.
//
// Run: ./target/release/limina --window js/src/demos/cottage_beach_window.ts
//   (or with a frame cap: ./target/release/limina --window --frames 1200 js/src/demos/cottage_beach_window.ts)
//
// This is the in-tab/in-window LOOK for the headless-proven scene builder
// (js/src/demos/cottage_beach.ts + js/test/p11_cottage_scene.ts). createEngine
// installs the Phase 11 render baseline automatically (key sun + hemisphere fill +
// procedural-sky IBL + tonemapping), so the world is lit by default — the flat
// baseline ground is disabled here because the generated terrain IS the ground.
//
// What you should see: a procedural beach (sand surface), a sea-level water plane the
// low sand dips under, a cottage standing on the dry sand, and palms + driftwood
// scattered across the beach above the waterline — ALL placed by asset id (the
// bundled test GLTFs stand in for the curated CC0 beach pack; swap the ASSET-ID
// constants in cottage_beach.ts to ship the real look). Camera auto-orbits the beach.

import * as THREE from "../../build/three.bundle.mjs";
import { createEngine, ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { LiminaTracer } from "../observability/event.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { buildTerrainMesh } from "../terrain/render.ts";
import { TILE_SIZE } from "../terrain/procedural.ts";
import { MATERIALS } from "../materials/palette.ts";
import { TROPICAL_BEACH_BASELINE } from "../render-baseline.ts";
import { buildCottageBeach, beachShapeHints, BEACH_SEED, BEACH_BOUNDS } from "./cottage_beach.ts";

// Opt into the NAMED warm "golden-hour tropical beach" baseline (warm sun + tropical
// sky IBL + lifted exposure) — additive, it never changes the global default. The
// terrain IS the ground here, so suppress the baseline's flat ground plane (it would
// clip through the beach) while keeping the warm sun/IBL/tonemapping/sky.
const engine = await createEngine({
  width: 1120,
  height: 720,
  renderBaseline: { ...TROPICAL_BEACH_BASELINE, ground: { ...TROPICAL_BEACH_BASELINE.ground, enabled: false } },
});

const tracer = new LiminaTracer("ses_cottage_beach_window");
const registry = new SkillRegistry(tracer);
const core = registerCoreSkills(registry);

const world: WorldContext = {
  ecs: engine.world,
  entities: engine.entities,
  tags: engine.tags,
  transforms: engine.transforms,
  spatial: engine.spatial,
  scene: engine.scene,
  camera: engine.camera,
  renderer: engine.renderer,
  ops: engine.ops,
  width: engine.width,
  height: engine.height,
  mode: engine.mode,
};

ops.op_physics_create_world(-9.81);

// Assemble the beach from intent-level skills (the SAME builder the headless test
// drives). asset.place adds the cottage GLTF root; asset.scatter mounts the palm/
// driftwood InstancedMeshes; world.addWater adds the sea plane — all onto engine.scene.
const result = await buildCottageBeach({ registry, world, source: core.terrain.source });

// Mount the generated region's surface as visible meshes. This is the HOST render path
// for terrain (world.generateRegion builds the heightfield COLLIDER + an inert ECS
// entity; the visible mesh is the host's job). Each tile mesh's vertices coincide with
// the collider surface, so the cottage/props sit exactly on what you see.
for (let tz = BEACH_BOUNDS.minTz; tz <= BEACH_BOUNDS.maxTz; tz++) {
  for (let tx = BEACH_BOUNDS.minTx; tx <= BEACH_BOUNDS.maxTx; tx++) {
    // OPT IN to the SAME island/dune/beach shaping the builder generated the colliders +
    // surveyed the sea level with, so the visible mesh matches the surface the cottage/
    // props/water sit on (without these hints the mesh would be the flat base field and
    // everything would float). beachShapeHints is the single source of truth for both.
    const tile = core.terrain.source.generateTile({ seed: BEACH_SEED, tx, tz, lod: 0, hints: beachShapeHints(BEACH_BOUNDS) });
    // Render-only tropical shoreline: a wet band + an animated foam line right where the
    // sand crosses the sea level (ground-truth from the sand's own height — no depth buffer).
    const mesh = buildTerrainMesh(tile, {
      color: MATERIALS.sand.color,
      roughness: MATERIALS.sand.roughness,
      shoreline: { seaLevel: result.seaLevel },
    });
    engine.scene.add(mesh);
  }
}

// Frame the beach for a HERO shot: orbit the cottage just above the waterline, with a
// LOW, grazing camera so the eye runs across the sea (the grazing angle is where the
// tropical water deepens, reflects the warm sky, and meets the bright foam line at the
// sand). Lower + a touch closer than a plain top-down orbit → a flattering postcard.
const cx = result.cottage.position[0];
const cz = result.cottage.position[2];
const cy = result.seaLevel + 1.2; // look at the shoreline band, not the dune tops
const orbitRadius = (Math.max(BEACH_BOUNDS.maxTx - BEACH_BOUNDS.minTx, BEACH_BOUNDS.maxTz - BEACH_BOUNDS.minTz) + 1) * TILE_SIZE * 1.05;

let angle = 0;
const axes = new Float32Array(3);
function render(_alpha: number): void {
  ops.op_input_axes(axes);
  angle += 0.0035 + axes[0] * 0.03;
  const r = orbitRadius * (1 - axes[2] * 0.15);
  // Low slung (≈0.28·radius above the water) so the shot grazes the sea; ↑/↓ still tilts.
  const h = cy + orbitRadius * 0.28 + axes[1] * 4;
  engine.camera.position.set(cx + Math.cos(angle) * r, h, cz + Math.sin(angle) * r);
  engine.camera.lookAt(cx, cy, cz);
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

ops.op_set_frame_callback(render);
ops.op_set_resize_callback(onResize);
ops.op_log(
  `cottage_beach ready: region ${result.regionId}, seaLevel=${result.seaLevel.toFixed(2)} ` +
  `(surface ${result.surface.minY.toFixed(2)}..${result.surface.maxY.toFixed(2)}), ` +
  `cottage @ [${result.cottage.position.map((n) => n.toFixed(1)).join(", ")}] (${result.cottage.assetId}), ` +
  `${result.scatter.instances} palm/driftwood instances — all asset-placed, zero hand-authored geometry. ` +
  `Swap the curated CC0 beach pack in via the ASSET-ID constants in cottage_beach.ts.`,
);
