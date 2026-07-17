import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_SOURCE = path.join(ROOT, "assets/buildings/functional-hall-house-architecture-v4.json");
export const DEFAULT_OUTPUT = path.join(ROOT, "assets/buildings/functional-hall-house-architecture-v5.json");

export function buildFunctionalHallHouseArchitectureV5(source) {
  const next=structuredClone(source);
  if(next.id!=="hall-house/temperate/architecture-v4")throw new Error(`architecture-v5: unexpected source id ${next.id}`);
  next.id="hall-house/temperate/architecture-v5";
  const support=next.functional?.site?.entranceSupport;
  if(support?.sourcePrimitiveId!=="entrance/front-entry/step-0")throw new Error("architecture-v5: structural entrance binding is missing");
  support.center=[-0.72,-4.25];
  return next;
}

export function writeFunctionalHallHouseArchitectureV5({sourcePath=DEFAULT_SOURCE,outputPath=DEFAULT_OUTPUT}={}){
  const result=buildFunctionalHallHouseArchitectureV5(JSON.parse(fs.readFileSync(sourcePath,"utf8")));
  fs.writeFileSync(outputPath,`${JSON.stringify(result,null,2)}\n`,{flag:"wx"});return outputPath;
}

if(import.meta.main)console.log(writeFunctionalHallHouseArchitectureV5({outputPath:process.argv[2]?path.resolve(process.argv[2]):DEFAULT_OUTPUT}));
