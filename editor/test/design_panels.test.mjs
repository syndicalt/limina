// Design panels (2.0-D): Places + Graph. Proves, against a fake DOM:
// - Places renders rows from api.state().places (name/kind/coords/radius),
//   row click emits "places.reveal" with the row's coords, rename commits
//   editPlace("update"), delete is two-click and commits editPlace("delete"),
//   add commits editPlace("add"), and a 409/conflict rejection refreshes from
//   the vault and surfaces the error line (CAS discipline — no silent clobber).
// - Graph renders nodes grouped by kind (with counts) + "a → b (type)" edges,
//   a node click emits "docs.open" ({ docId }), and empty states render.
//
// Falsifiability: the fake DOM implements only the keyed-render subset (no
// innerHTML), so an innerHTML rebuild throws instead of passing; the stub api
// records exact call payloads, so a wrong op name or payload fails the
// deepEqual assertions.

import assert from "node:assert/strict";
import test from "node:test";

import { createDesignPlacesPanel } from "../src/panels/design-places.js";
import { createDesignGraphPanel } from "../src/panels/design-graph.js";

// Minimal DOM double (pattern credited to editor/test/keyed_render.test.mjs and
// editor/test/tool_registry.test.mjs): nodeType, childNodes traversal,
// insertBefore/appendChild/removeChild for keyedList, classList/dataset/
// listeners for the panels. innerHTML is deliberately absent.
class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...cs) { for (const c of cs) this.set.add(c); }
  remove(...cs) { for (const c of cs) this.set.delete(c); }
  toggle(c, force) { const on = force === undefined ? !this.set.has(c) : force; on ? this.set.add(c) : this.set.delete(c); return on; }
  contains(c) { return this.set.has(c); }
}
class FakeElement {
  static detach(node) {
    if (!node.parentNode) return;
    const siblings = node.parentNode.childNodes;
    siblings.splice(siblings.indexOf(node), 1);
    node.parentNode = null;
  }

  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.parentNode = null;
    this.childNodes = [];
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.textContent = "";
    this.value = "";
    this.type = "";
    this.title = "";
    this.hidden = false;
  }

  get children() { return this.childNodes; }
  get className() { return [...this.classList.set].join(" "); }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get firstChild() { return this.childNodes.length > 0 ? this.childNodes[0] : null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    const at = siblings.indexOf(this);
    return at >= 0 && at + 1 < siblings.length ? siblings[at + 1] : null;
  }

  appendChild(node) { FakeElement.detach(node); this.childNodes.push(node); node.parentNode = this; return node; }
  insertBefore(node, ref) {
    if (ref === undefined) ref = null;
    if (ref !== null && ref.parentNode !== this) throw new Error("NotFoundError: reference node is not a child");
    FakeElement.detach(node);
    this.childNodes.splice(ref === null ? this.childNodes.length : this.childNodes.indexOf(ref), 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node) {
    if (node.parentNode !== this) throw new Error("NotFoundError: node is not a child");
    FakeElement.detach(node);
    return node;
  }
  replaceChildren(...nodes) { this.childNodes = []; for (const n of nodes) this.appendChild(n); }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  removeEventListener(name) { this.listeners.delete(name); }
  dispatch(name, event = {}) {
    event.target ??= this;
    event.preventDefault ??= () => {};
    this.listeners.get(name)?.(event);
  }
}
const doc = { createElement: (tag) => new FakeElement(tag) };

