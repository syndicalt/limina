// SETTLEMENT SHOWCASE — procedural ARCHITECTURE: a small village raised entirely from the
// architecture.building skill (floor + 4 walls + a doorway with lintel + roof, as real collidable
// boxes), composed N times on textured procedural terrain and dressed with biome scatter. Zero
// hand-authored geometry; deterministic + replay-safe.
//
// Run: ./target/release/limina --window js/src/demos/settlement_showcase.ts
//   (frame-capped: ./target/release/limina --window --frames 1 js/src/demos/settlement_showcase.ts)
//
// What you should see: half a dozen masonry buildings of varying size + tint clustered around a
// commons on a grassy plain, ringed by scattered pines and boulders, under the Phase-11 render
// baseline (sun + hemisphere fill + procedural-sky IBL + ACES) — a slow orbit framing the hamlet.

import { createEngine, ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { LiminaTracer } from "../observability/event.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { TILE_SIZE } from "../terrain/procedural.ts";
import { terrainTypeHints } from "../terrain/terrain-types.ts";
import { surveyRegionRelief } from "../terrain/biome-content.ts";

const SEED = 7;
const BOUNDS = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 } as const; // ~96 m of plains
const SHAPE = { amp: 0.6, erode: 0 }; // gently rolling, near-flat ground for a buildable commons

const engine = await createEngine({
  width: 1280,
  height: 720,
  renderBaseline: { ground: { enabled: false } }, // the generated region IS the ground
});

const tracer = new LiminaTracer("ses_settlement_showcase");
const registry = new SkillRegistry(tracer);
const core = registerCoreSkills(registry);
const world: WorldContext = {
  ecs: engine.world, entities: engine.entities, tags: engine.tags,
  transforms: engine.transforms, spatial: engine.spatial, scene: engine.scene,
  camera: engine.camera, renderer: engine.renderer, ops: engine.ops,
  width: engine.width, height: engine.height, mode: engine.mode,
};
const base = { agentId: "agt_settlement", sessionId: "ses_settlement_showcase", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

ops.op_physics_create_world(-9.81);

// 1. THE GROUND — a grassy plains region with the procedural-PBR surface (triplanar grass/soil).
const HINTS = { ...terrainTypeHints("plains", BOUNDS), ...SHAPE };
const relief = surveyRegionRelief(core.terrain.source, SEED, BOUNDS, HINTS);
const gen = await registry.invoke("world.generateRegion", {
  seed: SEED, bounds: BOUNDS, lod: 0, type: "plains", hints: SHAPE,
  surface: { mode: "pbr", roughness: 0.95, seaLevel: relief.minY - 5, minY: relief.minY, maxY: relief.maxY },
}, base);
if (!gen.success) throw new Error("world.generateRegion failed: " + JSON.stringify(gen.error));
const regionId = (gen.result as { regionId: string }).regionId;

const cx = ((BOUNDS.minTx + BOUNDS.maxTx + 1) / 2) * TILE_SIZE;
const cz = ((BOUNDS.minTz + BOUNDS.maxTz + 1) / 2) * TILE_SIZE;
const groundY = relief.maxY; // build on the high point so floors sit at/above the surface

// 2. THE VILLAGE — architecture.building ×6 around a commons: a hall in the middle, homes ringed
//    around it, each a different size + tint (stone hall, timber homes, a pale shrine).
const PLAN: Array<{ dx: number; dz: number; w: number; d: number; h: number; color: number }> = [
  { dx: 0, dz: 0, w: 9, d: 9, h: 5, color: 0x8d8378 }, // hall (stone)
  { dx: -13, dz: -9, w: 6, d: 6, h: 3, color: 0x9a6b4a }, // home (timber)
  { dx: 12, dz: -8, w: 6, d: 6, h: 3, color: 0x8f6a47 },
  { dx: -12, dz: 10, w: 5, d: 7, h: 3, color: 0xa07850 },
  { dx: 13, dz: 11, w: 6, d: 5, h: 3, color: 0x96754f },
  { dx: 0, dz: -16, w: 5, d: 5, h: 4, color: 0xc8bda6 }, // shrine (pale)
];
let parts = 0;
for (const b of PLAN) {
  const res = await registry.invoke("architecture.building", {
    position: [cx + b.dx, groundY, cz + b.dz], width: b.w, depth: b.d, height: b.h, color: b.color,
  }, base);
  if (!res.success) throw new Error("architecture.building failed: " + JSON.stringify(res.error));
  parts += (res.result as { entityCount: number }).entityCount;
}

// 3. THE DRESSING — a LIGHT plains scatter (sparse trees/boulders) so the village stays the subject,
//    not a forest that buries it. (Plains content is far sparser than forest.)
const pop = await registry.invoke("world.populateBiome", { regionId, type: "plains", waterLevel: relief.minY - 5, waterMargin: 0 }, base);
const scattered = pop.success ? (pop.result as { instances: number }).instances : 0;

// SLOW ORBIT camera framing the commons.
const span = (BOUNDS.maxTx - BOUNDS.minTx + 1) * TILE_SIZE;
engine.camera.near = 0.5;
engine.camera.far = span * 8;
engine.camera.updateProjectionMatrix();
const center = { x: cx, y: groundY + 3, z: cz };
const radius = span * 0.5;       // closer in — feature the buildings
const camHeight = groundY + span * 0.2; // lower, hero 3/4 angle
let angle = 0.6;
const DT = 1 / 60;

function render(_alpha: number): void {
  const axes = new Float32Array(3);
  ops.op_input_axes(axes); // A/D nudge the orbit, S/W dolly
  angle += 0.0016 + axes[0] * 0.02;
  const r = radius * (1 - axes[2] * 0.15);
  engine.camera.position.set(center.x + Math.cos(angle) * r, camHeight, center.z + Math.sin(angle) * r);
  engine.camera.lookAt(center.x, center.y, center.z);
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
render(0); // warm-up (compile pipelines before the loop)
ops.op_set_frame_callback(render);
ops.op_set_resize_callback(onResize);
ops.op_log(
  `settlement ready: ${PLAN.length} buildings (${parts} collidable parts) from architecture.building on a ` +
  `procedural-PBR plain, ${scattered} biome props — zero hand-authored geometry, deterministic. ` +
  `ORBIT: A/D nudge spin, S/W dolly, mouse to look.`,
);
