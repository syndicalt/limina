import assert from "node:assert/strict";
import test from "node:test";
import {
  furnitureDesignContractHash,
  validateFurnitureDesignContract,
} from "../../js/src/architecture/furniture-design-contract.ts";
import { verifyFurnitureFunction } from "../../js/src/architecture/furniture-functional-verifier.ts";

const HASH = `sha256:${"a".repeat(64)}`,
  GLB_HASH = `sha256:${"b".repeat(64)}`,
  INVENTORY_HASH = `sha256:${"c".repeat(64)}`,
  PLAN_HASH = `sha256:${"d".repeat(64)}`,
  PLAN_CONTENT = `sha256:${"e".repeat(64)}`;
const tierIds = ["tier/low", "tier/lower-middle", "tier/upper-middle", "tier/high"],
  supportIds = ["support/front-left", "support/front-right", "support/rear-left", "support/rear-right"],
  tierY = [0.1, 0.55, 1, 1.45];
const runtime = (id, min, max) => ({ id, bounds: { min, max }, vertexCount: 24 });
const tier = (id, y) => ({
  id,
  kind: "shaped-board",
  materialRole: "oak",
  center: [0, y, 0],
  rotationDeg: [0, 0, 0],
  geometry: { kind: "shaped-board", size: [0.36, 0.04, 0.94], edgeProfile: "eased", edgeRadiusM: 0.004 },
});
const support = (id, x, z) => ({
  id,
  kind: "tapered-member",
  materialRole: "oak",
  center: [x, 0.9, z],
  rotationDeg: [0, 0, 0],
  geometry: {
    kind: "tapered-member",
    lengthM: 1.8,
    bottomSection: [0.06, 0.06],
    topSection: [0.06, 0.06],
    axis: "y",
    chamferM: 0.004,
  },
});
const collider = (id, center, halfExtents, covers) => ({ id, center, halfExtents, covers });

