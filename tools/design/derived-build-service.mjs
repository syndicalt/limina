#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { compilerContentHash } from "../../js/src/world/compiler/canonical.mjs";
import { derivedGlobalArtifacts } from "../../js/src/world/compiler/manifest.mjs";
import { DerivedBuildCoordinator } from "./derived-build-coordinator.mjs";
import { DerivedRuntimeServer } from "./derived-runtime-server.mjs";
import {
  publishDerivedRevision,
  readPublishedDerivedRevision,
  verifyPublishedDerivedArtifacts,
} from "./derived-publisher.mjs";
import { EditorBridgeClient, editorClientConfigFromEnvironment } from "../bridge/editor-client.mjs";
import { loadProjectConfig } from "../project-config.mjs";
import { ProjectAssetStore } from "../project-asset-store.mjs";
import { parseTerrainEditLayer } from "../../js/src/terrain/edit-layer.mjs";
import { canonicalMapDocText } from "../../js/src/world/mapdoc-canonical.mjs";
import { persistMapDocSource, validateAuthoringProjectStateCommit } from "./atlas-source-bridge.mjs";
import { compileWorldTerrainInWorker } from "./world-compiler-worker.mjs";

export const DERIVED_BUILD_SERVICE_STATUS_SCHEMA = "limina.derived-build-service-status/v1";
export const DEFAULT_DERIVED_BUILD_POLL_MS = 500;
export const MIN_DERIVED_BUILD_POLL_MS = 100;
export const MAX_DERIVED_BUILD_POLL_MS = 60_000;
export const DEFAULT_DERIVED_BUILD_BRANCH = "main";
export const DERIVED_RUNTIME_DISCOVERY_SCHEMA = "limina.derived-runtime-discovery/v1";

const HASH = /^sha256:[0-9a-f]{64}$/;
const COMPILER_VERSION = /^[0-9][A-Za-z0-9._+-]{0,63}$/;
const BRANCH_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const ASSET_SEGMENT = /^[A-Za-z0-9._-]+$/;
const TERRAIN_LAYER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_AUTHORITY_EDIT_LAYERS = 256;
const MAX_COMPILED_EDIT_LAYERS = 64;
const MAX_RETAINED_COMPILE_METADATA = 32;
const DERIVED_RUNTIME_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function derivedRuntimeConfigurationFromEnvironment(environment = process.env) {
  const portText = environment.LIMINA_DERIVED_RUNTIME_PORT;
  if (typeof portText !== "string" || !/^[1-9][0-9]{0,4}$/.test(portText)) {
    throw new DerivedBuildServiceError("INVALID_RUNTIME_CONFIG", "LIMINA_DERIVED_RUNTIME_PORT must be a canonical TCP port");
  }
  const port = Number(portText);
  if (port > 65_535 || String(port) !== portText) {
    throw new DerivedBuildServiceError("INVALID_RUNTIME_CONFIG", "LIMINA_DERIVED_RUNTIME_PORT must be a canonical TCP port");
  }

  const tokenText = environment.LIMINA_DERIVED_RUNTIME_TOKEN;
  if (typeof tokenText !== "string" || !DERIVED_RUNTIME_TOKEN.test(tokenText)) {
    throw new DerivedBuildServiceError("INVALID_RUNTIME_CONFIG", "LIMINA_DERIVED_RUNTIME_TOKEN must encode exactly 32 random bytes");
  }
  const token = Buffer.from(tokenText, "base64url");
  if (token.byteLength !== 32 || token.toString("base64url") !== tokenText) {
    throw new DerivedBuildServiceError("INVALID_RUNTIME_CONFIG", "LIMINA_DERIVED_RUNTIME_TOKEN must encode exactly 32 random bytes");
  }

  const originText = environment.LIMINA_DERIVED_RUNTIME_ORIGIN;
  let origin;
  try { origin = new URL(originText); }
  catch (error) {
    throw new DerivedBuildServiceError("INVALID_RUNTIME_CONFIG", "LIMINA_DERIVED_RUNTIME_ORIGIN must be an exact loopback HTTP origin", { cause: error });
  }
  if (originText !== origin.origin || origin.protocol !== "http:"
      || (origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1")
      || origin.port === "") {
    throw new DerivedBuildServiceError("INVALID_RUNTIME_CONFIG", "LIMINA_DERIVED_RUNTIME_ORIGIN must be an exact loopback HTTP origin");
  }
  return Object.freeze({ port, token: new Uint8Array(token), allowedOrigins: Object.freeze([origin.origin]) });
}

export function derivedRuntimeDiscovery(baseUrl) {
  let parsed;
  try { parsed = new URL(baseUrl); }
  catch (error) { throw new DerivedBuildServiceError("INVALID_RUNTIME_DISCOVERY", "derived runtime returned an invalid base URL", { cause: error }); }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/"
      || parsed.search !== "" || parsed.hash !== "" || parsed.username !== "" || parsed.password !== ""
      || parsed.port === "") {
    throw new DerivedBuildServiceError("INVALID_RUNTIME_DISCOVERY", "derived runtime returned a non-loopback base URL");
  }
  return Object.freeze({ schema: DERIVED_RUNTIME_DISCOVERY_SCHEMA, baseUrl: parsed.origin });
}

export async function startDerivedRuntimeAfterAuthority(service, createRuntimeServer) {
  if (typeof service?.reconcileOnce !== "function" || typeof createRuntimeServer !== "function") {
    throw new DerivedBuildServiceError("INVALID_RUNTIME_LIFECYCLE", "derived runtime lifecycle inputs are incomplete");
  }
  await service.reconcileOnce();
  const runtimeServer = createRuntimeServer();
  if (typeof runtimeServer?.start !== "function" || typeof runtimeServer?.stop !== "function") {
    throw new DerivedBuildServiceError("INVALID_RUNTIME_LIFECYCLE", "derived runtime server factory returned an invalid owner");
  }
  let runtimeOwner;
  try { runtimeOwner = await runtimeServer.start(); }
  catch (error) {
    await runtimeServer.stop().catch(() => {});
    throw error;
  }
  let discovery;
  try { discovery = derivedRuntimeDiscovery(runtimeOwner?.baseUrl); }
  catch (error) {
    await runtimeServer.stop().catch(() => {});
    throw error;
  }
  return Object.freeze({ runtimeServer, discovery });
}

