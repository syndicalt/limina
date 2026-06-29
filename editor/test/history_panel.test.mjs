// Headless DOM test for the editor History panel binding (editor/src/history.js).
//
// The controller LOGIC is proven by js/test/p16_editor_controller.ts. This test proves the BROWSER
// BINDING is correct without a browser: under a minimal DOM stub it builds the panel, ingests
// world-log events onto the timeline, time-travels via the scrub control, and branches via the
// button — asserting the controller state the DOM drives. The only thing it cannot cover is literal
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
let promptAnswer = "wip-test";
globalThis.window = { prompt: () => promptAnswer };

// Walk the rendered panel tree to find a control (e.g. the scrub range input, or a button by text).
function find(root, pred) {
  if (pred(root)) return root;
  for (const c of root.children || []) { const r = find(c, pred); if (r) return r; }
  return null;
}

const { createHistoryPanel } = await import("../src/history.js");

let lastScrubPrefixLen = -1;
const panel = createHistoryPanel({ onScrub: (cmds) => { lastScrubPrefixLen = cmds.length; }, onLog: () => {} });
const ctrl = panel.controller();
const body = byId["history-body"];

// ── 1. Empty state renders the hint; no edits yet. ────────────────────────────────────────────
assert(ctrl.tip() === 0, "starts with an empty main branch");
assert(find(body, (e) => /no edits yet/.test(e._text || "")) !== null, "empty state hint rendered");

// ── 2. Ingesting world-log events grows the timeline on main. ─────────────────────────────────
panel.recordEvents([
  { id: "e1", type: "scene.createEntity" }, { id: "e2", type: "player.move" }, { id: "e3", type: "scene.createEntity" },
  { id: "e4", type: "world.generateRegion" }, { id: "e5", type: "quest.accept" },
]);
assert(ctrl.tip() === 5, `timeline grew to 5 edits (got ${ctrl.tip()})`);
panel.recordEvents([{ id: "e3", type: "dup" }, { id: "e6", type: "ability.cast" }]); // e3 dup ignored
assert(ctrl.tip() === 6, `dedupes already-seen events; tip 6 (got ${ctrl.tip()})`);

// ── 3. The scrub control time-travels the playhead and emits the prefix. ──────────────────────
const scrub = find(body, (e) => e.tagName === "input" && e.type === "range");
assert(scrub !== null, "a timeline scrub control is rendered");
assert(scrub.max === "6", `scrub max tracks the tip (got ${scrub.max})`);
scrub.value = "2";
scrub.dispatch("input");
assert(!ctrl.isLive() && ctrl.playheadAt() === 2, `scrubbing to 2 time-travels the playhead (live=${ctrl.isLive()}, at=${ctrl.playheadAt()})`);
assert(lastScrubPrefixLen === 2, `onScrub emitted the 2-command prefix for viewport replay (got ${lastScrubPrefixLen})`);

// ── 4. The "+ branch" button forks at the playhead. ──────────────────────────────────────────
promptAnswer = "experiment";
const branchBtn = find(body, (e) => e.tagName === "button" && /branch/.test(e._text || ""));
assert(branchBtn !== null, "a '+ branch' button is rendered");
branchBtn.dispatch("click");
assert(ctrl.branches().some((b) => b.name === "experiment"), "branch-from-here created 'experiment'");
assert(ctrl.currentBranch() === "experiment" && ctrl.tip() === 2, "checked out the new branch at the forked prefix (tip 2)");

// ── 5. Ongoing world-log events still land on MAIN, preserving the user's branch view. ────────
panel.recordEvents([{ id: "e7", type: "scene.createEntity" }]);
assert(ctrl.currentBranch() === "experiment", "the user stays on their branch while events ingest");
assert(ctrl.diff("main", "experiment").commonPrefix === 2, "main advanced (its tip grew) while 'experiment' held its fork point");

console.log("history_panel.test OK: the editor History binding builds the panel, ingests world-log events onto main, " +
  "dedupes, time-travels via the scrub control (emitting the viewport prefix), branches-from-here, and keeps ingesting onto " +
  "main while the user views a branch — all asserted under a headless DOM. Pixel rendering is the in-browser step.");
