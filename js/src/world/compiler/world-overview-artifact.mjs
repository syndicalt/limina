/** Compact portable codec for the single canonical coarse world terrain overview grid. */

export const WORLD_OVERVIEW_ARTIFACT_TYPE = "world-overview-terrain/v1";
export const WORLD_OVERVIEW_ARTIFACT_MEDIA_TYPE = "application/vnd.limina.world-overview-terrain-v1";
export const WORLD_OVERVIEW_ARTIFACT_VERSION = 1;
export const WORLD_OVERVIEW_ARTIFACT_HEADER_BYTES = 64;
export const WORLD_OVERVIEW_TARGET_DIMENSION = 129;
export const WORLD_OVERVIEW_MIN_DIMENSION = 2;
export const WORLD_OVERVIEW_MAX_DIMENSION = 257;
export const WORLD_OVERVIEW_MAX_CELLS = WORLD_OVERVIEW_MAX_DIMENSION ** 2;
export const WORLD_OVERVIEW_MAX_ORIGIN_ABS_M = 10_000_000;
export const WORLD_OVERVIEW_MAX_STEP_M = 1_000_000;
export const WORLD_OVERVIEW_MAX_HEIGHT_ABS_M = 100_000;
export const WORLD_OVERVIEW_MAX_ARTIFACT_BYTES = WORLD_OVERVIEW_ARTIFACT_HEADER_BYTES + WORLD_OVERVIEW_MAX_CELLS * 6;

const MAGIC = Object.freeze([0x4c, 0x4d, 0x57, 0x4f, 0x56, 0x52, 0x31, 0x00]); // LMWOVR1\0
const GRID_KEYS = new Set(["rows", "cols", "origin", "stepM", "heights", "paintMaterial", "paintWeight"]);
const CONTROL_KEYS = new Set(["shouldCancel"]);

export class WorldOverviewArtifactValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorldOverviewArtifactValidationError";
    this.code = "world_overview_artifact_invalid";
  }
}

export class WorldOverviewArtifactCancelledError extends Error {
  constructor() {
    super("world overview artifact operation cancelled");
    this.name = "WorldOverviewArtifactCancelledError";
    this.code = "world_overview_artifact_cancelled";
  }
}

function fail(message) { throw new WorldOverviewArtifactValidationError(message); }

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

function parseControl(value) {
  if (value === undefined) return undefined;
  const descriptors = exactRecord(value, CONTROL_KEYS, "world overview artifact control");
  if (typeof descriptors.shouldCancel.value !== "function") fail("world overview artifact control.shouldCancel must be a function");
  return descriptors.shouldCancel.value;
}

function createMeter(shouldCancel, limit) {
  let work = 0;
  const check = () => { if (shouldCancel?.()) throw new WorldOverviewArtifactCancelledError(); };
  return Object.freeze({
    start: check,
    work() {
      if (++work > limit) fail(`world overview artifact exceeded bounded validation work ${limit}`);
      if ((work & 1023) === 0) check();
    },
    finish: check,
  });
}

function dimension(value, label) {
  if (!Number.isSafeInteger(value) || value < WORLD_OVERVIEW_MIN_DIMENSION || value > WORLD_OVERVIEW_MAX_DIMENSION) {
    fail(`${label} must be an integer in [${WORLD_OVERVIEW_MIN_DIMENSION}, ${WORLD_OVERVIEW_MAX_DIMENSION}]`);
  }
  return value;
}

function canonicalFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) fail(`${label} must be a finite canonical number`);
  return value;
}

function originTuple(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 2
      || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== 3) {
    fail("world overview origin must be a dense two-number tuple");
  }
  const result = new Array(2);
  for (let index = 0; index < 2; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) fail(`world overview origin[${index}] must be an enumerable data field`);
    const coordinate = canonicalFinite(descriptor.value, `world overview origin[${index}]`);
    if (Math.abs(coordinate) > WORLD_OVERVIEW_MAX_ORIGIN_ABS_M) fail(`world overview origin[${index}] exceeds the supported world range`);
    result[index] = coordinate;
  }
  return Object.freeze(result);
}

