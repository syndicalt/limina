import { GRASS_FIELD_MAX_RESIDENT_SLOTS } from "./grass-field-plan.ts";

export type GrassFieldResidencyLod = 0 | 1;

export interface GrassFieldResidencyCoord {
  readonly tx: number;
  readonly tz: number;
}

/**
 * An unpublished tile mount. commit() owns the scene transaction: on success the candidate is the
 * sole published mount for its key; on failure the previous mount must remain published. dispose()
 * must release the mount whether or not it was ever committed.
 */
export interface GrassFieldResidencyMount {
  readonly slots: number;
  /** Optional weighted residency cost (for grass, actual modeled blades). Defaults to slots. */
  readonly cost?: number;
  commit(previous?: GrassFieldResidencyMount): void;
  dispose(): void;
}

export interface GrassFieldResidencyBuildInput<T> {
  readonly key: string;
  readonly coord: Readonly<GrassFieldResidencyCoord>;
  readonly source: T;
  readonly lod: GrassFieldResidencyLod;
  readonly spacingMultiplier: number;
  readonly generation: number;
}

export interface GrassFieldResidencyOptions<T> {
  readonly tileSize: number;
  readonly radius?: number;
  readonly hysteresis?: number;
  /** Chebyshev rings through this distance use LOD0. Default 1. */
  readonly fineRadius?: number;
  /** Force one representation across this controller's whole window. Used by package-declared
   * overlapping distance bands; ordinary two-level residency leaves this undefined. */
  readonly forcedLod?: GrassFieldResidencyLod;
  /** Defaults to [1, 4]; LOD1 is deliberately sparse enough to fit the native fixed-slot cap. */
  readonly spacingMultipliers?: readonly [number, number];
  readonly maxResidentSlots?: number;
  readonly maxResidentCost?: number;
  readonly estimateSlots: (source: T, lod: GrassFieldResidencyLod, spacingMultiplier: number) => number;
  readonly estimateCost?: (source: T, lod: GrassFieldResidencyLod, spacingMultiplier: number, slots: number) => number;
  readonly build: (input: GrassFieldResidencyBuildInput<T>) => Promise<GrassFieldResidencyMount>;
  readonly onError?: (error: unknown) => void;
}

export interface GrassFieldResidencyUpdate {
  readonly launched: Readonly<{ key: string; lod: GrassFieldResidencyLod }> | null;
  readonly dropped: number;
  readonly blocked: boolean;
  readonly active: number;
  readonly pending: number;
  readonly activeSlots: number;
  readonly pendingSlots: number;
  readonly totalSlots: number;
  readonly activeCost: number;
  readonly pendingCost: number;
  readonly totalCost: number;
}

export interface GrassFieldResidencySnapshot {
  readonly registeredKeys: readonly string[];
  readonly active: readonly Readonly<{ key: string; lod: GrassFieldResidencyLod; slots: number }>[];
  readonly pending: Readonly<{ key: string; lod: GrassFieldResidencyLod; slots: number }> | null;
  readonly activeSlots: number;
  readonly pendingSlots: number;
  readonly totalSlots: number;
  readonly activeCost: number;
  readonly pendingCost: number;
  readonly totalCost: number;
}

interface Registered<T> {
  readonly coord: Readonly<GrassFieldResidencyCoord>;
  readonly source: T;
  readonly generation: number;
}

interface Active {
  readonly key: string;
  readonly coord: Readonly<GrassFieldResidencyCoord>;
  readonly generation: number;
  readonly lod: GrassFieldResidencyLod;
  readonly mount: GrassFieldResidencyMount;
}

interface Pending {
  readonly key: string;
  readonly generation: number;
  readonly lod: GrassFieldResidencyLod;
  readonly slots: number;
  readonly cost: number;
  readonly task: Promise<void>;
}

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be finite and positive`);
  return value;
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a nonnegative safe integer`);
  return value;
}

function slotCount(value: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new RangeError(`${label} must be a safe integer in [0, ${max}]`);
  return value;
}

function mountCost(mount: GrassFieldResidencyMount): number { return mount.cost ?? mount.slots; }

