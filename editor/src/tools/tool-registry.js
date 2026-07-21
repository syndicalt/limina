// Tool Contract registry (Editor 2.0, D2): every tool in every surface is a
// declarative registration. The ribbon, options bar, cursor, and shortcuts are
// GENERATED from these schemas — option-contract drift between sibling tools (the
// old Atlas's "elevation has no radius readout, land has no strength" class of
// bug) is impossible by construction because options are declared once and
// rendered once.
//
// The registry validates and orders; the CONTROLLER owns per-surface state
// (active tool + option values, persisted); the builders generate DOM and
// subscribe to the controller. Commit is never the registry's business — a
// tool's commit fn belongs to its surface.

export const TOOL_GROUPS = Object.freeze(["select", "terrain", "paint", "water", "line", "place", "structure", "measure"]);
export const SURFACES = Object.freeze(["atlas", "viewport"]);
const CURSORS = new Set(["default", "brush", "crosshair", "pan"]);
const GESTURES = new Set(["stroke", "click", "drag", "poly", "lasso", "none"]);
// The Atlas surface's persistence key (viewport uses its own — see
// viewport-tools.js). Exported so surfaces restore their snapshots on boot.
export const DEFAULT_STORAGE_KEY = "limina.studio.tool-options/v1";

const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v)
  && Object.getPrototypeOf(v) === Object.prototype && Object.getOwnPropertySymbols(v).length === 0;
const isId = (v) => typeof v === "string" && v.length > 0;

function validateOption(key, option) {
  if (!isPlainObject(option)) throw new TypeError(`tool option "${key}" must be a plain object`);
  const kinds = ["range", "enum", "toggle", "color"];
  if (!kinds.includes(option.kind)) throw new TypeError(`tool option "${key}" kind must be one of ${kinds.join(",")}`);
  if (option.kind === "range") {
    if (!Number.isFinite(option.min) || !Number.isFinite(option.max) || !(option.min < option.max)) {
      throw new TypeError(`tool option "${key}": range requires min < max`);
    }
    if (!Number.isFinite(option.def) || option.def < option.min || option.def > option.max) {
      throw new TypeError(`tool option "${key}": def outside [min,max]`);
    }
    if (option.step !== undefined && (!Number.isFinite(option.step) || option.step <= 0)) {
      throw new TypeError(`tool option "${key}": step must be > 0`);
    }
    if (option.unit !== undefined && typeof option.unit !== "string") throw new TypeError(`tool option "${key}": unit must be a string`);
  } else if (option.kind === "enum") {
    if (!Array.isArray(option.values) || option.values.length === 0) throw new TypeError(`tool option "${key}": enum values must be non-empty`);
    for (const v of option.values) {
      if (!isPlainObject(v) || !isId(v.id) || typeof v.label !== "string") throw new TypeError(`tool option "${key}": enum values need {id,label}`);
    }
    if (!option.values.some((v) => v.id === option.def)) throw new TypeError(`tool option "${key}": def must name a value`);
  } else if (option.kind === "toggle") {
    if (typeof option.def !== "boolean") throw new TypeError(`tool option "${key}": toggle def must be boolean`);
    if (typeof option.label !== "string") throw new TypeError(`tool option "${key}": toggle label must be a string`);
  } else if (option.kind === "color") {
    if (!Array.isArray(option.values) || option.values.length === 0 || !option.values.every((v) => typeof v === "string")) {
      throw new TypeError(`tool option "${key}": color values must be non-empty strings`);
    }
    if (!option.values.includes(option.def)) throw new TypeError(`tool option "${key}": def must be one of values`);
  }
}

