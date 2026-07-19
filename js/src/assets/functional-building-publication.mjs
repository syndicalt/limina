// FB-5 release boundary between an authored/reviewed building candidate and the runtime catalog.
// A mechanically valid GLB is deliberately insufficient: the exact append-only review ledger must
// resolve the manifest-pinned candidate to an explicit HITL approval before this module will derive
// a catalog revision. The returned object is process-branded so production adapters cannot accept a
// caller-shaped lookalike in place of the verified publication result.

import {
  FUNCTIONAL_BUILDING_CATALOG_SCHEMA,
  FUNCTIONAL_BUILDING_LOD_PROOF_SCHEMA,
  deriveFunctionalBuildingContractHash,
  deriveFunctionalBuildingSemanticIdentity,
  parseFunctionalBuildingCatalog,
  verifyFunctionalBuildingCatalogEntry,
} from "./functional-building-catalog.mjs";
import {
  resolveBuildingReviewState,
  verifyBuildingReviewLedger,
} from "./building-review-outcome.ts";
import { parseFunctionalBuildingContract } from "./functional-building-contract.ts";
import { parseFunctionalBuildingStaticBatch } from "../skills/functional-building-lod.ts";
import { canonicalCompilerJson } from "../world/compiler/canonical.mjs";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { sha256 } from "../world/sha256.mjs";

export const FUNCTIONAL_BUILDING_PUBLICATION_SCHEMA = "limina.functional-building-publication/v1";

const HASH = /^sha256:[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._/-]{0,159}$/;
const PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,511}$/;
const VERIFIED = new WeakSet();

export class FunctionalBuildingPublicationError extends Error {
  constructor(message) { super(message); this.name = "FunctionalBuildingPublicationError"; }
}
const fail = (message) => { throw new FunctionalBuildingPublicationError(message); };
const rawHash = (bytes) => `sha256:${sha256(bytes)}`;

