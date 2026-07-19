import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { verifyFurnitureFunction } from "../../js/src/architecture/furniture-functional-verifier.ts";
import { verifyFurnitureFunctionFiles } from "./verify-furniture-function.ts";

const HASH = `sha256:${"1".repeat(64)}`,
  GLB_HASH = `sha256:${"2".repeat(64)}`,
  PLAN_CONTENT = `sha256:${"3".repeat(64)}`,
  INVENTORY_HASH = `sha256:${"4".repeat(64)}`;
const part = (id, bounds) => ({ id, bounds, vertexCount: 24 });

function fixture() {
  const parts = [
      {
        id: "leg/front-left",
        kind: "tapered-member",
        materialRole: "wood",
        center: [-0.4, 0.225, -0.2],
        rotationDeg: [0, 0, 0],
        geometry: {
          kind: "tapered-member",
          lengthM: 0.45,
          bottomSection: [0.1, 0.1],
          topSection: [0.1, 0.1],
          axis: "y",
          chamferM: 0.005,
        },
      },
      {
        id: "leg/front-right",
        kind: "tapered-member",
        materialRole: "wood",
        center: [0.4, 0.225, -0.2],
        rotationDeg: [0, 0, 0],
        geometry: {
          kind: "tapered-member",
          lengthM: 0.45,
          bottomSection: [0.1, 0.1],
          topSection: [0.1, 0.1],
          axis: "y",
          chamferM: 0.005,
        },
      },
      {
        id: "leg/rear-left",
        kind: "tapered-member",
        materialRole: "wood",
        center: [-0.4, 0.225, 0.2],
        rotationDeg: [0, 0, 0],
        geometry: {
          kind: "tapered-member",
          lengthM: 0.45,
          bottomSection: [0.1, 0.1],
          topSection: [0.1, 0.1],
          axis: "y",
          chamferM: 0.005,
        },
      },
      {
        id: "leg/rear-right",
        kind: "tapered-member",
        materialRole: "wood",
        center: [0.4, 0.225, 0.2],
        rotationDeg: [0, 0, 0],
        geometry: {
          kind: "tapered-member",
          lengthM: 0.45,
          bottomSection: [0.1, 0.1],
          topSection: [0.1, 0.1],
          axis: "y",
          chamferM: 0.005,
        },
      },
      {
        id: "seat",
        kind: "shaped-board",
        materialRole: "wood",
        center: [0, 0.5, 0],
        rotationDeg: [0, 0, 0],
        geometry: { kind: "shaped-board", size: [1, 0.1, 0.5], edgeProfile: "eased", edgeRadiusM: 0.01 },
      },
      {
        id: "back",
        kind: "panel",
        materialRole: "wood",
        center: [0, 0.75, 0.2],
        rotationDeg: [0, 0, 0],
        geometry: { kind: "panel", size: [1, 0.5, 0.1], fieldDepthM: 0.01, fieldMarginM: 0.05, edgeRadiusM: 0.01 },
      },
    ],
    bounds = { min: [-0.5, 0, -0.25], max: [0.5, 1, 0.25] },
    runtimeParts = [
      part("leg/front-left", { min: [-0.45, 0, -0.25], max: [-0.35, 0.5, -0.15] }),
      part("leg/front-right", { min: [0.35, 0, -0.25], max: [0.45, 0.5, -0.15] }),
      part("leg/rear-left", { min: [-0.45, 0, 0.15], max: [-0.35, 0.5, 0.25] }),
      part("leg/rear-right", { min: [0.35, 0, 0.15], max: [0.45, 0.5, 0.25] }),
      part("seat", { min: [-0.5, 0.45, -0.25], max: [0.5, 0.55, 0.25] }),
      part("back", { min: [-0.5, 0.5, 0.15], max: [0.5, 1, 0.25] }),
    ],
    joints = [
      { id: "joint/front-left", type: "housing", members: ["leg/front-left", "seat"], toleranceM: 0.005 },
      { id: "joint/front-right", type: "housing", members: ["leg/front-right", "seat"], toleranceM: 0.005 },
      { id: "joint/rear-left", type: "housing", members: ["leg/rear-left", "seat"], toleranceM: 0.005 },
      { id: "joint/rear-right", type: "housing", members: ["leg/rear-right", "seat"], toleranceM: 0.005 },
      { id: "joint/back", type: "housing", members: ["seat", "back"], toleranceM: 0.005 },
    ];
  const contract = {
    schema: "limina.furniture-design-contract/v1",
    id: "furniture/test-chair/v1",
    role: "chair",
    visualDesign: { id: "furniture/test-chair/visual", hash: HASH },
    dimensions: { widthM: 1, heightM: 1, depthM: 0.5, seatHeightM: 0.5, seatDepthM: 0.5, occupancy: 1 },
    parts,
    joints,
    sockets: [
      {
        id: "occupancy/main",
        kind: "occupancy",
        position: [0, 0.55, 0],
        facing: [0, 0, -1],
        supportedBy: "seat",
        clearanceRadiusM: 0.2,
      },
      {
        id: "approach/front",
        kind: "approach",
        position: [0, 0, -0.75],
        facing: [0, 0, 1],
        supportedBy: "seat",
        clearanceRadiusM: 0.3,
      },
      {
        id: "inspect/front",
        kind: "inspect",
        position: [0, 0.7, -0.8],
        facing: [0, 0, 1],
        supportedBy: "back",
        clearanceRadiusM: 0.25,
      },
    ],
    colliders: [
      {
        id: "collision/base",
        center: [0, 0.275, 0],
        halfExtents: [0.5, 0.275, 0.25],
        covers: ["leg/front-left", "leg/front-right", "leg/rear-left", "leg/rear-right", "seat"],
      },
      { id: "collision/back", center: [0, 0.75, 0.2], halfExtents: [0.5, 0.25, 0.05], covers: ["back"] },
    ],
    materialRoles: ["wood"],
    status: "candidate",
  };
  const build = {
    schema: "limina.furniture-contract-build-evidence/v1",
    payloadHash: HASH,
    bounds,
    asset: { sha256: GLB_HASH, bytes: 1000 },
    inventory: { parts: parts.length, joints: joints.length, sockets: 3, colliders: 2 },
    freshProcessValidation: { contractHash: HASH, semanticInventorySha256: INVENTORY_HASH },
    glbValidation: {
      finiteAccessorBounds: true,
      contractIdentity: true,
      boundsSource: "exported-glb-scene-graph",
      pivot: [0, 0, 0],
      partBounds: runtimeParts,
    },
  };
  const plan = {
      schema: "limina.building-interior-plan/v2",
      planId: "interior/test/r1",
      proxyArchetypes: [
        {
          id: "proxy/chair",
          kind: "chair",
          dimensions: [1, 1, 0.5],
          supportKind: "floor",
          requiresApproach: true,
          requiresOccupancy: true,
        },
      ],
      placements: [
        {
          id: "placement/chair",
          archetypeId: "proxy/chair",
          footprint: { localCenter: [0, 0], halfExtents: [0.5, 0.25] },
        },
      ],
    },
    artifact = {
      schema: "limina.building-stage-artifact/v1",
      artifactId: plan.planId,
      kind: "interior-plan",
      status: "approved",
      contractHash: HASH,
      contentHash: PLAN_CONTENT,
      metadata: { plan: { canonicalHash: HASH, contentHash: PLAN_CONTENT } },
    };
  return {
    contract,
    contractHash: HASH,
    buildEvidence: build,
    runtimeGlbSha256: GLB_HASH,
    approvedI1: { artifact, plan, canonicalPlanHash: HASH, planContentHash: PLAN_CONTENT },
    selectedProxyArchetypeId: "proxy/chair",
  };
}

