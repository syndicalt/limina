// Phase 5-A / A3 — Screen-space HUD / overlay.
//
// Proves the screen-anchored panel layer:
//
//   A. CAMERA-INDEPENDENT — a HUD panel anchored to a screen corner projects to
//      the SAME screen-pixel region across two very different camera
//      orientations. The panel is NOT a world object: it is re-derived relative
//      to the camera each frame, so projection*view*world cancels the camera
//      transform. Falsifiable: a WORLD-fixed quad projects to DIFFERENT pixels
//      when the camera moves (it would slide around the screen).
//   B. OVER THE SCENE — the ScreenAnchor turns depthTest + depthWrite OFF and
//      bumps renderOrder, the exact GPU state three's renderer uses to draw the
//      overlay on top. Asserted as a real before/after (a plain panel keeps
//      depthTest ON and would be occluded).
//   C. DPI / VIEWPORT AWARE — the same corner + px margin lands at the expected
//      screen pixel at two different viewport sizes (1 composited texel == 1
//      screen pixel at any size).
//   D. SCROLLING FEED — append lines; the feed keeps the latest N newest-in-
//      order; the oldest scrolls off. Falsifiable: one more append shifts the
//      window by one.
//
// Run (headless): ./target/debug/limina js/test/p5_hud.ts

import * as THREE from "../build/three.bundle.mjs";
import { hudPanel } from "../src/ui/containers.ts";
import { Panel } from "../src/ui/surface.ts";
import { ScreenAnchor, WorldAnchor } from "../src/ui/anchor.ts";
import { FeedModel } from "../src/ui/lifecycle.ts";
import { truncateToWidth } from "../src/ui/layout.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("P5 A3 FAIL: " + message);
}

const W = 960;
const H = 640;
const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 200);

/** Project a world position to screen pixels with the current camera. */
function projectPx(pos: [number, number, number]): { x: number; y: number } {
  camera.updateMatrixWorld(true);
  const n = new THREE.Vector3(pos[0], pos[1], pos[2]).project(camera);
  return { x: (n.x * 0.5 + 0.5) * W, y: (0.5 - n.y * 0.5) * H };
}
function setCamera(px: number, py: number, pz: number, tx: number, ty: number, tz: number): void {
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  camera.position.set(px, py, pz);
  camera.lookAt(tx, ty, tz);
  camera.updateMatrixWorld(true);
}

// ---- A. CAMERA-INDEPENDENT screen anchor ----------------------------------

const hud = hudPanel({ lines: ["PERCEIVE ok", "DECIDE move", "LLM 142ms"], title: "AGENT OPS", width: 280 });
const anchor = new ScreenAnchor(hud, { corner: "top-right", marginPx: [20, 16], distance: 1.5 });
const target = anchor.targetPixel(W, H);

setCamera(0, 2, 9, 0, 0, 0); // orientation 1
anchor.update(camera, W, H);
const p1 = projectPx(anchor.worldPosition());

setCamera(11, 7, -10, 1, 1, 1); // orientation 2 — very different
anchor.update(camera, W, H);
const p2 = projectPx(anchor.worldPosition());

console.log(`A3 HUD target px (${target.x.toFixed(1)},${target.y.toFixed(1)}); orient1 (${p1.x.toFixed(1)},${p1.y.toFixed(1)}); orient2 (${p2.x.toFixed(1)},${p2.y.toFixed(1)})`);
assert(Math.abs(p1.x - target.x) < 1 && Math.abs(p1.y - target.y) < 1, `(A) HUD did not land at its corner (orient1)`);
assert(Math.abs(p2.x - p1.x) < 1 && Math.abs(p2.y - p1.y) < 1, `(A) HUD moved across camera orientations: d=(${(p2.x - p1.x).toFixed(2)},${(p2.y - p1.y).toFixed(2)})`);
// it landed in the TOP-RIGHT region (not center) — a real corner anchor.
assert(target.x > W * 0.6 && target.y < H * 0.4, `(A) top-right corner target is not in the top-right region`);

// Falsifiable: a WORLD-fixed quad slides on screen when the camera moves.
const worldQuad = new Panel({ style: { background: { color: 0x224488 } }, text: "world" });
const worldAnchor = new WorldAnchor(worldQuad, { position: [0, 0, 0], billboard: true });
setCamera(0, 2, 9, 0, 0, 0);
worldAnchor.update(camera);
const w1 = projectPx(worldAnchor.worldPosition());
setCamera(11, 7, -10, 1, 1, 1);
worldAnchor.update(camera);
const w2 = projectPx(worldAnchor.worldPosition());
const worldDelta = Math.hypot(w2.x - w1.x, w2.y - w1.y);
assert(worldDelta > 20, `(A) falsifiable: a world-fixed quad should slide on screen but moved only ${worldDelta.toFixed(1)}px`);
console.log(`A3 (A) OK: screen anchor is camera-independent (delta < 1px); a world quad slid ${worldDelta.toFixed(0)}px`);

