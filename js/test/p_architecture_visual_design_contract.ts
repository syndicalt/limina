import {
  validateVisualDesignContract,
  visualDesignContractHash,
  validateFurnitureDesignContract,
  furnitureDesignContractHash,
} from "../src/architecture/index.ts";
const H = `sha256:${"a".repeat(64)}`;
const visual = validateVisualDesignContract({
  schema: "limina.visual-design-contract/v1",
  id: "furniture/hearth-settle/v1",
  subjectKind: "furniture",
  intendedFunction: "Two adults sit beside a medieval hall hearth.",
  prompt: "Broad two-bay oak hearth settle with visibly constructed period joinery.",
  references: [
    {
      id: "museum/settle/front",
      sourceUrl: "https://example.org/settle",
      creator: "Example Museum",
      license: "CC BY 4.0",
      retrievedAt: "2026-07-14T00:00:00Z",
      localPath: "art-direction/references/furniture/settle-front.jpg",
      sha256: H,
      roles: ["silhouette", "construction", "joinery", "function"],
    },
  ],
  cues: [
    {
      id: "broad-two-seat-silhouette",
      statement: "Width clearly dominates height and two occupant bays remain legible.",
      sourceIds: ["museum/settle/front"],
      measurements: [
        { name: "width", unit: "m", target: 2.16 },
        { name: "width-height-ratio", unit: "ratio", minimum: 1.45 },
      ],
      verification: "engine",
    },
  ],
  avoid: ["single-chair silhouette", "intersecting boxes posing as joints"],
  requiredViews: ["front", "right-side", "back", "three-quarter", "joinery-detail"],
  status: "draft",
});
const part = (
  id: string,
  kind: "tapered-member" | "shaped-board" | "panel" = "tapered-member",
  materialRole = "oak-frame",
) => ({
  id,
  kind,
  materialRole,
  center: [0, 0, 0],
  rotationDeg: [0, 0, 0],
  geometry:
    kind === "tapered-member"
      ? { kind, lengthM: 1, bottomSection: [0.1, 0.1], topSection: [0.08, 0.08], axis: "y", chamferM: 0.006 }
      : kind === "shaped-board"
        ? { kind, size: [1, 0.1, 0.4], edgeProfile: "eased", edgeRadiusM: 0.008 }
        : { kind, size: [0.5, 0.5, 0.04], fieldDepthM: 0.01, fieldMarginM: 0.05, edgeRadiusM: 0.005 },
});
const furniture = validateFurnitureDesignContract(
  {
    schema: "limina.furniture-design-contract/v1",
    id: "furniture/hearth-settle/v1",
    role: "hearth-settle",
    visualDesign: { id: visual.id, hash: visualDesignContractHash(visual) },
    dimensions: { widthM: 2.16, heightM: 1.46, depthM: 0.72, seatHeightM: 0.47, seatDepthM: 0.47, occupancy: 2 },
    materialRoles: ["oak-frame", "oak-panel", "oak-endgrain"],
    parts: [
      part("post/left"),
      part("post/right"),
      part("seat/left", "shaped-board", "oak-panel"),
      part("seat/right", "shaped-board", "oak-panel"),
      part("back/panel-left", "panel", "oak-panel"),
      part("back/panel-right", "panel", "oak-panel"),
    ],
    joints: [
      { id: "joint/seat-left", type: "mortise-tenon", members: ["post/left", "seat/left"], toleranceM: 0.002 },
      { id: "joint/seat-right", type: "mortise-tenon", members: ["post/right", "seat/right"], toleranceM: 0.002 },
    ],
    sockets: [
      {
        id: "occupancy/left",
        kind: "occupancy",
        position: [-0.46, 0.47, -0.04],
        facing: [0, 0, -1],
        supportedBy: "seat/left",
        clearanceRadiusM: 0.31,
      },
      {
        id: "occupancy/right",
        kind: "occupancy",
        position: [0.46, 0.47, -0.04],
        facing: [0, 0, -1],
        supportedBy: "seat/right",
        clearanceRadiusM: 0.31,
      },
      {
        id: "approach/left",
        kind: "approach",
        position: [-0.46, 0, -0.82],
        facing: [0, 0, 1],
        supportedBy: "seat/left",
        clearanceRadiusM: 0.35,
      },
    ],
    colliders: [
      {
        id: "collision/seat",
        center: [0, 0.42, 0],
        halfExtents: [0.86, 0.08, 0.235],
        covers: ["seat/left", "seat/right"],
      },
      { id: "collision/left", center: [-0.92, 0.73, 0.22], halfExtents: [0.08, 0.73, 0.1], covers: ["post/left"] },
      { id: "collision/right", center: [0.92, 0.73, 0.22], halfExtents: [0.08, 0.73, 0.1], covers: ["post/right"] },
    ],
    status: "draft",
  },
  visual,
);
if (!/^sha256:[0-9a-f]{64}$/.test(furnitureDesignContractHash(furniture)))
  throw new Error("furniture contract hash is invalid");
let rejected = false;
try {
  validateFurnitureDesignContract(
    {
      ...furniture,
      colliders: [
        {
          id: "collision/all",
          center: [0, 0.73, 0],
          halfExtents: [1.08, 0.73, 0.36],
          covers: furniture.parts.map((p) => p.id),
        },
      ],
    },
    visual,
  );
} catch {
  rejected = true;
}
if (!rejected) throw new Error("whole-AABB furniture collision was accepted");
console.log(
  "p_architecture_visual_design_contract OK: pinned cues become measurable two-seat geometry, joints, sockets, and compound collision",
);
