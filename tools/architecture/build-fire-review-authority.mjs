import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildingFireRuntimeV1Hash,
  validateBuildingFireRuntimeV1,
} from "../../js/src/assets/building-fire-runtime-v1.mjs";
import {
  validateBuildingHitlDecision,
  validateBuildingStageArtifact,
} from "../../js/src/assets/staged-building-pipeline.mjs";
import { validateBuildingCompositionReviewAuthority } from "../../js/src/render/building-composition-review-scene.ts";
import {
  buildingFireReviewExpectedFrames,
  validateBuildingFireReviewAuthority,
  verifyBuildingFireReviewClosure,
} from "../../js/src/render/building-fire-review-authority.ts";

export const FIRE_REVIEW_AUTHORITY_DEFAULTS = Object.freeze({
  contract: "assets/buildings/authoring/functional-hall-house-v4/fire-r1/fire-runtime-contract.json",
  artifact: "assets/buildings/authoring/functional-hall-house-v4/fire-r1/fire-runtime-artifact-draft.json",
  buildEvidence: "assets/buildings/authoring/functional-hall-house-v4/fire-r1/build-evidence.json",
  runtimeSource: "js/src/render/building-fire-runtime.ts",
  renderBindingSource: "js/src/render/building-fire-render-binding.ts",
  c1Authority: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/review-authority-v2.json",
  c1Artifact: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/composition-artifact-approved.json",
  output: "assets/buildings/authoring/functional-hall-house-v4/fire-r1/fire-review-authority-r3.json",
});

const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const portable = (root, path) => {
  const value = relative(root, path).split(sep).join("/");
  if (!value || value === ".." || value.startsWith("../"))
    throw new Error(`fire review path escapes repository: ${path}`);
  return value;
};
const decode = (bytes) => JSON.parse(bytes.toString("utf8"));
const exact = (root, path, bytes) => Object.freeze({ path: portable(root, resolve(root, path)), sha256: sha(bytes) });

