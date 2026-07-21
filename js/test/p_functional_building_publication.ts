import fs from "node:fs";
import { buildFb4CaptureProvenance } from "../src/render/fb4-capture-provenance.ts";
import {
  FUNCTIONAL_BUILDING_PUBLICATION_SCHEMA,
  assertApprovedFunctionalBuildingPublication,
  deriveApprovedFunctionalBuildingPublication,
  loadApprovedFunctionalBuildingPublication,
} from "../src/assets/functional-building-publication.mjs";
import {
  FUNCTIONAL_SETTLEMENT_ATLAS_REF_SCHEMA,
  FUNCTIONAL_SETTLEMENT_CATALOG_REF_SCHEMA,
  FUNCTIONAL_SETTLEMENT_ENTRY_CONNECTOR_SCHEMA,
  FUNCTIONAL_SETTLEMENT_PLAN_SCHEMA,
  FUNCTIONAL_SETTLEMENT_RESIDENCY_SCHEMA,
  FUNCTIONAL_SETTLEMENT_SITE_REF_SCHEMA,
  deriveFunctionalSettlementPlacementId,
} from "../src/assets/functional-settlement-plan.mjs";
import { createApprovedFunctionalSettlementRuntimeResidency } from "../src/skills/functional-settlement-runtime-residency.ts";
import { portableAssetContentHash } from "../src/world/asset-content-hash.mjs";
import { sha256 } from "../src/world/sha256.mjs";
import { worldMapContentHash } from "../src/world/worldmap.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_functional_building_publication FAIL: ${message}`);
}
function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  try {
    fn();
  } catch (error) {
    if (pattern.test(error instanceof Error ? error.message : String(error))) return;
    throw error;
  }
  throw new Error(`p_functional_building_publication FAIL: ${message}`);
}
const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
const files = new Map<string, Uint8Array>();
const put = (path: string, value: unknown | Uint8Array) => {
  const bytes = value instanceof Uint8Array ? value : encode(value);
  files.set(path, bytes);
  return {
    path,
    sha256: `sha256:${sha256(bytes)}`,
    contentHash: portableAssetContentHash(bytes),
    bytes: bytes.byteLength,
  } as const;
};
const short = <T extends { path: string; sha256: string; contentHash: string }>(file: T) => ({
  path: file.path,
  sha256: file.sha256,
  contentHash: file.contentHash,
});
const read = (path: string): Uint8Array => {
  const bytes = files.get(path);
  if (bytes === undefined) throw new Error(`missing fixture '${path}'`);
  return bytes;
};

