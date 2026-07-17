// FB-5 publication contract for functional buildings and explicitly inert props. This module is
// deliberately pure: parsing and verification do not read assets, mutate a registry, or construct
// runtime objects. A caller must supply the exact bytes (and, for an engine-addressed asset, the
// content address returned by that engine boundary).

import { FUNCTIONAL_BUILDING_CONTRACT_V2, parseFunctionalBuildingContract } from "./functional-building-contract.ts";
import { parseFunctionalBuildingStaticBatch } from "../skills/functional-building-lod.ts";
import { canonicalCompilerJson } from "../world/compiler/canonical.mjs";
import { sha256 } from "../world/sha256.mjs";

export const FUNCTIONAL_BUILDING_CATALOG_SCHEMA = "limina.functional-building-catalog/v1";
export const FUNCTIONAL_BUILDING_LOD_PROOF_SCHEMA = "limina.functional-building-lod-semantic-proof/v1";
export const INERT_PROP_DECLARATION_SCHEMA = "limina.inert-prop-declaration/v1";
export const FUNCTIONAL_BUILDING_CATALOG_LIMITS = Object.freeze({
  entries: 512, idChars: 160, pathChars: 512, byteLength: 2 ** 32 - 1,
  rooms: 32, portals: 64, doors: 64, spawns: 256, cells: 32, lodLevels: 8,
});

const ID = /^[a-z0-9][a-z0-9._/-]{0,159}$/;
const PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9][a-zA-Z0-9._/-]{0,511}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

export class FunctionalBuildingCatalogValidationError extends Error {
  constructor(message) { super(message); this.name = "FunctionalBuildingCatalogValidationError"; }
}
function fail(message) { throw new FunctionalBuildingCatalogValidationError(message); }

function record(value, required, optional, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${label} must not contain symbol fields`);
  const allowed = new Set([...required, ...optional]), descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key)) fail(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor) || descriptor.enumerable !== true) fail(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label} is missing '${key}'`);
  return descriptors;
}
function string(value, pattern, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}
function id(value, label) {
  const output = string(value, ID, FUNCTIONAL_BUILDING_CATALOG_LIMITS.idChars, label);
  if (output.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) fail(`${label} contains an unsafe path segment`);
  return output;
}
function hash(value, label) { return string(value, HASH, 71, label); }
function denseArray(value, minimum, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > maximum
      || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    fail(`${label} must be a dense, field-free array with ${minimum}..${maximum} entries`);
  }
  return value;
}
function boolean(value, expected, label) { if (value !== expected) fail(`${label} must be ${expected}`); return value; }
function uint(value, maximum, label, positive = false) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > maximum) fail(`${label} is outside its bounded integer range`);
  return value;
}
function sortedUniqueIds(value, maximum, label) {
  const source = denseArray(value, 1, maximum, label), output = source.map((entry, index) => id(entry, `${label}[${index}]`));
  for (let index = 1; index < output.length; index++) if (output[index - 1] >= output[index]) fail(`${label} must be strictly id-sorted and unique`);
  return Object.freeze(output);
}
function frozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozen));
  if (value !== null && typeof value === "object") {
    const output = {}; for (const [key, entry] of Object.entries(value)) output[key] = frozen(entry);
    return Object.freeze(output);
  }
  return value;
}
function jsonDomain(value) {
  if (Array.isArray(value)) return value.map(jsonDomain);
  if (value !== null && typeof value === "object") {
    const output = {};
    for (const [key, entry] of Object.entries(value)) if (entry !== undefined) output[key] = jsonDomain(entry);
    return output;
  }
  return value;
}
function canonicalHash(value, label) {
  try { return `sha256:${sha256(canonicalCompilerJson(jsonDomain(value), { maxBytes: 1024 * 1024, maxDepth: 32, maxNodes: 100_000, maxProperties: 64, maxArrayLength: 2048 }))}`; }
  catch (error) { fail(`${label} is not canonically hashable: ${error instanceof Error ? error.message : String(error)}`); }
}

