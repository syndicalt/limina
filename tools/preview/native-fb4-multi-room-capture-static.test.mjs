import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { FB4_CAPTURE, runFb4Capture } from "./run-native-fb4-multi-room-capture.mjs";
import { GUARDED_NATIVE_CAPTURE_CONTRACTS } from "./guarded-capture-publication.mjs";
import {
  assertCall,
  assertComparison,
  assertObject,
  assertPropertyValue,
  collect,
  parseTypeScript,
  propertyPath,
  ts,
} from "./source-semantics.test-helper.mjs";

const runner = fs.readFileSync(new URL("./run-native-fb4-multi-room-capture.mjs", import.meta.url), "utf8"),
  producer = fs.readFileSync(new URL("./capture-producer-closure.mjs", import.meta.url), "utf8"),
  demo = fs.readFileSync(new URL("../../js/src/demos/building_multi_room_review_window.ts", import.meta.url), "utf8"),
  scene = fs.readFileSync(new URL("../../js/src/render/building-multi-room-review-scene.ts", import.meta.url), "utf8");
const runnerFile = parseTypeScript(runner, "run-native-fb4-multi-room-capture.mjs"),
  demoFile = parseTypeScript(demo, "building_multi_room_review_window.ts"),
  sceneFile = parseTypeScript(scene, "building-multi-room-review-scene.ts");
const authorityPath =
    "../../assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-d0ca1e327841/review-authority.json",
  authority = JSON.parse(fs.readFileSync(new URL(authorityPath, import.meta.url), "utf8")),
  raw = (b) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
const v3Path =
    "../../assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-1b4470041e01/review-v3-r5/review-authority.json",
  v3 = JSON.parse(fs.readFileSync(new URL(v3Path, import.meta.url), "utf8"));
