// Live viewport — drives the Phase 8 Mode-B live runtime (runLive) for the editor.
//
// runLive spawns the M3 sim-worker (authoritative wasm-Rapier fixed-step solver on
// its own thread), JOINs its SharedArrayBuffer transform bridge, re-authors the
// SAME command log against the real three scene (matching eids → meshes), and
// renders the worker's simulation here every animation frame with M4 interpolation.
//
// The command log below is a stand-in for "the editor's authoring log" — the same
// AuthorCommand shape an agent's edits produce (a `physics` command calls an engine
// physics op; a `skill` command re-invokes a recorded tool through the registry).
// Wire this array to the live world-log when the editor's authoring stream lands.
//
// SAB requires CROSS-ORIGIN ISOLATION (COOP: same-origin + COEP: require-corp).
// Serve the editor with `node tools/scaffold/scripts/serve.mjs editor 5173`. Without
// it (or without WebGPU) runLive returns null + reports `error` — we show a poster,
// the MCP panels keep working. The live render itself is BROWSER-UAT.

import { runLive } from "../vendor/limina-runtime.js";

const canvas = document.getElementById("editor-viewport");
const statusEl = document.getElementById("viewport-status");

function setStatus(phase, detail) {
  if (statusEl) statusEl.textContent = detail !== undefined ? `${phase}: ${detail}` : phase;
}

// A minimal live world: ground + two dropped dynamic bodies + a player character.
const commands = [
  { kind: "physics", op: "op_physics_create_world", args: [-9.81] },
  { kind: "physics", op: "op_physics_add_ground", args: [0] },
  { kind: "skill", tool: "scene.createEntity", input: { shape: "box", size: 1, position: [0, 6, 0], dynamic: true, collider: "box", color: 0x44aaff } },
  { kind: "skill", tool: "scene.createEntity", input: { shape: "sphere", size: 1, position: [1.6, 9, 0.4], dynamic: true, collider: "sphere", color: 0xff8a3d } },
  { kind: "skill", tool: "player.spawn", input: { position: [3, 1, 3] } },
];

let running;

async function boot() {
  if (!canvas) { setStatus("error", "missing #editor-viewport canvas"); return; }
  const w = canvas.clientWidth || 640;
  const h = canvas.clientHeight || 360;
  canvas.width = w;
  canvas.height = h;
  setStatus("loading", "starting live runtime");
  try {
    running = await runLive({
      canvas,
      width: w,
      height: h,
      commands,
      input: window,
      onStatus: setStatus,
      orbit: { center: [0, 1, 0], radius: 14, height: 7 },
    });
    // running === null ⇒ unsupported environment (no COOP/COEP or no WebGPU); the
    // status is already set to `error` by runLive and the canvas shows its poster bg.
  } catch (e) {
    setStatus("error", e && e.message ? e.message : String(e));
  }
}

// Tear the worker + loop down on navigation so a reload doesn't leak a sim-worker.
window.addEventListener("beforeunload", () => { try { running?.stop(); } catch { /* ignore */ } });

void boot();
