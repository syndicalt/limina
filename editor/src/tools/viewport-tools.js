// Viewport tool surface (Editor 2.0, 2.0-C slice 1): the Tool Contract registry
// drives the 3D viewport — a generated ribbon + options bar whose controller is
// the single source of truth for edit mode, brush tool, and brush options.
// viewport.js keeps its pointer dispatch and recorded skill paths unchanged;
// this module only translates controller state into adapter callbacks. The
// legacy F4 HUD reads the same state fields, so the two UIs cannot fork the
// world — worst case a stale HUD slider label, never a divergent edit.

import { buildOptionsBar, buildToolRibbon, createToolController, createToolRegistry } from "./tool-registry.js";

// Distinct from the Atlas surface's default key: a strict snapshot restore
// would reject the other surface's tool ids, so sharing storage is a hard
// error, not a merge.
export const VIEWPORT_STORAGE_KEY = "limina.studio.tool-options/viewport/v1";

export const VIEWPORT_SCULPT_MODES = ["raise", "lower", "smooth", "flatten"];
export const VIEWPORT_PAINT_MATERIALS = ["sand", "grass", "rock", "dirt", "snow", "murk", "tundra"];

const BRUSH_RANGES = {
  radius: { kind: "range", min: 2, max: 60, step: 1, def: 12, unit: "m" },
  strength: { kind: "range", min: 0.2, max: 4, step: 0.1, def: 1.2 },
  falloff: {
    kind: "enum",
    values: [{ id: "smooth", label: "Smooth" }, { id: "linear", label: "Linear" }, { id: "constant", label: "Constant" }],
    def: "smooth",
  },
};

export function viewportToolRegistry() {
  const registry = createToolRegistry();
  registry.register({
    id: "select.pick", group: "select", title: "Select", icon: "➤",
    surfaces: ["viewport"], cursor: "default", gesture: "click",
    hint: "click an entity · gizmo moves it · Delete destroys",
    // Gizmo controls live here (2.0-C): the options bar IS the gizmo toolbar.
    options: {
      gizmo: {
        kind: "enum",
        values: [{ id: "translate", label: "Move" }, { id: "rotate", label: "Rotate" }, { id: "scale", label: "Scale" }],
        def: "translate",
      },
      space: {
        kind: "enum",
        values: [{ id: "world", label: "Global" }, { id: "local", label: "Local" }],
        def: "world",
      },
      snap: { kind: "toggle", def: false, label: "Snap" },
    },
    commit: () => {},
  });
  registry.register({
    id: "terrain.sculpt", group: "terrain", title: "Sculpt", icon: "⛰",
    surfaces: ["viewport"], cursor: "crosshair", gesture: "stroke",
    hint: "drag on the ground to sculpt · Ctrl inverts raise/lower",
    options: {
      mode: {
        kind: "enum",
        values: [
          { id: "raise", label: "Raise" },
          { id: "lower", label: "Lower" },
          { id: "smooth", label: "Smooth" },
          { id: "flatten", label: "Flatten" },
        ],
        def: "raise",
      },
      ...BRUSH_RANGES,
    },
    commit: () => {},
  });
  registry.register({
    id: "paint.material", group: "paint", title: "Paint", icon: "🖌",
    surfaces: ["viewport"], cursor: "crosshair", gesture: "stroke",
    hint: "drag to blend material · Ctrl erases",
    options: {
      material: {
        kind: "enum",
        values: VIEWPORT_PAINT_MATERIALS.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })),
        def: "grass",
      },
      ...BRUSH_RANGES,
    },
    commit: () => {},
  });
  registry.register({
    id: "water.plane", group: "water", title: "Water", icon: "🌊",
    surfaces: ["viewport"], cursor: "crosshair", gesture: "click",
    hint: "click to apply the world water plane at this level",
    options: {
      level: { kind: "range", min: -12, max: 40, step: 0.5, def: 0, unit: "m" },
      size: { kind: "range", min: 256, max: 16384, step: 256, def: 4096, unit: "m" },
    },
    commit: () => {},
  });
  registry.register({
    id: "water.river", group: "water", title: "River", icon: "〰",
    surfaces: ["viewport"], cursor: "crosshair", gesture: "poly",
    hint: "click the centerline · double-click to commit",
    options: {
      width: { kind: "range", min: 1, max: 40, step: 0.5, def: 6, unit: "m" },
      class: {
        kind: "enum",
        values: [{ id: "river", label: "River" }, { id: "stream", label: "Stream" }],
        def: "river",
      },
    },
    commit: () => {},
  });
  registry.register({
    id: "place.scatter", group: "place", title: "Scatter", icon: "🌲",
    surfaces: ["viewport"], cursor: "brush", gesture: "stroke",
    hint: "drag to plant · each dab is a recorded vegetation.scatter confined to the brush disc",
    options: {
      species: {
        kind: "enum",
        values: [
          { id: "mixed", label: "Mixed" },
          { id: "spruce", label: "Spruce" },
          { id: "pine", label: "Pine" },
          { id: "birch", label: "Birch" },
          { id: "oak", label: "Oak" },
          { id: "ash", label: "Ash" },
          { id: "dead-oak", label: "Dead oak" },
        ],
        def: "mixed",
      },
      density: { kind: "range", min: 4, max: 192, step: 4, def: 32 },
      radius: { kind: "range", min: 4, max: 60, step: 2, def: 16, unit: "m" },
    },
    commit: () => {},
  });
  registry.register({
    id: "place.catalog", group: "place", title: "Place", icon: "🏠",
    surfaces: ["viewport"], cursor: "crosshair", gesture: "click",
    hint: "arm an asset in the Content Browser · click ground · R rotates · Esc disarms",
    commit: () => {},
  });
  return registry;
}

