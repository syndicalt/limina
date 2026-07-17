#!/usr/bin/env node
// serve-design.mjs — the Design Space frontend server. Serves the design home-base SPA
// and, on each /api/state request, reads the vault fresh and runs it through the engine
// translator (so the UI reflects live doc edits): the documents, the generated mind-map
// graph, and the doc<->build links.
//
//   node tools/design/serve-design.mjs <vault-dir> [port]

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, basename, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { buildPeekScene } from "./peek-scene.mjs";
import { summarizePeekFailure } from "./peek-failure.mjs";
import { editorLaunchConfigFromEnvironment } from "./editor-launch.mjs";
import { listPacks, importPack } from "./pack-import.mjs";
import { connect as netConnect } from "node:net";
import { loadProjectConfig, resolveProjectPath } from "../project-config.mjs";
import { AtlasMapDocBridge, AtlasSourceBridgeError } from "./atlas-source-bridge.mjs";
import {
  EditorBridgeClient,
  assertLoopbackEditorUrl,
  editorClientConfigFromEnvironment,
} from "../bridge/editor-client.mjs";

// 3D-peek render jobs (Painter P5): bounded in-memory status retained for recent jobs.
const peekJobs = new Map();
import { createServer } from "node:http";
import { migrateMapDoc } from "./map-doc.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIMINA_HOME = resolve(__dirname, "..", "..");
const LIMINA_BIN = process.env.LIMINA_BIN || join(LIMINA_HOME, "target", "release", "limina");
// Content-pack library source. Imported packs and compiled maps are project-local.
const PACKS_DIR = process.env.LIMINA_PACKS_DIR || join(LIMINA_HOME, "packs");
// The frontend is served from disk PER REQUEST (no boot cache — caching index.html at startup
// meant every frontend edit needed a server restart, a repeated debugging trap).
const FRONTEND_DIR = join(__dirname, "frontend");
const SHARED_MODULES = {
  "/shared/marching-squares.mjs": join(LIMINA_HOME, "js/src/world/pipeline/marching-squares.mjs"),
  "/shared/raster-codec.mjs": join(LIMINA_HOME, "js/src/world/pipeline/raster-codec.mjs"),
  // Atlas WB-W1 authoring imports the exact engine validators. Explicit allow-list only:
  // no generic js/src mount and therefore no path traversal or accidental internal exposure.
  "/js/src/world/water-ir.mjs": join(LIMINA_HOME, "js/src/world/water-ir.mjs"),
  "/js/src/world/hydrology-ir.mjs": join(LIMINA_HOME, "js/src/world/hydrology-ir.mjs"),
};
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

const REQUESTED_VAULT_DIR = resolve(process.argv[2] || process.cwd());
const REQUESTED_PROJECT_ROOT = basename(REQUESTED_VAULT_DIR) === "design" ? dirname(REQUESTED_VAULT_DIR) : REQUESTED_VAULT_DIR;
const PROJECT_CONFIG = loadProjectConfig(REQUESTED_PROJECT_ROOT);
const PROJECT_ROOT = PROJECT_CONFIG.projectRoot;
const PROJECT_ID = PROJECT_CONFIG.projectId;
const vaultDir = resolveProjectPath(PROJECT_ROOT, REQUESTED_VAULT_DIR, "design vault");
const CONFIGURED_ASSET_ROOT = PROJECT_CONFIG.assetRoot ?? "assets";
function ensureProjectDirectory(path, label) {
  const candidate = resolve(path);
  const relativePath = relative(PROJECT_ROOT, candidate);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${label} must be a child of the canonical project root`);
  }
  let current = PROJECT_ROOT;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    try { mkdirSync(current, { mode: 0o755 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} contains a non-directory or symlink: ${current}`);
    const real = realpathSync(current);
    const realRelative = relative(PROJECT_ROOT, real);
    if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
      throw new Error(`${label} escapes the canonical project root through ${current}`);
    }
    current = real;
  }
  return current;
}
const ASSET_ROOT_REQUEST = process.env.LIMINA_ASSETS_ROOT || join(PROJECT_ROOT, CONFIGURED_ASSET_ROOT);
ensureProjectDirectory(ASSET_ROOT_REQUEST, "asset root");
const ASSETS_DIR = resolveProjectPath(
  PROJECT_ROOT,
  ASSET_ROOT_REQUEST,
  "asset root",
);
const port = Number(process.argv[3]) || 4321;
const HOST = "127.0.0.1";
const DESIGN_SESSION_TOKEN = randomBytes(32).toString("hex");
const EDITOR_LAUNCH_CONFIG = editorLaunchConfigFromEnvironment(process.env);
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const MAX_PEEK_JOBS = 256;
const MAX_CONCURRENT_PEEKS = 2;
const PEEK_JOB_TTL_MS = 30 * 60 * 1000;
const PEEK_TIMEOUT_MS = 2 * 60 * 1000;

let atlasAuthoringClient;
try {
  const config = editorClientConfigFromEnvironment(process.env, {
    agentId: "atlas-design-space",
    sessionId: `atlas-${randomBytes(16).toString("hex")}`,
    profile: "builder.readWrite",
  });
  assertLoopbackEditorUrl(config.url);
  atlasAuthoringClient = new EditorBridgeClient(config);
} catch (error) {
  const configurationError = error;
  atlasAuthoringClient = {
    callTool() { return Promise.reject(configurationError); },
    close() {},
  };
  console.warn(`[atlas] authoritative saves disabled until editor connection is configured: ${error.message}`);
}
const atlasMapDocBridge = new AtlasMapDocBridge({
  projectConfig: PROJECT_CONFIG,
  vaultDir,
  assetRoot: ASSETS_DIR,
  authoringClient: atlasAuthoringClient,
});

