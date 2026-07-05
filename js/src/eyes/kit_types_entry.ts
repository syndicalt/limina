// GPU-eyes proof that the SAME kit toolkit + DIFFERENT building briefs yields DIFFERENT, on-craft
// buildings. Reads ?type=cottage|monastery|keep|longhall, maps that archetype BRIEF (game/building-
// brief.ts) → recipe (briefToRecipe) → assembleBuilding, and renders it through the engine's REAL render
// baseline on the REAL GPU. Nothing bespoke: a cottage and a monastery diverge purely by their briefs.

import * as THREE from "../../build/three.bundle.mjs";
import { applyRenderBaseline } from "../render-baseline.ts";
import { EntityTable } from "../engine.ts";
import { createEcsWorld, renderSyncSystem } from "../ecs/world.ts";
import { createTransformStorage } from "../ecs/facade.ts";
import { UniformGridSpatialIndex } from "../spatial/index.ts";
import { assembleBuilding, briefToRecipe } from "../skills/building-recipe.ts";
import { COTTAGE_BRIEF, MONASTERY_BRIEF, KEEP_BRIEF, LONGHALL_BRIEF, type BuildingBrief } from "../game/building-brief.ts";
import { DEFAULT_DESIGN_DIRECTION } from "../game/design-direction.ts";
import type { WorldContext } from "../skills/registry.ts";

declare const window: { __kitReady?: boolean; __kitErr?: string; __label?: string; location: { search: string } };

const BRIEFS: Record<string, BuildingBrief> = {
  cottage: COTTAGE_BRIEF, monastery: MONASTERY_BRIEF, keep: KEEP_BRIEF, longhall: LONGHALL_BRIEF,
};

async function main(): Promise<void> {
  const type = new URLSearchParams(window.location.search).get("type") ?? "cottage";
  const brief = BRIEFS[type] ?? COTTAGE_BRIEF;
  const recipe = briefToRecipe(brief);
  window.__label = `${type}: ${brief.construction} · ${recipe.width}×${recipe.depth}×${recipe.height} · roof ${brief.roof.pitch}/${brief.roof.cover}`;

  const canvas = document.getElementById("limina-canvas") as HTMLCanvasElement;
  const W = canvas.width, H = canvas.height;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: !navigator.gpu } as never);
  await renderer.init();
  renderer.setSize(W, H, false);
  (renderer as unknown as { shadowMap: { enabled: boolean; type: number } }).shadowMap.enabled = true;
  (renderer as unknown as { shadowMap: { enabled: boolean; type: number } }).shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(46, W / H, 0.1, 600);
  // Frame the building from a grounded 3/4 angle, distance derived from its footprint + height.
  const bw = recipe.width, bd = recipe.depth, bh = recipe.height;
  const span = Math.max(bw, bd);
  const dist = span * 1.35 + bh * 0.9 + 5;
  camera.position.set(dist * 0.72, bh * 0.62 + 2.4, dist);
  camera.lookAt(0, bh * 0.42, 0);
  applyRenderBaseline({ scene, renderer: renderer as never, camera } as never);

  // A raking key light so timber relief, eaves + the base course throw real shadows.
  const key = new THREE.DirectionalLight(0xfff0da, 2.4);
  key.position.set(-span * 0.8, span + bh + 6, span * 0.7);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const kc = key.shadow.camera as THREE.OrthographicCamera;
  const r = span + bh + 6;
  kc.left = -r; kc.right = r; kc.top = r; kc.bottom = -r; kc.near = 0.1; kc.far = r * 3;
  scene.add(key);

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

  assembleBuilding(recipe, [0, 0, 0], world, { dd: DEFAULT_DESIGN_DIRECTION, seed: 7 });
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
