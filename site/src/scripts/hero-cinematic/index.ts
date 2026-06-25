// Hero cinematic entry: load real CC0 assets, build the world, run the 28s loop.
// Layers (portals, trail, postfx) are wired in progressively; the loop renders
// through the composer when present, else directly.
import * as THREE from 'three';
import { detectQuality } from './quality';
import { createManager, fetchManifest, loadHDR, buildEnv, loadGLTF } from './loader';
import { buildWorld, type World } from './world';
import { createAgent, type Agent } from './character';
import { createFollowRig } from './camera';
import { createTimeline } from './timeline';
import { createPortals, type PortalSystem } from './portals';
import { createPostFX, type PostFX } from './postfx';
import { createTrail, type Trail } from './trail';
import { type PhaseId } from './manifest';

export interface HeroCinematicOptions {
  canvas: HTMLCanvasElement;
  overlay?: { brand?: HTMLElement | null };
  onProgress?: (frac: number) => void;
  onReady?: () => void;
  onError?: () => void;
}

export interface HeroCinematic {
  destroy(): void;
}

function seekParam(): number | null {
  try {
    const v = new URLSearchParams(location.search).get('cineSeek');
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function initHeroCinematic(opts: HeroCinematicOptions): HeroCinematic {
  const { canvas } = opts;
  const quality = detectQuality();
  if (!quality.webgl) {
    opts.onError?.();
    return { destroy() {} };
  }

  const parent = canvas.parentElement ?? document.body;
  const sizeOf = () => {
    const r = parent.getBoundingClientRect();
    return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
  };

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  } catch {
    opts.onError?.();
    return { destroy() {} };
  }
  let { w, h } = sizeOf();
  renderer.setPixelRatio(quality.dpr);
  renderer.setSize(w, h, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 400);

  const clock = new THREE.Clock();
  const timeline = createTimeline();
  const rig = createFollowRig(camera);

  let world: World | null = null;
  let portals: PortalSystem | null = null;
  let postfx: PostFX | null = null;
  let trail: Trail | null = null;
  let agent: Agent | null = null;
  let raf = 0;
  let visible = true;
  let disposed = false;
  let lastWorldIndex = -1;

  const pos = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const facing = new THREE.Vector3();

  function renderOnce(elapsed: number) {
    if (!world || !agent) return;
    const st = timeline.update(elapsed);
    const lu = st.agentU;
    const activePath = world.paths[st.phase];
    activePath.getPointAt(Math.min(0.9999, lu), pos);
    activePath.getTangentAt(Math.min(0.9999, lu), dir).normalize();

    if (st.worldIndex !== lastWorldIndex) {
      world.setActiveWorld(st.phase);
      world.setReturnPanels(st.isReturn);
      portals?.place(world.paths[st.phase]);
      rig.snap();
      lastWorldIndex = st.worldIndex;
    }

    const dt = Math.min(0.05, clock.getDelta());
    facing.copy(dir);
    if (st.faceBack) facing.negate(); // turn to face the viewer (camera stays behind)
    agent.setPose(st.pose);
    agent.update(dt, pos, facing, st.emissivePulse);
    rig.update(dt, pos, dir, st.beat);
    world.update(dt, pos, st.elapsed);
    world.setComposite(st.composite);
    portals?.update(dt, lu, st.elapsed);

    const sprops = world.skillPropsFor(st.phase);
    trail?.update(dt, pos, st.trailIntensity, sprops);
    if (postfx) {
      let best: { d: number; o: THREE.Object3D } | null = null;
      for (const sp of sprops) {
        const d = pos.distanceTo(sp.position);
        if (d < 14 && (!best || d < best.d)) best = { d, o: sp.object };
      }
      postfx.outline.selectedObjects = best ? [best.o] : [];
    }

    if (opts.overlay?.brand) opts.overlay.brand.style.opacity = String(st.brandingOpacity);

    if (postfx) {
      postfx.setGrade(st.grade.lift, st.grade.gamma, st.grade.gain);
      postfx.setFlash(st.flash);
      const focus = camera.position.distanceTo(pos);
      postfx.setBokeh(focus, 0);
      postfx.render();
    } else {
      renderer.render(scene, camera);
    }
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    if (!visible) {
      clock.getDelta();
      return;
    }
    const seek = seekParam();
    renderOnce(seek ?? clock.elapsedTime);
  }

  async function boot() {
    let manifest;
    try {
      manifest = await fetchManifest();
    } catch (e) {
      console.error('[hero]', e);
      opts.onError?.();
      return;
    }
    if (!manifest.character) {
      opts.onError?.();
      return;
    }

    const manager = createManager(opts.onProgress);

    // Per-phase HDRIs → PMREM env (IBL) + retained equirect (skybox background).
    const envMaps: Partial<Record<PhaseId, THREE.Texture>> = {};
    const bgMaps: Partial<Record<PhaseId, THREE.Texture>> = {};
    const hdrJobs = (Object.keys(manifest.hdris) as PhaseId[]).map(async (phase) => {
      const url = manifest.hdris[phase];
      if (!url) return;
      const tex = await loadHDR(manager, url);
      envMaps[phase] = buildEnv(renderer, tex);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      bgMaps[phase] = tex;
    });

    const agentJob = createAgent(scene, manager, manifest.character);

    // Load downloaded kit models (name → scene), e.g. fantasy town buildings.
    const kit: Partial<Record<PhaseId, Record<string, THREE.Object3D>>> = {};
    const kitJobs: Promise<void>[] = [];
    for (const phase of Object.keys(manifest.models ?? {}) as PhaseId[]) {
      const urls = manifest.models?.[phase] ?? [];
      kit[phase] = {};
      for (const url of urls) {
        kitJobs.push(
          loadGLTF(manager, url).then((g) => {
            const name = (url.split('/').pop() ?? url).replace(/\.gltf$/, '');
            kit[phase]![name] = g.scene;
          }),
        );
      }
    }

    await Promise.all([...hdrJobs, ...kitJobs, agentJob.then((a) => (agent = a))]);
    if (disposed) return;

    world = buildWorld(scene, renderer, quality, envMaps, kit, bgMaps);
    portals = createPortals(scene, world.gatewayPath);
    postfx = createPostFX(renderer, scene, camera, quality, w, h);
    trail = createTrail(scene);
    world.setActiveWorld('builder');
    lastWorldIndex = 0;

    if (import.meta.env.DEV) {
      (window as unknown as { __hero?: unknown }).__hero = { scene, camera, world, agent };
    }

    opts.onReady?.();

    if (quality.reduceMotion) {
      clock.getDelta();
      renderOnce(7);
    } else {
      clock.start();
      tick();
    }
  }

  function onResize() {
    const s = sizeOf();
    w = s.w;
    h = s.h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    postfx?.setSize(w, h);
  }
  const ro = new ResizeObserver(onResize);
  ro.observe(parent);
  const vis = new IntersectionObserver((e) => (visible = e[0]?.isIntersecting ?? true), { threshold: 0.01 });
  vis.observe(canvas);

  void boot();

  return {
    destroy() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      vis.disconnect();
      trail?.dispose();
      postfx?.dispose();
      portals?.dispose();
      world?.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry?.dispose?.();
          const mat = m.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else mat?.dispose?.();
        }
      });
      renderer.dispose();
    },
  };
}
