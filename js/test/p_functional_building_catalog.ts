import {
  FUNCTIONAL_BUILDING_CATALOG_SCHEMA, FUNCTIONAL_BUILDING_LOD_PROOF_SCHEMA, INERT_PROP_DECLARATION_SCHEMA,
  deriveFunctionalBuildingContractHash, deriveFunctionalBuildingSemanticIdentity, parseFunctionalBuildingCatalog,
  verifyFunctionalBuildingCatalogEntry,
} from "../src/assets/functional-building-catalog.mjs";
import { FUNCTIONAL_BUILDING_CONTRACT_V2, parseFunctionalBuildingContract } from "../src/assets/functional-building-contract.ts";
import { sha256 } from "../src/world/sha256.mjs";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`p_functional_building_catalog FAIL: ${message}`); }
function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  try { fn(); } catch (error) { if (pattern.test(error instanceof Error ? error.message : String(error))) return; throw error; }
  throw new Error(`p_functional_building_catalog FAIL: ${message}`);
}
const node = (id: string, role: string, data: Record<string, unknown> = {}) => ({ extras: { limina: { id, role, ...data } } });
const rooms = [
  { id: "room/main", bounds: { center: [0, 1.5, 0], halfExtents: [2, 1.5, 2] }, finishedFloorY: 0, ceilingY: 3, storey: 0,
    visibilityCellId: "cell/main", acoustics: { absorption: .2, reverb: .3 } },
  { id: "room/service", bounds: { center: [4, 1.5, 0], halfExtents: [2, 1.5, 2] }, finishedFloorY: 0, ceilingY: 3, storey: 0,
    visibilityCellId: "cell/service", acoustics: { absorption: .4, reverb: .15 } },
];
const nodes = [
  node("building/root", "root"), node("room/main", "room"), node("room/service", "room"), node("portal/exterior", "portal"), node("portal/service", "portal"),
  ...Array.from({ length: 5 }, (_, index) => node(`collider/${index}`, "collider", { shape: "box", center: [index - 2, 1.5, index % 2 ? 2 : -2], halfExtents: [.15, 1.5, 1] })),
  node("door/service", "door", { roomId: "room/main", portalId: "portal/service", hinge: [2, 1.5, 0], center: [0, 0, 0], halfExtents: [.08, 1, .6], closedYaw: 0, openYaw: -Math.PI / 2 }),
];
nodes[0] = { ...nodes[0], children: nodes.slice(1).map((_, index) => index + 1) } as typeof nodes[number];
const fixture = {
  asset: { version: "2.0", extras: {
    liminaStaticBatch: { schema: "limina.static-batch/1", lodRoots: [20, 21, 22], doorRoot: 23 },
    liminaFunctionalBuilding: {
      schema: FUNCTIONAL_BUILDING_CONTRACT_V2, units: "meter", up: "Y", buildingId: "fixture/catalog-house", rootNodeId: "building/root",
      roomIds: ["room/main", "room/service"], portalIds: ["portal/exterior", "portal/service"], entryAnchor: [-2.5, 0, 0], rooms,
      portals: [
        { id: "portal/exterior", kind: "passage", exterior: true, roomIds: [null, "room/main"], center: [-2, 1.5, 0], halfExtents: [.1, 1, .6], acousticTransmission: .8 },
        { id: "portal/service", kind: "door", exterior: false, roomIds: ["room/main", "room/service"], center: [2, 1.5, 0], halfExtents: [.1, 1, .6], acousticTransmission: .4, doorId: "door/service" },
      ], verticalLinks: [],
      spawnAnchors: [
        { id: "spawn/main", roomId: "room/main", kind: "player", position: [0, 0, 0], direction: [0, 0, 1], clearanceRadius: .35, clearanceHeight: 1.8 },
        { id: "spawn/service", roomId: "room/service", kind: "npc", position: [4, 0, 0], direction: [-1, 0, 0], clearanceRadius: .35, clearanceHeight: 1.8 },
      ], visibilityCells: [
        { id: "cell/main", roomIds: ["room/main"], nodeIds: ["room/main"] },
        { id: "cell/service", roomIds: ["room/service"], nodeIds: ["room/service"] },
      ],
    },
  } }, scene: 0, scenes: [{ nodes: [0] }], nodes,
  animations: [{ name: "door/service/open", channels: [{ target: { node: 10, path: "rotation" } }], samplers: [] }],
};
const bytes = new TextEncoder().encode(JSON.stringify(fixture));
const contract = parseFunctionalBuildingContract(bytes);
assert(contract.schema === FUNCTIONAL_BUILDING_CONTRACT_V2, "fixture is not a v2 functional building");
const semanticIdentity = deriveFunctionalBuildingSemanticIdentity(contract);
const functional = {
  entryId: "building/catalog-house", placementClass: "functional-building",
  asset: { assetId: "buildings/catalog-house.gltf", hashKind: "raw-sha256", hash: `sha256:${sha256(bytes)}`, byteLength: bytes.byteLength },
  variant: { familyId: "house/catalog", variantId: "timber-a" },
  functionalContract: { schema: FUNCTIONAL_BUILDING_CONTRACT_V2, hash: deriveFunctionalBuildingContractHash(contract) }, semanticIdentity,
  lodSemanticIdentity: { schema: FUNCTIONAL_BUILDING_LOD_PROOF_SCHEMA, articulatedDoorPolicy: "shared-outside-static-lods", articulatedDoorRootIndex: 23,
    levels: [20, 21, 22].map((rootIndex, level) => ({ level, rootIndex, semanticFingerprint: semanticIdentity.fingerprint })) },
  compositionPackage: { schema: "limina.exact-composition-package-pointer/v1", artifactId: "composition/catalog-house/r1", path: "authoring/catalog-house/composition-r1.json", sha256: `sha256:${"1".repeat(64)}` },
  productionClosure: { schema: "limina.exact-production-closure-pointer/v1", artifactId: "closure/catalog-house/r1", path: "art-direction/catalog-house-r1.json", sha256: `sha256:${"2".repeat(64)}` },
};
const inert = { entryId: "prop/crate", placementClass: "inert-prop",
  asset: { assetId: "props/crate.glb", hashKind: "engine-content-hash", hash: `sha256:${"3".repeat(64)}`, byteLength: 800 },
  variant: { familyId: "prop/crate", variantId: "oak" }, inert: { schema: INERT_PROP_DECLARATION_SCHEMA, interactive: false, enterable: false } };
