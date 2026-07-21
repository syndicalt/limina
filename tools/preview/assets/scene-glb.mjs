// ROUND-TRIP PROOF: consume the EXPORTED reusable asset. This scene loads the baked GLB
// (assets/library/medieval-house.glb — the agent-authored house.mjs, exported via GLTFExporter)
// with a plain GLTFLoader and places three copies. If this renders the same house, the export is a
// genuine, portable, reusable asset — the author -> export -> reuse loop is closed.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

export async function buildScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fb6d9);
  scene.fog = new THREE.Fog(0xd8e2ea, 45, 170);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), new THREE.MeshStandardMaterial({ color: 0x5f7f3c, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

  const sun = new THREE.DirectionalLight(0xffd7a6, 2.8);
  sun.position.set(-30, 30, 22); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera; sc.left = -28; sc.right = 28; sc.top = 28; sc.bottom = -28; sc.near = 1; sc.far = 120;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xbcd0ff, 0x55502f, 0.55));
  scene.add(new THREE.AmbientLight(0x334455, 0.12));

  // Consume the EXPORTED asset — a plain glTF load, no knowledge of how it was authored.
  const gltf = await new GLTFLoader().loadAsync("/assets/library/medieval-house.glb");
  const proto = gltf.scene;
  const rng = mulberry32(7);
  const spots = [[-6, 0, -3, 0.35], [6.5, 0, -3.5, -0.7], [0, 0, 6, Math.PI + 0.2]];
  for (const [x, y, z, ry] of spots) {
    const h = proto.clone(true);
    h.position.set(x, y, z);
    h.rotation.y = ry + (rng() - 0.5) * 0.15;
    h.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(h);
  }

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  camera.position.set(16, 12, 19); camera.lookAt(0, 2.5, 0);
  return { scene, camera };
}
