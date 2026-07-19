import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  furnitureDesignContractHash,
  validateFurnitureDesignContract,
} from "../../js/src/architecture/furniture-design-contract.ts";
import {
  validateVisualDesignContract,
  visualDesignContractHash,
} from "../../js/src/architecture/visual-design-contract.ts";
import { buildHearthSettleV3Contract, createHearthSettleV3Contract } from "./create-hearth-settle-v3-contract.mjs";

const visual = validateVisualDesignContract(
  JSON.parse(
    await readFile(
      new URL("../../art-direction/furniture/hearth-settle-v3-visual-design.json", import.meta.url),
      "utf8",
    ),
  ),
);
const contract = buildHearthSettleV3Contract(visual),
  parts = new Map(contract.parts.map((part) => [part.id, part])),
  DEG = Math.PI / 180;
function localHalf(part) {
  const geometry = part.geometry;
  if (geometry.kind === "shaped-board" || geometry.kind === "panel") return geometry.size.map((value) => value / 2);
  if (geometry.kind === "tapered-member")
    return [
      Math.max(...geometry.bottomSection, ...geometry.topSection) / 2,
      geometry.lengthM / 2,
      Math.max(...geometry.bottomSection, ...geometry.topSection) / 2,
    ];
  if (geometry.kind === "peg")
    return geometry.axis === "x"
      ? [geometry.lengthM / 2, geometry.diameterM / 2, geometry.diameterM / 2]
      : geometry.axis === "y"
        ? [geometry.diameterM / 2, geometry.lengthM / 2, geometry.diameterM / 2]
        : [geometry.diameterM / 2, geometry.diameterM / 2, geometry.lengthM / 2];
  throw new Error(`unsupported test geometry ${geometry.kind}`);
}
function bounds(part) {
  const [hx, hy, hz] = localHalf(part),
    r = part.rotationDeg[0] * DEG,
    c = Math.abs(Math.cos(r)),
    s = Math.abs(Math.sin(r)),
    half = [hx, c * hy + s * hz, s * hy + c * hz];
  return half.map((value, axis) => [part.center[axis] - value, part.center[axis] + value]);
}
function touches(left, right, tolerance = 0.012) {
  const a = bounds(left),
    b = bounds(right);
  return a.every(([minimum, maximum], axis) => b[axis][1] >= minimum - tolerance && b[axis][0] <= maximum + tolerance);
}

test("contract binds the exact v3 visual authority, bounded I1 r3 envelope, and settle semantics", async () => {
  assert.equal(contract.id, "furniture/hearth-settle/v3");
  assert.equal(contract.role, "hearth-settle");
  assert.equal(contract.visualDesign.id, visual.id);
  assert.equal(contract.visualDesign.hash, visualDesignContractHash(visual));
  assert.deepEqual(contract.dimensions, {
    widthM: 1.6,
    heightM: 1.3,
    depthM: 0.7,
    seatHeightM: 0.46,
    seatDepthM: 0.5,
    occupancy: 2,
  });
  assert.deepEqual(contract.settle, {
    seatPartId: "seat/plank",
    backPartIds: [
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
    ],
    legPartIds: ["leg/front-left", "leg/front-right", "leg/rear-left", "leg/rear-right"],
    armPartIds: ["arm/left", "arm/right"],
    armSupportPartIds: ["arm-support/left", "arm-support/right"],
    occupancySocketIds: ["occupancy/left", "occupancy/right"],
    approachSocketId: "approach/front",
    usableSeatWidthM: 1.35,
    backSupportHeightM: 0.7,
    ratedLoadKg: 200,
    canonicalForward: [0, 0, -1],
  });
  assert.deepEqual(contract.sockets, [
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
  ]);
  assert.equal(
    (await createHearthSettleV3Contract({ write: false })).contractHash,
    furnitureDesignContractHash(contract),
  );
  validateFurnitureDesignContract(contract, visual);
});

