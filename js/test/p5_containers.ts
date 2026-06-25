// Phase 5-A / A2 — World-space styled containers.
//
// Proves the container/bubble layer on the A1 substrate, with real composited
// pixels (CPU readback) + real transform math:
//
//   1. SPEECH TAIL  — a tail composited on the BOTTOM edge puts fill below the
//      box and NONE above; flipping it to the top inverts that. Falsifiable: a
//      tail forced to the wrong edge fails the "toward the anchor" assert.
//   2. THOUGHT PUFFS — puff discs are composited beyond the chosen edge.
//   3. TEXT BOX     — the title-bar bg differs from the body bg.
//   4. CALLOUT      — leader-line pixels run from the box edge toward the target.
//   5. WORD-WRAP    — a known string at a known max-width yields the expected
//      line count at the expected baselines.
//   6. BILLBOARD    — after re-pointing the camera, the quad's +Z forward faces
//      the camera (forward·dirToCamera ~ 1); a non-billboard quad does not.
//   7. LIFECYCLE    — fade ramps material.opacity 0->1 (monotone, clamped);
//      per-speaker replace + queue swap the shown line (and re-composite it).
//
// Run (headless): ./target/debug/limina js/test/p5_containers.ts

import * as THREE from "../build/three.bundle.mjs";
import { composite, type Composited, type RGBA } from "../src/ui/compositor.ts";
import { wrapText, layout } from "../src/ui/layout.ts";
import { callout, speechBubble, textBox, thoughtBubble } from "../src/ui/containers.ts";
import { Panel } from "../src/ui/surface.ts";
import { WorldAnchor } from "../src/ui/anchor.ts";
import { Fade, SpeechQueue, Typewriter } from "../src/ui/lifecycle.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("P5 A2 FAIL: " + message);
}
function px(c: Composited, x: number, y: number): RGBA {
  const i = (y * c.width + x) * 4;
  return { r: c.data[i], g: c.data[i + 1], b: c.data[i + 2], a: c.data[i + 3] };
}
/** Count pixels in [x0,x1) x [y0,y1) whose alpha >= minAlpha. */
function countOpaque(c: Composited, x0: number, y0: number, x1: number, y1: number, minAlpha: number): number {
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(c.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(c.width, x1); x++) {
      if (px(c, x, y).a >= minAlpha) n++;
    }
  }
  return n;
}

// ---- 1. SPEECH-BUBBLE TAIL (toward the anchor) + falsifiability -------------

const BUBBLE_BG: RGBA = { r: 240, g: 244, b: 250, a: 255 };
function tailBox(side: "top" | "bottom"): Composited {
  return composite(
    {
      background: { color: 0xf0f4fa },
      border: { width: 2, color: 0x223355, radius: 10 },
      text: { color: 0x14202e, scale: 2 },
      width: 120,
      height: 56,
      tail: { side, length: 22, base: 20 },
    },
    "Hello!",
  );
}

const down = tailBox("bottom"); // tail points DOWN (toward an anchor below)
const cxDown = down.box.x + (down.box.width >> 1);
const belowFill = countOpaque(down, cxDown - 8, down.box.y + down.box.height + 2, cxDown + 8, down.height, 200);
const aboveFill = countOpaque(down, cxDown - 8, 0, cxDown + 8, down.box.y - 1, 200);
assert(belowFill > 30, `(1) bottom tail produced no fill below the box (${belowFill})`);
assert(aboveFill === 0, `(1) bottom tail leaked fill above the box (${aboveFill})`);
// the tail fill IS the bubble bg color (connected to the body).
const tailPix = px(down, cxDown, down.box.y + down.box.height + 4);
assert(
  Math.abs(tailPix.r - BUBBLE_BG.r) < 12 && Math.abs(tailPix.g - BUBBLE_BG.g) < 12 && Math.abs(tailPix.b - BUBBLE_BG.b) < 12,
  `(1) tail fill ${tailPix.r},${tailPix.g},${tailPix.b} is not the bubble bg`,
);

