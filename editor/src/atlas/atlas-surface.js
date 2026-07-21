// Atlas surface (Editor 2.0, D1+D2): the native 2D authoring surface — tool
// ribbon + generated options bar (Tool Contract), canvas stage with pan/zoom,
// brush strokes through the shared kernels, undo commands through the atlas
// command stack, CAS-debounced saves through the design API, and a layer rail.
//
// Commit discipline: every mutation is (a) a dab against the live raster, (b) one
// undo command per STROKE (bbox union of its dabs), (c) one debounced CAS save.
// Nothing here writes the doc outside those three steps — a mutation outside the
// command layer is a bug, matching the 2.0-A gate.

import { DEFAULT_STORAGE_KEY, createToolController, createToolRegistry, buildOptionsBar, buildToolRibbon, bindBrushKeys } from "../tools/tool-registry.js";
import { bboxUnion, cmdPatchRaster, cmdSetMapProp, createUndoStack, snapshotBBox } from "./atlas-commands.js";
import { decodeMap, ensureBiomes, ensureElevation, ensureLandmass, syncRastersIntoDoc, BIOME_CLASSES } from "./atlas-doc.js";
import { biomeDab, elevationDab, landDab, valToY } from "./paint-kernels.js";
import { compositeRasters } from "./atlas-render.js";
import { closeRing, featureId, makeStamp, makeWaterBody, smoothDrawnPolyline, validateWaterBodies } from "./atlas-features.js";
import { hitTest, lassoHits } from "./atlas-hit-test.js";

const SAVE_DEBOUNCE_MS = 750;

function atlasToolRegistry() {
  const registry = createToolRegistry();
  registry.register({
    id: "select.pick", group: "select", title: "Select", icon: "➤",
    surfaces: ["atlas"], cursor: "default", gesture: "click",
    hint: "click to pick · Delete removes · drag empty space to pan",
    commit: () => {},
  });
  registry.register({
    id: "select.lasso", group: "select", title: "Lasso", icon: "▢",
    surfaces: ["atlas"], cursor: "crosshair", gesture: "drag",
    hint: "drag a rect — everything inside is deleted",
    commit: () => {},
  });
  registry.register({
    id: "terrain.land", group: "terrain", title: "Land", icon: "🏝",
    surfaces: ["atlas"], cursor: "brush", gesture: "stroke",
    hint: "paint landmass ([ ] resize)",
    options: {
      mode: { kind: "enum", values: [{ id: "land", label: "Raise" }, { id: "ocean", label: "Carve" }], def: "land" },
      radius: { kind: "range", min: 10, max: 400, step: 5, def: 60, unit: "m" },
      strength: { kind: "range", min: 1, max: 8, step: 0.5, def: 4, unit: "×" },
      falloff: {
        kind: "enum",
        values: [
          { id: "cos2", label: "Cos²" },
          { id: "smoothstep", label: "Smooth" },
          { id: "linear", label: "Linear" },
          { id: "sharp", label: "Sharp" },
        ],
        def: "cos2",
      },
    },
    commit: () => {},
  });
  registry.register({
    id: "terrain.elev", group: "terrain", title: "Elev", icon: "⛰",
    surfaces: ["atlas"], cursor: "brush", gesture: "stroke",
    hint: "sculpt elevation ([ ] resize, Alt-click samples)",
    options: {
      mode: {
        kind: "enum",
        values: [
          { id: "raise", label: "Raise" },
          { id: "lower", label: "Lower" },
          { id: "smooth", label: "Smooth" },
          { id: "flatten", label: "Flatten" },
          { id: "level", label: "Level" },
          { id: "noise", label: "Noise" },
        ],
        def: "raise",
      },
      radius: { kind: "range", min: 2, max: 200, step: 2, def: 30, unit: "m" },
      strength: { kind: "range", min: 0.05, max: 1, step: 0.05, def: 0.4 },
      levelY: { kind: "range", min: -12, max: 120, step: 1, def: 10, unit: "m" },
      falloff: {
        kind: "enum",
        values: [
          { id: "cos2", label: "Cos²" },
          { id: "smoothstep", label: "Smooth" },
          { id: "linear", label: "Linear" },
          { id: "sharp", label: "Sharp" },
        ],
        def: "cos2",
      },
    },
    commit: () => {},
  });
  registry.register({
    id: "paint.biome", group: "paint", title: "Biome", icon: "🖌",
    surfaces: ["atlas"], cursor: "brush", gesture: "stroke",
    hint: "paint biome class ([ ] resize)",
    options: {
      class: {
        kind: "enum",
        values: [...BIOME_CLASSES.map((c) => ({ id: c, label: c })), { id: "erase", label: "erase" }],
        def: "grass",
      },
      radius: { kind: "range", min: 8, max: 300, step: 4, def: 48, unit: "m" },
    },
    commit: () => {},
  });
  registry.register({
    id: "water.basin", group: "water", title: "Basin", icon: "◯",
    surfaces: ["atlas"], cursor: "crosshair", gesture: "poly",
    hint: "click points, double-click to close (Esc cancels)",
    options: {
      kind: {
        kind: "enum",
        values: ["lake", "pond", "lagoon", "marsh", "reservoir", "estuary"].map((k) => ({ id: k, label: k })),
        def: "lake",
      },
      level: { kind: "range", min: -12, max: 12, step: 0.5, def: 0, unit: "m" },
      depth: { kind: "range", min: 2, max: 40, step: 1, def: 8, unit: "m" },
    },
    commit: () => {},
  });
  registry.register({
    id: "line.draw", group: "line", title: "Line", icon: "〜",
    surfaces: ["atlas"], cursor: "crosshair", gesture: "drag",
    hint: "drag a path; release to smooth + commit",
    options: {
      kind: {
        kind: "enum",
        values: [{ id: "river", label: "River" }, { id: "road", label: "Road" }, { id: "border", label: "Border" }],
        def: "road",
      },
      color: { kind: "color", values: ["#8a9bb5", "#b59a8a", "#8ab5a2", "#5c6773", "#2f6f7a"], def: "#8a9bb5" },
    },
    commit: () => {},
  });
  registry.register({
    id: "place.stamp", group: "place", title: "Stamp", icon: "🏠",
    surfaces: ["atlas"], cursor: "crosshair", gesture: "click",
    hint: "click to drop an asset anchor",
    options: {
      scale: { kind: "range", min: 0.25, max: 4, step: 0.25, def: 1, unit: "×" },
      rot: { kind: "range", min: 0, max: 315, step: 45, def: 0, unit: "°" },
    },
    commit: () => {},
  });
  return registry;
}

