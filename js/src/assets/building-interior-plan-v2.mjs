import { canonicalCompilerJson } from "../world/compiler/canonical.mjs";
import { sha256 } from "../world/sha256.mjs";

export const BUILDING_INTERIOR_PLAN_V2_SCHEMA =
  "limina.building-interior-plan/v2";
export const BUILDING_INTERIOR_PLAN_V2_LIMITS = Object.freeze({
  rooms: 32,
  zones: 128,
  sockets: 512,
  targets: 256,
  anchors: 256,
  sightlines: 128,
  occlusionConstraints: 128,
  archetypes: 128,
  placements: 256,
  clearances: 1024,
  navigationNodes: 512,
  navigationEdges: 1024,
  doors: 64,
  hearths: 64,
});
export const BUILDING_INTERIOR_PLAN_V2_POLICY_FLOORS = Object.freeze({
  corridorHalfWidthMinM: 0.45,
  clearHeightMinM: 1.9,
  approachRadiusMinM: 0.35,
  occupancyRadiusMinM: 0.3,
  doorOpeningMinRadians: 1.2,
  zoneHeadroomMinM: 1.9,
  occupantAreaMinM2: 0.75,
  hearthClearanceMinM: 0.8,
});

const ID = /^[a-z0-9][a-z0-9._/-]{0,159}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const SOCKET_KINDS = new Set(["floor", "wall", "ceiling", "prop-support"]);
const ANCHOR_KINDS = new Set(["lighting", "vfx", "camera"]);
const CLEARANCE_KINDS = new Set(["approach", "occupancy"]);
const REQUIRED_FACETS = Object.freeze({
  shell: [
    "interior-envelope",
    "support-sockets",
    "portal-articulation",
    "hearth-flue-sockets",
    "collision-traversal",
  ],
  "material-palette": [
    "role-contract",
    "surface-parameters",
    "runtime-textures",
  ],
});

/** Optional I1 facets isolate one furniture archetype from unrelated placement revisions. */
export const INTERIOR_PLACEMENT_FACET_ARCHETYPES = Object.freeze([
  "proxy/dining-table",
  "proxy/dining-chair",
  "proxy/hearth-settle",
  "proxy/storage-shelf",
]);
export const interiorPlacementFacetScope = (archetypeId) => {
  if (!INTERIOR_PLACEMENT_FACET_ARCHETYPES.includes(archetypeId))
    throw new Error(
      `unsupported interior placement facet archetype ${archetypeId}`,
    );
  return `placements/${archetypeId}`;
};

