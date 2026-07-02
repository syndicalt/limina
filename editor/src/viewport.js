// Live viewport — renders the world an agent/human is building on the authoritative editor server,
// by re-authoring the server's recorded AUTHORING command stream (worldlog.tail) through the SAME
// Mode-B live runtime (runLive). This replaces the former hardcoded command fixture: the viewport
// now reflects the REAL editor_host world log, polled incrementally and re-rendered as it grows.
//
// First cut: on each new batch of authoring commands, REBOOT runLive with the full translated
// command list (simple + correct; a brief flicker per update, at most once per poll). The smooth
// incremental feed (pushCommands into the running worker + SnapshotRing growth) is a follow-up.
//
// Connection: a READ-ONLY follower that reuses the SAME server + auth the MCP panels use — it reads
// the page's shared #url / #auth-token inputs and connects as the `system.readonly` profile once the
// user has connected the panels (so it shares the token the user entered). No writes, no gating.
//
// SAB requires CROSS-ORIGIN ISOLATION (COOP: same-origin + COEP: require-corp). Serve the editor with
// `node tools/scaffold/scripts/serve.mjs editor 5173`. Without it (or without WebGPU) runLive returns
// null and we show the poster; the MCP panels keep working.

import { runLive } from "../vendor/limina-runtime.js";
import { McpClient } from "./mcp-client.js";

const canvas = document.getElementById("editor-viewport");
const statusEl = document.getElementById("viewport-status");
function setStatus(phase, detail) {
  if (statusEl) statusEl.textContent = detail !== undefined ? `${phase}: ${detail}` : phase;
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
const state = { client: undefined, running: undefined, cursor: 0, commands: [], rebooting: false, dirty: false };

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
        for (const cmd of res.commands) state.commands.push(cmd);
        state.dirty = true;
      }
      if (typeof res.next === "number") state.cursor = res.next;
      if (state.dirty && !state.rebooting) await reboot();
    }
  } catch (e) {
    setStatus("poll error", e && e.message ? e.message : String(e));
  }
}

async function reboot() {
  if (state.commands.length === 0) { setStatus("following", "empty — waiting for the agent to build"); return; }
  state.rebooting = true;
  state.dirty = false;
  try {
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
      // WebGL2 backend: some drivers lose the WebGPU device mid-render (black canvas); the live
      // /examples site + the old viewport force WebGL2 for the same reason.
      forceWebGL: true,
    });
    if (state.running === null) setStatus("error", "no COOP/COEP or WebGPU — viewport unavailable");
    else setStatus("live", `${state.commands.length} commands`);
  } catch (e) {
    setStatus("error", e && e.message ? e.message : String(e));
  } finally {
    state.rebooting = false;
    if (state.dirty) void reboot(); // a batch arrived while rebooting — coalesce into one more pass
  }
}

setStatus("waiting", "connect the panels to follow the authoring stream");
const loop = setInterval(() => { void (state.client ? poll() : tryConnect()); }, 1000);

window.addEventListener("beforeunload", () => {
  clearInterval(loop);
  try { state.running?.stop(); } catch { /* ignore */ }
  try { state.client?.close(); } catch { /* ignore */ }
});
