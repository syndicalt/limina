import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertBuildingArtifactReviewable, validateBuildingHitlDecision, validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import { validateStagedMaterialReviewAuthority } from "../../js/src/render/staged-material-review-scene.ts";

const root=new URL("../../",import.meta.url),candidatePath=new URL("assets/qc/internal/materials/functional-hall-house-v4/m1-r1/review-candidate.json",root),capturePath=new URL("assets/qc/internal/materials/functional-hall-house-v4/m1-r1/capture-evidence.json",root),authorityPath=new URL("assets/buildings/authoring/functional-hall-house-v4/material-review-authority.json",root),shellPath=new URL("assets/buildings/authoring/functional-hall-house-v4/shell-artifact-approved.json",root);
const [candidateBytes,captureBytes,authorityBytes,shellBytes]=await Promise.all([readFile(candidatePath),readFile(capturePath),readFile(authorityPath),readFile(shellPath)]),candidate=validateBuildingStageArtifact(JSON.parse(candidateBytes)),capture=JSON.parse(captureBytes),authority=validateStagedMaterialReviewAuthority(JSON.parse(authorityBytes)),shell=validateBuildingStageArtifact(JSON.parse(shellBytes)),sha=(bytes)=>`sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("exact M1 candidate binds the guarded four-view native evidence set",()=>{
  assert.equal(candidate.kind,"material-palette");assert.equal(candidate.status,"candidate");assert.equal(candidate.artifactId,authority.stageArtifact.artifactId);assert.equal(candidate.contentHash,authority.derived.sha256);assert.equal(candidate.metadata.humanDecision,"pending");
  assert.equal(candidate.metadata.authorityPath,"assets/buildings/authoring/functional-hall-house-v4/material-review-authority.json");assert.equal(candidate.metadata.captureEvidencePath,"assets/qc/internal/materials/functional-hall-house-v4/m1-r1/capture-evidence.json");
  assert.deepEqual(candidate.evidence.map(({contentHash})=>contentHash),capture.outputs.map(({pngSha256})=>pngSha256));assert.deepEqual(candidate.evidence.map(({width,height})=>[width,height]),Array(4).fill([1920,1080]));
  assert.equal(capture.authority.sha256,sha(authorityBytes));assert.equal(capture.guardEvidence.preflight.xidObserved,false);assert.equal(capture.guardEvidence.live.xidObserved,false);assert.equal(capture.guardEvidence.postflight.xidObserved,false);assert.deepEqual(capture.timingPolicy,{gpuTimestampMode:"disabled",timestampQueriesEnabled:false});
});

test("a future M1 decision is reviewable only when it binds every exact PNG hash",()=>{
  const decision=validateBuildingHitlDecision({schema:"limina.building-hitl-decision/v1",decisionId:`${candidate.artifactId}/approve-user-r1`,gate:"M1-materials",artifactId:candidate.artifactId,contractHash:candidate.contractHash,contentHash:candidate.contentHash,reviewer:"user",timestamp:"2026-07-15T07:42:45.000Z",decision:"approve",evidenceHashes:candidate.evidence.map(({contentHash})=>contentHash),blockingFindings:[],observations:[],markedRegions:[]});
  assert.throws(()=>assertBuildingArtifactReviewable(candidate,decision,[candidate]),/stale building artifact/);
  assert.equal(assertBuildingArtifactReviewable(candidate,decision,[shell,candidate]).decision.decision,"approve");
  const stale=structuredClone(decision);stale.evidenceHashes=stale.evidenceHashes.slice(1);assert.throws(()=>assertBuildingArtifactReviewable(candidate,stale,[shell,candidate]),/complete evidence set/);
});
