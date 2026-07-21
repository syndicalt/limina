import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { parseFunctionalBuildingContract } from "../src/assets/functional-building-contract.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`p_functional_hall_house_v4_traversal FAIL: ${message}`); }
function ok(response: MCPResponse): Record<string, unknown> { if (!response.success) throw new Error(JSON.stringify(response.error)); return response.result as Record<string, unknown>; }
function makeWorld(worldOps: EngineOps): WorldContext { const ecs=createEcsWorld(); return { ecs, transforms:createTransformStorage(ecs), spatial:new UniformGridSpatialIndex(), entities:new EntityTable(), tags:new Map(),
  scene:{add(){},remove(){},position:{set(){},x:0,y:0,z:0},background:null},camera:{position:{set(){}},aspect:1,lookAt(){},updateProjectionMatrix(){}},ops:worldOps,mode:"headless",simWorker:true } as WorldContext; }
const ASSET="buildings/functional-hall-house-v4.glb", contract=parseFunctionalBuildingContract(ops.op_read_asset(ASSET)), perms=resolveProfile("builder.readWrite");
assert(contract.buildingId==="hall-house/temperate/v4"&&contract.doors.length===1,"wrong v4 traversal authority");
async function traverse(open:boolean,yaw=0):Promise<[number,number,number]>{
  ops.op_physics_create_world(0);ops.op_physics_add_ground(0);ops.op_physics_step();const world=makeWorld(ops),registry=new SkillRegistry(new LiminaTracer(`hall-v4-${open}-${yaw}`));registerCoreSkills(registry);
  const at=(tick:number)=>({agentId:"builder",sessionId:"hall-v4",permissions:perms,tick,world});const placed=ok(await registry.invoke("building.placeFunctional",{assetId:ASSET,position:[0,0,0],yaw},at(1)));
  assert((placed.parts as string[]).length===contract.colliders.length,"placement omitted decomposed v4 shell bodies");const door=(placed.doors as string[])[0];if(open)ok(await registry.invoke("door.setOpen",{door,open:true},at(2)));
  const local:[number,number,number]=[contract.entryAnchor[0],.85,contract.entryAnchor[2]-.5],c=Math.cos(yaw),s=Math.sin(yaw),start:[number,number,number]=[local[0]*c+local[2]*s,local[1],-local[0]*s+local[2]*c];
  const player=ok(await registry.invoke("player.spawn",{position:start},at(3))).entity as string;let final=start;
  for(let i=0;i<85;i++)final=ok(await registry.invoke("player.move",{entity:player,forward:1,yaw:Math.PI-yaw},at(4+i))).newPosition as [number,number,number];
  const before=world.entities.ids().length,removed=ok(await registry.invoke("building.destroyFunctional",{root:placed.root},at(100))).removed as number,expected=1+contract.colliders.length+2;
  assert(removed===expected&&world.entities.ids().length===before-expected,`v4 lifecycle leaked ${removed}/${expected} building entities`);return final;
}
const closed=await traverse(false),opened=await traverse(true),rotated=await traverse(true,Math.PI/2);
assert(closed[2]<-3.8,`closed authored v4 leaf did not block capsule: ${closed[2]}`);
assert(opened[2]>-2.5,`open v4 portal did not admit capsule: ${opened[2]}`);
assert(rotated[0]>-2.5,`rotated v4 portal did not admit capsule: ${rotated[0]}`);
console.log(`p_functional_hall_house_v4_traversal OK: closed=${closed[2].toFixed(3)}, open=${opened[2].toFixed(3)}, rotated=${rotated[0].toFixed(3)}, ${contract.colliders.length} decomposed bodies`);
