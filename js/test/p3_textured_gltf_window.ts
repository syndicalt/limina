// Windowed textured glTF smoke: load a textured fixture through three.loadGLTF,
// render it with WebGPU, and present a few frames without bypassing the skill.
//
// Run: limina --window --frames 5 js/test/p3_textured_gltf_window.ts

import { createEngine, ops } from "../src/engine.ts";
import { renderSyncSystem } from "../src/ecs/world.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";

const engine = await createEngine({ width: 640, height: 480 });
const tracer = new LiminaTracer("ses_p3_textured_gltf_window");
const registry = new SkillRegistry(tracer);
registerCoreSkills(registry);

const world = {
  ecs: engine.world,
  transforms: engine.transforms,
  spatial: engine.spatial,
  entities: engine.entities,
  tags: engine.tags,
  scene: engine.scene,
  camera: engine.camera,
  ops: engine.ops,
  renderer: engine.renderer,
  width: engine.width,
  height: engine.height,
  mode: engine.mode,
};
const ctx = { agentId: "agt_builder", sessionId: "ses_p3_textured_gltf_window", permissions: resolveProfile("builder.readWrite"), tick: 0, world };
const res = await registry.invoke("three.loadGLTF", { assetId: "textured-triangle.gltf", position: [-0.5, -0.5, 0] }, ctx);
if (!res.success) throw new Error("three.loadGLTF failed: " + JSON.stringify(res.error));
await registry.invoke("three.setLighting", { ambientIntensity: 2, directionalIntensity: 3 }, ctx);

engine.camera.position.set(0, 0, 3);
engine.camera.lookAt(0, 0, 0);

function render(): void {
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

render();
ops.op_set_frame_callback(render);
ops.op_set_resize_callback(onResize);
ops.op_log("P3 textured glTF window OK: textured glTF loaded through skill and rendered");
