// FB-5 pure settlement-plan authority. This module validates publication data only: it does not
// place buildings, read assets, mutate Atlas/village state, or construct streaming resources.

import {
  FUNCTIONAL_BUILDING_CATALOG_SCHEMA,
  parseFunctionalBuildingCatalog,
} from "./functional-building-catalog.mjs";
import { canonicalCompilerJson } from "../world/compiler/canonical.mjs";
import { sha256 } from "../world/sha256.mjs";

export const FUNCTIONAL_SETTLEMENT_PLAN_SCHEMA = "limina.functional-settlement-plan/v1";
export const FUNCTIONAL_SETTLEMENT_CATALOG_REF_SCHEMA = "limina.functional-settlement-catalog-ref/v1";
export const FUNCTIONAL_SETTLEMENT_ATLAS_REF_SCHEMA = "limina.functional-settlement-atlas-ref/v1";
export const FUNCTIONAL_SETTLEMENT_ENTRY_CONNECTOR_SCHEMA = "limina.functional-settlement-entry-connector/v1";
export const FUNCTIONAL_SETTLEMENT_SITE_REF_SCHEMA = "limina.functional-settlement-site-ref/v1";
export const FUNCTIONAL_SETTLEMENT_COMPOSITION_REF_SCHEMA = "limina.functional-settlement-composition-ref/v1";
export const FUNCTIONAL_SETTLEMENT_FURNISHING_REF_SCHEMA = "limina.functional-settlement-furnishing-ref/v1";
export const FUNCTIONAL_SETTLEMENT_RESIDENCY_SCHEMA = "limina.functional-settlement-residency/v1";
export const FUNCTIONAL_SETTLEMENT_LIMITS = Object.freeze({
  placements: 256,
  idChars: 160,
  pathChars: 512,
  coordinateMagnitude: 1_000_000_000,
  cellsPerBuilding: 32,
});

const ID = /^[a-z0-9][a-z0-9._/-]{0,159}$/;
const PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9][a-zA-Z0-9._/-]{0,511}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const ALIGNMENT_EPSILON = 1e-6;

export class FunctionalSettlementPlanValidationError extends Error {
  constructor(message) { super(message); this.name = "FunctionalSettlementPlanValidationError"; }
}
function fail(message) { throw new FunctionalSettlementPlanValidationError(message); }

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
function denseArray(value, minimum, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > maximum
      || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    fail(`${label} must be a dense, field-free array with ${minimum}..${maximum} entries`);
  }
  return value;
}
function text(value, pattern, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}
function id(value, label) {
  const output = text(value, ID, FUNCTIONAL_SETTLEMENT_LIMITS.idChars, label);
  if (output.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) fail(`${label} contains an unsafe path segment`);
  return output;
}
function hash(value, label) { return text(value, HASH, 71, label); }
function finite(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < minimum || value > maximum) fail(`${label} is not a bounded finite number`);
  return value;
}
function uint(value, maximum, label, positive = false) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > maximum) fail(`${label} is outside its bounded integer range`);
  return value;
}
function vector(value, length, label, magnitude = FUNCTIONAL_SETTLEMENT_LIMITS.coordinateMagnitude) {
  return Object.freeze(denseArray(value, length, length, label).map((component, index) => finite(component, -magnitude, magnitude, `${label}[${index}]`)));
}
function direction2(value, label) {
  const output = vector(value, 2, label, 1);
  if (Math.abs(Math.hypot(output[0], output[1]) - 1) > ALIGNMENT_EPSILON) fail(`${label} must be unit length`);
  return output;
}
function sortedUniqueIds(value, maximum, label, allowEmpty = false) {
  const source = denseArray(value, allowEmpty ? 0 : 1, maximum, label);
  const output = source.map((entry, index) => id(entry, `${label}[${index}]`));
  for (let index = 1; index < output.length; index++) if (output[index - 1] >= output[index]) fail(`${label} must be strictly id-sorted and unique`);
  return Object.freeze(output);
}
function exactRef(value, schema, label) {
  const d = record(value, new Set(["schema", "artifactId", "path", "sha256"]), new Set(), label);
  if (d.schema.value !== schema) fail(`${label}.schema must be ${schema}`);
  return Object.freeze({ schema, artifactId: id(d.artifactId.value, `${label}.artifactId`),
    path: text(d.path.value, PATH, FUNCTIONAL_SETTLEMENT_LIMITS.pathChars, `${label}.path`), sha256: hash(d.sha256.value, `${label}.sha256`) });
}
function equalExactRef(left, right) {
  return left.artifactId === right.artifactId && left.path === right.path && left.sha256 === right.sha256;
}
function near(a, b) { return Math.abs(a - b) <= ALIGNMENT_EPSILON; }
function nearVector(a, b) { return a.length === b.length && a.every((value, index) => near(value, b[index])); }

