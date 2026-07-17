import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILDING_INTERIOR_PLAN_V2_SCHEMA,
  buildingInteriorPlanV2CanonicalText,
  buildingInteriorPlanV2Hash,
  validateBuildingInteriorPlanV2,
} from "../../js/src/assets/building-interior-plan-v2.mjs";

const H = (digit) => `sha256:${digit.repeat(64)}`;
const dependency = (artifactId, kind, revision, digit, scopes) => ({
  artifactId, kind, revision, status: "approved",
  contractHash: H(digit), contentHash: H(String((Number(digit) + 1) % 10)),
  approvalDecisionId: `decision/${artifactId}/approve-r${revision}`,
  approvalDecisionHash: H(String((Number(digit) + 2) % 10)),
  facets: scopes.map((scope, index) => ({ scope, hash: H(String((Number(digit) + index + 3) % 10)) })),
});

const validPlan = () => ({
  schema: BUILDING_INTERIOR_PLAN_V2_SCHEMA,
  planId: "interior/functional-hall-house-v4/r1", revision: 1, supersedes: null, units: "meter",
  dependencies: {
    shell: dependency("shell/functional-hall-house-v4/r4", "shell", 4, "1", ["interior-envelope", "support-sockets", "portal-articulation", "hearth-flue-sockets", "collision-traversal"]),
    materials: dependency("materials/functional-hall-house-v4/r2", "material-palette", 2, "4", ["role-contract", "surface-parameters", "runtime-textures"]),
  },
  policy: { corridorHalfWidthMinM: 0.5, clearHeightMinM: 2, approachRadiusMinM: 0.35, occupancyRadiusMinM: 0.3, doorOpeningMinRadians: 1.2, zoneHeadroomMinM: 2, occupantAreaMinM2: 0.75, hearthClearanceMinM: 0.8 },
  rooms: [{ id: "room/main", bounds: { center: [0, 1.5, -0.5], halfExtents: [5, 1.5, 4.5] }, finishedFloorY: 0, ceilingY: 3, floorRegions: [
    { id: "floor-region/main-hall", center: [0, 0.4], halfExtents: [5, 3.6] },
    { id: "floor-region/passage", center: [2.6, -3.3], halfExtents: [0.7, 0.15] },
    { id: "floor-region/service-bay", center: [2.6, -4.2], halfExtents: [1.5, 0.8] },
  ] }],
  zones: [
    { id: "zone/entry", kind: "entry", roomId: "room/main", bounds: { center: [-1, 1.5, -2.3], halfExtents: [1.5, 1.5, 0.9] }, minimumOccupants: 1 },
    { id: "zone/hearth", kind: "hearth-seating", roomId: "room/main", bounds: { center: [2, 1.5, 0], halfExtents: [1.5, 1.5, 1.5] }, minimumOccupants: 2 },
  ],
  surfaceSockets: [
    { id: "socket/floor-settle", kind: "floor", roomId: "room/main", surfaceId: "surface/main-floor", position: [2, 0, 0], normal: [0, 1, 0], capacityKg: 400 },
    { id: "socket/wall-hearth", kind: "wall", roomId: "room/main", surfaceId: "surface/north-wall", position: [2, 1.2, 3.9], normal: [0, 0, -1], capacityKg: 80 },
    { id: "socket/ceiling-light", kind: "ceiling", roomId: "room/main", surfaceId: "surface/main-ceiling", position: [0, 3, 0], normal: [0, -1, 0], capacityKg: 20 },
    { id: "socket/prop-mantel", kind: "prop-support", roomId: "room/main", surfaceId: "surface/hearth-mantel", position: [2, 1.8, 2.7], normal: [0, 1, 0], capacityKg: 12 },
  ],
  facingTargets: [{ id: "facing/hearth", roomId: "room/main", position: [2, 1, 2.7] }],
  anchors: [
    { id: "anchor/camera-review", kind: "camera", roomId: "room/main", position: [2, 1.6, -3], direction: [0, 0, 1], socketId: null },
    { id: "anchor/vfx-hearth", kind: "vfx", roomId: "room/main", position: [2, 1, 2.7], direction: [0, 0, -1], socketId: "socket/wall-hearth" },
    { id: "anchor/light-main", kind: "lighting", roomId: "room/main", position: [0, 3, 0], direction: [0, -1, 0], socketId: "socket/ceiling-light" },
  ],
  sightlines: [{ id: "sightline/entry-hearth", roomId: "room/main", cameraAnchorId: "anchor/camera-review", targetAnchorId: "anchor/vfx-hearth" }],
  occlusionConstraints: [{ id: "occlusion/hearth", sightlineId: "sightline/entry-hearth", clearRadiusM: 0.1, maximumOccluderHeightM: 2 }],
  proxyArchetypes: [{ id: "proxy/settle-two-seat", kind: "settle", dimensions: [2, 1.2, 0.8], supportKind: "floor", requiresApproach: true, requiresOccupancy: true }],
  placements: [{ id: "placement/hearth-settle", archetypeId: "proxy/settle-two-seat", roomId: "room/main", zoneId: "zone/hearth", position: [2, 0, 0], yawRadians: Math.PI, supportSocketId: "socket/floor-settle", facingTargetId: "facing/hearth", footprint: { localCenter: [0, 0], halfExtents: [1, 0.4] } }],
  interactionClearances: [
    { id: "clearance/approach-settle", kind: "approach", placementId: "placement/hearth-settle", roomId: "room/main", center: [2, 0, -0.9], radiusM: 0.35, heightM: 1.9 },
    { id: "clearance/occupancy-settle", kind: "occupancy", placementId: "placement/hearth-settle", roomId: "room/main", center: [2, 0, 0], radiusM: 0.3, heightM: 1.5 },
  ],
  navigation: {
    entryNodeId: "nav/entry",
    nodes: [
      { id: "nav/entry", roomId: "room/main", zoneId: "zone/entry", position: [-1, 0, -2.6] },
      { id: "nav/hearth", roomId: "room/main", zoneId: "zone/hearth", position: [0.6, 0, -1.5] },
    ],
    edges: [{ id: "nav-edge/entry-hearth", fromNodeId: "nav/entry", toNodeId: "nav/hearth", halfWidthM: 0.5, clearHeightM: 2 }],
  },
  doorSweeps: [{ id: "door-sweep/front", roomId: "room/main", doorId: "door/front", hinge: [-1.44, 0.09, -3.66], radiusM: 1.44, leafThicknessM: 0.11, heightM: 2.48, closedYawRadians: 0, openYawRadians: -1.6580627893946132 }],
  hearthExclusions: [{ id: "hearth-exclusion/main", roomId: "room/main", hearthId: "hearth/main", center: [2, 0, 4.15], halfExtents: [0.7, 0.45], yawRadians: Math.PI, minimumClearanceM: 0.8, heightM: 2 }],
  requiredZoneIds: ["zone/entry", "zone/hearth"],
});

