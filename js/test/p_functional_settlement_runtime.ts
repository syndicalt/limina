import { z } from "../build/zod.bundle.mjs";
import { AssetRegistry } from "../src/asset-registry.ts";
import {
  FUNCTIONAL_BUILDING_CATALOG_SCHEMA, FUNCTIONAL_BUILDING_LOD_PROOF_SCHEMA,
  deriveFunctionalBuildingContractHash, deriveFunctionalBuildingSemanticIdentity,
} from "../src/assets/functional-building-catalog.mjs";
import { FUNCTIONAL_BUILDING_CONTRACT_V2, parseFunctionalBuildingContract } from "../src/assets/functional-building-contract.ts";
import { encodeFunctionalBuildingSiteArtifact, resolveFunctionalBuildingSiteArtifact } from "../src/assets/functional-building-site-artifact.mjs";
import {
  FUNCTIONAL_SETTLEMENT_ATLAS_REF_SCHEMA, FUNCTIONAL_SETTLEMENT_CATALOG_REF_SCHEMA, FUNCTIONAL_SETTLEMENT_ENTRY_CONNECTOR_SCHEMA,
  FUNCTIONAL_SETTLEMENT_PLAN_SCHEMA, FUNCTIONAL_SETTLEMENT_RESIDENCY_SCHEMA, FUNCTIONAL_SETTLEMENT_SITE_REF_SCHEMA,
  deriveFunctionalSettlementPlacementId,
} from "../src/assets/functional-settlement-plan.mjs";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { registerFunctionalSettlementSkills } from "../src/skills/functional-settlement.ts";
import { createFunctionalSettlementRuntimeResidency } from "../src/skills/functional-settlement-runtime-residency.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { worldMapContentHash } from "../src/world/worldmap.ts";
import { sha256 } from "../src/world/sha256.mjs";
import { installSeededRandom } from "../src/worldlog/log.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`p_functional_settlement_runtime FAIL: ${message}`); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function makeWorld(worldOps: EngineOps): WorldContext { const ecs=createEcsWorld(); return { ecs, transforms:createTransformStorage(ecs), spatial:new UniformGridSpatialIndex(), entities:new EntityTable(), tags:new Map(),
  scene:{add(){},remove(){},position:{set(){},x:0,y:0,z:0},background:null}, camera:{position:{set(){}},aspect:1,lookAt(){},updateProjectionMatrix(){}}, ops:worldOps, mode:"headless", simWorker:true } as WorldContext; }
function ok(response: MCPResponse): Record<string,unknown> { if (!response.success) throw new Error(response.error?.message ?? "unknown skill failure"); return response.result as Record<string,unknown>; }
async function rejects(promise: Promise<unknown>, pattern: RegExp, message: string) { try { await promise; } catch (error) { if (pattern.test(error instanceof Error?error.message:String(error))) return; throw error; } throw new Error(`p_functional_settlement_runtime FAIL: ${message}`); }
const node=(id:string,role:string,data:Record<string,unknown>={})=>({extras:{limina:{id,role,...data}}});
const site={ footprintCenter:[0,0], footprintHalfExtents:[3,2], finishedFloorY:0, terrainClearance:.1, vegetationClearance:1, maximumTerrainRelief:.25,
  entranceSupport:{sourcePrimitiveId:"primitive/entry-bearing",center:[-2.5,-2],halfExtents:[.8,.8],yawRadians:0,exteriorGradeY:0,bearingDepth:.4,maximumCutDepth:.2,maximumVariation:.2} };
const nodes:any[]=[node("building/root","root"),node("room/main","room"),node("portal/front","portal"),
  node("collider/floor","collider",{shape:"box",center:[0,-.1,0],halfExtents:[3,.1,2]}),
  node("collider/back","collider",{shape:"box",center:[0,1.5,2],halfExtents:[3,1.5,.1]}),
  node("collider/left","collider",{shape:"box",center:[-3,1.5,0],halfExtents:[.1,1.5,2]}),
  node("collider/right","collider",{shape:"box",center:[3,1.5,0],halfExtents:[.1,1.5,2]}),
  node("collider/front-a","collider",{shape:"box",center:[.5,1.5,-2],halfExtents:[2.5,1.5,.1]}),
  node("primitive/entry-bearing","architecture-primitive",{box:{center:[-2.5,-.3,-2],halfExtents:[.8,.1,.8],yawRadians:0}}),
  node("door/front","door",{roomId:"room/main",portalId:"portal/front",hinge:[-2,1,-2],center:[0,0,0],halfExtents:[.08,1,.5],closedYaw:0,openYaw:-Math.PI/2})];
