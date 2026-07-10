import assert from "node:assert/strict";
import test from "node:test";

import {
  ATLAS_WORKSPACE_STORAGE_KEY,
  atlasWorkspaceWidthBounds,
  clampAtlasWorkspaceWidth,
  defaultAtlasWorkspaceState,
  parseAtlasWorkspaceState,
  readAtlasWorkspaceState,
  writeAtlasWorkspaceState,
} from "../src/atlas-workspace-state.js";

const valid = () => ({ version: 1, open: true, maximized: false, widthPx: 612 });

test("Atlas workspace state round-trips through optional storage", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(writeAtlasWorkspaceState(storage, valid()), true);
  assert.equal(values.has(ATLAS_WORKSPACE_STORAGE_KEY), true);
  assert.deepEqual(readAtlasWorkspaceState(storage), valid());
});

test("Atlas workspace state fails closed on malformed or hostile data", () => {
  for (const input of [null, [], {}, { ...valid(), extra: true }, { ...valid(), version: 2 },
    { ...valid(), open: 1 }, { ...valid(), maximized: "yes" }, { ...valid(), widthPx: NaN },
    { ...valid(), widthPx: Infinity }, { ...valid(), widthPx: 20 }, { ...valid(), widthPx: 20_000 }]) {
    assert.throws(() => parseAtlasWorkspaceState(input));
  }
  const accessor = valid();
  Object.defineProperty(accessor, "widthPx", { enumerable: true, get: () => 600 });
  assert.throws(() => parseAtlasWorkspaceState(accessor), /data field/);
  const polluted = Object.assign(Object.create({ inherited: true }), valid());
  assert.throws(() => parseAtlasWorkspaceState(polluted), /plain object/);
});

test("Atlas workspace storage failures return immutable defaults", () => {
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readAtlasWorkspaceState(broken), defaultAtlasWorkspaceState());
  assert.equal(writeAtlasWorkspaceState(broken, valid()), false);
});

test("runtime width clamping preserves a usable 3D viewport", () => {
  assert.deepEqual(atlasWorkspaceWidthBounds(1200), { minimum: 360, maximum: 840 });
  assert.equal(clampAtlasWorkspaceWidth(900, 1200), 840);
  assert.equal(clampAtlasWorkspaceWidth(200, 1200), 360);
  assert.equal(clampAtlasWorkspaceWidth(612, 1400), 612);
  assert.equal(clampAtlasWorkspaceWidth(612, 500), 360);
});
