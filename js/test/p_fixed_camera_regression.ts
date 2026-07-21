import {
  evaluateFixedCameraRegression,
  FIXED_CAMERA_REGRESSION_SCHEMA,
  validateFixedCameraRegressionPolicy,
  type FixedCameraRegressionPolicy,
} from "../src/render/fixed-camera-regression.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_fixed_camera_regression FAIL: ${message}`);
}

const policy: FixedCameraRegressionPolicy = Object.freeze({
  schema: FIXED_CAMERA_REGRESSION_SCHEMA,
  largeDelta: 8,
  tileGrid: Object.freeze([4, 2] as const),
  maxMeanAbsoluteError: 1.5,
  maxRootMeanSquareError: 7,
  maxLargeChannelFraction: 0.04,
  maxTileMeanAbsoluteError: 7,
});
const width = 40, height = 20;
const baseline = new Uint8Array(width * height * 4).fill(128);
const jitter = baseline.slice();
for (let pixel = 0; pixel < width * height; pixel++) {
  const offset = pixel * 4;
  jitter[offset] += pixel % 3 === 0 ? 2 : 0;
  jitter[offset + 1] -= pixel % 5 === 0 ? 2 : 0;
  jitter[offset + 2] += pixel % 7 === 0 ? 1 : 0;
  jitter[offset + 3] = pixel % 2 === 0 ? 0 : 255;
}
const jitterResult = evaluateFixedCameraRegression({ width, height, baselineRgba: baseline, candidateRgba: jitter, policy });
assert(jitterResult.passed, `bounded raster jitter was rejected: ${jitterResult.violations.join("; ")}`);
assert(jitterResult.metrics.meanAbsoluteError > 0 && jitterResult.metrics.largeChannelFraction === 0,
  "regression metrics did not distinguish bounded jitter from a byte-identical frame");

const missingRegion = baseline.slice();
for (let y = 0; y < height / 2; y++) for (let x = 0; x < width / 2; x++) {
  const offset = (y * width + x) * 4;
  missingRegion[offset] = missingRegion[offset + 1] = missingRegion[offset + 2] = 0;
}
const missingResult = evaluateFixedCameraRegression({ width, height, baselineRgba: baseline, candidateRgba: missingRegion, policy });
assert(!missingResult.passed && missingResult.violations.length >= 3,
  "a missing scene quadrant did not fail the mechanical regression envelope");
assert(missingResult.metrics.maxTile.column < 2 && missingResult.metrics.maxTile.row === 0,
  "tile localization did not identify the missing scene region");

const alphaOnly = baseline.slice();
for (let offset = 3; offset < alphaOnly.length; offset += 4) alphaOnly[offset] = 0;
assert(evaluateFixedCameraRegression({ width, height, baselineRgba: baseline, candidateRgba: alphaOnly, policy }).passed,
  "alpha-only swapchain differences affected the RGB regression contract");

for (const invalid of [
  { ...policy, schema: "bad" },
  { ...policy, largeDelta: 1.5 },
  { ...policy, tileGrid: [0, 9] },
  { ...policy, maxLargeChannelFraction: 1.1 },
]) {
  let rejected = false;
  try { validateFixedCameraRegressionPolicy(invalid as FixedCameraRegressionPolicy); } catch { rejected = true; }
  assert(rejected, `invalid policy was accepted: ${JSON.stringify(invalid)}`);
}
let sizeRejected = false;
try {
  evaluateFixedCameraRegression({ width, height, baselineRgba: baseline, candidateRgba: jitter.subarray(4), policy });
} catch { sizeRejected = true; }
assert(sizeRejected, "mismatched fixed-camera image dimensions were accepted");

console.log("p_fixed_camera_regression OK: bounded raster jitter passes while missing regions, invalid policy, and size drift fail");
