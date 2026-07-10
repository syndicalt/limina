import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as editorProtocol from "../src/atlas-editor-protocol.js";
import * as atlasProtocol from "../../tools/design/frontend/atlas-editor-protocol.js";

const modules = [editorProtocol, atlasProtocol];

function focus(overrides = {}) {
  return {
    schema: editorProtocol.ATLAS_EDITOR_BRIDGE_SCHEMA,
    type: editorProtocol.ATLAS_FOCUS_REQUEST,
    requestId: 7,
    source: { revision: 42, headHash: `sha256:${"a".repeat(64)}` },
    mapId: "primary",
    subject: { kind: "place", id: "northern-shore", label: "Northern shore" },
    world: [1200, -450],
    ...overrides,
  };
}

function reveal(overrides = {}) {
  return {
    schema: editorProtocol.ATLAS_EDITOR_BRIDGE_SCHEMA,
    type: editorProtocol.EDITOR_REVEAL_REQUEST,
    requestId: 8,
    world: [1200, -450],
    label: "Northern shore",
    ...overrides,
  };
}

function invalidForEveryModule(inputFactory, pattern = /invalid|must|requires|exceeds/) {
  for (const protocol of modules) {
    assert.throws(
      () => protocol.parseAtlasEditorBridgeMessage(inputFactory()),
      (error) => error instanceof TypeError
        && error.code === "INVALID_ATLAS_EDITOR_MESSAGE"
        && pattern.test(error.message),
    );
  }
}

test("editor and Atlas browser modules remain byte-identical", () => {
  const editorBytes = readFileSync(new URL("../src/atlas-editor-protocol.js", import.meta.url));
  const atlasBytes = readFileSync(new URL("../../tools/design/frontend/atlas-editor-protocol.js", import.meta.url));
  assert.deepEqual(atlasBytes, editorBytes);
  assert.deepEqual(Object.keys(atlasProtocol).sort(), Object.keys(editorProtocol).sort());
});

test("focus and reveal requests parse into deeply frozen normalized data", () => {
  for (const protocol of modules) {
    const hostileLabel = `</text><script>globalThis.pwned=true</script> \u202e`;
    const parsedFocus = protocol.parseAtlasEditorBridgeMessage(focus({
      world: [-0, -450],
      radiusM: 25,
      subject: { kind: "place", id: "northern-shore", label: hostileLabel },
    }));
    assert.deepEqual(parsedFocus, {
      schema: protocol.ATLAS_EDITOR_BRIDGE_SCHEMA,
      type: protocol.ATLAS_FOCUS_REQUEST,
      requestId: 7,
      source: { revision: 42, headHash: `sha256:${"a".repeat(64)}` },
      mapId: "primary",
      subject: { kind: "place", id: "northern-shore", label: hostileLabel },
      world: [0, -450],
      radiusM: 25,
    });
    assert.equal(Object.is(parsedFocus.world[0], -0), false);
    assert.equal(Object.isFrozen(parsedFocus), true);
    assert.equal(Object.isFrozen(parsedFocus.source), true);
    assert.equal(Object.isFrozen(parsedFocus.subject), true);
    assert.equal(Object.isFrozen(parsedFocus.world), true);

    const parsedReveal = protocol.parseEditorRevealRequest(reveal({ world: [1, -0] }));
    assert.deepEqual(parsedReveal.world, [1, 0]);
    assert.equal(Object.isFrozen(parsedReveal), true);
    assert.equal(Object.isFrozen(parsedReveal.world), true);
  }
});

test("schemas, types, exact keys, request ids, subjects, and strings fail closed", () => {
  invalidForEveryModule(() => focus({ schema: "limina.atlas-editor-bridge/v2" }), /schema/);
  invalidForEveryModule(() => focus({ type: "atlas.focus" }), /type/);
  invalidForEveryModule(() => ({ ...focus(), admin: true }), /fields/);
  invalidForEveryModule(() => {
    const value = focus();
    delete value.mapId;
    return value;
  }, /fields/);
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "7"]) {
    invalidForEveryModule(() => focus({ requestId: value }), /requestId/);
  }
  invalidForEveryModule(() => focus({ subject: { kind: "entity", id: "p", label: "P" } }), /kind/);
  invalidForEveryModule(() => focus({ source: { revision: -1, headHash: `sha256:${"a".repeat(64)}` } }), /source/);
  invalidForEveryModule(() => focus({ source: { revision: 42, headHash: "sha256:nope" } }), /source/);
  invalidForEveryModule(() => focus({ source: { revision: 42, headHash: `sha256:${"a".repeat(64)}`, extra: true } }), /fields/);
  invalidForEveryModule(() => focus({ subject: { kind: "place", id: "p", label: "P", extra: true } }), /fields/);
  invalidForEveryModule(() => {
    const subject = { kind: "place", id: "p", label: "P" };
    Object.setPrototypeOf(subject, { polluted: true });
    return focus({ subject });
  }, /plain object/);
  invalidForEveryModule(() => focus({ mapId: " \t" }), /printable/);
  invalidForEveryModule(() => focus({ mapId: "m".repeat(editorProtocol.MAX_BRIDGE_IDENTIFIER_CHARS + 1) }), /printable/);
  invalidForEveryModule(() => focus({ subject: { kind: "place", id: "p", label: `bad\u0000label` } }), /printable/);
  invalidForEveryModule(() => reveal({ label: "x".repeat(editorProtocol.MAX_BRIDGE_LABEL_CHARS + 1) }), /printable/);
  invalidForEveryModule(() => ({ ...reveal(), radiusM: 2 }), /fields/);
});

