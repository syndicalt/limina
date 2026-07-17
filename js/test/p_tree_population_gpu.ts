// Native WebGPU compile/render smoke for B2 true-instanced tree rungs and pure-TSL materials.
// Run: ./target/release/limina --window --frames 8 js/test/p_tree_population_gpu.ts
import * as THREE from "../build/three.bundle.mjs";
import { buildTreeFoliageMaterial } from "../src/render/tree-foliage-material.ts";
import { buildTreeImpostorMaterial } from "../src/render/tree-impostor-material.ts";
import { TreeSpeciesBatchAdapter } from "../src/render/tree-population-batch.ts";
import type { SelectedTreeInstance, TreePopulationRung } from "../src/render/tree-population-plan.ts";

interface SurfaceOps { op_create_window_context(): unknown; op_surface_present(context: unknown): void; op_set_frame_callback(callback: () => void): void; op_log(message: string): void }
interface Adapter { requestDevice(): Promise<unknown> }
declare const navigator: { gpu: { requestAdapter(): Promise<Adapter | null> } };
declare const Deno: { core: { ops: SurfaceOps } };

const surfaceOps = Deno.core.ops, gpu = await navigator.gpu.requestAdapter();
if (gpu === null) throw new Error("p_tree_population_gpu FAIL: no WebGPU adapter");
const device = await gpu.requestDevice(), context = surfaceOps.op_create_window_context();
const canvas = { width: 640, height: 480, style: {} };
const renderer = new THREE.WebGPURenderer({ device, context, canvas, antialias: false });
await renderer.init(); renderer.setSize(canvas.width, canvas.height, false);

function atlas(kind: "albedo" | "normalDepth"): THREE.DataTexture {
  const size = 64, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const localX = x % 32 - 15.5, localY = y % 32 - 15.5, offset = (y * size + x) * 4;
    if (localX * localX / 120 + localY * localY / 190 < 1) {
      data[offset] = kind === "albedo" ? 52 : 128; data[offset + 1] = kind === "albedo" ? 142 : 128;
      data[offset + 2] = kind === "albedo" ? 42 : 110; data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size); texture.needsUpdate = true; return texture;
}
const albedo = atlas("albedo"), normalDepth = atlas("normalDepth");
const branch = new THREE.MeshStandardNodeMaterial({ color: 0x68401f, roughness: 0.86 });
const foliage = buildTreeFoliageMaterial(new THREE.MeshStandardMaterial({ color: 0x4b8738, roughness: 0.8 }), { sssStrength: 0.28 });
const impostor = buildTreeImpostorMaterial({ albedo, normalDepth, grid: 2, cellSize: 32, alphaCutoff: 0.4 });
const perRung = 384, capacity = perRung * 3;
const trees: SelectedTreeInstance[] = [];
for (let rung = 0 as TreePopulationRung; rung <= 2; rung = (rung + 1) as TreePopulationRung) {
  for (let index = 0; index < perRung; index++) {
    const column = index % 24, row = Math.floor(index / 24), x = (column - 12) * 2.2 + rung * 0.4, z = (row - 8) * 2.2 - rung * 14;
    trees.push({ speciesId: "oak", ordinal: rung * perRung + index, rung, x, y: 0, z, yaw: index * 0.37, scale: 0.8 + (index % 7) * 0.05, localX: 0, localZ: 0 });
  }
}
const adapter = new TreeSpeciesBatchAdapter("oak", capacity, { speciesId: "oak", capacity,
  branch: { full: new THREE.CylinderGeometry(0.45, 0.65, 7, 10), reduced: new THREE.CylinderGeometry(0.4, 0.6, 7, 6), material: branch },
  foliage: { full: new THREE.IcosahedronGeometry(2.6, 2), reduced: new THREE.IcosahedronGeometry(2.5, 1), material: foliage },
  impostorGeometry: new THREE.PlaneGeometry(5.5, 9).translate(0, 4.5, 0), impostorMaterial: impostor, atlasTextures: 2, atlasBytes: 32_768 });
adapter.publish(trees, 0, 0);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x17252d); scene.add(adapter.root, new THREE.HemisphereLight(0xc9e4ff, 0x26391d, 1.8));
const sun = new THREE.DirectionalLight(0xffe2b8, 4); sun.position.set(5, 9, 4); scene.add(sun);
const camera = new THREE.PerspectiveCamera(48, canvas.width / canvas.height, 0.1, 300); camera.position.set(48, 32, 60); camera.lookAt(0, 3, -12);
let frames = 0;
surfaceOps.op_set_frame_callback(() => {
  camera.position.x = Math.cos(frames * 0.08) * 60; camera.position.z = Math.sin(frames * 0.08) * 60 + 25; camera.lookAt(0, 3, -12);
  renderer.render(scene, camera); surfaceOps.op_surface_present(context); frames++;
  if (frames === 1) {
    const counts = [adapter.branchFull.count, adapter.branchReduced.count, adapter.foliageFull.count, adapter.foliageReduced.count, adapter.impostors.count];
    if (counts.some((count) => count !== perRung)) throw new Error(`p_tree_population_gpu FAIL: rung compaction ${counts}`);
    surfaceOps.op_log(`p_tree_population_gpu OK: native WebGPU compiled pure-TSL foliage/impostor and rendered ${capacity} trees through five population-constant instanced draws`);
  }
});
