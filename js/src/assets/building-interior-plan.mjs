import { canonicalCompilerJson } from "../world/compiler/canonical.mjs";
import { sha256 } from "../world/sha256.mjs";

export const BUILDING_INTERIOR_PLAN_SCHEMA = "limina.building-interior-plan/v1";
export const BUILDING_INTERIOR_PLAN_LIMITS = Object.freeze({
  rooms: 32, zones: 128, targets: 256, placements: 256, clearances: 1024,
  corridors: 128, doorSweeps: 64, hearthClearances: 64,
});

const ID = /^[a-z0-9][a-z0-9._/-]{0,159}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const CATALOG_KINDS = new Set(["furniture-pack", "prop-pack"]);
const TARGET_KINDS = new Set(["support", "facing"]);
const CLEARANCE_KINDS = new Set(["approach", "occupancy"]);

function fail(label, message) { throw new Error(`building interior plan: ${label} ${message}`); }
function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(label, "must be an object");
  return value;
}
function exact(value, keys, label) {
  const expected = new Set(keys), actual = Object.keys(value);
  for (const key of keys) if (!(key in value)) fail(`${label}.${key}`, "is required");
  for (const key of actual) if (!expected.has(key)) fail(`${label}.${key}`, "is unsupported");
}
function id(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail(label, "must be a stable lowercase id");
  return value;
}
function hash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) fail(label, "must be a lowercase sha256 hash");
  return value;
}
function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(label, "must be finite");
  if (Math.abs(value) > 1_000_000) fail(label, "exceeds the bounded numeric domain");
  return value;
}
function positive(value, label) {
  finite(value, label); if (value <= 0) fail(label, "must be positive"); return value;
}
function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(label, "must be a positive safe integer"); return value;
}
function vec3(value, label, axesPositive = false) {
  if (!Array.isArray(value) || value.length !== 3) fail(label, "must be a finite vec3");
  const result = value.map((entry, axis) => finite(entry, `${label}[${axis}]`));
  if (axesPositive && result.some((entry) => entry <= 0)) fail(label, "axes must be positive");
  return result;
}
function boundedArray(value, label, maximum, nonempty = true) {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) fail(label, nonempty ? "must be non-empty" : "must be an array");
  if (value.length > maximum) fail(label, `exceeds ${maximum} entries`);
  return value;
}
function unique(values, label) {
  if (new Set(values).size !== values.length) fail(label, "must be unique");
}
function bounds(value, label) {
  const box = object(value, label); exact(box, ["center", "halfExtents"], label);
  return { center: vec3(box.center, `${label}.center`), halfExtents: vec3(box.halfExtents, `${label}.halfExtents`, true) };
}
function min(box, axis) { return box.center[axis] - box.halfExtents[axis]; }
function max(box, axis) { return box.center[axis] + box.halfExtents[axis]; }
function contains(outer, inner, epsilon = 1e-9) {
  return [0, 1, 2].every((axis) => min(inner, axis) >= min(outer, axis) - epsilon && max(inner, axis) <= max(outer, axis) + epsilon);
}
function containsPoint(box, point, epsilon = 1e-9) {
  return [0, 1, 2].every((axis) => point[axis] >= min(box, axis) - epsilon && point[axis] <= max(box, axis) + epsilon);
}
function overlaps(a, b, epsilon = 1e-9) {
  return [0, 1, 2].every((axis) => min(a, axis) < max(b, axis) - epsilon && max(a, axis) > min(b, axis) + epsilon);
}
function cylinderBounds(clearance) {
  return { center: clearance.center, halfExtents: [clearance.radiusM, clearance.halfHeightM, clearance.radiusM] };
}
function segmentIntersectsExpandedBox2d(from, to, box, expansion) {
  let enter = 0, exit = 1;
  for (const axis of [0, 2]) {
    const low = min(box, axis) - expansion, high = max(box, axis) + expansion, delta = to[axis] - from[axis];
    if (Math.abs(delta) < 1e-12) { if (from[axis] < low || from[axis] > high) return false; continue; }
    const a = (low - from[axis]) / delta, b = (high - from[axis]) / delta;
    enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
    if (enter > exit) return false;
  }
  return true;
}
function approvedReference(value, label, expectedKind) {
  const ref = object(value, label);
  exact(ref, ["artifactId", "kind", "revision", "status", "contractHash", "contentHash", "approvalDecisionId", "approvalDecisionHash"], label);
  id(ref.artifactId, `${label}.artifactId`); id(ref.approvalDecisionId, `${label}.approvalDecisionId`);
  if (ref.kind !== expectedKind && !(expectedKind === "catalog" && CATALOG_KINDS.has(ref.kind))) fail(`${label}.kind`, "is unsupported");
  integer(ref.revision, `${label}.revision`);
  if (ref.status !== "approved") fail(`${label}.status`, "must be approved");
  hash(ref.contractHash, `${label}.contractHash`); hash(ref.contentHash, `${label}.contentHash`); hash(ref.approvalDecisionHash, `${label}.approvalDecisionHash`);
  return ref;
}

