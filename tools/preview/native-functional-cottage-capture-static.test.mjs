import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { verifyManifest as verifyHistoricalSourceManifest } from "../test-hygiene/source-evidence-archive.mjs";
import {
  assertComparison,
  collect,
  expressionValue,
  parseTypeScript,
  propertyPath,
  ts,
  unwrapExpression,
} from "./source-semantics.test-helper.mjs";

const demo = fs.readFileSync(
  new URL("../../js/src/demos/functional_cottage_capture_window.ts", import.meta.url),
  "utf8",
);
const scene = fs.readFileSync(
  new URL("../../js/src/render/functional-cottage-review-scene.ts", import.meta.url),
  "utf8",
);
const authority = JSON.parse(
  fs.readFileSync(new URL("../../art-direction/functional-cottage-review-scene.json", import.meta.url), "utf8"),
);
const temperate = JSON.parse(
  fs.readFileSync(new URL("../../art-direction/temperate-fidelity-scene.json", import.meta.url), "utf8"),
);
const launcher = fs.readFileSync(new URL("./run-native-functional-cottage-capture.mjs", import.meta.url), "utf8");
const launcherFile = parseTypeScript(launcher, "run-native-functional-cottage-capture.mjs");

test("review asset identity is pinned to the exact production GLB", () => {
  assert.equal(authority.asset.assetId, "buildings/functional-hall-house-v4-production.glb");
  const bytes = fs.readFileSync(new URL(`../../assets/${authority.asset.assetId}`, import.meta.url));
  assert.equal(authority.asset.sha256, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  assert.equal(authority.asset.assetHash, "sha256:cbc367e24b62df6d8a72266939c56ca62cd9bfe8e4d6885ec50caaade65df6d8");
  const environment = fs.readFileSync(new URL(`../../${authority.environmentAuthority.path}`, import.meta.url));
  const iteration = fs.readFileSync(new URL(`../../${authority.iterationAuthority.path}`, import.meta.url));
  assert.equal(
    authority.environmentAuthority.sha256,
    `sha256:${createHash("sha256").update(environment).digest("hex")}`,
  );
  assert.equal(authority.iterationAuthority.sha256, `sha256:${createHash("sha256").update(iteration).digest("hex")}`);
});

test("review retains its historical generator identity through the immutable source ledger", async () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../test-hygiene/source-evidence-archive.json", import.meta.url), "utf8"),
  );
  await verifyHistoricalSourceManifest(manifest);
  const generatorReference = manifest.sourceReferences.find(
    (entry) =>
      entry.evidencePath === "art-direction/functional-cottage-review-scene.json" &&
      entry.jsonLocation === "generator.path" &&
      entry.sourcePath === authority.generator.path,
  );
  assert.ok(generatorReference, "historical generator reference is missing from the source-evidence ledger");
  assert.equal(generatorReference.expectedSha256, authority.generator.sha256);
  assert.equal(generatorReference.reproducibility.status, "hash-attested-only");
  assert.equal(manifest.policy.hashAttestedOnlyMayAuthorizeTransition, false);
});

test("review is a landward three-quarter hero view while the facade faces the approved sun", () => {
  const [siteX, , siteZ] = authority.placement.position;
  const [cameraX, , cameraZ] = authority.camera.position;
  const yaw = authority.placement.yaw;
  const front = [-Math.sin(yaw), -Math.cos(yaw)];
  const cameraOffset = [cameraX - siteX, cameraZ - siteZ];
  const cameraRadius = Math.hypot(...cameraOffset);
  const cameraDirection = cameraOffset.map((value) => value / cameraRadius);
  const [sunX, , sunZ] = temperate.presentation.lighting.sun.position;
  const sunRadius = Math.hypot(sunX, sunZ);
  const sunDirection = [sunX / sunRadius, sunZ / sunRadius];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  assert.ok(Math.abs(cameraRadius - 18) < 1e-9, "camera is not at the authored hero radius");
  const threeQuarterDot = dot(front, cameraDirection);
  assert.ok(
    threeQuarterDot > Math.cos((36 * Math.PI) / 180) && threeQuarterDot < Math.cos((34 * Math.PI) / 180),
    "camera is not 35 degrees off the facade normal",
  );
  assert.ok(
    cameraDirection[1] > 0.95 && cameraDirection[0] > -0.3,
    "camera left the landward orbit and can reintroduce the river foreground obstruction",
  );
  assert.ok(dot(front, sunDirection) > 0.999999, "front elevation no longer faces the approved temperate sun");
  const verticalAngle = Math.atan2(authority.camera.position[1] - authority.camera.target[1], cameraRadius);
  assert.ok(verticalAngle > 0.08 && verticalAngle < 0.1, "camera elevation no longer favors the facade over the roof");
  assert.equal(authority.camera.fovDeg, 50, "hero framing FOV drifted");
});

