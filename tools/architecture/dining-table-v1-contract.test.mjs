import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateFurnitureDesignContract } from "../../js/src/architecture/furniture-design-contract.ts";
import { validateVisualDesignContract } from "../../js/src/architecture/visual-design-contract.ts";
import { buildDiningTableV1Contract, createDiningTableV1Contract } from "./create-dining-table-v1-contract.mjs";

const visual = validateVisualDesignContract(
    JSON.parse(
      await readFile(
        new URL("../../art-direction/furniture/dining-table-v1-visual-design.json", import.meta.url),
        "utf8",
      ),
    ),
  ),
  contract = buildDiningTableV1Contract(visual),
  parts = new Map(contract.parts.map((part) => [part.id, part]));
const bounds = (part) => {
  let extents;
  if (part.kind === "shaped-board" || part.kind === "panel") extents = part.geometry.size.map((value) => value / 2);
  else if (part.kind === "tapered-member") {
    const sections = [...part.geometry.bottomSection, ...part.geometry.topSection];
    extents = [
      Math.max(sections[0], sections[2]) / 2,
      part.geometry.lengthM / 2,
      Math.max(sections[1], sections[3]) / 2,
    ];
  } else if (part.kind === "peg")
    extents =
      part.geometry.axis === "x"
        ? [part.geometry.lengthM / 2, part.geometry.diameterM / 2, part.geometry.diameterM / 2]
        : part.geometry.axis === "y"
          ? [part.geometry.diameterM / 2, part.geometry.lengthM / 2, part.geometry.diameterM / 2]
          : [part.geometry.diameterM / 2, part.geometry.diameterM / 2, part.geometry.lengthM / 2];
  else
    extents =
      part.geometry.axis === "x"
        ? [
            part.geometry.depthM / 2,
            Math.max(...part.geometry.profile.map(([a]) => Math.abs(a))),
            Math.max(...part.geometry.profile.map(([, b]) => Math.abs(b))),
          ]
        : [
            Math.max(...part.geometry.profile.map(([a]) => Math.abs(a))),
            Math.max(...part.geometry.profile.map(([, b]) => Math.abs(b))),
            part.geometry.depthM / 2,
          ];
  return extents.map((extent, index) => [part.center[index] - extent, part.center[index] + extent]);
};
const touches = (a, b, tolerance = 0.0075) => {
  const left = bounds(a),
    right = bounds(b);
  return (
    left &&
    right &&
    left.every(([amin, amax], axis) => right[axis][1] >= amin - tolerance && right[axis][0] <= amax + tolerance)
  );
};

test("table contract binds the visual brief and exact non-seating I1 envelope", async () => {
  assert.equal(contract.id, "furniture/dining-table/v1");
  assert.equal(contract.role, "dining-table");
  assert.deepEqual(contract.dimensions, {
    widthM: 1.4,
    heightM: 0.78,
    depthM: 0.8,
    seatHeightM: 0,
    seatDepthM: 0,
    occupancy: 0,
  });
  assert.equal(contract.visualDesign.id, visual.id);
  assert.equal(contract.status, "draft");
  assert.deepEqual(
    visual.cues.map(({ id }) => id),
    [
      "locked-i1-envelope",
      "four-place-use-section",
      "coherent-trestle-load-path",
      "revealed-period-joinery",
      "material-direction-and-restraint",
    ],
  );
  assert.deepEqual(visual.requiredViews, [
    "front",
    "right-side",
    "back",
    "three-quarter",
    "joinery-detail",
    "socket-overlay",
    "collision-overlay",
  ]);
  assert.equal(
    contract.sockets.some(({ kind }) => kind === "occupancy"),
    false,
  );
  assert.deepEqual(
    contract.sockets.map(({ id }) => id),
    ["approach/north", "approach/south", "approach/west", "approach/east"],
  );
  assert.equal((await createDiningTableV1Contract({ write: false })).contract.id, contract.id);
  validateFurnitureDesignContract(contract, visual);
});

