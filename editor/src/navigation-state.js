export const NAVIGATION_STATE_SCHEMA = "limina.editor-navigation/v1";
export const NAVIGATION_STORAGE_PREFIX = "limina.editor.navigation/v1";
export const MAX_NAVIGATION_BOOKMARKS = 32;
export const MAX_NAVIGATION_RECENTS = 16;
export const MAX_NAVIGATION_STORAGE_BYTES = 64 * 1024;
export const MIN_NAVIGATION_SPEED_MPS = 0.25;
export const MAX_NAVIGATION_SPEED_MPS = 2048;
export const DEFAULT_NAVIGATION_SPEED_MPS = 64;
export const MAX_NAVIGATION_COORDINATE_M = 10_000_000;

const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BRANCH_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const ENTRY_ID = /^[a-z][a-z0-9._-]{0,63}$/;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const MODES = new Set(["orbit", "fly"]);
const RECENT_KINDS = new Set(["selection", "coordinate", "bookmark", "atlas", "world"]);

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function plainRecord(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function exactDataKeys(value, expected, label) {
  const names = Object.getOwnPropertyNames(value);
  const keys = new Set(expected);
  if (Object.getOwnPropertySymbols(value).length !== 0 || names.length !== keys.size || names.some((name) => !keys.has(name))) {
    throw new TypeError(`${label} fields are invalid`);
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new TypeError(`${label}.${name} must be an enumerable data field`);
    }
  }
}

function identifier(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function sequence(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

export function parseNavigationCoordinate(value, label = "navigation coordinate") {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  const coordinate = Object.is(value, -0) ? 0 : value;
  if (Math.abs(coordinate) > MAX_NAVIGATION_COORDINATE_M) {
    throw new RangeError(`${label} exceeds the navigation coordinate limit`);
  }
  return coordinate;
}

function denseFiniteTuple(value, length, label, { boundedCoordinates = false } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== length
      || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== length + 1) {
    throw new TypeError(`${label} must be a dense ${length}-element array`);
  }
  const output = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined
        || typeof descriptor.value !== "number" || !Number.isFinite(descriptor.value)) {
      throw new TypeError(`${label} must contain finite data values`);
    }
    const raw = Object.is(descriptor.value, -0) ? 0 : descriptor.value;
    output.push(boundedCoordinates ? parseNavigationCoordinate(raw, `${label}[${index}]`) : raw);
  }
  return output;
}

export function parseNavigationIdentity(input) {
  const identity = plainRecord(input, "navigation identity");
  exactDataKeys(identity, ["projectId", "branchId"], "navigation identity");
  return Object.freeze({
    projectId: identifier(identity.projectId, PROJECT_ID, "navigation projectId"),
    branchId: identifier(identity.branchId, BRANCH_ID, "navigation branchId"),
  });
}

export function navigationStorageKey(identityInput) {
  const identity = parseNavigationIdentity(identityInput);
  return `${NAVIGATION_STORAGE_PREFIX}:${identity.projectId}:${identity.branchId}`;
}

export function parseNavigationMode(value) {
  if (typeof value !== "string" || !MODES.has(value)) throw new TypeError("navigation mode must be orbit or fly");
  return value;
}

export function parseNavigationSpeed(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("navigation speed must be finite");
  return clamp(Object.is(value, -0) ? 0 : value, MIN_NAVIGATION_SPEED_MPS, MAX_NAVIGATION_SPEED_MPS);
}

export function parseNavigationPreferences(input) {
  const preferences = plainRecord(input, "navigation preferences");
  exactDataKeys(preferences, ["mode", "speedMps"], "navigation preferences");
  return Object.freeze({
    mode: parseNavigationMode(preferences.mode),
    speedMps: parseNavigationSpeed(preferences.speedMps),
  });
}

export function parseNavigationPose(input) {
  const pose = plainRecord(input, "navigation pose");
  exactDataKeys(pose, ["position", "quaternion", "target", "mode"], "navigation pose");
  const position = denseFiniteTuple(pose.position, 3, "navigation pose.position", { boundedCoordinates: true });
  const target = denseFiniteTuple(pose.target, 3, "navigation pose.target", { boundedCoordinates: true });
  const quaternion = denseFiniteTuple(pose.quaternion, 4, "navigation pose.quaternion");
  const quaternionLength = Math.hypot(...quaternion);
  if (!Number.isFinite(quaternionLength) || !(quaternionLength > 1e-12)) {
    throw new TypeError("navigation pose quaternion must have a finite non-zero length");
  }
  return Object.freeze({
    position: Object.freeze(position),
    quaternion: Object.freeze(quaternion.map((component) => component / quaternionLength)),
    target: Object.freeze(target),
    mode: parseNavigationMode(pose.mode),
  });
}

export function parseNavigationName(value, label = "navigation name") {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  if (CONTROL_CHAR.test(value)) throw new TypeError(`${label} must contain 1-64 printable characters`);
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 64) {
    throw new TypeError(`${label} must contain 1-64 printable characters`);
  }
  return name;
}

