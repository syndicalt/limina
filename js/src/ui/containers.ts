// limina UI — container kinds (A2): label, text box, speech/thought bubble,
// callout, HUD panel. Each is a thin builder that assembles a TextStyle (with
// the right bubble chrome) and wraps it in a Panel (./surface.ts). The chrome
// itself — tail triangle, thought puffs, callout leader line, rounded corners,
// shadow — is composited by ./compositor.ts; these builders only pick the style
// + the kind-specific geometry (which edge the tail points from, etc.).
//
// Placement (world billboard vs screen corner) is ./anchor.ts; lifecycle (fade/
// typewriter/queue/ttl) is ./lifecycle.ts. A container is just a styled Panel.

import {
  type ColorInput,
  consoleHeight,
  type Side,
  type TailStyle,
  type TextStyle,
} from "./compositor.ts";
import { Panel } from "./surface.ts";

/** A 2D direction in the panel's local plane (x right, y UP, world-style). */
export interface Toward {
  x: number;
  y: number;
}

/** Pick the box edge a tail/puff trail should sprout from to point at a local
 *  2D direction. `toward` is world-style (y up); the texture's y is down, so a
 *  target BELOW the box (toward.y < 0) yields the BOTTOM edge. */
export function sideToward(toward: Toward): Side {
  if (Math.abs(toward.y) >= Math.abs(toward.x)) return toward.y < 0 ? "bottom" : "top";
  return toward.x < 0 ? "left" : "right";
}

/** Nudge the tail/puff position along its edge toward the perpendicular
 *  component of `toward`, so a diagonal anchor aims the tail better. 0.5 center. */
function offsetToward(side: Side, toward: Toward): number {
  const horizontalEdge = side === "top" || side === "bottom";
  const perp = horizontalEdge ? toward.x : -toward.y; // texture x right / y down
  const mag = Math.sqrt(toward.x * toward.x + toward.y * toward.y) || 1; // sqrt: IEEE correctly-rounded, bit-stable (Math.hypot is not)
  const t = 0.5 + 0.4 * (perp / mag);
  return t < 0.08 ? 0.08 : t > 0.92 ? 0.92 : t;
}

/** Shallow-merge a partial style over a base (top-level keys; later wins). */
function mergeStyle(base: TextStyle, over: TextStyle | undefined): TextStyle {
  return over ? { ...base, ...over } : { ...base };
}

const INK: ColorInput = 0xf3f5f7;
const PANEL_BG = 0x1b2230;
const PANEL_BORDER = 0x46506a;

/** Default styles per kind — translucent dark panels, light ink, rounded bubbles. */
const LABEL_STYLE: TextStyle = {
  background: { color: 0x0b0e14, opacity: 0.55 },
  text: { color: INK, scale: 2, align: "center" },
  padding: 6,
};
const TEXT_BOX_STYLE: TextStyle = {
  background: { color: PANEL_BG, opacity: 0.92 },
  border: { width: 2, color: PANEL_BORDER, radius: 8 },
  title: { background: 0x2d3850, color: 0x9fd0ff, height: 26, align: "left" },
  text: { color: INK, scale: 2, align: "left", lineHeight: 24 },
  padding: { top: 8, right: 12, bottom: 10, left: 12 },
  shadow: { offsetY: 5, blur: 7, opacity: 0.5 },
};
const BUBBLE_STYLE: TextStyle = {
  background: { color: 0xf7f9fc, opacity: 0.98 },
  border: { width: 2, color: 0x2a3550, radius: 12 },
  text: { color: 0x14202e, scale: 2, align: "left", lineHeight: 24 },
  padding: { top: 8, right: 12, bottom: 8, left: 12 },
  shadow: { offsetY: 4, blur: 6, opacity: 0.4 },
};
const CALLOUT_STYLE: TextStyle = {
  background: { color: PANEL_BG, opacity: 0.95 },
  border: { width: 2, color: 0xffd166, radius: 6 },
  text: { color: INK, scale: 2, align: "left" },
  padding: 8,
};
const HUD_STYLE: TextStyle = {
  background: { color: 0x0b0e14, opacity: 0.82 },
  border: { width: 1, color: 0x2c3650, radius: 6 },
  title: { background: 0x162033, color: 0x7fd1ff, height: 24, align: "left" },
  text: { color: 0xd7e2f0, scale: 2, align: "left", lineHeight: 22 },
  padding: { top: 7, right: 12, bottom: 9, left: 12 },
};

// ---- builders --------------------------------------------------------------

export interface LabelOptions {
  text: string;
  style?: TextStyle;
  pixelScale?: number;
}
/** Plain billboard text (minimal chrome) tracking an entity or world point. */
export function label(opts: LabelOptions): Panel {
  return new Panel({ style: mergeStyle(LABEL_STYLE, opts.style), text: opts.text, pixelScale: opts.pixelScale });
}

export interface TextBoxOptions {
  text: string;
  title?: string;
  style?: TextStyle;
  maxWidth?: number;
  pixelScale?: number;
}
/** Rectangular container with an optional title/header bar. */
export function textBox(opts: TextBoxOptions): Panel {
  const style = mergeStyle(TEXT_BOX_STYLE, opts.style);
  if (opts.maxWidth !== undefined) style.maxWidth = opts.maxWidth;
  return new Panel({ style, text: opts.text, title: opts.title, pixelScale: opts.pixelScale });
}

