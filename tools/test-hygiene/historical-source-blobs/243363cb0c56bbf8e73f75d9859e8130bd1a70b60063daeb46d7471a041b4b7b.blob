import { validateBuildingFireRuntimeV1, buildingFireRuntimeV1Hash } from "../assets/building-fire-runtime-v1.mjs";
import { validateBuildingFireRuntimeV2, buildingFireRuntimeV2Hash } from "../assets/building-fire-runtime-v2.mjs";
import { validateBuildingHitlDecision, validateBuildingStageArtifact } from "../assets/staged-building-pipeline.mjs";
import { sha256 } from "../world/sha256.mjs";
import { validateBuildingCompositionReviewAuthority } from "./building-composition-review-scene.ts";

export const BUILDING_FIRE_REVIEW_AUTHORITY_SCHEMA = "limina.building-fire-review-authority/v1" as const;
export const BUILDING_FIRE_REVIEW_AUTHORITY_V2_SCHEMA = "limina.building-fire-review-authority/v2" as const;
export const BUILDING_FIRE_REVIEW_AUTHORITY_V3_SCHEMA = "limina.building-fire-review-authority/v3" as const;
export const BUILDING_FIRE_REVIEW_AUTHORITY_V4_SCHEMA = "limina.building-fire-review-authority/v4" as const;
export const BUILDING_FIRE_REVIEW_FRAME_IDS = Object.freeze([
  "hearth-motion--off-initial", "hearth-motion--ignition", "hearth-motion--burn-a", "hearth-motion--burn-b",
  "hearth-motion--burn-c", "hearth-motion--burn-d", "hearth-motion--extinguish", "hearth-motion--off-final",
  "fuel-detail--burn-a", "reflected-light--off-initial", "reflected-light--burn-a",
] as const);

type Hash = `sha256:${string}`;
type V3 = readonly [number, number, number];
type ExactFile = Readonly<{ path: string; sha256: Hash }>;
type Camera = Readonly<{ position: V3; target: V3; fovDeg: number }>;
export type BuildingFireReviewFrame = Readonly<{
  ordinal: number; id: typeof BUILDING_FIRE_REVIEW_FRAME_IDS[number]; viewId: "hearth-motion" | "fuel-detail" | "reflected-light";
  sampleId: string; tick: number; phase: "off" | "igniting" | "burning" | "extinguishing";
  purpose: "motion-sequence" | "fuel-detail" | "reflected-light-off" | "reflected-light-on"; camera: Camera;
}>;

export interface BuildingFireReviewAuthority {
  readonly schema: typeof BUILDING_FIRE_REVIEW_AUTHORITY_SCHEMA | typeof BUILDING_FIRE_REVIEW_AUTHORITY_V2_SCHEMA | typeof BUILDING_FIRE_REVIEW_AUTHORITY_V3_SCHEMA | typeof BUILDING_FIRE_REVIEW_AUTHORITY_V4_SCHEMA;
  readonly gate: "V1-vfx";
  readonly approvalPolicy: Readonly<{ renderer: "limina-production-native-engine"; blenderApprovalProhibited: true; nonEngineApprovalProhibited: true; humanDecisionRequired: true; guardSchema: "limina.nvidia-xid-guard/v1"; timestampQueriesEnabled: false }>;
  readonly fireStage: Readonly<{
    contract: ExactFile & Readonly<{ packageId: string; revision: number; canonicalHash: Hash }>;
    artifact: ExactFile & Readonly<{ artifactId: string; kind: "fire-runtime"; revision: number; status: "draft"; contractHash: Hash; contentHash: Hash }>;
  }>;
  readonly fuel: Readonly<{ buildEvidence: ExactFile; sourceBlend: ExactFile; runtimeGlb: ExactFile }>;
  readonly runtimeSources: Readonly<{ runtime: ExactFile; renderBinding: ExactFile; volumetric?: ExactFile }>;
  readonly visualContext: Readonly<{
    contentDependency: false; purpose: "approved-c1-r3-v2-visual-context-only";
    reviewAuthority: ExactFile; approvedArtifact: ExactFile & Readonly<{ artifactId: "composition/functional-hall-house-v4/r3"; revision: 3; status: "approved" }>;
    approvalDecision: ExactFile & Readonly<{ decisionId: string }>;
    integratedGlb: ExactFile;
  }>;
  readonly presentation: Readonly<{ minimumResolution: readonly [number, number]; warmupFrames: number; pixelFormat: "rgba8unorm"; rowOrigin: "top-left" }>;
  readonly evidenceFrames: readonly BuildingFireReviewFrame[];
  readonly metrics: Readonly<{
    silhouetteVariation: Readonly<{ required: true; frameIds: readonly [string, string, string, string] }>;
    fuelDetailFrameId: "fuel-detail--burn-a";
    reflectedLightPair: Readonly<{ required: true; offFrameId: "reflected-light--off-initial"; onFrameId: "reflected-light--burn-a" }>;
    exposure: Readonly<{ pairedOffOn: true; maxClippedPixelFraction: number; maxChannelP99: number }>;
    volumeProof?: Readonly<{ required: true; representation: "three-fire-derived-volume-raymarch/v1";
      primaryFrameIds: readonly [string, string, string, string]; multiViewFrameIds: readonly [string, string];
      minimumChangedPixels: number; minimumJaccardDistance: number; maximumOcclusionLeakFraction: number }>;
  }>;
}

