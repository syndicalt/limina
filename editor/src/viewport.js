// Live viewport — renders the world an agent/human is building on the authoritative editor server,
// by re-authoring the server's recorded AUTHORING command stream (worldlog.tail) through the SAME
// Mode-B live runtime (runLive). This replaces the former hardcoded command fixture: the viewport
// now reflects the REAL editor_host world log, polled incrementally and re-rendered as it grows.
//
// Tail batches are applied to the running viewport in place when they are existing-entity
// mutations. Structural additions still reboot because they need new render meshes and sync slots.
//
// Connection: a READ-ONLY follower that reuses the SAME server + auth the MCP panels use — it reads
// the page's shared #url / #auth-token inputs and connects as the `system.readonly` profile once the
// user has connected the panels (so it shares the token the user entered). No writes, no gating.
//
// SAB requires CROSS-ORIGIN ISOLATION (COOP: same-origin + COEP: require-corp). Serve the editor with
// `node tools/scaffold/scripts/serve.mjs editor 5173`. Without it (or without WebGPU) runLive returns
// null and we show the poster; the MCP panels keep working.
//
// Viewport editing controls:
// - W/E/R: translate / rotate / scale gizmo modes.
// - Ctrl hold: temporary rotate mode, restored to translate on release.
// - S: toggle TransformControls snapping; UI inputs set translate / rotate / scale increments.
// - X: toggle gizmo space between global (world) and local.
// - G: toggle the unobtrusive ground grid helper.
// - F: frame selection; Shift+F toggles scene wireframe view.

import { createBrowserRenderHost, runLive, partitionQuarantined, TransformControls, THREE, terrainBrushKernel } from "../vendor/limina-runtime.js";
import { applySculptPreview, collectDerivedTerrainMeshes, rollbackSculptPreview } from "./sculpt-preview.js";
import { createGraphicsSettings, readGraphicsQuality } from "./graphics-settings.js";
import { createDerivedRuntimeClient } from "./derived-runtime-client.js";
import { createBootLoading } from "./boot-loading.js";
import { createNavigationDestinationCoordinator } from "./navigation-destination.js";
import {
  DEFAULT_NAVIGATION_SPEED_MPS,
  createNavigationStateController,
  parseNavigationCoordinate,
  parseNavigationMode,
  parseNavigationPose,
  parseNavigationSpeed,
} from "./navigation-state.js";
import { sceneTransformOperation } from "./authoring-gateway.js";
import { assetPlacement, openContentBrowser, requestCatalogRefresh } from "./content-browser.js";
import { isAttachedToScene } from "./scene-graph.js";
import { editorSelection } from "./selection-store.js";
import { studioBus } from "./agents/studio-events.js";
import { MODE_BY_TOOL, createViewportTooling, toolForBrushTool } from "./tools/viewport-tools.js";
import { McpClient } from "./mcp-client.js";
import {
  commitSceneOperations,
  destroyEntity,
  deformTerrain,
  paintTerrain,
  placeAsset,
  addRiver,
  addWaterPlane,
  scatterVegetation,
  redoSceneAuthoring,
  refreshAuthoringHead,
  resetWriter,
  undoSceneAuthoring,
} from "./write-client.js";
import { CoalescedTask, createPlaySnapshot, playLifecycle, RetainedEditRestore } from "./play-lifecycle.js";

// Per-builder viewport cue colors. cueColorFor is the ONE source of truth for a builder's
// color — the roster swatch (app.js) and the viewport BoxHelper both derive from it, so a
// builder reads as the same color in every surface. Stable hash of the agentId -> palette slot.
const CUE_PALETTE = [0x4aa3ff, 0x3fb950, 0xd29922, 0xa371f7, 0xf778ba];
export function cueColorFor(agentId) {
  const s = String(agentId ?? "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return CUE_PALETTE[h % CUE_PALETTE.length];
}

// Builder cues on/off (Settings toggles this via localStorage). Default ON.
const CUES_STORAGE_KEY = "limina.editor.cues";
function cuesEnabled() {
  try { return localStorage.getItem(CUES_STORAGE_KEY) !== "off"; } catch { return true; }
}

const canvas = document.getElementById("editor-viewport");
let graphicsStorage;
try { graphicsStorage = globalThis.localStorage; }
catch { graphicsStorage = undefined; }
const initialGraphicsQuality = readGraphicsQuality(graphicsStorage);
const editRenderHost = createBrowserRenderHost({ canvas, forceWebGL: true, initialQuality: initialGraphicsQuality });
const statusEl = document.getElementById("viewport-status");
const viewportToolsEl = document.querySelector(".viewport-tools");
const viewportUi = {
  snapToggle: document.getElementById("viewport-snap-toggle"),
  snapTranslate: document.getElementById("viewport-snap-translate"),
  snapRotate: document.getElementById("viewport-snap-rotate"),
  snapScale: document.getElementById("viewport-snap-scale"),
  spaceToggle: document.getElementById("viewport-space-toggle"),
  gridToggle: document.getElementById("viewport-grid-toggle"),
  wireframeToggle: document.getElementById("viewport-wireframe-toggle"),
  play: document.getElementById("viewport-play"),
  pause: document.getElementById("viewport-pause"),
  stop: document.getElementById("viewport-stop"),
  playState: document.getElementById("viewport-play-state"),
  playSource: document.getElementById("viewport-play-source"),
  navigationMode: document.getElementById("viewport-navigation-mode"),
  navigationOrbit: document.getElementById("viewport-navigation-orbit"),
  navigationFly: document.getElementById("viewport-navigation-fly"),
  navigationSpeed: document.getElementById("viewport-navigation-speed"),
  navigationFocus: document.getElementById("viewport-navigation-focus"),
  navigationWorld: document.getElementById("viewport-navigation-world"),
  navigationGotoToggle: document.getElementById("viewport-navigation-goto-toggle"),
  navigationGoto: document.getElementById("viewport-navigation-goto"),
  navigationGotoClose: document.getElementById("viewport-navigation-goto-close"),
  navigationGotoCancel: document.getElementById("viewport-navigation-goto-cancel"),
  navigationX: document.getElementById("viewport-navigation-x"),
  navigationY: document.getElementById("viewport-navigation-y"),
  navigationZ: document.getElementById("viewport-navigation-z"),
  navigationGotoStatus: document.getElementById("viewport-navigation-goto-status"),
  navigationSearchToggle: document.getElementById("viewport-navigation-search-toggle"),
  navigationSearch: document.getElementById("viewport-navigation-search"),
  navigationSearchClose: document.getElementById("viewport-navigation-search-close"),
  navigationSearchInput: document.getElementById("viewport-navigation-search-input"),
  navigationSearchResults: document.getElementById("viewport-navigation-search-results"),
  navigationViewsToggle: document.getElementById("viewport-navigation-views-toggle"),
  navigationViews: document.getElementById("viewport-navigation-views"),
  navigationViewsClose: document.getElementById("viewport-navigation-views-close"),
  navigationBookmarkForm: document.getElementById("viewport-navigation-bookmark-form"),
  navigationBookmarkName: document.getElementById("viewport-navigation-bookmark-name"),
  navigationBookmarkSave: document.getElementById("viewport-navigation-bookmark-save"),
  navigationBookmarks: document.getElementById("viewport-navigation-bookmarks"),
  navigationRecents: document.getElementById("viewport-navigation-recents"),
};
function setStatus(phase, detail) {
  const bounded = detail === undefined ? "" : String(detail).slice(0, 240);
  if (statusEl) statusEl.textContent = bounded ? `${phase}: ${bounded}` : phase;
  // Viewport errors truncate in the one-line banner; the console panel keeps the
  // FULL detail (realm-divergence failure lists above all) scrollable + copyable.
  if (phase === "error") logConsolePanel(detail === undefined ? "viewport error" : String(detail), "err");
}

function setEditRuntimeStatus(phase, detail) {
  setStatus(phase === "playing" ? "Edit" : phase, detail);
}

// ── Boot loading overlay (boot-loading.js) ───────────────────────────────────
// One overlay per page session, mounted over the viewport canvas. Driven ONLY by real
// boot events: the connect click, reboot()'s command count, runLive's onStatus steps, the
// derived client's fetch/activation statuses, and the boot error paths.
function bootOverlayEnsure() {
  if (state.bootOverlaySettled) return;
  if (state.bootOverlay && state.bootOverlayFailed) bootOverlayReset(); // a retry gets a fresh overlay
  if (state.bootOverlay) return;
  const mount = document.getElementById("viewport-body");
  if (!mount) return;
  state.bootRuntimeError = undefined;
  state.bootOverlay = createBootLoading({ document, mount });
}

function bootOverlayDone() {
  const overlay = state.bootOverlay;
  state.bootOverlay = undefined;
  state.bootOverlaySettled = true;
  state.bootOverlayFailed = false;
  overlay?.done();
}

function bootOverlayFail(message) {
  state.bootOverlayFailed = true; // stays up with the error; settled stays false for retry
  state.bootOverlay?.fail(message);
}

function bootOverlayReset() {
  state.bootOverlay?.dispose();
  state.bootOverlay = undefined;
  state.bootOverlaySettled = false;
  state.bootOverlayFailed = false;
}

// runLive's onStatus during boot: forward loading/ready steps; remember the LAST error
// detail so the state.running === null path (no throw follows) can fail the overlay.
function bootOverlayRuntimeStep(phase, detail) {
  if (phase === "error") state.bootRuntimeError = detail;
  state.bootOverlay?.runtimeStep(phase, detail);
}

window.addEventListener("limina:studio-connect", bootOverlayEnsure);

function logConsolePanel(message, kind = "err") {
  const box = document.getElementById("log");
  if (!box) return;
  const row = document.createElement("div");
  row.className = "log-row log-" + kind;
  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = new Date().toLocaleTimeString();
  const msg = document.createElement("span");
  msg.className = "log-msg";
  msg.textContent = message;
  row.appendChild(time);
  row.appendChild(msg);
  box.prepend(row);
}

// Recorded physics op SHORT name -> full EngineOps key. worldlog.tail returns short names (the
// PhysicsCommand.op form); runLive's loadWorld expects the full op key. This mirrors
// js/src/worldlog/log.ts PHYSICS_OP_FN (the source of truth, unit-tested via worldCommandsToAuthor in
// js/test/p55_worldlog_tail.ts); duplicated here because this file is plain JS outside the bundle.
const PHYSICS_OP_FN = {
  create_world: "op_physics_create_world", add_ground: "op_physics_add_ground",
  add_box: "op_physics_add_box", add_box_material: "op_physics_add_box_material",
  add_sphere: "op_physics_add_sphere", add_capsule: "op_physics_add_capsule",
  add_static_box: "op_physics_add_static_box", add_static_sphere: "op_physics_add_static_sphere",
  add_static_capsule: "op_physics_add_static_capsule", add_character: "op_physics_add_character",
  move_character: "op_physics_move_character", remove_body: "op_physics_remove_body",
  apply_impulse: "op_physics_apply_impulse", step: "op_physics_step",
};

// WorldCommand[] (recorder) -> AuthorCommand[] (loadWorld): drop the seed marker, remap physics op
// names, pass skills through (actorId -> agentId). Mirror of worldlog.ts worldCommandsToAuthor.
export function toAuthorCommands(commands) {
  const out = [];
  for (const cmd of commands) {
    if (cmd.kind === "physics") {
      // The live viewport (+ its sim worker) runs its OWN fixed-step sim — it steps every tick. So a
      // recorded per-tick `step` op must NOT be re-authored: replaying it double-steps, and once a long
      // session has logged tens of thousands of steps, re-authoring the whole stream on reload fails
      // ("viewport unavailable"). Only SETUP/authoring physics ops (create_world, add_*, remove_body…)
      // rebuild state; `step` is pure sim output. (Root fix: don't record `step` — see recorder.ts.)
      if (cmd.op === "step") continue;
      out.push({ kind: "physics", op: PHYSICS_OP_FN[cmd.op], args: cmd.args });
    }
    else if (cmd.kind === "skill") out.push({ kind: "skill", tool: cmd.tool, input: cmd.input, agentId: cmd.actorId, perms: cmd.perms });
    // seed: dropped.
  }
  return out;
}

const val = (id) => { const el = document.getElementById(id); return el && el.value ? el.value.trim() : ""; };

// Editor session FAST-BOOT: sessions past this many recorded commands ask the host for
// worldlog.snapshotBoot (a v3 snapshot + resume cursor) and boot by snapshot restore +
// bounded tail replay instead of re-authoring the whole stream (the 7k-command boot hang).
// localStorage "limina.editor.fastboot": "off" disables; a number overrides the threshold.
const SNAPSHOT_BOOT_MIN_COMMANDS = 512;
function fastBootThreshold() {
  try {
    const raw = localStorage.getItem("limina.editor.fastboot");
    if (raw === "off") return Infinity;
    const n = Number(raw);
    if (raw !== null && Number.isFinite(n) && n >= 0) return n;
  } catch { /* storage unavailable */ }
  return SNAPSHOT_BOOT_MIN_COMMANDS;
}

const state = {
  client: undefined,
  running: undefined,
  cursor: 0,
  commands: [],
  // Editor session FAST-BOOT payload ({snapshotSeq, snapshot, bootstrapCommands}) from
  // worldlog.snapshotBoot. While set, state.commands holds ONLY the tail (seq >= snapshotSeq)
  // and reboot() hands the payload to runLive. Cleared on worldlog reset or a boot failure
  // (fall back to the full-replay path).
  bootPayload: undefined,
  // Boot loading overlay (boot-loading.js): shown from the connect click until the first
  // derived activation — or runtime-ready when there is no derived service. Settled =
  // dismissed; the overlay is a boot-only experience and never re-shows within a session.
  bootOverlay: undefined,
  bootOverlaySettled: false,
  bootOverlayFailed: false,
  // Last runLive onStatus("error") detail during boot — replayed onto the overlay when
  // runLive returns null (the environment cannot host the viewport) and no throw follows.
  bootRuntimeError: undefined,
  // Indices (into toAuthorCommands(state.commands)) of commands that FAILED authoring on a prior
  // reboot. reboot() skips these so ONE historically-bad command (e.g. an out-of-band asset the agent
  // generated once) can't wedge every future reboot. Cleared on a worldlog reset.
  quarantined: new Set(),
  rebooting: false,
  dirty: false,
  transformControls: undefined,
  transformHelper: undefined,
  gridHelper: undefined,
  selected: undefined,
  selectionGuardFrame: undefined,
  ctrlRotateDown: false,
  ctrlRotateActive: false,
  wireframeMaterials: new Map(),
  // Per-builder cues: agentId -> { helper, entityId, timeout }. Each builder's cue auto-clears
  // independently after 1500ms; a single shared RAF loop keeps every helper glued to its mesh.
  agentHighlights: new Map(),
  agentHighlightFrame: undefined,
  // In-game terrain editor (Slice 1). F4 toggles edit mode; while on, drag on the ground sculpts via
  // terrain.deform through the recorded command path. brushTool: raise | lower | smooth (1/2/3).
  editMode: false,
  brushTool: "raise",
  brush: { radius: 12, strength: 1.2, falloff: "smooth" },
  brushStroking: false,
  brushLast: 0,
  polling: false,
  // K4 (worldlog poll -> subscribe): true once worldlog/subscribe has ack'd on the CURRENT
  // client — the self-scheduling loop below degrades its poll cadence while this holds, since new
  // authoring commands now arrive as a worldlog/append push instead. Reset to false on
  // disconnect/subscribe-failure so the loop falls back to the original 1s poll.
  subscribed: false,
  // Serializes applyWorldlogBatch calls (poll() and the worldlog/append push both funnel through
  // it) so two batches arriving close together (a push landing mid-reboot) are applied ONE AT A
  // TIME instead of interleaving into state.commands / the reboot flags.
  applyingBatch: false,
  queuedBatches: [],
  strokeDid: false,
  flattenTarget: 0, // world height the flatten tool drives toward (captured at stroke start)
  spaceNav: false,  // hold Space in edit mode → a drag navigates the camera instead of sculpting
  paintMaterial: "grass", // active material for the paint tool (sand|grass|rock|dirt)
  placing: false,   // a placement round-trip is in flight — ignore further clicks until it lands
  playRuntime: undefined,
  playStart: undefined,
  playStop: undefined,
  playProgress: "",
  playCanvas: undefined,
  editRuntimeDuringPlay: undefined,
  editRestore: new RetainedEditRestore(),
  derivedEditClient: undefined,
  derivedPlayClient: undefined,
  derivedEditActivation: undefined,
  derivedEditRestartTimer: undefined,
  derivedPlayActivation: undefined,
  derivedEditResidencyUnsubscribe: undefined,
  derivedPlayResidencyUnsubscribe: undefined,
  latestEditDerivedRevision: undefined,
  editRuntimeEpoch: 0,
  historyTransition: undefined,
  connectionReset: undefined,
  navigationBusy: false,
};

// 2.0-C: the Tool Contract ribbon is the source of truth for edit mode / brush
// tool / brush options. The adapter writes controller state into the SAME state
// fields the legacy HUD + key paths use, so every edit still flows through the
// recorded write-client paths unchanged. Legacy HUD sliders write state
// directly (ribbon does not reflect them) — accepted drift while the HUD
// awaits retirement; the reverse direction (ribbon → state) is exact.
function applyRibbonBrush(brush) {
  state.brush.radius = brush.radius;
  state.brush.strength = brush.strength;
  state.brush.falloff = brush.falloff;
  state.paintMaterial = brush.material;
  // The sculpt-mode enum changed while a sculpt tool is armed.
  if (state.editMode && state.brushTool !== "paint" && state.brushTool !== "catalog") {
    state.brushTool = brush.sculptMode;
  }
  if (brushRing?.visible) brushRing.scale.set(brush.radius, brush.radius, brush.radius);
}
function applyRibbonMode(mode, brush) {
  if (mode === "select") {
    state.editMode = false;
  } else {
    state.editMode = true;
    // Water/scatter are not brush tools: brushTool keeps its last value and
    // the pointer dispatch reads the controller's active id for them.
    if (mode === "sculpt") state.brushTool = brush.sculptMode;
    else if (mode === "paint" || mode === "catalog") state.brushTool = mode;
  }
  applyRibbonBrush(brush);
  reconcileNavigationEditMode();
  updateEditModeIndicator();
  // Brush tools report their brushTool (raise/paint/…); water/scatter report
  // the ribbon id since they hold no brushTool of their own.
  const statusTool = mode === "sculpt" || mode === "paint" || mode === "catalog" ? state.brushTool : viewportTooling.controller.activeId();
  setStatus(mode === "select" ? "terrain edit: off" : "terrain edit",
    mode === "select" ? "" : `tool: ${statusTool}`);
}
const viewportTooling = createViewportTooling({
  document,
  mount: document.getElementById("viewport-tool-surface"),
  storage: {
    load: (k) => { try { const raw = localStorage.getItem(k); return raw === null ? undefined : JSON.parse(raw); } catch { return undefined; } },
    save: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage optional */ } },
  },
  onModeChange: applyRibbonMode,
  onBrushChange: applyRibbonBrush,
  // select.pick's gizmo/space/snap options are not brush state — they drive the
  // TransformControls + snap settings directly (same setters as W/E/R/X/S).
  onToolOption(toolId, key, value) {
    if (toolId !== "select.pick") return;
    if (key === "gizmo") state.transformControls?.setMode(value);
    else if (key === "space") setTransformSpace(value);
    else if (key === "snap") toggleSnapping(value);
  },
});
// Persisted ribbon state survives reload (plan: persistent modes) — apply it to
// the viewport state on boot instead of resetting the controller. Deferred past
// module evaluation: the adapter touches late-declared lets (brushRing).
queueMicrotask(() => {
  if (viewportTooling.controller.activeId() !== "select.pick") {
    applyRibbonMode(MODE_BY_TOOL[viewportTooling.controller.activeId()], viewportTooling.brushSnapshot());
  }
  // Restored gizmo options apply on boot too (persistence round-trip).
  const controller = viewportTooling.controller;
  controller.setOption("select.pick", "gizmo", controller.option("select.pick", "gizmo"));
  controller.setOption("select.pick", "space", controller.option("select.pick", "space"));
  controller.setOption("select.pick", "snap", controller.option("select.pick", "snap"));
});
// Reverse direction: legacy key paths (F4 / 1-6 / placement arm / play-state
// restore) mutate state directly, then sync the controller so the ribbon
// tracks. All adapter writes are idempotent, so the echo is a no-op.
function syncRibbonFromState() {
  const controller = viewportTooling.controller;
  if (!state.editMode) {
    controller.setActiveTool("select.pick");
    return;
  }
  if (state.brushTool !== "paint" && state.brushTool !== "catalog") {
    controller.setOption("terrain.sculpt", "mode", state.brushTool);
  }
  controller.setActiveTool(toolForBrushTool(state.brushTool));
}
// Reverse direction for the gizmo keys/buttons (W/E/R/X/S + bottom bar): the
// controller is the persisted source of truth, so key-driven changes echo up.
function syncGizmoOption(key, value) {
  viewportTooling.controller.setOption("select.pick", key, value);
}
window.__viewport = { controller: viewportTooling.controller, state }; // test hook, mirrors window.__atlas
// Derived residency window pref (navigation-stall lever): the whole 225-chunk
// window re-mounts per swap today, so weak GPUs shrink radius + raise the
// swap threshold via localStorage["limina.viewport.residency"] =
// '{"radius":5,"thresholdChunks":3}' and reload. Invalid values fall back to
// the engine defaults (7/2); bounds match runLive's own validation.
function readDerivedResidencyPref() {
  try {
    const raw = localStorage.getItem("limina.viewport.residency");
    if (raw === null) return undefined;
    const pref = JSON.parse(raw);
    const radius = Number(pref?.radius);
    const thresholdChunks = Number(pref?.thresholdChunks);
    if (!Number.isSafeInteger(radius) || radius < 2 || radius > 7) return undefined;
    if (!Number.isSafeInteger(thresholdChunks) || thresholdChunks < 1 || thresholdChunks > radius) return undefined;
    return { radius, thresholdChunks };
  } catch { return undefined; }
}
// Ribbon undo/redo (the retired HUD's one unique capability): same recorded
// authoring-undo path, rendered as plain ribbon buttons (no data-tool → the
// ribbon's active-marker ignores them).
for (const [label, title, fn] of [
  ["↶", "Undo the latest committed scene edit", () => void undoAuthoringEdit()],
  ["↷", "Reapply the latest undone scene edit", () => void redoAuthoringEdit()],
]) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tool-btn";
  btn.title = title;
  btn.textContent = label;
  btn.addEventListener("click", fn);
  document.querySelector("#viewport-tool-surface .tool-ribbon")?.appendChild(btn);
}
// The discovery response contains the runtime capability. Keep it in this module closure only: it
// must never enter DOM state, browser storage, console output, trace payloads, or status strings.
let derivedRuntimeDiscovery;
let navigationStateController;
let navigationStateUnsubscribe;
let navigationIdentity;
let navigationPreferences = Object.freeze({ mode: "orbit", speedMps: DEFAULT_NAVIGATION_SPEED_MPS });
const graphicsSettings = createGraphicsSettings({
  group: document.getElementById("viewport-graphics-quality"),
  buttons: document.querySelectorAll("[data-quality-tier]"),
  telemetry: document.getElementById("viewport-render-telemetry"),
  getRuntimeTargets: () => [state.running, state.editRuntimeDuringPlay],
  getTelemetryRuntime: () => state.running,
  storage: graphicsStorage,
});
const navigationDestination = createNavigationDestinationCoordinator({
  getContext: () => {
    const runtime = state.running;
    const client = state.derivedEditClient;
    return {
      runtime,
      client,
      isCurrent: () => state.running === runtime && state.derivedEditClient === client
        && runtime !== state.playRuntime && !state.rebooting && state.scrubLimit === undefined
        && !playLifecycle.isAuthoringLocked(),
    };
  },
  onState: ({ busy, label, code }) => {
    state.navigationBusy = busy;
    if (viewportUi.navigationGotoStatus) {
      viewportUi.navigationGotoStatus.textContent = busy ? `Loading ${label}` : code || "";
    }
    setStatus("navigation", busy ? `loading ${label}` : code || label);
    syncNavigationUi();
  },
  onCommit: ({ pose, metadata }) => {
    if (!navigationStateController || !metadata?.kind || !metadata?.label) return;
    navigationStateController.addRecent({
      kind: metadata.kind,
      label: metadata.label,
      pose: storedNavigationPose(pose),
    });
  },
  resetContext: async (context) => {
    if (state.derivedEditClient === context.client) await closeEditDerivedClient();
    if (state.running === context.runtime && !state.rebooting && state.scrubLimit === undefined
        && !playLifecycle.isAuthoringLocked()) requestEditDerivedClient();
  },
});
const pollTask = new CoalescedTask();
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const CLICK_MOVE_TOLERANCE_PX = 5;
const pointerClick = { id: undefined, x: 0, y: 0 };
// 2.0-C box select: Shift+drag with the select.pick ribbon tool draws a screen-space
// marquee; pointerup selects every entity whose mesh projects inside the rect. A drag
// shorter than BOX_SELECT_MIN_DRAG_PX falls through to the normal single-pick click.
const BOX_SELECT_MIN_DRAG_PX = 4;
const boxSelect = { active: false, pointerId: undefined, startX: 0, startY: 0, x: 0, y: 0 };
// Scratch for the marquee projection loop — no per-entity allocation.
const marqueeScratch = new THREE.Vector3();
const SNAP_DEFAULTS = {
  translate: 0.5,
  rotateDegrees: 15,
  scale: 0.1,
};
const viewportOptions = {
  snapEnabled: false,
  translateSnap: SNAP_DEFAULTS.translate,
  rotateSnapDegrees: SNAP_DEFAULTS.rotateDegrees,
  scaleSnap: SNAP_DEFAULTS.scale,
  transformSpace: "world",
  gridVisible: true,
  wireframeVisible: false,
};