function validateDescriptor(d) {
  if (!isPlainObject(d)) throw new TypeError("tool descriptor must be a plain object");
  const allowed = ["id", "group", "title", "icon", "surfaces", "cursor", "gesture", "options", "shortcuts", "commit", "hint"];
  for (const k of Object.keys(d)) {
    if (!allowed.includes(k)) throw new TypeError(`tool descriptor does not allow key "${k}"`);
  }
  if (!isId(d.id) || !d.id.includes(".")) throw new TypeError("tool id must be 'group.name'");
  if (!TOOL_GROUPS.includes(d.group)) throw new Error(`unknown tool group "${d.group}"`);
  if (d.id.split(".")[0] !== d.group) throw new TypeError(`tool id "${d.id}" prefix must equal its group`);
  if (typeof d.title !== "string" || d.title.length === 0) throw new TypeError(`tool "${d.id}" title must be non-empty`);
  if (typeof d.icon !== "string" || [...d.icon].length !== 1) throw new TypeError(`tool "${d.id}" icon must be a single grapheme`);
  if (!Array.isArray(d.surfaces) || d.surfaces.length === 0 || !d.surfaces.every((s) => SURFACES.includes(s))) {
    throw new TypeError(`tool "${d.id}" surfaces must be a non-empty subset of SURFACES`);
  }
  if (!CURSORS.has(d.cursor)) throw new TypeError(`tool "${d.id}" cursor is invalid`);
  if (!GESTURES.has(d.gesture)) throw new TypeError(`tool "${d.id}" gesture is invalid`);
  if (d.options !== undefined) {
    if (!isPlainObject(d.options)) throw new TypeError(`tool "${d.id}" options must be a plain object`);
    for (const [k, o] of Object.entries(d.options)) validateOption(k, o);
  }
  if (d.shortcuts !== undefined && (!Array.isArray(d.shortcuts) || !d.shortcuts.every((s) => typeof s === "string" && [...s].length === 1))) {
    throw new TypeError(`tool "${d.id}" shortcuts must be single-character strings`);
  }
  if (typeof d.commit !== "function") throw new TypeError(`tool "${d.id}" commit must be a function`);
  if (d.hint !== undefined && typeof d.hint !== "string") throw new TypeError(`tool "${d.id}" hint must be a string`);
}

export function createToolRegistry() {
  const tools = new Map();
  return Object.freeze({
    register(descriptor) {
      validateDescriptor(descriptor);
      if (tools.has(descriptor.id)) throw new Error(`duplicate tool "${descriptor.id}"`);
      const frozen = Object.freeze({
        ...descriptor,
        surfaces: Object.freeze([...descriptor.surfaces]),
        options: descriptor.options === undefined ? undefined : Object.freeze({ ...descriptor.options }),
        shortcuts: descriptor.shortcuts === undefined ? undefined : Object.freeze([...descriptor.shortcuts]),
      });
      tools.set(frozen.id, frozen);
      return frozen;
    },
    get: (id) => tools.get(id),
    forSurface(surface) {
      if (!SURFACES.includes(surface)) throw new Error(`unknown surface "${surface}"`);
      const order = new Map(TOOL_GROUPS.map((g, i) => [g, i]));
      return [...tools.values()]
        .filter((t) => t.surfaces.includes(surface))
        .sort((a, b) => order.get(a.group) - order.get(b.group));
    },
  });
}

