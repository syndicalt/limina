// ASSET PIPELINE PROOF — render two REAL pipeline-sourced glbs through the unchanged asset.place:
//   - assets/prop-barrel-1.glb         (Poly Pizza, CC-BY — free FOSS library)
//   - assets/prop-a-wooden-barrel-2.glb (3D AI Studio — generated, OBJ→glb w/ PBR)
// Both were produced HOST-SIDE by tools/asset-fetch.ts and dropped into assets/; the engine consumes
// them by id with zero pipeline awareness. This closes the loop: host generation → assets/ → asset.place.
//
// Run: ./target/release/limina --window js/src/demos/asset_proof.ts

import { createEngine, ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { LiminaTracer } from "../observability/event.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";

const engine = await createEngine({ width: 1280, height: 720 });
const registry = new SkillRegistry(new LiminaTracer("ses_asset_proof"));
registerCoreSkills(registry);
const world: WorldContext = {
  ecs: engine.world, entities: engine.entities, tags: engine.tags,
  transforms: engine.transforms, spatial: engine.spatial, scene: engine.scene,
  camera: engine.camera, renderer: engine.renderer, ops: engine.ops,
  width: engine.width, height: engine.height, mode: engine.mode,
};
const base = { agentId: "agt", sessionId: "ses_asset_proof", permissions: resolveProfile("builder.readWrite"), tick: 0, world };
ops.op_physics_create_world(-9.81);

async function place(assetId: string, x: number, label: string): Promise<void> {
  const res = await registry.invoke("asset.place", { assetId, position: [x, 0, 0] }, base);
  if (!res.success) { ops.op_log(`asset.place FAILED for ${label} (${assetId}): ${JSON.stringify(res.error)}`); return; }
  ops.op_log(`placed ${label}: ${assetId} → entity ${(res.result as { entity: string }).entity}`);
}
await place("prop-barrel-1.glb", -2.2, "Poly Pizza barrel");
await place("prop-a-wooden-barrel-2.glb", 2.2, "3D AI Studio barrel");

// Hero orbit framing both barrels.
const target = { x: 0, y: 0.6, z: 0 };
engine.camera.near = 0.05; engine.camera.far = 200; engine.camera.updateProjectionMatrix();
let angle = Math.PI * 0.25;
function render(_a: number): void {
  const axes = new Float32Array(3); ops.op_input_axes(axes);
  angle += 0.0015 + axes[0] * 0.02;
  const r = 7 * (1 - axes[2] * 0.15);
  engine.camera.position.set(target.x + Math.cos(angle) * r, 3, target.z + Math.sin(angle) * r);
  engine.camera.lookAt(target.x, target.y, target.z);
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
ops.op_log("asset proof ready: 2 pipeline-sourced glbs placed via the unchanged asset.place. A/D orbit, S/W dolly.");
