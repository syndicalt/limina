import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const launcher = readFileSync(new URL("./run-native-furniture-pack-capture.mjs", import.meta.url), "utf8");

test("furniture launcher is native-only and fail-closed around NVIDIA Xid", () => {
  assert.match(launcher, /js\/src\/demos\/furniture_pack_capture_window\.ts/);
  assert.match(launcher, /\["--window"/);
  assert.match(launcher, /current boot already contains an NVIDIA Xid/);
  assert.match(launcher, /journalctl.*-f.*-n.*0/s);
  assert.match(launcher, /setInterval\(.*kernelLog.*250/s);
  assert.match(launcher, /NVIDIA Xid detected after capture/);
  assert.match(launcher, /must not be retried before reboot/);
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
  assert.match(launcher, /--authority/);assert.match(launcher, /--out-dir/);
  assert.doesNotMatch(launcher, /hearth-settle-v2-r2/);
  assert.match(launcher, /authority\.evidenceViews\.map/);
  assert.match(launcher, /assets\/qc\/internal\/furniture/);
  assert.match(launcher, /append-only furniture capture output already exists/);
  assert.match(launcher, /chmod\(reviewRoot, 0o700\)/);
  assert.match(launcher, /flag:"wx"/);
  assert.match(launcher, /capture-evidence\.json/);
  assert.match(launcher, /captures: artifact\.captures\.map\(\(\{ rgbaBase64/);
  assert.doesNotMatch(launcher, /0\.0\.0\.0|--serve|http\.createServer/);
});

test("furniture launcher passes only an explicit authority to the native demo and cleans its trace",()=>{
  assert.match(launcher,/LIMINA_FURNITURE_REVIEW_AUTHORITY/);assert.match(launcher,/unlink\(tracePath\)/);
  assert.match(launcher,/capture\.reviewState/);assert.match(launcher,/expectedViews\[index\]\.type/);assert.match(launcher,/appliedState/);
});
