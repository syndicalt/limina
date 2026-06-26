// limina MCP-ws client (browser-native ES module, no build step).
//
// A thin JSON-RPC 2.0 client over the authoritative server's WebSocket transport
// (`limina --mcp-ws`, default :8787). It speaks the EXACT shapes verified by
// js/test/p7_editor_contract.ts:
//   - initialize(agentId, sessionId, profile) -> immediate {protocolVersion, session}
//   - callTool(name, args): tools/call, applied at the next server tick boundary.
//       success  -> JSON-RPC result is the MCPResponse {success, result, metadata};
//                   the tool's output is response.result.
//       held     -> JSON-RPC ERROR, error.code === -32003, error.message === approvalId,
//                   error.data is the MCPResponse (error.code === "pending_approval").
//       forbidden-> JSON-RPC ERROR, error.code === -32001.
//   - state/subscribe -> a `state/snapshot` notification then per-tick `state/delta`
//       notifications (read-only live transforms; the editor mainly polls, but we
//       cache deltas so the World panel can move between snapshots).
//
// Attribution is bound server-side at initialize from the session, never from a
// per-call payload — a client cannot raise its own privilege per intent.

/** MCP-level error code -> a stable symbolic name (mirrors mcpErrorToJsonRpc). */
export const JSONRPC_PENDING_APPROVAL = -32003;
export const JSONRPC_FORBIDDEN = -32001;

export class McpError extends Error {
  /** @param {number} code @param {string} message @param {unknown} data */
  constructor(code, message, data) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.data = data;
  }
  /** True when the call was HELD by the review gate; `this.message` is the approvalId. */
  get isPendingApproval() {
    return this.code === JSONRPC_PENDING_APPROVAL;
  }
}

export class McpClient {
  /** @param {string} url e.g. ws://localhost:8787/ */
  constructor(url) {
    this.url = url;
    /** @type {WebSocket | undefined} */
    this.ws = undefined;
    this.nextId = 1;
    /** @type {Map<number, {resolve:(m:any)=>void, reject:(e:any)=>void}>} */
    this.pending = new Map();
    /** Latest authoritative transform per entity id (snapshot + deltas). */
    this.entityState = new Map();
    /** @type {undefined | (() => void)} */
    this.onSync = undefined;
    /** @type {undefined | ((connected:boolean)=>void)} */
    this.onConnectionChange = undefined;
    this.session = undefined;
  }

  /** Open the socket. Resolves once the WebSocket is OPEN. */
  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => {
        settled = true;
        if (this.onConnectionChange) this.onConnectionChange(true);
        resolve(undefined);
      };
      ws.onerror = (ev) => {
        if (!settled) {
          settled = true;
          reject(new Error("WebSocket error connecting to " + this.url));
        }
      };
      ws.onclose = () => {
        if (this.onConnectionChange) this.onConnectionChange(false);
        for (const [, p] of this.pending) p.reject(new Error("connection closed"));
        this.pending.clear();
      };
      ws.onmessage = (ev) => this._onMessage(String(ev.data));
    });
  }

  close() {
    if (this.ws) this.ws.close();
  }

  /** @param {string} raw a single JSON-RPC line */
  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // Read-only state-sync notifications (no id).
    if (msg.method === "state/snapshot" || msg.method === "state/delta") {
      const entities = msg.method === "state/snapshot" ? msg.params?.entities : msg.params?.changes;
      if (Array.isArray(entities)) {
        for (const e of entities) this.entityState.set(e.id, e);
        if (this.onSync) this.onSync();
      }
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.resolve(msg);
      }
    }
  }

  /** Low-level JSON-RPC request. Resolves with the raw response message. */
  _request(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("socket is not open"));
    }
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return promise;
  }

  /** Bind this session's identity + profile (-> permission set) server-side. */
  async initialize(agentId, sessionId, profile) {
    const msg = await this._request("initialize", { agentId, sessionId, profile });
    if (msg.error) throw new McpError(msg.error.code, msg.error.message, msg.error.data);
    this.session = msg.result?.session;
    return this.session;
  }

  /** Subscribe to the read-only authoritative state stream (snapshot + deltas). */
  async subscribe() {
    const msg = await this._request("state/subscribe", {});
    if (msg.error) throw new McpError(msg.error.code, msg.error.message, msg.error.data);
    return msg.result;
  }

  /**
   * Call a skill. Returns the skill's OUTPUT (the unwrapped MCPResponse.result).
   * Throws McpError for a held action (isPendingApproval; message === approvalId),
   * a forbidden call, or a handler error — exactly the cases the UI must surface.
   * @param {string} name @param {Record<string, unknown>} [args]
   */
  async callTool(name, args = {}) {
    const msg = await this._request("tools/call", { name, arguments: args });
    if (msg.error) {
      // Held / forbidden / not-found surface as a JSON-RPC error; data carries the
      // MCPResponse so callers can read the symbolic MCP code when present.
      throw new McpError(msg.error.code, msg.error.message, msg.error.data);
    }
    const mcp = msg.result; // MCPResponse {success, result, metadata}
    if (mcp && mcp.success) return mcp.result;
    const err = mcp && mcp.error ? mcp.error : { code: "unknown", message: "tool call failed" };
    throw new McpError(0, err.message, mcp);
  }
}
