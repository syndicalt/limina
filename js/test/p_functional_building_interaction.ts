import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld, Position, Rotation, spawnRenderable } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { captureWorldSnapshot, restoreSnapshot } from "../src/worldlog/snapshot.ts";
import { installSeededRandom } from "../src/worldlog/log.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";
import { AssetRegistry } from "../src/asset-registry.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`p_functional_building_interaction FAIL: ${message}`); }
function ok(response: MCPResponse): Record<string, unknown> { if (!response.success) throw new Error(JSON.stringify(response.error)); return response.result as Record<string, unknown>; }
const inert = () => ({ position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } });
function makeWorld(worldOps: EngineOps): WorldContext {
  const ecs = createEcsWorld();
  return { ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(), entities: new EntityTable(), tags: new Map(),
    scene: { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null },
    camera: { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} }, ops: worldOps, mode: "headless", simWorker: true } as WorldContext;
}
function entity(world: WorldContext, position: [number,number,number], bodyId?: number): string {
  const eid=spawnRenderable(world.ecs,inert() as never,...position),id=world.entities.create({eid,...(bodyId===undefined?{}:{bodyId})});
  return id;
}

ops.op_physics_create_world(0);
installSeededRandom(0xFB3, true);
const fixture={asset:{version:"2.0",extras:{liminaFunctionalBuilding:{schema:"limina.functional-building/v1",units:"meter",up:"Y",buildingId:"fixture/fb3",rootNodeId:"building/root",roomIds:["room/main"],portalIds:["portal/front"],entryAnchor:[0,0,-1]}}},scene:0,scenes:[{nodes:[0]}],nodes:[
  {children:[1,2,3,4,5,6,7,8],extras:{limina:{id:"building/root",role:"root"}}},
  {extras:{limina:{id:"room/main",role:"room"}}},{extras:{limina:{id:"portal/front",role:"portal"}}},
  ...Array.from({length:5},(_,i)=>({extras:{limina:{id:`collider/${i}`,role:"collider",shape:"box",halfExtents:[.1,1,1],center:[i-2,1,0]}}})),
  {extras:{limina:{id:"door/front",role:"door",roomId:"room/main",portalId:"portal/front",hinge:[0,1,0],closedYaw:0,openYaw:-Math.PI/2,halfExtents:[.5,1,.08],center:[.5,0,0]}}}
],animations:[{name:"door/front/open",channels:[{target:{node:8,path:"rotation"}}],samplers:[]}]};
const assets=new AssetRegistry(ops);assets.seed("buildings/fb3-fixture.gltf",new TextEncoder().encode(JSON.stringify(fixture)));
const sounds:{freq:number;position:readonly number[]}[]=[];
const doorAudio={playAt(freq:number,_secs:number,position:readonly [number,number,number]){sounds.push({freq,position});return `test-sound-${sounds.length}`;}};
const world=makeWorld(ops), registry=new SkillRegistry(new LiminaTracer("fb3-interaction")),core=registerCoreSkills(registry,{assets,functionalDoorAudio:doorAudio}),perms=resolveProfile("builder.readWrite");
const at=(tick:number)=>({agentId:"builder",sessionId:"fb3",permissions:perms,tick,world});
const placed=ok(await registry.invoke("building.placeFunctional",{assetId:"buildings/fb3-fixture.gltf",position:[20,0,30],yaw:.4},at(0))),placedDoor=(placed.doors as string[])[0]!,placedRoot=placed.root as string;
assert(core.interaction.interactionManager.get(placedDoor)?.prompt==="Open door","placement did not register the door affordance");
const placedPortal=(world.entities.resolve(placedDoor)!.origin!.input as Record<string,unknown>).portalRuntimeId as string;
assert(core.nav.navmeshManager.isPortalOpen(placedPortal)===false,"placement did not register the closed nav portal");
ok(await registry.invoke("building.destroyFunctional",{root:placedRoot},at(0)));
assert(core.interaction.interactionManager.get(placedDoor)===undefined&&core.nav.navmeshManager.isPortalOpen(placedPortal)===undefined,"destroy did not unregister door affordance/portal");
const base:[number,number,number]=[100000,1,-200000],yaw=Math.PI/3;
const colliderBody=ops.op_physics_add_static_box(base[0],base[1],base[2],.5,1,.08,.85,0),collider=entity(world,base,colliderBody),door=entity(world,base);
world.tags.set(world.entities.resolve(collider)!.eid,new Set(["functional-building-part"]));
world.tags.set(world.entities.resolve(door)!.eid,new Set(["functional-building-part","functional-door","door-closed"]));
world.entities.resolve(door)!.origin={tool:"building.functionalDoor",input:{assetId:"test",hash:"0".repeat(64),position:base,buildingYaw:yaw,
  door:{id:"door/front",nodeId:"door/front",roomId:"room/main",portalId:"portal/front",hinge:[0,0,0],closedYaw:0,openYaw:-Math.PI/2,halfExtents:[.5,1,.08],center:[.5,0,0]},
  colliderEntity:collider,open:false,locked:true,keyId:"key/front",portalRuntimeId:"test-root:portal/front"}};
