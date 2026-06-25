// limina UI — text measurement + word-wrap layout over the embedded bitmap font.
//
// Pure, deterministic, no DOM. Turns a string + a scale/spacing/line-height into
// a list of line boxes (text + width + top/baseline offsets) that the compositor
// blits. Word-wrap respects explicit "\n", wraps on spaces to a max content
// width, and hard-breaks any single word that cannot fit. The font is monospace,
// so measurement is a multiply; this module stays font-agnostic via the metrics.

import { GLYPH_ADVANCE, GLYPH_BASELINE, GLYPH_H } from "./font.ts";

/** Layout inputs in *scaled* (composited) pixels. `scale` multiplies the source
 *  glyph metrics; `letterSpacing` is extra space between glyphs; `lineHeight` is
 *  the full line-box advance; `maxWidth` (content px) bounds word-wrap. */
export interface LayoutOptions {
  scale: number;
  letterSpacing: number;
  lineHeight: number;
  maxWidth?: number;
  /** Truncate each line to one row (ellipsis) to fit `maxWidth` instead of
   *  word-wrapping — a fixed-height console feed where one line == one row. */
  noWrap?: boolean;
}

/** One laid-out line. `width` is the rendered width in scaled px; `top` is the
 *  line-box top and `baseline` the text baseline, both measured from the text
 *  block's top edge in scaled px. */
export interface LineBox {
  text: string;
  width: number;
  top: number;
  baseline: number;
}

/** Result of laying out a paragraph: the line boxes plus the block's overall
 *  scaled width/height and the resolved scaled glyph metrics. */
export interface LayoutResult {
  lines: LineBox[];
  width: number;
  height: number;
  glyphW: number;
  glyphH: number;
  advance: number;
  baseline: number;
}

/** Width in scaled px of `n` glyphs at this scale + letter spacing. */
export function measureChars(n: number, scale: number, letterSpacing: number): number {
  if (n <= 0) return 0;
  return n * GLYPH_ADVANCE * scale + (n - 1) * letterSpacing;
}

/** Width in scaled px of a single line of text. */
export function measureLine(text: string, scale: number, letterSpacing: number): number {
  return measureChars(text.length, scale, letterSpacing);
}

/** Truncate `text` to a SINGLE line that fits `maxWidth` (content px), appending
 *  an ASCII "..." ellipsis when it overflows; returns `text` unchanged when it
 *  already fits. Used by the fixed-size console feed so one event == one row and
 *  a long line can never balloon the box. The ellipsis is ASCII because the
 *  embedded font covers only 0x20..0x7E (a Unicode "…" would fall back to "?"). */
export function truncateToWidth(text: string, maxWidth: number, scale: number, letterSpacing: number): string {
  if (maxWidth <= 0 || measureLine(text, scale, letterSpacing) <= maxWidth) return text;
  const ellipsis = "...";
  for (let n = text.length - 1; n > 0; n--) {
    const candidate = text.slice(0, n) + ellipsis;
    if (measureLine(candidate, scale, letterSpacing) <= maxWidth) return candidate;
  }
  // Not even one char + the ellipsis fits: keep as many raw chars as do.
  let m = text.length;
  while (m > 0 && measureLine(text.slice(0, m), scale, letterSpacing) > maxWidth) m--;
  return text.slice(0, m);
}

/** Hard-break a single word that exceeds `maxWidth` into chunks that each fit,
 *  appending all-but-the-last to `out` and returning the trailing remainder. */
function hardBreak(word: string, maxWidth: number, scale: number, letterSpacing: number, out: string[]): string {
  let chunk = "";
  for (const ch of word) {
    const next = chunk + ch;
    if (chunk !== "" && measureLine(next, scale, letterSpacing) > maxWidth) {
      out.push(chunk);
      chunk = ch;
    } else {
      chunk = next;
    }
  }
  return chunk;
}

/** Split text into rendered lines: honor explicit "\n", then greedily word-wrap
 *  on spaces to `maxWidth` (content px). A word longer than `maxWidth` is
 *  hard-broken. With no `maxWidth`, only "\n" splits. */
export function wrapText(text: string, opts: LayoutOptions): string[] {
  const { scale, letterSpacing, maxWidth } = opts;
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (maxWidth === undefined || maxWidth <= 0) {
      lines.push(paragraph);
      continue;
    }
    if (opts.noWrap) {
      lines.push(truncateToWidth(paragraph, maxWidth, scale, letterSpacing));
      continue;
    }
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(" ")) {
      const candidate = line === "" ? word : line + " " + word;
      if (measureLine(candidate, scale, letterSpacing) <= maxWidth) {
        line = candidate;
        continue;
      }
      // Candidate overflows: flush the current line first (if any).
      if (line !== "") {
        lines.push(line);
        line = "";
      }
      if (measureLine(word, scale, letterSpacing) > maxWidth) {
        line = hardBreak(word, maxWidth, scale, letterSpacing, lines);
      } else {
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Lay out `text` into positioned line boxes + block dimensions (scaled px). */
export function layout(text: string, opts: LayoutOptions): LayoutResult {
  const { scale, letterSpacing, lineHeight } = opts;
  const glyphW = GLYPH_ADVANCE * scale;
  const glyphH = GLYPH_H * scale;
  const baseline = GLYPH_BASELINE * scale;
  const rendered = wrapText(text, opts);
  const lines: LineBox[] = [];
  let maxLineWidth = 0;
  for (let i = 0; i < rendered.length; i++) {
    const lineText = rendered[i];
    const width = measureLine(lineText, scale, letterSpacing);
    if (width > maxLineWidth) maxLineWidth = width;
    const top = i * lineHeight;
    lines.push({ text: lineText, width, top, baseline: top + baseline });
  }
  const height = rendered.length > 0 ? (rendered.length - 1) * lineHeight + glyphH : 0;
  return { lines, width: maxLineWidth, height, glyphW, glyphH, advance: glyphW, baseline };
}