const HASH = /^sha256:[0-9a-f]{64}$/;
const EXACT_PATHS = Object.freeze({
  contract: "assets/buildings/authoring/functional-hall-house-v4/fire-r1/fire-runtime-contract.json",
  artifact: "assets/buildings/authoring/functional-hall-house-v4/fire-r1/fire-runtime-artifact-draft.json",
  contractV2: "assets/buildings/authoring/functional-hall-house-v4/fire-r2/fire-runtime-contract.json",
  artifactV2: "assets/buildings/authoring/functional-hall-house-v4/fire-r2/fire-runtime-artifact-draft.json",
  contractV3: "assets/buildings/authoring/functional-hall-house-v4/fire-r3/fire-runtime-contract.json",
  artifactV3: "assets/buildings/authoring/functional-hall-house-v4/fire-r3/fire-runtime-artifact-draft.json",
  contractV4: "assets/buildings/authoring/functional-hall-house-v4/fire-r4/fire-runtime-contract.json",
  artifactV4: "assets/buildings/authoring/functional-hall-house-v4/fire-r4/fire-runtime-artifact-draft.json",
  runtime: "js/src/render/building-fire-runtime.ts",
  renderBinding: "js/src/render/building-fire-render-binding.ts",
  volumetric: "js/src/render/building-fire-volumetric.ts",
  c1Authority: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/review-authority-v2.json",
  c1Artifact: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/composition-artifact-approved.json",
  c1Decision: "assets/qc/internal/compositions/functional-hall-house-v4-c1-r3-v2/review-decision-approve.json",
  c1Glb: "assets/buildings/authoring/functional-hall-house-v4/composition-r3/furnished-c1-r3.glb",
});
const rawHash = (bytes: Uint8Array): Hash => `sha256:${sha256(bytes)}`;
const exact = (value: unknown, keys: readonly string[], label: string): void => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value); for (const key of keys) if (!actual.includes(key)) throw new TypeError(`${label}.${key} is required`);
  for (const key of actual) if (!keys.includes(key)) throw new TypeError(`${label}.${key} is unsupported`);
};
const hash = (value: unknown, label: string): void => { if (typeof value !== "string" || !HASH.test(value)) throw new TypeError(`${label} must be lowercase sha256`); };
const path = (value: unknown, label: string): void => { if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")) throw new TypeError(`${label} must be repository-relative`); };
const integer = (value: unknown, min: number, max: number, label: string): void => { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new TypeError(`${label} must be an integer within [${min}, ${max}]`); };
const file = (value: unknown, label: string): void => { exact(value, ["path", "sha256"], label); const record = value as ExactFile; path(record.path, `${label}.path`); hash(record.sha256, `${label}.sha256`); };
const vec3 = (value: unknown, label: string): void => { if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) throw new TypeError(`${label} must be a finite vec3`); };
const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
const cloneFreeze = <T>(value: T): T => { const clone = JSON.parse(JSON.stringify(value)) as T; const freeze = (item: unknown): void => { if (item && typeof item === "object" && !Object.isFrozen(item)) { Object.freeze(item); for (const child of Object.values(item)) freeze(child); } }; freeze(clone); return clone; };