export interface SpeechBubbleOptions {
  text: string;
  title?: string;
  style?: TextStyle;
  maxWidth?: number;
  /** direction from the bubble toward the speaker (x right, y UP). */
  tailToward?: Toward;
  /** force the tail edge (overrides `tailToward`). */
  tailSide?: Side;
  /** extra tail tuning (length/base/color/offset). */
  tail?: Partial<TailStyle>;
  pixelScale?: number;
}
/** Rounded bubble + a directional tail aimed at the speaker (entity/world point).
 *  The tail edge is derived from `tailToward` so the pointer really points at
 *  the anchor; `tailSide` forces it (used by the falsifiable test). */
export function speechBubble(opts: SpeechBubbleOptions): Panel {
  const style = mergeStyle(BUBBLE_STYLE, opts.style);
  if (opts.maxWidth !== undefined) style.maxWidth = opts.maxWidth;
  const toward = opts.tailToward ?? { x: 0, y: -1 };
  const side = opts.tailSide ?? sideToward(toward);
  const offset = opts.tail?.offset ?? offsetToward(side, toward);
  style.tail = {
    side,
    offset,
    length: opts.tail?.length ?? 18,
    base: opts.tail?.base ?? 20,
    color: opts.tail?.color,
    opacity: opts.tail?.opacity,
  };
  return new Panel({ style, text: opts.text, title: opts.title, pixelScale: opts.pixelScale });
}

export interface ThoughtBubbleOptions {
  text: string;
  style?: TextStyle;
  maxWidth?: number;
  /** direction from the bubble toward the thinker (x right, y UP). */
  toward?: Toward;
  /** force the puff edge (overrides `toward`). */
  side?: Side;
  count?: number;
  pixelScale?: number;
}
/** Rounded bubble + trailing puffs leading back to the thinker. */
export function thoughtBubble(opts: ThoughtBubbleOptions): Panel {
  const style = mergeStyle(BUBBLE_STYLE, opts.style);
  style.border = { width: 2, color: 0x2a3550, radius: 18 };
  if (opts.maxWidth !== undefined) style.maxWidth = opts.maxWidth;
  const toward = opts.toward ?? { x: 0, y: -1 };
  const side = opts.side ?? sideToward(toward);
  style.puffs = { side, offset: offsetToward(side, toward), count: opts.count ?? 3, startRadius: 9 };
  return new Panel({ style, text: opts.text, pixelScale: opts.pixelScale });
}

export interface CalloutOptions {
  text: string;
  title?: string;
  style?: TextStyle;
  maxWidth?: number;
  /** leader vector from the box edge to the target, panel-local px (x right, y DOWN). */
  leader: { dx: number; dy: number; side?: Side; offset?: number; width?: number; color?: ColorInput; dot?: number };
  pixelScale?: number;
}
/** Annotation box + a leader line drawn to a target point. The container layer
 *  computes the leader vector (e.g. from the box toward where a world point
 *  projects); the line + end dot are composited into the texture. */
export function callout(opts: CalloutOptions): Panel {
  const style = mergeStyle(CALLOUT_STYLE, opts.style);
  if (opts.maxWidth !== undefined) style.maxWidth = opts.maxWidth;
  const lead = opts.leader;
  style.callout = {
    side: lead.side ?? "bottom",
    offset: lead.offset ?? 0.5,
    dx: lead.dx,
    dy: lead.dy,
    width: lead.width ?? 2,
    color: lead.color,
    dot: lead.dot ?? 4,
  };
  return new Panel({ style, text: opts.text, title: opts.title, pixelScale: opts.pixelScale });
}

export interface HudPanelOptions {
  /** body text, or a list of lines joined with newlines. */
  text?: string;
  lines?: string[];
  title?: string;
  style?: TextStyle;
  width?: number;
  pixelScale?: number;
  /** Render as a FIXED-size scrolling console: cap the body to exactly this many
   *  rows, truncate each line to one row (no wrap), and pin the height so the box
   *  never grows as feed lines stream. Combine with `width` for a constant box. */
  maxLines?: number;
}
/** Screen-anchored panel (a feed/HUD). Body is a list of lines; combine with a
 *  ScreenAnchor (./anchor.ts) to pin it to a corner and a FeedModel
 *  (./lifecycle.ts) to scroll it. With `maxLines` it becomes a constant-size
 *  scrolling console (pinned width + height, one truncated row per line). */
export function hudPanel(opts: HudPanelOptions): Panel {
  const style = mergeStyle(HUD_STYLE, opts.style);
  if (opts.width !== undefined) style.width = opts.width;
  if (opts.maxLines !== undefined) {
    style.maxLines = opts.maxLines;
    style.noWrap = true;
    const hasTitle = opts.title !== undefined && opts.title.length > 0;
    if (style.height === undefined) style.height = consoleHeight(style, opts.maxLines, hasTitle);
  }
  const text = opts.text ?? (opts.lines ?? []).join("\n");
  return new Panel({ style, text, title: opts.title, pixelScale: opts.pixelScale });
}