// A small but real v2 functional package with compiler-style semantic topology and static LOD roots.
const node = (id: string, role: string, data: Record<string, unknown> = {}) => ({
  extras: { limina: { id, role, ...data } },
});
const nodes: any[] = [
  node("building/root", "root"),
  node("room/main", "room"),
  node("room/service", "room"),
  node("portal/exterior", "portal"),
  node("portal/service", "portal"),
  ...Array.from({ length: 5 }, (_, index) =>
    node(`collider/${index}`, "collider", {
      shape: "box",
      center: [index - 2, 1.5, index % 2 ? 2 : -2],
      halfExtents: [0.15, 1.5, 1],
    }),
  ),
  node("door/service", "door", {
    roomId: "room/main",
    portalId: "portal/service",
    hinge: [2, 1.5, 0],
    center: [0, 0, 0],
    halfExtents: [0.08, 1, 0.6],
    closedYaw: 0,
    openYaw: -Math.PI / 2,
  }),
];
nodes[0] = { ...nodes[0], children: nodes.slice(1).map((_, index) => index + 1) };
const buildingBytes = encode({
  asset: {
    version: "2.0",
    extras: {
      liminaStaticBatch: { schema: "limina.static-batch/1", lodRoots: [20, 21, 22], doorRoot: 23 },
      liminaFunctionalBuilding: {
        schema: "limina.functional-building/v2",
        units: "meter",
        up: "Y",
        buildingId: "fixture/publication-house",
        rootNodeId: "building/root",
        roomIds: ["room/main", "room/service"],
        portalIds: ["portal/exterior", "portal/service"],
        entryAnchor: [-2.5, 0, 0],
        rooms: [
          {
            id: "room/main",
            bounds: { center: [0, 1.5, 0], halfExtents: [2, 1.5, 2] },
            finishedFloorY: 0,
            ceilingY: 3,
            storey: 0,
            visibilityCellId: "cell/main",
            acoustics: { absorption: 0.2, reverb: 0.3 },
          },
          {
            id: "room/service",
            bounds: { center: [4, 1.5, 0], halfExtents: [2, 1.5, 2] },
            finishedFloorY: 0,
            ceilingY: 3,
            storey: 0,
            visibilityCellId: "cell/service",
            acoustics: { absorption: 0.4, reverb: 0.15 },
          },
        ],
        portals: [
          {
            id: "portal/exterior",
            kind: "passage",
            exterior: true,
            roomIds: [null, "room/main"],
            center: [-2, 1.5, 0],
            halfExtents: [0.1, 1, 0.6],
            acousticTransmission: 0.8,
          },
          {
            id: "portal/service",
            kind: "door",
            exterior: false,
            roomIds: ["room/main", "room/service"],
            center: [2, 1.5, 0],
            halfExtents: [0.1, 1, 0.6],
            acousticTransmission: 0.4,
            doorId: "door/service",
          },
        ],
        verticalLinks: [],
        spawnAnchors: [
          {
            id: "spawn/main",
            roomId: "room/main",
            kind: "player",
            position: [0, 0, 0],
            direction: [0, 0, 1],
            clearanceRadius: 0.35,
            clearanceHeight: 1.8,
          },
          {
            id: "spawn/service",
            roomId: "room/service",
            kind: "npc",
            position: [4, 0, 0],
            direction: [-1, 0, 0],
            clearanceRadius: 0.35,
            clearanceHeight: 1.8,
          },
        ],
        visibilityCells: [
          { id: "cell/main", roomIds: ["room/main"], nodeIds: ["room/main"] },
          { id: "cell/service", roomIds: ["room/service"], nodeIds: ["room/service"] },
        ],
      },
    },
  },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes,
  animations: [{ name: "door/service/open", channels: [{ target: { node: 10, path: "rotation" } }], samplers: [] }],
});
const glb = put("assets/fixtures/publication-house-lod.gltf", buildingBytes);
const candidateId = "fixture/publication-house/candidate-r1";
const manifest = put("fixtures/publication/candidate-manifest.json", {
  schema: "limina.fb4-multi-room-production-candidate/v3",
  candidateId,
  status: "cpu-verified-human-pending",
  visualApprovalClaimed: false,
  gpuCaptureAtBuild: false,
  placementSkill: "building.placeFunctional",
  files: [{ role: "lodGlb", ...glb }],
});

