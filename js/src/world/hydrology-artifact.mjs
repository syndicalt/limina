import {
  HYDROLOGY_TOPOLOGY_SCHEMA,
  HYDROLOGY_TOPOLOGY_VERSION,
  MAX_HYDROLOGY_ABS_HEIGHT_M,
  MAX_HYDROLOGY_CELLS,
  MAX_HYDROLOGY_CELL_SIZE_M,
  MAX_HYDROLOGY_DIMENSION,
  MAX_HYDROLOGY_PRECIPITATION_MM_PER_YEAR,
} from "./hydrology-topology.mjs";

export const HYDROLOGY_FIELD_ARTIFACT_TYPE = "hydrology-field/v1";
export const HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.hydrology-field";
export const HYDROLOGY_FIELD_ARTIFACT_VERSION = 1;
export const HYDROLOGY_FIELD_ARTIFACT_HEADER_BYTES = 112;

const MAGIC = new Uint8Array([0x4c, 0x48, 0x59, 0x44, 0x46, 0x4c, 0x44, 0x31]); // LHYDFLD1
const ROOT_KEYS = new Set([
  "schema", "version", "rows", "cols", "cellCount", "cellSizeM", "cellAreaM2", "seaLevelM",
  "precipitationMmPerYear", "precipitationMPerYear", "receiver", "drainageRank", "filledHeightM",
  "catchmentAreaM2", "dischargeM3PerYear", "streamOrder", "oceanMask", "diagnostics",
]);
const PLACEMENT_KEYS = new Set(["originX", "originZ"]);
const CONTROL_KEYS = new Set(["shouldCancel"]);
const MAX_ORIGIN_M = 1_000_000_000_000;
const align = (value, alignment) => Math.ceil(value / alignment) * alignment;

function layoutForCells(cells) {
  const receiver = HYDROLOGY_FIELD_ARTIFACT_HEADER_BYTES;
  const drainageRank = align(receiver + cells * 4, 4);
  const filledHeightM = align(drainageRank + cells * 4, 8);
  const catchmentAreaM2 = align(filledHeightM + cells * 8, 8);
  const streamOrder = catchmentAreaM2 + cells * 8;
  const oceanMask = streamOrder + cells;
  const dataEnd = oceanMask + cells;
  return Object.freeze({
    receiver,
    drainageRank,
    filledHeightM,
    catchmentAreaM2,
    streamOrder,
    oceanMask,
    dataEnd,
    byteLength: align(dataEnd, 8),
  });
}

export const MAX_HYDROLOGY_FIELD_ARTIFACT_BYTES = layoutForCells(MAX_HYDROLOGY_CELLS).byteLength;

export class HydrologyArtifactValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "HydrologyArtifactValidationError";
    this.code = "hydrology_artifact_invalid";
  }
}

export class HydrologyArtifactCancelledError extends Error {
  constructor() {
    super("hydrology artifact operation cancelled");
    this.name = "HydrologyArtifactCancelledError";
    this.code = "hydrology_artifact_cancelled";
  }
}

function fail(message) { throw new HydrologyArtifactValidationError(message); }

function exactRecord(value, keys, label, optional = new Set()) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!keys.has(key)) fail(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor) || descriptor.enumerable !== true) fail(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of keys) if (!optional.has(key) && !Object.hasOwn(value, key)) fail(`${label} is missing '${key}'`);
  return descriptors;
}

function canonicalNumber(value, label, minimum, maximum, positive = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)
      || (positive ? value <= minimum : value < minimum) || value > maximum) {
    fail(`${label} must be a finite canonical number in ${positive ? "(" : "["}${minimum}, ${maximum}]`);
  }
  return value;
}

function dimension(value, label) {
  if (!Number.isSafeInteger(value) || value < 2 || value > MAX_HYDROLOGY_DIMENSION) {
    fail(`${label} must be an integer in [2, ${MAX_HYDROLOGY_DIMENSION}]`);
  }
  return value;
}

