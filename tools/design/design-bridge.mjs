#!/usr/bin/env node
// design-bridge.mjs — an MCP server that lets YOUR coding-agent session (Claude Code,
// Codex, …) drive the Design Space directly, the same way limina-bridge lets it drive the
// editor. No API key: your session IS the expert team. It fetches a role's full context
// (persona + owned/upstream documents + what you're viewing) and wears that hat, reads and
// edits the vault, and a save surfaces the cascade.
//
// Register it with your agent (set LIMINA_DESIGN_VAULT to the project's design/ folder):
//   { "mcpServers": { "limina-design": {
//       "command": "node",
//       "args": ["<limina>/tools/design/design-bridge.mjs"],
//       "env": { "LIMINA_DESIGN_VAULT": "<project>/design" } } } }

import readline from "node:readline";
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const VERSION = "0.1.0";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const JRPC_ERR = { parseError: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internalError: -32603 };
const HOME = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = process.env.LIMINA_BIN || join(HOME, "target", "release", "limina");
const VAULT = resolve(process.env.LIMINA_DESIGN_VAULT || process.cwd());

function stderr(m) { process.stderr.write(`[design-bridge] ${m}\n`); }
function write(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function ok(id, result) { return { jsonrpc: "2.0", id, result }; }
function err(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

function readDocs() {
  return readdirSync(VAULT).filter((f) => f.endsWith(".md")).sort()
    .map((f) => ({ name: f, content: readFileSync(join(VAULT, f), "utf8") }));
}

// Run an expression inside the limina runtime with the design modules + `docs` in scope.
const RB = "===R_BEGIN===", RE = "===R_END===";
function harness(returnExpr) {
  const docs = readDocs();
  const src = `
import { vaultToStore, vaultGraph, diffDocEntities } from "${HOME}/js/src/game/design-vault.ts";
import { compileDesignToGds } from "${HOME}/js/src/game/design-compile.ts";
import { assembleAgentContext, DESIGN_AGENTS } from "${HOME}/js/src/game/design-agents.ts";
import { computeImpact } from "${HOME}/js/src/game/design-cascade.ts";
import { ops } from "${HOME}/js/src/engine.ts";
const docs = ${JSON.stringify(docs)};
const out = (() => { ${returnExpr} })();
ops.op_log("${RB}" + JSON.stringify(out) + "${RE}");
`;
  const tmp = mkdtempSync(join(tmpdir(), "design-bridge-"));
  const hp = join(tmp, "h.ts");
  writeFileSync(hp, src);
  const r = spawnSync(BIN, [hp], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  rmSync(tmp, { recursive: true, force: true });
  const o = (r.stdout || "") + (r.stderr || "");
  const m = o.match(new RegExp(RB + "([\\s\\S]*?)" + RE));
  if (!m) throw new Error("engine call failed: " + o.slice(-400));
  return JSON.parse(m[1]);
}

function saveDoc(name, content) {
  const safe = basename(String(name));
  if (!safe.endsWith(".md")) throw new Error("doc name must end in .md");
  const fp = join(VAULT, safe);
  let old = "";
  try { old = readFileSync(fp, "utf8"); } catch { /* new */ }
  writeFileSync(fp, content);
  const out = harness(
    `const changes = diffDocEntities(${JSON.stringify(old)}, ${JSON.stringify(content)});` +
    `const impacts = changes.map((ch) => computeImpact(docs, ch)).filter((i) => i.affected.length || i.downstreamArtifacts.length);` +
    `return { changes, impacts };`,
  );
  return { saved: true, ...out };
}

// A recorded, shared message channel so MULTIPLE specialized agents (one per expert,
// spawned as subagents or separate bridge connections) can communicate — post proposals,
// impacts, and questions to each other; the Architect reads all and routes. Recorded to a
// dotfile in the vault so it is replayable and the frontend can render the conversation.
const MSGFILE = join(VAULT, ".design-messages.jsonl");
function readMessages(filter = {}) {
  let lines = [];
  try { lines = readFileSync(MSGFILE, "utf8").split("\n").filter((l) => l.trim()); } catch { /* none */ }
  let msgs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (typeof filter.since === "number") msgs = msgs.filter((m) => m.seq > filter.since);
  if (filter.forAgent) msgs = msgs.filter((m) => !m.to || m.to === "all" || m.to === filter.forAgent || m.from === filter.forAgent);
  return msgs;
}
function postMessage(msg) {
  const seq = readMessages().length + 1;
  const rec = {
    seq, ts: Date.now(),
    from: String(msg.from || "unknown"),
    to: msg.to ? String(msg.to) : "all",
    aboutDoc: msg.aboutDoc ? String(msg.aboutDoc) : undefined,
    kind: ["proposal", "impact", "question", "note"].includes(msg.kind) ? msg.kind : "note",
    text: String(msg.text || ""),
  };
  writeFileSync(MSGFILE, (() => { let e = ""; try { e = readFileSync(MSGFILE, "utf8"); } catch {} return e; })() + JSON.stringify(rec) + "\n");
  return rec;
}

const TOOLS = [
  { name: "design_list_docs", description: "List the design vault documents (name, kind, title).",
    inputSchema: { type: "object", properties: {} } },
  { name: "design_read_doc", description: "Read a design document's full markdown.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "design_save_doc", description: "Write a design document, then return the cascade impact of what changed (surface, do not silently drift).",
    inputSchema: { type: "object", properties: { name: { type: "string" }, content: { type: "string" } }, required: ["name", "content"] } },
  { name: "design_context", description: "Get the FULL role context for a design expert (concept|artDirection|world|cast|storyboard|architect) so you can respond AS that expert: persona + owned/upstream documents + what the maker is viewing. Call this before answering as an expert.",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, screen: { type: "object" } }, required: ["agentId"] } },
  { name: "design_cascade", description: "Compute the cascade impact of a change (entityId or artifact, op) over the design graph.",
    inputSchema: { type: "object", properties: { entityId: { type: "string" }, artifact: { type: "string" }, op: { type: "string", enum: ["modified", "removed", "added"] } }, required: ["op"] } },
  { name: "design_graph", description: "The mind-map graph generated from the vault's links (nodes + typed edges).",
    inputSchema: { type: "object", properties: {} } },
  { name: "design_build", description: "Compile the vault and return the build: placements + doc<->build links.",
    inputSchema: { type: "object", properties: {} } },
  { name: "design_agents", description: "The design expert team roster (roles, owned artifacts, dependencies).",
    inputSchema: { type: "object", properties: {} } },
  { name: "design_post_message", description: "Post a message to another design agent (or all) on the shared team channel — how specialized agents communicate: proposals, cascade impacts, questions. from = your agent id (e.g. 'world'); to = another agent id or omit for all.",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, aboutDoc: { type: "string" }, kind: { type: "string", enum: ["proposal", "impact", "question", "note"] }, text: { type: "string" } }, required: ["from", "text"] } },
  { name: "design_read_messages", description: "Read the shared team channel. since = last seq you saw; forAgent = only messages to/from that agent.",
    inputSchema: { type: "object", properties: { since: { type: "number" }, forAgent: { type: "string" } } } },
];

