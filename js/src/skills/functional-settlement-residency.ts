const MAX_REGISTERED_UNITS = 256;
const MAX_ACTIVE_UNITS = 256;
const MAX_RESIDENT_BYTES = 2 ** 40;
const MAX_DISTANCE = 1_000_000_000;

export interface FunctionalSettlementResidencyPlacement {
  readonly placementId: string;
  readonly position: readonly [number, number, number];
  readonly residency: {
    readonly unitId: string;
    readonly policy: "whole-building-atomic";
    readonly cellIds: readonly string[];
  };
}

export interface ParsedFunctionalSettlementPlanForResidency {
  readonly planId: string;
  readonly placements: readonly FunctionalSettlementResidencyPlacement[];
}

export interface FunctionalSettlementResidencyUnit {
  readonly unitId: string;
  readonly placementId: string;
  readonly position: readonly [number, number, number];
  /** The complete, indivisible visibility-cell inventory from the parsed settlement plan. */
  readonly cellIds: readonly string[];
  readonly residentBytes: number;
}

export interface FunctionalSettlementResidencyDelta<Resource> {
  readonly load: readonly FunctionalSettlementResidencyUnit[];
  readonly unload: readonly FunctionalSettlementResidencyUnit[];
  readonly previous: ReadonlyMap<string, Resource>;
}

export interface FunctionalSettlementResidencyTransaction<Resource> {
  /** Exact resources for the intended next resident set. Examined before commit. */
  readonly next: ReadonlyMap<string, Resource>;
  commit(): void | Promise<void>;
  /** Must be idempotent. Called after any validation or commit failure. */
  rollback(): void | Promise<void>;
}

export interface FunctionalSettlementResidencyOptions<Resource> {
  readonly loadDistance: number;
  readonly keepDistance: number;
  readonly maxActiveUnits: number;
  readonly maxResidentBytes: number;
  readonly estimateResidentBytes: (placement: FunctionalSettlementResidencyPlacement) => number;
  readonly stageTransition: (
    delta: FunctionalSettlementResidencyDelta<Resource>,
  ) => FunctionalSettlementResidencyTransaction<Resource> | Promise<FunctionalSettlementResidencyTransaction<Resource>>;
}

export interface FunctionalSettlementResidencySnapshot {
  readonly planId: string;
  readonly residentUnitIds: readonly string[];
  readonly explicitInterestUnitIds: readonly string[];
  readonly residentBytes: number;
  readonly revision: number;
}

interface Candidate<Resource> {
  unit: FunctionalSettlementResidencyUnit;
  resource?: Resource;
  explicit: boolean;
  distance: number;
}

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function finiteDistance(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > MAX_DISTANCE) throw new RangeError(`${label} must be a bounded non-negative finite number`);
  return value;
}
function boundedPositiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(`${label} is outside its bounded integer range`);
  return value;
}
function frozenSortedIds(ids: Iterable<string>): readonly string[] {
  return Object.freeze([...ids].sort(compareText));
}

/**
 * CPU-only whole-building residency authority. The input must already have passed the strict
 * functional-settlement-plan parser. A placement and every one of its visibility cells are one
 * indivisible unit; no API exists for loading or evicting an individual cell.
 */
export class FunctionalSettlementResidencyManager<Resource> {
  readonly #planId: string;
  readonly #units: ReadonlyMap<string, FunctionalSettlementResidencyUnit>;
  readonly #loadDistance: number;
  readonly #keepDistance: number;
  readonly #maxActiveUnits: number;
  readonly #maxResidentBytes: number;
  readonly #stageTransition: FunctionalSettlementResidencyOptions<Resource>["stageTransition"];
  #resident = new Map<string, Resource>();
  #explicit = new Set<string>();
  #revision = 0;
  #closed = false;
  #updating = false;

