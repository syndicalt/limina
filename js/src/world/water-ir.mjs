// Shared WB-W1 water contracts for both the TypeScript WorldMap boundary and the dependency-free
// Node compiler. Keep validation here so authoring and runtime cannot drift on topology or limits.

/** @type {readonly ["river", "stream"]} */
export const WATERWAY_CLASSES = Object.freeze(["river", "stream"]);
/** Per-basin standing/surface-water kinds. The global ocean remains `WorldMap.seaLevel`, while
 * flowing rivers and streams remain `WorldMap.waterways`. */
/** @type {readonly ["lake", "pond", "reservoir", "lagoon", "marsh", "swamp", "bog", "estuary"]} */
export const WATER_BODY_KINDS = Object.freeze(["lake", "pond", "reservoir", "lagoon", "marsh", "swamp", "bog", "estuary"]);

export const WATER_LIMITS = Object.freeze({
  bodies: 4096,
  waterways: 4096,
  ringPoints: 512,
  holes: 32,
  depthZones: 64,
  waterwayPoints: 8192,
  bodyPoints: 4096,
  totalBodyPoints: 65536,
  totalWaterwayPoints: 262144,
  // Ten million metres supports continental authoring while keeping determinant error bounded.
  absCoordinateM: 10000000,
  absLevelM: 100000,
  depthM: 20000,
  shoreDistanceM: 1000000,
  widthM: 100000,
  streamOrder: 12,
  // Simple-polygon validation is quadratic. This hard budget bounds hostile aggregate work even
  // when every individual ring remains below its point cap.
  topologyWorkUnits: 2000000,
});

const WATER_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const WATERWAY_CLASS_SET = new Set(WATERWAY_CLASSES);
const WATER_BODY_KIND_SET = new Set(WATER_BODY_KINDS);
const WATER_BODY_KEYS = new Set(["id", "kind", "level", "footprint", "depthZones"]);
const WATER_FOOTPRINT_KEYS = new Set(["points", "holes"]);
const WATER_DEPTH_ZONE_KEYS = new Set(["minShoreDistanceM", "maxShoreDistanceM", "depthM"]);

export function isPortableWaterId(value) {
  return typeof value === "string" && WATER_ID_RE.test(value);
}

/** Reject accessors, polluted prototypes, sparse arrays, symbols, cycles and non-enumerable data
 *  without invoking accessor values. */
export function isPlainJsonData(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    if (Object.keys(descriptors).some((key) => key !== "length" && !/^(0|[1-9]\d*)$/.test(key))) return false;
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || !isPlainJsonData(descriptor.value, seen)) return false;
    }
    return true;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor) || !descriptor.enumerable || !isPlainJsonData(descriptor.value, seen)) return false;
  }
  return true;
}

export class WaterIrValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "WaterIrValidationError";
  }
}

function fail(message) {
  throw new WaterIrValidationError(message);
}

function requireRecord(value, path, allowedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail(`${path} must be a plain object`);
  for (const key of Object.keys(value)) if (!allowedKeys.has(key)) fail(`${path} has unknown field '${key}'`);
  return value;
}