function validateFrame(value: unknown, index: number): void {
  const label = `evidenceFrames[${index}]`; exact(value, ["ordinal", "id", "viewId", "sampleId", "tick", "phase", "purpose", "camera"], label);
  const frame = value as BuildingFireReviewFrame; if (frame.ordinal !== index || frame.id !== BUILDING_FIRE_REVIEW_FRAME_IDS[index]) throw new TypeError(`${label} is not in the canonical evidence order`);
  if (!new Set(["hearth-motion", "fuel-detail", "reflected-light"]).has(frame.viewId)) throw new TypeError(`${label}.viewId is unsupported`);
  if (typeof frame.sampleId !== "string" || !frame.sampleId || !new Set(["off", "igniting", "burning", "extinguishing"]).has(frame.phase)) throw new TypeError(`${label} sample identity is invalid`);
  integer(frame.tick, 0, 10_000_000, `${label}.tick`); if (!new Set(["motion-sequence", "fuel-detail", "reflected-light-off", "reflected-light-on"]).has(frame.purpose)) throw new TypeError(`${label}.purpose is unsupported`);
  exact(frame.camera, ["position", "target", "fovDeg"], `${label}.camera`); vec3(frame.camera.position, `${label}.camera.position`); vec3(frame.camera.target, `${label}.camera.target`);
  if (!Number.isFinite(frame.camera.fovDeg) || frame.camera.fovDeg < 20 || frame.camera.fovDeg > 90) throw new TypeError(`${label}.camera.fovDeg is invalid`);
}