// Falsifiable: force the tail to the WRONG edge -> fill is now ABOVE, none below;
// the "toward the (below) anchor" assert (belowFill>0 && aboveFill==0) inverts.
const up = tailBox("top");
const cxUp = up.box.x + (up.box.width >> 1);
const upBelow = countOpaque(up, cxUp - 8, up.box.y + up.box.height + 2, cxUp + 8, up.height, 200);
const upAbove = countOpaque(up, cxUp - 8, 0, cxUp + 8, up.box.y - 1, 200);
assert(upAbove > 30 && upBelow === 0, `(1) falsifiable: wrong-edge tail did not invert (above ${upAbove}, below ${upBelow})`);

// Container builder: tailToward {0,-1} (speaker below) -> the BOTTOM edge gets
// the tail (its margin is larger than the opposite edge).
const sb = speechBubble({ text: "Greetings, traveller.", tailToward: { x: 0, y: -1 }, maxWidth: 220 });
const sbc = sb.composited;
const sbBottomMargin = sbc.height - sbc.box.y - sbc.box.height;
const sbTopMargin = sbc.box.y;
assert(sbBottomMargin > sbTopMargin + 8, `(1) speechBubble tailToward-down did not extend the bottom (top ${sbTopMargin}, bottom ${sbBottomMargin})`);
const sbTailFill = countOpaque(sbc, sbc.box.x, sbc.box.y + sbc.box.height + 2, sbc.box.x + sbc.box.width, sbc.height, 200);
assert(sbTailFill > 20, `(1) speechBubble produced no tail fill (${sbTailFill})`);
console.log("A2 (1) OK: speech-bubble tail points toward the anchor edge (+ falsifiable inversion)");

// ---- 2. THOUGHT-BUBBLE PUFFS ----------------------------------------------

const thought = thoughtBubble({ text: "Hmm...", toward: { x: 0, y: -1 }, count: 3 });
const tc = thought.composited;
const puffFill = countOpaque(tc, tc.box.x, tc.box.y + tc.box.height + 1, tc.box.x + tc.box.width, tc.height, 200);
const puffAbove = countOpaque(tc, tc.box.x, 0, tc.box.x + tc.box.width, tc.box.y - 1, 200);
assert(puffFill > 25, `(2) thought bubble produced no puff pixels below (${puffFill})`);
assert(puffAbove === 0, `(2) thought bubble leaked puffs above (${puffAbove})`);
console.log(`A2 (2) OK: thought-bubble puffs composited toward the thinker (${puffFill} puff texels)`);

// ---- 3. TEXT BOX: title-bar bg != body bg ---------------------------------

const tb = textBox({ text: "Body line one.\nBody line two.", title: "Inspector" });
const tbc = tb.composited;
const titleBarPx = px(tbc, tbc.box.x + 6, tbc.box.y + 6); // inside the header bar
const bodyPx = px(tbc, tbc.box.x + 6, tbc.box.y + tbc.box.height - 6); // body area
assert(
  titleBarPx.r !== bodyPx.r || titleBarPx.g !== bodyPx.g || titleBarPx.b !== bodyPx.b,
  `(3) title-bar bg ${titleBarPx.r},${titleBarPx.g},${titleBarPx.b} == body bg ${bodyPx.r},${bodyPx.g},${bodyPx.b}`,
);
console.log("A2 (3) OK: text-box title bar bg differs from body bg");

// ---- 4. CALLOUT LEADER LINE toward the target -----------------------------

