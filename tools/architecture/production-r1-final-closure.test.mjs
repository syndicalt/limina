import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  assertBuildingArtifactReviewable,
  buildingArtifactInvalidation,
  validateBuildingHitlDecision,
  validateBuildingStageArtifact,
} from "../../js/src/assets/staged-building-pipeline.mjs";
import { finalizeProductionReviewCandidate } from "./finalize-production-review-candidate.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const BASE = "assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653";
const CAPTURE = "assets/qc/internal/production-r1/r1-v5-spark-20260716/capture-evidence.json";
const CLOSURE = "art-direction/functional-hall-house-v4-r1-closure.json";
const paths = {
  candidate: `${BASE}/package-artifact-candidate-reviewed-v5.json`,
  approved: `${BASE}/package-artifact-approved-v6.json`,
  decision: `${BASE}/production-review-decision-approve-v5.json`,
  authority: `${BASE}/production-review-authority-v5.json`,
  manifest: `${BASE}/package-manifest-mount-verified.json`,
  glb: `${BASE}/functional-hall-house-v4-production.glb`,
};
const dependencyPaths = [
  "assets/buildings/authoring/functional-hall-house-v4/shell-r4/shell-artifact-approved.json",
  "assets/buildings/authoring/functional-hall-house-v4/material-r2/material-palette-artifact-approved.json",
  "assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-plan-artifact-approved.json",
  "assets/buildings/authoring/functional-hall-house-v4/interior-r2/interior-plan-artifact-approved.json",
  "assets/buildings/authoring/functional-hall-house-v4/interior-r3/interior-plan-artifact-approved.json",
  "assets/buildings/authoring/functional-hall-house-v4/interior-r4/interior-plan-artifact-approved.json",
  "assets/buildings/authoring/furniture/dining-table-v1/approved-artifact.json",
  "assets/buildings/authoring/furniture/dining-chair-v1-r4/approved-artifact.json",
  "assets/buildings/authoring/furniture/hearth-settle-v3-r6/approved-artifact.json",
  "assets/buildings/authoring/furniture/service-storage-v1-r1/approved-artifact.json",
  "assets/buildings/authoring/functional-hall-house-v4/composition-r3/composition-artifact-approved.json",
  "assets/buildings/authoring/functional-hall-house-v4/fire-r4/fire-runtime-artifact-approved-r15.json",
];
const expectedImages = new Map([
  ["exterior-three-quarter", "sha256:caacd5a9f15a50b6c433b25ab8f5cbfce805d8b23f8257d02521d6aa03061606"],
  ["entry-door-stairs", "sha256:5e05763c49e997ee297a3095c728ac536e84ae787639cb5edc9fe37b0ddaa895"],
  ["interior-overall", "sha256:e76417b2542ecce00a4748a18da140653ea90781765212204fee7c1859bfe984"],
  ["hearth-fire-seating", "sha256:c54c5c178ecdd72842f4e3384540a2f44eda6900e2072c61ed29a4a8b97fe898"],
  ["dining-service", "sha256:f88eb80cecfe2707db07674ac8a684c33f80e7377e2e7bf3640a2897be3da3b8"],
]);
const bytes = path => readFile(resolve(ROOT, path));
const json = async path => JSON.parse(await bytes(path));
const sha = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;

