import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { validateBuildingHitlDecision, validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";

const repo=resolve(import.meta.dirname,"../.."),candidate="assets/qc/internal/materials/functional-hall-house-v4/m1-r1/review-candidate.json",shell="assets/buildings/authoring/functional-hall-house-v4/shell-artifact-approved.json";
const run=(script,args)=>spawnSync(process.execPath,[script,...args],{cwd:repo,encoding:"utf8"});

test("dependent M1 review and promotion require the exact approved shell in the invalidation graph",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"limina-m1-decision-"));
  try{
    const candidateArtifact=validateBuildingStageArtifact(JSON.parse(await readFile(resolve(repo,candidate),"utf8")));
    const candidateEvidenceBindings=candidateArtifact.evidence.map(({evidenceId,contentHash})=>({evidenceId,contentHash}));
    const decision=join(directory,"decision.json"),approved=join(directory,"approved.json"),base=["--candidate",candidate,"--out",decision,"--decision","approve"];
    const missing=run("tools/architecture/record-building-stage-review-decision.mjs",base);assert.notEqual(missing.status,0);assert.match(missing.stderr,/stale building artifact/);
    const recorded=run("tools/architecture/record-building-stage-review-decision.mjs",[...base,"--dependency",shell]);assert.equal(recorded.status,0,recorded.stderr);const exactDecision=validateBuildingHitlDecision(JSON.parse(await readFile(decision,"utf8")));assert.equal(exactDecision.gate,"M1-materials");assert.equal(exactDecision.decision,"approve");assert.deepEqual(exactDecision.evidenceBindings,candidateEvidenceBindings);
    const missingPromotion=run("tools/architecture/promote-building-artifact.mjs",["--candidate",candidate,"--decision",decision,"--out",approved]);assert.notEqual(missingPromotion.status,0);assert.match(missingPromotion.stderr,/stale building artifact/);
    const promoted=run("tools/architecture/promote-building-artifact.mjs",["--candidate",candidate,"--decision",decision,"--out",approved,"--dependency",shell]);assert.equal(promoted.status,0,promoted.stderr);const artifact=validateBuildingStageArtifact(JSON.parse(await readFile(approved,"utf8")));assert.equal(artifact.status,"approved");assert.equal(artifact.metadata.humanDecision,"approved");assert.equal(artifact.inputs[0].artifactId,"shell/functional-hall-house-v4/r1");
  }finally{await rm(directory,{recursive:true,force:true});}
});
