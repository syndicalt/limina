import test from "node:test";
import assert from "node:assert/strict";
import { BUILDING_INTERIOR_PLAN_SCHEMA, buildingInteriorPlanCanonicalText, buildingInteriorPlanHash, validateBuildingInteriorPlan } from "../../js/src/assets/building-interior-plan.mjs";

const H = (digit) => `sha256:${digit.repeat(64)}`;
const approved = (artifactId, kind, revision, digit) => ({ artifactId, kind, revision, status: "approved", contractHash: H(digit), contentHash: H(String((Number(digit) + 1) % 10)), approvalDecisionId: `decision/${artifactId}/approve-r${revision}`, approvalDecisionHash: H(String((Number(digit) + 2) % 10)) });
const validPlan = () => ({
  schema: BUILDING_INTERIOR_PLAN_SCHEMA, planId: "cottage/hall/interior/r1", revision: 1, supersedes: null, units: "meter",
  shell: approved("cottage/hall/shell/r1", "shell", 1, "1"),
  rooms: [{ id: "room/main", bounds: { center: [0, 1.8, 0], halfExtents: [4.8, 1.8, 3.42] }, finishedFloorY: 0, ceilingY: 3.4 }],
  zones: [{ id: "zone/hearth-seating", kind: "hearth-seating", roomId: "room/main", bounds: { center: [2.8, 0.75, 0], halfExtents: [1.6, 0.75, 1.35] } }],
  targets: [
    { id: "support/main-floor", kind: "support", roomId: "room/main", position: [2.95, 0, 0.1], normal: [0, 1, 0] },
    { id: "facing/hall-hearth", kind: "facing", roomId: "room/main", position: [2.95, 1, 2.58], normal: [0, 0, -1] },
  ],
  placements: [{
    id: "placement/hearth-settle", roomId: "room/main", zoneId: "zone/hearth-seating", catalog: approved("furniture/hearth-settle-v2-r2/r1", "furniture-pack", 1, "4"),
    transform: { position: [2.95, 0, 0.1], yawRadians: Math.PI, scale: [1, 1, 1] }, envelope: { center: [2.95, 0.642, 0.1], halfExtents: [1.08, 0.642, 0.355] },
    support: { targetId: "support/main-floor", contactY: 0, toleranceM: 0.003 }, facing: { targetId: "facing/hall-hearth", forwardLocal: [0, 0, -1], maxAngularErrorDeg: 2 },
    requiredSockets: { approach: ["approach/left", "approach/right"], occupancy: ["occupancy/left", "occupancy/right"] },
  }],
  clearances: [
    { id: "clearance/approach-left", kind: "approach", placementId: "placement/hearth-settle", socketId: "approach/left", roomId: "room/main", center: [3.405, 0.9, 0.96], radiusM: 0.36, halfHeightM: 0.9 },
    { id: "clearance/approach-right", kind: "approach", placementId: "placement/hearth-settle", socketId: "approach/right", roomId: "room/main", center: [2.495, 0.9, 0.96], radiusM: 0.36, halfHeightM: 0.9 },
    { id: "clearance/occupancy-left", kind: "occupancy", placementId: "placement/hearth-settle", socketId: "occupancy/left", roomId: "room/main", center: [3.405, 1.05, 0.15], radiusM: 0.34, halfHeightM: 0.75 },
    { id: "clearance/occupancy-right", kind: "occupancy", placementId: "placement/hearth-settle", socketId: "occupancy/right", roomId: "room/main", center: [2.495, 1.05, 0.15], radiusM: 0.34, halfHeightM: 0.75 },
  ],
  circulationCorridors: [{ id: "corridor/entry-hearth", roomId: "room/main", from: [-0.72, 0, -2.9], to: [-0.72, 0, 2.7], halfWidthM: 0.5, minClearHeightM: 2.2 }],
  doorSweeps: [{ id: "door-sweep/front", roomId: "room/main", doorId: "door/front", hinge: [-1.44, 0, -3.3], closedYawRadians: 0, openYawRadians: -1.658, radiusM: 1.45, heightM: 2.6, clearanceBounds: { center: [-0.8, 1.3, -2.75], halfExtents: [0.65, 1.3, 0.55] } }],
  hearthClearances: [{ id: "heat-clearance/hall-hearth", roomId: "room/main", hearthId: "hall-hearth", minimumClearanceM: 0.8, clearanceBounds: { center: [2.95, 1, 2.45], halfExtents: [1.05, 1, 0.82] } }],
});

test("validates an exact approved, bounded interior plan and hashes canonically", () => {
  const plan = validPlan(); assert.equal(validateBuildingInteriorPlan(plan), plan);
  const reordered = Object.fromEntries(Object.entries(plan).reverse());
  assert.equal(buildingInteriorPlanCanonicalText(plan), buildingInteriorPlanCanonicalText(reordered));
  assert.equal(buildingInteriorPlanHash(plan), buildingInteriorPlanHash(reordered));
  assert.match(buildingInteriorPlanHash(plan), /^sha256:[0-9a-f]{64}$/);
  const moved = structuredClone(plan); moved.placements[0].transform.position[0] += 0.01;
  assert.notEqual(buildingInteriorPlanHash(plan), buildingInteriorPlanHash(moved));
});