function ownedArray(value, prototype, cells, label) {
  if (!ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== prototype) fail(`${label} has the wrong typed-array representation`);
  if (!(value.buffer instanceof ArrayBuffer) || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    fail(`${label} must own its complete non-shared ArrayBuffer`);
  }
  if (value.length !== cells) fail(`${label} length ${value.length} does not match ${cells} cells`);
  return value;
}

function parseControl(input, label) {
  if (input === undefined) return undefined;
  const descriptors = exactRecord(input, CONTROL_KEYS, label);
  const shouldCancel = descriptors.shouldCancel.value;
  if (typeof shouldCancel !== "function") fail(`${label}.shouldCancel must be a function`);
  return shouldCancel;
}

function createMeter(shouldCancel, maximum) {
  let workUnits = 0;
  let cancellationChecks = 0;
  const check = () => {
    cancellationChecks++;
    if (shouldCancel?.()) throw new HydrologyArtifactCancelledError();
  };
  const work = () => {
    workUnits++;
    if (workUnits > maximum) fail(`hydrology artifact exceeded bounded validation work ${maximum}`);
    if ((workUnits & 1023) === 0) check();
  };
  return Object.freeze({ work, check, snapshot: () => Object.freeze({ workUnits, workLimit: maximum, cancellationChecks }) });
}

function toleranceFor(expected, actual, terms = 1) {
  return Number.EPSILON * 64 * Math.max(1, Math.abs(expected), Math.abs(actual)) * Math.max(1, Math.ceil(Math.log2(terms + 1)));
}

function validateChannels(field, meter, validateDischarge) {
  const cells = field.cellCount;
  const rankToCell = new Uint32Array(cells);
  const seenRanks = new Uint8Array(cells);
  let outletCount = 0;
  let oceanCellCount = 0;
  let outletCatchmentAreaM2 = 0;
  let maximumStreamOrder = 1;
  for (let index = 0; index < cells; index++) {
    meter.work();
    const rank = field.drainageRank[index];
    if (rank >= cells || seenRanks[rank] !== 0) fail(`hydrology artifact drainageRank[${index}] is not a permutation`);
    seenRanks[rank] = 1;
    rankToCell[rank] = index;
    const receiver = field.receiver[index];
    if (receiver < -1 || receiver >= cells) fail(`hydrology artifact receiver[${index}] is out of range`);
    const filled = field.filledHeightM[index];
    if (!Number.isFinite(filled) || Object.is(filled, -0) || Math.abs(filled) > MAX_HYDROLOGY_ABS_HEIGHT_M) {
      fail(`hydrology artifact filledHeightM[${index}] is not finite canonical terrain data`);
    }
    const catchment = field.catchmentAreaM2[index];
    if (!Number.isFinite(catchment) || Object.is(catchment, -0) || !(catchment > 0)) {
      fail(`hydrology artifact catchmentAreaM2[${index}] must be finite and positive`);
    }
    const order = field.streamOrder[index];
    if (order < 1) fail(`hydrology artifact streamOrder[${index}] must be positive`);
    if (order > maximumStreamOrder) maximumStreamOrder = order;
    const ocean = field.oceanMask[index];
    if (ocean !== 0 && ocean !== 1) fail(`hydrology artifact oceanMask[${index}] must be 0 or 1`);
    if (ocean === 1) oceanCellCount++;
    const row = Math.floor(index / field.cols);
    const col = index - row * field.cols;
    const terminal = row === 0 || row === field.rows - 1 || col === 0 || col === field.cols - 1 || ocean === 1;
    if ((receiver === -1) !== terminal) fail(`hydrology artifact receiver[${index}] violates perimeter/ocean outlet policy`);
    if (receiver === -1) {
      outletCount++;
      outletCatchmentAreaM2 += catchment;
    }
    if (validateDischarge) {
      const discharge = field.dischargeM3PerYear[index];
      const expected = catchment * field.precipitationMPerYear;
      if (!Number.isFinite(discharge) || Object.is(discharge, -0) || discharge < 0
          || Math.abs(discharge - expected) > toleranceFor(expected, discharge, cells)) {
        fail(`hydrology artifact dischargeM3PerYear[${index}] is inconsistent with catchment and precipitation`);
      }
    }
  }

  const expectedCatchment = new Float64Array(cells);
  expectedCatchment.fill(field.cellAreaM2);
  const maxChildOrder = new Uint8Array(cells);
  const maxChildCount = new Uint8Array(cells);
  for (let rank = cells - 1; rank >= 0; rank--) {
    meter.work();
    const index = rankToCell[rank];
    const receiver = field.receiver[index];
    const expectedOrder = maxChildOrder[index] === 0 ? 1 : maxChildOrder[index] + (maxChildCount[index] >= 2 ? 1 : 0);
    if (field.streamOrder[index] !== expectedOrder) fail(`hydrology artifact streamOrder[${index}] violates Strahler topology`);
    const catchment = field.catchmentAreaM2[index];
    if (Math.abs(catchment - expectedCatchment[index]) > toleranceFor(expectedCatchment[index], catchment, cells)) {
      fail(`hydrology artifact catchmentAreaM2[${index}] violates receiver accumulation`);
    }
    if (receiver < 0) continue;
    if (field.drainageRank[receiver] >= field.drainageRank[index]) fail(`hydrology artifact receiver[${index}] does not have an earlier rank`);
    if (field.filledHeightM[receiver] > field.filledHeightM[index]) fail(`hydrology artifact filled surface rises downstream from cell ${index}`);
    expectedCatchment[receiver] += expectedCatchment[index];
    const order = field.streamOrder[index];
    if (order > maxChildOrder[receiver]) {
      maxChildOrder[receiver] = order;
      maxChildCount[receiver] = 1;
    } else if (order === maxChildOrder[receiver]) {
      maxChildCount[receiver]++;
    }
  }
  const expectedTotal = field.cellAreaM2 * cells;
  if (Math.abs(outletCatchmentAreaM2 - expectedTotal) > toleranceFor(expectedTotal, outletCatchmentAreaM2, cells)) {
    fail("hydrology artifact outlet catchment does not conserve total grid area");
  }
  return Object.freeze({ outletCount, oceanCellCount, maximumStreamOrder, outletCatchmentAreaM2 });
}