// ---- B. OVER THE SCENE: depthTest/depthWrite off + renderOrder bumped ------

const plain = new Panel({ style: { background: { color: 0x111111 } }, text: "x" });
assert(plain.material.depthTest === true, "(B) baseline panel should have depthTest ON (would be occluded)");
const plainMesh = plain.mesh as unknown as { renderOrder: number };
const overlay = new Panel({ style: { background: { color: 0x111111 } }, text: "x" });
const overlayMeshAnchor = new ScreenAnchor(overlay, { corner: "bottom-left", renderOrder: 1500 });
const overlayMesh = overlay.mesh as unknown as { renderOrder: number };
assert(overlay.material.depthTest === false, "(B) screen-anchored panel must disable depthTest to draw over the scene");
assert(overlay.material.depthWrite === false, "(B) screen-anchored panel must disable depthWrite");
assert(overlay.material.transparent === true, "(B) screen-anchored panel must be transparent");
assert(overlayMesh.renderOrder >= 1000 && overlayMesh.renderOrder > plainMesh.renderOrder, `(B) overlay renderOrder not bumped above scene (${overlayMesh.renderOrder})`);
void overlayMeshAnchor;
console.log(`A3 (B) OK: screen anchor draws over the scene (depthTest off, depthWrite off, renderOrder ${overlayMesh.renderOrder})`);

// ---- C. DPI / viewport-aware corner placement -----------------------------

// Same corner + px margin should land at the expected pixel at two viewport sizes.
function cornerCheck(vw: number, vh: number): void {
  const p = hudPanel({ lines: ["a", "b"], width: 200 });
  const a = new ScreenAnchor(p, { corner: "top-right", marginPx: [24, 18], distance: 2 });
  camera.aspect = vw / vh;
  camera.updateProjectionMatrix();
  camera.position.set(3, 1, 6);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  a.update(camera, vw, vh);
  camera.updateMatrixWorld(true);
  const n = new THREE.Vector3(...a.worldPosition()).project(camera);
  const sx = (n.x * 0.5 + 0.5) * vw;
  const sy = (0.5 - n.y * 0.5) * vh;
  const tgt = a.targetPixel(vw, vh);
  assert(Math.abs(sx - tgt.x) < 1 && Math.abs(sy - tgt.y) < 1, `(C) ${vw}x${vh}: projected (${sx.toFixed(1)},${sy.toFixed(1)}) != target (${tgt.x.toFixed(1)},${tgt.y.toFixed(1)})`);
  // top-right: the panel's right edge sits a fixed margin from the right edge.
  assert(tgt.x + p.width / 2 <= vw && vw - (tgt.x + p.width / 2) >= 23 && vw - (tgt.x + p.width / 2) <= 25, `(C) ${vw}x${vh}: right margin not preserved`);
}
cornerCheck(960, 640);
cornerCheck(1920, 1080);
// restore camera aspect for any later use
camera.aspect = W / H;
camera.updateProjectionMatrix();
console.log("A3 (C) OK: corner + px margin land correctly at 960x640 and 1920x1080 (1 texel = 1 px, DPI-aware)");

// ---- D. SCROLLING FEED: latest N, newest in order -------------------------

const feedPanel = hudPanel({ lines: [], title: "FEED", width: 260 });
const feed = new FeedModel({ maxLines: 4, panel: feedPanel, title: "FEED" });
for (const line of ["evt 1", "evt 2", "evt 3", "evt 4", "evt 5", "evt 6"]) feed.append(line);
assert(feed.size === 4, `(D) feed kept ${feed.size} lines, expected 4`);
assert(feed.lines().join("|") === "evt 3|evt 4|evt 5|evt 6", `(D) feed window wrong: ${feed.lines().join("|")}`);
// the panel re-composited to show the visible window.
assert(feedPanel.composited.height > 0, "(D) feed panel did not composite");
// Falsifiable: one more append scrolls the window by exactly one.
feed.append("evt 7");
assert(feed.lines().join("|") === "evt 4|evt 5|evt 6|evt 7", `(D) feed did not scroll on append: ${feed.lines().join("|")}`);
console.log("A3 (D) OK: scrolling feed keeps the latest 4 lines newest-in-order; append scrolls by one");

