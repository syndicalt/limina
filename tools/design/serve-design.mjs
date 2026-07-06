#!/usr/bin/env node
// serve-design.mjs — the Design Space frontend server. Serves the design home-base SPA
// and, on each /api/state request, reads the vault fresh and runs it through the engine
// translator (so the UI reflects live doc edits): the documents, the generated mind-map
// graph, and the doc<->build links.
//
//   node tools/design/serve-design.mjs <vault-dir> [port]

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIMINA_HOME = resolve(__dirname, "..", "..");
const LIMINA_BIN = process.env.LIMINA_BIN || join(LIMINA_HOME, "target", "release", "limina");
const APP = readFileSync(join(__dirname, "frontend", "index.html"), "utf8");

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
// rivers/roads, areas, outline) per map. The map owns maps.json (wholesale save). Markers stay
// world-bible locations (buildable + cascade); features are pure cartography.
function loadMaps(project) {
  let data;
  try { data = JSON.parse(readFileSync(join(vaultDir, "maps.json"), "utf8")); } catch { data = null; }
  if (!data || !Array.isArray(data.maps) || data.maps.length === 0) {
    data = { activeMapId: "primary", maps: [{ id: "primary", name: project + " — Hamlet", scope: "site", parent: null, features: [] }] };
  }
  return { maps: data.maps, activeMapId: data.activeMapId || data.maps[0].id };
}
function saveMaps(maps, activeMapId) {
  const clean = Array.isArray(maps) ? maps : [];
  writeFileSync(join(vaultDir, "maps.json"), JSON.stringify({ activeMapId: activeMapId || (clean[0] && clean[0].id), maps: clean }, null, 2));
  return { saved: true, maps: clean.length };
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
      "⚠ No ANTHROPIC_API_KEY found — add it to the project .env to get a live reply. " +
      "Your full role context IS assembled and ready: this expert already knows its persona, the documents " +
      "it owns and depends on, and which document you have open. Wire the key and it speaks." };
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
  if (req.method === "POST" && ["/api/agent", "/api/save", "/api/move-location", "/api/edit-location", "/api/map-save"].includes(req.url)) {
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
        if (req.url === "/api/map-save") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(saveMaps(p.maps, p.activeMapId)));
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
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e), reply: "⚠ " + String(e) }));
      }
    });
    return;
  }
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(APP);
  } else if (req.url === "/api/state") {
    try {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(computeState()));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
  } else {
    res.writeHead(404); res.end("not found");
  }
}).listen(port, () => {
  console.log(`\n  Design Space — ${vaultDir}`);
  console.log(`  open  http://localhost:${port}/\n`);
});
