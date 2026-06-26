// Co-authoring editor — wires the verified MCP contract to three panels:
//   (a) World     — inspector.snapshot (entities + transforms + tags, agents, skills)
//   (b) Reasoning — per-agent perceive->decide->act forest from trace.tail + causedBy
//   (c) Approval  — approval.list -> Approve/Reject -> approval.grant / approval.deny
//
// Live updates: poll trace.tail with the afterSeq CURSOR (incremental) + a periodic
// inspector.snapshot. Streaming-push is deferred; polling the cursor is the
// first-cut mechanism (the read-only state/subscribe stream is also consumed for
// live entity transforms between snapshots).

import { McpClient, McpError } from "./mcp-client.js";
import { buildForest, groupByActor, eventKind } from "./reasoning.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const state = {
  /** @type {McpClient | undefined} */ client: undefined,
  /** @type {McpClient | undefined} */ agentClient: undefined,
  events: new Map(), // id -> event (accumulated trace)
  afterSeq: -1,
  snapshot: undefined,
  approvals: [],
  polling: undefined,
  log: [],
};

function logLine(msg, kind = "info") {
  state.log.unshift({ t: new Date().toLocaleTimeString(), msg, kind });
  state.log = state.log.slice(0, 80);
  const box = $("log");
  box.innerHTML = "";
  for (const l of state.log) {
    const row = el("div", "log-row log-" + l.kind);
    row.appendChild(el("span", "log-time", l.t));
    row.appendChild(el("span", "log-msg", l.msg));
    box.appendChild(row);
  }
}

function setStatus(connected) {
  const dot = $("status-dot");
  const txt = $("status-text");
  dot.className = "dot " + (connected ? "dot-on" : "dot-off");
  txt.textContent = connected ? "connected" : "disconnected";
}

// ---------------------------------------------------------------------------
// Connect / disconnect.
// ---------------------------------------------------------------------------
async function connect() {
  const url = $("url").value.trim();
  const profile = $("profile").value;
  disconnect();
  const client = new McpClient(url);
  client.onConnectionChange = setStatus;
  client.onSync = () => {}; // live transforms cached; World panel re-renders on poll
  try {
    await client.connect();
    const sessionId = "ses_editor_" + Math.random().toString(36).slice(2, 8);
    await client.initialize("human_editor", sessionId, profile);
    try { await client.subscribe(); } catch { /* read-stream optional */ }
    state.client = client;
    logLine(`connected to ${url} as ${profile}`, "ok");
    startPolling();
    await refreshAll();
  } catch (e) {
    logLine("connect failed: " + (e && e.message ? e.message : String(e)), "err");
    setStatus(false);
  }
}

function disconnect() {
  if (state.polling) { clearInterval(state.polling); state.polling = undefined; }
  if (state.client) { state.client.close(); state.client = undefined; }
  if (state.agentClient) { state.agentClient.close(); state.agentClient = undefined; }
  state.events.clear();
  state.afterSeq = -1;
  setStatus(false);
}

function startPolling() {
  const ms = Math.max(250, Number($("interval").value) || 1000);
  if (state.polling) clearInterval(state.polling);
  state.polling = setInterval(() => { void refreshAll(); }, ms);
}

// ---------------------------------------------------------------------------
// Poll: incremental trace.tail (cursor), approval.list, periodic snapshot.
// ---------------------------------------------------------------------------
let snapshotTick = 0;
async function refreshAll() {
  const c = state.client;
  if (!c) return;
  try {
    // Incremental trace via the afterSeq cursor.
    const tail = await c.callTool("trace.tail", { afterSeq: state.afterSeq, limit: 500 });
    if (tail && Array.isArray(tail.events)) {
      for (const ev of tail.events) state.events.set(ev.id, ev);
      if (tail.nextAfterSeq !== null && tail.nextAfterSeq !== undefined) state.afterSeq = tail.nextAfterSeq;
    }
    // Approval queue every poll (cheap, must stay fresh).
    const list = await c.callTool("approval.list", {});
    state.approvals = (list && list.pending) || [];
    // World snapshot less often (heavier).
    if (snapshotTick % 2 === 0) {
      state.snapshot = await c.callTool("inspector.snapshot", { limit: 200 });
    }
    snapshotTick++;
    renderWorld();
    renderReasoning();
    renderApprovals();
  } catch (e) {
    logLine("poll error: " + (e && e.message ? e.message : String(e)), "err");
  }
}

