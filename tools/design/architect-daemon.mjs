// architect-daemon.mjs — ARCHITECT DAEMON v0 (editor Slice 6): the request-watcher that makes the
// ＋New asset loop autonomous. Polls asset.requests (the editor's +New queue, recorded by
// js/src/skills/asset-catalog.ts's asset.request skill), claims new/failed requests, spawns a
// `claude -p` authoring agent (Blender bpy, offline) to bake the GLB, and on success hands off to
// the existing mechanical pipeline (tools/design/architect-run.mjs: sanity → card → QC render →
// propose). Nothing here authors geometry itself — that stays agent work, per
// [[agent-authors-buildings-not-engine]] — this script only watches, claims, spawns, and pipes the
// result through the gate that already exists.
//
// Usage: node tools/design/architect-daemon.mjs [--interval 30] [--dry-run] [--once]
//   --interval <seconds>  poll period (default 30)
//   --dry-run             log what WOULD be claimed/spawned; never mutates state or spawns
//   --once                run a single poll cycle (claim + process whatever it finds), then exit
//
// State: .limina/architect-daemon.json — requestId -> {status, startedAt, slug, title, category,
// glb?, error?}. status one of claimed|authored|proposed|failed. Only requestIds ABSENT from the
// state file or whose last status is "failed" are (re-)claimed — claimed/authored/proposed ids are
// left alone (no re-claim, no double-spend on an in-flight or already-shipped request).
//
// Concurrency: ONE authoring child at a time (this process awaits each request's full
// author→sanity→pipeline sequence before starting the next) — see the "no concurrent authoring"
// limitation in the task report; this is a v0, not a fleet scheduler.
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, createWriteStream } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { glbBbox, classifyBounds } from "../qc/asset-sanity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FALLBACK_TOKEN = "i9y0smdFEIRUFggqryEkpO8jw5P6nLlY";
const TOKEN = process.env.LIMINA_EDITOR_TOKEN || FALLBACK_TOKEN;
const WS_URL = "ws://localhost:8787/";

const STATE_PATH = join(ROOT, ".limina", "architect-daemon.json");
const LOG_DIR = join(ROOT, ".limina", "architect-logs");
const MIN_GLB_BYTES = 100 * 1024;
const AUTHOR_TIMEOUT_MS = 45 * 60 * 1000; // 45 min
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
// Slug = kebab-case of the first ~4 words of the description (assets/<slug>.glb, tools/blender/<slug>.py).
function slugify(description) {
  const words = description.trim().toLowerCase().split(/\s+/).slice(0, 4);
  return words.join(" ").replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-") || "asset";
}
// Title = the whole description, title-cased, for the catalog entry / architect-run.mjs arg.
function titleCase(description) {
  return description.trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ---- WS client (short-lived connection per call — polling cadence is minutes, not ms, so a fresh
// connect per poll is simpler and more robust than a long-lived socket across a 45-min authoring
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
  process.exit(0);
});

async function sleepInterruptible(ms) {
  const step = 200;
  let elapsed = 0;
  while (elapsed < ms && !shuttingDown) {
    await new Promise((r) => setTimeout(r, Math.min(step, ms - elapsed)));
    elapsed += step;
  }
}

