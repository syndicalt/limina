import { z } from "../../build/zod.bundle.mjs";
import { assertApprovedFunctionalSettlementRelease } from "../assets/functional-settlement-release.mjs";
import { canonicalCompilerJson } from "../world/compiler/canonical.mjs";
import { sha256 } from "../world/sha256.mjs";
import type { SnapshotParticipant } from "../worldlog/snapshot.ts";
import type {
  FunctionalSettlementResidencyManager,
  FunctionalSettlementResidencySnapshot,
  FunctionalSettlementResidencyUnit,
} from "./functional-settlement-residency.ts";
import type { FunctionalSettlementResidentBuilding } from "./functional-settlement-runtime-residency.ts";
import type { FunctionalSettlementPlacementManager } from "./functional-settlement.ts";

export const RELEASED_FUNCTIONAL_SETTLEMENT_SNAPSHOT_SCHEMA = "limina.released-functional-settlement-snapshot/v1";

const hashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const idSchema = z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9._/-]{0,159}$/);
const namespaceSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9._/-]{0,79}$/);
const residencySnapshotSchema: z.ZodType<FunctionalSettlementResidencySnapshot> = z.object({
  planId: idSchema,
  residentUnitIds: z.array(idSchema).max(256),
  explicitInterestUnitIds: z.array(idSchema).max(256),
  residentBytes: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  closed: z.boolean(),
});

const releasedSnapshotSchema = z.object({
  schema: z.literal(RELEASED_FUNCTIONAL_SETTLEMENT_SNAPSHOT_SCHEMA),
  release: z.object({ releaseId: idSchema, settlementId: idSchema, closureHash: hashSchema, planId: idSchema }),
  namespace: namespaceSchema,
  runtime: z.object({
    loadDistance: z.number().nonnegative(), keepDistance: z.number().nonnegative(),
    maxActiveUnits: z.number().int().positive(), maxResidentBytes: z.number().int().positive(),
  }),
  residency: residencySnapshotSchema,
  ownership: z.array(z.object({
    unitId: idSchema, placementId: idSchema, settlementId: idSchema, buildingHash: hashSchema,
  })).max(256),
});

export type ReleasedFunctionalSettlementSnapshot = z.infer<typeof releasedSnapshotSchema>;

export interface ReleasedFunctionalSettlementSnapshotParticipantInput {
  readonly namespace: string;
  /** In-process exact release brand; deserialized lookalikes fail before participant creation. */
  readonly release: unknown;
  readonly residency: FunctionalSettlementResidencyManager<FunctionalSettlementResidentBuilding>;
  readonly placementManager: FunctionalSettlementPlacementManager;
}

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function buildingHash(building: unknown): string { return `sha256:${sha256(canonicalCompilerJson(building))}`; }
function runtimeJson(runtime: any): string {
  return canonicalCompilerJson({ loadDistance: runtime.loadDistance, keepDistance: runtime.keepDistance,
    maxActiveUnits: runtime.maxActiveUnits, maxResidentBytes: runtime.maxResidentBytes });
}

/**
 * Bind one released residency manager into the durable world snapshot. Placement ownership is
 * captured by the core `functionalSettlements.placements` participant; this later-sorting
 * participant restores policy/interest only after proving that every claimed resident unit maps
 * to the exact restored whole-building handle. It never invokes a placement skill during restore.
 */
