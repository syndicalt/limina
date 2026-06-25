// MCP-style interface — a thin, discoverable wrapper over the SkillRegistry.
// The in-process API stays available, while the stdio transport enforces an
// initialize-bound external session so callers cannot spoof attribution.

import { JSON_RPC_ERRORS, mcpErrorToJsonRpc, type JsonRpcFailure, type JsonRpcId, type JsonRpcRequest, type JsonRpcResponse, type MCPRequest, type MCPResponse, type MCPTool } from "./protocol.ts";
import type { InvokeBase, SkillRegistry, WorldContext } from "../skills/registry.ts";
import { resolveProfile } from "../skills/permissions.ts";

export interface Session {
  agentId: string;
  sessionId: string;
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

  listTools(): MCPTool[] {
    return this.registry.list();
  }

  callTool(req: MCPRequest, session = this.session): Promise<MCPResponse> {
    if (session === undefined) {
      return Promise.resolve({ success: false, error: { code: "forbidden", message: "MCP session is not initialized" } });
    }
    const base: InvokeBase = {
      agentId: session.agentId,
      sessionId: session.sessionId,
      permissions: session.permissions,
      tick: this.tick,
      world: this.world,
    };
    return this.registry.invoke(req.tool, req.input, base);
  }

  /** Trusted in-process path for engine systems that already own attribution. */
  callToolInternal(req: MCPRequest, session = this.session): Promise<MCPResponse> {
    if (session === undefined) {
      return Promise.resolve({ success: false, error: { code: "forbidden", message: "MCP internal session is not initialized" } });
    }
    const internalSession: Session = {
      agentId: req.context?.agentId ?? session.agentId,
      sessionId: req.context?.sessionId ?? session.sessionId,
      permissions: session.permissions,
    };
    return this.registry.invoke(req.tool, req.input, {
      agentId: internalSession.agentId,
      sessionId: internalSession.sessionId,
      permissions: internalSession.permissions,
      tick: this.tick,
      world: this.world,
    });
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

export class JsonRpcTransport {
  private session?: Session;

  constructor(
    private readonly mcp: Mcp,
    private readonly writeLine: (line: string) => void | Promise<void>,
  ) {}

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
    for await (const line of lines) {
      await this.handleLine(line);
    }
  }

  private async write(response: JsonRpcResponse): Promise<void> {
    await this.writeLine(JSON.stringify(response));
  }

  private async dispatch(req: JsonRpcRequest, id: JsonRpcId): Promise<JsonRpcResponse> {
    switch (req.method) {
      case "initialize": {
        const params = parseInitializeParams(req.params);
        if (params === undefined) return failure(id, JSON_RPC_ERRORS.invalidParams, "initialize requires agentId, sessionId, and profile");
        this.session = {
          agentId: params.agentId,
          sessionId: params.sessionId,
          permissions: resolveProfile(params.profile),
        };
        return success(id, {
          protocolVersion: "2026-06-23",
          session: { agentId: params.agentId, sessionId: params.sessionId, profile: params.profile },
        });
      }
      case "tools/list":
      case "listTools":
        return success(id, { tools: this.mcp.listTools() });
      case "tools/call":
      case "callTool": {
        if (this.session === undefined) return failure(id, -32000, "MCP session is not initialized");
        const params = parseToolCallParams(req.params);
        if (params === undefined) return failure(id, JSON_RPC_ERRORS.invalidParams, "tools/call requires name and object arguments");
        const result = await this.mcp.callTool({ tool: params.name, input: params.arguments ?? {} }, this.session);
        if (!result.success && result.error !== undefined) {
          return failure(id, mcpErrorToJsonRpc(result.error.code), result.error.message, result);
        }
        return success(id, result);
      }
      case "shutdown":
        this.session = undefined;
        return success(id, { ok: true });
      default:
        return failure(id, JSON_RPC_ERRORS.methodNotFound, `Method not found: ${req.method}`);
    }
  }
}

// Back-compat alias: the transport is wire-agnostic (driven by an injected
// writeLine), so the stdio entry + Phase 3 harness keep their import name.
export const StdioMcpTransport = JsonRpcTransport;
