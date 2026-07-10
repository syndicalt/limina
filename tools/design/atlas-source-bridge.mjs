import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { migrateMapDoc, serializeMapDoc } from "./map-doc.mjs";
import { canonicalMapDocText, MAX_CANONICAL_MAPDOC_BYTES } from "../../js/src/world/mapdoc-canonical.mjs";

const MAX_MAPDOC_BYTES = MAX_CANONICAL_MAPDOC_BYTES;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ASSET_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const WORKSPACE_LOCK_NAME = ".atlas-map-save.lock";
const MAX_MAPS = 256;

export class AtlasSourceBridgeError extends Error {
  constructor(code, message, { status = 500, details, cause, committed = false } = {}) {
    super(message, { cause });
    this.name = "AtlasSourceBridgeError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.committed = committed;
  }

  response() {
    return {
      ok: false,
      error: this.message,
      code: this.code,
      ...(this.status === 409 ? { conflict: true } : {}),
      ...(this.committed ? { committed: true } : {}),
      ...(typeof this.details?.mapsRev === "string" ? { mapsRev: this.details.mapsRev } : {}),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

function within(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function containedDirectory(projectRoot, candidateInput, label) {
  const candidate = resolve(candidateInput);
  if (!within(projectRoot, candidate)) throw new AtlasSourceBridgeError("invalid_project_path", `${label} is outside the project root`);
  let stat;
  try { stat = lstatSync(candidate); }
  catch (error) { throw new AtlasSourceBridgeError("invalid_project_path", `cannot inspect ${label}: ${error.message}`, { cause: error }); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new AtlasSourceBridgeError("invalid_project_path", `${label} must be a real directory, not a symlink`);
  }
  const real = realpathSync(candidate);
  if (!within(projectRoot, real)) throw new AtlasSourceBridgeError("invalid_project_path", `${label} resolves outside the project root`);
  return real;
}

function ensureChildDirectory(root, segments) {
  let current = root;
  for (const segment of segments) {
    if (!ASSET_SEGMENT_PATTERN.test(segment) || segment === "." || segment === "..") {
      throw new AtlasSourceBridgeError("invalid_project_path", `invalid source directory segment '${segment}'`);
    }
    current = join(current, segment);
    try { mkdirSync(current, { mode: 0o755 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new AtlasSourceBridgeError("invalid_project_path", `source directory is not a real directory: ${current}`);
    }
    const real = realpathSync(current);
    if (!within(root, real)) throw new AtlasSourceBridgeError("invalid_project_path", `source directory escapes its asset root: ${current}`);
    current = real;
  }
  return current;
}

function fsyncDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    if (!(["EINVAL", "ENOTSUP", "EISDIR"].includes(error?.code))) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function canonicalValue(value, path = "$", active = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AtlasSourceBridgeError("invalid_mapdoc", `${path} must be a finite JSON number`, { status: 400 });
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new AtlasSourceBridgeError("invalid_mapdoc", `${path} is not a JSON value`, { status: 400 });
  if (active.has(value)) throw new AtlasSourceBridgeError("invalid_mapdoc", `${path} contains a cycle`, { status: 400 });
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) throw new AtlasSourceBridgeError("invalid_mapdoc", `${path} contains symbol properties`, { status: 400 });
      const names = Object.getOwnPropertyNames(value);
      const expected = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
      if (names.length !== expected.size || names.some((name) => !expected.has(name))) {
        throw new AtlasSourceBridgeError("invalid_mapdoc", `${path} contains sparse or custom array entries`, { status: 400 });
      }
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
          throw new AtlasSourceBridgeError("invalid_mapdoc", `${path}[${index}] must be an enumerable data property`, { status: 400 });
        }
      }
      return value.map((entry, index) => canonicalValue(entry, `${path}[${index}]`, active));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AtlasSourceBridgeError("invalid_mapdoc", `${path} must be a plain JSON object`, { status: 400 });
    }
    if (Object.getOwnPropertySymbols(value).length > 0) throw new AtlasSourceBridgeError("invalid_mapdoc", `${path} contains symbol properties`, { status: 400 });
    const names = Object.getOwnPropertyNames(value);
    for (const key of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
        throw new AtlasSourceBridgeError("invalid_mapdoc", `${path}.${key} must be an enumerable data property`, { status: 400 });
      }
    }
    const output = Object.create(null);
    for (const key of names.sort()) output[key] = canonicalValue(value[key], `${path}.${key}`, active);
    return output;
  } finally { active.delete(value); }
}

