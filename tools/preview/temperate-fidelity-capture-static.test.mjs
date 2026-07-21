import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./temperate-fidelity-capture.ts", import.meta.url), "utf8");
const runnerSource = fs.readFileSync(new URL("./run-temperate-fidelity-capture.mjs", import.meta.url), "utf8");
const sharedSource = fs.readFileSync(new URL("../../js/src/render/temperate-fidelity-scene.ts", import.meta.url), "utf8");
const clockSource = fs.readFileSync(new URL("../../js/src/render/frozen-render-time.ts", import.meta.url), "utf8");

test("temperate fidelity capture uses the closure-scoped production population mount", () => {
  assert.match(source, /mountTemperateFidelityScene\(\{/);
  assert.match(sharedSource, /candidate\.stagePopulation\(/);
  assert.match(sharedSource, /mountDerivedBiomePopulation\(\{/);
  assert.match(sharedSource, /terrainWindow/);
  assert.match(sharedSource, /biomeField/);
  assert.match(sharedSource, /runtimePack/);
  assert.match(sharedSource, /portableAssetContentHash\(bytes\) !== entry\.contentHash/);
  assert.match(sharedSource, /runtime bundle does not carry closure entry/);
});

test("temperate fidelity capture has no aggregate-plan or live asset-root population side channel", () => {
  assert.doesNotMatch(sharedSource, /populationPlanAssetId/);
  assert.doesNotMatch(sharedSource, /plan\.placements\.filter/);
  assert.doesNotMatch(sharedSource, /descriptorPins/);
  assert.doesNotMatch(sharedSource, /AssetRegistry/);
  assert.doesNotMatch(sharedSource, /BiomePopulationMount\.create/);
  assert.doesNotMatch(sharedSource, /getBytes\(assetId\)/);
  assert.doesNotMatch(sharedSource, /fetch\(`\/assets\/\$\{entry\.assetId\}/);
});

test("capture fetches only the authenticated acceptance-camera residency window", () => {
  assert.match(sharedSource, /const residentChunkDescriptors = bundle\.manifest\.chunks\.filter/);
  assert.match(sharedSource, /Promise\.all\(residentChunkDescriptors\.map/);
  assert.doesNotMatch(sharedSource, /Promise\.all\(bundle\.manifest\.chunks\.map/);
  assert.match(sharedSource, /manifest: bundle\.manifest/);
});

test("capture backend is explicit and hardware evidence rejects software adapters", () => {
  assert.match(runnerSource, /LIMINA_CAPTURE_BACKEND/);
  assert.match(runnerSource, /captureBackend === "hardware"/);
  assert.match(runnerSource, /--use-angle=gl/);
  assert.match(runnerSource, /WEBGL_debug_renderer_info/);
  assert.match(runnerSource, /hardware capture resolved a software renderer/);
  assert.match(runnerSource, /sceneAuthority\.presentation\.minimumResolution/);
});

test("capture reports bounded stage timings instead of one opaque startup duration", () => {
  const timingSources = `${source}\n${sharedSource}`;
  for (const stage of ["authorityAndBundle", "resourceFetchAndDecode", "terrainCandidate", "rendererInit",
    "populationMount", "lightingAndEnvironment", "warmupAndRender", "total"]) {
    assert.match(timingSources, new RegExp(stage));
  }
  assert.match(source, /performance\.now\(\)/);
  assert.match(source, /timingsMs: Object\.freeze/);
});

test("capture enforces the authored release resolution and freezes TSL animation time", () => {
  assert.match(sharedSource, /is below required/);
  assert.match(sharedSource, /captureTimeSeconds/);
  assert.match(sharedSource, /warmupFrames/);
  assert.match(source, /withFrozenRendererTime\(renderer, schedule\.fixedTimeSeconds/);
  assert.match(source, /async \(beginFrame\)/);
  assert.match(source, /beginFrame\(\);[\s\S]*mounted\.post\.render\(\)/);
  assert.match(clockSource, /this\.frameId\+\+/);
  assert.match(clockSource, /info\.frame = frame\.frameId/);
  assert.match(clockSource, /this\.deltaTime = 0/);
  assert.match(clockSource, /this\.time = fixedSeconds/);
  assert.match(clockSource, /finally/);
});
