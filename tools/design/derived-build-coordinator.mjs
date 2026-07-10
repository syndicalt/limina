import {
  MAX_DERIVED_ARTIFACTS,
  MAX_DERIVED_TOTAL_ARTIFACT_BYTES,
  DERIVED_REVISION_MANIFEST_SCHEMA_V1,
  compilerContentHash,
  derivedGlobalArtifacts,
  derivedArtifactContentHash,
  parseDerivedRevisionManifest,
  validateCompilerContentHash,
} from "../../js/src/world/compiler/index.mjs";
import { publishDerivedRevision } from "./derived-publisher.mjs";

export const DERIVED_BUILD_REQUEST_SCHEMA = "limina.derived-build-request/v1";
export const DERIVED_BUILD_DIAGNOSTICS_SCHEMA = "limina.derived-build-diagnostics/v1";
export const DEFAULT_MAX_TRACKED_BRANCHES = 64;
export const DEFAULT_MAX_DIAGNOSTICS = 128;
export const DEFAULT_MAX_CONCURRENT_BUILDS = 2;

const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BRANCH_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const COMPILER_VERSION = /^[0-9][A-Za-z0-9._+-]{0,63}$/;
const MAX_ERROR_MESSAGE_LENGTH = 512;

export class DerivedBuildCoordinatorError extends Error {
  constructor(code, message) {
    super(limitMessage(message));
    this.name = "DerivedBuildCoordinatorError";
    this.code = code;
  }
}

function limitMessage(message) {
  const text = typeof message === "string" ? message : String(message);
  return text.length <= MAX_ERROR_MESSAGE_LENGTH ? text : `${text.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`;
}

function plainObject(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new DerivedBuildCoordinatorError("INVALID_INPUT", `${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new DerivedBuildCoordinatorError("INVALID_INPUT", `${label} has symbol fields`);
  }
  const names = Object.getOwnPropertyNames(value);
  const missing = [...expected].filter((key) => !names.includes(key));
  const extra = names.filter((key) => !expected.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new DerivedBuildCoordinatorError(
      "INVALID_INPUT",
      `${label} fields differ (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
    );
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor?.get !== undefined || descriptor?.set !== undefined || descriptor?.enumerable !== true) {
      throw new DerivedBuildCoordinatorError("INVALID_INPUT", `${label}.${name} must be an enumerable data field`);
    }
  }
}

function identifier(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new DerivedBuildCoordinatorError("INVALID_INPUT", `${label} is invalid`);
  }
  return value;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new DerivedBuildCoordinatorError("INVALID_INPUT", `${label} must be an integer in [${minimum}, ${maximum}]`);
  }
  return result;
}

function parseRequest(input, expectedProjectId, compilerIdentity) {
  const request = plainObject(input, "derived build request");
  exactKeys(request, new Set(["schema", "projectId", "branchId", "revision", "headHash"]), "derived build request");
  if (request.schema !== DERIVED_BUILD_REQUEST_SCHEMA) {
    throw new DerivedBuildCoordinatorError("INVALID_INPUT", `derived build request schema must be '${DERIVED_BUILD_REQUEST_SCHEMA}'`);
  }
  const projectId = identifier(request.projectId, PROJECT_ID, "derived build projectId");
  if (projectId !== expectedProjectId) throw new DerivedBuildCoordinatorError("WRONG_PROJECT", "derived build belongs to another project");
  if (!Number.isSafeInteger(request.revision) || request.revision < 0) {
    throw new DerivedBuildCoordinatorError("INVALID_INPUT", "derived build revision must be a non-negative safe integer");
  }
  return Object.freeze({
    schema: DERIVED_BUILD_REQUEST_SCHEMA,
    projectId,
    branchId: identifier(request.branchId, BRANCH_ID, "derived build branchId"),
    revision: request.revision,
    headHash: validateCompilerContentHash(request.headHash, "derived build headHash"),
    compiler: compilerIdentity,
  });
}

function parseCompilerIdentity(input) {
  const compiler = plainObject(input, "derived build compiler identity");
  exactKeys(compiler, new Set(["version", "configHash", "graphHash"]), "derived build compiler identity");
  return Object.freeze({
    version: identifier(compiler.version, COMPILER_VERSION, "derived build compiler version"),
    configHash: validateCompilerContentHash(compiler.configHash, "derived build compiler configHash"),
    graphHash: validateCompilerContentHash(compiler.graphHash, "derived build compiler graphHash"),
  });
}

