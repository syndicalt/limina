import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { constants, lstatSync, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, relative, sep } from "node:path";
import {
  MAX_DERIVED_ARTIFACT_BYTES,
  MAX_DERIVED_MANIFEST_BYTES,
} from "../../js/src/world/compiler/manifest.mjs";
import {
  PublicationRuntimeAccessError,
  readAuthoritativePublishedDerivedRevision,
  resolveCurrentPublishedDerivedArtifact,
} from "./derived-publisher.mjs";

export const DERIVED_RUNTIME_CURRENT_SCHEMA = "limina.derived-runtime-current/v1";
export const DERIVED_RUNTIME_ERROR_SCHEMA = "limina.derived-runtime-error/v1";
export const DERIVED_RUNTIME_MAX_URL_BYTES = 2 * 1024;
export const DERIVED_RUNTIME_MAX_HEADER_BYTES = 16 * 1024;
export const DERIVED_RUNTIME_CURRENT_RATE_CAPACITY = 8;
export const DERIVED_RUNTIME_CURRENT_RATE_PER_SECOND = 4;
export const DERIVED_RUNTIME_MAX_TOKEN_ARTIFACT_STREAMS = 2;
export const DERIVED_RUNTIME_MAX_PROCESS_ARTIFACT_STREAMS = 4;

const HASH_HEX = /^[0-9a-f]{64}$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BRANCH_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const CURRENT_PATH = "/v1/derived/current";
const ARTIFACT_PATH = /^\/v1\/derived\/manifests\/([0-9a-f]{64})\/artifacts\/([0-9a-f]{64})$/;
const ALLOWED_PREFLIGHT_HEADERS = new Set(["authorization", "if-none-match"]);
const BASE_HEADERS = Object.freeze({
  "Cross-Origin-Resource-Policy": "same-site",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});

let processArtifactStreams = 0;

function plainOptions(value) {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("derived runtime server options must be a plain object");
  }
  return value;
}

function identifier(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function exactStringSet(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new TypeError(`${label} must contain 1-16 entries`);
  const out = new Set();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length < 1 || entry.length > 256 || /[\0\r\n]/.test(entry)) {
      throw new TypeError(`${label} contains an invalid entry`);
    }
    if (out.has(entry)) throw new TypeError(`${label} must be unique`);
    out.add(entry);
  }
  return out;
}

function tokenBytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError("derived runtime server token must be exactly 32 bytes");
  }
  return Buffer.from(value);
}

function boundedPort(value) {
  const port = value ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("derived runtime server port is invalid");
  return port;
}

function contained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function fixedError(code) {
  const messages = {
    BAD_REQUEST: "request is invalid",
    BODY_NOT_ALLOWED: "request bodies are not allowed",
    FORBIDDEN_HOST: "request host is not allowed",
    FORBIDDEN_ORIGIN: "request origin is not allowed",
    UNAUTHORIZED: "bearer token is missing or invalid",
    METHOD_NOT_ALLOWED: "request method is not allowed",
    NOT_FOUND: "derived runtime resource was not found",
    NO_PUBLICATION: "no derived revision is published",
    NOT_CURRENT: "published derived revision is not authoritative current",
    CURRENT_CHANGED: "current derived publication changed during request",
    RANGE_NOT_SUPPORTED: "range requests are not supported",
    RATE_LIMITED: "derived current request rate exceeded",
    STREAM_LIMIT: "derived artifact stream limit exceeded",
    PUBLICATION_UNAVAILABLE: "derived publication is unavailable",
    ARTIFACT_INVALID: "derived artifact failed integrity validation",
    SERVER_STOPPING: "derived runtime server is stopping",
  };
  return Object.freeze({ schema: DERIVED_RUNTIME_ERROR_SCHEMA, code, message: messages[code] ?? "request failed" });
}

function bodyBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function waitForDrain(response) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", drained);
      response.off("close", closed);
      response.off("error", failed);
    };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error("response closed during artifact stream")); };
    const failed = (error) => { cleanup(); reject(error); };
    response.once("drain", drained);
    response.once("close", closed);
    response.once("error", failed);
  });
}

