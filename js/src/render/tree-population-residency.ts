import {
  TREE_POPULATION_MAX_ACTIVE,
  TREE_POPULATION_MAX_ACTIVE_AND_PENDING,
  selectTreePopulationPage,
  type TreePopulationPage,
  type TreePopulationPageSelection,
  type TreePopulationPlan,
  type TreePopulationRung,
} from "./tree-population-plan.ts";

export interface TreePopulationMount {
  readonly trees: number;
  commit(previous?: TreePopulationMount): void;
  dispose(): void;
}

export interface TreePopulationBuildInput {
  readonly selection: TreePopulationPageSelection;
  readonly generation: number;
  readonly anchorX: number;
  readonly anchorZ: number;
}

export interface TreePopulationResidencyOptions {
  readonly maxActiveTrees?: number;
  readonly maxActiveAndPendingTrees?: number;
  readonly build: (input: TreePopulationBuildInput) => Promise<TreePopulationMount>;
  readonly onError?: (error: unknown) => void;
}

export interface TreePopulationResidencySnapshot {
  readonly active: readonly Readonly<{ key: string; trees: number; signature: string }>[];
  readonly pending: Readonly<{ key: string; trees: number; signature: string }> | null;
  readonly activeTrees: number;
  readonly pendingTrees: number;
  readonly totalTrees: number;
}

interface ActivePage {
  readonly page: TreePopulationPage;
  readonly selection: TreePopulationPageSelection;
  readonly mount: TreePopulationMount;
}

interface PendingPage {
  readonly key: string;
  readonly trees: number;
  readonly signature: string;
  readonly generation: number;
  readonly task: Promise<void>;
}

function cap(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new RangeError(`${label} must be a positive safe integer <= ${maximum}`);
  return value;
}

function previousRungs(active: ActivePage | undefined): ReadonlyMap<number, TreePopulationRung> | undefined {
  if (active === undefined) return undefined;
  return new Map(active.selection.instances.map((instance) => [instance.ordinal, instance.rung]));
}

/** Deterministic one-pending page scheduler. It never publishes a partial page replacement. */
export class TreePopulationResidencyController {
  private readonly pages = new Map<string, TreePopulationPage>();
  private readonly active = new Map<string, ActivePage>();
  private readonly errors: unknown[] = [];
  private readonly maxActiveTrees: number;
  private readonly maxActiveAndPendingTrees: number;
  private readonly build: TreePopulationResidencyOptions["build"];
  private readonly onError?: (error: unknown) => void;
  private activeTreeCount = 0;
  private pending: PendingPage | undefined;
  private generation = 0;
  private camera: Readonly<{ x: number; y: number; z: number }> | undefined;
  private cleared = false;

  constructor(readonly plan: TreePopulationPlan, options: TreePopulationResidencyOptions) {
    this.maxActiveTrees = cap(options.maxActiveTrees ?? TREE_POPULATION_MAX_ACTIVE, TREE_POPULATION_MAX_ACTIVE, "tree population maxActiveTrees");
    this.maxActiveAndPendingTrees = cap(options.maxActiveAndPendingTrees ?? TREE_POPULATION_MAX_ACTIVE_AND_PENDING,
      TREE_POPULATION_MAX_ACTIVE_AND_PENDING, "tree population maxActiveAndPendingTrees");
    if (this.maxActiveAndPendingTrees < this.maxActiveTrees) throw new RangeError("tree population active+pending cap must be >= active cap");
    this.build = options.build;
    this.onError = options.onError;
    for (const page of plan.pages) this.pages.set(page.key, page);
  }

