import { z } from "../../build/zod.bundle.mjs";
import { AssetRegistry } from "../asset-registry.ts";
import {
  parseFunctionalBuildingCatalog,
  verifyFunctionalBuildingCatalogEntry,
} from "../assets/functional-building-catalog.mjs";
import { verifyFunctionalBuildingSiteArtifact } from "../assets/functional-building-site-artifact.mjs";
import { resolveFunctionalSettlementAtlas } from "../assets/functional-settlement-atlas.mjs";
import type { SkillRegistry, ExecutionContext, SkillDefinition } from "./registry.ts";

export interface FunctionalSettlementBuildingHandle {
  placementId: string;
  residencyUnitId: string;
  root: string;
  doors: readonly string[];
  parts: readonly string[];
  catalogEntryId: string;
  assetId: string;
  assetHash: string;
  position: readonly [number, number, number];
  yaw: number;
  atlasAnchorId: string;
  atlasRouteId: string;
  routeContact: readonly [number, number, number];
}

export interface FunctionalSettlementHandle {
  settlementId: string;
  planId: string;
  worldMapHash: string;
  buildings: readonly FunctionalSettlementBuildingHandle[];
}

/** Runtime ownership only. Residency policy is deliberately owned by the separate FB-5 manager. */
export class FunctionalSettlementPlacementManager {
  private readonly settlements = new Map<string, FunctionalSettlementHandle>();
  has(settlementId: string): boolean { return this.settlements.has(settlementId); }
  get(settlementId: string): FunctionalSettlementHandle | undefined { return this.settlements.get(settlementId); }
  size(): number { return this.settlements.size; }
  register(handle: FunctionalSettlementHandle): void {
    if (this.settlements.has(handle.settlementId)) throw new Error(`functional settlement: duplicate settlement '${handle.settlementId}'`);
    this.settlements.set(handle.settlementId, handle);
  }
  replace(handle: FunctionalSettlementHandle): void {
    if (!this.settlements.has(handle.settlementId)) throw new Error(`functional settlement: unknown settlement '${handle.settlementId}'`);
    this.settlements.set(handle.settlementId, handle);
  }
  unregister(settlementId: string): FunctionalSettlementHandle | undefined {
    const handle = this.settlements.get(settlementId);
    this.settlements.delete(settlementId);
    return handle;
  }
}

export interface FunctionalSettlementRegistrationOptions {
  /** Exact live terrain authority. Absence rejects placement before mutation. */
  sampleHeight?: (x: number, z: number) => number | undefined;
  placementManager?: FunctionalSettlementPlacementManager;
  /** Test/host fault seam, invoked only after complete authority preflight. */
  beforeBuildingPlacement?: (placementId: string, index: number) => void | Promise<void>;
  /** Test/host fault seam used to prove retry-safe ownership updates during teardown. */
  beforeBuildingDestroy?: (placementId: string, index: number) => void | Promise<void>;
}

const safeId = z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9._/-]{0,159}$/).refine((value) => !value.split("/").some((part) => part === "" || part === "." || part === ".."), "unsafe identifier");
const placeInput = z.object({
  settlementId: safeId,
  // The strict descriptor-aware parsers below are the sole untrusted-data reader. A Zod record
  // would enumerate nested hostile accessors before those parsers can reject them without execution.
  catalog: z.unknown(),
  plan: z.unknown(),
  worldMap: z.unknown(),
  connectorToleranceM: z.number().min(0).max(25).default(0),
  placementIds: z.array(safeId).min(1).max(256).optional(),
});
const buildingHandleSchema = z.object({
  placementId: z.string(), residencyUnitId: z.string(), root: z.string(), doors: z.array(z.string()), parts: z.array(z.string()),
  catalogEntryId: z.string(), assetId: z.string(), assetHash: z.string(), position: z.tuple([z.number(), z.number(), z.number()]), yaw: z.number(),
  atlasAnchorId: z.string(), atlasRouteId: z.string(), routeContact: z.tuple([z.number(), z.number(), z.number()]),
});
const placeOutput = z.object({ settlementId: z.string(), planId: z.string(), worldMapHash: z.string(), buildings: z.array(buildingHandleSchema) });

