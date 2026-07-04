// GPU-eyes proof for a WHOLE kit-composed building (Slice 2). Builds a cottage through the reworked
// assembleBuilding (kit parts: relief wall-panels + sills/lintels/plinth/roof, parented under a
// building-root, materials from the active DesignDirection) into a lightweight world, then renders it
// through the ENGINE's real render baseline on the REAL GPU. What the PNG shows is the live look.

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
    { wall: "south", kind: "door", width: 1.4, height: 2.2, sill: 0 },
    { wall: "south", kind: "window", offset: 2.6, width: 1.1, height: 1.1, sill: 1.1 },
    { wall: "south", kind: "window", offset: -2.6, width: 1.1, height: 1.1, sill: 1.1 },
    { wall: "east", kind: "window", width: 1.3, height: 1.1, sill: 1.0 },
    { wall: "west", kind: "window", width: 1.3, height: 1.1, sill: 1.0 },
    { wall: "north", kind: "window", width: 1.6, height: 1.1, sill: 1.0 },
  ],
  roof: { type: "gable", pitch: 2.6, overhang: 0.5 },
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
  const camera = new THREE.PerspectiveCamera(48, W / H, 0.1, 400);
  // Hero 3/4 angle, grounded, framing the whole cottage.
  camera.position.set(9.5, 4.6, 9.5);
  camera.lookAt(0, 1.5, 0);
  applyRenderBaseline({ scene, renderer: renderer as never, camera } as never);

  // A raking key light so the timber relief + eaves throw real shadows.
  const key = new THREE.DirectionalLight(0xfff0da, 2.4);
  key.position.set(-7, 9, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const kc = key.shadow.camera as THREE.OrthographicCamera;
  kc.left = -14; kc.right = 14; kc.top = 14; kc.bottom = -14; kc.near = 0.1; kc.far = 60;
  scene.add(key);

  // A lightweight WorldContext (mirrors p15c's makeWorld) with stub physics — we only render.
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

  assembleBuilding(COTTAGE, [0, 0, 0], world, { dd: DEFAULT_DESIGN_DIRECTION, seed: 3 });
  renderSyncSystem(ecs);
  // Shadows on every part.
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
