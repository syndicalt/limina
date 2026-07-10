import { parseAtlasFocusRequest } from "./atlas-editor-protocol.js";

export const ATLAS_HANDOFF_SCHEMA = "limina.atlas-editor-handoff/v1";
export const ATLAS_HANDOFF_STORAGE_KEY = "limina.atlas-editor-handoff/pending";
export const ATLAS_HANDOFF_TTL_MS = 60_000;

function handoffError(message) {
  const error = new TypeError(message);
  error.code = "INVALID_ATLAS_EDITOR_HANDOFF";
  return error;
}

function exactRecord(input, required, label) {
  if (input === null || Array.isArray(input) || typeof input !== "object"
      || Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length !== 0) {
    throw handoffError(`${label} must be a plain object`);
  }
  const names = Object.getOwnPropertyNames(input).sort();
  if (names.join(",") !== [...required].sort().join(",")) throw handoffError(`${label} fields are invalid`);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (descriptor?.enumerable !== true || !("value" in descriptor)) {
      throw handoffError(`${label}.${name} must be an enumerable data field`);
    }
  }
  return input;
}

function parseEditorServerUrl(input) {
  if (typeof input !== "string") throw handoffError("editor handoff serverUrl must be a string");
  let url;
  try { url = new URL(input); }
  catch { throw handoffError("editor handoff serverUrl is invalid"); }
  if (!['ws:', 'wss:'].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname)
      || url.port === "" || url.pathname !== "/" || url.search !== "" || url.hash !== ""
      || url.username !== "" || url.password !== "" || url.href !== input) {
    throw handoffError("editor handoff serverUrl must be an exact loopback WebSocket URL");
  }
  return url.href;
}

export function parseAtlasHandoffRelayConfig(input) {
  const record = exactRecord(input, ["atlasOrigin", "editorUrl", "editorServerUrl"], "editor handoff relay config");
  if (typeof record.atlasOrigin !== "string") throw handoffError("editor handoff relay Atlas origin must be a string");
  let atlas;
  try { atlas = new URL(record.atlasOrigin); }
  catch { throw handoffError("editor handoff relay Atlas origin is invalid"); }
  if (atlas.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(atlas.hostname)
      || atlas.port === "" || atlas.origin !== record.atlasOrigin || atlas.username !== "" || atlas.password !== "") {
    throw handoffError("editor handoff relay Atlas origin must be an exact loopback origin");
  }
  if (typeof record.editorUrl !== "string") throw handoffError("editor handoff relay editorUrl must be a string");
  let editor;
  try { editor = new URL(record.editorUrl); }
  catch { throw handoffError("editor handoff relay editorUrl is invalid"); }
  if (editor.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(editor.hostname)
      || editor.port === "" || editor.pathname !== "/" || editor.search !== "" || editor.hash !== ""
      || editor.username !== "" || editor.password !== "" || editor.href !== record.editorUrl) {
    throw handoffError("editor handoff relay editorUrl must be an exact loopback URL");
  }
  return Object.freeze({
    atlasOrigin: atlas.origin,
    editorUrl: editor.href,
    editorServerUrl: parseEditorServerUrl(record.editorServerUrl),
  });
}

export function createAtlasEditorHandoff({ serverUrl, focus, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - ATLAS_HANDOFF_TTL_MS) {
    throw handoffError("editor handoff time is invalid");
  }
  return Object.freeze({
    schema: ATLAS_HANDOFF_SCHEMA,
    createdAt: now,
    expiresAt: now + ATLAS_HANDOFF_TTL_MS,
    serverUrl: parseEditorServerUrl(serverUrl),
    focus: parseAtlasFocusRequest(focus),
  });
}

export function parseAtlasEditorHandoff(input, { now = Date.now() } = {}) {
  const record = exactRecord(input, ["schema", "createdAt", "expiresAt", "serverUrl", "focus"], "editor handoff");
  if (record.schema !== ATLAS_HANDOFF_SCHEMA || !Number.isSafeInteger(record.createdAt)
      || !Number.isSafeInteger(record.expiresAt) || record.createdAt < 0
      || record.expiresAt - record.createdAt !== ATLAS_HANDOFF_TTL_MS
      || !Number.isSafeInteger(now) || now < record.createdAt || now >= record.expiresAt) {
    throw handoffError("editor handoff lifetime is invalid or expired");
  }
  return Object.freeze({
    schema: ATLAS_HANDOFF_SCHEMA,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    serverUrl: parseEditorServerUrl(record.serverUrl),
    focus: parseAtlasFocusRequest(record.focus),
  });
}

export function storeAtlasEditorHandoff(storage, input, { now = Date.now() } = {}) {
  const handoff = parseAtlasEditorHandoff(input, { now });
  storage?.setItem?.(ATLAS_HANDOFF_STORAGE_KEY, JSON.stringify(handoff));
  return handoff;
}

let consumptionAttempted = false;
export function consumeAtlasEditorHandoff(storage = globalThis.sessionStorage, { now = Date.now() } = {}) {
  if (consumptionAttempted) return undefined;
  consumptionAttempted = true;
  let serialized;
  try {
    serialized = storage?.getItem?.(ATLAS_HANDOFF_STORAGE_KEY);
    storage?.removeItem?.(ATLAS_HANDOFF_STORAGE_KEY);
  } catch {
    return undefined;
  }
  if (typeof serialized !== "string") return undefined;
  try { return parseAtlasEditorHandoff(JSON.parse(serialized), { now }); }
  catch { return undefined; }
}
