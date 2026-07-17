import * as THREE from "../../build/three.bundle.mjs";
import type { CameraLike, SceneObject } from "../engine.ts";
import type { AssetInstance, ScatterTreeLod } from "../terrain/asset-scatter.ts";
import { buildTreeFoliageMaterial } from "./tree-foliage-material.ts";
import { buildTreeImpostorMaterial } from "./tree-impostor-material.ts";
import { TreeSpeciesBatchAdapter } from "./tree-population-batch.ts";
import { TreePopulationBatchSet } from "./tree-population-batch-set.ts";
import { buildTreePopulationPlan, type TreePopulationPlacement } from "./tree-population-plan.ts";
import { TreePopulationResidencyController } from "./tree-population-residency.ts";

type StandardMaterial = THREE.MeshStandardMaterial & Partial<THREE.MeshStandardNodeMaterial>;
interface RoleGeometry { readonly geometry: THREE.BufferGeometry; readonly material: StandardMaterial }

function meshes(root: SceneObject): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  root.traverse?.((object) => { if ((object as unknown as THREE.Mesh).isMesh) found.push(object as unknown as THREE.Mesh); });
  return found;
}
function cameraPosition(camera: CameraLike): THREE.Vector3 {
  const position = new THREE.Vector3();
  const candidate = camera as unknown as {
    getWorldPosition?(target: THREE.Vector3): THREE.Vector3;
    position?: { x?: number; y?: number; z?: number };
  };
  if (candidate.getWorldPosition) candidate.getWorldPosition(position);
  else position.set(candidate.position?.x ?? 0, candidate.position?.y ?? 0, candidate.position?.z ?? 0);
  return position;
}
function role(mesh: THREE.Mesh): "branch" | "foliage" {
  if (Array.isArray(mesh.material)) throw new Error("tree runtime requires one material per flattened mesh primitive");
  const material = mesh.material as StandardMaterial;
  if (material?.isMeshStandardMaterial !== true) throw new Error("tree runtime requires MeshStandardMaterial-compatible source materials");
  const label = `${mesh.name} ${material.name}`;
  return material.alphaTest > 0 || material.transparent || /leaf|leaves|foliage|needle|canopy/i.test(label) ? "foliage" : "branch";
}
function extract(root: SceneObject, label: string): Readonly<{ branch: RoleGeometry; foliage: RoleGeometry }> {
  const groups = { branch: [] as RoleGeometry[], foliage: [] as RoleGeometry[] };
  for (const mesh of meshes(root)) {
    const material = mesh.material as StandardMaterial;
    groups[role(mesh)].push({ geometry: mesh.geometry, material });
  }
  if (groups.branch.length !== 1 || groups.foliage.length !== 1) {
    throw new Error(`${label} must flatten to exactly one branch and one foliage primitive; found ${groups.branch.length}/${groups.foliage.length}`);
  }
  return Object.freeze({ branch: groups.branch[0]!, foliage: groups.foliage[0]! });
}
function branchMaterial(source: StandardMaterial): THREE.MeshStandardNodeMaterial {
  if (source.map !== null) source.map.colorSpace = THREE.SRGBColorSpace;
  for (const texture of [source.aoMap, source.normalMap, source.roughnessMap, source.metalnessMap]) if (texture !== null) texture.colorSpace = THREE.NoColorSpace;
  return new THREE.MeshStandardNodeMaterial({ color: source.color.clone(), roughness: source.roughness, metalness: source.metalness,
    map: source.map, aoMap: source.aoMap, aoMapIntensity: source.aoMapIntensity, normalMap: source.normalMap,
    normalScale: source.normalScale.clone(), roughnessMap: source.roughnessMap, metalnessMap: source.metalnessMap });
}
function impostor(root: SceneObject, sourceHash: string, reducedHash: string): Readonly<{ geometry: THREE.BufferGeometry; material: THREE.MeshStandardNodeMaterial; atlasBytes: number }> {
  const found = meshes(root);
  if (found.length !== 1 || Array.isArray(found[0]!.material)) throw new Error("tree impostor runtime requires one quad primitive/material");
  const mesh = found[0]!, sourceMaterial = mesh.material as THREE.MeshStandardMaterial;
  const descriptor = (mesh.parent?.userData?.liminaTreeImpostor ?? mesh.userData?.liminaTreeImpostor ??
    (root as unknown as { userData?: Record<string, any> }).userData?.liminaTreeImpostor) as Record<string, any> | undefined;
  if (descriptor?.schema !== "limina.tree-impostor/2" || descriptor.sourceContentHash !== sourceHash || descriptor.lodContentHash !== reducedHash) {
    throw new Error("tree impostor descriptor does not match the pinned source/reduced asset hashes");
  }
  if (!(sourceMaterial.map instanceof THREE.Texture) || !(sourceMaterial.normalMap instanceof THREE.Texture)) throw new Error("tree impostor runtime requires embedded albedo and normal-depth textures");
  const config = descriptor.config;
  const material = buildTreeImpostorMaterial({ albedo: sourceMaterial.map, normalDepth: sourceMaterial.normalMap,
    grid: config.grid, cellSize: config.cellSize, alphaCutoff: config.alphaCutoff });
  const atlasBytes = config.atlasSize * config.atlasSize * 4 * 2;
  return Object.freeze({ geometry: mesh.geometry, material, atlasBytes });
}

