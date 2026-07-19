import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  furnitureDesignContractHash,
  validateFurnitureDesignContract,
  validateVisualDesignContract,
  visualDesignContractHash,
} from "../../js/src/architecture/index.ts";

const DEFAULT_VISUAL = resolve(
  import.meta.dirname,
  "../../art-direction/furniture/hearth-settle-v3-visual-design.json",
);
const RAKE_DEG = 4,
  RAKE_RAD = (RAKE_DEG * Math.PI) / 180;
const lineZ = (y) => 0.24 + Math.tan(RAKE_RAD) * (y - 0.46);
const board = (size, edgeRadiusM = 0.006) => ({ kind: "shaped-board", size, edgeProfile: "eased", edgeRadiusM });
const post = (lengthM, section = 0.09) => ({
  kind: "tapered-member",
  lengthM,
  bottomSection: [section, section],
  topSection: [section, section],
  axis: "y",
  chamferM: 0.006,
});
const panel = (size) => ({ kind: "panel", size, fieldDepthM: 0.012, fieldMarginM: 0.035, edgeRadiusM: 0.005 });
const peg = (lengthM = 0.03) => ({ kind: "peg", diameterM: 0.018, lengthM, axis: "z" });

function partHalfExtents(part) {
  const geometry = part.geometry;
  let half;
  if (geometry.kind === "shaped-board" || geometry.kind === "panel") half = geometry.size.map((value) => value / 2);
  else if (geometry.kind === "tapered-member")
    half = [
      Math.max(...geometry.bottomSection, ...geometry.topSection) / 2,
      geometry.lengthM / 2,
      Math.max(...geometry.bottomSection, ...geometry.topSection) / 2,
    ];
  else if (geometry.kind === "peg") half = [geometry.diameterM / 2, geometry.diameterM / 2, geometry.lengthM / 2];
  else throw new Error(`unsupported settle collider geometry ${geometry.kind}`);
  const radians = (part.rotationDeg[0] * Math.PI) / 180,
    c = Math.abs(Math.cos(radians)),
    s = Math.abs(Math.sin(radians));
  return [half[0], c * half[1] + s * half[2], s * half[1] + c * half[2]];
}

