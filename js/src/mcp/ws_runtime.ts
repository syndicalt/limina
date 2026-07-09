// WebSocket MCP server entry for `limina --mcp-ws [--port N]`.
//
// The authoritative, MULTI-CLIENT server (Phase 4 M4/M5). JSON-RPC 2.0 over a
// localhost WebSocket -- the initialize handshake, tool-call semantics, and error
// codes match the stdio transport, EXTENDED with the read-only state-sync channel
// (state/subscribe -> snapshot + per-tick deltas, aoi/declare for area-of-interest).
//
// Phase 2 served one client at a time. Now the host hands every accepted
// connection to the AuthoritativeServer, which owns the fixed-step sim + the M1
// world log, applies intents at tick boundaries in one total order, and fans out
// authoritative deltas to each subscribed client (AoI-filtered). A client that
// only does initialize + tools/call still works exactly as before -- it simply
// never subscribes, so it receives no pushes.

import { AuthoritativeServer, hostTransport } from "../net/server.ts";
import type { NetOps } from "../net/protocol.ts";
import { PolicyEngine } from "../policy/engine.ts";
import { PERMISSION_PROFILES } from "../skills/permissions.ts";

declare const Deno: { core: { ops: NetOps } };
const net = Deno.core.ops;
const hostPort = net.op_net_host_port();
const authToken = net.op_net_host_auth_token();
if (authToken.length === 0) throw new Error("WebSocket host did not provide an authentication token");
const tracePrefix = hostPort === 8787 ? "mcp_ws" : `mcp_ws_${hostPort}`;

const server = new AuthoritativeServer(hostTransport(net), {
  sessionId: "mcp_ws",
  seed: 0x10ca1ed,
  tickMs: 8,
  policy: new PolicyEngine({ maxSessions: 64 }),
  initializeAuthToken: authToken,
  allowedProfiles: new Set(Object.keys(PERMISSION_PROFILES)),
  trace: { name: `${tracePrefix}_trace.jsonl`, maxInMemory: 8192 },
  worldLog: { name: `${tracePrefix}_worldlog.jsonl`, compactFlushed: true },
});
server.start();

// The accept + tick loops run in the background; the host pumps the event loop.
// This top-level await never resolves, so the server stays up like the Phase 2
// single-client accept loop did.
await new Promise<void>(() => {});
