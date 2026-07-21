// Proves createDockLayout renders the two D1 layout primitives correctly:
// splits emit .dock-split with two .dock-panes whose flex-basis tracks the
// ratio, and a .dock-divider whose pointer drag updates the ratio live,
// clamps to [0.15, 0.85], and persists only on pointerup; tabs emit
// .dock-tabs/.dock-tab(.active) with one .dock-pane-body per tab, hidden
// unless active, a hidden tab bar for single-tab groups, and lazy surface
// mounting (a hidden tab's mount fn is not called until first shown).
// Also proves setLayout re-renders and re-mounts freshly, state()/restore()
// round-trips with strict rejection (malformed → TypeError, unknown surface
// → Error), commits persist + fire onChange, and destroy() tears down DOM.
//
// Falsifiability: an implementation that persisted on every pointermove
// fails the saves.length assertions mid-drag; one that mounted every tab
// eagerly fails the lazy-mount counts; one that skipped ratio clamping
// fails the 0.15/0.85 bounds; one that re-created surfaces on tab switch
// fails the mount-count stability assertions; one that skipped validation
// fails the TypeError/Error discrimination checks.

import test from "node:test";
import assert from "node:assert/strict";

import { createDockLayout } from "../src/dock-layout.js";

// FakeElement copied from editor/test/keyed_render.test.mjs (same node-identity
// pattern), extended with the dock surface area: classList, style, hidden,
// event listeners with dispatch, pointer capture, and an injectable
// getBoundingClientRect. innerHTML remains deliberately absent.
class FakeElement {
  static detach(node) {
    if (!node.parentNode) return;
    const siblings = node.parentNode.childNodes;
    siblings.splice(siblings.indexOf(node), 1);
    node.parentNode = null;
  }

  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.parentNode = null;
    this.childNodes = [];
    this.textContent = "";
    this.ownerDocument = null;
    this.hidden = false;
    this.style = {};
    this.rect = { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 };
    this.capturedPointerId = null;
    this.listeners = new Map();
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
    };
  }

  get firstChild() {
    return this.childNodes.length > 0 ? this.childNodes[0] : null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    const at = siblings.indexOf(this);
    return at >= 0 && at + 1 < siblings.length ? siblings[at + 1] : null;
  }

  insertBefore(node, ref = null) {
    if (ref !== null && ref.parentNode !== this) throw new Error("NotFoundError: reference node is not a child");
    FakeElement.detach(node);
    this.childNodes.splice(ref === null ? this.childNodes.length : this.childNodes.indexOf(ref), 0, node);
    node.parentNode = this;
    return node;
  }

  appendChild(node) {
    FakeElement.detach(node);
    this.childNodes.push(node);
    node.parentNode = this;
    return node;
  }

  removeChild(node) {
    if (node.parentNode !== this) throw new Error("NotFoundError: node is not a child");
    FakeElement.detach(node);
    return node;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const fns = this.listeners.get(type) ?? [];
    const at = fns.indexOf(fn);
    if (at >= 0) fns.splice(at, 1);
  }

  dispatchEvent(event) {
    for (const fn of [...(this.listeners.get(event.type) ?? [])]) fn(event);
    return true;
  }

  setPointerCapture(pointerId) {
    this.capturedPointerId = pointerId;
  }

  releasePointerCapture(pointerId) {
    if (this.capturedPointerId === pointerId) this.capturedPointerId = null;
  }

  getBoundingClientRect() {
    return this.rect;
  }
}

class FakeDocument {
  createElement(tagName) {
    const el = new FakeElement(tagName);
    el.ownerDocument = this;
    return el;
  }
}

function makeMount() {
  const mount = new FakeElement("div");
  mount.ownerDocument = new FakeDocument();
  return mount;
}

function makeSurfaces(ids, counts = {}) {
  const surfaces = {};
  for (const id of ids) {
    surfaces[id] = {
      title: `Surface ${id}`,
      mount: (body, doc) => {
        counts[id] = (counts[id] ?? 0) + 1;
        assert.ok(body.classList.contains("dock-pane-body"), "mount receives the pane body element");
        assert.ok(doc && typeof doc.createElement === "function", "mount receives a document");
        body.textContent = `mounted:${id}`;
      },
    };
  }
  return surfaces;
}

const tabsOf = (...ids) => ({ kind: "tabs", tabs: ids, active: ids[0] });

