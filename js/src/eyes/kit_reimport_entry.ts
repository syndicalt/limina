// GPU-eyes RE-IMPORT proof (Slice 4). Loads the exported GLB (kit-building.glb) back through the
// ENGINE's OWN glTF path (parseGltfScene — the same GLTFLoader + texture handling the live viewport
// mounts through) and renders it on the REAL GPU with the SAME baseline/lights/camera as the SOURCE
// harness (kit_building_entry.ts). Read side-by-side with the source PNG, this shows the re-imported
// building is NOT darkened — i.e. the baked SRGB albedo texture round-tripped with its colourspace
// intact (the classic "re-imports dark" bug would show here as a muddy/black surface).
//
// ORDER MATTERS (headless forceWebGL init-collapse gotcha): the async fetch + parse (macrotasks) run
// BEFORE renderer.init(), so no macrotask fires between init() and the first render.

import * as THREE from "../../build/three.bundle.mjs";
import { applyRenderBaseline } from "../render-baseline.ts";
import { parseGltfScene } from "../skills/three.ts";

declare const window: { __kitReady?: boolean; __kitErr?: string };

async function main(): Promise<void> {
  // 1. Fetch + parse the exported GLB FIRST (all macrotasks before renderer.init()).
  const res = await fetch("./kit-building.glb");
  if (!res.ok) throw new Error(`fetch kit-building.glb: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const root = await parseGltfScene("kit-building.glb", bytes);

  // 2. Renderer + scene identical to the source harness (kit_building_entry.ts).
  const canvas = document.getElementById("limina-canvas") as HTMLCanvasElement;
  const W = canvas.width, H = canvas.height;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: !navigator.gpu } as never);
  await renderer.init();
  renderer.setSize(W, H, false);
  (renderer as unknown as { shadowMap: { enabled: boolean; type: number } }).shadowMap.enabled = true;
  (renderer as unknown as { shadowMap: { enabled: boolean; type: number } }).shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, W / H, 0.1, 400);
  camera.position.set(9.5, 4.6, 9.5);
  camera.lookAt(0, 1.5, 0);
  applyRenderBaseline({ scene, renderer: renderer as never, camera } as never);

  const key = new THREE.DirectionalLight(0xfff0da, 2.4);
  key.position.set(-7, 9, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const kc = key.shadow.camera as THREE.OrthographicCamera;
  kc.left = -14; kc.right = 14; kc.top = 14; kc.bottom = -14; kc.near = 0.1; kc.far = 60;
  scene.add(key);

  scene.add(root as unknown as THREE.Object3D);
  (root as unknown as THREE.Object3D).traverse((o: THREE.Object3D) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });

  let n = 0;
  const loop = (): void => {
    renderer.render(scene, camera);
    if (++n < 50) requestAnimationFrame(loop);
    else window.__kitReady = true;
  };
  loop();
}

main().catch((e) => { window.__kitErr = String((e && (e.stack || e.message)) || e); window.__kitReady = true; });
