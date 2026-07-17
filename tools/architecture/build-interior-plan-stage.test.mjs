import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { validateBuildingInteriorPlanV2 } from "../../js/src/assets/building-interior-plan-v2.mjs";
import { BUILDING_STAGE_FACETS, validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import { buildInteriorPlanStage } from "./build-interior-plan-stage.mjs";
import { interiorArchetypePlacementFacetHash } from "./build-interior-plan-stage.mjs";

const repo=resolve(import.meta.dirname,"../..");

test("builds exact shell-r4/M1-r2 proxy-only I1 closure without writing by default in the test",async()=>{
  const result=await buildInteriorPlanStage({repoRoot:repo,write:false}),plan=validateBuildingInteriorPlanV2(result.plan),artifact=validateBuildingStageArtifact(result.artifact);
  assert.equal(plan.planId,"interior/functional-hall-house-v4/r1");assert.equal(plan.dependencies.shell.artifactId,"shell/functional-hall-house-v4/r4");assert.equal(plan.dependencies.materials.artifactId,"materials/functional-hall-house-v4/r2");
  assert.deepEqual(plan.rooms[0].floorRegions.map(({id})=>id),["floor-region/main-usable","floor-region/passage-bridge","floor-region/service-usable"]);
  assert.deepEqual(plan.requiredZoneIds,["zone/entry","zone/dining","zone/hearth-seating","zone/service-storage","zone/circulation"]);assert.equal(plan.zones.some(({id})=>id.includes("sleep")),false);
  assert.equal(plan.placements.filter(({archetypeId})=>archetypeId==="proxy/dining-table").length,1);assert.equal(plan.placements.filter(({archetypeId})=>archetypeId==="proxy/dining-chair").length,4);
  assert.equal(plan.placements.filter(({zoneId})=>zoneId==="zone/hearth-seating").length,1);assert.equal(plan.proxyArchetypes.find(({id})=>id==="proxy/dining-table").requiresApproach,true);assert.equal(plan.proxyArchetypes.find(({id})=>id==="proxy/storage-shelf").requiresApproach,true);
  assert.ok(plan.interactionClearances.some(({placementId,kind})=>placementId==="placement/hearth-settle"&&kind==="approach"));assert.ok(plan.interactionClearances.some(({placementId,kind})=>placementId==="placement/hearth-settle"&&kind==="occupancy"));assert.ok(plan.interactionClearances.some(({placementId,kind})=>placementId==="placement/dining-table"&&kind==="approach"));assert.ok(plan.interactionClearances.some(({placementId,kind})=>placementId==="placement/service-storage"&&kind==="approach"));
  assert.deepEqual(plan.doorSweeps[0],{id:"door-sweep/front",roomId:"room/main",doorId:"door/front",hinge:[-1.44,.09,-3.66],radiusM:1.44,leafThicknessM:.11,heightM:2.48,closedYawRadians:0,openYawRadians:-1.6580627893946132});assert.deepEqual(plan.hearthExclusions[0],{id:"hearth-exclusion/hall-hearth",roomId:"room/main",hearthId:"hall-hearth",center:[2.95,.09,2.58],halfExtents:[.88,.98],yawRadians:Math.PI,minimumClearanceM:.8,heightM:2.3});
  assert.ok(plan.navigation.edges.some(({id})=>id==="nav-edge/circulation-dining"),"dining navigation edge was omitted");
  assert.deepEqual(artifact.facets.map(({scope})=>scope),BUILDING_STAGE_FACETS["interior-plan"]);assert.equal(artifact.contractHash,result.planHash);assert.equal(artifact.status,"draft");assert.equal(artifact.metadata.proxyOnly,true);assert.equal(artifact.metadata.approvedMaterials.derivedGlbSha256,"sha256:5d973e3f6e0dcc0a150c5f08e58682aae22d3af87808e78f1ef3844209150b88");
});

test("writes append-safe r1 plan and artifact only when invoked with output paths",async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),"limina-i1-stage-")),planOutputPath=resolve(directory,"interior-r1/plan.json"),artifactOutputPath=resolve(directory,"interior-r1/artifact.json");
  try{const result=await buildInteriorPlanStage({repoRoot:repo,planOutputPath,artifactOutputPath});assert.deepEqual(JSON.parse(await readFile(planOutputPath,"utf8")),result.plan);assert.deepEqual(validateBuildingStageArtifact(JSON.parse(await readFile(artifactOutputPath,"utf8"))),result.artifact);await assert.rejects(buildInteriorPlanStage({repoRoot:repo,planOutputPath,artifactOutputPath}),/EEXIST/);}finally{await rm(directory,{recursive:true,force:true});}
});

