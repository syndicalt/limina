// GPU-eyes proof for Slice 5 (connective + interior glimpse): the kit cottage seen from the FRONT,
// with the stepped DOORSTEP leading up to the door and a warm interior light so the floor reads as an
// enterable, lived-in space through the doorway + windows. Rendered through the engine baseline on the
// real GPU — what the PNG shows is the live look.

import * as THREE from "../../build/three.bundle.mjs";
import { applyRenderBaseline } from "../render-baseline.ts";
import { EntityTable } from "../engine.ts";
import { createEcsWorld, renderSyncSystem } from "../ecs/world.ts";
import { createTransformStorage } from "../ecs/facade.ts";
import { UniformGridSpatialIndex } from "../spatial/index.ts";
import { assembleBuilding, type BuildingRecipe } from "../skills/building-recipe.ts";
import { DEFAULT_DESIGN_DIRECTION } from "../game/design-direction.ts";
import type { WorldContext } from "../skills/registry.ts";

declare const window: { __kitReady?: boolean; __kitErr?: string };

const COTTAGE: BuildingRecipe = {
  width: 8, depth: 6, height: 3.2, wallThickness: 0.25,
  openings: [
    { wall: "south", kind: "door", width: 1.5, height: 2.3, sill: 0 },
    { wall: "south", kind: "window", offset: 2.7, width: 1.1, height: 1.1, sill: 1.1 },
    { wall: "south", kind: "window", offset: -2.7, width: 1.1, height: 1.1, sill: 1.1 },
    { wall: "east", kind: "window", width: 1.3, height: 1.1, sill: 1.0 },
    { wall: "west", kind: "window", width: 1.3, height: 1.1, sill: 1.0 },
  ],
  roof: { type: "gable", pitch: 2.6, overhang: 0.55 },
  plinth: true,
};

async function main(): Promise<void> {
  const canvas = document.getElementById("limina-canvas") as HTMLCanvasElement;
  const W = canvas.width, H = canvas.height;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: !navigator.gpu } as never);
  await renderer.init();
  renderer.setSize(W, H, false);
  (renderer as unknown as { shadowMap: { enabled: boolean; type: number } }).shadowMap.enabled = true;
  (renderer as unknown as { shadowMap: { enabled: boolean; type: number } }).shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(52, W / H, 0.1, 400);
  applyRenderBaseline({ scene, renderer: renderer as never, camera } as never);
  // Set the camera AFTER the baseline (which installs its own default view): low + dead-front of the
  // south door, close, so the doorstep leads up to the door and the eye reads straight through the void.
  camera.position.set(0.9, 1.35, -8.6);
  camera.lookAt(0, 1.25, -3);
  camera.updateProjectionMatrix();
  (renderer as unknown as { toneMappingExposure: number }).toneMappingExposure = 0.85;

  const key = new THREE.DirectionalLight(0xfff0da, 1.5);
  key.position.set(-6, 8, -7);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const kc = key.shadow.camera as THREE.OrthographicCamera;
  kc.left = -14; kc.right = 14; kc.top = 14; kc.bottom = -14; kc.near = 0.1; kc.far = 60;
  scene.add(key);

  // A warm hearth glow INSIDE so the floor + doorway read as an inhabited, enterable interior.
  const hearth = new THREE.PointLight(0xffa64d, 6.0, 14, 1.8);
  hearth.position.set(0.4, 1.2, 0.6);
  scene.add(hearth);

  let bid = 0;
  const ops = {
    op_physics_create_world: () => {},
    op_physics_add_static_box: () => bid++,
    op_physics_remove_body: () => {},
  } as unknown as WorldContext["ops"];
  const ecs = createEcsWorld();
  const world = {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: {} as WorldContext["camera"], ops, mode: "headless",
  } as WorldContext;

  assembleBuilding(COTTAGE, [0, 0, 0], world, { dd: DEFAULT_DESIGN_DIRECTION, seed: 5 });
  renderSyncSystem(ecs);
  scene.traverse((o: THREE.Object3D) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });

  let n = 0;
  const loop = (): void => {
    renderer.render(scene, camera);
    if (++n < 50) requestAnimationFrame(loop);
    else window.__kitReady = true;
  };
  loop();
}

main().catch((e) => { window.__kitErr = String((e && (e.stack || e.message)) || e); window.__kitReady = true; });
