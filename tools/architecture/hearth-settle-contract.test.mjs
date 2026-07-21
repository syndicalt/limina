import assert from "node:assert/strict";import{readFile}from"node:fs/promises";
const contract=JSON.parse(await readFile(new URL("../../assets/buildings/authoring/furniture/hearth-settle-v1/design-contract.json",import.meta.url),"utf8")),parts=new Map(contract.parts.map(part=>[part.id,part]));
assert.equal(contract.role,"hearth-settle");assert.equal(contract.dimensions.occupancy,2);assert.ok(contract.dimensions.widthM/contract.dimensions.heightM>=1.45,"settle must retain a broad, non-chair silhouette");
for(const side of["left","right"]){
  const front=`post/front-${side}`,rear=`post/rear-${side}`;
  assert.ok(contract.joints.some(j=>j.members.includes(front)&&j.members.includes("rail/front")),`${front} must join the front rail`);
  assert.ok(contract.joints.some(j=>j.members.includes(front)&&j.members.includes("stretcher/front")),`${front} must join the front stretcher`);
  for(const member of["rail/rear","rail/back-low","rail/back-high","stretcher/rear"])assert.ok(contract.joints.some(j=>j.members.includes(rear)&&j.members.includes(member)),`${rear} must join ${member}`);
}
for(const id of["rail/front","rail/rear","rail/back-low","rail/back-high","stretcher/front","stretcher/rear"]){const part=parts.get(id),span=part.geometry.size[0]/2;assert.ok(span>=.91&&span<=.94,`${id} must visibly enter the post joinery envelope`)}
const seats=["seat/left","seat/center","seat/right"].map(id=>parts.get(id)).sort((a,b)=>a.center[0]-b.center[0]);for(let i=1;i<seats.length;i++){const gap=seats[i].center[0]-seats[i-1].center[0]-(seats[i].geometry.size[0]+seats[i-1].geometry.size[0])/2;assert.ok(gap>=0&&gap<=.015,`seat-board gap ${gap} is outside craft tolerance`)}
for(const part of contract.parts.filter(part=>part.kind==="peg")){assert.equal(part.geometry.axis,"z");assert.deepEqual(part.rotationDeg,[0,0,0],`${part.id} must remain on its declared proud rear-facing axis`)}
assert.equal(contract.colliders.length,7);assert.ok(contract.colliders.some(c=>c.id==="collision/front-left"&&c.covers.includes("post/front-left")));assert.ok(contract.colliders.some(c=>c.id==="collision/front-right"&&c.covers.includes("post/front-right")));
assert.equal(contract.sockets.filter(s=>s.kind==="occupancy").length,2);assert.ok(contract.parts.filter(p=>p.kind==="panel").length>=4);assert.ok(contract.parts.filter(p=>p.kind==="peg").length>=8);
console.log("hearth settle construction contract checks passed");
