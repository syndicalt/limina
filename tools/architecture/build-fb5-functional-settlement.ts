#!/usr/bin/env bun
// Deterministic CPU-only FB-5 release builder. It consumes an independently reloaded exact HITL
// publication plus a bounded placement/terrain recipe and emits one atomic settlement authority.

import fs from "node:fs";
import path from "node:path";

import { parseFunctionalBuildingContract } from "../../js/src/assets/functional-building-contract.ts";
import { resolveFunctionalBuildingSitePlacement } from "../../js/src/assets/functional-building-site.ts";
import {
  encodeFunctionalBuildingSiteArtifact,
  resolveFunctionalBuildingSiteArtifact,
} from "../../js/src/assets/functional-building-site-artifact.mjs";
import { loadApprovedFunctionalBuildingPublication } from "../../js/src/assets/functional-building-publication.mjs";
import { resolveFunctionalSettlementAtlas } from "../../js/src/assets/functional-settlement-atlas.mjs";
import {
  FUNCTIONAL_SETTLEMENT_ATLAS_REF_SCHEMA,
  FUNCTIONAL_SETTLEMENT_CATALOG_REF_SCHEMA,
  FUNCTIONAL_SETTLEMENT_ENTRY_CONNECTOR_SCHEMA,
  FUNCTIONAL_SETTLEMENT_PLAN_SCHEMA,
  FUNCTIONAL_SETTLEMENT_RESIDENCY_SCHEMA,
  FUNCTIONAL_SETTLEMENT_SITE_REF_SCHEMA,
  deriveFunctionalSettlementPlacementId,
  parseFunctionalSettlementPlan,
} from "../../js/src/assets/functional-settlement-plan.mjs";
import { canonicalCompilerJson } from "../../js/src/world/compiler/canonical.mjs";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import { sha256 } from "../../js/src/world/sha256.mjs";
import {
  stableStringifyWorldMap,
  verifyWorldMap,
  WorldMapSchema,
  worldMapContentHash,
} from "../../js/src/world/worldmap.ts";

const ROOT = path.resolve(import.meta.dirname, "../.."),
  args = process.argv.slice(2);
const at = (flag: string) => {
  const index = args.indexOf(flag),
    value = args[index + 1];
  if (index < 0 || !value)
    throw new Error(
      `usage: bun tools/architecture/build-fb5-functional-settlement.ts --recipe <json> --out-root <new assets/settlements directory>`,
    );
  return value;
};
for (let index = 0; index < args.length; index += 2)
  if (!new Set(["--recipe", "--out-root"]).has(args[index]!) || !args[index + 1])
    throw new Error(`unsupported or incomplete argument '${args[index]}'`);
const portable = (input: string) => {
  const absolute = path.resolve(ROOT, input),
    relative = path.relative(ROOT, absolute).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative))
    throw new Error(`path escapes workspace: ${input}`);
  return relative;
};
const raw = (bytes: Uint8Array): `sha256:${string}` => `sha256:${sha256(bytes)}`,
  encode = (value: unknown) => Buffer.from(`${canonicalCompilerJson(value)}\n`),
  pretty = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const exact = (file: string) => {
  const filePath = portable(file),
    bytes = fs.readFileSync(path.resolve(ROOT, filePath));
  return { path: filePath, bytes, sha256: raw(bytes), contentHash: portableAssetContentHash(bytes) };
};
const plain = (value: any, label: string) => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`${label} must be a plain object`);
  return value;
};
const keys = (value: any, expected: string[], label: string) => {
  plain(value, label);
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw new Error(`${label} keys drifted`);
};
const id = (value: any, label: string) => {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._/-]{1,159}$/.test(value) ||
    value.split("/").some((part: string) => !part || part === "." || part === "..")
  )
    throw new Error(`${label} is invalid`);
  return value;
};
const finite = (value: any, label: string, min = -1e9, max = 1e9) => {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0) || value < min || value > max)
    throw new Error(`${label} is not bounded finite`);
  return value;
};
const vector = (value: any, length: number, label: string) => {
  if (!Array.isArray(value) || value.length !== length || Object.keys(value).length !== length)
    throw new Error(`${label} is not a dense ${length}-vector`);
  return value.map((entry, index) => finite(entry, `${label}[${index}]`));
};

