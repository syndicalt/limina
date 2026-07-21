import * as THREE from "three";
import { Tree } from "@dgreenheck/ez-tree";
import { createHouse } from "./house.mjs";

// ---------------------------------------------------------------------------
// buildScene — a small medieval hamlet at golden hour.
// Seven timber-framed houses ring a common with a well; a dirt path leads
// out through a gap toward the camera. Consumer sets renderer + aspect.
// ---------------------------------------------------------------------------

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = (rng, a, b) => a + (b - a) * rng();
// deterministic position hash (no rng needed, stable per-vertex)
const hash2 = (x, z) => {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
};
const std = (color, roughness = 0.95, metalness = 0, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });

function makeSkyTexture() {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = 16;
  c.height = 512;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0.0, "#6f9cd2");
  grad.addColorStop(0.45, "#a9c4de");
  grad.addColorStop(0.78, "#ddd6bd");
  grad.addColorStop(1.0, "#ecdcbb");
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeGround(rng) {
  const size = 260;
  const geo = new THREE.PlaneGeometry(size, size, 72, 72);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const cGrass = new THREE.Color(0x687c3c);
  const cGrass2 = new THREE.Color(0x7e8a46);
  const cDust = new THREE.Color(0x8d7c54);
  const tmp = new THREE.Color();
  const p1 = R(rng, 0, 6.28), p2 = R(rng, 0, 6.28), p3 = R(rng, 0, 6.28);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const r = Math.hypot(x, z);
    // keep the hamlet pad flat; gentle rolling further out
    const fall = Math.min(1, Math.max(0, (r - 17) / 14));
    const f = fall * fall * (3 - 2 * fall);
    const h =
      (Math.sin(x * 0.11 + p1) + Math.cos(z * 0.09 + p2)) * 0.42 +
      Math.sin(x * 0.23 + z * 0.31 + p3) * 0.22 +
      (hash2(x, z) - 0.5) * 0.1;
    pos.setY(i, h * f * 1.15);
    // vertex colours: mottled grass, dusty near the well/common
    const n = hash2(x * 0.7, z * 0.7);
    tmp.copy(cGrass).lerp(cGrass2, n);
    const dustAmt = Math.max(0, 1 - r / 5.5) * 0.8 + (hash2(x * 3.1, z * 3.1) < 0.06 ? 0.3 : 0);
    tmp.lerp(cDust, Math.min(1, dustAmt));
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = std(0xffffff, 1.0, 0, { vertexColors: true });
  const ground = new THREE.Mesh(geo, mat);
  ground.receiveShadow = true;
  return ground;
}

function makeWell(rng) {
  const g = new THREE.Group();
  const stone = std(0x847e70, 0.97);
  const stoneLight = std(0x948d7c, 0.95);
  const wood = std(0x4a3a28, 0.8);
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.08, 0.85, 12), stone);
  wall.position.y = 0.425;
  g.add(wall);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.1, 8, 18), stoneLight);
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.87;
  g.add(rim);
  const water = new THREE.Mesh(new THREE.CircleGeometry(0.82, 20), std(0x18242b, 0.15, 0.4));
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0.72;
  g.add(water);
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.13, 1.55, 0.13), wood);
    post.position.set(s * 1.02, 0.85 + 0.775, 0);
    g.add(post);
  }
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.3, 8), wood);
  bar.rotation.z = Math.PI / 2;
  bar.position.y = 2.28;
  g.add(bar);
  // tiny gabled cap over the winch
  for (const s of [-1, 1]) {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(2.65, 0.06, 0.85), std(0x5e4a38, 0.9));
    slab.rotation.x = s * 0.72;
    slab.position.set(0, 2.72, s * 0.27);
    g.add(slab);
  }
  const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.62, 6), std(0x9a8a66, 1));
  rope.position.y = 1.95;
  g.add(rope);
  const bucket = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.12, 0.24, 10), wood);
  bucket.position.y = 1.55;
  g.add(bucket);
  g.rotation.y = R(rng, 0, Math.PI);
  return g;
}

