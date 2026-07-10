// Human take-control inspector. Supported scene fields are staged and committed
// together through the authoritative project transaction gateway.

import {
  closeWriter,
  commitSceneOperations,
  destroyEntity,
  resetWriter,
} from "./write-client.js";
import { sceneMaterialOperation, sceneTagsOperation, sceneTransformOperation } from "./authoring-gateway.js";
import { parseTransformDraft } from "./inspector-draft.js";
import { editorSelection } from "./selection-store.js";
import { playLifecycle } from "./play-lifecycle.js";
import { surfaceViewportWarning, viewportIsReadOnly } from "./viewport.js";

const inspectorBody = document.getElementById("inspector-body");

const DEFAULT_TRANSFORM = {
  position: [0, 0, 0],
  rotationDeg: [0, 0, 0],
  scale: [1, 1, 1],
};

const state = {
  entity: undefined,
  base: cloneTransform(DEFAULT_TRANSFORM),
  original: cloneTransform(DEFAULT_TRANSFORM),
  tags: [],
  originalTags: [],
  materialBase: {},
  originalMaterial: {},
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

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function setStatus(message, kind = "info") {
  const node = document.getElementById("inspector-status");
  if (!node) return;
  node.textContent = message;
  node.className = "take-status take-status-" + kind;
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

function materialBaseFromRecord(record) {
  // Prefer the entity's LIVE material (current color/roughness/metalness); fall back to the
  // create-time origin. This fixes the "color always shows white" seeding bug.
  const live = record?.material;
  const origin = originInputFromRecord(record);
  const pick = (a, b) => (Number.isFinite(a) ? a : (Number.isFinite(b) ? b : undefined));
  const base = {};
  const color = pick(live?.color, origin?.color);
  if (Number.isInteger(color) && color >= 0 && color <= 0xffffff) base.color = color;
  const roughness = pick(live?.roughness, origin?.roughness);
  if (roughness !== undefined) base.roughness = clamp01(roughness);
  const metalness = pick(live?.metalness, origin?.metalness);
  if (metalness !== undefined) base.metalness = clamp01(metalness);
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
  if (!state.transformEdited) {
    state.base = transformFromRecord(record, state.base);
    state.original = cloneTransform(state.base);
  }
  if (!state.tagsEdited) {
    state.tags = (tagsFromRecord(record) ?? state.tags).sort();
    state.originalTags = [...state.tags];
  }
  state.originInput = originInputFromRecord(record) ?? state.originInput;
  if (!state.materialEdited) {
    state.materialBase = materialBaseFromRecord(record);
    state.originalMaterial = { ...state.materialBase };
  }
}

function readVec(prefix) {
  return ["x", "y", "z"].map((axis) => {
    const input = document.querySelector(`[data-take-input="${prefix}-${axis}"]`);
    return !input || input.value.trim() === "" ? NaN : Number(input.value);
  });
}

function readOptionalNumber(inputName) {
  const input = document.querySelector(`[data-take-input="${inputName}"]`);
  if (!input || input.value.trim() === "") return undefined;
  const value = Number(input.value);
  return Number.isFinite(value) ? value : NaN;
}

// A 0..1 slider value, or undefined if the user never moved it (so Apply only writes touched fields).
function readSlider(name) {
  const el = document.querySelector(`[data-take-input="${name}"]`);
  if (!el || el.dataset.set !== "true") return undefined;
  const v = Number(el.value);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined;
}

function changed(a, b) {
  return a.length !== b.length || a.some((v, i) => v !== b[i]);
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
    input.addEventListener("input", () => {
      if (input.value.trim() === "") { state.transformEdited = true; return; }
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;
      const key = prefix === "rotation" ? "rotationDeg" : prefix;
      state.base[key][i] = value;
      state.transformEdited = changed(state.base.position, state.original.position) ||
        changed(state.base.rotationDeg, state.original.rotationDeg) || changed(state.base.scale, state.original.scale);
    });
    labelEl.appendChild(input);
    wrap.appendChild(labelEl);
  }
  return wrap;
}

function section(label) {
  const wrap = document.createElement("fieldset");
  wrap.className = "insp-section";
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
}

// A labeled 0..1 slider with a live numeric readout. `value` undefined → the control shows a
// neutral default and is marked "unset" so Apply only writes it if the user actually moves it.
function inspSlider(parent, label, name, value) {
  const row = document.createElement("div");
  row.className = "insp-row";
  const lab = document.createElement("span");
  lab.className = "insp-label";
  lab.textContent = label;
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0"; slider.max = "1"; slider.step = "0.01";
  slider.className = "insp-slider";
  slider.value = Number.isFinite(value) ? String(value) : "0.5";
  slider.dataset.takeInput = name;
  slider.dataset.set = Number.isFinite(value) ? "true" : "false";
  const readout = document.createElement("span");
  readout.className = "insp-val mono";
  readout.textContent = Number.isFinite(value) ? Number(value).toFixed(2) : "—";
  slider.addEventListener("input", () => {
    readout.textContent = Number(slider.value).toFixed(2);
    slider.dataset.set = "true";
    const value = Number(slider.value);
    if (name === "material-smoothness") state.materialBase.roughness = 1 - value;
    else if (name === "material-metallic") state.materialBase.metalness = value;
    state.materialEdited = ["color", "roughness", "metalness"].some(
      (key) => state.materialBase[key] !== state.originalMaterial[key],
    );
  });
  row.append(lab, slider, readout);
  parent.appendChild(row);
}

function renderMaterialSection(form) {
  const material = section("Material");
  const base = state.materialBase;

  const colorRow = document.createElement("div");
  colorRow.className = "insp-row";
  const colorLab = document.createElement("span");
  colorLab.className = "insp-label";
  colorLab.textContent = "Color";
  const color = document.createElement("input");
  color.type = "color";
  color.className = "insp-color";
  color.value = toHexColor(Number.isInteger(base.color) ? base.color : 0xcccccc);
  color.dataset.takeInput = "material-color";
  color.dataset.dirty = "false";
  color.addEventListener("input", () => {
    color.dataset.dirty = "true";
    const value = fromHexColor(color.value);
    if (value !== undefined) state.materialBase.color = value;
    state.materialEdited = ["color", "roughness", "metalness"].some(
      (key) => state.materialBase[key] !== state.originalMaterial[key],
    );
  });
  colorRow.append(colorLab, color);
  material.appendChild(colorRow);

  // Smoothness is the inverse of roughness (Unity convention); Metallic == metalness.
  inspSlider(material, "Smoothness", "material-smoothness", Number.isFinite(base.roughness) ? 1 - base.roughness : undefined);
  inspSlider(material, "Metallic", "material-metallic", base.metalness);

  form.appendChild(material);

}

function renderTagsSection(form) {
  const tags = section("Tags");
  const chips = document.createElement("div");
  chips.className = "insp-chips";
  if (state.tags.length === 0) {
    chips.appendChild(el("span", "muted", "no tags"));
  } else {
    for (const tag of state.tags) {
      const chip = el("span", "insp-chip");
      chip.appendChild(el("span", null, tag));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "insp-chip-x";
      remove.textContent = "×";
      remove.title = `Remove ${tag}`;
      remove.addEventListener("click", () => { removeTagEdit(tag); });
      chip.appendChild(remove);
      chips.appendChild(chip);
    }
  }
  tags.appendChild(chips);

  const addRow = el("div", "insp-add-row");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "insp-add-input";
  input.placeholder = "add a tag…";
  input.dataset.takeInput = "tag-add";
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); addTagEdit(); }
  });
  const add = document.createElement("button");
  add.className = "btn btn-small";
  add.type = "button";
  add.textContent = "Add";
  add.addEventListener("click", () => { addTagEdit(); });
  addRow.append(input, add);
  tags.appendChild(addRow);
  form.appendChild(tags);
}

