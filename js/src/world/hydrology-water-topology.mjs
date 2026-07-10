import { parseAuthoredHydrologyRecipe } from "./hydrology-ir.mjs";
import {
  HydrologyArtifactCancelledError,
  decodeHydrologyFieldArtifact,
  encodeHydrologyFieldArtifact,
} from "./hydrology-artifact.mjs";
import { MAX_HYDROLOGY_ABS_HEIGHT_M, MAX_HYDROLOGY_CELLS } from "./hydrology-topology.mjs";
import { inspectWaterBodyTopology, WATER_LIMITS } from "./water-ir.mjs";

export const HYDROLOGY_WATER_TOPOLOGY_SCHEMA = "limina.hydrology-water-topology/v1";
export const HYDROLOGY_WATER_TOPOLOGY_VERSION = 1;
export const HYDROLOGY_REACH_TOPOLOGY_SCHEMA = "limina.hydrology-reaches/v1";
export const HYDROLOGY_REACH_TOPOLOGY_VERSION = 1;
export const HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA = "limina.hydrology-generated-water/v1";
export const HYDROLOGY_COMBINED_WATER_TOPOLOGY_VERSION = 1;

const INPUT_KEYS = new Set(["heightsM", "topology", "placement", "recipe"]);
const CONTROL_KEYS = new Set(["shouldCancel"]);
const CARDINAL_OFFSETS = Object.freeze([[-1, 0], [0, -1], [0, 1], [1, 0]]);
const CASE_SEGMENTS = Object.freeze([
  [], [[0, 3]], [[0, 1]], [[3, 1]], [[1, 2]], [[0, 3], [1, 2]], [[0, 2]], [[3, 2]],
  [[3, 2]], [[0, 2]], [[0, 1], [3, 2]], [[1, 2]], [[3, 1]], [[0, 1]], [[0, 3]], [],
]);

export class HydrologyWaterTopologyValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "HydrologyWaterTopologyValidationError";
    this.code = "hydrology_water_topology_invalid";
  }
}

export class HydrologyWaterTopologyCancelledError extends Error {
  constructor() {
    super("hydrology water topology operation cancelled");
    this.name = "HydrologyWaterTopologyCancelledError";
    this.code = "hydrology_water_topology_cancelled";
  }
}

function fail(message) { throw new HydrologyWaterTopologyValidationError(message); }

