// Tool Contract registry (Editor 2.0, D2). Proves: strict descriptor/option
// validation, surface ordering, controller confinement + clamp/step coercion +
// persistence + strict restore, generated ribbon/options DOM (classes, active
// marking, live readouts, subscriber rebuilds), brush key bindings, and the
// one-ribbon-one-bar discipline. Falsifiability: a hand-assembled options bar
// (the old Atlas pattern) is what this replaces — schema-driven generation means
// a missing readout or wrong default fails these assertions, not a user's eyes.

import assert from "node:assert/strict";
import test from "node:test";

import {
  SURFACES,
  TOOL_GROUPS,
  bindBrushKeys,
  buildOptionsBar,
  buildToolRibbon,
  createToolController,
  createToolRegistry,
} from "../src/tools/tool-registry.js";

// Minimal DOM double (pattern credited to editor/test/keyed_render.test.mjs).
class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...cs) { for (const c of cs) this.set.add(c); }
  remove(...cs) { for (const c of cs) this.set.delete(c); }
  toggle(c, force) { const on = force === undefined ? !this.set.has(c) : force; on ? this.set.add(c) : this.set.delete(c); return on; }
  contains(c) { return this.set.has(c); }
}
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
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
  }
  get nodeType() { return 1; }
  get className() { return [...this.classList.set].join(" "); }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  replaceChildren(...nodes) { this.children = []; for (const n of nodes) this.appendChild(n); }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  removeEventListener(name) { this.listeners.delete(name); }
  dispatch(name, event = {}) {
    event.target ??= this;
    event.preventDefault ??= () => {};
    this.listeners.get(name)?.(event);
  }
  querySelectorAll(sel) {
    const cls = sel.startsWith(".") ? sel.slice(1) : null;
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (cls && (c.className ?? "").split(/\s+/).includes(cls)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}
const doc = { createElement: (tag) => new FakeElement(tag) };

function makeRegistry() {
  const registry = createToolRegistry();
  registry.register({
    id: "select.pick", group: "select", title: "Select", icon: "➤",
    surfaces: ["atlas", "viewport"], cursor: "default", gesture: "click",
    commit: () => {},
  });
  registry.register({
    id: "terrain.raise", group: "terrain", title: "Raise", icon: "⛰",
    surfaces: ["atlas", "viewport"], cursor: "brush", gesture: "stroke",
    options: {
      radius: { kind: "range", min: 2, max: 400, def: 40, step: 2, unit: "m" },
      strength: { kind: "range", min: 0.05, max: 1, def: 0.5, step: 0.05 },
      falloff: { kind: "enum", values: [{ id: "cos2", label: "Cos²" }, { id: "linear", label: "Linear" }], def: "cos2" },
      invert: { kind: "toggle", def: false, label: "Invert" },
      tint: { kind: "color", values: ["#fff", "#000"], def: "#fff" },
    },
    shortcuts: ["2"],
    commit: () => {},
  });
  registry.register({
    id: "water.basin", group: "water", title: "Basin", icon: "◯",
    surfaces: ["atlas"], cursor: "crosshair", gesture: "poly",
    commit: () => {},
  });
  return registry;
}

test("TOOL_GROUPS and SURFACES are frozen and ordered", () => {
  assert.deepEqual([...TOOL_GROUPS], ["select", "terrain", "paint", "water", "line", "place", "structure", "measure"]);
  assert.deepEqual([...SURFACES], ["atlas", "viewport"]);
  assert.throws(() => TOOL_GROUPS.push("x"), TypeError);
});

test("descriptor validation: strict shape, group, prefix, icon, surfaces, options", () => {
  const r = createToolRegistry();
  const base = {
    id: "select.pick", group: "select", title: "Select", icon: "➤",
    surfaces: ["atlas"], cursor: "default", gesture: "click", commit: () => {},
  };
  r.register(base);
  assert.throws(() => r.register(base), /duplicate/);
  assert.throws(() => r.register({ ...base, id: "water.pick" }), /prefix must equal/);
  assert.throws(() => r.register({ ...base, id: "x.y", group: "nope" }), /unknown tool group/);
  assert.throws(() => r.register({ ...base, id: "terrain.t", group: "terrain", icon: "ab" }), /single grapheme/);
  assert.throws(() => r.register({ ...base, id: "terrain.t", group: "terrain", surfaces: [] }), /non-empty subset/);
  assert.throws(() => r.register({ ...base, id: "terrain.t", group: "terrain", surfaces: ["moon"] }), /non-empty subset/);
  assert.throws(() => r.register({ ...base, id: "terrain.t", group: "terrain", cursor: "fancy" }), /cursor is invalid/);
  assert.throws(() => r.register({ ...base, id: "terrain.t", group: "terrain", bogus: 1 }), /does not allow key/);
  assert.throws(() => r.register({ ...base, id: "terrain.t", group: "terrain", commit: undefined }), /commit must be a function/);
  const withOpt = (options) => ({ ...base, id: "terrain.t", group: "terrain", options });
  assert.throws(() => r.register(withOpt({ radius: { kind: "range", min: 5, max: 2, def: 3 } })), /min < max/);
  assert.throws(() => r.register(withOpt({ radius: { kind: "range", min: 1, max: 5, def: 9 } })), /def outside/);
  assert.throws(() => r.register(withOpt({ mode: { kind: "enum", values: [], def: "a" } })), /non-empty/);
  assert.throws(() => r.register(withOpt({ mode: { kind: "enum", values: [{ id: "a", label: "A" }], def: "b" } })), /def must name/);
  assert.throws(() => r.register(withOpt({ on: { kind: "toggle", def: "yes", label: "On" } })), /toggle def must be boolean/);
  assert.throws(() => r.register(withOpt({ c: { kind: "color", values: ["#fff"], def: "#000" } })), /def must be one of values/);
  assert.throws(() => r.register(withOpt({ x: { kind: "mystery" } })), /kind must be one of/);
});

test("forSurface: group order then registration order; unknown surface throws", () => {
  const registry = makeRegistry();
  assert.deepEqual(registry.forSurface("atlas").map((t) => t.id), ["select.pick", "terrain.raise", "water.basin"]);
  assert.deepEqual(registry.forSurface("viewport").map((t) => t.id), ["select.pick", "terrain.raise"]);
  assert.throws(() => registry.forSurface("moon"), /unknown surface/);
});

test("controller: confinement, defaults, clamp+snap, enum/color/toggle coercion", () => {
  const c = createToolController({ registry: makeRegistry(), surface: "atlas" });
  assert.equal(c.activeId(), "select.pick", "first surface tool is the default");
  c.setActiveTool("terrain.raise");
  assert.equal(c.option("terrain.raise", "radius"), 40, "schema default");
  assert.equal(c.setOption("terrain.raise", "radius", 9999), 400, "clamped to max");
  assert.equal(c.setOption("terrain.raise", "radius", 41), 42, "snapped to step (round-half-up)");
  assert.equal(c.setOption("terrain.raise", "strength", 0.07), 0.05, "step snap down");
  c.setOption("terrain.raise", "falloff", "linear");
  assert.equal(c.option("terrain.raise", "falloff"), "linear");
  assert.throws(() => c.setOption("terrain.raise", "falloff", "swirly"), TypeError);
  c.setOption("terrain.raise", "invert", true);
  assert.equal(c.option("terrain.raise", "invert"), true);
  c.setOption("terrain.raise", "tint", "#000");
  assert.equal(c.option("terrain.raise", "tint"), "#000");
  assert.throws(() => c.setOption("terrain.raise", "nope", 1), /no option/);
  assert.throws(() => c.setActiveTool("missing.tool"), /unknown tool/);
  const vc = createToolController({ registry: makeRegistry(), surface: "viewport" });
  assert.throws(() => vc.setActiveTool("water.basin"), /not available on surface "viewport"/);
});

test("controller: persistence round-trip + strict restore", () => {
  const store = new Map();
  const storage = { load: (k) => store.get(k), save: (k, v) => store.set(k, v) };
  const a = createToolController({ registry: makeRegistry(), surface: "atlas", storage });
  a.setActiveTool("terrain.raise");
  a.setOption("terrain.raise", "radius", 88);
  const b = createToolController({ registry: makeRegistry(), surface: "atlas", storage });
  b.restore(storage.load("limina.studio.tool-options/v1"));
  assert.equal(b.activeId(), "terrain.raise");
  assert.equal(b.option("terrain.raise", "radius"), 88);
  assert.throws(() => b.restore({ activeId: "ghost.tool", values: {} }), /unknown tool/);
  assert.throws(() => b.restore({ activeId: null, values: { "terrain.raise": { radius: "big" } } }), TypeError);
  assert.throws(() => b.restore({ activeId: null, values: {}, extra: 1 }), /does not allow key/);
});

test("ribbon: generated groups, active marking follows controller, one-ribbon rule", () => {
  const controller = createToolController({ registry: makeRegistry(), surface: "atlas" });
  const ribbon = buildToolRibbon(controller, { document: doc });
  assert.equal(ribbon.className, "tool-ribbon");
  const buttons = ribbon.querySelectorAll(".tool-btn");
  assert.equal(buttons.length, 3);
  assert.equal(buttons[0].dataset.tool, "select.pick");
  assert.ok(buttons[0].classList.contains("active"));
  controller.setActiveTool("terrain.raise");
  assert.ok(buttons[1].classList.contains("active"), "subscriber marks active");
  assert.ok(!buttons[0].classList.contains("active"));
  buttons[2].dispatch("click");
  assert.equal(controller.activeId(), "water.basin", "click selects");
  assert.throws(() => buildToolRibbon(controller, { document: doc }), /already drives/);
});

test("options bar: generated controls write through, readouts live, rebuild on switch", () => {
  const controller = createToolController({ registry: makeRegistry(), surface: "atlas" });
  const bar = buildOptionsBar(controller, { document: doc });
  controller.setActiveTool("terrain.raise");
  const fields = bar.querySelectorAll(".opt-field");
  assert.equal(fields.length, 5, "one field per option");
  const slider = bar.querySelectorAll(".opt-slider")[0];
  const readout = bar.querySelectorAll(".opt-value")[0];
  assert.equal(readout.textContent, "40m");
  slider.value = "120";
  slider.dispatch("input");
  assert.equal(controller.option("terrain.raise", "radius"), 120);
  assert.equal(readout.textContent, "120m", "live readout");
  const segs = bar.querySelectorAll(".seg-btn");
  assert.equal(segs.length, 2);
  assert.ok(segs[0].classList.contains("active"));
  segs[1].dispatch("click");
  assert.equal(controller.option("terrain.raise", "falloff"), "linear");
  assert.ok(segs[1].classList.contains("active"));
  const swatches = bar.querySelectorAll(".opt-swatch");
  swatches[1].dispatch("click");
  assert.equal(controller.option("terrain.raise", "tint"), "#000");
  controller.setActiveTool("select.pick");
  assert.equal(bar.querySelectorAll(".opt-field").length, 0, "rebuilds for optionless tool");
  assert.throws(() => buildOptionsBar(controller, { document: doc }), /already drives/);
});

test("bindBrushKeys: radius adjust, digit select, form-field guard, cleanup", () => {
  const controller = createToolController({ registry: makeRegistry(), surface: "atlas" });
  controller.setActiveTool("terrain.raise");
  const target = doc.createElement("div");
  const off = bindBrushKeys(controller, { target });
  target.dispatch("keydown", { key: "]" });
  assert.equal(controller.option("terrain.raise", "radius"), 42);
  target.dispatch("keydown", { key: "[" });
  assert.equal(controller.option("terrain.raise", "radius"), 40);
  target.dispatch("keydown", { key: "2" });
  assert.equal(controller.activeId(), "terrain.raise", "digit selects by surface order");
  const input = doc.createElement("input");
  const before = controller.option("terrain.raise", "radius");
  target.listeners.get("keydown")({ key: "]", target: input });
  assert.equal(controller.option("terrain.raise", "radius"), before, "keys from form fields are ignored");
  off();
  target.dispatch("keydown", { key: "]" });
  assert.equal(controller.option("terrain.raise", "radius"), 40, "cleanup removes the binding");
});
