// Canonical WB-W1 hydrology authoring inputs shared by Atlas compilation and the WorldMap
// boundary. This recipe selects deterministic derived work; it never contains generated topology.

export const HYDROLOGY_RECIPE_SCHEMA = "limina.hydrology-recipe/v1";

export const HYDROLOGY_LIMITS = Object.freeze({
  precipitationMmPerYear: 100_000,
  catchmentAreaM2: 1_000_000_000_000,
  basinAreaM2: 1_000_000_000_000,
  basinDepthM: 20_000,
  waterfallDropM: 20_000,
});

const HYDROLOGY_RECIPE_KEYS = new Set([
  "schema",
  "precipitationMmPerYear",
  "riverMinCatchmentAreaM2",
  "basinMinAreaM2",
  "basinMinDepthM",
  "waterfallMinDropM",
]);

export class HydrologyIrValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "HydrologyIrValidationError";
  }
}

function fail(message) {
  throw new HydrologyIrValidationError(message);
}

function requirePlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("hydrology must be a plain object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("hydrology must be a plain object");
  if (Object.getOwnPropertySymbols(value).length !== 0) fail("hydrology must not contain symbol fields");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!HYDROLOGY_RECIPE_KEYS.has(key)) fail(`hydrology has unknown field '${key}'`);
    if (!("value" in descriptor) || descriptor.enumerable !== true) fail(`hydrology.${key} must be an enumerable data field`);
  }
  for (const key of HYDROLOGY_RECIPE_KEYS) if (!Object.hasOwn(value, key)) fail(`hydrology is missing '${key}'`);
  return descriptors;
}

function requireCanonicalNumber(descriptor, path, maximum, allowZero) {
  const value = descriptor.value;
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)
      || (allowZero ? value < 0 : value <= 0) || value > maximum) {
    fail(`${path} must be a finite canonical ${allowZero ? "non-negative" : "positive"} number at most ${maximum}`);
  }
  return value;
}

/** Parse and clone the optional authored hydrology recipe without invoking accessors. */
export function parseAuthoredHydrologyRecipe(value) {
  const descriptors = requirePlainRecord(value);
  if (descriptors.schema.value !== HYDROLOGY_RECIPE_SCHEMA) {
    fail(`hydrology.schema must be '${HYDROLOGY_RECIPE_SCHEMA}'`);
  }
  return Object.freeze({
    schema: HYDROLOGY_RECIPE_SCHEMA,
    precipitationMmPerYear: requireCanonicalNumber(
      descriptors.precipitationMmPerYear,
      "hydrology.precipitationMmPerYear",
      HYDROLOGY_LIMITS.precipitationMmPerYear,
      true,
    ),
    riverMinCatchmentAreaM2: requireCanonicalNumber(
      descriptors.riverMinCatchmentAreaM2,
      "hydrology.riverMinCatchmentAreaM2",
      HYDROLOGY_LIMITS.catchmentAreaM2,
      false,
    ),
    basinMinAreaM2: requireCanonicalNumber(
      descriptors.basinMinAreaM2,
      "hydrology.basinMinAreaM2",
      HYDROLOGY_LIMITS.basinAreaM2,
      false,
    ),
    basinMinDepthM: requireCanonicalNumber(
      descriptors.basinMinDepthM,
      "hydrology.basinMinDepthM",
      HYDROLOGY_LIMITS.basinDepthM,
      false,
    ),
    waterfallMinDropM: requireCanonicalNumber(
      descriptors.waterfallMinDropM,
      "hydrology.waterfallMinDropM",
      HYDROLOGY_LIMITS.waterfallDropM,
      false,
    ),
  });
}
