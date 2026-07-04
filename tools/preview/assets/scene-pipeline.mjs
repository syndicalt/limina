import * as THREE from "three";
import { Tree } from "@dgreenheck/ez-tree";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// ---------------------------------------------------------------------------
// buildScene — limina's build pipeline run IN ORDER, as one legible file.
//
//   1. TERRAIN     the world exists first (flat 120×120m ground)
//   2. CLIMATE     the world has weather (temperate, AUTUMN)
//   3. VEGETATION  nature grows everywhere, climate-aware (autumn deciduous)
//   4. STRUCTURES  civilization builds — and CLEARS the vegetation it displaces
//   5. CAMERA      intelligence looks at what it made
//
// The causal model: each stage only reads what earlier stages produced.
// Consumer sets up the renderer (WebGL, PCF soft shadows, ACES, sRGB)
// and the aspect ratio; we set lights, materials, shadows and camera.
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
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];
// stable per-position hash for vertex mottling (no rng state consumed)
const hash2 = (x, z) => {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
};

export async function buildScene() {
  const rng = mulberry32(20261003); // fixed seed — the whole pipeline is deterministic
  const scene = new THREE.Scene();

  // ---- sky, air, light (autumn afternoon, golden hour) --------------------
  scene.background = new THREE.Color(0xc3d1e2);
  scene.fog = new THREE.Fog(0xd9d2bc, 70, 260);

  const sun = new THREE.DirectionalLight(0xffcf9c, 2.5);
  sun.position.set(-44, 27, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -58; sc.right = 58; sc.top = 58; sc.bottom = -58;
  sc.near = 5; sc.far = 160;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.target.position.set(0, 0, 0);
  scene.add(sun, sun.target);

  scene.add(new THREE.HemisphereLight(0xc6d6ec, 0x97804f, 0.55));
  scene.add(new THREE.AmbientLight(0x9a8a6e, 0.12));

  // =========================================================================
  // STAGE 1: TERRAIN — the world exists first.
  // Flat 120×120m ground at y=0 (robust: everything below seats on y=0).
  // Mottled autumn-grass vertex colours; no displacement.
  // =========================================================================
  const TERRAIN_SIZE = 120;
  {
    const geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, 64, 64);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const cGrass = new THREE.Color(0x6a7a3c);
    const cGrass2 = new THREE.Color(0x83853f);
    const cTawny = new THREE.Color(0x9a7f3e); // autumn-cured patches
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      tmp.copy(cGrass).lerp(cGrass2, hash2(x * 0.61, z * 0.61));
      tmp.lerp(cTawny, hash2(x * 0.17 + 9.1, z * 0.17 + 4.7) * 0.45);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const ground = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1.0, metalness: 0, vertexColors: true })
    );
    ground.receiveShadow = true;
    scene.add(ground);
  }

  // =========================================================================
  // STAGE 2: CLIMATE — hard-coded for this run: temperate, AUTUMN.
  // This is the single source the vegetation pass reads: conifers stay
  // evergreen; deciduous species take a warm autumn tint; moderate density.
  // =========================================================================
  const CLIMATE = {
    biome: "temperate",
    season: "autumn",
    treeCount: 62, // moderate density over 120×120m
    // species mix: mostly evergreen conifers + some deciduous
    species: [
      { preset: "Pine Large", deciduous: false, height: [11, 13], weight: 0.34 },
      { preset: "Pine Medium", deciduous: false, height: [9, 11], weight: 0.30 },
      { preset: "Oak Large", deciduous: true, height: [9.5, 12], weight: 0.20 },
      { preset: "Aspen Large", deciduous: true, height: [9, 11.5], weight: 0.16 },
    ],
    autumnLeafHues: [0xd9a233 /* gold */, 0xc46a1f /* orange */, 0x9c4a1a /* russet */],
  };

  // =========================================================================
  // STAGE 3: VEGETATION PASS — nature grows it, everywhere, climate-aware.
  // Seeded scatter across the WHOLE terrain (structures clear their patch in
  // stage 4, so we deliberately do not avoid the centre here). Trees are NOT
  // added to the scene yet — stage 4 gets to erase some first.
  // =========================================================================
  const pickSpecies = () => {
    let r = rng();
    for (const s of CLIMATE.species) {
      r -= s.weight;
      if (r <= 0) return s;
    }
    return CLIMATE.species[0];
  };

  const tintAutumn = (tree) => {
    const hue = new THREE.Color(pick(rng, CLIMATE.autumnLeafHues));
    hue.offsetHSL(R(rng, -0.015, 0.015), R(rng, -0.05, 0.05), R(rng, -0.04, 0.04));
    // ez-tree builds the foliage as tree.leavesMesh (bark is branchesMesh).
    if (tree.leavesMesh && tree.leavesMesh.material) {
      tree.leavesMesh.material.color.copy(hue);
      return;
    }
    // Fallback heuristic: any non-trunk mesh whose material reads greenish.
    tree.traverse((o) => {
      if (o.isMesh && o.material && o.material.color) {
        const c = o.material.color;
        if (c.g > c.r && c.g > c.b) o.material.color.copy(hue);
      }
    });
  };

  const grown = []; // { obj, x, z } — candidates; stage 4 filters them
  {
    const half = TERRAIN_SIZE / 2 - 5; // keep canopies on the terrain
    const minDist = 4.2;
    let treeSeed = 5000;
    let attempts = 0;
    while (grown.length < CLIMATE.treeCount && attempts < CLIMATE.treeCount * 30) {
      attempts++;
      const x = R(rng, -half, half);
      const z = R(rng, -half, half);
      if (grown.some((t) => (t.x - x) * (t.x - x) + (t.z - z) * (t.z - z) < minDist * minDist)) continue;

      const species = pickSpecies();
      const tree = new Tree();
      tree.loadPreset(species.preset);
      tree.options.seed = (treeSeed += 131);
      tree.generate();

      // CLIMATE-AWARE STATE: deciduous trees wear autumn; conifers stay green.
      if (species.deciduous) tintAutumn(tree);

      // Box3-measure → scale to a real height, seat the base exactly at y=0.
      const targetH = R(rng, species.height[0], species.height[1]) * R(rng, 0.92, 1.08);
      const box = new THREE.Box3().setFromObject(tree);
      const s = targetH / Math.max(0.001, box.max.y - box.min.y);
      tree.scale.setScalar(s);
      tree.position.set(x, -box.min.y * s, z);
      tree.rotation.y = R(rng, 0, Math.PI * 2);
      tree.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      grown.push({ obj: tree, x, z });
    }
  }

  // =========================================================================
  // STAGE 4: STRUCTURES PASS — civilization builds, and CLEARS (subtractive).
  // A hamlet of 6 library houses around a small common, plus a dirt path.
  // Every tree whose (x,z) falls inside a house's world AABB expanded by a
  // clearing margin — or inside the path strip — is ERASED before it ever
  // reaches the scene. The clearing is a consequence, not a layout choice.
  // =========================================================================
  const CLEAR_MARGIN = 3; // metres beyond each house's footprint
  const clearRects = []; // { minX, maxX, minZ, maxZ } in world XZ

  {
    const gltf = await new GLTFLoader().loadAsync("/assets/library/medieval-house.glb");
    const houseProto = gltf.scene;

    // Loose ring around a common. Slots 0 and 3 sit exactly on the X axis so
    // the path between them runs straight through the green.
    const slots = [
      { deg: 0, jitter: false },
      { deg: 63, jitter: true },
      { deg: 122, jitter: true },
      { deg: 180, jitter: false },
      { deg: 244, jitter: true },
      { deg: 299, jitter: true },
    ];
    for (const slot of slots) {
      const deg = slot.deg + (slot.jitter ? R(rng, -7, 7) : 0);
      const r = 12 + R(rng, -1.2, 1.4);
      const theta = (deg * Math.PI) / 180;
      const x = Math.cos(theta) * r;
      const z = Math.sin(theta) * r;

      const house = houseProto.clone(true);
      house.position.set(x, 0, z);
      // yaw to face the common, with a touch of human imprecision
      house.rotation.y = Math.atan2(-x, -z) + R(rng, -0.1, 0.1);
      house.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      scene.add(house);

      // world AABB in XZ + clearing margin → one subtractive rect
      const bb = new THREE.Box3().setFromObject(house);
      clearRects.push({
        minX: bb.min.x - CLEAR_MARGIN,
        maxX: bb.max.x + CLEAR_MARGIN,
        minZ: bb.min.z - CLEAR_MARGIN,
        maxZ: bb.max.z + CLEAR_MARGIN,
      });
    }

    // Dirt path between the two axis-aligned houses (through the common).
    const pathLen = 17, pathW = 2.2;
    const path = new THREE.Mesh(
      new THREE.BoxGeometry(pathLen, 0.06, pathW),
      new THREE.MeshStandardMaterial({ color: 0x83683f, roughness: 1.0, metalness: 0 })
    );
    path.position.set(0, 0.03, 0);
    path.receiveShadow = true;
    scene.add(path);
    clearRects.push({
      minX: -pathLen / 2 - 1,
      maxX: pathLen / 2 + 1,
      minZ: -pathW / 2 - 2,
      maxZ: pathW / 2 + 2,
    });
  }

  // THE KEY MECHANIC — clearing: erase every tree that collides with
  // civilization; only the survivors join the scene.
  const inAnyRect = (x, z) =>
    clearRects.some((rc) => x >= rc.minX && x <= rc.maxX && z >= rc.minZ && z <= rc.maxZ);

  let cleared = 0;
  for (const t of grown) {
    if (inAnyRect(t.x, t.z)) {
      cleared++;
      continue;
    }
    scene.add(t.obj);
  }
  console.log(
    `[scene-pipeline] vegetation grew ${grown.length} trees; ` +
      `structures cleared ${cleared}; ${grown.length - cleared} remain around the hamlet`
  );

  // =========================================================================
  // STAGE 5: CAMERA — an elevated 3/4 view: the hamlet in its clearing,
  // ringed by the forest that grew everywhere else.
  // =========================================================================
  const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 500);
  camera.position.set(38, 26, 42);
  camera.lookAt(0, 1.5, 0);

  return { scene, camera };
}
