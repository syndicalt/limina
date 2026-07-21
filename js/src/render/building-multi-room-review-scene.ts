import { AssetRegistry } from "../asset-registry.ts";
import { LiminaTracer } from "../observability/event.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { verifyBuildingArticulationCpuProxyEvidence } from "../architecture/building-articulation-cpu-proxy.ts";
import { sha256 } from "../world/sha256.mjs";
import {
  validateBuildingSiteReviewEnvelope,
  type BuildingSiteReviewEnvelope,
} from "./building-site-review-envelope.ts";
import {
  BUILDING_SEMANTIC_CLAIM_IDS,
  validateBuildingSemanticEvidence,
  verifyBuildingSemanticEvidence,
} from "./building-semantic-evidence.ts";

type V3 = readonly [number, number, number];
export type MultiRoomReviewViewId =
  | "exterior-entry"
  | "exterior-rear"
  | "gable-elevation"
  | "frame-entry-window-detail"
  | "ground-rooms-passage"
  | "stair-opening"
  | "upper-room"
  | "lod-25m";
type ViewId = MultiRoomReviewViewId;
type ExactReviewFile = {
  readonly path: string;
  readonly sha256: string;
  readonly contentHash: string;
  readonly bytes: number;
};
export const FB4_V4_SEMANTIC_VIEW_MAPPING = Object.freeze([
  { claimId: "gable-upper-window", reviewViewId: "gable-elevation" },
  { claimId: "entry-canopy", reviewViewId: "frame-entry-window-detail" },
  { claimId: "passage-fireplace", reviewViewId: "ground-rooms-passage" },
  { claimId: "stair-circulation", reviewViewId: "stair-opening" },
  { claimId: "upper-circulation", reviewViewId: "upper-room" },
] as const);
export interface MultiRoomReviewAuthority {
  readonly schema:
    | "limina.fb4-multi-room-review-authority/v2"
    | "limina.fb4-multi-room-review-authority/v3"
    | "limina.fb4-multi-room-review-authority/v4";
  readonly candidate: {
    readonly candidateId?: string;
    readonly architectureId?: string;
    readonly manifest: {
      readonly path: string;
      readonly sha256: string;
      readonly contentHash?: string;
      readonly bytes?: number;
    };
    readonly glb: {
      readonly path: string;
      readonly sha256: string;
      readonly contentHash: string;
      readonly bytes: number;
    };
    readonly architectureIr?: ExactReviewFile;
    readonly specHash?: string;
    readonly irHash: string;
  };
  readonly visualFloor: {
    readonly referenceSetId: "project-gorgon/house/v1";
    readonly releaseContract: { readonly path: string; readonly sha256: string };
    readonly belowFloorPresentationProhibited: true;
    readonly humanApprovalRequired: true;
  };
  readonly environment: {
    readonly authority: { readonly path: string; readonly sha256: string };
    readonly runtimeBundle: { readonly path: string; readonly sha256: string };
    readonly shot: "river-leading-line";
    readonly context: "approved-temperate-production";
  };
  readonly placement: { readonly position: V3; readonly yaw: number };
  readonly topologyProof: {
    readonly fromRoomId: string;
    readonly toRoomId: string;
    readonly roomIds: readonly string[];
    readonly connectionIds: readonly string[];
    readonly expectedDoors: number;
    readonly expectedAnchors: number;
  };
  readonly presentation: {
    readonly minimumResolution: readonly [number, number];
    readonly fixedTimeSeconds: number;
    readonly warmupFrames: number;
    readonly timestampQueriesEnabled: false;
  };
  readonly evidenceViews: readonly {
    readonly id: ViewId;
    readonly role: string;
    readonly camera: {
      readonly position: V3;
      readonly target: V3;
      readonly fovDeg: number;
      readonly near: number;
      readonly far: number;
    };
  }[];
  readonly approval: {
    readonly renderer: "limina-production-native-engine";
    readonly humanDecision: "pending";
    readonly visualApprovalClaimed: false;
    readonly nonEngineApprovalProhibited: true;
  };
  readonly siteReviewEnvelope?: BuildingSiteReviewEnvelope;
  /** V3-only, append-only CPU evidence. It proves mechanical legibility, never visual quality. */
  readonly articulationEvidence?: { readonly path: string; readonly sha256: string; readonly contentHash: string };
  /** V3-only exact byte authority for the inline site-review envelope. */
  readonly siteReviewEnvelopeAuthority?: {
    readonly path: string;
    readonly sha256: string;
    readonly contentHash: string;
  };
  /** V3-only CPU site-fit, camera-domain, and resident-terrain evidence. */
  readonly siteReviewEvidence?: { readonly path: string; readonly sha256: string; readonly contentHash: string };
  readonly cameraSetHash?: string;
  readonly reviewToolClosureHash?: string;
  /** V4-only exact, mechanically passing compiler-IR/GLB semantic evidence. */
  readonly semanticEvidence?: ExactReviewFile;
  /** V4-only exact binding from the canonical semantic claims to engine review views. */
  readonly semanticViewMapping?: readonly {
    readonly claimId: string;
    readonly semanticViewId: string;
    readonly reviewViewId: ViewId;
  }[];
}
const HASH = /^sha256:[0-9a-f]{64}$/;
const vec = (v: unknown): v is V3 => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
export function validateMultiRoomReviewAuthority(value: unknown): MultiRoomReviewAuthority {
  const a = value as MultiRoomReviewAuthority;
  if (
    ![
      "limina.fb4-multi-room-review-authority/v2",
      "limina.fb4-multi-room-review-authority/v3",
      "limina.fb4-multi-room-review-authority/v4",
    ].includes(a?.schema) ||
    !HASH.test(a.candidate?.manifest?.sha256) ||
    !HASH.test(a.candidate?.glb?.sha256) ||
    !HASH.test(a.candidate?.glb?.contentHash) ||
    !HASH.test(a.candidate?.irHash) ||
    !Number.isSafeInteger(a.candidate?.glb?.bytes) ||
    a.candidate.glb.bytes < 1
  )
    throw new Error("invalid FB-4 candidate authority");
  if (
    a.visualFloor?.referenceSetId !== "project-gorgon/house/v1" ||
    a.visualFloor.belowFloorPresentationProhibited !== true ||
    a.visualFloor.humanApprovalRequired !== true ||
    !HASH.test(a.visualFloor.releaseContract?.sha256)
  )
    throw new Error("FB-4 review lost the locked visual floor");
  if (
    a.environment?.shot !== "river-leading-line" ||
    a.environment.context !== "approved-temperate-production" ||
    !HASH.test(a.environment.authority?.sha256) ||
    !HASH.test(a.environment.runtimeBundle?.sha256)
  )
    throw new Error("FB-4 review lost approved production environment");
  if (
    !vec(a.placement?.position) ||
    !Number.isFinite(a.placement?.yaw) ||
    a.presentation?.timestampQueriesEnabled !== false ||
    a.presentation.minimumResolution[0] < 1920 ||
    a.presentation.minimumResolution[1] < 1080 ||
    a.approval?.humanDecision !== "pending" ||
    a.approval.visualApprovalClaimed !== false ||
    a.approval.nonEngineApprovalProhibited !== true
  )
    throw new Error("FB-4 presentation/approval policy drifted");
  if (
    !a.topologyProof?.fromRoomId ||
    !a.topologyProof.toRoomId ||
    a.topologyProof.roomIds?.length < 2 ||
    a.topologyProof.connectionIds?.length !== a.topologyProof.roomIds.length - 1 ||
    !Number.isSafeInteger(a.topologyProof.expectedDoors) ||
    a.topologyProof.expectedDoors < 1 ||
    !Number.isSafeInteger(a.topologyProof.expectedAnchors) ||
    a.topologyProof.expectedAnchors < 1
  )
    throw new Error("FB-4 topology proof is incomplete");
  if (
    a.evidenceViews?.map((v) => v.id).join(",") !==
    "exterior-entry,exterior-rear,gable-elevation,frame-entry-window-detail,ground-rooms-passage,stair-opening,upper-room,lod-25m"
  )
    throw new Error("FB-4 evidence cameras are incomplete");
  // Mechanical semantic cameras and human visual-review cameras are deliberately
  // separate authorities. The latter remain photographically bounded; a wide CPU
  // diagnostic must never silently lower the engine HITL presentation floor.
  for (const view of a.evidenceViews)
    if (
      !view.role ||
      !vec(view.camera.position) ||
      !vec(view.camera.target) ||
      view.camera.fovDeg < 20 ||
      view.camera.fovDeg > 85 ||
      view.camera.near <= 0 ||
      view.camera.far <= view.camera.near
    )
      throw new Error(`invalid FB-4 camera ${view.id}`);
  if (
    a.schema === "limina.fb4-multi-room-review-authority/v3" ||
    a.schema === "limina.fb4-multi-room-review-authority/v4"
  ) {
    validateBuildingSiteReviewEnvelope(a.siteReviewEnvelope);
    for (const [name, entry] of [
      ["articulation", a.articulationEvidence],
      ["site envelope", a.siteReviewEnvelopeAuthority],
      ["site review", a.siteReviewEvidence],
    ] as const)
      if (!entry?.path || !HASH.test(entry.sha256) || !HASH.test(entry.contentHash))
        throw new Error(`FB-4 V3 ${name} evidence is invalid`);
    if (!HASH.test(a.cameraSetHash ?? "") || !HASH.test(a.reviewToolClosureHash ?? ""))
      throw new Error("FB-4 V3 camera/tool closure is invalid");
    if (a.schema === "limina.fb4-multi-room-review-authority/v4") {
      const exact = (entry: ExactReviewFile | undefined) =>
        entry !== undefined &&
        !!entry.path &&
        HASH.test(entry.sha256) &&
        HASH.test(entry.contentHash) &&
        Number.isSafeInteger(entry.bytes) &&
        entry.bytes > 0;
      if (
        !a.candidate.candidateId ||
        !a.candidate.architectureId ||
        !HASH.test(a.candidate.specHash ?? "") ||
        !exact(a.candidate.manifest as ExactReviewFile) ||
        !exact(a.candidate.architectureIr) ||
        !exact(a.semanticEvidence) ||
        a.topologyProof.expectedAnchors !== 6
      )
        throw new Error("FB-4 V4 exact candidate/semantic authority is incomplete");
      const mapping = a.semanticViewMapping;
      if (
        !Array.isArray(mapping) ||
        mapping.length !== FB4_V4_SEMANTIC_VIEW_MAPPING.length ||
        mapping.map((entry) => entry.claimId).join(",") !== BUILDING_SEMANTIC_CLAIM_IDS.join(",") ||
        new Set(mapping.map((entry) => entry.semanticViewId)).size !== mapping.length ||
        mapping.some((entry, index) => entry.reviewViewId !== FB4_V4_SEMANTIC_VIEW_MAPPING[index].reviewViewId)
      )
        throw new Error("FB-4 V4 semantic/review view mapping is incomplete");
      const reviewIds = new Set(a.evidenceViews.map((view) => view.id));
      if (mapping.some((entry) => !reviewIds.has(entry.reviewViewId)))
        throw new Error("FB-4 V4 semantic mapping names an absent review camera");
    } else if (
      a.candidate.architectureIr !== undefined ||
      a.semanticEvidence !== undefined ||
      a.semanticViewMapping !== undefined
    )
      throw new Error("FB-4 V3 authority cannot claim V4 semantic closure");
  } else if (
    a.siteReviewEnvelope !== undefined ||
    a.articulationEvidence !== undefined ||
    a.siteReviewEnvelopeAuthority !== undefined ||
    a.siteReviewEvidence !== undefined ||
    a.cameraSetHash !== undefined ||
    a.reviewToolClosureHash !== undefined ||
    a.candidate.architectureIr !== undefined ||
    a.semanticEvidence !== undefined ||
    a.semanticViewMapping !== undefined
  )
    throw new Error("FB-4 V2 authority cannot claim later site/semantic guarantees");
  return Object.freeze(a);
}
export type CaptureReadyMultiRoomReviewAuthority = MultiRoomReviewAuthority & {
  readonly schema: "limina.fb4-multi-room-review-authority/v4";
  readonly siteReviewEnvelope: BuildingSiteReviewEnvelope;
  readonly semanticEvidence: ExactReviewFile;
  readonly candidate: MultiRoomReviewAuthority["candidate"] & { readonly architectureIr: ExactReviewFile };
};
export function assertMultiRoomReviewCaptureReady(
  value: MultiRoomReviewAuthority,
): CaptureReadyMultiRoomReviewAuthority {
  if (
    value.schema !== "limina.fb4-multi-room-review-authority/v4" ||
    value.siteReviewEnvelope === undefined ||
    value.semanticEvidence === undefined ||
    value.candidate.architectureIr === undefined
  )
    throw new Error(
      "FB-4 V2/V3 review authority is historical only; exact V4 semantic/site closure is required before GPU capture",
    );
  validateBuildingSiteReviewEnvelope(value.siteReviewEnvelope);
  return value as CaptureReadyMultiRoomReviewAuthority;
}
export interface Fb4ReviewDoorPose {
  readonly reviewViewId: ViewId;
  readonly openDoorIds: readonly string[];
}
/** Derive the native view-by-view articulation plan from the exact semantic claim binding.
 * This is deliberately total over all eight review views: an unmapped view has an explicit
 * closed-door pose, so state from an earlier interior evidence view can never leak forward. */
