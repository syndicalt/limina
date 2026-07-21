// Design Graph panel (2.0-D): READ-ONLY render of the sidecar's vaultGraph —
// nodes grouped by kind with counts, and the typed edge list ("a → b (type)").
// No editing here: changing the graph means editing the docs that generate it
// (design.review territory), so the only interaction is a click on a node,
// which emits "docs.open" ({ docId }) on the studio bus for the Docs tab.
//
// Keyed rendering only (keyed-render.js); the document is injected so
// node --test can drive the panel with a fake DOM.

import { keyedList } from "../keyed-render.js";

export function createDesignGraphPanel({ document: doc, api, bus }) {
  if (!doc || typeof doc.createElement !== "function") {
    throw new TypeError("design graph panel requires a document");
  }
  if (api === null || typeof api !== "object" || typeof api.state !== "function") {
    throw new TypeError("design graph panel requires a design-api client");
  }
  if (bus === null || typeof bus !== "object" || typeof bus.emit !== "function") {
    throw new TypeError("design graph panel requires an event bus");
  }

  const root = doc.createElement("div");
  root.className = "dg";
  const errorEl = doc.createElement("div");
  errorEl.className = "dg-error";
  errorEl.hidden = true;
  const nodesHead = doc.createElement("div");
  nodesHead.className = "dg-head";
  nodesHead.textContent = "Nodes";
  const groupsEl = doc.createElement("div");
  groupsEl.className = "dg-groups";
  const nodesEmpty = doc.createElement("div");
  nodesEmpty.className = "dg-empty dg-empty-nodes";
  nodesEmpty.textContent = "No graph nodes yet — vault docs generate them.";
  nodesEmpty.hidden = true;
  const edgesHead = doc.createElement("div");
  edgesHead.className = "dg-head";
  edgesHead.textContent = "Edges";
  const edgesEl = doc.createElement("div");
  edgesEl.className = "dg-edges";
  const edgesEmpty = doc.createElement("div");
  edgesEmpty.className = "dg-empty dg-empty-edges";
  edgesEmpty.textContent = "No edges yet — links between entities appear here.";
  edgesEmpty.hidden = true;
  root.appendChild(errorEl);
  root.appendChild(nodesHead);
  root.appendChild(groupsEl);
  root.appendChild(nodesEmpty);
  root.appendChild(edgesHead);
  root.appendChild(edgesEl);
  root.appendChild(edgesEmpty);

  let nodes = [];
  let edges = [];
  // Element refs, so keyed update() needs no querySelector (the fake DOM in
  // tests implements only the keyed-render subset).
  const groupRefs = new WeakMap();
  const nodeRefs = new WeakMap();
  const edgeRefs = new WeakMap();

  function setError(message) {
    errorEl.textContent = message ?? "";
    errorEl.hidden = message == null;
  }

  // Group nodes by kind (type), first-appearance order — a stable, meaningful
  // arrangement that doesn't reshuffle as the vault grows.
  function grouped() {
    const order = [];
    const byType = new Map();
    for (const n of nodes) {
      const type = typeof n.type === "string" && n.type.length > 0 ? n.type : "node";
      if (!byType.has(type)) { byType.set(type, []); order.push(type); }
      byType.get(type).push(n);
    }
    return order.map((type) => ({ type, nodes: byType.get(type) }));
  }

  function buildNodeRow(n) {
    const id = n.id;
    const row = doc.createElement("button");
    row.className = "dg-node";
    row.type = "button";
    const labelEl = doc.createElement("span");
    labelEl.className = "dg-node-label";
    const idEl = doc.createElement("span");
    idEl.className = "dg-node-id";
    row.appendChild(labelEl);
    row.appendChild(idEl);
    row.addEventListener("click", () => bus.emit("docs.open", { docId: id }));
    nodeRefs.set(row, { labelEl, idEl });
    updateNodeRow(row, n);
    return row;
  }

  function updateNodeRow(row, n) {
    const refs = nodeRefs.get(row);
    refs.labelEl.textContent = typeof n.label === "string" && n.label.length > 0 ? n.label : n.id;
    refs.idEl.textContent = n.id;
  }

  function buildGroup(g) {
    const el = doc.createElement("div");
    el.className = "dg-group";
    const head = doc.createElement("div");
    head.className = "dg-group-head";
    const list = doc.createElement("div");
    list.className = "dg-group-nodes";
    el.appendChild(head);
    el.appendChild(list);
    groupRefs.set(el, { head, list });
    updateGroup(el, g);
    return el;
  }

  function updateGroup(el, g) {
    const refs = groupRefs.get(el);
    refs.head.textContent = `${g.type} (${g.nodes.length})`;
    keyedList(refs.list, g.nodes, { key: (n) => n.id, render: buildNodeRow, update: updateNodeRow });
  }

  function edgeText(e) {
    return `${e.from} → ${e.to} (${e.label})`;
  }

  function buildEdgeRow(e) {
    const row = doc.createElement("div");
    row.className = "dg-edge";
    const textEl = doc.createElement("span");
    textEl.className = "dg-edge-text";
    row.appendChild(textEl);
    edgeRefs.set(row, { textEl });
    updateEdgeRow(row, e);
    return row;
  }

  function updateEdgeRow(row, e) {
    edgeRefs.get(row).textEl.textContent = edgeText(e);
  }

  function render() {
    const groups = grouped();
    nodesEmpty.hidden = groups.length > 0;
    keyedList(groupsEl, groups, { key: (g) => g.type, render: buildGroup, update: updateGroup });
    edgesEmpty.hidden = edges.length > 0;
    // Edges carry no id — (from,to,label) is the identity; a fully duplicated
    // edge throws in keyedList (fail loud: the sidecar should not emit one).
    keyedList(edgesEl, edges, { key: (e) => `${e.from}->${e.to}:${e.label}`, render: buildEdgeRow, update: updateEdgeRow });
  }

  async function refresh() {
    try {
      const s = await api.state();
      const graph = s?.graph;
      nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
      edges = Array.isArray(graph?.edges) ? graph.edges : [];
      setError(null);
      render();
    } catch (e) {
      nodes = [];
      edges = [];
      render();
      setError("Design backend unavailable: " + String(e?.message ?? e));
    }
  }

  return Object.freeze({
    mount(el) {
      if (!el || el.nodeType !== 1) throw new TypeError("design graph panel mount must be an Element");
      el.appendChild(root);
    },
    refresh,
    destroy() {
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  });
}
