// limina UI — UiManager (A4 host surface). Holds the LIVE container panels the
// `ui.*` skills author, keyed by an opaque handle (`ui_<n>`). Each live entry
// bundles its real A2/A3 pieces:
//
//   • a Panel built through the REAL container builders (./containers.ts) — its
//     mesh is added to the scene the skill handler hands in,
//   • a WorldAnchor (billboard, follows an entity/point) OR a ScreenAnchor
//     (camera-independent overlay) from ./anchor.ts, and
//   • optional lifecycle (./lifecycle.ts): Fade / Typewriter / Lifetime /
//     SpeechQueue / FeedModel.
//
// The skills only register / update / remove; the per-frame tick is the HOST's
// job — `update(camera, viewportW, viewportH, dtMs)` advances every anchor +
// lifecycle and auto-dismisses TTL-expired panels. No compositing or anchor math
// is re-implemented here: this is the live registry over the container layer.

import type { SceneLike } from "../engine.ts";
import type { ColorInput, Side, TextStyle } from "./compositor.ts";
import {
  callout,
  hudPanel,
  label,
  speechBubble,
  textBox,
  thoughtBubble,
  type Toward,
} from "./containers.ts";
import {
  type AnchorCamera,
  ScreenAnchor,
  type ScreenCorner,
  type Vec3,
  WorldAnchor,
} from "./anchor.ts";
import {
  Fade,
  FeedModel,
  Lifetime,
  type QueueMode,
  SpeechQueue,
  Typewriter,
} from "./lifecycle.ts";
import type { Panel, PanelMesh } from "./surface.ts";

/** The container kinds a builder can place (mirrors ./containers.ts). */
export type UiKind = "label" | "textBox" | "speechBubble" | "thoughtBubble" | "callout" | "hudPanel";

/** Where the panel lives: a world billboard following an entity/point, or a
 *  camera-independent screen overlay. `position` is resolved by the caller
 *  (the skill handler turns an entity id into a per-frame getter). */
export interface UiWorldAnchorSpec {
  kind: "world";
  position: Vec3 | (() => Vec3);
  offset?: Vec3;
  billboard?: boolean;
  /** draw order; a speech bubble bumps this above its nametag label (default 0). */
  renderOrder?: number;
  /** when false the billboard ignores depth and always draws over the scene +
   *  lower-order billboards (keeps the bubble readable). Default untouched. */
  depthTest?: boolean;
}
export interface UiScreenAnchorSpec {
  kind: "screen";
  corner?: ScreenCorner;
  marginPx?: [number, number];
  distance?: number;
  renderOrder?: number;
}
export type UiAnchorSpec = UiWorldAnchorSpec | UiScreenAnchorSpec;

/** Bubble chrome direction (speech tail / thought puffs aim at the speaker). */
export interface UiTailSpec {
  toward?: Toward;
  side?: Side;
  /** thought-bubble puff count */
  count?: number;
  /** speech-bubble tail tuning */
  length?: number;
  base?: number;
}

/** Callout leader line from the box edge to a target (panel-local px). */
export interface UiLeaderSpec {
  dx: number;
  dy: number;
  side?: Side;
  offset?: number;
  width?: number;
  color?: ColorInput;
  dot?: number;
}

/** Optional lifecycle/motion bound to the panel. */
export interface UiLifecycleSpec {
  fade?: { from?: number; to?: number; durationMs: number };
  typewriter?: { cps: number };
  /** auto-dismiss after this many ms (ticked by update()). */
  ttl?: number;
  queue?: { mode?: QueueMode; defaultHoldMs?: number; lines?: string[]; cps?: number };
  feed?: { maxLines: number };
}

