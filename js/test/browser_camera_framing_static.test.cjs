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

const source = fs.readFileSync(path.join(__dirname, "../src/browser-entry.ts"), "utf8");

test("map-generated editable terrain selects large-world framing defaults", () => {
  // Fast-boot (86edda0): framing derives from the EFFECTIVE command list — the
  // snapshot-boot program + tail when a snapshot rides along, opts.commands otherwise —
  // so a fast-booted world frames identically to its full-replay twin.
  assert.match(source, /const effectiveCommands = bootSnapshotProgram === undefined \? opts\.commands : \[\.\.\.bootSnapshotProgram, \.\.\.opts\.commands\]/);
  assert.match(source, /const commandCameraFrame = deriveCommandCameraFrame\(effectiveCommands\)/);
  assert.match(source, /const largeMapTerrainPlanned = streamingPlanned \|\| commandCameraFrame\.largeMapTerrain/);
  assert.match(source, /orbitCenter = opts\.orbit\?\.center \?\?/);
  assert.match(source, /opts\.orbit\?\.radius \?\? commandCameraFrame\.orbitRadiusM/);
  assert.match(source, /opts\.orbit\?\.height \?\? commandCameraFrame\.orbitHeightM/);
  assert.match(source, /cam\.far = opts\.orbit\.far;/, "explicit orbit far no longer overrides derived defaults");
});

test("OrbitControls have production terrain-view constraints", () => {
  assert.match(source, /cameraControls\.minDistance =/);
  assert.match(source, /cameraControls\.maxDistance =/);
  assert.match(source, /cameraControls\.minPolarAngle = 0\.04/);
  assert.match(source, /cameraControls\.maxPolarAngle = commandCameraFrame\.controls\.maxPolarAngleRad/);
});

test("runtime exposes target-driven threshold residency and cleans it up", () => {
  assert.match(source, /subscribeDerivedTerrainResidency\(listener: DerivedTerrainResidencyListener\): \(\) => void/);
  assert.match(source, /cameraControls\.target\.x, cameraControls\.target\.z/);
  assert.match(source, /derivedTerrainResidencyTracker\.setGrid\(candidate\.snapshot\.manifest\.grid\)/);
  assert.match(source, /derivedTerrainResidency: \(\).*derivedTerrainResidencyTracker\.current\(\)/);
  assert.match(source, /subscribeDerivedTerrainResidency: \(listener: DerivedTerrainResidencyListener\)/);
  assert.match(source, /derived terrain residency\", \(\) => cleanupDerivedTerrainResidency\?\.\(\)/);
});