function writeWorldMap(worldMap) {
  const relativePath = join("maps", worldMap.id, `${worldMap.provenance.contentHash}.worldmap.json`);
  const output = join(ASSETS_DIR, relativePath);
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, JSON.stringify(worldMap, null, 2) + "\n", "utf8");
    renameSync(temporary, output);
  } finally {
    rmSync(temporary, { force: true });
  }
  return relativePath.replaceAll("\\", "/");
}

function listWorldMaps(dir = join(ASSETS_DIR, "maps"), root = dir, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) listWorldMaps(path, root, found);
    else if (entry.name.endsWith(".worldmap.json")) found.push(path.slice(root.length + 1).replaceAll("\\", "/"));
  }
  return found.sort();
}

function prunePeekJobs(now = Date.now()) {
  for (const [id, job] of peekJobs) {
    if (job.status !== "running" && now - job.createdAt > PEEK_JOB_TTL_MS) peekJobs.delete(id);
  }
  while (peekJobs.size >= MAX_PEEK_JOBS) {
    const oldestFinished = [...peekJobs].find(([, job]) => job.status !== "running");
    if (oldestFinished === undefined) break;
    peekJobs.delete(oldestFinished[0]);
  }
}

// The 3D peek renders through the PREBUILT browser bundle editor/vendor/limina-runtime.js. When a
// js/src schema (e.g. the WorldMap IR) changes but the bundle isn't rebuilt, the stale bundle rejects
// the newer compiled map and terrain.create fails — the peek renders only ocean (a real bug that cost
// hours). Self-heal: before every peek, rebuild the bundle if any js/src file is newer than it. Cheap
// (esbuild ~100ms) and idempotent; if the rebuild fails we log and render anyway (fail-loud downstream
// in engine-shots then surfaces the real error instead of a silent blank).
const EDITOR_BUNDLE = join(LIMINA_HOME, "editor", "vendor", "limina-runtime.js");
function newestMtimeUnder(dir) {
  let newest = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mjs|js)$/.test(e.name)) { const m = statSync(p).mtimeMs; if (m > newest) newest = m; }
    }
  };
  try { walk(dir); } catch { /* best-effort */ }
  return newest;
}
function ensureFreshEditorBundle() {
  const bundleMtime = existsSync(EDITOR_BUNDLE) ? statSync(EDITOR_BUNDLE).mtimeMs : 0;
  const srcMtime = newestMtimeUnder(join(LIMINA_HOME, "js", "src"));
  if (srcMtime <= bundleMtime) return;
  console.error("[peek] editor bundle is stale (js/src is newer) — rebuilding via bundle:editor…");
  const r = spawnSync("npm", ["--prefix", join(LIMINA_HOME, "js"), "run", "bundle:editor"], { encoding: "utf8" });
  if (r.status !== 0) console.error("[peek] bundle:editor FAILED: " + String(r.stderr || r.stdout || "").slice(-400));
  else console.error("[peek] editor bundle rebuilt.");
}

// The expert agents talk through the model. Key from the environment or the project .env.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
function loadProjectEnv() {
  try {
    const txt = readFileSync(join(vaultDir, "..", ".env"), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no project .env */ }
}
loadProjectEnv();

function readDocs() {
  return readdirSync(vaultDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ name: f, content: readFileSync(join(vaultDir, f), "utf8") }));
}

