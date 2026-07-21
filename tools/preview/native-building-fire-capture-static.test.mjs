import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertCall,
  assertComparison,
  assertDelete,
  assertImportedNames,
  assertObject,
  assertPropertyValue,
  collect,
  parseTypeScript,
  propertyPath,
  ts,
} from "./source-semantics.test-helper.mjs";

const [authority, scene, binding, demo, runner] = await Promise.all([
  readFile(new URL("../../js/src/render/building-fire-review-authority.ts", import.meta.url), "utf8"),
  readFile(new URL("../../js/src/render/building-fire-review-scene.ts", import.meta.url), "utf8"),
  readFile(new URL("../../js/src/render/building-fire-render-binding.ts", import.meta.url), "utf8"),
  readFile(new URL("../../js/src/demos/building_fire_capture_window.ts", import.meta.url), "utf8"),
  readFile(new URL("./run-native-building-fire-capture.mjs", import.meta.url), "utf8"),
]);
const sceneFile = parseTypeScript(scene, "building-fire-review-scene.ts"),
  demoFile = parseTypeScript(demo, "building_fire_capture_window.ts"),
  runnerFile = parseTypeScript(runner, "run-native-building-fire-capture.mjs");

const frameIds = [
  "hearth-motion--off-initial",
  "hearth-motion--ignition",
  "hearth-motion--burn-a",
  "hearth-motion--burn-b",
  "hearth-motion--burn-c",
  "hearth-motion--burn-d",
  "hearth-motion--extinguish",
  "hearth-motion--off-final",
  "fuel-detail--burn-a",
  "reflected-light--off-initial",
  "reflected-light--burn-a",
];

test("V1 capture uses the exact authority and mount interfaces without compatibility shims", () => {
  assertImportedNames(demoFile, "../render/building-fire-review-authority.ts", [
    "validateBuildingFireReviewAuthority",
    "verifyBuildingFireReviewClosure",
  ]);
  assertCall(demoFile, "mountBuildingFireReview");
  assertCall(demoFile, "mounted.start", []);
  assertCall(demoFile, "mounted.extinguish", []);
  assertCall(demoFile, "mounted.advanceTicks");
  assertCall(demoFile, "mounted.snapshot", []);
  assertCall(demoFile, "mounted.restore", ["snapshot"]);
  assert.match(demo, /mounted\.setDynamicFireVisible/);
  assert.ok(
    collect(
      sceneFile,
      (node) =>
        ts.isFunctionDeclaration(node) &&
        node.name?.text === "mountBuildingFireReview" &&
        node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
        node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
        node.parameters.map((parameter) => parameter.name.getText(sceneFile)).join(",") === "world,authorityValue",
    ).length > 0,
  );
  assert.doesNotMatch(demo, /compat|fallback|legacy/i);
});

test("V1 captures the canonical 11 evidence frames from authority cameras and runtime ticks", () => {
  for (const id of frameIds) assert.match(authority, new RegExp(id));
  assert.match(authority, /evidenceFrames: readonly BuildingFireReviewFrame\[\]/);
  assertCall(demoFile, "authority.evidenceFrames.entries", []);
  assertComparison(demoFile, "snapshot.state.tick", "!==", "frame.tick");
  assertComparison(demoFile, "snapshot.state.phase", "!==", "frame.phase");
  assert.ok(
    assertCall(demoFile, "camera.position.set").some(
      (call) =>
        ts.isSpreadElement(call.arguments[0]) && propertyPath(call.arguments[0].expression) === "frame.camera.position",
    ),
  );
  assert.match(runner, /BUILDING_FIRE_REVIEW_FRAME_IDS/);
});

test("V1 capture is append-only private and absolute-stop Xid guarded", () => {
  assert.match(runner, /assets\/qc\/internal\/fire/);
  assert.match(runner, /append-only V1 output already exists/);
  assert.match(runner, /exact 1920x1080 evidence requires LIMINA_NATIVE_CAPTURE_FULLSCREEN=1/);
  assert.match(runner, /runGuardedCaptureWithSourceClosure/);
  assert.doesNotMatch(runner, /node:child_process|journalctl/);
  assertPropertyValue(runnerFile, "mode", 0o700);
  assertObject(runnerFile, { mode: 0o600, flag: "wx" });
});

test("V1 capture deletes every timestamp-risk input and disables GPU timestamps in-engine", () => {
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
  assertPropertyValue(demoFile, "gpuTimestampMode", "disabled");
  assertPropertyValue(demoFile, "timestampQueriesEnabled", false);
  assert.doesNotMatch(demo, /GPU_TIMESTAMP_RISK_ACK/);
});

test("V1 evidence includes whole-frame, paired, resource, lifecycle, pixels, and CPU encode timing", () => {
  assert.match(demo, /requireWholeFrameRenderSubmissionTelemetry/);
  assert.match(demo, /requireSubjectPairedRenderSubmissionTelemetry/);
  assert.match(demo, /captureRenderResourceTelemetry/);
  assert.match(demo, /pairedBaselineRgbaBase64/);
  assertObject(demoFile, {
    baselineResources: "baselineResources",
    mountedResources: "mountedResources",
    afterDisposeResources: "afterDisposeResources",
  });
  assert.match(runner, /lacks whole-scene telemetry/);
  assert.match(runner, /lacks paired fire telemetry/);
  assert.match(runner, /lacks renderer resource telemetry/);
  assert.match(runner, /cpuPngEncodeMs/);
  assertComparison(runnerFile, "artifact.lifecycle.afterDisposeEntities", "!==", "artifact.lifecycle.baselineEntities");
});

test("V1 TSL deformation never coerces an attribute node through JavaScript arithmetic", () => {
  assert.match(binding, /phase\.mul\(7\.3\)/);
  assert.doesNotMatch(binding, /phase\s*\*\s*7\.3/);
  assert.match(binding, /setAttribute\("fireShape"/);
  assert.match(binding, /setAttribute\("fireDeformation"/);
  assert.doesNotMatch(binding, /setAttribute\("fireHeight01"/);
  assert.doesNotMatch(binding, /setAttribute\("fireFrequencyHz"/);
});

test("V1 CPU evidence enforces channel exposure, flame variation, and reflected light", () => {
  assert.match(runner, /limina\.cpu-channel-exposure\/v1/);
  assert.match(runner, /maxChannelP99/);
  assert.match(runner, /maxClippedPixelFraction/);
  assert.match(runner, /limina\.deterministic-flame-silhouette-variation\/v1/);
  assert.match(runner, /jaccardDistance/);
  assert.match(runner, /maskSha256/);
  assert.match(runner, /limina\.cpu-volumetric-fire-proof\/v1/);
  assert.match(runner, /maximumOcclusionLeakFraction/);
  assert.match(runner, /multiViewFrameIds/);
  assert.match(runner, /limina\.cpu-reflected-light-off-on\/v1/);
  assert.match(runner, /positivelyLitPixels/);
  assert.match(runner, /hotPixelExclusion/);
});

test("static harness never invokes the native GPU capture", () => {
  assert.doesNotMatch(import.meta.url, /run-native-building-fire-capture\.mjs$/);
  assert.match(runner, /runGuardedCaptureWithSourceClosure/);
});
