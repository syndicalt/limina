// WB-B2 biome metadata contract. Definitions are deterministic authoring/content metadata;
// symbolic roles do not become renderable until provenance-bearing bindings fulfill them.

import { sha256 } from "./sha256.mjs";

export const BIOME_DEF_SCHEMA = "limina.biome-def/v1";
export const BIOME_PACK_SCHEMA = "limina.biome-pack/v1";
export const BIOME_CATEGORIES = Object.freeze(["terrestrial", "aquatic", "wetland", "geological", "fantasy", "sci-fi"]);
export const BIOME_BINDING_KINDS = Object.freeze(["surface-material", "vegetation", "resource-table", "spawn-table", "ambient-audio"]);
export const BIOME_FULFILLMENT_STATES = Object.freeze(["metadata-only", "partial", "fulfilled"]);
export const LEGACY_BIOME_KINDS = Object.freeze(["grass", "forest", "mountain", "desert", "tundra", "swamp", "water", "blight"]);
export const BIOME_LIMITS = Object.freeze({
  definitions: 64, tags: 16, surfaceMaterials: 16, vegetationRoles: 32,
  tableRefs: 32, ambientAudioRefs: 16, bindings: 128, legacyAliases: 8,
  idChars: 64, labelChars: 96, refChars: 160, uriChars: 512,
});

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const REF = /^[a-z][a-z0-9._/-]*$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

export class BiomeIrValidationError extends Error {
  constructor(message) { super(message); this.name = "BiomeIrValidationError"; }
}
function fail(message) { throw new BiomeIrValidationError(message); }

function record(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!keys.has(key)) fail(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor) || descriptor.enumerable !== true) fail(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${label} is missing '${key}'`);
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
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} is invalid`);
  return value;
}
function number(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < minimum || value > maximum) fail(`${label} must be a canonical number in [${minimum}, ${maximum}]`);
  return value;
}
function integer(value, minimum, maximum, label) {
  const parsed = number(value, minimum, maximum, label);
  if (!Number.isSafeInteger(parsed)) fail(`${label} must be an integer`);
  return parsed;
}

function sortedUniqueStrings(value, maximum, label) {
  const source = dense(value, maximum, label);
  const result = source.map((entry, index) => string(entry, REF, BIOME_LIMITS.refChars, `${label}[${index}]`));
  for (let index = 1; index < result.length; index++) if (result[index - 1] >= result[index]) fail(`${label} must be strictly sorted and unique`);
  return Object.freeze(result);
}

function provenance(value, label) {
  const d = record(value, new Set(["sourceUri", "licenseId", "authoredBy"]), label);
  return Object.freeze({
    sourceUri: text(d.sourceUri.value, BIOME_LIMITS.uriChars, `${label}.sourceUri`),
    licenseId: text(d.licenseId.value, BIOME_LIMITS.labelChars, `${label}.licenseId`),
    authoredBy: text(d.authoredBy.value, BIOME_LIMITS.labelChars, `${label}.authoredBy`),
  });
}

function band(value, minimum, maximum, label) {
  const d = record(value, new Set(["min", "max"]), label);
  const min = number(d.min.value, minimum, maximum, `${label}.min`);
  const max = number(d.max.value, minimum, maximum, `${label}.max`);
  if (max < min) fail(`${label}.max must be at least min`);
  return Object.freeze({ min, max });
}