  update(x: number, y: number, z: number): Readonly<{ launched: string | null; dropped: number; blocked: boolean }> {
    if (![x, y, z].every(Number.isFinite)) throw new RangeError("tree population camera must be finite");
    if (this.cleared) return Object.freeze({ launched: null, dropped: 0, blocked: false });
    if (this.camera === undefined || this.camera.x !== x || this.camera.y !== y || this.camera.z !== z) {
      this.camera = Object.freeze({ x, y, z });
      this.generation++;
    }
    const desired = new Map<string, TreePopulationPageSelection>();
    for (const page of this.plan.pages) {
      const selection = selectTreePopulationPage(this.plan, page, this.camera, previousRungs(this.active.get(page.key)));
      if (selection !== undefined) desired.set(page.key, selection);
    }
    let dropped = 0;
    for (const [key, active] of [...this.active]) {
      if (desired.has(key)) continue;
      this.active.delete(key); this.activeTreeCount -= active.mount.trees; dropped++;
      try { active.mount.dispose(); } catch (error) { this.report(error); }
    }
    if (this.pending !== undefined) return Object.freeze({ launched: null, dropped, blocked: false });
    const candidates = [...desired.values()].filter((selection) => this.active.get(selection.key)?.selection.signature !== selection.signature)
      .sort((a, b) => a.nearestDistance - b.nearestDistance || a.pageZ - b.pageZ || a.pageX - b.pageX || a.key.localeCompare(b.key));
    if (candidates.length === 0) return Object.freeze({ launched: null, dropped, blocked: false });
    const selection = candidates[0]!;
    const previous = this.active.get(selection.key);
    const resultingActive = this.activeTreeCount - (previous?.mount.trees ?? 0) + selection.instances.length;
    const withPending = this.activeTreeCount + selection.instances.length;
    if (resultingActive > this.maxActiveTrees || withPending > this.maxActiveAndPendingTrees) {
      return Object.freeze({ launched: null, dropped, blocked: true });
    }
    const generation = this.generation;
    const task = this.runBuild({ selection, generation,
      anchorX: Math.floor(this.camera.x / this.plan.pageSize) * this.plan.pageSize,
      anchorZ: Math.floor(this.camera.z / this.plan.pageSize) * this.plan.pageSize });
    this.pending = { key: selection.key, trees: selection.instances.length, signature: selection.signature, generation, task };
    return Object.freeze({ launched: selection.key, dropped, blocked: false });
  }

  snapshot(): TreePopulationResidencySnapshot {
    const pendingTrees = this.pending?.trees ?? 0;
    return Object.freeze({
      active: Object.freeze([...this.active.values()].map((entry) => Object.freeze({
        key: entry.page.key, trees: entry.mount.trees, signature: entry.selection.signature,
      })).sort((a, b) => a.key.localeCompare(b.key))),
      pending: this.pending === undefined ? null : Object.freeze({ key: this.pending.key, trees: this.pending.trees, signature: this.pending.signature }),
      activeTrees: this.activeTreeCount, pendingTrees, totalTrees: this.activeTreeCount + pendingTrees,
    });
  }

  takeErrors(): unknown[] { return this.errors.splice(0); }
  async settle(): Promise<void> { await this.pending?.task; }

  async clear(): Promise<void> {
    if (this.cleared) { await this.pending?.task; return; }
    this.cleared = true; this.generation++;
    const errors: unknown[] = [];
    for (const active of this.active.values()) {
      try { active.mount.dispose(); } catch (error) { errors.push(error); }
    }
    this.active.clear(); this.activeTreeCount = 0;
    const priorErrorCount = this.errors.length;
    await this.pending?.task;
    errors.push(...this.errors.slice(priorErrorCount));
    if (errors.length > 0) throw new AggregateError(errors, `tree population clear failed in ${errors.length} operation(s)`);
  }

  private async runBuild(input: TreePopulationBuildInput): Promise<void> {
    try {
      let mount: TreePopulationMount;
      try { mount = await this.build(input); } catch (error) { this.report(error); return; }
      if (!Number.isSafeInteger(mount.trees) || mount.trees !== input.selection.instances.length) {
        const primary = new Error(`tree population page '${input.selection.key}' published ${mount.trees} trees; reserved ${input.selection.instances.length}`);
        try { mount.dispose(); } catch (error) { this.report(new AggregateError([primary, error], "tree population count rejection cleanup failed")); return; }
        this.report(primary); return;
      }
      const page = this.pages.get(input.selection.key);
      const desired = !this.cleared && page !== undefined && this.camera !== undefined
        ? selectTreePopulationPage(this.plan, page, this.camera, previousRungs(this.active.get(page.key))) : undefined;
      if (this.cleared || input.generation !== this.generation || desired?.signature !== input.selection.signature) {
        try { mount.dispose(); } catch (error) { this.report(error); }
        return;
      }
      const previous = this.active.get(input.selection.key);
      try { mount.commit(previous?.mount); } catch (primary) {
        try { mount.dispose(); } catch (error) { this.report(new AggregateError([primary, error], "tree population commit cleanup failed")); return; }
        this.report(primary); return;
      }
      this.active.set(input.selection.key, { page: page!, selection: input.selection, mount });
      this.activeTreeCount += mount.trees - (previous?.mount.trees ?? 0);
      if (previous !== undefined) {
        try { previous.mount.dispose(); } catch (error) { this.report(error); }
      }
    } finally {
      if (this.pending?.generation === input.generation && this.pending.key === input.selection.key) this.pending = undefined;
    }
  }

  private report(error: unknown): void {
    this.errors.push(error);
    try { this.onError?.(error); } catch (observerError) { this.errors.push(observerError); }
  }
}
