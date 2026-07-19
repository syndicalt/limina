import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  furnitureDesignContractHash,
  validateFurnitureDesignContract,
  validateVisualDesignContract,
  visualDesignContractHash,
} from "../../js/src/architecture/index.ts";
import {
  buildingInteriorPlanV2Hash,
  interiorPlacementFacetScope,
  validateBuildingInteriorPlanV2,
} from "../../js/src/assets/building-interior-plan-v2.mjs";
import {
  validateBuildingHitlDecision,
  validateBuildingStageArtifact,
} from "../../js/src/assets/staged-building-pipeline.mjs";
import { validateFurniturePackReviewAuthority } from "../../js/src/render/furniture-pack-review-scene.ts";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";

type ReviewPoint = [number, number, number];
export function furnitureReviewCameraLayout(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  canonicalFront?: readonly [number, number, number],
) {
  const center: ReviewPoint = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    width = max[0] - min[0],
    height = max[1] - min[1],
    depth = max[2] - min[2],
    radius = Math.max(width, height, depth) * 1.45,
    eye = center[1] + height * 0.1;
  const front: ReviewPoint = canonicalFront ? ([...canonicalFront] as ReviewPoint) : [0, 0, -1],
    right: ReviewPoint = [-front[2], 0, front[0]],
    back: ReviewPoint = [-front[0], 0, -front[2]];
  const extent = (axis: ReviewPoint) => (Math.abs(axis[0]) * width) / 2 + (Math.abs(axis[2]) * depth) / 2;
  const axisPoint = (axis: ReviewPoint, distance: number, y = eye): ReviewPoint => [
    center[0] + axis[0] * (extent(axis) + distance),
    y,
    center[2] + axis[2] * (extent(axis) + distance),
  ];
  const cornerPoint = (frontDistance: number, rightDistance: number, y: number): ReviewPoint => [
    center[0] + front[0] * (extent(front) + frontDistance) + right[0] * (extent(right) + rightDistance),
    y,
    center[2] + front[2] * (extent(front) + frontDistance) + right[2] * (extent(right) + rightDistance),
  ];
  const frontageM = extent(right) * 2;
  return {
    center,
    width,
    height,
    depth,
    radius,
    eye,
    frontAxis: front,
    rightAxis: right,
    frontageM,
    front: axisPoint(front, radius),
    rightSide: axisPoint(right, radius),
    back: axisPoint(back, radius),
    threeQuarter: cornerPoint(radius * 0.75, radius * 0.75, eye + height * 0.18),
    joinery: cornerPoint(radius * 0.42, radius * 0.42, center[1] + height * 0.12),
    joineryTarget: [
      center[0] + right[0] * frontageM * 0.18,
      center[1],
      center[2] + right[2] * frontageM * 0.18,
    ] as ReviewPoint,
    overlay: cornerPoint(radius * 0.7, radius * 0.7, eye + height * 0.12),
  };
}

const root = resolve(import.meta.dir, "../.."),
  args = process.argv.slice(2),
  usage =
    "usage: bun tools/architecture/build-furniture-review.ts --evidence <json> --functional-evidence <pass.json> --visual-contract <json> --interior-artifact <json> --interior-decision <json> --interior-plan <json> --material-artifact <json> --material-decision <json> --proxy-archetype <id> --out <json>";
const arg = (flag: string) => {
    const index = args.indexOf(flag);
    if (index < 0 || !args[index + 1]) throw new Error(usage);
    return args[index + 1];
  },
  pathArg = (flag: string) => resolve(arg(flag));
const paths = {
    evidence: pathArg("--evidence"),
    functionalEvidence: pathArg("--functional-evidence"),
    visual: pathArg("--visual-contract"),
    interiorArtifact: pathArg("--interior-artifact"),
    interiorDecision: pathArg("--interior-decision"),
    plan: pathArg("--interior-plan"),
    materialArtifact: pathArg("--material-artifact"),
    materialDecision: pathArg("--material-decision"),
    out: pathArg("--out"),
  },
  proxyId = arg("--proxy-archetype");