export async function stopDerivedRuntimeBeforeBuildService(runtimeServer, service, reason) {
  if (runtimeServer !== undefined && typeof runtimeServer?.stop !== "function") {
    throw new DerivedBuildServiceError("INVALID_RUNTIME_LIFECYCLE", "derived runtime server cannot be stopped");
  }
  if (typeof service?.stop !== "function") {
    throw new DerivedBuildServiceError("INVALID_RUNTIME_LIFECYCLE", "derived build service cannot be stopped");
  }
  let runtimeFailure;
  try { await runtimeServer?.stop(); }
  catch (error) { runtimeFailure = error; }
  let serviceFailure;
  try { await service.stop(reason); }
  catch (error) { serviceFailure = error; }
  if (runtimeFailure !== undefined && serviceFailure !== undefined) {
    throw new AggregateError([runtimeFailure, serviceFailure], "derived runtime and build service shutdown failed");
  }
  if (runtimeFailure !== undefined) throw runtimeFailure;
  if (serviceFailure !== undefined) throw serviceFailure;
}

export class DerivedBuildServiceError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "DerivedBuildServiceError";
    this.code = code;
  }
}

function exactObject(input, keys, label) {
  if (input === null || Array.isArray(input) || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype
      || Object.getOwnPropertySymbols(input).length !== 0) {
    throw new DerivedBuildServiceError("INVALID_AUTHORITY", `${label} must be a plain object`);
  }
  const actual = Object.getOwnPropertyNames(input).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new DerivedBuildServiceError("INVALID_AUTHORITY", `${label} has unsupported or missing fields`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
      throw new DerivedBuildServiceError("INVALID_AUTHORITY", `${label}.${key} must be an enumerable data field`);
    }
  }
  return input;
}

function validateReference(input, label, terrainLayer = false) {
  const keys = terrainLayer ? ["assetId", "hash", "layerId", "baseTopologyHash"] : ["assetId", "hash"];
  const ref = exactObject(input, keys, label);
  if (!isProjectAssetId(ref.assetId)
      || typeof ref.hash !== "string" || !HASH.test(ref.hash)) {
    throw new DerivedBuildServiceError("INVALID_AUTHORITY", `${label} has an invalid asset identity`);
  }
  if (terrainLayer && (typeof ref.layerId !== "string" || ref.layerId.length > 128 || !TERRAIN_LAYER_ID.test(ref.layerId)
      || typeof ref.baseTopologyHash !== "string" || !HASH.test(ref.baseTopologyHash))) {
    throw new DerivedBuildServiceError("INVALID_AUTHORITY", `${label} has invalid terrain layer identity`);
  }
  return ref;
}

function isProjectAssetId(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 256
    && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((segment) => segment !== "." && segment !== ".." && ASSET_SEGMENT.test(segment));
}

function immutable(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

function validateCompilerBundle(input, label) {
  if (input === null || Array.isArray(input) || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype
      || Object.getOwnPropertySymbols(input).length !== 0) {
    throw new DerivedBuildServiceError("INVALID_COMPILER", `${label} must be a plain object`);
  }
  const names = Object.getOwnPropertyNames(input);
  const allowed = new Set(["schema", "version", "config", "identity"]);
  if (!names.includes("version") || !names.includes("config") || !names.includes("identity")
      || names.some((name) => !allowed.has(name))) {
    throw new DerivedBuildServiceError("INVALID_COMPILER", `${label} has unsupported or missing fields`);
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
      throw new DerivedBuildServiceError("INVALID_COMPILER", `${label}.${name} must be an enumerable data field`);
    }
  }
  if (typeof input.version !== "string" || !COMPILER_VERSION.test(input.version)
      || input.config === null || Array.isArray(input.config) || typeof input.config !== "object"
      || Object.getPrototypeOf(input.config) !== Object.prototype) {
    throw new DerivedBuildServiceError("INVALID_COMPILER", `${label} version or config is invalid`);
  }
  const identity = input.identity;
  if (identity === null || Array.isArray(identity) || typeof identity !== "object" || Object.getPrototypeOf(identity) !== Object.prototype
      || Object.getOwnPropertySymbols(identity).length !== 0) {
    throw new DerivedBuildServiceError("INVALID_COMPILER", `${label}.identity must be a plain object`);
  }
  const identityNames = Object.getOwnPropertyNames(identity).sort();
  if (identityNames.join() !== "configHash,graphHash,version") {
    throw new DerivedBuildServiceError("INVALID_COMPILER", `${label}.identity has unsupported or missing fields`);
  }
  for (const name of identityNames) {
    const descriptor = Object.getOwnPropertyDescriptor(identity, name);
    if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
      throw new DerivedBuildServiceError("INVALID_COMPILER", `${label}.identity.${name} must be an enumerable data field`);
    }
  }
  let actualConfigHash;
  try { actualConfigHash = compilerContentHash(input.config); }
  catch (error) { throw new DerivedBuildServiceError("INVALID_COMPILER", `${label}.config is not canonical compiler data`, { cause: error }); }
  if (identity.version !== input.version || identity.configHash !== actualConfigHash || !HASH.test(identity.graphHash)) {
    throw new DerivedBuildServiceError("INVALID_COMPILER", `${label}.identity is invalid or inconsistent`);
  }
  immutable(input.config);
  return Object.freeze({
    ...(Object.hasOwn(input, "schema") ? { schema: input.schema } : {}),
    version: input.version,
    config: input.config,
    identity: Object.freeze({
      version: identity.version,
      configHash: identity.configHash,
      graphHash: identity.graphHash,
    }),
  });
}

