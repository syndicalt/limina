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
// - F: toggle scene mesh wireframe view; original material wireframe flags are restored on disable.

import { runLive, partitionQuarantined, TransformControls, THREE } from "../vendor/limina-runtime.js";
import { isAttachedToScene } from "./scene-graph.js";
import { McpClient } from "./mcp-client.js";
import { destroyEntity, resetWriter, writeUpdate, deformTerrain, paintTerrain, fetchCatalog, placeAsset } from "./write-client.js";

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
const statusEl = document.getElementById("viewport-status");
const SELECT_ENTITY_EVENT = "limina:select-entity";
const VIEWPORT_ENTITY_SELECTED_EVENT = "limina:viewport-entity-selected";
const viewportUi = {
  snapToggle: document.getElementById("viewport-snap-toggle"),
  snapTranslate: document.getElementById("viewport-snap-translate"),
  snapRotate: document.getElementById("viewport-snap-rotate"),
  snapScale: document.getElementById("viewport-snap-scale"),
  spaceToggle: document.getElementById("viewport-space-toggle"),
  gridToggle: document.getElementById("viewport-grid-toggle"),
  wireframeToggle: document.getElementById("viewport-wireframe-toggle"),
};
function setStatus(phase, detail) {
  if (statusEl) statusEl.textContent = detail !== undefined ? `${phase}: ${detail}` : phase;
}

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
function toAuthorCommands(commands) {
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
const state = {
  client: undefined,
  running: undefined,
  cursor: 0,
  commands: [],
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
  // Undo trail (per-stroke). undoMarks = worldlog command counts at edit boundaries: undoMarks[0] is
  // "before the first stroke", each later entry is "after a completed stroke". undoAt indexes the point
  // currently in view (undoMarks.length-1 = live). Ctrl+Z walks back through strokes via the scrub view.
  undoMarks: [],
  undoAt: 0,
  strokeDid: false,
  strokeStartLen: 0,
  flattenTarget: 0, // world height the flatten tool drives toward (captured at stroke start)
  spaceNav: false,  // hold Space in edit mode → a drag navigates the camera instead of sculpting
  paintMaterial: "grass", // active material for the paint tool (sand|grass|rock|dirt)
  // Asset catalog place tool (Slice 4). placeAsset = the selected CatalogEntry ({id,title,category,
  // boundsM,qcRender,...}) or null; the ghost footprint + click-to-place only arm while set.
  placeAsset: null,
  placeYaw: 0,      // ghost yaw in radians; R rotates by 15°
  catalog: [],      // cached asset.catalog entries (refreshed when the Catalog tool opens)
  placing: false,   // a placement round-trip is in flight — ignore further clicks until it lands
};
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const CLICK_MOVE_TOLERANCE_PX = 5;
const pointerClick = { id: undefined, x: 0, y: 0 };
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
  viewportUi.snapToggle?.addEventListener("click", () => toggleSnapping());
  viewportUi.spaceToggle?.addEventListener("click", () => {
    setTransformSpace(viewportOptions.transformSpace === "local" ? "world" : "local");
  });
  viewportUi.gridToggle?.addEventListener("click", () => toggleGrid());
  viewportUi.wireframeToggle?.addEventListener("click", () => toggleWireframe());

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
}

// Connect once the panels' inputs are populated (the user entered the URL + auth token and connected
// the panels). Retries on a slow cadence until it succeeds, then switches to authoring-stream polling.
async function tryConnect() {
  if (state.client) return;
  const url = val("url");
  const authToken = val("auth-token") || undefined;
  if (!url) return; // wait until the user has set the server URL
  const client = new McpClient(url);
  try {
    await client.connect();
    await client.initialize("viewport_follower", "ses_viewport_" + Math.random().toString(36).slice(2, 8), "system.readonly", authToken);
    state.client = client;
    setStatus("following", "authoring stream");
    await poll();
  } catch (e) {
    // Likely the panels aren't connected yet (auth token missing) — keep the poster, retry later.
    setStatus("waiting", "connect the panels first");
    try { client.close(); } catch { /* ignore */ }
  }
}