const recipeFile = exact(at("--recipe")),
  recipe = JSON.parse(recipeFile.bytes.toString("utf8"));
keys(
  recipe,
  ["schema", "releaseId", "settlementId", "mapId", "routeId", "publication", "terrain", "runtime", "placements"],
  "settlement recipe",
);
if (recipe.schema !== "limina.functional-settlement-recipe/v1") throw new Error("unsupported settlement recipe schema");
for (const field of ["releaseId", "settlementId", "mapId", "routeId"]) id(recipe[field], `recipe.${field}`);
keys(recipe.publication, ["path", "sha256", "closureHash"], "recipe.publication");
const publicationFile = exact(recipe.publication.path);
if (publicationFile.sha256 !== recipe.publication.sha256) throw new Error("recipe publication bytes drifted");
const read = (file: string) => fs.readFileSync(path.resolve(ROOT, portable(file))),
  publication = loadApprovedFunctionalBuildingPublication(publicationFile.bytes, read);
if (publication.closureHash !== recipe.publication.closureHash || publication.catalog.entries.length !== 1)
  throw new Error("recipe does not bind one exact approved publication");
const entry: any = publication.catalog.entries[0],
  assetFile = exact(publication.asset.path),
  contract: any = parseFunctionalBuildingContract(assetFile.bytes);
if (
  entry.asset.hash !== assetFile.sha256 ||
  entry.asset.byteLength !== assetFile.bytes.byteLength ||
  entry.functionalContract.schema !== contract.schema
)
  throw new Error("approved catalog asset/contract closure drifted");

keys(
  recipe.terrain,
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
  "recipe.terrain",
);
if (recipe.terrain.schema !== "limina.shared-local-z-grade/v1")
  throw new Error("unsupported settlement terrain authority");
const terrainOrigin = vector(recipe.terrain.origin, 2, "recipe.terrain.origin"),
  terrainYaw = finite(recipe.terrain.yaw, "recipe.terrain.yaw", -Math.PI, Math.PI),
  baseHeight = finite(recipe.terrain.baseHeight, "recipe.terrain.baseHeight"),
  slope = finite(recipe.terrain.localZSlope, "recipe.terrain.localZSlope", -0.25, 0.25);
const maximumSampleSpacing = finite(
    recipe.terrain.maximumSampleSpacing,
    "recipe.terrain.maximumSampleSpacing",
    Number.MIN_VALUE,
    1,
  ),
  maximumTerrainGrade = finite(recipe.terrain.maximumTerrainGrade, "recipe.terrain.maximumTerrainGrade", 0, 4),
  maximumRouteElevationDelta = finite(
    recipe.terrain.maximumRouteElevationDelta,
    "recipe.terrain.maximumRouteElevationDelta",
    0,
    0.5,
  );
if (Math.abs(slope) > maximumTerrainGrade) throw new Error("terrain analytic slope exceeds its declared grade limit");
const tc = Math.cos(terrainYaw),
  ts = Math.sin(terrainYaw),
  sampleHeight = (x: number, z: number) =>
    baseHeight + slope * ((x - terrainOrigin[0]) * ts + (z - terrainOrigin[1]) * tc);
keys(recipe.runtime, ["loadDistance", "keepDistance", "maxActiveUnits", "maxResidentBytes"], "recipe.runtime");
const runtime = {
  loadDistance: finite(recipe.runtime.loadDistance, "runtime.loadDistance", 0, 1e6),
  keepDistance: finite(recipe.runtime.keepDistance, "runtime.keepDistance", 0, 1e6),
  maxActiveUnits: recipe.runtime.maxActiveUnits,
  maxResidentBytes: recipe.runtime.maxResidentBytes,
};
if (
  runtime.keepDistance < runtime.loadDistance ||
  !Number.isSafeInteger(runtime.maxActiveUnits) ||
  runtime.maxActiveUnits < 1 ||
  !Number.isSafeInteger(runtime.maxResidentBytes) ||
  runtime.maxResidentBytes < entry.asset.byteLength
)
  throw new Error("runtime residency budget is invalid");
