import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateFurnitureDesignContract } from "../../js/src/architecture/furniture-design-contract.ts";
import { validateVisualDesignContract } from "../../js/src/architecture/visual-design-contract.ts";
import {
  buildServiceStorageV1Contract,
  createServiceStorageV1Contract,
} from "./create-service-storage-v1-contract.mjs";

const visual = validateVisualDesignContract(
    JSON.parse(
      await readFile(
        new URL("../../art-direction/furniture/service-storage-v1-visual-design.json", import.meta.url),
        "utf8",
      ),
    ),
  ),
  contract = buildServiceStorageV1Contract(visual),
  parts = new Map(contract.parts.map((part) => [part.id, part]));
const extents = (part) =>
  part.kind === "shaped-board"
    ? part.geometry.size.map((v) => v / 2)
    : part.kind === "tapered-member"
      ? [
          Math.max(part.geometry.bottomSection[0], part.geometry.topSection[0]) / 2,
          part.geometry.lengthM / 2,
          Math.max(part.geometry.bottomSection[1], part.geometry.topSection[1]) / 2,
        ]
      : part.geometry.axis === "x"
        ? [part.geometry.lengthM / 2, part.geometry.diameterM / 2, part.geometry.diameterM / 2]
        : [part.geometry.diameterM / 2, part.geometry.diameterM / 2, part.geometry.lengthM / 2];
const bounds = (part) => extents(part).map((extent, axis) => [part.center[axis] - extent, part.center[axis] + extent]);
const touches = (a, b, tolerance = 0.011) =>
  bounds(a).every(([lo, hi], axis) => bounds(b)[axis][1] >= lo - tolerance && bounds(b)[axis][0] <= hi + tolerance);

test("binds the exact visual design, storage semantics, approach, and I1 envelope", async () => {
  assert.equal(contract.id, "furniture/service-storage/v1");
  assert.equal(contract.role, "service-storage");
  assert.deepEqual(contract.dimensions, {
    widthM: 0.4,
    heightM: 1.8,
    depthM: 1,
    seatHeightM: 0,
    seatDepthM: 0,
    occupancy: 0,
  });
  assert.deepEqual(contract.storage, {
    tierPartIds: ["tier/1", "tier/2", "tier/3", "tier/4"],
    verticalSupportPartIds: ["stile/front-left", "stile/front-right", "stile/rear-left", "stile/rear-right"],
    approachSocketId: "approach/front",
    canonicalFront: [-1, 0, 0],
    ratedLoadKgPerTier: 25,
  });
  assert.deepEqual(contract.sockets, [
    {
      id: "approach/front",
      kind: "approach",
      position: [-0.65, 0, 0],
      facing: [1, 0, 0],
      supportedBy: "tier/1",
      clearanceRadiusM: 0.35,
    },
  ]);
  assert.deepEqual(contract.materialRoles, ["oak-frame", "oak-panel", "oak-endgrain"]);
  assert.equal((await createServiceStorageV1Contract({ write: false })).contract.id, contract.id);
  validateFurnitureDesignContract(contract, visual);
});

test("four useful tiers, grounded 80 mm edge stiles, rear bracing, side rails, and one cornice are explicit", () => {
  const tiers = contract.storage.tierPartIds.map((id) => parts.get(id));
  assert.deepEqual(
    tiers.map((part) => part.center[1]),
    [0.08, 0.48, 0.88, 1.28],
  );
  assert.ok(
    tiers.every(
      (part) => part.geometry.size[0] >= 0.28 && part.geometry.size[2] >= 0.8 && part.geometry.size[1] <= 0.08,
    ),
  );
  for (let i = 1; i < tiers.length; i++) assert.ok(bounds(tiers[i])[1][0] - bounds(tiers[i - 1])[1][1] >= 0.3);
  for (const id of contract.storage.verticalSupportPartIds) {
    const part = parts.get(id);
    assert.deepEqual(part.geometry.bottomSection, [0.08, 0.08]);
    assert.equal(bounds(part)[1][0], 0);
  }
  assert.deepEqual(
    contract.storage.verticalSupportPartIds.map((id) => parts.get(id).center.filter((_, axis) => axis !== 1)),
    [
      [-0.16, -0.46],
      [-0.16, 0.46],
      [0.16, -0.46],
      [0.16, 0.46],
    ],
  );
  assert.equal(contract.parts.filter(({ id }) => id.startsWith("backboard/")).length, 4);
  assert.equal(contract.parts.filter(({ id }) => id.startsWith("side-rail/")).length, 6);
  assert.equal(contract.parts.filter(({ id }) => id === "cornice/top").length, 1);
  assert.equal(contract.parts.filter(({ kind }) => kind === "peg").length, 4);
});