const raw = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  portable = (path: string) => {
    const value = relative(root, path).split(sep).join("/");
    if (!value || value === ".." || value.startsWith("../"))
      throw new Error(`F1 input/output escapes repository: ${path}`);
    return value;
  },
  load = async (path: string) => {
    const bytes = await readFile(path);
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  };
const facet = (artifact: any, scope: string) => {
  const entry = artifact.facets.find((candidate: any) => candidate.scope === scope);
  if (!entry) throw new Error(`${artifact.artifactId} lacks required facet ${scope}`);
  return { scope, hash: entry.hash };
};
const approved = async (
  artifactPath: string,
  decisionPath: string,
  kind: "interior-plan" | "material-palette",
  gate: string,
) => {
  const [a, d] = await Promise.all([load(artifactPath), load(decisionPath)]),
    artifact = validateBuildingStageArtifact(a.value),
    decision = validateBuildingHitlDecision(d.value);
  if (
    artifact.kind !== kind ||
    artifact.status !== "approved" ||
    decision.decision !== "approve" ||
    decision.gate !== gate ||
    decision.artifactId !== artifact.artifactId ||
    decision.contractHash !== artifact.contractHash ||
    decision.contentHash !== artifact.contentHash ||
    artifact.metadata?.approval?.path !== portable(decisionPath) ||
    artifact.metadata?.approval?.sha256 !== raw(d.bytes) ||
    artifact.metadata?.approval?.decisionId !== decision.decisionId
  )
    throw new Error(`F1 ${kind} dependency is not the exact approved artifact/decision closure`);
  return { artifact, bytes: a.bytes, decision, decisionBytes: d.bytes };
};

const [
  { bytes: evidenceBytes, value: evidence },
  { bytes: functionalBytes, value: functionalPass },
  { bytes: visualBytes, value: visualValue },
  { bytes: planBytes, value: planValue },
  i1,
  m1,
] = await Promise.all([
  load(paths.evidence),
  load(paths.functionalEvidence),
  load(paths.visual),
  load(paths.plan),
  approved(paths.interiorArtifact, paths.interiorDecision, "interior-plan", "I1-layout"),
  approved(paths.materialArtifact, paths.materialDecision, "material-palette", "M1-materials"),
]);
if (evidence.schema !== "limina.furniture-contract-build-evidence/v1")
  throw new Error(
    "F1 authority requires typed furniture contract build evidence; legacy primitive packs are forbidden",
  );
if (
  evidence.status !== "cpu-authored-unreviewed" ||
  evidence.freshProcessValidation?.schema !== "limina.blender-furniture-source-validation/v1" ||
  evidence.glbValidation?.contractIdentity !== true ||
  evidence.glbValidation?.materialProvenance !== true ||
  evidence.glbValidation?.finiteAccessorBounds !== true
)
  throw new Error("F1 typed evidence lacks successful fresh-process/GLB contract validation");
const contractPath = resolve(evidence.contract?.path ?? ""),
  assetPath = resolve(evidence.asset?.path ?? ""),
  blendPath = resolve(evidence.sourceBlend?.path ?? ""),
  [{ bytes: contractBytes, value: contract }, assetBytes, blendBytes] = await Promise.all([
    load(contractPath),
    readFile(assetPath),
    readFile(blendPath),
  ]);
const validatedVisual = validateVisualDesignContract(visualValue),
  visualHash = visualDesignContractHash(validatedVisual),
  validatedContract = validateFurnitureDesignContract(contract, validatedVisual),
  contractHash = furnitureDesignContractHash(validatedContract);
if (
  contractHash !== evidence.contract.hash ||
  contractHash !== evidence.payloadHash ||
  evidence.sourceIrHash !== contractHash ||
  validatedContract.visualDesign.hash !== evidence.contract.visualDesignHash ||
  validatedContract.visualDesign.hash !== visualHash ||
  evidence.sourceSpecHash !== visualHash
)
  throw new Error("F1 typed evidence contract or visual-cue identity drifted");
