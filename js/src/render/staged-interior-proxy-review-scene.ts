import * as THREE from "../../build/three.bundle.mjs";
import { AssetRegistry } from "../asset-registry.ts";
import { validateBuildingInteriorPlanV2, buildingInteriorPlanV2Hash } from "../assets/building-interior-plan-v2.mjs";
import { validateBuildingHitlDecision, validateBuildingStageArtifact } from "../assets/staged-building-pipeline.mjs";
import { LiminaTracer } from "../observability/event.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { UiManager } from "../ui/manager.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { sha256 } from "../world/sha256.mjs";

type Hash = `sha256:${string}`;
type V3 = readonly [number, number, number];
type ExactFile = { readonly path:string; readonly sha256:Hash; readonly contentHash:Hash };
type InteriorRevision = 1|2|3|4;
export type InteriorYawConventionMigration =
  | {readonly from:"legacy-atan2-dx-negative-dz";readonly to:"engine-three-local-negative-z-atan2-negative-dx-negative-dz";readonly changedPlacementIds:readonly["placement/dining-chair-west","placement/dining-chair-east"]}
  | {readonly from:"legacy-positive-yaw-hearth-settle";readonly to:"engine-three-local-negative-z-facing-target";readonly changedPlacementIds:readonly["placement/hearth-settle"]}
  | {readonly from:"side-staged-hearth-settle";readonly to:"front-facing-wall-parallel-hearth-settle";readonly changedPlacementIds:readonly["placement/hearth-settle"]};
const HASH=/^sha256:[0-9a-f]{64}$/;
const VIEW_IDS="layout-top-down,entry-walkthrough";
const VIEW_SHELL="false,true";

interface ApprovedStage extends ExactFile {
  readonly artifactId:string; readonly kind:"shell"|"material-palette"; readonly revision:number; readonly status:"approved";
  readonly contractHash:Hash; readonly assetContentHash:Hash; readonly approvalDecisionPath:string; readonly approvalDecisionId:string; readonly approvalDecisionHash:Hash;
}

export interface StagedInteriorProxyReviewAuthority {
  readonly schema:"limina.staged-interior-proxy-review-scene/v1";
  readonly approvalPolicy:{readonly renderer:"limina-production-native-engine";readonly blenderApprovalProhibited:true;readonly nonEngineApprovalProhibited:true;readonly humanDecisionRequired:true;readonly proxyOnly:true};
  readonly approvedShell:ApprovedStage&{readonly kind:"shell"};
  readonly approvedMaterials:ApprovedStage&{readonly kind:"material-palette"};
  readonly derived:{readonly assetId:string;readonly runtimeGlbPath:string;readonly sha256:Hash;readonly assetHash:Hash;readonly sourceShellArtifactId:string;readonly sourceMaterialArtifactId:string};
  readonly plan:ExactFile&{readonly planId:string;readonly revision:InteriorRevision;readonly canonicalHash:Hash};
  readonly stageArtifact:ExactFile&{readonly artifactId:string;readonly kind:"interior-plan";readonly revision:InteriorRevision;readonly status:"draft"};
  readonly yawConventionMigration?:InteriorYawConventionMigration;
  readonly placement:{readonly position:V3;readonly yawRadians:number};
  readonly presentation:{readonly minimumResolution:readonly[number,number];readonly fixedTimeSeconds:number;readonly warmupFrames:number;readonly neutralStudio:true};
  readonly evidenceViews:readonly {
    readonly id:"layout-top-down"|"entry-walkthrough";readonly role:string;readonly shellVisible:boolean;readonly proxiesVisible:true;
    readonly camera:{readonly position:V3;readonly target:V3;readonly fovDeg:number;readonly near:number;readonly far:number};
  }[];
}