function parseTopology(topology) {
  const descriptors = exactRecord(topology, ROOT_KEYS, "hydrology topology");
  if (descriptors.schema.value !== HYDROLOGY_TOPOLOGY_SCHEMA || descriptors.version.value !== HYDROLOGY_TOPOLOGY_VERSION) {
    fail("hydrology topology schema/version is unsupported");
  }
  const rows = dimension(descriptors.rows.value, "hydrology topology rows");
  const cols = dimension(descriptors.cols.value, "hydrology topology cols");
  const cells = rows * cols;
  if (cells > MAX_HYDROLOGY_CELLS || descriptors.cellCount.value !== cells) fail("hydrology topology cellCount does not match dimensions");
  const cellSizeM = canonicalNumber(descriptors.cellSizeM.value, "hydrology topology cellSizeM", 0, MAX_HYDROLOGY_CELL_SIZE_M, true);
  const cellAreaM2 = cellSizeM * cellSizeM;
  if (descriptors.cellAreaM2.value !== cellAreaM2) fail("hydrology topology cellAreaM2 is inconsistent with cellSizeM");
  const seaLevelM = canonicalNumber(descriptors.seaLevelM.value, "hydrology topology seaLevelM", -MAX_HYDROLOGY_ABS_HEIGHT_M, MAX_HYDROLOGY_ABS_HEIGHT_M);
  const precipitationMmPerYear = canonicalNumber(
    descriptors.precipitationMmPerYear.value,
    "hydrology topology precipitationMmPerYear",
    0,
    MAX_HYDROLOGY_PRECIPITATION_MM_PER_YEAR,
  );
  const precipitationMPerYear = precipitationMmPerYear / 1000;
  if (descriptors.precipitationMPerYear.value !== precipitationMPerYear) fail("hydrology topology precipitationMPerYear is inconsistent");
  const source = {
    rows, cols, cellCount: cells, cellSizeM, cellAreaM2, seaLevelM, precipitationMmPerYear, precipitationMPerYear,
    receiver: ownedArray(descriptors.receiver.value, Int32Array.prototype, cells, "hydrology topology receiver"),
    drainageRank: ownedArray(descriptors.drainageRank.value, Uint32Array.prototype, cells, "hydrology topology drainageRank"),
    filledHeightM: ownedArray(descriptors.filledHeightM.value, Float64Array.prototype, cells, "hydrology topology filledHeightM"),
    catchmentAreaM2: ownedArray(descriptors.catchmentAreaM2.value, Float64Array.prototype, cells, "hydrology topology catchmentAreaM2"),
    dischargeM3PerYear: ownedArray(descriptors.dischargeM3PerYear.value, Float64Array.prototype, cells, "hydrology topology dischargeM3PerYear"),
    streamOrder: ownedArray(descriptors.streamOrder.value, Uint8Array.prototype, cells, "hydrology topology streamOrder"),
    oceanMask: ownedArray(descriptors.oceanMask.value, Uint8Array.prototype, cells, "hydrology topology oceanMask"),
  };
  const diagnostics = descriptors.diagnostics.value;
  if (diagnostics === null || typeof diagnostics !== "object" || Array.isArray(diagnostics) || Object.getPrototypeOf(diagnostics) !== Object.prototype
      || Object.getOwnPropertySymbols(diagnostics).length !== 0) {
    fail("hydrology topology diagnostics must be an object");
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(diagnostics))) {
    if (!("value" in descriptor) || descriptor.enumerable !== true) fail("hydrology topology diagnostics must contain only enumerable data fields");
  }
  // Snapshot all channels before invoking cancellation callbacks. Caller code cannot race or
  // mutate the canonical bytes through the input arrays once validation begins.
  return {
    ...source,
    receiver: source.receiver.slice(),
    drainageRank: source.drainageRank.slice(),
    filledHeightM: source.filledHeightM.slice(),
    catchmentAreaM2: source.catchmentAreaM2.slice(),
    dischargeM3PerYear: source.dischargeM3PerYear.slice(),
    streamOrder: source.streamOrder.slice(),
    oceanMask: source.oceanMask.slice(),
  };
}

