// Phase 5-A — Speech-bubble LAYOUT & FIT (headless, REAL, falsifiable).
//
// Proves the speech-bubble polish fixes with real composited pixels + real
// projection math (no screenshots needed — every claim is a number):
//
//   1. SIDE PLACEMENT — two speakers whose above-head bubbles OVERLAP on screen
//      are pushed to OPPOSITE outer sides along camera-right by UiManager.update()
//      so neither hides the other. Falsifiable + load-bearing: the naive rects
//      (== the pass's own input) overlap; the post-pass rects sit side-by-side
//      (no overlap), each on its speaker's outer side, screen-y unchanged (NOT
//      stacked), in viewport, with the tail re-aimed back at the speaker.
//   2. AUTO-SIZE + ON-SCREEN CLAMP — a bubble composites to its FULL wrapped
//      height (no maxLines cap): a longer line is TALLER (monotonic, exceeds the
//      old 4-line bound). The layout pass keeps it fully on-screen — a bubble
//      whose natural rect pokes off the TOP is slid DOWN (clamped, never
//      top-clipped, never culled), an over-tall line is pinned top-at-MARGIN, and
//      a Typewriter reveal grows the shown text up to the full uncapped height.
//   3. LAYERING — a world speech bubble renders OVER its nametag label
//      (renderOrder higher, depthTest off) and sits clearly ABOVE it on screen.
//   4. CULL — a bubble that cannot fit (speaker beside/too close to the lens) is
//      hidden rather than rendered as a clipped slab; a framed one stays shown.
//   5. NAMETAGS FREE-FLOATING — labels take NO part in the layout pass: the pass
//      never moves them (overlapping each other is fine), and a bubble always
//      draws over a label (renderOrder higher, depthTest off).
//
// Run (headless): ./target/debug/limina js/test/p5_bubble_layout.ts

import * as THREE from "../build/three.bundle.mjs";
import { type SceneLike } from "../src/engine.ts";
import { UiManager } from "../src/ui/manager.ts";
import { composite, type TextStyle } from "../src/ui/compositor.ts";
import { Panel } from "../src/ui/surface.ts";
import { Typewriter } from "../src/ui/lifecycle.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("P5 BUBBLE FAIL: " + message);
}

const W = 1024;
const H = 640;

// The live bubble chrome the social skill authors (kept in sync with social.ts).
const BUBBLE_STYLE: TextStyle = {
  background: { color: 0x161c28, opacity: 0.94 },
  border: { width: 2, color: 0x46506a, radius: 12 },
  text: { color: 0xf3f5f7, scale: 2, align: "left", lineHeight: 32 },
  padding: { top: 9, right: 13, bottom: 9, left: 13 },
};
const BUBBLE_PS = 0.009;

function makeScene(): { scene: SceneLike; children: unknown[] } {
  const children: unknown[] = [];
  const scene: SceneLike = {
    add(c: unknown) { children.push(c); },
    remove(c: unknown) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); },
    position: { set() {}, x: 0, y: 0, z: 0 },
    background: null as unknown,
  };
  return { scene, children };
}

interface Rect { cx: number; cy: number; halfW: number; halfH: number; top: number; bottom: number; left: number; right: number; depth: number; }

/** Project a world-space billboard center + composited size to its screen rect,
 *  using the SAME math UiManager.separateBubbles optimizes against. */
function project(
  pos: [number, number, number], panelW: number, panelH: number, pixelScale: number,
  camera: THREE.PerspectiveCamera, vw: number, vh: number,
): Rect {
  camera.updateMatrixWorld(true);
  const e = camera.matrixWorld.elements;
  const rgt = [e[0], e[1], e[2]];
  const up = [e[4], e[5], e[6]];
  const fwd = [-e[8], -e[9], -e[10]];
  const cam = [e[12], e[13], e[14]];
  const rx = pos[0] - cam[0], ry = pos[1] - cam[1], rz = pos[2] - cam[2];
  const depth = rx * fwd[0] + ry * fwd[1] + rz * fwd[2];
  const vx = rx * rgt[0] + ry * rgt[1] + rz * rgt[2];
  const vy = rx * up[0] + ry * up[1] + rz * up[2];
  const tanHalf = Math.tan((camera.fov * Math.PI) / 180 / 2);
  const k = vh / (2 * depth * tanHalf);
  const cx = vw / 2 + vx * k;
  const cy = vh / 2 - vy * k;
  const halfW = (panelW * pixelScale * k) / 2;
  const halfH = (panelH * pixelScale * k) / 2;
  return { cx, cy, halfW, halfH, top: cy - halfH, bottom: cy + halfH, left: cx - halfW, right: cx + halfW, depth };
}

