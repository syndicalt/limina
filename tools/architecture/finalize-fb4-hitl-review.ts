#!/usr/bin/env bun
// Append-only FB-4 review finalizer. It binds a central visual-floor pass and an explicit owner
// decision to one exact authority, capture, producer provenance, and complete RGBA evidence set.
// Every output is verified as an in-memory ledger before any file is written.

import fs from "node:fs";
import path from "node:path";

import { canonicalStringify } from "../../js/src/authoring/canonical.ts";
import { verifyBuildingReviewLedger } from "../../js/src/assets/building-review-outcome.ts";
import {
  assertBuildingArtifactReviewable,
  validateBuildingHitlDecision,
  validateBuildingStageArtifact,
} from "../../js/src/assets/staged-building-pipeline.mjs";
import { validateFb4CaptureProvenance } from "../../js/src/render/fb4-capture-provenance.ts";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import { sha256 } from "../../js/src/world/sha256.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const one = (flag: string, required=true): string | undefined => {
  const matches = args.flatMap((entry, index) => entry === flag && args[index + 1] ? [args[index + 1]!] : []);
  if (matches.length > 1) throw new Error(`${flag} must be supplied at most once`);
  if (required && matches.length !== 1) throw new Error(`${flag} is required`);
  return matches[0];
};
const all = (flag: string): string[] => args.flatMap((entry, index) => entry === flag && args[index + 1] ? [args[index + 1]!] : []);
const known = new Set([
  "--candidate-manifest", "--review-authority", "--capture-evidence", "--capture-provenance",
  "--central-review-out", "--presentation-out", "--decision-out", "--central-ledger-out", "--approved-ledger-out",
  "--review-id", "--revision", "--timestamp", "--reviewer", "--retained-proof", "--observation",
]);
for (let index=0; index<args.length; index+=2) {
  if (!known.has(args[index]!)) throw new Error(`unsupported argument '${args[index]}'`);
  if (!args[index+1]) throw new Error(`${args[index]} requires a value`);
}
const portable = (input: string): string => {
  const absolute = path.resolve(ROOT, input), relative = path.relative(ROOT, absolute).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error(`path escapes the workspace: ${input}`);
  return relative;
};
const raw = (bytes: Uint8Array): `sha256:${string}` => `sha256:${sha256(bytes)}`;
const encoded = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const exactBytes = (file: string) => {
  const portablePath = portable(file), bytes = fs.readFileSync(path.resolve(ROOT, portablePath));
  return Object.freeze({ path: portablePath, bytes, sha256: raw(bytes), contentHash: portableAssetContentHash(bytes) });
};
const short = (entry: {path:string;sha256:string;contentHash:string}) =>
  Object.freeze({ path: entry.path, sha256: entry.sha256, contentHash: entry.contentHash });
const outputPaths = {
  central: portable(one("--central-review-out")!),
  presentation: portable(one("--presentation-out")!),
  decision: portable(one("--decision-out")!),
  centralLedger: portable(one("--central-ledger-out")!),
  approvedLedger: portable(one("--approved-ledger-out")!),
};
if (new Set(Object.values(outputPaths)).size !== Object.keys(outputPaths).length) throw new Error("FB-4 review outputs must be distinct");
for (const output of Object.values(outputPaths)) if (fs.existsSync(path.resolve(ROOT, output))) throw new Error(`append-only FB-4 review output already exists: ${output}`);

const manifestFile = exactBytes(one("--candidate-manifest")!), authorityFile = exactBytes(one("--review-authority")!),
  captureFile = exactBytes(one("--capture-evidence")!), provenanceFile = exactBytes(one("--capture-provenance")!);
const manifest = JSON.parse(manifestFile.bytes.toString("utf8")), authority = JSON.parse(authorityFile.bytes.toString("utf8")),
  capture = JSON.parse(captureFile.bytes.toString("utf8")), provenance = validateFb4CaptureProvenance(JSON.parse(provenanceFile.bytes.toString("utf8")));
if (manifest.status !== "cpu-verified-human-pending" || manifest.visualApprovalClaimed !== false || manifest.gpuCaptureAtBuild !== false || manifest.placementSkill !== "building.placeFunctional")
  throw new Error("FB-4 HITL finalization requires an exact CPU-verified, human-pending functional candidate");
if (authority.approval?.humanDecision !== "pending" || authority.approval?.visualApprovalClaimed !== false || authority.approval?.renderer !== "limina-production-native-engine")
  throw new Error("FB-4 review authority is not an engine-rendered human-pending authority");
