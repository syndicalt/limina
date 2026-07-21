// Atlas surface select/lasso/delete/stamp-picker behavior (Editor 2.0, D2).
// Mounts createAtlasSurface on a fake DOM and exercises the NEW seams end to
// end: pickAt tolerances, selectHit rail strip, deleteSelected's undoable
// removal + debounced CAS save, lasso bulk delete (one undo command per doc
// array), the rail undo button, the Delete/Escape keydown paths with the
// form-field guard, and the stamp picker re-arming place.stamp's assetId.
// Falsifiability: these assertions fail if picking tolerance breaks, if a
// delete forgets its undo command, if the picker doesn't re-arm the stamp
// asset, or if the form-field guard regresses.

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

// Browser globals the surface touches at construction time (module scope
// below runs before any test hook, so install these first, restore in after).
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.ImageData = class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } };

const { createAtlasSurface } = await import("../src/atlas/atlas-surface.js");

// ── Fake DOM (extends the tool_registry.test.mjs pattern) ─────────────────
// Extensions: canvas with a no-op 2D context, multi-listener events (the
// surface binds two keydown handlers on the document), select value
// auto-arming (first option wins, like a real <select>), remove(),
// getBoundingClientRect, and text nodes.
class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...cs) { for (const c of cs) this.set.add(c); }
  remove(...cs) { for (const c of cs) this.set.delete(c); }
  toggle(c, force) { const on = force === undefined ? !this.set.has(c) : force; on ? this.set.add(c) : this.set.delete(c); return on; }
  contains(c) { return this.set.has(c); }
}