/** Everything needed to materialize one container. */
export interface UiCreateOptions {
  anchor: UiAnchorSpec;
  style?: TextStyle;
  text?: string;
  title?: string;
  lines?: string[];
  maxWidth?: number;
  width?: number;
  /** hudPanel fixed-console: cap to N rows, truncate per row, pin the height. */
  maxLines?: number;
  pixelScale?: number;
  tail?: UiTailSpec;
  leader?: UiLeaderSpec;
  lifecycle?: UiLifecycleSpec;
}

/** A content patch for an existing handle. */
export interface UiUpdate {
  text?: string;
  title?: string;
  style?: TextStyle;
  lines?: string[];
}

interface UiEntry {
  handle: string;
  kind: UiKind;
  scene: SceneLike;
  opts: UiCreateOptions;
  panel: Panel;
  anchorKind: "world" | "screen";
  worldAnchor?: WorldAnchor;
  screenAnchor?: ScreenAnchor;
  fade?: Fade;
  typewriter?: Typewriter;
  lifetime?: Lifetime;
  queue?: SpeechQueue;
  feed?: FeedModel;
  currentText: string;
  currentTitle: string | undefined;
  currentLines: string[] | undefined;
}

/** A live bubble's projected screen rect, used by the side-placement + on-screen
 *  clamp pass. `cx0`/`cy0` are the projected anchor center this frame (above the
 *  speaker); `cx`/`cy` are mutated as the bubble is nudged along camera-right /
 *  camera-up to separate overlaps and clamp the whole rect into the viewport. */
interface PanelRect {
  entry: UiEntry;
  k: number;
  cx0: number;
  cx: number;
  cy0: number;
  cy: number;
  halfW: number;
  halfH: number;
}

const DEFAULT_DT_MS = 1000 / 60;

/** A live handle as returned to a skill caller. */
export interface UiHandleResult {
  handle: string;
  panel: Panel;
}

export interface UiManagerOptions {
  /** Called when a TTL-expired panel is auto-dismissed during update(). */
  onAutoDismiss?(handle: string): void;
}

/** Build a Panel through the REAL container builder for `kind`. */
function buildPanel(kind: UiKind, opts: UiCreateOptions): Panel {
  const style = opts.style;
  const pixelScale = opts.pixelScale;
  const bodyFromLines = opts.lines !== undefined ? opts.lines.join("\n") : undefined;
  const text = opts.text ?? bodyFromLines ?? "";
  switch (kind) {
    case "label":
      return label({ text, style, pixelScale });
    case "textBox":
      return textBox({ text, title: opts.title, style, maxWidth: opts.maxWidth, pixelScale });
    case "speechBubble":
      return speechBubble({
        text,
        title: opts.title,
        style,
        maxWidth: opts.maxWidth,
        tailToward: opts.tail?.toward,
        tailSide: opts.tail?.side,
        tail: opts.tail !== undefined ? { length: opts.tail.length, base: opts.tail.base } : undefined,
        pixelScale,
      });
    case "thoughtBubble":
      return thoughtBubble({
        text,
        style,
        maxWidth: opts.maxWidth,
        toward: opts.tail?.toward,
        side: opts.tail?.side,
        count: opts.tail?.count,
        pixelScale,
      });
    case "callout":
      if (opts.leader === undefined) throw new Error("ui callout requires a `leader` vector");
      return callout({ text, title: opts.title, style, maxWidth: opts.maxWidth, leader: opts.leader, pixelScale });
    case "hudPanel":
      return hudPanel({ text: opts.text, lines: opts.lines, title: opts.title, style, width: opts.width, maxLines: opts.maxLines, pixelScale });
  }
}

/**
 * The live registry of authored containers. The `ui.*` skills call create /
 * update / remove; the host calls update(camera, …) each frame.
 */
export class UiManager {
  private readonly entries = new Map<string, UiEntry>();
  private seq = 0;
  private readonly onAutoDismiss: ((handle: string) => void) | undefined;

  constructor(opts: UiManagerOptions = {}) {
    this.onAutoDismiss = opts.onAutoDismiss;
  }