if (authority.candidate?.candidateId !== manifest.candidateId || authority.candidate?.manifest?.path !== manifestFile.path || authority.candidate?.manifest?.sha256 !== manifestFile.sha256)
  throw new Error("FB-4 authority does not bind the exact candidate manifest");
if (capture.authority?.path !== authorityFile.path || capture.authority?.sha256 !== authorityFile.sha256 || capture.candidate?.candidateId !== manifest.candidateId)
  throw new Error("FB-4 capture does not bind the exact authority and candidate");
if (capture.timingPolicy?.timestampQueriesEnabled !== false || capture.timingPolicy?.gpuTimestampMode !== "disabled"
    || capture.guardEvidence?.preflight?.xidObserved !== false || capture.guardEvidence?.live?.xidObserved !== false || capture.guardEvidence?.postflight?.xidObserved !== false)
  throw new Error("FB-4 capture lost the timestamp-disabled, Xid-clean safety boundary");
if (provenance.captureEvidence.path !== captureFile.path || provenance.captureEvidence.sha256 !== captureFile.sha256 || provenance.captureEvidence.contentHash !== captureFile.contentHash
    || provenance.subject.candidateId !== manifest.candidateId || provenance.subject.manifest.path !== manifestFile.path || provenance.subject.manifest.sha256 !== manifestFile.sha256
    || provenance.subject.reviewAuthority.path !== authorityFile.path || provenance.subject.reviewAuthority.sha256 !== authorityFile.sha256)
  throw new Error("FB-4 complete capture provenance does not bind the exact review subject");
if (!Array.isArray(capture.outputs) || capture.outputs.length < 1 || capture.outputs.length !== provenance.outputs.length) throw new Error("FB-4 capture evidence set is incomplete");
for (const output of provenance.outputs) {
  const captured = capture.outputs.find((entry: any) => entry.id === output.id);
  if (!captured || captured.path !== output.path || captured.pngSha256 !== output.pngSha256 || captured.rgbaContentHash !== output.rgbaContentHash
      || captured.width !== output.width || captured.height !== output.height || captured.pngByteLength !== output.pngByteLength)
    throw new Error(`FB-4 capture/provenance output drifted: ${output.id}`);
}

const retainedProof = all("--retained-proof");
if (retainedProof.length < 1 || retainedProof.some((entry) => entry.trim() === "")) throw new Error("at least one non-empty --retained-proof is required for a central pass");
const reviewId = one("--review-id")!;
if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(reviewId)) throw new Error("--review-id must be a stable lowercase id");
const revision = Number(one("--revision")!);
if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("--revision must be a positive integer");
const slug = String(manifest.candidateId).split("/").at(-1);
if (!slug || !/^[a-z0-9]{12}$/.test(slug)) throw new Error("FB-4 candidate id lacks its 12-character content slug");

