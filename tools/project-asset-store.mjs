import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const DEFAULT_PROJECT_ASSET_MAX_BYTES = 16 * 1024 * 1024;
export const MAX_PROJECT_ASSET_READ_BYTES = 256 * 1024 * 1024;
export const MAX_PROJECT_ASSET_BATCH = 16_384;
export const MAX_CANONICAL_JSON_DEPTH = 128;
export const MAX_CANONICAL_JSON_NODES = 1_000_000;

const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ASSET_SEGMENT = /^[A-Za-z0-9._-]+$/;
const HASH = /^sha256:[0-9a-f]{64}$/;

export class ProjectAssetStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ProjectAssetStoreError";
    this.code = code;
  }
}

function contained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function realDirectory(path, label) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { throw new ProjectAssetStoreError("INVALID_ROOT", `${label} cannot be inspected`, { cause: error }); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ProjectAssetStoreError("INVALID_ROOT", `${label} must be a real directory`);
  }
  return realpathSync(path);
}

export function isProjectAssetId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.startsWith("/") || value.includes("\\")) {
    return false;
  }
  return value.split("/").every((segment) => segment !== "." && segment !== ".." && ASSET_SEGMENT.test(segment));
}

function plainExactReference(input) {
  if (input === null || Array.isArray(input) || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype
      || Object.getOwnPropertySymbols(input).length !== 0) {
    throw new ProjectAssetStoreError("INVALID_REFERENCE", "project asset reference must be a plain object");
  }
  const keys = Object.getOwnPropertyNames(input).sort();
  if (keys.length !== 2 || keys[0] !== "assetId" || keys[1] !== "hash") {
    throw new ProjectAssetStoreError("INVALID_REFERENCE", "project asset reference must contain exactly assetId and hash");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
      throw new ProjectAssetStoreError("INVALID_REFERENCE", `project asset reference ${key} must be an enumerable data field`);
    }
  }
  if (!isProjectAssetId(input.assetId)) throw new ProjectAssetStoreError("INVALID_REFERENCE", "project assetId is invalid");
  if (typeof input.hash !== "string" || !HASH.test(input.hash)) {
    throw new ProjectAssetStoreError("INVALID_REFERENCE", "project asset hash must be lowercase sha256");
  }
  return Object.freeze({ assetId: input.assetId, hash: input.hash });
}

function boundedMaximum(value) {
  const maximum = value ?? DEFAULT_PROJECT_ASSET_MAX_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_PROJECT_ASSET_READ_BYTES) {
    throw new ProjectAssetStoreError("INVALID_LIMIT", `asset read limit must be an integer in [1, ${MAX_PROJECT_ASSET_READ_BYTES}]`);
  }
  return maximum;
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function canonicalJsonValue(value, state, depth = 0) {
  if (depth > MAX_CANONICAL_JSON_DEPTH) throw new ProjectAssetStoreError("INVALID_CANONICAL_JSON", "canonical JSON nesting is too deep");
  state.nodes++;
  if (state.nodes > MAX_CANONICAL_JSON_NODES) throw new ProjectAssetStoreError("INVALID_CANONICAL_JSON", "canonical JSON has too many nodes");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new ProjectAssetStoreError("INVALID_CANONICAL_JSON", "canonical JSON contains an invalid number");
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalJsonValue(entry, state, depth + 1));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ProjectAssetStoreError("INVALID_CANONICAL_JSON", "canonical JSON contains a non-JSON value");
  }
  const output = Object.create(null);
  for (const key of Object.keys(value).sort()) output[key] = canonicalJsonValue(value[key], state, depth + 1);
  return output;
}

function parseCanonicalJsonBytes(bytes) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) { throw new ProjectAssetStoreError("INVALID_CANONICAL_JSON", "canonical JSON is not valid UTF-8", { cause: error }); }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) { throw new ProjectAssetStoreError("INVALID_CANONICAL_JSON", "canonical JSON cannot be parsed", { cause: error }); }
  const canonical = `${JSON.stringify(canonicalJsonValue(parsed, { nodes: 0 }))}\n`;
  if (text !== canonical) {
    throw new ProjectAssetStoreError("INVALID_CANONICAL_JSON", "JSON asset is not in canonical sorted-key form with one trailing newline");
  }
  return immutable(parsed);
}