test("architectural inventory is one continuous seat on a complete joined four-leg frame", () => {
  assert.equal(contract.parts.filter(({ id }) => id === "seat/plank").length, 1);
  assert.deepEqual(parts.get("seat/plank").geometry.size, [1.44, 0.05, 0.5]);
  assert.equal(contract.parts.filter(({ id }) => id.startsWith("leg/")).length, 4);
  for (const prefix of ["apron/", "seat-rail/", "stretcher/"])
    assert.equal(
      contract.parts.filter(({ id }) => id.startsWith(prefix)).length,
      prefix === "apron/" ? 2 : prefix === "seat-rail/" ? 2 : 4,
    );
  assert.equal(contract.parts.filter(({ id }) => id.startsWith("back-panel/")).length, 4);
  assert.equal(contract.parts.filter(({ id }) => id.startsWith("back-stile/")).length, 3);
  assert.equal(contract.parts.filter(({ id }) => id.startsWith("back-post/")).length, 0);
  assert.equal(contract.parts.filter(({ id }) => id.startsWith("arm/")).length, 2);
  assert.equal(contract.parts.filter(({ id }) => id.startsWith("arm-support/")).length, 2);
  assert.equal(contract.parts.filter(({ kind }) => kind === "peg").length, 8);
  for (const side of ["left", "right"]) {
    const upright = parts.get(`leg/rear-${side}`);
    assert.equal(upright.geometry.lengthM, 1.3);
    assert.deepEqual(upright.center, [side === "left" ? -0.73 : 0.73, 0.65, 0.225]);
    assert.deepEqual(upright.rotationDeg, [0, 0, 0]);
    assert.ok(touches(upright, parts.get("back-rail/lower")));
    assert.ok(touches(upright, parts.get("back-rail/upper")));
    assert.ok(touches(upright, parts.get("crest/top")));
  }
  assert.deepEqual(
    contract.settle.legPartIds.map((id) => parts.get(id).center[0]),
    [-0.73, 0.73, -0.73, 0.73],
  );
  const cueIds = new Set(visual.cues.map(({ id }) => id));
  for (const id of [
    "locked-i1-r3-envelope-and-axis",
    "dimensioned-continuous-two-adult-seat",
    "four-post-complete-load-frame",
    "supported-arms",
    "separate-coherent-upper-back",
    "four-inset-fielded-panels-and-simple-crest",
    "visible-bounded-period-joinery",
    "restrained-three-role-oak",
    "exact-two-seat-function-and-compound-collision",
    "compact-shared-seat-read",
  ])
    assert.ok(cueIds.has(id), `missing visual authority cue ${id}`);
  assert.equal(
    contract.parts.some(({ id }) => /(canopy|chest|storage|cushion|upholster)/.test(id)),
    false,
  );
  assert.deepEqual(contract.materialRoles, ["oak-frame", "oak-panel", "oak-endgrain"]);
  assert.ok(contract.parts.every((part) => contract.materialRoles.includes(part.materialRole)));
});

test("all upper-back construction shares one four-degree section and four equal inset fields", () => {
  const upper = contract.parts.filter(({ id }) => id.startsWith("back-") || id === "crest/top");
  assert.equal(upper.length, 10);
  assert.ok(upper.every(({ rotationDeg }) => rotationDeg[0] === 4 && rotationDeg[1] === 0 && rotationDeg[2] === 0));
  const panels = contract.parts.filter(({ id }) => id.startsWith("back-panel/"));
  assert.ok(
    panels.every(
      ({ geometry }) =>
        geometry.kind === "panel" &&
        geometry.fieldDepthM === 0.012 &&
        geometry.size[0] === 0.285 &&
        geometry.size[1] === 0.48,
    ),
  );
  assert.deepEqual(
    panels.map(({ center }) => center[0]),
    [-0.5325, -0.1775, 0.1775, 0.5325],
  );
  for (const id of [
    "leg/front-left",
    "leg/front-right",
    "leg/rear-left",
    "leg/rear-right",
    "arm-support/left",
    "arm-support/right",
  ])
    assert.deepEqual(parts.get(id).rotationDeg, [0, 0, 0], `${id} must be plumb`);
});

test("every semantic member belongs to one contact-plausible explicit joint graph", () => {
  const graph = new Map(contract.parts.map(({ id }) => [id, new Set()]));
  for (const joint of contract.joints) {
    const [left, right] = joint.members;
    assert.ok(touches(parts.get(left), parts.get(right)), `${joint.id} does not plausibly contact`);
    assert.ok(joint.toleranceM <= 0.003);
    graph.get(left).add(right);
    graph.get(right).add(left);
  }
  const visited = new Set(),
    queue = ["seat/plank"];
  while (queue.length) {
    const id = queue.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    queue.push(...graph.get(id));
  }
  assert.equal(visited.size, contract.parts.length, "the settle must be one joined construction graph");
  for (const side of ["left", "right"]) {
    const arm = `arm/${side}`,
      support = `arm-support/${side}`,
      front = `leg/front-${side}`,
      rear = `leg/rear-${side}`;
    assert.ok(graph.get(arm).has(support));
    assert.ok(graph.get(support).has(front));
    assert.ok(graph.get(arm).has(rear));
  }
  for (const leg of contract.settle.legPartIds) {
    const seen = new Set(),
      pending = [contract.settle.seatPartId];
    while (pending.length) {
      const id = pending.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...graph.get(id));
    }
    assert.ok(seen.has(leg), `seat lacks load path to ${leg}`);
  }
});