/** Deterministically build the bounded, CPU-authored two-adult hearth settle contract. */
export function buildHearthSettleV3Contract(visualInput) {
  const visual = validateVisualDesignContract(visualInput);
  if (visual.id !== "furniture/hearth-settle/v3")
    throw new Error("hearth settle generator requires the exact v3 visual design");
  const parts = [],
    add = (id, materialRole, center, geometry, rotationDeg = [0, 0, 0]) =>
      parts.push({ id, kind: geometry.kind, materialRole, center, rotationDeg, geometry });

  for (const [x, side] of [
    [-0.73, "left"],
    [0.73, "right"],
  ]) {
    add(`leg/front-${side}`, "oak-frame", [x, 0.23, -0.305], post(0.46));
    // One grounded upright carries the seat frame, arms, and complete upper back.
    // Do not split this visible load path into a short leg plus a perched back post.
    add(`leg/rear-${side}`, "oak-frame", [x, 0.65, 0.225], post(1.3, 0.1));
  }
  add("seat/plank", "oak-panel", [0, 0.435, -0.05], board([1.44, 0.05, 0.5], 0.007));
  for (const [id, center, size] of [
    ["apron/front", [0, 0.345, -0.255], [1.37, 0.13, 0.07]],
    ["apron/rear", [0, 0.345, 0.2], [1.37, 0.13, 0.07]],
    ["seat-rail/left", [-0.73, 0.345, -0.0275], [0.07, 0.13, 0.455]],
    ["seat-rail/right", [0.73, 0.345, -0.0275], [0.07, 0.13, 0.455]],
    ["stretcher/front", [0, 0.18, -0.255], [1.37, 0.07, 0.06]],
    ["stretcher/rear", [0, 0.18, 0.2], [1.37, 0.07, 0.06]],
    ["stretcher/left", [-0.73, 0.18, -0.0275], [0.06, 0.07, 0.455]],
    ["stretcher/right", [0.73, 0.18, -0.0275], [0.06, 0.07, 0.455]],
  ])
    add(id, "oak-frame", center, board(size, 0.005));

  for (const [x, side] of [
    [-0.73, "left"],
    [0.73, "right"],
  ]) {
    // Arm load path follows the same front/rear post centerlines as the base.
    add(`arm-support/${side}`, "oak-frame", [x, 0.55, -0.305], post(0.22, 0.08));
    add(`arm/${side}`, "oak-frame", [x, 0.66, -0.055], board([0.11, 0.07, 0.56], 0.007));
  }
  add("back-rail/lower", "oak-frame", [0, 0.58, lineZ(0.58)], board([1.44, 0.09, 0.06], 0.006), [RAKE_DEG, 0, 0]);
  add("back-rail/upper", "oak-frame", [0, 1.15, lineZ(1.15)], board([1.44, 0.09, 0.06], 0.006), [RAKE_DEG, 0, 0]);
  for (const [x, label] of [
    [-0.355, "left"],
    [0, "center"],
    [0.355, "right"],
  ])
    add(`back-stile/${label}`, "oak-frame", [x, 0.865, lineZ(0.865)], post(0.48, 0.07), [RAKE_DEG, 0, 0]);
  for (const [x, label] of [
    [-0.5325, "outer-left"],
    [-0.1775, "inner-left"],
    [0.1775, "inner-right"],
    [0.5325, "outer-right"],
  ])
    add(`back-panel/${label}`, "oak-panel", [x, 0.865, lineZ(0.865)], panel([0.285, 0.48, 0.04]), [RAKE_DEG, 0, 0]);
  const crestHalfY = Math.cos(RAKE_RAD) * 0.05 + Math.sin(RAKE_RAD) * 0.04,
    crestCenterY = 1.3 - crestHalfY;
  add("crest/top", "oak-frame", [0, crestCenterY, lineZ(crestCenterY)], board([1.6, 0.1, 0.08], 0.009), [
    RAKE_DEG,
    0,
    0,
  ]);

  for (const [x, side] of [
    [-0.73, "left"],
    [0.73, "right"],
  ]) {
    for (const [y, level] of [
      [0.345, "apron"],
      [0.18, "stretcher"],
    ])
      add(`peg/front-${side}-${level}`, "oak-endgrain", [x, y, -0.335], peg());
    for (const [y, level] of [
      [0.58, "lower"],
      [1.15, "upper"],
    ])
      add(`peg/back-${side}-${level}`, "oak-endgrain", [x, y, lineZ(y) + 0.045], peg());
  }

  const joints = [],
    join = (id, type, left, right, toleranceM = 0.002) => joints.push({ id, type, members: [left, right], toleranceM });
  for (const side of ["left", "right"]) {
    const front = `leg/front-${side}`,
      rear = `leg/rear-${side}`;
    for (const [member, owner] of [
      ["apron/front", front],
      ["apron/rear", rear],
      [`seat-rail/${side}`, front],
      [`seat-rail/${side}`, rear],
      ["stretcher/front", front],
      ["stretcher/rear", rear],
      [`stretcher/${side}`, front],
      [`stretcher/${side}`, rear],
    ])
      join(
        `joint/${side}-${member.replace("/", "-")}-${owner === front ? "front" : "rear"}`,
        "mortise-tenon",
        owner,
        member,
      );
    join(`joint/${side}-back-lower`, "mortise-tenon", rear, "back-rail/lower");
    join(`joint/${side}-back-upper`, "mortise-tenon", rear, "back-rail/upper");
    join(`joint/${side}-crest`, "housing", rear, "crest/top");
    join(`joint/${side}-arm-base`, "housing", front, `arm-support/${side}`);
    join(`joint/${side}-arm-cap`, "mortise-tenon", `arm-support/${side}`, `arm/${side}`);
    join(`joint/${side}-arm-back`, "housing", rear, `arm/${side}`);
    join(`joint/peg-front-${side}-apron`, "drawbore-peg", front, `peg/front-${side}-apron`, 0.0015);
    join(`joint/peg-front-${side}-stretcher`, "drawbore-peg", front, `peg/front-${side}-stretcher`, 0.0015);
    join(`joint/peg-back-${side}-lower`, "drawbore-peg", "back-rail/lower", `peg/back-${side}-lower`, 0.0015);
    join(`joint/peg-back-${side}-upper`, "drawbore-peg", "back-rail/upper", `peg/back-${side}-upper`, 0.0015);
  }
  for (const rail of ["apron/front", "apron/rear", "seat-rail/left", "seat-rail/right"])
    join(`joint/seat-${rail.replace("/", "-")}`, "housing", "seat/plank", rail);
  for (const label of ["left", "center", "right"]) {
    join(`joint/back-stile-${label}-lower`, "mortise-tenon", `back-stile/${label}`, "back-rail/lower");
    join(`joint/back-stile-${label}-upper`, "mortise-tenon", `back-stile/${label}`, "back-rail/upper");
  }
  for (const label of ["outer-left", "inner-left", "inner-right", "outer-right"]) {
    join(`joint/back-panel-${label}-lower`, "housing", `back-panel/${label}`, "back-rail/lower");
    join(`joint/back-panel-${label}-upper`, "housing", `back-panel/${label}`, "back-rail/upper");
  }
  join("joint/crest-upper-rail", "housing", "crest/top", "back-rail/upper");

  const sockets = [
    {
      id: "occupancy/left",
      kind: "occupancy",
      position: [-0.32, 0.46, -0.05],
      facing: [0, 0, -1],
      supportedBy: "seat/plank",
      clearanceRadiusM: 0.3,
    },
    {
      id: "occupancy/right",
      kind: "occupancy",
      position: [0.32, 0.46, -0.05],
      facing: [0, 0, -1],
      supportedBy: "seat/plank",
      clearanceRadiusM: 0.3,
    },
    {
      id: "approach/front",
      kind: "approach",
      position: [0, 0, -0.85],
      facing: [0, 0, 1],
      supportedBy: "seat/plank",
      clearanceRadiusM: 0.35,
    },
  ];
  const colliders = parts.map((part) => {
    const halfExtents = partHalfExtents(part);
    return { id: `collision/${part.id}`, center: part.center, halfExtents, covers: [part.id] };
  });
  const backPartIds = [
    "back-rail/lower",
    "back-rail/upper",
    "back-stile/left",
    "back-stile/center",
    "back-stile/right",
    "back-panel/outer-left",
    "back-panel/inner-left",
    "back-panel/inner-right",
    "back-panel/outer-right",
    "crest/top",
  ];
  const contract = {
    schema: "limina.furniture-design-contract/v1",
    id: "furniture/hearth-settle/v3",
    role: "hearth-settle",
    visualDesign: { id: visual.id, hash: visualDesignContractHash(visual) },
    dimensions: { widthM: 1.6, heightM: 1.3, depthM: 0.7, seatHeightM: 0.46, seatDepthM: 0.5, occupancy: 2 },
    settle: {
      seatPartId: "seat/plank",
      backPartIds,
      legPartIds: ["leg/front-left", "leg/front-right", "leg/rear-left", "leg/rear-right"],
      armPartIds: ["arm/left", "arm/right"],
      armSupportPartIds: ["arm-support/left", "arm-support/right"],
      occupancySocketIds: ["occupancy/left", "occupancy/right"],
      approachSocketId: "approach/front",
      usableSeatWidthM: 1.35,
      backSupportHeightM: 0.7,
      ratedLoadKg: 200,
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

export async function createHearthSettleV3Contract({ visualPath = DEFAULT_VISUAL, outputPath, write = true } = {}) {
  const visual = JSON.parse(await readFile(resolve(visualPath), "utf8")),
    contract = buildHearthSettleV3Contract(visual);
  if (write) {
    if (!outputPath) throw new Error("hearth settle contract outputPath is required when writing");
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
          "usage: bun tools/architecture/create-hearth-settle-v3-contract.mjs --visual <json> --out <json>",
        );
      return args[index + 1];
    };
  const result = await createHearthSettleV3Contract({ visualPath: at("--visual"), outputPath: at("--out") });
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