export function createAtlasSurface({ mount, api, codec, document: doc, storage, onToast = console.warn, events, waterIr }) {
  if (!mount || mount.nodeType !== 1) throw new TypeError("atlas surface mount must be an Element");
  if (api === null || typeof api !== "object") throw new TypeError("atlas surface requires a design-api client");
  if (codec === null || typeof codec !== "object") throw new TypeError("atlas surface requires the raster codec");

  const root = doc.createElement("div");
  root.className = "atlas-root";
  const stage = doc.createElement("div");
  stage.className = "atlas-stage";
  const canvas = doc.createElement("canvas");
  canvas.className = "atlas-canvas";
  stage.appendChild(canvas);
  const rail = doc.createElement("div");
  rail.className = "atlas-rail";
  // createElement (not innerHTML): the behavioral tests mount this surface on a
  // fake DOM that deliberately has no HTML parser.
  const railHead = doc.createElement("div");
  railHead.className = "atlas-rail-head";
  const railTitle = doc.createElement("span");
  railTitle.textContent = "Layers";
  const railActions = doc.createElement("span");
  railActions.className = "rail-actions";
  const undoBtn = doc.createElement("button");
  undoBtn.type = "button";
  undoBtn.className = "icon-btn";
  undoBtn.id = "atlas-undo";
  undoBtn.title = "Undo (Ctrl+Z)";
  undoBtn.textContent = "↶";
  const redoBtn = doc.createElement("button");
  redoBtn.type = "button";
  redoBtn.className = "icon-btn";
  redoBtn.id = "atlas-redo";
  redoBtn.title = "Redo (Ctrl+Shift+Z)";
  redoBtn.textContent = "↷";
  railActions.appendChild(undoBtn);
  railActions.appendChild(redoBtn);
  railHead.appendChild(railTitle);
  railHead.appendChild(railActions);
  const railBody = doc.createElement("div");
  railBody.className = "atlas-rail-body";
  const selectionEl = doc.createElement("div");
  selectionEl.className = "atlas-selection";
  selectionEl.id = "atlas-selection";
  selectionEl.hidden = true;
  const stampPickWrap = doc.createElement("div");
  stampPickWrap.className = "atlas-stamp-pick";
  const stampLabel = doc.createElement("label");
  stampLabel.textContent = "stamp asset ";
  const stampPicker = doc.createElement("select");
  stampPicker.id = "atlas-stamp-asset";
  stampLabel.appendChild(stampPicker);
  stampPickWrap.appendChild(stampLabel);
  const mapProps = doc.createElement("div");
  mapProps.className = "atlas-map-props";
  const seaLabel = doc.createElement("label");
  seaLabel.textContent = "sea level ";
  const seaInput = doc.createElement("input");
  seaInput.id = "atlas-sea";
  seaInput.type = "number";
  seaInput.min = "-12";
  seaInput.max = "12";
  seaInput.step = "0.5";
  seaLabel.appendChild(seaInput);
  seaLabel.appendChild(doc.createTextNode(" m"));
  mapProps.appendChild(seaLabel);
  const statusEl = doc.createElement("div");
  statusEl.className = "atlas-rail-foot";
  statusEl.id = "atlas-status";
  statusEl.textContent = "—";
  rail.appendChild(railHead);
  rail.appendChild(railBody);
  rail.appendChild(selectionEl);
  rail.appendChild(stampPickWrap);
  rail.appendChild(mapProps);
  rail.appendChild(statusEl);
  undoBtn.addEventListener("click", () => doUndo());
  redoBtn.addEventListener("click", () => doRedo());
  stampPicker.addEventListener("change", () => {
    catalogAssetId = stampPicker.value === "" ? undefined : stampPicker.value;
  });

  const controller = createToolController({ registry: atlasToolRegistry(), surface: "atlas", storage });
  // Boot from the persisted snapshot BEFORE building views: restore() does not
  // notify subscribers, and createToolController only saves — without this the
  // Atlas tool options were write-only across reloads.
  const savedTools = storage?.load?.(DEFAULT_STORAGE_KEY);
  if (savedTools !== undefined) controller.restore(savedTools);
  const ribbon = buildToolRibbon(controller, { document: doc });
  const optionsBar = buildOptionsBar(controller, { document: doc });

  const center = doc.createElement("div");
  center.className = "atlas-surface";
  center.appendChild(stage);
  center.appendChild(rail);
  root.appendChild(ribbon);
  root.appendChild(optionsBar);
  root.appendChild(center);
  mount.appendChild(root);

  const ctx = canvas.getContext("2d");
  let undoStack = createUndoStack();
  const layerVisibility = new Map([["landmass", true], ["elevation", true], ["biomes", true]]);

  let model = null;
  let mapsRev = null;
  let cam = { x: 0, z: 0, scale: 0.5 }; // world meters -> px
  let stroke = null;
  let pan = null;
  let hover = null;
  let saveTimer = 0;
  /** The save currently airborne (null when idle) and whether another save was
   *  requested while it was in flight. Serializing saves this way means a second
   *  save never posts against a baseRev the first save is about to advance — the
   *  self-collision that produced a CAS 409, a reload, and silent loss of the
   *  strokes made during the in-flight window. */
  let saveInFlight = null;
  let saveQueued = false;
  let destroyed = false;
  let needsFit = true;
  // Composited-raster cache. render() runs on every pointer event; recompositing the
  // 512² landmass (a full-raster flood fill + two 1 MB allocations + a fresh <canvas>)
  // per event was the Atlas's dominant cost. The composite depends ONLY on raster
  // contents, layer visibility, seaLevel, and the model — none of which change on
  // pan/zoom/hover/select. Cache the offscreen canvas; the signature auto-invalidates
  // on visibility/seaLevel/model changes, and compositeDirty flags cell mutations.
  let compositeCanvas = null;
  let compositeModel = null;
  let compositeSig = "";
  let compositeDirty = true;
  const invalidateComposite = () => { compositeDirty = true; };
  let strokeSeed = 0;
  /** The picked feature/stamp/water body (select tool), with a Delete affordance. */
  let selectedItem = null;
  /** In-progress lasso rect (select.lasso). */
  let lassoRect = null;
  /** The catalog asset selected for stamping (picker in the rail). */
  let catalogAssets = [];
  let catalogAssetId;
  /** In-progress poly gestures: water.basin point list / line.draw drag points. */
  let polyPoints = null;
  let lineDraft = null;
  /** Timed agent-suggestion region highlights (studio.suggest with a region). */
  const highlights = [];
  const offEvents = events?.subscribe?.((event) => {
    if (event.type === "agent.suggestion" && event.payload?.region !== undefined) {
      highlights.push({ region: event.payload.region, until: Date.now() + 12_000 });
      render();
    }
  });

  function worldFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    // Pointer coords are CSS px; the canvas backing store (and the render transform
    // it is inverted against) is DEVICE px — resize() sets canvas.width = css * dpr.
    // Scale the CSS offset into device px before inverting, or the brush lands off
    // the cursor by a factor of dpr on any HiDPI display.
    const dpr = rect.width > 0 ? canvas.width / rect.width : 1;
    const px = (event.clientX - rect.left) * dpr;
    const pz = (event.clientY - rect.top) * dpr;
    return [cam.x + (px - canvas.width / 2) / cam.scale, cam.z + (pz - canvas.height / 2) / cam.scale];
  }

  /** Inverse of worldFromEvent (diagnostics + behavioral tests): world → CSS-px
   *  client coordinates. Divides the device-px render offset back down by dpr so it
   *  is a true inverse of worldFromEvent at any devicePixelRatio. */
  function worldToScreen(wx, wz) {
    const rect = canvas.getBoundingClientRect();
    const dpr = rect.width > 0 ? canvas.width / rect.width : 1;
    return [
      rect.left + ((wx - cam.x) * cam.scale + canvas.width / 2) / dpr,
      rect.top + ((wz - cam.z) * cam.scale + canvas.height / 2) / dpr,
    ];
  }

  function fitCamera() {
    if (model === null) return;
    const lm = model.rasters.landmass ?? model.rasters.elevation;
    const rect = lm?.rect ?? { x0: -400, z0: -400, w: 800, h: 800 };
    cam.x = rect.x0 + rect.w / 2;
    cam.z = rect.z0 + rect.h / 2;
    cam.scale = Math.min(canvas.width / rect.w, canvas.height / rect.h) * 0.9;
  }

  function resize() {
    const box = stage.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    const dpr = doc.defaultView?.devicePixelRatio ?? 1;
    canvas.width = Math.max(1, Math.round(box.width * dpr));
    canvas.height = Math.max(1, Math.round(box.height * dpr));
    canvas.style.width = `${box.width}px`;
    canvas.style.height = `${box.height}px`;
    // The workspace starts hidden (0×0): a fit computed against the canvas
    // default size is wrong, so defer it until real dimensions arrive.
    if (needsFit && model !== null) {
      needsFit = false;
      fitCamera();
    }
    render();
  }

  function renderRail() {
    railBody.replaceChildren();
    const rows = [
      { id: "landmass", label: "Landmass", layer: model?.rasters.landmass },
      { id: "elevation", label: "Elevation", layer: model?.rasters.elevation },
      { id: "biomes", label: "Biomes", layer: model?.rasters.biomes },
    ];
    if (model === null) {
      const empty = doc.createElement("div");
      empty.className = "layer-empty";
      empty.textContent = "loading the map…";
      railBody.appendChild(empty);
      return;
    }
    for (const row of rows) {
      const el = doc.createElement("div");
      el.className = "layer-row";
      const eye = doc.createElement("button");
      eye.type = "button";
      eye.className = "icon-btn";
      eye.textContent = "◉";
      const visible = layerVisibility.get(row.id) === true;
      eye.classList.toggle("off", !visible);
      eye.title = visible ? `hide ${row.label}` : `show ${row.label}`;
      eye.addEventListener("click", () => {
        layerVisibility.set(row.id, !visible);
        renderRail();
        render();
      });
      const name = doc.createElement("span");
      name.className = "layer-name";
      name.textContent = row.label;
      const meta = doc.createElement("span");
      meta.className = "layer-meta";
      meta.textContent = row.layer === undefined ? "—" : `${row.layer.w}² r${row.layer.rev ?? 0}`;
      el.appendChild(eye);
      el.appendChild(name);
      el.appendChild(meta);
      railBody.appendChild(el);
    }
  }

  /** The composited landmass/elevation/biome raster as an offscreen canvas, rebuilt
   *  only when its inputs change (see compositeCanvas). Reuses one canvas element and
   *  one signature so pan/zoom/hover/select frames pay a single drawImage, not a
   *  flood fill + megabyte allocations. */
  function ensureComposite(lm, el, bi) {
    const sig = `${model.seaLevel}|${layerVisibility.get("landmass") ? 1 : 0}${layerVisibility.get("elevation") ? 1 : 0}${layerVisibility.get("biomes") ? 1 : 0}`;
    if (!compositeDirty && compositeCanvas !== null && compositeModel === model && compositeSig === sig) {
      return compositeCanvas;
    }
    const frame = compositeRasters({
      landmass: layerVisibility.get("landmass") ? lm : { ...lm, cells: new Uint8Array(lm.cells.length) },
      elevation: layerVisibility.get("elevation") ? el : undefined,
      biomes: layerVisibility.get("biomes") ? bi : undefined,
      seaLevel: model.seaLevel,
    });
    const image = new ImageData(frame.pixels, frame.w, frame.h);
    const off = compositeCanvas ?? doc.createElement("canvas");
    off.width = frame.w;
    off.height = frame.h;
    off.getContext("2d").putImageData(image, 0, 0);
    compositeCanvas = off;
    compositeModel = model;
    compositeSig = sig;
    compositeDirty = false;
    return compositeCanvas;
  }

  function render() {
    if (destroyed || model === null || canvas.width === 0) return;
    const lm = model.rasters.landmass;
    const el = model.rasters.elevation;
    const bi = model.rasters.biomes;
    ctx.fillStyle = "#0e1116";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (lm === undefined) {
      ctx.fillStyle = "#6b7885";
      ctx.font = "13px system-ui";
      ctx.fillText("paint with the Land brush to begin", 16, 24);
      return;
    }
    const off = ensureComposite(lm, el, bi);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const rect = lm.rect;
    const dx = (rect.x0 - cam.x) * cam.scale + canvas.width / 2;
    const dz = (rect.z0 - cam.z) * cam.scale + canvas.height / 2;
    ctx.drawImage(off, dx, dz, rect.w * cam.scale, rect.h * cam.scale);
    // Brush cursor ring: the one affordance that must track the pointer exactly.
    const ringAt = stroke?.hover ?? hover;
    if (ringAt !== null && ringAt !== undefined && controller.activeTool()?.options?.radius !== undefined) {
      const [hx, hz] = ringAt;
      const radius = controller.option(controller.activeId(), "radius") * cam.scale;
      ctx.strokeStyle = "rgba(215,221,229,0.7)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc((hx - cam.x) * cam.scale + canvas.width / 2, (hz - cam.z) * cam.scale + canvas.height / 2, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Features (water bodies / lines / stamps), selection, lasso, highlights.
    drawFeatures();
    drawSelection();
    const now = Date.now();
    for (let i = highlights.length - 1; i >= 0; i--) {
      const h = highlights[i];
      if (now > h.until) {
        highlights.splice(i, 1);
        continue;
      }
      const { x0, z0, x1, z1 } = h.region;
      const rx = (x0 - cam.x) * cam.scale + canvas.width / 2;
      const rz = (z0 - cam.z) * cam.scale + canvas.height / 2;
      ctx.strokeStyle = "rgba(109, 180, 255, 0.85)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(rx, rz, (x1 - x0) * cam.scale, (z1 - z0) * cam.scale);
      ctx.setLineDash([]);
    }
    if (lassoRect !== null) {
      const [lx, lz] = [ (lassoRect.x0 - cam.x) * cam.scale + canvas.width / 2, (lassoRect.z0 - cam.z) * cam.scale + canvas.height / 2 ];
      ctx.strokeStyle = "rgba(215, 221, 229, 0.9)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(lx, lz, (lassoRect.x1 - lassoRect.x0) * cam.scale, (lassoRect.z1 - lassoRect.z0) * cam.scale);
      ctx.setLineDash([]);
    }
  }

  /** Sample the live elevation (meters) at a world point, or undefined outside
   *  the elevation raster's rect (Alt-click eyedropper + flatten seeding). */
  function sampleElevation(wx, wz) {
    const el = model?.rasters.elevation;
    if (el === undefined) return undefined;
    const { rect } = el;
    if (wx < rect.x0 || wz < rect.z0 || wx >= rect.x0 + rect.w || wz >= rect.z0 + rect.h) return undefined;
    const c = Math.min(el.w - 1, Math.floor(((wx - rect.x0) / rect.w) * el.w));
    const r = Math.min(el.h - 1, Math.floor(((wz - rect.z0) / rect.h) * el.h));
    return valToY(el.cells[r * el.w + c], el);
  }

  /** Selection highlight: accent outline around the picked item's geometry. */
  function drawSelection() {
    if (selectedItem === null) return;
    const toScreen = (wx, wz) => [(wx - cam.x) * cam.scale + canvas.width / 2, (wz - cam.z) * cam.scale + canvas.height / 2];
    ctx.strokeStyle = "rgba(255, 196, 92, 0.95)";
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 4]);
    if (selectedItem.kind === "stamp") {
      const [sx, sz] = toScreen(selectedItem.item.x, selectedItem.item.z);
      ctx.beginPath();
      ctx.arc(sx, sz, 10 * (selectedItem.item.scale ?? 1), 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const pts = selectedItem.kind === "waterBody" ? selectedItem.item.footprint?.points : selectedItem.item.points;
      if (Array.isArray(pts) && pts.length >= 2) {
        ctx.beginPath();
        const [ax, az] = toScreen(pts[0][0], pts[0][1]);
        ctx.moveTo(ax, az);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(...toScreen(pts[i][0], pts[i][1]));
        if (selectedItem.kind === "waterBody") ctx.closePath();
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }

  /** Apply-then-record for doc-array props (features/stamps/waterBodies). The
   *  doc IS the save payload; the command restores the prior array on undo. */
  function commitDocArray(key, next) {
    const before = model.doc[key] ?? [];
    const after = [...before, next];
    model.doc[key] = after;
    undoStack.push(cmdSetMapProp(model.id, model.doc, key, before, after));
    scheduleSave();
    render();
  }

  /** Remove doc-array entries by id, one undoable command per array. */
  function removeDocItems(key, ids) {
    const before = model.doc[key] ?? [];
    const drop = new Set(ids);
    const after = before.filter((entry) => !drop.has(entry.id));
    if (after.length === before.length) return 0;
    model.doc[key] = after;
    undoStack.push(cmdSetMapProp(model.id, model.doc, key, before, after));
    return before.length - after.length;
  }

  /** Bulk removal from all three pickable arrays; one toast + save. */
  function removeHits(hits) {
    let count = 0;
    count += removeDocItems("features", hits.features ?? []);
    count += removeDocItems("stamps", hits.stamps ?? []);
    count += removeDocItems("waterBodies", hits.waterBodies ?? []);
    if (count > 0) {
      selectedItem = null;
      renderSelection();
      scheduleSave();
      render();
      onToast(`deleted ${count} item${count === 1 ? "" : "s"}`);
    }
    return count;
  }

  function selectItem(hit) {
    selectedItem = hit;
    renderSelection();
    render();
  }

  function clearSelection() {
    if (selectedItem === null) return;
    selectedItem = null;
    renderSelection();
    render();
  }

  /** The rail strip naming the picked item with a Delete affordance. */
  function renderSelection() {
    selectionEl.replaceChildren();
    if (selectedItem === null) {
      selectionEl.hidden = true;
      return;
    }
    selectionEl.hidden = false;
    const label = doc.createElement("span");
    const kindLabel = selectedItem.kind === "waterBody" ? (selectedItem.item.kind ?? "water") : selectedItem.kind === "stamp" ? "stamp" : (selectedItem.item.kind ?? "line");
    label.textContent = `◈ ${kindLabel} ${selectedItem.id}`;
    const del = doc.createElement("button");
    del.type = "button";
    del.className = "icon-btn";
    del.textContent = "🗑";
    del.title = "Delete selected (Del)";
    del.addEventListener("click", () => deleteSelected());
    selectionEl.appendChild(label);
    selectionEl.appendChild(del);
  }

  function deleteSelected() {
    if (selectedItem === null || model === null) return;
    const key = selectedItem.kind === "waterBody" ? "waterBodies" : selectedItem.kind === "stamp" ? "stamps" : "features";
    const hits = { features: [], stamps: [], waterBodies: [] };
    hits[key].push(selectedItem.id);
    removeHits(hits);
  }

  function drawFeatures() {
    const toScreen = (wx, wz) => [(wx - cam.x) * cam.scale + canvas.width / 2, (wz - cam.z) * cam.scale + canvas.height / 2];
    // Water bodies: kind-tinted fill + darker outline.
    for (const body of model.doc.waterBodies ?? []) {
      const pts = body.footprint?.points ?? [];
      if (pts.length < 3) continue;
      ctx.beginPath();
      const [sx0, sz0] = toScreen(pts[0][0], pts[0][1]);
      ctx.moveTo(sx0, sz0);
      for (let i = 1; i < pts.length; i++) {
        const [sx, sz] = toScreen(pts[i][0], pts[i][1]);
        ctx.lineTo(sx, sz);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(63, 110, 165, 0.55)";
      ctx.fill();
      ctx.strokeStyle = "rgba(99, 160, 220, 0.9)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    // Line features (river/road/border): committed color polylines.
    for (const feature of model.doc.features ?? []) {
      if (feature.type !== "line" || !Array.isArray(feature.points) || feature.points.length < 2) continue;
      ctx.beginPath();
      const [fx0, fz0] = toScreen(feature.points[0][0], feature.points[0][1]);
      ctx.moveTo(fx0, fz0);
      for (let i = 1; i < feature.points.length; i++) {
        const [fx, fz] = toScreen(feature.points[i][0], feature.points[i][1]);
        ctx.lineTo(fx, fz);
      }
      ctx.strokeStyle = feature.color ?? "#8a9bb5";
      ctx.lineWidth = Math.max(1.5, 2 * cam.scale * 0.2);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    }
    // Stamps: diamond markers with a small ring.
    for (const stamp of model.doc.stamps ?? []) {
      const [sx, sz] = toScreen(stamp.x, stamp.z);
      ctx.save();
      ctx.translate(sx, sz);
      ctx.rotate(((stamp.rot ?? 0) * Math.PI) / 180);
      const size = 5 * (stamp.scale ?? 1);
      ctx.beginPath();
      ctx.moveTo(0, -size);
      ctx.lineTo(size, 0);
      ctx.lineTo(0, size);
      ctx.lineTo(-size, 0);
      ctx.closePath();
      ctx.fillStyle = "rgba(215, 221, 229, 0.9)";
      ctx.fill();
      ctx.strokeStyle = "rgba(20, 26, 32, 0.9)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
    // In-progress basin polygon preview.
    if (polyPoints !== null && polyPoints.length > 0) {
      ctx.beginPath();
      const [px0, pz0] = toScreen(polyPoints[0][0], polyPoints[0][1]);
      ctx.moveTo(px0, pz0);
      for (let i = 1; i < polyPoints.length; i++) {
        const [px, pz] = toScreen(polyPoints[i][0], polyPoints[i][1]);
        ctx.lineTo(px, pz);
      }
      if (hover !== null) ctx.lineTo(...toScreen(hover[0], hover[1]));
      ctx.strokeStyle = "rgba(99, 160, 220, 0.95)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const [px0, pz0] of polyPoints) {
        const [vx, vz] = toScreen(px0, pz0);
        ctx.beginPath();
        ctx.arc(vx, vz, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(99, 160, 220, 1)";
        ctx.fill();
      }
    }
    // In-progress line draft preview.
    if (lineDraft !== null && lineDraft.points.length > 0) {
      ctx.beginPath();
      const [dx0, dz0] = toScreen(lineDraft.points[0][0], lineDraft.points[0][1]);
      ctx.moveTo(dx0, dz0);
      for (let i = 1; i < lineDraft.points.length; i++) {
        const [dx, dz] = toScreen(lineDraft.points[i][0], lineDraft.points[i][1]);
        ctx.lineTo(dx, dz);
      }
      ctx.strokeStyle = controller.activeTool() !== undefined ? controller.option(controller.activeId(), "color") : "#8a9bb5";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  function dabAt(wx, wz, strokeCtx) {
    const tool = controller.activeTool();
    if (tool === undefined) return null;
    if (tool.id === "terrain.land") {
      const lm = ensureLandmass(model);
      return {
        layer: lm,
        bbox: landDab(lm, wx, wz, {
          mode: controller.option(tool.id, "mode"),
          radiusM: controller.option(tool.id, "radius"),
          strength: controller.option(tool.id, "strength"),
          falloff: controller.option(tool.id, "falloff"),
        }),
      };
    }
    if (tool.id === "terrain.elev") {
      const el = ensureElevation(model);
      const mode = controller.option(tool.id, "mode");
      return {
        layer: el,
        bbox: elevationDab(el, wx, wz, {
          mode,
          radiusM: controller.option(tool.id, "radius"),
          strength: controller.option(tool.id, "strength"),
          // flatten targets the stroke's START height (sampled at pointerdown);
          // level targets the explicit levelY option.
          levelY: mode === "flatten" && strokeCtx?.levelY !== undefined ? strokeCtx.levelY : controller.option(tool.id, "levelY"),
          falloff: controller.option(tool.id, "falloff"),
          seed: strokeCtx?.seed ?? 0,
        }),
      };
    }
    if (tool.id === "paint.biome") {
      const bi = ensureBiomes(model);
      const cls = controller.option(tool.id, "class");
      return { layer: bi, bbox: biomeDab(bi, wx, wz, { value: cls === "erase" ? 0 : BIOME_CLASSES.indexOf(cls) + 1, radiusM: controller.option(tool.id, "radius") }) };
    }
    return null;
  }

  function strokePoints(a, b, radiusM) {
    // Interpolate at radius/3 spacing (original map.js:3305-3332): continuous
    // stroke, no dab-shaped gaps at drag speed.
    const [x0, z0] = a;
    const [x1, z1] = b;
    const d = Math.hypot(x1 - x0, z1 - z0);
    const step = Math.max(1, radiusM / 3);
    const n = Math.max(1, Math.ceil(d / step));
    const out = [];
    for (let i = 1; i <= n; i++) out.push([x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n]);
    return out;
  }

  function onPointerDown(event) {
    if (model === null || event.button !== 0) return;
    const tool = controller.activeTool();
    // Alt-click is the height eyedropper (any tool): sample elevation into the
    // Level target so level/flatten aim at real terrain, not a guessed number.
    if (event.altKey) {
      const [sx, sz] = worldFromEvent(event);
      const sampled = sampleElevation(sx, sz);
      if (sampled !== undefined && tool !== undefined && tool.options?.levelY !== undefined) {
        controller.setOption(tool.id, "levelY", Math.round(sampled));
        onToast(`level target ← ${Math.round(sampled)}m`);
      }
      return;
    }
    if (tool === undefined) {
      pan = { startX: event.clientX, startZ: event.clientY, camX: cam.x, camZ: cam.z };
      stage.setPointerCapture?.(event.pointerId);
      return;
    }
    const [wx, wz] = worldFromEvent(event);
    // select.pick: hit-test in world meters; empty space clears + pans.
    if (tool.id === "select.pick") {
      const hit = hitTest(wx, wz, {
        features: model.doc.features ?? [],
        stamps: model.doc.stamps ?? [],
        waterBodies: model.doc.waterBodies ?? [],
      });
      if (hit !== null) {
        selectItem(hit);
        return;
      }
      clearSelection();
      pan = { startX: event.clientX, startZ: event.clientY, camX: cam.x, camZ: cam.z };
      stage.setPointerCapture?.(event.pointerId);
      return;
    }
    // select.lasso: drag a world-space rect; pointerup deletes its contents.
    if (tool.id === "select.lasso") {
      lassoRect = { x0: wx, z0: wz, x1: wx, z1: wz };
      stage.setPointerCapture?.(event.pointerId);
      render();
      return;
    }

    // water.basin: point-by-point polygon (close on double-click / Enter). A
    // point within epsilon of its predecessor is ignored — double-click fires
    // pointerdown twice at the same spot, and duplicate vertices are invalid.
    if (tool.id === "water.basin") {
      if (polyPoints === null) polyPoints = [];
      const last = polyPoints[polyPoints.length - 1];
      if (last === undefined || Math.hypot(wx - last[0], wz - last[1]) > 1e-6) {
        polyPoints.push([wx, wz]);
      }
      render();
      return;
    }
    // line.draw: drag a path; release smooths + commits.
    if (tool.id === "line.draw") {
      lineDraft = { points: [[wx, wz]], last: [wx, wz] };
      stage.setPointerCapture?.(event.pointerId);
      return;
    }
    // place.stamp: one click, one anchor.
    if (tool.id === "place.stamp") {
      if (catalogAssetId === undefined) {
        onToast("no asset catalog loaded — cannot stamp");
        return;
      }
      const stamp = makeStamp({
        id: featureId("st"),
        assetId: catalogAssetId,
        x: wx,
        z: wz,
        rot: controller.option(tool.id, "rot"),
        scale: controller.option(tool.id, "scale"),
      });
      commitDocArray("stamps", stamp);
      events?.emit?.("atlas.stroke", { detail: `stamp ${stamp.assetId}` });
      return;
    }
    const radius = tool.options?.radius !== undefined ? controller.option(tool.id, "radius") : 0;
    // Stroke context: flatten targets the height at stroke START (sampled
    // pristine, before the first dab); noise shares one seed across the whole
    // stroke so its displacement is coherent and redo-identical.
    const strokeCtx = { seed: (strokeSeed = (strokeSeed + 1) >>> 0) };
    if (tool.id === "terrain.elev" && controller.option(tool.id, "mode") === "flatten") {
      const sampled = sampleElevation(wx, wz);
      if (sampled !== undefined) strokeCtx.levelY = sampled;
    }
    const first = dabAt(wx, wz, strokeCtx);
    // One full-raster pre-stroke snapshot (bounded: 512² u8 = 256KB transient).
    // The stroke's undo then restores the exact pre-stroke bbox, however the dab
    // union grows — capturing per-dab before-images would double-count overlaps.
    stroke = {
      tool,
      ctx: strokeCtx,
      last: [wx, wz],
      hover: [wx, wz],
      radius,
      layer: first?.layer,
      bbox: first?.bbox ?? null,
      pristine: first?.layer?.cells.slice(),
    };
    stage.setPointerCapture?.(event.pointerId);
    render();
  }

  function onPointerMove(event) {
    const [wx, wz] = worldFromEvent(event);
    if (pan !== null) {
      cam.x = pan.camX - (event.clientX - pan.startX) / cam.scale;
      cam.z = pan.camZ - (event.clientY - pan.startZ) / cam.scale;
      render();
      return;
    }
    hover = [wx, wz];
    if (lassoRect !== null) {
      lassoRect.x1 = wx;
      lassoRect.z1 = wz;
      render();
      return;
    }
    if (lineDraft !== null) {
      const [lx, lz] = lineDraft.last;
      if (Math.hypot(wx - lx, wz - lz) >= 4 / cam.scale) {
        lineDraft.points.push([wx, wz]);
        lineDraft.last = [wx, wz];
        render();
      }
      return;
    }
    if (polyPoints !== null) {
      render();
      return;
    }
    if (stroke === null) {
      updateStatus();
      render();
      return;
    }
    stroke.hover = hover;
    for (const [px, pz] of strokePoints(stroke.last, hover, stroke.radius)) {
      const hit = dabAt(px, pz, stroke.ctx);
      if (hit?.bbox != null) {
        stroke.bbox = bboxUnion(stroke.bbox, hit.bbox);
        stroke.layer = hit.layer;
        invalidateComposite(); // this dab mutated raster cells
      }
    }
    stroke.last = hover;
    render();
  }

  function onPointerUp() {
    if (pan !== null) {
      pan = null;
      return;
    }
    if (lassoRect !== null) {
      const rect = lassoRect;
      lassoRect = null;
      const hits = lassoHits(rect.x0, rect.z0, rect.x1, rect.z1, {
        features: model.doc.features ?? [],
        stamps: model.doc.stamps ?? [],
        waterBodies: model.doc.waterBodies ?? [],
      });
      if (removeHits(hits) === 0) render();
      return;
    }
    if (lineDraft !== null) {
      const draft = lineDraft;
      lineDraft = null;
      const tool = controller.activeTool();
      if (tool !== undefined && draft.points.length >= 2) {
        const smoothed = smoothDrawnPolyline(draft.points, Math.max(2, 4 / cam.scale));
        commitDocArray("features", {
          id: featureId("ln"),
          type: "line",
          kind: controller.option(tool.id, "kind"),
          points: smoothed.map(([x, z]) => [Math.round(x), Math.round(z)]),
          color: controller.option(tool.id, "color"),
        });
        events?.emit?.("atlas.stroke", { detail: `${controller.option(tool.id, "kind")} line` });
      } else {
        render();
      }
      return;
    }
    if (stroke === null) return;
    const done = stroke;
    stroke = null;
    if (done.pristine === undefined || done.bbox === null || done.layer === undefined) return;
    const before = snapshotBBoxFrom(done.pristine, done.layer, done.bbox);
    const after = snapshotBBox(done.layer, done.bbox);
    const cmd = cmdPatchRaster(model.id, done.layer, done.bbox, before, after, `${done.tool.title} stroke`);
    undoStack.push(cmd);
    events?.emit?.("atlas.stroke", { detail: `${done.tool.title} stroke` });
    scheduleSave();
    renderRail();
    render();
  }

  function snapshotBBoxFrom(cells, layer, bbox) {
    const { c0, r0, c1, r1 } = bbox;
    const bw = c1 - c0 + 1;
    const bh = r1 - r0 + 1;
    const out = new layer.cells.constructor(bw * bh);
    for (let r = 0; r < bh; r++) out.set(cells.subarray((r0 + r) * layer.w + c0, (r0 + r) * layer.w + c0 + bw), r * bw);
    return out;
  }

  function updateStatus() {
    if (hover === null || model === null) {
      statusEl.textContent = "—";
      return;
    }
    const [wx, wz] = hover;
    const elev = sampleElevation(wx, wz);
    const parts = [`${Math.round(wx)}, ${Math.round(wz)}`];
    if (elev !== undefined) parts.push(`⛰ ${elev.toFixed(1)}m`);
    statusEl.textContent = parts.join("  ·  ");
  }

  function scheduleSave() {
    if (saveTimer !== 0) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      void flushSave();
    }, SAVE_DEBOUNCE_MS);
  }

  async function flushSave() {
    if (model === null) return;
    // Serialize: while a save is airborne, coalesce further requests into a SINGLE
    // follow-up that runs after it settles (so mapsRev has advanced and the two never
    // collide on the same baseRev). Returns the in-flight promise so callers can await.
    if (saveInFlight !== null) {
      saveQueued = true;
      return saveInFlight;
    }
    saveInFlight = (async () => {
      try {
        const docPayload = syncRastersIntoDoc(model, codec);
        // Every save descends from a deliberate user command (stroke, undo,
        // lasso/delete) — erasing the last water body/feature/stamp IS the
        // intended outcome of those commands, so authorize intentional shrink.
        // The bridge's circuit breaker still guards every other caller.
        const res = await api.mapSave([docPayload], model.id, mapsRev, { allowShrink: true });
        if (typeof res?.mapsRev === "string") mapsRev = res.mapsRev;
        events?.emit?.("atlas.save", { detail: "map saved" });
      } catch (e) {
        // A 409 here is a genuine EXTERNAL conflict (another writer holds the rev) —
        // our own back-to-back saves can no longer self-collide. Resync, never clobber.
        onToast(`map save failed: ${e instanceof Error ? e.message : e}`);
        await load();
      }
    })();
    try {
      await saveInFlight;
    } finally {
      saveInFlight = null;
      if (saveQueued) {
        saveQueued = false;
        await flushSave();
      }
    }
  }

  async function load() {
    try {
      const state = await api.state();
      mapsRev = state.mapsRev;
      const map = (state.maps ?? [])[0];
      if (map === undefined) {
        model = null;
        renderRail();
        render();
        return;
      }
      model = decodeMap(map, codec);
      seaInput.value = String(model.seaLevel);
      // The stamp catalog arms the picker; the selected entry is what
      // place.stamp anchors.
      try {
        const catalog = await api.catalog();
        catalogAssets = Array.isArray(catalog) ? catalog : [];
      } catch {
        catalogAssets = [];
      }
      stampPicker.replaceChildren();
      for (const asset of catalogAssets) {
        const opt = doc.createElement("option");
        opt.value = asset.id ?? asset.assetId;
        opt.textContent = asset.name ?? asset.title ?? opt.value;
        stampPicker.appendChild(opt);
      }
      catalogAssetId = stampPicker.value === "" ? undefined : stampPicker.value;
      undoStack = createUndoStack();
      selectedItem = null;
      renderSelection();
      needsFit = true;
      resize();
      renderRail();
      render();
    } catch (e) {
      model = null;
      railBody.replaceChildren();
      const err = doc.createElement("div");
      err.className = "layer-empty";
      err.textContent = `Atlas backend unavailable: ${e instanceof Error ? e.message : e}`;
      railBody.appendChild(err);
    }
  }

  function onWheel(event) {
    event.preventDefault();
    const [wx, wz] = worldFromEvent(event);
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    cam.scale = Math.max(0.02, Math.min(40, cam.scale * factor));
    // Zoom toward the pointer, not the canvas center.
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const pz = event.clientY - rect.top;
    cam.x = wx - (px - canvas.width / 2) / cam.scale;
    cam.z = wz - (pz - canvas.height / 2) / cam.scale;
    render();
  }

  function syncSeaFromDoc() {
    if (model === null) return;
    model.seaLevel = model.doc.seaLevel ?? model.doc.sea ?? 0;
    seaInput.value = String(model.seaLevel);
  }

  function doUndo() {
    undoStack.undo();
    invalidateComposite(); // an undone raster patch may have changed cells
    // The picked item may have been undone away; drop the dangling selection.
    selectedItem = null;
    renderSelection();
    syncSeaFromDoc();
    scheduleSave();
    renderRail();
    render();
  }

  function doRedo() {
    undoStack.redo();
    invalidateComposite(); // a redone raster patch may have changed cells
    selectedItem = null;
    renderSelection();
    syncSeaFromDoc();
    scheduleSave();
    renderRail();
    render();
  }

  function closeBasin() {
    if (polyPoints === null || model === null) return;
    const pts = polyPoints;
    polyPoints = null;
    const tool = controller.activeTool();
    if (tool === undefined || pts.length < 3) {
      render();
      return;
    }
    try {
      const body = makeWaterBody(waterIr, {
        id: featureId("wb"),
        kind: controller.option(tool.id, "kind"),
        level: controller.option(tool.id, "level"),
        ring: closeRing(pts),
        depthM: controller.option(tool.id, "depth"),
      });
      // The shared contract validates the FULL set (duplicate ids + topology).
      validateWaterBodies(waterIr, [...(model.doc.waterBodies ?? []), body]);
      commitDocArray("waterBodies", body);
      events?.emit?.("atlas.stroke", { detail: `${body.kind} basin` });
    } catch (error) {
      onToast(`basin invalid: ${error instanceof Error ? error.message : error}`);
      render();
    }
  }

  function onKey(event) {
    const tag = event.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (event.key === "Enter" && polyPoints !== null) {
      closeBasin();
      event.preventDefault();
      return;
    }
    if (event.key === "Escape") {
      if (polyPoints !== null || lineDraft !== null) {
        polyPoints = null;
        lineDraft = null;
        render();
        event.preventDefault();
        return;
      }
      if (selectedItem !== null) {
        clearSelection();
        event.preventDefault();
        return;
      }
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selectedItem !== null) {
      deleteSelected();
      event.preventDefault();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
      doUndo();
      event.preventDefault();
    } else if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey))) {
      doRedo();
      event.preventDefault();
    }
  }

  seaInput.addEventListener("change", () => {
    if (model === null) return;
    const next = Number(seaInput.value);
    if (!Number.isFinite(next) || next < -12 || next > 12) {
      seaInput.value = String(model.seaLevel);
      return;
    }
    const before = model.seaLevel;
    if (next === before) return;
    // The doc carries the property into the save payload; model.seaLevel mirrors
    // it for the renderer (below-sea cells read as shallow water).
    model.seaLevel = next;
    undoStack.push(cmdSetMapProp(model.id, model.doc, "seaLevel", before, next));
    scheduleSave();
    render();
  });

  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerup", onPointerUp);
  // A browser gesture (touch scroll, context menu, OS interruption) fires
  // pointercancel/lostpointercapture INSTEAD of pointerup — without these, a stroke
  // or pan stays live with no button held and its undo command is never committed.
  stage.addEventListener("pointercancel", onPointerUp);
  stage.addEventListener("lostpointercapture", onPointerUp);
  stage.addEventListener("dblclick", (e) => {
    e.preventDefault();
    if (polyPoints !== null) {
      closeBasin();
      return;
    }
    // 2.0-D: double-click on the map travels the 3D camera there (native
    // replacement for the deleted iframe focus bridge).
    if (model !== null) {
      const [wx, wz] = worldFromEvent(e);
      events?.emit?.("atlas.focus", { x: wx, z: wz });
    }
  });
  stage.addEventListener("wheel", onWheel, { passive: false });
  const offBrushKeys = bindBrushKeys(controller, { target: doc });
  doc.addEventListener("keydown", onKey);
  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(stage);
  // Flush a pending debounced save if the page is being hidden/unloaded — otherwise a
  // stroke finished within the 750ms debounce window is lost on navigation.
  const win = doc.defaultView ?? undefined;
  const onPageHide = () => {
    if (saveTimer !== 0) { clearTimeout(saveTimer); saveTimer = 0; void flushSave(); }
  };
  win?.addEventListener?.("pagehide", onPageHide);

  return Object.freeze({
    load,
    flushSave,
    worldToScreen,
    get model() { return model; },
    get controller() { return controller; },
    get cam() { return cam; },
    get selectedItem() { return selectedItem; },
    // Behavioral-test seams: same code path as the pointer handlers.
    pickAt(wx, wz) {
      if (model === null) return null;
      return hitTest(wx, wz, {
        features: model.doc.features ?? [],
        stamps: model.doc.stamps ?? [],
        waterBodies: model.doc.waterBodies ?? [],
      });
    },
    selectHit(hit) { selectItem(hit); },
    deleteSelected,
    lassoDelete(x0, z0, x1, z1) {
      if (model === null) return 0;
      return removeHits(lassoHits(x0, z0, x1, z1, {
        features: model.doc.features ?? [],
        stamps: model.doc.stamps ?? [],
        waterBodies: model.doc.waterBodies ?? [],
      }));
    },
    /** 2.0-D 3D → Atlas reveal: pan the map to a world position and pulse a
     *  marker there (same self-expiring highlight channel as suggestions). */
    reveal(wx, wz) {
      if (model === null || !Number.isFinite(wx) || !Number.isFinite(wz)) return;
      cam.x = wx;
      cam.z = wz;
      highlights.push({ region: { x0: wx - 24, z0: wz - 24, x1: wx + 24, z1: wz + 24 }, until: Date.now() + 8_000 });
      render();
    },
    destroy() {
      destroyed = true;
      // Flush, don't drop, a pending debounced save — a stroke finished within the
      // last 750ms would otherwise be lost when the surface is torn down on tab switch.
      if (saveTimer !== 0) { clearTimeout(saveTimer); saveTimer = 0; void flushSave(); }
      resizeObserver.disconnect();
      offBrushKeys();
      offEvents?.(); // release the studio event-bus subscription (was leaked)
      win?.removeEventListener?.("pagehide", onPageHide);
      doc.removeEventListener("keydown", onKey);
      root.remove();
    },
  });
}
