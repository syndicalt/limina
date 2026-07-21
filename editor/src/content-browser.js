import { fetchCatalog, requestAsset } from "./write-client.js";
import { playLifecycle } from "./play-lifecycle.js";

export const MAX_CATALOG_ENTRIES = 20_000;
export const CONTENT_ROW_HEIGHT = 46;
const OVERSCAN_ROWS = 6;
const CATEGORIES = new Set(["prop", "dwelling", "civic", "military", "religious"]);
const SEARCH_TEXT = new WeakMap();
let browserInstance = 0;

function boundedString(value, field, max, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  const normalized = value.trim();
  if ((!optional && normalized.length === 0) || normalized.length > max) {
    throw new TypeError(`${field} must contain ${optional ? "0" : "1"}-${max} characters`);
  }
  return normalized;
}

function assetPath(value, field) {
  const path = boundedString(value, field, 1024, { optional: true });
  if (path === undefined || path === "") return undefined;
  const normalized = path.replace(/^\/+/, "");
  if (/^[a-z][a-z\d+.-]*:/i.test(normalized) || normalized.includes("\\") || normalized.split("/").includes("..") || /[\0-\x1f\x7f]/.test(normalized)) {
    throw new TypeError(`${field} must be an assets-relative path`);
  }
  return normalized;
}

