// Mirrored byte-for-byte in both browser roots; atlas_editor_protocol.test.mjs prevents drift.
export const ATLAS_EDITOR_BRIDGE_SCHEMA = "limina.atlas-editor-bridge/v1";
export const ATLAS_FOCUS_REQUEST = "atlas.focus-request";
export const EDITOR_REVEAL_REQUEST = "editor.reveal-request";
export const EDITOR_HANDOFF_READY = "editor.handoff-ready";
export const MAX_BRIDGE_COORDINATE_M = 10_000_000;
export const MAX_BRIDGE_RADIUS_M = 10_000_000;
export const MAX_BRIDGE_IDENTIFIER_CHARS = 128;
export const MAX_BRIDGE_LABEL_CHARS = 256;

const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
export const ATLAS_FOCUS_SUBJECT_KINDS = Object.freeze(["coordinate", "feature", "marker", "place", "stamp"]);

const SUBJECT_KINDS = new Set(ATLAS_FOCUS_SUBJECT_KINDS);
const HEAD_HASH = /^sha256:[0-9a-f]{64}$/;

function protocolError(message) {
  const error = new TypeError(message);
  error.code = "INVALID_ATLAS_EDITOR_MESSAGE";
  return error;
}

function plainRecord(input, label) {
  if (input === null || Array.isArray(input) || typeof input !== "object"
      || Object.getPrototypeOf(input) !== Object.prototype) {
    throw protocolError(`${label} must be a plain object`);
  }
  return input;
}

function dataFields(input, required, optional, label) {
  const record = plainRecord(input, label);
  const allowed = new Set([...required, ...optional]);
  const names = Object.getOwnPropertyNames(record);
  if (Object.getOwnPropertySymbols(record).length !== 0
      || names.some((name) => !allowed.has(name))
      || required.some((name) => !names.includes(name))) {
    throw protocolError(`${label} fields are invalid`);
  }
  const fields = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(record, name);
    if (descriptor?.enumerable !== true || !("value" in descriptor)) {
      throw protocolError(`${label}.${name} must be an enumerable data field`);
    }
    fields[name] = descriptor.value;
  }
  return fields;
}

function boundedString(value, maximum, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
      || value.trim().length < 1 || CONTROL_CHAR.test(value)) {
    throw protocolError(`${label} must contain 1-${maximum} printable characters`);
  }
  return value;
}

function requestId(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw protocolError("bridge requestId must be a positive safe integer");
  }
  return value;
}

function finiteBoundedNumber(value, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw protocolError(`${label} must be finite`);
  }
  const normalized = Object.is(value, -0) ? 0 : value;
  if (Math.abs(normalized) > maximum) {
    throw protocolError(`${label} exceeds the supported coordinate range`);
  }
  return normalized;
}

function denseWorldTuple(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 2
      || Object.getOwnPropertySymbols(value).length !== 0
      || Object.getOwnPropertyNames(value).length !== 3) {
    throw protocolError(`${label} must be a dense [x,z] array`);
  }
  const output = [];
  for (let index = 0; index < 2; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor?.enumerable !== true || !("value" in descriptor)) {
      throw protocolError(`${label}[${index}] must be an enumerable data field`);
    }
    output.push(finiteBoundedNumber(descriptor.value, MAX_BRIDGE_COORDINATE_M, `${label}[${index}]`));
  }
  return Object.freeze(output);
}

function parseSubject(input) {
  const fields = dataFields(input, ["kind", "id", "label"], [], "Atlas focus subject");
  if (typeof fields.kind !== "string" || !SUBJECT_KINDS.has(fields.kind)) {
    throw protocolError("Atlas focus subject.kind is invalid");
  }
  return Object.freeze({
    kind: fields.kind,
    id: boundedString(fields.id, MAX_BRIDGE_IDENTIFIER_CHARS, "Atlas focus subject.id"),
    label: boundedString(fields.label, MAX_BRIDGE_LABEL_CHARS, "Atlas focus subject.label"),
  });
}

function parseSource(input) {
  const fields = dataFields(input, ["revision", "headHash"], [], "Atlas focus source");
  if (!Number.isSafeInteger(fields.revision) || fields.revision < 0 || typeof fields.headHash !== "string"
      || !HEAD_HASH.test(fields.headHash)) {
    throw protocolError("Atlas focus source is invalid");
  }
  return Object.freeze({ revision: fields.revision, headHash: fields.headHash });
}

export function parseAtlasFocusRequest(input) {
  const fields = dataFields(
    input,
    ["schema", "type", "requestId", "source", "mapId", "subject", "world"],
    ["radiusM"],
    "Atlas focus request",
  );
  if (fields.schema !== ATLAS_EDITOR_BRIDGE_SCHEMA || fields.type !== ATLAS_FOCUS_REQUEST) {
    throw protocolError("Atlas focus request schema or type is invalid");
  }
  const output = {
    schema: ATLAS_EDITOR_BRIDGE_SCHEMA,
    type: ATLAS_FOCUS_REQUEST,
    requestId: requestId(fields.requestId),
    source: parseSource(fields.source),
    mapId: boundedString(fields.mapId, MAX_BRIDGE_IDENTIFIER_CHARS, "Atlas focus mapId"),
    subject: parseSubject(fields.subject),
    world: denseWorldTuple(fields.world, "Atlas focus world"),
  };
  if (Object.hasOwn(fields, "radiusM")) {
    const radiusM = finiteBoundedNumber(fields.radiusM, MAX_BRIDGE_RADIUS_M, "Atlas focus radiusM");
    if (!(radiusM > 0)) throw protocolError("Atlas focus radiusM must be positive");
    output.radiusM = radiusM;
  }
  return Object.freeze(output);
}