async function poll() {
  const c = state.client;
  if (!c || state.polling) return; // re-entrancy guard: a brush dab triggers an immediate poll(); it
  state.polling = true;            // must not race the scheduled poll and double-apply an additive deform.
  try {
    const res = await c.callTool("worldlog.tail", { since: state.cursor });
    if (res) {
      if (res.reset) { state.commands = []; state.cursor = 0; state.quarantined.clear(); }
      if (Array.isArray(res.commands) && res.commands.length > 0) {
        const newCmds = res.commands;
        const authorCmds = toAuthorCommands(newCmds);
        for (const cmd of res.commands) state.commands.push(cmd);
        // While scrubbed into the past, accumulate new commands but don't hot-apply them to the
        // frozen past view (returning to live replays the full stream).
        if (state.scrubLimit !== undefined) {
          // no-op: the past view stays put; state.commands keeps growing in the background
        } else if (state.running && !state.rebooting && !res.reset) {
          const r = await state.running.applyAuthorCommands(authorCmds);
          if (r.needsReboot) state.dirty = true;
        } else {
          state.dirty = true;
        }
        showActiveAgentTargets(authorCmds);
      }
      if (typeof res.next === "number") state.cursor = res.next;
      if (state.dirty && !state.rebooting) await reboot();
    }
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    console.warn("viewport poll failed", e);
    logConsolePanel("viewport poll failed: " + message, "err");
    setStatus("poll error", message);
  } finally {
    state.polling = false;
  }
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
      deselectEntity();
      return;
    }
    state.selectionGuardFrame = requestAnimationFrame(tick);
  };
  state.selectionGuardFrame = requestAnimationFrame(tick);
}

function selectEntity(id, running) {
  const entry = running?.entities?.resolve?.(id);
  if (!entry?.mesh || typeof entry.eid !== "number") return false;
  state.selected = { id, eid: entry.eid, mesh: entry.mesh };
  state.transformControls?.attach(entry.mesh);
  startSelectionGuardLoop();
  setStatus("selected", id);
  return true;
}

function deselectEntity() {
  stopSelectionGuardLoop();
  try { state.transformControls?.detach(); } catch { /* ignore — object may already be gone */ }
  state.selected = undefined;
  state.ctrlRotateActive = false;
  setStatus("following", "no selection");
}

function pickEntity(event) {
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
      if (selectEntity(id, running)) {
        window.dispatchEvent(new CustomEvent(VIEWPORT_ENTITY_SELECTED_EVENT, { detail: { entity: id, source: "viewport" } }));
      }
      return;
    }
  }
  if (!controls.axis) deselectEntity();
}

// --- In-game terrain brush (Slice 1) ---------------------------------------------------------------
// Raycast the ground under the cursor, then stamp a terrain.deform through the recorded command path
// (write-client -> server -> worldlog broadcast -> live in-place apply). NO optimistic pre-apply:
// terrain.deform is ADDITIVE, so applying locally AND via the broadcast-back would double every dab.
const SCULPT_TOOLS = new Set(["raise", "lower", "smooth", "flatten", "paint"]);
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
      await deformTerrain([p.x, p.z], state.brush.radius, delta, mode, state.brush.falloff);
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
  if (!running?.scene || !state.placeAsset) return null;
  if (placeGhost && placeGhostFor !== state.placeAsset.id) {
    try { placeGhost.parent?.remove(placeGhost); placeGhost.geometry.dispose(); placeGhost.material.dispose(); } catch { /* ignore */ }
    placeGhost = null;
  }
  if (placeGhost && placeGhost.parent !== running.scene) {
    try { placeGhost.parent?.remove(placeGhost); } catch { /* ignore */ }
    running.scene.add(placeGhost);
  }
  if (!placeGhost) {
    const b = Array.isArray(state.placeAsset.boundsM) ? state.placeAsset.boundsM : [4, 4, 4];
    const geo = new THREE.BoxGeometry(b[0], b[1], b[2]);
    geo.translate(0, b[1] / 2, 0); // pivot at the base so the footprint sits ON the ground
    const mat = new THREE.MeshBasicMaterial({ color: 0xe0552b, transparent: true, opacity: 0.28, depthTest: false });
    placeGhost = new THREE.Mesh(geo, mat);
    placeGhost.raycast = () => {}; // NEVER raycastable — else the ground raycast hits the ghost's own
    // top face (nearer the camera than the terrain) and it re-positions onto itself every pointermove,
    // walking toward the camera in a "growing" feedback loop.
    placeGhost.renderOrder = 998;
    placeGhost.visible = false;
    placeGhostFor = state.placeAsset.id;
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
  ghost.rotation.y = state.placeYaw;
  ghost.visible = true;
}
function hidePlaceGhost() { if (placeGhost) placeGhost.visible = false; }