export function validateBuildingInteriorPlan(value) {
  const plan = object(value, "plan");
  exact(plan, ["schema", "planId", "revision", "supersedes", "units", "shell", "rooms", "zones", "targets", "placements", "clearances", "circulationCorridors", "doorSweeps", "hearthClearances"], "plan");
  if (plan.schema !== BUILDING_INTERIOR_PLAN_SCHEMA) fail("plan.schema", "is unsupported");
  id(plan.planId, "plan.planId"); integer(plan.revision, "plan.revision");
  if (plan.supersedes !== null) id(plan.supersedes, "plan.supersedes");
  if (plan.revision === 1 && plan.supersedes !== null) fail("plan.supersedes", "must be null for revision 1");
  if (plan.revision > 1 && plan.supersedes === null) fail("plan.supersedes", "must identify the prior revision");
  if (plan.supersedes === plan.planId) fail("plan.supersedes", "must not identify the current plan");
  if (plan.units !== "meter") fail("plan.units", "must be meter");
  approvedReference(plan.shell, "plan.shell", "shell");

  const rooms = new Map();
  for (const [index, raw] of boundedArray(plan.rooms, "plan.rooms", BUILDING_INTERIOR_PLAN_LIMITS.rooms).entries()) {
    const label = `plan.rooms[${index}]`, room = object(raw, label); exact(room, ["id", "bounds", "finishedFloorY", "ceilingY"], label);
    id(room.id, `${label}.id`); if (rooms.has(room.id)) fail(`${label}.id`, "is duplicated");
    const roomBounds = bounds(room.bounds, `${label}.bounds`), floor = finite(room.finishedFloorY, `${label}.finishedFloorY`), ceiling = finite(room.ceilingY, `${label}.ceilingY`);
    if (ceiling <= floor) fail(`${label}.ceilingY`, "must be above finishedFloorY");
    if (floor < min(roomBounds, 1) - 1e-9 || ceiling > max(roomBounds, 1) + 1e-9) fail(label, "floor/ceiling must lie inside room bounds");
    rooms.set(room.id, { raw: room, bounds: roomBounds, floor, ceiling });
  }

  const zones = new Map();
  for (const [index, raw] of boundedArray(plan.zones, "plan.zones", BUILDING_INTERIOR_PLAN_LIMITS.zones).entries()) {
    const label = `plan.zones[${index}]`, zone = object(raw, label); exact(zone, ["id", "kind", "roomId", "bounds"], label);
    id(zone.id, `${label}.id`); id(zone.kind, `${label}.kind`); id(zone.roomId, `${label}.roomId`); if (zones.has(zone.id)) fail(`${label}.id`, "is duplicated");
    const room = rooms.get(zone.roomId); if (!room) fail(`${label}.roomId`, "does not resolve");
    const zoneBounds = bounds(zone.bounds, `${label}.bounds`); if (!contains(room.bounds, zoneBounds)) fail(`${label}.bounds`, "must be contained by its room");
    zones.set(zone.id, { raw: zone, bounds: zoneBounds });
  }

  const targets = new Map();
  for (const [index, raw] of boundedArray(plan.targets, "plan.targets", BUILDING_INTERIOR_PLAN_LIMITS.targets).entries()) {
    const label = `plan.targets[${index}]`, target = object(raw, label); exact(target, ["id", "kind", "roomId", "position", "normal"], label);
    id(target.id, `${label}.id`); if (!TARGET_KINDS.has(target.kind)) fail(`${label}.kind`, "is unsupported"); id(target.roomId, `${label}.roomId`); if (targets.has(target.id)) fail(`${label}.id`, "is duplicated");
    const room = rooms.get(target.roomId); if (!room) fail(`${label}.roomId`, "does not resolve");
    const position = vec3(target.position, `${label}.position`), normal = vec3(target.normal, `${label}.normal`), length = Math.hypot(...normal);
    if (!containsPoint(room.bounds, position)) fail(`${label}.position`, "must be inside its room");
    if (Math.abs(length - 1) > 1e-6) fail(`${label}.normal`, "must be unit length");
    if (target.kind === "support" && normal[1] < 0.9) fail(`${label}.normal`, "must face upward for a support target");
    targets.set(target.id, { raw: target, position, normal });
  }

  const placements = new Map(), catalogReferences = new Map();
  for (const [index, raw] of boundedArray(plan.placements, "plan.placements", BUILDING_INTERIOR_PLAN_LIMITS.placements).entries()) {
    const label = `plan.placements[${index}]`, placement = object(raw, label);
    exact(placement, ["id", "roomId", "zoneId", "catalog", "transform", "envelope", "support", "facing", "requiredSockets"], label);
    id(placement.id, `${label}.id`); id(placement.roomId, `${label}.roomId`); id(placement.zoneId, `${label}.zoneId`); if (placements.has(placement.id)) fail(`${label}.id`, "is duplicated");
    const room = rooms.get(placement.roomId), zone = zones.get(placement.zoneId); if (!room) fail(`${label}.roomId`, "does not resolve"); if (!zone || zone.raw.roomId !== placement.roomId) fail(`${label}.zoneId`, "does not resolve in the placement room");
    const catalog = approvedReference(placement.catalog, `${label}.catalog`, "catalog"), catalogKey = `${catalog.artifactId}@${catalog.revision}`;
    const catalogIdentity = `${catalog.kind}\0${catalog.contractHash}\0${catalog.contentHash}\0${catalog.approvalDecisionId}\0${catalog.approvalDecisionHash}`;
    if (catalogReferences.has(catalogKey) && catalogReferences.get(catalogKey) !== catalogIdentity) fail(`${label}.catalog`, "conflicts with another reference to the same artifact revision");
    catalogReferences.set(catalogKey, catalogIdentity);
    const transform = object(placement.transform, `${label}.transform`); exact(transform, ["position", "yawRadians", "scale"], `${label}.transform`);
    const position = vec3(transform.position, `${label}.transform.position`), yaw = finite(transform.yawRadians, `${label}.transform.yawRadians`), scale = vec3(transform.scale, `${label}.transform.scale`, true);
    if (Math.abs(yaw) > Math.PI * 2) fail(`${label}.transform.yawRadians`, "must be within one signed revolution");
    if (scale.some((axis) => Math.abs(axis - 1) > 1e-9)) fail(`${label}.transform.scale`, "must remain [1,1,1] for an approved catalog artifact");
    const envelope = bounds(placement.envelope, `${label}.envelope`); if (!contains(room.bounds, envelope) || !contains(zone.bounds, envelope)) fail(`${label}.envelope`, "must be contained by its room and zone");
    if (!containsPoint(envelope, position)) fail(`${label}.transform.position`, "must lie inside the resolved envelope");
    const support = object(placement.support, `${label}.support`); exact(support, ["targetId", "contactY", "toleranceM"], `${label}.support`); id(support.targetId, `${label}.support.targetId`);
    const supportTarget = targets.get(support.targetId); if (!supportTarget || supportTarget.raw.kind !== "support" || supportTarget.raw.roomId !== placement.roomId) fail(`${label}.support.targetId`, "does not resolve to a support target in the placement room");
    const contactY = finite(support.contactY, `${label}.support.contactY`), tolerance = positive(support.toleranceM, `${label}.support.toleranceM`); if (tolerance > 0.05) fail(`${label}.support.toleranceM`, "must not exceed 0.05 m");
    if (Math.abs(contactY - min(envelope, 1)) > tolerance || Math.abs(contactY - supportTarget.position[1]) > tolerance) fail(`${label}.support.contactY`, "does not bind the envelope to its support target");
    const facing = object(placement.facing, `${label}.facing`); exact(facing, ["targetId", "forwardLocal", "maxAngularErrorDeg"], `${label}.facing`); id(facing.targetId, `${label}.facing.targetId`);
    const facingTarget = targets.get(facing.targetId); if (!facingTarget || facingTarget.raw.kind !== "facing" || facingTarget.raw.roomId !== placement.roomId) fail(`${label}.facing.targetId`, "does not resolve to a facing target in the placement room");
    const forward = vec3(facing.forwardLocal, `${label}.facing.forwardLocal`), horizontalLength = Math.hypot(forward[0], forward[2]);
    if (Math.abs(horizontalLength - 1) > 1e-6 || Math.abs(forward[1]) > 1e-6) fail(`${label}.facing.forwardLocal`, "must be a horizontal unit vector");
    const maxError = positive(facing.maxAngularErrorDeg, `${label}.facing.maxAngularErrorDeg`); if (maxError > 45) fail(`${label}.facing.maxAngularErrorDeg`, "must not exceed 45 degrees");
    const c = Math.cos(yaw), s = Math.sin(yaw), worldForward = [c * forward[0] + s * forward[2], -s * forward[0] + c * forward[2]], dx = facingTarget.position[0] - position[0], dz = facingTarget.position[2] - position[2], distance = Math.hypot(dx, dz);
    if (distance < 1e-6) fail(`${label}.facing.targetId`, "must be horizontally distinct from the placement");
    const dot = Math.max(-1, Math.min(1, (worldForward[0] * dx + worldForward[1] * dz) / distance)), error = Math.acos(dot) * 180 / Math.PI;
    if (error > maxError + 1e-6) fail(`${label}.facing`, `misses its target by ${error.toFixed(3)} degrees`);
    const required = object(placement.requiredSockets, `${label}.requiredSockets`); exact(required, ["approach", "occupancy"], `${label}.requiredSockets`);
    const socketIds = {};
    for (const kind of CLEARANCE_KINDS) { const list = boundedArray(required[kind], `${label}.requiredSockets.${kind}`, 64, false); list.forEach((entry, socketIndex) => id(entry, `${label}.requiredSockets.${kind}[${socketIndex}]`)); unique(list, `${label}.requiredSockets.${kind}`); socketIds[kind] = new Set(list); }
    placements.set(placement.id, { raw: placement, room, zone, envelope, position, socketIds });
  }
  const placementList = [...placements.values()];
  for (let left = 0; left < placementList.length; left++) for (let right = left + 1; right < placementList.length; right++) if (overlaps(placementList[left].envelope, placementList[right].envelope)) fail("plan.placements", `envelopes overlap: ${placementList[left].raw.id} and ${placementList[right].raw.id}`);

  const clearanceKeys = [], clearanceVolumes = [], fulfilled = new Map([...placements].map(([placementId, placement]) => [placementId, { approach: new Set(), occupancy: new Set(), placement }]));
  for (const [index, raw] of boundedArray(plan.clearances, "plan.clearances", BUILDING_INTERIOR_PLAN_LIMITS.clearances).entries()) {
    const label = `plan.clearances[${index}]`, clearance = object(raw, label); exact(clearance, ["id", "kind", "placementId", "socketId", "roomId", "center", "radiusM", "halfHeightM"], label);
    id(clearance.id, `${label}.id`); if (clearanceKeys.includes(clearance.id)) fail(`${label}.id`, "is duplicated"); clearanceKeys.push(clearance.id);
    if (!CLEARANCE_KINDS.has(clearance.kind)) fail(`${label}.kind`, "is unsupported"); id(clearance.placementId, `${label}.placementId`); id(clearance.socketId, `${label}.socketId`); id(clearance.roomId, `${label}.roomId`);
    const placement = placements.get(clearance.placementId), room = rooms.get(clearance.roomId); if (!placement || placement.raw.roomId !== clearance.roomId || !room) fail(`${label}.placementId`, "does not resolve in the clearance room");
    if (!placement.socketIds[clearance.kind].has(clearance.socketId)) fail(`${label}.socketId`, "is not required by its placement and kind");
    const center = vec3(clearance.center, `${label}.center`), record = { raw: clearance, center, radiusM: positive(clearance.radiusM, `${label}.radiusM`), halfHeightM: positive(clearance.halfHeightM, `${label}.halfHeightM`) };
    const box = cylinderBounds(record); if (!contains(room.bounds, box)) fail(label, "must be contained by its room");
    for (const other of placementList) if (other.raw.id !== clearance.placementId && overlaps(box, other.envelope)) fail(label, `overlaps placement ${other.raw.id}`);
    const used = fulfilled.get(clearance.placementId)[clearance.kind]; if (used.has(clearance.socketId)) fail(`${label}.socketId`, "has more than one clearance"); used.add(clearance.socketId);
    clearanceVolumes.push({ id: clearance.id, roomId: clearance.roomId, box });
  }
  for (const [placementId, record] of fulfilled) for (const kind of CLEARANCE_KINDS) {
    const required = record.placement.socketIds[kind], actual = record[kind];
    if (required.size !== actual.size || [...required].some((socketId) => !actual.has(socketId))) fail(`plan.placements.${placementId}.requiredSockets.${kind}`, "does not have an exact clearance set");
  }

  const corridors = [];
  for (const [index, raw] of boundedArray(plan.circulationCorridors, "plan.circulationCorridors", BUILDING_INTERIOR_PLAN_LIMITS.corridors).entries()) {
    const label = `plan.circulationCorridors[${index}]`, corridor = object(raw, label); exact(corridor, ["id", "roomId", "from", "to", "halfWidthM", "minClearHeightM"], label);
    id(corridor.id, `${label}.id`); id(corridor.roomId, `${label}.roomId`); const room = rooms.get(corridor.roomId); if (!room) fail(`${label}.roomId`, "does not resolve");
    const from = vec3(corridor.from, `${label}.from`), to = vec3(corridor.to, `${label}.to`), halfWidth = positive(corridor.halfWidthM, `${label}.halfWidthM`), clearHeight = positive(corridor.minClearHeightM, `${label}.minClearHeightM`);
    if (Math.hypot(to[0] - from[0], to[2] - from[2]) < 0.1 || Math.abs(to[1] - from[1]) > 1e-6) fail(label, "must be a non-degenerate horizontal corridor");
    const corridorBounds = { center: [(from[0] + to[0]) / 2, from[1] + clearHeight / 2, (from[2] + to[2]) / 2], halfExtents: [Math.abs(to[0] - from[0]) / 2 + halfWidth, clearHeight / 2, Math.abs(to[2] - from[2]) / 2 + halfWidth] };
    if (!contains(room.bounds, corridorBounds)) fail(label, "must be contained by its room");
    for (const placement of placementList) if (placement.raw.roomId === corridor.roomId && min(placement.envelope, 1) < from[1] + clearHeight && max(placement.envelope, 1) > from[1] && segmentIntersectsExpandedBox2d(from, to, placement.envelope, halfWidth)) fail(label, `intersects placement ${placement.raw.id}`);
    corridors.push({ id: corridor.id, roomId: corridor.roomId, bounds: corridorBounds });
  }
  unique(corridors.map((entry) => entry.id), "plan.circulationCorridors ids");

  const exclusionVolumes = [];
  for (const [collectionName, maximum, kind] of [["doorSweeps", BUILDING_INTERIOR_PLAN_LIMITS.doorSweeps, "door"], ["hearthClearances", BUILDING_INTERIOR_PLAN_LIMITS.hearthClearances, "hearth"]]) {
    const values = boundedArray(plan[collectionName], `plan.${collectionName}`, maximum);
    for (const [index, raw] of values.entries()) {
      const label = `plan.${collectionName}[${index}]`, volume = object(raw, label);
      if (kind === "door") exact(volume, ["id", "roomId", "doorId", "hinge", "closedYawRadians", "openYawRadians", "radiusM", "heightM", "clearanceBounds"], label);
      else exact(volume, ["id", "roomId", "hearthId", "minimumClearanceM", "clearanceBounds"], label);
      id(volume.id, `${label}.id`); id(volume.roomId, `${label}.roomId`); const room = rooms.get(volume.roomId); if (!room) fail(`${label}.roomId`, "does not resolve");
      const box = bounds(volume.clearanceBounds, `${label}.clearanceBounds`); if (!contains(room.bounds, box)) fail(`${label}.clearanceBounds`, "must be contained by its room");
      if (kind === "door") {
        id(volume.doorId, `${label}.doorId`); const hinge = vec3(volume.hinge, `${label}.hinge`), closed = finite(volume.closedYawRadians, `${label}.closedYawRadians`), open = finite(volume.openYawRadians, `${label}.openYawRadians`), radius = positive(volume.radiusM, `${label}.radiusM`), height = positive(volume.heightM, `${label}.heightM`);
        if (Math.abs(closed) > Math.PI * 2 || Math.abs(open) > Math.PI * 2) fail(label, "door angles must be within one signed revolution");
        if (Math.abs(open - closed) < 0.5) fail(label, "must describe a useful door sweep"); if (!containsPoint(box, hinge)) fail(`${label}.hinge`, "must lie inside clearanceBounds"); if (box.halfExtents[0] > radius + 1e-6 || box.halfExtents[2] > radius + 1e-6 || box.halfExtents[1] * 2 + 1e-6 < height) fail(`${label}.clearanceBounds`, "is inconsistent with door radius/height");
      } else { id(volume.hearthId, `${label}.hearthId`); positive(volume.minimumClearanceM, `${label}.minimumClearanceM`); }
      for (const placement of placementList) if (placement.raw.roomId === volume.roomId && overlaps(box, placement.envelope)) fail(label, `intersects placement ${placement.raw.id}`);
      for (const clearance of clearanceVolumes) if (clearance.roomId === volume.roomId && overlaps(box, clearance.box)) fail(label, `intersects interaction clearance ${clearance.id}`);
      exclusionVolumes.push({ collectionName, id: volume.id });
    }
  }
  unique(exclusionVolumes.map((entry) => `${entry.collectionName}/${entry.id}`), "plan exclusion volume ids");
  return Object.freeze(plan);
}

export function buildingInteriorPlanCanonicalText(value) {
  return canonicalCompilerJson(validateBuildingInteriorPlan(value), { maxBytes: 1024 * 1024, maxDepth: 32, maxNodes: 100_000, maxProperties: 64, maxArrayLength: 2048 });
}

export function buildingInteriorPlanHash(value) {
  return `sha256:${sha256(buildingInteriorPlanCanonicalText(value))}`;
}
