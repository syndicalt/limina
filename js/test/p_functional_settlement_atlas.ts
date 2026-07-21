import {
  FUNCTIONAL_SETTLEMENT_ATLAS_RESOLUTION_SCHEMA,
  resolveFunctionalSettlementAtlas,
} from "../src/assets/functional-settlement-atlas.mjs";
import {
  FUNCTIONAL_SETTLEMENT_ATLAS_REF_SCHEMA,
  FUNCTIONAL_SETTLEMENT_CATALOG_REF_SCHEMA,
  FUNCTIONAL_SETTLEMENT_ENTRY_CONNECTOR_SCHEMA,
  FUNCTIONAL_SETTLEMENT_PLAN_SCHEMA,
  FUNCTIONAL_SETTLEMENT_RESIDENCY_SCHEMA,
  FUNCTIONAL_SETTLEMENT_SITE_REF_SCHEMA,
  deriveFunctionalSettlementPlacementId,
} from "../src/assets/functional-settlement-plan.mjs";
import { FUNCTIONAL_BUILDING_CATALOG_SCHEMA, FUNCTIONAL_BUILDING_LOD_PROOF_SCHEMA } from "../src/assets/functional-building-catalog.mjs";
import { FUNCTIONAL_BUILDING_CONTRACT_V2 } from "../src/assets/functional-building-contract.ts";
import { worldMapContentHash } from "../src/world/worldmap.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`p_functional_settlement_atlas FAIL: ${message}`); }
function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  try { fn(); } catch (error) { if (pattern.test(error instanceof Error ? error.message : String(error))) return; throw error; }
  throw new Error(`p_functional_settlement_atlas FAIL: ${message}`);
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const H = (digit: string) => `sha256:${digit.repeat(64)}`;
const semantic = { buildingId: "building/house", rooms: ["room/main"], portals: ["portal/front"], exteriorPortals: ["portal/front"],
  doors: ["door/front"], spawns: ["spawn/main"], cells: ["cell/main"], fingerprint: H("2") };
const functional = { entryId: "building/house", placementClass: "functional-building",
  asset: { assetId: "buildings/house.glb", hashKind: "raw-sha256", hash: H("1"), byteLength: 4096 },
  variant: { familyId: "house/timber", variantId: "a" }, functionalContract: { schema: FUNCTIONAL_BUILDING_CONTRACT_V2, hash: H("3") }, semanticIdentity: semantic,
  lodSemanticIdentity: { schema: FUNCTIONAL_BUILDING_LOD_PROOF_SCHEMA, articulatedDoorPolicy: "shared-outside-static-lods", articulatedDoorRootIndex: 12,
    levels: [10, 11].map((rootIndex, level) => ({ level, rootIndex, semanticFingerprint: semantic.fingerprint })) } };
const catalog = { schema: FUNCTIONAL_BUILDING_CATALOG_SCHEMA, catalogId: "settlement/core", revision: 1, entries: [functional] };
const planId = "settlement/grey-field";

function placement(anchorId: string, x: number, residency: string) {
  const yaw = Math.PI / 2;
  return { placementId: deriveFunctionalSettlementPlacementId(planId, anchorId, functional.entryId), catalogEntryId: functional.entryId,
    catalogContractHash: functional.functionalContract.hash, semanticFingerprint: semantic.fingerprint,
    position: [x, 7, -50], yaw, atlasBinding: { anchorId, routeId: "route/main-street", anchorPosition: [x, 7, -50], anchorYaw: yaw },
    entryConnector: { schema: FUNCTIONAL_SETTLEMENT_ENTRY_CONNECTOR_SCHEMA, kind: "exterior-entry", portalId: "portal/front",
      localAnchor: [2, 0, 0], localOutward: [1, 0], routeContact: [x, 7, -52], worldOutward: [0, -1] },
    siteFoundation: { schema: FUNCTIONAL_SETTLEMENT_SITE_REF_SCHEMA, artifactId: `site/${anchorId}`, path: `sites/${anchorId}.json`, sha256: H("4") },
    residency: { schema: FUNCTIONAL_SETTLEMENT_RESIDENCY_SCHEMA, unitId: residency, policy: "whole-building-atomic", cellIds: ["cell/main"] } };
}

const placements = [placement("anchor/house-b", 120, "residency/b"), placement("anchor/house-a", 100, "residency/a")]
  .sort((a, b) => a.placementId.localeCompare(b.placementId));
const worldMap: any = { version: 1, id: "atlas/map/grey-field", unitsPerMeter: 1, origin: [0, 0], extent: { w: 1000, h: 1000 }, seaLevel: 0,
  land: [], relief: [], biomes: [], waterways: [], routes: [{ id: "route/main-street", points: [[90, -52], [110, -52], [130, -52]], class: "road" }],
  anchors: [{ id: "anchor/house-a", kind: "asset", position: [100, -50], rot: Math.PI / 2, source: "map" },
    { id: "anchor/house-b", kind: "asset", position: [120, -50], rot: Math.PI / 2, source: "map" }],
  provenance: { tool: "design-space", contentHash: "pending" } };
