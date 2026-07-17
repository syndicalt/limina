import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import { validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";

const root=new URL("../../",import.meta.url),read=(path)=>fs.readFileSync(new URL(path,root)),text=(path)=>read(path).toString("utf8"),rawHash=(bytes)=>`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const authority=JSON.parse(text("assets/buildings/authoring/functional-hall-house-v4/shell-review-authority.json")),draft=validateBuildingStageArtifact(JSON.parse(text(authority.artifact.path))),evidence=JSON.parse(text(authority.buildEvidence.path));
const scene=text("js/src/render/staged-shell-review-scene.ts"),demo=text("js/src/demos/staged_shell_capture_window.ts"),runner=text("tools/preview/run-native-staged-shell-capture.mjs"),candidate=text("tools/architecture/build-shell-review-candidate.mjs"),asset=read(`assets/${authority.asset.assetId}`);

test("A1 authority closes over the exact immutable shell and build sources",()=>{
  assert.equal(rawHash(read(authority.artifact.path)),authority.artifact.sha256);assert.equal(portableAssetContentHash(read(authority.artifact.path)),authority.artifact.contentHash);
  assert.equal(rawHash(asset),authority.asset.sha256);assert.equal(portableAssetContentHash(asset),authority.asset.assetHash);assert.equal(draft.contentHash,authority.asset.sha256);
  assert.equal(draft.kind,"shell");assert.equal(draft.status,"draft");assert.equal(draft.evidence.length,0);assert.equal(draft.metadata.functional.doors,1);assert.equal(draft.metadata.functional.colliders,37);
  for(const [path,hash] of [[authority.buildEvidence.path,authority.buildEvidence.sha256],[authority.source.blendPath,authority.source.blendSha256],[authority.source.buildToolPath,authority.source.buildToolSha256],[authority.source.adapterPath,authority.source.adapterSha256],[authority.environment.authorityPath,authority.environment.authoritySha256],[authority.environment.bundlePath,authority.environment.bundleSha256]])assert.equal(rawHash(read(path)),hash,path);
  assert.equal(evidence.shellPayloadHash,authority.artifact.contractHash);assert.equal(evidence.asset.sha256,authority.asset.sha256);assert.deepEqual(evidence.functional,{buildingId:"hall-house/temperate/v4",rooms:1,portals:1,colliders:37,doors:1});assert.deepEqual(evidence.exclusions,{furniture:true,domesticProps:true,fireVisuals:true,practicalLights:true});
});

test("exact GLB remains an empty functional shell",()=>{
  const view=new DataView(asset.buffer,asset.byteOffset,asset.byteLength);assert.equal(view.getUint32(0,true),0x46546c67);const json=JSON.parse(new TextDecoder().decode(asset.subarray(20,20+view.getUint32(12,true))).trim());
  const ids=json.nodes.map(node=>node.extras?.limina?.id??node.extras?.["limina.id"]??node.name).filter(value=>typeof value==="string"),roles=json.nodes.map(node=>node.extras?.limina?.role);
  assert.equal(roles.filter(role=>role==="door").length,1);assert.equal(roles.filter(role=>role==="collider").length,37);
  assert.equal(ids.filter(id=>/^(?:furnishing|domestic-prop)\//.test(id)||/\/(?:flame|fuel|ember)(?:\/|$)/.test(id)).length,0);assert.equal(json.extensionsUsed?.includes("KHR_lights_punctual")??false,false);
});

test("review uses functional engine placement and an honest canonical A1 view set",()=>{
  assert.match(scene,/registry\.invoke\("building\.placeFunctional"/);assert.match(scene,/registry\.invoke\("door\.setOpen"/);assert.match(scene,/registry\.invoke\("building\.destroyFunctional"/);assert.doesNotMatch(scene,/asset\.place|parseGltfScene|loadGltfIntoScene/);assert.match(scene,/doors\.length!==authority\.functional\.doors\|\|parts\.length!==authority\.functional\.colliders/);
  assert.deepEqual(authority.evidenceViews.map(({id,state,renderLevel})=>({id,state,renderLevel})),[
    {id:"exterior-closed",state:"closed",renderLevel:"source-lod0"},{id:"exterior-open",state:"open",renderLevel:"source-lod0"},{id:"roof-chimney-bumpout-junction",state:"closed",renderLevel:"source-lod0"},{id:"dormer-eave",state:"closed",renderLevel:"source-lod0"},{id:"threshold-stair-grade",state:"open",renderLevel:"source-lod0"},{id:"empty-interior-traversal",state:"open",renderLevel:"source-lod0"},{id:"hearth-structure",state:"open",renderLevel:"source-lod0"},{id:"lod-25m",state:"closed",renderLevel:"source-lod0"},
  ]);assert.equal(authority.evidenceViews.at(-1).role,"source-lod0-distance-silhouette-proof");assert.ok(authority.evidenceViews.at(-1).distanceM>=25);
});

test("native harness is bounded, paired, timestamp-disabled and never a generic mount",()=>{
  assert.match(demo,/createEngine\(\{ width: minimumWidth, height: minimumHeight, gpuTimestampMode: "disabled"/);assert.match(demo,/loadTemperateFidelityCandidate/);assert.match(demo,/mountTemperateFidelityScene/);assert.match(demo,/mountStagedShellReview/);assert.match(demo,/requireWholeFrameRenderSubmissionTelemetry/);assert.match(demo,/requirePairedRenderSubmissionTelemetry\(baselineSubmission, submission, 16\)/);assert.match(demo,/mounted!\.setRenderVisible\(false\)/);assert.match(demo,/lifecycleEvidence: Object\.freeze\(\{ cycles: 2/);assert.match(demo,/exact-staged-shell-has-no-packaged-lod-roots/);assert.doesNotMatch(demo,/asset\.place|setLodLevel|timestamp-query|requiredFeatures/);
  assert.match(runner,/current boot already contains an NVIDIA Xid/);assert.match(runner,/capture stopped and must not be retried before reboot/);assert.match(runner,/setInterval\([\s\S]*kernelLog\(\)[\s\S]*250/);assert.match(runner,/delete captureEnv\.LIMINA_GPU_TIMESTAMP_RISK_ACK/);assert.match(runner,/delete captureEnv\.LIMINA_GPU_TIMESTAMP_MODE/);assert.match(runner,/delete captureEnv\.LIMINA_GPU_TIMESTAMP_QUERIES/);assert.match(runner,/LIMINA_STAGED_SHELL_AUTHORITY: authorityPath/);assert.match(demo,/op_read_env\("LIMINA_STAGED_SHELL_AUTHORITY"\) \|\| DEFAULT_AUTHORITY_PATH/);assert.match(runner,/value\("--authority",defaultAuthorityPath\)/);assert.match(runner,/value\("--out-dir",defaultReviewPath\)/);assert.match(runner,/revised staged shell capture requires an explicit fresh --out-dir/);assert.match(runner,/flag:appendOnly\?"wx":"w"/);assert.match(runner,/authority\.evidenceViews\[index\]/);assert.match(runner,/assets\/qc\/internal\/shell\/functional-hall-house-v4/);assert.match(runner,/width:capture\.width, height:capture\.height, timestamp:new Date\(\)\.toISOString\(\)/);assert.match(runner,/chmod\(reviewDirectory,0o700\)/);assert.match(runner,/chmod\(captureOutput,0o600\)/);assert.match(runner,/await unlink\(tracePath\)/);assert.doesNotMatch(runner,/LIMINA_NATIVE_CAPTURE_OUTPUT|dgx-spark-review-bridge|asset\.place/);
  assert.match(runner,/parseFunctionalBuildingContract\(assetBytes\)/);assert.match(runner,/buildable authored entrance-support evidence/);
});

test("candidate builder accepts only the complete guarded output shape and preserves A1 facets",()=>{
  const directory=fs.mkdtempSync(resolve(tmpdir(),"limina-shell-review-")),authorityPath=resolve(directory,"authority.json"),capturePath=resolve(directory,"capture.json"),outputPath=resolve(directory,"candidate.json"),repo=resolve(new URL("../../",import.meta.url).pathname),timestamp="2026-07-15T12:00:00.000Z";
  fs.writeFileSync(authorityPath,JSON.stringify(authority));const authorityBytes=fs.readFileSync(authorityPath),authorityPathPortable=relative(repo,authorityPath).split(sep).join("/");
  const capture={schema:"limina.staged-shell-native-review-set/v1",backend:"native-webgpu",captureClass:"production-engine",authority:{path:authorityPathPortable,sha256:rawHash(authorityBytes)},asset:authority.asset,timingPolicy:{gpuTimestampMode:"disabled",timestampQueriesEnabled:false},functionalPlacement:{parts:37},functionalInventory:authority.functional,exclusions:authority.exclusions,renderPolicy:{level:"source-lod0",reason:"exact-staged-shell-has-no-packaged-lod-roots"},guardEvidence:{schema:"limina.nvidia-xid-guard/v1",preflight:{xidObserved:false},live:{xidObserved:false},postflight:{xidObserved:false}},outputs:authority.evidenceViews.map((view,index)=>({id:view.id,state:view.state,role:view.role,pngSha256:`sha256:${String(index+1).padStart(64,"0")}`,width:1920,height:1080,timestamp}))};
  fs.writeFileSync(capturePath,JSON.stringify(capture));const result=spawnSync(process.execPath,[new URL("../architecture/build-shell-review-candidate.mjs",import.meta.url).pathname,"--authority",authorityPath,"--capture",capturePath,"--draft",new URL(`../../${authority.artifact.path}`,import.meta.url).pathname,"--out",outputPath],{encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);const built=validateBuildingStageArtifact(JSON.parse(fs.readFileSync(outputPath,"utf8")));assert.equal(built.status,"candidate");assert.deepEqual(built.facets,draft.facets);assert.equal(built.evidence.length,8);assert.ok(built.evidence.every(entry=>entry.width===1920&&entry.height===1080&&entry.timestamp===timestamp));assert.equal(built.metadata.humanDecision,"pending");
  delete capture.outputs[0].width;fs.writeFileSync(capturePath,JSON.stringify(capture));const incomplete=spawnSync(process.execPath,[new URL("../architecture/build-shell-review-candidate.mjs",import.meta.url).pathname,"--authority",authorityPath,"--capture",capturePath,"--draft",new URL(`../../${authority.artifact.path}`,import.meta.url).pathname,"--out",outputPath],{encoding:"utf8"});assert.notEqual(incomplete.status,0,"candidate builder accepted evidence without dimensions");fs.rmSync(directory,{recursive:true,force:true});
});

test("revised candidate derives counts and roles from authority and refuses overwrite",()=>{
  const directory=fs.mkdtempSync(resolve(tmpdir(),"limina-shell-r2-review-")),repo=resolve(new URL("../../",import.meta.url).pathname),draftPath=resolve(directory,"draft-r2.json"),authorityPath=resolve(directory,"authority-r2.json"),capturePath=resolve(directory,"capture-r2.json"),outputPath=resolve(directory,"candidate-r2.json");
  try{
    const r2Draft={...draft,artifactId:"shell/functional-hall-house-v4/r2",revision:2,status:"draft",evidence:[]};
    fs.writeFileSync(draftPath,JSON.stringify(r2Draft));
    const r2Authority={...authority,artifact:{...authority.artifact,path:relative(repo,draftPath).split(sep).join("/"),artifactId:r2Draft.artifactId},functional:{...authority.functional,colliders:41}};
    fs.writeFileSync(authorityPath,JSON.stringify(r2Authority));const authorityBytes=fs.readFileSync(authorityPath),authorityPortable=relative(repo,authorityPath).split(sep).join("/");
    const capture={schema:"limina.staged-shell-native-review-set/v1",backend:"native-webgpu",captureClass:"production-engine",authority:{path:authorityPortable,sha256:rawHash(authorityBytes)},asset:r2Authority.asset,timingPolicy:{gpuTimestampMode:"disabled",timestampQueriesEnabled:false},functionalPlacement:{parts:r2Authority.functional.colliders},functionalInventory:r2Authority.functional,exclusions:r2Authority.exclusions,renderPolicy:{level:"source-lod0",reason:"exact-staged-shell-has-no-packaged-lod-roots"},guardEvidence:{schema:"limina.nvidia-xid-guard/v1",preflight:{xidObserved:false},live:{xidObserved:false},postflight:{xidObserved:false}},outputs:r2Authority.evidenceViews.map((view,index)=>({id:view.id,state:view.state,role:view.role,pngSha256:`sha256:${String(index+11).padStart(64,"0")}`,width:1920,height:1080}))};
    fs.writeFileSync(capturePath,JSON.stringify(capture));const command=[new URL("../architecture/build-shell-review-candidate.mjs",import.meta.url).pathname,"--authority",authorityPath,"--capture",capturePath,"--draft",draftPath,"--out",outputPath];
    const first=spawnSync(process.execPath,command,{encoding:"utf8"});assert.equal(first.status,0,first.stderr);
    const second=spawnSync(process.execPath,command,{encoding:"utf8"});assert.notEqual(second.status,0,"r2 candidate overwrote an existing path");assert.match(second.stderr,/EEXIST|file already exists/);
    capture.outputs[0].role="wrong-role";fs.rmSync(outputPath);fs.writeFileSync(capturePath,JSON.stringify(capture));const drifted=spawnSync(process.execPath,command,{encoding:"utf8"});assert.notEqual(drifted.status,0,"candidate accepted a role not bound by authority");
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
