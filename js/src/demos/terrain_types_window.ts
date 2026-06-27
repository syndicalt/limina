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

import { createEngine, ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { LiminaTracer } from "../observability/event.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { buildTerrainMesh } from "../terrain/render.ts";
import { TILE_SIZE, HEIGHT_SCALE } from "../terrain/procedural.ts";
import { TERRAIN_TYPE_NAMES, terrainTypeHints, type TerrainTypeName } from "../terrain/terrain-types.ts";
import { scatterBiomeContent } from "../terrain/biome-content.ts";
import { MATERIALS } from "../materials/palette.ts";

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

const engine = await createEngine({ width: 1280, height: 720 });

const tracer = new LiminaTracer("ses_terrain_types_window");
const registry = new SkillRegistry(tracer);
const core = registerCoreSkills(registry);

const world: WorldContext = {
  ecs: engine.world, entities: engine.entities, tags: engine.tags,
  transforms: engine.transforms, spatial: engine.spatial, scene: engine.scene,
  camera: engine.camera, renderer: engine.renderer, ops: engine.ops,
  width: engine.width, height: engine.height, mode: engine.mode,
};
const base = { agentId: "agt_types_window", sessionId: "ses_terrain_types_window", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

ops.op_physics_create_world(-9.81);

// Build one region per type along +X and mount its surface meshes.
let stripMinX = Infinity, stripMaxX = -Infinity;
for (let i = 0; i < TERRAIN_TYPE_NAMES.length; i++) {
  const type = TERRAIN_TYPE_NAMES[i];
  const bounds = { minTx: i * BLOCK, minTz: 0, maxTx: i * BLOCK + 1, maxTz: 1 };
  const hints = terrainTypeHints(type, bounds);
  // Generate the COLLIDERS via the same agent-facing skill the test drives (type by NAME).
  const gen = await registry.invoke("world.generateRegion", { seed: SEED, bounds, lod: 0, type }, base);
  const regionId = (gen.result as { regionId: string }).regionId;
  // Mount the visible surface (host render path) — vertices coincide with the collider.
  for (let tz = bounds.minTz; tz <= bounds.maxTz; tz++) {
    for (let tx = bounds.minTx; tx <= bounds.maxTx; tx++) {
      const tile = core.terrain.source.generateTile({ seed: SEED, tx, tz, lod: 0, hints });
      const mesh = buildTerrainMesh(tile, { color: TYPE_COLOR[type], roughness: 0.9 });
      engine.scene.add(mesh);
    }
  }
  // POPULATE the type with its biome content (pines on mountains, cacti in desert,
  // broadleaf/pine in forest, grass on plains, palms on the beach) — the SAME agent-native
  // path the gate drives: scatterBiomeContent surveys the region + runs asset.scatter per
  // layer, mounting curated CC0 InstancedMeshes onto the surface. Each strip is a lived-in
  // world, not a bare heightfield.
  await scatterBiomeContent({ registry, source: core.terrain.source, regionId, type, bounds, seed: SEED, base });
  stripMinX = Math.min(stripMinX, bounds.minTx * TILE_SIZE);
  stripMaxX = Math.max(stripMaxX, (bounds.maxTx + 1) * TILE_SIZE);
}

// Frame the whole row.
const cx = (stripMinX + stripMaxX) / 2;
const cz = TILE_SIZE; // mid-depth of the 2-tile-deep strips
const cy = HEIGHT_SCALE * 0.5;
const orbitRadius = (stripMaxX - stripMinX) * 0.62;

let angle = 0;
const axes = new Float32Array(3);
function render(_alpha: number): void {
  ops.op_input_axes(axes);
  angle += 0.0025 + axes[0] * 0.03;
  const r = orbitRadius * (1 - axes[2] * 0.2);
  const h = cy + orbitRadius * 0.45 + axes[1] * 8;
  engine.camera.position.set(cx + Math.cos(angle) * r, h, cz + Math.sin(angle) * r * 0.6);
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
  `terrain_types ready: ${TERRAIN_TYPE_NAMES.length} seedable types side by side — ${TERRAIN_TYPE_NAMES.join(", ")} — ` +
  `all at seed ${SEED}, each built by world.generateRegion type:NAME + POPULATED with its biome content via ` +
  `scatterBiomeContent (palms on the beach, pines on the mountains, cacti in the desert, broadleaf/pine forest, grass plains) — ` +
  `zero hand-authored geometry, all curated CC0 assets by id. Orbit auto; arrows nudge.`,
);
