import fs from "node:fs";
import path from "node:path";

const fail=(message:string):never=>{throw new Error(`p_architecture_reference_strategy_isolation FAIL: ${message}`)};
const files=(root:string):string[]=>fs.readdirSync(root,{withFileTypes:true}).flatMap((entry)=>{
  const target=path.join(root,entry.name);return entry.isDirectory()?files(target):entry.isFile()&&/\.(?:ts|mjs|js)$/.test(entry.name)?[target]:[];
});
for(const file of files("js/src")){
  if(file.endsWith("reference-first-contract.ts"))continue;
  const source=fs.readFileSync(file,"utf8");
  if(/(?:from\s*|import\s*\()["'][^"']*reference-first-contract/.test(source))fail(`${file} imported the compatibility-only reference-first contract`);
  if(/(?:from\s*|import\s*\()["'][^"']*tools\/reference/.test(source))fail(`${file} imported optional authoring discovery into production runtime`);
}
const builder=fs.readFileSync("tools/architecture/build-fb4-multi-room-candidate.ts","utf8");
if(!builder.includes("functional-hall-house-fb4-program-v3.json")||!builder.includes("synthesizeTimberHallHouseV3"))fail("FB4 production builder is not fail-closed on the V3 program/rulebook path");
for(const forbidden of ["referenceImage","GenerativeAssetSource","reference-first-contract","tools/reference"])
  if(builder.includes(forbidden))fail(`FB4 production builder admitted forbidden ${forbidden} authority`);
if(!builder.includes("visualDesign.references")||!builder.includes("reference.sha256")||!builder.includes("referenceAuthorityPaths"))fail("FB4 builder does not byte-bind its pinned visual references into the production closure");
const genericPolicy="generic-asset-authoring-policy.mjs",daemon=fs.readFileSync("tools/design/architect-daemon.mjs","utf8"),runner=fs.readFileSync("tools/design/architect-run.mjs","utf8"),catalog=fs.readFileSync("js/src/skills/asset-catalog.ts","utf8");
for(const [name,source] of [["architect daemon",daemon],["architect runner",runner],["asset catalog",catalog]] as const)if(!source.includes(genericPolicy)||!source.includes("assertGenericAssetAuthoringCategory"))fail(`${name} can bypass the prop-only quarantine and author a non-functional building`);

console.log("p_architecture_reference_strategy_isolation OK: optional discovery cannot enter runtime authority; pinned references are byte-bound and generic authoring/catalog lanes are prop-only");
