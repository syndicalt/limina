// SILHOUETTE SPIKE (Phase 2a) — render a real asset to a FLAT, UNLIT, fixed-orthographic silhouette
// (white shape on black). No lights, no shadows, no AA, no tonemapping → the mask is a pure function
// of geometry + camera, so it's deterministic across runs/GPUs. The node driver (run.mjs) shoots each
// asset and measures pairwise mask IoU to prove the design gate can tell distinct assets from clones.
//
// URL: /gates/design/spike/index.html?asset=<file.glb> ; web root = repo root (so /assets/* resolves).

import * as THREE from "../../../js/node_modules/three/build/three.module.js";
import { GLTFLoader } from "../../../js/node_modules/three/examples/jsm/loaders/GLTFLoader.js";

const W = 512, H = 512;
const canvas = document.createElement("canvas");
canvas.id = "sil-canvas"; canvas.width = W; canvas.height = H;
canvas.style.cssText = "width:512px;height:512px;display:block;background:#000";
document.body.appendChild(canvas);

const statusEl = document.createElement("div");
statusEl.id = "sil-status";
statusEl.style.cssText = "position:fixed;left:4px;bottom:4px;color:#888;font:11px monospace";
document.body.appendChild(statusEl);

const win = window as unknown as { __silDone?: boolean; __silErr?: string };
const asset = new URLSearchParams(location.search).get("asset") ?? "rock.glb";

try {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x000000, 1);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  // Fixed orthographic front view, slight downward tilt so 3D form reads in the silhouette.
  const cam = new THREE.OrthographicCamera(-1.3, 1.3, 1.3, -1.3, 0.01, 1000);
  cam.position.set(0, 0.25, 10);
  cam.lookAt(0, 0, 0);

  const res = await fetch(`/assets/${asset}`);
  if (!res.ok) throw new Error(`fetch ${asset} -> ${res.status}`);
  const buf = await res.arrayBuffer();
  const loader = new GLTFLoader();
  const gltf = await new Promise<{ scene: THREE.Object3D }>((resolve, reject) => {
    loader.parse(buf, "", (g: { scene: THREE.Object3D }) => resolve(g), (e: unknown) => reject(e));
  });
  const root = gltf.scene;
  const sil = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  root.traverse((o: THREE.Object3D) => {
    const m = o as unknown as { isMesh?: boolean; material?: unknown; castShadow?: boolean; receiveShadow?: boolean };
    if (m.isMesh === true) { m.material = sil; m.castShadow = false; m.receiveShadow = false; }
  });
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const s = 2.0 / Math.max(size.x, size.y, size.z, 1e-3);
  root.scale.setScalar(s);
  root.position.set(-center.x * s, -center.y * s, -center.z * s);
  scene.add(root);
  renderer.render(scene, cam);
  statusEl.textContent = `${asset} OK`;
} catch (e) {
  statusEl.textContent = `${asset} ERR: ${String(e)}`;
  win.__silErr = String(e);
} finally {
  win.__silDone = true;
}
