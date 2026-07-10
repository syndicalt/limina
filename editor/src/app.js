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
import { buildForest, groupByActor, eventKind, isIntrospectionEvent } from "./reasoning.js";
import { createHistoryPanel } from "./history.js";
import { createOutlinerView, SnapshotPageLoader } from "./outliner.js";
import { editorSelection } from "./selection-store.js";
import { cueColorFor } from "./viewport.js";
import { CHAT_MODELS, CHAT_MODEL_CHANGE_EVENT, currentChatModel, setChatModel } from "./chat.js";
import { ingestTraceEvents } from "./trace-retention.js";
import { assertEditorAuthoringAllowed, playLifecycle } from "./play-lifecycle.js";
import { atlasEditorHandoff } from "./atlas-handoff-bootstrap.js";
export { MAX_TRACE_EVENTS, ingestTraceEvents } from "./trace-retention.js";

const $ = (id) => document.getElementById(id);
// renderApprovals owns #approval-body and replaces its children. Retain the static developer
// controls so every render can reattach the same nodes (and their listeners) instead of deleting
// them and leaving lifecycle subscribers with null lookups.
const proposeButton = $("propose");
const proposeMoveButton = $("propose-move");

const configuredServerInput = new URLSearchParams(location.search).get("server");
const configuredServer = configuredServerInput !== null
  && /^wss?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/$/.test(configuredServerInput)
  ? configuredServerInput : atlasEditorHandoff?.serverUrl ?? null;
if (configuredServer !== null) {
  $("url").value = configuredServer;
}
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const state = {
  /** @type {McpClient | undefined} */ client: undefined,
  /** @type {McpClient | undefined} */ agentClient: undefined,
  events: new Map(), // id -> event (accumulated trace, rendered into the console Trace tab)
  activity: [], // chronological authoring edits (worldlog) for the Activity panel
  afterSeq: -1,
  worldlogCursor: 0, // worldlog.tail cursor for the History + Activity (authoring-command) streams
  snapshot: undefined,
  entityIndex: new Map(),
  approvals: [],
  polling: undefined,
  log: [],
};

const snapshotLoader = new SnapshotPageLoader();
const outliner = createOutlinerView($("outliner-root"), editorSelection);

// Read-only History timeline backed by the tested EditorHistoryController. It ingests the
// authoring stream; scrubbing changes only the viewport replay prefix.
const history = createHistoryPanel({
  onLog: (m) => logLine(m, "ok"),
  // Playhead moved: tell the viewport to replay to that prefix (live=true → follow the newest).
  onScrub: ({ commands, live }) => {
    window.dispatchEvent(new CustomEvent("limina:scrub-to", { detail: { limit: live ? null : commands.length } }));
  },
});

// Structured entity lookup for the property inspector — the full record (transform, tags,
// physics.bodyId, resource, and origin = the create command with shape/size/material/color/
// static/dynamic) from the latest inspector.snapshot. take-control uses this to edit more than
// the transform. The paged snapshot loader keeps this index complete up to the hard cap.
window.liminaEntity = (id) => state.entityIndex.get(id);

function logLine(msg, kind = "info") {
  state.log.unshift({ t: new Date().toLocaleTimeString(), msg, kind });
  state.log = state.log.slice(0, 80);
  // Errors also surface as a toast (the console is hidden by default). Dedupe consecutive
  // identical errors so a repeating transient poll failure doesn't stack toasts.
  if (kind === "err" && msg !== state.lastErrToast) {
    state.lastErrToast = msg;
    window.dispatchEvent(new CustomEvent("limina:toast", { detail: { message: msg, kind: "error" } }));
  } else if (kind !== "err") {
    state.lastErrToast = undefined;
  }
  const box = $("log");
  box.innerHTML = "";
  for (const l of state.log) {
    const row = el("div", "log-row log-" + l.kind);
    row.appendChild(el("span", "log-time", l.t));
    row.appendChild(el("span", "log-msg", l.msg));
    box.appendChild(row);
  }
}

// `connected`: true | false, or the string "connecting" for the in-progress state.
function setStatus(connected) {
  const dot = $("status-dot");
  const txt = $("status-text");
  if (connected === "connecting") {
    dot.className = "dot dot-connecting";
    txt.textContent = "connecting…";
    return;
  }
  dot.className = "dot " + (connected ? "dot-on" : "dot-off");
  txt.textContent = connected ? "connected" : "disconnected";
}

