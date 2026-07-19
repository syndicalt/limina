import { canonicalHash, type JsonValue } from "../src/authoring/canonical.ts";
import {
  createBuildingSemanticEvidence,
  validateBuildingSemanticEvidence,
  verifyBuildingSemanticEvidence,
  type BuildingSemanticEvidencePolicy,
  type BuildingSemanticGlbTarget,
  type BuildingSemanticTarget,
  type ExactSemanticEvidenceFile,
} from "../src/render/building-semantic-evidence.ts";
import { portableAssetContentHash } from "../src/world/asset-content-hash.mjs";
import { sha256 } from "../src/world/sha256.mjs";

const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(message);
};
const rejects = (fn: () => unknown, pattern: RegExp, message: string) => {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  assert(
    error instanceof Error && pattern.test(error.message),
    `${message}: ${error instanceof Error ? error.message : "accepted"}`,
  );
};
const encoder = new TextEncoder(),
  H1 = `sha256:${"1".repeat(64)}`,
  H2 = `sha256:${"2".repeat(64)}`;
const exact = (path: string, bytes: Uint8Array): ExactSemanticEvidenceFile => ({
  path,
  sha256: `sha256:${sha256(bytes)}`,
  contentHash: portableAssetContentHash(bytes),
  bytes: bytes.byteLength,
});
const group = (
  id: string,
  nodeIds: readonly string[],
  architectureOwnerId: string,
  architectureRegionId?: string,
): BuildingSemanticGlbTarget => ({
  kind: "glb-semantic-group",
  id,
  nodeIds,
  architectureOwnerId,
  ...(architectureRegionId ? { architectureRegionId } : {}),
});

const targetRoles = Object.freeze({
  "gable-upper-window": { glass: 1, frame: 4 },
  "entry-canopy": {
    roof: 1,
    header: 1,
    "knee-brace": 2,
    post: 1,
    "adjacent-window-glass": 1,
    "adjacent-window-frame": 4,
  },
  "passage-fireplace": {
    "passage-aperture": 1,
    "fireplace-hearth": 1,
    "fireplace-firebox": 1,
    "fireplace-mantle": 1,
    "fireplace-surround": 1,
  },
  "stair-circulation": {
    "bottom-landing": 1,
    "stair-low-extreme": 1,
    "stair-high-extreme": 1,
    "top-landing": 1,
    "headroom-clearance": 1,
  },
  "upper-circulation": { "upper-landing": 1, "access-frame": 1, "upper-window-glass": 1, "upper-window-frame": 4 },
} as const);

function makeTargets(): Record<string, Record<string, BuildingSemanticTarget[]>> {
  const result: Record<string, Record<string, BuildingSemanticTarget[]>> = {};
  for (const [claim, roles] of Object.entries(targetRoles)) {
    result[claim] = {};
    for (const [role, count] of Object.entries(roles))
      result[claim][role] = Array.from({ length: count }, (_, index) => {
        const owner = `owner/${claim}/${role}/${index}`,
          id = `${claim}/${role}/${index}`;
        return group(id, [`node/${id}`], owner);
      });
  }
  result["passage-fireplace"]["passage-aperture"] = [
    { kind: "functional-portal-witness", id: "witness/passage", portalId: "portal/test-passage" },
  ];
  result["stair-circulation"]["headroom-clearance"] = [
    { kind: "stair-headroom-witness", id: "witness/headroom", stairId: "stairs/test" },
  ];
  result["stair-circulation"]["top-landing"] = [
    { kind: "stair-top-arrival-witness", id: "witness/top-arrival", stairId: "stairs/test" },
  ];
  result["entry-canopy"].post = [
    group(
      "entry-canopy/post/assembly",
      ["node/entry-canopy/post/left", "node/entry-canopy/post/right"],
      "owner/entry-canopy/post",
    ),
  ];
  result["passage-fireplace"]["fireplace-surround"] = [
    group(
      "passage-fireplace/fireplace-surround/assembly",
      ["node/fireplace-surround/left", "node/fireplace-surround/right", "node/fireplace-surround/top"],
      "owner/fireplace",
    ),
  ];
  result["upper-circulation"]["access-frame"] = [
    group(
      "upper-circulation/access-frame/0",
      ["left", "right", "top"].map((part) => `node/access-0/${part}`),
      "owner/access-0",
    ),
  ];
  result["upper-circulation"]["upper-landing"] = [
    { kind: "functional-room-floor-witness", id: "witness/upper-landing", roomId: "room/upper-landing" },
  ];
  return result;
}

