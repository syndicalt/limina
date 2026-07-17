import fs from "node:fs";
import { resolveBuildingReviewState, validateBuildingReviewOutcome, verifyBuildingReviewLedger, verifyBuildingReviewOutcomeClosure } from "../src/assets/building-review-outcome.ts";

const candidateRoot="assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-d0ca1e327841";
const outcomePath="assets/buildings/authoring/functional-hall-house-v4/review-outcomes/fb4-d0ca1e327841-r1-central-rejected.json";
const read=(path:string)=>fs.readFileSync(path);
const assert=(value:unknown,message:string):asserts value=>{if(!value)throw new Error(`p_building_review_outcome FAIL: ${message}`);};
const manifest=JSON.parse(read(`${candidateRoot}/candidate-manifest.json`).toString("utf8"));
const outcomeBytes=read(outcomePath),outcome=verifyBuildingReviewOutcomeClosure(JSON.parse(outcomeBytes.toString("utf8")),read);
const ledger=verifyBuildingReviewLedger([{path:outcomePath,bytes:outcomeBytes}],read),state=resolveBuildingReviewState(manifest,ledger);
assert(manifest.status==="cpu-verified-human-pending"&&manifest.gpuCaptureRun===false,"immutable build-time manifest unexpectedly changed");
assert(state.buildStatus==="cpu-verified-human-pending"&&state.reviewStatus==="rejected-before-hitl","discovery trusted stale build-time status over append-only review outcome");
assert(state.outcome?.event.kind==="central-visual-review"&&state.outcome.event.record.path.endsWith("CENTRAL-REVIEW.json"),"resolved state lost exact central decision authority");
assert(outcome.subject.captureProvenance===null&&!state.hitlEligible,"historic capture provenance gap was hidden or allowed into HITL");

const base=JSON.parse(read(outcomePath).toString("utf8"));
for(const mutation of [
  {...base,sequence:2},
  {...base,subject:{...base.subject,candidateId:"functional-hall-house/fb4/wrong"}},
  {...base,event:{...base.event,record:{...base.event.record,sha256:"sha256:"+"0".repeat(64)}}},
]){
  let rejected=false;try{const parsed=validateBuildingReviewOutcome(mutation);verifyBuildingReviewOutcomeClosure(parsed,read);}catch{rejected=true;}
  assert(rejected,"review outcome mutation did not fail closed");
}
console.log("p_building_review_outcome OK: immutable candidate resolves rejected through exact append-only outcome closure; legacy provenance cannot approve");