function cleanupAll(operations: readonly (() => void)[], label: string): void {
  const errors: unknown[] = [];
  for (const operation of operations) {
    try { operation(); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, `${label} failed in ${errors.length} operation(s)`);
}

/** Renderer-agnostic, deterministic camera residency for async grass tile mounts. */
export class GrassFieldResidencyController<T> {
  private readonly registered = new Map<string, Registered<T>>();
  private readonly active = new Map<string, Active>();
  private readonly errors: unknown[] = [];
  private readonly tileSize: number;
  private readonly radius: number;
  private readonly hysteresis: number;
  private readonly fineRadius: number;
  private readonly forcedLod?: GrassFieldResidencyLod;
  private readonly spacingMultipliers: readonly [number, number];
  private readonly maxResidentSlots: number;
  private readonly maxResidentCost: number;
  private readonly estimateSlots: GrassFieldResidencyOptions<T>["estimateSlots"];
  private readonly estimateCost?: GrassFieldResidencyOptions<T>["estimateCost"];
  private readonly build: GrassFieldResidencyOptions<T>["build"];
  private readonly onError?: (error: unknown) => void;
  private generation = 0;
  private pending: Pending | undefined;
  private activeSlotCount = 0;
  private activeCostCount = 0;
  private cleared = false;
  private anchor: Readonly<GrassFieldResidencyCoord> | undefined;

  constructor(options: GrassFieldResidencyOptions<T>) {
    this.tileSize = finitePositive(options.tileSize, "grass residency tileSize");
    this.radius = nonnegativeInteger(options.radius ?? 2, "grass residency radius");
    this.hysteresis = nonnegativeInteger(options.hysteresis ?? 1, "grass residency hysteresis");
    this.fineRadius = nonnegativeInteger(options.fineRadius ?? 1, "grass residency fineRadius");
    if (this.fineRadius > this.radius) throw new RangeError("grass residency fineRadius must not exceed radius");
    if (options.forcedLod !== undefined && options.forcedLod !== 0 && options.forcedLod !== 1) {
      throw new RangeError("grass residency forcedLod must be 0 or 1");
    }
    this.forcedLod = options.forcedLod;
    const multipliers = options.spacingMultipliers ?? [1, 4];
    this.spacingMultipliers = Object.freeze([
      finitePositive(multipliers[0], "grass residency LOD0 spacing multiplier"),
      finitePositive(multipliers[1], "grass residency LOD1 spacing multiplier"),
    ]);
    this.maxResidentSlots = slotCount(options.maxResidentSlots ?? GRASS_FIELD_MAX_RESIDENT_SLOTS,
      GRASS_FIELD_MAX_RESIDENT_SLOTS, "grass residency maxResidentSlots");
    if (this.maxResidentSlots === 0) throw new RangeError("grass residency maxResidentSlots must be positive");
    this.maxResidentCost = nonnegativeInteger(options.maxResidentCost ?? this.maxResidentSlots,
      "grass residency maxResidentCost");
    if (this.maxResidentCost === 0) throw new RangeError("grass residency maxResidentCost must be positive");
    this.estimateSlots = options.estimateSlots;
    this.estimateCost = options.estimateCost;
    this.build = options.build;
    this.onError = options.onError;
  }

  noteTile(key: string, coord: GrassFieldResidencyCoord, source: T): void {
    if (this.cleared) return;
    if (key.length === 0) throw new RangeError("grass residency tile key must not be empty");
    if (!Number.isSafeInteger(coord.tx) || !Number.isSafeInteger(coord.tz)) throw new RangeError("grass residency tile coordinates must be safe integers");
    this.registered.set(key, {
      coord: Object.freeze({ tx: coord.tx, tz: coord.tz }), source, generation: ++this.generation,
    });
  }

  dropTile(key: string): void {
    this.registered.delete(key);
    this.generation++;
    const prior = this.active.get(key);
    if (prior === undefined) return;
    this.active.delete(key);
    this.activeSlotCount -= prior.mount.slots;
    this.activeCostCount -= mountCost(prior.mount);
    cleanupAll([() => prior.mount.dispose()], `grass residency drop '${key}'`);
  }

  activeKeys(): Set<string> { return new Set(this.active.keys()); }

  activeLod(key: string): GrassFieldResidencyLod | undefined { return this.active.get(key)?.lod; }

  residentSlots(): Readonly<{ active: number; pending: number; total: number }> {
    const pending = this.pending?.slots ?? 0;
    return Object.freeze({ active: this.activeSlotCount, pending, total: this.activeSlotCount + pending });
  }

  residentCost(): Readonly<{ active: number; pending: number; total: number }> {
    const pending = this.pending?.cost ?? 0;
    return Object.freeze({ active: this.activeCostCount, pending, total: this.activeCostCount + pending });
  }

  snapshot(): GrassFieldResidencySnapshot {
    const slots = this.residentSlots();
    const cost = this.residentCost();
    return Object.freeze({
      registeredKeys: Object.freeze([...this.registered.keys()].sort()),
      active: Object.freeze([...this.active.values()].map((entry) => Object.freeze({
        key: entry.key, lod: entry.lod, slots: entry.mount.slots,
      })).sort((a, b) => a.key.localeCompare(b.key))),
      pending: this.pending === undefined ? null : Object.freeze({
        key: this.pending.key, lod: this.pending.lod, slots: this.pending.slots,
      }),
      activeSlots: slots.active, pendingSlots: slots.pending, totalSlots: slots.total,
      activeCost: cost.active, pendingCost: cost.pending, totalCost: cost.total,
    });
  }

  takeErrors(): unknown[] { return this.errors.splice(0); }

  /** Await the current build only; a later update may start another one. Never rejects. */
  async settle(): Promise<void> { await this.pending?.task; }

  update(anchorX: number, anchorZ: number): GrassFieldResidencyUpdate {
    if (!Number.isFinite(anchorX) || !Number.isFinite(anchorZ)) throw new RangeError("grass residency anchor must be finite");
    if (this.cleared) return this.result(null, 0, false);
    const anchor = Object.freeze({ tx: Math.floor(anchorX / this.tileSize), tz: Math.floor(anchorZ / this.tileSize) });
    this.anchor = anchor;
    const distance = (coord: GrassFieldResidencyCoord): number => Math.max(Math.abs(coord.tx - anchor.tx), Math.abs(coord.tz - anchor.tz));
    const desiredLod = (coord: GrassFieldResidencyCoord): GrassFieldResidencyLod | undefined => {
      const d = distance(coord);
      return d > this.radius ? undefined : this.forcedLod ?? (d <= this.fineRadius ? 0 : 1);
    };

    let dropped = 0;
    const dropErrors: unknown[] = [];
    for (const [key, mounted] of [...this.active]) {
      const source = this.registered.get(key);
      if (source !== undefined && distance(source.coord) <= this.radius + this.hysteresis) continue;
      this.active.delete(key);
      this.activeSlotCount -= mounted.mount.slots;
      this.activeCostCount -= mountCost(mounted.mount);
      try { mounted.mount.dispose(); } catch (error) { dropErrors.push(error); }
      dropped++;
    }
    if (dropErrors.length > 0) this.report(new AggregateError(dropErrors, `grass residency update cleanup failed for ${dropErrors.length} mount(s)`));
    if (this.pending !== undefined) return this.result(null, dropped, false);

    const candidates = [...this.registered.entries()].flatMap(([key, source]) => {
      const lod = desiredLod(source.coord);
      if (lod === undefined) return [];
      const mounted = this.active.get(key);
      if (mounted?.lod === lod && mounted.generation === source.generation) return [];
      return [{ key, source, lod, distance: distance(source.coord) }];
    }).sort((a, b) => a.distance - b.distance || a.source.coord.tz - b.source.coord.tz ||
      a.source.coord.tx - b.source.coord.tx || a.key.localeCompare(b.key));

    if (candidates.length === 0) return this.result(null, dropped, false);
    const candidate = candidates[0];
    const multiplier = this.spacingMultipliers[candidate.lod];
    let estimate: number, estimatedCost: number;
    try {
      estimate = slotCount(this.estimateSlots(candidate.source.source, candidate.lod, multiplier),
        this.maxResidentSlots, `grass residency estimate for '${candidate.key}'`);
      estimatedCost = slotCount(this.estimateCost?.(candidate.source.source, candidate.lod, multiplier, estimate) ?? estimate,
        this.maxResidentCost, `grass residency cost estimate for '${candidate.key}'`);
    } catch (error) {
      this.report(error);
      return this.result(null, dropped, true);
    }

    // Prefer a gap-free replacement. If it cannot fit, retire only that key's old level first.
    const previous = this.active.get(candidate.key);
    const exceedsBudget = () => this.activeSlotCount + estimate > this.maxResidentSlots
      || this.activeCostCount + estimatedCost > this.maxResidentCost;
    if (exceedsBudget() && previous !== undefined) {
      this.active.delete(candidate.key);
      this.activeSlotCount -= previous.mount.slots;
      this.activeCostCount -= mountCost(previous.mount);
      try { previous.mount.dispose(); } catch (error) { this.report(error); }
      dropped++;
    }
    // Keep-window mounts are expendable before desired mounts. Eviction order is deterministic:
    // farthest first, then reverse tz/tx/key (the inverse of build preference).
    if (exceedsBudget()) {
      const expendable = [...this.active.values()].filter((mounted) => desiredLod(mounted.coord) === undefined)
        .sort((a, b) => distance(b.coord) - distance(a.coord) || b.coord.tz - a.coord.tz ||
          b.coord.tx - a.coord.tx || b.key.localeCompare(a.key));
      for (const mounted of expendable) {
        if (!exceedsBudget()) break;
        this.active.delete(mounted.key);
        this.activeSlotCount -= mounted.mount.slots;
        this.activeCostCount -= mountCost(mounted.mount);
        try { mounted.mount.dispose(); } catch (error) { this.report(error); }
        dropped++;
      }
    }
    if (exceedsBudget()) return this.result(null, dropped, true);

    const generation = candidate.source.generation;
    const task = this.runBuild({
      key: candidate.key, coord: candidate.source.coord, source: candidate.source.source,
      lod: candidate.lod, spacingMultiplier: multiplier, generation,
    }, estimate, estimatedCost);
    this.pending = { key: candidate.key, generation, lod: candidate.lod, slots: estimate, cost: estimatedCost, task };
    return this.result({ key: candidate.key, lod: candidate.lod }, dropped, false);
  }

  async clear(): Promise<void> {
    if (this.cleared) { await this.pending?.task; return; }
    this.cleared = true;
    this.generation++;
    this.registered.clear();
    const operations = [...this.active.values()].map((entry) => () => entry.mount.dispose());
    this.active.clear();
    this.activeSlotCount = 0;
    this.activeCostCount = 0;
    const failures: unknown[] = [];
    try { cleanupAll(operations, "grass residency clear"); } catch (error) { failures.push(error); }
    const errorStart = this.errors.length;
    await this.pending?.task;
    failures.push(...this.errors.slice(errorStart));
    if (failures.length > 0) throw new AggregateError(failures, `grass residency clear failed in ${failures.length} operation(s)`);
  }

  private async runBuild(input: GrassFieldResidencyBuildInput<T>, estimate: number, estimatedCost: number): Promise<void> {
    try {
      let mount: GrassFieldResidencyMount;
      try {
        mount = await this.build(input);
      } catch (error) {
        this.report(error);
        return;
      }
      if (!Number.isSafeInteger(mount.slots) || mount.slots !== estimate) {
        const primary = new Error(`grass residency build '${input.key}' published ${mount.slots} slots; reserved ${estimate}`);
        try { mount.dispose(); } catch (error) {
          this.report(new AggregateError([primary, error], `grass residency build '${input.key}' slot rejection cleanup failed`));
          return;
        }
        this.report(primary);
        return;
      }
      const cost = mountCost(mount);
      if (!Number.isSafeInteger(cost) || cost < 0 || cost > estimatedCost) {
        const primary = new Error(`grass residency build '${input.key}' published cost ${cost}; reserved ${estimatedCost}`);
        try { mount.dispose(); } catch (error) {
          this.report(new AggregateError([primary, error], `grass residency build '${input.key}' cost rejection cleanup failed`));
          return;
        }
        this.report(primary);
        return;
      }
      const current = this.registered.get(input.key);
      const desired = this.anchor === undefined ? undefined : this.lodAt(current?.coord, this.anchor);
      if (this.cleared || current?.generation !== input.generation || desired !== input.lod) {
        try { mount.dispose(); } catch (error) { this.report(error); }
        return;
      }
      const previous = this.active.get(input.key);
      try {
        mount.commit(previous?.mount);
      } catch (primary) {
        try { mount.dispose(); } catch (error) {
          this.report(new AggregateError([primary, error], `grass residency build '${input.key}' commit cleanup failed`));
          return;
        }
        this.report(primary);
        return;
      }
      this.active.set(input.key, {
        key: input.key, coord: input.coord, generation: input.generation, lod: input.lod, mount,
      });
      this.activeSlotCount += mount.slots - (previous?.mount.slots ?? 0);
      this.activeCostCount += cost - (previous === undefined ? 0 : mountCost(previous.mount));
      if (previous !== undefined) {
        try { previous.mount.dispose(); } catch (error) { this.report(error); }
      }
    } finally {
      if (this.pending?.generation === input.generation && this.pending.key === input.key) this.pending = undefined;
    }
  }

  private lodAt(coord: GrassFieldResidencyCoord | undefined, anchor: GrassFieldResidencyCoord): GrassFieldResidencyLod | undefined {
    if (coord === undefined) return undefined;
    const d = Math.max(Math.abs(coord.tx - anchor.tx), Math.abs(coord.tz - anchor.tz));
    return d > this.radius ? undefined : this.forcedLod ?? (d <= this.fineRadius ? 0 : 1);
  }

  private report(error: unknown): void {
    this.errors.push(error);
    try { this.onError?.(error); } catch (observerError) { this.errors.push(observerError); }
  }

  private result(launched: GrassFieldResidencyUpdate["launched"], dropped: number, blocked: boolean): GrassFieldResidencyUpdate {
    const slots = this.residentSlots();
    const cost = this.residentCost();
    return Object.freeze({ launched, dropped, blocked, active: this.active.size, pending: this.pending === undefined ? 0 : 1,
      activeSlots: slots.active, pendingSlots: slots.pending, totalSlots: slots.total,
      activeCost: cost.active, pendingCost: cost.pending, totalCost: cost.total });
  }
}
