import test from "node:test";
import assert from "node:assert/strict";
import { requireCommittedMapSave } from "./map-save-freshness.js";

test("build actions require an acknowledged authoritative MapDoc commit", () => {
  const committed = { ok: true, mapsRev: "next", authoring: { head: { revision: 2 } } };
  assert.equal(requireCommittedMapSave(committed, "Compile"), committed);
  assert.throws(() => requireCommittedMapSave(undefined, "Compile"), (error) => (
    error.code === "ATLAS_MAP_SAVE_REQUIRED" && /freshly committed/.test(error.message)
  ));
  assert.throws(() => requireCommittedMapSave({ conflict: true }, "3D peek"), (error) => (
    error.code === "ATLAS_MAP_SAVE_CONFLICT" && /freshly committed/.test(error.message)
  ));
});