const catalog = { schema: FUNCTIONAL_BUILDING_CATALOG_SCHEMA, catalogId: "settlement/core", revision: 1, entries: [functional, inert] };

const parsed = parseFunctionalBuildingCatalog(catalog);
assert(Object.isFrozen(parsed) && Object.isFrozen(parsed.entries) && parsed.entries.length === 2, "catalog was not deeply immutable");
const verified = verifyFunctionalBuildingCatalogEntry(functional, { assetId: functional.asset.assetId, bytes });
assert(verified.contract.buildingId === "fixture/catalog-house" && verified.staticBatch.lodRoots.join(",") === "20,21,22", "exact bytes did not close contract/LOD semantics");
assert(verified.semanticIdentity.fingerprint === semanticIdentity.fingerprint, "verified semantic fingerprint drifted");
const engineFunctional = { ...functional, asset: { ...functional.asset, hashKind: "engine-content-hash", hash: `sha256:${"8".repeat(64)}` } };
assert(verifyFunctionalBuildingCatalogEntry(engineFunctional, { assetId: functional.asset.assetId, bytes, engineContentHash: engineFunctional.asset.hash }).contract.buildingId === contract.buildingId,
  "engine content-addressed asset did not verify");

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const mutate = (fn: (value: any) => void) => { const value = clone(catalog); fn(value); return value; };
rejects(() => parseFunctionalBuildingCatalog(mutate(v => { v.extra = true; })), /unknown field/, "unknown catalog field was accepted");
rejects(() => parseFunctionalBuildingCatalog(mutate(v => { v.entries.reverse(); })), /entryId-sorted/, "unordered entries were accepted");
rejects(() => parseFunctionalBuildingCatalog(mutate(v => { v.entries[1].asset.assetId = v.entries[0].asset.assetId; })), /duplicate asset/, "duplicate asset was accepted");
rejects(() => parseFunctionalBuildingCatalog(mutate(v => { v.entries[1].asset = { ...v.entries[0].asset, assetId: "props/alias.glb" }; })), /duplicate exact asset address/, "duplicate exact asset address was accepted");
rejects(() => parseFunctionalBuildingCatalog(mutate(v => { v.entries[1].variant = clone(v.entries[0].variant); })), /duplicate variant/, "duplicate family variant was accepted");
rejects(() => parseFunctionalBuildingCatalog(mutate(v => { v.entries[0].semanticIdentity.rooms.reverse(); })), /strictly id-sorted/, "unstable semantic inventory was accepted");
rejects(() => parseFunctionalBuildingCatalog(mutate(v => { v.entries[0].semanticIdentity.exteriorPortals = []; })), /1\.\.64/, "functional entry without an exterior portal was accepted");
rejects(() => parseFunctionalBuildingCatalog(mutate(v => { v.entries[0].semanticIdentity.exteriorPortals = ["portal/missing"]; })), /non-portal/, "exterior portal outside the semantic portal inventory was accepted");
rejects(() => parseFunctionalBuildingCatalog(mutate(v => { v.entries[0].lodSemanticIdentity.levels[2].semanticFingerprint = `sha256:${"4".repeat(64)}`; })), /does not preserve/, "LOD semantic drift was accepted");
rejects(() => parseFunctionalBuildingCatalog(mutate(v => { v.entries[0].lodSemanticIdentity.levels[1].rootIndex = 20; })), /duplicate roots/, "duplicate LOD root was accepted");
rejects(() => parseFunctionalBuildingCatalog(mutate(v => { v.entries[0].placementClass = "inert-prop"; })), /unknown field/, "functional contract masquerading as inert prop was accepted");
rejects(() => parseFunctionalBuildingCatalog(mutate(v => { v.entries[1].placementClass = "functional-building"; })), /unknown field/, "inert prop masquerading as functional building was accepted");
rejects(() => parseFunctionalBuildingCatalog(mutate(v => { v.entries[1].inert.interactive = true; })), /must be false/, "interactive inert prop was accepted");
rejects(() => parseFunctionalBuildingCatalog(mutate(v => { v.entries[1].asset.assetId = "props/../buildings/house.glb"; })), /unsafe path segment/, "traversal asset id was accepted");
rejects(() => verifyFunctionalBuildingCatalogEntry(inert, { assetId: inert.asset.assetId, bytes: new Uint8Array(800), engineContentHash: inert.asset.hash }), /cannot be verified/, "inert prop entered functional verification");
rejects(() => verifyFunctionalBuildingCatalogEntry(functional, { assetId: functional.asset.assetId, bytes: bytes.subarray(0, bytes.length - 1) }), /byteLength mismatch/, "truncated bytes were accepted");
rejects(() => verifyFunctionalBuildingCatalogEntry({ ...functional, asset: { ...functional.asset, hash: `sha256:${"5".repeat(64)}` } }, { assetId: functional.asset.assetId, bytes }), /raw asset hash mismatch/, "wrong raw hash was accepted");
rejects(() => verifyFunctionalBuildingCatalogEntry(engineFunctional, { assetId: functional.asset.assetId, bytes }), /engine content hash mismatch/, "unproven engine content hash was accepted");
rejects(() => verifyFunctionalBuildingCatalogEntry({ ...functional, functionalContract: { ...functional.functionalContract, hash: `sha256:${"6".repeat(64)}` } }, { assetId: functional.asset.assetId, bytes }), /contract hash mismatch/, "wrong contract hash was accepted");
rejects(() => verifyFunctionalBuildingCatalogEntry({ ...functional, semanticIdentity: { ...functional.semanticIdentity, fingerprint: `sha256:${"7".repeat(64)}` },
  lodSemanticIdentity: { ...functional.lodSemanticIdentity, levels: functional.lodSemanticIdentity.levels.map(level => ({ ...level, semanticFingerprint: `sha256:${"7".repeat(64)}` })) } },
  { assetId: functional.asset.assetId, bytes }), /semantic identity mismatch/, "wrong semantic fingerprint was accepted");
