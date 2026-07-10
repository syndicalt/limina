import assert from "node:assert/strict";
import test from "node:test";

import {
  AssetPlacementStore,
  CatalogRefreshController,
  filterCatalog,
  validateCatalogPayload,
} from "../src/content-browser.js";

const entry = (id, title = id, category = "prop", extra = {}) => ({
  id,
  title,
  category,
  boundsM: [1, 2, 3],
  tags: [],
  ...extra,
});

test("catalog validation is bounded, strict, deduplicated, and deterministically sorted", () => {
  const validated = validateCatalogPayload({ entries: [
    entry("z.glb", "alpha"),
    entry("a.glb", "Alpha"),
    entry("b.glb", "Beta", "civic", { qcRender: "/qc/b.png", tags: ["Stone"] }),
  ] });
  assert.deepEqual(validated.map(({ id }) => id), ["a.glb", "z.glb", "b.glb"]);
  assert.equal(validated[2].qcRender, "qc/b.png");
  assert.equal(validated[0].type, "glb");
  assert.throws(() => validateCatalogPayload({ entries: [entry("same"), entry("same")] }), /duplicate id/);
  assert.throws(() => validateCatalogPayload({ entries: [entry("bad", "Bad", "prop", { qcRender: "../secret" })] }), /assets-relative path/);
  assert.throws(() => validateCatalogPayload({ entries: [entry("a"), entry("b")] }, 1), /cap is 1/);
  assert.throws(() => validateCatalogPayload({ entries: [entry("bad", "Bad", "unknown")] }), /category is unsupported/);
  assert.throws(() => validateCatalogPayload({ entries: [entry("bad", "Bad", "prop", { boundsM: [1, Infinity, 1] })] }), /positive finite/);
});

test("search and category/type filters use normalized validated metadata", () => {
  const entries = validateCatalogPayload({ entries: [
    entry("house.glb", "Farm House", "dwelling", { tags: ["Stone"] }),
    entry("archetype:well", "Village Well", "civic", { tags: ["water"] }),
  ] });
  assert.deepEqual(filterCatalog(entries, { query: "stone" }).map(({ id }) => id), ["house.glb"]);
  assert.deepEqual(filterCatalog(entries, { category: "civic" }).map(({ id }) => id), ["archetype:well"]);
  assert.deepEqual(filterCatalog(entries, { type: "archetype" }).map(({ id }) => id), ["archetype:well"]);
});

test("one placement store preserves yaw across metadata refresh and disarms removed assets", () => {
  const placement = new AssetPlacementStore();
  const original = validateCatalogPayload({ entries: [entry("house.glb", "House")] })[0];
  placement.arm(original);
  placement.rotate(Math.PI / 2);
  const updated = validateCatalogPayload({ entries: [entry("house.glb", "House v2", "prop", { boundsM: [4, 5, 6] })] })[0];
  placement.reconcile([updated]);
  assert.equal(placement.get().entry, updated);
  assert.equal(placement.get().yaw, Math.PI / 2);
  placement.reconcile([]);
  assert.deepEqual(placement.get(), { entry: undefined, yaw: 0 });
});

test("refresh bursts coalesce to one in-flight call and one bounded trailing refresh", async () => {
  let calls = 0;
  let resolveLoad;
  const timers = [];
  let now = 1_000;
  const firstLoad = new Promise((resolve) => { resolveLoad = resolve; });
  const controller = new CatalogRefreshController({
    load: () => { calls++; return calls === 1 ? firstLoad : Promise.resolve({ entries: [] }); },
    apply: () => {},
    onError: (error) => { throw error; },
    now: () => now,
    setTimer: (callback) => { timers.push(callback); },
  });
  const first = controller.request();
  controller.request();
  controller.request();
  assert.equal(calls, 0, "load should enter through the microtask boundary");
  await Promise.resolve();
  assert.equal(calls, 1);
  resolveLoad({ entries: [] });
  await first;
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(timers.length, 1);
  now += 250;
  timers.shift()();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 2, "burst produced more than one trailing refresh");
});

test("duplicate publication signals do not manufacture follow-up loads", async () => {
  let calls = 0;
  let resolveFirst;
  const timers = [];
  let now = 2_000;
  const controller = new CatalogRefreshController({
    load: () => {
      calls++;
      if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return Promise.resolve({ entries: [] });
    },
    apply: () => {},
    onError: (error) => { throw error; },
    now: () => now,
    setTimer: (callback) => { timers.push(callback); },
  });
  const first = controller.request({ signal: "catalog.publish:10" });
  await Promise.resolve();
  controller.request({ signal: "catalog.publish:10" });
  controller.request({ signal: "catalog.publish:11" });
  controller.request({ signal: "catalog.publish:11" });
  resolveFirst({ entries: [] });
  await first;
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(timers.length, 1, "newer signal did not coalesce into one trailing refresh");
  now += 250;
  timers.shift()();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 2);
  await controller.request({ signal: "catalog.publish:11" });
  assert.equal(calls, 2, "completed duplicate signal was fetched again");
});

test("a failed notification signal remains retryable", async () => {
  let calls = 0;
  let errors = 0;
  const controller = new CatalogRefreshController({
    load: async () => {
      calls++;
      if (calls === 1) throw new Error("offline");
      return { entries: [] };
    },
    apply: () => {},
    onError: () => { errors++; },
    minimumIntervalMs: 0,
  });
  await controller.request({ signal: "reconnect:2" });
  await controller.request({ signal: "reconnect:2" });
  assert.equal(errors, 1);
  assert.equal(calls, 2, "failed reconnect signal was incorrectly marked complete");
});

test("a forced refresh promotes scheduled work without leaking its timer", async () => {
  let calls = 0;
  let now = 4_000;
  const timers = new Map();
  let nextTimer = 0;
  const controller = new CatalogRefreshController({
    load: async () => { calls++; return { entries: [] }; },
    apply: () => {},
    onError: (error) => { throw error; },
    now: () => now,
    setTimer: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimer: (id) => { timers.delete(id); },
  });
  await controller.request({ signal: "reconnect:1" });
  const scheduled = controller.request({ signal: "catalog.publish:4" });
  const staleTimer = [...timers.values()][0];
  const promoted = controller.request({ force: true, signal: "manual-refresh" });
  await promoted;
  await scheduled;
  assert.equal(calls, 2);
  assert.equal(timers.size, 0, "promoted refresh left a scheduled timer owned by nobody");
  staleTimer();
  now += 250;
  await Promise.resolve();
  assert.equal(calls, 2, "cancelled scheduled callback manufactured a second load");
});
