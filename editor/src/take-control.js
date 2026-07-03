// Human take-control inspector. Select an entity from the World panel, edit its
// core properties, apply transform changes optimistically to the live viewport,
// then write through the shared builder.readWrite MCP write path.

import {
  addTag,
  closeWriter,
  destroyEntity,
  ensureWriter,
  removeTag,
  resetWriter,
  writeMaterial,
  writeUpdate,
} from "./write-client.js";
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
  tags: [],
  materialBase: {},
  originInput: undefined,
  transformEdited: false,
  tagsEdited: false,
  materialEdited: false,
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

function clamp01(n) {
  if (!Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n));
}

function toHexColor(n) {
  return "#" + Math.max(0, Math.min(0xffffff, Math.trunc(n))).toString(16).padStart(6, "0");
}

function fromHexColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value) ? Number.parseInt(value.slice(1), 16) : undefined;
}

function finiteVec(v, length) {
  return Array.isArray(v) && v.length === length && v.every(Number.isFinite);
}

function entityRecord(entity) {
  return typeof window.liminaEntity === "function" ? window.liminaEntity(entity) : undefined;
}

function tagsFromRecord(record) {
  return Array.isArray(record?.tags) ? record.tags.filter((tag) => typeof tag === "string") : undefined;
}

function originInputFromRecord(record) {
  const input = record?.origin?.input;
  return input && typeof input === "object" ? input : undefined;
}

function materialBaseFromOrigin(input) {
  const base = {};
  if (Number.isInteger(input?.color) && input.color >= 0 && input.color <= 0xffffff) base.color = input.color;
  if (Number.isFinite(input?.roughness)) base.roughness = clamp01(input.roughness);
  if (Number.isFinite(input?.metalness)) base.metalness = clamp01(input.metalness);
  return base;
}

function transformFromRecord(record, fallback) {
  const next = cloneTransform(fallback);
  if (finiteVec(record?.transform?.position, 3)) next.position = [...record.transform.position];
  if (finiteVec(record?.transform?.scale, 3)) next.scale = [...record.transform.scale];
  if (finiteVec(record?.transform?.rotation, 4)) {
    next.rotationDeg = quaternionToEuler(...record.transform.rotation).map(radToDeg);
  }
  return next;
}

function refreshSelectionFromSnapshot() {
  if (!state.entity) return;
  const record = entityRecord(state.entity);
  if (!record) return;
  if (!state.transformEdited) state.base = transformFromRecord(record, state.base);
  if (!state.tagsEdited) state.tags = tagsFromRecord(record) ?? state.tags;
  state.originInput = originInputFromRecord(record) ?? state.originInput;
  if (!state.materialEdited) state.materialBase = materialBaseFromOrigin(state.originInput);
}