export interface TreePopulationRuntimeInput {
  readonly speciesId: string;
  readonly placements: readonly AssetInstance[];
  readonly treeLod: ScatterTreeLod;
  readonly sourceHash: string;
  readonly reducedHash: string;
  readonly baseRoot: SceneObject;
  readonly reducedRoot: SceneObject;
  readonly impostorRoot: SceneObject;
  readonly scene: { add?(object: unknown): void; remove?(object: unknown): void };
  readonly onError?: (error: unknown) => void;
}

export class TreePopulationRuntime {
  readonly root: THREE.Group;
  readonly draws = 5;
  private readonly batches: TreePopulationBatchSet;
  private readonly residency: TreePopulationResidencyController;
  private readonly errors: unknown[] = [];
  private readonly scene: TreePopulationRuntimeInput["scene"];
  private disposalTask: Promise<void> | null = null;
  private disposed = false;

  constructor(input: TreePopulationRuntimeInput) {
    const base = extract(input.baseRoot, "tree LOD0"), reduced = extract(input.reducedRoot, "tree LOD1");
    const far = impostor(input.impostorRoot, input.sourceHash, input.reducedHash);
    const placements: TreePopulationPlacement[] = input.placements.map((tree) => ({ speciesId: input.speciesId,
      x: tree.x, y: tree.y, z: tree.z, yaw: tree.yaw, scale: tree.scale }));
    const plan = buildTreePopulationPlan(placements, [{ speciesId: input.speciesId,
      reducedDistance: input.treeLod.reducedDistance, impostorDistance: input.treeLod.impostorDistance,
      cullDistance: input.treeLod.cullDistance, ...(input.treeLod.hysteresis !== undefined ? { hysteresis: input.treeLod.hysteresis } : {}) }]);
    const adapter = new TreeSpeciesBatchAdapter(input.speciesId, Math.max(1, Math.min(placements.length, 24_576)), {
      speciesId: input.speciesId, capacity: Math.max(1, Math.min(placements.length, 24_576)),
      branch: { full: base.branch.geometry, reduced: reduced.branch.geometry, material: branchMaterial(base.branch.material) },
      foliage: { full: base.foliage.geometry, reduced: reduced.foliage.geometry, material: buildTreeFoliageMaterial(base.foliage.material) },
      impostorGeometry: far.geometry, impostorMaterial: far.material, atlasTextures: 2, atlasBytes: far.atlasBytes,
    });
    this.batches = new TreePopulationBatchSet([adapter]); this.root = this.batches.root;
    this.residency = new TreePopulationResidencyController(plan, { build: async (build) => this.batches.buildMount(build),
      onError: (error) => { this.errors.push(error); input.onError?.(error); } });
    this.scene = input.scene; input.scene.add?.(this.root);
  }

  update(camera: CameraLike): void {
    if (this.disposed) return;
    const position = cameraPosition(camera);
    this.residency.update(position.x, position.y, position.z);
  }
  async settle(): Promise<void> { await (this.disposalTask ?? this.residency.settle()); }
  /** Converge every desired page for a fixed camera before declaring a staged population ready. */
  async settleFully(camera: CameraLike): Promise<void> {
    if (this.disposed) throw new Error("cannot settle a disposed tree population runtime");
    const position = cameraPosition(camera);
    const maximumIterations = this.residency.plan.pages.length + 1;
    for (let iteration = 0; iteration < maximumIterations; iteration++) {
      const result = this.residency.update(position.x, position.y, position.z);
      await this.residency.settle();
      const errors = this.takeErrors();
      if (errors.length > 0) throw new AggregateError(errors, "tree population readiness failed");
      if (result.blocked) throw new Error("tree population readiness was blocked by its active-tree budget");
      if (result.launched === null) return;
    }
    throw new Error("tree population readiness did not converge within its page bound");
  }
  takeErrors(): unknown[] { return [...this.errors.splice(0), ...this.residency.takeErrors()]; }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    this.scene.remove?.(this.root);
    // clear() synchronously retires every active page before its first await. Dispose the shared
    // batch resources in this same terminal call so a world/candidate teardown cannot report
    // completion while GPU-facing meshes/materials remain live behind a promise microtask. A late
    // pending page is already generation-invalidated by clear() and can only dispose its unpublished
    // mount; it cannot commit into the now-disposed batch set.
    this.disposalTask = this.residency.clear().catch((error) => { this.errors.push(error); });
    this.batches.dispose();
  }
}