// ---------------------------------------------------------------------------
// (a) WORLD panel.
// ---------------------------------------------------------------------------
function renderWorld() {
  const root = $("world-body");
  root.innerHTML = "";
  const snap = state.snapshot;
  if (!snap) { root.appendChild(el("div", "muted", "no snapshot yet")); return; }

  const meta = el("div", "kv");
  meta.appendChild(kv("mode", snap.world?.mode ?? "?"));
  meta.appendChild(kv("entities", String(snap.entities?.length ?? 0)));
  meta.appendChild(kv("skills", String(snap.skills?.length ?? 0)));
  meta.appendChild(kv("caller caps", (snap.permissions?.caller ?? []).join(", ") || "—"));
  root.appendChild(meta);

  root.appendChild(el("h4", null, "Entities"));
  const live = state.client?.entityState;
  const etable = el("div", "list");
  for (const e of snap.entities ?? []) {
    const liveState = live?.get(e.entity);
    const pos = liveState ? liveState.pos : e.transform.position;
    const row = el("div", "row");
    row.appendChild(el("span", "mono", e.entity));
    row.appendChild(el("span", "dim", `(${fmt(pos[0])}, ${fmt(pos[1])}, ${fmt(pos[2])})`));
    if (e.tags && e.tags.length) {
      const tags = el("span", "tags");
      for (const t of e.tags) tags.appendChild(el("span", "tag", t));
      row.appendChild(tags);
    }
    etable.appendChild(row);
  }
  root.appendChild(etable);

  const agents = snap.agents ?? [];
  root.appendChild(el("h4", null, `Agents (${agents.length})`));
  if (agents.length === 0) {
    root.appendChild(el("div", "muted", "no in-process agents registered — proposing agents connect as external MCP clients (see Approval queue / trace actors)"));
  } else {
    const at = el("div", "list");
    for (const a of agents) {
      const row = el("div", "row");
      row.appendChild(el("span", "mono", a.id ?? "?"));
      row.appendChild(el("span", "tag", a.profile ?? "?"));
      row.appendChild(el("span", "dim", `queue ${a.queueLength ?? 0}${a.inFlight ? " • acting" : ""}`));
      at.appendChild(row);
    }
    root.appendChild(at);
  }
}

// ---------------------------------------------------------------------------
// (b) REASONING panel — causal forest grouped by actor.
// ---------------------------------------------------------------------------
function renderReasoning() {
  const root = $("reason-body");
  root.innerHTML = "";
  const events = [...state.events.values()];
  if (events.length === 0) { root.appendChild(el("div", "muted", "no trace events yet")); return; }
  const { roots } = buildForest(events);
  const byActor = groupByActor(roots);
  for (const [actor, actorRoots] of byActor) {
    root.appendChild(el("h4", null, actor));
    const ul = el("ul", "tree");
    for (const node of actorRoots) ul.appendChild(renderNode(node));
    root.appendChild(ul);
  }
}

function renderNode(node) {
  const li = el("li", null);
  const head = el("div", "node node-" + node.kind);
  head.appendChild(el("span", "node-type", node.event.type));
  const label = stepLabel(node.event);
  if (label) head.appendChild(el("span", "node-label", label));
  head.title = JSON.stringify(node.event.payload, null, 2);
  li.appendChild(head);
  if (node.children.length) {
    const ul = el("ul", "tree");
    for (const c of node.children) ul.appendChild(renderNode(c));
    li.appendChild(ul);
  }
  return li;
}

function stepLabel(ev) {
  const p = ev.payload || {};
  if (p.skill) return p.skill;
  if (p.tool) return p.tool;
  if (p.rule) return p.rule;
  return "";
}