function walk(el, fn) {
  fn(el);
  for (const child of [...el.childNodes]) if (child.nodeType === 1) walk(child, fn);
}

const findAll = (el, cls) => {
  const out = [];
  walk(el, (node) => { if (node.classList && node.classList.contains(cls)) out.push(node); });
  return out;
};
const find = (el, cls) => findAll(el, cls)[0] ?? null;

const pointer = (type, pointerId, extra = {}) => ({ type, pointerId, preventDefault() {}, ...extra });

test("split renders ratio-based flex-basis panes with a divider between", () => {
  const counts = {};
  const mount = makeMount();
  const dock = createDockLayout({
    mount,
    surfaces: makeSurfaces(["x", "y"], counts),
    layout: { kind: "split", dir: "horizontal", ratio: 0.25, a: tabsOf("x"), b: tabsOf("y") },
  });
  const root = mount.childNodes[0];
  assert.ok(root.classList.contains("dock-root"));
  const split = root.childNodes[0];
  assert.ok(split.classList.contains("dock-split"));
  assert.ok(split.classList.contains("horizontal"));
  assert.ok(!split.classList.contains("vertical"));
  const [paneA, divider, paneB] = split.childNodes;
  assert.ok(paneA.classList.contains("dock-pane"));
  assert.ok(paneB.classList.contains("dock-pane"));
  assert.ok(divider.classList.contains("dock-divider"));
  assert.equal(paneA.style.flexBasis, "25%");
  assert.equal(paneB.style.flexBasis, "75%");
  // Both panes are visible, so both surfaces mount eagerly at render.
  assert.equal(counts.x, 1);
  assert.equal(counts.y, 1);
  assert.equal(findAll(paneA, "dock-pane-body").length, 1);
  assert.equal(findAll(paneB, "dock-pane-body").length, 1);
  dock.destroy();
});

test("vertical splits carry the .vertical class and stack a over b", () => {
  const mount = makeMount();
  const dock = createDockLayout({
    mount,
    surfaces: makeSurfaces(["x", "y"]),
    layout: { kind: "split", dir: "vertical", ratio: 0.5, a: tabsOf("x"), b: tabsOf("y") },
  });
  const split = find(mount, "dock-split");
  assert.ok(split.classList.contains("vertical"));
  assert.ok(!split.classList.contains("horizontal"));
  dock.destroy();
});

test("out-of-range ratios are clamped at validation; non-numbers throw TypeError", () => {
  const surfaces = makeSurfaces(["x", "y"]);
  const low = createDockLayout({
    mount: makeMount(), surfaces,
    layout: { kind: "split", dir: "horizontal", ratio: 0.01, a: tabsOf("x"), b: tabsOf("y") },
  });
  assert.equal(low.state().ratio, 0.15);
  const high = createDockLayout({
    mount: makeMount(), surfaces,
    layout: { kind: "split", dir: "horizontal", ratio: 0.99, a: tabsOf("x"), b: tabsOf("y") },
  });
  assert.equal(high.state().ratio, 0.85);
  assert.throws(() => createDockLayout({
    mount: makeMount(), surfaces,
    layout: { kind: "split", dir: "horizontal", ratio: Number.NaN, a: tabsOf("x"), b: tabsOf("y") },
  }), TypeError);
  low.destroy();
  high.destroy();
});

