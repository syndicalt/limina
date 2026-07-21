import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_NAVIGATION_SPEED_MPS,
  MAX_NAVIGATION_BOOKMARKS,
  MAX_NAVIGATION_COORDINATE_M,
  MAX_NAVIGATION_RECENTS,
  MAX_NAVIGATION_SPEED_MPS,
  NAVIGATION_STATE_SCHEMA,
  createDefaultNavigationState,
  createNavigationStateController,
  navigationStorageKey,
  parseNavigationCoordinate,
  parseNavigationIdentity,
  parseNavigationName,
  parseNavigationPose,
  parseNavigationPreferences,
  parseNavigationState,
  readNavigationState,
  serializeNavigationState,
  writeNavigationState,
} from "../src/navigation-state.js";

const identity = Object.freeze({ projectId: "grey-field", branchId: "main" });
const otherIdentity = Object.freeze({ projectId: "other-world", branchId: "main" });

function pose(overrides = {}) {
  return {
    position: [10, 20, 30],
    quaternion: [0, 0, 0, 1],
    target: [1, 2, 3],
    mode: "orbit",
    ...overrides,
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("navigation identity and storage keys are strict and project scoped", () => {
  assert.deepEqual(parseNavigationIdentity(identity), identity);
  assert.equal(navigationStorageKey(identity), "limina.editor.navigation/v1:grey-field:main");
  assert.notEqual(navigationStorageKey(identity), navigationStorageKey(otherIdentity));
  assert.throws(() => parseNavigationIdentity({ projectId: "Grey Field", branchId: "main" }), /projectId/);
  assert.throws(() => parseNavigationIdentity({ projectId: "grey-field", branchId: "main", token: "secret" }), /fields/);
});

test("preferences clamp finite speed and reject unsupported shapes", () => {
  assert.deepEqual(parseNavigationPreferences({ mode: "fly", speedMps: 1e9 }), {
    mode: "fly",
    speedMps: MAX_NAVIGATION_SPEED_MPS,
  });
  assert.deepEqual(parseNavigationPreferences({ mode: "orbit", speedMps: -12 }), {
    mode: "orbit",
    speedMps: 0.25,
  });
  assert.throws(() => parseNavigationPreferences({ mode: "walk", speedMps: 10 }), /mode/);
  assert.throws(() => parseNavigationPreferences({ mode: "fly", speedMps: NaN }), /finite/);
  assert.throws(() => parseNavigationPreferences({ mode: "fly", speedMps: 10, boost: 4 }), /fields/);
});

test("coordinate parser rejects non-finite and out-of-domain input without changing its destination", () => {
  assert.equal(parseNavigationCoordinate(-0), 0);
  assert.equal(parseNavigationCoordinate(MAX_NAVIGATION_COORDINATE_M, "X"), MAX_NAVIGATION_COORDINATE_M);
  assert.throws(() => parseNavigationCoordinate(NaN, "X"), /X must be finite/);
  assert.throws(() => parseNavigationCoordinate(MAX_NAVIGATION_COORDINATE_M + 1, "Z"), /Z exceeds/);
});

test("poses enforce coordinate bounds, normalize quaternions, and reject hostile data", () => {
  const parsed = parseNavigationPose(pose({ position: [MAX_NAVIGATION_COORDINATE_M, -0, -MAX_NAVIGATION_COORDINATE_M], quaternion: [0, 0, 0, 2] }));
  assert.deepEqual(parsed.position, [MAX_NAVIGATION_COORDINATE_M, 0, -MAX_NAVIGATION_COORDINATE_M]);
  assert.deepEqual(parsed.quaternion, [0, 0, 0, 1]);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.position), true);
  assert.throws(() => parseNavigationPose(pose({ position: [MAX_NAVIGATION_COORDINATE_M + 1, 0, 0] })), /coordinate limit/);
  assert.throws(() => parseNavigationPose(pose({ position: [1, Infinity, 3] })), /finite/);
  assert.throws(() => parseNavigationPose(pose({ quaternion: [0, 0, 0, 0] })), /non-zero/);
  const hugeQuaternion = parseNavigationPose(pose({ quaternion: [1e308, 1e308, 0, 0] })).quaternion;
  assert.ok(Math.abs(hugeQuaternion[0] - Math.SQRT1_2) < 1e-15 && Math.abs(hugeQuaternion[1] - Math.SQRT1_2) < 1e-15);
  assert.throws(() => parseNavigationPose(pose({ target: [1, 2] })), /dense/);

  const hostile = pose();
  Object.defineProperty(hostile, "target", { enumerable: true, get() { throw new Error("getter ran"); } });
  assert.throws(() => parseNavigationPose(hostile), /data field/);
});

test("names are normalized but controls and oversized values are rejected", () => {
  assert.equal(parseNavigationName("  Northern   Shore  "), "Northern Shore");
  assert.throws(() => parseNavigationName(""), /1-64/);
  assert.throws(() => parseNavigationName("bad\nname"), /printable/);
  assert.throws(() => parseNavigationName("x".repeat(65)), /1-64/);
});