const check = (evidence, id) => evidence.checks.find((entry) => entry.id === id);

test("passes only a fully proven geometry-derived furniture closure deterministically", () => {
  const input = fixture(),
    left = verifyFurnitureFunction(input),
    right = verifyFurnitureFunction(structuredClone(input));
  assert.equal(left.verdict, "pass");
  assert.deepEqual(left, right);
  assert.equal(left.summary.failed, 0);
});

test("fails closed across identity, I1 envelope, runtime parts, joints, support, sockets, colliders, and LOD", () => {
  const cases = [
    [
      "input-identity",
      (input) => {
        input.runtimeGlbSha256 = HASH;
      },
    ],
    [
      "approved-i1-closure",
      (input) => {
        input.approvedI1.artifact.contentHash = HASH;
      },
    ],
    [
      "exported-bounds-envelope-floor-pivot",
      (input) => {
        input.buildEvidence.bounds.min[1] = 0.2;
      },
    ],
    [
      "runtime-part-geometry",
      (input) => {
        input.buildEvidence.glbValidation.partBounds.pop();
      },
    ],
    [
      "joint-connectivity-contact",
      (input) => {
        input.contract.joints.pop();
      },
    ],
    [
      "support-polygon-center-of-mass",
      (input) => {
        for (const p of input.buildEvidence.glbValidation.partBounds)
          if (p.id.startsWith("leg/")) p.bounds.min[1] = 0.1;
      },
    ],
    [
      "interaction-socket-geometry-posture",
      (input) => {
        input.contract.sockets[0].position = [0, 0.9, 0];
      },
    ],
    [
      "compound-collider-coverage",
      (input) => {
        input.contract.colliders[0].covers = ["seat"];
      },
    ],
    [
      "lod-proof",
      (input) => {
        input.buildEvidence.lod = { levels: ["25m"] };
      },
    ],
  ];
  for (const [id, mutate] of cases) {
    const input = structuredClone(fixture());
    mutate(input);
    const evidence = verifyFurnitureFunction(input);
    assert.equal(evidence.verdict, "fail", id);
    assert.equal(check(evidence, id).passed, false, id);
  }
  const penetration = structuredClone(fixture());
  penetration.buildEvidence.glbValidation.partBounds.find((part) => part.id === "leg/front-left").bounds =
    structuredClone(penetration.buildEvidence.glbValidation.partBounds.find((part) => part.id === "seat").bounds);
  assert.ok(
    check(verifyFurnitureFunction(penetration), "joint-connectivity-contact").findings.some((finding) =>
      finding.includes("penetration"),
    ),
  );
  const throughTenon = structuredClone(penetration);
  throughTenon.contract.joints.find((joint) => joint.id === "joint/front-left").type = "wedged-through-tenon";
  assert.equal(
    check(verifyFurnitureFunction(throughTenon), "joint-connectivity-contact").findings.some((finding) =>
      finding.includes("joint joint/front-left has implausible member penetration"),
    ),
    false,
  );
});

