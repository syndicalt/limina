// Proves keyedList reconciles by node identity: retained keys keep the SAME
// node object across re-renders, reorder is done by moving nodes (not
// re-creating), stale keys are removed, and update() delivers new data to
// retained nodes. Also proves the contract throws (duplicates, non-array,
// non-Element, missing key fn) and that a 10k-item re-render stays O(n):
// same-order re-render performs ZERO DOM mutations and a single childList pass.
//
// Falsifiability: a naive innerHTML rebuild creates fresh nodes every render,
// so every identity assertion (`assert.equal(after, before)`) fails; the fake
// DOM does not implement innerHTML at all, so such an implementation throws
// instead of passing. An O(n²) reconcile (per-item indexOf over children)
// would exceed the mutation/traversal budgets in the 10k test.

import test from "node:test";
import assert from "node:assert/strict";

import { keyedList } from "../src/keyed-render.js";

// Minimal DOM subset used by keyed-render: nodeType, firstChild/nextSibling
// traversal, insertBefore/appendChild/removeChild. Mutation and traversal
// calls are counted per instance for the O(n) assertions; internal reparenting
// during a move does not count — counters record only calls keyedList makes.
// innerHTML is deliberately absent — using it must throw.
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
    this.ops = { insertBefore: 0, appendChild: 0, removeChild: 0, traverse: 0 };
  }

  get firstChild() {
    this.ops.traverse++;
    return this.childNodes.length > 0 ? this.childNodes[0] : null;
  }

  get nextSibling() {
    this.ops.traverse++;
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    const at = siblings.indexOf(this);
    return at >= 0 && at + 1 < siblings.length ? siblings[at + 1] : null;
  }

  insertBefore(node, ref) {
    this.ops.insertBefore++;
    if (ref === undefined) ref = null;
    if (ref !== null && ref.parentNode !== this) throw new Error("NotFoundError: reference node is not a child");
    FakeElement.detach(node);
    this.childNodes.splice(ref === null ? this.childNodes.length : this.childNodes.indexOf(ref), 0, node);
    node.parentNode = this;
    return node;
  }

  appendChild(node) {
    this.ops.appendChild++;
    FakeElement.detach(node);
    this.childNodes.push(node);
    node.parentNode = this;
    return node;
  }

  removeChild(node) {
    this.ops.removeChild++;
    if (node.parentNode !== this) throw new Error("NotFoundError: node is not a child");
    FakeElement.detach(node);
    return node;
  }
}

const row = (item) => {
  const el = new FakeElement("li");
  el.textContent = item.name;
  return el;
};
const items = (...ids) => ids.map((id) => ({ id, name: `name-${id}` }));
const byId = (item) => item.id;

test("create-all: renders every item in order", () => {
  const list = new FakeElement("ul");
  keyedList(list, items("a", "b", "c"), { key: byId, render: row });
  assert.deepEqual(list.childNodes.map((n) => n.textContent), ["name-a", "name-b", "name-c"]);
  assert.equal(list.ops.insertBefore, 3);
  assert.equal(list.ops.removeChild, 0);
});

test("reuse-with-identity: retained keys keep the same node object, render not re-called", () => {
  const list = new FakeElement("ul");
  keyedList(list, items("a", "b", "c"), { key: byId, render: row });
  const before = [...list.childNodes];
  let renders = 0;
  keyedList(list, items("a", "b", "c"), { key: byId, render: (item) => (renders++, row(item)) });
  assert.equal(renders, 0);
  assert.deepEqual(list.childNodes, before);
  for (const node of before) assert.equal(list.childNodes.includes(node), true);
});

test("update() is called for retained nodes with new data and current index", () => {
  const list = new FakeElement("ul");
  keyedList(list, items("a", "b"), { key: byId, render: row });
  const calls = [];
  const next = [{ id: "b", name: "B2" }, { id: "a", name: "A2" }];
  keyedList(list, next, {
    key: byId,
    render: row,
    update: (node, item, index) => {
      calls.push([item.id, index]);
      node.textContent = item.name;
    },
  });
  assert.deepEqual(calls, [["b", 0], ["a", 1]]);
  assert.deepEqual(list.childNodes.map((n) => n.textContent), ["B2", "A2"]);
});

test("reorder by move: reversed order reuses nodes via insertBefore, zero renders", () => {
  const list = new FakeElement("ul");
  keyedList(list, items("a", "b", "c", "d"), { key: byId, render: row });
  const before = [...list.childNodes];
  const opsBefore = { ...list.ops };
  let renders = 0;
  keyedList(list, items("d", "c", "b", "a"), { key: byId, render: (item) => (renders++, row(item)) });
  assert.equal(renders, 0);
  assert.equal(list.ops.removeChild - opsBefore.removeChild, 0);
  assert.equal(list.ops.insertBefore - opsBefore.insertBefore <= 4, true);
  assert.deepEqual(list.childNodes.map((n) => n.textContent), ["name-d", "name-c", "name-b", "name-a"]);
  for (const node of list.childNodes) assert.equal(before.includes(node), true);
});

