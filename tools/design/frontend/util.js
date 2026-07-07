// util.js — tiny shared helpers for the Design Space frontend modules.

export function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function titleCaseName(s) {
  return String(s).replace(/(^|-)([a-z])/g, (_, a, b) => (a ? " " : "") + b.toUpperCase());
}
