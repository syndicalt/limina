import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = new URL("../../", import.meta.url);
const BRIDGE = new URL("./limina-bridge.mjs", import.meta.url);
const TOKEN = "stub-token";

function parseJsonLines(text) {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

async function listenOnLocalPort(server) {
  for (let port = 8700; port <= 8786; port++) {
    try {
      server.listen(port, "127.0.0.1");
      await once(server, "listening");
      return port;
    } catch (err) {
      if (err?.code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error("no local test port available in 8700-8786");
}

function encodeWebSocketText(text) {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  if (payload.length <= 0xffff) {
    const head = Buffer.allocUnsafe(4);
    head[0] = 0x81;
    head[1] = 126;
    head.writeUInt16BE(payload.length, 2);
    return Buffer.concat([head, payload]);
  }
  throw new Error("test payload too large");
}

function decodeWebSocketFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let header = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      throw new Error("test decoder does not support 64-bit WebSocket frames");
    }
    const maskLength = masked ? 4 : 0;
    const frameLength = header + maskLength + length;
    if (buffer.length - offset < frameLength) break;
    const payloadStart = offset + header + maskLength;
    const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + length));
    if (masked) {
      const mask = buffer.subarray(offset + header, offset + header + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    if (opcode === 0x1) messages.push(payload.toString("utf8"));
    offset += frameLength;
  }
  return { messages, rest: buffer.subarray(offset) };
}

function attachStubWebSocketServer(server, onMessage) {
  const sockets = new Set();
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    assert.equal(typeof key, "string");
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"));

    let buffer = Buffer.alloc(0);
    const ws = {
      send(data) {
        socket.write(encodeWebSocketText(data));
      },
      close() {
        socket.end();
      },
    };
    sockets.add(socket);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeWebSocketFrames(buffer);
      buffer = decoded.rest;
      for (const message of decoded.messages) onMessage(ws, message);
    });
    socket.on("close", () => sockets.delete(socket));
  });
  return {
    close() {
      for (const socket of sockets) socket.destroy();
    },
  };
}

async function withStubEditorHost(fn) {
  const server = createServer();
  const received = [];

  const wss = attachStubWebSocketServer(server, (ws, data) => {
    const msg = JSON.parse(String(data));
    received.push(msg);

    if (msg.method === "initialize") {
      assert.equal(msg.params.authToken, TOKEN);
      assert.equal(msg.params.profile, "builder.readWrite");
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2026-06-23",
          session: {
            agentId: msg.params.agentId,
            sessionId: msg.params.sessionId,
            profile: msg.params.profile,
          },
        },
      }));
      return;
    }

    if (msg.method === "tools/list") {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [{
            name: "scene.createEntity",
            description: "Create an entity",
            input_schema: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
            },
          }],
        },
      }));
      return;
    }

    if (msg.method === "tools/call") {
      assert.equal(msg.params.name, "scene.createEntity");
      assert.deepEqual(msg.params.arguments, { name: "Box" });
      setImmediate(() => {
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            success: true,
            result: { entity: "ent_x" },
          },
        }));
      });
    }
  });

  const port = await listenOnLocalPort(server);
  try {
    await fn({ url: `ws://127.0.0.1:${port}/`, received });
  } finally {
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  await withStubEditorHost(async ({ url, received }) => {
    const child = spawn(process.execPath, [BRIDGE.pathname], {
      cwd: ROOT.pathname,
      env: {
        ...process.env,
        LIMINA_EDITOR_URL: url,
        LIMINA_EDITOR_TOKEN: TOKEN,
        LIMINA_AGENT_ID: "test-agent",
        LIMINA_SESSION_ID: "test-session",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    function write(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "node-test" } } });
    write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    write({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    write({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "scene.createEntity", arguments: { name: "Box" } } });
    write({ jsonrpc: "2.0", id: 4, method: "shutdown", params: {} });

    const [code] = await once(child, "exit");
    assert.equal(code, 0, stderr);

    const messages = parseJsonLines(stdout);
    assert.equal(messages.length, 4, `stdout must contain only JSON-RPC lines, got:\n${stdout}`);

    assert.equal(messages[0].id, 1);
    assert.deepEqual(messages[0].result.capabilities, { tools: {} });
    assert.equal(messages[0].result.serverInfo.name, "limina-bridge");

    assert.equal(messages[1].id, 2);
    assert.deepEqual(messages[1].result.tools, [{
      name: "scene.createEntity",
      description: "Create an entity",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
      },
    }]);

    assert.equal(messages[2].id, 3);
    assert.deepEqual(messages[2].result, {
      content: [{ type: "text", text: JSON.stringify({ entity: "ent_x" }) }],
    });

    assert.equal(messages[3].id, 4);
    assert.deepEqual(messages[3].result, {});

    assert.equal(received[0].method, "initialize");
    assert.equal(received[1].method, "tools/list");
    assert.equal(received[2].method, "tools/call");

    await delay(10);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
