// util.js — tiny shared helpers for the Design Space frontend modules.

export function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function titleCaseName(s) {
  return String(s).replace(/(^|-)([a-z])/g, (_, a, b) => (a ? " " : "") + b.toUpperCase());
}

/** Transient bottom-center notice (undo labels, save-conflict reloads). One element, reused. */
export function toast(msg, ms = 2200) {
  let el = document.getElementById("ds-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "ds-toast";
    el.style.cssText = "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:rgba(30,32,28,.92);color:#f0ede4;padding:7px 14px;border-radius:8px;font:13px/1.4 system-ui,sans-serif;z-index:9999;pointer-events:none;transition:opacity .25s;opacity:0";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = "1";
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = "0"; }, ms);
}
