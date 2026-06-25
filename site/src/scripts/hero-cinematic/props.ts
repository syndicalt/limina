// Procedural stylised low-poly genre props. Each builder returns a prototype
// Object3D; world.ts clones it per instance (clones share geometry/material, so
// memory stays flat). Materials use flatShading for the engine's low-poly look.
import * as THREE from 'three';
import { BRAND, type PropKind } from './manifest';

export type Rng = () => number;

// mulberry32 — deterministic seeded RNG for repeatable placement.
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const std = (params: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(params);

function pineTree(): THREE.Object3D {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.18, 0.7, 6),
    std({ color: 0x5b3b22, roughness: 1, flatShading: true }),
  );
  trunk.position.y = 0.35;
  g.add(trunk);
  const foliage = std({ color: 0x2f6b32, roughness: 0.95, flatShading: true });
  for (let i = 0; i < 3; i++) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.7 - i * 0.18, 0.85, 7), foliage);
    cone.position.y = 0.9 + i * 0.55;
    g.add(cone);
  }
  return g;
}

function roundTree(): THREE.Object3D {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.13, 0.17, 0.8, 6),
    std({ color: 0x5b3b22, roughness: 1, flatShading: true }),
  );
  trunk.position.y = 0.4;
  g.add(trunk);
  const crown = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.85, 1),
    std({ color: 0x3f8a45, roughness: 0.9, flatShading: true }),
  );
  crown.position.y = 1.5;
  crown.scale.set(1, 0.9, 1);
  g.add(crown);
  return g;
}

function rock(): THREE.Object3D {
  const geo = new THREE.IcosahedronGeometry(0.8, 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const rng = makeRng(1337);
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) * (0.7 + rng() * 0.6),
      pos.getY(i) * (0.6 + rng() * 0.5),
      pos.getZ(i) * (0.7 + rng() * 0.6),
    );
  }
  const m = new THREE.Mesh(geo, std({ color: 0x6f685d, roughness: 1, flatShading: true }));
  m.position.y = 0.3;
  return m;
}

function cactus(): THREE.Object3D {
  const g = new THREE.Group();
  const mat = std({ color: 0x3f7d3a, roughness: 0.9, flatShading: true });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 1.1, 4, 8), mat);
  body.position.y = 0.9;
  g.add(body);
  for (const sgn of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.5, 4, 8), mat);
    arm.position.set(sgn * 0.32, 1.0, 0);
    arm.rotation.z = sgn * 0.9;
    g.add(arm);
    const up = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.4, 4, 8), mat);
    up.position.set(sgn * 0.46, 1.35, 0);
    g.add(up);
  }
  return g;
}

function mushroom(): THREE.Object3D {
  const g = new THREE.Group();
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.13, 0.5, 7),
    std({ color: 0xe8e0cf, roughness: 0.8, flatShading: true }),
  );
  stem.position.y = 0.25;
  g.add(stem);
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.34, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    std({ color: BRAND.magenta, emissive: BRAND.magenta, emissiveIntensity: 0.6, roughness: 0.6, flatShading: true }),
  );
  cap.position.y = 0.5;
  cap.scale.y = 0.7;
  g.add(cap);
  return g;
}

function crystal(): THREE.Object3D {
  const m = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.5, 0),
    std({
      color: BRAND.cyan,
      emissive: BRAND.cyan,
      emissiveIntensity: 1.1,
      metalness: 0.2,
      roughness: 0.2,
      flatShading: true,
      transparent: true,
      opacity: 0.92,
    }),
  );
  m.position.y = 0.7;
  m.scale.y = 1.7;
  return m;
}

function scifiPillar(): THREE.Object3D {
  const g = new THREE.Group();
  const col = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 3.2, 0.5),
    std({ color: 0x161a26, metalness: 0.85, roughness: 0.3, flatShading: false }),
  );
  col.position.y = 1.6;
  g.add(col);
  const band = std({ color: BRAND.cyan, emissive: BRAND.cyan, emissiveIntensity: 1.4 });
  for (let i = 0; i < 4; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.08, 0.54), band);
    b.position.y = 0.6 + i * 0.8;
    g.add(b);
  }
  return g;
}

function scifiPanel(): THREE.Object3D {
  const g = new THREE.Group();
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 1.0, 0.08),
    std({ color: 0x10131c, metalness: 0.8, roughness: 0.35 }),
  );
  g.add(frame);
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(1.4, 0.82),
    std({ color: BRAND.violet, emissive: BRAND.violet, emissiveIntensity: 1.3, side: THREE.DoubleSide }),
  );
  screen.position.z = 0.05;
  g.add(screen);
  g.position.y = 1.8;
  return g;
}

function house(): THREE.Object3D {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(2, 1.6, 2.2),
    std({ color: 0xe7d8c0, roughness: 0.9, flatShading: true }),
  );
  body.position.y = 0.8;
  g.add(body);
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(1.8, 1.1, 4),
    std({ color: 0x9a4a3a, roughness: 0.9, flatShading: true }),
  );
  roof.position.y = 2.15;
  roof.rotation.y = Math.PI / 4;
  g.add(roof);
  const win = std({ color: BRAND.amber, emissive: BRAND.amber, emissiveIntensity: 0.9 });
  for (const x of [-0.5, 0.5]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.05), win);
    w.position.set(x, 0.9, 1.13);
    g.add(w);
  }
  return g;
}

function fence(): THREE.Object3D {
  const g = new THREE.Group();
  const wood = std({ color: 0x6b4a2c, roughness: 1, flatShading: true });
  for (let i = 0; i < 3; i++) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.9, 0.12), wood);
    post.position.set(-0.8 + i * 0.8, 0.45, 0);
    g.add(post);
  }
  for (const y of [0.35, 0.7]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.1, 0.08), wood);
    rail.position.set(0, y, 0);
    g.add(rail);
  }
  return g;
}

function lamp(): THREE.Object3D {
  const g = new THREE.Group();
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.08, 2.0, 6),
    std({ color: 0x2a2f3a, metalness: 0.7, roughness: 0.4 }),
  );
  post.position.y = 1.0;
  g.add(post);
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 12, 12),
    std({ color: BRAND.amber, emissive: BRAND.amber, emissiveIntensity: 1.6 }),
  );
  bulb.position.y = 2.05;
  g.add(bulb);
  return g;
}

const BUILDERS: Record<PropKind, () => THREE.Object3D> = {
  pineTree,
  roundTree,
  rock,
  cactus,
  mushroom,
  crystal,
  scifiPillar,
  scifiPanel,
  house,
  fence,
  lamp,
};

const cache = new Map<PropKind, THREE.Object3D>();

/** Prototype for a kind (cached). Clone it per instance — clones share geo/mat. */
export function prototype(kind: PropKind): THREE.Object3D {
  let p = cache.get(kind);
  if (!p) {
    p = BUILDERS[kind]();
    p.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = true;
    });
    cache.set(kind, p);
  }
  return p;
}

/** Emissive kinds bloom; flag for the bloom selection layer. */
export const EMISSIVE_KINDS: ReadonlySet<PropKind> = new Set<PropKind>([
  'crystal',
  'mushroom',
  'scifiPillar',
  'scifiPanel',
  'lamp',
]);

export function disposePropCache() {
  for (const p of cache.values()) {
    p.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      }
    });
  }
  cache.clear();
}
