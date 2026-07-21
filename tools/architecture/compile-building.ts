import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compileArchitecture, serializeBlenderArchitectureInput, type ArchitectureSpec } from "../../js/src/architecture/index.ts";

const args=process.argv.slice(2),at=(flag:string)=>{const i=args.indexOf(flag);if(i<0||!args[i+1])throw new Error(`usage: bun tools/architecture/compile-building.ts --spec <json> --out <json>`);return resolve(args[i+1]);};
const specPath=at("--spec"),outputPath=at("--out"),spec=JSON.parse(await readFile(specPath,"utf8")) as ArchitectureSpec,compiled=compileArchitecture(spec);
await writeFile(outputPath,serializeBlenderArchitectureInput(compiled)+"\n",{mode:0o600});
console.log(JSON.stringify({schema:compiled.schema,specHash:compiled.specHash,irHash:compiled.irHash,primitives:compiled.primitives.length,stages:compiled.review.stages.map(stage=>stage.id),output:outputPath},null,2));
