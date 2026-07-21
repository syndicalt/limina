// Deterministic terrain incision for generated hydrology reaches. Hydrology is solved against the
// globally eroded authority first; this presentation/collision field then cuts a bed and blended
// banks beneath the exact verified water surface. It never raises terrain and never mutates input.

export const RIVER_CHANNEL_CARVE_POLICY_VERSION = 1;
export const RIVER_CHANNEL_CARVE_POLICY = Object.freeze({
  schema: "limina.river-channel-carve-policy/v1",
  version: RIVER_CHANNEL_CARVE_POLICY_VERSION,
  minimumDepthM: 0.4,
  maximumDepthM: 3.5,
  widthDepthScale: 0.16,
  edgeDepthFraction: 0.3,
  bankWidthScale: 0.8,
  minimumBankCells: 1.5,
});

export class RiverChannelCarveCancelledError extends Error {
  constructor() { super("river channel carve cancelled"); this.name = "RiverChannelCarveCancelledError"; }
}

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}

function smoothstep(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function closestSegment(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, length2 = dx * dx + dz * dz;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / length2));
  const px = ax + dx * t, pz = az + dz * t;
  return { t, distance: Math.hypot(x - px, z - pz) };
}

/** Return an owned carved height array plus falsifiable cut/bank diagnostics. */
export function carveGeneratedRiverChannels(input, options = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("river channel carve input must be an object");
  const rows = input.rows, cols = input.cols;
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || rows < 2 || cols < 2) {
    throw new RangeError("river channel carve rows and cols must be integers >= 2");
  }
  const cellSizeM = finite(input.cellSizeM, "river channel carve cellSizeM");
  if (!(cellSizeM > 0)) throw new RangeError("river channel carve cellSizeM must be positive");
  const originX = finite(input.originX, "river channel carve originX");
  const originZ = finite(input.originZ, "river channel carve originZ");
  const source = input.heightsM;
  if (!(source instanceof Float32Array || source instanceof Float64Array) || source.length !== rows * cols) {
    throw new RangeError("river channel carve heightsM must be a complete rows*cols float array");
  }
  if (!Array.isArray(input.reaches)) throw new TypeError("river channel carve reaches must be an array");
  const shouldCancel = options.shouldCancel;
  if (shouldCancel !== undefined && typeof shouldCancel !== "function") throw new TypeError("river channel carve shouldCancel must be a function");
  const minimumHeightM = options.minimumHeightM === undefined ? -Infinity : finite(options.minimumHeightM, "river channel carve minimumHeightM");

  const heightsM = new Float64Array(source);
  let segmentCount = 0, candidateSamples = 0, carvedSamples = 0, bankSamples = 0, maxCutDepthM = 0;
  const carved = new Uint8Array(source.length), banked = new Uint8Array(source.length);
  for (const reach of input.reaches) {
    if (!Array.isArray(reach.points) || !Array.isArray(reach.widths) || !Array.isArray(reach.surfaceElevationsM)
        || reach.points.length < 2 || reach.widths.length !== reach.points.length
        || reach.surfaceElevationsM.length !== reach.points.length) {
      throw new RangeError("river channel carve reach attributes must be point-aligned");
    }
    for (let segment = 0; segment < reach.points.length - 1; segment++) {
      if ((segmentCount++ & 63) === 0 && shouldCancel?.()) throw new RiverChannelCarveCancelledError();
      const a = reach.points[segment], b = reach.points[segment + 1];
      const ax = finite(a[0], "river channel point x"), az = finite(a[1], "river channel point z");
      const bx = finite(b[0], "river channel point x"), bz = finite(b[1], "river channel point z");
      const widthA = finite(reach.widths[segment], "river channel width"), widthB = finite(reach.widths[segment + 1], "river channel width");
      const surfaceA = finite(reach.surfaceElevationsM[segment], "river channel surface"), surfaceB = finite(reach.surfaceElevationsM[segment + 1], "river channel surface");
      if (!(widthA > 0) || !(widthB > 0)) throw new RangeError("river channel widths must be positive");
      const maximumWidth = Math.max(widthA, widthB);
      const maximumBank = Math.max(cellSizeM * RIVER_CHANNEL_CARVE_POLICY.minimumBankCells,
        maximumWidth * RIVER_CHANNEL_CARVE_POLICY.bankWidthScale);
      const radius = maximumWidth / 2 + maximumBank;
      const minCol = Math.max(0, Math.floor((Math.min(ax, bx) - radius - originX) / cellSizeM));
      const maxCol = Math.min(cols - 1, Math.ceil((Math.max(ax, bx) + radius - originX) / cellSizeM));
      const minRow = Math.max(0, Math.floor((Math.min(az, bz) - radius - originZ) / cellSizeM));
      const maxRow = Math.min(rows - 1, Math.ceil((Math.max(az, bz) + radius - originZ) / cellSizeM));
      for (let row = minRow; row <= maxRow; row++) for (let col = minCol; col <= maxCol; col++) {
        candidateSamples++;
        const x = originX + col * cellSizeM, z = originZ + row * cellSizeM;
        const closest = closestSegment(x, z, ax, az, bx, bz);
        const width = widthA + (widthB - widthA) * closest.t;
        const surface = surfaceA + (surfaceB - surfaceA) * closest.t;
        const halfWater = width / 2;
        const bankWidth = Math.max(cellSizeM * RIVER_CHANNEL_CARVE_POLICY.minimumBankCells,
          width * RIVER_CHANNEL_CARVE_POLICY.bankWidthScale);
        if (closest.distance > halfWater + bankWidth) continue;
        const depth = Math.max(RIVER_CHANNEL_CARVE_POLICY.minimumDepthM,
          Math.min(RIVER_CHANNEL_CARVE_POLICY.maximumDepthM, width * RIVER_CHANNEL_CARVE_POLICY.widthDepthScale));
        const edgeDepth = depth * RIVER_CHANNEL_CARVE_POLICY.edgeDepthFraction;
        let target;
        let isBank = false;
        if (closest.distance <= halfWater) {
          const across = halfWater === 0 ? 0 : closest.distance / halfWater;
          target = surface - (depth + (edgeDepth - depth) * across * across);
        } else {
          isBank = true;
          const blend = smoothstep((closest.distance - halfWater) / bankWidth);
          const original = source[row * cols + col];
          target = surface - edgeDepth + (original - (surface - edgeDepth)) * blend;
        }
        const index = row * cols + col, original = source[index];
        const next = Math.max(minimumHeightM, Math.min(heightsM[index], original, target));
        if (next < heightsM[index]) {
          heightsM[index] = next;
          carved[index] = 1;
          if (isBank) banked[index] = 1;
          maxCutDepthM = Math.max(maxCutDepthM, original - next);
        }
      }
    }
  }
  for (let index = 0; index < carved.length; index++) {
    carvedSamples += carved[index];
    bankSamples += banked[index];
  }
  return Object.freeze({
    heightsM,
    diagnostics: Object.freeze({ policyVersion: RIVER_CHANNEL_CARVE_POLICY_VERSION, segmentCount, candidateSamples,
      carvedSamples, bankSamples, maxCutDepthM }),
  });
}
