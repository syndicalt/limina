import * as THREE from "../../build/three.bundle.mjs";
import { TREE_POPULATION_MAX_ACTIVE, TREE_POPULATION_MAX_SPECIES, type SelectedTreeInstance } from "./tree-population-plan.ts";
import { buildTreeImpostorGeometry, markTreeImpostorAttributesUpdated, writeTreeImpostorInstance, type TreeImpostorGeometry } from "./tree-impostor-material.ts";

export const TREE_POPULATION_MAX_DRAWS = 60;
export const TREE_POPULATION_PROGRAM_GRAPHS = 3;
export const TREE_POPULATION_MAX_ATLAS_TEXTURES = 24;
export const TREE_POPULATION_MAX_GEOMETRY_BYTES = 64 * 1024 * 1024;
export const TREE_POPULATION_MAX_INSTANCE_BYTES = 8 * 1024 * 1024;
export const TREE_POPULATION_MAX_ATLAS_BYTES = 96 * 1024 * 1024;
export const TREE_POPULATION_MAX_RENDERER_BYTES = 192 * 1024 * 1024;

export interface TreeGeometryRungs {
  readonly full: THREE.BufferGeometry;
  readonly reduced: THREE.BufferGeometry;
  readonly material: THREE.Material;
}
export interface TreeSpeciesBatchInput {
  readonly speciesId: string;
  readonly capacity: number;
  readonly branch: TreeGeometryRungs;
  readonly foliage: TreeGeometryRungs;
  readonly impostorGeometry: THREE.BufferGeometry;
  readonly impostorMaterial: THREE.Material;
  readonly atlasTextures?: number;
  readonly atlasBytes?: number;
}
export interface TreeSpeciesBatchMetrics {
  readonly species: number; readonly draws: number; readonly programGraphs: number; readonly capacity: number;
  readonly geometryBytes: number; readonly instanceBytes: number; readonly atlasTextures: number; readonly atlasBytes: number; readonly totalBytes: number;
}

function geometryBytes(geometry: THREE.BufferGeometry): number {
  let total = geometry.index?.array.byteLength ?? 0;
  for (const attribute of Object.values(geometry.attributes)) total += attribute.array.byteLength;
  return total;
}
function validateMetrics(metrics: TreeSpeciesBatchMetrics): void {
  if (metrics.species > TREE_POPULATION_MAX_SPECIES) throw new RangeError(`tree renderer species exceed ${TREE_POPULATION_MAX_SPECIES}`);
  if (metrics.draws > TREE_POPULATION_MAX_DRAWS) throw new RangeError(`tree renderer draws exceed ${TREE_POPULATION_MAX_DRAWS}`);
  if (metrics.programGraphs > TREE_POPULATION_PROGRAM_GRAPHS) throw new RangeError(`tree renderer program graphs exceed ${TREE_POPULATION_PROGRAM_GRAPHS}`);
  if (metrics.capacity > TREE_POPULATION_MAX_ACTIVE) throw new RangeError(`tree renderer capacity exceeds ${TREE_POPULATION_MAX_ACTIVE}`);
  if (metrics.geometryBytes > TREE_POPULATION_MAX_GEOMETRY_BYTES) throw new RangeError("tree renderer geometry residency exceeds 64 MiB");
  if (metrics.instanceBytes > TREE_POPULATION_MAX_INSTANCE_BYTES) throw new RangeError("tree renderer instance residency exceeds 8 MiB");
  if (metrics.atlasTextures > TREE_POPULATION_MAX_ATLAS_TEXTURES) throw new RangeError(`tree renderer atlas textures exceed ${TREE_POPULATION_MAX_ATLAS_TEXTURES}`);
  if (metrics.atlasBytes > TREE_POPULATION_MAX_ATLAS_BYTES) throw new RangeError("tree renderer atlas residency exceeds 96 MiB");
  if (metrics.totalBytes > TREE_POPULATION_MAX_RENDERER_BYTES) throw new RangeError("tree renderer residency exceeds 192 MiB");
}
export function aggregateTreeSpeciesBatchMetrics(species: readonly TreeSpeciesBatchMetrics[]): TreeSpeciesBatchMetrics {
  const metrics = Object.freeze({
    species: species.length, draws: species.reduce((sum, item) => sum + item.draws, 0),
    programGraphs: species.length === 0 ? 0 : TREE_POPULATION_PROGRAM_GRAPHS,
    capacity: species.reduce((sum, item) => sum + item.capacity, 0),
    geometryBytes: species.reduce((sum, item) => sum + item.geometryBytes, 0),
    instanceBytes: species.reduce((sum, item) => sum + item.instanceBytes, 0),
    atlasTextures: species.reduce((sum, item) => sum + item.atlasTextures, 0),
    atlasBytes: species.reduce((sum, item) => sum + item.atlasBytes, 0),
    totalBytes: species.reduce((sum, item) => sum + item.totalBytes, 0),
  });
  validateMetrics(metrics); return metrics;
}

function instanced(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, name: string): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = name; mesh.count = 0; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = true;
  return mesh;
}

/** One species = five genuine instanced draws. Unlike BatchedMesh, draw count never scales with
 * visible trees on WebGPU or WebGL without WEBGL_multi_draw. */
export class TreeSpeciesBatchAdapter {
  readonly root = new THREE.Group();
  readonly branchFull: THREE.InstancedMesh;
  readonly branchReduced: THREE.InstancedMesh;
  readonly foliageFull: THREE.InstancedMesh;
  readonly foliageReduced: THREE.InstancedMesh;
  readonly impostors: THREE.InstancedMesh;
  readonly metrics: TreeSpeciesBatchMetrics;
  private readonly impostorGeometry: TreeImpostorGeometry;
  private readonly meshes: readonly THREE.InstancedMesh[];
  private readonly ownedMaterials: readonly THREE.Material[];
  private published: readonly SelectedTreeInstance[] = Object.freeze([]);
  private anchorX = 0; private anchorZ = 0; private disposed = false;

