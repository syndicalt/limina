import * as THREE from "../../build/three.bundle.mjs";
import { createEngine, ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { parseFunctionalBuildingContract } from "../assets/functional-building-contract.ts";
import { resolveFunctionalBuildingSitePlacement } from "../assets/functional-building-site.ts";
import { assertMultiRoomReviewCaptureReady, mountMultiRoomReview, validateMultiRoomReviewAuthority } from "../render/building-multi-room-review-scene.ts";
import { createSiteReviewDiscretePopulationExclusion, verifySiteReviewCameras, verifySiteReviewRuntimePack } from "../render/building-site-review-envelope.ts";
import { isSoftwareAdapter } from "../render/fidelity-benchmark.ts";
import { withFrozenRendererTime } from "../render/frozen-render-time.ts";
import { readNativeSurfaceRgba, withPresentedNativeSurfaceFrame } from "../render/native-surface-readback.ts";
import { captureRenderResourceTelemetry, captureRenderSubmissionTelemetry, requireWholeFrameRenderSubmissionTelemetry, type RendererInfoLike } from "../render/telemetry.ts";
import { loadTemperateFidelityCandidate, mountTemperateFidelityScene } from "../render/temperate-fidelity-scene.ts";
import { GltfSceneCache, prewarmGltfScene } from "../skills/three.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { sha256 } from "../world/sha256.mjs";

export const FB4_REVIEW_AUTHORITY_ENV="LIMINA_FB4_MULTI_ROOM_REVIEW_AUTHORITY" as const;
export const FB4_REVIEW_TRACE_ENV="LIMINA_FB4_MULTI_ROOM_REVIEW_TRACE" as const;
const authorityPath=ops.op_read_env(FB4_REVIEW_AUTHORITY_ENV),traceName=ops.op_read_env(FB4_REVIEW_TRACE_ENV);
if(!authorityPath)throw new Error(`${FB4_REVIEW_AUTHORITY_ENV} is required`);
if(!traceName||!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(traceName)||traceName.includes("..")||traceName.includes("/")||traceName.includes("\\"))throw new Error(`${FB4_REVIEW_TRACE_ENV} must be a bare .json filename`);
const decoder=new TextDecoder("utf8",{fatal:true}),authorityBytes=ops.op_read_asset(authorityPath),authority=assertMultiRoomReviewCaptureReady(validateMultiRoomReviewAuthority(JSON.parse(decoder.decode(authorityBytes))));
for(const entry of [authority.candidate.manifest,authority.visualFloor.releaseContract,authority.environment.authority,authority.environment.runtimeBundle])if(`sha256:${sha256(ops.op_read_asset(entry.path))}`!==entry.sha256)throw new Error(`FB-4 closure drifted: ${entry.path}`);
const glb=ops.op_read_asset(authority.candidate.glb.path),contract=parseFunctionalBuildingContract(glb),[width,height]=authority.presentation.minimumResolution;
const reader={readJson:async(path:string)=>JSON.parse(decoder.decode(ops.op_read_asset(path))),readBytes:async(path:string)=>ops.op_read_asset(path)};
const loaded=await loadTemperateFidelityCandidate({reader,shot:authority.environment.shot});
const site=resolveFunctionalBuildingSitePlacement({contract,position:authority.placement.position,yaw:authority.placement.yaw,sampleHeight:(x,z)=>loaded.candidate.snapshot.terrain.sampleHeight(x,z),maximumSampleSpacing:.5});
const runtimePackBytes=ops.op_read_asset(authority.siteReviewEnvelope.runtimePack.path),populationMaximumHorizontalReachM=verifySiteReviewRuntimePack(authority.siteReviewEnvelope,runtimePackBytes),discretePopulationHardExclusionAt=createSiteReviewDiscretePopulationExclusion({envelope:authority.siteReviewEnvelope,contract,position:authority.placement.position,yaw:authority.placement.yaw,views:authority.evidenceViews}),siteReviewCameraEvidence=verifySiteReviewCameras({envelope:authority.siteReviewEnvelope,position:authority.placement.position,yaw:authority.placement.yaw,rootWorldY:site.rootWorldY,views:authority.evidenceViews,width,height,sampleHeight:(x,z)=>loaded.candidate.snapshot.terrain.sampleHeight(x,z)});
const engine=await createEngine({width,height,gpuTimestampMode:"disabled",gpuTextureCompression:"bc-required",renderBaseline:false}).catch(error=>{loaded.candidate.dispose();throw error;});
const renderer=engine.renderer as unknown as THREE.WebGPURenderer;renderer.info.autoReset=false;
const cache=new GltfSceneCache({ktx2TranscoderPath:"/runtime/basis/",ktx2TranscoderBytes:{js:ops.op_read_asset("runtime/basis/basis_transcoder.js"),wasm:ops.op_read_asset("runtime/basis/basis_transcoder.wasm")}});cache.configureKtx2(renderer);
let environment:Awaited<ReturnType<typeof mountTemperateFidelityScene>>|undefined,mounted:Awaited<ReturnType<typeof mountMultiRoomReview>>|undefined,failure:unknown;
const b64=(bytes:Uint8Array)=>{let out="";for(let i=0;i<bytes.length;i+=32768)out+=String.fromCharCode(...bytes.subarray(i,Math.min(i+32768,bytes.length)));return btoa(out);};
try{
  if(isSoftwareAdapter(engine.gpuAdapter))throw new Error(`FB-4 review resolved a software adapter: ${JSON.stringify(engine.gpuAdapter)}`);
  await prewarmGltfScene(authority.candidate.glb.path.replace(/^assets\//,""),glb,cache);
  environment=await mountTemperateFidelityScene({loaded,renderer,scene:engine.scene as THREE.Scene,camera:engine.camera as THREE.PerspectiveCamera,ops,width,height,gltfCache:cache,populationHardExclusionAt:site.containsWorldXZ,discretePopulationHardExclusionAt});
  ops.op_physics_create_world(0);const baseline=environment.world.entities.ids().length;
  mounted=await mountMultiRoomReview(environment.world,authority,site.rootWorldY);renderSyncSystem(environment.world.ecs);
  const camera=engine.camera as THREE.PerspectiveCamera;
  const captures=await withFrozenRendererTime(renderer,authority.presentation.fixedTimeSeconds,async(beginFrame)=>{
    const output=[];for(let index=0;index<authority.evidenceViews.length;index++){
      const view=authority.evidenceViews[index];camera.position.set(view.camera.position[0],view.camera.position[1]+site.rootWorldY,view.camera.position[2]);camera.lookAt(view.camera.target[0],view.camera.target[1]+site.rootWorldY,view.camera.target[2]);camera.fov=view.camera.fovDeg;camera.near=view.camera.near;camera.far=view.camera.far;camera.updateProjectionMatrix();camera.updateMatrixWorld(true);
      for(let frame=0;frame<(index===0?authority.presentation.warmupFrames:2);frame++){beginFrame();await withPresentedNativeSurfaceFrame(()=>ops.op_surface_present(engine.context),()=>environment!.post.render());}
      const capture=await withPresentedNativeSurfaceFrame(()=>ops.op_surface_present(engine.context),async()=>{renderer.info.reset();beginFrame();const started=performance.now();environment!.post.render();const cpuEncodeMs=Number((performance.now()-started).toFixed(3));const submission=requireWholeFrameRenderSubmissionTelemetry(captureRenderSubmissionTelemetry(renderer.info as unknown as RendererInfoLike));if(submission.renderCalls<=1||submission.drawCalls<=1||submission.triangles<=1)throw new Error(`FB-4 ${view.id} did not submit a whole production frame`);const resources=captureRenderResourceTelemetry(renderer.info as unknown as RendererInfoLike),pixels=await readNativeSurfaceRgba({device:engine.device as never,context:engine.context as never,expectedWidth:width,expectedHeight:height,minimumWidth:width,minimumHeight:height});return{submission:{...submission,cpuEncodeMs},resources,pixels};});
      output.push(Object.freeze({id:view.id,role:view.role,camera:view.camera,width:capture.pixels.width,height:capture.pixels.height,surfaceFormat:capture.pixels.format,rgbaByteLength:capture.pixels.rgba.byteLength,rgbaContentHash:portableAssetContentHash(capture.pixels.rgba),rgbaBase64:b64(capture.pixels.rgba),renderSubmission:capture.submission,rendererResources:capture.resources}));
    }return Object.freeze(output);
  });
  const functionalEvidence={root:mounted.root,doors:mounted.doors.length,parts:mounted.parts.length,path:mounted.path,anchors:mounted.anchors.length};await mounted.dispose();mounted=undefined;const after=environment.world.entities.ids().length;if(after!==baseline)throw new Error(`FB-4 review leaked entities: ${baseline} -> ${after}`);
  ops.op_write_trace(traceName,`${JSON.stringify({schema:"limina.fb4-multi-room-native-review-set/v1",backend:"native-webgpu",captureClass:"production-engine",timingPolicy:{gpuTimestampMode:"disabled",timestampQueriesEnabled:false,gpuTextureCompression:"bc-required",renderBaseline:false},adapter:engine.gpuAdapter,authority:{path:authorityPath,sha256:`sha256:${sha256(authorityBytes)}`,contentHash:portableAssetContentHash(authorityBytes)},candidate:authority.candidate,environment:authority.environment,site:{rootWorldY:site.rootWorldY,sampleCount:site.sampleCount,terrainRelief:site.terrainRelief,reviewEnvelope:{populationMaximumHorizontalReachM,cameraEvidence:siteReviewCameraEvidence}},functionalPlacement:functionalEvidence,lifecycle:{baselineEntities:baseline,afterDisposeEntities:after,disposed:true},captures})}\n`);
}catch(error){failure=error;}finally{const errors:unknown[]=[];for(const operation of [async()=>mounted?.dispose(),async()=>environment?.dispose(),async()=>cache.dispose(),async()=>engine.disposeRenderBaseline(),async()=>renderer.dispose()])try{await operation();}catch(error){errors.push(error);}if(errors.length)failure=new AggregateError(failure===undefined?errors:[failure,...errors],"FB-4 capture teardown failed");}
if(failure!==undefined)throw failure;
