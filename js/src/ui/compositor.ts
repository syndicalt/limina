// limina UI — styled-box compositor: border + background + (optional) title bar
// + padding + wrapped/colored/aligned multi-line text -> ONE RGBA buffer.
//
// This is the substrate every container kind (text box, speech/thought bubble,
// label, callout, HUD panel) composites through. It is pure CPU pixel work: no
// DOM, no 2D canvas, no GPU. The buffer it returns is uploaded as-is to a
// THREE.DataTexture by the Panel (./surface.ts). All blending is straight-alpha
// source-over, so layers (shadow -> bg -> title bar -> border -> text -> tail/
// puffs/callout) compose correctly over a transparent buffer.
//
// A1 implemented border + background + title + wrapped text + padding + sizing.
// A2 extends it with: rounded corners (border.radius), drop shadow, gradient bg,
// rich text runs (per-segment color/scale), and the bubble chrome that sticks
// OUT past the box — a triangular TAIL (speech bubble), trailing PUFFS (thought
// bubble), and a CALLOUT leader line to a target point. Anything that extends
// past the box widens the buffer via per-side margins; `Composited.box` reports
// where the box itself sits inside that buffer so anchoring can place the box,
// not the texture, at the target.

import { type Glyph, GLYPH_H, GLYPH_W, glyphFor } from "./font.ts";
import { layout, type LayoutResult, measureLine } from "./layout.ts";

/** 8-bit straight-alpha color. */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A color as either a packed 0xRRGGBB integer (opaque) or an explicit RGBA. */
export type ColorInput = number | RGBA;

/** Horizontal text alignment within the content box. */
export type Align = "left" | "center" | "right";

/** Per-side padding in composited px. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Frame stroke. `radius` rounds the corners (bg + border ring follow the arc);
 *  0 (default) keeps square corners (the A1 path). */
export interface BorderStyle {
  width: number;
  color: ColorInput;
  radius?: number;
}

/** Box fill. `opacity` (0..1, default 1) scales the fill alpha. */
export interface BackgroundStyle {
  color: ColorInput;
  opacity?: number;
}

/** Optional title/header bar with its own background. */
export interface TitleStyle {
  /** title text color (defaults to the body text color) */
  color?: ColorInput;
  /** header-bar fill (its own background, distinct from the body bg) */
  background?: ColorInput;
  /** header-bar fill opacity (0..1, default 1) */
  opacity?: number;
  /** fixed bar height in px; auto-sized from the title text when omitted */
  height?: number;
  /** title alignment within the bar (default "left") */
  align?: Align;
  /** title glyph scale (defaults to the body text scale) */
  scale?: number;
}

/** Body text run styling. */
export interface TextRunStyle {
  color?: ColorInput;
  /** integer glyph scale (>= 1, default 2) */
  scale?: number;
  align?: Align;
  /** full line-box advance in px; auto from scale when omitted */
  lineHeight?: number;
  /** extra px between glyphs (default 0) */
  letterSpacing?: number;
}

/** Drop shadow cast behind the box (offset + soft feather). A2. */
export interface ShadowStyle {
  /** shadow color (default black) */
  color?: ColorInput;
  /** horizontal offset in px (default 0) */
  offsetX?: number;
  /** vertical offset in px (default 4) */
  offsetY?: number;
  /** feather/blur radius in px (default 6) */
  blur?: number;
  /** peak opacity 0..1 (default 0.4) */
  opacity?: number;
}

export type GradientDirection = "vertical" | "horizontal";

/** Linear gradient background fill; overrides `background.color` when set. A2. */
export interface GradientStyle {
  from: ColorInput;
  to: ColorInput;
  /** gradient axis (default "vertical") */
  direction?: GradientDirection;
  /** fill opacity 0..1 (default 1) */
  opacity?: number;
}

/** A box edge. */
export type Side = "top" | "bottom" | "left" | "right";

/** Triangular tail/pointer extending OUTWARD from one edge (speech bubble). A2. */
export interface TailStyle {
  side: Side;
  /** tail base center along the edge, 0..1 (default 0.5) */
  offset?: number;
  /** apex distance outward from the edge in px (default 16) */
  length?: number;
  /** tail base width on the edge in px (default 18) */
  base?: number;
  /** fill color (defaults to the resolved background color) */
  color?: ColorInput;
  /** fill opacity 0..1 (defaults to 1) */
  opacity?: number;
}

/** Trailing circular puffs leading outward from one edge (thought bubble). A2. */
export interface PuffStyle {
  side: Side;
  /** puff trail position along the edge, 0..1 (default 0.5) */
  offset?: number;
  /** number of puffs (default 3) */
  count?: number;
  /** radius of the first (largest) puff in px (default 9) */
  startRadius?: number;
  /** extra gap between consecutive puff edges in px (default 3) */
  gap?: number;
  /** radius multiplier per successive puff, 0..1 (default 0.62) */
  shrink?: number;
  /** fill color (defaults to the resolved background color) */
  color?: ColorInput;
  /** fill opacity 0..1 (defaults to 1) */
  opacity?: number;
}

/** Leader line from a box edge to a target point (callout/annotation). A2. */
export interface CalloutStyle {
  side: Side;
  /** anchor position along the edge, 0..1 (default 0.5) */
  offset?: number;
  /** leader vector from the edge anchor to the target, px (x right, y DOWN) */
  dx: number;
  dy: number;
  /** line thickness in px (default 2) */
  width?: number;
  /** line color (defaults to the border color, else the text color) */
  color?: ColorInput;
  /** radius of a dot drawn at the target end, px; 0 disables (default 3) */
  dot?: number;
}

/** One styled inline segment for rich body text (per-segment color/scale). A2. */
export interface TextRun {
  text: string;
  color?: ColorInput;
  /** integer glyph scale; defaults to the body text scale */
  scale?: number;
}

