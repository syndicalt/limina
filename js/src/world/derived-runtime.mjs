import { compilerContentHash } from "./compiler/canonical.mjs";
import { derivedArtifactContentHash, derivedGlobalArtifacts, parseDerivedRevisionManifest } from "./compiler/manifest.mjs";

export const DERIVED_RUNTIME_DIAGNOSTICS_LIMIT = 64;
export const MAX_DERIVED_RUNTIME_DIAGNOSTICS = 256;
export const MAX_DERIVED_RUNTIME_ERROR_SUMMARIES = 32;

const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BRANCH_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

function assertFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(`${label} must be a function`);
  return value;
}

function assertIdentifier(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function assertOptions(value, allowed, label) {
  if (value === undefined) return {};
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length > 0) throw new Error(`${label} has unsupported fields: ${extras.join(", ")}`);
  return value;
}

function freezeArray(entries) {
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

function errorSummary(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 240 ? message : `${message.slice(0, 237)}...`;
}

function elapsed(now, startedAt) {
  const duration = now() - startedAt;
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}

function cancellationError() {
  return new DerivedRevisionRuntimeError("DERIVED_REVISION_CANCELLED", "derived revision update was cancelled", "AbortError");
}

function throwIfCancelled(signal) {
  if (signal?.aborted === true) throw cancellationError();
}

function chunkRuntimeIdentity(chunk, grid) {
  return compilerContentHash({
    chunkId: chunk.chunkId,
    gridId: chunk.gridId,
    lod: chunk.lod,
    tx: chunk.tx,
    tz: chunk.tz,
    topologyHash: chunk.topologyHash,
    sourceSliceHashes: chunk.sourceSliceHashes,
    artifacts: chunk.artifacts,
    grid,
  });
}

function globalRuntimeIdentity(artifact) {
  return compilerContentHash(artifact);
}

function publicChunks(liveChunks) {
  return freezeArray([...liveChunks.values()].map((entry) => ({
    chunkId: entry.chunk.chunkId,
    chunk: entry.chunk,
    resource: entry.resource,
  })));
}

function publicGlobals(liveGlobals) {
  return new Map([...liveGlobals].map(([artifactType, entry]) => [artifactType, Object.freeze({
    artifactType,
    artifact: entry.artifact,
    resource: entry.resource,
  })]));
}

function assertAuthority(authority, projectId, branchId) {
  if (authority === null || Array.isArray(authority) || typeof authority !== "object" || Object.getPrototypeOf(authority) !== Object.prototype) {
    throw new DerivedRevisionRuntimeError("INVALID_AUTHORITY", "authoritative source lookup must return a plain object");
  }
  const actualKeys = Object.keys(authority).sort();
  const expectedKeys = ["branchId", "headHash", "projectId", "revision"];
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new DerivedRevisionRuntimeError("INVALID_AUTHORITY", "authoritative source lookup returned invalid fields");
  }
  if (authority.projectId !== projectId || authority.branchId !== branchId) {
    throw new DerivedRevisionRuntimeError("AUTHORITY_SCOPE_MISMATCH", "authoritative source lookup returned another project or branch");
  }
  if (!Number.isSafeInteger(authority.revision) || authority.revision < 0 || typeof authority.headHash !== "string" || !HASH.test(authority.headHash)) {
    throw new DerivedRevisionRuntimeError("INVALID_AUTHORITY", "authoritative source lookup returned an invalid revision or headHash");
  }
  return authority;
}

export class DerivedRevisionRuntimeError extends Error {
  constructor(code, message, name = "DerivedRevisionRuntimeError") {
    super(message);
    this.name = name;
    this.code = code;
  }
}

/**
 * Transactional owner of one project's live derived chunk set.
 *
 * `stageChunk` must create resources without making them visible. `activateRevision`
 * receives the complete next chunk/global sets and must swap them atomically: rejection means it left
 * the previously supplied set visible. This boundary is what lets the manager preserve
 * the live revision across loader, staging, cancellation, and activation failures.
 * If `stageChunk` throws before returning a resource, it owns cleanup of allocations it
 * made internally because the manager has no resource handle to pass to `disposeChunk`.
 */