function validateEntry(raw, index) {
  const prefix = `entries[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`${prefix} must be an object`);
  const id = boundedString(raw.id, `${prefix}.id`, 512);
  const title = boundedString(raw.title, `${prefix}.title`, 256);
  if (!CATEGORIES.has(raw.category)) throw new TypeError(`${prefix}.category is unsupported`);
  if (!Array.isArray(raw.boundsM) || raw.boundsM.length !== 3 || raw.boundsM.some((n) => !Number.isFinite(n) || n <= 0 || n > 100_000)) {
    throw new TypeError(`${prefix}.boundsM must contain three positive finite metre values`);
  }
  if (raw.tags !== undefined && (!Array.isArray(raw.tags) || raw.tags.length > 64)) throw new TypeError(`${prefix}.tags is invalid`);
  const tags = raw.tags?.map((tag, tagIndex) => boundedString(tag, `${prefix}.tags[${tagIndex}]`, 64)) ?? [];
  if (raw.qcTurntable !== undefined && (!Array.isArray(raw.qcTurntable) || raw.qcTurntable.length > 16)) {
    throw new TypeError(`${prefix}.qcTurntable is invalid`);
  }
  const qcTurntable = raw.qcTurntable?.map((path, pathIndex) => assetPath(path, `${prefix}.qcTurntable[${pathIndex}]`));
  let qcChecks;
  if (raw.qcChecks !== undefined) {
    if (!raw.qcChecks || typeof raw.qcChecks !== "object" || Array.isArray(raw.qcChecks)) throw new TypeError(`${prefix}.qcChecks is invalid`);
    const checks = Object.entries(raw.qcChecks);
    if (checks.length > 64 || checks.some(([key, value]) => key.length === 0 || key.length > 64 || (value !== true && value !== false && value !== null))) {
      throw new TypeError(`${prefix}.qcChecks is invalid`);
    }
    qcChecks = Object.fromEntries(checks);
  }
  const type = raw.type === undefined ? assetTypeFor({ id }) : boundedString(raw.type, `${prefix}.type`, 64);
  const qcRender = assetPath(raw.qcRender, `${prefix}.qcRender`);
  const entry = Object.freeze({
    id,
    title,
    category: raw.category,
    type,
    boundsM: Object.freeze([...raw.boundsM]),
    tags: Object.freeze(tags),
    ...(qcRender ? { qcRender } : {}),
    ...(qcTurntable ? { qcTurntable: Object.freeze(qcTurntable) } : {}),
    ...(qcChecks ? { qcChecks: Object.freeze(qcChecks) } : {}),
    ...(raw.authoredBy === undefined ? {} : { authoredBy: boundedString(raw.authoredBy, `${prefix}.authoredBy`, 128, { optional: true }) }),
  });
  SEARCH_TEXT.set(entry, `${entry.title}\n${entry.id}\n${entry.category}\n${entry.type}\n${entry.tags.join("\n")}`.toLowerCase());
  return entry;
}

export function assetTypeFor(entry) {
  const id = String(entry?.id ?? "").toLowerCase();
  if (id.startsWith("archetype:")) return "archetype";
  if (id.endsWith(".gltf")) return "gltf";
  if (id.endsWith(".glb")) return "glb";
  return "asset";
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function validateCatalogPayload(payload, maxEntries = MAX_CATALOG_ENTRIES) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) throw new TypeError("maxEntries must be a non-negative safe integer");
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.entries)) throw new TypeError("asset.catalog returned no entries array");
  if (payload.entries.length > maxEntries) throw new RangeError(`asset.catalog returned ${payload.entries.length} entries; cap is ${maxEntries}`);
  const seen = new Set();
  const entries = payload.entries.map((raw, index) => {
    const entry = validateEntry(raw, index);
    if (seen.has(entry.id)) throw new TypeError(`asset.catalog returned duplicate id ${entry.id}`);
    seen.add(entry.id);
    return entry;
  });
  const sortTitles = new Map(entries.map((entry) => [entry, entry.title.toLowerCase()]));
  entries.sort((a, b) => compareText(sortTitles.get(a), sortTitles.get(b)) || compareText(a.title, b.title) || compareText(a.id, b.id));
  return Object.freeze(entries);
}

export function filterCatalog(entries, { query = "", category = "all", type = "all" } = {}) {
  const needle = String(query).trim().toLowerCase();
  return entries.filter((entry) => {
    if (category !== "all" && entry.category !== category) return false;
    if (type !== "all" && entry.type !== type) return false;
    if (!needle) return true;
    const searchText = SEARCH_TEXT.get(entry) ?? `${entry.title}\n${entry.id}\n${entry.category}\n${entry.type}\n${entry.tags.join("\n")}`.toLowerCase();
    return searchText.includes(needle);
  });
}

export class AssetPlacementStore {
  #snapshot = Object.freeze({ entry: undefined, yaw: 0 });
  #listeners = new Set();

  get() { return this.#snapshot; }

  subscribe(listener, { emitCurrent = false } = {}) {
    if (typeof listener !== "function") throw new TypeError("placement listener must be a function");
    this.#listeners.add(listener);
    if (emitCurrent) listener(this.#snapshot);
    return () => this.#listeners.delete(listener);
  }

  arm(entry) {
    if (!entry?.id) throw new TypeError("placement asset must have an id");
    const same = this.#snapshot.entry?.id === entry.id;
    this.#set(Object.freeze({ entry, yaw: same ? this.#snapshot.yaw : 0 }));
  }

  disarm() {
    if (!this.#snapshot.entry) return;
    this.#set(Object.freeze({ entry: undefined, yaw: 0 }));
  }

  rotate(deltaRadians) {
    if (!this.#snapshot.entry || !Number.isFinite(deltaRadians)) return;
    const fullTurn = Math.PI * 2;
    const yaw = ((this.#snapshot.yaw + deltaRadians) % fullTurn + fullTurn) % fullTurn;
    this.#set(Object.freeze({ entry: this.#snapshot.entry, yaw }));
  }

  reconcile(entries) {
    const current = this.#snapshot.entry;
    if (!current) return;
    const replacement = entries.find((entry) => entry.id === current.id);
    if (!replacement) this.disarm();
    else if (replacement !== current) this.#set(Object.freeze({ entry: replacement, yaw: this.#snapshot.yaw }));
  }

  #set(snapshot) {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}

export class CatalogRefreshController {
  #load;
  #apply;
  #onError;
  #minimumIntervalMs;
  #now;
  #setTimer;
  #clearTimer;
  #lastStarted = -Infinity;
  #inFlight;
  #scheduled;
  #scheduledTimer;
  #scheduledResolve;
  #scheduledSignal;
  #scheduleGeneration = 0;
  #activeSignal;
  #queuedSignal;
  #lastCompletedSignal;
  #queued = false;

  constructor({
    load,
    apply,
    onError,
    minimumIntervalMs = 250,
    now = () => Date.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (timer) => clearTimeout(timer),
  }) {
    this.#load = load;
    this.#apply = apply;
    this.#onError = onError;
    this.#minimumIntervalMs = minimumIntervalMs;
    this.#now = now;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
  }

  request({ force = false, signal } = {}) {
    if (this.#inFlight) {
      if (signal !== undefined && (signal === this.#activeSignal || signal === this.#queuedSignal)) return this.#inFlight;
      this.#queued = true;
      this.#queuedSignal = signal;
      return this.#inFlight;
    }
    if (this.#scheduled) {
      if (signal !== undefined) this.#scheduledSignal = signal;
      if (!force) return this.#scheduled;
      const scheduled = this.#scheduled;
      const resolveScheduled = this.#scheduledResolve;
      const promotedSignal = this.#scheduledSignal;
      this.#scheduleGeneration++;
      this.#clearTimer(this.#scheduledTimer);
      this.#scheduled = undefined;
      this.#scheduledTimer = undefined;
      this.#scheduledResolve = undefined;
      this.#scheduledSignal = undefined;
      const promoted = this.request({ force: true, signal: promotedSignal });
      resolveScheduled(promoted);
      return scheduled;
    }
    if (!force && signal !== undefined && signal === this.#lastCompletedSignal) return Promise.resolve();
    const delay = force ? 0 : Math.max(0, this.#minimumIntervalMs - (this.#now() - this.#lastStarted));
    if (delay > 0) {
      if (signal !== undefined) this.#scheduledSignal = signal;
      if (!this.#scheduled) {
        const generation = ++this.#scheduleGeneration;
        this.#scheduled = new Promise((resolve) => {
          this.#scheduledResolve = resolve;
          this.#scheduledTimer = this.#setTimer(() => {
            if (generation !== this.#scheduleGeneration) return;
            this.#scheduleGeneration++;
            const scheduledSignal = this.#scheduledSignal;
            this.#scheduled = undefined;
            this.#scheduledTimer = undefined;
            this.#scheduledResolve = undefined;
            this.#scheduledSignal = undefined;
            resolve(this.request({ force: true, signal: scheduledSignal }));
          }, delay);
        });
      }
      return this.#scheduled;
    }
    this.#lastStarted = this.#now();
    this.#activeSignal = signal;
    let succeeded = false;
    this.#inFlight = Promise.resolve().then(this.#load).then(this.#apply).then((result) => {
      succeeded = true;
      return result;
    }).catch(this.#onError).finally(() => {
      if (succeeded) this.#lastCompletedSignal = this.#activeSignal;
      this.#activeSignal = undefined;
      this.#inFlight = undefined;
      if (this.#queued) {
        const queuedSignal = this.#queuedSignal;
        this.#queued = false;
        this.#queuedSignal = undefined;
        void this.request({ signal: queuedSignal });
      }
    });
    return this.#inFlight;
  }
}

export const assetPlacement = new AssetPlacementStore();

function option(value, label = value) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  return node;
}

function thumbnail(entry, className = "content-thumb") {
  const box = document.createElement("span");
  box.className = className;
  const fallback = document.createElement("span");
  fallback.className = "content-thumb-fallback";
  fallback.textContent = "3D";
  fallback.setAttribute("role", "img");
  fallback.setAttribute("aria-label", `No preview available for ${entry.title}`);
  box.appendChild(fallback);
  if (entry.qcRender) {
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.src = "/assets/" + entry.qcRender;
    image.addEventListener("load", () => { fallback.hidden = true; });
    image.addEventListener("error", () => { image.remove(); fallback.hidden = false; });
    box.appendChild(image);
  }
  return box;
}

function textPair(label, value) {
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.textContent = value;
  return [term, detail];
}

export function createContentBrowser(root, {
  loadCatalog = fetchCatalog,
  placement = assetPlacement,
  requestAssetFn = requestAsset,
  maxEntries = MAX_CATALOG_ENTRIES,
} = {}) {
  if (!root) throw new TypeError("content browser root is required");
  const state = { entries: [], filtered: [], query: "", category: "all", type: "all", selectedId: undefined, phase: "idle", authoringLocked: playLifecycle.isAuthoringLocked() };
  let entriesById = new Map();
  const optionIdPrefix = `content-option-${++browserInstance}-`;

  const shell = document.createElement("div");
  shell.className = "content-browser-shell";
  const toolbar = document.createElement("div");
  toolbar.className = "content-toolbar";
  const search = document.createElement("input");
  search.type = "search";
  search.className = "content-search";
  search.placeholder = "Search assets";
  search.setAttribute("aria-label", "Search assets");
  const category = document.createElement("select");
  category.setAttribute("aria-label", "Filter by category");
  const type = document.createElement("select");
  type.setAttribute("aria-label", "Filter by type");
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "content-icon-button";
  refresh.textContent = "↻";
  refresh.setAttribute("aria-label", "Refresh asset catalog");
  refresh.title = "Refresh asset catalog";
  toolbar.append(search, category, type, refresh);

  const status = document.createElement("div");
  status.className = "content-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "btn btn-small btn-ghost";
  retry.textContent = "Retry";
  retry.hidden = true;
  status.appendChild(retry);

  const list = document.createElement("div");
  list.className = "content-list";
  list.tabIndex = 0;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Asset catalog");
  const spacer = document.createElement("div");
  spacer.className = "content-list-spacer";
  const layer = document.createElement("div");
  layer.className = "content-list-layer";
  list.append(spacer, layer);

  const detail = document.createElement("section");
  detail.className = "content-detail";
  detail.setAttribute("aria-label", "Selected asset details");
  const footer = document.createElement("div");
  footer.className = "content-footer";
  const armed = document.createElement("span");
  armed.className = "content-armed";
  const newAsset = document.createElement("button");
  newAsset.type = "button";
  newAsset.className = "btn btn-small";
  newAsset.textContent = "New asset";
  footer.append(armed, newAsset);
  shell.append(toolbar, status, list, detail, footer);
  root.replaceChildren(shell);

  function setSelectOptions(select, values, allLabel, selected) {
    select.replaceChildren(option("all", allLabel), ...values.map((value) => option(value)));
    select.value = values.includes(selected) ? selected : "all";
  }

  function renderStatus(message, error = false) {
    status.classList.toggle("content-status-error", error);
    status.replaceChildren();
    const label = document.createElement("span");
    label.textContent = message;
    status.appendChild(label);
    if (error) status.appendChild(retry);
    retry.hidden = !error;
  }

  function selectedEntry() { return entriesById.get(state.selectedId); }

  function renderDetail() {
    const entry = selectedEntry();
    detail.replaceChildren();
    if (!entry) {
      const empty = document.createElement("span");
      empty.className = "muted";
      empty.textContent = "Select an asset to inspect it";
      detail.appendChild(empty);
      return;
    }
    const preview = thumbnail(entry, "content-detail-thumb");
    const body = document.createElement("div");
    body.className = "content-detail-body";
    const heading = document.createElement("strong");
    heading.textContent = entry.title;
    const metadata = document.createElement("dl");
    metadata.append(
      ...textPair("ID", entry.id),
      ...textPair("Category", entry.category),
      ...textPair("Type", entry.type),
      ...textPair("Bounds", entry.boundsM.map((n) => `${n}m`).join(" x ")),
      ...textPair("Author", entry.authoredBy || "unknown"),
      ...textPair("Tags", entry.tags.length ? entry.tags.join(", ") : "none"),
    );
    body.append(heading, metadata);
    detail.append(preview, body);
  }

  function activate(entry) {
    if (state.authoringLocked) return;
    state.selectedId = entry.id;
    if (placement.get().entry?.id === entry.id) placement.disarm();
    else placement.arm(entry);
    renderWindow();
    renderDetail();
  }

  // Drag-drop arming (2.0-C): the viewport canvas places the armed entry on
  // drop. Arming at dragstart (not drop) gives the ghost preview mid-drag.
  function createRow(entry, index) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "content-asset-row";
    row.id = optionIdPrefix + index;
    row.tabIndex = -1;
    row.draggable = true;
    row.addEventListener("dragstart", (event) => {
      if (state.authoringLocked) { event.preventDefault(); return; }
      event.dataTransfer?.setData("text/limina-asset", entry.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
      placement.arm(entry);
      renderWindow();
    });
    row.dataset.assetId = entry.id;
    row.style.transform = `translateY(${index * CONTENT_ROW_HEIGHT}px)`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(state.selectedId === entry.id));
    row.setAttribute("aria-disabled", String(state.authoringLocked));
    row.disabled = state.authoringLocked;
    row.classList.toggle("selected", state.selectedId === entry.id);
    row.classList.toggle("armed", placement.get().entry?.id === entry.id);
    const image = thumbnail(entry);
    const label = document.createElement("span");
    label.className = "content-asset-label";
    const titleLabel = document.createElement("strong");
    titleLabel.textContent = entry.title;
    const meta = document.createElement("small");
    meta.textContent = `${entry.category} / ${entry.type}`;
    label.append(titleLabel, meta);
    row.append(image, label);
    row.addEventListener("click", () => activate(entry));
    return row;
  }

  function renderWindow() {
    const height = list.clientHeight || 280;
    const start = Math.max(0, Math.floor(list.scrollTop / CONTENT_ROW_HEIGHT) - OVERSCAN_ROWS);
    const end = Math.min(state.filtered.length, Math.ceil((list.scrollTop + height) / CONTENT_ROW_HEIGHT) + OVERSCAN_ROWS);
    spacer.style.height = `${state.filtered.length * CONTENT_ROW_HEIGHT}px`;
    const rows = [];
    for (let index = start; index < end; index++) rows.push(createRow(state.filtered[index], index));
    layer.replaceChildren(...rows);
    const selectedIndex = state.filtered.findIndex((entry) => entry.id === state.selectedId);
    if (selectedIndex >= start && selectedIndex < end) list.setAttribute("aria-activedescendant", optionIdPrefix + selectedIndex);
    else list.removeAttribute("aria-activedescendant");
  }

  function applyFilters() {
    state.filtered = filterCatalog(state.entries, state);
    list.scrollTop = 0;
    renderWindow();
    if (state.phase === "ready") {
      const message = state.entries.length === 0
        ? "No approved assets have been published"
        : state.filtered.length === 0
          ? "No assets match the current filters"
          : `${state.filtered.length} of ${state.entries.length} assets`;
      renderStatus(message);
    }
  }

  function applyCatalog(payload) {
    const entries = validateCatalogPayload(payload, maxEntries);
    state.entries = entries;
    entriesById = new Map(entries.map((entry) => [entry.id, entry]));
    state.phase = "ready";
    if (state.selectedId && !entries.some((entry) => entry.id === state.selectedId)) state.selectedId = undefined;
    placement.reconcile(entries);
    setSelectOptions(category, [...new Set(entries.map((entry) => entry.category))].sort(compareText), "All categories", state.category);
    setSelectOptions(type, [...new Set(entries.map((entry) => entry.type))].sort(compareText), "All types", state.type);
    state.category = category.value;
    state.type = type.value;
    applyFilters();
    renderDetail();
  }

  function onCatalogError(error) {
    state.phase = "error";
    const message = String(error?.message ?? error).slice(0, 300);
    renderStatus(`Catalog unavailable: ${message}`, true);
  }

  const refresher = new CatalogRefreshController({
    load: async () => {
      state.phase = "loading";
      renderStatus(state.entries.length ? "Refreshing assets..." : "Loading assets...");
      return loadCatalog();
    },
    apply: applyCatalog,
    onError: onCatalogError,
  });

  search.addEventListener("input", () => { state.query = search.value; applyFilters(); });
  category.addEventListener("change", () => { state.category = category.value; applyFilters(); });
  type.addEventListener("change", () => { state.type = type.value; applyFilters(); });
  refresh.addEventListener("click", () => { void refresher.request({ force: true }); });
  retry.addEventListener("click", () => { void refresher.request({ force: true }); });
  list.addEventListener("scroll", renderWindow, { passive: true });
  list.addEventListener("keydown", (event) => {
    if (!state.filtered.length || !["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    const current = state.filtered.findIndex((entry) => entry.id === state.selectedId);
    let index = current;
    if (event.key === "ArrowDown") index = current < 0 ? 0 : Math.min(state.filtered.length - 1, current + 1);
    else if (event.key === "ArrowUp") index = current < 0 ? state.filtered.length - 1 : Math.max(0, current - 1);
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = state.filtered.length - 1;
    else { activate(state.filtered[current < 0 ? 0 : current]); return; }
    state.selectedId = state.filtered[index].id;
    list.scrollTop = Math.max(0, Math.min(index * CONTENT_ROW_HEIGHT, (index + 1) * CONTENT_ROW_HEIGHT - list.clientHeight));
    renderWindow();
    renderDetail();
  });
  const unsubscribe = placement.subscribe((snapshot) => {
    armed.textContent = snapshot.entry ? `Armed: ${snapshot.entry.title}` : "Placement not armed";
    armed.classList.toggle("active", !!snapshot.entry);
    renderWindow();
  }, { emitCurrent: true });

  function showNewAssetDialog() {
    const dialog = document.createElement("dialog");
    dialog.className = "content-request-dialog";
    const form = document.createElement("form");
    form.method = "dialog";
    const heading = document.createElement("h3");
    heading.textContent = "New asset request";
    const description = document.createElement("textarea");
    description.required = true;
    description.minLength = 3;
    description.maxLength = 2_000;
    description.rows = 4;
    description.placeholder = "Describe the production asset";
    description.setAttribute("aria-label", "Asset description");
    const requestCategory = document.createElement("select");
    requestCategory.setAttribute("aria-label", "Asset category");
    requestCategory.append(...[...CATEGORIES].map((value) => option(value)));
    const actions = document.createElement("div");
    actions.className = "content-dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-ghost";
    cancel.textContent = "Cancel";
    const send = document.createElement("button");
    send.type = "submit";
    send.className = "btn";
    send.textContent = "Send to architect";
    actions.append(cancel, send);
    form.append(heading, description, requestCategory, actions);
    dialog.appendChild(form);
    document.body.appendChild(dialog);
    const close = () => { dialog.close?.(); dialog.remove(); };
    cancel.addEventListener("click", close);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = description.value.trim();
      if (text.length < 3) { description.reportValidity(); return; }
      send.disabled = true;
      try {
        await requestAssetFn(text, requestCategory.value);
        close();
        window.dispatchEvent(new CustomEvent("limina:toast", { detail: { message: "Asset request sent to the architect", kind: "ok" } }));
      } catch (error) {
        send.disabled = false;
        const message = String(error?.message ?? error).slice(0, 300);
        window.dispatchEvent(new CustomEvent("limina:toast", { detail: { message: `Asset request failed: ${message}`, kind: "error" } }));
      }
    });
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    description.focus();
  }

  newAsset.addEventListener("click", showNewAssetDialog);
  const unsubscribePlay = playLifecycle.subscribe(({ authoringLocked }) => {
    state.authoringLocked = authoringLocked;
    newAsset.disabled = authoringLocked;
    shell.classList.toggle("authoring-locked", authoringLocked);
    renderWindow();
  }, { emitCurrent: true });
  renderStatus("Open Content Browser to load assets");
  renderDetail();

  const onWindowOpen = () => { void refresher.request({ signal: "window-open" }); };
  root.closest?.("#content-browser")?.addEventListener("limina:window-open", onWindowOpen);
  return Object.freeze({
    refresh(options) { return refresher.request(options); },
    stateSnapshot() { return { ...state, entries: [...state.entries], filtered: [...state.filtered] }; },
    destroy() {
      unsubscribe();
      unsubscribePlay();
      root.closest?.("#content-browser")?.removeEventListener("limina:window-open", onWindowOpen);
      root.replaceChildren();
    },
  });
}

const browserRoot = globalThis.document?.getElementById?.("content-browser-root");
export const contentBrowser = browserRoot ? createContentBrowser(browserRoot) : undefined;

export function requestCatalogRefresh(reason, options) {
  return contentBrowser?.refresh({ ...options, signal: reason }) ?? Promise.resolve();
}

export function openContentBrowser() {
  const open = globalThis.window?.liminaWindows?.open;
  if (open) {
    open("content-browser");
    return Promise.resolve();
  }
  return requestCatalogRefresh("window-open");
}

if (browserRoot) {
  document.getElementById("content-browser-toggle")?.addEventListener("click", () => { void openContentBrowser(); });
}
