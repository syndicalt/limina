import {
  TREE_POPULATION_MAX_ACTIVE,
  TREE_POPULATION_MAX_ACTIVE_AND_PENDING,
  TREE_POPULATION_MAX_SPECIES,
  TREE_POPULATION_PAGE_SIZE,
  buildTreePopulationPlan,
  classifyTreePopulationRung,
  selectTreePopulationPage,
  type TreePopulationPlacement,
  type TreeSpeciesLodPolicy,
} from "../src/render/tree-population-plan.ts";
import {
  TreePopulationResidencyController,
  type TreePopulationBuildInput,
  type TreePopulationMount,
} from "../src/render/tree-population-residency.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_tree_population_residency FAIL: ${message}`);
}
function rejects(operation: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown; try { operation(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${String(error)}`);
}
interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const oak: TreeSpeciesLodPolicy = { speciesId: "oak", reducedDistance: 80, impostorDistance: 280, cullDistance: 1_200, hysteresis: 0.15 };
const pine: TreeSpeciesLodPolicy = { speciesId: "pine", reducedDistance: 90, impostorDistance: 300, cullDistance: 1_100, hysteresis: 0.1 };
const placement = (speciesId: string, x: number, z: number, y = 0): TreePopulationPlacement => ({ speciesId, x, y, z, yaw: 0.25, scale: 1.1 });

// Signed half-open paging is canonical around zero and keeps every uploaded transform page-local.
const signed = buildTreePopulationPlan([
  placement("oak", -0.1, -48), placement("oak", 0, 0), placement("pine", 47.999, 47.999), placement("pine", 48, 48),
], [oak, pine]);
assert(TREE_POPULATION_PAGE_SIZE === 48 && signed.pages.map((page) => page.key).join(",") === "-1:-1,0:0,1:1", "signed page partition/order changed");
const negative = signed.pages[0]!.instances[0]!;
assert(negative.localX === 47.9 && negative.localZ === 0, `negative page-local transform is wrong: ${negative.localX},${negative.localZ}`);
assert(signed.pages.every((page) => page.instances.every((tree) => tree.localX >= 0 && tree.localX < 48 && tree.localZ >= 0 && tree.localZ < 48)),
  "a tree matrix escaped its feature-local page");
assert(signed.species.join(",") === "oak,pine" && signed.trees === 4 && signed.hash === buildTreePopulationPlan([
  placement("oak", -0.1, -48), placement("oak", 0, 0), placement("pine", 47.999, 47.999), placement("pine", 48, 48),
], [oak, pine]).hash, "tree plan is not deterministic");

// Policy validation is deliberately bounded; release thresholds remain species-authored data.
rejects(() => buildTreePopulationPlan([placement("missing", 0, 0)], [oak]), /unknown species/, "unknown species was admitted");
rejects(() => buildTreePopulationPlan([], Array.from({ length: TREE_POPULATION_MAX_SPECIES + 1 }, (_, i) => ({ ...oak, speciesId: `s${i}` }))),
  /species count/, "over-budget species palette was admitted");
rejects(() => buildTreePopulationPlan([], [{ ...oak, impostorDistance: 50 }]), /strictly increasing/, "invalid rung thresholds were admitted");

// Symmetric hysteresis prevents threshold chatter.
assert(classifyTreePopulationRung(80, oak) === 1, "cold classification missed reduced rung");
assert(classifyTreePopulationRung(90, oak, 0) === 0 && classifyTreePopulationRung(93, oak, 0) === 1, "LOD0 outward hysteresis is wrong");
assert(classifyTreePopulationRung(250, oak, 2) === 2 && classifyTreePopulationRung(230, oak, 2) === 1, "impostor inward hysteresis is wrong");
assert(classifyTreePopulationRung(1_300, oak, 2) === 2 && classifyTreePopulationRung(1_381, oak, 2) === undefined, "far cull hysteresis is wrong");

// A translation by an exact page multiple preserves page-local transforms and rung selections at
// million-metre coordinates. Only page identity/origin changes, as intended.
const SHIFT = 48 * 20_834;
const localPlacements = [placement("oak", 12, 8, 2), placement("pine", 38, 41, 5)];
const localPlan = buildTreePopulationPlan(localPlacements, [oak, pine]);
const shiftedPlan = buildTreePopulationPlan(localPlacements.map((tree) => ({ ...tree, x: tree.x + SHIFT, z: tree.z - SHIFT })), [oak, pine]);
const localSelection = selectTreePopulationPage(localPlan, localPlan.pages[0]!, { x: 0, y: 3, z: 0 })!;
const shiftedSelection = selectTreePopulationPage(shiftedPlan, shiftedPlan.pages[0]!, { x: SHIFT, y: 3, z: -SHIFT })!;
assert(localSelection.instances.map((tree) => `${tree.localX}:${tree.localZ}:${tree.rung}`).join("|") ===
  shiftedSelection.instances.map((tree) => `${tree.localX}:${tree.localZ}:${tree.rung}`).join("|"), "million-metre translation changed local matrices or rung selection");

class Mount implements TreePopulationMount {
  disposed = 0; committed = false;
  constructor(readonly name: string, readonly trees: number, private readonly live: Set<string>, private readonly failDispose = false) {}
  commit(previous?: TreePopulationMount): void {
    if (previous instanceof Mount) this.live.delete(previous.name);
    this.live.add(this.name); this.committed = true;
  }
  dispose(): void { this.disposed++; this.live.delete(this.name); if (this.failDispose) throw new Error(`dispose ${this.name}`); }
}

// One pending build, deterministic nearest-page ordering, stale rejection, and atomic replacement.
const runtimePlan = buildTreePopulationPlan([
  placement("oak", 10, 10), placement("oak", 60, 10), placement("pine", -12, 10),
], [oak, pine]);
const gates: Deferred<TreePopulationMount>[] = [], builds: TreePopulationBuildInput[] = [], mounts: Mount[] = [], live = new Set<string>();
const controller = new TreePopulationResidencyController(runtimePlan, {
  build: (input) => { builds.push(input); const gate = deferred<TreePopulationMount>(); gates.push(gate); return gate.promise; },
});
let update = controller.update(0, 0, 0);
assert(update.launched === "0:0" && controller.update(0, 0, 0).launched === null && gates.length === 1, "nearest/one-pending scheduling failed");
let mount = new Mount("0:0:v0", builds[0]!.selection.instances.length, live); mounts.push(mount); gates[0]!.resolve(mount); await controller.settle();
assert(live.has("0:0:v0") && controller.snapshot().activeTrees === 1, "first page did not publish");
update = controller.update(0, 0, 0);
assert(update.launched === "-1:0", `signed tie-break selected ${update.launched}`);
mount = new Mount("-1:0:v0", builds[1]!.selection.instances.length, live); mounts.push(mount); gates[1]!.resolve(mount); await controller.settle();
controller.update(0, 0, 0);
mount = new Mount("1:0:v0", builds[2]!.selection.instances.length, live); mounts.push(mount); gates[2]!.resolve(mount); await controller.settle();
assert(controller.snapshot().activeTrees === 3, "initial pages did not converge");

// Moving past oak's outward threshold requests a replacement but keeps the old page live until commit.
controller.update(-90, 0, 10);
assert(controller.snapshot().pending?.key === "0:0" && live.has("0:0:v0"), "replacement did not retain prior publication");
const replacement = new Mount("0:0:v1", builds.at(-1)!.selection.instances.length, live); mounts.push(replacement);
gates.at(-1)!.resolve(replacement); await controller.settle();
assert(live.has("0:0:v1") && !live.has("0:0:v0") && mounts[0]!.disposed === 1, "page replacement was not atomic");

// A camera change makes the pending selection stale; completion may dispose but never publish.
controller.update(200, 0, 0);
const staleGate = gates.at(-1)!;
const stale = new Mount("stale", builds.at(-1)!.selection.instances.length, live); mounts.push(stale);
controller.update(5_000, 0, 5_000);
staleGate.resolve(stale); await controller.settle();
assert(stale.disposed === 1 && !live.has("stale"), "stale tree page published or leaked");

// Exact active and active+pending caps reject work before build.
const capPlan = buildTreePopulationPlan([placement("oak", 1, 1), placement("oak", 49, 1)], [oak]);
let capBuilds = 0;
const capped = new TreePopulationResidencyController(capPlan, {
  maxActiveTrees: 1, maxActiveAndPendingTrees: 1,
  build: async (input) => { capBuilds++; return new Mount(input.selection.key, input.selection.instances.length, new Set()); },
});
capped.update(0, 0, 0); await capped.settle();
assert(capped.update(0, 0, 0).blocked && capBuilds === 1 && capped.snapshot().totalTrees === 1, "hard tree residency cap was exceeded");
assert(TREE_POPULATION_MAX_ACTIVE === 24_576 && TREE_POPULATION_MAX_ACTIVE_AND_PENDING === 30_720, "production tree caps drifted");

// Clear attempts every active and late pending disposal and aggregates faults.
const clearGates: Deferred<TreePopulationMount>[] = [], clearMounts: Mount[] = [], clearLive = new Set<string>();
const clearing = new TreePopulationResidencyController(runtimePlan, {
  build: (input) => { const gate = deferred<TreePopulationMount>(); clearGates.push(gate); return gate.promise; },
});
clearing.update(0, 0, 0);
const first = new Mount("clear-active", 1, clearLive, true); clearMounts.push(first); clearGates[0]!.resolve(first); await clearing.settle();
clearing.update(0, 0, 0);
const late = new Mount("clear-late", 1, clearLive, true); clearMounts.push(late);
const clearPromise = clearing.clear(); clearGates[1]!.resolve(late);
let clearError: unknown; try { await clearPromise; } catch (error) { clearError = error; }
assert(clearError instanceof AggregateError && clearMounts.every((item) => item.disposed === 1) && clearing.snapshot().totalTrees === 0,
  "clear did not aggregate active and pending disposal failures");

console.log("p_tree_population_residency OK: signed 48m paging, species/rung contracts, hysteresis, million-metre local equivalence, deterministic one-pending scheduling, hard caps, stale rejection, atomic replacement, and aggregate cleanup are proven");
