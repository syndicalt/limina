import {
  HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA,
  HYDROLOGY_COMBINED_WATER_TOPOLOGY_VERSION,
} from "./hydrology-water-topology.mjs";
import { MAX_HYDROLOGY_ABS_HEIGHT_M, MAX_HYDROLOGY_CELLS, MAX_HYDROLOGY_DIMENSION } from "./hydrology-topology.mjs";
import { inspectWaterBodyTopology, WATER_LIMITS } from "./water-ir.mjs";

export const HYDROLOGY_WATER_ARTIFACT_TYPE = "hydrology-water-topology/v1";
export const HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.hydrology-water-topology";
export const HYDROLOGY_WATER_ARTIFACT_VERSION = 1;
export const HYDROLOGY_WATER_ARTIFACT_HEADER_BYTES = 256;

const MAGIC = new Uint8Array([0x4c, 0x48, 0x59, 0x57, 0x41, 0x54, 0x31, 0x00]); // LHYWAT1\0
const ROOT_KEYS = new Set(["schema", "version", "placement", "rows", "cols", "cellSizeM", "basins", "reaches", "diagnostics"]);
const PLACEMENT_KEYS = new Set(["originX", "originZ"]);
const BASIN_KEYS = new Set(["id", "kind", "spillLevelM", "maxDepthM", "areaM2", "cellCount", "seedCell",
  "spillInsideCell", "spillOutsideCell", "spillOutsideDrainageRank", "footprint"]);
const FOOTPRINT_KEYS = new Set(["points", "holes"]);
const REACH_KEYS = new Set(["id", "class", "order", "startCell", "endCell", "points", "widths",
  "terrainElevationsM", "surfaceElevationsM", "waterfalls"]);
const WATERFALL_KEYS = new Set(["startSegment", "endSegmentExclusive", "startCell", "endCell", "totalDropM", "maxEdgeDropM"]);
const BINDING_KEYS = Object.freeze(["hydrologyFieldContentHash", "recipeHash", "erosionStageKey", "compilerGraphHash"]);
const BINDING_KEY_SET = new Set(BINDING_KEYS);
const CONTROL_KEYS = new Set(["shouldCancel"]);
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const BASIN_RECORD_BYTES = 64;
const RING_RECORD_BYTES = 16;
const BASIN_POINT_BYTES = 16;
const REACH_RECORD_BYTES = 32;
const REACH_POINT_BYTES = 48;
const WATERFALL_RECORD_BYTES = 40;
const MAX_RING_COUNT = Math.min(WATER_LIMITS.bodies * (WATER_LIMITS.holes + 1), Math.floor(WATER_LIMITS.totalBodyPoints / 3));
const MAX_ORIGIN_M = WATER_LIMITS.absCoordinateM;
const align8 = (value) => Math.ceil(value / 8) * 8;

function layoutForCounts(basins, rings, basinPoints, reaches, reachPoints, waterfalls) {
  const basinRecords = HYDROLOGY_WATER_ARTIFACT_HEADER_BYTES;
  const ringRecords = align8(basinRecords + basins * BASIN_RECORD_BYTES);
  const basinPointRecords = align8(ringRecords + rings * RING_RECORD_BYTES);
  const reachRecords = align8(basinPointRecords + basinPoints * BASIN_POINT_BYTES);
  const reachPointRecords = align8(reachRecords + reaches * REACH_RECORD_BYTES);
  const waterfallRecords = align8(reachPointRecords + reachPoints * REACH_POINT_BYTES);
  const dataEnd = waterfallRecords + waterfalls * WATERFALL_RECORD_BYTES;
  return Object.freeze({ basinRecords, ringRecords, basinPointRecords, reachRecords, reachPointRecords,
    waterfallRecords, dataEnd, byteLength: align8(dataEnd) });
}

export const MAX_HYDROLOGY_WATER_ARTIFACT_BYTES = layoutForCounts(
  WATER_LIMITS.bodies,
  MAX_RING_COUNT,
  WATER_LIMITS.totalBodyPoints,
  WATER_LIMITS.waterways,
  WATER_LIMITS.totalWaterwayPoints,
  WATER_LIMITS.totalWaterwayPoints,
).byteLength;

if (MAX_HYDROLOGY_WATER_ARTIFACT_BYTES > 256 * 1024 * 1024) {
  throw new Error("hydrology water artifact maximum exceeds the compiler artifact cap");
}

export class HydrologyWaterArtifactValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "HydrologyWaterArtifactValidationError";
    this.code = "hydrology_water_artifact_invalid";
  }
}

export class HydrologyWaterArtifactCancelledError extends Error {
  constructor() {
    super("hydrology water artifact operation cancelled");
    this.name = "HydrologyWaterArtifactCancelledError";
    this.code = "hydrology_water_artifact_cancelled";
  }
}

function fail(message) { throw new HydrologyWaterArtifactValidationError(message); }

function claim(seen, value, label) {
  if (seen.has(value)) fail(`${label} must not alias another object or array`);
  seen.add(value);
}

function exactRecord(value, keys, label, seen, optional = new Set()) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
  claim(seen, value, label);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!keys.has(key)) fail(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor) || descriptor.enumerable !== true) fail(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of keys) if (!optional.has(key) && !Object.hasOwn(value, key)) fail(`${label} is missing '${key}'`);
  return descriptors;
}

function denseArray(value, minimum, maximum, label, seen) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > maximum) {
    fail(`${label} must contain ${minimum}..${maximum} entries`);
  }
  claim(seen, value, label);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    if (key === "length") continue;
    if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) fail(`${label} has a non-index field '${key}'`);
  }
  const values = new Array(value.length);
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) fail(`${label} must be dense enumerable data`);
    values[index] = descriptor.value;
  }
  return values;
}