function parseEntryId(value, label) {
  return identifier(value, ENTRY_ID, label);
}

function parseBookmark(input, index) {
  const bookmark = plainRecord(input, `navigation bookmarks[${index}]`);
  exactDataKeys(bookmark, ["id", "name", "pose"], `navigation bookmarks[${index}]`);
  return Object.freeze({
    id: parseEntryId(bookmark.id, `navigation bookmarks[${index}].id`),
    name: parseNavigationName(bookmark.name, `navigation bookmarks[${index}].name`),
    pose: parseNavigationPose(bookmark.pose),
  });
}

function parseRecent(input, index) {
  const recent = plainRecord(input, `navigation recents[${index}]`);
  exactDataKeys(recent, ["id", "label", "kind", "pose"], `navigation recents[${index}]`);
  if (typeof recent.kind !== "string" || !RECENT_KINDS.has(recent.kind)) {
    throw new TypeError(`navigation recents[${index}].kind is invalid`);
  }
  return Object.freeze({
    id: parseEntryId(recent.id, `navigation recents[${index}].id`),
    label: parseNavigationName(recent.label, `navigation recents[${index}].label`),
    kind: recent.kind,
    pose: parseNavigationPose(recent.pose),
  });
}

function parseEntryList(value, maximum, parser, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
      || Object.getOwnPropertySymbols(value).length !== 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
    throw new TypeError(`${label} must be an array of at most ${maximum} entries`);
  }
  const output = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor?.enumerable !== true || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new TypeError(`${label}[${index}] must be an enumerable data field`);
    }
    output.push(parser(descriptor.value, index));
  }
  const ids = new Set();
  for (const entry of output) {
    if (ids.has(entry.id)) throw new TypeError(`${label} contains duplicate id '${entry.id}'`);
    ids.add(entry.id);
  }
  return Object.freeze(output);
}

export function createDefaultNavigationState(identityInput) {
  const identity = parseNavigationIdentity(identityInput);
  return Object.freeze({
    schema: NAVIGATION_STATE_SCHEMA,
    projectId: identity.projectId,
    branchId: identity.branchId,
    preferences: Object.freeze({ mode: "orbit", speedMps: DEFAULT_NAVIGATION_SPEED_MPS }),
    nextBookmarkSequence: 1,
    nextRecentSequence: 1,
    bookmarks: Object.freeze([]),
    recents: Object.freeze([]),
  });
}

export function parseNavigationState(input, expectedIdentityInput) {
  const state = plainRecord(input, "navigation state");
  exactDataKeys(state, [
    "schema", "projectId", "branchId", "preferences", "nextBookmarkSequence", "nextRecentSequence", "bookmarks", "recents",
  ], "navigation state");
  if (state.schema !== NAVIGATION_STATE_SCHEMA) throw new TypeError("navigation state schema is unsupported");
  const identity = parseNavigationIdentity({ projectId: state.projectId, branchId: state.branchId });
  if (expectedIdentityInput !== undefined) {
    const expected = parseNavigationIdentity(expectedIdentityInput);
    if (identity.projectId !== expected.projectId || identity.branchId !== expected.branchId) {
      throw new TypeError("navigation state belongs to another project or branch");
    }
  }
  return Object.freeze({
    schema: NAVIGATION_STATE_SCHEMA,
    projectId: identity.projectId,
    branchId: identity.branchId,
    preferences: parseNavigationPreferences(state.preferences),
    nextBookmarkSequence: sequence(state.nextBookmarkSequence, "navigation nextBookmarkSequence"),
    nextRecentSequence: sequence(state.nextRecentSequence, "navigation nextRecentSequence"),
    bookmarks: parseEntryList(state.bookmarks, MAX_NAVIGATION_BOOKMARKS, parseBookmark, "navigation bookmarks"),
    recents: parseEntryList(state.recents, MAX_NAVIGATION_RECENTS, parseRecent, "navigation recents"),
  });
}

export function readNavigationState(storage, identityInput) {
  const identity = parseNavigationIdentity(identityInput);
  const fallback = createDefaultNavigationState(identity);
  try {
    const raw = storage?.getItem?.(navigationStorageKey(identity));
    if (typeof raw !== "string" || raw.length === 0 || utf8ByteLength(raw) > MAX_NAVIGATION_STORAGE_BYTES) return fallback;
    return parseNavigationState(JSON.parse(raw), identity);
  } catch {
    return fallback;
  }
}

function utf8ByteLength(value) {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(value).byteLength;
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0);
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function serializeNavigationState(stateInput) {
  const state = parseNavigationState(stateInput);
  const serialized = JSON.stringify(state);
  if (utf8ByteLength(serialized) > MAX_NAVIGATION_STORAGE_BYTES) throw new RangeError("navigation state exceeds its storage limit");
  return serialized;
}

