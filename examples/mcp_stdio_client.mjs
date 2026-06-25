#!/usr/bin/env node
// Tiny external MCP stdio client. It sends newline-delimited JSON-RPC requests
// to `limina --mcp-stdio` and prints the server's newline-delimited responses.

import { spawn } from "node:child_process";

const child = spawn("target/debug/limina", ["--mcp-stdio"], {
  cwd: new URL("..", import.meta.url),
  stdio: ["pipe", "pipe", "inherit"],
});

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => process.stdout.write(chunk));

const requests = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { agentId: "agt_external", sessionId: "ses_external", profile: "builder.readWrite" } },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "scene.queryEntities", arguments: {} } },
  { jsonrpc: "2.0", id: 4, method: "shutdown", params: {} },
];

for (const request of requests) child.stdin.write(JSON.stringify(request) + "\n");
child.stdin.end();
