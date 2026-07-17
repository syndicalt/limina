import fs from "node:fs";
import { furnitureReviewScaleProxyPosition, validateFurniturePackReviewAuthority } from "../src/render/furniture-pack-review-scene.ts";
const path=process.argv[2];if(!path)throw new Error("usage: bun run js/test/p_furniture_pack_review_scene.ts <authority.json>");
const authority=validateFurniturePackReviewAuthority(JSON.parse(fs.readFileSync(path,"utf8")));
if(authority.pack.assetId.startsWith("/")||authority.pack.assetId.includes(".."))throw new Error("review authority assetId is not sandbox-relative");
if(authority.evidenceViews.length!==authority.visualDesign.requiredViews.length
  || authority.evidenceViews.some((view,index)=>view.id!==authority.visualDesign.requiredViews[index])
  || authority.presentation.neutralFloor!==true)throw new Error("review evidence contract drifted");
const proxy=furnitureReviewScaleProxyPosition(authority.bounds,authority.evidenceViews[0].position,authority.presentation.humanScaleProxyHeightM),center=authority.bounds.min.map((value,index)=>(value+authority.bounds.max[index])*.5),front=authority.evidenceViews[0].position.map((value,index)=>value-center[index]),horizontal=Math.hypot(front[0],front[2]),right=[-front[2]/horizontal,0,front[0]/horizontal],lateral=(proxy[0]-center[0])*right[0]+(proxy[2]-center[2])*right[2],minimumClearance=Math.abs(right[0])*(authority.bounds.max[0]-authority.bounds.min[0])*.5+Math.abs(right[2])*(authority.bounds.max[2]-authority.bounds.min[2])*.5;
if(!(lateral<-(minimumClearance+.29))||Math.abs(proxy[1]-authority.presentation.humanScaleProxyHeightM/2)>1e-9)throw new Error("review scale proxy is not laterally clear of the subject");
console.log(`p_furniture_pack_review_scene OK: ${authority.pack.id}, ${authority.evidenceViews.length} engine evidence views, ${authority.pack.sha256}`);