// ---------------------------------------------------------------------------
// (c) APPROVAL queue.
// ---------------------------------------------------------------------------
function renderApprovals() {
  const root = $("approval-body");
  root.innerHTML = "";
  const badge = $("approval-count");
  badge.textContent = String(state.approvals.length);
  if (state.approvals.length === 0) {
    root.appendChild(el("div", "muted", "no actions awaiting approval"));
    return;
  }
  for (const a of state.approvals) {
    const card = el("div", "approval-card");
    const top = el("div", "approval-top");
    top.appendChild(el("span", "approval-skill", a.skill));
    top.appendChild(el("span", "tag", a.profile ?? "?"));
    card.appendChild(top);
    card.appendChild(el("div", "dim", `proposed by ${a.agentId} • tick ${a.tick}`));
    const pre = el("pre", "approval-input");
    pre.textContent = JSON.stringify(a.input, null, 2);
    card.appendChild(pre);
    const actions = el("div", "approval-actions");
    const approve = el("button", "btn btn-approve", "Approve");
    approve.onclick = () => resolve(a.approvalId, true);
    const reject = el("button", "btn btn-reject", "Reject");
    reject.onclick = () => resolve(a.approvalId, false);
    actions.appendChild(approve);
    actions.appendChild(reject);
    card.appendChild(actions);
    root.appendChild(card);
  }
}

async function resolve(approvalId, grant) {
  const c = state.client;
  if (!c) return;
  try {
    if (grant) {
      const r = await c.callTool("approval.grant", { approvalId });
      logLine(`granted ${approvalId.slice(0, 24)}… applied=${r.applied}`, r.applied ? "ok" : "err");
    } else {
      const reason = prompt("Reject reason (optional):") || undefined;
      const r = await c.callTool("approval.deny", { approvalId, reason });
      logLine(`denied ${approvalId.slice(0, 24)}… resolved=${r.resolved}`, "warn");
    }
    await refreshAll();
  } catch (e) {
    logLine("resolve failed: " + (e && e.message ? e.message : String(e)), "err");
  }
}

// ---------------------------------------------------------------------------
// Dev affordance: connect a builder.review client and propose a held edit so the
// approval queue populates without a separate agent process. Goes through the
// REAL gate (the call comes back as pending_approval — that's the expected hold).
// ---------------------------------------------------------------------------
async function proposeTestEdit() {
  const url = $("url").value.trim();
  try {
    if (!state.agentClient) {
      const a = new McpClient(url);
      await a.connect();
      await a.initialize("agt_demo", "ses_demo_" + Math.random().toString(36).slice(2, 6), "builder.review");
      state.agentClient = a;
    }
    const pos = [Math.round((Math.random() * 8 - 4) * 10) / 10, 0.5, Math.round((Math.random() * 8 - 4) * 10) / 10];
    try {
      await state.agentClient.callTool("scene.createEntity", { position: pos, shape: "box", color: 0x44aaff });
      logLine("proposal applied directly — is the review gate enabled on the server?", "warn");
    } catch (e) {
      if (e instanceof McpError && e.isPendingApproval) {
        logLine(`agent proposed scene.createEntity at [${pos.join(", ")}] — HELD (approvalId ${e.message.slice(0, 20)}…)`, "info");
      } else {
        throw e;
      }
    }
    await refreshAll();
  } catch (e) {
    logLine("propose failed: " + (e && e.message ? e.message : String(e)), "err");
  }
}

// ---------------------------------------------------------------------------
// helpers + wiring
// ---------------------------------------------------------------------------
function kv(k, v) {
  const d = el("div", "kv-item");
  d.appendChild(el("span", "kv-k", k));
  d.appendChild(el("span", "kv-v", v));
  return d;
}
function fmt(n) { return (Math.round(n * 1000) / 1000).toString(); }

$("connect").onclick = () => void connect();
$("disconnect").onclick = () => { disconnect(); logLine("disconnected", "warn"); };
$("propose").onclick = () => void proposeTestEdit();
$("interval").onchange = () => { if (state.client) startPolling(); };
logLine("ready — set the server URL and Connect (run editor/server/editor_host.ts for the gate-enabled server)", "info");
