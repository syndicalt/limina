// Phase 11 UAT — the seedable TERRAIN-TYPE catalog, LIVE for the eye.
//
// Run: ./target/release/limina --window js/src/demos/terrain_types_window.ts
//   (frame-capped: ./target/release/limina --window --frames 1200 js/src/demos/terrain_types_window.ts)
//
// Lays out EVERY terrain type from the catalog (terrain-types.ts) side by side, each its own
// procedurally generated region at the SAME seed, so you can directly compare them: the tall,
// sharp, snow-pale MOUNTAINS next to the near-flat PLAINS, the dune-ridged DESERT, the rolling
// green FOREST, the sand ISLAND/BEACH rising from the sea floor. This is the LOOK behind the
// headless gate (js/test/p11_terrain_types.ts): same generator, one knob — the type name.
//
// The agent-native point: nothing here is hand-modeled. Each strip is `world.generateRegion`
// fed a TYPE; the deterministic generator builds the surface. Camera auto-orbits the row; the
// arrow keys nudge the orbit (←/→ spin, ↑/↓ height, in/out zoom) for a closer look.

import { ops } from "../engine.ts";
import { createWindowedContext } from "../game/index.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { TILE_SIZE, HEIGHT_SCALE } from "../terrain/procedural.ts";
import { TERRAIN_TYPE_NAMES, type TerrainTypeName } from "../terrain/terrain-types.ts";
import { MATERIALS } from "../materials/palette.ts";
import { buildPostPipeline } from "../render/post.ts";

const SEED = 1234;
const BLOCK = 3; // tiles between each type's 2×2 region (a visible gap)

// A representative albedo per type (purely cosmetic — the SHAPE is the generator's, not ours).
const TYPE_COLOR: Record<TerrainTypeName, number> = {
  beach: MATERIALS.sand.color,
  mountains: 0xbfc4cc,   // pale alpine rock/snow
  forest: MATERIALS.foliage.color,
  desert: 0xd9b06a,      // warm dune tan
  plains: MATERIALS.grass.color,
  hills: 0x7a9a4e,       // duller upland green
  islands: MATERIALS.sand.color,
};

// Disable the baseline's flat ground plane: the generated terrain IS the ground here, and the
// default 80 m ground only underlies the first strip — a dark slab that reads as broken water.
// (Each type's surface is its own region; the strips compare SHAPE, so no shared base.)
const ctx = await createWindowedContext({ width: 1280, height: 720, renderBaseline: { ground: { enabled: false } }, session: "ses_terrain_types_window", agentId: "agt_types_window" });
const engine = ctx.engine!;
const registry = ctx.registry;
const base = ctx.base;

ops.op_physics_create_world(-9.81);

// Build one region per type along +X and mount its surface meshes.
let stripMinX = Infinity, stripMaxX = -Infinity;
for (let i = 0; i < TERRAIN_TYPE_NAMES.length; i++) {
  const type = TERRAIN_TYPE_NAMES[i];
  const bounds = { minTx: i * BLOCK, minTz: 0, maxTx: i * BLOCK + 1, maxTz: 1 };
  // Generate the COLLIDERS + the VISIBLE flat-colour surface via the agent-facing skill
  // (the AUTO-SURFACE): one call per type, vertices coinciding with the collider. A
  // representative per-type albedo (TYPE_COLOR) keeps the strips visually distinct.
  const gen = await registry.invoke("world.generateRegion", {
    seed: SEED, bounds, lod: 0, type,
    surface: { mode: "flat", color: TYPE_COLOR[type], roughness: 0.9 },
  }, base);
  const regionId = (gen.result as { regionId: string }).regionId;
  // POPULATE the type with its biome content (pines on mountains, cacti in desert,
  // broadleaf/pine in forest, grass on plains, palms on the beach) — the agent-native
  // world.populateBiome SKILL surveys the region + runs asset.scatter per layer, mounting
  // curated CC0 InstancedMeshes onto the surface. Each strip is a lived-in world.
  const pop = await registry.invoke("world.populateBiome", { regionId, type }, base);
  if (!pop.success) throw new Error("world.populateBiome failed: " + JSON.stringify(pop.error));
  stripMinX = Math.min(stripMinX, bounds.minTx * TILE_SIZE);
  stripMaxX = Math.max(stripMaxX, (bounds.maxTx + 1) * TILE_SIZE);
}

