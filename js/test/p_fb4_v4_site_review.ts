import assert from "node:assert/strict";
import fs from "node:fs";
import {
  assertMultiRoomReviewCaptureReady,
  resolveFb4V4ReviewDoorPosePlan,
  validateMultiRoomReviewAuthority,
  verifyMultiRoomReviewV4Closure,
} from "../src/render/building-multi-room-review-scene.ts";
import { verifyBuildingSemanticEvidence } from "../src/render/building-semantic-evidence.ts";

const root = "assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-v3-1f375ec3abe1/review-v4-r1";
const read = (path: string): Uint8Array => new Uint8Array(fs.readFileSync(path));
const authority = assertMultiRoomReviewCaptureReady(validateMultiRoomReviewAuthority(JSON.parse(fs.readFileSync(`${root}/review-authority.json`, "utf8"))));

verifyMultiRoomReviewV4Closure(authority, read);
assert.equal(authority.candidate.candidateId, "functional-hall-house/fb4/1f375ec3abe1");
assert.equal(authority.topologyProof.expectedAnchors, 6);
assert.ok(authority.evidenceViews.every((view) => view.camera.fovDeg <= 85), "mechanical diagnostic camera leaked into the visual HITL set");
const semantic = verifyBuildingSemanticEvidence(JSON.parse(fs.readFileSync(authority.semanticEvidence.path, "utf8")), read);
assert.equal(semantic.mechanicalVerdict, "pass");
assert.equal(semantic.reviewBoundary.rendering, false);
assert.equal(semantic.reviewBoundary.gpu, false);
assert.equal(semantic.reviewBoundary.visualQuality, false);
assert.equal(semantic.reviewBoundary.humanDecision, "pending");
const poses = resolveFb4V4ReviewDoorPosePlan(authority, read);
assert.deepEqual(poses.map((entry) => entry.reviewViewId), authority.evidenceViews.map((entry) => entry.id));
assert.deepEqual(poses.filter((entry) => entry.openDoorIds.length > 0), [{ reviewViewId: "upper-room", openDoorIds: ["door/landing-front"] }]);
const site = JSON.parse(fs.readFileSync(authority.siteReviewEvidence.path, "utf8"));
assert.equal(site.verdict, "pass");
assert.equal(site.renderingPerformed, false);
assert.equal(site.gpuUsed, false);
assert.equal(site.visualQualityClaimed, false);
assert.equal(site.humanDecision, "pending");
assert.equal(site.inputs.semanticEvidence.sha256, authority.semanticEvidence.sha256);

console.log("p_fb4_v4_site_review OK: exact current candidate, six-anchor semantic/site/tool closure, bounded visual cameras, and per-view engine door poses are CPU-only human-pending");
