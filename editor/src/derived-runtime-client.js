export const DERIVED_RUNTIME_WORKER_SCHEMA = "limina.derived-runtime-worker/v1";
export const DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA = "limina.derived-runtime-resource-snapshot/v1";
export const DERIVED_RUNTIME_DISCOVERY_SCHEMA = "limina.derived-runtime-access/v1";

const HASH = /^sha256:[0-9a-f]{64}$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BRANCH_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const TOKEN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTIVATION_ID = /^derived-activation-[1-9][0-9]{0,15}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const REF_ID = /^[a-z][a-z0-9._-]{0,95}$/;
const TYPED_ID = /^[a-z][a-z0-9._-]{0,95}\/v[1-9][0-9]*$/;
const REVISION_STATUSES = new Set(["activated", "unchanged", "superseded"]);
const MAX_CHUNKS = 16_384;
const MAX_GLOBALS = 64;
const DEFAULT_CLOSE_TIMEOUT_MS = 1_500;
const DEFAULT_WORKER_URL = new URL("../vendor/derived-runtime-worker-entry.js", import.meta.url);

let requestSequence = 0;

function protocolError(message) {
  const error = new Error(message);
  error.code = "DERIVED_RUNTIME_PROTOCOL_ERROR";
  return error;
}

function plainRecord(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw protocolError(`${label} must be a plain object`);
  }
  return value;
}

function exactDataKeys(value, required, optional, label) {
  const names = Object.getOwnPropertyNames(value);
  const allowed = new Set([...required, ...optional]);
  if (Object.getOwnPropertySymbols(value).length !== 0 || required.some((key) => !names.includes(key)) || names.some((key) => !allowed.has(key))) {
    throw protocolError(`${label} has unsupported or missing fields`);
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw protocolError(`${label}.${name} must be an enumerable data field`);
    }
  }
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw protocolError(`${label} must be a non-negative safe integer`);
  return value;
}

function contentHash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) throw protocolError(`${label} must be a canonical sha256 hash`);
  return value;
}

function identifier(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw protocolError(`${label} is invalid`);
  return value;
}

function validateSource(value, label) {
  const source = plainRecord(value, label);
  exactDataKeys(source, ["revision", "headHash", "contentRefs"], [], label);
  safeInteger(source.revision, `${label}.revision`);
  contentHash(source.headHash, `${label}.headHash`);
  if (!Array.isArray(source.contentRefs) || source.contentRefs.length < 1 || source.contentRefs.length > 64) {
    throw protocolError(`${label}.contentRefs must contain 1-64 entries`);
  }
  const refIds = new Set();
  for (let index = 0; index < source.contentRefs.length; index++) {
    const ref = plainRecord(source.contentRefs[index], `${label}.contentRefs[${index}]`);
    exactDataKeys(ref, ["refId", "refType", "scope", "assetId", "contentHash"], [], `${label}.contentRefs[${index}]`);
    identifier(ref.refId, REF_ID, `${label}.contentRefs[${index}].refId`);
    identifier(ref.refType, TYPED_ID, `${label}.contentRefs[${index}].refType`);
    if (ref.scope !== "global" && ref.scope !== "chunk") throw protocolError(`${label}.contentRefs[${index}].scope is invalid`);
    if (typeof ref.assetId !== "string" || ref.assetId.length === 0 || ref.assetId.length > 256 || ref.assetId.startsWith("/")
        || ref.assetId.includes("\\") || ref.assetId.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
      throw protocolError(`${label}.contentRefs[${index}].assetId is invalid`);
    }
    contentHash(ref.contentHash, `${label}.contentRefs[${index}].contentHash`);
    if (refIds.has(ref.refId)) throw protocolError(`${label}.contentRefs contains duplicate refId '${ref.refId}'`);
    refIds.add(ref.refId);
  }
  return source;
}