// FREE-FLY camera (for recording a walkthrough of the type row).
//   move : W/S forward·back · A/D strafe · Q/E up·down   (op_input_axes)
//   look : move the mouse — CLICK the window to capture it; ESCAPE releases.  (op_input_look)
// Movement is relative to where you look (fly-cam); Q/E is always world-up/down.
const cx = (stripMinX + stripMaxX) / 2;
const cz = TILE_SIZE; // mid-depth of the 2-tile-deep strips
const cy = HEIGHT_SCALE * 0.5;
const rowSpan = stripMaxX - stripMinX;

// The default far-plane (200 m) clips this ~960 m row; widen it generously so free-fly can roam.
engine.camera.near = 0.5;
engine.camera.far = rowSpan * 4;
engine.camera.updateProjectionMatrix();

// Start above + south (+Z) of the row, looking back across it and slightly down.
const pos = { x: cx, y: cy + 170, z: cz + 340 };
let yaw = 0;        // 0 → facing -Z (toward the row); yaw about world-up
let pitch = -0.45;  // looking down ~26°
const MOVE_SPEED = 85;     // m/s
const LOOK_SENS = 0.0022;  // radians per raw mouse unit
const PITCH_LIMIT = Math.PI / 2 - 0.03;
const DT = 1 / 60;

// PRESENTATION. By DEFAULT, the bare known-good path (`renderer.render` →
// `op_surface_present`) so free-fly navigation is LIVE. The Phase-3 post stack —
// real depth+normal pre-pass → GTAO (nestles each strip's biome props into its
// surface) → high-threshold bloom → gentle HDR grade over ACES — is gated behind
// USE_POST: on this WebGPU windowed backend the composite does not reliably present
// a fresh frame per move (the view can stick while the camera moves), so it is OPT-IN
// for static / cinematic shots. The scene LOOK is scene/material — unaffected by this
// toggle. Flip to true to A/B the post stack. Render-only either way.
const USE_POST = false;
const post = USE_POST ? buildPostPipeline(engine.renderer, engine.scene, engine.camera) : null;

const axes = new Float32Array(3);
const look = new Float32Array(2);
function render(_alpha: number): void {
  ops.op_input_axes(axes); // [0]=A/D strafe, [1]=Q/E up, [2]=S/W forward
  ops.op_input_look(look); // [0]=mouse dx, [1]=mouse dy (raw, drained per frame)

  yaw += look[0] * LOOK_SENS;   // mouse right → turn right
  pitch -= look[1] * LOOK_SENS; // mouse up → look up
  if (pitch > PITCH_LIMIT) pitch = PITCH_LIMIT;
  if (pitch < -PITCH_LIMIT) pitch = -PITCH_LIMIT;

  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const sy = Math.sin(yaw), cyaw = Math.cos(yaw);
  // forward (yaw=0 → -Z, pitch tilts y); right (yaw=0 → +X), both on the horizontal for strafe.
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
  `terrain_types ready: ${TERRAIN_TYPE_NAMES.length} seedable types side by side — ${TERRAIN_TYPE_NAMES.join(", ")} — ` +
  `all at seed ${SEED}, each built by world.generateRegion type:NAME (auto-surface) + POPULATED with its biome content via ` +
  `world.populateBiome (palms on the beach, pines on the mountains, cacti in the desert, broadleaf/pine forest, grass plains) — ` +
  `zero hand-authored geometry, all curated CC0 assets by id. FREE-FLY: click to capture the mouse, ` +
  `WASD to move, Q/E up·down, mouse to look, Escape to release.`,
);