function fixture() {
  const parts = [
      ...tierIds.map((id, index) => tier(id, tierY[index])),
      support(supportIds[0], -0.17, -0.47),
      support(supportIds[1], -0.17, 0.47),
      support(supportIds[2], 0.17, -0.47),
      support(supportIds[3], 0.17, 0.47),
    ],
    joints = tierIds.flatMap((tierId, tierIndex) =>
      supportIds.map((supportId, supportIndex) => ({
        id: `joint/t${tierIndex}-s${supportIndex}`,
        type: "housing",
        members: [tierId, supportId],
        toleranceM: 0.005,
      })),
    );
  const contract = validateFurnitureDesignContract({
    schema: "limina.furniture-design-contract/v1",
    id: "furniture/service-storage/v1",
    role: "service-storage",
    visualDesign: { id: "furniture/service-storage/visual", hash: HASH },
    dimensions: { widthM: 0.4, heightM: 1.8, depthM: 1, seatHeightM: 0, seatDepthM: 0, occupancy: 0 },
    storage: {
      tierPartIds: tierIds,
      verticalSupportPartIds: supportIds,
      approachSocketId: "approach/front",
      canonicalFront: [-1, 0, 0],
      ratedLoadKgPerTier: 25,
    },
    parts,
    joints,
    sockets: [
      {
        id: "approach/front",
        kind: "approach",
        position: [-0.65, 0, 0],
        facing: [1, 0, 0],
        supportedBy: tierIds[0],
        clearanceRadiusM: 0.35,
      },
    ],
    colliders: [
      ...tierIds.map((id, index) =>
        collider(`collision/tier-${index}`, [0, tierY[index], 0], [0.18, 0.02, 0.47], [id]),
      ),
      collider("collision/front-left", [-0.17, 0.9, -0.47], [0.03, 0.9, 0.03], [supportIds[0]]),
      collider("collision/front-right", [-0.17, 0.9, 0.47], [0.03, 0.9, 0.03], [supportIds[1]]),
      collider("collision/rear-left", [0.17, 0.9, -0.47], [0.03, 0.9, 0.03], [supportIds[2]]),
      collider("collision/rear-right", [0.17, 0.9, 0.47], [0.03, 0.9, 0.03], [supportIds[3]]),
    ],
    materialRoles: ["oak"],
    status: "candidate",
  });
  const contractHash = furnitureDesignContractHash(contract),
    partBounds = [
      ...tierIds.map((id, index) =>
        runtime(id, [-0.18, tierY[index] - 0.02, -0.47], [0.18, tierY[index] + 0.02, 0.47]),
      ),
      runtime(supportIds[0], [-0.2, 0, -0.5], [-0.14, 1.8, -0.44]),
      runtime(supportIds[1], [-0.2, 0, 0.44], [-0.14, 1.8, 0.5]),
      runtime(supportIds[2], [0.14, 0, -0.5], [0.2, 1.8, -0.44]),
      runtime(supportIds[3], [0.14, 0, 0.44], [0.2, 1.8, 0.5]),
    ];
  const buildEvidence = {
    schema: "limina.furniture-contract-build-evidence/v1",
    payloadHash: contractHash,
    bounds: { min: [-0.2, 0, -0.5], max: [0.2, 1.8, 0.5] },
    asset: { sha256: GLB_HASH, bytes: 2000 },
    inventory: { parts: parts.length, joints: joints.length, sockets: 1, colliders: 8 },
    freshProcessValidation: { contractHash, semanticInventorySha256: INVENTORY_HASH },
    glbValidation: {
      finiteAccessorBounds: true,
      contractIdentity: true,
      boundsSource: "exported-glb-scene-graph",
      pivot: [0, 0, 0],
      partBounds,
    },
  };
  const storagePlacement = {
      id: "placement/service-storage",
      archetypeId: "proxy/storage-shelf",
      roomId: "room/main",
      zoneId: "zone/service-storage",
      position: [3.65, 0.09, -4.12],
      yawRadians: 0,
      supportSocketId: "socket/floor/service-storage",
      facingTargetId: null,
      footprint: { localCenter: [0, 0], halfExtents: [0.2, 0.5] },
    },
    otherPlacement = {
      id: "placement/dining-table",
      archetypeId: "proxy/dining-table",
      roomId: "room/main",
      zoneId: "zone/dining",
      position: [-3, 0.09, -0.8],
      yawRadians: 0,
      supportSocketId: "socket/floor/dining-table",
      facingTargetId: null,
      footprint: { localCenter: [0, 0], halfExtents: [0.7, 0.4] },
    };
  const plan = {
      schema: "limina.building-interior-plan/v2",
      planId: "interior/functional-hall-house-v4/r2",
      revision: 2,
      proxyArchetypes: [
        {
          id: "proxy/storage-shelf",
          kind: "storage",
          dimensions: [0.4, 1.8, 1],
          supportKind: "floor",
          requiresApproach: true,
          requiresOccupancy: false,
        },
        {
          id: "proxy/dining-table",
          kind: "table",
          dimensions: [1.4, 0.78, 0.8],
          supportKind: "floor",
          requiresApproach: true,
          requiresOccupancy: false,
        },
      ],
      placements: [storagePlacement, otherPlacement],
      interactionClearances: [
        {
          id: "clearance/approach/service-storage",
          kind: "approach",
          placementId: storagePlacement.id,
          roomId: "room/main",
          center: [3, 0.09, -4.12],
          radiusM: 0.35,
          heightM: 1.9,
        },
      ],
      facingTargets: [],
      surfaceSockets: [
        {
          id: "socket/floor/service-storage",
          kind: "floor",
          roomId: "room/main",
          position: [3.65, 0.09, -4.12],
          normal: [0, 1, 0],
          capacityKg: 250,
        },
      ],
    },
    artifact = {
      schema: "limina.building-stage-artifact/v1",
      artifactId: plan.planId,
      kind: "interior-plan",
      status: "approved",
      contractHash: PLAN_HASH,
      contentHash: PLAN_CONTENT,
      metadata: { plan: { canonicalHash: PLAN_HASH, contentHash: PLAN_CONTENT } },
    };
  return {
    contract,
    contractHash,
    buildEvidence,
    runtimeGlbSha256: GLB_HASH,
    approvedI1: { artifact, plan, canonicalPlanHash: PLAN_HASH, planContentHash: PLAN_CONTENT },
    selectedProxyArchetypeId: "proxy/storage-shelf",
  };
}

const check = (evidence, id) => evidence.checks.find((entry) => entry.id === id),
  run = (mutate = () => {}) => {
    const input = structuredClone(fixture());
    mutate(input);
    return verifyFurnitureFunction(input);
  },
  storage = (evidence) => check(evidence, "storage-i1-functional-placement");

test("proves an exact four-tier open storage rack in its approved I1 r2 service placement", () => {
  const evidence = run();
  assert.equal(
    evidence.verdict,
    "pass",
    JSON.stringify(
      evidence.checks.filter((entry) => !entry.passed),
      null,
      2,
    ),
  );
  assert.deepEqual(storage(evidence).metrics, {
    applicable: true,
    approachErrorM: 0,
    loadedStabilityMarginM: 0.081611348,
    placements: 1,
    ratedLoadKg: 100,
    tiers: 4,
  });
});