// ---------------------------------------------------------------------------
// Connect / disconnect.
// ---------------------------------------------------------------------------
async function connect() {
  const url = $("url").value.trim();
  const profile = $("profile").value;
  const authToken = $("auth-token").value.trim() || undefined;
  disconnect();
  setStatus("connecting");
  const client = new McpClient(url, authToken);
  client.onConnectionChange = setStatus;
  client.onSync = () => {}; // live transforms cached; World panel re-renders on poll
  try {
    await client.connect();
    const sessionId = "ses_editor_" + Math.random().toString(36).slice(2, 8);
    await client.initialize("human_editor", sessionId, profile);
    try { await client.subscribe(); } catch { /* read-stream optional */ }
    state.client = client;
    // The skill catalog is STATIC — fetch its size ONCE (limit:0 skips the entity page) so
    // routine World polls can drop the full-catalog serialization from every snapshot.
    try {
      const cat = await client.callTool("inspector.snapshot", { limit: 0, includeResources: false, includeSkills: true });
      state.skillCount = cat?.skills?.length ?? 0;
    } catch { state.skillCount = 0; }
    logLine(`connected to ${url} as ${profile}`, "ok");
    startPolling();
    await refreshAll();
  } catch (e) {
    logLine("connect failed: " + (e && e.message ? e.message : String(e)), "err");
    setStatus(false);
  }
}

function disconnect() {
  snapshotLoader.cancel();
  stopPolling();
  if (state.client) { state.client.close(); state.client = undefined; }
  if (state.agentClient) { state.agentClient.close(); state.agentClient = undefined; }
  state.events.clear();
  snapshotTick = 0;
  state.afterSeq = -1;
  state.worldlogCursor = 0;
  state.snapshot = undefined;
  state.entityIndex = new Map();
  outliner.setEntities([]);
  history.reset();
  setStatus(false);
}

// SELF-SCHEDULING poll loop — the next poll is scheduled ms AFTER the previous one
// FINISHES, never on a fixed timer. A fixed setInterval fires regardless of whether the
// prior async refreshAll completed, so once a poll takes longer than the interval (a large
// trace.tail batch on a busy host) the polls OVERLAP and compound into a request flood that
// pegs the server on JSON.stringify and starves everything (chat included). Waiting for each
// poll self-throttles: the client can never outrun the server.
function startPolling() {
  const ms = Math.max(250, Number($("interval").value) || 1000);
  stopPolling();
  state.pollActive = true;
  const loop = async () => {
    if (!state.pollActive || !state.client) return;
    try { await refreshAll(); } finally {
      if (state.pollActive) state.pollTimer = setTimeout(() => { void loop(); }, ms);
    }
  };
  void loop();
  startApprovalBadgePoll();
}

function stopPolling() {
  state.pollActive = false;
  if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = undefined; }
  if (state.polling) { clearInterval(state.polling); state.polling = undefined; }
  stopApprovalBadgePoll();
}

// Approval BADGE poll — runs on a slow fixed cadence (10s) for as long as a client is connected,
// REGARDLESS of whether the Approval panel is open. refreshAll's fast poll only fetches
// approval.list while the panel is open (cheap-when-idle), which means a proposal that lands while
// the panel is collapsed was invisible until the user happened to open it. This loop keeps the
// header's count badge (#approval-count, already rendered in the collapsed accordion head) current
// so a new pending proposal is visible without opening the panel — the whole point of a badge.
const APPROVAL_BADGE_POLL_MS = 10_000;
function startApprovalBadgePoll() {
  stopApprovalBadgePoll();
  state.badgePollActive = true;
  const loop = async () => {
    if (!state.badgePollActive || !state.client) return;
    try {
      const list = await state.client.callTool("approval.list", {});
      state.approvals = (list && list.pending) || [];
      renderApprovals();
    } catch (e) {
      logLine("approval badge poll error: " + (e && e.message ? e.message : String(e)), "err");
    } finally {
      if (state.badgePollActive) state.badgePollTimer = setTimeout(() => { void loop(); }, APPROVAL_BADGE_POLL_MS);
    }
  };
  void loop();
}
function stopApprovalBadgePoll() {
  state.badgePollActive = false;
  if (state.badgePollTimer) { clearTimeout(state.badgePollTimer); state.badgePollTimer = undefined; }
}

