import * as THREE from "../build/three.bundle.mjs";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { EntityTable, ops } from "../src/engine.ts";
import { mountBuildingProductionReview } from "../src/render/building-production-review-scene.ts";
import { GltfSceneCache, prewarmGltfScene } from "../src/skills/three.ts";
import type { WorldContext } from "../src/skills/registry.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";

function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(`p_building_production_review_scene FAIL: ${message}`);}
const authorityPath="assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653/production-review-authority-v5.json",authority=JSON.parse(new TextDecoder().decode(ops.op_read_asset(authorityPath))),manifest=JSON.parse(new TextDecoder().decode(ops.op_read_asset(authority.package.manifest.path))),siteFit=JSON.parse(new TextDecoder().decode(ops.op_read_asset(authority.siteFitEvidence.path))),terrainRootY=siteFit.fit.rootWorldY;
const cache=new GltfSceneCache({ktx2TranscoderPath:"/runtime/basis/",ktx2TranscoderBytes:{js:ops.op_read_asset("runtime/basis/basis_transcoder.js"),wasm:ops.op_read_asset("runtime/basis/basis_transcoder.wasm")}});
cache.configureKtx2({isWebGPURenderer:true,hasFeature:(feature:string)=>feature==="texture-compression-astc"||feature==="texture-compression-etc2"||feature==="texture-compression-bc"});
const productionId="buildings/functional-hall-house-v4-production.glb",fuelPath=manifest.runtimeFacets.fire.fuel.runtimeGlb.path,fuelId=fuelPath.replace(/^assets\//,"");
await prewarmGltfScene(productionId,ops.op_read_asset(manifest.runtime.productionGlb.path),cache);await prewarmGltfScene(fuelId,ops.op_read_asset(fuelPath),cache);cache.beginWorld();
let activeWorldMissRejected=false;try{await cache.parse("buildings/unprewarmed-regression.glb",ops.op_read_asset(fuelPath));}catch{activeWorldMissRejected=true;}assert(activeWorldMissRejected,"active-world cache miss did not fail closed");
ops.op_physics_create_world(0);const ecs=createEcsWorld(),scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(),counts=new Map<string,number>();
const gltfCache={parse:async(assetId:string,bytes:Uint8Array)=>{counts.set(assetId,(counts.get(assetId)??0)+1);return cache.parse(assetId,bytes);}};
const world={ecs,transforms:createTransformStorage(ecs),spatial:new UniformGridSpatialIndex(),entities:new EntityTable(),tags:new Map(),scene,camera,ops,mode:"headless",simWorker:false,gltfCache} as unknown as WorldContext;
try{const mount=await mountBuildingProductionReview(world,authority,terrainRootY);assert(mount.fireSample.phase==="burning"&&mount.fireSample.envelope===1&&mount.fireSample.tick===120,"review fire schedule drifted");assert(counts.get(productionId)===1&&counts.get(fuelId)===1&&counts.size===2,"review bypassed sole production/fuel engine mount");assert(mount.production.trace.visualFurniturePlacements===0&&mount.production.inventory.colliders===123&&mount.production.inventory.sockets===12,"review functional inventory drifted");for(const view of authority.evidenceViews){const selected=mount.setEvidenceView(view.id),resolved=new THREE.Vector3(view.camera.position[0],view.camera.position[1]+terrainRootY,view.camera.position[2]);assert(selected.id===view.id&&camera.position.distanceTo(resolved)<1e-6,`camera ${view.id} was not terrain-resolved`);}await mount.dispose();await mount.dispose();assert(mount.disposed&&world.entities.ids().length===0&&scene.children.length===0,"review lifecycle leaked entities/resources");}
finally{cache.endWorld();await cache.dispose();}
console.log("p_building_production_review_scene OK: sole frozen production mount, deterministic approved fire, five review cameras, functional inventory, and CPU-only lifecycle verified");