test("approved R1 package closes exact editable, functional, native-rendered evidence", async () => {
  const [candidateRaw, approvedRaw, decisionRaw, authorityRaw, captureRaw, closure, manifest, dependencies] = await Promise.all([
    bytes(paths.candidate), bytes(paths.approved), bytes(paths.decision), bytes(paths.authority), bytes(CAPTURE), json(CLOSURE),
    json(paths.manifest),
    Promise.all(dependencyPaths.map(json)),
  ]);
  const candidate = validateBuildingStageArtifact(JSON.parse(candidateRaw));
  const approved = validateBuildingStageArtifact(JSON.parse(approvedRaw));
  const decision = validateBuildingHitlDecision(JSON.parse(decisionRaw));
  const capture = JSON.parse(captureRaw);

  assert.deepEqual((await finalizeProductionReviewCandidate({ write: false })).candidate, candidate);
  assertBuildingArtifactReviewable(candidate, decision, [...dependencies, candidate]);
  assert.deepEqual(buildingArtifactInvalidation([...dependencies, approved]), []);
  assert.equal(approved.kind, "production-package");
  assert.equal(approved.status, "approved");
  assert.equal(approved.contractHash, candidate.contractHash);
  assert.equal(approved.contentHash, candidate.contentHash);
  assert.equal(approved.contentHash, "sha256:20063648f0c7aa7331b348e66bb714b419e2b8a1fa215045fb775d6c0ee3fb99");
  assert.equal(approved.metadata.humanDecision, "approved");
  assert.equal(approved.metadata.visualApprovalClaimed, true);
  assert.equal(approved.metadata.review.status, "approved");
  assert.equal(approved.metadata.review.humanDecision, "approved");
  assert.equal(approved.metadata.review.visualApprovalClaimed, true);
  assert.equal(approved.metadata.review.decision.sha256, sha(decisionRaw));
  assert.equal(approved.metadata.approval.sha256, sha(decisionRaw));
  assert.equal(decision.decision, "approve");
  assert.equal(decision.reviewer, "user");
  assert.equal(decision.evidenceBindings.length, 11);
  assert.equal(closure.schema, "limina.functional-building-production-closure/v1");
  assert.equal(closure.milestone, "FB-2");
  assert.equal(closure.status, "approved-closed");
  assert.equal(closure.productionPackage.path, paths.approved);
  assert.equal(closure.productionPackage.sha256, sha(approvedRaw));
  assert.equal(closure.productionPackage.contentHash, approved.contentHash);
  assert.equal(closure.review.candidate.sha256, sha(candidateRaw));
  assert.equal(closure.review.decision.sha256, sha(decisionRaw));
  assert.equal(closure.review.authority.sha256, sha(authorityRaw));
  assert.equal(closure.review.capture.sha256, sha(captureRaw));
  assert.equal(closure.regressionAuthority.fixed, true);
  assert.equal(closure.regressionAuthority.fixtureFor, "FB-3");
  assert.equal(closure.regressionAuthority.renderedChangesRequireNewHitlApproval, true);

  assert.equal(approved.metadata.review.authority.sha256, sha(authorityRaw));
  assert.equal(approved.metadata.review.capture.sha256, sha(captureRaw));
  assert.equal(capture.backend, "native-webgpu");
  assert.equal(capture.captureClass, "production-engine");
  assert.equal(capture.timingPolicy.timestampQueriesEnabled, false);
  assert.equal(capture.timingPolicy.gpuTimestampMode, "disabled");
  assert.equal(capture.adapter.description, "NVIDIA GB10");
  for (const phase of ["preflight", "live", "postflight"]) assert.equal(capture.guardEvidence[phase].xidObserved, false);
  assert.equal(capture.reviewBridge.bindHost, "127.0.0.1");
  assert.equal(capture.reviewBridge.public, false);
  assert.deepEqual(new Map(capture.outputs.map(output => [output.id, output.pngSha256])), expectedImages);
  for (const output of capture.outputs) {
    assert.equal(output.width, 1920); assert.equal(output.height, 1080);
    assert.equal(sha(await bytes(output.path)), output.pngSha256);
    assert.equal((await stat(resolve(ROOT, output.path))).mode & 0o777, 0o600);
    assert.ok(output.renderSubmission.drawCalls >= 513);
    assert.ok(output.renderSubmission.triangles >= 115_000_000);
  }

  assert.equal(manifest.composition.editableBlend.path.endsWith(".blend"), true);
  assert.equal(sha(await bytes(manifest.composition.editableBlend.path)), manifest.composition.editableBlend.sha256);
  assert.deepEqual(manifest.closure.counts, { semantics: 654, colliders: 123, sockets: 12, instances: 7 });
  assert.equal(manifest.runtime.productionGlb.engineHash, "sha256:d228705fedbcf0cb7b92cc0b14ecf77e87c89e55fdbba3b6c8ea1a8f25948f69");
  assert.equal(sha(await bytes(paths.glb)), approved.contentHash);
  assert.equal((await stat(resolve(ROOT, paths.glb))).size, 16_495_604);
});