function normalizePositiveNumber(value, fallback) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : fallback;
}

function updateToggleButton(button, active, activeText, inactiveText) {
  if (!button) return;
  button.classList.toggle("active", active);
  button.setAttribute("aria-pressed", active ? "true" : "false");
  button.textContent = active ? activeText : inactiveText;
}

function syncViewportUi() {
  if (viewportUi.snapTranslate) viewportUi.snapTranslate.value = String(viewportOptions.translateSnap);
  if (viewportUi.snapRotate) viewportUi.snapRotate.value = String(viewportOptions.rotateSnapDegrees);
  if (viewportUi.snapScale) viewportUi.snapScale.value = String(viewportOptions.scaleSnap);
  updateToggleButton(viewportUi.snapToggle, viewportOptions.snapEnabled, "Snap on", "Snap off");
  updateToggleButton(viewportUi.spaceToggle, viewportOptions.transformSpace === "local", "Local", "Global");
  updateToggleButton(viewportUi.gridToggle, viewportOptions.gridVisible, "Grid on", "Grid off");
  updateToggleButton(viewportUi.wireframeToggle, viewportOptions.wireframeVisible, "Wire on", "Wire off");
}

function storedNavigationPose(pose) {
  return parseNavigationPose({
    position: [...pose.position],
    quaternion: [...pose.quaternion],
    target: [...pose.target],
    mode: pose.mode,
  });
}

function runtimeNavigationPose(pose) {
  const parsed = parseNavigationPose(pose);
  return Object.freeze({
    position: parsed.position,
    quaternion: parsed.quaternion,
    up: Object.freeze([0, 1, 0]),
    target: parsed.target,
    mode: parsed.mode,
    speedMps: navigationPreferences.speedMps,
  });
}

function applyNavigationPreferencesToRuntime() {
  const navigation = state.running?.editorNavigation;
  if (!navigation) return;
  try {
    navigation.setSpeed(navigationPreferences.speedMps);
    navigation.setMode(state.editMode ? "orbit" : navigationPreferences.mode);
  } catch (error) {
    surfaceViewportWarning("navigation preferences failed", error);
  }
}

function releaseNavigationState() {
  navigationStateUnsubscribe?.();
  navigationStateUnsubscribe = undefined;
  navigationStateController = undefined;
  navigationIdentity = undefined;
  navigationPreferences = Object.freeze({ mode: "orbit", speedMps: DEFAULT_NAVIGATION_SPEED_MPS });
  renderNavigationViews();
  syncNavigationUi();
}

function bindNavigationIdentity(snapshot) {
  const identity = { projectId: snapshot?.projectId, branchId: snapshot?.branchId };
  if (navigationIdentity?.projectId === identity.projectId && navigationIdentity?.branchId === identity.branchId) return;
  navigationStateUnsubscribe?.();
  try {
    navigationStateController = createNavigationStateController({ storage: graphicsStorage, identity });
    navigationIdentity = Object.freeze(identity);
    navigationStateUnsubscribe = navigationStateController.subscribe(({ state: navigationState }) => {
      const preferencesChanged = navigationPreferences.mode !== navigationState.preferences.mode
        || navigationPreferences.speedMps !== navigationState.preferences.speedMps;
      navigationPreferences = navigationState.preferences;
      if (preferencesChanged) applyNavigationPreferencesToRuntime();
      renderNavigationViews();
      syncNavigationUi();
    }, { emitCurrent: true });
  } catch (error) {
    navigationStateController = undefined;
    navigationIdentity = undefined;
    surfaceViewportWarning("navigation state unavailable", error);
  }
}

function navigationListItem(entry, kind) {
  const item = document.createElement("li");
  const activate = document.createElement("button");
  activate.type = "button";
  activate.className = "navigation-view-activate";
  activate.dataset.navigationEntry = entry.id;
  activate.dataset.navigationKind = kind;
  activate.textContent = kind === "bookmark" ? entry.name : entry.label;
  item.appendChild(activate);
  if (kind === "bookmark") {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "navigation-view-remove";
    remove.dataset.navigationRemove = entry.id;
    remove.setAttribute("aria-label", `Remove ${entry.name}`);
    remove.title = "Remove bookmark";
    remove.textContent = "×";
    item.appendChild(remove);
  }
  return item;
}

function renderNavigationList(container, entries, kind) {
  if (!container) return;
  container.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "muted";
    empty.textContent = kind === "bookmark" ? "No bookmarks" : "No recent locations";
    container.appendChild(empty);
    return;
  }
  for (const entry of entries) container.appendChild(navigationListItem(entry, kind));
}

function renderNavigationViews() {
  const navigationState = navigationStateController?.snapshot();
  renderNavigationList(viewportUi.navigationBookmarks, navigationState?.bookmarks ?? [], "bookmark");
  renderNavigationList(viewportUi.navigationRecents, navigationState?.recents ?? [], "recent");
}

function closeNavigationPanel(panel, toggle) {
  if (panel) panel.hidden = true;
  toggle?.setAttribute("aria-expanded", "false");
}

function closeNavigationPanels() {
  closeNavigationPanel(viewportUi.navigationGoto, viewportUi.navigationGotoToggle);
  closeNavigationPanel(viewportUi.navigationSearch, viewportUi.navigationSearchToggle);
  closeNavigationPanel(viewportUi.navigationViews, viewportUi.navigationViewsToggle);
}

function navigationDiscreteReady() {
  return Boolean(state.running?.editorNavigation && state.derivedEditClient && state.scrubLimit === undefined
    && !state.rebooting && !state.navigationBusy && !playLifecycle.isAuthoringLocked());
}

function syncNavigationUi() {
  const navigation = state.running?.editorNavigation;
  const locked = playLifecycle.isAuthoringLocked();
  const localReady = Boolean(navigation) && !locked && !state.rebooting && !state.navigationBusy;
  const mode = navigation?.mode?.() ?? navigationPreferences.mode;
  for (const [button, value] of [[viewportUi.navigationOrbit, "orbit"], [viewportUi.navigationFly, "fly"]]) {
    if (!button) continue;
    const selected = mode === value;
    button.setAttribute("aria-checked", String(selected));
    button.tabIndex = selected ? 0 : -1;
    button.disabled = !localReady || (state.editMode && value === "fly");
  }
  if (viewportUi.navigationSpeed && document.activeElement !== viewportUi.navigationSpeed) {
    viewportUi.navigationSpeed.value = String(navigation?.speed?.() ?? navigationPreferences.speedMps);
  }
  if (viewportUi.navigationSpeed) viewportUi.navigationSpeed.disabled = !localReady;
  const discreteReady = navigationDiscreteReady();
  if (viewportUi.navigationFocus) viewportUi.navigationFocus.disabled = !discreteReady || !state.selected;
  if (viewportUi.navigationWorld) viewportUi.navigationWorld.disabled = !discreteReady || !state.running?.derivedWorldBounds?.();
  if (viewportUi.navigationGotoToggle) viewportUi.navigationGotoToggle.disabled = !discreteReady;
  if (viewportUi.navigationSearchToggle) viewportUi.navigationSearchToggle.disabled = !discreteReady;
  if (viewportUi.navigationViewsToggle) viewportUi.navigationViewsToggle.disabled = !localReady || !navigationStateController || state.navigationBusy;
  if (viewportUi.navigationBookmarkSave) viewportUi.navigationBookmarkSave.disabled = !localReady || !navigationStateController || state.navigationBusy;
  for (const button of document.querySelectorAll("[data-navigation-entry]")) button.disabled = !discreteReady;
  document.body.classList.toggle("editor-navigation-fly", mode === "fly" && localReady);
  if (locked) closeNavigationPanels();
}

function setNavigationMode(modeInput, { persist = true } = {}) {
  const mode = parseNavigationMode(modeInput);
  if (state.editMode && mode === "fly") {
    setStatus("navigation", "Fly is unavailable while terrain editing");
    return false;
  }
  const navigation = state.running?.editorNavigation;
  if (!navigation || playLifecycle.isAuthoringLocked()) return false;
  navigation.setMode(mode);
  if (persist && navigationStateController) navigationStateController.setMode(mode);
  else navigationPreferences = Object.freeze({ ...navigationPreferences, mode });
  syncNavigationUi();
  return true;
}

function setNavigationSpeed(value, { persist = true } = {}) {
  const speedMps = parseNavigationSpeed(Number(value));
  const navigation = state.running?.editorNavigation;
  if (!navigation || playLifecycle.isAuthoringLocked()) return false;
  navigation.setSpeed(speedMps);
  if (persist && navigationStateController) navigationStateController.setSpeed(speedMps);
  else navigationPreferences = Object.freeze({ ...navigationPreferences, speedMps });
  syncNavigationUi();
  return true;
}

function openNavigationGoto() {
  const pose = state.running?.editorNavigation?.snapshot?.();
  if (!pose || !navigationDiscreteReady()) return;
  closeNavigationPanel(viewportUi.navigationViews, viewportUi.navigationViewsToggle);
  closeNavigationPanel(viewportUi.navigationSearch, viewportUi.navigationSearchToggle);
  if (viewportUi.navigationX) viewportUi.navigationX.value = String(pose.target[0]);
  if (viewportUi.navigationY) viewportUi.navigationY.value = String(pose.target[1]);
  if (viewportUi.navigationZ) viewportUi.navigationZ.value = String(pose.target[2]);
  if (viewportUi.navigationGotoStatus) viewportUi.navigationGotoStatus.textContent = "";
  if (viewportUi.navigationGoto) viewportUi.navigationGoto.hidden = false;
  viewportUi.navigationGotoToggle?.setAttribute("aria-expanded", "true");
  viewportUi.navigationX?.focus();
  viewportUi.navigationX?.select?.();
}

function renderNavigationSearch() {
  const container = viewportUi.navigationSearchResults;
  if (!container) return;
  container.replaceChildren();
  const query = viewportUi.navigationSearchInput?.value.trim() ?? "";
  if (query.length === 0) return;
  let results;
  try { results = state.running?.searchDerivedNavigation?.(query, 20) ?? []; }
  catch (error) { container.textContent = error instanceof Error ? error.message : "Search unavailable"; return; }
  if (results.length === 0) { container.textContent = "No matches"; return; }
  for (const entry of results) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "navigation-search-result";
    button.setAttribute("role", "option");
    button.dataset.navigationSearchMap = entry.designRef.mapId;
    button.dataset.navigationSearchKind = entry.designRef.kind;
    button.dataset.navigationSearchId = entry.designRef.id;
    const label = document.createElement("strong");
    label.textContent = entry.label;
    const detail = document.createElement("span");
    detail.textContent = `${entry.kind}  ${entry.position[0]}, ${entry.position[1]}`;
    button.append(label, detail);
    button.addEventListener("click", () => navigateToSearchResult(entry));
    container.appendChild(button);
  }
}

function openNavigationSearch() {
  if (!navigationDiscreteReady()) return;
  closeNavigationPanel(viewportUi.navigationGoto, viewportUi.navigationGotoToggle);
  closeNavigationPanel(viewportUi.navigationViews, viewportUi.navigationViewsToggle);
  if (viewportUi.navigationSearch) viewportUi.navigationSearch.hidden = false;
  viewportUi.navigationSearchToggle?.setAttribute("aria-expanded", "true");
  renderNavigationSearch();
  viewportUi.navigationSearchInput?.focus();
  viewportUi.navigationSearchInput?.select?.();
}

function navigateToSearchResult(entry) {
  const navigation = state.running?.editorNavigation;
  if (!navigation || !navigationDiscreteReady()) return;
  leaveWorldOverviewPresentation();
  const current = navigation.snapshot();
  const provisional = navigation.destinationPose([entry.position[0], current.target[1], entry.position[1]], entry.radiusM ?? 32);
  void navigateToPose(provisional, {
    kind: "poi",
    label: entry.label.slice(0, 64),
    designRef: entry.designRef,
  }, {
    resolvePose: ({ context }) => {
      const height = context.runtime.derivedTerrainHeightAt(entry.position[0], entry.position[1]);
      if (height === null) throw Object.assign(new Error("POI terrain is unavailable"), { code: "POI_TERRAIN_UNAVAILABLE" });
      return context.navigation.destinationPose([entry.position[0], height, entry.position[1]], entry.radiusM ?? 32);
    },
  });
}

