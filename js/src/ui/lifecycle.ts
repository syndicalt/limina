// limina UI — lifecycle + motion (A2/A3). All time-driven; advance each with the
// frame dt (ms). None of these re-rasterize unless content actually changes.
//
//  Fade        — ramps material.opacity (the quad-wide alpha the renderer reads).
//  Typewriter  — reveals body text incrementally via Panel.setText.
//  Lifetime    — a TTL countdown / auto-dismiss.
//  SpeechQueue — per-speaker queue OR replace of successive lines (a conversation
//                reads naturally: replace swaps instantly; queue holds then advances).
//  FeedModel   — a scrolling log: append lines, keep the latest N newest-in-order
//                (the live agent-ops HUD feed).

import type { Panel } from "./surface.ts";

interface OpacityTarget {
  opacity: number;
  transparent: boolean;
}

/** Linear opacity ramp over `durationMs`. Drives the material's quad-wide alpha. */
export class Fade {
  private readonly material: OpacityTarget;
  private from: number;
  private to: number;
  private durationMs: number;
  private elapsed = 0;

  constructor(panel: Panel | OpacityTarget, opts: { from?: number; to?: number; durationMs: number }) {
    this.material = (panel as Panel).material ?? (panel as OpacityTarget);
    this.material.transparent = true;
    this.from = opts.from ?? 0;
    this.to = opts.to ?? 1;
    this.durationMs = Math.max(1, opts.durationMs);
    this.material.opacity = this.from;
  }

  /** Restart the ramp (optionally with new endpoints, e.g. fade back out). */
  reset(from?: number, to?: number, durationMs?: number): void {
    if (from !== undefined) this.from = from;
    if (to !== undefined) this.to = to;
    if (durationMs !== undefined) this.durationMs = Math.max(1, durationMs);
    this.elapsed = 0;
    this.material.opacity = this.from;
  }

  /** Advance; sets material.opacity. Returns true once the ramp completes. */
  update(dtMs: number): boolean {
    this.elapsed += dtMs;
    const t = this.elapsed >= this.durationMs ? 1 : this.elapsed / this.durationMs;
    this.material.opacity = this.from + (this.to - this.from) * t;
    return t >= 1;
  }

  get opacity(): number {
    return this.material.opacity;
  }
  get done(): boolean {
    return this.elapsed >= this.durationMs;
  }
}

/** Incremental text reveal (`cps` chars/second) via Panel.setText. */
export class Typewriter {
  private readonly panel: Panel;
  private readonly full: string;
  private readonly title: string | undefined;
  private readonly cps: number;
  private shownChars = 0;

  constructor(panel: Panel, full: string, opts: { cps?: number; title?: string } = {}) {
    this.panel = panel;
    this.full = full;
    this.title = opts.title;
    this.cps = Math.max(1, opts.cps ?? 40);
    this.panel.setText("", this.title);
  }

  /** Advance the reveal. Returns true once the whole string is shown. */
  update(dtMs: number): boolean {
    if (this.shownChars >= this.full.length) return true;
    this.shownChars = Math.min(this.full.length, this.shownChars + (this.cps * dtMs) / 1000);
    this.panel.setText(this.full.slice(0, Math.floor(this.shownChars)), this.title);
    return this.shownChars >= this.full.length;
  }

  /** Reveal the whole string immediately. */
  finish(): void {
    this.shownChars = this.full.length;
    this.panel.setText(this.full, this.title);
  }

  get shown(): string {
    return this.full.slice(0, Math.floor(this.shownChars));
  }
  get done(): boolean {
    return this.shownChars >= this.full.length;
  }
}

/** A time-to-live countdown for auto-dismiss. */
export class Lifetime {
  private remainingMs: number;

  constructor(ttlMs: number) {
    this.remainingMs = ttlMs;
  }

  /** Advance; returns true once expired. */
  update(dtMs: number): boolean {
    this.remainingMs -= dtMs;
    return this.remainingMs <= 0;
  }

  get remaining(): number {
    return Math.max(0, this.remainingMs);
  }
  get expired(): boolean {
    return this.remainingMs <= 0;
  }
}

export type QueueMode = "queue" | "replace";

export interface SpeechLine {
  text: string;
  title?: string;
  /** how long to hold this line before advancing (queue mode); default per-queue. */
  holdMs?: number;
}

