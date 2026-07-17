// LIMITATION (known, accepted): this is a SOURCE-TEXT wiring test — it asserts exact
// code fragments in the module's source instead of executing it (execution needs a
// real DOM/WebGPU browser realm; the behavioral twins are the *_browser.test.cjs
// suites, which need chromium). It can FAIL on a harmless rename and stay GREEN
// through a logic inversion the grepped fragments survive. A green here is a wiring
// check, never a behavioral verdict.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../src/viewport.js"), "utf8");

function functionBody(name) {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, "m");
  const match = signature.exec(source);
  assert.ok(match, `missing ${name}`);
  const start = match.index + match[0].lastIndexOf("{");
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return source.slice(start + 1, index);
  }
  assert.fail(`unterminated ${name}`);
}

test("Edit opts into runtime navigation while isolated Play retains gameplay controls", () => {
  assert.equal((source.match(/editorNavigation:\s*\{/g) ?? []).length, 1);
  assert.match(source, /editorNavigation:\s*\{\s*mode: state\.editMode \? "orbit" : navigationPreferences\.mode,\s*speedMps:/s);
  assert.match(source, /function syncPlayUi[\s\S]*?syncNavigationUi\(\);[\s\S]*?limina:authoring-mode/);
});

test("discrete destinations require the exact current Edit runtime and derived client", () => {
  assert.match(source, /createNavigationDestinationCoordinator\(\{/);
  assert.match(source, /state\.running === runtime && state\.derivedEditClient === client/);
  assert.match(source, /state\.scrubLimit === undefined/);
  assert.match(source, /!playLifecycle\.isAuthoringLocked\(\)/);
  assert.match(functionBody("navigateToPose"), /navigationDestination\.navigate\(pose/);
  assert.match(functionBody("focusNavigationSelection"), /navigation\.objectPose\(selected\.mesh\)/);
});

test("navigation pose, mode, and speed survive reboot and Play restoration", () => {
  assert.match(functionBody("captureEditState"), /navigation: running\?\.editorNavigation\?\.snapshot\?\.\(\)/);
  assert.match(functionBody("restoreEditState"), /running\.editorNavigation\.restore\(saved\.navigation\)/);
  assert.match(functionBody("bindNavigationIdentity"), /createNavigationStateController\(\{ storage: graphicsStorage, identity \}\)/);
  assert.match(functionBody("activateEditDerivedRevision"), /bindNavigationIdentity\(snapshot\)/);
});

test("fly input owns editor shortcuts only while RMB capture is active", () => {
  assert.match(source, /state\.running\?\.editorNavigation\?\.isCapturingInput\?\.\(\)/);
  assert.match(source, /if \(!event\.isPrimary \|\| event\.button !== 0\) return;/);
  assert.match(source, /if \(event\.shiftKey\) toggleWireframe\(\);\s*else focusNavigationSelection\(\);/);
  assert.match(functionBody("reconcileNavigationEditMode"), /state\.editMode \? "orbit" : navigationPreferences\.mode/);
  assert.match(source, /if \(state\.running\?\.editorNavigation\?\.isCapturingInput\?\.\(\)\) \{\s*event\.preventDefault\(\);\s*return;\s*\}\s*if \(viewportIsReadOnly\(\)\) return;/);
});

test("destination transactions lock local navigation settings", () => {
  assert.match(functionBody("syncNavigationUi"), /!state\.rebooting && !state\.navigationBusy/);
});

test("bookmarks and recents render through textContent and never HTML injection", () => {
  const item = functionBody("navigationListItem");
  assert.match(item, /activate\.textContent/);
  assert.match(item, /remove\.textContent/);
  assert.doesNotMatch(item, /innerHTML|insertAdjacentHTML/);
  assert.match(functionBody("renderNavigationViews"), /navigationStateController\?\.snapshot\(\)/);
});

test("closing a navigation panel cannot fall through into catalog Escape handling", () => {
  assert.match(source, /const gotoOpen = viewportUi\.navigationGoto\?\.hidden === false;/);
  assert.match(source, /event\.stopImmediatePropagation\(\);\s*closeNavigationPanels\(\);/);
  assert.match(source, /gotoOpen \? viewportUi\.navigationGotoToggle : searchOpen \? viewportUi\.navigationSearchToggle : viewportUi\.navigationViewsToggle/);
});
