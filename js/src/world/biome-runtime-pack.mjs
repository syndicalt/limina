// B3 runtime bindings for the immutable biome metadata library. This contract deliberately keeps
// deterministic population/material rules separate from content-addressed assets: a symbolic role
// is not renderable until an explicit binding fulfills it.

import { biomePackContentHash, parseBiomePack } from "./biome-ir.mjs";
import { sha256 } from "./sha256.mjs";

export const BIOME_RUNTIME_PACK_SCHEMA = "limina.biome-runtime-pack/v1";
export const BIOME_RUNTIME_FULFILLMENT_STATES = Object.freeze(["metadata-only", "partial", "fulfilled"]);
export const BIOME_RUNTIME_BINDING_KINDS = Object.freeze(["surface", "vegetation"]);
export const BIOME_RUNTIME_PACK_LIMITS = Object.freeze({
  biomes: 64,
  surfaceRules: 4,
  vegetationRules: 8,
  bindingsPerBiome: 12,
  idChars: 160,
  radiusM: 10_000,
  elevationM: 1_000_000,
  waterDistanceM: 1_000_000,
  scale: 100,
  weight: 1_000_000,
  tileScaleM: 10_000,
  displacementScaleM: 10,
  labelChars: 96,
  uriChars: 512,
});

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const REF = /^[a-z][a-z0-9._/-]*$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

export class BiomeRuntimePackValidationError extends Error {
  constructor(message) { super(message); this.name = "BiomeRuntimePackValidationError"; }
}
function fail(message) { throw new BiomeRuntimePackValidationError(message); }

function record(value, required, optional, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${label} must not contain symbol fields`);
  const allowed = new Set([...required, ...optional]);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key)) fail(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor) || descriptor.enumerable !== true) fail(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label} is missing '${key}'`);
  return descriptors;
}

function dense(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    fail(`${label} must be a standard array with at most ${maximum} entries`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    fail(`${label} must be dense and field-free`);
  }
  return value;
}

function string(value, pattern, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}

