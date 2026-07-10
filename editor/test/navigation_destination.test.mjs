import assert from "node:assert/strict";
import test from "node:test";
import { createNavigationDestinationCoordinator } from "../src/navigation-destination.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function pose(x, mode = "orbit") {
  return Object.freeze({
    position: Object.freeze([x + 10, 20, 30]),
    quaternion: Object.freeze([0, 0, 0, 1]),
    up: Object.freeze([0, 1, 0]),
    target: Object.freeze([x, 2, 4]),
    mode,
    speedMps: 64,
  });
}

function harness({ timeoutMs = 1_000 } = {}) {
  const reconciliation = deferred();
  const states = [];
  const commits = [];
  const restored = [];
  const enabled = [];
  const resets = [];
  const reverted = [];
  const reconciled = [];
  let current = true;
  let livePose = pose(0);
  const runtime = {
    editorNavigation: {
      snapshot: () => livePose,
      restore: (next) => { livePose = next; restored.push(next); },
      residencyCenter: (next) => next.mode === "fly" ? [next.position[0], next.position[2]] : [next.target[0], next.target[2]],
      acquireDisabled: () => {
        enabled.push(false);
        let released = false;
        return () => { if (!released) { released = true; enabled.push(true); } };
      },
    },
    derivedTerrainResidency: () => Object.freeze({
      schema: "limina.derived-terrain-residency/v1",
      center: Object.freeze([0, 4]),
      lod: 0,
      radius: 7,
    }),
  };
  const client = {
    reconcileResidency: (value) => {
      reconciled.push(value);
      return reconciled.length === 1
        ? reconciliation.promise
        : Promise.resolve(Object.freeze({ status: "unchanged", manifestHash: "sha256:" + "d".repeat(64), revision: 1 }));
    },
    setResidency: async (value) => { reverted.push(value); },
  };
  const context = { runtime, client, isCurrent: () => current };
  const coordinator = createNavigationDestinationCoordinator({
    getContext: () => context,
    onState: (value) => states.push(value),
    onCommit: (value) => commits.push(value),
    resetContext: async (_value, error) => resets.push(error.code),
    timeoutMs,
  });
  return {
    client, commits, context, coordinator, enabled, reconciliation, reconciled, resets, restored, reverted, states,
    livePose: () => livePose,
    setCurrent: (value) => { current = value; },
  };
}

test("destination pose is committed only after exact residency readiness", async () => {
  const state = harness();
  const destination = pose(1_024);
  const navigation = state.coordinator.navigate(destination, { label: "Northern shore" });
  await Promise.resolve();
  assert.equal(state.livePose().target[0], 0, "camera moved before terrain readiness");
  assert.deepEqual(state.enabled, [false]);
  assert.equal(state.coordinator.busy(), true);
  state.reconciliation.resolve(Object.freeze({ status: "activated", manifestHash: "sha256:" + "a".repeat(64), revision: 2 }));
  const committed = await navigation;
  assert.equal(committed.pose.target[0], 1_024);
  assert.deepEqual(committed.residency.center, [1_024, 4]);
  assert.deepEqual(state.enabled, [false, true]);
  assert.equal(state.commits.length, 1);
  assert.equal(state.reverted.length, 0);
});

test("post-activation pose resolution samples ready terrain before camera commit", async () => {
  const state = harness();
  const provisional = pose(1_200);
  const grounded = Object.freeze({ ...provisional, target: Object.freeze([1_200, 87, 4]) });
  const order = [];
  const navigation = state.coordinator.navigate(provisional, {
    label: "Atlas destination",
    resolvePose: ({ result, residency }) => {
      order.push("resolve");
      assert.equal(result.status, "activated");
      assert.deepEqual(residency.center, [1_200, 4]);
      assert.equal(state.livePose().target[0], 0, "camera moved before post-activation resolution");
      return grounded;
    },
  });
  await Promise.resolve();
  assert.deepEqual(order, []);
  state.reconciliation.resolve(Object.freeze({ status: "activated", manifestHash: "sha256:" + "9".repeat(64), revision: 2 }));
  const committed = await navigation;
  assert.deepEqual(order, ["resolve"]);
  assert.equal(committed.pose.target[1], 87);
  assert.equal(state.livePose().target[1], 87);
});

test("post-activation pose resolution cannot escape the ready residency", async () => {
  const state = harness();
  const navigation = state.coordinator.navigate(pose(500), {
    resolvePose: () => pose(900),
  });
  await Promise.resolve();
  state.reconciliation.resolve(Object.freeze({ status: "activated", manifestHash: "sha256:" + "8".repeat(64), revision: 2 }));
  await assert.rejects(navigation, (error) => error.code === "NAVIGATION_DESTINATION_CHANGED");
  assert.equal(state.livePose().target[0], 0);
  assert.deepEqual(state.reconciled.map((value) => value.center), [[500, 4], [0, 4]]);
});

