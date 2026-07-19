const DEFAULT_POLICY = Object.freeze({
  minimumDynamicRange: 4,
  minimumStandardDeviation: 1.5,
  maximumBlackCrushFraction: 0.985,
  maximumWhiteClipFraction: 0.985,
});

export function validateReviewPixels(rgba, width, height, options = {}) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || rgba.length !== width * height * 4) {
    throw new Error(`${options.label ?? "review"} pixel sanity input dimensions drifted`);
  }
  const policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
  const histogram = new Array(64).fill(0), pixels = width * height;
  let sum = 0, sumSquares = 0, minimum = 255, maximum = 0, black = 0, white = 0;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const luminance = Math.round((rgba[offset] * 54 + rgba[offset + 1] * 183 + rgba[offset + 2] * 19) / 256);
    histogram[Math.min(63, luminance >>> 2)]++;
    sum += luminance;
    sumSquares += luminance * luminance;
    minimum = Math.min(minimum, luminance);
    maximum = Math.max(maximum, luminance);
    if (luminance <= 4) black++;
    if (luminance >= 250) white++;
  }
  const mean = sum / pixels, variance = Math.max(0, sumSquares / pixels - mean * mean), standardDeviation = Math.sqrt(variance);
  const metrics = Object.freeze({
    schema: "limina.rgba-luminance-sanity/v1",
    basis: "rec709-integer-rgba8",
    pixels,
    minimum,
    maximum,
    dynamicRange: maximum - minimum,
    mean: Number(mean.toFixed(4)),
    standardDeviation: Number(standardDeviation.toFixed(4)),
    blackCrushFraction: Number((black / pixels).toFixed(8)),
    whiteClipFraction: Number((white / pixels).toFixed(8)),
    histogram: Object.freeze(histogram),
  });
  const label = options.label ?? "review";
  if (metrics.dynamicRange < policy.minimumDynamicRange || metrics.standardDeviation < policy.minimumStandardDeviation) {
    throw new Error(`${label} frame is blank or near-uniform: ${JSON.stringify(metrics)}`);
  }
  if (metrics.blackCrushFraction > policy.maximumBlackCrushFraction) {
    throw new Error(`${label} frame has severe black crush: ${JSON.stringify(metrics)}`);
  }
  if (metrics.whiteClipFraction > policy.maximumWhiteClipFraction) {
    throw new Error(`${label} frame has severe white clipping: ${JSON.stringify(metrics)}`);
  }
  return metrics;
}