/** Stable placement identity independent of input ordering. Atlas anchor ids are unique per plan. */
export function deriveFunctionalSettlementPlacementId(planIdValue, anchorIdValue, entryIdValue) {
  const planId = id(planIdValue, "settlement placement identity.planId");
  const anchorId = id(anchorIdValue, "settlement placement identity.anchorId");
  const entryId = id(entryIdValue, "settlement placement identity.entryId");
  const digest = sha256(canonicalCompilerJson({ planId, anchorId, entryId }));
  return `placement/${digest.slice(0, 32)}`;
}

function parseCatalogRef(value, catalog, label) {
  const d = record(value, new Set(["schema", "catalogId", "revision"]), new Set(), label);
  if (d.schema.value !== FUNCTIONAL_SETTLEMENT_CATALOG_REF_SCHEMA) fail(`${label}.schema is unsupported`);
  const catalogId = id(d.catalogId.value, `${label}.catalogId`);
  const revision = uint(d.revision.value, 2 ** 31 - 1, `${label}.revision`, true);
  if (catalog.schema !== FUNCTIONAL_BUILDING_CATALOG_SCHEMA || catalog.catalogId !== catalogId || catalog.revision !== revision) fail(`${label} does not bind the exact supplied catalog revision`);
  return Object.freeze({ schema: FUNCTIONAL_SETTLEMENT_CATALOG_REF_SCHEMA, catalogId, revision });
}
function parseAtlasRef(value, label) {
  const d = record(value, new Set(["schema", "worldMapHash", "mapId"]), new Set(), label);
  if (d.schema.value !== FUNCTIONAL_SETTLEMENT_ATLAS_REF_SCHEMA) fail(`${label}.schema is unsupported`);
  return Object.freeze({ schema: FUNCTIONAL_SETTLEMENT_ATLAS_REF_SCHEMA, worldMapHash: hash(d.worldMapHash.value, `${label}.worldMapHash`), mapId: id(d.mapId.value, `${label}.mapId`) });
}

