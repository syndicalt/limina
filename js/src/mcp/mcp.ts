// MCP-style interface — a thin, discoverable wrapper over the SkillRegistry.
// The in-process API stays available, while the stdio transport enforces an
// initialize-bound external session so callers cannot spoof attribution.

import { JSON_RPC_ERRORS, mcpErrorToJsonRpc, type JsonRpcFailure, type JsonRpcId, type JsonRpcRequest, type JsonRpcResponse, type MCPRequest, type MCPResponse, type MCPTool } from "./protocol.ts";
import type { InvokeBase, SkillRegistry, WorldContext } from "../skills/registry.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { PolicyEngine, policyEventPayload, policyEventType, type PolicyDecision } from "../policy/engine.ts";

export interface Session {
  agentId: string;
  sessionId: string;
  profile: string;
  permissions: ReadonlySet<string>;
}

export class Mcp {
  private tick = 0;
  constructor(
    private readonly registry: SkillRegistry,
    private readonly world: WorldContext,
    private readonly session?: Session,
  ) {}

  setTick(tick: number): void {
    this.tick = tick;
  }

  /** Advertise only the tools this session may invoke (least-privilege exposure).
   *  Trusted in-process callers may construct Mcp with a session; external
   *  transports must pass their initialize-bound session explicitly. */
  listTools(session = this.session): MCPTool[] {
    if (session === undefined) return [];
    return this.registry.list(session?.permissions);
  }

  callTool(req: MCPRequest, session = this.session): Promise<MCPResponse> {
    if (session === undefined) {
      return Promise.resolve({ success: false, error: { code: "forbidden", message: "MCP session is not initialized" } });
    }
    const base: InvokeBase = {
      agentId: session.agentId,
      sessionId: session.sessionId,
      profile: session.profile,
      permissions: session.permissions,
      tick: this.tick,
      world: this.world,
    };
    return this.registry.invoke(req.tool, req.input, base);
  }

  setPolicy(policy: PolicyEngine): void {
    this.registry.setPolicy(policy);
  }

  admitSession(policy: PolicyEngine, params: InitializeParams): PolicyDecision {
    const decision = policy.admitSession({
      boundary: "session",
      agentId: params.agentId,
      sessionId: params.sessionId,
      cap: "",
      profile: params.profile,
    });
    this.registry.tracer.emit({
      type: policyEventType(decision),
      actorId: params.agentId,
      threadId: params.sessionId,
      parentEventId: null,
      causedBy: [],
      payload: policyEventPayload(decision),
    });
    return decision;
  }

}

interface InitializeParams {
  agentId: string;
  sessionId: string;
  profile: string;
}

interface ToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
  context?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || typeof value === "number";
}

function parseInitializeParams(value: unknown): InitializeParams | undefined {
  const rec = asRecord(value);
  if (rec === undefined) return undefined;
  if (typeof rec.agentId !== "string" || typeof rec.sessionId !== "string" || typeof rec.profile !== "string") return undefined;
  return { agentId: rec.agentId, sessionId: rec.sessionId, profile: rec.profile };
}

function parseToolCallParams(value: unknown): ToolCallParams | undefined {
  const rec = asRecord(value);
  if (rec === undefined || typeof rec.name !== "string") return undefined;
  const args = rec.arguments === undefined ? {} : asRecord(rec.arguments);
  if (args === undefined) return undefined;
  return { name: rec.name, arguments: args, context: rec.context };
}

function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcFailure {
  return data === undefined
    ? { jsonrpc: "2.0", id, error: { code, message } }
    : { jsonrpc: "2.0", id, error: { code, message, data } };
}

