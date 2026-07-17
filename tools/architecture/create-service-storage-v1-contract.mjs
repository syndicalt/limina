import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { furnitureDesignContractHash, validateFurnitureDesignContract, validateVisualDesignContract, visualDesignContractHash } from "../../js/src/architecture/index.ts";

const DEFAULT_VISUAL=resolve(import.meta.dirname,"../../art-direction/furniture/service-storage-v1-visual-design.json");
const board=(size,edgeRadiusM=.005)=>({kind:"shaped-board",size,edgeProfile:"eased",edgeRadiusM});
const stile=()=>({kind:"tapered-member",lengthM:1.72,bottomSection:[.08,.08],topSection:[.08,.08],axis:"y",chamferM:.005});
const peg=()=>({kind:"peg",diameterM:.018,lengthM:.03,axis:"x"});

/** Deterministically build the CPU-only service-storage contract in memory. */
export function buildServiceStorageV1Contract(visualInput){
  const visual=validateVisualDesignContract(visualInput);if(visual.id!=="furniture/service-storage/v1")throw new Error("service storage generator requires the exact v1 visual design");
  const parts=[],add=(id,materialRole,center,geometry,rotationDeg=[0,0,0])=>parts.push({id,kind:geometry.kind,materialRole,center,rotationDeg,geometry});
  for(const [x,depth] of [[-.16,"front"],[.16,"rear"]])for(const [z,side] of [[-.46,"left"],[.46,"right"]])add(`stile/${depth}-${side}`,"oak-frame",[x,.86,z],stile());
  const tierYs=[.08,.48,.88,1.28];for(const [index,y] of tierYs.entries())add(`tier/${index+1}`,"oak-panel",[0,y,0],board([.30,.06,.84],.006));
  for(const [index,y] of [.405,.805,1.205].entries())for(const [z,side] of [[-.46,"left"],[.46,"right"]])add(`side-rail/${index+2}-${side}`,"oak-frame",[0,y,z],board([.28,.07,.06],.004));
  for(const [index,y] of [.28,.68,1.08,1.48].entries())add(`backboard/${index+1}`,"oak-panel",[.165,y,0],board([.05,.20,.84],.004));
  add("cornice/top","oak-frame",[0,1.76,0],board([.4,.08,1],.008));
  for(const [z,side] of [[-.46,"left"],[.46,"right"]])for(const [y,level] of [[.485,"lower"],[1.285,"upper"]])add(`peg/front-${side}-${level}`,"oak-endgrain",[-.185,y,z],peg());

  const joints=[],join=(id,type,a,b,toleranceM=.002)=>joints.push({id,type,members:[a,b],toleranceM});
  for(let tier=1;tier<=4;tier++)for(const depth of ["front","rear"])for(const side of ["left","right"])join(`joint/tier-${tier}-${depth}-${side}`,"housing",`tier/${tier}`,`stile/${depth}-${side}`);
  for(let level=2;level<=4;level++)for(const side of ["left","right"]){join(`joint/side-rail-${level}-front-${side}`,"mortise-tenon",`side-rail/${level}-${side}`,`stile/front-${side}`);join(`joint/side-rail-${level}-rear-${side}`,"mortise-tenon",`side-rail/${level}-${side}`,`stile/rear-${side}`);}
  for(let boardIndex=1;boardIndex<=4;boardIndex++)for(const side of ["left","right"])join(`joint/backboard-${boardIndex}-${side}`,"housing",`backboard/${boardIndex}`,`stile/rear-${side}`);
  for(const depth of ["front","rear"])for(const side of ["left","right"])join(`joint/cornice-${depth}-${side}`,"mortise-tenon","cornice/top",`stile/${depth}-${side}`);
  for(const side of ["left","right"])for(const level of ["lower","upper"])join(`joint/peg-front-${side}-${level}`,"drawbore-peg",`stile/front-${side}`,`peg/front-${side}-${level}`,.0015);

  const sockets=[{id:"approach/front",kind:"approach",position:[-.65,0,0],facing:[1,0,0],supportedBy:"tier/1",clearanceRadiusM:.35}];
  const colliders=[
    ...["front-left","front-right","rear-left","rear-right"].map((id)=>({id:`collision/stile-${id}`,center:[id.startsWith("front")?-.16:.16,.86,id.endsWith("left")?-.46:.46],halfExtents:[.04,.86,.04],covers:[`stile/${id}`,...(id.startsWith("front")?[`peg/${id}-lower`,`peg/${id}-upper`]:[])]})),
    ...tierYs.map((y,index)=>({id:`collision/tier-${index+1}`,center:[0,y,0],halfExtents:[.15,.03,.42],covers:[`tier/${index+1}`]})),
    ...[.405,.805,1.205].flatMap((y,index)=>[[-.46,"left"],[.46,"right"]].map(([z,side])=>({id:`collision/side-rail-${index+2}-${side}`,center:[0,y,z],halfExtents:[.14,.035,.03],covers:[`side-rail/${index+2}-${side}`]}))),
    ...[.28,.68,1.08,1.48].map((y,index)=>({id:`collision/backboard-${index+1}`,center:[.165,y,0],halfExtents:[.025,.10,.42],covers:[`backboard/${index+1}`]})),
    {id:"collision/cornice",center:[0,1.76,0],halfExtents:[.2,.04,.5],covers:["cornice/top"]},
  ];
  const contract={schema:"limina.furniture-design-contract/v1",id:"furniture/service-storage/v1",role:"service-storage",visualDesign:{id:visual.id,hash:visualDesignContractHash(visual)},dimensions:{widthM:.4,heightM:1.8,depthM:1,seatHeightM:0,seatDepthM:0,occupancy:0},storage:{tierPartIds:["tier/1","tier/2","tier/3","tier/4"],verticalSupportPartIds:["stile/front-left","stile/front-right","stile/rear-left","stile/rear-right"],approachSocketId:"approach/front",canonicalFront:[-1,0,0],ratedLoadKgPerTier:25},parts,joints,sockets,colliders,materialRoles:["oak-frame","oak-panel","oak-endgrain"],status:"draft"};
  return validateFurnitureDesignContract(contract,visual);
}

export async function createServiceStorageV1Contract({visualPath=DEFAULT_VISUAL,outputPath,write=true}={}){const visual=JSON.parse(await readFile(resolve(visualPath),"utf8")),contract=buildServiceStorageV1Contract(visual);if(write){if(!outputPath)throw new Error("service storage contract outputPath is required when writing");const out=resolve(outputPath);await mkdir(dirname(out),{recursive:true});await writeFile(out,`${JSON.stringify(contract,null,2)}\n`,{mode:0o600,flag:"wx"});}return Object.freeze({contract,contractHash:furnitureDesignContractHash(contract)});}

if(import.meta.url===`file://${process.argv[1]}`){const args=process.argv.slice(2),at=(flag)=>{const index=args.indexOf(flag);if(index<0||!args[index+1])throw new Error("usage: bun tools/architecture/create-service-storage-v1-contract.mjs --visual <json> --out <json>");return args[index+1]};const result=await createServiceStorageV1Contract({visualPath:at("--visual"),outputPath:at("--out")});console.log(JSON.stringify({id:result.contract.id,contractHash:result.contractHash,parts:result.contract.parts.length,joints:result.contract.joints.length,sockets:result.contract.sockets.length,colliders:result.contract.colliders.length},null,2));}
