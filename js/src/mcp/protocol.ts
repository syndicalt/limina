// limina MCP-style wire contract — the shape external agents + the player's
// DecisionSystem serialize against. The in-process API and stdio JSON-RPC
// transport share these types so attribution and errors stay consistent.

export interface MCPTool {
  name: string;
  description: string;
  input_schema: unknown; // JSON Schema (draft-07) from z.toJSONSchema
  /** Optional category for tool grouping/browse (not part of MCP spec, but used
   *  internally for skills.browse and visual organization). */
  category?: string;
  /** Optional progressive-disclosure tier ("core" | "standard" | "advanced") used
   *  by the bootstrap surface + skills.browse (not part of the MCP spec). */
  priority?: string;
}

export interface MCPRequest {
  tool: string;
  input: Record<string, unknown>;
  context?: { agentId: string; sessionId: string; previousResults?: unknown[] };
}

export type MCPErrorCode =
  | "not_found"
  | "invalid_input"
  | "forbidden"
  | "pending_approval"
  | "handler_error"
  | "capacity_exceeded";

export interface MCPResponse {
  success: boolean;
  result?: unknown;
  error?: { code: MCPErrorCode; message: string };
  metadata?: { executionTimeMs: number; eventsEmitted: string[] };
}

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export function mcpErrorToJsonRpc(code: MCPErrorCode): number {
  switch (code) {
    case "not_found":
      return JSON_RPC_ERRORS.methodNotFound;
    case "invalid_input":
      return JSON_RPC_ERRORS.invalidParams;
    case "forbidden":
      return -32001;
    case "pending_approval":
      return -32003;
    case "capacity_exceeded":
      return -32002;
    case "handler_error":
      return JSON_RPC_ERRORS.internalError;
  }
}