test("plain-object and data-descriptor rules reject accessors, symbols, and prototype pollution", () => {
  let getterInvoked = false;
  invalidForEveryModule(() => {
    const value = focus();
    Object.defineProperty(value, "schema", {
      enumerable: true,
      get() { getterInvoked = true; return editorProtocol.ATLAS_EDITOR_BRIDGE_SCHEMA; },
    });
    return value;
  }, /data field/);
  assert.equal(getterInvoked, false);

  getterInvoked = false;
  invalidForEveryModule(() => {
    const subject = { kind: "place", id: "p", label: "P" };
    Object.defineProperty(subject, "id", {
      enumerable: true,
      get() { getterInvoked = true; return "p"; },
    });
    return focus({ subject });
  }, /data field/);
  assert.equal(getterInvoked, false);

  invalidForEveryModule(() => Object.assign(Object.create(null), focus()), /plain object/);
  invalidForEveryModule(() => {
    const value = focus();
    Object.setPrototypeOf(value, { polluted: true });
    return value;
  }, /plain object/);
  invalidForEveryModule(() => JSON.parse(`${JSON.stringify(focus()).slice(0, -1)},"__proto__":{"polluted":true}}`), /fields/);
  invalidForEveryModule(() => {
    const value = focus();
    value[Symbol("hidden")] = true;
    return value;
  }, /fields/);
  invalidForEveryModule(() => {
    const value = focus();
    Object.defineProperty(value, "mapId", { value: "primary", enumerable: false });
    return value;
  }, /data field/);
  assert.equal(Object.prototype.polluted, undefined);
});

test("world tuples reject sparse, extended, accessor, subclassed, and non-finite arrays", () => {
  invalidForEveryModule(() => focus({ world: [1] }), /dense/);
  invalidForEveryModule(() => {
    const world = [1, 2];
    delete world[1];
    return focus({ world });
  }, /dense|data field/);
  invalidForEveryModule(() => {
    const world = [1, 2];
    world.extra = 3;
    return focus({ world });
  }, /dense/);
  invalidForEveryModule(() => {
    const world = [1, 2];
    world[Symbol("hidden")] = 3;
    return focus({ world });
  }, /dense/);
  invalidForEveryModule(() => {
    class WorldTuple extends Array {}
    return focus({ world: new WorldTuple(1, 2) });
  }, /dense/);

  let getterInvoked = false;
  invalidForEveryModule(() => {
    const world = [1, 2];
    Object.defineProperty(world, "1", {
      enumerable: true,
      get() { getterInvoked = true; return 2; },
    });
    return focus({ world });
  }, /data field/);
  assert.equal(getterInvoked, false);

  for (const coordinate of [NaN, Infinity, -Infinity, editorProtocol.MAX_BRIDGE_COORDINATE_M + 1]) {
    invalidForEveryModule(() => focus({ world: [coordinate, 0] }), /finite|range/);
  }
  for (const radiusM of [-0, -1, Infinity, editorProtocol.MAX_BRIDGE_RADIUS_M + 1]) {
    invalidForEveryModule(() => focus({ radiusM }), /positive|finite|range/);
  }
});

test("canonical Atlas local coordinates pass only for meter units at origin zero", () => {
  const canonical = { kind: "m", unitsPerMeter: 1, origin: [-0, 0] };
  for (const protocol of modules) {
    const world = protocol.atlasLocalToCanonicalWorld(canonical, [-0, -12]);
    assert.deepEqual(world, [0, -12]);
    assert.equal(Object.isFrozen(world), true);
    assert.equal(Object.is(world[0], -0), false);
  }

  for (const units of [
    { kind: "km", unitsPerMeter: 1, origin: [0, 0] },
    { kind: "m", unitsPerMeter: 2, origin: [0, 0] },
    { kind: "m", unitsPerMeter: 1, origin: [1, 0] },
    { kind: "m", unitsPerMeter: 1, origin: [0, 0], scale: 1 },
  ]) {
    for (const protocol of modules) {
      assert.throws(
        () => protocol.atlasLocalToCanonicalWorld(units, [1, 2]),
        (error) => error instanceof TypeError && error.code === "INVALID_ATLAS_EDITOR_MESSAGE",
      );
    }
  }

  let getterInvoked = false;
  for (const protocol of modules) {
    const units = { kind: "m", unitsPerMeter: 1, origin: [0, 0] };
    Object.defineProperty(units, "origin", {
      enumerable: true,
      get() { getterInvoked = true; return [0, 0]; },
    });
    assert.throws(() => protocol.atlasLocalToCanonicalWorld(units, [1, 2]), /data field/);
  }
  assert.equal(getterInvoked, false);
});

test("trusted event parsing requires exact source and exact origin before reading data", () => {
  for (const protocol of modules) {
    const source = {};
    const event = { source, origin: "http://localhost:5173", data: reveal() };
    assert.equal(protocol.isTrustedAtlasEditorMessageEvent(event, source, event.origin), true);
    assert.equal(protocol.isTrustedAtlasEditorMessageEvent(event, {}, event.origin), false);
    assert.equal(protocol.isTrustedAtlasEditorMessageEvent(event, source, "http://127.0.0.1:5173"), false);
    assert.deepEqual(protocol.parseTrustedAtlasEditorMessageEvent(event, source, event.origin), reveal());

    let dataRead = false;
    const untrusted = {
      source: {},
      origin: event.origin,
      get data() { dataRead = true; return reveal(); },
    };
    assert.throws(
      () => protocol.parseTrustedAtlasEditorMessageEvent(untrusted, source, event.origin),
      /source or origin is not trusted/,
    );
    assert.equal(dataRead, false);
  }
});