const flattenGroups = (targets: Record<string, Record<string, BuildingSemanticTarget[]>>) =>
  Object.entries(targets).flatMap(([claim, roles]) =>
    Object.values(roles).flatMap((entries) =>
      entries.flatMap((target) =>
        target.kind === "glb-semantic-group"
          ? target.nodeIds.map((nodeId) => ({ claim, nodeId, ownerId: target.architectureOwnerId }))
          : [],
      ),
    ),
  );

function glb(
  entries: readonly { claim: string; nodeId: string; ownerId: string }[],
  provenanceOverride?: Readonly<{
    nodeId: string;
    ownerId?: string;
    derivedFrom?: readonly string[];
    role?: string;
    editPolicy?: string;
  }>,
  doorAnimation?: Readonly<{
    doorId: string;
    childNodeId: string;
    quaternion?: readonly [number, number, number, number];
    animationName?: string;
    targetSemanticId?: string;
  }>,
): Uint8Array {
  const chunks: Uint8Array[] = [],
    bufferViews: unknown[] = [],
    accessors: unknown[] = [],
    meshes: unknown[] = [],
    nodes: unknown[] = [],
    groupByClaim = new Map(Object.keys(targetRoles).map((id, index) => [id, index]));
  let byteOffset = 0;
  for (let itemIndex = 0; itemIndex < entries.length; itemIndex++) {
    const { claim, nodeId, ownerId } = entries[itemIndex],
      claimIndex = groupByClaim.get(claim)!;
    const surround = nodeId.startsWith("node/fireplace-surround/"),
      upperFloor = nodeId.startsWith("node/upper-floor/"),
      x = claimIndex * 20 + (surround ? 0 : (itemIndex % 5) * 0.58 - 1.16),
      y = surround ? 2 : 3 - Math.floor((itemIndex % 20) / 5) * 0.5,
      z = upperFloor ? ({ east: 0, south: -1, north: 1 }[nodeId.split("/").at(-1)!] ?? 0) : 0;
    const values = new Float32Array([
        -0.2, -0.16, 0, 0.2, 0.16, 0, 0.2, -0.16, 0, -0.2, -0.16, 0, -0.2, 0.16, 0, 0.2, 0.16, 0,
      ]),
      bytes = new Uint8Array(values.buffer);
    chunks.push(bytes);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.byteLength });
    accessors.push({ bufferView: accessors.length, componentType: 5126, count: 6, type: "VEC3" });
    meshes.push({ primitives: [{ attributes: { POSITION: accessors.length - 1 }, material: 0 }] });
    const override = provenanceOverride?.nodeId === nodeId ? provenanceOverride : undefined,
      actualOwner = override?.ownerId ?? ownerId;
    nodes.push({
      mesh: meshes.length - 1,
      translation: [x, y, z],
      extras: {
        "limina.id": nodeId,
        "limina.owner": actualOwner,
        "limina.derivedFrom": override?.derivedFrom ?? [actualOwner],
        "limina.role": override?.role ?? "architecture-primitive",
        "limina.editPolicy": override?.editPolicy ?? "protected-generated",
        limina: { id: nodeId },
      },
    });
    byteOffset += bytes.byteLength;
  }
  let animations: unknown[] | undefined, doorChildIndex: number | undefined, doorRootIndex: number | undefined;
  if (doorAnimation) {
    doorChildIndex = nodes.findIndex((node: any) => node.extras?.["limina.id"] === doorAnimation.childNodeId);
    assert(doorChildIndex >= 0, "synthetic animated door child is missing");
    const child: any = nodes[doorChildIndex],
      rootTranslation = [...child.translation];
    child.translation = [0, 0, 0];
    doorRootIndex = nodes.length;
    nodes.push({
      name: doorAnimation.doorId,
      translation: rootTranslation,
      children: [doorChildIndex],
      extras: {
        "limina.id": doorAnimation.targetSemanticId ?? doorAnimation.doorId,
        "limina.owner": doorAnimation.doorId,
        "limina.derivedFrom": [doorAnimation.doorId],
        "limina.role": "architecture-primitive",
        "limina.editPolicy": "protected-generated",
        limina: { id: doorAnimation.targetSemanticId ?? doorAnimation.doorId, role: "door" },
      },
    });
    const times = new Uint8Array(new Float32Array([0, 1]).buffer),
      quaternion = doorAnimation.quaternion ?? [0, 0.173648178, 0, 0.984807753],
      rotations = new Uint8Array(new Float32Array([0, 0, 0, 1, ...quaternion]).buffer);
    const inputAccessor = accessors.length;
    chunks.push(times);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: times.byteLength });
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: 2, type: "SCALAR" });
    byteOffset += times.byteLength;
    const outputAccessor = accessors.length;
    chunks.push(rotations);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: rotations.byteLength });
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: 2, type: "VEC4" });
    byteOffset += rotations.byteLength;
    animations = [
      {
        name: doorAnimation.animationName ?? `${doorAnimation.doorId}/open`,
        channels: [{ sampler: 0, target: { node: doorRootIndex, path: "rotation" } }],
        samplers: [{ input: inputAccessor, output: outputAccessor, interpolation: "LINEAR" }],
      },
    ];
  }
  const binary = new Uint8Array(byteOffset);
  let offset = 0;
  for (const chunk of chunks) {
    binary.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const roots = nodes.map((_, index) => index).filter((index) => index !== doorChildIndex);
  const document: any = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: roots }],
    nodes,
    meshes,
    materials: [{ alphaMode: "OPAQUE" }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binary.byteLength }],
    ...(animations ? { animations } : {}),
  };
  let json = encoder.encode(JSON.stringify(document));
  const jsonPadding = (4 - (json.byteLength % 4)) % 4;
  if (jsonPadding) {
    const padded = new Uint8Array(json.byteLength + jsonPadding);
    padded.set(json);
    padded.fill(0x20, json.byteLength);
    json = padded;
  }
  const binPadding = (4 - (binary.byteLength % 4)) % 4,
    paddedBinary = new Uint8Array(binary.byteLength + binPadding);
  paddedBinary.set(binary);
  const result = new Uint8Array(12 + 8 + json.byteLength + 8 + paddedBinary.byteLength),
    view = new DataView(result.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, result.byteLength, true);
  view.setUint32(12, json.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  result.set(json, 20);
  const binHeader = 20 + json.byteLength;
  view.setUint32(binHeader, paddedBinary.byteLength, true);
  view.setUint32(binHeader + 4, 0x004e4942, true);
  result.set(paddedBinary, binHeader + 8);
  return result;
}