export function validateBuildingFireReviewAuthority(input: unknown): BuildingFireReviewAuthority {
  const value = cloneFreeze(input) as BuildingFireReviewAuthority;
  exact(value, ["schema", "gate", "approvalPolicy", "fireStage", "fuel", "runtimeSources", "visualContext", "presentation", "evidenceFrames", "metrics"], "fire review authority");
  const revision = value.schema === BUILDING_FIRE_REVIEW_AUTHORITY_V4_SCHEMA ? 4 : value.schema === BUILDING_FIRE_REVIEW_AUTHORITY_V3_SCHEMA ? 3 : value.schema === BUILDING_FIRE_REVIEW_AUTHORITY_V2_SCHEMA ? 2 : value.schema === BUILDING_FIRE_REVIEW_AUTHORITY_SCHEMA ? 1 : 0;
  const isVolume = revision >= 2;
  if (revision === 0 || value.gate !== "V1-vfx") throw new TypeError("unsupported V1 fire review authority identity");
  exact(value.approvalPolicy, ["renderer", "blenderApprovalProhibited", "nonEngineApprovalProhibited", "humanDecisionRequired", "guardSchema", "timestampQueriesEnabled"], "approvalPolicy");
  if (value.approvalPolicy.renderer !== "limina-production-native-engine" || value.approvalPolicy.blenderApprovalProhibited !== true || value.approvalPolicy.nonEngineApprovalProhibited !== true || value.approvalPolicy.humanDecisionRequired !== true || value.approvalPolicy.guardSchema !== "limina.nvidia-xid-guard/v1" || value.approvalPolicy.timestampQueriesEnabled !== false) throw new TypeError("V1 approval requires guarded native-engine HITL with timestamps disabled");
  exact(value.fireStage, ["contract", "artifact"], "fireStage");
  exact(value.fireStage.contract, ["path", "sha256", "packageId", "revision", "canonicalHash"], "fireStage.contract"); file({ path: value.fireStage.contract.path, sha256: value.fireStage.contract.sha256 }, "fireStage.contract"); hash(value.fireStage.contract.canonicalHash, "fireStage.contract.canonicalHash");
  const artifactId = `fire/functional-hall-house-v4/r${revision}`;
  if (value.fireStage.contract.packageId !== `fire/functional-hall-house-v4/v${revision}` || value.fireStage.contract.revision !== revision) throw new TypeError("fireStage.contract identity is invalid");
  exact(value.fireStage.artifact, ["path", "sha256", "artifactId", "kind", "revision", "status", "contractHash", "contentHash"], "fireStage.artifact"); file({ path: value.fireStage.artifact.path, sha256: value.fireStage.artifact.sha256 }, "fireStage.artifact"); hash(value.fireStage.artifact.contractHash, "fireStage.artifact.contractHash"); hash(value.fireStage.artifact.contentHash, "fireStage.artifact.contentHash");
  if (value.fireStage.artifact.artifactId !== artifactId || value.fireStage.artifact.kind !== "fire-runtime" || value.fireStage.artifact.revision !== revision || value.fireStage.artifact.status !== "draft" || value.fireStage.artifact.contractHash !== value.fireStage.contract.canonicalHash || value.fireStage.artifact.contentHash !== value.fireStage.contract.sha256) throw new TypeError("fireStage artifact/contract identity drifted");
  const contractPath = revision === 4 ? EXACT_PATHS.contractV4 : revision === 3 ? EXACT_PATHS.contractV3 : revision === 2 ? EXACT_PATHS.contractV2 : EXACT_PATHS.contract;
  const artifactPath = revision === 4 ? EXACT_PATHS.artifactV4 : revision === 3 ? EXACT_PATHS.artifactV3 : revision === 2 ? EXACT_PATHS.artifactV2 : EXACT_PATHS.artifact;
  if (value.fireStage.contract.path !== contractPath || value.fireStage.artifact.path !== artifactPath) throw new TypeError(`fireStage paths are not the exact fire-r${revision} closure`);
  exact(value.fuel, ["buildEvidence", "sourceBlend", "runtimeGlb"], "fuel"); for (const key of ["buildEvidence", "sourceBlend", "runtimeGlb"] as const) file(value.fuel[key], `fuel.${key}`);
  if (!value.fuel.sourceBlend.path.endsWith(".blend") || !value.fuel.runtimeGlb.path.endsWith(".glb")) throw new TypeError("fuel source extensions are invalid");
  exact(value.runtimeSources, isVolume ? ["runtime", "renderBinding", "volumetric"] : ["runtime", "renderBinding"], "runtimeSources"); file(value.runtimeSources.runtime, "runtimeSources.runtime"); file(value.runtimeSources.renderBinding, "runtimeSources.renderBinding");
  if (value.runtimeSources.runtime.path !== EXACT_PATHS.runtime || value.runtimeSources.renderBinding.path !== EXACT_PATHS.renderBinding) throw new TypeError("runtime source paths are unsupported");
  if (isVolume) { file(value.runtimeSources.volumetric, "runtimeSources.volumetric"); if (value.runtimeSources.volumetric?.path !== EXACT_PATHS.volumetric) throw new TypeError("volumetric runtime source path is unsupported"); }
  exact(value.visualContext, ["contentDependency", "purpose", "reviewAuthority", "approvedArtifact", "approvalDecision", "integratedGlb"], "visualContext");
  if (value.visualContext.contentDependency !== false || value.visualContext.purpose !== "approved-c1-r3-v2-visual-context-only") throw new TypeError("C1 may only be non-content visual context");
  file(value.visualContext.reviewAuthority, "visualContext.reviewAuthority"); exact(value.visualContext.approvedArtifact, ["path", "sha256", "artifactId", "revision", "status"], "visualContext.approvedArtifact"); file({ path: value.visualContext.approvedArtifact.path, sha256: value.visualContext.approvedArtifact.sha256 }, "visualContext.approvedArtifact");
  if (value.visualContext.approvedArtifact.artifactId !== "composition/functional-hall-house-v4/r3" || value.visualContext.approvedArtifact.revision !== 3 || value.visualContext.approvedArtifact.status !== "approved") throw new TypeError("visualContext is not approved C1 r3");
  exact(value.visualContext.approvalDecision, ["path", "sha256", "decisionId"], "visualContext.approvalDecision"); file({ path: value.visualContext.approvalDecision.path, sha256: value.visualContext.approvalDecision.sha256 }, "visualContext.approvalDecision"); if (!value.visualContext.approvalDecision.decisionId) throw new TypeError("visualContext approval decision is incomplete"); file(value.visualContext.integratedGlb, "visualContext.integratedGlb");
  if (value.visualContext.reviewAuthority.path !== EXACT_PATHS.c1Authority || value.visualContext.approvedArtifact.path !== EXACT_PATHS.c1Artifact || value.visualContext.approvalDecision.path !== EXACT_PATHS.c1Decision || value.visualContext.integratedGlb.path !== EXACT_PATHS.c1Glb) throw new TypeError("visualContext is not the exact C1 r3 v2 closure");
  exact(value.presentation, ["minimumResolution", "warmupFrames", "pixelFormat", "rowOrigin"], "presentation"); if (!Array.isArray(value.presentation.minimumResolution) || value.presentation.minimumResolution.length !== 2 || value.presentation.minimumResolution[0] < 1920 || value.presentation.minimumResolution[1] < 1080 || value.presentation.pixelFormat !== "rgba8unorm" || value.presentation.rowOrigin !== "top-left") throw new TypeError("V1 presentation policy is invalid"); integer(value.presentation.warmupFrames, 1, 120, "presentation.warmupFrames");
  if (!Array.isArray(value.evidenceFrames) || value.evidenceFrames.length !== 11) throw new TypeError("V1 authority requires exactly 11 evidence frames"); value.evidenceFrames.forEach(validateFrame);
  const expectedPurposes = ["motion-sequence", "motion-sequence", "motion-sequence", "motion-sequence", "motion-sequence", "motion-sequence", "motion-sequence", "motion-sequence", "fuel-detail", "reflected-light-off", "reflected-light-on"];
  if (JSON.stringify(value.evidenceFrames.map(({ purpose }) => purpose)) !== JSON.stringify(expectedPurposes)) throw new TypeError("V1 evidence purposes drifted");
  exact(value.metrics, isVolume ? ["silhouetteVariation", "fuelDetailFrameId", "reflectedLightPair", "exposure", "volumeProof"] : ["silhouetteVariation", "fuelDetailFrameId", "reflectedLightPair", "exposure"], "metrics"); exact(value.metrics.silhouetteVariation, ["required", "frameIds"], "metrics.silhouetteVariation");
  if (value.metrics.silhouetteVariation.required !== true || JSON.stringify(value.metrics.silhouetteVariation.frameIds) !== JSON.stringify(["hearth-motion--burn-a", "hearth-motion--burn-b", "hearth-motion--burn-c", "hearth-motion--burn-d"]) || value.metrics.fuelDetailFrameId !== "fuel-detail--burn-a") throw new TypeError("V1 silhouette/fuel evidence metric drifted");
  exact(value.metrics.reflectedLightPair, ["required", "offFrameId", "onFrameId"], "metrics.reflectedLightPair"); if (value.metrics.reflectedLightPair.required !== true || value.metrics.reflectedLightPair.offFrameId !== "reflected-light--off-initial" || value.metrics.reflectedLightPair.onFrameId !== "reflected-light--burn-a") throw new TypeError("V1 reflected-light pair drifted");
  exact(value.metrics.exposure, ["pairedOffOn", "maxClippedPixelFraction", "maxChannelP99"], "metrics.exposure"); if (value.metrics.exposure.pairedOffOn !== true || !Number.isFinite(value.metrics.exposure.maxClippedPixelFraction) || value.metrics.exposure.maxClippedPixelFraction < 0 || value.metrics.exposure.maxClippedPixelFraction > .01 || !Number.isFinite(value.metrics.exposure.maxChannelP99) || value.metrics.exposure.maxChannelP99 < .8 || value.metrics.exposure.maxChannelP99 > .995) throw new TypeError("V1 exposure metric is invalid");
  if (isVolume) {
    const proof = value.metrics.volumeProof; exact(proof, ["required", "representation", "primaryFrameIds", "multiViewFrameIds", "minimumChangedPixels", "minimumJaccardDistance", "maximumOcclusionLeakFraction"], "metrics.volumeProof");
    if (proof?.required !== true || proof.representation !== "three-fire-derived-volume-raymarch/v1" || JSON.stringify(proof.primaryFrameIds) !== JSON.stringify(["hearth-motion--burn-a", "hearth-motion--burn-b", "hearth-motion--burn-c", "hearth-motion--burn-d"]) || JSON.stringify(proof.multiViewFrameIds) !== JSON.stringify(["hearth-motion--burn-a", "fuel-detail--burn-a"])) throw new TypeError("V1 volumetric evidence frame policy drifted");
    integer(proof.minimumChangedPixels, 256, 10_000_000, "metrics.volumeProof.minimumChangedPixels");
    if (!Number.isFinite(proof.minimumJaccardDistance) || proof.minimumJaccardDistance < .001 || proof.minimumJaccardDistance > .5 || !Number.isFinite(proof.maximumOcclusionLeakFraction) || proof.maximumOcclusionLeakFraction < 0 || proof.maximumOcclusionLeakFraction > .01) throw new TypeError("V1 volumetric evidence thresholds are invalid");
  }
  return value;
}

