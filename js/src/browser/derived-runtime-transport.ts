import {
  MAX_DERIVED_ARTIFACT_BYTES,
  MAX_DERIVED_MANIFEST_BYTES,
  derivedGlobalArtifacts,
  parseDerivedRevisionManifest,
} from "../world/compiler/manifest.mjs";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { exactDataKeys, plainRecord } from "./derived-plain-data.ts";

export const DERIVED_RUNTIME_CURRENT_SCHEMA = "limina.derived-runtime-current/v1";
export const DERIVED_RUNTIME_ERROR_SCHEMA = "limina.derived-runtime-error/v1";
export const MAX_DERIVED_RUNTIME_CURRENT_BYTES = MAX_DERIVED_MANIFEST_BYTES + 64 * 1024;

const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BRANCH_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const BASE_URL = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/;
const MAX_ERROR_BYTES = 64 * 1024;

export type DerivedRuntimeTransportErrorCode =
  | "ABORTED"
  | "NETWORK_ERROR"
  | "NO_PUBLICATION"
  | "NOT_CURRENT"
  | "CURRENT_CHANGED"
  | "RATE_LIMITED"
  | "STREAM_LIMIT"
  | "PUBLICATION_UNAVAILABLE"
  | "SERVER_STOPPING"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "PROTOCOL_ERROR"
  | "INTEGRITY_ERROR";

export type DerivedRuntimeErrorClassification = "transient" | "fatal";

export class DerivedRuntimeTransportError extends Error {
  readonly code: DerivedRuntimeTransportErrorCode;
  readonly classification: DerivedRuntimeErrorClassification;

  constructor(code: DerivedRuntimeTransportErrorCode, classification: DerivedRuntimeErrorClassification, message: string) {
    super(message);
    this.name = "DerivedRuntimeTransportError";
    this.code = code;
    this.classification = classification;
  }
}

export interface DerivedRuntimeTransportConfig {
  baseUrl: string;
  token: string;
  projectId: string;
  branchId: string;
}

export interface DerivedRuntimeTransportDependencies {
  fetch?: typeof fetch;
  crypto?: Pick<Crypto, "subtle">;
}

export interface DerivedArtifactDescriptor {
  readonly artifactType: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mediaType: string;
}

export interface DerivedRuntimeContentDescriptor {
  readonly contentHash: string;
  readonly byteLength: number;
}

export interface DerivedRuntimeContentResult {
  readonly contentHash: string;
  readonly bytes: Uint8Array;
}

export interface DerivedRuntimeCurrent {
  readonly schema: typeof DERIVED_RUNTIME_CURRENT_SCHEMA;
  readonly projectId: string;
  readonly branchId: string;
  readonly generation: number;
  readonly source: Readonly<{ revision: number; headHash: string }>;
  readonly manifest: ReturnType<typeof parseDerivedRevisionManifest>;
  readonly manifestHash: string;
  readonly etag: string;
}

export type DerivedRuntimeCurrentResult =
  | Readonly<{ status: "current"; current: DerivedRuntimeCurrent }>
  | Readonly<{ status: "not-modified"; current: DerivedRuntimeCurrent }>;

export type DerivedRuntimeArtifactResult =
  | Readonly<{ status: "artifact"; contentHash: string; bytes: Uint8Array }>
  | Readonly<{ status: "not-modified"; contentHash: string }>;

interface BoundCurrent {
  readonly descriptorKeys: ReadonlySet<string>;
}

function fatal(code: DerivedRuntimeTransportErrorCode, message: string): DerivedRuntimeTransportError {
  return new DerivedRuntimeTransportError(code, "fatal", message);
}

function transient(code: DerivedRuntimeTransportErrorCode, message: string): DerivedRuntimeTransportError {
  return new DerivedRuntimeTransportError(code, "transient", message);
}

const protocolError = (message: string): Error => fatal("PROTOCOL_ERROR", message);

function plainObject(value: unknown, label: string): Record<string, unknown> {
  return plainRecord(value, label, protocolError);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  exactDataKeys(value, expected, [], label, protocolError);
}

