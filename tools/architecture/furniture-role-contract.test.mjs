import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { furnitureDesignContractHash, validateFurnitureDesignContract } from "../../js/src/architecture/furniture-design-contract.ts";

const HASH=`sha256:${"a".repeat(64)}`;
const member=id=>({id,kind:"tapered-member",materialRole:"wood",center:[0,.5,0],rotationDeg:[0,0,0],geometry:{kind:"tapered-member",lengthM:1,bottomSection:[.1,.1],topSection:[.08,.08],axis:"y",chamferM:.005}});

function nonSeating(role){return{schema:"limina.furniture-design-contract/v1",id:`furniture/test-${role}/v1`,role,visualDesign:{id:`furniture/test-${role}/visual`,hash:HASH},dimensions:{widthM:1.4,heightM:.8,depthM:.7,seatHeightM:0,seatDepthM:0,occupancy:0},parts:[member("leg/left-front"),member("leg/right-front"),member("leg/left-rear"),member("leg/right-rear")],joints:[{id:"joint/left",type:"housing",members:["leg/left-front","leg/left-rear"],toleranceM:.002},{id:"joint/right",type:"housing",members:["leg/right-front","leg/right-rear"],toleranceM:.002}],sockets:[{id:"approach/front",kind:"approach",position:[0,0,-.8],facing:[0,0,1],supportedBy:"leg/left-front",clearanceRadiusM:.35}],colliders:[{id:"collision/left",center:[-.5,.4,0],halfExtents:[.1,.4,.25],covers:["leg/left-front","leg/left-rear"]},{id:"collision/right",center:[.5,.4,0],halfExtents:[.1,.4,.25],covers:["leg/right-front","leg/right-rear"]}],materialRoles:["wood"],status:"draft"}};
function storage(){const value=nonSeating("service-storage"),tiers=[0,1,2,3].map(index=>({id:`tier/${index}`,kind:"shaped-board",materialRole:"wood",center:[0,.2+index*.45,0],rotationDeg:[0,0,0],geometry:{kind:"shaped-board",size:[.34,.05,.9],edgeProfile:"eased",edgeRadiusM:.004}}));return{...value,dimensions:{...value.dimensions,widthM:.4,heightM:1.8,depthM:1},storage:{tierPartIds:tiers.map(part=>part.id),verticalSupportPartIds:["leg/left-front","leg/right-front","leg/left-rear","leg/right-rear"],approachSocketId:"approach/front",canonicalFront:[-1,0,0],ratedLoadKgPerTier:25},parts:[...value.parts,...tiers],joints:[...value.joints,...tiers.flatMap((tier,index)=>[{id:`joint/tier-${index}-left`,type:"housing",members:[tier.id,"leg/left-front"],toleranceM:.002},{id:`joint/tier-${index}-right`,type:"housing",members:[tier.id,"leg/right-front"],toleranceM:.002}])],sockets:[{id:"approach/front",kind:"approach",position:[-.65,0,0],facing:[1,0,0],supportedBy:"tier/0",clearanceRadiusM:.35}],colliders:[{id:"collision/frame",center:[0,.9,0],halfExtents:[.2,.9,.5],covers:value.parts.map(part=>part.id)},{id:"collision/tiers",center:[0,.875,0],halfExtents:[.18,.825,.45],covers:tiers.map(part=>part.id)}]}};
function chair(){const value=nonSeating("dining-table"),seat={id:"seat",kind:"shaped-board",materialRole:"wood",center:[0,.44,0],rotationDeg:[0,0,0],geometry:{kind:"shaped-board",size:[.44,.04,.42],edgeProfile:"eased",edgeRadiusM:.005}},back={id:"back",kind:"panel",materialRole:"wood",center:[0,.68,.2],rotationDeg:[0,0,0],geometry:{kind:"panel",size:[.44,.44,.04],fieldDepthM:.005,fieldMarginM:.03,edgeRadiusM:.004}};return{...value,id:"furniture/test-chair/v1",role:"chair",dimensions:{widthM:.5,heightM:.9,depthM:.5,seatHeightM:.46,seatDepthM:.42,occupancy:1},chair:{seatPartId:"seat",backPartIds:["back"],legPartIds:["leg/left-front","leg/right-front","leg/left-rear","leg/right-rear"],usableSeatWidthM:.4,backSupportHeightM:.34,ratedLoadKg:150,canonicalForward:[0,0,-1]},parts:[...value.parts,seat,back],joints:[...value.joints,{id:"joint/seat-left",type:"housing",members:["leg/left-front","seat"],toleranceM:.002},{id:"joint/seat-right",type:"housing",members:["leg/right-front","seat"],toleranceM:.002},{id:"joint/back",type:"housing",members:["seat","back"],toleranceM:.002}],sockets:[{id:"occupancy/main",kind:"occupancy",position:[0,.46,0],facing:[0,0,-1],supportedBy:"seat",clearanceRadiusM:.3}],colliders:[{id:"collision/base",center:[0,.23,0],halfExtents:[.25,.23,.25],covers:[...value.parts.map(part=>part.id),"seat"]},{id:"collision/back",center:[0,.68,.2],halfExtents:[.22,.22,.025],covers:["back"]}]}};

