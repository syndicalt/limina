import assert from "node:assert/strict";

import { createOutlinerView } from "../src/outliner.js";
import { SelectionStore } from "../src/selection-store.js";

function element(tag) {
  const classes = new Set();
  const handlers = new Map();
  const node = {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    attributes: {},
    style: { setProperty(name, value) { this[name] = value; } },
    className: "",
    textContent: "",
    value: "",
    hidden: false,
    disabled: false,
    clientHeight: 240,
    scrollTop: 0,
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    append(...items) { this.children.push(...items); },
    appendChild(item) { this.children.push(item); return item; },
    replaceChildren(...items) { this.children = [...items]; },
    addEventListener(name, listener) { handlers.set(name, listener); },
    removeEventListener(name) { handlers.delete(name); },
    dispatch(name) { handlers.get(name)?.({ stopPropagation() {} }); },
    focus() { globalThis.document.activeElement = this; },
    get innerHTML() { return ""; },
    set innerHTML(_value) { this.children = []; },
  };
  Object.defineProperty(node, "className", {
    get() { return [...classes].join(" "); },
    set(value) { classes.clear(); for (const name of String(value).split(/\s+/).filter(Boolean)) classes.add(name); },
  });
  return node;
}

globalThis.document = { createElement: element, activeElement: undefined };

function find(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children ?? []) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return undefined;
}

const root = element("div");
const selection = new SelectionStore();
const view = createOutlinerView(root, selection);
const records = [
  { entity: "root", tags: [], transform: { position: [0, 0, 0] } },
  { entity: "child", parent: "root", tags: [], transform: { position: [1, 0, 0] } },
];
assert.equal(view.setEntities(records), true);
const search = find(root, (node) => node.tagName === "INPUT");
const tree = find(root, (node) => node.attributes?.role === "tree");
let rootRow = find(root, (node) => node.dataset?.entityId === "root");
assert(rootRow, "expanded root row missing");
assert(find(root, (node) => node.dataset?.entityId === "child"), "new root should initially show its child");

rootRow.children[0].dispatch("click");
assert.equal(find(root, (node) => node.dataset?.entityId === "child"), undefined, "collapse did not hide child");

tree.scrollTop = 48;
search.focus();
rootRow = find(root, (node) => node.dataset?.entityId === "root");
selection.select("root", "outliner");
assert.equal(find(root, (node) => node.dataset?.entityId === "root"), rootRow, "selection rebuilt hierarchy DOM");
assert.equal(rootRow.classList.contains("selected"), true, "selection did not update rendered row");
assert.equal(tree.scrollTop, 48, "selection changed Outliner scroll");
assert.equal(document.activeElement, search, "selection changed filter focus");

const positionOnly = records.map((record) => ({
  ...record,
  transform: { position: record.entity === "root" ? [9, 9, 9] : record.transform.position },
}));
assert.equal(view.setEntities(positionOnly), false, "position-only refresh rebuilt hierarchy");
assert.equal(find(root, (node) => node.dataset?.entityId === "root"), rootRow, "position-only refresh replaced rows");
assert.equal(find(root, (node) => node.dataset?.entityId === "child"), undefined, "refresh reopened a collapsed root");
assert.equal(tree.scrollTop, 48, "position-only refresh changed scroll");

view.destroy();

const virtualRoot = element("div");
const virtualSelection = new SelectionStore();
const virtualView = createOutlinerView(virtualRoot, virtualSelection);
const virtualRecords = [{ entity: "virtual-root", parent: null, tags: [] }];
for (let index = 0; index < 100; index++) {
  virtualRecords.push({
    entity: `virtual-child-${String(index).padStart(3, "0")}`,
    parent: "virtual-root",
    tags: [],
  });
}
virtualView.setEntities(virtualRecords);
const virtualTree = find(virtualRoot, (node) => node.attributes?.role === "tree");
const virtualRootRow = find(virtualRoot, (node) => node.dataset?.entityId === "virtual-root");
virtualRootRow.children[0].dispatch("click");
assert.equal(find(virtualRoot, (node) => node.dataset?.entityId === "virtual-child-099"), undefined);

virtualSelection.select("virtual-child-099", "viewport");
const revealed = find(virtualRoot, (node) => node.dataset?.entityId === "virtual-child-099");
assert(revealed, "viewport selection did not expand ancestors and enter the virtual window");
assert.equal(revealed.classList.contains("selected"), true, "revealed virtual row is not selected");
assert(virtualTree.scrollTop > 0, "viewport selection did not scroll the virtual tree");

virtualView.destroy();
console.log("outliner_view.test OK: collapse, source-aware reveal, selection, scroll/focus, and position-only refresh stability");