test("r3 changes only the hearth-settle placement closure and preserves exact r2 bytes",async()=>{
  const r2=await buildInteriorPlanStage({repoRoot:repo,revision:2,write:false}),r3=await buildInteriorPlanStage({repoRoot:repo,revision:3,write:false}),existingR2=await readFile(resolve(repo,"assets/buildings/authoring/functional-hall-house-v4/interior-r2/interior-plan.json"));
  assert.deepEqual(r2.planBytes,existingR2,"the append-only producer changed approved r2 plan bytes");
  assert.equal(r3.plan.planId,"interior/functional-hall-house-v4/r3");assert.equal(r3.plan.supersedes,"interior/functional-hall-house-v4/r2");assert.equal(r3.artifact.supersedes,"interior/functional-hall-house-v4/r2");

  const settle=r3.plan.placements.find(({id})=>id==="placement/hearth-settle"),target=r3.plan.facingTargets.find(({id})=>id==="facing/hall-hearth");assert.equal(settle.yawRadians,-1.750649826587375);
  const forward=[-Math.sin(settle.yawRadians),-Math.cos(settle.yawRadians)],delta=[target.position[0]-settle.position[0],target.position[2]-settle.position[2]],length=Math.hypot(...delta);assert.ok(Math.abs((forward[0]*delta[0]+forward[1]*delta[1])/length-1)<1e-12,"settle local -Z does not face the hearth exactly");
  assert.equal(r3.plan.surfaceSockets.find(({id})=>id==="socket/floor/hearth-settle").capacityKg,350);
  const clearances=r3.plan.interactionClearances.filter(({placementId})=>placementId===settle.id);assert.deepEqual(clearances,[
    {id:"clearance/approach/hearth-settle",kind:"approach",placementId:settle.id,roomId:"room/main",center:[1.0362894235849214,.09,2.352052622469986],radiusM:.35,heightM:1.9},
    {id:"clearance/occupancy/hearth-settle-left",kind:"occupancy",placementId:settle.id,roomId:"room/main",center:[.30643683572899,.09,1.894105900678029],radiusM:.3,heightM:1.5},
    {id:"clearance/occupancy/hearth-settle-right",kind:"occupancy",placementId:settle.id,roomId:"room/main",center:[.19195015528100076,.09,2.5237826431419697],radiusM:.3,heightM:1.5},
  ]);
  assert.deepEqual(r3.artifact.metadata.yawConventionMigration,{from:"legacy-positive-yaw-hearth-settle",to:"engine-three-local-negative-z-facing-target",changedPlacementIds:["placement/hearth-settle"]});

  const nonHearth=(plan)=>{const value=structuredClone(plan);value.planId="revision-neutral";value.revision=0;value.supersedes=null;value.placements=value.placements.filter(({id})=>id!==settle.id);value.interactionClearances=value.interactionClearances.filter(({placementId})=>placementId!==settle.id);value.surfaceSockets=value.surfaceSockets.filter(({id})=>id!=="socket/floor/hearth-settle");return value;};assert.deepEqual(nonHearth(r3.plan),nonHearth(r2.plan));
  for(const archetypeId of ["proxy/dining-table","proxy/dining-chair","proxy/storage-shelf"])assert.equal(interiorArchetypePlacementFacetHash(archetypeId,r3.plan),interiorArchetypePlacementFacetHash(archetypeId,r2.plan),`${archetypeId} facet drifted in r3`);assert.notEqual(interiorArchetypePlacementFacetHash("proxy/hearth-settle",r3.plan),interiorArchetypePlacementFacetHash("proxy/hearth-settle",r2.plan));
});

