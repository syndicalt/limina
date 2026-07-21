import assert from "node:assert/strict";
import test from "node:test";
import {
  EditorBridgeClient,
  assertEditorUrl,
  assertLoopbackEditorUrl,
  editorClientConfigFromEnvironment,
} from "./editor-client.mjs";

function fakeWebSocketHarness(onRequest) {
  const sockets = [];
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = new Map();
      this.index = sockets.length;
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.emit("open", {}); });
    }
    addEventListener(name, callback) {
      let callbacks = this.listeners.get(name);
      if (!callbacks) { callbacks = new Set(); this.listeners.set(name, callbacks); }
      callbacks.add(callback);
    }
    emit(name, event) { for (const callback of this.listeners.get(name) ?? []) callback(event); }
    send(text) { onRequest(this, JSON.parse(text)); }
    respond(message) { queueMicrotask(() => this.emit("message", { data: JSON.stringify(message) })); }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      queueMicrotask(() => this.emit("close", {}));
    }
  }
  return { FakeWebSocket, sockets };
}

function config() {
  return {
    url: "ws://127.0.0.1:8787/",
    authToken: "x".repeat(32),
    timeoutMs: 100,
    agentId: "test-agent",
    sessionId: "test-session",
    profile: "builder.readWrite",
  };
}

function initialize(socket, request) {
  socket.respond({ jsonrpc: "2.0", id: request.id, result: { session: { profile: request.params.profile } } });
}