test("storage failures, malformed bytes, and cross-project payloads fail closed", () => {
  const fallback = createDefaultNavigationState(identity);
  assert.equal(fallback.preferences.speedMps, DEFAULT_NAVIGATION_SPEED_MPS);
  assert.deepEqual(readNavigationState({ getItem() { throw new Error("denied"); } }, identity), fallback);
  assert.deepEqual(readNavigationState({ getItem: () => "{" }, identity), fallback);
  assert.deepEqual(readNavigationState({ getItem: () => "x".repeat(70_000) }, identity), fallback);

  const other = createDefaultNavigationState(otherIdentity);
  const storage = { getItem: () => JSON.stringify(other) };
  assert.deepEqual(readNavigationState(storage, identity), fallback);
  assert.equal(writeNavigationState({ setItem() { throw new Error("quota"); } }, fallback), false);
});

test("controller allocates deterministic ids and persists bounded immutable state", () => {
  const storage = memoryStorage();
  const controller = createNavigationStateController({ storage, identity });
  const changes = [];
  controller.subscribe((change) => changes.push(change), { emitCurrent: true });
  const detachedSetMode = controller.setMode;
  detachedSetMode("fly");
  controller.setSpeed(5000);
  const first = controller.addBookmark("Start", pose());
  const second = controller.addBookmark("Keep", pose({ position: [40, 50, 60] }));
  assert.deepEqual([first.id, second.id], ["bookmark-1", "bookmark-2"]);
  assert.equal(controller.snapshot().preferences.mode, "fly");
  assert.equal(controller.snapshot().preferences.speedMps, MAX_NAVIGATION_SPEED_MPS);
  assert.equal(controller.removeBookmark(first.id), true);
  assert.equal(controller.removeBookmark(first.id), false);
  assert.equal(Object.isFrozen(controller.snapshot().bookmarks), true);
  assert.equal(changes.at(-1).persisted, true);
  assert.equal(storage.values.has(navigationStorageKey(identity)), true);
  assert.deepEqual(parseNavigationState(JSON.parse(serializeNavigationState(controller.snapshot())), identity), controller.snapshot());
});

test("bookmark and recent collections stay bounded and recents deduplicate exact destinations", () => {
  const controller = createNavigationStateController({ identity });
  for (let index = 0; index < MAX_NAVIGATION_BOOKMARKS; index++) {
    controller.addBookmark(`View ${index}`, pose({ position: [index, 2, 3] }));
  }
  assert.throws(() => controller.addBookmark("Overflow", pose()), /limit/);

  for (let index = 0; index < MAX_NAVIGATION_RECENTS + 4; index++) {
    controller.addRecent({ label: `Place ${index}`, kind: "coordinate", pose: pose({ target: [index, 2, 3] }) });
  }
  assert.equal(controller.snapshot().recents.length, MAX_NAVIGATION_RECENTS);
  assert.equal(controller.snapshot().recents[0].label, `Place ${MAX_NAVIGATION_RECENTS + 3}`);
  const before = controller.snapshot().recents.length;
  controller.addRecent({ label: "Duplicate", kind: "bookmark", pose: pose() });
  controller.addRecent({ label: "Duplicate", kind: "bookmark", pose: pose() });
  assert.equal(controller.snapshot().recents.filter((recent) => recent.label === "Duplicate").length, 1);
  assert.equal(controller.snapshot().recents.length, Math.min(MAX_NAVIGATION_RECENTS, before + 1));
});

test("injected ids are validated and persistence failure does not discard in-memory changes", () => {
  const storage = { getItem: () => null, setItem() { throw new Error("quota"); } };
  const controller = createNavigationStateController({
    storage,
    identity,
    idSource: ({ kind, sequence }) => `custom-${kind}-${sequence}`,
  });
  assert.equal(controller.addBookmark("One", pose()).id, "custom-bookmark-1");
  assert.equal(controller.snapshot().bookmarks.length, 1);
  assert.equal(controller.setMode("fly").mode, "fly");

  const duplicate = createNavigationStateController({ identity, idSource: () => "same-id" });
  duplicate.addBookmark("One", pose());
  assert.throws(() => duplicate.addBookmark("Two", pose()), /already exists/);
  assert.throws(() => createNavigationStateController({ identity, idSource: () => "Bad ID" }).addBookmark("Bad", pose()), /id/);
});

test("state schema and exact fields remain stable", () => {
  const state = createDefaultNavigationState(identity);
  assert.equal(state.schema, NAVIGATION_STATE_SCHEMA);
  assert.throws(() => parseNavigationState({ ...state, token: "secret" }, identity), /fields/);
  assert.throws(() => parseNavigationState({ ...state, schema: "limina.editor-navigation/v2" }, identity), /unsupported/);
  const hostileBookmarks = [];
  Object.defineProperty(hostileBookmarks, "0", { enumerable: true, get() { throw new Error("getter ran"); } });
  hostileBookmarks.length = 1;
  assert.throws(() => parseNavigationState({ ...state, bookmarks: hostileBookmarks }, identity), /data field/);
});