const exact=(value:unknown,keys:readonly string[],label:string)=>{if(value===null||typeof value!=="object"||Array.isArray(value))throw new Error(`interior proxy authority ${label} must be an object`);const actual=Object.keys(value as object);for(const key of keys)if(!actual.includes(key))throw new Error(`interior proxy authority ${label}.${key} is required`);for(const key of actual)if(!keys.includes(key))throw new Error(`interior proxy authority ${label}.${key} is unsupported`);};
function hash(value:unknown,label:string):asserts value is Hash{if(typeof value!=="string"||!HASH.test(value))throw new Error(`interior proxy authority ${label} must be a lowercase sha256`);}
const id=(value:unknown,label:string)=>{if(typeof value!=="string"||!/^[a-z0-9][a-z0-9._/-]{0,159}$/.test(value))throw new Error(`interior proxy authority ${label} must be a stable lowercase id`);};
function v3(value:unknown,label:string):asserts value is V3{if(!Array.isArray(value)||value.length!==3||!value.every(Number.isFinite))throw new Error(`interior proxy authority ${label} must be a finite vec3`);}
function file(value:unknown,label:string):asserts value is ExactFile{exact(value,["path","sha256","contentHash"],label);const f=value as ExactFile;if(!f.path||f.path.startsWith("/")||f.path.split("/").includes(".."))throw new Error(`interior proxy authority ${label}.path must be workspace-relative`);hash(f.sha256,`${label}.sha256`);hash(f.contentHash,`${label}.contentHash`);}
const stage=(value:unknown,label:string,kind:"shell"|"material-palette")=>{exact(value,["path","sha256","contentHash","artifactId","kind","revision","status","contractHash","assetContentHash","approvalDecisionPath","approvalDecisionId","approvalDecisionHash"],label);const s=value as ApprovedStage;file({path:s.path,sha256:s.sha256,contentHash:s.contentHash},label);if(!s.approvalDecisionPath||s.approvalDecisionPath.startsWith("/")||s.approvalDecisionPath.split("/").includes(".."))throw new Error(`interior proxy authority ${label}.approvalDecisionPath must be workspace-relative`);id(s.artifactId,`${label}.artifactId`);if(s.kind!==kind||s.status!=="approved"||!Number.isSafeInteger(s.revision)||s.revision<1)throw new Error(`interior proxy authority ${label} is not an approved ${kind}`);hash(s.contractHash,`${label}.contractHash`);hash(s.assetContentHash,`${label}.assetContentHash`);id(s.approvalDecisionId,`${label}.approvalDecisionId`);hash(s.approvalDecisionHash,`${label}.approvalDecisionHash`);};
const YAW_MIGRATIONS=Object.freeze({
  2:Object.freeze({from:"legacy-atan2-dx-negative-dz",to:"engine-three-local-negative-z-atan2-negative-dx-negative-dz",changedPlacementIds:Object.freeze(["placement/dining-chair-west","placement/dining-chair-east"] as const)}),
  3:Object.freeze({from:"legacy-positive-yaw-hearth-settle",to:"engine-three-local-negative-z-facing-target",changedPlacementIds:Object.freeze(["placement/hearth-settle"] as const)}),
  4:Object.freeze({from:"side-staged-hearth-settle",to:"front-facing-wall-parallel-hearth-settle",changedPlacementIds:Object.freeze(["placement/hearth-settle"] as const)}),
});
function yawMigration(value:unknown,label:string,revision:2|3|4):asserts value is InteriorYawConventionMigration{exact(value,["from","to","changedPlacementIds"],label);const migration=value as InteriorYawConventionMigration,expected=YAW_MIGRATIONS[revision];if(migration.from!==expected.from||migration.to!==expected.to||!Array.isArray(migration.changedPlacementIds)||migration.changedPlacementIds.join(",")!==expected.changedPlacementIds.join(","))throw new Error(`interior proxy authority ${label} is not the exact r${revision} yaw migration`);}

