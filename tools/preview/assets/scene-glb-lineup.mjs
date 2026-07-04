// RE-IMPORT the whole set: load all four baked building GLBs from the asset
// library and stand them in a row on a plain ground. Every mesh here came off
// disk through GLTFLoader — nothing is authored in-scene. Proves the complete
// keep/church/cottage/barn set survives author → GLB → re-consume, in one frame.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const LIB = "/assets/library/";
const SET = ["keep.glb", "church.glb", "cottage.glb", "barn.glb"];

export async function buildScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbdd3e6);
  scene.fog = new THREE.Fog(0xd2ddb9, 90, 400);

  const loader = new GLTFLoader();
  const gltfs = await Promise.all(SET.map((f) => loader.loadAsync(LIB + f)));

  // Row them left→right, spaced by footprint, all seated on y=0.
  let cursor = 0;
  const spans = [];
  for (const g of gltfs) {
    const obj = g.scene;
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const bb = new THREE.Box3().setFromObject(obj);
    const size = bb.getSize(new THREE.Vector3());
    const half = size.x / 2;
    cursor += half + 3;
    obj.position.set(cursor, -bb.min.y, 0);
    cursor += half;
    spans.push({ x: cursor - half, w: size.x, h: size.y });
    scene.add(obj);
  }
  const totalW = cursor;

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(totalW * 2.2, 120),
    new THREE.MeshStandardMaterial({ color: 0x5c6b3c, roughness: 1, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Same sRGB-tuned golden-hour rig as the single-building re-import scene.
  const cx = totalW / 2, maxH = Math.max(...spans.map((s) => s.h));
  const sun = new THREE.DirectionalLight(0xfff0d2, 4.4);
  sun.position.set(cx - 30, maxH + 26, 30);
  sun.target.position.set(cx, maxH * 0.3, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera; sc.left = -totalW; sc.right = totalW; sc.top = 40; sc.bottom = -40; sc.near = 1; sc.far = 240;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun); scene.add(sun.target);
  scene.add(new THREE.HemisphereLight(0xbcd0ff, 0x4a5a30, 1.4));
  scene.add(new THREE.AmbientLight(0x556072, 0.42));

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 800);
  camera.position.set(cx + totalW * 0.12, maxH * 1.5, totalW * 0.95);
  camera.lookAt(cx, maxH * 0.35, 0);
  return { scene, camera };
}