/**
 * The expressive, validated style object every container shares. A1 implements
 * border + background + title + text + padding + sizing; A2 adds rounded corners
 * (`border.radius`), `shadow`, `gradient`, rich `runs`, and the bubble chrome
 * (`tail`/`puffs`/`callout`). A4 mirrors it as the Zod `ui.*` schema. Keep
 * additions optional so existing callers stay valid.
 */
export interface TextStyle {
  background?: BackgroundStyle;
  border?: BorderStyle;
  title?: TitleStyle;
  text?: TextRunStyle;
  /** inner padding around the text content (uniform number or per-side) */
  padding?: number | Insets;
  /** max OUTER width in px; body text word-wraps to fit inside the chrome */
  maxWidth?: number;
  /** fixed OUTER width in px; overrides auto-size (still wraps to fit) */
  width?: number;
  /** minimum OUTER width in px when auto-sizing */
  minWidth?: number;
  /** fixed OUTER height in px; overrides auto-size */
  height?: number;
  /** cap the number of WRAPPED body lines composited; when the wrapped text
   *  exceeds it, the LAST `maxLines` lines are kept (a scroll window to the
   *  newest content). Bounds the box height so a long line never grows an
   *  unbounded, screen-clipping column. Pairs with a Typewriter for reveal+
   *  scroll. Ignored on the rich-runs path. (P5-A bubble fit.) */
  maxLines?: number;
  /** Truncate each body line to ONE row (ellipsis) to fit the content width
   *  instead of word-wrapping — a fixed-size console feed where one line == one
   *  row, so a long line can never balloon the box. Ignored on the rich-runs
   *  path. Pairs with `maxLines` + `height` for a constant-size scrolling box. */
  noWrap?: boolean;
  /** drop shadow behind the box (A2) */
  shadow?: ShadowStyle;
  /** linear gradient background; overrides `background.color` (A2) */
  gradient?: GradientStyle;
  /** triangular tail/pointer — speech bubble (A2) */
  tail?: TailStyle;
  /** trailing puffs — thought bubble (A2) */
  puffs?: PuffStyle;
  /** leader line to a target point — callout (A2) */
  callout?: CalloutStyle;
  /** rich body text runs (per-segment color/scale); overrides `text` body (A2) */
  runs?: TextRun[];
}

/** The composited result: a tightly-packed RGBA8 buffer + its dimensions. */
export interface Composited {
  data: Uint8Array;
  width: number;
  height: number;
  /** where the styled box sits inside the buffer. With tail/puffs/callout/shadow
   *  extending past the box, the buffer grows by per-side margins and the box is
   *  inset by (x,y). Without those, this is the full buffer. */
  box: { x: number; y: number; width: number; height: number };
}

const DEFAULT_SCALE = 2;
const DEFAULT_TEXT: RGBA = { r: 255, g: 255, b: 255, a: 255 };

/** Normalize a ColorInput to RGBA. A packed int is opaque unless `alpha` given. */
export function toRGBA(color: ColorInput, alpha = 255): RGBA {
  if (typeof color === "number") {
    return { r: (color >> 16) & 0xff, g: (color >> 8) & 0xff, b: color & 0xff, a: alpha };
  }
  return { r: color.r, g: color.g, b: color.b, a: color.a };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function toInsets(padding: number | Insets | undefined): Insets {
  if (padding === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof padding === "number") return { top: padding, right: padding, bottom: padding, left: padding };
  return padding;
}

/** Straight-alpha source-over of (sr,sg,sb,sa) onto the pixel at byte `idx`. */
function blendPixel(buf: Uint8Array, idx: number, sr: number, sg: number, sb: number, sa: number): void {
  if (sa <= 0) return;
  if (sa >= 255) {
    buf[idx] = sr;
    buf[idx + 1] = sg;
    buf[idx + 2] = sb;
    buf[idx + 3] = 255;
    return;
  }
  const da = buf[idx + 3];
  if (da === 0) {
    buf[idx] = sr;
    buf[idx + 1] = sg;
    buf[idx + 2] = sb;
    buf[idx + 3] = sa;
    return;
  }
  const saf = sa / 255;
  const inv = 1 - saf;
  const daf = (da / 255) * inv;
  const outA = saf + daf;
  buf[idx] = Math.round((sr * saf + buf[idx] * daf) / outA);
  buf[idx + 1] = Math.round((sg * saf + buf[idx + 1] * daf) / outA);
  buf[idx + 2] = Math.round((sb * saf + buf[idx + 2] * daf) / outA);
  buf[idx + 3] = Math.round(outA * 255);
}

/** Blend a solid color over the half-open rect [x0,x1) x [y0,y1), clipped. */
function fillRect(buf: Uint8Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number, c: RGBA): void {
  const lx = Math.max(0, x0);
  const ly = Math.max(0, y0);
  const rx = Math.min(w, x1);
  const ry = Math.min(h, y1);
  for (let y = ly; y < ry; y++) {
    let idx = (y * w + lx) * 4;
    for (let x = lx; x < rx; x++) {
      blendPixel(buf, idx, c.r, c.g, c.b, c.a);
      idx += 4;
    }
  }
}

/** Stroke an inward border ring of width `bw` inside the outer rect, color `c`. */
function strokeBorder(buf: Uint8Array, w: number, h: number, bw: number, c: RGBA): void {
  if (bw <= 0) return;
  fillRect(buf, w, h, 0, 0, w, bw, c); // top
  fillRect(buf, w, h, 0, h - bw, w, h, c); // bottom
  fillRect(buf, w, h, 0, bw, bw, h - bw, c); // left
  fillRect(buf, w, h, w - bw, bw, w, h - bw, c); // right
}

/** Signed-distance coverage (1px AA) of a pixel center inside a rounded rect
 *  with per-corner radii (top-left, top-right, bottom-right, bottom-left). */
function roundRectCoverage(
  px: number, py: number,
  x0: number, y0: number, x1: number, y1: number,
  rTL: number, rTR: number, rBR: number, rBL: number,
): number {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hw = (x1 - x0) / 2;
  const hh = (y1 - y0) / 2;
  const right = px >= cx;
  const bottom = py >= cy;
  let r = right ? (bottom ? rBR : rTR) : (bottom ? rBL : rTL);
  r = Math.max(0, Math.min(r, hw, hh));
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  const sdf = outside + inside - r;
  return clamp01(0.5 - sdf);
}

/** Fill a rounded rect [x0,x1) x [y0,y1) with corner radii (uniform `r`, or only
 *  the top corners when `topOnly`). r<=0 falls back to the crisp square fill. */
function fillRoundedRect(
  buf: Uint8Array, w: number, h: number,
  x0: number, y0: number, x1: number, y1: number, r: number, c: RGBA, topOnly = false,
): void {
  if (r <= 0) {
    fillRect(buf, w, h, Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1), c);
    return;
  }
  const rBottom = topOnly ? 0 : r;
  const lx = Math.max(0, Math.floor(x0));
  const ly = Math.max(0, Math.floor(y0));
  const rx = Math.min(w, Math.ceil(x1));
  const ry = Math.min(h, Math.ceil(y1));
  for (let y = ly; y < ry; y++) {
    for (let x = lx; x < rx; x++) {
      const cov = roundRectCoverage(x + 0.5, y + 0.5, x0, y0, x1, y1, r, r, rBottom, rBottom);
      if (cov <= 0) continue;
      blendPixel(buf, (y * w + x) * 4, c.r, c.g, c.b, Math.round(c.a * cov));
    }
  }
}