export function buildFireReviewAuthorityFromClosure({ repoRoot, paths, bytes }) {
  const root = resolve(repoRoot),
    contract = validateBuildingFireRuntimeV1(decode(bytes.contract)),
    artifact = validateBuildingStageArtifact(decode(bytes.artifact)),
    build = decode(bytes.buildEvidence),
    c1Authority = validateBuildingCompositionReviewAuthority(decode(bytes.c1Authority)),
    c1Artifact = validateBuildingStageArtifact(decode(bytes.c1Artifact)),
    c1Decision = validateBuildingHitlDecision(decode(bytes.c1Decision));
  const contractFile = exact(root, paths.contract, bytes.contract),
    artifactFile = exact(root, paths.artifact, bytes.artifact),
    buildFile = exact(root, paths.buildEvidence, bytes.buildEvidence),
    blendFile = exact(root, paths.fuelBlend, bytes.fuelBlend),
    fuelGlbFile = exact(root, paths.fuelGlb, bytes.fuelGlb),
    runtimeFile = exact(root, paths.runtimeSource, bytes.runtimeSource),
    renderFile = exact(root, paths.renderBindingSource, bytes.renderBindingSource),
    c1AuthorityFile = exact(root, paths.c1Authority, bytes.c1Authority),
    c1ArtifactFile = exact(root, paths.c1Artifact, bytes.c1Artifact),
    c1DecisionFile = exact(root, paths.c1Decision, bytes.c1Decision),
    c1GlbFile = exact(root, paths.c1Glb, bytes.c1Glb);
  if (
    artifact.artifactId !== "fire/functional-hall-house-v4/r1" ||
    artifact.kind !== "fire-runtime" ||
    artifact.revision !== 1 ||
    artifact.status !== "draft" ||
    artifact.contractHash !== buildingFireRuntimeV1Hash(contract) ||
    artifact.contentHash !== contractFile.sha256 ||
    artifact.metadata?.contract?.path !== contractFile.path ||
    artifact.metadata?.contract?.sha256 !== contractFile.sha256
  )
    throw new Error("V1 draft artifact does not bind the exact contract");
  if (
    build.schema !== "limina.hearth-fuel-build-evidence/v1" ||
    build.status !== "cpu-authored-unreviewed" ||
    build.rendered !== false ||
    build.gpuUsed !== false ||
    build.sourceBlend?.path !== blendFile.path ||
    build.sourceBlend?.sha256 !== blendFile.sha256 ||
    build.sourceBlend?.bytes !== bytes.fuelBlend.length ||
    build.asset?.path !== fuelGlbFile.path ||
    build.asset?.sha256 !== fuelGlbFile.sha256 ||
    build.asset?.bytes !== bytes.fuelGlb.length ||
    contract.fuelAsset.sourceBlend.path !== blendFile.path ||
    contract.fuelAsset.sourceBlend.sha256 !== blendFile.sha256 ||
    contract.fuelAsset.runtimeGlb.path !== fuelGlbFile.path ||
    contract.fuelAsset.runtimeGlb.sha256 !== fuelGlbFile.sha256
  )
    throw new Error("V1 authority requires the exact finalized CPU-authored fuel closure");
  if (
    c1Artifact.artifactId !== "composition/functional-hall-house-v4/r3" ||
    c1Artifact.kind !== "composition" ||
    c1Artifact.revision !== 3 ||
    c1Artifact.status !== "approved" ||
    c1Artifact.metadata?.fireExcluded !== true ||
    c1Artifact.metadata?.authority?.path !== c1AuthorityFile.path ||
    c1Artifact.metadata?.authority?.sha256 !== c1AuthorityFile.sha256 ||
    c1Artifact.metadata?.approval?.path !== c1DecisionFile.path ||
    c1Artifact.metadata?.approval?.sha256 !== c1DecisionFile.sha256 ||
    c1Decision.decision !== "approve" ||
    c1Decision.gate !== "C1-composition" ||
    c1Decision.artifactId !== c1Artifact.artifactId ||
    c1Decision.contractHash !== c1Artifact.contractHash ||
    c1Decision.contentHash !== c1Artifact.contentHash ||
    c1Decision.blockingFindings.length !== 0 ||
    c1Authority.approvalPolicy.fireExcluded !== true ||
    c1Authority.integratedSource.glb.path !== c1GlbFile.path ||
    c1Authority.integratedSource.glb.sha256 !== c1GlbFile.sha256 ||
    c1Artifact.contentHash !== c1GlbFile.sha256
  )
    throw new Error("V1 visual context is not the exact approved fire-excluded C1 r3 v2 authority");
  const authority = validateBuildingFireReviewAuthority({
    schema: "limina.building-fire-review-authority/v1",
    gate: "V1-vfx",
    approvalPolicy: {
      renderer: "limina-production-native-engine",
      blenderApprovalProhibited: true,
      nonEngineApprovalProhibited: true,
      humanDecisionRequired: true,
      guardSchema: "limina.nvidia-xid-guard/v1",
      timestampQueriesEnabled: false,
    },
    fireStage: {
      contract: {
        ...contractFile,
        packageId: contract.packageId,
        revision: contract.revision,
        canonicalHash: artifact.contractHash,
      },
      artifact: {
        ...artifactFile,
        artifactId: artifact.artifactId,
        kind: artifact.kind,
        revision: artifact.revision,
        status: artifact.status,
        contractHash: artifact.contractHash,
        contentHash: artifact.contentHash,
      },
    },
    fuel: { buildEvidence: buildFile, sourceBlend: blendFile, runtimeGlb: fuelGlbFile },
    runtimeSources: { runtime: runtimeFile, renderBinding: renderFile },
    visualContext: {
      contentDependency: false,
      purpose: "approved-c1-r3-v2-visual-context-only",
      reviewAuthority: c1AuthorityFile,
      approvedArtifact: {
        ...c1ArtifactFile,
        artifactId: c1Artifact.artifactId,
        revision: c1Artifact.revision,
        status: c1Artifact.status,
      },
      approvalDecision: { ...c1DecisionFile, decisionId: c1Decision.decisionId },
      integratedGlb: c1GlbFile,
    },
    presentation: {
      minimumResolution: contract.evidenceContract.minimumResolution,
      warmupFrames: 12,
      pixelFormat: "rgba8unorm",
      rowOrigin: "top-left",
    },
    evidenceFrames: buildingFireReviewExpectedFrames(contract),
    metrics: {
      silhouetteVariation: {
        required: true,
        frameIds: ["hearth-motion--burn-a", "hearth-motion--burn-b", "hearth-motion--burn-c", "hearth-motion--burn-d"],
      },
      fuelDetailFrameId: "fuel-detail--burn-a",
      reflectedLightPair: {
        required: true,
        offFrameId: "reflected-light--off-initial",
        onFrameId: "reflected-light--burn-a",
      },
      exposure: contract.evidenceContract.exposure,
    },
  });
  const files = new Map(
    Object.entries(paths)
      .filter(([key]) => key !== "output")
      .map(([key, path]) => [portable(root, resolve(root, path)), bytes[key]]),
  );
  verifyBuildingFireReviewClosure(authority, (path) => {
    const value = files.get(path);
    if (!value) throw new Error(`missing V1 review closure bytes: ${path}`);
    return value;
  });
  return authority;
}

