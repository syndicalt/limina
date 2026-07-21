import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { assertComparison, parseTypeScript } from "./source-semantics.test-helper.mjs";

const demo = fs.readFileSync(
  new URL("../../js/src/demos/temperate_fidelity_capture_window.ts", import.meta.url),
  "utf8",
);
const engine = fs.readFileSync(new URL("../../js/src/engine.ts", import.meta.url), "utf8");
const launcher = fs.readFileSync(new URL("./run-native-temperate-fidelity-capture.mjs", import.meta.url), "utf8");
const shared = fs.readFileSync(new URL("../../js/src/render/temperate-fidelity-scene.ts", import.meta.url), "utf8");
const threeInfo = fs.readFileSync(
  new URL("../../js/node_modules/three/src/renderers/common/Info.js", import.meta.url),
  "utf8",
);
const threeRenderObject = fs.readFileSync(
  new URL("../../js/node_modules/three/src/renderers/common/RenderObject.js", import.meta.url),
  "utf8",
);
const threeWebGpuBackend = fs.readFileSync(
  new URL("../../js/node_modules/three/src/renderers/webgpu/WebGPUBackend.js", import.meta.url),
  "utf8",
);
const threeBundle = fs.readFileSync(new URL("../../js/build/three.bundle.mjs", import.meta.url), "utf8");
const launcherFile = parseTypeScript(launcher, "run-native-temperate-fidelity-capture.mjs");

test("native capture uses the shared closure-scoped production scene and exact authority", () => {
  assert.match(demo, /loadTemperateFidelityCandidate/);
  assert.match(demo, /mountTemperateFidelityScene/);
  assert.match(shared, /candidate\.stagePopulation/);
  assert.match(shared, /runtime bundle does not carry closure entry/);
  assert.match(shared, /is below required/);
  assert.match(demo, /river-leading-line/);
});

test("native capture copies the swapchain before present at a frozen authored time", () => {
  const frozen = demo.indexOf("withFrozenRendererTime");
  const render = demo.lastIndexOf("mounted.post.render()");
  const readback = demo.indexOf("readNativeSurfaceRgba({");
  const balanced = demo.indexOf("withPresentedNativeSurfaceFrame(");
  assert.ok(frozen >= 0 && frozen < balanced && balanced < render && render < readback);
  assert.match(demo, /gpuTimestampMode: "disabled"/);
  assert.match(demo, /isSoftwareAdapter/);
});

test("native renderer eagerly configures its surface inside a validation scope", () => {
  const size = engine.indexOf("renderer.setSize(actualWidth, actualHeight, false)");
  const configure = engine.indexOf("await configureNativeRendererSurface(renderer)");
  const scene = engine.indexOf("const scene: SceneLike", configure);
  assert.ok(size >= 0 && size < configure && configure < scene);
  assert.match(engine, /pushErrorScope\("validation"\)/);
  assert.match(engine, /void backend\.context/);
  assert.match(engine, /await device\.popErrorScope\(\)/);
  assert.match(engine, /native surface configuration failed/);
  assert.match(engine, /antialias: true,[\s\S]*alpha: false,[\s\S]*trackTimestamp: false/);
});

test("native capture records strict per-frame WebGPU submission counters before readback", () => {
  const reset = demo.lastIndexOf("renderer.info.reset()");
  const beginFrame = demo.lastIndexOf("beginFrame()");
  const render = demo.lastIndexOf("mounted.post.render()");
  const snapshot = demo.indexOf("captureRenderSubmissionTelemetry(renderer.info");
  const readback = demo.indexOf("await readNativeSurfaceRgba({");
  assert.ok(reset >= 0 && reset < beginFrame && beginFrame < render && render < snapshot && snapshot < readback);
  assert.match(demo, /renderer\.info\.autoReset = false/);
  assert.match(demo, /requireWholeFrameRenderSubmissionTelemetry/);
  assert.match(demo, /renderSubmission: Object\.freeze/);
  assert.match(demo, /limina\.temperate-fidelity-native-capture\/v2/);
  assert.match(launcher, /limina\.three-render-submission\/v2/);
  assert.match(launcher, /single-production-frame-all-passes/);
  assertComparison(launcherFile, "submission.renderCalls", "<=", 1);
  assertComparison(launcherFile, "submission.drawCalls", "<=", 1);
  assertComparison(launcherFile, "submission.triangles", "<=", 1);
  assert.match(launcher, /missing valid single-frame render submission telemetry/);
});

