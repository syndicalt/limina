// Dock layout engine for the Editor 2.0 studio shell (plans/design-space-editor-2.0.md, D1):
// two layout primitives — `split` (ratio-sized panes with a draggable divider) and `tabs`
// (single-focus group) — rendered with the studio dock classes and persisted as plain data.
// Validation and storage injection mirror editor/src/panel-registry.js.
//
// Constraints:
// - Vanilla ES module, no build step, no dependencies. DOM access goes through
//   mount.ownerDocument (falling back to globalThis.document) so tests can inject a fake.
// - Storage is dependency-injected ({ load, save }); without it a memory adapter is used so
//   commit() never branches. Mutations (drag end, tab switch, setLayout, restore) persist
//   then notify; initial construction neither persists nor notifies.
// - Layout trees are strict: unknown keys/kinds and malformed shapes throw TypeError;
//   unknown surface ids throw Error. Split ratios are clamped to [0.15, 0.85] at validation
//   and on every drag move, so state() never emits an out-of-range ratio.
// - A surface id may appear at most once in a tree (a pane owns its surface's DOM).
// - surface.mount(body, document) is called exactly once per render pass, on first show:
//   hidden tabs stay unmounted until shown; setLayout/restore re-render from scratch, so
//   every visible surface is mounted again against a fresh body element.
// - Live drags mutate the ratio without persisting; only pointerup/pointercancel commits.
// - state() returns a fresh deep copy per call; restore(state()) is an identity.
// - destroy() removes the root element (listeners die with the subtree); public methods
//   throw after destroy, and destroy itself is idempotent.

const DEFAULT_STORAGE_KEY = "limina.studio.dock-layout/v1";
const RATIO_MIN = 0.15;
const RATIO_MAX = 0.85;

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0;

const isId = (value) => typeof value === "string" && value.length > 0;

const clampRatio = (ratio) => Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio));

function requireShape(value, required, allowed, what) {
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!allowed.includes(key)) throw new TypeError(`${what} does not allow key "${key}"`);
  }
  for (const key of required) {
    if (!keys.includes(key)) throw new TypeError(`${what} requires key "${key}"`);
  }
}

function validateSurfaces(surfaces) {
  if (!isPlainObject(surfaces)) throw new TypeError("dock layout surfaces must be a plain object");
  for (const [id, surface] of Object.entries(surfaces)) {
    if (!isPlainObject(surface)) throw new TypeError(`surface "${id}" must be a plain object`);
    requireShape(surface, ["title", "mount"], ["title", "mount"], `surface "${id}"`);
    if (!isId(surface.title)) throw new TypeError(`surface "${id}" title must be a non-empty string`);
    if (typeof surface.mount !== "function") throw new TypeError(`surface "${id}" mount must be a function`);
  }
}

// Returns a normalized deep copy; `seen` rejects surfaces docked twice in one tree.
function validateNode(node, surfaces, seen, what) {
  if (!isPlainObject(node)) throw new TypeError(`${what} must be a plain object`);
  if (node.kind === "split") {
    requireShape(node, ["kind", "dir", "ratio", "a", "b"], ["kind", "dir", "ratio", "a", "b"], what);
    if (node.dir !== "horizontal" && node.dir !== "vertical") {
      throw new TypeError(`${what} dir must be "horizontal" or "vertical"`);
    }
    if (typeof node.ratio !== "number" || !Number.isFinite(node.ratio)) {
      throw new TypeError(`${what} ratio must be a finite number`);
    }
    return {
      kind: "split",
      dir: node.dir,
      ratio: clampRatio(node.ratio),
      a: validateNode(node.a, surfaces, seen, `${what}.a`),
      b: validateNode(node.b, surfaces, seen, `${what}.b`),
    };
  }
  if (node.kind === "tabs") {
    requireShape(node, ["kind", "tabs", "active"], ["kind", "tabs", "active"], what);
    if (!Array.isArray(node.tabs) || node.tabs.length === 0 || node.tabs.some((id) => !isId(id))) {
      throw new TypeError(`${what} tabs must be a non-empty array of non-empty string ids`);
    }
    if (new Set(node.tabs).size !== node.tabs.length) throw new TypeError(`${what} tabs must not repeat ids`);
    if (!node.tabs.includes(node.active)) throw new TypeError(`${what} active must be one of tabs`);
    for (const id of node.tabs) {
      if (surfaces[id] === undefined) throw new Error(`${what} names unknown surface "${id}"`);
      if (seen.has(id)) throw new TypeError(`${what} repeats surface "${id}"`);
      seen.add(id);
    }
    return { kind: "tabs", tabs: [...node.tabs], active: node.active };
  }
  throw new TypeError(`${what} kind must be "split" or "tabs"`);
}

