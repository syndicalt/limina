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

import { runLive, TransformControls, THREE } from "../vendor/limina-runtime.js";
import { McpClient } from "./mcp-client.js";
import { destroyEntity, resetWriter, writeUpdate } from "./write-client.js";

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
    if (cmd.kind === "physics") out.push({ kind: "physics", op: PHYSICS_OP_FN[cmd.op], args: cmd.args });
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
  rebooting: false,
  dirty: false,
  transformControls: undefined,
  transformHelper: undefined,
  gridHelper: undefined,
  selected: undefined,
  ctrlRotateDown: false,
  ctrlRotateActive: false,
  wireframeMaterials: new Map(),
  // Per-builder cues: agentId -> { helper, entityId, timeout }. Each builder's cue auto-clears
  // independently after 1500ms; a single shared RAF loop keeps every helper glued to its mesh.
  agentHighlights: new Map(),
  agentHighlightFrame: undefined,
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
  if (!c) return;
  try {
    const res = await c.callTool("worldlog.tail", { since: state.cursor });
    if (res) {
      if (res.reset) { state.commands = []; state.cursor = 0; }
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

function selectEntity(id, running) {
  const entry = running?.entities?.resolve?.(id);
  if (!entry?.mesh || typeof entry.eid !== "number") return false;
  state.selected = { id, eid: entry.eid, mesh: entry.mesh };
  state.transformControls?.attach(entry.mesh);
  setStatus("selected", id);
  return true;
}

function deselectEntity() {
  state.transformControls?.detach();
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
    setStatus(past ? "past" : "rendering", `${cmds.length} authoring commands${past ? " (history)" : ""}`);
    state.running = await runLive({
      canvas, width: w, height: h,
      commands: toAuthorCommands(cmds),
      input: window,
      onStatus: setStatus,
      orbit: { center: [0, 1, 0], radius: 16, height: 8 },
      orbitControls: true,
      // WebGL2 backend: some drivers lose the WebGPU device mid-render (black canvas); the live
      // /examples site + the old viewport force WebGL2 for the same reason.
      forceWebGL: true,
    });
    if (state.running === null) setStatus("error", "no COOP/COEP or WebGPU — viewport unavailable");
    else {
      installGizmo(state.running);
      installGridHelper(state.running);
      applyWireframeMode(state.running);
      setStatus(past ? "past" : "live", `${cmds.length} commands${past ? " · viewing history" : ""}`);
    }
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
});
canvas.addEventListener("pointerup", (event) => {
  if (!event.isPrimary || pointerClick.id !== event.pointerId) return;
  const dx = event.clientX - pointerClick.x;
  const dy = event.clientY - pointerClick.y;
  pointerClick.id = undefined;
  if (Math.hypot(dx, dy) <= CLICK_MOVE_TOLERANCE_PX) pickEntity(event);
});
canvas.addEventListener("pointercancel", (event) => {
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
  if (controls && (event.key === "Control" || event.ctrlKey)) {
    state.ctrlRotateDown = true;
    reconcileCtrlRotateMode();
    return;
  }
  const key = event.key.toLowerCase();
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
  if (event.key !== "Control") return;
  state.ctrlRotateDown = false;
  reconcileCtrlRotateMode();
});
window.addEventListener("blur", () => {
  state.ctrlRotateDown = false;
  reconcileCtrlRotateMode();
});

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