test("post-activation pose resolution rejects asynchronous work before it can retain the input lease", async () => {
  const state = harness();
  const navigation = state.coordinator.navigate(pose(600), {
    resolvePose: async () => pose(600),
  });
  await Promise.resolve();
  state.reconciliation.resolve(Object.freeze({ status: "activated", manifestHash: "sha256:" + "7".repeat(64), revision: 2 }));
  await assert.rejects(navigation, /pose resolver must be synchronous/);
  assert.equal(state.livePose().target[0], 0);
  assert.deepEqual(state.enabled, [false, true]);
});

test("failed destination retains the prior pose and requests the prior residency", async () => {
  const state = harness();
  const navigation = state.coordinator.navigate(pose(2_048));
  await Promise.resolve();
  const error = new Error("outside map");
  error.code = "RESIDENCY_OUTSIDE_DOMAIN";
  state.reconciliation.reject(error);
  await assert.rejects(navigation, (failure) => failure.code === "RESIDENCY_OUTSIDE_DOMAIN");
  assert.equal(state.livePose().target[0], 0);
  assert.deepEqual(state.reconciled.map((value) => value.center), [[2_048, 4], [0, 4]]);
  assert.equal(state.reverted.length, 0);
  assert.deepEqual(state.enabled, [false, true]);
});

test("post-activation camera failure exactly reconciles the prior residency before release", async () => {
  const state = harness();
  const destination = pose(400);
  const originalRestore = state.context.runtime.editorNavigation.restore;
  state.context.runtime.editorNavigation.restore = (next) => {
    if (next === destination) throw new Error("camera restore failed");
    originalRestore(next);
  };
  const navigation = state.coordinator.navigate(destination);
  await Promise.resolve();
  state.reconciliation.resolve(Object.freeze({ status: "activated", manifestHash: "sha256:" + "e".repeat(64), revision: 2 }));
  await assert.rejects(navigation, /camera restore failed/);
  assert.deepEqual(state.reconciled.map((value) => value.center), [[400, 4], [0, 4]]);
  assert.equal(state.livePose().target[0], 0);
  assert.deepEqual(state.enabled, [false, true]);
});

test("timeout resets the worker context instead of queueing behind a stuck reconcile", async () => {
  const state = harness({ timeoutMs: 5 });
  await assert.rejects(state.coordinator.navigate(pose(3_000)), (error) => error.code === "NAVIGATION_TIMEOUT");
  assert.deepEqual(state.resets, ["NAVIGATION_TIMEOUT"]);
  assert.equal(state.reverted.length, 0);
  assert.equal(state.livePose().target[0], 0);
});

test("overlapping destinations fail closed and stale contexts never move the camera", async () => {
  const state = harness();
  const first = state.coordinator.navigate(pose(512));
  await assert.rejects(state.coordinator.navigate(pose(768)), (error) => error.code === "NAVIGATION_BUSY");
  state.setCurrent(false);
  state.reconciliation.resolve(Object.freeze({ status: "activated", manifestHash: "sha256:" + "b".repeat(64), revision: 3 }));
  await assert.rejects(first, (error) => error.code === "NAVIGATION_STALE_CONTEXT");
  assert.equal(state.livePose().target[0], 0);
});

test("fly destinations derive residency from camera position and observers cannot break cleanup", async () => {
  const state = harness();
  const coordinator = createNavigationDestinationCoordinator({
    getContext: () => state.context,
    onState: () => { throw new Error("observer failure"); },
  });
  const destination = pose(900, "fly");
  const navigation = coordinator.navigate(destination);
  await Promise.resolve();
  state.reconciliation.resolve(Object.freeze({ status: "unchanged", manifestHash: "sha256:" + "c".repeat(64), revision: 4 }));
  const committed = await navigation;
  assert.deepEqual(committed.residency.center, [910, 30]);
  assert.equal(state.livePose().mode, "fly");
});

test("hostile residency centers fail before navigation is disabled", async () => {
  const state = harness();
  const sparse = new Array(2);
  sparse[0] = 1;
  state.context.runtime.editorNavigation.residencyCenter = () => sparse;
  await assert.rejects(state.coordinator.navigate(pose(200)), TypeError);
  assert.deepEqual(state.enabled, []);

  let accessorInvoked = false;
  const accessor = [1, 2];
  Object.defineProperty(accessor, "1", {
    enumerable: true,
    get() { accessorInvoked = true; return 2; },
  });
  state.context.runtime.editorNavigation.residencyCenter = () => accessor;
  await assert.rejects(state.coordinator.navigate(pose(300)), TypeError);
  assert.equal(accessorInvoked, false);
  assert.deepEqual(state.enabled, []);
});
