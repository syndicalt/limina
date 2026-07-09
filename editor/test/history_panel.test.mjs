// Headless DOM test for the editor History panel binding (editor/src/history.js).
//
// The controller LOGIC is proven by js/test/p16_editor_controller.ts. This test proves the BROWSER
// BINDING is correct without a browser: under a minimal DOM stub it builds the panel, ingests
// world-log events onto the timeline and time-travels via the read-only scrub control. The only thing it cannot cover is literal
// pixel rendering, which is the in-browser step.
//
// Run: node editor/test/history_panel.test.mjs   (exit 0 = pass)

function assert(cond, msg) { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } }

// ── Minimal DOM stub: enough of document/element/window for history.js. ───────────────────────
function makeEl(tag) {
  return {
    tagName: tag, className: "", _text: "", children: [], style: {}, _handlers: {},
    value: "", type: "", title: "", selected: false, min: "", max: "", step: "",
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c, ref) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? 0 : i, 0, c); return c; },
    addEventListener(ev, fn) { this._handlers[ev] = fn; },
    dispatch(ev) { if (this._handlers[ev]) this._handlers[ev]({ target: this }); },
    get firstChild() { return this.children[0] || null; },
    get textContent() { return this._text; }, set textContent(v) { this._text = v; },
    get innerHTML() { return ""; }, set innerHTML(_v) { this.children = []; },
  };
}
const byId = { "history-body": makeEl("div") };
globalThis.document = { getElementById: (id) => byId[id] || null, createElement: (t) => makeEl(t) };
globalThis.window = {};

// Walk the rendered panel tree to find a control (e.g. the scrub range input, or a button by text).
function find(root, pred) {
  if (pred(root)) return root;
  for (const c of root.children || []) { const r = find(c, pred); if (r) return r; }
  return null;
}

const { createHistoryPanel } = await import("../src/history.js");

let lastScrubPrefixLen = -1;
// onScrub now receives a { commands, live } payload (not the bare command array) so the host can
// replay the viewport to the playhead AND know whether it's live-tracking.
const panel = createHistoryPanel({ onScrub: (payload) => { lastScrubPrefixLen = payload.commands.length; }, onLog: () => {} });
const ctrl = panel.controller();
const body = byId["history-body"];

// ── 1. Empty state renders the hint; no edits yet. ────────────────────────────────────────────
assert(ctrl.tip() === 0, "starts with an empty main branch");
assert(find(body, (e) => /no edits yet/.test(e._text || "")) !== null, "empty state hint rendered");

// ── 2. Ingesting world-log events grows the timeline on main. ─────────────────────────────────
panel.recordCommands([
  { seq: 1, tool: "scene.createEntity" }, { seq: 2, tool: "player.move" }, { seq: 3, tool: "scene.createEntity" },
  { seq: 4, tool: "world.generateRegion" }, { seq: 5, tool: "quest.accept" },
]);
assert(ctrl.tip() === 5, `timeline grew to 5 edits (got ${ctrl.tip()})`);
panel.recordCommands([{ seq: 3, tool: "dup" }, { seq: 6, tool: "ability.cast" }]); // seq 3 dup ignored
assert(ctrl.tip() === 6, `dedupes already-seen events; tip 6 (got ${ctrl.tip()})`);

// ── 3. The scrub control time-travels the playhead and emits the prefix. ──────────────────────
const scrub = find(body, (e) => e.tagName === "input" && e.type === "range");
assert(scrub !== null, "a timeline scrub control is rendered");
assert(scrub.max === "6", `scrub max tracks the tip (got ${scrub.max})`);
scrub.value = "2";
scrub.dispatch("input");
assert(!ctrl.isLive() && ctrl.playheadAt() === 2, `scrubbing to 2 time-travels the playhead (live=${ctrl.isLive()}, at=${ctrl.playheadAt()})`);
assert(lastScrubPrefixLen === 2, `onScrub emitted the 2-command prefix for viewport replay (got ${lastScrubPrefixLen})`);

// ── 4. The timeline is explicitly view-only; fake branch/merge controls are absent. ───────────
assert(find(body, (e) => e.tagName === "select") === null, "no branch or merge selector is rendered");
assert(find(body, (e) => /view only/.test(e._text || "")) !== null, "view-only status is rendered");

// ── 5. Ongoing world-log events preserve the user's scrubbed playhead. ────────────────────────
panel.recordCommands([{ seq: 7, tool: "scene.createEntity" }]);
assert(ctrl.tip() === 7, "the observed timeline keeps growing");
assert(!ctrl.isLive() && ctrl.playheadAt() === 2, "the scrubbed read-only view stays at edit 2");

console.log("history_panel.test OK: the editor History binding dedupes observed edits, exposes an explicit read-only scrub, " +
  "preserves a past playhead while live events arrive, and renders no fake branch/merge controls.");