function byClass(root, cls) {
  const out = [];
  const walk = (el) => {
    for (const c of el.childNodes ?? []) {
      if (c.classList?.contains(cls)) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}
const one = (root, cls) => {
  const found = byClass(root, cls);
  assert.equal(found.length, 1, `expected exactly one .${cls}`);
  return found[0];
};
// Let queued microtasks (awaited stub calls + refresh) settle.
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function stubBus() {
  return { events: [], emit(type, payload) { this.events.push({ type, payload }); } };
}
function stubApi({ state, onEditPlace } = {}) {
  const calls = [];
  return {
    calls,
    state: async () => { calls.push({ m: "state" }); return typeof state === "function" ? state() : state; },
    editPlace: async (op, place) => {
      calls.push({ m: "editPlace", op, place });
      if (onEditPlace !== undefined) return onEditPlace(op, place);
      return { ok: true };
    },
  };
}

const PLACES = [
  { id: "town", name: "Town", kind: "settlement", position: [10, 20], radiusM: 50 },
  { id: "ruin", name: "Ruin", kind: "place", position: [-5, 3] },
];

function mountPlaces(apiOverrides = {}) {
  const api = stubApi({ state: { places: PLACES.map((p) => ({ ...p })) }, ...apiOverrides });
  const bus = stubBus();
  const host = new FakeElement("div");
  const panel = createDesignPlacesPanel({ document: doc, api, bus });
  panel.mount(host);
  return { api, bus, host, panel };
}

test("places: renders rows from api.state().places with name, kind, coords, radius", async () => {
  const { host, panel } = mountPlaces();
  await panel.refresh();
  const rows = byClass(host, "dp-row");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dataset.place, "town");
  assert.equal(one(rows[0], "dp-name").textContent, "Town");
  assert.equal(one(rows[0], "dp-meta").textContent, "settlement · (10, 20) · r 50m");
  assert.equal(one(rows[1], "dp-meta").textContent, "place · (-5, 3)");
  assert.equal(one(host, "dp-empty").hidden, true, "empty state stays hidden when rows exist");
});

test("places: row click emits places.reveal with the row's coords", async () => {
  const { host, bus, panel } = mountPlaces();
  await panel.refresh();
  one(byClass(host, "dp-row")[1], "dp-row-main").dispatch("click");
  assert.deepEqual(bus.events, [{ type: "places.reveal", payload: { x: -5, z: 3, placeId: "ruin" } }]);
});

test("places: rename commits editPlace('update', { id, name }) and refreshes", async () => {
  const { api, host, panel } = mountPlaces();
  await panel.refresh();
  const stateCallsBefore = api.calls.filter((c) => c.m === "state").length;
  const input = one(byClass(host, "dp-row")[0], "dp-rename");
  input.value = "New Town";
  input.dispatch("keydown", { key: "Enter" });
  await flush();
  assert.deepEqual(api.calls.find((c) => c.m === "editPlace"), { m: "editPlace", op: "update", place: { id: "town", name: "New Town" } });
  assert.ok(api.calls.filter((c) => c.m === "state").length > stateCallsBefore, "mutation re-fetches state");
});

test("places: delete is two-click and commits editPlace('delete', { id })", async () => {
  const { api, host, panel } = mountPlaces();
  await panel.refresh();
  const del = one(byClass(host, "dp-row")[0], "dp-del");
  del.dispatch("click");
  await flush();
  assert.equal(api.calls.some((c) => c.m === "editPlace"), false, "first click only arms");
  assert.equal(del.textContent, "Delete?");
  assert.equal(del.classList.contains("armed"), true);
  del.dispatch("click");
  await flush();
  assert.deepEqual(api.calls.find((c) => c.m === "editPlace"), { m: "editPlace", op: "delete", place: { id: "town" } });
});

test("places: 409/conflict refreshes from the vault and surfaces the error line", async () => {
  const api = stubApi({
    state: { places: PLACES.map((p) => ({ ...p })) },
    onEditPlace: () => { const e = new Error("conflict: places doc changed"); e.status = 409; throw e; },
  });
  const bus = stubBus();
  const host = new FakeElement("div");
  const panel = createDesignPlacesPanel({ document: doc, api, bus });
  panel.mount(host);
  await panel.refresh();
  const stateCallsBefore = api.calls.filter((c) => c.m === "state").length;
  const del = one(byClass(host, "dp-row")[0], "dp-del");
  del.dispatch("click");
  del.dispatch("click");
  await flush();
  const errorEl = one(host, "dp-error");
  assert.equal(errorEl.hidden, false, "error line is visible");
  assert.match(errorEl.textContent, /conflict/i);
  assert.ok(api.calls.filter((c) => c.m === "state").length > stateCallsBefore, "conflict path refreshes state");
});

test("places: add-place button commits editPlace('add', { name, position: [0, 0] })", async () => {
  const { api, host, panel } = mountPlaces();
  await panel.refresh();
  one(host, "dp-add").dispatch("click");
  await flush();
  assert.deepEqual(api.calls.find((c) => c.m === "editPlace"), { m: "editPlace", op: "add", place: { name: "New place", position: [0, 0] } });
});

test("places: empty state renders when the vault has no places", async () => {
  const api = stubApi({ state: { places: [] } });
  const host = new FakeElement("div");
  const panel = createDesignPlacesPanel({ document: doc, api, bus: stubBus() });
  panel.mount(host);
  await panel.refresh();
  assert.equal(byClass(host, "dp-row").length, 0);
  const empty = one(host, "dp-empty");
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent, /No places yet/);
});

