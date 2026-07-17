import crypto from "node:crypto";
import fs from "node:fs";
import sharp from "../node_modules/sharp/lib/index.js";
import { parseFunctionalBuildingContract } from "../src/assets/functional-building-contract.ts";
import { parseFunctionalBuildingVisualContract } from "../src/assets/functional-building-visual-contract.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`p_functional_hall_house_v4_quality FAIL: ${message}`); }
type J = Record<string, any>; type V3 = [number, number, number]; type M4 = number[];
const assetSource=process.env.LIMINA_FUNCTIONAL_HALL_HOUSE_SOURCE??new URL("../../assets/buildings/functional-hall-house-v4.glb", import.meta.url);
const bytes = fs.readFileSync(assetSource);
const jsonLength = bytes.readUInt32LE(12), gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString().trim()) as J;
let offset = 12, bin = new Uint8Array();
while (offset < bytes.length) { const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4); if (type === 0x004e4942) bin = bytes.subarray(offset + 8, offset + 8 + length); offset += 8 + length; }
const functional = parseFunctionalBuildingContract(bytes), visual = parseFunctionalBuildingVisualContract(bytes);
assert(functional.buildingId === "hall-house/temperate/v4", "wrong functional building identity");
const expectedWindowIds = ["window/cross-gable", "window/dormer", "window/east", "window/north-west", "window/south-west", "window/west"];
const windowIds = visual.openings.filter((opening) => opening.kind === "window").map((opening) => opening.id).sort();
assert(visual.openings.length === 7 && JSON.stringify(windowIds) === JSON.stringify(expectedWindowIds), "all six exposed authored windows plus the exterior door are not authoritative");
assert(functional.doors[0]?.nodeId === visual.openings.find((opening) => opening.kind === "door")?.leafNodeId, "visual door leaf diverges from functional authority");