worldMap.provenance.contentHash = worldMapContentHash(worldMap);
const plan: any = { schema: FUNCTIONAL_SETTLEMENT_PLAN_SCHEMA, planId,
  catalog: { schema: FUNCTIONAL_SETTLEMENT_CATALOG_REF_SCHEMA, catalogId: catalog.catalogId, revision: catalog.revision },
  atlas: { schema: FUNCTIONAL_SETTLEMENT_ATLAS_REF_SCHEMA, worldMapHash: `sha256:${worldMap.provenance.contentHash}`, mapId: worldMap.id }, placements };

function rebound(mutator: (map: any, candidatePlan: any) => void) {
  const map = clone(worldMap), candidatePlan = clone(plan); mutator(map, candidatePlan);
  map.provenance.contentHash = "pending"; map.provenance.contentHash = worldMapContentHash(map);
  candidatePlan.atlas.worldMapHash = `sha256:${map.provenance.contentHash}`;
  return { map, plan: candidatePlan };
}

const resolved = resolveFunctionalSettlementAtlas(plan, catalog, worldMap);
assert(resolved.schema === FUNCTIONAL_SETTLEMENT_ATLAS_RESOLUTION_SCHEMA && Object.isFrozen(resolved.placements), "resolution is not immutable or typed");
assert(resolved.placements.map((entry: any) => entry.placementId).join() === placements.map((entry) => entry.placementId).join(), "validated placement input order changed");
assert(resolved.placements[0].inputOrder === 0 && resolved.placements[0].position[1] === 7 && resolved.placements[0].anchor.position[1] === 7, "full 3D position was not preserved");
assert(JSON.stringify(resolved.placements[0].route.points) === JSON.stringify(worldMap.routes[0].points), "route geometry point order changed");
assert(resolved.placements.every((entry: any) => entry.connectorDistanceM === 0), "on-route connectors were not exact");

rejects(() => resolveFunctionalSettlementAtlas({ ...plan, atlas: { ...plan.atlas, mapId: "atlas/map/wrong" } }, catalog, worldMap), /map id/, "wrong map id was accepted");
rejects(() => resolveFunctionalSettlementAtlas({ ...plan, atlas: { ...plan.atlas, worldMapHash: H("9") } }, catalog, worldMap), /Atlas hash/, "wrong map hash was accepted");
{
  const { map, plan: candidate } = rebound((map) => { map.anchors[0].rot = 0; });
  rejects(() => resolveFunctionalSettlementAtlas(candidate, catalog, map), /position or rotation/, "Atlas yaw loss was accepted");
}
{
  const { map, plan: candidate } = rebound((map) => { map.anchors.splice(0, 1); });
  rejects(() => resolveFunctionalSettlementAtlas(candidate, catalog, map), /missing WorldMap anchor/, "missing anchor was accepted");
}
{
  const { map, plan: candidate } = rebound((map) => { map.anchors.push(clone(map.anchors[0])); });
  rejects(() => resolveFunctionalSettlementAtlas(candidate, catalog, map), /duplicate anchor/, "duplicate anchor was accepted");
}
{
  const { map, plan: candidate } = rebound((map) => { delete map.routes[0].id; });
  rejects(() => resolveFunctionalSettlementAtlas(candidate, catalog, map), /no stable Atlas id/, "unaddressable route was accepted");
}
{
  const { map, plan: candidate } = rebound((map) => { map.routes[0].id = "route/elsewhere"; });
  rejects(() => resolveFunctionalSettlementAtlas(candidate, catalog, map), /missing WorldMap route/, "missing route was accepted");
}
{
  const { map, plan: candidate } = rebound((map) => { map.routes.push(clone(map.routes[0])); });
  rejects(() => resolveFunctionalSettlementAtlas(candidate, catalog, map), /duplicate route/, "duplicate route was accepted");
}
{
  const { map, plan: candidate } = rebound((map) => { map.routes[0].points = map.routes[0].points.map(([x, z]: number[]) => [x, z + 1]); });
  const within = resolveFunctionalSettlementAtlas(candidate, catalog, map, { connectorToleranceM: 1 });
  assert(within.placements.every((entry: any) => Math.abs(entry.connectorDistanceM - 1) < 1e-9), "bounded connector tolerance did not retain measured distance");
  rejects(() => resolveFunctionalSettlementAtlas(candidate, catalog, map, { connectorToleranceM: .5 }), /beyond 0.5m/, "route contact outside tolerance was accepted");
}
rejects(() => resolveFunctionalSettlementAtlas(plan, catalog, worldMap, { connectorToleranceM: 26 }), /bounded finite/, "unbounded connector tolerance was accepted");
{
  const { map, plan: candidate } = rebound((map) => { map.routes[0].points[0][0] = 1_000_000_001; });
  rejects(() => resolveFunctionalSettlementAtlas(candidate, catalog, map), /bounded finite/, "unbounded route geometry was accepted");
}

console.log("p_functional_settlement_atlas OK: exact map/hash, stable Atlas anchor yaw and x/z, complete 3D placement preservation, stable route ids/geometry, bounded route-contact closure, deterministic order, and fail-closed missing/duplicate authority");
