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
  assert.match(source, /requireDerivedDisposalCapacity\(\);[\s\S]{0,100}new DetachedDerivedRenderCandidate/);
  assert.match(source, /await step\(\"derived disposal retries\", retryFailedDerivedDisposals\)/);
});