// One click = one recorded asset.place = one step in the existing per-stroke undo trail.
async function placeCatalogAsset(event) {
  if (state.placing) return;
  const entry = state.placeAsset;
  const p = raycastGround(event);
  if (!entry || !p) return;
  state.placing = true;
  const before = state.commands.length;
  try {
    setStatus("placing", entry.title);
    await placeAsset(entry.id, [p.x, 0, p.z], { rotation: [0, state.placeYaw, 0] });
    await poll(); // pull the recorded placement straight back so it renders (or reboots to warm the GLB)
    state.strokeStartLen = before;
    recordStrokeBoundary();
    setStatus("placed", entry.title);
  } catch (e) {
    resetWriter();
    surfaceViewportWarning("asset place failed", e);
  } finally {
    state.placing = false;
  }
}

// Catalog fetch + palette rendering. Thumbnails are the QC renders (served from /assets/qc/...) —
// the same image the human approved in the queue, so the palette shows what was actually reviewed.
let catalogFilter = "all";
let catalogFetching = false;
async function refreshCatalog() {
  if (catalogFetching) return;
  catalogFetching = true;
  try {
    const res = await fetchCatalog();
    state.catalog = Array.isArray(res?.entries) ? res.entries : [];
    renderCatalogChips();
    renderCatalogGrid();
  } catch (e) {
    surfaceViewportWarning("asset catalog fetch failed", e);
  } finally {
    catalogFetching = false;
  }
}
function renderCatalogChips() {
  const row = hud?._catChips;
  if (!row) return;
  row.textContent = "";
  const cats = ["all", ...new Set(state.catalog.map((e) => e.category).filter(Boolean))];
  for (const c of cats) {
    const chip = document.createElement("button");
    chip.textContent = c;
    const active = catalogFilter === c;
    chip.style.cssText = "padding:2px 8px;border-radius:999px;font:11px system-ui;cursor:pointer;color:#fff;" +
      "border:1px solid " + (active ? "#e0552b" : "#454550") + ";background:" + (active ? "#e0552b" : "#2a2a32");
    chip.onclick = () => { catalogFilter = c; renderCatalogChips(); renderCatalogGrid(); };
    row.appendChild(chip);
  }
}
function renderCatalogGrid() {
  const grid = hud?._catGrid;
  if (!grid) return;
  const q = (hud._catSearch?.value || "").trim().toLowerCase();
  grid.textContent = "";
  for (const entry of state.catalog) {
    if (catalogFilter !== "all" && entry.category !== catalogFilter) continue;
    if (q && !(`${entry.title} ${entry.id} ${(entry.tags || []).join(" ")}`.toLowerCase().includes(q))) continue;
    const active = state.placeAsset?.id === entry.id;
    const card = document.createElement("div");
    card.style.cssText = "cursor:pointer;border-radius:6px;overflow:hidden;background:#2a2a32;" +
      "border:2px solid " + (active ? "#e0552b" : "#454550");
    const img = document.createElement("img");
    img.src = "/assets/" + String(entry.qcRender || "").replace(/^\/+/, "");
    img.alt = entry.title;
    img.style.cssText = "width:100%;aspect-ratio:1/1;object-fit:cover;display:block;background:#1c1c22";
    img.onerror = () => { img.style.visibility = "hidden"; }; // missing QC render → neutral tile
    const lab = document.createElement("div");
    lab.textContent = entry.title;
    lab.style.cssText = "padding:4px 6px;font:11px system-ui;color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    card.appendChild(img);
    card.appendChild(lab);
    card.onclick = () => {
      state.placeAsset = active ? null : entry;
      state.placeYaw = 0;
      renderCatalogGrid();
      if (state.placeAsset) setStatus("place: " + entry.title, "click ground to place · R rotates · Esc deselects");
      else { hidePlaceGhost(); setStatus("place: off", ""); }
    };
    grid.appendChild(card);
  }
  if (!grid.children.length) {
    const empty = document.createElement("div");
    empty.textContent = "no approved assets";
    empty.style.cssText = "grid-column:1/-1;color:#888;font:12px system-ui;padding:8px;text-align:center";
    grid.appendChild(empty);
  }
}

