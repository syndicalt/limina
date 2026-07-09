import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  MAX_DERIVED_ARTIFACT_BYTES,
  MAX_DERIVED_MANIFEST_BYTES,
  MAX_DERIVED_TOTAL_ARTIFACT_BYTES,
  canonicalDerivedRevisionManifest,
  parseDerivedRevisionManifest,
} from "../../js/src/world/compiler/manifest.mjs";
import { canonicalCompilerJson, validateCompilerContentHash } from "../../js/src/world/compiler/canonical.mjs";
import { loadProjectConfig, resolveProjectPath } from "../project-config.mjs";

export const DERIVED_PUBLICATION_POINTER_SCHEMA = "limina.derived-publication-pointer/v1";
export const DERIVED_PUBLICATION_LOCK_SCHEMA = "limina.derived-publication-lock/v1";
export const DERIVED_PUBLICATION_STAGE_SCHEMA = "limina.derived-publication-stage/v1";
export const PUBLICATION_FAULT_POINTS = Object.freeze([
  "after-artifact-stage",
  "after-manifest-stage",
  "before-artifact-install",
  "after-artifact-install",
  "after-manifest-install",
  "before-pointer-write",
  "before-lock-acquire",
  "after-lock-acquire",
  "before-head-read",
  "after-head-read",
  "before-pointer-rename",
]);
export const MAX_STALE_STAGE_CLEANUPS = 8;
export const STALE_STAGE_AGE_MS = 15 * 60 * 1000;
export const PUBLICATION_LOCK_STALE_MS = 5 * 60 * 1000;

const BRANCH_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const JOB_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const POINTER_MAX_BYTES = 16 * 1024;

export const nodePublicationFs = Object.freeze({
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
});

export class PublicationConflictError extends Error {
  constructor(message) { super(message); this.name = "PublicationConflictError"; }
}

export class PublicationStaleError extends Error {
  constructor(message) { super(message); this.name = "PublicationStaleError"; }
}

export class PublicationCancelledError extends Error {
  constructor() { super("derived revision publication cancelled"); this.name = "PublicationCancelledError"; }
}