function parseVecFromRow(row) {
  const text = row?.querySelector(".dim")?.textContent ?? "";
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

function readOptionalNumber(inputName) {
  const input = document.querySelector(`[data-take-input="${inputName}"]`);
  if (!input || input.value.trim() === "") return undefined;
  const value = Number(input.value);
  return Number.isFinite(value) ? value : NaN;
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

function section(label) {
  const wrap = document.createElement("fieldset");
  wrap.className = "take-fieldset";
  const legend = document.createElement("legend");
  legend.textContent = label;
  wrap.appendChild(legend);
  return wrap;
}

function readonlyRow(label, value) {
  const labelEl = document.createElement("label");
  labelEl.textContent = label;
  const valueEl = document.createElement("span");
  valueEl.className = value === "none" ? "muted" : "mono";
  valueEl.textContent = value;
  valueEl.style.marginLeft = "auto";
  valueEl.style.overflow = "hidden";
  valueEl.style.textOverflow = "ellipsis";
  labelEl.appendChild(valueEl);
  return labelEl;
}

function renderTransformSection(form) {
  form.appendChild(fieldset("Position", "position", state.base.position));
  form.appendChild(fieldset("Rotation deg", "rotation", state.base.rotationDeg));
  form.appendChild(fieldset("Scale", "scale", state.base.scale));

  const actions = document.createElement("div");
  actions.className = "take-actions";
  const apply = document.createElement("button");
  apply.className = "btn btn-small";
  apply.type = "button";
  apply.textContent = "Apply transform";
  apply.addEventListener("click", () => { void applyEdits(); });
  actions.appendChild(apply);
  form.appendChild(actions);
}

function renderMaterialSection(form) {
  const material = section("Material");

  const colorLabel = document.createElement("label");
  colorLabel.textContent = "color";
  const color = document.createElement("input");
  color.type = "color";
  color.value = toHexColor(Number.isInteger(state.materialBase.color) ? state.materialBase.color : 0xffffff);
  color.dataset.takeInput = "material-color";
  color.dataset.dirty = "false";
  color.addEventListener("input", () => { color.dataset.dirty = "true"; });
  colorLabel.appendChild(color);
  material.appendChild(colorLabel);

  for (const key of ["roughness", "metalness"]) {
    const labelEl = document.createElement("label");
    labelEl.textContent = key;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "1";
    input.step = "0.01";
    input.placeholder = "unset";
    input.value = Number.isFinite(state.materialBase[key]) ? fmt(state.materialBase[key]) : "";
    input.dataset.takeInput = `material-${key}`;
    labelEl.appendChild(input);
    material.appendChild(labelEl);
  }

  form.appendChild(material);

  const actions = document.createElement("div");
  actions.className = "take-actions";
  const apply = document.createElement("button");
  apply.className = "btn btn-small";
  apply.type = "button";
  apply.textContent = "Apply material";
  apply.addEventListener("click", () => { void applyMaterialEdits(); });
  actions.appendChild(apply);
  form.appendChild(actions);
}

function renderTagsSection(form) {
  const tags = section("Tags");
  const list = document.createElement("div");
  list.className = "tags";
  list.style.marginLeft = "0";
  list.style.flexWrap = "wrap";
  list.style.gridColumn = "1 / -1";
  if (state.tags.length === 0) {
    const empty = document.createElement("span");
    empty.className = "muted";
    empty.textContent = "none";
    list.appendChild(empty);
  } else {
    for (const tag of state.tags) {
      const chip = document.createElement("span");
      chip.className = "tag";
      chip.textContent = tag + " ";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.title = `Remove ${tag}`;
      remove.style.background = "transparent";
      remove.style.border = "0";
      remove.style.color = "inherit";
      remove.style.cursor = "pointer";
      remove.style.padding = "0";
      remove.addEventListener("click", () => { void removeTagEdit(tag); });
      chip.appendChild(remove);
      list.appendChild(chip);
    }
  }
  tags.appendChild(list);

  const addLabel = document.createElement("label");
  addLabel.textContent = "add";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "tag";
  input.dataset.takeInput = "tag-add";
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void addTagEdit();
    }
  });
  addLabel.appendChild(input);
  tags.appendChild(addLabel);
  form.appendChild(tags);

  const actions = document.createElement("div");
  actions.className = "take-actions";
  const add = document.createElement("button");
  add.className = "btn btn-small";
  add.type = "button";
  add.textContent = "Add tag";
  add.addEventListener("click", () => { void addTagEdit(); });
  actions.appendChild(add);
  form.appendChild(actions);
}

function renderPhysicsSection(form) {
  const input = state.originInput ?? {};
  const physics = section("Physics & shape");
  const bodyType = input.dynamic === true ? "Dynamic" : input.static === true ? "Static" : "none";
  physics.appendChild(readonlyRow("shape", typeof input.shape === "string" ? input.shape : "none"));
  physics.appendChild(readonlyRow("size", Number.isFinite(input.size) ? fmt(input.size) : "none"));
  physics.appendChild(readonlyRow("body", bodyType));
  const note = document.createElement("div");
  note.className = "muted";
  note.textContent = "set at creation";
  note.style.gridColumn = "1 / -1";
  physics.appendChild(note);
  form.appendChild(physics);
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

  refreshSelectionFromSnapshot();
  const form = document.createElement("div");
  form.className = "take-form";
  const title = document.createElement("div");
  title.className = "take-entity mono";
  title.textContent = state.entity;
  form.appendChild(title);

  renderTransformSection(form);
  renderMaterialSection(form);
  renderTagsSection(form);
  renderPhysicsSection(form);

  const actions = document.createElement("div");
  actions.className = "take-actions";
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

// Copied from js/src/kernel/math.ts quaternionToEuler. Output is radians, XYZ order.
function quaternionToEuler(x, y, z, w) {
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const m11 = 1 - (yy + zz), m12 = xy - wz, m13 = xz + wy;
  const m22 = 1 - (xx + zz), m23 = yz - wx;
  const m32 = yz + wx, m33 = 1 - (xx + yy);
  const clamp = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);
  const ey = Math.asin(clamp(m13));
  if (Math.abs(m13) < 0.9999999) {
    return [Math.atan2(-m23, m33), ey, Math.atan2(-m12, m11)];
  }
  return [Math.atan2(m32, m22), ey, 0];
}

function degToRad(v) {
  return v * Math.PI / 180;
}

