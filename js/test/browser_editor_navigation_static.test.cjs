const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../src/browser-entry.ts"), "utf8");

function ordered(...fragments) {
  let cursor = -1;
  for (const fragment of fragments) {
    const next = source.indexOf(fragment, cursor + 1);
    assert.ok(next > cursor, `missing or out-of-order runtime contract: ${fragment}`);
    cursor = next;
  }
}

test("runtime owns editor navigation while preserving legacy OrbitControls access", () => {
  assert.match(source, /editorNavigation\?: boolean \| Readonly</);
  assert.match(source, /editorNavigation\?: RunningEditorNavigation/);
  assert.match(source, /new EditorNavigationController\(\{/);
  assert.match(source, /cameraControls = editorNavigation\.orbitControls/);
  assert.match(source, /cameraControls,\s*editorNavigation,/);
  assert.match(source, /if \(editorNavigation !== undefined\) editorNavigation\.setEnabled\(on\)/);
});

test("gameplay input listeners attach only when a player owns the camera", () => {
  const pump = source.indexOf("const liveInput = new LivePlayerInput();");
  const playerGate = source.indexOf("if (playerEid !== undefined && editorNavigation === undefined)", pump);
  const attach = source.indexOf("liveInput.attach(opts.input", pump);
  assert.ok(pump >= 0 && playerGate > pump && attach > playerGate,
    "LivePlayerInput attached globally before player/editor camera ownership was known");
  assert.equal(source.slice(pump, playerGate).includes("liveInput.attach(opts.input"), false,
    "non-player Edit runtime still captures gameplay keys");
});

test("one mode-aware anchor drives every editor streaming and shadow system", () => {
  assert.match(source, /editorNavigation\.writeAnchor\(navigationAnchor\)/);
  assert.match(source, /derivedTerrainResidencyTracker\.update\(navigationAnchor\.x, navigationAnchor\.z\)/);
  assert.match(source, /const streamX = editorNavigation === undefined \? camPos\.x : navigationAnchor\.x/);
  assert.match(source, /terrainStream\?\.update\(streamX, streamZ\)/);
  assert.match(source, /grassStream\?\.update\(streamX, streamZ\)/);
  assert.match(source, /entityStream\?\.update\(streamX, streamZ\)/);
  assert.match(source, /navigationFocus\[0\] = navigationAnchor\.x/);
});

test("manifest grid constrains orbit coverage before tracker activation", () => {
  ordered(
    "editorNavigation?.constrainToResidencyGrid(candidate.snapshot.manifest.grid.chunkSizeM, 7, 2);",
    "derivedTerrainResidencyTracker.setGrid(candidate.snapshot.manifest.grid);",
  );
});

test("navigation listeners and OrbitControls are disposed exactly once", () => {
  ordered(
    'await step("editor navigation", () => cleanupEditorNavigation?.dispose());',
    'await step("camera controls", () => cleanupCameraControls?.dispose());',
  );
  assert.match(source, /cleanupEditorNavigation = editorNavigation/);
  assert.doesNotMatch(source, /cleanupCameraControls = cameraControls;\s*cameraControls = editorNavigation\.orbitControls/);
});
