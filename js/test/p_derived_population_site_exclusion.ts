import { combinedPopulationHardExclusion, derivedPopulationPlacementSurvives } from "../src/browser/derived-biome-population-mount.ts";
function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(`p_derived_population_site_exclusion FAIL: ${message}`);}
const water=(x:number)=>x<0,building=(_:number,z:number)=>z>2,hard=combinedPopulationHardExclusion(water,building);
assert(hard(-1,0)&&hard(1,3)&&!hard(1,0),"continuous population did not combine water and building vetoes");
assert(derivedPopulationPlacementSurvives({continuous:true,x:-1,z:3,waterCoverageAt:water,hardExclusionAt:building}),"continuous descriptor sentinel was removed");
assert(!derivedPopulationPlacementSurvives({continuous:false,x:-1,z:0,waterCoverageAt:water,hardExclusionAt:building}),"submerged discrete placement survived");
assert(!derivedPopulationPlacementSurvives({continuous:false,x:1,z:3,waterCoverageAt:water,hardExclusionAt:building}),"building-overlapping discrete placement survived");
assert(derivedPopulationPlacementSurvives({continuous:false,x:1,z:0,waterCoverageAt:water,hardExclusionAt:building}),"clear discrete placement was removed");
assert(!derivedPopulationPlacementSurvives({continuous:false,x:1,z:0,waterCoverageAt:water,discreteHardExclusionAt:()=>true}),"canopy-only exclusion did not remove a discrete placement");
assert(derivedPopulationPlacementSurvives({continuous:true,x:1,z:0,waterCoverageAt:water,discreteHardExclusionAt:()=>true}),"canopy-only exclusion incorrectly carved continuous grass");
console.log("p_derived_population_site_exclusion OK");