function fail(label, message) {
  throw new Error(`building interior plan v2: ${label} ${message}`);
}
function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(label, "must be an object");
  return value;
}
function exact(value, keys, label) {
  const expected = new Set(keys);
  for (const key of keys)
    if (!(key in value)) fail(`${label}.${key}`, "is required");
  for (const key of Object.keys(value))
    if (!expected.has(key)) fail(`${label}.${key}`, "is unsupported");
}
function id(value, label) {
  if (typeof value !== "string" || !ID.test(value))
    fail(label, "must be a stable lowercase id");
  return value;
}
function hash(value, label) {
  if (typeof value !== "string" || !HASH.test(value))
    fail(label, "must be a lowercase sha256 hash");
  return value;
}
function finite(value, label) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > 1_000_000
  )
    fail(label, "must be finite and bounded");
  return value;
}
function positive(value, label) {
  finite(value, label);
  if (value <= 0) fail(label, "must be positive");
  return value;
}
function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 1)
    fail(label, "must be a positive safe integer");
  return value;
}
function vec3(value, label) {
  if (!Array.isArray(value) || value.length !== 3)
    fail(label, "must be a vec3");
  return value.map((entry, axis) => finite(entry, `${label}[${axis}]`));
}
function vec2(value, label, axesPositive = false) {
  if (!Array.isArray(value) || value.length !== 2)
    fail(label, "must be a vec2");
  const result = value.map((entry, axis) => finite(entry, `${label}[${axis}]`));
  if (axesPositive && result.some((entry) => entry <= 0))
    fail(label, "axes must be positive");
  return result;
}
function unit3(value, label) {
  const result = vec3(value, label),
    length = Math.hypot(...result);
  if (Math.abs(length - 1) > 1e-6) fail(label, "must be unit length");
  return result;
}
function array(value, label, maximum, nonempty = true) {
  if (!Array.isArray(value) || (nonempty && value.length === 0))
    fail(label, nonempty ? "must be non-empty" : "must be an array");
  if (value.length > maximum) fail(label, `exceeds ${maximum} entries`);
  return value;
}
function unique(values, label) {
  if (new Set(values).size !== values.length) fail(label, "must be unique");
}
function box(value, label) {
  const result = object(value, label);
  exact(result, ["center", "halfExtents"], label);
  const center = vec3(result.center, `${label}.center`),
    halfExtents = vec3(result.halfExtents, `${label}.halfExtents`);
  if (halfExtents.some((entry) => entry <= 0))
    fail(`${label}.halfExtents`, "axes must be positive");
  return { center, halfExtents };
}
function min(boxValue, axis) {
  return boxValue.center[axis] - boxValue.halfExtents[axis];
}
function max(boxValue, axis) {
  return boxValue.center[axis] + boxValue.halfExtents[axis];
}
function containsPoint(boxValue, point, epsilon = 1e-8) {
  return [0, 1, 2].every(
    (axis) =>
      point[axis] >= min(boxValue, axis) - epsilon &&
      point[axis] <= max(boxValue, axis) + epsilon,
  );
}
function containsBox(outer, inner, epsilon = 1e-8) {
  return [0, 1, 2].every(
    (axis) =>
      min(inner, axis) >= min(outer, axis) - epsilon &&
      max(inner, axis) <= max(outer, axis) + epsilon,
  );
}
function angle(value) {
  const twoPi = Math.PI * 2;
  let result = value % twoPi;
  if (result < 0) result += twoPi;
  return result;
}
function signedAngleDelta(from, to) {
  let result = angle(to) - angle(from);
  if (result > Math.PI) result -= Math.PI * 2;
  if (result < -Math.PI) result += Math.PI * 2;
  return result;
}
function angleInSweep(candidate, from, to, padding = 0) {
  const sweep = signedAngleDelta(from, to),
    delta = signedAngleDelta(from, candidate);
  return sweep >= 0
    ? delta >= -padding && delta <= sweep + padding
    : delta <= padding && delta >= sweep - padding;
}
function obbCorners(record) {
  const c = Math.cos(record.yaw),
    s = Math.sin(record.yaw),
    result = [];
  for (const x of [-record.half[0], record.half[0]])
    for (const z of [-record.half[1], record.half[1]])
      result.push([
        record.center[0] + c * x + s * z,
        record.center[1] - s * x + c * z,
      ]);
  return result;
}
function pointInBox2d(point, boundsValue) {
  return (
    point[0] >= min(boundsValue, 0) - 1e-8 &&
    point[0] <= max(boundsValue, 0) + 1e-8 &&
    point[1] >= min(boundsValue, 2) - 1e-8 &&
    point[1] <= max(boundsValue, 2) + 1e-8
  );
}
function pointInRegion(point, region) {
  return (
    point[0] >= region.center[0] - region.half[0] - 1e-8 &&
    point[0] <= region.center[0] + region.half[0] + 1e-8 &&
    point[1] >= region.center[1] - region.half[1] - 1e-8 &&
    point[1] <= region.center[1] + region.half[1] + 1e-8
  );
}
function regionOverlaps(a, b) {
  return (
    Math.abs(a.center[0] - b.center[0]) <= a.half[0] + b.half[0] + 1e-8 &&
    Math.abs(a.center[1] - b.center[1]) <= a.half[1] + b.half[1] + 1e-8
  );
}
function pointRegionDistance(point, region) {
  const dx = Math.max(
      Math.abs(point[0] - region.center[0]) - region.half[0],
      0,
    ),
    dz = Math.max(Math.abs(point[1] - region.center[1]) - region.half[1], 0);
  return Math.hypot(dx, dz);
}
function obbInRegion(obb, region) {
  return obbCorners(obb).every((corner) => pointInRegion(corner, region));
}
function pointInRoomFloor(room, point) {
  return room.regions.some((region) =>
    pointInRegion([point[0], point[2]], region),
  );
}
function obbInRoomFloor(room, obb) {
  return room.regions.some((region) => obbInRegion(obb, region));
}
function circleInRoomFloor(room, center, radius) {
  return room.regions.some(
    (region) =>
      center[0] - radius >= region.center[0] - region.half[0] - 1e-8 &&
      center[0] + radius <= region.center[0] + region.half[0] + 1e-8 &&
      center[2] - radius >= region.center[1] - region.half[1] - 1e-8 &&
      center[2] + radius <= region.center[1] + region.half[1] + 1e-8,
  );
}
function segmentRegionInterval(from, to, region, inset = 0) {
  let enter = 0,
    exit = 1;
  for (const [axis, sourceAxis] of [
    [0, 0],
    [1, 2],
  ]) {
    const low = region.center[axis] - region.half[axis] + inset,
      high = region.center[axis] + region.half[axis] - inset,
      delta = to[sourceAxis] - from[sourceAxis];
    if (low > high + 1e-8) return null;
    if (Math.abs(delta) < 1e-12) {
      if (from[sourceAxis] < low || from[sourceAxis] > high) return null;
      continue;
    }
    const a = (low - from[sourceAxis]) / delta,
      b = (high - from[sourceAxis]) / delta;
    enter = Math.max(enter, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
    if (enter > exit + 1e-10) return null;
  }
  return [enter, exit];
}
function segmentInsideRoomFloor(room, from, to, inset = 0) {
  const intervals = room.regions
    .map((region) => segmentRegionInterval(from, to, region, inset))
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0]);
  if (!intervals.length || intervals[0][0] > 1e-8) return false;
  let covered = intervals[0][1];
  for (const interval of intervals.slice(1)) {
    if (interval[0] > covered + 1e-8) return false;
    covered = Math.max(covered, interval[1]);
  }
  return covered >= 1 - 1e-8;
}
function corridorInsideRoomFloor(room, from, to, halfWidth) {
  const dx = to[0] - from[0],
    dz = to[2] - from[2],
    length = Math.hypot(dx, dz);
  if (length < 1e-8) return false;
  const offsetX = (-dz / length) * halfWidth,
    offsetZ = (dx / length) * halfWidth,
    shifted = (point, sign) => [
      point[0] + offsetX * sign,
      point[1],
      point[2] + offsetZ * sign,
    ];
  return (
    segmentInsideRoomFloor(room, from, to) &&
    segmentInsideRoomFloor(room, shifted(from, 1), shifted(to, 1)) &&
    segmentInsideRoomFloor(room, shifted(from, -1), shifted(to, -1))
  );
}
function obbInsideBox(record, boundsValue) {
  return (
    obbCorners(record).every((corner) => pointInBox2d(corner, boundsValue)) &&
    record.floorY >= min(boundsValue, 1) - 1e-8 &&
    record.floorY + record.height <= max(boundsValue, 1) + 1e-8
  );
}
function project(points, axis) {
  const values = points.map((point) => point[0] * axis[0] + point[1] * axis[1]);
  return [Math.min(...values), Math.max(...values)];
}
function obbOverlap(a, b, padding = 0) {
  const ac = obbCorners(a),
    bc = obbCorners(b),
    axes = [
      [Math.cos(a.yaw), -Math.sin(a.yaw)],
      [Math.sin(a.yaw), Math.cos(a.yaw)],
      [Math.cos(b.yaw), -Math.sin(b.yaw)],
      [Math.sin(b.yaw), Math.cos(b.yaw)],
    ];
  return axes.every((axis) => {
    const pa = project(ac, axis),
      pb = project(bc, axis);
    return pa[0] < pb[1] + padding - 1e-8 && pa[1] > pb[0] - padding + 1e-8;
  });
}
function pointSegmentDistance(point, from, to) {
  const dx = to[0] - from[0],
    dz = to[2] - from[2],
    length2 = dx * dx + dz * dz;
  const t =
    length2 === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((point[0] - from[0]) * dx + (point[2] - from[2]) * dz) / length2,
          ),
        );
  return Math.hypot(
    point[0] - (from[0] + t * dx),
    point[2] - (from[2] + t * dz),
  );
}
function segmentHitsObb(from, to, obb, padding = 0) {
  const c = Math.cos(obb.yaw),
    s = Math.sin(obb.yaw),
    local = (point) => {
      const dx = point[0] - obb.center[0],
        dz = point[2] - obb.center[1];
      return [c * dx - s * dz, s * dx + c * dz];
    };
  const a = local(from),
    b = local(to),
    expanded = {
      center: [0, 0, 0],
      halfExtents: [obb.half[0] + padding, 1, obb.half[1] + padding],
    };
  let enter = 0,
    exit = 1;
  for (const axis of [0, 1]) {
    const delta = b[axis] - a[axis],
      low = -expanded.halfExtents[axis],
      high = expanded.halfExtents[axis];
    if (Math.abs(delta) < 1e-12) {
      if (a[axis] < low || a[axis] > high) return false;
      continue;
    }
    const p = (low - a[axis]) / delta,
      q = (high - a[axis]) / delta;
    enter = Math.max(enter, Math.min(p, q));
    exit = Math.min(exit, Math.max(p, q));
    if (enter > exit) return false;
  }
  return true;
}
function circleHitsObb(center, radius, obb) {
  const c = Math.cos(obb.yaw),
    s = Math.sin(obb.yaw),
    dx = center[0] - obb.center[0],
    dz = center[2] - obb.center[1],
    x = c * dx - s * dz,
    z = s * dx + c * dz,
    qx = Math.max(-obb.half[0], Math.min(obb.half[0], x)),
    qz = Math.max(-obb.half[1], Math.min(obb.half[1], z));
  return Math.hypot(x - qx, z - qz) < radius - 1e-8;
}
function doorArcHitsCircle(door, center, obstacleRadius) {
  const dx = center[0] - door.hinge[0],
    dz = center[2] - door.hinge[2],
    distance = Math.hypot(dx, dz);
  if (
    distance > door.radius + obstacleRadius ||
    distance + obstacleRadius < door.leafThickness / 2
  )
    return false;
  if (distance <= obstacleRadius) return true;
  const padding = Math.asin(Math.min(1, obstacleRadius / distance));
  return angleInSweep(Math.atan2(dz, dx), door.closed, door.open, padding);
}
function doorArcRelevantToRoom(door, room) {
  return room.regions.some(
    (region) =>
      pointRegionDistance([door.hinge[0], door.hinge[2]], region) <=
      door.radius + door.leafThickness / 2 + 1e-8,
  );
}
function approvedDependency(value, label, expectedKind) {
  const ref = object(value, label);
  exact(
    ref,
    [
      "artifactId",
      "kind",
      "revision",
      "status",
      "contractHash",
      "contentHash",
      "approvalDecisionId",
      "approvalDecisionHash",
      "facets",
    ],
    label,
  );
  id(ref.artifactId, `${label}.artifactId`);
  if (ref.kind !== expectedKind)
    fail(`${label}.kind`, `must be ${expectedKind}`);
  integer(ref.revision, `${label}.revision`);
  if (ref.status !== "approved") fail(`${label}.status`, "must be approved");
  hash(ref.contractHash, `${label}.contractHash`);
  hash(ref.contentHash, `${label}.contentHash`);
  id(ref.approvalDecisionId, `${label}.approvalDecisionId`);
  hash(ref.approvalDecisionHash, `${label}.approvalDecisionHash`);
  const scopes = [];
  for (const [index, raw] of array(
    ref.facets,
    `${label}.facets`,
    32,
  ).entries()) {
    const facetLabel = `${label}.facets[${index}]`,
      facet = object(raw, facetLabel);
    exact(facet, ["scope", "hash"], facetLabel);
    id(facet.scope, `${facetLabel}.scope`);
    hash(facet.hash, `${facetLabel}.hash`);
    scopes.push(facet.scope);
  }
  unique(scopes, `${label}.facets scopes`);
  for (const required of REQUIRED_FACETS[expectedKind])
    if (!scopes.includes(required))
      fail(`${label}.facets`, `must include ${required}`);
  return ref;
}

