import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  validateVisualDesignContract,
  visualDesignContractHash,
  validateFurnitureDesignContract,
  furnitureDesignContractHash,
} from "../../js/src/architecture/index.ts";
const args = process.argv.slice(2),
  pedestalArms = args.includes("--pedestal-arms"),
  at = (f) => {
    const i = args.indexOf(f);
    if (i < 0 || !args[i + 1])
      throw new Error(
        "usage: bun tools/architecture/create-hearth-settle-v2-contract.mjs --visual <json> --out <json> [--pedestal-arms]",
      );
    return resolve(args[i + 1]);
  },
  visual = validateVisualDesignContract(JSON.parse(await readFile(at("--visual"), "utf8"))),
  out = at("--out"),
  parts = [];
const add = (id, materialRole, center, rotationDeg, geometry) =>
    parts.push({ id, kind: geometry.kind, materialRole, center, rotationDeg, geometry }),
  board = (size, r = 0.008) => ({ kind: "shaped-board", size, edgeProfile: "eased", edgeRadiusM: r }),
  post = (length, bottom = [0.13, 0.13], top = [0.11, 0.11]) => ({
    kind: "tapered-member",
    lengthM: length,
    bottomSection: bottom,
    topSection: top,
    axis: "y",
    chamferM: 0.008,
  }),
  panel = (size) => ({ kind: "panel", size, fieldDepthM: 0.012, fieldMarginM: 0.045, edgeRadiusM: 0.005 }),
  peg = (axis) => ({ kind: "peg", diameterM: 0.024, lengthM: 0.036, axis });
const rake = 4,
  lineZ = (y) => 0.185 + Math.tan((rake * Math.PI) / 180) * (y - 0.43);
for (const [x, label] of [
  [-0.97, "left"],
  [0.97, "right"],
]) {
  add(`leg/front-${label}`, "oak-frame", [x, 0.215, -0.255], [0, 0, 0], post(0.43, [0.125, 0.125], [0.11, 0.11]));
  add(`leg/rear-${label}`, "oak-frame", [x, 0.215, 0.175], [0, 0, 0], post(0.43, [0.13, 0.13], [0.115, 0.115]));
  add(
    `back-post/${label}`,
    "oak-frame",
    [x, 0.8375, lineZ(0.8375)],
    [rake, 0, 0],
    post(0.815, [0.125, 0.125], [0.105, 0.105]),
  );
  add(`arm/${label}`, "oak-frame", [x, 0.67, 0], [0, 0, 0], {
    kind: "profile-extrusion",
    profile: [
      [-0.355, -0.045],
      [0.275, -0.045],
      [0.355, 0.015],
      [0.27, 0.065],
      [-0.355, 0.065],
    ],
    depthM: 0.12,
    axis: "z",
    bevelM: 0.008,
  });
  if (pedestalArms)
    add(`arm-support/${label}`, "oak-frame", [x, 0.555, -0.255], [0, 0, 0], post(0.27, [0.105, 0.105], [0.09, 0.09]));
  else
    add(`arm-support/${label}`, "oak-frame", [x, 0.57, -0.16], [0, 0, 0], {
      kind: "profile-extrusion",
      profile: [
        [-0.11, -0.12],
        [0.09, -0.12],
        [0.09, 0.12],
        [0.035, 0.12],
        [-0.11, -0.03],
      ],
      depthM: 0.075,
      axis: "z",
      bevelM: 0.006,
    });
}
add("seat/plank", "oak-panel", [0, 0.4325, -0.05], [0, 0, 0], board([1.82, 0.055, 0.5], 0.007));
for (const [id, center, size] of [
  ["apron/front", [0, 0.36, -0.255], [1.84, 0.14, 0.08]],
  ["apron/rear", [0, 0.36, 0.155], [1.84, 0.14, 0.08]],
  ["stretcher/front", [0, 0.18, -0.23], [1.84, 0.075, 0.07]],
  ["stretcher/rear", [0, 0.18, 0.15], [1.84, 0.075, 0.07]],
])
  add(id, "oak-frame", center, [0, 0, 0], board(size, 0.006));