  constructor(readonly speciesId: string, readonly capacity: number, input: TreeSpeciesBatchInput) {
    if (speciesId !== input.speciesId || speciesId.length === 0) throw new RangeError("tree batch speciesId mismatch");
    if (!Number.isSafeInteger(capacity) || capacity <= 0 || capacity > TREE_POPULATION_MAX_ACTIVE || capacity !== input.capacity) {
      throw new RangeError(`tree species '${speciesId}' capacity must be a positive safe integer <= ${TREE_POPULATION_MAX_ACTIVE}`);
    }
    this.branchFull = instanced(input.branch.full, input.branch.material, capacity, "limina-tree-branch-lod0");
    this.branchReduced = instanced(input.branch.reduced, input.branch.material, capacity, "limina-tree-branch-lod1");
    this.foliageFull = instanced(input.foliage.full, input.foliage.material, capacity, "limina-tree-foliage-lod0");
    this.foliageReduced = instanced(input.foliage.reduced, input.foliage.material, capacity, "limina-tree-foliage-lod1");
    this.impostorGeometry = buildTreeImpostorGeometry(input.impostorGeometry, capacity);
    this.impostors = instanced(this.impostorGeometry, input.impostorMaterial, capacity, "limina-tree-impostor");
    this.meshes = Object.freeze([this.branchFull, this.branchReduced, this.foliageFull, this.foliageReduced, this.impostors]);
    this.root.name = `limina-tree-species:${speciesId}`; this.root.add(...this.meshes);
    this.ownedMaterials = Object.freeze([...new Set([input.branch.material, input.foliage.material, input.impostorMaterial])]);
    const geometry = geometryBytes(input.branch.full) + geometryBytes(input.branch.reduced) + geometryBytes(input.foliage.full) +
      geometryBytes(input.foliage.reduced) + geometryBytes(input.impostorGeometry);
    // Five mat4 instance buffers plus explicit impostor centerScale+yaw attributes.
    const instance = capacity * (16 * 4 * 5 + 4 * 5);
    const atlasBytes = input.atlasBytes ?? 0;
    this.metrics = Object.freeze({ species: 1, draws: 5, programGraphs: 3, capacity, geometryBytes: geometry,
      instanceBytes: instance, atlasTextures: input.atlasTextures ?? 0, atlasBytes, totalBytes: geometry + instance + atlasBytes });
    validateMetrics(this.metrics);
  }

  publish(instances: readonly SelectedTreeInstance[], anchorX: number, anchorZ: number): void {
    if (this.disposed) throw new Error(`tree species batch '${this.speciesId}' is disposed`);
    if (!Number.isFinite(anchorX) || !Number.isFinite(anchorZ)) throw new RangeError("tree species batch anchor must be finite");
    if (instances.length > this.capacity) throw new RangeError(`tree species '${this.speciesId}' publication exceeds capacity ${this.capacity}`);
    const ordered = [...instances].sort((a, b) => a.ordinal - b.ordinal);
    if (ordered.some((tree) => tree.speciesId !== this.speciesId)) throw new RangeError(`tree species '${this.speciesId}' publication contains another species`);
    const previous = this.published, previousAnchorX = this.anchorX, previousAnchorZ = this.anchorZ;
    try { this.apply(ordered, anchorX, anchorZ); }
    catch (primary) {
      try { this.apply(previous, previousAnchorX, previousAnchorZ); }
      catch (rollback) { throw new AggregateError([primary, rollback], `tree species '${this.speciesId}' publication rollback failed`); }
      throw primary;
    }
    this.published = Object.freeze(ordered); this.anchorX = anchorX; this.anchorZ = anchorZ;
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    const errors: unknown[] = [];
    for (const operation of [() => this.root.remove(...this.meshes), ...this.meshes.map((mesh) => () => mesh.dispose()),
      () => this.impostorGeometry.dispose(), ...this.ownedMaterials.map((material) => () => material.dispose())]) {
      try { operation(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, `tree species '${this.speciesId}' disposal failed in ${errors.length} operation(s)`);
  }

  private apply(instances: readonly SelectedTreeInstance[], anchorX: number, anchorZ: number): void {
    this.root.position.set(anchorX, 0, anchorZ);
    let full = 0, reduced = 0, impostor = 0;
    const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
    for (const tree of instances) {
      matrix.compose(position.set(tree.x - anchorX, tree.y, tree.z - anchorZ),
        quaternion.setFromEuler(new THREE.Euler(0, tree.yaw, 0)), scale.setScalar(tree.scale));
      if (tree.rung === 0) {
        this.branchFull.setMatrixAt(full, matrix); this.foliageFull.setMatrixAt(full, matrix); full++;
      } else if (tree.rung === 1) {
        this.branchReduced.setMatrixAt(reduced, matrix); this.foliageReduced.setMatrixAt(reduced, matrix); reduced++;
      } else {
        writeTreeImpostorInstance(this.impostorGeometry, impostor, tree, anchorX, anchorZ);
        this.impostors.setMatrixAt(impostor++, matrix);
      }
    }
    this.branchFull.count = this.foliageFull.count = full;
    this.branchReduced.count = this.foliageReduced.count = reduced;
    this.impostors.count = impostor;
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.count > 0) mesh.computeBoundingSphere();
    }
    markTreeImpostorAttributesUpdated(this.impostorGeometry);
  }
}