export function writeNavigationState(storage, stateInput) {
  try {
    const state = parseNavigationState(stateInput);
    storage?.setItem?.(navigationStorageKey({ projectId: state.projectId, branchId: state.branchId }), serializeNavigationState(state));
    return typeof storage?.setItem === "function";
  } catch {
    return false;
  }
}

function nextSequence(value) {
  return value === Number.MAX_SAFE_INTEGER ? 1 : value + 1;
}

function allocateEntryId(kind, state, idSource) {
  const field = kind === "bookmark" ? "nextBookmarkSequence" : "nextRecentSequence";
  const used = new Set([...state.bookmarks, ...state.recents].map((entry) => entry.id));
  let candidateSequence = state[field];
  for (let attempt = 0; attempt <= MAX_NAVIGATION_BOOKMARKS + MAX_NAVIGATION_RECENTS; attempt++) {
    const raw = idSource === undefined
      ? `${kind}-${candidateSequence}`
      : idSource(Object.freeze({ kind, sequence: candidateSequence, state }));
    const id = parseEntryId(raw, `${kind} id`);
    if (!used.has(id)) return { id, next: nextSequence(candidateSequence) };
    if (idSource !== undefined) throw new Error(`${kind} id '${id}' already exists`);
    candidateSequence = nextSequence(candidateSequence);
  }
  throw new Error(`no ${kind} id is available`);
}

function samePose(left, right) {
  return left.mode === right.mode
    && left.position.every((value, index) => value === right.position[index])
    && left.quaternion.every((value, index) => value === right.quaternion[index])
    && left.target.every((value, index) => value === right.target[index]);
}

export function createNavigationStateController({ storage, identity, idSource } = {}) {
  const scopedIdentity = parseNavigationIdentity(identity);
  if (idSource !== undefined && typeof idSource !== "function") throw new TypeError("navigation idSource must be a function");
  let state = readNavigationState(storage, scopedIdentity);
  const listeners = new Set();

  function emit(persisted) {
    const change = Object.freeze({ state, persisted });
    for (const listener of [...listeners]) {
      try { listener(change); }
      catch (error) {
        if (typeof globalThis.reportError === "function") globalThis.reportError(error);
        else globalThis.console?.error?.("navigation state listener failed", error);
      }
    }
  }

  function commit(next) {
    state = parseNavigationState(next, scopedIdentity);
    const persisted = writeNavigationState(storage, state);
    emit(persisted);
    return persisted;
  }

  function setPreferences(input) {
    const preferences = parseNavigationPreferences(input);
    commit({ ...state, preferences });
    return preferences;
  }

  return Object.freeze({
    snapshot: () => state,
    setPreferences,
    setMode(mode) {
      return setPreferences({ ...state.preferences, mode: parseNavigationMode(mode) });
    },
    setSpeed(speedMps) {
      return setPreferences({ ...state.preferences, speedMps: parseNavigationSpeed(speedMps) });
    },
    addBookmark(nameInput, poseInput) {
      if (state.bookmarks.length >= MAX_NAVIGATION_BOOKMARKS) throw new RangeError("navigation bookmark limit reached");
      const allocated = allocateEntryId("bookmark", state, idSource);
      const bookmark = Object.freeze({
        id: allocated.id,
        name: parseNavigationName(nameInput, "bookmark name"),
        pose: parseNavigationPose(poseInput),
      });
      commit({ ...state, nextBookmarkSequence: allocated.next, bookmarks: [...state.bookmarks, bookmark] });
      return bookmark;
    },
    removeBookmark(idInput) {
      const id = parseEntryId(idInput, "bookmark id");
      const bookmarks = state.bookmarks.filter((bookmark) => bookmark.id !== id);
      if (bookmarks.length === state.bookmarks.length) return false;
      commit({ ...state, bookmarks });
      return true;
    },
    addRecent({ label, kind, pose: poseInput } = {}) {
      if (typeof kind !== "string" || !RECENT_KINDS.has(kind)) throw new TypeError("recent kind is invalid");
      const pose = parseNavigationPose(poseInput);
      const normalizedLabel = parseNavigationName(label, "recent label");
      const allocated = allocateEntryId("recent", state, idSource);
      const recent = Object.freeze({ id: allocated.id, label: normalizedLabel, kind, pose });
      const deduplicated = state.recents.filter((entry) => entry.kind !== kind || entry.label !== normalizedLabel || !samePose(entry.pose, pose));
      commit({
        ...state,
        nextRecentSequence: allocated.next,
        recents: [recent, ...deduplicated].slice(0, MAX_NAVIGATION_RECENTS),
      });
      return recent;
    },
    clearRecents() {
      if (state.recents.length === 0) return false;
      commit({ ...state, recents: [] });
      return true;
    },
    subscribe(listener, { emitCurrent = false } = {}) {
      if (typeof listener !== "function") throw new TypeError("navigation state listener must be a function");
      listeners.add(listener);
      if (emitCurrent) listener(Object.freeze({ state, persisted: undefined }));
      return () => listeners.delete(listener);
    },
  });
}
