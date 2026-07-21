import type { CameraLike, SceneObject } from "../engine.ts";
import type { AssetRegistry } from "../asset-registry.ts";
import { parseBiomePopulationAsset } from "../world/biome-population-asset.mjs";
import { parseGltfScene } from "../skills/three.ts";
import { buildAssetInstancedMeshes, disposeAssetInstancedMesh } from "../terrain/asset-scatter-render.ts";
import type { AssetInstance } from "../terrain/asset-scatter.ts";
import type { GrassFieldQualityTier } from "./grass-field-config.ts";
import type { GrassFieldVisualPackageRegistry } from "./grass-field-package.ts";
import { BiomeGrassPopulationRuntime, type BiomeGrassPopulationPlacement } from "./biome-grass-population-runtime.ts";
import { TreePopulationRuntime } from "./tree-population-runtime.ts";

type SceneLike = { add?(object: unknown): void; remove?(object: unknown): void };
interface PlannedPlacement { readonly role: string; readonly assetId: string; readonly contentHash: string; readonly x: number; readonly y: number; readonly z: number; readonly yaw: number; readonly scale: number; readonly pageX?: number; readonly pageZ?: number }
interface PopulationPlan { readonly placements: readonly PlannedPlacement[] }
interface GrassRuntime { readonly draws: number; readonly bladeCount: number; update(camera: CameraLike): void; dispose(): void }
interface ContinuousGrassDescriptor {
  readonly id: string; readonly role: string; readonly backend: "continuous-grass-field";
  readonly visualPackageId: string; readonly visualPackageVersion: string;
  readonly densityScale: number; readonly bladeScale: readonly [number, number]; readonly climate: string;
}

export type ContinuousGrassFactory = (input: Readonly<{
  descriptorAssetId: string;
  descriptor: ContinuousGrassDescriptor;
  visualPackage: ReturnType<GrassFieldVisualPackageRegistry["get"]>;
}>) => Promise<GrassRuntime>;

export interface BiomePopulationMountInput {
  readonly plan: PopulationPlan;
  readonly assets: AssetRegistry;
  readonly scene: SceneLike;
  readonly camera: CameraLike;
  readonly grassVisualPackages: GrassFieldVisualPackageRegistry;
  readonly grassQuality: GrassFieldQualityTier;
  readonly gltfCache?: unknown;
  readonly worldLods: { update(camera: CameraLike): void }[];
  readonly continuousGrassFactory?: ContinuousGrassFactory;
  readonly onError?: (error: unknown) => void;
}

export class BiomePopulationMount {
  readonly grass: readonly Readonly<{ role: string; descriptorAssetId: string; visualPackageId: string; visualPackageVersion: string }> [];
  /** Exact tree placements owned by this mount, independent of the currently selected LOD draws. */
  readonly canopyInstances: number;
  readonly treeDraws: number;
  readonly instancedDraws: number;
  private readonly trees: TreePopulationRuntime[];
  private readonly grassRuntimes: GrassRuntime[];
  private readonly meshes: unknown[];
  private readonly input: BiomePopulationMountInput;
  private disposed = false;

  private constructor(input: BiomePopulationMountInput, trees: TreePopulationRuntime[], grassRuntimes: GrassRuntime[], meshes: unknown[],
    grass: Readonly<{ role: string; descriptorAssetId: string; visualPackageId: string; visualPackageVersion: string }>[],
    canopyInstances: number, treeDraws: number, instancedDraws: number) {
    this.input = input; this.trees = trees; this.grassRuntimes = grassRuntimes; this.meshes = meshes;
    this.grass = Object.freeze(grass); this.canopyInstances = canopyInstances;
    this.treeDraws = treeDraws; this.instancedDraws = instancedDraws;
  }

  get grassDraws(): number { return this.grassRuntimes.reduce((sum, runtime) => sum + runtime.draws, 0); }
  get grassBlades(): number { return this.grassRuntimes.reduce((sum, runtime) => sum + runtime.bladeCount, 0); }

