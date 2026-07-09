import { randomUUID } from "node:crypto";

const DEFAULT_URL = "ws://127.0.0.1:8787/";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RPC_MESSAGE_CHARS = 1_048_576;

export class EditorClientError extends Error {
  constructor(message, { code, data, cause } = {}) {
    super(message, { cause });
    this.name = "EditorClientError";
    this.code = code;
    this.data = data;
  }
}

export function assertEditorUrl(input) {
  let url;
  try { url = new URL(input); }
  catch (error) { throw new EditorClientError(`LIMINA_EDITOR_URL is invalid: ${input}`, { cause: error }); }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new EditorClientError("LIMINA_EDITOR_URL must use ws:// or wss://");
  if (url.username || url.password || url.hash) {
    throw new EditorClientError("LIMINA_EDITOR_URL must not contain credentials or a fragment");
  }
  return url.href;
}

export function assertLoopbackEditorUrl(input) {
  const url = new URL(assertEditorUrl(input));
  if (url.protocol !== "ws:") throw new EditorClientError("the Atlas editor connection must use loopback ws://");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new EditorClientError("LIMINA_EDITOR_URL must target the loopback editor host");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) {
    throw new EditorClientError("LIMINA_EDITOR_URL must not contain credentials, query, fragment, or a custom path");
  }
  return url.href;
}

async function defaultWebSocketConstructor() {
  if (typeof globalThis.WebSocket === "function") return globalThis.WebSocket;
  try {
    const module = await import("ws");
    return module.WebSocket ?? module.default;
  } catch (error) {
    throw new EditorClientError(
      "this Node runtime has no WebSocket client; use Node 22+ or install the optional 'ws' package",
      { cause: error },
    );
  }
}

function onSocket(socket, event, handler) {
  if (typeof socket.addEventListener === "function") socket.addEventListener(event, handler);
  else socket.on(event, handler);
}

function messageData(eventOrData) {
  if (eventOrData && typeof eventOrData === "object" && "data" in eventOrData) return eventOrData.data;
  return eventOrData;
}

function asText(data) {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return String(data);
}

export function editorClientConfigFromEnvironment(environment = process.env, overrides = {}) {
  const token = environment.LIMINA_EDITOR_TOKEN;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    throw new EditorClientError(
      "LIMINA_EDITOR_TOKEN must be the 32-128 character token printed by the project's editor launcher",
    );
  }
  const timeoutMs = Number(environment.LIMINA_CALL_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new EditorClientError("LIMINA_CALL_TIMEOUT_MS must be an integer from 100 to 120000");
  }
  return Object.freeze({
    url: assertEditorUrl(environment.LIMINA_EDITOR_URL ?? DEFAULT_URL),
    authToken: token,
    timeoutMs,
    agentId: overrides.agentId ?? "limina-coordinator",
    profile: overrides.profile ?? "builder.readWrite",
    sessionId: overrides.sessionId ?? `limina-${randomUUID()}`,
  });
}