// The terrain-edit HUD (Slice 2): a floating panel over the viewport with the tool palette, brush
// sliders, falloff, and undo/redo. It IS the can't-miss edit indicator (accent dot + outline + cursor).
let hud = null;
const HUD_TOOLS = [["raise", "Raise"], ["lower", "Lower"], ["smooth", "Smooth"], ["flatten", "Flatten"], ["paint", "Paint"], ["catalog", "Catalog"]];
const HUD_MATS = [["sand", "Sand", "#c4b68e"], ["grass", "Grass", "#5f7f3c"], ["rock", "Rock", "#756657"], ["dirt", "Dirt", "#6f5334"]];
function styleToolBtn(b, active) {
  b.style.cssText = "padding:6px 4px;border-radius:5px;font:12px system-ui,sans-serif;cursor:pointer;color:#fff;" +
    "border:1px solid " + (active ? "#e0552b" : "#454550") + ";background:" + (active ? "#e0552b" : "#2a2a32");
}
function buildTerrainHud() {
  if (hud) return;
  hud = document.createElement("div");
  hud.style.cssText = "position:absolute;top:10px;left:10px;z-index:30;width:216px;padding:12px;border-radius:8px;" +
    "background:rgba(22,22,27,.95);color:#eee;font:13px system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.5);display:none";
  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:10px";
  head.innerHTML = '<span style="width:9px;height:9px;border-radius:999px;background:#e0552b;box-shadow:0 0 6px #e0552b"></span>' +
    '<strong style="letter-spacing:.03em;flex:1">TERRAIN EDIT</strong>';
  const exit = document.createElement("button");
  exit.textContent = "F4 exit";
  exit.style.cssText = "padding:3px 8px;border-radius:5px;border:1px solid #454550;background:#2a2a32;color:#bbb;font:11px system-ui;cursor:pointer";
  exit.onclick = () => { state.editMode = false; updateEditModeIndicator(); };
  head.appendChild(exit);
  hud.appendChild(head);
  const tools = document.createElement("div");
  tools.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:12px";
  hud._toolBtns = {};
  for (const [id, label] of HUD_TOOLS) {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => { state.brushTool = id; refreshHudTools(); setStatus("terrain edit", "tool: " + id); };
    tools.appendChild(b);
    hud._toolBtns[id] = b;
  }
  hud.appendChild(tools);
  // Material picker — only shown while the Paint tool is active.
  const matRow = document.createElement("div");
  matRow.style.cssText = "display:none;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:12px";
  hud._matBtns = {};
  for (const [id, label, hex] of HUD_MATS) {
    const b = document.createElement("button");
    b.textContent = label;
    b.dataset.hex = hex;
    b.onclick = () => { state.paintMaterial = id; refreshHudMats(); };
    matRow.appendChild(b);
    hud._matBtns[id] = b;
  }
  hud._matRow = matRow;
  hud.appendChild(matRow);
  // Asset catalog palette — only shown while the Catalog tool is active. Search + category chips +
  // a thumbnail grid of QC-approved assets; clicking a card arms the ghost place tool.
  const catPanel = document.createElement("div");
  catPanel.style.cssText = "display:none;margin-bottom:10px";
  const catSearch = document.createElement("input");
  catSearch.type = "search";
  catSearch.placeholder = "Search assets";
  catSearch.style.cssText = "width:100%;box-sizing:border-box;background:#2a2a32;color:#eee;border:1px solid #454550;" +
    "border-radius:5px;padding:5px 8px;font:12px system-ui;margin-bottom:8px";
  catSearch.oninput = () => renderCatalogGrid();
  catPanel.appendChild(catSearch);
  const catChips = document.createElement("div");
  catChips.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px";
  catPanel.appendChild(catChips);
  const catGrid = document.createElement("div");
  catGrid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:7px;max-height:260px;overflow:auto";
  catPanel.appendChild(catGrid);
  hud._catPanel = catPanel;
  hud._catSearch = catSearch;
  hud._catChips = catChips;
  hud._catGrid = catGrid;
  hud.appendChild(catPanel);
  const mkSlider = (label, min, max, step, get, set, fmt) => {
    const wrap = document.createElement("div");
    wrap.style.margin = "0 0 8px";
    const lab = document.createElement("label");
    lab.style.cssText = "display:flex;justify-content:space-between;font-size:12px;opacity:.85;margin-bottom:2px";
    const valSpan = document.createElement("span");
    lab.append(label + " ");
    lab.appendChild(valSpan);
    const inp = document.createElement("input");
    inp.type = "range"; inp.min = min; inp.max = max; inp.step = step; inp.value = get(); inp.style.width = "100%";
    valSpan.textContent = fmt(get());
    inp.oninput = () => { const v = parseFloat(inp.value); set(v); valSpan.textContent = fmt(v); };
    wrap.appendChild(lab); wrap.appendChild(inp); hud.appendChild(wrap);
  };
  mkSlider("Radius", 2, 60, 1, () => state.brush.radius, (v) => { state.brush.radius = v; if (brushRing?.visible) brushRing.scale.set(v, v, v); }, (v) => v + " m");
  mkSlider("Strength", 0.2, 4, 0.1, () => state.brush.strength, (v) => { state.brush.strength = v; }, (v) => v.toFixed(1));
  const fWrap = document.createElement("div");
  fWrap.style.margin = "0 0 4px";
  const fLab = document.createElement("label");
  fLab.textContent = "Falloff";
  fLab.style.cssText = "display:block;font-size:12px;opacity:.85;margin-bottom:2px";
  const fSel = document.createElement("select");
  fSel.style.cssText = "width:100%;background:#2a2a32;color:#eee;border:1px solid #454550;border-radius:5px;padding:4px";
  for (const o of ["smooth", "linear", "constant"]) {
    const opt = document.createElement("option"); opt.value = o; opt.textContent = o; fSel.appendChild(opt);
  }
  fSel.value = state.brush.falloff;
  fSel.onchange = () => { state.brush.falloff = fSel.value; };
  fWrap.appendChild(fLab); fWrap.appendChild(fSel); hud.appendChild(fWrap);
  const ur = document.createElement("div");
  ur.style.cssText = "display:flex;gap:6px;margin-top:10px";
  const undoB = document.createElement("button"); undoB.textContent = "↶ Undo"; undoB.onclick = () => undoStroke();
  const redoB = document.createElement("button"); redoB.textContent = "↷ Redo"; redoB.onclick = () => redoStroke();
  for (const b of [undoB, redoB]) {
    b.style.cssText = "flex:1;padding:6px;border-radius:5px;border:1px solid #454550;background:#2a2a32;color:#eee;font:12px system-ui;cursor:pointer";
    ur.appendChild(b);
  }
  hud.appendChild(ur);
  const par = canvas.parentElement || document.body;
  if (par !== document.body && getComputedStyle(par).position === "static") par.style.position = "relative";
  par.appendChild(hud);
}
function styleMatBtn(b, active) {
  const hex = b.dataset.hex || "#888";
  b.style.cssText = "padding:6px 4px;border-radius:5px;font:12px system-ui,sans-serif;cursor:pointer;color:#fff;" +
    "text-shadow:0 1px 2px rgba(0,0,0,.6);border:2px solid " + (active ? "#fff" : "#454550") + ";background:" + hex;
}
function refreshHudMats() {
  if (!hud?._matBtns) return;
  for (const id of Object.keys(hud._matBtns)) styleMatBtn(hud._matBtns[id], id === state.paintMaterial);
}
function refreshHudTools() {
  if (!hud?._toolBtns) return;
  for (const [id] of HUD_TOOLS) styleToolBtn(hud._toolBtns[id], id === state.brushTool);
  if (hud._matRow) {
    const paint = state.brushTool === "paint";
    hud._matRow.style.display = paint ? "grid" : "none";
    if (paint) refreshHudMats();
  }
  if (hud._catPanel) {
    const cat = state.brushTool === "catalog";
    hud._catPanel.style.display = cat ? "block" : "none";
    if (cat) { hideBrushRing(); void refreshCatalog(); }
    else hidePlaceGhost();
  }
}
function updateEditModeIndicator() {
  buildTerrainHud();
  if (state.editMode) {
    refreshHudTools();
    hud.style.display = "block";
    canvas.style.outline = "2px solid #e0552b";
    canvas.style.outlineOffset = "-2px";
    canvas.style.cursor = "crosshair";
  } else {
    hud.style.display = "none";
    canvas.style.outline = "";
    canvas.style.cursor = "";
    hideBrushRing();
  }
}