const BEGIN = "===STATE_BEGIN===", END = "===STATE_END===";
function computeState() {
  const docs = readDocs();
  const harness = `
import { vaultToStore, vaultGraph, parseFrontmatter, parsePlaces } from "${LIMINA_HOME}/js/src/game/design-vault.ts";
import { compileDesignToGds } from "${LIMINA_HOME}/js/src/game/design-compile.ts";
import { ops } from "${LIMINA_HOME}/js/src/engine.ts";
const docs = ${JSON.stringify(docs)};
let graph = { nodes: [], edges: [] }, build = { ok: false, placements: [], links: [], issues: [] };
try { graph = vaultGraph(docs); } catch (e) { graph = { nodes: [], edges: [], error: String(e) }; }
try {
  const { store, links } = vaultToStore(docs);
  const { gds, issues } = compileDesignToGds(store);
  const placements = (gds && gds.world && gds.world.placements) ? gds.world.placements : [];
  const has = (id) => placements.some((p) => p.id === id);
  const entIds = new Set((gds ? gds.entities : []).map((e) => e.id));
  const resolved = links.map((l) => {
    const loc = "location-" + l.entity, ent = "entity-" + l.entity;
    return { ...l, buildId: has(loc) ? loc : has(ent) ? ent : entIds.has(l.entity) ? l.entity : null };
  });
  build = { ok: !!gds, issues, placements: placements.map((p) => ({ id: p.id, position: p.transform.position })), links: resolved };
} catch (e) { build = { ok: false, placements: [], links: [], issues: [String(e)] }; }
var world = { regions: [], locations: [] };
try {
  const wbDoc = docs.find((d) => /kind:\\s*world-bible/.test(d.content));
  if (wbDoc) {
    const fm = parseFrontmatter(wbDoc.content);
    world.regions = (fm.regions || []).map((r) => ({ id: r.id, name: r.name, biome: r.biome }));
    world.locations = (fm.locations || []).map((l) => ({
      id: l.id, name: l.name, kind: l.kind, region: l.region, regionId: l.regionId,
      x: (l.position||[0,0])[0], z: (l.position||[0,0])[1], tags: l.tags || [],
      map: l.map || "", mapLink: l.mapLink || "", count: l.count, radiusM: l.radiusM,
      assetId: l.assetId, note: l.note || l.description,
    }));
  }
} catch (e) { world = { regions: [], locations: [] }; }
var places = [];
try {
  const plDoc = docs.find((d) => /kind:\\s*places/.test(d.content));
  if (plDoc) places = parsePlaces(parseFrontmatter(plDoc.content));
} catch (e) { places = []; }
ops.op_log("${BEGIN}" + JSON.stringify({ graph, build, world, places }) + "${END}");
`;
  const tmp = mkdtempSync(join(tmpdir(), "limina-design-"));
  const hp = join(tmp, "h.ts");
  writeFileSync(hp, harness);
  const res = spawnSync(LIMINA_BIN, [hp], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  rmSync(tmp, { recursive: true, force: true });
  const out = (res.stdout || "") + (res.stderr || "");
  const m = out.match(new RegExp(BEGIN + "([\\s\\S]*?)" + END));
  const extra = m ? JSON.parse(m[1]) : { graph: { nodes: [], edges: [] }, build: { ok: false, error: out.slice(-400) }, places: [] };
  return { project: PROJECT_ID, docs, ...loadMaps(PROJECT_ID), ...extra };
}

// Multiple hierarchical maps (world -> region -> city) + a cartographic feature layer (glyphs,
// rivers/roads, areas, outline) per map. The map owns maps.json (wholesale save, debounced on the
// client). Markers stay world-bible locations (buildable + cascade); features are pure cartography.
// The doc shape + migration-on-read (v1 -> v2, scale-contract units) is owned by map-doc.mjs —
// the mapstudio gate imports the same module, so server and gate can't drift apart.
function loadMaps(project) {
  let data;
  try { data = JSON.parse(readFileSync(join(vaultDir, "maps.json"), "utf8")); } catch { data = null; }
  const { doc, repairedIds } = migrateMapDoc(data, project);
  if (repairedIds > 0) console.warn(`maps.json: repaired ${repairedIds} colliding feature id(s) on read`);
  return { maps: doc.maps, activeMapId: doc.activeMapId, mapsRev: mapsRev() };
}
// Opaque revision token for maps.json — a hash of the current file bytes. Every /api/state
// response carries it and every save must echo it back (compare-and-set below).
function mapsRev() {
  try { return createHash("sha1").update(readFileSync(join(vaultDir, "maps.json"))).digest("hex").slice(0, 16); }
  catch { return "0"; }
}
function saveMaps(maps, activeMapId, baseRev) {
  return atlasMapDocBridge.save({ maps, activeMapId, baseRev });
}

// Create a new vault document (a readable, linkable markdown note).
function createDoc(title, kind) {
  const base = String(title || "note").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "note";
  const name = base + ".md";
  const fp = join(vaultDir, name);
  if (existsSync(fp)) throw new Error(`a document "${name}" already exists`);
  const k = String(kind || "note");
  const t = String(title || base);
  writeFileSync(fp, `---\nkind: ${k}\ntitle: ${t}\n---\n\n# ${t}\n\nWrite here. Link with [[other-doc]].\n`);
  return { created: true, name };
}
function deleteDoc(name) {
  const safe = basename(String(name));
  if (!safe.endsWith(".md")) throw new Error("invalid document name");
  const fp = join(vaultDir, safe);
  if (!existsSync(fp)) throw new Error("document not found");
  unlinkSync(fp);
  return { deleted: true, name: safe };
}

// Assemble the FULL role context for an agent (persona + documents + screen) via the engine.
const ABEGIN = "===AGENT_BEGIN===", AEND = "===AGENT_END===";
function assembleContext(agentId, screen) {
  const docs = readDocs();
  const harness = `
import { vaultToStore } from "${LIMINA_HOME}/js/src/game/design-vault.ts";
import { assembleAgentContext } from "${LIMINA_HOME}/js/src/game/design-agents.ts";
import { ops } from "${LIMINA_HOME}/js/src/engine.ts";
const docs = ${JSON.stringify(docs)};
const { store } = vaultToStore(docs);
const ctx = assembleAgentContext(${JSON.stringify(String(agentId))}, store, ${JSON.stringify(screen || {})});
ops.op_log("${ABEGIN}" + JSON.stringify({ role: ctx.role, title: ctx.title, systemPrompt: ctx.systemPrompt }) + "${AEND}");
`;
  const tmp = mkdtempSync(join(tmpdir(), "limina-agent-"));
  const hp = join(tmp, "a.ts");
  writeFileSync(hp, harness);
  const res = spawnSync(LIMINA_BIN, [hp], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  rmSync(tmp, { recursive: true, force: true });
  const out = (res.stdout || "") + (res.stderr || "");
  const m = out.match(new RegExp(ABEGIN + "([\\s\\S]*?)" + AEND));
  if (!m) throw new Error("context assembly failed: " + out.slice(-400));
  return JSON.parse(m[1]);
}

async function callModel(system, history, message) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { ok: false, reply:
      "This expert is driven by YOUR coding-agent session (Claude Code / Codex) through the limina-design " +
      "MCP bridge — no API key needed. Register tools/design/design-bridge.mjs (with LIMINA_DESIGN_VAULT set " +
      "to this project's design/ folder) and ask your session to speak as this expert; it pulls this exact " +
      "role context via design_context and can read/edit the docs + surface cascades. " +
      "(Optional: set ANTHROPIC_API_KEY in the project .env to also get a built-in reply in this box.)" };
  }
  const messages = [...(history || []).map((h) => ({ role: h.role, content: h.content })), { role: "user", content: message }];
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, messages }),
    });
    if (!r.ok) return { ok: false, reply: `⚠ model error ${r.status}: ${(await r.text()).slice(0, 300)}` };
    const j = await r.json();
    return { ok: true, reply: (j.content || []).map((c) => c.text || "").join("").trim() || "(no reply)" };
  } catch (e) { return { ok: false, reply: "⚠ request failed: " + String(e) }; }
}

