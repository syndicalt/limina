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

import { runLive, TransformControls, THREE } from "../vendor/limina-runtime.js";
import { McpClient } from "./mcp-client.js";
import { resetWriter, writeUpdate } from "./write-client.js";

const canvas = document.getElementById("editor-viewport");
const statusEl = document.getElementById("viewport-status");
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
  selected: undefined,
};
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const CLICK_MOVE_TOLERANCE_PX = 5;
const pointerClick = { id: undefined, x: 0, y: 0 };

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
        for (const cmd of res.commands) state.commands.push(cmd);
        if (state.running && !state.rebooting && !res.reset) {
          const r = await state.running.applyAuthorCommands(toAuthorCommands(newCmds));
          if (r.needsReboot) state.dirty = true;
        } else {
          state.dirty = true;
        }
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

function clearGizmo() {
  state.selected = undefined;
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

function installGizmo(running) {
  clearGizmo();
  if (!running?.scene || !running?.camera || !running?.renderer?.domElement || typeof TransformControls !== "function") return;
  const controls = new TransformControls(running.camera, running.renderer.domElement);
  const helper = typeof controls.getHelper === "function" ? controls.getHelper() : controls;
  running.scene.add(helper);
  controls.setMode("translate");
  controls.addEventListener("dragging-changed", (event) => {
    const selected = state.selected;
    const active = event.value === true;
    if (typeof running.setCameraControlsEnabled === "function") {
      if (active) running.setCameraControlsEnabled(false);
      else running.setCameraControlsEnabled(true);
    }
    if (!selected || typeof running.setSyncSuppressed !== "function") return;
    if (active) running.setSyncSuppressed(selected.eid, true);
    else void commitSelectedTransform(selected, running);
  });
  state.transformControls = controls;
  state.transformHelper = helper;
}

function selectEntity(id, running) {
  const entry = running?.entities?.resolve?.(id);
  if (!entry?.mesh || typeof entry.eid !== "number") return;
  state.selected = { id, eid: entry.eid, mesh: entry.mesh };
  state.transformControls?.attach(entry.mesh);
  setStatus("selected", id);
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
      selectEntity(id, running);
      return;
    }
  }
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
  if (state.commands.length === 0) { setStatus("following", "empty — waiting for the agent to build"); return; }
  state.rebooting = true;
  state.dirty = false;
  try {
    clearGizmo();
    if (state.running) { try { state.running.stop(); } catch { /* ignore */ } state.running = undefined; }
    const w = canvas.clientWidth || 640, h = canvas.clientHeight || 360;
    canvas.width = w; canvas.height = h;
    setStatus("rendering", `${state.commands.length} authoring commands`);
    state.running = await runLive({
      canvas, width: w, height: h,
      commands: toAuthorCommands(state.commands),
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
      setStatus("live", `${state.commands.length} commands`);
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
window.addEventListener("keydown", (event) => {
  const controls = state.transformControls;
  if (!controls) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
  if (event.key === "w") controls.setMode("translate");
  else if (event.key === "e") controls.setMode("rotate");
  else if (event.key === "r") controls.setMode("scale");
});

setStatus("waiting", "connect the panels to follow the authoring stream");
const loop = setInterval(() => { void (state.client ? poll() : tryConnect()); }, 1000);
// (The ☰ tools menu + floating windows are owned by editor/src/windows.js.)

window.addEventListener("beforeunload", () => {
  clearInterval(loop);
  clearGizmo();
  try { state.running?.stop(); } catch { /* ignore */ }
  try { state.client?.close(); } catch { /* ignore */ }
});