export function parseEditorRevealRequest(input) {
  const fields = dataFields(
    input,
    ["schema", "type", "requestId", "world", "label"],
    [],
    "editor reveal request",
  );
  if (fields.schema !== ATLAS_EDITOR_BRIDGE_SCHEMA || fields.type !== EDITOR_REVEAL_REQUEST) {
    throw protocolError("editor reveal request schema or type is invalid");
  }
  return Object.freeze({
    schema: ATLAS_EDITOR_BRIDGE_SCHEMA,
    type: EDITOR_REVEAL_REQUEST,
    requestId: requestId(fields.requestId),
    world: denseWorldTuple(fields.world, "editor reveal world"),
    label: boundedString(fields.label, MAX_BRIDGE_LABEL_CHARS, "editor reveal label"),
  });
}

export function parseEditorHandoffReady(input) {
  const fields = dataFields(input, ["schema", "type"], [], "editor handoff ready");
  if (fields.schema !== ATLAS_EDITOR_BRIDGE_SCHEMA || fields.type !== EDITOR_HANDOFF_READY) {
    throw protocolError("editor handoff ready schema or type is invalid");
  }
  return Object.freeze({ schema: ATLAS_EDITOR_BRIDGE_SCHEMA, type: EDITOR_HANDOFF_READY });
}

export function parseAtlasEditorBridgeMessage(input) {
  const fields = dataFields(input, ["schema", "type"], ["requestId", "source", "mapId", "subject", "world", "radiusM", "label"], "Atlas editor bridge message");
  if (fields.schema !== ATLAS_EDITOR_BRIDGE_SCHEMA) {
    throw protocolError("Atlas editor bridge message schema is invalid");
  }
  if (fields.type === ATLAS_FOCUS_REQUEST) return parseAtlasFocusRequest(input);
  if (fields.type === EDITOR_REVEAL_REQUEST) return parseEditorRevealRequest(input);
  if (fields.type === EDITOR_HANDOFF_READY) return parseEditorHandoffReady(input);
  throw protocolError("Atlas editor bridge message type is invalid");
}

export function parseEditorLaunchConfig(input) {
  const fields = dataFields(input, ["handoffUrl", "editorOrigin", "atlasOrigin"], [], "editor launch config");
  if (typeof fields.handoffUrl !== "string" || typeof fields.editorOrigin !== "string"
      || typeof fields.atlasOrigin !== "string") {
    throw protocolError("editor launch config URLs must be strings");
  }
  let handoff;
  let atlas;
  try { handoff = new URL(fields.handoffUrl); atlas = new URL(fields.atlasOrigin); }
  catch { throw protocolError("editor launch handoffUrl is invalid"); }
  if (handoff.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(handoff.hostname)
      || handoff.port === "" || handoff.pathname !== "/atlas-handoff.html" || handoff.search !== ""
      || handoff.hash !== "" || handoff.username !== "" || handoff.password !== ""
      || handoff.origin !== fields.editorOrigin) {
    throw protocolError("editor launch config must target an exact loopback handoff URL");
  }
  if (atlas.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(atlas.hostname)
      || atlas.port === "" || atlas.origin !== fields.atlasOrigin
      || atlas.username !== "" || atlas.password !== "") {
    throw protocolError("editor launch config must name an exact loopback Atlas origin");
  }
  return Object.freeze({ handoffUrl: handoff.href, editorOrigin: handoff.origin, atlasOrigin: atlas.origin });
}

export function atlasLocalToCanonicalWorld(unitsInput, local) {
  const units = dataFields(unitsInput, ["kind", "unitsPerMeter", "origin"], [], "Atlas map units");
  if (units.kind !== "m" || units.unitsPerMeter !== 1) {
    throw protocolError("Atlas editor bridge requires canonical meter units");
  }
  const origin = denseWorldTuple(units.origin, "Atlas map units.origin");
  if (origin[0] !== 0 || origin[1] !== 0) {
    throw protocolError("Atlas editor bridge requires origin [0,0]");
  }
  return denseWorldTuple(local, "Atlas local coordinate");
}

export function isTrustedAtlasEditorMessageEvent(event, expectedSource, expectedOrigin) {
  return event !== null && typeof event === "object"
    && expectedSource !== null && expectedSource !== undefined
    && typeof expectedOrigin === "string" && expectedOrigin.length > 0
    && event.source === expectedSource && event.origin === expectedOrigin;
}

export function parseTrustedAtlasEditorMessageEvent(event, expectedSource, expectedOrigin) {
  if (!isTrustedAtlasEditorMessageEvent(event, expectedSource, expectedOrigin)) {
    throw protocolError("Atlas editor message event source or origin is not trusted");
  }
  return parseAtlasEditorBridgeMessage(event.data);
}
