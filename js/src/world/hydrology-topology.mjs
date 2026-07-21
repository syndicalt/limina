// Deterministic WB-W1 drainage field. The v1 terminal policy is fixed: every perimeter cell and
// every perimeter-connected cell strictly below sea level is an outlet. Priority-flood receivers
// always point to a cell popped earlier from the canonical (filledHeight,index) min heap.

import { HYDROLOGY_LIMITS } from "./hydrology-ir.mjs";

export const HYDROLOGY_TOPOLOGY_SCHEMA = "limina.hydrology-topology/v1";
export const HYDROLOGY_TOPOLOGY_VERSION = 1;
export const MAX_HYDROLOGY_DIMENSION = 1025;
export const MAX_HYDROLOGY_CELLS = MAX_HYDROLOGY_DIMENSION * MAX_HYDROLOGY_DIMENSION;
export const MAX_HYDROLOGY_ABS_HEIGHT_M = 1_000_000_000;
export const MAX_HYDROLOGY_CELL_SIZE_M = 1_000_000;
export const MAX_HYDROLOGY_PRECIPITATION_MM_PER_YEAR = HYDROLOGY_LIMITS.precipitationMmPerYear;

const INPUT_KEYS = new Set([
  "rows",
  "cols",
  "heightsM",
  "cellSizeM",
  "seaLevelM",
  "precipitationMmPerYear",
  "shouldCancel",
]);

export class HydrologyTopologyValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "HydrologyTopologyValidationError";
    this.code = "hydrology_topology_invalid";
  }
}

export class HydrologyTopologyCancelledError extends Error {
  constructor() {
    super("hydrology topology operation cancelled");
    this.name = "HydrologyTopologyCancelledError";
    this.code = "hydrology_topology_cancelled";
  }
}

function fail(message) {
  throw new HydrologyTopologyValidationError(message);
}

function parseInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    fail("hydrology topology input must be a plain object");
  }
  if (Object.getOwnPropertySymbols(input).length !== 0) fail("hydrology topology input must not contain symbol fields");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!INPUT_KEYS.has(key)) fail(`hydrology topology input has unknown field '${key}'`);
    if (!("value" in descriptor) || descriptor.enumerable !== true) fail(`hydrology topology input.${key} must be an enumerable data field`);
  }
  for (const key of INPUT_KEYS) {
    if (key !== "shouldCancel" && !Object.hasOwn(input, key)) fail(`hydrology topology input is missing '${key}'`);
  }
  return descriptors;
}

function dimension(descriptor, label) {
  const value = descriptor.value;
  if (!Number.isSafeInteger(value) || value < 2 || value > MAX_HYDROLOGY_DIMENSION) {
    fail(`${label} must be an integer in [2, ${MAX_HYDROLOGY_DIMENSION}]`);
  }
  return value;
}

function canonicalNumber(descriptor, label, minimum, maximum, minimumInclusive = true) {
  const value = descriptor.value;
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)
      || (minimumInclusive ? value < minimum : value <= minimum) || value > maximum) {
    fail(`${label} must be a finite canonical number in ${minimumInclusive ? "[" : "("}${minimum}, ${maximum}]`);
  }
  return value;
}

function ownedHeightArray(descriptor, cells) {
  const value = descriptor.value;
  if (!ArrayBuffer.isView(value)
      || (Object.getPrototypeOf(value) !== Float32Array.prototype && Object.getPrototypeOf(value) !== Float64Array.prototype)) {
    fail("hydrology topology heightsM must be a Float32Array or Float64Array");
  }
  if (!(value.buffer instanceof ArrayBuffer) || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    fail("hydrology topology heightsM must own its complete non-shared ArrayBuffer");
  }
  if (value.length !== cells) fail(`hydrology topology heightsM length ${value.length} does not match rows*cols ${cells}`);
  return value;
}

/**
 * Build the canonical v1 drainage field. Returned typed arrays are owned by the caller and never
 * alias the input. Units: catchmentAreaM2 is m2 and dischargeM3PerYear is annual rain volume.
 */