function exactRecord(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!keys.has(key)) fail(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor) || descriptor.enumerable !== true) fail(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${label} is missing '${key}'`);
  return descriptors;
}

function snapshotHeights(value) {
  if (!ArrayBuffer.isView(value)
      || (Object.getPrototypeOf(value) !== Float32Array.prototype && Object.getPrototypeOf(value) !== Float64Array.prototype)) {
    fail("hydrology extraction heightsM must be a Float32Array or Float64Array");
  }
  if (!(value.buffer instanceof ArrayBuffer) || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    fail("hydrology extraction heightsM must own its complete non-shared ArrayBuffer");
  }
  if (value.length < 4 || value.length > MAX_HYDROLOGY_CELLS) fail("hydrology extraction heightsM length is outside supported bounds");
  const copy = new Float64Array(value.length);
  for (let index = 0; index < value.length; index++) {
    const height = value[index];
    if (!Number.isFinite(height) || Object.is(height, -0) || Math.abs(height) > MAX_HYDROLOGY_ABS_HEIGHT_M) {
      fail(`hydrology extraction heightsM[${index}] must be finite, canonical, and within +/-${MAX_HYDROLOGY_ABS_HEIGHT_M}m`);
    }
    copy[index] = height;
  }
  return copy;
}

function parseControl(value) {
  if (value === undefined) return undefined;
  const descriptors = exactRecord(value, CONTROL_KEYS, "hydrology extraction control");
  if (typeof descriptors.shouldCancel.value !== "function") fail("hydrology extraction control.shouldCancel must be a function");
  return descriptors.shouldCancel.value;
}

function createMeter(shouldCancel, limit) {
  let workUnits = 0, cancellationChecks = 0;
  const check = () => {
    cancellationChecks++;
    if (shouldCancel?.()) throw new HydrologyWaterTopologyCancelledError();
  };
  const work = (amount = 1) => {
    workUnits += amount;
    if (workUnits > limit) fail(`hydrology basin extraction exceeds ${limit} bounded work units`);
    if ((workUnits & 1023) === 0) check();
  };
  return { work, check, snapshot: () => Object.freeze({ workUnits, workLimit: limit, cancellationChecks }) };
}

function compareVertex(a, b) { return a[0] - b[0] || a[1] - b[1]; }
function vertexKey(x, z) { return `${x},${z}`; }

function rotateToMinimum(ring) {
  let minimum = 0;
  for (let index = 1; index < ring.length; index++) if (compareVertex(ring[index], ring[minimum]) < 0) minimum = index;
  if (minimum === 0) return ring;
  return ring.slice(minimum).concat(ring.slice(0, minimum));
}

function removeCollinear(ring) {
  if (ring.length <= 3) return ring;
  let current = ring;
  for (;;) {
    const next = [];
    for (let index = 0; index < current.length; index++) {
      const prior = current[(index + current.length - 1) % current.length];
      const point = current[index];
      const after = current[(index + 1) % current.length];
      const cross = (point[0] - prior[0]) * (after[1] - point[1]) - (point[1] - prior[1]) * (after[0] - point[0]);
      if (cross !== 0) next.push(point);
    }
    if (next.length < 3) fail("hydrology basin contour collapsed below three vertices");
    if (next.length === current.length) return rotateToMinimum(next);
    current = next;
  }
}

function twiceArea(ring) {
  const origin = ring[0];
  let area = 0;
  for (let index = 1; index < ring.length - 1; index++) {
    const point = ring[index], next = ring[index + 1];
    area += (point[0] - origin[0]) * (next[1] - origin[1]) - (next[0] - origin[0]) * (point[1] - origin[1]);
  }
  if (!Number.isFinite(area) || area === 0) fail("hydrology basin contour has zero or non-finite area");
  return area;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, prior = ring.length - 1; index < ring.length; prior = index++) {
    const a = ring[prior], b = ring[index];
    const cross = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
    if (cross === 0 && point[0] >= Math.min(a[0], b[0]) && point[0] <= Math.max(a[0], b[0])
        && point[1] >= Math.min(a[1], b[1]) && point[1] <= Math.max(a[1], b[1])) return 0;
    if ((a[1] > point[1]) !== (b[1] > point[1])
        && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside ? 1 : -1;
}

function traceRings(segmentValues, meter) {
  const segmentCount = segmentValues.length / 4;
  const endpoints = new Map();
  for (let segment = 0; segment < segmentCount; segment++) {
    meter.work();
    for (let endpoint = 0; endpoint < 2; endpoint++) {
      const offset = segment * 4 + endpoint * 2;
      const key = vertexKey(segmentValues[offset], segmentValues[offset + 1]);
      let adjacent = endpoints.get(key);
      if (adjacent === undefined) endpoints.set(key, adjacent = []);
      adjacent.push(segment);
      if (adjacent.length > 2) fail("hydrology basin contour has a non-manifold marching-squares vertex");
    }
  }
  for (const adjacent of endpoints.values()) if (adjacent.length !== 2) fail("hydrology basin contour is open");
  const used = new Uint8Array(segmentCount);
  const rings = [];
  for (let startSegment = 0; startSegment < segmentCount; startSegment++) {
    if (used[startSegment] !== 0) continue;
    const startOffset = startSegment * 4;
    const start = [segmentValues[startOffset], segmentValues[startOffset + 1]];
    const ring = [start];
    let current = start, segment = startSegment;
    for (;;) {
      meter.work();
      if (used[segment] !== 0) fail("hydrology basin contour revisited an edge before closure");
      used[segment] = 1;
      const offset = segment * 4;
      const a = [segmentValues[offset], segmentValues[offset + 1]];
      const b = [segmentValues[offset + 2], segmentValues[offset + 3]];
      const next = a[0] === current[0] && a[1] === current[1] ? b : a;
      if (next[0] === start[0] && next[1] === start[1]) break;
      ring.push(next);
      const adjacent = endpoints.get(vertexKey(next[0], next[1]));
      const nextSegment = adjacent[0] === segment ? adjacent[1] : adjacent[0];
      segment = nextSegment;
      current = next;
      if (ring.length > segmentCount) fail("hydrology basin contour traversal did not close");
    }
    rings.push(removeCollinear(ring));
  }
  return rings;
}

function classifyRings(rings) {
  const areas = rings.map((ring) => twiceArea(ring));
  const parents = new Int32Array(rings.length);
  parents.fill(-1);
  for (let index = 0; index < rings.length; index++) {
    let parentArea = Infinity;
    for (let other = 0; other < rings.length; other++) {
      if (index === other || Math.abs(areas[other]) <= Math.abs(areas[index])) continue;
      const classification = pointInRing(rings[index][0], rings[other]);
      if (classification === 0) fail("hydrology basin contour rings touch at a vertex");
      if (classification === 1 && Math.abs(areas[other]) < parentArea) {
        parents[index] = other;
        parentArea = Math.abs(areas[other]);
      }
    }
  }
  const outers = [];
  for (let index = 0; index < rings.length; index++) if (parents[index] < 0) outers.push(index);
  if (outers.length !== 1) fail(`hydrology basin component produced ${outers.length} outer contours`);
  const outerIndex = outers[0];
  const holeIndexes = [];
  for (let index = 0; index < rings.length; index++) {
    if (index === outerIndex) continue;
    if (parents[index] !== outerIndex) fail("hydrology basin contour nesting exceeds one outer plus holes");
    holeIndexes.push(index);
  }
  let outer = rings[outerIndex];
  if (areas[outerIndex] < 0) outer = rotateToMinimum(outer.slice().reverse());
  const holes = holeIndexes.map((index) => areas[index] > 0
    ? rotateToMinimum(rings[index].slice().reverse())
    : rotateToMinimum(rings[index]));
  holes.sort((left, right) => compareVertex(left[0], right[0]));
  const netTwiceArea = Math.abs(twiceArea(outer)) - holes.reduce((sum, hole) => sum + Math.abs(twiceArea(hole)), 0);
  if (!(netTwiceArea > 0)) fail("hydrology basin holes consume the complete footprint");
  return { outer, holes, netTwiceArea };
}

function worldRing(ring, placement, cellSizeM) {
  return Object.freeze(ring.map(([x2, z2]) => {
    const x = placement.originX + x2 * cellSizeM / 2;
    const z = placement.originZ + z2 * cellSizeM / 2;
    if (!Number.isFinite(x) || !Number.isFinite(z) || Object.is(x, -0) || Object.is(z, -0)
        || Math.abs(x) > WATER_LIMITS.absCoordinateM || Math.abs(z) > WATER_LIMITS.absCoordinateM) {
      fail(`hydrology basin contour coordinate must be canonical and within +/-${WATER_LIMITS.absCoordinateM}m`);
    }
    return Object.freeze([x, z]);
  }));
}

function endpoint(edge, col, row) {
  if (edge === 0) return [col * 2 + 1, row * 2];
  if (edge === 1) return [col * 2 + 2, row * 2 + 1];
  if (edge === 2) return [col * 2 + 1, row * 2 + 2];
  return [col * 2, row * 2 + 1];
}

function appendQuadSegments(segments, labels, indexes, candidateByLabel, col, row) {
  const uniqueLabels = [];
  for (const index of indexes) {
    const label = labels[index];
    if (label > 0 && candidateByLabel[label] >= 0 && !uniqueLabels.includes(label)) uniqueLabels.push(label);
  }
  for (const label of uniqueLabels) {
    const candidate = candidateByLabel[label];
    let mask = 0;
    if (labels[indexes[0]] === label) mask |= 1;
    if (labels[indexes[1]] === label) mask |= 2;
    if (labels[indexes[2]] === label) mask |= 4;
    if (labels[indexes[3]] === label) mask |= 8;
    for (const [first, second] of CASE_SEGMENTS[mask]) {
      const a = endpoint(first, col, row), b = endpoint(second, col, row);
      segments[candidate].push(a[0], a[1], b[0], b[1]);
    }
  }
}

function verifyExtractionInput(input, controlInput) {
  const descriptors = exactRecord(input, INPUT_KEYS, "hydrology extraction input");
  const heightsM = snapshotHeights(descriptors.heightsM.value);
  let recipe;
  try { recipe = parseAuthoredHydrologyRecipe(descriptors.recipe.value); }
  catch (error) { fail(error instanceof Error ? error.message : "hydrology extraction recipe is invalid"); }
  const shouldCancel = parseControl(controlInput);
  let verified;
  try {
    const bytes = encodeHydrologyFieldArtifact(
      descriptors.topology.value,
      descriptors.placement.value,
      shouldCancel === undefined ? undefined : { shouldCancel },
    );
    verified = decodeHydrologyFieldArtifact(bytes, shouldCancel === undefined ? undefined : { shouldCancel });
  } catch (error) {
    if (error instanceof HydrologyArtifactCancelledError) throw new HydrologyWaterTopologyCancelledError();
    fail(error instanceof Error ? error.message : "hydrology extraction topology is invalid");
  }
  const topology = verified.topology, placement = verified.placement;
  if (heightsM.length !== topology.cellCount) fail("hydrology extraction heightsM length does not match topology dimensions");
  if (recipe.precipitationMmPerYear !== topology.precipitationMmPerYear) {
    fail("hydrology extraction recipe precipitation does not match hydrology topology");
  }
  return { heightsM, recipe, shouldCancel, topology, placement };
}

function extractBasinsVerified({ heightsM, recipe, shouldCancel, topology, placement }) {
  const meter = createMeter(shouldCancel, topology.cellCount * 96 + WATER_LIMITS.topologyWorkUnits * 4 + 4096);
  meter.check();

  const labels = new Int32Array(topology.cellCount);
  const queue = new Int32Array(topology.cellCount);
  const componentSeeds = new Int32Array(topology.cellCount + 1);
  const componentSpillLevelsM = new Float64Array(topology.cellCount + 1);
  const componentMaxDepthsM = new Float64Array(topology.cellCount + 1);
  const componentCellCounts = new Uint32Array(topology.cellCount + 1);
  const componentSpillRanks = new Uint32Array(topology.cellCount + 1);
  const componentSpillOutside = new Int32Array(topology.cellCount + 1);
  const componentSpillInside = new Int32Array(topology.cellCount + 1);
  const typedScratchBytes = labels.byteLength + queue.byteLength + componentSeeds.byteLength
    + componentSpillLevelsM.byteLength + componentMaxDepthsM.byteLength + componentCellCounts.byteLength
    + componentSpillRanks.byteLength + componentSpillOutside.byteLength + componentSpillInside.byteLength;
  let componentCount = 0, raisedCellCount = 0;
  for (let seed = 0; seed < topology.cellCount; seed++) {
    meter.work();
    if (labels[seed] !== 0 || topology.oceanMask[seed] !== 0 || !(topology.filledHeightM[seed] > heightsM[seed])) continue;
    const label = ++componentCount;
    const spillLevelM = topology.filledHeightM[seed];
    let head = 0, tail = 0, cellCount = 0, maxDepthM = 0;
    let spillRank = Infinity, spillOutside = -1, spillInside = -1;
    labels[seed] = label;
    queue[tail++] = seed;
    while (head < tail) {
      meter.work();
      const index = queue[head++];
      cellCount++;
      raisedCellCount++;
      const depthM = topology.filledHeightM[index] - heightsM[index];
      if (!Number.isFinite(depthM) || !(depthM > 0)) fail("hydrology basin depth is non-finite or non-positive");
      if (depthM > maxDepthM) maxDepthM = depthM;
      const row = Math.floor(index / topology.cols), col = index - row * topology.cols;
      for (const [dr, dc] of CARDINAL_OFFSETS) {
        const nextRow = row + dr, nextCol = col + dc;
        if (nextRow < 0 || nextRow >= topology.rows || nextCol < 0 || nextCol >= topology.cols) continue;
        const next = nextRow * topology.cols + nextCol;
        if (labels[next] === 0 && topology.oceanMask[next] === 0 && topology.filledHeightM[next] === spillLevelM
            && topology.filledHeightM[next] > heightsM[next]) {
          labels[next] = label;
          queue[tail++] = next;
        }
      }
    }
    // Label the complete 4-connected component before classifying receiver exits. A diagonal
    // receiver can have the same spill level while still belonging to another surface component.
    for (let position = 0; position < tail; position++) {
      meter.work();
      const index = queue[position], receiver = topology.receiver[index];
      if (receiver < 0 || labels[receiver] === label) continue;
      const rank = topology.drainageRank[receiver];
      if (rank < spillRank || (rank === spillRank && (receiver < spillOutside || (receiver === spillOutside && index < spillInside)))) {
        spillRank = rank; spillOutside = receiver; spillInside = index;
      }
    }
    if (spillOutside < 0) fail(`hydrology basin component at cell ${seed} has no canonical spill edge`);
    componentSeeds[label] = seed;
    componentSpillLevelsM[label] = spillLevelM;
    componentMaxDepthsM[label] = maxDepthM;
    componentCellCounts[label] = cellCount;
    componentSpillRanks[label] = spillRank;
    componentSpillOutside[label] = spillOutside;
    componentSpillInside[label] = spillInside;
  }

  const candidates = [];
  const candidateByLabel = new Int32Array(componentCount + 1);
  candidateByLabel.fill(-1);
  for (let label = 1; label <= componentCount; label++) {
    if (componentMaxDepthsM[label] < recipe.basinMinDepthM
        || componentCellCounts[label] * topology.cellAreaM2 < recipe.basinMinAreaM2) continue;
    if (candidates.length >= WATER_LIMITS.bodies) fail(`generated hydrology basins exceed ${WATER_LIMITS.bodies} bodies before contouring`);
    candidateByLabel[label] = candidates.length;
    candidates.push({
      label,
      seed: componentSeeds[label],
      spillLevelM: componentSpillLevelsM[label],
      maxDepthM: componentMaxDepthsM[label],
      cellCount: componentCellCounts[label],
      spillOutsideDrainageRank: componentSpillRanks[label],
      spillOutside: componentSpillOutside[label],
      spillInside: componentSpillInside[label],
    });
  }

  const segments = Array.from({ length: candidates.length }, () => []);
  for (let row = 0; row < topology.rows - 1; row++) {
    for (let col = 0; col < topology.cols - 1; col++) {
      meter.work();
      const topLeft = row * topology.cols + col;
      appendQuadSegments(segments, labels, [topLeft, topLeft + 1, topLeft + topology.cols + 1, topLeft + topology.cols], candidateByLabel, col, row);
    }
  }

  const basins = [];
  let totalPoints = 0, rawSegments = 0, contourPoints = 0;
  for (let candidate = 0; candidate < candidates.length; candidate++) {
    const component = candidates[candidate];
    rawSegments += segments[candidate].length / 4;
    if (segments[candidate].length === 0) fail(`hydrology basin ${component.seed} has no contour`);
    const traced = traceRings(segments[candidate], meter);
    if (traced.length > WATER_LIMITS.holes + 1) fail(`generated hydrology basin '${component.seed}' exceeds ${WATER_LIMITS.holes} holes`);
    if (traced.some((ring) => ring.length > WATER_LIMITS.ringPoints)) {
      fail(`generated hydrology basin '${component.seed}' exceeds ${WATER_LIMITS.ringPoints} points in one ring after exact collinear simplification`);
    }
    if (traced.reduce((sum, ring) => sum + ring.length, 0) > WATER_LIMITS.bodyPoints) {
      fail(`generated hydrology basin '${component.seed}' exceeds ${WATER_LIMITS.bodyPoints} points`);
    }
    const classified = classifyRings(traced);
    const areaM2 = classified.netTwiceArea * topology.cellAreaM2 / 8;
    if (!Number.isFinite(areaM2) || !(areaM2 > 0)) fail("hydrology basin area is non-finite or non-positive");
    if (areaM2 < recipe.basinMinAreaM2) continue;
    if (component.maxDepthM > WATER_LIMITS.depthM) fail(`generated hydrology basin depth exceeds ${WATER_LIMITS.depthM}m`);
    if (component.spillLevelM < -WATER_LIMITS.absLevelM || component.spillLevelM > WATER_LIMITS.absLevelM) {
      fail(`generated hydrology basin level exceeds +/-${WATER_LIMITS.absLevelM}m`);
    }
    const outer = worldRing(classified.outer, placement, topology.cellSizeM);
    const holes = Object.freeze(classified.holes.map((ring) => worldRing(ring, placement, topology.cellSizeM)));
    const points = outer.length + holes.reduce((sum, hole) => sum + hole.length, 0);
    if (outer.length > WATER_LIMITS.ringPoints || holes.some((hole) => hole.length > WATER_LIMITS.ringPoints)
        || holes.length > WATER_LIMITS.holes || points > WATER_LIMITS.bodyPoints) {
      fail(`generated hydrology basin '${component.seed}' exceeds WaterBody geometry limits`);
    }
    totalPoints += points;
    if (totalPoints > WATER_LIMITS.totalBodyPoints) fail(`generated hydrology basin geometry exceeds ${WATER_LIMITS.totalBodyPoints} total points`);
    contourPoints += points;
    const footprint = Object.freeze({ points: outer, ...(holes.length > 0 ? { holes } : {}) });
    basins.push(Object.freeze({
      id: `gen-b-${component.spillOutside.toString(36)}-${component.seed.toString(36)}`,
      kind: "lake",
      spillLevelM: component.spillLevelM,
      maxDepthM: component.maxDepthM,
      areaM2,
      cellCount: component.cellCount,
      seedCell: component.seed,
      spillInsideCell: component.spillInside,
      spillOutsideCell: component.spillOutside,
      spillOutsideDrainageRank: component.spillOutsideDrainageRank,
      footprint,
    }));
  }
  basins.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const topologyCheck = inspectWaterBodyTopology(basins.map((basin) => ({ footprint: basin.footprint })));
  if (!topologyCheck.ok) fail(topologyCheck.message);
  meter.check();
  return Object.freeze({
    schema: HYDROLOGY_WATER_TOPOLOGY_SCHEMA,
    version: HYDROLOGY_WATER_TOPOLOGY_VERSION,
    placement,
    rows: topology.rows,
    cols: topology.cols,
    cellSizeM: topology.cellSizeM,
    basins: Object.freeze(basins),
    diagnostics: Object.freeze({
      ...meter.snapshot(),
      raisedCellCount,
      componentCount,
      candidateCount: candidates.length,
      basinCount: basins.length,
      rawSegments,
      contourPoints,
      topologyWorkUnits: topologyCheck.workUnits,
      ownedTerrainBytes: heightsM.byteLength,
      typedScratchBytes,
      constrainedSimplificationToleranceM: topology.cellSizeM * 0.25,
      constrainedSimplificationApplied: false,
      simplificationPolicy: "exact-collinear-only; over-limit contours fail closed",
    }),
  });
}

/** Extract thresholded standing-water basins without mutating authored WorldMap water. */
export function extractHydrologyBasins(input, controlInput = undefined) {
  return extractBasinsVerified(verifyExtractionInput(input, controlInput));
}

function reachPoint(index, topology, placement) {
  const row = Math.floor(index / topology.cols), col = index - row * topology.cols;
  let x = placement.originX + col * topology.cellSizeM;
  let z = placement.originZ + row * topology.cellSizeM;
  if (Object.is(x, -0)) x = 0;
  if (Object.is(z, -0)) z = 0;
  if (!Number.isFinite(x) || !Number.isFinite(z)
      || Math.abs(x) > WATER_LIMITS.absCoordinateM || Math.abs(z) > WATER_LIMITS.absCoordinateM) {
    fail(`hydrology reach coordinate must be canonical and within +/-${WATER_LIMITS.absCoordinateM}m`);
  }
  return Object.freeze([x, z]);
}

function reachWidth(index, topology, minimumCatchmentAreaM2) {
  const ratio = topology.catchmentAreaM2[index] / minimumCatchmentAreaM2;
  const widthM = Math.min(
    32 * topology.cellSizeM,
    Math.max(0.5 * topology.cellSizeM, topology.cellSizeM * Math.sqrt(ratio)),
  );
  if (!Number.isFinite(widthM) || !(widthM > 0) || widthM > WATER_LIMITS.widthM) {
    fail(`hydrology reach width at cell ${index} must be finite, positive, and at most ${WATER_LIMITS.widthM}m`);
  }
  return widthM;
}

function freezeWaterfall(span) {
  return Object.freeze({
    startSegment: span.startSegment,
    endSegmentExclusive: span.endSegmentExclusive,
    startCell: span.startCell,
    endCell: span.endCell,
    totalDropM: span.totalDropM,
    maxEdgeDropM: span.maxEdgeDropM,
  });
}

function extractReachesVerified({ heightsM, recipe, shouldCancel, topology, placement }) {
  const meter = createMeter(shouldCancel, topology.cellCount * 80 + WATER_LIMITS.totalWaterwayPoints * 16 + 4096);
  meter.check();
  const active = new Uint8Array(topology.cellCount);
  const activeDonors = new Uint8Array(topology.cellCount);
  const visitedEdges = new Uint8Array(topology.cellCount);
  let activeCellCount = 0;
  for (let index = 0; index < topology.cellCount; index++) {
    meter.work();
    if (topology.oceanMask[index] === 0 && topology.catchmentAreaM2[index] >= recipe.riverMinCatchmentAreaM2) {
      active[index] = 1;
      activeCellCount++;
    }
  }

  let expectedEdgeCount = 0;
  for (let index = 0; index < topology.cellCount; index++) {
    meter.work();
    if (active[index] === 0) continue;
    const receiver = topology.receiver[index];
    if (receiver < 0) continue;
    const row = Math.floor(index / topology.cols), col = index - row * topology.cols;
    const receiverRow = Math.floor(receiver / topology.cols), receiverCol = receiver - receiverRow * topology.cols;
    if (Math.abs(receiverRow - row) > 1 || Math.abs(receiverCol - col) > 1
        || (receiverRow === row && receiverCol === col)) {
      fail(`hydrology reach receiver edge ${index}->${receiver} is not D8-adjacent`);
    }
    expectedEdgeCount++;
    if (active[receiver] !== 0) {
      if (activeDonors[receiver] === 255) fail(`hydrology reach active donor count overflows at cell ${receiver}`);
      activeDonors[receiver]++;
    }
  }

  const isNode = (index) => {
    if (active[index] === 0) return false;
    const receiver = topology.receiver[index];
    return activeDonors[index] !== 1 || receiver < 0 || active[receiver] === 0 || topology.oceanMask[receiver] !== 0;
  };
  let nodeCount = 0, outgoingNodeCount = 0;
  for (let index = 0; index < topology.cellCount; index++) {
    meter.work();
    if (!isNode(index)) continue;
    nodeCount++;
    if (topology.receiver[index] >= 0) outgoingNodeCount++;
  }
  if (outgoingNodeCount > WATER_LIMITS.waterways) {
    fail(`generated hydrology reaches exceed ${WATER_LIMITS.waterways} waterways`);
  }
  if (expectedEdgeCount + outgoingNodeCount > WATER_LIMITS.totalWaterwayPoints) {
    fail(`generated hydrology reach geometry exceeds ${WATER_LIMITS.totalWaterwayPoints} total points`);
  }

  const reaches = [];
  let totalPoints = 0, visitedEdgeCount = 0, waterfallSpanCount = 0;
  for (let start = 0; start < topology.cellCount; start++) {
    meter.work();
    if (!isNode(start) || topology.receiver[start] < 0) continue;
    const points = [reachPoint(start, topology, placement)];
    const widths = [reachWidth(start, topology, recipe.riverMinCatchmentAreaM2)];
    const terrainElevationsM = [heightsM[start]];
    const surfaceElevationsM = [topology.filledHeightM[start]];
    const waterfalls = [];
    let openWaterfall = null;
    let current = start, end = start, maximumOrder = topology.streamOrder[start];
    for (;;) {
      meter.work();
      const downstream = topology.receiver[current];
      if (downstream < 0) fail(`hydrology reach from cell ${start} terminated before its declared node edge`);
      if (visitedEdges[current] !== 0) fail(`hydrology reach edge from cell ${current} was traced more than once`);
      visitedEdges[current] = 1;
      visitedEdgeCount++;
      const segment = points.length - 1;
      end = downstream;
      points.push(reachPoint(downstream, topology, placement));
      widths.push(reachWidth(downstream, topology, recipe.riverMinCatchmentAreaM2));
      terrainElevationsM.push(heightsM[downstream]);
      surfaceElevationsM.push(topology.filledHeightM[downstream]);

      const dropM = heightsM[current] - heightsM[downstream];
      if (!Number.isFinite(dropM)) fail(`hydrology reach terrain drop at cell ${current} is non-finite`);
      if (dropM >= recipe.waterfallMinDropM) {
        if (openWaterfall === null) {
          openWaterfall = { startSegment: segment, endSegmentExclusive: segment + 1, startCell: current,
            endCell: downstream, totalDropM: dropM, maxEdgeDropM: dropM };
        } else {
          openWaterfall.endSegmentExclusive = segment + 1;
          openWaterfall.endCell = downstream;
          openWaterfall.totalDropM += dropM;
          if (dropM > openWaterfall.maxEdgeDropM) openWaterfall.maxEdgeDropM = dropM;
          if (!Number.isFinite(openWaterfall.totalDropM)) fail("hydrology reach waterfall drop accumulation is non-finite");
        }
      } else if (openWaterfall !== null) {
        waterfalls.push(freezeWaterfall(openWaterfall));
        waterfallSpanCount++;
        openWaterfall = null;
      }
      if (points.length > WATER_LIMITS.waterwayPoints) {
        fail(`generated hydrology reach from cell ${start} exceeds ${WATER_LIMITS.waterwayPoints} points`);
      }
      if (active[downstream] === 0 || isNode(downstream)) break;
      current = downstream;
      // Strahler order belongs to an outgoing drainage edge. The terminal node's order
      // belongs to the next reach and must not relabel its incoming tributaries.
      if (topology.streamOrder[current] > maximumOrder) maximumOrder = topology.streamOrder[current];
    }
    if (openWaterfall !== null) {
      waterfalls.push(freezeWaterfall(openWaterfall));
      waterfallSpanCount++;
    }
    if (waterfallSpanCount > WATER_LIMITS.totalWaterwayPoints) fail("generated hydrology waterfall spans exceed bounded metadata limits");
    if (maximumOrder < 1 || maximumOrder > WATER_LIMITS.streamOrder) {
      fail(`generated hydrology reach order ${maximumOrder} is outside [1, ${WATER_LIMITS.streamOrder}]`);
    }
    totalPoints += points.length;
    if (totalPoints > WATER_LIMITS.totalWaterwayPoints) {
      fail(`generated hydrology reach geometry exceeds ${WATER_LIMITS.totalWaterwayPoints} total points`);
    }
    reaches.push(Object.freeze({
      id: `gen-r-${start.toString(36)}-${end.toString(36)}`,
      class: maximumOrder <= 2 ? "stream" : "river",
      order: maximumOrder,
      startCell: start,
      endCell: end,
      points: Object.freeze(points),
      widths: Object.freeze(widths),
      terrainElevationsM: Object.freeze(terrainElevationsM),
      surfaceElevationsM: Object.freeze(surfaceElevationsM),
      waterfalls: Object.freeze(waterfalls),
    }));
  }
  if (reaches.length !== outgoingNodeCount) fail("hydrology reach count does not match outgoing network nodes");
  for (let index = 0; index < topology.cellCount; index++) {
    meter.work();
    const expected = active[index] !== 0 && topology.receiver[index] >= 0;
    if ((visitedEdges[index] !== 0) !== expected) fail(`hydrology reach edge ownership is incomplete at cell ${index}`);
  }
  if (visitedEdgeCount !== expectedEdgeCount) fail("hydrology reach edge count is not conservative");
  meter.check();
  return Object.freeze({
    schema: HYDROLOGY_REACH_TOPOLOGY_SCHEMA,
    version: HYDROLOGY_REACH_TOPOLOGY_VERSION,
    placement,
    rows: topology.rows,
    cols: topology.cols,
    cellSizeM: topology.cellSizeM,
    reaches: Object.freeze(reaches),
    diagnostics: Object.freeze({
      ...meter.snapshot(),
      activeCellCount,
      nodeCount,
      outgoingNodeCount,
      expectedEdgeCount,
      visitedEdgeCount,
      reachCount: reaches.length,
      totalPoints,
      waterfallSpanCount,
      ownedTerrainBytes: heightsM.byteLength,
      typedScratchBytes: active.byteLength + activeDonors.byteLength + visitedEdges.byteLength,
    }),
  });
}

/** Extract a thresholded, confluence-exact directed channel graph from the verified drainage field. */
export function extractHydrologyReaches(input, controlInput = undefined) {
  return extractReachesVerified(verifyExtractionInput(input, controlInput));
}

/** Verify and snapshot the field/terrain once, then derive both generated standing and flowing water. */
export function extractHydrologyWaterTopology(input, controlInput = undefined) {
  const verified = verifyExtractionInput(input, controlInput);
  const basinResult = extractBasinsVerified(verified);
  const reachResult = extractReachesVerified(verified);
  return Object.freeze({
    schema: HYDROLOGY_COMBINED_WATER_TOPOLOGY_SCHEMA,
    version: HYDROLOGY_COMBINED_WATER_TOPOLOGY_VERSION,
    placement: verified.placement,
    rows: verified.topology.rows,
    cols: verified.topology.cols,
    cellSizeM: verified.topology.cellSizeM,
    basins: basinResult.basins,
    reaches: reachResult.reaches,
    diagnostics: Object.freeze({
      verificationPasses: 1,
      basins: basinResult.diagnostics,
      reaches: reachResult.diagnostics,
    }),
  });
}
