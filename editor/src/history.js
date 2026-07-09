// Read-only world-log timeline. Scrubbing changes only the viewport replay prefix;
// authoritative edits and undo are handled by the project authoring gateway.

import { EditorHistoryController } from "../vendor/history-controller.js";

const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function createHistoryPanel(opts = {}) {
  const onScrub = typeof opts.onScrub === "function" ? opts.onScrub : () => {};
  let ctrl = new EditorHistoryController([], "main");
  const seen = new Set(); // command seqs already ingested (dedupe across polls)

  // Map an AUTHORING world-log command (from worldlog.tail — the actual world edits) to the
  // controller's lightweight record. The controller re-stamps its own seq on commit; the source
  // seq is kept as the stable dedup key + display seq.
  const toCommand = (cmd) => ({ kind: cmd.kind || "skill", seq: cmd.seq, tool: cmd.tool || cmd.op || "cmd", id: cmd.seq });

  /** Ingest newly observed authoring commands while preserving a scrubbed playhead. */
  function recordCommands(commands) {
    if (!Array.isArray(commands) || commands.length === 0) return;
    const fresh = [];
    for (const cmd of commands) {
      if (!cmd || cmd.seq === undefined || seen.has(cmd.seq)) continue;
      seen.add(cmd.seq);
      fresh.push(toCommand(cmd));
    }
    if (fresh.length === 0) return;
    const prevLive = ctrl.isLive();
    const prevPlayhead = ctrl.playheadAt();
    ctrl.toLive();
    ctrl.commit(fresh);
    if (!prevLive) ctrl.scrub(prevPlayhead);
    render();
  }

  function reset() {
    ctrl = new EditorHistoryController([], "main");
    seen.clear();
    render();
  }

  function render() {
    const root = $("history-body");
    if (!root) return;
    root.innerHTML = "";
    const v = ctrl.view();

    if (v.tip === 0 && v.branches.length === 1) {
      root.appendChild(el("div", "muted", "no edits yet — timeline is view only"));
      return;
    }

    // ── Timeline scrub: time-travel the playhead across the current branch ──────────────────
    const scrubRow = el("div", "hist-row");
    const scrub = el("input", "hist-scrub");
    scrub.type = "range"; scrub.min = "0"; scrub.max = String(v.tip); scrub.step = "1"; scrub.value = String(v.playhead);
    scrub.title = "View-only world-log replay";
    const readout = el("span", "hist-readout");
    const setReadout = () => {
      const p = ctrl.playheadAt();
      readout.textContent = `edit ${p} / ${ctrl.tip()} · ${ctrl.isLive() ? "live" : "past"} · view only`;
    };
    scrub.addEventListener("input", () => { ctrl.scrub(parseInt(scrub.value, 10)); setReadout(); emitScrub(); renderCommands(); });
    scrubRow.appendChild(el("span", "hist-label", "timeline"));
    scrubRow.appendChild(scrub);
    scrubRow.appendChild(readout);
    setReadout();
    root.appendChild(scrubRow);

    if (!ctrl.isLive()) {
      const liveBtn = el("button", "btn btn-small btn-ghost", "↦ live");
      liveBtn.addEventListener("click", () => { ctrl.toLive(); emitScrub(); render(); });
      root.appendChild(liveBtn);
    }

    // ── The edits up to the playhead (what the viewport would replay) ───────────────────────
    const list = el("div", "hist-list");
    root.appendChild(list);
    renderCommands();
    function renderCommands() {
      list.innerHTML = "";
      const cmds = ctrl.commandsAtPlayhead();
      const tail = cmds.slice(-12);
      for (const c of tail) list.appendChild(el("div", "hist-cmd", `${String(c.seq).padStart(3, " ")}  ${c.tool || c.kind}`));
      if (cmds.length > tail.length) list.insertBefore(el("div", "hist-cmd muted", `… ${cmds.length - tail.length} earlier`), list.firstChild);
    }
  }

  function emitScrub() {
    // Give the host both the prefix at the playhead and whether we're live, so it can replay the
    // viewport to a past state (or return to following the newest edits).
    try { onScrub({ commands: ctrl.commandsAtPlayhead(), live: ctrl.isLive() }); } catch (_e) { /* host viewport hook is optional */ }
  }

  render();
  return { recordCommands, reset, controller: () => ctrl };
}
