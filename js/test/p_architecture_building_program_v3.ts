import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  BUILDING_PROGRAM_V3,
  buildingProgramHash,
  buildingProgramV2Hash,
  buildingProgramV3Hash,
  parseBuildingProgram,
  parseBuildingProgramV2,
  parseBuildingProgramV3,
} from "../src/architecture/building-program.ts";

const fail=(message:string):never=>{throw new Error(`p_architecture_building_program_v3 FAIL: ${message}`);};
const assert=(condition:unknown,message:string):asserts condition=>{if(!condition)fail(message);};
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
const rejects=(value:unknown,pattern:RegExp,message:string):void=>{try{parseBuildingProgramV3(value);}catch(error){if(pattern.test(error instanceof Error?error.message:String(error)))return;throw error;}fail(message);};
const load=(path:string):any=>JSON.parse(fs.readFileSync(path,"utf8"));

const v1=load("assets/buildings/programs/functional-hall-house-fb4-program-v1.json");
const v2=load("assets/buildings/programs/functional-hall-house-fb4-program-v2.json");
const v3=load("assets/buildings/programs/functional-hall-house-fb4-program-v3.json");
const v1Hash="sha256:1cbfc81387a074f9475abdfe15290c21b6fc4b7a9050fd3f5db6f5543bf41736";
const v2Hash="sha256:0773d3b74739ac574fd5edab9886ffda9dec83cade820135f4b3a7ca296aab3a";
const v3Hash="sha256:14daddd5098cfcacd8cbf82532c2369872b47d3646b03031647b03f180732963";

assert(buildingProgramHash(v1)===v1Hash&&parseBuildingProgram(v1).schema==="limina.building-program/v1","V1 replay hash or parser behavior drifted");
assert(buildingProgramV2Hash(v2)===v2Hash&&parseBuildingProgramV2(v2).schema==="limina.building-program/v2","V2 replay hash or parser behavior drifted");
const parsed=parseBuildingProgramV3(v3);
assert(parsed.schema===BUILDING_PROGRAM_V3&&buildingProgramV3Hash(v3)===v3Hash,"valid V3 authority did not parse with its canonical hash");
assert(Object.isFrozen(parsed)&&Object.isFrozen(parsed.articulation.serviceCrossGable)&&Object.isFrozen(parsed.budgets.visualFloorAuthority),"V3 snapshot is not deeply immutable");
assert(!(parsed.budgets as any).visualFloorHash,"V3 retained the V2 bare visual-floor hash");
const floor=parsed.budgets.visualFloorAuthority,raw=`sha256:${createHash("sha256").update(fs.readFileSync(floor.path)).digest("hex")}`;
assert(raw===floor.sha256,"V3 visual-floor authority does not identify the exact current file bytes");
assert(buildingProgramV3Hash(Object.fromEntries(Object.entries(v3).reverse()))===v3Hash,"V3 hash depends on root insertion order");

const mutated=(edit:(value:any)=>void):any=>{const value=clone(v3);edit(value);return value;};
rejects(mutated(value=>{value.schema="limina.building-program/v2";}),/v3 schema/,"V2 schema entered the V3 parser");
rejects(mutated(value=>{value.budgets.visualFloorHash=value.budgets.visualFloorAuthority.sha256;}),/unknown field 'visualFloorHash'/,"V3 accepted the V2 bare visual-floor hash");
rejects(mutated(value=>{value.budgets.visualFloorAuthority.path="/tmp/floor.json";}),/repository-relative path/,"absolute visual-floor authority path was accepted");
rejects(mutated(value=>{value.budgets.visualFloorAuthority.path="art-direction/../floor.json";}),/repository-relative path/,"parent traversal visual-floor authority was accepted");
rejects(mutated(value=>{value.budgets.visualFloorAuthority.sha256="dc254b";}),/exact lowercase SHA-256/,"unbound visual-floor authority hash was accepted");