if (!Array.isArray(recipe.placements) || recipe.placements.length < 2 || recipe.placements.length > 256)
  throw new Error("settlement recipe requires 2..256 placements");
const placementRecipes = recipe.placements.map((value: any, index: number) => {
  keys(value, ["anchorId", "residencyUnitId", "position", "yaw"], `placements[${index}]`);
  const position = vector(value.position, 3, `placements[${index}].position`),
    yaw = finite(value.yaw, `placements[${index}].yaw`, -Math.PI, Math.PI);
  if (Math.abs(yaw - terrainYaw) > 1e-9)
    throw new Error("shared-local-z-grade requires every placement yaw to equal terrain yaw");
  return {
    anchorId: id(value.anchorId, `placements[${index}].anchorId`),
    residencyUnitId: id(value.residencyUnitId, `placements[${index}].residencyUnitId`),
    position,
    yaw,
  };
});
if (
  new Set(placementRecipes.map((value: any) => value.anchorId)).size !== placementRecipes.length ||
  new Set(placementRecipes.map((value: any) => value.residencyUnitId)).size !== placementRecipes.length
)
  throw new Error("settlement recipe anchor/residency identities must be unique");
const site = contract.site,
  support = site?.entranceSupport;
if (!site || !support) throw new Error("published building lacks settlement site and entrance-support authority");
const supportSign = Math.sign(
  (support.center[0] - site.footprintCenter[0]) * Math.sin(support.yawRadians) +
    (support.center[1] - site.footprintCenter[1]) * Math.cos(support.yawRadians),
);
if (supportSign === 0) throw new Error("entrance support has no exterior-facing side");
const localOutward: [number, number] = [
  Math.sin(support.yawRadians) * supportSign || 0,
  Math.cos(support.yawRadians) * supportSign || 0,
];
const preliminary = placementRecipes.map((placement: any) => {
  const c = Math.cos(placement.yaw),
    s = Math.sin(placement.yaw),
    localX = support.center[0],
    localZ = support.center[1],
    contactXZ = [placement.position[0] + localX * c + localZ * s, placement.position[2] - localX * s + localZ * c];
  return { ...placement, contactXZ };
});
const mapOrigin: [number, number] = [terrainOrigin[0] - 100, terrainOrigin[1] - 100],
  mapExtent = { w: 200, h: 200 };
if (
  preliminary.some(
    (value: any) =>
      value.contactXZ[0] < mapOrigin[0] ||
      value.contactXZ[0] > mapOrigin[0] + mapExtent.w ||
      value.contactXZ[1] < mapOrigin[1] ||
      value.contactXZ[1] > mapOrigin[1] + mapExtent.h,
  )
)
  throw new Error("settlement route contact lies outside the recipe's bounded WorldMap extent");
const worldMap: any = {
  version: 1,
  id: recipe.mapId,
  unitsPerMeter: 1,
  origin: mapOrigin,
  extent: mapExtent,
  seaLevel: 0,
  land: [],
  relief: [],
  biomes: [],
  waterways: [],
  routes: [{ id: recipe.routeId, points: preliminary.map((value: any) => value.contactXZ), class: "road" }],
  anchors: preliminary.map((value: any) => ({
    id: value.anchorId,
    kind: "asset",
    position: [value.position[0], value.position[2]],
    assetId: entry.asset.assetId,
    rot: value.yaw,
    source: "map",
  })),
  provenance: { tool: "design-space", sourceHash: publication.closureHash.slice(7), contentHash: "pending" },
};
worldMap.provenance.contentHash = worldMapContentHash(worldMap);
const parsedMap = WorldMapSchema.parse(worldMap),
  mapVerification = verifyWorldMap(parsedMap);
