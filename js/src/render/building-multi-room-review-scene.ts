import { AssetRegistry } from "../asset-registry.ts";
import { LiminaTracer } from "../observability/event.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { sha256 } from "../world/sha256.mjs";
import { validateBuildingSiteReviewEnvelope, type BuildingSiteReviewEnvelope } from "./building-site-review-envelope.ts";

type V3 = readonly [number,number,number];
type ViewId = "exterior-entry"|"exterior-rear"|"gable-elevation"|"frame-entry-window-detail"|"ground-rooms-passage"|"stair-opening"|"upper-room"|"lod-25m";
export interface MultiRoomReviewAuthority {
  readonly schema:"limina.fb4-multi-room-review-authority/v2"|"limina.fb4-multi-room-review-authority/v3";
  readonly candidate:{readonly manifest:{readonly path:string;readonly sha256:string};readonly glb:{readonly path:string;readonly sha256:string;readonly contentHash:string;readonly bytes:number};readonly irHash:string};
  readonly visualFloor:{readonly referenceSetId:"project-gorgon/house/v1";readonly releaseContract:{readonly path:string;readonly sha256:string};readonly belowFloorPresentationProhibited:true;readonly humanApprovalRequired:true};
  readonly environment:{readonly authority:{readonly path:string;readonly sha256:string};readonly runtimeBundle:{readonly path:string;readonly sha256:string};readonly shot:"river-leading-line";readonly context:"approved-temperate-production"};
  readonly placement:{readonly position:V3;readonly yaw:number};
  readonly topologyProof:{readonly fromRoomId:string;readonly toRoomId:string;readonly roomIds:readonly string[];readonly connectionIds:readonly string[];readonly expectedDoors:number;readonly expectedAnchors:number};
  readonly presentation:{readonly minimumResolution:readonly[number,number];readonly fixedTimeSeconds:number;readonly warmupFrames:number;readonly timestampQueriesEnabled:false};
  readonly evidenceViews:readonly{readonly id:ViewId;readonly role:string;readonly camera:{readonly position:V3;readonly target:V3;readonly fovDeg:number;readonly near:number;readonly far:number}}[];
  readonly approval:{readonly renderer:"limina-production-native-engine";readonly humanDecision:"pending";readonly visualApprovalClaimed:false;readonly nonEngineApprovalProhibited:true};
  readonly siteReviewEnvelope?:BuildingSiteReviewEnvelope;
}
const HASH=/^sha256:[0-9a-f]{64}$/;
const vec=(v:unknown):v is V3=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
export function validateMultiRoomReviewAuthority(value:unknown):MultiRoomReviewAuthority{
  const a=value as MultiRoomReviewAuthority;
  if(!["limina.fb4-multi-room-review-authority/v2","limina.fb4-multi-room-review-authority/v3"].includes(a?.schema)||!HASH.test(a.candidate?.manifest?.sha256)||!HASH.test(a.candidate?.glb?.sha256)||!HASH.test(a.candidate?.glb?.contentHash)||!HASH.test(a.candidate?.irHash)||!Number.isSafeInteger(a.candidate?.glb?.bytes)||a.candidate.glb.bytes<1)throw new Error("invalid FB-4 candidate authority");
  if(a.visualFloor?.referenceSetId!=="project-gorgon/house/v1"||a.visualFloor.belowFloorPresentationProhibited!==true||a.visualFloor.humanApprovalRequired!==true||!HASH.test(a.visualFloor.releaseContract?.sha256))throw new Error("FB-4 review lost the locked visual floor");
  if(a.environment?.shot!=="river-leading-line"||a.environment.context!=="approved-temperate-production"||!HASH.test(a.environment.authority?.sha256)||!HASH.test(a.environment.runtimeBundle?.sha256))throw new Error("FB-4 review lost approved production environment");
  if(!vec(a.placement?.position)||!Number.isFinite(a.placement?.yaw)||a.presentation?.timestampQueriesEnabled!==false||a.presentation.minimumResolution[0]<1920||a.presentation.minimumResolution[1]<1080||a.approval?.humanDecision!=="pending"||a.approval.visualApprovalClaimed!==false||a.approval.nonEngineApprovalProhibited!==true)throw new Error("FB-4 presentation/approval policy drifted");
  if(!a.topologyProof?.fromRoomId||!a.topologyProof.toRoomId||a.topologyProof.roomIds?.length<2||a.topologyProof.connectionIds?.length!==a.topologyProof.roomIds.length-1||!Number.isSafeInteger(a.topologyProof.expectedDoors)||a.topologyProof.expectedDoors<1||!Number.isSafeInteger(a.topologyProof.expectedAnchors)||a.topologyProof.expectedAnchors<1)throw new Error("FB-4 topology proof is incomplete");
  if(a.evidenceViews?.map(v=>v.id).join(",")!=="exterior-entry,exterior-rear,gable-elevation,frame-entry-window-detail,ground-rooms-passage,stair-opening,upper-room,lod-25m")throw new Error("FB-4 evidence cameras are incomplete");
  for(const view of a.evidenceViews)if(!view.role||!vec(view.camera.position)||!vec(view.camera.target)||view.camera.fovDeg<20||view.camera.fovDeg>85||view.camera.near<=0||view.camera.far<=view.camera.near)throw new Error(`invalid FB-4 camera ${view.id}`);
  if(a.schema==="limina.fb4-multi-room-review-authority/v3")validateBuildingSiteReviewEnvelope(a.siteReviewEnvelope);
  else if(a.siteReviewEnvelope!==undefined)throw new Error("FB-4 V2 authority cannot claim V3 site-review guarantees");
  return Object.freeze(a);
}
export type CaptureReadyMultiRoomReviewAuthority=MultiRoomReviewAuthority&{readonly schema:"limina.fb4-multi-room-review-authority/v3";readonly siteReviewEnvelope:BuildingSiteReviewEnvelope};
export function assertMultiRoomReviewCaptureReady(value:MultiRoomReviewAuthority):CaptureReadyMultiRoomReviewAuthority{
  if(value.schema!=="limina.fb4-multi-room-review-authority/v3"||value.siteReviewEnvelope===undefined)throw new Error("FB-4 V2 review authority is historical only; a V3 siteReviewEnvelope is required before GPU capture");
  validateBuildingSiteReviewEnvelope(value.siteReviewEnvelope);return value as CaptureReadyMultiRoomReviewAuthority;
}
const success=(result:Awaited<ReturnType<SkillRegistry["invoke"]>>,name:string)=>{if(!result.success)throw new Error(`${name} failed: ${JSON.stringify(result.error)}`);return result.result as Record<string,unknown>;};
export async function mountMultiRoomReview(world:WorldContext,authority:MultiRoomReviewAuthority,rootY:number){
  const bytes=world.ops.op_read_asset(authority.candidate.glb.path);
  if(bytes.byteLength!==authority.candidate.glb.bytes||`sha256:${sha256(bytes)}`!==authority.candidate.glb.sha256||portableAssetContentHash(bytes)!==authority.candidate.glb.contentHash)throw new Error("FB-4 production GLB exact bytes drifted");
  const manifestBytes=world.ops.op_read_asset(authority.candidate.manifest.path);if(`sha256:${sha256(manifestBytes)}`!==authority.candidate.manifest.sha256)throw new Error("FB-4 candidate manifest drifted");
  const assets=new AssetRegistry(world.ops),assetId=authority.candidate.glb.path.replace(/^assets\//,"");assets.seed(assetId,bytes);
  const registry=new SkillRegistry(new LiminaTracer("fb4-multi-room-review"));const core=registerCoreSkills(registry,{assets});
  const ctx={agentId:"fb4-review",sessionId:"fb4-review",permissions:resolveProfile("builder.readWrite"),tick:0,world};
  let root:string|undefined;
  try{
    const placed=success(await registry.invoke("building.placeFunctional",{assetId,hash:authority.candidate.glb.contentHash,position:[authority.placement.position[0],rootY+authority.placement.position[1],authority.placement.position[2]],yaw:authority.placement.yaw},ctx),"building.placeFunctional");root=placed.root as string;
    const doors=placed.doors as string[],parts=placed.parts as string[];if(doors.length!==authority.topologyProof.expectedDoors||parts.length<10)throw new Error("FB-4 functional placement lacks decomposed structure");
    const path=success(await registry.invoke("building.findRoomPath",{root,fromRoomId:authority.topologyProof.fromRoomId,toRoomId:authority.topologyProof.toRoomId},ctx),"building.findRoomPath");
    if(path.found!==true||(path.roomIds as string[]).join(",")!==authority.topologyProof.roomIds.join(",")||(path.connectionIds as string[]).join(",")!==authority.topologyProof.connectionIds.join(","))throw new Error("FB-4 mounted topology cannot traverse the authority path");
    const anchors=success(await registry.invoke("building.querySpawnAnchors",{root},ctx),"building.querySpawnAnchors").anchors as unknown[];if(anchors.length!==authority.topologyProof.expectedAnchors)throw new Error("FB-4 mounted topology lost spawn anchors");
    let disposed=false;return Object.freeze({root,doors:Object.freeze(doors),parts:Object.freeze(parts),path,anchors,topologyManager:core.functionalBuildings.topologyManager,
      dispose:async()=>{if(disposed)return;success(await registry.invoke("building.destroyFunctional",{root},{...ctx,tick:1}),"building.destroyFunctional");disposed=true;},
    });
  }catch(error){if(root!==undefined)await registry.invoke("building.destroyFunctional",{root},{...ctx,tick:1});throw error;}
}
