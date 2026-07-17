import { AssetRegistry } from "../asset-registry.ts";
import { LiminaTracer } from "../observability/event.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { sha256 } from "../world/sha256.mjs";
import { interiorPlacementFacetScope } from "../assets/building-interior-plan-v2.mjs";

export type V3 = readonly [number, number, number];
const HASH = /^sha256:[0-9a-f]{64}$/;
const REQUIRED_VIEWS = "front,right-side,back,three-quarter,joinery-detail";
type ExactFile={readonly path:string;readonly sha256:string;readonly contentHash:string};
type Facet={readonly scope:string;readonly hash:string};
type ApprovedDependency=ExactFile&{readonly artifactId:string;readonly kind:"interior-plan"|"material-palette";readonly revision:number;readonly status:"approved";readonly contractHash:string;readonly assetContentHash:string;readonly decision:ExactFile&{readonly decisionId:string};readonly facets:readonly Facet[]};
export type FurnitureReviewView={readonly id:string;readonly type:"silhouette"|"functional"|"construction"|"cohesion"|"joinery"|"interaction";readonly state:"static"|"closed"|"open";readonly role:string;readonly position:V3;readonly target:V3;readonly fovDeg:number;readonly near:number;readonly far:number;readonly distanceM:number};

/** Keep the human-scale marker laterally outside the subject for any canonical front axis. */
export function furnitureReviewScaleProxyPosition(bounds:Readonly<{min:V3;max:V3}>,frontCameraPosition:V3,proxyHeight:number):V3{
  const center:V3=bounds.min.map((value,index)=>(value+bounds.max[index])*.5) as unknown as V3,frontDelta:V3=[frontCameraPosition[0]-center[0],0,frontCameraPosition[2]-center[2]],frontLength=Math.hypot(frontDelta[0],frontDelta[2]);
  if(frontLength<1e-6)throw new Error("furniture review front camera has no horizontal axis");
  const frontAxis:V3=[frontDelta[0]/frontLength,0,frontDelta[2]/frontLength],rightAxis:V3=[-frontAxis[2],0,frontAxis[0]],halfX=(bounds.max[0]-bounds.min[0])*.5,halfZ=(bounds.max[2]-bounds.min[2])*.5,lateralExtent=Math.abs(rightAxis[0])*halfX+Math.abs(rightAxis[2])*halfZ,offset=lateralExtent+.3;
  return[center[0]-rightAxis[0]*offset,proxyHeight/2,center[2]-rightAxis[2]*offset];
}

export interface FurniturePackReviewAuthority {
  readonly schema: "limina.furniture-pack-review-scene/v1";
  readonly pack: {
    readonly id: string;
    readonly kind: string;
    readonly assetId: string;
    readonly sha256: string;
    readonly assetHash: string;
    readonly payloadHash: string;
    readonly sourceSpecHash: string;
    readonly sourceIrHash: string;
    readonly primitiveCount: number;
    readonly evidencePath: string;
    readonly evidenceSha256: string;
  };
  readonly source: { readonly blendPath: string; readonly blendSha256: string; readonly blenderVersion: string };
  readonly visualDesign:{readonly path:string;readonly sha256:string;readonly contentHash:string;readonly id:string;readonly hash:string;readonly cueIds:readonly string[];readonly requiredViews:readonly string[]};
  readonly functionalEvidence:{readonly schema:"limina.furniture-functional-evidence/v1";readonly verdict:"pass";readonly path:string;readonly sha256:string;readonly contentHash:string;readonly inputs:{readonly furnitureContractHash:string;readonly runtimeGlbSha256:string;readonly runtimeSemanticInventorySha256:string;readonly interiorArtifactId:string;readonly interiorContractHash:string;readonly interiorContentHash:string;readonly selectedProxyArchetypeId:string};readonly checks:readonly{readonly id:string;readonly passed:true;readonly findings:readonly[];readonly metrics:Readonly<Record<string,number|string|boolean>>}[];readonly summary:{readonly passed:number;readonly failed:0};readonly policy:Readonly<Record<string,number>>;readonly contractPath:string;readonly contractSha256:string;readonly contractContentHash:string;readonly contractHash:string;readonly parts:number;readonly joints:number;readonly sockets:number;readonly occupancySockets:number;readonly approachSockets:number;readonly colliders:number;readonly materialRoles:readonly string[];readonly collisionPolicy:"compound-semantic";readonly placementSkill:"furniture.placeFunctional"};
  readonly dependencies:{readonly interior:{readonly artifact:ApprovedDependency;readonly plan:ExactFile&{readonly planId:string;readonly revision:number;readonly canonicalHash:string};readonly selectedProxy:{readonly archetypeId:string;readonly kind:string;readonly dimensions:V3;readonly supportKind:string;readonly requiresApproach:boolean;readonly requiresOccupancy:boolean;readonly placementFacetHash:string;readonly placementIds:readonly string[]}};readonly materials:{readonly artifact:ApprovedDependency;readonly requiredFacets:readonly Facet[]}};
  readonly bounds: { readonly min: V3; readonly max: V3 };
  readonly placement: { readonly position: V3; readonly rotation: V3; readonly ground: false; readonly scale: V3 };
  readonly presentation: {
    readonly minimumResolution: readonly [number, number];
    readonly fixedTimeSeconds: number;
    readonly warmupFrames: number;
    readonly neutralFloor: true;
    readonly humanScaleProxyHeightM: number;
  };
  readonly evidenceViews: readonly FurnitureReviewView[];
}

