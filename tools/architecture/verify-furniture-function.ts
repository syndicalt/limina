import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildingInteriorPlanV2Hash, validateBuildingInteriorPlanV2 } from "../../js/src/assets/building-interior-plan-v2.mjs";
import { validateBuildingStageArtifact } from "../../js/src/assets/staged-building-pipeline.mjs";
import { furnitureDesignContractHash, furnitureFunctionalEvidenceCanonicalText, validateFurnitureDesignContract, verifyFurnitureFunction } from "../../js/src/architecture/index.ts";
import type { FurnitureFunctionalBuildEvidence } from "../../js/src/architecture/index.ts";
import { inspectFurnitureGlb } from "./glb-runtime-geometry.mjs";

const digest=(bytes:Uint8Array)=>`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const close=(left:number,right:number)=>Math.abs(left-right)<=1e-6;

export interface VerifyFurnitureFunctionFilesOptions {readonly contractPath:string;readonly buildEvidencePath:string;readonly glbPath:string;readonly interiorArtifactPath:string;readonly interiorPlanPath:string;readonly proxyArchetypeId:string;readonly outputPath?:string;readonly write?:boolean}

export async function verifyFurnitureFunctionFiles(options:VerifyFurnitureFunctionFilesOptions){
  const [contractBytes,buildBytes,glbBytes,artifactBytes,planBytes]=await Promise.all([options.contractPath,options.buildEvidencePath,options.glbPath,options.interiorArtifactPath,options.interiorPlanPath].map(path=>readFile(resolve(path))));
  const contract=validateFurnitureDesignContract(JSON.parse(contractBytes.toString("utf8"))),contractHash=furnitureDesignContractHash(contract),rawBuild=JSON.parse(buildBytes.toString("utf8")) as FurnitureFunctionalBuildEvidence,artifact=validateBuildingStageArtifact(JSON.parse(artifactBytes.toString("utf8"))),plan=validateBuildingInteriorPlanV2(JSON.parse(planBytes.toString("utf8"))),runtime=inspectFurnitureGlb(glbBytes,contract),runtimeHash=digest(glbBytes);
  if(rawBuild.asset?.sha256!==runtimeHash||rawBuild.asset?.bytes!==glbBytes.length)throw new Error("exact runtime GLB bytes do not match build evidence");
  if(!rawBuild.bounds?.min?.every((value:number,axis:number)=>close(value,runtime.bounds.min[axis]))||!rawBuild.bounds?.max?.every((value:number,axis:number)=>close(value,runtime.bounds.max[axis])))throw new Error("independently inspected runtime GLB bounds do not match build evidence");
  const build={...rawBuild,glbValidation:{...rawBuild.glbValidation,pivot:runtime.pivot,partBounds:runtime.partBounds}} as FurnitureFunctionalBuildEvidence;
  const evidence=verifyFurnitureFunction({contract,contractHash,buildEvidence:build,runtimeGlbSha256:runtimeHash,approvedI1:{artifact,plan,canonicalPlanHash:buildingInteriorPlanV2Hash(plan),planContentHash:digest(planBytes)},selectedProxyArchetypeId:options.proxyArchetypeId});
  if(options.write!==false){if(!options.outputPath)throw new Error("outputPath is required when writing");const output=resolve(options.outputPath);await mkdir(dirname(output),{recursive:true,mode:0o700});await writeFile(output,`${furnitureFunctionalEvidenceCanonicalText(evidence)}\n`,{mode:0o600,flag:"wx"});}
  return evidence;
}

if(import.meta.url===`file://${process.argv[1]}`){const args=process.argv.slice(2),at=(flag:string)=>{const index=args.indexOf(flag);if(index<0||!args[index+1])throw new Error("usage: bun tools/architecture/verify-furniture-function.ts --contract <json> --evidence <json> --glb <glb> --i1-artifact <approved.json> --i1-plan <json> --proxy <id> --out <json>");return args[index+1]};const evidence=await verifyFurnitureFunctionFiles({contractPath:at("--contract"),buildEvidencePath:at("--evidence"),glbPath:at("--glb"),interiorArtifactPath:at("--i1-artifact"),interiorPlanPath:at("--i1-plan"),proxyArchetypeId:at("--proxy"),outputPath:at("--out")});console.log(JSON.stringify({verdict:evidence.verdict,failed:evidence.summary.failed,output:at("--out")},null,2));if(evidence.verdict!=="pass")process.exitCode=2}