function requireArray(value, path, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${path} must contain ${min}..${max} entries`);
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) fail(`${path} must not be sparse`);
  return value;
}

function requireFiniteNumber(value, path, min, max, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    fail(`${path} must be a ${integer ? "finite integer" : "finite number"} in [${min}, ${max}]`);
  }
  return value;
}

function requirePositiveNumber(value, path, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max) fail(`${path} must be finite, positive, and at most ${max}`);
  return value;
}

function requireFinitePoint(value, path) {
  const point = requireArray(value, path, 2, 2);
  return [
    requireFiniteNumber(point[0], `${path}[0]`, -WATER_LIMITS.absCoordinateM, WATER_LIMITS.absCoordinateM),
    requireFiniteNumber(point[1], `${path}[1]`, -WATER_LIMITS.absCoordinateM, WATER_LIMITS.absCoordinateM),
  ];
}

function orientationSign(a, b, c) {
  const x1 = b[0] - a[0], y1 = b[1] - a[1], x2 = c[0] - a[0], y2 = c[1] - a[1];
  const determinant = x1 * y2 - y1 * x2;
  const tolerance = Number.EPSILON * 32 * (Math.abs(x1 * y2) + Math.abs(y1 * x2) + 1);
  return determinant > tolerance ? 1 : determinant < -tolerance ? -1 : 0;
}

function onSegment(a, b, point) {
  if (orientationSign(a, b, point) !== 0) return false;
  const tolerance = Number.EPSILON * 32 * Math.max(1, Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1]), Math.abs(point[0]), Math.abs(point[1]));
  return point[0] >= Math.min(a[0], b[0]) - tolerance && point[0] <= Math.max(a[0], b[0]) + tolerance &&
    point[1] >= Math.min(a[1], b[1]) - tolerance && point[1] <= Math.max(a[1], b[1]) + tolerance;
}

function compare(budget) {
  budget.workUnits++;
  if (budget.workUnits > WATER_LIMITS.topologyWorkUnits) fail(`water topology exceeds ${WATER_LIMITS.topologyWorkUnits} bounded work units`);
}

function segmentsIntersect(a, b, c, d, budget) {
  compare(budget);
  const abC = orientationSign(a, b, c), abD = orientationSign(a, b, d);
  const cdA = orientationSign(c, d, a), cdB = orientationSign(c, d, b);
  if (abC !== 0 && abD !== 0 && cdA !== 0 && cdB !== 0) return abC !== abD && cdA !== cdB;
  return (abC === 0 && onSegment(a, b, c)) || (abD === 0 && onSegment(a, b, d)) ||
    (cdA === 0 && onSegment(c, d, a)) || (cdB === 0 && onSegment(c, d, b));
}

function ringAreaSign(ring, budget) {
  const origin = ring[0];
  let twiceArea = 0;
  let magnitude = 0;
  // Triangulate in a translated local frame. Absolute-coordinate shoelace terms catastrophically
  // cancel for a small basin located far from the world origin.
  for (let index = 1; index < ring.length - 1; index++) {
    compare(budget);
    const point = ring[index], next = ring[index + 1];
    const px = point[0] - origin[0], py = point[1] - origin[1];
    const nx = next[0] - origin[0], ny = next[1] - origin[1];
    const term = px * ny - nx * py;
    twiceArea += term;
    magnitude += Math.abs(px * ny) + Math.abs(nx * py);
  }
  const tolerance = Number.EPSILON * 32 * (magnitude + 1);
  return twiceArea > tolerance ? 1 : twiceArea < -tolerance ? -1 : 0;
}

function validateRing(ring, path, budget) {
  const seen = new Set();
  for (let index = 0; index < ring.length; index++) {
    compare(budget);
    const point = ring[index], next = ring[(index + 1) % ring.length];
    const key = `${point[0]}\u0000${point[1]}`;
    if (seen.has(key) || (point[0] === next[0] && point[1] === next[1])) fail(`${path} must not repeat vertices`);
    seen.add(key);
  }
  if (ringAreaSign(ring, budget) === 0) fail(`${path} must enclose numerically stable non-zero area`);
  for (let i = 0; i < ring.length; i++) for (let j = i + 1; j < ring.length; j++) {
    if (j === i + 1 || (i === 0 && j === ring.length - 1)) continue;
    if (segmentsIntersect(ring[i], ring[(i + 1) % ring.length], ring[j], ring[(j + 1) % ring.length], budget)) fail(`${path} must not self-intersect`);
  }
}

function pointInRing(point, ring, budget) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    compare(budget);
    const a = ring[j], b = ring[i];
    if (onSegment(a, b, point)) return 0;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside ? 1 : -1;
}

function ringsIntersect(a, b, budget) {
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    if (segmentsIntersect(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length], budget)) return true;
  }
  return false;
}

function validateFootprint(footprint, path, budget) {
  validateRing(footprint.points, `${path}.points`, budget);
  const holes = footprint.holes ?? [];
  for (let index = 0; index < holes.length; index++) {
    const hole = holes[index];
    validateRing(hole, `${path}.holes[${index}]`, budget);
    if (pointInRing(hole[0], footprint.points, budget) !== 1 || ringsIntersect(hole, footprint.points, budget)) fail(`${path}.holes[${index}] must be strictly inside the footprint`);
    for (let previous = 0; previous < index; previous++) {
      if (ringsIntersect(hole, holes[previous], budget) || pointInRing(hole[0], holes[previous], budget) !== -1 || pointInRing(holes[previous][0], hole, budget) !== -1) {
        fail(`${path}.holes[${index}] must not overlap or contain another hole`);
      }
    }
  }
}

/** Topology validation for already structurally parsed WaterBody values. */
export function inspectWaterBodyTopology(bodies) {
  const budget = { workUnits: 0 };
  try {
    for (let index = 0; index < bodies.length; index++) validateFootprint(bodies[index].footprint, `waterBodies[${index}].footprint`, budget);
    return { ok: true, workUnits: budget.workUnits };
  } catch (error) {
    if (!(error instanceof WaterIrValidationError)) throw error;
    return { ok: false, workUnits: budget.workUnits, message: error.message };
  }
}

function parseRing(value, path) {
  return requireArray(value, path, 3, WATER_LIMITS.ringPoints).map((point, index) => requireFinitePoint(point, `${path}[${index}]`));
}

function parseFootprint(value, path) {
  const source = requireRecord(value, path, WATER_FOOTPRINT_KEYS);
  const points = parseRing(source.points, `${path}.points`);
  const holes = source.holes === undefined ? undefined : requireArray(source.holes, `${path}.holes`, 0, WATER_LIMITS.holes).map((hole, index) => parseRing(hole, `${path}.holes[${index}]`));
  return { points, ...(holes !== undefined ? { holes } : {}) };
}

/** Parse and clone the authored per-map WaterBody array. */
export function parseAuthoredWaterBodies(value) {
  if (!isPlainJsonData(value)) fail("waterBodies must be plain JSON data");
  const source = requireArray(value, "waterBodies", 0, WATER_LIMITS.bodies);
  const ids = new Set();
  let totalPoints = 0;
  const bodies = source.map((candidate, bodyIndex) => {
    const path = `waterBodies[${bodyIndex}]`;
    const body = requireRecord(candidate, path, WATER_BODY_KEYS);
    if (!isPortableWaterId(body.id)) fail(`${path}.id must be a portable lowercase ASCII id of at most 128 characters`);
    if (ids.has(body.id)) fail(`waterBodies has duplicate id '${body.id}'`);
    ids.add(body.id);
    if (!WATER_BODY_KIND_SET.has(body.kind)) fail(`${path}.kind must be one of ${WATER_BODY_KINDS.join(", ")}`);
    const footprint = parseFootprint(body.footprint, `${path}.footprint`);
    const bodyPoints = footprint.points.length + (footprint.holes ?? []).reduce((sum, hole) => sum + hole.length, 0);
    if (bodyPoints > WATER_LIMITS.bodyPoints) fail(`${path}.footprint exceeds ${WATER_LIMITS.bodyPoints} points`);
    totalPoints += bodyPoints;
    if (totalPoints > WATER_LIMITS.totalBodyPoints) fail(`waterBodies geometry exceeds ${WATER_LIMITS.totalBodyPoints} points`);
    let previousMax = -Infinity, previousDepth = -Infinity;
    const depthZones = requireArray(body.depthZones, `${path}.depthZones`, 1, WATER_LIMITS.depthZones).map((candidateZone, zoneIndex) => {
      const zonePath = `${path}.depthZones[${zoneIndex}]`;
      const zone = requireRecord(candidateZone, zonePath, WATER_DEPTH_ZONE_KEYS);
      const minShoreDistanceM = requireFiniteNumber(zone.minShoreDistanceM, `${zonePath}.minShoreDistanceM`, 0, WATER_LIMITS.shoreDistanceM);
      const maxShoreDistanceM = requirePositiveNumber(zone.maxShoreDistanceM, `${zonePath}.maxShoreDistanceM`, WATER_LIMITS.shoreDistanceM);
      const depthM = requirePositiveNumber(zone.depthM, `${zonePath}.depthM`, WATER_LIMITS.depthM);
      if (maxShoreDistanceM <= minShoreDistanceM) fail(`${zonePath} must have maxShoreDistanceM > minShoreDistanceM`);
      if (zoneIndex === 0 && minShoreDistanceM !== 0) fail(`${path}.depthZones must start at the shoreline (minShoreDistanceM=0)`);
      if (zoneIndex > 0 && minShoreDistanceM !== previousMax) fail(`${path}.depthZones must be ordered and contiguous without gaps or overlaps`);
      if (depthM <= previousDepth) fail(`${path}.depthZones depths must increase monotonically toward the interior`);
      previousMax = maxShoreDistanceM;
      previousDepth = depthM;
      return { minShoreDistanceM, maxShoreDistanceM, depthM };
    });
    return {
      id: body.id,
      kind: body.kind,
      level: requireFiniteNumber(body.level, `${path}.level`, -WATER_LIMITS.absLevelM, WATER_LIMITS.absLevelM),
      footprint,
      depthZones,
    };
  });
  const topology = inspectWaterBodyTopology(bodies);
  if (!topology.ok) fail(topology.message);
  return bodies;
}

/** Parse and clone one authored river feature while preserving legacy scalar width/class defaults. */
export function parseAuthoredWaterway(feature, defaultWidthM, path) {
  if (!isPlainJsonData(feature)) fail(`${path} must be plain JSON data`);
  const points = requireArray(feature.points, `${path}.points`, 2, WATER_LIMITS.waterwayPoints).map((point, index) => requireFinitePoint(point, `${path}.points[${index}]`));
  const className = feature.class === undefined ? "river" : feature.class;
  if (!WATERWAY_CLASS_SET.has(className)) fail(`${path}.class must be 'river' or 'stream'`);
  const widthM = feature.widthM === undefined ? requirePositiveNumber(defaultWidthM, `${path}.defaultWidthM`, WATER_LIMITS.widthM) : requirePositiveNumber(feature.widthM, `${path}.widthM`, WATER_LIMITS.widthM);
  const order = feature.order === undefined ? undefined : requireFiniteNumber(feature.order, `${path}.order`, 1, WATER_LIMITS.streamOrder, true);
  let widths;
  if (feature.widths !== undefined) {
    const sourceWidths = requireArray(feature.widths, `${path}.widths`, 2, WATER_LIMITS.waterwayPoints);
    if (sourceWidths.length !== points.length) fail(`${path}.widths must have exactly one value per point`);
    widths = sourceWidths.map((width, index) => requirePositiveNumber(width, `${path}.widths[${index}]`, WATER_LIMITS.widthM));
  }
  return { points, widthM, class: className, ...(order !== undefined ? { order } : {}), ...(widths !== undefined ? { widths } : {}) };
}