export class DerivedRevisionManager {
  #projectId;
  #branchId;
  #getAuthoritativeSource;
  #loadArtifact;
  #stageChunk;
  #stageGlobal;
  #activateRevision;
  #disposeChunk;
  #disposeGlobal;
  #now;
  #diagnosticsLimit;
  #diagnostics = [];
  #live = null;
  #running = false;
  #active = null;
  #pending = null;

  constructor(input) {
    const options = assertOptions(input, new Set([
      "projectId", "branchId", "getAuthoritativeSource", "loadArtifact", "stageChunk",
      "stageGlobal", "activateRevision", "disposeChunk", "disposeGlobal", "diagnosticsLimit", "now",
    ]), "derived revision manager options");
    this.#projectId = assertIdentifier(options.projectId, PROJECT_ID, "derived revision manager projectId");
    this.#branchId = assertIdentifier(options.branchId, BRANCH_ID, "derived revision manager branchId");
    this.#getAuthoritativeSource = assertFunction(options.getAuthoritativeSource, "getAuthoritativeSource");
    this.#loadArtifact = assertFunction(options.loadArtifact, "loadArtifact");
    this.#stageChunk = assertFunction(options.stageChunk, "stageChunk");
    this.#stageGlobal = options.stageGlobal === undefined ? undefined : assertFunction(options.stageGlobal, "stageGlobal");
    this.#activateRevision = assertFunction(options.activateRevision, "activateRevision");
    this.#disposeChunk = assertFunction(options.disposeChunk, "disposeChunk");
    this.#disposeGlobal = options.disposeGlobal === undefined ? undefined : assertFunction(options.disposeGlobal, "disposeGlobal");
    if (typeof globalThis.AbortController !== "function") {
      throw new Error("DerivedRevisionManager requires the platform AbortController API");
    }
    const clock = options.now === undefined ? () => globalThis.performance?.now?.() ?? Date.now() : assertFunction(options.now, "now");
    this.#now = () => {
      try {
        const timestamp = clock();
        return Number.isFinite(timestamp) ? timestamp : Date.now();
      } catch {
        return Date.now();
      }
    };
    this.#diagnosticsLimit = options.diagnosticsLimit ?? DERIVED_RUNTIME_DIAGNOSTICS_LIMIT;
    if (!Number.isSafeInteger(this.#diagnosticsLimit) || this.#diagnosticsLimit < 1 || this.#diagnosticsLimit > MAX_DERIVED_RUNTIME_DIAGNOSTICS) {
      throw new Error(`diagnosticsLimit must be an integer in [1, ${MAX_DERIVED_RUNTIME_DIAGNOSTICS}]`);
    }
  }