nodes[0]={...nodes[0],children:nodes.slice(1).map((_,i)=>i+1)};
const fixture:any={asset:{version:"2.0",extras:{liminaStaticBatch:{schema:"limina.static-batch/1",lodRoots:[20,21,22],doorRoot:23},liminaFunctionalBuilding:{schema:FUNCTIONAL_BUILDING_CONTRACT_V2,units:"meter",up:"Y",buildingId:"fixture/settlement-house",rootNodeId:"building/root",roomIds:["room/main"],portalIds:["portal/front"],entryAnchor:[-2.5,0,-2],site,
  rooms:[{id:"room/main",bounds:{center:[0,1.5,0],halfExtents:[3,1.5,2]},finishedFloorY:0,ceilingY:3,storey:0,visibilityCellId:"cell/main",acoustics:{absorption:.2,reverb:.3}}],
  portals:[{id:"portal/front",kind:"door",exterior:true,roomIds:[null,"room/main"],center:[-2,1,-2],halfExtents:[.1,1,.5],acousticTransmission:.7,doorId:"door/front"}],verticalLinks:[],
  spawnAnchors:[{id:"spawn/main",roomId:"room/main",kind:"player",position:[0,0,0],direction:[0,0,-1],clearanceRadius:.35,clearanceHeight:1.8}],visibilityCells:[{id:"cell/main",roomIds:["room/main"],nodeIds:["room/main"]}]}}},scene:0,scenes:[{nodes:[0]}],nodes,animations:[{name:"door/front/open",channels:[{target:{node:9,path:"rotation"}}],samplers:[]}]};
const buildingBytes=new TextEncoder().encode(JSON.stringify(fixture)), contract:any=parseFunctionalBuildingContract(buildingBytes), semantic=deriveFunctionalBuildingSemanticIdentity(contract);
const functional:any={entryId:"building/house",placementClass:"functional-building",asset:{assetId:"buildings/house.gltf",hashKind:"raw-sha256",hash:`sha256:${sha256(buildingBytes)}`,byteLength:buildingBytes.byteLength},variant:{familyId:"house/timber",variantId:"a"},functionalContract:{schema:FUNCTIONAL_BUILDING_CONTRACT_V2,hash:deriveFunctionalBuildingContractHash(contract)},semanticIdentity:semantic,
  lodSemanticIdentity:{schema:FUNCTIONAL_BUILDING_LOD_PROOF_SCHEMA,articulatedDoorPolicy:"shared-outside-static-lods",articulatedDoorRootIndex:23,levels:[20,21,22].map((rootIndex,level)=>({level,rootIndex,semanticFingerprint:semantic.fingerprint}))}};
const catalog:any={schema:FUNCTIONAL_BUILDING_CATALOG_SCHEMA,catalogId:"settlement/runtime",revision:1,entries:[functional]};
const planId="settlement/runtime-proof", yaw=.713, rootY=5.1, atlasY=0, terrain=()=>5;
const bases=[{anchorId:"anchor/a",x:750000.25,z:-420000.75,unit:"residency/a"},{anchorId:"anchor/b",x:750020.25,z:-420000.75,unit:"residency/b"}];
const c=Math.cos(yaw),s=Math.sin(yaw), localAnchor=[-2.5,rootY,-2] as const, localOutward=[0,-1] as const;
const placement=(base:typeof bases[number])=>{const routeContact=[base.x+localAnchor[0]*c+localAnchor[2]*s,rootY,base.z-localAnchor[0]*s+localAnchor[2]*c];return {placementId:deriveFunctionalSettlementPlacementId(planId,base.anchorId,functional.entryId),catalogEntryId:functional.entryId,catalogContractHash:functional.functionalContract.hash,semanticFingerprint:semantic.fingerprint,position:[base.x,atlasY,base.z],yaw,
  atlasBinding:{anchorId:base.anchorId,routeId:"route/main",anchorPosition:[base.x,atlasY,base.z],anchorYaw:yaw},entryConnector:{schema:FUNCTIONAL_SETTLEMENT_ENTRY_CONNECTOR_SCHEMA,kind:"exterior-entry",portalId:"portal/front",localAnchor,localOutward,routeContact,worldOutward:[localOutward[0]*c+localOutward[1]*s,-localOutward[0]*s+localOutward[1]*c]},
  siteFoundation:{schema:FUNCTIONAL_SETTLEMENT_SITE_REF_SCHEMA,artifactId:`site/${base.anchorId}`,path:`sites/${base.anchorId}.json`,sha256:"pending"},residency:{schema:FUNCTIONAL_SETTLEMENT_RESIDENCY_SCHEMA,unitId:base.unit,policy:"whole-building-atomic",cellIds:["cell/main"]}};};