test("divider drag updates ratio live, clamps, persists only on pointerup", () => {
  const saves = [];
  const changes = [];
  const mount = makeMount();
  const dock = createDockLayout({
    mount,
    surfaces: makeSurfaces(["x", "y"]),
    storage: { load: () => undefined, save: (key, value) => saves.push([key, value]) },
    storageKey: "test.dock/v1",
    onChange: (snapshot) => changes.push(snapshot),
    layout: { kind: "split", dir: "horizontal", ratio: 0.5, a: tabsOf("x"), b: tabsOf("y") },
  });
  assert.equal(saves.length, 0); // construction neither persists nor notifies
  assert.equal(changes.length, 0);
  const split = find(mount, "dock-split");
  split.rect = { left: 100, top: 0, right: 300, bottom: 50, width: 200, height: 50 };
  const divider = find(mount, "dock-divider");
  const [paneA] = split.childNodes;

  divider.dispatchEvent(pointer("pointerdown", 7));
  assert.equal(divider.capturedPointerId, 7);
  assert.ok(divider.classList.contains("dragging"));

  divider.dispatchEvent(pointer("pointermove", 7, { clientX: 150, clientY: 0 }));
  assert.equal(dock.state().ratio, 0.25); // (150-100)/200
  assert.equal(paneA.style.flexBasis, "25%");
  assert.equal(saves.length, 0, "live drag must not persist");
  assert.equal(changes.length, 0, "live drag must not notify");

  divider.dispatchEvent(pointer("pointermove", 7, { clientX: -500, clientY: 0 }));
  assert.equal(dock.state().ratio, 0.15, "drag clamps at the floor");
  assert.equal(paneA.style.flexBasis, "15%");

  divider.dispatchEvent(pointer("pointerup", 7));
  assert.equal(divider.capturedPointerId, null);
  assert.ok(!divider.classList.contains("dragging"));
  assert.equal(saves.length, 1);
  assert.equal(saves[0][0], "test.dock/v1");
  assert.deepEqual(saves[0][1], dock.state());
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], dock.state());

  divider.dispatchEvent(pointer("pointerdown", 8));
  divider.dispatchEvent(pointer("pointermove", 8, { clientX: 9999, clientY: 0 }));
  assert.equal(dock.state().ratio, 0.85, "drag clamps at the ceiling");
  divider.dispatchEvent(pointer("pointerup", 8));
  assert.equal(saves.length, 2);

  // Stray moves with no active drag or a foreign pointer id are ignored.
  divider.dispatchEvent(pointer("pointermove", 99, { clientX: 0, clientY: 0 }));
  assert.equal(dock.state().ratio, 0.85);
  dock.destroy();
});

test("vertical divider drag measures clientY against the split's height", () => {
  const mount = makeMount();
  const dock = createDockLayout({
    mount,
    surfaces: makeSurfaces(["x", "y"]),
    layout: { kind: "split", dir: "vertical", ratio: 0.5, a: tabsOf("x"), b: tabsOf("y") },
  });
  const split = find(mount, "dock-split");
  split.rect = { left: 0, top: 50, right: 100, bottom: 250, width: 100, height: 200 };
  const divider = find(mount, "dock-divider");
  divider.dispatchEvent(pointer("pointerdown", 1));
  divider.dispatchEvent(pointer("pointermove", 1, { clientX: 0, clientY: 100 }));
  assert.equal(dock.state().ratio, 0.25); // (100-50)/200
  divider.dispatchEvent(pointer("pointerup", 1));
  dock.destroy();
});

test("tabs render a tab per surface, track active, and switch via showTab or click", () => {
  const saves = [];
  const mount = makeMount();
  const dock = createDockLayout({
    mount,
    surfaces: makeSurfaces(["a", "b"]),
    storage: { load: () => undefined, save: (key, value) => saves.push(value) },
    layout: { kind: "tabs", tabs: ["a", "b"], active: "a" },
  });
  const tabBar = find(mount, "dock-tabs");
  assert.equal(tabBar.hidden, false);
  const tabs = findAll(mount, "dock-tab");
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].textContent, "Surface a");
  assert.equal(tabs[1].textContent, "Surface b");
  assert.ok(tabs[0].classList.contains("active"));
  assert.ok(!tabs[1].classList.contains("active"));
  const bodies = findAll(mount, "dock-pane-body");
  assert.equal(bodies[0].hidden, false);
  assert.equal(bodies[1].hidden, true);

  dock.showTab("b");
  assert.ok(!tabs[0].classList.contains("active"));
  assert.ok(tabs[1].classList.contains("active"));
  assert.equal(bodies[0].hidden, true);
  assert.equal(bodies[1].hidden, false);
  assert.equal(dock.state().active, "b");
  assert.equal(saves.length, 1, "tab switch persists");
  assert.deepEqual(saves[0], dock.state());

  tabs[0].dispatchEvent({ type: "click" });
  assert.equal(dock.state().active, "a");
  assert.ok(tabs[0].classList.contains("active"));
  assert.equal(saves.length, 2);

  assert.throws(() => dock.showTab("ghost"), { name: "Error" });
  assert.throws(() => dock.showTab(""), TypeError);
  dock.destroy();
});

