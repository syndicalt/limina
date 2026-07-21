import * as THREE from "../build/three.bundle.mjs";
import {
  TREE_POPULATION_MAX_ACTIVE,
  type SelectedTreeInstance,
  type TreePopulationRung,
} from "../src/render/tree-population-plan.ts";
import {
  TREE_POPULATION_MAX_DRAWS,
  TREE_POPULATION_MAX_INSTANCE_BYTES,
  TreeSpeciesBatchAdapter,
  aggregateTreeSpeciesBatchMetrics,
  type TreeSpeciesBatchMetrics,
} from "../src/render/tree-population-batch.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_tree_population_batch FAIL: ${message}`);
}
function rejects(operation: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown; try { operation(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${String(error)}`);
}

const branchMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x6b3f25 });
const foliageMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x3f7d31, side: THREE.DoubleSide, alphaTest: 0.45 });
const impostorMaterial = new THREE.MeshBasicNodeMaterial({ color: 0xffffff, side: THREE.DoubleSide, alphaTest: 0.45 });
const capacity = 8;
const adapter = new TreeSpeciesBatchAdapter("oak", capacity, {
  speciesId: "oak", capacity,
  branch: { full: new THREE.BoxGeometry(1, 8, 1), reduced: new THREE.BoxGeometry(0.9, 7.5, 0.9), material: branchMaterial },
  foliage: { full: new THREE.PlaneGeometry(5, 5, 2, 2), reduced: new THREE.PlaneGeometry(4.8, 4.8), material: foliageMaterial },
  impostorGeometry: new THREE.PlaneGeometry(1, 1), impostorMaterial,
  atlasTextures: 2, atlasBytes: 2 * 1024 * 1024,
});
assert(adapter.root.children.length === 5 && adapter.metrics.draws === 5 && adapter.metrics.programGraphs === 3,
  "one species did not produce exactly two bark + two foliage + one impostor instanced draws");
assert(adapter.root.children.every((child) => (child as THREE.InstancedMesh).isInstancedMesh), "tree adapter retained a BatchedMesh/per-object draw path");

function tree(ordinal: number, rung: TreePopulationRung, x: number, z: number): SelectedTreeInstance {
  return { speciesId: "oak", ordinal, rung, x, y: 2, z, yaw: ordinal * 0.2, scale: 1 + ordinal * 0.05, localX: 0, localZ: 0 };
}
const SHIFT = 48 * 20_834;
const published = [tree(0, 0, SHIFT + 12, -SHIFT + 8), tree(1, 2, SHIFT + 22, -SHIFT + 18), tree(2, 1, SHIFT + 32, -SHIFT + 28)];
adapter.publish(published, SHIFT, -SHIFT);
assert(adapter.root.position.x === SHIFT && adapter.root.position.z === -SHIFT, "camera/page anchor was not applied at the species root");
assert(adapter.branchFull.count === 1 && adapter.branchReduced.count === 1 && adapter.foliageFull.count === 1 && adapter.foliageReduced.count === 1,
  "geometry rungs were not densely compacted into true instanced draws");
assert(adapter.impostors.count === 1, "impostor rung was not compacted into the single impostor draw");
const matrix = new THREE.Matrix4(); adapter.branchFull.getMatrixAt(0, matrix);
const local = new THREE.Vector3().setFromMatrixPosition(matrix);
assert(local.x === 12 && local.z === 8, `million-metre tree matrix was not feature-local: ${local.x},${local.z}`);

// A second publication changes rungs and compacts without adding renderer objects or programs.
adapter.publish([tree(0, 2, SHIFT + 12, -SHIFT + 8), tree(1, 2, SHIFT + 22, -SHIFT + 18)], SHIFT, -SHIFT);
assert(adapter.root.children.length === 5 && adapter.impostors.count === 2 && adapter.branchFull.count === 0 && adapter.branchReduced.count === 0,
  "rung replacement changed object count or retained stale geometry slots");

rejects(() => adapter.publish(Array.from({ length: capacity + 1 }, (_, index) => tree(index, 0, index, 0)), 0, 0),
  /exceeds capacity/, "species publication exceeded its exact capacity");
rejects(() => new TreeSpeciesBatchAdapter("oak", TREE_POPULATION_MAX_ACTIVE + 1, {
  speciesId: "oak", capacity: TREE_POPULATION_MAX_ACTIVE + 1,
  branch: { full: new THREE.BoxGeometry(), reduced: new THREE.BoxGeometry(), material: branchMaterial },
  foliage: { full: new THREE.PlaneGeometry(), reduced: new THREE.PlaneGeometry(), material: foliageMaterial },
  impostorGeometry: new THREE.PlaneGeometry(), impostorMaterial,
}), /capacity/, "over-budget species capacity was admitted");

const twelve = Array.from({ length: 12 }, () => adapter.metrics);
const aggregate = aggregateTreeSpeciesBatchMetrics(twelve);
assert(aggregate.draws === TREE_POPULATION_MAX_DRAWS && aggregate.programGraphs === 3 && aggregate.species === 12,
  "aggregate draw/program topology budget changed");
const overInstance: TreeSpeciesBatchMetrics = { ...adapter.metrics, instanceBytes: TREE_POPULATION_MAX_INSTANCE_BYTES + 1,
  totalBytes: adapter.metrics.totalBytes + TREE_POPULATION_MAX_INSTANCE_BYTES + 1 };
rejects(() => aggregateTreeSpeciesBatchMetrics([overInstance]), /instance residency/, "over-budget instance residency was admitted");
rejects(() => aggregateTreeSpeciesBatchMetrics([...twelve, adapter.metrics]), /species|draws/, "thirteenth resident species was admitted");

let branchDisposed = 0, branchReducedDisposed = 0, foliageDisposed = 0, foliageReducedDisposed = 0, impostorDisposed = 0;
const disposeBranch = adapter.branchFull.dispose.bind(adapter.branchFull);
const disposeBranchReduced = adapter.branchReduced.dispose.bind(adapter.branchReduced);
const disposeFoliage = adapter.foliageFull.dispose.bind(adapter.foliageFull);
const disposeFoliageReduced = adapter.foliageReduced.dispose.bind(adapter.foliageReduced);
const disposeImpostor = adapter.impostors.dispose.bind(adapter.impostors);
adapter.branchFull.dispose = () => { branchDisposed++; return disposeBranch(); };
adapter.branchReduced.dispose = () => { branchReducedDisposed++; return disposeBranchReduced(); };
adapter.foliageFull.dispose = () => { foliageDisposed++; return disposeFoliage(); };
adapter.foliageReduced.dispose = () => { foliageReducedDisposed++; return disposeFoliageReduced(); };
adapter.impostors.dispose = () => { impostorDisposed++; return disposeImpostor(); };
adapter.dispose(); adapter.dispose();
assert(branchDisposed === 1 && branchReducedDisposed === 1 && foliageDisposed === 1 && foliageReducedDisposed === 1 && impostorDisposed === 1 && adapter.root.children.length === 0,
  "tree batch teardown was not exact/idempotent");

console.log("p_tree_population_batch OK: five true InstancedMesh draws keep submissions population-constant on WebGPU/WebGL, dense three-rung compaction and million-metre local matrices are exact, budgets reject overflow, and cleanup is idempotent");
