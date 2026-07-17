import {
  BUILDING_HITL_DECISION_SCHEMA, BUILDING_STAGE_ARTIFACT_SCHEMA,
  BUILDING_HITL_DECISION_SCHEMA_V2,
  assertBuildingArtifactReviewable, buildingArtifactInvalidation,
  validateBuildingHitlDecision, validateBuildingStageArtifact,
} from "../src/assets/staged-building-pipeline.mjs";
import { createHash } from "node:crypto";

const H=(tag:string)=>`sha256:${createHash("sha256").update(tag).digest("hex")}`;
const artifact=(artifactId:string,kind:string,overrides:any={})=>({
  schema:BUILDING_STAGE_ARTIFACT_SCHEMA,artifactId,kind,revision:1,status:"candidate",
  contractHash:H(`${artifactId}-contract`),contentHash:H(`${artifactId}-content`),
  facets:[{scope:({shell:"exterior-envelope","furniture-pack":"placement-contract","interior-plan":"placements",composition:"runtime-closure"} as any)[kind]??"requirements",hash:H(`${artifactId}-facet`)}],inputs:[],
  evidence:[{evidenceId:`${artifactId}/hero`,kind:"engine-png",contentHash:H(`${artifactId}-png`),width:1920,height:1080,timestamp:"2026-07-14T12:00:00Z"}],...overrides,
});
const decision=(a:any,overrides:any={})=>({
  schema:BUILDING_HITL_DECISION_SCHEMA,decisionId:`decision/${a.artifactId}`,gate:"A1-shell",artifactId:a.artifactId,
  contractHash:a.contractHash,contentHash:a.contentHash,reviewer:"human-owner",timestamp:"2026-07-14T12:30:00Z",
  decision:"approve",evidenceHashes:a.evidence.map((e:any)=>e.contentHash),blockingFindings:[],observations:[],markedRegions:[],...overrides,
});
const rejects=(fn:()=>unknown,pattern:RegExp)=>{let caught:any;try{fn();}catch(error){caught=error;}if(!(caught instanceof Error)||!pattern.test(caught.message))throw new Error(`expected ${pattern}, got ${caught?.message??"no rejection"}`);};

const shell=artifact("cottage/shell-r1","shell");
const furniture=artifact("catalog/oak-table-r1","furniture-pack");
const plan=artifact("cottage/interior-r1","interior-plan",{inputs:[
  {artifactId:shell.artifactId,kind:shell.kind,facets:[shell.facets[0]]},
  {artifactId:furniture.artifactId,kind:furniture.kind,facets:[furniture.facets[0]]},
]});
const composition=artifact("cottage/composition-r1","composition",{inputs:[
  {artifactId:shell.artifactId,kind:shell.kind,facets:[shell.facets[0]]},
  {artifactId:plan.artifactId,kind:plan.kind,facets:[plan.facets[0]]},
  {artifactId:furniture.artifactId,kind:furniture.kind,facets:[furniture.facets[0]]},
]});
for(const value of [shell,furniture,plan,composition])validateBuildingStageArtifact(value);
if(buildingArtifactInvalidation([shell,furniture,plan,composition]).length!==0)throw new Error("closed artifact graph was invalidated");

const materialOnlyShell={...shell,contentHash:H("shell-new-pixels")};
const materialStale=buildingArtifactInvalidation([materialOnlyShell,furniture,plan,composition]);
if(materialStale.length!==0)throw new Error(`unselected shell content change invalidated stages: ${JSON.stringify(materialStale)}`);
const contractShell={...shell,contractHash:H("shell-new-contract"),facets:[{...shell.facets[0],hash:H("shell-new-envelope")}]};
const contractStale=buildingArtifactInvalidation([contractShell,furniture,plan,composition]);
if(contractStale.map(x=>x.artifactId).join(",")!==`${composition.artifactId},${plan.artifactId}`)throw new Error(`shell contract change did not invalidate plan transitively: ${JSON.stringify(contractStale)}`);
const visualFurniture={...furniture,contentHash:H("table-new-pixels")};
const furnitureStale=buildingArtifactInvalidation([shell,visualFurniture,plan,composition]);
if(furnitureStale.length!==0)throw new Error("unselected furniture visual bytes invalidated its plan contract");

const approval=decision(shell);validateBuildingHitlDecision(approval);
assertBuildingArtifactReviewable(shell,approval,[shell]);
const repeatedOffFrame=artifact("cottage/repeatable-fire","shell",{evidence:[
  {evidenceId:"cottage/repeatable-fire/off-initial",kind:"engine-png",contentHash:H("identical-off-frame"),width:1920,height:1080},
  {evidenceId:"cottage/repeatable-fire/off-final",kind:"engine-png",contentHash:H("identical-off-frame"),width:1920,height:1080},
]});
const repeatedOffApproval={...decision(repeatedOffFrame),schema:BUILDING_HITL_DECISION_SCHEMA_V2,
  evidenceBindings:repeatedOffFrame.evidence.map(({evidenceId,contentHash}:any)=>({evidenceId,contentHash}))};
delete (repeatedOffApproval as any).evidenceHashes;
validateBuildingHitlDecision(repeatedOffApproval);assertBuildingArtifactReviewable(repeatedOffFrame,repeatedOffApproval,[repeatedOffFrame]);
rejects(()=>validateBuildingHitlDecision({...approval,decision:"approve-with-notes"}),/decision must be/);
rejects(()=>validateBuildingHitlDecision({...approval,blockingFindings:["roof defect"]}),/approval cannot carry/);
rejects(()=>validateBuildingHitlDecision({...approval,decision:"revise",blockingFindings:["roof defect"]}),/marked region or instruction/);
validateBuildingHitlDecision({...approval,decision:"revise",blockingFindings:["roof defect"],instruction:"Raise the dormer eave."});
rejects(()=>validateBuildingHitlDecision({...approval,decision:"reject",blockingFindings:["wrong massing"],instruction:"Return to brief."}),/returnToGate/);
validateBuildingHitlDecision({...approval,decision:"reject",blockingFindings:["wrong massing"],instruction:"Return to brief.",returnToGate:"B0-brief"});
rejects(()=>assertBuildingArtifactReviewable(shell,{...approval,contentHash:H("different")},[shell]),/exact building artifact/);
rejects(()=>assertBuildingArtifactReviewable(composition,decision(composition),[contractShell,furniture,plan,composition]),/stale building artifact/);
const cyclicA=artifact("cycle/a","brief"),cyclicB=artifact("cycle/b","brief");
cyclicA.inputs=[{artifactId:cyclicB.artifactId,kind:cyclicB.kind,facets:[cyclicB.facets[0]]}];cyclicB.inputs=[{artifactId:cyclicA.artifactId,kind:cyclicA.kind,facets:[cyclicA.facets[0]]}];
rejects(()=>buildingArtifactInvalidation([cyclicA,cyclicB]),/dependency cycle/);

console.log("p_staged_building_pipeline OK: exact stage identities, scoped/transitive invalidation, and fail-closed HITL decisions");
