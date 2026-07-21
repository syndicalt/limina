import {
  GrassFieldResidencyController,
  type GrassFieldResidencyBuildInput,
  type GrassFieldResidencyMount,
} from "../src/render/grass-field-residency.ts";

function assert(value: boolean, message: string): asserts value {
  if (!value) throw new Error(`p_grass_field_residency FAIL: ${message}`);
}

interface Source { readonly slots: readonly [number, number] }
interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Mount implements GrassFieldResidencyMount {
  committed = false;
  disposed = 0;
  constructor(readonly name: string, readonly slots: number, private readonly live: Set<string>,
    private readonly failCommit = false, private readonly failDispose = false) {}
  commit(previous?: GrassFieldResidencyMount): void {
    if (this.failCommit) throw new Error(`commit ${this.name}`);
    if (previous instanceof Mount) previous.live.delete(previous.name);
    this.live.add(this.name); this.committed = true;
  }
  dispose(): void {
    this.disposed++; this.live.delete(this.name);
    if (this.failDispose) throw new Error(`dispose ${this.name}`);
  }
}

const live = new Set<string>();
const builds: GrassFieldResidencyBuildInput<Source>[] = [];
const gates: Deferred<GrassFieldResidencyMount>[] = [];
const mounts: Mount[] = [];
const controller = new GrassFieldResidencyController<Source>({
  tileSize: 48, radius: 2, hysteresis: 1, fineRadius: 1, spacingMultipliers: [1, 4], maxResidentSlots: 105,
  estimateSlots: (source, lod) => source.slots[lod],
  build: (input) => { builds.push(input); const gate = deferred<GrassFieldResidencyMount>(); gates.push(gate); return gate.promise; },
});
const source: Source = { slots: [20, 5] };
for (const [key, tx, tz] of [["se", 1, 1], ["west", -1, 0], ["center", 0, 0], ["north", 0, -1], ["far", 2, 0]] as const) {
  controller.noteTile(key, { tx, tz }, source);
}

// Nearest, then tz, then tx ordering; only one build may be pending.
let update = controller.update(1, 1);
assert(update.launched?.key === "center" && update.launched.lod === 0 && update.pending === 1, "center was not first");
assert(controller.update(1, 1).launched === null && gates.length === 1, "second build launched while one was pending");
let mount = new Mount("center:0", 20, live); mounts.push(mount); gates[0].resolve(mount); await controller.settle();
update = controller.update(1, 1);
assert(update.launched?.key === "north", `tz tie-break chose ${update.launched?.key}`);
mount = new Mount("north:0", 20, live); mounts.push(mount); gates[1].resolve(mount); await controller.settle();
update = controller.update(1, 1);
assert(update.launched?.key === "west", `tx tie-break chose ${update.launched?.key}`);
mount = new Mount("west:0", 20, live); mounts.push(mount); gates[2].resolve(mount); await controller.settle();
update = controller.update(1, 1);
assert(update.launched?.key === "se", `last fine tile was not se: ${update.launched?.key}`);
mount = new Mount("se:0", 20, live); mounts.push(mount); gates[3].resolve(mount); await controller.settle();
update = controller.update(1, 1);
assert(update.launched?.key === "far" && update.launched.lod === 1 && builds.at(-1)?.spacingMultiplier === 4,
  "outer ring did not select LOD1 with the 4x spacing policy");
mount = new Mount("far:1", 5, live); mounts.push(mount); gates[4].resolve(mount); await controller.settle();
assert(controller.residentSlots().total === 85 && controller.activeKeys().size === 5, "initial slot/accounting convergence failed");

// Replacement retains the old mount while the candidate is pending when the reservation fits.
controller.update(48 * 2 + 1, 1); // far becomes the fine camera tile; old LOD1 remains live.
assert(controller.snapshot().pending?.key === "far" && live.has("far:1") && controller.residentSlots().total === 105,
  "gap-free replacement did not reserve slots while retaining the prior mount");
const fineFar = new Mount("far:0", 20, live); mounts.push(fineFar); gates[5].resolve(fineFar); await controller.settle();
assert(controller.activeLod("far") === 0 && live.has("far:0") && !live.has("far:1") && mounts[4].disposed === 1,
  "replacement was not atomically committed and retired");

// A camera-generation change makes a completion stale; it may only dispose, never publish.
controller.noteTile("stale", { tx: 3, tz: 0 }, { slots: [7, 3] });
controller.update(48 * 3 + 1, 1);
const staleGate = gates.at(-1)!;
const staleMount = new Mount("stale:0", 7, live); mounts.push(staleMount);
controller.update(48 * -10, 48 * -10);
staleGate.resolve(staleMount); await controller.settle();
assert(staleMount.disposed === 1 && !live.has("stale:0") && !controller.activeKeys().has("stale"), "stale completion published or leaked");

