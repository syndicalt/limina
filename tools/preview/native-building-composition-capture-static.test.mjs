import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertComparison,
  assertObject,
  assertPropertyValue,
  collect,
  expressionValue,
  hasStringLiteral,
  objectProperty,
  parseTypeScript,
  propertyInitializer,
  ts,
  unwrapExpression,
} from "./source-semantics.test-helper.mjs";

const [scene, demo, runner, builder] = await Promise.all([
  readFile(new URL("../../js/src/render/building-composition-review-scene.ts", import.meta.url), "utf8"),
  readFile(new URL("../../js/src/demos/building_composition_capture_window.ts", import.meta.url), "utf8"),
  readFile(new URL("./run-native-building-composition-capture.mjs", import.meta.url), "utf8"),
  readFile(new URL("../architecture/build-composition-review-authority.mjs", import.meta.url), "utf8"),
]);
const sceneFile = parseTypeScript(scene, "building-composition-review-scene.ts"),
  demoFile = parseTypeScript(demo, "building_composition_capture_window.ts"),
  runnerFile = parseTypeScript(runner, "run-native-building-composition-capture.mjs"),
  builderFile = parseTypeScript(builder, "build-composition-review-authority.mjs");

test("C1 mounts exact M1 runtime and seven functional furniture instances through engine skills", () => {
  assert.match(scene, /materialPalette\.runtimeGlb/);
  assert.match(scene, /"asset\.place"/);
  assert.match(scene, /"furniture\.placeFunctional"/);
  assert.match(scene, /"furniture\.destroyFunctional"/);
  assert.match(scene, /verifyBuildingCompositionReviewClosure/);
  assert.doesNotMatch(scene, /functional_cottage|legacy monolith/i);
  assertComparison(runnerFile, "artifact.mounted.inventory.instances", "!==", 7);
  assert.match(
    runner,
    /instance\/dining-table,instance\/dining-chair-north,instance\/dining-chair-south,instance\/dining-chair-west,instance\/dining-chair-east,instance\/hearth-settle,instance\/service-storage/,
  );
});

test("C1 requires five targeted native-engine human review views", () => {
  const views = "entry-circulation,dining-three-quarter,hearth-seating,service-storage,overall-room";
  assert.match(scene, new RegExp(views));
  assert.match(runner, new RegExp(views));
  for (const id of views.split(",")) assert.equal(hasStringLiteral(builderFile, id), true, `missing view ${id}`);
  const minimumResolution = collect(
    builderFile,
    (node) => ts.isPropertyAssignment(node) && node.name.getText(builderFile) === "minimumResolution",
  ).map((property) => unwrapExpression(property.initializer));
  assert.ok(
    minimumResolution.some(
      (value) => ts.isArrayLiteralExpression(value) && value.elements.map(expressionValue).join(",") === "1920,1080",
    ),
  );
  assertPropertyValue(builderFile, "blenderApprovalProhibited", true);
  assertPropertyValue(builderFile, "fireExcluded", true);
});

test("C1 r3 authority exposes the exact unobstructed evidence-camera revision", () => {
  const expected = [
    ["entry-circulation", [-0.15, 1.6, -1.55], [-0.72, 0.72, -3.58], 64],
    ["dining-three-quarter", [-1.05, 1.58, -2.5], [-3, 0.68, -0.8], 58],
    ["hearth-seating", [-1.65, 1.65, 0.35], [2.75, 0.82, 0.9], 64],
    ["service-storage", [1.45, 1.52, -4.12], [3.65, 0.9, -4.12], 60],
    ["overall-room", [-0.45, 2.3, -2.9], [0, 0.82, 0.25], 80],
  ];
  for (const [id, position, target, fovDeg] of expected) {
    const view = assertObject(builderFile, { id, fovDeg, near: 0.03, far: 100 })[0],
      array = (name) => {
        const value = unwrapExpression(propertyInitializer(objectProperty(view, name)));
        assert.ok(ts.isArrayLiteralExpression(value));
        return value.elements.map(expressionValue);
      };
    assert.deepEqual(array("position"), position);
    assert.deepEqual(array("target"), target);
  }
});

test("C1 capture is append-only private and absolute-stop Xid guarded with timestamps disabled", () => {
  assert.match(runner, /assets\/qc\/internal\/compositions/);
  assert.match(runner, /append-only C1 output already exists/);
  assert.match(runner, /runGuardedCaptureWithSourceClosure/);
  assert.doesNotMatch(runner, /node:child_process|journalctl/);
  assert.match(runner, /delete captureEnv\.LIMINA_GPU_TIMESTAMP_RISK_ACK/);
  assert.match(runner, /delete captureEnv\.LIMINA_GPU_TIMESTAMP_MODE/);
  assert.match(runner, /delete captureEnv\.LIMINA_GPU_TIMESTAMP_QUERIES/);
  assertPropertyValue(demoFile, "gpuTimestampMode", "disabled");
  assert.doesNotMatch(demo, /GPU_TIMESTAMP_RISK_ACK/);
});

test("C1 evidence validates whole-scene telemetry, furniture delta, resources, pixels, exposure, and lifecycle", () => {
  assert.match(demo, /requireWholeFrameRenderSubmissionTelemetry/);
  assert.match(demo, /requirePairedRenderSubmissionTelemetry/);
  assert.match(demo, /captureRenderResourceTelemetry/);
  assert.match(demo, /setFurnitureVisible\(false\)/);
  assert.match(demo, /readNativeSurfaceRgba/);
  assert.match(runner, /lacks whole-scene telemetry/);
  assert.match(runner, /lacks strict furniture-delta telemetry/);
  assert.match(runner, /lacks renderer resource telemetry/);
  assert.match(runner, /exposure is not reviewable/);
  assertComparison(runnerFile, "artifact.lifecycle.afterDisposeEntities", "!==", "artifact.lifecycle.baselineEntities");
});

test("C1 review binds the exact CPU-authored integrated Blender source without treating it as approval", () => {
  assert.match(scene, /integratedSource/);
  assert.match(scene, /limina\.building-composition-build-evidence\/v1/);
  assert.match(scene, /cpu-authored-unreviewed/);
  assertComparison(sceneFile, "build.rendered", "!==", false);
  assertComparison(sceneFile, "build.gpuUsed", "!==", false);
  assert.match(builder, /buildEvidencePath/);
  assert.match(builder, /--build-evidence/);
  assertObject(demoFile, { integratedSource: "authority.integratedSource" });
  assert.match(runner, /artifact\.integratedSource/);
});
