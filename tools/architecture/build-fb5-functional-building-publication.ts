#!/usr/bin/env bun
// CPU-only, append-only FB-5 publication command. It performs no render and writes nothing unless
// the supplied candidate and complete review ledger resolve to an exact terminal HITL approval.

import fs from "node:fs";
import path from "node:path";
import { deriveApprovedFunctionalBuildingPublication } from "../../js/src/assets/functional-building-publication.mjs";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import { sha256 } from "../../js/src/world/sha256.mjs";

const ROOT=path.resolve(import.meta.dirname,"../.."),args=process.argv.slice(2),outcomes:string[]=[];
let candidateManifest:string|undefined,approvedOutcomePath:string|undefined,out:string|undefined,publicationId:string|undefined,
  catalogId:string|undefined,entryId:string|undefined,familyId:string|undefined,variantId:string|undefined,catalogRevision:number|undefined;
const portable=(input:string)=>{const absolute=path.resolve(ROOT,input),relative=path.relative(ROOT,absolute).split(path.sep).join("/");if(!relative||relative.startsWith("../")||path.isAbsolute(relative))throw new Error(`path escapes the workspace: ${input}`);return relative;};
for(let index=0;index<args.length;index++){
  const arg=args[index]!;
  if(arg==="--review-outcome"){const value=args[++index];if(!value)throw new Error("--review-outcome requires a path");outcomes.push(value);}
  else if(arg==="--approved-outcome"){approvedOutcomePath=args[++index];if(!approvedOutcomePath)throw new Error("--approved-outcome requires a path");}
  else if(arg==="--out"){out=args[++index];if(!out)throw new Error("--out requires a path");}
  else if(arg==="--candidate-manifest"){candidateManifest=args[++index];if(!candidateManifest)throw new Error("--candidate-manifest requires a path");}
  else if(arg==="--publication-id"){publicationId=args[++index];if(!publicationId)throw new Error("--publication-id requires a value");}
  else if(arg==="--catalog-id"){catalogId=args[++index];if(!catalogId)throw new Error("--catalog-id requires a value");}
  else if(arg==="--catalog-revision"){const value=args[++index];catalogRevision=Number(value);if(!Number.isSafeInteger(catalogRevision)||catalogRevision<1)throw new Error("--catalog-revision requires a positive integer");}
  else if(arg==="--entry-id"){entryId=args[++index];if(!entryId)throw new Error("--entry-id requires a value");}
  else if(arg==="--family-id"){familyId=args[++index];if(!familyId)throw new Error("--family-id requires a value");}
  else if(arg==="--variant-id"){variantId=args[++index];if(!variantId)throw new Error("--variant-id requires a value");}
  else throw new Error(`unsupported argument '${arg}'`);
}
if(outcomes.length===0||approvedOutcomePath===undefined||candidateManifest===undefined||publicationId===undefined||catalogId===undefined||catalogRevision===undefined||entryId===undefined||familyId===undefined||variantId===undefined)
  throw new Error("FB-5 publication remains closed: supply the candidate, complete ledger, explicit HITL approval, and publication/catalog/entry/family/variant identities");
candidateManifest=portable(candidateManifest);approvedOutcomePath=portable(approvedOutcomePath);
if(!candidateManifest.startsWith("assets/buildings/authoring/")||!candidateManifest.endsWith("/candidate-manifest.json"))throw new Error("--candidate-manifest must name an authored building candidate manifest");
const exact=(file:string)=>{const portablePath=portable(file),bytes=fs.readFileSync(path.resolve(ROOT,portablePath));return {path:portablePath,sha256:`sha256:${sha256(bytes)}`,contentHash:portableAssetContentHash(bytes),bytes:bytes.byteLength};};
const reviewLedger=outcomes.map(exact).sort((a,b)=>a.path.localeCompare(b.path));
const approvedReviewOutcome=reviewLedger.find(entry=>entry.path===approvedOutcomePath);
if(approvedReviewOutcome===undefined)throw new Error("--approved-outcome must name one of the exact --review-outcome records");
const publication=deriveApprovedFunctionalBuildingPublication({
  publicationId,catalogId,catalogRevision,entryId,familyId,variantId,
  candidateManifest:exact(candidateManifest),approvedReviewOutcome,reviewLedger,
},(file:string)=>fs.readFileSync(path.resolve(ROOT,portable(file))));
const encoded=`${JSON.stringify(publication,null,2)}\n`;
if(out!==undefined){
  const normalized=portable(out);
  if(!normalized.startsWith("assets/buildings/catalog/")||normalized.includes("/../")||!normalized.endsWith(".json"))throw new Error("--out must be an append-only JSON path beneath assets/buildings/catalog/");
  fs.mkdirSync(path.dirname(path.resolve(ROOT,normalized)),{recursive:true});fs.writeFileSync(path.resolve(ROOT,normalized),encoded,{flag:"wx",mode:0o600});
  console.log(`${normalized} ${Buffer.byteLength(encoded)} bytes ${publication.closureHash}`);
}else process.stdout.write(encoded);
