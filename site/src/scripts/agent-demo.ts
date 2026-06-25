// A live, in-browser Three.js preview of Limina's signature scene: a crowd of
// low-poly agent-creatures milling on a glowing grid. This is a *stylised
// preview* — the native engine renders this on a WebGPU surface at far higher
// density. No external assets; everything is procedural.
import * as THREE from 'three';

export interface AgentDemoOptions {
  canvas: HTMLCanvasElement;
  count?: number;
  onStats?: (fps: number, agents: number) => void;
  onError?: () => void;
}

const PALETTE = [
  0x2fe6d6, 0x3bc9ff, 0x8b6bff, 0xff5aa0, 0xffb454, 0x57d977, 0xff7a59, 0x6c8cff,
];

function radialTexture(): THREE.Texture {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(47,230,214,0.55)');
  g.addColorStop(0.4, 'rgba(47,230,214,0.18)');
  g.addColorStop(1, 'rgba(47,230,214,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function initAgentDemo(opts: AgentDemoOptions): { destroy: () => void } {
  const { canvas } = opts;
  const count = opts.count ?? 150;
  const parent = canvas.parentElement ?? document.body;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch (err) {
    opts.onError?.();
    return { destroy() {} };
  }

  const sizeOf = () => {
    const r = parent.getBoundingClientRect();
    return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
  };

  let { w, h } = sizeOf();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070912);
  scene.fog = new THREE.FogExp2(0x070912, 0.05);

  const camera = new THREE.PerspectiveCamera(48, w / h, 0.1, 120);
  camera.position.set(0, 3.3, 10);

  // ---- floor + grid + glow ------------------------------------------------
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(46, 64),
    new THREE.MeshStandardMaterial({ color: 0x0a0f1c, roughness: 0.82, metalness: 0.15 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const grid = new THREE.GridHelper(70, 70, 0x2fe6d6, 0x15514c);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.28;
  grid.position.y = 0.02;
  scene.add(grid);

  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(16, 16),
    new THREE.MeshBasicMaterial({ map: radialTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.04;
  scene.add(glow);

  // ---- lights -------------------------------------------------------------
  scene.add(new THREE.AmbientLight(0x223049, 1.1));
  const key = new THREE.DirectionalLight(0xcfe0ff, 1.4);
  key.position.set(6, 12, 8);
  scene.add(key);
  const pTeal = new THREE.PointLight(0x2fe6d6, 60, 30, 2);
  pTeal.position.set(0, 2.4, 2);
  scene.add(pTeal);
  const pMag = new THREE.PointLight(0xff5aa0, 45, 34, 2);
  pMag.position.set(-8, 2.2, -5);
  scene.add(pMag);
  const pVio = new THREE.PointLight(0x8b6bff, 40, 34, 2);
  pVio.position.set(8, 2.6, 5);
  scene.add(pVio);

  // ---- agents (instanced bodies + eyes) -----------------------------------
  type Agent = { x: number; z: number; height: number; face: number; phase: number; sway: number };
  const agents: Agent[] = [];
  for (let i = 0; i < count; i++) {
    const r = 2.1 + Math.random() * 6.4;
    const a = Math.random() * Math.PI * 2;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    agents.push({
      x,
      z,
      height: 0.9 + Math.random() * 0.95,
      face: Math.atan2(-x, -z) + (Math.random() - 0.5) * 0.7,
      phase: Math.random() * Math.PI * 2,
      sway: 0.7 + Math.random() * 0.8,
    });
  }

  const bodyGeo = new THREE.BoxGeometry(0.8, 1, 0.56);
  const bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.08, flatShading: true });
  const bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, count);
  bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const col = new THREE.Color();
  for (let i = 0; i < count; i++) {
    col.setHex(PALETTE[i % PALETTE.length]);
    bodies.setColorAt(i, col);
  }
  scene.add(bodies);

  const eyeGeo = new THREE.SphereGeometry(0.08, 10, 10);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x080810, roughness: 0.12, metalness: 0.2 });
  const eyes = new THREE.InstancedMesh(eyeGeo, eyeMat, count * 2);
  eyes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(eyes);

  const dBody = new THREE.Object3D();
  const dEyeBase = new THREE.Object3D();
  const dEye = new THREE.Object3D();
  const localEye = new THREE.Vector3();

  function updateAgents(t: number) {
    for (let i = 0; i < count; i++) {
      const ag = agents[i];
      const bob = Math.sin(t * ag.sway + ag.phase) * 0.06;
      const wob = Math.sin(t * 0.8 + ag.phase) * 0.06;
      dBody.position.set(ag.x, ag.height / 2 + bob, ag.z);
      dBody.rotation.set(0, ag.face + wob, 0);
      dBody.scale.set(1, ag.height, 1);
      dBody.updateMatrix();
      bodies.setMatrixAt(i, dBody.matrix);

      dEyeBase.position.set(ag.x, bob + ag.height * 0.7, ag.z);
      dEyeBase.rotation.set(0, ag.face + wob, 0);
      dEyeBase.scale.set(1, 1, 1);
      dEyeBase.updateMatrix();
      for (let s = 0; s < 2; s++) {
        localEye.set(s === 0 ? -0.17 : 0.17, 0, 0.3);
        localEye.applyMatrix4(dEyeBase.matrix);
        dEye.position.copy(localEye);
        dEye.quaternion.copy(dEyeBase.quaternion);
        dEye.updateMatrix();
        eyes.setMatrixAt(i * 2 + s, dEye.matrix);
      }
    }
    bodies.instanceMatrix.needsUpdate = true;
    eyes.instanceMatrix.needsUpdate = true;
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
  }

  // ---- loop ---------------------------------------------------------------
  const clock = new THREE.Clock();
  let raf = 0;
  let visible = true;
  let frames = 0;
  let acc = 0;

  function renderFrame() {
    const t = clock.elapsedTime;
    const orbit = t * 0.075;
    const rad = 9.6;
    camera.position.set(Math.sin(orbit) * rad, 3.2 + Math.sin(t * 0.3) * 0.35, Math.cos(orbit) * rad);
    camera.lookAt(0, 1.15, 0);
    updateAgents(t);
    renderer.render(scene, camera);
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    const dt = clock.getDelta();
    if (!visible) return;
    renderFrame();
    frames++;
    acc += dt;
    if (acc >= 0.5) {
      opts.onStats?.(Math.round(frames / acc), count);
      frames = 0;
      acc = 0;
    }
  }

  function onResize() {
    const s = sizeOf();
    w = s.w;
    h = s.h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  const ro = new ResizeObserver(onResize);
  ro.observe(parent);

  const vis = new IntersectionObserver(
    (entries) => {
      visible = entries[0]?.isIntersecting ?? true;
    },
    { threshold: 0.01 },
  );
  vis.observe(canvas);

  if (reduceMotion) {
    clock.getDelta();
    renderFrame();
    opts.onStats?.(60, count);
  } else {
    tick();
  }

  return {
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      vis.disconnect();
      bodyGeo.dispose();
      eyeGeo.dispose();
      bodyMat.dispose();
      eyeMat.dispose();
      renderer.dispose();
    },
  };
}
