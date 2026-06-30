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

import { ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { createWindowedContext } from "../game/index.ts";
import { TILE_SIZE } from "../terrain/procedural.ts";
import { TROPICAL_BEACH_BASELINE } from "../render-baseline.ts";
import { buildPostPipeline } from "../render/post.ts";
import { buildCottageBeach, BEACH_BOUNDS } from "./cottage_beach.ts";

// Opt into the NAMED warm "golden-hour tropical beach" baseline (warm sun + tropical
// sky IBL + lifted exposure) — additive, it never changes the global default. The
// terrain IS the ground here, so suppress the baseline's flat ground plane (it would
// clip through the beach) while keeping the warm sun/IBL/tonemapping/sky.
const ctx = await createWindowedContext({
  width: 1120,
  height: 720,
  renderBaseline: { ...TROPICAL_BEACH_BASELINE, ground: { ...TROPICAL_BEACH_BASELINE.ground, enabled: false } },
  session: "ses_cottage_beach_window",
});
const engine = ctx.engine!;
const registry = ctx.registry;
const core = ctx.core;
const world = ctx.world;

ops.op_physics_create_world(-9.81);

// Assemble the beach from intent-level skills (the SAME builder the headless test
// drives). asset.place adds the cottage GLTF root; asset.scatter mounts the palm/
// driftwood InstancedMeshes; world.addWater adds the sea plane — all onto engine.scene.
// buildCottageBeach now builds the VISIBLE sand surface itself via the AUTO-SURFACE
// (world.generateRegion `surface:{mode:"shoreline"}`) — the tropical wet/foam shoreline band
// right where the sand crosses the sea level. The cottage GLTF, the palm/driftwood
// InstancedMeshes (asset.scatter), and the sea plane (world.addWater) are added onto
// engine.scene by the builder's skills. No hand-rolled terrain mesh loop here anymore.
const result = await buildCottageBeach({ registry, world, source: core.terrain.source });

// Frame the beach for a HERO shot: orbit the cottage just above the waterline, with a
// LOW, grazing camera so the eye runs across the sea (the grazing angle is where the
// tropical water deepens, reflects the warm sky, and meets the bright foam line at the
// sand). Lower + a touch closer than a plain top-down orbit → a flattering postcard.
const cx = result.cottage.position[0];
const cz = result.cottage.position[2];
const cy = result.seaLevel + 1.2; // look at the shoreline band, not the dune tops
const orbitRadius = (Math.max(BEACH_BOUNDS.maxTx - BEACH_BOUNDS.minTx, BEACH_BOUNDS.maxTz - BEACH_BOUNDS.minTz) + 1) * TILE_SIZE * 1.05;

// PRESENTATION. By DEFAULT, the bare known-good path (`renderer.render` →
// `op_surface_present`) so the auto-orbit (and ↑/↓·in/out nudges) stay LIVE. The
// Phase-3 post stack — real depth+normal pre-pass → GTAO (settles the cottage/palms/
// driftwood onto the sand with contact AO) → high-threshold bloom (warm sky + foam/
// water glints) → gentle HDR grade over the warm ACES baseline — is gated behind
// USE_POST: on this WebGPU windowed backend the composite does not reliably present a
// fresh frame per move (the view can stick while the camera orbits), so it is OPT-IN
// for static / cinematic shots. The scene LOOK is scene/material — unaffected by this
// toggle. Flip to true to A/B the post stack. Render-only either way.
const USE_POST = false;
const post = USE_POST ? buildPostPipeline(engine.renderer, engine.scene, engine.camera) : null;

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

// Warm-up render before registering callbacks (compile WebGPU pipelines while the
// loop is uncontended; otherwise the surface can stay blank — see playable_world_window).
render(0);
ops.op_set_frame_callback(render);
ops.op_set_resize_callback(onResize);
ops.op_log(
  `cottage_beach ready: region ${result.regionId}, seaLevel=${result.seaLevel.toFixed(2)} ` +
  `(surface ${result.surface.minY.toFixed(2)}..${result.surface.maxY.toFixed(2)}), ` +
  `cottage @ [${result.cottage.position.map((n) => n.toFixed(1)).join(", ")}] (${result.cottage.assetId}), ` +
  `${result.scatter.instances} palm/driftwood instances — all asset-placed, zero hand-authored geometry. ` +
  `Swap the curated CC0 beach pack in via the ASSET-ID constants in cottage_beach.ts.`,
);
