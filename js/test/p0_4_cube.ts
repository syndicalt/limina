// P0.4 - Three.js WebGPU lit cube rendered through the injected surface context.
//
// Run: limina --window --frames 240 js/test/p0_4_cube.ts
//
// Reuses the host's GPUDevice + GPUCanvasContext (Path B). The renderer never
// touches navigator.gpu's adapter path or a real canvas: it is handed `device`,
// `context`, and a minimal `{ width, height, style }` canvas stub.

import * as THREE from "../build/three.bundle.mjs";

interface SurfaceOps {
  op_create_window_context(): unknown;
  op_surface_present(context: unknown): void;
  op_surface_resize(w: number, h: number): void;
  op_set_frame_callback(cb: () => void): void;
  op_set_resize_callback(cb: (w: number, h: number) => void): void;
  op_log(msg: string): void;
}
interface Adapter {
  requestDevice(): Promise<unknown>;
}
interface Gpu {
  requestAdapter(): Promise<Adapter | null>;
  getPreferredCanvasFormat(): string;
}
declare const navigator: { gpu: Gpu };
declare const Deno: { core: { ops: SurfaceOps } };

const ops = Deno.core.ops;

const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error("P0.4 FAIL: no adapter");
const device = await adapter.requestDevice();
const context = ops.op_create_window_context();

let width = 960;
let height = 640;
const canvas = { width, height, style: {} };

const renderer = new THREE.WebGPURenderer({ device, context, canvas, antialias: false });
await renderer.init();
renderer.setSize(width, height, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1118);

const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 100);
camera.position.set(0, 0, 4);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1.6, 1.6, 1.6),
  new THREE.MeshStandardNodeMaterial({ color: 0xff8c1a, roughness: 0.45, metalness: 0.1 }),
);
scene.add(cube);

const key = new THREE.DirectionalLight(0xffffff, 3.0);
key.position.set(3, 5, 4);
scene.add(key);
scene.add(new THREE.AmbientLight(0x404060, 1.2));

let frames = 0;
function frame(): void {
  frames += 1;
  cube.rotation.x += 0.01;
  cube.rotation.y += 0.015;
  renderer.render(scene, camera);
  ops.op_surface_present(context);
  if (frames === 1) ops.op_log("P0.4 OK: first lit-cube frame rendered + presented");
}

function onResize(w: number, h: number): void {
  width = w;
  height = h;
  ops.op_surface_resize(w, h);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  ops.op_log(`P0.4 resized ${w}x${h}`);
}

ops.op_set_frame_callback(frame);
ops.op_set_resize_callback(onResize);
ops.op_log("P0.4 cube setup complete; entering frame loop");