function nestedBase(ctx: ExecutionContext) {
  return { agentId: ctx.agentId, sessionId: ctx.sessionId, profile: ctx.profile, permissions: ctx.permissions,
    tick: ctx.tick, world: ctx.world, chainId: ctx.chainId };
}
function nestedResult(response: Awaited<ReturnType<SkillRegistry["invoke"]>>, operation: string): Record<string, unknown> {
  if (!response.success) throw new Error(`functional settlement: ${operation} failed: ${response.error?.code ?? "unknown"}: ${response.error?.message ?? "unknown failure"}`);
  return response.result as Record<string, unknown>;
}
function frozenHandle(value: FunctionalSettlementHandle): FunctionalSettlementHandle {
  return Object.freeze({ ...value, buildings: Object.freeze(value.buildings.map((building) => Object.freeze({ ...building,
    doors: Object.freeze([...building.doors]), parts: Object.freeze([...building.parts]), position: Object.freeze([...building.position]) as readonly [number,number,number],
    routeContact: Object.freeze([...building.routeContact]) as readonly [number,number,number] }))) });
}

export function registerFunctionalSettlementSkills(
  registry: SkillRegistry,
  assets: AssetRegistry,
  options: FunctionalSettlementRegistrationOptions = {},
): FunctionalSettlementPlacementManager {
  const manager = options.placementManager ?? new FunctionalSettlementPlacementManager();
  const place: SkillDefinition<z.infer<typeof placeInput>, z.infer<typeof placeOutput>> = {
    name: "settlement.placeFunctional", version: "1.0.0",
    description: "Transactionally place an exact Atlas/site/catalog-bound settlement exclusively through building.placeFunctional.",
    category: "scene", permissions: ["scene.write"], input: placeInput, output: placeOutput,
    handler: async (input, ctx) => {
      if (manager.has(input.settlementId)) throw new Error(`functional settlement: duplicate settlement '${input.settlementId}'`);
      if (options.sampleHeight === undefined) throw new Error("functional settlement: no exact live terrain sampler is bound");
      const catalog = parseFunctionalBuildingCatalog(input.catalog);
      const atlas = resolveFunctionalSettlementAtlas(input.plan, catalog, input.worldMap, { connectorToleranceM: input.connectorToleranceM });
      const catalogById = new Map(catalog.entries.map((entry: any) => [entry.entryId, entry]));
      const selectedIds = input.placementIds === undefined ? undefined : new Set(input.placementIds);
      if (selectedIds !== undefined) {
        if (selectedIds.size !== input.placementIds!.length || input.placementIds!.some((id, index) => index > 0 && input.placementIds![index - 1]! >= id))
          throw new Error("functional settlement: placementIds must be strictly sorted and unique");
        const known = new Set(atlas.plan.placements.map((placement: any) => placement.placementId));
        for (const id of selectedIds) if (!known.has(id)) throw new Error(`functional settlement: unknown selected placement '${id}'`);
      }

      // Complete every expensive/external authority read and verification before the first mutation.
      const preparedAll: any[] = atlas.placements.map((resolved: any) => {
        const placement = atlas.plan.placements.find((candidate: any) => candidate.placementId === resolved.placementId)!;
        const entry: any = catalogById.get(placement.catalogEntryId);
        if (placement.composition !== undefined || placement.furnishing !== undefined) {
          throw new Error(`functional settlement: placement '${placement.placementId}' requests composition/furnishing, but no exact transactional runtime adapter is bound`);
        }
        const asset = assets.resolve(entry.asset.assetId);
        const verified = verifyFunctionalBuildingCatalogEntry(entry, { assetId: asset.assetId, bytes: asset.bytes, engineContentHash: asset.hash });
        const siteAsset = assets.resolve(placement.siteFoundation.path);
        const site = verifyFunctionalBuildingSiteArtifact(siteAsset.bytes, placement.siteFoundation, {
          contract: verified.contract, sampleHeight: options.sampleHeight, placementId: placement.placementId,
          contractHash: placement.catalogContractHash, semanticFingerprint: placement.semanticFingerprint,
          worldMapHash: atlas.atlas.worldMapHash, position: placement.position, yaw: placement.yaw,
          routeContact: placement.entryConnector.routeContact,
        }).artifact;
        return { placement, resolved, entry, asset, site };
      });
      const prepared = selectedIds === undefined ? preparedAll : preparedAll.filter((item) => selectedIds.has(item.placement.placementId));

      const placed: FunctionalSettlementBuildingHandle[] = [];
      try {
        for (let index = 0; index < prepared.length; index++) {
          const item = prepared[index]!;
          await options.beforeBuildingPlacement?.(item.placement.placementId, index);
          const position: [number, number, number] = [item.placement.position[0], item.site.foundation.rootWorldY, item.placement.position[2]];
          const result = nestedResult(await registry.invoke("building.placeFunctional", {
            assetId: item.asset.assetId, hash: item.asset.hash, position, yaw: item.placement.yaw,
          }, nestedBase(ctx)), `building.placeFunctional '${item.placement.placementId}'`);
          placed.push({ placementId: item.placement.placementId, residencyUnitId: item.placement.residency.unitId,
            root: result.root as string, doors: result.doors as string[], parts: result.parts as string[],
            catalogEntryId: item.entry.entryId, assetId: item.asset.assetId, assetHash: result.hash as string,
            position, yaw: item.placement.yaw, atlasAnchorId: item.resolved.anchor.id, atlasRouteId: item.resolved.route.id,
            routeContact: item.resolved.routeContact as [number,number,number] });
        }
        const handle = frozenHandle({ settlementId: input.settlementId, planId: atlas.plan.planId,
          worldMapHash: atlas.atlas.worldMapHash, buildings: placed });
        manager.register(handle);
        ctx.emit("settlement.functionalPlaced", { settlementId: handle.settlementId, planId: handle.planId, buildings: handle.buildings.length });
        return handle as z.infer<typeof placeOutput>;
      } catch (error) {
        const failures: unknown[] = [error];
        for (const building of [...placed].reverse()) {
          try { nestedResult(await registry.invoke("building.destroyFunctional", { root: building.root }, nestedBase(ctx)), `rollback '${building.placementId}'`); }
          catch (failure) { failures.push(failure); }
        }
        if (failures.length > 1) throw new AggregateError(failures, "functional settlement: placement and rollback both failed");
        throw error;
      }
    },
  };

  const destroyInput = z.object({ settlementId: safeId });
  const destroy: SkillDefinition<z.infer<typeof destroyInput>, { settlementId: string; buildingsRemoved: number; entitiesRemoved: number }> = {
    name: "settlement.destroyFunctional", version: "1.0.0", description: "Idempotently destroy every building owned by a functional settlement.",
    category: "scene", permissions: ["scene.write"], input: destroyInput,
    output: z.object({ settlementId: z.string(), buildingsRemoved: z.number().int().nonnegative(), entitiesRemoved: z.number().int().nonnegative() }),
    handler: async (input, ctx) => {
      const handle = manager.get(input.settlementId);
      if (handle === undefined) return { settlementId: input.settlementId, buildingsRemoved: 0, entitiesRemoved: 0 };
      let entitiesRemoved = 0, remaining = [...handle.buildings];
      const destructionOrder = [...handle.buildings].reverse();
      for (let index = 0; index < destructionOrder.length; index++) {
        const building = destructionOrder[index]!;
        await options.beforeBuildingDestroy?.(building.placementId, index);
        const result = nestedResult(await registry.invoke("building.destroyFunctional", { root: building.root }, nestedBase(ctx)), `destroy '${building.placementId}'`);
        entitiesRemoved += result.removed as number;
        // Publish ownership after every successful whole-building destroy. If a later destroy
        // fails, retry sees only still-live units and never targets a root already torn down.
        remaining = remaining.filter((candidate) => candidate.root !== building.root);
        if (remaining.length === 0) manager.unregister(input.settlementId);
        else manager.replace(frozenHandle({ ...handle, buildings: remaining }));
      }
      ctx.emit("settlement.functionalDestroyed", { settlementId: input.settlementId, buildings: handle.buildings.length, entitiesRemoved });
      return { settlementId: input.settlementId, buildingsRemoved: handle.buildings.length, entitiesRemoved };
    },
  };
  registry.register(place as never); registry.register(destroy as never);
  return manager;
}
