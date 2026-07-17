import * as THREE from "../../build/three.bundle.mjs";
import { AssetRegistry } from "../asset-registry.ts";
import { INTERACTIVE_TEMPERATE_MEADOW_PACKAGE } from "../content/grass/interactive-temperate-meadow.ts";
import { RIPARIAN_REED_GRASS_PACKAGE } from "../content/grass/riparian-reed.ts";
import type { CameraLike, EngineOps } from "../engine.ts";
import { BiomePopulationMount } from "../render/biome-population-mount.ts";
import { BiomeGrassDensitySampler } from "../render/biome-grass-density.ts";
import { ContinuousBiomeGrassRuntime } from "../render/continuous-biome-grass-runtime.ts";
import { GrassFieldVisualPackageRegistry } from "../render/grass-field-package.ts";
import type { RenderQualityTier } from "../render/quality.ts";
import type { WorldContext } from "../skills/registry.ts";
import type { GltfSceneCache } from "../skills/three.ts";
import { parseBiomePopulationAsset } from "../world/biome-population-asset.mjs";
import { BIOME_LIBRARY_V1 } from "../world/biome-library-v1.mjs";
import { createBiomeRuntimePublication } from "../world/biome-runtime-publication.mjs";
import type {
  DetachedDerivedPopulationPlan,
  VerifiedBiomeContentBundle,
} from "./derived-runtime-render-candidate.ts";
import {
  DerivedRuntimeTransport,
  type DerivedRuntimeTransportConfig,
} from "./derived-runtime-transport.ts";

const DERIVED_CONTENT_FETCH_CONCURRENCY = 4;
type VerifiedBiomeContentEntry = VerifiedBiomeContentBundle["entries"][number];

export function derivedPopulationPlacementSurvives(input: Readonly<{ continuous: boolean; x: number; z: number;
  waterCoverageAt: (x:number,z:number)=>boolean; hardExclusionAt?: (x:number,z:number)=>boolean; discreteHardExclusionAt?: (x:number,z:number)=>boolean }>): boolean {
  return input.continuous || (!input.waterCoverageAt(input.x,input.z) && !(input.hardExclusionAt?.(input.x,input.z) ?? false)
    && !(input.discreteHardExclusionAt?.(input.x,input.z) ?? false));
}

export function combinedPopulationHardExclusion(waterCoverageAt:(x:number,z:number)=>boolean,
  hardExclusionAt?: (x:number,z:number)=>boolean):(x:number,z:number)=>boolean {
  return (x,z)=>waterCoverageAt(x,z)||(hardExclusionAt?.(x,z)??false);
}

export interface DerivedBiomeContentLoadResult {
  readonly bytes: Uint8Array;
}

export type DerivedBiomeContentLoader = (
  entry: VerifiedBiomeContentEntry,
  signal: AbortSignal,
) => Promise<DerivedBiomeContentLoadResult>;

export interface DerivedBiomePopulationMountInput {
  readonly plan: DetachedDerivedPopulationPlan;
  readonly content: VerifiedBiomeContentBundle;
  readonly root: THREE.Group;
  readonly terrainWindow: readonly Readonly<{ key: string; tx: number; tz: number; tile: import("../terrain/types.ts").TerrainTile }>[];
  readonly biomeField: Readonly<{ bytes: Uint8Array; contentHash: string }>;
  readonly runtimePack: Readonly<{ bytes: Uint8Array; semanticContentHash: string }>;
  readonly waterCoverageAt: (x: number, z: number) => boolean;
  readonly hardExclusionAt?: (x: number, z: number) => boolean;
  /** Additional canopy/prop-only exclusion. Continuous grass remains governed by hardExclusionAt. */
  readonly discreteHardExclusionAt?: (x: number, z: number) => boolean;
  readonly loadContent: DerivedBiomeContentLoader;
  readonly signal?: AbortSignal;
  readonly world: WorldContext;
  readonly camera: CameraLike;
  readonly quality: RenderQualityTier;
  readonly gltfCache: GltfSceneCache;
  readonly ops: EngineOps;
}

export interface DerivedBiomePopulationTransportMountInput extends Omit<DerivedBiomePopulationMountInput, "loadContent"> {
  readonly manifestHash: string;
  readonly contentAccess: DerivedRuntimeTransportConfig;
}

export interface DerivedBiomePopulationMountResult {
  readonly canopyInstances: number;
  readonly groundCoverTiles: number;
  readonly groundCoverBlades: number;
  dispose(): void;
}

async function boundedMap<T, R>(
  values: readonly T[],
  concurrency: number,
  callerSignal: AbortSignal | undefined,
  map: (value: T, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) forwardAbort();
  else callerSignal?.addEventListener("abort", forwardAbort, { once: true });
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error("derived content fetch was cancelled");
      }
      const index = next++;
      if (index >= values.length) return;
      output[index] = await map(values[index], controller.signal);
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, worker);
  try {
    await Promise.all(workers);
    return output;
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled(workers);
    throw error;
  } finally {
    callerSignal?.removeEventListener("abort", forwardAbort);
  }
}