function canonicalNumber(value, label, minimum, maximum, positive = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)
      || (positive ? value <= minimum : value < minimum) || value > maximum) {
    fail(`${label} must be a finite canonical number in ${positive ? "(" : "["}${minimum}, ${maximum}]`);
  }
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${label} must be an integer in [${minimum}, ${maximum}]`);
  return value;
}

function parseControl(value) {
  if (value === undefined) return undefined;
  const seen = new Set();
  const descriptors = exactRecord(value, CONTROL_KEYS, "hydrology water artifact control", seen);
  if (typeof descriptors.shouldCancel.value !== "function") fail("hydrology water artifact control.shouldCancel must be a function");
  return descriptors.shouldCancel.value;
}

function createMeter(shouldCancel, maximum) {
  let workUnits = 0, cancellationChecks = 0;
  const check = () => {
    cancellationChecks++;
    if (shouldCancel?.()) throw new HydrologyWaterArtifactCancelledError();
  };
  const work = () => {
    workUnits++;
    if (workUnits > maximum) fail(`hydrology water artifact exceeds ${maximum} bounded work units`);
    if ((workUnits & 1023) === 0) check();
  };
  return { work, check, snapshot: () => Object.freeze({ workUnits, workLimit: maximum, cancellationChecks }) };
}

function parseBindings(value, label = "hydrology water artifact bindings") {
  const seen = new Set();
  const descriptors = exactRecord(value, BINDING_KEY_SET, label, seen);
  const parsed = {};
  for (const key of BINDING_KEYS) {
    const hash = descriptors[key].value;
    if (typeof hash !== "string" || !HASH_RE.test(hash)) fail(`${label}.${key} must be a lowercase sha256 content hash`);
    parsed[key] = hash;
  }
  return Object.freeze(parsed);
}

function parsePlacement(value, seen) {
  const descriptors = exactRecord(value, PLACEMENT_KEYS, "hydrology water topology placement", seen);
  return Object.freeze({
    originX: canonicalNumber(descriptors.originX.value, "hydrology water topology placement.originX", -MAX_ORIGIN_M, MAX_ORIGIN_M),
    originZ: canonicalNumber(descriptors.originZ.value, "hydrology water topology placement.originZ", -MAX_ORIGIN_M, MAX_ORIGIN_M),
  });
}

function parsePoint(value, label, seen) {
  const point = denseArray(value, 2, 2, label, seen);
  return Object.freeze([
    canonicalNumber(point[0], `${label}[0]`, -WATER_LIMITS.absCoordinateM, WATER_LIMITS.absCoordinateM),
    canonicalNumber(point[1], `${label}[1]`, -WATER_LIMITS.absCoordinateM, WATER_LIMITS.absCoordinateM),
  ]);
}

function twiceArea(ring) {
  const origin = ring[0];
  let area = 0;
  for (let index = 1; index < ring.length - 1; index++) {
    area += (ring[index][0] - origin[0]) * (ring[index + 1][1] - origin[1])
      - (ring[index + 1][0] - origin[0]) * (ring[index][1] - origin[1]);
  }
  return area;
}

function comparePoint(left, right) { return left[0] - right[0] || left[1] - right[1]; }

function parseRing(value, label, seen) {
  const source = denseArray(value, 3, WATER_LIMITS.ringPoints, label, seen);
  const ring = Object.freeze(source.map((point, index) => parsePoint(point, `${label}[${index}]`, seen)));
  for (let index = 1; index < ring.length; index++) if (comparePoint(ring[index], ring[0]) < 0) fail(`${label} must start at its lexicographically smallest point`);
  return ring;
}

function cellForPoint(point, placement, cellSizeM, rows, cols, label) {
  const col = Math.round((point[0] - placement.originX) / cellSizeM);
  const row = Math.round((point[1] - placement.originZ) / cellSizeM);
  if (row < 0 || row >= rows || col < 0 || col >= cols
      || placement.originX + col * cellSizeM !== point[0] || placement.originZ + row * cellSizeM !== point[1]) {
    fail(`${label} must be an exact hydrology cell center`);
  }
  return row * cols + col;
}

function validateDiagnostics(value, seen, budget = { properties: 0 }, label = "hydrology water topology diagnostics") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail(`${label} numbers must be finite and canonical`);
    return;
  }
  if (value === null || typeof value !== "object") fail(`${label} must contain only plain data`);
  if (Array.isArray(value)) {
    const values = denseArray(value, 0, 4096, label, seen);
    budget.properties += values.length;
    if (budget.properties > 4096) fail("hydrology water topology diagnostics exceed 4096 bounded properties");
    for (let index = 0; index < values.length; index++) validateDiagnostics(values[index], seen, budget, `${label}[${index}]`);
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object`);
  claim(seen, value, label);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${label} must not contain symbols`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  budget.properties += Object.keys(descriptors).length;
  if (budget.properties > 4096) fail("hydrology water topology diagnostics exceed 4096 bounded properties");
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor) || descriptor.enumerable !== true) fail(`${label}.${key} must be an enumerable data field`);
    validateDiagnostics(descriptor.value, seen, budget, `${label}.${key}`);
  }
}

function parseTopology(value) {
  const seen = new Set();
  const descriptors = exactRecord(value, ROOT_KEYS, "hydrology water topology", seen);
  if (descriptors.schema.value !== HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA
      || descriptors.version.value !== HYDROLOGY_COMBINED_WATER_TOPOLOGY_VERSION) fail("hydrology water topology schema/version is unsupported");
  const rows = integer(descriptors.rows.value, 2, MAX_HYDROLOGY_DIMENSION, "hydrology water topology rows");
  const cols = integer(descriptors.cols.value, 2, MAX_HYDROLOGY_DIMENSION, "hydrology water topology cols");
  const cells = rows * cols;
  if (cells > MAX_HYDROLOGY_CELLS) fail("hydrology water topology grid exceeds supported cells");
  const cellSizeM = canonicalNumber(descriptors.cellSizeM.value, "hydrology water topology cellSizeM", 0, 1_000_000, true);
  const placement = parsePlacement(descriptors.placement.value, seen);
  validateDiagnostics(descriptors.diagnostics.value, seen);

  const basinSource = denseArray(descriptors.basins.value, 0, WATER_LIMITS.bodies, "hydrology water topology basins", seen);
  const basinIds = new Set();
  let totalBasinPoints = 0, totalRings = 0, priorBasinId = "";
  const basins = basinSource.map((candidate, basinIndex) => {
    const path = `hydrology water topology basins[${basinIndex}]`;
    const record = exactRecord(candidate, BASIN_KEYS, path, seen);
    const seedCell = integer(record.seedCell.value, 0, cells - 1, `${path}.seedCell`);
    const spillOutsideCell = integer(record.spillOutsideCell.value, 0, cells - 1, `${path}.spillOutsideCell`);
    const id = `gen-b-${spillOutsideCell.toString(36)}-${seedCell.toString(36)}`;
    if (record.id.value !== id) fail(`${path}.id must equal '${id}'`);
    if (basinIds.has(id)) fail(`hydrology water topology has duplicate basin id '${id}'`);
    if (basinIndex > 0 && id <= priorBasinId) fail("hydrology water topology basins must be strictly ordered by id");
    priorBasinId = id;
    basinIds.add(id);
    if (record.kind.value !== "lake") fail(`${path}.kind must be 'lake'`);
    const footprintRecord = exactRecord(record.footprint.value, FOOTPRINT_KEYS, `${path}.footprint`, seen, new Set(["holes"]));
    const points = parseRing(footprintRecord.points.value, `${path}.footprint.points`, seen);
    const holes = footprintRecord.holes === undefined ? [] : denseArray(footprintRecord.holes.value, 0, WATER_LIMITS.holes, `${path}.footprint.holes`, seen)
      .map((ring, index) => parseRing(ring, `${path}.footprint.holes[${index}]`, seen));
    if (!(twiceArea(points) > 0)) fail(`${path}.footprint.points must be counter-clockwise`);
    for (const hole of holes) if (!(twiceArea(hole) < 0)) fail(`${path}.footprint holes must be clockwise`);
    for (let index = 1; index < holes.length; index++) if (comparePoint(holes[index - 1][0], holes[index][0]) >= 0) fail(`${path}.footprint holes must be strictly ordered`);
    const pointCount = points.length + holes.reduce((sum, hole) => sum + hole.length, 0);
    if (pointCount > WATER_LIMITS.bodyPoints) fail(`${path}.footprint exceeds ${WATER_LIMITS.bodyPoints} points`);
    totalBasinPoints += pointCount;
    totalRings += 1 + holes.length;
    if (totalBasinPoints > WATER_LIMITS.totalBodyPoints || totalRings > MAX_RING_COUNT) fail("hydrology water topology basin geometry exceeds aggregate limits");
    return Object.freeze({
      id,
      kind: "lake",
      spillLevelM: canonicalNumber(record.spillLevelM.value, `${path}.spillLevelM`, -WATER_LIMITS.absLevelM, WATER_LIMITS.absLevelM),
      maxDepthM: canonicalNumber(record.maxDepthM.value, `${path}.maxDepthM`, 0, WATER_LIMITS.depthM, true),
      areaM2: canonicalNumber(record.areaM2.value, `${path}.areaM2`, 0, 1_000_000_000_000, true),
      cellCount: integer(record.cellCount.value, 1, cells, `${path}.cellCount`),
      seedCell,
      spillInsideCell: integer(record.spillInsideCell.value, 0, cells - 1, `${path}.spillInsideCell`),
      spillOutsideCell,
      spillOutsideDrainageRank: integer(record.spillOutsideDrainageRank.value, 0, cells - 1, `${path}.spillOutsideDrainageRank`),
      footprint: Object.freeze({ points, ...(holes.length > 0 ? { holes: Object.freeze(holes) } : {}) }),
    });
  });
  const basinTopology = inspectWaterBodyTopology(basins.map((basin) => ({ footprint: basin.footprint })));
  if (!basinTopology.ok) fail(basinTopology.message);

  const reachSource = denseArray(descriptors.reaches.value, 0, WATER_LIMITS.waterways, "hydrology water topology reaches", seen);
  const reachIds = new Set();
  let totalReachPoints = 0, totalWaterfalls = 0, priorReachStart = -1;
  const reaches = reachSource.map((candidate, reachIndex) => {
    const path = `hydrology water topology reaches[${reachIndex}]`;
    const record = exactRecord(candidate, REACH_KEYS, path, seen);
    const startCell = integer(record.startCell.value, 0, cells - 1, `${path}.startCell`);
    const endCell = integer(record.endCell.value, 0, cells - 1, `${path}.endCell`);
    const id = `gen-r-${startCell.toString(36)}-${endCell.toString(36)}`;
    if (record.id.value !== id) fail(`${path}.id must equal '${id}'`);
    if (reachIds.has(id)) fail(`hydrology water topology has duplicate reach id '${id}'`);
    if (startCell <= priorReachStart) fail("hydrology water topology reaches must be strictly ordered by startCell");
    priorReachStart = startCell;
    reachIds.add(id);
    const order = integer(record.order.value, 1, WATER_LIMITS.streamOrder, `${path}.order`);
    const className = order <= 2 ? "stream" : "river";
    if (record.class.value !== className) fail(`${path}.class is inconsistent with order`);
    const points = Object.freeze(denseArray(record.points.value, 2, WATER_LIMITS.waterwayPoints, `${path}.points`, seen)
      .map((point, index) => parsePoint(point, `${path}.points[${index}]`, seen)));
    const widthsSource = denseArray(record.widths.value, points.length, points.length, `${path}.widths`, seen);
    const terrainSource = denseArray(record.terrainElevationsM.value, points.length, points.length, `${path}.terrainElevationsM`, seen);
    const surfaceSource = denseArray(record.surfaceElevationsM.value, points.length, points.length, `${path}.surfaceElevationsM`, seen);
    const widths = Object.freeze(widthsSource.map((entry, index) => canonicalNumber(entry, `${path}.widths[${index}]`, 0, WATER_LIMITS.widthM, true)));
    const terrainElevationsM = Object.freeze(terrainSource.map((entry, index) => canonicalNumber(entry, `${path}.terrainElevationsM[${index}]`, -MAX_HYDROLOGY_ABS_HEIGHT_M, MAX_HYDROLOGY_ABS_HEIGHT_M)));
    const surfaceElevationsM = Object.freeze(surfaceSource.map((entry, index) => canonicalNumber(entry, `${path}.surfaceElevationsM[${index}]`, -MAX_HYDROLOGY_ABS_HEIGHT_M, MAX_HYDROLOGY_ABS_HEIGHT_M)));
    for (let index = 0; index < points.length; index++) {
      if (surfaceElevationsM[index] < terrainElevationsM[index]) fail(`${path}.surfaceElevationsM[${index}] must not be below terrain`);
    }
    const cellIndexes = points.map((point, index) => cellForPoint(point, placement, cellSizeM, rows, cols, `${path}.points[${index}]`));
    if (cellIndexes[0] !== startCell || cellIndexes[cellIndexes.length - 1] !== endCell) fail(`${path} endpoints do not match point cells`);
    for (let index = 1; index < cellIndexes.length; index++) {
      const priorRow = Math.floor(cellIndexes[index - 1] / cols), priorCol = cellIndexes[index - 1] - priorRow * cols;
      const row = Math.floor(cellIndexes[index] / cols), col = cellIndexes[index] - row * cols;
      if (Math.abs(row - priorRow) > 1 || Math.abs(col - priorCol) > 1 || (row === priorRow && col === priorCol)) fail(`${path} contains a non-D8 point edge`);
      if (surfaceElevationsM[index] > surfaceElevationsM[index - 1]) fail(`${path}.surfaceElevationsM rises downstream`);
    }
    totalReachPoints += points.length;
    if (totalReachPoints > WATER_LIMITS.totalWaterwayPoints) fail("hydrology water topology reach points exceed aggregate limits");
    const waterfallSource = denseArray(record.waterfalls.value, 0, points.length - 1, `${path}.waterfalls`, seen);
    let priorEnd = 0;
    const waterfalls = waterfallSource.map((candidateSpan, waterfallIndex) => {
      const spanPath = `${path}.waterfalls[${waterfallIndex}]`;
      const span = exactRecord(candidateSpan, WATERFALL_KEYS, spanPath, seen);
      const startSegment = integer(span.startSegment.value, 0, points.length - 2, `${spanPath}.startSegment`);
      const endSegmentExclusive = integer(span.endSegmentExclusive.value, startSegment + 1, points.length - 1, `${spanPath}.endSegmentExclusive`);
      if (startSegment < priorEnd) fail(`${path}.waterfalls must be ordered and non-overlapping`);
      priorEnd = endSegmentExclusive;
      let totalDropM = 0, maxEdgeDropM = 0;
      for (let segment = startSegment; segment < endSegmentExclusive; segment++) {
        const drop = terrainElevationsM[segment] - terrainElevationsM[segment + 1];
        if (!(drop > 0)) fail(`${spanPath} contains a non-dropping terrain edge`);
        totalDropM += drop;
        if (drop > maxEdgeDropM) maxEdgeDropM = drop;
      }
      if (span.startCell.value !== cellIndexes[startSegment] || span.endCell.value !== cellIndexes[endSegmentExclusive]) fail(`${spanPath} cell endpoints do not match segments`);
      if (!Object.is(span.totalDropM.value, totalDropM) || !Object.is(span.maxEdgeDropM.value, maxEdgeDropM)) fail(`${spanPath} drop metrics do not match terrain elevations`);
      return Object.freeze({ startSegment, endSegmentExclusive, startCell: cellIndexes[startSegment], endCell: cellIndexes[endSegmentExclusive], totalDropM, maxEdgeDropM });
    });
    totalWaterfalls += waterfalls.length;
    if (totalWaterfalls > WATER_LIMITS.totalWaterwayPoints) fail("hydrology water topology waterfall metadata exceeds aggregate limits");
    return Object.freeze({ id, class: className, order, startCell, endCell, points, widths, terrainElevationsM, surfaceElevationsM,
      waterfalls: Object.freeze(waterfalls), cellIndexes: Object.freeze(cellIndexes) });
  });
  return {
    topology: Object.freeze({
      schema: HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA,
      version: HYDROLOGY_COMBINED_WATER_TOPOLOGY_VERSION,
      placement,
      rows,
      cols,
      cellSizeM,
      basins: Object.freeze(basins),
      reaches: Object.freeze(reaches.map(({ cellIndexes: _cells, ...reach }) => Object.freeze(reach))),
      diagnostics: Object.freeze({ source: HYDROLOGY_WATER_ARTIFACT_TYPE, basinCount: basins.length, reachCount: reaches.length,
        basinPointCount: totalBasinPoints, reachPointCount: totalReachPoints, waterfallCount: totalWaterfalls,
        topologyWorkUnits: basinTopology.workUnits }),
    }),
    internalReaches: reaches,
    counts: Object.freeze({ basins: basins.length, rings: totalRings, basinPoints: totalBasinPoints,
      reaches: reaches.length, reachPoints: totalReachPoints, waterfalls: totalWaterfalls }),
  };
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(32);
  const raw = hex.slice(7);
  for (let index = 0; index < 32; index++) bytes[index] = Number.parseInt(raw.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes, offset) {
  let hex = "";
  for (let index = 0; index < 32; index++) hex += bytes[offset + index].toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}

function writeHeader(view, parsed, bindings, layout) {
  for (let index = 0; index < MAGIC.length; index++) view.setUint8(index, MAGIC[index]);
  view.setUint16(8, HYDROLOGY_WATER_ARTIFACT_VERSION, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, HYDROLOGY_WATER_ARTIFACT_HEADER_BYTES, true);
  view.setUint16(14, 0, true);
  view.setUint32(16, layout.byteLength, true);
  view.setUint32(20, parsed.topology.rows, true);
  view.setUint32(24, parsed.topology.cols, true);
  view.setUint32(28, parsed.counts.basins, true);
  view.setUint32(32, parsed.counts.rings, true);
  view.setUint32(36, parsed.counts.basinPoints, true);
  view.setUint32(40, parsed.counts.reaches, true);
  view.setUint32(44, parsed.counts.reachPoints, true);
  view.setUint32(48, parsed.counts.waterfalls, true);
  view.setFloat64(56, parsed.topology.placement.originX, true);
  view.setFloat64(64, parsed.topology.placement.originZ, true);
  view.setFloat64(72, parsed.topology.cellSizeM, true);
  for (const [offset, value] of [[80, layout.basinRecords], [84, layout.ringRecords], [88, layout.basinPointRecords],
    [92, layout.reachRecords], [96, layout.reachPointRecords], [100, layout.waterfallRecords], [104, layout.dataEnd]]) {
    view.setUint32(offset, value, true);
  }
  for (let binding = 0; binding < BINDING_KEYS.length; binding++) {
    const bytes = hexToBytes(bindings[BINDING_KEYS[binding]]);
    for (let index = 0; index < 32; index++) view.setUint8(112 + binding * 32 + index, bytes[index]);
  }
}

export function encodeHydrologyWaterArtifact(topologyInput, bindingsInput, controlInput = undefined) {
  const parsed = parseTopology(topologyInput);
  const bindings = parseBindings(bindingsInput);
  const shouldCancel = parseControl(controlInput);
  const meter = createMeter(shouldCancel, (parsed.counts.basinPoints + parsed.counts.reachPoints + parsed.counts.waterfalls) * 8 + 8192);
  meter.check();
  const layout = layoutForCounts(parsed.counts.basins, parsed.counts.rings, parsed.counts.basinPoints,
    parsed.counts.reaches, parsed.counts.reachPoints, parsed.counts.waterfalls);
  if (layout.byteLength > MAX_HYDROLOGY_WATER_ARTIFACT_BYTES) fail("hydrology water artifact exceeds maximum bytes");
  const bytes = new Uint8Array(layout.byteLength);
  const view = new DataView(bytes.buffer);
  writeHeader(view, parsed, bindings, layout);

  let ringIndex = 0, basinPointIndex = 0;
  for (let basinIndex = 0; basinIndex < parsed.topology.basins.length; basinIndex++) {
    meter.work();
    const basin = parsed.topology.basins[basinIndex];
    const rings = [basin.footprint.points, ...(basin.footprint.holes ?? [])];
    const record = layout.basinRecords + basinIndex * BASIN_RECORD_BYTES;
    view.setUint32(record, basin.seedCell, true);
    view.setUint32(record + 4, basin.spillInsideCell, true);
    view.setUint32(record + 8, basin.spillOutsideCell, true);
    view.setUint32(record + 12, basin.spillOutsideDrainageRank, true);
    view.setUint32(record + 16, ringIndex, true);
    view.setUint32(record + 20, rings.length, true);
    view.setUint32(record + 24, rings.reduce((sum, ring) => sum + ring.length, 0), true);
    view.setFloat64(record + 32, basin.spillLevelM, true);
    view.setFloat64(record + 40, basin.maxDepthM, true);
    view.setFloat64(record + 48, basin.areaM2, true);
    view.setUint32(record + 56, basin.cellCount, true);
    for (let role = 0; role < rings.length; role++) {
      const ring = rings[role], ringRecord = layout.ringRecords + ringIndex * RING_RECORD_BYTES;
      view.setUint32(ringRecord, basinIndex, true);
      view.setUint8(ringRecord + 4, role === 0 ? 0 : 1);
      view.setUint32(ringRecord + 8, basinPointIndex, true);
      view.setUint32(ringRecord + 12, ring.length, true);
      ringIndex++;
      for (const point of ring) {
        meter.work();
        const pointRecord = layout.basinPointRecords + basinPointIndex * BASIN_POINT_BYTES;
        view.setFloat64(pointRecord, point[0], true);
        view.setFloat64(pointRecord + 8, point[1], true);
        basinPointIndex++;
      }
    }
  }

  let reachPointIndex = 0, waterfallIndex = 0;
  for (let reachIndex = 0; reachIndex < parsed.internalReaches.length; reachIndex++) {
    meter.work();
    const reach = parsed.internalReaches[reachIndex], record = layout.reachRecords + reachIndex * REACH_RECORD_BYTES;
    view.setUint32(record, reach.startCell, true);
    view.setUint32(record + 4, reach.endCell, true);
    view.setUint32(record + 8, reachPointIndex, true);
    view.setUint32(record + 12, reach.points.length, true);
    view.setUint32(record + 16, waterfallIndex, true);
    view.setUint32(record + 20, reach.waterfalls.length, true);
    view.setUint8(record + 24, reach.order);
    view.setUint8(record + 25, reach.class === "river" ? 1 : 0);
    for (let point = 0; point < reach.points.length; point++) {
      meter.work();
      const pointRecord = layout.reachPointRecords + reachPointIndex * REACH_POINT_BYTES;
      view.setUint32(pointRecord, reach.cellIndexes[point], true);
      view.setFloat64(pointRecord + 8, reach.points[point][0], true);
      view.setFloat64(pointRecord + 16, reach.points[point][1], true);
      view.setFloat64(pointRecord + 24, reach.widths[point], true);
      view.setFloat64(pointRecord + 32, reach.terrainElevationsM[point], true);
      view.setFloat64(pointRecord + 40, reach.surfaceElevationsM[point], true);
      reachPointIndex++;
    }
    for (const waterfall of reach.waterfalls) {
      meter.work();
      const waterfallRecord = layout.waterfallRecords + waterfallIndex * WATERFALL_RECORD_BYTES;
      view.setUint32(waterfallRecord, reachIndex, true);
      view.setUint32(waterfallRecord + 4, waterfall.startSegment, true);
      view.setUint32(waterfallRecord + 8, waterfall.endSegmentExclusive, true);
      view.setUint32(waterfallRecord + 12, waterfall.startCell, true);
      view.setUint32(waterfallRecord + 16, waterfall.endCell, true);
      view.setFloat64(waterfallRecord + 24, waterfall.totalDropM, true);
      view.setFloat64(waterfallRecord + 32, waterfall.maxEdgeDropM, true);
      waterfallIndex++;
    }
  }
  meter.check();
  return bytes;
}

function ownedByteView(value) {
  if (!ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype) fail("hydrology water artifact bytes must be a Uint8Array");
  if (!(value.buffer instanceof ArrayBuffer) || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    fail("hydrology water artifact bytes must own its complete non-shared ArrayBuffer");
  }
  if (value.byteLength < HYDROLOGY_WATER_ARTIFACT_HEADER_BYTES || value.byteLength > MAX_HYDROLOGY_WATER_ARTIFACT_BYTES) {
    fail("hydrology water artifact byte length is outside supported bounds");
  }
  return value;
}

function verifyZero(bytes, start, end, label) {
  for (let index = start; index < end; index++) if (bytes[index] !== 0) fail(`${label} must be zero`);
}

function inspectHeader(bytes) {
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC.length; index++) if (view.getUint8(index) !== MAGIC[index]) fail("hydrology water artifact magic mismatch");
  if (view.getUint16(8, true) !== HYDROLOGY_WATER_ARTIFACT_VERSION) fail("hydrology water artifact version is unsupported");
  if (view.getUint16(10, true) !== 0) fail("hydrology water artifact flags must be zero");
  if (view.getUint16(12, true) !== HYDROLOGY_WATER_ARTIFACT_HEADER_BYTES) fail("hydrology water artifact header length mismatch");
  if (view.getUint16(14, true) !== 0 || view.getUint32(52, true) !== 0 || view.getUint32(108, true) !== 0) fail("hydrology water artifact reserved header fields must be zero");
  verifyZero(bytes, 240, 256, "hydrology water artifact reserved header bytes");
  const rows = integer(view.getUint32(20, true), 2, MAX_HYDROLOGY_DIMENSION, "hydrology water artifact rows");
  const cols = integer(view.getUint32(24, true), 2, MAX_HYDROLOGY_DIMENSION, "hydrology water artifact cols");
  const cells = rows * cols;
  if (cells > MAX_HYDROLOGY_CELLS) fail("hydrology water artifact grid exceeds supported cells");
  const counts = Object.freeze({
    basins: integer(view.getUint32(28, true), 0, WATER_LIMITS.bodies, "hydrology water artifact basin count"),
    rings: integer(view.getUint32(32, true), 0, MAX_RING_COUNT, "hydrology water artifact ring count"),
    basinPoints: integer(view.getUint32(36, true), 0, WATER_LIMITS.totalBodyPoints, "hydrology water artifact basin point count"),
    reaches: integer(view.getUint32(40, true), 0, WATER_LIMITS.waterways, "hydrology water artifact reach count"),
    reachPoints: integer(view.getUint32(44, true), 0, WATER_LIMITS.totalWaterwayPoints, "hydrology water artifact reach point count"),
    waterfalls: integer(view.getUint32(48, true), 0, WATER_LIMITS.totalWaterwayPoints, "hydrology water artifact waterfall count"),
  });
  if ((counts.basins === 0) !== (counts.rings === 0 && counts.basinPoints === 0)) fail("hydrology water artifact basin section counts are inconsistent");
  if ((counts.reaches === 0) !== (counts.reachPoints === 0 && counts.waterfalls === 0)) fail("hydrology water artifact reach section counts are inconsistent");
  if (counts.rings < counts.basins || counts.basinPoints < counts.rings * 3 || counts.reachPoints < counts.reaches * 2) fail("hydrology water artifact section counts are structurally impossible");
  const layout = layoutForCounts(counts.basins, counts.rings, counts.basinPoints, counts.reaches, counts.reachPoints, counts.waterfalls);
  if (view.getUint32(16, true) !== bytes.byteLength || bytes.byteLength !== layout.byteLength) fail("hydrology water artifact byte length is non-canonical");
  for (const [offset, expected, label] of [[80, layout.basinRecords, "basin"], [84, layout.ringRecords, "ring"],
    [88, layout.basinPointRecords, "basin point"], [92, layout.reachRecords, "reach"], [96, layout.reachPointRecords, "reach point"],
    [100, layout.waterfallRecords, "waterfall"], [104, layout.dataEnd, "data end"]]) {
    if (view.getUint32(offset, true) !== expected) fail(`hydrology water artifact ${label} offset is non-canonical`);
  }
  verifyZero(bytes, layout.dataEnd, layout.byteLength, "hydrology water artifact trailing padding");
  const bindings = {};
  for (let binding = 0; binding < BINDING_KEYS.length; binding++) bindings[BINDING_KEYS[binding]] = bytesToHex(bytes, 112 + binding * 32);
  return Object.freeze({
    view,
    rows,
    cols,
    counts,
    layout,
    bindings: Object.freeze(bindings),
    placement: Object.freeze({
      originX: canonicalNumber(view.getFloat64(56, true), "hydrology water artifact originX", -MAX_ORIGIN_M, MAX_ORIGIN_M),
      originZ: canonicalNumber(view.getFloat64(64, true), "hydrology water artifact originZ", -MAX_ORIGIN_M, MAX_ORIGIN_M),
    }),
    cellSizeM: canonicalNumber(view.getFloat64(72, true), "hydrology water artifact cellSizeM", 0, 1_000_000, true),
  });
}

/** Validate the canonical fixed header and return its four content-addressed bindings without copying or scanning payload records. */
export function inspectHydrologyWaterArtifactBindings(bytesInput) {
  return inspectHeader(ownedByteView(bytesInput)).bindings;
}

export function decodeHydrologyWaterArtifact(bytesInput, expectedBindingsInput = undefined, controlInput = undefined) {
  const bytes = Uint8Array.from(ownedByteView(bytesInput));
  const expectedBindings = expectedBindingsInput === undefined ? undefined : parseBindings(expectedBindingsInput, "expected hydrology water artifact bindings");
  const shouldCancel = parseControl(controlInput);
  const meter = createMeter(shouldCancel, bytes.byteLength + 8192);
  meter.check();
  const header = inspectHeader(bytes);
  const { view, rows, cols, counts, layout, bindings: frozenBindings, placement, cellSizeM } = header;
  if (expectedBindings !== undefined) for (const key of BINDING_KEYS) {
    if (expectedBindings[key] !== frozenBindings[key]) fail(`hydrology water artifact binding '${key}' does not match expected value`);
  }

  const allBasinPoints = new Array(counts.basinPoints);
  for (let index = 0; index < counts.basinPoints; index++) {
    meter.work();
    const offset = layout.basinPointRecords + index * BASIN_POINT_BYTES;
    allBasinPoints[index] = Object.freeze([
      canonicalNumber(view.getFloat64(offset, true), `hydrology water artifact basin point ${index}.x`, -WATER_LIMITS.absCoordinateM, WATER_LIMITS.absCoordinateM),
      canonicalNumber(view.getFloat64(offset + 8, true), `hydrology water artifact basin point ${index}.z`, -WATER_LIMITS.absCoordinateM, WATER_LIMITS.absCoordinateM),
    ]);
  }
  const ringRecords = new Array(counts.rings);
  let expectedBasinPoint = 0;
  for (let index = 0; index < counts.rings; index++) {
    meter.work();
    const offset = layout.ringRecords + index * RING_RECORD_BYTES;
    verifyZero(bytes, offset + 5, offset + 8, `hydrology water artifact ring ${index} reserved bytes`);
    const pointStart = view.getUint32(offset + 8, true), pointCount = view.getUint32(offset + 12, true);
    if (pointStart !== expectedBasinPoint || pointCount < 3 || pointCount > WATER_LIMITS.ringPoints || pointStart + pointCount > counts.basinPoints) fail(`hydrology water artifact ring ${index} point range is non-canonical`);
    expectedBasinPoint += pointCount;
    ringRecords[index] = { basinIndex: view.getUint32(offset, true), role: view.getUint8(offset + 4), pointStart, pointCount };
  }
  if (expectedBasinPoint !== counts.basinPoints) fail("hydrology water artifact basin points are not completely referenced");
  const basins = new Array(counts.basins);
  let expectedRing = 0;
  for (let index = 0; index < counts.basins; index++) {
    meter.work();
    const offset = layout.basinRecords + index * BASIN_RECORD_BYTES;
    verifyZero(bytes, offset + 28, offset + 32, `hydrology water artifact basin ${index} reserved bytes`);
    verifyZero(bytes, offset + 60, offset + 64, `hydrology water artifact basin ${index} trailing reserved bytes`);
    const ringStart = view.getUint32(offset + 16, true), ringCount = view.getUint32(offset + 20, true);
    if (ringStart !== expectedRing || ringCount < 1 || ringCount > WATER_LIMITS.holes + 1 || ringStart + ringCount > counts.rings) fail(`hydrology water artifact basin ${index} ring range is non-canonical`);
    expectedRing += ringCount;
    let pointCount = 0;
    const rings = [];
    for (let ring = ringStart; ring < ringStart + ringCount; ring++) {
      const record = ringRecords[ring];
      if (record.basinIndex !== index || record.role !== (ring === ringStart ? 0 : 1)) fail(`hydrology water artifact basin ${index} ring ownership/role is inconsistent`);
      rings.push(Object.freeze(allBasinPoints.slice(record.pointStart, record.pointStart + record.pointCount)));
      pointCount += record.pointCount;
    }
    if (view.getUint32(offset + 24, true) !== pointCount) fail(`hydrology water artifact basin ${index} point count is inconsistent`);
    const seedCell = view.getUint32(offset, true), spillOutsideCell = view.getUint32(offset + 8, true);
    basins[index] = Object.freeze({
      id: `gen-b-${spillOutsideCell.toString(36)}-${seedCell.toString(36)}`,
      kind: "lake",
      spillLevelM: view.getFloat64(offset + 32, true),
      maxDepthM: view.getFloat64(offset + 40, true),
      areaM2: view.getFloat64(offset + 48, true),
      cellCount: view.getUint32(offset + 56, true),
      seedCell,
      spillInsideCell: view.getUint32(offset + 4, true),
      spillOutsideCell,
      spillOutsideDrainageRank: view.getUint32(offset + 12, true),
      footprint: Object.freeze({ points: rings[0], holes: Object.freeze(rings.slice(1)) }),
    });
  }
  if (expectedRing !== counts.rings) fail("hydrology water artifact rings are not completely referenced");

  const allReachPoints = new Array(counts.reachPoints);
  const allReachCells = new Uint32Array(counts.reachPoints);
  for (let index = 0; index < counts.reachPoints; index++) {
    meter.work();
    const offset = layout.reachPointRecords + index * REACH_POINT_BYTES;
    verifyZero(bytes, offset + 4, offset + 8, `hydrology water artifact reach point ${index} reserved bytes`);
    allReachCells[index] = view.getUint32(offset, true);
    allReachPoints[index] = {
      point: Object.freeze([view.getFloat64(offset + 8, true), view.getFloat64(offset + 16, true)]),
      width: view.getFloat64(offset + 24, true),
      terrain: view.getFloat64(offset + 32, true),
      surface: view.getFloat64(offset + 40, true),
    };
  }
  const waterfallRecords = new Array(counts.waterfalls);
  for (let index = 0; index < counts.waterfalls; index++) {
    meter.work();
    const offset = layout.waterfallRecords + index * WATERFALL_RECORD_BYTES;
    verifyZero(bytes, offset + 20, offset + 24, `hydrology water artifact waterfall ${index} reserved bytes`);
    waterfallRecords[index] = { reachIndex: view.getUint32(offset, true), startSegment: view.getUint32(offset + 4, true),
      endSegmentExclusive: view.getUint32(offset + 8, true), startCell: view.getUint32(offset + 12, true),
      endCell: view.getUint32(offset + 16, true), totalDropM: view.getFloat64(offset + 24, true), maxEdgeDropM: view.getFloat64(offset + 32, true) };
  }
  const reaches = new Array(counts.reaches);
  let expectedReachPoint = 0, expectedWaterfall = 0;
  for (let index = 0; index < counts.reaches; index++) {
    meter.work();
    const offset = layout.reachRecords + index * REACH_RECORD_BYTES;
    verifyZero(bytes, offset + 26, offset + 32, `hydrology water artifact reach ${index} reserved bytes`);
    const pointStart = view.getUint32(offset + 8, true), pointCount = view.getUint32(offset + 12, true);
    const waterfallStart = view.getUint32(offset + 16, true), waterfallCount = view.getUint32(offset + 20, true);
    if (pointStart !== expectedReachPoint || pointCount < 2 || pointCount > WATER_LIMITS.waterwayPoints || pointStart + pointCount > counts.reachPoints) fail(`hydrology water artifact reach ${index} point range is non-canonical`);
    if (waterfallStart !== expectedWaterfall || waterfallStart + waterfallCount > counts.waterfalls) fail(`hydrology water artifact reach ${index} waterfall range is non-canonical`);
    expectedReachPoint += pointCount;
    expectedWaterfall += waterfallCount;
    const source = allReachPoints.slice(pointStart, pointStart + pointCount);
    const startCell = view.getUint32(offset, true), endCell = view.getUint32(offset + 4, true), order = view.getUint8(offset + 24), classCode = view.getUint8(offset + 25);
    if (classCode > 1) fail(`hydrology water artifact reach ${index} class code is invalid`);
    for (let point = 0; point < source.length; point++) {
      const expectedCell = cellForPoint(source[point].point, placement, cellSizeM, rows, cols, `hydrology water artifact reach ${index} point ${point}`);
      if (allReachCells[pointStart + point] !== expectedCell) fail(`hydrology water artifact reach ${index} point ${point} cell index is inconsistent`);
    }
    const spans = waterfallRecords.slice(waterfallStart, waterfallStart + waterfallCount);
    for (const span of spans) if (span.reachIndex !== index) fail(`hydrology water artifact waterfall ownership is inconsistent at reach ${index}`);
    reaches[index] = Object.freeze({
      id: `gen-r-${startCell.toString(36)}-${endCell.toString(36)}`,
      class: classCode === 1 ? "river" : "stream",
      order,
      startCell,
      endCell,
      points: Object.freeze(source.map((entry) => entry.point)),
      widths: Object.freeze(source.map((entry) => entry.width)),
      terrainElevationsM: Object.freeze(source.map((entry) => entry.terrain)),
      surfaceElevationsM: Object.freeze(source.map((entry) => entry.surface)),
      waterfalls: Object.freeze(spans.map(({ reachIndex: _reach, ...span }) => Object.freeze(span))),
    });
  }
  if (expectedReachPoint !== counts.reachPoints || expectedWaterfall !== counts.waterfalls) fail("hydrology water artifact reach sections are not completely referenced");
  const candidate = {
    schema: HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA,
    version: HYDROLOGY_COMBINED_WATER_TOPOLOGY_VERSION,
    placement,
    rows,
    cols,
    cellSizeM,
    basins,
    reaches,
    diagnostics: { source: HYDROLOGY_WATER_ARTIFACT_TYPE },
  };
  const parsed = parseTopology(candidate);
  meter.check();
  return Object.freeze({
    bindings: frozenBindings,
    topology: parsed.topology,
    artifact: Object.freeze({ artifactType: HYDROLOGY_WATER_ARTIFACT_TYPE, mediaType: HYDROLOGY_WATER_ARTIFACT_MEDIA_TYPE,
      byteLength: bytes.byteLength, offsets: layout, counts: Object.freeze(counts), validation: meter.snapshot() }),
  });
}
