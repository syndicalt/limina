import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { validateBuildingInteriorPlanV2 } from "../../js/src/assets/building-interior-plan-v2.mjs";
import { validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import { validateStagedInteriorProxyReviewAuthority } from "../../js/src/render/staged-interior-proxy-review-scene.ts";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";

const DEFAULT_ROOT=resolve(import.meta.dirname,"../..");
const sha=(bytes)=>`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const portable=(root,path)=>{const value=relative(root,path).split(sep).join("/");if(value===".."||value.startsWith("../")||isAbsolute(value))throw new Error(`I1 candidate input escapes repo root: ${path}`);return value;};
const exact=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const integer=(value,minimum=0)=>Number.isSafeInteger(value)&&value>=minimum;

function requireSubmission(capture){
  const submission=capture.renderSubmission,paired=capture.pairedRenderSubmission,resources=capture.rendererResources;
  if(submission?.schema!=="limina.three-render-submission/v2"||submission.source!=="three-webgpu-renderer-info"||submission.scope!=="single-production-frame-all-passes"||submission.instanceAccounting!=="full-draw-instance-count"||!integer(submission.frameId,1)||!integer(submission.renderCalls,1)||!integer(submission.drawCalls,1)||!integer(submission.triangles,1)||!Number.isFinite(submission.cpuEncodeMs)||submission.cpuEncodeMs<0)throw new Error(`I1 ${capture.id} lacks strict whole-frame telemetry`);
  if(paired?.schema!=="limina.paired-render-submission/v1"||paired.basis!=="same-process-fixed-camera-time-residency-post-visibility-toggle"||paired.candidate?.frameId!==paired.baseline?.frameId+1||paired.candidate?.renderCalls!==submission.renderCalls||paired.candidate?.drawCalls!==submission.drawCalls||paired.candidate?.triangles!==submission.triangles||paired.delta?.renderCalls!==paired.candidate.renderCalls-paired.baseline.renderCalls||paired.delta?.drawCalls!==paired.candidate.drawCalls-paired.baseline.drawCalls||paired.delta?.triangles!==paired.candidate.triangles-paired.baseline.triangles||!integer(paired.delta.drawCalls,1)||!integer(paired.delta.triangles,1))throw new Error(`I1 ${capture.id} lacks strict paired incremental telemetry`);
  const values=resources===undefined?[]:[...Object.values(resources.counts??{}),...Object.values(resources.bytes??{})];
  if(resources?.schema!=="limina.three-render-resources/v1"||resources.source!=="three-webgpu-renderer-info"||resources.scope!=="renderer-live-after-production-frame"||values.length!==12||values.some((value)=>!integer(value)))throw new Error(`I1 ${capture.id} lacks renderer resource telemetry`);
}

/** CPU-only validation and promotion. It never invokes a renderer. */
export async function buildInteriorReviewCandidate({repoRoot=DEFAULT_ROOT,authorityPath,capturePath,draftPath,outputPath,write=true}){
  const root=resolve(repoRoot),authorityAbsolute=resolve(root,authorityPath),captureAbsolute=resolve(root,capturePath),draftAbsolute=resolve(root,draftPath),outputAbsolute=resolve(root,outputPath);
  const [authorityBytes,captureBytes,draftBytes]=await Promise.all([readFile(authorityAbsolute),readFile(captureAbsolute),readFile(draftAbsolute)]),authority=validateStagedInteriorProxyReviewAuthority(JSON.parse(authorityBytes)),capture=JSON.parse(captureBytes),draft=validateBuildingStageArtifact(JSON.parse(draftBytes));
  const planBytes=await readFile(resolve(root,authority.plan.path)),plan=validateBuildingInteriorPlanV2(JSON.parse(planBytes));
  if(portable(root,resolve(root,authority.plan.path))!==authority.plan.path||sha(planBytes)!==authority.plan.sha256||portableAssetContentHash(planBytes)!==authority.plan.contentHash||plan.planId!==authority.plan.planId||plan.revision!==authority.plan.revision)throw new Error("I1 authority plan bytes drifted");
  if(portable(root,draftAbsolute)!==authority.stageArtifact.path||draft.kind!=="interior-plan"||draft.status!=="draft"||draft.artifactId!==authority.stageArtifact.artifactId||draft.revision!==authority.stageArtifact.revision||draft.contractHash!==authority.plan.canonicalHash||draft.contentHash!==authority.plan.sha256||sha(draftBytes)!==authority.stageArtifact.sha256||portableAssetContentHash(draftBytes)!==authority.stageArtifact.contentHash||draft.evidence.length!==0||draft.metadata?.gate!=="I1-layout"||draft.metadata?.proxyOnly!==true)throw new Error("draft does not bind the exact corrected I1 authority and plan");
  if(capture.schema!=="limina.staged-interior-proxy-native-review-set/v1"||capture.backend!=="native-webgpu"||capture.captureClass!=="production-engine"||capture.pixelFormat!=="rgba8unorm"||capture.rowOrigin!=="top-left"||capture.authority?.path!==portable(root,authorityAbsolute)||capture.authority?.sha256!==sha(authorityBytes)||capture.authority?.contentHash!==portableAssetContentHash(authorityBytes))throw new Error("capture does not bind the exact I1 authority");
  const sourcePaths=["js/src/render/staged-interior-proxy-review-scene.ts","js/src/demos/staged_interior_proxy_capture_window.ts","tools/preview/run-native-staged-interior-proxy-capture.mjs"];
  if(!Array.isArray(capture.source)||capture.source.map(({path})=>path).join(",")!==sourcePaths.join(","))throw new Error("capture lacks exact I1 review implementation source closure");
  for(const entry of capture.source){const bytes=await readFile(resolve(root,entry.path));if(sha(bytes)!==entry.sha256||portableAssetContentHash(bytes)!==entry.contentHash)throw new Error(`capture I1 review implementation drifted: ${entry.path}`);}
  for(const key of ["approvedShell","approvedMaterials","derived","plan","stageArtifact",...(authority.yawConventionMigration===undefined?[]:["yawConventionMigration"])])if(!exact(capture[key],authority[key]))throw new Error(`capture ${key} does not bind the exact I1 authority`);
  if(capture.studio?.neutral!==true||capture.studio?.world!=="none"||capture.studio?.fixedTimeSeconds!==authority.presentation.fixedTimeSeconds)throw new Error("capture lacks the exact neutral I1 studio contract");
  if(capture.guardEvidence?.schema!=="limina.nvidia-xid-guard/v1"||capture.guardEvidence.preflight?.xidObserved!==false||capture.guardEvidence.live?.xidObserved!==false||capture.guardEvidence.postflight?.xidObserved!==false||capture.timingPolicy?.gpuTimestampMode!=="disabled"||capture.timingPolicy?.timestampQueriesEnabled!==false)throw new Error("capture lacks the absolute native GPU guard contract");
  const inventory={zones:plan.zones.length,placements:plan.placements.length,facingMarkers:plan.placements.filter(({facingTargetId})=>facingTargetId!==null).length,clearances:plan.interactionClearances.length,navigationNodes:plan.navigation.nodes.length,navigationEdges:plan.navigation.edges.length,doorSweeps:plan.doorSweeps.length,hearthExclusions:plan.hearthExclusions.length};
  if(!exact(capture.mounted?.inventory,inventory)||!integer(capture.mounted?.labelCount,1)||!integer(capture.lifecycle?.baselineEntities)||capture.lifecycle.afterDisposeEntities!==capture.lifecycle.baselineEntities)throw new Error("capture lacks exact proxy inventory, labels, or lifecycle return evidence");
  const views=authority.evidenceViews;
  if(views.length!==2||views.map(({id})=>id).join(",")!=="layout-top-down,entry-walkthrough"||!Array.isArray(capture.captures)||capture.captures.length!==2||!Array.isArray(capture.outputs)||capture.outputs.length!==2)throw new Error("capture lacks exactly the canonical two-view I1 evidence set");
  for(let index=0;index<2;index++){
    const view=views[index],record=capture.captures[index],output=capture.outputs[index];
    if(record.id!==view.id||record.role!==view.role||record.shellVisible!==view.shellVisible||record.proxiesVisible!==true||output.id!==view.id||output.role!==view.role||output.shellVisible!==view.shellVisible||output.proxiesVisible!==true)throw new Error("capture I1 views are incomplete or mislabeled");
    requireSubmission(record);
    if(record.width!==output.width||record.height!==output.height||record.rgbaContentHash!==output.rgbaContentHash||output.width<Math.max(1920,authority.presentation.minimumResolution[0])||output.height<Math.max(1080,authority.presentation.minimumResolution[1])||!/^sha256:[0-9a-f]{64}$/.test(output.pngSha256)||!integer(output.pngByteLength,1)||!/^sha256:[0-9a-f]{64}$/.test(output.rgbaContentHash)||Number.isNaN(Date.parse(output.timestamp))||output.exposureEvidence?.schema!=="limina.cpu-pixel-exposure/v1")throw new Error(`I1 ${output.id} is not a canonical review PNG`);
  }
  if(new Set(capture.outputs.map(({pngSha256})=>pngSha256)).size!==2)throw new Error("I1 canonical PNG evidence hashes must be distinct");
  const candidate=validateBuildingStageArtifact({...draft,status:"candidate",evidence:capture.outputs.map((output)=>({evidenceId:`${draft.artifactId}/${output.id}`,kind:"production-engine-png",contentHash:output.pngSha256,width:output.width,height:output.height})),metadata:{...draft.metadata,humanDecision:"pending",authorityPath:portable(root,authorityAbsolute),captureEvidencePath:portable(root,captureAbsolute),captureBackend:capture.backend,guardSchema:capture.guardEvidence.schema}});
  if(write){await mkdir(dirname(outputAbsolute),{recursive:true,mode:0o700});await writeFile(outputAbsolute,`${JSON.stringify(candidate,null,2)}\n`,{mode:0o600,flag:"wx"});}
  return Object.freeze({candidate,outputPath:outputAbsolute});
}

if(import.meta.url===`file://${process.argv[1]}`){
  const args=process.argv.slice(2),at=(flag)=>{const index=args.indexOf(flag);if(index<0||!args[index+1])throw new Error("usage: bun tools/architecture/build-interior-review-candidate.mjs --authority <json> --capture <json> --draft <json> --out <json>");return args[index+1];};
  const {candidate}=await buildInteriorReviewCandidate({authorityPath:at("--authority"),capturePath:at("--capture"),draftPath:at("--draft"),outputPath:at("--out")});console.log(JSON.stringify({artifactId:candidate.artifactId,status:candidate.status,evidence:candidate.evidence,humanDecision:candidate.metadata.humanDecision},null,2));
}
