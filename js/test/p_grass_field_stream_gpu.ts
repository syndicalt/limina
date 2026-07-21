// Native WebGPU camera-resident multi-page grass field smoke.
// Run: ./target/release/limina --window --frames 8 js/test/p_grass_field_stream_gpu.ts

import * as THREE from "../build/three.bundle.mjs";
import { GrassFieldStreamManager } from "../src/render/grass-field-render.ts";
import { GRASS_FIELD_MAX_RESIDENT_SLOTS } from "../src/render/grass-field-plan.ts";
import { INTERACTIVE_TEMPERATE_MEADOW_PACKAGE } from "../src/content/grass/interactive-temperate-meadow.ts";
import type { TerrainTile } from "../src/terrain/types.ts";

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
if (adapter === null) throw new Error("p_grass_field_stream_gpu FAIL: no WebGPU adapter");
const device = await adapter.requestDevice();
const context = surfaceOps.op_create_window_context();
const canvas = { width: 640, height: 480, style: {} };
const renderer = new THREE.WebGPURenderer({ device, context, canvas, antialias: false });
await renderer.init();
renderer.setSize(canvas.width, canvas.height, false);

const n = 33, heights = new Float32Array(n * n), paintMat = new Uint8Array(n * n).fill(2), paintW = new Float32Array(n * n);
for (let row = 0; row < n; row++) for (let column = 0; column < n; column++) {
  heights[row * n + column] = Math.sin(column / (n - 1) * Math.PI) * 0.18 + Math.cos(row / (n - 1) * Math.PI) * 0.08;
  paintW[row * n + column] = column < n * 0.75 ? 1 : 0.4;
}
const tileAt = (tx: number): TerrainTile => ({ nrows: n, ncols: n, origin: [tx * 48 + 24, 0, 24], scale: [48, 1, 48], heights, paintMat, paintW });
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x15202a);
const camera = new THREE.PerspectiveCamera(52, canvas.width / canvas.height, 0.1, 120);
camera.position.set(24, 8, 36); camera.lookAt(24, 0.3, 24);
const manager = new GrassFieldStreamManager(scene, {
  visualPackage: INTERACTIVE_TEMPERATE_MEADOW_PACKAGE,
  tileSize: 48, radius: 2, renderer,
  source: () => ({ seed: 1729, spacing: 0.75, elevationMin: -1 }),
});
manager.noteTile("0:0", { tx: 0, tz: 0 }, tileAt(0));
manager.noteTile("2:0", { tx: 2, tz: 0 }, tileAt(2));
const advance = async (x: number): Promise<void> => {
  const launched = manager.update(x, 24);
  if (launched.grown !== 1 || launched.pending !== 1) throw new Error("p_grass_field_stream_gpu FAIL: expected native resident build did not launch");
  await manager.settle();
};
await advance(24); await advance(24);
if (manager.activeLod("0:0") !== 0 || manager.activeLod("2:0") !== 1) throw new Error("p_grass_field_stream_gpu FAIL: initial fine/coarse levels are wrong");
await advance(120); await advance(120);
if (manager.activeLod("2:0") !== 0 || manager.activeLod("0:0") !== 1) throw new Error("p_grass_field_stream_gpu FAIL: camera move did not replace both native LOD levels");
const errors = manager.takeErrors();
if (errors.length > 0) throw new Error(`p_grass_field_stream_gpu FAIL: ${errors.map(String).join(" | ")}`);
const groups = scene.children.filter((child) => child.name === "limina:streamed-grass-field");
const pages = groups.reduce((sum, group) => sum + Number(group.userData.liminaGrassFieldPages ?? 0), 0);
if (groups.length !== 2 || groups.some((group) => group.children.length !== 1) || pages < 3) throw new Error("p_grass_field_stream_gpu FAIL: LOD-replaced multi-page compute was not batched into atomic tile draws");
if (manager.residentSlots().total > GRASS_FIELD_MAX_RESIDENT_SLOTS) throw new Error("p_grass_field_stream_gpu FAIL: native resident slots exceeded the hard cap");
camera.position.set(120, 8, 36); camera.lookAt(120, 0.3, 24);
scene.add(new THREE.HemisphereLight(0xc7e4ff, 0x273417, 2));
const sun = new THREE.DirectionalLight(0xffefc8, 4); sun.position.set(7, 12, 5); scene.add(sun);

let frames = 0;
surfaceOps.op_set_frame_callback(() => {
  renderer.render(scene, camera);
  surfaceOps.op_surface_present(context);
  frames++;
  if (frames === 1) surfaceOps.op_log(`p_grass_field_stream_gpu OK: native WebGPU streamed/replaced two camera LODs (${pages} canonical pages) through two tile draws and rendered shared storage-backed grass`);
});
