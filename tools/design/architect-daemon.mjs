// architect-daemon.mjs — ARCHITECT DAEMON v0 (editor Slice 6): the request-watcher that makes the
// ＋New asset loop autonomous. Polls asset.requests, claims new/failed generic-asset requests,
// and hands each one to the fixed-image isolation broker. The networked model worker can write
// source only into its private stage; Blender and QC then run networkless. A successful job stops
// at awaiting-reviewed-import. It never writes the repository asset catalog or invokes GPU QC.
//
// Usage: node tools/design/architect-daemon.mjs [--interval 30] [--dry-run] [--once]
//   --interval <seconds>  poll period (default 30)
//   --dry-run             log what WOULD be claimed/spawned; never mutates state or spawns
//   --once                run a single poll cycle (claim + process whatever it finds), then exit
//
// State: .limina/architect-daemon.json — requestId -> {status, startedAt, title, category,
// manifest?, artifactSha256?, error?}. A completed job has status awaiting-reviewed-import.
//
// Concurrency: ONE broker child at a time (this process awaits generation→Blender→QC before
// starting the next request). This is a v0, not a fleet scheduler.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assertGenericAssetAuthoringCategory } from "../../js/src/assets/generic-asset-authoring-policy.mjs";
import {
  runIsolatedArchitectJob,
  validateArchitectRequest,
  validateArchitectRequestId,
} from "./architect-isolation.mjs";
import { requireArchitectEditorToken } from "./architect-security.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
let TOKEN;
try { TOKEN = requireArchitectEditorToken(process.env, "architect-daemon"); }
catch (error) { console.error(error.message); process.exit(2); }
const WS_URL = "ws://localhost:8787/";

const STATE_PATH = join(ROOT, ".limina", "architect-daemon.json");
const RPC_TIMEOUT_MS = 15_000;
const INITIAL_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;

// ---- args ------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
let intervalS = 30, dryRun = false, once = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--interval") intervalS = Number(argv[++i]) || 30;
  else if (argv[i] === "--dry-run") dryRun = true;
  else if (argv[i] === "--once") once = true;
  else { console.error(`unknown arg: ${argv[i]}`); process.exit(2); }
}

const log = (msg) => console.log(`[architect-daemon] ${new Date().toISOString()} ${msg}`);

// ---- state -------------------------------------------------------------------------------------
function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return {}; }
}
function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

// ---- naming --------------------------------------------------------------------------------
// Title = the whole description, title-cased, for the catalog entry / architect-run.mjs arg.
function titleCase(description) {
  return description.trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ").slice(0, 256);
}

// ---- WS client (short-lived connection per call — polling cadence is minutes, not ms, so a fresh
// connect per poll is simpler and more robust than a long-lived socket across an isolated build
// window; "reconnect w/ backoff" below governs retries when the editor host is unreachable). -----
function rpcOnce(method, params) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const done = (fn, val) => { if (!settled) { settled = true; try { ws.close(); } catch { /* noop */ } fn(val); } };
    const ws = new WebSocket(WS_URL);
    let idc = 1;
    const pending = new Map();
    const timer = setTimeout(() => done(rejectPromise, new Error("rpc timeout")), RPC_TIMEOUT_MS);
    function rpc(m, pa = {}) {
      return new Promise((res, rej) => {
        const id = idc++;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: m, params: pa }));
      });
    }
    ws.addEventListener("message", (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m && m.id != null && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
      }
    });
    ws.addEventListener("error", (e) => { clearTimeout(timer); done(rejectPromise, new Error(e.message || "ws error — editor host unreachable at " + WS_URL)); });
    ws.addEventListener("open", async () => {
      try {
        await rpc("initialize", { agentId: "architect-daemon", sessionId: `daemon-${process.pid}-${Date.now()}`, profile: "builder.readWrite", authToken: TOKEN });
        const result = await rpc("tools/call", { name: method, arguments: params });
        clearTimeout(timer);
        if (result && result.success === false) { done(rejectPromise, new Error(result.error?.message || "tool call failed")); return; }
        done(resolvePromise, result.result);
      } catch (e) { clearTimeout(timer); done(rejectPromise, e); }
    });
  });
}

let backoffMs = INITIAL_BACKOFF_MS;
async function fetchRequests() {
  const r = await rpcOnce("asset.requests", {});
  backoffMs = INITIAL_BACKOFF_MS; // reset on success
  return r.requests;
}

