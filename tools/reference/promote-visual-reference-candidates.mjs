#!/usr/bin/env node
import { readFile,writeFile,mkdir } from "node:fs/promises";
import { dirname,resolve } from "node:path";
import { createAcquisitionManifest } from "./visual-reference-search-core.mjs";
const args=process.argv.slice(2),value=(flag)=>{const index=args.indexOf(flag);if(index<0||!args[index+1])throw new Error("usage: node tools/reference/promote-visual-reference-candidates.mjs --candidates <json> --selection <json> --out <acquisition.json>");return resolve(args[index+1]);};
const candidates=JSON.parse(await readFile(value("--candidates"),"utf8")),selection=JSON.parse(await readFile(value("--selection"),"utf8")),target=value("--out"),manifest=createAcquisitionManifest(candidates,selection);await mkdir(dirname(target),{recursive:true});await writeFile(target,`${JSON.stringify(manifest,null,2)}\n`,{mode:0o600});process.stdout.write(`${JSON.stringify(manifest,null,2)}\n`);