function parsePlacement(placement) {
  const descriptors = exactRecord(placement, PLACEMENT_KEYS, "hydrology artifact placement");
  return Object.freeze({
    originX: canonicalNumber(descriptors.originX.value, "hydrology artifact originX", -MAX_ORIGIN_M, MAX_ORIGIN_M),
    originZ: canonicalNumber(descriptors.originZ.value, "hydrology artifact originZ", -MAX_ORIGIN_M, MAX_ORIGIN_M),
  });
}

function writeHeader(view, field, placement, layout) {
  for (let index = 0; index < MAGIC.length; index++) view.setUint8(index, MAGIC[index]);
  view.setUint16(8, HYDROLOGY_FIELD_ARTIFACT_VERSION, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, HYDROLOGY_FIELD_ARTIFACT_HEADER_BYTES, true);
  view.setUint16(14, 0, true);
  view.setUint32(16, field.rows, true);
  view.setUint32(20, field.cols, true);
  view.setUint32(24, field.cellCount, true);
  view.setUint32(28, layout.byteLength, true);
  view.setFloat64(32, placement.originX, true);
  view.setFloat64(40, placement.originZ, true);
  view.setFloat64(48, field.cellSizeM, true);
  view.setFloat64(56, field.seaLevelM, true);
  view.setFloat64(64, field.precipitationMmPerYear, true);
  view.setUint32(72, layout.receiver, true);
  view.setUint32(76, layout.drainageRank, true);
  view.setUint32(80, layout.filledHeightM, true);
  view.setUint32(84, layout.catchmentAreaM2, true);
  view.setUint32(88, layout.streamOrder, true);
  view.setUint32(92, layout.oceanMask, true);
}

