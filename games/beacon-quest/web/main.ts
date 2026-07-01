// Beacon Quest — custom web entry. Loads the exported quest world via the engine's run() with a HERO
// camera, and flags the replayed meshes to cast/receive shadows (the baseline's sun already
// castShadow + shadowMap on; dynamically-added meshes just need the flags). Bundled → public/main.js.

import { run } from "../../../js/src/browser-entry.ts";
import * as THREE from "../../../js/build/three.bundle.mjs";

const canvas = document.getElementById("limina-canvas");
const statusEl = document.getElementById("status");

// Real-GPU headless rendering (tools/shoot.mjs uses hardware ANGLE/GL), so shadows work in the loop.
const SHADOWS = true;

const running = await run({
  canvas,
  worldUrl: "public/worlds/beacon",
  width: 1280,
  height: 720,
  orbit: {
    center: [0, 3, 0],
    radius: 18,
    height: 6, // low across the field, to judge grass density + height
    autoSpin: 0,
    maxRadius: 120,
    maxHeight: 90,
    far: 800,
  },
  onStatus: (s, d) => { if (statusEl) statusEl.textContent = d ? `${s} · ${d}` : s; },
});

// Scene-level look tweaks (the scene fills in over the replay, so re-apply for a few seconds).
const scene = (running.player as unknown as {
  world?: { scene?: { traverse(cb: (o: unknown) => void): void; fog?: unknown } };
}).world?.scene;
if (scene !== undefined) {
  scene.fog = new THREE.Fog(0xc7d3df, 45, 230);
  let nMesh = 0, nLight = 0;
  const apply = (): void => {
    nMesh = 0; nLight = 0;
    scene.traverse((o: unknown) => {
      const m = o as {
        isMesh?: boolean; isInstancedMesh?: boolean; isDirectionalLight?: boolean;
        intensity?: number; castShadow?: boolean; receiveShadow?: boolean;
        shadow?: { camera?: { left: number; right: number; top: number; bottom: number; near: number; far: number; updateProjectionMatrix?(): void }; mapSize?: { set(a: number, b: number): void }; bias?: number };
      };
      if (m.isDirectionalLight === true) nLight++;
      if (m.isMesh === true || m.isInstancedMesh === true) {
        nMesh++;
        if (SHADOWS) { m.castShadow = true; m.receiveShadow = true; }
      }
    });
    if (statusEl !== null) statusEl.textContent = `meshes ${nMesh} · lights ${nLight} · shadows ${SHADOWS}`;
  };
  apply();
  const iv = setInterval(apply, 400);
  setTimeout(() => clearInterval(iv), 6000);
} else if (statusEl !== null) {
  statusEl.textContent = "NO SCENE HANDLE";
}
