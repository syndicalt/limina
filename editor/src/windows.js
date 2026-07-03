// Docked editor chrome: a LEFT accordion sidebar (World / History / Activity / Team / Approval), a
// RIGHT chat sidebar, and a FLOATING Inspector — replacing the old ☰ menu + scattered floating
// windows. Keeps window.liminaWindows { open, close, isOpen } so every existing caller is unchanged:
// a LEFT id maps to its accordion section (open = expanded AND the sidebar not collapsed), "chat"
// maps to the right sidebar, "inspector" stays a floating window. Framework-free; shares only the DOM
// with app.js/viewport.js (they still fill the bodies). Opening a panel re-fires "limina:window-open"
// (app.js refreshes, chat focuses its composer); collapsing a sidebar fires "limina:layout-changed"
// (viewport.js re-fits the canvas).

const $ = (id) => document.getElementById(id);
const leftSidebar = $("sidebar-left");
const rightSidebar = $("sidebar-right");
const stage = document.querySelector(".stage");

// Left accordion section ids (the World panel is the primary one, open by default in the markup).
const LEFT_SECTIONS = new Set(["world", "history", "reasoning", "roster", "approval"]);

const isCollapsed = (side) => !!side && side.classList.contains("collapsed");
const sectionOf = (id) => $(id);
const sectionOpen = (id) => { const s = sectionOf(id); return !!s && s.classList.contains("acc-open"); };

// "A panel just opened" — app.js refreshes it, chat focuses its composer.
function announceOpen(el, id) {
  if (el) el.dispatchEvent(new CustomEvent("limina:window-open", { bubbles: true, detail: { id } }));
}
// "The layout changed the viewport's size" (a sidebar collapsed/expanded) — viewport.js re-fits.
function announceLayoutChange() {
  window.dispatchEvent(new CustomEvent("limina:layout-changed"));
}

function setSectionOpen(id, open) {
  const s = sectionOf(id);
  if (!s) return;
  s.classList.toggle("acc-open", open);
  const head = s.querySelector(".acc-head");
  if (head) head.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) announceOpen(s, id);
}

function setSidebarCollapsed(side, collapsed) {
  if (!side) return;
  side.classList.toggle("collapsed", collapsed);
  const toggle = side.querySelector(".sidebar-toggle");
  if (toggle) {
    const left = side === leftSidebar;
    toggle.textContent = collapsed ? (left ? "›" : "‹") : (left ? "‹" : "›");
    toggle.title = collapsed ? "Show panel" : "Collapse panel";
  }
  announceLayoutChange();
}

// ── window.liminaWindows: the unchanged open/close/isOpen contract over the new chrome ────────
function openInspector() {
  const w = $("inspector");
  if (!w) return;
  if (!w.dataset.placed) {
    const s = stage?.getBoundingClientRect();
    // Default: upper area of the stage, inset from the right chat sidebar.
    w.style.left = Math.max(16, (s ? s.width : 900) - 400) + "px";
    w.style.top = "58px";
    w.dataset.placed = "1";
  }
  w.hidden = false;
  w.style.zIndex = String(++zTop);
  announceOpen(w, "inspector");
}
function open(id) {
  if (id === "inspector") { openInspector(); return; }
  if (id === "chat") { if (isCollapsed(rightSidebar)) setSidebarCollapsed(rightSidebar, false); announceOpen($("chat"), "chat"); return; }
  if (LEFT_SECTIONS.has(id)) {
    if (isCollapsed(leftSidebar)) setSidebarCollapsed(leftSidebar, false);
    setSectionOpen(id, true);
  }
}
function close(id) {
  if (id === "inspector") { const w = $("inspector"); if (w) w.hidden = true; return; }
  if (id === "chat") { setSidebarCollapsed(rightSidebar, true); return; }
  if (LEFT_SECTIONS.has(id)) setSectionOpen(id, false);
}
function isOpen(id) {
  if (id === "inspector") { const w = $("inspector"); return !!w && !w.hidden; }
  if (id === "chat") return !isCollapsed(rightSidebar);
  if (LEFT_SECTIONS.has(id)) return sectionOpen(id) && !isCollapsed(leftSidebar);
  return false;
}
window.liminaWindows = { open, close, isOpen };