// --- Per-stroke undo trail (Ctrl+Z / Ctrl+Shift+Z) -------------------------------------------------
// Undo is non-destructive time-travel: we scrub the world to the command prefix BEFORE a stroke (the
// same mechanism the History panel uses). A stroke is one press-drag-release, so one Ctrl+Z undoes a
// whole stroke's worth of dabs, not one dab.
function scrubTo(limit) {
  window.dispatchEvent(new CustomEvent("limina:scrub-to", { detail: { limit: limit == null ? null : limit } }));
}
function recordStrokeBoundary() {
  // Called after a stroke's dabs have flushed. If we had undone strokes, a fresh edit branches: drop
  // the redo tail. Then mark the new live boundary.
  if (state.undoMarks.length === 0) state.undoMarks.push(state.strokeStartLen ?? state.commands.length);
  if (state.undoAt < state.undoMarks.length - 1) state.undoMarks.length = state.undoAt + 1;
  state.undoMarks.push(state.commands.length);
  state.undoAt = state.undoMarks.length - 1;
}
function undoStroke() {
  if (state.undoAt <= 0) { setStatus("nothing to undo", ""); return; }
  state.undoAt -= 1;
  scrubTo(state.undoMarks[state.undoAt]);
  setStatus("undo", `${state.undoAt}/${state.undoMarks.length - 1} strokes`);
}
function redoStroke() {
  if (state.undoAt >= state.undoMarks.length - 1) { setStatus("nothing to redo", ""); return; }
  state.undoAt += 1;
  scrubTo(state.undoAt >= state.undoMarks.length - 1 ? null : state.undoMarks[state.undoAt]);
  setStatus("redo", `${state.undoAt}/${state.undoMarks.length - 1} strokes`);
}