// Save an edited doc, then compute the cascade impact of what changed (save -> surface).
const SBEGIN = "===SAVE_BEGIN===", SEND = "===SAVE_END===";
function saveDoc(name, content) {
  const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safe.endsWith(".md") || safe.includes("..")) throw new Error("invalid doc name");
  const fp = join(vaultDir, safe);
  let old = "";
  try { old = readFileSync(fp, "utf8"); } catch { /* new file */ }
  writeFileSync(fp, content);
  const docs = readDocs();
  const harness = `
import { diffDocEntities } from "${LIMINA_HOME}/js/src/game/design-vault.ts";
import { computeImpact } from "${LIMINA_HOME}/js/src/game/design-cascade.ts";
import { ops } from "${LIMINA_HOME}/js/src/engine.ts";
const docs = ${JSON.stringify(docs)};
const changes = diffDocEntities(${JSON.stringify(old)}, ${JSON.stringify(content)});
const impacts = changes.map((ch) => computeImpact(docs, ch)).filter((i) => i.affected.length > 0 || i.downstreamArtifacts.length > 0);
ops.op_log("${SBEGIN}" + JSON.stringify({ changes, impacts }) + "${SEND}");
`;
  const tmp = mkdtempSync(join(tmpdir(), "limina-save-"));
  const hp = join(tmp, "s.ts");
  writeFileSync(hp, harness);
  const r = spawnSync(LIMINA_BIN, [hp], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  rmSync(tmp, { recursive: true, force: true });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = out.match(new RegExp(SBEGIN + "([\\s\\S]*?)" + SEND));
  return { saved: true, ...(m ? JSON.parse(m[1]) : { changes: [], impacts: [] }) };
}

// Structured location authoring: add / update / delete / move a marker in the world-bible
// via a real parse -> modify -> serialize (not regex), then save -> cascade.
const ELB = "===EL_BEGIN===", ELE = "===EL_END===";
function editLocation(op, a) {
  const doc = readDocs().find((d) => /kind:\s*world-bible/.test(d.content));
  if (!doc) throw new Error("no world-bible document");
  const src = `
import { parseFrontmatter, replaceFrontmatter } from "${LIMINA_HOME}/js/src/game/design-vault.ts";
import { ops } from "${LIMINA_HOME}/js/src/engine.ts";
const content = ${JSON.stringify(doc.content)};
const fm = parseFrontmatter(content);
let locs = Array.isArray(fm.locations) ? fm.locations : [];
const op = ${JSON.stringify(op)}, a = ${JSON.stringify(a)};
const defRegion = (fm.regions && fm.regions[0] && fm.regions[0].id) || "";
if (op === "add") locs.push({ id: a.id, name: a.name, kind: a.kind || "landmark", region: a.region || defRegion, position: [Math.round(a.x), Math.round(a.z)], ...(a.tags && a.tags.length ? { tags: a.tags } : {}), ...(a.map ? { map: a.map } : {}), ...(a.mapLink ? { mapLink: a.mapLink } : {}), note: a.note || a.name });
else if (op === "update") locs = locs.map((l) => l.id === a.id ? { ...l, ...(a.name !== undefined ? { name: a.name } : {}), ...(a.kind !== undefined ? { kind: a.kind } : {}), ...(a.region !== undefined ? { region: a.region } : {}), ...(a.note !== undefined ? { note: a.note } : {}), ...(a.tags !== undefined ? (a.tags.length ? { tags: a.tags } : { tags: undefined }) : {}), ...(a.map !== undefined ? (a.map ? { map: a.map } : { map: undefined }) : {}), ...(a.mapLink !== undefined ? (a.mapLink ? { mapLink: a.mapLink } : { mapLink: undefined }) : {}) } : l);
else if (op === "delete") locs = locs.filter((l) => l.id !== a.id);
else if (op === "move") locs = locs.map((l) => l.id === a.id ? { ...l, position: [Math.round(a.x), Math.round(a.z)] } : l);
else if (op === "unlink") { const ids = new Set(a.ids || []); locs = locs.map((l) => ids.has(l.id) ? { ...l, map: "__off__", mapLink: undefined } : l); }
fm.locations = locs;
ops.op_log("${ELB}" + JSON.stringify({ content: replaceFrontmatter(content, fm) }) + "${ELE}");
`;
  const tmp = mkdtempSync(join(tmpdir(), "limina-el-"));
  const hp = join(tmp, "e.ts");
  writeFileSync(hp, src);
  const r = spawnSync(LIMINA_BIN, [hp], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  rmSync(tmp, { recursive: true, force: true });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = out.match(new RegExp(ELB + "([\\s\\S]*?)" + ELE));
  if (!m) throw new Error("edit failed: " + out.slice(-300));
  // "unlink" is a cartography op: remove the markers from the map without cascading.
  if (op === "unlink") { writeFileSync(join(vaultDir, doc.name), JSON.parse(m[1]).content); return { saved: true, unlinked: (a.ids || []).length, impacts: [] }; }
  return saveDoc(doc.name, JSON.parse(m[1]).content);
}

// Move a location on the map: rewrite just its position in the world-bible, then cascade.
function moveLocation(id, x, z) {
  const doc = readDocs().find((d) => /kind:\s*world-bible/.test(d.content));
  if (!doc) throw new Error("no world-bible document");
  const esc = String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(- id:\\s*" + esc + "\\b[\\s\\S]*?position:\\s*\\[)[^\\]]*(\\])");
  if (!re.test(doc.content)) throw new Error(`location "${id}" has no position to move`);
  const next = doc.content.replace(re, `$1${Math.round(x)}, ${Math.round(z)}$2`);
  if (next === doc.content) return { saved: false, changes: [], impacts: [] };
  return saveDoc(doc.name, next);
}

