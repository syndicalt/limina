import crypto from "node:crypto";
import fs from "node:fs";
import {
  resolveBuildingReviewState,
  validateBuildingReviewOutcome,
  verifyBuildingReviewLedger,
  verifyBuildingReviewOutcomeClosure,
} from "../src/assets/building-review-outcome.ts";
import { portableAssetContentHash } from "../src/world/asset-content-hash.mjs";

const candidateRoot = "assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-d0ca1e327841";
const outcomePath =
  "assets/buildings/authoring/functional-hall-house-v4/review-outcomes/fb4-d0ca1e327841-r1-central-rejected.json";
const read = (path: string) => fs.readFileSync(path);
const assert = (value: unknown, message: string): asserts value => {
  if (!value) throw new Error(`p_building_review_outcome FAIL: ${message}`);
};
const sha256 = (bytes: Uint8Array) => crypto.createHash("sha256").update(bytes).digest("hex");
const manifestBytes = read(`${candidateRoot}/candidate-manifest.json`);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const outcomeBytes = read(outcomePath),
  outcome = verifyBuildingReviewOutcomeClosure(JSON.parse(outcomeBytes.toString("utf8")), read);

// Byte pins: the candidate manifest and the review outcome are FROZEN records — the
// status/decision assertions below would otherwise be self-consistency (regenerating
// either JSON forges the verdict). Re-pin ONLY with an explicit owner re-decision.
assert(
  sha256(manifestBytes) === "1eeccda410009e68be17dbada80a5c5568caf8f44f7bee3fbe095676a50322ad",
  "candidate manifest bytes drifted from the pinned record",
);
assert(
  sha256(outcomeBytes) === "08f4d1b9a94278cd747b3bf12d81ee204b2e0a9009529daebf49da6b889d6767",
  "review outcome bytes drifted from the pinned record",
);
const ledger = verifyBuildingReviewLedger([{ path: outcomePath, bytes: outcomeBytes }], read),
  state = resolveBuildingReviewState(manifest, ledger);
assert(
  manifest.status === "cpu-verified-human-pending" && manifest.gpuCaptureRun === false,
  "immutable build-time manifest unexpectedly changed",
);
assert(
  state.buildStatus === "cpu-verified-human-pending" && state.reviewStatus === "rejected-before-hitl",
  "discovery trusted stale build-time status over append-only review outcome",
);
assert(
  state.outcome?.event.kind === "central-visual-review" &&
    state.outcome.event.record.path.endsWith("CENTRAL-REVIEW.json"),
  "resolved state lost exact central decision authority",
);
assert(
  outcome.subject.captureProvenance === null && !state.hitlEligible,
  "historic capture provenance gap was hidden or allowed into HITL",
);

const currentRoot = "assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-1b4470041e01",
  currentOutcomePath =
    "assets/buildings/authoring/functional-hall-house-v4/review-outcomes/fb4-1b4470041e01-r1-central-rejected.json",
  currentOutcomeBytes = read(currentOutcomePath),
  currentOutcome = verifyBuildingReviewOutcomeClosure(JSON.parse(currentOutcomeBytes.toString("utf8")), read),
  currentManifest = JSON.parse(read(`${currentRoot}/candidate-manifest.json`).toString("utf8")),
  currentLedger = verifyBuildingReviewLedger([{ path: currentOutcomePath, bytes: currentOutcomeBytes }], read),
  currentState = resolveBuildingReviewState(currentManifest, currentLedger);
assert(
  sha256(currentOutcomeBytes) === "2f6b4e99629a59cf03f314e50c458e945e500093ae227a69e1b2c0c11664206b",
  "current review outcome bytes drifted from the pinned record",
);
assert(
  currentOutcome.subject.captureProvenance?.coverage === "complete" &&
    currentState.reviewStatus === "rejected-before-hitl" &&
    !currentState.hitlEligible,
  "complete capture provenance incorrectly overrode the central visual-floor rejection",
);

const forged = Buffer.from(
    `${JSON.stringify({ coverage: "complete", captureEvidence: currentOutcome.subject.captureEvidence })}\n`,
  ),
  forgedPath = currentOutcome.subject.captureProvenance!.path,
  forgedEntry = {
    ...currentOutcome,
    subject: {
      ...currentOutcome.subject,
      captureProvenance: {
        ...currentOutcome.subject.captureProvenance!,
        sha256: `sha256:${sha256(forged)}`,
        contentHash: portableAssetContentHash(forged),
      },
    },
  };
let forgedRejected = false;
try {
  verifyBuildingReviewOutcomeClosure(forgedEntry, (path) => (path === forgedPath ? forged : read(path)));
} catch {
  forgedRejected = true;
}
assert(forgedRejected, "self-declared complete provenance bypassed the exact FB-4 provenance validator");