const targets = makeTargets(),
  entries = flattenGroups(targets),
  owners = [...new Set(entries.map((entry) => entry.ownerId))];
const architectureBytes = encoder.encode(
  JSON.stringify({
    schema: "limina.blender-architecture-input/v1",
    compilerSchema: "limina.architecture-compile/v1",
    specHash: H1,
    irHash: H2,
    primitives: owners.map((id) => ({ id })),
    functionalContract: {
      schema: "limina.functional-building/v2",
      buildingId: "architecture/test-house",
      portals: [
        {
          id: "portal/test-passage",
          kind: "passage",
          exterior: false,
          center: [40, 2, 0],
          halfExtents: [0.3, 0.5, 0.12],
        },
        { id: "portal/test-upper-door", kind: "door", exterior: false, doorId: "door/test-upper" },
      ],
      doors: [{ id: "door/test-upper", portalId: "portal/test-upper-door", closedYaw: 0, openYaw: 0.3490658503988659 }],
      verticalLinks: [
        {
          id: "stairs/test",
          kind: "stairs",
          from: [60, 1.4, -0.7],
          to: [60, 2.4, 0.7],
          clearWidth: 0.8,
          clearHeight: 1,
          treadDepth: 0.25,
        },
      ],
      rooms: [
        { id: "room/upper-landing", bounds: { center: [80, 2.8, 0], halfExtents: [5, 3, 5] }, finishedFloorY: 2.8 },
      ],
      spawnAnchors: [
        {
          id: "spawn/upper",
          roomId: "room/upper-landing",
          position: [80, 2.8, 0],
          clearanceRadius: 0.2,
          clearanceHeight: 0.5,
        },
      ],
    },
  }),
);
const glbBytes = glb(entries),
  architectureFile = exact("virtual/architecture-ir.json", architectureBytes),
  glbFile = exact("virtual/house.glb", glbBytes);