const actor=ok(await registry.invoke("player.spawn",{position:[base[0],base[1],base[2]+1.5]},at(1))).entity as string;
ok(await registry.invoke("inventory.create",{entity:actor,capacity:2},at(2)));
let actorEntry=world.entities.resolve(actor)!;ops.op_physics_set_body_transform(actorEntry.bodyId!,base[0],base[1],base[2]+4,0,0,0,1);Position.z[actorEntry.eid]=base[2]+4;ops.op_physics_step();
let generic=ok(await registry.invoke("interaction.interact",{entity:door,actorEntity:actor},at(2))),result=generic.result as Record<string,unknown>;
assert(generic.ok===false,"generic out-of-range refusal was wrapped as success");
assert(result.ok===false&&result.reason==="out-of-range"&&sounds.length===0,"out-of-range refusal mutated audio/state");
ops.op_physics_set_body_transform(actorEntry.bodyId!,base[0],base[1],base[2]+1.5,0,0,0,1);Position.z[actorEntry.eid]=base[2]+1.5;ops.op_physics_step();
const query=ok(await registry.invoke("interaction.query",{actorEntity:actor,maxRange:3},at(3))).interactables as {entity:string;prompt:string}[];
assert(query.some(item=>item.entity===door&&item.prompt==="Locked"),"snapshot-derived door prompt was not reconciled/queryable");
const originalRegister=core.interaction.interactionManager.register.bind(core.interaction.interactionManager);let derivedRegistrations=0;
core.interaction.interactionManager.register=(definition)=>{derivedRegistrations++;originalRegister(definition);};
const steadyRevision=core.nav.navmeshManager.getRevision();
ok(await registry.invoke("inventory.has",{entity:actor,itemId:"missing"},at(3)));
ok(await registry.invoke("inventory.has",{entity:actor,itemId:"missing"},at(3)));
assert(derivedRegistrations===0&&core.nav.navmeshManager.getRevision()===steadyRevision,"steady-state unrelated invocations rescanned/re-registered door derived state");
generic=ok(await registry.invoke("interaction.interact",{entity:door,actorEntity:actor},at(4)));
result=generic.result as Record<string,unknown>;
assert(generic.ok===false,"generic locked refusal was wrapped as success");
assert(result.ok===false&&result.reason==="locked","generic interaction bypassed lock");
ok(await registry.invoke("inventory.add",{entity:actor,itemId:"key/front",quantity:1},at(5)));
result=ok(await registry.invoke("interaction.interact",{entity:door,actorEntity:actor},at(6))).result as Record<string,unknown>;
assert(result.ok===true&&result.open===true,"key did not unlock/open through generic interaction");
assert(core.inventory.inventoryManager.hasItem(actor,"key/front"),"door consumed the persistent key");
assert(core.nav.navmeshManager.isPortalOpen("test-root:portal/front")===true,"open door did not open its nav portal");
assert(sounds.length===1&&sounds[0]!.freq===240&&JSON.stringify(sounds[0]!.position)===JSON.stringify(base),"open SFX was not emitted once at the exact world hinge");
core.nav.navmeshManager.build({bounds:{minX:base[0]-3,minZ:base[2]-3,maxX:base[0]+3,maxZ:base[2]+3},cellSize:.5});
assert(core.nav.navmeshManager.planPath("ai/test",[base[0],0,base[2]-2],[base[0],0,base[2]+2]),"AI fixture path did not plan");
const aiPathRevision=core.nav.navmeshManager.getAgent("ai/test")!.pathRevision;