// Build a complete two-entry append-only review ledger: central pass followed by an exact v2 HITL approval.
const environmentAuthority = put("fixtures/publication/environment.json", { schema: "fixture.environment/v1" });
const runtimeBundle = put("fixtures/publication/runtime.js", new TextEncoder().encode("export const runtime=true;\n"));
const binary = put("fixtures/publication/limina", new Uint8Array([1, 2, 3, 4]));
const sourceA = put("fixtures/publication/source-a.ts", new Uint8Array([1]));
const sourceB = put("fixtures/publication/source-b.ts", new Uint8Array([2]));
const sourceC = put("fixtures/publication/source-c.ts", new Uint8Array([3]));
const png = put("fixtures/publication/exterior.png", new Uint8Array([137, 80, 78, 71]));
const reviewAuthority = put("fixtures/publication/review-authority.json", {
  candidate: { manifest: short(manifest), glb: short(glb), irHash: `sha256:${"1".repeat(64)}` },
  environment: { authority: short(environmentAuthority), runtimeBundle: short(runtimeBundle) },
});
const capture = put("fixtures/publication/capture.json", {
  authority: short(reviewAuthority),
  candidate: { manifest: short(manifest) },
  outputs: [
    {
      id: "exterior",
      path: png.path,
      width: 1,
      height: 1,
      pngSha256: png.sha256,
      pngByteLength: png.bytes,
      rgbaContentHash: `sha256:${"2".repeat(64)}`,
    },
  ],
});
const provenance = put(
  "fixtures/publication/capture-provenance.json",
  buildFb4CaptureProvenance({
    captureEvidence: short(capture),
    trace: { sha256: `sha256:${"3".repeat(64)}`, byteLength: 1 },
    subject: {
      candidateId,
      manifest: short(manifest),
      glb: { ...short(glb), bytes: glb.bytes },
      reviewAuthority: short(reviewAuthority),
      irHash: `sha256:${"1".repeat(64)}`,
    },
    environment: {
      authority: short(environmentAuthority),
      runtimeBundle: short(runtimeBundle),
      shot: "fixture",
      context: "publication-proof",
    },
    execution: {
      binary: { ...short(binary), bytes: binary.bytes },
      orchestrator: { kind: "bun", version: "1.2.0", sha256: `sha256:${"4".repeat(64)}`, bytes: 1 },
      entrySources: [sourceA.path, sourceB.path, sourceC.path],
      sources: [sourceA, sourceB, sourceC],
      argv: ["limina", "fixture"],
      platform: { arch: "arm64", os: "linux" },
      timestampEnvironmentKeys: [],
    },
    gpuSafety: {
      bootId: "12345678-1234-1234-1234-123456789abc",
      timestampQueriesEnabled: false,
      xidObserved: false,
      preflightSource: "journalctl-kernel-current-boot",
      liveFollower: "journalctl-kernel-follow-current-boot",
      redundantPollMs: 250,
      postflightSource: "journalctl-kernel-current-boot",
    },
    outputs: [
      {
        id: "exterior",
        path: png.path,
        width: 1,
        height: 1,
        pngSha256: png.sha256,
        pngByteLength: png.bytes,
        rgbaContentHash: `sha256:${"2".repeat(64)}`,
      },
    ],
  }),
);
const central = put("fixtures/publication/central-review.json", {
  schema: "limina.fb4-central-visual-review/v1",
  status: "passed-to-hitl",
  candidateId,
  captureEvidence: { path: capture.path, sha256: capture.sha256 },
  gpuSafety: { timestampQueriesEnabled: false, xidObserved: false },
  reviewBridgeStaged: false,
  visualFloor: { referenceSetId: "project-gorgon/house/v1", passed: true },
  findings: [],
  retainedProof: [],
});
const presentationBody = {
  schema: "limina.building-stage-artifact/v1",
  artifactId: "presentation/publication-house/r1",
  kind: "presentation-review",
  revision: 1,
  status: "candidate",
  contractHash: `sha256:${"5".repeat(64)}`,
  contentHash: `sha256:${"6".repeat(64)}`,
  facets: [{ scope: "evidence-contract", hash: `sha256:${"7".repeat(64)}` }],
  inputs: [],
  evidence: [
    { evidenceId: "exterior", kind: "engine-capture", contentHash: `sha256:${"2".repeat(64)}`, width: 1, height: 1 },
  ],
};
const presentation = put("fixtures/publication/presentation.json", presentationBody);
const decision = put("fixtures/publication/hitl-decision.json", {
  schema: "limina.building-hitl-decision/v2",
  decisionId: "decision/publication-house/r1",
  gate: "R1-release",
  artifactId: presentationBody.artifactId,
  contractHash: presentationBody.contractHash,
  contentHash: presentationBody.contentHash,
  reviewer: "owner",
  timestamp: "2026-07-17T12:00:00.000Z",
  decision: "approve",
  evidenceBindings: [{ evidenceId: "exterior", contentHash: `sha256:${"2".repeat(64)}` }],
  blockingFindings: [],
  observations: [],
  markedRegions: [],
});
const subject = {
  candidateId,
  candidateManifest: short(manifest),
  reviewAuthority: short(reviewAuthority),
  captureEvidence: short(capture),
  captureProvenance: { ...short(provenance), coverage: "complete" },
};
const centralEntry = put("fixtures/publication/ledger-01-central.json", {
  schema: "limina.building-review-ledger-entry/v1",
  sequence: 1,
  entryId: "review/publication-house/central-r1",
  previous: null,
  subject,
  event: {
    kind: "central-visual-review",
    record: { ...short(central), schema: "limina.fb4-central-visual-review/v1" },
  },
});
const approvedEntry = put("fixtures/publication/ledger-02-approved.json", {
  schema: "limina.building-review-ledger-entry/v1",
  sequence: 2,
  entryId: "review/publication-house/approved-r1",
  previous: short(centralEntry),
  subject,
  event: {
    kind: "hitl-decision",
    presentationArtifact: short(presentation),
    record: { ...short(decision), schema: "limina.building-hitl-decision/v2" },
  },
});