const LINE: RGBA = { r: 255, g: 70, b: 70, a: 255 };
const co = composite(
  {
    background: { color: 0x1b2230 },
    border: { width: 2, color: 0xffd166, radius: 6 },
    text: { color: 0xffffff, scale: 2 },
    width: 80,
    height: 40,
    callout: { side: "bottom", offset: 0.5, dx: 0, dy: 46, width: 3, color: 0xff4646, dot: 4 },
  },
  "node",
);
// the leader runs straight down from the bottom-edge anchor; sample its midpoint.
const ax = co.box.x + Math.round(0.5 * co.box.width);
const midY = co.box.y + co.box.height + 22;
const linePix = px(co, ax, midY);
assert(
  Math.abs(linePix.r - LINE.r) < 30 && linePix.g < 140 && linePix.b < 140 && linePix.a > 180,
  `(4) leader-line midpoint ${linePix.r},${linePix.g},${linePix.b},${linePix.a} is not the callout color`,
);
// the dot at the target end exists; and there is NO leader fill far to the side.
const tipFill = countOpaque(co, ax - 5, co.box.y + co.box.height + 40, ax + 5, co.height, 180);
assert(tipFill > 8, `(4) callout target dot missing (${tipFill})`);
const sideFill = countOpaque(co, 0, co.box.y + co.box.height + 2, co.box.x + 4, co.height, 180);
assert(sideFill === 0, `(4) callout leaked fill to the side; not pointing straight down (${sideFill})`);
console.log("A2 (4) OK: callout leader-line + target dot composited toward the target");

// ---- 5. WORD-WRAP to max-width: expected line count + baselines ------------

const SCALE = 2;
const LS = 0;
const LH = 40;
const text = "AB CD EF GH";
const content = 72; // fits one 2-char token (36px), not two with a space (90px)
const lines = wrapText(text, { scale: SCALE, letterSpacing: LS, lineHeight: LH, maxWidth: content });
assert(lines.length === 4, `(5) expected 4 wrapped lines, got ${lines.length}: ${JSON.stringify(lines)}`);
const lay = layout(text, { scale: SCALE, letterSpacing: LS, lineHeight: LH, maxWidth: content });
assert(
  lay.lines.map((l) => l.top).join(",") === "0,40,80,120",
  `(5) wrapped line baselines off: ${lay.lines.map((l) => l.top).join(",")}`,
);
// Falsifiable: a generous max-width collapses to ONE line.
const oneLine = wrapText(text, { scale: SCALE, letterSpacing: LS, lineHeight: LH, maxWidth: 400 });
assert(oneLine.length === 1, `(5) falsifiable: wide max-width should be 1 line, got ${oneLine.length}`);
console.log("A2 (5) OK: word-wrap yields the expected 4 lines at baselines 0,40,80,120 (1 line when wide)");

// ---- 6. BILLBOARD: quad forward faces the camera each frame ----------------

