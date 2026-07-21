import { parseFunctionalBuildingCatalog } from "../assets/functional-building-catalog.mjs";
import { assertApprovedFunctionalBuildingPublication } from "../assets/functional-building-publication.mjs";
import { assertApprovedFunctionalSettlementRelease } from "../assets/functional-settlement-release.mjs";
import { assertApprovedFunctionalSettlementFurnishingAuthority } from "../assets/functional-settlement-furnishing.mjs";
import { resolveFunctionalSettlementAtlas } from "../assets/functional-settlement-atlas.mjs";
import { canonicalCompilerJson } from "../world/compiler/canonical.mjs";
import { sha256 } from "../world/sha256.mjs";
import type { InvokeBase, SkillRegistry } from "./registry.ts";
import {
  FunctionalSettlementResidencyManager,
  type FunctionalSettlementResidencyOptions,
  type FunctionalSettlementResidencyTransaction,
} from "./functional-settlement-residency.ts";
import {
  FunctionalSettlementPlacementManager,
  type FunctionalSettlementBuildingHandle,
} from "./functional-settlement.ts";
import {
  FunctionalSettlementFurnishingRuntime,
  type FunctionalSettlementFurnishingRuntimeOptions,
} from "./functional-settlement-furnishing-runtime.ts";

export interface FunctionalSettlementResidentBuilding {
  readonly unitId: string;
  readonly placementId: string;
  readonly settlementId: string;
  /** Mutable only during rollback restoration so the residency manager's previous map remains live. */
  building: FunctionalSettlementBuildingHandle;
}

export interface FunctionalSettlementRuntimeResidencyInput {
  readonly namespace: string;
  readonly catalog: unknown;
  readonly plan: unknown;
  readonly worldMap: unknown;
  readonly connectorToleranceM?: number;
  readonly loadDistance: number;
  readonly keepDistance: number;
  readonly maxActiveUnits: number;
  readonly maxResidentBytes: number;
  readonly invokeBase: () => InvokeBase;
  /** Optional exact sidecar lifecycle; production callers use the furnishing-closed constructor. */
  readonly furnishingLifecycle?: Pick<FunctionalSettlementFurnishingRuntime, "furnish" | "ownerDestroyed">;
}

export interface ApprovedFunctionalSettlementRuntimeResidencyInput
  extends Omit<FunctionalSettlementRuntimeResidencyInput, "catalog"> {
  /** In-process result of exact review-ledger verification and catalog derivation. */
  readonly publication: unknown;
}

export interface ReleasedFunctionalSettlementRuntimeResidencyInput {
  readonly namespace: string;
  /** In-process result of exact publication/plan/WorldMap/site/release verification. */
  readonly release: unknown;
  readonly invokeBase: () => InvokeBase;
}

export interface FurnishedReleasedFunctionalSettlementRuntimeResidencyInput extends ReleasedFunctionalSettlementRuntimeResidencyInput {
  /** In-process result of exact furnishing-sidecar verification against this same release. */
  readonly furnishingAuthority: unknown;
  readonly beforeFurnitureInstancePlacement?: FunctionalSettlementFurnishingRuntimeOptions["beforeInstancePlacement"];
}

export interface FurnishedReleasedFunctionalSettlementRuntimeResidency {
  readonly residency: FunctionalSettlementResidencyManager<FunctionalSettlementResidentBuilding>;
  readonly furnishing: FunctionalSettlementFurnishingRuntime;
}

function settlementId(namespace: string, planId: string, unitId: string): string {
  if (!/^[a-z0-9][a-z0-9._/-]{0,79}$/.test(namespace) || namespace.split("/").some((part) => part === "" || part === "." || part === ".."))
    throw new TypeError("functional settlement residency namespace is not a bounded safe id");
  return `residency/${sha256(canonicalCompilerJson({ namespace, planId, unitId })).slice(0, 32)}`;
}
function result(response: Awaited<ReturnType<SkillRegistry["invoke"]>>, operation: string): Record<string, unknown> {
  if (!response.success) throw new Error(`functional settlement residency: ${operation} failed: ${response.error?.code ?? "unknown"}: ${response.error?.message ?? "unknown failure"}`);
  return response.result as Record<string, unknown>;
}

/**
 * Bind the pure bounded residency authority to exact runtime settlement placement. Loads stage one
 * complete functional building through settlement.placeFunctional; unloads destroy its whole owned
 * unit. No cell, generic asset, or legacy village API is available on this adapter.
 */