function openNavigationViews() {
  if (!state.running?.editorNavigation || !navigationStateController || playLifecycle.isAuthoringLocked()) return;
  closeNavigationPanel(viewportUi.navigationGoto, viewportUi.navigationGotoToggle);
  renderNavigationViews();
  if (viewportUi.navigationViews) viewportUi.navigationViews.hidden = false;
  viewportUi.navigationViewsToggle?.setAttribute("aria-expanded", "true");
  viewportUi.navigationBookmarkName?.focus();
}

async function navigateToPose(pose, metadata, { resolvePose } = {}) {
  try {
    const result = await navigationDestination.navigate(pose, { label: metadata.label, metadata, resolvePose });
    closeNavigationPanels();
    return result;
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "NAVIGATION_FAILED";
    if (viewportUi.navigationGotoStatus) viewportUi.navigationGotoStatus.textContent = code;
    setStatus("navigation", code);
    return undefined;
  }
}

function leaveWorldOverviewPresentation() {
  try { state.running?.setWorldOverviewPresentation?.(false); }
  catch (error) { surfaceViewportWarning("world overview presentation restore failed", error); }
}

function focusNavigationSelection() {
  const navigation = state.running?.editorNavigation;
  const selected = state.selected;
  if (!navigation || !selected?.mesh || !navigationDiscreteReady()) {
    setStatus("navigation", selected ? "destination unavailable" : "select an entity first");
    return;
  }
  let pose;
  leaveWorldOverviewPresentation();
  try { pose = navigation.objectPose(selected.mesh); }
  catch (error) { surfaceViewportWarning("selection focus failed", error); return; }
  const label = `Selection ${selected.id}`.slice(0, 64);
  void navigateToPose(pose, { kind: "selection", label });
}

function frameNavigationWorld() {
  const runtime = state.running;
  const navigation = runtime?.editorNavigation;
  const bounds = runtime?.derivedWorldBounds?.();
  if (!navigation || !bounds || !navigationDiscreteReady()) {
    setStatus("navigation", "world overview unavailable");
    return;
  }
  let pose;
  try { pose = navigation.worldPose(bounds); }
  catch (error) { surfaceViewportWarning("world framing failed", error); return; }
  void navigateToPose(pose, { kind: "world", label: "World" }, {
    resolvePose: ({ context }) => {
      const currentBounds = context.runtime.derivedWorldBounds?.();
      if (!currentBounds) throw Object.assign(new Error("world overview is unavailable after activation"), { code: "WORLD_OVERVIEW_UNAVAILABLE" });
      return context.navigation.worldPose(currentBounds);
    },
  }).then((result) => {
    if (result) runtime.setWorldOverviewPresentation?.(true);
    else leaveWorldOverviewPresentation();
  });
}

function applySnapSettings() {
  const controls = state.transformControls;
  if (!controls) return;
  const translateSnap = viewportOptions.snapEnabled ? viewportOptions.translateSnap : null;
  const rotateSnap = viewportOptions.snapEnabled ? THREE.MathUtils.degToRad(viewportOptions.rotateSnapDegrees) : null;
  const scaleSnap = viewportOptions.snapEnabled ? viewportOptions.scaleSnap : null;
  controls.setTranslationSnap?.(translateSnap);
  controls.setRotationSnap?.(rotateSnap);
  controls.setScaleSnap?.(scaleSnap);
}

function applyTransformSpace() {
  state.transformControls?.setSpace?.(viewportOptions.transformSpace);
}

function removeGridHelper() {
  const grid = state.gridHelper;
  if (!grid) return;
  try { grid.parent?.remove(grid); } catch { /* ignore */ }
  try { grid.geometry?.dispose?.(); } catch { /* ignore */ }
  try { disposeMaterial(grid.material); } catch { /* ignore */ }
  state.gridHelper = undefined;
}

function markEditorHelper(object) {
  object.userData.editorHelper = true;
  object.traverse?.((child) => { child.userData.editorHelper = true; });
}

function installGridHelper(running) {
  removeGridHelper();
  if (!viewportOptions.gridVisible || !running?.scene) return;
  const grid = new THREE.GridHelper(64, 64, 0x34465a, 0x22303d);
  grid.name = "limina-editor-grid";
  markEditorHelper(grid);
  grid.raycast = () => {};
  const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
  for (const material of materials) {
    material.transparent = true;
    material.opacity = 0.28;
    material.depthWrite = false;
  }
  running.scene.add(grid);
  state.gridHelper = grid;
}

function eachMaterial(material, fn) {
  if (Array.isArray(material)) {
    for (const item of material) if (item) fn(item);
  } else if (material) {
    fn(material);
  }
}

function restoreWireframeMaterials() {
  for (const [material, originalWireframe] of state.wireframeMaterials) {
    if (material && material.wireframe !== originalWireframe) {
      material.wireframe = originalWireframe;
      // Node materials (WebGPU/WebGL2 backend) cache a render pipeline keyed on state; toggling
      // wireframe changes the primitive topology (triangles↔lines), so the pipeline MUST be
      // rebuilt or the mesh renders nothing (looks like the entity vanished). Force the recompile.
      material.needsUpdate = true;
    }
  }
  state.wireframeMaterials.clear();
}

function applyWireframeMode(running) {
  restoreWireframeMaterials();
  if (!viewportOptions.wireframeVisible || !running?.scene) return;
  running.scene.traverse((object) => {
    if (!object?.isMesh || object.userData?.editorHelper) return;
    eachMaterial(object.material, (material) => {
      if (!state.wireframeMaterials.has(material)) state.wireframeMaterials.set(material, material.wireframe === true);
      if (material.wireframe !== true) {
        material.wireframe = true;
        material.needsUpdate = true; // rebuild the pipeline for line topology (see restore)
      }
    });
  });
}

function toggleSnapping(force) {
  viewportOptions.snapEnabled = force === undefined ? !viewportOptions.snapEnabled : force === true;
  applySnapSettings();
  syncViewportUi();
}

function setTransformSpace(space) {
  viewportOptions.transformSpace = space === "local" ? "local" : "world";
  applyTransformSpace();
  syncViewportUi();
}

function toggleGrid(force) {
  viewportOptions.gridVisible = force === undefined ? !viewportOptions.gridVisible : force === true;
  if (viewportOptions.gridVisible) installGridHelper(state.running);
  else removeGridHelper();
  syncViewportUi();
}

function toggleWireframe(force) {
  viewportOptions.wireframeVisible = force === undefined ? !viewportOptions.wireframeVisible : force === true;
  applyWireframeMode(state.running);
  syncViewportUi();
}

function bindViewportUi() {
  viewportUi.play?.addEventListener("click", () => { void startPlay(); });
  viewportUi.pause?.addEventListener("click", () => { void togglePlayPause(); });
  viewportUi.stop?.addEventListener("click", () => { void stopPlay(); });
  viewportUi.snapToggle?.addEventListener("click", () => { toggleSnapping(); syncGizmoOption("snap", viewportOptions.snapEnabled); });
  viewportUi.spaceToggle?.addEventListener("click", () => {
    setTransformSpace(viewportOptions.transformSpace === "local" ? "world" : "local");
    syncGizmoOption("space", viewportOptions.transformSpace);
  });
  viewportUi.gridToggle?.addEventListener("click", () => toggleGrid());
  viewportUi.wireframeToggle?.addEventListener("click", () => toggleWireframe());
  viewportUi.navigationOrbit?.addEventListener("click", () => setNavigationMode("orbit"));
  viewportUi.navigationFly?.addEventListener("click", () => setNavigationMode("fly"));
  viewportUi.navigationMode?.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const mode = event.key === "ArrowLeft" ? "orbit" : "fly";
    if (setNavigationMode(mode)) (mode === "orbit" ? viewportUi.navigationOrbit : viewportUi.navigationFly)?.focus();
  });
  viewportUi.navigationSpeed?.addEventListener("change", () => {
    try { setNavigationSpeed(viewportUi.navigationSpeed.value); }
    catch (error) {
      viewportUi.navigationSpeed.value = String(state.running?.editorNavigation?.speed?.() ?? navigationPreferences.speedMps);
      setStatus("navigation", error instanceof Error ? error.message : "invalid speed");
    }
  });
  viewportUi.navigationFocus?.addEventListener("click", focusNavigationSelection);
  viewportUi.navigationWorld?.addEventListener("click", frameNavigationWorld);
  viewportUi.navigationSearchToggle?.addEventListener("click", () => {
    if (viewportUi.navigationSearch?.hidden === false) closeNavigationPanel(viewportUi.navigationSearch, viewportUi.navigationSearchToggle);
    else openNavigationSearch();
  });
  viewportUi.navigationSearchClose?.addEventListener("click", () => closeNavigationPanel(viewportUi.navigationSearch, viewportUi.navigationSearchToggle));
  viewportUi.navigationSearchInput?.addEventListener("input", renderNavigationSearch);
  viewportUi.navigationGotoToggle?.addEventListener("click", () => {
    if (viewportUi.navigationGoto?.hidden === false) closeNavigationPanel(viewportUi.navigationGoto, viewportUi.navigationGotoToggle);
    else openNavigationGoto();
  });
  viewportUi.navigationGotoClose?.addEventListener("click", () => closeNavigationPanel(viewportUi.navigationGoto, viewportUi.navigationGotoToggle));
  viewportUi.navigationGotoCancel?.addEventListener("click", () => closeNavigationPanel(viewportUi.navigationGoto, viewportUi.navigationGotoToggle));
  viewportUi.navigationGoto?.addEventListener("submit", (event) => {
    event.preventDefault();
    const navigation = state.running?.editorNavigation;
    if (!navigation || !navigationDiscreteReady()) return;
    leaveWorldOverviewPresentation();
    try {
      const values = [viewportUi.navigationX?.value, viewportUi.navigationY?.value, viewportUi.navigationZ?.value];
      if (values.some((value) => typeof value !== "string" || value.trim() === "")) throw new TypeError("X, Y, and Z are required");
      const target = [
        parseNavigationCoordinate(Number(values[0]), "X"),
        parseNavigationCoordinate(Number(values[1]), "Y"),
        parseNavigationCoordinate(Number(values[2]), "Z"),
      ];
      const pose = navigation.destinationPose(target);
      const label = `X ${target[0]} Z ${target[2]}`.slice(0, 64);
      void navigateToPose(pose, { kind: "coordinate", label });
    } catch (error) {
      if (viewportUi.navigationGotoStatus) viewportUi.navigationGotoStatus.textContent = error instanceof Error ? error.message : "Invalid coordinates";
    }
  });
  viewportUi.navigationViewsToggle?.addEventListener("click", () => {
    if (viewportUi.navigationViews?.hidden === false) closeNavigationPanel(viewportUi.navigationViews, viewportUi.navigationViewsToggle);
    else openNavigationViews();
  });
  viewportUi.navigationViewsClose?.addEventListener("click", () => closeNavigationPanel(viewportUi.navigationViews, viewportUi.navigationViewsToggle));
  viewportUi.navigationBookmarkForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const pose = state.running?.editorNavigation?.snapshot?.();
    if (!pose || !navigationStateController || state.navigationBusy) return;
    try {
      navigationStateController.addBookmark(viewportUi.navigationBookmarkName?.value ?? "", storedNavigationPose(pose));
      if (viewportUi.navigationBookmarkName) viewportUi.navigationBookmarkName.value = "";
      renderNavigationViews();
    } catch (error) {
      setStatus("navigation", error instanceof Error ? error.message : "bookmark failed");
    }
  });
  viewportUi.navigationViews?.addEventListener("click", (event) => {
    const remove = event.target.closest?.("[data-navigation-remove]");
    if (remove) {
      navigationStateController?.removeBookmark(remove.dataset.navigationRemove);
      renderNavigationViews();
      return;
    }
    const activate = event.target.closest?.("[data-navigation-entry]");
    if (!activate || !navigationStateController || !navigationDiscreteReady()) return;
    const navigationState = navigationStateController.snapshot();
    const kind = activate.dataset.navigationKind;
    const entry = kind === "bookmark"
      ? navigationState.bookmarks.find((candidate) => candidate.id === activate.dataset.navigationEntry)
      : navigationState.recents.find((candidate) => candidate.id === activate.dataset.navigationEntry);
    if (!entry) return;
    leaveWorldOverviewPresentation();
    const label = kind === "bookmark" ? entry.name : entry.label;
    void navigateToPose(runtimeNavigationPose(entry.pose), { kind: kind === "bookmark" ? "bookmark" : entry.kind, label });
  });

  viewportUi.snapTranslate?.addEventListener("change", () => {
    viewportOptions.translateSnap = normalizePositiveNumber(viewportUi.snapTranslate.value, SNAP_DEFAULTS.translate);
    applySnapSettings();
    syncViewportUi();
  });
  viewportUi.snapRotate?.addEventListener("change", () => {
    viewportOptions.rotateSnapDegrees = normalizePositiveNumber(viewportUi.snapRotate.value, SNAP_DEFAULTS.rotateDegrees);
    applySnapSettings();
    syncViewportUi();
  });
  viewportUi.snapScale?.addEventListener("change", () => {
    viewportOptions.scaleSnap = normalizePositiveNumber(viewportUi.snapScale.value, SNAP_DEFAULTS.scale);
    applySnapSettings();
    syncViewportUi();
  });
  syncViewportUi();
  renderNavigationViews();
  syncNavigationUi();
}

function syncPlayUi(view = playLifecycle.view()) {
  const locked = view.authoringLocked;
  document.body.classList.toggle("editor-authoring-locked", locked);
  document.body.dataset.playPhase = view.phase;
  if (viewportUi.play) viewportUi.play.disabled = view.phase !== "edit";
  if (viewportUi.pause) {
    viewportUi.pause.disabled = view.phase !== "playing" && view.phase !== "paused";
    viewportUi.pause.textContent = view.phase === "paused" ? "▶" : "⏸";
    viewportUi.pause.title = view.phase === "paused" ? "Resume Play (F7)" : "Pause Play (F7)";
    viewportUi.pause.setAttribute("aria-label", view.phase === "paused" ? "Resume Play" : "Pause Play");
    viewportUi.pause.setAttribute("aria-pressed", view.phase === "paused" ? "true" : "false");
  }
  if (viewportUi.stop) viewportUi.stop.disabled = view.phase === "edit" || view.phase === "stopping";
  const label = view.phase[0].toUpperCase() + view.phase.slice(1);
  if (viewportUi.playState) {
    viewportUi.playState.textContent = `${label}${view.stale ? " · stale" : ""}`;
    viewportUi.playState.dataset.phase = view.phase;
  }
  if (viewportUi.playSource) {
    const source = view.snapshot?.source;
    viewportUi.playSource.textContent = source
      ? `${source.projectId} · r${source.revision} · ${source.headHash.slice(0, 15)}…${view.stale ? " · newer edits buffered" : ""}`
      : view.error ? `error · ${view.error}` : view.phase === "starting" && state.playProgress ? state.playProgress : "no Play snapshot";
    viewportUi.playSource.title = source ? `${source.projectId} revision ${source.revision} · ${source.headHash}` : view.error;
  }
  for (const control of [viewportUi.snapToggle, viewportUi.snapTranslate, viewportUi.snapRotate, viewportUi.snapScale, viewportUi.spaceToggle]) {
    if (control) control.disabled = locked;
  }
  viewportToolsEl?.setAttribute("aria-disabled", String(locked));
  if (locked) {
    hideBrushRing();
    hidePlaceGhost();
  } else {
    updateEditModeIndicator();
  }
  syncNavigationUi();
  window.dispatchEvent(new CustomEvent("limina:authoring-mode", { detail: { locked, phase: view.phase } }));
}

// K4 (worldlog poll -> subscribe): the push notification method name. Mirrors
// js/src/net/protocol.ts WORLDLOG_METHODS.append — duplicated here because this file is plain JS
// outside the bundle (same reason PHYSICS_OP_FN above is duplicated from log.ts).
const WORLDLOG_APPEND_METHOD = "worldlog/append";
const DERIVED_DISCOVERY_SKILL = "runtime.derivedDiscovery";
const DERIVED_PLAY_START_TIMEOUT_MS = 30_000;
const DERIVED_CLOSE_BARRIER_TIMEOUT_MS = 2_000;
let viewportConnectionGeneration = 0;

function sameDerivedSource(derived, authoritative) {
  return derived?.source?.revision === authoritative?.revision &&
    derived?.source?.headHash === authoritative?.headHash;
}

function assertRuntimeDerivedRevision(runtime, snapshot) {
  const active = runtime.derivedRevision();
  if (active?.manifestHash !== snapshot?.manifestHash || active?.revision !== snapshot?.source?.revision ||
      active?.headHash !== snapshot?.source?.headHash) {
    throw new Error("DERIVED_RUNTIME_COMMIT_MISMATCH");
  }
}

function derivedStatusDetail(status) {
  if (Number.isSafeInteger(status?.revision) && typeof status?.manifestHash === "string") {
    return `r${status.revision} · ${status.manifestHash.slice(0, 15)}…`;
  }
  return typeof status?.code === "string" ? status.code.slice(0, 64) : "DERIVED_RUNTIME_UNAVAILABLE";
}

function invalidateEditDerivedRevision() {
  const editRuntime = state.editRuntimeDuringPlay ?? (state.running === state.playRuntime ? undefined : state.running);
  const hadDerived = state.derivedEditActivation !== undefined
    || state.latestEditDerivedRevision !== undefined
    || editRuntime?.derivedRevision?.() != null;
  state.editRuntimeEpoch++;
  state.latestEditDerivedRevision = undefined;
  if (!hadDerived) return false;
  if (playLifecycle.isAuthoringLocked() && state.editRestore.hasPending()) {
    state.editRestore.peek().forceReboot = true;
  } else {
    state.dirty = true;
  }
  return true;
}

function releaseEditDerivedResidency() {
  const unsubscribe = state.derivedEditResidencyUnsubscribe;
  state.derivedEditResidencyUnsubscribe = undefined;
  try { unsubscribe?.(); } catch { /* runtime teardown must continue */ }
}

function releasePlayDerivedResidency() {
  const unsubscribe = state.derivedPlayResidencyUnsubscribe;
  state.derivedPlayResidencyUnsubscribe = undefined;
  try { unsubscribe?.(); } catch { /* runtime teardown must continue */ }
}

function subscribeDerivedResidency(runtime, client, isCurrent, failureCode) {
  let closed = false;
  let pending;
  let flushing = false;

  const flush = async () => {
    try {
      while (!closed && isCurrent() && pending !== undefined) {
        const residency = pending;
        pending = undefined;
        await client.setResidency(residency);
      }
    } catch {
      if (!closed && isCurrent()) setStatus("derived", failureCode);
    } finally {
      flushing = false;
      if (!closed && isCurrent() && pending !== undefined) {
        flushing = true;
        void flush();
      }
    }
  };

  const unsubscribe = runtime.subscribeDerivedTerrainResidency((residency) => {
    if (closed || !isCurrent()) return;
    pending = residency;
    if (flushing) return;
    flushing = true;
    void flush();
  });
  return () => {
    if (closed) return;
    closed = true;
    pending = undefined;
    unsubscribe();
  };
}