function sameCompilerIdentity(left, right) {
  return left?.version === right?.version
    && left?.configHash === right?.configHash
    && left?.graphHash === right?.graphHash;
}

function installedFor(snapshot, installed, compilerIdentity) {
  return installed?.source?.revision === snapshot.head.revision
    && installed.source.headHash === snapshot.head.headHash
    && sameCompilerIdentity(installed.compiler, compilerIdentity);
}

function denseAuthorityArray(input, maximum, label) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype
      || Object.getOwnPropertySymbols(input).length !== 0 || input.length > maximum) {
    throw new DerivedBuildServiceError("INVALID_AUTHORITY", `${label} must be a plain dense array with at most ${maximum} entries`);
  }
  const names = Object.getOwnPropertyNames(input);
  if (names.length !== input.length + 1 || !names.includes("length")) {
    throw new DerivedBuildServiceError("INVALID_AUTHORITY", `${label} must not contain sparse or custom entries`);
  }
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
      throw new DerivedBuildServiceError("INVALID_AUTHORITY", `${label}[${index}] must be an enumerable data field`);
    }
  }
  return input;
}

export function validateAuthoritySourceSnapshot(input, projectId) {
  const envelope = exactObject(input, ["schema", "head", "projectState", "snapshotHash"], "authority source snapshot");
  if (envelope.schema !== "limina.world-project-source-snapshot/v1" || !HASH.test(envelope.snapshotHash)) {
    throw new DerivedBuildServiceError("INVALID_AUTHORITY", "authority source snapshot schema or hash is invalid");
  }
  const head = exactObject(envelope.head, ["schema", "projectId", "revision", "headHash"], "authority source head");
  if (head.schema !== "limina.world-project-head/v1" || head.projectId !== projectId
      || !Number.isSafeInteger(head.revision) || head.revision < 0 || !HASH.test(head.headHash)) {
    throw new DerivedBuildServiceError("INVALID_AUTHORITY", "authority source head is invalid or belongs to another project");
  }
  const state = exactObject(envelope.projectState, ["schema", "projectId", "refs", "stateHash"], "authority project state");
  if (state.schema !== "limina.world-project-state/v1" || state.projectId !== projectId || !HASH.test(state.stateHash)) {
    throw new DerivedBuildServiceError("INVALID_AUTHORITY", "authority project state is invalid or belongs to another project");
  }
  const refs = exactObject(state.refs, ["mapDoc", "terrainEditLayers", "scene", "assets", "lookProfile"], "authority project refs");
  if (refs.mapDoc !== null) validateReference(refs.mapDoc, "authority MapDoc ref");
  const layerIds = new Set();
  denseAuthorityArray(refs.terrainEditLayers, MAX_AUTHORITY_EDIT_LAYERS, "authority terrain edit layers")
    .forEach((ref, index) => {
      const valid = validateReference(ref, `authority terrain edit layer ${index}`, true);
      if (layerIds.has(valid.layerId)) throw new DerivedBuildServiceError("INVALID_AUTHORITY", `authority terrain edit layer ${index} duplicates layerId '${valid.layerId}'`);
      layerIds.add(valid.layerId);
    });
  let previousAssetId;
  denseAuthorityArray(refs.assets, 2_048, "authority asset refs")
    .forEach((ref, index) => {
      const valid = validateReference(ref, `authority asset ref ${index}`);
      if (previousAssetId !== undefined && previousAssetId >= valid.assetId) {
        throw new DerivedBuildServiceError("INVALID_AUTHORITY", "authority asset refs must be strictly sorted by assetId");
      }
      previousAssetId = valid.assetId;
    });
  if (refs.scene !== null) validateReference(refs.scene, "authority scene ref");
  if (refs.lookProfile !== null) validateReference(refs.lookProfile, "authority look profile ref");
  const expectedStateHash = compilerContentHash({
    schema: "limina.world-project-state/v1",
    projectId,
    refs,
  });
  if (state.stateHash !== expectedStateHash) throw new DerivedBuildServiceError("INVALID_AUTHORITY", "authority project state hash is invalid");
  const expectedSnapshotHash = compilerContentHash({
    schema: "limina.world-project-source-snapshot/v1",
    head,
    projectState: state,
  });
  if (envelope.snapshotHash !== expectedSnapshotHash) throw new DerivedBuildServiceError("INVALID_AUTHORITY", "authority source snapshot hash is invalid");
  return immutable({
    schema: envelope.schema,
    head: { ...head },
    projectState: {
      ...state,
      refs: {
        mapDoc: refs.mapDoc === null ? null : { ...refs.mapDoc },
        terrainEditLayers: refs.terrainEditLayers.map((ref) => ({ ...ref })),
        scene: refs.scene === null ? null : { ...refs.scene },
        assets: refs.assets.map((ref) => ({ ...ref })),
        lookProfile: refs.lookProfile === null ? null : { ...refs.lookProfile },
      },
    },
    snapshotHash: envelope.snapshotHash,
  });
}

function compilerArtifacts(artifacts) {
  const byHash = new Map();
  for (const artifact of artifacts) {
    if (!(artifact?.bytes instanceof Uint8Array) || !HASH.test(artifact.contentHash)) {
      throw new DerivedBuildServiceError("INVALID_COMPILE_OUTPUT", "world compiler returned malformed artifact bytes");
    }
    const existing = byHash.get(artifact.contentHash);
    if (existing !== undefined) {
      if (existing.bytes.byteLength !== artifact.bytes.byteLength
          || !existing.bytes.every((byte, index) => byte === artifact.bytes[index])) {
        throw new DerivedBuildServiceError("INVALID_COMPILE_OUTPUT", `world compiler returned conflicting bytes for ${artifact.contentHash}`);
      }
      continue;
    }
    byHash.set(artifact.contentHash, Object.freeze({ contentHash: artifact.contentHash, bytes: artifact.bytes }));
  }
  return Object.freeze([...byHash.values()].sort((a, b) => a.contentHash < b.contentHash ? -1 : a.contentHash > b.contentHash ? 1 : 0));
}

