// Exact FB-5 release boundary. A valid building publication is necessary but insufficient: this
// loader independently closes the immutable plan, WorldMap, sites, terrain recipe, and residency
// budget before returning the in-process brand accepted by production settlement streaming.

import { parseFunctionalBuildingContract } from "./functional-building-contract.ts";
import { verifyFunctionalBuildingSiteArtifact } from "./functional-building-site-artifact.mjs";
import { loadApprovedFunctionalBuildingPublication } from "./functional-building-publication.mjs";
import { resolveFunctionalSettlementAtlas } from "./functional-settlement-atlas.mjs";
import { parseFunctionalSettlementPlan } from "./functional-settlement-plan.mjs";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { canonicalCompilerJson } from "../world/compiler/canonical.mjs";
import { sha256 } from "../world/sha256.mjs";
import { verifyWorldMap, WorldMapSchema } from "../world/worldmap.ts";

export const FUNCTIONAL_SETTLEMENT_RELEASE_SCHEMA = "limina.functional-settlement-release/v1";
const HASH = /^sha256:[0-9a-f]{64}$/,
  ID = /^[a-z0-9][a-z0-9._/-]{1,159}$/,
  PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9][a-zA-Z0-9._/-]{1,511}$/;
const BRANDED = new WeakSet();
const fail = (message) => {
  throw new Error(`functional settlement release: ${message}`);
};
const plain = (value, label) => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length
  )
    fail(`${label} must be a plain object`);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value)))
    if (!("value" in descriptor) || descriptor.enumerable !== true)
      fail(`${label} must contain only enumerable data fields`);
  return value;
};
const keys = (value, required, label) => {
  plain(value, label);
  const actual = Object.keys(value).sort(),
    expected = [...required].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} keys drifted`);
};
const id = (value, label) => {
  if (
    typeof value !== "string" ||
    !ID.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    fail(`${label} is invalid`);
  return value;
};
const hash = (value, label) => {
  if (typeof value !== "string" || !HASH.test(value)) fail(`${label} is invalid`);
  return value;
};
const pathValue = (value, label) => {
  if (typeof value !== "string" || !PATH.test(value)) fail(`${label} is invalid`);
  return value;
};
const integer = (value, label, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} is invalid`);
  return value;
};
const finite = (value, label, min = -1e9, max = 1e9) => {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < min || value > max)
    fail(`${label} is invalid`);
  return value;
};
const exact = (value, label, extras = []) => {
  keys(value, ["path", "sha256", "contentHash", "bytes", ...extras], label);
  return {
    path: pathValue(value.path, `${label}.path`),
    sha256: hash(value.sha256, `${label}.sha256`),
    contentHash: hash(value.contentHash, `${label}.contentHash`),
    bytes: integer(value.bytes, `${label}.bytes`, 1),
    ...Object.fromEntries(extras.map((key) => [key, value[key]])),
  };
};
const shortExact = (value, label, extras = []) => {
  keys(value, ["path", "sha256", "contentHash", ...extras], label);
  return {
    path: pathValue(value.path, `${label}.path`),
    sha256: hash(value.sha256, `${label}.sha256`),
    contentHash: hash(value.contentHash, `${label}.contentHash`),
    ...Object.fromEntries(extras.map((key) => [key, value[key]])),
  };
};
const raw = (bytes) => `sha256:${sha256(bytes)}`;
const readExact = (entry, read, label) => {
  const bytes = read(entry.path);
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !== entry.bytes ||
    raw(bytes) !== entry.sha256 ||
    portableAssetContentHash(bytes) !== entry.contentHash
  )
    fail(`${label} exact bytes drifted`);
  return bytes;
};
const deepFreeze = (value) => {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreeze));
  if (value !== null && typeof value === "object") {
    const output = {};
    for (const [key, entry] of Object.entries(value)) output[key] = deepFreeze(entry);
    return Object.freeze(output);
  }
  return value;
};
const decode = (bytes, label) => {
  try {
    return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
  } catch (error) {
    fail(`${label} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export function loadApprovedFunctionalSettlementRelease(bytes, read) {
  if (!(bytes instanceof Uint8Array) || typeof read !== "function")
    fail("loader requires release bytes and an exact reader");
  const value = decode(bytes, "release");
  keys(
    value,
    [
      "schema",
      "releaseId",
      "settlementId",
      "approval",
      "recipe",
      "worldMap",
      "plan",
      "sites",
      "runtime",
      "terrain",
      "inventory",
      "engine",
      "closureHash",
    ],
    "release",
  );
  if (value.schema !== FUNCTIONAL_SETTLEMENT_RELEASE_SCHEMA) fail("schema is unsupported");
  id(value.releaseId, "releaseId");
  id(value.settlementId, "settlementId");
  hash(value.closureHash, "closureHash");
  const { closureHash, ...body } = value;
  if (raw(new TextEncoder().encode(canonicalCompilerJson(body))) !== closureHash) fail("closure hash drifted");
  keys(value.approval, ["publication", "candidateId", "reviewOutcome"], "approval");
  id(value.approval.candidateId, "approval.candidateId");
  const publicationRef = shortExact(value.approval.publication, "approval.publication", ["closureHash"]);
  hash(publicationRef.closureHash, "approval.publication.closureHash");
  const publicationBytes = read(publicationRef.path);
  if (
    !(publicationBytes instanceof Uint8Array) ||
    raw(publicationBytes) !== publicationRef.sha256 ||
    portableAssetContentHash(publicationBytes) !== publicationRef.contentHash
  )
    fail("approved publication bytes drifted");
  const publication = loadApprovedFunctionalBuildingPublication(publicationBytes, read);
  if (publication.closureHash !== publicationRef.closureHash || publication.candidateId !== value.approval.candidateId)
    fail("approved publication identity drifted");
  const reviewOutcome = value.approval.reviewOutcome;
  if (
    reviewOutcome.path !== publication.approval.reviewOutcome.path ||
    reviewOutcome.sha256 !== publication.approval.reviewOutcome.sha256 ||
    reviewOutcome.contentHash !== publication.approval.reviewOutcome.contentHash ||
    reviewOutcome.bytes !== publication.approval.reviewOutcome.bytes
  )
    fail("terminal review outcome drifted from the approved publication");
  const recipeRef = shortExact(value.recipe, "recipe"),
    recipeBytes = read(recipeRef.path);
  if (
    !(recipeBytes instanceof Uint8Array) ||
    raw(recipeBytes) !== recipeRef.sha256 ||
    portableAssetContentHash(recipeBytes) !== recipeRef.contentHash
  )
    fail("recipe exact bytes drifted");
  const recipe = decode(recipeBytes, "recipe");
  keys(
    recipe,
    ["schema", "releaseId", "settlementId", "mapId", "routeId", "publication", "terrain", "runtime", "placements"],
    "recipe",
  );
  const recipeReleaseId = id(recipe.releaseId, "recipe.releaseId"),
    recipeSettlementId = id(recipe.settlementId, "recipe.settlementId");
  id(recipe.mapId, "recipe.mapId");
  id(recipe.routeId, "recipe.routeId");
  if (
    recipe.schema !== "limina.functional-settlement-recipe/v1" ||
    recipeReleaseId !== value.releaseId ||
    recipeSettlementId !== value.settlementId
  )
    fail("recipe identity drifted");
  keys(recipe.publication, ["path", "sha256", "closureHash"], "recipe.publication");
  if (
    pathValue(recipe.publication.path, "recipe.publication.path") !== publicationRef.path ||
    hash(recipe.publication.sha256, "recipe.publication.sha256") !== publicationRef.sha256 ||
    hash(recipe.publication.closureHash, "recipe.publication.closureHash") !== publicationRef.closureHash
  )
    fail("recipe approval binding drifted");
  if (
    canonicalCompilerJson(recipe.runtime) !== canonicalCompilerJson(value.runtime) ||
    canonicalCompilerJson(recipe.terrain) !== canonicalCompilerJson(value.terrain)
  )
    fail("recipe runtime/terrain authority drifted from release");
  const worldMapRef = exact(value.worldMap, "worldMap", ["mapId", "worldMapHash"]);
  id(worldMapRef.mapId, "worldMap.mapId");
  hash(worldMapRef.worldMapHash, "worldMap.worldMapHash");
  const worldMap = WorldMapSchema.parse(decode(readExact(worldMapRef, read, "WorldMap"), "WorldMap")),
    mapVerification = verifyWorldMap(worldMap);
  if (
    !mapVerification.ok ||
    worldMap.id !== worldMapRef.mapId ||
    `sha256:${mapVerification.actual}` !== worldMapRef.worldMapHash
  )
    fail("WorldMap logical identity drifted");
  const planRef = exact(value.plan, "plan", ["planId"]);
  id(planRef.planId, "plan.planId");
  const plan = parseFunctionalSettlementPlan(decode(readExact(planRef, read, "plan"), "plan"), publication.catalog);
  if (
    plan.planId !== value.settlementId ||
    plan.planId !== planRef.planId ||
    recipe.mapId !== worldMap.id ||
    recipe.routeId !== plan.placements[0]?.atlasBinding.routeId
  )
    fail("plan/recipe identity drifted");
  if (!Array.isArray(recipe.placements) || recipe.placements.length !== plan.placements.length)
    fail("recipe placement inventory drifted");
  const recipePlacements = new Map(
    recipe.placements.map((placement, index) => {
      keys(placement, ["anchorId", "residencyUnitId", "position", "yaw"], `recipe.placements[${index}]`);
      return [id(placement.anchorId, `recipe.placements[${index}].anchorId`), placement];
    }),
  );
  if (recipePlacements.size !== recipe.placements.length) fail("recipe placement identities are not unique");
  for (const placement of plan.placements) {
    const source = recipePlacements.get(placement.atlasBinding.anchorId);
    if (
      source === undefined ||
      source.residencyUnitId !== placement.residency.unitId ||
      canonicalCompilerJson(source.position) !== canonicalCompilerJson(placement.position) ||
      source.yaw !== placement.yaw
    )
      fail(`recipe placement drifted: ${placement.placementId}`);
  }
  const atlas = resolveFunctionalSettlementAtlas(plan, publication.catalog, worldMap, { connectorToleranceM: 0 });
  if (atlas.placements.some((placement) => placement.connectorDistanceM !== 0))
    fail("Atlas route contact is not exact");
  keys(
    value.terrain,
    [
      "schema",
      "origin",
      "yaw",
      "baseHeight",
      "localZSlope",
      "maximumSampleSpacing",
      "maximumTerrainGrade",
      "maximumRouteElevationDelta",
    ],
    "terrain",
  );
  if (
    value.terrain.schema !== "limina.shared-local-z-grade/v1" ||
    !Array.isArray(value.terrain.origin) ||
    value.terrain.origin.length !== 2
  )
    fail("terrain authority is unsupported");
  const origin = value.terrain.origin.map((entry, index) => finite(entry, `terrain.origin[${index}]`)),
    yaw = finite(value.terrain.yaw, "terrain.yaw", -Math.PI, Math.PI),
    base = finite(value.terrain.baseHeight, "terrain.baseHeight"),
    slope = finite(value.terrain.localZSlope, "terrain.localZSlope", -0.25, 0.25),
    spacing = finite(value.terrain.maximumSampleSpacing, "terrain.maximumSampleSpacing", Number.MIN_VALUE, 1),
    maximumGrade = finite(value.terrain.maximumTerrainGrade, "terrain.maximumTerrainGrade", 0, 4),
    routeDelta = finite(value.terrain.maximumRouteElevationDelta, "terrain.maximumRouteElevationDelta", 0, 0.5);
  if (Math.abs(slope) > maximumGrade) fail("terrain slope exceeds declared maximum grade");
  const c = Math.cos(yaw),
    s = Math.sin(yaw),
    sampleHeight = (x, z) => base + slope * ((x - origin[0]) * s + (z - origin[1]) * c);
  const assetBytes = read(publication.asset.path),
    contract = parseFunctionalBuildingContract(assetBytes),
    sites = value.sites;
  if (
    !Array.isArray(sites) ||
    sites.length !== plan.placements.length ||
    new Set(sites.map((entry) => entry.path)).size !== sites.length
  )
    fail("site artifact inventory is incomplete");
  const siteByPath = new Map(
    sites.map((entry, index) => {
      const parsed = exact(entry, `sites[${index}]`);
      return [parsed.path, parsed];
    }),
  );
  for (const placement of plan.placements) {
    const ref = siteByPath.get(placement.siteFoundation.path);
    if (ref === undefined || ref.sha256 !== placement.siteFoundation.sha256)
      fail(`site reference drifted: ${placement.placementId}`);
    verifyFunctionalBuildingSiteArtifact(
      readExact(ref, read, `site '${placement.placementId}'`),
      placement.siteFoundation,
      {
        contract,
        sampleHeight,
        placementId: placement.placementId,
        contractHash: placement.catalogContractHash,
        semanticFingerprint: placement.semanticFingerprint,
        worldMapHash: plan.atlas.worldMapHash,
        position: placement.position,
        yaw: placement.yaw,
        routeContact: placement.entryConnector.routeContact,
      },
    );
  }
  keys(value.runtime, ["loadDistance", "keepDistance", "maxActiveUnits", "maxResidentBytes"], "runtime");
  const runtime = {
    loadDistance: finite(value.runtime.loadDistance, "runtime.loadDistance", 0, 1e6),
    keepDistance: finite(value.runtime.keepDistance, "runtime.keepDistance", 0, 1e6),
    maxActiveUnits: integer(value.runtime.maxActiveUnits, "runtime.maxActiveUnits", 1, plan.placements.length),
    maxResidentBytes: integer(value.runtime.maxResidentBytes, "runtime.maxResidentBytes", 1),
  };
  if (
    runtime.keepDistance < runtime.loadDistance ||
    runtime.maxResidentBytes < publication.catalog.entries[0].asset.byteLength
  )
    fail("runtime bounds are inconsistent");
  keys(value.inventory, ["buildings", "catalogEntries", "visibilityCellsPerBuilding", "lodLevels"], "inventory");
  if (
    value.inventory.buildings !== plan.placements.length ||
    value.inventory.catalogEntries !== publication.catalog.entries.length ||
    value.inventory.visibilityCellsPerBuilding !== publication.catalog.entries[0].semanticIdentity.cells.length ||
    value.inventory.lodLevels !== publication.catalog.entries[0].lodSemanticIdentity.levels.length
  )
    fail("release inventory drifted");
  keys(
    value.engine,
    ["placementSkill", "settlementSkill", "residencyPolicy", "genericAssetPlacementProhibited"],
    "engine",
  );
  if (
    value.engine.placementSkill !== "building.placeFunctional" ||
    value.engine.settlementSkill !== "settlement.placeFunctional" ||
    value.engine.residencyPolicy !== "whole-building-atomic" ||
    value.engine.genericAssetPlacementProhibited !== true
  )
    fail("engine pipeline authority drifted");
  const loaded = Object.freeze({
    release: deepFreeze(value),
    publication,
    plan,
    worldMap: deepFreeze(worldMap),
    runtime: deepFreeze(runtime),
  });
  BRANDED.add(loaded);
  return loaded;
}

export function assertApprovedFunctionalSettlementRelease(value) {
  if (value === null || typeof value !== "object" || !BRANDED.has(value))
    fail("value is not a verified in-process settlement release");
  return value;
}