export class DerivedRuntimeServer {
  #projectId;
  #projectRoot;
  #branchId;
  #readHeadInput;
  #token;
  #tokenText;
  #allowedHosts;
  #allowedOrigins;
  #requestedPort;
  #now;
  #server;
  #port;
  #startPromise;
  #stopPromise;
  #stopping = false;
  #abort = new AbortController();
  #sockets = new Set();
  #handlers = new Set();
  #activeArtifacts = new Set();
  #rateTokens = DERIVED_RUNTIME_CURRENT_RATE_CAPACITY;
  #rateAt;

  constructor(input) {
    const options = plainOptions(input);
    this.#projectId = identifier(options.projectId, PROJECT_ID, "derived runtime projectId");
    if (typeof options.projectRoot !== "string" || options.projectRoot.length < 1) throw new TypeError("derived runtime projectRoot is required");
    this.#projectRoot = options.projectRoot;
    this.#branchId = identifier(options.branchId, BRANCH_ID, "derived runtime branchId");
    if (typeof options.readHead !== "function") throw new TypeError("derived runtime readHead must be a function");
    this.#readHeadInput = options.readHead;
    this.#token = tokenBytes(options.token);
    this.#tokenText = this.#token.toString("base64url");
    this.#allowedHosts = exactStringSet(options.allowedHosts, "derived runtime allowedHosts");
    this.#allowedOrigins = exactStringSet(options.allowedOrigins, "derived runtime allowedOrigins");
    this.#requestedPort = boundedPort(options.port);
    this.#now = options.now ?? (() => Date.now());
    if (typeof this.#now !== "function") throw new TypeError("derived runtime now must be a function");
    this.#rateAt = this.#now();
    if (!Number.isFinite(this.#rateAt)) throw new TypeError("derived runtime now returned an invalid timestamp");
  }

  async start() {
    if (this.#stopping) throw new Error("derived runtime server is stopping");
    if (this.#startPromise !== undefined) return this.#startPromise;
    this.#startPromise = new Promise((resolveStart, rejectStart) => {
      const server = createServer({
        maxHeaderSize: DERIVED_RUNTIME_MAX_HEADER_BYTES,
        headersTimeout: 5_000,
        requestTimeout: 60_000,
        keepAliveTimeout: 5_000,
      }, (request, response) => {
        const work = this.#handle(request, response).catch((error) => this.#handleFailure(response, error));
        this.#handlers.add(work);
        void work.finally(() => this.#handlers.delete(work));
      });
      this.#server = server;
      server.maxHeadersCount = 64;
      server.on("connection", (socket) => {
        this.#sockets.add(socket);
        socket.once("close", () => this.#sockets.delete(socket));
      });
      server.on("clientError", (_error, socket) => {
        if (!socket.destroyed) socket.end("HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      });
      const failed = (error) => { server.off("listening", listening); rejectStart(error); };
      const listening = () => {
        server.off("error", failed);
        const address = server.address();
        if (address === null || typeof address === "string") {
          rejectStart(new Error("derived runtime server did not bind a TCP address"));
          return;
        }
        this.#port = address.port;
        resolveStart(Object.freeze({ baseUrl: `http://127.0.0.1:${address.port}`, token: this.#tokenText }));
      };
      server.once("error", failed);
      server.once("listening", listening);
      server.listen(this.#requestedPort, "127.0.0.1");
    });
    return this.#startPromise;
  }

  stop() {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#stopping = true;
    this.#abort.abort(new Error("derived runtime server stopped"));
    this.#stopPromise = (async () => {
      await this.#startPromise?.catch(() => {});
      for (const active of this.#activeArtifacts) {
        active.stream?.destroy();
        active.response.destroy();
        void active.handle?.close().catch(() => {});
      }
      for (const socket of this.#sockets) socket.destroy();
      const server = this.#server;
      if (server?.listening) await new Promise((resolveClose) => server.close(() => resolveClose()));
      await Promise.allSettled([...this.#handlers]);
      this.#token.fill(0);
    })();
    return this.#stopPromise;
  }

  async #readHead() {
    if (this.#abort.signal.aborted) throw this.#abort.signal.reason;
    let removeAbort;
    const aborted = new Promise((_resolve, reject) => {
      const listener = () => reject(this.#abort.signal.reason);
      removeAbort = () => this.#abort.signal.removeEventListener("abort", listener);
      this.#abort.signal.addEventListener("abort", listener, { once: true });
    });
    const reading = Promise.resolve().then(() => this.#readHeadInput());
    try { return await Promise.race([reading, aborted]); }
    finally { removeAbort?.(); void reading.catch(() => {}); }
  }

  #corsHeaders(origin) {
    return {
      ...BASE_HEADERS,
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Expose-Headers": "ETag, X-Limina-Content-Hash, X-Limina-Generation, X-Limina-Head-Hash, X-Limina-Manifest-Hash, X-Limina-Revision",
      Vary: "Origin",
    };
  }

  #sendJson(response, status, value, headers = {}) {
    if (response.headersSent || response.destroyed) return;
    const bytes = bodyBytes(value);
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store",
      ...headers,
    });
    response.end(bytes);
  }

  #sendError(response, status, code, origin) {
    this.#sendJson(response, status, fixedError(code), origin === undefined ? BASE_HEADERS : this.#corsHeaders(origin));
  }

  #validateHost(request) {
    const raw = request.headers.host;
    if (typeof raw !== "string" || raw.length > 256 || /[\0\r\n/@\\]/.test(raw)) return false;
    try {
      const parsed = new URL(`http://${raw}`);
      const port = parsed.port === "" ? 80 : Number(parsed.port);
      return parsed.pathname === "/" && port === this.#port && this.#allowedHosts.has(parsed.hostname);
    } catch { return false; }
  }

  #validateBearer(request) {
    const raw = request.headers.authorization;
    if (typeof raw !== "string" || !raw.startsWith("Bearer ")) return false;
    const encoded = raw.slice(7);
    if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return false;
    let candidate;
    try { candidate = Buffer.from(encoded, "base64url"); } catch { return false; }
    return candidate.byteLength === this.#token.byteLength && timingSafeEqual(candidate, this.#token);
  }

  #takeCurrentRate() {
    const now = this.#now();
    if (!Number.isFinite(now)) return false;
    const elapsed = Math.max(0, now - this.#rateAt);
    this.#rateAt = now;
    this.#rateTokens = Math.min(
      DERIVED_RUNTIME_CURRENT_RATE_CAPACITY,
      this.#rateTokens + elapsed * DERIVED_RUNTIME_CURRENT_RATE_PER_SECOND / 1000,
    );
    if (this.#rateTokens < 1) return false;
    this.#rateTokens -= 1;
    return true;
  }

  async #handle(request, response) {
    if (this.#stopping) { this.#sendError(response, 503, "SERVER_STOPPING"); return; }
    const rawUrl = request.url ?? "";
    if (Buffer.byteLength(rawUrl, "utf8") > DERIVED_RUNTIME_MAX_URL_BYTES || rawUrl.includes("\\") || rawUrl.includes("%") || rawUrl.includes("?")) {
      this.#sendError(response, 400, "BAD_REQUEST"); return;
    }
    if (!this.#validateHost(request)) { this.#sendError(response, 403, "FORBIDDEN_HOST"); return; }
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !this.#allowedOrigins.has(origin)) { this.#sendError(response, 403, "FORBIDDEN_ORIGIN"); return; }
    if (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0"
        || request.headers["transfer-encoding"] !== undefined) {
      this.#sendError(response, 400, "BODY_NOT_ALLOWED", origin); return;
    }
    const method = request.method ?? "";
    if (method === "OPTIONS") { this.#handleOptions(request, response, rawUrl, origin); return; }
    if (method !== "GET" && method !== "HEAD") { this.#sendError(response, 405, "METHOD_NOT_ALLOWED", origin); return; }
    if (!this.#validateBearer(request)) { this.#sendError(response, 401, "UNAUTHORIZED", origin); return; }

    if (rawUrl === CURRENT_PATH) {
      if (!this.#takeCurrentRate()) { this.#sendError(response, 429, "RATE_LIMITED", origin); return; }
      await this.#serveCurrent(request, response, origin, method === "HEAD");
      return;
    }
    const match = ARTIFACT_PATH.exec(rawUrl);
    if (match !== null && method === "GET") {
      if (request.headers.range !== undefined) { this.#sendError(response, 416, "RANGE_NOT_SUPPORTED", origin); return; }
      await this.#serveArtifact(request, response, origin, match[1], match[2]);
      return;
    }
    if (match !== null) { this.#sendError(response, 405, "METHOD_NOT_ALLOWED", origin); return; }
    this.#sendError(response, 404, "NOT_FOUND", origin);
  }

  #handleOptions(request, response, rawUrl, origin) {
    const artifact = ARTIFACT_PATH.test(rawUrl);
    if (rawUrl !== CURRENT_PATH && !artifact) { this.#sendError(response, 404, "NOT_FOUND", origin); return; }
    const requestedMethod = String(request.headers["access-control-request-method"] ?? "").toUpperCase();
    if (requestedMethod !== "GET" && !(rawUrl === CURRENT_PATH && requestedMethod === "HEAD")) {
      this.#sendError(response, 405, "METHOD_NOT_ALLOWED", origin); return;
    }
    const requestedHeaders = String(request.headers["access-control-request-headers"] ?? "")
      .split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
    if (requestedHeaders.some((entry) => !ALLOWED_PREFLIGHT_HEADERS.has(entry))) {
      this.#sendError(response, 400, "BAD_REQUEST", origin); return;
    }
    response.writeHead(204, {
      ...this.#corsHeaders(origin),
      "Access-Control-Allow-Methods": rawUrl === CURRENT_PATH ? "GET, HEAD, OPTIONS" : "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, If-None-Match",
      "Access-Control-Max-Age": "600",
      "Content-Length": "0",
      "Cache-Control": "no-store",
    });
    response.end();
  }

  async #currentView() {
    return readAuthoritativePublishedDerivedRevision({
      projectRoot: this.#projectRoot,
      branchId: this.#branchId,
      readHead: () => this.#readHead(),
      shouldCancel: () => this.#abort.signal.aborted,
    });
  }

  async #serveCurrent(request, response, origin, headOnly) {
    let view;
    try { view = await this.#currentView(); }
    catch (error) { this.#publicationError(response, error, origin, false); return; }
    const etag = `"${view.manifest.manifestHash}"`;
    const headers = {
      ...this.#corsHeaders(origin),
      ETag: etag,
      "Cache-Control": "no-store",
      "X-Limina-Manifest-Hash": view.manifest.manifestHash,
      "X-Limina-Revision": String(view.source.revision),
      "X-Limina-Head-Hash": view.source.headHash,
      "X-Limina-Generation": String(view.generation),
    };
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { ...headers, "Content-Length": "0" });
      response.end();
      return;
    }
    const payload = bodyBytes(Object.freeze({
      schema: DERIVED_RUNTIME_CURRENT_SCHEMA,
      projectId: this.#projectId,
      branchId: this.#branchId,
      generation: view.generation,
      source: view.source,
      manifest: view.manifest,
    }));
    if (payload.byteLength > MAX_DERIVED_MANIFEST_BYTES + 64 * 1024) {
      this.#sendError(response, 503, "PUBLICATION_UNAVAILABLE", origin); return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(payload.byteLength),
      ...headers,
    });
    response.end(headOnly ? undefined : payload);
  }

  async #serveArtifact(request, response, origin, manifestHex, contentHex) {
    if (!HASH_HEX.test(manifestHex) || !HASH_HEX.test(contentHex)) { this.#sendError(response, 404, "NOT_FOUND", origin); return; }
    if (this.#activeArtifacts.size >= DERIVED_RUNTIME_MAX_TOKEN_ARTIFACT_STREAMS
        || processArtifactStreams >= DERIVED_RUNTIME_MAX_PROCESS_ARTIFACT_STREAMS) {
      this.#sendError(response, 429, "STREAM_LIMIT", origin); return;
    }
    const active = { response, handle: undefined, stream: undefined };
    this.#activeArtifacts.add(active);
    processArtifactStreams++;
    let headersSent = false;
    try {
      const manifestHash = `sha256:${manifestHex}`;
      const contentHash = `sha256:${contentHex}`;
      let initial;
      try { initial = await this.#currentView(); }
      catch (error) { this.#publicationError(response, error, origin, false); return; }
      if (initial.manifest.manifestHash !== manifestHash) {
        this.#sendError(response, 412, "CURRENT_CHANGED", origin); return;
      }
      let access;
      try {
        access = resolveCurrentPublishedDerivedArtifact({
          projectRoot: this.#projectRoot,
          branchId: this.#branchId,
          manifestHash,
          contentHash,
        });
      } catch (error) {
        this.#publicationError(response, error, origin, true); return;
      }
      if (access.descriptor.byteLength > MAX_DERIVED_ARTIFACT_BYTES) {
        this.#sendError(response, 503, "ARTIFACT_INVALID", origin); return;
      }
      const leaf = lstatSync(access.path);
      if (leaf.isSymbolicLink() || !leaf.isFile()) throw new Error("artifact is not a regular file");
      const handle = await open(access.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      active.handle = handle;
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink < 1 || !sameFile(leaf, opened) || opened.size !== access.descriptor.byteLength) {
        throw new Error("artifact changed while opening");
      }
      const root = realpathSync(access.artifactRoot);
      let openedPath;
      try { openedPath = realpathSync(`/proc/self/fd/${handle.fd}`); }
      catch {
        openedPath = realpathSync(access.path);
        if (!sameFile(opened, statSync(openedPath))) throw new Error("artifact path changed after open");
      }
      if (!contained(root, openedPath) || openedPath === root) throw new Error("artifact resolved outside publication root");

      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, opened.size)));
      let position = 0;
      while (position < opened.size) {
        if (request.destroyed || response.destroyed || this.#abort.signal.aborted) throw new Error("artifact request aborted");
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, opened.size - position), position);
        if (bytesRead === 0) throw new Error("artifact truncated during validation");
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      if (`sha256:${hash.digest("hex")}` !== contentHash) throw new Error("artifact content hash mismatch");
      const afterHash = await handle.stat();
      if (!sameFile(opened, afterHash) || afterHash.nlink < 1 || afterHash.size !== opened.size) throw new Error("artifact changed during validation");

      let confirmed;
      try { confirmed = await this.#currentView(); }
      catch (error) { this.#publicationError(response, error, origin, false); return; }
      if (confirmed.manifest.manifestHash !== manifestHash || confirmed.generation !== initial.generation
          || confirmed.generation !== access.generation) {
        this.#sendError(response, 412, "CURRENT_CHANGED", origin); return;
      }
      const etag = `"${contentHash}"`;
      const headers = {
        ...this.#corsHeaders(origin),
        "Content-Type": access.descriptor.mediaType,
        "Content-Length": String(access.descriptor.byteLength),
        "Cache-Control": "private, max-age=31536000, immutable",
        ETag: etag,
        "X-Limina-Content-Hash": contentHash,
        "X-Limina-Manifest-Hash": manifestHash,
      };
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { ...headers, "Content-Length": "0" });
        response.end();
        return;
      }
      const stream = handle.createReadStream({ autoClose: false, start: 0 });
      active.stream = stream;
      response.writeHead(200, headers);
      headersSent = true;
      const streamedHash = createHash("sha256");
      let streamedBytes = 0;
      for await (const chunk of stream) {
        if (request.destroyed || response.destroyed || this.#abort.signal.aborted) throw new Error("artifact request aborted");
        streamedHash.update(chunk);
        streamedBytes += chunk.byteLength;
        if (!response.write(chunk)) await waitForDrain(response);
      }
      const finalStat = await handle.stat();
      if (streamedBytes !== access.descriptor.byteLength || `sha256:${streamedHash.digest("hex")}` !== contentHash
          || !sameFile(opened, finalStat) || finalStat.nlink < 1 || finalStat.size !== opened.size) {
        throw new Error("artifact changed during stream");
      }
      response.end();
    } catch (error) {
      if (headersSent || response.headersSent) response.destroy();
      else if (!response.destroyed) this.#sendError(response, 503, "ARTIFACT_INVALID", origin);
    } finally {
      active.stream?.destroy();
      await active.handle?.close().catch(() => {});
      this.#activeArtifacts.delete(active);
      processArtifactStreams--;
    }
  }

  #publicationError(response, error, origin, artifactRequest) {
    if (!(error instanceof PublicationRuntimeAccessError)) {
      this.#sendError(response, 503, "PUBLICATION_UNAVAILABLE", origin); return;
    }
    if (error.code === "NO_PUBLICATION") this.#sendError(response, 404, "NO_PUBLICATION", origin);
    else if (error.code === "NOT_CURRENT") this.#sendError(response, 409, "NOT_CURRENT", origin);
    else if (error.code === "CURRENT_CHANGED") this.#sendError(response, artifactRequest ? 412 : 409, "CURRENT_CHANGED", origin);
    else if (error.code === "UNREFERENCED_ARTIFACT") this.#sendError(response, 404, "NOT_FOUND", origin);
    else this.#sendError(response, 503, "PUBLICATION_UNAVAILABLE", origin);
  }

  #handleFailure(response, _error) {
    if (!response.headersSent && !response.destroyed) this.#sendError(response, 503, "PUBLICATION_UNAVAILABLE");
    else if (!response.destroyed) response.destroy();
  }
}