rejects(() => verifyFunctionalBuildingCatalogEntry({ ...functional, lodSemanticIdentity: { ...functional.lodSemanticIdentity, levels: functional.lodSemanticIdentity.levels.map((level, index) => ({ ...level, rootIndex: 30 + index })) } },
  { assetId: functional.asset.assetId, bytes }), /LOD\/static-batch proof mismatch/, "LOD root drift was accepted");

const getterCatalog = clone(catalog) as any;
Object.defineProperty(getterCatalog.entries[0], "entryId", { enumerable: true, get() { throw new Error("getter executed"); } });
rejects(() => parseFunctionalBuildingCatalog(getterCatalog), /data field/, "accessor field was executed or accepted");
const sparse = clone(catalog) as any; sparse.entries.length = 3;
rejects(() => parseFunctionalBuildingCatalog(sparse), /dense, field-free/, "sparse entry array was accepted");
const excessive = clone(catalog) as any; excessive.entries = Array.from({ length: 513 }, (_, index) => ({ ...inert, entryId: `prop/p${String(index).padStart(3, "0")}`, asset: { ...inert.asset, assetId: `props/p${index}.glb` }, variant: { ...inert.variant, variantId: `v${index}` } }));
rejects(() => parseFunctionalBuildingCatalog(excessive), /1\.\.512/, "unbounded catalog was accepted");

console.log(`p_functional_building_catalog OK: ${parsed.entries.length} strict entries, exact v2 bytes/contract/topology/static-LOD closure, inert-prop discrimination, and hostile bounded-shape rejection`);
