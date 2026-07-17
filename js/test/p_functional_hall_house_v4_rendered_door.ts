import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { Position, Rotation, createEcsWorld, renderSyncSystem } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { parseFunctionalBuildingContract } from "../src/assets/functional-building-contract.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_functional_hall_house_v4_rendered_door FAIL: ${message}`);
}
function ok(response: MCPResponse): Record<string, unknown> {
  if (!response.success) throw new Error(JSON.stringify(response.error));
  return response.result as Record<string, unknown>;
}
function makeWorld(worldOps: EngineOps): WorldContext {
  const ecs=createEcsWorld(),scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(55,16/9,.05,100);
  return {ecs,transforms:createTransformStorage(ecs),spatial:new UniformGridSpatialIndex(),entities:new EntityTable(),tags:new Map(),scene,camera,ops:worldOps,mode:"headless",simWorker:false} as unknown as WorldContext;
}
const near=(actual:number,expected:number,label:string,tolerance=1e-5)=>assert(Math.abs(actual-expected)<=tolerance,`${label}: ${actual} != ${expected}`);
const ASSET="buildings/functional-hall-house-v4.glb",bytes=ops.op_read_asset(ASSET),contract=parseFunctionalBuildingContract(bytes),doorContract=contract.doors[0]!;
ops.op_physics_create_world(0);ops.op_physics_add_ground(0);ops.op_physics_step();
const world=makeWorld(ops),registry=new SkillRegistry(new LiminaTracer("hall-v4-rendered-door"));registerCoreSkills(registry);
const at=(tick:number)=>({agentId:"builder",sessionId:"hall-v4-rendered-door",permissions:resolveProfile("builder.readWrite"),tick,world});
const placed=ok(await registry.invoke("building.placeFunctional",{assetId:ASSET,position:[0,0,0],yaw:0},at(1))),root=placed.root as string,door=placed.doors[0] as string;
const rootEntry=world.entities.resolve(root)!,doorEntry=world.entities.resolve(door)!,doorMesh=doorEntry.mesh as unknown as THREE.Object3D;
assert(rootEntry.mesh!==undefined&&doorMesh!==undefined,"real GLB render objects were not mounted");
const semanticDoorCount=(subject:THREE.Object3D):number=>{let count=0;subject.traverse(node=>{if((node.userData as {limina?:{id?:string}}).limina?.id==="door/front")count++;});return count;};
assert(semanticDoorCount(rootEntry.mesh as unknown as THREE.Object3D)===0,"detached leaf remains duplicated in the static building root");
assert(semanticDoorCount(doorMesh)===1,"runtime door entity does not own exactly one semantic leaf");
let meshCount=0;doorMesh.traverse(node=>{if((node as THREE.Mesh).isMesh)meshCount++;});assert(meshCount===18,`rendered leaf subtree has ${meshCount}/18 meshes`);

renderSyncSystem(world.ecs);doorMesh.updateMatrixWorld(true);
const childMatrices=new Map<string,number[]>();doorMesh.traverse(node=>{if(node!==doorMesh)childMatrices.set(node.name,[...node.matrix.elements]);});
near(doorMesh.position.x,doorContract.hinge[0],"closed render hinge x");near(doorMesh.position.y,doorContract.hinge[1],"closed render hinge y");near(doorMesh.position.z,doorContract.hinge[2],"closed render hinge z");

ok(await registry.invoke("door.setOpen",{door,open:true},at(2)));renderSyncSystem(world.ecs);doorMesh.updateMatrixWorld(true);
near(doorMesh.position.x,doorContract.hinge[0],"open render hinge x");near(doorMesh.position.y,doorContract.hinge[1],"open render hinge y");near(doorMesh.position.z,doorContract.hinge[2],"open render hinge z");
near(2*Math.atan2(Rotation.y[doorEntry.eid],Rotation.w[doorEntry.eid]),doorContract.openYaw,"rendered leaf yaw");
doorMesh.traverse(node=>{if(node!==doorMesh)assert(JSON.stringify([...node.matrix.elements])===JSON.stringify(childMatrices.get(node.name)),`${node.name} did not move as a rigid hinge-local assembly`);});

const state=doorEntry.origin!.input as {colliderEntity:string},collider=world.entities.resolve(state.colliderEntity)!;
const c=Math.cos(doorContract.openYaw),s=Math.sin(doorContract.openYaw),expectedCenter=[doorContract.hinge[0]+doorContract.center[0]*c+doorContract.center[2]*s,doorContract.hinge[1]+doorContract.center[1],doorContract.hinge[2]-doorContract.center[0]*s+doorContract.center[2]*c];
near(Position.x[collider.eid],expectedCenter[0]!,"open collider center x");near(Position.y[collider.eid],expectedCenter[1]!,"open collider center y");near(Position.z[collider.eid],expectedCenter[2]!,"open collider center z");
near(2*Math.atan2(Rotation.y[collider.eid],Rotation.w[collider.eid]),doorContract.openYaw,"open collider yaw");

// Dense rays through the useful center of the real rendered aperture prove
// that the articulated triangles—not merely the abstract collider—park clear.
const ray=new THREE.Raycaster(),direction=new THREE.Vector3(0,0,1);
for(let yi=0;yi<=8;yi++)for(let xi=0;xi<=8;xi++){
  const x=-1.10+xi*(.80/8),y=.22+yi*(1.95/8);ray.set(new THREE.Vector3(x,y,-4.5),direction);
  const hit=ray.intersectObject(doorMesh,true).find(candidate=>candidate.distance<2.0);
  assert(hit===undefined,`open rendered leaf occludes usable portal at x=${x.toFixed(3)}, y=${y.toFixed(3)}`);
}
const removed=ok(await registry.invoke("building.destroyFunctional",{root},at(3))).removed as number;
assert(removed===1+contract.colliders.length+2,"rendered building lifecycle leaked entities");
console.log(`p_functional_hall_house_v4_rendered_door OK: one 18-mesh rigid leaf, renderer/collider agree at ${(Math.abs(doorContract.openYaw)*180/Math.PI).toFixed(0)} degrees, 81 aperture rays clear`);