async function closeEditDerivedClient() {
  if (state.derivedEditRestartTimer !== undefined) {
    clearTimeout(state.derivedEditRestartTimer);
    state.derivedEditRestartTimer = undefined;
  }
  const client = state.derivedEditClient;
  const activation = state.derivedEditActivation;
  releaseEditDerivedResidency();
  state.derivedEditClient = undefined;
  syncNavigationUi();
  state.editRuntimeEpoch++;
  const settled = Promise.all([
    client?.close() ?? Promise.resolve(),
    activation?.catch(() => undefined) ?? Promise.resolve(),
  ]);
  let timer;
  try {
    await Promise.race([
      settled,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("DERIVED_EDIT_CLOSE_TIMEOUT")), DERIVED_CLOSE_BARRIER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function rejectPlayDerivedActivation(code) {
  const pending = state.derivedPlayActivation;
  if (!pending || pending.settled) return;
  pending.settled = true;
  clearTimeout(pending.timer);
  pending.reject(new Error(code));
}

async function closePlayDerivedClient() {
  const client = state.derivedPlayClient;
  releasePlayDerivedResidency();
  state.derivedPlayClient = undefined;
  rejectPlayDerivedActivation("DERIVED_PLAY_CLOSED");
  if (!client) return;
  await client.close();
}

async function closeDerivedClients({ forgetDiscovery = false } = {}) {
  if (forgetDiscovery) derivedRuntimeDiscovery = undefined;
  await Promise.allSettled([closeEditDerivedClient(), closePlayDerivedClient()]);
}

async function discoverDerivedRuntime(client) {
  try {
    const discovery = await client.callTool(DERIVED_DISCOVERY_SKILL, {});
    if (state.client !== client) return undefined;
    // createDerivedRuntimeClient validates the capability before it is ever sent to a worker. Do
    // not inspect, clone, stringify, or surface this object here.
    derivedRuntimeDiscovery = discovery;
    return discovery;
  } catch {
    if (state.client === client) {
      derivedRuntimeDiscovery = undefined;
      setStatus("derived", "DISCOVERY_UNAVAILABLE");
    }
    return undefined;
  }
}

async function requireDerivedDiscovery() {
  if (derivedRuntimeDiscovery !== undefined) return derivedRuntimeDiscovery;
  const client = state.client;
  if (!client) throw new Error("DERIVED_DISCOVERY_UNAVAILABLE");
  const discovery = await discoverDerivedRuntime(client);
  if (discovery === undefined) throw new Error("DERIVED_DISCOVERY_UNAVAILABLE");
  return discovery;
}

function derivedMainRealmContentAccess() {
  const discovery = derivedRuntimeDiscovery;
  if (discovery === undefined) throw new Error("DERIVED_DISCOVERY_UNAVAILABLE");
  return Object.freeze({
    baseUrl: discovery.baseUrl,
    token: discovery.token,
    projectId: discovery.projectId,
    branchId: discovery.branchId,
  });
}

function activateEditDerivedRevision(snapshot, { signal } = {}) {
  const runtime = state.running;
  const epoch = state.editRuntimeEpoch;
  if (!runtime || runtime === state.playRuntime || state.scrubLimit !== undefined ||
      state.rebooting || playLifecycle.isAuthoringLocked()) {
    throw new Error("Edit derived presentation is not available");
  }
  // Boot overlay: the manifest's real tx/tz chunk grid replaces the shimmer — the
  // loading screen now shows THIS world's island shape being carried in.
  state.bootOverlay?.setManifest(snapshot?.manifest);
  let activation;
  activation = (async () => {
    try {
      await runtime.activateDerivedRevision(snapshot, { signal, contentAccess: derivedMainRealmContentAccess() });
    assertRuntimeDerivedRevision(runtime, snapshot);
    if (signal?.aborted || epoch !== state.editRuntimeEpoch || state.running !== runtime ||
        state.scrubLimit !== undefined || state.rebooting || playLifecycle.isAuthoringLocked()) {
      throw new Error("Edit runtime changed during derived activation");
      }
    } catch (error) {
      // The client ack only carries a code; the CAUSE must reach the status line
      // or an activation loop is undebuggable (a real incident: rejected in a
      // loop with no visible reason).
      setStatus("derived", `ACTIVATION_FAILED ${error?.message ?? error}`);
      throw error;
    }
    state.latestEditDerivedRevision = snapshot;
    bindNavigationIdentity(snapshot);
  })().finally(() => {
    if (state.derivedEditActivation === activation) {
      state.derivedEditActivation = undefined;
      if (!state.derivedEditClient && state.scrubLimit === undefined && !state.historyTransition &&
          !state.rebooting && !playLifecycle.isAuthoringLocked()) requestEditDerivedClient();
    }
  });
  state.derivedEditActivation = activation;
  return activation;
}

async function ensureEditDerivedClient() {
  if (state.derivedEditClient || !state.running || state.running === state.playRuntime ||
      state.scrubLimit !== undefined || state.historyTransition || playLifecycle.isAuthoringLocked()) return;
  const discovery = await requireDerivedDiscovery();
  if (state.derivedEditClient || !state.running || state.running === state.playRuntime ||
      state.scrubLimit !== undefined || state.historyTransition || playLifecycle.isAuthoringLocked()) return;
  let client;
  client = createDerivedRuntimeClient({
    activate: activateEditDerivedRevision,
    onStatus: (status) => {
      if (state.derivedEditClient !== client) return;
      // Boot overlay: the fetch seam ({ phase:"fetch", fetched, total }) is emitted only
      // by workers new enough to report download progress — without it the overlay keeps
      // its indeterminate "carrying" pulse. activation-failed/error before any activation
      // is NOT a boot failure (e.g. no derived publication yet): reveal the authored world.
      if (status.phase === "fetch") {
        state.bootOverlay?.setFetch(status.fetched, status.total, status.manifest);
        return;
      }
      // No fetch seam (older worker): the client reaching ready means the manifest+chunk
      // download has silently begun — fall back to the indeterminate "carrying" pulse.
      if (status.phase === "ready") state.bootOverlay?.setFetch(undefined, undefined);
      if (status.phase === "activating") state.bootOverlay?.setActivating(status.revision);
      else if (status.phase === "activated") bootOverlayDone();
      else if ((status.phase === "error" || status.phase === "activation-failed") && state.bootOverlay) bootOverlayDone();
      if (status.phase === "activated" || status.phase === "revision") {
        setStatus("derived", derivedStatusDetail(status));
      } else if (status.phase === "error" || status.phase === "activation-failed") {
        setStatus("derived", derivedStatusDetail(status));
      } else if (status.phase === "closed") {
        releaseEditDerivedResidency();
        state.derivedEditClient = undefined;
        syncNavigationUi();
        state.derivedEditRestartTimer = setTimeout(() => {
          state.derivedEditRestartTimer = undefined;
          requestEditDerivedClient();
        }, 2_000);
      }
    },
  });
  state.derivedEditClient = client;
  syncNavigationUi();
  try {
    client.start(discovery, { mode: "watch", residency: state.running.derivedTerrainResidency() });
    const runtime = state.running;
    state.derivedEditResidencyUnsubscribe = subscribeDerivedResidency(
      runtime,
      client,
      () => state.derivedEditClient === client && state.running === runtime &&
        state.running !== state.playRuntime && !state.rebooting && !playLifecycle.isAuthoringLocked(),
      "DERIVED_EDIT_RESIDENCY_UPDATE_FAILED",
    );
  } catch (error) {
    releaseEditDerivedResidency();
    if (state.derivedEditClient === client) state.derivedEditClient = undefined;
    syncNavigationUi();
    await client.close();
    throw error;
  }
}

function requestEditDerivedClient() {
  if (!state.client || derivedRuntimeDiscovery === undefined) return;
  void ensureEditDerivedClient().catch(() => {
    if (state.scrubLimit === undefined && !playLifecycle.isAuthoringLocked()) {
      setStatus("derived", "WATCH_START_FAILED");
    }
  });
}

function startPinnedDerivedClient(runtime, source, token) {
  if (state.derivedPlayClient) throw new Error("DERIVED_PLAY_ALREADY_STARTED");
  const discovery = derivedRuntimeDiscovery;
  if (discovery === undefined) throw new Error("DERIVED_DISCOVERY_UNAVAILABLE");
  let client;
  const activation = {};
  activation.promise = new Promise((resolve, reject) => {
    activation.resolve = resolve;
    activation.reject = reject;
  });
  activation.timer = setTimeout(() => {
    if (state.derivedPlayActivation === activation) rejectPlayDerivedActivation("DERIVED_PLAY_ACTIVATION_TIMEOUT");
  }, DERIVED_PLAY_START_TIMEOUT_MS);
  activation.settled = false;
  state.derivedPlayActivation = activation;
  client = createDerivedRuntimeClient({
    activate: async (snapshot, { signal } = {}) => {
      if (!playLifecycle.is(token, "starting") || state.playRuntime !== runtime ||
          !sameDerivedSource(snapshot, source)) throw new Error("Pinned Play runtime is no longer current");
      await runtime.activateDerivedRevision(snapshot, { signal, contentAccess: derivedMainRealmContentAccess() });
      assertRuntimeDerivedRevision(runtime, snapshot);
      if (signal?.aborted || !playLifecycle.is(token, "starting") || state.playRuntime !== runtime) {
        throw new Error("Pinned Play runtime changed during derived activation");
      }
    },
    onStatus: (status) => {
      if (state.derivedPlayClient !== client) return;
      if (status.phase === "activated" && status.revision === source.revision && !activation.settled) {
        activation.settled = true;
        clearTimeout(activation.timer);
        activation.resolve();
      } else if ((status.phase === "error" || status.phase === "activation-failed" || status.phase === "closed") && !activation.settled) {
        rejectPlayDerivedActivation(derivedStatusDetail(status));
      }
    },
  });
  state.derivedPlayClient = client;
  try {
    const activeManifestHash = runtime.derivedRevision()?.manifestHash;
    client.start(discovery, {
      mode: "pinned",
      pinnedSource: {
        revision: source.revision,
        headHash: source.headHash,
        ...(typeof activeManifestHash === "string" ? { manifestHash: activeManifestHash } : {}),
      },
      residency: runtime.derivedTerrainResidency(),
    });
    state.derivedPlayResidencyUnsubscribe = subscribeDerivedResidency(
      runtime,
      client,
      () => state.derivedPlayClient === client && state.playRuntime === runtime &&
        playLifecycle.generation === token,
      "DERIVED_PLAY_RESIDENCY_UPDATE_FAILED",
    );
  } catch (error) {
    releasePlayDerivedResidency();
    state.derivedPlayClient = undefined;
    activation.settled = true;
    clearTimeout(activation.timer);
    activation.resolve();
    if (state.derivedPlayActivation === activation) state.derivedPlayActivation = undefined;
    void client.close();
    throw new Error("DERIVED_PLAY_START_FAILED", { cause: error });
  }
  return activation.promise.finally(() => {
    if (state.derivedPlayActivation === activation) state.derivedPlayActivation = undefined;
  });
}

function handleViewportDisconnect(client) {
  if (state.client !== client) return;
  state.client = undefined;
  state.subscribed = false;
  void closeDerivedClients({ forgetDiscovery: true });
  if (playLifecycle.isAuthoringLocked()) void stopPlay("DERIVED_CONNECTION_CLOSED");
  setStatus("disconnected", "reconnecting…");
}

function resetViewportConnection() {
  if (state.connectionReset) return state.connectionReset;
  const client = state.client;
  state.client = undefined;
  state.subscribed = false;
  state.latestEditDerivedRevision = undefined;
  try { client?.close(); } catch { /* socket teardown is best effort */ }
  let reset;
  reset = (async () => {
    await closeDerivedClients({ forgetDiscovery: true });
    if (playLifecycle.isAuthoringLocked()) await stopPlay("DERIVED_CONNECTION_RESET");
    await state.historyTransition?.catch(() => undefined);
    bootOverlayReset(); // a reset connection re-boots from scratch — and so does the overlay
    try { await waitForViewportIdle(); } catch { /* the old connection is already closed */ }
    const runtimes = new Set([state.playRuntime, state.running, state.editRuntimeDuringPlay]);
    await Promise.allSettled([...runtimes].filter(Boolean).map((runtime) => stopRuntime(runtime)));
    clearGizmo();
    removeGridHelper();
    restoreWireframeMaterials();
    releasePlayCanvas();
    state.running = undefined;
    state.playRuntime = undefined;
    state.editRuntimeDuringPlay = undefined;
    state.commands = [];
    state.cursor = 0;
    state.quarantined.clear();
    state.queuedBatches = [];
    state.dirty = false;
    state.scrubLimit = undefined;
    state.editRestore = new RetainedEditRestore();
    releaseNavigationState();
    editorSelection.clear("connection-reset");
    window.dispatchEvent(new CustomEvent("limina:history-return-live"));
    playLifecycle.finishEdit();
  })().finally(() => {
    if (state.connectionReset === reset) state.connectionReset = undefined;
  });
  state.connectionReset = reset;
  return reset;
}

// Connect once the panels' inputs are populated (the user entered the URL + auth token and connected
// the panels). Retries on a slow cadence until it succeeds. Prefers worldlog/subscribe (K4: the
// server PUSHES new authoring commands instead of us polling worldlog.tail every second); falls
// back to polling if the server doesn't support it or the subscribe request itself fails.
async function tryConnect() {
  if (state.client || state.connectionReset) return;
  if (document.getElementById("status-text")?.textContent !== "connected") return;
  const url = val("url");
  const authToken = val("auth-token") || undefined;
  if (!url) return; // wait until the user has set the server URL
  const client = new McpClient(url);
  // The socket can drop later (server restart, network blip) without a clean close() call on our
  // side — WebSocket.onclose still fires. Drop the dead client so the NEXT viewportTick() tick
  // reconnects via tryConnect() again; that re-subscribes at the current state.cursor, so the
  // resumed stream picks up exactly where it left off (worldlogTail from that cursor covers
  // whatever was missed while disconnected — no gap, no replay of already-applied commands).
  client.onConnectionChange = (connected) => {
    if (connected) return;
    handleViewportDisconnect(client);
  };
  try {
    bootOverlayEnsure(); // the island assembles itself from the first connect attempt
    await client.connect();
    await client.initialize("viewport_follower", "ses_viewport_" + Math.random().toString(36).slice(2, 8), "system.readonly", authToken);
    state.client = client;
    await discoverDerivedRuntime(client);
    requestEditDerivedClient();
    void requestCatalogRefresh(`reconnect:${++viewportConnectionGeneration}`);
    // Editor session FAST-BOOT: before subscribing, ask the host whether this session can
    // boot from a snapshot + bounded tail. Only on a fresh sync (cursor 0) — a reconnect
    // mid-session resumes its cursor and needs no snapshot. Any failure (older server
    // without the skill, ineligible session) keeps the full-replay path.
    if (state.cursor === 0 && !state.bootPayload) await tryFastBoot(client);
    // Register the push handler BEFORE subscribing so the server's immediate join-batch push
    // (sent before the subscribe request's own ack) is never missed.
    client.onNotification(WORLDLOG_APPEND_METHOD, (params) => { void applyWorldlogBatch(params); });
    try {
      await client.worldlogSubscribe(state.cursor);
      state.subscribed = true;
      setStatus("following", "authoring stream (push)");
      // A fast-booted viewport at the stream head gets NO join batch (nothing after its
      // cursor), so the snapshot restore must be kicked explicitly.
      if (state.dirty && !state.rebooting && !playLifecycle.isAuthoringLocked()) void reboot();
    } catch (subErr) {
      // Older server / transient failure — degrade to the 1s poll loop below (state.subscribed
      // stays false), rather than leaving the viewport with nothing at all.
      state.subscribed = false;
      console.warn("worldlog/subscribe failed, falling back to polling worldlog.tail", subErr);
      setStatus("following", "authoring stream (poll fallback)");
      await poll();
    }
  } catch (e) {
    // Likely the panels aren't connected yet (auth token missing) — keep the poster, retry later.
    setStatus("waiting", "connect the panels first");
    try { client.close(); } catch { /* ignore */ }
  }
}

// Editor session FAST-BOOT request. On an eligible answer: stash the payload, point the
// cursor at the snapshot boundary (the tail accumulates from there via subscribe/poll),
// and mark dirty so the next reboot boots via snapshot restore. Every other outcome
// (ineligible, older server without the skill, transport error) leaves the full-replay
// path untouched. Never throws.
async function tryFastBoot(client) {
  const threshold = fastBootThreshold();
  if (!Number.isFinite(threshold)) {
    logConsolePanel("viewport fast-boot disabled (limina.editor.fastboot=off)", "info");
    return;
  }
  try {
    const res = await client.callTool("worldlog.snapshotBoot", { minCommands: Math.max(1, threshold) });
    if (!res || res.eligible !== true || typeof res.next !== "number" || typeof res.snapshot !== "string") {
      if (res && res.reason) logConsolePanel(`viewport fast-boot unavailable: ${res.reason}`, "info");
      return;
    }
    state.bootPayload = {
      snapshotSeq: res.snapshotSeq ?? res.next,
      snapshot: res.snapshot,
      bootstrapCommands: Array.isArray(res.bootstrapCommands) ? res.bootstrapCommands : [],
    };
    state.commands = [];
    state.quarantined.clear();
    state.cursor = res.next;
    state.dirty = true;
    logConsolePanel(`viewport fast-boot: snapshot@seq${res.next} + tail replay`, "info");
  } catch (err) {
    // Older server (unknown tool) or a transient failure — full replay covers it.
    logConsolePanel("viewport fast-boot probe failed (using full replay): " + (err && err.message ? err.message : String(err)), "info");
  }
}

// Abandon the snapshot-boot path (a program/finalize failure, or runLive returned null while
// fast-booting) and resync the FULL authoring stream from scratch. Correctness over speed:
// a failed snapshot restore must never leave a half-restored world on screen.
function abandonFastBoot(reason) {
  if (!state.bootPayload) return false;
  logConsolePanel("viewport fast-boot failed — falling back to full replay: " + reason, "err");
  state.bootPayload = undefined;
  state.commands = [];
  state.cursor = 0;
  state.quarantined.clear();
  state.dirty = true;
  return true;
}

// K4: dedupe guard + serialization for a worldlog batch ({commands, next, reset}), shared by
// poll() (worldlog.tail) and the worldlog/append push (tryConnect's onNotification handler) — both
// funnel through here so a batch delivered by BOTH paths (a poll racing a push, or the same push
// re-sent) is applied EXACTLY ONCE, and two batches arriving close together (e.g. a push landing
// mid-reboot) apply ONE AT A TIME instead of interleaving into state.commands / the reboot flags.
async function applyWorldlogBatch(res) {
  if (!res) return;
  if (state.applyingBatch) { state.queuedBatches.push(res); return; }
  state.applyingBatch = true;
  try {
    await applyWorldlogBatchInner(res);
    while (state.queuedBatches.length > 0) {
      await applyWorldlogBatchInner(state.queuedBatches.shift());
    }
  } finally {
    state.applyingBatch = false;
  }
}

async function applyWorldlogBatchInner(res) {
  // Cursor dedupe guard: a batch whose `next` does not ADVANCE our cursor is a duplicate or stale
  // delivery (a poll racing a push, a re-sent subscribe join batch, a push that arrived mid-
  // reconnect) — applying it again would double-author every command it carries. `reset` always
  // resyncs from scratch regardless of `next` (mirrors worldlog.tail's own reset meaning).
  if (!res.reset && typeof res.next === "number" && res.next <= state.cursor) return;
  if (playLifecycle.isAuthoringLocked() && (res.reset || (typeof res.next === "number" && res.next > state.cursor))) {
    playLifecycle.markStale(res.reset ? undefined : res.next);
  }
  if (res.reset) {
    invalidateEditDerivedRevision();
    state.bootPayload = undefined; // a stream reset invalidates any snapshot boot (full resync)
    state.commands = [];
    state.cursor = 0;
    state.quarantined.clear();
    state.dirty = true;
  }
  if (Array.isArray(res.commands) && res.commands.length > 0) {
    const newCmds = res.commands;
    const authorCmds = toAuthorCommands(newCmds);
    for (const cmd of res.commands) state.commands.push(cmd);
    // While scrubbed into the past, accumulate new commands but don't hot-apply them to the
    // frozen past view (returning to live replays the full stream).
    if (state.scrubLimit !== undefined || playLifecycle.isAuthoringLocked()) {
      invalidateEditDerivedRevision();
    } else if (state.running && !state.rebooting && !res.reset) {
      // Hot-apply FIRST (sculpt-on-derived): commands the live runtime absorbs in place
      // (terrain.deform is LIVE_IN_PLACE) must NOT invalidate the derived presentation —
      // the derived watch client delivers the recompiled revision into THIS runtime
      // (content-delta activation), so a dab no longer reboots the viewport. Only a
      // command the runtime cannot absorb (structural/worker divergence) invalidates.
      const r = await state.running.applyAuthorCommands(authorCmds);
      if (r.needsReboot) {
        invalidateEditDerivedRevision();
        state.dirty = true;
      }
    } else {
      invalidateEditDerivedRevision();
      state.dirty = true;
    }
    showActiveAgentTargets(authorCmds);
    // A granted catalog.publish just landed in the log → the palette is stale; re-fetch so a
    // freshly approved asset appears without reopening the panel.
    if (newCmds.some((c) => c.kind === "skill" && c.tool === "catalog.publish")) void requestCatalogRefresh(`catalog.publish:${res.next ?? state.cursor}`);
  }
  if (typeof res.next === "number") state.cursor = res.next;
  if (state.dirty && !state.rebooting && !playLifecycle.isAuthoringLocked()) await reboot();
}

// Explicit poll: worldlog.tail from the current cursor. Used as (a) the fallback loop when not
// subscribed, (b) a slow liveness/resync check while subscribed (harmless — applyWorldlogBatch's
// cursor guard makes a redundant poll a no-op), and (c) the immediate "pull the edit straight back"
// call after a brush dab / catalog placement, regardless of subscription state.
async function poll(throwOnError = false) {
  const c = state.client;
  if (!c) {
    if (throwOnError) throw new Error("viewport is not connected to the authoritative authoring stream");
    return;
  }
  return pollTask.run(async () => {
    state.polling = true;
    try {
      const res = await c.callTool("worldlog.tail", { since: state.cursor });
      await applyWorldlogBatch(res);
    } finally {
      state.polling = false;
    }
  }, {
    strict: throwOnError,
    onError: (e) => {
      const message = e && e.message ? e.message : String(e);
      console.warn("viewport poll failed", e);
      logConsolePanel("viewport poll failed: " + message, "err");
      setStatus("poll error", message);
    },
  });
}

function disposeMaterial(material) {
  if (Array.isArray(material)) {
    for (const item of material) item?.dispose?.();
  } else {
    material?.dispose?.();
  }
}

function stopAgentHighlightLoop() {
  if (state.agentHighlightFrame !== undefined) {
    cancelAnimationFrame(state.agentHighlightFrame);
    state.agentHighlightFrame = undefined;
  }
}

function startAgentHighlightLoop() {
  if (state.agentHighlightFrame !== undefined) return;
  const tick = () => {
    if (state.agentHighlights.size === 0) {
      state.agentHighlightFrame = undefined;
      return;
    }
    for (const entry of state.agentHighlights.values()) entry.helper.update();
    state.agentHighlightFrame = requestAnimationFrame(tick);
  };
  state.agentHighlightFrame = requestAnimationFrame(tick);
}

function disposeHighlightEntry(entry) {
  if (!entry) return;
  if (entry.timeout !== undefined) clearTimeout(entry.timeout);
  const helper = entry.helper;
  if (helper) {
    try { helper.parent?.remove(helper); } catch { /* ignore */ }
    try { helper.geometry?.dispose?.(); } catch { /* ignore */ }
    try { disposeMaterial(helper.material); } catch { /* ignore */ }
  }
}

// Clear ALL builders' cues (reboot / deselect / teardown).
function clearAgentHighlight() {
  for (const entry of state.agentHighlights.values()) disposeHighlightEntry(entry);
  state.agentHighlights.clear();
  stopAgentHighlightLoop();
}

// Clear one builder's cue (its independent 1500ms timeout fired).
function clearAgentHighlightFor(agentId) {
  const entry = state.agentHighlights.get(agentId);
  if (!entry) return;
  disposeHighlightEntry(entry);
  state.agentHighlights.delete(agentId);
  if (state.agentHighlights.size === 0) stopAgentHighlightLoop();
}

function refreshAgentHighlightTimeout(agentId) {
  const entry = state.agentHighlights.get(agentId);
  if (!entry) return;
  if (entry.timeout !== undefined) clearTimeout(entry.timeout);
  entry.timeout = setTimeout(() => clearAgentHighlightFor(agentId), 1500);
}

function showAgentHighlight(agentId, entityId) {
  const running = state.running;
  const entry = running?.entities?.resolve?.(entityId);
  if (!running?.scene || !entry?.mesh) return;
  let cue = state.agentHighlights.get(agentId);
  if (!cue || cue.entityId !== entityId) {
    if (cue) disposeHighlightEntry(cue);
    const helper = new THREE.BoxHelper(entry.mesh, cueColorFor(agentId));
    helper.raycast = () => {};
    running.scene.add(helper);
    cue = { entityId, helper, timeout: undefined };
    state.agentHighlights.set(agentId, cue);
  }
  cue.helper.update();
  refreshAgentHighlightTimeout(agentId);
  startAgentHighlightLoop();
}

// Actor ids that are the HUMAN operator, not an agent: "human" is the optimistic
// local apply; "editor_writer" is the builder.readWrite client the gizmo/inspector
// persist through (mcp records agentId = the client name, and those writes echo
// back via worldlog.tail). Neither should trigger the "an agent is working here" cue.
const SELF_ACTOR_IDS = new Set(["human", "editor_writer"]);

// Highlight the LAST entity each non-self builder touched in this batch, one colored cue per
// builder — so a coordinated team is legible (who is working where) rather than a single shared mark.
function showActiveAgentTargets(commands) {
  if (!cuesEnabled()) { clearAgentHighlight(); return; }
  const lastByAgent = new Map();
  for (const cmd of commands) {
    if (!SELF_ACTOR_IDS.has(cmd.agentId) && cmd.input?.entity) lastByAgent.set(cmd.agentId, cmd.input.entity);
  }
  for (const [agentId, entityId] of lastByAgent) showAgentHighlight(agentId, entityId);
}

function clearGizmo() {
  clearAgentHighlight();
  stopSelectionGuardLoop();
  state.selected = undefined;
  state.ctrlRotateActive = false;
  if (state.transformControls) {
    try { state.transformControls.detach(); } catch { /* ignore */ }
    try { state.transformControls.dispose(); } catch { /* ignore */ }
  }
  if (state.transformHelper?.parent) {
    try { state.transformHelper.parent.remove(state.transformHelper); } catch { /* ignore */ }
  }
  state.transformControls = undefined;
  state.transformHelper = undefined;
}

function isTextInputTarget(target) {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

function reconcileCtrlRotateMode() {
  const controls = state.transformControls;
  if (!controls || controls.dragging) return;
  if (state.ctrlRotateDown) {
    controls.setMode("rotate");
    state.ctrlRotateActive = true;
  } else if (state.ctrlRotateActive) {
    controls.setMode("translate");
    state.ctrlRotateActive = false;
  }
}

function installGizmo(running) {
  clearGizmo();
  if (!running?.scene || !running?.camera || !running?.renderer?.domElement || typeof TransformControls !== "function") return;
  const controls = new TransformControls(running.camera, running.renderer.domElement);
  const helper = typeof controls.getHelper === "function" ? controls.getHelper() : controls;
  markEditorHelper(helper);
  running.scene.add(helper);
  controls.setMode("translate");
  controls.addEventListener("dragging-changed", (event) => {
    const selected = state.selected;
    const active = event.value === true;
    if (typeof running.setCameraControlsEnabled === "function") {
      if (active) running.setCameraControlsEnabled(false);
      else running.setCameraControlsEnabled(true);
    }
    if (!active) reconcileCtrlRotateMode();
    if (!selected || typeof running.setSyncSuppressed !== "function") return;
    if (active) running.setSyncSuppressed(selected.eid, true);
    else void commitSelectedTransform(selected, running);
  });
  state.transformControls = controls;
  state.transformHelper = helper;
  applySnapSettings();
  applyTransformSpace();
  reconcileCtrlRotateMode();
}

// Per-frame guard: if the SELECTED entity leaves the scene graph (deleted via the World panel, an
// agent, or a recorded-stream re-author — any path other than the viewport's own Delete key, which
// detaches first), auto-detach the gizmo. Without this, TransformControls validates its now-orphaned
// object every frame and floods "The attached 3D object must be a part of the scene graph", wedging
// the app. Self-terminating: runs only while something is selected + attached.
function stopSelectionGuardLoop() {
  if (state.selectionGuardFrame !== undefined) {
    cancelAnimationFrame(state.selectionGuardFrame);
    state.selectionGuardFrame = undefined;
  }
}

function startSelectionGuardLoop() {
  if (state.selectionGuardFrame !== undefined) return;
  const tick = () => {
    const mesh = state.selected?.mesh;
    const scene = state.running?.scene;
    if (!mesh || !scene) { state.selectionGuardFrame = undefined; return; }
    if (!isAttachedToScene(mesh, scene)) {
      // The selected entity was destroyed out from under the gizmo — detach before TransformControls
      // spams the scene-graph error every frame. deselectEntity() also stops this loop.
      const removedId = state.selected?.id;
      deselectEntity();
      if (removedId !== undefined && editorSelection.get() === removedId) editorSelection.clear("viewport-deleted");
      return;
    }
    state.selectionGuardFrame = requestAnimationFrame(tick);
  };
  state.selectionGuardFrame = requestAnimationFrame(tick);
}

function selectEntity(id, running) {
  const entry = running?.entities?.resolve?.(id);
  if (!entry?.mesh || typeof entry.eid !== "number") {
    if (state.selected?.id !== id) deselectEntity();
    return false;
  }
  // Task #78: pin the selection RESIDENT in the placed-entity residency stream BEFORE the gizmo
  // attaches — setProtected(true) re-materializes a dormant mesh immediately, so the selection
  // guard's scene-graph check never fires on a detached target (e.g. a far entity chosen from
  // the World panel). Release the previous selection's pin so it can stream out again.
  if (state.selected && state.selected.id !== id) running?.entityStream?.setProtected(state.selected.id, false);
  running?.entityStream?.setProtected(id, true);
  state.selected = { id, eid: entry.eid, mesh: entry.mesh };
  state.transformControls?.attach(entry.mesh);
  startSelectionGuardLoop();
  setStatus("selected", id);
  syncNavigationUi();
  return true;
}

function deselectEntity() {
  stopSelectionGuardLoop();
  // Task #78: release the residency pin — an unselected far entity may stream out again.
  if (state.selected) state.running?.entityStream?.setProtected(state.selected.id, false);
  try { state.transformControls?.detach(); } catch { /* ignore — object may already be gone */ }
  state.selected = undefined;
  state.ctrlRotateActive = false;
  setStatus("following", "no selection");
  syncNavigationUi();
}

// --- Box select marquee (2.0-C) -------------------------------------------------------
// Overlay div over the canvas, created once and reused. The canvas fills .panel-body
// (#viewport-body is position:absolute inset:0), so absolute coords anchor correctly.
let marqueeEl;
function ensureMarquee() {
  if (marqueeEl) return marqueeEl;
  marqueeEl = document.createElement("div");
  marqueeEl.style.cssText = "position:absolute;display:none;pointer-events:none;z-index:4;"
    + "border:1px dashed rgba(74,163,255,0.9);background:rgba(74,163,255,0.12);";
  (document.getElementById("viewport-body") ?? canvas.parentElement)?.appendChild(marqueeEl);
  return marqueeEl;
}
function updateMarqueeOverlay() {
  const el = ensureMarquee();
  const parentRect = el.parentElement?.getBoundingClientRect();
  if (!parentRect) return;
  el.style.display = "block";
  el.style.left = `${Math.min(boxSelect.startX, boxSelect.x) - parentRect.left}px`;
  el.style.top = `${Math.min(boxSelect.startY, boxSelect.y) - parentRect.top}px`;
  el.style.width = `${Math.abs(boxSelect.x - boxSelect.startX)}px`;
  el.style.height = `${Math.abs(boxSelect.y - boxSelect.startY)}px`;
}
function hideMarquee() { if (marqueeEl) marqueeEl.style.display = "none"; }

function endBoxSelect() {
  boxSelect.active = false;
  boxSelect.pointerId = undefined;
  hideMarquee();
  state.running?.setCameraControlsEnabled?.(true);
}

// Every entity whose mesh's projected screen position falls inside the marquee rect.
function entitiesInMarquee(x0, y0, x1, y1) {
  const running = state.running;
  if (!running?.camera || !running?.entities) return [];
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return [];
  const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
  const ids = [];
  for (const id of running.entities.ids()) {
    const mesh = running.entities.resolve(id)?.mesh;
    if (!mesh) continue;
    mesh.getWorldPosition(marqueeScratch).project(running.camera);
    if (marqueeScratch.z < -1 || marqueeScratch.z > 1) continue; // behind the camera / outside depth
    const sx = rect.left + (marqueeScratch.x + 1) * 0.5 * rect.width;
    const sy = rect.top + (1 - marqueeScratch.y) * 0.5 * rect.height;
    if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) ids.push(id);
  }
  return ids;
}

// --- Secondary selection cues (2.0-C) --------------------------------------------------
// One accent BoxHelper per non-primary selected id (the primary keeps the gizmo), in the
// agentHighlights idiom. Rebuilt on every selection change and after reboot() re-parents
// the scene (helpers added to the old scene die with it).
const SECONDARY_SELECTION_COLOR = 0x4aa3ff; // studio accent (CUE_PALETTE[0])
const secondaryHelpers = new Map(); // entityId -> BoxHelper

function clearSecondaryHelpers() {
  for (const helper of secondaryHelpers.values()) {
    try { helper.parent?.remove(helper); } catch { /* ignore */ }
    try { helper.geometry?.dispose?.(); } catch { /* ignore */ }
    try { disposeMaterial(helper.material); } catch { /* ignore */ }
  }
  secondaryHelpers.clear();
}

function rebuildSecondaryHelpers() {
  clearSecondaryHelpers();
  const running = state.running;
  if (!running?.scene) return;
  const primary = editorSelection.get();
  for (const id of editorSelection.getMany()) {
    if (id === primary) continue;
    const mesh = running.entities?.resolve?.(id)?.mesh;
    if (!mesh) continue;
    const helper = new THREE.BoxHelper(mesh, SECONDARY_SELECTION_COLOR);
    helper.raycast = () => {}; // cursor overlays must never intercept picking
    running.scene.add(helper);
    secondaryHelpers.set(id, helper);
  }
}

function pickEntity(event) {
  if (playLifecycle.isAuthoringLocked()) return;
  const running = state.running;
  const controls = state.transformControls;
  if (!running || !controls || controls.dragging) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  pointerNdc.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointerNdc, running.camera);
  const hits = raycaster.intersectObjects(running.scene.children, true);
  for (const hit of hits) {
    const id = running.pickEntityId?.(hit.object);
    if (id) {
      editorSelection.select(id, "viewport");
      return;
    }
  }
  if (!controls.axis) editorSelection.clear("viewport");
}

// --- In-game terrain brush (Slice 1) ---------------------------------------------------------------
// Raycast the ground under the cursor, then stamp a terrain.deform through the recorded command path
// (write-client -> server -> worldlog broadcast -> live in-place apply). NO optimistic pre-apply on
// EditableTerrain worlds: terrain.deform is ADDITIVE there, so applying locally AND via the
// broadcast-back would double every dab. DERIVED terrain is the opposite (D5.2): the render realm is
// inert for the recorded deform, so without a local preview the terrain would only move seconds later
// when the recompiled revision lands — hence the optimistic sculpt preview below.
const SCULPT_TOOLS = new Set(["raise", "lower", "smooth", "flatten", "paint"]);
// D5.2 preview seam: morph the live derived chunk meshes NOW with the engine's own brush kernel
// (terrainBrushKernel from the vendor bundle == the materializeTerrainBrushOp math). The recompiled
// revision remounts the touched chunks and replaces the preview — no drift correction. Fire-and-
// forget with failure rollback (NOT apply-on-success): the morph must land in the dab's own frame,
// and a failed commit restores the vertices byte-identical from the pre-dab snapshot. Caveat: dabs
// are not serialized across the await, so a FAILED dab rolls its whole-chunk snapshot back over any
// later dab's preview on that chunk — failure-only, and the next revision remounts the chunk anyway.
function sculptPreviewFor(dab) {
  if (dab.mode !== "raise" && dab.mode !== "lower") return null; // smooth/flatten reject authority-side; noise is ribbon-unreachable
  const meshes = collectDerivedTerrainMeshes(state.running?.scene);
  if (meshes.length === 0) return null; // EditableTerrain worlds: the broadcast applies the deform — no preview (additive double-apply)
  return applySculptPreview(meshes, dab, terrainBrushKernel);
}
function raycastGround(event) {
  const running = state.running;
  if (!running?.camera || !running?.scene) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  pointerNdc.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointerNdc, running.camera);
  const hits = raycaster.intersectObjects(running.scene.children, true);
  return hits.length ? hits[0].point : null; // nearest surface point (the ground on open terrain)
}
async function brushDab(event) {
  const p = raycastGround(event);
  if (!p) return;
  try {
    if (state.brushTool === "paint") {
      // Map the shared strength slider (0.2..4) to a 0..1 paint blend rate; Ctrl erases.
      const rate = Math.min(1, state.brush.strength / 4);
      await paintTerrain([p.x, p.z], state.brush.radius, rate, state.brush.falloff, state.paintMaterial, event.ctrlKey);
    } else {
      let mode = state.brushTool;
      if (event.ctrlKey && mode === "raise") mode = "lower"; // Ctrl inverts raise<->lower
      else if (event.ctrlKey && mode === "lower") mode = "raise";
      const delta = mode === "flatten" ? state.flattenTarget : state.brush.strength; // flatten = target height
      const dab = { center: [p.x, p.z], radius: state.brush.radius, delta, mode, falloff: state.brush.falloff };
      const preview = sculptPreviewFor(dab); // morphs synchronously — visible this frame
      try {
        await deformTerrain(dab.center, dab.radius, delta, mode, dab.falloff);
      } catch (dabError) {
        if (preview !== null) rollbackSculptPreview(preview); // unrecorded dab must not linger visually
        throw dabError;
      }
    }
    state.strokeDid = true;
    await poll(); // pull the recorded edit straight back (localhost round-trip) so it renders now
  } catch (e) {
    surfaceViewportWarning("terrain brush failed", e);
  }
}

// Brush ring: an accent ring lying on the terrain under the cursor, scaled to the brush radius, so the
// footprint is legible (the OS crosshair alone gave no sense of size). Re-parents itself after a reboot
// (undo/scrub rebuilds the scene).
let brushRing = null;
function ensureBrushRing() {
  const running = state.running;
  if (!running?.scene || typeof THREE !== "object") return null;
  if (brushRing && brushRing.parent !== running.scene) {
    try { brushRing.parent?.remove(brushRing); } catch { /* ignore */ }
    running.scene.add(brushRing);
  }
  if (!brushRing) {
    const geo = new THREE.RingGeometry(0.94, 1.0, 56); // unit ring in XY...
    geo.rotateX(-Math.PI / 2);                          // ...laid flat into the XZ ground plane
    const mat = new THREE.MeshBasicMaterial({ color: 0xe0552b, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthTest: false });
    brushRing = new THREE.Mesh(geo, mat);
    brushRing.raycast = () => {}; // cursor overlays must never intercept the ground raycast
    brushRing.renderOrder = 999; // draw over the terrain
    brushRing.visible = false;
    running.scene.add(brushRing);
  }
  return brushRing;
}
function updateBrushRing(event) {
  const ring = ensureBrushRing();
  if (!ring) return;
  if (!state.editMode) { ring.visible = false; return; }
  const p = event ? raycastGround(event) : null;
  if (event) {
    if (!p) { ring.visible = false; return; }
    ring.position.set(p.x, p.y + 0.06, p.z); // lift slightly off the surface to avoid z-fighting
  }
  const r = state.brush.radius;
  ring.scale.set(r, r, r);
  ring.visible = true;
}
function hideBrushRing() { if (brushRing) brushRing.visible = false; }

// --- Asset catalog place tool (Slice 4) ------------------------------------------------------------
// A translucent footprint box sized from the selected catalog entry's boundsM tracks the ground
// cursor; a click places the whole GLB via the recorded asset.place. Same idiom as the brush ring:
// module-level mesh, lazily built, re-parented after a reboot rebuilds the scene. Deliberately a BOX
// (not the GLB itself): no async asset fetch may run in the pointer path (live pre-warm constraint).
let placeGhost = null, placeGhostFor = "";
function ensurePlaceGhost() {
  const running = state.running;
  const placement = assetPlacement.get();
  if (!running?.scene || !placement.entry) return null;
  const ghostKey = `${placement.entry.id}:${placement.entry.boundsM.join(",")}`;
  if (placeGhost && placeGhostFor !== ghostKey) {
    try { placeGhost.parent?.remove(placeGhost); placeGhost.geometry.dispose(); placeGhost.material.dispose(); } catch { /* ignore */ }
    placeGhost = null;
  }
  if (placeGhost && placeGhost.parent !== running.scene) {
    try { placeGhost.parent?.remove(placeGhost); } catch { /* ignore */ }
    running.scene.add(placeGhost);
  }
  if (!placeGhost) {
    const b = placement.entry.boundsM;
    const geo = new THREE.BoxGeometry(b[0], b[1], b[2]);
    geo.translate(0, b[1] / 2, 0); // pivot at the base so the footprint sits ON the ground
    const mat = new THREE.MeshBasicMaterial({ color: 0xe0552b, transparent: true, opacity: 0.28, depthTest: false });
    placeGhost = new THREE.Mesh(geo, mat);
    placeGhost.raycast = () => {}; // NEVER raycastable — else the ground raycast hits the ghost's own
    // top face (nearer the camera than the terrain) and it re-positions onto itself every pointermove,
    // walking toward the camera in a "growing" feedback loop.
    placeGhost.renderOrder = 998;
    placeGhost.visible = false;
    placeGhostFor = ghostKey;
    running.scene.add(placeGhost);
  }
  return placeGhost;
}
function updatePlaceGhost(event) {
  const ghost = ensurePlaceGhost();
  if (!ghost) return;
  if (!state.editMode || state.brushTool !== "catalog") { ghost.visible = false; return; }
  if (event) {
    const p = raycastGround(event);
    if (!p) { ghost.visible = false; return; }
    ghost.position.set(p.x, p.y + 0.03, p.z);
  }
  ghost.rotation.y = assetPlacement.get().yaw;
  ghost.visible = true;
}
function hidePlaceGhost() { if (placeGhost) placeGhost.visible = false; }

// Water + scatter tools (2.0-C): the ribbon's active id is the source of truth
// — these are NOT brush tools, so state.brushTool keeps its last brush value.
async function applyWaterPlane() {
  const controller = viewportTooling.controller;
  try {
    setStatus("water", "applying plane…");
    await addWaterPlane(controller.option("water.plane", "level"), controller.option("water.plane", "size"));
    await poll();
    setStatus("water", "plane applied");
  } catch (e) {
    resetWriter();
    surfaceViewportWarning("water plane failed", e);
  }
}

// River draft: clicked centerline points (world xyz) + a preview line that
// re-parents after reboot like the brush ring. Double-click commits through
// the recorded world.addRiver path; Esc cancels.
const riverDraft = { points: [], line: null };
function riverDraftClear() {
  riverDraft.points = [];
  if (riverDraft.line) {
    riverDraft.line.parent?.remove(riverDraft.line);
    riverDraft.line.geometry.dispose();
    riverDraft.line = null;
  }
}
function riverDraftRender() {
  const running = state.running;
  if (!running?.scene || typeof THREE !== "object") return;
  if (riverDraft.line && riverDraft.line.parent !== running.scene) {
    riverDraft.line.parent?.remove(riverDraft.line);
    running.scene.add(riverDraft.line);
  }
  if (!riverDraft.line) {
    riverDraft.line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x4aa3ff }));
    riverDraft.line.raycast = () => {}; // previews never intercept the ground raycast
    riverDraft.line.renderOrder = 999;
    running.scene.add(riverDraft.line);
  }
  riverDraft.line.geometry.dispose();
  riverDraft.line.geometry = new THREE.BufferGeometry().setFromPoints(
    riverDraft.points.map(([x, y, z]) => new THREE.Vector3(x, y + 0.15, z)),
  );
}
async function commitRiverDraft() {
  if (riverDraft.points.length < 2) { riverDraftClear(); return; }
  const controller = viewportTooling.controller;
  const points = riverDraft.points.map(([x, , z]) => [Math.round(x * 100) / 100, Math.round(z * 100) / 100]);
  riverDraftClear();
  try {
    setStatus("water", `committing river (${points.length} pts)…`);
    await addRiver(points, controller.option("water.river", "width"), controller.option("water.river", "class"));
    await poll();
    setStatus("water", "river committed");
  } catch (e) {
    resetWriter();
    surfaceViewportWarning("river commit failed", e);
  }
}

