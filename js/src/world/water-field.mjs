// Deterministic standing-water runtime over the canonical WB-W1 WaterBody IR.
//
// Boundary policy: an outer footprint edge belongs to its basin; a hole edge belongs to the
// hole and is therefore dry with respect to that basin. Depth bands are [min,max), so an exact
// shared band boundary selects the deeper band. Interior points beyond the final maximum clamp
// to the final authored depth. Overlapping basins select the highest surface, then the
// lexicographically smallest portable id.

import { isPlainJsonData, parseAuthoredWaterBodies, WATER_LIMITS } from "./water-ir.mjs";
import { worldMapContentHash } from "./worldmap-hash.mjs";

export const MAX_WATER_FIELD_ROWS = 257;
export const MAX_WATER_FIELD_COLS = 257;
export const MAX_WATER_FIELD_SAMPLES = MAX_WATER_FIELD_ROWS * MAX_WATER_FIELD_COLS;
export const MAX_WATER_FIELD_ABS_WORLD_M = 1_000_000_000_000;
export const WATER_FIELD_BVH_LEAF_BODIES = 8;
export const MAX_WATER_FIELD_BVH_NODES = WATER_LIMITS.bodies * 2 - 1;
export const WATER_FIELD_EDGE_BVH_LEAF_SEGMENTS = 8;
export const MAX_WATER_FIELD_EDGE_BVH_NODES = WATER_LIMITS.totalBodyPoints * 4 + WATER_LIMITS.bodies * 2;

export const WATER_SAMPLE_CLASS_DRY = 0;
export const WATER_SAMPLE_CLASS_OCEAN = 1;
export const WATER_SAMPLE_CLASS_BASIN = 2;
export const WATER_SAMPLE_SUBMERGED_NO = 0;
export const WATER_SAMPLE_SUBMERGED_YES = 1;
export const WATER_SAMPLE_SUBMERGED_UNKNOWN = 255;
export const WATER_SAMPLE_RECORD_BYTES = 48;

// Per-cell row-major, little-endian layout. Missing float channels use the canonical quiet-NaN
// bit pattern 0x7ff8000000000000, never a host-provided NaN payload.
export const WATER_SAMPLE_LAYOUT = Object.freeze({
  recordBytes: WATER_SAMPLE_RECORD_BYTES,
  class: Object.freeze({ offset: 0, type: "u8", dry: WATER_SAMPLE_CLASS_DRY, ocean: WATER_SAMPLE_CLASS_OCEAN, basin: WATER_SAMPLE_CLASS_BASIN }),
  submerged: Object.freeze({ offset: 1, type: "u8", no: WATER_SAMPLE_SUBMERGED_NO, yes: WATER_SAMPLE_SUBMERGED_YES, unknown: WATER_SAMPLE_SUBMERGED_UNKNOWN }),
  flags: Object.freeze({ offset: 2, type: "u8", reservedValue: 0 }),
  reserved: Object.freeze({ offset: 3, type: "u8", value: 0 }),
  bodyIndex: Object.freeze({ offset: 4, type: "i32", none: -1 }),
  surfaceLevelM: Object.freeze({ offset: 8, type: "f64" }),
  authoredTargetDepthM: Object.freeze({ offset: 16, type: "f64" }),
  targetFloorLevelM: Object.freeze({ offset: 24, type: "f64" }),
  actualSubmergedDepthM: Object.freeze({ offset: 32, type: "f64" }),
  oceanSurfaceCandidateM: Object.freeze({ offset: 40, type: "f64" }),
});

const WORLD_MAP_ROOT_KEYS = new Set([
  "version", "id", "unitsPerMeter", "origin", "extent", "seaLevel", "land", "relief",
  "reliefGrid", "biomes", "waterways", "waterBodies", "hydrology", "routes", "anchors", "gazetteer",
  "provenance",
]);
const REQUIRED_ARRAY_KEYS = ["land", "relief", "biomes", "waterways", "routes", "anchors"];
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;
const CANONICAL_NAN_BITS = 0x7ff8000000000000n;

