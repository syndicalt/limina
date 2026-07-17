import {
  FUNCTIONAL_SETTLEMENT_ATLAS_REF_SCHEMA,
  FUNCTIONAL_SETTLEMENT_CATALOG_REF_SCHEMA,
  FUNCTIONAL_SETTLEMENT_COMPOSITION_REF_SCHEMA,
  FUNCTIONAL_SETTLEMENT_ENTRY_CONNECTOR_SCHEMA,
  FUNCTIONAL_SETTLEMENT_FURNISHING_REF_SCHEMA,
  FUNCTIONAL_SETTLEMENT_PLAN_SCHEMA,
  FUNCTIONAL_SETTLEMENT_RESIDENCY_SCHEMA,
  FUNCTIONAL_SETTLEMENT_SITE_REF_SCHEMA,
  deriveFunctionalSettlementPlacementId,
  parseFunctionalSettlementPlan,
} from "../src/assets/functional-settlement-plan.mjs";
import {
  FUNCTIONAL_BUILDING_CATALOG_SCHEMA,
  FUNCTIONAL_BUILDING_LOD_PROOF_SCHEMA,
  INERT_PROP_DECLARATION_SCHEMA,
} from "../src/assets/functional-building-catalog.mjs";
import { FUNCTIONAL_BUILDING_CONTRACT_V2 } from "../src/assets/functional-building-contract.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`p_functional_settlement_plan FAIL: ${message}`); }
function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  try { fn(); } catch (error) { if (pattern.test(error instanceof Error ? error.message : String(error))) return; throw error; }
  throw new Error(`p_functional_settlement_plan FAIL: ${message}`);
}
const H = (digit: string) => `sha256:${digit.repeat(64)}`;
const semantic = {
  buildingId: "building/house-a", rooms: ["room/main", "room/upper"], portals: ["portal/exterior", "portal/stair"],
  exteriorPortals: ["portal/exterior"], doors: ["door/exterior"], spawns: ["spawn/main"], cells: ["cell/main", "cell/upper"], fingerprint: H("2"),
};
const functional = {
  entryId: "building/house-a", placementClass: "functional-building",
  asset: { assetId: "buildings/house-a.glb", hashKind: "raw-sha256", hash: H("1"), byteLength: 4096 },
  variant: { familyId: "house/timber", variantId: "a" },
  functionalContract: { schema: FUNCTIONAL_BUILDING_CONTRACT_V2, hash: H("3") }, semanticIdentity: semantic,
  lodSemanticIdentity: { schema: FUNCTIONAL_BUILDING_LOD_PROOF_SCHEMA, articulatedDoorPolicy: "shared-outside-static-lods", articulatedDoorRootIndex: 13,
    levels: [10, 11].map((rootIndex, level) => ({ level, rootIndex, semanticFingerprint: semantic.fingerprint })) },
  compositionPackage: { schema: "limina.exact-composition-package-pointer/v1", artifactId: "composition/house-a/r1", path: "buildings/house-a/composition-r1.json", sha256: H("4") },
};
const inert = { entryId: "prop/crate", placementClass: "inert-prop",
  asset: { assetId: "props/crate.glb", hashKind: "engine-content-hash", hash: H("5"), byteLength: 512 },
  variant: { familyId: "prop/crate", variantId: "oak" }, inert: { schema: INERT_PROP_DECLARATION_SCHEMA, interactive: false, enterable: false } };
