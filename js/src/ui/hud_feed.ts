// Real trace-fed agent-ops HUD. A small reusable helper over the UiManager +
// LiminaTracer: it authors a screen-anchored hudPanel with a scrolling feed and,
// each pump, pulls NEW events from tracer.tail({ afterSeq }) and feedAppends one
// compact line per event (type + skill/tool/actor). The HUD shows ONLY real
// recorded events — never a canned/hardcoded string — so it is an honest live
// window on what the agents actually did.
//
//   const hud = new TraceHud(ui, tracer, { scene });
//   // ...each frame, after running the systems:
//   hud.pump();
//   ui.update(camera, w, h, dt);
//
// Wave 2's windowed demo reuses this verbatim to surface the live Ollama-driven
// conversation's ops in the HUD.

import type { SceneLike } from "../engine.ts";
import type { EngineEvent } from "../observability/event.ts";
import type { ScreenCorner } from "./anchor.ts";
import type { UiManager } from "./manager.ts";

const DEFAULT_DT_MS = 1000 / 60;

/** The slice of LiminaTracer the HUD reads (incremental tail by seq cursor). */
export interface TraceTailer {
  tail(opts?: { afterSeq?: number; limit?: number; actorId?: string; type?: string }): {
    events: EngineEvent[];
    nextAfterSeq: number | null;
  };
}

export interface TraceHudOptions {
  /** Scene the hudPanel's mesh is added to. */
  scene: SceneLike;
  title?: string;
  corner?: ScreenCorner;
  marginPx?: [number, number];
  maxLines?: number;
  width?: number;
  /** Which events to surface (default: social.* + skill.executed + agent action
   *  + permission denials — the meaningful agent-ops stream). */
  filter?: (ev: EngineEvent) => boolean;
  /** How an event renders to a feed line (default: "<type> · <skill|tool|actor>"). */
  format?: (ev: EngineEvent) => string;
  /** Max events pulled per pump (default 256). */
  pullLimit?: number;
  /** Reveal at most one new feed line per this many ms (default 500): the
   *  backlog is queued + drained slowly so lines linger long enough to read. */
  revealIntervalMs?: number;
}

/** "type · detail" where detail is the skill (skill.executed), the tool (agent
 *  action), or the acting agent — the real payload, never a fixed string. */
function formatEvent(ev: EngineEvent): string {
  const p = ev.payload;
  if (p !== null && typeof p === "object") {
    const rec = p as Record<string, unknown>;
    if (typeof rec.skill === "string") return `${ev.type} · ${rec.skill}`;
    if (typeof rec.tool === "string") return `${ev.type} · ${rec.tool}`;
  }
  return `${ev.type} · ${ev.actorId}`;
}

export class TraceHud {
  /** The UiManager handle of the HUD panel (live in the scene). */
  readonly handle: string;
  private cursor = -1;
  private readonly consumed: string[] = [];
  private readonly ui: UiManager;
  private readonly tracer: TraceTailer;
  private readonly filter: (ev: EngineEvent) => boolean;
  private readonly format: (ev: EngineEvent) => string;
  private readonly pullLimit: number;
  private readonly revealIntervalMs: number;
  /** Meaningful lines pulled but not yet revealed into the visible feed. */
  private readonly queued: string[] = [];
  private revealClock = 0;

  constructor(ui: UiManager, tracer: TraceTailer, opts: TraceHudOptions) {
    this.ui = ui;
    this.tracer = tracer;
    this.filter = opts.filter ?? ((ev) =>
      ev.type.startsWith("social.")
      || ev.type === "skill.executed"
      || ev.type === "agent.action.executed"
      || ev.type === "security.permission.denied");
    this.format = opts.format ?? formatEvent;
    this.pullLimit = opts.pullLimit ?? 256;
    this.revealIntervalMs = Math.max(0, opts.revealIntervalMs ?? 500);
    const { handle } = ui.create(opts.scene, "hudPanel", {
      anchor: { kind: "screen", corner: opts.corner ?? "top-right", marginPx: opts.marginPx ?? [16, 16] },
      title: opts.title ?? "AGENT OPS",
      lines: [],
      width: opts.width ?? 340,
      // Fixed-size scrolling console: pins width + height + truncates each line to
      // one row, so the box stays CONSTANT as events stream (same N caps the feed).
      maxLines: opts.maxLines ?? 10,
      lifecycle: { feed: { maxLines: opts.maxLines ?? 10 } },
    });
    this.handle = handle;
  }

  /** Pull every event newer than the cursor and RECORD the matching ones as real
   *  feed lines (the immediate audit), then reveal them into the visible feed at
   *  a calm, rate-limited pace (~1 line per `revealIntervalMs`) so each lingers
   *  long enough to read. The backlog is queued + drained, never dropped. Pass
   *  the frame dt so the reveal clock advances in sim-time. Returns the number of
   *  lines REVEALED this pump. */
  pump(dtMs: number = DEFAULT_DT_MS): number {
    const { events, nextAfterSeq } = this.tracer.tail({ afterSeq: this.cursor, limit: this.pullLimit });
    for (const ev of events) {
      if (!this.filter(ev)) continue;
      const line = this.format(ev);
      this.consumed.push(line); // immediate audit: every meaningful op recorded
      this.queued.push(line); // backlog revealed slowly below
    }
    if (nextAfterSeq !== null) this.cursor = nextAfterSeq;
    return this.drain(dtMs);
  }

  /** Reveal at most one queued line per `revealIntervalMs` of elapsed dt. */
  private drain(dtMs: number): number {
    this.revealClock += dtMs;
    let revealed = 0;
    while (this.queued.length > 0 && this.revealClock >= this.revealIntervalMs) {
      this.revealClock -= this.revealIntervalMs;
      this.ui.feedAppend(this.handle, this.queued.shift() as string);
      revealed++;
    }
    // Keep at most one interval of "credit" while idle: a lone event after a
    // quiet spell reveals promptly, but a burst still drains one-per-interval.
    if (this.queued.length === 0 && this.revealClock > this.revealIntervalMs) {
      this.revealClock = this.revealIntervalMs;
    }
    return revealed;
  }

  /** Every meaningful line the HUD has RECORDED from the trace (oldest first) —
   *  the real, trace-derived audit a host/test can scan. Independent of the
   *  rate-limited visible feed: a line is recorded the pump it is pulled, even if
   *  it has not yet been revealed on screen. */
  lines(): string[] {
    return this.consumed.slice();
  }

  /** Whether the HUD has surfaced a line matching a predicate. */
  has(predicate: (line: string) => boolean): boolean {
    return this.consumed.some(predicate);
  }
}