test("real approved settle inspection writes private append-only failure evidence without GPU", async () => {
  const repo = resolve(import.meta.dirname, "../.."),
    directory = await mkdtemp(resolve(tmpdir(), "limina-furniture-functional-")),
    output = resolve(directory, "private/evidence.json"),
    options = {
      contractPath: resolve(repo, "assets/buildings/authoring/furniture/hearth-settle-v2-r2/design-contract.json"),
      buildEvidencePath: resolve(repo, "assets/buildings/authoring/furniture/hearth-settle-v2-r2/build-evidence.json"),
      glbPath: resolve(repo, "assets/buildings/authoring/furniture/hearth-settle-v2-r2/hearth-settle-v2-r2.glb"),
      interiorArtifactPath: resolve(
        repo,
        "assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-plan-artifact-approved.json",
      ),
      interiorPlanPath: resolve(
        repo,
        "assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-plan.json",
      ),
      proxyArchetypeId: "proxy/hearth-settle",
      outputPath: output,
    };
  try {
    const evidence = await verifyFurnitureFunctionFiles(options);
    assert.equal(evidence.verdict, "fail");
    assert.equal(
      check(evidence, "exported-bounds-envelope-floor-pivot").passed,
      false,
      "approved settle must not silently overflow the approved I1 envelope",
    );
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(output, "utf8")).schema, "limina.furniture-functional-evidence/v1");
    await assert.rejects(verifyFurnitureFunctionFiles(options), (error) => error?.code === "EEXIST");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