test("joint graph is connected, every tier has grounded supports, and declared members contact", () => {
  const graph = new Map(contract.parts.map(({ id }) => [id, new Set()]));
  for (const joint of contract.joints) {
    const [a, b] = joint.members;
    graph.get(a).add(b);
    graph.get(b).add(a);
    assert.ok(touches(parts.get(a), parts.get(b)), `${joint.id} members do not contact`);
    assert.ok(joint.toleranceM <= 0.003);
  }
  for (const tier of contract.storage.tierPartIds) {
    const grounded = contract.joints.filter(
      ({ members }) =>
        members.includes(tier) && members.some((id) => contract.storage.verticalSupportPartIds.includes(id)),
    );
    assert.equal(grounded.length, 4);
  }
  const visited = new Set(),
    queue = [contract.parts[0].id];
  while (queue.length) {
    const id = queue.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    queue.push(...graph.get(id));
  }
  assert.equal(visited.size, contract.parts.length);
});

test("all geometry stays in the grounded envelope and leaves an unobstructed central -X service aperture", () => {
  const envelope = [
    [-0.2, 0.2],
    [0, 1.8],
    [-0.5, 0.5],
  ];
  for (const part of contract.parts)
    for (let axis = 0; axis < 3; axis++) {
      const [lo, hi] = bounds(part)[axis];
      assert.ok(lo >= envelope[axis][0] - 1e-9 && hi <= envelope[axis][1] + 1e-9, `${part.id} escapes axis ${axis}`);
    }
  const frontObstructions = contract.parts.filter(
    (part) =>
      !part.id.startsWith("tier/") &&
      !part.id.startsWith("stile/") &&
      !part.id.startsWith("side-rail/") &&
      bounds(part)[0][0] < -0.12,
  );
  assert.deepEqual(
    frontObstructions.map(({ id }) => id),
    ["cornice/top", "peg/front-left-lower", "peg/front-left-upper", "peg/front-right-lower", "peg/front-right-upper"],
  );
  for (const [lower, upper] of [
    [0.12, 0.44],
    [0.52, 0.84],
    [0.92, 1.24],
  ]) {
    const blockers = contract.parts.filter((part) => {
      const b = bounds(part);
      return (
        !part.id.startsWith("tier/") &&
        b[0][0] < -0.12 &&
        b[1][1] > lower &&
        b[1][0] < upper &&
        b[2][0] < 0.35 &&
        b[2][1] > -0.35 &&
        !part.id.startsWith("stile/")
      );
    });
    assert.deepEqual(
      blockers.map(({ id }) => id),
      [],
      `central front aperture ${lower}-${upper} is blocked`,
    );
  }
});

test("compound collision covers every semantic part without a whole-object AABB", () => {
  const covered = new Set(contract.colliders.flatMap(({ covers }) => covers));
  assert.deepEqual(
    contract.parts.map(({ id }) => id).filter((id) => !covered.has(id)),
    [],
  );
  assert.ok(contract.colliders.length >= 8);
  assert.equal(
    contract.colliders.some(
      ({ center, halfExtents }) =>
        center[0] === 0 &&
        center[1] === 0.9 &&
        center[2] === 0 &&
        halfExtents[0] === 0.2 &&
        halfExtents[1] === 0.9 &&
        halfExtents[2] === 0.5,
    ),
    false,
  );
  for (const collider of contract.colliders)
    for (let axis = 0; axis < 3; axis++)
      assert.ok(
        collider.center[axis] - collider.halfExtents[axis] >= [-0.2, 0, -0.5][axis] - 1e-9 &&
          collider.center[axis] + collider.halfExtents[axis] <= [0.2, 1.8, 0.5][axis] + 1e-9,
      );
});

test("every selected primitive is supported by the shared Blender adapter", async () => {
  assert.deepEqual([...new Set(contract.parts.map(({ kind }) => kind))].sort(), [
    "peg",
    "shaped-board",
    "tapered-member",
  ]);
  const source = await readFile(new URL("../blender/furniture-contract-adapter.py", import.meta.url), "utf8");
  assert.match(
    source,
    /BUILDERS=\{"shaped-board":shaped,"tapered-member":tapered,"profile-extrusion":profile,"panel":panel,"peg":peg\}/,
  );
});
