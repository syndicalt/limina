// LANDSCAPE SHOWCASE — the ELEVATION + BIOME colour ramp, LIVE, with NO GPU model.
//
// Run: ./target/release/limina --window js/src/demos/world_showcase.ts
//   (frame-capped: ./target/release/limina --window --frames 1200 js/src/demos/world_showcase.ts)
//
// This is the UAT for the terrain colour ramp WITHOUT the flaky terrain-diffusion model: a
// high-relief procedural MOUNTAINS region (with hydraulic/thermal EROSION on) shaded by the
// opt-in elevation+biome ramp (terrain/render.ts), flooded by a sea-level water plane, and
// populated with biome content (pines below the tree-line, boulders on the high flanks) — all
// through the SAME deterministic agent-native seam the model demo uses, so what you see here
// is exactly what the ramp does to the model's DEM, minus the HTTP model dependency.
//
// What you should see: a sandy shoreline just above the water, green forested lower slopes
// (drying to grass where precip is low), bare grey rock on the steep upper flanks, white snow
// on the cold crests, and a dark silt tint where the land dips under the sea — blended smoothly
// (no hard stripes), with the biome varying spatially across the surface from the baked climate.

import * as THREE from "../../build/three.bundle.mjs";
import { createEngine, ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { LiminaTracer } from "../observability/event.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { TILE_SIZE } from "../terrain/procedural.ts";
import { terrainTypeHints, type TerrainTypeName } from "../terrain/terrain-types.ts";
import { surveyRegionRelief } from "../terrain/biome-content.ts";
import { MATERIALS } from "../materials/palette.ts";
import { DEFAULT_RENDER_BASELINE } from "../render-baseline.ts";
import { buildPostPipeline } from "../render/post.ts";

const SEED = 1234;
const TYPE: TerrainTypeName = "mountains";
// A/B the terrain SURFACE: "pbr" = the opt-in procedural-PBR material (triplanar layers + detail
// normals + honest roughness — "Grounded Stylized Realism"); "ramp" = the flat elevation+biome
// ramp it's compared against. Same bands either way; only the surface detail changes.
const SURFACE: "pbr" | "ramp" = "pbr";
// A 4×4 tile region (16 heightfield tiles ≈ 192 m square) — a varied vista that fits inside
// one erosion macro-block, so the eroded seams are bit-exact and the bake is cheap.
const BOUNDS = { minTx: 0, minTz: 0, maxTx: 3, maxTz: 3 } as const;
// The sea floods the low ~18 % of the relief, so valleys read as water + sandy shore and the
// peaks tower dry above — the full ramp range in one shot.
const SEA_FRACTION = 0.18;
// DRAMATIC RELIEF: override the mountains amplitude well above the type default (2.4) so a tall
// summit rises over a green base — the elevation gradient needs real vertical range to read.
// Deterministic (a plain hint, recorded verbatim); the colliders/mesh/props all use it.
const AMP = 4.5;
// Dry margin (m) above the water line for scattered props, so nothing stands at the shoreline:
// raised from 1.0 so trees/boulders sit CLEARLY above the waterline (no props at the lake/coast
// edge). The waterGated layers resolve elevationMin = waterLevel + this margin against the eroded
// surface, so every layer's spawn mask shares one dry buffer.
const WATER_MARGIN = 2.5;

// COASTAL / ISLAND FALLOFF — taper the region boundary BELOW sea level so the finite 4×4 grid's
// raw SCENE-TERMINATION wall (the vertical edge where the demo grid abruptly ends — an untextured
// single-grid artifact, NOT a real sea cliff) sinks underwater and the coast reads as a clean
// island. The relief rises in the CENTRE and slopes radially down to the sea floor at the edges.
// Mirrors the island math in terrainTypeHints (mountains has no built-in island, so we compose it
// here): a dramatic core (radius ≈ 0.40 of the half-extent) tapering over a long beach (falloff ≈
// 0.62). Natural cliffs the erosion carves WITHIN the terrain are unaffected (and now texture-
// terminated at the waterline by the PBR wet-shore band).
const HALF_EXTENT = (Math.min(BOUNDS.maxTx - BOUNDS.minTx, BOUNDS.maxTz - BOUNDS.minTz) + 1) * TILE_SIZE / 2;
const ISLAND = {
  islandCx: ((BOUNDS.minTx + BOUNDS.maxTx + 1) / 2) * TILE_SIZE,
  islandCz: ((BOUNDS.minTz + BOUNDS.maxTz + 1) / 2) * TILE_SIZE,
  islandRadius: HALF_EXTENT * 0.40,
  islandFalloff: HALF_EXTENT * 0.62,
};
// The shaping OVERRIDES on top of the mountains type: dramatic amplitude, hydraulic/thermal EROSION
// (`erode`), and the coastal falloff. This SAME object is recorded into the region's hints
// (world.generateRegion below), so the colliders, the relief survey, the scatter spawn mask, the
// water depth bake, and the visible mesh all read the identical shaped+eroded surface (the
// region-hints survey path — one config, no test/demo divergence).
const SHAPE = { amp: AMP, erode: 1, ...ISLAND };

// The full shaping recipe = the mountains type's knobs + SHAPE. Used for the visible mesh + the
// demo's relief/sea-level survey; it equals the region's stored hints so every read matches the
// eroded tiles bit-for-bit.
const HINTS = { ...terrainTypeHints(TYPE, BOUNDS), ...SHAPE };

// Default render baseline (key sun + hemisphere fill + procedural-sky IBL + tonemapping); the
// generated terrain IS the ground, so suppress the baseline's flat ground plane.
//
// ATMOSPHERE (Phase-2 terrain overhaul): this is the SHOWCASE for the opt-in HEIGHT-FALLOFF
// haze — the island reads as VAST because the haze pools in the low ground (the sea + the far
// shore dissolve into the horizon band) while the summit stays crisp above the haze ceiling.
// The ceiling is set from the surveyed relief AFTER the region is generated (see below), so it
// tracks the real peak height; here we just enable the model + tune the density. The haze colour
// auto-matches sky.horizon (0xcdd9e6) so the terrain edge melts into the sky with no hard band.
const engine = await createEngine({
  width: 1280,
  height: 720,
  renderBaseline: {
    ground: { enabled: false },
    atmosphere: { height: { enabled: true, density: 0.00055 } },
  },
});

const tracer = new LiminaTracer("ses_world_showcase");
const registry = new SkillRegistry(tracer);
const core = registerCoreSkills(registry);

const world: WorldContext = {
  ecs: engine.world, entities: engine.entities, tags: engine.tags,
  transforms: engine.transforms, spatial: engine.spatial, scene: engine.scene,
  camera: engine.camera, renderer: engine.renderer, ops: engine.ops,
  width: engine.width, height: engine.height, mode: engine.mode,
};
const base = { agentId: "agt_landscape", sessionId: "ses_world_showcase", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

ops.op_physics_create_world(-9.81);

// Survey the eroded surface (SAME hints) → relief + sea level, BEFORE generating, so the
// auto-surface (world.generateRegion `surface`) builds the visible PBR mesh with the EXACT
// band the demo used to build by hand — byte-identical look, no double mesh.
const relief = surveyRegionRelief(core.terrain.source, SEED, BOUNDS, HINTS);
const seaLevel = relief.minY + SEA_FRACTION * (relief.maxY - relief.minY);

// 1. THE GROUND + SURFACE — generate the eroded mountains region (heightfield colliders +
//    region handle) AND, in the SAME skill call, the VISIBLE procedural-PBR terrain surface
//    (the AUTO-SURFACE). Each tile mesh's vertices coincide with the collider; the WET-SHORE
//    band texture-terminates the waterline (darker/glossier contact + a thin foam line).
//    Render-only; the surface recipe is recorded with the request and rebuilt on replay.
const gen = await registry.invoke("world.generateRegion", {
  seed: SEED, bounds: BOUNDS, lod: 0, type: TYPE, hints: SHAPE,
  surface: SURFACE === "pbr"
    ? { mode: "pbr", roughness: 0.95, seaLevel, minY: relief.minY, maxY: relief.maxY, waterline: { wetBand: 1.4, foam: 0.5 } }
    : { mode: "palette", roughness: 0.95, seaLevel, minY: relief.minY, maxY: relief.maxY },
}, base);
if (!gen.success) throw new Error("world.generateRegion failed: " + JSON.stringify(gen.error));
const regionId = (gen.result as { regionId: string }).regionId;

// ATMOSPHERE ceiling — now that the real relief is surveyed, retune the height-falloff haze so
// its ceiling sits just under the summit: the sea + low forested base + far shore pool in the
// haze (dissolving into the horizon), while the bare rock + snow crest rise crisp ABOVE it.
// Render-only; rebuilds the node fog the baseline installed (same colour = sky.horizon).
{
  const T = (THREE as unknown as { TSL: Record<string, (...a: unknown[]) => unknown> }).TSL;
  const ceiling = seaLevel + (relief.maxY - seaLevel) * 0.85;
  const factor = T.exponentialHeightFogFactor(T.float(0.00055), T.float(ceiling));
  (engine.scene as { fogNode?: unknown }).fogNode = T.fog(T.color(DEFAULT_RENDER_BASELINE.sky.horizon), factor);
  ops.op_log(`atmosphere: height-falloff haze, ceiling ${ceiling.toFixed(1)} m (peak ${relief.maxY.toFixed(1)} m), tinted to sky horizon`);
}

// 2. THE SEA — a render-only water plane at sea level, region-aware depth shading. It bakes the
//    depth field from the SAME terrain source/type AND the SAME shaping hints (SHAPE: amp/erode/
//    island falloff), so the shoreline depth-fade reads against the real tapered island coast,
//    sized to cover the region.
const span = (BOUNDS.maxTx - BOUNDS.minTx + 1) * TILE_SIZE;
const waterRes = await registry.invoke("world.addWater", {
  level: seaLevel, color: MATERIALS.water.color, size: span * 3,
  region: { seed: SEED, type: TYPE, bounds: BOUNDS, hints: SHAPE },
}, base);
if (!waterRes.success) throw new Error("world.addWater failed: " + JSON.stringify(waterRes.error));

// 3. THE SURFACE is built by the AUTO-SURFACE above (world.generateRegion `surface`) — the
//    ELEVATION + BIOME PBR ramp: sandy coast → green/dry lowland by precip → grey-brown rock
//    mountainside → white snow PEAK → dark silt below the sea, with the wet-shore waterline.

// 4. THE CONTENT — pines below the tree-line + boulders on the high flanks, scattered via the
//    deterministic world.populateBiome SKILL (gated by the region's surveyed relief; pass the
//    water level so nothing places at/below the shoreline). It surveys the region with the
//    hints it was generated with, resolves the mountains content layers, and drives asset.scatter.
const popRes = await registry.invoke("world.populateBiome", {
  regionId, type: TYPE, waterLevel: seaLevel, waterMargin: WATER_MARGIN,
}, base);
if (!popRes.success) throw new Error("world.populateBiome failed: " + JSON.stringify(popRes.error));
const scattered = popRes.result as { instances: number };

// FREE-FLY camera framed low across the landscape (a flattering grazing vista).
const cx = ((BOUNDS.minTx + BOUNDS.maxTx + 1) / 2) * TILE_SIZE;
const cz = ((BOUNDS.minTz + BOUNDS.maxTz + 1) / 2) * TILE_SIZE;
const cy = seaLevel + (relief.maxY - seaLevel) * 0.45;

engine.camera.near = 0.5;
engine.camera.far = span * 6;
engine.camera.updateProjectionMatrix();

const pos = { x: cx, y: cy + span * 0.35, z: cz + span * 0.95 };
let yaw = 0;        // 0 → facing -Z; yaw about world-up
let pitch = -0.35;  // looking gently down
const MOVE_SPEED = Math.max(40, span * 0.5); // m/s — scaled to the region
const LOOK_SENS = 0.0022;
const PITCH_LIMIT = Math.PI / 2 - 0.03;
const DT = 1 / 60;

// PRESENTATION. By DEFAULT, the bare known-good path (`renderer.render` →
// `op_surface_present`) so free-fly navigation is LIVE. The Phase-3 post stack —
// real depth+normal pre-pass → GTAO (subtle contact AO nestling the pines/boulders
// into the slopes) → high-threshold bloom (snow crest + sun-glints) → gentle HDR
// grade over ACES — is gated behind USE_POST: on this WebGPU windowed backend the
// composite does not reliably present a fresh frame per move (the view can stick
// while the camera moves), so it is OPT-IN for static / cinematic shots. The scene
// LOOK (PBR terrain, atmosphere/fog, water, scatter) is scene/material — unaffected
// by this toggle. Flip to true to A/B the post stack. Render-only either way.
const USE_POST = false;
const post = USE_POST ? buildPostPipeline(engine.renderer, engine.scene, engine.camera) : null;

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
  `landscape ready: eroded ${TYPE} region ${regionId} (relief ${relief.minY.toFixed(1)}..${relief.maxY.toFixed(1)} m), ` +
  `ELEVATION+BIOME colour ramp over the baked climate, sea at ${seaLevel.toFixed(1)} m, ` +
  `${scattered.instances} biome props — all deterministic + opt-in, zero hand-authored geometry. ` +
  `FREE-FLY: click to capture the mouse, WASD to move, Q/E up·down, mouse to look, Escape to release.`,
);
