import * as THREE from "../build/three.bundle.mjs";
import { AssetRegistry } from "../src/asset-registry.ts";
import { BiomePopulationMount } from "../src/render/biome-population-mount.ts";
import { GrassFieldVisualPackageRegistry } from "../src/render/grass-field-package.ts";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`p_biome_population_mount FAIL: ${message}`); }
const assets = new AssetRegistry(), descriptor = assets.resolve("population/temperate-oak.json");
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(); camera.position.set(0, 4, 0);
const worldLods: { update(camera: any): void }[] = [];
const grassVisualPackages = new GrassFieldVisualPackageRegistry();
const placements = Array.from({ length: 12 }, (_, index) => ({ role: "flora/oak", assetId: descriptor.assetId,
  contentHash: descriptor.hash, x: (index % 4) * 5, y: 0, z: Math.floor(index / 4) * 5, yaw: index * 0.3, scale: 0.9 + index * 0.01 }));
const mount = await BiomePopulationMount.create({ plan: { placements }, assets, scene, camera, worldLods,
  grassVisualPackages, grassQuality: "balanced" });
assert(mount.treeDraws === 5 && mount.instancedDraws === 0 && mount.grass.length === 0, "tree descriptor did not select the B2 five-draw backend");
assert(mount.canopyInstances === placements.length, "population mount did not expose its exact canopy placement count");
assert(worldLods.length === 1 && scene.children.some((child) => child.name === "limina-tree-population-batches"), "tree backend did not register its controller/root");
const controller = worldLods[0] as any; for (let index = 0; index < 4; index++) { controller.update(camera); await controller.settle(); }
assert(controller.takeErrors().length === 0, "descriptor-driven tree residency reported an error");
mount.dispose(); mount.dispose(); await Promise.resolve(); await Promise.resolve();
assert(worldLods.length === 0 && !scene.children.some((child) => child.name === "limina-tree-population-batches"), "descriptor-driven population retained runtime ownership");
console.log("p_biome_population_mount OK: a content-addressed B3 role descriptor selected, pinned, mounted, converged, and released the B2 tree backend");