function assetBinding(value, label) {
  const d = record(value, new Set(["assetId", "hashKind", "hash", "byteLength"]), new Set(), label);
  if (d.hashKind.value !== "raw-sha256" && d.hashKind.value !== "engine-content-hash") fail(`${label}.hashKind is unsupported`);
  return Object.freeze({
    assetId: id(d.assetId.value, `${label}.assetId`), hashKind: d.hashKind.value,
    hash: hash(d.hash.value, `${label}.hash`),
    byteLength: uint(d.byteLength.value, FUNCTIONAL_BUILDING_CATALOG_LIMITS.byteLength, `${label}.byteLength`, true),
  });
}
function variant(value, label) {
  const d = record(value, new Set(["familyId", "variantId"]), new Set(), label);
  return Object.freeze({ familyId: id(d.familyId.value, `${label}.familyId`), variantId: id(d.variantId.value, `${label}.variantId`) });
}
function exactPointer(value, schema, label) {
  const d = record(value, new Set(["schema", "artifactId", "path", "sha256"]), new Set(), label);
  if (d.schema.value !== schema) fail(`${label}.schema must be ${schema}`);
  return Object.freeze({ schema, artifactId: id(d.artifactId.value, `${label}.artifactId`),
    path: string(d.path.value, PATH, FUNCTIONAL_BUILDING_CATALOG_LIMITS.pathChars, `${label}.path`), sha256: hash(d.sha256.value, `${label}.sha256`) });
}
function semanticIdentity(value, label) {
  const d = record(value, new Set(["buildingId", "rooms", "portals", "exteriorPortals", "doors", "spawns", "cells", "fingerprint"]), new Set(), label);
  const portals = sortedUniqueIds(d.portals.value, FUNCTIONAL_BUILDING_CATALOG_LIMITS.portals, `${label}.portals`);
  const exteriorPortals = sortedUniqueIds(d.exteriorPortals.value, FUNCTIONAL_BUILDING_CATALOG_LIMITS.portals, `${label}.exteriorPortals`);
  for (const portalId of exteriorPortals) if (!portals.includes(portalId)) fail(`${label}.exteriorPortals contains non-portal '${portalId}'`);
  return Object.freeze({ buildingId: id(d.buildingId.value, `${label}.buildingId`),
    rooms: sortedUniqueIds(d.rooms.value, FUNCTIONAL_BUILDING_CATALOG_LIMITS.rooms, `${label}.rooms`),
    portals, exteriorPortals,
    doors: sortedUniqueIds(d.doors.value, FUNCTIONAL_BUILDING_CATALOG_LIMITS.doors, `${label}.doors`),
    spawns: sortedUniqueIds(d.spawns.value, FUNCTIONAL_BUILDING_CATALOG_LIMITS.spawns, `${label}.spawns`),
    cells: sortedUniqueIds(d.cells.value, FUNCTIONAL_BUILDING_CATALOG_LIMITS.cells, `${label}.cells`),
    fingerprint: hash(d.fingerprint.value, `${label}.fingerprint`) });
}
function lodProof(value, fingerprint, label) {
  const d = record(value, new Set(["schema", "articulatedDoorPolicy", "articulatedDoorRootIndex", "levels"]), new Set(), label);
  if (d.schema.value !== FUNCTIONAL_BUILDING_LOD_PROOF_SCHEMA) fail(`${label}.schema is unsupported`);
  if (d.articulatedDoorPolicy.value !== "shared-outside-static-lods") fail(`${label}.articulatedDoorPolicy must isolate doors from static LODs`);
  const levels = denseArray(d.levels.value, 2, FUNCTIONAL_BUILDING_CATALOG_LIMITS.lodLevels, `${label}.levels`).map((raw, index) => {
    const level = record(raw, new Set(["level", "rootIndex", "semanticFingerprint"]), new Set(), `${label}.levels[${index}]`);
    if (level.level.value !== index) fail(`${label}.levels must be contiguous from zero`);
    const semanticFingerprint = hash(level.semanticFingerprint.value, `${label}.levels[${index}].semanticFingerprint`);
    if (semanticFingerprint !== fingerprint) fail(`${label}.levels[${index}] does not preserve the catalog semantic fingerprint`);
    return Object.freeze({ level: index, rootIndex: uint(level.rootIndex.value, 2 ** 31 - 1, `${label}.levels[${index}].rootIndex`), semanticFingerprint });
  });
  if (new Set(levels.map((level) => level.rootIndex)).size !== levels.length) fail(`${label}.levels contains duplicate roots`);
  const articulatedDoorRootIndex = uint(d.articulatedDoorRootIndex.value, 2 ** 31 - 1, `${label}.articulatedDoorRootIndex`);
  if (levels.some((level) => level.rootIndex === articulatedDoorRootIndex)) fail(`${label} includes the articulated door root in a static LOD`);
  return Object.freeze({ schema: FUNCTIONAL_BUILDING_LOD_PROOF_SCHEMA, articulatedDoorPolicy: "shared-outside-static-lods", articulatedDoorRootIndex, levels: Object.freeze(levels) });
}