export function encodeHydrologyFieldArtifact(topology, placementInput, controlInput = undefined) {
  const shouldCancel = parseControl(controlInput, "hydrology artifact encode control");
  const placement = parsePlacement(placementInput);
  const field = parseTopology(topology);
  const meter = createMeter(shouldCancel, MAX_HYDROLOGY_CELLS * 48 + 4096);
  meter.check();
  validateChannels(field, meter, true);
  const layout = layoutForCells(field.cellCount);
  if (layout.byteLength > MAX_HYDROLOGY_FIELD_ARTIFACT_BYTES) fail("hydrology artifact exceeds maximum bytes");
  const bytes = new Uint8Array(layout.byteLength);
  const view = new DataView(bytes.buffer);
  writeHeader(view, field, placement, layout);
  for (let index = 0; index < field.cellCount; index++) {
    meter.work();
    view.setInt32(layout.receiver + index * 4, field.receiver[index], true);
    view.setUint32(layout.drainageRank + index * 4, field.drainageRank[index], true);
    view.setFloat64(layout.filledHeightM + index * 8, field.filledHeightM[index], true);
    view.setFloat64(layout.catchmentAreaM2 + index * 8, field.catchmentAreaM2[index], true);
    view.setUint8(layout.streamOrder + index, field.streamOrder[index]);
    view.setUint8(layout.oceanMask + index, field.oceanMask[index]);
  }
  meter.check();
  return bytes;
}

function ownedBytes(input) {
  if (!ArrayBuffer.isView(input) || Object.getPrototypeOf(input) !== Uint8Array.prototype) {
    fail("hydrology artifact bytes must be a Uint8Array");
  }
  if (!(input.buffer instanceof ArrayBuffer)) fail("hydrology artifact bytes must use a non-shared ArrayBuffer");
  if (input.byteLength < HYDROLOGY_FIELD_ARTIFACT_HEADER_BYTES || input.byteLength > MAX_HYDROLOGY_FIELD_ARTIFACT_BYTES) {
    fail("hydrology artifact byte length is outside supported bounds");
  }
  return Uint8Array.from(input);
}

