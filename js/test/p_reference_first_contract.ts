import assert from "node:assert/strict";
import { referenceFirstAuthorityHash, referenceFirstContractHash, validateReferenceFirstContract } from "../src/architecture/reference-first-contract.ts";

const NOW=Date.parse("2026-07-16T18:00:00Z"), H=`sha256:${"a".repeat(64)}`;
const h=(character:string)=>`sha256:${character.repeat(64)}`;
const cue=(id:string,source:string,statement:string,target:number)=>({id,kind:"dimensions",statement,sourceIds:[source],measurement:{name:id,unit:"m",target},confidence:"direct"});
function draft():any {
  return {
    schema:"limina.reference-first-modeling/v1",id:"hall-reference-v1",subjectKind:"building",
    referenceBoard:{path:"art-direction/boards/hall.webp",sha256:H,id:"hall-board"},
    acquisitionPolicy:{maximumSources:8,maximumAgeDays:30,runtimeNetwork:"forbidden",sourceUse:"reference-only",automaticProductionImport:"forbidden"},
    sources:[
      {id:"stair-a",sourceUrl:"https://example.org/stair-a",creator:"Archive",license:"CC0",retrievedAt:"2026-07-16T11:00:00Z",localPath:"art-direction/cache/stair-a.webp",sha256:h("1"),roles:["stair adjacency"]},
      {id:"stair-b",sourceUrl:"https://example.org/stair-b",creator:"Archive",license:"CC BY 4.0",retrievedAt:"2026-07-16T11:00:00Z",localPath:"art-direction/cache/stair-b.webp",sha256:h("2"),roles:["stair width"]},
      {id:"window-a",sourceUrl:"https://example.org/window-a",creator:"Museum",license:"CC0",retrievedAt:"2026-07-16T11:00:00Z",localPath:"art-direction/cache/window-a.webp",sha256:h("3"),roles:["upper windows"]},
      {id:"window-b",sourceUrl:"https://example.org/window-b",creator:"Museum",license:"Public domain",retrievedAt:"2026-07-16T11:00:00Z",localPath:"art-direction/cache/window-b.webp",sha256:h("4"),roles:["window spacing"]},
    ],
    decisionClasses:[
      {id:"stair-placement",question:"Where does the stair belong?",sourceIds:["stair-a","stair-b"],cues:[cue("stair-wall-gap","stair-a","Stair stringer is adjacent to the wall.",0.1),cue("stair-width","stair-b","Clear stair width supports circulation.",0.9)],chosenPattern:{id:"wall-flight",rationale:"Preserves the occupied center and follows both precedents.",cueIds:["stair-wall-gap","stair-width"]},rejectedAlternatives:[{id:"center-flight",rationale:"Splits the principal room without precedent.",cueIds:["stair-wall-gap"]}]},
      {id:"upper-windows",question:"How is the upper floor lit?",sourceIds:["window-a","window-b"],cues:[cue("upper-sill","window-a","Upper window sill aligns above the finished floor.",0.8),cue("window-spacing","window-b","Upper windows repeat at bounded spacing.",2.1)],chosenPattern:{id:"paired-bays",rationale:"Provides upper-storey daylight with a coherent elevation.",cueIds:["upper-sill","window-spacing"]},rejectedAlternatives:[{id:"blank-upper-wall",rationale:"Would leave an occupied floor without daylight.",cueIds:["upper-sill"]}]},
    ],
    geometryDecisions:[
      {id:"stair-geometry",decisionClassId:"stair-placement",cueIds:["stair-wall-gap","stair-width"],compilerConstraintIds:["stair-constraint"]},
      {id:"window-geometry",decisionClassId:"upper-windows",cueIds:["upper-sill","window-spacing"],compilerConstraintIds:["window-constraint"]},
    ],
    compilerConstraints:[
      {id:"stair-constraint",cueIds:["stair-wall-gap","stair-width"],assertion:"Stair wall gap <= 0.1 m and clear width >= 0.9 m.",verification:"compiler"},
      {id:"window-constraint",cueIds:["upper-sill","window-spacing"],assertion:"Every occupied upper room has a window at the measured sill and spacing.",verification:"compiler"},
    ],
    evidenceCameras:[
      {id:"stair-plan",cueIds:["stair-wall-gap","stair-width"],view:"upper plan",framing:"wall, complete stair, and room center",acceptance:"Shows wall adjacency and an unobstructed center."},
      {id:"upper-elevation",cueIds:["upper-sill","window-spacing"],view:"exterior elevation",framing:"complete upper storey",acceptance:"Shows windows serving every occupied upper room."},
    ],
    checkpoints:["reference-lock","massing","structure","junctions","materials","integration"].map(id=>({id,cueIds:["stair-wall-gap","upper-sill"],evidenceCameraIds:["stair-plan","upper-elevation"],status:"pending"})),
    status:"draft",
  };
}
const good=draft();assert.equal(validateReferenceFirstContract(good,NOW).id,"hall-reference-v1");assert.match(referenceFirstContractHash(good,NOW),/^sha256:/);
const approved=draft();const authority=referenceFirstAuthorityHash(approved);const decisionHash=`sha256:${"b".repeat(64)}`;approved.checkpoints[0]={...approved.checkpoints[0],status:"approved",hitlDecisionHash:decisionHash};approved.referenceLock={decision:"approve-exact-reference-set",reviewer:"human-reviewer",decidedAt:"2026-07-16T14:00:00Z",authorityHash:authority,hitlDecisionHash:decisionHash};approved.status="reference-approved";assert.equal(validateReferenceFirstContract(approved,NOW).status,"reference-approved");

function rejects(mutator:(v:any)=>void,pattern:RegExp){const value=draft();mutator(value);assert.throws(()=>validateReferenceFirstContract(value,NOW),pattern)}
rejects(v=>v.sources[0].surprise=true,/unknown field/);
rejects(v=>Object.setPrototypeOf(v.decisionClasses[0],{polluted:true}),/plain object/);
rejects(v=>{delete v.sources[1];},/sparse/);
let invoked=false;const hostile=draft();Object.defineProperty(hostile.sources[0],"creator",{enumerable:true,get(){invoked=true;return "attacker"}});assert.throws(()=>validateReferenceFirstContract(hostile,NOW),/accessor-backed/);assert.equal(invoked,false);
rejects(v=>v.acquisitionPolicy.automaticProductionImport="allowed",/reference-only/);
rejects(v=>v.decisionClasses[0].sourceIds=["stair-a","window-a"],/cue sourceIds cites an unknown/);
rejects(v=>v.decisionClasses[0].cues[1].sourceIds=["stair-a"],/every decision source/);
rejects(v=>v.geometryDecisions[0].cueIds=["upper-sill"],/only use cues from its decision class/);
rejects(v=>v.compilerConstraints[0].cueIds=["stair-wall-gap"],/map through a cited compiler constraint/);
rejects(v=>{v.status="reference-approved";v.checkpoints[0].status="approved";v.checkpoints[0].hitlDecisionHash=H;v.referenceLock={decision:"approve-exact-reference-set",reviewer:"human",decidedAt:"2026-07-16T14:00:00Z",authorityHash:H,hitlDecisionHash:H}},/does not bind the exact/);
console.log("PASS reference-first contract: cited-board relevance, reference-only use, constraints, cameras, ordered HITL lock, and hostile shapes are fail-closed");