const manifest = (production = glbFile, candidateId = "candidate/test-house/v1") =>
  encoder.encode(
    JSON.stringify({
      schema: "limina.fb4-multi-room-production-candidate/v3",
      candidateId,
      compiler: { specHash: H1, irHash: H2 },
      files: [{ role: "productionGlb", ...production }],
    }),
  );
const manifestBytes = manifest(),
  manifestFile = exact("virtual/candidate-manifest.json", manifestBytes);

const policy = (): BuildingSemanticEvidencePolicy => ({
  schema: "limina.building-semantic-evidence-policy/v2",
  viewport: [1920, 1080],
  safeFrameNdc: 0.94,
  minimumVisibleAnchors: 2,
  minimumVisibleFraction: 0.5,
  minimumProjectedWidthNdc: 0.003,
  minimumProjectedHeightNdc: 0.003,
  maximumTrianglesPerTarget: 64,
  rayEpsilonM: 0.002,
  minimumFacadeAlignmentDot: 0.8,
  claims: Object.keys(targetRoles).map((id, index) => ({
    id: id as keyof typeof targetRoles,
    viewId: `view/${id}`,
    expectedFacade: index === 0 ? ("left-gable" as const) : index === 1 ? ("entry" as const) : ("interior" as const),
    viewedFacade: index === 0 ? ("left-gable" as const) : index === 1 ? ("entry" as const) : ("interior" as const),
    ...(index < 2 ? { exteriorNormal: [0, 0, -1] as const } : {}),
    camera: {
      position: [index * 20, 2, -10] as const,
      target: [index * 20, 2, 0] as const,
      fovYDegrees: 42,
      nearM: 0.05,
      farM: 30,
    },
    targets: structuredClone(targets[id]),
  })),
});
const input = (
  usePolicy = policy(),
  useGlbBytes = glbBytes,
  useGlbFile = glbFile,
  useManifestBytes = manifestBytes,
  useManifestFile = manifestFile,
) => ({
  candidateId: "candidate/test-house/v1",
  architectureId: "architecture/test-house",
  candidateManifest: { file: useManifestFile, bytes: useManifestBytes },
  architectureIr: { file: architectureFile, bytes: architectureBytes },
  productionGlb: { file: useGlbFile, bytes: useGlbBytes },
  policy: usePolicy,
});
const files = new Map([
    [manifestFile.path, manifestBytes],
    [architectureFile.path, architectureBytes],
    [glbFile.path, glbBytes],
  ]),
  read = (path: string) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error(`missing ${path}`);
    return bytes;
  };