function parseFunctionalEntry(value, label) {
  const d = record(value, new Set(["entryId", "placementClass", "asset", "variant", "functionalContract", "semanticIdentity", "lodSemanticIdentity"]), new Set(["compositionPackage", "productionClosure"]), label);
  if (d.placementClass.value !== "functional-building") fail(`${label}.placementClass must be functional-building`);
  const contract = record(d.functionalContract.value, new Set(["schema", "hash"]), new Set(), `${label}.functionalContract`);
  if (contract.schema.value !== FUNCTIONAL_BUILDING_CONTRACT_V2) fail(`${label}.functionalContract must bind ${FUNCTIONAL_BUILDING_CONTRACT_V2}`);
  const semantic = semanticIdentity(d.semanticIdentity.value, `${label}.semanticIdentity`);
  return Object.freeze({ entryId: id(d.entryId.value, `${label}.entryId`), placementClass: "functional-building",
    asset: assetBinding(d.asset.value, `${label}.asset`), variant: variant(d.variant.value, `${label}.variant`),
    functionalContract: Object.freeze({ schema: FUNCTIONAL_BUILDING_CONTRACT_V2, hash: hash(contract.hash.value, `${label}.functionalContract.hash`) }),
    semanticIdentity: semantic, lodSemanticIdentity: lodProof(d.lodSemanticIdentity.value, semantic.fingerprint, `${label}.lodSemanticIdentity`),
    ...(d.compositionPackage === undefined ? {} : { compositionPackage: exactPointer(d.compositionPackage.value, "limina.exact-composition-package-pointer/v1", `${label}.compositionPackage`) }),
    ...(d.productionClosure === undefined ? {} : { productionClosure: exactPointer(d.productionClosure.value, "limina.exact-production-closure-pointer/v1", `${label}.productionClosure`) }) });
}
function parseInertEntry(value, label) {
  const d = record(value, new Set(["entryId", "placementClass", "asset", "variant", "inert"]), new Set(), label);
  if (d.placementClass.value !== "inert-prop") fail(`${label}.placementClass must be inert-prop`);
  const declaration = record(d.inert.value, new Set(["schema", "interactive", "enterable"]), new Set(), `${label}.inert`);
  if (declaration.schema.value !== INERT_PROP_DECLARATION_SCHEMA) fail(`${label}.inert.schema is unsupported`);
  boolean(declaration.interactive.value, false, `${label}.inert.interactive`); boolean(declaration.enterable.value, false, `${label}.inert.enterable`);
  return Object.freeze({ entryId: id(d.entryId.value, `${label}.entryId`), placementClass: "inert-prop",
    asset: assetBinding(d.asset.value, `${label}.asset`), variant: variant(d.variant.value, `${label}.variant`),
    inert: Object.freeze({ schema: INERT_PROP_DECLARATION_SCHEMA, interactive: false, enterable: false }) });
}

/** Strictly parse a complete catalog. Unknown/accessor/sparse/prototyped data fails closed. */
export function parseFunctionalBuildingCatalog(value) {
  const d = record(value, new Set(["schema", "catalogId", "revision", "entries"]), new Set(), "functional building catalog");
  if (d.schema.value !== FUNCTIONAL_BUILDING_CATALOG_SCHEMA) fail("functional building catalog.schema is unsupported");
  const entries = denseArray(d.entries.value, 1, FUNCTIONAL_BUILDING_CATALOG_LIMITS.entries, "functional building catalog.entries").map((entry, index) => {
    if (entry === null || typeof entry !== "object") fail(`functional building catalog.entries[${index}] must be an object`);
    const placementClass = Object.getOwnPropertyDescriptor(entry, "placementClass");
    if (!placementClass || !("value" in placementClass)) fail(`functional building catalog.entries[${index}].placementClass must be a data field`);
    if (placementClass.value === "functional-building") return parseFunctionalEntry(entry, `functional building catalog.entries[${index}]`);
    if (placementClass.value === "inert-prop") return parseInertEntry(entry, `functional building catalog.entries[${index}]`);
    fail(`functional building catalog.entries[${index}].placementClass is unsupported`);
  });
  for (let index = 1; index < entries.length; index++) if (entries[index - 1].entryId >= entries[index].entryId) fail("functional building catalog.entries must be strictly entryId-sorted and unique");
  const assets = new Set(), addresses = new Set(), variants = new Set();
  for (const entry of entries) {
    if (assets.has(entry.asset.assetId)) fail(`functional building catalog has duplicate asset '${entry.asset.assetId}'`); assets.add(entry.asset.assetId);
    const address = `${entry.asset.hashKind}\0${entry.asset.hash}`;
    if (addresses.has(address)) fail(`functional building catalog has duplicate exact asset address '${entry.asset.hash}'`); addresses.add(address);
    const key = `${entry.variant.familyId}\0${entry.variant.variantId}`;
    if (variants.has(key)) fail(`functional building catalog has duplicate variant '${entry.variant.familyId}/${entry.variant.variantId}'`); variants.add(key);
  }
  return Object.freeze({ schema: FUNCTIONAL_BUILDING_CATALOG_SCHEMA, catalogId: id(d.catalogId.value, "functional building catalog.catalogId"),
    revision: uint(d.revision.value, 2 ** 31 - 1, "functional building catalog.revision", true), entries: Object.freeze(entries) });
}