export function createReleasedFunctionalSettlementSnapshotParticipant(
  input: ReleasedFunctionalSettlementSnapshotParticipantInput,
): SnapshotParticipant {
  const loaded: any = assertApprovedFunctionalSettlementRelease(input.release);
  if (!namespaceSchema.safeParse(input.namespace).success || input.namespace.split("/").some((part) => part === "" || part === "." || part === ".."))
    throw new TypeError("released functional settlement snapshot namespace is not a bounded safe id");
  const planId = loaded.plan.planId as string;
  const releaseId = loaded.release.releaseId as string;
  const releaseSettlementId = loaded.release.settlementId as string;
  const closureHash = loaded.release.closureHash as string;
  const placementByUnit = new Map<string, any>(loaded.plan.placements.map((placement: any) => [placement.residency.unitId, placement]));
  const settlementIdByUnit = new Map<string, string>([...placementByUnit.keys()].map((unitId) => [unitId,
    `residency/${sha256(canonicalCompilerJson({ namespace: input.namespace, planId, unitId })).slice(0, 32)}`]));
  const participantKey = `functionalSettlements.residency.${sha256(canonicalCompilerJson({ releaseId, closureHash, namespace: input.namespace })).slice(0, 24)}`;

  const resolveOwnership = (unit: FunctionalSettlementResidencyUnit, claim?: ReleasedFunctionalSettlementSnapshot["ownership"][number]): FunctionalSettlementResidentBuilding => {
    const placement = placementByUnit.get(unit.unitId);
    const settlementId = settlementIdByUnit.get(unit.unitId);
    if (placement === undefined || settlementId === undefined || placement.placementId !== unit.placementId)
      throw new Error(`released functional settlement snapshot unit '${unit.unitId}' drifted from release authority`);
    if (claim !== undefined && (claim.unitId !== unit.unitId || claim.placementId !== unit.placementId || claim.settlementId !== settlementId))
      throw new Error(`released functional settlement snapshot ownership claim '${unit.unitId}' drifted`);
    const handle = input.placementManager.get(settlementId);
    if (handle === undefined || handle.planId !== planId || handle.worldMapHash !== loaded.plan.atlas.worldMapHash || handle.buildings.length !== 1)
      throw new Error(`released functional settlement snapshot has no exact whole-building ownership for '${unit.unitId}'`);
    const building = handle.buildings[0]!;
    if (building.placementId !== unit.placementId || building.residencyUnitId !== unit.unitId ||
        building.catalogEntryId !== placement.catalogEntryId || buildingHash(building) !== (claim?.buildingHash ?? buildingHash(building)))
      throw new Error(`released functional settlement snapshot building ownership '${unit.unitId}' drifted`);
    return { unitId: unit.unitId, placementId: unit.placementId, settlementId, building };
  };

  const assertNoUnclaimedOwnership = (residentIds: ReadonlySet<string>): void => {
    for (const [unitId, settlementId] of settlementIdByUnit) {
      if (input.placementManager.has(settlementId) !== residentIds.has(unitId))
        throw new Error(`released functional settlement snapshot has unpaired runtime ownership for '${unitId}'`);
    }
  };

  const capture = (): ReleasedFunctionalSettlementSnapshot => {
    const residency = input.residency.snapshot();
    if (residency.planId !== planId) throw new Error("released functional settlement snapshot plan authority drifted");
    const residentIds = new Set(residency.residentUnitIds);
    assertNoUnclaimedOwnership(residentIds);
    const ownership = residency.residentUnitIds.map((unitId) => {
      const placement = placementByUnit.get(unitId)!;
      const resource = resolveOwnership({ unitId, placementId: placement.placementId, position: placement.position,
        cellIds: placement.residency.cellIds, residentBytes: 1 });
      return Object.freeze({ unitId, placementId: placement.placementId, settlementId: resource.settlementId,
        buildingHash: buildingHash(resource.building) });
    });
    return Object.freeze({ schema: RELEASED_FUNCTIONAL_SETTLEMENT_SNAPSHOT_SCHEMA,
      release: Object.freeze({ releaseId, settlementId: releaseSettlementId, closureHash, planId }), namespace: input.namespace,
      runtime: Object.freeze({ ...loaded.runtime }), residency, ownership: Object.freeze(ownership) }) as unknown as ReleasedFunctionalSettlementSnapshot;
  };

  const restore = (value: unknown): void => {
    const snapshot = releasedSnapshotSchema.parse(value);
    if (snapshot.release.releaseId !== releaseId || snapshot.release.settlementId !== releaseSettlementId ||
        snapshot.release.closureHash !== closureHash || snapshot.release.planId !== planId || snapshot.namespace !== input.namespace)
      throw new Error("released functional settlement snapshot release authority drifted");
    if (runtimeJson(snapshot.runtime) !== runtimeJson(loaded.runtime))
      throw new Error("released functional settlement snapshot budget authority drifted");
    if (snapshot.residency.planId !== planId || snapshot.ownership.length !== snapshot.residency.residentUnitIds.length)
      throw new Error("released functional settlement snapshot residency/ownership inventory drifted");
    const claims = new Map(snapshot.ownership.map((claim) => [claim.unitId, claim]));
    const claimIds = [...claims.keys()].sort(compareText);
    if (claims.size !== snapshot.ownership.length || claimIds.some((unitId, index) => unitId !== snapshot.residency.residentUnitIds[index]))
      throw new Error("released functional settlement snapshot ownership is not the exact resident inventory");
    const residentIds = new Set(snapshot.residency.residentUnitIds);
    assertNoUnclaimedOwnership(residentIds);
    input.residency.restoreSnapshot(snapshot.residency, (unit) => resolveOwnership(unit, claims.get(unit.unitId)));
  };

  return Object.freeze({ key: participantKey, schema: releasedSnapshotSchema, capture, restore });
}