/** Stroke a rounded border ring of width `bw` between the outer rect and its
 *  inward inset, color `c`. r<=0 reduces to the square 4-rect ring. */
function strokeRoundedBorder(
  buf: Uint8Array, w: number, h: number,
  x0: number, y0: number, x1: number, y1: number, bw: number, r: number, c: RGBA,
): void {
  if (bw <= 0) return;
  if (r <= 0) {
    fillRect(buf, w, h, x0, y0, x1, y0 + bw, c); // top
    fillRect(buf, w, h, x0, y1 - bw, x1, y1, c); // bottom
    fillRect(buf, w, h, x0, y0 + bw, x0 + bw, y1 - bw, c); // left
    fillRect(buf, w, h, x1 - bw, y0 + bw, x1, y1 - bw, c); // right
    return;
  }
  const ri = Math.max(0, r - bw);
  const lx = Math.max(0, Math.floor(x0));
  const ly = Math.max(0, Math.floor(y0));
  const rx = Math.min(w, Math.ceil(x1));
  const ry = Math.min(h, Math.ceil(y1));
  for (let y = ly; y < ry; y++) {
    for (let x = lx; x < rx; x++) {
      const outer = roundRectCoverage(x + 0.5, y + 0.5, x0, y0, x1, y1, r, r, r, r);
      if (outer <= 0) continue;
      const inner = roundRectCoverage(x + 0.5, y + 0.5, x0 + bw, y0 + bw, x1 - bw, y1 - bw, ri, ri, ri, ri);
      const cov = outer * (1 - inner);
      if (cov <= 0) continue;
      blendPixel(buf, (y * w + x) * 4, c.r, c.g, c.b, Math.round(c.a * cov));
    }
  }
}

/** Fill the inner rect with a linear gradient (vertical or horizontal), clipped
 *  to an optional rounded shape (`r` > 0). */
function fillGradient(
  buf: Uint8Array, w: number, h: number,
  x0: number, y0: number, x1: number, y1: number, r: number,
  from: RGBA, to: RGBA, dir: GradientDirection,
): void {
  const lx = Math.max(0, Math.floor(x0));
  const ly = Math.max(0, Math.floor(y0));
  const rx = Math.min(w, Math.ceil(x1));
  const ry = Math.min(h, Math.ceil(y1));
  const span = dir === "horizontal" ? (x1 - x0) : (y1 - y0);
  for (let y = ly; y < ry; y++) {
    for (let x = lx; x < rx; x++) {
      const cov = r > 0 ? roundRectCoverage(x + 0.5, y + 0.5, x0, y0, x1, y1, r, r, r, r) : 1;
      if (cov <= 0) continue;
      const t = span <= 0 ? 0 : clamp01((dir === "horizontal" ? (x + 0.5 - x0) : (y + 0.5 - y0)) / span);
      const cr = Math.round(from.r + (to.r - from.r) * t);
      const cg = Math.round(from.g + (to.g - from.g) * t);
      const cb = Math.round(from.b + (to.b - from.b) * t);
      const ca = Math.round((from.a + (to.a - from.a) * t) * cov);
      blendPixel(buf, (y * w + x) * 4, cr, cg, cb, ca);
    }
  }
}

/** Fill a disc centered at (cx,cy) radius `rad` with 1px AA. */
function fillCircle(buf: Uint8Array, w: number, h: number, cx: number, cy: number, rad: number, c: RGBA): void {
  const lx = Math.max(0, Math.floor(cx - rad - 1));
  const ly = Math.max(0, Math.floor(cy - rad - 1));
  const rx = Math.min(w, Math.ceil(cx + rad + 1));
  const ry = Math.min(h, Math.ceil(cy + rad + 1));
  for (let y = ly; y < ry; y++) {
    for (let x = lx; x < rx; x++) {
      const cov = clamp01(rad + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy));
      if (cov <= 0) continue;
      blendPixel(buf, (y * w + x) * 4, c.r, c.g, c.b, Math.round(c.a * cov));
    }
  }
}