test("validates a strict proxy-only plan and hashes canonically", () => {
  const plan = validPlan();
  assert.equal(validateBuildingInteriorPlanV2(plan), plan);
  const reordered = Object.fromEntries(Object.entries(plan).reverse());
  assert.equal(buildingInteriorPlanV2CanonicalText(plan), buildingInteriorPlanV2CanonicalText(reordered));
  assert.equal(buildingInteriorPlanV2Hash(plan), buildingInteriorPlanV2Hash(reordered));
  assert.match(buildingInteriorPlanV2Hash(plan), /^sha256:[0-9a-f]{64}$/);
  const moved = structuredClone(plan); moved.anchors[0].position[0] += 0.01;
  assert.notEqual(buildingInteriorPlanV2Hash(plan), buildingInteriorPlanV2Hash(moved));
});

test("pins approved shell and material identities including required facets and decisions", () => {
  const candidate = validPlan(); candidate.dependencies.materials.status = "candidate";
  assert.throws(() => validateBuildingInteriorPlanV2(candidate), /must be approved/);
  const missingFacet = validPlan(); missingFacet.dependencies.shell.facets.pop();
  assert.throws(() => validateBuildingInteriorPlanV2(missingFacet), /must include collision-traversal/);
  const decisionDrift = validPlan(); decisionDrift.dependencies.materials.approvalDecisionHash = "sha256:ABC";
  assert.throws(() => validateBuildingInteriorPlanV2(decisionDrift), /lowercase sha256/);
  const catalogSmuggling = validPlan(); catalogSmuggling.proxyArchetypes[0].catalog = { artifactId: "furniture/settle/r1" };
  assert.throws(() => validateBuildingInteriorPlanV2(catalogSmuggling), /catalog is unsupported/);
});

