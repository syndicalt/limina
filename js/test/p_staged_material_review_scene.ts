import assert from "node:assert/strict";
import test from "node:test";
import { materialRoleForPack, validateStagedMaterialReviewAuthority } from "../src/render/staged-material-review-scene.ts";

const h=(d:string)=>`sha256:${d.repeat(64)}`;
const file=(path:string,d:string)=>({path,sha256:h(d),contentHash:h(d)});
const camera={position:[0,2,8],target:[0,1,0],fovDeg:50,near:.03,far:100};
const fixture=()=>({schema:"limina.staged-material-review-scene/v1",approvalPolicy:{renderer:"limina-production-native-engine",blenderApprovalProhibited:true,nonEngineApprovalProhibited:true,humanDecisionRequired:true},
  approvedShell:{...file("shell-approved.json","1"),artifactId:"shell/functional-hall-house-v4/r1",contractHash:h("2"),runtimeGlbPath:"shell.glb",runtimeGlbSha256:h("3"),surfaceMappingFacetHash:h("4"),materialRoleSlotsFacetHash:h("5")},
  paletteLock:{...file("materials.lock.json","6"),paletteId:"materials/functional-hall-house-v4/r1",packIds:["a","b","c","d","e","f"],authoredSimpleRoles:["glass","lead"]},
  derived:{assetId:"derived.glb",sha256:h("7"),assetHash:h("8"),manifestPath:"derived.json",manifestSha256:h("9"),manifestContentHash:h("a"),sourceShellSha256:h("3"),fallback:"none",extension:"KHR_texture_basisu"},
  stageArtifact:{...file("material-draft.json","b"),artifactId:"materials/functional-hall-house-v4/r1",kind:"material-palette",status:"draft"},presentation:{minimumResolution:[1920,1080],fixedTimeSeconds:12,warmupFrames:8,neutralStudio:true},evidenceViews:[
    {id:"poly-haven-pack-swatches",role:"six Poly Haven packs on spheres and planes",subject:"pack-swatches",camera},
    {id:"authored-simple-role-swatches",role:"authored simple role response",subject:"simple-swatches",camera},
    {id:"representative-exterior-shell-crop",role:"exterior mapping and continuity",subject:"shell",camera},
    {id:"representative-interior-hearth-crop",role:"interior and hearth mapping",subject:"shell",camera},
  ]});

test("M1 engine review authority closes the canonical evidence and exact pipeline inputs",()=>{
  const authority=validateStagedMaterialReviewAuthority(fixture());assert.equal(authority.paletteLock.packIds.length,6);assert.equal(authority.evidenceViews.length,4);
});
test("M1 review rejects Blender approval, shell derivation drift, incomplete packs, and missing crop evidence",()=>{
  for(const mutate of [(v:any)=>v.approvalPolicy.blenderApprovalProhibited=false,(v:any)=>v.derived.sourceShellSha256=h("f"),(v:any)=>v.paletteLock.packIds.pop(),(v:any)=>v.evidenceViews.pop()]){const v=fixture();mutate(v);assert.throws(()=>validateStagedMaterialReviewAuthority(v));}
});
test("M1 swatches use canonical packs[].id to roles[].packId association",()=>{
  const palette={packs:[{id:"cottage-fieldstone"}],roles:[{kind:"texture-pack",packId:"cottage-fieldstone",role:"foundation",materialName:"V4 foundation fieldstone"}]};
  assert.equal(materialRoleForPack(palette,"cottage-fieldstone").role,"foundation");
  assert.throws(()=>materialRoleForPack({packs:[{id:"cottage-fieldstone"}],roles:[{kind:"texture-pack",pack:{id:"cottage-fieldstone"}}]},"cottage-fieldstone"),/texture role/);
});