export async function applyOptimisticUpdate(entity, component, value) {
  const running = state.running;
  if (!running || typeof running.applyAuthorCommands !== "function") {
    // Surface, don't swallow: if applyAuthorCommands is missing the served limina-runtime.js bundle
    // is stale (rebuild: `cd js && npm run bundle:editor`, then hard-refresh) or the live sim isn't up.
    logConsolePanel("optimistic edit skipped — live viewport not ready or runtime bundle out of date (rebuild bundle:editor + hard-refresh)", "err");
    return { applied: 0, needsReboot: false };
  }
  // Carry the skill's OWN required permission: ecs.updateComponent needs `ecs.modify`, which the
  // runLive re-author DEFAULT_GRANTS does not include — without it the optimistic invoke is
  // permission-denied and throws before the edit reaches the canvas.
  return running.applyAuthorCommands([
    { kind: "skill", tool: "ecs.updateComponent", input: { entity, component, value }, agentId: "human", perms: ["ecs.modify"] },
  ]);
}

export async function reconcileViewport() {
  await reboot();
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
  const updates = [
    ["position", mesh.position.toArray()],
    ["scale", mesh.scale.toArray()],
    ["rotation", mesh.quaternion.toArray()],
  ];
  try {
    setStatus("applying", selected.id);
    for (const [component, value] of updates) await applyOptimisticUpdate(selected.id, component, value);
    if (typeof running?.setSyncSuppressed === "function") running.setSyncSuppressed(selected.eid, false);
    for (const [component, value] of updates) await writeUpdate(selected.id, component, value);
    setStatus("applied", selected.id);
  } catch (e) {
    resetWriter();
    surfaceViewportWarning("viewport gizmo write failed", e);
    setStatus("write failed", e && e.message ? e.message : String(e));
    await reboot();
  } finally {
    if (typeof running?.setSyncSuppressed === "function") running.setSyncSuppressed(selected.eid, false);
  }
}

