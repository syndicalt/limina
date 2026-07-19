import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  compileArchitecture,
  partitionCompiledArchitecture,
  serializeBlenderShellInput,
} from "../../js/src/architecture/index.ts";
import {
  buildingInteriorPlanV2CanonicalText,
  buildingInteriorPlanV2Hash,
  interiorPlacementFacetScope,
  INTERIOR_PLACEMENT_FACET_ARCHETYPES,
  validateBuildingInteriorPlanV2,
} from "../../js/src/assets/building-interior-plan-v2.mjs";
import {
  BUILDING_STAGE_FACETS,
  validateBuildingHitlDecision,
  validateBuildingStageArtifact,
} from "../../js/src/assets/staged-building-pipeline.mjs";
import { canonicalCompilerJson } from "../../js/src/world/compiler/canonical.mjs";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";

const DEFAULT_ROOT = resolve(import.meta.dirname, "../..");
const DEFAULTS = Object.freeze({
  specPath: "assets/buildings/functional-hall-house-architecture-v5.json",
  shellEvidencePath: "assets/buildings/authoring/functional-hall-house-v4/shell-r4/shell.evidence.json",
  shellSidecarPath: "assets/buildings/authoring/functional-hall-house-v4/shell-r4/shell.glb.shell.json",
  shellArtifactPath: "assets/buildings/authoring/functional-hall-house-v4/shell-r4/shell-artifact-approved.json",
  shellDecisionPath: "assets/buildings/authoring/functional-hall-house-v4/shell-r4/shell-review-decision-approve.json",
  materialArtifactPath:
    "assets/buildings/authoring/functional-hall-house-v4/material-r2/material-palette-artifact-approved.json",
  materialDecisionPath:
    "assets/buildings/authoring/functional-hall-house-v4/material-r2/material-review-decision-approve.json",
  planOutputPath: "assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-plan.json",
  artifactOutputPath:
    "assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-plan-artifact-draft.json",
});

const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const portable = (root, path) => relative(root, path).split(sep).join("/");
const exactFacets = (artifact, scopes) =>
  scopes.map((scope) => {
    const facet = artifact.facets.find((entry) => entry.scope === scope);
    if (!facet) throw new Error(`${artifact.artifactId} lacks required facet ${scope}`);
    return { scope, hash: facet.hash };
  });
const dependency = (artifact, decision, decisionBytes, scopes) => ({
  artifactId: artifact.artifactId,
  kind: artifact.kind,
  revision: artifact.revision,
  status: artifact.status,
  contractHash: artifact.contractHash,
  contentHash: artifact.contentHash,
  approvalDecisionId: decision.decisionId,
  approvalDecisionHash: sha(decisionBytes),
  facets: exactFacets(artifact, scopes),
});
const floorSocket = (id, surfaceId, position, capacityKg = 250) => ({
  id,
  kind: "floor",
  roomId: "room/main",
  surfaceId,
  position,
  normal: [0, 1, 0],
  capacityKg,
});
const placement = (
  id,
  archetypeId,
  zoneId,
  position,
  supportSocketId,
  halfExtents,
  facingTargetId = null,
  yawRadians = 0,
) => ({
  id,
  archetypeId,
  roomId: "room/main",
  zoneId,
  position,
  yawRadians,
  supportSocketId,
  facingTargetId,
  footprint: { localCenter: [0, 0], halfExtents },
});