test("authored geometry and exact compound collision remain inside the centered max envelope", () => {
  const envelope = [
      [-0.8, 0.8],
      [0, 1.3],
      [-0.35, 0.35],
    ],
    aggregate = [
      [Infinity, -Infinity],
      [Infinity, -Infinity],
      [Infinity, -Infinity],
    ];
  for (const part of contract.parts) {
    const box = bounds(part);
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(
        box[axis][0] >= envelope[axis][0] - 1e-9 && box[axis][1] <= envelope[axis][1] + 1e-9,
        `${part.id} escapes envelope axis ${axis}`,
      );
      aggregate[axis][0] = Math.min(aggregate[axis][0], box[axis][0]);
      aggregate[axis][1] = Math.max(aggregate[axis][1], box[axis][1]);
    }
  }
  assert.ok(
    Math.abs(aggregate[0][0] + 0.8) < 1e-9 && Math.abs(aggregate[0][1] - 0.8) < 1e-9,
    "crest must use the exact locked width",
  );
  assert.ok(
    Math.abs(aggregate[1][0]) < 1e-9 && Math.abs(aggregate[1][1] - 1.3) < 1e-9,
    "settle must be grounded and use the exact locked height",
  );
  assert.ok(
    Math.abs(aggregate[2][1] - aggregate[2][0] - 0.7) <= 0.002,
    "joined construction must materially occupy the declared depth",
  );
  assert.equal(contract.colliders.length, contract.parts.length);
  assert.deepEqual(
    new Set(contract.colliders.flatMap(({ covers }) => covers)),
    new Set(contract.parts.map(({ id }) => id)),
  );
  assert.equal(
    contract.colliders.some(
      ({ center, halfExtents }) =>
        center[0] === 0 &&
        center[1] === 0.65 &&
        center[2] === 0 &&
        halfExtents[0] === 0.8 &&
        halfExtents[1] === 0.65 &&
        halfExtents[2] === 0.35,
    ),
    false,
    "whole-settle AABB is forbidden",
  );
  for (const collider of contract.colliders)
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(collider.center[axis] - collider.halfExtents[axis] >= envelope[axis][0] - 1e-9);
      assert.ok(collider.center[axis] + collider.halfExtents[axis] <= envelope[axis][1] + 1e-9);
    }
});

test("seat, grounded support polygon, and independently supported arms prove two-adult function", () => {
  const seat = bounds(parts.get(contract.settle.seatPartId));
  assert.ok(Math.abs(seat[1][1] - 0.46) < 1e-9);
  assert.ok(seat[0][1] - seat[0][0] >= contract.settle.usableSeatWidthM);
  assert.ok(Math.abs(seat[2][1] - seat[2][0] - 0.5) < 1e-9);
  const legs = contract.settle.legPartIds.map((id) => bounds(parts.get(id)));
  assert.ok(legs.every((box) => Math.abs(box[1][0]) < 1e-9));
  const support = {
    minX: Math.min(...legs.map((box) => box[0][0])),
    maxX: Math.max(...legs.map((box) => box[0][1])),
    minZ: Math.min(...legs.map((box) => box[2][0])),
    maxZ: Math.max(...legs.map((box) => box[2][1])),
  };
  for (const socket of contract.sockets.filter(({ kind }) => kind === "occupancy"))
    assert.ok(
      socket.position[0] > support.minX + 0.05 &&
        socket.position[0] < support.maxX - 0.05 &&
        socket.position[2] > support.minZ + 0.05 &&
        socket.position[2] < support.maxZ - 0.05,
    );
  for (let index = 0; index < 2; index++) {
    const armPart = parts.get(contract.settle.armPartIds[index]),
      supportPart = parts.get(contract.settle.armSupportPartIds[index]),
      frontPart = parts.get(contract.settle.legPartIds[index]),
      rearPart = parts.get(contract.settle.legPartIds[index + 2]),
      arm = bounds(armPart),
      supportBounds = bounds(supportPart);
    assert.ok(arm[1][0] <= supportBounds[1][1] + 1e-9);
    assert.ok(arm[1][1] >= 0.68 && arm[1][1] <= 0.7);
    assert.equal(supportPart.center[2], frontPart.center[2], "front arm support must share the front-leg centerline");
    assert.ok(
      arm[2][0] <= frontPart.center[2] && arm[2][1] >= rearPart.center[2],
      "arm rail must span both grounded post centerlines",
    );
  }
});

test("the reusable Blender adapter supports every selected deterministic primitive", async () => {
  assert.deepEqual([...new Set(contract.parts.map(({ kind }) => kind))].sort(), [
    "panel",
    "peg",
    "shaped-board",
    "tapered-member",
  ]);
  const source = await readFile(new URL("../blender/furniture-contract-adapter.py", import.meta.url), "utf8");
  assert.match(
    source,
    /BUILDERS=\{"shaped-board":shaped,"tapered-member":tapered,"profile-extrusion":profile,"panel":panel,"peg":peg\}/,
  );
  assert.match(source, /save_as_mainfile/);
  assert.match(source, /export_format="GLB"/);
});