export class WaterFieldValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "WaterFieldValidationError";
    this.code = "water_field_invalid";
  }
}

export class WaterFieldCancelledError extends Error {
  constructor() {
    super("water field operation cancelled");
    this.name = "WaterFieldCancelledError";
    this.code = "water_field_cancelled";
  }
}

function fail(message) {
  throw new WaterFieldValidationError(message);
}

function canonicalNumber(value) {
  return Object.is(value, -0) ? 0 : value;
}

function finite(value, label, maxAbs = MAX_WATER_FIELD_ABS_WORLD_M) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > maxAbs) {
    fail(`${label} must be finite with absolute value <= ${maxAbs}`);
  }
  return canonicalNumber(value);
}

function positiveFinite(value, label) {
  const parsed = finite(value, label);
  if (!(parsed > 0)) fail(`${label} must be positive`);
  return parsed;
}

function plainRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  return value;
}

function checkpoint(shouldCancel, work) {
  if ((work & 255) === 0 && shouldCancel?.()) throw new WaterFieldCancelledError();
}

function validateWorldMapIdentity(input) {
  if (!isPlainJsonData(input)) fail("water field requires plain finite WorldMap JSON data");
  const map = plainRecord(input, "water field WorldMap");
  for (const key of Object.keys(map)) if (!WORLD_MAP_ROOT_KEYS.has(key)) fail(`water field WorldMap has unknown root field '${key}'`);
  if (map.version !== 1) fail("water field WorldMap version must be 1");
  if (typeof map.id !== "string" || map.id.length === 0) fail("water field WorldMap id must be non-empty");
  positiveFinite(map.unitsPerMeter, "water field WorldMap unitsPerMeter");
  if (!Array.isArray(map.origin) || map.origin.length !== 2) fail("water field WorldMap origin must be a 2-tuple");
  finite(map.origin[0], "water field WorldMap origin[0]");
  finite(map.origin[1], "water field WorldMap origin[1]");
  const extent = plainRecord(map.extent, "water field WorldMap extent");
  positiveFinite(extent.w, "water field WorldMap extent.w");
  positiveFinite(extent.h, "water field WorldMap extent.h");
  finite(map.seaLevel, "water field WorldMap seaLevel", WATER_LIMITS.absLevelM);
  for (const key of REQUIRED_ARRAY_KEYS) if (!Array.isArray(map[key])) fail(`water field WorldMap ${key} must be an array`);
  const provenance = plainRecord(map.provenance, "water field WorldMap provenance");
  if (!CONTENT_HASH_RE.test(provenance.contentHash)) fail("water field WorldMap provenance.contentHash must be lowercase sha256 hex");
  let actual;
  try {
    actual = worldMapContentHash(map);
  } catch (error) {
    fail(`water field WorldMap cannot be canonically hashed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (actual !== provenance.contentHash) fail(`water field WorldMap content hash mismatch: expected ${provenance.contentHash}, actual ${actual}`);
  return map;
}

function transformedPoint(point, originX, originZ, unitsPerMeter, label) {
  return Object.freeze([
    finite(originX + point[0] * unitsPerMeter, `${label}[0]`),
    finite(originZ + point[1] * unitsPerMeter, `${label}[1]`),
  ]);
}

function transformRing(ring, originX, originZ, unitsPerMeter, label, shouldCancel, work) {
  const transformed = new Array(ring.length);
  for (let index = 0; index < ring.length; index++) {
    checkpoint(shouldCancel, work.value++);
    transformed[index] = transformedPoint(ring[index], originX, originZ, unitsPerMeter, `${label}[${index}]`);
  }
  return Object.freeze(transformed);
}

function ringBounds(ring, bounds) {
  for (const point of ring) {
    if (point[0] < bounds.minX) bounds.minX = point[0];
    if (point[0] > bounds.maxX) bounds.maxX = point[0];
    if (point[1] < bounds.minZ) bounds.minZ = point[1];
    if (point[1] > bounds.maxZ) bounds.maxZ = point[1];
  }
}

function boundedRing(ring, shouldCancel, work) {
  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  ringBounds(ring, bounds);
  return Object.freeze({ ring, edgeBvh: buildEdgeBvh([ring], shouldCancel, work), ...bounds });
}

function buildEdgeBvh(rings, shouldCancel, work) {
  const segments = [];
  for (const ring of rings) {
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      checkpoint(shouldCancel, work.value++);
      const a = ring[previous], b = ring[index];
      const minX = Math.min(a[0], b[0]), maxX = Math.max(a[0], b[0]);
      const minZ = Math.min(a[1], b[1]), maxZ = Math.max(a[1], b[1]);
      segments.push(Object.freeze({
        a,
        b,
        minX,
        maxX,
        minZ,
        maxZ,
        centerX: canonicalNumber((minX + maxX) / 2),
        centerZ: canonicalNumber((minZ + maxZ) / 2),
        ordinal: segments.length,
      }));
    }
  }
  return buildEdgeBvhFromSegments(segments, shouldCancel, work);
}

function buildEdgeBvhFromSegments(segments, shouldCancel, work) {
  const order = new Int32Array(segments.length);
  for (let index = 0; index < order.length; index++) order[index] = index;
  const nodes = [null];
  const tasks = [{ start: 0, end: order.length, nodeIndex: 0 }];
  while (tasks.length > 0) {
    checkpoint(shouldCancel, work.value++);
    const task = tasks.pop();
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let position = task.start; position < task.end; position++) {
      checkpoint(shouldCancel, work.value++);
      const segment = segments[order[position]];
      if (segment.minX < minX) minX = segment.minX;
      if (segment.maxX > maxX) maxX = segment.maxX;
      if (segment.minZ < minZ) minZ = segment.minZ;
      if (segment.maxZ > maxZ) maxZ = segment.maxZ;
    }
    const count = task.end - task.start;
    if (count <= WATER_FIELD_EDGE_BVH_LEAF_SEGMENTS) {
      nodes[task.nodeIndex] = { minX, maxX, minZ, maxZ, left: -1, right: -1, start: task.start, count };
      continue;
    }
    const axis = maxX - minX >= maxZ - minZ ? 0 : 1;
    const center = axis === 0 ? "centerX" : "centerZ";
    const otherCenter = axis === 0 ? "centerZ" : "centerX";
    const slice = Array.from(order.subarray(task.start, task.end));
    slice.sort((leftIndex, rightIndex) => {
      const left = segments[leftIndex], right = segments[rightIndex];
      return left[center] - right[center] || left[otherCenter] - right[otherCenter]
        || left.minX - right.minX || left.minZ - right.minZ || left.ordinal - right.ordinal;
    });
    order.set(slice, task.start);
    const mid = task.start + Math.floor(count / 2);
    const left = nodes.length, right = left + 1;
    if (right >= MAX_WATER_FIELD_EDGE_BVH_NODES) fail(`water field edge BVH exceeds ${MAX_WATER_FIELD_EDGE_BVH_NODES} retained nodes`);
    nodes.push(null, null);
    nodes[task.nodeIndex] = { minX, maxX, minZ, maxZ, left, right, start: 0, count: 0 };
    tasks.push({ start: mid, end: task.end, nodeIndex: right });
    tasks.push({ start: task.start, end: mid, nodeIndex: left });
  }
  for (let index = 0; index < nodes.length; index++) nodes[index] = Object.freeze(nodes[index]);
  return Object.freeze({ segments: Object.freeze(segments), order, nodes: Object.freeze(nodes) });
}

function prepareBodies(parsedBodies, map, shouldCancel) {
  const bodies = new Array(parsedBodies.length);
  const work = { value: 0 };
  let edgeCount = 0;
  let edgeNodeCount = 0;
  for (let bodyIndex = 0; bodyIndex < parsedBodies.length; bodyIndex++) {
    checkpoint(shouldCancel, work.value++);
    const source = parsedBodies[bodyIndex];
    const outer = boundedRing(
      transformRing(source.footprint.points, map.origin[0], map.origin[1], map.unitsPerMeter, `waterBodies[${bodyIndex}].footprint.points`, shouldCancel, work),
      shouldCancel,
      work,
    );
    const holes = Object.freeze((source.footprint.holes ?? []).map((hole, holeIndex) => boundedRing(
      transformRing(hole, map.origin[0], map.origin[1], map.unitsPerMeter, `waterBodies[${bodyIndex}].footprint.holes[${holeIndex}]`, shouldCancel, work), shouldCancel, work)));
    const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    ringBounds(outer.ring, bounds);
    edgeCount += outer.ring.length;
    for (const hole of holes) {
      ringBounds(hole.ring, bounds);
      edgeCount += hole.ring.length;
    }
    const edgeBvh = buildEdgeBvhFromSegments([
      ...outer.edgeBvh.segments,
      ...holes.flatMap((hole) => hole.edgeBvh.segments),
    ], shouldCancel, work);
    edgeNodeCount += edgeBvh.nodes.length + outer.edgeBvh.nodes.length
      + holes.reduce((total, hole) => total + hole.edgeBvh.nodes.length, 0);
    if (edgeNodeCount > MAX_WATER_FIELD_EDGE_BVH_NODES) fail(`water field edge BVHs exceed ${MAX_WATER_FIELD_EDGE_BVH_NODES} retained nodes`);
    const zones = Object.freeze(source.depthZones.map((zone) => Object.freeze({
      minShoreDistanceM: canonicalNumber(zone.minShoreDistanceM),
      maxShoreDistanceM: canonicalNumber(zone.maxShoreDistanceM),
      depthM: canonicalNumber(zone.depthM),
    })));
    bodies[bodyIndex] = Object.freeze({
      id: source.id,
      kind: source.kind,
      level: canonicalNumber(source.level),
      outer,
      holes,
      edgeBvh,
      zones,
      minX: bounds.minX,
      maxX: bounds.maxX,
      minZ: bounds.minZ,
      maxZ: bounds.maxZ,
      centerX: canonicalNumber((bounds.minX + bounds.maxX) / 2),
      centerZ: canonicalNumber((bounds.minZ + bounds.maxZ) / 2),
    });
  }
  bodies.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return { bodies: Object.freeze(bodies), edgeCount, edgeNodeCount, transformWork: work.value };
}

function compareBodyOnAxis(bodies, axis) {
  const center = axis === 0 ? "centerX" : "centerZ";
  const otherCenter = axis === 0 ? "centerZ" : "centerX";
  return (leftIndex, rightIndex) => {
    const left = bodies[leftIndex], right = bodies[rightIndex];
    return left[center] - right[center] || left[otherCenter] - right[otherCenter]
      || left.minX - right.minX || left.minZ - right.minZ
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  };
}

function buildBvh(bodies, shouldCancel) {
  if (bodies.length === 0) return { nodes: Object.freeze([]), order: new Int32Array(), maxLeafBodies: 0 };
  const order = new Int32Array(bodies.length);
  for (let index = 0; index < bodies.length; index++) order[index] = index;
  const nodes = [];
  const tasks = [{ start: 0, end: bodies.length, nodeIndex: 0 }];
  nodes.push(null);
  let maxLeafBodies = 0;
  let work = 0;
  while (tasks.length > 0) {
    checkpoint(shouldCancel, work++);
    const task = tasks.pop();
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let position = task.start; position < task.end; position++) {
      checkpoint(shouldCancel, work++);
      const body = bodies[order[position]];
      if (body.minX < minX) minX = body.minX;
      if (body.maxX > maxX) maxX = body.maxX;
      if (body.minZ < minZ) minZ = body.minZ;
      if (body.maxZ > maxZ) maxZ = body.maxZ;
    }
    const count = task.end - task.start;
    if (count <= WATER_FIELD_BVH_LEAF_BODIES) {
      if (count > maxLeafBodies) maxLeafBodies = count;
      nodes[task.nodeIndex] = { minX, maxX, minZ, maxZ, left: -1, right: -1, start: task.start, count };
      continue;
    }
    const axis = maxX - minX >= maxZ - minZ ? 0 : 1;
    const slice = Array.from(order.subarray(task.start, task.end));
    const comparator = compareBodyOnAxis(bodies, axis);
    slice.sort(comparator);
    order.set(slice, task.start);
    const mid = task.start + Math.floor(count / 2);
    const left = nodes.length;
    const right = left + 1;
    if (right >= MAX_WATER_FIELD_BVH_NODES) fail(`water field BVH exceeds ${MAX_WATER_FIELD_BVH_NODES} retained nodes`);
    nodes.push(null, null);
    nodes[task.nodeIndex] = { minX, maxX, minZ, maxZ, left, right, start: 0, count: 0 };
    // Push right first so the lower deterministic node index is processed first.
    tasks.push({ start: mid, end: task.end, nodeIndex: right });
    tasks.push({ start: task.start, end: mid, nodeIndex: left });
  }
  for (let index = 0; index < nodes.length; index++) nodes[index] = Object.freeze(nodes[index]);
  return { nodes: Object.freeze(nodes), order, maxLeafBodies };
}

function orientationSign(a, b, point) {
  const x1 = b[0] - a[0], z1 = b[1] - a[1];
  const x2 = point[0] - a[0], z2 = point[1] - a[1];
  const determinant = x1 * z2 - z1 * x2;
  const tolerance = Number.EPSILON * 32 * (Math.abs(x1 * z2) + Math.abs(z1 * x2) + 1);
  return determinant > tolerance ? 1 : determinant < -tolerance ? -1 : 0;
}

function onSegment(a, b, point) {
  if (orientationSign(a, b, point) !== 0) return false;
  const tolerance = Number.EPSILON * 32 * Math.max(1, Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1]), Math.abs(point[0]), Math.abs(point[1]));
  return point[0] >= Math.min(a[0], b[0]) - tolerance && point[0] <= Math.max(a[0], b[0]) + tolerance
    && point[1] >= Math.min(a[1], b[1]) - tolerance && point[1] <= Math.max(a[1], b[1]) + tolerance;
}

// Returns 0 on the boundary, 1 inside, -1 outside.
function classifyRing(x, z, bounded, stats) {
  let inside = false;
  const point = [x, z];
  const edgeBvh = bounded.edgeBvh;
  const stack = [0];
  while (stack.length > 0) {
    const node = edgeBvh.nodes[stack.pop()];
    stats.edgeNodesVisited++;
    if (z < node.minZ || z > node.maxZ || x > node.maxX) continue;
    if (node.left >= 0) {
      stack.push(node.right, node.left);
      continue;
    }
    for (let position = node.start; position < node.start + node.count; position++) {
      const segment = edgeBvh.segments[edgeBvh.order[position]];
      if (z < segment.minZ || z > segment.maxZ || x > segment.maxX) continue;
      stats.segmentTests++;
      const a = segment.a, b = segment.b;
      if (onSegment(a, b, point)) return 0;
      if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
  }
  return inside ? 1 : -1;
}

function containsBody(body, x, z, stats) {
  const outer = classifyRing(x, z, body.outer, stats);
  if (outer < 0) return false;
  for (const hole of body.holes) {
    if (x < hole.minX || x > hole.maxX || z < hole.minZ || z > hole.maxZ) continue;
    if (classifyRing(x, z, hole, stats) >= 0) return false;
  }
  return true;
}

function segmentDistanceSquared(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const lengthSquared = dx * dx + dz * dz;
  let t = ((x - a[0]) * dx + (z - a[1]) * dz) / lengthSquared;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const offsetX = x - (a[0] + t * dx), offsetZ = z - (a[1] + t * dz);
  const squared = offsetX * offsetX + offsetZ * offsetZ;
  if (!Number.isFinite(squared)) fail("water field shoreline distance exceeded finite numeric bounds");
  return squared;
}

function pointAabbDistanceSquared(x, z, node) {
  const dx = x < node.minX ? node.minX - x : x > node.maxX ? x - node.maxX : 0;
  const dz = z < node.minZ ? node.minZ - z : z > node.maxZ ? z - node.maxZ : 0;
  return dx * dx + dz * dz;
}

function shorelineDistance(body, x, z, stats) {
  let minimumSquared = Infinity;
  const edgeBvh = body.edgeBvh;
  const stack = [0];
  while (stack.length > 0) {
    const nodeIndex = stack.pop();
    const node = edgeBvh.nodes[nodeIndex];
    stats.edgeNodesVisited++;
    if (pointAabbDistanceSquared(x, z, node) > minimumSquared) continue;
    if (node.left >= 0) {
      const leftDistance = pointAabbDistanceSquared(x, z, edgeBvh.nodes[node.left]);
      const rightDistance = pointAabbDistanceSquared(x, z, edgeBvh.nodes[node.right]);
      if (leftDistance <= rightDistance) stack.push(node.right, node.left);
      else stack.push(node.left, node.right);
      continue;
    }
    for (let position = node.start; position < node.start + node.count; position++) {
      stats.segmentTests++;
      const segment = edgeBvh.segments[edgeBvh.order[position]];
      const squared = segmentDistanceSquared(x, z, segment.a, segment.b);
      if (squared < minimumSquared) minimumSquared = squared;
    }
  }
  return canonicalNumber(Math.sqrt(minimumSquared));
}

function targetDepth(body, shoreDistanceM) {
  let low = 0, high = body.zones.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (shoreDistanceM < body.zones[mid].maxShoreDistanceM) high = mid;
    else low = mid + 1;
  }
  return body.zones[low].depthM;
}

function frozenResult(type, isSubmerged, id, kind, surfaceLevelM, oceanSurfaceCandidateM, authoredTargetDepthM, targetFloorLevelM, actualSubmergedDepthM, shoreDistanceM) {
  return Object.freeze({
    type,
    isSubmerged,
    id,
    kind,
    surfaceLevelM,
    oceanSurfaceCandidateM,
    authoredTargetDepthM,
    targetFloorLevelM,
    actualSubmergedDepthM,
    shoreDistanceM,
  });
}

function writeFloatOrCanonicalNaN(view, offset, value) {
  if (value === null) view.setBigUint64(offset, CANONICAL_NAN_BITS, true);
  else view.setFloat64(offset, canonicalNumber(value), true);
}

function sampleDimension(value, label, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) fail(`${label} must be an integer in [1, ${maximum}]`);
  return value;
}

class WaterField {
  #bodies;
  #bodyIndexById;
  #nodes;
  #order;
  #seaLevelM;

  constructor(map, bodies, bvh, buildStats) {
    this.#bodies = bodies;
    this.#bodyIndexById = new Map(bodies.map((body, index) => [body.id, index]));
    this.#nodes = bvh.nodes;
    this.#order = bvh.order;
    this.#seaLevelM = canonicalNumber(map.seaLevel);
    this.bodyIds = Object.freeze(bodies.map((body) => body.id));
    this.boundaryPolicy = "outer-wet-hole-dry; depth bands [min,max); final depth clamps beyond final max";
    this.overlapPolicy = "highest surface level, then lexicographically smallest portable id";
    this.surfacePolicy = "proven-submerged ocean competes by surface level and wins only when strictly above the selected basin";
    this.buildStats = Object.freeze(buildStats);
    Object.freeze(this);
  }

  #queryRaw(xValue, zValue, terrainHeightValue) {
    const x = finite(xValue, "water query x");
    const z = finite(zValue, "water query z");
    const terrainSupplied = terrainHeightValue !== undefined;
    const terrainHeightM = terrainSupplied ? finite(terrainHeightValue, "water query terrainHeightM") : null;
    const stats = { visitedNodes: 0, candidateBodies: 0, testedBodies: 0, edgeNodesVisited: 0, segmentTests: 0 };
    let winner = null;
    if (this.#nodes.length > 0) {
      const stack = [0];
      while (stack.length > 0) {
        const nodeIndex = stack.pop();
        const node = this.#nodes[nodeIndex];
        stats.visitedNodes++;
        if (x < node.minX || x > node.maxX || z < node.minZ || z > node.maxZ) continue;
        if (node.left >= 0) {
          stack.push(node.right, node.left);
          continue;
        }
        stats.candidateBodies += node.count;
        for (let position = node.start; position < node.start + node.count; position++) {
          const body = this.#bodies[this.#order[position]];
          if (x < body.minX || x > body.maxX || z < body.minZ || z > body.maxZ) continue;
          stats.testedBodies++;
          if (!containsBody(body, x, z, stats)) continue;
          if (winner === null || body.level > winner.level || (body.level === winner.level && body.id < winner.id)) winner = body;
        }
      }
    }
    const oceanIsSubmerged = terrainSupplied && terrainHeightM < this.#seaLevelM;
    if (oceanIsSubmerged && (winner === null || this.#seaLevelM > winner.level)) {
      return {
        result: frozenResult("ocean", true, null, "ocean", this.#seaLevelM, this.#seaLevelM, null, null,
          canonicalNumber(this.#seaLevelM - terrainHeightM), null),
        stats: Object.freeze(stats),
        bodyIndex: -1,
      };
    }
    if (winner !== null) {
      const shoreDistanceM = shorelineDistance(winner, x, z, stats);
      const authoredTargetDepthM = targetDepth(winner, shoreDistanceM);
      const targetFloorLevelM = canonicalNumber(winner.level - authoredTargetDepthM);
      const actualSubmergedDepthM = terrainSupplied ? canonicalNumber(Math.max(0, winner.level - terrainHeightM)) : null;
      return {
        result: frozenResult("basin", terrainSupplied ? actualSubmergedDepthM > 0 : null, winner.id, winner.kind,
          winner.level, this.#seaLevelM, authoredTargetDepthM, targetFloorLevelM, actualSubmergedDepthM, shoreDistanceM),
        stats: Object.freeze(stats),
        bodyIndex: this.#bodyIndexById.get(winner.id),
      };
    }
    if (!terrainSupplied) {
      return {
        result: frozenResult("ocean", null, null, null, null, this.#seaLevelM, null, null, null, null),
        stats: Object.freeze(stats),
        bodyIndex: -1,
      };
    }
    if (oceanIsSubmerged) {
      return {
        result: frozenResult("ocean", true, null, "ocean", this.#seaLevelM, this.#seaLevelM, null, null,
          canonicalNumber(this.#seaLevelM - terrainHeightM), null),
        stats: Object.freeze(stats),
        bodyIndex: -1,
      };
    }
    return {
      result: frozenResult("dry", false, null, null, null, this.#seaLevelM, null, null, 0, null),
      stats: Object.freeze(stats),
      bodyIndex: -1,
    };
  }

  query(x, z, terrainHeightM) {
    return this.#queryRaw(x, z, terrainHeightM).result;
  }

  queryWithStats(x, z, terrainHeightM) {
    const queried = this.#queryRaw(x, z, terrainHeightM);
    return Object.freeze({ result: queried.result, stats: queried.stats });
  }

  sampleGrid(options) {
    const source = plainRecord(options, "water sample options");
    const rect = plainRecord(source.rect, "water sample rect");
    const x0 = finite(rect.x0, "water sample rect.x0");
    const z0 = finite(rect.z0, "water sample rect.z0");
    const width = positiveFinite(rect.w, "water sample rect.w");
    const height = positiveFinite(rect.h, "water sample rect.h");
    finite(x0 + width, "water sample rect max x");
    finite(z0 + height, "water sample rect max z");
    const rows = sampleDimension(source.rows, "water sample rows", MAX_WATER_FIELD_ROWS);
    const cols = sampleDimension(source.cols, "water sample cols", MAX_WATER_FIELD_COLS);
    if (source.terrainSampler !== undefined && typeof source.terrainSampler !== "function") fail("water sample terrainSampler must be a function");
    if (source.shouldCancel !== undefined && typeof source.shouldCancel !== "function") fail("water sample shouldCancel must be a function");
    if (source.shouldCancel?.()) throw new WaterFieldCancelledError();
    const cells = rows * cols;
    if (cells > MAX_WATER_FIELD_SAMPLES) fail(`water sample grid exceeds ${MAX_WATER_FIELD_SAMPLES} cells`);
    const bytes = new Uint8Array(cells * WATER_SAMPLE_RECORD_BYTES);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let work = 0;
    for (let row = 0; row < rows; row++) {
      const z = rows === 1 ? z0 + height / 2 : z0 + (row / (rows - 1)) * height;
      for (let col = 0; col < cols; col++) {
        checkpoint(source.shouldCancel, work++);
        const x = cols === 1 ? x0 + width / 2 : x0 + (col / (cols - 1)) * width;
        const terrainHeightM = source.terrainSampler === undefined ? undefined : source.terrainSampler(x, z, row, col);
        if (source.terrainSampler !== undefined) finite(terrainHeightM, `water sample terrainSampler(${row},${col})`);
        const queried = this.#queryRaw(x, z, terrainHeightM);
        const result = queried.result;
        const offset = (row * cols + col) * WATER_SAMPLE_RECORD_BYTES;
        view.setUint8(offset, result.type === "dry" ? WATER_SAMPLE_CLASS_DRY : result.type === "ocean" ? WATER_SAMPLE_CLASS_OCEAN : WATER_SAMPLE_CLASS_BASIN);
        view.setUint8(offset + 1, result.isSubmerged === null ? WATER_SAMPLE_SUBMERGED_UNKNOWN : result.isSubmerged ? WATER_SAMPLE_SUBMERGED_YES : WATER_SAMPLE_SUBMERGED_NO);
        view.setUint8(offset + 2, 0);
        view.setUint8(offset + 3, 0);
        view.setInt32(offset + 4, queried.bodyIndex, true);
        writeFloatOrCanonicalNaN(view, offset + 8, result.surfaceLevelM);
        writeFloatOrCanonicalNaN(view, offset + 16, result.authoredTargetDepthM);
        writeFloatOrCanonicalNaN(view, offset + 24, result.targetFloorLevelM);
        writeFloatOrCanonicalNaN(view, offset + 32, result.actualSubmergedDepthM);
        writeFloatOrCanonicalNaN(view, offset + 40, result.oceanSurfaceCandidateM);
      }
    }
    if (source.shouldCancel?.()) throw new WaterFieldCancelledError();
    return Object.freeze({
      rows,
      cols,
      cells,
      rect: Object.freeze({ x0, z0, w: width, h: height }),
      bodyIds: this.bodyIds,
      layout: WATER_SAMPLE_LAYOUT,
      storage: "owned-row-major-little-endian-records",
      bytes,
    });
  }
}

export function createWaterField(worldMapInput, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) fail("water field options must be an object");
  if (options.shouldCancel !== undefined && typeof options.shouldCancel !== "function") fail("water field shouldCancel must be a function");
  if (options.shouldCancel?.()) throw new WaterFieldCancelledError();
  const map = validateWorldMapIdentity(worldMapInput);
  let parsedBodies;
  try {
    parsedBodies = parseAuthoredWaterBodies(map.waterBodies ?? []);
  } catch (error) {
    fail(`water field WaterBody contract rejected input: ${error instanceof Error ? error.message : String(error)}`);
  }
  const prepared = prepareBodies(parsedBodies, map, options.shouldCancel);
  const bvh = buildBvh(prepared.bodies, options.shouldCancel);
  if (options.shouldCancel?.()) throw new WaterFieldCancelledError();
  return new WaterField(map, prepared.bodies, bvh, {
    bodyCount: prepared.bodies.length,
    edgeCount: prepared.edgeCount,
    edgeNodeCount: prepared.edgeNodeCount,
    retainedEdgeNodeCap: MAX_WATER_FIELD_EDGE_BVH_NODES,
    nodeCount: bvh.nodes.length,
    retainedNodeCap: MAX_WATER_FIELD_BVH_NODES,
    maxLeafBodies: bvh.maxLeafBodies,
    transformWork: prepared.transformWork,
    bodyPairValidationWork: 0,
  });
}
