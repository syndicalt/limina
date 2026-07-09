import assert from "node:assert/strict";
import test from "node:test";

import { parseTransformDraft } from "../src/inspector-draft.js";
import {
  SnapshotPageLoader,
  buildOutlinerForest,
  filterOutlinerForest,
} from "../src/outliner.js";
import { SelectionStore } from "../src/selection-store.js";

const record = (entity, parent, tags = []) => ({ entity, ...(parent ? { parent } : {}), tags });

test("hierarchy is stable, cycle-safe, and orphan-safe", () => {
  const forest = buildOutlinerForest([
    record("z-root"),
    record("child", "z-root"),
    record("orphan", "missing"),
    record("cycle-b", "cycle-a"),
    record("cycle-a", "cycle-b"),
    record("self", "self"),
    record("a-root"),
  ]);
  assert.deepEqual(forest.map((node) => node.id), ["a-root", "cycle-a", "orphan", "self", "z-root"]);
  const cycle = forest.find((node) => node.id === "cycle-a");
  assert.equal(cycle.cycleBroken, true);
  assert.deepEqual(cycle.children.map((node) => node.id), ["cycle-b"]);
  assert.equal(forest.find((node) => node.id === "orphan").orphaned, true);
  assert.equal(forest.find((node) => node.id === "self").cycleBroken, true);
  assert.deepEqual(forest.find((node) => node.id === "z-root").children.map((node) => node.id), ["child"]);
});

test("filter preserves ancestors and uses entity tags", () => {
  const forest = buildOutlinerForest([
    record("root"),
    record("middle", "root"),
    record("leaf", "middle", ["Boss"]),
    record("other"),
  ]);
  const filtered = filterOutlinerForest(forest, "boss");
  assert.deepEqual(filtered.map((node) => node.id), ["root"]);
  assert.deepEqual(filtered[0].children.map((node) => node.id), ["middle"]);
  assert.deepEqual(filtered[0].children[0].children.map((node) => node.id), ["leaf"]);
});

test("snapshot loader fetches every bounded page in cursor order", async () => {
  const calls = [];
  const all = [record("e0"), record("e1"), record("e2"), record("e3"), record("e4")];
  const client = { async callTool(name, input) {
    assert.equal(name, "inspector.snapshot");
    calls.push(input);
    const start = input.afterEntity === undefined ? 0 : all.findIndex((entry) => entry.entity === input.afterEntity) + 1;
    const entities = all.slice(start, start + input.limit);
    const next = start + input.limit < all.length ? entities.at(-1).entity : null;
    return {
      page: { totalEntities: all.length, limit: input.limit, nextAfterEntity: next, entityVersion: 4 },
      entities,
      world: { mode: "headless" }, agents: [], skills: [], permissions: {}, resources: {}, trace: {},
    };
  } };
  const loader = new SnapshotPageLoader({ pageSize: 2, totalCap: 5 });
  const snapshot = await loader.load(client);
  assert.deepEqual(snapshot.entities.map((entry) => entry.entity), ["e0", "e1", "e2", "e3", "e4"]);
  assert.deepEqual(calls.map((call) => call.afterEntity), [undefined, "e1", "e3"]);
  assert.deepEqual(calls.map((call) => call.entityVersion), [undefined, 4, 4]);
  assert.equal(calls.every((call) => call.includeResources === false && call.includeSkills === false), true);
});

test("snapshot loader rejects caps, cursor loops, and count drift", async () => {
  const overCap = new SnapshotPageLoader({ totalCap: 2 });
  await assert.rejects(overCap.load({ callTool: async () => ({ page: { totalEntities: 3, nextAfterEntity: null, entityVersion: 1 }, entities: [] }) }), /cap is 2/);

  const looping = new SnapshotPageLoader({ pageSize: 1 });
  let calls = 0;
  await assert.rejects(looping.load({ callTool: async () => {
    calls++;
    return { page: { totalEntities: 2, nextAfterEntity: "e0", entityVersion: 1 }, entities: [record("e0")] };
  } }), /duplicate entity id|cursor did not advance/);
  assert.equal(calls, 2);

  const drifting = new SnapshotPageLoader({ pageSize: 1 });
  let page = 0;
  await assert.rejects(drifting.load({ callTool: async () => {
    page++;
    return page === 1
      ? { page: { totalEntities: 2, nextAfterEntity: "e0", entityVersion: 1 }, entities: [record("e0")] }
      : { page: { totalEntities: 3, nextAfterEntity: null, entityVersion: 1 }, entities: [record("e1")] };
  } }), /count changed/);

  const versionDrift = new SnapshotPageLoader({ pageSize: 1 });
  page = 0;
  await assert.rejects(versionDrift.load({ callTool: async () => {
    page++;
    return page === 1
      ? { page: { totalEntities: 2, nextAfterEntity: "e0", entityVersion: 1 }, entities: [record("e0")] }
      : { page: { totalEntities: 2, nextAfterEntity: null, entityVersion: 2 }, entities: [record("e1")] };
  } }), /version changed/);
});

test("new snapshot generations supersede stale responses", async () => {
  let resolveFirst;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  let call = 0;
  const client = { callTool: async () => {
    call++;
    if (call === 1) return first;
    return { page: { totalEntities: 0, nextAfterEntity: null, entityVersion: 2 }, entities: [], world: {}, agents: [] };
  } };
  const loader = new SnapshotPageLoader();
  const staleLoad = loader.load(client);
  const current = await loader.load(client);
  assert.deepEqual(current.entities, []);
  resolveFirst({ page: { totalEntities: 1, nextAfterEntity: null, entityVersion: 1 }, entities: [record("old")] });
  assert.equal(await staleLoad, undefined);

  let rejectDisconnected;
  const disconnected = new Promise((_resolve, reject) => { rejectDisconnected = reject; });
  const cancelledLoader = new SnapshotPageLoader();
  const cancelledLoad = cancelledLoader.load({ callTool: () => disconnected });
  cancelledLoader.cancel();
  rejectDisconnected(new Error("socket closed"));
  assert.equal(await cancelledLoad, undefined, "cancelled request rejection escaped as a poll error");
});

test("selection synchronizes subscribers, survives refresh, and clears on deletion", () => {
  const selection = new SelectionStore();
  const outliner = [];
  const viewport = [];
  const inspector = [];
  selection.subscribe((change) => outliner.push(change));
  selection.subscribe((change) => viewport.push(change));
  selection.subscribe((change) => inspector.push(change));
  selection.select("e1", "outliner");
  selection.select("e1", "viewport");
  selection.reconcile(new Set(["e1", "e2"]));
  assert.equal(selection.get(), "e1");
  assert.equal(outliner.length, 1);
  selection.reconcile(new Set(["e2"]), "snapshot-delete");
  assert.equal(selection.get(), undefined);
  for (const stream of [outliner, viewport, inspector]) {
    assert.deepEqual(stream.map((change) => change.selectedId), ["e1", undefined]);
  }
});

test("invalid visible transform drafts fail instead of falling back to old state", () => {
  assert.equal(parseTransformDraft([1, 2, NaN], [0, 0, 0], [1, 1, 1]).valid, false);
  assert.equal(parseTransformDraft([1, 2, 3], [0, Infinity, 0], [1, 1, 1]).valid, false);
  assert.deepEqual(
    parseTransformDraft([1, 2, 3], [0, 90, 0], [1, 1, 1]),
    { valid: true, transform: { position: [1, 2, 3], rotationDeg: [0, 90, 0], scale: [1, 1, 1] } },
  );
});
