// Studio event bus (fluid agents): every surface emits typed events here; a
// rolling buffer feeds the agent context pack, so the co-authoring agent sees
// what the human just did — workspace switches, tool changes, strokes, saves,
// selection — without polling. Ambient, typed, bounded.
//
// Events are plain data ({ type, at, ...fields }). The buffer is the ambient
// window; it is NOT an audit log (the engine trace is that).

const DEFAULT_CAPACITY = 50;

export function createStudioEventBus({ capacity = DEFAULT_CAPACITY, clock = () => Date.now() } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new TypeError("studio event bus capacity must be a positive integer");
  const buffer = [];
  const listeners = new Set();

  function emit(type, fields = {}) {
    if (typeof type !== "string" || !type.includes(".")) throw new TypeError("studio event type must be 'family.verb'");
    const event = Object.freeze({ type, at: clock(), ...fields });
    buffer.push(event);
    if (buffer.length > capacity) buffer.shift();
    for (const fn of listeners) fn(event);
    return event;
  }

  return Object.freeze({
    emit,
    /** The most recent n events, oldest first (the ambient window for packs). */
    recent(n = 10) {
      if (!Number.isSafeInteger(n) || n < 1) throw new TypeError("recent(n) needs a positive integer");
      return buffer.slice(-n).map((e) => ({ ...e }));
    },
    /** Events of one family (e.g. "atlas"), oldest first. */
    ofFamily(family, n = 10) {
      return buffer.filter((e) => e.type.startsWith(`${family}.`)).slice(-n).map((e) => ({ ...e }));
    },
    subscribe(fn) {
      if (typeof fn !== "function") throw new TypeError("studio event listener must be a function");
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get size() { return buffer.length; },
    clear() { buffer.length = 0; },
  });
}

// Canonical event types (string constants so a typo fails a grep, not a user).
export const STUDIO_EVENTS = Object.freeze({
  WORKSPACE_SWITCH: "studio.workspace",
  TOOL_CHANGE: "studio.tool",
  ATLAS_STROKE: "atlas.stroke",
  ATLAS_SAVE: "atlas.save",
  DOC_OPEN: "docs.open",
  DOC_SAVE: "docs.save",
  SELECTION_CHANGE: "world.selection",
  WORLD_EDIT: "world.edit",
  DERIVED_REVISION: "world.derived",
  AGENT_SUGGESTION: "agent.suggestion",
  /** Atlas → 3D reveal (2.0-D): double-click on the native atlas map travels
   *  the viewport camera to that world position. Fields: {x, z}. */
  ATLAS_FOCUS: "atlas.focus",
  /** 3D → Atlas reveal (2.0-D): selection/bookmark reveal pans the atlas map
   *  to a world position + pulse marker. Fields: {x, z, source}. */
  NAV_REVEAL: "nav.reveal",
  /** Places panel → camera reveal (2.0-D). Fields: {x, z, placeId}. */
  PLACES_REVEAL: "places.reveal",
});

/** The shared studio bus (app surfaces emit; the context packer + agent-surface
 *  highlights consume). Modules that only PUBLISH (chat renderers) use this. */
export const studioBus = createStudioEventBus();
