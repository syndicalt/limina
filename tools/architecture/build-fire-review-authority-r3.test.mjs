import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { verifyBuildingFireReviewClosure } from "../../js/src/render/building-fire-review-authority.ts";
import { buildFireReviewAuthorityR3 } from "./build-fire-review-authority-r3.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

test("builds exact fire-r3 volumetric review closure without weakening evidence", async () => {
  const { authority } = await buildFireReviewAuthorityR3({ repoRoot: ROOT, write: false });
  assert.equal(authority.schema, "limina.building-fire-review-authority/v3"); assert.equal(authority.fireStage.contract.revision, 3);
  assert.equal(authority.metrics.exposure.maxClippedPixelFraction, .0025); assert.equal(authority.metrics.exposure.maxChannelP99, .98);
  assert.equal(authority.metrics.volumeProof.required, true); assert.equal(authority.approvalPolicy.timestampQueriesEnabled, false);
  verifyBuildingFireReviewClosure(authority, (path) => new Uint8Array(readFileSync(resolve(ROOT, path))));
});

test("writes authority append-only", async (t) => {
  const directory = await mkdtemp(join(ROOT, ".tmp-fire-review-r3-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const output = relative(ROOT, join(directory, "authority.json"));
  await buildFireReviewAuthorityR3({ repoRoot: ROOT, paths: { output }, write: true });
  await assert.rejects(buildFireReviewAuthorityR3({ repoRoot: ROOT, paths: { output }, write: true }), /EEXIST/);
});
