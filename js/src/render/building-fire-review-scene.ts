/** CPU-side engine mount for the guarded V1 fire review.
 *
 * This composes exact, verified authorities through ordinary engine placement. It does not create a
 * renderer, submit a GPU frame, enable timestamp queries, or capture evidence.
 */

import * as THREE from "../../build/three.bundle.mjs";
import { AssetRegistry } from "../asset-registry.ts";
import { LiminaTracer } from "../observability/event.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { mountBuildingCompositionReview } from "./building-composition-review-scene.ts";
import { createBuildingFireRenderBinding, type BuildingFireRenderBinding,
  type BuildingFireRenderContract, type BuildingFireRenderInventory } from "./building-fire-render-binding.ts";
import { BuildingFireRuntime, type BuildingFireLightSample, type BuildingFireRuntimeSnapshot } from "./building-fire-runtime.ts";
import { verifyBuildingFireReviewClosure, type BuildingFireReviewAuthority } from "./building-fire-review-authority.ts";

type CompositionMount = Awaited<ReturnType<typeof mountBuildingCompositionReview>>;
type MaterialSlot = Readonly<{ mesh: THREE.Mesh; index: number | null; original: THREE.Material; override: THREE.Material }>;

export interface BuildingFireReviewInventory {
  readonly composition: CompositionMount["inventory"];
  readonly fire: Readonly<BuildingFireRenderInventory>;
  readonly fuelMaterialOverrides: number;
  readonly fuelMaterialsDarkNonEmissive: true;
  readonly fuelPlacedAtIdentity: true;
}

export interface BuildingFireReviewTrace {
  readonly schema: "limina.building-fire-review-mount-trace/v1";
  readonly authoritySchema: BuildingFireReviewAuthority["schema"];
  readonly packageId: string;
  readonly contractHash: string;
  readonly fuelAssetId: string;
  readonly fuelContentHash: string;
  readonly compositionArtifactId: "composition/functional-hall-house-v4/r3";
  readonly compositionContentDependency: false;
  readonly timestampQueriesEnabled: false;
}

export interface BuildingFireReviewMount {
  readonly authority: BuildingFireReviewAuthority;
  readonly contract: BuildingFireRenderContract;
  readonly composition: CompositionMount;
  readonly fuelEntity: string;
  readonly binding: BuildingFireRenderBinding;
  readonly runtime: BuildingFireRuntime;
  readonly inventory: Readonly<BuildingFireReviewInventory>;
  readonly trace: Readonly<BuildingFireReviewTrace>;
  readonly disposed: boolean;
  start(): boolean;
  extinguish(): boolean;
  advanceTicks(count?: number): Readonly<BuildingFireLightSample>;
  snapshot(): Readonly<BuildingFireRuntimeSnapshot>;
  restore(value: unknown): Readonly<BuildingFireLightSample>;
  setDynamicFireVisible(visible: boolean): void;
  dispose(): Promise<void>;
}

function emberRole(material: THREE.Material): boolean {
  const data = material.userData as Record<string, unknown>;
  return data["limina.materialRole"] === "hearth-embers" || data["limina.authorityRole"] === "hearth-embers"
    || material.name === "V1 hearth ember bed";
}

function darkCoalOverride(source: THREE.Material): THREE.Material {
  const result = source.clone(), candidate = result as THREE.Material & {
    color?: THREE.Color; emissive?: THREE.Color; emissiveIntensity?: number; emissiveMap?: THREE.Texture | null;
  };
  candidate.color?.setRGB(0.018, 0.009, 0.005, THREE.SRGBColorSpace);
  candidate.emissive?.setRGB(0, 0, 0, THREE.LinearSRGBColorSpace);
  if (candidate.emissiveIntensity !== undefined) candidate.emissiveIntensity = 0;
  if (candidate.emissiveMap !== undefined) candidate.emissiveMap = null;
  result.name = `${source.name || "hearth-embers"} [runtime dark substrate]`;
  result.userData = { ...source.userData, liminaRuntimeMaterialOverride: "hearth-embers-dark-non-emissive/v1",
    liminaRuntimeEmissionOwner: "building-fire-render-binding" };
  result.needsUpdate = true;
  return result;
}

