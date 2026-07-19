import * as THREE from "../build/three.bundle.mjs";
import { AssetRegistry } from "../src/asset-registry.ts";
import { BiomePopulationMount } from "../src/render/biome-population-mount.ts";
import {
  GRASS_FIELD_VISUAL_PACKAGE_SCHEMA,
  GrassFieldVisualPackageRegistry,
  type GrassFieldVisualBuildContext,
  type GrassFieldVisualPackage,
  type GrassFieldVisualProfile,
} from "../src/render/grass-field-package.ts";
import { BIOME_POPULATION_ASSET_SCHEMA } from "../src/world/biome-population-asset.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_biome_grass_population_runtime FAIL: ${message}`);
}
async function rejects(fn: () => Promise<unknown>, pattern: RegExp, message: string): Promise<void> {
  let error: unknown;
  try { await fn(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}

const profile: GrassFieldVisualProfile = Object.freeze({
  maxResidentBlades: 12,
  bladesPerInstance: Object.freeze([3, 1]) as readonly [number, number],
  bladesPerSquareMeter: Object.freeze([12, 3]) as readonly [number, number],
  radius: 2,
  fineRadius: 1,
  spacingMultipliers: Object.freeze([1, 1]) as readonly [number, number],
  lod: Object.freeze([
    Object.freeze({ maxHeight: 0.4, maxHorizontalDisplacement: 0.09, footprintRadius: 0.1,
      fade: Object.freeze({ start: 10, end: 20 }) }),
    Object.freeze({ maxHeight: 0.25, maxHorizontalDisplacement: 0.04, footprintRadius: 0.08,
      fade: Object.freeze({ start: 20, end: 60 }) }),
  ]),
});

function packageFixture(version = "1.0.0", failLod?: 0 | 1) {
  const built: number[] = [], disposed: number[] = [];
  const pkg: GrassFieldVisualPackage = Object.freeze({
    schema: GRASS_FIELD_VISUAL_PACKAGE_SCHEMA,
    id: "test.grass.broad-tuft",
    version,
    variants: Object.freeze(["summer"]),
    profile: () => profile,
    createGeometry(context: GrassFieldVisualBuildContext) {
      built.push(context.lod);
      const geometry = new THREE.BoxGeometry(0.25, context.lod === 0 ? 0.5 : 0.3, 0.2);
      geometry.userData.testPackageLod = context.lod;
      geometry.addEventListener("dispose", () => disposed.push(context.lod));
      return geometry;
    },
    createMaterial(context: GrassFieldVisualBuildContext) {
      if (context.lod === failLod) throw new Error(`injected package LOD${context.lod} failure`);
      const material = new THREE.MeshBasicMaterial({ color: context.lod === 0 ? 0x228833 : 0x446622 });
      material.userData.testPackageLod = context.lod;
      return material;
    },
  });
  return { pkg, built, disposed };
}

const descriptorHash = `sha256:${"d".repeat(64)}`;
const descriptor = {
  schema: BIOME_POPULATION_ASSET_SCHEMA,
  id: "test-broad-ground-cover",
  version: "1.0.0",
  role: "flora/test-grass",
  backend: "grass-field",
  visualPackageId: "test.grass.broad-tuft",
  visualPackageVersion: "1.0.0",
  densityScale: 1,
  bladeScale: [0.8, 1.2],
  climate: "summer",
  provenance: { licenseId: "CC0-1.0", sourceUri: "https://example.invalid/test-grass" },
};
const descriptorBytes = new TextEncoder().encode(JSON.stringify(descriptor));
const assets = (): AssetRegistry => AssetRegistry.fromBundle([{
  id: "population/test-grass.json", path: "assets/population/test-grass.json", hash: descriptorHash, bytes: descriptorBytes,
}], { op_sha256: () => "" } as any);
const placement = (x: number, pageX: number) => ({ role: descriptor.role, assetId: "population/test-grass.json",
  contentHash: descriptorHash, x, y: 2 + x * 0.01, z: pageX, yaw: x * 0.05, scale: 1, pageX, pageZ: 0 });
const placements = [placement(0, 0), placement(1, 0), placement(2, 0), placement(30, 1), placement(31, 1), placement(32, 1)];

const visual = packageFixture(), packages = new GrassFieldVisualPackageRegistry(); packages.register(visual.pkg);
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(); camera.position.set(0, 4, 0);
const worldLods: { update(camera: any): void; settle?(): Promise<void> }[] = [];
const mount = await BiomePopulationMount.create({ plan: { placements }, assets: assets(), scene, camera, worldLods,
  grassVisualPackages: packages, grassQuality: "cinematic" });
assert(mount.grass.length === 1 && mount.grass[0]!.visualPackageId === visual.pkg.id
  && mount.grass[0]!.visualPackageVersion === visual.pkg.version, "mount did not expose its exact package pin");
assert(mount.grassDraws === 2 && mount.grassBlades === 12, "initial mixed-LOD field exceeded or underfilled its 12-blade budget");
assert(worldLods.length === 1 && scene.children.length === 1, "grass runtime was not registered as one owned world LOD root");
const meshes = (): THREE.InstancedMesh[] => {
  const result: THREE.InstancedMesh[] = [];
  scene.traverse((object) => { if ((object as THREE.InstancedMesh).isInstancedMesh) result.push(object as THREE.InstancedMesh); });
  return result;
};
assert(new Set(meshes().map((mesh) => mesh.geometry.userData.testPackageLod)).size === 2,
  "camera residency did not select both package LOD geometries");
assert(meshes().every((mesh) => mesh.geometry.getAttribute("aWind") !== undefined && mesh.frustumCulled),
  "package page lost its feature-local wind roots or bounded culling");
const reconstructed = new Set<number>();
const matrix = new THREE.Matrix4(), position = new THREE.Vector3();
for (const mesh of meshes()) for (let index = 0; index < mesh.count; index++) {
  mesh.getMatrixAt(index, matrix); position.setFromMatrixPosition(matrix);
  reconstructed.add(Math.round((position.x + mesh.position.x) * 1_000));
}
assert([0, 1, 2, 30, 31, 32].every((x) => reconstructed.has(x * 1_000)),
  "feature-local page transforms did not reconstruct the authored world positions");

camera.position.x = 30; worldLods[0]!.update(camera); await worldLods[0]!.settle?.();
assert(mount.grassBlades <= 12 && mount.grassDraws <= 2 && meshes().some((mesh) => mesh.name.endsWith("lod0"))
  && meshes().some((mesh) => mesh.name.endsWith("lod1")), "camera movement did not atomically exchange the two package LODs");
camera.position.x = 500; worldLods[0]!.update(camera); await worldLods[0]!.settle?.();
assert(mount.grassBlades === 0 && mount.grassDraws === 0 && meshes().length === 0,
  "out-of-range grass pages remained resident");
mount.dispose(); mount.dispose();
assert(worldLods.length === 0 && scene.children.length === 0, "grass runtime retained world/scene ownership after disposal");
assert(visual.disposed.length === 2, "package visual cache was not disposed exactly once per constructed LOD");

const missingScene = new THREE.Scene(), missingLods: { update(camera: any): void }[] = [];
await rejects(() => BiomePopulationMount.create({ plan: { placements }, assets: assets(), scene: missingScene, camera,
  worldLods: missingLods, grassVisualPackages: new GrassFieldVisualPackageRegistry(), grassQuality: "balanced" }),
/not registered/, "missing package did not fail closed");
assert(missingScene.children.length === 0 && missingLods.length === 0, "missing-package rejection published runtime state");

const wrong = packageFixture("2.0.0"), wrongRegistry = new GrassFieldVisualPackageRegistry(); wrongRegistry.register(wrong.pkg);
await rejects(() => BiomePopulationMount.create({ plan: { placements }, assets: assets(), scene: missingScene, camera,
  worldLods: missingLods, grassVisualPackages: wrongRegistry, grassQuality: "balanced" }),
/requires visual package.*1\.0\.0.*registered '2\.0\.0'/, "mismatched package version did not fail closed");
assert(missingScene.children.length === 0 && missingLods.length === 0, "version rejection published runtime state");

const failing = packageFixture("1.0.0", 1), failingRegistry = new GrassFieldVisualPackageRegistry(); failingRegistry.register(failing.pkg);
const rollbackScene = new THREE.Scene(), rollbackCamera = new THREE.PerspectiveCamera(); rollbackCamera.position.set(0, 2, 0);
const rollbackLods: { update(camera: any): void; settle?(): Promise<void> }[] = [], observed: unknown[] = [];
const rollbackMount = await BiomePopulationMount.create({ plan: { placements: placements.slice(0, 3) }, assets: assets(),
  scene: rollbackScene, camera: rollbackCamera, worldLods: rollbackLods, grassVisualPackages: failingRegistry,
  grassQuality: "balanced", onError: (error) => observed.push(error) });
assert(rollbackMount.grassDraws === 1 && rollbackMount.grassBlades === 9,
  "rollback fixture did not publish its initial package-owned LOD0 page");
rollbackCamera.position.x = 30; rollbackLods[0]!.update(rollbackCamera); await rollbackLods[0]!.settle?.();
const rollbackMeshes: THREE.InstancedMesh[] = [];
rollbackScene.traverse((object) => { if ((object as THREE.InstancedMesh).isInstancedMesh) rollbackMeshes.push(object as THREE.InstancedMesh); });
assert(observed.length === 1 && rollbackMeshes.length === 1 && rollbackMeshes[0]!.name.endsWith("lod0"),
  "failed LOD build replaced the prior page instead of rolling back");
assert(failing.disposed.includes(1), "failed package material build leaked its candidate geometry");
rollbackMount.dispose();
assert(rollbackScene.children.length === 0 && rollbackLods.length === 0, "rollback fixture retained runtime ownership");

console.log("p_biome_grass_population_runtime OK: exact package pinning, dense feature-local pages, two camera LODs, blade/draw caps, failure rollback, and complete disposal");
