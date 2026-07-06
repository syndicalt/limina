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
import { vaultToStore, vaultGraph } from "${LIMINA_HOME}/js/src/game/design-vault.ts";
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
ops.op_log("${BEGIN}" + JSON.stringify({ graph, build }) + "${END}");
`;
  const tmp = mkdtempSync(join(tmpdir(), "limina-design-"));
  const hp = join(tmp, "h.ts");
  writeFileSync(hp, harness);
  const res = spawnSync(LIMINA_BIN, [hp], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  rmSync(tmp, { recursive: true, force: true });
  const out = (res.stdout || "") + (res.stderr || "");
  const m = out.match(new RegExp(BEGIN + "([\\s\\S]*?)" + END));
  const extra = m ? JSON.parse(m[1]) : { graph: { nodes: [], edges: [] }, build: { ok: false, error: out.slice(-400) } };
  return { project: vaultDir.split("/").filter(Boolean).slice(-2, -1)[0] || "project", docs, ...extra };
}

createServer((req, res) => {
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
