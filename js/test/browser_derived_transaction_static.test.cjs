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

function ordered(...needles) {
  let offset = 0;
  for (const needle of needles) {
    const next = source.indexOf(needle, offset);
    assert.notEqual(next, -1, `missing transaction contract: ${needle}`);
    offset = next + needle.length;
  }
}

test("commit dispatch is an irreversible fail-closed boundary", () => {
  ordered(
    "commitDispatched = true;",
    "requestDerivedWorker(\"commitDerivedRevision\"",
    "simCommitted = true;",
    "cancelled();",
    "if (commitDispatched)",
    "derived revision commit outcome is indeterminate",
    "failLive(",
  );
  assert.match(source, /if \(!failClosed && releaseActivationPause !== undefined\)/,
    "fail-closed activation can still release its pause lease");
});

test("public pause intent and activation suspension are independent", () => {
  assert.match(source, /const target = publicPauseIntent \|\| activationPauseLeases > 0/);
  assert.match(source, /publicPauseIntent = next;\s*return reconcilePaused\(\)/);
  assert.match(source, /activationPauseLeases\+\+;[\s\S]*activationPauseLeases--;/);
});

test("authoring and derived activation share one mutation queue", () => {
  assert.match(source, /return serializeRuntimeMutation\(work\);/);
  assert.match(source, /applyAuthorCommands:[\s\S]{0,180}serializeRuntimeMutation\(async \(\) =>/);
});

test("quality, suppression, and disposal lifecycle remain bounded", () => {
  assert.match(source, /candidate\.setQuality\(renderSession\.quality\(\)\.tier\);[\s\S]{0,100}scene\.add\(candidate\.root\)/);
  assert.match(source, /stagingDerivedCandidate\?\.setQuality\(nextTier\)/);
  assert.match(source, /configureAuthoredTerrainFarField\(layer\.mesh\)/,
    "derived activation does not retain the authored full-map far-field underlay");
  assert.match(source, /input\.raycast = \(\) => \{\};/,
    "far-field terrain can intercept editor raycasts");
  assert.match(source, /material\.polygonOffset = true;[\s\S]{0,160}material\.polygonOffsetUnits = 4;/,
    "far-field terrain can z-fight the derived window");
  assert.match(source, /suppressedAuthoredTerrainBodies\.clear\(\);\s*for \(const bodyId of currentBodies\)/);
  assert.match(source, /MAX_FAILED_DERIVED_DISPOSALS = 8/);
  // H8 (PR C1): capacity is reserved BEFORE verification, verification runs off the
  // main thread, and the candidate is constructed only from the verified snapshot.
  assert.match(source, /requireDerivedDisposalCapacity\(\);[\s\S]{0,600}await verifyDerivedSnapshotOffThread\(snapshot\);[\s\S]{0,60}cancelled\(\);[\s\S]{0,60}new DetachedDerivedRenderCandidate\(verifiedSnapshot/);
  assert.match(source, /await step\(\"derived disposal retries\", retryFailedDerivedDisposals\)/);
});

test("active navigation API searches only the verified active candidate snapshot", () => {
  assert.match(source, /searchDerivedNavigation: \(prefix: string, limit = 20\) => searchTransferredDerivedNavigation\(\s*activeDerivedRevision\?\.candidate\.snapshot \?\? null,\s*prefix,\s*limit,/);
});

test("world overview presentation bounds fog and restores the captured local density", () => {
  assert.match(source, /if \(localFogDensity === undefined\) localFogDensity = fog\.density;/);
  assert.match(source, /if \(!enabled\) \{\s*fog\.density = localFogDensity;\s*return true;/);
  assert.match(source, /Math\.min\(localFogDensity, 1 \/ Math\.max\(2_400, span \* 3\)\)/);
});
