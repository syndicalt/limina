// Phase 1 chat UI slice. The transport is intentionally pluggable: the server slice replaces only
// state.chatTransport with the real WebSocket channel and keeps the DOM/rendering contract intact.

import { McpClient } from "./mcp-client.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const chatPanel = $("chat");
const chatBody = $("chat-body");
const CHAT_MODEL_STORAGE_KEY = "limina.chat.model";
const DEFAULT_CHAT_MODEL = "claude-haiku-4-5-20251001";
export const CHAT_MODELS = [
  { label: "Haiku 4.5", value: DEFAULT_CHAT_MODEL },
  { label: "Sonnet 5", value: "claude-sonnet-5" },
  { label: "Opus 4.8", value: "claude-opus-4-8" },
];
// Fired whenever the built-in agent's model changes from EITHER picker (chat header or Settings),
// so the other picker stays in sync — both are views of the same localStorage["limina.chat.model"].
export const CHAT_MODEL_CHANGE_EVENT = "limina:chat-model-change";
const CHAT_MODEL_IDS = new Set(CHAT_MODELS.map((model) => model.value));

function storedChatModel() {
  try {
    const value = localStorage.getItem(CHAT_MODEL_STORAGE_KEY);
    return CHAT_MODEL_IDS.has(value) ? value : DEFAULT_CHAT_MODEL;
  } catch {
    return DEFAULT_CHAT_MODEL;
  }
}

const state = {
  turns: new Map(),
  attachments: [],
  turnSeq: 0,
  activeDrag: 0,
  model: storedChatModel(),
  chatTransport: undefined,
  /** Surface-awareness hook: setChatContextProvider installs the studio's
   *  context packer; every chat turn carries the CURRENT pack block. */
  contextProvider: undefined,
  /** Suggestion apply hook: app.js installs the reviewer-profiled tool caller. */
  applySuggestion: undefined,
};

export function setChatContextProvider(fn) {
  state.contextProvider = typeof fn === "function" ? fn : undefined;
}

export function setChatApplySuggestion(fn) {
  state.applySuggestion = typeof fn === "function" ? fn : undefined;
}

function inputTarget(target) {
  return !!target?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHref(value) {
  const raw = String(value || "").trim();
  if (/^(https?:|mailto:|\/|#)/i.test(raw)) return escapeHtml(raw);
  return "#";
}

function renderInlineMarkdown(text) {
  const code = [];
  let html = escapeHtml(text).replace(/`([^`\n]+)`/g, (_, body) => {
    code.push(`<code>${body}</code>`);
    return `\u0000CODE${code.length - 1}\u0000`;
  });
  html = html.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    return `<a href="${safeHref(href)}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  html = html
    .replace(/\*\*([^*\n][\s\S]*?[^*\n])\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n][^*\n]*?)\*/g, "<em>$1</em>");
  return html.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => code[Number(i)] || "");
}

function renderMarkdown(text) {
  const blocks = String(text || "").split(/(```[\s\S]*?```)/g);
  const out = [];
  for (const block of blocks) {
    if (!block) continue;
    if (block.startsWith("```") && block.endsWith("```")) {
      const body = block.slice(3, -3).replace(/^\w+\n/, "");
      out.push(`<pre><code>${escapeHtml(body)}</code></pre>`);
      continue;
    }
    const lines = block.split(/\n/);
    let list = [];
    const flushList = () => {
      if (!list.length) return;
      out.push(`<ul>${list.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`);
      list = [];
    };
    for (const line of lines) {
      const item = line.match(/^\s*-\s+(.+)$/);
      if (item) {
        list.push(item[1]);
      } else if (line.trim()) {
        flushList();
        out.push(`<p>${renderInlineMarkdown(line)}</p>`);
      } else {
        flushList();
      }
    }
    flushList();
  }
  return out.join("");
}

