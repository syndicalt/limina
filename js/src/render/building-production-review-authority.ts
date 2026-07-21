import { validateBuildingCompositionManifestV2 } from "../assets/building-composition-manifest-v2.mjs";
import { validateBuildingHitlDecision, validateBuildingStageArtifact } from "../assets/staged-building-pipeline.mjs";
import { canonicalStringify } from "../authoring/canonical.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { sha256 } from "../world/sha256.mjs";
import { VISUAL_FIDELITY_REFERENCE_SET_ID } from "./visual-fidelity-floor.ts";

type Hash = `sha256:${string}`;
type V3 = readonly [number, number, number];
export interface ExactReviewFile {
  readonly path: string;
  readonly sha256: Hash;
}
export interface BuildingProductionReviewView {
  readonly id:
    "exterior-three-quarter" | "entry-door-stairs" | "interior-overall" | "hearth-fire-seating" | "dining-service";
  readonly role: string;
  readonly camera: {
    readonly position: V3;
    readonly target: V3;
    readonly fovDeg: number;
    readonly near: number;
    readonly far: number;
  };
}
export interface BuildingProductionReviewAuthority {
  readonly schema: "limina.building-production-review-authority/v4";
  readonly gate: "R1-release";
  readonly approvalPolicy: {
    readonly renderer: "limina-production-native-engine";
    readonly humanDecisionRequired: true;
    readonly humanDecision: "pending";
    readonly visualApprovalClaimed: false;
    readonly timestampQueriesEnabled: false;
    readonly nonEngineApprovalProhibited: true;
  };
  readonly package: {
    readonly manifest: ExactReviewFile;
    readonly cpuEvidence: ExactReviewFile;
    readonly candidate: ExactReviewFile;
    readonly mountEvidence: ExactReviewFile;
    readonly productionGlb: ExactReviewFile & { readonly bytes: number; readonly engineHash: Hash };
  };
  readonly upstreamApprovals: readonly ExactReviewFile[];
  readonly visualFloor: {
    readonly referenceSetId: typeof VISUAL_FIDELITY_REFERENCE_SET_ID;
    readonly releaseContract: ExactReviewFile;
    readonly automatedApprovalProhibited: true;
    readonly belowFloorPresentationProhibited: true;
  };
  readonly environment: {
    readonly authority: ExactReviewFile;
    readonly runtimeBundle: ExactReviewFile;
    readonly shot: "river-leading-line";
    readonly context: "approved-temperate-production";
    readonly siteFit: "authored-footprint-terrain-sampled";
    readonly populationExclusion: "rotated-authored-footprint-before-population-mount";
  };
  readonly siteFitEvidence: ExactReviewFile;
  readonly placement: { readonly position: V3; readonly yaw: number };
  readonly fire: {
    readonly start: true;
    readonly advanceTicks: 120;
    readonly expectedPhase: "burning";
    readonly expectedEnvelope: 1;
  };
  readonly presentation: {
    readonly minimumResolution: readonly [number, number];
    readonly fixedTimeSeconds: 12;
    readonly warmupFrames: number;
    readonly cameraVerticalBasis: "terrain-root-relative";
    readonly captureTrace: "traces/building-production-r1-native-capture.json";
    readonly captureSchema: "limina.building-production-native-review-set/v1";
  };
  readonly evidenceViews: readonly BuildingProductionReviewView[];
}