function readArtifact(input, controlInput, includeTopology) {
  const shouldCancel = parseControl(controlInput, "hydrology artifact decode control");
  const bytes = ownedBytes(input);
  const meter = createMeter(shouldCancel, MAX_HYDROLOGY_CELLS * 48 + 4096);
  meter.check();
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC.length; index++) if (view.getUint8(index) !== MAGIC[index]) fail("hydrology artifact magic mismatch");
  if (view.getUint16(8, true) !== HYDROLOGY_FIELD_ARTIFACT_VERSION) fail("hydrology artifact version is unsupported");
  if (view.getUint16(10, true) !== 0) fail("hydrology artifact flags must be zero");
  if (view.getUint16(12, true) !== HYDROLOGY_FIELD_ARTIFACT_HEADER_BYTES) fail("hydrology artifact header length mismatch");
  if (view.getUint16(14, true) !== 0) fail("hydrology artifact reserved header field must be zero");
  for (let index = 96; index < HYDROLOGY_FIELD_ARTIFACT_HEADER_BYTES; index++) if (view.getUint8(index) !== 0) fail("hydrology artifact reserved header bytes must be zero");
  const rows = dimension(view.getUint32(16, true), "hydrology artifact rows");
  const cols = dimension(view.getUint32(20, true), "hydrology artifact cols");
  const cells = rows * cols;
  if (cells > MAX_HYDROLOGY_CELLS || view.getUint32(24, true) !== cells) fail("hydrology artifact cell count does not match dimensions");
  const layout = layoutForCells(cells);
  if (view.getUint32(28, true) !== bytes.byteLength || bytes.byteLength !== layout.byteLength) fail("hydrology artifact byte length is non-canonical");
  const placement = Object.freeze({
    originX: canonicalNumber(view.getFloat64(32, true), "hydrology artifact originX", -MAX_ORIGIN_M, MAX_ORIGIN_M),
    originZ: canonicalNumber(view.getFloat64(40, true), "hydrology artifact originZ", -MAX_ORIGIN_M, MAX_ORIGIN_M),
  });
  const cellSizeM = canonicalNumber(view.getFloat64(48, true), "hydrology artifact cellSizeM", 0, MAX_HYDROLOGY_CELL_SIZE_M, true);
  const seaLevelM = canonicalNumber(view.getFloat64(56, true), "hydrology artifact seaLevelM", -MAX_HYDROLOGY_ABS_HEIGHT_M, MAX_HYDROLOGY_ABS_HEIGHT_M);
  const precipitationMmPerYear = canonicalNumber(
    view.getFloat64(64, true), "hydrology artifact precipitationMmPerYear", 0, MAX_HYDROLOGY_PRECIPITATION_MM_PER_YEAR,
  );
  for (const [offset, expected, label] of [
    [72, layout.receiver, "receiver"], [76, layout.drainageRank, "drainageRank"],
    [80, layout.filledHeightM, "filledHeightM"], [84, layout.catchmentAreaM2, "catchmentAreaM2"],
    [88, layout.streamOrder, "streamOrder"], [92, layout.oceanMask, "oceanMask"],
  ]) if (view.getUint32(offset, true) !== expected) fail(`hydrology artifact ${label} offset is non-canonical`);
  for (let index = layout.dataEnd; index < layout.byteLength; index++) if (view.getUint8(index) !== 0) fail("hydrology artifact alignment padding must be zero");

  const receiver = new Int32Array(cells);
  const drainageRank = new Uint32Array(cells);
  const filledHeightM = new Float64Array(cells);
  const catchmentAreaM2 = new Float64Array(cells);
  const streamOrder = new Uint8Array(cells);
  const oceanMask = new Uint8Array(cells);
  for (let index = 0; index < cells; index++) {
    meter.work();
    receiver[index] = view.getInt32(layout.receiver + index * 4, true);
    drainageRank[index] = view.getUint32(layout.drainageRank + index * 4, true);
    filledHeightM[index] = view.getFloat64(layout.filledHeightM + index * 8, true);
    catchmentAreaM2[index] = view.getFloat64(layout.catchmentAreaM2 + index * 8, true);
    streamOrder[index] = view.getUint8(layout.streamOrder + index);
    oceanMask[index] = view.getUint8(layout.oceanMask + index);
  }
  const precipitationMPerYear = precipitationMmPerYear / 1000;
  const dischargeM3PerYear = new Float64Array(cells);
  for (let index = 0; index < cells; index++) dischargeM3PerYear[index] = catchmentAreaM2[index] * precipitationMPerYear;
  const field = {
    rows, cols, cellCount: cells, cellSizeM, cellAreaM2: cellSizeM * cellSizeM, seaLevelM,
    precipitationMmPerYear, precipitationMPerYear, receiver, drainageRank, filledHeightM,
    catchmentAreaM2, dischargeM3PerYear, streamOrder, oceanMask,
  };
  const invariants = validateChannels(field, meter, false);
  meter.check();
  const validation = meter.snapshot();
  const artifact = Object.freeze({
    artifactType: HYDROLOGY_FIELD_ARTIFACT_TYPE,
    mediaType: HYDROLOGY_FIELD_ARTIFACT_MEDIA_TYPE,
    byteLength: bytes.byteLength,
    offsets: layout,
    invariants,
    validation,
  });
  if (!includeTopology) return Object.freeze({ placement, artifact });
  const topology = Object.freeze({
    schema: HYDROLOGY_TOPOLOGY_SCHEMA,
    version: HYDROLOGY_TOPOLOGY_VERSION,
    ...field,
    diagnostics: Object.freeze({
      source: "hydrology-field/v1",
      outletCount: invariants.outletCount,
      oceanCellCount: invariants.oceanCellCount,
      maximumStreamOrder: invariants.maximumStreamOrder,
      totalAreaM2: field.cellAreaM2 * cells,
      totalDischargeM3PerYear: field.cellAreaM2 * cells * precipitationMPerYear,
      validationWorkUnits: validation.workUnits,
    }),
  });
  return Object.freeze({ placement, topology, artifact });
}

export function inspectHydrologyFieldArtifact(bytes, control = undefined) {
  return readArtifact(bytes, control, false);
}

export function decodeHydrologyFieldArtifact(bytes, control = undefined) {
  return readArtifact(bytes, control, true);
}