function availableHashes(manifest) {
  const hashes = new Set();
  for (const artifact of derivedGlobalArtifacts(manifest)) hashes.add(artifact.contentHash);
  for (const chunk of manifest.chunks) for (const artifact of chunk.artifacts) hashes.add(artifact.contentHash);
  return [...hashes].sort();
}

function boundedPollMs(value) {
  const parsed = value ?? DEFAULT_DERIVED_BUILD_POLL_MS;
  if (!Number.isInteger(parsed) || parsed < MIN_DERIVED_BUILD_POLL_MS || parsed > MAX_DERIVED_BUILD_POLL_MS) {
    throw new DerivedBuildServiceError(
      "INVALID_OPTIONS",
      `derived build poll interval must be an integer in [${MIN_DERIVED_BUILD_POLL_MS}, ${MAX_DERIVED_BUILD_POLL_MS}]`,
    );
  }
  return parsed;
}

function noPublishedRevision(error) {
  return error instanceof Error && error.message === "no derived revision has been published";
}

function within(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function readSeedMapDoc(projectRootInput, seedPathInput) {
  const projectRoot = realpathSync(resolve(projectRootInput));
  const seedPath = resolve(seedPathInput);
  if (!within(projectRoot, seedPath) || seedPath === projectRoot) {
    throw new DerivedBuildServiceError("INVALID_BOOTSTRAP", "seed MapDoc must be a child of the project root");
  }
  const parts = relative(projectRoot, seedPath).split(sep);
  let current = projectRoot;
  for (let index = 0; index < parts.length - 1; index++) {
    current = join(current, parts[index]);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new DerivedBuildServiceError("INVALID_BOOTSTRAP", "seed MapDoc has a symlink or non-directory parent");
    }
    current = realpathSync(current);
    if (!within(projectRoot, current)) throw new DerivedBuildServiceError("INVALID_BOOTSTRAP", "seed MapDoc escapes the project root");
  }
  let descriptor;
  try { descriptor = openSync(seedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) { throw new DerivedBuildServiceError("INVALID_BOOTSTRAP", "seed MapDoc cannot be opened safely", { cause: error }); }
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink < 1 || opened.size > MAX_SOURCE_BYTES) {
      throw new DerivedBuildServiceError("INVALID_BOOTSTRAP", `seed MapDoc must be a regular file of at most ${MAX_SOURCE_BYTES} bytes`);
    }
    let openedPath;
    try { openedPath = realpathSync(`/proc/self/fd/${descriptor}`); }
    catch {
      openedPath = realpathSync(seedPath);
      const candidate = statSync(openedPath);
      if (candidate.dev !== opened.dev || candidate.ino !== opened.ino) {
        throw new DerivedBuildServiceError("INVALID_BOOTSTRAP", "seed MapDoc changed while opening");
      }
    }
    if (!within(projectRoot, openedPath)) throw new DerivedBuildServiceError("INVALID_BOOTSTRAP", "seed MapDoc descriptor escapes the project root");
    const bytes = readFileSync(descriptor);
    if (bytes.byteLength !== opened.size) throw new DerivedBuildServiceError("INVALID_BOOTSTRAP", "seed MapDoc changed while reading");
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (error) { throw new DerivedBuildServiceError("INVALID_BOOTSTRAP", "seed MapDoc is not valid UTF-8", { cause: error }); }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (error) { throw new DerivedBuildServiceError("INVALID_BOOTSTRAP", "seed MapDoc is invalid JSON", { cause: error }); }
    return Buffer.from(canonicalMapDocText(parsed), "utf8");
  } finally { closeSync(descriptor); }
}

function sameRef(left, right) {
  return left?.assetId === right.assetId && left?.hash === right.hash;
}

