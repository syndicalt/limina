import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import { finalizeProductionReviewCandidate } from "./finalize-production-review-candidate.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const OUTPUT = "assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653/package-artifact-candidate-reviewed-v5.json";

test("reviewed R1 candidate binds the exact guarded v5 authority, capture set, and five PNGs", async () => {
  const result = await finalizeProductionReviewCandidate({ write: false }), actual = JSON.parse(await readFile(resolve(ROOT, OUTPUT), "utf8"));
  assert.deepEqual(result.candidate, actual);
  assert.equal(actual.status, "candidate");
  assert.equal(actual.contentHash, "sha256:20063648f0c7aa7331b348e66bb714b419e2b8a1fa215045fb775d6c0ee3fb99");
  assert.equal(actual.metadata.review.authority.sha256, "sha256:df607673a570ee9e610b4b684d20646c65fcc0768bd74d6ee4c950fe04747ab4");
  assert.equal(actual.metadata.review.timestampQueriesEnabled, false);
  assert.equal(actual.evidence.length, 11);
  assert.deepEqual(actual.evidence.slice(-5).map(({ evidenceId }) => evidenceId.split("/").at(-1)), ["exterior-three-quarter", "entry-door-stairs", "interior-overall", "hearth-fire-seating", "dining-service"]);
});