function parsePlacement(value, planId, catalogEntries, label) {
  const d = record(value, new Set([
    "placementId", "catalogEntryId", "catalogContractHash", "semanticFingerprint", "position", "yaw",
    "atlasBinding", "entryConnector", "siteFoundation", "residency",
  ]), new Set(["composition", "furnishing"]), label);
  const catalogEntryId = id(d.catalogEntryId.value, `${label}.catalogEntryId`);
  const entry = catalogEntries.get(catalogEntryId);
  if (entry === undefined) fail(`${label} references unknown catalog entry '${catalogEntryId}'`);
  if (entry.placementClass !== "functional-building") fail(`${label} cannot place inert catalog entry '${catalogEntryId}' as a functional building`);
  const catalogContractHash = hash(d.catalogContractHash.value, `${label}.catalogContractHash`);
  const semanticFingerprint = hash(d.semanticFingerprint.value, `${label}.semanticFingerprint`);
  if (catalogContractHash !== entry.functionalContract.hash) fail(`${label} does not preserve the catalog contract hash`);
  if (semanticFingerprint !== entry.semanticIdentity.fingerprint) fail(`${label} does not preserve the catalog semantic fingerprint`);

  const position = vector(d.position.value, 3, `${label}.position`);
  const yaw = finite(d.yaw.value, -Math.PI, Math.PI, `${label}.yaw`);
  const atlas = record(d.atlasBinding.value, new Set(["anchorId", "routeId", "anchorPosition", "anchorYaw"]), new Set(), `${label}.atlasBinding`);
  const atlasBinding = Object.freeze({ anchorId: id(atlas.anchorId.value, `${label}.atlasBinding.anchorId`), routeId: id(atlas.routeId.value, `${label}.atlasBinding.routeId`),
    anchorPosition: vector(atlas.anchorPosition.value, 3, `${label}.atlasBinding.anchorPosition`),
    anchorYaw: finite(atlas.anchorYaw.value, -Math.PI, Math.PI, `${label}.atlasBinding.anchorYaw`) });
  if (!nearVector(position, atlasBinding.anchorPosition) || !near(yaw, atlasBinding.anchorYaw)) fail(`${label}.atlasBinding must retain the exact placement position and rotation`);

  const placementId = id(d.placementId.value, `${label}.placementId`);
  const expectedPlacementId = deriveFunctionalSettlementPlacementId(planId, atlasBinding.anchorId, catalogEntryId);
  if (placementId !== expectedPlacementId) fail(`${label}.placementId is not the deterministic plan/anchor/catalog identity`);

  const connector = record(d.entryConnector.value, new Set(["schema", "kind", "portalId", "localAnchor", "localOutward", "routeContact", "worldOutward"]), new Set(), `${label}.entryConnector`);
  if (connector.schema.value !== FUNCTIONAL_SETTLEMENT_ENTRY_CONNECTOR_SCHEMA) fail(`${label}.entryConnector.schema is unsupported`);
  if (connector.kind.value !== "exterior-entry") fail(`${label}.entryConnector.kind must be exterior-entry`);
  const portalId = id(connector.portalId.value, `${label}.entryConnector.portalId`);
  if (!entry.semanticIdentity.portals.includes(portalId)) fail(`${label}.entryConnector.portalId is absent from the bound functional semantics`);
  if (!entry.semanticIdentity.exteriorPortals.includes(portalId)) fail(`${label}.entryConnector.portalId is not an exterior portal in the bound functional semantics`);
  const localAnchor = vector(connector.localAnchor.value, 3, `${label}.entryConnector.localAnchor`);
  const localOutward = direction2(connector.localOutward.value, `${label}.entryConnector.localOutward`);
  const routeContact = vector(connector.routeContact.value, 3, `${label}.entryConnector.routeContact`);
  const worldOutward = direction2(connector.worldOutward.value, `${label}.entryConnector.worldOutward`);
  const cosine = Math.cos(yaw), sine = Math.sin(yaw);
  const expectedContact = Object.freeze([position[0] + localAnchor[0] * cosine + localAnchor[2] * sine, position[1] + localAnchor[1], position[2] - localAnchor[0] * sine + localAnchor[2] * cosine]);
  const expectedOutward = Object.freeze([localOutward[0] * cosine + localOutward[1] * sine, -localOutward[0] * sine + localOutward[1] * cosine]);
  if (!nearVector(routeContact, expectedContact) || !nearVector(worldOutward, expectedOutward)) fail(`${label}.entryConnector is not aligned by the authoritative placement transform`);
  const entryConnector = Object.freeze({ schema: FUNCTIONAL_SETTLEMENT_ENTRY_CONNECTOR_SCHEMA, kind: "exterior-entry", portalId, localAnchor, localOutward, routeContact, worldOutward });

  const siteFoundation = exactRef(d.siteFoundation.value, FUNCTIONAL_SETTLEMENT_SITE_REF_SCHEMA, `${label}.siteFoundation`);
  const residencyRaw = record(d.residency.value, new Set(["schema", "unitId", "policy", "cellIds"]), new Set(), `${label}.residency`);
  if (residencyRaw.schema.value !== FUNCTIONAL_SETTLEMENT_RESIDENCY_SCHEMA) fail(`${label}.residency.schema is unsupported`);
  if (residencyRaw.policy.value !== "whole-building-atomic") fail(`${label}.residency.policy must be whole-building-atomic`);
  const cellIds = sortedUniqueIds(residencyRaw.cellIds.value, FUNCTIONAL_SETTLEMENT_LIMITS.cellsPerBuilding, `${label}.residency.cellIds`);
  if (canonicalCompilerJson(cellIds) !== canonicalCompilerJson(entry.semanticIdentity.cells)) fail(`${label}.residency must cover the exact functional visibility-cell inventory`);
  const residency = Object.freeze({ schema: FUNCTIONAL_SETTLEMENT_RESIDENCY_SCHEMA, unitId: id(residencyRaw.unitId.value, `${label}.residency.unitId`), policy: "whole-building-atomic", cellIds });

  let composition;
  if (d.composition !== undefined) {
    composition = exactRef(d.composition.value, FUNCTIONAL_SETTLEMENT_COMPOSITION_REF_SCHEMA, `${label}.composition`);
    if (entry.compositionPackage === undefined || !equalExactRef(composition, entry.compositionPackage)) fail(`${label}.composition does not bind the catalog-approved exact composition package`);
  }
  const furnishing = d.furnishing === undefined ? undefined : exactRef(d.furnishing.value, FUNCTIONAL_SETTLEMENT_FURNISHING_REF_SCHEMA, `${label}.furnishing`);
  return Object.freeze({ placementId, catalogEntryId, catalogContractHash, semanticFingerprint, position, yaw, atlasBinding, entryConnector, siteFoundation, residency,
    ...(composition === undefined ? {} : { composition }), ...(furnishing === undefined ? {} : { furnishing }) });
}