function renderPhysicsSection(form) {
  const input = state.originInput ?? {};
  const record = entityRecord(state.entity);
  const hasBody = record?.physics?.bodyId !== undefined;
  const physics = section("Physics & shape");

  // Body type: from the create command when known; otherwise just whether a collider exists.
  const bodyType = input.dynamic === true ? "Dynamic body"
    : input.static === true ? "Static body"
    : hasBody ? "Has collider"
    : "No physics";
  const shape = typeof input.shape === "string" ? input.shape : (record?.resource ? "asset" : "—");
  const size = Number.isFinite(input.size) ? fmt(input.size) : "—";

  const grid = el("div", "insp-props");
  const prop = (k, v, muted) => {
    grid.appendChild(el("span", "insp-prop-k", k));
    grid.appendChild(el("span", "insp-prop-v " + (muted ? "muted" : "mono"), v));
  };
  prop("Shape", shape, shape === "—");
  prop("Size", size, size === "—");
  prop("Body", bodyType, bodyType === "No physics");
  physics.appendChild(grid);

  const note = el("div", "insp-note muted", "Set at creation — editing shape/size is engine work in progress.");
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
  const apply = document.createElement("button");
  apply.className = "btn btn-small";
  apply.type = "button";
  apply.textContent = "Apply changes";
  apply.title = "Commit transform, tags, and material together";
  apply.addEventListener("click", () => { void applyEdits(); });
  actions.appendChild(apply);
  const del = document.createElement("button");
  del.className = "btn btn-small btn-danger";
  del.type = "button";
  del.textContent = "Delete";
  del.title = "Legacy delete; not included in scene undo";
  del.addEventListener("click", () => { void deleteEntity(); });
  actions.appendChild(del);
  form.appendChild(actions);

  const status = document.createElement("div");
  status.id = "inspector-status";
  status.className = "take-status";
  status.textContent = "ready";
  form.appendChild(status);
  inspectorBody.appendChild(form);
  syncInspectorReadOnly();
}