export function validateStagedInteriorProxyReviewAuthority(value:unknown):StagedInteriorProxyReviewAuthority{
  const rootKeys=["schema","approvalPolicy","approvedShell","approvedMaterials","derived","plan","stageArtifact","placement","presentation","evidenceViews",...((value!==null&&typeof value==="object"&&"yawConventionMigration" in value)?["yawConventionMigration"]:[])];exact(value,rootKeys,"root");const a=value as StagedInteriorProxyReviewAuthority;
  if(a.schema!=="limina.staged-interior-proxy-review-scene/v1")throw new Error("unsupported staged interior proxy review authority");
  exact(a.approvalPolicy,["renderer","blenderApprovalProhibited","nonEngineApprovalProhibited","humanDecisionRequired","proxyOnly"],"approvalPolicy");
  if(a.approvalPolicy.renderer!=="limina-production-native-engine"||a.approvalPolicy.blenderApprovalProhibited!==true||a.approvalPolicy.nonEngineApprovalProhibited!==true||a.approvalPolicy.humanDecisionRequired!==true||a.approvalPolicy.proxyOnly!==true)throw new Error("I1 approval requires human review of proxy-only Limina production native-engine evidence");
  stage(a.approvedShell,"approvedShell","shell");stage(a.approvedMaterials,"approvedMaterials","material-palette");
  exact(a.derived,["assetId","runtimeGlbPath","sha256","assetHash","sourceShellArtifactId","sourceMaterialArtifactId"],"derived");id(a.derived.assetId,"derived.assetId");
  if(a.derived.runtimeGlbPath!==`assets/${a.derived.assetId}`)throw new Error("interior proxy derived runtime path must be the production asset path");hash(a.derived.sha256,"derived.sha256");hash(a.derived.assetHash,"derived.assetHash");
  if(a.derived.sourceShellArtifactId!==a.approvedShell.artifactId||a.derived.sourceMaterialArtifactId!==a.approvedMaterials.artifactId)throw new Error("interior proxy derived shell is not bound to the approved A1/M1 pair");
  exact(a.plan,["path","sha256","contentHash","planId","revision","canonicalHash"],"plan");file({path:a.plan.path,sha256:a.plan.sha256,contentHash:a.plan.contentHash},"plan");id(a.plan.planId,"plan.planId");hash(a.plan.canonicalHash,"plan.canonicalHash");if(![1,2,3,4].includes(a.plan.revision)||a.plan.planId!==`interior/functional-hall-house-v4/r${a.plan.revision}`)throw new Error("I1 authority must bind an exact supported interior plan revision");
  exact(a.stageArtifact,["path","sha256","contentHash","artifactId","kind","revision","status"],"stageArtifact");file({path:a.stageArtifact.path,sha256:a.stageArtifact.sha256,contentHash:a.stageArtifact.contentHash},"stageArtifact");if(a.stageArtifact.artifactId!==a.plan.planId||a.stageArtifact.kind!=="interior-plan"||a.stageArtifact.revision!==a.plan.revision||a.stageArtifact.status!=="draft")throw new Error("I1 authority must bind its exact draft interior-plan artifact");
  if(a.plan.revision===1){if(a.yawConventionMigration!==undefined)throw new Error("I1 r1 authority must not claim a yaw migration");}else{yawMigration(a.yawConventionMigration,"yawConventionMigration",a.plan.revision);}
  exact(a.placement,["position","yawRadians"],"placement");v3(a.placement.position,"placement.position");if(!Number.isFinite(a.placement.yawRadians))throw new Error("interior proxy authority placement yaw must be finite");
  exact(a.presentation,["minimumResolution","fixedTimeSeconds","warmupFrames","neutralStudio"],"presentation");if(!Array.isArray(a.presentation.minimumResolution)||a.presentation.minimumResolution.length!==2||!a.presentation.minimumResolution.every(n=>Number.isSafeInteger(n)&&n>=720)||!Number.isFinite(a.presentation.fixedTimeSeconds)||a.presentation.fixedTimeSeconds<0||!Number.isSafeInteger(a.presentation.warmupFrames)||a.presentation.warmupFrames<1||a.presentation.warmupFrames>120||a.presentation.neutralStudio!==true)throw new Error("interior proxy authority presentation policy is invalid");
  if(!Array.isArray(a.evidenceViews)||a.evidenceViews.map(v=>v.id).join(",")!==VIEW_IDS||a.evidenceViews.map(v=>String(v.shellVisible)).join(",")!==VIEW_SHELL)throw new Error("I1 authority requires exactly layout-top-down then entry-walkthrough");
  for(const view of a.evidenceViews){exact(view,["id","role","shellVisible","proxiesVisible","camera"],`evidenceViews.${view.id}`);if(!view.role||view.proxiesVisible!==true)throw new Error(`interior proxy view ${view.id} must review visible proxies`);exact(view.camera,["position","target","fovDeg","near","far"],`${view.id}.camera`);v3(view.camera.position,`${view.id}.camera.position`);v3(view.camera.target,`${view.id}.camera.target`);if(!Number.isFinite(view.camera.fovDeg)||view.camera.fovDeg<15||view.camera.fovDeg>80||!Number.isFinite(view.camera.near)||view.camera.near<=0||!Number.isFinite(view.camera.far)||view.camera.far<=view.camera.near)throw new Error(`interior proxy view ${view.id} has an invalid camera`);}
  return a;
}