for (const [id, y, size] of [
  ["rail/back-low", 0.735, [1.84, 0.105, 0.075]],
  ["rail/back-high", 1.145, [1.84, 0.105, 0.075]],
])
  add(id, "oak-frame", [0, y, lineZ(y)], [rake, 0, 0], board(size, 0.006));
for (const [x, label] of [
  [-0.91, "left"],
  [0, "center"],
  [0.91, "right"],
])
  add(`stile/${label}`, "oak-frame", [x, 0.94, lineZ(0.94)], [rake, 0, 0], post(0.31, [0.07, 0.065], [0.065, 0.06]));
for (const [x, label] of [
  [-0.585, "outer-left"],
  [-0.195, "inner-left"],
  [0.195, "inner-right"],
  [0.585, "outer-right"],
])
  add(`panel/${label}`, "oak-panel", [x, 0.94, lineZ(0.94)], [rake, 0, 0], panel([0.32, 0.3, 0.04]));
add("crest", "oak-frame", [0, 1.235, lineZ(1.235)], [rake, 0, 0], {
  kind: "profile-extrusion",
  profile: [
    [-1.08, -0.045],
    [-0.82, -0.025],
    [-0.55, 0.018],
    [-0.28, -0.005],
    [0, 0.035],
    [0.28, -0.005],
    [0.55, 0.018],
    [0.82, -0.025],
    [1.08, -0.045],
    [1.08, 0.045],
    [-1.08, 0.045],
  ],
  depthM: 0.1,
  axis: "x",
  bevelM: 0.008,
});
for (const [x, side] of [
  [-0.97, "left"],
  [0.97, "right"],
])
  for (const [y, level] of [
    [0.36, "apron"],
    [0.735, "back-low"],
    [1.145, "back-high"],
    [0.18, "stretcher"],
  ])
    add(
      `peg/${side}-${level}`,
      "oak-endgrain",
      [x, y, level === "apron" ? -0.306 : lineZ(y) + 0.065],
      [0, 0, 0],
      peg("z"),
    );
const joints = [];
for (const side of ["left", "right"]) {
  for (const [owner, member] of [
    [`leg/front-${side}`, "apron/front"],
    [`leg/rear-${side}`, "apron/rear"],
    [`leg/front-${side}`, "stretcher/front"],
    [`leg/rear-${side}`, "stretcher/rear"],
    [`back-post/${side}`, "rail/back-low"],
    [`back-post/${side}`, "rail/back-high"],
  ])
    joints.push({
      id: `joint/${side}-${member.replace("/", "-")}`,
      type: "mortise-tenon",
      members: [owner, member],
      toleranceM: 0.002,
    });
  joints.push(
    {
      id: `joint/${side}-rear-leg-back-post`,
      type: "housing",
      members: [`leg/rear-${side}`, `back-post/${side}`],
      toleranceM: 0.002,
    },
    {
      id: `joint/${side}-arm-base`,
      type: "housing",
      members: [`leg/front-${side}`, `arm-support/${side}`],
      toleranceM: 0.002,
    },
    {
      id: `joint/${side}-arm-cap`,
      type: "mortise-tenon",
      members: [`arm-support/${side}`, `arm/${side}`],
      toleranceM: 0.002,
    },
    { id: `joint/${side}-arm-back`, type: "housing", members: [`back-post/${side}`, `arm/${side}`], toleranceM: 0.002 },
  );
}
for (const side of ["left", "right"])
  for (const level of ["apron", "back-low", "back-high", "stretcher"])
    joints.push({
      id: `joint/peg-${side}-${level}`,
      type: "drawbore-peg",
      members: [level === "apron" ? `leg/front-${side}` : `back-post/${side}`, `peg/${side}-${level}`],
      toleranceM: 0.0015,
    });
