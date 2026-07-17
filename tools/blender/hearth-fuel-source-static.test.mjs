import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {resolve} from "node:path";

const root=resolve(import.meta.dirname,"../.."),recipePath=resolve(root,"assets/buildings/authoring/functional-hall-house-v4/fire-r1/hearth-fuel-recipe.json"),adapterPath=resolve(root,"tools/blender/hearth-fuel-adapter.py"),wrapperPath=resolve(root,"tools/architecture/build-hearth-fuel-source.mjs");
const [recipeRaw,adapter,wrapper]=await Promise.all([readFile(recipePath),readFile(adapterPath,"utf8"),readFile(wrapperPath,"utf8")]),recipe=JSON.parse(recipeRaw),sha=bytes=>`sha256:${createHash("sha256").update(bytes).digest("hex")}`;

assert.equal(recipe.schema,"limina.hearth-fuel-recipe/v1");
assert.equal(recipe.id,"fire/functional-hall-house-v4/hearth-fuel/r1");
assert.equal(recipe.revision,1);
assert.deepEqual(recipe.coordinateFrame,{units:"meter",up:[0,1,0],anchorSemanticId:"anchor/vfx/hall-hearth",socketSemanticId:"socket/wall/hall-hearth",origin:[2.95,1.2,3.18],right:[1,0,0],forward:[0,0,-1]});
for(const resource of Object.values(recipe.authority))assert.equal(sha(await readFile(resolve(root,resource.path))),resource.sha256,`${resource.path} exact authority drifted`);

const materialRoles=new Map(recipe.materials.map(material=>[material.role,material]));
assert.deepEqual([...materialRoles],[
  ["hearth-embers",recipe.materials[0]],
  ["hearth-soot-char",recipe.materials[1]],
  ["hearth-soot-endgrain",recipe.materials[2]],
]);
const lock=JSON.parse(await readFile(resolve(root,recipe.authority.materialsLock.path),"utf8")),approvedEmbers=lock.roles.find(({role})=>role==="hearth-embers");
assert.ok(approvedEmbers);
for(const key of ["baseColorSrgb","roughness","metallic","emissionSrgb","emissionStrength"])assert.deepEqual(recipe.materials[0][key],approvedEmbers.parameters[key]);
const approvedSoot=lock.roles.find(({role})=>role==="hearth-soot");
for(const material of recipe.materials.slice(1)){assert.equal(material.authorityRole,"hearth-soot");for(const key of ["baseColorSrgb","roughness","metallic","emissionSrgb","emissionStrength"])assert.deepEqual(material[key],approvedSoot.parameters[key]);}
assert.deepEqual(Object.keys(recipe.authority).sort(),["interiorPlan","materialsLock","materialsRuntime","shell"]);
assert.equal(JSON.stringify(recipe).includes("composition-r3"),false);