const GRAPH = {
  nodes: [
    { id: "r1", label: "North", type: "region" },
    { id: "n1", label: "Ada", type: "npc" },
    { id: "r2", label: "South", type: "region" },
  ],
  edges: [{ from: "n1", to: "r1", label: "lives-in" }],
};

test("graph: renders nodes grouped by kind with counts, and edge rows", async () => {
  const api = stubApi({ state: { graph: GRAPH } });
  const host = new FakeElement("div");
  const panel = createDesignGraphPanel({ document: doc, api, bus: stubBus() });
  panel.mount(host);
  await panel.refresh();
  const groups = byClass(host, "dg-group");
  assert.equal(groups.length, 2);
  assert.equal(one(groups[0], "dg-group-head").textContent, "region (2)");
  assert.equal(one(groups[1], "dg-group-head").textContent, "npc (1)");
  assert.equal(byClass(groups[0], "dg-node").length, 2);
  assert.equal(byClass(groups[1], "dg-node").length, 1);
  const edges = byClass(host, "dg-edge");
  assert.equal(edges.length, 1);
  assert.equal(one(edges[0], "dg-edge-text").textContent, "n1 → r1 (lives-in)");
  assert.equal(one(host, "dg-empty-nodes").hidden, true);
  assert.equal(one(host, "dg-empty-edges").hidden, true);
});

test("graph: doc-node click emits docs.open with the node id", async () => {
  const api = stubApi({ state: { graph: GRAPH } });
  const bus = stubBus();
  const host = new FakeElement("div");
  const panel = createDesignGraphPanel({ document: doc, api, bus });
  panel.mount(host);
  await panel.refresh();
  const npcGroup = byClass(host, "dg-group")[1];
  byClass(npcGroup, "dg-node")[0].dispatch("click");
  assert.deepEqual(bus.events, [{ type: "docs.open", payload: { docId: "n1" } }]);
});

test("graph: empty states render for an empty graph", async () => {
  const api = stubApi({ state: { graph: { nodes: [], edges: [] } } });
  const host = new FakeElement("div");
  const panel = createDesignGraphPanel({ document: doc, api, bus: stubBus() });
  panel.mount(host);
  await panel.refresh();
  assert.equal(byClass(host, "dg-group").length, 0);
  assert.equal(byClass(host, "dg-edge").length, 0);
  assert.equal(one(host, "dg-empty-nodes").hidden, false);
  assert.equal(one(host, "dg-empty-edges").hidden, false);
});

test("graph: backend failure surfaces the error line, not a crash", async () => {
  const api = stubApi({
    state: () => { const e = new Error("sidecar down"); e.status = 404; throw e; },
  });
  const host = new FakeElement("div");
  const panel = createDesignGraphPanel({ document: doc, api, bus: stubBus() });
  panel.mount(host);
  await panel.refresh();
  const errorEl = one(host, "dg-error");
  assert.equal(errorEl.hidden, false);
  assert.match(errorEl.textContent, /sidecar down/);
});