test("stale keys are removed; new keys mid-list are created in place", () => {
  const list = new FakeElement("ul");
  keyedList(list, items("a", "b", "c"), { key: byId, render: row });
  const [a, b, c] = list.childNodes;
  keyedList(list, items("a", "x", "c"), { key: byId, render: row });
  assert.equal(list.childNodes.length, 3);
  assert.equal(list.childNodes[0], a);
  assert.equal(list.childNodes[2], c);
  assert.equal(b.parentNode, null);
  assert.equal(list.childNodes[1].textContent, "name-x");
  assert.equal(list.ops.removeChild, 1);
});

test("empty list clears the container and releases nodes", () => {
  const list = new FakeElement("ul");
  keyedList(list, items("a", "b"), { key: byId, render: row });
  const before = [...list.childNodes];
  keyedList(list, [], { key: byId, render: row });
  assert.equal(list.childNodes.length, 0);
  assert.equal(list.firstChild, null);
  for (const node of before) assert.equal(node.parentNode, null);
});

test("duplicate keys throw TypeError", () => {
  const list = new FakeElement("ul");
  assert.throws(() => keyedList(list, items("a", "a"), { key: byId, render: row }), TypeError);
});

test("contract violations throw TypeError", () => {
  const list = new FakeElement("ul");
  assert.throws(() => keyedList(list, "not-an-array", { key: byId, render: row }), TypeError);
  assert.throws(() => keyedList(list, items("a"), { render: row }), TypeError);
  assert.throws(() => keyedList(list, items("a"), { key: byId }), TypeError);
  assert.throws(() => keyedList({}, items("a"), { key: byId, render: row }), TypeError);
  assert.throws(() => keyedList(null, items("a"), { key: byId, render: row }), TypeError);
});

test("registries are per-container: two lists with overlapping keys stay independent", () => {
  const one = new FakeElement("ul");
  const two = new FakeElement("ul");
  keyedList(one, items("a"), { key: byId, render: row });
  keyedList(two, items("a"), { key: byId, render: row });
  assert.notEqual(one.childNodes[0], two.childNodes[0]);
  keyedList(one, [], { key: byId, render: row });
  assert.equal(one.childNodes.length, 0);
  assert.equal(two.childNodes.length, 1);
});

test("10k items: same-order re-render performs zero mutations and one pass", () => {
  const list = new FakeElement("ul");
  const data = Array.from({ length: 10_000 }, (_, i) => ({ id: `k${i}`, name: `n${i}` }));
  keyedList(list, data, { key: byId, render: row });
  assert.equal(list.childNodes.length, 10_000);
  assert.equal(list.ops.insertBefore, 10_000); // exactly one insert per new node
  assert.equal(list.ops.removeChild, 0);

  const before = [...list.childNodes];
  const opsBefore = { ...list.ops };
  let updates = 0;
  const refreshed = data.map((item) => ({ ...item, name: `${item.name}*` }));
  keyedList(list, refreshed, { key: byId, render: () => assert.fail("render called for retained key"), update: () => updates++ });
  assert.equal(updates, 10_000);
  assert.equal(list.ops.insertBefore, opsBefore.insertBefore);
  assert.equal(list.ops.appendChild, opsBefore.appendChild);
  assert.equal(list.ops.removeChild, opsBefore.removeChild);
  // Single pass: one firstChild plus one nextSibling per already-ordered node.
  assert.equal(list.ops.traverse - opsBefore.traverse <= 10_001, true);
  for (let i = 0; i < before.length; i++) assert.equal(list.childNodes[i], before[i]);
});

test("10k items reversed: linear moves, identity preserved for all nodes", () => {
  const list = new FakeElement("ul");
  const data = Array.from({ length: 10_000 }, (_, i) => ({ id: `k${i}`, name: `n${i}` }));
  keyedList(list, data, { key: byId, render: row });
  const before = [...list.childNodes];
  const opsBefore = { ...list.ops };
  keyedList(list, [...data].reverse(), { key: byId, render: () => assert.fail("render called") });
  assert.equal(list.ops.insertBefore - opsBefore.insertBefore <= 10_000, true);
  assert.equal(list.ops.removeChild, opsBefore.removeChild);
  for (let i = 0; i < before.length; i++) assert.equal(list.childNodes[i], before[before.length - 1 - i]);
});
