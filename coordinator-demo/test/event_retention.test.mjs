function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exit(1);
  }
}

function makeEl(tag) {
  return {
    tagName: tag,
    className: "",
    children: [],
    style: {},
    value: "",
    disabled: false,
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {},
    get innerHTML() { return ""; },
    set innerHTML(_v) { this.children = []; },
    get textContent() { return ""; },
    set textContent(_v) {},
  };
}

globalThis.document = {
  getElementById: (id) => makeEl(id === "interval" ? "input" : "div"),
  createElement: (tag) => makeEl(tag),
};
globalThis.window = { addEventListener() {} };

const { ingestTraceEvents } = await import("../src/app.js");

const retained = new Map();
ingestTraceEvents(retained, Array.from({ length: 7 }, (_, i) => ({ id: `e${i}`, type: "event" })), 5);

assert(retained.size === 5, `retained ${retained.size} events, expected 5`);
assert([...retained.keys()].join(",") === "e2,e3,e4,e5,e6", "retained window order is wrong: " + [...retained.keys()].join(","));

ingestTraceEvents(retained, [{ id: "e4", type: "updated" }, { id: "e7", type: "event" }], 5);

assert(retained.size === 5, "dedupe/update should not grow beyond retention cap");
assert([...retained.keys()].join(",") === "e3,e5,e6,e4,e7", "duplicate update should refresh insertion order inside the bounded window");

console.log("coordinator event_retention.test OK: trace accumulation keeps a bounded recent event window.");
