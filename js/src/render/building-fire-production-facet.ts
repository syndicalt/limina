/** CPU-side production mount for the approved building fire facet.
 *
 * Fuel is mounted through asset.place and the procedural volume/light through the pinned render
 * binding. This module creates no renderer, submits no frame, and never enables timestamp queries.
 */

import * as THREE from "../../build/three.bundle.mjs";
import { AssetRegistry } from "../asset-registry.ts";
import { validateBuildingFireRuntimeV2, buildingFireRuntimeV2Hash } from "../assets/building-fire-runtime-v2.mjs";
import { computeLocalOffset } from "../ecs/hierarchy.ts";
import { LiminaTracer } from "../observability/event.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { sha256 } from "../world/sha256.mjs";
import { createBuildingFireRenderBinding, type BuildingFireRenderBinding, type BuildingFireRenderContract } from "./building-fire-render-binding.ts";
import { BuildingFireRuntime, type BuildingFireLightSample, type BuildingFireRuntimeSnapshot } from "./building-fire-runtime.ts";

type V3 = readonly [number, number, number];
type MaterialSlot = Readonly<{ mesh: THREE.Mesh; index: number | null; original: THREE.Material; override: THREE.Material }>;

export interface BuildingFireProductionFacetInput {
  readonly contractBytes: Uint8Array;
  readonly contractSha256: `sha256:${string}`;
  readonly contractHash: `sha256:${string}`;
  readonly fuelBytes: Uint8Array;
  readonly fuelSha256: `sha256:${string}`;
  readonly position: V3;
  readonly yaw: number;
  readonly parentEntity?: string;
}

export interface BuildingFireProductionFacet {
  readonly contract: BuildingFireRenderContract;
  readonly fuelEntity: string;
  readonly binding: BuildingFireRenderBinding;
  readonly runtime: BuildingFireRuntime;
  readonly fuelMaterialOverrides: number;
  readonly disposed: boolean;
  start(): boolean;
  extinguish(): boolean;
  advanceTicks(count?: number): Readonly<BuildingFireLightSample>;
  snapshot(): Readonly<BuildingFireRuntimeSnapshot>;
  restore(value: unknown): Readonly<BuildingFireLightSample>;
  setVisible(visible: boolean): void;
  dispose(): Promise<void>;
}

const rawHash = (bytes: Uint8Array): `sha256:${string}` => `sha256:${sha256(bytes)}`;

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
    let override = replacements.get(original);
    if (override === undefined) { override = darkCoalOverride(original); replacements.set(original, override); }
    slots.push(Object.freeze({ mesh, index, original, override })); return override;
  };
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (Array.isArray(object.material)) object.material = object.material.map((material, index) => replace(object, material, index));
    else object.material = replace(object, object.material, null);
  });
  if (slots.length === 0) throw new Error("production fire fuel exposes no hearth-embers material to normalize");
  return Object.freeze({ slots: Object.freeze(slots), overrides: new Set(replacements.values()) });
}

function restoreFuelMaterials(normalized: Readonly<{ slots: readonly MaterialSlot[]; overrides: ReadonlySet<THREE.Material> }>): void {
  for (const slot of normalized.slots) {
    if (slot.index === null) slot.mesh.material = slot.original;
    else { const materials = Array.isArray(slot.mesh.material) ? slot.mesh.material : [slot.mesh.material]; materials[slot.index] = slot.original; slot.mesh.material = materials; }
  }
  for (const material of normalized.overrides) material.dispose();
}