export function validateBuildingInteriorPlanV2(value) {
  const plan = object(value, "plan");
  exact(
    plan,
    [
      "schema",
      "planId",
      "revision",
      "supersedes",
      "units",
      "dependencies",
      "policy",
      "rooms",
      "zones",
      "surfaceSockets",
      "facingTargets",
      "anchors",
      "sightlines",
      "occlusionConstraints",
      "proxyArchetypes",
      "placements",
      "interactionClearances",
      "navigation",
      "doorSweeps",
      "hearthExclusions",
      "requiredZoneIds",
    ],
    "plan",
  );
  if (plan.schema !== BUILDING_INTERIOR_PLAN_V2_SCHEMA)
    fail("plan.schema", "is unsupported");
  id(plan.planId, "plan.planId");
  integer(plan.revision, "plan.revision");
  if (plan.supersedes !== null) id(plan.supersedes, "plan.supersedes");
  if ((plan.revision === 1) !== (plan.supersedes === null))
    fail("plan.supersedes", "must be null exactly for revision 1");
  if (plan.supersedes === plan.planId)
    fail("plan.supersedes", "must not identify this plan");
  if (plan.units !== "meter") fail("plan.units", "must be meter");
  const dependencies = object(plan.dependencies, "plan.dependencies");
  exact(dependencies, ["shell", "materials"], "plan.dependencies");
  approvedDependency(dependencies.shell, "plan.dependencies.shell", "shell");
  approvedDependency(
    dependencies.materials,
    "plan.dependencies.materials",
    "material-palette",
  );
  const policy = object(plan.policy, "plan.policy");
  exact(
    policy,
    Object.keys(BUILDING_INTERIOR_PLAN_V2_POLICY_FLOORS),
    "plan.policy",
  );
  for (const [key, floor] of Object.entries(
    BUILDING_INTERIOR_PLAN_V2_POLICY_FLOORS,
  ))
    if (positive(policy[key], `plan.policy.${key}`) < floor)
      fail(`plan.policy.${key}`, `must be at least ${floor}`);

  const rooms = new Map();
  for (const [index, raw] of array(
    plan.rooms,
    "plan.rooms",
    BUILDING_INTERIOR_PLAN_V2_LIMITS.rooms,
  ).entries()) {
    const label = `plan.rooms[${index}]`,
      room = object(raw, label);
    exact(
      room,
      ["id", "bounds", "finishedFloorY", "ceilingY", "floorRegions"],
      label,
    );
    id(room.id, `${label}.id`);
    if (rooms.has(room.id)) fail(`${label}.id`, "is duplicated");
    const bounds = box(room.bounds, `${label}.bounds`),
      floorY = finite(room.finishedFloorY, `${label}.finishedFloorY`),
      ceilingY = finite(room.ceilingY, `${label}.ceilingY`);
    if (
      floorY < min(bounds, 1) ||
      ceilingY > max(bounds, 1) ||
      ceilingY - floorY < policy.zoneHeadroomMinM
    )
      fail(label, "must provide bounded human-scale floor and ceiling");
    const regions = [];
    for (const [regionIndex, rawRegion] of array(
      room.floorRegions,
      `${label}.floorRegions`,
      128,
    ).entries()) {
      const regionLabel = `${label}.floorRegions[${regionIndex}]`,
        region = object(rawRegion, regionLabel);
      exact(region, ["id", "center", "halfExtents"], regionLabel);
      id(region.id, `${regionLabel}.id`);
      const center = vec2(region.center, `${regionLabel}.center`),
        half = vec2(region.halfExtents, `${regionLabel}.halfExtents`, true);
      if (
        !pointInBox2d([center[0] - half[0], center[1] - half[1]], bounds) ||
        !pointInBox2d([center[0] + half[0], center[1] + half[1]], bounds)
      )
        fail(regionLabel, "must fit the conservative room bounds");
      regions.push({ raw: region, center, half });
    }
    unique(
      regions.map((entry) => entry.raw.id),
      `${label}.floorRegions ids`,
    );
    const reachedRegions = new Set([0]),
      regionQueue = [0];
    while (regionQueue.length) {
      const current = regionQueue.shift();
      for (let other = 0; other < regions.length; other++)
        if (
          !reachedRegions.has(other) &&
          regionOverlaps(regions[current], regions[other])
        ) {
          reachedRegions.add(other);
          regionQueue.push(other);
        }
    }
    if (reachedRegions.size !== regions.length)
      fail(
        `${label}.floorRegions`,
        "must form one connected usable-floor union",
      );
    rooms.set(room.id, { raw: room, bounds, floorY, ceilingY, regions });
  }
  const zones = new Map();
  for (const [index, raw] of array(
    plan.zones,
    "plan.zones",
    BUILDING_INTERIOR_PLAN_V2_LIMITS.zones,
  ).entries()) {
    const label = `plan.zones[${index}]`,
      zone = object(raw, label);
    exact(zone, ["id", "kind", "roomId", "bounds", "minimumOccupants"], label);
    id(zone.id, `${label}.id`);
    id(zone.kind, `${label}.kind`);
    id(zone.roomId, `${label}.roomId`);
    integer(zone.minimumOccupants, `${label}.minimumOccupants`);
    if (zones.has(zone.id)) fail(`${label}.id`, "is duplicated");
    const room = rooms.get(zone.roomId);
    if (!room) fail(`${label}.roomId`, "does not resolve");
    const bounds = box(zone.bounds, `${label}.bounds`),
      zoneObb = {
        center: [bounds.center[0], bounds.center[2]],
        half: [bounds.halfExtents[0], bounds.halfExtents[2]],
        yaw: 0,
      };
    const floorArea = bounds.halfExtents[0] * 2 * bounds.halfExtents[2] * 2;
    if (
      !containsBox(room.bounds, bounds) ||
      !obbInRoomFloor(room, zoneObb) ||
      bounds.halfExtents[1] * 2 < policy.zoneHeadroomMinM ||
      floorArea < zone.minimumOccupants * policy.occupantAreaMinM2
    )
      fail(
        `${label}.bounds`,
        "must fit one usable floor region at human scale for its occupants",
      );
    zones.set(zone.id, { raw: zone, bounds });
  }
  const requiredZoneIds = array(
    plan.requiredZoneIds,
    "plan.requiredZoneIds",
    BUILDING_INTERIOR_PLAN_V2_LIMITS.zones,
  );
  requiredZoneIds.forEach((entry, index) => {
    id(entry, `plan.requiredZoneIds[${index}]`);
    if (!zones.has(entry))
      fail(`plan.requiredZoneIds[${index}]`, "does not resolve");
  });
  unique(requiredZoneIds, "plan.requiredZoneIds");

  const sockets = new Map();
  for (const [index, raw] of array(
    plan.surfaceSockets,
    "plan.surfaceSockets",
    BUILDING_INTERIOR_PLAN_V2_LIMITS.sockets,
  ).entries()) {
    const label = `plan.surfaceSockets[${index}]`,
      socket = object(raw, label);
    exact(
      socket,
      ["id", "kind", "roomId", "surfaceId", "position", "normal", "capacityKg"],
      label,
    );
    id(socket.id, `${label}.id`);
    if (!SOCKET_KINDS.has(socket.kind)) fail(`${label}.kind`, "is unsupported");
    id(socket.roomId, `${label}.roomId`);
    id(socket.surfaceId, `${label}.surfaceId`);
    if (sockets.has(socket.id)) fail(`${label}.id`, "is duplicated");
    const room = rooms.get(socket.roomId);
    if (!room) fail(`${label}.roomId`, "does not resolve");
    const position = vec3(socket.position, `${label}.position`),
      normal = unit3(socket.normal, `${label}.normal`);
    if (
      !containsPoint(room.bounds, position) ||
      !pointInRoomFloor(room, position)
    )
      fail(
        `${label}.position`,
        "must be above a usable floor region in its room",
      );
    if (
      socket.kind === "floor" &&
      (normal[1] < 0.9 || Math.abs(position[1] - room.floorY) > 0.05)
    )
      fail(label, "floor socket must bind the finished floor");
    if (
      socket.kind === "ceiling" &&
      (normal[1] > -0.9 || Math.abs(position[1] - room.ceilingY) > 0.05)
    )
      fail(label, "ceiling socket must bind the ceiling");
    if (socket.kind === "wall" && Math.abs(normal[1]) > 0.1)
      fail(label, "wall socket normal must be horizontal");
    positive(socket.capacityKg, `${label}.capacityKg`);
    sockets.set(socket.id, { raw: socket, position, normal });
  }
  const targets = new Map();
  for (const [index, raw] of array(
    plan.facingTargets,
    "plan.facingTargets",
    BUILDING_INTERIOR_PLAN_V2_LIMITS.targets,
  ).entries()) {
    const label = `plan.facingTargets[${index}]`,
      target = object(raw, label);
    exact(target, ["id", "roomId", "position"], label);
    id(target.id, `${label}.id`);
    id(target.roomId, `${label}.roomId`);
    if (targets.has(target.id)) fail(`${label}.id`, "is duplicated");
    const room = rooms.get(target.roomId),
      position = vec3(target.position, `${label}.position`);
    if (
      !room ||
      !containsPoint(room.bounds, position) ||
      !pointInRoomFloor(room, position)
    )
      fail(label, "must resolve above usable floor in its room");
    targets.set(target.id, { raw: target, position });
  }
  const anchors = new Map();
  for (const [index, raw] of array(
    plan.anchors,
    "plan.anchors",
    BUILDING_INTERIOR_PLAN_V2_LIMITS.anchors,
  ).entries()) {
    const label = `plan.anchors[${index}]`,
      anchor = object(raw, label);
    exact(
      anchor,
      ["id", "kind", "roomId", "position", "direction", "socketId"],
      label,
    );
    id(anchor.id, `${label}.id`);
    if (!ANCHOR_KINDS.has(anchor.kind)) fail(`${label}.kind`, "is unsupported");
    id(anchor.roomId, `${label}.roomId`);
    if (anchors.has(anchor.id)) fail(`${label}.id`, "is duplicated");
    const room = rooms.get(anchor.roomId),
      position = vec3(anchor.position, `${label}.position`),
      direction = unit3(anchor.direction, `${label}.direction`);
    if (
      !room ||
      !containsPoint(room.bounds, position) ||
      !pointInRoomFloor(room, position)
    )
      fail(label, "must resolve above usable floor in its room");
    if (anchor.socketId !== null) {
      id(anchor.socketId, `${label}.socketId`);
      const socket = sockets.get(anchor.socketId);
      if (!socket || socket.raw.roomId !== anchor.roomId)
        fail(`${label}.socketId`, "does not resolve in its room");
    }
    anchors.set(anchor.id, { raw: anchor, position, direction });
  }

  const archetypes = new Map();
  for (const [index, raw] of array(
    plan.proxyArchetypes,
    "plan.proxyArchetypes",
    BUILDING_INTERIOR_PLAN_V2_LIMITS.archetypes,
  ).entries()) {
    const label = `plan.proxyArchetypes[${index}]`,
      archetype = object(raw, label);
    exact(
      archetype,
      [
        "id",
        "kind",
        "dimensions",
        "supportKind",
        "requiresApproach",
        "requiresOccupancy",
      ],
      label,
    );
    id(archetype.id, `${label}.id`);
    id(archetype.kind, `${label}.kind`);
    if (archetypes.has(archetype.id)) fail(`${label}.id`, "is duplicated");
    const dimensions = vec3(archetype.dimensions, `${label}.dimensions`);
    if (dimensions.some((entry) => entry < 0.05))
      fail(`${label}.dimensions`, "must be human-scale positive dimensions");
    if (!SOCKET_KINDS.has(archetype.supportKind))
      fail(`${label}.supportKind`, "is unsupported");
    if (
      typeof archetype.requiresApproach !== "boolean" ||
      typeof archetype.requiresOccupancy !== "boolean"
    )
      fail(label, "interaction requirements must be boolean");
    archetypes.set(archetype.id, { raw: archetype, dimensions });
  }
  const placements = new Map();
  for (const [index, raw] of array(
    plan.placements,
    "plan.placements",
    BUILDING_INTERIOR_PLAN_V2_LIMITS.placements,
  ).entries()) {
    const label = `plan.placements[${index}]`,
      placement = object(raw, label);
    exact(
      placement,
      [
        "id",
        "archetypeId",
        "roomId",
        "zoneId",
        "position",
        "yawRadians",
        "supportSocketId",
        "facingTargetId",
        "footprint",
      ],
      label,
    );
    id(placement.id, `${label}.id`);
    id(placement.archetypeId, `${label}.archetypeId`);
    id(placement.roomId, `${label}.roomId`);
    id(placement.zoneId, `${label}.zoneId`);
    id(placement.supportSocketId, `${label}.supportSocketId`);
    if (placements.has(placement.id)) fail(`${label}.id`, "is duplicated");
    const room = rooms.get(placement.roomId),
      zone = zones.get(placement.zoneId),
      archetype = archetypes.get(placement.archetypeId),
      socket = sockets.get(placement.supportSocketId);
    if (
      !room ||
      !zone ||
      zone.raw.roomId !== placement.roomId ||
      !archetype ||
      !socket ||
      socket.raw.roomId !== placement.roomId ||
      socket.raw.kind !== archetype.raw.supportKind
    )
      fail(
        label,
        "has an unresolved room, zone, archetype, or support binding",
      );
    const position = vec3(placement.position, `${label}.position`),
      yaw = finite(placement.yawRadians, `${label}.yawRadians`);
    if (Math.abs(yaw) > Math.PI * 2)
      fail(`${label}.yawRadians`, "must be within one signed revolution");
    if (
      Math.hypot(
        position[0] - socket.position[0],
        position[1] - socket.position[1],
        position[2] - socket.position[2],
      ) > 0.05
    )
      fail(`${label}.position`, "must contact its support socket");
    if (placement.facingTargetId !== null) {
      id(placement.facingTargetId, `${label}.facingTargetId`);
      const target = targets.get(placement.facingTargetId);
      if (!target || target.raw.roomId !== placement.roomId)
        fail(`${label}.facingTargetId`, "does not resolve in its room");
      const dx = target.position[0] - position[0],
        dz = target.position[2] - position[2],
        usesCanonicalLocalNegativeZ =
          (plan.revision >= 2 && placement.archetypeId === "proxy/dining-chair") ||
          (plan.revision >= 3 && placement.archetypeId === "proxy/hearth-settle"),
        desired =
          usesCanonicalLocalNegativeZ
            ? Math.atan2(-dx, -dz)
            : Math.atan2(dx, -dz);
      if (Math.abs(signedAngleDelta(yaw, desired)) > Math.PI / 4)
        fail(label, "does not face its target within 45 degrees");
    }
    const footprint = object(placement.footprint, `${label}.footprint`);
    exact(footprint, ["localCenter", "halfExtents"], `${label}.footprint`);
    const localCenter = vec2(
        footprint.localCenter,
        `${label}.footprint.localCenter`,
      ),
      half = vec2(
        footprint.halfExtents,
        `${label}.footprint.halfExtents`,
        true,
      );
    if (
      half[0] * 2 + 1e-6 < archetype.dimensions[0] ||
      half[1] * 2 + 1e-6 < archetype.dimensions[2]
    )
      fail(`${label}.footprint`, "must contain the proxy archetype dimensions");
    const c = Math.cos(yaw),
      s = Math.sin(yaw),
      obb = {
        center: [
          position[0] + c * localCenter[0] + s * localCenter[1],
          position[2] - s * localCenter[0] + c * localCenter[1],
        ],
        half,
        yaw,
        floorY: position[1],
        height: archetype.dimensions[1],
      };
    if (
      !obbInsideBox(obb, room.bounds) ||
      !obbInsideBox(obb, zone.bounds) ||
      !obbInRoomFloor(room, obb)
    )
      fail(
        `${label}.footprint`,
        "rotated envelope must fit its zone and one usable floor region",
      );
    placements.set(placement.id, {
      raw: placement,
      room,
      zone,
      archetype,
      obb,
      position,
    });
  }
  const placementList = [...placements.values()];
  for (let left = 0; left < placementList.length; left++)
    for (let right = left + 1; right < placementList.length; right++)
      if (
        placementList[left].raw.roomId === placementList[right].raw.roomId &&
        obbOverlap(placementList[left].obb, placementList[right].obb)
      )
        fail(
          "plan.placements",
          `rotated envelopes overlap: ${placementList[left].raw.id} and ${placementList[right].raw.id}`,
        );

  const clearances = [],
    fulfilled = new Map([...placements].map(([key]) => [key, new Set()]));
  for (const [index, raw] of array(
    plan.interactionClearances,
    "plan.interactionClearances",
    BUILDING_INTERIOR_PLAN_V2_LIMITS.clearances,
  ).entries()) {
    const label = `plan.interactionClearances[${index}]`,
      clearance = object(raw, label);
    exact(
      clearance,
      ["id", "kind", "placementId", "roomId", "center", "radiusM", "heightM"],
      label,
    );
    id(clearance.id, `${label}.id`);
    if (clearances.some((entry) => entry.raw.id === clearance.id))
      fail(`${label}.id`, "is duplicated");
    if (!CLEARANCE_KINDS.has(clearance.kind))
      fail(`${label}.kind`, "is unsupported");
    id(clearance.placementId, `${label}.placementId`);
    id(clearance.roomId, `${label}.roomId`);
    const placement = placements.get(clearance.placementId),
      room = rooms.get(clearance.roomId),
      center = vec3(clearance.center, `${label}.center`),
      radius = positive(clearance.radiusM, `${label}.radiusM`),
      height = positive(clearance.heightM, `${label}.heightM`);
    if (
      !placement ||
      !room ||
      placement.raw.roomId !== clearance.roomId ||
      !containsPoint(room.bounds, center) ||
      !circleInRoomFloor(room, center, radius) ||
      center[1] + height > room.ceilingY + 1e-8
    )
      fail(
        label,
        "must resolve and fit one usable floor region in its placement room",
      );
    const floor =
      clearance.kind === "approach"
        ? policy.approachRadiusMinM
        : policy.occupancyRadiusMinM;
    if (radius < floor) fail(`${label}.radiusM`, `must be at least ${floor}`);
    for (const other of placementList)
      if (
        other.raw.id !== placement.raw.id &&
        other.raw.roomId === clearance.roomId &&
        circleHitsObb(center, radius, other.obb)
      )
        fail(label, `intersects placement ${other.raw.id}`);
    fulfilled.get(clearance.placementId).add(clearance.kind);
    clearances.push({ raw: clearance, center, radius, height });
  }
  for (const [placementId, placement] of placements) {
    const kinds = fulfilled.get(placementId);
    if (placement.archetype.raw.requiresApproach && !kinds.has("approach"))
      fail(`plan.placements.${placementId}`, "requires an approach clearance");
    if (placement.archetype.raw.requiresOccupancy && !kinds.has("occupancy"))
      fail(`plan.placements.${placementId}`, "requires an occupancy clearance");
  }

  const hearths = [];
  for (const [index, raw] of array(
    plan.hearthExclusions,
    "plan.hearthExclusions",
    BUILDING_INTERIOR_PLAN_V2_LIMITS.hearths,
    false,
  ).entries()) {
    const label = `plan.hearthExclusions[${index}]`,
      hearth = object(raw, label);
    exact(
      hearth,
      [
        "id",
        "roomId",
        "hearthId",
        "center",
        "halfExtents",
        "yawRadians",
        "minimumClearanceM",
        "heightM",
      ],
      label,
    );
    id(hearth.id, `${label}.id`);
    id(hearth.roomId, `${label}.roomId`);
    id(hearth.hearthId, `${label}.hearthId`);
    const room = rooms.get(hearth.roomId),
      center = vec3(hearth.center, `${label}.center`),
      half = vec2(hearth.halfExtents, `${label}.halfExtents`, true),
      yaw = finite(hearth.yawRadians, `${label}.yawRadians`),
      minimum = positive(
        hearth.minimumClearanceM,
        `${label}.minimumClearanceM`,
      ),
      height = positive(hearth.heightM, `${label}.heightM`);
    if (minimum < policy.hearthClearanceMinM)
      fail(
        `${label}.minimumClearanceM`,
        `must be at least ${policy.hearthClearanceMinM}`,
      );
    const c = Math.cos(yaw),
      s = Math.sin(yaw),
      frontOffset = half[1] + minimum / 2,
      obb = {
        center: [center[0] + s * frontOffset, center[2] + c * frontOffset],
        half: [half[0] + minimum, minimum / 2],
        yaw,
        floorY: center[1],
        height,
      };
    if (
      !room ||
      !obbInRoomFloor(room, obb) ||
      center[1] < room.floorY - 0.1 ||
      center[1] + height > room.ceilingY + 1e-8
    )
      fail(
        label,
        "front clearance must fit usable floor even when masonry is embedded outside it",
      );
    for (const placement of placementList)
      if (
        placement.raw.roomId === hearth.roomId &&
        obbOverlap(obb, placement.obb)
      )
        fail(label, `intersects placement ${placement.raw.id}`);
    for (const clearance of clearances)
      if (
        clearance.raw.roomId === hearth.roomId &&
        circleHitsObb(clearance.center, clearance.radius, obb)
      )
        fail(label, `intersects interaction clearance ${clearance.raw.id}`);
    hearths.push({ raw: hearth, obb });
  }
  unique(
    hearths.map((entry) => entry.raw.id),
    "plan.hearthExclusions ids",
  );

  const doors = [];
  for (const [index, raw] of array(
    plan.doorSweeps,
    "plan.doorSweeps",
    BUILDING_INTERIOR_PLAN_V2_LIMITS.doors,
    false,
  ).entries()) {
    const label = `plan.doorSweeps[${index}]`,
      door = object(raw, label);
    exact(
      door,
      [
        "id",
        "roomId",
        "doorId",
        "hinge",
        "radiusM",
        "leafThicknessM",
        "heightM",
        "closedYawRadians",
        "openYawRadians",
      ],
      label,
    );
    id(door.id, `${label}.id`);
    id(door.roomId, `${label}.roomId`);
    id(door.doorId, `${label}.doorId`);
    const room = rooms.get(door.roomId),
      hinge = vec3(door.hinge, `${label}.hinge`),
      radius = positive(door.radiusM, `${label}.radiusM`),
      leafThickness = positive(door.leafThicknessM, `${label}.leafThicknessM`),
      height = positive(door.heightM, `${label}.heightM`),
      closed = finite(door.closedYawRadians, `${label}.closedYawRadians`),
      open = finite(door.openYawRadians, `${label}.openYawRadians`);
    if (
      !room ||
      hinge[1] < room.floorY - 0.25 ||
      hinge[1] + height > room.ceilingY + 0.1
    )
      fail(label, "must have a human-scale vertical fit at its room boundary");
    if (Math.abs(signedAngleDelta(closed, open)) < policy.doorOpeningMinRadians)
      fail(label, "does not meet the minimum derived arc opening");
    const record = {
      raw: door,
      hinge,
      radius,
      leafThickness,
      height,
      closed,
      open,
    };
    if (!doorArcRelevantToRoom(record, room))
      fail(label, "derived arc does not enter a usable floor region");
    for (const placement of placementList)
      if (
        placement.raw.roomId === door.roomId &&
        doorArcHitsCircle(
          record,
          [
            placement.obb.center[0],
            placement.obb.floorY,
            placement.obb.center[1],
          ],
          Math.hypot(...placement.obb.half),
        )
      )
        fail(label, `derived sweep intersects placement ${placement.raw.id}`);
    for (const clearance of clearances)
      if (
        clearance.raw.roomId === door.roomId &&
        doorArcHitsCircle(record, clearance.center, clearance.radius)
      )
        fail(
          label,
          `derived sweep intersects interaction clearance ${clearance.raw.id}`,
        );
    doors.push(record);
  }
  unique(
    doors.map((entry) => entry.raw.id),
    "plan.doorSweeps ids",
  );

  const navigation = object(plan.navigation, "plan.navigation");
  exact(navigation, ["entryNodeId", "nodes", "edges"], "plan.navigation");
  id(navigation.entryNodeId, "plan.navigation.entryNodeId");
  const nodes = new Map();
  for (const [index, raw] of array(
    navigation.nodes,
    "plan.navigation.nodes",
    BUILDING_INTERIOR_PLAN_V2_LIMITS.navigationNodes,
  ).entries()) {
    const label = `plan.navigation.nodes[${index}]`,
      node = object(raw, label);
    exact(node, ["id", "roomId", "zoneId", "position"], label);
    id(node.id, `${label}.id`);
    id(node.roomId, `${label}.roomId`);
    if (node.zoneId !== null) id(node.zoneId, `${label}.zoneId`);
    if (nodes.has(node.id)) fail(`${label}.id`, "is duplicated");
    const room = rooms.get(node.roomId),
      position = vec3(node.position, `${label}.position`),
      zone = node.zoneId === null ? null : zones.get(node.zoneId);
    if (
      !room ||
      !containsPoint(room.bounds, position) ||
      !pointInRoomFloor(room, position) ||
      (zone &&
        (zone.raw.roomId !== node.roomId ||
          !containsPoint(zone.bounds, position))) ||
      (node.zoneId !== null && !zone)
    )
      fail(
        label,
        "must resolve above usable floor in its room and optional zone",
      );
    nodes.set(node.id, { raw: node, position });
  }
  if (!nodes.has(navigation.entryNodeId))
    fail("plan.navigation.entryNodeId", "does not resolve");
  const adjacency = new Map([...nodes.keys()].map((key) => [key, new Set()])),
    edgeIds = [];
  for (const [index, raw] of array(
    navigation.edges,
    "plan.navigation.edges",
    BUILDING_INTERIOR_PLAN_V2_LIMITS.navigationEdges,
  ).entries()) {
    const label = `plan.navigation.edges[${index}]`,
      edge = object(raw, label);
    exact(
      edge,
      ["id", "fromNodeId", "toNodeId", "halfWidthM", "clearHeightM"],
      label,
    );
    id(edge.id, `${label}.id`);
    id(edge.fromNodeId, `${label}.fromNodeId`);
    id(edge.toNodeId, `${label}.toNodeId`);
    const from = nodes.get(edge.fromNodeId),
      to = nodes.get(edge.toNodeId);
    if (!from || !to || from.raw.roomId !== to.raw.roomId || from === to)
      fail(label, "must connect distinct nodes in one room");
    const room = rooms.get(from.raw.roomId),
      width = positive(edge.halfWidthM, `${label}.halfWidthM`),
      clearHeight = positive(edge.clearHeightM, `${label}.clearHeightM`);
    if (
      width < policy.corridorHalfWidthMinM ||
      clearHeight < policy.clearHeightMinM
    )
      fail(label, "does not meet navigation policy minima");
    if (!corridorInsideRoomFloor(room, from.position, to.position, width))
      fail(
        label,
        "full corridor width must remain inside the connected usable-floor union",
      );
    for (const placement of placementList)
      if (
        placement.raw.roomId === from.raw.roomId &&
        placement.obb.floorY < from.position[1] + clearHeight &&
        segmentHitsObb(from.position, to.position, placement.obb, width)
      )
        fail(label, `intersects placement ${placement.raw.id}`);
    for (const clearance of clearances)
      if (
        clearance.raw.roomId === from.raw.roomId &&
        pointSegmentDistance(clearance.center, from.position, to.position) <
          width + clearance.radius - 1e-8
      )
        fail(label, `intersects interaction clearance ${clearance.raw.id}`);
    for (const hearth of hearths)
      if (
        hearth.raw.roomId === from.raw.roomId &&
        segmentHitsObb(from.position, to.position, hearth.obb, width)
      )
        fail(label, `intersects hearth ${hearth.raw.id}`);
    adjacency.get(edge.fromNodeId).add(edge.toNodeId);
    adjacency.get(edge.toNodeId).add(edge.fromNodeId);
    edgeIds.push(edge.id);
  }
  unique(edgeIds, "plan.navigation.edges ids");
  const reached = new Set([navigation.entryNodeId]),
    queue = [navigation.entryNodeId];
  while (queue.length)
    for (const next of adjacency.get(queue.shift()))
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
  if (reached.size !== nodes.size)
    fail("plan.navigation", "must form one connected topology");
  for (const zoneId of requiredZoneIds)
    if (![...reached].some((nodeId) => nodes.get(nodeId).raw.zoneId === zoneId))
      fail("plan.navigation", `required zone ${zoneId} is unreachable`);

  const sightlines = new Map();
  for (const [index, raw] of array(
    plan.sightlines,
    "plan.sightlines",
    BUILDING_INTERIOR_PLAN_V2_LIMITS.sightlines,
  ).entries()) {
    const label = `plan.sightlines[${index}]`,
      sightline = object(raw, label);
    exact(
      sightline,
      ["id", "roomId", "cameraAnchorId", "targetAnchorId"],
      label,
    );
    id(sightline.id, `${label}.id`);
    id(sightline.roomId, `${label}.roomId`);
    id(sightline.cameraAnchorId, `${label}.cameraAnchorId`);
    id(sightline.targetAnchorId, `${label}.targetAnchorId`);
    const camera = anchors.get(sightline.cameraAnchorId),
      target = anchors.get(sightline.targetAnchorId),
      room = rooms.get(sightline.roomId);
    if (sightlines.has(sightline.id)) fail(`${label}.id`, "is duplicated");
    if (
      !camera ||
      camera.raw.kind !== "camera" ||
      !target ||
      camera.raw.roomId !== sightline.roomId ||
      target.raw.roomId !== sightline.roomId ||
      sightline.cameraAnchorId === sightline.targetAnchorId ||
      !segmentInsideRoomFloor(room, camera.position, target.position)
    )
      fail(
        label,
        "must bind distinct anchors through the usable-floor union in one room",
      );
    sightlines.set(sightline.id, { raw: sightline, camera, target });
  }
  const constraints = [];
  for (const [index, raw] of array(
    plan.occlusionConstraints,
    "plan.occlusionConstraints",
    BUILDING_INTERIOR_PLAN_V2_LIMITS.occlusionConstraints,
  ).entries()) {
    const label = `plan.occlusionConstraints[${index}]`,
      constraint = object(raw, label);
    exact(
      constraint,
      ["id", "sightlineId", "clearRadiusM", "maximumOccluderHeightM"],
      label,
    );
    id(constraint.id, `${label}.id`);
    id(constraint.sightlineId, `${label}.sightlineId`);
    const sightline = sightlines.get(constraint.sightlineId),
      radius = positive(constraint.clearRadiusM, `${label}.clearRadiusM`),
      maximumHeight = positive(
        constraint.maximumOccluderHeightM,
        `${label}.maximumOccluderHeightM`,
      );
    if (!sightline) fail(`${label}.sightlineId`, "does not resolve");
    for (const placement of placementList)
      if (
        placement.raw.roomId === sightline.raw.roomId &&
        placement.obb.height > maximumHeight &&
        segmentHitsObb(
          sightline.camera.position,
          sightline.target.position,
          placement.obb,
          radius,
        )
      )
        fail(label, `is occluded by placement ${placement.raw.id}`);
    constraints.push(constraint);
  }
  unique(
    constraints.map((entry) => entry.id),
    "plan.occlusionConstraints ids",
  );
  return Object.freeze(plan);
}

export function buildingInteriorPlanV2CanonicalText(value) {
  return canonicalCompilerJson(validateBuildingInteriorPlanV2(value), {
    maxBytes: 2 * 1024 * 1024,
    maxDepth: 40,
    maxNodes: 200_000,
    maxProperties: 64,
    maxArrayLength: 4096,
  });
}
export function buildingInteriorPlanV2Hash(value) {
  return `sha256:${sha256(buildingInteriorPlanV2CanonicalText(value))}`;
}
