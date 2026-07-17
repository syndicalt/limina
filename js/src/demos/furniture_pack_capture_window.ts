import * as THREE from "../../build/three.bundle.mjs";
import { createEngine, ops } from "../engine.ts";
import { renderSyncSystem } from "../ecs/world.ts";
import { isSoftwareAdapter } from "../render/fidelity-benchmark.ts";
import { withFrozenRendererTime } from "../render/frozen-render-time.ts";
import { mountFurniturePackReview, validateFurniturePackReviewAuthority } from "../render/furniture-pack-review-scene.ts";
import { readNativeSurfaceRgba, withPresentedNativeSurfaceFrame } from "../render/native-surface-readback.ts";
import { captureRenderResourceTelemetry, captureRenderSubmissionTelemetry, requirePairedRenderSubmissionTelemetry, requireWholeFrameRenderSubmissionTelemetry, type RendererInfoLike } from "../render/telemetry.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { sha256 } from "../world/sha256.mjs";
import type { WorldContext } from "../skills/registry.ts";

const TRACE_NAME="furniture-pack-native-capture.json";
const AUTHORITY_PATH=ops.op_read_env("LIMINA_FURNITURE_REVIEW_AUTHORITY");
if(!AUTHORITY_PATH)throw new Error("LIMINA_FURNITURE_REVIEW_AUTHORITY is required for native furniture capture");
const decoder=new TextDecoder("utf-8",{fatal:true}),authorityBytes=ops.op_read_asset(AUTHORITY_PATH),authority=validateFurniturePackReviewAuthority(JSON.parse(decoder.decode(authorityBytes)));
const exact=(path:string,expected:string,label:string)=>{const bytes=ops.op_read_asset(path);if(`sha256:${sha256(bytes)}`!==expected)throw new Error(`${label} hash drifted`);return bytes;};
const evidenceBytes=exact(authority.pack.evidencePath,authority.pack.evidenceSha256,"furniture evidence"),evidence=JSON.parse(decoder.decode(evidenceBytes));
exact(authority.source.blendPath,authority.source.blendSha256,"furniture source Blend");
if(evidence.payloadHash!==authority.pack.payloadHash||evidence.sourceSpecHash!==authority.pack.sourceSpecHash||evidence.sourceIrHash!==authority.pack.sourceIrHash||evidence.primitiveCount!==authority.pack.primitiveCount)throw new Error("furniture authority no longer matches build evidence");
const [width,height]=authority.presentation.minimumResolution,engine=await createEngine({width,height,gpuTimestampMode:"disabled",renderBaseline:false});
if(isSoftwareAdapter(engine.gpuAdapter))throw new Error(`furniture production review resolved a software adapter: ${JSON.stringify(engine.gpuAdapter)}`);
const renderer=engine.renderer as unknown as THREE.WebGPURenderer;renderer.info.autoReset=false;
const world={ecs:engine.world,entities:engine.entities,tags:engine.tags,transforms:engine.transforms,spatial:engine.spatial,scene:engine.scene,camera:engine.camera,renderer:engine.renderer,ops:engine.ops,width:engine.width,height:engine.height,mode:engine.mode} as WorldContext;
const bytesToBase64=(bytes:Uint8Array)=>{let binary="";for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,Math.min(offset+32768,bytes.length)));return btoa(binary);};
let mounted:Awaited<ReturnType<typeof mountFurniturePackReview>>|undefined,captureFailure:unknown;
try{
  ops.op_physics_create_world(0);const lifecycleBaseline=world.entities.ids().length;mounted=await mountFurniturePackReview(world,authority);renderSyncSystem(world.ecs);
  const functionalMount=mounted as typeof mounted&{functionalEvidence:unknown;setReviewState(view:(typeof authority.evidenceViews)[number]):string};
  if(typeof functionalMount.setReviewState!=="function"||JSON.stringify(functionalMount.functionalEvidence)!==JSON.stringify(authority.functionalEvidence))throw new Error("furniture mount lacks exact functional socket/collision/interaction evidence");
  const subject=mounted.entity,authoritativeBounds=mounted.authoritativeBounds,stageEntities=[...mounted.stageEntities],camera=engine.camera as THREE.PerspectiveCamera;
  const captures=await withFrozenRendererTime(renderer,authority.presentation.fixedTimeSeconds,async(beginFrame)=>{const out=[];for(let i=0;i<authority.evidenceViews.length;i++){
    const view=authority.evidenceViews[i],appliedState=functionalMount.setReviewState(view),reviewState={type:view.type,state:view.state,appliedState};mounted!.setScaleProxyVisible(view.id==="front");camera.fov=view.fovDeg;camera.near=view.near;camera.far=view.far;camera.position.set(...view.position);camera.lookAt(...view.target);camera.updateProjectionMatrix();camera.updateMatrixWorld(true);
    for(let frame=0;frame<(i===0?authority.presentation.warmupFrames:2);frame++){beginFrame();renderer.render(engine.scene,engine.camera);ops.op_surface_present(engine.context);}
    mounted!.setSubjectVisible(false);let baseline;try{baseline=await withPresentedNativeSurfaceFrame(()=>ops.op_surface_present(engine.context),()=>{renderer.info.reset();beginFrame();renderer.render(engine.scene,engine.camera);return requireWholeFrameRenderSubmissionTelemetry(captureRenderSubmissionTelemetry(renderer.info as unknown as RendererInfoLike));});}finally{mounted!.setSubjectVisible(true);}
    const captured=await withPresentedNativeSurfaceFrame(()=>ops.op_surface_present(engine.context),async()=>{renderer.info.reset();beginFrame();const started=performance.now();renderer.render(engine.scene,engine.camera);const cpuEncodeMs=Number((performance.now()-started).toFixed(3)),submission=requireWholeFrameRenderSubmissionTelemetry(captureRenderSubmissionTelemetry(renderer.info as unknown as RendererInfoLike)),paired=requirePairedRenderSubmissionTelemetry(baseline,submission),resources=captureRenderResourceTelemetry(renderer.info as unknown as RendererInfoLike),readback=await readNativeSurfaceRgba({device:engine.device as never,context:engine.context as never,expectedWidth:width,expectedHeight:height,minimumWidth:width,minimumHeight:height});return{cpuEncodeMs,submission,paired,resources,readback};});
    out.push(Object.freeze({id:view.id,role:view.role,reviewState,camera:{position:view.position,target:view.target,fovDeg:view.fovDeg,near:view.near,far:view.far,distanceM:view.distanceM},width:captured.readback.width,height:captured.readback.height,surfaceFormat:captured.readback.format,rgbaContentHash:portableAssetContentHash(captured.readback.rgba),rgbaByteLength:captured.readback.rgba.byteLength,rgbaBase64:bytesToBase64(captured.readback.rgba),renderSubmission:{...captured.submission,cpuEncodeMs:captured.cpuEncodeMs},pairedRenderSubmission:captured.paired,rendererResources:captured.resources}));
  }return Object.freeze(out);});
  await mounted.dispose();mounted=undefined;const afterDispose=world.entities.ids().length;if(afterDispose!==lifecycleBaseline)throw new Error(`furniture review lifecycle leaked entities: ${lifecycleBaseline} -> ${afterDispose}`);
  ops.op_write_trace(TRACE_NAME,`${JSON.stringify({schema:"limina.furniture-pack-native-review-set/v1",backend:"native-webgpu",captureClass:"production-engine",surfaceFormat:captures[0].surfaceFormat,pixelFormat:"rgba8unorm",rowOrigin:"top-left",timingPolicy:{gpuTimestampMode:"disabled",timestampQueriesEnabled:false},adapter:engine.gpuAdapter,authority:{path:AUTHORITY_PATH,sha256:`sha256:${sha256(authorityBytes)}`,contentHash:portableAssetContentHash(authorityBytes)},dependencies:authority.dependencies,pack:authority.pack,source:authority.source,placement:authority.placement,presentation:authority.presentation,functionalEvidence:authority.functionalEvidence,mounted:{subject,authoritativeBounds,stageEntities,functionalEvidence:functionalMount.functionalEvidence,collisionEvidence:"compound-semantic-functional-placement"},lifecycle:{baselineEntities:lifecycleBaseline,afterDisposeEntities:afterDispose},captures})}\n`);
  ops.op_log(`furniture pack native review wrote ${TRACE_NAME} (${captures.map(c=>c.id).join(", ")})`);
}catch(error){captureFailure=error;}finally{const failures:unknown[]=[];try{await mounted?.dispose();}catch(error){failures.push(error);}try{engine.disposeRenderBaseline();}catch(error){failures.push(error);}try{await renderer.dispose();}catch(error){failures.push(error);}if(failures.length)captureFailure=new AggregateError(captureFailure===undefined?failures:[captureFailure,...failures],"furniture capture teardown failed");}
if(captureFailure!==undefined)throw captureFailure;