function callTool(name, args) {
  switch (name) {
    case "design_list_docs":
      return readDocs().map((d) => ({
        name: d.name,
        kind: (d.content.match(/kind:\s*([^\s]+)/) || [])[1] || "doc",
        title: (d.content.match(/\ntitle:\s*(.+)/) || [])[1] || d.name.replace(/\.md$/, ""),
      }));
    case "design_read_doc": {
      const d = readDocs().find((x) => x.name === args.name || x.name === args.name + ".md");
      if (!d) throw new Error(`no document "${args.name}"`);
      return d.content;
    }
    case "design_save_doc": return saveDoc(args.name, args.content);
    case "design_context":
      return harness(`return assembleAgentContext(${JSON.stringify(String(args.agentId))}, vaultToStore(docs).store, ${JSON.stringify(args.screen || {})});`);
    case "design_cascade":
      return harness(`return computeImpact(docs, ${JSON.stringify({ entityId: args.entityId, artifact: args.artifact, op: args.op || "modified" })});`);
    case "design_graph": return harness(`return vaultGraph(docs);`);
    case "design_build":
      return harness(
        `const { store, links } = vaultToStore(docs); const { gds, issues } = compileDesignToGds(store);` +
        `const placements = (gds && gds.world && gds.world.placements) ? gds.world.placements : [];` +
        `const has = (id) => placements.some((p) => p.id === id); const ent = new Set((gds?gds.entities:[]).map((e)=>e.id));` +
        `const resolved = links.map((l)=>({ ...l, buildId: has("location-"+l.entity)?"location-"+l.entity:has("entity-"+l.entity)?"entity-"+l.entity:ent.has(l.entity)?l.entity:null }));` +
        `return { ok: !!gds, issues, placements: placements.map((p)=>({id:p.id,position:p.transform.position})), links: resolved };`,
      );
    case "design_agents":
      return harness(`return DESIGN_AGENTS.map((a)=>({ id:a.id, role:a.role, title:a.title, scope:a.scope, owns:a.artifactKind, upstream:a.upstreamKinds, downstream:a.downstreamKinds }));`);
    case "design_post_message": return postMessage(args);
    case "design_read_messages": return readMessages(args || {});
    default: throw new Error(`unknown tool ${name}`);
  }
}

function dispatch(req) {
  const id = req.id ?? null;
  switch (req.method) {
    case "initialize":
      return ok(id, { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "limina-design", version: VERSION } });
    case "notifications/initialized": return ok(id, {});
    case "ping": return ok(id, {});
    case "tools/list": return ok(id, { tools: TOOLS });
    case "tools/call": {
      const p = req.params || {};
      if (typeof p.name !== "string") return err(id, JRPC_ERR.invalidParams, "tools/call requires a name");
      try {
        const result = callTool(p.name, p.arguments || {});
        return ok(id, { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] });
      } catch (e) {
        return ok(id, { content: [{ type: "text", text: "⚠ " + String(e) }], isError: true });
      }
    }
    case "shutdown": case "exit": return ok(id, {});
    default:
      if (req.method.startsWith("notifications/")) return ok(id, {});
      return err(id, JRPC_ERR.methodNotFound, `Method not found: ${req.method}`);
  }
}

stderr(`serving design vault ${VAULT} (${readDocs().length} docs)`);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let req;
  try { req = JSON.parse(t); } catch { write(err(null, JRPC_ERR.parseError, "parse error")); return; }
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") { write(err(req.id ?? null, JRPC_ERR.invalidRequest, "invalid request")); return; }
  const res = dispatch(req);
  if (req.id !== undefined) write(res);
});