  /** Number of live panels. */
  get size(): number {
    return this.entries.size;
  }
  /** Live handle ids (creation order). */
  handles(): string[] {
    return [...this.entries.keys()];
  }
  /** Whether a handle is live. */
  has(handle: string): boolean {
    return this.entries.has(handle);
  }
  /** The live Panel for a handle (for host/test inspection). */
  panel(handle: string): Panel | undefined {
    return this.entries.get(handle)?.panel;
  }
  /** The scene-addable mesh for a handle (assert membership in the scene). */
  mesh(handle: string): PanelMesh | undefined {
    return this.entries.get(handle)?.panel.mesh;
  }
  /** Whether the panel's speech queue has FULLY revealed its current line (and
   *  has nothing queued behind it). True when the handle is unknown or has no
   *  queue, so a caller gating on it never blocks on a missing/plain bubble. */
  revealed(handle: string): boolean {
    const entry = this.entries.get(handle);
    if (entry === undefined || entry.queue === undefined) return true;
    return entry.queue.revealed;
  }

  /** Build a container of `kind`, add its mesh to `scene`, register its anchor +
   *  lifecycle, and return an opaque handle. */
  create(scene: SceneLike, kind: UiKind, opts: UiCreateOptions): UiHandleResult {
    const panel = buildPanel(kind, opts);
    const handle = `ui_${this.seq++}`;
    const bodyFromLines = opts.lines !== undefined ? opts.lines.join("\n") : undefined;
    const entry: UiEntry = {
      handle,
      kind,
      scene,
      opts,
      panel,
      anchorKind: opts.anchor.kind,
      currentText: opts.text ?? bodyFromLines ?? "",
      currentTitle: opts.title,
      currentLines: opts.lines,
    };
    this.bindAnchor(entry);
    this.bindLifecycle(entry);
    scene.add(panel.mesh);
    this.entries.set(handle, entry);
    return { handle, panel };
  }

  // -- update is overloaded: content patch by handle, OR per-frame tick. -------

  /** Patch a live panel's content/style. Returns whether it re-composited. */
  update(handle: string, patch: UiUpdate): boolean;
  /** Per-frame host tick: advance every anchor + lifecycle, auto-dismiss TTLs. */
  update(camera: AnchorCamera, viewportW: number, viewportH: number, dtMs?: number): void;
  update(a: string | AnchorCamera, b: UiUpdate | number, c?: number, d?: number): boolean | void {
    if (typeof a === "string") return this.applyContentUpdate(a, b as UiUpdate);
    this.tick(a, b as number, c as number, d);
  }

  /** Remove a panel: detach its mesh from the scene + dispose GPU resources. */
  remove(handle: string): boolean {
    const entry = this.entries.get(handle);
    if (entry === undefined) return false;
    entry.scene.remove(entry.panel.mesh);
    entry.panel.dispose();
    this.entries.delete(handle);
    return true;
  }

  /** Gracefully dismiss a panel: ramp its opacity to 0 over `fadeMs`, then have
   *  the next ticks auto-remove it (a Lifetime expiring with the fade). Used to
   *  clear speech bubbles when a conversation ends — fade out, then gone. */
  dismiss(handle: string, fadeMs = 220): boolean {
    const entry = this.entries.get(handle);
    if (entry === undefined) return false;
    const from = entry.panel.material.opacity;
    if (entry.fade !== undefined) entry.fade.reset(from, 0, fadeMs);
    else entry.fade = new Fade(entry.panel, { from, to: 0, durationMs: fadeMs });
    entry.lifetime = new Lifetime(fadeMs); // auto-removed once the fade completes
    return true;
  }

  /** Remove every live panel (host teardown). */
  clear(): void {
    for (const handle of [...this.entries.keys()]) this.remove(handle);
  }

  // -- internals --------------------------------------------------------------