function closureEntry(
  content: VerifiedBiomeContentBundle,
  assetId: string,
  contentHash: string,
): VerifiedBiomeContentEntry {
  const entry = content.entries.find((candidate) => candidate.assetId === assetId);
  if (entry === undefined || entry.contentHash !== contentHash) {
    throw new Error(`derived biome content closure does not authorize '${assetId}' at ${contentHash}`);
  }
  return entry;
}

/**
 * Shared, package-backed activation path for one independently verified population candidate.
 * Callers supply only a closure-scoped byte loader; descriptor parsing, reachable-leaf expansion,
 * cache prewarm, package registration, and atomic mount ownership remain identical in production
 * and in the frozen visual-review harness.
 */
export async function mountDerivedBiomePopulation(
  input: Readonly<DerivedBiomePopulationMountInput>,
): Promise<Readonly<DerivedBiomePopulationMountResult>> {
  const descriptorIdentities = [...new Map(input.plan.placements.map((placement) => [
    `${placement.assetId}\0${placement.contentHash}`,
    Object.freeze({ assetId: placement.assetId, contentHash: placement.contentHash }),
  ])).values()];
  const descriptorEntries = descriptorIdentities.map(({ assetId, contentHash }) => {
    const entry = closureEntry(input.content, assetId, contentHash);
    if (entry.kind !== "population-descriptor") {
      throw new Error(`derived biome population descriptor '${assetId}' has closure kind '${entry.kind}'`);
    }
    return entry;
  });
  const fetchedDescriptors = await boundedMap(
    descriptorEntries,
    DERIVED_CONTENT_FETCH_CONCURRENCY,
    input.signal,
    async (entry, signal) => ({ entry, result: await input.loadContent(entry, signal) }),
  );

  const requiredLeaves = new Map<string, VerifiedBiomeContentEntry>();
  const descriptorBackends = new Map<string, ReturnType<typeof parseBiomePopulationAsset>["backend"]>();
  for (const { entry, result } of fetchedDescriptors) {
    let descriptor: ReturnType<typeof parseBiomePopulationAsset>;
    try {
      descriptor = parseBiomePopulationAsset(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.bytes)));
    } catch (error) {
      throw new Error(`derived biome population descriptor '${entry.assetId}' is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    descriptorBackends.set(`${entry.assetId}\0${entry.contentHash}`, descriptor.backend);
    const requireLeaf = (assetId: string, contentHash: string, expectedKind: string): void => {
      const leaf = closureEntry(input.content, assetId, contentHash);
      if (leaf.kind !== expectedKind) {
        throw new Error(`derived biome content '${assetId}' has closure kind '${leaf.kind}', expected '${expectedKind}'`);
      }
      const prior = requiredLeaves.get(assetId);
      if (prior !== undefined && prior.contentHash !== contentHash) {
        throw new Error(`derived biome content closure assigns conflicting hashes to '${assetId}'`);
      }
      requiredLeaves.set(assetId, leaf);
    };
    if (descriptor.backend === "tree-population") {
      const tree = descriptor as unknown as {
        sourceAssetId: string; sourceContentHash: string;
        reducedAssetId: string; reducedContentHash: string;
        impostorAssetId: string; impostorContentHash: string;
      };
      requireLeaf(tree.sourceAssetId, tree.sourceContentHash, "model-source");
      requireLeaf(tree.reducedAssetId, tree.reducedContentHash, "model-lod");
      requireLeaf(tree.impostorAssetId, tree.impostorContentHash, "impostor");
    } else if (descriptor.backend === "instanced-asset") {
      const instanced = descriptor as unknown as { assetId: string; contentHash: string };
      requireLeaf(instanced.assetId, instanced.contentHash, "model-source");
    }
  }
  const fetchedLeaves = await boundedMap(
    [...requiredLeaves.values()],
    DERIVED_CONTENT_FETCH_CONCURRENCY,
    input.signal,
    async (entry, signal) => ({ entry, result: await input.loadContent(entry, signal) }),
  );
  if (input.signal?.aborted) {
    throw input.signal.reason instanceof Error ? input.signal.reason : new Error("derived biome content activation was cancelled");
  }

  const packageOps: EngineOps = {
    ...input.ops,
    op_read_asset: (assetId: string): Uint8Array => {
      throw new Error(`derived package registry has no closure-authorized asset '${assetId}'`);
    },
  };
  const assets = AssetRegistry.fromBundle([
    ...fetchedDescriptors.map(({ entry, result }) => ({
      id: entry.assetId, path: `assets/${entry.assetId}`, hash: entry.contentHash, bytes: result.bytes,
    })),
    ...fetchedLeaves.map(({ entry, result }) => ({
      id: entry.assetId, path: `assets/${entry.assetId}`, hash: entry.contentHash, bytes: result.bytes,
    })),
  ], packageOps);
  await input.gltfCache.prewarmActiveWorld(fetchedLeaves.map(({ entry, result }) => ({
    assetId: entry.assetId,
    bytes: result.bytes,
  })));
  if (input.signal?.aborted) {
    throw input.signal.reason instanceof Error ? input.signal.reason : new Error("derived biome content activation was cancelled");
  }
  const visualPackages = new GrassFieldVisualPackageRegistry();
  visualPackages.register(INTERACTIVE_TEMPERATE_MEADOW_PACKAGE);
  visualPackages.register(RIPARIAN_REED_GRASS_PACKAGE);
  const worldLods = (input.world.lods ??= []);
  let publication: ReturnType<typeof createBiomeRuntimePublication> | undefined;
  try {
    const runtimePack = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.runtimePack.bytes));
    publication = createBiomeRuntimePublication({
      fieldArtifactBytes: input.biomeField.bytes,
      fieldContentHash: input.biomeField.contentHash,
      runtimePack,
      runtimePackContentHash: input.runtimePack.semanticContentHash,
      metadataPack: BIOME_LIBRARY_V1,
    });
  } catch (error) {
    throw new Error(`derived continuous grass authority is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const density = new BiomeGrassDensitySampler(publication, assets);
  // Compiled vegetation placements are biome candidates, not permission to render submerged
  // above-water assets. Continuous grass keeps its descriptor sentinel and applies the same final
  // vetoes to every terrain sample below; all discrete grass, reeds, shrubs, and trees are culled here.
  const aboveWaterPlan: DetachedDerivedPopulationPlan = Object.freeze({
    ...input.plan,
    placements: Object.freeze(input.plan.placements.filter((placement) => derivedPopulationPlacementSurvives({
      continuous:descriptorBackends.get(`${placement.assetId}\0${placement.contentHash}`) === "continuous-grass-field",
      x:placement.x,z:placement.z,waterCoverageAt:input.waterCoverageAt,hardExclusionAt:input.hardExclusionAt,discreteHardExclusionAt:input.discreteHardExclusionAt}))),
  });
  let mount: BiomePopulationMount;
  try {
    mount = await BiomePopulationMount.create({
      plan: aboveWaterPlan,
      assets,
      scene: input.root,
      camera: input.camera,
      grassVisualPackages: visualPackages,
      grassQuality: input.quality,
      gltfCache: input.gltfCache,
      worldLods,
      continuousGrassFactory: async ({ descriptorAssetId, descriptor, visualPackage }) => {
        const descriptorHash = assets.resolve(descriptorAssetId).hash;
        return ContinuousBiomeGrassRuntime.create({
          role: descriptor.role,
          tiles: input.terrainWindow,
          // Water is the final semantic veto below. Sampling it again inside densityAt doubled an
          // expensive topology query for every dry candidate. Package-authoritative paintPolicy
          // prevents terrain paint from reintroducing grass before this single hard exclusion.
          densityAt: (x, z) => density.sampleBinding(x, z, descriptorAssetId, descriptorHash),
          hardExclusionAt: combinedPopulationHardExclusion(input.waterCoverageAt,input.hardExclusionAt),
          visualPackage,
          quality: input.quality,
          variant: descriptor.climate,
          bladeScale: descriptor.bladeScale,
          scene: input.root,
          camera: input.camera,
          ...(input.world.renderer === undefined ? {} : { renderer: input.world.renderer }),
        });
      },
    });
  } catch (primary) {
    try { publication.dispose(); } catch (rollback) {
      throw new AggregateError([primary, rollback], "derived biome population creation rollback failed");
    }
    throw primary;
  }
  return Object.freeze({
    canopyInstances: mount.canopyInstances,
    groundCoverTiles: mount.grassDraws,
    groundCoverBlades: mount.grassBlades,
    dispose: (): void => {
      const errors: unknown[] = [];
      try { mount.dispose(); } catch (error) { errors.push(error); }
      try { publication?.dispose(); } catch (error) { errors.push(error); }
      if (errors.length > 0) throw new AggregateError(errors, "derived biome population disposal failed");
    },
  });
}

/** Production adapter: retains authenticated, manifest-scoped DerivedRuntimeTransport fetches. */
export async function mountTransportDerivedBiomePopulation(
  input: Readonly<DerivedBiomePopulationTransportMountInput>,
): Promise<Readonly<DerivedBiomePopulationMountResult>> {
  const transport = new DerivedRuntimeTransport(input.contentAccess);
  return mountDerivedBiomePopulation({
    ...input,
    loadContent: async (entry, signal) => transport.fetchContent(input.manifestHash, {
      contentHash: entry.contentHash,
      byteLength: entry.byteLength,
    }, { signal }),
  });
}