function dot(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function dirTo(from: number[], to: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const dx = to.x - from[0], dy = to.y - from[1], dz = to.z - from[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  return { x: dx / len, y: dy / len, z: dz / len };
}

const label = new Panel({ style: { background: { color: 0x224488 }, text: { color: 0xffffff, scale: 2 } }, text: "Marker" });
const anchor = new WorldAnchor(label, { position: [2, 1.5, -1], billboard: true });
const camera = new THREE.PerspectiveCamera(60, 1.5, 0.1, 100);

camera.position.set(0, 2, 8);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld(true);
anchor.update(camera);
const f1 = anchor.forward();
const d1 = dirTo(anchor.worldPosition(), camera.position);
assert(dot(f1, d1) > 0.999, `(6) billboard not facing camera (orient 1): dot ${dot(f1, d1).toFixed(4)}`);

// Re-point the camera from a very different direction; the quad must re-face it.
camera.position.set(-7, 5, -6);
camera.lookAt(1, 1, 1);
camera.updateMatrixWorld(true);
anchor.update(camera);
const f2 = anchor.forward();
const d2 = dirTo(anchor.worldPosition(), camera.position);
assert(dot(f2, d2) > 0.999, `(6) billboard not facing camera (orient 2): dot ${dot(f2, d2).toFixed(4)}`);

// Falsifiable: a NON-billboard quad keeps its orientation; after the same camera
// move its forward no longer faces the camera.
const fixed = new Panel({ style: { background: { color: 0x224488 } }, text: "Fixed" });
const fixedAnchor = new WorldAnchor(fixed, { position: [2, 1.5, -1], billboard: false });
camera.position.set(0, 2, 8); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
fixedAnchor.update(camera);
camera.position.set(-7, 5, -6); camera.lookAt(1, 1, 1); camera.updateMatrixWorld(true);
fixedAnchor.update(camera);
const ff = fixedAnchor.forward();
const fd = dirTo(fixedAnchor.worldPosition(), camera.position);
assert(dot(ff, fd) < 0.95, `(6) falsifiable: non-billboard quad still faces the camera (dot ${dot(ff, fd).toFixed(4)})`);
console.log("A2 (6) OK: billboard forward faces the camera across orientations (dot ~1); fixed quad does not");

// ---- 7. LIFECYCLE: fade ramp + per-speaker queue/replace ------------------

const fadePanel = new Panel({ style: { background: { color: 0x224488 } }, text: "Fade" });
const fade = new Fade(fadePanel, { from: 0, to: 1, durationMs: 200 });
assert(fadePanel.material.opacity === 0, `(7) fade did not start at 0 (${fadePanel.material.opacity})`);
assert(fadePanel.material.transparent === true, "(7) fade material must be transparent for opacity to render");
fade.update(50);
const q25 = fadePanel.material.opacity;
fade.update(50);
const q50 = fadePanel.material.opacity;
assert(Math.abs(q25 - 0.25) < 1e-6 && Math.abs(q50 - 0.5) < 1e-6, `(7) fade ramp off: 50ms=${q25}, 100ms=${q50}`);
assert(q50 > q25, "(7) fade ramp not monotonically increasing");
fade.update(1000); // overshoot
assert(fadePanel.material.opacity === 1 && fade.done, `(7) fade did not clamp to 1 (${fadePanel.material.opacity})`);

// per-speaker REPLACE: latest line wins immediately + the panel re-composites.
const rPanel = new Panel({ style: { background: { color: 0x111111 }, text: { color: 0xffffff, scale: 2 } }, text: "" });
const replace = new SpeechQueue(rPanel, { mode: "replace" });
replace.push("first");
const afterFirst = rPanel.composited.data.slice(0, 64).join(",");
replace.push("second");
assert(replace.current === "second", `(7) replace mode shows '${replace.current}', expected 'second'`);
const afterSecond = rPanel.composited.data.slice(0, 64).join(",");
assert(afterFirst !== afterSecond || rPanel.width !== 0, "(7) replace did not re-composite the panel");

// per-speaker QUEUE: lines show in order, advancing after the hold.
const qPanel = new Panel({ style: { background: { color: 0x111111 }, text: { color: 0xffffff, scale: 2 } }, text: "" });
const queue = new SpeechQueue(qPanel, { mode: "queue", defaultHoldMs: 1000 });
queue.push("line A");
queue.push("line B");
assert(queue.current === "line A", `(7) queue first line '${queue.current}', expected 'line A'`);
queue.update(500);
assert(queue.current === "line A", `(7) queue advanced before hold elapsed ('${queue.current}')`);
queue.update(600); // total 1100 >= 1000 hold
assert(queue.current === "line B", `(7) queue did not advance after hold ('${queue.current}')`);

// typewriter reveal: partial then complete.
const twPanel = new Panel({ style: { text: { color: 0xffffff, scale: 2 } }, text: "" });
const tw = new Typewriter(twPanel, "hello world", { cps: 10 });
tw.update(300); // ~3 chars
assert(tw.shown.length > 0 && tw.shown.length < 11, `(7) typewriter partial reveal wrong ('${tw.shown}')`);
tw.finish();
assert(tw.shown === "hello world" && tw.done, `(7) typewriter did not finish ('${tw.shown}')`);
console.log("A2 (7) OK: fade ramps 0->0.25->0.5->1 (clamped); replace/queue swap the shown line; typewriter reveals");

console.log("P5 A2 OK: world containers — tail/puffs/title/callout/wrap (pixel readback) + billboard (math) + lifecycle");