function overlap(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
function fmt(r: Rect): string {
  return `[x ${r.left.toFixed(0)}..${r.right.toFixed(0)}, y ${r.top.toFixed(0)}..${r.bottom.toFixed(0)}]`;
}

// =============================================================================
// 1. SIDE PLACEMENT: two speakers whose above-head bubbles OVERLAP are pushed to
//    OPPOSITE outer sides (horizontal), never stacked, never overlapping.
// =============================================================================

{
  const ui = new UiManager();
  const { scene } = makeScene();
  // Level camera framing two close speakers head-on (camera-right == world +x,
  // so a sideways nudge is a clean horizontal move + screen-y is preserved).
  const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 200);
  camera.position.set(0, 3, 9);
  camera.lookAt(0, 3, 0);
  camera.updateMatrixWorld(true);

  // Two speakers stood close together at the SAME height -> their above-head
  // bubbles land on top of each other on screen (the reported bug).
  const SAY = "Well met, friend — fine evening.";
  const speakers: [number, number, number][] = [[-0.55, 3, 0], [0.55, 3, 0]];
  const handles = speakers.map((p) =>
    ui.create(scene, "speechBubble", {
      anchor: { kind: "world", position: p, offset: [0, 0, 0], billboard: true, renderOrder: 20, depthTest: false },
      style: BUBBLE_STYLE, text: SAY, maxWidth: 380, pixelScale: BUBBLE_PS, tail: { toward: { x: 0, y: -1 } },
    }).handle,
  );
  const panels = handles.map((h) => ui.panel(h)!);

  // NAIVE rects (no layout pass) == the pass's own input: they overlap. This is
  // the falsifiable precondition — disabling the pass leaves them overlapping.
  const naive = speakers.map((p, i) => project(p, panels[i].width, panels[i].height, BUBBLE_PS, camera, W, H));
  assert(overlap(naive[0], naive[1]), `(1) precondition: the two above-head bubbles should overlap naively ${fmt(naive[0])} ${fmt(naive[1])}`);
  const li = naive[0].cx <= naive[1].cx ? 0 : 1; // left-of-frame speaker
  const ri = 1 - li;

  // The side-placement pass runs INSIDE update().
  ui.update(camera, W, H, 16);

  const meshes = handles.map((h) => ui.mesh(h)!);
  const post = meshes.map((m, i) => project([m.position.x, m.position.y, m.position.z], panels[i].width, panels[i].height, BUBBLE_PS, camera, W, H));

  // No longer overlapping, separated HORIZONTALLY (left bubble fully left of the
  // right one), each pushed to its speaker's OUTER side...
  assert(!overlap(post[0], post[1]), `(1) bubbles still overlap after the pass ${fmt(post[0])} ${fmt(post[1])}`);
  assert(post[li].right <= post[ri].left, `(1) bubbles not horizontally separated (left ${fmt(post[li])} vs right ${fmt(post[ri])})`);
  assert(post[li].cx < naive[li].cx - 1, `(1) left bubble not pushed to its outer (left) side (${post[li].cx.toFixed(0)} !< ${naive[li].cx.toFixed(0)})`);
  assert(post[ri].cx > naive[ri].cx + 1, `(1) right bubble not pushed to its outer (right) side (${post[ri].cx.toFixed(0)} !> ${naive[ri].cx.toFixed(0)})`);
  // ...NOT stacked vertically (screen-y essentially unchanged)...
  for (let i = 0; i < 2; i++) {
    assert(Math.abs(post[i].cy - naive[i].cy) < 2, `(1) bubble ${i} moved vertically (${naive[i].cy.toFixed(0)} -> ${post[i].cy.toFixed(0)}) — separation should be horizontal only`);
  }
  // ...still fully on screen...
  for (let i = 0; i < 2; i++) {
    assert(post[i].left >= -1 && post[i].right <= W + 1, `(1) bubble ${i} left the viewport horizontally ${fmt(post[i])}`);
    assert(post[i].top >= -1 && post[i].bottom <= H + 1, `(1) bubble ${i} left the viewport vertically ${fmt(post[i])}`);
  }
  // ...and each tail re-aimed back toward its speaker (left bubble's tail toward
  // its inner/right edge > 0.5; right bubble's toward its inner/left edge < 0.5).
  assert((panels[li].tailOffset ?? 0.5) > 0.5, `(1) left bubble tail not re-aimed inward (offset ${panels[li].tailOffset})`);
  assert((panels[ri].tailOffset ?? 0.5) < 0.5, `(1) right bubble tail not re-aimed inward (offset ${panels[ri].tailOffset})`);

  console.log(`BUBBLE (1) OK: overlapping bubbles side-placed -> L ${fmt(post[li])} tail ${panels[li].tailOffset} | R ${fmt(post[ri])} tail ${panels[ri].tailOffset} (horizontal, no overlap, in viewport)`);
}

