import assert from "node:assert/strict";
import test from "node:test";

import { requireArchitectEditorToken } from "./architect-security.mjs";

test("architect clients fail closed without an explicit editor capability", () => {
  for (const environment of [{}, { LIMINA_EDITOR_TOKEN: "fallback" }, { LIMINA_EDITOR_TOKEN: "x".repeat(129) }]) {
    assert.throws(() => requireArchitectEditorToken(environment, "architect-test"), /must be an explicit/);
  }
  assert.equal(
    requireArchitectEditorToken({ LIMINA_EDITOR_TOKEN: "A".repeat(32) }, "architect-test"),
    "A".repeat(32),
  );
});