function semanticCore(contract) {
  const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return { buildingId: contract.buildingId, rooms: [...contract.rooms].sort(byId), portals: [...contract.portals].sort(byId),
    doors: [...contract.doors].sort(byId), spawns: [...contract.spawnAnchors].sort(byId), cells: [...contract.visibilityCells].sort(byId) };
}
/** Stable identity of gameplay-relevant topology; visual mesh/material changes do not perturb it. */
export function deriveFunctionalBuildingSemanticFingerprint(contract) {
  if (contract?.schema !== FUNCTIONAL_BUILDING_CONTRACT_V2) fail(`semantic fingerprint requires ${FUNCTIONAL_BUILDING_CONTRACT_V2}`);
  return canonicalHash(semanticCore(contract), "functional building semantic identity");
}
/** Stable hash of the complete, validated v2 runtime contract. */
export function deriveFunctionalBuildingContractHash(contract) {
  if (contract?.schema !== FUNCTIONAL_BUILDING_CONTRACT_V2) fail(`contract hash requires ${FUNCTIONAL_BUILDING_CONTRACT_V2}`);
  return canonicalHash(contract, "functional building contract");
}
export function deriveFunctionalBuildingSemanticIdentity(contract) {
  const sorted = (values) => Object.freeze(values.map((entry) => entry.id).sort((a, b) => a < b ? -1 : a > b ? 1 : 0));
  return Object.freeze({ buildingId: contract.buildingId, rooms: sorted(contract.rooms), portals: sorted(contract.portals),
    exteriorPortals: sorted(contract.portals.filter((portal) => portal.exterior)),
    doors: sorted(contract.doors), spawns: sorted(contract.spawnAnchors), cells: sorted(contract.visibilityCells),
    fingerprint: deriveFunctionalBuildingSemanticFingerprint(contract) });
}

/** Verify one functional catalog entry against exact bytes and the embedded engine contract. */
export function verifyFunctionalBuildingCatalogEntry(entryValue, asset) {
  const entry = parseFunctionalBuildingCatalog({ schema: FUNCTIONAL_BUILDING_CATALOG_SCHEMA, catalogId: "verification/single", revision: 1, entries: [entryValue] }).entries[0];
  if (entry.placementClass !== "functional-building") fail("an inert prop cannot be verified or placed as a functional building");
  const d = record(asset, new Set(["assetId", "bytes"]), new Set(["engineContentHash"]), "functional building catalog asset input");
  if (d.assetId.value !== entry.asset.assetId) fail("functional building catalog asset id does not match supplied bytes");
  if (!(d.bytes.value instanceof Uint8Array)) fail("functional building catalog asset bytes must be Uint8Array");
  const bytes = d.bytes.value;
  if (bytes.byteLength !== entry.asset.byteLength) fail("functional building catalog asset byteLength mismatch");
  if (entry.asset.hashKind === "raw-sha256") {
    if (`sha256:${sha256(bytes)}` !== entry.asset.hash) fail("functional building catalog raw asset hash mismatch");
  } else {
    if (d.engineContentHash === undefined || hash(d.engineContentHash.value, "functional building catalog asset input.engineContentHash") !== entry.asset.hash) fail("functional building catalog engine content hash mismatch");
  }
  let contract; try { contract = parseFunctionalBuildingContract(bytes); }
  catch (error) { fail(`functional building catalog embedded contract rejected: ${error instanceof Error ? error.message : String(error)}`); }
  if (contract.schema !== FUNCTIONAL_BUILDING_CONTRACT_V2) fail(`functional building catalog asset is not ${FUNCTIONAL_BUILDING_CONTRACT_V2}`);
  if (deriveFunctionalBuildingContractHash(contract) !== entry.functionalContract.hash) fail("functional building catalog contract hash mismatch");
  const identity = deriveFunctionalBuildingSemanticIdentity(contract);
  if (canonicalCompilerJson(identity) !== canonicalCompilerJson(entry.semanticIdentity)) fail("functional building catalog semantic identity mismatch");
  const batch = parseFunctionalBuildingStaticBatch(bytes);
  if (batch === undefined) fail("functional building catalog asset lacks a static LOD batch manifest");
  if (canonicalCompilerJson(batch.lodRoots) !== canonicalCompilerJson(entry.lodSemanticIdentity.levels.map((level) => level.rootIndex))
      || batch.doorRoot !== entry.lodSemanticIdentity.articulatedDoorRootIndex) fail("functional building catalog LOD/static-batch proof mismatch");
  return Object.freeze({ entry, contract: frozen(contract), semanticIdentity: identity, staticBatch: batch });
}