function uid(prefix) {
  state.turnSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${state.turnSeq.toString(36)}`;
}

function scrollToEnd() {
  const log = $("chat-log");
  if (log) log.scrollTop = log.scrollHeight;
}

function focusComposer() {
  const input = $("chat-input");
  if (input) input.focus({ preventScroll: true });
}

function openAndFocusChat() {
  if (window.liminaWindows?.open) window.liminaWindows.open("chat");
  else if (chatPanel) chatPanel.hidden = false;
  requestAnimationFrame(focusComposer);
}

function makeTurn(kind, turnId, text, attachments) {
  const turn = {
    kind,
    turnId,
    text: text || "",
    attachments: attachments || [],
    steps: [],
    streaming: kind === "agent",
    error: "",
  };
  state.turns.set(turnId, turn);
  renderTurn(turn);
  return turn;
}

function getAgentTurn(turnId) {
  let turn = state.turns.get(turnId);
  if (!turn) turn = makeTurn("agent", turnId, "", []);
  return turn;
}

function renderAttachmentChip(attachment, removable, index) {
  const chip = el("div", "chat-attachment-chip");
  if (attachment.kind === "image" && attachment.dataUrl) {
    const img = el("img");
    img.src = attachment.dataUrl;
    img.alt = "";
    chip.appendChild(img);
  }
  chip.appendChild(el("span", null, attachment.name || (attachment.kind === "image" ? "image" : "file")));
  if (removable) {
    const remove = el("button", "chat-chip-remove", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", "Remove attachment");
    remove.addEventListener("click", () => {
      state.attachments.splice(index, 1);
      renderPendingAttachments();
    });
    chip.appendChild(remove);
  }
  return chip;
}

function renderTurn(turn) {
  const log = $("chat-log");
  if (!log) return;
  let row = $(`chat-turn-${turn.turnId}`);
  if (!row) {
    $("chat-log")?.querySelector(".chat-empty")?.remove();
    row = el("div", `chat-turn chat-turn-${turn.kind}`);
    row.id = `chat-turn-${turn.turnId}`;
    log.appendChild(row);
  }
  row.classList.toggle("chat-turn-error", !!turn.error);
  row.innerHTML = "";
  const bubble = el("div", "chat-bubble");
  if (turn.kind === "agent") {
    bubble.appendChild(renderSteps(turn));
    const text = el("div", "chat-markdown");
    text.innerHTML = renderMarkdown(turn.text);
    if (turn.streaming) text.appendChild(el("span", "chat-caret"));
    bubble.appendChild(text);
    if (turn.error) bubble.appendChild(el("div", "chat-error", turn.error));
  } else {
    if (turn.attachments.length) {
      const chips = el("div", "chat-sent-attachments");
      turn.attachments.forEach((item) => chips.appendChild(renderAttachmentChip(item, false)));
      bubble.appendChild(chips);
    }
    bubble.appendChild(el("div", "chat-user-text", turn.text));
  }
  row.appendChild(bubble);
  scrollToEnd();
}

// Step-state glyphs: ok ✓ / failed ✕ / held ⏸ / rejected ⊘; a pending step (no
// status yet) keeps its neutral icon. The contract under test in
// editor/test/chat_step_state.test.mjs.
const STEP_STATUS_GLYPHS = { ok: "✓", failed: "✕", held: "⏸", rejected: "⊘" };

function openApprovalPanel() {
  const head = document.querySelector('[data-acc-toggle="approval"]');
  if (head && head.getAttribute("aria-expanded") !== "true") head.click();
  const panel = document.getElementById("approval");
  if (panel && panel.scrollIntoView) panel.scrollIntoView({ block: "nearest" });
}

function renderStepChip(step) {
  if (step.tool === "gds.plan" && step.status === "ok" && step.result) return renderPlanCard(step.result);
  const chip = el("div", "chat-step-chip" + (step.status ? ` chat-step-${step.status}` : ""));
  chip.appendChild(el("span", "chat-step-icon", STEP_STATUS_GLYPHS[step.status] || step.icon || "•"));
  chip.appendChild(el("span", "chat-step-tool", step.tool || step.label || "worked"));
  if (step.detail) chip.appendChild(el("span", "chat-step-detail", step.detail));
  if (step.status === "held") {
    const link = el("button", "chat-step-approval-link", "Review in Approval");
    link.type = "button";
    link.addEventListener("click", openApprovalPanel);
    chip.appendChild(link);
  }
  return chip;
}

// A gds.plan success renders as a structured plan card (slices, mechanic→skill
// mapping chips colored by status, gaps) instead of a JSON blob. Contract under
// test in editor/test/chat_plan_card.test.mjs.
function renderPlanCard(result) {
  const card = el("div", "chat-plan-card");
  const plan = result.plan;
  card.appendChild(el("div", "chat-plan-title", plan ? `Plan · ${plan.gdsId}` : "Plan"));
  if (plan && Array.isArray(plan.slices)) {
    const slices = el("div", "chat-plan-slices");
    for (const slice of plan.slices) {
      const row = el("div", "chat-plan-slice");
      row.appendChild(el("span", "chat-plan-slice-name", slice.name));
      row.appendChild(el("span", "chat-plan-slice-goal", slice.goal));
      const dods = Array.isArray(slice.dodIds) ? slice.dodIds.length : 0;
      row.appendChild(el("span", "chat-plan-slice-dods", dods ? `${dods} DoD${dods === 1 ? "" : "s"}` : "not auto-gated"));
      slices.appendChild(row);
    }
    card.appendChild(slices);
  }
  if (plan && Array.isArray(plan.systems) && plan.systems.length) {
    const mappings = el("div", "chat-plan-mappings");
    for (const m of plan.systems) {
      const chip = el("span", `chat-plan-mapping chat-plan-mapping-${m.status}`, `${m.mechanicName} → ${m.skill}`);
      chip.title = m.status;
      mappings.appendChild(chip);
    }
    card.appendChild(mappings);
  }
  if (Array.isArray(result.gaps) && result.gaps.length) {
    const gaps = el("div", "chat-plan-gaps");
    gaps.appendChild(el("span", "chat-plan-gaps-label", "Gaps"));
    for (const gap of result.gaps) gaps.appendChild(el("span", "chat-plan-gap", gap));
    card.appendChild(gaps);
  }
  if (Array.isArray(result.issues) && result.issues.length) {
    const issues = el("div", "chat-plan-issues");
    for (const issue of result.issues) issues.appendChild(el("div", "chat-plan-issue", `${issue.path || "(root)"}: ${issue.message}`));
    card.appendChild(issues);
  }
  if (Array.isArray(result.newWork) && result.newWork.length) {
    const work = el("div", "chat-plan-newwork");
    work.appendChild(el("span", "chat-plan-newwork-label", "New work"));
    for (const item of result.newWork) work.appendChild(el("span", "chat-plan-newwork-item", item));
    card.appendChild(work);
  }
  return card;
}

function renderSteps(turn) {
  const details = el("details", "chat-steps");
  const summary = el("summary");
  const failed = turn.steps.filter((s) => s.status === "failed" || s.status === "rejected").length;
  const held = turn.steps.filter((s) => s.status === "held").length;
  let head = `⚙ worked on this · ${turn.steps.length} steps`;
  if (failed) head += ` · ${failed} failed`;
  if (held) head += ` · ${held} held`;
  summary.appendChild(el("span", null, head));
  details.appendChild(summary);
  // A failed/held call must never hide behind a collapsed accordion.
  if (failed || held) details.open = true;
  const list = el("div", "chat-step-list");
  for (const step of turn.steps) list.appendChild(renderStepChip(step));
  details.appendChild(list);
  return details;
}

function renderPendingAttachments() {
  const box = $("chat-attachments");
  if (!box) return;
  box.innerHTML = "";
  box.hidden = state.attachments.length === 0;
  state.attachments.forEach((item, index) => box.appendChild(renderAttachmentChip(item, true, index)));
}

function setDragActive(active) {
  if (!chatPanel) return;
  chatPanel.classList.toggle("chat-dragging", active);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("failed to read file"));
    reader.readAsDataURL(file);
  });
}

function imageFilesFromClipboard(data) {
  const out = [...(data?.files || [])].filter((file) => file.type.startsWith("image/"));
  if (out.length) return out;
  for (const item of data?.items || []) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) out.push(file);
    }
  }
  return out;
}

async function addFiles(files) {
  for (const file of files) {
    if (file.type.startsWith("image/")) {
      const dataUrl = await readFileAsDataUrl(file);
      state.attachments.push({ kind: "image", name: file.name || "pasted image", type: file.type, size: file.size, dataUrl });
    } else {
      state.attachments.push({ kind: "file", name: file.name, type: file.type || "application/octet-stream", size: file.size });
    }
  }
  renderPendingAttachments();
}

function composerText() {
  const input = $("chat-input");
  return input ? input.value.trim() : "";
}

function clearComposer() {
  const input = $("chat-input");
  if (input) input.value = "";
  state.attachments = [];
  renderPendingAttachments();
}

export function setChatModel(model) {
  state.model = CHAT_MODEL_IDS.has(model) ? model : DEFAULT_CHAT_MODEL;
  try {
    localStorage.setItem(CHAT_MODEL_STORAGE_KEY, state.model);
  } catch {
    // Storage is optional; the in-memory selection is still authoritative for this session.
  }
}

/** The built-in agent's current model (shared by the chat header + Settings pickers). */
export function currentChatModel() {
  return state.model;
}

// Broadcast a model change so the OTHER picker updates. Called by whichever picker the user touched.
function broadcastChatModel(model) {
  setChatModel(model);
  window.dispatchEvent(new CustomEvent(CHAT_MODEL_CHANGE_EVENT, { detail: { model: state.model } }));
}

async function sendChat({ text, attachments }) {
  const turnId = uid("turn");
  const message = { turnId, text, attachments, model: state.model };
  if (typeof state.contextProvider === "function") {
    try {
      message.context = state.contextProvider();
    } catch { /* a broken pack must never block a turn */ }
  }
  makeTurn("user", `${turnId}_user`, text, attachments);
  makeTurn("agent", turnId, "", []);
  await state.chatTransport.send(message);
}

function submitComposer() {
  const text = composerText();
  if (!text && state.attachments.length === 0) return;
  const attachments = state.attachments.map((item) => ({ ...item }));
  clearComposer();
  sendChat({ text, attachments });
}

// ── Ambient notes + agent suggestion cards (fluid agents) ────────────────────
// Ambient: quiet timeline dividers for studio events (saves, switches) so the
// conversation reflects the shared process without an LLM call.
export function noteAmbient(text) {
  const log = $("chat-log");
  if (!log) return;
  $("chat-log")?.querySelector(".chat-empty")?.remove();
  const row = el("div", "chat-ambient", text);
  log.appendChild(row);
  scrollToEnd();
}

// Suggestion cards: traced studio.suggestion events rendered inline with the
// conversation. Apply routes the action through the host-installed caller
// (recorded, policy-gated); Dismiss drops the card.
import { studioBus, STUDIO_EVENTS } from "./agents/studio-events.js";

export function renderSuggestionCard(suggestion) {
  const log = $("chat-log");
  if (!log || suggestion === null || typeof suggestion !== "object") return;
  $("chat-log")?.querySelector(".chat-empty")?.remove();
  const card = el("div", "suggestion-card");
  const head = el("div", "suggestion-title", `◈ ${suggestion.title ?? "suggestion"}`);
  card.appendChild(head);
  if (suggestion.detail) card.appendChild(el("div", "suggestion-detail", suggestion.detail));
  if (suggestion.region) {
    card.appendChild(el("div", "suggestion-meta", "highlighted on the Atlas"));
    studioBus.emit(STUDIO_EVENTS.AGENT_SUGGESTION, { payload: suggestion });
  }
  const actions = el("div", "suggestion-actions");
  if (suggestion.action && typeof state.applySuggestion === "function") {
    const apply = el("button", "btn btn-small suggestion-apply", suggestion.action.label ?? "Apply");
    apply.type = "button";
    apply.onclick = () => {
      apply.disabled = true;
      apply.textContent = "Applying…";
      Promise.resolve(state.applySuggestion(suggestion.action))
        .then(() => { apply.textContent = "Applied ✓"; })
        .catch((error) => {
          apply.disabled = false;
          apply.textContent = suggestion.action.label ?? "Apply";
          noteAmbient(`apply failed: ${error instanceof Error ? error.message : error}`);
        });
    };
    actions.appendChild(apply);
  }
  const dismiss = el("button", "btn btn-small btn-ghost", "Dismiss");
  dismiss.type = "button";
  dismiss.onclick = () => card.remove();
  actions.appendChild(dismiss);
  card.appendChild(actions);
  log.appendChild(card);
  scrollToEnd();
}

function onChatMessage(msg) {
  if (!msg || !msg.type || !msg.turnId) return;
  const turn = getAgentTurn(msg.turnId);
  if (msg.type === "chat.delta") {
    turn.text += String(msg.text || "");
    turn.streaming = true;
  } else if (msg.type === "chat.step") {
    const step = {
      icon: msg.icon || "•",
      label: msg.label || msg.tool || "worked",
      tool: msg.tool || "",
      status: msg.status,
      detail: msg.detail,
      result: msg.result,
    };
    if (msg.status) {
      // A completion step upgrades the matching pending chip in place (the server
      // pushes one step before the invoke and one after with the outcome).
      const pending = [...turn.steps].reverse().find((s) => s.tool === step.tool && !s.status);
      if (pending) Object.assign(pending, { status: step.status, detail: step.detail, result: step.result });
      else turn.steps.push(step);
      // A completed studio.suggest renders its card inline (the suggestion IS
      // the result payload; no extra polling needed).
      if (step.tool === "studio.suggest" && step.status === "ok" && step.result?.suggestion !== undefined) {
        renderSuggestionCard(step.result.suggestion);
      }
    } else {
      turn.steps.push(step);
    }
  } else if (msg.type === "chat.done") {
    turn.streaming = false;
    // A bound-cut turn with no reply must say so, never read as silence.
    if (msg.reason && !turn.text) turn.error = `The agent stopped without a reply (${msg.reason}).`;
  } else if (msg.type === "chat.error") {
    turn.streaming = false;
    turn.error = msg.message || "chat failed";
  }
  renderTurn(turn);
}

const fieldValue = (id) => {
  const field = $(id);
  return field && field.value ? field.value.trim() : "";
};

function clientIsOpen(client) {
  const openState = globalThis.WebSocket?.OPEN ?? 1;
  return client?.ws?.readyState === openState;
}

function chatError(turnId, message) {
  onChatMessage({ type: "chat.error", turnId, message });
}

function resultErrorMessage(result) {
  if (!result) return "chat/send failed";
  if (typeof result.error === "string") return result.error;
  if (result.error?.message) return result.error.message;
  if (typeof result.message === "string") return result.message;
  return "chat/send failed";
}

function createLiveChatTransport(offlineTransport) {
  const live = {
    client: undefined,
    connecting: undefined,
  };

  async function ensureClient() {
    if (clientIsOpen(live.client)) return live.client;
    live.client = undefined;
    if (live.connecting) return live.connecting;
    live.connecting = (async () => {
      const url = fieldValue("url");
      const authToken = fieldValue("auth-token") || undefined;
      if (!url) return undefined;

      const client = new McpClient(url, authToken);
      try {
        await client.connect();
        await client.initialize(
          "editor_chat",
          "ses_chat_" + Math.random().toString(36).slice(2, 8),
          "system.readonly",
          authToken,
        );
        client.onChat(onChatMessage);
        live.client = client;
        return client;
      } catch (e) {
        try { client.close(); } catch { /* ignore */ }
        throw e;
      } finally {
        live.connecting = undefined;
      }
    })();
    return live.connecting;
  }

  return {
    async send(msg) {
      let client;
      try {
        client = await ensureClient();
      } catch (e) {
        chatError(msg.turnId, `Could not connect to editor_host: ${e?.message || e}`);
        offlineTransport.send(msg);
        return;
      }

      if (!client) {
        offlineTransport.send(msg);
        return;
      }

      let response;
      try {
        response = await client._request("chat/send", {
          turnId: msg.turnId,
          text: msg.text,
          attachments: msg.attachments,
          model: msg.model,
          ...(msg.context !== undefined ? { context: msg.context } : {}),
        });
      } catch (e) {
        chatError(msg.turnId, `chat/send failed: ${e?.message || e}`);
        offlineTransport.send(msg);
        return;
      }

      if (response?.error) {
        chatError(msg.turnId, response.error.message || "chat/send failed");
        return;
      }

      const result = response?.result || response;
      if (result?.ok === false) {
        chatError(msg.turnId, resultErrorMessage(result));
      }
    },
  };
}

function createEchoTransport() {
  return {
    send(msg) {
      // Offline fallback — used only when no editor_host connection.
      const chunks = [
        "I can work with that. ",
        "Here is a **streamed** markdown reply with `inline code`, ",
        "a [local editor link](#viewport), and a short list:\n- inspect the current intent\n- stage the next UI slice\n",
        "```js\nstate.chatTransport = realWebSocketTransport;\n```\n",
      ];
      const timers = [
        () => onChatMessage({ type: "chat.step", turnId: msg.turnId, icon: "🔎", label: "read editor context" }),
        () => onChatMessage({ type: "chat.step", turnId: msg.turnId, icon: "🧪", label: "prepared standalone echo run" }),
        ...chunks.map((text) => () => onChatMessage({ type: "chat.delta", turnId: msg.turnId, text })),
        () => onChatMessage({ type: "chat.done", turnId: msg.turnId }),
      ];
      timers.forEach((fn, index) => setTimeout(fn, 180 + index * 260));
    },
  };
}

function buildChat() {
  if (!chatBody) return;
  chatBody.innerHTML = "";
  const shell = el("div", "chat-shell");
  const log = el("div", "chat-log");
  log.id = "chat-log";
  const empty = el("div", "chat-empty");
  empty.textContent = "Describe what to build.";
  log.appendChild(empty);
  const attachments = el("div", "chat-attachments");
  attachments.id = "chat-attachments";
  attachments.hidden = true;
  const composer = el("form", "chat-composer");
  const fileInput = el("input");
  fileInput.id = "chat-file";
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.hidden = true;
  const attach = el("button", "chat-icon-btn", "+");
  attach.type = "button";
  attach.title = "Attach";
  attach.setAttribute("aria-label", "Attach files");
  const input = el("textarea", "chat-input");
  input.id = "chat-input";
  input.rows = 1;
  input.placeholder = "Describe what to build…";
  const model = el("select", "chat-model-select");
  model.id = "chat-model";
  model.title = "Model";
  model.setAttribute("aria-label", "Chat model");
  for (const optionModel of CHAT_MODELS) {
    const option = el("option", null, optionModel.label);
    option.value = optionModel.value;
    option.selected = optionModel.value === state.model;
    model.appendChild(option);
  }
  const send = el("button", "btn chat-send", "Send");
  send.type = "submit";
  composer.append(fileInput, attach, input, send);
  shell.append(log, attachments, composer, el("div", "chat-drop-overlay", "Drop files to attach"));
  chatBody.appendChild(shell);

  // The model select lives in the panel HEADER (right side, before the close
  // button) so it never crowds the composer.
  const chatHead = chatPanel?.querySelector(".panel-head");
  if (chatHead) {
    model.style.marginLeft = "auto";
    const closeBtn = chatHead.querySelector(".win-close");
    if (closeBtn) chatHead.insertBefore(model, closeBtn);
    else chatHead.appendChild(model);
  }

  attach.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    void addFiles(fileInput.files || []);
    fileInput.value = "";
  });
  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    submitComposer();
  });
  model.addEventListener("change", () => broadcastChatModel(model.value));
  // Keep the header picker in sync when the model is changed from Settings.
  window.addEventListener(CHAT_MODEL_CHANGE_EVENT, (e) => {
    const next = e.detail?.model;
    if (next && model.value !== next) model.value = next;
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitComposer();
    }
  });
}

function installGlobalHandlers() {
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !inputTarget(e.target)) {
      e.preventDefault();
      openAndFocusChat();
    }
  });
  document.addEventListener("paste", (e) => {
    if (chatPanel?.hidden || !chatPanel?.contains(document.activeElement)) return;
    const files = imageFilesFromClipboard(e.clipboardData);
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  });
  for (const type of ["dragenter", "dragover"]) {
    chatPanel?.addEventListener(type, (e) => {
      e.preventDefault();
      state.activeDrag += type === "dragenter" ? 1 : 0;
      setDragActive(true);
    });
  }
  for (const type of ["dragleave", "drop"]) {
    chatPanel?.addEventListener(type, (e) => {
      e.preventDefault();
      if (type === "drop") {
        state.activeDrag = 0;
        void addFiles(e.dataTransfer?.files || []);
      } else {
        state.activeDrag = Math.max(0, state.activeDrag - 1);
      }
      setDragActive(state.activeDrag > 0);
    });
  }
  chatPanel?.addEventListener("limina:window-open", focusComposer);
}

state.chatTransport = createLiveChatTransport(createEchoTransport());
window.liminaChat = { state, sendChat, onChatMessage, focus: openAndFocusChat };
buildChat();
installGlobalHandlers();
