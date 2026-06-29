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

interface FrameStats { meanLum: number; lumStdev: number; detail: number; width: number; height: number }
interface SceneSpec { boxes: Array<{ position: [number, number, number]; size: [number, number, number]; color: number }> }
declare const window: {
  __renderAt?: (config: Record<string, number>) => Promise<FrameStats>;
  __renderScene?: (spec: SceneSpec) => Promise<FrameStats>;
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
// The baseline's procedural sky (kept for the A fidelity comparison via `fullSky`).
const skyBackground = scene.background;
// Default: draw a dark background so the lit surfaces (not a bright sky) dominate the measured
// luminance — gives the B-loop's sun-intensity knob a wide, monotonic range.
scene.background = new THREE.Color(0x0a0d12);

// A few shapes, each with a lit PBR material AND a flat unlit material, so the harness can render
// the fidelity baseline ("after") or a naive flat-shaded frame ("before") for a side-by-side.
const palette = [
  [-2.4, 0x4488ff],
  [0, 0xff8a3d],
  [2.4, 0x55cc88],
] as const;
const shapes: Array<{ mesh: THREE.Mesh; lit: THREE.Material; flat: THREE.Material }> = [];
for (const [x, color] of palette) {
  const lit = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.1 });
  const flat = new THREE.MeshBasicMaterial({ color }); // unlit, constant color — "before fidelity"
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), lit);
  mesh.position.set(x, 1, 0);
  scene.add(mesh);
  shapes.push({ mesh, lit, flat });
}

/** Per-pixel luminance stats. `detail` is mean local gradient magnitude (|Δ| to the right + down
 *  neighbour) — the right fidelity proxy: lit shading puts SMOOTH gradients across the whole frame
 *  (sky gradient, curved-surface shading, ground falloff), while a flat-shaded frame is uniform
 *  interiors with gradient only at sparse hard edges. (Global stdev is fooled by flat bright colors.) */
function lumStats(px: Uint8Array | Float32Array): { mean: number; stdev: number; detail: number } {
  const scale = px instanceof Float32Array ? 1 : 1 / 255;
  const n = W * H;
  let sum = 0;
  const lum = new Float64Array(n);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    lum[j] = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) * scale;
    sum += lum[j];
  }
  const mean = sum / n;
  let varSum = 0;
  for (let j = 0; j < n; j++) varSum += (lum[j] - mean) * (lum[j] - mean);
  let gradSum = 0, gradN = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const j = y * W + x;
      if (x + 1 < W) { gradSum += Math.abs(lum[j + 1] - lum[j]); gradN++; }
      if (y + 1 < H) { gradSum += Math.abs(lum[j + W] - lum[j]); gradN++; }
    }
  }
  return { mean, stdev: Math.sqrt(varSum / n), detail: gradSum / Math.max(gradN, 1) };
}

const renderAsync = (renderer as never as { renderAsync(s: unknown, c: unknown): Promise<void> }).renderAsync.bind(renderer);
const readPixels = (renderer as never as {
  readRenderTargetPixelsAsync(rt: unknown, x: number, y: number, w: number, h: number): Promise<Uint8Array | Float32Array>;
}).readRenderTargetPixelsAsync.bind(renderer);

/** Render into the offscreen target, read it back (render twice first so a just-changed state is
 *  settled), then draw to the canvas for screenshots. Returns the frame stats. */
async function renderAndRead(): Promise<FrameStats> {
  renderer.setRenderTarget(rt as never);
  await renderAsync(scene, camera);
  await renderAsync(scene, camera);
  const px = await readPixels(rt, 0, 0, W, H);
  renderer.setRenderTarget(null);
  await renderAsync(scene, camera);
  const s = lumStats(px);
  return { meanLum: s.mean, lumStdev: s.stdev, detail: s.detail, width: W, height: H };
}

window.__renderAt = async (config) => {
  // `flat` (1) renders the naive unlit "before" frame; `fullSky` (1) renders the lit baseline WITH its
  // procedural sky (the "after" for the A side-by-side); otherwise the lit scene on a dark background.
  const flat = (config.flat ?? 0) >= 1;
  const fullSky = (config.fullSky ?? 0) >= 1;
  for (const s of shapes) { s.mesh.visible = true; s.mesh.material = flat ? s.flat : s.lit; }
  scene.background = flat ? new THREE.Color(0x222222) : (fullSky ? skyBackground : new THREE.Color(0x0a0d12));
  renderer.toneMappingExposure = config.exposure ?? 1.0;
  if (config.sun !== undefined) {
    scene.traverse((o: THREE.Object3D) => {
      if ((o as THREE.DirectionalLight).isDirectionalLight) (o as THREE.DirectionalLight).intensity = config.sun;
    });
  }
  return renderAndRead();
};

// Flagship-demo render: build a real archetype scene from a box spec (e.g. the siege keep's actual
// architecture.building parts + attackers), frame the camera to its bounds, render with the baseline.
const sceneMeshes: THREE.Mesh[] = [];
window.__renderScene = async (spec) => {
  for (const m of shapes) m.mesh.visible = false; // hide the A/B probe spheres
  for (const m of sceneMeshes) scene.remove(m);
  sceneMeshes.length = 0;
  scene.background = skyBackground; // full fidelity for the showcase
  renderer.toneMappingExposure = 1.0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const b of spec.boxes) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(b.size[0], b.size[1], b.size[2]),
      new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.75, metalness: 0.04 }),
    );
    mesh.position.set(b.position[0], b.position[1], b.position[2]);
    scene.add(mesh); sceneMeshes.push(mesh);
    minX = Math.min(minX, b.position[0] - b.size[0]); maxX = Math.max(maxX, b.position[0] + b.size[0]);
    minY = Math.min(minY, b.position[1] - b.size[1]); maxY = Math.max(maxY, b.position[1] + b.size[1]);
    minZ = Math.min(minZ, b.position[2] - b.size[2]); maxZ = Math.max(maxZ, b.position[2] + b.size[2]);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 4);
  camera.position.set(cx + span * 0.9, cy + span * 0.85, cz + span * 1.25);
  camera.lookAt(cx, cy, cz);
  return renderAndRead();
};

window.__ready = true;
