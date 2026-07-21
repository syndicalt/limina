// Production content closure for one immutable biome runtime pack. This is deliberately a pure
// data contract: it proves exactly which licensed, content-addressed assets and acceptance records
// a runtime pack may publish without importing filesystem, network, or renderer capabilities.

import { sha256 } from "./sha256.mjs";

export const BIOME_CONTENT_BUNDLE_SCHEMA = "limina.biome-content-bundle/v1";
export const BIOME_CONTENT_BUNDLE_STATUSES = Object.freeze(["candidate", "accepted"]);
export const BIOME_CONTENT_BUNDLE_KINDS = Object.freeze([
  "surface-wrapper",
  "authoring-recipe",
  "material-pack",
  "texture",
  "population-descriptor",
  "model-source",
  "model-lod",
  "impostor",
  "mechanical-evidence",
  "human-visual-evidence",
]);
export const BIOME_CONTENT_BUNDLE_LICENSES = Object.freeze({
  tierA: Object.freeze(["CC0-1.0", "MIT", "Apache-2.0"]),
  tierB: Object.freeze(["CC-BY-3.0", "CC-BY-4.0"]),
});
export const BIOME_CONTENT_BUNDLE_LIMITS = Object.freeze({
  entries: 4_096,
  idChars: 160,
  versionChars: 64,
  labelChars: 256,
  uriChars: 1_024,
  entryBytes: 512 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024 * 1024,
  canonicalBytes: 4 * 1024 * 1024,
});

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const REF = /^[A-Za-z0-9._/-]+$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const HTTPS = /^https:\/\/[^\s]+$/;
const PRODUCTION_WRAPPER_KINDS = new Set(["surface-wrapper", "population-descriptor"]);

export class BiomeContentBundleValidationError extends Error {
  constructor(message) { super(message); this.name = "BiomeContentBundleValidationError"; }
}

function fail(message) { throw new BiomeContentBundleValidationError(message); }

function record(value, required, optional, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(`${label} must not contain symbol fields`);
  const allowed = new Set([...required, ...optional]);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key)) fail(`${label} has unknown field '${key}'`);
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      fail(`${label}.${key} must be an enumerable data field`);
    }
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label} is missing '${key}'`);
  return descriptors;
}

function dense(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
      || Object.getOwnPropertySymbols(value).length !== 0
      || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    fail(`${label} must be a dense, field-free standard array with at most ${maximum} entries`);
  }
  return value;
}

function string(value, pattern, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function text(value, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value
      || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} is invalid`);
  return value;
}

function assetId(value, label) {
  const parsed = string(value, REF, BIOME_CONTENT_BUNDLE_LIMITS.idChars, label);
  if (parsed.startsWith("/") || parsed.includes("\\")
      || parsed.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail(`${label} contains an unsafe path segment`);
  }
  return parsed;
}

function https(value, label) {
  return string(value, HTTPS, BIOME_CONTENT_BUNDLE_LIMITS.uriChars, label);
}

function byteLength(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0)
      || value < 1 || value > BIOME_CONTENT_BUNDLE_LIMITS.entryBytes) {
    fail(`${label} must be a positive canonical integer no greater than ${BIOME_CONTENT_BUNDLE_LIMITS.entryBytes}`);
  }
  return value;
}

function parseIdentity(value, label) {
  const d = record(value, new Set(["assetId", "contentHash"]), new Set(), label);
  return Object.freeze({
    assetId: assetId(d.assetId.value, `${label}.assetId`),
    contentHash: string(d.contentHash.value, HASH, 71, `${label}.contentHash`),
  });
}

function parseAttribution(value, label) {
  const d = record(value, new Set(["author", "title", "sourceUrl", "licenseUrl", "modified"]), new Set(), label);
  if (typeof d.modified.value !== "boolean") fail(`${label}.modified must be a boolean`);
  return Object.freeze({
    author: text(d.author.value, BIOME_CONTENT_BUNDLE_LIMITS.labelChars, `${label}.author`),
    title: text(d.title.value, BIOME_CONTENT_BUNDLE_LIMITS.labelChars, `${label}.title`),
    sourceUrl: https(d.sourceUrl.value, `${label}.sourceUrl`),
    licenseUrl: https(d.licenseUrl.value, `${label}.licenseUrl`),
    modified: d.modified.value,
  });
}

