#!/usr/bin/env node
// serve-design.mjs — the Design Space frontend server. Serves the design home-base SPA
// and, on each /api/state request, reads the vault fresh and runs it through the engine
// translator (so the UI reflects live doc edits): the documents, the generated mind-map
// graph, and the doc<->build links.
//
//   node tools/design/serve-design.mjs <vault-dir> [port]

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { buildPeekScene } from "./peek-scene.mjs";
import { connect as netConnect } from "node:net";

// 3D-peek render jobs (Painter P5): jobId -> {status, png?, error?}. In-memory, best-effort.
const peekJobs = new Map();
import { createServer } from "node:http";
import { migrateMapDoc, serializeMapDoc } from "./map-doc.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIMINA_HOME = resolve(__dirname, "..", "..");
const LIMINA_BIN = process.env.LIMINA_BIN || join(LIMINA_HOME, "target", "release", "limina");
// The frontend is served from disk PER REQUEST (no boot cache — caching index.html at startup
// meant every frontend edit needed a server restart, a repeated debugging trap).
const FRONTEND_DIR = join(__dirname, "frontend");
const SHARED_MODULES = {
  "/shared/marching-squares.mjs": join(LIMINA_HOME, "js/src/world/pipeline/marching-squares.mjs"),
  "/shared/raster-codec.mjs": join(LIMINA_HOME, "js/src/world/pipeline/raster-codec.mjs"),
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

const vaultDir = resolve(process.argv[2] || process.cwd());
const port = Number(process.argv[3]) || 4321;

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
import { vaultToStore, vaultGraph, parseFrontmatter } from "${LIMINA_HOME}/js/src/game/design-vault.ts";
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
    world.locations = (fm.locations || []).map((l) => ({ id: l.id, name: l.name, kind: l.kind, region: l.region, x: (l.position||[0,0])[0], z: (l.position||[0,0])[1], tags: l.tags || [], map: l.map || "", mapLink: l.mapLink || "" }));
  }
} catch (e) { world = { regions: [], locations: [] }; }
ops.op_log("${BEGIN}" + JSON.stringify({ graph, build, world }) + "${END}");
`;
  const tmp = mkdtempSync(join(tmpdir(), "limina-design-"));
  const hp = join(tmp, "h.ts");
  writeFileSync(hp, harness);
  const res = spawnSync(LIMINA_BIN, [hp], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  rmSync(tmp, { recursive: true, force: true });
  const out = (res.stdout || "") + (res.stderr || "");
  const m = out.match(new RegExp(BEGIN + "([\\s\\S]*?)" + END));
  const extra = m ? JSON.parse(m[1]) : { graph: { nodes: [], edges: [] }, build: { ok: false, error: out.slice(-400) } };
  const project = vaultDir.split("/").filter(Boolean).slice(-2, -1)[0] || "project";
  return { project, docs, ...loadMaps(project), ...extra };
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
  // COMPARE-AND-SET: saves are wholesale (the client posts its entire in-memory doc), so a
  // client holding stale state would silently clobber every feature saved since it loaded —
  // the proven root cause of the phantom feature loss. A save whose baseRev doesn't match the
  // on-disk revision is refused with a conflict; the client reloads and the stale tab's
  // unsaved edits are dropped VISIBLY instead of newer disk state dying silently.
  const cur = mapsRev();
  if (typeof baseRev !== "string" || baseRev !== cur) return { conflict: true, mapsRev: cur };
  // The client only round-trips maps + activeMapId; re-read the on-disk doc so top-level markers
  // it doesn't know about (e.g. axes:"north-negz") survive every save.
  let prev = {};
  try { prev = JSON.parse(readFileSync(join(vaultDir, "maps.json"), "utf8")) || {}; } catch { /* first save */ }
  const doc = serializeMapDoc(maps, activeMapId, prev);
  // TRIPWIRE (phantom feature loss under investigation): whenever a save DROPS features that the
  // on-disk doc has, snapshot both sides so the culprit interaction can be reconstructed. Legit
  // deletes trip this too — it's evidence, not a refusal.
  try {
    for (const pm of prev.maps || []) {
      const nm = doc.maps.find((m) => m.id === pm.id);
      const prevIds = new Set((pm.features || []).map((f) => f.id));
      const nextIds = new Set(((nm && nm.features) || []).map((f) => f.id));
      const dropped = [...prevIds].filter((id) => !nextIds.has(id));
      if (dropped.length > 0) {
        const evDir = join(vaultDir, ".map-save-drops");
        mkdirSync(evDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        writeFileSync(join(evDir, `${stamp}-${pm.id}.json`), JSON.stringify({ droppedIds: dropped, prevMap: pm, nextMap: nm ?? null }, null, 2));
        console.warn(`map-save DROPPED ${dropped.length} feature(s) from "${pm.id}" (${dropped.join(", ")}) — evidence in ${evDir}`);
      }
    }
  } catch { /* evidence only — never block a save */ }
  writeFileSync(join(vaultDir, "maps.json"), JSON.stringify(doc, null, 2));
  return { saved: true, maps: doc.maps.length, mapsRev: mapsRev() };
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

createServer((req, res) => {
  if (req.method === "POST" && ["/api/agent", "/api/save", "/api/move-location", "/api/edit-location", "/api/map-save", "/api/compile-map", "/api/peek", "/api/doc-create", "/api/doc-delete"].includes(req.url)) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const p = JSON.parse(body || "{}");
        if (req.url === "/api/save") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(saveDoc(p.name, p.content)));
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
          const { compileDesignMap } = await import(join(LIMINA_HOME, "js/src/world/design-map-compile.mjs"));
          const mapsJsonText = readFileSync(join(vaultDir, "maps.json"), "utf8");
          const worldBibleText = readFileSync(join(vaultDir, "world-bible.md"), "utf8");
          const project = vaultDir.split("/").filter(Boolean).slice(-2, -1)[0] || "project";
          const { worldMap } = compileDesignMap({ mapsJsonText, worldBibleText, mapId: p.mapId });
          const mapFile = `${project}-${worldMap.id}.worldmap.json`;
          writeFileSync(join(LIMINA_HOME, "assets", "maps", mapFile), JSON.stringify(worldMap, null, 2));
          // Scene assembly lives in peek-scene.mjs (pure, gate-proven) — everything the
          // author painted, including stamped asset-anchors, must appear in the peek.
          const { scene, sceneName, clampedToTileCap } = buildPeekScene(worldMap, { project, mapFile });
          const outDir = join(LIMINA_HOME, "tools", "preview", "out");
          mkdirSync(outDir, { recursive: true });
          writeFileSync(join(outDir, sceneName + ".json"), JSON.stringify(scene, null, 2));
          const jobId = "pk" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
          // 18 yaw frames at exact 20° steps (engine-shots' __setYaw mode — cheap per frame, and
          // the loop always closes). The Atlas lightbox scrubs them as a turntable.
          const FRAMES = 18;
          const child = spawn("node", [join(LIMINA_HOME, "tools/preview/engine-shots.mjs"), String(FRAMES), "400", "/tools/preview/out/" + sceneName + ".json", sceneName], { stdio: ["ignore", "pipe", "pipe"] });
          let errTail = "";
          child.stderr.on("data", (c) => { errTail = (errTail + c).slice(-800); });
          child.stdout.on("data", (c) => { errTail = (errTail + c).slice(-800); });
          child.on("exit", (code) => {
            const frames = [];
            for (let i = 1; i <= FRAMES; i++) if (existsSync(join(outDir, `${sceneName}-${i}.png`))) frames.push(`${sceneName}-${i}.png`);
            peekJobs.set(jobId, code === 0 && frames.length > 0
              ? { status: "done", png: frames[0], frames }
              : { status: "error", error: "render exited " + code + ": " + errTail.slice(-300) });
          });
          peekJobs.set(jobId, { status: "running" });
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
          const project = vaultDir.split("/").filter(Boolean).slice(-2, -1)[0] || "project";
          const { worldMap, warnings } = compileDesignMap({ mapsJsonText, worldBibleText, mapId: p.mapId });
          const file = `${project}-${worldMap.id}.worldmap.json`;
          writeFileSync(join(LIMINA_HOME, "assets", "maps", file), JSON.stringify(worldMap, null, 2));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ file, contentHash: worldMap.provenance.contentHash, warnings }));
          return;
        }
        if (req.url === "/api/map-save") {
          const r = saveMaps(p.maps, p.activeMapId, p.baseRev);
          res.writeHead(r.conflict ? 409 : 200, { "content-type": "application/json" });
          res.end(JSON.stringify(r));
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
  if (req.method === "GET" && req.url.split("?")[0] === "/api/catalog") {
    // The REAL asset catalog (read fresh — the architect daemon appends approved assets).
    try {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
      res.end(readFileSync(join(LIMINA_HOME, "assets", "catalog.json"), "utf8"));
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
      const dir = join(LIMINA_HOME, "assets", "maps");
      const files = readdirSync(dir).filter((f) => f.endsWith(".worldmap.json"));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
      res.end(JSON.stringify(files));
    } catch { res.writeHead(200, { "content-type": "application/json" }); res.end("[]"); }
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/api/worldmaps/")) {
    try {
      const name = basename(req.url.split("?")[0]);
      if (!/^[\w.-]+\.worldmap\.json$/.test(name)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(readFileSync(join(LIMINA_HOME, "assets", "maps", name), "utf8"));
    } catch { res.writeHead(404); res.end(); }
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/assets/qc/")) {
    // QC-render thumbnails for the stamp tool — basename-only (traversal-safe), read-only.
    try {
      const name = basename(req.url.split("?")[0]);
      if (!/^[\w.-]+\.(png|jpg|jpeg)$/i.test(name)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": name.endsWith(".png") ? "image/png" : "image/jpeg", "cache-control": "max-age=300" });
      res.end(readFileSync(join(LIMINA_HOME, "assets", "qc", name)));
    } catch {
      res.writeHead(404); res.end();
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
}).listen(port, () => {
  console.log(`\n  Design Space — ${vaultDir}`);
  console.log(`  open  http://localhost:${port}/\n`);
});