function strictConfig(input: DerivedRuntimeTransportConfig): Readonly<DerivedRuntimeTransportConfig> {
  if (input === null || Array.isArray(input) || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError("derived runtime transport config must be a plain object");
  }
  const value = input as unknown as Record<string, unknown>;
  const names = Object.getOwnPropertyNames(value);
  const keys = [...names].sort().join(",");
  if (Object.getOwnPropertySymbols(value).length !== 0 || keys !== "baseUrl,branchId,projectId,token") {
    throw new TypeError("derived runtime transport config must contain exactly baseUrl, token, projectId, and branchId");
  }
  if (names.some((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined;
  })) throw new TypeError("derived runtime transport config fields must be enumerable data properties");
  const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl : undefined;
  const match = baseUrl === undefined ? null : BASE_URL.exec(baseUrl);
  if (match === null || Number(match[1]) > 65535) {
    throw new TypeError("derived runtime baseUrl must be canonical loopback HTTP with an explicit non-zero port");
  }
  if (typeof value.token !== "string" || !TOKEN.test(value.token) || base64urlValue(value.token.at(-1)!) % 4 !== 0) {
    throw new TypeError("derived runtime token must be canonical base64url for exactly 32 bytes");
  }
  if (typeof value.projectId !== "string" || !PROJECT_ID.test(value.projectId)) throw new TypeError("derived runtime projectId is invalid");
  if (typeof value.branchId !== "string" || !BRANCH_ID.test(value.branchId)) throw new TypeError("derived runtime branchId is invalid");
  return Object.freeze({
    baseUrl: baseUrl!,
    token: value.token,
    projectId: value.projectId,
    branchId: value.branchId,
  });
}

function base64urlValue(character: string): number {
  const code = character.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return character === "-" ? 62 : 63;
}

function strictDependencies(input: DerivedRuntimeTransportDependencies | undefined): {
  fetch: typeof fetch;
  crypto: Pick<Crypto, "subtle">;
} {
  const value = input ?? {};
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("derived runtime transport dependencies must be a plain object");
  }
  const keys = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0 || keys.some((key) => key !== "fetch" && key !== "crypto")) {
    throw new TypeError("derived runtime transport dependencies contain unsupported fields");
  }
  if (keys.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined;
  })) throw new TypeError("derived runtime transport dependency fields must be enumerable data properties");
  const fetchImpl = value.fetch ?? globalThis.fetch;
  const cryptoImpl = value.crypto ?? globalThis.crypto;
  if (typeof fetchImpl !== "function") throw new TypeError("derived runtime transport requires fetch");
  if (cryptoImpl === undefined || cryptoImpl === null || typeof cryptoImpl.subtle?.digest !== "function") {
    throw new TypeError("derived runtime transport requires WebCrypto SHA-256");
  }
  return { fetch: fetchImpl, crypto: cryptoImpl };
}

function parseLength(headers: Headers, maximum: number, label: string): number {
  const raw = headers.get("content-length");
  if (raw === null || !/^(0|[1-9][0-9]*)$/.test(raw)) throw fatal("PROTOCOL_ERROR", `${label} Content-Length is missing or non-canonical`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) throw fatal("PROTOCOL_ERROR", `${label} Content-Length exceeds its resource bound`);
  return value;
}

function exactHeader(headers: Headers, name: string, expected: string, label: string): void {
  if (headers.get(name) !== expected) throw fatal("PROTOCOL_ERROR", `${label} ${name} does not match the requested publication`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw transient("ABORTED", "derived runtime request was aborted");
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body === null || response.body.locked) return;
  try { await response.body.cancel(); } catch { /* preserve the protocol error */ }
}

async function readBounded(response: Response, expectedLength: number, maximum: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (expectedLength > maximum) throw fatal("PROTOCOL_ERROR", "derived runtime response exceeds its resource bound");
  if (response.body === null) {
    if (expectedLength === 0) return new Uint8Array(0);
    throw fatal("PROTOCOL_ERROR", "derived runtime response body is missing");
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(expectedLength);
  let total = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw fatal("PROTOCOL_ERROR", "derived runtime response yielded non-byte data");
      total += part.value.byteLength;
      if (total > expectedLength || total > maximum) {
        throw fatal("PROTOCOL_ERROR", "derived runtime response body exceeds declared Content-Length");
      }
      bytes.set(part.value, total - part.value.byteLength);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof DerivedRuntimeTransportError) throw error;
    if (signal?.aborted) throw transient("ABORTED", "derived runtime request was aborted");
    throw transient("NETWORK_ERROR", "derived runtime response body stream failed");
  } finally {
    reader.releaseLock();
  }
  if (total !== expectedLength) throw fatal("PROTOCOL_ERROR", "derived runtime response body does not match Content-Length");
  return bytes;
}