function parseProvenance(value, label) {
  const d = record(value, new Set(["licenseSpdx", "sourceUri"]), new Set(["attribution"]), label);
  const licenseSpdx = text(d.licenseSpdx.value, 32, `${label}.licenseSpdx`);
  const tierA = BIOME_CONTENT_BUNDLE_LICENSES.tierA.includes(licenseSpdx);
  const tierB = BIOME_CONTENT_BUNDLE_LICENSES.tierB.includes(licenseSpdx);
  if (!tierA && !tierB) fail(`${label}.licenseSpdx '${licenseSpdx}' is not an allowed Tier A or Tier B license`);
  if (tierB && d.attribution === undefined) fail(`${label}.attribution is required for ${licenseSpdx}`);
  const attribution = d.attribution === undefined ? undefined : parseAttribution(d.attribution.value, `${label}.attribution`);
  return Object.freeze({
    licenseSpdx,
    sourceUri: text(d.sourceUri.value, BIOME_CONTENT_BUNDLE_LIMITS.uriChars, `${label}.sourceUri`),
    ...(attribution === undefined ? {} : { attribution }),
  });
}

function parseAcceptance(value, status, label) {
  const d = record(value, new Set(["mechanicalEvidence"]), new Set(["humanVisualEvidence"]), label);
  if (status === "accepted" && d.humanVisualEvidence === undefined) {
    fail(`${label}.humanVisualEvidence is required for an accepted bundle`);
  }
  if (status === "candidate" && d.humanVisualEvidence !== undefined) {
    fail(`${label}.humanVisualEvidence cannot be claimed by a candidate bundle`);
  }
  return Object.freeze({
    mechanicalEvidence: parseIdentity(d.mechanicalEvidence.value, `${label}.mechanicalEvidence`),
    ...(d.humanVisualEvidence === undefined ? {} : {
      humanVisualEvidence: parseIdentity(d.humanVisualEvidence.value, `${label}.humanVisualEvidence`),
    }),
  });
}

function parseEntry(value, index, status) {
  const label = `biome content bundle.entries[${index}]`;
  const d = record(value, new Set(["assetId", "contentHash", "kind", "byteLength", "provenance"]),
    new Set(["acceptance"]), label);
  if (!BIOME_CONTENT_BUNDLE_KINDS.includes(d.kind.value)) fail(`${label}.kind is unsupported`);
  const productionRequired = PRODUCTION_WRAPPER_KINDS.has(d.kind.value);
  if (productionRequired && d.acceptance === undefined) fail(`${label}.acceptance is required for production wrapper kind '${d.kind.value}'`);
  if (!productionRequired && d.acceptance !== undefined) fail(`${label}.acceptance is only valid on production wrapper entries`);
  return Object.freeze({
    assetId: assetId(d.assetId.value, `${label}.assetId`),
    contentHash: string(d.contentHash.value, HASH, 71, `${label}.contentHash`),
    kind: d.kind.value,
    byteLength: byteLength(d.byteLength.value, `${label}.byteLength`),
    provenance: parseProvenance(d.provenance.value, `${label}.provenance`),
    ...(d.acceptance === undefined ? {} : { acceptance: parseAcceptance(d.acceptance.value, status, `${label}.acceptance`) }),
  });
}