/** Fill a triangle (3 points) via the half-plane edge test. */
function fillTriangle(
  buf: Uint8Array, w: number, h: number,
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number, c: RGBA,
): void {
  const minx = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const miny = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const maxx = Math.min(w, Math.ceil(Math.max(ax, bx, cx)));
  const maxy = Math.min(h, Math.ceil(Math.max(ay, by, cy)));
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (area === 0) return;
  const s = area > 0 ? 1 : -1;
  for (let y = miny; y < maxy; y++) {
    for (let x = minx; x < maxx; x++) {
      const pxx = x + 0.5;
      const pyy = y + 0.5;
      const e0 = ((bx - ax) * (pyy - ay) - (by - ay) * (pxx - ax)) * s;
      const e1 = ((cx - bx) * (pyy - by) - (cy - by) * (pxx - bx)) * s;
      const e2 = ((ax - cx) * (pyy - cy) - (ay - cy) * (pxx - cx)) * s;
      if (e0 >= 0 && e1 >= 0 && e2 >= 0) blendPixel(buf, (y * w + x) * 4, c.r, c.g, c.b, c.a);
    }
  }
}

/** Draw a thick line segment from (x0,y0) to (x1,y1), thickness `t`, color c. */
function drawLine(
  buf: Uint8Array, w: number, h: number,
  x0: number, y0: number, x1: number, y1: number, t: number, c: RGBA,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return;
  const half = t / 2;
  const minx = Math.max(0, Math.floor(Math.min(x0, x1) - half - 1));
  const miny = Math.max(0, Math.floor(Math.min(y0, y1) - half - 1));
  const maxx = Math.min(w, Math.ceil(Math.max(x0, x1) + half + 1));
  const maxy = Math.min(h, Math.ceil(Math.max(y0, y1) + half + 1));
  for (let y = miny; y < maxy; y++) {
    for (let x = minx; x < maxx; x++) {
      const px = x + 0.5 - x0;
      const py = y + 0.5 - y0;
      const proj = clamp01((px * dx + py * dy) / len2);
      const dist = Math.hypot(px - proj * dx, py - proj * dy);
      const cov = clamp01(half + 0.5 - dist);
      if (cov <= 0) continue;
      blendPixel(buf, (y * w + x) * 4, c.r, c.g, c.b, Math.round(c.a * cov));
    }
  }
}

/** Blit one glyph at composited (penX, topY), scaled, blended with `color`. */
function blitGlyph(
  buf: Uint8Array,
  w: number,
  h: number,
  glyph: Glyph,
  penX: number,
  topY: number,
  scale: number,
  color: RGBA,
): void {
  const ca = color.a / 255;
  for (let sy = 0; sy < glyph.height; sy++) {
    for (let sx = 0; sx < glyph.width; sx++) {
      const cov = glyph.alpha[sy * GLYPH_W + sx];
      if (cov === 0) continue;
      const sa = Math.round(cov * ca);
      if (sa === 0) continue;
      const px0 = penX + sx * scale;
      const py0 = topY + sy * scale;
      for (let dy = 0; dy < scale; dy++) {
        const py = py0 + dy;
        if (py < 0 || py >= h) continue;
        for (let dx = 0; dx < scale; dx++) {
          const px = px0 + dx;
          if (px < 0 || px >= w) continue;
          blendPixel(buf, (py * w + px) * 4, color.r, color.g, color.b, sa);
        }
      }
    }
  }
}

/** Blit a single line of text starting at composited (originX, topY). */
function blitLine(
  buf: Uint8Array,
  w: number,
  h: number,
  text: string,
  originX: number,
  topY: number,
  scale: number,
  letterSpacing: number,
  color: RGBA,
): void {
  let penX = originX;
  const advance = GLYPH_W * scale + letterSpacing;
  for (let i = 0; i < text.length; i++) {
    blitGlyph(buf, w, h, glyphFor(text.charCodeAt(i)), penX, topY, scale, color);
    penX += advance;
  }
}

function alignOffset(align: Align, contentWidth: number, lineWidth: number): number {
  if (align === "center") return Math.round((contentWidth - lineWidth) / 2);
  if (align === "right") return contentWidth - lineWidth;
  return 0;
}

// ---- rich runs (per-segment color/scale, word-wrapped) ---------------------

interface RunToken {
  text: string;
  color: RGBA;
  scale: number;
  /** x offset within the line (scaled px) */
  x: number;
}
interface RunLine {
  tokens: RunToken[];
  top: number;
  width: number;
}
interface RunLayout {
  lines: RunLine[];
  width: number;
  height: number;
}

/** Lay out rich runs into positioned, per-token-colored lines. Words are atomic
 *  for color (the common case: "PERCEIVE" green, "ok" gray); a single space gap
 *  separates consecutive words; "\n" forces a break; words wrap to `maxWidth`. */
