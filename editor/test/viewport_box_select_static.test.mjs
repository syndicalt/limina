// LIMITATION (known, accepted): this is a SOURCE-TEXT wiring test — it asserts exact
// code fragments in the module's source instead of executing it (execution needs a
// real DOM/WebGPU browser realm; the behavioral twins are the *_browser.test.cjs
// suites, which need chromium). It can FAIL on a harmless rename and stay GREEN
// through a logic inversion the grepped fragments survive. A green here is a wiring
// check, never a behavioral verdict.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/viewport.js", import.meta.url), "utf8");

function listenerBody(eventName, occurrence = 0) {
  const pattern = new RegExp(`canvas\\.addEventListener\\("${eventName}"`, "g");
  let match;
  for (let i = 0; i <= occurrence; i++) {
    match = pattern.exec(source);
    assert.ok(match, `missing canvas ${eventName} listener #${occurrence}`);
  }
  const start = source.indexOf("{", match.index);
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return source.slice(start + 1, index);
  }
  assert.fail(`unterminated ${eventName} listener`);
}

function ordered(body, fragments, label) {
  let cursor = -1;
  for (const fragment of fragments) {
    const next = body.indexOf(fragment, cursor + 1);
    assert.ok(next > cursor, `${label}: '${fragment}' is missing or out of order`);
    cursor = next;
  }
}

test("shift+drag with select.pick armed starts a marquee and suppresses orbit", () => {
  const down = listenerBody("pointerdown");
  ordered(down, [
    "event.shiftKey",
    'viewportTooling.controller.activeId() === "select.pick"',
    "boxSelect.active = true",
    "canvas.setPointerCapture(event.pointerId)",
    "state.running?.setCameraControlsEnabled?.(false)",
  ], "marquee start");
  // The marquee branch precedes the terrain-sculpt branch so shift+drag never sculpts.
  assert.ok(down.indexOf("event.shiftKey") < down.indexOf("state.brushStroking = true"));
});

test("pointermove tracks the marquee; pointerup finalizes through the selection store", () => {
  const move = listenerBody("pointermove");
  ordered(move, ["boxSelect.active", "updateMarqueeOverlay()"], "marquee drag");

  const up = listenerBody("pointerup");
  ordered(up, [
    "boxSelect.active",
    "BOX_SELECT_MIN_DRAG_PX",
    "entitiesInMarquee(",
    'editorSelection.clear("viewport")',
    'editorSelection.selectMany(ids, "viewport")',
  ], "marquee finalize");
  // An empty-rect hit clears BEFORE the non-empty selectMany (if/else order).
  assert.ok(up.indexOf('editorSelection.clear("viewport")') < up.indexOf("editorSelection.selectMany"));

  const cancel = listenerBody("pointercancel");
  assert.match(cancel, /boxSelect\.active[^]*endBoxSelect\(\)/);
});

test("marquee helpers project through the camera and reuse one scratch vector", () => {
  assert.match(source, /const marqueeScratch = new THREE\.Vector3\(\)/);
  const hitTest = source.slice(source.indexOf("function entitiesInMarquee"));
  ordered(hitTest, [
    "running.entities.ids()",
    "getWorldPosition(marqueeScratch).project(running.camera)",
  ], "marquee hit test");
  assert.match(source, /marqueeEl\.style\.cssText/);
  assert.match(source, /rgba\(74,163,255,0\.9\)/);
});

test("secondary selections get accent BoxHelpers, rebuilt on change and reboot", () => {
  assert.match(source, /const secondaryHelpers = new Map\(\)/);
  assert.match(source, /new THREE\.BoxHelper\(mesh, SECONDARY_SELECTION_COLOR\)/);
  const subscribe = source.slice(source.indexOf("editorSelection.subscribe("));
  ordered(subscribe, ["selectEntity(selectedId, state.running)", "rebuildSecondaryHelpers()"], "selection subscribe");
  const reboot = source.slice(source.indexOf("async function reboot("));
  ordered(reboot, ["selectEntity(selectedId, state.running)", "rebuildSecondaryHelpers()"], "reboot re-parent");
});

test("Delete destroys every id in getMany(), sequentially, and re-selects survivors", () => {
  const keydown = source.slice(source.lastIndexOf('window.addEventListener("keydown"'));
  assert.match(keydown, /event\.key !== "Delete" && event\.key !== "Backspace"/);
  ordered(keydown, [
    "editorSelection.getMany()",
    "deselectEntity()",
    "for (const id of ids)",
    "await destroyEntity(id)",
    "surfaceViewportWarning(\"destroy failed\", e)",
    'editorSelection.selectMany(survivors, "delete")',
  ], "multi-delete");
});