const catalog = { schema: FUNCTIONAL_BUILDING_CATALOG_SCHEMA, catalogId: "settlement/core", revision: 7, entries: [functional, inert] };
const planId = "settlement/grey-field/a";
const anchorId = "atlas/anchor/house-01";
const placementId = deriveFunctionalSettlementPlacementId(planId, anchorId, functional.entryId);
const placement = {
  placementId, catalogEntryId: functional.entryId, catalogContractHash: functional.functionalContract.hash, semanticFingerprint: semantic.fingerprint,
  position: [100, 12, -50], yaw: Math.PI / 2,
  atlasBinding: { anchorId, routeId: "atlas/route/main-street", anchorPosition: [100, 12, -50], anchorYaw: Math.PI / 2 },
  entryConnector: { schema: FUNCTIONAL_SETTLEMENT_ENTRY_CONNECTOR_SCHEMA, kind: "exterior-entry", portalId: "portal/exterior",
    localAnchor: [2, 0, 0], localOutward: [1, 0], routeContact: [100, 12, -52], worldOutward: [0, -1] },
  siteFoundation: { schema: FUNCTIONAL_SETTLEMENT_SITE_REF_SCHEMA, artifactId: "site/house-01/r1", path: "settlements/grey-field/site-house-01.json", sha256: H("6") },
  residency: { schema: FUNCTIONAL_SETTLEMENT_RESIDENCY_SCHEMA, unitId: "residency/house-01", policy: "whole-building-atomic", cellIds: ["cell/main", "cell/upper"] },
  composition: { schema: FUNCTIONAL_SETTLEMENT_COMPOSITION_REF_SCHEMA, artifactId: "composition/house-a/r1", path: "buildings/house-a/composition-r1.json", sha256: H("4") },
  furnishing: { schema: FUNCTIONAL_SETTLEMENT_FURNISHING_REF_SCHEMA, artifactId: "furnishing/house-01/r1", path: "settlements/grey-field/furnishing-house-01.json", sha256: H("7") },
};
const plan = { schema: FUNCTIONAL_SETTLEMENT_PLAN_SCHEMA, planId,
  catalog: { schema: FUNCTIONAL_SETTLEMENT_CATALOG_REF_SCHEMA, catalogId: catalog.catalogId, revision: catalog.revision },
  atlas: { schema: FUNCTIONAL_SETTLEMENT_ATLAS_REF_SCHEMA, worldMapHash: H("8"), mapId: "atlas/map/grey-field" }, placements: [placement] };

