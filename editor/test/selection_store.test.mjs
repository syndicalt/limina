import assert from "node:assert/strict";
import test from "node:test";

import { SelectionStore } from "../src/selection-store.js";

test("single select/clear stay byte-compatible and always carry selectedIds", () => {
  const store = new SelectionStore();
  const seen = [];
  store.subscribe((change) => seen.push(change));
  assert.equal(store.get(), undefined);
  assert.deepEqual(store.getMany(), []);

  assert.equal(store.select("e1", "outliner"), true);
  assert.equal(store.get(), "e1");
  assert.deepEqual(store.getMany(), ["e1"]);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { selectedId: "e1", previousId: undefined, source: "outliner", selectedIds: ["e1"] });
  assert.ok(Object.isFrozen(seen[0]));
  assert.ok(Object.isFrozen(seen[0].selectedIds));

  // Same id is a no-op: no event, false return.
  assert.equal(store.select("e1", "viewport"), false);
  assert.equal(seen.length, 1);

  assert.equal(store.clear("viewport"), true);
  assert.equal(store.get(), undefined);
  assert.deepEqual(store.getMany(), []);
  assert.deepEqual(seen[1], { selectedId: undefined, previousId: "e1", source: "viewport", selectedIds: [] });
  assert.equal(store.clear(), false);

  assert.throws(() => store.select(""), TypeError);
  assert.throws(() => store.select(7), TypeError);
  assert.throws(() => store.subscribe(null), TypeError);
});

test("subscribe emitCurrent includes selectedIds", () => {
  const store = new SelectionStore();
  store.selectMany(["a", "b"]);
  const seen = [];
  store.subscribe((change) => seen.push(change), { emitCurrent: true });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { selectedId: "b", previousId: undefined, source: "subscribe", selectedIds: ["a", "b"] });
});

test("selectMany validates input, fires once, primary is the last id", () => {
  const store = new SelectionStore();
  assert.throws(() => store.selectMany([]), TypeError);
  assert.throws(() => store.selectMany("abc"), TypeError);
  assert.throws(() => store.selectMany(["a", ""]), TypeError);
  assert.throws(() => store.selectMany([undefined]), TypeError);

  const seen = [];
  store.subscribe((change) => seen.push(change));
  assert.equal(store.selectMany(["a", "b", "c"], "viewport"), true);
  assert.equal(seen.length, 1);
  assert.equal(store.get(), "c"); // LAST id is the primary
  assert.deepEqual(seen[0].selectedIds, ["a", "b", "c"]);
  assert.equal(seen[0].previousId, undefined);
  assert.equal(seen[0].source, "viewport");

  // Identical set + primary is a no-op even in a different array order.
  assert.equal(store.selectMany(["b", "a", "c"], "viewport"), false);
  assert.equal(seen.length, 1);

  // Same set but a different primary fires.
  assert.equal(store.selectMany(["c", "b", "a"], "viewport"), true);
  assert.equal(store.get(), "a");
  assert.equal(seen.length, 2);

  // Single select collapses the multi-selection.
  store.select("a", "outliner");
  assert.deepEqual(store.getMany(), ["a"]);
});

test("getMany returns a frozen defensive copy", () => {
  const store = new SelectionStore();
  store.selectMany(["a", "b"]);
  const first = store.getMany();
  const second = store.getMany();
  assert.notEqual(first, second);
  assert.ok(Object.isFrozen(first));
  assert.throws(() => first.push("c"), TypeError);
  assert.deepEqual(store.getMany(), ["a", "b"]);
});

test("reconcile drops dead ids and falls back to the last survivor", () => {
  const store = new SelectionStore();
  assert.throws(() => store.reconcile(["a"]), TypeError);

  store.selectMany(["a", "b", "c"], "viewport");
  const seen = [];
  store.subscribe((change) => seen.push(change));

  // Nothing dead: no event, primary unchanged.
  assert.equal(store.reconcile(new Set(["a", "b", "c", "d"])), "c");
  assert.equal(seen.length, 0);

  // A secondary id died: dropped, primary untouched, one event.
  assert.equal(store.reconcile(new Set(["a", "c"]), "snapshot-delete"), "c");
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].selectedIds, ["a", "c"]);

  // The primary died: the LAST surviving id becomes primary.
  assert.equal(store.reconcile(new Set(["a"]), "snapshot-delete"), "a");
  assert.equal(store.get(), "a");
  assert.deepEqual(store.getMany(), ["a"]);

  // Everything died: selection clears (legacy single-select behavior).
  assert.equal(store.reconcile(new Set(["zzz"]), "snapshot-delete"), undefined);
  assert.equal(store.get(), undefined);
  assert.deepEqual(store.getMany(), []);
  assert.equal(seen.at(-1).selectedId, undefined);
  assert.deepEqual(seen.at(-1).selectedIds, []);
});
