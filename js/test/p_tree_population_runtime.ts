import * as THREE from "../build/three.bundle.mjs";
import { TreePopulationRuntime } from "../src/render/tree-population-runtime.ts";
import type { AssetInstance } from "../src/terrain/asset-scatter.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_tree_population_runtime FAIL: ${message}`);
}
function treeRoot(detail: number): THREE.Group {
  const root = new THREE.Group();
  const bark = new THREE.MeshStandardMaterial({ color: 0x654020, roughness: 0.85 }); bark.name = "bark";
  const leafMap = new THREE.Texture(); leafMap.colorSpace = THREE.SRGBColorSpace;
  const leaves = new THREE.MeshStandardMaterial({ color: 0x4f8b39, roughness: 0.8, map: leafMap, alphaTest: 0.45 }); leaves.name = "leaves";
  root.add(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 8, detail), bark),
    new THREE.Mesh(new THREE.IcosahedronGeometry(2.5, detail > 6 ? 2 : 1).translate(0, 5, 0), leaves));
  return root;
}
function impostorRoot(sourceHash: string, reducedHash: string): THREE.Group {
  const root = new THREE.Group(), node = new THREE.Group();
  const bytes = new Uint8Array(64 * 64 * 4).fill(128), albedo = new THREE.DataTexture(bytes.slice(), 64, 64), normalDepth = new THREE.DataTexture(bytes.slice(), 64, 64);
  albedo.needsUpdate = normalDepth.needsUpdate = true;
  const material = new THREE.MeshStandardMaterial({ map: albedo, normalMap: normalDepth, alphaTest: 0.45, side: THREE.DoubleSide });
  node.userData.liminaTreeImpostor = { schema: "limina.tree-impostor/2", sourceSha256: sourceHash, lodSha256: reducedHash,
    sourceContentHash: sourceHash, lodContentHash: reducedHash,
    config: { grid: 2, cellSize: 32, atlasSize: 64, alphaCutoff: 0.45 } };
  node.add(new THREE.Mesh(new THREE.PlaneGeometry(5, 10).translate(0, 5, 0), material)); root.add(node); return root;
}

const sourceHash = `sha256:${"a".repeat(64)}`, reducedHash = `sha256:${"b".repeat(64)}`;
const placements: AssetInstance[] = [
  { assetId: "oak", x: -12, y: 0, z: 10, yaw: 0, scale: 1 },
  { assetId: "oak", x: 14, y: 0, z: 12, yaw: 0.5, scale: 1.1 },
  { assetId: "oak", x: 62, y: 0, z: 8, yaw: 1, scale: 0.9 },
];
const added: unknown[] = [], removed: unknown[] = [];
const scene = { add(object: unknown) { added.push(object); }, remove(object: unknown) { removed.push(object); } };
const runtime = new TreePopulationRuntime({ speciesId: "oak", placements,
  treeLod: { reducedId: "oak-lod", reducedDistance: 20, impostorId: "oak-impostor", impostorDistance: 45, cullDistance: 300, hysteresis: 0.1 },
  sourceHash, reducedHash, baseRoot: treeRoot(10), reducedRoot: treeRoot(6), impostorRoot: impostorRoot(sourceHash, reducedHash), scene });
assert(runtime.draws === 5 && added.includes(runtime.root), "runtime did not publish one five-draw species root");
const camera = new THREE.PerspectiveCamera(); camera.position.set(0, 4, 0);
await runtime.settleFully(camera);
const batches: THREE.InstancedMesh[] = []; runtime.root.traverse((object) => { if ((object as THREE.InstancedMesh).isInstancedMesh) batches.push(object as THREE.InstancedMesh); });
assert(batches.length === 5 && batches.reduce((sum, batch) => sum + batch.count, 0) === placements.length * 2 - 1,
  `runtime three-rung publication counts are wrong: ${batches.map((batch) => batch.count)}`);
assert(runtime.takeErrors().length === 0, "runtime reported a clean-build error");
camera.position.set(5000, 0, 5000); await runtime.settleFully(camera);
assert(batches.every((batch) => batch.count === 0), "far camera did not cull every population page");
let meshDisposals = 0;
for (const batch of batches) batch.dispose = () => { meshDisposals++; };
const ownedMaterials = [...new Set(batches.map((batch) => batch.material as THREE.Material))];
let materialDisposals = 0;
for (const material of ownedMaterials) material.dispose = () => { materialDisposals++; };
const impostorGeometry = batches.find((batch) => batch.name === "limina-tree-impostor")!.geometry;
let impostorGeometryDisposals = 0;
impostorGeometry.dispose = () => { impostorGeometryDisposals++; };
runtime.dispose();
assert(meshDisposals === 5 && materialDisposals === 3 && impostorGeometryDisposals === 1,
  `runtime returned from dispose before exact batch retirement (${meshDisposals}/5 meshes, ${materialDisposals}/3 materials, ${impostorGeometryDisposals}/1 impostor geometry)`);
await runtime.settle();
assert(removed.includes(runtime.root), "runtime disposal did not detach the shared root");

let invalid: unknown;
try { new TreePopulationRuntime({ speciesId: "oak", placements, treeLod: { reducedId: "oak-lod", reducedDistance: 20, impostorId: "bad", impostorDistance: 45, cullDistance: 300 },
  sourceHash, reducedHash, baseRoot: treeRoot(10), reducedRoot: treeRoot(6), impostorRoot: impostorRoot(sourceHash, `sha256:${"c".repeat(64)}`), scene }); }
catch (error) { invalid = error; }
assert(invalid instanceof Error && /descriptor/.test(invalid.message), "mismatched impostor source chain was admitted");

console.log("p_tree_population_runtime OK: flattened branch/foliage plus pinned v2 impostor compose into one shared five-draw root, camera residency converges/culls, terminal dispose retires all batch resources before returning, errors stay observable, and descriptor mismatch fails closed");