// Rejection releases its reservation and is observable without an unhandled rejection.
controller.update(1, 1);
const rejection = gates.at(-1)!;
rejection.reject(new Error("injected build rejection")); await controller.settle();
assert(controller.snapshot().pending === null && controller.takeErrors().some((error) => /injected build rejection/.test(String(error))),
  "build rejection was not contained/reported");

// Hard cap: a missing desired tile whose reservation cannot fit is blocked and never built.
const capLive = new Set<string>(), capBuilds: GrassFieldResidencyBuildInput<Source>[] = [];
const cap = new GrassFieldResidencyController<Source>({ tileSize: 48, radius: 1, fineRadius: 1, maxResidentSlots: 20,
  estimateSlots: (item, lod) => item.slots[lod],
  build: async (input) => { capBuilds.push(input); return new Mount(input.key, input.source.slots[input.lod], capLive); } });
cap.noteTile("a", { tx: 0, tz: 0 }, { slots: [20, 5] });
cap.update(1, 1); await cap.settle();
cap.noteTile("b", { tx: 1, tz: 0 }, { slots: [20, 5] });
const blocked = cap.update(1, 1);
assert(blocked.blocked && blocked.totalSlots === 20 && capBuilds.length === 1, "hard cap admitted or launched an over-cap tile");

// drop invalidates a pending completion and removes an active mount.
const dropGate = deferred<GrassFieldResidencyMount>(), dropLive = new Set<string>();
const drop = new GrassFieldResidencyController<Source>({ tileSize: 48, radius: 0, fineRadius: 0, maxResidentSlots: 20,
  estimateSlots: (item, lod) => item.slots[lod], build: () => dropGate.promise });
drop.noteTile("drop", { tx: 0, tz: 0 }, { slots: [10, 2] }); drop.update(0, 0); drop.dropTile("drop");
const droppedPending = new Mount("drop", 10, dropLive); dropGate.resolve(droppedPending); await drop.settle();
assert(droppedPending.disposed === 1 && drop.snapshot().totalSlots === 0, "drop did not invalidate and release pending completion");

// clear attempts every active cleanup and a stale pending cleanup, aggregating failures.
const clearLive = new Set<string>(), clearGates: Deferred<GrassFieldResidencyMount>[] = [], clearMounts: Mount[] = [];
const clearing = new GrassFieldResidencyController<Source>({ tileSize: 48, radius: 1, maxResidentSlots: 30,
  estimateSlots: (item, lod) => item.slots[lod], build: () => { const gate = deferred<GrassFieldResidencyMount>(); clearGates.push(gate); return gate.promise; } });
for (const [key, tx] of [["c0", 0], ["c1", 1], ["c2", -1]] as const) clearing.noteTile(key, { tx, tz: 0 }, { slots: [10, 2] });
for (let i = 0; i < 2; i++) {
  clearing.update(0, 0); const item = new Mount(`c${i}`, 10, clearLive, false, true); clearMounts.push(item);
  clearGates[i].resolve(item); await clearing.settle();
}
clearing.update(0, 0);
const late = new Mount("late", 10, clearLive, false, true); clearMounts.push(late);
const clearPromise = clearing.clear(); clearGates[2].resolve(late);
let clearError: unknown;
try { await clearPromise; } catch (error) { clearError = error; }
assert(clearError instanceof AggregateError && clearMounts.every((item) => item.disposed === 1)
  && clearing.snapshot().totalSlots === 0 && clearLive.size === 0,
  "clear did not attempt every active/pending cleanup and aggregate failures");

// A commit failure leaves the previous publication intact and disposes the candidate.
const replaceLive = new Set<string>(), replaceGates: Deferred<GrassFieldResidencyMount>[] = [];
const replacing = new GrassFieldResidencyController<Source>({ tileSize: 48, radius: 1, fineRadius: 0, maxResidentSlots: 30,
  estimateSlots: (item, lod) => item.slots[lod], build: () => { const gate = deferred<GrassFieldResidencyMount>(); replaceGates.push(gate); return gate.promise; } });
replacing.noteTile("r", { tx: 1, tz: 0 }, { slots: [10, 4] }); replacing.update(0, 0);
const old = new Mount("r:1", 4, replaceLive); replaceGates[0].resolve(old); await replacing.settle();
replacing.update(48, 0);
const bad = new Mount("r:0", 10, replaceLive, true); replaceGates[1].resolve(bad); await replacing.settle();
assert(replaceLive.has("r:1") && !replaceLive.has("r:0") && replacing.activeLod("r") === 1 && bad.disposed === 1
  && replacing.takeErrors().some((error) => /commit r:0/.test(String(error))),
  "failed replacement damaged the prior publication or leaked the candidate");

console.log("p_grass_field_residency OK: deterministic ordering/4x LOD, one-pending scheduling, hard slot cap, stale/reject/drop/clear handling, atomic replacement, and aggregate cleanup are proven");
