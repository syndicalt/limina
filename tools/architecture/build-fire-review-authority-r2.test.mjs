import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { BUILDING_FIRE_REVIEW_FRAME_IDS, verifyBuildingFireReviewClosure } from "../../js/src/render/building-fire-review-authority.ts";
import { buildFireReviewAuthorityR2 } from "./build-fire-review-authority-r2.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

test("builds exact guarded volumetric fire r2 review closure", async () => {
  const { authority } = await buildFireReviewAuthorityR2({ repoRoot: ROOT, write: false });
  const closure = verifyBuildingFireReviewClosure(authority, (path) => readFileSync(resolve(ROOT, path)));
  assert.equal(authority.schema, "limina.building-fire-review-authority/v2");
  assert.equal(closure.contract.visuals.flameVolume.representation, "three-fire-derived-volume-raymarch/v1");
  assert.equal(authority.runtimeSources.volumetric.path, "js/src/render/building-fire-volumetric.ts");
  assert.deepEqual(authority.evidenceFrames.map(({ id }) => id), BUILDING_FIRE_REVIEW_FRAME_IDS);
  assert.equal(authority.metrics.volumeProof.minimumJaccardDistance, .01);
  assert.equal(authority.approvalPolicy.timestampQueriesEnabled, false);
});

test("r2 closure fails closed on volumetric source drift", async () => {
  const { authority } = await buildFireReviewAuthorityR2({ repoRoot: ROOT, write: false });
  assert.throws(() => verifyBuildingFireReviewClosure(authority, (path) => path === authority.runtimeSources.volumetric.path ? Buffer.from("drift") : readFileSync(resolve(ROOT, path))), /volumetric source bytes drifted/);
});