// Move the actor into the prospective closed leaf. The close must be wholly atomic.
actorEntry=world.entities.resolve(actor)!;ops.op_physics_set_body_transform(actorEntry.bodyId!,base[0]+.25,base[1],base[2],0,0,0,1);Position.x[actorEntry.eid]=base[0]+.25;Position.y[actorEntry.eid]=base[1];Position.z[actorEntry.eid]=base[2];ops.op_physics_step();
const revision=core.nav.navmeshManager.getRevision();
generic=ok(await registry.invoke("interaction.interact",{entity:door,actorEntity:actor},at(7)));
result=generic.result as Record<string,unknown>;
assert(generic.ok===false,"generic occupied refusal was wrapped as success");
assert(result.ok===false&&result.reason==="occupied"&&result.open===true,"occupied close did not remain open");
assert(core.nav.navmeshManager.getRevision()===revision&&core.nav.navmeshManager.isPortalOpen("test-root:portal/front")===true,"occupied refusal mutated portal revision/state");
assert(sounds.length===1,"occupied refusal emitted audio");
ops.op_physics_set_body_transform(actorEntry.bodyId!,base[0],base[1],base[2]+2,0,0,0,1);Position.x[actorEntry.eid]=base[0];Position.z[actorEntry.eid]=base[2]+2;ops.op_physics_step();
result=ok(await registry.invoke("interaction.interact",{entity:door,actorEntity:actor},at(8))).result as Record<string,unknown>;
assert(result.ok===true&&result.open===false&&sounds.length===2&&sounds[1]!.freq===160,"clear close did not commit one close SFX");
assert(core.nav.navmeshManager.getRevision()>aiPathRevision&&core.nav.navmeshManager.getAgent("ai/test")!.pathRevision===aiPathRevision,"successful close did not invalidate the cached AI path revision");

// Snapshot restores entity origins but not closure managers. The registry-wide reconciler must
// rebuild both prompt dispatch and portal state before the first generic gameplay invocation.
const snapshot=captureWorldSnapshot(world,{sessionId:"fb3",tick:7,snapshotSeq:0}),restored=makeWorld(ops);restoreSnapshot(restored,snapshot);
const restoredRegistry=new SkillRegistry(new LiminaTracer("fb3-restored")),restoredCore=registerCoreSkills(restoredRegistry),restoredAt=(tick:number)=>({agentId:"builder",sessionId:"fb3-restored",permissions:perms,tick,world:restored});
const restoredQuery=ok(await restoredRegistry.invoke("interaction.query",{actorEntity:actor,maxRange:3},restoredAt(8))).interactables as {entity:string;prompt:string}[];
assert(restoredQuery.some(item=>item.entity===door&&item.prompt==="Open door"),"snapshot restore did not reconcile the door affordance");
assert(restoredCore.nav.navmeshManager.isPortalOpen("test-root:portal/front")===false,"snapshot restore did not reconcile portal state");
const restoredResult=ok(await restoredRegistry.invoke("interaction.interact",{entity:door,actorEntity:actor},restoredAt(9))).result as Record<string,unknown>;
assert(restoredResult.ok===true&&restoredResult.open===true&&restoredCore.nav.navmeshManager.isPortalOpen("test-root:portal/front")===true,"snapshot-restored generic interaction did not drive the reconciled portal");

console.log("p_functional_building_interaction OK: generic prompt/dispatch, persistent key, occupied-close atomicity, portal revision, large-coordinate yaw, snapshot reconciliation");