/** The viewport.js edit-mode mapping for each ribbon tool. */
export const MODE_BY_TOOL = Object.freeze({
  "select.pick": "select",
  "terrain.sculpt": "sculpt",
  "paint.material": "paint",
  "water.plane": "water-plane",
  "water.river": "water-river",
  "place.scatter": "scatter",
  "place.catalog": "catalog",
});

/** Inverse of MODE_BY_TOOL for the legacy key paths (F4 / 1-6 / placement arm)
 *  syncing state back INTO the controller. brushTool is the viewport.js field. */
export function toolForBrushTool(brushTool) {
  if (brushTool === "paint") return "paint.material";
  if (brushTool === "catalog") return "place.catalog";
  return "terrain.sculpt"; // raise | lower | smooth | flatten
}

/**
 * Mount the ribbon + options bar and forward controller state to the viewport.
 *   onModeChange(mode, brush) — mode: select | sculpt | paint | catalog
 *   onBrushChange(brush)      — active tool's brush values changed
 * brush = { sculptMode, material, radius, strength, falloff } — radius/strength/
 * falloff are the ACTIVE tool's (sculpt and paint persist separately, matching
 * the Atlas surface's per-tool option discipline).
 */
export function createViewportTooling({ document: doc, mount, storage, onModeChange, onBrushChange, onToolOption }) {
  if (!mount || mount.nodeType !== 1) throw new TypeError("viewport tooling mount must be an Element");
  if (typeof onModeChange !== "function") throw new TypeError("viewport tooling requires onModeChange");
  if (typeof onBrushChange !== "function") throw new TypeError("viewport tooling requires onBrushChange");
  if (onToolOption !== undefined && typeof onToolOption !== "function") throw new TypeError("onToolOption must be a function");

  const controller = createToolController({
    registry: viewportToolRegistry(),
    surface: "viewport",
    storage,
    storageKey: VIEWPORT_STORAGE_KEY,
  });
  // Boot from the persisted snapshot BEFORE building views: restore() does not
  // notify subscribers, and viewport.js reads activeId()/brushSnapshot() on
  // boot to reapply the persisted mode. Without this, persistence was write-only.
  const saved = storage?.load(VIEWPORT_STORAGE_KEY);
  if (saved !== undefined) controller.restore(saved);
  const ribbon = buildToolRibbon(controller, { document: doc });
  const optionsBar = buildOptionsBar(controller, { document: doc });
  const root = doc.createElement("div");
  root.className = "viewport-tooling";
  root.appendChild(ribbon);
  root.appendChild(optionsBar);
  mount.appendChild(root);

  function brushSnapshot() {
    const activeId = controller.activeId();
    const active = controller.activeTool();
    // radius/strength/falloff come from the ACTIVE tool when it declares them
    // (scatter's disc radius drives the cursor ring); otherwise the sculpt
    // brush's values carry over.
    const fromActive = (key) => (active?.options?.[key] !== undefined ? controller.option(activeId, key) : undefined);
    return {
      sculptMode: controller.option("terrain.sculpt", "mode"),
      material: controller.option("paint.material", "material"),
      radius: fromActive("radius") ?? controller.option("terrain.sculpt", "radius"),
      strength: fromActive("strength") ?? controller.option("terrain.sculpt", "strength"),
      falloff: fromActive("falloff") ?? controller.option("terrain.sculpt", "falloff"),
    };
  }

  controller.subscribe({
    onActiveChange: () => {
      const mode = MODE_BY_TOOL[controller.activeId()];
      if (mode === undefined) return;
      onModeChange(mode, brushSnapshot());
    },
    onOptionChange: (toolId, key, value) => {
      // Every option change is forwarded raw (gizmo/space/snap on select.pick
      // are not brush state); the brush snapshot is the ACTIVE tool's only.
      onToolOption?.(toolId, key, value);
      if (toolId !== controller.activeId()) return;
      onBrushChange(brushSnapshot());
    },
  });

  return Object.freeze({
    controller,
    brushSnapshot,
    destroy() { root.remove(); },
  });
}
