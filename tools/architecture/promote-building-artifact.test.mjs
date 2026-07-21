import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  validateBuildingStageArtifact,
  validateBuildingHitlDecision,
  assertBuildingArtifactReviewable,
} from "../../js/src/assets/staged-building-pipeline.mjs";
const candidate = validateBuildingStageArtifact(
    JSON.parse(
      await readFile(
        new URL(
          "../../assets/buildings/authoring/furniture/hearth-settle-v2-r2/review-candidate.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  ),
  decision = validateBuildingHitlDecision(
    JSON.parse(
      await readFile(
        new URL(
          "../../assets/buildings/authoring/furniture/hearth-settle-v2-r2/review-decision-approve.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
assert.equal(decision.decision, "approve");
assertBuildingArtifactReviewable(candidate, decision, [candidate]);
assert.equal(candidate.contentHash, "sha256:86d43554df9ccac491f888d2059f9d4543ac98ee9e07221f51bf0736e1766453");
assert.equal(decision.evidenceHashes.length, 5);
console.log("approved settle promotion inputs are exact and reviewable");
