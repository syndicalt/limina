import assert from "node:assert/strict";
import test from "node:test";
import {
  readAuthorityManifest,
  validateBehavioralAuthorityManifest,
} from "./static-behavioral-authorities.mjs";

test("the checked-in manifest covers the discovered source-text inventory", async () => {
  const result = await validateBehavioralAuthorityManifest(await readAuthorityManifest());
  assert.equal(result.staticTests.length, 13);
  assert.ok(result.chromium.length >= 6);
});

test("falsifiability: omitting one source-text test fails closed", async () => {
  const manifest = structuredClone(await readAuthorityManifest());
  manifest.entries.pop();
  await assert.rejects(() => validateBehavioralAuthorityManifest(manifest), /coverage mismatch; missing=/);
});

test("falsifiability: static-on-static authority laundering is rejected", async () => {
  const manifest = structuredClone(await readAuthorityManifest());
  manifest.entries[0].authorities = [{ kind: "node-test", path: manifest.entries[1].staticTest }];
  await assert.rejects(() => validateBehavioralAuthorityManifest(manifest), /another source-text test instead of behavior/);
});

test("falsifiability: a Chromium twin without CPU-only launch policy is rejected", async () => {
  const manifest = structuredClone(await readAuthorityManifest());
  manifest.entries[0].authorities = [{ kind: "chromium-live", path: "editor/test/play_ui_browser.test.cjs" }];
  await assert.rejects(() => validateBehavioralAuthorityManifest(manifest), /does not pin CPU-only Chromium/);
});