function layoutRuns(
  runs: TextRun[],
  baseScale: number,
  baseColor: RGBA,
  letterSpacing: number,
  lineHeight: number,
  maxWidth: number | undefined,
): RunLayout {
  interface Word {
    text: string;
    color: RGBA;
    scale: number;
    newline: boolean;
  }
  const words: Word[] = [];
  for (const run of runs) {
    const color = run.color !== undefined ? toRGBA(run.color) : baseColor;
    const scale = Math.max(1, Math.floor(run.scale ?? baseScale));
    for (const part of run.text.split("\n")) {
      if (words.length > 0 && words[words.length - 1].text !== "") {
        // a "\n" boundary between parts forces a break (except before the first)
      }
      const segWords = part.split(" ").filter((s) => s !== "");
      for (const wtxt of segWords) words.push({ text: wtxt, color, scale, newline: false });
      // mark the paragraph break that follows this `part` (the split point)
      words.push({ text: "", color, scale, newline: true });
    }
    // the trailing newline from the last split is bogus; drop it
    if (words.length > 0 && words[words.length - 1].newline) words.pop();
  }

  const spaceW = GLYPH_W * baseScale + letterSpacing;
  const lines: RunLine[] = [];
  let cur: RunLine = { tokens: [], top: 0, width: 0 };
  let penX = 0;
  let topY = 0;
  const flush = (): void => {
    cur.width = penX;
    lines.push(cur);
    topY += lineHeight;
    cur = { tokens: [], top: topY, width: 0 };
    penX = 0;
  };
  for (const wd of words) {
    if (wd.newline) {
      flush();
      continue;
    }
    const wWidth = measureLine(wd.text, wd.scale, letterSpacing);
    const startX = penX > 0 ? penX + spaceW : 0;
    if (maxWidth !== undefined && maxWidth > 0 && penX > 0 && startX + wWidth > maxWidth) {
      flush();
      cur.tokens.push({ text: wd.text, color: wd.color, scale: wd.scale, x: 0 });
      penX = wWidth;
    } else {
      cur.tokens.push({ text: wd.text, color: wd.color, scale: wd.scale, x: startX });
      penX = startX + wWidth;
    }
  }
  flush();

  let width = 0;
  for (const ln of lines) if (ln.width > width) width = ln.width;
  const height = lines.length > 0 ? (lines.length - 1) * lineHeight + GLYPH_H * baseScale : 0;
  return { lines, width, height };
}

// ---- box sizing (shared by every container) --------------------------------

interface BoxLayout {
  scale: number;
  letterSpacing: number;
  lineHeight: number;
  align: Align;
  textColor: RGBA;
  bw: number;
  pad: Insets;
  radius: number;
  hasTitle: boolean;
  titleScale: number;
  titleColor: RGBA;
  titleLayout: LayoutResult | undefined;
  titleWidth: number;
  titleBarH: number;
  body: LayoutResult | undefined;
  runLayout: RunLayout | undefined;
  boxW: number;
  boxH: number;
  innerW: number;
}

/** Keep only the last `maxLines` wrapped lines, re-based so the first kept line
 *  sits at top 0; recompute the block height. A scroll window to the NEWEST
 *  content, so a Typewriter reveal scrolls upward once it overruns the cap. */
function clampToLastLines(body: LayoutResult, maxLines: number, lineHeight: number): LayoutResult {
  const kept = body.lines.slice(body.lines.length - maxLines);
  const base = kept[0]?.top ?? 0;
  const lines = kept.map((l) => ({ text: l.text, width: l.width, top: l.top - base, baseline: l.baseline - base }));
  const height = (lines.length - 1) * lineHeight + body.glyphH;
  return { ...body, lines, height };
}

function sizeBox(style: TextStyle, text: string, title: string | undefined): BoxLayout {
  const run = style.text ?? {};
  const scale = Math.max(1, Math.floor(run.scale ?? DEFAULT_SCALE));
  const letterSpacing = run.letterSpacing ?? 0;
  const lineHeight = run.lineHeight ?? scaledLineHeight(scale);
  const align: Align = run.align ?? "left";
  const textColor = toRGBA(run.color ?? DEFAULT_TEXT);

  const bw = Math.max(0, Math.floor(style.border?.width ?? 0));
  const pad = toInsets(style.padding);
  const radius = Math.max(0, Math.floor(style.border?.radius ?? 0));

  const hasTitle = title !== undefined && title.length > 0;
  const titleScale = hasTitle ? Math.max(1, Math.floor(style.title?.scale ?? scale)) : 0;
  const titleColor = toRGBA(style.title?.color ?? run.color ?? DEFAULT_TEXT);

  const chromeX = 2 * bw + pad.left + pad.right;
  let wrapWidth: number | undefined;
  if (style.width !== undefined) wrapWidth = style.width - chromeX;
  else if (style.maxWidth !== undefined) wrapWidth = style.maxWidth - chromeX;

  const hasRuns = style.runs !== undefined && style.runs.length > 0;
  let body = hasRuns ? undefined : layout(text, { scale, letterSpacing, lineHeight, maxWidth: wrapWidth, noWrap: style.noWrap });
  // Bound the body to `maxLines` wrapped lines (the LAST N — a scroll window to
  // the newest content) so a long line yields a fixed-height box, never an
  // unbounded, screen-clipping column. Rich runs keep their own flow.
  if (body !== undefined && style.maxLines !== undefined && style.maxLines > 0 && body.lines.length > style.maxLines) {
    body = clampToLastLines(body, style.maxLines, lineHeight);
  }
  const runLayout = hasRuns
    ? layoutRuns(style.runs as TextRun[], scale, textColor, letterSpacing, lineHeight, wrapWidth)
    : undefined;
  const bodyW = hasRuns ? (runLayout as RunLayout).width : (body as LayoutResult).width;
  const bodyH = hasRuns ? (runLayout as RunLayout).height : (body as LayoutResult).height;

  let titleWidth = 0;
  let titleLayout: LayoutResult | undefined;
  if (hasTitle) {
    titleLayout = layout(title as string, { scale: titleScale, letterSpacing, lineHeight: scaledLineHeight(titleScale) });
    titleWidth = titleLayout.width;
  }
  const titleBarH = hasTitle ? (style.title?.height ?? scaledLineHeight(titleScale) + 2 * titleScale) : 0;

  const contentWidth = Math.max(bodyW, titleWidth);
  let boxW = style.width ?? chromeX + contentWidth;
  if (style.minWidth !== undefined) boxW = Math.max(boxW, style.minWidth);
  boxW = Math.max(boxW, 2 * bw + 1);
  const bodyAreaH = bw + titleBarH + pad.top + bodyH + pad.bottom + bw;
  const boxH = Math.max(style.height ?? bodyAreaH, 2 * bw + 1);
  const innerW = boxW - 2 * bw;

  return {
    scale, letterSpacing, lineHeight, align, textColor, bw, pad, radius,
    hasTitle, titleScale, titleColor, titleLayout, titleWidth, titleBarH,
    body, runLayout, boxW, boxH, innerW,
  };
}

