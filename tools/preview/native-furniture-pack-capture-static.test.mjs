import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GUARDED_NATIVE_CAPTURE_CONTRACTS } from "./guarded-capture-publication.mjs";
import {
  assertCall,
  assertPropertyValue,
  findPropertyAssignments,
  parseTypeScript,
} from "./source-semantics.test-helper.mjs";

const launcher = readFileSync(new URL("./run-native-furniture-pack-capture.mjs", import.meta.url), "utf8");
const launcherFile = parseTypeScript(launcher, "run-native-furniture-pack-capture.mjs");

test("furniture launcher is native-only and fail-closed around NVIDIA Xid", () => {
  assert.match(launcher, /js\/src\/demos\/furniture_pack_capture_window\.ts/);
  assert.deepEqual(
    GUARDED_NATIVE_CAPTURE_CONTRACTS.find(({ runner }) => runner.endsWith("run-native-furniture-pack-capture.mjs")),
    {
      runner: "tools/preview/run-native-furniture-pack-capture.mjs",
      module: "js/src/demos/furniture_pack_capture_window.ts",
    },
  );
  assertCall(launcherFile, "runGuardedCaptureWithSourceClosure");
  assert.doesNotMatch(launcher, /node:child_process|journalctl/);
});

test("furniture launcher forbids timestamp risk and validates engine evidence", () => {
  assert.match(launcher, /delete captureEnv\.LIMINA_GPU_TIMESTAMP_RISK_ACK/);
  assert.match(launcher, /delete captureEnv\.LIMINA_GPU_TIMESTAMP_MODE/);
  assert.match(launcher, /delete captureEnv\.LIMINA_GPU_TIMESTAMP_QUERIES/);
  assert.match(launcher, /gpuTimestampMode !== "disabled"/);
  assert.match(launcher, /timestampQueriesEnabled !== false/);
  assert.match(launcher, /single-production-frame-all-passes/);
  assert.match(launcher, /renderer-live-after-production-frame/);
  assert.match(launcher, /compound-semantic-functional-placement/);
  assert.match(launcher, /mounted\?\.functionalEvidence/);
  assert.match(launcher, /mounted\?\.authoritativeBounds/);
  assert.doesNotMatch(launcher, /measuredBounds/);
  assert.match(launcher, /artifact\.lifecycle/);
  assert.match(launcher, /paired-render-submission\/v1/);
  assert.match(launcher, /Math\.abs\(value - expectedAuthoritativeBounds\[index\]\) > 0\.002/);
});

test("furniture launcher binds all views and writes only private review artifacts", () => {
  assert.match(launcher, /--authority/);
  assert.match(launcher, /--out-dir/);
  assert.doesNotMatch(launcher, /hearth-settle-v2-r2/);
  assertCall(launcherFile, "authority.evidenceViews.map");
  assert.match(launcher, /assets\/qc\/internal\/furniture/);
  assert.match(launcher, /append-only furniture capture output already exists/);
  assert.match(launcher, /chmod\(reviewRoot, 0o700\)/);
  assertPropertyValue(launcherFile, "flag", "wx");
  assert.match(launcher, /capture-evidence\.json/);
  assertCall(launcherFile, "artifact.captures.map");
  assert.doesNotMatch(launcher, /0\.0\.0\.0|--serve|http\.createServer/);
});

test("furniture launcher passes only an explicit authority to the native demo and cleans its trace", () => {
  assert.ok(findPropertyAssignments(launcherFile, "LIMINA_FURNITURE_REVIEW_AUTHORITY").length > 0);
  assertCall(launcherFile, "unlink", ["tracePath"]);
  assert.match(launcher, /capture\.reviewState/);
  assert.match(launcher, /expectedViews\[index\]\.type/);
  assert.match(launcher, /appliedState/);
});
