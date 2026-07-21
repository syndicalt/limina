import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";

import {
  assertApprovedFunctionalSettlementRelease,
  loadApprovedFunctionalSettlementRelease,
} from "../src/assets/functional-settlement-release.mjs";
import { portableAssetContentHash } from "../src/world/asset-content-hash.mjs";
import { canonicalCompilerJson } from "../src/world/compiler/canonical.mjs";

const RELEASE="assets/settlements/functional-hall-r1/release.json",read=(path:string)=>fs.readFileSync(path),bytes=read(RELEASE);
assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"),"6af4b3cf25a38a79af60d9516ed7b7eb1808ea7fa5277e12bb586a71f379c636","FB-5 release bytes drifted from the approved publication-derived record");
const loaded:any=loadApprovedFunctionalSettlementRelease(bytes,read);
assert.equal(assertApprovedFunctionalSettlementRelease(loaded),loaded);
assert.equal(loaded.release.closureHash,"sha256:e6cb4277226c55b8ae66d70f4768ea06bc3eba22d3bcb3e16fc23a424fa8220a");
assert.equal(loaded.release.approval.candidateId,"functional-hall-house/fb4/1f375ec3abe1");
assert.equal(loaded.publication.approval.status,"approved");
assert.equal(loaded.plan.placements.length,3);
assert(loaded.plan.placements.every((placement:any)=>Math.abs(placement.position[0])>100_000&&Math.abs(placement.position[2])>100_000),"release lost large-coordinate placement proof");
assert(loaded.plan.placements.every((placement:any)=>placement.yaw===.713&&placement.residency.policy==="whole-building-atomic"&&placement.residency.cellIds.length===6),"release lost yaw or whole-building semantic inventory");
assert.equal(loaded.worldMap.routes.length,1);assert.equal(loaded.worldMap.routes[0].points.length,3);assert.equal(loaded.worldMap.anchors.length,3);
assert.deepEqual(loaded.runtime,{loadDistance:16,keepDistance:24,maxActiveUnits:2,maxResidentBytes:44317376});

assert.throws(()=>assertApprovedFunctionalSettlementRelease(JSON.parse(JSON.stringify(loaded))),/not a verified in-process settlement release/);
const forged=JSON.parse(bytes.toString("utf8"));forged.runtime.maxActiveUnits=3;
assert.throws(()=>loadApprovedFunctionalSettlementRelease(Buffer.from(`${JSON.stringify(forged)}\n`),read),/closure hash drifted/);
const releaseValue=JSON.parse(bytes.toString("utf8")),recipeBytes=read(releaseValue.recipe.path),recipe=JSON.parse(recipeBytes.toString("utf8"));recipe.runtime.maxActiveUnits=3;
const recipeDrift=new Map<string,Uint8Array>([[releaseValue.recipe.path,Buffer.from(`${JSON.stringify(recipe)}\n`)]]);
const rebound=structuredClone(releaseValue),reboundRecipe=recipeDrift.get(releaseValue.recipe.path)!;
rebound.recipe.sha256=`sha256:${crypto.createHash("sha256").update(reboundRecipe).digest("hex")}`;
rebound.recipe.contentHash=portableAssetContentHash(reboundRecipe);
const {closureHash:_,...reboundBody}=rebound;rebound.closureHash=`sha256:${crypto.createHash("sha256").update(Buffer.from(canonicalCompilerJson(reboundBody))).digest("hex")}`;
assert.throws(()=>loadApprovedFunctionalSettlementRelease(Buffer.from(`${JSON.stringify(rebound)}\n`),(path:string)=>recipeDrift.get(path)??read(path)),/recipe runtime\/terrain authority drifted/);
const driftedPlan=new Map<string,Uint8Array>(),planBytes=read(loaded.release.plan.path),plan=JSON.parse(planBytes.toString("utf8"));plan.placements[0].yaw=0;driftedPlan.set(loaded.release.plan.path,Buffer.from(`${JSON.stringify(plan)}\n`));
assert.throws(()=>loadApprovedFunctionalSettlementRelease(bytes,(path:string)=>driftedPlan.get(path)??read(path)),/plan exact bytes drifted/);

console.log("p_fb5_functional_settlement_release OK: exact approved publication + 3-building large-coordinate Atlas/road/site closure is branded; loose/forged plans and runtime limits fail closed");