function record(value, required, optional, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${label} must not contain symbol fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value), allowed = new Set([...required, ...optional]);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key)) fail(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor) || descriptor.enumerable !== true) fail(`${label}.${key} must be an enumerable data field`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label} is missing '${key}'`);
  return descriptors;
}
function text(value, pattern, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}
function id(value, label) {
  const output = text(value, ID, 160, label);
  if (output.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) fail(`${label} contains an unsafe path segment`);
  return output;
}
function exactFile(value, label) {
  const d = record(value, new Set(["path", "sha256", "contentHash", "bytes"]), new Set(), label);
  const bytes = d.bytes.value;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 2 ** 32 - 1) fail(`${label}.bytes is outside its bounded integer range`);
  return Object.freeze({
    path: text(d.path.value, PATH, 512, `${label}.path`),
    sha256: text(d.sha256.value, HASH, 71, `${label}.sha256`),
    contentHash: text(d.contentHash.value, HASH, 71, `${label}.contentHash`),
    bytes,
  });
}
function denseArray(value, minimum, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > maximum
      || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    fail(`${label} must be a dense, field-free array with ${minimum}..${maximum} entries`);
  }
  return value;
}
function readExact(file, read, label) {
  let bytes;
  try { bytes = read(file.path); } catch (error) { fail(`${label} could not be read: ${error instanceof Error ? error.message : String(error)}`); }
  if (!(bytes instanceof Uint8Array)) fail(`${label} reader did not return Uint8Array`);
  if (bytes.byteLength !== file.bytes || rawHash(bytes) !== file.sha256 || portableAssetContentHash(bytes) !== file.contentHash) fail(`${label} exact bytes drifted`);
  return bytes;
}
function decode(bytes, label) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (error) { fail(`${label} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`); }
}
function sameExact(left, right) {
  return left.path === right.path && left.sha256 === right.sha256 && left.contentHash === right.contentHash;
}
function deepFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreeze));
  if (value !== null && typeof value === "object") {
    const output = {}; for (const [key, entry] of Object.entries(value)) output[key] = deepFreeze(entry);
    return Object.freeze(output);
  }
  return value;
}

/**
 * Verify exact candidate bytes and its complete review ledger, then derive the only catalog entry
 * that may be published for that approval. An empty/pending/rejected ledger fails before a catalog
 * object is returned. `assetRole` is intentionally locked to the manifest's semantic LOD package.
 */
export function deriveApprovedFunctionalBuildingPublication(input, read) {
  if (typeof read !== "function") fail("functional building publication requires an exact file reader");
  const d = record(input,
    new Set(["publicationId", "catalogId", "catalogRevision", "entryId", "familyId", "variantId", "candidateManifest", "approvedReviewOutcome", "reviewLedger"]),
    new Set(), "functional building publication input");
  const publicationId = id(d.publicationId.value, "functional building publication input.publicationId");
  const catalogId = id(d.catalogId.value, "functional building publication input.catalogId");
  const catalogRevision = d.catalogRevision.value;
  if (!Number.isSafeInteger(catalogRevision) || catalogRevision < 1 || catalogRevision > 2 ** 31 - 1) fail("functional building publication input.catalogRevision is invalid");
  const entryId = id(d.entryId.value, "functional building publication input.entryId");
  const familyId = id(d.familyId.value, "functional building publication input.familyId");
  const variantId = id(d.variantId.value, "functional building publication input.variantId");
  const candidateManifest = exactFile(d.candidateManifest.value, "functional building publication input.candidateManifest");
  const approvedReviewOutcome = exactFile(d.approvedReviewOutcome.value, "functional building publication input.approvedReviewOutcome");
  const reviewLedger = denseArray(d.reviewLedger.value, 1, 64, "functional building publication input.reviewLedger")
    .map((value, index) => exactFile(value, `functional building publication input.reviewLedger[${index}]`));
  for (let index = 1; index < reviewLedger.length; index++) if (reviewLedger[index - 1].path >= reviewLedger[index].path) fail("functional building publication review ledger must be strictly path-sorted and unique");
  const approvedIndex = reviewLedger.findIndex((entry) => sameExact(entry, approvedReviewOutcome));
  if (approvedIndex < 0) fail("approved review outcome is absent from the supplied exact ledger");

  const manifest = decode(readExact(candidateManifest, read, "candidate manifest"), "candidate manifest");
  if (!manifest?.candidateId || manifest.status !== "cpu-verified-human-pending" || manifest.visualApprovalClaimed !== false
      || manifest.gpuCaptureAtBuild !== false || manifest.placementSkill !== "building.placeFunctional") {
    fail("candidate manifest is not an exact CPU-verified, engine-review-pending functional candidate");
  }
  const records = reviewLedger.map((entry) => ({ path: entry.path, bytes: readExact(entry, read, `review ledger '${entry.path}'`) }));
  let verified;
  try { verified = verifyBuildingReviewLedger(records, read); }
  catch (error) { fail(`functional building review ledger rejected: ${error instanceof Error ? error.message : String(error)}`); }
  const state = resolveBuildingReviewState(manifest, verified);
  if (state.reviewStatus !== "approved" || state.outcome?.event.kind !== "hitl-decision") {
    fail(`functional building publication requires explicit HITL approval; current review state is '${state.reviewStatus}'`);
  }
  const latest = verified.filter((entry) => entry.entry.subject.candidateId === manifest.candidateId).at(-1);
  if (latest === undefined || latest.decision !== "approved" || latest.path !== approvedReviewOutcome.path
      || rawHash(latest.bytes) !== approvedReviewOutcome.sha256 || portableAssetContentHash(latest.bytes) !== approvedReviewOutcome.contentHash) {
    fail("approved review outcome is not the latest exact approved ledger entry for this candidate");
  }
  if (!sameExact(state.outcome.subject.candidateManifest, candidateManifest)) fail("approved review outcome does not bind the publication candidate manifest");

  if (!Array.isArray(manifest.files)) fail("candidate manifest has no exact file inventory");
  const lodFiles = manifest.files.filter((entry) => entry?.role === "lodGlb");
  if (lodFiles.length !== 1) fail("candidate manifest must contain exactly one semantic LOD GLB");
  const lodFile = exactFile({ path: lodFiles[0].path, sha256: lodFiles[0].sha256,
    contentHash: lodFiles[0].contentHash, bytes: lodFiles[0].bytes }, "candidate manifest lodGlb");
  const assetBytes = readExact(lodFile, read, "candidate semantic LOD GLB");
  let contract, batch;
  try { contract = parseFunctionalBuildingContract(assetBytes); batch = parseFunctionalBuildingStaticBatch(assetBytes); }
  catch (error) { fail(`candidate semantic LOD GLB rejected: ${error instanceof Error ? error.message : String(error)}`); }
  if (contract.schema !== "limina.functional-building/v2" || batch === undefined) fail("published settlement buildings require a v2 functional contract and static LOD package");
  const semanticIdentity = deriveFunctionalBuildingSemanticIdentity(contract);
  const assetId = lodFile.path.startsWith("assets/") ? lodFile.path.slice("assets/".length) : lodFile.path;
  const entry = {
    entryId,
    placementClass: "functional-building",
    asset: { assetId, hashKind: "raw-sha256", hash: lodFile.sha256, byteLength: lodFile.bytes },
    variant: { familyId, variantId },
    functionalContract: { schema: "limina.functional-building/v2", hash: deriveFunctionalBuildingContractHash(contract) },
    semanticIdentity,
    lodSemanticIdentity: {
      schema: FUNCTIONAL_BUILDING_LOD_PROOF_SCHEMA,
      articulatedDoorPolicy: "shared-outside-static-lods",
      articulatedDoorRootIndex: batch.doorRoot,
      levels: batch.lodRoots.map((rootIndex, level) => ({ level, rootIndex, semanticFingerprint: semanticIdentity.fingerprint })),
    },
    productionClosure: {
      schema: "limina.exact-production-closure-pointer/v1",
      artifactId: state.outcome.entryId,
      path: approvedReviewOutcome.path,
      sha256: approvedReviewOutcome.sha256,
    },
  };
  const catalog = parseFunctionalBuildingCatalog({ schema: FUNCTIONAL_BUILDING_CATALOG_SCHEMA, catalogId, revision: catalogRevision, entries: [entry] });
  verifyFunctionalBuildingCatalogEntry(catalog.entries[0], { assetId, bytes: assetBytes });
  const catalogHash = rawHash(new TextEncoder().encode(canonicalCompilerJson(catalog)));
  const body = {
    schema: FUNCTIONAL_BUILDING_PUBLICATION_SCHEMA,
    publicationId,
    candidateId: manifest.candidateId,
    candidateManifest,
    approval: {
      status: "approved",
      reviewOutcome: approvedReviewOutcome,
      reviewLedger: Object.freeze(reviewLedger),
      decision: deepFreeze(state.outcome.event.record),
    },
    asset: lodFile,
    catalog,
    catalogHash,
  };
  const result = deepFreeze({ ...body, closureHash: rawHash(new TextEncoder().encode(canonicalCompilerJson(body))) });
  VERIFIED.add(result);
  return result;
}

/**
 * Re-verify a persisted publication artifact from bytes. Deserialization alone never restores the
 * in-process approval brand: this replays the exact manifest/ledger/LOD derivation and requires the
 * persisted artifact to equal that independently derived result in canonical JSON.
 */
export function loadApprovedFunctionalBuildingPublication(bytes, read) {
  if (!(bytes instanceof Uint8Array)) fail("persisted functional building publication must be Uint8Array");
  const value = decode(bytes, "persisted functional building publication");
  const d = record(value,
    new Set(["schema", "publicationId", "candidateId", "candidateManifest", "approval", "asset", "catalog", "catalogHash", "closureHash"]),
    new Set(), "persisted functional building publication");
  if (d.schema.value !== FUNCTIONAL_BUILDING_PUBLICATION_SCHEMA) fail("persisted functional building publication schema is unsupported");
  const approval = record(d.approval.value, new Set(["status", "reviewOutcome", "reviewLedger", "decision"]), new Set(), "persisted functional building publication.approval");
  if (approval.status.value !== "approved") fail("persisted functional building publication is not approved");
  const catalog = parseFunctionalBuildingCatalog(d.catalog.value);
  if (catalog.entries.length !== 1 || catalog.entries[0].placementClass !== "functional-building") fail("persisted functional building publication must contain exactly one functional entry");
  const entry = catalog.entries[0];
  const derived = deriveApprovedFunctionalBuildingPublication({
    publicationId: d.publicationId.value,
    catalogId: catalog.catalogId,
    catalogRevision: catalog.revision,
    entryId: entry.entryId,
    familyId: entry.variant.familyId,
    variantId: entry.variant.variantId,
    candidateManifest: d.candidateManifest.value,
    approvedReviewOutcome: approval.reviewOutcome.value,
    reviewLedger: approval.reviewLedger.value,
  }, read);
  if (canonicalCompilerJson(value) !== canonicalCompilerJson(derived)) fail("persisted functional building publication drifted from independently re-derived approval closure");
  return derived;
}

/** Reject forged/deserialized lookalikes and catalog drift at production integration boundaries. */
export function assertApprovedFunctionalBuildingPublication(value, catalogValue) {
  if (value === null || typeof value !== "object" || !VERIFIED.has(value) || value.schema !== FUNCTIONAL_BUILDING_PUBLICATION_SCHEMA || value.approval?.status !== "approved") {
    fail("functional building publication is not a verified in-process approval result");
  }
  const catalog = parseFunctionalBuildingCatalog(catalogValue === undefined ? value.catalog : catalogValue);
  const actual = rawHash(new TextEncoder().encode(canonicalCompilerJson(catalog)));
  if (actual !== value.catalogHash || canonicalCompilerJson(catalog) !== canonicalCompilerJson(value.catalog)) fail("functional building publication catalog drifted from its approved closure");
  return value;
}
