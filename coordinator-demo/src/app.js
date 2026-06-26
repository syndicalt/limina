// coordinator-demo — the watchable showcase of an agent TEAM building "a cottage on
// the beach" under human review. One MCP-ws connection as `reviewer.coordinator`
// drives all four surfaces:
//   - the live WORLD viewport (THREE) — entities from inspector.snapshot, GHOST
//     markers for held edits;
//   - LEFT the agent ORG-CHART (coordinator -> 3 workers, bundle chips + live status)
//     from trace.tail;
//   - RIGHT the REVIEW QUEUE (held edits as cards, Approve/Reject -> grant/deny) from
//     approval.list;
//   - BOTTOM the TRACE RIBBON (decompose -> delegate -> propose -> review -> apply).
//
// All view-model derivation lives in viewmodel.js (pure, headlessly verified). This
// file is the browser shell: connect, poll, render the DOM, paint the world.

import { McpClient, McpError } from "./mcp-client.js";
import {
  buildOrgChart,
  buildReviewQueue,
  buildWorldModel,
  buildTraceRibbon,
} from "./viewmodel.js";
import { WorldRenderer } from "./world-renderer.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const state = {
  /** @type {McpClient | undefined} */ client: undefined,
  /** @type {WorldRenderer | undefined} */ renderer: undefined,
  events: new Map(), // id -> trace event (accumulated for the CURRENT build)
  afterSeq: -1,
  snapshot: undefined,
  pending: [],
  approved: [], // placements the human has approved this build (for the position-join)
  building: false,
  polling: undefined,
  built: false,
  log: [],
};

const URL_DEFAULT = "ws://localhost:8787/";

// ---------------------------------------------------------------------------
// Activity log.
// ---------------------------------------------------------------------------
function logLine(msg, kind = "info") {
  state.log.unshift({ t: new Date().toLocaleTimeString(), msg, kind });
  state.log = state.log.slice(0, 60);
  const box = $("log");
  if (!box) return;
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
  if (dot) dot.className = "dot " + (connected ? "dot-on" : "dot-off");
  if (txt) txt.textContent = connected ? "connected" : "offline";
}

// ---------------------------------------------------------------------------
// Connect / disconnect.
// ---------------------------------------------------------------------------
async function connect() {
  const url = ($("url")?.value || URL_DEFAULT).trim();
  disconnect();
  const client = new McpClient(url);
  client.onConnectionChange = setStatus;
  try {
    await client.connect();
    const sessionId = "ses_coord_demo_" + Math.random().toString(36).slice(2, 8);
    await client.initialize("agt_coord", sessionId, "reviewer.coordinator");
    try { await client.subscribe(); } catch { /* read-stream optional */ }
    state.client = client;
    logLine(`connected to ${url} as reviewer.coordinator`, "ok");
    setBuildEnabled(true);
    startPolling();
    await refreshAll();
  } catch (e) {
    logLine("connect failed: " + msgOf(e), "err");
    setStatus(false);
  }
}

function disconnect() {
  if (state.polling) { clearInterval(state.polling); state.polling = undefined; }
  if (state.client) { state.client.close(); state.client = undefined; }
  state.events.clear();
  state.afterSeq = -1;
  state.snapshot = undefined;
  state.pending = [];
  state.approved = [];
  state.built = false;
  state.building = false;
  state.renderer?.reset();
  setBuildEnabled(false);
  setStatus(false);
}

function setBuildEnabled(on) {
  const b = $("build");
  if (b) b.disabled = !on;
}

function startPolling() {
  const ms = Math.max(400, Number($("interval")?.value) || 900);
  if (state.polling) clearInterval(state.polling);
  state.polling = setInterval(() => { void refreshAll(); }, ms);
}

// ---------------------------------------------------------------------------
// Start the build — one coordinator.build call delegates the three workers.
// ---------------------------------------------------------------------------
async function startBuild() {
  const c = state.client;
  if (!c) { logLine("connect first", "warn"); return; }
  if (state.building) return;
  try {
    state.building = true;
    setBuildEnabled(false);
    // Show ONE clean build: clear the accumulated view and fast-forward the trace
    // cursor PAST everything already on the server, so this build's events are the
    // only ones we render (a re-run re-delegates w4/w5/w6 server-side — we don't
    // carry the stale workers into the org-chart/queue/world).
    await resetClientView();
    logLine("coordinator.build — decomposing 'a cottage on the beach'…", "info");
    const res = await c.callTool("coordinator.build", {});
    state.built = true;
    const names = (res.workers || []).map((w) => `${w.provider} (${w.workerId})`).join(", ");
    logLine(`delegated ${res.workers?.length ?? 0} workers: ${names}`, "ok");
    logLine("their mutating edits are HELD — review them on the right →", "info");
    await refreshAll();
  } catch (e) {
    if (e instanceof McpError && e.isPendingApproval) {
      logLine("coordinator.build returned a held action (unexpected)", "warn");
    } else {
      logLine("build failed: " + msgOf(e), "err");
    }
  } finally {
    state.building = false;
    setBuildEnabled(true);
  }
}

