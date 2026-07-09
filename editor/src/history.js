// History panel — binds the tested EditorHistoryController (git-for-worlds) to the editor DOM.
//
// The controller logic is the engine's js/src/editor/history_controller.ts, bundled to
// ../vendor/history-controller.js (so there is ONE source of truth, proven by
// js/test/p16_editor_controller.ts). This module is the thin browser binding: it ingests the
// editor's observed authoring log (worldlog.tail commands) onto the "main" branch, and renders the branch
// list, a time-travel scrub slider, and branch/merge controls. Scrubbing emits the command prefix
// at the playhead (onScrub) so a host can replay the viewport to that past state.

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

  /** Ingest newly-observed AUTHORING commands (world edits) onto the MAIN branch, preserving the
   *  user's current view (checked-out branch + scrub position). */
  function recordCommands(commands) {
    if (!Array.isArray(commands) || commands.length === 0) return;
    const fresh = [];
    for (const cmd of commands) {
      if (!cmd || cmd.seq === undefined || seen.has(cmd.seq)) continue;
      seen.add(cmd.seq);
      fresh.push(toCommand(cmd));
    }
    if (fresh.length === 0) return;
    const prevBranch = ctrl.currentBranch();
    const prevLive = ctrl.isLive();
    const prevPlayhead = ctrl.playheadAt();
    ctrl.checkout("main");
    ctrl.commit(fresh);
    ctrl.checkout(prevBranch);
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
      root.appendChild(el("div", "muted", "no edits yet — observed world-log edits appear here as the timeline"));
      return;
    }

    // ── Branch row: checkout selector + new-branch + merge ──────────────────────────────────
    const branchRow = el("div", "hist-row");
    const branchSel = el("select", "hist-select");
    for (const b of v.branches) {
      const o = el("option", undefined, `${b.name} (${b.tip})${b.current ? " ●" : ""}`);
      o.value = b.name;
      if (b.current) o.selected = true;
      branchSel.appendChild(o);
    }
    branchSel.addEventListener("change", () => { ctrl.checkout(branchSel.value); emitScrub(); render(); });
    branchRow.appendChild(el("span", "hist-label", "branch"));
    branchRow.appendChild(branchSel);

    const newBtn = el("button", "btn btn-small", "+ branch");
    newBtn.title = "Fork a new branch from the current playhead";
    newBtn.addEventListener("click", () => {
      const name = (window.prompt("New branch name", `wip-${v.branches.length}`) || "").trim();
      if (name && ctrl.createBranch(name)) { ctrl.checkout(name); emitScrub(); render(); }
    });
    branchRow.appendChild(newBtn);
    root.appendChild(branchRow);

    // ── Merge row: pick a source branch to merge into the current one ───────────────────────
    if (v.branches.length > 1) {
      const mergeRow = el("div", "hist-row");
      const mergeSel = el("select", "hist-select");
      for (const b of v.branches) {
        if (b.name === v.current) continue;
        const o = el("option", undefined, b.name); o.value = b.name; mergeSel.appendChild(o);
      }
      const mergeBtn = el("button", "btn btn-small", "merge →");
      mergeBtn.title = `Merge the selected branch into ${v.current}`;
      mergeBtn.addEventListener("click", () => {
        if (!mergeSel.value) return;
        const r = ctrl.merge(v.current, mergeSel.value);
        emitScrub(); render();
        if (opts.onLog) opts.onLog(`merged ${mergeSel.value} → ${v.current}: ${r.kind} (+${r.added})`);
      });
      mergeRow.appendChild(el("span", "hist-label", "merge"));
      mergeRow.appendChild(mergeSel);
      mergeRow.appendChild(mergeBtn);
      root.appendChild(mergeRow);
    }

    // ── Timeline scrub: time-travel the playhead across the current branch ──────────────────
    const scrubRow = el("div", "hist-row");
    const scrub = el("input", "hist-scrub");
    scrub.type = "range"; scrub.min = "0"; scrub.max = String(v.tip); scrub.step = "1"; scrub.value = String(v.playhead);
    const readout = el("span", "hist-readout");
    const setReadout = () => {
      const p = ctrl.playheadAt();
      readout.textContent = `edit ${p} / ${ctrl.tip()} · ${ctrl.isLive() ? "live" : "past"}`;
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