/** Fixed OUTER height (px) of a console-style box showing exactly `lines` body
 *  rows under `style` (border + optional title bar + padding + N line-boxes).
 *  Pin `style.height` to this for a constant-size scrolling console whose box
 *  never grows as feed lines stream. Mirrors sizeBox's vertical metrics. */
export function consoleHeight(style: TextStyle, lines: number, hasTitle: boolean): number {
  const run = style.text ?? {};
  const scale = Math.max(1, Math.floor(run.scale ?? DEFAULT_SCALE));
  const lineHeight = run.lineHeight ?? scaledLineHeight(scale);
  const glyphH = GLYPH_H * scale;
  const bw = Math.max(0, Math.floor(style.border?.width ?? 0));
  const pad = toInsets(style.padding);
  const titleScale = Math.max(1, Math.floor(style.title?.scale ?? scale));
  const titleBarH = hasTitle ? (style.title?.height ?? scaledLineHeight(titleScale) + 2 * titleScale) : 0;
  const n = Math.max(1, Math.floor(lines));
  const bodyH = (n - 1) * lineHeight + glyphH;
  return bw + titleBarH + pad.top + bodyH + pad.bottom + bw;
}

// ---- bubble chrome geometry ------------------------------------------------

interface PuffGeom {
  radii: number[];
  dist: number[];
  extent: number;
}
function puffGeom(p: PuffStyle): PuffGeom {
  const count = Math.max(1, Math.floor(p.count ?? 3));
  const start = p.startRadius ?? 9;
  const gap = p.gap ?? 3;
  const shrink = p.shrink ?? 0.62;
  const radii: number[] = [];
  let r = start;
  for (let i = 0; i < count; i++) {
    radii.push(r);
    r = Math.max(2, r * shrink);
  }
  const dist: number[] = [];
  for (let i = 0; i < count; i++) {
    dist[i] = i === 0 ? radii[0] : dist[i - 1] + radii[i - 1] + gap + radii[i];
  }
  return { radii, dist, extent: dist[count - 1] + radii[count - 1] };
}

function edgeAnchor(side: Side, offset: number, boxW: number, boxH: number): { x: number; y: number } {
  const t = clamp01(offset);
  if (side === "top") return { x: t * boxW, y: 0 };
  if (side === "bottom") return { x: t * boxW, y: boxH };
  if (side === "left") return { x: 0, y: t * boxH };
  return { x: boxW, y: t * boxH };
}

function sideNormal(side: Side): { x: number; y: number } {
  if (side === "top") return { x: 0, y: -1 };
  if (side === "bottom") return { x: 0, y: 1 };
  if (side === "left") return { x: -1, y: 0 };
  return { x: 1, y: 0 };
}

interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

function computeMargins(style: TextStyle, boxW: number, boxH: number): Margins {
  const m: Margins = { top: 0, right: 0, bottom: 0, left: 0 };
  const grow = (side: Side, amt: number): void => {
    if (side === "top") m.top = Math.max(m.top, amt);
    else if (side === "bottom") m.bottom = Math.max(m.bottom, amt);
    else if (side === "left") m.left = Math.max(m.left, amt);
    else m.right = Math.max(m.right, amt);
  };
  if (style.shadow) {
    const ox = style.shadow.offsetX ?? 0;
    const oy = style.shadow.offsetY ?? 4;
    const blur = Math.max(0, style.shadow.blur ?? 6);
    m.right = Math.max(m.right, Math.max(0, ox) + blur);
    m.left = Math.max(m.left, Math.max(0, -ox) + blur);
    m.bottom = Math.max(m.bottom, Math.max(0, oy) + blur);
    m.top = Math.max(m.top, Math.max(0, -oy) + blur);
  }
  if (style.tail) grow(style.tail.side, style.tail.length ?? 16);
  if (style.puffs) grow(style.puffs.side, puffGeom(style.puffs).extent);
  if (style.callout) {
    const c = style.callout;
    const pad = (c.width ?? 2) / 2 + (c.dot ?? 3) + 1;
    const a = edgeAnchor(c.side, c.offset ?? 0.5, boxW, boxH);
    const tx = a.x + c.dx;
    const ty = a.y + c.dy;
    if (tx > boxW) m.right = Math.max(m.right, tx - boxW + pad);
    if (tx < 0) m.left = Math.max(m.left, -tx + pad);
    if (ty > boxH) m.bottom = Math.max(m.bottom, ty - boxH + pad);
    if (ty < 0) m.top = Math.max(m.top, -ty + pad);
  }
  m.top = Math.ceil(m.top);
  m.right = Math.ceil(m.right);
  m.bottom = Math.ceil(m.bottom);
  m.left = Math.ceil(m.left);
  return m;
}

/** Resolve the box's effective fill color (gradient `from` or solid bg), with
 *  opacity applied — used to fill tail/puffs so they match the bubble body. */
function resolvedFill(style: TextStyle): RGBA {
  if (style.gradient) {
    const f = toRGBA(style.gradient.from);
    return { r: f.r, g: f.g, b: f.b, a: Math.round(f.a * (style.gradient.opacity ?? 1)) };
  }
  if (style.background) {
    const base = toRGBA(style.background.color);
    return { r: base.r, g: base.g, b: base.b, a: Math.round(base.a * (style.background.opacity ?? 1)) };
  }
  return { r: 0, g: 0, b: 0, a: 0 };
}

/**
 * Composite a styled box for `text` (with an optional `title`) into one RGBA8
 * buffer. Auto-sizes to content unless `style.width`/`style.height` pin it. The
 * square, no-extension path (no radius/shadow/gradient/runs/tail/puffs/callout)
 * is the A1 layering exactly; extensions add layers + grow the buffer.
 */