// Scatter brush: one dab = one recorded vegetation.scatter confined to the
// brush disc. Dab spacing >= radius so the inclusion discs TOUCH instead of
// stacking (overlaps would double-plant). Seeds derive from a module counter
// + dab index — Math.random would break replay determinism.
let scatterStrokeSeed = 0;
let scatterStroke = null;
async function scatterDab(event) {
  if (scatterStroke === null) return;
  const controller = viewportTooling.controller;
  const p = raycastGround(event);
  if (!p) return;
  const radius = controller.option("place.scatter", "radius");
  if (scatterStroke.last !== null && Math.hypot(p.x - scatterStroke.last[0], p.z - scatterStroke.last[1]) < radius) return;
  scatterStroke.last = [p.x, p.z];
  const dab = scatterStroke.dab++;
  try {
    await scatterVegetation({
      species: controller.option("place.scatter", "species"),
      density: controller.option("place.scatter", "density"),
      seed: (scatterStroke.seed * 4096 + dab) >>> 0,
      x: p.x,
      z: p.z,
      r: radius,
    });
    state.strokeDid = true;
    await poll();
  } catch (e) {
    surfaceViewportWarning("scatter failed", e);
  }
}

// Asset placement remains a legacy command and is deliberately excluded from transactional undo.
async function placeCatalogAsset(event) {
  if (state.placing) return;
  const placement = assetPlacement.get();
  const entry = placement.entry;
  const p = raycastGround(event);
  if (!entry || !p) return;
  state.placing = true;
  try {
    setStatus("placing", entry.title);
    await placeAsset(entry.id, [p.x, 0, p.z], { rotation: [0, placement.yaw, 0] });
    await poll(); // pull the recorded placement straight back so it renders (or reboots to warm the GLB)
    setStatus("placed", entry.title);
  } catch (e) {
    resetWriter();
    surfaceViewportWarning("asset place failed", e);
  } finally {
    state.placing = false;
  }
}