if (
  raw(assetBytes) !== evidence.asset.sha256 ||
  assetBytes.length !== evidence.asset.bytes ||
  raw(blendBytes) !== evidence.sourceBlend.sha256 ||
  blendBytes.length !== evidence.sourceBlend.bytes
)
  throw new Error("F1 typed evidence asset/source bytes drifted");
const counts = {
  parts: validatedContract.parts.length,
  joints: validatedContract.joints.length,
  sockets: validatedContract.sockets.length,
  occupancySockets: validatedContract.sockets.filter((socket) => socket.kind === "occupancy").length,
  approachSockets: validatedContract.sockets.filter((socket) => socket.kind === "approach").length,
  colliders: validatedContract.colliders.length,
};
for (const key of ["parts", "joints", "sockets", "occupancySockets", "colliders"] as const)
  if (evidence.inventory?.[key] !== counts[key]) throw new Error(`F1 typed evidence ${key} inventory drifted`);
if (
  JSON.stringify(evidence.inventory.materialRoles) !== JSON.stringify(validatedContract.materialRoles) ||
  evidence.primitiveCount !== counts.parts ||
  evidence.glbValidation.meshes !== counts.parts ||
  evidence.freshProcessValidation.contractHash !== contractHash ||
  evidence.freshProcessValidation.parts !== counts.parts ||
  evidence.freshProcessValidation.sockets !== counts.sockets ||
  evidence.freshProcessValidation.colliders !== counts.colliders
)
  throw new Error("F1 fresh-process semantic inventory drifted");
const plan = validateBuildingInteriorPlanV2(planValue) as any,
  canonicalHash = buildingInteriorPlanV2Hash(plan);
if (
  raw(planBytes) !== i1.artifact.contentHash ||
  canonicalHash !== i1.artifact.contractHash ||
  i1.artifact.metadata?.plan?.path !== portable(paths.plan) ||
  i1.artifact.metadata?.plan?.contentHash !== raw(planBytes) ||
  i1.artifact.metadata?.plan?.canonicalHash !== canonicalHash
)
  throw new Error("F1 I1 artifact does not bind the exact validated plan bytes");
if (
  functionalPass.schema !== "limina.furniture-functional-evidence/v1" ||
  functionalPass.verdict !== "pass" ||
  !Array.isArray(functionalPass.checks) ||
  functionalPass.checks.length < 1 ||
  functionalPass.checks.some(
    (check: any) => check.passed !== true || !Array.isArray(check.findings) || check.findings.length !== 0,
  ) ||
  functionalPass.summary?.failed !== 0 ||
  functionalPass.summary?.passed !== functionalPass.checks.length
)
  throw new Error("F1 authority requires an actual all-checks-passed functional verifier artifact");
const functionalInputs = {
    furnitureContractHash: contractHash,
    runtimeGlbSha256: raw(assetBytes),
    runtimeSemanticInventorySha256: evidence.freshProcessValidation.semanticInventorySha256,
    interiorArtifactId: i1.artifact.artifactId,
    interiorContractHash: i1.artifact.contractHash,
    interiorContentHash: i1.artifact.contentHash,
    selectedProxyArchetypeId: proxyId,
  },
  inputKeys = Object.keys(functionalInputs).sort();
if (
  JSON.stringify(Object.keys(functionalPass.inputs ?? {}).sort()) !== JSON.stringify(inputKeys) ||
  inputKeys.some((key) => functionalPass.inputs[key] !== functionalInputs[key])
)
  throw new Error("F1 functional verifier pass does not bind the exact contract/runtime/I1/proxy inputs");
const proxy = plan.proxyArchetypes.find((entry: any) => entry.id === proxyId);
if (!proxy) throw new Error(`F1 selected proxy archetype does not exist: ${proxyId}`);
const placements = plan.placements.filter((entry: any) => entry.archetypeId === proxyId);
if (!placements.length) throw new Error(`F1 selected proxy has no approved placements: ${proxyId}`);
const kindMatches = (value: string) => value === proxy.kind || value.endsWith(`-${proxy.kind}`);
if (!kindMatches(validatedContract.role) && !kindMatches(evidence.kind))
  throw new Error(`F1 furniture kind ${evidence.kind} does not satisfy selected proxy kind ${proxy.kind}`);