test("manual capture advances Three frame identity before every post render", () => {
  assert.match(
    demo,
    /for \(let frame = 0; frame < schedule\.warmupFrames; frame\+\+\)[\s\S]*beginFrame\(\);[\s\S]*mounted\.post\.render\(\)/,
  );
  assert.match(threeBundle, /this\.info\.frame = this\.nodes\.nodeFrame\.frameId/);
  assert.match(threeBundle, /this\.updateBeforeType = NodeUpdateType\.FRAME/);
  assert.match(threeBundle, /this\.frameId\+\+/);
  assert.match(threeBundle, /renderer\.render\(scene, camera\)/);
});

test("native capture owns renderer teardown across adapter rejection and scene-mount failure", () => {
  const lifecycleTry = demo.indexOf("try {", demo.indexOf("let mounted:"));
  const adapterCheck = demo.indexOf("isSoftwareAdapter(engine.gpuAdapter)");
  const mount = demo.indexOf("mounted = await mountTemperateFidelityScene");
  const lifecycleFinally = demo.lastIndexOf("} finally {");
  const sceneDispose = demo.indexOf("await mounted?.dispose()", lifecycleFinally);
  const rendererDispose = demo.indexOf(".dispose();", sceneDispose);
  assert.ok(
    lifecycleTry >= 0 &&
      lifecycleTry < adapterCheck &&
      adapterCheck < mount &&
      mount < lifecycleFinally &&
      lifecycleFinally < sceneDispose &&
      sceneDispose < rendererDispose,
  );
});

test("pinned Three WebGPU counters count fixed-slot instance submissions", () => {
  assert.match(
    threeRenderObject,
    /else if \( object\.count !== undefined \)[\s\S]*instanceCount = Math\.max\( 0, object\.count \)/,
  );
  assert.match(
    threeWebGpuBackend,
    /drawIndexed\( indexCount, instanceCount,[\s\S]*info\.update\( object, indexCount, instanceCount \)/,
  );
  assert.match(
    threeWebGpuBackend,
    /draw\( vertexCount, instanceCount,[\s\S]*info\.update\( object, vertexCount, instanceCount \)/,
  );
  assert.match(threeInfo, /this\.render\.drawCalls \+\+/);
  assert.match(threeInfo, /this\.render\.triangles \+= instanceCount \* \( count \/ 3 \)/);
});

test("launcher derives resolution from authority, verifies pixels, and fails closed around Xid", () => {
  assert.match(launcher, /sceneAuthority|authority\.presentation\.minimumResolution/);
  assert.match(launcher, /--width/);
  assert.match(launcher, /--height/);
  assert.match(launcher, /LIMINA_NATIVE_CAPTURE_FULLSCREEN/);
  assert.match(launcher, /\.\.\.\(fullscreen \? \["--fullscreen"\] : \[\]\)/);
  assert.match(launcher, /runGuardedCaptureWithSourceClosure/);
  assert.doesNotMatch(launcher, /node:child_process|journalctl/);
  assert.match(launcher, /rgbaContentHash/);
  assert.match(launcher, /rgba\.toString\("hex"\)/);
  assert.match(launcher, /LIMINA_NATIVE_CAPTURE_REUSE_TRACE/);
  assert.match(launcher, /sharp\(rgba/);
});