/** Clear the client view + re-baseline the trace cursor to the server's current
 *  high-water mark, so only the next build's events flow in. */
async function resetClientView() {
  state.events.clear();
  state.pending = [];
  state.approved = [];
  state.snapshot = undefined;
  state.renderer?.reset();
  try {
    const probe = await state.client.callTool("trace.tail", { afterSeq: -1, limit: 1000 });
    state.afterSeq = (probe && typeof probe.nextAfterSeq === "number") ? probe.nextAfterSeq : -1;
  } catch { state.afterSeq = -1; }
  renderAll();
}

// ---------------------------------------------------------------------------
// Poll: incremental trace.tail (cursor), approval.list, periodic snapshot.
// ---------------------------------------------------------------------------
let snapshotTick = 0;
async function refreshAll() {
  const c = state.client;
  if (!c) return;
  try {
    const tail = await c.callTool("trace.tail", { afterSeq: state.afterSeq, limit: 500 });
    if (tail && Array.isArray(tail.events)) {
      for (const ev of tail.events) state.events.set(ev.id, ev);
      if (tail.nextAfterSeq !== null && tail.nextAfterSeq !== undefined) state.afterSeq = tail.nextAfterSeq;
    }
    const list = await c.callTool("approval.list", {});
    state.pending = (list && list.pending) || [];
    if (snapshotTick % 2 === 0) {
      state.snapshot = await c.callTool("inspector.snapshot", { limit: 200 });
    }
    snapshotTick++;
    renderAll();
  } catch (e) {
    logLine("poll error: " + msgOf(e), "err");
  }
}

function renderAll() {
  const events = [...state.events.values()];
  const org = buildOrgChart(events);
  // Scope the queue + ghosts to the CURRENT build's workers (a re-run's stale holds
  // from a prior build are not this build's; the trace cursor already scopes events).
  const currentWorkers = new Set(org.workers.map((w) => w.workerId));
  const pendingForView = currentWorkers.size > 0
    ? state.pending.filter((p) => currentWorkers.has(p.agentId))
    : state.pending;
  renderOrgChart(org);
  renderQueue(buildReviewQueue({ pending: pendingForView }));
  renderRibbon(buildTraceRibbon(events));
  const model = buildWorldModel(state.snapshot, pendingForView, state.approved);
  renderWorldCounts(model);
  if (state.renderer && state.renderer.ready) {
    try { state.renderer.render(model); } catch (e) { /* render is UAT */ }
  }
}

// ---------------------------------------------------------------------------
// LEFT — agent org-chart.
// ---------------------------------------------------------------------------
function renderOrgChart(org) {
  const root = $("org-body");
  if (!root) return;
  root.innerHTML = "";
  if (!org.coordinator.id && org.workers.length === 0) {
    root.appendChild(el("div", "muted", state.client ? "press “Start the build” →" : "connect to begin"));
    return;
  }
  // Coordinator card.
  const coord = el("div", "agent-card coordinator");
  coord.appendChild(el("div", "agent-role", "Coordinator"));
  coord.appendChild(el("div", "agent-id", org.coordinator.id || "—"));
  coord.appendChild(el("div", "agent-goal", "“" + org.coordinator.goal + "”"));
  const cprofile = el("div", "chips");
  cprofile.appendChild(el("span", "chip chip-perm", "orchestrate"));
  cprofile.appendChild(el("span", "chip chip-perm", "approval.review"));
  coord.appendChild(cprofile);
  root.appendChild(coord);

  if (org.workers.length > 0) root.appendChild(el("div", "org-link", "delegates ↓"));

  const grid = el("div", "worker-grid");
  for (const w of org.workers) {
    const card = el("div", "agent-card worker status-" + w.status);
    const head = el("div", "worker-head");
    head.appendChild(el("span", "agent-role", w.role));
    head.appendChild(el("span", "status-pill status-" + w.status, w.label));
    card.appendChild(head);
    card.appendChild(el("div", "agent-id", w.workerId || "—"));
    if (w.task) card.appendChild(el("div", "agent-task", w.task));
    const chips = el("div", "chips");
    for (const b of w.bundle) chips.appendChild(el("span", "chip chip-bundle", b));
    card.appendChild(chips);
    grid.appendChild(card);
  }
  root.appendChild(grid);
}