function vector(value: unknown, label: string): asserts value is V3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) throw new Error(`furniture review authority has an invalid ${label}`);
}

export function validateFurniturePackReviewAuthority(value: unknown): FurniturePackReviewAuthority {
  const a = value as Partial<FurniturePackReviewAuthority>;
  if (a.schema !== "limina.furniture-pack-review-scene/v1") throw new Error("unsupported furniture pack review authority");
  if (!a.pack?.id || !a.pack.kind || !a.pack.assetId || !HASH.test(a.pack.sha256) || !HASH.test(a.pack.assetHash)
      || !HASH.test(a.pack.payloadHash) || !HASH.test(a.pack.sourceSpecHash) || !HASH.test(a.pack.sourceIrHash)
      || !Number.isSafeInteger(a.pack.primitiveCount) || a.pack.primitiveCount < 1
      || !a.pack.evidencePath || !HASH.test(a.pack.evidenceSha256)) throw new Error("furniture review authority is missing exact pack identities");
  if (!a.source?.blendPath || !HASH.test(a.source.blendSha256) || !a.source.blenderVersion) throw new Error("furniture review authority is missing editable source identity");
  const visual=a.visualDesign;if(!visual?.path||!visual.id||![visual.sha256,visual.contentHash,visual.hash].every(value=>HASH.test(value))||!Array.isArray(visual.cueIds)||visual.cueIds.length<1||new Set(visual.cueIds).size!==visual.cueIds.length||!Array.isArray(visual.requiredViews)||visual.requiredViews.length<5||new Set(visual.requiredViews).size!==visual.requiredViews.length)throw new Error("furniture review authority lacks exact visual cue closure");
  const f=a.functionalEvidence;if(f?.schema!=="limina.furniture-functional-evidence/v1"||f.verdict!=="pass"||!f.path||![f.sha256,f.contentHash,f.inputs?.furnitureContractHash,f.inputs?.runtimeGlbSha256,f.inputs?.runtimeSemanticInventorySha256,f.inputs?.interiorContractHash,f.inputs?.interiorContentHash].every(value=>HASH.test(value))||!f.inputs?.interiorArtifactId||!f.inputs.selectedProxyArchetypeId||!Array.isArray(f.checks)||f.checks.length<1||f.checks.some(check=>check.passed!==true||!Array.isArray(check.findings)||check.findings.length!==0)||f.summary?.failed!==0||f.summary.passed!==f.checks.length||!f.contractPath||![f.contractSha256,f.contractContentHash,f.contractHash].every(value=>HASH.test(value))||![f.parts,f.joints,f.sockets,f.occupancySockets,f.approachSockets,f.colliders].every(value=>Number.isSafeInteger(value)&&value>=0)||(f.parts??0)<1||(f.joints??0)<1||(f.sockets??0)<1||(f.colliders??0)<2||!Array.isArray(f.materialRoles)||f.materialRoles.length<1||f.collisionPolicy!=="compound-semantic"||f.placementSkill!=="furniture.placeFunctional")throw new Error("furniture review authority lacks an exact passing functional verifier closure");
  const deps=a.dependencies;if(!deps?.interior?.artifact||!deps.materials?.artifact)throw new Error("furniture review authority lacks approved I1/M1 dependencies");
  for(const [label,dependency,kind] of [["I1",deps.interior.artifact,"interior-plan"],["M1",deps.materials.artifact,"material-palette"]] as const){if(dependency.kind!==kind||dependency.status!=="approved"||!dependency.artifactId||!Number.isSafeInteger(dependency.revision)||dependency.revision<1||![dependency.sha256,dependency.contentHash,dependency.contractHash,dependency.assetContentHash,dependency.decision.sha256,dependency.decision.contentHash].every(value=>HASH.test(value))||!dependency.path||!dependency.decision.path||!dependency.decision.decisionId||!Array.isArray(dependency.facets)||dependency.facets.some(facet=>!facet.scope||!HASH.test(facet.hash)))throw new Error(`furniture review authority has an invalid ${label} dependency`);}
  const plan=deps.interior.plan,selected=deps.interior.selectedProxy;if(!plan.path||!plan.planId||!Number.isSafeInteger(plan.revision)||![plan.sha256,plan.contentHash,plan.canonicalHash,selected.placementFacetHash].every(value=>HASH.test(value))||!selected.archetypeId||!selected.kind||!selected.supportKind||typeof selected.requiresApproach!=="boolean"||typeof selected.requiresOccupancy!=="boolean"||!Array.isArray(selected.placementIds)||selected.placementIds.length<1)throw new Error("furniture review authority has an invalid selected I1 proxy binding");vector(selected.dimensions,"selected proxy dimensions");
  const placementScope=plan.revision>=2?interiorPlacementFacetScope(selected.archetypeId):"placements",expectedInteriorScopes=[placementScope,"support-bindings"];if(deps.interior.artifact.facets.map(facet=>facet.scope).join(",")!==expectedInteriorScopes.join(",")||deps.interior.artifact.facets[0]?.hash!==selected.placementFacetHash)throw new Error("furniture review authority lacks the exact selected I1 placement facet");
  if(f.inputs.furnitureContractHash!==f.contractHash||f.inputs.runtimeGlbSha256!==a.pack.sha256||f.inputs.interiorArtifactId!==deps.interior.artifact.artifactId||f.inputs.interiorContractHash!==deps.interior.artifact.contractHash||f.inputs.interiorContentHash!==deps.interior.artifact.assetContentHash||f.inputs.selectedProxyArchetypeId!==selected.archetypeId)throw new Error("furniture review authority functional verifier inputs drifted from its runtime/I1 closure");
  const requiredScopes=["role-contract","surface-parameters","runtime-textures"];if(deps.materials.requiredFacets.map(facet=>facet.scope).join(",")!==requiredScopes.join(",")||deps.materials.requiredFacets.some(facet=>!HASH.test(facet.hash)))throw new Error("furniture review authority lacks exact required M1 facets");
  vector(a.bounds?.min, "minimum bounds"); vector(a.bounds?.max, "maximum bounds");
  if (a.bounds!.max.some((n, i) => n <= a.bounds!.min[i])) throw new Error("furniture review authority bounds must have positive extent");
  vector(a.placement?.position, "placement position"); vector(a.placement?.rotation, "placement rotation"); vector(a.placement?.scale, "placement scale");
  if (a.placement!.ground !== false || a.placement!.scale.some((n) => n <= 0)) throw new Error("furniture review authority requires authored-scale local-origin placement");
  const resolution = a.presentation?.minimumResolution;
  if (!Array.isArray(resolution) || resolution.length !== 2 || !resolution.every((n) => Number.isSafeInteger(n) && n >= 720)
      || !Number.isSafeInteger(a.presentation?.warmupFrames) || a.presentation!.warmupFrames < 1 || a.presentation!.warmupFrames > 120
      || !Number.isFinite(a.presentation?.fixedTimeSeconds) || a.presentation!.fixedTimeSeconds < 0
      || a.presentation?.neutralFloor !== true || !Number.isFinite(a.presentation?.humanScaleProxyHeightM) || a.presentation!.humanScaleProxyHeightM <= 0) {
    throw new Error("furniture review authority has an invalid presentation contract");
  }
  if (!Array.isArray(a.evidenceViews) || a.evidenceViews.length<5 || a.evidenceViews.slice(0,5).map((view) => view.id).join(",") !== REQUIRED_VIEWS||new Set(a.evidenceViews.map(view=>view.id)).size!==a.evidenceViews.length) throw new Error("furniture review authority is missing the canonical evidence views");
  for (const view of a.evidenceViews) {
    if (!view.role || !["silhouette","functional","construction","cohesion","joinery","interaction"].includes(view.type)||!["static","closed","open"].includes(view.state)||!Number.isFinite(view.fovDeg) || view.fovDeg < 15 || view.fovDeg > 80 || !Number.isFinite(view.near) || view.near <= 0
        || !Number.isFinite(view.far) || view.far <= view.near || !Number.isFinite(view.distanceM) || view.distanceM <= 0) throw new Error(`furniture review view ${view.id} is invalid`);
    vector(view.position, `${view.id} camera position`); vector(view.target, `${view.id} camera target`);
  }
  return a as FurniturePackReviewAuthority;
}