function parseDefinition(value, label) {
  const d = record(value, new Set([
    "schema", "id", "version", "displayName", "taxonomy", "climate", "surfaceMaterials",
    "vegetationPalette", "resourceTableRefs", "spawnTableRefs", "waterTintSrgb",
    "ambientAudioRefs", "fulfillment", "provenance",
  ]), label);
  if (d.schema.value !== BIOME_DEF_SCHEMA) fail(`${label}.schema must be '${BIOME_DEF_SCHEMA}'`);
  const id = string(d.id.value, ID, BIOME_LIMITS.idChars, `${label}.id`);
  const version = string(d.version.value, SEMVER, 64, `${label}.version`);
  const taxonomyInput = record(d.taxonomy.value, new Set(["category", "tags"]), `${label}.taxonomy`);
  if (!BIOME_CATEGORIES.includes(taxonomyInput.category.value)) fail(`${label}.taxonomy.category is unsupported`);
  const tags = sortedUniqueStrings(taxonomyInput.tags.value, BIOME_LIMITS.tags, `${label}.taxonomy.tags`);
  const climateInput = record(d.climate.value, new Set(["temperatureC", "moisture01"]), `${label}.climate`);
  const climate = Object.freeze({
    temperatureC: band(climateInput.temperatureC.value, -100, 100, `${label}.climate.temperatureC`),
    moisture01: band(climateInput.moisture01.value, 0, 1, `${label}.climate.moisture01`),
  });
  const surfaceInput = dense(d.surfaceMaterials.value, BIOME_LIMITS.surfaceMaterials, `${label}.surfaceMaterials`);
  if (surfaceInput.length < 1) fail(`${label}.surfaceMaterials must not be empty`);
  const surfaceSeen = new Set();
  const surfaceMaterials = Object.freeze(surfaceInput.map((entry, index) => {
    const e = record(entry, new Set(["role"]), `${label}.surfaceMaterials[${index}]`);
    const role = string(e.role.value, REF, BIOME_LIMITS.refChars, `${label}.surfaceMaterials[${index}].role`);
    if (surfaceSeen.has(role)) fail(`${label}.surfaceMaterials duplicates role '${role}'`);
    surfaceSeen.add(role);
    return Object.freeze({ role });
  }));
  const vegetationInput = dense(d.vegetationPalette.value, BIOME_LIMITS.vegetationRoles, `${label}.vegetationPalette`);
  const vegetationPalette = Object.freeze(vegetationInput.map((entry, index) => {
    const e = record(entry, new Set(["role", "weight"]), `${label}.vegetationPalette[${index}]`);
    return Object.freeze({
      role: string(e.role.value, REF, BIOME_LIMITS.refChars, `${label}.vegetationPalette[${index}].role`),
      weight: number(e.weight.value, Number.MIN_VALUE, 1_000_000, `${label}.vegetationPalette[${index}].weight`),
    });
  }));
  for (let index = 1; index < vegetationPalette.length; index++) if (vegetationPalette[index - 1].role >= vegetationPalette[index].role) fail(`${label}.vegetationPalette must be strictly role-sorted and unique`);
  const resourceTableRefs = sortedUniqueStrings(d.resourceTableRefs.value, BIOME_LIMITS.tableRefs, `${label}.resourceTableRefs`);
  const spawnTableRefs = sortedUniqueStrings(d.spawnTableRefs.value, BIOME_LIMITS.tableRefs, `${label}.spawnTableRefs`);
  const ambientAudioRefs = sortedUniqueStrings(d.ambientAudioRefs.value, BIOME_LIMITS.ambientAudioRefs, `${label}.ambientAudioRefs`);
  const tintInput = dense(d.waterTintSrgb.value, 3, `${label}.waterTintSrgb`);
  if (tintInput.length !== 3) fail(`${label}.waterTintSrgb must contain exactly 3 channels`);
  const waterTintSrgb = Object.freeze(tintInput.map((entry, index) => integer(entry, 0, 255, `${label}.waterTintSrgb[${index}]`)));

  const fulfillmentInput = record(d.fulfillment.value, new Set(["status", "bindings"]), `${label}.fulfillment`);
  if (!BIOME_FULFILLMENT_STATES.includes(fulfillmentInput.status.value)) fail(`${label}.fulfillment.status is unsupported`);
  const declared = new Set([
    ...surfaceMaterials.map((entry) => `surface-material:${entry.role}`),
    ...vegetationPalette.map((entry) => `vegetation:${entry.role}`),
    ...resourceTableRefs.map((ref) => `resource-table:${ref}`),
    ...spawnTableRefs.map((ref) => `spawn-table:${ref}`),
    ...ambientAudioRefs.map((ref) => `ambient-audio:${ref}`),
  ]);
  const bindingsInput = dense(fulfillmentInput.bindings.value, BIOME_LIMITS.bindings, `${label}.fulfillment.bindings`);
  const bindingKeys = new Set();
  const bindings = Object.freeze(bindingsInput.map((entry, index) => {
    const e = record(entry, new Set(["kind", "ref", "assetId", "contentHash", "licenseId", "sourceUri"]), `${label}.fulfillment.bindings[${index}]`);
    if (!BIOME_BINDING_KINDS.includes(e.kind.value)) fail(`${label}.fulfillment.bindings[${index}].kind is unsupported`);
    const ref = string(e.ref.value, REF, BIOME_LIMITS.refChars, `${label}.fulfillment.bindings[${index}].ref`);
    const key = `${e.kind.value}:${ref}`;
    if (!declared.has(key)) fail(`${label}.fulfillment binding '${key}' is not declared by the definition`);
    if (bindingKeys.has(key)) fail(`${label}.fulfillment duplicates binding '${key}'`);
    bindingKeys.add(key);
    return Object.freeze({
      kind: e.kind.value,
      ref,
      assetId: string(e.assetId.value, REF, BIOME_LIMITS.refChars, `${label}.fulfillment.bindings[${index}].assetId`),
      contentHash: string(e.contentHash.value, HASH, 71, `${label}.fulfillment.bindings[${index}].contentHash`),
      licenseId: text(e.licenseId.value, BIOME_LIMITS.labelChars, `${label}.fulfillment.bindings[${index}].licenseId`),
      sourceUri: text(e.sourceUri.value, BIOME_LIMITS.uriChars, `${label}.fulfillment.bindings[${index}].sourceUri`),
    });
  }));
  for (let index = 1; index < bindings.length; index++) {
    const prior = `${bindings[index - 1].kind}:${bindings[index - 1].ref}`, current = `${bindings[index].kind}:${bindings[index].ref}`;
    if (prior >= current) fail(`${label}.fulfillment.bindings must be strictly kind/ref-sorted`);
  }
  const expectedStatus = bindings.length === 0 ? "metadata-only" : bindings.length === declared.size ? "fulfilled" : "partial";
  if (fulfillmentInput.status.value !== expectedStatus) fail(`${label}.fulfillment.status must be '${expectedStatus}' for its declared bindings`);
  return Object.freeze({
    schema: BIOME_DEF_SCHEMA, id, version,
    displayName: text(d.displayName.value, BIOME_LIMITS.labelChars, `${label}.displayName`),
    taxonomy: Object.freeze({ category: taxonomyInput.category.value, tags }), climate, surfaceMaterials,
    vegetationPalette, resourceTableRefs, spawnTableRefs, waterTintSrgb, ambientAudioRefs,
    fulfillment: Object.freeze({ status: expectedStatus, bindings }),
    provenance: provenance(d.provenance.value, `${label}.provenance`),
  });
}