const HASH = /^sha256:[0-9a-f]{64}$/;
const RELEASE_CONTRACT = Object.freeze({
  path: "plans/visual-fidelity-release-contract.md",
  sha256: "sha256:0564b277a8e9ae5b6e498c7b3433123a4bd396e885ebdc3df08d2380142d5bc3",
});
const TEMPERATE_ENVIRONMENT = Object.freeze({
  authority: Object.freeze({
    path: "art-direction/temperate-fidelity-scene.json",
    sha256: "sha256:8ad4266675bda4c10bda3dd1fdbcbbd5e7d0516080f91b635202b6340b39d1c2",
  }),
  runtimeBundle: Object.freeze({
    path: "assets/derived/temperate-fidelity/runtime/bundle.json",
    sha256: "sha256:1d82456ac1a594bbe5e1238b25efd43e63817396a264b308eaa999deb8a91e23",
  }),
});
const SITE_FIT_EVIDENCE = Object.freeze({
  path: "assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653/production-review-site-fit-v3.json",
  sha256: "sha256:6569856d7e5eeb9f34c1f3106d3dec48a4250d0c8b0af19d62f6ff94d94dff6c",
});
const INTERIOR_PLAN = Object.freeze({
  path: "assets/buildings/authoring/functional-hall-house-v4/interior-r4/interior-plan.json",
  sha256: "sha256:32a25b969c940b4ee78365da6c75c9b47a7e70646e9faf04ce6c29b1357e2f0f",
});
const APPROVED_CAMERA_AUTHORITY = Object.freeze({
  path: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/review-authority-v2.json",
  sha256: "sha256:d64b907c14024e529ee3316df4ec043890ff614a587287228693d3ad7defcfa7",
});
const SITE = Object.freeze({ position: Object.freeze([106.25, 0, 50.25]), yaw: 1.175 });
const IDS = "exterior-three-quarter,entry-door-stairs,interior-overall,hearth-fire-seating,dining-service";
const raw = (bytes: Uint8Array): Hash => `sha256:${sha256(bytes)}`;
const decode = (bytes: Uint8Array, label: string): any => {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error });
  }
};
const exactKeys = (value: unknown, keys: readonly string[], label: string): void => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const actual = Object.keys(value);
  if (actual.some((key) => !keys.includes(key)) || keys.some((key) => !actual.includes(key)))
    throw new Error(`${label} keys drifted`);
};
const file: (value: unknown, label: string) => asserts value is ExactReviewFile = (value, label) => {
  exactKeys(value, ["path", "sha256"], label);
  const entry = value as ExactReviewFile;
  if (
    !entry.path ||
    entry.path.startsWith("/") ||
    entry.path.includes("\\") ||
    entry.path.split("/").includes("..") ||
    !HASH.test(entry.sha256)
  )
    throw new Error(`${label} is not an exact workspace file`);
};
const v3: (value: unknown, label: string) => asserts value is V3 = (value, label) => {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite))
    throw new Error(`${label} must be a finite vec3`);
};