const r4Root = "assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-v3-a11f21423016",
  r4OutcomePath =
    "assets/buildings/authoring/functional-hall-house-v4/review-outcomes/fb4-a11f21423016-r4-central-passed.json",
  r4OutcomeBytes = read(r4OutcomePath),
  r4Outcome = verifyBuildingReviewOutcomeClosure(JSON.parse(r4OutcomeBytes.toString("utf8")), read),
  r4Manifest = JSON.parse(read(`${r4Root}/candidate-manifest.json`).toString("utf8")),
  r4Ledger = verifyBuildingReviewLedger([{ path: r4OutcomePath, bytes: r4OutcomeBytes }], read),
  r4State = resolveBuildingReviewState(r4Manifest, r4Ledger);
assert(
  sha256(r4OutcomeBytes) === "de270f66ecb77126e5a86e286131f22d2c5f256d9fdda13898154077caef1570",
  "R4 central-pass outcome bytes drifted from the pinned record",
);
assert(
  r4Outcome.subject.captureProvenance?.coverage === "complete" &&
    r4State.reviewStatus === "central-pass" &&
    r4State.hitlEligible,
  "exact R4 capture provenance and central pass did not open the HITL gate",
);
const r4RevisePath =
    "assets/buildings/authoring/functional-hall-house-v4/review-outcomes/fb4-a11f21423016-r4-hitl-revise.json",
  r4ReviseBytes = read(r4RevisePath),
  r4ReviewedLedger = verifyBuildingReviewLedger(
    [
      { path: r4OutcomePath, bytes: r4OutcomeBytes },
      { path: r4RevisePath, bytes: r4ReviseBytes },
    ],
    read,
  ),
  r4ReviewedState = resolveBuildingReviewState(r4Manifest, r4ReviewedLedger);
assert(
  sha256(r4ReviseBytes) === "2eb5499bcc9782480d6fcca58add41957f542b94fc121601bc8cf38edcfae3b1",
  "R4 HITL-revise outcome bytes drifted from the pinned record",
);
assert(
  r4ReviewedState.reviewStatus === "rejected" &&
    !r4ReviewedState.hitlEligible &&
    r4ReviewedState.outcome?.event.kind === "hitl-decision",
  "exact owner revision did not close the R4 release gate",
);

const approvedRoot = "assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-v3-1f375ec3abe1",
  approvedCentralPath =
    "assets/buildings/authoring/functional-hall-house-v4/review-outcomes/fb4-1f375ec3abe1-v4-r1-central-passed.json",
  approvedHitlPath =
    "assets/buildings/authoring/functional-hall-house-v4/review-outcomes/fb4-1f375ec3abe1-v4-r1-hitl-approved.json",
  approvedCentralBytes = read(approvedCentralPath),
  approvedHitlBytes = read(approvedHitlPath),
  approvedManifest = JSON.parse(read(`${approvedRoot}/candidate-manifest.json`).toString("utf8")),
  approvedLedger = verifyBuildingReviewLedger(
    [
      { path: approvedCentralPath, bytes: approvedCentralBytes },
      { path: approvedHitlPath, bytes: approvedHitlBytes },
    ],
    read,
  ),
  approvedState = resolveBuildingReviewState(approvedManifest, approvedLedger);
assert(
  sha256(approvedCentralBytes) === "b14215c408554690e45e2375476331844fa10fda42929f896ed92b2049edc46c",
  "V4 R1 central-pass outcome bytes drifted from the owner-approved record",
);
assert(
  sha256(approvedHitlBytes) === "3856d6a9b03fad5cf82e838b587ff44be1d5465fdfd55fca06b4c3fb6f7a55ac",
  "V4 R1 HITL approval bytes drifted from the owner-approved record",
);
assert(
  approvedLedger.map((entry) => entry.decision).join(",") === "central-pass,approved" &&
    approvedState.reviewStatus === "approved" &&
    !approvedState.hitlEligible &&
    approvedState.outcome?.event.kind === "hitl-decision",
  "exact V4 R1 owner approval did not resolve as the terminal candidate state",
);

const base = JSON.parse(read(outcomePath).toString("utf8"));
for (const mutation of [
  { ...base, sequence: 2 },
  { ...base, subject: { ...base.subject, candidateId: "functional-hall-house/fb4/wrong" } },
  { ...base, event: { ...base.event, record: { ...base.event.record, sha256: "sha256:" + "0".repeat(64) } } },
]) {
  let rejected = false;
  try {
    const parsed = validateBuildingReviewOutcome(mutation);
    verifyBuildingReviewOutcomeClosure(parsed, read);
  } catch {
    rejected = true;
  }
  assert(rejected, "review outcome mutation did not fail closed");
}
console.log(
  "p_building_review_outcome OK: immutable candidates resolve exact central/HITL outcomes; complete provenance is schema/subject/output validated; rejected R4 stays closed and exact V4 R1 resolves owner-approved",
);