const authored = [
  validatedContract.dimensions.widthM,
  validatedContract.dimensions.heightM,
  validatedContract.dimensions.depthM,
];
if (authored.some((value, index) => value > proxy.dimensions[index] + 0.002))
  throw new Error(
    `F1 authored furniture dimensions ${JSON.stringify(authored)} exceed approved I1 proxy ${JSON.stringify(proxy.dimensions)}`,
  );
if (proxy.requiresOccupancy && counts.occupancySockets < 1)
  throw new Error("F1 selected I1 proxy requires occupancy sockets");
if (proxy.requiresApproach && counts.approachSockets < 1)
  throw new Error("F1 selected I1 proxy requires approach sockets");
const exactDependency = (loaded: any, artifactPath: string, decisionPath: string, scopes: string[]) => ({
  path: portable(artifactPath),
  sha256: raw(loaded.bytes),
  contentHash: portableAssetContentHash(loaded.bytes),
  artifactId: loaded.artifact.artifactId,
  kind: loaded.artifact.kind,
  revision: loaded.artifact.revision,
  status: "approved",
  contractHash: loaded.artifact.contractHash,
  assetContentHash: loaded.artifact.contentHash,
  decision: {
    path: portable(decisionPath),
    sha256: raw(loaded.decisionBytes),
    contentHash: portableAssetContentHash(loaded.decisionBytes),
    decisionId: loaded.decision.decisionId,
  },
  facets: scopes.map((scope) => facet(loaded.artifact, scope)),
});
const min = evidence.bounds.min as [number, number, number],
  max = evidence.bounds.max as [number, number, number],
  reviewLayout = furnitureReviewCameraLayout(min, max, validatedContract.storage?.canonicalFront),
  { center, width, height, depth, radius, eye } = reviewLayout;
const camera = (
  id: string,
  type: string,
  state: string,
  role: string,
  position: [number, number, number],
  target: [number, number, number] = center,
  fovDeg = 42,
) => ({
  id,
  type,
  state,
  role,
  position,
  target,
  fovDeg,
  near: 0.03,
  far: 50,
  distanceM: Math.hypot(position[0] - target[0], position[1] - target[1], position[2] - target[2]),
});
const materialScopes = ["role-contract", "surface-parameters", "runtime-textures"],
  placementScope = plan.revision >= 2 ? interiorPlacementFacetScope(proxy.id) : "placements",
  placementFacet = facet(i1.artifact, placementScope);
const canonicalViews = [
    camera(
      "front",
      "silhouette",
      "static",
      "functional front silhouette, alignment, and human scale",
      reviewLayout.front,
    ),
    camera("right-side", "functional", "static", "depth, compound support, and usable posture", reviewLayout.rightSide),
    camera("back", "construction", "static", "rear construction and hidden intersections", reviewLayout.back),
    camera(
      "three-quarter",
      "cohesion",
      "static",
      "front-right cohesion and material continuity",
      reviewLayout.threeQuarter,
    ),
    camera(
      "joinery-detail",
      "joinery",
      "static",
      "close joint, clipping, and mapping evidence",
      reviewLayout.joinery,
      reviewLayout.joineryTarget,
      34,
    ),
  ],
  detailViews = {
    "seat-section": camera(
      "seat-section",
      "functional",
      "static",
      "clean side human-use section through seat, back, legs, and floor support",
      [max[0] + radius * 0.72, validatedContract.dimensions.seatHeightM + height * 0.08, center[2]],
      [center[0], validatedContract.dimensions.seatHeightM, center[2]],
      32,
    ),
  },
  overlayViews = {
    "socket-overlay": camera(
      "socket-overlay",
      "functional",
      "static",
      "exact interaction and approach socket overlay",
      reviewLayout.overlay,
    ),
    "collision-overlay": camera(
      "collision-overlay",
      "construction",
      "static",
      "compound semantic collider overlay",
      reviewLayout.overlay,
    ),
  },
  supported = new Set([
    ...canonicalViews.map((view) => view.id),
    ...Object.keys(detailViews),
    ...Object.keys(overlayViews),
  ]);