export function validateBuildingProductionReviewAuthority(input: unknown): BuildingProductionReviewAuthority {
  exactKeys(
    input,
    [
      "schema",
      "gate",
      "approvalPolicy",
      "package",
      "upstreamApprovals",
      "visualFloor",
      "environment",
      "siteFitEvidence",
      "placement",
      "fire",
      "presentation",
      "evidenceViews",
    ],
    "R1 review authority",
  );
  const value = input as BuildingProductionReviewAuthority;
  if (value.schema !== "limina.building-production-review-authority/v4" || value.gate !== "R1-release")
    throw new Error("unsupported R1 review authority identity");
  exactKeys(
    value.approvalPolicy,
    [
      "renderer",
      "humanDecisionRequired",
      "humanDecision",
      "visualApprovalClaimed",
      "timestampQueriesEnabled",
      "nonEngineApprovalProhibited",
    ],
    "approvalPolicy",
  );
  if (
    value.approvalPolicy.renderer !== "limina-production-native-engine" ||
    value.approvalPolicy.humanDecisionRequired !== true ||
    value.approvalPolicy.humanDecision !== "pending" ||
    value.approvalPolicy.visualApprovalClaimed !== false ||
    value.approvalPolicy.timestampQueriesEnabled !== false ||
    value.approvalPolicy.nonEngineApprovalProhibited !== true
  )
    throw new Error("R1 review must remain native-engine, timestamp-disabled, and human-pending");
  exactKeys(value.package, ["manifest", "cpuEvidence", "candidate", "mountEvidence", "productionGlb"], "package");
  file(value.package.manifest, "package.manifest");
  file(value.package.cpuEvidence, "package.cpuEvidence");
  file(value.package.candidate, "package.candidate");
  file(value.package.mountEvidence, "package.mountEvidence");
  exactKeys(value.package.productionGlb, ["path", "sha256", "bytes", "engineHash"], "package.productionGlb");
  if (
    !value.package.productionGlb.path ||
    !HASH.test(value.package.productionGlb.sha256) ||
    !HASH.test(value.package.productionGlb.engineHash) ||
    !Number.isSafeInteger(value.package.productionGlb.bytes) ||
    value.package.productionGlb.bytes <= 0
  )
    throw new Error("R1 review production GLB identity is invalid");
  if (
    !Array.isArray(value.upstreamApprovals) ||
    value.upstreamApprovals.length !== 9 ||
    new Set(value.upstreamApprovals.map(({ path }) => path)).size !== 9
  )
    throw new Error("R1 review requires all nine unique upstream approvals");
  value.upstreamApprovals.forEach((entry, index) => file(entry, `upstreamApprovals[${index}]`));
  exactKeys(
    value.visualFloor,
    ["referenceSetId", "releaseContract", "automatedApprovalProhibited", "belowFloorPresentationProhibited"],
    "visualFloor",
  );
  file(value.visualFloor.releaseContract, "visualFloor.releaseContract");
  if (
    value.visualFloor.referenceSetId !== VISUAL_FIDELITY_REFERENCE_SET_ID ||
    value.visualFloor.automatedApprovalProhibited !== true ||
    value.visualFloor.belowFloorPresentationProhibited !== true
  )
    throw new Error("R1 review lost the locked Project Gorgon human floor");
  if (
    value.visualFloor.releaseContract.path !== RELEASE_CONTRACT.path ||
    value.visualFloor.releaseContract.sha256 !== RELEASE_CONTRACT.sha256
  )
    throw new Error("R1 review visual release contract identity drifted");
  exactKeys(
    value.environment,
    ["authority", "runtimeBundle", "shot", "context", "siteFit", "populationExclusion"],
    "environment",
  );
  file(value.environment.authority, "environment.authority");
  file(value.environment.runtimeBundle, "environment.runtimeBundle");
  if (
    value.environment.shot !== "river-leading-line" ||
    value.environment.context !== "approved-temperate-production" ||
    value.environment.siteFit !== "authored-footprint-terrain-sampled" ||
    value.environment.populationExclusion !== "rotated-authored-footprint-before-population-mount"
  )
    throw new Error("R1 review lost its approved production environment or ecological exclusion");
  if (
    value.environment.authority.path !== TEMPERATE_ENVIRONMENT.authority.path ||
    value.environment.authority.sha256 !== TEMPERATE_ENVIRONMENT.authority.sha256 ||
    value.environment.runtimeBundle.path !== TEMPERATE_ENVIRONMENT.runtimeBundle.path ||
    value.environment.runtimeBundle.sha256 !== TEMPERATE_ENVIRONMENT.runtimeBundle.sha256
  )
    throw new Error("R1 review approved temperate environment identity drifted");
  file(value.siteFitEvidence, "siteFitEvidence");
  if (
    value.siteFitEvidence.path !== SITE_FIT_EVIDENCE.path ||
    value.siteFitEvidence.sha256 !== SITE_FIT_EVIDENCE.sha256
  )
    throw new Error("R1 deterministic site-fit evidence identity drifted");
  exactKeys(value.placement, ["position", "yaw"], "placement");
  v3(value.placement.position, "placement.position");
  if (!Number.isFinite(value.placement.yaw)) throw new Error("placement yaw is invalid");
  if (JSON.stringify(value.placement) !== JSON.stringify(SITE))
    throw new Error("R1 placement is not the CPU-verified production site");
  if (
    JSON.stringify(value.fire) !==
    JSON.stringify({ start: true, advanceTicks: 120, expectedPhase: "burning", expectedEnvelope: 1 })
  )
    throw new Error("R1 fire review schedule drifted");
  const p = value.presentation;
  if (
    !Array.isArray(p.minimumResolution) ||
    p.minimumResolution.length !== 2 ||
    p.minimumResolution[0] < 1920 ||
    p.minimumResolution[1] < 1080 ||
    !p.minimumResolution.every(Number.isSafeInteger) ||
    p.fixedTimeSeconds !== 12 ||
    !Number.isSafeInteger(p.warmupFrames) ||
    p.warmupFrames < 1 ||
    p.warmupFrames > 120 ||
    p.cameraVerticalBasis !== "terrain-root-relative" ||
    p.captureTrace !== "traces/building-production-r1-native-capture.json" ||
    p.captureSchema !== "limina.building-production-native-review-set/v1"
  )
    throw new Error("R1 presentation policy is invalid");
  if (!Array.isArray(value.evidenceViews) || value.evidenceViews.map(({ id }) => id).join(",") !== IDS)
    throw new Error("R1 authority lacks the canonical five-view sequence");
  for (const view of value.evidenceViews) {
    if (!view.role) throw new Error(`${view.id} role is empty`);
    exactKeys(view.camera, ["position", "target", "fovDeg", "near", "far"], `${view.id}.camera`);
    v3(view.camera.position, `${view.id}.position`);
    v3(view.camera.target, `${view.id}.target`);
    if (
      !Number.isFinite(view.camera.fovDeg) ||
      view.camera.fovDeg < 20 ||
      view.camera.fovDeg > 80 ||
      !Number.isFinite(view.camera.near) ||
      view.camera.near <= 0 ||
      !Number.isFinite(view.camera.far) ||
      view.camera.far <= view.camera.near
    )
      throw new Error(`${view.id} camera is invalid`);
  }
  return Object.freeze(value);
}

