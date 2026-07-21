import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import { validateStagedShellReviewAuthority } from "../../js/src/render/staged-shell-review-scene.ts";
import { buildShellReviewAuthority } from "./build-shell-review-authority.mjs";
import { buildShellStageArtifact } from "./build-shell-stage-artifact.mjs";

const repo=resolve(import.meta.dirname,"../.."),base="assets/buildings/authoring/functional-hall-house-v4",evidence=`${base}/shell.evidence.json`,r1Artifact=`${base}/shell-artifact-draft.json`,r1Authority=`${base}/shell-review-authority.json`,sha=(bytes)=>createHash("sha256").update(bytes).digest("hex");

test("r1 defaults remain byte-reproducible while r2 artifact and authority are append-only",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"limina-shell-r2-tooling-"));
  try{
    const [r1ArtifactBefore,r1AuthorityBefore]=await Promise.all([readFile(resolve(repo,r1Artifact)),readFile(resolve(repo,r1Authority))]);
    const rebuiltR1=join(directory,"shell-artifact-r1.json");await buildShellStageArtifact({repoRoot:repo,evidencePath:evidence,outputPath:rebuiltR1});
    assert.deepEqual(await readFile(rebuiltR1),r1ArtifactBefore,"r1 artifact defaults changed");
    const rebuiltAuthority=join(directory,"shell-review-authority-r1.json");await buildShellReviewAuthority({repoRoot:repo,artifactPath:r1Artifact,buildEvidencePath:evidence,outputPath:rebuiltAuthority});
    assert.deepEqual(JSON.parse(await readFile(rebuiltAuthority,"utf8")),JSON.parse(r1AuthorityBefore.toString()),"r1 authority defaults changed");

    const r2ArtifactPath=join(directory,"shell-artifact-r2-draft.json"),r2AuthorityPath=join(directory,"shell-review-authority-r2.json");
    const r2=await buildShellStageArtifact({repoRoot:repo,evidencePath:evidence,outputPath:r2ArtifactPath,artifactId:"shell/functional-hall-house-v4/r2",revision:2});
    assert.equal(r2.artifactId,"shell/functional-hall-house-v4/r2");assert.equal(r2.revision,2);assert.equal(r2.supersedes,"shell/functional-hall-house-v4/r1");assert.equal(r2.status,"draft");assert.equal(r2.evidence.length,0);
    const authority=await buildShellReviewAuthority({repoRoot:repo,artifactPath:r2ArtifactPath,buildEvidencePath:evidence,outputPath:r2AuthorityPath});
    validateBuildingStageArtifact(JSON.parse(await readFile(r2ArtifactPath,"utf8")));validateStagedShellReviewAuthority(JSON.parse(await readFile(r2AuthorityPath,"utf8")));
    assert.equal(authority.artifact.artifactId,r2.artifactId);assert.equal(authority.artifact.assetContentHash,r2.contentHash);assert.notEqual(authority.artifact.path,r1Artifact);
    const relocatedPath=join(directory,"shell-review-authority-r2-relocated.json"),relocated=await buildShellReviewAuthority({repoRoot:repo,artifactPath:r2ArtifactPath,buildEvidencePath:evidence,outputPath:relocatedPath,reviewPlacement:{position:[17.6,0,76.1],yaw:5.1749012322}});
    assert.deepEqual(relocated.placement,{position:[17.6,0,76.1],yaw:5.1749012322});assert.deepEqual(relocated.evidenceViews.map(view=>view.distanceM),authority.evidenceViews.map(view=>view.distanceM));assert.notDeepEqual(relocated.evidenceViews[0].camera.position,authority.evidenceViews[0].camera.position);
    await assert.rejects(()=>buildShellStageArtifact({repoRoot:repo,evidencePath:evidence,outputPath:r2ArtifactPath,artifactId:"shell/functional-hall-house-v4/r2",revision:2}),error=>error?.code==="EEXIST");
    await assert.rejects(()=>buildShellReviewAuthority({repoRoot:repo,artifactPath:r2ArtifactPath,buildEvidencePath:evidence,outputPath:r2AuthorityPath}),error=>error?.code==="EEXIST");
    assert.equal(sha(await readFile(resolve(repo,r1Artifact))),sha(r1ArtifactBefore));assert.equal(sha(await readFile(resolve(repo,r1Authority))),sha(r1AuthorityBefore));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test("shell revision tooling rejects inconsistent artifact ids and revisions",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"limina-shell-revision-reject-"));
  try{await assert.rejects(()=>buildShellStageArtifact({repoRoot:repo,evidencePath:evidence,outputPath:join(directory,"bad.json"),artifactId:"shell/functional-hall-house-v4/r2",revision:1}),/same positive append-only revision/);}
  finally{await rm(directory,{recursive:true,force:true});}
});