function immutable(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

/** Hash-verifying, bounded read boundary for authoritative project asset refs. */
export class ProjectAssetStore {
  constructor({ projectId, projectRoot, assetRoot }) {
    if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) {
      throw new ProjectAssetStoreError("INVALID_ROOT", "project asset store projectId is invalid");
    }
    if (typeof projectRoot !== "string" || typeof assetRoot !== "string") {
      throw new ProjectAssetStoreError("INVALID_ROOT", "project asset store roots must be paths");
    }
    this.projectId = projectId;
    this.projectRoot = realDirectory(resolve(projectRoot), "project root");
    const requestedAssetRoot = resolve(assetRoot);
    if (!contained(this.projectRoot, requestedAssetRoot) || requestedAssetRoot === this.projectRoot) {
      throw new ProjectAssetStoreError("INVALID_ROOT", "asset root must be a child of the project root");
    }
    this.assetRoot = realDirectory(requestedAssetRoot, "asset root");
    if (!contained(this.projectRoot, this.assetRoot) || this.assetRoot === this.projectRoot) {
      throw new ProjectAssetStoreError("INVALID_ROOT", "asset root resolves outside the project root");
    }
    this.assetPrefix = relative(this.projectRoot, this.assetRoot).split(sep).join("/");
    if (!isProjectAssetId(this.assetPrefix)) throw new ProjectAssetStoreError("INVALID_ROOT", "asset root has a non-portable project-relative path");
  }

  read(referenceInput, options = {}) {
    const { reference, bytes } = this.#readRaw(referenceInput, options);
    const actual = sha256(bytes);
    if (actual !== reference.hash) {
      throw this.#readError("HASH_MISMATCH", reference.assetId, `hash mismatch (expected ${reference.hash}, actual ${actual})`);
    }
    return bytes;
  }

  readCanonicalJson(referenceInput, options = {}) {
    if (options.contentHashOf !== undefined && typeof options.contentHashOf !== "function") {
      throw new ProjectAssetStoreError("INVALID_REFERENCE", "canonical JSON contentHashOf must be a function");
    }
    const { reference, bytes } = this.#readRaw(referenceInput, options);
    const parsed = parseCanonicalJsonBytes(bytes);
    const actual = options.contentHashOf === undefined ? sha256(bytes) : options.contentHashOf(parsed);
    if (typeof actual !== "string" || !HASH.test(actual)) {
      throw this.#readError("HASH_MISMATCH", reference.assetId, "domain hash verifier returned an invalid lowercase sha256 hash");
    }
    if (actual !== reference.hash) {
      throw this.#readError("HASH_MISMATCH", reference.assetId, `hash mismatch (expected ${reference.hash}, actual ${actual})`);
    }
    return parsed;
  }

  verify(reference, options = {}) {
    this.read(reference, options);
    return true;
  }

  verifyMany(references, options = {}) {
    if (!Array.isArray(references) || references.length > MAX_PROJECT_ASSET_BATCH) {
      throw new ProjectAssetStoreError("INVALID_LIMIT", `asset verification batch must contain at most ${MAX_PROJECT_ASSET_BATCH} refs`);
    }
    for (const reference of references) this.verify(reference, options);
    return true;
  }

  #readRaw(referenceInput, options) {
    const reference = plainExactReference(referenceInput);
    const maximum = boundedMaximum(options.maximumBytes);
    if (!reference.assetId.startsWith(`${this.assetPrefix}/`)) {
      throw this.#readError("OUTSIDE_ASSET_ROOT", reference.assetId, `is not beneath configured asset root '${this.assetPrefix}'`);
    }
    const segments = reference.assetId.slice(this.assetPrefix.length + 1).split("/");
    let current = this.assetRoot;
    for (let index = 0; index < segments.length - 1; index++) {
      current = join(current, segments[index]);
      let stat;
      try { stat = lstatSync(current); }
      catch (error) { throw this.#readError("NOT_FOUND", reference.assetId, "cannot inspect a parent directory", error); }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw this.#readError("UNSAFE_PATH", reference.assetId, "contains a symlink or non-directory parent");
      }
      const real = realpathSync(current);
      if (!contained(this.assetRoot, real)) throw this.#readError("UNSAFE_PATH", reference.assetId, "escapes the asset root");
      current = real;
    }

    const candidate = join(current, segments.at(-1));
    let descriptor;
    try { descriptor = openSync(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
    catch (error) {
      const code = error?.code === "ENOENT" ? "NOT_FOUND" : (error?.code === "ELOOP" ? "UNSAFE_PATH" : "READ_FAILED");
      throw this.#readError(code, reference.assetId, "cannot be opened", error);
    }
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile()) throw this.#readError("NOT_REGULAR", reference.assetId, "is not a regular file");
      if (opened.nlink < 1) throw this.#readError("READ_RACE", reference.assetId, "was unlinked while opening");
      if (opened.size > maximum) throw this.#readError("TOO_LARGE", reference.assetId, `exceeds ${maximum} bytes`);
      this.#verifyDescriptorPath(descriptor, candidate, opened, reference.assetId);
      const bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor);
      if (!sameFile(opened, after) || after.nlink < 1 || after.size !== bytes.byteLength) {
        throw this.#readError("READ_RACE", reference.assetId, "changed while it was being read");
      }
      return { reference, bytes };
    } finally {
      closeSync(descriptor);
    }
  }

  #verifyDescriptorPath(descriptor, candidate, opened, assetId) {
    let openedPath;
    try { openedPath = realpathSync(`/proc/self/fd/${descriptor}`); }
    catch {
      try { openedPath = realpathSync(candidate); }
      catch (error) { throw this.#readError("READ_RACE", assetId, "path changed after open", error); }
      let pathStat;
      try { pathStat = statSync(openedPath); }
      catch (error) { throw this.#readError("READ_RACE", assetId, "path cannot be revalidated", error); }
      if (!sameFile(opened, pathStat)) throw this.#readError("READ_RACE", assetId, "path target changed after open");
    }
    if (!contained(this.assetRoot, openedPath) || openedPath === this.assetRoot) {
      throw this.#readError("UNSAFE_PATH", assetId, "opened descriptor resolves outside the asset root");
    }
  }

  #readError(code, assetId, detail, cause) {
    return new ProjectAssetStoreError(code, `project asset '${assetId}' ${detail}`, cause === undefined ? {} : { cause });
  }
}

export function projectAssetHash(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new ProjectAssetStoreError("INVALID_REFERENCE", "projectAssetHash requires Uint8Array bytes");
  return sha256(bytes);
}