export function composite(style: TextStyle, text: string, title?: string): Composited {
  const L = sizeBox(style, text, title);
  const m = computeMargins(style, L.boxW, L.boxH);

  const ox = m.left;
  const oy = m.top;
  const width = m.left + L.boxW + m.right;
  const height = m.top + L.boxH + m.bottom;
  const data = new Uint8Array(width * height * 4);

  const bx0 = ox;
  const by0 = oy;
  const bx1 = ox + L.boxW;
  const by1 = oy + L.boxH;
  const bw = L.bw;
  const radius = L.radius;
  const rounded = radius > 0;
  const hasBorder = bw > 0 && style.border !== undefined;

  // Layer 0: drop shadow behind the box.
  if (style.shadow) drawShadow(data, width, height, bx0, by0, bx1, by1, radius, style.shadow);

  // Layers 1-3: frame / background / title bar. Rounded boxes draw the border
  // as a filled frame then the interior on top; square boxes keep the A1 order
  // (bg, title bar, border ring on top) so A1 output is byte-identical.
  const ir = Math.max(0, radius - bw);
  if (rounded) {
    if (hasBorder) fillRoundedRect(data, width, height, bx0, by0, bx1, by1, radius, toRGBA((style.border as BorderStyle).color));
    drawInterior(data, width, height, bx0 + bw, by0 + bw, bx1 - bw, by1 - bw, ir, style);
    if (L.hasTitle && style.title?.background !== undefined) {
      const base = toRGBA(style.title.background);
      const titleBg: RGBA = { r: base.r, g: base.g, b: base.b, a: Math.round(base.a * (style.title.opacity ?? 1)) };
      fillRoundedRect(data, width, height, bx0 + bw, by0 + bw, bx1 - bw, by0 + bw + L.titleBarH, ir, titleBg, true);
    }
  } else {
    drawInterior(data, width, height, bx0 + bw, by0 + bw, bx1 - bw, by1 - bw, 0, style);
    if (L.hasTitle && style.title?.background !== undefined) {
      const base = toRGBA(style.title.background);
      const titleBg: RGBA = { r: base.r, g: base.g, b: base.b, a: Math.round(base.a * (style.title.opacity ?? 1)) };
      fillRect(data, width, height, bx0 + bw, by0 + bw, bx1 - bw, by0 + bw + L.titleBarH, titleBg);
    }
    if (hasBorder) {
      strokeRoundedBorder(data, width, height, bx0, by0, bx1, by1, bw, 0, toRGBA((style.border as BorderStyle).color));
    }
  }

  // Layer 4: title text, vertically centered in the bar.
  if (L.hasTitle && L.titleLayout !== undefined) {
    const tAlign: Align = style.title?.align ?? "left";
    const tContentW = L.innerW - L.pad.left - L.pad.right;
    const tx = bx0 + bw + L.pad.left + alignOffset(tAlign, tContentW, L.titleWidth);
    const ty = by0 + bw + Math.round((L.titleBarH - scaledLineHeight(L.titleScale)) / 2);
    blitLine(data, width, height, L.titleLayout.lines[0]?.text ?? "", tx, ty, L.titleScale, L.letterSpacing, L.titleColor);
  }

  // Layer 5: body text (rich runs or plain wrapped lines), under the title bar.
  const originX = bx0 + bw + L.pad.left;
  const originY = by0 + bw + L.titleBarH + L.pad.top;
  const contentW = L.innerW - L.pad.left - L.pad.right;
  if (L.runLayout !== undefined) {
    for (const ln of L.runLayout.lines) {
      const lineOff = alignOffset(L.align, contentW, ln.width);
      for (const tk of ln.tokens) {
        blitLine(data, width, height, tk.text, originX + lineOff + tk.x, originY + ln.top, tk.scale, L.letterSpacing, tk.color);
      }
    }
  } else if (L.body !== undefined) {
    for (const line of L.body.lines) {
      const x = originX + alignOffset(L.align, contentW, line.width);
      blitLine(data, width, height, line.text, x, originY + line.top, L.scale, L.letterSpacing, L.textColor);
    }
  }

  // Layer 6: bubble chrome that sticks out past the box.
  const fill = resolvedFill(style);
  const borderColor = hasBorder ? toRGBA((style.border as BorderStyle).color) : undefined;
  if (style.tail) drawTail(data, width, height, bx0, by0, bx1, by1, style.tail, fill, bw, borderColor);
  if (style.puffs) drawPuffs(data, width, height, bx0, by0, bx1, by1, style.puffs, fill);
  if (style.callout) {
    const fallback = borderColor ?? L.textColor;
    drawCallout(data, width, height, bx0, by0, bx1, by1, style.callout, fallback);
  }

  return { data, width, height, box: { x: ox, y: oy, width: L.boxW, height: L.boxH } };
}

/** Fill the interior (gradient overrides solid background), with corner radius `r`. */
function drawInterior(
  buf: Uint8Array, w: number, h: number,
  x0: number, y0: number, x1: number, y1: number, r: number, style: TextStyle,
): void {
  if (style.gradient) {
    const from = toRGBA(style.gradient.from);
    const to = toRGBA(style.gradient.to);
    const op = style.gradient.opacity ?? 1;
    from.a = Math.round(from.a * op);
    to.a = Math.round(to.a * op);
    fillGradient(buf, w, h, x0, y0, x1, y1, r, from, to, style.gradient.direction ?? "vertical");
  } else if (style.background) {
    const base = toRGBA(style.background.color);
    const bg: RGBA = { r: base.r, g: base.g, b: base.b, a: Math.round(base.a * (style.background.opacity ?? 1)) };
    if (r > 0) fillRoundedRect(buf, w, h, x0, y0, x1, y1, r, bg);
    else fillRect(buf, w, h, x0, y0, x1, y1, bg);
  }
}

