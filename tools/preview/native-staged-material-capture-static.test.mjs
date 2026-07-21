import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertCall,
  assertComparison,
  assertDelete,
  assertPropertyValue,
  collect,
  findPropertyAssignments,
  literalValue,
  parseTypeScript,
  propertyPath,
  ts,
} from "./source-semantics.test-helper.mjs";
const runner = readFileSync(new URL("./run-native-staged-material-capture.mjs", import.meta.url), "utf8"),
  demo = readFileSync(new URL("../../js/src/demos/staged_material_capture_window.ts", import.meta.url), "utf8");
const runnerFile = parseTypeScript(runner, "run-native-staged-material-capture.mjs"),
  demoFile = parseTypeScript(demo, "staged_material_capture_window.ts");
test("M1 production capture is native, canonical, fixed, and engine-mounted", () => {
  assert.match(runner, /staged_material_capture_window\.ts/);
  assert.match(
    runner,
    /poly-haven-pack-swatches,authored-simple-role-swatches,representative-exterior-shell-crop,representative-interior-hearth-crop/,
  );
  assertComparison(runnerFile, "minimumWidth", "<", 1920);
  assertComparison(runnerFile, "minimumHeight", "<", 1080);
  assert.match(demo, /mountStagedMaterialReview/);
  assert.match(demo, /fixedTimeSeconds/);
  assertPropertyValue(demoFile, "neutral", true);
});
test("M1 capture is fail-closed around Xid and every timestamp environment variable", () => {
  assert.match(runner, /runGuardedCaptureWithSourceClosure/);
  assert.doesNotMatch(runner, /node:child_process|journalctl/);
  assertDelete(runnerFile, "captureEnv.LIMINA_GPU_TIMESTAMP_RISK_ACK");
  assertDelete(runnerFile, "captureEnv.LIMINA_GPU_TIMESTAMP_MODE");
  assertDelete(runnerFile, "captureEnv.LIMINA_GPU_TIMESTAMP_QUERIES");
  assert.ok(
    collect(
      runnerFile,
      (node) =>
        ts.isDeleteExpression(node) &&
        ts.isElementAccessExpression(node.expression) &&
        propertyPath(node.expression.expression) === "captureEnv" &&
        propertyPath(node.expression.argumentExpression) === "key",
    ).length > 0,
  );
  assertComparison(runnerFile, "artifact.timingPolicy.gpuTimestampMode", "!==", "disabled");
  assertComparison(runnerFile, "artifact.timingPolicy.timestampQueriesEnabled", "!==", false);
});
test("M1 runner validates telemetry and writes only private artifacts after deleting trace", () => {
  assert.match(runner, /single-production-frame-all-passes/);
  assert.match(runner, /paired-render-submission\/v1/);
  assert.match(runner, /renderer-live-after-production-frame/);
  assert.match(runner, /cpu-pixel-exposure\/v1/);
  assert.match(runner, /assets\/qc\/internal\/materials\/functional-hall-house-v4/);
  assertCall(runnerFile, "unlink", ["tracePath"]);
  assertCall(runnerFile, "chmod", ["reviewRoot", 0o700]);
  assertCall(runnerFile, "chmod", ["path", 0o600]);
  assert.match(runner, /capture-evidence\.json/);
  assert.doesNotMatch(runner, /0\.0\.0\.0|http\.createServer|--serve/);
});
test("M1 revised captures select exact authority and publish append-only", () => {
  assert.match(demo, /op_read_env\("LIMINA_STAGED_MATERIAL_AUTHORITY"\) \|\| DEFAULT_AUTHORITY_PATH/);
  assertPropertyValue(runnerFile, "LIMINA_STAGED_MATERIAL_AUTHORITY", "authorityPath");
  assertCall(runnerFile, "value", ["--authority", "defaultAuthorityPath"]);
  assertCall(runnerFile, "value", ["--out-dir", "defaultReviewPath"]);
  assert.match(runner, /revised staged material capture requires an explicit fresh --out-dir/);
  assertComparison(runnerFile, "stage.revision", ">", 1);
  assertCall(runnerFile, "args.includes", ["--out-dir"]);
  const writeFlags = findPropertyAssignments(runnerFile, "flag");
  assert.ok(writeFlags.length > 0 && writeFlags.every((property) => literalValue(property.initializer) === "wx"));
  assert.match(runner, /roof-dormer-eave-continuity/);
});