const publicationInput = {
  publicationId: "publication/publication-house/r1",
  catalogId: "settlement/approved-core",
  catalogRevision: 1,
  entryId: "building/publication-house",
  familyId: "house/multi-room",
  variantId: "cross-gable-a",
  candidateManifest: manifest,
  approvedReviewOutcome: approvedEntry,
  reviewLedger: [centralEntry, approvedEntry].sort((a, b) => a.path.localeCompare(b.path)),
};
const publication = deriveApprovedFunctionalBuildingPublication(publicationInput, read);
assert(
  publication.schema === FUNCTIONAL_BUILDING_PUBLICATION_SCHEMA && publication.approval.status === "approved",
  "approved review did not produce a typed publication",
);
assert(
  publication.catalog.entries.length === 1 && publication.catalog.entries[0].asset.hash === glb.sha256,
  "publication did not derive the manifest-pinned LOD asset",
);
assert(
  publication.catalog.entries[0].semanticIdentity.rooms.join(",") === "room/main,room/service" &&
    publication.catalog.entries[0].lodSemanticIdentity.levels.length === 3,
  "publication lost functional topology or LOD identity",
);
assert(
  publication.catalog.entries[0].productionClosure.path === approvedEntry.path,
  "catalog did not retain exact HITL outcome closure",
);
assert(
  assertApprovedFunctionalBuildingPublication(publication) === publication,
  "in-process publication brand was not retained",
);
const persisted = encode(publication),
  reloaded = loadApprovedFunctionalBuildingPublication(persisted, read);
assert(
  assertApprovedFunctionalBuildingPublication(reloaded) === reloaded &&
    reloaded.closureHash === publication.closureHash,
  "persisted publication did not independently re-derive and restore its approval brand",
);
rejects(
  () => assertApprovedFunctionalBuildingPublication(JSON.parse(JSON.stringify(publication))),
  /not a verified in-process approval/,
  "deserialized publication lookalike was accepted",
);
let getterRan = false;
const hostile: any = {};
Object.defineProperty(hostile, "catalog", {
  get() {
    getterRan = true;
    throw new Error("getter ran");
  },
});
rejects(
  () => assertApprovedFunctionalBuildingPublication(hostile),
  /not a verified in-process approval/,
  "hostile publication lookalike was accepted",
);
assert(!getterRan, "publication brand check executed a hostile catalog getter");
rejects(
  () => assertApprovedFunctionalBuildingPublication(publication, { ...publication.catalog, revision: 2 }),
  /catalog drifted/,
  "catalog substitution escaped approval closure",
);
rejects(
  () => deriveApprovedFunctionalBuildingPublication({ ...publicationInput, approvedReviewOutcome: centralEntry }, read),
  /approval|approved review outcome/,
  "central pass was treated as HITL approval",
);

// Production admission proof: the approval brand is checked before Atlas parsing or any runtime
// call, then that exact publication can drive one bounded whole-building residency transaction.
const publishedEntry: any = publication.catalog.entries[0],
  planId = "settlement/publication-proof",
  anchorId = "anchor/publication-house",
  position = [100, 0, 200] as const,
  yaw = 0,
  localAnchor = [-2.5, 0, 0] as const,
  routeContact = [97.5, 0, 200] as const;
