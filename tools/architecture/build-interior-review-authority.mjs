import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { buildingInteriorPlanV2Hash, validateBuildingInteriorPlanV2 } from "../../js/src/assets/building-interior-plan-v2.mjs";
import { validateBuildingHitlDecision, validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import { validateStagedInteriorProxyReviewAuthority } from "../../js/src/render/staged-interior-proxy-review-scene.ts";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";

const DEFAULT_ROOT=resolve(import.meta.dirname,"../..");
export const INTERIOR_REVIEW_AUTHORITY_DEFAULTS=Object.freeze({
  shellArtifactPath:"assets/buildings/authoring/functional-hall-house-v4/shell-r4/shell-artifact-approved.json",
  shellDecisionPath:"assets/buildings/authoring/functional-hall-house-v4/shell-r4/shell-review-decision-approve.json",
  materialArtifactPath:"assets/buildings/authoring/functional-hall-house-v4/material-r2/material-palette-artifact-approved.json",
  materialDecisionPath:"assets/buildings/authoring/functional-hall-house-v4/material-r2/material-review-decision-approve.json",
  planPath:"assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-plan.json",
  stageArtifactPath:"assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-plan-artifact-draft.json",
  outputPath:"assets/buildings/authoring/functional-hall-house-v4/interior-r1/interior-review-authority.json",
});
const revisionPaths=(revision)=>revision===1?INTERIOR_REVIEW_AUTHORITY_DEFAULTS:{...INTERIOR_REVIEW_AUTHORITY_DEFAULTS,planPath:`assets/buildings/authoring/functional-hall-house-v4/interior-r${revision}/interior-plan.json`,stageArtifactPath:`assets/buildings/authoring/functional-hall-house-v4/interior-r${revision}/interior-plan-artifact-draft.json`,outputPath:`assets/buildings/authoring/functional-hall-house-v4/interior-r${revision}/interior-review-authority.json`};

const sha=(bytes)=>`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const portable=(root,path)=>{const value=relative(root,path).split(sep).join("/");if(value===".."||value.startsWith("../")||value.startsWith("/"))throw new Error(`I1 review input escapes repo root: ${path}`);return value;};
const same=(values)=>values.every((value)=>value===values[0]);

function verifyApprovedStage({label,kind,expectedId,artifactBytes,artifactPath,decisionBytes,decisionPath,root}){
  const artifact=validateBuildingStageArtifact(JSON.parse(artifactBytes)),decision=validateBuildingHitlDecision(JSON.parse(decisionBytes)),decisionSha=sha(decisionBytes),artifactPortable=portable(root,artifactPath),decisionPortable=portable(root,decisionPath);
  if(artifact.kind!==kind||artifact.artifactId!==expectedId||artifact.status!=="approved")throw new Error(`I1 review requires exact approved ${label}`);
  if(decision.decision!=="approve"||!same([decision.artifactId,artifact.artifactId])||!same([decision.contractHash,artifact.contractHash])||!same([decision.contentHash,artifact.contentHash]))throw new Error(`I1 review ${label} approval decision does not bind the exact artifact`);
  if(artifact.metadata?.approval?.decisionId!==decision.decisionId||artifact.metadata?.approval?.path!==decisionPortable||artifact.metadata?.approval?.sha256!==decisionSha)throw new Error(`I1 review ${label} approval metadata drifted from the decision file`);
  const evidence=artifact.evidence.map((entry)=>entry.contentHash).sort(),reviewed=[...decision.evidenceHashes].sort();if(JSON.stringify(evidence)!==JSON.stringify(reviewed))throw new Error(`I1 review ${label} approval decision does not bind all evidence`);
  return Object.freeze({artifact,decision,authority:{path:artifactPortable,sha256:sha(artifactBytes),contentHash:portableAssetContentHash(artifactBytes),assetContentHash:artifact.contentHash,artifactId:artifact.artifactId,kind:artifact.kind,revision:artifact.revision,status:artifact.status,contractHash:artifact.contractHash,approvalDecisionPath:decisionPortable,approvalDecisionId:decision.decisionId,approvalDecisionHash:decisionSha}});
}

/** Build and validate an authority from already-read bytes. This is CPU-only and performs no writes. */
export function buildInteriorReviewAuthorityFromClosure({repoRoot=DEFAULT_ROOT,paths,bytes}){
  const root=resolve(repoRoot),shell=verifyApprovedStage({label:"shell r4",kind:"shell",expectedId:"shell/functional-hall-house-v4/r4",artifactBytes:bytes.shellArtifact,artifactPath:paths.shellArtifact,decisionBytes:bytes.shellDecision,decisionPath:paths.shellDecision,root}),materials=verifyApprovedStage({label:"M1 r2",kind:"material-palette",expectedId:"materials/functional-hall-house-v4/r2",artifactBytes:bytes.materialArtifact,artifactPath:paths.materialArtifact,decisionBytes:bytes.materialDecision,decisionPath:paths.materialDecision,root});
  const derived=materials.artifact.metadata?.derivedRuntime;if(!derived?.assetId||!derived.path||!derived.sha256||!derived.assetHash)throw new Error("I1 review approved M1 lacks exact derived runtime closure");
  const derivedPath=resolve(root,derived.path);if(portable(root,derivedPath)!==derived.path||derived.assetId!==relative(resolve(root,"assets"),derivedPath).split(sep).join("/"))throw new Error("I1 review M1 derived runtime path is not the production asset path");
  if(sha(bytes.derivedRuntime)!==derived.sha256||portableAssetContentHash(bytes.derivedRuntime)!==derived.assetHash||derived.sha256!==materials.artifact.contentHash)throw new Error("I1 review M1 derived runtime bytes drifted");
  if(materials.artifact.metadata?.approvedShell?.artifactId!==shell.artifact.artifactId||materials.artifact.metadata?.approvedShell?.contractHash!==shell.artifact.contractHash||materials.artifact.metadata?.approvedShell?.contentHash!==shell.artifact.contentHash)throw new Error("I1 review approved M1 is not derived from the exact approved shell");

  const plan=validateBuildingInteriorPlanV2(JSON.parse(bytes.plan)),stageArtifact=validateBuildingStageArtifact(JSON.parse(bytes.stageArtifact)),planSha=sha(bytes.plan),planHash=buildingInteriorPlanV2Hash(plan),planPath=portable(root,paths.plan),stagePath=portable(root,paths.stageArtifact);
  if(![1,2,3,4].includes(plan.revision)||plan.planId!==`interior/functional-hall-house-v4/r${plan.revision}`)throw new Error("I1 review requires an exact supported interior plan revision");
  const expectedSupersedes=plan.revision===1?null:`interior/functional-hall-house-v4/r${plan.revision-1}`;
  if(plan.supersedes!==expectedSupersedes)throw new Error("I1 review plan supersession identity drifted");
  for(const [label,dependency,approved] of [["shell",plan.dependencies.shell,shell],["materials",plan.dependencies.materials,materials]]){
    if(!same([dependency.artifactId,approved.artifact.artifactId])||dependency.revision!==approved.artifact.revision||dependency.status!=="approved"||!same([dependency.contractHash,approved.artifact.contractHash])||!same([dependency.contentHash,approved.artifact.contentHash])||!same([dependency.approvalDecisionId,approved.decision.decisionId])||!same([dependency.approvalDecisionHash,sha(label==="shell"?bytes.shellDecision:bytes.materialDecision)]))throw new Error(`I1 review plan ${label} dependency drifted from approved closure`);
  }
  if(stageArtifact.artifactId!==plan.planId||stageArtifact.kind!=="interior-plan"||stageArtifact.revision!==plan.revision||stageArtifact.status!=="draft"||stageArtifact.contractHash!==planHash||stageArtifact.contentHash!==planSha||stageArtifact.evidence.length!==0||stageArtifact.metadata?.gate!=="I1-layout"||stageArtifact.metadata?.proxyOnly!==true)throw new Error("I1 review requires the exact unreviewed proxy-only I1 draft artifact");
  if(plan.revision===1){if(stageArtifact.supersedes!==undefined||stageArtifact.metadata?.yawConventionMigration!==undefined)throw new Error("I1 r1 draft must not claim revision supersession or yaw migration");}else if(stageArtifact.supersedes!==expectedSupersedes||!stageArtifact.metadata?.yawConventionMigration)throw new Error(`I1 r${plan.revision} draft must carry exact supersession and yaw migration metadata`);
  if(stageArtifact.metadata?.plan?.path!==planPath||stageArtifact.metadata?.plan?.canonicalHash!==planHash||stageArtifact.metadata?.plan?.contentHash!==planSha)throw new Error("I1 draft metadata does not bind the exact plan bytes");
  if(stageArtifact.metadata?.approvedShell?.path!==shell.authority.path||stageArtifact.metadata?.approvedShell?.sha256!==shell.authority.sha256||stageArtifact.metadata?.approvedShell?.decisionPath!==shell.authority.approvalDecisionPath||stageArtifact.metadata?.approvedShell?.decisionSha256!==shell.authority.approvalDecisionHash)throw new Error("I1 draft approved-shell closure drifted");
  if(stageArtifact.metadata?.approvedMaterials?.path!==materials.authority.path||stageArtifact.metadata?.approvedMaterials?.sha256!==materials.authority.sha256||stageArtifact.metadata?.approvedMaterials?.decisionPath!==materials.authority.approvalDecisionPath||stageArtifact.metadata?.approvedMaterials?.decisionSha256!==materials.authority.approvalDecisionHash||stageArtifact.metadata?.approvedMaterials?.derivedAssetId!==derived.assetId||stageArtifact.metadata?.approvedMaterials?.derivedGlbPath!==derived.path||stageArtifact.metadata?.approvedMaterials?.derivedGlbSha256!==derived.sha256||stageArtifact.metadata?.approvedMaterials?.derivedAssetHash!==derived.assetHash)throw new Error("I1 draft approved-M1 runtime closure drifted");

  return validateStagedInteriorProxyReviewAuthority({schema:"limina.staged-interior-proxy-review-scene/v1",approvalPolicy:{renderer:"limina-production-native-engine",blenderApprovalProhibited:true,nonEngineApprovalProhibited:true,humanDecisionRequired:true,proxyOnly:true},approvedShell:shell.authority,approvedMaterials:materials.authority,derived:{assetId:derived.assetId,runtimeGlbPath:derived.path,sha256:derived.sha256,assetHash:derived.assetHash,sourceShellArtifactId:shell.artifact.artifactId,sourceMaterialArtifactId:materials.artifact.artifactId},plan:{path:planPath,sha256:planSha,contentHash:portableAssetContentHash(bytes.plan),planId:plan.planId,revision:plan.revision,canonicalHash:planHash},stageArtifact:{path:stagePath,sha256:sha(bytes.stageArtifact),contentHash:portableAssetContentHash(bytes.stageArtifact),artifactId:stageArtifact.artifactId,kind:"interior-plan",revision:stageArtifact.revision,status:"draft"},...(plan.revision===1?{}:{yawConventionMigration:stageArtifact.metadata.yawConventionMigration}),placement:{position:[0,0,0],yawRadians:0},presentation:{minimumResolution:[1920,1080],fixedTimeSeconds:12,warmupFrames:8,neutralStudio:true},evidenceViews:[
    {id:"layout-top-down",role:"unoccluded activity zones, proxy OBBs, clearances, circulation, door arc, and hearth exclusion",shellVisible:false,proxiesVisible:true,camera:{position:[.01,13,-.815],target:[0,.09,-.815],fovDeg:42,near:.03,far:100}},
    {id:"entry-walkthrough",role:"shell-registered entry-to-hearth proxy walkthrough",shellVisible:true,proxiesVisible:true,camera:{position:[-.72,1.6,-2.7],target:[2.95,1.2,3.18],fovDeg:58,near:.03,far:100}},
  ]});
}

export async function writeInteriorReviewAuthority(authority,outputPath){validateStagedInteriorProxyReviewAuthority(authority);await mkdir(dirname(outputPath),{recursive:true});await writeFile(outputPath,`${JSON.stringify(authority,null,2)}\n`,{mode:0o600,flag:"wx"});return authority;}

export async function buildInteriorReviewAuthority(options={}){
  const revision=options.revision??1;if(![1,2,3,4].includes(revision))throw new Error("I1 review authority revision must be 1, 2, 3, or 4");
  const root=resolve(options.repoRoot??DEFAULT_ROOT),configured={...revisionPaths(revision),...options},paths=Object.fromEntries(["shellArtifactPath","shellDecisionPath","materialArtifactPath","materialDecisionPath","planPath","stageArtifactPath","outputPath"].map((key)=>[key.replace(/Path$/,""),resolve(root,configured[key])]));
  const inputPaths=[paths.shellArtifact,paths.shellDecision,paths.materialArtifact,paths.materialDecision,paths.plan,paths.stageArtifact],[shellArtifact,shellDecision,materialArtifact,materialDecision,plan,stageArtifact]=await Promise.all(inputPaths.map((path)=>readFile(path)));
  const material=validateBuildingStageArtifact(JSON.parse(materialArtifact)),derivedPath=resolve(root,material.metadata?.derivedRuntime?.path??"__missing_m1_runtime__"),derivedRuntime=await readFile(derivedPath);
  const authority=buildInteriorReviewAuthorityFromClosure({repoRoot:root,paths:{...paths,derivedRuntime:derivedPath},bytes:{shellArtifact,shellDecision,materialArtifact,materialDecision,plan,stageArtifact,derivedRuntime}});
  if(options.write!==false)await writeInteriorReviewAuthority(authority,paths.output);return Object.freeze({authority,outputPath:paths.output});
}

if(import.meta.url===`file://${process.argv[1]}`){const args=process.argv.slice(2),optional=(flag)=>{const index=args.indexOf(flag);if(index<0)return undefined;if(!args[index+1])throw new Error(`missing value for ${flag}`);return args[index+1];},revisionValue=optional("--revision"),revision=revisionValue===undefined?1:Number(revisionValue),result=await buildInteriorReviewAuthority({revision,...(optional("--plan")?{planPath:optional("--plan")} :{}),...(optional("--draft")?{stageArtifactPath:optional("--draft")} :{}),...(optional("--out")?{outputPath:optional("--out")} :{})});console.log(JSON.stringify({schema:result.authority.schema,planId:result.authority.plan.planId,revision:result.authority.plan.revision,output:relative(DEFAULT_ROOT,result.outputPath).split(sep).join("/"),views:result.authority.evidenceViews.map((view)=>view.id)},null,2));}