function buildPlan(shellDependency, materialDependency, revision = 1) {
  const floorY = 0.09,
    roomCenterY = 1.75,
    roomHalfY = 1.75,
    zoneCenterY = 1.74,
    zoneHalfY = 1.66;
  const dining = [
    placement(
      "placement/dining-table",
      "proxy/dining-table",
      "zone/dining",
      [-3, floorY, -0.8],
      "socket/floor/dining-table",
      [0.7, 0.4],
    ),
    placement(
      "placement/dining-chair-north",
      "proxy/dining-chair",
      "zone/dining",
      [-3, floorY, 0],
      "socket/floor/dining-chair-north",
      [0.25, 0.25],
      "facing/dining-table",
      0,
    ),
    placement(
      "placement/dining-chair-south",
      "proxy/dining-chair",
      "zone/dining",
      [-3, floorY, -1.6],
      "socket/floor/dining-chair-south",
      [0.25, 0.25],
      "facing/dining-table",
      Math.PI,
    ),
    placement(
      "placement/dining-chair-west",
      "proxy/dining-chair",
      "zone/dining",
      [-4, floorY, -0.8],
      "socket/floor/dining-chair-west",
      [0.25, 0.25],
      "facing/dining-table",
      revision === 1 ? Math.PI / 2 : -Math.PI / 2,
    ),
    placement(
      "placement/dining-chair-east",
      "proxy/dining-chair",
      "zone/dining",
      [-2, floorY, -0.8],
      "socket/floor/dining-chair-east",
      [0.25, 0.25],
      "facing/dining-table",
      revision === 1 ? -Math.PI / 2 : Math.PI / 2,
    ),
  ];
  const hearthPosition = revision >= 4 ? [2.95, floorY, -0.9] : [0.2, floorY, 2.2],
    hearthYaw = revision >= 4 ? Math.PI : revision >= 3 ? -1.750649826587375 : 1.750649826587375,
    hearthSeat = placement(
      "placement/hearth-settle",
      "proxy/hearth-settle",
      "zone/hearth-seating",
      hearthPosition,
      "socket/floor/hearth-settle",
      [0.8, 0.35],
      "facing/hall-hearth",
      hearthYaw,
    ),
    storage = placement(
      "placement/service-storage",
      "proxy/storage-shelf",
      "zone/service-storage",
      [3.65, floorY, -4.12],
      "socket/floor/service-storage",
      [0.2, 0.5],
    );
  return validateBuildingInteriorPlanV2({
    schema: "limina.building-interior-plan/v2",
    planId: `interior/functional-hall-house-v4/r${revision}`,
    revision,
    supersedes: revision === 1 ? null : `interior/functional-hall-house-v4/r${revision - 1}`,
    units: "meter",
    dependencies: { shell: shellDependency, materials: materialDependency },
    policy: {
      corridorHalfWidthMinM: 0.5,
      clearHeightMinM: 2.2,
      approachRadiusMinM: 0.35,
      occupancyRadiusMinM: 0.3,
      doorOpeningMinRadians: 1.2,
      zoneHeadroomMinM: 2.2,
      occupantAreaMinM2: 0.75,
      hearthClearanceMinM: 0.8,
    },
    rooms: [
      {
        id: "room/main",
        bounds: { center: [0, roomCenterY, -0.815], halfExtents: [4.63, roomHalfY, 4.005] },
        finishedFloorY: floorY,
        ceilingY: 3.43,
        floorRegions: [
          { id: "floor-region/main-usable", center: [0, 0], halfExtents: [4.63, 3.19] },
          { id: "floor-region/passage-bridge", center: [1.9, -3.305], halfExtents: [0.8, 0.115] },
          { id: "floor-region/service-usable", center: [2.62, -4.12], halfExtents: [1.32, 0.7] },
        ],
      },
    ],
    zones: [
      {
        id: "zone/entry",
        kind: "entry",
        roomId: "room/main",
        bounds: { center: [-0.72, zoneCenterY, -2.7], halfExtents: [0.7, zoneHalfY, 0.45] },
        minimumOccupants: 1,
      },
      {
        id: "zone/dining",
        kind: "dining",
        roomId: "room/main",
        bounds: { center: [-3, zoneCenterY, -0.8], halfExtents: [1.4, zoneHalfY, 1.15] },
        minimumOccupants: 5,
      },
      {
        id: "zone/hearth-seating",
        kind: "hearth-seating",
        roomId: "room/main",
        bounds:
          revision >= 4
            ? { center: [2.65, zoneCenterY, -0.3], halfExtents: [1.2, zoneHalfY, 1.1] }
            : { center: [-0.25, zoneCenterY, 2.2], halfExtents: [1.15, zoneHalfY, 0.9] },
        minimumOccupants: 2,
      },
      {
        id: "zone/service-storage",
        kind: "service-storage",
        roomId: "room/main",
        bounds: { center: [2.62, zoneCenterY, -4.12], halfExtents: [1.25, zoneHalfY, 0.65] },
        minimumOccupants: 1,
      },
      {
        id: "zone/circulation",
        kind: "circulation",
        roomId: "room/main",
        bounds: { center: [-0.72, zoneCenterY, 0], halfExtents: [0.5, zoneHalfY, 2.5] },
        minimumOccupants: 1,
      },
    ],
    surfaceSockets: [
      floorSocket("socket/floor/dining-table", "volume/main-hall/floor", [-3, floorY, -0.8]),
      floorSocket("socket/floor/dining-chair-north", "volume/main-hall/floor", [-3, floorY, 0]),
      floorSocket("socket/floor/dining-chair-south", "volume/main-hall/floor", [-3, floorY, -1.6]),
      floorSocket("socket/floor/dining-chair-west", "volume/main-hall/floor", [-4, floorY, -0.8]),
      floorSocket("socket/floor/dining-chair-east", "volume/main-hall/floor", [-2, floorY, -0.8]),
      floorSocket("socket/floor/hearth-settle", "volume/main-hall/floor", hearthPosition, revision >= 3 ? 350 : 250),
      floorSocket("socket/floor/service-storage", "volume/service-bay/floor", [3.65, floorY, -4.12]),
      {
        id: "socket/wall/hall-hearth",
        kind: "wall",
        roomId: "room/main",
        surfaceId: "fireplace/hall-hearth/fireback",
        position: [2.95, 1.2, 3.18],
        normal: [0, 0, -1],
        capacityKg: 80,
      },
      {
        id: "socket/ceiling/main",
        kind: "ceiling",
        roomId: "room/main",
        surfaceId: "volume/main-hall/ceiling",
        position: [0, 3.43, 0],
        normal: [0, -1, 0],
        capacityKg: 20,
      },
      {
        id: "socket/prop/hearth-mantel",
        kind: "prop-support",
        roomId: "room/main",
        surfaceId: "interior-structure/hearth-mantel",
        position: [2.95, 2.3, 1.936],
        normal: [0, 1, 0],
        capacityKg: 12,
      },
    ],
    facingTargets: [
      { id: "facing/dining-table", roomId: "room/main", position: [-3, 0.85, -0.8] },
      { id: "facing/hall-hearth", roomId: "room/main", position: [2.95, 1.2, 2.7] },
    ],
    anchors: [
      {
        id: "anchor/camera/entry-hearth",
        kind: "camera",
        roomId: "room/main",
        position: [-0.72, 1.6, -2.7],
        direction: [0, 0, 1],
        socketId: null,
      },
      {
        id: "anchor/vfx/hall-hearth",
        kind: "vfx",
        roomId: "room/main",
        position: [2.95, 1.2, 3.18],
        direction: [0, 0, -1],
        socketId: "socket/wall/hall-hearth",
      },
      {
        id: "anchor/lighting/main-ceiling",
        kind: "lighting",
        roomId: "room/main",
        position: [0, 3.43, 0],
        direction: [0, -1, 0],
        socketId: "socket/ceiling/main",
      },
    ],
    sightlines: [
      {
        id: "sightline/entry-hearth",
        roomId: "room/main",
        cameraAnchorId: "anchor/camera/entry-hearth",
        targetAnchorId: "anchor/vfx/hall-hearth",
      },
    ],
    occlusionConstraints: [
      {
        id: "occlusion/entry-hearth",
        sightlineId: "sightline/entry-hearth",
        clearRadiusM: 0.1,
        maximumOccluderHeightM: 0.8,
      },
    ],
    proxyArchetypes: [
      {
        id: "proxy/dining-table",
        kind: "table",
        dimensions: [1.4, 0.78, 0.8],
        supportKind: "floor",
        requiresApproach: true,
        requiresOccupancy: false,
      },
      {
        id: "proxy/dining-chair",
        kind: "chair",
        dimensions: [0.5, 0.9, 0.5],
        supportKind: "floor",
        requiresApproach: false,
        requiresOccupancy: true,
      },
      {
        id: "proxy/hearth-settle",
        kind: "settle",
        dimensions: [1.6, 1.3, 0.7],
        supportKind: "floor",
        requiresApproach: true,
        requiresOccupancy: true,
      },
      {
        id: "proxy/storage-shelf",
        kind: "storage",
        dimensions: [0.4, 1.8, 1],
        supportKind: "floor",
        requiresApproach: true,
        requiresOccupancy: false,
      },
    ],
    placements: [...dining, hearthSeat, storage],
    interactionClearances: [
      ...dining.slice(1).map((entry) => ({
        id: `clearance/occupancy/${entry.id.split("/").at(-1)}`,
        kind: "occupancy",
        placementId: entry.id,
        roomId: "room/main",
        center: entry.position,
        radiusM: 0.3,
        heightM: 1.5,
      })),
      {
        id: "clearance/approach/dining-table",
        kind: "approach",
        placementId: "placement/dining-table",
        roomId: "room/main",
        center: [-3, floorY, 0.65],
        radiusM: 0.35,
        heightM: 1.9,
      },
      ...(revision >= 4
        ? [
            {
              id: "clearance/approach/hearth-settle",
              kind: "approach",
              placementId: "placement/hearth-settle",
              roomId: "room/main",
              center: [2.95, floorY, -0.05],
              radiusM: 0.35,
              heightM: 1.9,
            },
            {
              id: "clearance/occupancy/hearth-settle-left",
              kind: "occupancy",
              placementId: "placement/hearth-settle",
              roomId: "room/main",
              center: [3.27, floorY, -0.85],
              radiusM: 0.3,
              heightM: 1.5,
            },
            {
              id: "clearance/occupancy/hearth-settle-right",
              kind: "occupancy",
              placementId: "placement/hearth-settle",
              roomId: "room/main",
              center: [2.63, floorY, -0.85],
              radiusM: 0.3,
              heightM: 1.5,
            },
          ]
        : revision >= 3
          ? [
              {
                id: "clearance/approach/hearth-settle",
                kind: "approach",
                placementId: "placement/hearth-settle",
                roomId: "room/main",
                center: [1.0362894235849214, floorY, 2.352052622469986],
                radiusM: 0.35,
                heightM: 1.9,
              },
              {
                id: "clearance/occupancy/hearth-settle-left",
                kind: "occupancy",
                placementId: "placement/hearth-settle",
                roomId: "room/main",
                center: [0.30643683572899, floorY, 1.894105900678029],
                radiusM: 0.3,
                heightM: 1.5,
              },
              {
                id: "clearance/occupancy/hearth-settle-right",
                kind: "occupancy",
                placementId: "placement/hearth-settle",
                roomId: "room/main",
                center: [0.19195015528100076, floorY, 2.5237826431419697],
                radiusM: 0.3,
                heightM: 1.5,
              },
            ]
          : [
              {
                id: "clearance/approach/hearth-settle",
                kind: "approach",
                placementId: "placement/hearth-settle",
                roomId: "room/main",
                center: [0.2, floorY, 1.05],
                radiusM: 0.35,
                heightM: 1.9,
              },
              {
                id: "clearance/occupancy/hearth-settle",
                kind: "occupancy",
                placementId: "placement/hearth-settle",
                roomId: "room/main",
                center: [0.2, floorY, 2.2],
                radiusM: 0.3,
                heightM: 1.5,
              },
            ]),
      {
        id: "clearance/approach/service-storage",
        kind: "approach",
        placementId: "placement/service-storage",
        roomId: "room/main",
        center: [3, floorY, -4.12],
        radiusM: 0.35,
        heightM: 1.9,
      },
    ],
    navigation: {
      entryNodeId: "nav/entry",
      nodes: [
        { id: "nav/entry", roomId: "room/main", zoneId: "zone/entry", position: [-0.72, floorY, -2.65] },
        { id: "nav/circulation", roomId: "room/main", zoneId: "zone/circulation", position: [-0.72, floorY, 0.3] },
        { id: "nav/dining", roomId: "room/main", zoneId: "zone/dining", position: [-1.65, floorY, 0.3] },
        {
          id: "nav/hearth-turn",
          roomId: "room/main",
          zoneId: null,
          position: revision >= 4 ? [0.7, floorY, 0] : [-1.8, floorY, 0.8],
        },
        {
          id: "nav/hearth-seating",
          roomId: "room/main",
          zoneId: "zone/hearth-seating",
          position: revision >= 4 ? [1.6, floorY, 0] : [-1.3, floorY, 3],
        },
        { id: "nav/service-approach", roomId: "room/main", zoneId: null, position: [1.9, floorY, -2.65] },
        { id: "nav/passage", roomId: "room/main", zoneId: null, position: [1.9, floorY, -3.305] },
        {
          id: "nav/service-storage",
          roomId: "room/main",
          zoneId: "zone/service-storage",
          position: [2.1, floorY, -4.12],
        },
      ],
      edges: [
        {
          id: "nav-edge/entry-circulation",
          fromNodeId: "nav/entry",
          toNodeId: "nav/circulation",
          halfWidthM: 0.5,
          clearHeightM: 2.2,
        },
        {
          id: "nav-edge/circulation-dining",
          fromNodeId: "nav/circulation",
          toNodeId: "nav/dining",
          halfWidthM: 0.5,
          clearHeightM: 2.2,
        },
        {
          id: "nav-edge/circulation-hearth-turn",
          fromNodeId: "nav/circulation",
          toNodeId: "nav/hearth-turn",
          halfWidthM: 0.5,
          clearHeightM: 2.2,
        },
        {
          id: "nav-edge/hearth-turn-seating",
          fromNodeId: "nav/hearth-turn",
          toNodeId: "nav/hearth-seating",
          halfWidthM: 0.5,
          clearHeightM: 2.2,
        },
        {
          id: "nav-edge/entry-service-approach",
          fromNodeId: "nav/entry",
          toNodeId: "nav/service-approach",
          halfWidthM: 0.5,
          clearHeightM: 2.2,
        },
        {
          id: "nav-edge/service-approach-passage",
          fromNodeId: "nav/service-approach",
          toNodeId: "nav/passage",
          halfWidthM: 0.5,
          clearHeightM: 2.2,
        },
        {
          id: "nav-edge/passage-storage",
          fromNodeId: "nav/passage",
          toNodeId: "nav/service-storage",
          halfWidthM: 0.5,
          clearHeightM: 2.2,
        },
      ],
    },
    doorSweeps: [
      {
        id: "door-sweep/front",
        roomId: "room/main",
        doorId: "door/front",
        hinge: [-1.44, 0.09, -3.66],
        radiusM: 1.44,
        leafThicknessM: 0.11,
        heightM: 2.48,
        closedYawRadians: 0,
        openYawRadians: -1.6580627893946132,
      },
    ],
    hearthExclusions: [
      {
        id: "hearth-exclusion/hall-hearth",
        roomId: "room/main",
        hearthId: "hall-hearth",
        center: [2.95, 0.09, 2.58],
        halfExtents: [0.88, 0.98],
        yawRadians: Math.PI,
        minimumClearanceM: 0.8,
        heightM: 2.3,
      },
    ],
    requiredZoneIds: ["zone/entry", "zone/dining", "zone/hearth-seating", "zone/service-storage", "zone/circulation"],
  });
}