function exactBytes(label:string,entry:ExactFile,read:(path:string)=>Uint8Array){const bytes=read(entry.path);if(`sha256:${sha256(bytes)}`!==entry.sha256||portableAssetContentHash(bytes)!==entry.contentHash)throw new Error(`interior proxy review ${label} bytes drifted`);return bytes;}

/** Verify the complete A1/M1/I1 closure before initializing the native renderer or GLTF loader. */
export function verifyStagedInteriorProxyReviewClosure(authority:StagedInteriorProxyReviewAuthority,read:(path:string)=>Uint8Array){
  validateStagedInteriorProxyReviewAuthority(authority);
  const shell=exactBytes("approved shell artifact",authority.approvedShell,read),materials=exactBytes("approved materials artifact",authority.approvedMaterials,read),shellDecisionBytes=read(authority.approvedShell.approvalDecisionPath),materialDecisionBytes=read(authority.approvedMaterials.approvalDecisionPath),planBytes=exactBytes("plan",authority.plan,read),stageArtifact=exactBytes("draft stage artifact",authority.stageArtifact,read),derived=read(authority.derived.runtimeGlbPath);
  if(`sha256:${sha256(derived)}`!==authority.derived.sha256||portableAssetContentHash(derived)!==authority.derived.assetHash)throw new Error("interior proxy review approved M1-derived shell bytes drifted");
  const decoder=new TextDecoder("utf-8",{fatal:true}),shellArtifact=validateBuildingStageArtifact(JSON.parse(decoder.decode(shell))),materialArtifact=validateBuildingStageArtifact(JSON.parse(decoder.decode(materials))),draftArtifact=validateBuildingStageArtifact(JSON.parse(decoder.decode(stageArtifact)));
  for(const [label,bytes,approved] of [["shell",shellDecisionBytes,authority.approvedShell],["materials",materialDecisionBytes,authority.approvedMaterials]] as const){if(`sha256:${sha256(bytes)}`!==approved.approvalDecisionHash)throw new Error(`interior proxy review approved ${label} decision bytes drifted`);const decision=validateBuildingHitlDecision(JSON.parse(decoder.decode(bytes)));if(decision.decision!=="approve"||decision.decisionId!==approved.approvalDecisionId||decision.artifactId!==approved.artifactId||decision.contractHash!==approved.contractHash||decision.contentHash!==approved.assetContentHash)throw new Error(`interior proxy review approved ${label} decision identity drifted`);}
  for(const [label,artifact,approved] of [["shell",shellArtifact,authority.approvedShell],["materials",materialArtifact,authority.approvedMaterials]] as const){if(artifact.artifactId!==approved.artifactId||artifact.kind!==approved.kind||artifact.revision!==approved.revision||artifact.status!=="approved"||artifact.contractHash!==approved.contractHash||artifact.contentHash!==approved.assetContentHash)throw new Error(`interior proxy review approved ${label} artifact identity drifted`);if(artifact.metadata?.approval?.decisionId!==approved.approvalDecisionId||artifact.metadata?.approval?.sha256!==approved.approvalDecisionHash)throw new Error(`interior proxy review approved ${label} decision identity drifted`);}
  if(materialArtifact.metadata?.approvedShell?.artifactId!==shellArtifact.artifactId||materialArtifact.metadata?.approvedShell?.contractHash!==shellArtifact.contractHash||materialArtifact.metadata?.derivedRuntime?.path!==authority.derived.runtimeGlbPath||materialArtifact.metadata?.derivedRuntime?.sha256!==authority.derived.sha256||materialArtifact.metadata?.derivedRuntime?.assetHash!==authority.derived.assetHash)throw new Error("interior proxy review approved A1/M1 derived closure drifted");
  const plan=JSON.parse(decoder.decode(planBytes));validateBuildingInteriorPlanV2(plan);
  if(plan.planId!==authority.plan.planId||plan.revision!==authority.plan.revision||buildingInteriorPlanV2Hash(plan)!==authority.plan.canonicalHash)throw new Error("interior proxy review plan identity drifted");
  for(const [label,dependency,approved] of [["shell",plan.dependencies.shell,authority.approvedShell],["materials",plan.dependencies.materials,authority.approvedMaterials]] as const){for(const key of ["artifactId","revision","contractHash","approvalDecisionId","approvalDecisionHash"] as const)if(dependency[key]!==approved[key])throw new Error(`interior proxy review plan ${label} dependency ${key} drifted`);if(dependency.contentHash!==approved.assetContentHash)throw new Error(`interior proxy review plan ${label} dependency contentHash drifted`);}
  const expectedSupersedes=authority.plan.revision===1?null:`interior/functional-hall-house-v4/r${authority.plan.revision-1}`;
  if(plan.supersedes!==expectedSupersedes)throw new Error("interior proxy review plan supersession identity drifted");
  if(draftArtifact.artifactId!==authority.stageArtifact.artifactId||draftArtifact.kind!=="interior-plan"||draftArtifact.revision!==authority.plan.revision||draftArtifact.status!=="draft"||draftArtifact.contractHash!==authority.plan.canonicalHash||draftArtifact.contentHash!==authority.plan.sha256||draftArtifact.evidence.length!==0)throw new Error("interior proxy review draft I1 artifact drifted");
  if(authority.plan.revision!==1){yawMigration(draftArtifact.metadata?.yawConventionMigration,"draftArtifact.metadata.yawConventionMigration",authority.plan.revision);if(JSON.stringify(draftArtifact.metadata?.yawConventionMigration)!==JSON.stringify(authority.yawConventionMigration))throw new Error(`interior proxy review r${authority.plan.revision} yaw migration drifted`);}
  return Object.freeze({shell,materials,planBytes,stageArtifact,derived,plan});
}

