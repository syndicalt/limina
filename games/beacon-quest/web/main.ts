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
    // HERO framing: stand near the camp at eye level and look DOWN the path toward the
    // beacon (-Z). azimuth=PI/2 puts the camera on +Z of the center looking -Z; a low
    // height keeps it at ~human eye level so dense foreground reads and the flat ground
    // edge is below frame + lost in fog.
    center: [0, 2.4, -5],
    radius: 15,
    height: 1.7,
    azimuth: Math.PI / 2,
    autoSpin: 0,
    maxRadius: 120,
    maxHeight: 90,
    far: 300,
  },
  onStatus: (s, d) => { if (statusEl) statusEl.textContent = d ? `${s} · ${d}` : s; },
});

// Scene-level look tweaks (the scene fills in over the replay, so re-apply for a few seconds).
const scene = (running.player as unknown as {
  world?: { scene?: { traverse(cb: (o: unknown) => void): void; fog?: unknown } };
}).world?.scene;
if (scene !== undefined) {
  // Exponential distance haze matched to the baseline sky horizon (0xcdd9e6) so the far
  // scatter + the flat ground edge melt into the sky instead of ending at a hard line.
  // Tuned to this ~60-unit scene: near hub stays crisp, distance reads as depth.
  scene.fog = new THREE.FogExp2(0xcdd9e6, 0.024);
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
