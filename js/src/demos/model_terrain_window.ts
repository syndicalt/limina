// S1 UAT — the terrain-diffusion model, LIVE behind limina's terrain seam.
//
// This is the model-backed twin of terrain_types_window.ts: instead of the procedural
// source, it points `world.generateRegion` at `ModelTerrainSource`, which talks to the
// reference SHIM (tools/terrain-diffusion/shim.py) that adapts the real terrain-diffusion
// `/terrain` API to limina's stable `/tile` contract. The surface you fly over is the
// diffusion model's elevation + climate, parsed through the EXACT same seam the headless
// tests cover (p9/p11_model_source) — zero hand-authored geometry.
//
// THIS IS UAT: it needs the model + shim running (no GPU here). Bring them up first:
//   tools/terrain-diffusion/run.sh            # launches terrain-diffusion + the shim
// then (the shim listens on 127.0.0.1:8917 = the ModelTerrainSource default baseUrl):
//   ./target/release/limina --window js/src/demos/model_terrain_window.ts
//   (frame-capped: ./target/release/limina --window --frames 1200 js/src/demos/model_terrain_window.ts)
//
// RESOLUTION: must match the shim's --scale. The shim default (--scale 1) serves the
// model's native 30 m/px, so METERS_PER_PX below is 30. Run the shim with --scale 8 for
// 3.75 m/px detail and set METERS_PER_PX = 30/8 here to keep the geometry consistent.

