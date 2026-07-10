import assert from "node:assert/strict";
import test from "node:test";
import {
  ATLAS_DESIGN_REF_SCHEMA,
  atlasDesignRefKey,
  parseAtlasDesignRef,
} from "../src/world/design-ref.mjs";

const valid = { schema: ATLAS_DESIGN_REF_SCHEMA, mapId: "primary", kind: "stamp", id: "church-1" };

test("parseAtlasDesignRef returns a frozen exact identity", () => {
  const parsed = parseAtlasDesignRef(valid);
  assert.deepEqual(parsed, valid);
  assert.equal(Object.isFrozen(parsed), true);
  assert.notEqual(parsed, valid);
});

test("parseAtlasDesignRef rejects extra, accessor, symbol, and invalid identity fields", () => {
  assert.throws(() => parseAtlasDesignRef({ ...valid, label: "mutable" }), /fields are invalid/);
  assert.throws(() => parseAtlasDesignRef({ ...valid, kind: "coordinate" }), /kind is invalid/);
  assert.throws(() => parseAtlasDesignRef({ ...valid, mapId: " \t" }), /mapId must contain/);
  const accessor = { ...valid };
  Object.defineProperty(accessor, "id", { enumerable: true, get() { throw new Error("invoked"); } });
  assert.throws(() => parseAtlasDesignRef(accessor), /must be an enumerable data field/);
  const symbol = { ...valid, [Symbol("hidden")]: true };
  assert.throws(() => parseAtlasDesignRef(symbol), /fields are invalid/);
});

test("atlasDesignRefKey cannot collide through delimiter content", () => {
  const left = { ...valid, mapId: "a:b", id: "c" };
  const right = { ...valid, mapId: "a", id: "b:c" };
  assert.notEqual(atlasDesignRefKey(left), atlasDesignRefKey(right));
  assert.equal(atlasDesignRefKey(valid), atlasDesignRefKey({ ...valid }));
});