function validateManifest(value, snapshot, source) {
  const manifest = plainRecord(value, "derived snapshot manifest");
  if (manifest.schema === "limina.derived-revision-manifest/v1") {
    exactDataKeys(manifest, ["schema", "projectId", "branchId", "source", "compiler", "grid", "chunks", "manifestHash"], [], "derived snapshot manifest");
  } else if (manifest.schema === "limina.derived-revision-manifest/v2") {
    exactDataKeys(manifest, ["schema", "projectId", "branchId", "source", "compiler", "grid", "globalArtifacts", "chunks", "manifestHash"], [], "derived snapshot manifest");
    if (!Array.isArray(manifest.globalArtifacts) || manifest.globalArtifacts.length > MAX_GLOBALS) {
      throw protocolError("derived snapshot manifest.globalArtifacts must be a bounded array");
    }
  } else {
    throw protocolError("derived snapshot manifest schema is unsupported");
  }
  identifier(manifest.projectId, PROJECT_ID, "derived snapshot manifest.projectId");
  identifier(manifest.branchId, BRANCH_ID, "derived snapshot manifest.branchId");
  if (manifest.projectId !== snapshot.projectId || manifest.branchId !== snapshot.branchId) {
    throw protocolError("derived snapshot manifest identity does not match its envelope");
  }
  if (contentHash(manifest.manifestHash, "derived snapshot manifest.manifestHash") !== snapshot.manifestHash) {
    throw protocolError("derived snapshot manifest hash does not match its envelope");
  }
  const manifestSource = validateSource(manifest.source, "derived snapshot manifest.source");
  if (manifestSource.revision !== source.revision || manifestSource.headHash !== source.headHash || manifestSource.contentRefs !== source.contentRefs) {
    throw protocolError("derived snapshot source does not match its manifest");
  }
  if (!Array.isArray(manifest.chunks) || manifest.chunks.length > MAX_CHUNKS) {
    throw protocolError("derived snapshot manifest.chunks must be a bounded array");
  }
  plainRecord(manifest.compiler, "derived snapshot manifest.compiler");
  plainRecord(manifest.grid, "derived snapshot manifest.grid");
  return manifest;
}

function validateSnapshot(value, expected) {
  const snapshot = plainRecord(value, "derived activation snapshot");
  exactDataKeys(snapshot, ["schema", "projectId", "branchId", "manifestHash", "source", "manifest", "chunks", "globals"], [], "derived activation snapshot");
  if (snapshot.schema !== DERIVED_RUNTIME_RESOURCE_SNAPSHOT_SCHEMA) throw protocolError("derived activation snapshot schema is unsupported");
  identifier(snapshot.projectId, PROJECT_ID, "derived activation snapshot.projectId");
  identifier(snapshot.branchId, BRANCH_ID, "derived activation snapshot.branchId");
  if (snapshot.projectId !== expected.projectId || snapshot.branchId !== expected.branchId) {
    throw protocolError("derived activation snapshot belongs to another project or branch");
  }
  contentHash(snapshot.manifestHash, "derived activation snapshot.manifestHash");
  const source = validateSource(snapshot.source, "derived activation snapshot.source");
  validateManifest(snapshot.manifest, snapshot, source);
  if (!Array.isArray(snapshot.chunks) || snapshot.chunks.length > MAX_CHUNKS) {
    throw protocolError("derived activation snapshot.chunks must be a bounded array");
  }
  for (let index = 0; index < snapshot.chunks.length; index++) {
    const chunk = plainRecord(snapshot.chunks[index], `derived activation snapshot.chunks[${index}]`);
    exactDataKeys(chunk, ["chunkId", "chunk", "resource"], [], `derived activation snapshot.chunks[${index}]`);
    if (typeof chunk.chunkId !== "string" || chunk.chunkId.length === 0 || chunk.chunkId.length > 192) {
      throw protocolError(`derived activation snapshot.chunks[${index}].chunkId is invalid`);
    }
    plainRecord(chunk.chunk, `derived activation snapshot.chunks[${index}].chunk`);
  }
  if (!Array.isArray(snapshot.globals) || snapshot.globals.length > MAX_GLOBALS) {
    throw protocolError("derived activation snapshot.globals must be a bounded array");
  }
  for (let index = 0; index < snapshot.globals.length; index++) {
    const global = plainRecord(snapshot.globals[index], `derived activation snapshot.globals[${index}]`);
    exactDataKeys(global, ["artifactType", "artifact", "resource"], [], `derived activation snapshot.globals[${index}]`);
    if (typeof global.artifactType !== "string" || global.artifactType.length === 0 || global.artifactType.length > 128) {
      throw protocolError(`derived activation snapshot.globals[${index}].artifactType is invalid`);
    }
    plainRecord(global.artifact, `derived activation snapshot.globals[${index}].artifact`);
  }
  return snapshot;
}