function normalizeFuelEmbers(root: THREE.Object3D): Readonly<{ slots: readonly MaterialSlot[]; overrides: ReadonlySet<THREE.Material> }> {
  const slots: MaterialSlot[] = [], replacements = new Map<THREE.Material, THREE.Material>();
  const replace = (mesh: THREE.Mesh, original: THREE.Material, index: number | null): THREE.Material => {
    if (!emberRole(original)) return original;
    let override = replacements.get(original); if (override === undefined) { override = darkCoalOverride(original); replacements.set(original, override); }
    slots.push(Object.freeze({ mesh, index, original, override })); return override;
  };
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (Array.isArray(object.material)) object.material = object.material.map((material, index) => replace(object, material, index));
    else object.material = replace(object, object.material, null);
  });
  if (slots.length === 0) throw new Error("V1 fuel GLB exposes no hearth-embers material to normalize");
  return Object.freeze({ slots: Object.freeze(slots), overrides: new Set(replacements.values()) });
}

function restoreFuelMaterials(normalized: Readonly<{ slots: readonly MaterialSlot[]; overrides: ReadonlySet<THREE.Material> }>): void {
  for (const slot of normalized.slots) {
    if (slot.index === null) slot.mesh.material = slot.original;
    else {
      const materials = Array.isArray(slot.mesh.material) ? slot.mesh.material : [slot.mesh.material];
      materials[slot.index] = slot.original; slot.mesh.material = materials;
    }
  }
  for (const material of normalized.overrides) material.dispose();
}

