// Isolated worlds. Each world is its own group built along its OWN local run
// path (all share start (0,0,0) and end (PATH_LEN,0,0); fantasy winds between).
// Only the active world is visible. The portal (portals.ts) is a gateway at the
// shared path end; the white wash hides the swap. IBL per world from Poly Haven.
import * as THREE from 'three';
import { PHASES, DRESSING, BRAND, BLOOM_LAYER, type PhaseId, type DressRow } from './manifest';
import { prototype, makeRng, EMISSIVE_KINDS } from './props';
import type { Quality } from './quality';

export const PATH_LEN = 42;
const WORLD_PHASES: PhaseId[] = ['builder', 'fantasy', 'western', 'scifi', 'sim'];

export interface SkillProp {
  position: THREE.Vector3;
  object: THREE.Object3D;
}

export interface World {
  paths: Record<PhaseId, THREE.CatmullRomCurve3>;
  gatewayPath: THREE.CatmullRomCurve3;
  setActiveWorld(phase: PhaseId): void;
  skillPropsFor(phase: PhaseId): SkillProp[];
  update(dt: number, agentPos: THREE.Vector3, t: number): void;
  setComposite(v: number): void;
  setReturnPanels(on: boolean): void;
  dispose(): void;
}

function makeSky(top: number, bottom: number): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  const hx = (n: number) => '#' + n.toString(16).padStart(6, '0');
  g.addColorStop(0, hx(top));
  g.addColorStop(1, hx(bottom));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Procedural deep-space skybox: starfield + brand-tinted nebulae + a distant sun.