const worldMap: any = {
  version: 1,
  id: "atlas/publication-proof",
  unitsPerMeter: 1,
  origin: [0, 0],
  extent: { w: 1000, h: 1000 },
  seaLevel: 0,
  land: [],
  relief: [],
  biomes: [],
  waterways: [],
  routes: [
    {
      id: "route/main",
      points: [
        [97.5, 199],
        [97.5, 201],
      ],
      class: "road",
    },
  ],
  anchors: [{ id: anchorId, kind: "asset", position: [position[0], position[2]], rot: yaw, source: "map" }],
  provenance: { tool: "design-space", contentHash: "pending" },
};
worldMap.provenance.contentHash = worldMapContentHash(worldMap);
const worldMapHash = `sha256:${worldMap.provenance.contentHash}`,
  placementId = deriveFunctionalSettlementPlacementId(planId, anchorId, publishedEntry.entryId);
const plan: any = {
  schema: FUNCTIONAL_SETTLEMENT_PLAN_SCHEMA,
  planId,
  catalog: {
    schema: FUNCTIONAL_SETTLEMENT_CATALOG_REF_SCHEMA,
    catalogId: publication.catalog.catalogId,
    revision: publication.catalog.revision,
  },
  atlas: { schema: FUNCTIONAL_SETTLEMENT_ATLAS_REF_SCHEMA, worldMapHash, mapId: worldMap.id },
  placements: [
    {
      placementId,
      catalogEntryId: publishedEntry.entryId,
      catalogContractHash: publishedEntry.functionalContract.hash,
      semanticFingerprint: publishedEntry.semanticIdentity.fingerprint,
      position: [...position],
      yaw,
      atlasBinding: { anchorId, routeId: "route/main", anchorPosition: [...position], anchorYaw: yaw },
      entryConnector: {
        schema: FUNCTIONAL_SETTLEMENT_ENTRY_CONNECTOR_SCHEMA,
        kind: "exterior-entry",
        portalId: "portal/exterior",
        localAnchor: [...localAnchor],
        localOutward: [-1, 0],
        routeContact: [...routeContact],
        worldOutward: [-1, 0],
      },
      siteFoundation: {
        schema: FUNCTIONAL_SETTLEMENT_SITE_REF_SCHEMA,
        artifactId: "site/publication-house",
        path: "sites/publication-house.json",
        sha256: `sha256:${"8".repeat(64)}`,
      },
      residency: {
        schema: FUNCTIONAL_SETTLEMENT_RESIDENCY_SCHEMA,
        unitId: "residency/publication-house",
        policy: "whole-building-atomic",
        cellIds: [...publishedEntry.semanticIdentity.cells],
      },
    },
  ],
};
const handles = new Map<string, any>();
let runtimeCalls = 0;
const registry: any = {
  async invoke(name: string, value: any) {
    runtimeCalls++;
    if (name === "settlement.placeFunctional") {
      handles.set(value.settlementId, { buildings: [{ placementId: value.placementIds[0] }] });
      return { success: true, result: { buildingsPlaced: 1 } };
    }
    if (name === "settlement.destroyFunctional") {
      handles.delete(value.settlementId);
      return { success: true, result: { buildingsRemoved: 1 } };
    }
    throw new Error(`unexpected skill ${name}`);
  },
};
const placementManager: any = { get: (id: string) => handles.get(id), has: (id: string) => handles.has(id) };
const runtimeInput = {
  namespace: "proof/approved",
  plan,
  worldMap,
  loadDistance: 4,
  keepDistance: 8,
  maxActiveUnits: 1,
  maxResidentBytes: glb.bytes,
  invokeBase: () => ({}) as any,
};
rejects(
  () =>
    createApprovedFunctionalSettlementRuntimeResidency(registry, placementManager, {
      ...runtimeInput,
      publication: JSON.parse(JSON.stringify(publication)),
    }),
  /not a verified in-process approval/,
  "deserialized publication reached production residency",
);
assert(runtimeCalls === 0 && handles.size === 0, "unapproved residency admission mutated runtime state");
const approvedResidency = createApprovedFunctionalSettlementRuntimeResidency(registry, placementManager, {
  ...runtimeInput,
  publication,
});
assert(runtimeCalls === 0 && handles.size === 0, "approved residency constructor mutated before bounded interest");
const resident = await approvedResidency.update(position);
assert(
  resident.residentUnitIds.join(",") === "residency/publication-house" && runtimeCalls === 1 && handles.size === 1,
  "approved publication did not load one complete runtime building",
);
const retired = await approvedResidency.update([900, 0, 900]);
assert(
  retired.residentUnitIds.length === 0 && runtimeCalls === 2 && handles.size === 0,
  "approved publication residency did not atomically unload its building",
);
await approvedResidency.close();