/** Seed a new project through the same exact-head transaction used by normal Atlas saves. */
export async function bootstrapAuthoritativeMapDoc({
  projectId,
  projectRoot,
  assetRoot,
  seedPath,
  authoringClient,
  validateMapDoc,
  persistSource = persistMapDocSource,
}) {
  if (typeof validateMapDoc !== "function") throw new DerivedBuildServiceError("INVALID_BOOTSTRAP", "bootstrap requires a MapDoc validator");
  const initial = validateAuthoritySourceSnapshot(await authoringClient.callTool("authoring.sourceSnapshot", {}), projectId);
  if (initial.projectState.refs.mapDoc !== null) {
    return Object.freeze({ status: "preserved", source: initial.projectState.refs.mapDoc, snapshot: initial });
  }
  if (initial.head.revision !== 0) {
    return Object.freeze({ status: "not-genesis", source: null, snapshot: initial });
  }

  const bytes = readSeedMapDoc(projectRoot, seedPath);
  validateMapDoc({ mapsJsonText: bytes.toString("utf8") });
  const stored = persistSource({ projectRoot, assetRoot, bytes });
  const source = Object.freeze({ assetId: stored.assetId, hash: stored.hash });
  const digest = source.hash.slice("sha256:".length);
  const transaction = {
    schema: "limina.authoring-transaction/v1",
    transactionId: `bootstrap-mapdoc-${digest}-${initial.head.headHash.slice(7, 39)}`,
    projectId,
    baseRevision: initial.head.revision,
    baseHeadHash: initial.head.headHash,
    operations: [{
      adapter: "project-state",
      adapterVersion: "1.0.0",
      action: "refs.patch",
      input: { projectId, patch: { mapDoc: source } },
      guard: { beforeHash: initial.projectState.stateHash },
    }],
  };
  let result;
  let commitEvidence;
  let commitError;
  try { result = await authoringClient.callTool("authoring.commit", { transaction }, { retryTransport: true }); }
  catch (error) { commitError = error; }
  if (commitError === undefined) {
    commitEvidence = validateAuthoringProjectStateCommit(result, transaction, initial.projectState, source);
  }

  const confirmed = validateAuthoritySourceSnapshot(await authoringClient.callTool("authoring.sourceSnapshot", {}), projectId);
  if (!sameRef(confirmed.projectState.refs.mapDoc, source)) {
    if (confirmed.projectState.refs.mapDoc !== null) {
      return Object.freeze({ status: "preserved-concurrent", source: confirmed.projectState.refs.mapDoc, snapshot: confirmed });
    }
    if (commitError !== undefined) throw commitError;
    throw new DerivedBuildServiceError("INVALID_AUTHORITY", "bootstrap commit returned without installing or preserving a MapDoc ref");
  }
  if (confirmed.head.revision < 1 || confirmed.head.headHash === initial.head.headHash) {
    throw new DerivedBuildServiceError("INVALID_AUTHORITY", "bootstrap source ref is not bound to an authoritative revision");
  }
  if (commitError !== undefined && commitEvidence === undefined) {
    // An identical concurrent bootstrap can commit while this caller receives a stale-head
    // response. The hash-bound post-read above is the recovery proof in that case.
    return Object.freeze({ status: "already-committed", source, snapshot: confirmed });
  }
  return Object.freeze({
    status: commitEvidence?.committed === false ? "already-committed" : "committed",
    source,
    snapshot: confirmed,
  });
}

export class DerivedBuildService {
  #projectId;
  #projectRoot;
  #branchId;
  #authoringClient;
  #assetStore;
  #compileAtlasMapDoc;
  #compileWorldTerrain;
  #compiler;
  #compilerForWorldMap;
  #coordinator;
  #pollMs;
  #logger;
  #setTimer;
  #clearTimer;
  #timer;
  #running = false;
  #closed = false;
  #polling;
  #sourceByHead = new Map();
  #submittedSnapshotHash;
  #inFlight = new Set();
  #previous;
  #previousLoaded = false;
  #loadPrevious;
  #compileMetadata = new Map();
  #compileMetadataByHead = new Map();
  #bootstrapMapDoc;
  #bootstrapping;