// ---- the embedded authoring-prompt template --------------------------------------------------
// Self-contained authoring packet for `claude -p`, modeled on how well.py / tudor-cottage.py /
// veilstone-monolith.py were actually briefed: the request verbatim, the established bake pattern
// to follow, the hard engine-translation constraints those scripts' own comments discovered the
// hard way, GPU-eyes iteration, and an explicit stop condition (no commit, no pipeline, no propose
// — that is this daemon's job, next).
function buildAuthoringPrompt(req, slug, title) {
  const outPath = `assets/${slug}.glb`;
  const scriptPath = `tools/blender/${slug}.py`;
  const refLine = req.refImage ? `\nReference image to match (repo-relative): ${req.refImage}\n` : "";
  return `You are the ARCHITECT: author ONE new limina asset end-to-end, offline, in headless Blender. This is a build task, not a chat — work until the asset exists and passes your own visual check, then stop.

REQUEST (verbatim, from the editor's +New queue, requestId ${req.requestId}):
  "${req.description}"
category: ${req.category}${refLine}

WHAT TO BUILD
Author a Blender bpy script at ${scriptPath} that models "${title}" and bakes it to a single glTF binary at ${outPath}. Follow the established recipe in this repo — read tools/blender/cottage.py and tools/blender/tudor-cottage.py first: bake a small procedural material node-graph to a real IMAGE on a throwaway plane (Cycles DIFFUSE/ROUGHNESS/NORMAL passes, pack the image into the .blend), then build a tiled CONSUMPTION material that samples that baked image via cube-projected UVs at true world scale — no flat/solid colors on visible surfaces unless the brief genuinely calls for a uniform material (metal, glass, etc). If the brief calls for a glowing/hero element, read tools/blender/veilstone-monolith.py's material comments for the emissive recipe instead.

ENGINE CONSTRAINTS (glTF/three.js consumption, NOT a Cycles beauty render — the engine only ever loads the exported GLB):
  - No volumes, no particle systems, no shader/keyframe animation. Anything that "glows" must be real emissive GEOMETRY: Principled BSDF "Emission Color" + "Emission Strength" (Blender 4.0+ has these as direct Principled inputs, no separate Emission node). Strength > 1 auto-exports the KHR_materials_emissive_strength extension, which three.js reads natively.
  - The engine's ACES tone-mapping crushes any emissive color whose three channels sit close together — push ONE channel toward zero (real hue separation, not just saturation) and keep raw radiance (color * strength) under ~1.5 per channel so the curve has room to keep them apart, then push overall Emission Strength into the 3.5-6.0 range for glows to actually read (a dim glow tone-maps to nothing). See veilstone-monolith.py's MAT_RUNE_GLOW / emissive() comments for a worked example of this exact fix.
  - One exported GLB, real-world scale in meters, sitting on the ground plane (min Y ≈ 0), a reasonable game-asset poly budget (not a film render).

BUILD LOOP — iterate with your own eyes, don't guess blind:
  1. Write/refine ${scriptPath}.
  2. Bake: ~/blender-5.1.2-linux-x64/blender --background --factory-startup --python ${scriptPath} -- --out ${outPath}
     (if that path doesn't exist, check $BLENDER_BIN or \`which blender\` — see CLAUDE.md's Blender authoring section).
  3. Look at it for real: write a small QC scene spec (terrain + asset.place + a camera framed to the asset's bounds — copy the pattern from any tools/preview/*-qc.json) and render it on the real GPU:
     node tools/preview/engine-authored.mjs /tmp/${slug}-check.png /tools/preview/<your-spec>.json
     then read the PNG. Judge it against the request like a person would — silhouette, proportions, texture, glow readability if applicable — and iterate the script until it looks right.
  4. Run node tools/qc/asset-sanity.mjs to confirm ${outPath} has no DEGENERATE/OVERSIZE flags.

WHEN DONE
  Stop as soon as ${outPath} exists, passes asset-sanity, and looks right in your GPU render. Do NOT run tools/design/architect-run.mjs and do NOT call catalog.publish/asset.place against the live editor — a separate pipeline stage handles QC-carding and proposing this asset into the catalog after you finish. Do NOT run \`git commit\` or stage any files — leave the working tree as-is for review. If you get genuinely stuck, stop and explain what's blocking you rather than shipping a broken bake.`;
}

// ---- authoring model tier (provenance for catalog.publish's authoredBy) -----------------------
function detectAuthoringModel() {
  try {
    const r = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 10_000 });
    const out = (r.stdout || "").trim();
    if (r.status === 0 && out) return out;
  } catch { /* fall through */ }
  return "claude-agent";
}