export function deriveFb4V4ReviewDoorPosePlan(
  authority: CaptureReadyMultiRoomReviewAuthority,
  semantic: any,
): readonly Fb4ReviewDoorPose[] {
  const policyClaims = semantic?.policy?.claims,
    claims = semantic?.claims,
    mapping = authority.semanticViewMapping;
  if (
    !Array.isArray(policyClaims) ||
    !Array.isArray(claims) ||
    policyClaims.map((claim: any) => claim.id).join(",") !== BUILDING_SEMANTIC_CLAIM_IDS.join(",") ||
    claims.map((claim: any) => claim.id).join(",") !== BUILDING_SEMANTIC_CLAIM_IDS.join(",")
  )
    throw new Error("FB-4 runtime door poses require canonical semantic claims");
  if (!Array.isArray(mapping) || mapping.length !== FB4_V4_SEMANTIC_VIEW_MAPPING.length)
    throw new Error("FB-4 runtime door poses require the exact semantic/review mapping");
  const byView = new Map<ViewId, readonly string[]>();
  for (let index = 0; index < mapping.length; index++) {
    const entry = mapping[index]!,
      canonical = FB4_V4_SEMANTIC_VIEW_MAPPING[index]!,
      policy = policyClaims[index],
      claim = claims[index];
    if (
      entry.claimId !== canonical.claimId ||
      entry.claimId !== policy.id ||
      entry.claimId !== claim.id ||
      entry.reviewViewId !== canonical.reviewViewId ||
      entry.semanticViewId !== policy.viewId ||
      entry.semanticViewId !== claim.viewId ||
      byView.has(entry.reviewViewId)
    )
      throw new Error(`FB-4 runtime door pose mapping drifted: ${entry.claimId}`);
    const requested = [...(policy.openDoorIds ?? [])];
    if (
      requested.some((id) => typeof id !== "string" || id.length === 0) ||
      new Set(requested).size !== requested.length
    )
      throw new Error(`FB-4 runtime door pose inventory is invalid: ${entry.claimId}`);
    const resolved = (claim.resolvedOpenDoorPoses ?? []).map((pose: any) => pose.doorId);
    if (JSON.stringify([...requested].sort()) !== JSON.stringify([...resolved].sort()))
      throw new Error(`FB-4 runtime door pose escaped exact semantic evidence: ${entry.claimId}`);
    byView.set(entry.reviewViewId, Object.freeze([...requested].sort()));
  }
  return Object.freeze(
    authority.evidenceViews.map((view) =>
      Object.freeze({ reviewViewId: view.id, openDoorIds: byView.get(view.id) ?? Object.freeze([]) }),
    ),
  );
}
export function resolveFb4V4ReviewDoorPosePlan(
  authorityValue: MultiRoomReviewAuthority,
  read: (path: string) => Uint8Array,
): readonly Fb4ReviewDoorPose[] {
  const authority = assertMultiRoomReviewCaptureReady(authorityValue),
    bytes = read(authority.semanticEvidence.path);
  if (
    bytes.byteLength !== authority.semanticEvidence.bytes ||
    `sha256:${sha256(bytes)}` !== authority.semanticEvidence.sha256 ||
    portableAssetContentHash(bytes) !== authority.semanticEvidence.contentHash
  )
    throw new Error("FB-4 runtime semantic door-pose authority drifted");
  const semantic = validateBuildingSemanticEvidence(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)));
  return deriveFb4V4ReviewDoorPosePlan(authority, semantic);
}
export function verifyMultiRoomReviewV4Closure(
  authorityValue: MultiRoomReviewAuthority,
  read: (path: string) => Uint8Array,
): void {
  const authority = assertMultiRoomReviewCaptureReady(authorityValue);
  verifyMultiRoomReviewV3Closure(authority, read);
  const exact = (entry: ExactReviewFile) => {
    const bytes = read(entry.path);
    if (
      bytes.byteLength !== entry.bytes ||
      `sha256:${sha256(bytes)}` !== entry.sha256 ||
      portableAssetContentHash(bytes) !== entry.contentHash
    )
      throw new Error(`FB-4 V4 closure drifted: ${entry.path}`);
    return bytes;
  };
  const manifestBytes = exact(authority.candidate.manifest as ExactReviewFile),
    manifest = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(manifestBytes));
  if (
    manifest.candidateId !== authority.candidate.candidateId ||
    manifest.status !== "cpu-verified-human-pending" ||
    manifest.gpuCaptureAtBuild !== false ||
    manifest.visualApprovalClaimed !== false ||
    manifest.compiler?.specHash !== authority.candidate.specHash ||
    manifest.compiler?.irHash !== authority.candidate.irHash
  )
    throw new Error("FB-4 V4 candidate manifest escaped exact CPU-only authority");
  const manifestGlb = manifest.files?.find((entry: { role?: string }) => entry.role === "productionGlb");
  if (
    manifestGlb?.path !== authority.candidate.glb.path ||
    manifestGlb.sha256 !== authority.candidate.glb.sha256 ||
    manifestGlb.contentHash !== authority.candidate.glb.contentHash ||
    manifestGlb.bytes !== authority.candidate.glb.bytes
  )
    throw new Error("FB-4 V4 manifest/GLB closure drifted");
  const architectureBytes = exact(authority.candidate.architectureIr),
    architecture = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(architectureBytes));
  if (
    architecture.schema !== "limina.blender-architecture-input/v1" ||
    architecture.compilerSchema !== "limina.architecture-compile/v1" ||
    architecture.specHash !== authority.candidate.specHash ||
    architecture.irHash !== authority.candidate.irHash ||
    architecture.functionalContract?.buildingId !== authority.candidate.architectureId
  )
    throw new Error("FB-4 V4 architecture IR closure drifted");
  const semantic = verifyBuildingSemanticEvidence(
    JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(exact(authority.semanticEvidence))),
    read,
  );
  if (
    semantic.mechanicalVerdict !== "pass" ||
    semantic.authority.candidateId !== authority.candidate.candidateId ||
    semantic.authority.architectureId !== authority.candidate.architectureId ||
    semantic.authority.architectureIr.path !== authority.candidate.architectureIr.path ||
    semantic.authority.architectureIr.sha256 !== authority.candidate.architectureIr.sha256 ||
    semantic.authority.productionGlb.path !== authority.candidate.glb.path ||
    semantic.authority.productionGlb.sha256 !== authority.candidate.glb.sha256
  )
    throw new Error("FB-4 V4 semantic evidence is not an exact passing candidate closure");
  for (let index = 0; index < authority.semanticViewMapping!.length; index++) {
    const mapping = authority.semanticViewMapping![index],
      claim = semantic.claims[index],
      policyClaim = semantic.policy.claims[index];
    if (
      mapping.claimId !== claim.id ||
      mapping.semanticViewId !== claim.viewId ||
      mapping.semanticViewId !== policyClaim.viewId ||
      mapping.reviewViewId !== FB4_V4_SEMANTIC_VIEW_MAPPING[index].reviewViewId
    )
      throw new Error(`FB-4 V4 semantic/review view mapping drifted: ${mapping.claimId}`);
  }
  // V3 closure independently replays the exact engine camera-set hash and site
  // containment/framing evidence. The mapping binds what the human view reviews;
  // it must not replace that visual camera with a CPU raycast diagnostic camera.
  deriveFb4V4ReviewDoorPosePlan(authority, semantic);
}
export function verifyMultiRoomReviewV3Closure(
  authorityValue: MultiRoomReviewAuthority,
  read: (path: string) => Uint8Array,
): void {
  const authority = authorityValue;
  if (
    !["limina.fb4-multi-room-review-authority/v3", "limina.fb4-multi-room-review-authority/v4"].includes(
      authority.schema,
    ) ||
    authority.siteReviewEnvelope === undefined
  )
    throw new Error("FB-4 V3 closure requires an exact V3/V4 site-review authority");
  validateBuildingSiteReviewEnvelope(authority.siteReviewEnvelope);
  const exact = (entry: { readonly path: string; readonly sha256: string; readonly contentHash?: string }) => {
    const bytes = read(entry.path);
    if (
      `sha256:${sha256(bytes)}` !== entry.sha256 ||
      (entry.contentHash !== undefined && portableAssetContentHash(bytes) !== entry.contentHash)
    )
      throw new Error(`FB-4 V3 closure drifted: ${entry.path}`);
    return bytes;
  };
  for (const entry of [
    authority.candidate.manifest,
    authority.candidate.glb,
    authority.visualFloor.releaseContract,
    authority.environment.authority,
    authority.environment.runtimeBundle,
    authority.articulationEvidence!,
    authority.siteReviewEnvelopeAuthority!,
    authority.siteReviewEvidence!,
  ])
    exact(entry);
  const envelope = JSON.parse(
    new TextDecoder("utf8", { fatal: true }).decode(exact(authority.siteReviewEnvelopeAuthority!)),
  );
  if (JSON.stringify(envelope) !== JSON.stringify(authority.siteReviewEnvelope))
    throw new Error("FB-4 inline site-review envelope drifted from its exact authority");
  const articulation = verifyBuildingArticulationCpuProxyEvidence(
    JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(exact(authority.articulationEvidence!))),
    read,
  );
  if (articulation.mechanicalVerdict !== "mechanically-sufficient-for-v3-site-review")
    throw new Error("FB-4 articulation evidence is not mechanically sufficient");
  const site = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(exact(authority.siteReviewEvidence!)));
  if (
    site.schema !== "limina.fb4-multi-room-site-review-evidence/v1" ||
    site.verdict !== "pass" ||
    site.renderingPerformed !== false ||
    site.gpuUsed !== false ||
    site.visualQualityClaimed !== false ||
    site.cameraSetHash !== authority.cameraSetHash ||
    site.reviewToolClosureHash !== authority.reviewToolClosureHash ||
    site.cameraEvidence?.views?.map((view: { id: string }) => view.id).join(",") !==
      authority.evidenceViews.map((view) => view.id).join(",")
  )
    throw new Error("FB-4 V3 site-review evidence is incomplete");
  const encoded = new TextEncoder(),
    raw = (bytes: Uint8Array) => `sha256:${sha256(bytes)}`;
  if (raw(encoded.encode(JSON.stringify(authority.evidenceViews))) !== authority.cameraSetHash)
    throw new Error("FB-4 V3 camera-set hash drifted from authority views");
  if (!Array.isArray(site.toolClosureFiles) || site.toolClosureFiles.length < 3)
    throw new Error("FB-4 V3 review tool closure is incomplete");
  for (const entry of site.toolClosureFiles) {
    const bytes = read(entry.path);
    if (bytes.byteLength !== entry.bytes || raw(bytes) !== entry.sha256)
      throw new Error(`FB-4 V3 review tool closure drifted: ${entry.path}`);
  }
  if (raw(encoded.encode(JSON.stringify(site.toolClosureFiles))) !== authority.reviewToolClosureHash)
    throw new Error("FB-4 V3 review tool closure hash drifted");
}
const success = (result: Awaited<ReturnType<SkillRegistry["invoke"]>>, name: string) => {
  if (!result.success) throw new Error(`${name} failed: ${JSON.stringify(result.error)}`);
  return result.result as Record<string, unknown>;
};
export async function mountMultiRoomReview(world: WorldContext, authority: MultiRoomReviewAuthority, rootY: number) {
  const captureAuthority = assertMultiRoomReviewCaptureReady(authority),
    doorPosePlan = resolveFb4V4ReviewDoorPosePlan(captureAuthority, (path) => world.ops.op_read_asset(path));
  const bytes = world.ops.op_read_asset(authority.candidate.glb.path);
  if (
    bytes.byteLength !== authority.candidate.glb.bytes ||
    `sha256:${sha256(bytes)}` !== authority.candidate.glb.sha256 ||
    portableAssetContentHash(bytes) !== authority.candidate.glb.contentHash
  )
    throw new Error("FB-4 production GLB exact bytes drifted");
  const manifestBytes = world.ops.op_read_asset(authority.candidate.manifest.path);
  if (`sha256:${sha256(manifestBytes)}` !== authority.candidate.manifest.sha256)
    throw new Error("FB-4 candidate manifest drifted");
  const assets = new AssetRegistry(world.ops),
    assetId = authority.candidate.glb.path.replace(/^assets\//, "");
  assets.seed(assetId, bytes);
  const registry = new SkillRegistry(new LiminaTracer("fb4-multi-room-review"));
  const core = registerCoreSkills(registry, { assets });
  const ctx = {
    agentId: "fb4-review",
    sessionId: "fb4-review",
    permissions: resolveProfile("builder.readWrite"),
    tick: 0,
    world,
  };
  let root: string | undefined;
  try {
    const placed = success(
      await registry.invoke(
        "building.placeFunctional",
        {
          assetId,
          hash: authority.candidate.glb.contentHash,
          position: [
            authority.placement.position[0],
            rootY + authority.placement.position[1],
            authority.placement.position[2],
          ],
          yaw: authority.placement.yaw,
        },
        ctx,
      ),
      "building.placeFunctional",
    );
    root = placed.root as string;
    const doors = placed.doors as string[],
      parts = placed.parts as string[];
    if (doors.length !== authority.topologyProof.expectedDoors || parts.length < 10)
      throw new Error("FB-4 functional placement lacks decomposed structure");
    const doorEntitiesBySemanticId = new Map<string, string>();
    for (const entity of doors) {
      const entry = world.entities.resolve(entity),
        semanticId = (entry?.origin?.input as any)?.door?.id;
      if (
        entry?.origin?.tool !== "building.functionalDoor" ||
        typeof semanticId !== "string" ||
        !semanticId ||
        doorEntitiesBySemanticId.has(semanticId)
      )
        throw new Error("FB-4 functional placement has an ambiguous semantic door inventory");
      doorEntitiesBySemanticId.set(semanticId, entity);
    }
    const requiredDoorIds = new Set(doorPosePlan.flatMap((pose) => pose.openDoorIds));
    for (const id of requiredDoorIds)
      if (!doorEntitiesBySemanticId.has(id))
        throw new Error(`FB-4 semantic evidence names an unmounted functional door: ${id}`);
    const path = success(
      await registry.invoke(
        "building.findRoomPath",
        { root, fromRoomId: authority.topologyProof.fromRoomId, toRoomId: authority.topologyProof.toRoomId },
        ctx,
      ),
      "building.findRoomPath",
    );
    if (
      path.found !== true ||
      (path.roomIds as string[]).join(",") !== authority.topologyProof.roomIds.join(",") ||
      (path.connectionIds as string[]).join(",") !== authority.topologyProof.connectionIds.join(",")
    )
      throw new Error("FB-4 mounted topology cannot traverse the authority path");
    const anchors = success(
      await registry.invoke("building.querySpawnAnchors", { root }, ctx),
      "building.querySpawnAnchors",
    ).anchors as unknown[];
    if (anchors.length !== authority.topologyProof.expectedAnchors)
      throw new Error("FB-4 mounted topology lost spawn anchors");
    let disposed = false,
      tick = 1;
    return Object.freeze({
      root,
      doors: Object.freeze(doors),
      semanticDoorIds: Object.freeze([...doorEntitiesBySemanticId.keys()].sort()),
      parts: Object.freeze(parts),
      path,
      anchors,
      doorPosePlan,
      topologyManager: core.functionalBuildings.topologyManager,
      setReviewViewDoorPose: async (viewId: ViewId) => {
        if (disposed) throw new Error("FB-4 review building is already disposed");
        const pose = doorPosePlan.find((entry) => entry.reviewViewId === viewId);
        if (pose === undefined) throw new Error(`FB-4 review door pose is absent: ${viewId}`);
        const requested = new Set(pose.openDoorIds);
        for (const [semanticId, entity] of [...doorEntitiesBySemanticId.entries()].sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          const open = requested.has(semanticId),
            result = success(
              await registry.invoke("door.setOpen", { door: entity, open }, { ...ctx, tick: tick++ }),
              `door.setOpen ${semanticId}`,
            );
          if (result.ok !== true || result.open !== open)
            throw new Error(`FB-4 functional door refused exact review pose: ${semanticId}`);
          const state = world.entities.resolve(entity)?.origin?.input as any;
          if (state?.door?.id !== semanticId || state.open !== open)
            throw new Error(`FB-4 functional door state drifted after review pose: ${semanticId}`);
        }
        return pose;
      },
      dispose: async () => {
        if (disposed) return;
        success(
          await registry.invoke("building.destroyFunctional", { root }, { ...ctx, tick: tick++ }),
          "building.destroyFunctional",
        );
        disposed = true;
      },
    });
  } catch (error) {
    if (root !== undefined) await registry.invoke("building.destroyFunctional", { root }, { ...ctx, tick: 1 });
    throw error;
  }
}
