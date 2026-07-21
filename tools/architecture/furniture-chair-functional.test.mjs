import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
const member = (id, center) => ({
  id,
  kind: "tapered-member",
  materialRole: "wood",
  center,
  rotationDeg: [0, 0, 0],
  geometry: {
    kind: "tapered-member",
    lengthM: 0.42,
    bottomSection: [0.06, 0.06],
    topSection: [0.06, 0.06],
    axis: "y",
    chamferM: 0.004,
  },
});
const runtime = (id, min, max) => ({ id, bounds: { min, max }, vertexCount: 24 });

function contract() {
  const legs = [
      member("leg/front-left", [-0.19, 0.21, -0.19]),
      member("leg/front-right", [0.19, 0.21, -0.19]),
      member("leg/rear-left", [-0.19, 0.21, 0.19]),
      member("leg/rear-right", [0.19, 0.21, 0.19]),
    ],
    seat = {
      id: "seat",
      kind: "shaped-board",
      materialRole: "wood",
      center: [0, 0.44, 0],
      rotationDeg: [0, 0, 0],
      geometry: { kind: "shaped-board", size: [0.44, 0.04, 0.42], edgeProfile: "eased", edgeRadiusM: 0.005 },
    },
    back = {
      id: "back",
      kind: "panel",
      materialRole: "wood",
      center: [0, 0.68, 0.2],
      rotationDeg: [0, 0, 0],
      geometry: { kind: "panel", size: [0.44, 0.44, 0.04], fieldDepthM: 0.005, fieldMarginM: 0.03, edgeRadiusM: 0.004 },
    },
    legIds = legs.map((part) => part.id);
  return validateFurnitureDesignContract({
    schema: "limina.furniture-design-contract/v1",
    id: "furniture/dining-chair/v1",
    role: "chair",
    visualDesign: { id: "furniture/dining-chair/visual", hash: HASH },
    dimensions: { widthM: 0.5, heightM: 0.9, depthM: 0.5, seatHeightM: 0.46, seatDepthM: 0.42, occupancy: 1 },
    chair: {
      seatPartId: "seat",
      backPartIds: ["back"],
      legPartIds: legIds,
      usableSeatWidthM: 0.4,
      backSupportHeightM: 0.34,
      ratedLoadKg: 150,
      canonicalForward: [0, 0, -1],
    },
    parts: [...legs, seat, back],
    joints: [
      ...legIds.map((id, index) => ({
        id: `joint/leg-${index}`,
        type: "housing",
        members: [id, "seat"],
        toleranceM: 0.002,
      })),
      { id: "joint/back", type: "housing", members: ["seat", "back"], toleranceM: 0.002 },
    ],
    sockets: [
      {
        id: "occupancy/main",
        kind: "occupancy",
        position: [0, 0.46, 0],
        facing: [0, 0, -1],
        supportedBy: "seat",
        clearanceRadiusM: 0.3,
      },
    ],
    colliders: [
      { id: "collision/base", center: [0, 0.23, 0], halfExtents: [0.25, 0.23, 0.25], covers: [...legIds, "seat"] },
      { id: "collision/back", center: [0, 0.68, 0.2], halfExtents: [0.22, 0.22, 0.025], covers: ["back"] },
    ],
    materialRoles: ["wood"],
    status: "candidate",
  });
}

function build(design) {
  const contractHash = furnitureDesignContractHash(design),
    partBounds = [
      runtime("leg/front-left", [-0.22, 0, -0.22], [-0.16, 0.42, -0.16]),
      runtime("leg/front-right", [0.16, 0, -0.22], [0.22, 0.42, -0.16]),
      runtime("leg/rear-left", [-0.22, 0, 0.16], [-0.16, 0.42, 0.22]),
      runtime("leg/rear-right", [0.16, 0, 0.16], [0.22, 0.42, 0.22]),
      runtime("seat", [-0.22, 0.42, -0.21], [0.22, 0.46, 0.21]),
      runtime("back", [-0.22, 0.46, 0.18], [0.22, 0.9, 0.22]),
    ];
  return {
    schema: "limina.furniture-contract-build-evidence/v1",
    payloadHash: contractHash,
    bounds: { min: [-0.25, 0, -0.25], max: [0.25, 0.9, 0.25] },
    asset: { sha256: GLB_HASH, bytes: 1000 },
    inventory: { parts: 6, joints: 5, sockets: 1, colliders: 2 },
    freshProcessValidation: { contractHash, semanticInventorySha256: INVENTORY_HASH },
    glbValidation: {
      finiteAccessorBounds: true,
      contractIdentity: true,
      boundsSource: "exported-glb-scene-graph",
      pivot: [0, 0, 0],
      partBounds,
    },
  };
}