function codeUnitCompare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function pathWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertId(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function isMissing(error) { return error?.code === "ENOENT"; }
function isExists(error) { return error?.code === "EEXIST"; }

function nodeProcessIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

function safeLstat(fs, path) {
  try { return fs.lstatSync(path); } catch (error) { if (isMissing(error)) return undefined; throw error; }
}

function ensureDirectory(fs, root, target) {
  const absolute = resolve(target);
  if (!pathWithin(root, absolute)) throw new Error(`publication path escapes project state: ${absolute}`);
  const rel = relative(root, absolute);
  let cursor = root;
  for (const segment of rel === "" ? [] : rel.split(sep)) {
    cursor = join(cursor, segment);
    let stat = safeLstat(fs, cursor);
    if (stat === undefined) {
      try { fs.mkdirSync(cursor); }
      catch (error) { if (!isExists(error)) throw error; }
      stat = fs.lstatSync(cursor);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`publication directory is not a real directory: ${cursor}`);
    const real = fs.realpathSync(cursor);
    if (!pathWithin(root, real)) throw new Error(`publication directory resolves outside project state: ${cursor}`);
  }
  return absolute;
}

function publicationPaths(projectRoot, branchId, fs) {
  assertId(branchId, BRANCH_ID, "derived branchId");
  const config = loadProjectConfig(projectRoot);
  if (config.stateDir === undefined) throw new Error("Limina project must configure stateDir for derived publication");
  ensureDirectory(fs, config.projectRoot, join(config.projectRoot, config.stateDir));
  const stateRoot = resolveProjectPath(config.projectRoot, join(config.projectRoot, config.stateDir), "project state directory");
  const derivedRoot = ensureDirectory(fs, stateRoot, join(stateRoot, "derived"));
  const branchRoot = ensureDirectory(fs, stateRoot, join(derivedRoot, branchId));
  return {
    config,
    branchId,
    stateRoot,
    branchRoot,
    artifacts: ensureDirectory(fs, stateRoot, join(branchRoot, "artifacts")),
    manifests: ensureDirectory(fs, stateRoot, join(branchRoot, "manifests")),
    staging: ensureDirectory(fs, stateRoot, join(branchRoot, "staging")),
    pointer: join(branchRoot, "published.json"),
    lock: join(branchRoot, "publication.lock"),
  };
}

function artifactPath(paths, hash) { return join(paths.artifacts, `${validateCompilerContentHash(hash).slice(7)}.bin`); }
function manifestPath(paths, hash) { return join(paths.manifests, `${validateCompilerContentHash(hash).slice(7)}.json`); }

function parsePointer(input, projectId, branchId) {
  const pointer = input;
  if (pointer === null || Array.isArray(pointer) || typeof pointer !== "object") throw new Error("derived publication pointer must be an object");
  const keys = Object.keys(pointer).sort();
  if (canonicalCompilerJson(keys) !== canonicalCompilerJson(["branchId", "current", "generation", "previous", "projectId", "schema"])) {
    throw new Error("derived publication pointer has unsupported or missing fields");
  }
  if (pointer.schema !== DERIVED_PUBLICATION_POINTER_SCHEMA || pointer.projectId !== projectId || pointer.branchId !== branchId) {
    throw new Error("derived publication pointer identity or schema mismatch");
  }
  if (!Number.isSafeInteger(pointer.generation) || pointer.generation < 1) throw new Error("derived publication pointer generation is invalid");
  const ref = (value, label) => {
    if (value === null) return null;
    if (value === null || Array.isArray(value) || typeof value !== "object" || Object.keys(value).length !== 1 || !("manifestHash" in value)) {
      throw new Error(`${label} must be a manifest reference or null`);
    }
    return { manifestHash: validateCompilerContentHash(value.manifestHash, `${label} manifestHash`) };
  };
  const current = ref(pointer.current, "current publication");
  if (current === null) throw new Error("derived publication pointer current cannot be null");
  const previous = ref(pointer.previous, "previous publication");
  if (previous?.manifestHash === current.manifestHash) throw new Error("derived publication pointer current and previous must differ");
  return { schema: DERIVED_PUBLICATION_POINTER_SCHEMA, projectId, branchId, generation: pointer.generation, current, previous };
}

function readBoundedText(fs, path, maximum, label) {
  const stat = safeLstat(fs, path);
  if (stat === undefined) return undefined;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} is not a regular file`);
  if (stat.size > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
  return fs.readFileSync(path, "utf8");
}

function readPointer(fs, paths) {
  const raw = readBoundedText(fs, paths.pointer, POINTER_MAX_BYTES, "derived publication pointer");
  if (raw === undefined) return { raw: undefined, pointer: undefined };
  let parsed;
  try { parsed = JSON.parse(raw); } catch (error) { throw new Error(`derived publication pointer is invalid JSON: ${error.message}`); }
  return { raw, pointer: parsePointer(parsed, paths.config.projectId, paths.branchId) };
}

function writeExclusive(fs, path, bytes) {
  fs.writeFileSync(path, bytes, { flag: "wx" });
  const descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function fsyncDirectory(fs, path) {
  const descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function parseOwner(raw, schema, label) {
  let value;
  try { value = JSON.parse(raw); } catch (error) { throw new Error(`${label} is invalid JSON: ${error.message}`); }
  if (value === null || Array.isArray(value) || typeof value !== "object"
    || Object.keys(value).sort().join(",") !== "createdAtMs,jobId,ownerToken,pid,schema") {
    throw new Error(`${label} has unsupported or missing fields`);
  }
  if (value.schema !== schema) throw new Error(`${label} schema mismatch`);
  assertId(value.jobId, JOB_ID, `${label} jobId`);
  if (!Number.isSafeInteger(value.pid) || value.pid < 1) throw new Error(`${label} pid is invalid`);
  if (!Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0) throw new Error(`${label} creation time is invalid`);
  if (typeof value.ownerToken !== "string" || value.ownerToken.length < 1 || value.ownerToken.length > 256) {
    throw new Error(`${label} owner token is invalid`);
  }
  return value;
}

function ownerRecord(schema, jobId, nowMs) {
  return { schema, jobId, pid: process.pid, createdAtMs: nowMs, ownerToken: randomUUID() };
}

function acquirePublicationLock(fs, paths, owner, nowMs, isProcessAlive) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("derived publication clock must be a non-negative safe integer");
  const bytes = `${canonicalCompilerJson(owner)}\n`;
  const attempt = () => {
    try {
      writeExclusive(fs, paths.lock, bytes);
      fsyncDirectory(fs, paths.branchRoot);
      return true;
    } catch (error) {
      if (isExists(error)) return false;
      throw error;
    }
  };
  if (attempt()) return owner;

  const lockStat = safeLstat(fs, paths.lock);
  if (lockStat !== undefined && (lockStat.isSymbolicLink() || !lockStat.isFile())) {
    throw new Error("derived publication lock is not a regular file");
  }
  const raw = readBoundedText(fs, paths.lock, POINTER_MAX_BYTES, "derived publication lock");
  if (raw === undefined) {
    if (attempt()) return owner;
    throw new PublicationConflictError("another derived publisher acquired the publication lock");
  }
  let existing;
  try { existing = parseOwner(raw, DERIVED_PUBLICATION_LOCK_SCHEMA, "derived publication lock"); } catch (error) {
    const fileAgeMs = lockStat === undefined ? 0 : nowMs - lockStat.mtimeMs;
    if (fileAgeMs < 0 || fileAgeMs <= PUBLICATION_LOCK_STALE_MS) {
      throw new PublicationConflictError(`derived publication lock is present but unreadable: ${error.message}`);
    }
  }
  if (existing !== undefined) {
    const ageMs = nowMs - existing.createdAtMs;
    if (ageMs < 0 || ageMs <= PUBLICATION_LOCK_STALE_MS || isProcessAlive(existing.pid)) {
      throw new PublicationConflictError(`derived publication is locked by job '${existing.jobId}' (pid ${existing.pid})`);
    }
  }

  const stalePath = join(paths.branchRoot, `publication.lock.stale-${owner.jobId}`);
  try {
    fs.renameSync(paths.lock, stalePath);
    fsyncDirectory(fs, paths.branchRoot);
  } catch (error) {
    if (isMissing(error)) throw new PublicationConflictError("derived publication lock changed during stale recovery");
    throw error;
  }
  fs.rmSync(stalePath, { force: true });
  fsyncDirectory(fs, paths.branchRoot);
  if (!attempt()) throw new PublicationConflictError("another derived publisher won stale-lock recovery");
  return owner;
}

function releasePublicationLock(fs, paths, owner) {
  const raw = readBoundedText(fs, paths.lock, POINTER_MAX_BYTES, "derived publication lock");
  if (raw === undefined) return;
  const current = parseOwner(raw, DERIVED_PUBLICATION_LOCK_SCHEMA, "derived publication lock");
  if (current.ownerToken !== owner.ownerToken) return;
  fs.unlinkSync(paths.lock);
  fsyncDirectory(fs, paths.branchRoot);
}

function assertPublicationLockOwner(fs, paths, owner) {
  const raw = readBoundedText(fs, paths.lock, POINTER_MAX_BYTES, "derived publication lock");
  if (raw === undefined) throw new PublicationConflictError("derived publication lock disappeared before commit");
  const current = parseOwner(raw, DERIVED_PUBLICATION_LOCK_SCHEMA, "derived publication lock");
  if (current.ownerToken !== owner.ownerToken) throw new PublicationConflictError("derived publication lock ownership changed before commit");
}

function validateHead(head, manifest) {
  if (head === null || typeof head !== "object") throw new Error("authoritative head reader returned an invalid value");
  if (head.projectId !== manifest.projectId || head.branchId !== manifest.branchId) throw new PublicationStaleError("authoritative project/branch changed before publication");
  if (!Number.isSafeInteger(head.revision) || head.revision < 0) throw new Error("authoritative head revision is invalid");
  validateCompilerContentHash(head.headHash, "authoritative headHash");
  if (head.revision !== manifest.source.revision || head.headHash !== manifest.source.headHash) {
    throw new PublicationStaleError(
      `derived revision ${manifest.source.revision}/${manifest.source.headHash} is stale against authoritative ${head.revision}/${head.headHash}`,
    );
  }
  return { projectId: head.projectId, branchId: head.branchId, revision: head.revision, headHash: head.headHash };
}

function artifactDescriptors(manifest) {
  const descriptors = new Map();
  for (const chunk of manifest.chunks) for (const artifact of chunk.artifacts) {
    const existing = descriptors.get(artifact.contentHash);
    if (existing !== undefined && existing.byteLength !== artifact.byteLength) {
      throw new Error(`artifact ${artifact.contentHash} has inconsistent byte lengths`);
    }
    descriptors.set(artifact.contentHash, artifact);
  }
  return descriptors;
}

function nodeArtifactContentHash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function validateArtifactInputs(manifest, inputs) {
  if (!Array.isArray(inputs)) throw new Error("publication artifacts must be an array");
  const required = artifactDescriptors(manifest);
  const supplied = new Map();
  let total = 0;
  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index];
    if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== "bytes,contentHash") {
      throw new Error(`publication artifact ${index} must contain exactly contentHash and bytes`);
    }
    const hash = validateCompilerContentHash(input.contentHash, `publication artifact ${index} contentHash`);
    if (!(input.bytes instanceof Uint8Array)) throw new Error(`publication artifact ${index} bytes must be Uint8Array`);
    if (supplied.has(hash)) throw new Error(`publication artifacts contain duplicate ${hash}`);
    const descriptor = required.get(hash);
    if (descriptor === undefined) throw new Error(`publication supplied unreferenced artifact ${hash}`);
    if (input.bytes.byteLength !== descriptor.byteLength) throw new Error(`publication artifact ${hash} byteLength mismatch`);
    if (nodeArtifactContentHash(input.bytes) !== hash) throw new Error(`publication artifact ${hash} content hash mismatch`);
    total += input.bytes.byteLength;
    if (total > MAX_DERIVED_TOTAL_ARTIFACT_BYTES) throw new Error("publication artifact bytes exceed the total resource bound");
    supplied.set(hash, input.bytes);
  }
  for (const hash of required.keys()) if (!supplied.has(hash)) throw new Error(`publication is missing artifact ${hash}`);
  return supplied;
}

function validateInstalledArtifact(fs, path, descriptor) {
  const stat = safeLstat(fs, path);
  if (stat === undefined || stat.isSymbolicLink() || !stat.isFile()) throw new Error(`derived artifact ${descriptor.contentHash} is missing or not regular`);
  if (stat.size !== descriptor.byteLength || stat.size > MAX_DERIVED_ARTIFACT_BYTES) throw new Error(`derived artifact ${descriptor.contentHash} byteLength mismatch`);
  const descriptorFd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const hash = createHash("sha256");
  try {
    const opened = fs.fstatSync(descriptorFd);
    if (!opened.isFile() || opened.size !== descriptor.byteLength || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error(`derived artifact ${descriptor.contentHash} changed while it was being validated`);
    }
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, opened.size)));
    let remaining = opened.size;
    while (remaining > 0) {
      const count = fs.readSync(descriptorFd, buffer, 0, Math.min(buffer.byteLength, remaining), null);
      if (count === 0) throw new Error(`derived artifact ${descriptor.contentHash} was truncated during validation`);
      hash.update(buffer.subarray(0, count));
      remaining -= count;
    }
  } finally {
    fs.closeSync(descriptorFd);
  }
  if (`sha256:${hash.digest("hex")}` !== descriptor.contentHash) throw new Error(`derived artifact ${descriptor.contentHash} hash mismatch`);
}

function validateInstalledManifest(fs, paths, ref) {
  const raw = readBoundedText(fs, manifestPath(paths, ref.manifestHash), MAX_DERIVED_MANIFEST_BYTES, "derived revision manifest");
  if (raw === undefined) throw new Error(`derived manifest ${ref.manifestHash} is missing`);
  let manifest;
  try { manifest = parseDerivedRevisionManifest(JSON.parse(raw)); } catch (error) { throw new Error(`derived manifest ${ref.manifestHash} is invalid: ${error.message}`); }
  if (manifest.manifestHash !== ref.manifestHash || manifest.projectId !== paths.config.projectId || manifest.branchId !== paths.branchId) {
    throw new Error(`derived manifest ${ref.manifestHash} identity mismatch`);
  }
  const descriptors = artifactDescriptors(manifest);
  for (const descriptor of descriptors.values()) validateInstalledArtifact(fs, artifactPath(paths, descriptor.contentHash), descriptor);
  return manifest;
}

function maybeCancel(shouldCancel) {
  if (shouldCancel !== undefined && typeof shouldCancel !== "function") throw new Error("publication shouldCancel must be a function");
  if (shouldCancel?.()) throw new PublicationCancelledError();
}

function faultAt(fault, point, context) {
  if (fault !== undefined && typeof fault !== "function") throw new Error("publication fault injector must be a function");
  fault?.(point, context);
}

function cleanupOldStages(fs, stagingRoot, currentJobId, nowMs, isProcessAlive) {
  const entries = fs.readdirSync(stagingRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== currentJobId && JOB_ID.test(entry.name))
    .sort((a, b) => codeUnitCompare(a.name, b.name));
  let cleaned = 0;
  for (const entry of entries) {
    if (cleaned >= MAX_STALE_STAGE_CLEANUPS) break;
    const path = join(stagingRoot, entry.name);
    const stat = fs.lstatSync(path);
    if (stat.isSymbolicLink() || nowMs - stat.mtimeMs < STALE_STAGE_AGE_MS) continue;
    const markerPath = join(path, "active.json");
    const markerStat = safeLstat(fs, markerPath);
    if (markerStat !== undefined) {
      if (markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.size > POINTER_MAX_BYTES) continue;
      try {
        const owner = parseOwner(fs.readFileSync(markerPath, "utf8"), DERIVED_PUBLICATION_STAGE_SCHEMA, "derived publication stage owner");
        if (nowMs - owner.createdAtMs <= STALE_STAGE_AGE_MS || isProcessAlive(owner.pid)) continue;
      } catch {
        // A stale regular marker can be torn by a crashed writer; the age gate
        // above prevents cleanup while a new job is creating it.
      }
    }
    fs.rmSync(path, { recursive: true, force: true });
    cleaned++;
  }
  return cleaned;
}

export async function publishDerivedRevision(options) {
  const fs = options?.fs ?? nodePublicationFs;
  const jobId = assertId(options?.jobId, JOB_ID, "derived publication jobId");
  const manifest = parseDerivedRevisionManifest(options?.manifest);
  const paths = publicationPaths(options?.projectRoot, manifest.branchId, fs);
  if (manifest.projectId !== paths.config.projectId) throw new Error("derived manifest projectId does not match Limina project identity");
  if (typeof options?.readHead !== "function") throw new Error("derived publication requires readHead");
  const isProcessAlive = options?.isProcessAlive ?? nodeProcessIsAlive;
  if (typeof isProcessAlive !== "function") throw new Error("derived publication isProcessAlive must be a function");
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("derived publication clock must be a non-negative safe integer");
  const artifacts = validateArtifactInputs(manifest, options.artifacts);
  const baseline = readPointer(fs, paths);
  const stageRoot = join(paths.staging, jobId);
  if (safeLstat(fs, stageRoot) !== undefined) throw new Error(`derived publication job '${jobId}' already exists`);
  fs.mkdirSync(stageRoot);
  let stageArtifacts;
  const stageManifest = join(stageRoot, "manifest.json");
  const pointerTemp = join(paths.branchRoot, `published.json.tmp-${jobId}`);
  let cleanedStages = 0;
  let lockOwner;
  try {
    const stageOwner = ownerRecord(DERIVED_PUBLICATION_STAGE_SCHEMA, jobId, nowMs);
    writeExclusive(fs, join(stageRoot, "active.json"), `${canonicalCompilerJson(stageOwner)}\n`);
    fsyncDirectory(fs, stageRoot);
    stageArtifacts = ensureDirectory(fs, paths.stateRoot, join(stageRoot, "artifacts"));
    cleanedStages = cleanupOldStages(fs, paths.staging, jobId, nowMs, isProcessAlive);
    maybeCancel(options.shouldCancel);
    for (const [hash, bytes] of [...artifacts.entries()].sort(([a], [b]) => codeUnitCompare(a, b))) {
      writeExclusive(fs, join(stageArtifacts, `${hash.slice(7)}.bin`), bytes);
      maybeCancel(options.shouldCancel);
    }
    fsyncDirectory(fs, stageArtifacts);
    faultAt(options.fault, "after-artifact-stage", { manifestHash: manifest.manifestHash });
    writeExclusive(fs, stageManifest, `${canonicalDerivedRevisionManifest(manifest)}\n`);
    fsyncDirectory(fs, stageRoot);
    faultAt(options.fault, "after-manifest-stage", { manifestHash: manifest.manifestHash });

    faultAt(options.fault, "before-artifact-install", {});
    const descriptors = artifactDescriptors(manifest);
    for (const [hash] of [...artifacts.entries()].sort(([a], [b]) => codeUnitCompare(a, b))) {
      const staged = join(stageArtifacts, `${hash.slice(7)}.bin`);
      const final = artifactPath(paths, hash);
      if (safeLstat(fs, final) === undefined) fs.renameSync(staged, final);
      else {
        validateInstalledArtifact(fs, final, descriptors.get(hash));
        fs.unlinkSync(staged);
      }
    }
    fsyncDirectory(fs, paths.artifacts);
    faultAt(options.fault, "after-artifact-install", {});

    const finalManifest = manifestPath(paths, manifest.manifestHash);
    if (safeLstat(fs, finalManifest) === undefined) fs.renameSync(stageManifest, finalManifest);
    else {
      validateInstalledManifest(fs, paths, { manifestHash: manifest.manifestHash });
      fs.unlinkSync(stageManifest);
    }
    fsyncDirectory(fs, paths.manifests);
    faultAt(options.fault, "after-manifest-install", {});
    maybeCancel(options.shouldCancel);

    if (baseline.pointer?.generation === Number.MAX_SAFE_INTEGER) throw new Error("derived publication pointer generation exhausted");
    const pointer = {
      schema: DERIVED_PUBLICATION_POINTER_SCHEMA,
      projectId: manifest.projectId,
      branchId: manifest.branchId,
      generation: (baseline.pointer?.generation ?? 0) + 1,
      current: { manifestHash: manifest.manifestHash },
      previous: baseline.pointer?.current ?? null,
    };
    if (pointer.previous?.manifestHash === pointer.current.manifestHash) pointer.previous = baseline.pointer?.previous ?? null;
    faultAt(options.fault, "before-pointer-write", { pointer });
    writeExclusive(fs, pointerTemp, `${canonicalCompilerJson(pointer)}\n`);

    faultAt(options.fault, "before-lock-acquire", {});
    lockOwner = ownerRecord(DERIVED_PUBLICATION_LOCK_SCHEMA, jobId, nowMs);
    lockOwner = acquirePublicationLock(fs, paths, lockOwner, nowMs, isProcessAlive);
    try {
      faultAt(options.fault, "after-lock-acquire", { owner: lockOwner });
      faultAt(options.fault, "before-head-read", {});
      maybeCancel(options.shouldCancel);
      const head = validateHead(await options.readHead(), manifest);
      faultAt(options.fault, "after-head-read", { head });
      maybeCancel(options.shouldCancel);

      // The source re-read is followed by pointer CAS and rename without another
      // asynchronous boundary, while the branch publication lease is held.
      const finalPointerState = readPointer(fs, paths);
      if (finalPointerState.raw !== baseline.raw) throw new PublicationConflictError("published pointer changed while derived job was compiling");
      faultAt(options.fault, "before-pointer-rename", { pointer });
      maybeCancel(options.shouldCancel);
      assertPublicationLockOwner(fs, paths, lockOwner);
      fs.renameSync(pointerTemp, paths.pointer);
      fsyncDirectory(fs, paths.branchRoot);
      return { published: true, manifest, pointer, cleanedStages };
    } finally {
      if (lockOwner !== undefined) releasePublicationLock(fs, paths, lockOwner);
      lockOwner = undefined;
    }
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    try { fs.unlinkSync(pointerTemp); } catch (error) { if (!isMissing(error)) throw error; }
  }
}

export async function readPublishedDerivedRevision(options) {
  const fs = options?.fs ?? nodePublicationFs;
  const branchId = assertId(options?.branchId, BRANCH_ID, "derived branchId");
  if (typeof options?.readHead !== "function") throw new Error("derived publication reader requires readHead");
  const paths = publicationPaths(options?.projectRoot, branchId, fs);
  const { pointer } = readPointer(fs, paths);
  if (pointer === undefined) throw new Error("no derived revision has been published");
  let currentError;
  let manifest;
  let usedFallback = false;
  try {
    manifest = validateInstalledManifest(fs, paths, pointer.current);
  } catch (error) {
    currentError = error instanceof Error ? error.message : String(error);
    if (pointer.previous === null) throw new Error(`current derived revision is unusable and no previous revision exists: ${currentError}`);
    try {
      manifest = validateInstalledManifest(fs, paths, pointer.previous);
      usedFallback = true;
    } catch (previousError) {
      throw new Error(
        `all published derived revisions are unusable; current: ${currentError}; previous: ${previousError instanceof Error ? previousError.message : String(previousError)}`,
      );
    }
  }
  const head = validateHeadShape(await options.readHead());
  const sourceMatches = !usedFallback
    && head.projectId === manifest.projectId
    && head.branchId === manifest.branchId
    && head.revision === manifest.source.revision
    && head.headHash === manifest.source.headHash;
  return {
    status: usedFallback ? "fallback" : sourceMatches ? "current" : "stale",
    manifest,
    pointer,
    diagnostics: {
      usedFallback,
      currentError: currentError ?? null,
      matchesCurrentSource: sourceMatches,
      manifestSource: { revision: manifest.source.revision, headHash: manifest.source.headHash },
      authoritativeSource: { revision: head.revision, headHash: head.headHash },
    },
  };
}

function validateHeadShape(head) {
  if (head === null || typeof head !== "object") throw new Error("authoritative head reader returned an invalid value");
  assertId(head.projectId, /^[a-z0-9][a-z0-9._-]{0,63}$/, "authoritative projectId");
  assertId(head.branchId, BRANCH_ID, "authoritative branchId");
  if (!Number.isSafeInteger(head.revision) || head.revision < 0) throw new Error("authoritative head revision is invalid");
  return { ...head, headHash: validateCompilerContentHash(head.headHash, "authoritative headHash") };
}