if (validatedVisual.requiredViews.some((id) => !supported.has(id)))
  throw new Error("F1 visual design requests an unsupported review view");
const evidenceViews = validatedVisual.requiredViews.map(
  (id) =>
    canonicalViews.find((view) => view.id === id) ??
    detailViews[id as keyof typeof detailViews] ??
    overlayViews[id as keyof typeof overlayViews],
);
const authority = {
  schema: "limina.furniture-pack-review-scene/v1",
  pack: {
    id: evidence.id,
    kind: evidence.kind,
    assetId: portable(assetPath).replace(/^assets\//, ""),
    sha256: raw(assetBytes),
    assetHash: portableAssetContentHash(assetBytes),
    payloadHash: evidence.payloadHash,
    sourceSpecHash: evidence.sourceSpecHash,
    sourceIrHash: evidence.sourceIrHash,
    primitiveCount: evidence.primitiveCount,
    evidencePath: portable(paths.evidence),
    evidenceSha256: raw(evidenceBytes),
  },
  source: { blendPath: portable(blendPath), blendSha256: raw(blendBytes), blenderVersion: evidence.toolchain.version },
  visualDesign: {
    path: portable(paths.visual),
    sha256: raw(visualBytes),
    contentHash: portableAssetContentHash(visualBytes),
    id: validatedVisual.id,
    hash: visualHash,
    cueIds: validatedVisual.cues.map((cue) => cue.id),
    requiredViews: [...validatedVisual.requiredViews],
  },
  functionalEvidence: {
    ...functionalPass,
    path: portable(paths.functionalEvidence),
    sha256: raw(functionalBytes),
    contentHash: portableAssetContentHash(functionalBytes),
    contractPath: portable(contractPath),
    contractSha256: raw(contractBytes),
    contractContentHash: portableAssetContentHash(contractBytes),
    contractHash,
    ...counts,
    materialRoles: [...validatedContract.materialRoles],
    collisionPolicy: "compound-semantic",
    placementSkill: "furniture.placeFunctional",
  },
  dependencies: {
    interior: {
      artifact: exactDependency(i1, paths.interiorArtifact, paths.interiorDecision, [
        placementScope,
        "support-bindings",
      ]),
      plan: {
        path: portable(paths.plan),
        sha256: raw(planBytes),
        contentHash: portableAssetContentHash(planBytes),
        planId: plan.planId,
        revision: plan.revision,
        canonicalHash,
      },
      selectedProxy: {
        archetypeId: proxy.id,
        kind: proxy.kind,
        dimensions: proxy.dimensions,
        supportKind: proxy.supportKind,
        requiresApproach: proxy.requiresApproach,
        requiresOccupancy: proxy.requiresOccupancy,
        placementFacetHash: placementFacet.hash,
        placementIds: placements.map((entry: any) => entry.id),
      },
    },
    materials: {
      artifact: exactDependency(m1, paths.materialArtifact, paths.materialDecision, materialScopes),
      requiredFacets: materialScopes.map((scope) => facet(m1.artifact, scope)),
    },
  },
  bounds: { min, max },
  placement: { position: [0, 0, 0], rotation: [0, 0, 0], ground: false, scale: [1, 1, 1] },
  presentation: {
    minimumResolution: [1280, 720],
    fixedTimeSeconds: 3,
    warmupFrames: 12,
    neutralFloor: true,
    humanScaleProxyHeightM: 1.75,
  },
  evidenceViews,
};
validateFurniturePackReviewAuthority(authority);
await mkdir(dirname(paths.out), { recursive: true });
await writeFile(paths.out, `${JSON.stringify(authority, null, 2)}\n`, { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ path: portable(paths.out), pack: authority.pack.id, proxy: proxy.id }, null, 2));