function text(value, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value
      || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} is invalid`);
  return value;
}

function number(value, minimum, maximum, label, positive = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)
      || value < minimum || value > maximum || (positive && value === 0)) {
    fail(`${label} must be a finite canonical number in ${positive ? "(" : "["}${minimum}, ${maximum}]`);
  }
  return value;
}

function integer(value, minimum, maximum, label) {
  const parsed = number(value, minimum, maximum, label);
  if (!Number.isSafeInteger(parsed)) fail(`${label} must be an integer`);
  return parsed;
}

function tupleBand(value, minimum, maximum, label, positive = false) {
  const source = dense(value, 2, label);
  if (source.length !== 2) fail(`${label} must contain exactly [min, max]`);
  const min = number(source[0], minimum, maximum, `${label}[0]`, positive);
  const max = number(source[1], minimum, maximum, `${label}[1]`, positive);
  if (max < min) fail(`${label}[1] must be at least ${label}[0]`);
  return Object.freeze([min, max]);
}

function tuple3(value, minimum, maximum, label, positive = false) {
  const source = dense(value, 3, label);
  if (source.length !== 3) fail(`${label} must contain exactly three values`);
  return Object.freeze(source.map((entry, index) => number(entry, minimum, maximum, `${label}[${index}]`, positive)));
}

function surfaceCalibration(value, label) {
  const d = record(value, new Set(["albedoLinearGain", "normalStrength", "displacementScaleM"]), new Set(), label);
  return Object.freeze({
    albedoLinearGain: tuple3(d.albedoLinearGain.value, Number.MIN_VALUE, 4, `${label}.albedoLinearGain`, true),
    normalStrength: number(d.normalStrength.value, 0, 4, `${label}.normalStrength`),
    displacementScaleM: number(d.displacementScaleM.value, 0, BIOME_RUNTIME_PACK_LIMITS.displacementScaleM,
      `${label}.displacementScaleM`),
  });
}

function surfaceEnvironment(value, label) {
  const d = record(value, new Set(["overlayWeight"]), new Set(["slope01", "elevationM", "waterDistanceM"]), label);
  const band = (descriptor, minimum, maximum, path) => {
    if (descriptor === undefined) return undefined;
    const source = dense(descriptor.value, 3, path);
    if (source.length !== 3) fail(`${path} must contain exactly [min, max, feather]`);
    const min = number(source[0], minimum, maximum, `${path}[0]`);
    const max = number(source[1], minimum, maximum, `${path}[1]`);
    const feather = number(source[2], 0, maximum - minimum, `${path}[2]`);
    if (max < min) fail(`${path}[1] must be at least ${path}[0]`);
    return Object.freeze([min, max, feather]);
  };
  return Object.freeze({
    overlayWeight: number(d.overlayWeight.value, 0, BIOME_RUNTIME_PACK_LIMITS.weight, `${label}.overlayWeight`),
    ...(d.slope01 === undefined ? {} : { slope01: band(d.slope01, 0, 1, `${label}.slope01`) }),
    ...(d.elevationM === undefined ? {} : { elevationM: band(d.elevationM, -BIOME_RUNTIME_PACK_LIMITS.elevationM,
      BIOME_RUNTIME_PACK_LIMITS.elevationM, `${label}.elevationM`) }),
    ...(d.waterDistanceM === undefined ? {} : { waterDistanceM: band(d.waterDistanceM, 0,
      BIOME_RUNTIME_PACK_LIMITS.waterDistanceM, `${label}.waterDistanceM`) }),
  });
}

function assertStrictRoleOrder(rules, label) {
  for (let index = 1; index < rules.length; index++) {
    if (rules[index - 1].role >= rules[index].role) fail(`${label} must be strictly role-sorted and unique`);
  }
}

function parseSurfaceRules(value, definition, label) {
  const declared = new Set(definition.surfaceMaterials.map((entry) => entry.role));
  const rules = dense(value, BIOME_RUNTIME_PACK_LIMITS.surfaceRules, label).map((entry, index) => {
    const path = `${label}[${index}]`;
    const d = record(entry, new Set(["role", "weight", "tileScaleM"]), new Set(["calibration", "environment"]), path);
    const role = string(d.role.value, REF, BIOME_RUNTIME_PACK_LIMITS.idChars, `${path}.role`);
    if (!declared.has(role)) fail(`${path}.role '${role}' is not declared by biome '${definition.id}'`);
    return Object.freeze({
      role,
      weight: number(d.weight.value, 0, BIOME_RUNTIME_PACK_LIMITS.weight, `${path}.weight`, true),
      tileScaleM: number(d.tileScaleM.value, 0, BIOME_RUNTIME_PACK_LIMITS.tileScaleM, `${path}.tileScaleM`, true),
      ...(d.calibration === undefined ? {} : { calibration: surfaceCalibration(d.calibration.value, `${path}.calibration`) }),
      ...(d.environment === undefined ? {} : { environment: surfaceEnvironment(d.environment.value, `${path}.environment`) }),
    });
  });
  if (rules.length < 1) fail(`${label} must not be empty`);
  assertStrictRoleOrder(rules, label);
  if (rules.length !== declared.size) fail(`${label} must cover every surface role declared by biome '${definition.id}'`);
  return Object.freeze(rules);
}

function parseVegetationRules(value, definition, label) {
  const declared = new Set(definition.vegetationPalette.map((entry) => entry.role));
  const required = new Set(["role", "weight", "radiusM", "density01", "scale", "tintSrgb"]);
  const optional = new Set(["slope01", "elevationM", "moisture01", "waterDistanceM"]);
  const rules = dense(value, BIOME_RUNTIME_PACK_LIMITS.vegetationRules, label).map((entry, index) => {
    const path = `${label}[${index}]`;
    const d = record(entry, required, optional, path);
    const role = string(d.role.value, REF, BIOME_RUNTIME_PACK_LIMITS.idChars, `${path}.role`);
    if (!declared.has(role)) fail(`${path}.role '${role}' is not declared by biome '${definition.id}'`);
    const tint = dense(d.tintSrgb.value, 3, `${path}.tintSrgb`);
    if (tint.length !== 3) fail(`${path}.tintSrgb must contain exactly 3 channels`);
    const parsed = {
      role,
      weight: number(d.weight.value, 0, BIOME_RUNTIME_PACK_LIMITS.weight, `${path}.weight`, true),
      radiusM: number(d.radiusM.value, 0, BIOME_RUNTIME_PACK_LIMITS.radiusM, `${path}.radiusM`, true),
      density01: number(d.density01.value, 0, 1, `${path}.density01`),
      scale: tupleBand(d.scale.value, Number.MIN_VALUE, BIOME_RUNTIME_PACK_LIMITS.scale, `${path}.scale`, true),
      ...(d.slope01 === undefined ? {} : { slope01: tupleBand(d.slope01.value, 0, 1, `${path}.slope01`) }),
      ...(d.elevationM === undefined ? {} : { elevationM: tupleBand(d.elevationM.value, -BIOME_RUNTIME_PACK_LIMITS.elevationM, BIOME_RUNTIME_PACK_LIMITS.elevationM, `${path}.elevationM`) }),
      ...(d.moisture01 === undefined ? {} : { moisture01: tupleBand(d.moisture01.value, 0, 1, `${path}.moisture01`) }),
      ...(d.waterDistanceM === undefined ? {} : { waterDistanceM: tupleBand(d.waterDistanceM.value, 0, BIOME_RUNTIME_PACK_LIMITS.waterDistanceM, `${path}.waterDistanceM`) }),
      tintSrgb: Object.freeze(tint.map((channel, channelIndex) => integer(channel, 0, 255, `${path}.tintSrgb[${channelIndex}]`))),
    };
    return Object.freeze(parsed);
  });
  assertStrictRoleOrder(rules, label);
  if (rules.length !== declared.size) fail(`${label} must cover every vegetation role declared by biome '${definition.id}'`);
  return Object.freeze(rules);
}

function parseBindings(value, declaredKeys, label) {
  const bindings = dense(value, BIOME_RUNTIME_PACK_LIMITS.bindingsPerBiome, label).map((entry, index) => {
    const path = `${label}[${index}]`;
    const d = record(entry, new Set(["kind", "role", "assetId", "contentHash", "licenseId", "sourceUri"]), new Set(), path);
    if (!BIOME_RUNTIME_BINDING_KINDS.includes(d.kind.value)) fail(`${path}.kind is unsupported`);
    const role = string(d.role.value, REF, BIOME_RUNTIME_PACK_LIMITS.idChars, `${path}.role`);
    const key = `${d.kind.value}:${role}`;
    if (!declaredKeys.has(key)) fail(`${path} targets undeclared runtime rule '${key}'`);
    return Object.freeze({
      kind: d.kind.value,
      role,
      assetId: string(d.assetId.value, REF, BIOME_RUNTIME_PACK_LIMITS.idChars, `${path}.assetId`),
      contentHash: string(d.contentHash.value, HASH, 71, `${path}.contentHash`),
      licenseId: text(d.licenseId.value, BIOME_RUNTIME_PACK_LIMITS.labelChars, `${path}.licenseId`),
      sourceUri: text(d.sourceUri.value, BIOME_RUNTIME_PACK_LIMITS.uriChars, `${path}.sourceUri`),
    });
  });
  for (let index = 1; index < bindings.length; index++) {
    const previous = `${bindings[index - 1].kind}:${bindings[index - 1].role}`;
    const current = `${bindings[index].kind}:${bindings[index].role}`;
    if (previous >= current) fail(`${label} must be strictly kind/role-sorted and unique`);
  }
  return Object.freeze(bindings);
}

function fulfillmentStatus(bound, required) {
  if (bound === 0) return "metadata-only";
  return bound === required ? "fulfilled" : "partial";
}

function parseBiomeEntry(value, definition, label) {
  const d = record(value, new Set(["biomeId", "status", "surfaceRules", "vegetationRules", "bindings"]), new Set(), label);
  const biomeId = string(d.biomeId.value, ID, 64, `${label}.biomeId`);
  if (biomeId !== definition.id) fail(`${label}.biomeId does not match its metadata definition`);
  const surfaceRules = parseSurfaceRules(d.surfaceRules.value, definition, `${label}.surfaceRules`);
  const vegetationRules = parseVegetationRules(d.vegetationRules.value, definition, `${label}.vegetationRules`);
  const declaredKeys = new Set([
    ...surfaceRules.map((entry) => `surface:${entry.role}`),
    ...vegetationRules.map((entry) => `vegetation:${entry.role}`),
  ]);
  const bindings = parseBindings(d.bindings.value, declaredKeys, `${label}.bindings`);
  const status = fulfillmentStatus(bindings.length, declaredKeys.size);
  if (!BIOME_RUNTIME_FULFILLMENT_STATES.includes(d.status.value)) fail(`${label}.status is unsupported`);
  if (d.status.value !== status) fail(`${label}.status must be '${status}' for its declared bindings`);
  return Object.freeze({ biomeId, status, surfaceRules, vegetationRules, bindings });
}

/**
 * Parse a runtime pack against the exact metadata authority it extends. The metadata hash is part
 * of canonical pack identity, so roles cannot drift underneath an otherwise valid runtime pack.
 */
export function parseBiomeRuntimePack(value, metadataPackValue) {
  const metadataPack = parseBiomePack(metadataPackValue);
  const metadataPackHash = biomePackContentHash(metadataPack);
  const d = record(value, new Set(["schema", "id", "version", "metadataPackContentHash", "status", "biomes"]), new Set(), "biome runtime pack");
  if (d.schema.value !== BIOME_RUNTIME_PACK_SCHEMA) fail(`biome runtime pack.schema must be '${BIOME_RUNTIME_PACK_SCHEMA}'`);
  if (d.metadataPackContentHash.value !== metadataPackHash) fail("biome runtime pack.metadataPackContentHash does not match the provided metadata pack");
  const definitions = new Map(metadataPack.definitions.map((definition) => [definition.id, definition]));
  const source = dense(d.biomes.value, BIOME_RUNTIME_PACK_LIMITS.biomes, "biome runtime pack.biomes");
  if (source.length < 1) fail("biome runtime pack.biomes must not be empty");
  const biomes = Object.freeze(source.map((entry, index) => {
    const entryRecord = record(entry, new Set(["biomeId", "status", "surfaceRules", "vegetationRules", "bindings"]), new Set(), `biome runtime pack.biomes[${index}]`);
    const biomeId = string(entryRecord.biomeId.value, ID, 64, `biome runtime pack.biomes[${index}].biomeId`);
    const definition = definitions.get(biomeId);
    if (definition === undefined) fail(`biome runtime pack references unknown biome '${biomeId}'`);
    return parseBiomeEntry(entry, definition, `biome runtime pack.biomes[${index}]`);
  }));
  for (let index = 1; index < biomes.length; index++) {
    if (biomes[index - 1].biomeId >= biomes[index].biomeId) fail("biome runtime pack.biomes must be strictly biomeId-sorted and unique");
  }
  const required = biomes.reduce((sum, biome) => sum + biome.surfaceRules.length + biome.vegetationRules.length, 0);
  const bound = biomes.reduce((sum, biome) => sum + biome.bindings.length, 0);
  const status = fulfillmentStatus(bound, required);
  if (!BIOME_RUNTIME_FULFILLMENT_STATES.includes(d.status.value)) fail("biome runtime pack.status is unsupported");
  if (d.status.value !== status) fail(`biome runtime pack.status must be '${status}' for its declared bindings`);
  return Object.freeze({
    schema: BIOME_RUNTIME_PACK_SCHEMA,
    id: string(d.id.value, ID, 64, "biome runtime pack.id"),
    version: string(d.version.value, SEMVER, 64, "biome runtime pack.version"),
    metadataPackContentHash: metadataPackHash,
    status,
    biomes,
  });
}

export function stableStringifyBiomeRuntimePack(value, metadataPack) {
  return JSON.stringify(parseBiomeRuntimePack(value, metadataPack));
}

export function biomeRuntimePackContentHash(value, metadataPack) {
  return `sha256:${sha256(stableStringifyBiomeRuntimePack(value, metadataPack))}`;
}
