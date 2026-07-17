// Minimal adapter/device/surface probe for isolating GPU backend failures.
//
// Run:
//   LIMINA_GPU_POWER_PREFERENCE=low-power ./target/release/limina --window --frames 30 js/test/p_gpu_surface_probe.ts
//   LIMINA_GPU_POWER_PREFERENCE=high-performance ./target/release/limina --window --frames 30 js/test/p_gpu_surface_probe.ts

import * as THREE from "../build/three.bundle.mjs";
import { isSoftwareAdapter } from "../src/render/fidelity-benchmark.ts";

type PowerPreference = "low-power" | "high-performance";

interface SurfaceOps {
  op_create_window_context(): unknown;
  op_surface_present(context: unknown): void;
  op_set_frame_callback(callback: () => void): void;
  op_log(message: string): void;
  op_read_env(name: string): string;
}

interface AdapterLike {
  features: Iterable<string>;
  info?: Partial<{ vendor: string; architecture: string; device: string; description: string }>;
  requestDevice(): Promise<unknown>;
}

declare const navigator: {
  gpu: {
    requestAdapter(options?: { powerPreference?: PowerPreference }): Promise<AdapterLike | null>;
  };
};
declare const Deno: { core: { ops: SurfaceOps } };

const ops = Deno.core.ops;
const configuredPreference = ops.op_read_env("LIMINA_GPU_POWER_PREFERENCE");
if (configuredPreference !== "" && configuredPreference !== "low-power" && configuredPreference !== "high-performance") {
  throw new Error("GPU probe: LIMINA_GPU_POWER_PREFERENCE must be 'low-power' or 'high-performance'");
}
const powerPreference = configuredPreference === "" ? undefined : configuredPreference as PowerPreference;

ops.op_log(`GPU probe: requesting adapter with power preference ${powerPreference ?? "default"}`);
const adapter = await navigator.gpu.requestAdapter({ powerPreference });
if (!adapter) throw new Error("GPU probe: no WebGPU adapter");

const adapterInfo = Object.freeze({
  vendor: adapter.info?.vendor ?? "",
  architecture: adapter.info?.architecture ?? "",
  device: adapter.info?.device ?? "",
  description: adapter.info?.description ?? "",
});
ops.op_log(`GPU probe: adapter ${JSON.stringify(adapterInfo)}; features ${JSON.stringify([...adapter.features].sort())}`);
if (isSoftwareAdapter(adapterInfo)) {
  throw new Error(`GPU probe: refusing software adapter "${adapterInfo.description || adapterInfo.device || "unknown"}" — a GPU surface probe must run on real hardware`);
}

const device = await adapter.requestDevice();
ops.op_log("GPU probe: device created without optional features");

const context = ops.op_create_window_context();
const canvas = { width: 320, height: 240, style: {} };
const renderer = new THREE.WebGPURenderer({ device, context, canvas, antialias: false });
await renderer.init();
renderer.setSize(canvas.width, canvas.height, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111827);
const camera = new THREE.PerspectiveCamera(55, canvas.width / canvas.height, 0.1, 20);
camera.position.set(0, 0, 3);
const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicNodeMaterial({ color: 0x22c55e }),
);
scene.add(cube);

let frames = 0;
function render(): void {
  cube.rotation.x += 0.01;
  cube.rotation.y += 0.02;
  renderer.render(scene, camera);
  ops.op_surface_present(context);
  frames++;
  if (frames === 1) ops.op_log("GPU probe: first frame rendered and presented");
  if (frames === 30) ops.op_log(`GPU probe: PASS 30 frames on ${adapterInfo.description || adapterInfo.device || "unknown adapter"}`);
}

ops.op_set_frame_callback(render);
ops.op_log("GPU probe: setup complete");