export async function mountBuildingFireProductionFacet(world: WorldContext, input: BuildingFireProductionFacetInput): Promise<BuildingFireProductionFacet> {
  if (!Number.isFinite(input.yaw) || !input.position.every(Number.isFinite)) throw new TypeError("production fire transform must be finite");
  if (rawHash(input.contractBytes) !== input.contractSha256) throw new Error("production fire raw contract bytes drifted");
  let contractValue: unknown;
  try { contractValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.contractBytes)); }
  catch (error) { throw new Error("production fire contract is not valid UTF-8 JSON", { cause: error }); }
  const contract = validateBuildingFireRuntimeV2(contractValue) as BuildingFireRenderContract;
  if (buildingFireRuntimeV2Hash(contract) !== input.contractHash) throw new Error("production fire canonical contract hash drifted");
  if (contract.budgets.timestampQueriesEnabled !== false) throw new Error("production fire prohibits timestamp queries");
  if (rawHash(input.fuelBytes) !== input.fuelSha256 || contract.fuelAsset.runtimeGlb.sha256 !== input.fuelSha256) throw new Error("production fire fuel bytes drifted");

  const assets = new AssetRegistry(world.ops), registry = new SkillRegistry(new LiminaTracer("building-fire-production-facet"));
  assets.seed(contract.fuelAsset.runtimeGlb.assetId, input.fuelBytes); registerCoreSkills(registry, { assets });
  const base = { agentId: "building-fire-production-facet", sessionId: "building-fire-production-facet",
    permissions: resolveProfile("builder.readWrite"), tick: 1, world };
  let fuelEntity: string | undefined, fuelMesh: THREE.Object3D | undefined, normalized: ReturnType<typeof normalizeFuelEmbers> | undefined;
  let binding: BuildingFireRenderBinding | undefined, runtime: BuildingFireRuntime | undefined, disposed = false;
  const destroyFuel = async (): Promise<void> => {
    if (fuelEntity === undefined) return; const entity = fuelEntity;
    if (world.entities.resolve(entity) === undefined) {
      if (fuelMesh !== undefined) world.scene.remove(fuelMesh);
      fuelEntity = undefined; fuelMesh = undefined; return;
    }
    const response = await registry.invoke("scene.destroyEntity", { entity }, { ...base, tick: 2 });
    if (!response.success || (response.result as { removed?: boolean }).removed !== true) throw new Error(`failed to destroy production fire fuel: ${JSON.stringify(response.success ? response.result : response.error)}`);
    fuelEntity = undefined; fuelMesh = undefined;
  };
  try {
    const placed = await registry.invoke("asset.place", { assetId: contract.fuelAsset.runtimeGlb.assetId,
      hash: assets.hashOf(contract.fuelAsset.runtimeGlb.assetId), position: input.position, rotation: [0, input.yaw, 0], scale: [1, 1, 1], ground: false }, base);
    if (!placed.success) throw new Error(`asset.place failed for production fire fuel: ${JSON.stringify(placed.error)}`);
    fuelEntity = (placed.result as { entity: string }).entity;
    const fuelEntry = world.entities.resolve(fuelEntity);
    if (fuelEntry?.mesh === undefined) throw new Error("production fire fuel did not mount a visual scene root");
    fuelMesh = fuelEntry.mesh as THREE.Object3D;
    if (input.parentEntity !== undefined) world.entities.setParent(fuelEntity, input.parentEntity, computeLocalOffset(world, input.parentEntity, fuelEntry.eid));
    normalized = normalizeFuelEmbers(fuelEntry.mesh as THREE.Object3D);
    binding = createBuildingFireRenderBinding({ parent: world.scene, contract });
    binding.root.position.set(...input.position); binding.root.rotation.set(0, input.yaw, 0); binding.root.updateMatrixWorld(true);
    runtime = new BuildingFireRuntime({ seed: contract.simulation.seed, ...contract.simulation.parameters, binding });
    const mountedFuel = fuelEntity, mountedBinding = binding, mountedRuntime = runtime, mountedNormalized = normalized;
    let runtimeDisposed = false, materialsRestored = false, fuelDestroyed = false;
    return Object.freeze({ contract, fuelEntity: mountedFuel, binding: mountedBinding, runtime: mountedRuntime,
      fuelMaterialOverrides: mountedNormalized.overrides.size, get disposed() { return disposed; },
      start: () => mountedRuntime.start(), extinguish: () => mountedRuntime.extinguish(),
      advanceTicks: (count = 1) => mountedRuntime.advanceTicks(count), snapshot: () => mountedRuntime.snapshot(),
      restore: (value: unknown) => mountedRuntime.restore(value), setVisible: (visible: boolean) => mountedBinding.setVisible(visible),
      dispose: async () => { if (disposed) return; const failures: unknown[] = [];
        if (!runtimeDisposed) try { mountedRuntime.dispose(); runtimeDisposed = true; } catch (error) { failures.push(error); }
        if (!materialsRestored) try { restoreFuelMaterials(mountedNormalized); materialsRestored = true; } catch (error) { failures.push(error); }
        if (!fuelDestroyed) try { await destroyFuel(); fuelDestroyed = true; } catch (error) { failures.push(error); }
        disposed = runtimeDisposed && materialsRestored && fuelDestroyed;
        if (failures.length) throw new AggregateError(failures, "production fire facet disposal failed");
        if (!disposed) throw new Error("production fire facet disposal did not complete"); },
    });
  } catch (error) {
    const failures: unknown[] = [error];
    try { runtime?.dispose(); } catch (failure) { failures.push(failure); }
    if (normalized !== undefined) try { restoreFuelMaterials(normalized); } catch (failure) { failures.push(failure); }
    try { await destroyFuel(); } catch (failure) { failures.push(failure); }
    if (failures.length > 1) throw new AggregateError(failures, "production fire facet mount failed and rollback reported errors");
    throw error;
  }
}