// =============================================================================
// 2. AUTO-SIZE + ON-SCREEN CLAMP: bubbles auto-size to full content (no cap) and
//    the layout pass keeps a tall bubble fully on-screen (slid down, not culled,
//    not top-clipped). Falsifiable: a maxLines cap would plateau the height and
//    the tall bubble would poke off-screen.
// =============================================================================

const SHORT = "Well met, friend.";
const MED =
  "The river remembers every stone it has ever passed, and tonight it whispers of travellers who " +
  "lost their way among the birches when the mist came down thick and cold across the whole grove.";
const LONG = MED + " " +
  "Stay close to the light, friend, and mind the roots that reach for careless boots in the dark. " +
  "The wardens once counted every leaf that fell, but the years grew long and the tally was lost to " +
  "the wind, and now only the water keeps the reckoning of who has wandered through and who stayed. " +
  "Walk gently, and the grove will remember you kindly when the next mist rolls down off the hills.";

// (2a) AUTO-SIZE — composited height GROWS monotonically with content, uncapped.
// A local maxLines:4 probe computes what the REMOVED cap would have bounded a
// long line to; both MED and LONG must exceed it (no cap), and LONG > MED proves
// the growth never plateaus (a live cap would clamp both to one height).
{
  const shortC = composite({ ...BUBBLE_STYLE, maxWidth: 380 }, SHORT);
  const medC = composite({ ...BUBBLE_STYLE, maxWidth: 380 }, MED);
  const longC = composite({ ...BUBBLE_STYLE, maxWidth: 380 }, LONG);
  const cap4 = composite({ ...BUBBLE_STYLE, maxLines: 4, maxWidth: 380 }, LONG).height;
  assert(shortC.height < medC.height, `(2a) MED (${medC.height}px) not taller than SHORT (${shortC.height}px) — height should grow with content`);
  assert(medC.height < longC.height, `(2a) LONG (${longC.height}px) not taller than MED (${medC.height}px) — a live cap would clamp both to one height`);
  assert(medC.height > cap4 && longC.height > cap4, `(2a) uncapped MED ${medC.height} / LONG ${longC.height} should exceed the old 4-line bound ${cap4} — no cap`);
  console.log(`BUBBLE (2a) OK: auto-size monotonic, no cap — SHORT ${shortC.height} < MED ${medC.height} < LONG ${longC.height} (px), all past old 4-line bound ${cap4}`);
}