function facetHash(scope, plan, planHash) {
  const selections = {
    "activity-zones": { rooms: plan.rooms, zones: plan.zones, requiredZoneIds: plan.requiredZoneIds },
    placements: {
      proxyArchetypes: plan.proxyArchetypes,
      placements: plan.placements,
      interactionClearances: plan.interactionClearances,
    },
    circulation: { navigation: plan.navigation, doorSweeps: plan.doorSweeps },
    sightlines: { anchors: plan.anchors, sightlines: plan.sightlines, occlusionConstraints: plan.occlusionConstraints },
    "support-bindings": { surfaceSockets: plan.surfaceSockets },
    "vfx-intent": {
      hearthExclusions: plan.hearthExclusions,
      anchors: plan.anchors.filter((entry) => entry.kind === "vfx"),
    },
  };
  return sha(
    canonicalCompilerJson({ schema: "limina.interior-plan-facet/v1", scope, planHash, payload: selections[scope] }),
  );
}

export function interiorArchetypePlacementFacetHash(archetypeId, plan) {
  const placementIds = new Set(
    plan.placements.filter((entry) => entry.archetypeId === archetypeId).map((entry) => entry.id),
  );
  return sha(
    canonicalCompilerJson({
      schema: "limina.interior-archetype-placement-facet/v1",
      archetypeId,
      proxyArchetype: plan.proxyArchetypes.find((entry) => entry.id === archetypeId),
      placements: plan.placements.filter((entry) => entry.archetypeId === archetypeId),
      interactionClearances: plan.interactionClearances.filter((entry) => placementIds.has(entry.placementId)),
    }),
  );
}