export function createHydrologyTopology(input) {
  const descriptors = parseInput(input);
  const rows = dimension(descriptors.rows, "hydrology topology rows");
  const cols = dimension(descriptors.cols, "hydrology topology cols");
  const cellCount = rows * cols;
  if (!Number.isSafeInteger(cellCount) || cellCount > MAX_HYDROLOGY_CELLS) {
    fail(`hydrology topology grid exceeds ${MAX_HYDROLOGY_CELLS} cells`);
  }
  const heightsM = ownedHeightArray(descriptors.heightsM, cellCount);
  const cellSizeM = canonicalNumber(descriptors.cellSizeM, "hydrology topology cellSizeM", 0, MAX_HYDROLOGY_CELL_SIZE_M, false);
  const seaLevelM = canonicalNumber(
    descriptors.seaLevelM,
    "hydrology topology seaLevelM",
    -MAX_HYDROLOGY_ABS_HEIGHT_M,
    MAX_HYDROLOGY_ABS_HEIGHT_M,
  );
  const precipitationMmPerYear = canonicalNumber(
    descriptors.precipitationMmPerYear,
    "hydrology topology precipitationMmPerYear",
    0,
    MAX_HYDROLOGY_PRECIPITATION_MM_PER_YEAR,
  );
  const shouldCancel = descriptors.shouldCancel?.value;
  if (shouldCancel !== undefined && typeof shouldCancel !== "function") fail("hydrology topology shouldCancel must be a function");

  const cellAreaM2 = cellSizeM * cellSizeM;
  const precipitationMPerYear = precipitationMmPerYear / 1000;
  const cellDischargeM3PerYear = cellAreaM2 * precipitationMPerYear;
  const totalAreaM2 = cellAreaM2 * cellCount;
  const totalDischargeM3PerYear = cellDischargeM3PerYear * cellCount;
  if (![cellAreaM2, precipitationMPerYear, cellDischargeM3PerYear, totalAreaM2, totalDischargeM3PerYear].every(Number.isFinite)) {
    fail("hydrology topology cell metrics exceed finite arithmetic bounds");
  }

  const workLimit = cellCount * 192 + 1024;
  let workUnits = 0;
  let cancellationChecks = 0;
  const checkCancellation = () => {
    cancellationChecks++;
    if (shouldCancel?.()) throw new HydrologyTopologyCancelledError();
  };
  const meter = () => {
    workUnits++;
    if (workUnits > workLimit) fail(`hydrology topology exceeded bounded work limit ${workLimit}`);
    if ((workUnits & 1023) === 0) checkCancellation();
  };
  // Snapshot before invoking caller code. A cancellation callback may mutate or detach its input;
  // canonical output must depend on the values present at function entry, not callback side effects.
  const filledHeightM = new Float64Array(cellCount);
  for (let index = 0; index < cellCount; index++) filledHeightM[index] = heightsM[index];
  checkCancellation();
  for (let index = 0; index < cellCount; index++) {
    meter();
    const height = filledHeightM[index];
    if (!Number.isFinite(height) || Object.is(height, -0) || Math.abs(height) > MAX_HYDROLOGY_ABS_HEIGHT_M) {
      fail(`hydrology topology heightsM[${index}] must be finite, canonical, and within +/-${MAX_HYDROLOGY_ABS_HEIGHT_M}m`);
    }
  }

  // Prove ocean membership independently from drainage: only strictly sub-sea cells connected
  // through the fixed 8-neighbor grid to a strictly sub-sea perimeter cell are ocean.
  const oceanMask = new Uint8Array(cellCount);
  const rankToCell = new Int32Array(cellCount); // ocean BFS queue, then reused as priority-pop order.
  let oceanTail = 0;
  const seedOcean = (index) => {
    if (oceanMask[index] === 0 && filledHeightM[index] < seaLevelM) {
      oceanMask[index] = 1;
      rankToCell[oceanTail++] = index;
    }
  };
  for (let col = 0; col < cols; col++) {
    seedOcean(col);
    seedOcean((rows - 1) * cols + col);
  }
  for (let row = 1; row < rows - 1; row++) {
    seedOcean(row * cols);
    seedOcean(row * cols + cols - 1);
  }
  let oceanHead = 0;
  let oceanNeighborTests = 0;
  while (oceanHead < oceanTail) {
    meter();
    const index = rankToCell[oceanHead++];
    const row = Math.floor(index / cols);
    const col = index - row * cols;
    for (let dr = -1; dr <= 1; dr++) {
      const nextRow = row + dr;
      if (nextRow < 0 || nextRow >= rows) continue;
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nextCol = col + dc;
        if (nextCol < 0 || nextCol >= cols) continue;
        meter();
        oceanNeighborTests++;
        const neighbor = nextRow * cols + nextCol;
        if (oceanMask[neighbor] === 0 && filledHeightM[neighbor] < seaLevelM) {
          oceanMask[neighbor] = 1;
          rankToCell[oceanTail++] = neighbor;
        }
      }
    }
  }
  const oceanCellCount = oceanTail;

  const receiver = new Int32Array(cellCount);
  receiver.fill(-2);
  const drainageRank = new Uint32Array(cellCount);
  const discovered = new Uint8Array(cellCount);
  const heapIndexes = new Int32Array(cellCount);
  const heapHeights = new Float64Array(cellCount);
  let heapSize = 0;
  let heapPeak = 0;
  let heapPushes = 0;
  let heapPops = 0;
  let heapComparisons = 0;

  const less = (leftHeight, leftIndex, rightHeight, rightIndex) => {
    meter();
    heapComparisons++;
    return leftHeight < rightHeight || (leftHeight === rightHeight && leftIndex < rightIndex);
  };
  const push = (index, height) => {
    if (heapSize >= cellCount) fail("hydrology topology heap exceeded cell count");
    let position = heapSize++;
    while (position > 0) {
      const parent = (position - 1) >>> 1;
      if (!less(height, index, heapHeights[parent], heapIndexes[parent])) break;
      heapHeights[position] = heapHeights[parent];
      heapIndexes[position] = heapIndexes[parent];
      position = parent;
    }
    heapHeights[position] = height;
    heapIndexes[position] = index;
    heapPushes++;
    if (heapSize > heapPeak) heapPeak = heapSize;
  };
  const pop = () => {
    if (heapSize <= 0) fail("hydrology topology heap underflow");
    const root = heapIndexes[0];
    const lastPosition = --heapSize;
    if (lastPosition > 0) {
      const lastHeight = heapHeights[lastPosition];
      const lastIndex = heapIndexes[lastPosition];
      let position = 0;
      while (true) {
        const left = position * 2 + 1;
        if (left >= heapSize) break;
        const right = left + 1;
        let child = left;
        if (right < heapSize && less(heapHeights[right], heapIndexes[right], heapHeights[left], heapIndexes[left])) child = right;
        if (!less(heapHeights[child], heapIndexes[child], lastHeight, lastIndex)) break;
        heapHeights[position] = heapHeights[child];
        heapIndexes[position] = heapIndexes[child];
        position = child;
      }
      heapHeights[position] = lastHeight;
      heapIndexes[position] = lastIndex;
    }
    heapPops++;
    return root;
  };

  let outletCount = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      meter();
      const index = row * cols + col;
      if (row !== 0 && row !== rows - 1 && col !== 0 && col !== cols - 1 && oceanMask[index] === 0) continue;
      discovered[index] = 1;
      receiver[index] = -1;
      push(index, filledHeightM[index]);
      outletCount++;
    }
  }

  let poppedCells = 0;
  let drainageNeighborTests = 0;
  while (heapSize > 0) {
    meter();
    const index = pop();
    const rank = poppedCells++;
    rankToCell[rank] = index;
    drainageRank[index] = rank;
    const parentHeight = filledHeightM[index];
    const row = Math.floor(index / cols);
    const col = index - row * cols;
    for (let dr = -1; dr <= 1; dr++) {
      const nextRow = row + dr;
      if (nextRow < 0 || nextRow >= rows) continue;
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nextCol = col + dc;
        if (nextCol < 0 || nextCol >= cols) continue;
        meter();
        drainageNeighborTests++;
        const neighbor = nextRow * cols + nextCol;
        if (discovered[neighbor] !== 0) continue;
        discovered[neighbor] = 1;
        receiver[neighbor] = index;
        const original = filledHeightM[neighbor];
        const filled = original > parentHeight ? original : parentHeight;
        filledHeightM[neighbor] = filled;
        push(neighbor, filled);
      }
    }
  }
  if (poppedCells !== cellCount || heapPushes !== cellCount || heapPops !== cellCount) {
    fail("hydrology topology priority flood did not visit every cell exactly once");
  }

  const catchmentAreaM2 = new Float64Array(cellCount);
  const dischargeM3PerYear = new Float64Array(cellCount);
  catchmentAreaM2.fill(cellAreaM2);
  dischargeM3PerYear.fill(cellDischargeM3PerYear);
  const streamOrder = new Uint8Array(cellCount);
  const maximumChildOrder = new Uint8Array(cellCount);
  const maximumChildCount = new Uint8Array(cellCount);
  let accumulationEdges = 0;
  let maximumStreamOrder = 1;
  for (let rank = cellCount - 1; rank >= 0; rank--) {
    meter();
    const index = rankToCell[rank];
    const childMaximum = maximumChildOrder[index];
    const order = childMaximum === 0 ? 1 : childMaximum + (maximumChildCount[index] >= 2 ? 1 : 0);
    if (order > 255) fail("hydrology topology stream order exceeds Uint8 storage");
    streamOrder[index] = order;
    if (order > maximumStreamOrder) maximumStreamOrder = order;
    const downstream = receiver[index];
    if (downstream < 0) continue;
    if (drainageRank[downstream] >= drainageRank[index]) fail("hydrology topology receiver does not have an earlier drainage rank");
    catchmentAreaM2[downstream] += catchmentAreaM2[index];
    dischargeM3PerYear[downstream] += dischargeM3PerYear[index];
    if (!Number.isFinite(catchmentAreaM2[downstream]) || !Number.isFinite(dischargeM3PerYear[downstream])) {
      fail("hydrology topology accumulation exceeded finite arithmetic bounds");
    }
    const downstreamMaximum = maximumChildOrder[downstream];
    if (order > downstreamMaximum) {
      maximumChildOrder[downstream] = order;
      maximumChildCount[downstream] = 1;
    } else if (order === downstreamMaximum && maximumChildCount[downstream] < 255) {
      maximumChildCount[downstream]++;
    }
    accumulationEdges++;
  }
  checkCancellation();

  const diagnostics = Object.freeze({
    workUnits,
    workLimit,
    cancellationChecks,
    oceanCellCount,
    oceanFloodVisits: oceanHead,
    oceanNeighborTests,
    outletCount,
    priorityFloodVisits: poppedCells,
    drainageNeighborTests,
    heapCapacity: cellCount,
    heapPeak,
    heapPushes,
    heapPops,
    heapComparisons,
    accumulationEdges,
    maximumStreamOrder,
    totalAreaM2,
    totalDischargeM3PerYear,
  });
  return Object.freeze({
    schema: HYDROLOGY_TOPOLOGY_SCHEMA,
    version: HYDROLOGY_TOPOLOGY_VERSION,
    rows,
    cols,
    cellCount,
    cellSizeM,
    cellAreaM2,
    seaLevelM,
    precipitationMmPerYear,
    precipitationMPerYear,
    receiver,
    drainageRank,
    filledHeightM,
    catchmentAreaM2,
    dischargeM3PerYear,
    streamOrder,
    oceanMask,
    diagnostics,
  });
}