  private applyContentUpdate(handle: string, patch: UiUpdate): boolean {
    const entry = this.entries.get(handle);
    if (entry === undefined) return false;
    // A style change re-derives the whole container (kind chrome + merged style),
    // so rebuild the panel through the builder and swap it in the scene.
    if (patch.style !== undefined) {
      this.rebuildWithStyle(entry, patch);
      return true;
    }
    let changed = false;
    if (patch.title !== undefined) entry.currentTitle = patch.title;
    if (patch.lines !== undefined) {
      entry.currentLines = patch.lines;
      entry.currentText = patch.lines.join("\n");
      changed = entry.panel.setText(entry.currentText, entry.currentTitle) || changed;
    } else if (patch.text !== undefined) {
      entry.currentText = patch.text;
      entry.currentLines = undefined;
      // A queued speaker pushes successive lines through its queue (natural
      // conversation); otherwise set the body text directly.
      if (entry.queue !== undefined) {
        entry.queue.push({ text: patch.text, title: entry.currentTitle });
        changed = true;
      } else {
        changed = entry.panel.setText(entry.currentText, entry.currentTitle) || changed;
      }
    } else if (patch.title !== undefined) {
      changed = entry.panel.setText(entry.currentText, entry.currentTitle) || changed;
    }
    return changed;
  }

  private rebuildWithStyle(entry: UiEntry, patch: UiUpdate): void {
    const mergedStyle: TextStyle = { ...(entry.opts.style ?? {}), ...(patch.style ?? {}) };
    if (patch.title !== undefined) entry.currentTitle = patch.title;
    if (patch.lines !== undefined) {
      entry.currentLines = patch.lines;
      entry.currentText = patch.lines.join("\n");
    } else if (patch.text !== undefined) {
      entry.currentText = patch.text;
      entry.currentLines = undefined;
    }
    entry.opts = {
      ...entry.opts,
      style: mergedStyle,
      text: entry.currentText,
      title: entry.currentTitle,
      lines: entry.currentLines,
    };
    const newPanel = buildPanel(entry.kind, entry.opts);
    entry.scene.remove(entry.panel.mesh);
    entry.panel.dispose();
    entry.panel = newPanel;
    entry.scene.add(newPanel.mesh);
    // Anchors + lifecycle hold a panel/material reference — rebind to the new one.
    this.bindAnchor(entry);
    this.bindLifecycle(entry);
  }

  private bindAnchor(entry: UiEntry): void {
    const spec = entry.opts.anchor;
    if (spec.kind === "screen") {
      entry.worldAnchor = undefined;
      entry.screenAnchor = new ScreenAnchor(entry.panel, {
        corner: spec.corner,
        marginPx: spec.marginPx,
        distance: spec.distance,
        renderOrder: spec.renderOrder,
      });
      entry.anchorKind = "screen";
    } else {
      entry.screenAnchor = undefined;
      entry.worldAnchor = new WorldAnchor(entry.panel, {
        position: spec.position,
        offset: spec.offset,
        billboard: spec.billboard,
        renderOrder: spec.renderOrder,
        depthTest: spec.depthTest,
      });
      entry.anchorKind = "world";
    }
  }

  private bindLifecycle(entry: UiEntry): void {
    const life = entry.opts.lifecycle;
    entry.fade = undefined;
    entry.typewriter = undefined;
    entry.lifetime = undefined;
    entry.queue = undefined;
    entry.feed = undefined;
    if (life === undefined) return;
    if (life.fade !== undefined) entry.fade = new Fade(entry.panel, life.fade);
    if (life.typewriter !== undefined) {
      entry.typewriter = new Typewriter(entry.panel, entry.currentText, { cps: life.typewriter.cps, title: entry.currentTitle });
    }
    if (life.ttl !== undefined) entry.lifetime = new Lifetime(life.ttl);
    if (life.queue !== undefined) {
      const queue = new SpeechQueue(entry.panel, { mode: life.queue.mode, defaultHoldMs: life.queue.defaultHoldMs, cps: life.queue.cps });
      for (const line of life.queue.lines ?? []) queue.push(line);
      entry.queue = queue;
    }
    if (life.feed !== undefined) {
      const feed = new FeedModel({ maxLines: life.feed.maxLines, panel: entry.panel, title: entry.currentTitle });
      for (const line of entry.currentLines ?? []) feed.append(line);
      entry.feed = feed;
    }
  }