  get projectId() { return this.#projectId; }
  get branchId() { return this.#branchId; }
  get isUpdating() { return this.#running; }

  get current() {
    if (this.#live === null) return null;
    return Object.freeze({
      manifest: this.#live.manifest,
      chunks: publicChunks(this.#live.chunks),
      globals: publicGlobals(this.#live.globals),
    });
  }

  getDiagnostics() {
    return Object.freeze(this.#diagnostics.map((entry) => Object.freeze({
      ...entry,
      timingsMs: Object.freeze({ ...entry.timingsMs }),
      errors: Object.freeze([...entry.errors]),
    })));
  }

  submit(manifestInput, submitInput = undefined) {
    let manifest;
    let submitOptions;
    try {
      submitOptions = assertOptions(submitInput, new Set(["force", "signal"]), "derived revision submit options");
      if (submitOptions.force !== undefined && typeof submitOptions.force !== "boolean") throw new TypeError("force must be boolean");
      const signal = submitOptions.signal;
      if (signal !== undefined && (signal === null || typeof signal !== "object" || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
        throw new TypeError("signal must be an AbortSignal");
      }
      manifest = parseDerivedRevisionManifest(manifestInput);
      if (manifest.projectId !== this.#projectId || manifest.branchId !== this.#branchId) {
        throw new DerivedRevisionRuntimeError("MANIFEST_SCOPE_MISMATCH", "derived manifest belongs to another project or branch");
      }
      throwIfCancelled(signal);
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      const force = submitOptions.force === true;
      if (this.#sameJob(this.#active, manifest, force) && !this.#active.cancellation.signal.aborted) {
        this.#addWaiter(this.#active, submitOptions.signal, resolve, reject);
        return;
      }
      if (this.#sameJob(this.#pending, manifest, force) && !this.#pending.cancellation.signal.aborted) {
        this.#addWaiter(this.#pending, submitOptions.signal, resolve, reject);
        return;
      }
      const request = {
        manifest,
        force,
        signal: null,
        queuedAt: this.#now(),
        waiters: new Set(),
        cancellation: new globalThis.AbortController(),
        activationStarted: false,
      };
      request.signal = request.cancellation.signal;
      this.#addWaiter(request, submitOptions.signal, resolve, reject);
      if (!this.#running) {
        this.#running = true;
        this.#active = request;
        void this.#drain(request);
        return;
      }
      if (this.#pending !== null && !force && manifest.source.revision < this.#pending.manifest.source.revision) {
        this.#supersedeJob(request, this.#pending.manifest.manifestHash);
        return;
      }
      if (this.#pending !== null) this.#supersedeJob(this.#pending, manifest.manifestHash);
      this.#pending = request;
    });
  }

  #sameJob(request, manifest, force) {
    return request !== null && request.manifest.manifestHash === manifest.manifestHash && request.force === force;
  }

  #addWaiter(request, signal, resolve, reject) {
    const waiter = { signal, resolve, reject, abortListener: null };
    waiter.abortListener = () => {
      if (!request.waiters.has(waiter) || request.activationStarted) return;
      if (request.waiters.size > 1) {
        request.waiters.delete(waiter);
        signal.removeEventListener("abort", waiter.abortListener);
        reject(cancellationError());
        return;
      }
      request.cancellation.abort(cancellationError());
      if (this.#pending === request) {
        this.#pending = null;
        request.waiters.delete(waiter);
        signal.removeEventListener("abort", waiter.abortListener);
        const error = cancellationError();
        this.#recordDiagnostic(request, "cancelled", { errors: [errorSummary(error)] });
        reject(error);
      }
    };
    signal?.addEventListener("abort", waiter.abortListener, { once: true });
    request.waiters.add(waiter);
  }

  #settleWaiters(request, method, value) {
    for (const waiter of request.waiters) {
      waiter.signal?.removeEventListener("abort", waiter.abortListener);
      waiter[method](value);
    }
    request.waiters.clear();
  }

  #supersedeJob(request, supersededByManifestHash) {
    request.cancellation.abort(cancellationError());
    this.#recordDiagnostic(request, "superseded", { errors: [] });
    this.#settleWaiters(request, "resolve", Object.freeze({
      status: "superseded",
      manifestHash: request.manifest.manifestHash,
      supersededByManifestHash,
      revision: request.manifest.source.revision,
    }));
  }

  async #drain(initialRequest) {
    let request = initialRequest;
    while (request !== null) {
      try {
        this.#settleWaiters(request, "resolve", await this.#apply(request));
      } catch (error) {
        this.#settleWaiters(request, "reject", error);
      }
      request = this.#pending;
      this.#pending = null;
      this.#active = request;
    }
    this.#active = null;
    this.#running = false;
  }

  async #authoritativeSource(manifest) {
    const authority = assertAuthority(await this.#getAuthoritativeSource(Object.freeze({
      projectId: this.#projectId,
      branchId: this.#branchId,
    })), this.#projectId, this.#branchId);
    if (authority.revision !== manifest.source.revision || authority.headHash !== manifest.source.headHash) {
      throw new DerivedRevisionRuntimeError(
        "STALE_SOURCE_HEAD",
        `derived manifest source ${manifest.source.revision}/${manifest.source.headHash} is not the authoritative head ${authority.revision}/${authority.headHash}`,
      );
    }
  }

  async #loadVerifiedArtifact(request, artifact, loaderInput, cache, timings, counts) {
    let pending = cache.get(artifact.contentHash);
    if (pending === undefined) {
      pending = (async () => {
        const phaseAt = this.#now();
        try {
          return await this.#loadArtifact(Object.freeze(loaderInput));
        } finally {
          timings.load += elapsed(this.#now, phaseAt);
        }
      })();
      cache.set(artifact.contentHash, pending);
    }
    const bytes = await pending;
    throwIfCancelled(request.signal);
    if (!(bytes instanceof Uint8Array)) {
      throw new DerivedRevisionRuntimeError("INVALID_ARTIFACT_BYTES", `artifact '${artifact.artifactType}' loader did not return Uint8Array`);
    }
    if (bytes.byteLength !== artifact.byteLength) {
      throw new DerivedRevisionRuntimeError("ARTIFACT_LENGTH_MISMATCH", `artifact '${artifact.artifactType}' byteLength mismatch`);
    }
    // Re-verify every descriptor even on a content-addressed cache hit. Deduplication reduces loader
    // I/O only; it never weakens the declared length/hash boundary.
    if (derivedArtifactContentHash(bytes) !== artifact.contentHash) {
      throw new DerivedRevisionRuntimeError("ARTIFACT_HASH_MISMATCH", `artifact '${artifact.artifactType}' content hash mismatch`);
    }
    counts.artifacts++;
    counts.artifactBytes += bytes.byteLength;
    return bytes;
  }

  async #apply(request) {
    const startedAt = this.#now();
    const timingsMs = { authority: 0, load: 0, stage: 0, activation: 0, retirement: 0, total: 0 };
    const counts = {
      changed: 0, unchanged: 0, removed: 0,
      changedGlobals: 0, unchangedGlobals: 0, removedGlobals: 0,
      artifacts: 0, artifactBytes: 0, retirementFailures: 0,
    };
    const staged = [];
    const artifactCache = new Map();
    let failurePhase = "validation";
    try {
      throwIfCancelled(request.signal);
      if (this.#live !== null && request.manifest.source.revision < this.#live.manifest.source.revision && !request.force) {
        throw new DerivedRevisionRuntimeError("OUT_OF_ORDER_REVISION", "derived revision rollback requires force: true");
      }

      failurePhase = "authority";
      let phaseAt = this.#now();
      await this.#authoritativeSource(request.manifest);
      timingsMs.authority += elapsed(this.#now, phaseAt);
      throwIfCancelled(request.signal);

      // The helper accepts only the verified object returned by parseDerivedRevisionManifest above;
      // v1 maps to its canonical frozen empty set without normalizing the manifest shape.
      failurePhase = "validation";
      const manifestGlobals = derivedGlobalArtifacts(request.manifest);
      if (manifestGlobals.length > 0 && (this.#stageGlobal === undefined || this.#disposeGlobal === undefined)) {
        throw new DerivedRevisionRuntimeError(
          "GLOBAL_LIFECYCLE_UNAVAILABLE",
          "derived manifest carries global artifacts but stageGlobal/disposeGlobal are unavailable",
        );
      }

      if (this.#live?.manifest.manifestHash === request.manifest.manifestHash) {
        timingsMs.total = elapsed(this.#now, startedAt);
        counts.unchanged = request.manifest.chunks.length;
        counts.unchangedGlobals = manifestGlobals.length;
        const outcome = this.#outcome("unchanged", request.manifest, counts);
        this.#recordDiagnostic(request, "unchanged", { timingsMs, counts, errors: [] });
        return outcome;
      }

      const priorChunks = this.#live?.chunks ?? new Map();
      const priorGlobals = this.#live?.globals ?? new Map();
      const nextChunks = new Map();
      const nextGlobals = new Map();
      const changedChunks = [];
      const changedGlobals = [];
      for (const artifact of manifestGlobals) {
        const identity = globalRuntimeIdentity(artifact);
        const prior = priorGlobals.get(artifact.artifactType);
        if (prior?.identity === identity) {
          nextGlobals.set(artifact.artifactType, prior);
          counts.unchangedGlobals++;
        } else {
          changedGlobals.push({ artifact, identity });
          counts.changedGlobals++;
        }
      }
      const changedGlobalTypes = new Set(changedGlobals.map((changed) => changed.artifact.artifactType));
      const removedGlobals = [...priorGlobals.values()].filter((entry) => (
        !nextGlobals.has(entry.artifact.artifactType) && !changedGlobalTypes.has(entry.artifact.artifactType)
      ));
      counts.removedGlobals = removedGlobals.length;

      for (const chunk of request.manifest.chunks) {
        const identity = chunkRuntimeIdentity(chunk, request.manifest.grid);
        const prior = priorChunks.get(chunk.chunkId);
        if (prior?.identity === identity) {
          nextChunks.set(chunk.chunkId, prior);
          counts.unchanged++;
        } else {
          changedChunks.push({ chunk, identity });
          counts.changed++;
        }
      }
      const changedChunkIds = new Set(changedChunks.map((changed) => changed.chunk.chunkId));
      const removedChunks = [...priorChunks.values()].filter((entry) => !nextChunks.has(entry.chunk.chunkId) && !changedChunkIds.has(entry.chunk.chunkId));
      counts.removed = removedChunks.length;

      for (const changed of changedGlobals) {
        throwIfCancelled(request.signal);
        failurePhase = "load";
        const bytes = await this.#loadVerifiedArtifact(
          request,
          changed.artifact,
          {
            manifest: request.manifest,
            artifact: changed.artifact,
            globalArtifact: changed.artifact,
            signal: request.signal,
          },
          artifactCache,
          timingsMs,
          counts,
        );
        failurePhase = "stage";
        phaseAt = this.#now();
        const resource = await this.#stageGlobal(Object.freeze({
          manifest: request.manifest,
          artifact: changed.artifact,
          bytes,
          signal: request.signal,
        }));
        timingsMs.stage += elapsed(this.#now, phaseAt);
        if (resource === undefined) {
          throw new DerivedRevisionRuntimeError("INVALID_STAGED_RESOURCE", `global '${changed.artifact.artifactType}' staging returned undefined`);
        }
        const liveEntry = Object.freeze({ artifact: changed.artifact, identity: changed.identity, resource });
        staged.push({ kind: "global", entry: liveEntry });
        nextGlobals.set(changed.artifact.artifactType, liveEntry);
        throwIfCancelled(request.signal);
      }

      for (const changed of changedChunks) {
        throwIfCancelled(request.signal);
        const artifactPayloads = [];
        for (const artifact of changed.chunk.artifacts) {
          failurePhase = "load";
          const bytes = await this.#loadVerifiedArtifact(
            request,
            artifact,
            { manifest: request.manifest, chunk: changed.chunk, artifact, signal: request.signal },
            artifactCache,
            timingsMs,
            counts,
          );
          artifactPayloads.push(Object.freeze({ artifact, bytes }));
        }

        failurePhase = "stage";
        phaseAt = this.#now();
        const resource = await this.#stageChunk(Object.freeze({
          manifest: request.manifest,
          chunk: changed.chunk,
          artifacts: freezeArray(artifactPayloads),
          signal: request.signal,
        }));
        timingsMs.stage += elapsed(this.#now, phaseAt);
        if (resource === undefined) throw new DerivedRevisionRuntimeError("INVALID_STAGED_RESOURCE", `chunk '${changed.chunk.chunkId}' staging returned undefined`);
        const liveEntry = Object.freeze({ chunk: changed.chunk, identity: changed.identity, resource });
        staged.push({ kind: "chunk", entry: liveEntry });
        nextChunks.set(changed.chunk.chunkId, liveEntry);
        throwIfCancelled(request.signal);
      }

      const orderedNextGlobals = new Map(manifestGlobals.map((artifact) => [artifact.artifactType, nextGlobals.get(artifact.artifactType)]));
      const orderedNextChunks = new Map(request.manifest.chunks.map((chunk) => [chunk.chunkId, nextChunks.get(chunk.chunkId)]));
      const replacedChunks = changedChunks
        .map((changed) => priorChunks.get(changed.chunk.chunkId))
        .filter((entry) => entry !== undefined);
      const replacedChunkIds = new Set(replacedChunks.map((entry) => entry.chunk.chunkId));
      const chunkRetirementQueue = [...replacedChunks, ...removedChunks].map((entry) => ({
        entry,
        reason: replacedChunkIds.has(entry.chunk.chunkId) ? "replaced" : "removed",
      }));
      const replacedGlobals = changedGlobals
        .map((changed) => priorGlobals.get(changed.artifact.artifactType))
        .filter((entry) => entry !== undefined);
      const replacedGlobalTypes = new Set(replacedGlobals.map((entry) => entry.artifact.artifactType));
      const globalRetirementQueue = [...replacedGlobals, ...removedGlobals].map((entry) => ({
        entry,
        reason: replacedGlobalTypes.has(entry.artifact.artifactType) ? "replaced" : "removed",
      }));
      const nextLive = Object.freeze({ manifest: request.manifest, chunks: orderedNextChunks, globals: orderedNextGlobals });
      failurePhase = "authority";
      phaseAt = this.#now();
      await this.#authoritativeSource(request.manifest);
      timingsMs.authority += elapsed(this.#now, phaseAt);
      throwIfCancelled(request.signal);

      failurePhase = "activation";
      request.activationStarted = true;
      phaseAt = this.#now();
      await this.#activateRevision(Object.freeze({
        manifest: request.manifest,
        previousManifest: this.#live?.manifest ?? null,
        chunks: publicChunks(orderedNextChunks),
        previousChunks: this.#live === null ? Object.freeze([]) : publicChunks(this.#live.chunks),
        globals: publicGlobals(orderedNextGlobals),
        previousGlobals: this.#live === null ? new Map() : publicGlobals(this.#live.globals),
        changedChunkIds: Object.freeze(changedChunks.map((entry) => entry.chunk.chunkId)),
        removedChunkIds: Object.freeze(removedChunks.map((entry) => entry.chunk.chunkId)),
        changedGlobalArtifactTypes: Object.freeze(changedGlobals.map((entry) => entry.artifact.artifactType)),
        removedGlobalArtifactTypes: Object.freeze(removedGlobals.map((entry) => entry.artifact.artifactType)),
        signal: request.signal,
      }));
      this.#live = nextLive;
      staged.length = 0;
      timingsMs.activation = elapsed(this.#now, phaseAt);

      failurePhase = "retirement";
      phaseAt = this.#now();
      const retirementErrors = [];
      let retirementFailureCount = 0;
      // Chunk resources can depend on global resources. Retire chunks first, then globals.
      for (const retirement of chunkRetirementQueue) {
        const { entry } = retirement;
        try {
          await this.#disposeChunk(Object.freeze({
            chunkId: entry.chunk.chunkId,
            chunk: entry.chunk,
            resource: entry.resource,
            reason: retirement.reason,
          }));
        } catch (error) {
          retirementFailureCount++;
          if (retirementErrors.length < MAX_DERIVED_RUNTIME_ERROR_SUMMARIES) retirementErrors.push(errorSummary(error));
        }
      }
      for (const retirement of globalRetirementQueue) {
        const { entry } = retirement;
        try {
          await this.#disposeGlobal(Object.freeze({
            artifactType: entry.artifact.artifactType,
            artifact: entry.artifact,
            resource: entry.resource,
            reason: retirement.reason,
          }));
        } catch (error) {
          retirementFailureCount++;
          if (retirementErrors.length < MAX_DERIVED_RUNTIME_ERROR_SUMMARIES) retirementErrors.push(errorSummary(error));
        }
      }
      timingsMs.retirement = elapsed(this.#now, phaseAt);
      counts.retirementFailures = retirementFailureCount;
      timingsMs.total = elapsed(this.#now, startedAt);
      const outcome = this.#outcome("activated", request.manifest, counts);
      this.#recordDiagnostic(request, "activated", { timingsMs, counts, errors: retirementErrors, errorCount: retirementFailureCount });
      return outcome;
    } catch (error) {
      const cleanup = await this.#disposeStaged(staged, failurePhase === "activation" ? "activation-failed" : error?.code === "DERIVED_REVISION_CANCELLED" ? "cancelled" : "staging-failed");
      timingsMs.total = elapsed(this.#now, startedAt);
      const errors = [errorSummary(error), ...cleanup.failures.map(errorSummary)].slice(0, MAX_DERIVED_RUNTIME_ERROR_SUMMARIES);
      this.#recordDiagnostic(request, error?.code === "DERIVED_REVISION_CANCELLED" ? "cancelled" : "failed", {
        phase: failurePhase,
        timingsMs,
        counts,
        errors,
        errorCount: 1 + cleanup.failureCount,
      });
      if (cleanup.failureCount > 0) {
        throw new AggregateError(
          [error, ...cleanup.failures].slice(0, MAX_DERIVED_RUNTIME_ERROR_SUMMARIES),
          `${errorSummary(error)}; ${cleanup.failureCount} staged resource cleanup operation(s) also failed`,
        );
      }
      throw error;
    }
  }

  async #disposeStaged(staged, reason) {
    const failures = [];
    let failureCount = 0;
    for (let index = staged.length - 1; index >= 0; index--) {
      const stagedEntry = staged[index];
      const entry = stagedEntry.entry;
      try {
        if (stagedEntry.kind === "chunk") {
          await this.#disposeChunk(Object.freeze({ chunkId: entry.chunk.chunkId, chunk: entry.chunk, resource: entry.resource, reason }));
        } else {
          await this.#disposeGlobal(Object.freeze({
            artifactType: entry.artifact.artifactType,
            artifact: entry.artifact,
            resource: entry.resource,
            reason,
          }));
        }
      } catch (error) {
        failureCount++;
        if (failures.length < MAX_DERIVED_RUNTIME_ERROR_SUMMARIES - 1) failures.push(error);
      }
    }
    return { failures, failureCount };
  }

  #outcome(status, manifest, counts) {
    return Object.freeze({
      status,
      manifestHash: manifest.manifestHash,
      revision: manifest.source.revision,
      changedChunks: counts.changed,
      unchangedChunks: counts.unchanged,
      removedChunks: counts.removed,
      changedGlobals: counts.changedGlobals,
      unchangedGlobals: counts.unchangedGlobals,
      removedGlobals: counts.removedGlobals,
      retirementFailures: counts.retirementFailures,
    });
  }

  #recordDiagnostic(request, status, details = {}) {
    const timingsMs = details.timingsMs ?? { authority: 0, load: 0, stage: 0, activation: 0, retirement: 0, total: elapsed(this.#now, request.queuedAt) };
    const counts = details.counts ?? {
      changed: 0, unchanged: 0, removed: 0,
      changedGlobals: 0, unchangedGlobals: 0, removedGlobals: 0,
      artifacts: 0, artifactBytes: 0, retirementFailures: 0,
    };
    const errorCount = details.errorCount ?? details.errors?.length ?? 0;
    const retainedErrors = [...(details.errors ?? [])].slice(0, MAX_DERIVED_RUNTIME_ERROR_SUMMARIES);
    this.#diagnostics.push(Object.freeze({
      manifestHash: request.manifest.manifestHash,
      revision: request.manifest.source.revision,
      status,
      phase: details.phase ?? null,
      changedChunks: counts.changed,
      unchangedChunks: counts.unchanged,
      removedChunks: counts.removed,
      changedGlobals: counts.changedGlobals,
      unchangedGlobals: counts.unchangedGlobals,
      removedGlobals: counts.removedGlobals,
      artifactsLoaded: counts.artifacts,
      artifactBytesLoaded: counts.artifactBytes,
      retirementFailures: counts.retirementFailures,
      errorCount,
      errorsTruncated: errorCount > retainedErrors.length,
      timingsMs: Object.freeze({ ...timingsMs }),
      errors: Object.freeze(retainedErrors),
    }));
    if (this.#diagnostics.length > this.#diagnosticsLimit) this.#diagnostics.splice(0, this.#diagnostics.length - this.#diagnosticsLimit);
  }
}
