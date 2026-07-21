// Native WebGPU shader-compile smoke for the A3 material surface sampler.
// Run: ./target/release/limina --window --frames 8 js/test/p_material_surface_gpu.ts

import * as THREE from "../build/three.bundle.mjs";
import { MaterialRegistry, type ImportedTextures } from "../src/materials/material-registry.ts";

interface SurfaceOps {
  op_create_window_context(): unknown;
  op_surface_present(context: unknown): void;
  op_set_frame_callback(callback: () => void): void;
  op_log(message: string): void;
}
interface Adapter { requestDevice(): Promise<unknown>; }
declare const navigator: { gpu: { requestAdapter(): Promise<Adapter | null> } };
declare const Deno: { core: { ops: SurfaceOps } };

const ops = Deno.core.ops;
const adapter = await navigator.gpu.requestAdapter();
if (adapter === null) throw new Error("p_material_surface_gpu FAIL: no WebGPU adapter");
const device = await adapter.requestDevice();
const context = ops.op_create_window_context();
const canvas = { width: 640, height: 480, style: {} };
const renderer = new THREE.WebGPURenderer({ device, context, canvas, antialias: false });
await renderer.init();
renderer.setSize(canvas.width, canvas.height, false);

function texture(kind: "albedo" | "normal" | "roughness" | "occlusion" | "height"): THREE.DataTexture {
  const size = 16;
  const bytes = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const offset = (y * size + x) * 4;
    const checker = ((x >> 2) + (y >> 2)) & 1;
    const height = Math.round((0.15 + 0.8 * Math.sin(x / size * Math.PI) ** 2 * Math.sin(y / size * Math.PI) ** 2) * 255);
    if (kind === "albedo") {
      bytes[offset] = checker ? 88 : 43; bytes[offset + 1] = checker ? 114 : 74; bytes[offset + 2] = checker ? 58 : 35;
    } else if (kind === "normal") {
      bytes[offset] = 128; bytes[offset + 1] = 128; bytes[offset + 2] = 255;
    } else {
      const value = kind === "height" ? height : kind === "roughness" ? 190 : 220;
      bytes[offset] = value; bytes[offset + 1] = value; bytes[offset + 2] = value;
    }
    bytes[offset + 3] = 255;
  }
  const result = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  result.wrapS = THREE.RepeatWrapping;
  result.wrapT = THREE.RepeatWrapping;
  result.minFilter = THREE.LinearMipmapLinearFilter;
  result.magFilter = THREE.LinearFilter;
  if (kind === "albedo") result.colorSpace = THREE.SRGBColorSpace;
  result.needsUpdate = true;
  return result;
}

const textures: ImportedTextures = {
  albedo: texture("albedo"), normal: texture("normal"), roughness: texture("roughness"),
  occlusion: texture("occlusion"), displacement: texture("height"),
};
const registry = new MaterialRegistry();
const parallax = { heightScale: 0.08, minLayers: 8, maxLayers: 16, fadeStart: 20, fadeEnd: 40 };
const common = {
  scale: 0.8, normalStrength: 1, sharpness: 4, metalness: 0, roughness: 0.8,
  occlusionStrength: 0.8, antiTiling: true, parallax,
};
registry.define("uv", { ...common, triplanar: false }, textures, {});
registry.define("tri", { ...common, triplanar: true }, textures, {});

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x161c20);
const camera = new THREE.PerspectiveCamera(52, canvas.width / canvas.height, 0.1, 100);
camera.position.set(5.5, 4.2, 6.5);
camera.lookAt(0, 0.4, 0);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(7, 7, 32, 32), registry.build("uv"));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(1.25, 3), registry.build("tri"));
rock.position.set(0, 1.2, 0);
rock.scale.set(1.4, 1, 1.1);
scene.add(rock);
const light = new THREE.DirectionalLight(0xfff4df, 4);
light.position.set(4, 7, 3);
scene.add(light, new THREE.HemisphereLight(0xbcd7ff, 0x203018, 1.5));

let frameCount = 0;
ops.op_set_frame_callback(() => {
  rock.rotation.y += 0.01;
  renderer.render(scene, camera);
  ops.op_surface_present(context);
  frameCount++;
  if (frameCount === 1) ops.op_log("p_material_surface_gpu OK: native WebGPU compiled and rendered UV plus bounded upward-triplanar POM");
});
