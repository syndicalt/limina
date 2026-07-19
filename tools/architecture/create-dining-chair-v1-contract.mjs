import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  furnitureDesignContractHash,
  validateFurnitureDesignContract,
  validateVisualDesignContract,
  visualDesignContractHash,
} from "../../js/src/architecture/index.ts";

const DEFAULT_VISUAL = resolve(import.meta.dirname, "../../art-direction/furniture/dining-chair-v1-visual-design.json");
const RAKE_DEG = 4.5,
  RAKE_RAD = (RAKE_DEG * Math.PI) / 180,
  POST_SECTION = 0.07;
const REAR_POST_LENGTH = (0.89 - POST_SECTION * Math.sin(RAKE_RAD)) / Math.cos(RAKE_RAD);
const REAR_POST_CENTER_Y = 0.89 / 2,
  REAR_POST_CENTER_Z = 0.235 - ((REAR_POST_LENGTH / 2) * Math.sin(RAKE_RAD) + (POST_SECTION / 2) * Math.cos(RAKE_RAD));
const rearAxisZ = (y) => REAR_POST_CENTER_Z + (y - REAR_POST_CENTER_Y) * Math.tan(RAKE_RAD);
const board = (size, edgeRadiusM = 0.005) => ({ kind: "shaped-board", size, edgeProfile: "eased", edgeRadiusM });
const post = (lengthM, section = 0.07) => ({
  kind: "tapered-member",
  lengthM,
  bottomSection: [section, section],
  topSection: [section, section],
  axis: "y",
  chamferM: 0.005,
});
const peg = () => ({ kind: "peg", diameterM: 0.018, lengthM: 0.03, axis: "z" });