function updateEditModeIndicator() {
  viewportToolsEl?.classList.toggle("terrain-edit-active", state.editMode);
  if (state.editMode) {
    // Catalog arming auto-opens the Content Browser (ported from the retired HUD).
    if (state.brushTool === "catalog") {
      hideBrushRing();
      if (!window.liminaWindows?.isOpen?.("content-browser")) void openContentBrowser();
    }
    canvas.style.outline = "2px solid #e0552b";
    canvas.style.outlineOffset = "-2px";
    canvas.style.cursor = "crosshair";
  } else {
    canvas.style.outline = "";
    canvas.style.cursor = "";
    hideBrushRing();
    hidePlaceGhost();
  }
  syncNavigationUi();
}

function reconcileNavigationEditMode() {
  const navigation = state.running?.editorNavigation;
  if (!navigation) return;
  try { navigation.setMode(state.editMode ? "orbit" : navigationPreferences.mode); }
  catch (error) { surfaceViewportWarning("navigation mode transition failed", error); }
  syncNavigationUi();
}

export function viewportIsReadOnly() {
  return state.scrubLimit !== undefined || playLifecycle.isAuthoringLocked();
}

async function undoAuthoringEdit() {
  if (viewportIsReadOnly()) { setStatus("read-only history", "return to live before undo"); return; }
  try {
    const receipt = await undoSceneAuthoring();
    setStatus(receipt ? "undone" : "nothing to undo", receipt?.compensates ?? "");
  } catch (error) {
    surfaceViewportWarning("authoritative undo failed", error);
    setStatus("undo failed", error?.message ?? String(error));
  }
}

async function redoAuthoringEdit() {
  if (viewportIsReadOnly()) { setStatus("read-only history", "return to live before redo"); return; }
  try {
    const receipt = await redoSceneAuthoring();
    setStatus(receipt ? "reapplied" : "nothing to redo", receipt?.transactionId ?? "");
  } catch (error) {
    surfaceViewportWarning("authoritative redo failed", error);
    setStatus("redo failed", error?.message ?? String(error));
  }
}

export function surfaceViewportWarning(message, error) {
  console.warn(message, error);
  const detail = error && error.message ? error.message : String(error);
  logConsolePanel(`${message}: ${detail}`, "err");
}