test("a single-tab group hides its tab bar", () => {
  const mount = makeMount();
  const dock = createDockLayout({ mount, surfaces: makeSurfaces(["solo"]), layout: tabsOf("solo") });
  assert.equal(find(mount, "dock-tabs").hidden, true);
  assert.equal(findAll(mount, "dock-tab").length, 1);
  dock.destroy();
});

test("hidden tabs mount lazily on first show; setLayout re-mounts freshly", () => {
  const counts = {};
  const mount = makeMount();
  const dock = createDockLayout({
    mount,
    surfaces: makeSurfaces(["a", "b"], counts),
    layout: { kind: "tabs", tabs: ["a", "b"], active: "a" },
  });
  assert.equal(counts.a, 1);
  assert.equal(counts.b, undefined, "hidden tab's surface must not mount eagerly");

  dock.showTab("b");
  assert.equal(counts.b, 1, "first show mounts the surface once");
  dock.showTab("a");
  dock.showTab("b");
  assert.equal(counts.a, 1, "tab switches re-use the mounted pane");
  assert.equal(counts.b, 1);

  dock.setLayout({ kind: "tabs", tabs: ["a", "b"], active: "b" });
  assert.equal(counts.a, 1, "setLayout re-render does not mount the hidden tab");
  assert.equal(counts.b, 2, "setLayout re-render mounts the visible surface freshly");
  dock.destroy();
});

test("setLayout re-renders the tree, replacing the old DOM", () => {
  const counts = {};
  const mount = makeMount();
  const dock = createDockLayout({
    mount,
    surfaces: makeSurfaces(["a", "x", "y"], counts),
    layout: tabsOf("a"),
  });
  const oldPane = find(mount, "dock-pane");
  const next = { kind: "split", dir: "horizontal", ratio: 0.4, a: tabsOf("x"), b: tabsOf("y") };
  dock.setLayout(next);
  assert.equal(oldPane.parentNode, null, "old subtree is detached");
  assert.equal(findAll(mount, "dock-split").length, 1);
  assert.equal(counts.x, 1);
  assert.equal(counts.y, 1);
  assert.deepEqual(dock.state(), next);
  const [paneA, , paneB] = find(mount, "dock-split").childNodes;
  assert.equal(paneA.style.flexBasis, "40%");
  assert.equal(paneB.style.flexBasis, "60%");
  dock.destroy();
});

test("state/restore round-trips across instances; state() returns fresh copies", () => {
  const surfaces = makeSurfaces(["x", "y", "z"]);
  const mount = makeMount();
  const dock = createDockLayout({
    mount, surfaces,
    layout: { kind: "split", dir: "horizontal", ratio: 0.5, a: tabsOf("x", "z"), b: tabsOf("y") },
  });
  const split = find(mount, "dock-split");
  split.rect = { left: 0, top: 0, right: 400, bottom: 100, width: 400, height: 100 };
  const divider = find(mount, "dock-divider");
  divider.dispatchEvent(pointer("pointerdown", 1));
  divider.dispatchEvent(pointer("pointermove", 1, { clientX: 120, clientY: 0 }));
  divider.dispatchEvent(pointer("pointerup", 1));
  dock.showTab("z");

  const snapshot = dock.state();
  assert.equal(snapshot.ratio, 0.3);
  assert.equal(snapshot.a.active, "z");

  const other = createDockLayout({ mount: makeMount(), surfaces, layout: tabsOf("x") });
  other.restore(snapshot);
  assert.deepEqual(other.state(), snapshot);

  other.restore(other.state()); // identity
  assert.deepEqual(other.state(), snapshot);

  snapshot.ratio = 0.7; // mutating a snapshot must not leak into live state
  assert.equal(dock.state().ratio, 0.3);
  dock.destroy();
  other.destroy();
});