const centralRecord = Object.freeze({
  schema: "limina.fb4-central-visual-review/v1", status: "passed-to-hitl", candidateId: manifest.candidateId,
  captureEvidence: { path: captureFile.path, sha256: captureFile.sha256 },
  gpuSafety: { timestampQueriesEnabled: false, xidObserved: false, retryProhibited: false }, reviewBridgeStaged: false,
  visualFloor: { referenceSetId: "project-gorgon/house/v1", passed: true, presentationProhibited: false },
  findings: [], retainedProof,
});
const centralBytes = encoded(centralRecord), centralExact = Object.freeze({ path: outputPaths.central, sha256: raw(centralBytes), contentHash: portableAssetContentHash(centralBytes) });
const presentationContract = Object.freeze({
  schema: "limina.fb4-presentation-evidence-contract/v1", candidateId: manifest.candidateId,
  reviewAuthority: short(authorityFile), captureEvidence: short(captureFile), captureProvenance: short(provenanceFile),
  outputs: provenance.outputs.map(({id,width,height,rgbaContentHash}) => ({id,width,height,rgbaContentHash})),
});
const evidenceContractHash = raw(Buffer.from(canonicalStringify(presentationContract)));
const presentation = validateBuildingStageArtifact({
  schema: "limina.building-stage-artifact/v1", artifactId: `presentation/fb4-${slug}/${reviewId}`,
  kind: "presentation-review", revision, status: "candidate", contractHash: authorityFile.sha256, contentHash: evidenceContractHash,
  facets: [
    { scope: "scene-authority", hash: authorityFile.sha256 },
    { scope: "environment", hash: authority.environment.authority.sha256 },
    { scope: "cameras", hash: authority.cameraSetHash },
    { scope: "post", hash: captureFile.sha256 },
    { scope: "evidence-contract", hash: evidenceContractHash },
  ], inputs: [], evidence: provenance.outputs.map((output) => ({
    evidenceId: `fb4/${slug}/${reviewId}/${output.id}`, kind: "production-engine-png",
    contentHash: output.rgbaContentHash, width: output.width, height: output.height,
  })), metadata: {
    candidateId: manifest.candidateId, reviewAuthority: authorityFile.path, captureEvidence: captureFile.path,
    captureProvenance: provenanceFile.path, centralReview: outputPaths.central,
  },
});
const presentationBytes = encoded(presentation), presentationExact = Object.freeze({ path: outputPaths.presentation, sha256: raw(presentationBytes), contentHash: portableAssetContentHash(presentationBytes) });
const timestamp = one("--timestamp", false) ?? new Date().toISOString(), reviewer = one("--reviewer", false) ?? "user";
const decision = validateBuildingHitlDecision({
  schema: "limina.building-hitl-decision/v2", decisionId: `${presentation.artifactId}/approve-user-r${revision}`,
  gate: "R1-release", artifactId: presentation.artifactId, contractHash: presentation.contractHash, contentHash: presentation.contentHash,
  reviewer, timestamp, decision: "approve",
  evidenceBindings: presentation.evidence.map(({evidenceId,contentHash}) => ({evidenceId,contentHash})),
  blockingFindings: [], observations: all("--observation"), markedRegions: [],
});
assertBuildingArtifactReviewable(presentation, decision, [presentation]);
const decisionBytes = encoded(decision), decisionExact = Object.freeze({ path: outputPaths.decision, sha256: raw(decisionBytes), contentHash: portableAssetContentHash(decisionBytes) });
const subject = Object.freeze({
  candidateId: manifest.candidateId, candidateManifest: short(manifestFile), reviewAuthority: short(authorityFile), captureEvidence: short(captureFile),
  captureProvenance: { ...short(provenanceFile), coverage: "complete" },
});
const centralEntry = Object.freeze({
  schema: "limina.building-review-ledger-entry/v1", sequence: 1, entryId: `fb4/${slug}/000001-central-${reviewId}`,
  previous: null, subject, event: { kind: "central-visual-review", record: { schema: centralRecord.schema, ...centralExact } },
});
const centralLedgerBytes = encoded(centralEntry), centralLedgerExact = Object.freeze({ path: outputPaths.centralLedger, sha256: raw(centralLedgerBytes), contentHash: portableAssetContentHash(centralLedgerBytes) });
const approvedEntry = Object.freeze({
  schema: "limina.building-review-ledger-entry/v1", sequence: 2, entryId: `fb4/${slug}/000002-hitl-approved-${reviewId}`,
  previous: centralLedgerExact, subject, event: { kind: "hitl-decision", presentationArtifact: presentationExact,
    record: { schema: decision.schema, ...decisionExact } },
});
const approvedLedgerBytes = encoded(approvedEntry);
const virtual = new Map<string,Uint8Array>([
  [outputPaths.central,centralBytes], [outputPaths.presentation,presentationBytes], [outputPaths.decision,decisionBytes],
  [outputPaths.centralLedger,centralLedgerBytes], [outputPaths.approvedLedger,approvedLedgerBytes],
]);
const read = (file: string): Uint8Array => virtual.get(file) ?? fs.readFileSync(path.resolve(ROOT, portable(file)));
const verified = verifyBuildingReviewLedger([
  { path: outputPaths.centralLedger, bytes: centralLedgerBytes }, { path: outputPaths.approvedLedger, bytes: approvedLedgerBytes },
], read);
if (verified.length !== 2 || verified[0]?.decision !== "central-pass" || verified[1]?.decision !== "approved")
  throw new Error("in-memory FB-4 review ledger did not resolve central-pass -> approved");

for (const [file,bytes] of virtual) {
  fs.mkdirSync(path.dirname(path.resolve(ROOT,file)), {recursive:true,mode:0o700});
  fs.writeFileSync(path.resolve(ROOT,file), bytes, {flag:"wx",mode:0o600});
}
console.log(JSON.stringify({candidateId:manifest.candidateId,reviewId,decision:"approved",timestamp,
  centralLedger:{path:outputPaths.centralLedger,sha256:centralLedgerExact.sha256},
  approvedLedger:{path:outputPaths.approvedLedger,sha256:raw(approvedLedgerBytes)},evidence:provenance.outputs.length},null,2));
