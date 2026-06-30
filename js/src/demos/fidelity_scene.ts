// Phase 3 T4 -- Windowed visual-fidelity demo, built THROUGH SKILLS.
//
// A shadow-casting directional light renders real shadow maps onto a floor that
// receives them; a textured glTF samples its baseColor texture; ACES Filmic tone
// mapping + MSAA come from engine.ts. The caster slowly spins so the cast shadow
// visibly sweeps across the floor. The whole scene is authored via the same
// scene.*/three.* skills agents use (see demos/fidelity_scene_core.ts).
//
// Run: limina --window --frames 600 js/src/demos/fidelity_scene.ts

import { ops } from "../engine.ts";
import { Rotation, renderSyncSystem } from "../ecs/world.ts";
import { createWindowedContext } from "../game/index.ts";
import { buildFidelityScene } from "./fidelity_scene_core.ts";

const ctx = await createWindowedContext({ width: 960, height: 640, renderBaseline: { ground: { enabled: false } }, session: "ses_fidelity", agentId: "engine" });
const engine = ctx.engine!;
const registry = ctx.registry;
ops.op_physics_create_world(0);

const world = ctx.world;
const base = ctx.base;

const handles = await buildFidelityScene(registry, base);
const casterEid = engine.entities.resolve(handles.caster)?.eid ?? -1;

let tick = 0;
function fixedStep(): void {
  if (casterEid < 0) return;
  // Spin the caster about Y so its cast shadow sweeps across the floor.
  tick += 1;
  const half = tick * 0.012 * 0.5;
  Rotation.x[casterEid] = 0;
  Rotation.y[casterEid] = Math.sin(half);
  Rotation.z[casterEid] = 0;
  Rotation.w[casterEid] = Math.cos(half);
}

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

// Warm-up render so WebGPU pipelines (including the shadow-map pass) compile while
// the loop is uncontended; otherwise the first frames present blank.
render();
ops.op_set_fixed_step_callback(fixedStep);
ops.op_set_frame_callback(render);
ops.op_set_resize_callback(onResize);
ops.op_log("fidelity scene ready: shadowed floor + textured glTF, ACES tone mapping + MSAA");