test("fails closed on unsupported keys, unapproved catalog bytes, and non-unit approved scale", () => {
  const extra = validPlan(); extra.placements[0].mystery = true; assert.throws(() => validateBuildingInteriorPlan(extra), /mystery is unsupported/);
  const unapproved = validPlan(); unapproved.placements[0].catalog.status = "candidate"; assert.throws(() => validateBuildingInteriorPlan(unapproved), /must be approved/);
  const scaled = validPlan(); scaled.placements[0].transform.scale = [1.1, 1.1, 1.1]; assert.throws(() => validateBuildingInteriorPlan(scaled), /must remain \[1,1,1\]/);
  const drift = validPlan(); drift.placements[0].catalog.contentHash = "sha256:ABC"; assert.throws(() => validateBuildingInteriorPlan(drift), /lowercase sha256/);
});

test("rejects unresolved bindings and incomplete socket clearance sets", () => {
  const support = validPlan(); support.placements[0].support.targetId = "support/missing"; assert.throws(() => validateBuildingInteriorPlan(support), /does not resolve to a support target/);
  const facing = validPlan(); facing.placements[0].transform.yawRadians = 0; assert.throws(() => validateBuildingInteriorPlan(facing), /misses its target/);
  const missing = validPlan(); missing.clearances.pop(); assert.throws(() => validateBuildingInteriorPlan(missing), /does not have an exact clearance set/);
  const wrongSocket = validPlan(); wrongSocket.clearances[0].socketId = "approach/unknown"; assert.throws(() => validateBuildingInteriorPlan(wrongSocket), /is not required/);
});

test("rejects placements outside zones or crossing circulation, door, and hearth exclusions", () => {
  const outside = validPlan(); outside.placements[0].envelope.center[0] = 4.5; assert.throws(() => validateBuildingInteriorPlan(outside), /contained by its room and zone/);
  const corridor = validPlan(); corridor.circulationCorridors[0].from = [2.95, 0, -1]; corridor.circulationCorridors[0].to = [2.95, 0, 1]; assert.throws(() => validateBuildingInteriorPlan(corridor), /intersects placement/);
  const sweep = validPlan(); sweep.doorSweeps[0].clearanceBounds = { center: [2.95, 1.3, 0.1], halfExtents: [1.2, 1.3, 0.5] }; sweep.doorSweeps[0].hinge = [2.95, 0, 0.1]; assert.throws(() => validateBuildingInteriorPlan(sweep), /intersects placement/);
  const heat = validPlan(); heat.hearthClearances[0].clearanceBounds.center = [2.95, 1, 0.6]; assert.throws(() => validateBuildingInteriorPlan(heat), /intersects placement/);
  const heatApproach = validPlan(); heatApproach.hearthClearances[0].clearanceBounds = { center: [3.405, 1, 1.1], halfExtents: [0.3, 1, 0.2] }; assert.throws(() => validateBuildingInteriorPlan(heatApproach), /intersects interaction clearance/);
});

test("rejects non-finite geometry, overlapping envelopes, and invalid support contact", () => {
  const nonfinite = validPlan(); nonfinite.rooms[0].bounds.center[0] = Infinity; assert.throws(() => validateBuildingInteriorPlan(nonfinite), /must be finite/);
  const contact = validPlan(); contact.placements[0].support.contactY = 0.1; assert.throws(() => validateBuildingInteriorPlan(contact), /does not bind/);
  const overlap = validPlan(), duplicate = structuredClone(overlap.placements[0]); duplicate.id = "placement/hearth-settle-2"; overlap.placements.push(duplicate); assert.throws(() => validateBuildingInteriorPlan(overlap), /envelopes overlap/);
});

test("permits repeated approved catalog instances but rejects conflicting identity for one revision", () => {
  const repeated = validPlan(), second = structuredClone(repeated.placements[0]); second.id = "placement/hearth-settle-2"; second.zoneId = "zone/hearth-seating-2"; second.transform.position = [-2.5, 0, 0]; second.envelope.center = [-2.5, 0.642, 0]; second.support.targetId = "support/main-floor-2"; second.facing.targetId = "facing/hall-hearth-2"; second.requiredSockets = { approach: [], occupancy: [] };
  repeated.zones.push({ id: "zone/hearth-seating-2", kind: "hearth-seating", roomId: "room/main", bounds: { center: [-2.5, 0.75, 0], halfExtents: [1.2, 0.75, 1] } });
  repeated.targets.push({ id: "support/main-floor-2", kind: "support", roomId: "room/main", position: [-2.5, 0, 0], normal: [0, 1, 0] }, { id: "facing/hall-hearth-2", kind: "facing", roomId: "room/main", position: [-2.5, 1, 2], normal: [0, 0, -1] });
  repeated.placements.push(second); assert.equal(validateBuildingInteriorPlan(repeated), repeated);
  const conflict = structuredClone(repeated); conflict.placements[1].catalog.contentHash = H("9"); assert.throws(() => validateBuildingInteriorPlan(conflict), /conflicts with another reference/);
});
