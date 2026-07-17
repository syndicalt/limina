import assert from "node:assert/strict";
import test from "node:test";
import { furnitureDesignContractHash, validateFurnitureDesignContract } from "../../js/src/architecture/furniture-design-contract.ts";
import { verifyFurnitureFunction } from "../../js/src/architecture/furniture-functional-verifier.ts";

const H=n=>`sha256:${n.repeat(64)}`,VISUAL=H("a"),GLB=H("b"),INVENTORY=H("c"),PLAN=H("d"),CONTENT=H("e");
const legs=["leg/front-left","leg/front-right","leg/rear-left","leg/rear-right"],arms=["arm/left","arm/right"],supports=["arm-support/left","arm-support/right"],backs=["back/lower-rail","back/field"],occupancies=["occupancy/left","occupancy/right"];
const shaped=(id,center,size)=>({id,kind:"shaped-board",materialRole:"oak",center,rotationDeg:[0,0,0],geometry:{kind:"shaped-board",size,edgeProfile:"eased",edgeRadiusM:.004}});
const member=(id,center,lengthM,bottomSection=[.08,.08])=>({id,kind:"tapered-member",materialRole:"oak",center,rotationDeg:[0,0,0],geometry:{kind:"tapered-member",lengthM,bottomSection,topSection:bottomSection,axis:"y",chamferM:.004}});
const panel=(id,center,size)=>({id,kind:"panel",materialRole:"oak",center,rotationDeg:[4,0,0],geometry:{kind:"panel",size,fieldDepthM:.008,fieldMarginM:.04,edgeRadiusM:.004}});
const joint=(id,left,right)=>({id,type:"mortise-tenon",members:[left,right],toleranceM:.005});
const runtime=(id,min,max)=>({id,bounds:{min,max},vertexCount:24});
const collider=(id,bounds,covers)=>({id,center:bounds.min.map((value,index)=>(value+bounds.max[index])/2),halfExtents:bounds.min.map((value,index)=>(bounds.max[index]-value)/2),covers});
const rotate2=([x,z],yaw)=>[Math.cos(yaw)*x+Math.sin(yaw)*z,-Math.sin(yaw)*x+Math.cos(yaw)*z];