/**
 * Strictly parse a complete settlement plan against one exact functional-building catalog revision.
 * Unknown/accessor/sparse/prototyped data and inert-as-functional placement fail before mutation.
 */
export function parseFunctionalSettlementPlan(value, catalogValue) {
  const catalog = parseFunctionalBuildingCatalog(catalogValue);
  const d = record(value, new Set(["schema", "planId", "catalog", "atlas", "placements"]), new Set(), "functional settlement plan");
  if (d.schema.value !== FUNCTIONAL_SETTLEMENT_PLAN_SCHEMA) fail("functional settlement plan.schema is unsupported");
  const planId = id(d.planId.value, "functional settlement plan.planId");
  const catalogRef = parseCatalogRef(d.catalog.value, catalog, "functional settlement plan.catalog");
  const atlas = parseAtlasRef(d.atlas.value, "functional settlement plan.atlas");
  const catalogEntries = new Map(catalog.entries.map((entry) => [entry.entryId, entry]));
  const placements = denseArray(d.placements.value, 1, FUNCTIONAL_SETTLEMENT_LIMITS.placements, "functional settlement plan.placements")
    .map((placement, index) => parsePlacement(placement, planId, catalogEntries, `functional settlement plan.placements[${index}]`));
  for (let index = 1; index < placements.length; index++) if (placements[index - 1].placementId >= placements[index].placementId) fail("functional settlement plan.placements must be strictly placementId-sorted and unique");
  const anchors = new Set(), residencyUnits = new Set();
  for (const placement of placements) {
    if (anchors.has(placement.atlasBinding.anchorId)) fail(`functional settlement plan has duplicate Atlas anchor '${placement.atlasBinding.anchorId}'`);
    anchors.add(placement.atlasBinding.anchorId);
    if (residencyUnits.has(placement.residency.unitId)) fail(`functional settlement plan has duplicate residency unit '${placement.residency.unitId}'`);
    residencyUnits.add(placement.residency.unitId);
  }
  return Object.freeze({ schema: FUNCTIONAL_SETTLEMENT_PLAN_SCHEMA, planId, catalog: catalogRef, atlas, placements: Object.freeze(placements) });
}
