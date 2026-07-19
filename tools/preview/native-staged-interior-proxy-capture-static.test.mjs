import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertArrayLiteral, parseTypeScript } from "./source-semantics.test-helper.mjs";

const runner = readFileSync(new URL("./run-native-staged-interior-proxy-capture.mjs", import.meta.url), "utf8");
const demo = readFileSync(
  new URL("../../js/src/demos/staged_interior_proxy_capture_window.ts", import.meta.url),
  "utf8",
);
const runnerFile = parseTypeScript(runner, "run-native-staged-interior-proxy-capture.mjs");

test("I1 capture closes exact authority before renderer and mounts approved M1 shell through engine review", () => {
  assert.match(demo, /verifyStagedInteriorProxyReviewClosure\(authority[\s\S]*createEngine/);
  assert.match(demo, /mountStagedInteriorProxyReview/);
  assert.match(runner, /verifyStagedInteriorProxyReviewClosure\(authority/);
  assert.match(runner, /stage\.kind !== "interior-plan"/);
  assert.match(runner, /stage\.status !== "draft"/);
  assertArrayLiteral(runnerFile, ["approvedShell", "approvedMaterials", "derived", "plan", "stageArtifact"]);
  assert.doesNotMatch(demo, /mountTemperateFidelityScene|loadTemperateFidelityCandidate|furniture-pack/);
});

test("I1 capture uses exactly two labeled neutral-studio proxy views with paired native readback", () => {
  assert.match(runner, /layout-top-down,entry-walkthrough/);
  assert.match(runner, /authority\.evidenceViews\.length !== 2/);
  assert.match(demo, /scene\.background = new THREE\.Color/);
  assert.match(demo, /I1 neutral studio floor/);
  assert.match(demo, /studio: \{ neutral: true, world: "none"/);
  assert.match(demo, /mounted!\.setEvidenceView/);
  assert.match(demo, /mounted!\.updateLabels/);
  assert.match(demo, /mounted!\.setCurrentSubjectVisible\(false\)/);
  assert.match(demo, /requireWholeFrameRenderSubmissionTelemetry/);
  assert.match(demo, /requirePairedRenderSubmissionTelemetry/);
  assert.match(demo, /captureRenderResourceTelemetry/);
  assert.match(demo, /readNativeSurfaceRgba/);
  assert.match(demo, /withFrozenRendererTime/);
  assert.match(demo, /lifecycle leaked entities/);
});

test("I1 capture rejects software and disables timestamp queries without acknowledgement", () => {
  assert.match(demo, /gpuTimestampMode: "disabled"/);
  assert.match(demo, /isSoftwareAdapter\(engine\.gpuAdapter\)/);
  assert.match(demo, /timestampQueriesEnabled: false/);
  assert.match(runner, /delete captureEnv\.LIMINA_GPU_TIMESTAMP_RISK_ACK/);
  assert.match(runner, /delete captureEnv\.LIMINA_GPU_TIMESTAMP_MODE/);
  assert.match(runner, /delete captureEnv\.LIMINA_GPU_TIMESTAMP_QUERIES/);
  assert.match(
    runner,
    /for \(const key of Object\.keys\(captureEnv\)\) if \(\/TIMESTAMP\/i\.test\(key\)\) delete captureEnv\[key\]/,
  );
  assert.match(runner, /gpuTimestampMode !== "disabled"/);
  assert.match(runner, /timestampQueriesEnabled !== false/);
});

test("I1 launcher is append-only, private, bounded, and absolute-stop guarded against Xid", () => {
  assert.match(runner, /value\("--authority", defaultAuthorityPath\)/);
  assert.match(runner, /value\("--out-dir", undefined\)/);
  assert.match(runner, /i1-r\$\{authority\.plan\.revision\}/);
  assert.match(runner, /stage\.revision !== authority\.plan\.revision/);
  assert.doesNotMatch(runner, /stage\.revision !== 1/);
  assert.match(runner, /append-only I1 output already exists/);
  assert.match(runner, /flag: "wx"/);
  assert.match(runner, /chmod\(reviewRoot, 0o700\)/);
  assert.match(runner, /chmod\(path, 0o600\)/);
  assert.match(runner, /runGuardedCaptureWithSourceClosure/);
  assert.doesNotMatch(runner, /node:child_process|journalctl/);
  assert.match(runner, /await fs\.unlink\(tracePath\)/);
  assert.doesNotMatch(runner, /0\.0\.0\.0|http\.createServer|--serve|dgx-spark-review-bridge/);
});

test("I1 runner validates whole-frame, paired, resource, pixel, exposure, and lifecycle evidence", () => {
  assert.match(runner, /single-production-frame-all-passes/);
  assert.match(runner, /paired-render-submission\/v1/);
  assert.match(runner, /same-process-fixed-camera-time-residency-post-visibility-toggle/);
  assert.match(runner, /renderer-live-after-production-frame/);
  assert.match(runner, /cpu-pixel-exposure\/v1/);
  assert.match(runner, /afterDisposeEntities !== artifact\.lifecycle\.baselineEntities/);
  assert.match(runner, /capture-evidence\.json/);
  assert.match(runner, /rgbaBase64/);
  assert.match(runner, /portableAssetContentHash\(rgba\)/);
});
