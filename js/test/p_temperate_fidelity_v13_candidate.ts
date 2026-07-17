import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  evaluateVisualFidelityEvidence,
  type VisualFidelityEvidence,
} from "../src/render/visual-fidelity-floor.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_temperate_fidelity_v13_candidate FAIL: ${message}`);
}

const root = new URL("../../", import.meta.url);
const review = JSON.parse(readFileSync(new URL("art-direction/temperate-fidelity-v13-candidate-review.json", root), "utf8"));
const artifact = readFileSync(new URL(`assets/${review.artifact.assetId}`, root));
const digest = createHash("sha256").update(artifact).digest("hex");
assert(review.schema === "limina.visual-fidelity-candidate-review/v1", "candidate review schema drifted");
assert(artifact.byteLength === review.artifact.byteLength && digest === review.artifact.sha256,
  "human-reviewed v13 artifact bytes drifted");
assert(review.publication.manifestHash === "sha256:3728ab6b8a12009e0911ebb55673c18468d5266ab852655f168e66be23e1baaa"
  && review.publication.contentClosureHash === "sha256:f0fe936cff9bcad5a50627efce951bc85408887deb5346717eafabec03c0b6c4"
  && review.publication.contentStatus === "candidate", "review no longer identifies the exact candidate publication");
assert(review.decision.status === "human-approved-candidate" && review.decision.releasePassed === false,
  "browser candidate review was mislabeled as a production release");
assert(review.decision.deferredPolish.includes("flow-driven foam maps"), "accepted water polish deferral was lost");
assert(review.performanceHardening.baseline.totalMs === 402072.4
  && review.performanceHardening.optimized.totalMs === 45989.9
  && review.performanceHardening.result.endToEndSpeedup > 8.7
  && review.performanceHardening.result.sceneIdentity.grassBlades === 886649
  && review.performanceHardening.result.nvidiaXidObserved === false,
"measured v13 browser-path hardening evidence drifted or overstated scene identity");
assert(review.performanceHardening.status === "non-release-browser-evidence"
  && /does not satisfy native-backend/.test(review.performanceHardening.releaseNote),
"browser-path speedup was mislabeled as native release evidence");

const evaluation = evaluateVisualFidelityEvidence(review.evidence as VisualFidelityEvidence);
assert(!evaluation.eligibleForHumanReview && !evaluation.releasePassed,
  "non-native v13 candidate incorrectly passed the production release contract");
for (const expected of ["native production renderer", "visualRegression", "lifecycle", "targetHardwarePerformance"]) {
  assert(evaluation.violations.some((entry) => entry.includes(expected)), `release evaluation lost blocker '${expected}'`);
}

console.log("p_temperate_fidelity_v13_candidate OK: exact v13 bytes retain owner approval while native, regression, lifecycle, and performance release blockers remain explicit");