// ---- E. FIXED-SIZE SCROLLING CONSOLE: constant box, latest-N, truncated rows -
//
// A console-style HUD: pinned width + a FIXED number of visible rows (so a fixed
// height) + each line truncated to ONE row (ellipsis, no wrap). The box must stay
// the SAME size as events stream — a long line can never balloon it. Falsifiable:
// removing the line-cap (towering feed) or the truncation (wrapped column) grows
// the box.
const CN = 8; // fixed visible rows (a reasonable console height)
const CW = 320; // pinned width
const LONG = "Willow: the river remembers every leaf that ever fell into the slow green current at dusk and far longer still";

const consolePanel = hudPanel({ lines: [], title: "AGENT OPS", width: CW, maxLines: CN });
const cw0 = consolePanel.composited.width;
const ch0 = consolePanel.composited.height;
assert(cw0 === CW, `(E) console width not pinned to ${CW} (got ${cw0})`);
assert(ch0 > 0, "(E) console did not composite a height");

const consoleFeed = new FeedModel({ maxLines: CN, panel: consolePanel, title: "AGENT OPS" });
// Stream MANY lines (> N), incl. an over-long one, exactly as live ops would.
for (let i = 0; i < 30; i++) consoleFeed.append(`evt ${i}`);
consoleFeed.append(LONG); // newest line is over-long (now visible at the bottom)

// 1) The box DID NOT GROW: width AND height unchanged from the fixed initial size.
assert(consolePanel.composited.width === cw0, `(E) console width grew ${cw0} -> ${consolePanel.composited.width}`);
assert(consolePanel.composited.height === ch0, `(E) console height grew ${ch0} -> ${consolePanel.composited.height} (box ballooned)`);

// 2) The visible feed is EXACTLY the latest N, newest last (oldest scrolled off).
assert(consoleFeed.size === CN, `(E) console kept ${consoleFeed.size} rows, expected ${CN}`);
const want = ["evt 23", "evt 24", "evt 25", "evt 26", "evt 27", "evt 28", "evt 29", LONG];
assert(consoleFeed.lines().join("|") === want.join("|"), `(E) visible feed not the latest ${CN}: ${consoleFeed.lines().join("|")}`);

// 3) The over-long line is TRUNCATED to one row (ellipsis), never wrapped.
const contentW = CW - (2 * 1 + 12 + 12); // pinned width minus HUD border (1) + L/R padding (12)
const truncated = truncateToWidth(LONG, contentW, 2, 0);
assert(!truncated.includes("\n"), "(E) truncated line wrapped (contains a newline)");
assert(truncated.endsWith("..."), `(E) truncated line missing the ellipsis: ${JSON.stringify(truncated)}`);
assert(truncated.length < LONG.length, "(E) over-long line was not shortened");

// Falsifiable A — the LINE-CAP is load-bearing: the SAME 31 lines in an UNCAPPED
// panel grow the box far past the fixed console height.
const allLines = [...Array(30)].map((_, i) => `evt ${i}`).concat(LONG);
const uncapped = hudPanel({ title: "AGENT OPS", width: CW, lines: allLines });
assert(uncapped.composited.height > ch0 * 2, `(E) falsifiable: uncapped feed should tower over the console (${uncapped.composited.height} vs ${ch0})`);

// Falsifiable B — TRUNCATION (no wrap) is load-bearing: one over-long line in a
// 1-row console stays one row; the SAME line uncapped wraps into a tall column.
const oneRow = hudPanel({ title: "AGENT OPS", width: CW, maxLines: 1, lines: [LONG] });
const wrappedCol = hudPanel({ title: "AGENT OPS", width: CW, lines: [LONG] });
assert(oneRow.composited.height < wrappedCol.composited.height, `(E) falsifiable: truncated 1-row (${oneRow.composited.height}) should be shorter than the wrapped column (${wrappedCol.composited.height})`);

console.log(`A3 (E) OK: fixed-size scrolling console — box stays ${cw0}x${ch0} as 31 lines stream (latest ${CN} shown, one truncated row each); uncapped feed towers ${uncapped.composited.height}px, a wrapped long line ${wrappedCol.composited.height}px`);

console.log("P5 A3 OK: screen HUD — camera-independent corner anchor + over-scene z-order + DPI placement + scrolling feed + fixed-size scrolling console");