// ── Left accordion: each header toggles its own section (independent; World is the primary). ──
for (const head of document.querySelectorAll(".acc-head[data-acc-toggle]")) {
  head.addEventListener("click", () => {
    const id = head.dataset.accToggle;
    setSectionOpen(id, !sectionOpen(id));
  });
}

// ── Sidebar collapse rails. ───────────────────────────────────────────────────────────────
$("sidebar-left-toggle")?.addEventListener("click", () => setSidebarCollapsed(leftSidebar, !isCollapsed(leftSidebar)));
$("sidebar-right-toggle")?.addEventListener("click", () => setSidebarCollapsed(rightSidebar, !isCollapsed(rightSidebar)));

// ── Floating Inspector: close via ×, raise on click, drag by the title bar. ───────────────────
let zTop = 10;
for (const b of document.querySelectorAll(".win-close[data-close]")) {
  b.addEventListener("click", (e) => { e.stopPropagation(); const w = $(b.dataset.close); if (w) w.hidden = true; });
}
for (const w of document.querySelectorAll(".window")) {
  w.addEventListener("pointerdown", () => { w.style.zIndex = String(++zTop); });
}
let drag = null;
for (const head of document.querySelectorAll(".window > .panel-head[data-drag]")) {
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, input, select, a")) return;
    const w = head.parentElement;
    const r = w.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    drag = { w, dx: e.clientX - r.left, dy: e.clientY - r.top, s };
    w.style.zIndex = String(++zTop);
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener("pointermove", (e) => {
    if (!drag) return;
    drag.w.style.left = Math.max(0, e.clientX - drag.s.left - drag.dx) + "px";
    drag.w.style.top = Math.max(0, e.clientY - drag.s.top - drag.dy) + "px";
  });
  const end = (e) => { if (drag) { try { head.releasePointerCapture(e.pointerId); } catch { /* ignore */ } drag = null; } };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);
}

// Resizable console: drag the console header up/down to expand it (clamped 32px .. half the screen).
// The stage (viewport) is flex:1, so it gives up space as the console grows.
const logbar = document.querySelector(".logbar");
const logHead = logbar && logbar.querySelector(".log-head");
if (logbar && logHead) {
  let startY = 0, startH = 0, resizing = false;
  logHead.addEventListener("pointerdown", (e) => {
    resizing = true;
    startY = e.clientY;
    startH = logbar.getBoundingClientRect().height;
    logHead.setPointerCapture(e.pointerId);
  });
  logHead.addEventListener("pointermove", (e) => {
    if (!resizing) return;
    const dy = startY - e.clientY; // drag UP (clientY decreases) → taller console
    logbar.style.height = Math.min(window.innerHeight * 0.5, Math.max(32, startH + dy)) + "px";
  });
  const end = (e) => { if (resizing) { resizing = false; try { logHead.releasePointerCapture(e.pointerId); } catch { /* ignore */ } } };
  logHead.addEventListener("pointerup", end);
  logHead.addEventListener("pointercancel", end);
}

// Timeline lists (Activity, History) default to showing the MOST RECENT item: as new content is
// rendered they stick to the bottom — unless you've scrolled up to read older entries, in which case
// they leave your position alone. app.js re-renders these bodies every poll, so the MutationObserver
// keeps them pinned. `capture:true` on the scroll listener catches scrolling of inner scrollers too
// (e.g. History's dynamically-built .hist-list).
function stickToBottom(container, resolveScroller) {
  if (!container) return;
  let stick = true;
  container.addEventListener("scroll", (e) => {
    const el = e.target;
    if (typeof el.scrollTop === "number") stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
  }, true);
  const pin = () => { const el = resolveScroller(); if (el && stick) el.scrollTop = el.scrollHeight; };
  new MutationObserver(pin).observe(container, { childList: true, subtree: true });
  pin();
}
const reasonBody = document.getElementById("reason-body");
stickToBottom(reasonBody, () => reasonBody);
const historyBody = document.getElementById("history-body");
stickToBottom(historyBody, () => (historyBody && historyBody.querySelector(".hist-list")) || historyBody);