function parseHead(input, expected) {
  const head = plainObject(input, "authoritative build head");
  exactKeys(head, new Set(["projectId", "branchId", "revision", "headHash"]), "authoritative build head");
  const parsed = {
    projectId: identifier(head.projectId, PROJECT_ID, "authoritative head projectId"),
    branchId: identifier(head.branchId, BRANCH_ID, "authoritative head branchId"),
    revision: head.revision,
    headHash: validateCompilerContentHash(head.headHash, "authoritative head headHash"),
  };
  if (!Number.isSafeInteger(parsed.revision) || parsed.revision < 0) {
    throw new DerivedBuildCoordinatorError("INVALID_AUTHORITY", "authoritative head revision must be a non-negative safe integer");
  }
  if (parsed.projectId !== expected.projectId || parsed.branchId !== expected.branchId) {
    throw new DerivedBuildCoordinatorError("AUTHORITY_IDENTITY_DRIFT", "authoritative project or branch changed during derived build");
  }
  return Object.freeze(parsed);
}

function sameSource(left, right) {
  return left.revision === right.revision && left.headHash === right.headHash;
}

function sameIntent(left, right) {
  return sameSource(left, right)
    && left.compiler.version === right.compiler.version
    && left.compiler.configHash === right.compiler.configHash
    && left.compiler.graphHash === right.compiler.graphHash;
}

function assertAuthoritative(head, requested, phase) {
  if (!sameSource(head, requested)) {
    throw new DerivedBuildCoordinatorError(
      "AUTHORITY_DRIFT",
      `${phase}: requested ${requested.revision}/${requested.headHash} but authority is ${head.revision}/${head.headHash}`,
    );
  }
}

function buildIdFor(request) {
  const hash = compilerContentHash({
    schema: DERIVED_BUILD_REQUEST_SCHEMA,
    projectId: request.projectId,
    branchId: request.branchId,
    revision: request.revision,
    headHash: request.headHash,
    compiler: request.compiler,
  });
  return `derived-${hash.slice("sha256:".length)}`;
}

function artifactDescriptors(manifest) {
  const descriptors = new Map();
  const add = (artifact) => {
    const previous = descriptors.get(artifact.contentHash);
    if (previous !== undefined && previous.byteLength !== artifact.byteLength) {
      throw new DerivedBuildCoordinatorError("INVALID_COMPILE_OUTPUT", `artifact ${artifact.contentHash} has inconsistent byte lengths`);
    }
    descriptors.set(artifact.contentHash, artifact);
  };
  for (const artifact of derivedGlobalArtifacts(manifest)) add(artifact);
  for (const chunk of manifest.chunks) for (const artifact of chunk.artifacts) add(artifact);
  return descriptors;
}

function artifactReferences(manifest) {
  const references = new Map();
  for (const artifact of derivedGlobalArtifacts(manifest)) {
    references.set(`global\u0000${artifact.artifactType}`, { scope: "global", ...artifact });
  }
  for (const chunk of manifest.chunks) for (const artifact of chunk.artifacts) {
    references.set(`chunk\u0000${chunk.chunkId}\u0000${artifact.artifactType}`, { scope: "chunk", chunkId: chunk.chunkId, ...artifact });
  }
  return references;
}

function compileReference(manifest, value, index, label, includeBytes) {
  const legacyChunk = manifest.schema === DERIVED_REVISION_MANIFEST_SCHEMA_V1 && !Object.hasOwn(value, "scope");
  const scope = legacyChunk ? "chunk" : value.scope;
  if (scope !== "global" && scope !== "chunk") {
    throw new DerivedBuildCoordinatorError("INVALID_COMPILE_OUTPUT", `${label} ${index} scope must be global or chunk`);
  }
  const suffix = includeBytes ? ["bytes"] : ["byteLength"];
  exactKeys(
    value,
    new Set(scope === "global"
      ? ["scope", "artifactType", "mediaType", "contentHash", ...suffix]
      : [...(legacyChunk ? [] : ["scope"]), "chunkId", "artifactType", "mediaType", "contentHash", ...suffix]),
    `${label} ${index}`,
  );
  return {
    scope,
    legacyChunk,
    key: scope === "global"
      ? `global\u0000${value.artifactType}`
      : `chunk\u0000${value.chunkId}\u0000${value.artifactType}`,
  };
}