function makeSpaceSky(): THREE.Texture {
  const w = 2048, h = 1024;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  let s = 1337;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;

  const base = ctx.createLinearGradient(0, 0, 0, h);
  base.addColorStop(0, '#05060f');
  base.addColorStop(0.5, '#080a1a');
  base.addColorStop(1, '#03040a');
  ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);

  // nebula clouds (additive, brand hues)
  const neb = ['#3a2a6e', '#1f5f7a', '#6e2a5a', '#2a3a8a', '#1a6a6a'];
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 22; i++) {
    const x = rnd() * w, y = rnd() * h * 0.92, r = 180 + rnd() * 380;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, neb[Math.floor(rnd() * neb.length)]);
    g.addColorStop(1, 'transparent');
    ctx.globalAlpha = 0.16 + rnd() * 0.22;
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';

  // stars
  for (let i = 0; i < 1500; i++) {
    const x = rnd() * w, y = rnd() * h;
    const r = rnd() < 0.92 ? rnd() * 0.9 + 0.3 : rnd() * 1.8 + 1.0;
    ctx.fillStyle = `rgba(255,255,255,${0.45 + rnd() * 0.55})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  const starCols = ['#9fd8ff', '#ffd9a0', '#ffb0c0'];
  for (let i = 0; i < 70; i++) {
    ctx.fillStyle = starCols[Math.floor(rnd() * starCols.length)];
    ctx.beginPath(); ctx.arc(rnd() * w, rnd() * h, rnd() * 1.2 + 0.6, 0, Math.PI * 2); ctx.fill();
  }

  // distant sun with glow
  const sx = w * 0.72, sy = h * 0.28;
  ctx.globalCompositeOperation = 'lighter';
  const halo = ctx.createRadialGradient(sx, sy, 0, sx, sy, 170);
  halo.addColorStop(0, 'rgba(255,250,235,0.95)');
  halo.addColorStop(0.18, 'rgba(255,235,200,0.55)');
  halo.addColorStop(0.5, 'rgba(120,160,255,0.16)');
  halo.addColorStop(1, 'transparent');
  ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(sx, sy, 170, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fffdf5'; ctx.beginPath(); ctx.arc(sx, sy, 17, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}

function gravelTexture(): THREE.Texture {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  // packed dirt base with a little tonal noise
  ctx.fillStyle = '#5f574c';
  ctx.fillRect(0, 0, s, s);
  const rng = makeRng(99);
  for (let i = 0; i < 1400; i++) {
    const x = rng() * s;
    const y = rng() * s;
    const r = 1 + rng() * rng() * 5; // mostly small, a few larger
    // grey-brown pebbles with random tone; occasional dark gap or light fleck
    const roll = rng();
    let base: number;
    if (roll < 0.16) base = 60 + rng() * 25; // dark gap
    else if (roll > 0.9) base = 165 + rng() * 40; // light fleck
    else base = 95 + rng() * 55;
    const warm = rng() * 12;
    ctx.fillStyle = `rgb(${Math.round(base + warm)},${Math.round(base + warm * 0.4)},${Math.round(base - 6)})`;
    ctx.beginPath();
    const rot = rng() * Math.PI;
    ctx.ellipse(x, y, r, r * (0.6 + rng() * 0.4), rot, 0, Math.PI * 2);
    ctx.fill();
  }
  // fine grit speckle
  for (let i = 0; i < 4000; i++) {
    const g = 40 + Math.floor(rng() * 170);
    ctx.fillStyle = `rgba(${g},${g - 4},${g - 10},0.35)`;
    ctx.fillRect(rng() * s, rng() * s, 1, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function holoPanelTexture(title: string, rows: string[]): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 320;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(7,12,22,0.9)';
  ctx.fillRect(0, 0, 512, 320);
  ctx.strokeStyle = 'rgba(47,230,214,0.5)';
  ctx.lineWidth = 3;
  ctx.strokeRect(6, 6, 500, 308);
  ctx.fillStyle = '#2fe6d6';
  ctx.font = 'bold 30px monospace';
  ctx.fillText(title, 24, 50);
  ctx.font = '22px monospace';
  ctx.fillStyle = '#9fd9ff';
  rows.forEach((r, i) => ctx.fillText(r, 24, 96 + i * 36));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Final-scene hologram: the Limina wordmark (replaces the centre dev panel on the
// return so the closing room reads differently from the opening).
function holoBrandTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 320;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(7,12,22,0.92)';
  ctx.fillRect(0, 0, 512, 320);
  ctx.strokeStyle = 'rgba(139,107,255,0.6)';
  ctx.lineWidth = 3;
  ctx.strokeRect(6, 6, 500, 308);
  const g = ctx.createLinearGradient(40, 0, 472, 0);
  g.addColorStop(0, '#2fe6d6');
  g.addColorStop(1, '#8b6bff');
  ctx.textAlign = 'center';
  ctx.fillStyle = g;
  ctx.font = 'bold 70px system-ui, sans-serif';
  ctx.fillText('LIMINA', 256, 150);
  ctx.fillStyle = '#cfe0ff';
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.fillText('E N G I N E', 256, 200);
  ctx.fillStyle = 'rgba(159,217,255,0.75)';
  ctx.font = '20px monospace';
  ctx.fillText('real-time · agent-native', 256, 250);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function cardTexture(name: string, top: number, bottom: number): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 160;
  const ctx = c.getContext('2d')!;
  const hx = (n: number) => '#' + n.toString(16).padStart(6, '0');
  const g = ctx.createLinearGradient(0, 0, 0, 160);
  g.addColorStop(0, hx(top));
  g.addColorStop(1, hx(bottom));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 160);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 4;
  ctx.strokeRect(5, 5, 246, 150);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(name, 128, 92);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildPath(phase: PhaseId): THREE.CatmullRomCurve3 {
  const L = PATH_LEN;
  const pts: THREE.Vector3[] = [];
  if (phase === 'fantasy') {
    // winding lane through the city, straightening into the gateway
    pts.push(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(7, 0, 2.4),
      new THREE.Vector3(15, 0, -2.2),
      new THREE.Vector3(23, 0, 2.2),
      new THREE.Vector3(30, 0, -1.6),
      new THREE.Vector3(36, 0, 0.4),
      new THREE.Vector3(L, 0, 0),
    );
  } else if (phase === 'western') {
    // one turn around a mesa, then straight up over the river bridge to the gateway
    pts.push(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(9, 0, 1),
      new THREE.Vector3(16, 0, 5),
      new THREE.Vector3(22, 0, 5),
      new THREE.Vector3(27, 0, 0.4),
      new THREE.Vector3(30, 0, 0),     // straight + centred well before the bridge
      new THREE.Vector3(31, 0.25, 0),  // flat wood deck (y = walkable surface) across the span
      new THREE.Vector3(35, 0.25, 0),
      new THREE.Vector3(39, 0.25, 0),
      new THREE.Vector3(40.5, 0, 0),
      new THREE.Vector3(L, 0, 0),
    );
  } else if (phase === 'sim') {
    // residential street, then a hard right down a side street to the gateway
    pts.push(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(9, 0, 0),
      new THREE.Vector3(18, 0, 0),
      new THREE.Vector3(22, 0, 0.4),   // approach the corner
      new THREE.Vector3(23.5, 0, 3),   // hard right → side street (+Z)
      new THREE.Vector3(23.5, 0, 11),
      new THREE.Vector3(23.5, 0, 19),
      new THREE.Vector3(23.5, 0, 26),
    );
  } else {
    for (let i = 0; i <= 6; i++) pts.push(new THREE.Vector3((i / 6) * L, 0, Math.sin(i * 0.7) * 0.6));
  }
  return new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
}

export function buildWorld(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  quality: Quality,
  envMaps: Partial<Record<PhaseId, THREE.Texture>>,
  kit: Partial<Record<PhaseId, Record<string, THREE.Object3D>>> = {},
  bgMaps: Partial<Record<PhaseId, THREE.Texture>> = {},
): World {
  const disposables: { dispose(): void }[] = [];
  const protoCache = new Map<string, { proto: THREE.Object3D; h: number; w: number }>();
  const half = PATH_LEN / 2;

  const paths = {} as Record<PhaseId, THREE.CatmullRomCurve3>;
  for (const ph of WORLD_PHASES) paths[ph] = buildPath(ph);

  const SKY: Record<PhaseId, THREE.Texture | number> = {
    builder: BRAND.bg,
    fantasy: makeSky(0x8fb6d8, 0xcfe0d8),
    western: makeSky(0x9fb4d6, 0xd9b375),
    scifi: makeSpaceSky(),
    sim: makeSky(0x7fb4ef, 0xcfe0ff),
  };
  for (const v of Object.values(SKY)) if (v instanceof THREE.Texture) disposables.push(v);

  // ---- shared placement helpers ------------------------------------------
  const tmp = new THREE.Vector3();
  function scatter(group: THREE.Group, path: THREE.CatmullRomCurve3, rows: DressRow[], seed: number): SkillProp[] {
    const rng = makeRng(seed);
    const skills: SkillProp[] = [];
    for (const row of rows) {
      const count = Math.max(1, Math.round(row.count * quality.instanceScale));
      let nearest: { d: number; obj: THREE.Object3D } | null = null;
      for (let i = 0; i < count; i++) {
        const u = row.along[0] + (row.along[1] - row.along[0]) * rng();
        path.getPointAt(Math.min(0.999, Math.max(0.001, u)), tmp);
        const side = rng() < 0.5 ? -1 : 1;
        const off = row.spread[0] + rng() * (row.spread[1] - row.spread[0]);
        const inst = prototype(row.kind).clone(true);
        const sc = row.scale[0] + rng() * (row.scale[1] - row.scale[0]);
        inst.scale.multiplyScalar(sc);
        inst.position.set(tmp.x, tmp.y, tmp.z + side * off);
        inst.rotation.y = rng() * Math.PI * 2;
        if (EMISSIVE_KINDS.has(row.kind)) inst.traverse((o) => o.layers.enable(BLOOM_LAYER));
        group.add(inst);
        if (row.skillProp) {
          const d = Math.abs(off);
          if (!nearest || d < nearest.d) nearest = { d, obj: inst };
        }
      }
      if (row.skillProp && nearest) {
        const p = new THREE.Vector3();
        nearest.obj.getWorldPosition(p);
        skills.push({ position: p.setY(1.2), object: nearest.obj });
      }
    }
    return skills;
  }

  function addGround(group: THREE.Group, color: number, rough: number, metal: number, depth = 70, width = PATH_LEN + 16) {
    const geo = new THREE.PlaneGeometry(width, depth);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(half, 0, 0);
    m.receiveShadow = true;
    group.add(m);
    disposables.push(geo, mat);
  }

  // ---- per-world groups ---------------------------------------------------
  const worldGroups: Record<PhaseId, THREE.Group> = {} as Record<PhaseId, THREE.Group>;
  const skillProps: Record<PhaseId, SkillProp[]> = {} as Record<PhaseId, SkillProp[]>;
  const holo: THREE.Mesh[] = [];
  const holoStartTex: THREE.Texture[] = [];
  const holoFinalTex: THREE.Texture[] = [];

  for (const phase of WORLD_PHASES) {
    const group = new THREE.Group();
    group.visible = false;
    scene.add(group);
    worldGroups[phase] = group;
    const rows = DRESSING[phase] ?? [];
    const path = paths[phase];

    if (phase === 'builder') {
      const floorGeo = new THREE.PlaneGeometry(PATH_LEN + 16, 52);
      const floorMat = new THREE.MeshStandardMaterial({ color: 0x0a0f1c, roughness: 0.55, metalness: 0.6 });
      const floor = new THREE.Mesh(floorGeo, floorMat);
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(half, 0, 0);
      floor.receiveShadow = true;
      group.add(floor);
      disposables.push(floorGeo, floorMat);
      const grid = new THREE.GridHelper(PATH_LEN + 16, PATH_LEN + 16, BRAND.teal, 0x15514c);
      (grid.material as THREE.Material).transparent = true;
      (grid.material as THREE.Material).opacity = 0.3;
      grid.position.set(half, 0.02, 0);
      group.add(grid);

      const panelData = [
        ['ENTITY INSPECTOR', ['ent_8f3 · agent', 'pos 12.4 0 3.1', 'state: perceiving']],
        ['SKILL REGISTRY', ['scene.spawn  ✓', 'three.setMaterial ✓', 'physics.raycast ✓']],
        ['TRACE VIEWER', ['skill.invoked', '└ permission ok', '└ emitted event']],
      ];
      const place: [number, number, number, number][] = [
        [half - 8, 3.0, -6, -Math.PI / 2 + 0.35],
        [half, 5.0, 1.5, -Math.PI / 2],
        [half - 8, 3.0, 6, -Math.PI / 2 - 0.35],
      ];
      const panelDataFinal = [
        ['SESSION TRACE', ['5 worlds traversed', '14 skills · 0 denied', 'fully observed']],
        ['LIMINA ENGINE', [] as string[]],
        ['RUN COMPLETE', ['agent · returned home', 'perception → action ✓', 'ready to replay']],
      ];
      panelData.forEach((d, i) => {
        const startTex = holoPanelTexture(d[0] as string, d[1] as string[]);
        const finalTex = i === 1
          ? holoBrandTexture()
          : holoPanelTexture(panelDataFinal[i][0] as string, panelDataFinal[i][1] as string[]);
        const mat = new THREE.MeshBasicMaterial({
          map: startTex,
          transparent: true,
          opacity: 1,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 2.7), mat);
        const [px, py, pz, ry] = place[i];
        panel.position.set(px, py, pz);
        panel.rotation.y = ry;
        panel.layers.enable(BLOOM_LAYER);
        group.add(panel);
        holo.push(panel);
        holoStartTex.push(startTex);
        holoFinalTex.push(finalTex);
        disposables.push(startTex, finalTex, mat, panel.geometry);
      });

      const pTeal = new THREE.PointLight(BRAND.teal, 50, 30, 2);
      pTeal.position.set(half - 4, 3, 2);
      const pMag = new THREE.PointLight(BRAND.magenta, 40, 34, 2);
      pMag.position.set(half + 2, 3, -5);
      group.add(pTeal, pMag);

      skillProps[phase] = scatter(group, path, rows, 11);
    } else if (phase === 'fantasy') {
      addGround(group, 0x40683a, 0.95, 0, 150, 150);
      skillProps[phase] = buildFantasy(group, path);
    } else if (phase === 'scifi') {
      addGround(group, 0x0c0f18, 0.35, 0.6);
      skillProps[phase] = buildScifi(group, path);
    } else if (phase === 'western') {
      skillProps[phase] = buildWestern(group, path);
    } else if (phase === 'sim') {
      addGround(group, 0x4f7a43, 0.95, 0, 150, 150); // grass lawns
      skillProps[phase] = buildSim(group, path);
    } else {
      addGround(group, 0x3f7a44, 0.9, 0);
      skillProps[phase] = scatter(group, path, rows, 67);
    }
  }

  // KayKit building helpers ---------------------------------------------------
  function prepProto(name: string, kitMap: Record<string, THREE.Object3D>) {
    let rec = protoCache.get(name);
    if (rec) return rec;
    const proto = kitMap[name];
    proto.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const mm = mesh.material as THREE.MeshStandardMaterial;
        if (mm && 'envMapIntensity' in mm) mm.envMapIntensity = 0.5;
      }
    });
    proto.updateMatrixWorld(true);
    const size = new THREE.Vector3();
    new THREE.Box3().setFromObject(proto).getSize(size);
    rec = { proto, h: size.y || 1, w: Math.max(size.x, size.z) || 1 };
    protoCache.set(name, rec);
    return rec;
  }

  function buildFantasy(group: THREE.Group, path: THREE.CatmullRomCurve3): SkillProp[] {
    const fantasyKit = kit.fantasy ?? {};
    const all = Object.keys(fantasyKit);
    const buildingNames = all.filter((n) => /building/.test(n) && !/castle/.test(n));
    const treeNames = all.filter((n) => /^tree/.test(n));
    const rockNames = all.filter((n) => /^rock/.test(n));
    const mountainNames = all.filter((n) => /^mountain/.test(n));
    const cloudNames = all.filter((n) => /^cloud/.test(n));
    const skills: SkillProp[] = [];

    // winding gravel road ribbon -----------------------------------------
    const cob = gravelTexture();
    disposables.push(cob);
    const N = 140;
    const halfW = 2.4;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    const pt = new THREE.Vector3();
    const tan = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    const prev = new THREE.Vector3();
    let len = 0;
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      path.getPointAt(u, pt);
      path.getTangentAt(u, tan).normalize();
      nrm.crossVectors(tan, up).normalize();
      if (i > 0) len += pt.distanceTo(prev);
      prev.copy(pt);
      positions.push(pt.x - nrm.x * halfW, 0.03, pt.z - nrm.z * halfW);
      positions.push(pt.x + nrm.x * halfW, 0.03, pt.z + nrm.z * halfW);
      const v = len / 2.2; // fine tiling → small gravel
      uvs.push(0, v, 2.0, v); // ~2 repeats across the width
    }
    for (let i = 0; i < N; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const roadGeo = new THREE.BufferGeometry();
    roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    roadGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    roadGeo.setIndex(indices);
    roadGeo.computeVertexNormals();
    const roadMat = new THREE.MeshStandardMaterial({ map: cob, roughness: 0.95 });
    const road = new THREE.Mesh(roadGeo, roadMat);
    road.receiveShadow = true;
    group.add(road);
    disposables.push(roadGeo, roadMat);

    const rng = makeRng(20240611);
    const inward = new THREE.Vector3();
    const KIT = 4.1; // uniform kit scale tuned to the ~1.8u agent (cottage ≈ 2× agent)
    const placeAt = (name: string, x: number, z: number, targetH: number, ry: number) => {
      const pk = prepProto(name, fantasyKit);
      const inst = pk.proto.clone(true);
      inst.scale.multiplyScalar(targetH / pk.h);
      inst.position.set(x, 0, z);
      inst.rotation.y = ry;
      group.add(inst);
      return inst;
    };
    const placeScaled = (name: string, x: number, z: number, mul: number, ry: number) => {
      const pk = prepProto(name, fantasyKit);
      const inst = pk.proto.clone(true);
      inst.scale.multiplyScalar(mul);
      inst.position.set(x, 0, z);
      inst.rotation.y = ry;
      group.add(inst);
      return inst;
    };

    // buildings lining the road — placed sequentially by footprint width so they
    // never overlap (advance along the path by width+gap; offset by half-width off
    // the road edge). One dense row per side; trees fill behind.
    if (buildingNames.length) {
      const pathLen = path.getLength();
      let k = 0;
      for (const side of [-1, 1] as const) {
        let u = 0.04;
        while (u <= 0.95) {
          const name = buildingNames[k % buildingNames.length];
          k++;
          const pk = prepProto(name, fantasyKit);
          const scale = KIT * (0.95 + rng() * 0.15);
          const wWorld = pk.w * scale;
          path.getPointAt(u, pt);
          path.getTangentAt(u, tan).normalize();
          nrm.crossVectors(tan, up).normalize();
          const o = halfW + wWorld / 2 + 0.9 + rng() * 0.5; // clear the road edge
          inward.set(-nrm.x * side, 0, -nrm.z * side);
          placeScaled(name, pt.x + nrm.x * side * o, pt.z + nrm.z * side * o, scale,
            Math.atan2(inward.x, inward.z) + (rng() - 0.5) * 0.08);
          u += (wWorld + 1.6 + rng() * 1.4) / pathLen; // footprint + gap → no overlap
        }
      }
    }

    // dense foliage: trees behind the buildings + a far mass toward the hills
    if (treeNames.length) {
      for (let u = 0.03; u <= 0.97; u += 0.03) {
        path.getPointAt(u, pt);
        path.getTangentAt(u, tan).normalize();
        nrm.crossVectors(tan, up).normalize();
        for (const side of [-1, 1] as const) {
          if (rng() < 0.22) continue;
          const o = 13 + rng() * 14;
          const name = treeNames[Math.floor(rng() * treeNames.length)];
          placeScaled(name, pt.x + nrm.x * side * o + (rng() - 0.5) * 3, pt.z + nrm.z * side * o + (rng() - 0.5) * 3,
            KIT * (0.8 + rng() * 0.5), rng() * Math.PI * 2);
        }
      }
      for (let u = 0.04; u <= 0.96; u += 0.05) {
        path.getPointAt(u, pt);
        path.getTangentAt(u, tan).normalize();
        nrm.crossVectors(tan, up).normalize();
        for (const side of [-1, 1] as const) {
          const o = 29 + rng() * 16;
          const name = treeNames[Math.floor(rng() * treeNames.length)];
          placeScaled(name, pt.x + nrm.x * side * o, pt.z + nrm.z * side * o, KIT * (1.0 + rng() * 0.6), rng() * Math.PI * 2);
        }
      }
    }

    // rocks near the road edges + among the trees
    if (rockNames.length) {
      for (let u = 0.04; u <= 0.96; u += 0.045) {
        path.getPointAt(u, pt);
        path.getTangentAt(u, tan).normalize();
        nrm.crossVectors(tan, up).normalize();
        const side = rng() < 0.5 ? -1 : 1;
        const o = 5 + rng() * 16;
        const name = rockNames[Math.floor(rng() * rockNames.length)];
        placeScaled(name, pt.x + nrm.x * side * o, pt.z + nrm.z * side * o, KIT * (0.7 + rng() * 0.8), rng() * Math.PI * 2);
      }
    }

    // skill-spark emitters: a few trees right by the road
    if (treeNames.length) {
      for (const u of [0.25, 0.55, 0.82]) {
        path.getPointAt(u, pt);
        path.getTangentAt(u, tan).normalize();
        nrm.crossVectors(tan, up).normalize();
        const side = rng() < 0.5 ? -1 : 1;
        const obj = placeScaled(treeNames[0], pt.x + nrm.x * side * 5.5, pt.z + nrm.z * side * 5.5, KIT, rng() * Math.PI * 2);
        skills.push({ position: new THREE.Vector3(obj.position.x, 1.4, obj.position.z), object: obj });
      }
    }

    // castle landmark (placed first so mountains can avoid it) ----------
    const castlePos = new THREE.Vector3(half + 8, 0, -30);
    const castleName = all.find((n) => /castle/.test(n));
    if (castleName) placeAt(castleName, castlePos.x, castlePos.z, 18, Math.PI * 0.9);

    // mountain ring backdrop (real assets), skipping the castle + gateway
    if (mountainNames.length) {
      const mrng = makeRng(777);
      const ring = 22;
      for (let i = 0; i < ring; i++) {
        const ang = (i / ring) * Math.PI * 2 + mrng() * 0.15;
        const radius = 32 + mrng() * 18;
        const cx = half + Math.cos(ang) * radius;
        const cz = Math.sin(ang) * radius;
        if (Math.hypot(cx - castlePos.x, cz - castlePos.z) < 16) continue;
        if (Math.abs(cz) < 12 && cx > half + 6) continue;
        const name = mountainNames[Math.floor(mrng() * mountainNames.length)];
        placeAt(name, cx, cz, 20 + mrng() * 16, mrng() * Math.PI * 2);
      }
    }

    // a few clouds for sky depth ----------------------------------------
    if (cloudNames.length) {
      const crng = makeRng(321);
      for (let i = 0; i < 7; i++) {
        const name = cloudNames[Math.floor(crng() * cloudNames.length)];
        const inst = placeAt(name, half + (crng() - 0.5) * 90, (crng() - 0.5) * 80, 3 + crng() * 3, crng() * Math.PI * 2);
        inst.position.y = 16 + crng() * 12;
      }
    }

    return skills;
  }

  function buildScifi(group: THREE.Group, path: THREE.CatmullRomCurve3): SkillProp[] {
    const scifiKit = kit.scifi ?? {};
    const all = Object.keys(scifiKit);
    const moduleNames = all.filter((n) => /^(basemodule|cargodepot|structure_low)/.test(n));
    const tallNames = all.filter((n) => /^(structure_tall|drill_structure|windturbine)/.test(n));
    const padNames = all.filter((n) => /^(landingpad|lander)/.test(n));
    const propNames = all.filter((n) => /^(containers|cargo|solarpanel)/.test(n));
    const rockNames = all.filter((n) => /^rock/.test(n));
    const skills: SkillProp[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    const pt = new THREE.Vector3();
    const tan = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    const inward = new THREE.Vector3();
    const rng = makeRng(70707);
    const KIT = 3.0; // uniform kit scale tuned to the ~1.8u agent

    const placeScaled = (name: string, x: number, z: number, mul: number, ry: number) => {
      const pk = prepProto(name, scifiKit);
      const inst = pk.proto.clone(true);
      inst.scale.multiplyScalar(mul);
      inst.rotation.y = ry;
      inst.position.set(x, 0, z);
      // KayKit module origins aren't footprint-centred — recentre on (x,z) so the
      // placement offset truly clears the corridor (no intruding into the path)
      inst.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(inst);
      inst.position.x += x - (box.min.x + box.max.x) / 2;
      inst.position.z += z - (box.min.z + box.max.z) / 2;
      group.add(inst);
      return inst;
    };

    // glowing runway strip down the corridor centre (bloom layer → neon glow)
    {
      const N = 120, hw = 0.4;
      const pos: number[] = [], idx: number[] = [];
      for (let i = 0; i <= N; i++) {
        path.getPointAt(i / N, pt);
        path.getTangentAt(i / N, tan).normalize();
        nrm.crossVectors(tan, up).normalize();
        pos.push(pt.x - nrm.x * hw, 0.05, pt.z - nrm.z * hw, pt.x + nrm.x * hw, 0.05, pt.z + nrm.z * hw);
      }
      for (let i = 0; i < N; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      const m = new THREE.MeshBasicMaterial({ color: BRAND.cyan, transparent: true, opacity: 0.85 });
      const strip = new THREE.Mesh(g, m);
      strip.layers.enable(BLOOM_LAYER);
      group.add(strip);
      disposables.push(g, m);
    }

    // base modules lining the corridor, sequential by footprint (no overlap)
    if (moduleNames.length) {
      const pathLen = path.getLength();
      let k = 0;
      for (const side of [-1, 1] as const) {
        let u = 0.05;
        while (u <= 0.95) {
          const name = moduleNames[k % moduleNames.length];
          k++;
          const pk = prepProto(name, scifiKit);
          const scale = KIT * (0.85 + rng() * 0.4);
          const wWorld = pk.w * scale;
          path.getPointAt(u, pt);
          path.getTangentAt(u, tan).normalize();
          nrm.crossVectors(tan, up).normalize();
          const o = 4.5 + wWorld / 2 + 0.6 + rng() * 0.5;
          inward.set(-nrm.x * side, 0, -nrm.z * side);
          placeScaled(name, pt.x + nrm.x * side * o, pt.z + nrm.z * side * o, scale,
            Math.atan2(inward.x, inward.z) + (rng() - 0.5) * 0.1);
          u += (wWorld + 2.6 + rng() * 1.8) / pathLen; // footprint + bigger gap (open corridor)
        }
      }
    }

    // tall structures / towers farther out (skyline depth)
    if (tallNames.length) {
      for (let u = 0.06; u <= 0.95; u += 0.1) {
        path.getPointAt(u, pt);
        path.getTangentAt(u, tan).normalize();
        nrm.crossVectors(tan, up).normalize();
        const side = rng() < 0.5 ? -1 : 1;
        const o = 13 + rng() * 13;
        const name = tallNames[Math.floor(rng() * tallNames.length)];
        placeScaled(name, pt.x + nrm.x * side * o, pt.z + nrm.z * side * o, KIT * (1.0 + rng() * 0.9), rng() * Math.PI * 2);
      }
    }

    // landing pads + landers as midground set pieces
    if (padNames.length) {
      for (let u = 0.2; u <= 0.85; u += 0.28) {
        path.getPointAt(u, pt);
        path.getTangentAt(u, tan).normalize();
        nrm.crossVectors(tan, up).normalize();
        const side = rng() < 0.5 ? -1 : 1;
        const o = 8 + rng() * 4;
        const name = padNames[Math.floor(rng() * padNames.length)];
        placeScaled(name, pt.x + nrm.x * side * o, pt.z + nrm.z * side * o, KIT * (1.1 + rng() * 0.5), rng() * Math.PI * 2);
      }
    }

    // small props near the corridor edge — a few are skill emitters
    if (propNames.length) {
      let i = 0;
      for (let u = 0.08; u <= 0.92; u += 0.07) {
        path.getPointAt(u, pt);
        path.getTangentAt(u, tan).normalize();
        nrm.crossVectors(tan, up).normalize();
        const side = rng() < 0.5 ? -1 : 1;
        const o = 4.8 + rng() * 1.6;
        const name = propNames[Math.floor(rng() * propNames.length)];
        const inst = placeScaled(name, pt.x + nrm.x * side * o, pt.z + nrm.z * side * o, KIT * (0.85 + rng() * 0.5), rng() * Math.PI * 2);
        if (i++ % 5 === 2) skills.push({ position: new THREE.Vector3(inst.position.x, 1.0, inst.position.z), object: inst });
      }
    }

    // sci-fi rocks scattered between the structures
    if (rockNames.length) {
      for (let u = 0.05; u <= 0.95; u += 0.06) {
        path.getPointAt(u, pt);
        path.getTangentAt(u, tan).normalize();
        nrm.crossVectors(tan, up).normalize();
        const side = rng() < 0.5 ? -1 : 1;
        const o = 6 + rng() * 12;
        const name = rockNames[Math.floor(rng() * rockNames.length)];
        placeScaled(name, pt.x + nrm.x * side * o, pt.z + nrm.z * side * o, KIT * (1.0 + rng() * 1.2), rng() * Math.PI * 2);
      }
    }

    // neon point lights along the corridor (alternating cyan / violet)
    let li = 0;
    for (let u = 0.1; u <= 0.9; u += 0.16) {
      path.getPointAt(u, pt);
      const color = li % 2 ? BRAND.cyan : BRAND.violet;
      const pl = new THREE.PointLight(color, 50, 24, 2);
      pl.position.set(pt.x, 3.2, pt.z + (li % 2 ? 5 : -5));
      group.add(pl);
      li++;
    }

    return skills;
  }

  function buildSim(group: THREE.Group, path: THREE.CatmullRomCurve3): SkillProp[] {
    const simKit = kit.sim ?? {};
    const all = Object.keys(simKit);
    const houseNames = all.filter((n) => /^building_/.test(n));
    const carNames = all.filter((n) => /^car_/.test(n));
    const skills: SkillProp[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    const pt = new THREE.Vector3();
    const tan = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    const inward = new THREE.Vector3();
    const rng = makeRng(424242);
    const KIT = 2.2;        // ~1.8u agent → house ≈ 3.6u (2 storeys)
    const roadHalf = 3.0;

    const place = (name: string, x: number, z: number, mul: number, ry: number, recenter = false) => {
      const pk = prepProto(name, simKit);
      const inst = pk.proto.clone(true);
      inst.scale.multiplyScalar(mul);
      inst.rotation.y = ry;
      inst.position.set(x, 0, z);
      if (recenter) {
        inst.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(inst);
        inst.position.x += x - (box.min.x + box.max.x) / 2;
        inst.position.z += z - (box.min.z + box.max.z) / 2;
      }
      group.add(inst);
      return inst;
    };

    // asphalt road ribbon following the path + a dashed centre line
    {
      const N = 160, hw = roadHalf;
      const rp: number[] = [], ruv: number[] = [], ri: number[] = [];
      const cp: number[] = [], ci: number[] = [];
      const prev = new THREE.Vector3(); let len = 0;
      for (let i = 0; i <= N; i++) {
        path.getPointAt(i / N, pt); path.getTangentAt(i / N, tan).normalize(); nrm.crossVectors(tan, up).normalize();
        if (i > 0) len += pt.distanceTo(prev); prev.copy(pt);
        rp.push(pt.x - nrm.x * hw, 0.02, pt.z - nrm.z * hw, pt.x + nrm.x * hw, 0.02, pt.z + nrm.z * hw);
        ruv.push(0, len / 3, 1, len / 3);
        const dash = Math.floor(len / 1.4) % 2 === 0 ? 0.12 : 0.0; // dashed centre line
        cp.push(pt.x - nrm.x * dash, 0.035, pt.z - nrm.z * dash, pt.x + nrm.x * dash, 0.035, pt.z + nrm.z * dash);
      }
      for (let i = 0; i < N; i++) { const a = i * 2; ri.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); ci.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      const rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3));
      rg.setAttribute('uv', new THREE.Float32BufferAttribute(ruv, 2));
      rg.setIndex(ri); rg.computeVertexNormals();
      const rm = new THREE.MeshStandardMaterial({ color: 0x2c2f36, roughness: 0.9 });
      const road = new THREE.Mesh(rg, rm); road.receiveShadow = true; group.add(road); disposables.push(rg, rm);
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
      cg.setIndex(ci);
      const cm = new THREE.MeshBasicMaterial({ color: 0xd9c24a });
      const cl = new THREE.Mesh(cg, cm); group.add(cl); disposables.push(cg, cm);
    }

    // houses lining both sides, sequential by footprint, facing the street
    if (houseNames.length) {
      const pathLen = path.getLength();
      let k = 0;
      for (const side of [-1, 1] as const) {
        let u = 0.03;
        while (u <= 0.96) {
          const name = houseNames[k % houseNames.length]; k++;
          const pk = prepProto(name, simKit);
          const scale = KIT * (0.95 + rng() * 0.3);
          const wWorld = pk.w * scale;
          path.getPointAt(u, pt); path.getTangentAt(u, tan).normalize(); nrm.crossVectors(tan, up).normalize();
          const o = roadHalf + 1.6 + wWorld / 2 + rng() * 0.3;
          inward.set(-nrm.x * side, 0, -nrm.z * side);
          place(name, pt.x + nrm.x * side * o, pt.z + nrm.z * side * o, scale,
            Math.atan2(inward.x, inward.z) + (rng() - 0.5) * 0.05, true);
          u += (wWorld + 1.0 + rng() * 0.8) / pathLen;
        }
      }
    }

    // parked cars along the kerb (occasional, aligned with the street)
    if (carNames.length) {
      for (let u = 0.06; u <= 0.93; u += 0.11) {
        if (rng() < 0.4) continue;
        path.getPointAt(u, pt); path.getTangentAt(u, tan).normalize(); nrm.crossVectors(tan, up).normalize();
        const side = rng() < 0.5 ? -1 : 1;
        const name = carNames[Math.floor(rng() * carNames.length)];
        place(name, pt.x + nrm.x * side * (roadHalf - 0.7), pt.z + nrm.z * side * (roadHalf - 0.7),
          2.6, Math.atan2(tan.x, tan.z), true);
      }
    }

    // streetlights alternating along the kerb
    let li = 0;
    for (let u = 0.05; u <= 0.95; u += 0.11) {
      path.getPointAt(u, pt); path.getTangentAt(u, tan).normalize(); nrm.crossVectors(tan, up).normalize();
      const side = (li % 2) ? -1 : 1;
      place('streetlight', pt.x + nrm.x * side * (roadHalf + 0.6), pt.z + nrm.z * side * (roadHalf + 0.6),
        3.0, Math.atan2(-nrm.x * side, -nrm.z * side));
      li++;
    }

    // bushes in the front yards
    if (all.includes('bush')) {
      for (let u = 0.04; u <= 0.96; u += 0.05) {
        path.getPointAt(u, pt); path.getTangentAt(u, tan).normalize(); nrm.crossVectors(tan, up).normalize();
        const side = rng() < 0.5 ? -1 : 1;
        const o = roadHalf + 1.4 + rng() * 3.5;
        place('bush', pt.x + nrm.x * side * o, pt.z + nrm.z * side * o, 2.4 + rng() * 1.4, rng() * Math.PI * 2);
      }
    }

    // fire hydrants by the kerb double as skill-spark emitters
    if (all.includes('firehydrant')) {
      for (const u of [0.18, 0.45, 0.72, 0.9]) {
        path.getPointAt(u, pt); path.getTangentAt(u, tan).normalize(); nrm.crossVectors(tan, up).normalize();
        const side = rng() < 0.5 ? -1 : 1;
        const inst = place('firehydrant', pt.x + nrm.x * side * (roadHalf + 0.5), pt.z + nrm.z * side * (roadHalf + 0.5), 2.6, rng() * Math.PI * 2);
        skills.push({ position: new THREE.Vector3(inst.position.x, 1.0, inst.position.z), object: inst });
      }
    }

    return skills;
  }

  function buildWestern(group: THREE.Group, path: THREE.CatmullRomCurve3): SkillProp[] {
    const skills: SkillProp[] = [];
    const rng = makeRng(53);
    const up = new THREE.Vector3(0, 1, 0);
    const pt = new THREE.Vector3();
    const tan = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    const fantasyKit = kit.fantasy ?? {};

    // desert recolour materials for the canyon rock (real KayKit meshes, retinted)
    const rockMats = [0xb5651d, 0xc8743a, 0xa6603a, 0xd99a5a, 0x9c5a32].map(
      (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 1, flatShading: true }),
    );
    rockMats.forEach((m) => disposables.push(m));
    const pickMat = () => rockMats[Math.floor(rng() * rockMats.length)];

    const placeRock = (names: string[], x: number, z: number, targetH: number, mat: THREE.Material) => {
      const name = names[Math.floor(rng() * names.length)];
      const pk = prepProto(name, fantasyKit);
      const inst = pk.proto.clone(true);
      inst.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.material = mat;
          m.castShadow = true;
          m.receiveShadow = true;
        }
      });
      inst.scale.multiplyScalar(targetH / pk.h);
      inst.position.set(x, 0, z);
      inst.rotation.y = rng() * Math.PI * 2;
      group.add(inst);
      return inst;
    };

    const mountainNames = Object.keys(fantasyKit).filter((n) => /^mountain_[ABC]$/.test(n));
    const hillNames = Object.keys(fantasyKit).filter((n) => /^hill_single/.test(n));
    const rockNames = Object.keys(fantasyKit).filter((n) => /^rock_single/.test(n));
    const buttes = mountainNames.length ? mountainNames : hillNames;

    // ---- sunken river channel + KayKit stone bridge spanning it ----
    const bridgeU = 0.85;          // crossing center (matches the path's flat top)
    const bx = 35;                 // bridge/gap centre X
    const RW = 6;        // channel width along travel (X)
    const ZSPAN = 130;   // channel length across the canyon (Z)
    const bedY = -1.7, waterY = -1.0;
    const X0 = half - 80, X1 = half + 80;

    // split the desert floor, leaving a gap [bx-RW/2, bx+RW/2] for the river
    const groundMat = new THREE.MeshStandardMaterial({ color: 0xc79a5e, roughness: 1, metalness: 0 });
    disposables.push(groundMat);
    const addSlab = (cx: number, w: number) => {
      const g = new THREE.PlaneGeometry(w, 160);
      const m = new THREE.Mesh(g, groundMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(cx, 0, 0);
      m.receiveShadow = true;
      group.add(m); disposables.push(g);
    };
    addSlab((X0 + bx - RW / 2) / 2, (bx - RW / 2) - X0);
    addSlab((bx + RW / 2 + X1) / 2, X1 - (bx + RW / 2));

    // dark riverbed + rock channel walls so the gap reads as a carved trench
    const bedMat = new THREE.MeshStandardMaterial({ color: 0x4f3a28, roughness: 1, metalness: 0 });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x6e4a30, roughness: 1, metalness: 0, side: THREE.DoubleSide, flatShading: true });
    disposables.push(bedMat, wallMat);
    const bedGeo = new THREE.PlaneGeometry(RW + 2.4, ZSPAN);
    const bed = new THREE.Mesh(bedGeo, bedMat);
    bed.rotation.x = -Math.PI / 2; bed.position.set(bx, bedY, 0); bed.receiveShadow = true;
    group.add(bed); disposables.push(bedGeo);
    for (const wx of [bx - RW / 2, bx + RW / 2]) {
      const wg = new THREE.PlaneGeometry(ZSPAN, -bedY);
      const wall = new THREE.Mesh(wg, wallMat);
      wall.rotation.y = Math.PI / 2;
      wall.position.set(wx, bedY / 2, 0);
      wall.receiveShadow = true;
      group.add(wall); disposables.push(wg);
    }

    // deep blue water low in the channel; emissive carries the colour through
    // the warm dusk light, gentle reflection (not a mirror)
    const waterMat = new THREE.MeshStandardMaterial({ color: 0x10546f, emissive: 0x06243a, emissiveIntensity: 0.6, metalness: 0.35, roughness: 0.12, transparent: true, opacity: 0.9 });
    waterMat.envMapIntensity = 0.4;
    const waterGeo = new THREE.PlaneGeometry(RW, ZSPAN);
    disposables.push(waterMat, waterGeo);
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(bx, waterY, 0);
    group.add(water);

    // rubble banks lining both rims (hide slab edges, natural gorge look)
    const bankNames = rockNames.length ? rockNames : buttes;
    for (const side of [-1, 1] as const) {
      for (let z = -ZSPAN / 2 + 6; z <= ZSPAN / 2 - 6; z += 4 + rng() * 3) {
        if (Math.abs(z) < 6.5) continue; // leave the bridge mouth + deck clear
        placeRock(bankNames, bx + side * (RW / 2 + 0.2 + rng() * 0.6), z, 0.9 + rng() * 1.6, pickMat());
      }
    }

    // low-poly WOOD plank bridge, built flat and aligned to the trail (+X) so the
    // agent runs straight along the deck; wide deck, rails, trestle legs in the water
    {
      const woodDark = new THREE.MeshStandardMaterial({ color: 0x6b4a2b, roughness: 0.9, metalness: 0, flatShading: true });
      const woodLight = new THREE.MeshStandardMaterial({ color: 0x8a6038, roughness: 0.9, metalness: 0, flatShading: true });
      disposables.push(woodDark, woodLight);
      const DECK_LEN = 8;     // along X (travel): spans the gap + rests on both rims
      const DECK_W = 7;       // along Z: wide
      const DECK_Y = 0.25;    // walkable surface (top of planks)
      const x0b = bx - DECK_LEN / 2, x1b = bx + DECK_LEN / 2;
      const grp = new THREE.Group();

      // longitudinal beams under the planks
      const beamGeo = new THREE.BoxGeometry(DECK_LEN, 0.18, 0.35);
      disposables.push(beamGeo);
      for (const z of [-DECK_W / 2 + 0.6, 0, DECK_W / 2 - 0.6]) {
        const beam = new THREE.Mesh(beamGeo, woodDark);
        beam.position.set(bx, DECK_Y - 0.19, z);
        beam.castShadow = beam.receiveShadow = true;
        grp.add(beam);
      }
      // cross planks laid across the deck, repeated along the run
      const plankGeo = new THREE.BoxGeometry(0.42, 0.1, DECK_W);
      disposables.push(plankGeo);
      let pi = 0;
      for (let x = x0b + 0.25; x <= x1b - 0.25; x += 0.5) {
        const plank = new THREE.Mesh(plankGeo, pi++ % 2 ? woodDark : woodLight);
        plank.position.set(x, DECK_Y - 0.05, 0);
        plank.castShadow = plank.receiveShadow = true;
        grp.add(plank);
      }
      // side rails: top rail + posts on both edges
      const railGeo = new THREE.BoxGeometry(DECK_LEN, 0.12, 0.14);
      const postGeo = new THREE.BoxGeometry(0.16, 0.7, 0.16);
      disposables.push(railGeo, postGeo);
      for (const side of [-1, 1] as const) {
        const zr = side * (DECK_W / 2 - 0.15);
        const rail = new THREE.Mesh(railGeo, woodDark);
        rail.position.set(bx, DECK_Y + 0.6, zr);
        rail.castShadow = true; grp.add(rail);
        for (let x = x0b + 0.4; x <= x1b - 0.4; x += 1.5) {
          const post = new THREE.Mesh(postGeo, woodLight);
          post.position.set(x, DECK_Y + 0.3, zr);
          post.castShadow = true; grp.add(post);
        }
      }
      // trestle legs dropping into the water at both rims + centre
      const legGeo = new THREE.BoxGeometry(0.32, 2.0, 0.32);
      disposables.push(legGeo);
      for (const x of [x0b + 0.7, bx, x1b - 0.7]) {
        for (const side of [-1, 1] as const) {
          const leg = new THREE.Mesh(legGeo, woodDark);
          leg.position.set(x, DECK_Y - 1.1, side * (DECK_W / 2 - 0.9));
          leg.castShadow = true; grp.add(leg);
        }
      }
      group.add(grp);
    }

    // ---- canyon: dense ring of big buttes + midground, flanking the trail ----
    const mrng = makeRng(909);
    for (let i = 0; i < 30; i++) {
      const ang = (i / 30) * Math.PI * 2 + mrng() * 0.2;
      const radius = 30 + mrng() * 32;
      const cx = half + Math.cos(ang) * radius;
      const cz = Math.sin(ang) * radius;
      if (Math.abs(cz) < 12 && cx > half + 8) continue; // keep the gateway open
      placeRock(buttes, cx, cz, 12 + mrng() * 22, pickMat());
    }
    for (let u = 0.05; u <= 0.95; u += 0.08) {
      if (Math.abs(u - bridgeU) < 0.14) continue;
      path.getPointAt(u, pt);
      path.getTangentAt(u, tan).normalize();
      nrm.crossVectors(tan, up).normalize();
      const side = rng() < 0.5 ? -1 : 1;
      const o = 11 + rng() * 12;
      placeRock(buttes, pt.x + nrm.x * side * o, pt.z + nrm.z * side * o, 5 + rng() * 9, pickMat());
    }
    if (rockNames.length) {
      for (let u = 0.04; u <= 0.96; u += 0.04) {
        if (Math.abs(u - bridgeU) < 0.12) continue;
        path.getPointAt(u, pt);
        path.getTangentAt(u, tan).normalize();
        nrm.crossVectors(tan, up).normalize();
        const side = rng() < 0.5 ? -1 : 1;
        const o = 4.5 + rng() * 13;
        placeRock(rockNames, pt.x + nrm.x * side * o, pt.z + nrm.z * side * o, 0.6 + rng() * 2.0, pickMat());
      }
    }

    // skill-spark emitters: a few boulders by the trail
    for (const u of [0.2, 0.45, 0.68]) {
      path.getPointAt(u, pt);
      path.getTangentAt(u, tan).normalize();
      nrm.crossVectors(tan, up).normalize();
      const side = rng() < 0.5 ? -1 : 1;
      const inst = placeRock(rockNames.length ? rockNames : buttes, pt.x + nrm.x * side * 5, pt.z + nrm.z * side * 5, 1.5, pickMat());
      skills.push({ position: new THREE.Vector3(inst.position.x, 1.0, inst.position.z), object: inst });
    }
    return skills;
  }

  // ---- global lights ------------------------------------------------------
  const ambient = new THREE.AmbientLight(0x223049, 0.8);
  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x35402f, 0.6);
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 60;
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -20;
  sc.right = 20;
  sc.top = 20;
  sc.bottom = -20;
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0006;
  scene.add(ambient, hemi, sun, sun.target);
  const sunDir = new THREE.Vector3(6, 12, 8);

  const SUN_PARAMS: Record<PhaseId, { color: number; intensity: number; dir: THREE.Vector3; hemiSky: number; hemiGround: number; amb: number }> = {
    builder: { color: 0xcfe0ff, intensity: 0.6, dir: new THREE.Vector3(6, 12, 8), hemiSky: 0x223049, hemiGround: 0x141a28, amb: 0.9 },
    fantasy: { color: 0xfff1d0, intensity: 2.3, dir: new THREE.Vector3(-8, 12, 6), hemiSky: 0xbfe0ff, hemiGround: 0x35502f, amb: 0.55 },
    western: { color: 0xffcf94, intensity: 1.35, dir: new THREE.Vector3(-9, 8, 4), hemiSky: 0xe8c9a0, hemiGround: 0x7a5232, amb: 0.35 },
    scifi: { color: 0x6c8cff, intensity: 0.8, dir: new THREE.Vector3(4, 10, -6), hemiSky: 0x16306a, hemiGround: 0x0a0f1c, amb: 0.4 },
    sim: { color: 0xffffff, intensity: 2.4, dir: new THREE.Vector3(6, 13, 5), hemiSky: 0x9fc4ff, hemiGround: 0x3f6a3f, amb: 0.6 },
  };

  const RENDER_PARAMS: Record<PhaseId, { exposure: number; env: number; bg: number }> = {
    builder: { exposure: 1.0, env: 1.0, bg: 1.0 },
    fantasy: { exposure: 1.0, env: 1.0, bg: 1.0 },
    western: { exposure: 0.8, env: 0.5, bg: 0.7 },
    scifi: { exposure: 1.05, env: 0.9, bg: 1.0 },
    sim: { exposure: 0.95, env: 0.9, bg: 0.95 },
  };

  function setActiveWorld(phase: PhaseId) {
    for (const id of WORLD_PHASES) worldGroups[id].visible = id === phase;
    const rp = RENDER_PARAMS[phase];
    renderer.toneMappingExposure = rp.exposure;
    scene.environment = envMaps[phase] ?? null;
    scene.environmentIntensity = rp.env;
    const skybox = bgMaps[phase];
    if (skybox && phase !== 'builder' && phase !== 'scifi') {
      scene.background = skybox;
      scene.backgroundBlurriness = 0.04;
      scene.backgroundIntensity = rp.bg;
    } else {
      const bg = SKY[phase];
      scene.background = bg instanceof THREE.Texture ? bg : new THREE.Color(bg as number);
      scene.backgroundBlurriness = 0;
      scene.backgroundIntensity = rp.bg;
    }
    const sp = SUN_PARAMS[phase];
    sun.color.setHex(sp.color);
    sun.intensity = sp.intensity;
    hemi.color.setHex(sp.hemiSky);
    hemi.groundColor.setHex(sp.hemiGround);
    ambient.intensity = sp.amb;
    sunDir.copy(sp.dir);
    const fog = PHASES.find((p) => p.id === phase)!.fog;
    if (!scene.fog) scene.fog = new THREE.FogExp2(fog.color, fog.density);
    else {
      (scene.fog as THREE.FogExp2).color.setHex(fog.color);
      (scene.fog as THREE.FogExp2).density = fog.density;
    }
  }

  // ---- climax composite cards --------------------------------------------
  const compGroup = new THREE.Group();
  const compMats: THREE.MeshBasicMaterial[] = [];
  const endPt = paths.builder.getPointAt(0.97, new THREE.Vector3());
  const cardDefs: [string, number, number][] = [
    ['BUILDER', 0x223049, 0x0a0f1c],
    ['FANTASY', 0x213a52, 0x3a5a3a],
    ['WESTERN', 0x9fb4d6, 0xd9b375],
    ['SCI-FI', 0x1a2a6a, 0x05060f],
    ['SIMULATION', 0x7fb4ef, 0xcfe0ff],
  ];
  cardDefs.forEach((d, i) => {
    const tex = cardTexture(d[0], d[1], d[2]);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const card = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.5), mat);
    const ang = (i - (cardDefs.length - 1) / 2) * 0.5;
    card.position.set(endPt.x - 4 + Math.abs(ang) * 1.2, 7.5 + Math.cos(ang * 1.4) * 1.2, Math.sin(ang) * 9);
    card.rotation.y = -Math.PI / 2 + ang * 0.45;
    card.layers.enable(BLOOM_LAYER);
    compGroup.add(card);
    compMats.push(mat);
    disposables.push(tex, mat, card.geometry);
  });
  compGroup.visible = false;
  scene.add(compGroup);

  function setComposite(v: number) {
    for (const m of compMats) m.opacity = v * 0.95;
    compGroup.visible = v > 0.001;
    compGroup.scale.setScalar(0.7 + 0.3 * v);
  }

  function setReturnPanels(on: boolean) {
    const src = on ? holoFinalTex : holoStartTex;
    for (let i = 0; i < holo.length; i++) {
      const mat = holo[i].material as THREE.MeshBasicMaterial;
      if (src[i] && mat.map !== src[i]) { mat.map = src[i]; mat.needsUpdate = true; }
    }
  }

  function update(dt: number, agentPos: THREE.Vector3, t: number) {
    sun.position.copy(agentPos).add(sunDir);
    sun.target.position.copy(agentPos);
    sun.target.updateMatrixWorld();
    for (let i = 0; i < holo.length; i++) {
      holo[i].position.y += Math.sin(t * 1.2 + i) * 0.0015;
      holo[i].rotation.z = Math.sin(t * 0.6 + i) * 0.02;
    }
    if (compGroup.visible) compGroup.rotation.y = Math.sin(t * 0.4) * 0.08;
    void dt;
  }

  function dispose() {
    for (const id of WORLD_PHASES) scene.remove(worldGroups[id]);
    scene.remove(ambient, hemi, sun, sun.target, compGroup);
    for (const d of disposables) d.dispose();
  }

  return {
    paths,
    gatewayPath: paths.builder,
    setActiveWorld,
    skillPropsFor: (phase: PhaseId) => skillProps[phase] ?? [],
    update,
    setComposite,
    setReturnPanels,
    dispose,
  };
}