  constructor(plan: ParsedFunctionalSettlementPlanForResidency, options: FunctionalSettlementResidencyOptions<Resource>) {
    if (plan.placements.length < 1 || plan.placements.length > MAX_REGISTERED_UNITS) throw new RangeError("settlement residency plan has an invalid unit count");
    this.#loadDistance = finiteDistance(options.loadDistance, "loadDistance");
    this.#keepDistance = finiteDistance(options.keepDistance, "keepDistance");
    if (this.#keepDistance < this.#loadDistance) throw new RangeError("keepDistance must be at least loadDistance");
    this.#maxActiveUnits = boundedPositiveInteger(options.maxActiveUnits, MAX_ACTIVE_UNITS, "maxActiveUnits");
    this.#maxResidentBytes = boundedPositiveInteger(options.maxResidentBytes, MAX_RESIDENT_BYTES, "maxResidentBytes");
    this.#stageTransition = options.stageTransition;
    this.#planId = plan.planId;
    const units = new Map<string, FunctionalSettlementResidencyUnit>();
    for (const placement of plan.placements) {
      if (placement.residency.policy !== "whole-building-atomic") throw new TypeError(`placement '${placement.placementId}' is not whole-building atomic`);
      const residentBytes = options.estimateResidentBytes(placement);
      boundedPositiveInteger(residentBytes, MAX_RESIDENT_BYTES, `resident bytes for '${placement.residency.unitId}'`);
      if (units.has(placement.residency.unitId)) throw new TypeError(`duplicate residency unit '${placement.residency.unitId}'`);
      const cellIds = frozenSortedIds(placement.residency.cellIds);
      if (cellIds.length !== placement.residency.cellIds.length || cellIds.some((id, index) => id !== placement.residency.cellIds[index])) {
        throw new TypeError(`residency cells for '${placement.residency.unitId}' are not the parsed exact sorted inventory`);
      }
      units.set(placement.residency.unitId, Object.freeze({
        unitId: placement.residency.unitId,
        placementId: placement.placementId,
        position: Object.freeze([...placement.position]) as readonly [number, number, number],
        cellIds,
        residentBytes,
      }));
    }
    this.#units = units;
  }

  get revision(): number { return this.#revision; }
  get closed(): boolean { return this.#closed; }

  setExplicitInterest(unitIds: Iterable<string>): void {
    this.#assertOpen();
    const next = new Set<string>();
    for (const unitId of unitIds) {
      if (!this.#units.has(unitId)) throw new RangeError(`explicit interest references unknown unit '${unitId}'`);
      next.add(unitId);
      if (next.size > MAX_REGISTERED_UNITS) throw new RangeError("explicit interest is unbounded");
    }
    this.#explicit = next;
  }

  /** Reconcile distance and explicit interest. Equal priority/distance is resolved by unit id. */
  async update(position: readonly [number, number, number]): Promise<FunctionalSettlementResidencySnapshot> {
    this.#assertOpen();
    if (this.#updating) throw new Error("settlement residency update is already in progress");
    if (position.length !== 3 || !position.every(Number.isFinite)) throw new TypeError("residency position must contain three finite coordinates");
    this.#updating = true;
    try {
      const candidates: Candidate<Resource>[] = [];
      for (const unit of this.#units.values()) {
        const dx = unit.position[0] - position[0];
        const dy = unit.position[1] - position[1];
        const dz = unit.position[2] - position[2];
        const distance = Math.hypot(dx, dy, dz);
        const explicit = this.#explicit.has(unit.unitId);
        const resource = this.#resident.get(unit.unitId);
        const threshold = resource === undefined ? this.#loadDistance : this.#keepDistance;
        if (explicit || distance <= threshold) candidates.push({ unit, resource, explicit, distance });
      }
      candidates.sort((a, b) => Number(b.explicit) - Number(a.explicit) || a.distance - b.distance || compareText(a.unit.unitId, b.unit.unitId));
      const wanted = new Set<string>();
      let bytes = 0;
      for (const candidate of candidates) {
        if (wanted.size >= this.#maxActiveUnits || bytes + candidate.unit.residentBytes > this.#maxResidentBytes) continue;
        wanted.add(candidate.unit.unitId);
        bytes += candidate.unit.residentBytes;
      }
      await this.#transition(wanted);
      return this.snapshot();
    } finally {
      this.#updating = false;
    }
  }

  snapshot(): FunctionalSettlementResidencySnapshot {
    const residentUnitIds = frozenSortedIds(this.#resident.keys());
    return Object.freeze({ planId: this.#planId, residentUnitIds,
      explicitInterestUnitIds: frozenSortedIds(this.#explicit), residentBytes: this.#residentBytes(), revision: this.#revision });
  }

  /** Idempotent terminal teardown. A failed transaction leaves the manager open and unchanged. */
  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#updating) throw new Error("cannot close residency during an update");
    this.#updating = true;
    try {
      await this.#transition(new Set());
      this.#explicit.clear();
      this.#closed = true;
    } finally {
      this.#updating = false;
    }
  }

  async #transition(wanted: ReadonlySet<string>): Promise<void> {
    if (wanted.size === this.#resident.size && [...wanted].every((id) => this.#resident.has(id))) return;
    const load = [...wanted].filter((id) => !this.#resident.has(id)).map((id) => this.#units.get(id)!).sort((a, b) => compareText(a.unitId, b.unitId));
    const unload = [...this.#resident.keys()].filter((id) => !wanted.has(id)).map((id) => this.#units.get(id)!).sort((a, b) => compareText(a.unitId, b.unitId));
    const previous = new Map(this.#resident);
    let transaction: FunctionalSettlementResidencyTransaction<Resource> | undefined;
    try {
      transaction = await this.#stageTransition(Object.freeze({ load: Object.freeze(load), unload: Object.freeze(unload), previous }));
      const keys = frozenSortedIds(transaction.next.keys());
      const expected = frozenSortedIds(wanted);
      if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("residency transaction returned a partial or unexpected whole-building set");
      // Capture the validated proposal before handing control back to commit; a callback cannot
      // mutate its exposed map during commit and smuggle in a partial or over-budget live set.
      const validatedNext = new Map(transaction.next);
      await transaction.commit();
      this.#resident = validatedNext;
      this.#revision++;
    } catch (error) {
      if (transaction !== undefined) {
        try { await transaction.rollback(); } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "residency transition and rollback both failed");
        }
      }
      throw error;
    }
  }

  #residentBytes(): number {
    let total = 0;
    for (const id of this.#resident.keys()) total += this.#units.get(id)!.residentBytes;
    return total;
  }
  #assertOpen(): void { if (this.#closed) throw new Error("settlement residency manager is closed"); }
}
