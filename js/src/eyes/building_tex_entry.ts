// GPU-eyes proof for the building MATERIAL TEXTURES (materials/building-textures.ts). Renders three
// large panels side by side — slate, wood, plaster — each with texturedRoleMaterial(kind, base, 0.8),
// through the engine's real render path (WebGPURenderer + node materials + render baseline) under a
// raking key light, so the shingle relief / plank grooves / plaster lumps self-shadow in the PNG.
//
// Bundled to tools/preview/out/building-tex.js; loaded by tools/preview/building-tex.html; shot on the
// REAL GPU by tools/shoot.mjs.

import * as THREE from "../../build/three.bundle.mjs";
import { applyRenderBaseline } from "../render-baseline.ts";
import { texturedRoleMaterial, type TextureKind } from "../materials/building-textures.ts";

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

  applyRenderBaseline({ scene, renderer: renderer as never, camera } as never);

  // Set camera AFTER the baseline (which otherwise forces its own 3/4 far framing): a close,
  // near-eye-level look so the shingle/plank/plaster relief fills the frame and is judgeable.
  camera.position.set(0, 1.5, 4.0);
  camera.lookAt(0, 1.4, 0);
  camera.updateProjectionMatrix();

  const key = new THREE.DirectionalLight(0xfff2df, 2.6);
  key.position.set(-5, 4.5, 4.5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const cam = key.shadow.camera as THREE.OrthographicCamera;
  cam.left = -8; cam.right = 8; cam.top = 8; cam.bottom = -8; cam.near = 0.1; cam.far = 40;
  scene.add(key);

  // Three ~3 m panels. Base hexes are role-appropriate so the modulated albedo stays on-palette.
  const specs: Array<{ kind: TextureKind; base: number; x: number }> = [
    { kind: "slate", base: 0x3b4653, x: -2.85 },
    { kind: "wood", base: 0x6b4a2f, x: 0.0 },
    { kind: "plaster", base: 0xcfc6b4, x: 2.85 },
  ];
  const geo = new THREE.BoxGeometry(2.7, 2.7, 0.3);
  for (const s of specs) {
    const mat = texturedRoleMaterial(s.kind, s.base, 0.8);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(s.x, 1.5, 0);
    mesh.castShadow = true; mesh.receiveShadow = true;
    scene.add(mesh);
  }

  let n = 0;
  const loop = (): void => {
    renderer.render(scene, camera);
    if (++n < 40) requestAnimationFrame(loop);
    else window.__kitReady = true;
  };
  loop();
}

main().catch((e) => { window.__kitErr = String((e && (e.stack || e.message)) || e); window.__kitReady = true; });