function exactBytes(entry: ExactFile, read: (path: string) => Uint8Array, label: string): Uint8Array { const bytes = read(entry.path); if (!(bytes instanceof Uint8Array) || rawHash(bytes) !== entry.sha256) throw new Error(`${label} bytes drifted`); return bytes; }
function expectedFrames(contract: ReturnType<typeof validateBuildingFireRuntimeV1> | ReturnType<typeof validateBuildingFireRuntimeV2>): readonly BuildingFireReviewFrame[] {
  const samples = new Map(contract.evidenceContract.sampleTicks.map((sample: any) => [sample.id, sample])); const views = new Map(contract.evidenceContract.views.map((view: any) => [view.id, view]));
  const frame = (ordinal: number, viewId: BuildingFireReviewFrame["viewId"], sampleId: string, purpose: BuildingFireReviewFrame["purpose"]): BuildingFireReviewFrame => { const sample: any = samples.get(sampleId), view: any = views.get(viewId); if (!sample || !view) throw new Error(`contract lacks ${viewId}/${sampleId}`); return { ordinal, id: `${viewId}--${sampleId}` as BuildingFireReviewFrame["id"], viewId, sampleId, tick: sample.tick, phase: sample.phase, purpose, camera: { position: view.position, target: view.target, fovDeg: view.fovDeg } }; };
  const motion = contract.evidenceContract.sampleTicks.map((sample: any, index: number) => frame(index, "hearth-motion", sample.id, "motion-sequence"));
  return Object.freeze([...motion, frame(8, "fuel-detail", "burn-a", "fuel-detail"), frame(9, "reflected-light", "off-initial", "reflected-light-off"), frame(10, "reflected-light", "burn-a", "reflected-light-on")]);
}