function exactBytes(entry: ExactReviewFile, read: (path: string) => Uint8Array, label: string): Uint8Array {
  const bytes = read(entry.path);
  if (raw(bytes) !== entry.sha256) throw new Error(`${label} exact bytes drifted`);
  return bytes;
}
function correlateStage(
  ref: any,
  decisionRef: ExactReviewFile,
  read: (path: string) => Uint8Array,
  label: string,
): void {
  const artifact = validateBuildingStageArtifact(
      decode(
        exactBytes({ path: ref.artifactPath, sha256: ref.artifactSha256 }, read, `${label} artifact`),
        `${label} artifact`,
      ),
    ),
    decision = validateBuildingHitlDecision(
      decode(exactBytes(decisionRef, read, `${label} decision`), `${label} decision`),
    );
  if (
    artifact.artifactId !== ref.artifactId ||
    artifact.kind !== ref.kind ||
    artifact.status !== "approved" ||
    artifact.contractHash !== ref.contractHash ||
    artifact.contentHash !== ref.contentHash ||
    decision.decision !== "approve" ||
    decision.artifactId !== artifact.artifactId ||
    decision.contractHash !== artifact.contractHash ||
    decision.contentHash !== artifact.contentHash ||
    artifact.metadata?.approval?.decisionId !== decision.decisionId ||
    artifact.metadata?.approval?.sha256 !== decisionRef.sha256
  )
    throw new Error(`${label} approved closure drifted`);
}