// ---------------------------------------------------------------------------
// Poll: incremental trace.tail (cursor), approval.list, periodic snapshot.
// ---------------------------------------------------------------------------
let snapshotTick = 0;
// A panel is polled ONLY when it is open — a closed World/Reasoning/Approval/Team panel
// costs nothing. Its loading spinner shows only while that panel's own fetch is in flight.
const panelOpen = (id) => window.liminaWindows?.isOpen?.(id) ?? true;
function setSpin(id, on) { const el = $(id + "-spin"); if (el) el.hidden = !on; }
async function refreshAll() {
  const c = state.client;
  if (!c || state.refreshing) return; // in-flight guard: opening a panel can also trigger a refresh
  state.refreshing = true;
  try {
    // trace.tail feeds the Reasoning tree AND the Team roster (the causal/"why" stream). The
    // History timeline is fed separately from worldlog.tail below (the actual world EDITS).
    if (panelOpen("reasoning") || panelOpen("roster")) {
      const spins = ["reasoning", "roster"].filter(panelOpen);
      spins.forEach((id) => setSpin(id, true));
      try {
        const tail = await c.callTool("trace.tail", { afterSeq: state.afterSeq, limit: 120 });
        if (tail && Array.isArray(tail.events)) {
          ingestTraceEvents(state.events, tail.events);
          if (tail.nextAfterSeq !== null && tail.nextAfterSeq !== undefined) state.afterSeq = tail.nextAfterSeq;
        }
      } finally { spins.forEach((id) => setSpin(id, false)); }
    }
    // The AUTHORING command stream (worldlog.tail — the real world edits) drives BOTH the History
    // timeline (scrub time-travels the viewport) and the Activity feed. Poll when either is open;
    // always keep both fed so a just-opened panel is current (recordCommands dedups by seq).
    if (panelOpen("history") || panelOpen("reasoning")) {
      const spins = ["history", "reasoning"].filter(panelOpen);
      spins.forEach((id) => setSpin(id, true));
      try {
        const wl = await c.callTool("worldlog.tail", { since: state.worldlogCursor });
        if (wl && Array.isArray(wl.commands)) {
          if (wl.reset) { history.reset(); state.activity = []; state.worldlogCursor = 0; }
          history.recordCommands(wl.commands);
          ingestActivity(wl.commands);
          if (typeof wl.next === "number") state.worldlogCursor = wl.next;
        }
      } finally { spins.forEach((id) => setSpin(id, false)); }
    }
    // Approval queue only when its panel is open.
    if (panelOpen("approval")) {
      setSpin("approval", true);
      try {
        const list = await c.callTool("approval.list", {});
        state.approvals = (list && list.pending) || [];
      } finally { setSpin("approval", false); }
    }
    // World snapshot only when its panel is open, and less often (it's the heaviest read).
    if (panelOpen("world") && snapshotTick % 2 === 0) {
      setSpin("world", true);
      // Routine polls drop the two blocks that don't scale: the O(world) resource scan and
      // the static skill catalog (its size is cached once at connect as state.skillCount).
      // Live positions come from the delta stream (client.entityState), overlaid below.
      try {
        const snapshot = await snapshotLoader.load(c);
        if (snapshot !== undefined && state.client === c) {
          state.snapshot = snapshot;
          state.entityIndex = new Map(snapshot.entities.map((record) => [record.entity, record]));
          editorSelection.reconcile(new Set(state.entityIndex.keys()), "snapshot-delete");
        }
      }
      finally { setSpin("world", false); }
    }
    snapshotTick++;
    renderWorld();
    renderRoster();
    renderReasoning();
    renderConsoleTrace();
    renderApprovals();
  } catch (e) {
    logLine("poll error: " + (e && e.message ? e.message : String(e)), "err");
  } finally {
    state.refreshing = false;
  }
}

// Opening a panel fetches its data immediately (with the in-flight guard, this never
// overlaps the self-scheduled loop) so a just-opened panel shows its spinner + data at once
// instead of waiting up to a full poll interval.
window.addEventListener("limina:window-open", () => { if (state.client) void refreshAll(); });