// ---- shutdown -----------------------------------------------------------------------------
let shuttingDown = false;
let currentChild = null;
let currentRequestId = null;
process.on("SIGINT", () => {
  if (shuttingDown) { process.exit(130); return; }
  shuttingDown = true;
  log("SIGINT — shutting down");
  if (currentChild && currentRequestId) {
    log(`terminating in-flight authoring child for ${currentRequestId}`);
    try { currentChild.kill("SIGTERM"); } catch { /* noop */ }
    const state = loadState();
    state[currentRequestId] = { ...(state[currentRequestId] || {}), status: "failed", error: "interrupted by SIGINT" };
    saveState(state);
  }
});

async function sleepInterruptible(ms) {
  const step = 200;
  let elapsed = 0;
  while (elapsed < ms && !shuttingDown) {
    await new Promise((r) => setTimeout(r, Math.min(step, ms - elapsed)));
    elapsed += step;
  }
}

// ---- per-request handling -----------------------------------------------------------------
async function handleRequest(req, state) {
  // Re-read the state FILE before deciding: state is loaded once per poll, and an authoring run can
  // hold a poll open for many minutes — a user cancelling a queued request (status: "cancelled" written
  // externally) must take effect mid-poll, not be clobbered by this cycle's stale in-memory copy.
  let requestId;
  try {
    requestId = validateArchitectRequestId(req?.requestId);
  } catch (error) {
    log(`invalid request refused: ${error.message}`);
    return;
  }
  if (!dryRun) Object.assign(state, loadState());
  const existing = state[requestId];
  if (existing && existing.status !== "failed") return;
  try { assertGenericAssetAuthoringCategory(req.category, "architect-daemon"); }
  catch (error) {
    log(`routing refusal for ${requestId}: ${error.message}`);
    if (!dryRun) { state[requestId] = { status: "requires-functional-building-pipeline", error: error.message }; saveState(state); }
    return;
  }
  let isolatedRequest;
  try {
    const title = typeof req?.description === "string" ? titleCase(req.description) : "";
    isolatedRequest = validateArchitectRequest({ requestId, description: req?.description, title, category: req?.category });
  } catch (error) {
    log(`invalid request ${requestId} refused: ${error.message}`);
    return;
  }
  const { description, title, category } = isolatedRequest;

  if (dryRun) {
    log(`[dry-run] ${requestId} "${description}" (${category}) → would run pinned-image generation, networkless Blender, and networkless QC; then stop for reviewed import`);
    return;
  }

  log(`claiming ${requestId} "${description}" for isolated staging`);
  state[requestId] = { status: "claimed", startedAt: new Date().toISOString(), title, category };
  saveState(state);

  try {
    const model = process.env.LIMINA_ARCHITECT_MODEL || "claude-sonnet-5";
    const result = await runIsolatedArchitectJob({
      projectRoot: ROOT,
      request: isolatedRequest,
      apiKey: process.env.ANTHROPIC_API_KEY,
      model,
      onProcess(child) {
        currentChild = child;
        currentRequestId = child ? requestId : null;
      },
    });
    if (shuttingDown) return;
    const manifest = relative(ROOT, result.path);
    log(`${requestId} isolated candidate ready at ${manifest}; awaiting reviewed import`);
    state[requestId] = {
      ...state[requestId], status: "awaiting-reviewed-import", manifest,
      manifestSha256: result.sha256, artifactSha256: result.manifest.artifact.sha256,
      image: result.manifest.image, model,
    };
    saveState(state);
  } catch (error) {
    if (shuttingDown) return;
    log(`isolated authoring failed for ${requestId}: ${error.message}`);
    state[requestId] = { ...state[requestId], status: "failed", error: error.message };
    saveState(state);
  }
}

// ---- main loop -----------------------------------------------------------------------------
async function main() {
  log(`starting (interval=${intervalS}s dry-run=${dryRun} once=${once})`);
  while (!shuttingDown) {
    let requests = null;
    try {
      requests = await fetchRequests();
    } catch (e) {
      log(`poll failed: ${e.message} — retrying in ${backoffMs}ms`);
      await sleepInterruptible(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
    if (requests) {
      const state = dryRun ? {} : loadState();
      log(`poll: ${requests.length} request(s) on record`);
      for (const req of requests) {
        if (shuttingDown) break;
        await handleRequest(req, state);
      }
    }
    if (once) break;
    if (!shuttingDown) await sleepInterruptible(intervalS * 1000);
  }
  log("stopped");
}

main().catch((e) => { console.error(`[architect-daemon] fatal: ${e.stack || e.message}`); process.exit(1); });