const evidence = createBuildingSemanticEvidence(input());
assert(
  evidence.mechanicalVerdict === "pass" && evidence.failures.length === 0,
  "complete exact semantic fixture did not pass",
);
assert(
  evidence.reviewBoundary.rendering === false &&
    evidence.reviewBoundary.gpu === false &&
    evidence.reviewBoundary.visualQuality === false &&
    evidence.reviewBoundary.humanDecision === "pending",
  "mechanical-only boundary drifted",
);
const surround = evidence.claims
  .find((claim) => claim.id === "passage-fireplace")!
  .targets.find((target) => target.role === "fireplace-surround")!;
assert(surround.visibleAnchorCount > 0 && surround.pass, "multi-node semantic group self-occluded");
validateBuildingSemanticEvidence(evidence);
verifyBuildingSemanticEvidence(evidence, read);

const animatedChild = "node/upper-circulation/upper-window-glass/0",
  animatedGlbBytes = glb(entries, undefined, { doorId: "door/test-upper", childNodeId: animatedChild }),
  animatedGlbFile = exact("virtual/animated-door.glb", animatedGlbBytes),
  animatedManifestBytes = manifest(animatedGlbFile),
  animatedManifestFile = exact("virtual/animated-door-manifest.json", animatedManifestBytes);
const openPolicy = policy() as any;
openPolicy.claims[4].openDoorIds = ["door/test-upper"];
const openEvidence = createBuildingSemanticEvidence(
  input(openPolicy, animatedGlbBytes, animatedGlbFile, animatedManifestBytes, animatedManifestFile),
);
const openClaim = openEvidence.claims[4],
  baseWindow = evidence.claims[4].targets.find(
    (target) => target.targetId === "upper-circulation/upper-window-glass/0",
  )!,
  openWindow = openClaim.targets.find((target) => target.targetId === "upper-circulation/upper-window-glass/0")!;
assert(
  openEvidence.mechanicalVerdict === "pass" &&
    openClaim.resolvedOpenDoorPoses.length === 1 &&
    openClaim.resolvedOpenDoorPoses[0].doorId === "door/test-upper" &&
    /^sha256:[0-9a-f]{64}$/.test(openClaim.resolvedOpenDoorPoses[0].poseHash),
  "exact compiler/animation-derived open-door pose did not pass with hashed provenance",
);
assert(
  JSON.stringify(baseWindow.projectedBounds) !== JSON.stringify(openWindow.projectedBounds),
  "open-door animation endpoint was recorded but not applied to its semantic subtree",
);