// (2b) ON-SCREEN CLAMP — a bubble whose natural rect pokes off the TOP is slid
// DOWN by UiManager.update() until its whole rect fits (top >= 0), still VISIBLE
// (not culled) and NOT top-clipped; an over-tall line is pinned top-at-MARGIN.
{
  const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 200);
  camera.position.set(0, 3, 6);
  camera.lookAt(0, 3, 0);
  camera.updateMatrixWorld(true);
  // depth == 6 (anchor z == 0). Place the anchor so its projected center lands at
  // the very TOP of the viewport (cy ~ 0): any positive-height bubble then pokes
  // off the top naively — purely camera geometry, independent of glyph metrics.
  const k = H / (2 * 6 * Math.tan((60 * Math.PI) / 180 / 2));
  const anchorY = 3 + (H / 2) / k; // projects to cy ~ 0

  // A MED bubble: tall, but fits the viewport once slid down -> clamps to top>=0.
  const ui = new UiManager();
  const { scene } = makeScene();
  const medH = ui.create(scene, "speechBubble", {
    anchor: { kind: "world", position: [0, anchorY, 0], offset: [0, 0, 0], billboard: true, renderOrder: 20, depthTest: false },
    style: BUBBLE_STYLE, text: MED, maxWidth: 380, pixelScale: BUBBLE_PS, tail: { toward: { x: 0, y: -1 } },
  }).handle;
  const medPanel = ui.panel(medH)!;
  const medNaive = project([0, anchorY, 0], medPanel.width, medPanel.height, BUBBLE_PS, camera, W, H);
  assert(medNaive.top < -1, `(2b) precondition: the MED bubble should poke off the TOP naively (top ${medNaive.top.toFixed(0)} !< 0)`);
  assert(medNaive.right - medNaive.left <= W, `(2b) precondition: the MED bubble should fit the viewport WIDTH (not a slab)`);
  assert(medNaive.bottom - medNaive.top <= H - 16, `(2b) precondition: the MED bubble should fit the viewport HEIGHT once slid down (${(medNaive.bottom - medNaive.top).toFixed(0)}px)`);

  ui.update(camera, W, H, 16);

  const medMesh = ui.mesh(medH)!;
  const medPost = project([medMesh.position.x, medMesh.position.y, medMesh.position.z], medPanel.width, medPanel.height, BUBBLE_PS, camera, W, H);
  assert(medMesh.visible === true, `(2b) the tall bubble was CULLED instead of clamped on-screen`);
  assert(medPost.top >= -1, `(2b) bubble still top-clipped after the clamp (top ${medPost.top.toFixed(0)} < 0) ${fmt(medPost)}`);
  assert(medPost.bottom <= H + 1, `(2b) bubble runs off the BOTTOM after the clamp ${fmt(medPost)}`);
  assert(medPost.cy > medNaive.cy + 1, `(2b) the clamp did NOT slide the bubble down (${medNaive.cy.toFixed(0)} -> ${medPost.cy.toFixed(0)})`);
  assert(Math.abs(medPost.cx - medNaive.cx) < 2, `(2b) the vertical clamp moved the bubble horizontally (${medNaive.cx.toFixed(0)} -> ${medPost.cx.toFixed(0)}) — should be vertical only`);
  console.log(`BUBBLE (2b) OK: MED bubble poking off top ${fmt(medNaive)} slid DOWN to ${fmt(medPost)} (visible, top>=0, no clip)`);

  // Over-tall: a LONG bubble TALLER than the viewport is pinned top-at-MARGIN
  // (shown from the top; bottom unavoidably past the edge), still visible.
  const ui2 = new UiManager();
  const { scene: scene2 } = makeScene();
  const longH = ui2.create(scene2, "speechBubble", {
    anchor: { kind: "world", position: [0, anchorY, 0], offset: [0, 0, 0], billboard: true, renderOrder: 20, depthTest: false },
    style: BUBBLE_STYLE, text: LONG, maxWidth: 380, pixelScale: BUBBLE_PS, tail: { toward: { x: 0, y: -1 } },
  }).handle;
  const longPanel = ui2.panel(longH)!;
  const longNaive = project([0, anchorY, 0], longPanel.width, longPanel.height, BUBBLE_PS, camera, W, H);
  assert(longNaive.bottom - longNaive.top > H, `(2b) precondition: the LONG bubble should be TALLER than the viewport (${(longNaive.bottom - longNaive.top).toFixed(0)} <= ${H})`);
  assert(longNaive.right - longNaive.left <= W, `(2b) precondition: the LONG bubble should fit the viewport WIDTH (not a slab)`);

  ui2.update(camera, W, H, 16);

  const longMesh = ui2.mesh(longH)!;
  const longPost = project([longMesh.position.x, longMesh.position.y, longMesh.position.z], longPanel.width, longPanel.height, BUBBLE_PS, camera, W, H);
  assert(longMesh.visible === true, `(2b) the over-tall bubble was CULLED instead of pinned on-screen`);
  assert(Math.abs(longPost.top - 6) <= 2, `(2b) over-tall bubble TOP not pinned at MARGIN (top ${longPost.top.toFixed(0)}, want ~6) ${fmt(longPost)}`);
  assert(longPost.bottom > H, `(2b) over-tall bubble should still overflow the BOTTOM (top-pinned, ${longPost.bottom.toFixed(0)} <= ${H})`);
  console.log(`BUBBLE (2b') OK: over-tall LONG (${(longNaive.bottom - longNaive.top).toFixed(0)}px > ${H}) pinned top-at-MARGIN ${fmt(longPost)} (visible, shown from top)`);
}

