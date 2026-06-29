// Track R probe — LIVE post-processing during free navigation (the roadmap's open question for the
// deno_webgpu backend). Builds emissive orbs and runs a real TSL PostProcessing pipeline (scene pass →
// bloom) every frame, presenting to the native window. If bloom glows the orbs AND the camera keeps
// orbiting smoothly, live post works on the current backend (R's "live post + MSAA" gate, MSAA already
// on via antialias). If it freezes/black, the native wgpu rewrite is the only path.
//
// Run: limina --window js/src/demos/r_post_window.ts

import * as THREE from "../../build/three.bundle.mjs";
import { createEngine, ops } from "../engine.ts";
import { renderSyncSystem, spawnRenderable } from "../ecs/world.ts";

const engine = await createEngine({ width: 960, height: 640 });
const { renderer, scene, camera, world } = engine;
ops.op_physics_create_world(0);

const colors = [0xff5533, 0x33ff88, 0x3388ff, 0xffcc22, 0xff44cc];
for (let i = 0; i < colors.length; i++) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.8, 48, 24),
    new THREE.MeshStandardNodeMaterial({ color: 0x222228, emissive: new THREE.Color(colors[i]), emissiveIntensity: 1.25, roughness: 0.4 }),
  );
  const x = (i - (colors.length - 1) / 2) * 2.4;
  mesh.position.set(x, 1.5, 0);
  scene.add(mesh);
  spawnRenderable(world, mesh, x, 1.5, 0);
}

// Build the live post pipeline; fall back to a plain render if the backend rejects it (logged).
let post: { renderAsync(): Promise<void> } | undefined;
const T = THREE as unknown as {
  TSL: { pass(s: unknown, c: unknown): { getTextureNode(): unknown } };
  bloom(node: unknown, strength?: number, radius?: number, threshold?: number): unknown;
  PostProcessing: new (r: unknown) => { outputNode: unknown; renderAsync(): Promise<void> };
};
try {
  const scenePass = T.TSL.pass(scene, camera);
  const color = scenePass.getTextureNode() as { add(n: unknown): unknown };
  const bloomPass = T.bloom(color, 0.7, 0.45, 0.2);
  const pp = new T.PostProcessing(renderer);
  pp.outputNode = color.add(bloomPass);
  post = pp;
  ops.op_log("r_post: live PostProcessing pipeline built (scene pass + bloom) ✓");
} catch (e) {
  ops.op_log("r_post: post setup FAILED → plain render fallback: " + (e instanceof Error ? e.message : String(e)));
}

let angle = 0;
function render(_alpha: number): void {
  angle += 0.008;
  camera.position.set(Math.cos(angle) * 8, 3.5, Math.sin(angle) * 8);
  camera.lookAt(0, 1.2, 0);
  renderSyncSystem(world);
  if (post) {
    // The RenderPipeline composites + presents to the surface itself; calling op_surface_present
    // again double-presents and errors ("Surface is not configured for presentation"). So present
    // is owned by the pipeline here, by limina's op only for the plain path.
    void post.renderAsync();
  } else {
    renderer.render(scene, camera);
    ops.op_surface_present(engine.context);
  }
}
ops.op_set_frame_callback(render);
ops.op_log("r_post ready: live bloom post-processing test (R)");
