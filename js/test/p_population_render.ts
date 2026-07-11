import * as THREE from "../build/three.bundle.mjs";
import {
  buildPopulationLodBatches,
  partitionPopulationInstances,
  validatePopulationLodLevels,
} from "../src/terrain/population-render.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_population_render: ${message}`);
}

const instances = [
  { assetId: "tree.glb", x: -1, y: 2, z: 1, yaw: 0, scale: 1 },
  { assetId: "tree.glb", x: 2, y: 3, z: 1, yaw: 0.5, scale: 1.1 },
  { assetId: "tree.glb", x: 11, y: 4, z: 1, yaw: 1, scale: 0.9 },
];
const cells = partitionPopulationInstances(instances, 10);
assert(cells.length === 3 && cells[0]?.key === "-1:0" && cells[2]?.key === "1:0", "cell partition/order changed");
assert(cells[1]?.centerY === 3, "cell elevation center changed");

validatePopulationLodLevels([
  { assetId: "near.glb", distance: 0 },
  { assetId: "far.glb", distance: 30, hysteresis: 0.15 },
]);
let rejected = false;
try { validatePopulationLodLevels([{ assetId: "a", distance: 5 }, { assetId: "b", distance: 5 }]); } catch { rejected = true; }
assert(rejected, "non-increasing LOD distances were accepted");

const root = (segments: number): THREE.Group => {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.SphereGeometry(1, segments, Math.max(2, segments / 2)), new THREE.MeshBasicMaterial()));
  return group;
};
const batches = buildPopulationLodBatches([
  { assetId: "near.glb", distance: 0, root: root(12) as never },
  { assetId: "far.glb", distance: 30, root: root(4) as never },
], instances, 10);
const camera = new THREE.PerspectiveCamera();
camera.position.set(0, 3, 0);
batches.update(camera);
assert(batches.meshes.length === 2 && batches.meshes[0]?.count === 3 && batches.meshes[1]?.count === 0, "near cells were not aggregated");
camera.position.set(100, 3, 0);
batches.update(camera);
assert(batches.meshes[0]?.count === 0 && batches.meshes[1]?.count === 3, "far cells were not aggregated");
batches.dispose();
batches.dispose();

const hysteresis = buildPopulationLodBatches([
  { assetId: "near.glb", distance: 0, root: root(8) as never },
  { assetId: "far.glb", distance: 30, hysteresis: 0.1, root: root(4) as never },
], [{ assetId: "tree.glb", x: 5, y: 2, z: 5, yaw: 0, scale: 1 }], 10);
camera.position.set(35, 2, 5);
hysteresis.update(camera);
assert(hysteresis.meshes[1]?.count === 1, "outbound LOD threshold did not select far geometry");
camera.position.set(33, 2, 5);
hysteresis.update(camera);
assert(hysteresis.meshes[1]?.count === 1, "LOD hysteresis did not retain far geometry inside the return band");
camera.position.set(31, 2, 5);
hysteresis.update(camera);
assert(hysteresis.meshes[0]?.count === 1, "LOD hysteresis did not return to near geometry after the band");
hysteresis.dispose();
console.log("p_population_render: ok");