function closure(
  plan,
  artifact = {
    schema: "limina.building-stage-artifact/v1",
    artifactId: plan.planId,
    kind: "interior-plan",
    status: "approved",
    contractHash: PLAN_HASH,
    contentHash: PLAN_CONTENT,
    metadata: { plan: { canonicalHash: PLAN_HASH, contentHash: PLAN_CONTENT } },
  },
) {
  return { artifact, plan, canonicalPlanHash: artifact.contractHash, planContentHash: artifact.contentHash };
}
const check = (evidence, id) => evidence.checks.find((entry) => entry.id === id);

test("proves a bounded dining chair across four corrected runtime-yaw placements", async () => {
  const design = contract(),
    plan = JSON.parse(
      await readFile(
        new URL(
          "../../assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-plan.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  plan.placements.find((p) => p.id === "placement/dining-chair-west").yawRadians = -Math.PI / 2;
  plan.placements.find((p) => p.id === "placement/dining-chair-east").yawRadians = Math.PI / 2;
  const evidence = verifyFurnitureFunction({
    contract: design,
    contractHash: furnitureDesignContractHash(design),
    buildEvidence: build(design),
    runtimeGlbSha256: GLB_HASH,
    approvedI1: closure(plan),
    selectedProxyArchetypeId: "proxy/dining-chair",
  });
  assert.equal(
    evidence.verdict,
    "pass",
    JSON.stringify(
      evidence.checks.filter((entry) => !entry.passed),
      null,
      2,
    ),
  );
  assert.equal(check(evidence, "chair-i1-functional-placement").metrics.placements, 4);
  assert.equal(check(evidence, "support-polygon-center-of-mass").metrics.floorContactParts, 4);
});

test("fails the current exact I1 side-chair yaw convention instead of mounting chairs backward", async () => {
  const design = contract(),
    planBytes = await readFile(
      new URL(
        "../../assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-plan.json",
        import.meta.url,
      ),
    ),
    artifact = JSON.parse(
      await readFile(
        new URL(
          "../../assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-plan-artifact-approved.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
    plan = JSON.parse(planBytes),
    evidence = verifyFurnitureFunction({
      contract: design,
      contractHash: furnitureDesignContractHash(design),
      buildEvidence: build(design),
      runtimeGlbSha256: GLB_HASH,
      approvedI1: {
        artifact,
        plan,
        canonicalPlanHash: artifact.contractHash,
        planContentHash: `sha256:${createHash("sha256").update(planBytes).digest("hex")}`,
      },
      selectedProxyArchetypeId: "proxy/dining-chair",
    }),
    chairCheck = check(evidence, "chair-i1-functional-placement");
  assert.equal(evidence.verdict, "fail");
  assert.ok(chairCheck.findings.some((finding) => finding.includes("chair-west") && finding.includes("forward")));
  assert.ok(chairCheck.findings.some((finding) => finding.includes("chair-east") && finding.includes("forward")));
});

test("rejects chair envelope drift, insufficient floor load, unstable loading, and composition collision", async () => {
  const design = contract(),
    basePlan = JSON.parse(
      await readFile(
        new URL(
          "../../assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-plan.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  basePlan.placements.find((p) => p.id === "placement/dining-chair-west").yawRadians = -Math.PI / 2;
  basePlan.placements.find((p) => p.id === "placement/dining-chair-east").yawRadians = Math.PI / 2;
  const run = (mutate) => {
    const evidenceBuild = structuredClone(build(design)),
      plan = structuredClone(basePlan),
      contractValue = structuredClone(design);
    mutate({ evidenceBuild, plan, contractValue });
    return verifyFurnitureFunction({
      contract: contractValue,
      contractHash: furnitureDesignContractHash(design),
      buildEvidence: evidenceBuild,
      runtimeGlbSha256: GLB_HASH,
      approvedI1: closure(plan),
      selectedProxyArchetypeId: "proxy/dining-chair",
    });
  };
  const envelope = run(({ evidenceBuild }) => {
    evidenceBuild.bounds.max[0] = 0.254;
  });
  assert.equal(check(envelope, "exported-bounds-envelope-floor-pivot").passed, false);
  const load = run(({ plan }) => {
    for (const socket of plan.surfaceSockets) if (socket.id.includes("dining-chair")) socket.capacityKg = 100;
  });
  assert.ok(check(load, "chair-i1-functional-placement").findings.some((finding) => finding.includes("floor/load")));
  const stability = run(({ evidenceBuild, contractValue }) => {
    contractValue.sockets[0].position[0] = 0.2;
    for (const leg of evidenceBuild.glbValidation.partBounds.filter((part) => part.id.startsWith("leg/")))
      if (leg.id.includes("right")) {
        leg.bounds.min[0] = 0.02;
        leg.bounds.max[0] = 0.08;
      }
  });
  assert.equal(check(stability, "support-polygon-center-of-mass").passed, false);
  const collision = run(({ plan }) => {
    plan.placements.find((p) => p.id === "placement/dining-chair-west").position[0] = -3.8;
  });
  assert.ok(
    check(collision, "chair-i1-functional-placement").findings.some((finding) =>
      finding.includes("intersects placement/dining-table"),
    ),
  );
});