export function canonicalMapDocBytes(doc) {
  try {
    return Buffer.from(canonicalMapDocText(doc), "utf8");
  } catch (error) {
    if (error instanceof AtlasSourceBridgeError) throw error;
    const tooLarge = error instanceof Error && error.message.includes("canonical MapDoc exceeds");
    throw new AtlasSourceBridgeError(
      tooLarge ? "mapdoc_too_large" : "invalid_mapdoc",
      error instanceof Error ? error.message : "MapDoc canonicalization failed",
      { status: tooLarge ? 413 : 400, cause: error },
    );
  }
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function hashCanonical(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function exactKeys(value, required, optional = []) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function readNoFollow(path, { missing = false, maximum = MAX_MAPDOC_BYTES } = {}) {
  let descriptor;
  try { descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if (missing && error?.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    if (stat.size > maximum) throw new Error(`${path} exceeds ${maximum} bytes`);
    return readFileSync(descriptor);
  } finally { closeSync(descriptor); }
}

function validateExistingSource(path, expected) {
  const actual = readNoFollow(path, { maximum: expected.length });
  if (!actual.equals(expected)) {
    throw new AtlasSourceBridgeError("source_hash_collision", `content-addressed source is corrupt or collided: ${path}`);
  }
}

/** Persist immutable source bytes without overwriting an existing hash path. */
export function persistMapDocSource({ projectRoot, assetRoot, bytes }) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  const hash = `sha256:${digest}`;
  const sourceDir = ensureChildDirectory(assetRoot, ["sources", "map-doc"]);
  const path = join(sourceDir, `${digest}.mapdoc.json`);
  try {
    validateExistingSource(path, bytes);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const temporary = join(sourceDir, `.${digest}.${process.pid}.${randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644);
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try { linkSync(temporary, path); }
      catch (linkError) {
        if (linkError?.code !== "EEXIST") throw linkError;
      }
      validateExistingSource(path, bytes);
      fsyncDirectory(sourceDir);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporary, { force: true });
    }
  }
  const assetId = relative(projectRoot, path).split(sep).join("/");
  if (assetId.length > 256 || !assetId.split("/").every((segment) => ASSET_SEGMENT_PATTERN.test(segment) && segment !== "." && segment !== "..")) {
    throw new AtlasSourceBridgeError("invalid_project_path", `source asset id is not portable: ${assetId}`);
  }
  return Object.freeze({ assetId, hash, path, bytes: bytes.length });
}

export function workspaceRevision(bytes) {
  return bytes === undefined ? "0" : createHash("sha1").update(bytes).digest("hex").slice(0, 16);
}

function readWorkspace(path) {
  let bytes;
  try { bytes = readNoFollow(path, { missing: true }); }
  catch (error) {
    throw new AtlasSourceBridgeError("workspace_read_failed", `cannot safely read Atlas workspace MapDoc: ${error.message}`, { cause: error });
  }
  let raw = {};
  if (bytes !== undefined) {
    try { raw = JSON.parse(bytes.toString("utf8")); }
    catch (error) { throw new AtlasSourceBridgeError("invalid_workspace_mapdoc", `Atlas workspace maps.json is invalid JSON: ${error.message}`, { cause: error }); }
    if (raw === null || Array.isArray(raw) || typeof raw !== "object") {
      throw new AtlasSourceBridgeError("invalid_workspace_mapdoc", "Atlas workspace maps.json must contain an object");
    }
  }
  return { bytes, raw, revision: workspaceRevision(bytes) };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function readLockOwner(lockPath) {
  const stat = lstatSync(lockPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new AtlasSourceBridgeError("workspace_lock_invalid", `Atlas workspace lock is not a real file: ${lockPath}`);
  }
  let owner;
  try { owner = JSON.parse(readNoFollow(lockPath, { maximum: 4096 }).toString("utf8")); }
  catch (error) { throw new AtlasSourceBridgeError("workspace_lock_invalid", `Atlas workspace lock owner is invalid: ${error.message}`, { cause: error }); }
  if (!owner || typeof owner !== "object" || !Number.isInteger(owner.pid) || owner.pid < 1
      || typeof owner.token !== "string" || !/^[0-9a-f]{32}$/.test(owner.token)
      || typeof owner.createdAt !== "string" || !Number.isFinite(Date.parse(owner.createdAt))) {
    throw new AtlasSourceBridgeError("workspace_lock_invalid", "Atlas workspace lock owner has an invalid schema");
  }
  return owner;
}

function acquireWorkspaceLock(vaultDir) {
  const lockPath = join(vaultDir, WORKSPACE_LOCK_NAME);
  const token = createHash("sha256").update(`${process.pid}:${randomUUID()}`).digest("hex").slice(0, 32);
  for (let attempt = 0; attempt < 3; attempt++) {
    let descriptor;
    let created = false;
    try {
      const owner = { pid: process.pid, token, createdAt: new Date().toISOString() };
      descriptor = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      created = true;
      writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      fsyncDirectory(vaultDir);
      return { lockPath, owner };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error?.code !== "EEXIST") {
        if (created) {
          rmSync(lockPath, { force: true });
          fsyncDirectory(vaultDir);
        }
        throw new AtlasSourceBridgeError("workspace_lock_failed", `cannot acquire Atlas workspace lock: ${error.message}`, { cause: error });
      }
      let owner;
      try { owner = readLockOwner(lockPath); }
      catch (lockError) {
        let ageMs = Number.POSITIVE_INFINITY;
        try { ageMs = Math.max(0, Date.now() - lstatSync(lockPath).mtimeMs); } catch { /* lock changed; retry below */ }
        if (ageMs < 30_000) {
          throw new AtlasSourceBridgeError("workspace_busy", "Atlas workspace lock publication is still in progress", { status: 423 });
        }
        const invalidPath = `${lockPath}.invalid.${token}.${randomUUID()}`;
        try { renameSync(lockPath, invalidPath); }
        catch (renameError) {
          if (renameError?.code === "ENOENT") continue;
          throw lockError;
        }
        rmSync(invalidPath, { recursive: true, force: true });
        fsyncDirectory(vaultDir);
        continue;
      }
      if (processIsAlive(owner.pid)) {
        throw new AtlasSourceBridgeError("workspace_busy", `Atlas workspace is being saved by process ${owner.pid}`, {
          status: 423,
          details: { owner: { pid: owner.pid, createdAt: owner.createdAt } },
        });
      }
      const stalePath = `${lockPath}.stale.${owner.token}.${randomUUID()}`;
      try { renameSync(lockPath, stalePath); }
      catch (renameError) {
        if (renameError?.code === "ENOENT") continue;
        throw new AtlasSourceBridgeError("workspace_lock_failed", `cannot quarantine stale Atlas workspace lock: ${renameError.message}`, { cause: renameError });
      }
      const movedOwner = readLockOwner(stalePath);
      if (movedOwner.token !== owner.token) {
        throw new AtlasSourceBridgeError("workspace_lock_invalid", "Atlas workspace lock changed while stale ownership was verified");
      }
      rmSync(stalePath, { recursive: true, force: true });
      fsyncDirectory(vaultDir);
    }
  }
  throw new AtlasSourceBridgeError("workspace_lock_failed", "Atlas workspace lock changed repeatedly during acquisition");
}

function releaseWorkspaceLock(vaultDir, lease) {
  const releasePath = `${lease.lockPath}.release.${lease.owner.token}.${randomUUID()}`;
  renameSync(lease.lockPath, releasePath);
  const owner = readLockOwner(releasePath);
  if (owner.token !== lease.owner.token || owner.pid !== lease.owner.pid) {
    throw new AtlasSourceBridgeError("workspace_lock_invalid", "Atlas workspace lock ownership changed before release");
  }
  rmSync(releasePath, { force: true });
  fsyncDirectory(vaultDir);
}

export function atomicWriteWorkspace(path, bytes) {
  const directory = dirname(path);
  const temporary = join(directory, `.maps.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function validateHead(input, projectId) {
  if (!exactKeys(input, ["schema", "projectId", "revision", "headHash"])
      || input.schema !== "limina.world-project-head/v1" || input.projectId !== projectId
      || !Number.isSafeInteger(input.revision) || input.revision < 0 || !HASH_PATTERN.test(input.headHash)) {
    throw new AtlasSourceBridgeError("invalid_authority_response", "authority returned an invalid or wrong-project head", { status: 502 });
  }
  return input;
}

function validateProjectState(input, projectId) {
  const mapDoc = input?.refs?.mapDoc;
  if (!exactKeys(input, ["schema", "projectId", "refs", "stateHash"])
      || input.schema !== "limina.world-project-state/v1" || input.projectId !== projectId
      || !HASH_PATTERN.test(input.stateHash) || !input.refs || typeof input.refs !== "object"
      || !exactKeys(input.refs, ["mapDoc", "terrainEditLayers", "scene", "assets", "lookProfile"])
      || !Array.isArray(input.refs.terrainEditLayers) || !Array.isArray(input.refs.assets)
      || (mapDoc !== null && (!exactKeys(mapDoc, ["assetId", "hash"])
        || typeof mapDoc.assetId !== "string" || !HASH_PATTERN.test(mapDoc.hash)))) {
    throw new AtlasSourceBridgeError("invalid_authority_response", "authority returned invalid or wrong-project state", { status: 502 });
  }
  const expectedStateHash = hashCanonical({
    schema: "limina.world-project-state/v1",
    projectId,
    refs: input.refs,
  });
  if (input.stateHash !== expectedStateHash) {
    throw new AtlasSourceBridgeError("invalid_authority_response", "authority returned a project state with an invalid binding hash", { status: 502 });
  }
  return input;
}

function validateSourceSnapshot(input, projectId) {
  if (!exactKeys(input, ["schema", "head", "projectState", "snapshotHash"])
      || input.schema !== "limina.world-project-source-snapshot/v1"
      || !HASH_PATTERN.test(input.snapshotHash)) {
    throw new AtlasSourceBridgeError("invalid_authority_response", "authoring.sourceSnapshot returned an invalid envelope", { status: 502 });
  }
  const head = validateHead(input.head, projectId);
  const projectState = validateProjectState(input.projectState, projectId);
  const expectedSnapshotHash = hashCanonical({
    schema: "limina.world-project-source-snapshot/v1",
    head,
    projectState,
  });
  if (input.snapshotHash !== expectedSnapshotHash) {
    throw new AtlasSourceBridgeError("invalid_authority_response", "authoring.sourceSnapshot returned an invalid binding hash", { status: 502 });
  }
  return { head, projectState, snapshotHash: input.snapshotHash };
}

function sameReference(left, right) {
  return left?.assetId === right.assetId && left?.hash === right.hash;
}

function validateSavePayload(maps, activeMapId) {
  if (!Array.isArray(maps) || maps.length < 1 || maps.length > MAX_MAPS) {
    throw new AtlasSourceBridgeError("invalid_mapdoc", `Atlas save requires 1-${MAX_MAPS} maps`, { status: 400 });
  }
  const ids = new Set();
  for (let index = 0; index < maps.length; index++) {
    const map = maps[index];
    if (!map || Array.isArray(map) || typeof map !== "object" || typeof map.id !== "string"
        || map.id.length < 1 || map.id.length > 128) {
      throw new AtlasSourceBridgeError("invalid_mapdoc", `Atlas map ${index} requires a 1-128 character id`, { status: 400 });
    }
    if (ids.has(map.id)) throw new AtlasSourceBridgeError("invalid_mapdoc", `Atlas map id '${map.id}' is duplicated`, { status: 400 });
    ids.add(map.id);
  }
  if (typeof activeMapId !== "string" || !ids.has(activeMapId)) {
    throw new AtlasSourceBridgeError("invalid_mapdoc", "activeMapId must identify one submitted Atlas map", { status: 400 });
  }
}

function transactionFor(projectId, head, projectState, source) {
  const digest = source.hash.slice("sha256:".length);
  return {
    schema: "limina.authoring-transaction/v1",
    transactionId: `atlas-mapdoc-${digest}-${head.headHash.slice("sha256:".length, "sha256:".length + 32)}`,
    projectId,
    baseRevision: head.revision,
    baseHeadHash: head.headHash,
    operations: [{
      adapter: "project-state",
      adapterVersion: "1.0.0",
      action: "refs.patch",
      input: { projectId, patch: { mapDoc: { assetId: source.assetId, hash: source.hash } } },
      guard: { beforeHash: projectState.stateHash },
    }],
  };
}

export function validateAuthoringProjectStateCommit(input, transaction, projectState, sourceRef) {
  const receipt = input?.receipt;
  const operationReceipt = receipt?.operations?.[0];
  const expectedTransactionHash = hashCanonical(transaction);
  const expectedAfterStateHash = hashCanonical({
    schema: "limina.world-project-state/v1",
    projectId: transaction.projectId,
    refs: { ...projectState.refs, mapDoc: sourceRef },
  });
  if (!input || typeof input.committed !== "boolean" || !receipt
      || !exactKeys(input, ["committed", "commitRecord", "receipt"])
      || !exactKeys(receipt, [
        "schema", "transactionId", "projectId", "transactionHash", "previousRevision", "committedRevision",
        "previousHeadHash", "headHash", "operations",
      ], ["compensates"])
      || receipt.schema !== "limina.authoring-receipt/v1"
      || receipt.transactionId !== transaction.transactionId || receipt.projectId !== transaction.projectId
      || receipt.transactionHash !== expectedTransactionHash
      || receipt.previousRevision !== transaction.baseRevision || receipt.previousHeadHash !== transaction.baseHeadHash
      || receipt.committedRevision !== transaction.baseRevision + 1 || !HASH_PATTERN.test(receipt.headHash)
      || !Array.isArray(receipt.operations) || receipt.operations.length !== 1
      || !exactKeys(operationReceipt, ["index", "adapter", "action", "stateKey", "beforeStateHash", "afterStateHash"])
      || operationReceipt.index !== 0 || operationReceipt.adapter !== "project-state"
      || operationReceipt.action !== "refs.patch"
      || operationReceipt.stateKey !== `world-project:${transaction.projectId}:refs`
      || operationReceipt.beforeStateHash !== projectState.stateHash
      || operationReceipt.afterStateHash !== expectedAfterStateHash) {
    throw new AtlasSourceBridgeError("invalid_authority_response", "authoring.commit returned a receipt inconsistent with the Atlas transaction", { status: 502 });
  }
  const expectedHeadHash = hashCanonical({
    schema: "limina.world-project-head/v1",
    projectId: transaction.projectId,
    revision: receipt.committedRevision,
    parentHash: transaction.baseHeadHash,
    transactionHash: expectedTransactionHash,
    operations: receipt.operations,
  });
  if (receipt.headHash !== expectedHeadHash) {
    throw new AtlasSourceBridgeError("invalid_authority_response", "authoring.commit returned an invalid derived head hash", { status: 502 });
  }
  const record = input.commitRecord;
  if (!exactKeys(record, ["schema", "previousRecordHash", "receipt", "recordHash"])
      || record.schema !== "limina.authoring-commit-record/v1"
      || !(record.previousRecordHash === null || HASH_PATTERN.test(record.previousRecordHash))
      || canonicalJson(record.receipt) !== canonicalJson(receipt)
      || record.recordHash !== hashCanonical({
        schema: "limina.authoring-commit-record/v1",
        previousRecordHash: record.previousRecordHash,
        receipt,
      })) {
    throw new AtlasSourceBridgeError("invalid_authority_response", "authoring.commit returned invalid durable commit evidence", { status: 502 });
  }
  return { committed: input.committed, receipt };
}

function authorityError(error, source) {
  const mcpCode = error?.data?.error?.code ?? error?.code;
  if (mcpCode === "conflict" || mcpCode === -32009) {
    return new AtlasSourceBridgeError("authoring_conflict", `Atlas source was stored but the authoritative head changed: ${error.message}`, {
      status: 409,
      details: { source: { assetId: source.assetId, hash: source.hash } },
      cause: error,
    });
  }
  return new AtlasSourceBridgeError("authoring_unavailable", `Atlas source was stored but could not be committed: ${error.message}`, {
    status: 503,
    details: { source: { assetId: source.assetId, hash: source.hash } },
    cause: error,
  });
}

export class AtlasMapDocBridge {
  constructor({ projectConfig, vaultDir, assetRoot, authoringClient, sourceWriter = persistMapDocSource, mirrorWriter = atomicWriteWorkspace }) {
    if (!projectConfig || !PROJECT_ID_PATTERN.test(projectConfig.projectId) || typeof projectConfig.projectRoot !== "string") {
      throw new AtlasSourceBridgeError("invalid_project", "Atlas bridge requires canonical Limina project configuration");
    }
    const projectRoot = containedDirectory(realpathSync(resolve(projectConfig.projectRoot)), projectConfig.projectRoot, "project root");
    this.projectId = projectConfig.projectId;
    this.projectRoot = projectRoot;
    this.vaultDir = containedDirectory(projectRoot, vaultDir, "design vault");
    this.assetRoot = containedDirectory(projectRoot, assetRoot, "asset root");
    this.workspacePath = join(this.vaultDir, "maps.json");
    this.authoringClient = authoringClient;
    this.sourceWriter = sourceWriter;
    this.mirrorWriter = mirrorWriter;
    this.tail = Promise.resolve();
  }

  save(input) {
    const execute = async () => {
      const lease = acquireWorkspaceLock(this.vaultDir);
      let result;
      let failure;
      try { result = await this.#save(input); }
      catch (error) { failure = error; }
      try { releaseWorkspaceLock(this.vaultDir, lease); }
      catch (releaseError) {
        if (failure === undefined) throw releaseError;
        throw new AtlasSourceBridgeError(
          "workspace_lock_release_failed",
          `Atlas save failed and its workspace lock could not be released: ${releaseError.message}`,
          { cause: failure },
        );
      }
      if (failure !== undefined) throw failure;
      return result;
    };
    const run = this.tail.then(execute, execute);
    this.tail = run.catch(() => {});
    return run;
  }

  async #save({ maps, activeMapId, baseRev }) {
    const workspace = readWorkspace(this.workspacePath);
    if (typeof baseRev !== "string" || baseRev !== workspace.revision) {
      throw new AtlasSourceBridgeError("workspace_stale", "Atlas workspace changed since this client loaded it", {
        status: 409,
        details: { mapsRev: workspace.revision },
      });
    }

    validateSavePayload(maps, activeMapId);
    const serialized = serializeMapDoc(maps, activeMapId, workspace.raw);
    const { doc } = migrateMapDoc(serialized, this.projectId);
    const sourceBytes = canonicalMapDocBytes(doc);
    let source;
    try { source = this.sourceWriter({ projectRoot: this.projectRoot, assetRoot: this.assetRoot, bytes: sourceBytes }); }
    catch (error) {
      if (error instanceof AtlasSourceBridgeError) throw error;
      throw new AtlasSourceBridgeError("source_persist_failed", `failed to persist canonical Atlas source: ${error.message}`, { cause: error });
    }
    const sourceRef = { assetId: source.assetId, hash: source.hash };

    let authoring;
    try {
      const snapshot = validateSourceSnapshot(
        await this.authoringClient.callTool("authoring.sourceSnapshot", {}),
        this.projectId,
      );
      const { head, projectState } = snapshot;
      if (sameReference(projectState.refs.mapDoc, sourceRef)) {
        const confirmed = validateSourceSnapshot(
          await this.authoringClient.callTool("authoring.sourceSnapshot", {}),
          this.projectId,
        );
        if (confirmed.snapshotHash !== snapshot.snapshotHash) {
          throw new AtlasSourceBridgeError("authoring_conflict", "authoritative head changed while confirming an idempotent Atlas save", { status: 409 });
        }
        authoring = { committed: false, head: confirmed.head };
      } else {
        const transaction = transactionFor(this.projectId, head, projectState, source);
        authoring = validateAuthoringProjectStateCommit(
          await this.authoringClient.callTool("authoring.commit", { transaction }, { retryTransport: true }),
          transaction,
          projectState,
          sourceRef,
        );
      }
    } catch (error) {
      if (error instanceof AtlasSourceBridgeError) throw error;
      throw authorityError(error, source);
    }

    let confirmedSnapshot;
    try {
      confirmedSnapshot = validateSourceSnapshot(
        await this.authoringClient.callTool("authoring.sourceSnapshot", {}),
        this.projectId,
      );
    } catch (error) {
      throw new AtlasSourceBridgeError("post_commit_verification_failed", `Atlas source may be committed, but its authoritative ref could not be verified: ${error.message}`, {
        status: 503,
        committed: true,
        details: { source: sourceRef, authoring },
        cause: error,
      });
    }
    if (!sameReference(confirmedSnapshot.projectState.refs.mapDoc, sourceRef)) {
      throw new AtlasSourceBridgeError("authoring_advanced", "Atlas source committed, but another authoritative MapDoc superseded it before workspace publication", {
        status: 409,
        committed: true,
        details: { source: sourceRef, authoring, currentMapDoc: confirmedSnapshot.projectState.refs.mapDoc },
      });
    }

    const beforeMirror = readWorkspace(this.workspacePath);
    if (beforeMirror.revision !== workspace.revision) {
      throw new AtlasSourceBridgeError("workspace_mirror_conflict", "Atlas source committed, but maps.json changed before its workspace mirror", {
        status: 409,
        committed: true,
        details: { mapsRev: beforeMirror.revision, source: sourceRef, authoring },
      });
    }
    const mirrorBytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, "utf8");
    try { this.mirrorWriter(this.workspacePath, mirrorBytes); }
    catch (error) {
      throw new AtlasSourceBridgeError("workspace_mirror_failed", `Atlas source committed, but its maps.json mirror failed: ${error.message}`, {
        status: 503,
        committed: true,
        details: { mapsRev: workspace.revision, source: sourceRef, authoring },
        cause: error,
      });
    }
    return {
      ok: true,
      saved: true,
      maps: doc.maps.length,
      mapsRev: workspaceRevision(mirrorBytes),
      source: sourceRef,
      authoring,
    };
  }
}
