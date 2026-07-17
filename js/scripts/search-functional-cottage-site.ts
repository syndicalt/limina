import { ops } from "../src/engine.ts";
import { parseFunctionalBuildingContract } from "../src/assets/functional-building-contract.ts";
import { resolveFunctionalBuildingSitePlacement } from "../src/assets/functional-building-site.ts";
import { loadTemperateFidelityCandidate } from "../src/render/temperate-fidelity-scene.ts";
import { generatedWaterCoversPoint } from "../src/render/water/generated-water-renderer.ts";

const decoder=new TextDecoder("utf-8",{fatal:true}),reader={readJson:async(path:string)=>JSON.parse(decoder.decode(ops.op_read_asset(path))),readBytes:async(path:string)=>ops.op_read_asset(path)};
const authority=JSON.parse(decoder.decode(ops.op_read_asset("art-direction/functional-cottage-review-scene.json"))),parsedContract=parseFunctionalBuildingContract(ops.op_read_asset(`assets/${authority.asset.assetId}`)),contract={...parsedContract,site:{...parsedContract.site!,maximumTerrainRelief:1.4}};
const loaded=await loadTemperateFidelityCandidate({reader,shot:"river-leading-line"}),[originX,originZ]=[29,113],yaw=authority.placement.yaw,candidates=[];
const buildableIsDry=(x:number,z:number):boolean=>{const site=contract.site!,c=Math.cos(yaw),s=Math.sin(yaw),water=loaded.candidate.snapshot.generatedWater?.render;if(water===undefined)return true;for(let lz=site.footprintCenter[1]-site.footprintHalfExtents[1];lz<=site.footprintCenter[1]+site.footprintHalfExtents[1]+1e-6;lz+=.5)for(let lx=site.footprintCenter[0]-site.footprintHalfExtents[0];lx<=site.footprintCenter[0]+site.footprintHalfExtents[0]+1e-6;lx+=.5){const wx=x+lx*c+lz*s,wz=z-lx*s+lz*c;if(generatedWaterCoversPoint(water,wx,wz,.8))return false;}return true;};
for(let dz=-32;dz<=32;dz+=1)for(let dx=-32;dx<=32;dx+=1){const x=originX+dx,z=originZ+dz;try{const site=resolveFunctionalBuildingSitePlacement({contract,position:[x,0,z],yaw,sampleHeight:(sx,sz)=>loaded.candidate.snapshot.terrain.sampleHeight(sx,sz),maximumSampleSpacing:.5});if(!buildableIsDry(x,z))continue;candidates.push({x,z,distance:Math.hypot(dx,dz),relief:site.terrainRelief,rootY:site.rootY,minimum:site.terrainMinimum,maximum:site.terrainMaximum,samples:site.sampleCount});}catch{/* invalid footprint */}}
candidates.sort((a,b)=>a.distance-b.distance||a.relief-b.relief);
ops.op_log(JSON.stringify({schema:"limina.functional-cottage-site-search/v1",origin:[originX,originZ],yaw,valid:candidates.length,nearest:candidates.slice(0,20),flattest:[...candidates].sort((a,b)=>a.relief-b.relief||a.distance-b.distance).slice(0,20)},null,2));