/** Deterministically build a CPU-only chair contract in memory. */
export function buildDiningChairV1Contract(visualInput) {
  const visual = validateVisualDesignContract(visualInput);
  if (visual.id !== "furniture/dining-chair/v1")
    throw new Error("dining chair generator requires the exact v1 visual design");
  const parts = [],
    add = (id, materialRole, center, geometry, rotationDeg = [0, 0, 0]) =>
      parts.push({ id, kind: geometry.kind, materialRole, center, rotationDeg, geometry });
  const frontZ = -0.2,
    rearSeatZ = rearAxisZ(0.36),
    sideTenonDepth = 0.015,
    sideRearEndZ = rearSeatZ - sideTenonDepth,
    sideCenterZ = (frontZ + sideRearEndZ) / 2,
    sideSpan = sideRearEndZ - frontZ;
  const seatFrontZ = frontZ - POST_SECTION / 2,
    seatRearZ = rearAxisZ(0.43) + POST_SECTION / (2 * Math.cos(RAKE_RAD)),
    seatCenterZ = (seatFrontZ + seatRearZ) / 2,
    seatDepth = seatRearZ - seatFrontZ;
  for (const [x, side] of [
    [-0.205, "left"],
    [0.205, "right"],
  ]) {
    add(`leg/front-${side}`, "oak-frame", [x, 0.205, frontZ], post(0.41));
    add(`leg/rear-${side}`, "oak-frame", [x, REAR_POST_CENTER_Y, REAR_POST_CENTER_Z], post(REAR_POST_LENGTH), [
      RAKE_DEG,
      0,
      0,
    ]);
  }
  add("seat/solid", "oak-panel", [0, 0.43, seatCenterZ], board([0.48, 0.04, seatDepth], 0.006));
  add("seat-rail/front", "oak-frame", [0, 0.36, frontZ], board([0.41, 0.1, 0.065]));
  add("seat-rail/rear", "oak-frame", [0, 0.36, rearSeatZ], board([0.41, 0.1, 0.065]));
  add("seat-rail/left", "oak-frame", [-0.205, 0.36, sideCenterZ], board([0.065, 0.1, sideSpan]));
  add("seat-rail/right", "oak-frame", [0.205, 0.36, sideCenterZ], board([0.065, 0.1, sideSpan]));
  const rearStretcherZ = rearAxisZ(0.16),
    stretcherCenterZ = (frontZ + rearStretcherZ) / 2,
    stretcherSpan = rearStretcherZ - frontZ;
  add("stretcher/front", "oak-frame", [0, 0.16, frontZ], board([0.41, 0.065, 0.06], 0.004));
  add("stretcher/rear", "oak-frame", [0, 0.16, rearStretcherZ], board([0.41, 0.065, 0.06], 0.004));
  add("stretcher/left", "oak-frame", [-0.205, 0.16, stretcherCenterZ], board([0.06, 0.065, stretcherSpan], 0.004));
  add("stretcher/right", "oak-frame", [0.205, 0.16, stretcherCenterZ], board([0.06, 0.065, stretcherSpan], 0.004));
  for (const [id, y, height] of [
    ["back-rail/lower", 0.56, 0.13],
    ["back-rail/upper", 0.825, 0.12],
  ])
    add(id, "oak-frame", [0, y, rearAxisZ(y)], board([0.41, height, 0.055], 0.005), [RAKE_DEG, 0, 0]);
  for (const [x, side] of [
    [-0.205, "left"],
    [0.205, "right"],
  ]) {
    add(`peg/front-${side}`, "oak-endgrain", [x, 0.365, -0.22], peg());
    add(`peg/rear-${side}`, "oak-endgrain", [x, 0.365, rearAxisZ(0.365) + 0.04], peg());
  }

  const joints = [],
    join = (id, type, left, right, toleranceM = 0.002) => joints.push({ id, type, members: [left, right], toleranceM });
  for (const side of ["left", "right"]) {
    const front = `leg/front-${side}`,
      rear = `leg/rear-${side}`;
    join(`joint/seat-front-${side}`, "mortise-tenon", front, "seat-rail/front");
    join(`joint/seat-rear-${side}`, "mortise-tenon", rear, "seat-rail/rear");
    join(`joint/seat-side-front-${side}`, "mortise-tenon", front, `seat-rail/${side}`);
    join(`joint/seat-side-rear-${side}`, "mortise-tenon", rear, `seat-rail/${side}`);
    join(`joint/stretcher-front-${side}`, "mortise-tenon", front, "stretcher/front");
    join(`joint/stretcher-rear-${side}`, "mortise-tenon", rear, "stretcher/rear");
    join(`joint/stretcher-side-front-${side}`, "mortise-tenon", front, `stretcher/${side}`);
    join(`joint/stretcher-side-rear-${side}`, "mortise-tenon", rear, `stretcher/${side}`);
    join(`joint/back-lower-${side}`, "mortise-tenon", rear, "back-rail/lower");
    join(`joint/back-upper-${side}`, "mortise-tenon", rear, "back-rail/upper");
    join(`joint/peg-front-${side}`, "drawbore-peg", front, `peg/front-${side}`, 0.0015);
    join(`joint/peg-rear-${side}`, "drawbore-peg", rear, `peg/rear-${side}`, 0.0015);
  }
  for (const rail of ["front", "rear", "left", "right"])
    join(`joint/seat-housing-${rail}`, "housing", "seat/solid", `seat-rail/${rail}`);

  const sockets = [
    {
      id: "occupancy/main",
      kind: "occupancy",
      position: [0, 0.45, 0],
      facing: [0, 0, -1],
      supportedBy: "seat/solid",
      clearanceRadiusM: 0.3,
    },
  ];
  const colliders = [
    {
      id: "collision/seat-frame",
      center: [0, 0.38, seatCenterZ],
      halfExtents: [0.24, 0.07, seatDepth / 2],
      covers: ["seat/solid", "seat-rail/front", "seat-rail/rear", "seat-rail/left", "seat-rail/right"],
    },
    {
      id: "collision/front-left",
      center: [-0.205, 0.205, frontZ],
      halfExtents: [0.035, 0.205, 0.035],
      covers: ["leg/front-left"],
    },
    {
      id: "collision/front-right",
      center: [0.205, 0.205, frontZ],
      halfExtents: [0.035, 0.205, 0.035],
      covers: ["leg/front-right"],
    },
    {
      id: "collision/rear-left",
      center: [-0.205, 0.445, REAR_POST_CENTER_Z],
      halfExtents: [0.035, 0.445, 0.235 - REAR_POST_CENTER_Z],
      covers: ["leg/rear-left"],
    },
    {
      id: "collision/rear-right",
      center: [0.205, 0.445, REAR_POST_CENTER_Z],
      halfExtents: [0.035, 0.445, 0.235 - REAR_POST_CENTER_Z],
      covers: ["leg/rear-right"],
    },
    {
      id: "collision/stretcher-ring",
      center: [0, 0.16, stretcherCenterZ],
      halfExtents: [0.205, 0.033, stretcherSpan / 2],
      covers: ["stretcher/front", "stretcher/rear", "stretcher/left", "stretcher/right"],
    },
    {
      id: "collision/back-rails",
      center: [0, 0.6925, rearAxisZ(0.6925)],
      halfExtents: [0.205, 0.1975, 0.045],
      covers: ["back-rail/lower", "back-rail/upper"],
    },
  ];
  const contract = {
    schema: "limina.furniture-design-contract/v1",
    id: "furniture/dining-chair/v1",
    role: "dining-chair",
    visualDesign: { id: visual.id, hash: visualDesignContractHash(visual) },
    dimensions: { widthM: 0.48, heightM: 0.89, depthM: 0.47, seatHeightM: 0.45, seatDepthM: 0.42, occupancy: 1 },
    chair: {
      seatPartId: "seat/solid",
      backPartIds: ["back-rail/lower", "back-rail/upper"],
      legPartIds: ["leg/front-left", "leg/front-right", "leg/rear-left", "leg/rear-right"],
      usableSeatWidthM: 0.42,
      backSupportHeightM: 0.38,
      ratedLoadKg: 150,
      canonicalForward: [0, 0, -1],
    },
    parts,
    joints,
    sockets,
    colliders,
    materialRoles: ["oak-frame", "oak-panel", "oak-endgrain"],
    status: "draft",
  };
  return validateFurnitureDesignContract(contract, visual);
}

export async function createDiningChairV1Contract({ visualPath = DEFAULT_VISUAL, outputPath, write = true } = {}) {
  const visual = JSON.parse(await readFile(resolve(visualPath), "utf8")),
    contract = buildDiningChairV1Contract(visual);
  if (write) {
    if (!outputPath) throw new Error("dining chair contract outputPath is required when writing");
    const out = resolve(outputPath);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }
  return Object.freeze({ contract, contractHash: furnitureDesignContractHash(contract) });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2),
    at = (flag) => {
      const index = args.indexOf(flag);
      if (index < 0 || !args[index + 1])
        throw new Error(
          "usage: bun tools/architecture/create-dining-chair-v1-contract.mjs --visual <json> --out <json>",
        );
      return args[index + 1];
    };
  const result = await createDiningChairV1Contract({ visualPath: at("--visual"), outputPath: at("--out") });
  console.log(
    JSON.stringify(
      {
        id: result.contract.id,
        contractHash: result.contractHash,
        visualHash: result.contract.visualDesign.hash,
        parts: result.contract.parts.length,
        joints: result.contract.joints.length,
        sockets: result.contract.sockets.length,
        colliders: result.contract.colliders.length,
      },
      null,
      2,
    ),
  );
}