const placements:any[]=bases.map(placement).sort((a,b)=>a.placementId.localeCompare(b.placementId));
const worldMap:any={version:1,id:"atlas/runtime",unitsPerMeter:1,origin:[700000,-500000],extent:{w:100000,h:100000},seaLevel:0,land:[],relief:[],biomes:[],waterways:[],routes:[{id:"route/main",points:placements.map(p=>[p.entryConnector.routeContact[0],p.entryConnector.routeContact[2]]),class:"road"}],anchors:bases.map(base=>({id:base.anchorId,kind:"asset",position:[base.x,base.z],rot:yaw,source:"map"})),provenance:{tool:"design-space",contentHash:"pending"}};
worldMap.provenance.contentHash=worldMapContentHash(worldMap); const worldMapHash=`sha256:${worldMap.provenance.contentHash}`;
const siteBytes=new Map<string,Uint8Array>(); for(const p of placements){const artifact=resolveFunctionalBuildingSiteArtifact({artifactId:p.siteFoundation.artifactId,placementId:p.placementId,contractHash:p.catalogContractHash,semanticFingerprint:p.semanticFingerprint,worldMapHash,contract,position:p.position,yaw:p.yaw,routeContact:p.entryConnector.routeContact,sampleHeight:terrain,maximumSampleSpacing:.5,maximumTerrainGrade:.1,maximumRouteElevationDelta:.2});const bytes=encodeFunctionalBuildingSiteArtifact(artifact);p.siteFoundation.sha256=`sha256:${sha256(bytes)}`;siteBytes.set(p.siteFoundation.path,bytes);}
const plan:any={schema:FUNCTIONAL_SETTLEMENT_PLAN_SCHEMA,planId,catalog:{schema:FUNCTIONAL_SETTLEMENT_CATALOG_REF_SCHEMA,catalogId:catalog.catalogId,revision:1},atlas:{schema:FUNCTIONAL_SETTLEMENT_ATLAS_REF_SCHEMA,worldMapHash,mapId:worldMap.id},placements};

ops.op_physics_create_world(0); installSeededRandom(0xFB5,true); const permissions=resolveProfile("builder.readWrite");
function runtime(hook?: (id:string,index:number)=>void, siteOverride?:Map<string,Uint8Array>, sampler:(x:number,z:number)=>number|undefined=terrain, destroyHook?: (id:string,index:number)=>void){const assets=new AssetRegistry(ops);assets.seed(functional.asset.assetId,buildingBytes);for(const [path,bytes] of siteOverride??siteBytes)assets.seed(path,bytes);const world=makeWorld(ops),registry=new SkillRegistry(new LiminaTracer("fb5-runtime"));const core=registerCoreSkills(registry,{assets});
  // Rebind with the exact test terrain seam while preserving all core building skills.
  registry.unregister("settlement.placeFunctional");registry.unregister("settlement.destroyFunctional");const manager=registerFunctionalSettlementSkills(registry,assets,{sampleHeight:sampler,beforeBuildingPlacement:hook,beforeBuildingDestroy:destroyHook});let genericCalls=0;registry.replace("asset.place",{name:"asset.place",version:"trap",description:"trap",category:"scene",permissions:["scene.write"],input:z.unknown(),output:z.unknown(),handler(){genericCalls++;throw new Error("generic asset.place forbidden");}} as any);
  const at=(tick:number)=>({agentId:"builder",sessionId:"fb5",permissions,tick,world});return {assets,world,registry,core,manager,at,genericCalls:()=>genericCalls};}