async function reboot() {
  // Time-travel: when scrubbed to a past point, replay only the authoring-command PREFIX up to
  // the playhead (state.scrubLimit); undefined = live (replay everything). state.commands still
  // accumulates in the background so returning to live is instant.
  const cmds = state.scrubLimit === undefined ? state.commands : state.commands.slice(0, state.scrubLimit);
  if (cmds.length === 0) { setStatus("following", "empty — waiting for the agent to build"); return; }
  state.rebooting = true;
  state.dirty = false;
  try {
    clearGizmo();
    removeGridHelper();
    restoreWireframeMaterials();
    if (state.running) { try { state.running.stop(); } catch { /* ignore */ } state.running = undefined; }
    const w = canvas.clientWidth || 640, h = canvas.clientHeight || 360;
    canvas.width = w; canvas.height = h;
    const past = state.scrubLimit !== undefined;
    // Convert to AuthorCommands, then SKIP any command quarantined on a prior pass (it failed
    // authoring — replaying it would wedge every future reboot). keptIndex maps a kept command's
    // position back to its index in authorCmds, so a NEW failure can be quarantined by that index.
    const authorCmds = toAuthorCommands(cmds);
    const { kept, keptIndex } = partitionQuarantined(authorCmds, state.quarantined);
    setStatus(past ? "past" : "rendering", `${kept.length} authoring commands${past ? " (history)" : ""}`);
    state.running = await runLive({
      canvas, width: w, height: h,
      commands: kept,
      input: window,
      onStatus: setStatus,
      orbit: { center: [0, 1, 0], radius: 16, height: 8 },
      orbitControls: true,
      // WebGL2 backend: some drivers lose the WebGPU device mid-render (black canvas); the live
      // /examples site + the old viewport force WebGL2 for the same reason.
      forceWebGL: true,
    });
    if (state.running === null) {
      // The environment could not HOST the viewport (no COOP/COEP, no WebGPU, or a hard worker
      // startup error). runLive already reported the SPECIFIC reason via onStatus=setStatus — do NOT
      // stomp it with a generic "no COOP/COEP or WebGPU" message (which masked real authoring/worker
      // failures as a fake GPU error). Leave the precise status runLive set.
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
    installGridHelper(state.running);
    applyWireframeMode(state.running);
    const authored = kept.length - failures.length;
    setStatus(
      past ? "past" : "live",
      failures.length > 0
        ? `${authored} commands · ${failures.length} quarantined${past ? " · viewing history" : ""}`
        : `${kept.length} commands${past ? " · viewing history" : ""}`,
    );
  } catch (e) {
    setStatus("error", e && e.message ? e.message : String(e));
  } finally {
    state.rebooting = false;
    if (state.dirty) void reboot(); // a batch arrived while rebooting — coalesce into one more pass
  }
}

canvas.addEventListener("pointerdown", (event) => {
  if (!event.isPrimary) return;
  pointerClick.id = event.pointerId;
  pointerClick.x = event.clientX;
  pointerClick.y = event.clientY;
  // Terrain edit mode: a drag on the ground sculpts — UNLESS Space is held, which hands the drag to the
  // camera so you can reframe and keep editing without leaving edit mode.
  if (state.editMode && !state.spaceNav && SCULPT_TOOLS.has(state.brushTool)) {
    state.brushStroking = true;
    state.strokeStartLen = state.commands.length; // command count before this stroke (for undo)
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
  if (state.editMode) {
    // The cursor overlay tracks the active tool: sculpt/paint → brush ring, catalog → footprint ghost.
    if (state.brushTool === "catalog") updatePlaceGhost(event);
    else updateBrushRing(event);
  }
  if (!state.brushStroking) return;
  const now = performance.now();
  if (now - state.brushLast < 55) return; // throttle dabs so a drag doesn't flood the server
  state.brushLast = now;
  void brushDab(event);
});
canvas.addEventListener("pointerleave", () => { hideBrushRing(); hidePlaceGhost(); });
canvas.addEventListener("pointerup", (event) => {
  if (!event.isPrimary || pointerClick.id !== event.pointerId) return;
  const dx = event.clientX - pointerClick.x;
  const dy = event.clientY - pointerClick.y;
  pointerClick.id = undefined;
  if (state.brushStroking) {
    state.brushStroking = false;
    try { canvas.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    state.running?.setCameraControlsEnabled?.(true);
    // Close the undo boundary once the stroke's dabs have flushed back through the poll.
    if (state.strokeDid) void (async () => { await poll(); recordStrokeBoundary(); })();
    return; // a sculpt stroke never falls through to entity selection
  }
  if (Math.hypot(dx, dy) <= CLICK_MOVE_TOLERANCE_PX) {
    // Catalog place tool: a click on the ground places the armed asset (a drag still orbits the
    // camera — "catalog" is not in SCULPT_TOOLS, so no stroke ever starts).
    if (state.editMode && !state.spaceNav && state.brushTool === "catalog" && state.placeAsset) {
      void placeCatalogAsset(event);
      return;
    }
    pickEntity(event);
  }
});
canvas.addEventListener("pointercancel", (event) => {
  if (state.brushStroking) {
    state.brushStroking = false;
    state.running?.setCameraControlsEnabled?.(true);
  }
  if (pointerClick.id === event.pointerId) pointerClick.id = undefined;
});
window.addEventListener(SELECT_ENTITY_EVENT, (event) => {
  const entity = event instanceof CustomEvent ? event.detail?.entity : undefined;
  if (typeof entity !== "string" || !entity.startsWith("ent_")) return;
  selectEntity(entity, state.running);
});
// History time-travel: the History panel scrubs over the authoring-command timeline and emits
// the target here — replay the world to that prefix (limit=null → back to live/following).
window.addEventListener("limina:scrub-to", (event) => {
  const limit = event instanceof CustomEvent ? event.detail?.limit : undefined;
  const next = (limit === null || limit === undefined) ? undefined : Math.max(0, Math.min(limit | 0, state.commands.length));
  if (next === state.scrubLimit) return;
  state.scrubLimit = next;
  if (!state.rebooting) void reboot();
});
window.addEventListener("keydown", (event) => {
  const controls = state.transformControls;
  if (isTextInputTarget(event.target)) return;
  // Undo trail: Ctrl+Z undoes the last terrain stroke, Ctrl+Shift+Z redoes. Intercept before the
  // Ctrl-rotate handler below (which returns early on any ctrlKey press).
  if ((event.ctrlKey || event.metaKey) && (event.key === "z" || event.key === "Z")) {
    event.preventDefault();
    if (event.shiftKey) redoStroke(); else undoStroke();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && (event.key === "y" || event.key === "Y")) {
    event.preventDefault();
    redoStroke();
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
    updateEditModeIndicator();
    setStatus(state.editMode ? "terrain edit: ON" : "terrain edit: off",
      state.editMode ? `${state.brushTool} · drag to sculpt · Ctrl inverts · 1-6 tool` : "");
    return;
  }
  if (state.editMode && (key === "1" || key === "2" || key === "3" || key === "4" || key === "5" || key === "6")) {
    event.preventDefault();
    state.brushTool = key === "1" ? "raise" : key === "2" ? "lower" : key === "3" ? "smooth"
      : key === "4" ? "flatten" : key === "5" ? "paint" : "catalog";
    updateEditModeIndicator();
    setStatus("terrain edit", `tool: ${state.brushTool}`);
    return;
  }
  // Catalog place tool: R rotates the armed ghost 15°, Esc disarms it. Checked BEFORE the gizmo
  // w/e/r modes below so R never falls through to "scale" while placing.
  if (state.editMode && state.brushTool === "catalog" && state.placeAsset) {
    if (key === "r") {
      event.preventDefault();
      state.placeYaw = (state.placeYaw + Math.PI / 12) % (Math.PI * 2);
      updatePlaceGhost();
      return;
    }
    if (key === "escape") {
      event.preventDefault();
      state.placeAsset = null;
      hidePlaceGhost();
      renderCatalogGrid();
      setStatus("place: off", "");
      return;
    }
  }
  if (key === "s") {
    event.preventDefault();
    toggleSnapping();
    return;
  }
  if (key === "x") {
    event.preventDefault();
    setTransformSpace(viewportOptions.transformSpace === "local" ? "world" : "local");
    return;
  }
  if (key === "g") {
    event.preventDefault();
    toggleGrid();
    return;
  }
  if (key === "f") {
    event.preventDefault();
    toggleWireframe();
    return;
  }
  if (!controls) return;
  if (key === "w") controls.setMode("translate");
  else if (key === "e") controls.setMode("rotate");
  else if (key === "r") controls.setMode("scale");
});
// Delete / Backspace destroys the selected entity (immediate — the world log records the destroy,
// which is the recovery path). Guarded by isTextInputTarget so it never fires while typing in chat
// or an inspector field. The recorded destroy re-authors back through poll() and drops the mesh.
window.addEventListener("keydown", (event) => {
  if (event.key !== "Delete" && event.key !== "Backspace") return;
  if (isTextInputTarget(event.target)) return;
  const selected = state.selected;
  if (!selected) return;
  event.preventDefault();
  const id = selected.id;
  deselectEntity();
  destroyEntity(id).catch((e) => {
    resetWriter();
    surfaceViewportWarning("destroy failed", e);
  });
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

// Re-fit the canvas to its container when the layout changes size (a sidebar collapses/expands) or
// the window resizes. The canvas is otherwise only sized at reboot (runLive), so a docked-sidebar
// toggle would leave it stretched until the next re-author. Resizes the drawing buffer + the live
// renderer + the camera aspect in place — no reboot, no scene rebuild.
function resizeViewport() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w; canvas.height = h;
  const running = state.running;
  try { running?.renderer?.setSize?.(w, h, false); } catch { /* ignore */ }
  const cam = running?.camera;
  if (cam) { cam.aspect = w / h; cam.updateProjectionMatrix?.(); }
}
let winResizeRaf = 0;
window.addEventListener("resize", () => { cancelAnimationFrame(winResizeRaf); winResizeRaf = requestAnimationFrame(resizeViewport); });
// Sidebar collapse animates over ~160ms (CSS); re-fit once the transition has settled.
window.addEventListener("limina:layout-changed", () => { setTimeout(resizeViewport, 200); });

bindViewportUi();
setStatus("waiting", "connect the panels to follow the authoring stream");
// Self-scheduling loop (NOT a fixed setInterval): the next tick is scheduled AFTER the
// current poll/reboot finishes, so a slow re-author can never overlap the next poll into a
// compounding request flood that pegs the server.
let viewportLoopStopped = false;
const viewportTick = async () => {
  if (viewportLoopStopped) return;
  try { await (state.client ? poll() : tryConnect()); } finally {
    if (!viewportLoopStopped) setTimeout(() => { void viewportTick(); }, 1000);
  }
};
void viewportTick();
// (The ☰ tools menu + floating windows are owned by editor/src/windows.js.)

window.addEventListener("beforeunload", () => {
  viewportLoopStopped = true;
  clearAgentHighlight();
  clearGizmo();
  removeGridHelper();
  restoreWireframeMaterials();
  try { state.running?.stop(); } catch { /* ignore */ }
  try { state.client?.close(); } catch { /* ignore */ }
});