function fixture(){
  const parts=[
    shaped("seat/main",[0,.44,-.05],[1.36,.04,.5]),
    member(legs[0],[-.72,.22,-.3],.44),member(legs[1],[.72,.22,-.3],.44),member(legs[2],[-.72,.22,.3],.44),member(legs[3],[.72,.22,.3],.44),
    shaped(arms[0],[-.73,.68,-.05],[.08,.08,.5]),shaped(arms[1],[.73,.68,-.05],[.08,.08,.5]),
    member(supports[0],[-.73,.54,-.27],.28,[.06,.06]),member(supports[1],[.73,.54,-.27],.28,[.06,.06]),
    shaped(backs[0],[0,.5,.18],[1.48,.1,.08]),panel(backs[1],[0,.915,.18],[1.6,.77,.08]),
  ];
  const bounds=new Map([
    ["seat/main",{min:[-.69,.42,-.3],max:[.69,.46,.2]}],
    [legs[0],{min:[-.76,0,-.35],max:[-.68,.44,-.25]}],[legs[1],{min:[.68,0,-.35],max:[.76,.44,-.25]}],
    [legs[2],{min:[-.76,0,.19],max:[-.68,.44,.35]}],[legs[3],{min:[.68,0,.19],max:[.76,.44,.35]}],
    [arms[0],{min:[-.77,.64,-.3],max:[-.69,.72,.2]}],[arms[1],{min:[.69,.64,-.3],max:[.77,.72,.2]}],
    [supports[0],{min:[-.76,.4,-.3],max:[-.69,.68,-.24]}],[supports[1],{min:[.69,.4,-.3],max:[.76,.68,-.24]}],
    [backs[0],{min:[-.74,.45,.14],max:[.74,.55,.22]}],[backs[1],{min:[-.8,.53,.14],max:[.8,1.3,.22]}],
  ]);
  const joints=[...legs.map((id,index)=>joint(`joint/seat-leg-${index}`,"seat/main",id)),joint("joint/left-arm-support",arms[0],supports[0]),joint("joint/right-arm-support",arms[1],supports[1]),joint("joint/left-support-seat",supports[0],"seat/main"),joint("joint/right-support-seat",supports[1],"seat/main"),joint("joint/left-arm-back",arms[0],backs[1]),joint("joint/right-arm-back",arms[1],backs[1]),joint("joint/back-rail-left",backs[0],legs[2]),joint("joint/back-rail-right",backs[0],legs[3]),joint("joint/back-field-rail",backs[1],backs[0])];
  const sockets=[{id:occupancies[0],kind:"occupancy",position:[-.32,.46,-.05],facing:[0,0,-1],supportedBy:"seat/main",clearanceRadiusM:.3},{id:occupancies[1],kind:"occupancy",position:[.32,.46,-.05],facing:[0,0,-1],supportedBy:"seat/main",clearanceRadiusM:.3},{id:"approach/front",kind:"approach",position:[0,0,-.85],facing:[0,0,1],supportedBy:"seat/main",clearanceRadiusM:.35}];
  const contract=validateFurnitureDesignContract({schema:"limina.furniture-design-contract/v1",id:"furniture/hearth-settle/v3",role:"hearth-settle",visualDesign:{id:"furniture/hearth-settle/visual-v3",hash:VISUAL},dimensions:{widthM:1.6,heightM:1.3,depthM:.7,seatHeightM:.46,seatDepthM:.5,occupancy:2},settle:{seatPartId:"seat/main",backPartIds:backs,legPartIds:legs,armPartIds:arms,armSupportPartIds:supports,occupancySocketIds:occupancies,approachSocketId:"approach/front",usableSeatWidthM:1.36,backSupportHeightM:.8,ratedLoadKg:220,canonicalForward:[0,0,-1]},parts,joints,sockets,colliders:[...bounds].map(([id,value],index)=>collider(`collision/part-${index}`,value,[id])),materialRoles:["oak"],status:"candidate"});
  const contractHash=furnitureDesignContractHash(contract),partBounds=[...bounds].map(([id,value])=>runtime(id,value.min,value.max)),buildEvidence={schema:"limina.furniture-contract-build-evidence/v1",payloadHash:contractHash,bounds:{min:[-.8,0,-.35],max:[.8,1.3,.35]},asset:{sha256:GLB,bytes:4096},inventory:{parts:parts.length,joints:joints.length,sockets:sockets.length,colliders:parts.length},freshProcessValidation:{contractHash,semanticInventorySha256:INVENTORY},glbValidation:{finiteAccessorBounds:true,contractIdentity:true,boundsSource:"exported-glb-scene-graph",pivot:[0,0,0],partBounds}};
  const yaw=-1.750649826587375,position=[.2,.09,2.2],world=local=>{const offset=rotate2([local[0],local[2]],yaw);return[position[0]+offset[0],position[1],position[2]+offset[1]]},settlePlacement={id:"placement/hearth-settle",archetypeId:"proxy/hearth-settle",roomId:"room/main",zoneId:"zone/hearth-seating",position,yawRadians:yaw,supportSocketId:"socket/floor/hearth-settle",facingTargetId:"facing/hall-hearth",footprint:{localCenter:[0,0],halfExtents:[.8,.35]}},other={id:"placement/dining-table",archetypeId:"proxy/dining-table",roomId:"room/main",zoneId:"zone/dining",position:[-3,.09,-.8],yawRadians:0,supportSocketId:"socket/floor/dining-table",facingTargetId:null,footprint:{localCenter:[0,0],halfExtents:[.7,.4]}};
  const plan={schema:"limina.building-interior-plan/v2",planId:"interior/functional-hall-house-v4/r3",revision:3,proxyArchetypes:[{id:"proxy/hearth-settle",kind:"settle",dimensions:[1.6,1.3,.7],supportKind:"floor",requiresApproach:true,requiresOccupancy:true},{id:"proxy/dining-table",kind:"table",dimensions:[1.4,.78,.8],supportKind:"floor",requiresApproach:true,requiresOccupancy:false}],placements:[settlePlacement,other],interactionClearances:[{id:"clearance/approach/hearth-settle",kind:"approach",placementId:settlePlacement.id,roomId:"room/main",center:world([0,0,-.85]),radiusM:.35,heightM:1.9},{id:"clearance/occupancy/hearth-settle-left",kind:"occupancy",placementId:settlePlacement.id,roomId:"room/main",center:world([-.32,0,-.05]),radiusM:.3,heightM:1.5},{id:"clearance/occupancy/hearth-settle-right",kind:"occupancy",placementId:settlePlacement.id,roomId:"room/main",center:world([.32,0,-.05]),radiusM:.3,heightM:1.5}],facingTargets:[{id:"facing/hall-hearth",roomId:"room/main",position:[2.95,1.2,2.7]}],surfaceSockets:[{id:"socket/floor/hearth-settle",kind:"floor",roomId:"room/main",position,normal:[0,1,0],capacityKg:350}],hearthExclusions:[{id:"hearth-exclusion/hall-hearth",roomId:"room/main",hearthId:"hall-hearth",center:[2.95,.09,2.58],halfExtents:[.88,.98],yawRadians:Math.PI,minimumClearanceM:.8,heightM:2.3}]},artifact={schema:"limina.building-stage-artifact/v1",artifactId:plan.planId,kind:"interior-plan",status:"approved",contractHash:PLAN,contentHash:CONTENT,metadata:{plan:{canonicalHash:PLAN,contentHash:CONTENT}}};
  return{contract,contractHash,buildEvidence,runtimeGlbSha256:GLB,approvedI1:{artifact,plan,canonicalPlanHash:PLAN,planContentHash:CONTENT},selectedProxyArchetypeId:"proxy/hearth-settle"};
}

