// Viewport tool surface (Editor 2.0, 2.0-C slices 1+gizmo). Proves: the four
// viewport tool descriptors (ids, groups, surfaces, option schemas — incl.
// select.pick's gizmo/space/snap), the brushTool→tool mapping, mount of the
// generated ribbon + options bar, mode/brush forwarding discipline (only the
// ACTIVE tool's option edits reach the shared brush state; sculpt and paint
// keep separate radius/strength/falloff), the raw onToolOption stream (every
// tool, coerced values, before onBrushChange), storage persistence + boot
// restore under the viewport-only key, and isolation from the Atlas surface's
// default key. Falsifiability: these fail if a tool id/group drifts, if
// inactive-tool option edits leak into the shared brush state, or if the two
// surfaces' persisted snapshots ever share a key.

import assert from "node:assert/strict";
import test from "node:test";

import { createToolController, createToolRegistry } from "../src/tools/tool-registry.js";
import {
  MODE_BY_TOOL,
  VIEWPORT_PAINT_MATERIALS,
  VIEWPORT_SCULPT_MODES,
  VIEWPORT_STORAGE_KEY,
  createViewportTooling,
  toolForBrushTool,
  viewportToolRegistry,
} from "../src/tools/viewport-tools.js";

const ATLAS_STORAGE_KEY = "limina.studio.tool-options/v1";

