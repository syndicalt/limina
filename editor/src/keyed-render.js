// Keyed reconciliation over a container's element children.
// innerHTML rebuilds are forbidden here: they lose node identity, and with it
// focus, selection, open <details>, and in-flight CSS transitions.

// container -> Map<key, node>. Keyed by container so registry state dies with
// the container — no expando attributes on nodes, nothing shared across lists.
const registries = new WeakMap();

/**
 * @param {Element} container
 * @param {unknown[]} items
 * @param {{ key: (item: unknown) => string,
 *           render: (item: unknown, index: number) => Node,
 *           update?: (node: Node, item: unknown, index: number) => void }} options
 */
export function keyedList(container, items, { key, render, update } = {}) {
  if (!container || container.nodeType !== 1) throw new TypeError("container must be an Element");
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  if (typeof key !== "function") throw new TypeError("options.key must be a function");
  if (typeof render !== "function") throw new TypeError("options.render must be a function");

  const keys = new Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const k = key(items[i]);
    if (typeof k !== "string" || k.length === 0) throw new TypeError("key(item) must return a non-empty string");
    keys[i] = k;
  }
  // Loose reconciliation of duplicate keys silently drops a row — a data bug, so fail loud.
  if (new Set(keys).size !== keys.length) throw new TypeError("items contain duplicate keys");

  const previous = registries.get(container) ?? new Map();
  const next = new Map();
  // Single in-order pass: insertBefore(node, cursor) both inserts new nodes and
  // moves retained ones, so no per-item rescan of the child list.
  let cursor = container.firstChild;
  for (let i = 0; i < items.length; i++) {
    const k = keys[i];
    let node = previous.get(k);
    if (node === undefined) {
      node = render(items[i], i);
      if (!node || typeof node.nodeType !== "number") throw new TypeError("render must return a Node");
    } else {
      previous.delete(k);
      update?.(node, items[i], i);
    }
    next.set(k, node);
    if (node === cursor) cursor = cursor.nextSibling;
    else container.insertBefore(node, cursor);
  }
  for (const node of previous.values()) container.removeChild(node);
  registries.set(container, next);
}

// Interpolations are concatenated raw — escaping is the caller's job. Trusted/static markup only.
export function html(strings, ...values) {
  let markup = "";
  for (let i = 0; i < strings.length; i++) markup += i < values.length ? strings[i] + String(values[i]) : strings[i];
  const template = document.createElement("template"); // parses without attaching to the document
  template.innerHTML = markup.trim();
  const root = template.content.firstElementChild;
  if (root === null || root.nextElementSibling !== null) throw new Error("html`` requires exactly one root element");
  return root;
}
