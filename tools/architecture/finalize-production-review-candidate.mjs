import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const BASE = "assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653";
const DEFAULTS = Object.freeze({
  candidate: `${BASE}/package-artifact-candidate-mount-verified.json`,
  authority: `${BASE}/production-review-authority-v5.json`,
  capture: "assets/qc/internal/production-r1/r1-v5-spark-20260716/capture-evidence.json",
  output: `${BASE}/package-artifact-candidate-reviewed-v5.json`,
});
const IDS = Object.freeze(["exterior-three-quarter", "entry-door-stairs", "interior-overall", "hearth-fire-seating", "dining-service"]);
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const portable = (path) => relative(ROOT, path).split(sep).join("/");
const load = async (path) => { const absolute = resolve(ROOT, path), bytes = await readFile(absolute); return { absolute, path: portable(absolute), bytes, sha256: sha(bytes) }; };

export async function finalizeProductionReviewCandidate({ candidatePath = DEFAULTS.candidate, authorityPath = DEFAULTS.authority, capturePath = DEFAULTS.capture, outputPath = DEFAULTS.output, write = true } = {}) {
  const [candidateFile, authorityFile, captureFile] = await Promise.all([load(candidatePath), load(authorityPath), load(capturePath)]);
  const candidate = validateBuildingStageArtifact(JSON.parse(candidateFile.bytes)), authority = JSON.parse(authorityFile.bytes), capture = JSON.parse(captureFile.bytes);
  if (candidate.kind !== "production-package" || candidate.status !== "candidate" || candidate.metadata?.gate !== "R1-release" || candidate.metadata?.humanDecision !== "pending" || candidate.metadata?.visualApprovalClaimed !== false) throw new Error("R1 source candidate is not the frozen pending production package");
  if (authority.gate !== "R1-release" || authority.approvalPolicy?.humanDecision !== "pending" || authority.approvalPolicy?.visualApprovalClaimed !== false || authority.approvalPolicy?.timestampQueriesEnabled !== false) throw new Error("R1 review authority is not exact pending timestamp-disabled authority");
  if (capture.schema !== "limina.building-production-native-review-set/v1" || capture.captureClass !== "production-engine" || capture.backend !== "native-webgpu" || capture.timingPolicy?.timestampQueriesEnabled !== false || capture.timingPolicy?.gpuTimestampMode !== "disabled") throw new Error("R1 capture is not the guarded production-engine review set");
  if (capture.authority?.path !== authorityFile.path || capture.authority?.sha256 !== authorityFile.sha256) throw new Error("R1 capture does not bind the exact authority bytes");
  if (capture.guardEvidence?.preflight?.xidObserved !== false || capture.guardEvidence?.live?.xidObserved !== false || capture.guardEvidence?.postflight?.xidObserved !== false) throw new Error("R1 capture lacks a clean pre/live/post Xid guard");
  if (!/nvidia/i.test(capture.adapter?.description ?? "") || capture.adapter?.vendor !== "4318") throw new Error("R1 capture did not use the NVIDIA hardware adapter");
  if (!Array.isArray(capture.outputs) || capture.outputs.map(({ id }) => id).join(",") !== IDS.join(",")) throw new Error("R1 capture does not contain the canonical five-view sequence");
  const reviewEvidence = [];
  for (const output of capture.outputs) {
    const [privateFile, bridgeFile] = await Promise.all([load(output.path), load(output.reviewArtifactPath)]);
    if (privateFile.sha256 !== output.pngSha256 || bridgeFile.sha256 !== output.pngSha256 || !privateFile.bytes.equals(bridgeFile.bytes) || output.width < 1920 || output.height < 1080 || output.renderSubmission?.schema !== "limina.three-render-submission/v2" || output.renderSubmission?.renderCalls <= 1 || output.renderSubmission?.drawCalls <= 1 || output.renderSubmission?.triangles <= 1 || output.pixelSanity?.schema !== "limina.rgba-luminance-sanity/v1") throw new Error(`R1 review output closure drifted: ${output.id}`);
    reviewEvidence.push(Object.freeze({ evidenceId: `production/functional-hall-house-v4/r1/native-review/${output.id}`, kind: "guarded-native-production-review-png", contentHash: output.pngSha256, width: output.width, height: output.height }));
  }
  const evidence = [
    ...candidate.evidence,
    { evidenceId: "production/functional-hall-house-v4/r1/native-review/authority-v5", kind: "production-review-authority-json", contentHash: authorityFile.sha256 },
    { evidenceId: "production/functional-hall-house-v4/r1/native-review/capture-set-v5", kind: "guarded-native-production-review-set-json", contentHash: captureFile.sha256 },
    ...reviewEvidence,
  ];
  const reviewed = validateBuildingStageArtifact({ ...candidate, evidence, metadata: { ...candidate.metadata, rendered: true, gpuUsed: true, review: { status: "candidate", humanDecision: "pending", visualApprovalClaimed: false, authority: { path: authorityFile.path, sha256: authorityFile.sha256 }, capture: { path: captureFile.path, sha256: captureFile.sha256 }, adapter: capture.adapter, bootId: capture.guardEvidence.bootId, timestampQueriesEnabled: false, outputIds: IDS } } });
  const serialized = `${JSON.stringify(reviewed, null, 2)}\n`, outputAbsolute = resolve(ROOT, outputPath);
  if (write) { await mkdir(dirname(outputAbsolute), { recursive: true, mode: 0o700 }); await writeFile(outputAbsolute, serialized, { mode: 0o600, flag: "wx" }); }
  return Object.freeze({ candidate: reviewed, outputPath: portable(outputAbsolute), sha256: sha(Buffer.from(serialized)) });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await finalizeProductionReviewCandidate();
  console.log(JSON.stringify({ outputPath: result.outputPath, sha256: result.sha256, evidence: result.candidate.evidence }, null, 2));
}