async function commitSelectedTransform(selected, running) {
  const current = state.selected;
  if (!current || current.id !== selected.id || current.eid !== selected.eid || current.mesh !== selected.mesh) return;
  const mesh = selected.mesh;
  try {
    if (viewportIsReadOnly()) throw new Error("history scrub is read-only; return to live before editing");
    const record = typeof window.liminaEntity === "function" ? window.liminaEntity(selected.id) : undefined;
    if (record?.physics?.bodyId !== undefined) {
      throw new Error("transactional transforms are unavailable for physics-bearing entities");
    }
    setStatus("applying", selected.id);
    await commitSceneOperations([sceneTransformOperation(selected.id, {
      position: mesh.position.toArray(),
      rotation: mesh.quaternion.toArray(),
      scale: mesh.scale.toArray(),
    })]);
    setStatus("applied", selected.id);
  } catch (e) {
    surfaceViewportWarning("viewport gizmo write failed", e);
    setStatus("write failed", e && e.message ? e.message : String(e));
    await reboot();
  } finally {
    if (typeof running?.setSyncSuppressed === "function") running.setSyncSuppressed(selected.eid, false);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForViewportIdle(timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  while (state.applyingBatch || state.rebooting || state.polling) {
    if (performance.now() >= deadline) throw new Error("viewport synchronization timed out");
    await sleep(10);
  }
}

function sameHead(a, b) {
  return a?.projectId === b?.projectId && a?.revision === b?.revision && a?.headHash === b?.headHash;
}

function setPlayProgress(detail) {
  state.playProgress = String(detail).slice(0, 160);
  document.body.dataset.playProgress = state.playProgress;
  if (viewportUi.playSource && playLifecycle.phase === "starting") viewportUi.playSource.textContent = state.playProgress;
}

async function captureSynchronizedPlaySnapshot() {
  for (let attempt = 0; attempt < 3; attempt++) {
    setPlayProgress(`sync attempt ${attempt + 1} · waiting for viewport`);
    setStatus("Starting", `synchronizing viewport · attempt ${attempt + 1}`);
    await waitForViewportIdle();
    setPlayProgress(`sync attempt ${attempt + 1} · validating head`);
    setStatus("Starting", "validating project head");
    const before = await refreshAuthoringHead();
    setPlayProgress(`sync attempt ${attempt + 1} · pulling command tip`);
    setStatus("Starting", "pulling authoritative command tip");
    await poll(true);
    setPlayProgress(`sync attempt ${attempt + 1} · verifying head`);
    setStatus("Starting", "verifying stable project head");
    await waitForViewportIdle();
    const after = await refreshAuthoringHead();
    if (sameHead(before, after)) return createPlaySnapshot(state.commands, after, state.cursor);
  }
  throw new Error("authoritative project head kept advancing while Play was starting");
}

function captureEditState() {
  const running = state.running;
  const placement = assetPlacement.get();
  return {
    selection: editorSelection.get(),
    camera: running?.camera ? {
      position: running.camera.position?.toArray?.(),
      quaternion: running.camera.quaternion?.toArray?.(),
      up: running.camera.up?.toArray?.(),
      target: running.cameraControls?.target?.toArray?.(),
    } : undefined,
    navigation: running?.editorNavigation?.snapshot?.(),
    editMode: state.editMode,
    brushTool: state.brushTool,
    brush: { ...state.brush },
    paintMaterial: state.paintMaterial,
    viewportOptions: { ...viewportOptions },
    placement: { entry: placement.entry, yaw: placement.yaw },
    commandCount: state.commands.length,
    cursor: state.cursor,
    forceReboot: false,
  };
}

function restoreEditState(saved) {
  if (!saved) return;
  Object.assign(viewportOptions, saved.viewportOptions);
  state.editMode = saved.editMode;
  state.brushTool = saved.brushTool;
  state.brush = { ...saved.brush };
  state.paintMaterial = saved.paintMaterial;
  syncRibbonFromState();
  if (saved.placement.entry) {
    assetPlacement.arm(saved.placement.entry);
    const currentYaw = assetPlacement.get().yaw;
    assetPlacement.rotate(saved.placement.yaw - currentYaw);
  } else assetPlacement.disarm();
  if (saved.selection === undefined) editorSelection.clear("play-restore");
  else editorSelection.select(saved.selection, "play-restore");
  const running = state.running;
  const camera = running?.camera;
  if (running?.editorNavigation && saved.navigation) {
    try { running.editorNavigation.restore(saved.navigation); }
    catch (error) { surfaceViewportWarning("navigation restore failed", error); }
  } else if (camera && saved.camera) {
    if (saved.camera.position) camera.position.fromArray?.(saved.camera.position);
    if (saved.camera.quaternion) camera.quaternion.fromArray?.(saved.camera.quaternion);
    if (saved.camera.up) camera.up.fromArray?.(saved.camera.up);
    if (saved.camera.target && running.cameraControls?.target) running.cameraControls.target.fromArray?.(saved.camera.target);
    running.cameraControls?.update?.();
  }
  applySnapSettings();
  applyTransformSpace();
  syncViewportUi();
  updateEditModeIndicator();
  syncNavigationUi();
}

async function stopRuntime(runtime) {
  if (!runtime) return;
  try { await runtime.stop(); } catch (error) { console.warn("Play runtime teardown failed", error); }
}

function createPlayCanvas(width, height) {
  const playCanvas = document.createElement("canvas");
  playCanvas.className = "editor-play-canvas";
  playCanvas.width = width;
  playCanvas.height = height;
  playCanvas.setAttribute("aria-label", "Isolated Play viewport");
  canvas.hidden = true;
  canvas.parentElement?.insertBefore(playCanvas, canvas.nextSibling);
  state.playCanvas = playCanvas;
  viewportResizeObserver?.observe(playCanvas);
  return playCanvas;
}

function releasePlayCanvas() {
  if (state.playCanvas) viewportResizeObserver?.unobserve(state.playCanvas);
  state.playCanvas?.remove();
  state.playCanvas = undefined;
  canvas.hidden = false;
}

async function restoreEditWorld() {
  if (!state.editRestore.hasPending()) return;
  await closePlayDerivedClient();
  await stopRuntime(state.playRuntime);
  if (state.running === state.playRuntime) state.running = undefined;
  state.playRuntime = undefined;
  releasePlayCanvas();
  await state.editRestore.attempt(async (saved) => {
    const editRuntime = state.editRuntimeDuringPlay;
    const streamReset = state.commands.length < saved.commandCount || state.cursor < saved.cursor;
    if (!editRuntime || saved.forceReboot || streamReset || state.dirty) {
      if (editRuntime) await stopRuntime(editRuntime);
      state.running = undefined;
      state.dirty = true;
      await reboot({ allowWhilePlay: true, restore: saved, throwOnError: true });
      return;
    }
    state.running = editRuntime;
    const delta = state.commands.slice(saved.commandCount);
    if (delta.length > 0) {
      const applied = await editRuntime.applyAuthorCommands(toAuthorCommands(delta));
      if (applied.needsReboot) {
        saved.forceReboot = true;
        await stopRuntime(editRuntime);
        state.running = undefined;
        state.dirty = true;
        await reboot({ allowWhilePlay: true, restore: saved, throwOnError: true });
        return;
      }
    }
    restoreEditState(saved);
    editRuntime.setViewSuspended?.(false);
    await editRuntime.resume();
    resizeViewport();
    state.dirty = false;
    requestEditDerivedClient();
  });
  state.editRuntimeDuringPlay = undefined;
}

async function startPlay() {
  if (state.playStart) return state.playStart;
  if (state.scrubLimit !== undefined) {
    setStatus("Play unavailable", "return History to live before starting");
    return;
  }
  const begin = playLifecycle.begin();
  if (!begin.accepted) return state.playStart;
  const token = begin.token;
  const work = (async () => {
    try {
      const snapshot = await captureSynchronizedPlaySnapshot();
      if (!playLifecycle.is(token, "starting")) return;
      playLifecycle.capture(token, snapshot);
      await requireDerivedDiscovery();
      if (!playLifecycle.is(token, "starting")) return;
      state.playProgress = "";
      state.editRestore.retain(captureEditState());
      state.editRuntimeDuringPlay = state.running;
      await closeEditDerivedClient();
      if (!playLifecycle.is(token, "starting")) return;
      clearGizmo();
      removeGridHelper();
      restoreWireframeMaterials();
      await state.editRuntimeDuringPlay?.pause?.();
      state.editRuntimeDuringPlay?.setViewSuspended?.(true);
      const w = canvas.clientWidth || 640, h = canvas.clientHeight || 360;
      const playCanvas = createPlayCanvas(w, h);
      const initialDerivedRevision = sameDerivedSource(state.latestEditDerivedRevision, snapshot.source)
        ? state.latestEditDerivedRevision
        : undefined;
      let playRuntimeStartupFailed = false;
      let runtime;
      try {
        runtime = await runLive({
          canvas: playCanvas, width: w, height: h,
          commands: toAuthorCommands(snapshot.commands),
          // Fast-booted sessions hold only the tail in state.commands — the Play world
          // needs the same snapshot restore under it or it would boot near-empty.
          ...(state.bootPayload ? { snapshotBoot: state.bootPayload } : {}),
          input: window,
          onStatus: (phase, detail) => {
            setStatus(phase, phase === "error" && initialDerivedRevision !== undefined
              ? "DERIVED_PLAY_INITIAL_ACTIVATION_FAILED"
              : detail);
            if (phase === "error" && playLifecycle.is(token, "starting")) {
              playRuntimeStartupFailed = true;
              rejectPlayDerivedActivation("PLAY_RUNTIME_START_FAILED");
            }
            if (phase === "error" && (playLifecycle.is(token, "playing") || playLifecycle.is(token, "paused"))) {
              playLifecycle.fail(token, detail || "live runtime failed");
              void stopPlay(detail || "live runtime failed");
            }
          },
          orbitControls: true,
          forceWebGL: true,
          quality: graphicsSettings.tier,
          disposeRendererOnStop: true,
          ...(readDerivedResidencyPref() === undefined ? {} : { derivedResidency: readDerivedResidencyPref() }),
          ...(initialDerivedRevision === undefined ? {} : {
            initialDerivedRevision,
            initialDerivedContentAccess: derivedMainRealmContentAccess(),
          }),
        });
        if (runtime && initialDerivedRevision !== undefined) assertRuntimeDerivedRevision(runtime, initialDerivedRevision);
      } catch (error) {
        if (initialDerivedRevision !== undefined) {
          throw new Error("DERIVED_PLAY_INITIAL_ACTIVATION_FAILED", { cause: error });
        }
        throw error;
      }
      if (!playLifecycle.is(token, "starting")) {
        await stopRuntime(runtime);
        return;
      }
      if (!runtime) throw new Error("Play runtime could not start in this browser");
      if (playRuntimeStartupFailed) {
        await stopRuntime(runtime);
        throw new Error("PLAY_RUNTIME_START_FAILED");
      }
      state.playRuntime = runtime;
      await startPinnedDerivedClient(runtime, snapshot.source, token);
      if (!playLifecycle.is(token, "starting")) {
        await closePlayDerivedClient();
        await stopRuntime(runtime);
        return;
      }
      state.running = runtime;
      if (!playLifecycle.started(token)) {
        await stopRuntime(runtime);
        return;
      }
      setStatus("Play", `revision ${snapshot.source.revision}`);
    } catch (error) {
      if (playLifecycle.is(token, "starting")) {
        playLifecycle.fail(token, error);
        surfaceViewportWarning("Play start failed", new Error("Play could not activate its pinned derived revision"));
        let detail = String(error?.message ?? "PLAY_START_FAILED").slice(0, 160);
        let restored = false;
        try { await restoreEditWorld(); restored = true; }
        catch (restoreError) {
          detail = `${detail}; Edit restore failed: ${restoreError?.message ?? String(restoreError)}`;
          surfaceViewportWarning("Edit restore failed", restoreError);
          playLifecycle.restoreFailed(detail);
        }
        if (restored) {
          state.playProgress = "";
          playLifecycle.finishEdit({ error: detail });
          requestEditDerivedClient();
        }
      }
    }
  })();
  state.playStart = work.finally(() => { state.playStart = undefined; });
  return state.playStart;
}

async function togglePlayPause() {
  const runtime = state.playRuntime;
  const token = playLifecycle.generation;
  if (!runtime) return;
  try {
    if (playLifecycle.is(token, "playing")) {
      await runtime.pause();
      playLifecycle.paused(token);
    } else if (playLifecycle.is(token, "paused")) {
      await runtime.resume();
      playLifecycle.resumed(token);
    }
  } catch (error) {
    if (playLifecycle.phase !== "stopping") {
      playLifecycle.fail(token, error);
      surfaceViewportWarning("Play pause control failed", error);
      await stopPlay(error?.message ?? String(error));
    }
  }
}

async function stopPlay(error = "") {
  if (state.playStop) return state.playStop;
  const request = playLifecycle.requestStop();
  if (!request.accepted && playLifecycle.phase === "edit") return;
  const work = (async () => {
    let detail = error;
    try {
      await closePlayDerivedClient();
      await stopRuntime(state.playRuntime);
      await state.playStart;
      await restoreEditWorld();
    } catch (restoreError) {
      detail = detail ? `${detail}; ${restoreError?.message ?? String(restoreError)}` : restoreError?.message ?? String(restoreError);
      surfaceViewportWarning("Edit restore failed", restoreError);
      playLifecycle.restoreFailed(detail);
      setStatus("Error", `Edit restore failed · Stop to retry · ${detail}`);
      return;
    }
    if (!state.editRestore.hasPending()) {
      state.playProgress = "";
      playLifecycle.finishEdit({ error: detail });
      setStatus(detail ? "Edit" : "Edit restored", detail || "following current authoring head");
      requestEditDerivedClient();
    }
  })();
  state.playStop = work.finally(() => { state.playStop = undefined; });
  return state.playStop;
}

async function reboot({ allowWhilePlay = false, restore, throwOnError = false } = {}) {
  if (playLifecycle.isAuthoringLocked() && !allowWhilePlay) { state.dirty = true; return; }
  if (state.rebooting) { state.dirty = true; return; }
  const savedEditState = restore ?? captureEditState();
  state.rebooting = true;
  state.editRuntimeEpoch++;
  state.dirty = false;
  try {
    // An already-started activation may be mutating the old runtime. Invalidate its epoch first,
    // then close its worker so the activation is aborted and bounded before stopping that runtime.
    // New activations reject while the reboot flag is set, so presentation and replacement cannot
    // interleave.
    await closeEditDerivedClient();
    // Time-travel: when scrubbed to a past point, replay only the authoring-command PREFIX up to
    // the playhead (state.scrubLimit); undefined = live (replay everything). state.commands still
    // accumulates in the background so returning to live is instant.
    const cmds = state.scrubLimit === undefined ? state.commands : state.commands.slice(0, state.scrubLimit);
    if (cmds.length === 0 && !state.bootPayload) {
      await stopRuntime(state.running);
      state.running = undefined;
      state.dirty = false;
      restoreEditState(savedEditState);
      setStatus("following", "empty — waiting for the agent to build");
      return;
    }
    clearGizmo();
    removeGridHelper();
    restoreWireframeMaterials();
    if (state.running) { await stopRuntime(state.running); state.running = undefined; }
    const w = canvas.clientWidth || 640, h = canvas.clientHeight || 360;
    const past = state.scrubLimit !== undefined;
    // Convert to AuthorCommands, then SKIP any command quarantined on a prior pass (it failed
    // authoring — replaying it would wedge every future reboot). keptIndex maps a kept command's
    // position back to its index in authorCmds, so a NEW failure can be quarantined by that index.
    const authorCmds = toAuthorCommands(cmds);
    const { kept, keptIndex } = partitionQuarantined(authorCmds, state.quarantined);
    const bootPayload = state.bootPayload;
    setStatus(
      past ? "past" : "rendering",
      bootPayload
        ? `snapshot@seq${bootPayload.snapshotSeq} + ${kept.length} tail commands${past ? " (history)" : ""}`
        : `${kept.length} authoring commands${past ? " (history)" : ""}`,
    );
    state.bootOverlay?.setReplay(kept.length);
    const initialDerivedRevision = past ? undefined : state.latestEditDerivedRevision;
    try {
      state.running = await runLive({
        canvas, width: w, height: h,
        commands: kept,
        // Editor session FAST-BOOT: runLive authors the snapshot boot program, finalizes
        // against the snapshot, then applies `commands` as the bounded tail (both realms).
        ...(bootPayload ? { snapshotBoot: bootPayload } : {}),
        input: window,
        renderHost: editRenderHost,
        quality: graphicsSettings.tier,
        onStatus: (phase, detail) => {
          bootOverlayRuntimeStep(phase, detail);
          setEditRuntimeStatus(
            phase,
            phase === "error" && initialDerivedRevision !== undefined
              ? "DERIVED_EDIT_INITIAL_ACTIVATION_FAILED"
              : detail,
          );
        },
        ...(initialDerivedRevision === undefined ? {} : {
          initialDerivedRevision,
          initialDerivedContentAccess: derivedMainRealmContentAccess(),
        }),
        orbitControls: true,
        editorNavigation: {
          mode: state.editMode ? "orbit" : navigationPreferences.mode,
          speedMps: navigationPreferences.speedMps,
        },
        ...(readDerivedResidencyPref() === undefined ? {} : { derivedResidency: readDerivedResidencyPref() }),
        // WebGL2 backend: some drivers lose the WebGPU device mid-render (black canvas); the live
        // /examples site + the old viewport force WebGL2 for the same reason.
        forceWebGL: true,
      });
      if (state.running && initialDerivedRevision !== undefined) {
        assertRuntimeDerivedRevision(state.running, initialDerivedRevision);
        bindNavigationIdentity(initialDerivedRevision);
      }
    } catch (error) {
      if (initialDerivedRevision !== undefined) {
        throw new Error("DERIVED_EDIT_INITIAL_ACTIVATION_FAILED", { cause: error });
      }
      throw error;
    }
    if (state.running === null && bootPayload) {
      // The snapshot boot path failed (program/finalize mismatch in either realm, reported
      // via onStatus) OR the environment cannot host the viewport. Fall back to the full
      // replay path — if the environment is truly unsupported the fallback fails the same
      // way and leaves the specific status; if only the snapshot path was at fault, the
      // full replay brings the viewport up correctly.
      abandonFastBoot("runLive rejected the snapshot boot");
      void poll();
      return;
    }
    if (state.running === null) {
      // The environment could not HOST the viewport (no COOP/COEP, no WebGPU, or a hard worker
      // startup error). runLive already reported the SPECIFIC reason via onStatus=setStatus — do NOT
      // stomp it with a generic "no COOP/COEP or WebGPU" message (which masked real authoring/worker
      // failures as a fake GPU error). Leave the precise status runLive set.
      bootOverlayFail(state.bootRuntimeError ?? "the viewport could not start in this browser");
      if (throwOnError) throw new Error("Edit runtime could not be restored in this browser");
      return;
    }
    // A per-command authoring failure does NOT null the handle — the viewport came up with everything
    // that DID author. Quarantine each offender (by its authorCmds index) so the next reboot skips it,
    // and surface which/why.
    const failures = state.running.authoringFailures ?? [];
    for (const f of failures) {
      const originalIndex = keptIndex[f.index];
      if (originalIndex !== undefined) state.quarantined.add(originalIndex);
      logConsolePanel(`viewport quarantined a bad command (${f.command}): ${f.message}`, "err");
    }
    installGizmo(state.running);
    const selectedId = editorSelection.get();
    if (selectedId !== undefined) selectEntity(selectedId, state.running);
    rebuildSecondaryHelpers(); // helpers parented to the torn-down scene died with it
    installGridHelper(state.running);
    applyWireframeMode(state.running);
    restoreEditState(savedEditState);
    const authored = kept.length - failures.length;
    const bootLabel = bootPayload ? `snapshot@seq${bootPayload.snapshotSeq} + ` : "";
    // Boot overlay: an inline derived activation (initialDerivedRevision) means the world
    // is already presented; no derived service means there will never be an activation —
    // in both cases the runtime-ready moment ends the loading experience.
    if (!past && (initialDerivedRevision !== undefined || derivedRuntimeDiscovery === undefined)) bootOverlayDone();
    setStatus(
      past ? "past" : "live",
      failures.length > 0
        ? `${bootLabel}${authored} commands · ${failures.length} quarantined${past ? " · viewing history" : ""}`
        : `${bootLabel}${kept.length} commands${past ? " · viewing history" : ""}`,
    );
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    setStatus("error", message);
    bootOverlayFail(message);
    if (abandonFastBoot(message)) void poll();
    if (throwOnError) throw e;
  } finally {
    state.rebooting = false;
    if (state.scrubLimit === undefined && !playLifecycle.isAuthoringLocked() && state.running && !state.derivedEditActivation) {
      requestEditDerivedClient();
    }
    if (state.dirty && !playLifecycle.isAuthoringLocked()) void reboot(); // a batch arrived while rebooting — coalesce into one more pass
  }
}

canvas.addEventListener("pointerdown", (event) => {
  if (!event.isPrimary || event.button !== 0) return;
  pointerClick.id = event.pointerId;
  pointerClick.x = event.clientX;
  pointerClick.y = event.clientY;
  // 2.0-C: Shift+drag with select.pick armed is a marquee box-select — suppress orbit
  // for the drag and finalize the multi-selection on pointerup.
  if (event.shiftKey && !playLifecycle.isAuthoringLocked()
      && viewportTooling.controller.activeId() === "select.pick") {
    boxSelect.active = true;
    boxSelect.pointerId = event.pointerId;
    boxSelect.startX = boxSelect.x = event.clientX;
    boxSelect.startY = boxSelect.y = event.clientY;
    try { canvas.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    state.running?.setCameraControlsEnabled?.(false);
    event.preventDefault();
    return;
  }
  // water.river: each click adds a centerline vertex (double-click commits).
  if (viewportTooling.controller.activeId() === "water.river" && !playLifecycle.isAuthoringLocked()) {
    const p = raycastGround(event);
    if (p) {
      const last = riverDraft.points[riverDraft.points.length - 1];
      if (!last || Math.hypot(p.x - last[0], p.z - last[2]) > 1e-3) {
        riverDraft.points.push([p.x, p.y, p.z]);
        riverDraftRender();
      }
    }
    event.preventDefault();
    return;
  }
  // place.scatter: a drag plants forest dabs — same stroke discipline as sculpt.
  if (viewportTooling.controller.activeId() === "place.scatter" && !playLifecycle.isAuthoringLocked()) {
    state.brushStroking = true;
    state.strokeDid = false;
    scatterStroke = { seed: (scatterStrokeSeed = (scatterStrokeSeed + 1) >>> 0), dab: 0, last: null };
    try { canvas.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    state.running?.setCameraControlsEnabled?.(false);
    event.preventDefault();
    void scatterDab(event);
    return;
  }
  // Terrain edit mode: a drag on the ground sculpts — UNLESS Space is held, which hands the drag to the
  // camera so you can reframe and keep editing without leaving edit mode. The ribbon must actually have
  // a brush tool armed: brushTool alone can be stale (water/scatter leave it untouched).
  if (!playLifecycle.isAuthoringLocked() && state.editMode && !state.spaceNav && SCULPT_TOOLS.has(state.brushTool)
      && (viewportTooling.controller.activeId() === "terrain.sculpt" || viewportTooling.controller.activeId() === "paint.material")) {
    state.brushStroking = true;
    state.strokeDid = false;
    if (state.brushTool === "flatten") { const g = raycastGround(event); state.flattenTarget = g ? g.y : 0; }
    try { canvas.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    state.running?.setCameraControlsEnabled?.(false); // suppress orbit while sculpting
    event.preventDefault();
    void brushDab(event);
  }
});
canvas.addEventListener("pointermove", (event) => {
  if (!event.isPrimary) return;
  if (boxSelect.active && event.pointerId === boxSelect.pointerId) {
    boxSelect.x = event.clientX;
    boxSelect.y = event.clientY;
    updateMarqueeOverlay();
  }
  if (state.editMode && !playLifecycle.isAuthoringLocked()) {
    // The cursor overlay tracks the ribbon's active tool: catalog → footprint
    // ghost, brush tools + scatter → brush ring, water tools → no overlay.
    const activeId = viewportTooling.controller.activeId();
    if (activeId === "place.catalog" || state.brushTool === "catalog") updatePlaceGhost(event);
    else if (activeId === "terrain.sculpt" || activeId === "paint.material" || activeId === "place.scatter") updateBrushRing(event);
    else { hideBrushRing(); hidePlaceGhost(); }
  }
  if (!state.brushStroking) return;
  const now = performance.now();
  if (now - state.brushLast < 55) return; // throttle dabs so a drag doesn't flood the server
  state.brushLast = now;
  void (scatterStroke !== null ? scatterDab(event) : brushDab(event));
});
canvas.addEventListener("pointerleave", () => { hideBrushRing(); hidePlaceGhost(); });
canvas.addEventListener("dblclick", (event) => {
  if (viewportTooling.controller.activeId() !== "water.river") return;
  event.preventDefault();
  void commitRiverDraft();
});
// Drag-drop placement (2.0-C): a catalog row drag arms the placement store at
// dragstart (content-browser.js), so dragover only needs the ghost preview and
// drop lands exactly where the pointer is — same recorded placeCatalogAsset
// path as click-to-place.
canvas.addEventListener("dragover", (event) => {
  if (playLifecycle.isAuthoringLocked() || viewportIsReadOnly()) return;
  if (!assetPlacement.get().entry) return;
  event.preventDefault(); // allow the drop
  updatePlaceGhost(event);
});
canvas.addEventListener("dragleave", () => hidePlaceGhost());
canvas.addEventListener("drop", (event) => {
  if (playLifecycle.isAuthoringLocked() || viewportIsReadOnly()) return;
  if (!assetPlacement.get().entry) return;
  event.preventDefault();
  state.editMode = true;
  state.brushTool = "catalog";
  updateEditModeIndicator();
  syncRibbonFromState();
  void placeCatalogAsset(event);
});
canvas.addEventListener("pointerup", (event) => {
  if (!event.isPrimary || pointerClick.id !== event.pointerId) return;
  const dx = event.clientX - pointerClick.x;
  const dy = event.clientY - pointerClick.y;
  pointerClick.id = undefined;
  if (boxSelect.active && event.pointerId === boxSelect.pointerId) {
    const dragged = Math.hypot(event.clientX - boxSelect.startX, event.clientY - boxSelect.startY);
    const { startX, startY } = boxSelect;
    endBoxSelect();
    if (dragged >= BOX_SELECT_MIN_DRAG_PX) {
      const ids = entitiesInMarquee(startX, startY, event.clientX, event.clientY);
      if (ids.length === 0) editorSelection.clear("viewport");
      else editorSelection.selectMany(ids, "viewport");
      return; // a marquee never falls through to single-entity picking
    }
    // < 4px: treat as a plain click — fall through to pickEntity below.
  }
  if (state.brushStroking) {
    state.brushStroking = false;
    scatterStroke = null;
    try { canvas.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    state.running?.setCameraControlsEnabled?.(true);
    if (state.strokeDid) void poll();
    return; // a sculpt stroke never falls through to entity selection
  }
  if (Math.hypot(dx, dy) <= CLICK_MOVE_TOLERANCE_PX) {
    if (playLifecycle.isAuthoringLocked()) return;
    // water.plane: a click applies the world water plane at the option level.
    if (viewportTooling.controller.activeId() === "water.plane") {
      void applyWaterPlane();
      return;
    }
    // Catalog place tool: a click on the ground places the armed asset (a drag still orbits the
    // camera — "catalog" is not in SCULPT_TOOLS, so no stroke ever starts). The ribbon must have
    // the Place tool armed: brushTool "catalog" alone can be stale (water/scatter keep it).
    if (state.editMode && !state.spaceNav && state.brushTool === "catalog"
        && viewportTooling.controller.activeId() === "place.catalog" && assetPlacement.get().entry) {
      void placeCatalogAsset(event);
      return;
    }
    pickEntity(event);
  }
});
canvas.addEventListener("pointercancel", (event) => {
  if (boxSelect.active && event.pointerId === boxSelect.pointerId) endBoxSelect();
  if (state.brushStroking) {
    state.brushStroking = false;
    state.running?.setCameraControlsEnabled?.(true);
  }
  if (pointerClick.id === event.pointerId) pointerClick.id = undefined;
});
const revealScratch = new THREE.Vector3();
editorSelection.subscribe(({ selectedId, source }) => {
  if (selectedId === undefined) deselectEntity();
  else selectEntity(selectedId, state.running);
  rebuildSecondaryHelpers();
  // 2.0-D 3D → Atlas reveal: a selection made in the viewport/outliner pans
  // the native atlas map to the entity (app.js consumes nav.reveal when the
  // atlas workspace is visible). Selections SOURCED from the atlas itself are
  // excluded to keep the channel one-directional per surface.
  if (selectedId !== undefined && source !== "atlas" && state.selected?.mesh) {
    const p = state.selected.mesh.getWorldPosition(revealScratch);
    studioBus.emit("nav.reveal", { x: p.x, z: p.z, entityId: selectedId, source: "viewport-selection" });
  }
}, { emitCurrent: true });
// 2.0-D Atlas → 3D reveal (native replacement for the deleted iframe focus
// bridge): double-click on the atlas map travels the camera there, with the
// same terrain-height resolution a POI search result gets. places.reveal
// shares the path.
studioBus.subscribe((event) => {
  if (event.type !== "atlas.focus" && event.type !== "places.reveal") return;
  const navigation = state.running?.editorNavigation;
  if (!navigation || !navigationDiscreteReady()) return;
  const x = Number(event.x);
  const z = Number(event.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return;
  leaveWorldOverviewPresentation();
  const provisional = navigation.destinationPose([x, navigation.snapshot().target[1], z], 64);
  void navigateToPose(provisional, { kind: "poi", label: event.type === "places.reveal" ? "Place reveal" : "Atlas reveal" }, {
    resolvePose: ({ context }) => {
      const height = context.runtime.derivedTerrainHeightAt(x, z);
      if (height === null) throw Object.assign(new Error("reveal terrain is unavailable"), { code: "POI_TERRAIN_UNAVAILABLE" });
      return context.navigation.destinationPose([x, height, z], 64);
    },
  });
});
let lastArmedAssetId;
assetPlacement.subscribe(({ entry }) => {
  if (playLifecycle.isAuthoringLocked()) { hidePlaceGhost(); return; }
  if (!entry) {
    lastArmedAssetId = undefined;
    hidePlaceGhost();
    if (state.editMode && state.brushTool === "catalog") {
      state.brushTool = "raise";
      updateEditModeIndicator();
      setStatus("terrain edit", "tool: raise");
      syncRibbonFromState();
    }
    return;
  }
  if (entry.id === lastArmedAssetId) return;
  lastArmedAssetId = entry.id;
  state.editMode = true;
  state.brushTool = "catalog";
  reconcileNavigationEditMode();
  updateEditModeIndicator();
  syncRibbonFromState();
  setStatus(`place: ${entry.title}`, "click ground to place · R rotates · Esc deselects");
});
async function transitionHistoryPresentation(next) {
  await waitForViewportIdle();
  if (next !== undefined) await closeEditDerivedClient();
  state.scrubLimit = next;
  await reboot();
}

function queueHistoryPresentation(next) {
  const previous = state.historyTransition ?? Promise.resolve();
  let transition;
  transition = previous.catch(() => undefined).then(() => transitionHistoryPresentation(next)).catch(() => {
    setStatus("history", "DERIVED_PRESENTATION_TRANSITION_FAILED");
  }).finally(() => {
    if (state.historyTransition === transition) {
      state.historyTransition = undefined;
      if (state.scrubLimit === undefined) requestEditDerivedClient();
    }
  });
  state.historyTransition = transition;
}

// History time-travel: close the current-derived watcher before replaying a past command prefix.
// Returning live reboots with the last accepted revision, then resumes exactly one watch client.
window.addEventListener("limina:scrub-to", (event) => {
  if (state.connectionReset) return;
  if (playLifecycle.isAuthoringLocked()) {
    setStatus("Play", "stop before viewing History");
    window.dispatchEvent(new CustomEvent("limina:history-return-live"));
    return;
  }
  const limit = event instanceof CustomEvent ? event.detail?.limit : undefined;
  const next = (limit === null || limit === undefined) ? undefined : Math.max(0, Math.min(limit | 0, state.commands.length));
  if (next === state.scrubLimit && !state.historyTransition) return;
  queueHistoryPresentation(next);
});
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (riverDraft.points.length > 0) {
    riverDraftClear();
    event.preventDefault();
    return;
  }
  const gotoOpen = viewportUi.navigationGoto?.hidden === false;
  const viewsOpen = viewportUi.navigationViews?.hidden === false;
  const searchOpen = viewportUi.navigationSearch?.hidden === false;
  if (gotoOpen || viewsOpen || searchOpen) {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeNavigationPanels();
    (gotoOpen ? viewportUi.navigationGotoToggle : searchOpen ? viewportUi.navigationSearchToggle : viewportUi.navigationViewsToggle)?.focus();
  }
});
window.addEventListener("keydown", (event) => {
  const controls = state.transformControls;
  if (isTextInputTarget(event.target)) return;
  if (event.key === "F6") {
    event.preventDefault();
    if (event.shiftKey) void stopPlay();
    else void startPlay();
    return;
  }
  if (event.key === "F7") {
    event.preventDefault();
    void togglePlayPause();
    return;
  }
  // Player WASD/mouse input is handled by runLive. The editor listener must stay inert while Play
  // owns the canvas so those same familiar keys never trigger gizmo/terrain authoring shortcuts.
  if (playLifecycle.isAuthoringLocked()) return;
  if (state.running?.editorNavigation?.isCapturingInput?.()) {
    event.preventDefault();
    return;
  }
  // Scene undo is an authoritative compensation transaction; redo is a new reapply transaction.
  if ((event.ctrlKey || event.metaKey) && (event.key === "z" || event.key === "Z")) {
    event.preventDefault();
    if (event.shiftKey) void redoAuthoringEdit(); else void undoAuthoringEdit();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && (event.key === "y" || event.key === "Y")) {
    event.preventDefault();
    void redoAuthoringEdit();
    return;
  }
  // Hold Space in edit mode: a drag navigates the camera (reframe) instead of sculpting.
  if (state.editMode && (event.key === " " || event.code === "Space")) {
    event.preventDefault(); // Space would otherwise scroll/click
    if (!state.spaceNav) {
      state.spaceNav = true;
      state.running?.setCameraControlsEnabled?.(true);
      canvas.style.cursor = "grab";
    }
    return;
  }
  if (controls && (event.key === "Control" || event.ctrlKey)) {
    state.ctrlRotateDown = true;
    reconcileCtrlRotateMode();
    return;
  }
  const key = event.key.toLowerCase();
  if (key === "f4") {
    event.preventDefault();
    state.editMode = !state.editMode;
    reconcileNavigationEditMode();
    updateEditModeIndicator();
    syncRibbonFromState();
    setStatus(state.editMode ? "terrain edit: ON" : "terrain edit: off",
      state.editMode ? `${state.brushTool} · drag to sculpt · Ctrl inverts · 1-6 tool` : "");
    return;
  }
  if (state.editMode && (key === "1" || key === "2" || key === "3" || key === "4" || key === "5" || key === "6")) {
    event.preventDefault();
    state.brushTool = key === "1" ? "raise" : key === "2" ? "lower" : key === "3" ? "smooth"
      : key === "4" ? "flatten" : key === "5" ? "paint" : "catalog";
    updateEditModeIndicator();
    syncRibbonFromState();
    setStatus("terrain edit", `tool: ${state.brushTool}`);
    return;
  }
  // Catalog place tool: R rotates the armed ghost 15°, Esc disarms it. Checked BEFORE the gizmo
  // w/e/r modes below so R never falls through to "scale" while placing.
  if (state.editMode && state.brushTool === "catalog" && assetPlacement.get().entry) {
    if (key === "r") {
      event.preventDefault();
      assetPlacement.rotate(Math.PI / 12);
      updatePlaceGhost();
      return;
    }
    if (key === "escape") {
      event.preventDefault();
      assetPlacement.disarm();
      hidePlaceGhost();
      return;
    }
  }
  if (key === "s") {
    event.preventDefault();
    toggleSnapping();
    syncGizmoOption("snap", viewportOptions.snapEnabled);
    return;
  }
  if (key === "x") {
    event.preventDefault();
    setTransformSpace(viewportOptions.transformSpace === "local" ? "world" : "local");
    syncGizmoOption("space", viewportOptions.transformSpace);
    return;
  }
  if (key === "g") {
    event.preventDefault();
    toggleGrid();
    return;
  }
  if (key === "f") {
    event.preventDefault();
    if (event.shiftKey) toggleWireframe();
    else focusNavigationSelection();
    return;
  }
  if (key === "home") {
    event.preventDefault();
    frameNavigationWorld();
    return;
  }
  if (!controls) return;
  if (key === "w") { controls.setMode("translate"); syncGizmoOption("gizmo", "translate"); }
  else if (key === "e") { controls.setMode("rotate"); syncGizmoOption("gizmo", "rotate"); }
  else if (key === "r") { controls.setMode("scale"); syncGizmoOption("gizmo", "scale"); }
});
// Delete / Backspace destroys the selected entity (immediate — the world log records the destroy,
// which is the recovery path). Guarded by isTextInputTarget so it never fires while typing in chat
// or an inspector field. The recorded destroy re-authors back through poll() and drops the mesh.
window.addEventListener("keydown", (event) => {
  if (event.key !== "Delete" && event.key !== "Backspace") return;
  if (isTextInputTarget(event.target)) return;
  if (state.running?.editorNavigation?.isCapturingInput?.()) {
    event.preventDefault();
    return;
  }
  if (viewportIsReadOnly()) return;
  const selected = state.selected;
  if (!selected) return;
  event.preventDefault();
  // 2.0-C: destroy EVERY selected id (multi-select). Each destroy is the same recorded
  // scene.destroyEntity through write-client as the single-select path, awaited in turn.
  const targets = editorSelection.getMany();
  const ids = targets.length > 0 ? [...targets] : [selected.id];
  deselectEntity();
  void (async () => {
    const survivors = [];
    for (const id of ids) {
      try {
        await destroyEntity(id);
      } catch (e) {
        resetWriter();
        surfaceViewportWarning("destroy failed", e);
        survivors.push(id);
      }
    }
    // Only touch the store if it still points at a target (the user may have picked
    // something else while the destroy round-trip was in flight).
    if (survivors.length > 0 && ids.includes(editorSelection.get())) {
      // Re-select only what failed to destroy (selectMany may be a store no-op when the
      // set is unchanged, so re-attach the gizmo explicitly — the single-select behavior).
      editorSelection.selectMany(survivors, "delete");
      const primary = editorSelection.get();
      if (primary !== undefined) selectEntity(primary, state.running);
    } else if (survivors.length === 0 && ids.includes(editorSelection.get())) {
      editorSelection.clear("delete");
    }
  })();
});
window.addEventListener("keyup", (event) => {
  if ((event.key === " " || event.code === "Space") && state.spaceNav) {
    state.spaceNav = false;
    if (state.editMode) canvas.style.cursor = "crosshair";
    return;
  }
  if (event.key !== "Control") return;
  state.ctrlRotateDown = false;
  reconcileCtrlRotateMode();
});
window.addEventListener("blur", () => {
  state.ctrlRotateDown = false;
  state.spaceNav = false; // dropping focus mid-hold must not leave nav stuck on
  reconcileCtrlRotateMode();
  if (state.editMode) canvas.style.cursor = "crosshair";
});

// --- North compass ---------------------------------------------------------------------------------
// The map tool is north-up (north = -z, east = +x); the 3D orbit camera is not. Without a compass, a
// yawed viewport reads as a MIRRORED world when compared against the drawn map (a real UAT confusion
// — the island was reported "inverted" when the camera was simply facing south). The needle points at
// world north (-z) as seen on screen: θ = atan2(-forward.x, -forward.z), CSS-clockwise.
let compassEl = null, compassNeedle = null, compassLast = 999;
function ensureCompass() {
  if (compassEl) return;
  compassEl = document.createElement("div");
  compassEl.className = "viewport-compass";
  compassEl.style.cssText = "width:44px;height:44px;border-radius:999px;" +
    "background:rgba(22,22,27,.85);border:1px solid #454550;display:flex;align-items:center;justify-content:center;" +
    "pointer-events:none;font:11px system-ui,sans-serif;color:#bbb";
  compassNeedle = document.createElement("div");
  compassNeedle.style.cssText = "position:relative;width:100%;height:100%;display:flex;align-items:flex-start;justify-content:center;" +
    "transition:transform .12s linear";
  compassNeedle.innerHTML = '<span style="margin-top:3px;font-weight:600;color:#e0552b">N</span>' +
    '<span style="position:absolute;top:17px;left:50%;width:2px;height:12px;margin-left:-1px;background:#e0552b;border-radius:1px"></span>';
  compassEl.appendChild(compassNeedle);
  const par = canvas.parentElement || document.body;
  if (par !== document.body && getComputedStyle(par).position === "static") par.style.position = "relative";
  par.appendChild(compassEl);
}
(function compassTick() {
  const cam = state.running?.camera;
  if (cam && typeof cam.getWorldDirection === "function") {
    ensureCompass();
    const d = cam.getWorldDirection(new THREE.Vector3());
    // Degenerate straight-down view: fall back to camera up for the screen frame.
    const fx = Math.abs(d.x) + Math.abs(d.z) < 1e-4 ? cam.up.x : d.x;
    const fz = Math.abs(d.x) + Math.abs(d.z) < 1e-4 ? cam.up.z : d.z;
    const deg = Math.atan2(-fx, -fz) * 180 / Math.PI;
    if (Math.abs(deg - compassLast) > 0.5) {
      compassNeedle.style.transform = `rotate(${deg.toFixed(1)}deg)`;
      compassLast = deg;
    }
  }
  requestAnimationFrame(compassTick);
})();

// Re-fit the canvas to its container when the layout changes size (a sidebar collapses/expands) or
// the window resizes. The canvas is otherwise only sized at reboot (runLive), so a docked-sidebar
// toggle would leave it stretched until the next re-author. Resizes the drawing buffer + the live
// renderer + the camera aspect in place — no reboot, no scene rebuild.
function resizeViewport() {
  const activeCanvas = state.playCanvas ?? canvas;
  const w = activeCanvas.clientWidth, h = activeCanvas.clientHeight;
  if (!w || !h) return;
  const running = state.running;
  try {
    if (typeof running?.resize === "function") running.resize(w, h);
    else {
      activeCanvas.width = w;
      activeCanvas.height = h;
      running?.renderer?.setSize?.(w, h, false);
    }
  } catch { /* ignore */ }
  if (typeof running?.resize !== "function") {
    const cam = running?.camera;
    if (cam) { cam.aspect = w / h; cam.updateProjectionMatrix?.(); }
  }
}
let viewportResizeRaf = 0;
let viewportResizeObserver;
function scheduleResizeViewport() {
  cancelAnimationFrame(viewportResizeRaf);
  viewportResizeRaf = requestAnimationFrame(() => {
    viewportResizeRaf = 0;
    resizeViewport();
  });
}
if (typeof ResizeObserver === "function") {
  viewportResizeObserver = new ResizeObserver(() => {
    scheduleResizeViewport();
  });
  viewportResizeObserver.observe(canvas);
}
window.addEventListener("resize", () => {
  scheduleResizeViewport();
});
// Sidebar collapse animates over ~160ms (CSS); re-fit once the transition has settled.
window.addEventListener("limina:layout-changed", () => {
  setTimeout(() => {
    scheduleResizeViewport();
  }, 200);
});

bindViewportUi();
// Reconnecting with a different URL/token must not leave the independent readonly follower (or its
// derived capability) attached to the old host. The panel owns these buttons; additive listeners
// preserve its connect/disconnect handlers while resetting the viewport-side connection.
document.getElementById("connect")?.addEventListener("click", resetViewportConnection);
document.getElementById("disconnect")?.addEventListener("click", resetViewportConnection);
playLifecycle.subscribe(syncPlayUi, { emitCurrent: true });
setStatus("waiting", "connect the panels to follow the authoring stream");
// Self-scheduling loop (NOT a fixed setInterval): the next tick is scheduled AFTER the
// current poll/reboot finishes, so a slow re-author can never overlap the next poll into a
// compounding request flood that pegs the server.
//
// K4 (worldlog poll -> subscribe): once worldlog/subscribe is active, new authoring commands
// arrive as a worldlog/append PUSH (registered in tryConnect), not via this loop — so it degrades
// to a slow 10s liveness/resync poll instead of the original 1s cadence. Not connected, or
// subscribe unavailable/failed (state.subscribed stays false), keeps the original 1s poll.
const POLL_INTERVAL_MS = 1000;
const SUBSCRIBED_LIVENESS_POLL_INTERVAL_MS = 10000;
let viewportLoopStopped = false;
const viewportTick = async () => {
  if (viewportLoopStopped) return;
  try { await (state.client ? poll() : tryConnect()); } finally {
    if (!viewportLoopStopped) {
      const delay = state.client && state.subscribed ? SUBSCRIBED_LIVENESS_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
      setTimeout(() => { void viewportTick(); }, delay);
    }
  }
};
void viewportTick();
// (The ☰ tools menu + floating windows are owned by editor/src/windows.js.)

window.addEventListener("beforeunload", () => {
  viewportLoopStopped = true;
  bootOverlayReset();
  state.scrubLimit = undefined;
  releaseNavigationState();
  window.dispatchEvent(new CustomEvent("limina:history-return-live"));
  clearAgentHighlight();
  clearGizmo();
  removeGridHelper();
  restoreWireframeMaterials();
  void closeDerivedClients({ forgetDiscovery: true });
  void stopRuntime(state.playRuntime);
  if (state.running !== state.playRuntime) void stopRuntime(state.running);
  void editRenderHost.dispose();
  graphicsSettings.dispose();
  releasePlayCanvas();
  playLifecycle.finishEdit();
  try { state.client?.close(); } catch { /* ignore */ }
});
