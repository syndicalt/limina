// B3 content contract for one vegetation role's production backend. This module is deliberately
// pure data: it imports only the portable SHA-256 implementation and cannot create renderer,
// GLTF, texture, or runtime objects.

import { sha256 } from "./sha256.mjs";

export const BIOME_POPULATION_ASSET_SCHEMA = "limina.biome-population-asset/v1";
export const BIOME_POPULATION_ASSET_BACKENDS = Object.freeze([
  "continuous-grass-field", "grass-field", "tree-population", "instanced-asset",
]);
export const BIOME_POPULATION_CLIMATES = Object.freeze(["summer", "autumn", "winter", "dry"]);
export const BIOME_POPULATION_TREE_CAPS = Object.freeze({
  species: 12,
  active: 24_576,
  activeAndPending: 30_720,
  hysteresisMaximum: 0.49,
});
export const BIOME_POPULATION_ASSET_LIMITS = Object.freeze({
  idChars: 64,
  refChars: 160,
  versionChars: 64,
  labelChars: 96,
  uriChars: 512,
  densityScale: 100,
  bladeScale: 100,
  distance: 1_000_000,
});

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const REF = /^[a-z][a-z0-9._/-]*$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

export class BiomePopulationAssetValidationError extends Error {
  constructor(message) { super(message); this.name = "BiomePopulationAssetValidationError"; }
}

function fail(message) { throw new BiomePopulationAssetValidationError(message); }