test("shared URL policy permits remote bridge wss while Atlas enforces loopback ws", () => {
  assert.equal(assertEditorUrl("wss://editor.example.test/project"), "wss://editor.example.test/project");
  assert.throws(() => assertEditorUrl("https://editor.example.test"), /ws:\/\/ or wss:\/\//);
  assert.equal(assertLoopbackEditorUrl("ws://localhost:8787/"), "ws://localhost:8787/");
  assert.throws(() => assertLoopbackEditorUrl("wss://localhost:8787/"), /loopback ws/);
  assert.throws(() => assertLoopbackEditorUrl("ws://editor.example.test/"), /loopback editor host/);
  assert.throws(() => editorClientConfigFromEnvironment({ LIMINA_EDITOR_TOKEN: "short" }), /32-128/);
});

test("explicit JSON-RPC application errors are never transport-retried", async () => {
  let toolCalls = 0;
  const harness = fakeWebSocketHarness((socket, request) => {
    if (request.method === "initialize") return initialize(socket, request);
    toolCalls++;
    socket.respond({ jsonrpc: "2.0", id: request.id, error: { code: -32009, message: "stale", data: { error: { code: "conflict" } } } });
  });
  const client = new EditorBridgeClient(config(), { getWebSocketConstructor: async () => harness.FakeWebSocket });
  await assert.rejects(client.rpc("tools/call", { name: "authoring.commit", arguments: {} }, { retryTransport: true }), (error) => error.code === -32009);
  assert.equal(toolCalls, 1);
  assert.equal(harness.sockets.length, 1);
  client.close();
});

test("ordinary calls are at-most-once after an ambiguous transport close", async () => {
  let toolCalls = 0;
  const harness = fakeWebSocketHarness((socket, request) => {
    if (request.method === "initialize") return initialize(socket, request);
    toolCalls++;
    socket.close();
  });
  const client = new EditorBridgeClient(config(), { getWebSocketConstructor: async () => harness.FakeWebSocket });
  await assert.rejects(client.rpc("tools/call", { name: "scene.create", arguments: {} }), /closed/);
  assert.equal(toolCalls, 1);
  assert.equal(harness.sockets.length, 1);
  client.close();
});

test("opt-in retry resends the exact method and params once", async () => {
  const calls = [];
  const harness = fakeWebSocketHarness((socket, request) => {
    if (request.method === "initialize") return initialize(socket, request);
    calls.push(structuredClone({ method: request.method, params: request.params }));
    if (socket.index === 0) socket.close();
    else socket.respond({ jsonrpc: "2.0", id: request.id, result: { success: true, result: { committed: true } } });
  });
  const client = new EditorBridgeClient(config(), { getWebSocketConstructor: async () => harness.FakeWebSocket });
  const transaction = { transactionId: "deterministic", nested: { value: 1 } };
  const result = await client.callTool("authoring.commit", { transaction }, { retryTransport: true });
  assert.deepEqual(result, { committed: true });
  assert.equal(harness.sockets.length, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
  assert.deepEqual(calls[0].params.arguments.transaction, transaction);
  client.close();
});

test("malformed JSON-RPC envelopes fail promptly and close the protocol", async () => {
  const cases = [
    (id) => ({ id, result: {} }),
    (id) => ({ jsonrpc: "2.0", id, result: {}, error: { code: 1, message: "both" } }),
    (id) => ({ jsonrpc: "2.0", id, error: { code: "wrong", message: 17 } }),
  ];
  for (const malformed of cases) {
    const harness = fakeWebSocketHarness((socket, request) => {
      if (request.method === "initialize") return initialize(socket, request);
      socket.respond(malformed(request.id));
    });
    const client = new EditorBridgeClient(config(), { getWebSocketConstructor: async () => harness.FakeWebSocket });
    await assert.rejects(client.rpc("tools/call", { name: "authoring.head", arguments: {} }), /JSON-RPC|exactly one|malformed/);
    client.close();
  }
});

// ── Capability-file auth (studio-unification P5): the launcher's private 0600
// handoff replaces pasted console tokens. These tests prove: strict schema/token
// validation, the 0600 privacy invariant (a world-readable capability is a leak,
// not a config), env-token precedence, and the capability fallback path. ────────

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultEditorCapabilityPath,
  readEditorCapability,
} from "./editor-client.mjs";

const VALID_TOKEN = "A".repeat(43);

function writeCapability(dir, { mode = 0o600, schema = "limina.editor-capability/v1", token = VALID_TOKEN, editorUrl = "ws://localhost:8787/" } = {}) {
  const path = join(dir, "editor-capability.json");
  writeFileSync(path, JSON.stringify({ schema, editorUrl, token }) + "\n", { mode });
  chmodSync(path, mode);
  return path;
}

test("readEditorCapability round-trips a valid private capability", () => {
  const dir = mkdtempSync(join(tmpdir(), "limina-cap-"));
  try {
    const path = writeCapability(dir);
    const cap = readEditorCapability(path);
    assert.equal(cap.token, VALID_TOKEN);
    assert.equal(cap.url, "ws://localhost:8787/");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readEditorCapability rejects a world-readable capability (leaked token, not config)", () => {
  const dir = mkdtempSync(join(tmpdir(), "limina-cap-"));
  try {
    const path = writeCapability(dir, { mode: 0o644 });
    assert.throws(() => readEditorCapability(path), /mode 0600/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readEditorCapability rejects bad schema, bad token, and missing files with clear errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "limina-cap-"));
  try {
    assert.throws(() => readEditorCapability(writeCapability(dir, { schema: "other/v9" })), /unrecognized schema/);
    assert.throws(() => readEditorCapability(writeCapability(dir, { token: "short" })), /invalid token/);
    assert.throws(() => readEditorCapability(join(dir, "nope.json")), /no editor capability/);
    assert.throws(() => readEditorCapability(""), /non-empty string/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("editorClientConfigFromEnvironment: env token wins; capability file is the fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "limina-cap-"));
  try {
    const path = writeCapability(dir, { token: VALID_TOKEN, editorUrl: "ws://localhost:9999/" });
    // Fallback: no env token → capability token + URL.
    const fromCap = editorClientConfigFromEnvironment({ LIMINA_EDITOR_CAPABILITY: path });
    assert.equal(fromCap.authToken, VALID_TOKEN);
    assert.equal(fromCap.url, "ws://localhost:9999/");
    // Env token wins over the file; an explicitly-malformed env token is rejected, never displaced.
    // (With an env token present the file is never read — no reason to touch it.)
    const envToken = "B".repeat(40);
    const fromEnv = editorClientConfigFromEnvironment({ LIMINA_EDITOR_TOKEN: envToken, LIMINA_EDITOR_CAPABILITY: path });
    assert.equal(fromEnv.authToken, envToken);
    assert.equal(fromEnv.url, "ws://127.0.0.1:8787/");
    assert.throws(
      () => editorClientConfigFromEnvironment({ LIMINA_EDITOR_TOKEN: "short", LIMINA_EDITOR_CAPABILITY: path }),
      /32-128/,
    );
    // LIMINA_EDITOR_URL beats the capability URL.
    const envUrl = editorClientConfigFromEnvironment({ LIMINA_EDITOR_CAPABILITY: path, LIMINA_EDITOR_URL: "ws://127.0.0.1:8787/" });
    assert.equal(envUrl.url, "ws://127.0.0.1:8787/");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultEditorCapabilityPath points at the project .limina runtime dir", () => {
  assert.equal(
    defaultEditorCapabilityPath("/proj"),
    join("/proj", ".limina", "editor-runtime", "editor-capability.json"),
  );
});