function utf8ByteLength(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const codePoint = value.codePointAt(index);
    if (codePoint > 0xffff) index++;
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function parseCore(value, withClosureHash) {
  const required = new Set(["schema", "id", "version", "status", "runtimePack", "entries"]);
  if (withClosureHash) required.add("closureHash");
  const d = record(value, required, new Set(), "biome content bundle");
  if (d.schema.value !== BIOME_CONTENT_BUNDLE_SCHEMA) {
    fail(`biome content bundle.schema must be '${BIOME_CONTENT_BUNDLE_SCHEMA}'`);
  }
  if (!BIOME_CONTENT_BUNDLE_STATUSES.includes(d.status.value)) fail("biome content bundle.status is unsupported");
  const status = d.status.value;
  const runtimePack = parseIdentity(d.runtimePack.value, "biome content bundle.runtimePack");
  const sourceEntries = dense(d.entries.value, BIOME_CONTENT_BUNDLE_LIMITS.entries, "biome content bundle.entries");
  if (sourceEntries.length < 1) fail("biome content bundle.entries must not be empty");
  const entries = Object.freeze(sourceEntries.map((entry, index) => parseEntry(entry, index, status)));
  for (let index = 1; index < entries.length; index++) {
    if (entries[index - 1].assetId >= entries[index].assetId) {
      fail("biome content bundle.entries must be strictly assetId-sorted and unique");
    }
  }
  if (entries.some((entry) => entry.assetId === runtimePack.assetId)) {
    fail("biome content bundle runtime-pack assetId must not collide with a leaf entry");
  }
  const totalBytes = entries.reduce((sum, entry) => sum + entry.byteLength, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > BIOME_CONTENT_BUNDLE_LIMITS.totalBytes) {
    fail(`biome content bundle entry bytes exceed ${BIOME_CONTENT_BUNDLE_LIMITS.totalBytes}`);
  }

  const byId = new Map(entries.map((entry) => [entry.assetId, entry]));
  for (const entry of entries) {
    if (entry.acceptance === undefined) continue;
    for (const [field, expectedKind] of [
      ["mechanicalEvidence", "mechanical-evidence"],
      ["humanVisualEvidence", "human-visual-evidence"],
    ]) {
      const identity = entry.acceptance[field];
      if (identity === undefined) continue;
      const evidence = byId.get(identity.assetId);
      if (evidence === undefined) fail(`${entry.assetId} ${field} does not resolve inside the bundle closure`);
      if (evidence.kind !== expectedKind) fail(`${entry.assetId} ${field} must resolve to kind '${expectedKind}'`);
      if (evidence.contentHash !== identity.contentHash) fail(`${entry.assetId} ${field} contentHash does not match its closure entry`);
    }
  }

  const core = Object.freeze({
    schema: BIOME_CONTENT_BUNDLE_SCHEMA,
    id: string(d.id.value, ID, 64, "biome content bundle.id"),
    version: string(d.version.value, SEMVER, BIOME_CONTENT_BUNDLE_LIMITS.versionChars, "biome content bundle.version"),
    status,
    runtimePack,
    entries,
  });
  const closureBytes = JSON.stringify({ status, runtimePack, entries });
  if (utf8ByteLength(closureBytes) > BIOME_CONTENT_BUNDLE_LIMITS.canonicalBytes) {
    fail(`biome content bundle canonical closure exceeds ${BIOME_CONTENT_BUNDLE_LIMITS.canonicalBytes} bytes`);
  }
  const derivedClosureHash = `sha256:${sha256(closureBytes)}`;
  if (!withClosureHash) return Object.freeze({ core, derivedClosureHash });
  const supplied = string(d.closureHash.value, HASH, 71, "biome content bundle.closureHash");
  if (supplied !== derivedClosureHash) fail("biome content bundle.closureHash does not match its runtime pack and entries");
  return Object.freeze({ core, derivedClosureHash });
}

/** Derive the closure hash for a strict bundle draft that does not yet contain closureHash. */
export function deriveBiomeContentBundleClosureHash(value) {
  return parseCore(value, false).derivedClosureHash;
}

export function parseBiomeContentBundle(value) {
  const parsed = parseCore(value, true);
  return Object.freeze({ ...parsed.core, closureHash: parsed.derivedClosureHash });
}

export function stableStringifyBiomeContentBundle(value) {
  return JSON.stringify(parseBiomeContentBundle(value));
}

export function biomeContentBundleContentHash(value) {
  return `sha256:${sha256(stableStringifyBiomeContentBundle(value))}`;
}