// (2c) TYPEWRITER — the reveal grows the shown text over ticks and the box grows
// (monotonic, uncapped) up to the FULL uncapped height (a cap would plateau it).
{
  const fullC = composite({ ...BUBBLE_STYLE, maxWidth: 380 }, LONG);
  const panel = new Panel({ style: { ...BUBBLE_STYLE, maxWidth: 380 }, text: "", pixelScale: BUBBLE_PS });
  const tw = new Typewriter(panel, LONG, { cps: 50 });
  let prevShown = -1;
  let prevH = -1;
  let steps = 0;
  for (let i = 0; i < 600 && !tw.done; i++) {
    tw.update(120);
    assert(tw.shown.length >= prevShown, `(2c) typewriter reveal went backwards (${prevShown} -> ${tw.shown.length})`);
    assert(panel.height >= prevH, `(2c) revealing bubble height shrank (${prevH} -> ${panel.height}) — should grow monotonically, uncapped`);
    prevShown = tw.shown.length;
    prevH = panel.height;
    steps++;
  }
  assert(tw.done && tw.shown === LONG, `(2c) typewriter did not fully reveal the long line`);
  assert(steps > 4, `(2c) typewriter revealed too fast to observe growth (${steps} steps)`);
  assert(panel.height === fullC.height, `(2c) fully-revealed bubble is not at the FULL uncapped height (${panel.height} != ${fullC.height}) — a cap would plateau it`);
  console.log(`BUBBLE (2c) OK: typewriter revealed ${LONG.length} chars over ${steps} ticks, height grew to the full uncapped ${fullC.height}px (no cap)`);
}

// =============================================================================
// 3. LAYERING: bubble renders OVER its nametag (order + depth) and sits ABOVE it.
// =============================================================================

{
  const ui = new UiManager();
  const { scene } = makeScene();
  const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 200);
  camera.position.set(0, 3, 12);
  camera.lookAt(0, 3, 0);
  camera.updateMatrixWorld(true);

  // SAME anchor world point; the nametag is pinned just above the head, the
  // bubble well above that (mirrors social.ts + the forest demo).
  const labelH = ui.create(scene, "label", {
    anchor: { kind: "world", position: [0, 0, 0], offset: [0, 1.95, 0], billboard: true },
    text: "Willow",
    style: { text: { color: 0xc6f0e2 }, background: { color: 0x0c1018, opacity: 0.55 }, border: { width: 1, color: 0xc6f0e2, radius: 8 }, padding: 6 },
  }).handle;
  const bubbleH = ui.create(scene, "speechBubble", {
    anchor: { kind: "world", position: [0, 0, 0], offset: [0, 3.2, 0], billboard: true, renderOrder: 20, depthTest: false },
    style: BUBBLE_STYLE,
    text: "Hi there.",
    maxWidth: 380,
    pixelScale: BUBBLE_PS,
    tail: { toward: { x: 0, y: -1 } },
  }).handle;

  ui.update(camera, W, H, 16);

  const labelMesh = ui.mesh(labelH)!;
  const bubbleMesh = ui.mesh(bubbleH)!;
  const labelPanel = ui.panel(labelH)!;
  const bubblePanel = ui.panel(bubbleH)!;

  // renderOrder: bubble draws AFTER (over) the label; depthTest off so it wins.
  assert(bubbleMesh.renderOrder > labelMesh.renderOrder, `(3) bubble renderOrder ${bubbleMesh.renderOrder} not above label ${labelMesh.renderOrder}`);
  assert(bubblePanel.material.depthTest === false, `(3) bubble should disable depthTest so it always wins over the label`);
  assert(labelPanel.material.depthTest === true, `(3) the nametag label should keep depthTest on (it is the minor chrome)`);

  // Screen position: the bubble sits clearly ABOVE the nametag (no overlap).
  const labelRect = project([labelMesh.position.x, labelMesh.position.y, labelMesh.position.z], labelPanel.width, labelPanel.height, labelPanel.pixelScale, camera, W, H);
  const bubbleRect = project([bubbleMesh.position.x, bubbleMesh.position.y, bubbleMesh.position.z], bubblePanel.width, bubblePanel.height, BUBBLE_PS, camera, W, H);
  assert(bubbleRect.bottom < labelRect.top, `(3) bubble ${fmt(bubbleRect)} not fully above the nametag ${fmt(labelRect)}`);
  assert(!overlap(bubbleRect, labelRect), `(3) bubble + nametag overlap on screen`);
  console.log(`BUBBLE (3) OK: bubble renderOrder ${bubbleMesh.renderOrder} > label ${labelMesh.renderOrder}, depthTest off; bubble ${fmt(bubbleRect)} sits above nametag ${fmt(labelRect)}`);
}

