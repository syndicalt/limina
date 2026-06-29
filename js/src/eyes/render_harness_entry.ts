// Browser render harness for the Track B visual self-correction loop.
//
// Renders the ENGINE's real render baseline (lights + procedural sky + ACES tonemapping + ground)
// over a few PBR shapes, via a WebGL2 renderer that runs under SwiftShader in headless Chromium — so
// the loop's RenderProvider draws genuine engine pixels with no GPU. `window.__renderAt(config)`
// applies the config (exposure, sun intensity), renders one frame, and reads the framebuffer back
// (gl.readPixels in the render context — reliable, unlike drawImage on a WebGL canvas) to return image
// stats the critic scores. Bundled to editor/vendor/render-harness.js; loaded by editor/render-harness.html.

// Import THREE from the engine's WebGPU bundle (three/webgpu) — the SAME instance render-baseline.ts
// uses, so WebGPURenderer/node materials are present and there's a single THREE (no "multiple
// instances" clash that breaks materials).
import * as THREE from "../../build/three.bundle.mjs";
import { applyRenderBaseline } from "../render-baseline.ts";

declare const window: {
  __renderAt?: (config: Record<string, number>) => Promise<{ meanLum: number; width: number; height: number }>;
  __ready?: boolean;
};

const W = 320;
const H = 240;

const canvas = document.createElement("canvas");
canvas.width = W;
canvas.height = H;
canvas.id = "harness-canvas";
canvas.style.cssText = "width:320px;height:240px;display:block";
document.body.appendChild(canvas);

// Match the engine: THREE's WebGPURenderer with the WebGL2 backend (forceWebGL) — the engine baseline
// uses node materials that only compile under WebGPURenderer, and this backend runs under SwiftShader.
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: true } as never);
await renderer.init();
renderer.setSize(W, H, false);

// Read pixels back from an offscreen render target (reliable across the WebGPU/WebGL backends).
const rt = new THREE.RenderTarget(W, H);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, W / H, 0.1, 100);
camera.position.set(6, 5, 8);
camera.lookAt(0, 1, 0);

// The engine's real baseline: sun + hemisphere lights, procedural-sky IBL, ACES tonemapping, ground.
applyRenderBaseline({ scene, renderer: renderer as never, camera } as never);
// Keep the IBL environment for lighting, but draw a dark background so the lit surfaces (not a bright
// sky) dominate the measured luminance — gives the sun-intensity knob a wide, monotonic range.
scene.background = new THREE.Color(0x0a0d12);

// A few PBR shapes for the lighting to shade.
const palette = [
  [-2.4, 0x4488ff],
  [0, 0xff8a3d],
  [2.4, 0x55cc88],
] as const;
for (const [x, color] of palette) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16),
    new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.1 }),
  );
  mesh.position.set(x, 1, 0);
  scene.add(mesh);
}

function meanLuminance(px: Uint8Array | Float32Array): number {
  let sum = 0;
  const scale = px instanceof Float32Array ? 1 : 1 / 255;
  for (let i = 0; i < px.length; i += 4) {
    sum += (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) * scale;
  }
  return sum / (W * H); // normalized 0..1
}

window.__renderAt = async (config) => {
  // Exposure is the primary knob the critic drives; sun intensity is an optional second axis.
  renderer.toneMappingExposure = config.exposure ?? 1.0;
  if (config.sun !== undefined) {
    scene.traverse((o: THREE.Object3D) => {
      if ((o as THREE.DirectionalLight).isDirectionalLight) (o as THREE.DirectionalLight).intensity = config.sun;
    });
  }
  // Render into the offscreen target and read it back, then also draw to the canvas for screenshots.
  // Render twice so a just-changed light/IBL state is fully settled before the readback (the renderer
  // can lag one frame on state changes).
  renderer.setRenderTarget(rt as never);
  const renderAsync = (renderer as never as { renderAsync(s: unknown, c: unknown): Promise<void> }).renderAsync.bind(renderer);
  await renderAsync(scene, camera);
  await renderAsync(scene, camera);
  const px = await (renderer as never as {
    readRenderTargetPixelsAsync(rt: unknown, x: number, y: number, w: number, h: number): Promise<Uint8Array | Float32Array>;
  }).readRenderTargetPixelsAsync(rt, 0, 0, W, H);
  renderer.setRenderTarget(null);
  await (renderer as never as { renderAsync(s: unknown, c: unknown): Promise<void> }).renderAsync(scene, camera);
  return { meanLum: meanLuminance(px), width: W, height: H };
};
window.__ready = true;