/** Mount through the functional furniture skill used by composed worlds, including semantic sockets and compound collision. */
export async function mountFurniturePackReview(world: WorldContext, authority: FurniturePackReviewAuthority): Promise<{ entity: string; assetHash: string; authoritativeBounds: V3; stageEntities: readonly string[]; functionalEvidence:FurniturePackReviewAuthority["functionalEvidence"]; setSubjectVisible(visible: boolean): void; setScaleProxyVisible(visible: boolean): void; setReviewState(view:FurnitureReviewView):string; dispose(): Promise<void> }> {
  validateFurniturePackReviewAuthority(authority);
  const bytes = world.ops.op_read_asset(`assets/${authority.pack.assetId}`);
  if (`sha256:${sha256(bytes)}` !== authority.pack.sha256 || portableAssetContentHash(bytes) !== authority.pack.assetHash) throw new Error("furniture review asset bytes do not match the pinned identities");
  const assets = new AssetRegistry(world.ops); assets.seed(authority.pack.assetId, bytes);
  const registry = new SkillRegistry(new LiminaTracer("furniture-pack-engine-review")); registerCoreSkills(registry, { assets });
  const base = { agentId: "furniture-pack-review", sessionId: "furniture-pack-review", permissions: resolveProfile("builder.readWrite"), tick: 0, world };
  const result = await registry.invoke("furniture.placeFunctional", { assetId: authority.pack.assetId, hash: authority.pack.assetHash, contractHash:authority.functionalEvidence.contractHash, position: authority.placement.position, yaw:authority.placement.rotation[1] }, base);
  if (!result.success) throw new Error(`furniture.placeFunctional failed: ${JSON.stringify(result.error)}`);
  const placed = result.result as { root: string; colliders:string[]; sockets:{id:string;kind:string;position:V3;clearanceRadiusM:number}[]; hash: string; contractHash:string };
  if (placed.hash !== authority.pack.assetHash||placed.contractHash!==authority.functionalEvidence.contractHash||placed.colliders.length!==authority.functionalEvidence.colliders||placed.sockets.length!==authority.functionalEvidence.sockets) throw new Error("furniture.placeFunctional returned unpinned or incomplete semantic evidence");
  const expectedBounds=authority.bounds.max.map((value,index)=>value-authority.bounds.min[index]) as unknown as V3;
  const entity = world.entities.resolve(placed.root);
  if (!entity?.mesh) throw new Error("furniture review functional placement did not create an engine render root");
  let tick=1;
  const invoke=async(name:string,input:unknown)=>{const response=await registry.invoke(name,input,{...base,tick:tick++});if(!response.success)throw new Error(`${name} failed: ${JSON.stringify(response.error)}`);return response.result as Record<string,unknown>;};
  const floor=(await invoke("scene.createEntity",{shape:"box",size:8,color:0x77736b,pbr:true,position:[0,-4,0]})).entity as string;
  await invoke("three.setMaterial",{entity:floor,roughness:.92,metalness:0,receiveShadow:true});
  const proxyHeight=authority.presentation.humanScaleProxyHeightM,frontView=authority.evidenceViews[0],proxyPosition=furnitureReviewScaleProxyPosition(authority.bounds,frontView.position,proxyHeight);
  const proxy=(await invoke("scene.createEntity",{shape:"box",size:proxyHeight,color:0xaaa69e,pbr:true,position:proxyPosition})).entity as string;
  await invoke("three.setTransform",{entity:proxy,scale:[.07,1,.07]});
  await invoke("three.setMaterial",{entity:proxy,roughness:.8,metalness:0,castShadow:true,receiveShadow:true});
  await invoke("three.setMaterial",{entity:placed.root,castShadow:true,receiveShadow:true});
  await invoke("three.setLighting",{ambientColor:0xe8edf5,ambientIntensity:1.15,directionalColor:0xfff2dd,directionalIntensity:2.8,direction:[4,7,5],castShadow:true,shadowMapSize:2048,shadowCameraExtent:6});
  const socketMarkers:string[]=[];for(const socket of placed.sockets){const marker=(await invoke("scene.createEntity",{shape:"sphere",size:Math.max(.08,Math.min(.18,socket.clearanceRadiusM*.3)),color:socket.kind==="occupancy"?0x37d67a:socket.kind==="approach"?0x3f8cff:0xffc247,pbr:true,position:socket.position})).entity as string;socketMarkers.push(marker);}
  const contractBytes=world.ops.op_read_asset(authority.functionalEvidence.contractPath);if(`sha256:${sha256(contractBytes)}`!==authority.functionalEvidence.contractSha256||portableAssetContentHash(contractBytes)!==authority.functionalEvidence.contractContentHash)throw new Error("furniture functional design contract bytes drifted");
  const contract=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(contractBytes)) as {colliders:{center:V3;halfExtents:V3}[]};const collisionMarkers:string[]=[];for(const collider of contract.colliders){const marker=(await invoke("scene.createEntity",{shape:"box",size:1,color:0xe34b4b,pbr:true,position:collider.center})).entity as string;await invoke("three.setTransform",{entity:marker,scale:collider.halfExtents.map(value=>value*2)});collisionMarkers.push(marker);}
  const stageEntities=Object.freeze([floor,proxy,...socketMarkers,...collisionMarkers]);
  const proxyEntity=world.entities.resolve(proxy);if(!proxyEntity?.mesh)throw new Error("furniture review scale proxy has no render mesh");
  const setGroup=(ids:readonly string[],visible:boolean)=>{for(const id of ids){const entry=world.entities.resolve(id);if(entry?.mesh)entry.mesh.visible=visible;}};setGroup(socketMarkers,false);setGroup(collisionMarkers,false);
  return Object.freeze({ entity: placed.root, assetHash: placed.hash, authoritativeBounds:Object.freeze([...expectedBounds]) as unknown as V3, stageEntities, functionalEvidence:authority.functionalEvidence, setSubjectVisible:(visible:boolean)=>{entity.mesh!.visible=visible;}, setScaleProxyVisible:(visible:boolean)=>{proxyEntity.mesh!.visible=visible;}, setReviewState:(view:FurnitureReviewView)=>{const socketVisible=view.id==="socket-overlay",collisionVisible=view.id==="collision-overlay";setGroup(socketMarkers,socketVisible);setGroup(collisionMarkers,collisionVisible);return `${view.type}:${view.state}`;}, dispose: async () => {
    const failures:unknown[]=[];
    for(const candidate of [...stageEntities].reverse()){const removed=await registry.invoke("scene.destroyEntity",{entity:candidate},{...base,tick:tick++});if(!removed.success)failures.push(new Error(`scene.destroyEntity failed for ${candidate}: ${JSON.stringify(removed.error)}`));}
    const removed=await registry.invoke("furniture.destroyFunctional",{root:placed.root},{...base,tick:tick++});if(!removed.success)failures.push(new Error(`furniture.destroyFunctional failed: ${JSON.stringify(removed.error)}`));
    if(failures.length)throw new AggregateError(failures,"furniture review stage disposal failed");
  } });
}