function decodeJson(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw fatal("PROTOCOL_ERROR", `${label} is not valid UTF-8`); }
  try { return JSON.parse(text); }
  catch { throw fatal("PROTOCOL_ERROR", `${label} is not valid JSON`); }
}

async function sha256(cryptoImpl: Pick<Crypto, "subtle">, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  let digest: ArrayBuffer;
  try { digest = await cryptoImpl.subtle.digest("SHA-256", bytes); }
  catch { throw fatal("INTEGRITY_ERROR", "WebCrypto could not verify the derived artifact"); }
  const values = new Uint8Array(digest);
  if (values.byteLength !== 32) throw fatal("INTEGRITY_ERROR", "WebCrypto returned an invalid SHA-256 digest");
  let hex = "";
  for (const value of values) hex += value.toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}

function descriptorKey(descriptor: DerivedArtifactDescriptor): string {
  return `${descriptor.artifactType}\0${descriptor.contentHash}\0${descriptor.byteLength}\0${descriptor.mediaType}`;
}

function descriptorSet(manifest: ReturnType<typeof parseDerivedRevisionManifest>): ReadonlySet<string> {
  const descriptors = new Set<string>();
  for (const descriptor of derivedGlobalArtifacts(manifest)) descriptors.add(descriptorKey(descriptor));
  for (const chunk of manifest.chunks) for (const descriptor of chunk.artifacts) descriptors.add(descriptorKey(descriptor));
  return descriptors;
}

function contentEtag(contentHash: string): string { return `"${contentHash}"`; }

function currentPublicationEtag(generation: number, manifestHash: string): string {
  return `"g${generation}-${manifestHash}"`;
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw fatal("PROTOCOL_ERROR", `${label} is invalid`);
  return value;
}

export class DerivedRuntimeTransport {
  readonly #config: Readonly<DerivedRuntimeTransportConfig>;
  readonly #fetch: typeof fetch;
  readonly #crypto: Pick<Crypto, "subtle">;
  readonly #bindings = new WeakMap<DerivedRuntimeCurrent, BoundCurrent>();

  constructor(config: DerivedRuntimeTransportConfig, dependencies?: DerivedRuntimeTransportDependencies) {
    this.#config = strictConfig(config);
    const resolved = strictDependencies(dependencies);
    this.#fetch = resolved.fetch;
    this.#crypto = resolved.crypto;
  }