test("review mounts the cottage only through functional engine skills", () => {
  assert.match(scene, /registry\.invoke\("building\.placeFunctional"/);
  assert.match(scene, /registry\.invoke\("door\.setOpen"/);
  assert.doesNotMatch(scene, /loadGltfIntoScene|parseGltfScene/);
  assert.match(scene, /new AssetRegistry\(world\.ops\)/);
  assert.match(scene, /op_read_asset\(`assets\/\$\{authority\.asset\.assetId\}`\)/);
  assert.match(scene, /assets\.seed\(authority\.asset\.assetId, assetBytes\)/);
  assert.match(scene, /building\.destroyFunctional/);
  assert.match(scene, /setDoorOpen: async/);
  assert.match(scene, /setRenderVisible: \(visible: boolean\)/);
  assert.match(scene, /node\.userData\?\.liminaLod\?\.level/);
  assert.doesNotMatch(scene, /hall-house\\\/v4\\\/LOD/);
  assert.match(scene, /terrainHeight/);
});

test("review uses production camera, lighting baseline, post and guarded-compatible readback", () => {
  assert.match(
    demo,
    /createEngine\(\{ width: minimumWidth, height: minimumHeight, gpuTimestampMode: "disabled", gpuTextureCompression: "bc-required", renderBaseline: false \}\)/,
  );
  assert.match(
    demo,
    /timingPolicy: Object\.freeze\(\{ gpuTimestampMode: "disabled", timestampQueriesEnabled: false \}\)/,
  );
  assert.match(demo, /loadTemperateFidelityCandidate/);
  assert.match(demo, /selectedFunctionalBuildingCycle/);
  assert.match(demo, /verifyFunctionalBuildingReferenceSources/);
  assert.match(demo, /selected functional cottage iteration does not match capture asset closure/);
  assert.match(demo, /mountTemperateFidelityScene/);
  assert.match(demo, /prewarmGltfScene\(authority\.asset\.assetId[\s\S]*gltfCache\)/);
  assert.match(demo, /GltfSceneCache\(\{ ktx2TranscoderPath: "\/runtime\/basis\/", ktx2TranscoderBytes:/);
  assert.match(demo, /gltfCache\.configureKtx2\(renderer\)/);
  assert.match(demo, /mountTemperateFidelityScene\(\{[\s\S]*gltfCache/);
  assert.match(demo, /loaded\.candidate\.snapshot\.terrain\.sampleHeight/);
  assert.match(demo, /populationHardExclusionAt:siteEvidence\.containsWorldXZ/);
  assert.match(demo, /op_physics_create_world\(0\)/);
  assert.match(demo, /renderSyncSystem\(environment\.world\.ecs\)/);
  assert.match(demo, /withFrozenRendererTime/);
  assert.match(demo, /withPresentedNativeSurfaceFrame/);
  assert.match(demo, /readNativeSurfaceRgba/);
  assert.match(demo, /isSoftwareAdapter/);
  assert.match(demo, /requireWholeFrameRenderSubmissionTelemetry/);
  assert.match(demo, /mounted!\.setRenderVisible\(false\)/);
  assert.match(demo, /finally \{[\s\S]*mounted!\.setRenderVisible\(true\)/);
  assert.match(demo, /requirePairedRenderSubmissionTelemetry\(baselineSubmission, submission, 16\)/);
  assert.match(demo, /pairedRenderSubmission: captured\.pairedSubmission/);
  assert.match(demo, /await mounted\.dispose\(\); mounted = undefined;/);
  assert.match(demo, /functional cottage repeated lifecycle leaked entities/);
  assert.match(demo, /lifecycleEvidence: Object\.freeze\(\{ cycles: 2/);
  assert.match(demo, /captureRenderResourceTelemetry/);
  assert.match(demo, /rendererResources: captured\.resources/);
  assert.match(demo, /limina\.functional-cottage-native-review-set\/v2/);
  assert.match(demo, /for \(let viewIndex = 0; viewIndex < authority\.evidenceViews\.length; viewIndex\+\+\)/);
  assert.match(demo, /await mounted!\.setDoorOpen\(view\.state === "open"\)/);
  assert.match(demo, /renderSyncSystem\(environment!\.world\.ecs\)/);
  assert.match(
    demo,
    /finally \{[\s\S]*attempt\(async \(\) => \{ await mounted\?\.dispose\(\); \}\)[\s\S]*attempt\(async \(\) => \{ await environment\?\.dispose\(\); \}\)[\s\S]*disposeRenderBaseline\(\)[\s\S]*renderer\.dispose\(\)/,
  );
  assert.doesNotMatch(demo, /timestamp-query|requiredFeatures/);
  assert.match(launcher, /runGuardedCaptureWithSourceClosure/);
  assert.doesNotMatch(launcher, /node:child_process|journalctl/);
  assert.match(launcher, /publicationEvidence/);
  assert.match(launcher, /outputs: outputs\.map/);
  assert.match(launcher, /pngSha256: `sha256:/);
  assert.match(launcher, /functional-cottage-hall-house-v4-native/);
  assert.match(launcher, /delete captureEnv\.LIMINA_GPU_TIMESTAMP_RISK_ACK/);
  assert.match(launcher, /artifact\.timingPolicy\?\.gpuTimestampMode !== "disabled"/);
  assert.match(launcher, /artifact\.timingPolicy\?\.timestampQueriesEnabled !== false/);
  assert.match(launcher, /limina\.three-render-resources\/v1/);
  assert.match(launcher, /lacks strict renderer resource telemetry/);
  assert.match(launcher, /limina\.paired-render-submission\/v1/);
  assert.match(launcher, /lacks strict paired incremental submission evidence/);
  assert.match(launcher, /lacks repeated lifecycle entity-return evidence/);
  assert.match(launcher, /limina\.cpu-pixel-exposure\/v1/);
  assertComparison(launcherFile, "clippedFraction", ">", "clippingLimit");
  assertComparison(launcherFile, "p99Luma", ">", 250);
  assert.match(launcher, /capture\.id === "interior-open" \|\| capture\.id === "hearth-detail"/);
  const thresholdLimits = collect(launcherFile, (node) => {
    if (!ts.isConditionalExpression(node)) return false;
    const condition = unwrapExpression(node.condition);
    return (
      ts.isBinaryExpression(condition) &&
      condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      propertyPath(condition.left) === "capture.id" &&
      expressionValue(condition.right) === "threshold-detail" &&
      expressionValue(node.whenTrue) === 0.03 &&
      expressionValue(node.whenFalse) === 0.04
    );
  });
  assert.equal(thresholdLimits.length, 1, "threshold detail must retain its dedicated clipping limit");
  assert.match(
    launcher,
    /exterior-closed:closed:articulation-before,exterior-open:open:primary,threshold-detail:open:threshold-detail,interior-open:open:interior-traversal,hearth-detail:open:hearth-detail,lod-25m:closed:lod-proof/,
  );
  assert.doesNotMatch(launcher, /dgx-spark-review-bridge\.mjs|["']stage["']\s*,\s*captureOutput/);
  assert.match(launcher, /selectedFunctionalBuildingCycle/);
  assert.match(launcher, /verifyFunctionalBuildingReferenceSources/);
  assert.match(launcher, /LIMINA_NATIVE_CAPTURE_FULLSCREEN/);
  assert.match(launcher, /\.\.\.\(fullscreen \? \["--fullscreen"\] : \[\]\)/);
});

test("review authority carries paired articulation and interior traversal evidence", () => {
  assert.deepEqual(
    authority.evidenceViews.map(({ id, state, role }) => ({ id, state, role })),
    [
      { id: "exterior-closed", state: "closed", role: "articulation-before" },
      { id: "exterior-open", state: "open", role: "primary" },
      { id: "threshold-detail", state: "open", role: "threshold-detail" },
      { id: "interior-open", state: "open", role: "interior-traversal" },
      { id: "hearth-detail", state: "open", role: "hearth-detail" },
      { id: "lod-25m", state: "closed", role: "lod-proof" },
    ],
  );
  assert.equal(authority.evidenceViews[0].camera, "hero");
  assert.equal(authority.evidenceViews[1].camera, "hero");
  assert.notEqual(authority.evidenceViews[2].camera, "hero");
  assert.deepEqual(
    authority.evidenceViews.map(({ lodLevel }) => lodLevel),
    [0, 0, 0, 0, 0, 1],
  );
});