// ---- spawn the authoring agent, await completion (or timeout/crash) --------------------------
function runAuthoringAgent(req, slug, title, logPath) {
  return new Promise((resolvePromise) => {
    const prompt = buildAuthoringPrompt(req, slug, title);
    mkdirSync(dirname(logPath), { recursive: true });
    const out = createWriteStream(logPath, { flags: "a" });
    out.write(`--- architect-daemon: authoring ${req.requestId} (${slug}) at ${new Date().toISOString()} ---\n`);
    // NEVER pass --model — authoring runs on the strongest (inherited) model, per
    // [[asset-authoring-model-tier]].
    // Permissions: the architect MUST execute binaries (headless Blender bake, node QC render/sanity)
    // — acceptEdits alone starved the very loop that makes authoring real (the first live run wrote
    // a full bridge script, then died at the bake step on "requires approval"). The user-facing
    // safety boundary is NOT this flag: every proposal lands HELD under builder.review and nothing
    // enters the catalog or world without explicit approval in the editor queue.
    let child;
    try {
      child = spawn("claude", ["-p", prompt, "--dangerously-skip-permissions"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      out.write(`spawn failed: ${e.message}\n`); out.end();
      resolvePromise({ ok: false, reason: `spawn failed: ${e.message}` });
      return;
    }
    currentChild = child;
    currentRequestId = req.requestId;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      out.write(`--- TIMEOUT after ${AUTHOR_TIMEOUT_MS}ms — killing child ---\n`);
      try { child.kill("SIGTERM"); } catch { /* noop */ }
    }, AUTHOR_TIMEOUT_MS);
    child.stdout.on("data", (d) => out.write(d));
    child.stderr.on("data", (d) => out.write(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      out.write(`--- child error: ${e.message} ---\n`); out.end();
      currentChild = null; currentRequestId = null;
      resolvePromise({ ok: false, reason: `child error: ${e.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      out.write(`--- exited code=${code} signal=${signal} timedOut=${timedOut} ---\n`); out.end();
      currentChild = null; currentRequestId = null;
      if (timedOut) { resolvePromise({ ok: false, reason: "authoring timed out (45min)" }); return; }
      if (code !== 0) { resolvePromise({ ok: false, reason: `authoring agent exited ${code}${signal ? ` (signal ${signal})` : ""}` }); return; }
      resolvePromise({ ok: true });
    });
  });
}

// ---- post-authoring gate: GLB exists, big enough, sanity-clean --------------------------------
function checkAuthoredGlb(slug) {
  const glbPath = join(ROOT, "assets", `${slug}.glb`);
  if (!existsSync(glbPath)) return { ok: false, reason: `no assets/${slug}.glb produced` };
  const size = statSync(glbPath).size;
  if (size < MIN_GLB_BYTES) return { ok: false, reason: `assets/${slug}.glb is only ${size} bytes (<${MIN_GLB_BYTES})` };
  let bb;
  try { bb = glbBbox(readFileSync(glbPath)); } catch (e) { return { ok: false, reason: `GLB parse error: ${String(e).slice(0, 120)}` }; }
  if (bb === null) return { ok: false, reason: "NO-BOUNDS — no POSITION min/max in the GLB" };
  const d = bb.mx.map((v, i) => v - bb.mn[i]);
  const flags = classifyBounds(d, bb.mn).filter((f) => f.startsWith("DEGENERATE") || f.startsWith("OVERSIZE"));
  if (flags.length > 0) return { ok: false, reason: `${flags.join(" ")} — broken bake` };
  return { ok: true, size };
}

// ---- run the existing mechanical pipeline (sanity/card/render/propose) ------------------------
function runArchitectPipeline(slug, title, category, authoredBy) {
  const args = [join(ROOT, "tools/design/architect-run.mjs"), `${slug}.glb`, title, category, "--authored-by", authoredBy];
  const res = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit", timeout: 5 * 60_000 });
  return res.status === 0;
}

// ---- per-request handling -----------------------------------------------------------------
async function handleRequest(req, state) {
  // Re-read the state FILE before deciding: state is loaded once per poll, and an authoring run can
  // hold a poll open for ~45min — a user cancelling a queued request (status: "cancelled" written
  // externally) must take effect mid-poll, not be clobbered by this cycle's stale in-memory copy.
  if (!dryRun) Object.assign(state, loadState());
  const existing = state[req.requestId];
  if (existing && existing.status !== "failed") {
    return; // claimed/authored/proposed/cancelled — never (re-)claim
  }
  const slug = slugify(req.description);
  const title = titleCase(req.description);
  const glbPath = join(ROOT, "assets", `${slug}.glb`);

  if (dryRun) {
    if (existsSync(glbPath)) {
      log(`[dry-run] ${req.requestId} "${req.description}" → assets/${slug}.glb already exists — would treat as already-authored`);
    } else {
      log(`[dry-run] ${req.requestId} "${req.description}" (${req.category}) → would claim, spawn authoring agent for assets/${slug}.glb`);
    }
    return;
  }

  log(`claiming ${req.requestId} "${req.description}" → slug=${slug}`);
  state[req.requestId] = { status: "claimed", startedAt: new Date().toISOString(), slug, title, category: req.category };
  saveState(state);

  const logPath = join(LOG_DIR, `${req.requestId}.log`);
  const authorResult = await runAuthoringAgent(req, slug, title, logPath);
  if (shuttingDown) return; // SIGINT handler already persisted a "failed/interrupted" state
  if (!authorResult.ok) {
    log(`authoring failed for ${req.requestId}: ${authorResult.reason}`);
    state[req.requestId] = { ...state[req.requestId], status: "failed", error: authorResult.reason };
    saveState(state);
    return;
  }

  const glbCheck = checkAuthoredGlb(slug);
  if (!glbCheck.ok) {
    log(`authored GLB failed the post-authoring gate for ${req.requestId}: ${glbCheck.reason}`);
    state[req.requestId] = { ...state[req.requestId], status: "failed", error: glbCheck.reason };
    saveState(state);
    return;
  }
  log(`authoring succeeded for ${req.requestId} — assets/${slug}.glb (${glbCheck.size} bytes)`);
  state[req.requestId] = { ...state[req.requestId], status: "authored", glb: `${slug}.glb` };
  saveState(state);

  const authoredBy = detectAuthoringModel();
  log(`running architect-run.mjs for ${slug}.glb (authoredBy=${authoredBy})`);
  const pipelineOk = runArchitectPipeline(slug, title, req.category, authoredBy);
  if (!pipelineOk) {
    log(`architect-run.mjs pipeline failed for ${req.requestId}`);
    state[req.requestId] = { ...state[req.requestId], status: "failed", error: "architect-run.mjs pipeline failed" };
    saveState(state);
    return;
  }
  log(`${req.requestId} proposed — awaiting approval in the editor queue`);
  state[req.requestId] = { ...state[req.requestId], status: "proposed" };
  saveState(state);
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