const run=(mutate=()=>{})=>{const input=structuredClone(fixture());mutate(input);return verifyFurnitureFunction(input)},settle=evidence=>evidence.checks.find(entry=>entry.id==="settle-i1-r3-functional-placement"),compound=evidence=>evidence.checks.find(entry=>entry.id==="compound-collider-coverage");

test("accepts exact two-person settle semantics and proves the approved I1 r3 hearth placement",()=>{const input=fixture(),validated=validateFurnitureDesignContract(input.contract),evidence=verifyFurnitureFunction(input);assert.equal(validated.settle.backPartIds.length,2);assert.equal(evidence.verdict,"pass",JSON.stringify(evidence.checks.filter(entry=>!entry.passed),null,2));assert.deepEqual(settle(evidence).metrics,{applicable:true,approachErrorM:0,loadedStabilityMarginM:.346935235,occupancies:2,placements:1,ratedLoadKg:220})});

test("contract rejects missing semantics, wrong identities, sockets, and non-I1 dimensions",()=>{const cases=[input=>delete input.contract.settle,input=>input.contract.settle.backPartIds=[backs[0]],input=>input.contract.settle.armPartIds=[arms[0],arms[0]],input=>input.contract.sockets[0].position=[-.3,.46,-.05],input=>input.contract.sockets[2].facing=[0,0,-1],input=>input.contract.dimensions.widthM=1.59,input=>input.contract.settle.ratedLoadKg=301];for(const mutate of cases){const input=structuredClone(fixture());mutate(input);assert.throws(()=>validateFurnitureDesignContract(input.contract));}});

test("rejects non-continuous seat/back geometry and missing grounded load path",()=>{
  const narrow=run(input=>input.buildEvidence.glbValidation.partBounds.find(part=>part.id==="seat/main").bounds.max[0]=.4);assert.ok(settle(narrow).findings.some(value=>value.includes("continuous settle seat")));
  const back=run(input=>{input.buildEvidence.glbValidation.partBounds.find(part=>part.id===backs[0]).bounds.max[0]=-.2;input.buildEvidence.glbValidation.partBounds.find(part=>part.id===backs[1]).bounds.min[0]=.2});assert.ok(settle(back).findings.some(value=>value.includes("back support")));
  const floating=run(input=>input.buildEvidence.glbValidation.partBounds.find(part=>part.id===legs[0]).bounds.min[1]=.1);assert.ok(settle(floating).findings.some(value=>value.includes("grounded")));
  const disconnected=run(input=>input.contract.joints=input.contract.joints.filter(entry=>!entry.members.includes(legs[0])));assert.ok(settle(disconnected).findings.some(value=>value.includes("load path")));
});

test("rejects disconnected arms and an unstable or under-supported two-person load",()=>{
  const arm=run(input=>input.contract.joints=input.contract.joints.filter(entry=>entry.id!=="joint/left-arm-support"));assert.ok(settle(arm).findings.some(value=>value.includes("not joined")));
  const capacity=run(input=>input.approvedI1.plan.surfaceSockets[0].capacityKg=300);assert.ok(settle(capacity).findings.some(value=>value.includes("350kg")));
  const unstable=run(input=>{for(const id of legs){const part=input.buildEvidence.glbValidation.partBounds.find(entry=>entry.id===id);part.bounds.min[2]=-.01;part.bounds.max[2]=.01;}});assert.ok(settle(unstable).findings.some(value=>value.includes("stability margin")));
});

test("rejects I1 revision, transform, facing, socket-clearance, composition, and hearth drift",()=>{
  const cases=[
    [input=>{input.approvedI1.plan.planId="interior/functional-hall-house-v4/r2";input.approvedI1.artifact.artifactId=input.approvedI1.plan.planId},"exact approved I1 r3 dependency"],
    [input=>input.approvedI1.plan.placements[0].yawRadians+=.1,"drifted from"],
    [input=>input.approvedI1.plan.facingTargets[0].position=[-3,1,-3],"does not align"],
    [input=>input.approvedI1.plan.interactionClearances[1].center[0]+=.1,"occupancy socket"],
    [input=>input.approvedI1.plan.interactionClearances[0].center[2]+=.1,"front approach"],
    [input=>input.approvedI1.plan.placements[1].position=[.2,.09,2.2],"transformed runtime envelope intersects"],
    [input=>input.approvedI1.plan.hearthExclusions[0].center=[.8,.09,2.8],"hearth exclusion"],
  ];
  for(const [mutate,message] of cases){const evidence=run(mutate);assert.ok(settle(evidence).findings.some(value=>value.includes(message)),`${message}: ${JSON.stringify(settle(evidence).findings)}`);}
});

test("retains exact compound collider coverage for settle semantic parts",()=>{const evidence=run(input=>input.contract.colliders=input.contract.colliders.filter(entry=>!entry.covers.includes(backs[1])));assert.equal(compound(evidence).passed,false);assert.ok(compound(evidence).findings.some(value=>value.includes("has no plausible collider coverage")))});
