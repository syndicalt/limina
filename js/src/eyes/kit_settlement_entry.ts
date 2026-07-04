// GPU proof that the ENGINE's building primitive (now kit-backed) produces a good SETTLEMENT — several
// buildings of varying size/rotation, exactly as architecture.building emits them (it delegates to the
// same assembleBuilding). Confirms the migration reaches the played/agent-built world, not just a hero.

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

// A hall in the middle + homes ringed around a commons — the settlement_showcase layout.
const PLAN: { pos: [number, number, number]; w: number; d: number; h: number; rot: number; door: number }[] = [
  { pos: [0, 0, 0], w: 11, d: 8, h: 4.2, rot: 0, door: 2.0 },        // the hall
  { pos: [-13, 0, -6], w: 7, d: 6, h: 3.2, rot: 0.5, door: 1.4 },
  { pos: [13, 0, -6], w: 7, d: 6, h: 3.2, rot: -0.5, door: 1.4 },
  { pos: [-11, 0, 9], w: 6, d: 6, h: 3.0, rot: 2.4, door: 1.4 },
  { pos: [11, 0, 9], w: 8, d: 6, h: 3.4, rot: 3.6, door: 1.4 },
];

async function main(): Promise<void> {
  const canvas = document.getElementById("limina-canvas") as HTMLCanvasElement;
  const W = canvas.width, H = canvas.height;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: !navigator.gpu } as never);
  await renderer.init();
  renderer.setSize(W, H, false);
  (renderer as unknown as { shadowMap: { enabled: boolean; type: number } }).shadowMap.enabled = true;
  (renderer as unknown as { shadowMap: { enabled: boolean; type: number } }).shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 500);
  applyRenderBaseline({ scene, renderer: renderer as never, camera } as never);
  camera.position.set(22, 15, 28);
  camera.lookAt(0, 2, 0);
  camera.updateProjectionMatrix();

  const key = new THREE.DirectionalLight(0xfff0da, 2.3);
  key.position.set(-16, 22, 14);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const kc = key.shadow.camera as THREE.OrthographicCamera;
  kc.left = -32; kc.right = 32; kc.top = 32; kc.bottom = -32; kc.near = 0.1; kc.far = 120;
  scene.add(key);

  let bid = 0;
  const ops = { op_physics_create_world: () => {}, op_physics_add_static_box: () => bid++, op_physics_remove_body: () => {} } as unknown as WorldContext["ops"];
  const ecs = createEcsWorld();
  const world = {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: {} as WorldContext["camera"], ops, mode: "headless",
  } as WorldContext;

  PLAN.forEach((b, i) => {
    const recipe: BuildingRecipe = {
      width: b.w, depth: b.d, height: b.h, rotation: b.rot,
      openings: [{ wall: "south", kind: "door", width: b.door, height: 2.2, sill: 0 }],
      roof: { type: "gable", pitch: b.h * 0.7, overhang: 0.5 },
    };
    assembleBuilding(recipe, b.pos, world, { seed: i + 1 });
  });
  renderSyncSystem(ecs);
  scene.traverse((o: THREE.Object3D) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });

  let n = 0;
  const loop = (): void => { renderer.render(scene, camera); if (++n < 55) requestAnimationFrame(loop); else window.__kitReady = true; };
  loop();
}

main().catch((e) => { window.__kitErr = String((e && (e.stack || e.message)) || e); window.__kitReady = true; });