export async function buildInteriorPlanStage(options = {}) {
  const revision = options.revision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new Error("interior plan revision must be a positive integer");
  const revisionDefaults =
    revision === 1
      ? DEFAULTS
      : {
          ...DEFAULTS,
          planOutputPath: `assets/buildings/authoring/functional-hall-house-v4/interior-r${revision}/interior-plan.json`,
          artifactOutputPath: `assets/buildings/authoring/functional-hall-house-v4/interior-r${revision}/interior-plan-artifact-draft.json`,
        };
  const root = resolve(options.repoRoot ?? DEFAULT_ROOT),
    configured = { ...revisionDefaults, ...options };
  const paths = Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, resolve(root, configured[key])]));
  const bytes = await Promise.all(
    [
      paths.specPath,
      paths.shellEvidencePath,
      paths.shellSidecarPath,
      paths.shellArtifactPath,
      paths.shellDecisionPath,
      paths.materialArtifactPath,
      paths.materialDecisionPath,
    ].map((path) => readFile(path)),
  );
  const [
    specBytes,
    evidenceBytes,
    sidecarBytes,
    shellArtifactBytes,
    shellDecisionBytes,
    materialArtifactBytes,
    materialDecisionBytes,
  ] = bytes;
  const spec = JSON.parse(specBytes),
    evidence = JSON.parse(evidenceBytes),
    sidecar = JSON.parse(sidecarBytes),
    shell = validateBuildingStageArtifact(JSON.parse(shellArtifactBytes)),
    shellDecision = validateBuildingHitlDecision(JSON.parse(shellDecisionBytes)),
    materials = validateBuildingStageArtifact(JSON.parse(materialArtifactBytes)),
    materialDecision = validateBuildingHitlDecision(JSON.parse(materialDecisionBytes));
  const compiled = compileArchitecture(spec),
    partition = partitionCompiledArchitecture(spec, compiled),
    recompiledSidecar = JSON.parse(serializeBlenderShellInput(partition, compiled));
  if (
    compiled.specHash !== evidence.sourceSpecHash ||
    compiled.irHash !== evidence.sourceIrHash ||
    partition.shell.payloadHash !== evidence.shellPayloadHash ||
    sidecar.specHash !== compiled.specHash ||
    sidecar.irHash !== partition.shell.payloadHash ||
    canonicalCompilerJson(recompiledSidecar) !== canonicalCompilerJson(sidecar)
  )
    throw new Error("I1 source/spec/IR/shell payload closure drifted from approved shell r4");
  if (
    shell.kind !== "shell" ||
    shell.status !== "approved" ||
    shell.artifactId !== "shell/functional-hall-house-v4/r4" ||
    shell.contractHash !== partition.shell.payloadHash ||
    shell.contentHash !== evidence.asset.sha256
  )
    throw new Error("I1 approved shell r4 identity drifted");
  if (
    shellDecision.decision !== "approve" ||
    shellDecision.artifactId !== shell.artifactId ||
    shellDecision.contractHash !== shell.contractHash ||
    shellDecision.contentHash !== shell.contentHash ||
    shell.metadata?.approval?.sha256 !== sha(shellDecisionBytes)
  )
    throw new Error("I1 shell approval decision closure drifted");
  const shellGlbPath = resolve(root, shell.metadata.runtimeGlb.path),
    shellGlbBytes = await readFile(shellGlbPath);
  if (sha(shellGlbBytes) !== shell.contentHash || sha(shellGlbBytes) !== evidence.asset.sha256)
    throw new Error("I1 exact approved shell GLB drifted");
  if (
    materials.kind !== "material-palette" ||
    materials.status !== "approved" ||
    materials.artifactId !== "materials/functional-hall-house-v4/r2"
  )
    throw new Error("I1 approved M1 identity drifted");
  if (
    materialDecision.decision !== "approve" ||
    materialDecision.artifactId !== materials.artifactId ||
    materialDecision.contractHash !== materials.contractHash ||
    materialDecision.contentHash !== materials.contentHash ||
    materials.metadata?.approval?.sha256 !== sha(materialDecisionBytes)
  )
    throw new Error("I1 M1 approval decision closure drifted");
  const derived = materials.metadata?.derivedRuntime;
  if (!derived?.path || derived.sha256 !== materials.contentHash)
    throw new Error("I1 approved M1 lacks exact derived runtime identity");
  const derivedBytes = await readFile(resolve(root, derived.path));
  if (sha(derivedBytes) !== derived.sha256 || portableAssetContentHash(derivedBytes) !== derived.assetHash)
    throw new Error("I1 approved M1 derived GLB bytes drifted");
  const shellScopes = [
      "interior-envelope",
      "support-sockets",
      "portal-articulation",
      "hearth-flue-sockets",
      "collision-traversal",
    ],
    materialScopes = ["role-contract", "surface-parameters", "runtime-textures"];
  const plan = buildPlan(
      dependency(shell, shellDecision, shellDecisionBytes, shellScopes),
      dependency(materials, materialDecision, materialDecisionBytes, materialScopes),
      revision,
    ),
    planHash = buildingInteriorPlanV2Hash(plan),
    planText = buildingInteriorPlanV2CanonicalText(plan),
    planBytes = Buffer.from(`${planText}\n`);
  const facets = BUILDING_STAGE_FACETS["interior-plan"].map((scope) => ({
    scope,
    hash: facetHash(scope, plan, planHash),
  }));
  if (revision >= 2)
    for (const archetypeId of INTERIOR_PLACEMENT_FACET_ARCHETYPES)
      facets.push({
        scope: interiorPlacementFacetScope(archetypeId),
        hash: interiorArchetypePlacementFacetHash(archetypeId, plan),
      });
  const yawConventionMigration =
    revision === 1
      ? undefined
      : revision === 2
        ? {
            from: "legacy-atan2-dx-negative-dz",
            to: "engine-three-local-negative-z-atan2-negative-dx-negative-dz",
            changedPlacementIds: ["placement/dining-chair-west", "placement/dining-chair-east"],
          }
        : revision === 3
          ? {
              from: "legacy-positive-yaw-hearth-settle",
              to: "engine-three-local-negative-z-facing-target",
              changedPlacementIds: ["placement/hearth-settle"],
            }
          : {
              from: "side-staged-hearth-settle",
              to: "front-facing-wall-parallel-hearth-settle",
              changedPlacementIds: ["placement/hearth-settle"],
            };
  const artifact = validateBuildingStageArtifact({
    schema: "limina.building-stage-artifact/v1",
    artifactId: plan.planId,
    kind: "interior-plan",
    revision,
    status: "draft",
    contractHash: planHash,
    contentHash: sha(planBytes),
    facets,
    inputs: [
      { artifactId: shell.artifactId, kind: shell.kind, facets: exactFacets(shell, shellScopes) },
      { artifactId: materials.artifactId, kind: materials.kind, facets: exactFacets(materials, materialScopes) },
    ],
    evidence: [],
    ...(revision === 1 ? {} : { supersedes: `interior/functional-hall-house-v4/r${revision - 1}` }),
    metadata: {
      gate: "I1-layout",
      humanDecision: "not-reviewed",
      proxyOnly: true,
      sleepingOmitted: true,
      ...(yawConventionMigration ? { yawConventionMigration } : {}),
      plan: { path: portable(root, paths.planOutputPath), canonicalHash: planHash, contentHash: sha(planBytes) },
      sourceClosure: {
        specPath: portable(root, paths.specPath),
        specSha256: sha(specBytes),
        specHash: compiled.specHash,
        sourceIrHash: compiled.irHash,
        shellPayloadHash: partition.shell.payloadHash,
        sidecarPath: portable(root, paths.shellSidecarPath),
        sidecarSha256: sha(sidecarBytes),
      },
      approvedShell: {
        path: portable(root, paths.shellArtifactPath),
        sha256: sha(shellArtifactBytes),
        decisionPath: portable(root, paths.shellDecisionPath),
        decisionSha256: sha(shellDecisionBytes),
        runtimeGlbPath: portable(root, shellGlbPath),
        runtimeGlbSha256: sha(shellGlbBytes),
      },
      approvedMaterials: {
        path: portable(root, paths.materialArtifactPath),
        sha256: sha(materialArtifactBytes),
        decisionPath: portable(root, paths.materialDecisionPath),
        decisionSha256: sha(materialDecisionBytes),
        derivedAssetId: derived.assetId,
        derivedGlbPath: derived.path,
        derivedGlbSha256: derived.sha256,
        derivedAssetHash: derived.assetHash,
      },
      policy: {
        hearthFrontClearanceM: 0.8,
        hearthClearanceAuthority: "explicit-i1-conservative-policy",
        navigationFullWidth: true,
      },
    },
  });
  if (options.write !== false) {
    await Promise.all([
      mkdir(dirname(paths.planOutputPath), { recursive: true }),
      mkdir(dirname(paths.artifactOutputPath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(paths.planOutputPath, planBytes, { mode: 0o600, flag: "wx" }),
      writeFile(paths.artifactOutputPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600, flag: "wx" }),
    ]);
  }
  return Object.freeze({ plan, artifact, planBytes, planHash, paths });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2),
    revisionIndex = args.indexOf("--revision"),
    revision = revisionIndex < 0 ? 1 : Number(args[revisionIndex + 1]);
  const result = await buildInteriorPlanStage({ revision });
  console.log(
    JSON.stringify(
      {
        planId: result.plan.planId,
        planHash: result.planHash,
        artifactId: result.artifact.artifactId,
        status: result.artifact.status,
      },
      null,
      2,
    ),
  );
}