const sockets = [
  {
    id: "occupancy/left",
    kind: "occupancy",
    position: [-0.455, 0.46, -0.05],
    facing: [0, 0, -1],
    supportedBy: "seat/plank",
    clearanceRadiusM: 0.34,
  },
  {
    id: "occupancy/right",
    kind: "occupancy",
    position: [0.455, 0.46, -0.05],
    facing: [0, 0, -1],
    supportedBy: "seat/plank",
    clearanceRadiusM: 0.34,
  },
  {
    id: "approach/left",
    kind: "approach",
    position: [-0.455, 0, -0.86],
    facing: [0, 0, 1],
    supportedBy: "seat/plank",
    clearanceRadiusM: 0.36,
  },
  {
    id: "approach/right",
    kind: "approach",
    position: [0.455, 0, -0.86],
    facing: [0, 0, 1],
    supportedBy: "seat/plank",
    clearanceRadiusM: 0.36,
  },
  {
    id: "inspect/front",
    kind: "inspect",
    position: [0, 0.82, -1.1],
    facing: [0, 0, 1],
    supportedBy: "apron/front",
    clearanceRadiusM: 0.3,
  },
];
const colliders = [
  {
    id: "collision/seat",
    center: [0, 0.41, -0.05],
    halfExtents: [0.91, 0.075, 0.25],
    covers: ["seat/plank", "apron/front", "apron/rear"],
  },
  {
    id: "collision/front-left",
    center: [-0.97, 0.215, -0.255],
    halfExtents: [0.065, 0.215, 0.065],
    covers: ["leg/front-left", "arm-support/left"],
  },
  {
    id: "collision/front-right",
    center: [0.97, 0.215, -0.255],
    halfExtents: [0.065, 0.215, 0.065],
    covers: ["leg/front-right", "arm-support/right"],
  },
  {
    id: "collision/rear-left",
    center: [-0.97, 0.64, 0.205],
    halfExtents: [0.07, 0.64, 0.09],
    covers: ["leg/rear-left", "back-post/left", "arm/left"],
  },
  {
    id: "collision/rear-right",
    center: [0.97, 0.64, 0.205],
    halfExtents: [0.07, 0.64, 0.09],
    covers: ["leg/rear-right", "back-post/right", "arm/right"],
  },
  {
    id: "collision/back-left",
    center: [-0.49, 0.94, lineZ(0.94)],
    halfExtents: [0.48, 0.31, 0.06],
    covers: ["panel/outer-left", "panel/inner-left", "rail/back-low", "rail/back-high"],
  },
  {
    id: "collision/back-right",
    center: [0.49, 0.94, lineZ(0.94)],
    halfExtents: [0.48, 0.31, 0.06],
    covers: ["panel/inner-right", "panel/outer-right", "crest"],
  },
];
const contract = {
  schema: "limina.furniture-design-contract/v1",
  id: `furniture/hearth-settle/${pedestalArms ? "v2-r2" : "v2"}`,
  role: "hearth-settle",
  visualDesign: { id: visual.id, hash: visualDesignContractHash(visual) },
  dimensions: { widthM: 2.16, heightM: 1.28, depthM: 0.71, seatHeightM: 0.46, seatDepthM: 0.5, occupancy: 2 },
  parts,
  joints,
  sockets,
  colliders,
  materialRoles: ["oak-frame", "oak-panel", "oak-endgrain"],
  status: "draft",
};
validateFurnitureDesignContract(contract, visual);
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(contract, null, 2) + "\n", { mode: 0o600 });
console.log(
  JSON.stringify(
    {
      id: contract.id,
      visualHash: contract.visualDesign.hash,
      contractHash: furnitureDesignContractHash(contract),
      parts: parts.length,
      joints: joints.length,
      sockets: sockets.length,
      colliders: colliders.length,
    },
    null,
    2,
  ),
);