  constructor(options) {
    if (!options || typeof options !== "object" || typeof options.projectId !== "string"
        || typeof options.projectRoot !== "string" || typeof options.authoringClient?.callTool !== "function"
        || typeof options.assetStore?.read !== "function" || typeof options.compileAtlasMapDoc !== "function"
        || typeof options.compileWorldTerrain !== "function" || !options.compiler?.identity || !options.compiler?.config) {
      throw new DerivedBuildServiceError("INVALID_OPTIONS", "derived build service options are incomplete");
    }
    this.#projectId = options.projectId;
    this.#projectRoot = options.projectRoot;
    this.#branchId = options.branchId ?? DEFAULT_DERIVED_BUILD_BRANCH;
    if (!BRANCH_ID.test(this.#branchId)) throw new DerivedBuildServiceError("INVALID_OPTIONS", "derived build branchId is invalid");
    this.#authoringClient = options.authoringClient;
    this.#assetStore = options.assetStore;
    this.#compileAtlasMapDoc = options.compileAtlasMapDoc;
    this.#compileWorldTerrain = options.compileWorldTerrain;
    this.#compiler = validateCompilerBundle(options.compiler, "derived build service compiler");
    if (options.compilerForWorldMap !== undefined && typeof options.compilerForWorldMap !== "function") {
      throw new DerivedBuildServiceError("INVALID_OPTIONS", "derived build service compilerForWorldMap must be a function");
    }
    this.#compilerForWorldMap = options.compilerForWorldMap;
    this.#pollMs = boundedPollMs(options.pollMs);
    this.#logger = options.logger ?? console;
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#clearTimer = options.clearTimer ?? clearTimeout;
    this.#loadPrevious = options.loadPrevious ?? (async () => undefined);
    if (options.bootstrapMapDoc !== undefined && typeof options.bootstrapMapDoc !== "function") {
      throw new DerivedBuildServiceError("INVALID_OPTIONS", "derived build bootstrapMapDoc must be a function");
    }
    this.#bootstrapMapDoc = options.bootstrapMapDoc;

    const coordinatorFactory = options.coordinatorFactory ?? ((input) => new DerivedBuildCoordinator(input));
    const publish = options.publish ?? (async ({ buildId, manifest, artifacts, reusedArtifacts, readHead, signal }) => {
      const metadata = this.#compileMetadata.get(manifest.manifestHash);
      if (metadata === undefined) throw new DerivedBuildServiceError("MISSING_COMPILE_METADATA", "compiler snapshot was not retained for publication");
      try {
        const result = await publishDerivedRevision({
          projectRoot: this.#projectRoot,
          jobId: buildId,
          manifest,
          artifacts,
          reusedArtifacts,
          snapshot: metadata.snapshot,
          readHead,
          shouldCancel: () => signal.aborted,
        });
        this.#previous = { manifest: result.manifest, snapshot: result.snapshot };
        this.#previousLoaded = true;
        return { published: result.published, manifestHash: result.manifest.manifestHash };
      } finally {
        this.#compileMetadata.delete(manifest.manifestHash);
      }
    });
    const reuseVerifier = options.verifyReusableArtifacts ?? (({ manifest, reusedArtifacts, signal }) => verifyPublishedDerivedArtifacts({
      projectRoot: this.#projectRoot,
      branchId: manifest.branchId,
      manifest,
      reusedArtifacts,
      shouldCancel: () => signal.aborted,
    }));
    const verifyReusableArtifacts = async (input) => {
      try { return await reuseVerifier(input); }
      catch (error) {
        // Do not repeatedly advertise a cache set that just failed descriptor-level verification.
        // The next retry is a complete rebuild and can repair a missing/corrupt installation.
        this.#previous = undefined;
        this.#previousLoaded = true;
        throw error;
      }
    };
    this.#coordinator = coordinatorFactory({
      projectId: this.#projectId,
      projectRoot: this.#projectRoot,
      compiler: this.#compiler.identity,
      ...(this.#compilerForWorldMap === undefined ? {} : {
        compilerForRequest: (request) => {
          const prepared = this.#sourceByHead.get(request.headHash);
          if (prepared === undefined || prepared.authority.head.revision !== request.revision) {
            throw new DerivedBuildServiceError("SOURCE_SNAPSHOT_MISSING", "exact prepared source is no longer retained for compiler selection");
          }
          return prepared.compiler.identity;
        },
      }),
      readHead: () => this.#readHead(),
      compile: (request) => this.#compile(request),
      publish,
      verifyReusableArtifacts,
      maxConcurrentBuilds: 1,
    });
  }

  start() {
    if (this.#closed) throw new DerivedBuildServiceError("SERVICE_CLOSED", "derived build service is closed");
    if (this.#running) return;
    this.#running = true;
    this.#schedule(0);
  }

  async reconcileOnce({ waitForBuild = false } = {}) {
    if (this.#closed) throw new DerivedBuildServiceError("SERVICE_CLOSED", "derived build service is closed");
    let snapshot = await this.#readSnapshot();
    if (snapshot.projectState.refs.mapDoc === null && snapshot.head.revision === 0 && this.#bootstrapMapDoc !== undefined) {
      this.#bootstrapping ??= Promise.resolve(this.#bootstrapMapDoc()).finally(() => { this.#bootstrapping = undefined; });
      await this.#bootstrapping;
      snapshot = await this.#readSnapshot();
    }
    if (snapshot.projectState.refs.mapDoc === null) return { status: "waiting-for-mapdoc", snapshotHash: snapshot.snapshotHash };
    if (snapshot.snapshotHash === this.#submittedSnapshotHash) return { status: "unchanged", snapshotHash: snapshot.snapshotHash };
    await this.#ensurePrevious();
    const installed = this.#previous?.manifest;
    if (this.#compilerForWorldMap === undefined && this.#previous?.snapshot
        && installedFor(snapshot, installed, this.#compiler.identity)) {
      this.#submittedSnapshotHash = snapshot.snapshotHash;
      return { status: "already-published", snapshotHash: snapshot.snapshotHash, manifestHash: installed.manifestHash };
    }
    const prepared = this.#prepareSource(snapshot);
    if (this.#previous?.snapshot && installedFor(snapshot, installed, prepared.compiler.identity)) {
      this.#submittedSnapshotHash = snapshot.snapshotHash;
      return { status: "already-published", snapshotHash: snapshot.snapshotHash, manifestHash: installed.manifestHash };
    }
    this.#submittedSnapshotHash = snapshot.snapshotHash;
    this.#sourceByHead.set(snapshot.head.headHash, prepared);
    let promise;
    try {
      promise = this.#coordinator.submit({
        schema: "limina.derived-build-request/v1",
        projectId: this.#projectId,
        branchId: this.#branchId,
        revision: snapshot.head.revision,
        headHash: snapshot.head.headHash,
      });
    } catch (error) {
      this.#sourceByHead.delete(snapshot.head.headHash);
      if (this.#submittedSnapshotHash === snapshot.snapshotHash) this.#submittedSnapshotHash = undefined;
      throw error;
    }
    this.#inFlight.add(promise);
    const settled = promise.then(
      (result) => {
        this.#logger.info?.(`[derived-build] published revision ${result.revision} as ${result.manifestHash}`);
        return result;
      },
      (error) => {
        if (this.#submittedSnapshotHash === snapshot.snapshotHash) this.#submittedSnapshotHash = undefined;
        this.#logger.error?.(`[derived-build] revision ${snapshot.head.revision} failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      },
    ).finally(() => {
      this.#sourceByHead.delete(snapshot.head.headHash);
      const metadataHash = this.#compileMetadataByHead.get(snapshot.head.headHash);
      if (metadataHash !== undefined) this.#compileMetadata.delete(metadataHash);
      this.#compileMetadataByHead.delete(snapshot.head.headHash);
      this.#inFlight.delete(promise);
    });
    if (waitForBuild) return settled;
    settled.catch(() => {});
    return { status: "submitted", snapshotHash: snapshot.snapshotHash };
  }

  diagnostics() {
    return Object.freeze({
      schema: DERIVED_BUILD_SERVICE_STATUS_SCHEMA,
      projectId: this.#projectId,
      branchId: this.#branchId,
      running: this.#running,
      closed: this.#closed,
      submittedSnapshotHash: this.#submittedSnapshotHash ?? null,
      inFlight: this.#inFlight.size,
      coordinator: this.#coordinator.diagnostics(),
    });
  }

  async stop(reason = "derived build service stopped") {
    if (this.#closed) return;
    this.#closed = true;
    this.#running = false;
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    this.#timer = undefined;
    await this.#polling?.catch(() => {});
    await this.#coordinator.close(reason);
    await Promise.allSettled([...this.#inFlight]);
    this.#authoringClient.close?.();
    this.#sourceByHead.clear();
    this.#compileMetadata.clear();
    this.#compileMetadataByHead.clear();
  }

  #schedule(delay) {
    if (!this.#running || this.#closed) return;
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined;
      this.#polling = this.reconcileOnce().catch((error) => {
        this.#logger.error?.(`[derived-build] poll failed: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => {
        this.#polling = undefined;
        this.#schedule(this.#pollMs);
      });
    }, delay);
  }

  async #readSnapshot() {
    const input = await this.#authoringClient.callTool("authoring.sourceSnapshot", {});
    return validateAuthoritySourceSnapshot(input, this.#projectId);
  }

  async #readHead() {
    const snapshot = await this.#readSnapshot();
    return Object.freeze({
      projectId: snapshot.head.projectId,
      branchId: this.#branchId,
      revision: snapshot.head.revision,
      headHash: snapshot.head.headHash,
    });
  }

  #prepareSource(authority) {
    const mapRef = authority.projectState.refs.mapDoc;
    if (mapRef === null) throw new DerivedBuildServiceError("SOURCE_SNAPSHOT_MISSING", "authoritative source snapshot has no MapDoc");
    if (authority.projectState.refs.terrainEditLayers.length > MAX_COMPILED_EDIT_LAYERS) {
      throw new DerivedBuildServiceError(
        "SOURCE_LIMIT_EXCEEDED",
        `terrain compilation supports at most ${MAX_COMPILED_EDIT_LAYERS} edit layers per revision`,
      );
    }
    const mapBytes = this.#assetStore.read(mapRef, { maximumBytes: MAX_SOURCE_BYTES });
    let mapsJsonText;
    try { mapsJsonText = new TextDecoder("utf-8", { fatal: true }).decode(mapBytes); }
    catch (error) { throw new DerivedBuildServiceError("INVALID_MAPDOC", "authoritative MapDoc is not valid UTF-8", { cause: error }); }
    let compiledMap;
    try { compiledMap = this.#compileAtlasMapDoc({ mapsJsonText }); }
    catch (error) { throw new DerivedBuildServiceError("INVALID_MAPDOC", `authoritative MapDoc compilation failed: ${error?.message ?? error}`, { cause: error }); }
    if (compiledMap === null || typeof compiledMap !== "object" || compiledMap.worldMap === null || typeof compiledMap.worldMap !== "object") {
      throw new DerivedBuildServiceError("INVALID_MAPDOC", "authoritative MapDoc compiler returned no WorldMap");
    }
    immutable(compiledMap);
    let compiler = this.#compiler;
    if (this.#compilerForWorldMap !== undefined) {
      let selected;
      try { selected = this.#compilerForWorldMap(compiledMap.worldMap); }
      catch (error) {
        throw new DerivedBuildServiceError("COMPILER_SELECTION_FAILED", `world compiler profile selection failed: ${error?.message ?? error}`, { cause: error });
      }
      try { compiler = validateCompilerBundle(selected, "selected world compiler"); }
      catch (error) {
        throw new DerivedBuildServiceError("COMPILER_SELECTION_FAILED", `world compiler profile selection returned an invalid bundle: ${error?.message ?? error}`, { cause: error });
      }
    }
    return Object.freeze({ authority, compiledMap, compiler });
  }

  async #compile(request) {
    const prepared = this.#sourceByHead.get(request.headHash);
    if (prepared === undefined || prepared.authority.head.revision !== request.revision) {
      throw new DerivedBuildServiceError("SOURCE_SNAPSHOT_MISSING", "exact authoritative source snapshot is no longer retained");
    }
    if (!sameCompilerIdentity(prepared.compiler.identity, request.compiler)) {
      throw new DerivedBuildServiceError("COMPILER_IDENTITY_DRIFT", "prepared compiler identity does not match the submitted build identity");
    }
    const authority = prepared.authority;
    await this.#ensurePrevious();
    const mapRef = authority.projectState.refs.mapDoc;
    if (mapRef === null) throw new DerivedBuildServiceError("SOURCE_SNAPSHOT_MISSING", "authoritative source snapshot has no MapDoc");
    if (authority.projectState.refs.terrainEditLayers.length > MAX_COMPILED_EDIT_LAYERS) {
      throw new DerivedBuildServiceError(
        "SOURCE_LIMIT_EXCEEDED",
        `terrain compilation supports at most ${MAX_COMPILED_EDIT_LAYERS} edit layers per revision`,
      );
    }
    const terrainEditLayers = [];
    const terrainEditLayerRefs = [];
    for (let index = 0; index < authority.projectState.refs.terrainEditLayers.length; index++) {
      const ref = authority.projectState.refs.terrainEditLayers[index];
      terrainEditLayers.push(this.#assetStore.readCanonicalJson({ assetId: ref.assetId, hash: ref.hash }, {
        maximumBytes: MAX_SOURCE_BYTES,
        contentHashOf: (value) => parseTerrainEditLayer(value).contentHash,
      }));
      terrainEditLayerRefs.push({
        refId: `terrain-edit-layer-${String(index).padStart(3, "0")}`,
        refType: "terrain-edit-layer/v1",
        scope: "chunk",
        assetId: ref.assetId,
        contentHash: ref.hash,
      });
    }

    const previous = this.#previous?.snapshot && this.#previous?.manifest ? this.#previous : undefined;
    const prior = previous !== undefined && sameCompilerIdentity(previous.manifest.compiler, prepared.compiler.identity)
      ? previous
      : undefined;
    const output = await this.#compileWorldTerrain({
      request: {
        projectId: request.projectId,
        branchId: request.branchId,
        revision: request.revision,
        headHash: request.headHash,
      },
      worldMap: prepared.compiledMap.worldMap,
      sourceRefs: {
        mapDocument: {
          refId: "map-document",
          refType: "map-document/v1",
          scope: "global",
          assetId: mapRef.assetId,
          contentHash: mapRef.hash,
        },
      },
      terrainEditLayers,
      terrainEditLayerRefs,
      compiler: { version: prepared.compiler.version, config: prepared.compiler.config },
      previousSnapshot: prior?.snapshot ?? null,
      ...(prior === undefined ? {} : {
        previousManifest: prior.manifest,
        availableArtifactHashes: availableHashes(prior.manifest),
      }),
      cancellation: { shouldCancel: () => request.signal.aborted },
    }, { signal: request.signal });
    if (!output || !Array.isArray(output.artifacts) || !Array.isArray(output.reusedArtifacts)
        || !output.manifest || !output.snapshot || !Array.isArray(output.diagnostics)) {
      throw new DerivedBuildServiceError("INVALID_COMPILE_OUTPUT", "world compiler returned an incomplete production envelope");
    }
    this.#compileMetadata.set(output.manifest.manifestHash, {
      snapshot: output.snapshot,
      invalidation: output.invalidation,
      diagnostics: output.diagnostics,
    });
    this.#compileMetadataByHead.set(request.headHash, output.manifest.manifestHash);
    while (this.#compileMetadata.size > MAX_RETAINED_COMPILE_METADATA) {
      this.#compileMetadata.delete(this.#compileMetadata.keys().next().value);
    }
    return Object.freeze({
      manifest: output.manifest,
      artifacts: compilerArtifacts(output.artifacts),
      reusedArtifacts: output.reusedArtifacts,
    });
  }

  async #ensurePrevious() {
    if (this.#previousLoaded) return;
    try { this.#previous = await this.#loadPrevious(); }
    catch (error) { if (!noPublishedRevision(error)) throw error; }
    this.#previousLoaded = true;
  }
}

