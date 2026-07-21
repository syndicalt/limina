import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import sharp from "sharp";

import { validateFb4CaptureProvenance } from "../src/render/fb4-capture-provenance.ts";
import { portableAssetContentHash } from "../src/world/asset-content-hash.mjs";

const CAPTURE_ROOT = "assets/qc/internal/fb4-multi-room/program-v3-1f375ec3abe1-v4-r1";
const PROVENANCE_PATH = `${CAPTURE_ROOT}/capture-provenance.json`;
const EXPECTED_CANDIDATE = "functional-hall-house/fb4/1f375ec3abe1";
const EXPECTED_VIEW_IDS = Object.freeze([
  "exterior-entry",
  "exterior-rear",
  "gable-elevation",
  "frame-entry-window-detail",
  "ground-rooms-passage",
  "stair-opening",
  "upper-room",
  "lod-25m",
]);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const read = (path: string): Buffer => fs.readFileSync(path);
const rawHash = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const assertExact = (entry: { path: string; sha256: string; contentHash: string; bytes?: number }, label: string): Buffer => {
  const bytes = read(entry.path);
  assert.equal(rawHash(bytes), entry.sha256, `${label} raw SHA-256 drifted: ${entry.path}`);
  assert.equal(portableAssetContentHash(bytes), entry.contentHash, `${label} engine content hash drifted: ${entry.path}`);
  if (entry.bytes !== undefined) assert.equal(bytes.byteLength, entry.bytes, `${label} byte length drifted: ${entry.path}`);
  return bytes;
};

const provenance = validateFb4CaptureProvenance(JSON.parse(read(PROVENANCE_PATH).toString("utf8")));
assert.equal(provenance.subject.candidateId, EXPECTED_CANDIDATE);
assert.equal(provenance.execution.platform.arch, "arm64");
assert.deepEqual(provenance.execution.timestampEnvironmentKeys, []);
assert.equal(provenance.gpuSafety.timestampQueriesEnabled, false);
assert.equal(provenance.gpuSafety.xidObserved, false);

const evidenceBytes = assertExact(provenance.captureEvidence, "capture evidence");
const manifestBytes = assertExact(provenance.subject.manifest, "candidate manifest");
assertExact(provenance.subject.glb, "production GLB");
const authorityBytes = assertExact(provenance.subject.reviewAuthority, "review authority");
assertExact(provenance.environment.authority, "environment authority");
assertExact(provenance.environment.runtimeBundle, "environment runtime bundle");
assertExact(provenance.execution.binary, "native runtime binary");

const sourcePaths = new Set(provenance.execution.sources.map((entry) => entry.path));
for (const entryPath of provenance.execution.entrySources) {
  assert(sourcePaths.has(entryPath), `capture entry source is absent from the complete producer closure: ${entryPath}`);
}
for (const source of provenance.execution.sources) assertExact(source, "capture producer source");

assert.equal(typeof Bun, "object", "the recorded capture orchestrator must be verified under Bun");
assert.equal(Bun.version, provenance.execution.orchestrator.version, "capture Bun version drifted");
const bunBytes = read(process.execPath);
assert.equal(bunBytes.byteLength, provenance.execution.orchestrator.bytes, "capture Bun byte length drifted");
assert.equal(rawHash(bunBytes), provenance.execution.orchestrator.sha256, "capture Bun executable drifted");

const manifest = JSON.parse(manifestBytes.toString("utf8"));
const authority = JSON.parse(authorityBytes.toString("utf8"));
const evidence = JSON.parse(evidenceBytes.toString("utf8"));
assert.equal(manifest.candidateId, EXPECTED_CANDIDATE);
assert.equal(authority.candidate.candidateId, EXPECTED_CANDIDATE);
assert.equal(authority.approval.humanDecision, "pending");
assert.equal(authority.approval.visualApprovalClaimed, false);
assert.equal(authority.approval.nonEngineApprovalProhibited, true);
assert.equal(authority.approval.renderer, "limina-production-native-engine");
assert.equal(evidence.schema, "limina.fb4-multi-room-native-review-set/v1");
assert.equal(evidence.backend, "native-webgpu");
assert.equal(evidence.captureClass, "production-engine");
assert.equal(evidence.candidate.candidateId, EXPECTED_CANDIDATE);
assert.equal(evidence.timingPolicy.gpuTimestampMode, "disabled");
assert.equal(evidence.timingPolicy.timestampQueriesEnabled, false);
assert.equal(evidence.guardEvidence.preflight.xidObserved, false);
assert.equal(evidence.guardEvidence.live.xidObserved, false);
assert.equal(evidence.guardEvidence.live.redundantPollMs, 250);
assert.equal(evidence.guardEvidence.postflight.xidObserved, false);
assert.deepEqual(evidence.reviewBridge, {
  artifactDirectory: ".limina/review-artifacts",
  bindHost: "127.0.0.1",
  public: false,
  staged: false,
  candidatePrefix: "fb4-1f375ec3abe1-v4-r1",
});
assert.equal(evidence.lifecycle.disposed, true);
assert.equal(evidence.lifecycle.afterDisposeEntities, evidence.lifecycle.baselineEntities);

assert.deepEqual(evidence.captures.map((entry: any) => entry.id), EXPECTED_VIEW_IDS);
assert.deepEqual(provenance.outputs.map((entry) => entry.id), EXPECTED_VIEW_IDS);
assert.deepEqual(evidence.outputs.map((entry: any) => entry.id), EXPECTED_VIEW_IDS);
for (const capture of evidence.captures) {
  assert.equal(capture.renderSubmission.scope, "single-production-frame-all-passes", `${capture.id} lacks whole-scene render telemetry`);
  assert.equal(capture.renderSubmission.instanceAccounting, "full-draw-instance-count", `${capture.id} instance accounting drifted`);
  assert(capture.renderSubmission.drawCalls > 1, `${capture.id} draw-call telemetry is not credible`);
  assert(capture.renderSubmission.triangles > 1, `${capture.id} triangle telemetry is not credible`);
  assert.equal(capture.rendererResources.scope, "renderer-live-after-production-frame", `${capture.id} lacks whole-scene resource telemetry`);
}

for (const output of provenance.outputs) {
  const evidenceOutput = evidence.outputs.find((entry: any) => entry.id === output.id);
  assert(evidenceOutput, `capture evidence omitted ${output.id}`);
  for (const key of ["path", "width", "height", "pngSha256", "pngByteLength", "rgbaContentHash"] as const) {
    assert.equal(evidenceOutput[key], output[key], `${output.id} ${key} drifted between evidence and provenance`);
  }
  const png = read(output.path);
  assert.equal(png.byteLength, output.pngByteLength, `${output.id} PNG byte length drifted`);
  assert.equal(rawHash(png), output.pngSha256, `${output.id} PNG hash drifted`);
  assert(png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), `${output.id} is not a PNG`);
  assert.equal(png.readUInt32BE(16), output.width, `${output.id} PNG width drifted`);
  assert.equal(png.readUInt32BE(20), output.height, `${output.id} PNG height drifted`);
  const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, output.width, `${output.id} decoded width drifted`);
  assert.equal(decoded.info.height, output.height, `${output.id} decoded height drifted`);
  assert.equal(decoded.info.channels, 4, `${output.id} decoded channel count drifted`);
  assert.equal(portableAssetContentHash(decoded.data), output.rgbaContentHash, `${output.id} decoded RGBA hash drifted`);
}

console.log("p_fb4_v4_capture_closure OK: pending 1f375ec3abe1 review authority, ARM64 producer, guarded whole-scene telemetry, and eight exact PNG/RGBA artifacts close independently");
