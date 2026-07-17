import { ops } from "../src/engine.ts";
import { validateBuildingProductionReviewAuthority, verifyBuildingProductionReviewClosure } from "../src/render/building-production-review-authority.ts";

function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(`p_building_production_review_authority FAIL: ${message}`);}
const path="assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653/production-review-authority-v5.json",authority=JSON.parse(new TextDecoder().decode(ops.op_read_asset(path)));
const closure=verifyBuildingProductionReviewClosure(authority,(asset)=>ops.op_read_asset(asset));
assert(closure.contractHash==="sha256:9c28cc3568d84caea0c04594d3c9273ff3b0205315b9e31a629a122c255bfb9f","frozen v3 package contract drifted");
assert(authority.evidenceViews.length===5&&authority.presentation.minimumResolution[0]>=1920&&authority.presentation.minimumResolution[1]>=1080,"review coverage/resolution drifted");
assert(authority.upstreamApprovals.length===9&&authority.approvalPolicy.humanDecision==="pending"&&!authority.approvalPolicy.visualApprovalClaimed,"authority improperly claims visual approval");
const terrainPath=closure.siteFit.terrain.residentChunks[0].path;let terrainRejected=false;try{verifyBuildingProductionReviewClosure(authority,(asset)=>{const bytes=ops.op_read_asset(asset);if(asset!==terrainPath)return bytes;const changed=new Uint8Array(bytes);changed[changed.length-1]^=1;return changed;});}catch{terrainRejected=true;}assert(terrainRejected,"resident terrain byte mutation was accepted");
for(const mutate of [(v:any)=>v.approvalPolicy.timestampQueriesEnabled=true,(v:any)=>v.visualFloor.referenceSetId="wrong",(v:any)=>v.upstreamApprovals.pop(),(v:any)=>v.presentation.minimumResolution=[1280,720],(v:any)=>v.evidenceViews.reverse(),(v:any)=>v.fire.advanceTicks=90,(v:any)=>v.placement.position[0]=30,(v:any)=>v.siteFitEvidence.sha256=v.package.manifest.sha256]){const value=JSON.parse(JSON.stringify(authority));mutate(value);let rejected=false;try{validateBuildingProductionReviewAuthority(value);}catch{rejected=true;}assert(rejected,"invalid review authority mutation was accepted");}
console.log("p_building_production_review_authority OK: frozen v3 manifest/evidence/candidate/mount/GLB, nine approved upstream closures, Project Gorgon floor, five views, and pending human gate verified");
