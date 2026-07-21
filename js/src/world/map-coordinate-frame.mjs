// MapDoc horizontal coordinate conversion. MapDoc stores authored units per metre; engine-facing
// world coordinates are metres. This module is dependency-free so compiler and browser code can
// share the exact validation and affine transform.

export const MAX_MAP_WORLD_COORDINATE_M = 10_000_000;

export class MapCoordinateFrameError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "MapCoordinateFrameError";
    this.code = "INVALID_MAP_COORDINATE_FRAME";
  }
}

function fail(message) {
  throw new MapCoordinateFrameError(message);
}

function dataRecord(input, keys, label) {
  if (input === null || typeof input !== "object" || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype
      || Object.getOwnPropertySymbols(input).length !== 0) {
    fail(`${label} must be a plain object`);
  }
  const names = Object.getOwnPropertyNames(input);
  if (names.length !== keys.length || names.some((name) => !keys.includes(name))) {
    fail(`${label} fields are invalid`);
  }
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      fail(`${label}.${key} must be an enumerable data field`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function canonicalFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}

function boundedWorldNumber(value, label) {
  const number = canonicalFinite(value, label);
  if (Math.abs(number) > MAX_MAP_WORLD_COORDINATE_M) {
    fail(`${label} exceeds the supported world coordinate range`);
  }
  return number;
}

function denseTuple(input, label, numberParser = canonicalFinite) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype
      || input.length !== 2 || Object.getOwnPropertySymbols(input).length !== 0
      || Object.getOwnPropertyNames(input).length !== 3) {
    fail(`${label} must be a dense two-number tuple`);
  }
  const output = new Array(2);
  for (let index = 0; index < 2; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      fail(`${label}[${index}] must be an enumerable data field`);
    }
    output[index] = numberParser(descriptor.value, `${label}[${index}]`);
  }
  return Object.freeze(output);
}

function closeEnough(actual, expected) {
  const tolerance = Number.EPSILON * 32 * Math.max(1, Math.abs(actual), Math.abs(expected));
  return Math.abs(actual - expected) <= tolerance;
}

function assertRoundTrip(actual, expected, label) {
  if (!Number.isFinite(actual) || !closeEnough(actual, expected)) {
    fail(`${label} loses precision under the map coordinate transform`);
  }
}

/** Strictly parse `{ kind:"m", unitsPerMeter, origin:[worldX,worldZ] }`. */
export function parseMapCoordinateFrame(input) {
  const fields = dataRecord(input, ["kind", "unitsPerMeter", "origin"], "MapDoc units");
  if (fields.kind !== "m") fail('MapDoc units.kind must be "m"');
  const unitsPerMeter = canonicalFinite(fields.unitsPerMeter, "MapDoc units.unitsPerMeter");
  if (!(unitsPerMeter > 0) || !Number.isFinite(1 / unitsPerMeter) || !(1 / unitsPerMeter > 0)) {
    fail("MapDoc units.unitsPerMeter must be finite, positive, and have a finite positive reciprocal");
  }
  const origin = denseTuple(fields.origin, "MapDoc units.origin", boundedWorldNumber);
  return Object.freeze({ kind: "m", unitsPerMeter, origin });
}

function frame(input) {
  return parseMapCoordinateFrame(input);
}

/** Convert a MapDoc-local XZ tuple to canonical world metres: `origin + local / u`. */
export function mapLocalToWorld(unitsInput, localInput) {
  const units = frame(unitsInput);
  const local = denseTuple(localInput, "MapDoc local coordinate");
  const world = new Array(2);
  for (let index = 0; index < 2; index++) {
    const delta = local[index] / units.unitsPerMeter;
    const value = boundedWorldNumber(units.origin[index] + delta, `world coordinate[${index}]`);
    assertRoundTrip((value - units.origin[index]) * units.unitsPerMeter, local[index], `MapDoc local coordinate[${index}]`);
    world[index] = value;
  }
  return Object.freeze(world);
}

/** Convert canonical world metres to a MapDoc-local XZ tuple: `(world - origin) * u`. */
export function mapWorldToLocal(unitsInput, worldInput) {
  const units = frame(unitsInput);
  const world = denseTuple(worldInput, "world coordinate", boundedWorldNumber);
  const local = new Array(2);
  for (let index = 0; index < 2; index++) {
    const value = canonicalFinite((world[index] - units.origin[index]) * units.unitsPerMeter, `MapDoc local coordinate[${index}]`);
    assertRoundTrip(units.origin[index] + value / units.unitsPerMeter, world[index], `world coordinate[${index}]`);
    local[index] = value;
  }
  return Object.freeze(local);
}

/** Convert a non-negative physical length in metres to MapDoc-local units. */
export function mapMetersToLocalLength(unitsInput, metersInput) {
  const units = frame(unitsInput);
  const meters = canonicalFinite(metersInput, "length in metres");
  if (meters < 0 || meters > MAX_MAP_WORLD_COORDINATE_M) {
    fail("length in metres must be non-negative and within the supported world range");
  }
  const local = canonicalFinite(meters * units.unitsPerMeter, "MapDoc local length");
  assertRoundTrip(local / units.unitsPerMeter, meters, "length in metres");
  return local;
}

/** Convert a positive MapDoc-local axis-aligned rect to canonical world metres. */
export function mapLocalRectToWorld(unitsInput, rectInput) {
  const units = frame(unitsInput);
  const rect = dataRecord(rectInput, ["x0", "z0", "w", "h"], "MapDoc local rect");
  const x0 = canonicalFinite(rect.x0, "MapDoc local rect.x0");
  const z0 = canonicalFinite(rect.z0, "MapDoc local rect.z0");
  const width = canonicalFinite(rect.w, "MapDoc local rect.w");
  const height = canonicalFinite(rect.h, "MapDoc local rect.h");
  if (!(width > 0) || !(height > 0)) fail("MapDoc local rect dimensions must be positive");

  const start = mapLocalToWorld(units, [x0, z0]);
  const end = mapLocalToWorld(units, [x0 + width, z0 + height]);
  const worldWidth = canonicalFinite(end[0] - start[0], "world rect.w");
  const worldHeight = canonicalFinite(end[1] - start[1], "world rect.h");
  if (!(worldWidth > 0) || !(worldHeight > 0)) fail("MapDoc local rect loses positive extent under the map coordinate transform");
  assertRoundTrip(worldWidth * units.unitsPerMeter, width, "MapDoc local rect.w");
  assertRoundTrip(worldHeight * units.unitsPerMeter, height, "MapDoc local rect.h");
  return Object.freeze({ x0: start[0], z0: start[1], w: worldWidth, h: worldHeight });
}
