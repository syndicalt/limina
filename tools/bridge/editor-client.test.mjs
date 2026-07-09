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