test("rejects missing, undersized, vertical, and too-close tier geometry", () => {
  const cases = [
    (input) =>
      (input.buildEvidence.glbValidation.partBounds = input.buildEvidence.glbValidation.partBounds.filter(
        (part) => part.id !== tierIds[3],
      )),
    (input) =>
      (input.buildEvidence.glbValidation.partBounds.find((part) => part.id === tierIds[2]).bounds.max[2] = 0.2),
    (input) =>
      (input.buildEvidence.glbValidation.partBounds.find((part) => part.id === tierIds[1]).bounds.max[1] = 0.7),
    (input) => {
      const part = input.buildEvidence.glbValidation.partBounds.find((entry) => entry.id === tierIds[1]);
      part.bounds.min[1] = 0.38;
      part.bounds.max[1] = 0.42;
    },
  ];
  for (const mutate of cases) assert.equal(storage(run(mutate)).passed, false);
});

test("rejects a tier without two support joints and a floating declared support", () => {
  const joints = run((input) => {
    input.contract.joints = input.contract.joints.filter(
      (joint) => !joint.members.includes(tierIds[3]) || joint.members.includes(supportIds[0]),
    );
  });
  assert.ok(storage(joints).findings.some((finding) => finding.includes("not joined to two")));
  const floating = run((input) => {
    const part = input.buildEvidence.glbValidation.partBounds.find((entry) => entry.id === supportIds[3]);
    part.bounds.min[1] = 0.1;
  });
  assert.ok(storage(floating).findings.some((finding) => finding.includes("does not reach the floor")));
});

test("rejects insufficient floor capacity and unstable front-loaded support", () => {
  const capacity = run((input) => {
    input.approvedI1.plan.surfaceSockets[0].capacityKg = 100;
  });
  assert.ok(storage(capacity).findings.some((finding) => finding.includes("floor/load")));
  const unstable = run((input) => {
    for (const id of supportIds) {
      const part = input.buildEvidence.glbValidation.partBounds.find((entry) => entry.id === id);
      part.bounds.min[0] = -0.025;
      part.bounds.max[0] = 0.025;
    }
  });
  assert.ok(storage(unstable).findings.some((finding) => finding.includes("stability margin")));
});

test("rejects wrong approach position, facing, and I1 clearance", () => {
  const position = run((input) => {
    input.contract.sockets[0].position = [-0.55, 0, 0];
  });
  assert.ok(storage(position).findings.some((finding) => finding.includes("does not fit or face inward")));
  const facing = run((input) => {
    input.contract.sockets[0].facing = [-1, 0, 0];
  });
  assert.ok(storage(facing).findings.some((finding) => finding.includes("does not fit or face inward")));
  const clearance = run((input) => {
    input.approvedI1.plan.interactionClearances[0].center = [3.1, 0.09, -4.12];
  });
  assert.ok(storage(clearance).findings.some((finding) => finding.includes("does not fit or face inward")));
});

test("rejects transformed composition collision and front-aperture occlusion", () => {
  const collision = run((input) => {
    input.approvedI1.plan.placements[1].position = [3.65, 0.09, -4.12];
  });
  assert.ok(storage(collision).findings.some((finding) => finding.includes("transformed runtime envelope intersects")));
  const occluded = run((input) => {
    const id = "panel/front-occluder";
    input.contract.parts.push({
      id,
      kind: "panel",
      materialRole: "oak",
      center: [-0.15, 0.325, 0],
      rotationDeg: [0, 0, 0],
      geometry: { kind: "panel", size: [0.06, 0.35, 0.8], fieldDepthM: 0.01, fieldMarginM: 0.03, edgeRadiusM: 0.004 },
    });
    input.contract.joints.push({
      id: "joint/front-occluder",
      type: "housing",
      members: [id, supportIds[0]],
      toleranceM: 0.005,
    });
    input.contract.colliders.push(collider("collision/front-occluder", [-0.15, 0.325, 0], [0.03, 0.175, 0.4], [id]));
    input.buildEvidence.glbValidation.partBounds.push(runtime(id, [-0.18, 0.15, -0.4], [-0.12, 0.5, 0.4]));
    input.buildEvidence.inventory.parts++;
    input.buildEvidence.inventory.joints++;
    input.buildEvidence.inventory.colliders++;
  });
  assert.ok(storage(occluded).findings.some((finding) => finding.includes("aperture is occluded")));
});