test("FB-4 authority pins the program-derived append-only candidate and exact eight-view HITL gate", () => {
  assert.deepEqual(
    authority.evidenceViews.map(({ id }) => id),
    FB4_CAPTURE.viewIds,
  );
  assert.equal(authority.schema, "limina.fb4-multi-room-review-authority/v2");
  assert.equal(authority.approval.humanDecision, "pending");
  assert.equal(authority.approval.visualApprovalClaimed, false);
  assert.equal(authority.presentation.timestampQueriesEnabled, false);
  assert.equal(authority.topologyProof.expectedDoors, 3);
  assert.equal(authority.topologyProof.expectedAnchors, 5);
  for (const entry of [
    authority.candidate.manifest,
    authority.candidate.glb,
    authority.visualFloor.releaseContract,
    authority.environment.authority,
    authority.environment.runtimeBundle,
  ])
    assert.equal(raw(fs.readFileSync(new URL(`../../${entry.path}`, import.meta.url))), entry.sha256);
});
test("rejected, retired, and pre-V4 authorities cannot launch another GPU capture", () => {
  assert.match(runner, /authority is retired and cannot launch GPU capture/);
  assert.match(runner, /assertMultiRoomReviewCaptureReady\(validateMultiRoomReviewAuthority/);
  assert.match(scene, /V2\/V3 review authority is historical only/);
  assert.match(demo, /assertMultiRoomReviewCaptureReady/);
  assert.match(demo, /verifySiteReviewRuntimePack/);
  assert.match(demo, /verifySiteReviewCameras/);
  assert.match(demo, /discretePopulationHardExclusionAt/);
});
test("retired authority fails before guarded/GPU setup", async () => {
  await assert.rejects(
    runFb4Capture({
      repoRoot: new URL("../../", import.meta.url).pathname,
      authorityPath: v3Path.replace(/^\.\.\/\.\.\//, ""),
      outDir: "assets/qc/internal/fb4-multi-room/prohibited-retired",
      reviewPrefix: "prohibited-retired",
    }),
    /authority is retired and cannot launch GPU capture/,
  );
});
test("historical V3 authority still binds CPU articulation and exact site evidence but V4 closure is mandatory before engine creation", () => {
  assert.equal(v3.schema, "limina.fb4-multi-room-review-authority/v3");
  assert.deepEqual(
    v3.evidenceViews.map(({ id }) => id),
    FB4_CAPTURE.viewIds,
  );
  assert.equal(v3.articulationEvidence.path.endsWith("articulation-cpu-proxy-v2.json"), true);
  assert.equal(v3.siteReviewEnvelope.cameraChecks.maximumFullSubjectHeightFraction, 0.95);
  assert.deepEqual(v3.siteReviewEnvelope.cameraChecks.fullSubjectViewIds, [
    "exterior-entry",
    "exterior-rear",
    "gable-elevation",
    "lod-25m",
  ]);
  for (const entry of [
    v3.candidate.manifest,
    v3.candidate.glb,
    v3.articulationEvidence,
    v3.siteReviewEnvelopeAuthority,
    v3.siteReviewEvidence,
  ])
    assert.equal(raw(fs.readFileSync(new URL(`../../${entry.path}`, import.meta.url))), entry.sha256);
  assert.match(runner, /verifyMultiRoomReviewV4Closure\(authority/);
  assert.ok(
    runner.indexOf("verifyMultiRoomReviewV4Closure(authority") <
      runner.lastIndexOf("runGuardedCaptureWithSourceClosure"),
  );
  assert.match(demo, /verifyMultiRoomReviewV4Closure\(authority/);
  assert.ok(demo.indexOf("verifyMultiRoomReviewV4Closure(authority") < demo.indexOf("createEngine("));
  assert.match(scene, /verifyBuildingSemanticEvidence/);
  assertComparison(sceneFile, "a.topologyProof.expectedAnchors", "!==", 6);
  assertComparison(
    runnerFile,
    "camera.rawProjectedHeightFraction",
    ">",
    "envelope.cameraChecks.maximumFullSubjectHeightFraction",
  );
});
test("FB-4 scene places only through functional engine skills and proves authority-owned layered topology", () => {
  assertCall(sceneFile, "registry.invoke", ["building.placeFunctional"]);
  assertCall(sceneFile, "registry.invoke", ["building.findRoomPath"]);
  assert.match(scene, /authority\.topologyProof\.fromRoomId/);
  assert.match(scene, /authority\.topologyProof\.connectionIds/);
  assert.match(scene, /building\.destroyFunctional/);
  assert.doesNotMatch(scene, /loadGltfIntoScene|parseGltfScene/);
});
test("FB-4 demo is production native, timestamp-disabled, whole-frame, and uses approved temperate context", () => {
  const engineCall = assertCall(demoFile, "createEngine")[0];
  assert.ok(ts.isObjectLiteralExpression(engineCall.arguments[0]));
  assertObject(demoFile, {
    width: "width",
    height: "height",
    gpuTimestampMode: "disabled",
    gpuTextureCompression: "bc-required",
    renderBaseline: false,
  });
  assert.match(demo, /mountTemperateFidelityScene/);
  assertPropertyValue(demoFile, "populationHardExclusionAt", "site.containsWorldXZ");
  assert.match(demo, /mountMultiRoomReview/);
  assert.match(demo, /requireWholeFrameRenderSubmissionTelemetry/);
  assert.match(demo, /readNativeSurfaceRgba/);
  assert.match(demo, /limina\.fb4-multi-room-native-review-set\/v1/);
  assert.doesNotMatch(demo, /timestamp-query|requiredFeatures/);
});
test("FB-4 native views apply and attest exact semantic door poses through functional engine skills", () => {
  assert.match(scene, /deriveFb4V4ReviewDoorPosePlan/);
  assertCall(sceneFile, "registry.invoke", ["door.setOpen"]);
  assert.match(scene, /setReviewViewDoorPose/);
  assert.match(demo, /mounted!\.setReviewViewDoorPose\(view\.id\)/);
  assertPropertyValue(demoFile, "openDoorIds", "doorPose.openDoorIds");
  assert.match(runner, /resolveFb4V4ReviewDoorPosePlan/);
  assert.match(runner, /native trace lost exact semantic door-pose authority/);
  assert.match(runner, /capture\.openDoorIds/);
});
test("FB-4 launcher is private, append-only, Xid guarded, timestamp-scrubbed, and does not auto-stage below-floor captures", () => {
  assert.equal(FB4_CAPTURE.binary, "target/release/limina");
  assert.equal(FB4_CAPTURE.reviewBindHost, "127.0.0.1");
  assert.equal(FB4_CAPTURE.reviewRoot, ".limina/review-artifacts");
  assert.match(runner, /runGuardedCaptureWithSourceClosure/);
  assert.doesNotMatch(runner, /node:child_process|spawn(?:Sync)?\s*\(\s*"journalctl"/);
  assert.ok(
    collect(
      runnerFile,
      (node) =>
        ts.isDeleteExpression(node) &&
        ts.isElementAccessExpression(node.expression) &&
        propertyPath(node.expression.expression) === "environment" &&
        propertyPath(node.expression.argumentExpression) === "key",
    ).length > 0,
  );
  assertCall(runnerFile, "args.includes", ["--fullscreen"]);
  assertObject(runnerFile, { recursive: true, mode: 0o700 });
  assert.match(runner, /append-only/);
  assertObject(runnerFile, {
    artifactDirectory: "FB4_CAPTURE.reviewRoot",
    bindHost: "FB4_CAPTURE.reviewBindHost",
    public: false,
    staged: false,
  });
  assert.doesNotMatch(runner, /reviewArtifactPath|writeFile\(reviewPath|requiredFeatures.*timestamp-query/);
});
test("FB-4 launcher binds complete producer provenance without retaining traces or serializing credentials", () => {
  assert.deepEqual(FB4_CAPTURE.sourcePaths, [
    "js/src/render/building-multi-room-review-scene.ts",
    "js/src/demos/building_multi_room_review_window.ts",
    "js/src/render/review-pixel-sanity.mjs",
    "tools/preview/run-native-fb4-multi-room-capture.mjs",
  ]);
  assert.deepEqual(
    GUARDED_NATIVE_CAPTURE_CONTRACTS.find(({ runner }) => runner.endsWith("run-native-fb4-multi-room-capture.mjs")),
    {
      runner: "tools/preview/run-native-fb4-multi-room-capture.mjs",
      module: "js/src/demos/building_multi_room_review_window.ts",
    },
  );
  assertCall(runnerFile, "runGuardedCaptureWithSourceClosure");
  assertCall(runnerFile, "archiveGuardedCaptureSources");
  assertCall(runnerFile, "verifyGuardedCaptureEvidence");
  assert.match(runner, /captureSession\.guardEvidence\.bootId/);
  assertCall(runnerFile, "readFile", ["tracePath"]);
  assertCall(runnerFile, "unlink", ["tracePath"]);
  assert.match(runner, /capture-provenance\.json/);
  assert.match(producer, /timestampEnvironmentKeys/);
  assert.match(producer, /collectCaptureModuleClosure/);
  assertObject(runnerFile, { flag: "wx", mode: 0o600 });
  assert.doesNotMatch(runner, /JSON\.stringify\(environment|environment:\{\.\.\.process\.env\}/);
});