export function parseBiomeDef(value) { return parseDefinition(value, "biome definition"); }
export function stableStringifyBiomeDef(value) { return JSON.stringify(parseBiomeDef(value)); }
export function biomeDefContentHash(value) { return `sha256:${sha256(stableStringifyBiomeDef(value))}`; }

export function parseBiomePack(value) {
  const d = record(value, new Set(["schema", "id", "version", "definitions", "legacyAliases", "provenance"]), "biome pack");
  if (d.schema.value !== BIOME_PACK_SCHEMA) fail(`biome pack.schema must be '${BIOME_PACK_SCHEMA}'`);
  const definitionsInput = dense(d.definitions.value, BIOME_LIMITS.definitions, "biome pack.definitions");
  if (definitionsInput.length < 1) fail("biome pack.definitions must not be empty");
  const definitions = Object.freeze(definitionsInput.map((entry, index) => parseDefinition(entry, `biome pack.definitions[${index}]`)));
  for (let index = 1; index < definitions.length; index++) if (definitions[index - 1].id >= definitions[index].id) fail("biome pack.definitions must be strictly id-sorted and unique");
  const ids = new Set(definitions.map((definition) => definition.id));
  const aliasesInput = dense(d.legacyAliases.value, BIOME_LIMITS.legacyAliases, "biome pack.legacyAliases");
  const legacyAliases = Object.freeze(aliasesInput.map((entry, index) => {
    const e = record(entry, new Set(["legacyKind", "biomeId"]), `biome pack.legacyAliases[${index}]`);
    if (!LEGACY_BIOME_KINDS.includes(e.legacyKind.value)) fail(`biome pack.legacyAliases[${index}].legacyKind is unsupported`);
    const biomeId = string(e.biomeId.value, ID, BIOME_LIMITS.idChars, `biome pack.legacyAliases[${index}].biomeId`);
    if (!ids.has(biomeId)) fail(`biome pack legacy alias targets unknown biome '${biomeId}'`);
    return Object.freeze({ legacyKind: e.legacyKind.value, biomeId });
  }));
  for (let index = 1; index < legacyAliases.length; index++) if (legacyAliases[index - 1].legacyKind >= legacyAliases[index].legacyKind) fail("biome pack.legacyAliases must be strictly legacyKind-sorted and unique");
  return Object.freeze({
    schema: BIOME_PACK_SCHEMA,
    id: string(d.id.value, ID, BIOME_LIMITS.idChars, "biome pack.id"),
    version: string(d.version.value, SEMVER, 64, "biome pack.version"),
    definitions, legacyAliases,
    provenance: provenance(d.provenance.value, "biome pack.provenance"),
  });
}

export function stableStringifyBiomePack(value) { return JSON.stringify(parseBiomePack(value)); }
export function biomePackContentHash(value) { return `sha256:${sha256(stableStringifyBiomePack(value))}`; }

export function inspectBiomeFulfillment(value) {
  const definition = parseBiomeDef(value);
  const bound = new Set(definition.fulfillment.bindings.map((entry) => `${entry.kind}:${entry.ref}`));
  const required = [
    ...definition.surfaceMaterials.map((entry) => ["surface-material", entry.role]),
    ...definition.vegetationPalette.map((entry) => ["vegetation", entry.role]),
    ...definition.resourceTableRefs.map((ref) => ["resource-table", ref]),
    ...definition.spawnTableRefs.map((ref) => ["spawn-table", ref]),
    ...definition.ambientAudioRefs.map((ref) => ["ambient-audio", ref]),
  ];
  const missing = Object.freeze(required.filter(([kind, ref]) => !bound.has(`${kind}:${ref}`)).map(([kind, ref]) => Object.freeze({ kind, ref })));
  return Object.freeze({ status: definition.fulfillment.status, required: required.length, bound: bound.size, missing });
}
