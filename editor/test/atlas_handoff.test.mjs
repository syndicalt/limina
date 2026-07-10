import assert from "node:assert/strict";
import test from "node:test";

import {
  ATLAS_EDITOR_BRIDGE_SCHEMA,
  ATLAS_FOCUS_REQUEST,
  EDITOR_HANDOFF_READY,
  parseAtlasEditorBridgeMessage,
  parseEditorLaunchConfig,
} from "../src/atlas-editor-protocol.js";
import {
  ATLAS_HANDOFF_STORAGE_KEY,
  consumeAtlasEditorHandoff,
  createAtlasEditorHandoff,
  parseAtlasHandoffRelayConfig,
  parseAtlasEditorHandoff,
  storeAtlasEditorHandoff,
} from "../src/atlas-handoff.js";
import { installAtlasHandoffRelayGate } from "../src/atlas-handoff-relay.js";

const focus = () => ({
  schema: ATLAS_EDITOR_BRIDGE_SCHEMA,
  type: ATLAS_FOCUS_REQUEST,
  requestId: 7,
  source: { revision: 3, headHash: `sha256:${"a".repeat(64)}` },
  mapId: "primary",
  subject: { kind: "coordinate", id: "primary:1:2", label: "Atlas view" },
  world: [1, 2],
  radiusM: 64,
});

test("editor handoff ready and launch configuration are strict", () => {
  assert.deepEqual(parseAtlasEditorBridgeMessage({ schema: ATLAS_EDITOR_BRIDGE_SCHEMA, type: EDITOR_HANDOFF_READY }), {
    schema: ATLAS_EDITOR_BRIDGE_SCHEMA,
    type: EDITOR_HANDOFF_READY,
  });
  assert.deepEqual(parseEditorLaunchConfig({
    handoffUrl: "http://localhost:5180/atlas-handoff.html",
    editorOrigin: "http://localhost:5180",
    atlasOrigin: "http://127.0.0.1:4321",
  }), {
    handoffUrl: "http://localhost:5180/atlas-handoff.html",
    editorOrigin: "http://localhost:5180",
    atlasOrigin: "http://127.0.0.1:4321",
  });
  for (const input of [
    { handoffUrl: "http://evil.test/atlas-handoff.html", editorOrigin: "http://evil.test", atlasOrigin: "http://127.0.0.1:4321" },
    { handoffUrl: "http://localhost:5180/atlas-handoff.html?token=x", editorOrigin: "http://localhost:5180", atlasOrigin: "http://127.0.0.1:4321" },
    { handoffUrl: "http://localhost:5180/atlas-handoff.html", editorOrigin: "http://127.0.0.1:5180", atlasOrigin: "http://127.0.0.1:4321" },
    { handoffUrl: "http://localhost:5180/atlas-handoff.html", editorOrigin: "http://localhost:5180", atlasOrigin: "http://evil.test:4321" },
  ]) assert.throws(() => parseEditorLaunchConfig(input));
});

test("one-shot handoff validates lifetime, server, and focus", () => {
  const handoff = createAtlasEditorHandoff({ serverUrl: "ws://localhost:8790/", focus: focus(), now: 1_000 });
  assert.deepEqual(parseAtlasEditorHandoff(handoff, { now: 1_001 }), handoff);
  assert.throws(() => parseAtlasEditorHandoff(handoff, { now: 61_000 }), /expired/);
  assert.throws(() => createAtlasEditorHandoff({ serverUrl: "ws://evil.test:8790/", focus: focus(), now: 1_000 }));
  assert.throws(() => createAtlasEditorHandoff({ serverUrl: "ws://localhost:8790/?token=x", focus: focus(), now: 1_000 }));
  assert.throws(() => createAtlasEditorHandoff({
    serverUrl: "ws://localhost:8790/",
    focus: focus(),
    now: Number.MAX_SAFE_INTEGER,
  }));
});

test("relay configuration is exact, loopback-only, and immutable", () => {
  assert.deepEqual(parseAtlasHandoffRelayConfig({
    atlasOrigin: "http://127.0.0.1:4321",
    editorUrl: "http://localhost:5180/",
    editorServerUrl: "ws://localhost:8790/",
  }), {
    atlasOrigin: "http://127.0.0.1:4321",
    editorUrl: "http://localhost:5180/",
    editorServerUrl: "ws://localhost:8790/",
  });
  for (const input of [
    { atlasOrigin: "http://evil.test:4321", editorUrl: "http://localhost:5180/", editorServerUrl: "ws://localhost:8790/" },
    { atlasOrigin: "http://127.0.0.1:4321", editorUrl: "http://evil.test:5180/", editorServerUrl: "ws://localhost:8790/" },
    { atlasOrigin: "http://127.0.0.1:4321", editorUrl: "http://localhost:5180/", editorServerUrl: "ws://localhost:8790/", extra: true },
  ]) assert.throws(() => parseAtlasHandoffRelayConfig(input));
});

test("handoff storage contains no editor token and is bounded to session storage", () => {
  const values = new Map();
  const storage = { setItem: (key, value) => values.set(key, value) };
  const handoff = createAtlasEditorHandoff({ serverUrl: "ws://localhost:8790/", focus: focus(), now: 1_000 });
  storeAtlasEditorHandoff(storage, handoff, { now: 1_001 });
  const serialized = values.get(ATLAS_HANDOFF_STORAGE_KEY);
  assert.equal(typeof serialized, "string");
  assert.doesNotMatch(serialized, /token|274f5d1072386356b6c932761c1b6130/i);
  const hostile = { ...handoff };
  Object.defineProperty(hostile, "createdAt", { enumerable: true, get: () => { throw new Error("accessed"); } });
  assert.throws(() => storeAtlasEditorHandoff(storage, hostile, { now: 1_001 }), /data field/);
});

test("bootstrap removes a handoff before parsing so malformed payloads cannot replay", () => {
  const calls = [];
  const storage = {
    getItem: (key) => { calls.push(`get:${key}`); return "{"; },
    removeItem: (key) => calls.push(`remove:${key}`),
  };
  assert.equal(consumeAtlasEditorHandoff(storage, { now: 2_000 }), undefined);
  assert.deepEqual(calls, [`get:${ATLAS_HANDOFF_STORAGE_KEY}`, `remove:${ATLAS_HANDOFF_STORAGE_KEY}`]);
  assert.equal(consumeAtlasEditorHandoff(storage, { now: 2_000 }), undefined);
  assert.equal(calls.length, 2, "the destructive storage API must not read twice");
});

test("relay timeout is terminal and ignores a valid late focus", () => {
  const listeners = new Set();
  let messageListener;
  const eventTarget = {
    addEventListener: (type, listener) => { if (type === "message") { listeners.add(listener); messageListener = listener; } },
    removeEventListener: (type, listener) => { if (type === "message") listeners.delete(listener); },
  };
  let timeoutCallback;
  let focused = 0;
  let timedOut = 0;
  const opener = {};
  installAtlasHandoffRelayGate({
    eventTarget,
    opener,
    atlasOrigin: "http://127.0.0.1:4321",
    setTimer: (callback) => { timeoutCallback = callback; return 7; },
    clearTimer: () => {},
    onFocus: () => { focused++; },
    onTimeout: () => { timedOut++; },
  });
  assert.equal(listeners.size, 1);
  timeoutCallback();
  assert.equal(timedOut, 1);
  assert.equal(listeners.size, 0);
  messageListener({ source: opener, origin: "http://127.0.0.1:4321", data: focus() });
  assert.equal(focused, 0);
});