export function verifyBuildingFireReviewClosure(input: unknown, read: (path: string) => Uint8Array) {
  const authority = validateBuildingFireReviewAuthority(input), revision = authority.fireStage.contract.revision, isVolume = revision >= 2;
  const contractBytes = exactBytes(authority.fireStage.contract, read, "V1 contract"), contract = isVolume ? validateBuildingFireRuntimeV2(decode(contractBytes)) : validateBuildingFireRuntimeV1(decode(contractBytes));
  const canonicalHash = isVolume ? buildingFireRuntimeV2Hash(contract) : buildingFireRuntimeV1Hash(contract);
  if (contract.packageId !== authority.fireStage.contract.packageId || contract.revision !== revision || canonicalHash !== authority.fireStage.contract.canonicalHash) throw new Error("V1 contract canonical identity drifted");
  const artifactBytes = exactBytes(authority.fireStage.artifact, read, "V1 draft artifact"), artifact = validateBuildingStageArtifact(decode(artifactBytes));
  if (artifact.artifactId !== authority.fireStage.artifact.artifactId || artifact.kind !== "fire-runtime" || artifact.revision !== revision || artifact.status !== "draft" || artifact.contractHash !== authority.fireStage.contract.canonicalHash || artifact.contentHash !== authority.fireStage.contract.sha256 || artifact.metadata?.contract?.path !== authority.fireStage.contract.path || artifact.metadata?.contract?.sha256 !== authority.fireStage.contract.sha256 || artifact.metadata?.hearthFuel?.buildEvidence?.path !== authority.fuel.buildEvidence.path || artifact.metadata?.hearthFuel?.buildEvidence?.sha256 !== authority.fuel.buildEvidence.sha256 || artifact.metadata?.hearthFuel?.sourceBlend?.path !== authority.fuel.sourceBlend.path || artifact.metadata?.hearthFuel?.sourceBlend?.sha256 !== authority.fuel.sourceBlend.sha256 || artifact.metadata?.hearthFuel?.runtimeGlb?.path !== authority.fuel.runtimeGlb.path || artifact.metadata?.hearthFuel?.runtimeGlb?.sha256 !== authority.fuel.runtimeGlb.sha256 || artifact.metadata?.runtimeAuthority?.timestampQueriesEnabled !== false) throw new Error("V1 draft artifact closure drifted");
  const buildEvidence = decode(exactBytes(authority.fuel.buildEvidence, read, "V1 fuel build evidence")) as any, blendBytes = exactBytes(authority.fuel.sourceBlend, read, "V1 fuel source blend"), glbBytes = exactBytes(authority.fuel.runtimeGlb, read, "V1 fuel runtime GLB");
  if (buildEvidence.schema !== "limina.hearth-fuel-build-evidence/v1" || buildEvidence.status !== "cpu-authored-unreviewed" || buildEvidence.rendered !== false || buildEvidence.gpuUsed !== false || buildEvidence.sourceBlend?.path !== authority.fuel.sourceBlend.path || buildEvidence.sourceBlend?.sha256 !== rawHash(blendBytes) || buildEvidence.asset?.path !== authority.fuel.runtimeGlb.path || buildEvidence.asset?.sha256 !== rawHash(glbBytes) || contract.fuelAsset.sourceBlend.path !== authority.fuel.sourceBlend.path || contract.fuelAsset.sourceBlend.sha256 !== authority.fuel.sourceBlend.sha256 || contract.fuelAsset.runtimeGlb.path !== authority.fuel.runtimeGlb.path || contract.fuelAsset.runtimeGlb.sha256 !== authority.fuel.runtimeGlb.sha256) throw new Error("V1 fuel closure drifted");
  exactBytes(authority.runtimeSources.runtime, read, "V1 runtime source"); exactBytes(authority.runtimeSources.renderBinding, read, "V1 render-binding source");
  if (isVolume) exactBytes(authority.runtimeSources.volumetric!, read, "V1 volumetric source");
  const c1Authority = validateBuildingCompositionReviewAuthority(decode(exactBytes(authority.visualContext.reviewAuthority, read, "C1 r3 v2 review authority"))), c1Artifact = validateBuildingStageArtifact(decode(exactBytes(authority.visualContext.approvedArtifact, read, "C1 r3 approved artifact"))), c1Decision = validateBuildingHitlDecision(decode(exactBytes(authority.visualContext.approvalDecision, read, "C1 r3 approval decision")));
  const c1Glb = exactBytes(authority.visualContext.integratedGlb, read, "C1 r3 visual-context GLB");
  const evidenceHashes = c1Artifact.evidence.map((entry: any) => entry.contentHash).sort();
  if (c1Artifact.artifactId !== "composition/functional-hall-house-v4/r3" || c1Artifact.kind !== "composition" || c1Artifact.revision !== 3 || c1Artifact.status !== "approved" || c1Artifact.metadata?.fireExcluded !== true || c1Artifact.metadata?.authority?.path !== authority.visualContext.reviewAuthority.path || c1Artifact.metadata?.authority?.sha256 !== authority.visualContext.reviewAuthority.sha256 || c1Artifact.metadata?.approval?.path !== authority.visualContext.approvalDecision.path || c1Artifact.metadata?.approval?.sha256 !== authority.visualContext.approvalDecision.sha256 || c1Decision.decision !== "approve" || c1Decision.gate !== "C1-composition" || c1Decision.decisionId !== authority.visualContext.approvalDecision.decisionId || c1Decision.artifactId !== c1Artifact.artifactId || c1Decision.contractHash !== c1Artifact.contractHash || c1Decision.contentHash !== c1Artifact.contentHash || c1Decision.blockingFindings.length !== 0 || JSON.stringify([...c1Decision.evidenceHashes].sort()) !== JSON.stringify(evidenceHashes) || c1Authority.approvalPolicy.fireExcluded !== true || c1Authority.integratedSource.glb.path !== authority.visualContext.integratedGlb.path || c1Authority.integratedSource.glb.sha256 !== rawHash(c1Glb) || c1Artifact.contentHash !== rawHash(c1Glb)) throw new Error("C1 r3 v2 approved non-content visual context drifted");
  if (JSON.stringify(authority.evidenceFrames) !== JSON.stringify(expectedFrames(contract)) || JSON.stringify(authority.presentation.minimumResolution) !== JSON.stringify(contract.evidenceContract.minimumResolution) || JSON.stringify(authority.metrics.exposure) !== JSON.stringify(contract.evidenceContract.exposure)) throw new Error("V1 review evidence no longer matches the contract");
  return Object.freeze({ authority, contract, artifact, buildEvidence, c1Authority, c1Artifact, c1Decision });
}

export function buildingFireReviewExpectedFrames(contractInput: unknown): readonly BuildingFireReviewFrame[] {
  const value = contractInput as { schema?: string }; return cloneFreeze(expectedFrames(value?.schema === "limina.building-fire-runtime/v2" ? validateBuildingFireRuntimeV2(contractInput) : validateBuildingFireRuntimeV1(contractInput)));
}