// ---------------------------------------------------------------------------
// (a) WORLD panel.
// ---------------------------------------------------------------------------
function renderWorld() {
  const root = $("world-meta");
  root.innerHTML = "";
  const snap = state.snapshot;
  if (!snap) { outliner.setEntities([]); root.appendChild(el("div", "muted", "no snapshot yet")); return; }
  outliner.setEntities(snap.entities ?? []);

  const meta = el("div", "kv");
  meta.appendChild(kv("mode", snap.world?.mode ?? "?"));
  meta.appendChild(kv("entities", String(snap.page?.totalEntities ?? snap.entities?.length ?? 0)));
  meta.appendChild(kv("skills", String(snap.skills?.length || state.skillCount || 0)));
  meta.appendChild(kv("caller caps", (snap.permissions?.caller ?? []).join(", ") || "—"));
  root.appendChild(meta);

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
// (a2) TEAM roster — the coordinated builder team, made legible. A builder is any
// non-system actor that authored a skill (from the trace we already poll). Each row
// shows the builder's cue color (shared with the viewport via cueColorFor), its name,
// a human label for its last action, and a building/idle status derived from recency.
// ---------------------------------------------------------------------------
const SYSTEM_ACTORS = new Set(["editor_host", "viewport_follower", "human_editor", "human", "editor_writer"]);

// Map raw skill/tool names to friendly verbs — the UI never surfaces internal tool names.
const ROSTER_VERBS = {
  "scene.createEntity": "placed a shape",
  "asset.place": "placed an asset",
  "ecs.updateComponent": "moved an entity",
  "world.generateRegion": "shaped terrain",
  "scene.destroyEntity": "removed an entity",
  "three.setMaterial": "restyled a surface",
  "player.spawn": "spawned the player",
};
function rosterVerb(skill) { return ROSTER_VERBS[skill] || "editing"; }

// The Activity feed: chronological authoring edits (worldlog skill commands), attributed. Physics
// ops (kind:"physics") are engine-level and stay out of the author-facing feed. Bounded ring.
const MAX_ACTIVITY = 300;
function ingestActivity(commands) {
  if (!Array.isArray(commands)) return;
  for (const cmd of commands) {
    if (!cmd || cmd.kind !== "skill" || typeof cmd.tool !== "string") continue;
    state.activity.push({ tool: cmd.tool, actor: cmd.actorId || "agent" });
  }
  if (state.activity.length > MAX_ACTIVITY) state.activity.splice(0, state.activity.length - MAX_ACTIVITY);
}

// A builder is "building" if it authored something within the last few polls, else "idle".
const ROSTER_IDLE_POLLS = 3;
const rosterActivity = new Map(); // actorId -> { lastId, activeTick }
let rosterTick = 0;

function hexColor(value) {
  return "#" + (value >>> 0).toString(16).padStart(6, "0");
}

function rosterRow(actor, skill, building) {
  const row = el("div", "row roster-row");
  const swatch = el("span", "roster-swatch");
  swatch.style.background = hexColor(cueColorFor(actor));
  row.appendChild(swatch);
  row.appendChild(el("span", "roster-name mono", actor));
  row.appendChild(el("span", "roster-action dim", rosterVerb(skill)));
  // Status slot. Derived from activity for now. TODO(question-channel): there is no
  // editor-readable signal for a builder's question yet (that channel is the user's own
  // agent's subagent mechanism), so a "waiting on coordinator" state + read-only question
  // text would attach HERE once such a signal exists — do not fabricate one.
  const status = el("span", "roster-status " + (building ? "roster-status-building" : "roster-status-idle"));
  status.textContent = building ? "building" : "idle";
  row.appendChild(status);
  return row;
}

function renderRoster() {
  const root = $("roster-body");
  if (!root) return;
  rosterTick++;
  // Last authored skill per non-system builder (Map preserves insertion order → last write wins).
  const byActor = new Map();
  for (const ev of state.events.values()) {
    if (ev.type !== "skill.executed" || isIntrospectionEvent(ev)) continue;
    const skill = ev.payload?.skill;
    const actor = ev.actorId;
    if (!skill || !actor || SYSTEM_ACTORS.has(actor)) continue;
    byActor.set(actor, { skill, id: ev.id });
  }
  root.innerHTML = "";
  if (byActor.size === 0) {
    root.appendChild(el("div", "muted", "no builders active"));
    return;
  }
  const list = el("div", "list");
  for (const [actor, info] of [...byActor.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const prev = rosterActivity.get(actor);
    if (!prev || prev.lastId !== info.id) rosterActivity.set(actor, { lastId: info.id, activeTick: rosterTick });
    const building = rosterTick - rosterActivity.get(actor).activeTick <= ROSTER_IDLE_POLLS;
    list.appendChild(rosterRow(actor, info.skill, building));
  }
  root.appendChild(list);
}

// ---------------------------------------------------------------------------
// (b) ACTIVITY panel (#reason-body) — chronological WORLD EDITS, attributed (what the agents did
//     to the world). The raw causal TRACE is a developer view and now lives in the console's
//     Trace tab (renderConsoleTrace). Both "stick to bottom unless the user scrolled up".
// ---------------------------------------------------------------------------
function nearBottom(root) { return root.scrollHeight - root.scrollTop - root.clientHeight < 24; }

function renderReasoning() {
  const root = $("reason-body");
  if (!root) return;
  const stick = nearBottom(root);
  root.innerHTML = "";
  if (state.activity.length === 0) {
    root.appendChild(el("div", "muted", "no edits yet — the agents' changes to the world show up here"));
    return;
  }
  const list = el("div", "list");
  for (const a of state.activity) {
    const row = el("div", "row roster-row");
    const swatch = el("span", "roster-swatch");
    swatch.style.background = hexColor(cueColorFor(a.actor));
    row.appendChild(swatch);
    row.appendChild(el("span", "roster-name mono", a.actor));
    row.appendChild(el("span", "roster-action dim", rosterVerb(a.tool)));
    list.appendChild(row);
  }
  root.appendChild(list);
  if (stick) root.scrollTop = root.scrollHeight;
}

// The raw causal trace (developer view), rendered into the console's Trace tab.
function renderConsoleTrace() {
  const root = $("console-trace");
  if (!root) return;
  const stick = nearBottom(root);
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
  if (stick) root.scrollTop = root.scrollHeight;
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
// QC-render lightbox: click a small approval thumbnail to review it near-fullscreen. Click
// anywhere (without dragging) or press Esc to close. One shared overlay, lazily built.
//
// Task #66 (360° turntable): when the proposal carries qcTurntable (8 yaw-rotated frames from
// architect-run.mjs --turntable), the SAME lightbox becomes a turntable viewer — ←/→ and
// drag-to-rotate cycle through the frames, which are preloaded up front so cycling is instant.
let qcLightbox = null;
function ensureQcLightbox() {
  if (qcLightbox) return qcLightbox;
  qcLightbox = document.createElement("div");
  qcLightbox.style.cssText = "position:fixed;inset:0;z-index:100;display:none;align-items:center;justify-content:center;" +
    "background:rgba(0,0,0,.82);cursor:zoom-out";
  const big = document.createElement("img");
  big.style.cssText = "max-width:94vw;max-height:94vh;object-fit:contain;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,.8)";
  qcLightbox.appendChild(big);
  qcLightbox._img = big;
  qcLightbox._frames = null;
  qcLightbox._idx = 0;
  qcLightbox._dragged = false;
  qcLightbox.onclick = () => {
    // A drag ending over the overlay also fires a click — swallow that one so rotating the
    // turntable doesn't also close it. A plain click (no drag) closes, as before.
    if (qcLightbox._dragged) { qcLightbox._dragged = false; return; }
    qcLightbox.style.display = "none";
  };
  window.addEventListener("keydown", (e) => {
    if (qcLightbox.style.display === "none") return;
    if (e.key === "Escape") { qcLightbox.style.display = "none"; return; }
    if (!qcLightbox._frames) return;
    if (e.key === "ArrowRight") { e.preventDefault(); qcShowFrame(qcLightbox._idx + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); qcShowFrame(qcLightbox._idx - 1); }
  });
  // Drag-to-rotate: horizontal drag steps through frames like spinning a physical turntable.
  const DRAG_STEP_PX = 24;
  let dragging = false, dragStartX = 0, dragStartIdx = 0;
  big.addEventListener("pointerdown", (e) => {
    if (!qcLightbox._frames) return;
    dragging = true;
    qcLightbox._dragged = false;
    dragStartX = e.clientX;
    dragStartIdx = qcLightbox._idx;
    big.style.cursor = "grabbing";
    big.setPointerCapture(e.pointerId);
    e.stopPropagation();
  });
  big.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - dragStartX;
    if (Math.abs(dx) >= DRAG_STEP_PX) qcLightbox._dragged = true;
    qcShowFrame(dragStartIdx - Math.trunc(dx / DRAG_STEP_PX));
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    big.style.cursor = qcLightbox._frames ? "grab" : "";
    try { big.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  big.addEventListener("pointerup", endDrag);
  big.addEventListener("pointercancel", endDrag);
  document.body.appendChild(qcLightbox);
  return qcLightbox;
}

function qcShowFrame(idx) {
  const frames = qcLightbox?._frames;
  if (!frames || frames.length === 0) return;
  const n = ((idx % frames.length) + frames.length) % frames.length;
  qcLightbox._idx = n;
  qcLightbox._img.src = frames[n];
}

// `frames`, when a non-empty array of resolved image URLs, turns this open into a turntable
// (←/→ + drag cycle through them, preloaded so cycling never blocks on the network); otherwise
// this is the plain single-image lightbox it always was.
function openQcLightbox(startSrc, frames) {
  const box = ensureQcLightbox();
  if (Array.isArray(frames) && frames.length > 0) {
    for (const src of frames) { const preload = new Image(); preload.src = src; }
    box._frames = frames;
    box._img.style.cursor = "grab";
    qcShowFrame(0);
  } else {
    box._frames = null;
    box._img.style.cursor = "";
    box._img.src = startSrc;
  }
  box.style.display = "flex";
}

function renderApprovals() {
  const root = $("approval-body");
  root.innerHTML = "";
  if (proposeButton && proposeMoveButton) {
    const devActions = el("div", "acc-actions");
    devActions.append(proposeButton, proposeMoveButton);
    root.appendChild(devActions);
  }
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
    // Provenance: which model authored the asset. Model tier is a real quality signal for the
    // reviewer (a cheap-tier build warrants a harder look), so it sits in the card header.
    const inputForTag = a.input && typeof a.input === "object" ? a.input : {};
    if (typeof inputForTag.authoredBy === "string" && inputForTag.authoredBy.length > 0) {
      top.appendChild(el("span", "tag", "model: " + inputForTag.authoredBy));
    }
    card.appendChild(top);
    card.appendChild(el("div", "dim", `proposed by ${a.agentId} • tick ${a.tick}`));
    // Visual QC: when a proposal carries a QC render + automated pre-checks (an asset review
    // proposed under builder.review), SHOW the render + flag badges so the reviewer approves what
    // they can SEE, not just an input blob. `qcRender` is an /assets-relative path (e.g.
    // "qc/cottage-authored.png"); `qcChecks` flags the objective axes (theme is the human's call).
    const input = a.input && typeof a.input === "object" ? a.input : {};
    if (typeof input.qcRender === "string" && input.qcRender.length > 0) {
      // Task #66: a non-empty qcTurntable means this proposal has a full 360° set (architect-run
      // --turntable) — the thumbnail gets a ⟳ badge and the lightbox becomes a turntable viewer.
      const turntableFrames = Array.isArray(input.qcTurntable) && input.qcTurntable.length > 0
        ? input.qcTurntable.map((p) => "/assets/" + String(p).replace(/^\/+/, ""))
        : undefined;
      const wrap = el("div", null);
      wrap.style.cssText = "position:relative;margin:6px 0";
      const img = document.createElement("img");
      img.src = "/assets/" + input.qcRender.replace(/^\/+/, "");
      img.alt = "QC render";
      img.title = turntableFrames ? "click to enlarge — 360° turntable (←/→ or drag to rotate)" : "click to enlarge";
      img.style.cssText = "display:block;width:100%;max-height:260px;object-fit:contain;border:1px solid var(--line,#333);border-radius:6px;background:#0b0b0b;cursor:zoom-in";
      img.onclick = () => openQcLightbox(img.src, turntableFrames);
      wrap.appendChild(img);
      if (turntableFrames) {
        const badge = el("span", null, "⟳");
        badge.title = `${turntableFrames.length}-frame 360° turntable`;
        badge.style.cssText = "position:absolute;top:4px;right:4px;background:rgba(0,0,0,.7);color:#fff;" +
          "font-size:13px;line-height:1;padding:3px 5px;border-radius:10px;pointer-events:none";
        wrap.appendChild(badge);
      }
      card.appendChild(wrap);
    }
    if (input.qcChecks && typeof input.qcChecks === "object") {
      const row = el("div", "approval-qc-checks");
      row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin:4px 0";
      for (const [axis, val] of Object.entries(input.qcChecks)) {
        const pass = val === true, fail = val === false;
        const b = el("span", "tag", `${pass ? "✓" : fail ? "✗" : "?"} ${axis}`);
        b.style.cssText = `font-size:11px;padding:1px 6px;border-radius:4px;background:${pass ? "#14401f" : fail ? "#4a1616" : "#333"};color:${pass ? "#7fe39a" : fail ? "#ff9a9a" : "#bbb"}`;
        row.appendChild(b);
      }
      card.appendChild(row);
    }
    const pre = el("pre", "approval-input");
    pre.textContent = JSON.stringify(a.input, null, 2);
    card.appendChild(pre);
    const actions = el("div", "approval-actions");
    const approve = el("button", "btn btn-approve", "Approve");
    approve.disabled = playLifecycle.isAuthoringLocked();
    approve.onclick = () => resolve(a.approvalId, true);
    const reject = el("button", "btn btn-reject", "Reject");
    reject.disabled = playLifecycle.isAuthoringLocked();
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
    assertEditorAuthoringAllowed();
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
async function ensureAgentClient() {
  const url = $("url").value.trim();
  const authToken = $("auth-token").value.trim() || undefined;
  if (state.agentClient) return state.agentClient;
  const a = new McpClient(url, authToken);
  await a.connect();
  await a.initialize("agt_demo", "ses_demo_" + Math.random().toString(36).slice(2, 6), "builder.review");
  state.agentClient = a;
  return a;
}

async function proposeTestEdit() {
  try {
    assertEditorAuthoringAllowed();
    const agent = await ensureAgentClient();
    const pos = [Math.round((Math.random() * 8 - 4) * 10) / 10, 0.5, Math.round((Math.random() * 8 - 4) * 10) / 10];
    try {
      await agent.callTool("scene.createEntity", { position: pos, shape: "box", color: 0x44aaff });
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

function firstMovableEntity() {
  const entity = (state.snapshot?.entities ?? [])[0];
  if (entity?.entity) {
    const liveState = state.client?.entityState?.get(entity.entity);
    return { id: entity.entity, position: liveState?.pos ?? entity.transform?.position };
  }

  const rowId = $("outliner-root")?.querySelector(".outliner-row .mono")?.textContent?.trim();
  if (rowId && rowId.startsWith("ent_")) return { id: rowId, position: undefined };
  return undefined;
}

function movedPosition(position) {
  const hasPosition = Array.isArray(position) && position.length >= 3 && position.every((n) => Number.isFinite(n));
  if (!hasPosition) {
    return [Math.round((Math.random() * 8 - 4) * 10) / 10, 0.5, Math.round((Math.random() * 8 - 4) * 10) / 10];
  }
  const dx = Math.round((Math.random() * 1.5 - 0.75) * 10) / 10;
  const dz = Math.round((Math.random() * 1.5 - 0.75) * 10) / 10;
  return [
    Math.round((position[0] + dx) * 10) / 10,
    position[1],
    Math.round((position[2] + dz) * 10) / 10,
  ];
}

async function proposeAgentMove() {
  try {
    assertEditorAuthoringAllowed();
    const target = firstMovableEntity();
    if (!target) {
      logLine("no entity to move — click + test and approve one first", "warn");
      return;
    }

    const agent = await ensureAgentClient();
    const pos = movedPosition(target.position);
    try {
      await agent.callTool("ecs.updateComponent", { entity: target.id, component: "position", value: pos });
      logLine(`agent moved ${target.id} to [${pos.join(", ")}] directly — is the review gate enabled on the server?`, "warn");
    } catch (e) {
      if (e instanceof McpError && e.isPendingApproval) {
        logLine(`agent proposed ecs.updateComponent on ${target.id} — HELD (approvalId ${e.message.slice(0, 20)}…)`, "info");
      } else {
        throw e;
      }
    }
    await refreshAll();
  } catch (e) {
    logLine("propose move failed: " + (e && e.message ? e.message : String(e)), "err");
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
if (proposeButton) proposeButton.onclick = () => void proposeTestEdit();
if (proposeMoveButton) proposeMoveButton.onclick = () => void proposeAgentMove();
$("interval").onchange = () => { if (state.client) startPolling(); };
playLifecycle.subscribe(({ authoringLocked }) => {
  if (proposeButton) proposeButton.disabled = authoringLocked;
  if (proposeMoveButton) proposeMoveButton.disabled = authoringLocked;
  renderApprovals();
});

// ---------------------------------------------------------------------------
// Settings popover — shared model default (synced with the chat header picker), the
// builder-cues toggle (viewport reads it), and connection DEFAULTS that prefill the
// top-bar #url / #interval on load. The top-bar connect/token stay the live path.
// ---------------------------------------------------------------------------
const SETTINGS_CUES_KEY = "limina.editor.cues";
const SETTINGS_URL_KEY = "limina.editor.serverUrl";
const SETTINGS_INTERVAL_KEY = "limina.editor.pollInterval";
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage optional */ } };

function setupSettings() {
  const toggle = $("settings-toggle");
  const popover = $("settings-popover");
  if (!toggle || !popover) return;

  // Connection defaults prefill the top-bar inputs (which hold the live values).
  const urlInput = $("url");
  const intervalInput = $("interval");
  const storedUrl = lsGet(SETTINGS_URL_KEY);
  const storedInterval = lsGet(SETTINGS_INTERVAL_KEY);
  // An explicit launch URL is session configuration and must win over a stale saved default.
  if (configuredServer === null && storedUrl && urlInput) urlInput.value = storedUrl;
  if (storedInterval && intervalInput) intervalInput.value = storedInterval;

  const settingsUrl = $("settings-default-url");
  const settingsInterval = $("settings-default-interval");
  if (settingsUrl && urlInput) settingsUrl.value = urlInput.value;
  if (settingsInterval && intervalInput) settingsInterval.value = intervalInput.value;
  settingsUrl?.addEventListener("change", () => {
    const v = settingsUrl.value.trim();
    lsSet(SETTINGS_URL_KEY, v);
    if (urlInput) urlInput.value = v;
  });
  settingsInterval?.addEventListener("change", () => {
    const v = settingsInterval.value.trim();
    lsSet(SETTINGS_INTERVAL_KEY, v);
    if (intervalInput) { intervalInput.value = v; if (state.client) startPolling(); }
  });

  // Model default — shares state with the chat header picker via setChatModel + the change event.
  const modelSelect = $("settings-model");
  if (modelSelect) {
    modelSelect.innerHTML = "";
    for (const m of CHAT_MODELS) {
      const opt = el("option", null, `Claude · ${m.label}`);
      opt.value = m.value;
      opt.selected = m.value === currentChatModel();
      modelSelect.appendChild(opt);
    }
    modelSelect.addEventListener("change", () => {
      setChatModel(modelSelect.value);
      window.dispatchEvent(new CustomEvent(CHAT_MODEL_CHANGE_EVENT, { detail: { model: modelSelect.value } }));
    });
    window.addEventListener(CHAT_MODEL_CHANGE_EVENT, (e) => {
      const next = e.detail?.model;
      if (next && modelSelect.value !== next) modelSelect.value = next;
    });
  }

  // Builder cues toggle (default on ⇒ checked unless explicitly "off").
  const cues = $("settings-cues");
  if (cues) {
    cues.checked = lsGet(SETTINGS_CUES_KEY) !== "off";
    cues.addEventListener("change", () => lsSet(SETTINGS_CUES_KEY, cues.checked ? "on" : "off"));
  }

  // Open/close (mirrors the ☰ tools menu): gear toggles; a click elsewhere closes.
  toggle.addEventListener("click", (e) => { e.stopPropagation(); popover.hidden = !popover.hidden; });
  document.addEventListener("click", (e) => {
    if (!popover.hidden && !popover.contains(e.target) && e.target !== toggle) popover.hidden = true;
  });
}
setupSettings();

logLine("ready — set the server URL and Connect (run editor/server/editor_host.ts for the gate-enabled server)", "info");
