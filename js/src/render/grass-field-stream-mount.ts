import * as THREE from "../../build/three.bundle.mjs";
import type { GrassFieldQualityTier, GrassFieldSourceOptions } from "./grass-field-config.ts";
import { grassFieldBladesPerInstance, grassFieldVisualBounds, type GrassFieldLod, type GrassFieldVisualPackage } from "./grass-field-package.ts";
import {
  buildGrassFieldComputeBatch,
  type GrassFieldComputeBatchInput,
  type GrassFieldComputeBatchResource,
  type GrassFieldComputeInput,
} from "./grass-field-compute.ts";
import { countGrassFieldTerrainSlots, prepareGrassFieldTerrainPages } from "./grass-field-terrain.ts";
import type { GrassFieldBounds } from "./grass-field-plan.ts";
import type { GrassFieldResidencyMount } from "./grass-field-residency.ts";
import type { TerrainTile } from "../terrain/types.ts";

export interface GrassFieldMountScene {
  add(child: unknown): void;
  remove(child: unknown): void;
}

export interface NativeGrassFieldStreamMount extends GrassFieldResidencyMount {
  readonly accepted: number;
  readonly pages: number;
}

export interface NativeGrassFieldStreamBuildInput {
  readonly scene: GrassFieldMountScene;
  readonly renderer: GrassFieldComputeInput["renderer"];
  readonly tile: TerrainTile;
  readonly source: GrassFieldSourceOptions;
  readonly spacingMultiplier: number;
  readonly requestedBounds?: GrassFieldBounds;
  readonly visualPackage: GrassFieldVisualPackage;
  readonly quality: GrassFieldQualityTier;
  readonly lod: GrassFieldLod;
  readonly variant?: string;
  readonly presentationBand?: string;
  readonly buildComputeBatch?: (input: GrassFieldComputeBatchInput) => GrassFieldComputeBatchResource;
}

function cleanupAll(operations: readonly (() => void)[], label: string): void {
  const errors: unknown[] = [];
  for (const operation of operations) try { operation(); } catch (error) { errors.push(error); }
  if (errors.length > 0) throw new AggregateError(errors, `${label} failed in ${errors.length} operation(s)`);
}

/** Exact fixed-slot reservation used by the residency controller and native build. */
export function prepareNativeGrassFieldStreamPages(input: Pick<NativeGrassFieldStreamBuildInput, "tile" | "source" | "spacingMultiplier" | "requestedBounds">) {
  const spacing = (input.source.spacing ?? 0.45) * input.spacingMultiplier;
  return prepareGrassFieldTerrainPages(input.tile, {
    seed: input.source.seed, spacing,
    elevationMin: input.source.elevationMin,
    elevationMax: input.source.elevationMax,
    slopeMax: input.source.slopeMax,
    exclusions: input.source.exclusions,
    densityAt: input.source.densityAt,
    hardExclusionAt: input.source.hardExclusionAt,
    paintPolicy: input.source.paintPolicy,
    placement: input.source.placement,
  }, input.requestedBounds);
}

export function nativeGrassFieldStreamSlots(input: Pick<NativeGrassFieldStreamBuildInput, "tile" | "source" | "spacingMultiplier" | "requestedBounds">): number {
  const spacing = (input.source.spacing ?? 0.45) * input.spacingMultiplier;
  return countGrassFieldTerrainSlots(input.tile, spacing, input.requestedBounds);
}