const palette={zone:0x42d392,placement:0x35b9ff,facing:0xffffff,approach:0xffcc4d,occupancy:0xf58f38,navigation:0x508cff,door:0xff4b5c,hearth:0xc83cff};
type ProxyKind=keyof typeof palette;
export interface InteriorProxyInventory {readonly zones:number;readonly placements:number;readonly facingMarkers:number;readonly clearances:number;readonly navigationNodes:number;readonly navigationEdges:number;readonly doorSweeps:number;readonly hearthExclusions:number;}

/** Three rotates local -Z to this world-XZ direction for a yaw about +Y. */
export const interiorLocalNegativeZForward=(yawRadians:number):readonly[number,number]=>Object.freeze([-Math.sin(yawRadians),-Math.cos(yawRadians)]);

/** Build only review proxies; this function never reads or mounts furniture/catalog GLBs. */
export function buildStagedInteriorProxyGeometry(planValue:any){
  const plan=validateBuildingInteriorPlanV2(planValue) as any,group=new THREE.Group();group.name="I1 proxy-only interior review";
  const geometries=new Set<THREE.BufferGeometry>(),materials=new Map<ProxyKind,THREE.MeshBasicMaterial>();
  const material=(kind:ProxyKind)=>{let value=materials.get(kind);if(!value){value=new THREE.MeshBasicMaterial({name:`I1/${kind}`,color:palette[kind],transparent:true,opacity:kind==="placement"?.42:.26,depthWrite:false,side:THREE.DoubleSide});materials.set(kind,value);}return value;};
  const box=(name:string,kind:ProxyKind,size:V3,position:V3,yaw=0)=>{const geometry=new THREE.BoxGeometry(...size),mesh=new THREE.Mesh(geometry,material(kind));geometries.add(geometry);mesh.name=name;mesh.position.set(...position);mesh.rotation.y=yaw;group.add(mesh);return mesh;};
  const cylinder=(name:string,kind:ProxyKind,radius:number,height:number,position:V3)=>{const geometry=new THREE.CylinderGeometry(radius,radius,height,48,1,false),mesh=new THREE.Mesh(geometry,material(kind));geometries.add(geometry);mesh.name=name;mesh.position.set(...position);group.add(mesh);return mesh;};
  const roomFloor=new Map(plan.rooms.map((room:any)=>[room.id,room.finishedFloorY]));
  for(const zone of plan.zones){const y=roomFloor.get(zone.roomId) as number;box(`zone/${zone.id}`,"zone",[zone.bounds.halfExtents[0]*2,.035,zone.bounds.halfExtents[2]*2],[zone.bounds.center[0],y+.018,zone.bounds.center[2]]);}
  const archetypes=new Map(plan.proxyArchetypes.map((entry:any)=>[entry.id,entry]));
  let facingMarkers=0;
  for(const placement of plan.placements){const archetype=archetypes.get(placement.archetypeId) as any,c=Math.cos(placement.yawRadians),s=Math.sin(placement.yawRadians),center=placement.footprint.localCenter;box(`placement/${placement.id}`,"placement",archetype.dimensions,[placement.position[0],placement.position[1]+archetype.dimensions[1]/2,placement.position[2]],placement.yawRadians);box(`footprint/${placement.id}`,"placement",[placement.footprint.halfExtents[0]*2,.025,placement.footprint.halfExtents[1]*2],[placement.position[0]+c*center[0]+s*center[1],placement.position[1]+.013,placement.position[2]-s*center[0]+c*center[1]],placement.yawRadians);if(placement.facingTargetId!==null){const length=Math.max(.42,Math.min(.8,Math.max(archetype.dimensions[0],archetype.dimensions[2])*.65)),width=Math.min(.2,length*.28),y=placement.position[1]+archetype.dimensions[1]+.025,positions=[-width*.28,0,0,width*.28,0,0,-width*.28,0,-length*.62,width*.28,0,0,width*.28,0,-length*.62,-width*.28,0,-length*.62,-width,0,-length*.55,width,0,-length*.55,0,0,-length],geometry=new THREE.BufferGeometry();geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));geometry.computeVertexNormals();geometries.add(geometry);const mesh=new THREE.Mesh(geometry,material("facing"));mesh.name=`facing/${placement.id}`;mesh.position.set(placement.position[0],y,placement.position[2]);mesh.rotation.y=placement.yawRadians;mesh.userData={placementId:placement.id,facingTargetId:placement.facingTargetId,forwardXZ:interiorLocalNegativeZForward(placement.yawRadians)};group.add(mesh);facingMarkers++;}}
  for(const clearance of plan.interactionClearances)cylinder(`clearance/${clearance.id}`,clearance.kind,clearance.radiusM,.04,[clearance.center[0],clearance.center[1]+.02,clearance.center[2]]);
  const nodes=new Map(plan.navigation.nodes.map((entry:any)=>[entry.id,entry]));
  for(const node of plan.navigation.nodes)cylinder(`navigation-node/${node.id}`,"navigation",.11,.08,[node.position[0],node.position[1]+.04,node.position[2]]);
  for(const edge of plan.navigation.edges){const from=nodes.get(edge.fromNodeId) as any,to=nodes.get(edge.toNodeId) as any,dx=to.position[0]-from.position[0],dz=to.position[2]-from.position[2],length=Math.hypot(dx,dz);box(`navigation-edge/${edge.id}`,"navigation",[edge.halfWidthM*2,.025,length],[(from.position[0]+to.position[0])/2,from.position[1]+.013,(from.position[2]+to.position[2])/2],Math.atan2(dx,dz));}
  for(const door of plan.doorSweeps){let delta=door.openYawRadians-door.closedYawRadians;while(delta>Math.PI)delta-=Math.PI*2;while(delta< -Math.PI)delta+=Math.PI*2;const segments=Math.max(16,Math.ceil(Math.abs(delta)/(Math.PI/48))),positions=[door.hinge[0],door.hinge[1]+.03,door.hinge[2]];for(let i=0;i<=segments;i++){const angle=door.closedYawRadians+delta*i/segments;positions.push(door.hinge[0]+Math.cos(angle)*door.radiusM,door.hinge[1]+.03,door.hinge[2]+Math.sin(angle)*door.radiusM);}const indexes=[];for(let i=0;i<segments;i++)indexes.push(0,i+1,i+2);const geometry=new THREE.BufferGeometry();geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));geometry.setIndex(indexes);geometry.computeVertexNormals();geometries.add(geometry);const mesh=new THREE.Mesh(geometry,material("door"));mesh.name=`door-sweep/${door.id}`;group.add(mesh);}
  for(const hearth of plan.hearthExclusions){const offset=hearth.halfExtents[1]+hearth.minimumClearanceM/2,c=Math.cos(hearth.yawRadians),s=Math.sin(hearth.yawRadians);box(`hearth-exclusion/${hearth.id}`,"hearth",[(hearth.halfExtents[0]+hearth.minimumClearanceM)*2,.05,hearth.minimumClearanceM],[hearth.center[0]+s*offset,hearth.center[1]+.025,hearth.center[2]+c*offset],hearth.yawRadians);}
  const inventory=Object.freeze({zones:plan.zones.length,placements:plan.placements.length,facingMarkers,clearances:plan.interactionClearances.length,navigationNodes:plan.navigation.nodes.length,navigationEdges:plan.navigation.edges.length,doorSweeps:plan.doorSweeps.length,hearthExclusions:plan.hearthExclusions.length});
  let disposed=false;return Object.freeze({group,inventory,dispose:()=>{if(disposed)return;disposed=true;group.remove(...group.children);for(const geometry of geometries)geometry.dispose();for(const value of materials.values())value.dispose();}});
}

