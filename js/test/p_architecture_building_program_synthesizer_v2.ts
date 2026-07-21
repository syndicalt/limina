import fs from "node:fs";
import { canonicalStringify } from "../src/authoring/canonical.ts";
import { BUILDING_PROGRAM_V2 } from "../src/architecture/building-program.ts";
import { BUILDING_SYNTHESIS_MANIFEST_V2, synthesizeTimberHallHouseV2 } from "../src/architecture/building-program-synthesizer.ts";
import { serializeBlenderArchitectureInput } from "../src/architecture/blender-adapter.ts";
import { compileArchitecture } from "../src/architecture/compiler.ts";
import { partitionCompiledArchitecture, serializeBlenderShellInput } from "../src/architecture/staged-partition.ts";

function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(`p_architecture_building_program_synthesizer_v2 FAIL: ${message}`)}
const source=JSON.parse(fs.readFileSync("assets/buildings/programs/functional-hall-house-fb4-program-v1.json","utf8"));
const program={...source,schema:BUILDING_PROGRAM_V2,id:"building-program/functional-hall-house/fb4-v2",
  objectives:source.objectives.map((entry:string)=>entry==="structural-legibility"?"construction-expression":entry).concat("silhouette-articulation"),
  articulation:{upper:{composition:"single-front-gable-dormer",role:"attic-articulation",baySelection:"rulebook"},
    entrance:{composition:"covered-primary",weatherProtection:"compiler-owned"},
    chimney:{required:true,fireplaceSpaceId:"space/ground-hall",roofPenetration:"curb-flashing-cricket-cap",distinctRoofBayFromDormer:true},
    visualFloor:{minimumSecondarySilhouetteElements:3,requireFacadeAsymmetry:true,requireMultiViewCpuProxy:true}}};

const first=synthesizeTimberHallHouseV2(program),second=synthesizeTimberHallHouseV2(structuredClone(program));
assert(first.acceptedDecisionCount===4&&first.candidates.length===3,"bounded V2 frontier did not retain the four valid target layouts");
assert(canonicalStringify(first)===canonicalStringify(second),"V2 synthesis is not deterministic");
for(const candidate of first.candidates){
  const {spec,compiled,manifest}=candidate,canopy=compiled.entranceCanopies?.[0],penetration=compiled.roofPenetrations[0];
  assert(manifest.schema===BUILDING_SYNTHESIS_MANIFEST_V2&&manifest.compiledArticulation.secondarySilhouetteElements===3,"manifest lacks compiled articulation facts");
  assert(manifest.evidenceRequirements.cpuProxy.required===true&&!("evidenceHash" in manifest.evidenceRequirements.cpuProxy),"synthesis falsely claimed later CPU evidence");
  assert(spec.dormers?.length===1&&compiled.dormers.length===1&&compiled.dormers[0].windowId==="window/attic-dormer/0","attic dormer authority drifted");
  for(const space of program.spaces.filter((item:any)=>item.storey==="upper"&&item.daylight.exteriorWindows==="required"))
    assert(compiled.windows.filter((window)=>window.openingId.startsWith(`window/${space.id}/`)).length===space.daylight.minimumWindowCount,`${space.id} lost real occupied-storey daylight`);
  assert(canopy&&canopy.posts.length===2&&canopy.footings.length===2,"covered entry lacks its supported assembly");
  const roles=new Map(compiled.primitives.map((item)=>[item.id,item.materialRole]));
  assert(roles.get(canopy.roof.id)==="roof"&&roles.get(canopy.flashing.id)==="roof-flashing"&&roles.get(canopy.counterflashing.id)==="roof-flashing"&&canopy.footings.every((item)=>roles.get(item.id)==="foundation"),"canopy material ownership drifted");
  assert(compiled.functionalContract?.colliders.filter((item)=>canopy.posts.some((post)=>item.id===`collider/${post.id}`)).length===2,"canopy supports are visually solid but non-functional");
  assert(penetration&&penetration.roofPlaneId!==compiled.dormers[0].hostPlaneId&&penetration.cricket.length===2&&penetration.flashing.length===4&&penetration.cap.length===4,"chimney/weather-layer inventory drifted");
  const blender=JSON.parse(serializeBlenderArchitectureInput(compiled)),partition=partitionCompiledArchitecture(spec,compiled),shell=JSON.parse(serializeBlenderShellInput(partition,compiled));
  assert(blender.entranceCanopies?.[0]?.id===canopy.id&&shell.entranceCanopies?.[0]?.id===canopy.id,"canopy metadata was lost before Blender/staged realization");
}

const candidate=first.candidates[0];
const rejects=(mutate:(spec:any)=>void,fragment:string)=>{const spec=structuredClone(candidate.spec) as any;mutate(spec);try{compileArchitecture(spec)}catch(error){assert(String(error).includes(fragment),`unexpected rejection: ${String(error)}`);return}throw new Error(`p_architecture_building_program_synthesizer_v2 FAIL: compiler accepted ${fragment}`)};
rejects(spec=>spec.entranceCanopies.push({...spec.entranceCanopies[0],id:"canopy/duplicate"}),"at most one weather canopy");
rejects(spec=>spec.entranceCanopies[0].width=20,"entrance canopy canopy/primary");
rejects(spec=>spec.roofPenetrations[0].center[0]+=.1,"invalid roof penetration");
rejects(spec=>spec.roofPenetrations.push({...spec.roofPenetrations[0],id:"chimney/duplicate"}),"at most one centerline roof penetration");

console.log("p_architecture_building_program_synthesizer_v2 OK: deterministic attic articulation, occupied daylight integrity, supported/flashed/collidable entry, centerline chimney closure, and conditional Blender metadata");
