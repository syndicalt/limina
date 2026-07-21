// GPU-eyes proof for the building module-kit wall-panel (Slice 1). Renders, through the ENGINE's real
// render path (WebGPURenderer + node materials + the shipped render baseline), the kit wall-panel
// beside a same-size FLAT slab at eye level under a raking key light — so the timber frame's proud
// relief self-shadows and the "surface not shape" delta is visible in a screenshot, not just asserted.
//
// Bundled to tools/preview/out/kit-panel.js; loaded by tools/preview/kit-panel.html; shot on the REAL
// GPU by tools/shoot.mjs (--use-gl=angle). This renders the ACTUAL node materials the kit ships, so
// what the PNG shows is what the live engine draws.

import * as THREE from "../../build/three.bundle.mjs";
import { applyRenderBaseline } from "../render-baseline.ts";
import { makePart, type PartContext } from "../skills/building/kit.ts";
import { DEFAULT_DESIGN_DIRECTION } from "../game/design-direction.ts";

declare const window: { __kitReady?: boolean; __kitErr?: string };

async function main(): Promise<void> {
  const canvas = document.getElementById("limina-canvas") as HTMLCanvasElement;
  const W = canvas.width, H = canvas.height;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: !navigator.gpu } as never);
  await renderer.init();
  renderer.setSize(W, H, false);
  (renderer as unknown as { shadowMap: { enabled: boolean; type: number } }).shadowMap.enabled = true;
  (renderer as unknown as { shadowMap: { enabled: boolean; type: number } }).shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 200);
  camera.position.set(0, 1.7, 6.2);
  camera.lookAt(0, 1.5, 0);

  // The engine's shipped baseline: sun + hemisphere + procedural-sky IBL + ACES tonemapping + ground.
  applyRenderBaseline({ scene, renderer: renderer as never, camera } as never);

  // A raking key light so the proud timber frame throws a real shadow across the recessed plaster.
  const key = new THREE.DirectionalLight(0xfff2df, 2.6);
  key.position.set(-5, 4.5, 4.5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const cam = key.shadow.camera as THREE.OrthographicCamera;
  cam.left = -8; cam.right = 8; cam.top = 8; cam.bottom = -8; cam.near = 0.1; cam.far = 40;
  scene.add(key);

  const ctx: PartContext = { dd: DEFAULT_DESIGN_DIRECTION, seed: 7 };
  const size: [number, number, number] = [3, 3, 0.3];

  // Left: the kit wall-panel (recessed plaster + proud timber frame). Right: a same-size flat slab.
  const panel = makePart({ kind: "wall-panel", size, role: "stone" }, ctx).mesh;
  panel.position.set(-1.9, 1.5, 0);
  const flat = makePart({ kind: "beam", size, role: "stone" }, ctx).mesh;
  flat.position.set(1.9, 1.5, 0);
  for (const m of [panel, flat]) {
    m.traverse((o: THREE.Object3D) => { (o as THREE.Mesh).castShadow = true; (o as THREE.Mesh).receiveShadow = true; });
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
  }

  // Render a few frames so node-material shaders compile + shadows settle, then hold.
  let n = 0;
  const loop = (): void => {
    renderer.render(scene, camera);
    if (++n < 40) requestAnimationFrame(loop);
    else window.__kitReady = true;
  };
  loop();
}

main().catch((e) => { window.__kitErr = String((e && (e.stack || e.message)) || e); window.__kitReady = true; });