// ---------------------------------------------------------------------------
// RIGHT — review queue.
// ---------------------------------------------------------------------------
function renderQueue(queue) {
  const root = $("queue-body");
  const badge = $("queue-count");
  if (badge) badge.textContent = String(queue.count);
  if (!root) return;
  root.innerHTML = "";
  if (queue.count === 0) {
    root.appendChild(el("div", "muted", state.built ? "nothing held — all edits resolved" : "no edits awaiting review"));
    return;
  }
  for (const card of queue.cards) {
    const c = el("div", "review-card kind-" + card.kind);
    const top = el("div", "review-top");
    top.appendChild(el("span", "review-skill", card.skill));
    top.appendChild(el("span", "chip chip-kind", card.kind));
    c.appendChild(top);
    c.appendChild(el("div", "review-by", `${card.workerId} · tick ${card.tick}`));
    c.appendChild(el("div", "review-label", card.label));
    const summary = el("div", "review-summary", card.summary || "");
    c.appendChild(summary);
    const actions = el("div", "review-actions");
    const approve = el("button", "btn btn-approve", "Approve");
    approve.onclick = () => void resolve(card, true);
    const reject = el("button", "btn btn-reject", "Reject");
    reject.onclick = () => void resolve(card, false);
    actions.appendChild(approve);
    actions.appendChild(reject);
    c.appendChild(actions);
    root.appendChild(c);
  }
}

async function resolve(card, grant) {
  const c = state.client;
  if (!c) return;
  const approvalId = card.approvalId;
  try {
    if (grant) {
      const r = await c.callTool("approval.grant", { approvalId });
      // Remember the typed placement so the snapshot entity it produces can be
      // joined BY POSITION and rendered with its real shape (cottage/tree), not a
      // generic cube — the snapshot itself carries only the position.
      if (Array.isArray(card.position) || card.kind === "ground") {
        state.approved.push({ kind: card.kind, position: card.position, shape: card.shape, size: card.size, color: card.color });
      }
      logLine(`approved ${short(approvalId)} — applied=${r.applied}`, r.applied ? "ok" : "warn");
    } else {
      const r = await c.callTool("approval.deny", { approvalId, reason: "rejected in review" });
      logLine(`rejected ${short(approvalId)} — resolved=${r.resolved}`, "warn");
    }
    await refreshAll();
  } catch (e) {
    logLine("resolve failed: " + msgOf(e), "err");
  }
}

// ---------------------------------------------------------------------------
// BOTTOM — trace ribbon.
// ---------------------------------------------------------------------------
function renderRibbon(ribbon) {
  const root = $("ribbon");
  if (!root) return;
  root.innerHTML = "";
  ribbon.phases.forEach((p, i) => {
    if (i > 0) root.appendChild(el("span", "ribbon-arrow", "→"));
    const node = el("div", "ribbon-phase" + (p.active ? " active" : "") + (p.key === ribbon.current ? " current" : ""));
    node.appendChild(el("span", "ribbon-label", p.label));
    node.appendChild(el("span", "ribbon-count", String(p.count)));
    root.appendChild(node);
  });
}

function renderWorldCounts(model) {
  const c = $("world-counts");
  if (!c) return;
  c.textContent = `${model.entities.length} entities · ${model.ghosts.length} held`;
}

// ---------------------------------------------------------------------------
// helpers + boot.
// ---------------------------------------------------------------------------
function msgOf(e) { return e && e.message ? e.message : String(e); }
function short(id) { return String(id).slice(0, 18) + "…"; }

async function boot() {
  // Wire controls.
  if ($("url")) $("url").value = URL_DEFAULT;
  $("connect")?.addEventListener("click", () => void connect());
  $("disconnect")?.addEventListener("click", () => { disconnect(); logLine("disconnected", "warn"); });
  $("build")?.addEventListener("click", () => void startBuild());
  $("interval")?.addEventListener("change", () => { if (state.client) startPolling(); });
  setBuildEnabled(false);

  // Stand up the world viewport (UAT — degrade gracefully without a GPU).
  const canvas = $("viewport");
  if (canvas) {
    try {
      state.renderer = new WorldRenderer(canvas);
      await state.renderer.init();
      window.addEventListener("resize", () => state.renderer?.resize());
      logLine("world viewport ready (WebGPU)", "ok");
    } catch (e) {
      logLine("world viewport unavailable (no WebGPU) — panels still live: " + msgOf(e), "warn");
      const note = $("viewport-fallback");
      if (note) note.style.display = "flex";
    }
  }

  logLine("ready — Connect, then “Start the build”. Run editor/server/editor_host.ts for the gate-enabled server.", "info");
}

window.addEventListener("DOMContentLoaded", () => void boot());