const request={settlementId:"settlement/runtime-instance",catalog,plan,worldMap,connectorToleranceM:0};
const live=runtime(), result=ok(await live.registry.invoke("settlement.placeFunctional",request,live.at(1))), handles=result.buildings as any[];
assert(handles.length===2&&live.manager.size()===1&&live.core.functionalBuildings.topologyManager.size()===2,"success did not own two functional buildings/topologies");
assert(handles.every((h,i)=>h.position[1]===rootY&&h.yaw===yaw&&h.atlasRouteId==="route/main"&&h.root),"root Y/yaw/route authority was not retained");
assert(live.genericCalls()===0&&[...live.world.entities.ids()].filter(id=>live.world.entities.resolve(id)?.origin?.tool==="building.placeFunctional").length===2,"placement did not exclusively use building.placeFunctional");
const destroyed=ok(await live.registry.invoke("settlement.destroyFunctional",{settlementId:request.settlementId},live.at(2)));assert(destroyed.buildingsRemoved===2&&live.manager.size()===0&&live.core.functionalBuildings.topologyManager.size()===0,"destroy leaked ownership/topology");
assert(ok(await live.registry.invoke("settlement.destroyFunctional",{settlementId:request.settlementId},live.at(3))).buildingsRemoved===0,"destroy is not idempotent");

let destroyFault=true;const retryableDestroy=runtime(undefined,undefined,terrain,(_id,index)=>{if(index===1&&destroyFault){destroyFault=false;throw new Error("injected-mid-destroy");}});ok(await retryableDestroy.registry.invoke("settlement.placeFunctional",request,retryableDestroy.at(1)));
await rejects((async()=>{const response=await retryableDestroy.registry.invoke("settlement.destroyFunctional",{settlementId:request.settlementId},retryableDestroy.at(2));if(!response.success)throw new Error(response.error?.message);})(),/injected-mid-destroy/,"mid-destroy failure was not surfaced");
assert(retryableDestroy.manager.get(request.settlementId)?.buildings.length===1&&retryableDestroy.core.functionalBuildings.topologyManager.size()===1,"mid-destroy failure did not retain only still-live ownership");
assert(ok(await retryableDestroy.registry.invoke("settlement.destroyFunctional",{settlementId:request.settlementId},retryableDestroy.at(3))).buildingsRemoved===1&&retryableDestroy.manager.size()===0&&retryableDestroy.core.functionalBuildings.topologyManager.size()===0,"deterministic destroy retry did not finish remaining unit");

let visits=0;const failing=runtime((_id,index)=>{visits++;if(index===1)throw new Error("injected-mid-plan");});
await rejects((async()=>{const response=await failing.registry.invoke("settlement.placeFunctional",request,failing.at(1));if(!response.success)throw new Error(response.error?.message);})(),/injected-mid-plan/,"injected failure was not surfaced");
assert(visits===2&&failing.manager.size()===0&&failing.core.functionalBuildings.topologyManager.size()===0&&[...failing.world.entities.ids()].length===0,"mid-plan failure did not roll back every entity/topology");

for(const [label,mutate,pattern] of [
  ["asset hash",(r:any)=>{r.catalog.entries[0].asset.hash=`sha256:${"9".repeat(64)}`;},/raw asset hash mismatch/],
  ["semantic",(r:any)=>{r.plan.placements[0].semanticFingerprint=`sha256:${"8".repeat(64)}`;},/semantic fingerprint/],
  ["site hash",(r:any)=>{r.plan.placements[0].siteFoundation.sha256=`sha256:${"7".repeat(64)}`;},/exact settlement reference/],
] as const){const candidate=clone(request) as any;mutate(candidate);const rt=runtime();await rejects((async()=>{const response=await rt.registry.invoke("settlement.placeFunctional",candidate,rt.at(1));if(!response.success)throw new Error(response.error?.message);})(),pattern,`${label} drift was accepted`);assert([...rt.world.entities.ids()].length===0&&rt.manager.size()===0,`${label} drift mutated the world`);}
const inertCandidate=clone(request) as any;inertCandidate.catalog.entries.push({entryId:"prop/crate",placementClass:"inert-prop",asset:{assetId:"props/crate.glb",hashKind:"raw-sha256",hash:`sha256:${"1".repeat(64)}`,byteLength:1},variant:{familyId:"prop/crate",variantId:"a"},inert:{schema:"limina.inert-prop-declaration/v1",interactive:false,enterable:false}});inertCandidate.plan.placements[0].catalogEntryId="prop/crate";
const inertRt=runtime();await rejects((async()=>{const response=await inertRt.registry.invoke("settlement.placeFunctional",inertCandidate,inertRt.at(1));if(!response.success)throw new Error(response.error?.message);})(),/inert|placementId/,"inert catalog entry was placed");assert([...inertRt.world.entities.ids()].length===0,"inert rejection mutated world");
const terrainDrift=runtime(undefined,undefined,()=>5.01);await rejects((async()=>{const response=await terrainDrift.registry.invoke("settlement.placeFunctional",request,terrainDrift.at(1));if(!response.success)throw new Error(response.error?.message);})(),/does not reproduce|bindings|route contact/,"live site drift was accepted");assert([...terrainDrift.world.entities.ids()].length===0,"live site drift mutated world");
let getterExecuted=false;const accessorRequest=clone(request) as any;Object.defineProperty(accessorRequest.catalog.entries[0],"entryId",{enumerable:true,get(){getterExecuted=true;throw new Error("hostile getter executed");}});const accessorRt=runtime();await rejects((async()=>{const response=await accessorRt.registry.invoke("settlement.placeFunctional",accessorRequest,accessorRt.at(1));if(!response.success)throw new Error(response.error?.message);})(),/data field/,"hostile accessor was accepted");assert(!getterExecuted&&[...accessorRt.world.entities.ids()].length===0,"Zod/placement executed hostile getter or mutated world");
const prototypeRequest=clone(request) as any;Object.setPrototypeOf(prototypeRequest.plan.placements[0],{hostile:true});const prototypeRt=runtime();await rejects((async()=>{const response=await prototypeRt.registry.invoke("settlement.placeFunctional",prototypeRequest,prototypeRt.at(1));if(!response.success)throw new Error(response.error?.message);})(),/plain object/,"prototyped nested plan record was accepted");assert([...prototypeRt.world.entities.ids()].length===0,"prototype rejection mutated world");