rejects(mutated(value=>{value.spaces.push({...clone(value.spaces[2]),id:"space/utility",use:"utility"});value.connections.push({id:"connection/hall-utility",fromSpaceId:"space/ground-hall",toSpaceId:"space/utility",kind:"open-passage",minimumClearWidthM:1});}),/exactly one additional ground/,"multiple ground service spaces were accepted");
rejects(mutated(value=>{value.spaces[2].use="study";}),/exactly one additional ground/,"missing ground pantry/utility/storage space was accepted");
rejects(mutated(value=>{value.spaces[2].privacy="household";}),/service privacy/,"non-service cross-gable privacy was accepted");
rejects(mutated(value=>{value.articulation.serviceCrossGable.spaceId="space/kitchen";}),/sole ground service space/,"cross-gable identity drift from its functional space was accepted");
rejects(mutated(value=>{value.spaces[2].daylight.preferredFacades=["right"];}),/front gable window/,"service mass without front daylight was accepted");
rejects(mutated(value=>{value.articulation.serviceCrossGable.gableWindow="preferred";}),/requires a front gable window/,"optional gable window was accepted");

rejects(mutated(value=>{value.connections[1].kind="door";}),/exactly one prescribed open passage/,"door substituted for the exact service open passage");
rejects(mutated(value=>{value.articulation.serviceCrossGable.hostSpaceId="space/upper-landing";}),/ground hall or kitchen/,"upper host for the service mass was accepted");
rejects(mutated(value=>{value.connections.push({id:"connection/service-kitchen",fromSpaceId:"space/service-pantry",toSpaceId:"space/kitchen",kind:"open-passage",minimumClearWidthM:1});}),/exactly one prescribed open passage/,"second service-space connection was accepted");

rejects(mutated(value=>{value.articulation.entrance.bracing="unbraced";}),/knee-braced timber/,"unbraced canopy was accepted");
rejects(mutated(value=>{value.articulation.serviceCrossGable.sideBias="center";}),/sideBias is unsupported/,"unbounded cross-gable placement was accepted");
rejects(mutated(value=>{value.articulation.serviceCrossGable.widthM.maximum=8;}),/2.4\.\.7.5|bounded secondary mass/,"oversized cross-gable width was accepted");
rejects(mutated(value=>{value.articulation.serviceCrossGable.projectionM.maximum=6;}),/bounded secondary mass/,"host-depth-sized projection was accepted");
rejects(mutated(value=>{value.articulation.serviceCrossGable.roofTermination="valley";}),/upper headwall/,"valley-cut service roof replaced the locked headwall abutment");
rejects(mutated(value=>{value.articulation.serviceCrossGable.foundation.composition="shared-slab";}),/independently bearing/,"shared service foundation was accepted");
rejects(mutated(value=>{value.articulation.serviceCrossGable.foundation.bearing="decorative-skin";}),/independently bearing/,"non-bearing service foundation was accepted");
rejects(mutated(value=>{value.articulation.serviceCrossGable.foundation.minimumVisibleRevealM=0;}),/\.05\.\.1/,"zero foundation reveal was accepted");
rejects(mutated(value=>{value.spaces[2].areaM2.target=13;value.spaces[2].areaM2.maximum=14;}),/fit inside the target cross-gable footprint/,"service program larger than its cross-gable footprint was accepted");

let v2AcceptedV3=false;try{parseBuildingProgramV2(v3);v2AcceptedV3=true;}catch{}
assert(!v2AcceptedV3,"V2 parser silently accepted V3 authority");
assert(buildingProgramHash(v1)===v1Hash&&buildingProgramV2Hash(v2)===v2Hash,"V3 parsing mutated earlier replay domains");

console.log(`p_architecture_building_program_v3 OK: ${v3Hash}; exact visual-floor file, functional service cross-gable, headwall roof, bearing reveal, braced canopy; V1 ${v1Hash} and V2 ${v2Hash} unchanged`);
