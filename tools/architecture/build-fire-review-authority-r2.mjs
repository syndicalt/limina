import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { buildingFireRuntimeV2Hash, validateBuildingFireRuntimeV2 } from "../../js/src/assets/building-fire-runtime-v2.mjs";
import { validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import { validateBuildingCompositionReviewAuthority } from "../../js/src/render/building-composition-review-scene.ts";
import { BUILDING_FIRE_REVIEW_AUTHORITY_V2_SCHEMA, BUILDING_FIRE_REVIEW_AUTHORITY_V3_SCHEMA, BUILDING_FIRE_REVIEW_AUTHORITY_V4_SCHEMA, buildingFireReviewExpectedFrames, validateBuildingFireReviewAuthority, verifyBuildingFireReviewClosure } from "../../js/src/render/building-fire-review-authority.ts";

export const FIRE_REVIEW_R2_DEFAULTS = Object.freeze({
  contract: "assets/buildings/authoring/functional-hall-house-v4/fire-r2/fire-runtime-contract.json",
  artifact: "assets/buildings/authoring/functional-hall-house-v4/fire-r2/fire-runtime-artifact-draft.json",
  runtime: "js/src/render/building-fire-runtime.ts",
  renderBinding: "js/src/render/building-fire-render-binding.ts",
  volumetric: "js/src/render/building-fire-volumetric.ts",
  c1Authority: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/review-authority-v2.json",
  c1Artifact: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/composition-artifact-approved.json",
  output: "assets/buildings/authoring/functional-hall-house-v4/fire-r2/fire-review-authority-r5.json",
});

const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const portable = (root, path) => { const value = relative(root, path).split(sep).join("/"); if (!value || value === ".." || value.startsWith("../")) throw new Error(`fire r2 review path escapes repository: ${path}`); return value; };
const decode = (bytes) => JSON.parse(bytes.toString("utf8"));

export async function buildFireReviewAuthorityR2({ repoRoot = resolve(import.meta.dirname, "../.."), paths = {}, write = true } = {}) {
  const root = resolve(repoRoot), selected = { ...FIRE_REVIEW_R2_DEFAULTS, ...paths };
  const load = async (path) => { const full = resolve(root, path), bytes = await readFile(full); return { path: portable(root, full), bytes, sha256: sha(bytes) }; };
  const [contractFile, artifactFile, runtimeFile, bindingFile, volumetricFile, c1AuthorityFile, c1ArtifactFile] = await Promise.all([
    load(selected.contract), load(selected.artifact), load(selected.runtime), load(selected.renderBinding), load(selected.volumetric), load(selected.c1Authority), load(selected.c1Artifact),
  ]);
  const contract = validateBuildingFireRuntimeV2(decode(contractFile.bytes)), artifact = validateBuildingStageArtifact(decode(artifactFile.bytes));
  const c1Authority = validateBuildingCompositionReviewAuthority(decode(c1AuthorityFile.bytes)), c1Artifact = validateBuildingStageArtifact(decode(c1ArtifactFile.bytes));
  const revision = contract.revision;
  if (![2, 3, 4].includes(revision) || artifact.artifactId !== `fire/functional-hall-house-v4/r${revision}` || artifact.revision !== revision || artifact.status !== "draft" || artifact.contractHash !== buildingFireRuntimeV2Hash(contract) || artifact.contentHash !== contractFile.sha256) throw new Error(`fire r${revision} review requires exact draft contract closure`);
  const buildEvidencePath = artifact.metadata?.hearthFuel?.buildEvidence?.path, blendPath = artifact.metadata?.hearthFuel?.sourceBlend?.path, glbPath = artifact.metadata?.hearthFuel?.runtimeGlb?.path;
  const c1DecisionPath = c1Artifact.metadata?.approval?.path, c1GlbPath = c1Authority.integratedSource.glb.path;
  for (const [label, value] of Object.entries({ buildEvidencePath, blendPath, glbPath, c1DecisionPath, c1GlbPath })) if (typeof value !== "string") throw new Error(`fire r2 review lacks ${label}`);
  const [buildEvidence, blend, fuelGlb, c1Decision, c1Glb] = await Promise.all([load(buildEvidencePath), load(blendPath), load(glbPath), load(c1DecisionPath), load(c1GlbPath)]);
  const authority = validateBuildingFireReviewAuthority({
    schema: revision === 4 ? BUILDING_FIRE_REVIEW_AUTHORITY_V4_SCHEMA : revision === 3 ? BUILDING_FIRE_REVIEW_AUTHORITY_V3_SCHEMA : BUILDING_FIRE_REVIEW_AUTHORITY_V2_SCHEMA, gate: "V1-vfx",
    approvalPolicy: { renderer: "limina-production-native-engine", blenderApprovalProhibited: true, nonEngineApprovalProhibited: true, humanDecisionRequired: true, guardSchema: "limina.nvidia-xid-guard/v1", timestampQueriesEnabled: false },
    fireStage: {
      contract: { path: contractFile.path, sha256: contractFile.sha256, packageId: contract.packageId, revision, canonicalHash: artifact.contractHash },
      artifact: { path: artifactFile.path, sha256: artifactFile.sha256, artifactId: artifact.artifactId, kind: "fire-runtime", revision, status: "draft", contractHash: artifact.contractHash, contentHash: artifact.contentHash },
    },
    fuel: { buildEvidence: { path: buildEvidence.path, sha256: buildEvidence.sha256 }, sourceBlend: { path: blend.path, sha256: blend.sha256 }, runtimeGlb: { path: fuelGlb.path, sha256: fuelGlb.sha256 } },
    runtimeSources: { runtime: { path: runtimeFile.path, sha256: runtimeFile.sha256 }, renderBinding: { path: bindingFile.path, sha256: bindingFile.sha256 }, volumetric: { path: volumetricFile.path, sha256: volumetricFile.sha256 } },
    visualContext: {
      contentDependency: false, purpose: "approved-c1-r3-v2-visual-context-only",
      reviewAuthority: { path: c1AuthorityFile.path, sha256: c1AuthorityFile.sha256 },
      approvedArtifact: { path: c1ArtifactFile.path, sha256: c1ArtifactFile.sha256, artifactId: c1Artifact.artifactId, revision: 3, status: "approved" },
      approvalDecision: { path: c1Decision.path, sha256: c1Decision.sha256, decisionId: decode(c1Decision.bytes).decisionId },
      integratedGlb: { path: c1Glb.path, sha256: c1Glb.sha256 },
    },
    presentation: { minimumResolution: contract.evidenceContract.minimumResolution, warmupFrames: 12, pixelFormat: "rgba8unorm", rowOrigin: "top-left" },
    evidenceFrames: buildingFireReviewExpectedFrames(contract),
    metrics: {
      silhouetteVariation: { required: true, frameIds: ["hearth-motion--burn-a", "hearth-motion--burn-b", "hearth-motion--burn-c", "hearth-motion--burn-d"] },
      fuelDetailFrameId: "fuel-detail--burn-a", reflectedLightPair: { required: true, offFrameId: "reflected-light--off-initial", onFrameId: "reflected-light--burn-a" }, exposure: contract.evidenceContract.exposure,
      volumeProof: { required: true, representation: "three-fire-derived-volume-raymarch/v1", primaryFrameIds: ["hearth-motion--burn-a", "hearth-motion--burn-b", "hearth-motion--burn-c", "hearth-motion--burn-d"], multiViewFrameIds: ["hearth-motion--burn-a", "fuel-detail--burn-a"], minimumChangedPixels: 256, minimumJaccardDistance: .01, maximumOcclusionLeakFraction: .002 },
    },
  });
  const files = new Map([contractFile, artifactFile, runtimeFile, bindingFile, volumetricFile, buildEvidence, blend, fuelGlb, c1AuthorityFile, c1ArtifactFile, c1Decision, c1Glb].map((file) => [file.path, file.bytes]));
  verifyBuildingFireReviewClosure(authority, (path) => { const value = files.get(path); if (!value) throw new Error(`fire r2 review closure lacks ${path}`); return value; });
  const output = resolve(root, selected.output); portable(root, output);
  if (write) { await mkdir(dirname(output), { recursive: true, mode: 0o700 }); await writeFile(output, `${JSON.stringify(authority, null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
  return Object.freeze({ authority, output });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = await buildFireReviewAuthorityR2(); console.log(JSON.stringify({ schema: result.authority.schema, frames: result.authority.evidenceFrames.length, output: portable(resolve(import.meta.dirname, "../.."), result.output) }, null, 2));
}