function parseCompileOutputUnchecked(input, request) {
  const output = plainObject(input, "derived compile output");
  const outputKeys = new Set(Object.getOwnPropertyNames(output));
  const sparse = outputKeys.has("reusedArtifacts");
  exactKeys(output, new Set(sparse ? ["manifest", "artifacts", "reusedArtifacts"] : ["manifest", "artifacts"]), "derived compile output");
  let manifest;
  try {
    manifest = parseDerivedRevisionManifest(output.manifest);
  } catch (error) {
    throw new DerivedBuildCoordinatorError("INVALID_COMPILE_OUTPUT", `derived compile manifest is invalid: ${error?.message ?? error}`);
  }
  if (
    manifest.projectId !== request.projectId
    || manifest.branchId !== request.branchId
    || manifest.source.revision !== request.revision
    || manifest.source.headHash !== request.headHash
    || manifest.compiler.version !== request.compiler.version
    || manifest.compiler.configHash !== request.compiler.configHash
    || manifest.compiler.graphHash !== request.compiler.graphHash
  ) {
    throw new DerivedBuildCoordinatorError("INVALID_COMPILE_OUTPUT", "derived compile manifest source or compiler identity does not match its build request");
  }
  if (!Array.isArray(output.artifacts) || output.artifacts.length > MAX_DERIVED_ARTIFACTS) {
    throw new DerivedBuildCoordinatorError(
      "INVALID_COMPILE_OUTPUT",
      `derived compile artifacts must be an array with at most ${MAX_DERIVED_ARTIFACTS} entries`,
    );
  }
  const required = artifactDescriptors(manifest);
  const references = artifactReferences(manifest);
  const supplied = new Set();
  const artifacts = [];
  let totalBytes = 0;
  for (let index = 0; index < output.artifacts.length; index++) {
    const artifact = plainObject(output.artifacts[index], `derived compile artifact ${index}`);
    const artifactKeys = new Set(Object.getOwnPropertyNames(artifact));
    const rich = artifactKeys.has("scope") || artifactKeys.has("chunkId") || artifactKeys.has("artifactType") || artifactKeys.has("mediaType");
    const location = rich ? compileReference(manifest, artifact, index, "derived compile artifact", true) : undefined;
    if (!rich) exactKeys(artifact, new Set(["contentHash", "bytes"]), `derived compile artifact ${index}`);
    const contentHash = validateCompilerContentHash(artifact.contentHash, `derived compile artifact ${index} contentHash`);
    if (!(artifact.bytes instanceof Uint8Array)) {
      throw new DerivedBuildCoordinatorError("INVALID_COMPILE_OUTPUT", `derived compile artifact ${index} bytes must be Uint8Array`);
    }
    if (supplied.has(contentHash)) {
      throw new DerivedBuildCoordinatorError("INVALID_COMPILE_OUTPUT", `derived compile artifacts contain duplicate ${contentHash}`);
    }
    const descriptor = required.get(contentHash);
    if (descriptor === undefined) {
      throw new DerivedBuildCoordinatorError("INVALID_COMPILE_OUTPUT", `derived compile supplied unreferenced artifact ${contentHash}`);
    }
    if (artifact.bytes.byteLength !== descriptor.byteLength) {
      throw new DerivedBuildCoordinatorError("INVALID_COMPILE_OUTPUT", `derived compile artifact ${contentHash} byteLength mismatch`);
    }
    if (rich) {
      const reference = references.get(location.key);
      if (reference === undefined || reference.contentHash !== contentHash || reference.mediaType !== artifact.mediaType) {
        throw new DerivedBuildCoordinatorError("INVALID_COMPILE_OUTPUT", `derived compile artifact ${index} does not match the manifest`);
      }
    }
    if (derivedArtifactContentHash(artifact.bytes) !== contentHash) {
      throw new DerivedBuildCoordinatorError("INVALID_COMPILE_OUTPUT", `derived compile artifact ${contentHash} content hash mismatch`);
    }
    totalBytes += artifact.bytes.byteLength;
    if (totalBytes > MAX_DERIVED_TOTAL_ARTIFACT_BYTES) {
      throw new DerivedBuildCoordinatorError("INVALID_COMPILE_OUTPUT", "derived compile artifact bytes exceed the total resource bound");
    }
    supplied.add(contentHash);
    artifacts.push(Object.freeze({ contentHash, bytes: artifact.bytes }));
  }
  const reusedArtifacts = [];
  const reusedHashes = new Set();
  const reusedReferences = new Set();
  let previousReuseKey;
  if (sparse && (!Array.isArray(output.reusedArtifacts) || output.reusedArtifacts.length > MAX_DERIVED_ARTIFACTS)) {
    throw new DerivedBuildCoordinatorError("INVALID_COMPILE_OUTPUT", `derived compile reusedArtifacts must be an array with at most ${MAX_DERIVED_ARTIFACTS} entries`);
  }
  const reusedInputs = sparse ? output.reusedArtifacts : [];
  for (let index = 0; index < reusedInputs.length; index++) {
    const reused = plainObject(reusedInputs[index], `derived compile reused artifact ${index}`);
    const location = compileReference(manifest, reused, index, "derived compile reused artifact", false);
    const contentHash = validateCompilerContentHash(reused.contentHash, `derived compile reused artifact ${index} contentHash`);
    const key = location.key;
    if (previousReuseKey !== undefined && previousReuseKey >= key) {
      throw new DerivedBuildCoordinatorError("INVALID_COMPILE_OUTPUT", "derived compile reusedArtifacts must be strictly ordered and unique");
    }
    previousReuseKey = key;
    if (reusedReferences.has(key)) throw new DerivedBuildCoordinatorError("INVALID_COMPILE_OUTPUT", `derived compile reused artifacts contain duplicate ${key}`);
    const reference = references.get(key);
    if (reference === undefined
      || reference.contentHash !== contentHash
      || reference.byteLength !== reused.byteLength
      || reference.mediaType !== reused.mediaType) {
      throw new DerivedBuildCoordinatorError("INVALID_COMPILE_OUTPUT", `derived compile reused artifact ${index} does not match the manifest`);
    }
    if (supplied.has(contentHash)) {
      throw new DerivedBuildCoordinatorError("INVALID_COMPILE_OUTPUT", `derived compile artifact ${contentHash} is both supplied and reused`);
    }
    reusedReferences.add(key);
    reusedHashes.add(contentHash);
    reusedArtifacts.push(Object.freeze({
      ...(location.legacyChunk ? {} : { scope: reference.scope }),
      ...(reference.scope === "chunk" ? { chunkId: reference.chunkId } : {}),
      artifactType: reference.artifactType,
      mediaType: reference.mediaType,
      contentHash,
      byteLength: reference.byteLength,
    }));
  }
  for (const contentHash of required.keys()) {
    if (!supplied.has(contentHash) && !reusedHashes.has(contentHash)) {
      throw new DerivedBuildCoordinatorError("INVALID_COMPILE_OUTPUT", `derived compile is missing artifact ${contentHash}`);
    }
  }
  return { manifest, artifacts: Object.freeze(artifacts), reusedArtifacts: Object.freeze(reusedArtifacts) };
}

