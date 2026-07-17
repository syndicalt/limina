import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { validateBuildingInteriorPlanV2 } from "../../js/src/assets/building-interior-plan-v2.mjs";
import { validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import { interiorLocalNegativeZForward } from "../../js/src/render/staged-interior-proxy-review-scene.ts";
import { buildInteriorPlanStage, interiorArchetypePlacementFacetHash } from "./build-interior-plan-stage.mjs";

const repo=resolve(import.meta.dirname,"../.."),r1PlanPath=resolve(repo,"assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-plan.json");
const digest=(bytes)=>createHash("sha256").update(bytes).digest("hex"),byId=(plan,id)=>plan.placements.find((entry)=>entry.id===id),facet=(artifact,scope)=>artifact.facets.find((entry)=>entry.scope===scope)?.hash;

test("preserves the exact approved r1 canonical bytes and legacy validation",async()=>{
  const approvedBytes=await readFile(r1PlanPath),built=await buildInteriorPlanStage({repoRoot:repo,revision:1,write:false});
  assert.deepEqual(built.planBytes,approvedBytes);assert.equal(digest(built.planBytes),"43c2ca0b29ca8b384b000628fe91e927e2b3748331f5db8fcb85fc4cbe36c9e9");
  assert.equal(validateBuildingInteriorPlanV2(JSON.parse(approvedBytes)).revision,1);
});

test("r2 validates and changes only revision identity plus west/east chair yaw",async()=>{
  const r1=(await buildInteriorPlanStage({repoRoot:repo,revision:1,write:false})).plan,r2Result=await buildInteriorPlanStage({repoRoot:repo,revision:2,write:false}),r2=validateBuildingInteriorPlanV2(r2Result.plan),artifact=validateBuildingStageArtifact(r2Result.artifact);
  assert.equal(r2.planId,"interior/functional-hall-house-v4/r2");assert.equal(r2.revision,2);assert.equal(r2.supersedes,r1.planId);assert.equal(artifact.supersedes,r1.planId);assert.equal(artifact.status,"draft");
  const normalized=structuredClone(r2);normalized.planId=r1.planId;normalized.revision=1;normalized.supersedes=null;byId(normalized,"placement/dining-chair-west").yawRadians=byId(r1,"placement/dining-chair-west").yawRadians;byId(normalized,"placement/dining-chair-east").yawRadians=byId(r1,"placement/dining-chair-east").yawRadians;assert.deepEqual(normalized,r1);
  assert.equal(byId(r2,"placement/dining-chair-west").yawRadians,-Math.PI/2);assert.equal(byId(r2,"placement/dining-chair-east").yawRadians,Math.PI/2);
  assert.deepEqual(artifact.metadata.yawConventionMigration,{from:"legacy-atan2-dx-negative-dz",to:"engine-three-local-negative-z-atan2-negative-dx-negative-dz",changedPlacementIds:["placement/dining-chair-west","placement/dining-chair-east"]});
  assert.deepEqual(r2.dependencies,r1.dependencies);
});

test("archetype placement facets isolate the chair correction",async()=>{
  const r1=await buildInteriorPlanStage({repoRoot:repo,revision:1,write:false}),r2=await buildInteriorPlanStage({repoRoot:repo,revision:2,write:false});
  assert.ok(facet(r2.artifact,"placements/proxy/dining-table"));assert.ok(facet(r2.artifact,"placements/proxy/dining-chair"));
  assert.equal(interiorArchetypePlacementFacetHash("proxy/dining-table",r1.plan),facet(r2.artifact,"placements/proxy/dining-table"));
  assert.notEqual(interiorArchetypePlacementFacetHash("proxy/dining-chair",r1.plan),facet(r2.artifact,"placements/proxy/dining-chair"));
  assert.notEqual(facet(r1.artifact,"placements"),facet(r2.artifact,"placements"));
});

test("r2 visible local-negative-Z facing markers point every dining chair at the table",async()=>{
  const {plan}=await buildInteriorPlanStage({repoRoot:repo,revision:2,write:false}),target=plan.facingTargets.find((entry)=>entry.id==="facing/dining-table");
  for(const placement of plan.placements.filter((entry)=>entry.archetypeId==="proxy/dining-chair")){
    const forward=interiorLocalNegativeZForward(placement.yawRadians),dx=target.position[0]-placement.position[0],dz=target.position[2]-placement.position[2],length=Math.hypot(dx,dz);
    assert.ok((forward[0]*dx+forward[1]*dz)/length>.999999,`${placement.id} facing marker misses dining table`);
  }
});

test("writes r2 append-only to an isolated path and invokes no GPU tooling",async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),"limina-i1-r2-")),planOutputPath=resolve(directory,"interior-r2/interior-plan.json"),artifactOutputPath=resolve(directory,"interior-r2/interior-plan-artifact-draft.json");
  try{const result=await buildInteriorPlanStage({repoRoot:repo,revision:2,planOutputPath,artifactOutputPath});assert.deepEqual(JSON.parse(await readFile(planOutputPath)),result.plan);assert.deepEqual(JSON.parse(await readFile(artifactOutputPath)),result.artifact);await assert.rejects(buildInteriorPlanStage({repoRoot:repo,revision:2,planOutputPath,artifactOutputPath}),/EEXIST/);const source=await readFile(new URL("./build-interior-plan-stage.mjs",import.meta.url),"utf8");assert.doesNotMatch(source,/nvidia-smi|vulkan|webgpu|capture|render/i);}finally{await rm(directory,{recursive:true,force:true});}
});
