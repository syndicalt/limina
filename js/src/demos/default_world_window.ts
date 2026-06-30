// DEFAULT-WORLD SHOWCASE — the WHOLE textured world in THREE skill calls.
//
// Run: ./target/release/limina --window js/src/demos/default_world_window.ts
//   (frame-capped: ./target/release/limina --window --frames 1200 js/src/demos/default_world_window.ts)
//
// This is the proof of the default-render skill library: everything an AGENT-BUILDER writes to get
// a gorgeous, populated, lit landscape is the three `registry.invoke(...)` calls in THE WORLD block
// below — no hand-rolled mesh loop, no manual relief survey, no scatter config, zero hand-authored
// geometry. `createEngine` applies the lighting/IBL/atmosphere/tonemapping baseline automatically;
// `world.generateRegion` builds the colliders AND the procedural-PBR terrain surface (auto-surface);
// `world.addWater` floods it with depth-aware water; `world.populateBiome` drops biome-correct props.
// The rest of this file is just a free-fly CAMERA so you can look around.

import { ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { createWindowedContext } from "../game/index.ts";
import { TILE_SIZE } from "../terrain/procedural.ts";
import { terrainTypeHints, type TerrainTypeName } from "../terrain/terrain-types.ts";
import { MATERIALS } from "../materials/palette.ts";

const SEED = 1234;
const TYPE: TerrainTypeName = "mountains";
const BOUNDS = { minTx: 0, minTz: 0, maxTx: 3, maxTz: 3 } as const;

// Shape the region into a dramatic ISLAND: tall eroded amplitude + a coastal falloff so the finite
// grid tapers under the sea (a clean island, not a clipped slab). A plain recorded hint object.
const HALF_EXTENT = (Math.min(BOUNDS.maxTx - BOUNDS.minTx, BOUNDS.maxTz - BOUNDS.minTz) + 1) * TILE_SIZE / 2;
const HINTS = {
  ...terrainTypeHints(TYPE, BOUNDS),
  amp: 4.5,
  erode: 1,
  islandCx: ((BOUNDS.minTx + BOUNDS.maxTx + 1) / 2) * TILE_SIZE,
  islandCz: ((BOUNDS.minTz + BOUNDS.maxTz + 1) / 2) * TILE_SIZE,
  islandRadius: HALF_EXTENT * 0.40,
  islandFalloff: HALF_EXTENT * 0.62,
};

// The engine + skill registry. The render BASELINE (sun + hemisphere fill + procedural-sky IBL +
// atmosphere/fog + ACES tonemapping) is applied automatically; we only suppress the flat ground
// plane because the generated terrain IS the ground.
const ctx = await createWindowedContext({ width: 1280, height: 720, renderBaseline: { ground: { enabled: false } }, session: "ses_default_world", agentId: "agt_default_world" });
const engine = ctx.engine!;
const registry = ctx.registry;
const world = ctx.world;
const base = ctx.base;

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE WORLD — everything below is THREE skill calls. This is the entire OOB authoring surface.
// ════════════════════════════════════════════════════════════════════════════════════════════════
ops.op_physics_create_world(-9.81);

// 1. GROUND + SURFACE: colliders AND the visible procedural-PBR terrain mesh (the auto-surface).
//    `seaFraction` floods the low 18 % of the relief; the skill returns the resolved sea level +
//    relief so we don't have to survey anything ourselves.
const gen = await registry.invoke("world.generateRegion", {
  seed: SEED, bounds: BOUNDS, lod: 0, type: TYPE, hints: HINTS,
  surface: { mode: "pbr", seaFraction: 0.18, waterline: { wetBand: 1.4, foam: 0.5 } },
}, base);
if (!gen.success) throw new Error("world.generateRegion failed: " + JSON.stringify(gen.error));
const { regionId, seaLevel, relief } = gen.result as { regionId: string; seaLevel: number; relief: { minY: number; maxY: number } };

// 2. SEA: a depth-aware water plane at the resolved sea level (turquoise shallows → deep blue).
const span = (BOUNDS.maxTx - BOUNDS.minTx + 1) * TILE_SIZE;
await registry.invoke("world.addWater", {
  level: seaLevel, color: MATERIALS.water.color, size: span * 3,
  region: { seed: SEED, type: TYPE, bounds: BOUNDS, hints: HINTS },
}, base);

// 3. CONTENT: biome-correct scatter — pines below the tree-line, boulders on the high flanks,
//    nothing at/below the shoreline. One call; the skill surveys + gates + places.
const pop = await registry.invoke("world.populateBiome", {
  regionId, type: TYPE, waterLevel: seaLevel, waterMargin: 2.5,
}, base);
if (!pop.success) throw new Error("world.populateBiome failed: " + JSON.stringify(pop.error));
const props = (pop.result as { instances: number }).instances;
// ════════════════════════════════════════════════════════════════════════════════════════════════
// That's the whole world. Everything below is just a free-fly camera to look at it.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const cx = ((BOUNDS.minTx + BOUNDS.maxTx + 1) / 2) * TILE_SIZE;
const cz = ((BOUNDS.minTz + BOUNDS.maxTz + 1) / 2) * TILE_SIZE;
const cy = seaLevel + (relief.maxY - seaLevel) * 0.45;
engine.camera.near = 0.5;
engine.camera.far = span * 6;
engine.camera.updateProjectionMatrix();

const pos = { x: cx, y: cy + span * 0.35, z: cz + span * 0.95 };
let yaw = 0;
let pitch = -0.35;
const MOVE_SPEED = Math.max(40, span * 0.5);
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
  `default-world ready: ${TYPE} island (relief ${relief.minY.toFixed(1)}..${relief.maxY.toFixed(1)} m, ` +
  `sea ${seaLevel.toFixed(1)} m), ${props} biome props — built from THREE skill calls (generateRegion ` +
  `auto-surface + addWater + populateBiome), zero hand-authored geometry. ` +
  `FREE-FLY: click to capture the mouse, WASD to move, Q/E up·down, mouse to look, Escape to release.`,
);
