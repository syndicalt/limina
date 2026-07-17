// Native WebGPU compute-dispatch + storage-backed render smoke for vegetation.grassField.
// Run: ./target/release/limina --window --frames 8 js/test/p_grass_field_gpu.ts

import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, type WorldContext } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { registerGrassFieldSkill } from "../src/skills/grass-field.ts";
import type { EditableTerrain } from "../src/skills/terrain-edit.ts";

interface SurfaceOps {
  op_create_window_context(): unknown;
  op_surface_present(context: unknown): void;
  op_set_frame_callback(callback: () => void): void;
  op_log(message: string): void;
}
interface Adapter { requestDevice(): Promise<unknown>; }
declare const navigator: { gpu: { requestAdapter(): Promise<Adapter | null> } };
declare const Deno: { core: { ops: SurfaceOps } };

const surfaceOps = Deno.core.ops;
const adapter = await navigator.gpu.requestAdapter();
if (adapter === null) throw new Error("p_grass_field_gpu FAIL: no WebGPU adapter");
const device = await adapter.requestDevice();
const context = surfaceOps.op_create_window_context();
const canvas = { width: 640, height: 480, style: {} };
const renderer = new THREE.WebGPURenderer({ device, context, canvas, antialias: false });
await renderer.init();
renderer.setSize(canvas.width, canvas.height, false);

const n = 17;
const heights = new Float32Array(n * n);
const paintMat = new Uint8Array(n * n).fill(2);
const paintW = new Float32Array(n * n);
for (let row = 0; row < n; row++) for (let column = 0; column < n; column++) {
  heights[row * n + column] = Math.sin(column / (n - 1) * Math.PI) * 0.25;
  paintW[row * n + column] = column < n / 2 ? 1 : 0.35;
}
const layer: EditableTerrain = {
  tile: { nrows: n, ncols: n, origin: [12, 0, 12], scale: [24, 1, 24], heights, paintMat, paintW },
  mesh: undefined, eid: 0, entity: "terrain", bodyId: 0,
};
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15202a);
const camera = new THREE.PerspectiveCamera(52, canvas.width / canvas.height, 0.1, 100);
camera.position.set(12, 6, 19);
camera.lookAt(12, 0.3, 12);
const ecs = createEcsWorld();
const world: WorldContext = {
  ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
  entities: new EntityTable(), tags: new Map(), scene, camera, renderer,
  ops: Deno.core.ops as never, mode: "windowed",
};
const registry = new SkillRegistry(new LiminaTracer("p_grass_field_gpu"));
registerGrassFieldSkill(registry, new Map([["terrain", layer]]));
const result = await registry.invoke(
  "vegetation.grassField",
  { terrain: "terrain", seed: 1729, spacing: 0.75, tileSize: 24 },
  { agentId: "gpu", sessionId: "p_grass_field_gpu", permissions: resolveProfile("builder.readWrite"), tick: 1, world },
);
if (!result.success) throw new Error(`p_grass_field_gpu FAIL: ${JSON.stringify(result.error)}`);

const meshes: THREE.InstancedMesh[] = [];
scene.traverse((object) => { if ((object as THREE.InstancedMesh).isInstancedMesh) meshes.push(object as THREE.InstancedMesh); });
if (meshes.length !== 1 || meshes[0].count < 1) throw new Error("p_grass_field_gpu FAIL: compute field did not publish one bounded tile mesh");
scene.add(new THREE.HemisphereLight(0xc7e4ff, 0x273417, 2));
const sun = new THREE.DirectionalLight(0xffefc8, 4);
sun.position.set(7, 12, 5);
scene.add(sun);

let frames = 0;
surfaceOps.op_set_frame_callback(() => {
  renderer.render(scene, camera);
  surfaceOps.op_surface_present(context);
  frames++;
  if (frames === 1) surfaceOps.op_log("p_grass_field_gpu OK: native WebGPU dispatched fixed-slot grass compute and rendered storage-backed roots/scales");
});
