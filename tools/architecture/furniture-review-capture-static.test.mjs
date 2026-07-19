import assert from "node:assert/strict";
import fs from "node:fs";
import {
  findCalls,
  findPropertyAssignments,
  findVariable,
  literalValue,
  objectProperty,
  parseTypeScript,
  propertyInitializer,
  propertyPath,
  ts,
  unwrapExpression,
} from "./test-source-semantics.mjs";
const demo = fs.readFileSync(new URL("../../js/src/demos/furniture_pack_capture_window.ts", import.meta.url), "utf8"),
  scene = fs.readFileSync(new URL("../../js/src/render/furniture-pack-review-scene.ts", import.meta.url), "utf8"),
  demoFile = parseTypeScript(demo, "furniture_pack_capture_window.ts"),
  sceneFile = parseTypeScript(scene, "furniture-pack-review-scene.ts");
assert.match(demo, /gpuTimestampMode:\s*"disabled"/);
assert.ok(
  findPropertyAssignments(demoFile, "timestampQueriesEnabled").some(
    (property) => literalValue(property.initializer) === false,
  ),
);
assert.match(demo, /isSoftwareAdapter/);
assert.match(demo, /withFrozenRendererTime/);
assert.match(demo, /withPresentedNativeSurfaceFrame/);
assert.ok(
  findCalls(demoFile, "requirePairedRenderSubmissionTelemetry").some(
    (call) => propertyPath(call.arguments[0]) === "baseline" && propertyPath(call.arguments[1]) === "submission",
  ),
);
assert.match(demo, /readNativeSurfaceRgba/);
assert.match(demo, /mountFurniturePackReview/);
assert.doesNotMatch(demo, /loadGltfIntoScene|parseGltfScene/);
assert.ok(
  findCalls(demoFile, "ops.op_read_env").some(
    (call) => literalValue(call.arguments[0]) === "LIMINA_FURNITURE_REVIEW_AUTHORITY",
  ),
);
assert.doesNotMatch(demo, /hearth-settle-v2-r2/);
const reviewState = unwrapExpression(findVariable(demoFile, "reviewState")[0].initializer);
assert.equal(propertyPath(propertyInitializer(objectProperty(reviewState, "type"))), "view.type");
assert.equal(propertyPath(propertyInitializer(objectProperty(reviewState, "state"))), "view.state");
assert.equal(propertyPath(propertyInitializer(objectProperty(reviewState, "appliedState"))), "appliedState");
assert.ok(
  findCalls(demoFile, "functionalMount.setReviewState").some((call) => propertyPath(call.arguments[0]) === "view"),
);
assert.match(demo, /compound-semantic-functional-placement/);
assert.ok(
  findPropertyAssignments(demoFile, "functionalEvidence").some(
    (property) => propertyPath(property.initializer) === "authority.functionalEvidence",
  ),
);
assert.ok(
  findVariable(demoFile, "authoritativeBounds").some(
    (declaration) => propertyPath(declaration.initializer) === "mounted.authoritativeBounds",
  ),
);
assert.doesNotMatch(demo, /measuredBounds/);
assert.ok(
  findCalls(sceneFile, "registry.invoke").some(
    (call) => literalValue(call.arguments[0]) === "furniture.placeFunctional",
  ),
);
assert.match(scene, /furniture\.destroyFunctional/);
assert.match(scene, /compound-semantic/);
assert.match(scene, /socketMarkers/);
assert.match(scene, /collisionMarkers/);
assert.match(scene, /scene\.createEntity/);
assert.match(scene, /three\.setLighting/);
assert.match(scene, /setSubjectVisible/);
assert.match(scene, /setReviewState/);
const visibility = (name, field, id) =>
  findVariable(sceneFile, name).some((declaration) => {
    const value = unwrapExpression(declaration.initializer);
    return (
      ts.isBinaryExpression(value) &&
      value.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      propertyPath(value.left) === `view.${field}` &&
      literalValue(value.right) === id
    );
  });
assert.equal(visibility("socketVisible", "id", "socket-overlay"), true);
assert.equal(visibility("collisionVisible", "id", "collision-overlay"), true);
assert.equal(visibility("socketVisible", "type", "socket-overlay"), false);
assert.equal(visibility("collisionVisible", "type", "collision-overlay"), false);
console.log(
  "furniture-review-capture-static OK: functional engine mount, dynamic overlays/states, fixed native readback, paired telemetry, timestamps disabled",
);