/** Soft drop shadow: a rounded-rect SDF feathered over `blur` px, offset. */
function drawShadow(
  buf: Uint8Array, w: number, h: number,
  x0: number, y0: number, x1: number, y1: number, radius: number, sh: ShadowStyle,
): void {
  const ox = sh.offsetX ?? 0;
  const oy = sh.offsetY ?? 4;
  const blur = Math.max(0, sh.blur ?? 6);
  const op = sh.opacity ?? 0.4;
  const base = toRGBA(sh.color ?? { r: 0, g: 0, b: 0, a: 255 });
  const cx0 = x0 + ox;
  const cy0 = y0 + oy;
  const cx1 = x1 + ox;
  const cy1 = y1 + oy;
  const lx = Math.max(0, Math.floor(cx0 - blur));
  const ly = Math.max(0, Math.floor(cy0 - blur));
  const rx = Math.min(w, Math.ceil(cx1 + blur));
  const ry = Math.min(h, Math.ceil(cy1 + blur));
  const r = Math.max(0, radius);
  for (let y = ly; y < ry; y++) {
    for (let x = lx; x < rx; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const ccx = (cx0 + cx1) / 2;
      const ccy = (cy0 + cy1) / 2;
      const hw = (cx1 - cx0) / 2;
      const hh = (cy1 - cy0) / 2;
      const rr = Math.max(0, Math.min(r, hw, hh));
      const qx = Math.abs(px - ccx) - (hw - rr);
      const qy = Math.abs(py - ccy) - (hh - rr);
      const sdf = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr;
      const cov = blur <= 0 ? (sdf < 0.5 ? 1 : 0) : clamp01(1 - sdf / blur);
      if (cov <= 0) continue;
      blendPixel(buf, (y * w + x) * 4, base.r, base.g, base.b, Math.round(base.a * op * cov));
    }
  }
}

/** Triangular tail: base on the edge, apex `length` px outward, optional outline. */
function drawTail(
  buf: Uint8Array, w: number, h: number,
  bx0: number, by0: number, bx1: number, by1: number,
  t: TailStyle, fill: RGBA, bw: number, borderColor: RGBA | undefined,
): void {
  const len = t.length ?? 16;
  const base = t.base ?? 18;
  const off = clamp01(t.offset ?? 0.5);
  const c = t.color !== undefined ? toRGBA(t.color) : fill;
  const col: RGBA = { r: c.r, g: c.g, b: c.b, a: Math.round(c.a * (t.opacity ?? 1)) };
  let ax1: number, ay1: number, ax2: number, ay2: number, apx: number, apy: number;
  if (t.side === "bottom") {
    const cx = bx0 + off * (bx1 - bx0);
    ax1 = cx - base / 2; ay1 = by1; ax2 = cx + base / 2; ay2 = by1; apx = cx; apy = by1 + len;
  } else if (t.side === "top") {
    const cx = bx0 + off * (bx1 - bx0);
    ax1 = cx - base / 2; ay1 = by0; ax2 = cx + base / 2; ay2 = by0; apx = cx; apy = by0 - len;
  } else if (t.side === "left") {
    const cy = by0 + off * (by1 - by0);
    ax1 = bx0; ay1 = cy - base / 2; ax2 = bx0; ay2 = cy + base / 2; apx = bx0 - len; apy = cy;
  } else {
    const cy = by0 + off * (by1 - by0);
    ax1 = bx1; ay1 = cy - base / 2; ax2 = bx1; ay2 = cy + base / 2; apx = bx1 + len; apy = cy;
  }
  fillTriangle(buf, w, h, ax1, ay1, ax2, ay2, apx, apy, col);
  if (borderColor !== undefined && bw > 0) {
    drawLine(buf, w, h, ax1, ay1, apx, apy, bw, borderColor);
    drawLine(buf, w, h, ax2, ay2, apx, apy, bw, borderColor);
  }
}

/** Trailing puffs: decreasing discs marching outward along the edge normal. */
function drawPuffs(
  buf: Uint8Array, w: number, h: number,
  bx0: number, by0: number, bx1: number, by1: number,
  p: PuffStyle, fill: RGBA,
): void {
  const g = puffGeom(p);
  const a = edgeAnchor(p.side, p.offset ?? 0.5, bx1 - bx0, by1 - by0);
  const ax = bx0 + a.x;
  const ay = by0 + a.y;
  const n = sideNormal(p.side);
  const c = p.color !== undefined ? toRGBA(p.color) : fill;
  const col: RGBA = { r: c.r, g: c.g, b: c.b, a: Math.round(c.a * (p.opacity ?? 1)) };
  for (let i = 0; i < g.radii.length; i++) {
    fillCircle(buf, w, h, ax + n.x * g.dist[i], ay + n.y * g.dist[i], g.radii[i], col);
  }
}

/** Leader line from an edge anchor to a target point + a dot at the target. */
function drawCallout(
  buf: Uint8Array, w: number, h: number,
  bx0: number, by0: number, bx1: number, by1: number,
  c: CalloutStyle, fallback: RGBA,
): void {
  const a = edgeAnchor(c.side, c.offset ?? 0.5, bx1 - bx0, by1 - by0);
  const ax = bx0 + a.x;
  const ay = by0 + a.y;
  const tx = ax + c.dx;
  const ty = ay + c.dy;
  const col = c.color !== undefined ? toRGBA(c.color) : fallback;
  drawLine(buf, w, h, ax, ay, tx, ty, c.width ?? 2, col);
  const dot = c.dot ?? 3;
  if (dot > 0) fillCircle(buf, w, h, tx, ty, dot, col);
}

/** Default line-box height for a scale: glyph cell + a little leading. */
function scaledLineHeight(scale: number): number {
  return GLYPH_H * scale + 2 * scale;
}