const parsed = parseFunctionalSettlementPlan(plan, catalog);
assert(Object.isFrozen(parsed) && Object.isFrozen(parsed.placements) && Object.isFrozen(parsed.placements[0].entryConnector), "parsed plan was not deeply immutable");
assert(parsed.placements[0].atlasBinding.anchorYaw === Math.PI / 2 && parsed.placements[0].entryConnector.worldOutward[1] === -1, "Atlas rotation or connector alignment was discarded");
assert(parsed.placements[0].residency.cellIds.join(",") === semantic.cells.join(","), "whole-building cell authority drifted");
assert(deriveFunctionalSettlementPlacementId(planId, anchorId, functional.entryId) === placementId, "placement identity is not deterministic");

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const mutate = (fn: (value: any) => void) => { const value = clone(plan); fn(value); return value; };
rejects(() => parseFunctionalSettlementPlan(mutate(v => { v.extra = true; }), catalog), /unknown field/, "unknown plan field was accepted");
rejects(() => parseFunctionalSettlementPlan(mutate(v => { v.catalog.revision++; }), catalog), /exact supplied catalog revision/, "catalog revision drift was accepted");
rejects(() => parseFunctionalSettlementPlan(mutate(v => { v.placements[0].catalogEntryId = "building/missing"; }), catalog), /unknown catalog entry/, "unknown entry was accepted");
rejects(() => parseFunctionalSettlementPlan(mutate(v => { v.placements[0].catalogEntryId = inert.entryId; }), catalog), /cannot place inert/, "inert prop was accepted as a functional building");
rejects(() => parseFunctionalSettlementPlan(mutate(v => { v.placements[0].catalogContractHash = H("9"); }), catalog), /catalog contract hash/, "contract hash drift was accepted");
rejects(() => parseFunctionalSettlementPlan(mutate(v => { v.placements[0].semanticFingerprint = H("9"); }), catalog), /semantic fingerprint/, "semantic fingerprint drift was accepted");
rejects(() => parseFunctionalSettlementPlan(mutate(v => { v.placements[0].placementId = "placement/manual"; }), catalog), /deterministic/, "ad hoc placement id was accepted");
rejects(() => parseFunctionalSettlementPlan(mutate(v => { v.placements[0].position[0] = Infinity; }), catalog), /bounded finite/, "non-finite transform was accepted");
rejects(() => parseFunctionalSettlementPlan(mutate(v => { v.placements[0].atlasBinding.anchorYaw = 0; }), catalog), /retain the exact/, "Atlas rotation loss was accepted");
rejects(() => parseFunctionalSettlementPlan(mutate(v => { delete v.placements[0].entryConnector; }), catalog), /missing 'entryConnector'/, "missing connector authority was accepted");
rejects(() => parseFunctionalSettlementPlan(mutate(v => { v.placements[0].entryConnector.kind = "decorative"; }), catalog), /exterior-entry/, "non-entry connector was accepted");
rejects(() => parseFunctionalSettlementPlan(mutate(v => { v.placements[0].entryConnector.portalId = "portal/stair"; }), catalog), /not an exterior portal/, "interior portal was accepted as settlement entry");
rejects(() => parseFunctionalSettlementPlan(mutate(v => { v.placements[0].entryConnector.routeContact[2] += .01; }), catalog), /not aligned/, "misaligned entry connector was accepted");
rejects(() => parseFunctionalSettlementPlan(mutate(v => { v.placements[0].entryConnector.localOutward = [.5, 0]; }), catalog), /unit length/, "non-unit entry direction was accepted");
rejects(() => parseFunctionalSettlementPlan(mutate(v => { v.placements[0].siteFoundation.sha256 = H("9"); v.placements[0].siteFoundation.extra = true; }), catalog), /unknown field/, "loose foundation reference was accepted");
rejects(() => parseFunctionalSettlementPlan(mutate(v => { v.placements[0].residency.policy = "per-cell"; }), catalog), /whole-building-atomic/, "partial building residency policy was accepted");
rejects(() => parseFunctionalSettlementPlan(mutate(v => { v.placements[0].residency.cellIds = ["cell/main"]; }), catalog), /exact functional visibility-cell inventory/, "partial building residency inventory was accepted");
rejects(() => parseFunctionalSettlementPlan(mutate(v => { v.placements[0].composition.sha256 = H("9"); }), catalog), /catalog-approved exact composition/, "unapproved composition was accepted");

const accessor = clone(plan) as any;
Object.defineProperty(accessor.placements[0], "yaw", { enumerable: true, get() { throw new Error("getter executed"); } });
rejects(() => parseFunctionalSettlementPlan(accessor, catalog), /enumerable data field/, "accessor was executed or accepted");
const sparse = clone(plan) as any; sparse.placements.length = 2;
rejects(() => parseFunctionalSettlementPlan(sparse, catalog), /dense, field-free/, "sparse placement array was accepted");
const prototyped = clone(plan) as any; Object.setPrototypeOf(prototyped.placements[0].atlasBinding, { hostile: true });
rejects(() => parseFunctionalSettlementPlan(prototyped, catalog), /plain object/, "prototyped Atlas binding was accepted");
const excessive = clone(plan) as any; excessive.placements = Array.from({ length: 257 }, () => clone(placement));
rejects(() => parseFunctionalSettlementPlan(excessive, catalog), /1\.\.256/, "unbounded placement count was accepted");
const duplicate = clone(plan) as any; duplicate.placements = [clone(placement), clone(placement)];
rejects(() => parseFunctionalSettlementPlan(duplicate, catalog), /placementId-sorted and unique/, "duplicate placement was accepted");

const badCatalog = clone(catalog) as any; badCatalog.entries[0].semanticIdentity.exteriorPortals = ["portal/missing"];
rejects(() => parseFunctionalSettlementPlan(plan, badCatalog), /non-portal/, "catalog exterior portal outside its semantic inventory was accepted");

console.log("p_functional_settlement_plan OK: exact catalog/Atlas/site/composition closure, deterministic transformed exterior connectors, atomic whole-building residency, and hostile bounded-shape rejection");