function cloneNode(node) {
  return node.kind === "split"
    ? { kind: "split", dir: node.dir, ratio: node.ratio, a: cloneNode(node.a), b: cloneNode(node.b) }
    : { kind: "tabs", tabs: [...node.tabs], active: node.active };
}

function memoryStorage() {
  const memory = new Map();
  return { load: (key) => memory.get(key), save: (key, value) => void memory.set(key, value) };
}

export function createDockLayout(options = {}) {
  if (!isPlainObject(options)) throw new TypeError("dock layout options must be a plain object");
  requireShape(options, ["mount", "layout", "surfaces"],
    ["mount", "layout", "surfaces", "storage", "storageKey", "onChange"], "dock layout options");
  const { mount, surfaces, onChange } = options;
  const storage = options.storage === undefined ? memoryStorage() : options.storage;
  const storageKey = options.storageKey === undefined ? DEFAULT_STORAGE_KEY : options.storageKey;
  if (!mount || mount.nodeType !== 1) throw new TypeError("dock layout mount must be an Element");
  validateSurfaces(surfaces);
  if (typeof storage.load !== "function" || typeof storage.save !== "function") {
    throw new TypeError("dock layout storage must provide load(key) and save(key, value)");
  }
  if (!isId(storageKey)) throw new TypeError("dock layout storageKey must be a non-empty string");
  if (onChange !== undefined && typeof onChange !== "function") {
    throw new TypeError("dock layout onChange must be a function");
  }
  const doc = mount.ownerDocument ?? (typeof document !== "undefined" ? document : undefined);
  if (doc === undefined) throw new Error("dock layout requires a document");

  let tree = validateNode(options.layout, surfaces, new Set(), "layout");
  let destroyed = false;
  let mountedIds = new Set();  // surfaces already mounted in this render pass
  const tabsRefs = new Map();  // tabs node -> { tabEls: Map<id, el>, bodies: Map<id, el> }

  const ensureAlive = () => {
    if (destroyed) throw new Error("dock layout is destroyed");
  };

  const make = (classNames) => {
    const el = doc.createElement("div");
    el.classList.add(...classNames);
    return el;
  };

  function mountSurface(id, body) {
    if (mountedIds.has(id)) return;
    mountedIds.add(id);
    surfaces[id].mount(body, doc);
  }

  function commit() {
    storage.save(storageKey, state());
    if (onChange !== undefined) onChange(state()); // fresh snapshot per notification
  }

  function applyRatio(node, paneA, paneB) {
    paneA.style.flexBasis = `${node.ratio * 100}%`;
    paneB.style.flexBasis = `${(1 - node.ratio) * 100}%`;
  }

  function attachDrag(divider, node, split, paneA, paneB) {
    let dragPointerId = null;
    divider.addEventListener("pointerdown", (event) => {
      if (destroyed || dragPointerId !== null) return;
      dragPointerId = event.pointerId;
      divider.setPointerCapture?.(event.pointerId);
      divider.classList.add("dragging");
      event.preventDefault?.();
    });
    divider.addEventListener("pointermove", (event) => {
      if (dragPointerId === null || event.pointerId !== dragPointerId) return;
      const rect = split.getBoundingClientRect();
      const [offset, extent] = node.dir === "horizontal"
        ? [event.clientX - rect.left, rect.width]
        : [event.clientY - rect.top, rect.height];
      if (!extent) return; // zero-size container carries no ratio information
      node.ratio = clampRatio(offset / extent);
      applyRatio(node, paneA, paneB); // live only — persistence waits for drag end
    });
    const endDrag = (event) => {
      if (dragPointerId === null || event.pointerId !== dragPointerId) return;
      dragPointerId = null;
      divider.classList.remove("dragging");
      divider.releasePointerCapture?.(event.pointerId);
      commit();
    };
    divider.addEventListener("pointerup", endDrag);
    divider.addEventListener("pointercancel", endDrag);
  }

  function renderNode(node) {
    if (node.kind === "split") {
      const split = make(["dock-split", node.dir]);
      const paneA = make(["dock-pane"]);
      const divider = make(["dock-divider"]);
      const paneB = make(["dock-pane"]);
      paneA.appendChild(renderNode(node.a));
      paneB.appendChild(renderNode(node.b));
      applyRatio(node, paneA, paneB);
      split.appendChild(paneA);
      split.appendChild(divider);
      split.appendChild(paneB);
      attachDrag(divider, node, split, paneA, paneB);
      return split;
    }
    const pane = make(["dock-pane"]);
    const tabBar = make(["dock-tabs"]);
    tabBar.hidden = node.tabs.length < 2; // a lone tab gets no chrome
    const tabEls = new Map();
    const bodies = new Map();
    for (const id of node.tabs) {
      const tab = make(["dock-tab"]);
      if (id === node.active) tab.classList.add("active");
      tab.textContent = surfaces[id].title;
      tab.addEventListener("click", () => showTab(id));
      tabBar.appendChild(tab);
      tabEls.set(id, tab);
      const body = make(["dock-pane-body"]);
      body.hidden = id !== node.active;
      bodies.set(id, body);
    }
    pane.appendChild(tabBar);
    for (const id of node.tabs) pane.appendChild(bodies.get(id));
    tabsRefs.set(node, { tabEls, bodies });
    mountSurface(node.active, bodies.get(node.active));
    return pane;
  }

  const root = make(["dock-root"]);
  mount.appendChild(root);

  function renderAll() {
    tabsRefs.clear();
    mountedIds = new Set();
    while (root.firstChild) root.removeChild(root.firstChild);
    root.appendChild(renderNode(tree));
  }

  function findTabsNode(node, id) {
    if (node.kind === "tabs") return node.tabs.includes(id) ? node : null;
    return findTabsNode(node.a, id) ?? findTabsNode(node.b, id);
  }

  function applyLayout(layout) {
    ensureAlive();
    tree = validateNode(layout, surfaces, new Set(), "layout");
    renderAll();
    commit();
  }

  function setLayout(layout) {
    applyLayout(layout);
  }

  function restore(snapshot) {
    applyLayout(snapshot); // same strict validation as setLayout; restore(state()) is an identity
  }

  function showTab(id) {
    ensureAlive();
    if (!isId(id)) throw new TypeError("showTab id must be a non-empty string");
    if (surfaces[id] === undefined) throw new Error(`unknown surface "${id}"`);
    const node = findTabsNode(tree, id);
    if (node === null) throw new Error(`surface "${id}" is not docked in this layout`);
    node.active = id;
    const refs = tabsRefs.get(node);
    for (const [tabId, tab] of refs.tabEls) tab.classList.toggle("active", tabId === id);
    for (const [tabId, body] of refs.bodies) body.hidden = tabId !== id;
    mountSurface(id, refs.bodies.get(id));
    commit();
  }

  function state() {
    return cloneNode(tree);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    tabsRefs.clear();
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  renderAll(); // construction renders but neither persists nor notifies

  return Object.freeze({ setLayout, showTab, state, restore, destroy });
}
