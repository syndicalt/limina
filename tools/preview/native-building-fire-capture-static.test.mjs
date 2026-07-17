import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const [authority,scene,binding,demo,runner]=await Promise.all([
  readFile(new URL("../../js/src/render/building-fire-review-authority.ts",import.meta.url),"utf8"),
  readFile(new URL("../../js/src/render/building-fire-review-scene.ts",import.meta.url),"utf8"),
  readFile(new URL("../../js/src/render/building-fire-render-binding.ts",import.meta.url),"utf8"),
  readFile(new URL("../../js/src/demos/building_fire_capture_window.ts",import.meta.url),"utf8"),
  readFile(new URL("./run-native-building-fire-capture.mjs",import.meta.url),"utf8"),
]);

const frameIds=["hearth-motion--off-initial","hearth-motion--ignition","hearth-motion--burn-a","hearth-motion--burn-b","hearth-motion--burn-c","hearth-motion--burn-d","hearth-motion--extinguish","hearth-motion--off-final","fuel-detail--burn-a","reflected-light--off-initial","reflected-light--burn-a"];

test("V1 capture uses the exact authority and mount interfaces without compatibility shims",()=>{
  assert.match(demo,/validateBuildingFireReviewAuthority,verifyBuildingFireReviewClosure/);assert.match(demo,/mountBuildingFireReview/);assert.match(demo,/mounted\.start\(\)/);assert.match(demo,/mounted\.extinguish\(\)/);assert.match(demo,/mounted\.advanceTicks/);assert.match(demo,/mounted\.snapshot\(\)/);assert.match(demo,/mounted\.restore\(snapshot\)/);assert.match(demo,/mounted\.setDynamicFireVisible/);
  assert.match(scene,/export async function mountBuildingFireReview\(world: WorldContext, authorityValue: unknown\)/);assert.doesNotMatch(demo,/compat|fallback|legacy/i);
});

test("V1 captures the canonical 11 evidence frames from authority cameras and runtime ticks",()=>{
  for(const id of frameIds)assert.match(authority,new RegExp(id));assert.match(authority,/evidenceFrames: readonly BuildingFireReviewFrame\[\]/);assert.match(demo,/for\(const \[index,frame\] of authority\.evidenceFrames\.entries\(\)\)/);assert.match(demo,/snapshot\.state\.tick!==frame\.tick/);assert.match(demo,/snapshot\.state\.phase!==frame\.phase/);assert.match(demo,/camera\.position\.set\(\.\.\.frame\.camera\.position\)/);assert.match(runner,/BUILDING_FIRE_REVIEW_FRAME_IDS/);
});

test("V1 capture is append-only private and absolute-stop Xid guarded",()=>{
  assert.match(runner,/assets\/qc\/internal\/fire/);assert.match(runner,/append-only V1 output already exists/);assert.match(runner,/exact 1920x1080 evidence requires LIMINA_NATIVE_CAPTURE_FULLSCREEN=1/);assert.match(runner,/journalctl/);assert.match(runner,/NVIDIA Xid detected; capture stopped and must not be retried before reboot/);assert.match(runner,/current boot already contains an NVIDIA Xid; reboot before any native capture retry/);assert.match(runner,/stop immediately and reboot before any retry/);assert.match(runner,/mode:0o700/);assert.match(runner,/mode:0o600,flag:"wx"/);
});

test("V1 capture deletes every timestamp-risk input and disables GPU timestamps in-engine",()=>{
  assert.match(runner,/delete captureEnv\.LIMINA_GPU_TIMESTAMP_RISK_ACK/);assert.match(runner,/delete captureEnv\.LIMINA_GPU_TIMESTAMP_MODE/);assert.match(runner,/delete captureEnv\.LIMINA_GPU_TIMESTAMP_QUERIES/);assert.match(runner,/if\(\/TIMESTAMP\/i\.test\(key\)\)delete captureEnv\[key\]/);assert.match(demo,/gpuTimestampMode:"disabled"/);assert.match(demo,/timestampQueriesEnabled:false/);assert.doesNotMatch(demo,/GPU_TIMESTAMP_RISK_ACK/);
});

test("V1 evidence includes whole-frame, paired, resource, lifecycle, pixels, and CPU encode timing",()=>{
  assert.match(demo,/requireWholeFrameRenderSubmissionTelemetry/);assert.match(demo,/requireSubjectPairedRenderSubmissionTelemetry/);assert.match(demo,/captureRenderResourceTelemetry/);assert.match(demo,/pairedBaselineRgbaBase64/);assert.match(demo,/baselineResources,mountedResources,afterDisposeResources/);assert.match(runner,/lacks whole-scene telemetry/);assert.match(runner,/lacks paired fire telemetry/);assert.match(runner,/lacks renderer resource telemetry/);assert.match(runner,/cpuPngEncodeMs/);assert.match(runner,/afterDisposeEntities!==artifact\.lifecycle\.baselineEntities/);
});

test("V1 TSL deformation never coerces an attribute node through JavaScript arithmetic",()=>{
  assert.match(binding,/phase\.mul\(7\.3\)/);assert.doesNotMatch(binding,/phase\s*\*\s*7\.3/);
  assert.match(binding,/setAttribute\("fireShape"/);assert.match(binding,/setAttribute\("fireDeformation"/);
  assert.doesNotMatch(binding,/setAttribute\("fireHeight01"/);assert.doesNotMatch(binding,/setAttribute\("fireFrequencyHz"/);
});

test("V1 CPU evidence enforces channel exposure, flame variation, and reflected light",()=>{
  assert.match(runner,/limina\.cpu-channel-exposure\/v1/);assert.match(runner,/maxChannelP99/);assert.match(runner,/maxClippedPixelFraction/);assert.match(runner,/limina\.deterministic-flame-silhouette-variation\/v1/);assert.match(runner,/jaccardDistance/);assert.match(runner,/maskSha256/);assert.match(runner,/limina\.cpu-volumetric-fire-proof\/v1/);assert.match(runner,/maximumOcclusionLeakFraction/);assert.match(runner,/multiViewFrameIds/);assert.match(runner,/limina\.cpu-reflected-light-off-on\/v1/);assert.match(runner,/positivelyLitPixels/);assert.match(runner,/hotPixelExclusion/);
});

test("static harness never invokes the native GPU capture",()=>{
  assert.doesNotMatch(import.meta.url,/run-native-building-fire-capture\.mjs$/);assert.match(runner,/runGuarded\(binary/);
});