export function createFunctionalSettlementRuntimeResidency(
  registry: SkillRegistry,
  placementManager: FunctionalSettlementPlacementManager,
  input: FunctionalSettlementRuntimeResidencyInput,
): FunctionalSettlementResidencyManager<FunctionalSettlementResidentBuilding> {
  const catalog = parseFunctionalBuildingCatalog(input.catalog);
  const atlas = resolveFunctionalSettlementAtlas(input.plan, catalog, input.worldMap, { connectorToleranceM: input.connectorToleranceM ?? 0 });
  const entryById = new Map(catalog.entries.map((entry: any) => [entry.entryId, entry]));
  const placementById = new Map(atlas.plan.placements.map((placement: any) => [placement.placementId, placement]));
  const idByUnit = new Map<string, string>(atlas.plan.placements.map((placement: any) => [placement.residency.unitId,
    settlementId(input.namespace, atlas.plan.planId, placement.residency.unitId)] as [string, string]));

  const invoke = (name: string, value: unknown) => registry.invoke(name, value, input.invokeBase());
  const loadOne = async (unitId: string, placementId: string): Promise<FunctionalSettlementResidentBuilding> => {
    const id = idByUnit.get(unitId)!;
    result(await invoke("settlement.placeFunctional", { settlementId: id, catalog, plan: atlas.plan,
      worldMap: input.worldMap, connectorToleranceM: input.connectorToleranceM ?? 0, placementIds: [placementId] }), `load '${unitId}'`);
    const handle = placementManager.get(id);
    if (handle === undefined || handle.buildings.length !== 1 || handle.buildings[0]!.placementId !== placementId)
      throw new Error(`functional settlement residency: placement manager returned partial ownership for '${unitId}'`);
    if (input.furnishingLifecycle !== undefined) {
      try { await input.furnishingLifecycle.furnish(handle.buildings[0]!); }
      catch (error) {
        const failures: unknown[] = [error];
        try { result(await invoke("settlement.destroyFunctional", { settlementId: id }), `cleanup unfurnished '${unitId}'`); }
        catch (failure) { failures.push(failure); }
        if (failures.length > 1) throw new AggregateError(failures, `functional settlement residency: furnishing and building cleanup failed for '${unitId}'`);
        throw error;
      }
    }
    return { unitId, placementId, settlementId: id, building: handle.buildings[0]! };
  };
  const destroyOne = async (resource: FunctionalSettlementResidentBuilding): Promise<void> => {
    const output = result(await invoke("settlement.destroyFunctional", { settlementId: resource.settlementId }), `unload '${resource.unitId}'`);
    if (output.buildingsRemoved !== 1) throw new Error(`functional settlement residency: unload '${resource.unitId}' did not destroy exactly one whole building`);
    input.furnishingLifecycle?.ownerDestroyed(resource.placementId);
  };

  const stageTransition: FunctionalSettlementResidencyOptions<FunctionalSettlementResidentBuilding>["stageTransition"] = async (delta) => {
    const staged: FunctionalSettlementResidentBuilding[] = [];
    try {
      for (const unit of delta.load) staged.push(await loadOne(unit.unitId, unit.placementId));
    } catch (error) {
      const failures: unknown[] = [error];
      for (const resource of [...staged].reverse()) try { await destroyOne(resource); } catch (failure) { failures.push(failure); }
      if (failures.length > 1) throw new AggregateError(failures, "functional settlement residency: load staging and cleanup failed");
      throw error;
    }
    const next = new Map(delta.previous);
    for (const unit of delta.unload) next.delete(unit.unitId);
    for (const resource of staged) next.set(resource.unitId, resource);
    const destroyed: FunctionalSettlementResidentBuilding[] = [];
    let rolledBack = false;
    const transaction: FunctionalSettlementResidencyTransaction<FunctionalSettlementResidentBuilding> = {
      next,
      commit: async () => {
        for (const unit of delta.unload) {
          const resource = delta.previous.get(unit.unitId);
          if (resource === undefined) throw new Error(`functional settlement residency: missing prior resource '${unit.unitId}'`);
          await destroyOne(resource); destroyed.push(resource);
        }
      },
      rollback: async () => {
        if (rolledBack) return;
        rolledBack = true;
        const failures: unknown[] = [];
        for (const resource of [...staged].reverse()) {
          if (!placementManager.has(resource.settlementId)) continue;
          try { await destroyOne(resource); } catch (failure) { failures.push(failure); }
        }
        for (const resource of destroyed) {
          try {
            const restored = await loadOne(resource.unitId, resource.placementId);
            resource.building = restored.building;
          } catch (failure) { failures.push(failure); }
        }
        if (failures.length) throw new AggregateError(failures, "functional settlement residency: rollback could not restore whole-building ownership");
      },
    };
    return transaction;
  };

  return new FunctionalSettlementResidencyManager(atlas.plan, {
    loadDistance: input.loadDistance, keepDistance: input.keepDistance, maxActiveUnits: input.maxActiveUnits,
    maxResidentBytes: input.maxResidentBytes,
    estimateResidentBytes: (placement) => {
      const planPlacement: any = placementById.get(placement.placementId), entry: any = entryById.get(planPlacement.catalogEntryId);
      return entry.asset.byteLength;
    },
    stageTransition,
  });
}

