import fs from "node:fs";
import {
  createBuildingSemanticEvidence,
  type ExactSemanticEvidenceFile,
} from "../src/render/building-semantic-evidence.ts";
import { createFb4V3SemanticPolicy } from "../src/render/fb4-v3-semantic-policy.ts";
import { portableAssetContentHash } from "../src/world/asset-content-hash.mjs";
import { sha256 } from "../src/world/sha256.mjs";

const root = "assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-v3-1f375ec3abe1";
const manifestPath = `${root}/candidate-manifest.json`;
const irPath = `${root}/functional-hall-house-fb4-multi-room.glb.architecture.json`;
const glbPath = `${root}/functional-hall-house-fb4-multi-room.glb`;
const manifestBytes = fs.readFileSync(manifestPath);
const irBytes = fs.readFileSync(irPath);
const glbBytes = fs.readFileSync(glbPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const ir = JSON.parse(irBytes.toString("utf8"));
const exact = (path: string, bytes: Uint8Array): ExactSemanticEvidenceFile => ({
  path,
  sha256: `sha256:${sha256(bytes)}`,
  contentHash: portableAssetContentHash(bytes),
  bytes: bytes.byteLength,
});
const FB4_V3_SEMANTIC_POLICY = createFb4V3SemanticPolicy(ir);

const evidence = createBuildingSemanticEvidence({
  candidateId: manifest.candidateId,
  architectureId: ir.functionalContract.buildingId,
  candidateManifest: { file: exact(manifestPath, manifestBytes), bytes: manifestBytes },
  architectureIr: { file: exact(irPath, irBytes), bytes: irBytes },
  productionGlb: { file: exact(glbPath, glbBytes), bytes: glbBytes },
  policy: FB4_V3_SEMANTIC_POLICY,
});
if (evidence.mechanicalVerdict !== "pass") {
  const failed = evidence.claims.flatMap((claim) => claim.targets.filter((target) => !target.pass).map((target) => ({ claim: claim.id, role: target.role, id: target.targetId, bounds: target.projectedBounds, visible: target.visibleAnchorCount, eligible: target.eligibleAnchorCount, fraction: target.visibleFraction, occluders: target.occlusionLeaders })));
  throw new Error(`p_fb4_v3_semantic_evidence FAIL:\n${evidence.failures.join("\n")}\n${JSON.stringify(failed)}`);
}
console.log(`p_fb4_v3_semantic_evidence OK: ${evidence.claims.length} exact manifest/compiler-IR/owned-GLB semantic claim views pass without rendering, GPU, visual-quality, or approval claims (${evidence.evidenceHash})`);