function record(value, required, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!required.has(key)) fail(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      fail(`${label}.${key} must be an enumerable data field`);
    }
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label} is missing '${key}'`);
  return descriptors;
}

function denseTuple(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 2
      || Object.getOwnPropertySymbols(value).length !== 0
      || Object.getOwnPropertyNames(value).length !== 3) {
    fail(`${label} must be a dense, field-free [min, max] array`);
  }
  return value;
}

function string(value, pattern, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) {
    fail(`${label} is invalid`);
  }
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

function provenance(value, label) {
  const d = record(value, new Set(["licenseId", "sourceUri"]), label);
  return Object.freeze({
    licenseId: text(d.licenseId.value, BIOME_POPULATION_ASSET_LIMITS.labelChars, `${label}.licenseId`),
    sourceUri: text(d.sourceUri.value, BIOME_POPULATION_ASSET_LIMITS.uriChars, `${label}.sourceUri`),
  });
}

function common(d) {
  return {
    schema: BIOME_POPULATION_ASSET_SCHEMA,
    id: string(d.id.value, ID, BIOME_POPULATION_ASSET_LIMITS.idChars, "biome population asset.id"),
    version: string(d.version.value, SEMVER, BIOME_POPULATION_ASSET_LIMITS.versionChars, "biome population asset.version"),
    role: string(d.role.value, REF, BIOME_POPULATION_ASSET_LIMITS.refChars, "biome population asset.role"),
    backend: d.backend.value,
  };
}

function parseGrassField(value) {
  const d = record(value, new Set([
    "schema", "id", "version", "role", "backend", "visualPackageId", "visualPackageVersion",
    "densityScale", "bladeScale", "climate", "provenance",
  ]), "biome population asset");
  const band = denseTuple(d.bladeScale.value, "biome population asset.bladeScale");
  const minimum = number(band[0], Number.MIN_VALUE, BIOME_POPULATION_ASSET_LIMITS.bladeScale,
    "biome population asset.bladeScale[0]", true);
  const maximum = number(band[1], Number.MIN_VALUE, BIOME_POPULATION_ASSET_LIMITS.bladeScale,
    "biome population asset.bladeScale[1]", true);
  if (minimum > maximum) fail("biome population asset.bladeScale must be sorted [min, max]");
  if (!BIOME_POPULATION_CLIMATES.includes(d.climate.value)) fail("biome population asset.climate is unsupported");
  return Object.freeze({
    ...common(d),
    visualPackageId: string(d.visualPackageId.value, REF, BIOME_POPULATION_ASSET_LIMITS.refChars,
      "biome population asset.visualPackageId"),
    visualPackageVersion: string(d.visualPackageVersion.value, SEMVER, BIOME_POPULATION_ASSET_LIMITS.versionChars,
      "biome population asset.visualPackageVersion"),
    densityScale: number(d.densityScale.value, Number.MIN_VALUE, BIOME_POPULATION_ASSET_LIMITS.densityScale,
      "biome population asset.densityScale", true),
    bladeScale: Object.freeze([minimum, maximum]),
    climate: d.climate.value,
    provenance: provenance(d.provenance.value, "biome population asset.provenance"),
  });
}

function parseTreePopulation(value) {
  const d = record(value, new Set([
    "schema", "id", "version", "role", "backend",
    "sourceAssetId", "sourceContentHash", "reducedAssetId", "reducedContentHash",
    "impostorAssetId", "impostorContentHash", "reducedDistance", "impostorDistance",
    "cullDistance", "hysteresis", "provenance",
  ]), "biome population asset");
  const reducedDistance = number(d.reducedDistance.value, Number.MIN_VALUE, BIOME_POPULATION_ASSET_LIMITS.distance,
    "biome population asset.reducedDistance", true);
  const impostorDistance = number(d.impostorDistance.value, Number.MIN_VALUE, BIOME_POPULATION_ASSET_LIMITS.distance,
    "biome population asset.impostorDistance", true);
  const cullDistance = number(d.cullDistance.value, Number.MIN_VALUE, BIOME_POPULATION_ASSET_LIMITS.distance,
    "biome population asset.cullDistance", true);
  if (!(reducedDistance < impostorDistance && impostorDistance < cullDistance)) {
    fail("biome population asset tree distances must be strictly increasing");
  }
  const sourceAssetId = string(d.sourceAssetId.value, REF, BIOME_POPULATION_ASSET_LIMITS.refChars,
    "biome population asset.sourceAssetId");
  const reducedAssetId = string(d.reducedAssetId.value, REF, BIOME_POPULATION_ASSET_LIMITS.refChars,
    "biome population asset.reducedAssetId");
  const impostorAssetId = string(d.impostorAssetId.value, REF, BIOME_POPULATION_ASSET_LIMITS.refChars,
    "biome population asset.impostorAssetId");
  if (new Set([sourceAssetId, reducedAssetId, impostorAssetId]).size !== 3) {
    fail("biome population asset tree asset IDs must be distinct");
  }
  return Object.freeze({
    ...common(d), sourceAssetId,
    sourceContentHash: string(d.sourceContentHash.value, HASH, 71, "biome population asset.sourceContentHash"),
    reducedAssetId,
    reducedContentHash: string(d.reducedContentHash.value, HASH, 71, "biome population asset.reducedContentHash"),
    impostorAssetId,
    impostorContentHash: string(d.impostorContentHash.value, HASH, 71, "biome population asset.impostorContentHash"),
    reducedDistance, impostorDistance, cullDistance,
    hysteresis: number(d.hysteresis.value, 0, BIOME_POPULATION_TREE_CAPS.hysteresisMaximum,
      "biome population asset.hysteresis"),
    provenance: provenance(d.provenance.value, "biome population asset.provenance"),
  });
}

function parseInstancedAsset(value) {
  const d = record(value, new Set([
    "schema", "id", "version", "role", "backend", "assetId", "contentHash", "provenance",
  ]), "biome population asset");
  return Object.freeze({
    ...common(d),
    assetId: string(d.assetId.value, REF, BIOME_POPULATION_ASSET_LIMITS.refChars, "biome population asset.assetId"),
    contentHash: string(d.contentHash.value, HASH, 71, "biome population asset.contentHash"),
    provenance: provenance(d.provenance.value, "biome population asset.provenance"),
  });
}

export function parseBiomePopulationAsset(value) {
  // Read the discriminators through descriptors so accessors are never executed during validation.
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("biome population asset must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const schema = descriptors.schema;
  const backend = descriptors.backend;
  if (schema === undefined || !("value" in schema) || schema.value !== BIOME_POPULATION_ASSET_SCHEMA) {
    fail(`biome population asset.schema must be '${BIOME_POPULATION_ASSET_SCHEMA}'`);
  }
  if (backend === undefined || !("value" in backend) || !BIOME_POPULATION_ASSET_BACKENDS.includes(backend.value)) {
    fail("biome population asset.backend is unsupported");
  }
  if (backend.value === "grass-field" || backend.value === "continuous-grass-field") return parseGrassField(value);
  if (backend.value === "tree-population") return parseTreePopulation(value);
  return parseInstancedAsset(value);
}

export function stableStringifyBiomePopulationAsset(value) {
  return JSON.stringify(parseBiomePopulationAsset(value));
}

export function biomePopulationAssetContentHash(value) {
  return `sha256:${sha256(stableStringifyBiomePopulationAsset(value))}`;
}
