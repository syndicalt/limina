import { readFileSync } from "node:fs";
import { parseFunctionalBuildingContract } from "../src/assets/functional-building-contract.ts";
import { parseFunctionalBuildingStaticBatch } from "../src/skills/functional-building-lod.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`p_architecture_lod_package FAIL: ${message}`); }
const path=process.argv[2];assert(path,"usage: bun run js/test/p_architecture_lod_package.ts <architecture-lod.glb>");
const bytes=readFileSync(path),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
const functional=parseFunctionalBuildingContract(bytes),parsedBatch=parseFunctionalBuildingStaticBatch(bytes);
assert(functional.buildingId==="hall-house/temperate/v4"&&functional.rootNodeId==="building/root","functional building authority drifted");
assert(functional.colliders.length===37&&functional.doors.length===1,"shell collider or operable-door closure drifted");
assert(parsedBatch?.lodRoots.length===3,"runtime static-batch parser rejected the package");
assert(view.getUint32(0,true)===0x46546c67&&view.getUint32(4,true)===2&&view.getUint32(8,true)===bytes.byteLength,"invalid GLB 2.0 envelope");
const jsonLength=view.getUint32(12,true);assert(view.getUint32(16,true)===0x4e4f534a,"missing JSON chunk");
const gltf=JSON.parse(new TextDecoder().decode(bytes.subarray(20,20+jsonLength)).trim()) as any,batch=gltf.asset?.extras?.liminaStaticBatch;
assert(batch?.schema==="limina.static-batch/1","static batch authority missing");
assert(Array.isArray(batch.lodRoots)&&batch.lodRoots.length===3&&new Set(batch.lodRoots).size===3,"exactly three unique LOD roots are required");
assert(Array.isArray(batch.measurements)&&batch.measurements.length===3,"LOD measurements missing");
const descendants=(root:number)=>{const found=new Set<number>();const visit=(index:number)=>{assert(!found.has(index),`cycle/duplicate below node ${root}`);found.add(index);for(const child of gltf.nodes[index]?.children??[])visit(child);};visit(root);return found;};
const lodSets=batch.lodRoots.map((root:number)=>descendants(root)),doorSet=descendants(batch.doorRoot);
const sceneRoots=gltf.scenes?.[gltf.scene??0]?.nodes??[],buildingRoot=gltf.nodes.findIndex((node:any)=>(node.extras?.limina?.id??node.extras?.["limina.id"])==="building/root"),buildingSet=descendants(buildingRoot);
assert(sceneRoots.length===1&&sceneRoots[0]===buildingRoot,"building/root is not the sole canonical scene root");
const semanticNodes=gltf.nodes.map((node:any,index:number)=>({index,id:node.extras?.limina?.id??node.extras?.["limina.id"]})).filter((entry:any)=>typeof entry.id==="string");
assert(semanticNodes.length===654&&new Set(semanticNodes.map((entry:any)=>entry.id)).size===654,"integrated semantic inventory drifted");
assert(semanticNodes.every((entry:any)=>buildingSet.has(entry.index)),"semantic node escaped the canonical building root");
assert(batch.lodRoots.every((root:number)=>buildingSet.has(root)),"LOD root escaped the canonical building root");
const semanticRole=(node:any)=>node.extras?.limina?.role??node.extras?.["limina.role"];
assert(gltf.nodes.filter((node:any)=>semanticRole(node)==="collider").length===123,"integrated shell/furniture collider inventory drifted");
assert(gltf.nodes.filter((node:any)=>semanticRole(node)==="socket").length===12,"integrated furniture socket inventory drifted");
assert(gltf.nodes.filter((node:any)=>semanticRole(node)==="composition-instance").length===7,"integrated composition-instance inventory drifted");
for(const set of lodSets)for(const node of doorSet)assert(!set.has(node),"articulated door leaked into a static LOD batch");
assert(gltf.nodes[batch.doorRoot]?.mesh!==undefined,"articulated door root lost its authored mesh");
const componentCount=(type:string)=>({SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16} as Record<string,number>)[type];
for(let level=0;level<3;level++){
  const root=gltf.nodes[batch.lodRoots[level]],children=root.children??[];let triangles=0;
  for(const nodeIndex of children){const mesh=gltf.meshes[gltf.nodes[nodeIndex].mesh];assert(mesh?.primitives?.length===1,`LOD${level} batch node is not one draw primitive`);const primitive=mesh.primitives[0],accessor=gltf.accessors[primitive.indices];assert(componentCount(accessor.type)===1&&accessor.count%3===0,`LOD${level} batch has invalid triangle indices`);triangles+=accessor.count/3;assert(gltf.nodes[nodeIndex].extras?.liminaBatch?.lod===level,`LOD${level} child metadata drifted`);}
  const measured=batch.measurements[level];assert(measured.level===level&&measured.draws===children.length&&measured.triangles===triangles,`LOD${level} measurements do not match encoded geometry`);
}
assert(batch.measurements[0].triangles>batch.measurements[1].triangles&&batch.measurements[1].triangles>batch.measurements[2].triangles,"LOD triangles do not strictly descend");
let staticSources=0;
for(const [nodeIndex,node] of gltf.nodes.entries()){
  if(doorSet.has(nodeIndex))continue;
  const levels=node.extras?.limina?.lodLevels;
  const shellSource=Array.isArray(levels)&&levels.length>0;
  const furnitureSource=node.extras?.["limina.role"]==="furniture-part"&&batch.furniturePolicy==="LOD0-only";
  if(!shellSource&&!furnitureSource)continue;
  staticSources++;assert(node.mesh===undefined,"static semantic source retained duplicate render geometry");const range=node.extras?.visualBatchRange;assert(range?.schema==="limina.visual-batch-range/1"&&range.authoritative===true&&range.indexCount>0,"LOD0 semantic visual range missing");assert(lodSets[0].has(range.batchNode),"semantic visual range points outside LOD0");
  if(furnitureSource)assert(range.sourceKind==="furniture","LOD0-only furniture range lacks explicit source kind");
}
assert(staticSources===batch.measurements[0].sourcePrimitiveCount,"LOD0 semantic-source coverage is incomplete");
console.log(`p_architecture_lod_package OK: ${batch.measurements.map((m:any)=>`LOD${m.level} ${m.triangles} tris/${m.draws} draws`).join(", ")}; door isolated; ${staticSources} semantic sources range-mapped`);
