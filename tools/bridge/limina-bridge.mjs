#!/usr/bin/env node

import readline from "node:readline";
import { randomUUID } from "node:crypto";

const VERSION = "0.1.0";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_EDITOR_URL = "ws://localhost:8787/";
const DEFAULT_AGENT_ID = "limina-coordinator";
const DEFAULT_PROFILE = "builder.readWrite";
const DEFAULT_TIMEOUT_MS = 10_000;

const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
};

function stderr(message) {
  process.stderr.write(`[limina-bridge] ${message}\n`);
}

function fatal(message) {
  stderr(message);
  process.exit(1);
}

function asRecord(value) {
  return typeof value === "object" && value !== null ? value : undefined;
}

function isJsonRpcId(value) {
  return value === null || typeof value === "string" || typeof value === "number";
}

function success(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function failure(id, code, message, data = undefined) {
  return data === undefined
    ? { jsonrpc: "2.0", id, error: { code, message } }
    : { jsonrpc: "2.0", id, error: { code, message, data } };
}

function writeJson(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function parseRequest(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return failure(null, JSON_RPC_ERRORS.parseError, "Parse error");
  }
  const rec = asRecord(parsed);
  if (rec === undefined || rec.jsonrpc !== "2.0" || typeof rec.method !== "string") {
    const id = rec !== undefined && isJsonRpcId(rec.id) ? rec.id : null;
    return failure(id, JSON_RPC_ERRORS.invalidRequest, "Invalid Request");
  }
  if (rec.id !== undefined && !isJsonRpcId(rec.id)) {
    return failure(null, JSON_RPC_ERRORS.invalidRequest, "Invalid Request");
  }
  return { jsonrpc: "2.0", id: rec.id, method: rec.method, params: rec.params };
}

async function getWebSocketConstructor() {
  if (typeof globalThis.WebSocket === "function") return globalThis.WebSocket;
  const mod = await import("ws");
  return mod.WebSocket ?? mod.default;
}

function onSocket(ws, event, handler) {
  if (typeof ws.addEventListener === "function") {
    ws.addEventListener(event, handler);
    return;
  }
  ws.on(event, handler);
}

function messageData(eventOrData) {
  if (eventOrData && typeof eventOrData === "object" && "data" in eventOrData) {
    return eventOrData.data;
  }
  return eventOrData;
}

function socketReadyState(ws, WebSocketCtor) {
  return ws?.readyState === (WebSocketCtor.OPEN ?? 1);
}

class EditorBridgeClient {
  constructor(config) {
    this.config = config;
    this.WebSocketCtor = undefined;
    this.ws = undefined;
    this.nextId = 1;
    this.pending = new Map();
    this.connecting = undefined;
    this.reconnectsRemaining = 1;
    this.closing = false;
  }

  async close() {
    this.closing = true;
    this.rejectAll(new Error("bridge is shutting down"));
    if (this.ws !== undefined) {
      try {
        this.ws.close();
      } catch {
        // already closed
      }
    }
  }

  async ensureConnected() {
    if (this.WebSocketCtor === undefined) {
      this.WebSocketCtor = await getWebSocketConstructor();
    }
    if (socketReadyState(this.ws, this.WebSocketCtor)) return;
    if (this.connecting !== undefined) {
      await this.connecting;
      return;
    }
    this.connecting = this.connectAndInitialize();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  async connectAndInitialize() {
    const ws = await this.openSocket();
    this.ws = ws;
    onSocket(ws, "message", (event) => this.onMessage(messageData(event)));
    onSocket(ws, "close", () => this.onClose());
    onSocket(ws, "error", () => {
      // The close event or request timeout carries the actionable failure.
    });
    await this.request("initialize", {
      agentId: this.config.agentId,
      sessionId: this.config.sessionId,
      profile: this.config.profile,
      authToken: this.config.authToken,
    }, { allowReconnect: false });
  }

  openSocket() {
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketCtor(this.config.url);
      let settled = false;
      const finishResolve = () => {
        if (settled) return;
        settled = true;
        resolve(ws);
      };
      const finishReject = (reason) => {
        if (settled) return;
        settled = true;
        reject(reason instanceof Error ? reason : new Error(`WebSocket connection failed: ${String(reason)}`));
      };
      onSocket(ws, "open", finishResolve);
      onSocket(ws, "error", () => finishReject(new Error(`WebSocket error connecting to ${this.config.url}`)));
      onSocket(ws, "close", () => finishReject(new Error(`WebSocket closed before opening ${this.config.url}`)));
    });
  }

  onClose() {
    const wasClosing = this.closing;
    this.ws = undefined;
    this.rejectAll(new Error("editor_host WebSocket closed"));
    if (!wasClosing && this.reconnectsRemaining > 0) {
      this.reconnectsRemaining -= 1;
      void this.ensureConnected().catch((err) => {
        stderr(`reconnect failed: ${err.message}`);
      });
    }
  }

  onMessage(data) {
    let raw;
    if (typeof data === "string") raw = data;
    else if (Buffer.isBuffer(data)) raw = data.toString("utf8");
    else if (data instanceof ArrayBuffer) raw = Buffer.from(data).toString("utf8");
    else raw = String(data);

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      stderr("ignored non-JSON message from editor_host");
      return;
    }
    if (msg.id === undefined) return;
    const key = String(msg.id);
    const pending = this.pending.get(key);
    if (pending === undefined) return;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    pending.resolve(msg);
  }

  rejectAll(err) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  async rpc(method, params = {}) {
    await this.ensureConnected();
    try {
      return await this.request(method, params, { allowReconnect: true });
    } catch (err) {
      if (this.closing || this.reconnectsRemaining <= 0) throw err;
      this.reconnectsRemaining -= 1;
      stderr(`editor_host request failed; reconnecting once: ${err.message}`);
      this.ws = undefined;
      await this.ensureConnected();
      return this.request(method, params, { allowReconnect: false });
    }
  }

  request(method, params, { allowReconnect: _allowReconnect }) {
    if (!socketReadyState(this.ws, this.WebSocketCtor)) {
      return Promise.reject(new Error("editor_host WebSocket is not open"));
    }
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    const key = String(id);
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`editor_host ${method} timed out after ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
    });
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      const pending = this.pending.get(key);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pending.delete(key);
      }
      return Promise.reject(err);
    }
    return promise.then((msg) => {
      if (msg.error !== undefined) {
        const error = new Error(msg.error.message ?? `${method} failed`);
        error.code = msg.error.code;
        error.data = msg.error.data;
        throw error;
      }
      return msg.result;
    });
  }
}

function parseToolCallParams(value) {
  const rec = asRecord(value);
  if (rec === undefined || typeof rec.name !== "string") return undefined;
  const args = rec.arguments === undefined ? {} : asRecord(rec.arguments);
  if (args === undefined) return undefined;
  return { name: rec.name, arguments: args };
}

function mcpToolResult(mcpResponse) {
  if (mcpResponse?.success) {
    return { content: [{ type: "text", text: JSON.stringify(mcpResponse.result ?? null) }] };
  }
  const message = mcpResponse?.error?.message ?? "tool call failed";
  return { content: [{ type: "text", text: message }], isError: true };
}

async function dispatch(req, editor) {
  const id = req.id ?? null;
  switch (req.method) {
    case "initialize":
      return success(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "limina-bridge", version: VERSION },
      });
    case "notifications/initialized":
      return success(id, {});
    case "ping":
      return success(id, {});
    case "tools/list": {
      const result = await editor.rpc("tools/list", {});
      const tools = Array.isArray(result?.tools) ? result.tools : [];
      return success(id, {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.input_schema,
        })),
      });
    }
    case "tools/call": {
      const params = parseToolCallParams(req.params);
      if (params === undefined) {
        return failure(id, JSON_RPC_ERRORS.invalidParams, "tools/call requires name and object arguments");
      }
      const result = await editor.rpc("tools/call", { name: params.name, arguments: params.arguments });
      return success(id, mcpToolResult(result));
    }
    case "shutdown":
    case "exit":
      await editor.close();
      return success(id, {});
    default:
      if (req.method.startsWith("notifications/")) return success(id, {});
      return failure(id, JSON_RPC_ERRORS.methodNotFound, `Method not found: ${req.method}`);
  }
}

async function main() {
  const authToken = process.env.LIMINA_EDITOR_TOKEN;
  if (authToken === undefined || authToken.length === 0) {
    fatal("LIMINA_EDITOR_TOKEN is required; copy the EDITOR_AUTH_TOKEN printed by editor_host at boot.");
  }

  const config = {
    url: process.env.LIMINA_EDITOR_URL ?? DEFAULT_EDITOR_URL,
    authToken,
    agentId: process.env.LIMINA_AGENT_ID ?? DEFAULT_AGENT_ID,
    sessionId: process.env.LIMINA_SESSION_ID ?? `limina-bridge-${randomUUID()}`,
    profile: process.env.LIMINA_PROFILE ?? DEFAULT_PROFILE,
    timeoutMs: Number.parseInt(process.env.LIMINA_CALL_TIMEOUT_MS ?? `${DEFAULT_TIMEOUT_MS}`, 10),
  };
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    fatal("LIMINA_CALL_TIMEOUT_MS must be a positive integer.");
  }

  const editor = new EditorBridgeClient(config);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let shuttingDown = false;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const req = parseRequest(trimmed);
    if ("error" in req) {
      writeJson(req);
      continue;
    }

    const shouldReply = req.id !== undefined;
    try {
      const response = await dispatch(req, editor);
      if (shouldReply) writeJson(response);
      if (req.method === "shutdown" || req.method === "exit") {
        shuttingDown = true;
        break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (shouldReply) writeJson(failure(req.id ?? null, JSON_RPC_ERRORS.internalError, message));
    }
  }

  if (!shuttingDown) await editor.close();
}

main().then(() => {
  process.exit(0);
}).catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  stderr(message);
  process.exit(1);
});