import { createEngine, ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { LiminaTracer } from "../observability/event.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { buildTerrainMesh } from "../terrain/render.ts";
import { ModelTerrainSource } from "../terrain/model-source.ts";
import { surveyRegionRelief, scatterBiomeContent } from "../terrain/biome-content.ts";

const SEED = 1234;                  // MUST equal the shim's --region-seed (model launch --seed)
const SHIM_URL = "http://127.0.0.1:8917";
const TILE_PX = 256;                // limina tilePx == the shim's --tile
const NATIVE_M_PER_PX = 30;         // terrain-diffusion-30m native (scale 1)
const SHIM_SCALE = 1;               // == the shim's --scale
const METERS_PER_PX = NATIVE_M_PER_PX / SHIM_SCALE; // limina extent = tilePx * this
const ELEV_MIN = -500, ELEV_MAX = 9000;             // fixed normalization window (metres)
const SEA_LEVEL = 0;                                 // real-DEM sea level (0 m) → world Y 0
// Render-only vertical exaggeration of the terrain MESH (geometry only; collider/source
// heights untouched). 1 = off (default). Bump (e.g. 1.5–2) if the 30 m/px relief reads
// too gentle — but keep it 1 when scatter is on, since props sit at TRUE heights.
const VERT_EXAG = 1;
// The terrain TYPE whose biome CONTENT (vegetation layers) is scattered over the model
// region. The model isn't a procedural type, so the type only selects which curated assets
// to place; relief + biome/elevation gating read the MODEL's real surface + climate.
const CONTENT_TYPE = "hills" as const;

// The model source: a drop-in TerrainSource that marshals each tile to the shim over HTTP.
// The shim emits the model's FAITHFUL channel-major climate [temp@0, t_season@1, precip@2,
// p_cv@3], so the source's DEFAULTS (tempChannel 0, precipChannel 2) decode it with NO
// override — it reads temp/precip from those channels and classifies biome itself.
const source = new ModelTerrainSource({
  baseUrl: SHIM_URL,
  tilePx: TILE_PX,
  metersPerPx: METERS_PER_PX,
  elevMinM: ELEV_MIN,
  elevMaxM: ELEV_MAX,
  timeoutMs: 180_000, // the model is slow (cold load + per-tile diffusion); be patient
});

const engine = await createEngine({ width: 1280, height: 720, renderBaseline: { ground: { enabled: false } } });

const tracer = new LiminaTracer("ses_model_terrain_window");
const registry = new SkillRegistry(tracer);
const core = registerCoreSkills(registry, { terrainSource: source });

const world: WorldContext = {
  ecs: engine.world, entities: engine.entities, tags: engine.tags,
  transforms: engine.transforms, spatial: engine.spatial, scene: engine.scene,
  camera: engine.camera, renderer: engine.renderer, ops: engine.ops,
  width: engine.width, height: engine.height, mode: engine.mode,
};
const base = { agentId: "agt_model_terrain", sessionId: "ses_model_terrain_window", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

ops.op_physics_create_world(-9.81);

// Wait for the shim + model to be ready (cold model load can take a while).
ops.op_log("model_terrain: waiting for the shim/model /health …");
await source.waitForReady(60, 2000);
ops.op_log("model_terrain: shim ready — generating region from the diffusion model …");

// A small region (the model is expensive). 2x2 tiles at the configured resolution.
const bounds = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 };
const gen = await registry.invoke("world.generateRegion", { seed: SEED, bounds, lod: 0 }, base);
if (!gen.success) throw new Error("world.generateRegion failed: " + JSON.stringify(gen.error));
const regionId = (gen.result as { regionId: string }).regionId;

// Survey the model region's true world-Y relief (the tiles are cached after generateRegion)
// so the ramp's high/rock/snow bands normalise against the ACTUAL relief, not the −500..9000
// normalization window (which the region rarely fills). The model ignores hints, so {} is fine.
const relief = surveyRegionRelief(source, SEED, bounds, {});

// THE SEA — a render-only water plane at real sea level (0 m). Sized to span the whole
// region so the ocean reads as open water around the landmass (the default 400 plane is far
// too small for a multi-km model region).
const span = (bounds.maxTx - bounds.minTx + 1) * source.extent;
const waterRes = await registry.invoke("world.addWater", { level: SEA_LEVEL, size: span * 3 }, base);
if (!waterRes.success) throw new Error("world.addWater failed: " + JSON.stringify(waterRes.error));

// Mount the model surface tile-by-tile with the ELEVATION + BIOME colour ramp (sandy coast →
// green/dry lowland by precip → grey rock on the high+steep → white snow on the high+cold →
// dark silt below the sea), driven by the model's own climate. generateTile is ASYNC for the
// model source (HTTP); generateRegion already baked + cached these, so each await is a hit.
for (let tz = bounds.minTz; tz <= bounds.maxTz; tz++) {
  for (let tx = bounds.minTx; tx <= bounds.maxTx; tx++) {
    const tile = await source.generateTile({ seed: SEED, tx, tz, lod: 0 });
    const mesh = buildTerrainMesh(tile, {
      roughness: 0.95,
      palette: { seaLevel: SEA_LEVEL, minY: relief.minY, maxY: relief.maxY },
      ...(VERT_EXAG !== 1 ? { exaggerateY: { factor: VERT_EXAG, pivot: SEA_LEVEL } } : {}),
    });
    engine.scene.add(mesh);
  }
}

// POPULATE the model surface with biome content via the SAME agent-native seam the procedural
// worlds use: scatterBiomeContent surveys the region + runs asset.scatter per layer, gated by
// the MODEL's real relief + climate. NOTE: at 30 m/px (shim --scale 1) a 256-px tile spans
// ~7.7 km, so the curated trees/rocks read as specks — run the shim at --scale 8 (3.75 m/px,
// METERS_PER_PX 30/8) to see the vegetation. Count is bounded per tile, so it never blows up.
const scattered = await scatterBiomeContent({
  registry, source, regionId, type: CONTENT_TYPE, bounds, seed: SEED, base,
});

// FREE-FLY camera framed on the generated region (geometry from the source, not procedural).
const extent = source.extent; // world metres per tile edge
const cx = ((bounds.minTx + bounds.maxTx + 1) / 2) * extent;
const cz = ((bounds.minTz + bounds.maxTz + 1) / 2) * extent;
const cy = relief.minY + (relief.maxY - relief.minY) * 0.6;

engine.camera.near = 1;
engine.camera.far = span * 6;
engine.camera.updateProjectionMatrix();

const pos = { x: cx, y: cy + span * 0.5, z: cz + span * 0.9 };
let yaw = 0;        // 0 -> facing -Z; yaw about world-up
let pitch = -0.5;   // looking down
const MOVE_SPEED = Math.max(120, span * 0.25); // m/s — scaled to the region size
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
  `model_terrain ready: ${(bounds.maxTx - bounds.minTx + 1)}x${(bounds.maxTz - bounds.minTz + 1)} tiles from terrain-diffusion ` +
  `via the /tile shim (${SHIM_URL}), seed ${SEED}, ${METERS_PER_PX} m/px — ELEVATION+BIOME colour ramp over the model's ` +
  `climate (relief ${relief.minY.toFixed(0)}..${relief.maxY.toFixed(0)} m), sea at ${SEA_LEVEL} m, ` +
  `${scattered.instances} biome props (${CONTENT_TYPE} layers, model-gated) — ` +
  `FREE-FLY: click to capture the mouse, WASD to move, Q/E up·down, mouse to look, Escape to release.`,
);