function isShared(buffer) { return Object.prototype.toString.call(buffer) === "[object SharedArrayBuffer]"; }

function ownedTypedArray(value, prototype, cells, label) {
  if (!ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== prototype) fail(`${label} has the wrong typed-array representation`);
  if (!(value.buffer instanceof ArrayBuffer) || isShared(value.buffer) || value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength) {
    fail(`${label} must own its complete non-shared ArrayBuffer`);
  }
  if (value.length !== cells) fail(`${label} length ${value.length} does not match ${cells} cells`);
  return value;
}

function layout(cells) {
  const heights = WORLD_OVERVIEW_ARTIFACT_HEADER_BYTES;
  const paintMaterial = heights + cells * 4;
  const paintWeight = paintMaterial + cells;
  return Object.freeze({ heights, paintMaterial, paintWeight, byteLength: paintWeight + cells });
}

function parseGrid(input, meter) {
  const descriptors = exactRecord(input, GRID_KEYS, "world overview grid");
  const rows = dimension(descriptors.rows.value, "world overview rows");
  const cols = dimension(descriptors.cols.value, "world overview cols");
  const cells = rows * cols;
  const origin = originTuple(descriptors.origin.value);
  const stepM = canonicalFinite(descriptors.stepM.value, "world overview stepM");
  if (!(stepM > 0) || stepM > WORLD_OVERVIEW_MAX_STEP_M) fail(`world overview stepM must be in (0, ${WORLD_OVERVIEW_MAX_STEP_M}]`);
  const maxX = canonicalFinite(origin[0] + (cols - 1) * stepM, "world overview maximum x");
  const maxZ = canonicalFinite(origin[1] + (rows - 1) * stepM, "world overview maximum z");
  if (Math.abs(maxX) > WORLD_OVERVIEW_MAX_ORIGIN_ABS_M || Math.abs(maxZ) > WORLD_OVERVIEW_MAX_ORIGIN_ABS_M) {
    fail("world overview grid extent exceeds the supported world range");
  }
  const heights = ownedTypedArray(descriptors.heights.value, Float32Array.prototype, cells, "world overview heights");
  const paintMaterial = ownedTypedArray(descriptors.paintMaterial.value, Uint8Array.prototype, cells, "world overview paintMaterial");
  const paintWeight = ownedTypedArray(descriptors.paintWeight.value, Uint8Array.prototype, cells, "world overview paintWeight");
  for (let index = 0; index < cells; index++) {
    meter.work();
    const height = heights[index];
    if (!Number.isFinite(height) || Object.is(height, -0) || Math.abs(height) > WORLD_OVERVIEW_MAX_HEIGHT_ABS_M) {
      fail(`world overview heights[${index}] must be finite canonical metres within the supported range`);
    }
  }
  return Object.freeze({ rows, cols, cells, origin, stepM, heights, paintMaterial, paintWeight });
}

function writeHeader(view, grid, offsets) {
  for (let index = 0; index < MAGIC.length; index++) view.setUint8(index, MAGIC[index]);
  view.setUint16(8, WORLD_OVERVIEW_ARTIFACT_VERSION, true);
  view.setUint16(10, WORLD_OVERVIEW_ARTIFACT_HEADER_BYTES, true);
  view.setUint32(12, offsets.byteLength, true);
  view.setUint16(16, grid.rows, true);
  view.setUint16(18, grid.cols, true);
  view.setUint32(20, grid.cells, true);
  view.setFloat64(24, grid.origin[0], true);
  view.setFloat64(32, grid.origin[1], true);
  view.setFloat64(40, grid.stepM, true);
  view.setUint32(48, offsets.heights, true);
  view.setUint32(52, offsets.paintMaterial, true);
  view.setUint32(56, offsets.paintWeight, true);
  view.setUint32(60, 0, true);
}

