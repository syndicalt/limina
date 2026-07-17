import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { validateVisualDesignContract, visualDesignContractHash, validateFurnitureDesignContract, furnitureDesignContractHash } from "../../js/src/architecture/index.ts";

const args=process.argv.slice(2),at=flag=>{const i=args.indexOf(flag);if(i<0||!args[i+1])throw new Error("usage: bun tools/architecture/create-hearth-settle-contract.mjs --visual <json> --out <json>");return resolve(args[i+1])};
const visual=validateVisualDesignContract(JSON.parse(await readFile(at("--visual"),"utf8"))),out=at("--out"),parts=[];
const add=(id,materialRole,center,rotationDeg,geometry)=>parts.push({id,kind:geometry.kind,materialRole,center,rotationDeg,geometry});
const board=(size,edgeProfile="eased")=>({kind:"shaped-board",size,edgeProfile,edgeRadiusM:.008});
const post=(length,bottom=[.13,.13],top=[.105,.105])=>({kind:"tapered-member",lengthM:length,bottomSection:bottom,topSection:top,axis:"y",chamferM:.009});
const panel=size=>({kind:"panel",size,fieldDepthM:.012,fieldMarginM:.055,edgeRadiusM:.006});
const peg=(axis="z")=>({kind:"peg",diameterM:.026,lengthM:.035,axis});
for(const [x,label] of [[-.96,"left"],[.96,"right"]]){
  add(`post/rear-${label}`,"oak-frame",[x,.73,.28],[-7,0,0],post(1.46));
  add(`post/front-${label}`,"oak-frame",[x,.36,-.25],[0,0,0],post(.72,[.12,.12],[.10,.10]));
  add(`arm/${label}`,"oak-frame",[x,.73,0],[0,0,0],{kind:"profile-extrusion",profile:[[-.31,-.045],[.23,-.045],[.31,0],[.23,.06],[-.31,.06]],depthM:.12,axis:"z",bevelM:.008});
  add(`bracket/${label}`,"oak-frame",[x,.62,-.12],[0,0,0],{kind:"profile-extrusion",profile:[[-.12,-.16],[.10,-.16],[.10,.16],[.04,.16],[-.12,-.04]],depthM:.08,axis:"z",bevelM:.006});
}
for(const [x,label] of [[-.56,"left"],[0,"center"],[.56,"right"]])add(`seat/${label}`,"oak-panel",[x,.435,-.01],[0,0,0],board([.55,.07,.47]));
for(const [id,center,size] of [
  ["rail/front",[0,.34,-.25],[1.84,.12,.08]],["rail/rear",[0,.36,.25],[1.84,.10,.08]],
  ["rail/back-low",[0,.79,.28],[1.84,.11,.08]],["rail/back-high",[0,1.31,.34],[1.84,.11,.08]],
  ["stretcher/front",[0,.20,-.20],[1.84,.08,.08]],["stretcher/rear",[0,.20,.20],[1.84,.08,.08]],
])add(id,"oak-frame",center,[0,0,0],board(size));
for(const [x,label] of [[-.885,"left"],[0,"center"],[.885,"right"]])add(`stile/${label}`,"oak-frame",[x,1.05,.31],[-7,0,0],post(.50,[.08,.08],[.075,.075]));
for(const [x,label] of [[-.66,"outer-left"],[-.22,"inner-left"],[.22,"inner-right"],[.66,"outer-right"]])add(`panel/${label}`,"oak-panel",[x,1.055,.325],[-7,0,0],panel([.36,.40,.045]));
add("crest","oak-frame",[0,1.405,.38],[-7,0,0],{kind:"profile-extrusion",profile:[[-1.05,-.055],[-.82,-.035],[-.55,.025],[-.28,-.005],[0,.045],[.28,-.005],[.55,.025],[.82,-.035],[1.05,-.055],[1.05,.055],[-1.05,.055]],depthM:.11,axis:"x",bevelM:.009});
for(const [x,side] of [[-.96,"left"],[.96,"right"]])for(const [y,level] of [[.34,"seat"],[.80,"back-low"],[1.31,"back-high"],[.20,"stretcher"]])add(`peg/${side}-${level}`,"oak-endgrain",[x,y,.325],[0,0,0],peg());
const joints=[];
for(const side of ["left","right"]){
  for(const [postId,member] of [[`post/front-${side}`,"rail/front"],[`post/rear-${side}`,"rail/rear"],[`post/rear-${side}`,"rail/back-low"],[`post/rear-${side}`,"rail/back-high"],[`post/front-${side}`,"stretcher/front"],[`post/rear-${side}`,"stretcher/rear"]])joints.push({id:`joint/${side}-${member.replace("/","-")}`,type:"mortise-tenon",members:[postId,member],toleranceM:.002});
  joints.push({id:`joint/${side}-arm`,type:"wedged-through-tenon",members:[`post/rear-${side}`,`arm/${side}`],toleranceM:.002});
}
for(const side of ["left","right"])for(const level of ["seat","back-low","back-high","stretcher"])joints.push({id:`joint/peg-${side}-${level}`,type:"drawbore-peg",members:[`post/rear-${side}`,`peg/${side}-${level}`],toleranceM:.0015});
const sockets=[
  {id:"occupancy/left",kind:"occupancy",position:[-.46,.47,-.04],facing:[0,0,-1],supportedBy:"seat/left",clearanceRadiusM:.31},
  {id:"occupancy/right",kind:"occupancy",position:[.46,.47,-.04],facing:[0,0,-1],supportedBy:"seat/right",clearanceRadiusM:.31},
  {id:"approach/left",kind:"approach",position:[-.46,0,-.82],facing:[0,0,1],supportedBy:"seat/left",clearanceRadiusM:.35},
  {id:"approach/right",kind:"approach",position:[.46,0,-.82],facing:[0,0,1],supportedBy:"seat/right",clearanceRadiusM:.35},
  {id:"inspect/front",kind:"inspect",position:[0,.9,-1.05],facing:[0,0,1],supportedBy:"rail/front",clearanceRadiusM:.3},
];
const colliders=[
  {id:"collision/seat",center:[0,.42,-.01],halfExtents:[.92,.09,.235],covers:["seat/left","seat/center","seat/right","rail/front","rail/rear"]},
  {id:"collision/front-left",center:[-.96,.36,-.25],halfExtents:[.06,.36,.06],covers:["post/front-left","bracket/left"]},
  {id:"collision/front-right",center:[.96,.36,-.25],halfExtents:[.06,.36,.06],covers:["post/front-right","bracket/right"]},
  {id:"collision/rear-left",center:[-.96,.73,.28],halfExtents:[.07,.73,.07],covers:["post/rear-left","arm/left"]},
  {id:"collision/rear-right",center:[.96,.73,.28],halfExtents:[.07,.73,.07],covers:["post/rear-right","arm/right"]},
  {id:"collision/back-left",center:[-.48,1.08,.33],halfExtents:[.48,.36,.07],covers:["panel/outer-left","panel/inner-left","rail/back-low","rail/back-high"]},
  {id:"collision/back-right",center:[.48,1.08,.33],halfExtents:[.48,.36,.07],covers:["panel/inner-right","panel/outer-right","crest"]},
];
const contract={schema:"limina.furniture-design-contract/v1",id:"furniture/hearth-settle/v1",role:"hearth-settle",visualDesign:{id:visual.id,hash:visualDesignContractHash(visual)},dimensions:{widthM:2.16,heightM:1.46,depthM:.72,seatHeightM:.47,seatDepthM:.47,occupancy:2},parts,joints,sockets,colliders,materialRoles:["oak-frame","oak-panel","oak-endgrain"],status:"draft"};
validateFurnitureDesignContract(contract,visual);await mkdir(dirname(out),{recursive:true});await writeFile(out,`${JSON.stringify(contract,null,2)}\n`,{mode:0o600});console.log(JSON.stringify({id:contract.id,visualHash:contract.visualDesign.hash,contractHash:furnitureDesignContractHash(contract),parts:parts.length,joints:joints.length,sockets:sockets.length,colliders:colliders.length},null,2));