test("r4 places the settle in front of and parallel to the hearth with exact interaction and navigation proof",async()=>{
  const r4=await buildInteriorPlanStage({repoRoot:repo,revision:4,write:false}),settle=r4.plan.placements.find(({id})=>id==="placement/hearth-settle"),socket=r4.plan.surfaceSockets.find(({id})=>id==="socket/floor/hearth-settle"),zone=r4.plan.zones.find(({id})=>id==="zone/hearth-seating");
  assert.equal(r4.plan.planId,"interior/functional-hall-house-v4/r4");assert.equal(r4.plan.supersedes,"interior/functional-hall-house-v4/r3");assert.equal(r4.artifact.supersedes,"interior/functional-hall-house-v4/r3");
  assert.deepEqual(settle.position,[2.95,.09,-.9]);assert.equal(settle.yawRadians,Math.PI);assert.deepEqual(socket.position,settle.position);assert.equal(socket.capacityKg,350);assert.deepEqual(zone.bounds,{center:[2.65,1.74,-.3],halfExtents:[1.2,1.66,1.1]});
  const target=r4.plan.facingTargets.find(({id})=>id===settle.facingTargetId),forward=[-Math.sin(settle.yawRadians),-Math.cos(settle.yawRadians)],delta=[target.position[0]-settle.position[0],target.position[2]-settle.position[2]],length=Math.hypot(...delta);assert.ok((forward[0]*delta[0]+forward[1]*delta[1])/length>.999999,"settle local -Z does not face the hearth");
  assert.deepEqual(r4.plan.interactionClearances.filter(({placementId})=>placementId===settle.id),[
    {id:"clearance/approach/hearth-settle",kind:"approach",placementId:settle.id,roomId:"room/main",center:[2.95,.09,-.05],radiusM:.35,heightM:1.9},
    {id:"clearance/occupancy/hearth-settle-left",kind:"occupancy",placementId:settle.id,roomId:"room/main",center:[3.27,.09,-.85],radiusM:.3,heightM:1.5},
    {id:"clearance/occupancy/hearth-settle-right",kind:"occupancy",placementId:settle.id,roomId:"room/main",center:[2.63,.09,-.85],radiusM:.3,heightM:1.5},
  ]);
  assert.deepEqual(r4.plan.navigation.nodes.filter(({id})=>id==="nav/hearth-turn"||id==="nav/hearth-seating"),[
    {id:"nav/hearth-turn",roomId:"room/main",zoneId:null,position:[.7,.09,0]},
    {id:"nav/hearth-seating",roomId:"room/main",zoneId:"zone/hearth-seating",position:[1.6,.09,0]},
  ]);
  assert.ok(r4.plan.navigation.edges.some(({id,fromNodeId,toNodeId,halfWidthM})=>id==="nav-edge/hearth-turn-seating"&&fromNodeId==="nav/hearth-turn"&&toNodeId==="nav/hearth-seating"&&halfWidthM===.5));
  assert.deepEqual(r4.artifact.metadata.yawConventionMigration,{from:"side-staged-hearth-settle",to:"front-facing-wall-parallel-hearth-settle",changedPlacementIds:["placement/hearth-settle"]});
});

test("r4 generation preserves the exact approved r3 plan and draft bytes",async()=>{
  const r3=await buildInteriorPlanStage({repoRoot:repo,revision:3,write:false}),existingPlan=await readFile(resolve(repo,"assets/buildings/authoring/functional-hall-house-v4/interior-r3/interior-plan.json")),existingDraft=await readFile(resolve(repo,"assets/buildings/authoring/functional-hall-house-v4/interior-r3/interior-plan-artifact-draft.json"));
  assert.deepEqual(r3.planBytes,existingPlan,"the append-only producer changed approved r3 plan bytes");assert.deepEqual(Buffer.from(`${JSON.stringify(r3.artifact,null,2)}\n`),existingDraft,"the append-only producer changed approved r3 draft bytes");
  await buildInteriorPlanStage({repoRoot:repo,revision:4,write:false});
  assert.deepEqual(await readFile(resolve(repo,"assets/buildings/authoring/functional-hall-house-v4/interior-r3/interior-plan.json")),existingPlan);assert.deepEqual(await readFile(resolve(repo,"assets/buildings/authoring/functional-hall-house-v4/interior-r3/interior-plan-artifact-draft.json")),existingDraft);
});
