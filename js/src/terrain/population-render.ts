import * as THREE from "../../build/three.bundle.mjs";
import type { CameraLike, SceneObject } from "../engine.ts";
import type { AssetInstance } from "./asset-scatter.ts";
import { buildAssetInstancedMeshes, disposeAssetInstancedMesh, setAssetInstancedMeshInstances } from "./asset-scatter-render.ts";

export interface PopulationLodLevel {
  assetId: string;
  distance: number;
  hysteresis?: number;
}

export interface LoadedPopulationLodLevel extends PopulationLodLevel {
  root: SceneObject;
}

export interface PopulationCell {
  key: string;
  cellX: number;
  cellZ: number;
  centerX: number;
  centerY: number;
  centerZ: number;
  instances: readonly AssetInstance[];
}

export interface PopulationLodBatches {
  meshes: readonly THREE.InstancedMesh[];
  cells: number;
  update(camera: CameraLike): void;
  dispose(scene?: { remove?(object: unknown): void }): void;
}

export function validatePopulationLodLevels(levels: readonly PopulationLodLevel[]): void {
  if (levels.length === 0) throw new RangeError("population LOD requires at least one level");
  let previousDistance = -1;
  const ids = new Set<string>();
  for (const [index, level] of levels.entries()) {
    if (typeof level.assetId !== "string" || level.assetId.length === 0) throw new TypeError(`population LOD level ${index} requires an assetId`);
    if (!Number.isFinite(level.distance) || level.distance < 0 || level.distance <= previousDistance) {
      throw new RangeError("population LOD distances must be finite, non-negative, and strictly increasing");
    }
    if (level.hysteresis !== undefined && (!Number.isFinite(level.hysteresis) || level.hysteresis < 0 || level.hysteresis > 1)) {
      throw new RangeError("population LOD hysteresis must be in [0, 1]");
    }
    if (ids.has(level.assetId)) throw new RangeError(`population LOD asset '${level.assetId}' is duplicated`);
    ids.add(level.assetId);
    previousDistance = level.distance;
  }
}

export function partitionPopulationInstances(instances: readonly AssetInstance[], cellSize: number): readonly Readonly<PopulationCell>[] {
  if (!Number.isFinite(cellSize) || cellSize <= 0) throw new RangeError("population cellSize must be positive and finite");
  const cells = new Map<string, { cellX: number; cellZ: number; instances: AssetInstance[] }>();
  for (const instance of instances) {
    const cellX = Math.floor(instance.x / cellSize);
    const cellZ = Math.floor(instance.z / cellSize);
    const key = `${cellX}:${cellZ}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { cellX, cellZ, instances: [] };
      cells.set(key, cell);
    }
    cell.instances.push(instance);
  }
  return Object.freeze([...cells.entries()]
    .sort((a, b) => (a[1].cellZ - b[1].cellZ) || (a[1].cellX - b[1].cellX))
    .map(([key, cell]) => {
      let minY = Infinity;
      let maxY = -Infinity;
      for (const instance of cell.instances) {
        if (instance.y < minY) minY = instance.y;
        if (instance.y > maxY) maxY = instance.y;
      }
      return Object.freeze({
        key,
        cellX: cell.cellX,
        cellZ: cell.cellZ,
        centerX: (cell.cellX + 0.5) * cellSize,
        centerY: (minY + maxY) * 0.5,
        centerZ: (cell.cellZ + 0.5) * cellSize,
        instances: Object.freeze(cell.instances),
      });
    }));
}

/**
 * Build a draw-call-bounded population. Cells retain stable LOD state, but instances
 * selected for the same level are aggregated into shared InstancedMeshes.
 */
export function buildPopulationLodBatches(
  levels: readonly LoadedPopulationLodLevel[],
  instances: readonly AssetInstance[],
  cellSize: number,
): PopulationLodBatches {
  validatePopulationLodLevels(levels);
  const cells = partitionPopulationInstances(instances, cellSize);
  const meshesByLevel = levels.map((level) => buildAssetInstancedMeshes(level.root, [...instances]));
  const meshes = meshesByLevel.flat();
  for (const mesh of meshes) mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const currentLevels = new Int16Array(cells.length);
  currentLevels.fill(-1);
  const cameraPosition = new THREE.Vector3();
  const selected = levels.map(() => [] as AssetInstance[]);
  let disposed = false;

  const classify = (distance: number, current: number): number => {
    let selectedLevel = 0;
    for (let index = 1; index < levels.length; index++) {
      const level = levels[index]!;
      const threshold = current === index ? level.distance * (1 - (level.hysteresis ?? 0.1)) : level.distance;
      if (distance < threshold) break;
      selectedLevel = index;
    }
    return selectedLevel;
  };

  const update = (camera: CameraLike): void => {
    if (disposed) return;
    const cameraLike = camera as unknown as {
      getWorldPosition?(target: THREE.Vector3): THREE.Vector3;
      position?: { x?: number; y?: number; z?: number };
      zoom?: number;
    };
    if (cameraLike.getWorldPosition !== undefined) cameraLike.getWorldPosition(cameraPosition);
    else cameraPosition.set(cameraLike.position?.x ?? 0, cameraLike.position?.y ?? 0, cameraLike.position?.z ?? 0);
    const zoom = cameraLike.zoom !== undefined && cameraLike.zoom > 0 ? cameraLike.zoom : 1;
    let changed = false;
    for (let index = 0; index < cells.length; index++) {
      const cell = cells[index]!;
      const dx = cameraPosition.x - cell.centerX;
      const dy = cameraPosition.y - cell.centerY;
      const dz = cameraPosition.z - cell.centerZ;
      const next = classify(Math.sqrt(dx * dx + dy * dy + dz * dz) / zoom, currentLevels[index]!);
      if (next !== currentLevels[index]) {
        currentLevels[index] = next;
        changed = true;
      }
    }
    if (!changed) return;
    for (const list of selected) list.length = 0;
    for (let index = 0; index < cells.length; index++) {
      const destination = selected[currentLevels[index]!]!;
      for (const instance of cells[index]!.instances) destination.push(instance);
    }
    for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
      for (const mesh of meshesByLevel[levelIndex]!) setAssetInstancedMeshInstances(mesh, selected[levelIndex]!);
    }
  };

  return Object.freeze({
    meshes: Object.freeze(meshes),
    cells: cells.length,
    update,
    dispose(scene?: { remove?(object: unknown): void }): void {
      if (disposed) return;
      disposed = true;
      const errors: unknown[] = [];
      for (const mesh of meshes) {
        try { scene?.remove?.(mesh); } catch (error) { errors.push(error); }
        try { disposeAssetInstancedMesh(mesh); } catch (error) { errors.push(error); }
      }
      if (errors.length > 0) throw new AggregateError(errors, `population LOD disposal failed in ${errors.length} operation(s)`);
    },
  });
}