/** Per-speaker line manager. `replace` swaps the shown line instantly (latest
 *  wins, queue cleared); `queue` shows lines in order, each held then advanced.
 *  With `cps` set, each line TYPES IN (a Typewriter per line); paired with a
 *  `maxLines`-clamped bubble the reveal scrolls to the newest text. A line is
 *  never advanced before it has fully revealed. */
export class SpeechQueue {
  private readonly panel: Panel;
  private readonly mode: QueueMode;
  private readonly defaultHoldMs: number;
  private readonly cps: number | undefined;
  private readonly pendingLines: SpeechLine[] = [];
  private showing: SpeechLine | null = null;
  private writer: Typewriter | null = null;
  private elapsed = 0;

  constructor(panel: Panel, opts: { mode?: QueueMode; defaultHoldMs?: number; cps?: number } = {}) {
    this.panel = panel;
    this.mode = opts.mode ?? "queue";
    this.defaultHoldMs = opts.defaultHoldMs ?? 2500;
    this.cps = opts.cps;
  }

  /** Submit a line. In replace mode it is shown immediately; in queue mode it is
   *  appended (and shown now if nothing is showing). */
  push(line: SpeechLine | string): void {
    const l: SpeechLine = typeof line === "string" ? { text: line } : line;
    if (this.mode === "replace") {
      this.pendingLines.length = 0;
      this.show(l);
      return;
    }
    this.pendingLines.push(l);
    if (this.showing === null) this.advance();
  }

  /** Advance the reveal + hold clock; swaps to the next line once the current
   *  line is fully revealed AND its hold has elapsed. */
  update(dtMs: number): void {
    if (this.showing === null) return;
    if (this.writer !== null) this.writer.update(dtMs); // reveal (+ scroll via maxLines)
    if (this.mode === "replace") return;
    this.elapsed += dtMs;
    const hold = this.showing.holdMs ?? this.defaultHoldMs;
    const revealed = this.writer === null || this.writer.done;
    if (this.elapsed >= hold && revealed && this.pendingLines.length > 0) this.advance();
  }

  private advance(): void {
    const next = this.pendingLines.shift();
    if (next === undefined) return;
    this.show(next);
  }

  private show(line: SpeechLine): void {
    this.showing = line;
    this.elapsed = 0;
    if (this.cps !== undefined) {
      // Typewriter sets the panel to "" then reveals to `line.text` over ticks.
      this.writer = new Typewriter(this.panel, line.text, { cps: this.cps, title: line.title });
    } else {
      this.writer = null;
      this.panel.setText(line.text, line.title);
    }
  }

  /** The full text of the line currently showing (independent of reveal). */
  get current(): string | null {
    return this.showing?.text ?? null;
  }
  /** The portion revealed so far (== current once typed in; full when no cps). */
  get shown(): string | null {
    if (this.showing === null) return null;
    return this.writer !== null ? this.writer.shown : this.showing.text;
  }
  /** True once the line currently showing is FULLY revealed AND nothing is
   *  queued behind it — i.e. the latest pushed line is completely on screen. A
   *  director can gate a turn on this so a long line finishes typing before the
   *  reply (an empty queue is trivially "revealed"). */
  get revealed(): boolean {
    if (this.showing === null) return this.pendingLines.length === 0;
    if (this.pendingLines.length > 0) return false;
    return this.writer === null || this.writer.done;
  }
  get pending(): number {
    return this.pendingLines.length;
  }
  get idle(): boolean {
    return this.showing === null && this.pendingLines.length === 0;
  }
}

/** A scrolling feed: append lines, render only the latest `maxLines`, newest
 *  last (oldest scrolls off the top). Optionally pushes into a Panel. */
export class FeedModel {
  private readonly maxLines: number;
  private readonly buffer: string[] = [];
  private readonly panel: Panel | undefined;
  private readonly title: string | undefined;

  constructor(opts: { maxLines: number; panel?: Panel; title?: string }) {
    this.maxLines = Math.max(1, opts.maxLines);
    this.panel = opts.panel;
    this.title = opts.title;
  }

  /** Append a line; trims to the latest `maxLines`; refreshes the panel if bound. */
  append(line: string): void {
    this.buffer.push(line);
    if (this.buffer.length > this.maxLines) this.buffer.splice(0, this.buffer.length - this.maxLines);
    if (this.panel) this.panel.setText(this.text(), this.title);
  }

  /** The visible window (latest `maxLines`, newest last). */
  lines(): string[] {
    return this.buffer.slice();
  }
  text(): string {
    return this.buffer.join("\n");
  }
  get size(): number {
    return this.buffer.length;
  }
}