/** Verify exact V1+C1 authority and mount review state through engine pipelines. CPU-side only. */
export async function mountBuildingFireReview(world: WorldContext, authorityValue: unknown): Promise<BuildingFireReviewMount> {
  const closure = verifyBuildingFireReviewClosure(authorityValue, (path) => {
    try { return world.ops.op_read_asset(path); } catch (error) { throw new Error(`V1 review authority resource is unreadable: ${path}`, { cause: error }); }
  });
  const authority = closure.authority, contract = closure.contract as BuildingFireRenderContract;
  if (authority.approvalPolicy.timestampQueriesEnabled !== false || contract.budgets.timestampQueriesEnabled !== false) {
    throw new Error("V1 fire review mount prohibits timestamp queries");
  }
  let composition: CompositionMount | undefined, fuelEntity: string | undefined;
  let normalized: ReturnType<typeof normalizeFuelEmbers> | undefined;
  let binding: BuildingFireRenderBinding | undefined, runtime: BuildingFireRuntime | undefined;
  const assets = new AssetRegistry(world.ops), registry = new SkillRegistry(new LiminaTracer("building-fire-v1-review"));
  const base = { agentId: "building-fire-v1-review", sessionId: "building-fire-v1-review",
    permissions: resolveProfile("builder.readWrite"), tick: 1, world };
  const destroyFuel = async (): Promise<void> => {
    if (fuelEntity === undefined) return; const entity = fuelEntity; fuelEntity = undefined;
    const result = await registry.invoke("scene.destroyEntity", { entity }, { ...base, tick: 2 });
    if (!result.success || (result.result as { removed?: boolean }).removed !== true) {
      throw new Error(`failed to destroy V1 fuel entity: ${JSON.stringify(result.success ? result.result : result.error)}`);
    }
  };
  try {
    composition = await mountBuildingCompositionReview(world, closure.c1Authority);
    const fuelPath = contract.fuelAsset.runtimeGlb.path, fuelBytes = world.ops.op_read_asset(fuelPath);
    const fuelAssetId = contract.fuelAsset.runtimeGlb.assetId;
    if (portableAssetContentHash(fuelBytes) !== portableAssetContentHash(world.ops.op_read_asset(authority.fuel.runtimeGlb.path))) {
      throw new Error("V1 fuel bytes drifted between verified authority and placement");
    }
    assets.seed(fuelAssetId, fuelBytes); registerCoreSkills(registry, { assets }); const fuelHash = assets.hashOf(fuelAssetId);
    const placed = await registry.invoke("asset.place", { assetId: fuelAssetId, hash: fuelHash, position: [0, 0, 0],
      rotation: [0, 0, 0], scale: [1, 1, 1], ground: false }, base);
    if (!placed.success) throw new Error(`asset.place failed for V1 fuel: ${JSON.stringify(placed.error)}`);
    const result = placed.result as { entity: string; hash: string }; fuelEntity = result.entity;
    if (result.hash !== fuelHash) throw new Error("V1 fuel asset.place returned an unpinned content hash");
    const fuelRoot = world.entities.resolve(fuelEntity)?.mesh as THREE.Object3D | undefined;
    if (fuelRoot === undefined) throw new Error("V1 fuel asset.place did not mount a render object");
    if (fuelRoot.position.x !== 0 || fuelRoot.position.y !== 0 || fuelRoot.position.z !== 0
      || fuelRoot.rotation.x !== 0 || fuelRoot.rotation.y !== 0 || fuelRoot.rotation.z !== 0
      || fuelRoot.scale.x !== 1 || fuelRoot.scale.y !== 1 || fuelRoot.scale.z !== 1) throw new Error("V1 fuel placement is not identity");
    normalized = normalizeFuelEmbers(fuelRoot);
    binding = createBuildingFireRenderBinding({ parent: world.scene, contract });
    const parameters = contract.simulation.parameters;
    runtime = new BuildingFireRuntime({ seed: contract.simulation.seed, ignitionTicks: parameters.ignitionTicks,
      extinguishTicks: parameters.extinguishTicks, lightBaseCandela: parameters.lightBaseCandela,
      lightFlickerCandela: parameters.lightFlickerCandela, lightDistanceM: parameters.lightDistanceM, binding });
    const inventory = Object.freeze({ composition: composition.inventory, fire: binding.inventory,
      fuelMaterialOverrides: normalized.overrides.size, fuelMaterialsDarkNonEmissive: true as const,
      fuelPlacedAtIdentity: true as const });
    const trace = Object.freeze({ schema: "limina.building-fire-review-mount-trace/v1" as const,
      authoritySchema: authority.schema, packageId: contract.packageId, contractHash: authority.fireStage.contract.canonicalHash,
      fuelAssetId, fuelContentHash: fuelHash, compositionArtifactId: authority.visualContext.approvedArtifact.artifactId,
      compositionContentDependency: false as const, timestampQueriesEnabled: false as const });
    let disposed = false;
    const live = (): void => { if (disposed) throw new Error("building fire review mount is disposed"); };
    const mounted: BuildingFireReviewMount = {
      authority, contract, composition, fuelEntity, binding, runtime, inventory, trace,
      get disposed() { return disposed; },
      start() { live(); return runtime!.start(); }, extinguish() { live(); return runtime!.extinguish(); },
      advanceTicks(count = 1) { live(); return runtime!.advanceTicks(count); }, snapshot() { live(); return runtime!.snapshot(); },
      restore(value) { live(); return runtime!.restore(value); },
      setDynamicFireVisible(visible) { live(); binding!.setVisible(visible); },
      async dispose() {
        if (disposed) return; disposed = true; const failures: unknown[] = [];
        try { runtime!.dispose(); } catch (error) { failures.push(error); }
        try { restoreFuelMaterials(normalized!); } catch (error) { failures.push(error); }
        try { await destroyFuel(); } catch (error) { failures.push(error); }
        try { await composition!.dispose(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, "V1 fire review disposal failed");
      },
    };
    return Object.freeze(mounted);
  } catch (error) {
    const failures: unknown[] = [error];
    try { runtime?.dispose(); if (runtime === undefined) binding?.dispose(); } catch (cleanup) { failures.push(cleanup); }
    if (normalized !== undefined) try { restoreFuelMaterials(normalized); } catch (cleanup) { failures.push(cleanup); }
    try { await destroyFuel(); } catch (cleanup) { failures.push(cleanup); }
    if (composition !== undefined) try { await composition.dispose(); } catch (cleanup) { failures.push(cleanup); }
    if (failures.length > 1) throw new AggregateError(failures, "V1 fire review mount failed and rollback was incomplete");
    throw error;
  }
}