  private tick(camera: AnchorCamera, viewportW: number, viewportH: number, dtMs = DEFAULT_DT_MS): void {
    const expired: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.fade !== undefined) entry.fade.update(dtMs);
      if (entry.typewriter !== undefined) entry.typewriter.update(dtMs);
      if (entry.queue !== undefined) entry.queue.update(dtMs);
      if (entry.lifetime !== undefined && entry.lifetime.update(dtMs)) expired.push(entry.handle);
      if (entry.worldAnchor !== undefined) entry.worldAnchor.update(camera);
      else if (entry.screenAnchor !== undefined) entry.screenAnchor.update(camera, viewportW, viewportH);
    }
    this.cullWorldPanels(camera, viewportW, viewportH);
    this.separateBubbles(camera, viewportW, viewportH);
    for (const handle of expired) {
      if (this.remove(handle)) this.onAutoDismiss?.(handle);
    }
  }

  /**
   * Per-frame billboard cull for world panels (P5-A "never clipped"). A speech
   * BUBBLE auto-sizes to its full content, so being TALL is fine — it is hidden
   * only when it cannot be shown sanely: (a) behind/grazing the lens, where it
   * projects as a giant SLAB wider than the viewport that no horizontal clamp
   * can fit, or (b) ENTIRELY off-screen (the same rule as a label). A normally-
   * placed, content-tall bubble stays VISIBLE; separateBubbles then clamps it
   * fully on-screen (sliding it down, never top-clipping). A NAMETAG label is
   * hidden only when it is ENTIRELY off-screen or behind the lens (an NPC across
   * the clearing). Re-evaluated every frame, so anything swinging back into
   * frame shows again.
   */
  private cullWorldPanels(camera: AnchorCamera, viewportW: number, viewportH: number): void {
    let any = false;
    for (const entry of this.entries.values()) {
      if (entry.anchorKind === "world" && (entry.kind === "speechBubble" || entry.kind === "label")) { any = true; break; }
    }
    if (!any) return;
    camera.updateMatrixWorld(true);
    const e = camera.matrixWorld.elements;
    const rgt = [e[0], e[1], e[2]];
    const up = [e[4], e[5], e[6]];
    const fwd = [-e[8], -e[9], -e[10]];
    const cam = [e[12], e[13], e[14]];
    const tanHalf = Math.tan((camera.fov * Math.PI) / 180 / 2);
    for (const entry of this.entries.values()) {
      if (entry.anchorKind !== "world") continue;
      const isBubble = entry.kind === "speechBubble";
      if (!isBubble && entry.kind !== "label") continue;
      const p = entry.panel.mesh.position;
      const rx = p.x - cam[0], ry = p.y - cam[1], rz = p.z - cam[2];
      const depth = rx * fwd[0] + ry * fwd[1] + rz * fwd[2];
      let show = depth > 0.1; // in front of the lens
      if (show) {
        const k = viewportH / (2 * depth * tanHalf);
        const halfW = (entry.panel.width * entry.panel.pixelScale * k) / 2;
        const halfH = (entry.panel.height * entry.panel.pixelScale * k) / 2;
        const cx = viewportW / 2 + (rx * rgt[0] + ry * rgt[1] + rz * rgt[2]) * k;
        const cy = viewportH / 2 - (rx * up[0] + ry * up[1] + rz * up[2]) * k;
        const M = 1; // sub-pixel rounding tolerance
        // ENTIRELY off-screen (same rule for bubbles + labels): the whole rect
        // sits past one edge, so nothing is visible.
        const offscreen = cx + halfW < M || cx - halfW > viewportW - M || cy + halfH < M || cy - halfH > viewportH - M;
        if (isBubble) {
          // A bubble is kept even when TALLER than the viewport (the clamp slides
          // it on-screen). Cull only a grazing SLAB — projected WIDER than the
          // viewport, so no horizontal clamp can fit it — or one entirely off.
          const slab = 2 * halfW > viewportW + 2 * M;
          if (slab || offscreen) show = false;
        } else {
          // Nametags: hide only when ENTIRELY off-screen (NPC out of frame).
          if (offscreen) show = false;
        }
      }
      entry.panel.mesh.visible = show;
    }
  }

  /**
   * Screen-space side-placement pass (P5-A). After every world anchor placed its
   * billboard this frame, project each live, visible speech BUBBLE and push any
   * OVERLAPPING pair APART along the camera-right axis: the lower-x bubble slides
   * toward its OUTER (left) side, the higher-x bubble toward its outer (right)
   * side, so two speakers facing each other end with their bubbles on opposite
   * sides of the frame — never stacked, never overlapping. Each bubble's speech
   * TAIL is re-aimed along its bottom edge so it still points back down at its
   * speaker after the slide. A non-overlapping bubble is left exactly above its
   * speaker (tail centred) — moving ONLY along camera-right preserves screen-y,
   * and an un-nudged bubble keeps its x/z anchoring. NAMETAG labels do NOT take
   * part (free-floating billboards): they never push or get pushed, and the
   * bubble's higher renderOrder + depthTest-off draw it over any label it
   * crosses. Deterministic + allocation-light (a handful of panels); each bubble
   * is then clamped on BOTH axes to sit fully in the viewport — a content-tall
   * bubble slides DOWN (never top-clipped) rather than being culled.
   */
  private separateBubbles(camera: AnchorCamera, viewportW: number, viewportH: number): void {
    camera.updateMatrixWorld(true);
    const e = camera.matrixWorld.elements;
    const rgt = [e[0], e[1], e[2]];
    const up = [e[4], e[5], e[6]];
    const fwd = [-e[8], -e[9], -e[10]];
    const cam = [e[12], e[13], e[14]];
    const tanHalf = Math.tan((camera.fov * Math.PI) / 180 / 2);

    const bubbles: PanelRect[] = [];
    for (const entry of this.entries.values()) {
      if (entry.anchorKind !== "world" || entry.kind !== "speechBubble" || !entry.panel.mesh.visible) continue;
      const p = entry.panel.mesh.position;
      const rx = p.x - cam[0], ry = p.y - cam[1], rz = p.z - cam[2];
      const depth = rx * fwd[0] + ry * fwd[1] + rz * fwd[2];
      if (depth <= 0.05) continue; // behind / on the lens plane
      const vx = rx * rgt[0] + ry * rgt[1] + rz * rgt[2];
      const vy = rx * up[0] + ry * up[1] + rz * up[2];
      const k = viewportH / (2 * depth * tanHalf);
      const cx = viewportW / 2 + vx * k;
      const cy = viewportH / 2 - vy * k;
      bubbles.push({
        entry, k, cx0: cx, cx, cy0: cy, cy,
        halfW: (entry.panel.width * entry.panel.pixelScale * k) / 2,
        halfH: (entry.panel.height * entry.panel.pixelScale * k) / 2,
      });
    }
    if (bubbles.length === 0) return;

    if (bubbles.length >= 2) this.spreadBubblesHorizontally(bubbles);

    // Clamp each bubble fully inside the viewport on BOTH axes, realize the net
    // screen shift as orthogonal world moves (camera-right leaves screen-y
    // untouched; camera-up leaves screen-x untouched), then re-aim the tail
    // along the bottom edge so it still points down at the speaker.
    const MARGIN = 6;
    for (const b of bubbles) {
      // Horizontal: keep the whole rect within [MARGIN, W-MARGIN].
      const loX = b.halfW + MARGIN;
      const hiX = viewportW - b.halfW - MARGIN;
      if (hiX > loX) b.cx = b.cx < loX ? loX : b.cx > hiX ? hiX : b.cx;
      // Vertical: slide down/up so the whole rect fits. A bubble TALLER than the
      // viewport can't fit — pin its TOP at MARGIN (show from the top; the bottom
      // unavoidably runs past the edge) so it is never top-clipped.
      const loY = b.halfH + MARGIN;
      const hiY = viewportH - b.halfH - MARGIN;
      b.cy = hiY >= loY ? (b.cy < loY ? loY : b.cy > hiY ? hiY : b.cy) : loY;
      this.applyHorizontalShift(b, rgt);
      this.applyVerticalShift(b, up);
      const frac = b.halfW > 0.5 ? 0.5 + (b.cx0 - b.cx) / (2 * b.halfW) : 0.5;
      b.entry.panel.setTailOffset(frac);
    }
  }

  /** Push overlapping bubbles apart along screen-x — the left member toward the
   *  left, the right toward the right — until none overlap in BOTH axes. A few
   *  passes converge; deterministic via a stable handle tie-break. */
  private spreadBubblesHorizontally(bubbles: PanelRect[]): void {
    const GAP = 12; // px of breathing room between two bubbles
    for (let pass = 0; pass < 6; pass++) {
      bubbles.sort((a, b) => a.cx - b.cx || (a.entry.handle < b.entry.handle ? -1 : 1));
      let moved = false;
      for (let i = 0; i < bubbles.length; i++) {
        for (let j = i + 1; j < bubbles.length; j++) {
          const a = bubbles[i], b = bubbles[j]; // a.cx <= b.cx after the sort
          if (!(a.cy - a.halfH < b.cy + b.halfH && a.cy + a.halfH > b.cy - b.halfH)) continue; // no y-overlap
          const need = a.halfW + b.halfW + GAP - (b.cx - a.cx);
          if (need <= 0.001) continue; // no x-overlap
          a.cx -= need / 2;
          b.cx += need / 2;
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  /** Apply a bubble's net screen-x delta as a world move along camera-right
   *  (orthogonal to up, so screen-y is preserved); true if it actually moved. */
  private applyHorizontalShift(r: PanelRect, rgt: number[]): boolean {
    const dCx = r.cx - r.cx0;
    if (Math.abs(dCx) < 0.25) return false; // sub-pixel: nothing meaningful
    const d = dCx / r.k;
    const p = r.entry.panel.mesh.position;
    p.set(p.x + rgt[0] * d, p.y + rgt[1] * d, p.z + rgt[2] * d);
    r.entry.panel.mesh.updateMatrixWorld(true);
    return true;
  }

  /** Apply a bubble's net screen-y delta as a world move along camera-up
   *  (orthogonal to right, so screen-x is preserved); true if it actually moved.
   *  Screen-y grows DOWNWARD while camera-up grows UPWARD, hence the sign flip. */
  private applyVerticalShift(r: PanelRect, up: number[]): boolean {
    const dCy = r.cy - r.cy0;
    if (Math.abs(dCy) < 0.25) return false; // sub-pixel: nothing meaningful
    const d = -dCy / r.k;
    const p = r.entry.panel.mesh.position;
    p.set(p.x + up[0] * d, p.y + up[1] * d, p.z + up[2] * d);
    r.entry.panel.mesh.updateMatrixWorld(true);
    return true;
  }

  /** Append a line to a panel's bound feed (HUD scroll). Returns false when the
   *  handle is unknown or has no feed. */
  feedAppend(handle: string, line: string): boolean {
    const feed = this.entries.get(handle)?.feed;
    if (feed === undefined) return false;
    feed.append(line);
    return true;
  }
}
