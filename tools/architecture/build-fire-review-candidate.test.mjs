import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  buildFireReviewCandidate,
  FIRE_R15_CAPTURE_PATH,
  FIRE_R4_R7_AUTHORITY_PATH,
  validateFireReviewCandidateInputs,
} from "./build-fire-review-candidate.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const AUTHORITY_ABSOLUTE = resolve(ROOT, FIRE_R4_R7_AUTHORITY_PATH);
const CAPTURE_ABSOLUTE = resolve(ROOT, FIRE_R15_CAPTURE_PATH);
const encode = (value) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);

async function fixture() {
  const [authorityBytes, captureBytes] = await Promise.all([readFile(AUTHORITY_ABSOLUTE), readFile(CAPTURE_ABSOLUTE)]);
  return { authorityBytes, captureBytes, capture: JSON.parse(captureBytes) };
}

function validate(value, capture = value.capture, authorityBytes = value.authorityBytes) {
  return validateFireReviewCandidateInputs({
    repoRoot: ROOT,
    authorityPath: AUTHORITY_ABSOLUTE,
    authorityBytes,
    capturePath: CAPTURE_ABSOLUTE,
    captureBytes: capture === value.capture ? value.captureBytes : encode(capture),
  });
}

test("CPU-only V1 builder binds exact fire-r4/r7 authority to all 11 r15 production PNGs and remains pending HITL", async () => {
  const value = await fixture(), { candidate } = validate(value);
  assert.equal(candidate.artifactId, "fire/functional-hall-house-v4/r4");
  assert.equal(candidate.kind, "fire-runtime");
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.metadata.humanDecision, "pending");
  assert.equal(candidate.metadata.authority.path, FIRE_R4_R7_AUTHORITY_PATH);
  assert.equal(candidate.metadata.capture.path, FIRE_R15_CAPTURE_PATH);
  assert.equal(candidate.metadata.capture.backend, "native-webgpu");
  assert.equal(candidate.metadata.capture.captureClass, "production-engine");
  assert.deepEqual(candidate.metadata.capture.timingPolicy, { gpuTimestampMode: "disabled", timestampQueriesEnabled: false });
  assert.equal(candidate.evidence.length, 11);
  assert.deepEqual(candidate.evidence.map(({ kind }) => kind), Array(11).fill("production-engine-png"));
  assert.deepEqual(candidate.evidence.map(({ contentHash }) => contentHash), value.capture.outputs.map(({ pngSha256 }) => pngSha256));
  assert.deepEqual(candidate.metadata.automatedEvidence, {
    exposure: { schema: "limina.cpu-channel-exposure/v1", outputs: 11, passed: true },
    silhouetteVariation: { schema: "limina.deterministic-flame-silhouette-variation/v1", passed: true },
    volumeProof: { schema: "limina.cpu-volumetric-fire-proof/v1", passed: true },
    reflectedLight: { schema: "limina.cpu-reflected-light-off-on/v1", passed: true },
  });
});

test("V1 builder fails closed on timestamp policy or any NVIDIA Xid phase", async () => {
  const value = await fixture();
  const timestampCapture = structuredClone(value.capture); timestampCapture.timingPolicy.timestampQueriesEnabled = true;
  assert.throws(() => validate(value, timestampCapture), /guarded native-webgpu production capture authority/);
  for (const phase of ["preflight", "live", "postflight"]) {
    const capture = structuredClone(value.capture); capture.guardEvidence[phase].xidObserved = true;
    assert.throws(() => validate(value, capture), /all three NVIDIA Xid guard phases/);
  }
});

test("V1 builder rejects incomplete, substituted, or drifted production PNG evidence", async () => {
  const value = await fixture();
  const incomplete = structuredClone(value.capture); incomplete.outputs.pop();
  assert.throws(() => validate(value, incomplete), /exactly 11 canonical outputs/);
  const substituted = structuredClone(value.capture); substituted.outputs[2].path = substituted.outputs[1].path;
  assert.throws(() => validate(value, substituted), /not the exact r15 production PNG/);
  const drifted = structuredClone(value.capture); drifted.outputs[2].pngSha256 = `sha256:${"0".repeat(64)}`;
  assert.throws(() => validate(value, drifted), /production PNG bytes drifted/);
});

test("V1 builder requires passing exposure, variation, volume, and reflected-light CPU proofs", async () => {
  const value = await fixture();
  const exposure = structuredClone(value.capture); exposure.outputs[2].exposureEvidence.red.p99 = 1;
  assert.throws(() => validate(value, exposure), /red exposure evidence failed/);
  const silhouette = structuredClone(value.capture); silhouette.silhouetteVariationEvidence.comparisons[0].jaccardDistance = 0;
  assert.throws(() => validate(value, silhouette), /silhouette-variation evidence failed/);
  const volume = structuredClone(value.capture); volume.volumeProofEvidence.views[0].leakFraction = .5;
  assert.throws(() => validate(value, volume), /volumetric multi-view evidence failed/);
  const reflected = structuredClone(value.capture); reflected.reflectedLightEvidence.positivelyLitPixels = 0;
  assert.throws(() => validate(value, reflected), /passing reflected-light evidence/);
});

test("V1 candidate writer is append-only and never records a decision", async () => {
  const directory = await mkdtemp(resolve(ROOT, "tools/architecture/.v1-fire-candidate-fixture-"));
  try {
    const outputPath = resolve(directory, "review-candidate.json");
    const { candidate } = await buildFireReviewCandidate({ repoRoot: ROOT, outputPath });
    assert.equal(candidate.status, "candidate");
    assert.equal(candidate.metadata.humanDecision, "pending");
    assert.equal("approval" in candidate.metadata, false);
    await assert.rejects(buildFireReviewCandidate({ repoRoot: ROOT, outputPath }), /EEXIST/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
