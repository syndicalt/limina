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
const CHAT_MODELS = [
  { label: "Haiku 4.5", value: DEFAULT_CHAT_MODEL },
  { label: "Sonnet 5", value: "claude-sonnet-5" },
  { label: "Opus 4.8", value: "claude-opus-4-8" },
];
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
};

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

function renderSteps(turn) {
  const details = el("details", "chat-steps");
  const summary = el("summary");
  summary.appendChild(el("span", null, `⚙ worked on this · ${turn.steps.length} steps`));
  details.appendChild(summary);
  const list = el("div", "chat-step-list");
  for (const step of turn.steps) {
    const chip = el("div", "chat-step-chip");
    chip.appendChild(el("span", "chat-step-icon", step.icon || "•"));
    chip.appendChild(el("span", null, step.label || "worked"));
    list.appendChild(chip);
  }
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

function setChatModel(model) {
  state.model = CHAT_MODEL_IDS.has(model) ? model : DEFAULT_CHAT_MODEL;
  try {
    localStorage.setItem(CHAT_MODEL_STORAGE_KEY, state.model);
  } catch {
    // Storage is optional; the in-memory selection is still authoritative for this session.
  }
}

async function sendChat({ text, attachments }) {
  const turnId = uid("turn");
  const message = { turnId, text, attachments, model: state.model };
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

function onChatMessage(msg) {
  if (!msg || !msg.type || !msg.turnId) return;
  const turn = getAgentTurn(msg.turnId);
  if (msg.type === "chat.delta") {
    turn.text += String(msg.text || "");
    turn.streaming = true;
  } else if (msg.type === "chat.step") {
    turn.steps.push({ icon: msg.icon || "•", label: msg.label || "worked" });
  } else if (msg.type === "chat.done") {
    turn.streaming = false;
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
  composer.append(fileInput, attach, input, model, send);
  shell.append(log, attachments, composer, el("div", "chat-drop-overlay", "Drop files to attach"));
  chatBody.appendChild(shell);

  attach.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    void addFiles(fileInput.files || []);
    fileInput.value = "";
  });
  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    submitComposer();
  });
  model.addEventListener("change", () => setChatModel(model.value));
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