/** Build and dispatch an unpublished native-WebGPU terrain-tile mount. No scene mutation occurs. */
export async function buildNativeGrassFieldStreamMount(input: NativeGrassFieldStreamBuildInput): Promise<NativeGrassFieldStreamMount> {
  const prepared = prepareNativeGrassFieldStreamPages(input);
  const slots = prepared.reduce((sum, page) => sum + page.plan.slots, 0);
  const acceptedInstances = prepared.reduce((sum, page) => {
    let count = 0; for (const value of page.plan.accepted) count += value; return sum + count;
  }, 0);
  const accepted = acceptedInstances * grassFieldBladesPerInstance(
    input.visualPackage.profile(input.quality), input.lod, input.presentationBand);
  const cost = accepted;
  const root = new THREE.Group(); root.name = "limina:streamed-grass-field";
  root.userData.liminaGrassFieldPages = prepared.length;
  let compute: GrassFieldComputeBatchResource | undefined, geometry: THREE.BufferGeometry | undefined;
  let material: THREE.MeshStandardNodeMaterial | undefined, mesh: THREE.InstancedMesh | undefined;
  try {
    compute = (input.buildComputeBatch ?? buildGrassFieldComputeBatch)({ renderer: input.renderer,
      pages: prepared, sizeRange: input.source.sizeRange, featureOrigin: input.tile.origin });
    const context = { quality: input.quality, lod: input.lod, maxBlades: cost,
      fieldAttributes: { rootYaw: compute.rootYawAttribute, scale: compute.scaleAttribute },
      ...(input.variant === undefined ? {} : { variant: input.variant }),
      ...(input.presentationBand === undefined ? {} : { presentationBand: input.presentationBand }) } as const;
    const visual = grassFieldVisualBounds(input.visualPackage.profile(input.quality), input.lod,
      input.presentationBand);
    geometry = input.visualPackage.createGeometry(context);
    material = input.visualPackage.createMaterial(context) as THREE.MeshStandardNodeMaterial;
    mesh = new THREE.InstancedMesh(geometry, material, slots);
    const matrices = mesh.instanceMatrix.array as Float32Array;
    for (let slot = 0; slot < slots; slot++) {
      const offset = slot * 16;
      matrices[offset] = 1; matrices[offset + 5] = 1; matrices[offset + 10] = 1; matrices[offset + 15] = 1;
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.position.set(...input.tile.origin);
    mesh.name = "limina:streamed-grass-field-tile";
    mesh.castShadow = false; mesh.receiveShadow = false;
    let minY = Infinity, maxY = -Infinity;
    for (const entry of prepared) for (const y of entry.heights) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const sizeHi = input.source.sizeRange?.[1] ?? 1.3;
    const ry = (maxY - minY) / 2 + visual.maxHeight * sizeHi + visual.maxHorizontalDisplacement;
    const cy = (minY + maxY) / 2 - input.tile.origin[1] + visual.maxHeight * sizeHi / 2;
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, cy, 0), Math.sqrt(
      (input.tile.scale[0] / 2) ** 2 + ry * ry + (input.tile.scale[2] / 2) ** 2,
    ) + visual.footprintRadius * sizeHi);
    root.add(mesh);
    await compute.dispatch();
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      cleanupAll([
        ...(compute === undefined ? [] : [() => compute!.dispose()]),
        ...(material === undefined ? [] : [() => material!.dispose()]),
        ...(mesh === undefined ? [] : [() => mesh!.dispose()]),
        ...(geometry === undefined ? [] : [() => geometry!.dispose()]),
        () => root.clear(),
      ], "native grass field build rollback");
    } catch (failure) { failures.push(failure); }
    throw failures.length === 1 ? error : new AggregateError(failures, "native grass field build and rollback failed");
  }

  let published = false, disposed = false;
  const mount: NativeGrassFieldStreamMount = {
    slots, cost, accepted, pages: prepared.length,
    commit(previous?: GrassFieldResidencyMount): void {
      if (disposed) throw new Error("cannot publish a disposed native grass field mount");
      try { input.scene.add(root); } catch (error) {
        try { input.scene.remove(root); } catch (rollback) { throw new AggregateError([error, rollback], "native grass field initial publication rollback failed"); }
        throw error;
      }
      try {
        if (previous instanceof NativeMountHandle) previous.unpublish();
      } catch (error) {
        try { input.scene.remove(root); } catch (rollback) { throw new AggregateError([error, rollback], "native grass field publication rollback failed"); }
        throw error;
      }
      published = true;
    },
    dispose(): void {
      if (disposed) return; disposed = true;
      const operations: Array<() => void> = [];
      if (published) operations.push(() => input.scene.remove(root));
      operations.push(() => compute!.dispose(), () => material!.dispose(), () => mesh!.dispose(), () => geometry!.dispose(), () => root.clear());
      cleanupAll(operations, "native grass field mount disposal");
    },
  };
  return new NativeMountHandle(mount, () => { if (published) { input.scene.remove(root); published = false; } });
}

class NativeMountHandle implements NativeGrassFieldStreamMount {
  constructor(private readonly mount: NativeGrassFieldStreamMount, private readonly remove: () => void) {}
  get slots(): number { return this.mount.slots; }
  get cost(): number { return this.mount.cost ?? this.mount.slots; }
  get accepted(): number { return this.mount.accepted; }
  get pages(): number { return this.mount.pages; }
  commit(previous?: GrassFieldResidencyMount): void { this.mount.commit(previous); }
  dispose(): void { this.mount.dispose(); }
  unpublish(): void { this.remove(); }
}
