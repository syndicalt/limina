import fs from "node:fs";
import { compileArchitecture, type ArchitectureSpec } from "../src/architecture/index.ts";

const assert=(value:unknown,message:string):asserts value=>{if(!value)throw new Error(`p_architecture_attached_bay FAIL: ${message}`)};
const source="assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-1b4470041e01/architecture-spec.json";
const original=JSON.parse(fs.readFileSync(source,"utf8")) as ArchitectureSpec;
const before=compileArchitecture(original),replay=compileArchitecture(structuredClone(original));
assert(JSON.stringify(before)===JSON.stringify(replay),"absent additive fields changed replay output");

const spec=structuredClone(original) as any;
spec.id="hall-house/attached-bay-compiler-test/v1";
spec.entranceCanopies[0].joineryPolicy="wall-plate-header-post-brace";
spec.attachedBays=[{
  id:"attached-bay/service",hostVolumeId:"volume/storey-ground",hostEdgeIndex:3,
  headwallVolumeId:"volume/storey-upper",headwallEdgeIndex:3,
  volumeId:"volume/service-bay",foundationId:"foundation/service-bay",roofSystemId:"roof-system/service-cross-gable",
  passageOpeningId:"opening/service-bay",frontWindowId:"window/service-bay/front",
  functionalRoomId:"room/space/service-bay",portalId:"portal/service-bay",
  alongOffset:0,width:3.2,projection:2.4,eaveY:3.8,foundationDepth:1,
  passageWidth:1.2,passageHeight:2.2,windowWidth:1.1,windowHeight:1.15,windowSillY:.85,
  pitchDegrees:40,eaveOverhang:.28,roofThickness:.16,flashingWidth:.2,flashingUpstand:.1,
}];
spec.functional.rooms.push({id:"room/space/service-bay",volumeId:"volume/service-bay",bounds:{center:[-6,1.9,0],halfExtents:[1.2,1.9,1.6]},finishedFloorY:0,ceilingY:3.8,storey:0,visibilityCellId:"cell/room/space/service-bay",acoustics:{absorption:.4,reverb:.18}});
spec.functional.portals.push({id:"portal/service-bay",kind:"passage",exterior:false,roomIds:["room/space/ground-hall","room/space/service-bay"],center:[-4.8,1.1,0],halfExtents:[.18,1.1,.6],acousticTransmission:.7});
spec.functional.spawnAnchors.push({id:"spawn/service-bay",roomId:"room/space/service-bay",kind:"item",position:[-6,0,0],direction:[1,0,0],clearanceRadius:.3,clearanceHeight:.5});
spec.functional.visibilityCells.push({id:"cell/room/space/service-bay",roomIds:["room/space/service-bay"],nodeIds:["volume/service-bay"]});
spec.functional.site.footprintCenter=[-1.2,0];spec.functional.site.footprintHalfExtents=[6,3.42];

const compiled=compileArchitecture(spec),bay=compiled.attachedBays?.[0],canopy=compiled.entranceCanopies?.[0];
assert(bay?.volumeId==="volume/service-bay"&&bay.foundationId==="foundation/service-bay","stable derived volume/foundation ids were lost");
assert(bay.roofPlaneIds.join(",")==="roof-system/service-cross-gable/south,roof-system/service-cross-gable/north","cross-gable plane ids drifted");
assert(bay.roofAbutmentIds.length===2&&bay.roofAbutmentIds.every(id=>compiled.primitives.some(item=>item.id===`roof-wall-flashing/${id}`)),"complete two-slope headwall flashing was not emitted");
assert(!compiled.primitives.some(item=>item.id==="gable/roof-system/service-cross-gable/east"),"false rear gable closure survived at the headwall");
assert(compiled.primitives.some(item=>item.id==="gable/roof-system/service-cross-gable/west"),"front gable closure was removed with the rear closure");
assert(compiled.windows.some(window=>window.openingId==="window/service-bay/front"),"front gable composition window was not compiled");
assert(compiled.walls.find(wall=>wall.id==="volume/storey-ground/edge-3")?.openingIds.includes("opening/service-bay"),"reciprocal host passage was not cut");
assert(!compiled.walls.some(wall=>wall.id==="volume/service-bay/edge-3"),"coincident bay rear wall was emitted");
assert(bay.passageThreshold.id==="attached-bay/attached-bay/service/passage-threshold","stable passage-threshold identity drifted");
assert(Math.abs(bay.passageThreshold.center[1]+.04)<1e-9&&Math.abs(bay.passageThreshold.halfExtents[1]-.04)<1e-9,"passage threshold is not flush with finished floor");
assert(bay.passageThreshold.halfExtents[0]===.6&&bay.passageThreshold.halfExtents[2]>.18,"passage threshold does not bear beneath both floor slabs");
assert(bay.functionalFloorColliderIds.length===3&&bay.functionalFloorColliderIds.every(id=>compiled.functionalContract?.colliders.some(collider=>collider.id===id)),"continuous attached-bay floor union is absent from functional collision authority");
assert(!compiled.functionalContract?.colliders.some(collider=>collider.id===`collider/${compiled.volumes.find(volume=>volume.id===bay.volumeId)?.floor.id}`),"coincident bay floor collider survived the continuous union decomposition");
assert(canopy?.kneeBraces?.length===2&&canopy.kneeBraces.every(brace=>compiled.primitives.some(item=>item.id===brace.id)),"joinery policy did not emit exactly two compiler-owned knee braces");

const rejects=(mutate:(copy:any)=>void,pattern:RegExp)=>{const copy=structuredClone(spec);mutate(copy);let error="";try{compileArchitecture(copy)}catch(cause){error=String(cause)}assert(pattern.test(error),`expected ${pattern}, got ${error}`)};
rejects(copy=>{copy.attachedBays[0].projection=-1},/bounded construction constraints/);
rejects(copy=>{copy.attachedBays[0].functionalRoomId="room\/missing"},/bind its room and reciprocal/);
rejects(copy=>{copy.attachedBays[0].headwallEdgeIndex=1},/bounded construction constraints/);
rejects(copy=>{copy.functional.portals.find((portal:any)=>portal.id==="portal\/service-bay").halfExtents[0]=.3},/bind its room and reciprocal/);

console.log("p_architecture_attached_bay OK: zero-overlap habitable bay, reciprocal passage, front window, two-slope headwall flashing, no rear closure, exact canopy braces");