/** Mount the exact approved M1-derived shell via production asset.place, plus proxy-only I1 review geometry and labels. */
export async function mountStagedInteriorProxyReview(world:WorldContext,authority:StagedInteriorProxyReviewAuthority){
  const closure=verifyStagedInteriorProxyReviewClosure(authority,path=>world.ops.op_read_asset(path)),assets=new AssetRegistry(world.ops);assets.seed(authority.derived.assetId,closure.derived);
  const registry=new SkillRegistry(new LiminaTracer("staged-interior-i1-review"));registerCoreSkills(registry,{assets});const base={agentId:"staged-interior-i1-review",sessionId:"staged-interior-i1-review",permissions:resolveProfile("builder.readWrite"),tick:0,world};let tick=1;
  const invoke=async(name:string,input:unknown)=>{const result=await registry.invoke(name,input,{...base,tick:tick++});if(!result.success)throw new Error(`${name} failed: ${JSON.stringify(result.error)}`);return result.result as Record<string,unknown>;};
  let entity:string|undefined;const proxies=buildStagedInteriorProxyGeometry(closure.plan),ui=new UiManager();
  try{
    const placed=await invoke("asset.place",{assetId:authority.derived.assetId,hash:authority.derived.assetHash,position:authority.placement.position,rotation:[0,authority.placement.yawRadians,0],scale:[1,1,1],ground:false});entity=placed.entity as string;if(placed.hash!==authority.derived.assetHash)throw new Error("asset.place returned an unpinned approved M1-derived shell");
    const shell=world.entities.resolve(entity);if(!shell?.mesh)throw new Error("interior proxy asset.place did not create an engine render root");
    proxies.group.position.set(...authority.placement.position);proxies.group.rotation.y=authority.placement.yawRadians;world.scene.add(proxies.group);proxies.group.updateMatrixWorld(true);
    const localLabel=(point:V3)=>()=>{const value=proxies.group.localToWorld(new THREE.Vector3(...point));return [value.x,value.y,value.z] as [number,number,number];};const labels:string[]=[];
    const roomFloor=new Map(closure.plan.rooms.map((room:any)=>[room.id,room.finishedFloorY]));
    const short=(id:string)=>id.split("/").at(-1)??id;
    for(const zone of closure.plan.zones)labels.push(ui.create(world.scene,"label",{text:`ZONE ${short(zone.id)}`,anchor:{kind:"world",position:localLabel([zone.bounds.center[0],(roomFloor.get(zone.roomId) as number)+.25,zone.bounds.center[2]]),billboard:true,depthTest:false,renderOrder:20},pixelScale:.002}).handle);
    const archetypes=new Map(closure.plan.proxyArchetypes.map((entry:any)=>[entry.id,entry]));for(const placement of closure.plan.placements){const archetype=archetypes.get(placement.archetypeId) as any;labels.push(ui.create(world.scene,"label",{text:`PROXY ${short(placement.id)}${placement.facingTargetId===null?"":` → ${short(placement.facingTargetId)}`}`,anchor:{kind:"world",position:localLabel([placement.position[0],placement.position[1]+archetype.dimensions[1]+.18,placement.position[2]]),billboard:true,depthTest:false,renderOrder:21},pixelScale:.002}).handle);}
    labels.push(ui.create(world.scene,"hudPanel",{title:"I1 PROXY-ONLY REVIEW",lines:["green  activity zones","cyan   proxy envelopes",`white  facing arrows (${proxies.inventory.facingMarkers})`,"amber  use clearances","blue   navigation","red    door swing","violet hearth clearance","no furniture meshes"],anchor:{kind:"screen",corner:"top-left",marginPx:[24,24],distance:.12,renderOrder:30},width:520,maxLines:8,pixelScale:.001}).handle);
    let proxiesVisible=true,current=authority.evidenceViews[0];const apply=()=>{shell.mesh!.visible=current.shellVisible;proxies.group.visible=proxiesVisible&&current.proxiesVisible;for(const handle of labels){const mesh=ui.mesh(handle);if(mesh)mesh.visible=proxies.group.visible;}};apply();
    return Object.freeze({entity,inventory:proxies.inventory,labelCount:labels.length,setEvidenceView:(id:StagedInteriorProxyReviewAuthority["evidenceViews"][number]["id"])=>{const view=authority.evidenceViews.find(candidate=>candidate.id===id);if(!view)throw new Error(`unknown I1 evidence view ${id}`);current=view;proxiesVisible=true;apply();return view;},setCurrentSubjectVisible:(visible:boolean)=>{proxiesVisible=visible;apply();},updateLabels:(camera:any,width:number,height:number,dtMs=0)=>ui.update(camera,width,height,dtMs),dispose:async()=>{ui.clear();world.scene.remove(proxies.group);proxies.dispose();if(entity!==undefined){await invoke("scene.destroyEntity",{entity});entity=undefined;}}});
  }catch(error){ui.clear();world.scene.remove(proxies.group);proxies.dispose();if(entity!==undefined)try{await registry.invoke("scene.destroyEntity",{entity},{...base,tick:tick++});}catch{}throw error;}
}