function syncInspectorReadOnly() {
  if (!inspectorBody) return;
  const locked = viewportIsReadOnly();
  inspectorBody.setAttribute("aria-disabled", String(locked));
  inspectorBody.classList.toggle("authoring-locked", locked);
  for (const control of inspectorBody.querySelectorAll("input, select, textarea, button")) control.disabled = locked;
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

function captureDraftFromForm() {
  const position = readVec("position");
  const rotationDeg = readVec("rotation");
  const scale = readVec("scale");
  const parsedTransform = parseTransformDraft(position, rotationDeg, scale);
  if (parsedTransform.valid) {
    state.base = parsedTransform.transform;
    state.transformEdited = changed(position, state.original.position) ||
      changed(rotationDeg, state.original.rotationDeg) || changed(scale, state.original.scale);
  }

  const colorInput = document.querySelector('[data-take-input="material-color"]');
  const smoothness = readSlider("material-smoothness");
  const metalness = readSlider("material-metallic");
  const color = colorInput ? fromHexColor(colorInput.value) : undefined;
  if (color !== undefined && colorInput?.dataset.dirty === "true") state.materialBase.color = color;
  if (smoothness !== undefined) state.materialBase.roughness = 1 - smoothness;
  if (metalness !== undefined) state.materialBase.metalness = metalness;
  state.materialEdited = ["color", "roughness", "metalness"].some(
    (key) => state.materialBase[key] !== state.originalMaterial[key],
  );
  return { transformValid: parsedTransform.valid };
}

function materialChanges() {
  const patch = {};
  for (const key of ["color", "roughness", "metalness"]) {
    if (state.materialBase[key] !== state.originalMaterial[key] && state.materialBase[key] !== undefined) {
      patch[key] = state.materialBase[key];
    }
  }
  return patch;
}

async function applyEdits() {
  if (!state.entity) { setStatus("select an entity first", "warn"); return; }
  if (viewportIsReadOnly()) { setStatus("history view is read-only", "err"); return; }
  const draft = captureDraftFromForm();
  if (!draft.transformValid) {
    setStatus("all transform fields must be finite numbers", "err");
    return;
  }

  try {
    const operations = [];
    if (state.transformEdited) {
      if (entityRecord(state.entity)?.physics?.bodyId !== undefined) {
        setStatus("transactional transforms are unavailable for physics-bearing entities", "err");
        return;
      }
      operations.push(sceneTransformOperation(state.entity, {
        position: state.base.position,
        rotation: eulerToQuaternion(...state.base.rotationDeg.map(degToRad)),
        scale: state.base.scale,
      }));
    }
    if (changed(state.tags, state.originalTags)) operations.push(sceneTagsOperation(state.entity, state.tags));
    const material = materialChanges();
    if (Object.keys(material).length > 0) operations.push(sceneMaterialOperation(state.entity, material));
    if (operations.length === 0) { setStatus("no changes to apply", "warn"); return; }
    setStatus("committing...", "info");
    await commitSceneOperations(operations);
    state.original = cloneTransform(state.base);
    state.originalTags = [...state.tags];
    state.originalMaterial = { ...state.materialBase };
    state.transformEdited = false;
    state.tagsEdited = false;
    state.materialEdited = false;
    renderInspector();
    setStatus(`committed ${operations.length} change${operations.length === 1 ? "" : "s"}`, "ok");
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    surfaceViewportWarning("take-control transaction failed", e);
    setStatus("failed: " + message, "err");
  }
}

function addTagEdit() {
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
  if (tag.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(tag)) {
    setStatus("tag contains unsupported characters", "err");
    return;
  }
  if (!captureDraftFromForm().transformValid) {
    setStatus("all transform fields must be finite numbers", "err");
    return;
  }
  state.tags = [...state.tags, tag].sort();
  state.tagsEdited = changed(state.tags, state.originalTags);
  renderInspector();
  setStatus(`staged tag ${tag}`, "info");
}

function removeTagEdit(tag) {
  if (!state.entity) {
    setStatus("select an entity first", "warn");
    return;
  }
  if (!captureDraftFromForm().transformValid) {
    setStatus("all transform fields must be finite numbers", "err");
    return;
  }
  state.tags = state.tags.filter((candidate) => candidate !== tag);
  state.tagsEdited = changed(state.tags, state.originalTags);
  renderInspector();
  setStatus(`staged removal ${tag}`, "info");
}

async function deleteEntity() {
  if (!state.entity) {
    setStatus("select an entity first", "warn");
    return;
  }
  const entity = state.entity;
  try {
    setStatus("deleting...", "info");
    await destroyEntity(entity);
    console.info("take-control destroyed", { entity });
    editorSelection.clear("delete");
  } catch (e) {
    resetWriter();
    const message = e && e.message ? e.message : String(e);
    surfaceViewportWarning("take-control delete failed", e);
    setStatus("failed: " + message, "err");
  }
}

function selectEntity(entity) {
  if (!entity) return;
  const transform = cloneTransform(DEFAULT_TRANSFORM);
  const record = entityRecord(entity);
  state.entity = entity;
  state.base = transformFromRecord(record, transform);
  state.original = cloneTransform(state.base);
  state.tags = (tagsFromRecord(record) ?? []).sort();
  state.originalTags = [...state.tags];
  state.originInput = originInputFromRecord(record);
  state.materialBase = materialBaseFromRecord(record);
  state.originalMaterial = { ...state.materialBase };
  state.transformEdited = false;
  state.tagsEdited = false;
  state.materialEdited = false;
  renderInspector();
  // Selecting an entity pops the Inspector up and focuses it if already open.
  window.liminaWindows?.open?.("inspector");
}

function clearInspectorSelection() {
  state.entity = undefined;
  state.base = cloneTransform(DEFAULT_TRANSFORM);
  state.original = cloneTransform(DEFAULT_TRANSFORM);
  state.tags = [];
  state.originalTags = [];
  state.materialBase = {};
  state.originalMaterial = {};
  state.originInput = undefined;
  state.transformEdited = false;
  state.tagsEdited = false;
  state.materialEdited = false;
  renderInspector();
}

if (inspectorBody) {
  editorSelection.subscribe(({ selectedId }) => {
    if (selectedId === undefined) clearInspectorSelection();
    else selectEntity(selectedId);
  }, { emitCurrent: true });

  playLifecycle.subscribe(syncInspectorReadOnly);
}

window.addEventListener("beforeunload", () => {
  closeWriter();
});
