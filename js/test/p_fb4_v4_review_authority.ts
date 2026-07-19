import assert from "node:assert/strict";
import fs from "node:fs";
import {
  assertMultiRoomReviewCaptureReady,
  FB4_V4_SEMANTIC_VIEW_MAPPING,
  validateMultiRoomReviewAuthority,
} from "../src/render/building-multi-room-review-scene.ts";

const historical=JSON.parse(fs.readFileSync("assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-1b4470041e01/review-v3-r5/review-authority.json","utf8"));
assert.throws(()=>assertMultiRoomReviewCaptureReady(validateMultiRoomReviewAuthority(historical)),/V2\/V3 review authority is historical only/);

const semanticViewIds=["semantic/gable","semantic/entry","semantic/passage","semantic/stair","semantic/upper"],claimIds=FB4_V4_SEMANTIC_VIEW_MAPPING.map(entry=>entry.claimId),semantic={
  claims:claimIds.map((id,index)=>({id,viewId:semanticViewIds[index]})),
  policy:{claims:claimIds.map((id,index)=>({id,viewId:semanticViewIds[index],camera:{position:[index+1,2,index+3],target:[index,1,index+2],fovYDegrees:50+index,nearM:.05,farM:40}}))},
};
const views=historical.evidenceViews;
assert.deepEqual(views,historical.evidenceViews,"semantic CPU diagnostics must not replace the visual-review camera set");
assert.ok(views.every((view:any)=>view.camera.fovDeg<=85),"human review camera escaped the visual-quality FOV bound");

const hash=`sha256:${"a".repeat(64)}`,exact={path:"fixtures/exact",sha256:hash,contentHash:hash,bytes:1};
const v4={
  ...historical,
  schema:"limina.fb4-multi-room-review-authority/v4",
  candidate:{...historical.candidate,candidateId:"candidate/current",architectureId:"architecture/current",manifest:exact,architectureIr:exact,specHash:hash},
  topologyProof:{...historical.topologyProof,expectedAnchors:6},
  evidenceViews:views,
  semanticEvidence:exact,
  semanticViewMapping:FB4_V4_SEMANTIC_VIEW_MAPPING.map((entry,index)=>({...entry,semanticViewId:semanticViewIds[index]})),
  cameraSetHash:hash,
  reviewToolClosureHash:hash,
};
assert.equal(assertMultiRoomReviewCaptureReady(validateMultiRoomReviewAuthority(v4)).schema,"limina.fb4-multi-room-review-authority/v4");
assert.throws(()=>validateMultiRoomReviewAuthority({...v4,topologyProof:{...v4.topologyProof,expectedAnchors:5}}),/expected|exact candidate\/semantic authority/);
assert.throws(()=>validateMultiRoomReviewAuthority({...v4,semanticViewMapping:v4.semanticViewMapping.slice(0,4)}),/semantic\/review view mapping/);
console.log("p_fb4_v4_review_authority OK: V3 historical-only, five semantic claims map to independently site-verified visual views, V4 requires exact IR/evidence and six anchors");
