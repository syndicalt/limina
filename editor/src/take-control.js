// Human take-control inspector. Select an entity from the World panel, edit its
// transform, apply it optimistically to the live viewport, then write through the
// shared builder.readWrite MCP write path.

import { closeWriter, destroyEntity, ensureWriter, resetWriter, writeUpdate } from "./write-client.js";
import { applyOptimisticUpdate, reconcileViewport, surfaceViewportWarning } from "./viewport.js";

const worldBody = document.getElementById("world-body");
const inspectorBody = document.getElementById("inspector-body");
const SELECT_ENTITY_EVENT = "limina:select-entity";
const VIEWPORT_ENTITY_SELECTED_EVENT = "limina:viewport-entity-selected";

const DEFAULT_TRANSFORM = {
  position: [0, 0, 0],
  rotationDeg: [0, 0, 0],
  scale: [1, 1, 1],
};

const state = {
  entity: undefined,
  base: cloneTransform(DEFAULT_TRANSFORM),
};

function cloneTransform(t) {
  return {
    position: [...t.position],
    rotationDeg: [...t.rotationDeg],
    scale: [...t.scale],
  };
}

function setStatus(message, kind = "info") {
  const el = document.getElementById("inspector-status");
  if (!el) return;
  el.textContent = message;
  el.className = "take-status take-status-" + kind;
}

function fmt(n) {
  return Number.isFinite(n) ? String(Math.round(n * 1000000) / 1000000) : "0";
}

function parseVecFromRow(row) {
  const text = row.querySelector(".dim")?.textContent ?? "";
  const match = text.match(/\(([^)]*)\)/);
  if (!match) return undefined;
  const nums = match[1].split(",").map((v) => Number(v.trim()));
  return nums.length === 3 && nums.every(Number.isFinite) ? nums : undefined;
}

function readVec(prefix) {
  return ["x", "y", "z"].map((axis) => {
    const input = document.querySelector(`[data-take-input="${prefix}-${axis}"]`);
    return Number(input?.value);
  });
}

function validVec(v) {
  return v.length === 3 && v.every(Number.isFinite);
}

function changed(a, b) {
  return a.length !== b.length || a.some((v, i) => v !== b[i]);
}

function rowEntity(row) {
  const id = row?.querySelector(".mono")?.textContent?.trim();
  return id && id.startsWith("ent_") ? id : undefined;
}

function highlightSelectedRow() {
  if (!worldBody) return;
  for (const row of worldBody.querySelectorAll(".row")) {
    row.classList.toggle("selected", rowEntity(row) === state.entity);
  }
}

function fieldset(label, prefix, values) {
  const wrap = document.createElement("fieldset");
  wrap.className = "take-fieldset";
  const legend = document.createElement("legend");
  legend.textContent = label;
  wrap.appendChild(legend);
  for (const [i, axis] of ["x", "y", "z"].entries()) {
    const labelEl = document.createElement("label");
    labelEl.textContent = axis;
    const input = document.createElement("input");
    input.type = "number";
    input.step = prefix === "rotation" ? "1" : "0.1";
    input.value = fmt(values[i]);
    input.dataset.takeInput = `${prefix}-${axis}`;
    labelEl.appendChild(input);
    wrap.appendChild(labelEl);
  }
  return wrap;
}

function renderInspector() {
  if (!inspectorBody) return;
  inspectorBody.innerHTML = "";
  if (!state.entity) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "select an entity in World";
    inspectorBody.appendChild(empty);
    return;
  }

  const form = document.createElement("div");
  form.className = "take-form";
  const title = document.createElement("div");
  title.className = "take-entity mono";
  title.textContent = state.entity;
  form.appendChild(title);
  form.appendChild(fieldset("Position", "position", state.base.position));
  form.appendChild(fieldset("Rotation deg", "rotation", state.base.rotationDeg));
  form.appendChild(fieldset("Scale", "scale", state.base.scale));

  const actions = document.createElement("div");
  actions.className = "take-actions";
  const apply = document.createElement("button");
  apply.className = "btn btn-small";
  apply.type = "button";
  apply.textContent = "Apply";
  apply.addEventListener("click", () => { void applyEdits(); });
  actions.appendChild(apply);
  const del = document.createElement("button");
  del.className = "btn btn-small btn-danger";
  del.type = "button";
  del.textContent = "Delete";
  del.addEventListener("click", () => { void deleteEntity(); });
  actions.appendChild(del);
  form.appendChild(actions);

  const status = document.createElement("div");
  status.id = "inspector-status";
  status.className = "take-status";
  status.textContent = "ready";
  form.appendChild(status);
  inspectorBody.appendChild(form);
}