/** Minimal bounded JSON-RPC client for Design Space -> authoritative editor_host calls. */
export class EditorBridgeClient {
  constructor(config, { getWebSocketConstructor = defaultWebSocketConstructor } = {}) {
    if (!config || typeof config.authToken !== "string" || config.authToken.length === 0
        || typeof config.agentId !== "string" || config.agentId.length === 0
        || typeof config.sessionId !== "string" || config.sessionId.length === 0
        || typeof config.profile !== "string" || config.profile.length === 0
        || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 120_000) {
      throw new EditorClientError("editor client configuration is incomplete or outside its resource bounds");
    }
    this.config = Object.freeze({ ...config, url: assertEditorUrl(config.url) });
    this.getWebSocketConstructor = getWebSocketConstructor;
    this.WebSocketConstructor = undefined;
    this.socket = undefined;
    this.connecting = undefined;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  async callTool(name, args = {}, options = {}) {
    if (typeof name !== "string" || name.length === 0 || args === null || Array.isArray(args) || typeof args !== "object") {
      throw new EditorClientError("callTool requires a non-empty name and an object argument");
    }
    const mcp = await this.rpc("tools/call", { name, arguments: args }, options);
    if (!mcp || mcp.success !== true) {
      throw new EditorClientError(mcp?.error?.message ?? `${name} failed`, {
        code: mcp?.error?.code,
        data: mcp,
      });
    }
    return mcp.result;
  }

  close() {
    this.closed = true;
    this.#rejectPending(new EditorClientError("editor authoring client closed"));
    try { this.socket?.close(); } catch { /* already closed */ }
    this.socket = undefined;
  }

  async rpc(method, params = {}, { retryTransport = false } = {}) {
    let lastError;
    const attempts = retryTransport ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await this.#ensureConnected();
        return await this.#request(method, params);
      } catch (error) {
        lastError = error;
        if (error instanceof EditorClientError && error.code !== undefined) throw error;
        this.#dropSocket();
      }
    }
    if (!retryTransport) throw lastError;
    throw new EditorClientError(`editor_host ${method} failed after one reconnect: ${lastError instanceof Error ? lastError.message : String(lastError)}`, { cause: lastError });
  }

  async #ensureConnected() {
    if (this.closed) throw new EditorClientError("editor authoring client is closed");
    const open = this.WebSocketConstructor?.OPEN ?? 1;
    if (this.socket?.readyState === open) return;
    if (this.connecting !== undefined) return this.connecting;
    this.connecting = this.#connect();
    try { await this.connecting; }
    finally { this.connecting = undefined; }
  }

  async #connect() {
    this.WebSocketConstructor ??= await this.getWebSocketConstructor();
    const socket = await new Promise((resolve, reject) => {
      const candidate = new this.WebSocketConstructor(this.config.url);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { candidate.close(); } catch { /* best effort */ }
        reject(new EditorClientError(`editor_host connection timed out after ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(candidate);
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new EditorClientError(`WebSocket error connecting to ${this.config.url}`));
      };
      onSocket(candidate, "open", succeed);
      onSocket(candidate, "error", fail);
      onSocket(candidate, "close", fail);
    });
    this.socket = socket;
    onSocket(socket, "message", (event) => this.#onMessage(messageData(event)));
    onSocket(socket, "close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.#rejectPending(new EditorClientError("editor_host WebSocket closed"));
    });
    onSocket(socket, "error", () => {});
    await this.#request("initialize", {
      agentId: this.config.agentId,
      sessionId: this.config.sessionId,
      profile: this.config.profile,
      authToken: this.config.authToken,
    });
  }

  #request(method, params) {
    const open = this.WebSocketConstructor?.OPEN ?? 1;
    if (this.socket?.readyState !== open) return Promise.reject(new EditorClientError("editor_host WebSocket is not open"));
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EditorClientError(`editor_host ${method} timed out after ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try { this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }
    catch (error) {
      const pending = this.pending.get(id);
      if (pending) clearTimeout(pending.timer);
      this.pending.delete(id);
      return Promise.reject(new EditorClientError(`failed to send editor_host ${method}`, { cause: error }));
    }
    return promise;
  }

  #onMessage(data) {
    const text = asText(data);
    if (text.length > MAX_RPC_MESSAGE_CHARS) {
      this.#protocolFailure("editor_host response exceeds the 1048576-character limit");
      return;
    }
    let message;
    try { message = JSON.parse(text); }
    catch { this.#protocolFailure("editor_host sent invalid JSON"); return; }
    if (!message || Array.isArray(message) || typeof message !== "object" || message.jsonrpc !== "2.0") {
      this.#protocolFailure("editor_host sent an invalid JSON-RPC envelope");
      return;
    }
    if (!("id" in message)) {
      if (typeof message.method !== "string") this.#protocolFailure("editor_host sent a malformed JSON-RPC notification");
      return;
    }
    if (!Number.isSafeInteger(message.id) || message.id < 1) {
      this.#protocolFailure("editor_host response id is invalid");
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    if (hasResult === hasError) {
      pending.reject(new EditorClientError("editor_host response must contain exactly one of result or error"));
      return;
    }
    if (hasError) {
      if (!message.error || Array.isArray(message.error) || typeof message.error !== "object"
          || typeof message.error.code !== "number" || typeof message.error.message !== "string") {
        pending.reject(new EditorClientError("editor_host returned a malformed JSON-RPC error"));
        return;
      }
      pending.reject(new EditorClientError(message.error.message ?? "editor_host request failed", {
        code: message.error.code,
        data: message.error.data,
      }));
    } else pending.resolve(message.result);
  }

  #rejectPending(error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  #protocolFailure(message) {
    const error = new EditorClientError(message);
    this.#rejectPending(error);
    this.#dropSocket();
  }

  #dropSocket() {
    try { this.socket?.close(); } catch { /* best effort */ }
    this.socket = undefined;
  }
}

export function createEditorClientFromEnvironment(environment = process.env, overrides, dependencies) {
  return new EditorBridgeClient(editorClientConfigFromEnvironment(environment, overrides), dependencies);
}