test("restore strictly rejects malformed shapes and unknown surfaces", () => {
  const mount = makeMount();
  const dock = createDockLayout({ mount, surfaces: makeSurfaces(["x", "y"]), layout: tabsOf("x") });
  const bad = [
    null,
    "split",
    { kind: "wat" },
    { kind: "split", dir: "diagonal", ratio: 0.5, a: tabsOf("x"), b: tabsOf("y") },
    { kind: "split", dir: "horizontal", ratio: "half", a: tabsOf("x"), b: tabsOf("y") },
    { kind: "split", dir: "horizontal", ratio: 0.5, a: tabsOf("x") },
    { kind: "split", dir: "horizontal", ratio: 0.5, a: tabsOf("x"), b: tabsOf("y"), extra: 1 },
    { kind: "tabs", tabs: [], active: "x" },
    { kind: "tabs", tabs: ["x"], active: "y" },
    { kind: "tabs", tabs: ["x", "x"], active: "x" },
    { kind: "split", dir: "horizontal", ratio: 0.5, a: tabsOf("x"), b: tabsOf("x") },
  ];
  for (const layout of bad) assert.throws(() => dock.restore(layout), TypeError, JSON.stringify(layout));
  assert.throws(() => dock.restore({ kind: "tabs", tabs: ["ghost"], active: "ghost" }), { name: "Error" });
  assert.throws(
    () => dock.restore({ kind: "tabs", tabs: ["ghost"], active: "ghost" }),
    (error) => error instanceof Error && !(error instanceof TypeError),
  );
  assert.deepEqual(dock.state(), tabsOf("x"), "rejected restores leave state untouched");
  dock.destroy();
});

test("persistence defaults: memory storage and default key; onChange per commit", () => {
  const changes = [];
  const dock = createDockLayout({
    mount: makeMount(),
    surfaces: makeSurfaces(["a", "b"]),
    onChange: (snapshot) => changes.push(snapshot),
    layout: { kind: "tabs", tabs: ["a", "b"], active: "a" },
  });
  dock.showTab("b"); // must not throw without injected storage
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], dock.state());

  const keys = [];
  const keyed = createDockLayout({
    mount: makeMount(),
    surfaces: makeSurfaces(["a"]),
    storage: { load: () => undefined, save: (key) => keys.push(key) },
    layout: tabsOf("a"),
  });
  keyed.setLayout(tabsOf("a"));
  assert.deepEqual(keys, ["limina.studio.dock-layout/v1"]);
  dock.destroy();
  keyed.destroy();
});

test("destroy removes the DOM subtree, is idempotent, and disarms the API", () => {
  const mount = makeMount();
  const dock = createDockLayout({
    mount,
    surfaces: makeSurfaces(["x", "y"]),
    layout: { kind: "split", dir: "horizontal", ratio: 0.5, a: tabsOf("x"), b: tabsOf("y") },
  });
  const root = mount.childNodes[0];
  const divider = find(mount, "dock-divider");
  dock.destroy();
  assert.equal(mount.childNodes.length, 0);
  assert.equal(root.parentNode, null);
  dock.destroy(); // idempotent
  assert.throws(() => dock.showTab("x"), /destroyed/);
  assert.throws(() => dock.setLayout(tabsOf("x")), /destroyed/);
  assert.throws(() => dock.restore(tabsOf("x")), /destroyed/);
  // A drag event racing destroy is inert.
  divider.dispatchEvent(pointer("pointerdown", 1));
  divider.dispatchEvent(pointer("pointermove", 1, { clientX: 0, clientY: 0 }));
  assert.equal(dock.state().ratio, 0.5);
});

test("option and layout contract violations throw before any render", () => {
  const surfaces = makeSurfaces(["x"]);
  assert.throws(() => createDockLayout(), TypeError);
  assert.throws(() => createDockLayout({}), TypeError);
  assert.throws(() => createDockLayout({ mount: {}, layout: tabsOf("x"), surfaces }), TypeError);
  assert.throws(() => createDockLayout({ mount: makeMount(), layout: tabsOf("x"), surfaces, bogus: 1 }), TypeError);
  assert.throws(() => createDockLayout({ mount: makeMount(), layout: tabsOf("ghost"), surfaces }), { name: "Error" });
  assert.throws(() => createDockLayout({
    mount: makeMount(), layout: tabsOf("x"), surfaces: { x: { title: "", mount: () => {} } },
  }), TypeError);
  assert.throws(() => createDockLayout({
    mount: makeMount(), layout: tabsOf("x"), surfaces: { x: { title: "X" } },
  }), TypeError);
  assert.throws(() => createDockLayout({
    mount: makeMount(), layout: tabsOf("x"), surfaces, storage: { load: () => undefined },
  }), TypeError);
  const mount = makeMount();
  assert.throws(() => createDockLayout({ mount, layout: tabsOf("x"), surfaces, onChange: 1 }), TypeError);
  assert.equal(mount.childNodes.length, 0, "failed construction renders nothing");
});