function radToDeg(v) {
  return v * 180 / Math.PI;
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
    state.transformEdited = true;
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

async function applyMaterialEdits() {
  if (!state.entity) {
    setStatus("select an entity first", "warn");
    return;
  }
  const colorInput = document.querySelector('[data-take-input="material-color"]');
  const roughness = readOptionalNumber("material-roughness");
  const metalness = readOptionalNumber("material-metalness");
  if (Number.isNaN(roughness) || Number.isNaN(metalness)) {
    setStatus("material fields must be finite numbers", "err");
    return;
  }
  if ((roughness !== undefined && (roughness < 0 || roughness > 1)) || (metalness !== undefined && (metalness < 0 || metalness > 1))) {
    setStatus("roughness and metalness must be 0..1", "err");
    return;
  }

  const material = {};
  const color = colorInput ? fromHexColor(colorInput.value) : undefined;
  const colorDirty = colorInput?.dataset.dirty === "true";
  if (color !== undefined && (colorDirty || (Number.isInteger(state.materialBase.color) && color !== state.materialBase.color))) {
    material.color = color;
  }
  if (roughness !== undefined && roughness !== state.materialBase.roughness) material.roughness = roughness;
  if (metalness !== undefined && metalness !== state.materialBase.metalness) material.metalness = metalness;

  if (Object.keys(material).length === 0) {
    setStatus("no material changes to apply", "warn");
    return;
  }

  try {
    setStatus("connecting writer...", "info");
    await ensureWriter();
    setStatus("applying material...", "info");
    await writeMaterial(state.entity, material);
    state.materialBase = { ...state.materialBase, ...material };
    state.materialEdited = true;
    console.info("take-control material applied", { entity: state.entity, fields: Object.keys(material) });
    renderInspector();
    setStatus(`applied material ${Object.keys(material).join(", ")}`, "ok");
  } catch (e) {
    resetWriter();
    const message = e && e.message ? e.message : String(e);
    surfaceViewportWarning("take-control material failed", e);
    setStatus("failed: " + message, "err");
  }
}

async function addTagEdit() {
  if (!state.entity) {
    setStatus("select an entity first", "warn");
    return;
  }
  const input = document.querySelector('[data-take-input="tag-add"]');
  const tag = input?.value?.trim();
  if (!tag) {
    setStatus("enter a tag first", "warn");
    return;
  }
  if (state.tags.includes(tag)) {
    setStatus("tag already present", "warn");
    return;
  }
  try {
    setStatus("connecting writer...", "info");
    await ensureWriter();
    setStatus("adding tag...", "info");
    await addTag(state.entity, tag);
    state.tags = [...state.tags, tag].sort();
    state.tagsEdited = true;
    console.info("take-control tag added", { entity: state.entity, tag });
    renderInspector();
    setStatus(`added tag ${tag}`, "ok");
  } catch (e) {
    resetWriter();
    const message = e && e.message ? e.message : String(e);
    surfaceViewportWarning("take-control add tag failed", e);
    setStatus("failed: " + message, "err");
  }
}

async function removeTagEdit(tag) {
  if (!state.entity) {
    setStatus("select an entity first", "warn");
    return;
  }
  try {
    setStatus("connecting writer...", "info");
    await ensureWriter();
    setStatus("removing tag...", "info");
    await removeTag(state.entity, tag);
    state.tags = state.tags.filter((candidate) => candidate !== tag);
    state.tagsEdited = true;
    console.info("take-control tag removed", { entity: state.entity, tag });
    renderInspector();
    setStatus(`removed tag ${tag}`, "ok");
  } catch (e) {
    resetWriter();
    const message = e && e.message ? e.message : String(e);
    surfaceViewportWarning("take-control remove tag failed", e);
    setStatus("failed: " + message, "err");
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
    state.tags = [];
    state.materialBase = {};
    state.originInput = undefined;
    state.transformEdited = false;
    state.tagsEdited = false;
    state.materialEdited = false;
    highlightSelectedRow();
    renderInspector();
  } catch (e) {
    resetWriter();
    const message = e && e.message ? e.message : String(e);
    surfaceViewportWarning("take-control delete failed", e);
    setStatus("failed: " + message, "err");
  }
}

function selectEntity(entity, row, options = {}) {
  if (!entity) return;
  const transform = cloneTransform(DEFAULT_TRANSFORM);
  const pos = parseVecFromRow(row);
  if (pos) transform.position = pos;
  const record = entityRecord(entity);
  state.entity = entity;
  state.base = transformFromRecord(record, transform);
  state.tags = tagsFromRecord(record) ?? [];
  state.originInput = originInputFromRecord(record);
  state.materialBase = materialBaseFromOrigin(state.originInput);
  state.transformEdited = false;
  state.tagsEdited = false;
  state.materialEdited = false;
  highlightSelectedRow();
  renderInspector();
  // The Inspector is not a menu window you open by hand — selecting an entity in the
  // World panel pops it up (and focuses it if already open).
  window.liminaWindows?.open?.("inspector");
  if (options.emitViewportSelection !== false) {
    window.dispatchEvent(new CustomEvent(SELECT_ENTITY_EVENT, { detail: { entity, source: "world-panel" } }));
  }
}

function selectRow(row, options = {}) {
  selectEntity(rowEntity(row), row, options);
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
    selectEntity(entity, row, { emitViewportSelection: false });
  });
  new MutationObserver(highlightSelectedRow).observe(worldBody, { childList: true, subtree: true });
  renderInspector();
}

window.addEventListener("beforeunload", () => {
  closeWriter();
});