/**
 * Production FB-5 entry point. It admits only the catalog derived from an exact HITL-approved
 * functional-building publication; forged/deserialized lookalikes and catalog substitution fail
 * before Atlas resolution, asset reads, or runtime mutation. The unprefixed constructor above is
 * retained as the lower-level mechanical adapter used by isolated engine tests.
 */
export function createApprovedFunctionalSettlementRuntimeResidency(
  registry: SkillRegistry,
  placementManager: FunctionalSettlementPlacementManager,
  input: ApprovedFunctionalSettlementRuntimeResidencyInput,
): FunctionalSettlementResidencyManager<FunctionalSettlementResidentBuilding> {
  const publication = assertApprovedFunctionalBuildingPublication(input.publication);
  return createFunctionalSettlementRuntimeResidency(registry, placementManager, {
    namespace: input.namespace,
    catalog: publication.catalog,
    plan: input.plan,
    worldMap: input.worldMap,
    connectorToleranceM: input.connectorToleranceM,
    loadDistance: input.loadDistance,
    keepDistance: input.keepDistance,
    maxActiveUnits: input.maxActiveUnits,
    maxResidentBytes: input.maxResidentBytes,
    furnishingLifecycle: input.furnishingLifecycle,
    invokeBase: input.invokeBase,
  });
}

/**
 * Fully closed FB-5 production entry point. Unlike the publication-only adapter, callers cannot
 * substitute plan, Atlas, site, terrain, or residency limits after release verification.
 */
export function createReleasedFunctionalSettlementRuntimeResidency(
  registry: SkillRegistry,
  placementManager: FunctionalSettlementPlacementManager,
  input: ReleasedFunctionalSettlementRuntimeResidencyInput,
): FunctionalSettlementResidencyManager<FunctionalSettlementResidentBuilding> {
  const loaded: any = assertApprovedFunctionalSettlementRelease(input.release);
  return createApprovedFunctionalSettlementRuntimeResidency(registry, placementManager, {
    namespace: input.namespace,
    publication: loaded.publication,
    plan: loaded.plan,
    worldMap: loaded.worldMap,
    connectorToleranceM: 0,
    loadDistance: loaded.runtime.loadDistance,
    keepDistance: loaded.runtime.keepDistance,
    maxActiveUnits: loaded.runtime.maxActiveUnits,
    maxResidentBytes: loaded.runtime.maxResidentBytes,
    invokeBase: input.invokeBase,
  });
}

/** Exact release + exact dormant furnishing sidecar production boundary (zero meshes/colliders). */
export function createFurnishedReleasedFunctionalSettlementRuntimeResidency(
  registry: SkillRegistry,
  placementManager: FunctionalSettlementPlacementManager,
  input: FurnishedReleasedFunctionalSettlementRuntimeResidencyInput,
): FurnishedReleasedFunctionalSettlementRuntimeResidency {
  const loaded: any = assertApprovedFunctionalSettlementRelease(input.release);
  const authority: any = assertApprovedFunctionalSettlementFurnishingAuthority(input.furnishingAuthority);
  if (authority.release !== loaded) throw new Error("functional settlement furnishing: authority was not verified against this exact in-process release");
  const furnishing = new FunctionalSettlementFurnishingRuntime(registry, {
    authority,
    invokeBase: input.invokeBase,
    beforeInstancePlacement: input.beforeFurnitureInstancePlacement,
  });
  const residency = createFunctionalSettlementRuntimeResidency(registry, placementManager, {
    namespace: input.namespace,
    catalog: loaded.publication.catalog,
    plan: loaded.plan,
    worldMap: loaded.worldMap,
    connectorToleranceM: 0,
    loadDistance: loaded.runtime.loadDistance,
    keepDistance: loaded.runtime.keepDistance,
    maxActiveUnits: loaded.runtime.maxActiveUnits,
    maxResidentBytes: loaded.runtime.maxResidentBytes,
    invokeBase: input.invokeBase,
    furnishingLifecycle: furnishing,
  });
  return Object.freeze({ residency, furnishing });
}