// =============================================================================
// 4. CULL: a bubble that can't fit (speaker beside/too close to the lens) is
//    HIDDEN rather than rendered as a clipped slab; a framed bubble stays shown.
// =============================================================================

{
  const ui = new UiManager();
  const { scene } = makeScene();
  const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 200);
  camera.position.set(0, 3, 12);
  camera.lookAt(0, 3, 0);
  camera.updateMatrixWorld(true);

  // Framed speaker (far enough to fit) vs one almost on the lens (depth ~0.5 ->
  // projects far wider than the viewport == the grazing/left-behind slab).
  const framed = ui.create(scene, "speechBubble", {
    anchor: { kind: "world", position: [-6, 3, 0], offset: [0, 0, 0], billboard: true, renderOrder: 20, depthTest: false },
    style: BUBBLE_STYLE, text: "Well met.", maxWidth: 380, pixelScale: BUBBLE_PS, tail: { toward: { x: 0, y: -1 } },
  }).handle;
  const tooClose = ui.create(scene, "speechBubble", {
    anchor: { kind: "world", position: [0, 3, 11.5], offset: [0, 0, 0], billboard: true, renderOrder: 20, depthTest: false },
    style: BUBBLE_STYLE, text: "Well met.", maxWidth: 380, pixelScale: BUBBLE_PS, tail: { toward: { x: 0, y: -1 } },
  }).handle;

  // Their NAIVE projected sizes: the close one is wildly larger than the viewport.
  const framedPanel = ui.panel(framed)!;
  const closePanel = ui.panel(tooClose)!;
  const framedNaive = project([-6, 3, 0], framedPanel.width, framedPanel.height, BUBBLE_PS, camera, W, H);
  const closeNaive = project([0, 3, 11.5], closePanel.width, closePanel.height, BUBBLE_PS, camera, W, H);
  assert(closeNaive.right - closeNaive.left > W, `(4) precondition: too-close bubble should project wider than viewport (${(closeNaive.right - closeNaive.left).toFixed(0)} <= ${W})`);
  assert(framedNaive.right - framedNaive.left <= W, `(4) precondition: framed bubble should fit the viewport width`);

  ui.update(camera, W, H, 16);

  assert(ui.mesh(framed)!.visible === true, `(4) framed bubble was wrongly culled`);
  assert(ui.mesh(tooClose)!.visible === false, `(4) oversized too-close bubble was NOT culled (would render clipped)`);
  console.log(`BUBBLE (4) OK: framed bubble (${(framedNaive.right - framedNaive.left).toFixed(0)}px) stays visible; too-close ${(closeNaive.right - closeNaive.left).toFixed(0)}px slab culled (never a clipped render)`);
}

// =============================================================================
// 5. NAMETAGS are FREE-FLOATING: the layout pass NEVER moves a label (overlapping
//    each other is fine), and a bubble always draws OVER a label (renderOrder).
// =============================================================================

