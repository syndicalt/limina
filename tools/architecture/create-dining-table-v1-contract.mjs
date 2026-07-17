import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { furnitureDesignContractHash, validateFurnitureDesignContract, validateVisualDesignContract, visualDesignContractHash } from "../../js/src/architecture/index.ts";

const DEFAULT_VISUAL=resolve(import.meta.dirname,"../../art-direction/furniture/dining-table-v1-visual-design.json");
const board=(size,edgeRadiusM=.008)=>({kind:"shaped-board",size,edgeProfile:"eased",edgeRadiusM});
const upright=(lengthM,bottomSection=[.16,.18],topSection=[.14,.16])=>({kind:"tapered-member",lengthM,bottomSection,topSection,axis:"y",chamferM:.008});
const peg=(axis,lengthM=.04)=>({kind:"peg",diameterM:.024,lengthM,axis});
const wedge=()=>({kind:"profile-extrusion",profile:[[-.055,-.045],[.055,-.032],[.055,.032],[-.055,.045]],depthM:.06,axis:"x",bevelM:.004});

/** Build the CPU-authored contract in memory. This performs no writes or Blender work. */
export function buildDiningTableV1Contract(visualInput){
  const visual=validateVisualDesignContract(visualInput),parts=[],add=(id,materialRole,center,geometry,rotationDeg=[0,0,0])=>parts.push({id,kind:geometry.kind,materialRole,center,rotationDeg,geometry});
  if(visual.id!=="furniture/dining-table/v1")throw new Error("dining table generator requires the exact v1 visual design");
  add("top/plank","oak-panel",[0,.74,0],board([1.4,.08,.8],.01));
  for(const [x,side] of [[-.54,"left"],[.54,"right"]]){
    add(`trestle/${side}/foot`,"oak-frame",[x,.05,0],board([.18,.10,.64],.008));
    add(`trestle/${side}/post`,"oak-frame",[x,.39,0],upright(.60));
    add(`trestle/${side}/cap`,"oak-frame",[x,.67,0],board([.20,.10,.62],.008));
    add(`wedge/${side}`,"oak-endgrain",[side==="left"?-.628:.628,.27,0],wedge(),[0,0,side==="left"?0:180]);
    for(const [z,face] of [[-.20,"front"],[.20,"rear"]])add(`peg/${side}-${face}`,"oak-endgrain",[x,.655,z],peg("y"));
  }
  add("stretcher/longitudinal","oak-frame",[0,.27,0],board([1.20,.14,.12],.006));

  const joints=[];
  for(const side of ["left","right"]){
    joints.push(
      {id:`joint/${side}-foot-post`,type:"mortise-tenon",members:[`trestle/${side}/foot`,`trestle/${side}/post`],toleranceM:.002},
      {id:`joint/${side}-post-cap`,type:"mortise-tenon",members:[`trestle/${side}/post`,`trestle/${side}/cap`],toleranceM:.002},
      {id:`joint/${side}-cap-top`,type:"housing",members:[`trestle/${side}/cap`,`top/plank`],toleranceM:.002},
      {id:`joint/${side}-stretcher-through-post`,type:"wedged-through-tenon",members:[`trestle/${side}/post`,`stretcher/longitudinal`],toleranceM:.002},
      {id:`joint/${side}-visible-wedge`,type:"wedged-through-tenon",members:[`stretcher/longitudinal`,`wedge/${side}`],toleranceM:.0015},
    );
    for(const face of ["front","rear"])joints.push({id:`joint/${side}-${face}-drawbore`,type:"drawbore-peg",members:[`trestle/${side}/cap`,`peg/${side}-${face}`],toleranceM:.0015});
  }
  const sockets=[
    {id:"approach/north",kind:"approach",position:[0,0,.78],facing:[0,0,-1],supportedBy:"top/plank",clearanceRadiusM:.35},
    {id:"approach/south",kind:"approach",position:[0,0,-.78],facing:[0,0,1],supportedBy:"top/plank",clearanceRadiusM:.35},
    {id:"approach/west",kind:"approach",position:[-1.08,0,0],facing:[1,0,0],supportedBy:"top/plank",clearanceRadiusM:.35},
    {id:"approach/east",kind:"approach",position:[1.08,0,0],facing:[-1,0,0],supportedBy:"top/plank",clearanceRadiusM:.35},
  ];
  const colliders=[
    {id:"collision/top",center:[0,.74,0],halfExtents:[.70,.04,.40],covers:["top/plank"]},
    {id:"collision/trestle-left",center:[-.54,.35,0],halfExtents:[.10,.35,.32],covers:["trestle/left/foot","trestle/left/post","trestle/left/cap","peg/left-front","peg/left-rear"]},
    {id:"collision/trestle-right",center:[.54,.35,0],halfExtents:[.10,.35,.32],covers:["trestle/right/foot","trestle/right/post","trestle/right/cap","peg/right-front","peg/right-rear"]},
    {id:"collision/stretcher",center:[0,.27,0],halfExtents:[.68,.07,.06],covers:["stretcher/longitudinal","wedge/left","wedge/right"]},
  ];
  const contract={schema:"limina.furniture-design-contract/v1",id:"furniture/dining-table/v1",role:"dining-table",visualDesign:{id:visual.id,hash:visualDesignContractHash(visual)},dimensions:{widthM:1.4,heightM:.78,depthM:.8,seatHeightM:0,seatDepthM:0,occupancy:0},parts,joints,sockets,colliders,materialRoles:["oak-frame","oak-panel","oak-endgrain"],status:"draft"};
  return validateFurnitureDesignContract(contract,visual);
}

export async function createDiningTableV1Contract({visualPath=DEFAULT_VISUAL,outputPath,write=true}={}){
  const visual=JSON.parse(await readFile(resolve(visualPath),"utf8")),contract=buildDiningTableV1Contract(visual);
  if(write){if(!outputPath)throw new Error("dining table contract outputPath is required when writing");const out=resolve(outputPath);await mkdir(dirname(out),{recursive:true});await writeFile(out,`${JSON.stringify(contract,null,2)}\n`,{mode:0o600,flag:"wx"});}
  return Object.freeze({contract,contractHash:furnitureDesignContractHash(contract)});
}

if(import.meta.url===`file://${process.argv[1]}`){const args=process.argv.slice(2),at=(flag)=>{const index=args.indexOf(flag);if(index<0||!args[index+1])throw new Error("usage: bun tools/architecture/create-dining-table-v1-contract.mjs --visual <json> --out <json>");return args[index+1];};const result=await createDiningTableV1Contract({visualPath:at("--visual"),outputPath:at("--out")});console.log(JSON.stringify({id:result.contract.id,contractHash:result.contractHash,parts:result.contract.parts.length,joints:result.contract.joints.length,sockets:result.contract.sockets.length,colliders:result.contract.colliders.length},null,2));}