function makeFence(rng, length) {
  const g = new THREE.Group();
  const wood = std(0x6d5c44, 0.92);
  const n = Math.max(2, Math.round(length / 1.15) + 1);
  for (let i = 0; i < n; i++) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.9, 0.09), wood);
    post.position.set(-length / 2 + (i * length) / (n - 1), 0.42, 0);
    post.rotation.z = R(rng, -0.04, 0.04);
    g.add(post);
  }
  for (const y of [0.42, 0.7]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(length + 0.15, 0.07, 0.05), wood);
    rail.position.y = y;
    g.add(rail);
  }
  return g;
}

// Measure the generated tree's native bounding box, scale it so its height
// ≈ targetH metres, and offset so the trunk base sits exactly on y=0.
function groundAndScale(t, targetH) {
  const box = new THREE.Box3().setFromObject(t);
  const h = Math.max(0.001, box.max.y - box.min.y);
  const s = targetH / h;
  t.scale.setScalar(s);
  t.position.y = -box.min.y * s;
  t.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return t;
}

// Real ez-tree asset via its built-in presets — these are fuller and better
// tuned than a hand config. Seed varies per tree for variety.
function makeTreeAsset(preset, seed) {
  const t = new Tree();
  t.loadPreset(preset);
  t.options.seed = seed;
  t.generate();
  return t;
}