  async fetchCurrent(options: Readonly<{ previous?: DerivedRuntimeCurrent; signal?: AbortSignal }> = {}): Promise<DerivedRuntimeCurrentResult> {
    const previous = options.previous;
    if (previous !== undefined && !this.#bindings.has(previous)) {
      throw fatal("PROTOCOL_ERROR", "previous derived current was not issued by this transport");
    }
    const response = await this.#request(`${this.#config.baseUrl}/v1/derived/current`, {
      signal: options.signal,
      headers: previous === undefined ? undefined : { "If-None-Match": previous.etag },
    });
    if (response.status === 304) {
      try {
        if (previous === undefined) throw fatal("PROTOCOL_ERROR", "derived current returned 304 without a bound previous publication");
        this.#validateCurrentIdentityHeaders(response, previous);
        if (parseLength(response.headers, 0, "derived current 304") !== 0) throw fatal("PROTOCOL_ERROR", "derived current 304 carried a body");
      } catch (error) {
        await cancelResponseBody(response);
        throw error;
      }
      return Object.freeze({ status: "not-modified", current: previous });
    }
    if (response.status !== 200) await this.#throwResponseError(response, options.signal);
    let length: number;
    try {
      if (response.headers.get("content-type") !== "application/json; charset=utf-8") {
        throw fatal("PROTOCOL_ERROR", "derived current Content-Type is invalid");
      }
      length = parseLength(response.headers, MAX_DERIVED_RUNTIME_CURRENT_BYTES, "derived current");
    } catch (error) {
      await cancelResponseBody(response);
      throw error;
    }
    const bytes = await readBounded(response, length, MAX_DERIVED_RUNTIME_CURRENT_BYTES, options.signal);
    const body = plainObject(decodeJson(bytes, "derived current response"), "derived current response");
    exactKeys(body, ["schema", "projectId", "branchId", "generation", "source", "manifest"], "derived current response");
    if (body.schema !== DERIVED_RUNTIME_CURRENT_SCHEMA) throw fatal("PROTOCOL_ERROR", "derived current schema is unsupported");
    if (body.projectId !== this.#config.projectId || body.branchId !== this.#config.branchId) {
      throw fatal("PROTOCOL_ERROR", "derived current project or branch does not match transport configuration");
    }
    if (!Number.isSafeInteger(body.generation) || (body.generation as number) < 1) throw fatal("PROTOCOL_ERROR", "derived current generation is invalid");
    const source = plainObject(body.source, "derived current source");
    exactKeys(source, ["revision", "headHash"], "derived current source");
    if (!Number.isSafeInteger(source.revision) || (source.revision as number) < 0) throw fatal("PROTOCOL_ERROR", "derived current source revision is invalid");
    const headHash = requireHash(source.headHash, "derived current source headHash");
    let manifest: ReturnType<typeof parseDerivedRevisionManifest>;
    try { manifest = parseDerivedRevisionManifest(body.manifest); }
    catch (error) { throw fatal("PROTOCOL_ERROR", `derived current manifest is invalid: ${error instanceof Error ? error.message : String(error)}`); }
    if (manifest.projectId !== this.#config.projectId || manifest.branchId !== this.#config.branchId
        || manifest.source.revision !== source.revision || manifest.source.headHash !== headHash) {
      throw fatal("PROTOCOL_ERROR", "derived current envelope and manifest identities disagree");
    }
    const current: DerivedRuntimeCurrent = Object.freeze({
      schema: DERIVED_RUNTIME_CURRENT_SCHEMA,
      projectId: this.#config.projectId,
      branchId: this.#config.branchId,
      generation: body.generation as number,
      source: Object.freeze({ revision: source.revision as number, headHash }),
      manifest,
      manifestHash: manifest.manifestHash,
      etag: currentPublicationEtag(body.generation as number, manifest.manifestHash),
    });
    this.#validateCurrentIdentityHeaders(response, current);
    this.#bindings.set(current, Object.freeze({ descriptorKeys: descriptorSet(manifest) }));
    return Object.freeze({ status: "current", current });
  }

  async fetchArtifact(
    current: DerivedRuntimeCurrent,
    descriptor: DerivedArtifactDescriptor,
    options: Readonly<{ signal?: AbortSignal; allowNotModified?: boolean }> = {},
  ): Promise<DerivedRuntimeArtifactResult> {
    const binding = this.#bindings.get(current);
    if (binding === undefined || !binding.descriptorKeys.has(descriptorKey(descriptor))) {
      throw fatal("PROTOCOL_ERROR", "derived artifact descriptor is not bound to this transport publication");
    }
    if (descriptor.byteLength > MAX_DERIVED_ARTIFACT_BYTES) throw fatal("PROTOCOL_ERROR", "derived artifact descriptor exceeds the server cap");
    const manifestHex = current.manifestHash.slice(7);
    const contentHex = descriptor.contentHash.slice(7);
    const response = await this.#request(
      `${this.#config.baseUrl}/v1/derived/manifests/${manifestHex}/artifacts/${contentHex}`,
      {
        signal: options.signal,
        headers: options.allowNotModified ? { "If-None-Match": contentEtag(descriptor.contentHash) } : undefined,
      },
    );
    if (response.status === 304) {
      try {
        if (!options.allowNotModified) throw fatal("PROTOCOL_ERROR", "derived artifact returned an unsolicited 304");
        this.#validateArtifactHeaders(response, current, descriptor, true);
      } catch (error) {
        await cancelResponseBody(response);
        throw error;
      }
      return Object.freeze({ status: "not-modified", contentHash: descriptor.contentHash });
    }
    if (response.status !== 200) await this.#throwResponseError(response, options.signal);
    try { this.#validateArtifactHeaders(response, current, descriptor, false); }
    catch (error) {
      await cancelResponseBody(response);
      throw error;
    }
    const bytes = await readBounded(response, descriptor.byteLength, MAX_DERIVED_ARTIFACT_BYTES, options.signal);
    throwIfAborted(options.signal);
    const actualHash = await sha256(this.#crypto, bytes);
    throwIfAborted(options.signal);
    if (actualHash !== descriptor.contentHash) throw fatal("INTEGRITY_ERROR", "derived artifact SHA-256 does not match its descriptor");
    return Object.freeze({ status: "artifact", contentHash: descriptor.contentHash, bytes });
  }

  /**
   * Fetch one closure-authorized engine asset directly into the main realm. Unlike derived
   * artifacts, these bytes are intentionally never transferred through the worker. The server
   * binds authorization to `manifestHash`; the caller must source the descriptor from that
   * manifest's independently verified biome-content closure.
   */
  async fetchContent(
    manifestHashInput: string,
    descriptorInput: DerivedRuntimeContentDescriptor,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<Readonly<DerivedRuntimeContentResult>> {
    const manifestHash = requireHash(manifestHashInput, "derived content manifestHash");
    const descriptor = plainObject(descriptorInput, "derived content descriptor");
    exactKeys(descriptor, ["contentHash", "byteLength"], "derived content descriptor");
    const contentHash = requireHash(descriptor.contentHash, "derived content descriptor.contentHash");
    if (!Number.isSafeInteger(descriptor.byteLength) || (descriptor.byteLength as number) < 1
        || (descriptor.byteLength as number) > MAX_DERIVED_ARTIFACT_BYTES) {
      throw fatal("PROTOCOL_ERROR", "derived content descriptor.byteLength exceeds the server cap");
    }
    const response = await this.#request(
      `${this.#config.baseUrl}/v1/derived/manifests/${manifestHash.slice(7)}/content/${contentHash.slice(7)}`,
      { signal: options.signal },
    );
    if (response.status !== 200) await this.#throwResponseError(response, options.signal);
    try {
      exactHeader(response.headers, "etag", contentEtag(contentHash), "derived content");
      exactHeader(response.headers, "x-limina-content-hash", contentHash, "derived content");
      exactHeader(response.headers, "x-limina-manifest-hash", manifestHash, "derived content");
      exactHeader(response.headers, "content-type", "application/octet-stream", "derived content");
      if (parseLength(response.headers, MAX_DERIVED_ARTIFACT_BYTES, "derived content") !== descriptor.byteLength) {
        throw fatal("PROTOCOL_ERROR", "derived content Content-Length does not match its closure entry");
      }
      const generation = response.headers.get("x-limina-generation");
      if (generation === null || !/^[1-9][0-9]*$/.test(generation) || !Number.isSafeInteger(Number(generation))) {
        throw fatal("PROTOCOL_ERROR", "derived content X-Limina-Generation is invalid");
      }
    } catch (error) {
      await cancelResponseBody(response);
      throw error;
    }
    const bytes = await readBounded(
      response,
      descriptor.byteLength as number,
      MAX_DERIVED_ARTIFACT_BYTES,
      options.signal,
    );
    throwIfAborted(options.signal);
    if (portableAssetContentHash(bytes) !== contentHash) {
      throw fatal("INTEGRITY_ERROR", "derived content portable engine hash does not match its closure entry");
    }
    throwIfAborted(options.signal);
    return Object.freeze({ contentHash, bytes });
  }

  async #request(url: string, options: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<Response> {
    throwIfAborted(options.signal);
    const headers = { Authorization: `Bearer ${this.#config.token}`, ...options.headers };
    try {
      // Calling a function-valued class field as `this.#fetch()` supplies the transport object as
      // its receiver. Chromium's worker fetch rejects that WebIDL receiver before any request is
      // issued, so detach the callable first.
      const fetchImpl = this.#fetch;
      return await fetchImpl(url, {
        method: "GET",
        headers,
        signal: options.signal,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
    } catch {
      if (options.signal?.aborted) throw transient("ABORTED", "derived runtime request was aborted");
      throw transient("NETWORK_ERROR", "derived runtime request failed before an HTTP response was received");
    }
  }

  #validateCurrentIdentityHeaders(response: Response, current: DerivedRuntimeCurrent): void {
    exactHeader(response.headers, "etag", current.etag, "derived current");
    exactHeader(response.headers, "x-limina-manifest-hash", current.manifestHash, "derived current");
    exactHeader(response.headers, "x-limina-revision", String(current.source.revision), "derived current");
    exactHeader(response.headers, "x-limina-head-hash", current.source.headHash, "derived current");
    exactHeader(response.headers, "x-limina-generation", String(current.generation), "derived current");
  }

  #validateArtifactHeaders(response: Response, current: DerivedRuntimeCurrent, descriptor: DerivedArtifactDescriptor, notModified: boolean): void {
    exactHeader(response.headers, "etag", contentEtag(descriptor.contentHash), "derived artifact");
    exactHeader(response.headers, "x-limina-content-hash", descriptor.contentHash, "derived artifact");
    exactHeader(response.headers, "x-limina-manifest-hash", current.manifestHash, "derived artifact");
    exactHeader(response.headers, "content-type", descriptor.mediaType, "derived artifact");
    const length = parseLength(response.headers, MAX_DERIVED_ARTIFACT_BYTES, "derived artifact");
    const expected = notModified ? 0 : descriptor.byteLength;
    if (length !== expected) throw fatal("PROTOCOL_ERROR", "derived artifact Content-Length does not match its descriptor");
  }

  async #throwResponseError(response: Response, signal?: AbortSignal): Promise<never> {
    const contentType = response.headers.get("content-type");
    if (contentType !== "application/json; charset=utf-8") {
      await cancelResponseBody(response);
      throw fatal("PROTOCOL_ERROR", `derived runtime returned unexpected HTTP ${response.status}`);
    }
    let length: number;
    try { length = parseLength(response.headers, MAX_ERROR_BYTES, "derived runtime error"); }
    catch (error) {
      await cancelResponseBody(response);
      throw error;
    }
    const body = plainObject(decodeJson(await readBounded(response, length, MAX_ERROR_BYTES, signal), "derived runtime error"), "derived runtime error");
    exactKeys(body, ["schema", "code", "message"], "derived runtime error");
    if (body.schema !== DERIVED_RUNTIME_ERROR_SCHEMA || typeof body.code !== "string" || typeof body.message !== "string"
        || body.message.length < 1 || body.message.length > 256) {
      throw fatal("PROTOCOL_ERROR", "derived runtime error envelope is invalid");
    }
    const expectedStatus: Readonly<Record<string, number>> = {
      UNAUTHORIZED: 401, FORBIDDEN_HOST: 403, FORBIDDEN_ORIGIN: 403, NO_PUBLICATION: 404,
      NOT_FOUND: 404,
      NOT_CURRENT: 409, RATE_LIMITED: 429, STREAM_LIMIT: 429,
      PUBLICATION_UNAVAILABLE: 503, ARTIFACT_INVALID: 503, SERVER_STOPPING: 503,
    };
    const statusMatches = body.code === "CURRENT_CHANGED"
      ? response.status === 409 || response.status === 412
      : expectedStatus[body.code] === response.status;
    if (!statusMatches) throw fatal("PROTOCOL_ERROR", "derived runtime error code and HTTP status disagree");
    if (body.code === "NO_PUBLICATION") throw transient("NO_PUBLICATION", body.message);
    if (body.code === "NOT_CURRENT") throw transient("NOT_CURRENT", body.message);
    if (body.code === "CURRENT_CHANGED") throw transient("CURRENT_CHANGED", body.message);
    if (body.code === "RATE_LIMITED") throw transient("RATE_LIMITED", body.message);
    if (body.code === "STREAM_LIMIT") throw transient("STREAM_LIMIT", body.message);
    if (body.code === "PUBLICATION_UNAVAILABLE") throw transient("PUBLICATION_UNAVAILABLE", body.message);
    if (body.code === "SERVER_STOPPING") throw transient("SERVER_STOPPING", body.message);
    if (body.code === "UNAUTHORIZED") throw fatal("UNAUTHORIZED", body.message);
    if (body.code === "NOT_FOUND") throw fatal("NOT_FOUND", body.message);
    if (body.code === "FORBIDDEN_HOST" || body.code === "FORBIDDEN_ORIGIN") throw fatal("FORBIDDEN", body.message);
    if (body.code === "ARTIFACT_INVALID") throw fatal("INTEGRITY_ERROR", body.message);
    throw fatal("PROTOCOL_ERROR", "derived runtime returned an unsupported error code");
  }
}