test("enforces semantic socket kinds, anchors, and human-scale policy minima", () => {
  const wall = validPlan(); wall.surfaceSockets[1].normal = [0, 1, 0];
  assert.throws(() => validateBuildingInteriorPlanV2(wall), /wall socket normal must be horizontal/);
  const ceiling = validPlan(); ceiling.surfaceSockets[2].position[1] = 2.8;
  assert.throws(() => validateBuildingInteriorPlanV2(ceiling), /ceiling socket must bind/);
  const corridor = validPlan(); corridor.navigation.edges[0].halfWidthM = 0.2;
  assert.throws(() => validateBuildingInteriorPlanV2(corridor), /navigation policy minima/);
  const clearance = validPlan(); clearance.interactionClearances[0].radiusM = 0.2;
  assert.throws(() => validateBuildingInteriorPlanV2(clearance), /must be at least 0.35/);
});

test("uses rotated footprints for containment and overlap", () => {
  const outside = validPlan(); outside.placements[0].position[0] = 3; outside.surfaceSockets[0].position[0] = 3; outside.placements[0].yawRadians = Math.PI / 4; outside.placements[0].facingTargetId = null;
  assert.throws(() => validateBuildingInteriorPlanV2(outside), /rotated envelope must fit/);
  const overlap = validPlan(), second = structuredClone(overlap.placements[0]); second.id = "placement/hearth-settle-2"; second.position = [2.5, 0, 0]; second.supportSocketId = "socket/floor-settle-2"; second.facingTargetId = null;
  overlap.surfaceSockets.push({ ...structuredClone(overlap.surfaceSockets[0]), id: "socket/floor-settle-2", position: [2.5, 0, 0] }); overlap.placements.push(second);
  assert.throws(() => validateBuildingInteriorPlanV2(overlap), /rotated envelopes overlap/);
});

test("requires connected navigation and a reachable node in every required zone", () => {
  const disconnected = validPlan(); disconnected.navigation.nodes.push({ id: "nav/orphan", roomId: "room/main", zoneId: null, position: [-4, 0, 2] });
  assert.throws(() => validateBuildingInteriorPlanV2(disconnected), /one connected topology/);
  const unreachableZone = validPlan(); unreachableZone.zones.push({ id: "zone/storage", kind: "storage", roomId: "room/main", bounds: { center: [-3.5, 1.5, 2.5], halfExtents: [1, 1.5, 1] }, minimumOccupants: 1 }); unreachableZone.requiredZoneIds.push("zone/storage");
  assert.throws(() => validateBuildingInteriorPlanV2(unreachableZone), /required zone zone\/storage is unreachable/);
});

test("rejects a navigation centerline whose full half-width clips a wall", () => {
  const clipped = validPlan();
  clipped.navigation.nodes.push(
    { id: "nav/wall-a", roomId: "room/main", zoneId: null, position: [-4.8, 0, -1] },
    { id: "nav/wall-b", roomId: "room/main", zoneId: null, position: [-4.8, 0, 1] },
  );
  clipped.navigation.edges.push(
    { id: "nav-edge/wall-clipped", fromNodeId: "nav/wall-a", toNodeId: "nav/wall-b", halfWidthM: 0.5, clearHeightM: 2 },
    { id: "nav-edge/wall-connect", fromNodeId: "nav/wall-b", toNodeId: "nav/entry", halfWidthM: 0.5, clearHeightM: 2 },
  );
  assert.throws(() => validateBuildingInteriorPlanV2(clipped), /full corridor width must remain inside/);
});

