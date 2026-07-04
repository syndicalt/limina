// RE-IMPORT gate: load a baked building GLB back through the STANDARD sRGB
// pipeline (GLTFLoader tags baseColor maps SRGBColorSpace; engine-consume's
// renderer has outputColorSpace=sRGB + ACES) and render it on a plain ground.
// This is the real pipeline proof — does the agent-authored asset survive the
// author -> GLB -> re-consume round-trip and still read as the same building?
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export async function buildScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbdd3e6);
  scene.fog = new THREE.Fog(0xd2ddb9, 60, 260);

  const url = new URLSearchParams(location.search).get("glb") || "/tools/preview/out/keep.glb";
  const gltf = await new GLTFLoader().loadAsync(url);
  const building = gltf.scene;
  building.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(building);

  const bbox = new THREE.Box3().setFromObject(building);
  const c = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());

  // Ground plane flush with the building's base.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(160, 160),
    new THREE.MeshStandardMaterial({ color: 0x5c6b3c, roughness: 1, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = bbox.min.y;
  ground.receiveShadow = true;
  scene.add(ground);

  // Golden-hour key + fills. Intensities are lifted vs the old preview because
  // the GLB's baseColor maps are (correctly) SRGBColorSpace on re-import, so the
  // pipeline sRGB-decodes them to linear before lighting — a correct-colorspace
  // asset needs a correct-exposure scene to read at the right brightness.
  const sun = new THREE.DirectionalLight(0xfff0d2, 4.6);
  sun.position.set(-c.x - 22, c.y + size.y + 20, c.z + 16);
  sun.target.position.copy(c);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera; sc.left = -28; sc.right = 28; sc.top = 28; sc.bottom = -28; sc.near = 1; sc.far = 140;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun); scene.add(sun.target);
  scene.add(new THREE.HemisphereLight(0xbcd0ff, 0x4a5a30, 1.5));
  scene.add(new THREE.AmbientLight(0x556072, 0.5));

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 600);
  const reach = Math.max(size.x, size.z);
  camera.position.set(c.x + reach * 1.15, c.y + size.y * 0.85, c.z + reach * 1.45);
  camera.lookAt(c.x, c.y - size.y * 0.1, c.z);
  return { scene, camera };
}
