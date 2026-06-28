// LANDSCAPE SHOWCASE — the ELEVATION + BIOME colour ramp, LIVE, with NO GPU model.
//
// Run: ./target/release/limina --window js/src/demos/landscape_window.ts
//   (frame-capped: ./target/release/limina --window --frames 1200 js/src/demos/landscape_window.ts)
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
// Dry margin (m) above the water line for scattered props, so nothing stands in the lakes.
const WATER_MARGIN = 1.0;

// The shaping recipe = the mountains type's knobs, with the amplitude bumped for drama, PLUS
// hydraulic/thermal erosion (the `erode` hint). Passed to world.generateRegion (the colliders +
// region the scatter binds to) and to the visible mesh + relief survey, so every read matches
// the eroded tiles bit-for-bit.
const HINTS = { ...terrainTypeHints(TYPE, BOUNDS), amp: AMP, erode: 1 };

// Default render baseline (key sun + hemisphere fill + procedural-sky IBL + tonemapping); the
// generated terrain IS the ground, so suppress the baseline's flat ground plane.
const engine = await createEngine({ width: 1280, height: 720, renderBaseline: { ground: { enabled: false } } });

const tracer = new LiminaTracer("ses_landscape_window");
const registry = new SkillRegistry(tracer);
const core = registerCoreSkills(registry);

const world: WorldContext = {
  ecs: engine.world, entities: engine.entities, tags: engine.tags,
  transforms: engine.transforms, spatial: engine.spatial, scene: engine.scene,
  camera: engine.camera, renderer: engine.renderer, ops: engine.ops,
  width: engine.width, height: engine.height, mode: engine.mode,
};
const base = { agentId: "agt_landscape", sessionId: "ses_landscape_window", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

ops.op_physics_create_world(-9.81);

// 1. THE GROUND — generate the eroded mountains region (heightfield colliders + region handle).
const gen = await registry.invoke("world.generateRegion", { seed: SEED, bounds: BOUNDS, lod: 0, type: TYPE, hints: { amp: AMP, erode: 1 } }, base);
if (!gen.success) throw new Error("world.generateRegion failed: " + JSON.stringify(gen.error));
const regionId = (gen.result as { regionId: string }).regionId;

// Survey the eroded surface (SAME hints) → relief + sea level.
const relief = surveyRegionRelief(core.terrain.source, SEED, BOUNDS, HINTS);
const seaLevel = relief.minY + SEA_FRACTION * (relief.maxY - relief.minY);

// 2. THE SEA — a render-only water plane at sea level, region-aware depth shading (it bakes
//    the depth field from the SAME terrain source/type), sized to cover the region.
const span = (BOUNDS.maxTx - BOUNDS.minTx + 1) * TILE_SIZE;
const waterRes = await registry.invoke("world.addWater", {
  level: seaLevel, color: MATERIALS.water.color, size: span * 3,
  region: { seed: SEED, type: TYPE, bounds: BOUNDS },
}, base);
if (!waterRes.success) throw new Error("world.addWater failed: " + JSON.stringify(waterRes.error));

// 3. THE SURFACE — mount each tile with the ELEVATION + BIOME ramp: a stark elevation gradient
//    (sandy coast → green/dry lowland by precip → grey-brown rock mountainside → white snow
//    PEAK → dark silt below the sea), elevation-primary with the baked climate only modulating.
//    Built with the SAME eroded hints so the visible mesh coincides with the colliders.
for (let tz = BOUNDS.minTz; tz <= BOUNDS.maxTz; tz++) {
  for (let tx = BOUNDS.minTx; tx <= BOUNDS.maxTx; tx++) {
    const tile = core.terrain.source.generateTile({ seed: SEED, tx, tz, lod: 0, hints: HINTS });
    const band = { seaLevel, minY: relief.minY, maxY: relief.maxY };
    const mesh = buildTerrainMesh(tile, SURFACE === "pbr"
      ? { roughness: 0.95, pbr: band }
      : { roughness: 0.95, palette: band });
    engine.scene.add(mesh);
  }
}

// 4. THE CONTENT — pines below the tree-line + boulders on the high flanks, scattered via the
//    deterministic biome-content seam (gated by the region's surveyed relief). Pass the water
//    level so the scatter knows the shoreline.
const scattered = await scatterBiomeContent({
  registry, source: core.terrain.source, regionId, type: TYPE, bounds: BOUNDS, seed: SEED, base,
  waterLevel: seaLevel, waterMargin: WATER_MARGIN,
});

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
ops.op_set_frame_callback(render);
ops.op_set_resize_callback(onResize);
ops.op_log(
  `landscape ready: eroded ${TYPE} region ${regionId} (relief ${relief.minY.toFixed(1)}..${relief.maxY.toFixed(1)} m), ` +
  `ELEVATION+BIOME colour ramp over the baked climate, sea at ${seaLevel.toFixed(1)} m, ` +
  `${scattered.instances} biome props — all deterministic + opt-in, zero hand-authored geometry. ` +
  `FREE-FLY: click to capture the mouse, WASD to move, Q/E up·down, mouse to look, Escape to release.`,
);