export function buildScene() {
  const rng = mulberry32(20260702);
  const scene = new THREE.Scene();

  // ---- sky + air ---------------------------------------------------------
  const sky = makeSkyTexture();
  scene.background = sky || new THREE.Color(0xb7cde4);
  scene.fog = new THREE.Fog(0xe4dcc2, 55, 185);

  // ---- lighting ----------------------------------------------------------
  const sun = new THREE.DirectionalLight(0xffd7a6, 2.8);
  sun.position.set(-37, 25, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -27; sc.right = 27; sc.top = 27; sc.bottom = -27;
  sc.near = 10; sc.far = 110;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.target.position.set(0, 0, 0);
  scene.add(sun, sun.target);

  const hemi = new THREE.HemisphereLight(0xbfd6f2, 0x8f8258, 0.55);
  scene.add(hemi);
  scene.add(new THREE.AmbientLight(0x8fa3bf, 0.12));
  // cool rim from behind the hamlet for silhouette separation
  const rim = new THREE.DirectionalLight(0xa9c4e6, 0.45);
  rim.position.set(30, 14, -34);
  scene.add(rim);

  // ---- ground + path -----------------------------------------------------
  scene.add(makeGround(rng));

  const pathMat = std(0x8b7355, 1.0, 0, { polygonOffset: true, polygonOffsetFactor: -1 });
  const ringPath = new THREE.Mesh(new THREE.RingGeometry(1.9, 3.4, 48), pathMat);
  ringPath.rotation.x = -Math.PI / 2;
  ringPath.position.y = 0.03;
  ringPath.receiveShadow = true;
  scene.add(ringPath);

  const gapAngle = (48 * Math.PI) / 180; // the open slot faces the camera
  const spurGeo = new THREE.PlaneGeometry(2.3, 15);
  spurGeo.rotateX(-Math.PI / 2);
  const spur = new THREE.Mesh(spurGeo, pathMat);
  spur.rotation.y = Math.PI / 2 - gapAngle;
  spur.position.set(Math.cos(gapAngle) * 10, 0.03, Math.sin(gapAngle) * 10);
  spur.receiveShadow = true;
  scene.add(spur);

  // ---- houses: 7 on an 8-slot ring, one slot left open toward the camera --
  const storiesBySlot = [1, 0, 2, 1, 2, 1, 2, 1]; // slot 1 skipped
  for (let i = 0; i < 8; i++) {
    if (i === 1) continue; // the gap the path runs through
    const theta = (i * 45 + 3) * (Math.PI / 180);
    const r = 11 + (i % 2) * 1.6 + R(rng, -0.4, 0.6);
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    const house = createHouse({
      seed: 11 + i * 7,
      width: R(rng, 5.4, 7.3),
      depth: R(rng, 4.4, 5.7),
      stories: storiesBySlot[i],
    });
    house.position.set(x, 0, z);
    house.rotation.y = Math.atan2(-x, -z) + R(rng, -0.12, 0.12);
    scene.add(house);
  }

  // ---- common: well at the centre ----------------------------------------
  const well = makeWell(rng);
  well.position.set(0.4, 0, 0.2);
  scene.add(well);

  // ---- fences between a couple of houses ---------------------------------
  for (const midDeg of [160.5, 295.5]) {
    const theta = (midDeg * Math.PI) / 180;
    const fence = makeFence(rng, R(rng, 3.4, 4.6));
    fence.position.set(Math.cos(theta) * 12.6, 0, Math.sin(theta) * 12.6);
    fence.rotation.y = -(theta + Math.PI / 2);
    scene.add(fence);
  }

  // ---- trees: real ez-tree assets ringing the outside of the hamlet -------
  // Mostly pines with a couple of oaks; kept well outside the house ring and
  // off the open path slot (~48°) so the common stays clear.
  const treePlan = [
    ["Pine Large", 95, 12.5],
    ["Oak Large", 148, 11.0],
    ["Pine Medium", 178, 10.0],
    ["Pine Large", 205, 12.0],
    ["Oak Large", 258, 11.5],
    ["Pine Large", 300, 12.5],
    ["Pine Large", 332, 13.0],
  ];
  let treeSeed = 1000;
  for (const [preset, deg, targetH] of treePlan) {
    const theta = ((deg + R(rng, -6, 6)) * Math.PI) / 180;
    const r = R(rng, 17.5, 22.0);
    const raw = makeTreeAsset(preset, (treeSeed += 137));
    const tree = groundAndScale(raw, targetH * R(rng, 0.92, 1.08));
    tree.position.x = Math.cos(theta) * r;
    tree.position.z = Math.sin(theta) * r;
    tree.rotation.y = R(rng, 0, Math.PI * 2);
    scene.add(tree);
  }

  // ---- bushes + rocks for life --------------------------------------------
  const bushMat = std(0x55702f, 0.98, 0, { flatShading: true });
  for (let i = 0; i < 8; i++) {
    let deg = R(rng, 0, 360);
    if (Math.abs(((deg - 48 + 540) % 360) - 180) < 30) deg += 60; // keep the gap clear
    const theta = (deg * Math.PI) / 180;
    const r = rng() < 0.5 ? R(rng, 7.4, 8.6) : R(rng, 14.6, 16.2);
    const size = R(rng, 0.35, 0.62);
    const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 1), bushMat);
    bush.position.set(Math.cos(theta) * r, size * 0.55, Math.sin(theta) * r);
    bush.scale.y = 0.72;
    bush.rotation.y = R(rng, 0, Math.PI);
    bush.castShadow = true;
    bush.receiveShadow = true;
    scene.add(bush);
  }
  const rockMat = std(0x7b7568, 0.98, 0, { flatShading: true });
  for (let i = 0; i < 7; i++) {
    const theta = R(rng, 0, Math.PI * 2);
    const r = i < 2 ? R(rng, 4.2, 6.0) : R(rng, 13.8, 18.5);
    const size = R(rng, 0.22, 0.5);
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(size, 0), rockMat);
    rock.position.set(Math.cos(theta) * r, size * 0.42, Math.sin(theta) * r);
    rock.rotation.set(R(rng, 0, 3), R(rng, 0, 3), R(rng, 0, 3));
    rock.scale.y = 0.7;
    rock.castShadow = true;
    rock.receiveShadow = true;
    scene.add(rock);
  }

  // ---- camera: elevated 3/4 view down the open slot ------------------------
  const camera = new THREE.PerspectiveCamera(44, 1, 0.1, 500);
  camera.position.set(24, 19, 27);
  camera.lookAt(0, 1, 0);

  return { scene, camera };
}