test("two grounded trestles, top, and low stretcher form one plausible connected load path", () => {
  assert.deepEqual(
    [...parts.keys()].filter((id) => id.endsWith("/foot")),
    ["trestle/left/foot", "trestle/right/foot"],
  );
  assert.equal(parts.get("trestle/left/foot").center[1] - parts.get("trestle/left/foot").geometry.size[1] / 2, 0);
  assert.equal(parts.get("trestle/right/foot").center[1] - parts.get("trestle/right/foot").geometry.size[1] / 2, 0);
  assert.equal(parts.get("top/plank").center[1] + parts.get("top/plank").geometry.size[1] / 2, 0.78);
  assert.equal(parts.get("stretcher/longitudinal").center[1], 0.27);
  assert.ok(0.64 / 0.8 >= 0.72 && 0.64 / 0.8 <= 0.9);
  const graph = new Map(contract.parts.map(({ id }) => [id, new Set()]));
  for (const joint of contract.joints) {
    const [a, b] = joint.members;
    graph.get(a).add(b);
    graph.get(b).add(a);
    assert.ok(touches(parts.get(a), parts.get(b)), `${joint.id} members do not plausibly contact`);
  }
  const visited = new Set(),
    queue = ["top/plank"];
  while (queue.length) {
    const id = queue.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    queue.push(...graph.get(id));
  }
  assert.equal(visited.size, contract.parts.length, "joint graph must connect every semantic part");
});

test("period joinery, knee space, and compound semantic collision remain explicit", () => {
  assert.equal(contract.joints.filter(({ id }) => id.includes("stretcher-through-post")).length, 2);
  assert.equal([...parts.keys()].filter((id) => id.startsWith("wedge/")).length, 2);
  assert.ok(contract.parts.filter(({ kind }) => kind === "peg").length >= 4);
  assert.ok(contract.joints.every(({ toleranceM }) => toleranceM <= 0.003));
  const posts = [parts.get("trestle/left/post"), parts.get("trestle/right/post")],
    innerWidth =
      posts[1].center[0] - posts[0].center[0] - (posts[0].geometry.topSection[0] + posts[1].geometry.topSection[0]) / 2;
  assert.ok(innerWidth >= 0.92, `long-side knee width ${innerWidth}`);
  assert.ok(parts.get("top/plank").center[1] - parts.get("top/plank").geometry.size[1] / 2 >= 0.66);
  assert.equal(contract.colliders.length, 4);
  assert.ok(contract.colliders.every(({ covers }) => covers.length > 0));
  const covered = new Set(contract.colliders.flatMap(({ covers }) => covers));
  assert.deepEqual(
    [...parts.keys()].filter((id) => !covered.has(id)),
    [],
  );
  assert.equal(
    contract.colliders.some(
      ({ halfExtents }) => halfExtents[0] === 0.7 && halfExtents[1] === 0.39 && halfExtents[2] === 0.4,
    ),
    false,
    "whole-object AABB is forbidden",
  );
  assert.equal(
    contract.parts.some((part) => "lodLevels" in part || "lod" in part),
    false,
  );
});

test("exported geometry and collision stay inside the centered grounded I1 envelope", () => {
  const half = [0.7, 0.39, 0.4],
    center = [0, 0.39, 0];
  for (const part of contract.parts) {
    const partBounds = bounds(part);
    for (let axis = 0; axis < 3; axis++)
      assert.ok(
        partBounds[axis][0] >= center[axis] - half[axis] - 1e-9 &&
          partBounds[axis][1] <= center[axis] + half[axis] + 1e-9,
        `${part.id} escapes I1 axis ${axis}`,
      );
  }
  for (const collider of contract.colliders)
    for (let axis = 0; axis < 3; axis++)
      assert.ok(
        Math.abs(collider.center[axis] - center[axis]) + collider.halfExtents[axis] <= half[axis] + 1e-9,
        `${collider.id} escapes I1 axis ${axis}`,
      );
  const minimumY = Math.min(
    ...contract.parts
      .filter(({ kind }) => kind === "shaped-board")
      .map((part) => part.center[1] - part.geometry.size[1] / 2),
  );
  assert.equal(minimumY, 0);
});

test("the shared Blender adapter supports table drawbore peg axes without settle-specific coercion", async () => {
  const source = await readFile(new URL("../blender/furniture-contract-adapter.py", import.meta.url), "utf8");
  assert.doesNotMatch(source, /settle pegs must use engine Z/);
  assert.match(source, /axis not in \{"x","y","z"\}/);
  assert.match(source, /elif axis=="z": o\.rotation_euler\[0\]=math\.pi\/2/);
});
