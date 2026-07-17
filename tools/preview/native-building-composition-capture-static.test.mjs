import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const [scene,demo,runner,builder]=await Promise.all([
  readFile(new URL("../../js/src/render/building-composition-review-scene.ts",import.meta.url),"utf8"),
  readFile(new URL("../../js/src/demos/building_composition_capture_window.ts",import.meta.url),"utf8"),
  readFile(new URL("./run-native-building-composition-capture.mjs",import.meta.url),"utf8"),
  readFile(new URL("../architecture/build-composition-review-authority.mjs",import.meta.url),"utf8"),
]);

test("C1 mounts exact M1 runtime and seven functional furniture instances through engine skills",()=>{
  assert.match(scene,/materialPalette\.runtimeGlb/);assert.match(scene,/"asset\.place"/);assert.match(scene,/"furniture\.placeFunctional"/);assert.match(scene,/"furniture\.destroyFunctional"/);assert.match(scene,/verifyBuildingCompositionReviewClosure/);assert.doesNotMatch(scene,/functional_cottage|legacy monolith/i);
  assert.match(runner,/inventory\?\.instances!==7/);assert.match(runner,/instance\/dining-table,instance\/dining-chair-north,instance\/dining-chair-south,instance\/dining-chair-west,instance\/dining-chair-east,instance\/hearth-settle,instance\/service-storage/);
});

test("C1 requires five targeted native-engine human review views",()=>{
  const views="entry-circulation,dining-three-quarter,hearth-seating,service-storage,overall-room";assert.match(scene,new RegExp(views));assert.match(runner,new RegExp(views));for(const id of views.split(","))assert.match(builder,new RegExp(`id:\"${id}\"`));assert.match(builder,/minimumResolution:\[1920,1080\]/);assert.match(builder,/blenderApprovalProhibited:true/);assert.match(builder,/fireExcluded:true/);
});

test("C1 r3 authority exposes the exact unobstructed evidence-camera revision",()=>{
  assert.match(builder,/id:"entry-circulation"[^\n]+position:\[-\.15,1\.6,-1\.55\][^\n]+target:\[-\.72,\.72,-3\.58\][^\n]+fovDeg:64/);
  assert.match(builder,/id:"dining-three-quarter"[^\n]+position:\[-1\.05,1\.58,-2\.5\][^\n]+target:\[-3,\.68,-\.8\][^\n]+fovDeg:58/);
  assert.match(builder,/id:"hearth-seating"[^\n]+position:\[-1\.65,1\.65,\.35\][^\n]+target:\[2\.75,\.82,\.9\][^\n]+fovDeg:64/);
  assert.match(builder,/id:"service-storage"[^\n]+position:\[1\.45,1\.52,-4\.12\][^\n]+target:\[3\.65,\.9,-4\.12\][^\n]+fovDeg:60/);
  assert.match(builder,/id:"overall-room"[^\n]+position:\[-\.45,2\.3,-2\.9\][^\n]+target:\[0,\.82,\.25\][^\n]+fovDeg:80/);
  assert.equal((builder.match(/near:\.03,far:100/g)??[]).length,5,"all five revised views must retain the exact near/far policy");
});

test("C1 capture is append-only private and absolute-stop Xid guarded with timestamps disabled",()=>{
  assert.match(runner,/assets\/qc\/internal\/compositions/);assert.match(runner,/append-only C1 output already exists/);assert.match(runner,/journalctl/);assert.match(runner,/NVIDIA Xid detected; capture stopped and must not be retried before reboot/);assert.match(runner,/current boot already contains an NVIDIA Xid/);assert.match(runner,/delete captureEnv\.LIMINA_GPU_TIMESTAMP_RISK_ACK/);assert.match(runner,/delete captureEnv\.LIMINA_GPU_TIMESTAMP_MODE/);assert.match(runner,/delete captureEnv\.LIMINA_GPU_TIMESTAMP_QUERIES/);assert.match(demo,/gpuTimestampMode:\"disabled\"/);assert.doesNotMatch(demo,/GPU_TIMESTAMP_RISK_ACK/);
});

test("C1 evidence validates whole-scene telemetry, furniture delta, resources, pixels, exposure, and lifecycle",()=>{
  assert.match(demo,/requireWholeFrameRenderSubmissionTelemetry/);assert.match(demo,/requirePairedRenderSubmissionTelemetry/);assert.match(demo,/captureRenderResourceTelemetry/);assert.match(demo,/setFurnitureVisible\(false\)/);assert.match(demo,/readNativeSurfaceRgba/);assert.match(runner,/lacks whole-scene telemetry/);assert.match(runner,/lacks strict furniture-delta telemetry/);assert.match(runner,/lacks renderer resource telemetry/);assert.match(runner,/exposure is not reviewable/);assert.match(runner,/afterDisposeEntities!==artifact\.lifecycle\.baselineEntities/);
});

test("C1 review binds the exact CPU-authored integrated Blender source without treating it as approval",()=>{
  assert.match(scene,/integratedSource/);assert.match(scene,/limina\.building-composition-build-evidence\/v1/);assert.match(scene,/cpu-authored-unreviewed/);assert.match(scene,/rendered!==false/);assert.match(scene,/gpuUsed!==false/);assert.match(builder,/buildEvidencePath/);assert.match(builder,/--build-evidence/);assert.match(demo,/integratedSource:authority\.integratedSource/);assert.match(runner,/artifact\.integratedSource/);
});