assert.equal(recipe.parts.length,14);
assert.deepEqual(recipe.parts.slice(0,4).map(part=>part.id),[
  "fire/hall-hearth/fuel/ember-bed",
  "fire/hall-hearth/fuel/log/lower-front",
  "fire/hall-hearth/fuel/log/lower-rear",
  "fire/hall-hearth/fuel/log/upper-cross",
]);
assert.equal(recipe.parts.filter(part=>part.kind==="log").length,3);
for(const log of recipe.parts.filter(part=>part.kind==="log")){
  assert.ok(Math.abs(Math.hypot(...log.axis)-1)<2e-6,`${log.id} axis is not unit length`);
  assert.equal(log.radialSegments,16);
  assert.equal(log.ringProfile.length,7);
  assert.ok(new Set(log.ringProfile.map(ring=>ring.radiusScale)).size>=5);
  assert.ok(new Set(log.ringProfile.map(ring=>ring.twistRadians)).size>=5);
  assert.ok(log.ringProfile.some(ring=>ring.offsetA!==0||ring.offsetB!==0));
  assert.equal(log.sideMaterialRole,"hearth-soot-char");
  assert.equal(log.endgrainMaterialRole,"hearth-soot-endgrain");
}
const coals=recipe.parts.filter(part=>part.kind==="coal-pocket");
assert.equal(coals.length,10);
assert.equal(new Set(coals.map(coal=>JSON.stringify([coal.radialScales,coal.topOffset,coal.yawRadians]))).size,coals.length);
for(const coal of coals){assert.match(coal.id,/^fire\/hall-hearth\/fuel\/coal\/\d{2}$/);assert.equal(coal.radialScales.length,8);assert.ok(new Set(coal.radialScales).size>=6);assert.deepEqual(coal.materialRoles,["hearth-soot-char","hearth-embers"]);}
assert.equal(recipe.parts[0].radialScales.length,16);
assert.ok(new Set(recipe.parts[0].radialScales).size>=6);
const aggregate=recipe.aggregateBounds,conservative=recipe.firebox.conservativeFuelBounds,opening=recipe.firebox.openingBounds;
const authoredVertices=[];
const ember=recipe.parts[0];
for(const [ringIndex,[y,scale]] of [[0,[-ember.halfExtents[1],1]],[1,[ember.halfExtents[1],ember.topScale]]])for(let index=0;index<16;index++){
  const angle=2*Math.PI*index/16,radial=ember.radialScales[index],[offsetX,offsetZ]=ringIndex?ember.topOffset:[0,0];
  authoredVertices.push([ember.center[0]+offsetX+ember.halfExtents[0]*scale*radial*Math.cos(angle),ember.center[1]+y,ember.center[2]+offsetZ+ember.halfExtents[2]*scale*radial*Math.sin(angle)]);
}
for(const log of recipe.parts.filter(part=>part.kind==="log")){
  const [ax,,az]=log.axis,basisB=[-az,0,ax];
  for(const ring of log.ringProfile)for(let index=0;index<log.radialSegments;index++){
    const angle=2*Math.PI*index/log.radialSegments+ring.twistRadians,furrow=index%4===0?.945:1,radial=log.radiusM*ring.radiusScale*furrow;
    authoredVertices.push([log.center[0]+ax*ring.t*log.lengthM+basisB[0]*ring.offsetB+basisB[0]*Math.sin(angle)*radial,log.center[1]+ring.offsetA+Math.cos(angle)*radial,log.center[2]+az*ring.t*log.lengthM+basisB[2]*ring.offsetB+basisB[2]*Math.sin(angle)*radial]);
  }
}
for(const coal of coals){
  authoredVertices.push([coal.center[0],coal.center[1]-coal.halfExtents[1],coal.center[2]],[coal.center[0]+coal.topOffset[0],coal.center[1]+coal.halfExtents[1],coal.center[2]+coal.topOffset[1]]);
  const cosine=Math.cos(coal.yawRadians),sine=Math.sin(coal.yawRadians);
  for(const [ringIndex,[height,scale]] of [[0,[-.55,.7]],[1,[0,1]],[2,[.58,.66]]])for(let index=0;index<8;index++){
    const angle=2*Math.PI*index/8,radial=coal.radialScales[index],localX=coal.halfExtents[0]*scale*radial*Math.cos(angle),localZ=coal.halfExtents[2]*scale*radial*Math.sin(angle),shiftX=coal.topOffset[0]*Math.max(ringIndex-1,0),shiftZ=coal.topOffset[1]*Math.max(ringIndex-1,0);
    authoredVertices.push([coal.center[0]+shiftX+cosine*localX+sine*localZ,coal.center[1]+coal.halfExtents[1]*height,coal.center[2]+shiftZ-sine*localX+cosine*localZ]);
  }
}
for(const [vertexIndex,vertex] of authoredVertices.entries())for(let axis=0;axis<3;axis++)assert.ok(vertex[axis]>=aggregate.min[axis]-1e-6&&vertex[axis]<=aggregate.max[axis]+1e-6,`authored vertex ${vertexIndex} escapes aggregate on axis ${axis}: ${vertex}`);
for(let axis=0;axis<3;axis++){
  assert.ok(aggregate.min[axis]>=conservative.min[axis]&&aggregate.max[axis]<=conservative.max[axis],`aggregate escapes conservative firebox on axis ${axis}`);
  assert.ok(aggregate.min[axis]>=opening.min[axis]&&aggregate.max[axis]<=opening.max[axis],`aggregate escapes audited opening on axis ${axis}`);
}
assert.equal(recipe.parts[0].center[1]-recipe.parts[0].halfExtents[1],recipe.firebox.supportY+0.005);

const syntax=spawnSync("python3",["-c","import ast,sys; ast.parse(sys.stdin.read())"],{input:adapter,encoding:"utf8"});
assert.equal(syntax.status,0,syntax.stderr);
for(const token of ["bpy.ops.wm.read_factory_settings(use_empty=True)","limina.blender-hearth-fuel-handoff/v1","limina.blender-hearth-fuel-output/v1","ringProfile","make_coal","limina.endgrainPolygonCount","limina.recipeHash","export_extras=True","export_cameras=False","export_lights=False","rendered\": False","gpuUsed\": False"])assert.ok(adapter.includes(token),`adapter missing ${token}`);
assert.doesNotMatch(adapter,/primitive_cylinder_add/);
assert.doesNotMatch(adapter,/C1-r3|composition_ids|recipe\.authority\.composition/);
assert.doesNotMatch(adapter,/bpy\.ops\.render|cycles|BLENDER_EEVEE|CUDA|OPTIX/);
for(const token of ["resolveBlender","--factory-startup","append-only hearth fuel build output already exists","limina.hearth-fuel-build-evidence/v1","flag:\"wx\"","rendered:false","gpuUsed:false"])assert.ok(wrapper.includes(token),`wrapper missing ${token}`);
assert.match(wrapper,/C1 composition is capture context and must not be a hearth fuel build dependency/);
assert.doesNotMatch(wrapper,/--render|bpy\.ops\.render|timestamp/i);

console.log("hearth fuel r1 recipe, exact authority, Blender adapter, and append-only wrapper validated without Blender or GPU");