// Minimal DOM double (pattern credited to editor/test/tool_registry.test.mjs).
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
  remove() {
    if (this.parentNode === null) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
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

function mapStorage(store = new Map()) {
  return { store, storage: { load: (k) => store.get(k), save: (k, v) => store.set(k, v) } };
}

function makeTooling({ storage, onToolOption } = {}) {
  const mount = doc.createElement("div");
  const events = []; // shared ordered log: ["mode"|"brush"|"option", ...args]
  const modeCalls = [];
  const brushCalls = [];
  const optionCalls = [];
  const tooling = createViewportTooling({
    document: doc,
    mount,
    storage,
    onModeChange: (mode, brush) => { modeCalls.push([mode, brush]); events.push(["mode", mode, brush]); },
    onBrushChange: (brush) => { brushCalls.push(brush); events.push(["brush", brush]); },
    onToolOption: onToolOption === null ? undefined : (toolId, key, value) => {
      optionCalls.push([toolId, key, value]);
      events.push(["option", toolId, key, value]);
    },
  });
  return { mount, tooling, modeCalls, brushCalls, optionCalls, events, controller: tooling.controller };
}

test("registry descriptors: ids, groups, surfaces, option schemas, strictness", () => {
  const registry = viewportToolRegistry();
  const tools = registry.forSurface("viewport");
  assert.deepEqual(tools.map((t) => t.id), ["select.pick", "terrain.sculpt", "paint.material", "water.plane", "water.river", "place.scatter", "place.catalog"]);
  for (const t of tools) {
    assert.equal(t.group, t.id.split(".")[0], "group matches id prefix");
    assert.deepEqual(t.surfaces, ["viewport"]);
  }
  assert.deepEqual(registry.forSurface("atlas"), [], "no viewport tool leaks onto the atlas surface");
  const select = tools[0];
  assert.deepEqual(select.options.gizmo.values.map((v) => v.id), ["translate", "rotate", "scale"]);
  assert.equal(select.options.gizmo.def, "translate");
  assert.deepEqual(select.options.space.values.map((v) => v.id), ["world", "local"]);
  assert.equal(select.options.space.def, "world");
  assert.deepEqual(select.options.snap, { kind: "toggle", def: false, label: "Snap" });
  const sculpt = tools[1];
  assert.deepEqual(sculpt.options.mode.values.map((v) => v.id), VIEWPORT_SCULPT_MODES);
  assert.equal(sculpt.options.mode.def, "raise");
  assert.deepEqual(sculpt.options.radius, { kind: "range", min: 2, max: 60, step: 1, def: 12, unit: "m" });
  assert.deepEqual(sculpt.options.strength, { kind: "range", min: 0.2, max: 4, step: 0.1, def: 1.2 });
  assert.deepEqual(sculpt.options.falloff.values.map((v) => v.id), ["smooth", "linear", "constant"]);
  assert.equal(sculpt.options.falloff.def, "smooth");
  const paint = tools[2];
  assert.deepEqual(paint.options.material.values.map((v) => v.id), VIEWPORT_PAINT_MATERIALS);
  assert.equal(paint.options.material.def, "grass");
  assert.equal(paint.options.radius.def, 12, "paint carries the same brush ranges");
  assert.equal(tools[6].options, undefined, "place has no options");
  const water = tools[3];
  assert.deepEqual(water.options.level, { kind: "range", min: -12, max: 40, step: 0.5, def: 0, unit: "m" });
  assert.deepEqual(tools[4].options.class.values.map((v) => v.id), ["river", "stream"]);
  const scatter = tools[5];
  assert.deepEqual(scatter.options.species.values.map((v) => v.id), ["mixed", "spruce", "pine", "birch", "oak", "ash", "dead-oak"]);
  assert.equal(scatter.options.radius.def, 16);
  assert.throws(() => registry.register(tools[0]), /duplicate/);
});

test("toolForBrushTool maps legacy brush tools to ribbon tools", () => {
  assert.equal(toolForBrushTool("paint"), "paint.material");
  assert.equal(toolForBrushTool("catalog"), "place.catalog");
  assert.equal(toolForBrushTool("raise"), "terrain.sculpt");
  assert.equal(toolForBrushTool("flatten"), "terrain.sculpt");
  assert.equal(toolForBrushTool("anything-else"), "terrain.sculpt");
});

test("mount: .viewport-tooling root with ribbon (7 buttons) + options bar; select default", () => {
  const { mount, controller } = makeTooling();
  assert.equal(mount.children.length, 1);
  const root = mount.children[0];
  assert.equal(root.className, "viewport-tooling");
  const ribbon = root.querySelector(".tool-ribbon");
  assert.ok(ribbon, "ribbon mounted");
  assert.equal(ribbon.querySelectorAll(".tool-btn").length, 7);
  assert.ok(root.querySelector(".tool-options"), "options bar mounted");
  assert.equal(controller.activeId(), "select.pick");
  const optionsBar = root.querySelector(".tool-options");
  assert.equal(optionsBar.querySelectorAll(".opt-field").length, 3, "gizmo + space + snap fields");
  const segs = optionsBar.querySelectorAll(".seg-btn");
  assert.equal(segs.length, 5, "3 gizmo + 2 space segments");
  assert.equal(segs.filter((b) => b.classList.contains("active")).length, 2, "translate + world preselected");
  assert.ok(ribbon.querySelectorAll(".tool-btn")[0].classList.contains("active"));
});

test("mode forwarding: tool switches emit (mode, snapshot); no brush events", () => {
  const { controller, modeCalls, brushCalls } = makeTooling();
  const want = { sculptMode: "raise", material: "grass", radius: 12, strength: 1.2, falloff: "smooth" };
  controller.setActiveTool("terrain.sculpt");
  assert.equal(modeCalls.length, 1);
  assert.equal(modeCalls[0][0], "sculpt");
  assert.deepEqual(modeCalls[0][1], want);
  controller.setActiveTool("paint.material");
  assert.equal(modeCalls[1][0], "paint");
  assert.deepEqual(modeCalls[1][1], want);
  controller.setActiveTool("place.catalog");
  assert.equal(modeCalls[2][0], "catalog");
  controller.setActiveTool("select.pick");
  assert.equal(modeCalls[3][0], "select");
  assert.equal(modeCalls.length, 4);
  assert.equal(brushCalls.length, 0, "pure tool switches never fire onBrushChange");
});

test("brush forwarding: only the ACTIVE tool's edits emit; per-tool radius persists", () => {
  const { controller, modeCalls, brushCalls } = makeTooling();
  controller.setActiveTool("terrain.sculpt");
  assert.equal(brushCalls.length, 0);
  controller.setOption("terrain.sculpt", "radius", 30);
  assert.equal(brushCalls.length, 1);
  assert.equal(brushCalls[0].radius, 30);
  controller.setOption("paint.material", "material", "rock");
  assert.equal(brushCalls.length, 1, "inactive tool edit must not reach the shared brush state");
  controller.setActiveTool("paint.material");
  const paintSnap = modeCalls.at(-1)[1];
  assert.equal(paintSnap.material, "rock", "idle edit re-emits on activation");
  assert.equal(paintSnap.radius, 12, "paint has its OWN radius, not sculpt's 30");
  brushCalls.length = 0;
  controller.setOption("paint.material", "radius", 44);
  assert.equal(brushCalls.length, 1);
  assert.equal(brushCalls[0].radius, 44);
  assert.equal(controller.option("terrain.sculpt", "radius"), 30, "sculpt radius untouched by paint edit");
});

test("sculpt mode enum flows through onBrushChange and brushSnapshot()", () => {
  const { controller, tooling, brushCalls } = makeTooling();
  controller.setActiveTool("terrain.sculpt");
  controller.setOption("terrain.sculpt", "mode", "flatten");
  assert.equal(brushCalls.length, 1);
  assert.equal(brushCalls[0].sculptMode, "flatten");
  assert.equal(tooling.brushSnapshot().sculptMode, "flatten");
});

test("storage persistence: snapshot saved under the viewport key and restored on boot", () => {
  const { store, storage } = mapStorage();
  const a = makeTooling({ storage });
  a.controller.setActiveTool("paint.material");
  a.controller.setOption("paint.material", "radius", 22);
  a.controller.setOption("select.pick", "gizmo", "rotate");
  a.controller.setOption("select.pick", "space", "local");
  a.controller.setOption("select.pick", "snap", true);
  assert.ok(store.has(VIEWPORT_STORAGE_KEY), "persisted under the viewport key");
  const b = makeTooling({ storage }); // fresh registry + fresh mount, same storage
  assert.equal(b.controller.activeId(), "paint.material", "active tool restored on construction");
  assert.equal(b.controller.option("paint.material", "radius"), 22, "option value restored");
  assert.equal(b.tooling.brushSnapshot().radius, 22);
  assert.equal(b.controller.option("select.pick", "gizmo"), "rotate", "gizmo option round-trips");
  assert.equal(b.controller.option("select.pick", "space"), "local", "space option round-trips");
  assert.equal(b.controller.option("select.pick", "snap"), true, "snap option round-trips");
});

test("no cross-surface clobber: atlas default key and viewport key stay independent", () => {
  const { store, storage } = mapStorage();
  const atlasRegistry = createToolRegistry();
  atlasRegistry.register({
    id: "terrain.raise", group: "terrain", title: "Raise", icon: "⛰",
    surfaces: ["atlas"], cursor: "brush", gesture: "stroke",
    options: { radius: { kind: "range", min: 2, max: 400, def: 40, step: 2, unit: "m" } },
    commit: () => {},
  });
  const atlas = createToolController({ registry: atlasRegistry, surface: "atlas", storage });
  atlas.setOption("terrain.raise", "radius", 88);
  const vp = makeTooling({ storage });
  vp.controller.setActiveTool("terrain.sculpt");
  vp.controller.setOption("terrain.sculpt", "radius", 30);
  assert.notEqual(VIEWPORT_STORAGE_KEY, ATLAS_STORAGE_KEY);
  const atlasSnap = store.get(ATLAS_STORAGE_KEY);
  assert.equal(atlasSnap.activeId, "terrain.raise");
  assert.deepEqual(Object.keys(atlasSnap.values), ["terrain.raise"], "atlas snapshot sees no viewport tools");
  assert.equal(atlasSnap.values["terrain.raise"].radius, 88, "viewport writes never touch the atlas key");
  const viewportSnap = store.get(VIEWPORT_STORAGE_KEY);
  assert.equal(viewportSnap.activeId, "terrain.sculpt");
  assert.deepEqual(Object.keys(viewportSnap.values), ["terrain.sculpt"], "viewport snapshot sees no atlas tools");
});

test("validation: mount, onModeChange, onBrushChange are required", () => {
  const noop = () => {};
  assert.throws(() => createViewportTooling({ document: doc, mount: null, onModeChange: noop, onBrushChange: noop }), TypeError);
  const mount = doc.createElement("div");
  assert.throws(() => createViewportTooling({ document: doc, mount, onModeChange: "x", onBrushChange: noop }), TypeError);
  assert.throws(() => createViewportTooling({ document: doc, mount, onModeChange: noop, onBrushChange: 42 }), TypeError);
  assert.throws(() => createViewportTooling({ document: doc, mount, onModeChange: noop, onBrushChange: noop, onToolOption: "x" }), TypeError);
});

test("destroy() removes the root from the mount", () => {
  const { mount, tooling } = makeTooling();
  assert.equal(mount.children.length, 1);
  tooling.destroy();
  assert.equal(mount.children.length, 0);
});

test("MODE_BY_TOOL covers every registered viewport tool", () => {
  for (const t of viewportToolRegistry().forSurface("viewport")) {
    assert.ok(typeof MODE_BY_TOOL[t.id] === "string", `mode mapping for ${t.id}`);
  }
});

test("onToolOption: fires for an INACTIVE tool's change; onBrushChange stays silent", () => {
  const { controller, optionCalls, brushCalls } = makeTooling();
  controller.setActiveTool("terrain.sculpt");
  assert.equal(optionCalls.length, 0);
  controller.setOption("select.pick", "snap", true);
  assert.deepEqual(optionCalls, [["select.pick", "snap", true]], "raw stream sees every tool");
  assert.equal(brushCalls.length, 0, "inactive tool edit must not reach the shared brush state");
});

test("onToolOption: coerced values, and it fires BEFORE onBrushChange", () => {
  const { controller, optionCalls, brushCalls, events } = makeTooling();
  controller.setActiveTool("terrain.sculpt");
  events.length = 0;
  controller.setOption("terrain.sculpt", "radius", 999);
  assert.deepEqual(optionCalls, [["terrain.sculpt", "radius", 60]], "clamped to max before forwarding");
  assert.equal(brushCalls.length, 1);
  assert.equal(brushCalls[0].radius, 60);
  assert.deepEqual(events.map((e) => e[0]), ["option", "brush"], "raw stream precedes brush snapshot");
});

test("brushSnapshot() with select.pick active: brush fields fall back to terrain.sculpt", () => {
  const { controller, tooling, modeCalls } = makeTooling();
  controller.setActiveTool("terrain.sculpt");
  controller.setOption("terrain.sculpt", "radius", 33);
  controller.setOption("terrain.sculpt", "strength", 2);
  controller.setOption("terrain.sculpt", "falloff", "linear");
  controller.setActiveTool("select.pick");
  const snap = tooling.brushSnapshot();
  assert.equal(snap.radius, 33, "select owns no brush — sculpt's radius shows through");
  assert.equal(snap.strength, 2);
  assert.equal(snap.falloff, "linear");
  assert.equal(snap.sculptMode, "raise");
  assert.equal(snap.material, "grass");
  assert.deepEqual(modeCalls.at(-1)[1], snap, "mode event carries the same fallback snapshot");
});
