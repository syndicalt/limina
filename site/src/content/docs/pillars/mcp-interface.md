---
title: "MCP Interface"
description: "The discoverable, typed tool-calling contract — in-process, stdio, and WebSocket."
---

Limina speaks **MCP**: a structured, discoverable tool-calling protocol optimized for LLM agents. The MCP layer is a thin wrapper over the [Skill Registry](/pillars/skill-registry) — `callTool` routes straight to `registry.invoke()`, so every MCP call gets the same resolve → validate → permission → handler → emit pipeline as an in-engine call. Tools *are* skills; there is no renaming layer.

An agent's workflow is always the same: **discover** the tools, then **call** them with full context and permission checks. This page is the wire contract; for a concrete walk-through see [Building agents → Builders](/building-agents/builders), and for the live agent roster see [Agents](/agents).

## listTools

`listTools()` returns the registered tools. Each is an `MCPTool`:

```ts
interface MCPTool {
  name: string;          // the skill name, e.g. "scene.createEntity"
  description: string;
  input_schema: unknown; // JSON Schema, draft-07
}
```

The `input_schema` is JSON Schema **draft-07**, produced from the skill's Zod input via `z.toJSONSchema(skill.input, { target: "draft-07", unrepresentable: "any" })`. Only the **input** schema is exposed as a tool schema — output schemas validate internally but are not part of the tool surface. The list is memoized and invalidated on register / unregister / replace.

## callTool

A call is an `MCPRequest`; the response is an `MCPResponse`:

```ts
interface MCPRequest {
  tool: string;
  input: Record<string, unknown>;
  context?: { agentId: string; sessionId: string; previousResults?: unknown[] };
}

interface MCPResponse {
  success: boolean;
  result?: unknown;                                 // present on success
  error?: { code: MCPErrorCode; message: string };  // present on failure
  metadata?: { executionTimeMs: number; eventsEmitted: string[] };
}
```

`callTool` requires an initialized session — `{ agentId, sessionId, permissions }`. Without one it returns `forbidden` ("MCP session is not initialized"). On success it builds the invocation base from the session and calls `registry.invoke(req.tool, req.input, base)`.

A trusted in-process variant, `callToolInternal`, lets engine systems that already own attribution override `context.agentId`/`sessionId` (permissions still come from the session) — this is how the player's DecisionSystem routes a player's actions through the same path as an external builder.

## Error codes

`MCPErrorCode = "not_found" | "invalid_input" | "forbidden" | "handler_error" | "capacity_exceeded"`.

| code | when |
|---|---|
| `not_found` | unknown skill name |
| `invalid_input` | Zod `safeParse` failure (`message` is the Zod error) |
| `forbidden` | permission / policy denial (`message` is the decision reason) |
| `handler_error` | the handler threw (`message` is the error) |
| `capacity_exceeded` | declared in the protocol; mapped to JSON-RPC `-32002` |

Over JSON-RPC these map via `mcpErrorToJsonRpc`: standard codes plus `not_found → -32601`, `invalid_input → -32602`, `forbidden → -32001`, `capacity_exceeded → -32002`, `handler_error → -32603`.

## Example

A `tools/list` then `tools/call` exchange over JSON-RPC 2.0:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }
```

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "scene.createEntity",
        "description": "Create a renderable entity (box or sphere) at a position, optionally with a dynamic physics body. Returns its entity id.",
        "input_schema": {
          "$schema": "http://json-schema.org/draft-07/schema#",
          "type": "object",
          "properties": {
            "shape": { "enum": ["box", "sphere"], "default": "box" },
            "size": { "type": "number", "exclusiveMinimum": 0, "maximum": 50, "default": 1 },
            "position": { "type": "array", "items": { "type": "number" } },
            "dynamic": { "type": "boolean", "default": false }
          }
        }
      }
    ]
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "scene.createEntity",
    "arguments": { "shape": "sphere", "color": 16747546, "position": [0, 0.5, 0], "dynamic": true }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "success": true,
    "result": { "entity": "ent_0001" },
    "metadata": { "executionTimeMs": 0.42, "eventsEmitted": ["skill.executed"] }
  }
}
```

On an `MCPResponse` failure, the transport returns a JSON-RPC **error** (via `mcpErrorToJsonRpc(code)`) with the full `MCPResponse` attached as `error.data`.

## Three transports

All three share identical JSON-RPC 2.0 semantics, the same `initialize` handshake, the same tool-call behavior, and the same error codes. Only the channel — and, for WebSocket, an extra read-only state-sync — differs.

| transport | entry | use |
|---|---|---|
| **in-process** | the `Mcp` class | engine systems and the player's DecisionSystem; no serialization |
| **stdio** | `limina --mcp-stdio` | a single external agent over newline-delimited JSON-RPC on stdin/stdout; exits on stdin EOF |
| **WebSocket** | `limina --mcp-ws [--port N]` | the authoritative, multi-client server over a localhost WebSocket |

### In-process

The `Mcp` class directly: `listTools` / `callTool` / `callToolInternal`. No serialization — used by engine systems and the in-world player loop.

### stdio

`limina --mcp-stdio` runs a newline-delimited JSON-RPC 2.0 server on stdin/stdout. JSON-RPC methods:

- `initialize` — params `{ agentId, sessionId, profile }`; binds the session with `permissions = resolveProfile(profile)`. Result: `{ protocolVersion, session }`.
- `tools/list` (alias `listTools`) — `{ tools: MCPTool[] }`.
- `tools/call` (alias `callTool`) — params `{ name, arguments?, context? }`; requires a bound session.
- `shutdown` — clears the session; `{ ok: true }`.

Notifications (no `id`) execute but produce no response; an unknown method returns `-32601`.

### WebSocket

`limina --mcp-ws [--port N]` is the authoritative multi-client server (Phase 4). It uses the same initialize handshake, tool-call semantics, and error codes as stdio, **extended** with a read-only state-sync channel:

- `state/subscribe` → an initial snapshot plus per-tick deltas.
- `aoi/declare` → declare an area-of-interest so a client only receives state for what it can "see".

This is how many builders and players share one authoritative world while every mutating action still goes through the permission-checked, traced skill pipeline. Authoritative multi-client sync runs at p95 11 ms.