export async function writeFireReviewAuthority(authority, outputPath) {
  validateBuildingFireReviewAuthority(authority);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${JSON.stringify(authority, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return authority;
}

export async function buildFireReviewAuthority({
  repoRoot = resolve(import.meta.dirname, "../.."),
  paths = {},
  write = true,
} = {}) {
  const root = resolve(repoRoot),
    selected = { ...FIRE_REVIEW_AUTHORITY_DEFAULTS, ...paths };
  const initialKeys = [
      "contract",
      "artifact",
      "buildEvidence",
      "runtimeSource",
      "renderBindingSource",
      "c1Authority",
      "c1Artifact",
    ],
    initial = Object.fromEntries(
      await Promise.all(initialKeys.map(async (key) => [key, await readFile(resolve(root, selected[key]))])),
    ),
    build = decode(initial.buildEvidence),
    c1Artifact = validateBuildingStageArtifact(decode(initial.c1Artifact)),
    c1Authority = validateBuildingCompositionReviewAuthority(decode(initial.c1Authority));
  selected.fuelBlend = build.sourceBlend?.path;
  selected.fuelGlb = build.asset?.path;
  selected.c1Decision = c1Artifact.metadata?.approval?.path;
  selected.c1Glb = c1Authority.integratedSource.glb.path;
  for (const key of ["fuelBlend", "fuelGlb", "c1Decision", "c1Glb"])
    if (typeof selected[key] !== "string") throw new Error(`V1 review closure lacks ${key}`);
  const derivedKeys = ["fuelBlend", "fuelGlb", "c1Decision", "c1Glb"],
    derived = Object.fromEntries(
      await Promise.all(derivedKeys.map(async (key) => [key, await readFile(resolve(root, selected[key]))])),
    ),
    authority = buildFireReviewAuthorityFromClosure({
      repoRoot: root,
      paths: selected,
      bytes: { ...initial, ...derived },
    }),
    outputPath = resolve(root, selected.output);
  portable(root, outputPath);
  if (write) await writeFireReviewAuthority(authority, outputPath);
  return Object.freeze({ authority, outputPath });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = await buildFireReviewAuthority();
  console.log(
    JSON.stringify(
      {
        schema: result.authority.schema,
        gate: result.authority.gate,
        frames: result.authority.evidenceFrames.length,
        output: portable(resolve(import.meta.dirname, "../.."), result.outputPath),
      },
      null,
      2,
    ),
  );
}