export function encodeWorldOverviewArtifact(input, controlInput) {
  const meter = createMeter(parseControl(controlInput), WORLD_OVERVIEW_MAX_CELLS * 2 + 4096);
  meter.start();
  const grid = parseGrid(input, meter);
  const offsets = layout(grid.cells);
  const bytes = new Uint8Array(offsets.byteLength);
  const view = new DataView(bytes.buffer);
  writeHeader(view, grid, offsets);
  for (let index = 0; index < grid.cells; index++) {
    meter.work();
    view.setFloat32(offsets.heights + index * 4, grid.heights[index], true);
  }
  bytes.set(grid.paintMaterial, offsets.paintMaterial);
  bytes.set(grid.paintWeight, offsets.paintWeight);
  meter.finish();
  return bytes;
}

function artifactBytes(input) {
  if (!ArrayBuffer.isView(input) || Object.getPrototypeOf(input) !== Uint8Array.prototype
      || !(input.buffer instanceof ArrayBuffer) || isShared(input.buffer)
      || input.byteOffset !== 0 || input.byteLength !== input.buffer.byteLength) {
    fail("world overview artifact bytes must be an owned Uint8Array over a non-shared ArrayBuffer");
  }
  if (input.byteLength < WORLD_OVERVIEW_ARTIFACT_HEADER_BYTES || input.byteLength > WORLD_OVERVIEW_MAX_ARTIFACT_BYTES) {
    fail("world overview artifact byte length is outside the supported range");
  }
  return input;
}

export function decodeWorldOverviewArtifact(input, controlInput) {
  const bytes = artifactBytes(input);
  const meter = createMeter(parseControl(controlInput), WORLD_OVERVIEW_MAX_CELLS * 2 + 4096);
  meter.start();
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < MAGIC.length; index++) if (view.getUint8(index) !== MAGIC[index]) fail("world overview artifact magic mismatch");
  if (view.getUint16(8, true) !== WORLD_OVERVIEW_ARTIFACT_VERSION) fail("world overview artifact version is unsupported");
  if (view.getUint16(10, true) !== WORLD_OVERVIEW_ARTIFACT_HEADER_BYTES) fail("world overview artifact header length mismatch");
  const rows = dimension(view.getUint16(16, true), "world overview rows");
  const cols = dimension(view.getUint16(18, true), "world overview cols");
  const cells = rows * cols;
  if (view.getUint32(20, true) !== cells) fail("world overview artifact cell count mismatch");
  const offsets = layout(cells);
  if (view.getUint32(12, true) !== bytes.byteLength || bytes.byteLength !== offsets.byteLength) fail("world overview artifact byte length is non-canonical");
  if (view.getUint32(48, true) !== offsets.heights || view.getUint32(52, true) !== offsets.paintMaterial
      || view.getUint32(56, true) !== offsets.paintWeight) fail("world overview artifact channel offsets are non-canonical");
  if (view.getUint32(60, true) !== 0) fail("world overview artifact reserved header bytes must be zero");

  const origin = originTuple([view.getFloat64(24, true), view.getFloat64(32, true)]);
  const stepM = canonicalFinite(view.getFloat64(40, true), "world overview stepM");
  const heights = new Float32Array(cells);
  const paintMaterial = new Uint8Array(cells);
  const paintWeight = new Uint8Array(cells);
  for (let index = 0; index < cells; index++) {
    meter.work();
    heights[index] = view.getFloat32(offsets.heights + index * 4, true);
  }
  paintMaterial.set(bytes.subarray(offsets.paintMaterial, offsets.paintWeight));
  paintWeight.set(bytes.subarray(offsets.paintWeight));
  parseGrid({ rows, cols, origin, stepM, heights, paintMaterial, paintWeight }, meter);
  meter.finish();
  const grid = Object.freeze({ rows, cols, origin, stepM, heights, paintMaterial, paintWeight });
  const metadata = Object.freeze({
    artifactType: WORLD_OVERVIEW_ARTIFACT_TYPE,
    mediaType: WORLD_OVERVIEW_ARTIFACT_MEDIA_TYPE,
    version: WORLD_OVERVIEW_ARTIFACT_VERSION,
    byteLength: bytes.byteLength,
    cells,
    offsets,
    storage: "owned-transferable-channel-copies",
  });
  return Object.freeze({ grid, metadata });
}