// Structured PLACE authoring (Places Stage 2): add / update / move / reparent / delete a node in
// the `kind: places` doc's `places:` array via a real parse -> modify -> serialize (not regex),
// then save -> cascade — the exact shape editLocation uses for world-bible locations. The place
// tree stays connected: reparent refuses a cycle, delete re-parents the victim's children.
const ELP_B = "===ELP_BEGIN===", ELP_E = "===ELP_END===";
// One-time convergence: MOVE world-bible locations: into places.md — Places is now the single
// named-point model. Idempotent (a location whose id is already a place is skipped); migrated
// locations are REMOVED from the world-bible (a true move, no data loss). Each becomes a place
// carrying its name/kind/position/tags/note + mapLink (nested-map zoom) + assetId (marker asset).
function migrateLocationsToPlaces() {
  // Frontmatter parsing lives in the spawned harness, not this Node process — read the already-parsed
  // locations + places from computeState() instead.
  const st = computeState();
  const locations = (st.world && st.world.locations) || [];
  const existing = new Set((st.places || []).map((p) => p.id));
  let migrated = 0;
  for (const loc of Array.isArray(locations) ? locations : []) {
    if (!loc || !loc.id || existing.has(loc.id)) continue;
    const pos = (typeof loc.x === "number" && typeof loc.z === "number") ? [Number(loc.x), Number(loc.z)]
      : (Array.isArray(loc.position) && loc.position.length >= 2 ? [Number(loc.position[0]), Number(loc.position[1])] : null);
    const place = {
      id: loc.id, name: loc.name || loc.id, kind: loc.kind || "landmark", binding: "point",
      ...(pos ? { position: pos } : {}),
      ...(loc.region || loc.regionId ? { regionId: loc.region || loc.regionId } : {}),
      ...(loc.map && loc.map !== "__off__" ? { map: loc.map } : {}), // "__off__" = unlinked; default to primary
      ...(Array.isArray(loc.tags) && loc.tags.length ? { tags: loc.tags } : {}),
      ...(loc.note || loc.description ? { note: loc.note || loc.description } : {}),
      ...(loc.mapLink ? { mapLink: loc.mapLink } : {}),
      ...(loc.assetId ? { assetId: loc.assetId } : {}),
    };
    editPlace("add", place);                // preserves the id; carries assetId/mapLink
    existing.add(loc.id);
    editLocation("delete", { id: loc.id }); // remove from world-bible — a true MOVE
    migrated++;
  }
  const places = (computeState().places) || [];
  return { ok: true, migrated, places };
}
function editPlace(op, place) {
  let doc = readDocs().find((d) => /kind:\s*places/.test(d.content));
  if (!doc) {
    if (op !== "add") throw new Error("no places document");
    createDoc("places", "places"); // first place authored → seed places.md (kind: places)
    doc = readDocs().find((d) => /kind:\s*places/.test(d.content));
    if (!doc) throw new Error("could not create a places document");
  }
  const src = `
import { parseFrontmatter, replaceFrontmatter, parsePlaces } from "${LIMINA_HOME}/js/src/game/design-vault.ts";
import { ops } from "${LIMINA_HOME}/js/src/engine.ts";
const content = ${JSON.stringify(doc.content)};
const fm = parseFrontmatter(content);
let places = Array.isArray(fm.places) ? fm.places : [];
const op = ${JSON.stringify(op)}, place = ${JSON.stringify(place)};
// A root place carries NO parentId key (a null would round-trip to a bogus "null" parent).
const withParent = (pl, pid) => { const n = { ...pl }; if (pid) n.parentId = pid; else delete n.parentId; return n; };
const has = (id) => places.some((pl) => pl.id === id);
let error = null;
if (op === "add") {
  const node = { id: place.id, name: place.name || place.id, kind: place.kind || "place" };
  if (place.parentId) node.parentId = place.parentId;
  if (Array.isArray(place.position) && place.position.length >= 2) node.position = [Number(place.position[0]), Number(place.position[1])];
  if (place.binding) node.binding = place.binding;
  if (typeof place.radiusM === "number") node.radiusM = place.radiusM;
  if (place.regionId) node.regionId = place.regionId;
  if (place.map) node.map = place.map;
  if (Array.isArray(place.tags) && place.tags.length) node.tags = place.tags;
  if (place.note) node.note = place.note;
  if (place.assetId) node.assetId = place.assetId;
  if (place.mapLink) node.mapLink = place.mapLink;
  places.push(node);
} else if (!has(place.id)) {
  error = "no such place: " + place.id;
} else if (op === "update") {
  const patch = { ...place }; delete patch.id;
  places = places.map((pl) => pl.id === place.id ? { ...pl, ...patch } : pl);
} else if (op === "move") {
  if (!Array.isArray(place.position) || place.position.length < 2) error = "move needs position [x, z]";
  else places = places.map((pl) => pl.id === place.id ? { ...pl, position: [Math.round(place.position[0]), Math.round(place.position[1])] } : pl);
} else if (op === "reparent") {
  const byId = new Map(places.map((pl) => [pl.id, pl]));
  let cur = place.parentId || null, cyc = false; const seen = new Set();
  while (cur != null) {
    if (cur === place.id) { cyc = true; break; }
    if (seen.has(cur)) break; seen.add(cur);
    const par = byId.get(cur); cur = par ? (par.parentId || null) : null;
  }
  if (cyc) error = "reparent would make " + place.id + " its own ancestor (cycle refused)";
  else places = places.map((pl) => pl.id === place.id ? withParent(pl, place.parentId || null) : pl);
} else if (op === "delete") {
  const victim = places.find((pl) => pl.id === place.id);
  const newParent = (victim && victim.parentId) || null; // children re-home to the victim's parent
  places = places.filter((pl) => pl.id !== place.id).map((pl) => pl.parentId === place.id ? withParent(pl, newParent) : pl);
} else error = "unknown op: " + op;
if (error) ops.op_log("${ELP_B}" + JSON.stringify({ error }) + "${ELP_E}");
else { fm.places = places; const nextContent = replaceFrontmatter(content, fm); ops.op_log("${ELP_B}" + JSON.stringify({ content: nextContent, places: parsePlaces(parseFrontmatter(nextContent)) }) + "${ELP_E}"); }
`;
  const tmp = mkdtempSync(join(tmpdir(), "limina-elp-"));
  const hp = join(tmp, "ep.ts");
  writeFileSync(hp, src);
  const r = spawnSync(LIMINA_BIN, [hp], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  rmSync(tmp, { recursive: true, force: true });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = out.match(new RegExp(ELP_B + "([\\s\\S]*?)" + ELP_E));
  if (!m) throw new Error("edit-place failed: " + out.slice(-300));
  const parsed = JSON.parse(m[1]);
  if (parsed.error) throw new Error(parsed.error);
  const saveRes = saveDoc(doc.name, parsed.content);
  return { ok: true, places: parsed.places, ...saveRes };
}

createServer((req, res) => {
  if (req.method === "POST" && ["/api/agent", "/api/save", "/api/move-location", "/api/edit-location", "/api/edit-place", "/api/migrate-locations-to-places", "/api/map-save", "/api/compile-map", "/api/peek", "/api/doc-create", "/api/doc-delete", "/api/pack-import"].includes(req.url)) {
    if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      res.writeHead(415, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "application/json is required" }));
      return;
    }
    const chunks = [];
    let bodyBytes = 0;
    let bodyTooLarge = false;
    req.on("data", (chunk) => {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_REQUEST_BODY_BYTES) bodyTooLarge = true;
      else chunks.push(chunk);
    });
    req.on("end", async () => {
      if (bodyTooLarge) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "request body exceeds 16 MiB" }));
        return;
      }
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        const p = JSON.parse(body || "{}");
        if (req.headers["x-limina-design-token"] !== DESIGN_SESSION_TOKEN && p?._token !== DESIGN_SESSION_TOKEN) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "invalid design session token" }));
          return;
        }
        if (req.url === "/api/save") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(saveDoc(p.name, p.content)));
          return;
        }
        if (req.url === "/api/migrate-locations-to-places") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(migrateLocationsToPlaces()));
          return;
        }
        if (req.url === "/api/move-location") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(moveLocation(p.id, p.x, p.z)));
          return;
        }
        if (req.url === "/api/peek") {
          // 3D PEEK (Painter P5): compile the active map, then render ONE real-GPU frame of the
          // resulting terrain through the EXISTING proof harness (tools/preview/engine-authored.mjs
          // — runLive + terrain.create source:"map", ANGLE GL, never swiftshader) as an async job.
          // GPU CAUTION (failure mode #14): the UI warns the user to close the 3D editor first;
          // we also report whether the editor host port is up so the client can warn harder.
          // Self-heal a stale render bundle before we compile+render (see ensureFreshEditorBundle).
          prunePeekJobs();
          const runningJobs = [...peekJobs.values()].filter((job) => job.status === "running").length;
          if (runningJobs >= MAX_CONCURRENT_PEEKS || peekJobs.size >= MAX_PEEK_JOBS) {
            res.writeHead(429, { "content-type": "application/json", "retry-after": "5" });
            res.end(JSON.stringify({ ok: false, error: "peek render capacity is full" }));
            return;
          }
          ensureFreshEditorBundle();
          const { compileDesignMap } = await import(join(LIMINA_HOME, "js/src/world/design-map-compile.mjs"));
          const mapsJsonText = readFileSync(join(vaultDir, "maps.json"), "utf8");
          const worldBibleText = readFileSync(join(vaultDir, "world-bible.md"), "utf8");
          const project = PROJECT_ID;
          // Places (Stage 4): the compiled peek carries the gazetteer + place-marker anchors, so the
          // author sees placed places in the render (and NPC nav has its index). Absent doc = undefined.
          const placesTextPeek = readDocs().find((d) => /kind:\s*places/.test(d.content))?.content;
          const { worldMap } = compileDesignMap({ mapsJsonText, worldBibleText, mapId: p.mapId, placesText: placesTextPeek });
          const mapAssetId = writeWorldMap(worldMap);
          // Scene assembly lives in peek-scene.mjs (pure, gate-proven) — everything the
          // author painted, including stamped asset-anchors, must appear in the peek.
          // An optional `camera` of shape { mode:'vantage', pos:[x,z], yaw, eyeHeight } swaps the
          // overview turntable for a positioned camera looking FROM a point on the map (Places
          // Stage 2). Default (no camera / non-vantage mode) = the overview turntable.
          const vantage = (p.camera && p.camera.mode === "vantage") ? p.camera : undefined;
          const { scene, sceneName, clampedToTileCap } = buildPeekScene(worldMap, { project, mapAssetId, vantage });
          const outDir = join(LIMINA_HOME, "tools", "preview", "out");
          mkdirSync(outDir, { recursive: true });
          writeFileSync(join(outDir, sceneName + ".json"), JSON.stringify(scene, null, 2));
          const jobId = "pk" + randomBytes(12).toString("hex");
          // 18 yaw frames at exact 20° steps (engine-shots' __setYaw mode — cheap per frame, and
          // the loop always closes). The Atlas lightbox scrubs them as a turntable. A vantage is a
          // single fixed-pose shot — one frame, no turntable.
          const FRAMES = vantage ? 1 : 8;
          const child = spawn("node", [join(LIMINA_HOME, "tools/preview/engine-shots.mjs"), String(FRAMES), "400", "/tools/preview/out/" + sceneName + ".json", sceneName], {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, LIMINA_PREVIEW_ASSETS_DIR: ASSETS_DIR },
          });
          let diagnosticTail = "";
          let timedOut = false;
          const killTimer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, PEEK_TIMEOUT_MS);
          killTimer.unref();
          const captureDiagnostic = (chunk) => { diagnosticTail = (diagnosticTail + chunk).slice(-8 * 1024); };
          child.stderr.on("data", captureDiagnostic);
          child.stdout.on("data", captureDiagnostic);
          child.on("exit", (code) => {
            clearTimeout(killTimer);
            const frames = [];
            for (let i = 1; i <= FRAMES; i++) if (existsSync(join(outDir, `${sceneName}-${i}.png`))) frames.push(`${sceneName}-${i}.png`);
            const createdAt = Date.now();
            if (timedOut || code !== 0 || frames.length === 0) {
              console.error(`[peek:${jobId}] renderer failed${timedOut ? " (timeout)" : ` (exit ${code})`}:\n${diagnosticTail}`);
            }
            peekJobs.set(jobId, !timedOut && code === 0 && frames.length > 0
              ? { status: "done", png: frames[0], frames, createdAt }
              : { status: "error", error: summarizePeekFailure({ timedOut, code, output: diagnosticTail }), createdAt });
          });
          peekJobs.set(jobId, { status: "running", createdAt: Date.now() });
          const editorHostUp = await new Promise((resolveUp) => {
            const s = netConnect({ port: 8787, host: "127.0.0.1" }, () => { s.destroy(); resolveUp(true); });
            s.on("error", () => resolveUp(false));
            s.setTimeout(400, () => { s.destroy(); resolveUp(false); });
          });
          res.writeHead(200, { "content-type": "application/json" });
          // clampedToTileCap: the painted world is larger than the single-tile peek can show
          // at full size (>~6.5km span). It still renders (coarser); the client warns that the
          // full-fidelity view is the streamed build, not the peek.
          res.end(JSON.stringify({ job: jobId, editorHostUp, clampedToTileCap }));
          return;
        }
        if (req.url === "/api/compile-map") {
          // Compile the ACTIVE Atlas map (vault maps.json + world-bible) into a world asset the
          // build consumes and the import list shows — the same pure compiler the gates run.
          const { compileDesignMap } = await import(join(LIMINA_HOME, "js/src/world/design-map-compile.mjs"));
          const mapsJsonText = readFileSync(join(vaultDir, "maps.json"), "utf8");
          const worldBibleText = readFileSync(join(vaultDir, "world-bible.md"), "utf8");
          // Places (Stage 4): the built map asset embeds the gazetteer + place-marker anchors.
          const placesTextCompile = readDocs().find((d) => /kind:\s*places/.test(d.content))?.content;
          const { worldMap, warnings } = compileDesignMap({ mapsJsonText, worldBibleText, mapId: p.mapId, placesText: placesTextCompile });
          const file = writeWorldMap(worldMap);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ file, contentHash: worldMap.provenance.contentHash, warnings }));
          return;
        }
        if (req.url === "/api/map-save") {
          try {
            const r = await saveMaps(p.maps, p.activeMapId, p.baseRev);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(r));
          } catch (error) {
            if (!(error instanceof AtlasSourceBridgeError)) throw error;
            res.writeHead(error.status, { "content-type": "application/json", "cache-control": "no-store" });
            res.end(JSON.stringify(error.response()));
          }
          return;
        }
        if (req.url === "/api/doc-create") {
          const r = createDoc(p.title, p.kind);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(r));
          return;
        }
        if (req.url === "/api/doc-delete") {
          const r = deleteDoc(p.name);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(r));
          return;
        }
        if (req.url === "/api/edit-location") {
          if (p.op === "add" && !p.id) {
            const base = String(p.name || "marker").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "marker";
            const existing = new Set((computeState().world.locations || []).map((l) => l.id));
            let id = base, n = 2; while (existing.has(id)) id = `${base}-${n++}`;
            p.id = id;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(editLocation(p.op, p)));
          return;
        }
        if (req.url === "/api/edit-place") {
          // Body: { op, place } — op ∈ add|update|move|reparent|delete. On add without an id,
          // slugify the name (uniqued against the current tree) so the client can add by name.
          const place = p.place || {};
          if (p.op === "add" && !place.id) {
            const base = String(place.name || "place").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "place";
            const existing = new Set((computeState().places || []).map((pl) => pl.id));
            let id = base, n = 2; while (existing.has(id)) id = `${base}-${n++}`;
            place.id = id;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(editPlace(p.op, place)));
          return;
        }
        if (req.url === "/api/pack-import") {
          // Import a content pack into the engine asset root: a generator recipe bakes its trees on
          // the fly (headless ez-tree) + binds them; a static pack copies its GLBs. Merges
          // tree-pack.json / biome-pack.json / catalog.json — read fresh by the engine + /api/catalog.
          try {
            const r = importPack({ packsDir: PACKS_DIR, packName: String(p.pack || ""), assetsDir: ASSETS_DIR });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(r));
          } catch (e) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
          }
          return;
        }
        const ctx = assembleContext(p.agentId, p.screen || {});
        const out = await callModel(ctx.systemPrompt, p.history || [], String(p.message || ""));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ role: ctx.role, title: ctx.title, model: MODEL, ...out }));
      } catch (e) {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e), reply: "⚠ " + String(e) }));
      }
    });
    return;
  }
  if (req.method === "GET" && req.url.split("?")[0] === "/api/session") {
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(JSON.stringify({ token: DESIGN_SESSION_TOKEN, editor: EDITOR_LAUNCH_CONFIG }));
    return;
  }
  if (req.method === "GET" && req.url.split("?")[0] === "/api/packs") {
    // The content-pack library (LIMINA_PACKS_DIR or LIMINA_HOME/packs), each with an `imported`
    // flag computed against the current asset root — so the Packs panel can show what's installed.
    try {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
      res.end(JSON.stringify({ packs: listPacks({ packsDir: PACKS_DIR, assetsDir: ASSETS_DIR }) }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ packs: [], error: String(e) }));
    }
    return;
  }
  if (req.method === "GET" && req.url.split("?")[0] === "/api/catalog") {
    // The REAL asset catalog (read fresh — the architect daemon appends approved assets).
    try {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
      const catalog = join(ASSETS_DIR, "catalog.json");
      res.end(existsSync(catalog) ? readFileSync(catalog, "utf8") : "[]");
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/api/peek/")) {
    const job = peekJobs.get(basename(req.url.split("?")[0]));
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
    res.end(JSON.stringify(job ? {
      ...job,
      url: job.png ? "/api/peek-image/" + job.png : undefined,
      frameUrls: job.frames ? job.frames.map((f) => "/api/peek-image/" + f) : undefined,
    } : { status: "unknown" }));
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/api/peek-image/")) {
    try {
      const name = basename(req.url.split("?")[0]);
      if (!/^[\w.-]+\.png$/.test(name)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-cache" });
      res.end(readFileSync(join(LIMINA_HOME, "tools", "preview", "out", name)));
    } catch { res.writeHead(404); res.end(); }
    return;
  }
  if (req.method === "GET" && req.url.split("?")[0] === "/api/worldmaps") {
    // Compiled WorldMap IR files available for import into the Atlas as paint layers.
    try {
      const files = listWorldMaps();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
      res.end(JSON.stringify(files));
    } catch { res.writeHead(200, { "content-type": "application/json" }); res.end("[]"); }
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/api/worldmaps/")) {
    try {
      const relativePath = decodeURIComponent(req.url.split("?")[0].slice("/api/worldmaps/".length));
      if (!relativePath.endsWith(".worldmap.json") || relativePath.split(/[\\/]/).some((part) => part === ".." || part === "")) {
        res.writeHead(404); res.end(); return;
      }
      const root = resolve(ASSETS_DIR, "maps");
      const file = resolve(root, relativePath);
      if (file !== root && !file.startsWith(root + "/")) { res.writeHead(404); res.end(); return; }
      const body = readFileSync(file, "utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/assets/qc/")) {
    // QC-render thumbnails for the stamp tool — basename-only (traversal-safe), read-only.
    try {
      const name = basename(req.url.split("?")[0]);
      if (!/^[\w.-]+\.(png|jpg|jpeg)$/i.test(name)) { res.writeHead(404); res.end(); return; }
      const bytes = readFileSync(join(ASSETS_DIR, "qc", name));
      res.writeHead(200, { "content-type": name.endsWith(".png") ? "image/png" : "image/jpeg", "cache-control": "max-age=300" });
      res.end(bytes);
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    }
    return;
  }
  if (req.url === "/api/state") {
    try {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(computeState()));
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
  } else if (req.method === "GET" && SHARED_MODULES[req.url.split("?")[0]]) {
    // Engine-shared pure modules: the SAME marching-squares/codec code the compiler runs is
    // served to the frontend, so the coast the user sees while painting IS the compiled coast.
    // Explicit allow-list only — never a generic js/src mount.
    try {
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-cache" });
      res.end(readFileSync(SHARED_MODULES[req.url.split("?")[0]], "utf8"));
    } catch (e) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(e));
    }
  } else if (req.method === "GET") {
    // Generic frontend static dispatch (the SPA is ES modules now, not one cached HTML blob).
    // Resolve inside FRONTEND_DIR only; anything else (traversal, unknown type) is a 404.
    const clean = (req.url.split("?")[0] || "/").replace(/\/+$/, "") || "/";
    const rel = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
    const fp = resolve(FRONTEND_DIR, rel);
    const ext = fp.slice(fp.lastIndexOf("."));
    if (fp.startsWith(FRONTEND_DIR + "/") || fp === join(FRONTEND_DIR, "index.html")) {
      try {
        const body = readFileSync(fp);
        res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-cache" });
        res.end(body);
        return;
      } catch { /* fall through to 404 */ }
    }
    res.writeHead(404); res.end("not found");
  } else {
    res.writeHead(404); res.end("not found");
  }
}).listen(port, HOST, () => {
  console.log(`\n  Design Space — ${vaultDir}`);
  console.log(`  open  http://localhost:${port}/\n`);
});
