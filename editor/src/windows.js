// Floating tool windows for the co-authoring editor. The ☰ menu toggles each tool's window; windows
// open at staggered default positions, are draggable by their title bar, and close via the ×. Each
// tool (World / Reasoning / History / Approval, and later Chat) is its OWN window so they never
// overlap in a crammed sidebar and you open only what you need — the viewport stays the full canvas.
// Framework-free; shares no state with app.js/viewport.js beyond the DOM (app.js still fills the bodies).

const menuBtn = document.getElementById("tools-toggle");
const menu = document.getElementById("tools-menu");
const stage = document.querySelector(".stage");

if (menuBtn && menu && stage) {
  // Staggered default positions (px from the stage top-left) applied the first time a window opens.
  const DEFAULT_POS = {
    world: { left: 16, top: 60 },
    reasoning: { left: 392, top: 60 },
    inspector: { left: 768, top: 60 },
    history: { left: 16, top: 384 },
    approval: { left: 392, top: 384 },
    chat: { left: 768, top: 384 },
  };
  const placed = new Set();
  let z = 10;
  const nextZ = () => ++z;
  const winOf = (id) => document.getElementById(id);
  const isOpen = (id) => { const w = winOf(id); return !!w && !w.hidden; };

  function syncMenu() {
    for (const b of menu.querySelectorAll("button[data-target]")) {
      b.classList.toggle("open", isOpen(b.dataset.target));
    }
  }
  function open(id) {
    const w = winOf(id);
    if (!w) return;
    if (!placed.has(id)) {
      const p = DEFAULT_POS[id] || { left: 40, top: 80 };
      w.style.left = p.left + "px";
      w.style.top = p.top + "px";
      placed.add(id);
    }
    w.hidden = false;
    w.style.zIndex = String(nextZ());
    w.dispatchEvent(new CustomEvent("limina:window-open", { bubbles: true, detail: { id } }));
    syncMenu();
  }
  function close(id) { const w = winOf(id); if (w) { w.hidden = true; syncMenu(); } }
  window.liminaWindows = { open, close, isOpen };

  // ☰ opens the menu; a click elsewhere closes it.
  menuBtn.addEventListener("click", (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== menuBtn) menu.hidden = true;
  });
  for (const b of menu.querySelectorAll("button[data-target]")) {
    b.addEventListener("click", (e) => { e.stopPropagation(); isOpen(b.dataset.target) ? close(b.dataset.target) : open(b.dataset.target); });
  }
  for (const b of document.querySelectorAll(".win-close[data-close]")) {
    b.addEventListener("click", (e) => { e.stopPropagation(); close(b.dataset.close); });
  }

  // Clicking anywhere on a window raises it above the others (so a window behind another comes to
  // the front on click). Menu + toggle sit far above this z band (CSS), so chrome always overlays.
  for (const w of document.querySelectorAll(".window")) {
    w.addEventListener("pointerdown", () => { w.style.zIndex = String(nextZ()); });
  }

  // Drag a window by its title bar (but not from a control inside it).
  let drag = null;
  for (const head of document.querySelectorAll(".window > .panel-head[data-drag]")) {
    head.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, input, select, a")) return;
      const w = head.parentElement;
      const r = w.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      drag = { w, dx: e.clientX - r.left, dy: e.clientY - r.top, s };
      w.style.zIndex = String(nextZ());
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

  syncMenu();
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

// Timeline lists (Reasoning, History) default to showing the MOST RECENT item: as new content is
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
