import {ops} from "../src/engine.ts";
import {parseFunctionalBuildingContract} from "../src/assets/functional-building-contract.ts";
import {resolveFunctionalBuildingSitePlacement} from "../src/assets/functional-building-site.ts";
import {loadTemperateFidelityCandidate} from "../src/render/temperate-fidelity-scene.ts";
import {verifyBuildingProductionReviewClosure,verifyBuildingProductionReviewSiteResolution} from "../src/render/building-production-review-authority.ts";

function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(`p_building_production_review_site_fit FAIL: ${message}`);}
const decoder=new TextDecoder("utf-8",{fatal:true}),authorityPath="assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653/production-review-authority-v5.json",authority=JSON.parse(decoder.decode(ops.op_read_asset(authorityPath))),closure=verifyBuildingProductionReviewClosure(authority,path=>ops.op_read_asset(path));
const reader={readJson:async(path:string)=>JSON.parse(decoder.decode(ops.op_read_asset(path))),readBytes:async(path:string)=>ops.op_read_asset(path)},loaded=await loadTemperateFidelityCandidate({reader,shot:authority.environment.shot});
try{const contract=parseFunctionalBuildingContract(closure.productionBytes),resolution=resolveFunctionalBuildingSitePlacement({contract,position:authority.placement.position,yaw:authority.placement.yaw,sampleHeight:(x,z)=>loaded.candidate.snapshot.terrain.sampleHeight(x,z),maximumSampleSpacing:.5}),evidence=verifyBuildingProductionReviewSiteResolution(authority,closure.siteFit,resolution,(x,z)=>loaded.candidate.snapshot.terrain.sampleHeight(x,z));
  assert(Math.abs(resolution.terrainRelief-.28095984171)<1e-10&&resolution.terrainRelief<=contract.site!.maximumTerrainRelief,"footprint relief proof drifted");
  assert(Math.abs(resolution.rootWorldY-16.405181949178)<1e-10,"root height proof drifted");
  assert(resolution.entranceSupport!==undefined&&Math.abs(resolution.entranceSupport.terrainVariation-.023145916089)<1e-10&&Math.abs(resolution.entranceSupport.cutDepth-.03216789938)<1e-10,"entrance support proof drifted");
  assert(evidence.terrain.residentChunks.length===25&&evidence.cameraDomain.views.length===5&&evidence.cameraDomain.views.every((view:any)=>view.residentTerrain&&view.aboveTerrain&&view.withinClipDomain),"terrain or camera domain closure is incomplete");
  assert(evidence.cameraDomain.interiorRoom.views.length===3&&evidence.cameraDomain.interiorRoom.views.every((view:any)=>view.positionInsideRoom&&view.targetInsideRoom&&view.minimumColliderClearanceM>=.25),"interior camera envelope/collider closure is incomplete");
}finally{loaded.candidate.dispose();}
console.log("p_building_production_review_site_fit OK: exact temperate snapshot, production site contract, 25 resident terrain chunks, footprint/root/entrance metrics, five terrain domains, and three interior envelope/collider camera domains verified CPU-only");