if (!mapVerification.ok) throw new Error("generated settlement WorldMap hash failed self-verification");
const worldMapHash = `sha256:${mapVerification.actual}`,
  outRoot = portable(at("--out-root"));
if (!outRoot.startsWith("assets/settlements/") || fs.existsSync(path.resolve(ROOT, outRoot)))
  throw new Error("--out-root must be a new directory beneath assets/settlements/");
const finalPaths = {
  worldMap: `${outRoot}/worldmap.json`,
  plan: `${outRoot}/plan.json`,
  release: `${outRoot}/release.json`,
};
const settlementSlug = recipe.settlementId.replace(/^settlement\//, "");
const sites = new Map<string, Uint8Array>(),
  placements = preliminary
    .map((placement: any) => {
      const resolved = resolveFunctionalBuildingSitePlacement({
          contract,
          position: placement.position,
          yaw: placement.yaw,
          sampleHeight,
          maximumSampleSpacing,
        }),
        grade = resolved.entranceSupport?.worldGradeY;
      if (grade === undefined) throw new Error(`placement '${placement.anchorId}' has no resolved entrance grade`);
      const localAnchor: [number, number, number] = [
          support.center[0],
          grade - placement.position[1],
          support.center[1],
        ],
        c = Math.cos(placement.yaw),
        s = Math.sin(placement.yaw),
        routeContact = [
          placement.position[0] + localAnchor[0] * c + localAnchor[2] * s,
          placement.position[1] + localAnchor[1],
          placement.position[2] - localAnchor[0] * s + localAnchor[2] * c,
        ],
        worldOutward = [localOutward[0] * c + localOutward[1] * s, -localOutward[0] * s + localOutward[1] * c],
        placementId = deriveFunctionalSettlementPlacementId(recipe.settlementId, placement.anchorId, entry.entryId),
        suffix = placement.anchorId.split("/").at(-1),
        sitePath = `${outRoot}/sites/${suffix}.json`,
        artifactId = `site/${settlementSlug}/${suffix}`,
        artifact = resolveFunctionalBuildingSiteArtifact({
          artifactId,
          placementId,
          contractHash: entry.functionalContract.hash,
          semanticFingerprint: entry.semanticIdentity.fingerprint,
          worldMapHash,
          contract,
          position: placement.position,
          yaw: placement.yaw,
          routeContact,
          sampleHeight,
          maximumSampleSpacing,
          maximumTerrainGrade,
          maximumRouteElevationDelta,
        }),
        bytes = encodeFunctionalBuildingSiteArtifact(artifact);
      sites.set(sitePath, bytes);
      return {
        placementId,
        catalogEntryId: entry.entryId,
        catalogContractHash: entry.functionalContract.hash,
        semanticFingerprint: entry.semanticIdentity.fingerprint,
        position: placement.position,
        yaw: placement.yaw,
        atlasBinding: {
          anchorId: placement.anchorId,
          routeId: recipe.routeId,
          anchorPosition: placement.position,
          anchorYaw: placement.yaw,
        },
        entryConnector: {
          schema: FUNCTIONAL_SETTLEMENT_ENTRY_CONNECTOR_SCHEMA,
          kind: "exterior-entry",
          portalId: entry.semanticIdentity.exteriorPortals[0],
          localAnchor,
          localOutward,
          routeContact,
          worldOutward,
        },
        siteFoundation: {
          schema: FUNCTIONAL_SETTLEMENT_SITE_REF_SCHEMA,
          artifactId,
          path: sitePath,
          sha256: raw(bytes),
        },
        residency: {
          schema: FUNCTIONAL_SETTLEMENT_RESIDENCY_SCHEMA,
          unitId: placement.residencyUnitId,
          policy: "whole-building-atomic",
          cellIds: entry.semanticIdentity.cells,
        },
      };
    })
    .sort((a: any, b: any) => a.placementId.localeCompare(b.placementId));
const planValue = {
    schema: FUNCTIONAL_SETTLEMENT_PLAN_SCHEMA,
    planId: recipe.settlementId,
    catalog: {
      schema: FUNCTIONAL_SETTLEMENT_CATALOG_REF_SCHEMA,
      catalogId: publication.catalog.catalogId,
      revision: publication.catalog.revision,
    },
    atlas: { schema: FUNCTIONAL_SETTLEMENT_ATLAS_REF_SCHEMA, worldMapHash, mapId: parsedMap.id },
    placements,
  },
  plan = parseFunctionalSettlementPlan(planValue, publication.catalog),
  atlas = resolveFunctionalSettlementAtlas(plan, publication.catalog, parsedMap, { connectorToleranceM: 0 });
if (
  atlas.placements.length !== placements.length ||
  atlas.placements.some((value: any) => value.connectorDistanceM !== 0)
)
  throw new Error("generated settlement Atlas closure is incomplete");
const mapBytes = Buffer.from(`${stableStringifyWorldMap(parsedMap)}\n`),
  planBytes = encode(plan),
  recipeShort = { path: recipeFile.path, sha256: recipeFile.sha256, contentHash: recipeFile.contentHash },
  publicationShort = {
    path: publicationFile.path,
    sha256: publicationFile.sha256,
    contentHash: publicationFile.contentHash,
    closureHash: publication.closureHash,
  },
  fileRef = (filePath: string, bytes: Uint8Array) => ({
    path: filePath,
    sha256: raw(bytes),
    contentHash: portableAssetContentHash(bytes),
    bytes: bytes.byteLength,
  });
const releaseBody: any = {
  schema: "limina.functional-settlement-release/v1",
  releaseId: recipe.releaseId,
  settlementId: recipe.settlementId,
  approval: {
    publication: publicationShort,
    candidateId: publication.candidateId,
    reviewOutcome: publication.approval.reviewOutcome,
  },
  recipe: recipeShort,
  worldMap: { ...fileRef(finalPaths.worldMap, mapBytes), mapId: parsedMap.id, worldMapHash },
  plan: { ...fileRef(finalPaths.plan, planBytes), planId: plan.planId },
  sites: [...sites].map(([filePath, bytes]) => fileRef(filePath, bytes)).sort((a, b) => a.path.localeCompare(b.path)),
  runtime,
  terrain: recipe.terrain,
  inventory: {
    buildings: placements.length,
    catalogEntries: publication.catalog.entries.length,
    visibilityCellsPerBuilding: entry.semanticIdentity.cells.length,
    lodLevels: entry.lodSemanticIdentity.levels.length,
  },
  engine: {
    placementSkill: "building.placeFunctional",
    settlementSkill: "settlement.placeFunctional",
    residencyPolicy: "whole-building-atomic",
    genericAssetPlacementProhibited: true,
  },
};
const closureHash = raw(Buffer.from(canonicalCompilerJson(releaseBody))),
  release = { ...releaseBody, closureHash },
  releaseBytes = pretty(release),
  staging = path.resolve(ROOT, `${outRoot}.staging-${process.pid}`);
fs.mkdirSync(path.dirname(staging), { recursive: true, mode: 0o700 });
fs.mkdirSync(staging, { recursive: false, mode: 0o700 });
try {
  const write = (relativePath: string, bytes: Uint8Array) => {
    const target = path.resolve(staging, path.relative(outRoot, relativePath));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
  };
  write(finalPaths.worldMap, mapBytes);
  write(finalPaths.plan, planBytes);
  for (const [filePath, bytes] of sites) write(filePath, bytes);
  write(finalPaths.release, releaseBytes);
  fs.renameSync(staging, path.resolve(ROOT, outRoot));
} catch (error) {
  fs.rmSync(staging, { recursive: true, force: true });
  throw error;
}
console.log(
  JSON.stringify(
    {
      releaseId: release.releaseId,
      path: finalPaths.release,
      closureHash,
      buildings: placements.length,
      worldMapHash,
      sites: sites.size,
      runtime,
    },
    null,
    2,
  ),
);