// The exact current FB4 V3 candidate is now approved. Only its complete central-pass -> HITL
// ledger may derive the publication; the central prefix and unrelated historical records stay closed.
const currentRoot = "assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-v3-1f375ec3abe1";
const currentManifestBytes = fs.readFileSync(`${currentRoot}/candidate-manifest.json`),
  currentManifest = {
    path: `${currentRoot}/candidate-manifest.json`,
    sha256: `sha256:${sha256(currentManifestBytes)}`,
    contentHash: portableAssetContentHash(currentManifestBytes),
    bytes: currentManifestBytes.byteLength,
  };
const diskRead = (path: string) => fs.readFileSync(path);
const diskExact = (path: string) => {
    const bytes = diskRead(path);
    return {
      path,
      sha256: `sha256:${sha256(bytes)}`,
      contentHash: portableAssetContentHash(bytes),
      bytes: bytes.byteLength,
    };
  },
  currentCentral = diskExact(
    "assets/buildings/authoring/functional-hall-house-v4/review-outcomes/fb4-1f375ec3abe1-v4-r1-central-passed.json",
  ),
  currentApproved = diskExact(
    "assets/buildings/authoring/functional-hall-house-v4/review-outcomes/fb4-1f375ec3abe1-v4-r1-hitl-approved.json",
  ),
  currentInput = {
    publicationId: "publication/functional-hall-house/fb4-v3-r1",
    catalogId: "settlement/functional-buildings",
    catalogRevision: 1,
    entryId: "building/functional-hall-house-fb4",
    familyId: "house/functional-hall",
    variantId: "fb4-v3-cross-gable",
    candidateManifest: currentManifest,
    approvedReviewOutcome: currentApproved,
    reviewLedger: [currentCentral, currentApproved].sort((a, b) => a.path.localeCompare(b.path)),
  };
const currentPublication = deriveApprovedFunctionalBuildingPublication(currentInput, diskRead),
  persistedCurrent = loadApprovedFunctionalBuildingPublication(
    diskRead("assets/buildings/catalog/functional-hall-house-fb4-v3-r1.json"),
    diskRead,
  );
assert(
  currentPublication.approval.status === "approved" &&
    currentPublication.closureHash === "sha256:25dd7c2236726b595e11963877bee990c967191b97a5d5a2f4a2f23c63d95ced" &&
    persistedCurrent.closureHash === currentPublication.closureHash,
  "current owner-approved ledger did not reproduce the shipped publication",
);
rejects(
  () =>
    deriveApprovedFunctionalBuildingPublication(
      { ...currentInput, approvedReviewOutcome: currentCentral, reviewLedger: [currentCentral] },
      diskRead,
    ),
  /requires explicit HITL approval|current review state/,
  "central pass alone entered the settlement catalog",
);
const historical = diskExact(
  "assets/buildings/authoring/functional-hall-house-v4/review-outcomes/fb4-1b4470041e01-r1-central-rejected.json",
);
rejects(
  () =>
    deriveApprovedFunctionalBuildingPublication(
      { ...currentInput, approvedReviewOutcome: historical, reviewLedger: [historical] },
      diskRead,
    ),
  /candidate|approval|review/,
  "unrelated historical review authorized the current candidate",
);

console.log(
  "p_functional_building_publication OK: exact V4 R1 HITL ledger reproduces the shipped v2 LOD catalog; only branded approvals reach bounded runtime residency; central-only, unrelated, forged, and drifted authority fails closed",
);