const missing = policy() as any;
delete missing.claims[0].targets.glass;
rejects(() => createBuildingSemanticEvidence(input(missing)), /role inventory is incomplete/, "missing role accepted");
const duplicateTarget = policy() as any;
duplicateTarget.claims[1].targets["knee-brace"][1].id = duplicateTarget.claims[1].targets["knee-brace"][0].id;
rejects(
  () => createBuildingSemanticEvidence(input(duplicateTarget)),
  /duplicated or invalid/,
  "duplicate target accepted",
);
const duplicateNode = policy() as any;
duplicateNode.claims[0].targets.frame[1].nodeIds = duplicateNode.claims[0].targets.frame[0].nodeIds;
rejects(
  () => createBuildingSemanticEvidence(input(duplicateNode)),
  /belongs to multiple targets/,
  "duplicate GLB node authority accepted",
);
const fakePortal = policy() as any;
fakePortal.claims[2].targets["passage-aperture"][0].center = [40, 2, 0];
rejects(
  () => createBuildingSemanticEvidence(input(fakePortal)),
  /portal witness keys are invalid/,
  "policy-supplied portal geometry accepted",
);
const fakeHeadroom = policy() as any;
fakeHeadroom.claims[3].targets["headroom-clearance"][0] = group(
  "fake/headroom",
  [entries[0].nodeId],
  entries[0].ownerId,
);
rejects(
  () => createBuildingSemanticEvidence(input(fakeHeadroom)),
  /compiler-derived stair witness/,
  "GLB geometry impersonated headroom",
);
const suppliedPose = policy() as any;
suppliedPose.claims[4].openDoorIds = ["door/test-upper"];
suppliedPose.claims[4].openDoorTransforms = { "door/test-upper": [0, 0, 0, 1] };
rejects(
  () =>
    createBuildingSemanticEvidence(
      input(suppliedPose, animatedGlbBytes, animatedGlbFile, animatedManifestBytes, animatedManifestFile),
    ),
  /claim 'upper-circulation' keys are invalid/,
  "policy-supplied door transform accepted",
);
const unknownDoor = policy() as any;
unknownDoor.claims[4].openDoorIds = ["door/unknown"];
rejects(
  () => createBuildingSemanticEvidence(input(unknownDoor)),
  /lacks one exact compiler functional door/,
  "unknown policy door accepted",
);
const missingAnimation = policy() as any;
missingAnimation.claims[4].openDoorIds = ["door/test-upper"];
rejects(
  () => createBuildingSemanticEvidence(input(missingAnimation)),
  /lacks one exact GLB 'door\/test-upper\/open' animation/,
  "compiler door without exact GLB open animation accepted",
);
const wrongAnimationBytes = glb(entries, undefined, {
    doorId: "door/test-upper",
    childNodeId: animatedChild,
    targetSemanticId: "door/forged",
  }),
  wrongAnimationFile = exact("virtual/wrong-door-animation.glb", wrongAnimationBytes),
  wrongAnimationManifestBytes = manifest(wrongAnimationFile),
  wrongAnimationManifestFile = exact("virtual/wrong-door-animation-manifest.json", wrongAnimationManifestBytes);
rejects(
  () =>
    createBuildingSemanticEvidence(
      input(
        openPolicy,
        wrongAnimationBytes,
        wrongAnimationFile,
        wrongAnimationManifestBytes,
        wrongAnimationManifestFile,
      ),
    ),
  /does not target its exact compiler-owned semantic door root/,
  "animation targeting a forged semantic door root accepted",
);
const unnormalizedAnimationBytes = glb(entries, undefined, {
    doorId: "door/test-upper",
    childNodeId: animatedChild,
    quaternion: [0, 0, 0, 2],
  }),
  unnormalizedAnimationFile = exact("virtual/unnormalized-door-animation.glb", unnormalizedAnimationBytes),
  unnormalizedAnimationManifestBytes = manifest(unnormalizedAnimationFile),
  unnormalizedAnimationManifestFile = exact(
    "virtual/unnormalized-door-animation-manifest.json",
    unnormalizedAnimationManifestBytes,
  );
rejects(
  () =>
    createBuildingSemanticEvidence(
      input(
        openPolicy,
        unnormalizedAnimationBytes,
        unnormalizedAnimationFile,
        unnormalizedAnimationManifestBytes,
        unnormalizedAnimationManifestFile,
      ),
    ),
  /endpoint quaternion is not normalized/,
  "unnormalized animation endpoint accepted",
);
const wrongPoseAnimationBytes = glb(entries, undefined, {
    doorId: "door/test-upper",
    childNodeId: animatedChild,
    quaternion: [0, 0.707106781, 0, 0.707106781],
  }),
  wrongPoseAnimationFile = exact("virtual/wrong-door-pose-animation.glb", wrongPoseAnimationBytes),
  wrongPoseAnimationManifestBytes = manifest(wrongPoseAnimationFile),
  wrongPoseAnimationManifestFile = exact(
    "virtual/wrong-door-pose-animation-manifest.json",
    wrongPoseAnimationManifestBytes,
  );
rejects(
  () =>
    createBuildingSemanticEvidence(
      input(
        openPolicy,
        wrongPoseAnimationBytes,
        wrongPoseAnimationFile,
        wrongPoseAnimationManifestBytes,
        wrongPoseAnimationManifestFile,
      ),
    ),
  /endpoint disagrees with the exact compiler open pose/,
  "animation endpoint disagreeing with compiler open yaw accepted",
);