function validateSiteFitEvidence(value: any, authority: BuildingProductionReviewAuthority): any {
  if (
    value?.schema !== "limina.building-production-review-site-fit/v1" ||
    value.verdict !== "pass" ||
    JSON.stringify(value.placement) !== JSON.stringify(authority.placement)
  )
    throw new Error("R1 site-fit evidence identity or placement drifted");
  if (
    JSON.stringify(value.inputs?.environmentAuthority) !== JSON.stringify(authority.environment.authority) ||
    JSON.stringify(value.inputs?.runtimeBundle) !== JSON.stringify(authority.environment.runtimeBundle) ||
    JSON.stringify(value.inputs?.productionGlb) !==
      JSON.stringify({ path: authority.package.productionGlb.path, sha256: authority.package.productionGlb.sha256 }) ||
    JSON.stringify(value.inputs?.interiorPlan) !== JSON.stringify(INTERIOR_PLAN) ||
    JSON.stringify(value.inputs?.approvedCameraAuthority) !== JSON.stringify(APPROVED_CAMERA_AUTHORITY)
  )
    throw new Error("R1 site-fit evidence inputs drifted");
  const fit = value.fit,
    support = fit?.entranceSupport;
  if (
    !Number.isFinite(fit?.rootWorldY) ||
    !Number.isFinite(fit?.terrainMinimum) ||
    !Number.isFinite(fit?.terrainMaximum) ||
    !Number.isFinite(fit?.terrainRelief) ||
    fit.terrainRelief < 0 ||
    fit.terrainRelief > fit.maximumTerrainRelief ||
    !Number.isSafeInteger(fit.sampleCount) ||
    fit.sampleCount < 1 ||
    support === null ||
    !Number.isFinite(support?.terrainVariation) ||
    support.terrainVariation < 0 ||
    support.terrainVariation > value.inputs.sitePolicy?.entranceSupport?.maximumVariation ||
    support.cutDepth < 0 ||
    support.cutDepth > value.inputs.sitePolicy?.entranceSupport?.maximumCutDepth
  )
    throw new Error("R1 site-fit metrics violate the exact production contract");
  if (
    !Array.isArray(value.terrain?.residentChunks) ||
    value.terrain.residentChunks.length !== 25 ||
    new Set(value.terrain.residentChunks.map((entry: any) => entry.chunkId)).size !== 25 ||
    value.terrain.residentChunks.some(
      (entry: any) =>
        !HASH.test(entry.rawSha256) ||
        !HASH.test(entry.contentHash) ||
        !Number.isSafeInteger(entry.byteLength) ||
        entry.byteLength < 1,
    )
  )
    throw new Error("R1 site-fit evidence lacks exact resident terrain closure");
  const views = value.cameraDomain?.views;
  if (
    value.cameraDomain?.basis !== "terrain-root-relative" ||
    !Array.isArray(views) ||
    views.map((entry: any) => entry.id).join(",") !== IDS ||
    views.some(
      (entry: any) =>
        entry.residentTerrain !== true ||
        entry.aboveTerrain !== true ||
        entry.withinClipDomain !== true ||
        entry.positionTerrainClearanceM <= 0 ||
        entry.targetTerrainClearanceM < 0,
    )
  )
    throw new Error("R1 site-fit camera domain evidence is incomplete");
  const interior = value.cameraDomain?.interiorRoom,
    interiorViews = interior?.views;
  if (
    interior?.id !== "room/main" ||
    !Array.isArray(interiorViews) ||
    interiorViews.map((entry: any) => entry.id).join(",") !== "interior-overall,hearth-fire-seating,dining-service" ||
    interiorViews.some(
      (entry: any) =>
        entry.positionInsideRoom !== true ||
        entry.targetInsideRoom !== true ||
        entry.minimumBoundaryMarginM < 0.2 ||
        entry.minimumColliderClearanceM < 0.25 ||
        !entry.approvedSourceId,
    )
  )
    throw new Error("R1 interior camera envelope/collider evidence is incomplete");
  return value;
}

const rounded = (value: number) => Number(value.toFixed(12));
export function verifyBuildingProductionReviewSiteResolution(
  authorityValue: unknown,
  evidenceValue: unknown,
  resolution: any,
  sampleHeight: (x: number, z: number) => number | undefined | null,
) {
  const authority = validateBuildingProductionReviewAuthority(authorityValue),
    evidence = validateSiteFitEvidence(evidenceValue, authority),
    fit = resolution,
    expectedFit = {
      rootWorldY: rounded(fit.rootWorldY),
      terrainMinimum: rounded(fit.terrainMinimum),
      terrainMaximum: rounded(fit.terrainMaximum),
      terrainRelief: rounded(fit.terrainRelief),
      sampleCount: fit.sampleCount,
      maximumTerrainRelief: evidence.inputs.sitePolicy.maximumTerrainRelief,
      entranceSupport: fit.entranceSupport
        ? {
            terrainMinimum: rounded(fit.entranceSupport.terrainMinimum),
            terrainMaximum: rounded(fit.entranceSupport.terrainMaximum),
            terrainVariation: rounded(fit.entranceSupport.terrainVariation),
            worldGradeY: rounded(fit.entranceSupport.worldGradeY),
            fillDepth: rounded(fit.entranceSupport.fillDepth),
            cutDepth: rounded(fit.entranceSupport.cutDepth),
            sampleCount: fit.entranceSupport.sampleCount,
          }
        : null,
    };
  if (JSON.stringify(expectedFit) !== JSON.stringify(evidence.fit))
    throw new Error("R1 runtime site resolution drifted from deterministic CPU evidence");
  const cameras = authority.evidenceViews.map((view) => {
    const positionTerrain = sampleHeight(view.camera.position[0], view.camera.position[2]),
      targetTerrain = sampleHeight(view.camera.target[0], view.camera.target[2]);
    if (positionTerrain == null || targetTerrain == null) throw new Error(`${view.id} left exact resident terrain`);
    const position = [view.camera.position[0], view.camera.position[1] + fit.rootWorldY, view.camera.position[2]],
      target = [view.camera.target[0], view.camera.target[1] + fit.rootWorldY, view.camera.target[2]],
      distance = Math.hypot(position[0] - target[0], position[1] - target[1], position[2] - target[2]),
      positionClearance = position[1] - positionTerrain,
      targetClearance = target[1] - targetTerrain;
    return {
      id: view.id,
      terrainSamples: { position: rounded(positionTerrain), target: rounded(targetTerrain) },
      resolved: { position: position.map(rounded), target: target.map(rounded) },
      positionTerrainClearanceM: rounded(positionClearance),
      targetTerrainClearanceM: rounded(targetClearance),
      viewRayLengthM: rounded(distance),
      residentTerrain: true,
      aboveTerrain: positionClearance > view.camera.near && targetClearance >= 0,
      withinClipDomain: distance > view.camera.near && distance < view.camera.far,
    };
  });
  if (JSON.stringify(cameras) !== JSON.stringify(evidence.cameraDomain.views))
    throw new Error("R1 runtime camera domain drifted from deterministic CPU evidence");
  return evidence;
}