function parseJsonRpc(line: string): JsonRpcRequest | JsonRpcFailure {
  let parsed: unknown;
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

// limina release version reported in MCP `serverInfo`.
const SERVER_VERSION = "0.1.0";
// Profile granted to a standard MCP client, which does not supply limina's
// agentId/sessionId/profile. `builder.readWrite` = full authoring (what someone
// installing limina into their agent wants). Making this configurable per
// connection needs an engine env/argv channel to JS (follow-up); today it is the
// fixed default for spec-mode sessions.
const DEFAULT_MCP_PROFILE = "system.readonly";
// MCP protocol version advertised when a spec client omits one.
const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

export class JsonRpcTransport {
  private session?: Session;
  /** "native" = limina-native init (explicit attribution); "spec" = a standard MCP client. */
  private mode: "native" | "spec" = "native";
  private sessionSeq = 0;
  private readonly allowedProfiles: ReadonlySet<string>;
  private readonly policy?: PolicyEngine;
  private readonly specProfile: string;

  constructor(
    private readonly mcp: Mcp,
    private readonly writeLine: (line: string) => void | Promise<void>,
    opts: {
      allowedProfiles?: ReadonlySet<string>;
      policy?: PolicyEngine;
      specProfile?: string;
    } = {},
  ) {
    this.allowedProfiles = opts.allowedProfiles ?? new Set([DEFAULT_MCP_PROFILE]);
    this.policy = opts.policy;
    this.specProfile = opts.specProfile ?? DEFAULT_MCP_PROFILE;
    if (!this.allowedProfiles.has(this.specProfile)) {
      throw new Error(`JsonRpcTransport: spec profile '${this.specProfile}' is not in allowedProfiles`);
    }
    if (this.policy !== undefined) this.mcp.setPolicy(this.policy);
  }

  async handleLine(line: string): Promise<void> {
    const req = parseJsonRpc(line);
    if ("error" in req) {
      await this.write(req);
      return;
    }

    // JSON-RPC notifications do not get responses, but still execute.
    const id = req.id ?? null;
    const shouldReply = req.id !== undefined;
    const response = await this.dispatch(req, id);
    if (shouldReply) await this.write(response);
  }

  async run(lines: AsyncIterable<string>): Promise<void> {
    try {
      for await (const line of lines) await this.handleLine(line);
    } finally {
      this.close();
    }
  }

  /** Release admission exactly once on shutdown/EOF/transport teardown. */
  close(): void {
    if (this.session !== undefined) this.policy?.releaseSession(this.session.sessionId);
    this.session = undefined;
  }

  private async write(response: JsonRpcResponse): Promise<void> {
    await this.writeLine(JSON.stringify(response));
  }

  private async dispatch(req: JsonRpcRequest, id: JsonRpcId): Promise<JsonRpcResponse> {
    switch (req.method) {
      case "initialize": {
        if (this.session !== undefined) {
          return failure(id, JSON_RPC_ERRORS.invalidRequest, "MCP session is already initialized");
        }
        // limina-native init: caller supplies explicit attribution + profile.
        const native = parseInitializeParams(req.params);
        if (native !== undefined) {
          if (!this.allowedProfiles.has(native.profile)) {
            return failure(id, mcpErrorToJsonRpc("forbidden"), `initialize denied: profile '${native.profile}' is not allowed on this transport`);
          }
          if (this.policy !== undefined) {
            const decision = this.mcp.admitSession(this.policy, native);
            if (!decision.allow) return failure(id, mcpErrorToJsonRpc("forbidden"), `session admission denied: ${decision.reason}`);
          }
          let permissions: ReadonlySet<string>;
          try { permissions = resolveProfile(native.profile); }
          catch (error) {
            this.policy?.releaseSession(native.sessionId);
            return failure(id, mcpErrorToJsonRpc("forbidden"), error instanceof Error ? error.message : String(error));
          }
          this.mode = "native";
          this.session = {
            agentId: native.agentId,
            sessionId: native.sessionId,
            profile: native.profile,
            permissions,
          };
          return success(id, {
            protocolVersion: "2026-06-23",
            session: { agentId: native.agentId, sessionId: native.sessionId, profile: native.profile },
          });
        }
        // Spec MCP init: a standard client (Claude, Codex, Cursor, ...) that does
        // not know limina's attribution. Synthesize a default session and reply
        // with the spec-required capabilities + serverInfo.
        this.mode = "spec";
        const params = asRecord(req.params);
        const clientInfo = asRecord(params?.clientInfo);
        const clientName = typeof clientInfo?.name === "string" ? clientInfo.name : "mcp-client";
        const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : FALLBACK_PROTOCOL_VERSION;
        const specInit: InitializeParams = {
          agentId: clientName,
          sessionId: `mcp-${++this.sessionSeq}`,
          profile: this.specProfile,
        };
        if (this.policy !== undefined) {
          const decision = this.mcp.admitSession(this.policy, specInit);
          if (!decision.allow) return failure(id, mcpErrorToJsonRpc("forbidden"), `session admission denied: ${decision.reason}`);
        }
        this.session = {
          agentId: specInit.agentId,
          sessionId: specInit.sessionId,
          profile: specInit.profile,
          permissions: resolveProfile(specInit.profile),
        };
        return success(id, {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: { name: "limina", version: SERVER_VERSION },
        });
      }
      // Post-initialize handshake notification (no id → reply is dropped) + keepalive.
      case "notifications/initialized":
        return success(id, {});
      case "ping":
        return success(id, {});
      case "tools/list":
      case "listTools": {
        if (this.session === undefined) return failure(id, -32000, "MCP session is not initialized");
        const tools = this.mcp.listTools(this.session);
        if (this.mode === "spec") {
          // Spec field is `inputSchema` (camelCase); limina-native uses `input_schema`.
          return success(id, {
            tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })),
          });
        }
        return success(id, { tools });
      }
      case "tools/call":
      case "callTool": {
        if (this.session === undefined) return failure(id, -32000, "MCP session is not initialized");
        const params = parseToolCallParams(req.params);
        if (params === undefined) return failure(id, JSON_RPC_ERRORS.invalidParams, "tools/call requires name and object arguments");
        const result = await this.mcp.callTool({ tool: params.name, input: params.arguments ?? {} }, this.session);
        if (this.mode === "spec") {
          // Spec wants tool outcomes as a content[] result; tool failures are
          // `isError` results, not JSON-RPC protocol errors.
          if (!result.success) {
            const message = result.error?.message ?? "tool error";
            return success(id, { content: [{ type: "text", text: message }], isError: true });
          }
          return success(id, { content: [{ type: "text", text: JSON.stringify(result.result ?? null) }] });
        }
        if (!result.success && result.error !== undefined) {
          return failure(id, mcpErrorToJsonRpc(result.error.code), result.error.message, result);
        }
        return success(id, result);
      }
      case "shutdown":
        this.close();
        return success(id, { ok: true });
      default:
        // Ignore any other client notifications rather than erroring.
        if (req.method.startsWith("notifications/")) return success(id, {});
        return failure(id, JSON_RPC_ERRORS.methodNotFound, `Method not found: ${req.method}`);
    }
  }
}

// Back-compat alias: the transport is wire-agnostic (driven by an injected
// writeLine), so the stdio entry + Phase 3 harness keep their import name.
export const StdioMcpTransport = JsonRpcTransport;