const identity = (): M4 => [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const mul = (a: M4, b: M4): M4 => Array.from({ length: 16 }, (_, i) => {
  const row = i % 4, col = Math.floor(i / 4); let sum = 0;
  for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k]; return sum;
});
const local = (node: J): M4 => {
  if (Array.isArray(node.matrix)) return node.matrix;
  const [x,y,z,w] = node.rotation ?? [0,0,0,1], [sx,sy,sz] = node.scale ?? [1,1,1], [tx,ty,tz] = node.translation ?? [0,0,0];
  return [(1-2*y*y-2*z*z)*sx,(2*x*y+2*z*w)*sx,(2*x*z-2*y*w)*sx,0,
    (2*x*y-2*z*w)*sy,(1-2*x*x-2*z*z)*sy,(2*y*z+2*x*w)*sy,0,
    (2*x*z+2*y*w)*sz,(2*y*z-2*x*w)*sz,(1-2*x*x-2*y*y)*sz,0, tx,ty,tz,1];
};
const parents = new Map<number, number>();
for (let i=0;i<(gltf.nodes?.length??0);i++) for (const child of gltf.nodes[i].children ?? []) parents.set(child, i);
const worldMemo = new Map<number,M4>();
const world = (index: number): M4 => { const cached=worldMemo.get(index); if(cached) return cached; const own=local(gltf.nodes[index]); const parent=parents.get(index); const result=parent===undefined?own:mul(world(parent),own); worldMemo.set(index,result); return result; };
const point = (m:M4,p:V3):V3 => [m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]];
const semantic = new Map<string,number>();
for (let i=0;i<(gltf.nodes?.length??0);i++) { const id=gltf.nodes[i].extras?.limina?.id; if(typeof id==="string") semantic.set(id,i); }
const resolveId=(...candidates:string[]):string=>{const found=candidates.find((id)=>semantic.has(id));assert(found!==undefined,`none of the semantic candidates resolve: ${candidates.join(", ")}`);return found;};
const bounds = (id:string):{min:V3;max:V3;center:V3} => {
  const index=semantic.get(id); assert(index!==undefined,`unresolved geometry node ${id}`); const node=gltf.nodes[index], mesh=gltf.meshes?.[node.mesh]; assert(mesh,`${id} has no mesh`);
  const corners:V3[]=[];
  for(const primitive of mesh.primitives){const accessor=gltf.accessors[primitive.attributes.POSITION];assert(accessor?.min&&accessor?.max,`${id} position bounds missing`);for(const x of [accessor.min[0],accessor.max[0]])for(const y of [accessor.min[1],accessor.max[1]])for(const z of [accessor.min[2],accessor.max[2]])corners.push(point(world(index),[x,y,z]));}
  const min:[number,number,number]=[0,1,2].map(axis=>Math.min(...corners.map(p=>p[axis]))) as V3, max:[number,number,number]=[0,1,2].map(axis=>Math.max(...corners.map(p=>p[axis]))) as V3;
  return {min,max,center:[(min[0]+max[0])/2,(min[1]+max[1])/2,(min[2]+max[2])/2]};
};
const nodeId = (index:number):string => gltf.nodes[index].extras?.limina?.id ?? gltf.nodes[index].name ?? `node[${index}]`;
const accessorValue = (accessor:J,index:number,component:number):number => {
  const view=gltf.bufferViews[accessor.bufferView],componentBytes:Record<number,number>={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4};
  const bytesPerComponent=componentBytes[accessor.componentType];assert(bytesPerComponent!==undefined,`unsupported accessor component ${accessor.componentType}`);
  const components:Record<string,number>={SCALAR:1,VEC2:2,VEC3:3,VEC4:4},componentCount=components[accessor.type];assert(componentCount!==undefined,`unsupported accessor type ${accessor.type}`);
  const byteOffset=(view.byteOffset??0)+(accessor.byteOffset??0)+index*(view.byteStride??bytesPerComponent*componentCount)+component*bytesPerComponent;
  const data=new DataView(bin.buffer,bin.byteOffset+byteOffset,bytesPerComponent);
  switch(accessor.componentType){case 5120:return data.getInt8(0);case 5121:return data.getUint8(0);case 5122:return data.getInt16(0,true);case 5123:return data.getUint16(0,true);case 5125:return data.getUint32(0,true);case 5126:return data.getFloat32(0,true);default:throw new Error("unreachable accessor component");}
};
const primitiveTriangles = (nodeIndex:number,primitive:J):readonly [V3,V3,V3][] => {
  const positionAccessor=gltf.accessors[primitive.attributes.POSITION],indices=primitive.indices===undefined?undefined:gltf.accessors[primitive.indices];
  const count=indices?.count??positionAccessor.count,result:[V3,V3,V3][]=[];
  const vertex=(i:number):V3=>point(world(nodeIndex),[accessorValue(positionAccessor,i,0),accessorValue(positionAccessor,i,1),accessorValue(positionAccessor,i,2)]);
  for(let i=0;i+2<count;i+=3){const at=(j:number)=>indices===undefined?j:accessorValue(indices,j,0);result.push([vertex(at(i)),vertex(at(i+1)),vertex(at(i+2))]);}
  return result;
};
const sub=(a:V3,b:V3):V3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],cross=(a:V3,b:V3):V3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const rayTriangleDistance=(origin:V3,direction:V3,triangle:readonly [V3,V3,V3]):number|undefined=>{
  const epsilon=1e-7,edge1=sub(triangle[1],triangle[0]),edge2=sub(triangle[2],triangle[0]),p=cross(direction,edge2),det=dot(edge1,p);
  if(Math.abs(det)<epsilon)return undefined;const inv=1/det,t=sub(origin,triangle[0]),u=dot(t,p)*inv;if(u<0||u>1)return undefined;
  const q=cross(t,edge1),v=dot(direction,q)*inv;if(v<0||u+v>1)return undefined;const distance=dot(edge2,q)*inv;return distance>epsilon?distance:undefined;
};
const inward:Record<string,V3>={south:[0,0,1],north:[0,0,-1],west:[1,0,0],east:[-1,0,0]};
const dot=(a:V3,b:V3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const exportedWindowGlass=[...gltf.nodes.entries()].filter(([,node]:[number,J])=>/^window\/.+\/glass$/.test(node.name??"")).map(([,node]:[number,J])=>node.name).sort();
const contractedWindowGlass=visual.openings.filter((opening)=>opening.kind==="window").map((opening)=>opening.glazingNodeId!).sort();
assert(JSON.stringify(exportedWindowGlass)===JSON.stringify(contractedWindowGlass),`exported window glass is not exactly contract-covered: ${JSON.stringify(exportedWindowGlass)} vs ${JSON.stringify(contractedWindowGlass)}`);
const glazingName=visual.materialRoles.find((role)=>role.role==="glazing")?.materialName;
const glazingMatches=gltf.materials.filter((material:J)=>material.name===glazingName);
assert(glazingMatches.length===1,"glazing role does not resolve to exactly one exported material");
const glazingMaterial=glazingMatches[0],glazingPbr=glazingMaterial.pbrMetallicRoughness??{},glazingAlpha=glazingPbr.baseColorFactor?.[3]??1;
assert(glazingMaterial.alphaMode==="BLEND",`glazing is ${glazingMaterial.alphaMode??"OPAQUE"}, not standard glTF alpha blend`);
assert(glazingAlpha>=.08&&glazingAlpha<=.35,`glazing opacity ${glazingAlpha} is outside the restrained leadlight range`);
assert((glazingPbr.metallicFactor??0)===0,"glazing is metallic");
assert((glazingPbr.roughnessFactor??1)>=.08&&(glazingPbr.roughnessFactor??1)<=.35,"glazing roughness is outside the leadlight range");
assert(glazingPbr.baseColorTexture===undefined&&glazingMaterial.normalTexture===undefined,"glazing uses a checker/opaque texture payload instead of restrained optical glass");
const opaqueTriangles:{id:string;triangles:readonly [V3,V3,V3][]}[]=[];
for(let nodeIndex=0;nodeIndex<gltf.nodes.length;nodeIndex++)for(const primitive of gltf.meshes?.[gltf.nodes[nodeIndex].mesh]?.primitives??[]){
  const material=gltf.materials?.[primitive.material];
  if(material===glazingMaterial)continue;
  opaqueTriangles.push({id:nodeId(nodeIndex),triangles:primitiveTriangles(nodeIndex,primitive)});
}
for(const opening of visual.openings){
  const direction=inward[opening.facade], depthAxis=opening.facade==="north"||opening.facade==="south"?2:0, crossAxis=depthAxis===2?0:2;
  const partId=opening.kind==="window"?opening.glazingNodeId!:opening.leafNodeId!, part=bounds(partId);
  if(opening.kind==="window"){
    assert(Math.abs(part.center[crossAxis]-opening.aperture.center[crossAxis])<.025&&Math.abs(part.center[1]-opening.aperture.center[1])<.025,
      `${opening.id} glazing is not aligned to the aperture on both cross axes`);
    assert(dot([part.center[0]-opening.aperture.center[0],part.center[1]-opening.aperture.center[1],part.center[2]-opening.aperture.center[2]],direction)>.12,
      `${opening.id} glazing is face-mounted/outside instead of recessed`);
  }
  const reveals=opening.revealNodeIds.map(bounds), aperture=opening.aperture;
  for(let i=0;i<reveals.length;i++) assert(reveals[i].max[depthAxis]-reveals[i].min[depthAxis]>=aperture.halfExtents[depthAxis]*1.5,
    `${opening.id} reveal ${i} has no credible opening depth`);
  assert(reveals[0].center[crossAxis]<aperture.center[crossAxis]&&reveals[1].center[crossAxis]>aperture.center[crossAxis],`${opening.id} side reveals do not bracket aperture`);
  assert(reveals[2].center[1]>aperture.center[1]&&reveals[3].center[1]<aperture.center[1],`${opening.id} top/bottom reveals do not bracket aperture`);
  for(const reveal of reveals.slice(0,2))assert(Math.abs(reveal.center[1]-aperture.center[1])<.03,`${opening.id} side reveal is vertically misaligned`);
  for(const reveal of reveals.slice(2))assert(Math.abs(reveal.center[crossAxis]-aperture.center[crossAxis])<.03,`${opening.id} top/bottom reveal is laterally misaligned`);
  const own=new Set([partId,...opening.revealNodeIds,...(opening.frameNodeIds??[]),...(opening.mullionNodeIds??[]),...(opening.cameNodeIds??[]),...(opening.plankNodeIds??[]),...(opening.ironworkNodeIds??[])]);
  // The functional leaf owns modeled stiles, rails, hardware, and future
  // construction descendants as one articulation. Ignore that complete leaf
  // assembly while proving the surrounding portal corridor.
  if(opening.kind==="door"){
    const leaf=semantic.get(partId);assert(leaf!==undefined,`${opening.id} leaf root is unresolved`);
    for(let nodeIndex=0;nodeIndex<gltf.nodes.length;nodeIndex++){
      let cursor:number|undefined=nodeIndex;
      while(cursor!==undefined){if(cursor===leaf){own.add(nodeId(nodeIndex));break;}cursor=parents.get(cursor);}
    }
  }
  const samples:[[number,number]]=[[0,0],[-.35,0],[.35,0],[0,-.35],[0,.35]];
  for(const [crossFraction,yFraction] of samples){
    const target:[number,number,number]=[aperture.center[0],aperture.center[1]+aperture.halfExtents[1]*yFraction,aperture.center[2]];
    target[crossAxis]+=aperture.halfExtents[crossAxis]*crossFraction;
    const check=(origin:V3,rayDirection:V3,length:number,label:string)=>{for(const candidate of opaqueTriangles){if(own.has(candidate.id))continue;for(const triangle of candidate.triangles){const hit=rayTriangleDistance(origin,rayDirection,triangle);assert(hit===undefined||hit>=length,`${opening.id} ${label} corridor is occluded by ${candidate.id} at ${hit?.toFixed(3)}m`);}}};
    const outward:[number,number,number]=[-direction[0],-direction[1],-direction[2]],outside:[number,number,number]=[target[0]+outward[0]*2.5,target[1],target[2]+outward[2]*2.5];
    check(outside,direction,2.5-aperture.halfExtents[depthAxis]-.01,"exterior");
    const inside:[number,number,number]=[target[0]+direction[0]*(aperture.halfExtents[depthAxis]+.01),target[1],target[2]+direction[2]*(aperture.halfExtents[depthAxis]+.01)];
    check(inside,direction,.70,"interior/roof-cutout");
  }
}

const rootIndex=semantic.get(visual.lod.lod0RootNodeId);assert(rootIndex!==undefined,"LOD0 root unresolved");let primitives=0,triangles=0;
const visit=(index:number)=>{const mesh=gltf.meshes?.[gltf.nodes[index].mesh];for(const primitive of mesh?.primitives??[]){primitives++;const count=primitive.indices===undefined?gltf.accessors[primitive.attributes.POSITION].count:gltf.accessors[primitive.indices].count;triangles+=Math.floor(count/3);}for(const child of gltf.nodes[index].children??[])visit(child);};visit(rootIndex);
assert(primitives<=visual.lod.drawBudget&&visual.lod.drawBudget<=640,`LOD0 primitive budget dishonest/unbounded: ${primitives}/${visual.lod.drawBudget}`);
assert(triangles<=visual.lod.triangleBudget&&visual.lod.triangleBudget<=150_000,`LOD0 triangle budget dishonest/unbounded: ${triangles}/${visual.lod.triangleBudget}`);

const imageBytes=(textureRecord:J):Buffer=>{const texture=gltf.textures[textureRecord.index],image=gltf.images[texture.source],view=gltf.bufferViews[image.bufferView];return Buffer.from(bin.subarray(view.byteOffset??0,(view.byteOffset??0)+view.byteLength));};
const normalHashes=new Set<string>(),albedoHashes=new Set<string>(),roughnessHashes=new Set<string>();
const texturedRoles=visual.materialRoles.filter((role)=>gltf.materials.find((material:J)=>material.name===role.materialName)?.extras?.limina_material_pack!==undefined);
const materialPacks=new Set<string>();
for(const role of texturedRoles){const material=gltf.materials.find((entry:J)=>entry.name===role.materialName);assert(typeof material?.extras?.limina_material_pack==="string",`${role.role} lacks a pinned material-pack identity`);materialPacks.add(material.extras.limina_material_pack);
  const normal=imageBytes(material.normalTexture), rough=imageBytes(material.pbrMetallicRoughness.metallicRoughnessTexture);
  const albedo=imageBytes(material.pbrMetallicRoughness.baseColorTexture),normalMeta=await sharp(normal).metadata(),roughMeta=await sharp(rough).metadata(),albedoMeta=await sharp(albedo).metadata();
  const normalStats=await sharp(normal).stats(),roughStats=await sharp(rough).stats();normalHashes.add(crypto.createHash("sha256").update(normal).digest("hex"));
  albedoHashes.add(crypto.createHash("sha256").update(albedo).digest("hex"));roughnessHashes.add(crypto.createHash("sha256").update(rough).digest("hex"));
  for(const [kind,meta] of [["albedo",albedoMeta],["roughness",roughMeta],["normal",normalMeta]] as const)assert((meta.width??0)>=1024&&(meta.height??0)>=1024,`${role.role} ${kind} map is below 1024px construction evidence floor`);
  assert(normalStats.channels.slice(0,2).some((channel)=>channel.stdev>1),`${role.role} normal map is effectively flat`);
  assert(roughStats.channels.some((channel)=>channel.stdev>1),`${role.role} roughness map is effectively flat`);
}
assert(materialPacks.size===6,"construction roles do not close to the six selected cottage material packs");
assert(normalHashes.size===materialPacks.size&&albedoHashes.size===materialPacks.size&&roughnessHashes.size===materialPacks.size,"embedded PBR payload identities do not match pinned material-pack reuse");

const roleMaterial=new Map(visual.materialRoles.map((role)=>[role.role,role.materialName]));
const nodeMaterials=(id:string):string[]=>{const index=semantic.get(id);assert(index!==undefined,`material node ${id} unresolved`);const mesh=gltf.meshes?.[gltf.nodes[index].mesh];assert(mesh,`${id} has no material mesh`);return mesh.primitives.map((primitive:J)=>gltf.materials[primitive.material].name);};
const descendantOf=(id:string,ancestorId:string):boolean=>{let index=semantic.get(id),ancestor=semantic.get(ancestorId);assert(index!==undefined&&ancestor!==undefined,"door hierarchy identity unresolved");while(index!==undefined){if(index===ancestor)return true;index=parents.get(index);}return false;};
const doorOpening=visual.openings.find((opening)=>opening.kind==="door")!;
assert(nodeMaterials(doorOpening.leafNodeId!).every((name)=>name===roleMaterial.get("door-surface")),"door leaf is not bound to declared door-surface PBR role");
for(const id of doorOpening.plankNodeIds!){assert(descendantOf(id,doorOpening.leafNodeId!),`${id} is not articulated under authored leaf`);assert(nodeMaterials(id).every((name)=>name===roleMaterial.get("door-surface")),`${id} lacks coherent door-oak binding`);}
for(const id of doorOpening.ironworkNodeIds!){assert(descendantOf(id,doorOpening.leafNodeId!),`${id} is not articulated under authored leaf`);assert(nodeMaterials(id).every((name)=>name===roleMaterial.get("door-hardware")),`${id} lacks black-iron binding`);}
assert(doorOpening.ironworkNodeIds!.some((id)=>/hinge/.test(id))&&doorOpening.ironworkNodeIds!.some((id)=>/latch|pull/.test(id)),"door ironwork lacks both hinge and latch/pull identities");

// The cycle-4 leaf passed ancestry tests while reading as a barred gate: its
// nominal "planks" were sparse battens, a stale transform exported its brace
// as a 2.42 m horizontal beam, and the 70-degree pose dominated the aperture.
// Measure the authored construction rather than trusting semantic labels.
const leafBounds=bounds(doorOpening.leafNodeId!),boardIds=doorOpening.plankNodeIds!.filter((id)=>/\/plank-\d+$/.test(id));
assert(boardIds.length===5,"door no longer has exactly five authored face boards");
const boards=boardIds.map(bounds).sort((a,b)=>a.min[0]-b.min[0]);
for(const [index,board] of boards.entries()){
  const width=board.max[0]-board.min[0],height=board.max[1]-board.min[1];
  assert(width>=.25&&width<=.28,`door board ${index} is a batten or oversized panel (${width.toFixed(3)}m)`);
  assert(height>=(leafBounds.max[1]-leafBounds.min[1])*.95,`door board ${index} does not cover the leaf height`);
  if(index>0){const seam=board.min[0]-boards[index-1]!.max[0];assert(seam>=.006&&seam<=.022,`door board seam ${index-1}/${index} is not credible (${seam.toFixed(3)}m)`);}
}
assert(boards.at(-1)!.max[0]-boards[0]!.min[0]>=(leafBounds.max[0]-leafBounds.min[0])*.98,"door boards do not form a continuous opaque face");
const brace=bounds("door/front/brace"),braceRun=brace.max[0]-brace.min[0],braceRise=brace.max[1]-brace.min[1];
assert(braceRun>1.10&&braceRun<1.38&&braceRise>1.60,"door brace is not a contained diagonal structural member");
for(const id of doorOpening.plankNodeIds!){const part=bounds(id);assert(part.min[0]>=leafBounds.min[0]-.07&&part.max[0]<=leafBounds.max[0]+.07&&part.min[1]>=leafBounds.min[1]-.03&&part.max[1]<=leafBounds.max[1]+.03,`${id} escapes the closed leaf envelope`);}
assert(functional.doors[0]!.openYaw<=-Math.PI/2&&functional.doors[0]!.openYaw>=-Math.PI*.58,"door does not park beyond 90 degrees without over-rotating");

const entranceCaps=["entry/front-entry/finish-landing","entry/front-entry/finish-step-1","entry/front-entry/finish-step-0"].map(bounds);
for(const [index,cap] of entranceCaps.entries()){const width=cap.max[0]-cap.min[0];assert(Math.abs((cap.min[0]+cap.max[0])/2+.72)<.01,`entrance cap ${index} is not centered on the portal`);assert(Math.abs(width-1.72)<.02,`entrance cap ${index} escaped the common stair width (${width.toFixed(3)}m)`);assert(cap.max[1]-cap.min[1]>=.045&&cap.max[1]-cap.min[1]<=.055,`entrance cap ${index} lacks a credible stone tread thickness`);}
for(let index=1;index<entranceCaps.length;index++){const a=entranceCaps[index-1]!,b=entranceCaps[index]!,joint=Math.min(Math.abs(a.min[2]-b.max[2]),Math.abs(a.max[2]-b.min[2]));assert(joint<.015,`entrance tread ${index-1}/${index} has a visible depth gap`);}

// Service-bay construction must be supported as one building volume.  Cycle 5
// extended its finish floor 1.45 m beyond every deep foundation and left a
// literal 0.295 m gap below the side/front walls.
const bayFloor=bounds(resolveId("volume/service-bay/floor","crossbay/floor")),bayCore=bounds(resolveId("foundation/service-core","crossbay/subfloor")),mainCore=bounds(resolveId("foundation/main-core","shell/subfloor")),supporters=[bayCore,mainCore];
for(let xi=0;xi<=16;xi++)for(let zi=0;zi<=12;zi++){
  const x=bayFloor.min[0]+(bayFloor.max[0]-bayFloor.min[0])*xi/16,z=bayFloor.min[2]+(bayFloor.max[2]-bayFloor.min[2])*zi/12;
  assert(supporters.some(support=>x>=support.min[0]-.01&&x<=support.max[0]+.01&&z>=support.min[2]-.01&&z<=support.max[2]+.01&&support.max[1]>=bayFloor.min[1]-.01),`service-bay floor lacks deep support at ${x.toFixed(2)},${z.toFixed(2)}`);
}
const serviceWallIds=semantic.has("wall/service-bay/edge-1/bay-end")?[...semantic.keys()].filter((id)=>/^wall\/service-bay\/edge-(0|1|3)\//.test(id)&&!id.endsWith("/above")):["crossbay/side-1.1","crossbay/side-4.14","crossbay/front-left","crossbay/front-right"];
const serviceBearingY=semantic.has("volume/service-bay/floor")?bayFloor.max[1]:bayCore.max[1];
for(const id of serviceWallIds){const wall=bounds(id);assert(Math.abs(wall.min[1]-serviceBearingY)<=.02,`${id} does not close vertically onto the supported bay floor`);}
const gable=bounds(resolveId("gable/service-roof/front","crossbay/gable")),crossWest=bounds(resolveId("roof/service-roof/west","roof/cross-west")),crossEast=bounds(resolveId("roof/service-roof/east","roof/cross-east")),crossRidge=bounds(resolveId("roof-seam/service-roof/ridge","roof/cross-ridge"));
assert(gable.max[1]<=5.74&&crossRidge.min[1]-gable.max[1]>=.05,"cross-gable penetrates or nearly touches its roof closure");
assert(crossRidge.min[0]<=Math.max(crossWest.min[0],crossEast.min[0])&&crossRidge.max[0]>=Math.min(crossWest.max[0],crossEast.max[0]),"cross-roof ridge cap does not cover the paired-plane seam");
for(const id of [resolveId("roof-seam/main-service-valley/0","roof/cross-valley-west"),resolveId("roof-seam/main-service-valley/1","roof/cross-valley-east")]){const valley=bounds(id),index=semantic.get(id)!,node=gltf.nodes[index],accessor=gltf.accessors[gltf.meshes[node.mesh].primitives[0].attributes.POSITION],length=id.startsWith("roof-seam/")?Math.max(...accessor.max.map((value:number,axis:number)=>value-accessor.min[axis])):Math.hypot(valley.max[0]-valley.min[0],valley.max[1]-valley.min[1],valley.max[2]-valley.min[2]);assert(length>2.8&&length<3.6,`${id} does not close the main/cross weather-skin junction`);}
assert(!gltf.nodes.some((node:J)=>/^roof\/course-/.test(node.name??"")),"duplicate transverse roof-course bars returned");
// The service roof must terminate at the true main-roof intersection. Earlier
// cycles merely laid flashing over full slabs that continued behind the valley.
for(const [side,index] of [["west",0],["east",1]] as const){const valley=bounds(resolveId(`roof-seam/main-service-valley/${index}`,`roof/cross-valley-${side}`)),skin=bounds(resolveId(`roof/service-roof/${side}`,`roof/cross-${side}`));assert(skin.max[2]>=valley.max[2]-.02&&skin.max[2]<=valley.max[2]+.25,`cross-${side} roof does not terminate at its valley substrate`);assert(skin.min[2]<=valley.min[2]-.10,`cross-${side} roof does not retain a front weather overlap`);}
assert(!semantic.has("gable/service-roof/rear"),"joined service roof retained a false rear gable through the main roof");
const dormerHead=bounds(resolveId("wall/dormer/south/front/window/dormer/above","dormer/front-head")),dormerGable=bounds(resolveId("dormer/south/gable-front","dormer/gable")),dormerWest=bounds(resolveId("dormer/south/roof-west","dormer/roof-west")),dormerEast=bounds(resolveId("dormer/south/roof-east","dormer/roof-east")),dormerRidge=bounds(resolveId("dormer/south/roof-ridge","dormer/roof-ridge"));
for(const [side,roof] of [["west",dormerWest],["east",dormerEast]] as const){const clearance=roof.min[1]-Math.max(dormerHead.max[1],dormerGable.min[1]);assert(clearance>=.03&&clearance<=.14,`dormer ${side} eave is buried in or floating above its wall: ${clearance}`);}
assert(Math.abs(dormerWest.min[1]-dormerEast.min[1])<=.005,"dormer paired eaves are asymmetric");
assert(dormerRidge.min[1]>=dormerGable.max[1]+.02,"dormer plaster apex penetrates the ridge closure");
assert(["fascia-left","fascia-right","rake-left","rake-right"].every(part=>semantic.has(`dormer/south/${part}`)),"dormer lacks authored eave/rake trim");
assert([0,1,2,3].every(index=>semantic.has(`dormer/south/curb-${index}`)&&semantic.has(`dormer/south/counterflashing-${index}`)),"dormer seat lacks a closed curb/counterflashing assembly");
for(const id of [resolveId("gable/main-roof/west","shell/gable-west"),resolveId("gable/main-roof/east","shell/gable-east")]){const endGable=bounds(id),compilerOwned=id.startsWith("gable/main-roof/"),ridge=compilerOwned?bounds("roof-seam/main-roof/ridge"):undefined;assert(compilerOwned?endGable.max[1]<=ridge!.min[1]-.02:endGable.min[1]<=3.44&&endGable.max[1]<=6.67,`${id} can break through the main weather skin`);}

const hearth=visual.interior.hearth;assert(hearth!==undefined,"authored hearth contract missing");
const hearthNodeMaterials=(id:string):string[]=>{const index=semantic.get(id);assert(index!==undefined,`hearth node ${id} unresolved`);const mesh=gltf.meshes?.[gltf.nodes[index].mesh];assert(mesh,`${id} has no material mesh`);return mesh.primitives.map((primitive:J)=>gltf.materials[primitive.material].name);};
for(const id of [...hearth.surroundNodeIds,...hearth.fuelNodeIds,hearth.emberNodeId,...hearth.flameNodeIds])bounds(id);
assert(hearth.surroundNodeIds.length>=4&&hearth.fuelNodeIds.length>=3&&hearth.flameNodeIds.length>=2,"hearth lacks surround, crossed fuel, or layered flame construction");
assert(["fireback","throat","lining-left","lining-right","smoke-shelf","smoke-chamber-west","smoke-chamber-east"].every(part=>hearth.surroundNodeIds.includes(`fireplace/hall-hearth/${part}`)),"hearth lacks a constructed firebox, throat, or smoke chamber");
const apertureMin:V3=hearth.apertureCenter.map((value:number,index:number)=>value-hearth.apertureHalfExtents[index]) as V3,apertureMax:V3=hearth.apertureCenter.map((value:number,index:number)=>value+hearth.apertureHalfExtents[index]) as V3;
for(const id of [...hearth.fuelNodeIds,hearth.emberNodeId,...hearth.flameNodeIds]){const part=bounds(id);assert(part.min.every((value,index)=>value>=apertureMin[index]-.01)&&part.max.every((value,index)=>value<=apertureMax[index]+.01),`${id} escaped the firebox aperture`);}
const hearthBase=bounds(resolveId("fireplace/hall-hearth/base","interior/hearth-base")),fuel=bounds(hearth.fuelNodeIds[0]);for(const id of hearth.fuelNodeIds){const log=bounds(id);assert(log.min[1]>=hearthBase.max[1]-.01,`${id} penetrates below the hearth base`);const extents=log.max.map((value,index)=>value-log.min[index]);assert(extents[1]<Math.max(extents[0],extents[2])*.30,`${id} is not a horizontal fuel log`);}assert((fuel.max[0]-fuel.min[0])>.8&&hearth.fuelNodeIds.some((id)=>{const log=bounds(id);return log.max[2]-log.min[2]>.8;}),"hearth fuel lacks crossed horizontal headings");
for(const id of hearth.flameNodeIds){const material=gltf.materials.find((entry:J)=>entry.name===hearthNodeMaterials(id)[0]);const emissive=material?.emissiveFactor??[0,0,0],strength=material?.extensions?.KHR_materials_emissive_strength?.emissiveStrength??1,peak=Math.max(...emissive)*strength;assert(peak>=.45,`${id} is not a visibly emissive authored flame`);assert(peak<=.8,`${id} exceeds the flame red-channel retention ceiling`);assert(emissive[0]>emissive[1]*1.5&&emissive[1]>emissive[2]*3,`${id} lost warm chromatic separation and can clip toward white`);}
const emberMaterial=gltf.materials.find((entry:J)=>entry.name===hearthNodeMaterials(hearth.emberNodeId)[0]),emberEmissive=emberMaterial?.emissiveFactor??[0,0,0],emberStrength=emberMaterial?.extensions?.KHR_materials_emissive_strength?.emissiveStrength??1,emberPeak=Math.max(...emberEmissive)*emberStrength;assert(emberPeak>=.3&&emberPeak<=.5,"ember bed escaped restrained emissive authority");

// Blender's glTF SPEC conversion multiplies point-light power by ~54.35 to
// candela.  Gate exported engine units and occupied-grid illuminance directly,
// so plausible Blender numbers cannot silently blow out the production view.
type LightRecord={name:string;intensity:number;range:number;position:V3};
const lightDefs=gltf.extensions?.KHR_lights_punctual?.lights??[],lights:LightRecord[]=[];
for(let nodeIndex=0;nodeIndex<gltf.nodes.length;nodeIndex++){const lightIndex=gltf.nodes[nodeIndex].extensions?.KHR_lights_punctual?.light;if(!Number.isInteger(lightIndex))continue;const definition=lightDefs[lightIndex],matrix=world(nodeIndex);lights.push({name:definition.name,intensity:definition.intensity,range:definition.range,position:[matrix[12],matrix[13],matrix[14]]});}
const hearthLight=lights.find((light)=>light.name.includes("hearth"));assert(hearthLight!==undefined,"authored hearth light missing");assert(hearthLight.position.every((value,index)=>value>=apertureMin[index]&&value<=apertureMax[index]),"hearth light is detached from the authored firebox aperture");
const verifyPracticalLights=(records:LightRecord[])=>{assert(records.length===3,"cottage must export exactly three bounded practical lights");const limits:Record<string,[number,number,number,number]>={entry:[5,9,2.6,3.0],hearth:[6,8,2.0,2.5],table:[12,18,3.4,3.8]};let total=0;
  for(const light of records){const role=Object.keys(limits).find(key=>light.name.includes(key));assert(role!==undefined,`unknown practical ${light.name}`);const[min,max,minRange,maxRange]=limits[role];assert(light.intensity>=min&&light.intensity<=max&&light.range>=minRange&&light.range<=maxRange,`${role} practical escaped candela/range authority`);if(role==="hearth"){const definition=lightDefs.find((candidate:J)=>candidate.name===light.name),color=definition?.color??[1,1,1],channelEnergy=color.map((channel:number)=>channel*light.intensity);assert(color[0]>=.65&&color[0]<=.85&&color[1]/color[0]>=.3&&color[1]/color[0]<=.5&&color[2]/color[0]<=.2,"hearth practical escaped warm bounded chroma authority");assert(Math.max(...channelEnergy)<=5,"hearth practical exceeds per-channel emitted-energy authority");}total+=light.intensity;}assert(total<=60,"practical-light sum exceeds 60 candela");
  const lux:number[]=[];for(let y=.5;y<=1.7+1e-9;y+=.3)for(let x=-4.15;x<=4.15+1e-9;x+=.25)for(let z=-3;z<=3+1e-9;z+=.25){const distances=records.map(light=>Math.hypot(x-light.position[0],y-light.position[1],z-light.position[2]));if(Math.min(...distances)<.55)continue;let value=0;for(let i=0;i<records.length;i++){const d=distances[i]!,light=records[i]!;if(d>=light.range)continue;const rangeFade=Math.max(0,1-(d/light.range)**4);value+=light.intensity/(d*d)*rangeFade*rangeFade;}lux.push(value);}lux.sort((a,b)=>a-b);assert(lux[Math.floor(lux.length*.95)]!<=300&&lux.at(-1)!<=1000,"occupied-grid practical illuminance exceeds p95/max authority");
};
verifyPracticalLights(lights);let lightMutationFailed=false;try{verifyPracticalLights(lights.map((light,index)=>index===0?{...light,intensity:light.intensity*10}:light));}catch{lightMutationFailed=true;}assert(lightMutationFailed,"adversarial tenfold practical intensity escaped the gate");

for(const opening of visual.openings.filter((entry)=>entry.kind==="window")){const aperture=opening.aperture,cross=opening.facade==="north"||opening.facade==="south"?0:2,glass=bounds(opening.glazingNodeId!);
  assert(nodeMaterials(opening.glazingNodeId!).every((name)=>name===roleMaterial.get("glazing")),`${opening.id} pane lacks glazing material identity`);
  for(const id of [...opening.frameNodeIds!,...opening.mullionNodeIds!])assert(nodeMaterials(id).every((name)=>name===roleMaterial.get("structure-trim")),`${opening.id} frame/mullion lacks structural material identity`);
  for(const id of opening.cameNodeIds!)assert(nodeMaterials(id).every((name)=>name===roleMaterial.get("door-hardware")),`${opening.id} lead came lacks metal material identity`);
  for(const id of opening.mullionNodeIds!){const mullion=bounds(id);assert(Math.abs(mullion.center[cross]-aperture.center[cross])<aperture.halfExtents[cross]*.2,`${opening.id} mullion is not centered in pane`);assert(mullion.max[1]-mullion.min[1]>aperture.halfExtents[1]*1.5,`${opening.id} mullion does not span pane height`);}
  for(const id of opening.cameNodeIds!){const came=bounds(id),span=came.max[cross]-came.min[cross],rise=came.max[1]-came.min[1];
    if(/came-vertical/.test(id))assert(rise>aperture.halfExtents[1]*1.5&&span<.08,`${opening.id} vertical leadwork is not slender or full-height`);
    else assert(span>aperture.halfExtents[cross]*1.5&&rise<.08,`${opening.id} horizontal lead came is not slender or full-width: span=${span}, rise=${rise}`);
    assert(came.min[1]>=glass.min[1]-.1&&came.max[1]<=glass.max[1]+.1,`${opening.id} lead came lies outside glazing`);}}

const aisle=visual.interior.clearAisle,aisleMinX=Math.min(aisle.from[0],aisle.to[0])-aisle.halfWidth,aisleMaxX=Math.max(aisle.from[0],aisle.to[0])+aisle.halfWidth,
  aisleMinZ=Math.min(aisle.from[2],aisle.to[2])-aisle.halfWidth,aisleMaxZ=Math.max(aisle.from[2],aisle.to[2])+aisle.halfWidth;
for(const id of visual.interior.furnishingNodeIds){const item=bounds(id),blocks=item.max[0]>aisleMinX&&item.min[0]<aisleMaxX&&item.max[2]>aisleMinZ&&item.min[2]<aisleMaxZ&&item.min[1]<aisle.minClearHeight&&item.max[1]>0;
  assert(!blocks,`${id} obstructs declared traversal aisle`);}

const iteration=JSON.parse(fs.readFileSync(new URL("../../art-direction/functional-cottage-v4-iteration.json",import.meta.url),"utf8"));
assert(iteration.acceptance?.renderer==="native production engine only"&&iteration.acceptance?.humanApprovalRequired===true&&iteration.acceptance?.automaticGalleryStaging===false,
  "v4 iteration permits non-engine or automatic visual acceptance");
console.log(`p_functional_hall_house_v4_quality OK: ${visual.openings.length} deep true openings, authored functional leaf, ${visual.materialRoles.length} material-specific PBR roles, interior identities, LOD0 ${triangles} triangles/${primitives} primitives, engine-only human review retained`);