export function createToolController({ registry, surface, storage, storageKey = DEFAULT_STORAGE_KEY, onActiveChange, onOptionChange }) {
  if (registry === null || typeof registry !== "object" || typeof registry.forSurface !== "function") {
    throw new TypeError("tool controller requires a tool registry");
  }
  if (!SURFACES.includes(surface)) throw new Error(`unknown surface "${surface}"`);
  if (storage !== undefined && (typeof storage.load !== "function" || typeof storage.save !== "function")) {
    throw new TypeError("tool controller storage must provide load(key)/save(key,value)");
  }

  const surfaceTools = registry.forSurface(surface);
  let activeId = surfaceTools[0]?.id ?? null;
  const values = new Map(); // toolId -> {optionKey: value}
  const activeListeners = new Set();
  const optionListeners = new Set();
  if (onActiveChange !== undefined) {
    if (typeof onActiveChange !== "function") throw new TypeError("onActiveChange must be a function");
    activeListeners.add(onActiveChange);
  }
  if (onOptionChange !== undefined) {
    if (typeof onOptionChange !== "function") throw new TypeError("onOptionChange must be a function");
    optionListeners.add(onOptionChange);
  }
  const fireActive = (tool) => { for (const fn of activeListeners) fn(tool); };
  const fireOption = (toolId, key, value) => { for (const fn of optionListeners) fn(toolId, key, value); };

  const defaultsFor = (tool) => {
    const out = {};
    for (const [k, o] of Object.entries(tool.options ?? {})) out[k] = o.def;
    return out;
  };
  const commit = () => {
    if (storage !== undefined) storage.save(storageKey, state());
  };

  function coerce(tool, key, value) {
    const schema = tool.options?.[key];
    if (schema === undefined) throw new Error(`tool "${tool.id}" has no option "${key}"`);
    if (schema.kind === "range") {
      if (!Number.isFinite(value)) throw new TypeError(`option "${key}" must be a finite number`);
      let v = Math.min(schema.max, Math.max(schema.min, value));
      if (schema.step !== undefined) v = schema.min + Math.round((v - schema.min) / schema.step) * schema.step;
      return Math.min(schema.max, Math.max(schema.min, v));
    }
    if (schema.kind === "enum") {
      if (!schema.values.some((entry) => entry.id === value)) throw new TypeError(`option "${key}" must name a value`);
      return value;
    }
    if (schema.kind === "toggle") return value === true;
    if (!schema.values.includes(value)) throw new TypeError(`option "${key}" must be one of values`);
    return value;
  }

  function state() {
    const out = {};
    for (const [toolId, opts] of values) out[toolId] = { ...opts };
    return { activeId, values: out };
  }

  return Object.freeze({
    activeId: () => activeId,
    activeTool: () => (activeId === null ? undefined : registry.get(activeId)),
    tools: () => surfaceTools,
    setActiveTool(id) {
      const tool = registry.get(id);
      if (tool === undefined) throw new Error(`unknown tool "${id}"`);
      if (!tool.surfaces.includes(surface)) throw new Error(`tool "${id}" is not available on surface "${surface}"`);
      if (id === activeId) return;
      activeId = id;
      commit();
      fireActive(tool);
    },
    option(toolId, key) {
      const tool = registry.get(toolId);
      if (tool === undefined) throw new Error(`unknown tool "${toolId}"`);
      const stored = values.get(toolId);
      if (stored !== undefined && key in stored) return stored[key];
      const schema = tool.options?.[key];
      if (schema === undefined) throw new Error(`tool "${toolId}" has no option "${key}"`);
      return schema.def;
    },
    setOption(toolId, key, value) {
      const tool = registry.get(toolId);
      if (tool === undefined) throw new Error(`unknown tool "${toolId}"`);
      const coerced = coerce(tool, key, value);
      const stored = values.get(toolId) ?? defaultsFor(tool);
      stored[key] = coerced;
      values.set(toolId, stored);
      commit();
      fireOption(toolId, key, coerced);
      return coerced;
    },
    /** Generated views subscribe here; returns an unsubscribe function. */
    subscribe(hooks) {
      if (!isPlainObject(hooks)) throw new TypeError("subscribe requires a hooks object");
      if (hooks.onActiveChange !== undefined) {
        if (typeof hooks.onActiveChange !== "function") throw new TypeError("onActiveChange must be a function");
        activeListeners.add(hooks.onActiveChange);
      }
      if (hooks.onOptionChange !== undefined) {
        if (typeof hooks.onOptionChange !== "function") throw new TypeError("onOptionChange must be a function");
        optionListeners.add(hooks.onOptionChange);
      }
      return () => {
        if (hooks.onActiveChange !== undefined) activeListeners.delete(hooks.onActiveChange);
        if (hooks.onOptionChange !== undefined) optionListeners.delete(hooks.onOptionChange);
      };
    },
    state,
    restore(snapshot) {
      if (!isPlainObject(snapshot)) throw new TypeError("tool controller snapshot must be a plain object");
      for (const k of Object.keys(snapshot)) {
        if (!["activeId", "values"].includes(k)) throw new TypeError(`snapshot does not allow key "${k}"`);
      }
      if (snapshot.activeId !== null && registry.get(snapshot.activeId) === undefined) {
        throw new Error(`snapshot names unknown tool "${snapshot.activeId}"`);
      }
      if (!isPlainObject(snapshot.values)) throw new TypeError("snapshot values must be a plain object");
      const next = new Map();
      for (const [toolId, opts] of Object.entries(snapshot.values)) {
        const tool = registry.get(toolId);
        if (tool === undefined) throw new Error(`snapshot names unknown tool "${toolId}"`);
        if (!isPlainObject(opts)) throw new TypeError(`snapshot values for "${toolId}" must be a plain object`);
        const merged = defaultsFor(tool);
        for (const [k, v] of Object.entries(opts)) merged[k] = coerce(tool, k, v);
        next.set(toolId, merged);
      }
      activeId = snapshot.activeId;
      values.clear();
      for (const [k, v] of next) values.set(k, v);
      commit();
    },
  });
}

