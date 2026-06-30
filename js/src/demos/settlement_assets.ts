// SETTLEMENT (asset-sourced) — the village re-sourced from REAL assets via the pipeline, instead of
// procedural boxes. Buildings/well/tree were fetched by tools/asset-fetch.ts (Poly Pizza CC models)
// into assets/, and placed through the grounding + scale-normalizing asset.place. This is the payoff
// of the asset pipeline: agent intent → host-side retrieval → glb in assets/ → a real village.
//
// Run: ./target/release/limina --window js/src/demos/settlement_assets.ts

import { ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { createWindowedContext } from "../game/index.ts";
import { TILE_SIZE } from "../terrain/procedural.ts";
import { terrainTypeHints } from "../terrain/terrain-types.ts";
import { surveyRegionRelief } from "../terrain/biome-content.ts";

const SEED = 11;
const BOUNDS = { minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 } as const;
const SHAPE = { amp: 0.2, erode: 0 }; // nearly flat — a buildable commons

// One factory call replaces the hand-copied engine + registry + core + WorldContext + base block.
const ctx = await createWindowedContext({ width: 1280, height: 720, renderBaseline: { ground: { enabled: false } }, session: "ses_settlement_assets" });
const engine = ctx.engine!;
const core = ctx.core;
const registry = ctx.registry;
const base = ctx.base;
ops.op_physics_create_world(-9.81);

// Ground: a grassy plains region (textured PBR), nearly flat.
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

// Place an asset GROUNDED on the terrain + normalized to a real-world height, facing the commons.
async function place(assetId: string, dx: number, dz: number, height: number, faceCommons = true): Promise<void> {
  const x = cx + dx, z = cz + dz;
  const rotY = faceCommons && (dx !== 0 || dz !== 0) ? Math.atan2(dx, dz) : 0;
  const res = await registry.invoke("asset.place", { assetId, position: [x, surf(x, z), z], normalizeHeight: height, rotation: [0, rotY, 0] }, base);
  if (!res.success) { ops.op_log(`asset.place FAILED ${assetId}: ${JSON.stringify(res.error)}`); return; }
  const b = (res.result as { bounds: [number, number, number] }).bounds;
  ops.op_log(`placed ${assetId} @(${dx},${dz}) h=${height} → bounds=[${b.map((v) => v.toFixed(1)).join(",")}]`);
}

// THE VILLAGE — a well at the commons, houses ringed + facing it, a tower as the focal point.
await place("prop-water-well-1.glb", 0, 0, 2.4, false);
await place("building-medieval-house-1.glb", -11, -8, 5.0);
await place("building-medieval-house-2.glb", 11, -8, 5.0);
await place("building-medieval-house-4.glb", -12, 9, 5.0);
await place("building-medieval-house-5.glb", 12, 10, 5.0);
await place("building-medieval-house-1.glb", 0, -17, 5.0);
await place("building-wooden-watchtower-1.glb", 18, -2, 10.0, false);
// A ring of pines around the village edge.
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2;
  await place("vegetation-pine-tree-1.glb", Math.cos(a) * 26, Math.sin(a) * 26, 6.5, false);
}

// Hero orbit framing the hamlet.
const centerY = surf(cx, cz);
const center = { x: cx, y: centerY + 3, z: cz };
engine.camera.near = 0.3; engine.camera.far = 400; engine.camera.updateProjectionMatrix();
let angle = 0.7; const radius = 34, camHeight = centerY + 14;
function render(_a: number): void {
  const axes = new Float32Array(3); ops.op_input_axes(axes);
  angle += 0.0014 + axes[0] * 0.02;
  const r = radius * (1 - axes[2] * 0.15);
  engine.camera.position.set(center.x + Math.cos(angle) * r, camHeight, center.z + Math.sin(angle) * r);
  engine.camera.lookAt(center.x, center.y, center.z);
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
ops.op_log("asset-sourced settlement ready: real glb buildings/well/trees placed via grounding asset.place. A/D orbit, S/W dolly.");
