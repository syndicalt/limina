import { resolveFunctionalBuildingSitePlacement } from "../src/assets/functional-building-site.ts";
import type { FunctionalBuildingContract } from "../src/assets/functional-building-contract.ts";
function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(`p_functional_building_site FAIL: ${message}`);}
const contract={site:{footprintCenter:[0,-.7],footprintHalfExtents:[5.1,4.6],finishedFloorY:.09,terrainClearance:.12,vegetationClearance:.8,maximumTerrainRelief:.6}} as unknown as FunctionalBuildingContract;
const flat=resolveFunctionalBuildingSitePlacement({contract,position:[10,2,20],yaw:Math.PI/2,sampleHeight:(x,z)=>3+.01*x-.005*z,maximumSampleSpacing:.5});
assert(flat.sampleCount>=400,"complete footprint was not sampled");
assert(flat.rootWorldY===flat.rootY,"root world authority is not singular");
assert(Math.abs((flat.rootY+.09)-((flat.terrainMaximum)+.12+2))<1e-9,"finished floor does not clear the maximum terrain sample");
assert(flat.containsWorldXZ(10.7,20)&&flat.containsWorldXZ(10,14.2)&&!flat.containsWorldXZ(17,20),"rotated footprint exclusion is wrong");
try{resolveFunctionalBuildingSitePlacement({contract,position:[0,0,0],yaw:0,sampleHeight:(x)=>x>0?1:0});throw new Error("excess relief accepted");}catch(error){if((error as Error).message==="excess relief accepted")throw error;}
try{resolveFunctionalBuildingSitePlacement({contract,position:[0,0,0],yaw:0,sampleHeight:()=>undefined});throw new Error("missing terrain accepted");}catch(error){if((error as Error).message==="missing terrain accepted")throw error;}
const supported={site:{...contract.site,entranceSupport:{center:[0,-4],halfExtents:[1,.2],yawRadians:0,exteriorGradeY:-.31,bearingDepth:.1,maximumCutDepth:.04,maximumVariation:.08}}} as unknown as FunctionalBuildingContract;
const bearing=resolveFunctionalBuildingSitePlacement({contract:supported,position:[0,0,0],yaw:0,sampleHeight:(_x,z)=>z<-3.7?2.70:3});
assert(Math.abs(bearing.rootWorldY-3.03)<1e-9,"site resolver returned the wrong root authority");
assert(Math.abs(bearing.entranceSupport!.worldGradeY-2.72)<1e-9,"exterior grade did not share the root datum");
assert(bearing.entranceSupport!.fillDepth<=.1&&bearing.entranceSupport!.cutDepth<=.04,"buildable entrance support failed");
try{resolveFunctionalBuildingSitePlacement({contract:supported,position:[0,0,0],yaw:0,sampleHeight:(_x,z)=>z<-3.7?2.6:3});throw new Error("floating entrance accepted");}catch(error){if((error as Error).message==="floating entrance accepted")throw error;}
console.log(`p_functional_building_site OK: ${flat.sampleCount} samples, relief=${flat.terrainRelief.toFixed(3)}m`);