// Copied from js/src/kernel/math.ts eulerToQuaternion. Input is radians, XYZ order.
function eulerToQuaternion(x, y, z) {
  const c1 = Math.cos(x / 2), s1 = Math.sin(x / 2);
  const c2 = Math.cos(y / 2), s2 = Math.sin(y / 2);
  const c3 = Math.cos(z / 2), s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

function degToRad(v) {
  return v * Math.PI / 180;
}

async function applyEdits() {
  if (!state.entity) {
    setStatus("select an entity first", "warn");
    return;
  }
  const position = readVec("position");
  const rotationDeg = readVec("rotation");
  const scale = readVec("scale");
  if (!validVec(position) || !validVec(rotationDeg) || !validVec(scale)) {
    setStatus("all fields must be finite numbers", "err");
    return;
  }

  const updates = [];
  if (changed(position, state.base.position)) updates.push(["position", position]);
  if (changed(scale, state.base.scale)) updates.push(["scale", scale]);
  if (changed(rotationDeg, state.base.rotationDeg)) {
    updates.push(["rotation", eulerToQuaternion(...rotationDeg.map(degToRad))]);
  }
  if (updates.length === 0) {
    setStatus("no changes to apply", "warn");
    return;
  }

  try {
    setStatus("applying...", "info");
    for (const [component, value] of updates) await applyOptimisticUpdate(state.entity, component, value);
    setStatus("connecting writer...", "info");
    await ensureWriter();
    setStatus("applying...", "info");
    for (const [component, value] of updates) await writeUpdate(state.entity, component, value);
    state.base = { position, rotationDeg, scale };
    console.info("take-control applied", { entity: state.entity, components: updates.map(([c]) => c) });
    setStatus(`applied ${updates.map(([component]) => component).join(", ")}`, "ok");
  } catch (e) {
    resetWriter();
    const message = e && e.message ? e.message : String(e);
    surfaceViewportWarning("take-control apply failed", e);
    setStatus("failed: " + message, "err");
    await reconcileViewport();
  }
}

async function deleteEntity() {
  if (!state.entity) {
    setStatus("select an entity first", "warn");
    return;
  }
  const entity = state.entity;
  try {
    setStatus("deleting...", "info");
    await ensureWriter();
    await destroyEntity(entity);
    console.info("take-control destroyed", { entity });
    state.entity = undefined;
    highlightSelectedRow();
    renderInspector();
  } catch (e) {
    resetWriter();
    const message = e && e.message ? e.message : String(e);
    surfaceViewportWarning("take-control delete failed", e);
    setStatus("failed: " + message, "err");
  }
}

function selectRow(row, options = {}) {
  const entity = rowEntity(row);
  if (!entity) return;
  const transform = cloneTransform(DEFAULT_TRANSFORM);
  const pos = parseVecFromRow(row);
  if (pos) transform.position = pos;
  state.entity = entity;
  state.base = transform;
  highlightSelectedRow();
  renderInspector();
  // The Inspector is not a menu window you open by hand — selecting an entity in the
  // World panel pops it up (and focuses it if already open).
  window.liminaWindows?.open?.("inspector");
  if (options.emitViewportSelection !== false) {
    window.dispatchEvent(new CustomEvent(SELECT_ENTITY_EVENT, { detail: { entity, source: "world-panel" } }));
  }
}

if (worldBody && inspectorBody) {
  worldBody.addEventListener("click", (event) => {
    const row = event.target instanceof Element ? event.target.closest(".row") : null;
    if (row && worldBody.contains(row)) selectRow(row);
  });
  window.addEventListener(VIEWPORT_ENTITY_SELECTED_EVENT, (event) => {
    const entity = event instanceof CustomEvent ? event.detail?.entity : undefined;
    if (typeof entity !== "string" || !entity.startsWith("ent_")) return;
    const row = [...worldBody.querySelectorAll(".row")].find((candidate) => rowEntity(candidate) === entity);
    if (row) selectRow(row, { emitViewportSelection: false });
  });
  new MutationObserver(highlightSelectedRow).observe(worldBody, { childList: true, subtree: true });
  renderInspector();
}

window.addEventListener("beforeunload", () => {
  closeWriter();
});