export function verifyBuildingProductionReviewClosure(input: unknown, read: (path: string) => Uint8Array) {
  const authority = validateBuildingProductionReviewAuthority(input),
    manifestBytes = exactBytes(authority.package.manifest, read, "R1 package manifest"),
    manifest = decode(manifestBytes, "R1 package manifest"),
    evidence = decode(exactBytes(authority.package.cpuEvidence, read, "R1 CPU evidence"), "R1 CPU evidence"),
    candidate = validateBuildingStageArtifact(
      decode(exactBytes(authority.package.candidate, read, "R1 candidate"), "R1 candidate"),
    );
  const mountBytes = exactBytes(authority.package.mountEvidence, read, "R1 mount evidence"),
    productionBytes = exactBytes(authority.package.productionGlb, read, "R1 production GLB");
  if (
    manifest.schema !== "limina.building-production-package/v1" ||
    manifest.packageId !== "production/functional-hall-house-v4/r1" ||
    manifest.status !== "draft" ||
    manifest.humanDecision !== "pending" ||
    manifest.visualApprovalClaimed !== false ||
    manifest.buildPolicy?.timestampQueriesEnabled !== false
  )
    throw new Error("R1 package is not the frozen pending authority");
  const contractHash = `sha256:${sha256(canonicalStringify(manifest))}`;
  if (
    candidate.kind !== "production-package" ||
    candidate.status !== "candidate" ||
    candidate.contractHash !== contractHash ||
    candidate.contentHash !== authority.package.productionGlb.sha256 ||
    candidate.metadata?.productionMountEvidence?.sha256 !== authority.package.mountEvidence.sha256 ||
    candidate.metadata?.humanDecision !== "pending"
  )
    throw new Error("R1 candidate does not bind manifest and mount evidence");
  if (
    evidence.verdict !== "pass" ||
    evidence.contractHash !== contractHash ||
    evidence.humanDecision !== "pending" ||
    evidence.gpuUsed !== false ||
    evidence.rendered !== false ||
    evidence.inputs?.mountEvidence?.sha256 !== authority.package.mountEvidence.sha256
  )
    throw new Error("R1 CPU evidence is not mount-verified and pending");
  if (
    productionBytes.length !== authority.package.productionGlb.bytes ||
    portableAssetContentHash(productionBytes) !== authority.package.productionGlb.engineHash ||
    manifest.runtime?.productionGlb?.sha256 !== authority.package.productionGlb.sha256 ||
    manifest.runtime.productionGlb.engineHash !== authority.package.productionGlb.engineHash
  )
    throw new Error("R1 production GLB raw/engine identity drifted");
  if (JSON.stringify(manifest.approvals?.decisions) !== JSON.stringify(authority.upstreamApprovals))
    throw new Error("R1 upstream approval inventory drifted");
  for (const [index, entry] of authority.upstreamApprovals.entries()) {
    const decision = validateBuildingHitlDecision(
      decode(exactBytes(entry, read, `upstream approval ${index}`), `upstream approval ${index}`),
    );
    if (decision.decision !== "approve") throw new Error(`upstream approval ${index} is not approved`);
  }
  const composition = validateBuildingCompositionManifestV2(
    decode(exactBytes(manifest.composition.manifest, read, "C1 manifest"), "C1 manifest"),
  );
  correlateStage(
    composition.dependencies.shell.artifact,
    composition.dependencies.shell.approvalDecision,
    read,
    "shell",
  );
  correlateStage(
    composition.dependencies.materialPalette.artifact,
    composition.dependencies.materialPalette.approvalDecision,
    read,
    "materials",
  );
  correlateStage(
    composition.dependencies.interiorPlan.artifact,
    composition.dependencies.interiorPlan.approvalDecision,
    read,
    "interior",
  );
  for (const [index, entry] of composition.dependencies.catalog.entries())
    correlateStage(entry.artifact, entry.approvalDecision, read, `catalog ${index}`);
  const compositionArtifact = validateBuildingStageArtifact(
      decode(exactBytes(manifest.composition.approvedArtifact, read, "composition artifact"), "composition artifact"),
    ),
    compositionDecision = validateBuildingHitlDecision(
      decode(exactBytes(manifest.composition.approvalDecision, read, "composition decision"), "composition decision"),
    );
  if (
    compositionArtifact.status !== "approved" ||
    compositionDecision.decision !== "approve" ||
    compositionDecision.artifactId !== compositionArtifact.artifactId ||
    compositionDecision.contentHash !== compositionArtifact.contentHash
  )
    throw new Error("composition approval closure drifted");
  const fireArtifact = validateBuildingStageArtifact(
      decode(exactBytes(manifest.runtimeFacets.fire.approvedArtifact, read, "fire artifact"), "fire artifact"),
    ),
    fireDecision = validateBuildingHitlDecision(
      decode(exactBytes(manifest.runtimeFacets.fire.approvalDecision, read, "fire decision"), "fire decision"),
    );
  if (
    fireArtifact.status !== "approved" ||
    fireDecision.decision !== "approve" ||
    fireDecision.artifactId !== fireArtifact.artifactId ||
    fireDecision.contractHash !== fireArtifact.contractHash ||
    fireDecision.contentHash !== fireArtifact.contentHash
  )
    throw new Error("fire approval closure drifted");
  exactBytes(authority.visualFloor.releaseContract, read, "visual release contract");
  const environmentAuthority = decode(
      exactBytes(authority.environment.authority, read, "temperate environment authority"),
      "temperate environment authority",
    ),
    environmentBundle = decode(
      exactBytes(authority.environment.runtimeBundle, read, "temperate environment bundle"),
      "temperate environment bundle",
    );
  if (
    environmentAuthority.presentation?.captureTimeSeconds !== authority.presentation.fixedTimeSeconds ||
    environmentAuthority.presentation?.warmupFrames !== authority.presentation.warmupFrames
  )
    throw new Error("R1 capture timing drifted from approved temperate environment authority");
  const siteFit = validateSiteFitEvidence(
    decode(exactBytes(authority.siteFitEvidence, read, "R1 site-fit evidence"), "R1 site-fit evidence"),
    authority,
  );
  if (
    siteFit.inputs.manifestHash !== environmentBundle.manifest?.manifestHash ||
    JSON.stringify(siteFit.terrain.grid) !== JSON.stringify(environmentBundle.manifest?.grid)
  )
    throw new Error("R1 site-fit terrain snapshot identity drifted");
  for (const entry of siteFit.terrain.residentChunks) {
    const bytes = read(entry.path),
      descriptor = environmentBundle.artifactIndex?.find(
        (candidate: any) =>
          candidate.assetId === entry.path.replace(/^assets\//, "") && candidate.contentHash === entry.contentHash,
      ),
      chunk = environmentBundle.manifest?.chunks?.find(
        (candidate: any) =>
          candidate.chunkId === entry.chunkId && candidate.tx === entry.tx && candidate.tz === entry.tz,
      );
    if (
      raw(bytes) !== entry.rawSha256 ||
      bytes.length !== entry.byteLength ||
      descriptor?.byteLength !== entry.byteLength ||
      !chunk?.artifacts?.some(
        (artifact: any) =>
          artifact.artifactType === "terrain-chunk/v1" &&
          artifact.contentHash === entry.contentHash &&
          artifact.byteLength === entry.byteLength,
      )
    )
      throw new Error(`R1 site-fit resident terrain closure drifted: ${entry.chunkId}`);
  }
  return Object.freeze({
    authority,
    manifest,
    evidence,
    candidate,
    mountBytes,
    productionBytes,
    contractHash,
    siteFit,
  });
}
