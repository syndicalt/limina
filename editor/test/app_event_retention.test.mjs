// Headless retention test for editor/src/app.js trace accumulation.
//
// The live editor polls trace.tail forever. The reasoning panel only needs a
// bounded recent window, while afterSeq preserves the durable cursor. This keeps
// a long-lived tab from retaining every event it has ever observed.

function assert(cond, msg) { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } }

function makeEl(tag) {
  return {
    tagName: tag, className: "", _text: "", children: [], style: {},
    value: tag === "input" ? "1000" : "", type: "", title: "", selected: false,
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {},
    get firstChild() { return this.children[0] || null; },
    get textContent() { return this._text; }, set textContent(v) { this._text = v; },
    get innerHTML() { return ""; }, set innerHTML(_v) { this.children = []; },
  };
}

const ids = [
  "connect", "disconnect", "propose", "interval", "log",
  "status-dot", "status-text", "history-body",
];
const byId = Object.fromEntries(ids.map((id) => [id, makeEl(id === "interval" ? "input" : "div")]));
globalThis.document = { getElementById: (id) => byId[id] || makeEl("div"), createElement: (tag) => makeEl(tag) };
globalThis.window = { prompt: () => "" };

const { ingestTraceEvents } = await import("../src/app.js");

const retained = new Map();
ingestTraceEvents(retained, Array.from({ length: 7 }, (_, i) => ({ id: `e${i}`, type: "event" })), 5);

assert(retained.size === 5, `retained ${retained.size} events, expected 5`);
assert(!retained.has("e0") && !retained.has("e1"), "oldest events were not evicted first");
assert([...retained.keys()].join(",") === "e2,e3,e4,e5,e6", "retained window order is wrong: " + [...retained.keys()].join(","));

ingestTraceEvents(retained, [{ id: "e4", type: "updated" }, { id: "e7", type: "event" }], 5);
assert(retained.size === 5, "dedupe/update should not grow beyond retention cap");
assert([...retained.keys()].join(",") === "e3,e5,e6,e4,e7", "duplicate update should refresh insertion order inside the bounded window");

console.log("app_event_retention.test OK: editor trace accumulation keeps a bounded recent event window with deterministic oldest-first eviction.");