function validateDiscovery(value) {
  const discovery = plainRecord(value, "derived runtime discovery");
  exactDataKeys(discovery, ["schema", "baseUrl", "token", "projectId", "branchId"], [], "derived runtime discovery");
  if (discovery.schema !== DERIVED_RUNTIME_DISCOVERY_SCHEMA) throw protocolError("derived runtime discovery schema is unsupported");
  let url;
  try { url = new URL(discovery.baseUrl); } catch { throw protocolError("derived runtime discovery baseUrl is invalid"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port === "" || url.origin !== discovery.baseUrl
      || url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw protocolError("derived runtime discovery baseUrl must be a canonical loopback origin");
  }
  if (typeof discovery.token !== "string" || !TOKEN.test(discovery.token)) throw protocolError("derived runtime discovery token is invalid");
  identifier(discovery.projectId, PROJECT_ID, "derived runtime discovery.projectId");
  identifier(discovery.branchId, BRANCH_ID, "derived runtime discovery.branchId");
  return discovery;
}

function validatePinnedSource(value) {
  const source = plainRecord(value, "derived pinned source");
  exactDataKeys(source, ["revision", "headHash"], [], "derived pinned source");
  return Object.freeze({
    revision: safeInteger(source.revision, "derived pinned source.revision"),
    headHash: contentHash(source.headHash, "derived pinned source.headHash"),
  });
}

function nextRequestId(prefix) {
  requestSequence = requestSequence >= Number.MAX_SAFE_INTEGER ? 1 : requestSequence + 1;
  return `${prefix}-${requestSequence}`;
}

export class DerivedRuntimeClient {
  #activate;
  #onStatus;
  #workerFactory;
  #workerUrl;
  #timers;
  #closeTimeoutMs;
  #worker;
  #phase = "idle";
  #mode;
  #expected;
  #initRequestId;
  #closeRequestId;
  #generation = 0;
  #activationId;
  #activationAbort;
  #closePromise;
  #resolveClose;
  #closeTimer;
  #pinnedRevision;
  #pinnedHeadHash;

  constructor({
    activate,
    onStatus = () => {},
    workerFactory = (url) => new Worker(url, { type: "module" }),
    workerUrl = DEFAULT_WORKER_URL,
    closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
    timers = globalThis,
  } = {}) {
    if (typeof activate !== "function") throw new TypeError("derived runtime activate callback is required");
    if (typeof onStatus !== "function") throw new TypeError("derived runtime status callback must be a function");
    if (typeof workerFactory !== "function") throw new TypeError("derived runtime workerFactory must be a function");
    if (!Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < 10 || closeTimeoutMs > 30_000) {
      throw new RangeError("derived runtime closeTimeoutMs must be an integer in [10, 30000]");
    }
    if (typeof timers?.setTimeout !== "function" || typeof timers?.clearTimeout !== "function") {
      throw new TypeError("derived runtime timers are invalid");
    }
    this.#activate = activate;
    this.#onStatus = onStatus;
    this.#workerFactory = workerFactory;
    this.#workerUrl = workerUrl;
    this.#closeTimeoutMs = closeTimeoutMs;
    this.#timers = timers;
  }

  get phase() { return this.#phase; }
  get mode() { return this.#mode; }

  start(discoveryInput, { mode = "watch", pinnedSource } = {}) {
    if (this.#phase !== "idle") throw new Error("derived runtime client can only be started once");
    if (mode !== "watch" && mode !== "pinned") throw new TypeError("derived runtime mode must be watch or pinned");
    if ((mode === "pinned") !== (pinnedSource !== undefined)) throw new TypeError("pinned mode requires pinnedSource and watch mode forbids it");
    const discovery = validateDiscovery(discoveryInput);
    const pin = pinnedSource === undefined ? undefined : validatePinnedSource(pinnedSource);
    const worker = this.#workerFactory(this.#workerUrl);
    if (!worker || typeof worker.postMessage !== "function" || typeof worker.terminate !== "function") {
      try { worker?.terminate?.(); } catch { /* best effort for an invalid injected worker */ }
      throw new TypeError("derived runtime workerFactory returned an invalid worker");
    }
    const generation = ++this.#generation;
    this.#worker = worker;
    this.#phase = "starting";
    this.#mode = mode;
    this.#pinnedRevision = pin?.revision;
    this.#pinnedHeadHash = pin?.headHash;
    this.#expected = Object.freeze({ projectId: discovery.projectId, branchId: discovery.branchId });
    this.#initRequestId = nextRequestId("derived-init");
    worker.onmessage = (event) => { void this.#handleMessage(event?.data, generation); };
    worker.onerror = () => { this.#failProtocol("WORKER_ERROR", generation); };
    try {
      worker.postMessage({
        schema: DERIVED_RUNTIME_WORKER_SCHEMA,
        type: "init",
        requestId: this.#initRequestId,
        config: {
          baseUrl: discovery.baseUrl,
          token: discovery.token,
          projectId: discovery.projectId,
          branchId: discovery.branchId,
        },
        mode,
        ...(pin === undefined ? {} : { pinnedSource: pin }),
      });
    } catch (error) {
      this.#terminate();
      this.#phase = "closed";
      throw error;
    }
    this.#emit({ phase: "starting", mode });
    return this;
  }

  async #handleMessage(input, generation) {
    if (generation !== this.#generation || this.#phase === "closing" || this.#phase === "closed") return;
    try {
      const message = plainRecord(input, "derived runtime worker output");
      if (message.schema !== DERIVED_RUNTIME_WORKER_SCHEMA || typeof message.type !== "string") {
        throw protocolError("derived runtime worker output schema/type is invalid");
      }
      if (message.type === "ready") {
        exactDataKeys(message, ["schema", "type", "requestId", "mode"], [], "derived runtime ready");
        if (message.requestId !== this.#initRequestId || !REQUEST_ID.test(message.requestId) || message.mode !== this.#mode || this.#phase !== "starting") {
          throw protocolError("derived runtime ready does not match its initialization");
        }
        this.#phase = "ready";
        this.#emit({ phase: "ready", mode: this.#mode });
        return;
      }
      if (message.type === "activate") {
        exactDataKeys(message, ["schema", "type", "activationId", "snapshot"], [], "derived runtime activation");
        if (typeof message.activationId !== "string" || !ACTIVATION_ID.test(message.activationId) || this.#activationId !== undefined || this.#phase === "starting") {
          throw protocolError("derived runtime activation identity or ordering is invalid");
        }
        const snapshot = validateSnapshot(message.snapshot, this.#expected);
        if (this.#mode === "pinned" && (snapshot.source.revision !== this.#pinnedRevision || snapshot.source.headHash !== this.#pinnedHeadHash)) {
          throw protocolError("derived runtime activation does not match the pinned source");
        }
        this.#activationId = message.activationId;
        const activationAbort = new AbortController();
        this.#activationAbort = activationAbort;
        this.#emit({ phase: "activating", mode: this.#mode, revision: snapshot.source.revision, manifestHash: snapshot.manifestHash });
        try {
          await this.#activate(snapshot, Object.freeze({ signal: activationAbort.signal }));
          if (generation !== this.#generation || this.#phase === "closing" || this.#phase === "closed" || this.#activationId !== message.activationId) return;
          this.#worker.postMessage({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "activation-ack", activationId: message.activationId, accepted: true });
          this.#emit({ phase: "activated", mode: this.#mode, revision: snapshot.source.revision, manifestHash: snapshot.manifestHash });
        } catch {
          if (generation !== this.#generation || this.#phase === "closing" || this.#phase === "closed" || this.#activationId !== message.activationId) return;
          this.#worker.postMessage({
            schema: DERIVED_RUNTIME_WORKER_SCHEMA,
            type: "activation-ack",
            activationId: message.activationId,
            accepted: false,
            errorCode: "VIEWPORT_ACTIVATION_FAILED",
          });
          this.#emit({ phase: "activation-failed", mode: this.#mode, code: "VIEWPORT_ACTIVATION_FAILED" });
        } finally {
          if (this.#activationAbort === activationAbort) this.#activationAbort = undefined;
          if (generation === this.#generation && this.#activationId === message.activationId) this.#activationId = undefined;
        }
        return;
      }
      if (message.type === "revision") {
        exactDataKeys(message, ["schema", "type", "status", "manifestHash", "revision"], [], "derived runtime revision");
        if (this.#phase !== "ready" || this.#activationId !== undefined || !REVISION_STATUSES.has(message.status)) {
          throw protocolError("derived runtime revision status or ordering is invalid");
        }
        contentHash(message.manifestHash, "derived runtime revision.manifestHash");
        safeInteger(message.revision, "derived runtime revision.revision");
        this.#emit({ phase: "revision", mode: this.#mode, status: message.status, revision: message.revision, manifestHash: message.manifestHash });
        return;
      }
      if (message.type === "error") {
        exactDataKeys(message, ["schema", "type", "code", "classification", "message"], [], "derived runtime error");
        if (typeof message.code !== "string" || !ERROR_CODE.test(message.code)
            || (message.classification !== "transient" && message.classification !== "fatal")
            || typeof message.message !== "string" || message.message.length > 512) {
          throw protocolError("derived runtime error payload is invalid");
        }
        this.#emit({ phase: "error", mode: this.#mode, code: message.code, classification: message.classification });
        if (message.classification === "fatal") void this.close();
        return;
      }
      if (message.type === "closed") throw protocolError("derived runtime worker closed without a client close request");
      throw protocolError("derived runtime worker output type is unsupported");
    } catch {
      this.#failProtocol("PROTOCOL_ERROR", generation);
    }
  }

  #emit(status) {
    const safe = Object.freeze({ ...status });
    try { this.#onStatus(safe); }
    catch (error) {
      if (typeof globalThis.reportError === "function") globalThis.reportError(error);
    }
  }

  #failProtocol(code, generation) {
    if (generation !== this.#generation || this.#phase === "closing" || this.#phase === "closed") return;
    this.#emit({ phase: "error", mode: this.#mode, code, classification: "fatal" });
    void this.close();
  }

  close() {
    if (this.#closePromise !== undefined) return this.#closePromise;
    if (this.#phase === "closed") return Promise.resolve();
    this.#phase = "closing";
    this.#activationAbort?.abort(new Error("derived runtime client closed during activation"));
    this.#activationAbort = undefined;
    const generation = ++this.#generation;
    const worker = this.#worker;
    if (worker === undefined) {
      this.#phase = "closed";
      return Promise.resolve();
    }
    this.#closeRequestId = nextRequestId("derived-close");
    this.#closePromise = new Promise((resolve) => { this.#resolveClose = resolve; });
    worker.onmessage = (event) => {
      if (generation !== this.#generation || this.#phase !== "closing") return;
      try {
        const message = plainRecord(event?.data, "derived runtime close output");
        exactDataKeys(message, ["schema", "type", "requestId"], [], "derived runtime close output");
        if (message.schema !== DERIVED_RUNTIME_WORKER_SCHEMA || message.type !== "closed" || message.requestId !== this.#closeRequestId) {
          throw protocolError("derived runtime close acknowledgement does not match the request");
        }
        this.#finishClose();
      } catch {
        this.#emit({ phase: "error", mode: this.#mode, code: "PROTOCOL_ERROR", classification: "fatal" });
        this.#finishClose();
      }
    };
    worker.onerror = () => { if (generation === this.#generation) this.#finishClose(); };
    this.#closeTimer = this.#timers.setTimeout(() => this.#finishClose(), this.#closeTimeoutMs);
    try {
      worker.postMessage({ schema: DERIVED_RUNTIME_WORKER_SCHEMA, type: "close", requestId: this.#closeRequestId });
    } catch {
      this.#finishClose();
    }
    return this.#closePromise;
  }

  #finishClose() {
    if (this.#phase === "closed") return;
    if (this.#closeTimer !== undefined) {
      this.#timers.clearTimeout(this.#closeTimer);
      this.#closeTimer = undefined;
    }
    this.#terminate();
    this.#phase = "closed";
    this.#activationId = undefined;
    this.#emit({ phase: "closed", mode: this.#mode });
    const resolve = this.#resolveClose;
    this.#resolveClose = undefined;
    resolve?.();
  }

  #terminate() {
    const worker = this.#worker;
    this.#worker = undefined;
    if (worker === undefined) return;
    worker.onmessage = null;
    worker.onerror = null;
    try { worker.terminate(); } catch { /* termination is best effort */ }
  }
}

export function createDerivedRuntimeClient(options) {
  return new DerivedRuntimeClient(options);
}