const clippedPolicy = policy() as any;
clippedPolicy.claims[4].camera.target = [86, 2, 0];
const clipped = createBuildingSemanticEvidence(input(clippedPolicy));
assert(
  clipped.mechanicalVerdict === "fail" &&
    clipped.failures.some((failure) => failure.startsWith("upper-circulation:") && failure.endsWith(":clipped")),
  "clipped targets did not fail",
);
const wrongFacade = policy() as any;
wrongFacade.claims[0].viewedFacade = "right-gable";
rejects(
  () => createBuildingSemanticEvidence(input(wrongFacade)),
  /camera\/facade authority is invalid/,
  "wrong facade accepted",
);

const badOwnerBytes = glb(entries, { nodeId: entries[0].nodeId, ownerId: "owner/forged" }),
  badOwnerFile = exact("virtual/bad-owner.glb", badOwnerBytes),
  badOwnerManifestBytes = manifest(badOwnerFile),
  badOwnerManifestFile = exact("virtual/bad-owner-manifest.json", badOwnerManifestBytes);
rejects(
  () =>
    createBuildingSemanticEvidence(
      input(policy(), badOwnerBytes, badOwnerFile, badOwnerManifestBytes, badOwnerManifestFile),
    ),
  /lacks exact compiler owner\/derivedFrom provenance/,
  "forged GLB owner accepted",
);
const badDerivedBytes = glb(entries, { nodeId: entries[0].nodeId, derivedFrom: ["owner/other"] }),
  badDerivedFile = exact("virtual/bad-derived.glb", badDerivedBytes),
  badDerivedManifestBytes = manifest(badDerivedFile),
  badDerivedManifestFile = exact("virtual/bad-derived-manifest.json", badDerivedManifestBytes);
rejects(
  () =>
    createBuildingSemanticEvidence(
      input(policy(), badDerivedBytes, badDerivedFile, badDerivedManifestBytes, badDerivedManifestFile),
    ),
  /lacks exact compiler owner\/derivedFrom provenance/,
  "forged derivedFrom accepted",
);

const wrongManifestBytes = manifest(glbFile, "candidate/other"),
  wrongManifestFile = exact("virtual/wrong-manifest.json", wrongManifestBytes);
rejects(
  () => createBuildingSemanticEvidence(input(policy(), glbBytes, glbFile, wrongManifestBytes, wrongManifestFile)),
  /manifest\/compiler binding is invalid/,
  "candidate manifest swap accepted",
);
const fabricated: any = structuredClone(evidence);
fabricated.claims[0].targets[0].visibleAnchorCount = 999;
const { evidenceHash: _fabricatedHash, ...fabricatedCore } = fabricated;
fabricated.evidenceHash = canonicalHash(sha256, fabricatedCore as JsonValue);
validateBuildingSemanticEvidence(fabricated);
rejects(
  () => verifyBuildingSemanticEvidence(fabricated, read),
  /recomputation drifted/,
  "rehashed fabricated metrics accepted",
);
const duplicateGlbBytes = glb([...entries, entries[0]]),
  duplicateGlbFile = exact("virtual/duplicate.glb", duplicateGlbBytes),
  duplicateManifestBytes = manifest(duplicateGlbFile),
  duplicateManifestFile = exact("virtual/duplicate-manifest.json", duplicateManifestBytes);
rejects(
  () =>
    createBuildingSemanticEvidence(
      input(policy(), duplicateGlbBytes, duplicateGlbFile, duplicateManifestBytes, duplicateManifestFile),
    ),
  /duplicates target/,
  "duplicate GLB semantic node accepted",
);

console.log(
  "p_building_semantic_evidence OK: manifest-bound compiled witnesses, exact owner-derived GLB groups, and compiler/animation-derived open-door poses prove deterministic mechanical claims; fake geometry, policy transforms, unknown/missing/wrong animations, provenance drift, duplicates, clipping, facade drift, swaps, and fabrication fail closed",
);