  static async create(input: BiomePopulationMountInput): Promise<BiomePopulationMount> {
    const byDescriptor = new Map<string, PlannedPlacement[]>();
    for (const placement of input.plan.placements) {
      const key = `${placement.assetId}\u0000${placement.contentHash}`;
      const list = byDescriptor.get(key); if (list === undefined) byDescriptor.set(key, [placement]); else list.push(placement);
    }
    const trees: TreePopulationRuntime[] = [], grassRuntimes: GrassRuntime[] = [], meshes: unknown[] = [];
    const grass: Readonly<{ role: string; descriptorAssetId: string; visualPackageId: string; visualPackageVersion: string }>[] = [];
    let treeDraws = 0, instancedDraws = 0, treeSpecies = 0, treePlacements = 0;
    const cleanup = (): void => {
      const errors: unknown[] = [];
      for (const runtime of grassRuntimes) { const index = input.worldLods.indexOf(runtime); if (index >= 0) input.worldLods.splice(index, 1); try { runtime.dispose(); } catch (error) { errors.push(error); } }
      for (const tree of trees) { const index = input.worldLods.indexOf(tree); if (index >= 0) input.worldLods.splice(index, 1); try { tree.dispose(); } catch (error) { errors.push(error); } }
      for (const mesh of meshes) { try { input.scene.remove?.(mesh); } catch (error) { errors.push(error); } try { disposeAssetInstancedMesh(mesh as never); } catch (error) { errors.push(error); } }
      if (errors.length > 0) throw new AggregateError(errors, `biome population cleanup failed in ${errors.length} operation(s)`);
    };
    try {
      for (const [key, placements] of [...byDescriptor].sort((left, right) => left[0].localeCompare(right[0]))) {
        const [descriptorAssetId, expectedHash] = key.split("\u0000"), resolved = input.assets.resolve(descriptorAssetId!);
        if (resolved.hash !== expectedHash) throw new Error(`biome population descriptor '${descriptorAssetId}' content hash mismatch`);
        let descriptor: any;
        try { descriptor = parseBiomePopulationAsset(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(resolved.bytes))); }
        catch (error) { throw new Error(`biome population descriptor '${descriptorAssetId}' is invalid: ${error instanceof Error ? error.message : String(error)}`); }
        if (placements.some((placement) => placement.role !== descriptor.role)) throw new Error(`biome population descriptor '${descriptorAssetId}' role does not match its planned placements`);
        if (descriptor.backend === "continuous-grass-field") {
          const visualPackage = input.grassVisualPackages.get(descriptor.visualPackageId);
          if (visualPackage.version !== descriptor.visualPackageVersion) {
            throw new Error(`biome grass population '${descriptor.id}' requires visual package '${descriptor.visualPackageId}' version '${descriptor.visualPackageVersion}', registered '${visualPackage.version}'`);
          }
          if (input.continuousGrassFactory === undefined) {
            throw new Error(`biome continuous grass population '${descriptor.id}' requires a terrain-density field factory`);
          }
          const runtime = await input.continuousGrassFactory({ descriptorAssetId,
            descriptor: descriptor as ContinuousGrassDescriptor, visualPackage });
          grassRuntimes.push(runtime); input.worldLods.push(runtime);
          grass.push(Object.freeze({ role: descriptor.role, descriptorAssetId,
            visualPackageId: descriptor.visualPackageId, visualPackageVersion: descriptor.visualPackageVersion }));
          continue;
        }
        if (descriptor.backend === "grass-field") {
          const visualPackage = input.grassVisualPackages.get(descriptor.visualPackageId);
          if (visualPackage.version !== descriptor.visualPackageVersion) {
            throw new Error(`biome grass population '${descriptor.id}' requires visual package '${descriptor.visualPackageId}' version '${descriptor.visualPackageVersion}', registered '${visualPackage.version}'`);
          }
          const grassPlacements: BiomeGrassPopulationPlacement[] = placements.map((placement, index) => {
            if (!Number.isSafeInteger(placement.pageX) || !Number.isSafeInteger(placement.pageZ)) {
              throw new Error(`biome grass population '${descriptor.id}' placement ${index} is missing canonical page coordinates`);
            }
            return { x: placement.x, y: placement.y, z: placement.z, yaw: placement.yaw, scale: placement.scale,
              pageX: placement.pageX!, pageZ: placement.pageZ! };
          });
          const runtime = new BiomeGrassPopulationRuntime({ role: descriptor.role, placements: grassPlacements,
            visualPackage, quality: input.grassQuality, variant: descriptor.climate, bladeScale: descriptor.bladeScale,
            scene: input.scene, onError: input.onError });
          try { runtime.initialize(input.camera); runtime.publish(); }
          catch (primary) {
            try { runtime.dispose(); } catch (rollback) {
              throw new AggregateError([primary, rollback], `biome grass population '${descriptor.id}' creation rollback failed`);
            }
            throw primary;
          }
          grassRuntimes.push(runtime); input.worldLods.push(runtime);
          grass.push(Object.freeze({ role: descriptor.role, descriptorAssetId,
            visualPackageId: descriptor.visualPackageId, visualPackageVersion: descriptor.visualPackageVersion }));
          continue;
        }
        if (descriptor.backend === "tree-population") {
          treeSpecies++; treePlacements += placements.length;
          if (treeSpecies > 12 || treePlacements > 24_576) throw new RangeError("biome tree population exceeds the B2 species/active caps");
          const source = input.assets.resolve(descriptor.sourceAssetId), reduced = input.assets.resolve(descriptor.reducedAssetId), impostor = input.assets.resolve(descriptor.impostorAssetId);
          if (source.hash !== descriptor.sourceContentHash || reduced.hash !== descriptor.reducedContentHash || impostor.hash !== descriptor.impostorContentHash) {
            throw new Error(`biome tree population '${descriptor.id}' rung content hash mismatch`);
          }
          const [baseRoot, reducedRoot, impostorRoot] = await Promise.all([
            parseGltfScene(descriptor.sourceAssetId, source.bytes, input.gltfCache as never),
            parseGltfScene(descriptor.reducedAssetId, reduced.bytes, input.gltfCache as never),
            parseGltfScene(descriptor.impostorAssetId, impostor.bytes, input.gltfCache as never),
          ]);
          const instances: AssetInstance[] = placements.map((placement) => ({ assetId: descriptor.sourceAssetId, x: placement.x, y: placement.y, z: placement.z, yaw: placement.yaw, scale: placement.scale }));
          const tree = new TreePopulationRuntime({ speciesId: descriptor.id, placements: instances,
            treeLod: { reducedId: descriptor.reducedAssetId, reducedDistance: descriptor.reducedDistance,
              impostorId: descriptor.impostorAssetId, impostorDistance: descriptor.impostorDistance,
              cullDistance: descriptor.cullDistance, hysteresis: descriptor.hysteresis },
            sourceHash: source.hash, reducedHash: reduced.hash, baseRoot, reducedRoot, impostorRoot, scene: input.scene,
            onError: input.onError });
          trees.push(tree); input.worldLods.push(tree); treeDraws += tree.draws;
          continue;
        }
        const asset = input.assets.resolve(descriptor.assetId);
        if (asset.hash !== descriptor.contentHash) throw new Error(`biome instanced asset '${descriptor.id}' content hash mismatch`);
        const root: SceneObject = await parseGltfScene(descriptor.assetId, asset.bytes, input.gltfCache as never);
        const instances: AssetInstance[] = placements.map((placement) => ({ assetId: descriptor.assetId, x: placement.x, y: placement.y, z: placement.z, yaw: placement.yaw, scale: placement.scale }));
        for (const mesh of buildAssetInstancedMeshes(root, instances, { chunkSize: 48 })) { input.scene.add?.(mesh); meshes.push(mesh); instancedDraws++; }
      }
      // Atomic population readiness includes every camera-resident tree page. Returning while
      // those pages are merely queued races native capture and first-frame gameplay against LOD
      // publication, even though canopyInstances already reports the authored placement count.
      await Promise.all(trees.map((tree) => tree.settleFully(input.camera)));
    } catch (primary) {
      try { cleanup(); } catch (rollback) { throw new AggregateError([primary, rollback], "biome population mount and rollback failed"); }
      throw primary;
    }
    return new BiomePopulationMount(input, trees, grassRuntimes, meshes, grass, treePlacements, treeDraws, instancedDraws);
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    const errors: unknown[] = [];
    for (const runtime of this.grassRuntimes) { const index = this.input.worldLods.indexOf(runtime); if (index >= 0) this.input.worldLods.splice(index, 1); try { runtime.dispose(); } catch (error) { errors.push(error); } }
    for (const tree of this.trees) { const index = this.input.worldLods.indexOf(tree); if (index >= 0) this.input.worldLods.splice(index, 1); try { tree.dispose(); } catch (error) { errors.push(error); } }
    for (const mesh of this.meshes) { try { this.input.scene.remove?.(mesh); } catch (error) { errors.push(error); } try { disposeAssetInstancedMesh(mesh as never); } catch (error) { errors.push(error); } }
    if (errors.length > 0) throw new AggregateError(errors, `biome population disposal failed in ${errors.length} operation(s)`);
  }
}
