// EditorHistoryController — the stateful "git for worlds" control layer the editor UI binds to.
//
// WorldHistory (worldlog/history.ts) is the pure data model: branches of the command log with
// branch/time-travel/diff/merge. The editor needs a CONTROLLER on top of it that holds the live
// session state a UI renders and drives: which branch is checked out, where the time-travel
// playhead sits, and the command prefix the viewport should replay to show the world "right now."
// The editor's buttons/sliders call these methods; the viewport renders commandsAtPlayhead().
//
// This is the wiring seam between the (tested) data model and the browser UI: it is pure,
// deterministic, framework-agnostic state logic — so it is unit-testable headlessly, exactly the
// way the rest of the engine is, while the DOM/canvas binding lives in the browser app.

import { WorldHistory, type BranchDiff, type MergeResult } from "../worldlog/history.ts";
import type { WorldCommand } from "../worldlog/log.ts";

/** One row in the UI's branch list. */
export interface BranchView {
  name: string;
  tip: number;
  current: boolean;
}

/** The full UI-facing view model — everything a branch/timeline panel needs to render. */
export interface EditorHistoryView {
  current: string;
  branches: BranchView[];
  /** Length of the current branch (its live tip). */
  tip: number;
  /** Time-travel position on the current branch (command count). Equals tip when live. */
  playhead: number;
  /** True when the playhead is at the live tip (not scrubbed into the past). */
  live: boolean;
}

export class EditorHistoryController {
  private readonly history: WorldHistory;
  private current: string;
  /** -1 means "live tip"; otherwise a command count the playhead is scrubbed to. */
  private playhead = -1;

  constructor(baseCommands: WorldCommand[] = [], mainName = "main") {
    this.history = new WorldHistory(baseCommands, mainName);
    this.current = mainName;
  }

  // ---- queries the UI renders -----------------------------------------------------------------

  currentBranch(): string {
    return this.current;
  }
  tip(): number {
    return this.history.tip(this.current);
  }
  /** The effective playhead position (the live tip when not scrubbed). */
  playheadAt(): number {
    return this.playhead < 0 ? this.tip() : Math.min(this.playhead, this.tip());
  }
  isLive(): boolean {
    return this.playhead < 0 || this.playhead >= this.tip();
  }
  branches(): BranchView[] {
    return this.history.names().map((name) => ({ name, tip: this.history.tip(name), current: name === this.current }));
  }
  view(): EditorHistoryView {
    return { current: this.current, branches: this.branches(), tip: this.tip(), playhead: this.playheadAt(), live: this.isLive() };
  }

  /** The command prefix the VIEWPORT replays to show the world at the current playhead — this is
   *  what makes the time-travel slider actually scrub the rendered world. */
  commandsAtPlayhead(): WorldCommand[] {
    return this.history.at(this.current, this.playheadAt());
  }

  // ---- commands the UI buttons/sliders invoke -------------------------------------------------

  /** Switch the checked-out branch; resets the playhead to that branch's live tip. */
  checkout(branch: string): boolean {
    if (!this.history.has(branch)) return false;
    this.current = branch;
    this.playhead = -1;
    return true;
  }

  /** Create a branch from the current one at `atSeq` (default: the current playhead — so you can
   *  branch off a point you've scrubbed back to, the editor's "branch from here"). Does not auto-
   *  check it out. */
  createBranch(name: string, atSeq?: number): boolean {
    const from = atSeq ?? this.playheadAt();
    return this.history.fork(name, this.current, from);
  }

  /** Move the time-travel playhead to `seq` on the current branch (clamped). Returns the effective
   *  position. The viewport then replays commandsAtPlayhead() to show that past state. */
  scrub(seq: number): number {
    const clamped = Math.max(0, Math.min(seq, this.tip()));
    this.playhead = clamped;
    return clamped;
  }
  /** Snap the playhead back to the live tip. */
  toLive(): void {
    this.playhead = -1;
  }

  /** Append authored commands to the current branch. Only allowed at the live tip — editing while
   *  scrubbed into the past would silently fork history, so the caller must branch first (the UI
   *  greys out "commit" while scrubbed and offers "branch from here"). Returns the new tip, or -1
   *  when refused. */
  commit(commands: WorldCommand[]): number {
    if (!this.isLive()) return -1;
    const tip = this.history.extend(this.current, commands);
    this.playhead = -1; // stay live at the new tip
    return tip;
  }

  diff(a: string, b: string): BranchDiff {
    return this.history.diff(a, b);
  }

  /** Merge `from` into `into`; if `into` is the current branch, snap to its (new) live tip. */
  merge(into: string, from: string): MergeResult {
    const r = this.history.merge(into, from);
    if (into === this.current) this.playhead = -1;
    return r;
  }
}