{
  const ui = new UiManager();
  const { scene } = makeScene();
  const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 200);
  camera.position.set(0, 3, 9);
  camera.lookAt(0, 3, 0);
  camera.updateMatrixWorld(true);

  // Two speakers stood very close: their nametags (just above each head) overlap.
  const labelStyle: TextStyle = { text: { color: 0xc6f0e2 }, background: { color: 0x0c1018, opacity: 0.55 }, border: { width: 1, color: 0xc6f0e2, radius: 8 }, padding: 6 };
  const pts: [number, number, number][] = [[-0.25, 0, 0], [0.25, 0, 0]];
  const tagOffset: [number, number, number] = [0, 1.95, 0];
  const tags = pts.map((p) =>
    ui.create(scene, "label", { anchor: { kind: "world", position: p, offset: tagOffset, billboard: true, renderOrder: 0 }, text: "Willow", style: labelStyle }).handle,
  );
  // A bubble above each (the important content) so the layering claim is real.
  const bubbles = pts.map((p) =>
    ui.create(scene, "speechBubble", { anchor: { kind: "world", position: p, offset: [0, 3.2, 0], billboard: true, renderOrder: 20, depthTest: false }, style: BUBBLE_STYLE, text: "Hello.", maxWidth: 380, pixelScale: BUBBLE_PS, tail: { toward: { x: 0, y: -1 } } }).handle,
  );

  const tagPanels = tags.map((h) => ui.panel(h)!);
  const anchored = pts.map((p) => [p[0] + tagOffset[0], p[1] + tagOffset[1], p[2] + tagOffset[2]] as [number, number, number]);
  const naiveTags = anchored.map((a, i) => project(a, tagPanels[i].width, tagPanels[i].height, tagPanels[i].pixelScale, camera, W, H));
  assert(overlap(naiveTags[0], naiveTags[1]), `(5) precondition: the two nametags should overlap naively ${fmt(naiveTags[0])} ${fmt(naiveTags[1])}`);

  ui.update(camera, W, H, 16);

  // The pass NEVER moved a label: each sits EXACTLY at its anchor (pos+offset).
  const tagMeshes = tags.map((h) => ui.mesh(h)!);
  for (let i = 0; i < tagMeshes.length; i++) {
    const m = tagMeshes[i], a = anchored[i];
    assert(Math.abs(m.position.x - a[0]) < 1e-6 && Math.abs(m.position.y - a[1]) < 1e-6 && Math.abs(m.position.z - a[2]) < 1e-6,
      `(5) nametag ${i} was MOVED by the pass (${m.position.x},${m.position.y},${m.position.z}) != anchor (${a.join(",")})`);
  }
  // ...so the two free-floating tags STILL overlap — falsifiable: a label that
  // participated in the pass would have been separated.
  const postTags = tagMeshes.map((m, i) => project([m.position.x, m.position.y, m.position.z], tagPanels[i].width, tagPanels[i].height, tagPanels[i].pixelScale, camera, W, H));
  assert(overlap(postTags[0], postTags[1]), `(5) free-floating nametags should still overlap (the pass must not touch them) ${fmt(postTags[0])} ${fmt(postTags[1])}`);

  // A bubble ALWAYS draws over a label: higher renderOrder + depthTest off.
  for (let i = 0; i < bubbles.length; i++) {
    const bMesh = ui.mesh(bubbles[i])!, lMesh = tagMeshes[i];
    const bPanel = ui.panel(bubbles[i])!, lPanel = tagPanels[i];
    assert(bMesh.renderOrder > lMesh.renderOrder, `(5) bubble renderOrder ${bMesh.renderOrder} not above label ${lMesh.renderOrder}`);
    assert(bPanel.material.depthTest === false && lPanel.material.depthTest === true, `(5) bubble must disable depthTest while the label keeps it (so the bubble wins)`);
  }
  console.log(`BUBBLE (5) OK: nametags free-floating — pass never moves them (still overlapping ${fmt(postTags[0])} ${fmt(postTags[1])}); bubble renderOrder ${ui.mesh(bubbles[0])!.renderOrder} > label ${tagMeshes[0].renderOrder}`);
}

console.log("P5 BUBBLE OK: side-placement layout (opposite-side, no overlap, tail re-aimed, in viewport) + auto-size + on-screen clamp + typewriter (full content, slid down, never top-clipped) + bubble-over-nametag layering + free-floating nametags");
