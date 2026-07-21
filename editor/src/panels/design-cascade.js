// Cascade banner (studio-unification U1): the Design Space's save→cascade
// surfacing, ported as a standalone overlay. A doc save that impacts downstream
// design entities names the affected experts; each button routes to that expert's
// chat (the chat router owns what "talk to" means). Pure presentation — the
// impact computation stays server-side.

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Show the cascade for a save response's impacts. Idempotent per banner: a new
 *  cascade replaces the old. Returns the banner element (or null when there is
 *  nothing to surface — a save with no downstream impact is not an event). */
export function surfaceCascade(impacts, { onOpenChat } = {}) {
  document.getElementById("studio-cascade")?.remove();
  if (!Array.isArray(impacts) || impacts.length === 0) return null;
  const first = impacts[0];
  const src = first?.source?.name ?? first?.change?.entityId ?? "the design";
  const seen = new Set();
  const items = [];
  for (const impact of impacts) {
    for (const affected of impact.affected ?? []) {
      if (!seen.has(affected.id)) {
        seen.add(affected.id);
        items.push(affected);
      }
    }
  }
  if (items.length === 0) return null;
  const el = document.createElement("div");
  el.className = "cascade studio-cascade";
  el.id = "studio-cascade";
  el.innerHTML = `<h4>⚑ You changed ${esc(src)} — review the cascade<button class="cx" id="studio-cascade-x" type="button">×</button></h4>`
    + `<div class="sum">${esc(first?.summary ?? "")}</div>`
    + items.map((a) =>
      `<div class="item"><span class="nm">${esc(a.name)}</span><span class="rel">${esc(a.relation)}</span>`
      + `<button class="go" data-agent="${esc(a.expertId)}" type="button">Talk to ${esc(a.expertRole)}</button></div>`
    ).join("");
  document.body.appendChild(el);
  el.querySelector("#studio-cascade-x").onclick = () => el.remove();
  if (typeof onOpenChat === "function") {
    for (const b of el.querySelectorAll(".go")) b.onclick = () => onOpenChat(b.dataset.agent);
  }
  return el;
}