// ── Generated views. Exactly one ribbon / options bar per controller (building
// twice throws — two views bound to one controller would fight over rebuilds).

const ribbonControllers = new WeakSet();
const optionsControllers = new WeakSet();

/** .tool-ribbon with one .tool-group per group that has surface tools. */
export function buildToolRibbon(controller, { document: doc } = {}) {
  if (doc === undefined) throw new TypeError("buildToolRibbon requires a document");
  if (ribbonControllers.has(controller)) throw new Error("this controller already drives a tool ribbon");
  ribbonControllers.add(controller);
  const root = doc.createElement("div");
  root.className = "tool-ribbon";
  const byGroup = new Map();
  for (const tool of controller.tools()) {
    if (!byGroup.has(tool.group)) byGroup.set(tool.group, []);
    byGroup.get(tool.group).push(tool);
  }
  const markActive = () => {
    for (const btn of root.querySelectorAll(".tool-btn")) {
      btn.classList.toggle("active", btn.dataset.tool === controller.activeId());
    }
  };
  for (const [, groupTools] of byGroup) {
    const groupEl = doc.createElement("div");
    groupEl.className = "tool-group";
    for (const tool of groupTools) {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "tool-btn";
      btn.dataset.tool = tool.id;
      btn.title = `${tool.title} (${tool.hint ?? tool.id})`;
      const icon = doc.createElement("span");
      icon.textContent = tool.icon;
      btn.appendChild(icon);
      const label = doc.createElement("span");
      label.className = "tool-label";
      label.textContent = tool.title;
      btn.appendChild(label);
      btn.addEventListener("click", () => controller.setActiveTool(tool.id));
      groupEl.appendChild(btn);
    }
    root.appendChild(groupEl);
  }
  markActive();
  controller.subscribe({ onActiveChange: () => markActive() });
  return root;
}

function formatRange(value, schema) {
  const rounded = schema.step !== undefined && schema.step < 1 ? value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "") : String(Math.round(value));
  return schema.unit !== undefined ? `${rounded}${schema.unit}` : rounded;
}