async function main() {
  const projectRoot = resolve(process.argv[2] ?? process.cwd());
  const projectConfig = loadProjectConfig(projectRoot);
  const assetRoot = join(projectConfig.projectRoot, projectConfig.assetRoot ?? "assets");
  const compilerBundlePath = process.env.LIMINA_WORLD_COMPILER_BUNDLE;
  if (!compilerBundlePath) throw new Error("LIMINA_WORLD_COMPILER_BUNDLE is required");
  const compilerModule = await import(pathToFileURL(resolve(compilerBundlePath)).href);
  const compiler = compilerModule.createDefaultWorldTerrainCompiler(projectConfig.projectId);
  if (typeof compilerModule.createHydrologyWorldTerrainCompiler !== "function") {
    throw new Error("world compiler bundle does not export createHydrologyWorldTerrainCompiler");
  }
  const hydrologyCompiler = compilerModule.createHydrologyWorldTerrainCompiler(projectConfig.projectId);
  const authoringClient = new EditorBridgeClient(editorClientConfigFromEnvironment(process.env, {
    agentId: "limina-derived-build-service",
    sessionId: `derived-build-${process.pid}`,
    profile: "system.derived-build",
  }));
  const readHead = async () => {
    const snapshot = validateAuthoritySourceSnapshot(
      await authoringClient.callTool("authoring.sourceSnapshot", {}),
      projectConfig.projectId,
    );
    return { projectId: projectConfig.projectId, branchId: DEFAULT_DERIVED_BUILD_BRANCH, revision: snapshot.head.revision, headHash: snapshot.head.headHash };
  };
  const runtimeConfiguration = derivedRuntimeConfigurationFromEnvironment(process.env);
  const service = new DerivedBuildService({
    projectId: projectConfig.projectId,
    projectRoot: projectConfig.projectRoot,
    authoringClient,
    assetStore: new ProjectAssetStore({ projectId: projectConfig.projectId, projectRoot: projectConfig.projectRoot, assetRoot }),
    compileAtlasMapDoc: compilerModule.compileAtlasMapDoc,
    compileWorldTerrain: (input, { signal }) => compileWorldTerrainInWorker({
      bundlePath: compilerBundlePath,
      input,
      signal,
    }),
    compiler,
    compilerForWorldMap: (worldMap) => worldMap.hydrology === undefined ? compiler : hydrologyCompiler,
    bootstrapMapDoc: existsSync(join(projectConfig.projectRoot, "design", "maps.json"))
      ? () => bootstrapAuthoritativeMapDoc({
        projectId: projectConfig.projectId,
        projectRoot: projectConfig.projectRoot,
        assetRoot,
        seedPath: join(projectConfig.projectRoot, "design", "maps.json"),
        authoringClient,
        validateMapDoc: compilerModule.compileAtlasMapDoc,
      })
      : undefined,
    pollMs: Number(process.env.LIMINA_DERIVED_BUILD_POLL_MS ?? DEFAULT_DERIVED_BUILD_POLL_MS),
    loadPrevious: () => readPublishedDerivedRevision({ projectRoot: projectConfig.projectRoot, branchId: DEFAULT_DERIVED_BUILD_BRANCH, readHead }),
  });
  let runtimeServer;
  let stopping;
  const stop = (signal) => {
    if (stopping !== undefined) return;
    console.error(`[derived-build] received ${signal}, shutting down`);
    stopping = stopDerivedRuntimeBeforeBuildService(runtimeServer, service, `received ${signal}`)
      .then(
        () => process.exit(0),
        (error) => {
          console.error(`[derived-build] shutdown failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
          process.exit(1);
        },
      );
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  const runtime = await startDerivedRuntimeAfterAuthority(service, () => {
    try {
      return new DerivedRuntimeServer({
        projectId: projectConfig.projectId,
        projectRoot: projectConfig.projectRoot,
        branchId: DEFAULT_DERIVED_BUILD_BRANCH,
        readHead,
        token: runtimeConfiguration.token,
        port: runtimeConfiguration.port,
        allowedHosts: ["127.0.0.1"],
        allowedOrigins: runtimeConfiguration.allowedOrigins,
      });
    } finally {
      runtimeConfiguration.token.fill(0);
    }
  });
  runtimeServer = runtime.runtimeServer;
  service.start();
  console.log(`[derived-build] watching ${projectConfig.projectId}/${DEFAULT_DERIVED_BUILD_BRANCH}`);
  console.log(`[derived-runtime] ready ${JSON.stringify(runtime.discovery)}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[derived-build] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  });
}