test("requires the full navigation corridor width to remain on usable floor", () => {
  const clipped = validPlan();
  clipped.navigation.nodes[0].position[0] = -4.8;
  clipped.navigation.nodes[0].zoneId = null;
  clipped.navigation.nodes[1].position = [-4.8, 0, -1.5];
  clipped.navigation.nodes[1].zoneId = null;
  assert.throws(() => validateBuildingInteriorPlanV2(clipped), /full corridor width/);
});

test("keeps navigation corridors clear of interaction envelopes", () => {
  const blocked = validPlan();
  blocked.interactionClearances[0].center = [-.2, 0, -2];
  assert.throws(() => validateBuildingInteriorPlanV2(blocked), /intersects interaction clearance/);
});

test("derives door sweep collisions from hinge, radius, and angles", () => {
  const exactExteriorHinge = validPlan(); assert.deepEqual(exactExteriorHinge.doorSweeps[0].hinge, [-1.44, 0.09, -3.66]); assert.equal(validateBuildingInteriorPlanV2(exactExteriorHinge), exactExteriorHinge);
  const collision = validPlan(); collision.doorSweeps[0] = { ...collision.doorSweeps[0], hinge: [1, 0, -1], radiusM: 1.6, closedYawRadians: 0, openYawRadians: Math.PI / 2 };
  assert.throws(() => validateBuildingInteriorPlanV2(collision), /derived sweep intersects placement/);
  const tooNarrow = validPlan(); tooNarrow.doorSweeps[0].openYawRadians = 0.4;
  assert.throws(() => validateBuildingInteriorPlanV2(tooNarrow), /minimum derived arc opening/);
});

test("enforces hearth exclusions and camera sightline occlusion constraints", () => {
  const embedded = validPlan(); assert.equal(validateBuildingInteriorPlanV2(embedded), embedded);
  const badFront = validPlan(); badFront.hearthExclusions[0].center[2] = 4.8;
  assert.throws(() => validateBuildingInteriorPlanV2(badFront), /front clearance must fit usable floor/);
  const hearth = validPlan(); hearth.hearthExclusions[0].center = [2, 0, 1.5];
  assert.throws(() => validateBuildingInteriorPlanV2(hearth), /intersects placement/);
  const occluded = validPlan(); occluded.occlusionConstraints[0].maximumOccluderHeightM = 0.5;
  assert.throws(() => validateBuildingInteriorPlanV2(occluded), /is occluded by placement/);
  const missingSightline = validPlan(); missingSightline.occlusionConstraints[0].sightlineId = "sightline/missing";
  assert.throws(() => validateBuildingInteriorPlanV2(missingSightline), /does not resolve/);
});

test("rejects conservative-AABB space outside the connected usable-floor union", () => {
  const corner = validPlan(); corner.surfaceSockets[0].position = [-4.5, 0, -4.5];
  assert.throws(() => validateBuildingInteriorPlanV2(corner), /above a usable floor region/);
  const disconnected = validPlan(); disconnected.rooms[0].floorRegions.push({ id: "floor-region/orphan", center: [-4.5, -4.5], halfExtents: [0.25, 0.25] });
  assert.throws(() => validateBuildingInteriorPlanV2(disconnected), /connected usable-floor union/);
});

test("fails closed on unsupported keys, non-finite geometry, and missing interaction proof", () => {
  const extra = validPlan(); extra.placements[0].mystery = true;
  assert.throws(() => validateBuildingInteriorPlanV2(extra), /mystery is unsupported/);
  const nonfinite = validPlan(); nonfinite.rooms[0].bounds.center[0] = Infinity;
  assert.throws(() => validateBuildingInteriorPlanV2(nonfinite), /finite and bounded/);
  const missing = validPlan(); missing.interactionClearances = missing.interactionClearances.filter((entry) => entry.kind !== "approach");
  assert.throws(() => validateBuildingInteriorPlanV2(missing), /requires an approach clearance/);
});