/** .tool-options generated from the active tool's option schema. */
export function buildOptionsBar(controller, { document: doc } = {}) {
  if (doc === undefined) throw new TypeError("buildOptionsBar requires a document");
  if (optionsControllers.has(controller)) throw new Error("this controller already drives an options bar");
  optionsControllers.add(controller);
  const root = doc.createElement("div");
  root.className = "tool-options";

  function rebuild() {
    root.replaceChildren();
    const tool = controller.activeTool();
    if (tool === undefined) return;
    for (const [key, schema] of Object.entries(tool.options ?? {})) {
      const field = doc.createElement("div");
      field.className = "opt-field";
      const name = doc.createElement("span");
      name.className = "opt-name";
      name.textContent = key;
      field.appendChild(name);
      if (schema.kind === "range") {
        const slider = doc.createElement("input");
        slider.type = "range";
        slider.className = "opt-slider";
        slider.min = String(schema.min);
        slider.max = String(schema.max);
        if (schema.step !== undefined) slider.step = String(schema.step);
        slider.value = String(controller.option(tool.id, key));
        const readout = doc.createElement("span");
        readout.className = "opt-value";
        readout.textContent = formatRange(controller.option(tool.id, key), schema);
        slider.addEventListener("input", () => {
          const v = controller.setOption(tool.id, key, Number(slider.value));
          readout.textContent = formatRange(v, schema);
        });
        field.appendChild(slider);
        field.appendChild(readout);
      } else if (schema.kind === "enum") {
        const segs = doc.createElement("div");
        segs.className = "opt-segs";
        for (const entry of schema.values) {
          const btn = doc.createElement("button");
          btn.type = "button";
          btn.className = "seg-btn";
          btn.textContent = entry.label;
          btn.classList.toggle("active", controller.option(tool.id, key) === entry.id);
          btn.addEventListener("click", () => {
            controller.setOption(tool.id, key, entry.id);
            for (const other of segs.querySelectorAll(".seg-btn")) other.classList.toggle("active", other === btn);
          });
          segs.appendChild(btn);
        }
        field.appendChild(segs);
      } else if (schema.kind === "toggle") {
        const box = doc.createElement("input");
        box.type = "checkbox";
        box.checked = controller.option(tool.id, key);
        box.addEventListener("change", () => controller.setOption(tool.id, key, box.checked));
        field.appendChild(box);
        const label = doc.createElement("span");
        label.textContent = schema.label;
        field.appendChild(label);
      } else if (schema.kind === "color") {
        for (const color of schema.values) {
          const swatch = doc.createElement("button");
          swatch.type = "button";
          swatch.className = "opt-swatch";
          swatch.style.background = color;
          swatch.title = color;
          swatch.classList.toggle("active", controller.option(tool.id, key) === color);
          swatch.addEventListener("click", () => {
            controller.setOption(tool.id, key, color);
            for (const other of field.querySelectorAll(".opt-swatch")) other.classList.toggle("active", other === swatch);
          });
          field.appendChild(swatch);
        }
      }
      root.appendChild(field);
    }
  }
  rebuild();
  controller.subscribe({ onActiveChange: () => rebuild() });
  return root;
}

/** `[`/`]` adjust the active tool's radius option; digits select surface tools.
 *  Events on `target`; ignored from form fields. Returns a cleanup function. */
export function bindBrushKeys(controller, { target } = {}) {
  if (target === undefined || typeof target.addEventListener !== "function") {
    throw new TypeError("bindBrushKeys requires an event target");
  }
  const isFormField = (el) => {
    const tag = el?.tagName?.toLowerCase?.();
    return tag === "input" || tag === "textarea" || tag === "select" || el?.isContentEditable === true;
  };
  const onKey = (event) => {
    if (isFormField(event.target)) return;
    const tool = controller.activeTool();
    if (event.key === "[" || event.key === "]") {
      if (tool === undefined || tool.options?.radius === undefined) return;
      const schema = tool.options.radius;
      const step = schema.step ?? Math.max(1, (schema.max - schema.min) / 40);
      const delta = event.key === "[" ? -step : step;
      controller.setOption(tool.id, "radius", controller.option(tool.id, "radius") + delta);
      event.preventDefault();
      return;
    }
    if (event.key >= "1" && event.key <= "9") {
      const index = Number(event.key) - 1;
      const tools = controller.tools();
      if (index < tools.length) {
        controller.setActiveTool(tools[index].id);
        event.preventDefault();
      }
    }
  };
  target.addEventListener("keydown", onKey);
  return () => target.removeEventListener("keydown", onKey);
}