function parseCompileOutput(input, request) {
  try {
    return parseCompileOutputUnchecked(input, request);
  } catch (error) {
    if (error instanceof DerivedBuildCoordinatorError && error.code === "INVALID_COMPILE_OUTPUT") throw error;
    throw new DerivedBuildCoordinatorError("INVALID_COMPILE_OUTPUT", `derived compile output is invalid: ${error?.message ?? error}`);
  }
}

function parsePublishResult(input, manifestHash) {
  try {
    const result = plainObject(input, "derived publish result");
    exactKeys(result, new Set(["published", "manifestHash"]), "derived publish result");
    if (result.published !== true || result.manifestHash !== manifestHash) {
      throw new DerivedBuildCoordinatorError("INVALID_PUBLISH_RESULT", "derived publisher did not confirm the requested manifest");
    }
  } catch (error) {
    if (error instanceof DerivedBuildCoordinatorError && error.code === "INVALID_PUBLISH_RESULT") throw error;
    throw new DerivedBuildCoordinatorError("INVALID_PUBLISH_RESULT", `derived publish result is invalid: ${error?.message ?? error}`);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function normalizeFailure(error, phase) {
  if (error instanceof DerivedBuildCoordinatorError) return error;
  return new DerivedBuildCoordinatorError("BUILD_FAILED", `${phase} failed: ${error?.message ?? error}`);
}

function terminalKind(error) {
  if (error.code === "BUILD_SUPERSEDED") return "superseded";
  if (error.code === "BUILD_CANCELLED") return "cancelled";
  return "failed";
}

function immutableResult(job, manifestHash, durationMs) {
  return Object.freeze({
    status: "published",
    buildId: job.buildId,
    projectId: job.request.projectId,
    branchId: job.request.branchId,
    revision: job.request.revision,
    headHash: job.request.headHash,
    compiler: job.request.compiler,
    manifestHash,
    durationMs,
  });
}

async function defaultPublish({ projectRoot, buildId, manifest, artifacts, reusedArtifacts, readHead, signal }) {
  if (reusedArtifacts.length > 0) throw new Error("default derived publisher cannot publish sparse output without a compiler snapshot");
  const result = await publishDerivedRevision({
    projectRoot,
    jobId: buildId,
    manifest,
    artifacts,
    reusedArtifacts,
    allowLegacyManifestOnly: true,
    readHead,
    shouldCancel: () => signal.aborted,
  });
  return { published: result.published, manifestHash: result.manifest.manifestHash };
}

/**
 * Callback ownership contract:
 * - readHead returns the exact project/branch authority requested by its argument.
 * - compile returns either complete artifact bytes or a strict supplied/reused
 *   partition. Reused entries require an independent verifier callback.
 * - publish does not mutate artifact bytes, calls its provided readHead immediately
 *   before its atomic commit, and returns only { published, manifestHash }.
 * The coordinator retains metadata, never artifact bytes, after settlement.
 */
export class DerivedBuildCoordinator {
  #projectId;
  #projectRoot;
  #compilerIdentity;
  #readHead;
  #compile;
  #publish;
  #verifyReusableArtifacts;
  #now;
  #maxTrackedBranches;
  #maxDiagnostics;
  #maxConcurrentBuilds;
  #branches = new Map();
  #readyBranches = [];
  #readyCursor = 0;
  #readyJobs = new Map();
  #runningBuilds = 0;
  #closed = false;
  #idleWaiters = new Set();
  #records = [];
  #recordCursor = 0;
  #counts = {
    submitted: 0,
    coalesced: 0,
    rejected: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    superseded: 0,
    diagnosticsDropped: 0,
  };

  constructor(input) {
    const options = plainObject(input, "derived build coordinator options");
    const allowed = new Set([
      "projectId", "projectRoot", "compiler", "readHead", "compile", "publish", "now", "maxTrackedBranches", "maxDiagnostics",
      "maxConcurrentBuilds", "verifyReusableArtifacts",
    ]);
    const required = new Set(["projectId", "projectRoot", "compiler", "readHead", "compile"]);
    const names = Object.getOwnPropertyNames(options);
    for (const name of names) {
      if (!allowed.has(name)) throw new DerivedBuildCoordinatorError("INVALID_INPUT", `derived build coordinator options has unsupported field '${name}'`);
      const descriptor = Object.getOwnPropertyDescriptor(options, name);
      if (descriptor?.get !== undefined || descriptor?.set !== undefined || descriptor?.enumerable !== true) {
        throw new DerivedBuildCoordinatorError("INVALID_INPUT", `derived build coordinator options.${name} must be an enumerable data field`);
      }
    }
    for (const name of required) {
      if (!names.includes(name)) throw new DerivedBuildCoordinatorError("INVALID_INPUT", `derived build coordinator options is missing '${name}'`);
    }
    this.#projectId = identifier(options.projectId, PROJECT_ID, "derived build coordinator projectId");
    if (typeof options.projectRoot !== "string" || options.projectRoot.length < 1 || options.projectRoot.length > 4096) {
      throw new DerivedBuildCoordinatorError("INVALID_INPUT", "derived build coordinator projectRoot is invalid");
    }
    if (typeof options.readHead !== "function" || typeof options.compile !== "function") {
      throw new DerivedBuildCoordinatorError("INVALID_INPUT", "derived build coordinator readHead and compile must be functions");
    }
    if (options.publish !== undefined && typeof options.publish !== "function") {
      throw new DerivedBuildCoordinatorError("INVALID_INPUT", "derived build coordinator publish must be a function");
    }
    if (options.verifyReusableArtifacts !== undefined && typeof options.verifyReusableArtifacts !== "function") {
      throw new DerivedBuildCoordinatorError("INVALID_INPUT", "derived build coordinator verifyReusableArtifacts must be a function");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new DerivedBuildCoordinatorError("INVALID_INPUT", "derived build coordinator now must be a function");
    }
    this.#projectRoot = options.projectRoot;
    this.#compilerIdentity = parseCompilerIdentity(options.compiler);
    this.#readHead = options.readHead;
    this.#compile = options.compile;
    this.#publish = options.publish ?? defaultPublish;
    this.#verifyReusableArtifacts = options.verifyReusableArtifacts;
    this.#now = options.now ?? Date.now;
    this.#maxTrackedBranches = boundedInteger(options.maxTrackedBranches, DEFAULT_MAX_TRACKED_BRANCHES, 1, 1024, "maxTrackedBranches");
    this.#maxDiagnostics = boundedInteger(options.maxDiagnostics, DEFAULT_MAX_DIAGNOSTICS, 1, 4096, "maxDiagnostics");
    this.#maxConcurrentBuilds = boundedInteger(options.maxConcurrentBuilds, DEFAULT_MAX_CONCURRENT_BUILDS, 1, 16, "maxConcurrentBuilds");
  }

  submit(input) {
    const request = parseRequest(input, this.#projectId, this.#compilerIdentity);
    if (this.#closed) {
      this.#counts.rejected++;
      throw new DerivedBuildCoordinatorError("COORDINATOR_CLOSED", "derived build coordinator is closed");
    }
    this.#counts.submitted++;
    let state = this.#branches.get(request.branchId);
    if (state === undefined) {
      if (this.#branches.size >= this.#maxTrackedBranches) {
        this.#counts.rejected++;
        throw new DerivedBuildCoordinatorError("BRANCH_LIMIT", `derived build coordinator tracks at most ${this.#maxTrackedBranches} branches`);
      }
      state = { latest: undefined, active: undefined, pending: undefined, lastSuccess: undefined };
      this.#branches.set(request.branchId, state);
    }

    if (state.latest !== undefined) {
      if (request.revision < state.latest.revision) return this.#rejectStale(request, state.latest);
      if (request.revision === state.latest.revision && request.headHash !== state.latest.headHash) {
        return this.#rejectStale(request, state.latest, "same revision has a different authoritative hash");
      }
      if (sameIntent(request, state.latest)) {
        const shared = [state.active, state.pending].find((job) => job !== undefined && sameIntent(job.request, request));
        if (shared !== undefined) {
          this.#counts.coalesced++;
          return shared.promise;
        }
        if (state.lastSuccess !== undefined && sameIntent(state.lastSuccess, request)) {
          this.#counts.coalesced++;
          return Promise.resolve(state.lastSuccess.result);
        }
      }
    }

    const job = this.#createJob(request);
    state.latest = request;
    if (state.active === undefined) {
      state.active = job;
      this.#enqueue(state, job);
      return job.promise;
    }
    if (!state.active.running) {
      this.#supersedeQueued(state, job);
      return job.promise;
    }
    if (state.pending !== undefined) this.#supersedePending(state.pending, job);
    state.pending = job;
    state.active.controller.abort(new DerivedBuildCoordinatorError(
      "BUILD_SUPERSEDED",
      `build ${state.active.buildId} was superseded by ${job.buildId}`,
    ));
    return job.promise;
  }

  diagnostics() {
    const now = this.#clock();
    const active = [];
    const pending = [];
    const lastKnownGood = [];
    for (const [branchId, state] of this.#branches) {
      if (state.active !== undefined) active.push(this.#jobDiagnostic(state.active, now));
      if (state.pending !== undefined) pending.push(this.#jobDiagnostic(state.pending, now));
      if (state.lastSuccess !== undefined) lastKnownGood.push(Object.freeze({ ...state.lastSuccess.result }));
      if (branchId !== state.latest?.branchId) throw new Error("derived build coordinator branch index invariant failed");
    }
    const counts = Object.freeze({ ...this.#counts });
    return Object.freeze({
      schema: DERIVED_BUILD_DIAGNOSTICS_SCHEMA,
      projectId: this.#projectId,
      counts,
      truncated: counts.diagnosticsDropped > 0,
      capacity: Object.freeze({
        running: this.#runningBuilds,
        ready: this.#readyJobs.size,
        maxConcurrentBuilds: this.#maxConcurrentBuilds,
      }),
      active: Object.freeze(active),
      pending: Object.freeze(pending),
      lastKnownGood: Object.freeze(lastKnownGood),
      recent: Object.freeze(this.#orderedRecords().map((entry) => Object.freeze({ ...entry }))),
    });
  }

  close(reason = "derived build coordinator is shutting down") {
    if (typeof reason !== "string" || reason.length < 1) {
      throw new DerivedBuildCoordinatorError("INVALID_INPUT", "derived build coordinator close reason must be a non-empty string");
    }
    if (this.#closed) return this.whenIdle();
    this.#closed = true;
    const error = new DerivedBuildCoordinatorError("BUILD_CANCELLED", reason);
    this.#readyJobs.clear();
    this.#readyBranches = [];
    this.#readyCursor = 0;
    for (const state of this.#branches.values()) {
      if (state.pending !== undefined) {
        this.#cancelUnstarted(state.pending, error);
        state.pending = undefined;
      }
      if (state.active === undefined) continue;
      if (state.active.running) state.active.controller.abort(error);
      else {
        this.#cancelUnstarted(state.active, error);
        state.active = undefined;
      }
    }
    this.#notifyIdle();
    return this.whenIdle();
  }

  whenIdle() {
    if (this.#isIdle()) return Promise.resolve();
    const completion = deferred();
    this.#idleWaiters.add(completion.resolve);
    return completion.promise;
  }

  #rejectStale(request, latest, detail = "request is older than the latest accepted build intent") {
    this.#counts.rejected++;
    const error = new DerivedBuildCoordinatorError(
      "STALE_BUILD_REQUEST",
      `${detail}: ${request.revision}/${request.headHash}; latest is ${latest.revision}/${latest.headHash}`,
    );
    this.#record({
      status: "rejected",
      buildId: buildIdFor(request),
      branchId: request.branchId,
      revision: request.revision,
      headHash: request.headHash,
      compiler: request.compiler,
      phase: "queue",
      durationMs: 0,
      errorCode: error.code,
      errorMessage: error.message,
    });
    return Promise.reject(error);
  }

  #createJob(request) {
    const completion = deferred();
    return {
      request,
      buildId: buildIdFor(request),
      controller: new AbortController(),
      phase: "queued",
      submittedAt: this.#clock(),
      running: false,
      promise: completion.promise,
      resolve: completion.resolve,
      reject: completion.reject,
    };
  }

  #enqueue(state, job) {
    job.phase = "waiting-for-capacity";
    if (!this.#readyJobs.has(job.request.branchId)) this.#readyBranches.push(job.request.branchId);
    this.#readyJobs.set(job.request.branchId, { state, job });
    this.#drain();
  }

  #drain() {
    while (this.#runningBuilds < this.#maxConcurrentBuilds && this.#readyCursor < this.#readyBranches.length) {
      const branchId = this.#readyBranches[this.#readyCursor++];
      const entry = this.#readyJobs.get(branchId);
      this.#readyJobs.delete(branchId);
      if (entry === undefined || entry.state.active !== entry.job || entry.job.controller.signal.aborted) continue;
      this.#runActive(entry.state, entry.job);
    }
    if (this.#readyCursor === this.#readyBranches.length) {
      this.#readyBranches = [];
      this.#readyCursor = 0;
    }
  }

  #runActive(state, job) {
    job.running = true;
    this.#runningBuilds++;
    void this.#run(job).then(
      (result) => this.#settleActive(state, job, result, undefined),
      (error) => this.#settleActive(state, job, undefined, error),
    );
  }

  #settleActive(state, job, result, error) {
    const resolve = job.resolve;
    const reject = job.reject;
    if (error === undefined) state.lastSuccess = { ...job.request, result };
    if (state.active === job) state.active = undefined;
    job.running = false;
    job.controller = undefined;
    job.resolve = undefined;
    job.reject = undefined;
    this.#runningBuilds--;
    if (state.pending !== undefined) {
      const next = state.pending;
      state.pending = undefined;
      state.active = next;
      this.#enqueue(state, next);
    }
    this.#drain();
    this.#notifyIdle();
    if (error === undefined) resolve(result);
    else reject(error);
  }

  async #run(job) {
    let manifest;
    let artifacts;
    let reusedArtifacts;
    try {
      job.phase = "authority-before-compile";
      this.#throwIfAborted(job);
      const initialHead = await this.#readAuthoritative(job, job.phase);
      assertAuthoritative(initialHead, job.request, job.phase);
      this.#throwIfAborted(job);

      job.phase = "compile";
      const output = await this.#compile(Object.freeze({
        buildId: job.buildId,
        projectId: job.request.projectId,
        branchId: job.request.branchId,
        revision: job.request.revision,
        headHash: job.request.headHash,
        compiler: job.request.compiler,
        signal: job.controller.signal,
      }));
      this.#throwIfAborted(job);
      ({ manifest, artifacts, reusedArtifacts } = parseCompileOutput(output, job.request));
      this.#throwIfAborted(job);

      if (reusedArtifacts.length > 0) {
        if (this.#verifyReusableArtifacts === undefined) {
          throw new DerivedBuildCoordinatorError(
            "REUSE_VERIFIER_REQUIRED",
            "sparse derived compile output requires verifyReusableArtifacts",
          );
        }
        job.phase = "verify-reuse";
        await this.#verifyReusableArtifacts(Object.freeze({
          projectRoot: this.#projectRoot,
          buildId: job.buildId,
          manifest,
          reusedArtifacts,
          signal: job.controller.signal,
        }));
        this.#throwIfAborted(job);
      }

      job.phase = "authority-before-publish";
      const prePublishHead = await this.#readAuthoritative(job, job.phase);
      assertAuthoritative(prePublishHead, job.request, job.phase);
      this.#throwIfAborted(job);

      job.phase = "publish";
      let publicationHeadReads = 0;
      const publicationReadHead = async () => {
        publicationHeadReads++;
        const head = await this.#readAuthoritative(job, "authority-at-publication");
        assertAuthoritative(head, job.request, "authority-at-publication");
        return head;
      };
      const publishResult = await this.#publish(Object.freeze({
        projectRoot: this.#projectRoot,
        buildId: job.buildId,
        manifest,
        artifacts,
        reusedArtifacts,
        readHead: publicationReadHead,
        signal: job.controller.signal,
      }));
      if (publicationHeadReads < 1) {
        throw new DerivedBuildCoordinatorError(
          "PUBLISH_AUTHORITY_NOT_CHECKED",
          "derived publisher must call readHead at its atomic commit boundary",
        );
      }
      parsePublishResult(publishResult, manifest.manifestHash);
      const durationMs = this.#duration(job);
      const result = immutableResult(job, manifest.manifestHash, durationMs);
      this.#counts.succeeded++;
      this.#record({
        status: "published",
        buildId: job.buildId,
        branchId: job.request.branchId,
        revision: job.request.revision,
        headHash: job.request.headHash,
        compiler: job.request.compiler,
        manifestHash: manifest.manifestHash,
        phase: "complete",
        durationMs,
        errorCode: null,
        errorMessage: null,
      });
      return result;
    } catch (caught) {
      const abortReason = job.controller?.signal.aborted ? job.controller.signal.reason : undefined;
      const error = normalizeFailure(abortReason ?? caught, job.phase);
      const kind = terminalKind(error);
      this.#counts[kind]++;
      this.#record({
        status: kind,
        buildId: job.buildId,
        branchId: job.request.branchId,
        revision: job.request.revision,
        headHash: job.request.headHash,
        compiler: job.request.compiler,
        manifestHash: manifest?.manifestHash ?? null,
        phase: job.phase,
        durationMs: this.#duration(job),
        errorCode: error.code,
        errorMessage: error.message,
      });
      throw error;
    } finally {
      manifest = undefined;
      artifacts = undefined;
      reusedArtifacts = undefined;
    }
  }

  async #readAuthoritative(job, phase) {
    let value;
    try {
      value = await this.#readHead(Object.freeze({
        projectId: job.request.projectId,
        branchId: job.request.branchId,
        buildId: job.buildId,
        phase,
        signal: job.controller.signal,
      }));
    } catch (error) {
      throw normalizeFailure(error, phase);
    }
    return parseHead(value, job.request);
  }

  #throwIfAborted(job) {
    if (!job.controller.signal.aborted) return;
    const reason = job.controller.signal.reason;
    if (reason instanceof DerivedBuildCoordinatorError) throw reason;
    throw new DerivedBuildCoordinatorError("BUILD_CANCELLED", `build ${job.buildId} was cancelled`);
  }

  #supersedePending(pending, replacement) {
    const error = new DerivedBuildCoordinatorError(
      "BUILD_SUPERSEDED",
      `pending build ${pending.buildId} was superseded by ${replacement.buildId}`,
    );
    this.#counts.superseded++;
    this.#record({
      status: "superseded",
      buildId: pending.buildId,
      branchId: pending.request.branchId,
      revision: pending.request.revision,
      headHash: pending.request.headHash,
      compiler: pending.request.compiler,
      manifestHash: null,
      phase: "queued",
      durationMs: 0,
      errorCode: error.code,
      errorMessage: error.message,
    });
    pending.reject(error);
    pending.controller.abort(error);
    pending.controller = undefined;
    pending.resolve = undefined;
    pending.reject = undefined;
  }

  #supersedeQueued(state, replacement) {
    const queued = state.active;
    const error = new DerivedBuildCoordinatorError(
      "BUILD_SUPERSEDED",
      `queued build ${queued.buildId} was superseded by ${replacement.buildId}`,
    );
    this.#counts.superseded++;
    this.#record({
      status: "superseded",
      buildId: queued.buildId,
      branchId: queued.request.branchId,
      revision: queued.request.revision,
      headHash: queued.request.headHash,
      compiler: queued.request.compiler,
      manifestHash: null,
      phase: queued.phase,
      durationMs: this.#duration(queued),
      errorCode: error.code,
      errorMessage: error.message,
    });
    queued.reject(error);
    queued.controller.abort(error);
    queued.controller = undefined;
    queued.resolve = undefined;
    queued.reject = undefined;
    replacement.phase = "waiting-for-capacity";
    state.active = replacement;
    this.#readyJobs.set(replacement.request.branchId, { state, job: replacement });
  }

  #cancelUnstarted(job, error) {
    this.#counts.cancelled++;
    this.#record({
      status: "cancelled",
      buildId: job.buildId,
      branchId: job.request.branchId,
      revision: job.request.revision,
      headHash: job.request.headHash,
      compiler: job.request.compiler,
      manifestHash: null,
      phase: job.phase,
      durationMs: this.#duration(job),
      errorCode: error.code,
      errorMessage: error.message,
    });
    job.reject(error);
    job.controller.abort(error);
    job.controller = undefined;
    job.resolve = undefined;
    job.reject = undefined;
  }

  #isIdle() {
    if (this.#runningBuilds !== 0 || this.#readyJobs.size !== 0) return false;
    for (const state of this.#branches.values()) if (state.active !== undefined || state.pending !== undefined) return false;
    return true;
  }

  #notifyIdle() {
    if (!this.#isIdle()) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }

  #clock() {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new DerivedBuildCoordinatorError("INVALID_CLOCK", "derived build clock returned an invalid value");
    return now;
  }

  #duration(job, now = this.#clock()) {
    return Math.max(0, now - job.submittedAt);
  }

  #jobDiagnostic(job, now) {
    return Object.freeze({
      buildId: job.buildId,
      branchId: job.request.branchId,
      revision: job.request.revision,
      headHash: job.request.headHash,
      compiler: job.request.compiler,
      phase: job.phase,
      durationMs: this.#duration(job, now),
    });
  }

  #record(record) {
    const frozen = Object.freeze({ ...record });
    if (this.#records.length < this.#maxDiagnostics) {
      this.#records.push(frozen);
      return;
    }
    this.#records[this.#recordCursor] = frozen;
    this.#recordCursor = (this.#recordCursor + 1) % this.#maxDiagnostics;
    this.#counts.diagnosticsDropped++;
  }

  #orderedRecords() {
    if (this.#records.length < this.#maxDiagnostics || this.#recordCursor === 0) return this.#records;
    return [...this.#records.slice(this.#recordCursor), ...this.#records.slice(0, this.#recordCursor)];
  }
}