const streaming=runtime();let streamTick=10;const residency=createFunctionalSettlementRuntimeResidency(streaming.registry,streaming.manager,{namespace:"proof/runtime",catalog,plan,worldMap,loadDistance:4,keepDistance:8,maxActiveUnits:2,maxResidentBytes:buildingBytes.byteLength*2,invokeBase:()=>streaming.at(streamTick++)});
const nearest=bases[0]!;let snapshot=await residency.update([nearest.x,atlasY,nearest.z]);assert(snapshot.residentUnitIds.length===1&&streaming.manager.size()===1&&streaming.core.functionalBuildings.topologyManager.size()===1,"runtime residency did not stage one whole nearby building");
residency.setExplicitInterest(["residency/a","residency/b"]);snapshot=await residency.update([nearest.x,atlasY,nearest.z]);assert(snapshot.residentUnitIds.join(",")==="residency/a,residency/b"&&streaming.manager.size()===2&&streaming.core.functionalBuildings.topologyManager.size()===2,"explicit interest did not load complete functional units");
residency.setExplicitInterest([]);snapshot=await residency.update([900000,atlasY,-900000]);assert(snapshot.residentUnitIds.length===0&&streaming.manager.size()===0&&streaming.core.functionalBuildings.topologyManager.size()===0,"runtime residency did not atomically unload whole buildings");await residency.close();assert(streaming.genericCalls()===0,"runtime residency used generic asset.place");
let unloadCalls=0,unloadFault=true;const atomicStreaming=runtime(undefined,undefined,terrain,()=>{unloadCalls++;if(unloadCalls===2&&unloadFault){unloadFault=false;throw new Error("injected-residency-unload");}});let atomicTick=30;const atomicResidency=createFunctionalSettlementRuntimeResidency(atomicStreaming.registry,atomicStreaming.manager,{namespace:"proof/atomic",catalog,plan,worldMap,loadDistance:4,keepDistance:8,maxActiveUnits:2,maxResidentBytes:buildingBytes.byteLength*2,invokeBase:()=>atomicStreaming.at(atomicTick++)});atomicResidency.setExplicitInterest(["residency/a","residency/b"]);await atomicResidency.update([nearest.x,atlasY,nearest.z]);atomicResidency.setExplicitInterest([]);
await rejects(atomicResidency.update([900000,atlasY,-900000]),/injected-residency-unload/,"residency mid-unload failure was not surfaced");assert(atomicResidency.snapshot().residentUnitIds.length===2&&atomicStreaming.manager.size()===2&&atomicStreaming.core.functionalBuildings.topologyManager.size()===2,"residency rollback did not restore the exact prior whole-building set");
assert((await atomicResidency.update([900000,atlasY,-900000])).residentUnitIds.length===0&&atomicStreaming.manager.size()===0&&atomicStreaming.core.functionalBuildings.topologyManager.size()===0,"residency unload retry did not close the whole-building set");await atomicResidency.close();

console.log("p_functional_settlement_runtime OK: exact preflight, arbitrary-yaw/large-coordinate functional placement, route/site ownership, mid-plan rollback, drift/inert rejection, and idempotent destroy without asset.place");
