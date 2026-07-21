import { FunctionalSettlementResidencyManager } from "../src/skills/functional-settlement-residency.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`p_functional_settlement_residency FAIL: ${message}`); }
async function rejects(fn: () => Promise<unknown>, pattern: RegExp, message: string): Promise<void> {
  try { await fn(); } catch (error) { if (pattern.test(error instanceof Error ? error.message : String(error))) return; throw error; }
  throw new Error(`p_functional_settlement_residency FAIL: ${message}`);
}
const placement = (unitId: string, x: number, cells: string[]) => ({ placementId: `placement/${unitId}`, position: [x, 5, -900_000_000] as const,
  residency: { unitId, policy: "whole-building-atomic" as const, cellIds: cells } });
const plan = { planId: "settlement/residency-test", placements: [
  placement("unit/a", 900_000_010, ["cell/a-main", "cell/a-upper"]),
  placement("unit/b", 900_000_010, ["cell/b-main", "cell/b-upper"]),
  placement("unit/c", 900_000_025, ["cell/c-main"]),
] };
type Resource = { id: string };
let live = new Map<string, Resource>();
let commits = 0, rollbacks = 0, failCommit = false;
const manager = new FunctionalSettlementResidencyManager<Resource>(plan, {
  loadDistance: 12, keepDistance: 20, maxActiveUnits: 2, maxResidentBytes: 200,
  estimateResidentBytes: (p) => p.residency.unitId === "unit/c" ? 150 : 100,
  stageTransition: ({ load, unload, previous }) => {
    // Every callback receives complete buildings, never a cell-level delta.
    assert(load.every(unit => unit.cellIds.length === plan.placements.find(p => p.residency.unitId === unit.unitId)!.residency.cellIds.length), "partial cell load escaped");
    const next = new Map(previous);
    for (const unit of unload) next.delete(unit.unitId);
    for (const unit of load) next.set(unit.unitId, { id: unit.unitId });
    const before = new Map(live);
    return { next, commit() { if (failCommit) throw new Error("injected commit failure"); live = new Map(next); commits++; },
      rollback() { live = before; rollbacks++; } };
  },
});

// Million-scale origin and equal-distance selection use stable id ordering under count/byte caps.
let snap = await manager.update([900_000_000, 5, -900_000_000]);
assert(snap.residentUnitIds.join(",") === "unit/a,unit/b" && snap.residentBytes === 200, "stable bounded initial selection failed");

// Hysteresis retains existing units beyond load distance; a nonresident peer cannot thrash in.
snap = await manager.update([899_999_995, 5, -900_000_000]);
assert(snap.residentUnitIds.join(",") === "unit/a,unit/b" && commits === 1, "keep margin thrashed or caused a redundant transaction");

// Explicit interest outranks distance but byte accounting admits only the indivisible large unit.
manager.setExplicitInterest(["unit/c"]);
snap = await manager.update([900_000_000, 5, -900_000_000]);
assert(snap.residentUnitIds.join(",") === "unit/c" && snap.residentBytes === 150, "explicit interest or whole-unit byte budget failed");
assert(live.size === 1 && live.has("unit/c"), "transaction callback and manager state diverged");

// Failed activation rolls back host effects and preserves authoritative manager state/revision.
const beforeFailure = manager.snapshot();
failCommit = true;
manager.setExplicitInterest(["unit/a"]);
await rejects(() => manager.update([0, 5, -900_000_000]), /injected commit failure/, "commit failure was accepted");
assert(manager.snapshot().residentUnitIds.join(",") === beforeFailure.residentUnitIds.join(",") && live.has("unit/c") && rollbacks === 1,
  "failed transition did not roll back atomically");
failCommit = false;

// A malformed transaction that returns a partial cell/building selection is rejected pre-commit.
const malformed = new FunctionalSettlementResidencyManager<Resource>(plan, {
  loadDistance: 100, keepDistance: 100, maxActiveUnits: 3, maxResidentBytes: 1000, estimateResidentBytes: () => 1,
  stageTransition: () => ({ next: new Map([["unit/a", { id: "unit/a" }]]), commit() { throw new Error("must not commit"); }, rollback() { rollbacks++; } }),
});
await rejects(() => malformed.update([900_000_000, 5, -900_000_000]), /partial or unexpected/, "partial transaction set was accepted");
assert(malformed.snapshot().residentUnitIds.length === 0, "malformed transition changed manager state");

// Successful unload is whole-building and terminal teardown is idempotent.
manager.setExplicitInterest([]);
await manager.update([0, 5, 0]);
assert(manager.snapshot().residentUnitIds.length === 0 && live.size === 0, "safe whole-building unload failed");
await manager.close();
await manager.close();
assert(manager.closed && commits === 3, "idempotent close performed an extra transition");
await rejects(() => manager.update([0, 0, 0]), /closed/, "closed manager accepted an update");

console.log("p_functional_settlement_residency OK: exact atomic cell inventories, stable bounded distance/interest selection, hysteresis, large-coordinate safety, transactional rollback, safe unload, and idempotent teardown proven");