// A 2D context double: any method is a no-op, any property set is swallowed.
function fakeCtx() {
  return new Proxy({}, {
    get: (target, prop) => (prop in target ? target[prop] : () => {}),
    set: (target, prop, value) => { target[prop] = value; return true; },
  });
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.listeners = new Map(); // name -> [fn] (surface binds two keydown handlers)
    this.classList = new FakeClassList();
    this.textContent = "";
    this.type = "";
    this.title = "";
    this.value = "";
    this.checked = false;
    this.min = "";
    this.max = "";
    this.step = "";
    this.hidden = false;
    this.id = "";
    if (tag === "canvas") {
      this.width = 300;
      this.height = 150;
      this._ctx = fakeCtx();
    }
  }
  get nodeType() { return 1; }
  get className() { return [...this.classList.set].join(" "); }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  getContext(kind) { return kind === "2d" ? this._ctx : null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    // <select> semantics: the first option arms the value.
    if (this.tagName === "SELECT" && child.tagName === "OPTION" && this.value === "") this.value = child.value;
    return child;
  }
  replaceChildren(...nodes) { this.children = []; for (const n of nodes) this.appendChild(n); }
  remove() {
    if (this.parentNode === null) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  addEventListener(name, fn) {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
  }
  removeEventListener(name, fn) {
    if (fn === undefined) this.listeners.delete(name);
    else this.listeners.set(name, (this.listeners.get(name) ?? []).filter((f) => f !== fn));
  }
  dispatch(name, event = {}) {
    event.target ??= this;
    event.preventDefault ??= () => {};
    for (const fn of this.listeners.get(name) ?? []) fn(event);
  }
  querySelectorAll(sel) {
    const cls = sel.startsWith(".") ? sel.slice(1) : null;
    const out = [];
    const walk = (el) => {
      for (const c of el.children ?? []) {
        if (cls && (c.className ?? "").split(/\s+/).includes(cls)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}

function makeFakeDocument() {
  const doc = new FakeElement("#document");
  doc.createElement = (tag) => new FakeElement(tag);
  doc.createTextNode = (text) => ({ nodeType: 3, textContent: text, parentNode: null });
  doc.defaultView = { devicePixelRatio: 1 };
  return doc;
}

function walk(root, pred) {
  if (pred(root)) return root;
  for (const c of root.children ?? []) {
    const hit = walk(c, pred);
    if (hit !== null) return hit;
  }
  return null;
}
const byId = (root, id) => walk(root, (el) => el.id === id);
const byClass = (root, cls) => walk(root, (el) => (el.className ?? "").split(/\s+/).includes(cls));

// ── Fixture: a pure-vector map (no rasters key — codec stays untouched) ────
const mapDoc = {
  id: "primary", name: "Select Test", scope: "site", parent: null,
  units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
  sea: true, seaLevel: 0,
  features: [
    { id: "ln-river", type: "line", kind: "river", points: [[-100, 0], [100, 0]], color: "#88a" },
    { id: "ln-road", type: "line", kind: "road", points: [[0, -100], [0, 100]] },
  ],
  stamps: [{ id: "st-1", assetId: "cottage", x: 40, z: 40, rot: 0, scale: 1 }],
  waterBodies: [{ id: "wb-1", kind: "lake", level: 0, footprint: { points: [[-60, -60], [-20, -60], [-20, -20], [-60, -20]] }, depthZones: [{ minShoreDistanceM: 0, maxShoreDistanceM: 50, depthM: 8 }] }],
};

// ── Shared harness: one surface for the whole file (load order matters) ────
const doc = makeFakeDocument();
const mount = doc.createElement("div");
const saves = []; // structuredClone'd snapshots — the payload aliases the live doc
const toasts = [];
let revCounter = 1;
const api = {
  async state() { return { mapsRev: "rev-1", maps: [structuredClone(mapDoc)] }; },
  async catalog() { return [{ id: "cottage", name: "Cottage" }, { id: "pine", name: "Pine" }]; },
  async mapSave(payload, mapId, mapsRev) {
    saves.push({ payload: structuredClone(payload), mapId, mapsRev });
    revCounter += 1;
    return { mapsRev: `rev-${revCounter}` };
  },
};
const storage = { load: () => undefined, save: () => {} };
const surface = createAtlasSurface({
  mount, api, codec: {}, document: doc, storage,
  onToast: (msg) => toasts.push(msg),
  events: { emit() {}, subscribe() {} },
});
const stampPicker = byId(mount, "atlas-stamp-asset");
const selectionEl = byId(mount, "atlas-selection");
const undoBtn = byId(mount, "atlas-undo");
const stage = byClass(mount, "atlas-stage");
const docNode = () => surface.model.doc;
const lastSave = () => saves[saves.length - 1].payload[0];

before(() => surface.load());
after(() => {
  surface.destroy();
  delete globalThis.ResizeObserver;
  delete globalThis.ImageData;
});

test("load: stamp picker armed from catalog, selection strip hidden", () => {
  assert.ok(stampPicker, "picker exists in the rail");
  assert.equal(stampPicker.children.length, 2, "one option per catalog asset");
  assert.equal(stampPicker.value, "cottage", "first option arms the value");
  assert.equal(stampPicker.children[0].textContent, "Cottage");
  assert.equal(selectionEl.hidden, true, "nothing selected at load");
  assert.equal(docNode().features.length, 2);
});

test("pickAt: stamp, line, water containment, miss", () => {
  const stamp = surface.pickAt(40, 40);
  assert.equal(stamp.kind, "stamp");
  assert.equal(stamp.id, "st-1");
  // (0,3) is exactly 3m from BOTH crossing lines and the tie goes to the
  // first-registered (river); (2,6) is unambiguously nearer the road.
  const road = surface.pickAt(2, 6);
  assert.equal(road.kind, "feature");
  assert.equal(road.id, "ln-road");
  const lake = surface.pickAt(-40, -40);
  assert.equal(lake.kind, "waterBody");
  assert.equal(lake.id, "wb-1");
  assert.equal(surface.pickAt(500, 500), null);
});

test("selectHit: rail strip unhidden, names the item, delete affordance", () => {
  surface.selectHit(surface.pickAt(40, 40));
  assert.equal(surface.selectedItem.id, "st-1");
  assert.equal(selectionEl.hidden, false);
  assert.ok(selectionEl.children[0].textContent.includes("st-1"));
  assert.equal(selectionEl.children[1].textContent, "🗑", "delete affordance present");
});

test("deleteSelected: undoable removal + debounced CAS save + strip reset", async () => {
  surface.selectHit(surface.pickAt(40, 40));
  surface.deleteSelected();
  assert.equal(docNode().stamps.length, 0, "stamp removed from the live doc");
  assert.equal(surface.selectedItem, null, "selection cleared");
  assert.equal(selectionEl.hidden, true, "strip re-hidden");
  assert.ok(toasts.includes("deleted 1 item"));
  await surface.flushSave();
  assert.equal(lastSave().stamps.length, 0);
  assert.equal(lastSave().features.length, 2, "other arrays untouched");
  assert.equal(lastSave().waterBodies.length, 1);
});

test("rail undo button restores the deleted stamp and saves it back", async () => {
  undoBtn.dispatch("click");
  assert.equal(docNode().stamps.length, 1, "cmdSetMapProp undo restores the prior array");
  assert.equal(docNode().stamps[0].id, "st-1");
  await surface.flushSave();
  assert.equal(lastSave().stamps.length, 1);
  assert.equal(lastSave().stamps[0].id, "st-1");
});

test("lassoDelete: bulk removal, one undo command per array", async () => {
  const count = surface.lassoDelete(-200, -200, 200, 200);
  assert.equal(count, 4, "2 features + 1 stamp + 1 water body");
  assert.equal(docNode().features.length, 0);
  assert.equal(docNode().stamps.length, 0);
  assert.equal(docNode().waterBodies.length, 0);
  assert.ok(toasts.includes("deleted 4 items"));
  await surface.flushSave();
  assert.equal(lastSave().features.length, 0);
  assert.equal(lastSave().stamps.length, 0);
  assert.equal(lastSave().waterBodies.length, 0);
  // Three commands were pushed (features, stamps, waterBodies) — LIFO undo.
  undoBtn.dispatch("click");
  assert.equal(docNode().waterBodies.length, 1, "first undo restores water bodies only");
  assert.equal(docNode().features.length, 0);
  undoBtn.dispatch("click");
  assert.equal(docNode().stamps.length, 1, "second undo restores stamps");
  undoBtn.dispatch("click");
  assert.equal(docNode().features.length, 2, "third undo restores features");
  await surface.flushSave();
  assert.equal(lastSave().features.length, 2);
});

test("keydown: Delete removes the selection, INPUT target is guarded, Escape clears", () => {
  const plain = doc.createElement("div");
  surface.selectHit(surface.pickAt(40, 40));
  doc.dispatch("keydown", { key: "Delete", target: plain });
  assert.equal(docNode().stamps.length, 0, "Delete key deletes the selection");
  assert.equal(surface.selectedItem, null);
  undoBtn.dispatch("click"); // restore for the guard half
  assert.equal(docNode().stamps.length, 1);
  surface.selectHit(surface.pickAt(40, 40));
  doc.dispatch("keydown", { key: "Delete", target: { tagName: "INPUT" } });
  assert.equal(docNode().stamps.length, 1, "form-field guard: typing Delete in an input must not delete");
  assert.equal(surface.selectedItem.id, "st-1", "selection retained");
  doc.dispatch("keydown", { key: "Escape", target: plain });
  assert.equal(surface.selectedItem, null, "Escape clears without deleting");
  assert.equal(docNode().stamps.length, 1);
  assert.equal(docNode().features.length, 2);
  assert.equal(docNode().waterBodies.length, 1);
});

test("stamp picker change re-arms place.stamp; stage click drops the new asset", async () => {
  stampPicker.value = "pine";
  stampPicker.dispatch("change");
  surface.controller.setActiveTool("place.stamp");
  const before = docNode().stamps.length;
  // clientX/Y = canvas center → world ≈ cam (0,0); assert the asset, not coords.
  stage.dispatch("pointerdown", { button: 0, clientX: 400, clientY: 300 });
  assert.equal(docNode().stamps.length, before + 1, "one anchor per click");
  const stamp = docNode().stamps[docNode().stamps.length - 1];
  assert.equal(stamp.assetId, "pine", "the picker re-armed the stamp asset");
  await surface.flushSave();
  assert.equal(lastSave().stamps.at(-1).assetId, "pine");
});

test("HiDPI: a center click maps to camera origin at devicePixelRatio 2", async () => {
  // Falsifiability for the CSS-px/device-px mixing bug: the canvas backing store is
  // device px (width = css * dpr) but pointer coords are CSS px. A center click must
  // land at the camera origin regardless of dpr. Before the fix, at dpr=2 the click
  // resolved to (400-800)/scale ≈ -222m off-origin.
  const doc2 = makeFakeDocument();
  doc2.defaultView.devicePixelRatio = 2;
  const mount2 = doc2.createElement("div");
  const saves2 = [];
  const api2 = {
    async state() { return { mapsRev: "rev-1", maps: [structuredClone(mapDoc)] }; },
    async catalog() { return [{ id: "cottage", name: "Cottage" }]; },
    async mapSave(payload, mapId, mapsRev) { saves2.push({ payload: structuredClone(payload), mapId, mapsRev }); return { mapsRev: "rev-2" }; },
  };
  const surface2 = createAtlasSurface({
    mount: mount2, api: api2, codec: {}, document: doc2, storage,
    onToast: () => {}, events: { emit() {}, subscribe() {} },
  });
  await surface2.load();
  const canvas2 = walk(mount2, (el) => el.tagName === "CANVAS");
  // resize() must have set the backing store to css(800) * dpr(2) = 1600.
  assert.equal(canvas2.width, 1600, "backing store is device px at dpr=2");
  surface2.controller.setActiveTool("place.stamp");
  const before = surface2.model.doc.stamps.length;
  const stage2 = byClass(mount2, "atlas-stage");
  stage2.dispatch("pointerdown", { button: 0, clientX: 400, clientY: 300 }); // CSS center
  assert.equal(surface2.model.doc.stamps.length, before + 1, "one anchor dropped");
  const dropped = surface2.model.doc.stamps.at(-1);
  assert.ok(Math.hypot(dropped.x, dropped.z) < 1e-6, `center click must map to camera origin, got (${dropped.x}, ${dropped.z})`);
  surface2.destroy();
});

test("destroy: listeners detached, no page errors", () => {
  surface.destroy();
  assert.equal(doc.listeners.get("keydown")?.length ?? 0, 0, "keydown detached");
  surface.destroy(); // idempotent
});
