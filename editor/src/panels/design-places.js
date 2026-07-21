// Design Places panel (2.0-D): the vault's `kind: places` doc as a list of
// named points — id, name, kind, coordinates, radius — with inline rename,
// two-click delete, and an "add at 0,0" create leg. All mutations round-trip
// through api.editPlace (ops add|update|delete as served by /api/edit-place);
// nothing is edited client-side only.
//
// Discipline:
// - Keyed rendering only (keyed-render.js): no innerHTML, so focus in the
//   rename field survives a refresh that retains the row.
// - CAS: every mutation re-fetches state afterwards. A 409/conflict rejection
//   refreshes from the vault and surfaces an error line — never a silent
//   clobber of someone else's edit.
// - Row click emits "places.reveal" ({ x, z, placeId }) on the studio bus; a
//   later slice wires it to the 3D camera, so the emit happens regardless.
//
// The document is injected so node --test can drive the panel with a fake DOM.

import { keyedList } from "../keyed-render.js";

function metaOf(p) {
  const bits = [typeof p.kind === "string" && p.kind.length > 0 ? p.kind : "place"];
  if (Array.isArray(p.position) && p.position.length >= 2) bits.push(`(${p.position[0]}, ${p.position[1]})`);
  if (typeof p.radiusM === "number") bits.push(`r ${p.radiusM}m`);
  return bits.join(" · ");
}

export function createDesignPlacesPanel({ document: doc, api, bus }) {
  if (!doc || typeof doc.createElement !== "function") {
    throw new TypeError("design places panel requires a document");
  }
  if (api === null || typeof api !== "object" || typeof api.state !== "function" || typeof api.editPlace !== "function") {
    throw new TypeError("design places panel requires a design-api client");
  }
  if (bus === null || typeof bus !== "object" || typeof bus.emit !== "function") {
    throw new TypeError("design places panel requires an event bus");
  }

  const root = doc.createElement("div");
  root.className = "dp";
  const barEl = doc.createElement("div");
  barEl.className = "dp-bar";
  const addBtn = doc.createElement("button");
  addBtn.className = "btn btn-small dp-add";
  addBtn.type = "button";
  addBtn.textContent = "＋ Add place at 0,0";
  barEl.appendChild(addBtn);
  const errorEl = doc.createElement("div");
  errorEl.className = "dp-error";
  errorEl.hidden = true;
  const listEl = doc.createElement("div");
  listEl.className = "dp-list";
  const emptyEl = doc.createElement("div");
  emptyEl.className = "dp-empty";
  emptyEl.textContent = "No places yet — ＋ Add place drops one at 0,0.";
  emptyEl.hidden = true;
  root.appendChild(barEl);
  root.appendChild(errorEl);
  root.appendChild(listEl);
  root.appendChild(emptyEl);

  let places = [];
  let armedDelete = null; // place id whose delete button awaits its confirming second click
  // Row element -> child refs, so keyed update() needs no querySelector (the
  // fake DOM in tests implements only the keyed-render subset).
  const rowRefs = new WeakMap();

  function setError(message) {
    errorEl.textContent = message ?? "";
    errorEl.hidden = message == null;
  }

  function placeById(id) {
    return places.find((p) => p.id === id);
  }

  function reveal(id) {
    const p = placeById(id);
    if (p === undefined) return;
    const pos = Array.isArray(p.position) && p.position.length >= 2 ? p.position : null;
    bus.emit("places.reveal", { x: pos === null ? null : pos[0], z: pos === null ? null : pos[1], placeId: id });
  }

  async function onEditFailure(e) {
    const conflict = e?.status === 409 || /conflict/i.test(String(e?.message ?? e));
    if (conflict) {
      // CAS discipline: resync from the vault, then say why — never clobber.
      await refresh();
      setError("Edit conflicted with a newer vault state — the list was refreshed.");
    } else {
      setError("Edit failed: " + String(e?.message ?? e));
    }
  }

  async function rename(id, name) {
    const p = placeById(id);
    if (p === undefined) return;
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed === p.name) { render(); return; }
    try {
      await api.editPlace("update", { id, name: trimmed });
      setError(null);
      await refresh();
    } catch (e) {
      await onEditFailure(e);
    }
  }

  async function remove(id) {
    if (armedDelete !== id) { armedDelete = id; render(); return; }
    armedDelete = null;
    try {
      await api.editPlace("delete", { id });
      setError(null);
      await refresh();
    } catch (e) {
      await onEditFailure(e);
    }
  }

  async function addPlace() {
    // No id: the sidecar slugifies the name (uniqued against the tree).
    try {
      await api.editPlace("add", { name: "New place", position: [0, 0] });
      setError(null);
      await refresh();
    } catch (e) {
      await onEditFailure(e);
    }
  }

  function buildRow(p) {
    const id = p.id;
    const row = doc.createElement("div");
    row.className = "dp-row";
    row.dataset.place = id;
    const mainBtn = doc.createElement("button");
    mainBtn.className = "dp-row-main";
    mainBtn.type = "button";
    const nameEl = doc.createElement("span");
    nameEl.className = "dp-name";
    const metaEl = doc.createElement("span");
    metaEl.className = "dp-meta";
    mainBtn.appendChild(nameEl);
    mainBtn.appendChild(metaEl);
    mainBtn.addEventListener("click", () => reveal(id));
    const renameEl = doc.createElement("input");
    renameEl.className = "dp-rename";
    renameEl.type = "text";
    renameEl.title = "Rename (Enter commits, Esc resets)";
    renameEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void rename(id, renameEl.value);
      else if (e.key === "Escape") { renameEl.value = placeById(id)?.name ?? ""; }
    });
    const delEl = doc.createElement("button");
    delEl.className = "btn btn-small dp-del";
    delEl.type = "button";
    delEl.title = "Delete place (click twice to confirm)";
    delEl.addEventListener("click", () => void remove(id));
    row.appendChild(mainBtn);
    row.appendChild(renameEl);
    row.appendChild(delEl);
    rowRefs.set(row, { nameEl, metaEl, renameEl, delEl });
    updateRow(row, p);
    return row;
  }

  function updateRow(row, p) {
    const refs = rowRefs.get(row);
    // Don't stomp an in-flight rename typed since the last refresh — only
    // resync the field when the value still mirrors the old server name.
    const oldName = refs.nameEl.textContent;
    refs.nameEl.textContent = p.name ?? p.id;
    refs.metaEl.textContent = metaOf(p);
    if (refs.renameEl.value === "" || refs.renameEl.value === oldName) {
      refs.renameEl.value = p.name ?? p.id;
    }
    const armed = armedDelete === p.id;
    refs.delEl.textContent = armed ? "Delete?" : "🗑";
    refs.delEl.classList.toggle("armed", armed);
  }

  function render() {
    emptyEl.hidden = places.length > 0;
    keyedList(listEl, places, { key: (p) => p.id, render: buildRow, update: updateRow });
  }

  addBtn.addEventListener("click", () => void addPlace());

  async function refresh() {
    try {
      const s = await api.state();
      places = Array.isArray(s?.places) ? s.places : [];
      if (armedDelete !== null && placeById(armedDelete) === undefined) armedDelete = null;
      render();
    } catch (e) {
      places = [];
      armedDelete = null;
      render();
      setError("Design backend unavailable: " + String(e?.message ?? e));
    }
  }

  return Object.freeze({
    mount(el) {
      if (!el || el.nodeType !== 1) throw new TypeError("design places panel mount must be an Element");
      el.appendChild(root);
    },
    refresh,
    destroy() {
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  });
}
