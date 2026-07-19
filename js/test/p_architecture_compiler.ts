import { compileArchitecture, serializeBlenderArchitectureInput, type ArchitectureSpec } from "../src/architecture/index.ts";

function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(`p_architecture_compiler FAIL: ${message}`);}
const spec:ArchitectureSpec={schema:"limina.architecture-spec/v1",id:"hall-house/compiler-fixture/v1",
  foundations:[{id:"main",center:[0,0],halfExtents:[5,4],topY:0,depth:1.4}],
  walls:[{id:"south",from:[-4.8,-3.4],to:[4.8,-3.4],bottomY:0,topY:3.55,thickness:.36,openings:[{id:"front-door",kind:"door",offset:-.72,width:1.44,sillY:.09,height:2.48}]}],
  entrances:[{id:"front-entry",wallId:"south",openingId:"front-door",exteriorSide:1,exteriorGradeY:-.31,landingDepth:.64,stepCount:2,treadDepth:.38,width:1.72}],
  roofPlanes:[
    {id:"south-slope",origin:[0,3,0],normal:[-.7071067811865476,.7071067811865476,0],boundary:[[-2,1,-3],[2,5,-3],[2,5,3],[-2,1,3]],thickness:.14},
    {id:"cross-slope",origin:[0,3,0],normal:[.7071067811865476,.7071067811865476,0],boundary:[[2,1,-3],[-2,5,-3],[-2,5,3],[2,1,3]],thickness:.14}],
  roofSeams:[{id:"joined-valley",kind:"valley",planeIds:["south-slope","cross-slope"],from:[0,3,-2],to:[0,3,2],flashingWidth:.22}],
  fireplaces:[{id:"hall-hearth",center:[2.8,1.05,2.5],apertureHalfExtents:[.7,.72,.6],chimneyTopY:7.2,roofPlaneId:"south-slope",fireboxPolicy:"rear-soot-lining"}]};

const first=compileArchitecture(spec),second=compileArchitecture(structuredClone(spec));
assert(first.specHash===second.specHash&&first.irHash===second.irHash,"compile is not deterministic");
assert(JSON.stringify(first)===JSON.stringify(second),"compile output changes across identical inputs");
assert(first.entrances.length===1&&first.entrances[0].steps.length===2,"entrance assembly was not derived");
assert(first.walls.length===1&&first.walls[0].segments.length===4,"door opening was not compiled as a structural wall void");
assert(first.primitives.every(primitive=>primitive.kind!=="box"||primitive.halfExtents.every(value=>value>0)),"compiler emitted a non-positive solid");
const entrance=first.entrances[0],heights=entrance.steps.map(step=>step.center[1]+step.halfExtents[1]);
assert(heights[0]<heights[1]&&Math.abs(heights[1]-entrance.finishedFloorY)<1e-9,"steps are not monotonic to finished floor");
assert(entrance.threshold.center[0]===entrance.landing.center[0],"threshold and landing are not centered as one assembly");
assert(first.roofSeams[0].supported===true,"roof seam lacks dual-substrate authority");
assert(first.fireplaces[0].fuel.length>=2&&first.fireplaces[0].flames.length>=2,"fireplace compiled as a light-only placeholder");
const hearth=first.fireplaces[0],aperture=spec.fireplaces![0];
assert(hearth.cavity.halfExtents[2]<=.03,"firebox soot lining still fills the aperture and occludes the fire");
assert(Math.abs((hearth.cavity.center[2]+hearth.cavity.halfExtents[2])-(aperture.center[2]+aperture.apertureHalfExtents[2]))<1e-9,"firebox soot lining is not anchored to the rear wall");
assert(hearth.flames.every(flame=>flame.baseCenter[2]<hearth.cavity.center[2]-hearth.cavity.halfExtents[2]),"firebox flame is buried behind the soot lining");
assert(first.review.stages.map(stage=>stage.id).join(",")==="massing,envelope,roof-junctions,openings-circulation,interior-fireplace,materials-uv,lod-final","staged review order drifted");
assert(first.review.stages.slice(1).every(stage=>/^sha256:[0-9a-f]{64}$/.test(stage.prerequisiteHash??"")),"review prerequisites are not content hashes");
const blender=serializeBlenderArchitectureInput(first);assert(blender.includes('"limina.blender-architecture-input/v1"')&&blender.includes(first.irHash),"Blender adapter is not IR/hash bound");

const rejects=(mutate:(copy:any)=>void,pattern:RegExp)=>{const copy=structuredClone(spec);mutate(copy);let error="";try{compileArchitecture(copy);}catch(cause){error=String(cause);}assert(pattern.test(error),`expected ${pattern}, got ${error}`);};
rejects(copy=>{copy.entrances[0].stepCount=1;copy.entrances[0].exteriorGradeY=-.31;},/stair rise\/run/);
rejects(copy=>{copy.roofSeams[0].to=[0,3,4.5];},/not fully supported/);
rejects(copy=>{copy.roofSeams[0].flashingWidth=.05;},/credible flashing/);
rejects(copy=>{copy.walls[0].openings.push({...copy.walls[0].openings[0],id:"overlap",offset:-.5});},/overlaps or escapes/);
rejects(copy=>{copy.fireplaces[0].chimneyTopY=1.2;},/invalid fireplace/);
rejects(copy=>{copy.entrances[0].wallId="missing";},/missing wall/);
rejects(copy=>{copy.walls[0].openings[0].width=Number.NaN;},/must be finite|positive extents|overlaps or escapes/);
rejects(copy=>{copy.roofPlanes[0].normal=[Number.NaN,1,0];},/must be finite/);
rejects(copy=>{copy.roofSeams[0].planeIds=["south-slope","south-slope"];},/requires two planes/);
rejects(copy=>{copy.roofSeams[0].to=copy.roofSeams[0].from;},/nonzero length/);
const firelit=structuredClone(spec);firelit.fireplaces[0].lightId="hearth-light";firelit.practicalLights=[{id:"hearth-light",position:[2.8,1.05,2.5],color:[.75,.3,.1],intensityCandela:6,range:2}];assert(compileArchitecture(firelit).practicalLights[0].intensityCandela===6,"bounded fireplace light did not compile");
rejects(copy=>{copy.fireplaces[0].lightId="hearth-light";copy.practicalLights=[{id:"hearth-light",position:[2.8,1.05,2.5],color:[1,.46,.18],intensityCandela:29.9,range:4.2}];},/bounded fire-spill authority/);
rejects(copy=>{copy.fireplaces[0].lightId="hearth-light";copy.practicalLights=[{id:"hearth-light",position:[2.8,1.05,2.5],color:[.85,.34,.1],intensityCandela:8,range:2.3}];},/bounded fire-spill authority/);
const rotated=structuredClone(spec);rotated.walls[0].from=[2,-4.8];rotated.walls[0].to=[2,4.8];rotated.entrances[0].exteriorSide=-1;const rotatedCompile=compileArchitecture(rotated);
assert(rotatedCompile.walls[0].segments.every(segment=>Math.abs((segment.yawRadians??0)-Math.PI/2)<1e-9),"rotated wall lost compiler-owned orientation");
assert(rotatedCompile.entrances[0].steps.every(step=>Math.abs((step.yawRadians??0)-Math.PI/2)<1e-9),"rotated entrance lost wall-local orientation");
console.log(`p_architecture_compiler OK: ${first.primitives.length} resolved primitives, dual-substrate roof seam, unified entrance, complete hearth, 7 hash-addressed review stages`);