test("accepts honest dining-table and service-storage contracts with no fabricated seating",()=>{for(const value of[nonSeating("dining-table"),storage()]){const contract=validateFurnitureDesignContract(value);assert.equal(contract.dimensions.occupancy,0);assert.equal(contract.sockets.filter(socket=>socket.kind==="occupancy").length,0);assert.match(furnitureDesignContractHash(contract),/^sha256:[0-9a-f]{64}$/)}});

test("rejects fabricated non-seating occupancy and missing approach proof",()=>{
  const capacity=nonSeating("dining-table");capacity.dimensions.occupancy=1;assert.throws(()=>validateFurnitureDesignContract(capacity),/forbids seat dimensions and fabricated occupancy/);
  const socket=storage();socket.sockets.push({id:"occupancy/fake",kind:"occupancy",position:[0,.5,0],facing:[0,0,-1],supportedBy:"leg/left-front",clearanceRadiusM:.3});assert.throws(()=>validateFurnitureDesignContract(socket),/forbids seat dimensions and fabricated occupancy/);
  const approach=nonSeating("dining-table");approach.sockets=[];assert.throws(()=>validateFurnitureDesignContract(approach),/requires an approach socket/);
});

test("requires exact bounded service-storage semantics",()=>{
  const valid=validateFurnitureDesignContract(storage());assert.equal(valid.storage.tierPartIds.length,4);assert.deepEqual(valid.storage.canonicalFront,[-1,0,0]);
  const missing=storage();delete missing.storage;assert.throws(()=>validateFurnitureDesignContract(missing),/requires explicit storage semantics/);
  const duplicate=storage();duplicate.storage.tierPartIds[3]=duplicate.storage.tierPartIds[2];assert.throws(()=>validateFurnitureDesignContract(duplicate),/four unique semantic tier parts/);
  const supports=storage();supports.storage.verticalSupportPartIds=[supports.storage.tierPartIds[0]];assert.throws(()=>validateFurnitureDesignContract(supports),/vertical supports/);
  const approach=storage();approach.sockets[0].position=[.65,0,0];assert.throws(()=>validateFurnitureDesignContract(approach),/approved local I1 clearance/);
  const front=storage();front.storage.canonicalFront=[0,0,-1];assert.throws(()=>validateFurnitureDesignContract(front),/local -X/);
  const load=storage();load.storage.ratedLoadKgPerTier=60;assert.throws(()=>validateFurnitureDesignContract(load),/bounded policy/);
  const table=nonSeating("dining-table");table.storage=storage().storage;assert.throws(()=>validateFurnitureDesignContract(table),/cannot claim storage semantics/);
});

test("keeps seating roles strict and preserves the narrowly enumerated historical settle",async()=>{
  const settle=JSON.parse(await readFile(new URL("../../assets/buildings/authoring/furniture/hearth-settle-v2-r2/design-contract.json",import.meta.url),"utf8"));assert.equal(validateFurnitureDesignContract(settle).id,"furniture/hearth-settle/v2-r2");
  const fraudulent={...settle,dimensions:{...settle.dimensions,seatHeightM:0,seatDepthM:0,occupancy:0},sockets:settle.sockets.filter(socket=>socket.kind!=="occupancy")};assert.throws(()=>validateFurnitureDesignContract(fraudulent),/seating furniture requires positive seat dimensions and occupancy/);
  assert.throws(()=>validateFurnitureDesignContract({...nonSeating("dining-table"),role:"chair-table"}),/exactly one supported/);
});

test("requires explicit bounded single-occupant dining-chair semantics",()=>{
  const valid=validateFurnitureDesignContract(chair());assert.equal(valid.dimensions.occupancy,1);assert.equal(valid.chair.legPartIds.length,4);assert.equal(valid.chair.canonicalForward[2],-1);
  const capacity=chair();capacity.dimensions.occupancy=2;assert.throws(()=>validateFurnitureDesignContract(capacity),/occupancy/);
  const legs=chair();legs.chair.legPartIds=legs.chair.legPartIds.slice(0,3);assert.throws(()=>validateFurnitureDesignContract(legs),/four-leg identities/);
  const forward=chair();forward.chair.canonicalForward=[0,0,1];forward.sockets[0].facing=[0,0,1];assert.throws(()=>validateFurnitureDesignContract(forward),/local -Z/);
  const load=chair();load.chair.ratedLoadKg=90;assert.throws(()=>validateFurnitureDesignContract(load),/ergonomics or rated load/);
});
