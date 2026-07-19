import crypto from "node:crypto";
import fs from "node:fs";
import {
  validateMultiRoomReviewAuthority,
  verifyMultiRoomReviewV4Closure,
} from "../src/render/building-multi-room-review-scene.ts";
import { portableAssetContentHash } from "../src/world/asset-content-hash.mjs";

const root =
    "assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-v3-1f375ec3abe1/review-v4-r1",
  authorityPath = `${root}/review-authority.json`,
  raw = (bytes: Uint8Array) => `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
  read = (path: string) => fs.readFileSync(path);
const assert = (value: unknown, message: string): asserts value => {
    if (!value) throw new Error(`p_fb4_v3_site_review FAIL: ${message}`);
  },
  authorityBytes = read(authorityPath),
  authority = validateMultiRoomReviewAuthority(JSON.parse(authorityBytes.toString("utf8")));
assert(
  raw(authorityBytes) === "sha256:e02a8b50070a6b0a131f1e6e54ddef6e67c9b5a23219bea87509bd9c06768217",
  "V4 authority bytes drifted",
);
verifyMultiRoomReviewV4Closure(authority, (path) => read(path));
assert(
  authority.schema === "limina.fb4-multi-room-review-authority/v4" &&
    authority.approval.humanDecision === "pending" &&
    authority.approval.visualApprovalClaimed === false &&
    authority.presentation.timestampQueriesEnabled === false,
  "V4 escaped guarded human-pending policy",
);
const evidence = JSON.parse(read(authority.siteReviewEvidence!.path).toString("utf8")),
  envelope = authority.siteReviewEnvelope!;
assert(
  evidence.renderingPerformed === false &&
    evidence.gpuUsed === false &&
    evidence.visualQualityClaimed === false &&
    evidence.siteFitClaimed === true,
  "site evidence has false visual/GPU claims",
);
assert(
  evidence.site.terrainRelief <= evidence.site.maximumTerrainRelief &&
    evidence.site.entranceSupport.terrainVariation <= 0.08,
  "site fit exceeded building authority",
);
const full = new Set(envelope.cameraChecks.fullSubjectViewIds),
  interior = new Set(envelope.cameraChecks.interiorViewIds);
for (const view of evidence.cameraEvidence.views) {
  assert(
    view.minimumTerrainClearanceM >= envelope.cameraChecks.minimumTerrainClearanceM,
    `${view.id} lost terrain LOS`,
  );
  if (full.has(view.id))
    assert(
      view.fullSubjectFramed === true &&
        view.rawProjectedHeightFraction <= envelope.cameraChecks.maximumFullSubjectHeightFraction,
      `${view.id} clips full subject`,
    );
  if (interior.has(view.id)) assert(view.interiorContained === true, `${view.id} left subject`);
}
for (const entry of [
  authority.articulationEvidence!,
  authority.siteReviewEnvelopeAuthority!,
  authority.siteReviewEvidence!,
  authority.semanticEvidence!,
]) {
  const exact = read(entry.path);
  assert(
    raw(exact) === entry.sha256 && portableAssetContentHash(exact) === entry.contentHash,
    `V4 evidence drifted: ${entry.path}`,
  );
}
console.log(
  "p_fb4_v3_site_review OK: current V4 exact proxy/envelope/site/semantic/tool/camera closure, full-subject framing, terrain LOS, vegetation reach, interior containment, timestamp-off human-pending",
);
