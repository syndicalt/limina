/**
 * Mechanical fixed-camera pixel regression guard.
 *
 * This deliberately does not answer whether a scene is visually good. It only
 * rejects material drift from an already human-approved production capture.
 * Human comparison against the locked reference set remains the release verdict.
 */

export const FIXED_CAMERA_REGRESSION_SCHEMA = "limina.fixed-camera-regression/v1" as const;

export interface FixedCameraRegressionPolicy {
  readonly schema: typeof FIXED_CAMERA_REGRESSION_SCHEMA;
  readonly largeDelta: number;
  readonly tileGrid: readonly [number, number];
  readonly maxMeanAbsoluteError: number;
  readonly maxRootMeanSquareError: number;
  readonly maxLargeChannelFraction: number;
  readonly maxTileMeanAbsoluteError: number;
}

export interface FixedCameraRegressionMetrics {
  readonly meanAbsoluteError: number;
  readonly rootMeanSquareError: number;
  readonly largeChannelFraction: number;
  readonly maxTileMeanAbsoluteError: number;
  readonly maxTile: Readonly<{ column: number; row: number }>;
}

export interface FixedCameraRegressionEvaluation {
  readonly passed: boolean;
  readonly metrics: FixedCameraRegressionMetrics;
  readonly violations: readonly string[];
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive integer`);
  return value;
}

function finiteLimit(value: number, label: string, maximum: number): number {
  if (!Number.isFinite(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} must be finite and in [0,${maximum}]`);
  }
  return value;
}

export function validateFixedCameraRegressionPolicy(
  policy: Readonly<FixedCameraRegressionPolicy>,
): FixedCameraRegressionPolicy {
  if (policy.schema !== FIXED_CAMERA_REGRESSION_SCHEMA) throw new Error("unsupported fixed-camera regression schema");
  const columns = positiveInteger(policy.tileGrid?.[0], "fixed-camera tile columns");
  const rows = positiveInteger(policy.tileGrid?.[1], "fixed-camera tile rows");
  if (columns > 64 || rows > 64) throw new RangeError("fixed-camera tile grid dimensions must not exceed 64");
  const largeDelta = finiteLimit(policy.largeDelta, "fixed-camera largeDelta", 255);
  if (!Number.isSafeInteger(largeDelta)) throw new RangeError("fixed-camera largeDelta must be an integer");
  return Object.freeze({
    schema: FIXED_CAMERA_REGRESSION_SCHEMA,
    largeDelta,
    tileGrid: Object.freeze([columns, rows] as const),
    maxMeanAbsoluteError: finiteLimit(policy.maxMeanAbsoluteError, "fixed-camera maxMeanAbsoluteError", 255),
    maxRootMeanSquareError: finiteLimit(policy.maxRootMeanSquareError, "fixed-camera maxRootMeanSquareError", 255),
    maxLargeChannelFraction: finiteLimit(policy.maxLargeChannelFraction, "fixed-camera maxLargeChannelFraction", 1),
    maxTileMeanAbsoluteError: finiteLimit(policy.maxTileMeanAbsoluteError, "fixed-camera maxTileMeanAbsoluteError", 255),
  });
}

/** Compare tightly packed, top-left-origin RGBA8 images while ignoring alpha. */
export function evaluateFixedCameraRegression(input: Readonly<{
  width: number;
  height: number;
  baselineRgba: Uint8Array;
  candidateRgba: Uint8Array;
  policy: Readonly<FixedCameraRegressionPolicy>;
}>): FixedCameraRegressionEvaluation {
  const width = positiveInteger(input.width, "fixed-camera width");
  const height = positiveInteger(input.height, "fixed-camera height");
  const byteLength = width * height * 4;
  if (!Number.isSafeInteger(byteLength) || input.baselineRgba.byteLength !== byteLength
      || input.candidateRgba.byteLength !== byteLength) {
    throw new RangeError(`fixed-camera RGBA inputs must each contain exactly ${byteLength} bytes`);
  }
  const policy = validateFixedCameraRegressionPolicy(input.policy);
  const [tileColumns, tileRows] = policy.tileGrid;
  const tileAbsolute = new Float64Array(tileColumns * tileRows);
  const tileChannels = new Uint32Array(tileColumns * tileRows);
  let absolute = 0;
  let squared = 0;
  let largeChannels = 0;
  for (let y = 0; y < height; y++) {
    const tileRow = Math.min(tileRows - 1, Math.floor((y * tileRows) / height));
    for (let x = 0; x < width; x++) {
      const tileColumn = Math.min(tileColumns - 1, Math.floor((x * tileColumns) / width));
      const tile = tileRow * tileColumns + tileColumn;
      const pixel = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const delta = Math.abs(input.baselineRgba[pixel + channel] - input.candidateRgba[pixel + channel]);
        absolute += delta;
        squared += delta * delta;
        if (delta > policy.largeDelta) largeChannels++;
        tileAbsolute[tile] += delta;
        tileChannels[tile]++;
      }
    }
  }
  const channelCount = width * height * 3;
  let maxTileMeanAbsoluteError = 0;
  let maxTile = 0;
  for (let tile = 0; tile < tileAbsolute.length; tile++) {
    const mean = tileChannels[tile] === 0 ? 0 : tileAbsolute[tile] / tileChannels[tile];
    if (mean > maxTileMeanAbsoluteError) {
      maxTileMeanAbsoluteError = mean;
      maxTile = tile;
    }
  }
  const metrics = Object.freeze({
    meanAbsoluteError: absolute / channelCount,
    rootMeanSquareError: Math.sqrt(squared / channelCount),
    largeChannelFraction: largeChannels / channelCount,
    maxTileMeanAbsoluteError,
    maxTile: Object.freeze({ column: maxTile % tileColumns, row: Math.floor(maxTile / tileColumns) }),
  });
  const violations: string[] = [];
  if (metrics.meanAbsoluteError > policy.maxMeanAbsoluteError) violations.push(
    `mean absolute error ${metrics.meanAbsoluteError} exceeds ${policy.maxMeanAbsoluteError}`,
  );
  if (metrics.rootMeanSquareError > policy.maxRootMeanSquareError) violations.push(
    `root mean square error ${metrics.rootMeanSquareError} exceeds ${policy.maxRootMeanSquareError}`,
  );
  if (metrics.largeChannelFraction > policy.maxLargeChannelFraction) violations.push(
    `large-channel fraction ${metrics.largeChannelFraction} exceeds ${policy.maxLargeChannelFraction}`,
  );
  if (metrics.maxTileMeanAbsoluteError > policy.maxTileMeanAbsoluteError) violations.push(
    `tile (${metrics.maxTile.column},${metrics.maxTile.row}) mean absolute error ${metrics.maxTileMeanAbsoluteError} exceeds ${policy.maxTileMeanAbsoluteError}`,
  );
  return Object.freeze({ passed: violations.length === 0, metrics, violations: Object.freeze(violations) });
}
