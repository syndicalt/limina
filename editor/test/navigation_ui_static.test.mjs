// LIMITATION (known, accepted): this is a SOURCE-TEXT wiring test — it asserts exact
// code fragments in the module's source instead of executing it (execution needs a
// real DOM/WebGPU browser realm; the behavioral twins are the *_browser.test.cjs
// suites, which need chromium). It can FAIL on a harmless rename and stay GREEN
// through a logic inversion the grepped fragments survive. A green here is a wiring
// check, never a behavioral verdict.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, css] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../styles.css", import.meta.url), "utf8"),
]);

const requiredIds = [
  "viewport-navigation-mode", "viewport-navigation-orbit", "viewport-navigation-fly", "viewport-navigation-speed",
  "viewport-navigation-focus", "viewport-navigation-goto-toggle", "viewport-navigation-goto", "viewport-navigation-goto-close",
  "viewport-navigation-goto-cancel", "viewport-navigation-goto-submit", "viewport-navigation-x", "viewport-navigation-y",
  "viewport-navigation-z", "viewport-navigation-goto-status", "viewport-navigation-views-toggle", "viewport-navigation-views",
  "viewport-navigation-views-close", "viewport-navigation-bookmark-form", "viewport-navigation-bookmark-name",
  "viewport-navigation-bookmark-save", "viewport-navigation-bookmarks", "viewport-navigation-recents",
];

test("navigation controls expose one unique stable DOM contract", () => {
  for (const id of requiredIds) {
    const matches = html.match(new RegExp(`id=["']${id}["']`, "g")) ?? [];
    assert.equal(matches.length, 1, `${id} must occur exactly once`);
  }
  assert.match(html, /id="viewport-navigation-mode"[^>]*role="radiogroup"[^>]*aria-label="Navigation mode"/);
  assert.match(html, /id="viewport-navigation-orbit"[^>]*role="radio"[^>]*aria-checked="true"[^>]*tabindex="0"/);
  assert.match(html, /id="viewport-navigation-fly"[^>]*role="radio"[^>]*aria-checked="false"[^>]*tabindex="-1"/);
  assert.match(html, /id="viewport-navigation-fly"[^>]*title="Hold right mouse to look; WASD moves;/);
  assert.match(html, /id="viewport-navigation-speed"[^>]*type="number"[^>]*min="0\.25"[^>]*max="2048"/);
});

test("coordinate and views panels are compact, labelled, and hidden initially", () => {
  assert.match(html, /id="viewport-navigation-goto"[^>]*role="dialog"[^>]*aria-labelledby="viewport-navigation-goto-title"[^>]*hidden/);
  assert.match(html, /id="viewport-navigation-views"[^>]*aria-labelledby="viewport-navigation-views-title"[^>]*hidden/);
  for (const axis of ["x", "y", "z"]) {
    assert.match(html, new RegExp(`for="viewport-navigation-${axis}"`));
    assert.match(html, new RegExp(`id="viewport-navigation-${axis}"[^>]*required`));
  }
  assert.match(html, /id="viewport-navigation-bookmark-name"[^>]*maxlength="64"/);
});

test("navigation is a dedicated overlay below graphics with bounded mobile popovers", () => {
  const stackStart = html.indexOf('<div class="viewport-overlay-stack">');
  const graphicsStart = html.indexOf('<div class="viewport-graphics"', stackStart);
  const navigationStart = html.indexOf('<div class="viewport-navigation">', graphicsStart);
  assert.ok(stackStart >= 0 && graphicsStart > stackStart && navigationStart > graphicsStart);
  assert.match(css, /\.viewport-overlay-stack\s*\{[^}]*position:\s*absolute[^}]*flex-direction:\s*column/s);
  assert.match(css, /\.viewport-navigation\s*\{[^}]*position:\s*relative[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.navigation-popover\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /@media \(max-width:\s*720px\)[\s\S]*\.navigation-toolbar\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /@media \(max-width:\s*720px\)[\s\S]*\.navigation-popover\s*\{[^}]*top:\s*calc\(100% \+ 5px\)[^}]*width:\s*min\(334px, calc\(100vw - 16px\)\)/);
});
